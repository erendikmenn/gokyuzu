// Flight model: arcade-but-plausible Cessna-172-class aircraft.
//
// Rigid body with forces in body axes, integrated with a fixed internal sub-step
// (semi-implicit Euler at 120 Hz, leftover time accumulated, rendered state interpolated).
//
// Body axes (same as Three.js camera): nose -> -Z, up -> +Y, right wing -> +X.
// Aerodynamic sign convention used internally (all "+ = right / up"):
//   p = roll rate  (+ right wing down)  = -omega.z
//   q = pitch rate (+ nose up)          = +omega.x
//   r = yaw rate   (+ nose right)       = -omega.y
//   alpha > 0 when the relative wind comes from below, beta > 0 when it comes from the right.
//
// No DOM access: runs in Node for tests (tests/physics.test.mjs).
import * as THREE from 'three';
import { AIR_DENSITY, GRAVITY, WORLD } from '../config.js';

const DEG = Math.PI / 180;
const H = 1 / 120;            // internal fixed step (s)
const MAX_FRAME_DT = 0.25;    // anything longer (tab switch) is clamped

// ---------------------------------------------------------------------------------------------
// Aircraft data. Coefficients are per radian; control coefficients are per unit (-1..1) input.
// ---------------------------------------------------------------------------------------------
export const AIRCRAFT = {
  mass: 1000,
  inertia: { pitch: 1825, yaw: 2667, roll: 1285 }, // kg m^2
  wingArea: 16.2,
  span: 11.0,
  chord: 1.47,

  // lift
  CL0: 0.40,               // fuselage-referenced wing incidence + camber
  CLalpha: 4.9,
  alphaStall: 16 * DEG,
  alphaStallNeg: -13 * DEG,
  postStallSlope: 1.6,     // CL lost per rad beyond the stall (gentle)
  flapCL: 0.72,            // full flaps
  flapStallShift: 2 * DEG, // flaps stall at a slightly lower alpha

  // drag
  CD0: 0.027,
  oswald: 0.8,
  flapCD: 0.05,
  separationCD: 1.3,       // flat-plate drag growth beyond the stall

  // side force
  CYbeta: -0.6,

  // pitch
  Cm0: 0.04,
  Cmalpha: -0.3,           // wing + fuselage share of pitch stability (free-stream dynamic pressure)
  CmalphaTail: -0.8,       // horizontal tail share (sees the propeller slipstream, like the elevator)
  Cmq: -16,                // pitch damping (tail, incl. downwash lag)
  CmElevator: 0.45,
  CmStall: -0.9,           // extra nose-down moment per rad beyond the stall (nose drops)

  // roll
  Clbeta: -0.08,           // dihedral effect
  Clp: -0.5,               // roll damping
  Clr: 0.06,
  ClAileron: 0.068,

  // yaw
  Cnbeta: 0.09,            // weathervane stability
  Cnr: -0.22,
  Cnp: -0.03,
  CnRudder: 0.032,
  CnAileron: -0.006,       // mild adverse yaw

  // engine / propeller
  thrustStatic: 2050,      // N at full throttle, standstill
  power: 104000,           // W of useful thrust power at full throttle (thrust ~ P/V at speed)
  throttleExponent: 1.65,  // power fraction = throttle^k at speed (75% lever ~ cruise, 100% ~ top speed)
  staticThrottleExponent: 1.2, // ... and at low speed (so taxiing at 30-40% works)
  propDisc: 2.8,           // m^2
  propWash: 0.35,          // fraction of disc loading felt as extra dynamic pressure on the tail
  windmillDrag: 0.13,      // idle propeller drag coefficient (on disc area)

  // controls: the pilot's elevator authority shrinks with dynamic pressure (~constant stick force per g):
  // a full pull is ~+3 g extra at speed (loops possible) instead of an instant over-stress, yet still
  // reaches the stall when slow.
  pullG: 3.0,              // extra load factor for full nose-up input at speed
  pushG: 2.0,              // ... and for full nose-down input
  maxPullAuthority: 0.8,   // fraction of full elevator available to the pilot

  // ground
  staticCompression: 0.10, // m of strut compression at rest (wheels drawn exactly on the ground)
  bumpStop: 0.2,
  rollingFriction: 0.02,
  rollingFrictionGrass: 0.05,
  brakeFriction: 0.55,
  lateralFriction: 0.75,    // tires skid before the aircraft can tip over
  tireLongStiffness: 20000,   // N per m/s (stiff viscous approximation of Coulomb friction)
  tireLatStiffness: 20000,
};

