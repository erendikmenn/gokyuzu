// Airbus A320neo (CFM LEAP-1A26) flight-model data (P1). SI units: m, kg, N, s, m/s (speeds are IAS unless noted).
// Sources: Airbus A320 Aircraft Characteristics (ACAP), EASA TCDS A.064, CFM LEAP-1A data, typical FCOM figures.
const KT = 0.514444;

const AIRLINER_THRUST = {
  // max (TOGA / MCT / climb) thrust lapse, fraction of SL static rated thrust; rows = altitude (m), cols = Mach
  alt: [0, 1500, 3000, 6000, 9000, 11000, 12500],
  mach: [0, 0.2, 0.4, 0.6, 0.8, 0.9],
  v: [
    [1.00, 0.87, 0.77, 0.70, 0.64, 0.61],
    [0.90, 0.79, 0.70, 0.64, 0.59, 0.57],
    [0.78, 0.69, 0.62, 0.57, 0.53, 0.51],
    [0.60, 0.535, 0.485, 0.45, 0.42, 0.41],
    [0.40, 0.355, 0.325, 0.30, 0.28, 0.27],
    [0.31, 0.275, 0.25, 0.228, 0.215, 0.207],
    [0.25, 0.22, 0.20, 0.185, 0.172, 0.168],
  ],
};

