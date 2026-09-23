// Airbus A320neo (2 × CFM LEAP-1A) sound profile.
import { clamp, db, linDb, sstep, xfade } from '../util.js';
import { airframeLayers, airlinerAlerts, COMMON_SHOTS } from './common.js';

export const FAN_REFS = [0.25, 0.58, 0.92];
const JET_REFS = [0.25, 0.92];

export function airlinerEngineLayers(dir, o = {}) {
  return [
    ...['lo', 'mid', 'hi'].map((n, i) => ({
      id: `fan_${n}`, file: `${dir}/fan_${n}`, emitter: 'eng', perEngine: true, dir: { front: 1, side: 0.7, rear: 0.45 },
      ext: db(o.fanDb ?? 0), int: db(o.fanIntDb ?? -20),
      gain: (s, e) => e.on * xfade(e.n1s, FAN_REFS, i) * linDb(e.pow, 0, 1, -8, 0),
      rate: (s, e) => clamp(e.n1s / FAN_REFS[i], 0.3, 1.7),
    })),
    { id: 'buzzsaw', file: `${dir}/buzzsaw`, emitter: 'eng', perEngine: true, dir: { front: 1, side: 0.4, rear: 0.1 },
      ext: db(o.buzzDb ?? -3), int: db(o.buzzIntDb ?? -25),
      gain: (s, e) => e.on * sstep(0.8, 0.93, e.n1s), rate: (s, e) => e.n1s / 0.95 },
    { id: 'jet_lo', file: `${dir}/jet_lo`, emitter: 'eng', perEngine: true, dir: 'rear', ext: 1, int: db(o.jetIntDb ?? -13),
      gain: (s, e) => e.on * xfade(e.n1s, JET_REFS, 0) * linDb(e.pow, 0, 0.8, -16, -5),
      rate: (s, e) => 0.92 + 0.14 * e.pow, lp: (s, e) => 2200 + 9000 * e.pow },
    { id: 'jet_hi', file: `${dir}/jet_hi`, emitter: 'eng', perEngine: true, dir: 'rear', ext: 1, int: db(o.jetIntDb ?? -13),
      gain: (s, e) => e.on * xfade(e.n1s, JET_REFS, 1) * linDb(e.pow, 0.2, 1, -10, 0),
      rate: (s, e) => 0.9 + 0.12 * e.pow },
    { id: 'reverse', file: `${dir}/reverse`, emitter: 'eng', perEngine: true, dir: { front: 1, side: 0.9, rear: 0.6 },
      ext: db(o.revDb ?? 0), int: db(-15),
      gain: (s, e) => e.on * e.rev * (0.3 + 0.7 * sstep(0.1, 0.7, e.pow)), rate: (s, e) => 0.92 + 0.12 * e.pow },
    { id: 'apu', file: `${dir}/apu`, emitter: 'apu', dir: { front: 0.6, side: 1, rear: 1 }, ext: db(o.apuDb ?? -10), int: db(-34),
      gain: (s) => (s.dead ? 0 : s.onGround * (1 - sstep(8, 20, s.gs)) * (1 - 0.7 * sstep(0.3, 0.6, s.pow))), tau: 1.5 },
  ];
}

export default {
  id: 'a320neo', category: 'airliner', engines: 2, idleN1: 0.2, idleRef: 0.22,
  emitters: {
    eng1: { nodes: ['engine_1'], offset: [-5.75, -1.6, -1.5], ref: 60, intPan: -0.35, aftDb: 10 },
    eng2: { nodes: ['engine_2'], offset: [5.75, -1.6, -1.5], ref: 60, intPan: 0.35, aftDb: 10 },
    apu: { offset: [0, 1.2, 18.5], ref: 40 },
    air: { offset: [0, 0, 0], ref: 50 },
  },
  interior: { lp: 700, q: 0.5, engineDb: 0 },
  exteriorDb: 0,
  layers: [
    ...airlinerEngineLayers('a320neo', { fanDb: -1, buzzDb: -6 }),
    ...airframeLayers({ cockpitWind: 'wind_deck', windIntDb: -4, windLp: 1100, windLpSlope: 22, flapMotor: 'flap_airbus',
      flapMotorDb: -17, flapMotorExtDb: -8, avionicsDb: -15, transonicBuffet: 0.25, airframeNoise: 1, gearMotorDb: -16, rollDb: -13,
      gearDragDb: -9, buffetDb: -4 }),
  ],
  shots: { ...COMMON_SHOTS },
  alerts: airlinerAlerts('a320neo', true),
  mech: { gearClunkInt: 0.45, flapLever: true, reverser: true, spoilers: true, canopy: false, gearSeconds: 9 },
};
