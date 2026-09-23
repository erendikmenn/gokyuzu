// Shared layer / alert builders used by the per-aircraft sound profiles.
//
// A profile (default export of profiles/<id>.js) is plain data + small functions of the derived state `s`
// (see src/audio/index.js → deriveState) and, for engine layers, of the engine state `e`:
//   s: { cockpit, t, dt, eng[], n1, pow, ab, rev, thr, tas, ias, mach, qn, gs, vs, agl, g, onGround, gear, flaps,
//        flapsIndex, flapsCount, spoilers, speedbrake, brakes, canopy, gearMoving, flapMoving, canopyMoving,
//        rotor, collective, torque, stalled, dead, w: {stall, overspeed, gear, bank, sinkRate, pullUp}, fuelFrac }
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

// ------------------------------------------------------------------------------------------------ alert sets
const RA_AIRBUS = [[2500, 'v_2500'], [1000, 'v_1000'], [500, 'v_500'], [400, 'v_400'], [300, 'v_hundredabove'],
  [200, 'v_minimums'], [100, 'v_100'], [50, 'v_50'], [40, 'v_40'], [30, 'v_30'], [20, 'v_20'], [10, 'v_10'], [5, 'v_5']];
const RA_BOEING = [[2500, 'v_2500'], [1000, 'v_1000'], [500, 'v_500'], [300, 'v_hundredabove'], [200, 'v_minimums'],
  [100, 'v_100'], [50, 'v_50'], [40, 'v_40'], [30, 'v_30'], [20, 'v_20'], [10, 'v_10']];

/** GPWS mode 4B-like: too low with flaps not in landing configuration (gear down, descending, slow, < 245 ft). */
const tooLowFlaps = (s) => !s.onGround && s.agl < 75 && s.agl > 8 && s.vs < -1 && s.gear > 0.9 && s.ias < 95
  && s.flapsCount > 1 && s.flapsIndex < s.flapsCount - 2;

export function bettyAlerts(dir, { stallVoice = 'v_warning' } = {}) {
  const v = (n) => `${dir}/${n}`;
  return {
    style: 'betty', chime: v('v_caution'), apDisconnect: null,
    rules: [
      { id: 'pullUp', when: (s) => s.w.pullUp, voice: v('v_pullup'), prio: 10, repeat: 0.25 },
      { id: 'altitude', when: (s) => s.w.sinkRate && !s.w.pullUp && s.agl < 400, voice: v('v_altitude'), prio: 8, repeat: 0.9 },
      { id: 'stall', when: (s) => s.w.stall, voice: v(stallVoice), prio: 7, repeat: 1.2 },
      { id: 'overg', when: (s) => s.g > 9.3, voice: v('v_overg'), prio: 6, repeat: 1.5 },
      { id: 'gear', when: (s) => s.w.gear, voice: v('v_gear'), prio: 5, repeat: 3 },
      { id: 'overspeed', when: (s) => s.w.overspeed, voice: v('v_caution'), prio: 4, repeat: 4 },
      { id: 'bingo', when: (s) => s.fuelFrac < 0.12, voice: v('v_bingo'), prio: 3, once: true },
    ],
  };
}

export function airlinerAlerts(dir, airbus) {
  const v = (n) => `${dir}/${n}`;
  const rules = [
    { id: 'pullUp', when: (s) => s.w.pullUp, voice: v('v_pullup'), prio: 10, repeat: airbus ? 0.3 : 0.2 },
    { id: 'sink', when: (s) => s.w.sinkRate && !s.w.pullUp, voice: v('v_sinkrate'), prio: 8, repeat: 0.9 },
    { id: 'gear', when: (s) => s.w.gear && !s.w.pullUp, voice: v('v_toolow_gear'), prio: 7, repeat: 1.4 },
    { id: 'flaps', when: (s) => tooLowFlaps(s) && !s.w.gear && !s.w.pullUp, voice: v('v_toolow_flaps'), prio: 6, repeat: 1.4 },
    { id: 'bank', when: (s) => s.w.bank, voice: v('v_bankangle'), prio: 5, repeat: 1.2 },
  ];
  if (airbus) {
    rules.push({ id: 'stall', when: (s) => s.w.stall, voice: v('v_stall'), prio: 11, repeat: 0.15 });
    rules.push({ id: 'overspeed', when: (s) => s.w.overspeed, loop: v('crc'), loopDb: -4 });
  } else {
    rules.push({ id: 'stall', when: (s) => s.w.stall, loop: v('shaker'), loopDb: 0 });
    rules.push({ id: 'overspeed', when: (s) => s.w.overspeed, loop: v('clacker'), loopDb: -2 });
  }
  return {
    style: airbus ? 'airbus' : 'boeing',
    chime: v(airbus ? 'single_chime' : 'chime'),
    // A/P disconnect (real reference recordings, see assets/audio/CREDITS.txt): A320 cavalry charge once on an
    // intentional disconnect (with the pushbutton click), cavalry_loop repeated when involuntary; 737 wailer loop
    apDisconnect: v(airbus ? 'cavalry' : 'wailer'),
    apDisconnectLoop: v(airbus ? 'cavalry_loop' : 'wailer'),
    apButton: airbus ? v('ap_button') : null,
    altAlert: v('c_chord'),
    rules,
    callouts: (airbus ? RA_AIRBUS : RA_BOEING).map(([ft, n]) => ({ ft, voice: v(n) })),
    retard: airbus ? v('v_retard') : null,
  };
}

export function heloAlerts(dir) {
  const v = (n) => `${dir}/${n}`;
  return {
    style: 'helo', chime: 'common/click_soft', apDisconnect: null,
    rules: [
      { id: 'pullUp', when: (s) => s.w.pullUp, voice: v('v_pullup'), prio: 10, repeat: 0.4 },
      { id: 'lowRotor', when: (s) => s.rotorLow, voice: v('v_lowrotor'), loop: v('low_rotor'), loopDb: -6, prio: 9, repeat: 3 },
      { id: 'altitude', when: (s) => s.w.sinkRate && !s.w.pullUp, voice: v('v_altitude'), prio: 8, repeat: 1.0 },
      { id: 'bank', when: (s) => s.w.bank, voice: v('v_bankangle'), prio: 5, repeat: 1.5 },
    ],
  };
}
