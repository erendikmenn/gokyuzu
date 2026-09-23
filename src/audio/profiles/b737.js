// Boeing 737-800 (2 × CFM56-7B26) sound profile: the classic buzz-saw on takeoff, stick shaker, clacker.
import { airframeLayers, airlinerAlerts, COMMON_SHOTS } from './common.js';
import { airlinerEngineLayers } from './a320neo.js';

export default {
  id: 'b737', category: 'airliner', engines: 2, idleN1: 0.2, idleRef: 0.22,
  emitters: {
    eng1: { nodes: ['engine_1'], offset: [-4.9, -1.5, -2.0], ref: 60, intPan: -0.35, aftDb: 10 },
    eng2: { nodes: ['engine_2'], offset: [4.9, -1.5, -2.0], ref: 60, intPan: 0.35, aftDb: 10 },
    apu: { offset: [0, 1.0, 18.0], ref: 40 },
    air: { offset: [0, 0, 0], ref: 50 },
  },
  interior: { lp: 750, q: 0.5, engineDb: 1 },
  exteriorDb: 0,
  layers: [
    ...airlinerEngineLayers('b737', { fanDb: 0, buzzDb: -2 }),
    ...airframeLayers({ cockpitWind: 'wind_deck', windIntDb: -3, windLp: 1000, windLpSlope: 20, flapMotor: 'flap_boeing',
      flapMotorDb: -16, flapMotorExtDb: -7, avionicsDb: -14, transonicBuffet: 0.3, airframeNoise: 1, gearMotorDb: -15, rollDb: -12,
      gearDragDb: -8, buffetDb: -3 }),
  ],
  shots: { ...COMMON_SHOTS },
  alerts: airlinerAlerts('b737', false),
  mech: { gearClunkInt: 0.45, flapLever: true, reverser: true, spoilers: true, canopy: false, gearSeconds: 8 },
};
