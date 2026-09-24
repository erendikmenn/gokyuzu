// Turbofan powerplant: spool dynamics, thrust vs Mach / altitude from spec tables, afterburner stages,
// thrust reversers and fuel flow. All engines of an aircraft are driven by the same lever (symmetric thrust).
// Failures (fixedwing-failures.js): an engine with `out` set produces no thrust but windmilling drag (pp.windmill:
// fan / inlet area × drag coefficient × dynamic pressure) and its N1 winds down to the windmill N1; a relit engine
// (`xs` ≥ 0) spools up on its own from idle until it has caught up with the others. While any engine is out or
// catching up (`degraded`) the engines are computed one by one and `st.yaw` holds the thrust yawing moment
// Σ arm_i × T_i (body torque about +Y in N m, arm = lateral engine position, + right: nose toward the dead engine).
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

  const engines = Array.from({ length: count }, () => ({ n1: E.n1Idle ?? 0.2, thrust: 0, afterburner: 0, fuelFlow: 0, nozzle: 0, reverser: 0,
    // failure state (written by fixedwing-failures.js): out = not producing thrust (failed / shut down / relighting),
    // startN1 ≥ 0: N1 the relight has reached, xs ≥ 0: own spool while catching up after a relight, arm: lateral position (m)
    out: false, startN1: -1, xs: -1, arm: 0, failed: false, fire: false }));
  const wm = { area: 0, cd: 0, n1k: 0.35, n1max: 0.3 };   // windmilling (set by the failure module per type)
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
    yaw: 0,          // thrust yawing moment (body torque about +Y, N m) while degraded
  };

  const pp = {
    engines, st, count, hasAB, hasRev, windmill: wm,
    degraded: false, // some engine out or catching up: per-engine thrust (see updateDegraded)
    /** Recompute `degraded` after an engine state change. */
    refresh() { pp.degraded = engines.some((e) => e.out || e.xs >= 0); if (!pp.degraded) st.yaw = 0; },
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
      if (pp.degraded) return updateDegraded(h, air, fuelOk, xCmd, tEach, ff, n1, nozzle, n1Idle, n1Max);
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

  /** Engines one by one (some out or catching up after a relight). Returns the total net thrust (N). */
  function updateDegraded(h, air, fuelOk, xCmd, tEach, ff, n1, nozzle, n1Idle, n1Max) {
    const qbar = 0.7 * 101325 * air.delta * air.M * air.M;
    const dWm = wm.cd * wm.area * qbar;                       // windmilling drag of a dead engine
    const n1Wm = clamp(wm.n1k * air.M, 0, wm.n1max);
    let total = 0, yaw = 0, ffTot = 0, busy = false;
    for (const e of engines) {
      let t, n1t, f, ab, kN1;
      if (e.out) {
        busy = true;
        t = e.thrust + (-dWm - e.thrust) * Math.min(1, h / 0.8); f = 0; ab = 0;   // thrust runs down in ≈1 s
        n1t = e.startN1 >= 0 ? Math.max(e.startN1, n1Wm) : n1Wm;
        kN1 = Math.min(1, h / (e.startN1 >= 0 ? 0.5 : 2.5));   // run-down ≈ 2.5 s time constant
      } else if (e.xs >= 0) {
        busy = true;
        // relit: own spool from idle toward the common command (same acceleration law), then back in step
        const dx = xCmd - e.xs;
        const rate = dx > 0 ? Math.min(dx * 3, accel[0] + accel[1] * e.xs) : Math.max(dx * 3, -(decel[0] + decel[1] * e.xs));
        e.xs = clamp(e.xs + rate * h, 0, 1);
        const xi = e.xs;
        if (Math.abs(e.xs - st.x) < 0.005) e.xs = -1;
        t = fuelOk ? pp.thrustAt(xi, 0, st.rev) : Math.min(st.tidle, 0) * 0.5;
        const dryi = Math.max(0, st.tidle + (st.tmil - st.tidle) * Math.pow(xi, exp));
        f = fuelOk ? (E.ffIdle ?? 0.1) * Math.sqrt(Math.max(air.delta, 0.05)) + (E.tsfc ?? 1e-5) * dryi * (1 + (E.tsfcMach ?? 1) * air.M) * Math.sqrt(air.theta) : 0;
        ab = 0;
        n1t = fuelOk ? n1Idle + (n1Max - n1Idle) * xi : 0;
        kN1 = Math.min(1, h * 30);
      } else { t = tEach; f = ff; ab = st.ab; n1t = n1; kN1 = Math.min(1, h * 30); }
      e.n1 += (n1t - e.n1) * kN1;
      e.thrust = t; e.afterburner = ab; e.fuelFlow = f; e.nozzle = e.out ? 0.72 : nozzle; e.reverser = st.rev;
      total += t; yaw += e.arm * t; ffTot += f;
    }
    st.thrust = total; st.yaw = yaw; st.fuelFlow = ffTot;
    if (!busy) { pp.degraded = false; st.yaw = 0; }
    return total;
  }
  return pp;
}
