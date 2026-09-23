// Shared layer / alert builders used by the per-aircraft sound profiles.
//
// A profile (default export of profiles/<id>.js) is plain data + small functions of the derived state `s`
// (see src/audio/index.js → deriveState) and, for engine layers, of the engine state `e`:
//   s: { cockpit, t, dt, eng[], n1, pow, ab, rev, thr, tas, ias, mach, qn, gs, vs, agl, g, onGround, gear, flaps,
//        flapsIndex, flapsCount, spoilers, speedbrake, brakes, canopy, gearMoving, flapMoving, canopyMoving,
//        rotor, collective, torque, stalled, dead, w: {stall, overspeed, gear, bank, sinkRate, pullUp}, fuelFrac,
//        + alert inputs: ft, kt, fpm, altFt, roll, aoa, gearHandle, apMode, apAlt, fcuValid, athr, fuelKg, gsDots… }
//   e: { n1, pow, ab, rev, on, i }
// Layer: { id, file, emitter, perEngine, dir: 'front'|'rear'|'omni'|{front,side,rear}, ext, int, intPath:
//          'eng'|'direct', gain(s,e), rate(s,e)?, lp(s,e)?, lpQ?, tau? }
//   ext / int: send levels (number or function(s,e)); gain: state level (linear); files are loudness-normalised.
import { band, clamp, db, lin, sstep } from '../util.js';

/** Cockpit airflow level: boundary-layer noise ∝ q, transonic buffet bump, quieter once supersonic. */
export function cockpitWind(s) {
  const q = Math.min(2.2, Math.pow(s.ias / 150, 1.5));
  const trans = 1 + 0.6 * band(s.mach, 0.85, 0.94, 1.0, 1.08);
  const sup = 1 - 0.45 * sstep(1.02, 1.3, s.mach);
  return s.dead ? 0 : q * trans * sup;
}

export function airframeLayers(o = {}) {
  const L = [
    { id: 'wind_ext', file: 'common/wind_ext', emitter: 'air', dir: 'omni', ext: db(o.windExtDb ?? -6), int: 0,
      // airframe noise: flaps/slats side edges and the extended gear add broadband roar on approach
      gain: (s) => (s.dead ? 0 : Math.min(2.5, Math.pow(s.tas / 140, 2))
        * (1 + (o.airframeNoise ?? 0) * (1.2 * s.flaps + 0.8 * s.gear * (1 - s.onGround)))),
      rate: (s) => 0.75 + clamp(s.tas / 320) * 0.5, lp: (s) => 350 + s.tas * 45 },
    { id: 'wind_int', file: `common/${o.cockpitWind || 'wind_deck'}`, int: db(o.windIntDb ?? 0), intPath: 'direct',
      gain: cockpitWind, rate: (s) => 0.85 + clamp(s.ias / 400) * 0.35,
      lp: (s) => (o.windLp ?? 1400) + s.ias * (o.windLpSlope ?? 30) },
    { id: 'buffet', file: 'common/buffet', emitter: 'air', ext: db(-14), int: db(o.buffetDb ?? -2), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : Math.max(s.w.stall ? 0.55 : 0, s.stalled ? 1 : 0,
        (o.transonicBuffet ?? 0.5) * band(s.mach, 0.86, 0.95, 1.0, 1.06),
        (o.gBuffet ?? 0) * sstep(4.5, 8.5, s.g) * clamp(s.qn * 1.5, 0, 1),
        0.7 * s.speedbrake * clamp(s.qn * 1.3, 0, 1.2), 0.5 * s.spoilers * clamp(s.qn * 1.3, 0, 1.2))) },
  ];
  if (o.gear !== false) {
    L.push(
      { id: 'gear_drag', file: 'common/gear_drag', emitter: 'air', dir: 'omni', ext: db(-6), int: db(o.gearDragDb ?? -12),
        intPath: 'direct', gain: (s) => (s.dead ? 0 : s.gear * clamp(s.qn * 1.3, 0, 1.4) * (1 - s.onGround)) },
      { id: 'gear_motor', file: 'common/gear_motor', emitter: 'air', ext: db(-12), int: db(o.gearMotorDb ?? -10),
        intPath: 'direct', gain: (s) => s.gearMoving, rate: (s) => 0.97 + 0.06 * s.gear },
      { id: 'roll', file: 'common/roll', emitter: 'air', ext: db(-8), int: db(o.rollDb ?? -6), intPath: 'direct',
        gain: (s) => s.onGround * sstep(0.3, 6, s.gs) * lin(s.gs, 0, 80, 0.35, 1.2),
        rate: (s) => 0.55 + Math.min(1.3, s.gs / 70), lp: (s) => 500 + s.gs * 60 },
      { id: 'squeal', file: 'common/brake_squeal', emitter: 'air', ext: db(-10), int: db(-18), intPath: 'direct',
        gain: (s) => s.onGround * sstep(0.3, 0.7, s.brakes) * band(s.gs, 0.5, 2, 16, 28) },
    );
  }
  if (o.flapMotor) {
    L.push({ id: 'flap_motor', file: `common/${o.flapMotor}`, emitter: 'air', ext: db(o.flapMotorExtDb ?? -10),
      int: db(o.flapMotorDb ?? -14), intPath: 'direct', gain: (s) => s.flapMoving,
      rate: (s) => 0.92 + 0.1 * s.flaps });
  }
  if (o.canopy) {
    L.push({ id: 'canopy_motor', file: 'common/canopy_motor', emitter: 'air', ext: db(-6), int: db(-6), intPath: 'direct',
      gain: (s) => s.canopyMoving });
  }
  if (o.avionicsDb != null) {
    L.push({ id: 'avionics', file: 'common/avionics', int: db(o.avionicsDb), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : 1) });
  }
  return L;
}

/** Default one-shot map (profiles may override entries). */
export const COMMON_SHOTS = {
  touchdownLight: 'common/touchdown_light', touchdownHeavy: 'common/touchdown_heavy', noseTouch: 'common/nose_touch',
  gearUnlock: 'common/gear_unlock', gearLockDown: 'common/gear_lock_down', gearLockUp: 'common/gear_lock_up',
  flapLever: 'common/flap_lever', speedbrake: 'common/speedbrake', spoiler: 'common/spoiler_deploy',
  reverser: 'common/reverser_unlock', canopyLock: 'common/canopy_lock', canopyUnlock: 'common/canopy_unlock',
  canopySeal: 'common/canopy_seal', click: 'common/click', clickSoft: 'common/click_soft', bump: 'common/bump',
  crash: 'common/crash', boom: 'common/sonic_boom',
};

// ------------------------------------------------------------------------------------------------ alerts
// The aural alerts of each aircraft are emulations of its real warning systems: src/audio/alertlogic.js (profiles
// list them in alerts.systems). The A/P-disconnect sounds (A320 cavalry charge, 737 wailer) are GPL-2.0 FlightGear
// files: the cavalry charge is a re-synthesis from an Airbus waveform diagram (1660/830 Hz square waves), the
// wailer's origin is not stated (see assets/audio/CREDITS.txt).
