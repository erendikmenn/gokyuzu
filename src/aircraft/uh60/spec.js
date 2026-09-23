// Sikorsky UH-60M Black Hawk: data for the helicopter flight model (src/flight/helicopter.js).
// Published data (Sikorsky / US Army TM 1-1520-237-10, Jane's) where available; aerodynamic coefficients are
// calibrated so the model reproduces the published performance (hover torque, cruise, Vh, VNE, ceilings).
// Body axes (Three.js): nose -Z, up +Y, right +X, origin at the CG. Geometry matches the Blender model
// (blender/aircraft/uh60: CG 0.35 m aft of the mast, 1.55 m above the ground).
const KT = 0.514444;
const FT = 0.3048;

export default {
  id: 'uh60',
  category: 'helicopter',
  name: 'UH-60M Black Hawk',
  engines: 2,

  // ---- performance / handbook data -------------------------------------------------------------
  mass: {
    empty: 5300,          // kg (≈ 11,700 lb)
    typical: 8500,        // kg typical mission gross weight (crew, 11 troops or cargo, full internal fuel)
    max: 9980,            // kg max gross weight (22,000 lb)
    fuel: 1090,           // kg internal fuel (360 US gal JP-8)
  },
  cruiseSpeed: 150 * KT,  // m/s (≈ 150 kt at typical weight)
  maxSpeed: 159 * KT,     // m/s max level-flight speed (Vh) at max continuous power
  vne: 193 * KT,          // m/s never-exceed speed
  serviceCeiling: 5790,   // m (19,000 ft)
  hogeCeiling: 3000,      // m hover-out-of-ground-effect ceiling, ISA, heavy (model: 3,000 m at 9.5 t, 2,500 m at 10 t)
  spawnSpeed: 50,         // m/s (≈ 97 kt) for airborne spawns
  vRotate: 0,
  vRef: 40 * KT,          // approach speed (m/s) used by the HUD/avionics
  abDetent: null,
  flapDetents: [{ label: '—', value: 0 }],

  // ---- rigid body ---------------------------------------------------------------------------------
  inertia: { roll: 7600, pitch: 62000, yaw: 59000 },   // kg m² at typical mass (GenHel UH-60A, scaled)

  // ---- main rotor (4-blade fully articulated elastomeric hub, SC1095 wide-chord blades) ------------
  mainRotor: {
    radius: 8.18,         // m (Ø 53 ft 8 in = 16.36 m)
    blades: 4,
    chord: 0.58,          // m wide-chord blade
    rpm: 258,             // 100 % NR
    direction: 'ccw',     // counter-clockwise seen from above (advancing blade on the right)
    twistDeg: -18,        // linear-equivalent blade twist
    liftSlope: 5.73,      // per rad
    tipLoss: 0.97,
    hingeOffset: 0.381,   // m (15 in)
    bladeMass: 116,       // kg
    shaftTiltDeg: 3,      // forward mast tilt
    hub: [0, 1.87, -0.38],        // blade plane centre relative to the CG (m)
    collectiveDeg: [0.5, 16.5],   // blade pitch at 0.75 R, lever full down / full up
    cyclicLonDeg: 16,     // max disc tilt from longitudinal cyclic (±)
    cyclicLatDeg: 9,      // max disc tilt from lateral cyclic (±)
    polarInertia: 8600,   // kg m², rotor + drive train referred to the main rotor
    cd0: 0.0078,          // profile drag coefficient ...
    cd2: 0.3,             // ... + cd2 * (mean blade AoA)²
    mdd: 0.80,            // drag-divergence Mach number of the advancing tip
    compressibility: 0.8, // Δcd = k (M_adv - Mdd)²
    stallCT: 0.128,       // retreating-blade stall onset CT/σ = stallCT - stallMu·μ² - stallMu4·μ⁴ (McHugh-like boundary)
    stallMu: 0.05,
    stallMu4: 1.0,
    stallWidth: 0.013,    // soft thrust saturation above the onset (CT/σ)
  },

  // ---- tail rotor (4 blades, canted 20° so it also lifts) ------------------------------------------
  tailRotor: {
    radius: 1.675,        // m (Ø 11 ft)
    blades: 4,
    chord: 0.246,
    rpm: 1190,
    cantDeg: 20,
    twistDeg: -18,
    liftSlope: 5.73,
    cd0: 0.009,
    position: [0.36, 2.0, 9.71],  // hub relative to the CG, right side of the pylon; thrust toward +X (anti-torque), tilted up by the cant
    pitchCenterDeg: 3.5,  // blade pitch at pedals centred, collective full down
    pitchRangeDeg: 14,    // ± pedal authority
    collectiveMixDeg: 14, // mechanical collective → tail rotor mixing (full lever)
    pitchLimitsDeg: [-9, 26],
  },

  // ---- engines / drive train (2 × GE T700-GE-701D) --------------------------------------------------
  engine: {
    name: 'T700-GE-701D',
    powerShp: 1994,       // per engine, sea level ISA
    transmissionShp: 3400, // dual-engine main transmission limit → 100 % torque
    accessoryKW: 45,
    efficiency: 0.97,
    idleFraction: 0.05,
    responseTime: 0.22,   // s gas-generator lag
    lapseExponent: 0.8,   // available power ∝ σ^k
    fuelFlowIdle: 60,     // kg/h per engine
    fuelFlowMax: 421,     // kg/h per engine at max power (sfc ≈ 0.465 lb/shp/h)
  },

  // ---- airframe aerodynamics -----------------------------------------------------------------------
  fuselage: {
    dragArea: [16, 24, 3.7],  // m² equivalent flat-plate area sideways / vertical / frontal (≈ 40 ft² incl. hub)
    download: 0.04,       // rotor-wake download on the fuselage in hover (fraction of thrust)
    pitchVolume: 18,      // m³ unstable fuselage pitching moment
    yawVolume: 24,        // m³ unstable fuselage yawing moment
  },
  stabilator: {
    area: 4.18,           // m² (45 ft²)
    aspect: 4.6,
    liftSlope: 3.5,
    position: [0, -0.08, 8.8],
    rangeDeg: [-8, 42],   // trailing edge up … trailing edge down
    // airspeed schedule (kt → deg trailing-edge-down), plus collective coupling and pitch-rate feedback
    schedule: [[0, 42], [30, 42], [55, 20], [80, 6], [120, 2], [160, 0]],
    collectiveDeg: 8,     // extra TED per unit collective above 0.5 (above 30 kt)
    pitchRateGain: 0.5,   // deg TED per deg/s nose-up rate
  },
  fin: {
    area: 3.0,            // m² (32 ft²)
    aspect: 1.9,
    liftSlope: 2.6,
    position: [0, 1.5, 8.9],
    camberCL: 0.22,       // side force toward +X at zero sideslip (unloads the tail rotor in cruise)
  },

  // ---- landing gear defaults (used when the rig provides no contacts) -----------------------------
  gear: {
    contacts: [
      { name: 'contact_main_L', position: [-1.352, -1.55, -1.57], kind: 'main' },
      { name: 'contact_main_R', position: [1.352, -1.55, -1.57], kind: 'main' },
      { name: 'contact_tail', position: [0, -1.55, 7.30], kind: 'tail' },
    ],
    mainTrack: 2.7,       // m (8 ft 10.5 in)
    wheelbase: 8.83,      // m (29 ft)
    staticCompression: 0.12,
    stroke: 0.42,         // m usable stroke beyond static
    rollingFriction: 0.02,
    rollingFrictionRough: 0.05,
    brakeFriction: 0.5,
    lateralFriction: 0.6,
    hardLanding: 3.6,     // m/s sink rate → crash (landing gear design limit ≈ 10–12 ft/s)
  },

  lengthFt: 64.83 * FT,   // overall length with rotors turning (m)
};
