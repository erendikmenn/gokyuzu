// Aerodynamic coefficient model for the fixed-wing flight model, parameterized by spec.aero + spec.flapDetents.
//
// Sign convention (all "+ = right / up"): alpha > 0 wind from below, beta > 0 wind from the right,
// p roll right, q pitch up, r yaw right; elevator + = nose up, aileron + = roll right, rudder + = yaw right.
// Moments are non-dimensional about the CG: pitch by (qbar S cbar), roll / yaw by (qbar S b).
import { DEG, clamp, lerp, smoothstep, interp1 } from './fixedwing-util.js';

/**
 * Configuration (high-lift devices) as a continuous function of the flap "position" c in detent units
 * (c = 0 first detent ... c = n-1 last detent). Fills `out` with dCL, CLmax, dCD, dCm, flap, slats.
 */
export function flapConfig(detents, c, out) {
  const n = detents.length;
  c = clamp(c, 0, n - 1);
  const i = Math.min(Math.floor(c), n - 2 < 0 ? 0 : n - 2);
  const t = n > 1 ? c - i : 0;
  const a = detents[i], b = detents[Math.min(i + 1, n - 1)];
  const g = (k, d = 0) => lerp(a[k] ?? d, b[k] ?? d, t);
  out.dCL = g('dCL');
  out.dCLmax = g('dCLmax');
  out.dCD = g('dCD');
  out.dCm = g('dCm');
  out.flap = g('value');
  out.slats = g('slats');
  out.dAlphaStall = g('dAlphaStall');
  return out;
}

