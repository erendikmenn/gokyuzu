// Turbofan powerplant: spool dynamics, thrust vs Mach / altitude from spec tables, afterburner stages,
// thrust reversers and fuel flow. All engines of an aircraft are driven by the same lever (symmetric thrust).
//
// spec.engine = {
//   thrust: N,            SL static maximum dry thrust per engine (TOGA for airliners, MIL for fighters)
//   thrustAB?: N,         SL static maximum afterburner thrust per engine
//   dry: { alt:[m], mach:[], v:[[fraction of `thrust`]] },   max dry thrust lapse
//   wet?: { alt, mach, v },                                     max AB thrust lapse (fraction of `thrustAB`)
//   idle: fraction of `thrust` at SL static, idleMach: Mach at which idle net thrust reaches zero, idleFloor: min fraction
//   thrustExp: thrust ~ spool^thrustExp,  n1Idle, n1Max,
//   accel: [a0, a1] spool acceleration rate a0 + a1 x (1/s),  decel: [d0, d1],
//   abDelay: s (light-off), abRate: 1/s (stage progression),
//   tsfc: kg/(N s) at SL static, tsfcMach: growth per Mach, tsfcAB: kg/(N s) for the AB increment, ffIdle: kg/s,
//   reverseEff: reverse thrust / forward thrust at the same spool, reverseMax: max spool in reverse, reverseTime: s
// }
import { clamp, interp2, moveToward } from './fixedwing-util.js';

