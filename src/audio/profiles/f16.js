// F-16C Block 50 (F110-GE-129) sound profile.
import { clamp, db, lin, linDb, xfade } from '../util.js';
import { airframeLayers, COMMON_SHOTS } from './common.js';
import { f16Vms } from '../alertlogic.js';

export const WHINE_REFS = [0.30, 0.62, 0.95];   // N1 (sound scale) at which whine_lo/mid/hi were synthesised
const ROAR_REFS = [0.30, 0.95];
const wrate = (n1, ref) => (0.15 + 0.85 * n1) / (0.15 + 0.85 * ref);

export function fighterEngineLayers(dir, o = {}) {
  const ab = o.abDb ?? 5;
  return [
    ...['lo', 'mid', 'hi'].map((n, i) => ({
      id: `whine_${n}`, file: `${dir}/whine_${n}`, emitter: 'eng', perEngine: true, dir: { front: 1, side: 0.65, rear: 0.45 },
      ext: db(o.whineDb ?? 0), int: db(o.whineIntDb ?? -10),
      gain: (s, e) => e.on * xfade(e.n1s, WHINE_REFS, i) * linDb(e.pow, 0, 1, -7, 0),
      rate: (s, e) => wrate(e.n1s, WHINE_REFS[i]),
    })),
    { id: 'roar_lo', file: `${dir}/roar_lo`, emitter: 'eng', perEngine: true, dir: 'rear', ext: 1, int: db(o.roarIntDb ?? -12),
      gain: (s, e) => e.on * xfade(e.n1s, ROAR_REFS, 0) * linDb(e.pow, 0, 0.8, -15, -4),
      rate: (s, e) => 0.94 + 0.12 * e.pow, lp: (s, e) => 2500 + 12000 * e.pow },
    { id: 'roar_hi', file: `${dir}/roar_hi`, emitter: 'eng', perEngine: true, dir: 'rear', ext: 1, int: db(o.roarIntDb ?? -12),
      gain: (s, e) => e.on * xfade(e.n1s, ROAR_REFS, 1) * linDb(e.pow, 0.2, 1, -9, 0) * (1 + 0.25 * e.ab),
      rate: (s, e) => 0.9 + 0.1 * e.pow + 0.03 * e.ab },
    { id: 'ab', file: `${dir}/ab`, emitter: 'eng', perEngine: true, dir: 'rear', ext: 1, int: db(o.abIntDb ?? -9),
      gain: (s, e) => (e.ab > 0.01 ? e.on * linDb(e.ab, 0, 1, ab - 9, ab) : 0), rate: (s, e) => 0.95 + 0.07 * e.ab, tau: 0.12 },
    { id: 'rumble', file: `${dir}/rumble`, emitter: 'eng', perEngine: true, dir: 'rear', ext: db(-13), int: db(o.rumbleIntDb ?? -9),
      intPath: 'direct', gain: (s, e) => e.on * lin(e.pow, 0, 1, 0.15, 1) * (1 + 0.8 * e.ab) },
    { id: 'ecs', file: `${dir}/ecs`, int: db(o.ecsDb ?? -13), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : 0.75 + 0.25 * s.pow) * (1 - 0.7 * s.canopy) },
    { id: 'breath', file: `${dir}/breath`, int: db(o.breathDb ?? -30), intPath: 'direct',
      gain: (s) => (s.dead ? 0 : (1 - s.canopy) * (1 + 1.5 * clamp((s.g - 2) / 6))),
      rate: (s) => 1 + 0.45 * clamp((s.g - 2) / 6) },
  ];
}

export default {
  id: 'f16', category: 'fighter', engines: 1, idleN1: 0.25, idleRef: WHINE_REFS[0],
  emitters: {
    eng1: { nodes: ['nozzle_1', 'engine_1'], offset: [0, 0.3, 6.8], ref: 30, intPan: 0, aftDb: 9 },
    air: { offset: [0, 0, 0], ref: 25 },
  },
  interior: { lp: 1500, q: 0.5, engineDb: 0, canopyOpenDb: 9 },
  exteriorDb: 3,
  layers: [
    ...fighterEngineLayers('f16'),
    ...airframeLayers({ cockpitWind: 'wind_canopy', windIntDb: -10, windLp: 2500, windLpSlope: 30, flapMotor: 'flap_fighter',
      flapMotorDb: -22, canopy: true, transonicBuffet: 0.4, gBuffet: 0.45, gearMotorDb: -14, rollDb: -11, gearDragDb: -10 }),
  ],
  shots: { ...COMMON_SHOTS, abLightoff: 'f16/ab_lightoff', abOut: 'f16/ab_out' },
  // voice message system (WARNING, CAUTION, ALTITUDE, BINGO, PULLUP) + LG warning horn + low-speed warning tone
  alerts: { style: 'betty', chime: null, apDisconnect: null, systems: [() => f16Vms('f16')] },
  mech: { flapLever: false, reverser: false, spoilers: false, canopy: true, gearSeconds: 5 },
};