export function createAero(spec) {
  const A = spec.aero;
  const S = spec.wingArea, b = spec.span, c = spec.chord;
  const AR = (b * b) / S;
  const K0 = A.K ?? 1 / (Math.PI * AR * (A.oswald ?? 0.8));
  const round = (A.stallRound ?? 2) * DEG;
  const roundNeg = (A.stallRoundNeg ?? A.stallRound ?? 2) * DEG;
  const drop = A.postStallDrop ?? 2.0;
  const CD90 = A.CD90 ?? 1.6;
  const alpha0 = (A.alpha0 ?? 0) * DEG;

  const self = {
    AR, S, b, c,
    /** Lift-curve parameters at Mach M for configuration cfg (see flapConfig). */
    liftParams(M, cfg, out) {
      out.CLa = A.CLalpha * interp1(A.CLalphaMach ?? 1, M);
      out.dCL = cfg.dCL;
      out.CLmax = (A.CLmax + cfg.dCLmax) * interp1(A.CLmaxMach ?? 1, M);
      out.CLmin = A.CLmin ?? -0.8;
      // alpha where the straight line reaches CLmax, then the curve rounds over +-round
      const aLin = alpha0 + (out.CLmax - out.dCL) / out.CLa;
      out.alphaStall = aLin + round;
      out.alphaKnee = aLin - round;
      const aNeg = alpha0 + (out.CLmin - out.dCL) / out.CLa;
      out.alphaStallNeg = aNeg - roundNeg;
      out.alphaKneeNeg = aNeg + roundNeg;
      return out;
    },

    /** Lift coefficient (no ground effect) from lift parameters lp. */
    CL(alpha, lp) {
      const plate = CD90 * Math.sin(alpha) * Math.cos(alpha);
      if (alpha > lp.alphaKnee) {
        if (alpha < lp.alphaStall) {
          const d = lp.alphaStall - alpha;
          return lp.CLmax - (lp.CLa * d * d) / (4 * round);
        }
        const post = lp.CLmax - drop * (alpha - lp.alphaStall);
        const w = smoothstep(lp.alphaStall, lp.alphaStall + 50 * DEG, alpha);
        return Math.max(post, plate) * (1 - w) + plate * w;
      }
      if (alpha < lp.alphaKneeNeg) {
        if (alpha > lp.alphaStallNeg) {
          const d = alpha - lp.alphaStallNeg;
          return lp.CLmin + (lp.CLa * d * d) / (4 * roundNeg);
        }
        const post = lp.CLmin + drop * (lp.alphaStallNeg - alpha);
        const w = smoothstep(-lp.alphaStallNeg, -lp.alphaStallNeg + 50 * DEG, -alpha);
        return Math.min(post, plate) * (1 - w) + plate * w;
      }
      return lp.CLa * (alpha - alpha0) + lp.dCL;
    },

    /** Ground-effect factor on induced drag (1 = free air) at wing height h (m above ground). */
    groundEffect(h) {
      const hb = Math.max(h, 0.1) / b;
      if (hb > 1.5) return 1;
      const k = 16 * hb * hb;
      return k / (1 + k);
    },

    /**
     * All coefficients for the current state. st: { alpha, beta, M, CL (precomputed incl. ground effect), phiGE,
     * gear, spoilers, speedbrake, cfg, lp, qbar }. Fills out.
     */
    drag(st, out) {
      const { alpha, M, cfg, lp } = st;
      const CL = st.CL;
      const K = K0 * interp1(A.KMach ?? 1, M);
      let CD0 = (A.CD0Mach ? interp1(A.CD0Mach, M) : A.CD0) + cfg.dCD + st.gear * (A.gearCD ?? 0.015)
        + st.spoilers * (A.spoilerCD ?? 0.05) + st.speedbrake * (A.speedbrakeCD ?? 0.05);
      if (A.mdd) {
        // Korn / Lock wave drag for transonic transports
        const mcrit = A.mdd - 0.108 - 0.1 * (CL - 0.5);
        if (M > mcrit) CD0 += Math.min(0.1, 20 * Math.pow(M - mcrit, 4));
      }
      let CDi = K * CL * CL * st.phiGE;
      if (A.suction && alpha > 0) {
        // leading-edge suction is lost progressively at high alpha: induced drag -> CL tan(alpha)
        const loss = smoothstep(A.suction[0] * DEG, A.suction[1] * DEG, alpha);
        const full = CL * Math.tan(Math.min(alpha, 80 * DEG));
        if (full > CDi) CDi += (full - CDi) * loss;
      }
      let CD = CD0 + CDi;
      // beyond the stall the flow separates: drag grows toward the flat plate normal force
      const aAbs = Math.abs(alpha);
      const aS = alpha >= 0 ? lp.alphaStall : -lp.alphaStallNeg;
      const sep = smoothstep(aS - round, aS + 12 * DEG, aAbs);
      if (sep > 0) {
        const sa = Math.sin(aAbs);
        const plate = CD0 + CD90 * sa * sa;
        if (plate > CD) CD += (plate - CD) * sep;
      }
      // sideslip adds some drag
      CD += 0.5 * Math.abs(Math.sin(st.beta)) * Math.abs(A.CYb ?? 0.8) * 0.3;
      out.CD = CD;
      out.K = K;
      return CD;
    },

    /**
     * Base moments (without control surfaces) and control effectiveness.
     * st: { alpha, beta, M, phat, qhat, rhat, qbar, cfg, lp, spoilers }.
     */
    moments(st, out) {
      const { alpha, beta, M, lp } = st;
      const aAbs = Math.abs(alpha);
      const sa = Math.sin(alpha);
      // pitch
      const Cma = interp1(A.CmalphaMach ?? A.Cmalpha, M);
      let Cm = (A.Cm0 ?? 0) + st.cfg.dCm + Cma * sa + (A.Cmq ?? -10) * st.qhat;
      // beyond the stall: pitch break (nose down); high-alpha nose-down keeps FBW jets deep-stall free
      const over = Math.max(0, alpha - lp.alphaStall);
      Cm += (A.CmStall ?? -0.5) * Math.min(over, 30 * DEG);
      if (A.CmHighAlpha) Cm += A.CmHighAlpha.k * Math.max(0, alpha - A.CmHighAlpha.alpha * DEG);
      const under = Math.max(0, lp.alphaStallNeg - alpha);
      Cm += -(A.CmStall ?? -0.5) * Math.min(under, 30 * DEG);
      Cm += (A.CmSpoiler ?? 0) * st.spoilers;
      out.Cm = Cm;
      out.Cmde = interp1(A.CmdeMach ?? A.Cmde, M) * (1 - 0.45 * smoothstep(25 * DEG, 70 * DEG, aAbs));
      // lateral / directional
      const post = smoothstep(lp.alphaStall - 1 * DEG, lp.alphaStall + 8 * DEG, alpha);
      const Clp = (A.Clp ?? -0.4) * (1 - (A.ClpStallLoss ?? 0.7) * post);
      const Cnb = (A.Cnb ?? 0.1) * (1 - (A.CnbHighAlphaLoss ?? 0.6) * smoothstep((A.CnbAlpha ?? 25) * DEG, ((A.CnbAlpha ?? 25) + 25) * DEG, aAbs));
      // base values exclude the control surfaces (the control laws allocate them with the derivatives below)
      out.Cl = (A.Clb ?? -0.08) * Math.sin(beta) + Clp * st.phat + (A.Clr ?? 0.1) * st.rhat;
      // stall wing drop: past the stall the wing that meets the sideslip / rolls down loses lift first (roll-off)
      if (post > 0) out.Cl += (A.wingDrop ?? 0.02) * post * clamp(Math.sin(beta) * 8 + st.phat * 25, -1, 1);
      out.Cn = Cnb * Math.sin(beta) + (A.Cnr ?? -0.15) * st.rhat + (A.Cnp ?? -0.03) * st.phat;
      out.CY = (A.CYb ?? -0.8) * Math.sin(beta);
      out.CYdr = A.CYdr ?? 0.1;
      // aeroelastic loss of roll control at high dynamic pressure, and at / beyond the stall
      const ae = A.rollQref ? 1 / (1 + st.qbar / A.rollQref) : 1;
      out.Clda = (A.Clda ?? 0.06) * ae * (1 - 0.6 * post) * interp1(A.CldaMach ?? 1, M);
      out.Cndr = (A.Cndr ?? 0.05) * (1 - 0.5 * smoothstep(30 * DEG, 70 * DEG, aAbs));
      out.Cnda = A.Cnda ?? 0;
      out.Cldr = A.Cldr ?? 0;
      return out;
    },
  };
  return self;
}
