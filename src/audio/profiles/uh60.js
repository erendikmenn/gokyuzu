// UH-60M Black Hawk sound profile: main rotor thump + blade slap, tail rotor buzz, twin T700 whine, gearbox, wash.
import { band, clamp, db, lin, linDb, sstep } from '../util.js';
import { airframeLayers, COMMON_SHOTS } from './common.js';
import { uh60Vws } from '../alertlogic.js';

/** Blade-vortex interaction: descents of ~1-3 m/s at 15-45 m/s, loaded turns, and high-speed (advancing tip). */
export function slapAmount(s) {
  const bvi = sstep(0.6, 2.8, -s.vs) * band(s.tas, 6, 16, 40, 58);
  const turn = 0.8 * sstep(1.25, 1.9, s.g);
  const hs = 0.7 * sstep(68, 85, s.tas);
  return clamp(Math.max(bvi, turn, hs) + 0.08);
}

const rr = (s) => Math.max(0.12, s.rotor);

export default {
  id: 'uh60', category: 'helicopter', engines: 2, idleN1: 0.6, idleRef: 0.6,
  emitters: {
    rotor: { nodes: ['rotor_main'], offset: [0, 2.3, 0.2], ref: 40, intPan: 0 },
    tail: { nodes: ['rotor_tail'], offset: [0.45, 2.0, 12.4], ref: 25, intPan: 0 },
    eng: { offset: [0, 1.7, 1.2], ref: 25, intPan: 0 },            // both T700s are in one loop (with their beating)
    air: { offset: [0, 0, 0], ref: 25 },
  },
  interior: { lp: 2600, q: 0.5, engineDb: 0 },
  exteriorDb: 1,
  layers: [
    { id: 'rotor', file: 'uh60/rotor', emitter: 'rotor', dir: 'omni', ext: 1, int: db(-5), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : s.rotor * s.rotor * (0.45 + 0.65 * clamp(s.torque))), rate: rr, lp: (s) => 400 + 9000 * s.rotor },
    { id: 'slap', file: 'uh60/slap', emitter: 'rotor', dir: { front: 1, side: 0.75, rear: 0.4 }, ext: db(1), int: db(-10),
      intPath: 'direct', gain: (s) => (s.dead ? 0 : s.rotor * s.rotor * slapAmount(s)), rate: rr, tau: 0.25 },
    { id: 'tail', file: 'uh60/tail', emitter: 'tail', dir: 'omni', ext: db(-4), int: db(-20),
      gain: (s) => (s.dead ? 0 : s.rotor * s.rotor * (0.8 + 0.3 * clamp(s.torque))), rate: rr },
    { id: 'turbine', file: 'uh60/turbine', emitter: 'eng', dir: { front: 0.7, side: 1, rear: 0.9 },
      ext: db(-6), int: db(-14), gain: (s, e) => e.on * linDb(e.pow, 0, 1, -7, 0),
      rate: (s, e) => clamp(0.55 + 0.45 * e.n1s / 0.9, 0.2, 1.1) },
    { id: 'gearbox', file: 'uh60/gearbox', int: db(-9), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : Math.pow(s.rotor, 1.5) * (0.8 + 0.3 * s.torque)), rate: rr },
    { id: 'wash', file: 'uh60/wash', emitter: 'air', dir: 'omni', ext: db(-3), int: db(-12), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : s.rotor * s.rotor * (1 - sstep(4, 35, s.agl)) * (1 - 0.6 * sstep(8, 35, s.tas))
        * (0.5 + 0.7 * clamp(s.collective))), rate: (s) => lin(s.rotor, 0.3, 1, 0.6, 1) },
    ...airframeLayers({ cockpitWind: 'wind_deck', windIntDb: -6, windLp: 1600, windLpSlope: 25, gear: false,
      transonicBuffet: 0, buffetDb: -6 }),
  ],
  shots: { ...COMMON_SHOTS },
  // voice warning system in the documented Army H-60 (MH-60K VWS) format: ENGINE 1/2 OUT and LOW ROTOR after a 2 s
  // steady 250 Hz tone, ALTITUDE LOW at the radar-altimeter low bug; nothing for rotor overspeed (see alertlogic.js)
  alerts: { style: 'helo', chime: 'common/click_soft', apDisconnect: null, systems: [() => uh60Vws('uh60')] },
  mech: { flapLever: false, reverser: false, spoilers: false, canopy: false, gear: false, helicopter: true },
};
