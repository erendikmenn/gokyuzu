// Lockheed Martin F-22A Raptor (2 x P&W F119-PW-100) flight-model data (P1). SI units (speeds IAS unless noted).
// F119: ~116 kN MIL, ~156 kN AB each; supercruise ~M1.5-1.8, max ~M2.25; +9/-3 g; controllable to ~60° AoA with
// ±20° pitch thrust vectoring.
const KT = 0.514444;

export default {
  id: 'f22',
  category: 'fighter',
  name: 'F-22A Raptor',
  engines: 2,
  abDetent: 0.9,

  length: 18.92, span: 13.56, height: 5.08, wingArea: 78.04, chord: 6.4, fuselageRadius: 1.3,

  mass: { empty: 19700, typical: 29300, mtow: 38000, fuelCapacity: 8200, fuelTypical: 8200 },
  inertia: { mass: 29300, roll: 60000, pitch: 245000, yaw: 290000 },

  aero: {
    CLalpha: 4.0, alpha0: -1.5,
    CLalphaMach: { x: [0, 0.8, 1.0, 1.2, 1.5, 2.0], y: [1, 1.08, 1.05, 0.92, 0.78, 0.62] },
    CLmax: 1.9, CLmaxMach: { x: [0.3, 0.6, 0.9, 1.2, 2.0], y: [1, 0.96, 0.88, 0.78, 0.62] },
    stallRound: 12, stallRoundNeg: 5, postStallDrop: 0.8, CLmin: -1.0, CD90: 2.0,
    CD0Mach: { x: [0, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5, 1.8, 2.2], y: [0.0145, 0.0148, 0.017, 0.030, 0.034, 0.034, 0.032, 0.030, 0.029] },
    oswald: 0.8, KMach: { x: [0, 0.8, 1.0, 1.2, 1.5, 2.0], y: [1, 1.05, 1.2, 1.45, 1.85, 2.4] },
    suction: [14, 40],
    gearCD: 0.02, speedbrakeCD: 0.05, groundEffectLift: 0.08,
    Cm0: 0, CmalphaMach: { x: [0, 0.9, 1.1, 1.5, 2.0], y: [-0.05, -0.07, -0.35, -0.45, -0.4] }, Cmalpha: -0.05,
    Cmq: -4.5, CmdeMach: { x: [0, 1.0, 1.3, 2.0], y: [0.38, 0.4, 0.28, 0.22] }, Cmde: 0.38,
    CmStall: -0.15, CmHighAlpha: { alpha: 55, k: -0.8 },
    Clb: -0.05, Clp: -0.30, Clr: 0.08, Clda: 0.07, CldaMach: { x: [0, 1.0, 1.5, 2.0], y: [1, 0.85, 0.6, 0.45] }, Cldr: 0.01, ClpStallLoss: 0.4,
    Cnb: 0.14, CnbAlpha: 30, CnbHighAlphaLoss: 0.6, Cnr: -0.30, Cnp: -0.02, Cndr: 0.06, Cnda: -0.003,
    CYb: -0.9, CYdr: 0.12,
  },

  flapDetents: [
    { label: 'OTO', value: 0, slats: 0, dCL: 0, dCLmax: 0, dCD: 0, dCm: 0, vfe: 0 },
    { label: 'İNİŞ', value: 1, slats: 0, dCL: 0.12, dCLmax: 0.08, dCD: 0.015, dCm: -0.02, vfe: 250 * KT, time: 1.5 },
  ],
  takeoffFlapIndex: 0, landingFlapIndex: 1,
  speedbrakeTime: 1.5,

  engine: {
    thrust: 116000, thrustAB: 156000,
    dry: {
      alt: [0, 3000, 6000, 9000, 11000, 13000, 15000, 18000],
      mach: [0, 0.4, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.3],
      v: [
        [1.00, 0.97, 1.02, 1.06, 1.05, 0.98, 0.88, 0.78, 0.66],
        [0.80, 0.79, 0.86, 0.91, 0.94, 0.93, 0.87, 0.80, 0.69],
        [0.61, 0.62, 0.69, 0.74, 0.78, 0.81, 0.79, 0.75, 0.66],
        [0.45, 0.46, 0.52, 0.57, 0.61, 0.66, 0.67, 0.65, 0.59],
        [0.35, 0.36, 0.42, 0.46, 0.50, 0.55, 0.57, 0.56, 0.51],
        [0.26, 0.27, 0.31, 0.34, 0.37, 0.41, 0.43, 0.42, 0.38],
        [0.19, 0.20, 0.23, 0.25, 0.28, 0.31, 0.32, 0.32, 0.29],
        [0.12, 0.12, 0.14, 0.16, 0.17, 0.19, 0.20, 0.20, 0.18],
      ],
    },
    wet: {
      alt: [0, 3000, 6000, 9000, 11000, 13000, 15000, 18000],
      mach: [0, 0.4, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.3],
      v: [
        [1.00, 1.04, 1.17, 1.20, 1.10, 0.92, 0.78, 0.68, 0.56],
        [0.80, 0.84, 0.98, 1.05, 1.10, 1.10, 1.02, 0.93, 0.78],
        [0.62, 0.66, 0.79, 0.86, 0.92, 0.97, 0.94, 0.88, 0.76],
        [0.46, 0.50, 0.61, 0.67, 0.73, 0.80, 0.81, 0.78, 0.69],
        [0.36, 0.39, 0.48, 0.54, 0.59, 0.66, 0.68, 0.67, 0.60],
        [0.27, 0.29, 0.36, 0.40, 0.44, 0.49, 0.52, 0.51, 0.46],
        [0.20, 0.21, 0.26, 0.30, 0.33, 0.37, 0.39, 0.38, 0.35],
        [0.12, 0.13, 0.16, 0.18, 0.20, 0.23, 0.24, 0.24, 0.22],
      ],
    },
    idle: 0.07, idleMach: 0.4, idleFloor: 0.15, thrustExp: 1.6,
    n1Idle: 0.68, n1Max: 1.0, accel: [0.15, 0.5], decel: [0.2, 0.5],
    abDelay: 0.5, abRate: 0.5,
    tsfc: 2.0e-5, tsfcMach: 0.35, tsfcAB: 5.0e-5, ffIdle: 0.12,
    thrustLineY: 0,
  },

  gear: {
    staticCompression: 0.14, bumpStop: 0.22, stroke: 0.28, damping: 0.75, extendTime: 5, retractTime: 5,
    steerMax: 40, steerPedal: 8, rollingFriction: 0.02, rollingFrictionGrass: 0.06, brakeFriction: 0.45,
    lateralFriction: 0.7, breakaway: 0.02, maxSink: 5.0,
  },
  contacts: [
    { name: 'contact_nose', kind: 'nose', position: { x: 0, y: -1.9, z: -5.2 } },
    { name: 'contact_main_L', kind: 'main', position: { x: -1.6, y: -1.9, z: 0.8 } },
    { name: 'contact_main_R', kind: 'main', position: { x: 1.6, y: -1.9, z: 0.8 } },
  ],
  structure: {
    tail: { z: 7.5, strikeDeg: 15 },
    nose: { z: -9.5, height: 1.5 },
    belly: { z: 0, height: 0.8 },
    wingtip: { x: 6.78, z: 2.5, height: 1.5 },
    top: { height: 5.08, z: 6 },
    maxTouchdownBank: 25,
  },

  fcs: {
    law: 'fighter',
    nMax: 9, nMin: -3, nMaxFlaps: 5, nMinFlaps: -1,
    alphaLimit: 60, alphaMin: -10, alphaHoldMargin: 8,
    Ka: 2.0, KaBoost: 2.2, Kq: 7, Kg: 0.8, qMax: 0.7, pitchExpo: 0.6,
    rollRateMax: 240, rollRateGear: 100, rollExpo: 0.65, Kp: 7,
    betaMax: 6, Kb: 2.0, Kr: 3.5,
    rates: { elevator: 2.5, aileron: 2.8, rudder: 3.5, tvc: 3 },
    tvc: { max: 20, arm: 7.2 },
    trimRange: null, takeoffTrim: 0,
    rotRate: 8, blendTime: 1.0,
  },
  limits: { vmo: 800 * KT, mmo: 2.25, vle: 250 * KT, vfeAuto: 250 * KT, nMax: 9 },
  autopilot: { vsMax: 60, bankMax: 45, rollRate: 30, athrMax: 1.0, Kgamma: 1.2, flareHeight: 9, flareSink: 1.0, flareTau: 5, retardHeight: 4 },

  vSpeedMass: 29300,
  vRotate: 125 * KT, v2: 145 * KT, vRef: 140 * KT,
  cruiseSpeed: 255, cruiseMach: 0.86, cruiseAltitude: 11000,
  supercruiseMach: 1.5, maxMach: 2.25,
  serviceCeiling: 19800,
  spawnSpeed: 180,
  published: { supercruiseMach: [1.5, 1.82], maxMach: 2.25 },
};
