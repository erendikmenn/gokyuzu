// UH-60M-style Automatic Flight Control System for keyboard play.
//
//  * SAS + FPS (always on): rate command / attitude hold in pitch and roll ("force trim": release the key and the
//    attitude at release is held), heading hold / yaw-rate command at low speed, automatic turn coordination and
//    heading hold (through small bank corrections) in forward flight. Integrators = automatic trim.
//  * Coupled modes (the 'autopilot' action):
//      'hover'  – hover hold: translational-rate command (stick → ground speed), position hold when hands-off,
//                 radar/baro altitude hold on the collective (lever = altitude beeper).
//      'cruise' – altitude + airspeed + heading hold (stick moves the references).
// On the ground (weight on wheels) the loops are frozen and re-initialised to the hover trim for a clean lift-off.
//
// Inputs are normalised control positions: cLon (+ forward), cLat (+ right), cPed (+ right pedal), collective 0..1.
import { G, DEG, clamp, smoothstep, lerp, moveToward, wrapPi } from './helicopter-aero.js';

const GAINS = {
  pitchRate: 20 * DEG, rollRate: 38 * DEG, yawRate: 45 * DEG,     // full-stick rate commands
  Kth: 1.8, Kq: 5.0, Kith: 1.0,                                   // pitch attitude / rate / integral
  Kph: 2.5, Kp: 8.0, Kiph: 1.5,                                   // roll
  Kpsi: 1.3, Kr: 4.0, Kir: 0.8, Kbeta: 1.6, Kibeta: 0.25, KbetaRate: 0.8,   // yaw
  hdgBank: 1.6, maxHdgBank: 6 * DEG, hdgTrimI: 0.12,              // heading hold through bank (forward flight)
  pitchLimit: 35 * DEG, rollLimit: 60 * DEG, refLead: 10 * DEG,
  // hover hold
  hoverSpeed: 10, hoverSpeedLat: 8, Ku: 0.55, Kui: 0.08, Kx: 0.22, maxAccel: 3.0, attSlew: 8 * DEG,
  // hover augmentation (FPS velocity stabilisation at low speed with the cyclic released)
  KuA: 0.12, KuiA: 0.02, augSlew: 6 * DEG, augLow: 5, augHigh: 10, augDelay: 0.5, augMaxDev: 4 * DEG, lowSpeedRate: 0.55,
  // lateral drift / sideslip nulling below ≈ 40 kt (roll channel, cyclic centred)
  KvL: 0.45, KviL: 0.03, latLow: 16, latHigh: 22, latMaxDev: 12 * DEG, latSlew: 10 * DEG, latDelay: 0.15,
  hoverEngage: 40 * 0.514444,                                     // O selects hover hold below ≈ 40 kt ground speed
  // airspeed hold (FPS in forward flight with the cyclic released, and the cruise hold)
  KV: 0.25, KA: 0.8, KVi: 0.015, speedSlew: 8 * DEG, speedLow: 8, speedHigh: 14, settleRate: 5 * DEG,
  // altitude hold (collective)
  Kh: 0.35, Kvz: 1.4, Kvzi: 0.45, vzMaxHover: 3, vzMaxCruise: 6, beeper: 30,
};

export class AFCS {
  constructor() {
    this.enabled = true;        // SAS/FPS on
    this.ap = { on: false, mode: null, altitude: 0, heading: 0, speed: 0, radar: false };
    this.hoverTrim = { cLon: 0, cLat: 0, cPed: 0, theta: 3 * DEG, phi: 0, collective: 0.6 };
    this.trimPitch = null;      // Float64Array: trim pitch attitude every 5 m/s of airspeed (from the trim solver)
    this.reset(null, 0);
  }

