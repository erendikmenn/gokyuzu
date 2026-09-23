// Lockheed Martin F-16C Block 50 (GE F110-GE-129) flight-model data (P1). SI units (speeds IAS unless noted).
// Aerodynamics after the NASA / Stevens & Lewis F-16 wind-tunnel model (CL(alpha) with scheduled LEFs), supersonic
// drag rise from published polars; F110-GE-129: 76.3 kN MIL, ~129 kN max AB; FLCS: +9/-3 g, AoA limiter 25°, roll
// rate command ~308°/s.
const KT = 0.514444;

export default {
  id: 'f16',
  category: 'fighter',
  name: 'F-16C Fighting Falcon',
  engines: 1,
  abDetent: 0.9,                 // throttle above this = afterburner (MIL at the detent)

  length: 15.06, span: 9.96, height: 4.88, wingArea: 27.87, chord: 3.45, fuselageRadius: 1.0,

  mass: { empty: 8570, typical: 12000, mtow: 19187, fuelCapacity: 3200, fuelTypical: 3200 },
  inertia: { mass: 9299, roll: 12875, pitch: 75674, yaw: 85552 },   // Stevens & Lewis (scaled with mass)

  aero: {
    CLalpha: 3.6, alpha0: -1.4,
    CLalphaMach: { x: [0, 0.6, 0.9, 1.0, 1.2, 1.5, 2.0], y: [1, 1.05, 1.15, 1.12, 0.95, 0.8, 0.62] },
    CLmax: 1.74, CLmaxMach: { x: [0.3, 0.6, 0.9, 1.2, 2.0], y: [1, 0.96, 0.88, 0.78, 0.62] },
    stallRound: 10, stallRoundNeg: 5, postStallDrop: 0.9, CLmin: -1.0, CD90: 1.9,
    CD0Mach: { x: [0, 0.6, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.5, 2.0, 2.4], y: [0.0185, 0.0185, 0.019, 0.022, 0.030, 0.043, 0.049, 0.050, 0.049, 0.045, 0.038, 0.037] },
    oswald: 0.75, KMach: { x: [0, 0.8, 1.0, 1.2, 1.5, 2.0], y: [1, 1.05, 1.25, 1.6, 2.1, 2.8] },
    suction: [12, 35],
    // speedbrakes: 4 split clamshell petals at the strake ends (0.905 × 0.38 m each, 1.38 m² in all — geometry of
    // blender/aircraft/f16/f16_parts.py), hinged at the front, opening ±60° (NASA TP-1538 Table I: speed brake 60°;
    // 43° with the gear handle down, see JSBSim f16.xml after the flight manual — not modelled by fixedwing.js yet).
    // Inclined plates: CN ≈ 1.15 at 60° (Hoerner, Fluid-Dynamic Drag §13) → drag area ≈ 1.38 × 1.15 × sin 60° ≈ 1.4 m²,
    // + ~10 % fuselage interference → ΔCD ≈ 0.055 on 27.87 m². Model, 12 t idle, level at 3 km: 250 KIAS 1.7 → 3.8 kt/s,
    // 350 KIAS 2.3 → 6.6 kt/s, 450 KIAS 3.5 → 10.0 kt/s (was 0.07: 4.4 / 7.7 / 11.3 kt/s).
    gearCD: 0.03, speedbrakeCD: 0.055, groundEffectLift: 0.08,
    Cm0: 0, CmalphaMach: { x: [0, 0.8, 0.95, 1.1, 1.4, 2.0], y: [-0.08, -0.1, -0.22, -0.55, -0.65, -0.55] }, Cmalpha: -0.08,
    Cmq: -5.5, CmdeMach: { x: [0, 0.9, 1.2, 2.0], y: [0.55, 0.6, 0.45, 0.32] }, Cmde: 0.55,
    CmStall: -0.3, CmHighAlpha: { alpha: 40, k: -0.6 },
    Clb: -0.06, Clp: -0.35, Clr: 0.10, Clda: 0.08, CldaMach: { x: [0, 1.0, 1.5, 2.0], y: [1, 0.85, 0.6, 0.45] }, Cldr: 0.012, ClpStallLoss: 0.5,
    Cnb: 0.20, CnbAlpha: 25, CnbHighAlphaLoss: 0.7, Cnr: -0.35, Cnp: -0.03, Cndr: 0.075, Cnda: -0.004,
    CYb: -1.0, CYdr: 0.15,
  },

  // automatic LEF / TEF schedule; the flap keys select the alternate flaps (TEF 20° as with the gear down)
  flapDetents: [
    { label: 'OTO', value: 0, slats: 0, dCL: 0, dCLmax: 0, dCD: 0, dCm: 0, vfe: 0 },
    { label: 'İNİŞ', value: 1, slats: 0, dCL: 0.15, dCLmax: 0.10, dCD: 0.02, dCm: -0.03, vfe: 300 * KT, time: 1.5 },
  ],
  takeoffFlapIndex: 0, landingFlapIndex: 1,
  speedbrakeTime: 2,

  engine: {
    thrust: 76300, thrustAB: 129000,
    // MIL: the fixed normal-shock inlet loses pressure recovery supersonic (≈12 % less dry thrust at altitude)
    dry: {
      alt: [0, 3000, 6000, 9000, 11000, 13000, 15000, 18000],
      mach: [0, 0.4, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2],
      v: [
        [1.00, 0.96, 1.00, 1.03, 1.00, 0.90, 0.78, 0.68, 0.58],
        [0.79, 0.77, 0.83, 0.88, 0.89, 0.85, 0.77, 0.69, 0.60],
        [0.60, 0.60, 0.66, 0.62, 0.65, 0.66, 0.62, 0.58, 0.52],
        [0.44, 0.45, 0.50, 0.48, 0.51, 0.54, 0.53, 0.50, 0.46],
        [0.34, 0.35, 0.40, 0.39, 0.41, 0.44, 0.44, 0.42, 0.39],
        [0.25, 0.26, 0.30, 0.29, 0.32, 0.33, 0.34, 0.33, 0.30],
        [0.18, 0.19, 0.22, 0.21, 0.23, 0.25, 0.26, 0.25, 0.23],
        [0.11, 0.12, 0.14, 0.13, 0.15, 0.16, 0.17, 0.16, 0.15],
      ],
    },
    wet: {
      alt: [0, 3000, 6000, 9000, 11000, 13000, 15000, 18000],
      mach: [0, 0.4, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2],
      v: [
        [1.00, 1.04, 1.16, 1.20, 1.08, 0.95, 0.80, 0.70, 0.60],
        [0.80, 0.84, 0.97, 1.04, 1.06, 1.00, 0.88, 0.78, 0.68],
        [0.62, 0.66, 0.78, 0.85, 0.90, 0.92, 0.86, 0.79, 0.70],
        [0.46, 0.50, 0.60, 0.66, 0.72, 0.77, 0.76, 0.72, 0.65],
        [0.36, 0.39, 0.47, 0.53, 0.58, 0.63, 0.64, 0.61, 0.55],
        [0.27, 0.29, 0.35, 0.40, 0.44, 0.48, 0.50, 0.48, 0.43],
        [0.20, 0.21, 0.26, 0.29, 0.32, 0.36, 0.37, 0.36, 0.33],
        [0.12, 0.13, 0.16, 0.18, 0.20, 0.22, 0.23, 0.22, 0.20],
      ],
    },
    idle: 0.08, idleMach: 0.4, idleFloor: 0.18, thrustExp: 1.6,
    n1Idle: 0.70, n1Max: 1.0, accel: [0.15, 0.5], decel: [0.2, 0.5],   // idle → MIL ≈ 3.5 s
    abDelay: 0.5, abRate: 0.5,
    tsfc: 2.1e-5, tsfcMach: 0.35, tsfcAB: 5.2e-5, ffIdle: 0.12,
    thrustLineY: 0,
  },

  // wheelbase 4.00 m, track 2.36 m
  gear: {
    staticCompression: 0.12, bumpStop: 0.2, stroke: 0.25, damping: 0.75, extendTime: 5, retractTime: 5,
    steerMax: 32, steerPedal: 8, rollingFriction: 0.02, rollingFrictionGrass: 0.06, brakeFriction: 0.45,
    lateralFriction: 0.7, breakaway: 0.02, maxSink: 5.0,
  },
  contacts: [
    { name: 'contact_nose', kind: 'nose', position: { x: 0, y: -1.7, z: -3.4 } },
    { name: 'contact_main_L', kind: 'main', position: { x: -1.18, y: -1.7, z: 0.6 } },
    { name: 'contact_main_R', kind: 'main', position: { x: 1.18, y: -1.7, z: 0.6 } },
  ],
  structure: {
    tail: { z: 6.5, strikeDeg: 15 },
    nose: { z: -7.5, height: 1.4 },
    belly: { z: 0, height: 0.75 },
    wingtip: { x: 4.98, z: 1.5, height: 1.6 },
    top: { height: 4.88, z: 5 },
    maxTouchdownBank: 25,
  },

  // F-16 FLCS
  fcs: {
    law: 'fighter',
    nMax: 9, nMin: -3, nMaxFlaps: 5, nMinFlaps: -1,
    alphaLimit: 25, alphaMin: -8,
    Ka: 2.0, KaBoost: 2.2, Kq: 7, Kg: 0.8, qMax: 0.6, pitchExpo: 0.6,
    rollRateMax: 308, rollRateGear: 100, rollExpo: 0.65, Kp: 8,
    betaMax: 6, Kb: 2.0, Kr: 4,
    rates: { elevator: 2.4, aileron: 2.6, rudder: 4 },
    trimRange: null, takeoffTrim: 0,
    rotRate: 8, blendTime: 1.0,
  },
  limits: { vmo: 800 * KT, mmo: 2.05, vle: 300 * KT, vfeAuto: 300 * KT, nMax: 9 },
  autopilot: { vsMax: 60, bankMax: 45, rollRate: 30, athrMax: 1.0, Kgamma: 1.2, flareHeight: 9, flareSink: 1.0, flareTau: 5, retardHeight: 4 },

  vSpeedMass: 12000,
  vRotate: 140 * KT, v2: 160 * KT, vRef: 145 * KT, vlsFactor: 1.24,   // approach ≈ 13° AoA
  cruiseSpeed: 250, cruiseMach: 0.85, cruiseAltitude: 9000,
  maxMach: 2.05, maxMachSeaLevel: 1.2,
  serviceCeiling: 15240,
  spawnSpeed: 180,
  published: {
    takeoffRollAB: [450, 600],   // m, with afterburner, combat weight
    maxMach: 2.05, maxMachSL: 1.2, climbRateFpm: 50000,
  },
};
