// Boeing 737-800 (CFM56-7B26) flight-model data (P1). SI units: m, kg, N, s, m/s (speeds are IAS unless noted).
// Sources: Boeing 737 Airplane Characteristics for Airport Planning (D6-58325-6), FAA TCDS A16WE, CFM56-7B data,
// typical FCTM / QRH figures (Vref table, flap limit speeds, autobrake decelerations).
const KT = 0.514444;

const THRUST = {
  alt: [0, 1500, 3000, 6000, 9000, 11000, 12500],
  mach: [0, 0.2, 0.4, 0.6, 0.8, 0.9],
  v: [
    [1.00, 0.88, 0.79, 0.72, 0.66, 0.63],
    [0.90, 0.80, 0.72, 0.66, 0.61, 0.59],
    [0.78, 0.70, 0.63, 0.58, 0.54, 0.52],
    [0.60, 0.54, 0.50, 0.46, 0.43, 0.42],
    [0.41, 0.36, 0.33, 0.305, 0.285, 0.275],
    [0.315, 0.28, 0.255, 0.233, 0.22, 0.212],
    [0.255, 0.225, 0.205, 0.19, 0.177, 0.172],
  ],
};

export default {
  id: 'b737',
  category: 'airliner',
  name: 'Boeing 737-800',
  engines: 2,
  abDetent: null,

  length: 39.47, span: 35.79, height: 12.55, wingArea: 124.58, chord: 3.96, fuselageRadius: 1.9,

  mass: { empty: 41413, typical: 65000, mtow: 79016, mlw: 66361, mzfw: 62732, fuelCapacity: 20894, fuelTypical: 9000 },
  inertia: { mass: 65000, roll: 1.4e6, pitch: 3.6e6, yaw: 4.8e6 },

  aero: {
    CLalpha: 5.6, alpha0: -1.8,
    CLalphaMach: { x: [0, 0.4, 0.6, 0.7, 0.78, 0.85, 0.9], y: [1, 1.04, 1.1, 1.15, 1.2, 1.18, 1.1] },
    CLmax: 1.35, CLmaxMach: { x: [0.25, 0.4, 0.55, 0.7, 0.8, 0.9], y: [1, 0.93, 0.82, 0.68, 0.6, 0.5] },
    stallRound: 1.8, postStallDrop: 3.0, CLmin: -0.75, CD90: 1.7,
    CD0: 0.019, oswald: 0.82, KMach: { x: [0.6, 0.78, 0.9], y: [1, 1.05, 1.15] }, mdd: 0.80,
    gearCD: 0.02, spoilerCD: 0.10, spoilerCL: 0.9, groundEffectLift: 0.1,
    speedbrakeCD: 0,              // no separate board: the in-flight speedbrake drag is the flight spoilers' (speedbrakeMax)
    Cm0: 0.05, Cmalpha: -1.2, Cmq: -24, Cmde: 0.5, CmStall: -0.5,
    Clb: -0.12, Clp: -0.45, Clr: 0.12, Clda: 0.07, rollQref: 9000, Cldr: 0.008,
    Cnb: 0.13, Cnr: -0.20, Cnp: -0.04, Cndr: 0.07, Cnda: -0.005,
    CYb: -0.9, CYdr: 0.18,
  },

  // Boeing detents: flaps UP 1 2 5 10 15 25 30 40 (value = flap angle / 40°), LE slats EXT (1-5) / FULL EXT (10-40)
  flapDetents: [
    { label: 'UP', value: 0, slats: 0, dCL: 0, dCLmax: 0, dCD: 0, dCm: 0, vfe: 0, time: 0 },
    { label: '1', value: 0.025, slats: 0.5, dCL: 0.03, dCLmax: 0.20, dCD: 0.004, dCm: -0.005, vfe: 250 * KT, time: 4 },
    { label: '2', value: 0.05, slats: 0.5, dCL: 0.07, dCLmax: 0.27, dCD: 0.006, dCm: -0.01, vfe: 250 * KT, time: 2 },
    { label: '5', value: 0.125, slats: 0.5, dCL: 0.15, dCLmax: 0.37, dCD: 0.012, dCm: -0.025, vfe: 250 * KT, time: 4 },
    { label: '10', value: 0.25, slats: 1, dCL: 0.28, dCLmax: 0.45, dCD: 0.020, dCm: -0.05, vfe: 210 * KT, time: 5 },
    { label: '15', value: 0.375, slats: 1, dCL: 0.40, dCLmax: 0.52, dCD: 0.028, dCm: -0.075, vfe: 200 * KT, time: 4 },
    { label: '25', value: 0.625, slats: 1, dCL: 0.55, dCLmax: 0.62, dCD: 0.045, dCm: -0.12, vfe: 190 * KT, time: 6 },
    { label: '30', value: 0.75, slats: 1, dCL: 0.66, dCLmax: 0.72, dCD: 0.058, dCm: -0.15, vfe: 175 * KT, time: 4 },
    { label: '40', value: 1.0, slats: 1, dCL: 0.82, dCLmax: 0.90, dCD: 0.085, dCm: -0.2, vfe: 162 * KT, time: 7 },
  ],
  takeoffFlapIndex: 3,          // flaps 5
  landingFlapIndex: 7,          // flaps 30
  // In-flight speedbrake (flight spoilers, lever at the FLIGHT detent): drag / lift-loss effect as a fraction of the
  // full ground-spoiler effect (aero.spoilerCD, spoilerCL), not the drawn deflection (the rig takes the flight spoilers
  // from VisualState.speedbrake): 0.16 → ΔCD ≈ 0.016.
  // Real data: Boeing 737 FCTM (FCT 737 (TM) rev. 15, 30 JUN 2016) p. 4.20-4.21, 737-600…-900ER, typical idle descent
  // below FL200, clean → with speedbrake (with or without load alleviation): M.78/280 kt 2,200 → 3,100 fpm,
  // 250 kt 1,700 → 2,300 fpm, VREF40+70 kt 1,100 → 1,400 fpm. Level 280 → 250 kt ≈ 25 s / 2 NM clean, "using
  // speedbrakes ... reduces these times and distances by approximately 50 %". In flight never beyond the FLIGHT
  // detent; retract them with flaps 15 or greater and before 1,000 ft AGL.
  // Model, 65 t idle: descent 250 KIAS 1,280 → 1,880 fpm (+600), 280 KIAS 1,650 → 2,515 fpm (+865), 215 KIAS +380;
  // level 280 KIAS 0.99 → 1.63 kt/s (×1.6). Before: spoilers 0.35 × 0.10 + default speedbrakeCD 0.05 (ΔCD 0.087):
  // +3,850 fpm at 250 kt, ×4.3 deceleration.
  speedbrakeMax: 0.16,

  // 2 x CFM56-7B26, 117.0 kN (26,300 lbf)
  engine: {
    thrust: 117000, dry: THRUST,
    idle: 0.05, idleMach: 0.6, idleFloor: 0.02, thrustExp: 1.5,
    n1Idle: 0.21, n1Max: 1.0, accel: [0.075, 0.30], decel: [0.12, 0.35],
    tsfc: 9.4e-6, tsfcMach: 1.25, ffIdle: 0.045,
    reverseEff: 0.40, reverseMax: 0.82, reverseTime: 2.0,
    thrustLineY: -1.4,
  },

  // wheelbase 15.60 m, track 5.72 m
  gear: {
    staticCompression: 0.25, bumpStop: 0.35, stroke: 0.40, damping: 0.7, extendTime: 9, retractTime: 7,
    steerMax: 78, steerPedal: 7, rollingFriction: 0.015, rollingFrictionGrass: 0.05, brakeFriction: 0.4,
    lateralFriction: 0.7, breakaway: 0.015, maxSink: 4.0,
  },
  contacts: [
    { name: 'contact_nose', kind: 'nose', position: { x: 0, y: -2.6, z: -14.3 } },
    { name: 'contact_main_L', kind: 'main', position: { x: -2.86, y: -2.6, z: 1.3 } },
    { name: 'contact_main_R', kind: 'main', position: { x: 2.86, y: -2.6, z: 1.3 } },
  ],
  structure: {
    tail: { z: 17.0, strikeDeg: 11.0 },
    nose: { z: -19.0, height: 1.6 },
    belly: { z: 0, height: 0.95 },
    nacelle: { x: 4.9, z: -5.0, clearance: 0.46 },
    wingtip: { x: 17.9, z: 5.5, height: 3.2 },
    top: { height: 12.55, z: 17 },
    maxTouchdownBank: 25,
  },

  // conventional controls: yoke → elevator (feel scaled), stabilizer trim, yaw damper, keyboard assist
  fcs: {
    law: 'conventional',
    nMax: 2.5, nMin: -1.0, nMaxFlaps: 2.0, nMinFlaps: 0,
    pullG: 1.5, pushG: 1.2, pitchExpo: 0.4, assistPitch: 0.35, assistTrimRate: 0.06, assistRoll: 0.3, levelTau: 12, shakerCL: 0.9,
    Ka: 1.4, Kq: 3.0, Kg: 0.5, qMax: 0.16, Kp: 2.0, bankComp: 30,
    betaMax: 8, Kb: 1.2, Kr: 2.0,
    rates: { elevator: 1.5, aileron: 2.0, rudder: 1.3, trim: 0.12 },
    trimRange: [-1, 1], takeoffTrim: 0.2, rotRate: 4.5,
    rudderLimiter: [160 * KT, 340 * KT, 0.2],
  },
  limits: { vmo: 340 * KT, mmo: 0.82, vle: 320 * KT, vlo: 270 * KT, nMax: 2.5 },
  autopilot: { vsMax: 12, bankMax: 25, rollRate: 5, appFlap: 6, flareHeight: 15, flareSink: 0.45, flareTau: 3.2, retardHeight: 8 },
  autobrake: { landing: '3', decel: { '1': 1.22, '2': 1.52, '3': 2.13, MAX: 3.66 } },

  vSpeedMass: 65000,
  vRotate: 145 * KT, v2: 151 * KT, vRef: 152 * KT,    // flaps 5 takeoff, Vref30
  cruiseSpeed: 232, cruiseMach: 0.785, cruiseAltitude: 10670,
  serviceCeiling: 12500,                                         // 41,000 ft
  spawnSpeed: 118,
  published: {
    // VS1g from the Vref / V2 tables at 65 t (Vref = 1.23 VS1g, V2 = 1.13 VS1g)
    stallSpeedsKt: { mass: 65000, UP: 153, '5': 136, '15': 131, '30': 124, '40': 119 },
    takeoffDistanceMTOW: [2300, 2600],
    vmoKt: 340, mmo: 0.82,
  },
};
