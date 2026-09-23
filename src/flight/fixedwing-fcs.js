// Flight control laws. Every law ends in the same inner loops: nonlinear dynamic inversion (NDI) of the model's own
// aerodynamic moments gives the surface deflection that produces a desired angular acceleration; the outer loops
// shape what the pilot's stick means for each aircraft:
//
//   'fighter'      F-16 FLCS / F-22: pitch = load-factor (g) command with an AoA limiter, stick released = flight
//                  path hold (bank compensated, keyboard friendly); roll = roll-rate command (expo shaped), released =
//                  bank hold; yaw = turn coordination (stability-axis roll) + sideslip command from the pedals.
//                  F-22: pitch thrust vectoring supplies the moment the stabilators cannot (low speed / high AoA).
//   'airbus'       A320 normal law: sidestick = load-factor demand (C*), auto-trim, flight path held when released,
//                  bank compensation to 33°, protections (bank 67° / 33° return, pitch +30°/-15°, load factor, alpha
//                  prot / alpha max / alpha floor, high speed), flare mode below 50 ft; ground = rotation rate law.
//   'conventional' 737: yoke = elevator around the stabilizer trim (elevator feel scales authority with speed),
//                  aileron + spoilers direct, yaw damper; a mild keyboard assist auto-trims to hold the path and
//                  levels the wings when released. The autopilot drives the NDI loops.
//
// Units: radians, rad/s, SI. Controls are normalized: elevator/aileron/rudder/trim/tvc in -1..1 (+ = nose up / roll
// right / yaw right).
import { DEG, G0, clamp, lerp, smoothstep, moveToward, wrapPi } from './fixedwing-util.js';