export function createPowerplant(spec) {
  const E = spec.engine;
  const count = spec.engines || 1;
  const exp = E.thrustExp ?? 1.5;
  const accel = E.accel ?? [0.08, 0.3];
  const decel = E.decel ?? [0.12, 0.35];
  const hasAB = !!(E.thrustAB && E.wet);
  const hasRev = !!E.reverseEff;

  const engines = Array.from({ length: count }, () => ({ n1: E.n1Idle ?? 0.2, thrust: 0, afterburner: 0, fuelFlow: 0, nozzle: 0, reverser: 0 }));
  const st = {
    x: 0,            // spool: 0 idle ... 1 max dry
    ab: 0,           // afterburner 0..1
    abTimer: 0,
    rev: 0,          // reverser doors 0 stowed ... 1 deployed
    revCmd: false,
    flameout: false,
    thrust: 0,       // total net thrust (N, + forward)
    fuelFlow: 0,     // total kg/s
    tmil: 0, tidle: 0, twet: 0,
  };

  const pp = {
    engines, st, count, hasAB, hasRev,
    /** Thrust fraction x^exp for a lever power fraction (inverse used by trim). */
    spoolFor(power) { return Math.pow(clamp(power, 0, 1), 1 / exp); },
    /** Max dry / wet / idle thrust (per engine) at altitude h and Mach M, sigma = density ratio. */
    limits(h, M, sigma) {
      st.tmil = E.thrust * interp2(E.dry, h, M);
      st.twet = hasAB ? E.thrustAB * interp2(E.wet, h, M) : st.tmil;
      const idle = (E.idle ?? 0.05) * Math.pow(sigma, 0.7) * (1 - M / (E.idleMach ?? 0.6));
      st.tidle = E.thrust * Math.max(idle, -(E.idleFloor ?? 0.02) * sigma);
      return st;
    },
    /** Net thrust per engine for spool x, afterburner ab, reverser r at the current limits. */
    thrustAt(x, ab, r) {
      const dry = st.tidle + (st.tmil - st.tidle) * Math.pow(clamp(x, 0, 1), exp);
      let t = dry + ab * (st.twet - st.tmil);
      if (r > 0) t = t * (1 - r) - r * (E.reverseEff ?? 0.35) * Math.max(dry, 0);
      return t;
    },
    /** Steady-state lever power fraction (0..1 of the dry range) that gives net thrust T per engine (no AB). */
    powerFor(T) {
      const span = st.tmil - st.tidle;
      if (span <= 1) return 0;
      return clamp((T - st.tidle) / span, 0, 1);
    },
    /** Instantly set the spool (reset / trim). */
    setSpool(x, ab = 0) { st.x = clamp(x, 0, 1); st.ab = ab; st.abTimer = ab > 0 ? 1 : 0; st.rev = 0; st.revCmd = false; st.flameout = false; },

    /**
     * Advance h seconds. cmd: { power 0..1 (dry range), ab 0..1, reverse: bool (deploy request), fuel: kg available }
     * air: { h, M, sigma, theta, delta }. Returns total net thrust (N).
     */
    update(h, cmd, air) {
      pp.limits(air.h, air.M, air.sigma);
      const fuelOk = cmd.fuel > 0;
      st.flameout = !fuelOk;
      // reverser doors
      if (hasRev) {
        st.revCmd = !!cmd.reverse;
        st.rev = moveToward(st.rev, st.revCmd ? 1 : 0, h / (E.reverseTime ?? 1.8));
      }
      // spool target
      let xCmd = pp.spoolFor(cmd.power);
      if (st.rev > 0 && st.rev < 0.98) xCmd = 0;                                 // doors in transit: idle
      else if (st.rev >= 0.98) xCmd = pp.spoolFor(cmd.power) * (E.reverseMax ?? 0.8);
      if (!fuelOk) xCmd = 0;
      const dx = xCmd - st.x;
      const rate = dx > 0 ? Math.min(dx * 3, accel[0] + accel[1] * st.x) : Math.max(dx * 3, -(decel[0] + decel[1] * st.x));
      st.x = clamp(st.x + rate * h, 0, 1);
      // afterburner: lights only near max dry spool, after a short delay, then stages up
      let abCmd = hasAB && fuelOk && st.rev === 0 ? clamp(cmd.ab, 0, 1) : 0;
      if (abCmd > 0 && st.x > 0.93) {
        st.abTimer += h;
        if (st.abTimer < (E.abDelay ?? 0.35)) abCmd = 0;
      } else if (abCmd <= 0) st.abTimer = 0;
      else abCmd = 0;
      st.ab = abCmd > st.ab ? Math.min(abCmd, st.ab + h * (E.abRate ?? 0.9)) : Math.max(abCmd, st.ab - h * 2.5);

      const tEach = fuelOk ? pp.thrustAt(st.x, st.ab, st.rev) : Math.min(st.tidle, 0) * 0.5;
      st.thrust = tEach * count;
      // fuel flow per engine
      const dry = Math.max(0, st.tidle + (st.tmil - st.tidle) * Math.pow(st.x, exp));
      let ff = (E.ffIdle ?? 0.1) * Math.sqrt(Math.max(air.delta, 0.05)) + (E.tsfc ?? 1e-5) * dry * (1 + (E.tsfcMach ?? 1) * air.M) * Math.sqrt(air.theta);
      if (st.ab > 0) ff += (E.tsfcAB ?? 5.5e-5) * st.ab * Math.max(0, st.twet - st.tmil);
      if (!fuelOk) ff = 0;
      st.fuelFlow = ff * count;
      // readouts
      const n1Idle = E.n1Idle ?? 0.2, n1Max = E.n1Max ?? 1;
      const n1 = fuelOk ? n1Idle + (n1Max - n1Idle) * st.x : 0;
      const nozzle = hasAB ? (st.ab > 0 ? 0.3 + 0.7 * st.ab : clamp(0.85 - st.x, 0, 1) * 0.85) : 0;
      for (const e of engines) {
        e.n1 = e.n1 + (n1 - e.n1) * Math.min(1, h * 30);
        e.thrust = tEach;
        e.afterburner = st.ab;
        e.fuelFlow = ff;
        e.nozzle = nozzle;
        e.reverser = st.rev;
      }
      return st.thrust;
    },
  };
  return pp;
}
