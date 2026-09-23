// F-22A Raptor (2 × F119-PW-100) sound profile: deeper, heavier, twin engine.
import { airframeLayers, bettyAlerts, COMMON_SHOTS } from './common.js';
import { fighterEngineLayers, WHINE_REFS } from './f16.js';

export default {
  id: 'f22', category: 'fighter', engines: 2, idleN1: 0.25, idleRef: WHINE_REFS[0],
  emitters: {
    eng1: { nodes: ['nozzle_1', 'engine_1'], offset: [-0.65, 0.3, 7.6], ref: 32, intPan: -0.15, aftDb: 10 },
    eng2: { nodes: ['nozzle_2', 'engine_2'], offset: [0.65, 0.3, 7.6], ref: 32, intPan: 0.15, aftDb: 10 },
    air: { offset: [0, 0, 0], ref: 25 },
  },
  interior: { lp: 1300, q: 0.5, engineDb: -2, canopyOpenDb: 9 },
  exteriorDb: 1,
  layers: [
    ...fighterEngineLayers('f22', { abDb: 6, whineDb: -2, rumbleIntDb: -10, ecsDb: -14 }),
    ...airframeLayers({ cockpitWind: 'wind_canopy', windIntDb: -11, windLp: 2200, windLpSlope: 28, flapMotor: 'flap_fighter',
      flapMotorDb: -22, canopy: true, transonicBuffet: 0.3, gBuffet: 0.4, gearMotorDb: -14, rollDb: -11, gearDragDb: -10 }),
  ],
  shots: { ...COMMON_SHOTS, abLightoff: 'f22/ab_lightoff', abOut: 'f22/ab_out' },
  alerts: bettyAlerts('f22', { stallVoice: 'v_lowspeed' }),
  mech: { flapLever: false, reverser: false, spoilers: false, canopy: true, gearSeconds: 5 },
};