// Stability assist ("auto-trim") tuning.
const ASSIST = {
  gammaTau: 8,             // s: flight path relaxes toward level with this time constant
  maxGammaRate: 3 * DEG,   // rad/s
  alphaMargin: 3 * DEG,    // assist never commands beyond stall - margin
  bankTau: 8,              // s: wings relax toward level
  maxLevelRollRate: 15 * DEG,
  steepBank: 40 * DEG,     // beyond this the leveler works harder (no spiral dives when hands-off)
  steepBankGain: 0.9,      // extra roll rate (rad/s) per rad of bank beyond steepBank
  rollRateGain: 1.2,
  betaGain: 2.5,           // auto-coordination rudder per rad of sideslip
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const moveToward = (v, target, maxDelta) => (Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta);

/** Terrain height with a safe fallback (e.g. outside the generated terrain). */
function groundAt(world, x, z) {
  const g = world.getGroundHeight(x, z);
  return Number.isFinite(g) ? g : WORLD.seaLevel;
}

function stallAlpha(flaps) { return AIRCRAFT.alphaStall - AIRCRAFT.flapStallShift * flaps; }
function zeroAlphaCL(flaps) { return AIRCRAFT.CL0 + AIRCRAFT.flapCL * flaps; }

/** Lift coefficient: linear up to the stall, gentle drop afterwards, flat plate at high alpha. */
export function liftCoefficient(alpha, flaps) {
  const A = AIRCRAFT;
  const cl0 = zeroAlphaCL(flaps);
  const as = stallAlpha(flaps);
  const plate = 1.15 * Math.sin(2 * alpha);
  if (alpha > as) {
    const clMax = cl0 + A.CLalpha * as;
    return Math.max(clMax - A.postStallSlope * (alpha - as), plate);
  }
  if (alpha < A.alphaStallNeg) {
    const clMin = cl0 + A.CLalpha * A.alphaStallNeg;
    return Math.min(clMin + A.postStallSlope * (A.alphaStallNeg - alpha), plate);
  }
  return cl0 + A.CLalpha * alpha;
}

/** How far past the stall we are (rad, >= 0). */
function stallDepth(alpha, flaps) {
  const as = stallAlpha(flaps);
  if (alpha > as) return alpha - as;
  if (alpha < AIRCRAFT.alphaStallNeg) return AIRCRAFT.alphaStallNeg - alpha;
  return 0;
}

/** Thrust (N) from lever position and airspeed; negative = windmilling drag at idle. */
export function thrustAt(throttle, V) {
  const A = AIRCRAFT;
  const x = (A.thrustStatic * V) / A.power; // ~1 where the static limit meets the power limit
  const k = A.staticThrottleExponent + (A.throttleExponent - A.staticThrottleExponent) * smoothstep(0, 1, x);
  const pf = Math.pow(clamp(throttle, 0, 1), k);
  const available = A.thrustStatic / Math.pow(1 + x * x * x * x, 0.25); // soft min(Tstatic, P/V)
  const qbar = 0.5 * AIR_DENSITY * V * V;
  return pf * available - A.windmillDrag * qbar * A.propDisc * (1 - throttle) * (1 - throttle);
}

// scratch objects (no allocations in the hot loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _Fb = new THREE.Vector3();
const _Fw = new THREE.Vector3();
const _Tw = new THREE.Vector3();
const _Tb = new THREE.Vector3();
const _Ffric = new THREE.Vector3();
const _Tfric = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pw = new THREE.Vector3();
const _rw = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _omegaW = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _AXIS_Y = new THREE.Vector3(0, 1, 0);

export class FlightModel {
  constructor({ gearHeight = 1.2 } = {}) {
    this.gearHeight = gearHeight;
    const A = AIRCRAFT;

    // ---- public readable state (see CONTRACTS.md) ----
    this.position = new THREE.Vector3();      // interpolated for rendering
    this.quaternion = new THREE.Quaternion(); // interpolated for rendering
    this.velocity = new THREE.Vector3();      // world m/s
    this.angularVelocity = new THREE.Vector3(); // body rad/s (extra)
    this.airspeed = 0; this.altitude = 0; this.agl = 0;
    this.heading = 0; this.pitch = 0; this.roll = 0;
    this.verticalSpeed = 0; this.gForce = 1;
    this.throttle = 0; this.flaps = 0;
    this.aileron = 0; this.elevator = 0; this.rudder = 0;
    this.onGround = true; this.stalled = false; this.crashed = false; this.crashReason = '';
    this.aoa = 0;        // degrees (extra, for HUD/audio stall warning)
    this.sideslip = 0;   // degrees (extra)
    this.thrust = 0;     // N (extra)
    this.assist = true;  // keyboard stability assist (auto-trim, wing leveler, auto-rudder)

    // ---- internal state ----
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._omega = this.angularVelocity;
    this._acc = 0;
    this._handlers = {};

    // Landing gear (body frame, relative to CG). Wheels hang staticCompression lower than drawn when
    // unloaded, so at rest the struts are compressed and the drawn wheels sit exactly on the ground.
    const s0 = A.staticCompression;
    const zNose = -1.6, zMain = 0.45, xMain = 1.25;
    const noseShare = zMain / (zMain - zNose);
    const mainShare = (1 - noseShare) / 2;
    const W = A.mass * GRAVITY;
    const mk = (x, z, share, steer, brake) => {
      const k = (share * W) / (s0 * (1 + (s0 / A.bumpStop) ** 2));
      const c = 2 * 0.75 * Math.sqrt(k * share * A.mass);
      return { r: new THREE.Vector3(x, -(gearHeight + s0), z), k, c, steer, brake, contact: false, load: 0 };
    };
    this._wheels = [mk(0, zNose, noseShare, true, false), mk(-xMain, zMain, mainShare, false, true), mk(xMain, zMain, mainShare, false, true)];
    // Tail skid: soft contact that saves over-rotations; crashes only if hit hard.
    this._tail = { r: new THREE.Vector3(0, -gearHeight + 1.25, 4.3), k: 60000, c: 9000, contact: false };
    // Structure points that must never touch the ground.
    this._structure = [
      { r: new THREE.Vector3(0, -gearHeight + 0.38, -2.3), reason: 'Burun yere çarptı' },
      { r: new THREE.Vector3(0, -gearHeight + 0.5, 0.4), reason: 'Gövde yere çarptı' },
      { r: new THREE.Vector3(-5.5, 0.75, 0.1), reason: 'Kanat ucu yere çarptı' },
      { r: new THREE.Vector3(5.5, 0.75, 0.1), reason: 'Kanat ucu yere çarptı' },
      { r: new THREE.Vector3(0, 1.05, -0.4), reason: 'Uçak yere çakıldı' },
      { r: new THREE.Vector3(0, 1.55, 4.6), reason: 'Kuyruk yere çarptı' },
    ];
    this._reach = 7; // m: no structure point is farther than this from the CG

    this._resetInternals();
  }

  on(event, cb) { (this._handlers[event] ||= []).push(cb); }

  _emit(event, info) { for (const cb of this._handlers[event] || []) cb(info); }

  _resetInternals() {
    this.velocity.set(0, 0, 0);
    this._omega.set(0, 0, 0);
    this._acc = 0;
    this._throttle = 0; this._flaps = 0;
    this._ail = 0; this._elev = 0; this._rud = 0;
    this._trim = 0;           // auto-trim elevator (assist output, frozen while the pilot pitches)
    this._assistBlend = 0;    // 0 on the ground -> 1 in flight
    this._airTime = 0;        // time spent airborne with agl > 1 m (for touchdown events)
    this._noContactTime = 0;
    this._fastRoll = false;   // ground roll above 20 m/s seen (for takeoff event)
    this._takeoffArmed = true; // re-armed by a touchdown or a sustained ground roll (no double events on a bounce)
    this._groundTime = 0;
    this._liftoff = null;
    this._contact = true;
    this._gSmooth = 1;
    this._aglCG = 0;
    this._tailWas = false;
    this._loadAcc = 0; this._loadN = 0;
    this.crashed = false; this.crashReason = '';
    this.stalled = false; this.onGround = true;
    for (const w of this._wheels) { w.contact = false; w.load = 0; }
  }

  /** Parked on the ground at (x, z), facing `heading` (radians), engine idle. */
  reset(x, z, heading, world) {
    this._resetInternals();
    this._quat.setFromAxisAngle(_AXIS_Y, -heading);
    // highest ground under the three wheels, so nothing starts below the terrain
    let g = groundAt(world, x, z);
    for (const w of this._wheels) {
      _v1.copy(w.r).applyQuaternion(this._quat);
      g = Math.max(g, groundAt(world, x + _v1.x, z + _v1.z));
    }
    this._pos.set(x, g + this.gearHeight, z);
    this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
    this._contact = true; this._noContactTime = 0;
    this._updateReadouts(world, 0);
  }

  /**
   * Extra helper (tests, spawning in the air): trimmed level flight at `speed` m/s.
   * opts: { throttle, flaps, verticalSpeed, pitch (deg, overrides trim), roll (deg) }
   */
  resetAirborne(x, y, z, heading, speed, world, opts = {}) {
    this._resetInternals();
    const A = AIRCRAFT;
    const flaps = opts.flaps ?? 0;
    const throttle = opts.throttle ?? 0.6;
    const vs = opts.verticalSpeed ?? 0;
    const qbar = 0.5 * AIR_DENSITY * speed * speed;
    const cl = (A.mass * GRAVITY) / (qbar * A.wingArea);
    const alpha = clamp((cl - zeroAlphaCL(flaps)) / A.CLalpha, -10 * DEG, stallAlpha(flaps) - 1 * DEG);
    const gamma = Math.asin(clamp(vs / speed, -1, 1));
    const pitch = opts.pitch !== undefined ? opts.pitch * DEG : alpha + gamma;
    const roll = (opts.roll ?? 0) * DEG;
    _euler.set(pitch, -heading, -roll, 'YXZ');
    this._quat.setFromEuler(_euler);
    this._pos.set(x, y, z);
    this.velocity.set(Math.sin(heading) * Math.cos(gamma), Math.sin(gamma), -Math.cos(heading) * Math.cos(gamma)).multiplyScalar(speed);
    this._throttle = throttle; this._flaps = flaps;
    this._trim = this._elev = -(A.Cm0 + (A.Cmalpha + A.CmalphaTail) * Math.sin(alpha)) / A.CmElevator;
    this._assistBlend = 1;
    this._airTime = 5; this._noContactTime = 5; this._contact = false; this.onGround = false;
    this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
    this._updateReadouts(world, 0);
  }

  step(dt, input, world) {
    if (this.crashed) return;
    this._acc += clamp(dt || 0, 0, MAX_FRAME_DT);
    this._loadAcc = 0; this._loadN = 0;
    while (this._acc >= H) {
      this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
      this._substep(H, input, world);
      this._acc -= H;
      if (this.crashed) { this._acc = 0; break; }
    }
    if (this._loadN > 0) {
      const g = this._loadAcc / this._loadN;
      this._gSmooth += (g - this._gSmooth) * clamp(dt / 0.12, 0, 1);
    }
    this._updateReadouts(world, this.crashed ? 1 : this._acc / H);
  }

  // -------------------------------------------------------------------------------------------
  _substep(h, inp, world) {
    const A = AIRCRAFT;
    const m = A.mass;
    const pos = this._pos, quat = this._quat, vel = this.velocity, omega = this._omega;

    // ---- engine & flaps (lever -> actual) ----
    this._throttle = moveToward(this._throttle, clamp(inp.throttle ?? 0, 0, 1), h * 1.2);
    this._flaps = moveToward(this._flaps, clamp(inp.flaps ?? 0, 0, 1), h * 0.4);
    const flaps = this._flaps;

    // ---- air data ----
    _qInv.copy(quat).invert();
    _vb.copy(vel).applyQuaternion(_qInv); // body-frame velocity (no wind)
    const V = _vb.length();
    const Vs = Math.max(V, 1);
    const qbar = 0.5 * AIR_DENSITY * V * V;
    let alpha = 0, beta = 0;
    if (V > 0.5) {
      alpha = Math.atan2(-_vb.y, -_vb.z);
      beta = Math.asin(clamp(_vb.x / V, -1, 1));
    }
    const p = -omega.z, q = omega.x, r = -omega.y;

    const T = thrustAt(this._throttle, V);
    const qbarTail = qbar + A.propWash * Math.max(T, 0) / A.propDisc;

    // attitude (for the assists)
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    _right.set(1, 0, 0).applyQuaternion(quat);
    _up.set(0, 1, 0).applyQuaternion(quat);
    const bank = Math.atan2(-_right.y, _up.y);
    const pitchAtt = Math.asin(clamp(_fwd.y, -1, 1));
    const gamma = V > 1 ? Math.asin(clamp(vel.y / V, -1, 1)) : 0;

    // ---- controls: pilot + stability assist -> smoothed surfaces ----
    const airborne = !this._contact && V > 12;
    this._assistBlend = moveToward(this._assistBlend, airborne && this.assist ? 1 : 0, h * (airborne ? 2 : 4));
    const blend = this._assistBlend;
    const pin = clamp(inp.pitch ?? 0, -1, 1), rin = clamp(inp.roll ?? 0, -1, 1), yin = clamp(inp.yaw ?? 0, -1, 1);
    const wP = 1 - smoothstep(0.02, 0.2, Math.abs(pin));
    const wR = 1 - smoothstep(0.02, 0.2, Math.abs(rin));
    const wY = 1 - smoothstep(0.02, 0.2, Math.abs(yin));

    // pitch: auto-trim tracks the assist target while the pilot is off the controls
    if (this._contact) {
      this._trim = moveToward(this._trim, 0, h * 0.5);
    } else if (blend > 0) {
      const target = blend * this._pitchAssist(V, qbar, qbarTail, alpha, gamma, bank, pitchAtt, T, flaps);
      this._trim += (target - this._trim) * Math.min(1, h * 8) * wP;
    }
    // alpha change per unit elevator, then elevator needed for the pilot's g budget
    const dAlphaPerElev = (A.CmElevator * qbarTail) / Math.max(-A.Cmalpha * qbar - A.CmalphaTail * qbarTail, 1);
    const nPerElev = (qbar * A.wingArea * A.CLalpha * dAlphaPerElev) / (m * GRAVITY);
    const gBudget = pin >= 0 ? A.pullG : A.pushG;
    const authority = Math.min(A.maxPullAuthority, gBudget / Math.max(nPerElev, 1e-3));
    const elevCmd = clamp(this._trim + pin * authority, -1, 1);

    // roll: wing leveler when released
    let ailCmd = rin;
    const wRoll = wR * (1 - smoothstep(0.3, 0.8, Math.abs(pin))); // no wing leveling mid-loop
    if (blend > 0 && wRoll > 0) {
      const steep = Math.max(0, Math.abs(bank) - ASSIST.steepBank) * ASSIST.steepBankGain;
      const pDes = -Math.sign(bank) * Math.min(Math.abs(bank) / ASSIST.bankTau, ASSIST.maxLevelRollRate) - Math.sign(bank) * Math.min(steep, 50 * DEG);
      const G = (A.ClAileron / -A.Clp) * (2 * Vs) / A.span; // steady roll rate per unit aileron
      const da = (pDes + ASSIST.rollRateGain * (pDes - p)) / Math.max(G, 0.3);
      const nearVertical = Math.cos(pitchAtt) ** 2;
      ailCmd += wRoll * blend * nearVertical * clamp(da, -0.5, 0.5);
    }
    ailCmd = clamp(ailCmd, -1, 1);

    // yaw: auto-coordination (kills sideslip) when released
    let rudCmd = yin;
    if (blend > 0 && wY > 0) rudCmd += wY * blend * clamp(ASSIST.betaGain * beta, -0.4, 0.4);
    rudCmd = clamp(rudCmd, -1, 1);

    const k = Math.min(1, h * 20);
    this._elev = moveToward(this._elev, this._elev + (elevCmd - this._elev) * k, h * 5);
    this._ail = moveToward(this._ail, this._ail + (ailCmd - this._ail) * k, h * 7);
    this._rud = moveToward(this._rud, this._rud + (rudCmd - this._rud) * k, h * 5);

    // ---- aerodynamic forces (body frame) ----
    _Fb.set(0, 0, 0);
    _Tb.set(0, 0, 0);
    let aglWing = 50;
    if (V > 0.5) {
      const S = A.wingArea;
      const CL = liftCoefficient(alpha, flaps);
      const sd = stallDepth(alpha, flaps);
      // ground effect reduces induced drag close to the ground
      aglWing = this._aglCG + 2.0;
      const hb = aglWing / A.span;
      const ge = hb < 1.5 ? (16 * hb * hb) / (1 + 16 * hb * hb) : 1;
      const AR = (A.span * A.span) / S;
      let CD = A.CD0 + A.flapCD * flaps + (CL * CL) / (Math.PI * AR * A.oswald) * ge;
      if (sd > 0) {
        const sa = Math.sin(Math.abs(alpha)), ss = Math.sin(stallAlpha(flaps));
        CD += A.separationCD * Math.max(0, sa * sa - ss * ss);
      }
      const CY = A.CYbeta * Math.sin(beta);
      // directions: drag opposite to the relative wind, lift perpendicular in the symmetry plane
      const dx = _vb.x / V, dy = _vb.y / V, dz = _vb.z / V;
      const ln = Math.hypot(dy, dz) || 1;
      const L = qbar * S * CL, D = qbar * S * CD, Y = qbar * S * CY;
      _Fb.x += -dx * D + Y;
      _Fb.y += -dy * D + L * (-dz / ln);
      _Fb.z += -dz * D + L * (dy / ln);

      // moments
      const c = A.chord, b = A.span;
      const ph = (p * b) / (2 * Vs), qh = (q * c) / (2 * Vs), rh = (r * b) / (2 * Vs);
      const sa = Math.sin(alpha);
      const Cm = A.Cm0 + A.Cmalpha * sa + A.CmStall * sd;
      const CmTail = A.CmalphaTail * sa + A.Cmq * qh + A.CmElevator * this._elev;
      const Cl = A.Clbeta * Math.sin(beta) + A.Clp * ph + A.Clr * rh;
      const Cn = A.Cnbeta * Math.sin(beta) + A.Cnr * rh + A.Cnp * ph;
      const Mp = qbar * S * c * Cm + qbarTail * S * c * CmTail;
      const Lr = qbar * S * b * (Cl + A.ClAileron * this._ail);
      const Ny = qbar * S * b * (Cn + A.CnAileron * this._ail) + qbarTail * S * b * A.CnRudder * this._rud;
      _Tb.x += Mp; _Tb.y += -Ny; _Tb.z += -Lr;
    }
    // thrust along the nose
    _Fb.z -= T;
    this.thrust = T;

    // to world
    _Fw.copy(_Fb).applyQuaternion(quat);
    _Tw.set(0, 0, 0);

    // ---- ground contact ----
    const gCG = groundAt(world, pos.x, pos.z);
    this._aglCG = pos.y - this.gearHeight - gCG;
    const nearGround = pos.y - gCG < this._reach + 6 || this._contact;
    let anyContact = false;
    let wheelContact = false;
    let wheelsDown = 0, capLong = 0, capLat = 0;
    const brake = !!inp.brake;
    _omegaW.copy(omega).applyQuaternion(quat);
    _Ffric.set(0, 0, 0); _Tfric.set(0, 0, 0);
    if (nearGround && this._checkStructure(world)) return;
    if (nearGround) {
      // forward on the ground and speed for nose-wheel steering
      const groundSpeed = Math.hypot(vel.x, vel.z);
      const steerMax = (30 * DEG) / (1 + (groundSpeed / 5) ** 2); // keeps lateral accel < ~0.6 g
      const steer = this._rud * steerMax;
      for (const w of this._wheels) {
        w.contact = false; w.load = 0;
        _rw.copy(w.r).applyQuaternion(quat);
        _pw.copy(pos).add(_rw);
        const gh = groundAt(world, _pw.x, _pw.z);
        const pen = gh - _pw.y;
        if (pen <= 0) continue;
        if (world.isWater && world.isWater(_pw.x, _pw.z)) { this._crash('Uçak suya düştü'); return; }
        this._groundNormal(world, _pw.x, _pw.z, gh, _n);
        if (_n.y < 0.5) { this._crash('Uçak yere çakıldı'); return; }        // wall / cliff, not a surface to roll on
        const d = pen * _n.y;
        if (d > A.staticCompression + 0.45) { this._crash('İniş takımı kırıldı'); return; }
        _vc.crossVectors(_omegaW, _rw).add(vel);
        const vn = _vc.dot(_n);
        if (vn < -5.5) { this._crash('Çok sert iniş'); return; }
        let N = w.k * d * (1 + (d / A.bumpStop) ** 2) - w.c * vn;
        N = clamp(N, 0, 15 * m * GRAVITY);
        w.contact = true; w.load = N; anyContact = true; wheelContact = true; wheelsDown++;
        // tire frame
        _wf.copy(_fwd).addScaledVector(_n, -_fwd.dot(_n)).normalize();
        if (w.steer && steer !== 0) _wf.applyAxisAngle(_n, -steer);
        _wl.crossVectors(_wf, _n);
        const vLong = _vc.dot(_wf), vLat = _vc.dot(_wl);
        const onRunway = world.isOnRunway ? world.isOnRunway(_pw.x, _pw.z) : true;
        let mu = onRunway ? A.rollingFriction : A.rollingFrictionGrass;
        if (w.brake && brake) mu += A.brakeFriction;
        const fLong = -clamp(vLong * A.tireLongStiffness, -mu * N, mu * N);
        const fLat = -clamp(vLat * A.tireLatStiffness, -A.lateralFriction * N, A.lateralFriction * N);
        capLong += mu * N; capLat += A.lateralFriction * N;
        // normal force
        _v1.copy(_n).multiplyScalar(N);
        _Fw.add(_v1);
        _Tw.add(_v2.crossVectors(_rw, _v1));
        // tire friction (kept separate for the stiction test below)
        _v1.copy(_wf).multiplyScalar(fLong).addScaledVector(_wl, fLat);
        _Ffric.add(_v1);
        _Tfric.add(_v2.crossVectors(_rw, _v1));
      }
      // tail skid
      const t = this._tail;
      t.contact = false;
      _rw.copy(t.r).applyQuaternion(quat);
      _pw.copy(pos).add(_rw);
      const ght = groundAt(world, _pw.x, _pw.z);
      const pent = ght - _pw.y;
      if (pent > 0) {
        _vc.crossVectors(_omegaW, _rw).add(vel);
        if (!this._tailWas && _vc.y < -3) { this._crash('Kuyruk yere sert çarptı'); return; }
        if (world.isWater && world.isWater(_pw.x, _pw.z)) { this._crash('Uçak suya düştü'); return; }
        let N = t.k * pent - t.c * _vc.y;
        if (N < 0) N = 0;
        _v1.set(0, N, 0);
        _v3.set(_vc.x, 0, _vc.z);
        const sp = _v3.length();
        if (sp > 1e-4) _v1.addScaledVector(_v3, -Math.min(0.5 * N, sp * 20000) / sp);
        _Fw.add(_v1);
        _Tw.add(_v2.crossVectors(_rw, _v1));
        t.contact = true; anyContact = true;
      }
      this._tailWas = t.contact;
    } else {
      for (const w of this._wheels) { w.contact = false; w.load = 0; }
      this._tailWas = false;
    }

    // ---- events on first contact ----
    if (anyContact && !this._contact) {
      const vs = vel.y;
      const e = _euler.setFromQuaternion(quat, 'YXZ');
      const pitchDeg = e.x / DEG, rollDeg = -e.z / DEG;
      if (vs < -5) { this._crash('Çok sert iniş'); return; }
      if (Math.abs(rollDeg) > 30) { this._crash('Yatış açısı çok fazlaydı, kanat yere vurdu'); return; }
      if (pitchDeg < -10) { this._crash('Burun yere çarptı'); return; }
      if (pitchDeg > 25) { this._crash('Kuyruk yere çarptı'); return; }
      if (this._airTime > 1) {
        this._takeoffArmed = true;
        this._emit('touchdown', {
          verticalSpeed: vs,
          onRunway: world.isOnRunway ? world.isOnRunway(pos.x, pos.z) : false,
          pitch: pitchDeg, roll: rollDeg,
        });
      }
      this._airTime = 0;
    }
    if (anyContact) {
      this._noContactTime = 0;
      this._groundTime += h;
      if (this._groundTime > 2) this._takeoffArmed = true;
      this._liftoff = null;
      if (V > 20 && wheelContact) this._fastRoll = true;
    } else {
      if (this._noContactTime === 0 && this._fastRoll) this._liftoff = { x: pos.x, z: pos.z, airspeed: V };
      this._noContactTime += h;
      this._groundTime = 0;
      if (this._aglCG > 1) this._airTime += h;
      if (this._fastRoll && this._noContactTime > 0.3 && this._liftoff) {
        this._fastRoll = false;
        if (this._takeoffArmed) {
          this._takeoffArmed = false;
          this._emit('takeoff', { ...this._liftoff });
        }
      }
    }
    this._contact = anyContact;

    // ---- static friction: at (near) rest, if the tires can hold the driving force, hold still ----
    let stuck = false;
    if (wheelsDown === 3 && V < 0.05 && omega.lengthSq() < 0.0025) {
      // everything except tire friction, including gravity, in the ground plane
      _v1.copy(_Fw); _v1.y -= m * GRAVITY;
      _wf.copy(_fwd); _wf.y = 0; _wf.normalize();
      _wl.set(-_wf.z, 0, _wf.x);
      stuck = Math.abs(_v1.dot(_wf)) < capLong && Math.abs(_v1.dot(_wl)) < capLat;
    }
    if (!stuck) { _Fw.add(_Ffric); _Tw.add(_Tfric); }

    // ---- load factor (non-gravitational specific force along body up) ----
    this._loadAcc += _Fw.dot(_up) / (m * GRAVITY);
    this._loadN++;

    // ---- integrate ----
    vel.addScaledVector(_Fw, h / m);
    vel.y -= GRAVITY * h;
    if (stuck) {
      vel.x = 0; vel.z = 0;
      // no yawing while held by the tires either
      _omegaW.copy(omega).applyQuaternion(quat);
      _omegaW.y = 0;
      omega.copy(_omegaW.applyQuaternion(_qInv));
    }
    pos.addScaledVector(vel, h);

    // rotation (body frame, Euler's equations with diagonal inertia)
    _Tw.applyQuaternion(_qInv);
    _Tb.add(_Tw);
    const I = A.inertia;
    const Ix = I.pitch, Iy = I.yaw, Iz = I.roll;
    const wx = omega.x, wy = omega.y, wz = omega.z;
    // gyroscopic term: omega x (I omega)
    const gx = wy * (Iz * wz) - wz * (Iy * wy);
    const gy = wz * (Ix * wx) - wx * (Iz * wz);
    const gz = wx * (Iy * wy) - wy * (Ix * wx);
    // light structural damping so the airframe never spins freely at zero airspeed
    const dampK = 0.15;
    omega.x += ((_Tb.x - gx) / Ix - dampK * wx) * h;
    omega.y += ((_Tb.y - gy) / Iy - dampK * wy) * h;
    omega.z += ((_Tb.z - gz) / Iz - dampK * wz) * h;
    if (omega.lengthSq() > 64) omega.setLength(8);
    const ang = omega.length() * h;
    if (ang > 1e-12) {
      _dq.setFromAxisAngle(_v1.copy(omega).normalize(), ang);
      quat.multiply(_dq).normalize();
    }

    if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z)) this._crash('Sayısal hata');
  }

  /** Elevator (incl. trim) that makes the aircraft hold its flight path, relaxing gently toward level. */
  _pitchAssist(V, qbar, qbarTail, alpha, gamma, bank, pitchAtt, T, flaps) {
    const A = AIRCRAFT;
    const Vs = Math.max(V, 10);
    const cb = Math.cos(bank);
    const gdot = clamp(-gamma / ASSIST.gammaTau, -ASSIST.maxGammaRate, ASSIST.maxGammaRate);
    const nLevel = Math.cos(gamma) + (Vs * gdot) / GRAVITY;
    // level flight needs n = nLevel / cos(bank); continuous through knife edge (0 g) to inverted (-1 g)
    const n = clamp((nLevel * cb) / Math.max(cb * cb, 0.25), -1, 2.5);
    const clDes = (n * A.mass * GRAVITY - Math.max(T, 0) * Math.sin(alpha)) / (Math.max(qbar, 50) * A.wingArea);
    const aDes = clamp((clDes - zeroAlphaCL(flaps)) / A.CLalpha, -8 * DEG, stallAlpha(flaps) - ASSIST.alphaMargin);
    const qExp = (GRAVITY * (n - Math.cos(gamma) * cb)) / Vs;
    const sa = Math.sin(aDes);
    // moment balance: qbar (Cm0 + Cma sa) + qbarTail (Cma_t sa + Cmq qhat + Cmde de) = 0
    const wing = qbar * (A.Cm0 + A.Cmalpha * sa);
    const qt = Math.max(qbarTail, 50);
    const tail = A.CmalphaTail * sa + (A.Cmq * qExp * A.chord) / (2 * Vs);
    return clamp((-wing / qt - tail) / A.CmElevator, -1, 1);
  }

  /** Crash if any structure point (nose, belly, wingtips, roof, fin) is below the terrain. */
  _checkStructure(world) {
    for (const s of this._structure) {
      _pw.copy(s.r).applyQuaternion(this._quat).add(this._pos);
      if (_pw.y < groundAt(world, _pw.x, _pw.z)) {
        const water = world.isWater && world.isWater(_pw.x, _pw.z);
        this._crash(water ? 'Uçak suya düştü' : s.reason);
        return true;
      }
    }
    return false;
  }

  _groundNormal(world, x, z, h0, out) {
    const hx = groundAt(world, x + 0.5, z) - h0;
    const hz = groundAt(world, x, z + 0.5) - h0;
    return out.set(-hx / 0.5, 1, -hz / 0.5).normalize();
  }

  _crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.velocity.set(0, 0, 0);
    this._omega.set(0, 0, 0);
    this._emit('crash', { reason, position: this._pos.clone() });
  }

  _updateReadouts(world, alpha) {
    this.position.lerpVectors(this._prevPos, this._pos, alpha);
    this.quaternion.slerpQuaternions(this._prevQuat, this._quat, alpha);
    const V = this.velocity.length();
    this.airspeed = V;
    this.altitude = this.position.y;
    const g = groundAt(world, this.position.x, this.position.z);
    this.agl = Math.max(0, this.position.y - this.gearHeight - g);
    this._aglCG = this._pos.y - this.gearHeight - groundAt(world, this._pos.x, this._pos.z);
    const e = _euler.setFromQuaternion(this._quat, 'YXZ');
    this.heading = ((-e.y / DEG) % 360 + 360) % 360;
    this.pitch = e.x / DEG;
    this.roll = -e.z / DEG;
    this.verticalSpeed = this.velocity.y;
    this.gForce = this._gSmooth;
    this.throttle = this._throttle;
    this.flaps = this._flaps;
    this.aileron = this._ail;
    this.elevator = this._elev;
    this.rudder = this._rud;
    this.onGround = this._contact;
    // angle of attack / stall
    _qInv.copy(this._quat).invert();
    _vb.copy(this.velocity).applyQuaternion(_qInv);
    const a = V > 0.5 ? Math.atan2(-_vb.y, -_vb.z) : 0;
    this.aoa = a / DEG;
    this.sideslip = V > 0.5 ? Math.asin(clamp(_vb.x / V, -1, 1)) / DEG : 0;
    const as = stallAlpha(this._flaps);
    if (this._contact || V < 3) this.stalled = false;
    else if (!this.stalled && a > as + 0.5 * DEG) this.stalled = true;
    else if (this.stalled && a < as - 0.5 * DEG) this.stalled = false;
  }
}