  /** Initialise references and integrators from a trim state (or the hover trim when t is null). */
  reset(t, psi) {
    const h = t || this.hoverTrim;
    this.trimLon = h.cLon; this.trimLat = h.cLat; this.trimPed = h.cPed;
    this.thRef = h.theta; this.phRef = h.phi; this.psiRef = psi;
    this.yawCaptured = true; this.hdgCaptured = !!t;
    this.hdgRef = psi;
    this.colI = t ? t.collective : 0;
    this.Iu = 0; this.Iv = 0; this.IV = 0; this.IuA = 0; this.IvA = 0; this.IvL = 0; this.relP = 9; this.relR = 9;
    this.vHold = t && t.speed ? t.speed : 0;
    this.settling = false; this.uDot = 0; this.uPrev = undefined;
    this.hoverAugment = this.hoverAugment ?? true;
    this.posCaptured = false; this.xRef = 0; this.zRef = 0;
    this.thBase = h.theta; this.phBase = h.phi;
    this.phTrimF = h.phi;       // wings-level bank in forward flight (tail-rotor side force), learned by the heading hold
    this.bankByPilot = false;   // bank reference set by the pilot (held in turns) or by the SAS (levelled)
    this.ap.on = false; this.ap.mode = null;
    this.frozenLon = h.cLon; this.frozenLat = h.cLat; this.frozenPed = h.cPed;
  }

  engage(s) {
    if (s.wow > 0.3) return false;
    const ap = this.ap;
    ap.on = true;
    ap.mode = Math.hypot(s.gsF, s.gsR) < GAINS.hoverEngage ? 'hover' : 'cruise';
    ap.radar = ap.mode === 'hover' && s.agl < 120;
    ap.altitude = ap.radar ? s.agl : s.alt;
    ap.heading = s.psi;
    ap.speed = Math.max(0, s.gsF);
    this.vHold = ap.speed; this.settling = false;
    this.colI = s.collective;
    // hover hold works around the solved hover attitude; cruise hold around the current one
    this.thBase = ap.mode === 'hover' ? this.hoverTrim.theta : s.theta;
    this.phBase = ap.mode === 'hover' ? this.hoverTrim.phi : s.phi;
    this.Iu = 0; this.Iv = 0; this.IV = 0;
    this.posCaptured = false;
    this.hdgRef = s.psi; this.hdgCaptured = true;
    this.psiRef = s.psi; this.yawCaptured = true;
    return true;
  }

  disengage() { this.ap.on = false; this.ap.mode = null; }

  /** Hover hold beeped below the ground: coupled descent to touchdown (height hold released on the wheels). */
  isLanding() { const ap = this.ap; return ap.on && ap.mode === 'hover' && ap.radar && ap.altitude < 0.5; }

  /** Trim pitch attitude (rad) for a forward airspeed (m/s), interpolated from the trim table. */
  thetaTrim(u) {
    const tp = this.trimPitch;
    if (!tp || !tp.length) return this.hoverTrim.theta;
    const x = clamp(u / 5, 0, tp.length - 1.001);
    const i = Math.floor(x), f = x - i;
    return tp[i] + (tp[i + 1] - tp[i]) * f;
  }