export default {
  id: 'a320neo',
  category: 'airliner',
  name: 'Airbus A320neo',
  engines: 2,
  abDetent: null,

  // ---- geometry ----
  length: 37.57, span: 35.80, height: 11.76, wingArea: 122.6, chord: 4.29, fuselageRadius: 2.0,

  // ---- masses (kg) ----
  mass: { empty: 44300, typical: 65000, mtow: 79000, mlw: 67400, mzfw: 64300, fuelCapacity: 19000, fuelTypical: 9000 },
  inertia: { mass: 65000, roll: 1.35e6, pitch: 3.2e6, yaw: 4.4e6 },   // kg m^2

  // ---- aerodynamics (per rad; controls per unit deflection) ----
  aero: {
    CLalpha: 5.8, alpha0: -2.1,                       // body-referenced
    CLalphaMach: { x: [0, 0.4, 0.6, 0.7, 0.78, 0.85, 0.9], y: [1, 1.04, 1.1, 1.15, 1.2, 1.18, 1.1] },
    CLmax: 1.52, CLmaxMach: { x: [0.25, 0.4, 0.55, 0.7, 0.8, 0.9], y: [1, 0.93, 0.8, 0.64, 0.55, 0.46] },
    stallRound: 2.0, postStallDrop: 2.5, CLmin: -0.75, CD90: 1.7,
    CD0: 0.019, oswald: 0.82, KMach: { x: [0.6, 0.78, 0.9], y: [1, 1.05, 1.15] }, mdd: 0.80,
    gearCD: 0.018, spoilerCD: 0.10, spoilerCL: 0.9, groundEffectLift: 0.1,
    speedbrakeCD: 0,              // no separate board: the in-flight speedbrake drag is the spoilers' (see speedbrakeMax)
    Cm0: 0.05, Cmalpha: -1.1, Cmq: -22, Cmde: 0.5, CmStall: -0.6,
    Clb: -0.12, Clp: -0.45, Clr: 0.12, Clda: 0.075, rollQref: 9000, Cldr: 0.008,
    Cnb: 0.13, Cnr: -0.20, Cnp: -0.04, Cndr: 0.07, Cnda: -0.005,
    CYb: -0.9, CYdr: 0.18,
  },

  // ---- high lift: real A320 detents (slats° / flaps°: 0/0, 18/0, 18/10, 22/15, 22/20, 27/35) ----
  flapDetents: [
    { label: '0', value: 0, slats: 0, dCL: 0, dCLmax: 0, dCD: 0, dCm: 0, vfe: 0, time: 0 },
    { label: '1', value: 0, slats: 0.67, dCL: 0.02, dCLmax: 0.33, dCD: 0.004, dCm: 0, vfe: 230 * KT, time: 7 },
    { label: '1+F', value: 0.29, slats: 0.67, dCL: 0.30, dCLmax: 0.53, dCD: 0.012, dCm: -0.05, vfe: 215 * KT, time: 6 },
    { label: '2', value: 0.43, slats: 0.81, dCL: 0.45, dCLmax: 0.73, dCD: 0.022, dCm: -0.08, vfe: 200 * KT, time: 5 },
    { label: '3', value: 0.57, slats: 0.81, dCL: 0.60, dCLmax: 0.88, dCD: 0.034, dCm: -0.11, vfe: 185 * KT, time: 5 },
    { label: 'FULL', value: 1, slats: 1, dCL: 0.82, dCLmax: 1.10, dCD: 0.072, dCm: -0.18, vfe: 177 * KT, time: 8 },
  ],
  takeoffFlapIndex: 2,          // 1+F
  landingFlapIndex: 5,          // FULL
  // In-flight speedbrake (spoilers 2-4): drag / lift-loss effect as a fraction of the full ground-spoiler effect
  // (aero.spoilerCD, spoilerCL), not the drawn deflection (the rig takes spoilers 2-4 from VisualState.speedbrake):
  // 0.30 → ΔCD ≈ 0.030, ΔCL ≈ -0.08 (VLS rises with the speedbrakes, as on the real aircraft).
  // Real data: Airbus A318-A321 FCTM (23 NOV 21) PR-NP-SOP-190: level deceleration while configuring ≈ 10 kt/NM, "twice
  // i.e. 20 kt/NM, with the use of the speedbrakes"; limited effect at low speed; VLS increases with speedbrakes (also
  // Airbus Safety First #24, Jul 2017); PR-NP-SOP-170: "Speedbrake is very effective in increasing descent rate".
  // Inhibited / auto-retracted (FCOM DSC-27): CONF FULL (A319/A320), alpha prot, alpha floor, thrust levers above MCT,
  // SEC 1+3 or an elevator failed (not modelled by fixedwing.js yet).
  // Model, 65 t idle: level 250 KIAS 0.86 → 1.82 kt/s (×2.1; 210 KIAS ×1.9), idle descent 250 KIAS 1,150 → 2,550 fpm,
  // 1 g AoA +1°.
  // Before this calibration the spoilers (0.35 × 0.10) and the default speedbrakeCD 0.05 were added together
  // (ΔCD 0.087): ×4 deceleration, ×4.7 descent rate.
  speedbrakeMax: 0.30,

  // ---- engines: 2 x CFM LEAP-1A26, 120.6 kN (27,120 lbf) ----
  engine: {
    thrust: 120600, dry: AIRLINER_THRUST,
    idle: 0.05, idleMach: 0.6, idleFloor: 0.02, thrustExp: 1.5,
    n1Idle: 0.21, n1Max: 1.0, accel: [0.07, 0.30], decel: [0.12, 0.35],   // idle → 95 % thrust ≈ 5.6 s
    tsfc: 8.5e-6, tsfcMach: 1.22, ffIdle: 0.04,                          // 0.30 lb/lbf/h static, ~0.51 cruise
    reverseEff: 0.38, reverseMax: 0.8, reverseTime: 1.8,
    thrustLineY: -1.6,
  },

  // ---- landing gear (wheelbase 12.64 m, track 7.59 m) ----
  gear: {
    staticCompression: 0.25, bumpStop: 0.35, stroke: 0.45, damping: 0.7, extendTime: 10, retractTime: 8,
    steerMax: 75, steerPedal: 6, rollingFriction: 0.015, rollingFrictionGrass: 0.05, brakeFriction: 0.4,
    lateralFriction: 0.7, breakaway: 0.015, maxSink: 4.0,
  },
  contacts: [
    { name: 'contact_nose', kind: 'nose', position: { x: 0, y: -3.3, z: -11.29 } },
    { name: 'contact_main_L', kind: 'main', position: { x: -3.795, y: -3.3, z: 1.35 } },
    { name: 'contact_main_R', kind: 'main', position: { x: 3.795, y: -3.3, z: 1.35 } },
  ],
  structure: {
    tail: { z: 16.0, strikeDeg: 11.7 },
    nose: { z: -17.3, height: 1.9 },
    belly: { z: 0, height: 1.3 },
    nacelle: { x: 5.75, z: -4.5, clearance: 0.56 },
    wingtip: { x: 17.9, z: 4.5, height: 3.6 },
    top: { height: 11.76, z: 16 },
    maxTouchdownBank: 25,
  },

  // ---- flight control: A320 normal law ----
  fcs: {
    law: 'airbus',
    nMax: 2.5, nMin: -1.0, nMaxFlaps: 2.0, nMinFlaps: 0,
    Ka: 1.4, Kq: 3.0, Kg: 0.5, qMax: 0.16, pitchExpo: 0.3,
    rollRateMax: 15, Kp: 2.5, bankComp: 33, bankMax: 67, bankHold: 33,
    pitchMax: 30, pitchMaxLow: 25, pitchMin: -15,
    clAlphaMax: 0.92, clAlphaFloor: 0.87, clAlphaProt: 0.80,
    betaMax: 8, Kb: 1.2, Kr: 2.0,
    rates: { elevator: 1.8, aileron: 2.0, rudder: 1.5, trim: 0.12 },
    trimRange: [-1, 1], takeoffTrim: 0.15,
    rotRate: 3.5, blendTime: 5,
    flareMinFlap: 4, flareAuthority: 8,
    rudderLimiter: [160 * KT, 380 * KT, 0.14],
  },
  limits: { vmo: 350 * KT, mmo: 0.82, vle: 280 * KT, vlo: 250 * KT, nMax: 2.5 },
  autopilot: { vsMax: 12, bankMax: 25, rollRate: 5, appFlap: 4, flareHeight: 15, flareSink: 0.45, flareTau: 3.2, retardHeight: 6 },
  autobrake: { landing: 'MED', decel: { LO: 1.7, MED: 3.0 } },

  // ---- performance / reference speeds (IAS, m/s, at vSpeedMass) ----
  vSpeedMass: 65000,
  vRotate: 137 * KT, v2: 142 * KT, vRef: 136 * KT,   // VR / V2 (CONF 1+F), VREF = VLS CONF FULL
  cruiseSpeed: 230, cruiseMach: 0.78, cruiseAltitude: 10670,   // M0.78 at FL350 (TAS m/s)
  serviceCeiling: 12130,                                         // 39,800 ft
  spawnSpeed: 115,                                               // airborne start (TAS), ~224 kt clean
  // published reference data used by the tests
  published: {
    stallSpeedsKt: { mass: 65000, '0': 148, '1': 132, '1+F': 125, '2': 119, '3': 116, FULL: 111 },   // VS1g
    takeoffDistanceMTOW: [1900, 2100],   // m, factored (x1.15) all-engine distance to 35 ft, SL ISA
    vmoKt: 350, mmo: 0.82,
  },
};