export function createFCS(m) {
  const spec = m.spec;
  const F = spec.fcs;
  const law = F.law;
  const S = spec.wingArea, b = spec.span, c = spec.chord;
  const rates = F.rates || {};
  const hasTrim = !!F.trimRange;
  const expoP = F.pitchExpo ?? 0, expoR = F.rollExpo ?? 0;
  const shape = (s, e) => s * ((1 - e) + e * s * s);

  const st = {
    gammaRef: 0, holding: false, holdT: 0,
    phiRef: 0, rollHold: false,
    blend: 0,               // 0 ground law ... 1 flight law
    flare: false, flareTheta: 0, flareT: 0,
    alphaProt: false, highSpeed: false, alphaFloor: false,
    nCmd: 1, qCmd: 0, pCmd: 0, uReq: 0,
    alphaMax: 0, alphaProtA: 0, alphaFloorA: 0,
    assistT: 0,
  };

  // ---------------------------------------------------------------------------------------------- helpers
  /** Load factor that holds a flight path gamma at bank phi (the bank compensation of each law). */
  function nLevel(gamma, phi, full = false) {
    const cg = Math.cos(gamma);
    if (!full && law !== 'fighter') {
      const lim = (F.bankComp ?? 33) * DEG;
      const cb = Math.cos(clamp(phi, -lim, lim));
      return cg / cb;
    }
    const cb = Math.cos(phi);
    return clamp((cg * cb) / Math.max(cb * cb, 0.25), -1.5, 3);
  }

  /** AoA (below the stall) where the lift coefficient reaches CL (bisection on the model's lift curve). */
  function alphaForCL(CL) {
    const lp = m.lp;
    let lo = lp.alphaKneeNeg, hi = lp.alphaStall;
    for (let i = 0; i < 14; i++) {
      const mid = 0.5 * (lo + hi);
      if (m.aero.CL(mid, lp) < CL) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }
  st.alphaForCL = alphaForCL;

  /** Pitch NDI: total pitch control (elevator + trim units) for a desired pitch acceleration. */
  function ndiPitch(qdotDes) {
    const ad = m.ad, I = m.I, w = m._omega;
    const Mreq = I.pitch * qdotDes + w.y * w.z * (I.roll - I.yaw);
    const Mde = Math.max(m.mom.Mde, 1);
    return (Mreq - m.mom.Mbase) / Mde;
  }

  function qFromN(nCmd, aMax, aMin, aOverride = null) {
    const ad = m.ad;
    const aCmd = aOverride ?? clamp(m.alphaForN(nCmd), aMin, aMax);
    // pitch rate = rotation of the flight path at the present load factor + first-order AoA tracking (no overshoot)
    const nNow = m.nForAlpha(ad.alpha);
    const V = Math.max(ad.V, 30);
    // faster AoA tracking at small commanded AoA (g onset at speed), the nominal gain near the AoA limit
    const Ka = (F.Ka ?? 2) * lerp(F.KaBoost ?? 1, 1, smoothstep(8 * DEG, 20 * DEG, aCmd));
    let q = (G0 / V) * (nNow - Math.cos(ad.gamma) * Math.cos(ad.phi)) + Ka * (aCmd - ad.alpha);
    st.aCmd = aCmd;
    return clamp(q, -(F.qMax ?? 0.5), F.qMax ?? 0.5);
  }

  /** Flight path hold / stick → load factor demand (FBW laws). */
  function stickToN(h, s, ad) {
    const nMax = m.sys.flapPos > 0.5 || m.sys.gear > 0.5 ? (F.nMaxFlaps ?? F.nMax) : F.nMax;
    const nMin = m.sys.flapPos > 0.5 || m.sys.gear > 0.5 ? (F.nMinFlaps ?? F.nMin) : F.nMin;
    let n;
    const neutral = Math.abs(s) < 0.03;
    const vertical = Math.abs(ad.gamma) > 70 * DEG;
    if (neutral) {
      // stick released at very high AoA (low energy): unload to alphaHold first, the flight path is captured after
      const aHold = law === 'fighter' ? Math.min((F.alphaLimit ?? 25) * DEG, m.lp.alphaStall) - (F.alphaHoldMargin ?? 5) * DEG : Infinity;
      if (ad.alpha > aHold) {
        st.holding = false; st.holdT = 0;
        return clamp(Math.min(nLevel(ad.gamma, ad.phi), m.nForAlpha(aHold)), nMin, nMax);
      }
      if (!st.holding) {
        st.holdT += h;
        const qss = (G0 / Math.max(ad.V, 30)) * (ad.nz - Math.cos(ad.gamma) * Math.cos(ad.phi));
        if (st.holdT > 0.8 || (st.holdT > 0.15 && Math.abs(ad.q - qss) < 1.5 * DEG)) { st.holding = true; st.gammaRef = ad.gamma; }
      }
      n = nLevel(ad.gamma, ad.phi);
      if (st.holding && !vertical && Math.abs(ad.phi) < 75 * DEG) {
        const dg = wrapPi(st.gammaRef - ad.gamma);
        n += ((Math.max(ad.V, 30) * (F.Kg ?? 0.6) * dg) / G0) * Math.cos(ad.phi) / Math.max(Math.cos(ad.phi) ** 2, 0.25);
      } else if (vertical) st.gammaRef = ad.gamma;
    } else {
      st.holding = false; st.holdT = 0;
      const n0 = nLevel(ad.gamma, ad.phi);
      const k = shape(s, expoP);
      n = k > 0 ? n0 + k * (nMax - n0) : n0 + k * (n0 - nMin);
    }
    return clamp(n, nMin, nMax);
  }

  function pitchAttitudeLimit(n, ad) {
    if (F.pitchMax == null) return n;
    const V = Math.max(ad.V, 30);
    const base = Math.cos(ad.gamma) * Math.cos(ad.phi);
    const lowSpeed = ad.V < (m.vSpeeds.vls || 0) * 1.1;
    const tmax = (lowSpeed ? (F.pitchMaxLow ?? F.pitchMax) : F.pitchMax) * DEG;
    const tmin = (F.pitchMin ?? -15) * DEG;
    const Kt = 0.6;
    if (ad.theta > tmax - 6 * DEG) n = Math.min(n, base + (V * Kt * (tmax - ad.theta)) / G0);
    if (ad.theta < tmin + 5 * DEG) n = Math.max(n, base + (V * Kt * (tmin - ad.theta)) / G0);
    return n;
  }

  // ---------------------------------------------------------------------------------------------- pitch
  function pitchLaw(h, s, apOut) {
    const ad = m.ad;
    const lp = m.lp;
    // AoA limits of the law (config dependent for the airbus: alpha max just below the stall)
    let aMax, aMin = Math.max(lp.alphaStallNeg + 2 * DEG, (F.alphaMin ?? -10) * DEG);
    if (law === 'airbus' || law === 'conventional') {
      // protection thresholds as fractions of CLmax (so they scale with the Mach-reduced buffet boundary):
      // alpha max ≈ 1.04 VS1g, alpha floor ≈ 1.07 VS1g, alpha prot ≈ 1.12 VS1g
      st.alphaMax = alphaForCL((F.clAlphaMax ?? 0.92) * lp.CLmax);
      st.alphaProtA = alphaForCL((F.clAlphaProt ?? 0.80) * lp.CLmax);
      st.alphaFloorA = ad.M < 0.6 ? alphaForCL((F.clAlphaFloor ?? 0.87) * lp.CLmax) : 10;
      if (law === 'airbus') {
        // alpha protection: stick commands alpha between alpha prot (neutral) and alpha max (full aft)
        if (ad.alpha > st.alphaProtA) st.alphaProt = true;
        else if (ad.alpha < st.alphaProtA - 2 * DEG || s < -0.3) st.alphaProt = false;
        aMax = st.alphaProt ? st.alphaProtA + Math.max(0, s) * (st.alphaMax - st.alphaProtA) : st.alphaMax;
        if (m.wow || m.agl < 30) st.alphaProt = false;
      } else aMax = lp.alphaStall + 10 * DEG;
    } else {
      aMax = Math.min((F.alphaLimit ?? 25) * DEG, lp.alphaStall + 25 * DEG);
      st.alphaMax = aMax;
    }

    // flight law demand
    let uAir, qCmd;
    if (apOut.active && apOut.nCmd != null) {
      let n = apOut.nCmd;
      n = pitchAttitudeLimit(n, ad);
      qCmd = qFromN(n, Math.min(aMax, st.alphaProtA || aMax), aMin);
      st.nCmd = n;
      uAir = ndiPitch((F.Kq ?? 4) * (qCmd - ad.q));
      st.holding = false;
    } else if (law === 'conventional') {
      // yoke = elevator around the trim; the elevator feel limits authority at speed
      const dAlpha = Math.abs(m.mom.Mde) / Math.max(-m.mom.MalphaDim, 1);
      const nPerUnit = (ad.qbar * S * lp.CLa * dAlpha) / (m.mass * G0);
      const auth = Math.min(1, (s >= 0 ? (F.pullG ?? 1.6) : (F.pushG ?? 1.2)) / Math.max(nPerUnit, 1e-3));
      uAir = m.act.trim + shape(s, expoP) * auth;
      qCmd = 0;
      // keyboard assist (like a control-wheel-steering / stability augmentation): once the yoke is released a
      // limited-authority elevator command holds the flight path (bank compensated to 30°) and the stabilizer
      // trim slowly unloads it
      if (!m.wow && Math.abs(s) < 0.03 && ad.V > 30) {
        st.assistT += h;
        const n = stickToN(h, 0, ad);
        const q = qFromN(pitchAttitudeLimit(n, ad), lp.alphaStall - 3 * DEG, aMin);
        const uHold = ndiPitch((F.Kq ?? 3) * (q - ad.q));
        const k = smoothstep(0.1, 1.0, st.assistT);
        const A = F.assistPitch ?? 0.35;
        uAir = m.act.trim + k * clamp(uHold - m.act.trim, -A, A);
        st.trimTarget = uHold;
        st.assist = k;
      } else { st.assistT = 0; st.assist = 0; if (Math.abs(s) >= 0.03) { st.holding = false; st.holdT = 0; } }
    } else {
      // FBW
      let n;
      const flareOk = law === 'airbus' && m.sys.gear > 0.9 && m.flapIndexActual >= (F.flareMinFlap ?? 2);
      if (flareOk && !m.wow && m.agl < 15.2 && ad.vs < 1 && !apOut.active) {
        if (!st.flare) { st.flare = true; st.flareTheta = ad.theta; st.flareT = 0; }
      } else if (st.flare && (m.agl > 20 || m.wow || !flareOk)) st.flare = false;
      if (st.flare) {
        if (m.agl < 9.1) st.flareT += h;
        const thCmd = st.flareTheta - 2 * DEG * clamp(st.flareT / 8, 0, 1) + s * (F.flareAuthority ?? 10) * DEG;
        qCmd = clamp(1.2 * (thCmd - ad.theta), -5 * DEG, 5 * DEG);
        st.holding = false;
      } else {
        let sEff = s;
        if (law === 'airbus') {
          // high speed protection above VMO+6 kt / MMO+0.01: the nose-down authority fades out and a nose-up
          // demand limits the speed to about VMO+16 kt with the stick held fully forward
          const vmo = spec.limits.vmo, mmo = spec.limits.mmo;
          const over = Math.max(ad.ias - (vmo + 6 * 0.5144), (ad.M - (mmo + 0.01)) * 650);
          st.highSpeed = over > 0;
          if (s < 0) sEff = s * (1 - smoothstep(-6 * 0.5144, 2 * 0.5144, over));
          n = stickToN(h, sEff, ad);
          if (over > -2 * 0.5144) {
            const V = Math.max(ad.V, 30);
            const nUp = Math.cos(ad.gamma) * Math.cos(ad.phi) + (V * 0.012 * (over + 2 * 0.5144)) / G0;
            n = Math.max(n, Math.min(nUp, 1.8));
            st.holding = false;
          }
          n = pitchAttitudeLimit(n, ad);
        } else n = stickToN(h, s, ad);
        // post-stall (F-22): past ~half stick, when the g demand cannot be met, the stick drives AoA beyond CLmax
        let aOver = null;
        if (law === 'fighter' && aMax > lp.alphaStall + 2 * DEG && s > 0.5 && m.nForAlpha(lp.alphaStall) < n) {
          const k = (s - 0.5) / 0.5;
          aOver = lp.alphaStall - 3 * DEG + (aMax - lp.alphaStall + 3 * DEG) * k * k;
          aOver = Math.max(aOver, Math.min(m.alphaForN(n), aMax));
        }
        qCmd = qFromN(n, aMax, aMin, aOver);
        st.nCmd = n;
      }
      uAir = ndiPitch((F.Kq ?? 4) * (qCmd - ad.q));
    }

    // ground law (weight on wheels): direct elevator, with the rotation rate limited to rotRate x stick and the
    // pitch attitude kept below the tail-strike angle (keyboard friendly rotation)
    let uGround;
    // derotation after touchdown: the nose is lowered at no more than ~2°/s (A320 derotation law; keyboard assist
    // for the others) unless the pilot pushes
    const noseUp = m.wow && m._wheels.some((w) => w.kind !== 'main' && !w.contact) && ad.theta > 0.3 * DEG;
    const derot = noseUp && s < 0.05 ? (F.rotDamping ?? 12) * 0.6 * (-(2 + Math.max(0, -s) * 4) * DEG - ad.q) : 0;
    if (law === 'conventional') {
      // keyboard assist on the takeoff roll: the rotation rate is limited (a full keyboard pull would over-rotate)
      uGround = uAir - (F.rotDamping ?? 12) * Math.max(0, ad.q - Math.max(0, s) * (F.rotRate ?? 4) * DEG) + derot;
    } else {
      const qRot = Math.max(0, s) * (F.rotRate ?? 4) * DEG;
      const kq = (F.rotDamping ?? 12);
      uGround = m.act.trim + s - kq * Math.max(0, ad.q - qRot);
      const tLim = (m.tailStrikeDeg - 1.5) * DEG;
      if (m.wow && ad.theta > tLim - 2 * DEG) uGround -= 3 * (ad.theta - (tLim - 2 * DEG)) + kq * Math.max(0, ad.q) * 0.5;
      uGround += derot;
      if (apOut.active && apOut.groundPitch != null) uGround = m.act.trim + apOut.groundPitch;
    }
    const target = m.wow ? 0 : 1;
    st.blend = moveToward(st.blend, target, h * (target > st.blend ? 1 / (F.blendTime ?? 3) : 2.5));
    if (law === 'conventional' && !(apOut.active && apOut.nCmd != null)) st.blend = target > 0 ? moveToward(st.blend, 1, h * 0.5) : 0;
    st.qCmd = qCmd;
    return lerp(uGround, uAir, st.blend);
  }

  // ---------------------------------------------------------------------------------------------- roll
  function rollLaw(h, s, apOut) {
    const ad = m.ad;
    const I = m.I, w = m._omega;
    let pCmd;
    let direct = null;
    if (apOut.active && apOut.pCmd != null) pCmd = apOut.pCmd;
    else if (law === 'conventional') {
      direct = s;
      if (!m.wow && Math.abs(s) < 0.03 && ad.V > 30) {
        // mild wing leveler (and back to 30° beyond 35° of bank)
        const phi = ad.phi;
        const aphi = Math.abs(phi);
        let pDes = -phi / (F.levelTau ?? 12);
        if (aphi > 35 * DEG) pDes = -Math.sign(phi) * Math.min((aphi - 30 * DEG) * 0.3, 4 * DEG);
        if (aphi > 100 * DEG) pDes = 0;
        pCmd = pDes;
      } else pCmd = null;
    } else if (law === 'airbus') {
      const pMax = (F.rollRateMax ?? 15) * DEG;
      const lim = (st.highSpeed || st.alphaProt ? 45 : (F.bankMax ?? 67)) * DEG;
      const hold = (F.bankHold ?? 33) * DEG;
      if (Math.abs(s) >= 0.03) { pCmd = s * pMax; st.rollHold = false; }
      else {
        if (!st.rollHold && Math.abs(ad.p) < 3 * DEG) { st.rollHold = true; st.phiRef = clamp(ad.phi, -hold, hold); }
        let target = st.rollHold ? st.phiRef : ad.phi;
        if (Math.abs(ad.phi) > hold) target = Math.sign(ad.phi) * hold;
        pCmd = st.rollHold || Math.abs(ad.phi) > hold ? clamp(0.6 * (target - ad.phi), -pMax, pMax) : 0;
      }
      if (pCmd > 0 && ad.phi > lim - 12 * DEG) pCmd = Math.min(pCmd, 0.8 * (lim - ad.phi));
      if (pCmd < 0 && ad.phi < -lim + 12 * DEG) pCmd = Math.max(pCmd, 0.8 * (-lim - ad.phi));
    } else {
      // fighter: roll-rate command, reduced at high AoA / low q / gear down
      let pMax = (F.rollRateMax ?? 300) * DEG;
      pMax *= 1 - 0.75 * smoothstep(15 * DEG, 35 * DEG, ad.alpha);
      if (m.sys.gearHandleDown) pMax = Math.min(pMax, (F.rollRateGear ?? 120) * DEG);
      if (Math.abs(s) >= 0.03) { pCmd = shape(s, expoR) * pMax; st.rollHold = false; }
      else {
        if (!st.rollHold && Math.abs(ad.p) < 15 * DEG) { st.rollHold = true; st.phiRef = ad.phi; }
        pCmd = st.rollHold && Math.abs(ad.theta) < 60 * DEG ? clamp(1.5 * wrapPi(st.phiRef - ad.phi), -pMax, pMax) : 0;
        if (Math.abs(ad.theta) >= 60 * DEG) st.phiRef = ad.phi;
      }
    }
    let ail;
    if (pCmd != null) {
      const pdotDes = (F.Kp ?? 4) * (pCmd - ad.p);
      const Lreq = I.roll * pdotDes - w.x * w.y * (I.yaw - I.pitch);
      const Lda = m.mom.Lda;
      ail = Math.abs(Lda) > 1 ? (Lreq - m.mom.Lbase) / Lda : Math.sign(pdotDes);
      if (direct != null) ail = direct + clamp(ail, -(F.assistRoll ?? 0.25), F.assistRoll ?? 0.25);
    } else ail = direct;
    st.pCmd = pCmd ?? 0;
    // on the ground the FBW laws are direct (with the blend back to flight law after liftoff)
    if (law !== 'conventional' && !(apOut.active && apOut.pCmd != null)) ail = lerp(s, ail, st.blend);
    return clamp(ail, -1, 1);
  }

  // ---------------------------------------------------------------------------------------------- yaw
  function yawLaw(h, pedal, apOut) {
    const ad = m.ad;
    const I = m.I, w = m._omega;
    if (apOut.active && apOut.pedal != null) pedal = apOut.pedal;
    if (m.wow || ad.V < 25) return clamp(pedal, -1, 1);
    const V = Math.max(ad.V, 30);
    const rCoord = (G0 / V) * Math.sin(ad.phi) * Math.cos(ad.theta) + ad.p * Math.tan(clamp(ad.alpha, -0.5, 0.8));
    const betaCmd = pedal * (F.betaMax ?? 8) * DEG;
    const rCmd = rCoord + (F.Kb ?? 1.5) * (ad.beta - betaCmd);
    const rdotDes = (F.Kr ?? 2.5) * (rCmd - ad.r);
    const Nreq = I.yaw * rdotDes - w.x * w.z * (I.pitch - I.roll);
    const Ndr = m.mom.Ndr;
    let rud = Math.abs(Ndr) > 1 ? (Nreq - m.mom.Nbase) / Ndr : 0;
    if (law === 'conventional' && !apOut.active) {
      // yaw damper / turn coordinator with limited authority; the pedals stay direct
      rud = Math.abs(pedal) >= 0.03 ? pedal : clamp(rud, -0.35, 0.35);
    }
    return clamp(lerp(pedal, rud, law === 'conventional' ? 1 : st.blend), -1, 1);
  }

  // ---------------------------------------------------------------------------------------------- update
  function update(h, inp, apOut) {
    const ad = m.ad, act = m.act;
    const sP = clamp(inp.pitch ?? 0, -1, 1), sR = clamp(inp.roll ?? 0, -1, 1), sY = clamp(inp.yaw ?? 0, -1, 1);
    const apStick = apOut.active;
    const uReq = pitchLaw(h, apStick ? 0 : sP, apOut);
    st.uReq = uReq;
    const ailCmd = rollLaw(h, apStick ? 0 : sR, apOut);
    const rudCmd0 = yawLaw(h, apStick && apOut.pedal != null ? 0 : sY, apOut);
    // rudder travel limiter (airliners) vs indicated airspeed
    let rudLim = 1;
    if (F.rudderLimiter) {
      const [v1, v2, minFrac] = F.rudderLimiter;
      rudLim = lerp(1, minFrac, smoothstep(v1, v2, ad.ias));
    }
    const rudCmd = clamp(rudCmd0, -rudLim, rudLim);

    // allocation: elevator (+ stabilizer trim) + thrust vectoring
    let elevCmd, trimNext = act.trim;
    if (law === 'conventional' && !(apOut.active && apOut.nCmd != null)) {
      // elevator = yoke deflection around the stabilizer; the assist moves the stabilizer (auto-trim)
      elevCmd = clamp(uReq - act.trim, -1, 1);
      if (!m.wow && st.assist > 0 && st.trimTarget != null) {
        const rate = (F.assistTrimRate ?? 0.25) * st.assist;
        trimNext = moveToward(act.trim, clamp(st.trimTarget, F.trimRange[0], F.trimRange[1]), rate * h);
      }
    } else if (hasTrim) {
      // auto-trim: the stabilizer follows the demand so the elevator returns near neutral
      if (!m.wow && !st.flare) trimNext = moveToward(act.trim, clamp(uReq, F.trimRange[0], F.trimRange[1]), (rates.trim ?? 0.1) * h);
      elevCmd = clamp(uReq - trimNext, -1, 1);
    } else elevCmd = clamp(uReq, -1, 1);

    let tvcCmd = 0;
    if (F.tvc && m.pp.st.thrust > 1000) {
      const deficit = (uReq - (trimNext + elevCmd)) * m.mom.Mde;
      const perUnit = m.pp.st.thrust * F.tvc.arm * Math.sin(F.tvc.max * DEG);
      tvcCmd = clamp(deficit / perUnit, -1, 1);
      if (m.wow) tvcCmd *= 0;
    }

    // actuators (rate limited)
    act.elevator = moveToward(act.elevator, elevCmd, (rates.elevator ?? 2) * h);
    act.aileron = moveToward(act.aileron, ailCmd, (rates.aileron ?? 2.5) * h);
    act.rudder = moveToward(act.rudder, rudCmd, (rates.rudder ?? 2) * h);
    act.trim = trimNext;
    act.tvc = moveToward(act.tvc, tvcCmd, (rates.tvc ?? 3) * h);
  }

  function reset({ gamma = 0, phi = 0, airborne = false } = {}) {
    st.gammaRef = gamma; st.holding = airborne; st.holdT = 0;
    st.phiRef = phi; st.rollHold = airborne;
    st.blend = airborne ? 1 : 0;
    st.flare = false; st.flareT = 0;
    st.alphaProt = false; st.highSpeed = false; st.alphaFloor = false;
    st.assistT = airborne ? 2 : 0; st.assist = 0; st.trimTarget = null;
  }

  return { st, update, reset, nLevel, ndiPitch };
}