  /**
   * One control step. pilot = { pitch, roll, yaw, leverDelta }, s = sensor struct (see helicopter.js), out receives
   * { cLon, cLat, cPed, collective (NaN when the pilot's lever drives it) }.
   */
  update(h, pilot, s, out) {
    const K = GAINS;
    const db = 0.005;   // keyboard axes return to exactly 0; the input module applies the gamepad dead-zone
    const sp = Math.abs(pilot.pitch) > db ? pilot.pitch : 0;
    const sr = Math.abs(pilot.roll) > db ? pilot.roll : 0;
    const sy = Math.abs(pilot.yaw) > db ? pilot.yaw : 0;
    out.collective = NaN;

    if (!this.enabled) {
      // raw mechanical controls around the trim frozen when the AFCS was switched off
      out.cLon = clamp(this.frozenLon - 0.5 * pilot.pitch, -1, 1);
      out.cLat = clamp(this.frozenLat + 0.5 * pilot.roll, -1, 1);
      out.cPed = clamp(this.frozenPed + 0.6 * pilot.yaw, -1, 1);
      return out;
    }

    const ap = this.ap;
    // on the wheels the hold releases; a coupled landing first lowers the collective to flat pitch
    if (ap.on && s.wow > 0.5 && !(this.isLanding() && s.collective > 0.02)) this.disengage();
    // hover hold engaged high up (baro): switch to the radar height reference below 100 m AGL
    if (ap.on && ap.mode === 'hover' && !ap.radar && s.agl < 100) { ap.altitude -= s.alt - s.agl; ap.radar = true; }
    if (ap.on && ap.mode === 'cruise' && s.V < 9) {        // slowed down: cruise hold becomes hover hold
      ap.mode = 'hover'; ap.radar = s.agl < 120; ap.altitude = ap.radar ? s.agl : s.alt;
      this.thBase = this.hoverTrim.theta; this.phBase = this.hoverTrim.phi; this.Iu = 0; this.Iv = 0; this.posCaptured = false;
    }

    // ---------------- ground (weight on wheels): loops frozen at the hover trim ----------------
    const wow = s.wow;
    if (wow > 0.5) {
      const ht = this.hoverTrim;
      this.trimLon = ht.cLon; this.trimLat = ht.cLat;
      this.trimPed = ht.cPed * clamp(s.collective / Math.max(ht.collective, 0.2), 0, 1.3);
      this.thRef = ht.theta; this.phRef = ht.phi;
      this.psiRef = s.psi; this.yawCaptured = true; this.hdgRef = s.psi; this.hdgCaptured = true;
      this.frozenLon = this.trimLon; this.frozenLat = this.trimLat; this.frozenPed = this.trimPed;
    }

    // filtered forward acceleration (airspeed-hold damping)
    // (forward horizontal speed: attitude-independent, equals the airspeed without wind)
    const uh = Math.max(0, s.gsF);
    if (this.uPrev === undefined) this.uPrev = uh;
    this.uDot += ((uh - this.uPrev) / Math.max(h, 1e-4) - this.uDot) * Math.min(1, h / 0.4);
    this.uPrev = uh;
    const wF = smoothstep(15, 28, s.V);               // forward-flight blend (≈ 30…55 kt)
    const gs = Math.hypot(s.gsF, s.gsR);
    const wAug = this.hoverAugment && wow < 0.5 ? 1 - smoothstep(K.augLow, K.augHigh, gs) : 0;
    const rateScale = lerp(K.lowSpeedRate, 1, wF);    // gentler attitude rates in the hover (keyboard taps)
    this.relP = sp ? 0 : this.relP + h; this.relR = sr ? 0 : this.relR + h;
    const augP = wAug * smoothstep(0, K.augDelay, this.relP);
    const uhL = Math.max(0, s.gsF);
    const wLat = this.hoverAugment && wow < 0.5 ? (1 - smoothstep(K.latLow, K.latHigh, uhL)) * smoothstep(0, K.latDelay, this.relR) : 0;
    const sth = Math.sin(s.theta), cth = Math.cos(s.theta), sph = Math.sin(s.phi), cph = Math.cos(s.phi);
    let thDotFF = 0, phDotFF = 0;

    // ---------------- pitch & roll references ----------------
    if (ap.on && ap.mode === 'hover') {
      // translational-rate command with position hold
      let uc = -sp * K.hoverSpeed, vc = sr * K.hoverSpeedLat;
      if (!sp && !sr) {
        if (!this.posCaptured && Math.hypot(s.gsF, s.gsR) < 1.0) { this.posCaptured = true; this.xRef = s.x; this.zRef = s.z; }
        if (this.posCaptured) {
          const dx = this.xRef - s.x, dz = this.zRef - s.z;
          const sps = Math.sin(s.psi), cps = Math.cos(s.psi);
          uc += clamp(K.Kx * (dx * sps - dz * cps), -2, 2);
          vc += clamp(K.Kx * (dx * cps + dz * sps), -2, 2);
        }
      } else this.posCaptured = false;
      const eu = uc - s.gsF, ev = vc - s.gsR;
      if (Math.abs(eu) < 2) this.Iu = clamp(this.Iu + K.Kui * eu * h, -2, 2);   // integrate near the target only (no overshoot)
      if (Math.abs(ev) < 2) this.Iv = clamp(this.Iv + K.Kui * ev * h, -2, 2);
      const aF = clamp(K.Ku * eu + this.Iu, -K.maxAccel, K.maxAccel);
      const aR = clamp(K.Ku * ev + this.Iv, -K.maxAccel, K.maxAccel);
      this.thRef = moveToward(this.thRef, clamp(this.thBase - aF / G, -25 * DEG, 25 * DEG), K.attSlew * h);
      this.phRef = moveToward(this.phRef, clamp(this.phBase + aR / G, -25 * DEG, 25 * DEG), K.attSlew * h);
    } else {
      // pitch: rate command / attitude hold (cruise hold: airspeed hold on the pitch attitude)
      const wS = smoothstep(K.speedLow, K.speedHigh, uh);   // airspeed hold weight (≈ 15…27 kt and up)
      if (sp) {
        this.IuA = 0; this.IV = 0;
        thDotFF = sp * K.pitchRate * rateScale;
        this.thRef += thDotFF * h;
        this.vHold = uh; this.settling = true;
        if (ap.on) ap.speed = uh;
      } else if (this.settling) {
        // cyclic released: the attitude eases back to the trim attitude for the current airspeed; the airspeed
        // reached when it gets there is the one the FPS then holds ("push longer → end up faster")
        const tt = this.thetaTrim(uh);
        this.thRef = moveToward(this.thRef, tt, K.settleRate * h);
        this.vHold = uh;
        if (ap.on) ap.speed = uh;
        if (Math.abs(this.thRef - tt) < 1 * DEG) this.settling = false;
      } else {
        if (augP > 0 && !ap.on && wS < 1) {
          // hover augmentation: gentle drift damping toward a hover
          const eu = -s.gsF;
          if (Math.abs(eu) < 1) this.IuA = clamp(this.IuA + K.KuiA * eu * h, -1, 1);
          const aF = clamp(K.KuA * eu + this.IuA, -2, 2);
          const ht = this.hoverTrim.theta;
          const target = clamp(ht - aF / G, ht - K.augMaxDev, ht + K.augMaxDev);
          const w = augP * (1 - wS);
          this.thRef = moveToward(this.thRef, lerp(this.thRef, target, w), K.augSlew * w * h);
        }
        if (wS > 0 && (!ap.on || ap.mode === 'cruise')) {
          // airspeed hold: the attitude that holds the airspeed captured when the cyclic was released
          const vRef = ap.on ? ap.speed : this.vHold;
          const eV = uh - vRef;
          if (Math.abs(eV) < 3) this.IV = clamp(this.IV + K.KVi * eV * h, -0.12, 0.12);
          const aDes = clamp(-K.KV * eV - K.KA * this.uDot, -2.5, 2.5);
          const target = clamp(this.thetaTrim(uh) - aDes / G + this.IV, -25 * DEG, 20 * DEG);
          this.thRef = moveToward(this.thRef, lerp(this.thRef, target, wS), K.speedSlew * wS * h);
        }
      }
      // roll: rate command / attitude hold; forward flight: wings level + heading hold through bank
      if (sr) {
        this.IvA = 0; this.IvL = 0; this.bankByPilot = true;
        phDotFF = sr * K.rollRate * rateScale;
        this.phRef += phDotFF * h;
        this.hdgCaptured = false;
      } else if (wLat > 0 && !ap.on) {
        // cyclic centred below ≈ 40 kt: null the lateral ground speed (sideslip) around the hover roll trim
        const ev = -s.gsR;
        if (Math.abs(ev) < 1) this.IvL = clamp(this.IvL + K.KviL * ev * h, -1, 1);
        const aR = clamp(K.KvL * ev + this.IvL, -3, 3);
        const hp = this.hoverTrim.phi;
        const target = clamp(hp + aR / G, hp - K.latMaxDev, hp + K.latMaxDev);
        this.phRef = moveToward(this.phRef, lerp(this.phRef, target, wLat), K.latSlew * wLat * h);
        if (wLat > 0.5) this.bankByPilot = false;
      } else if (wF > 0.5 && (Math.abs(this.phRef - this.phTrimF) < 5 * DEG || !this.bankByPilot || ap.on)) {
        const psiDot = Math.abs(s.r);
        if (!this.hdgCaptured && psiDot < 2 * DEG && Math.abs(s.phi - this.phTrimF) < 6 * DEG) { this.hdgCaptured = true; this.hdgRef = s.psi; if (ap.on) ap.heading = s.psi; }
        let target = this.phTrimF;
        if (this.hdgCaptured) {
          const eh = wrapPi(this.hdgRef - s.psi);
          this.phTrimF = clamp(this.phTrimF + K.hdgTrimI * eh * h * wF, -12 * DEG, 12 * DEG);
          target += clamp(K.hdgBank * eh, -K.maxHdgBank, K.maxHdgBank);
        }
        this.phRef = moveToward(this.phRef, target, 10 * DEG * h);
      }
    }
    this.thRef = clamp(this.thRef, Math.max(-K.pitchLimit, s.theta - K.refLead), Math.min(K.pitchLimit, s.theta + K.refLead));
    this.phRef = clamp(this.phRef, Math.max(-K.rollLimit, s.phi - K.refLead), Math.min(K.rollLimit, s.phi + K.refLead));

    // ---------------- yaw: heading hold (hover) / turn coordination (forward flight) ----------------
    // Above ≈ 10 kt with the pedals centred the nose is kept into the relative wind (sideslip → yaw rate), so a
    // lateral drift cannot build up in the transition; not while the hover hold flies a commanded sideward translation.
    const wB = ap.on && ap.mode === 'hover' ? 0 : smoothstep(8, 12, s.V);
    let psiDotH;
    if (sy) { psiDotH = sy * K.yawRate; this.psiRef = s.psi; this.yawCaptured = false; }
    else if (wB > 0.05 || wF > 0.95) { psiDotH = 0; this.psiRef = s.psi; this.yawCaptured = true; }
    else if (!this.yawCaptured) {
      psiDotH = 0;
      if (Math.abs(s.r) < 3 * DEG) { this.yawCaptured = true; this.psiRef = s.psi; }
    } else psiDotH = K.Kpsi * wrapPi(this.psiRef - s.psi);
    const psiDotTurn = (G * Math.tan(clamp(s.phi - this.phTrimF * wF, -1.2, 1.2))) / Math.max(s.V, 15) + sy * 12 * DEG;
    const psiDot = lerp(psiDotH, psiDotTurn, wF) + (sy ? 0 : wB * K.KbetaRate * clamp(s.beta, -0.6, 0.6));
    const wY = wB;

    // ---------------- Euler-rate → body-rate commands and rate loops ----------------
    const eth = this.thRef - s.theta, eph = this.phRef - s.phi;
    const thDot = K.Kth * eth + thDotFF;
    const phDot = K.Kph * eph + phDotFF;
    const pc = phDot - psiDot * sth;
    const qc = thDot * cph + psiDot * sph * cth;
    const rc = -thDot * sph + psiDot * cph * cth;
    const qdd = K.Kq * (qc - s.q);
    const pdd = K.Kp * (pc - s.p);
    let rdd = K.Kr * (rc - s.r);
    const betaFb = sy ? 0 : wY * K.Kbeta * clamp(s.beta, -0.5, 0.5);
    rdd += betaFb;

    const Bq = Math.max(s.Bq, 0.3), Bp = Math.max(s.Bp, 1.0), Br = Math.max(s.Br, 0.3);
    let cLon = this.trimLon - qdd / Bq;
    let cLat = this.trimLat + pdd / Bp;
    let cPed = this.trimPed + rdd / Br;

    // integrators (automatic trim), frozen on the ground and while the output saturates
    const air = 1 - clamp(wow * 2, 0, 1);
    if (air > 0) {
      const dLon = (-K.Kq * K.Kith * eth / Bq) * h * air;
      if (!((cLon >= 1 && dLon > 0) || (cLon <= -1 && dLon < 0))) this.trimLon = clamp(this.trimLon + dLon, -1, 1);
      const dLat = (K.Kp * K.Kiph * eph / Bp) * h * air;
      if (!((cLat >= 1 && dLat > 0) || (cLat <= -1 && dLat < 0))) this.trimLat = clamp(this.trimLat + dLat, -1, 1);
      const dPed = ((K.Kr * K.Kir * (rc - s.r) + (sy ? 0 : wY * K.Kibeta * s.beta * 4)) / Br) * h * air;
      if (!((cPed >= 1 && dPed > 0) || (cPed <= -1 && dPed < 0))) this.trimPed = clamp(this.trimPed + dPed, -1, 1);
    }

    // ground law: direct stick around the hover trim; blended by weight on wheels
    if (wow > 0) {
      const gLon = this.trimLon - pilot.pitch * 0.45;
      const gLat = this.trimLat + pilot.roll * 0.45;
      // taxi turns: pedals command a yaw rate (≤ 20°/s) instead of raw tail-rotor pitch
      const gPed = this.trimPed + clamp((K.Kr * (sy * 20 * DEG - s.r)) / Br, -0.6, 0.6);
      cLon = lerp(cLon, gLon, wow); cLat = lerp(cLat, gLat, wow); cPed = lerp(cPed, gPed, wow);
    }
    out.cLon = clamp(cLon, -1, 1);
    out.cLat = clamp(cLat, -1, 1);
    out.cPed = clamp(cPed, -1, 1);

    // ---------------- collective: altitude hold when coupled ----------------
    if (ap.on) {
      ap.altitude += pilot.leverDelta * K.beeper;
      if (ap.radar) ap.altitude = Math.max(ap.altitude, -1);        // beeping below the ground = land
      const hm = ap.radar ? s.agl : s.alt;
      const vzMax = ap.mode === 'hover' ? K.vzMaxHover : K.vzMaxCruise;
      let vzc = clamp(K.Kh * (ap.altitude - hm), -vzMax, vzMax);
      const landing = this.isLanding();
      if (landing) vzc = -clamp(0.6 + 0.3 * Math.max(s.agl, 0), 0.6, vzMax);   // steady descent, ≈ 0.6–0.7 m/s at touchdown
      vzc = Math.max(vzc, -(0.6 + 0.3 * Math.max(s.agl, 0)));       // never faster than that close to the ground
      const e = vzc - s.vz;
      const A = Math.max(s.Acol, 3);
      let dI = (K.Kvzi * e / A) * h;
      let col = this.colI + (K.Kvz * e) / A;
      // on the wheels while landing: lower the collective, the height hold releases once the weight is on the gear
      if (landing && (s.wow > 0 || s.onGround)) { dI = -0.35 * h; col = Math.min(col, this.colI + dI); }
      // torque / rotor-speed protection
      if ((s.torque > 1.0 || s.nr < 0.97) && col > s.collective) { col = s.collective; if (dI > 0) dI = 0; }
      this.colI = clamp(this.colI + dI, 0, 1);
      out.collective = clamp(col, 0, 1);
      ap.heading = this.hdgCaptured && wF > 0.5 ? this.hdgRef : this.psiRef;
    }
    return out;
  }
}
