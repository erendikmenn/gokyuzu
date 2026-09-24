// UH-60M Black Hawk flight model (FlightModel interface of CONTRACTS-SF.md §6.3).
//
// 6-DOF rigid body integrated at a fixed 120 Hz sub-step (semi-implicit Euler, rendered state interpolated).
//  * Main rotor: blade-element thrust (linear twist, tip loss, uniform inflow) coupled with a dynamic inflow state
//    (momentum theory, Glauert forward flight → effective translational lift, empirical vortex-ring curve, ground
//    effect), first-order tip-path-plane flapping (cyclic, flap-back with speed, coning/transverse-flow lateral flapping,
//    pitch/roll-rate lag = rotor damping + gyroscopic cross coupling), hub moments from the hinge offset, profile power
//    with blade loading and advancing-tip compressibility, soft retreating-blade stall (thrust limit, pitch-up, roll-left,
//    power rise), H-force.
//  * Tail rotor: canted 20° (lifts), blade-element + inflow state; pedals = tail-rotor pitch with collective mixing;
//    sideslip / yaw rate change its inflow (yaw damping, weathervaning together with the cambered fin).
//  * Drive train: two T700-GE-701D with an NR governor (load anticipation + PI), power lapse with density, torque
//    output, rotor-speed dynamics (droop when power-limited, free-wheeling), engine torque reaction on the airframe.
//  * Airframe: fuselage drag areas + download + unstable moments, scheduled stabilator in the rotor wake, fin.
//  * AFCS (helicopter-afcs.js): SAS/FPS attitude hold + trim, turn coordination, hover / altitude hold modes.
//  * Ground: struts with springs/dampers, brakes, castoring tail wheel, stiction, touchdown/hard landing, dynamic
//    rollover, rotor/tail-rotor strikes (terrain, world.getObstacleHeight, world.hitTest), water ditching.
//  * Failures (failures.js API): engine (one T700 out: the other at its contingency rating, ≈ 59 % of the dual-engine
//    transmission torque), engineAll (autorotation: NR from the airflow, flare), fire (the engine fails after a delay
//    unless shut down; fire handle + extinguisher), tailRotor ('drive': no tail-rotor thrust, the main-rotor torque yaws
//    the nose right; 'fixed': pitch frozen). Flags engineFail, engineFire, tailRotor.
//
// Body axes (Three.js): nose -Z, up +Y, right +X. Aero sign convention: p = roll right, q = nose up, r = nose right.
// No DOM access: runs in Node (tests/helicopter.test.mjs).
import * as THREE from 'three';
import {
  G, DEG, KT, SHP, clamp, smoothstep, lerp, moveToward, wrapPi, isa, inducedRatio, groundEffect, surfaceCoefficients, solveLinear,
} from './helicopter-aero.js';
import { AFCS } from './helicopter-afcs.js';
import { createLnav } from '../nav/lnav.js';
import { FailureManager } from './failures.js';

const H = 1 / 120;             // internal fixed step (s)
const MAX_FRAME_DT = 0.25;
const B_TIP = 0.97;

// scratch (no allocations in the hot loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _Fw = new THREE.Vector3();
const _Tw = new THREE.Vector3();
const _Ffric = new THREE.Vector3();
const _Tfric = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pw = new THREE.Vector3();
const _rw = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _omegaW = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _AXIS_Y = new THREE.Vector3(0, 1, 0);
const _coef = { cl: 0, cd: 0 };
const _qTrim = new THREE.Quaternion();
const RIM_FRACTIONS = [0.45, 0.95];

/** Derived constants from the spec. */
function deriveParams(spec) {
  const mr = spec.mainRotor, tr = spec.tailRotor, en = spec.engine, fu = spec.fuselage, st = spec.stabilator, fin = spec.fin;
  const R = mr.radius, Nb = mr.blades;
  const e = mr.hingeOffset;
  const Om0 = (mr.rpm * 2 * Math.PI) / 60;
  const Ib = (mr.bladeMass * (R - e) ** 2) / 3;
  const Sb = (mr.bladeMass * (R - e)) / 2;
  const is = mr.shaftTiltDeg * DEG;
  const cant = tr.cantDeg * DEG;
  const RT = tr.radius;
  const P = {
    R, A: Math.PI * R * R, Nb, c: mr.chord, sigma: (Nb * mr.chord) / (Math.PI * R), a: mr.liftSlope,
    twist: mr.twistDeg * DEG, Om0, Ib, Sb, bladeMass: mr.bladeMass, e,
    Kb0: (Nb / 2) * e * Sb * Om0 * Om0,
    lockBase: (mr.liftSlope * mr.chord * R ** 4) / Ib,  // × rho = Lock number
    hub: mr.hub.slice(),
    // shaft axis (up) and forward in-plane axis of the (forward tilted) shaft
    sy: Math.cos(is), sz: -Math.sin(is), fy: -Math.sin(is), fz: -Math.cos(is),
    thMin: mr.collectiveDeg[0] * DEG, thMax: mr.collectiveDeg[1] * DEG,
    Blon: mr.cyclicLonDeg * DEG, Blat: mr.cyclicLatDeg * DEG,
    IR: mr.polarInertia,
    cd0: mr.cd0, cd2: mr.cd2, mdd: mr.mdd, kComp: mr.compressibility,
    stallC0: mr.stallCT, stallC2: mr.stallMu, stallC4: mr.stallMu4 || 0, stallW: mr.stallWidth,
    // tail rotor
    RT, AT: Math.PI * RT * RT, sigmaT: (tr.blades * tr.chord) / (Math.PI * RT), aT: tr.liftSlope, twistT: tr.twistDeg * DEG,
    gearT: tr.rpm / mr.rpm, tpos: tr.position.slice(), tdx: Math.cos(cant), tdy: Math.sin(cant),
    thT0: tr.pitchCenterDeg * DEG, thTrange: tr.pitchRangeDeg * DEG, thTmix: tr.collectiveMixDeg * DEG,
    thTmin: tr.pitchLimitsDeg[0] * DEG, thTmax: tr.pitchLimitsDeg[1] * DEG, cd0T: tr.cd0,
    // engines
    Peng: en.powerShp * SHP, Pxmsn: en.transmissionShp * SHP, Pacc: en.accessoryKW * 1000, eta: en.efficiency,
    idle: en.idleFraction, tauE: en.responseTime, lapse: en.lapseExponent, ffIdle: en.fuelFlowIdle, ffMax: en.fuelFlowMax,
    // airframe
    fdx: fu.dragArea[0], fdy: fu.dragArea[1], fdz: fu.dragArea[2], download: fu.download, volP: fu.pitchVolume, volY: fu.yawVolume,
    Sh: st.area, ARh: st.aspect, CLah: st.liftSlope, hpos: st.position.slice(), stabMin: st.rangeDeg[0] * DEG, stabMax: st.rangeDeg[1] * DEG,
    stabSched: st.schedule, stabCol: st.collectiveDeg * DEG, stabQ: st.pitchRateGain,
    Sv: fin.area, ARv: fin.aspect, CLav: fin.liftSlope, vpos: fin.position.slice(), finCamber: fin.camberCL / fin.liftSlope,
    vne: spec.vne,
  };
  return P;
}

function stabScheduleDeg(sched, kt) {
  if (kt <= sched[0][0]) return sched[0][1];
  for (let i = 1; i < sched.length; i++) {
    if (kt <= sched[i][0]) {
      const [x0, y0] = sched[i - 1], [x1, y1] = sched[i];
      return y0 + (y1 - y0) * smoothstep(0, 1, (kt - x0) / (x1 - x0));
    }
  }
  return sched[sched.length - 1][1];
}

export function createHelicopterModel(spec, { contacts } = {}) {
  return new HelicopterModel(spec, contacts);
}

export class HelicopterModel {
  constructor(spec, contacts) {
    this.spec = spec;
    this.P = deriveParams(spec);
    const P = this.P;
    this._handlers = {};

    // ---- public readable state ----
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.airspeed = 0; this.ias = 0; this.mach = 0; this.altitude = 0; this.agl = 0;
    this.heading = 0; this.pitch = 0; this.roll = 0; this.verticalSpeed = 0; this.gForce = 1; this.aoa = 0; this.sideslip = 0;
    this.throttle = 0; this.onGround = true; this.stalled = false; this.crashed = false; this.crashReason = '';
    this.crashCause = '';         // '' | 'collective' (collective lowered into a hard ground / water impact, see _crash)
    this.aileron = 0; this.elevator = 0; this.rudder = 0;
    this.engines = [0, 1].map(() => ({ n1: 0, thrust: 0, afterburner: 0, fuelFlow: 0, power: 0, torque: 0, running: true, cause: '' }));
    this.gear = 1; this.gearHandleDown = true; this.flaps = 0; this.flapsIndex = 0; this.flapsLabel = '—';
    this.slats = 0; this.spoilers = 0; this.speedbrake = 0; this.reverser = 0; this.brakes = 0;
    this.fuel = spec.mass.fuel;
    this.warnings = { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false,
      lowRotor: false, highRotor: false, overtorque: false, vrs: false, lowFuel: false,
      engineFail: false, engineFire: false, tailRotor: false };   // failure flags
    this.autopilot = { on: false, altitude: 0, heading: 0, speed: 0, mode: null, radar: false };   // altitude AGL when radar
    this.rotorRPM = 1; this.collective = 0; this.torque = 0;
    this.pendingThrottle = null;  // input.js lever sync request (adopted and cleared by the input module)
    // helicopter extras (HUD / avionics / audio / camera)
    this.stabilator = 0;          // deg trailing edge down
    this.stabilatorAuto = true;   // false = stabilator frozen at 0° (no schedule): pitch-up in the transition
    this.vibration = 0;           // 0..1 (ETL shudder, blade stall, overspeed)
    this.thrust = 0;              // N main rotor thrust
    this.power = 0;               // W total engine shaft power
    this.lights = { nav: true, strobe: true, beacon: true, landing: false, taxi: false };
    this.doors = 0;               // cabin doors (VisualState.canopy)
    this.afcs = new AFCS();
    // route following (src/nav): setRoute(route) attaches a Route, `nav` = LNAV guidance; the AFCS flies it in 'nav'
    this.route = null;
    this.nav = null;
    this._lnav = createLnav();
    this._navIn = { x: 0, z: 0, vx: 0, vz: 0, alt: 0, hdg: 0, category: 'helicopter', bankMax: 20 * DEG, rollTime: 1, onGround: true };
    this.mass = spec.mass.typical;
    this._payload = spec.mass.typical - spec.mass.empty - spec.mass.fuel;

    // ---- internal state ----
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._omega = this.angularVelocity;
    this._acc = 0;
    this._atm = { rho: 1.225, T: 288.15, a: 340.3, sigma: 1 };
    // aero scratch state/outputs
    this._s = { vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, Om: P.Om0, aLon: 0, aLat: 0, vi: 0, viT: 0, zHub: 1e9,
      rho: 1.225, aSnd: 340.3, col: 0, cLon: 0, cLat: 0, cPed: 0, stab: 0 };
    this._o = { fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0, T: 0, CT: 0, mu: 0, lam: 0, Vn: 0, u: 0, vh: 0, Pmr: 0, Qmr: 0,
      Ttr: 0, Ptr: 0, sev: 0, coning: 0, tgtLon: 0, tgtLat: 0, viss: 0, tauI: 0.1, vissT: 0, tauIT: 0.05, tauF: 0.07,
      Kb: 0, skew: 0, dTdcol: 0, dTtrdped: 0, wake: 0, thT: 0, stall: 0, nx: 0, ny: 1, nz: 0, vrs: 0 };
    this._sens = { theta: 0, phi: 0, psi: 0, p: 0, q: 0, r: 0, V: 0, u: 0, gsF: 0, gsR: 0, vz: 0, alt: 0, agl: 0, x: 0, z: 0, beta: 0,
      wow: 1, Bq: 1, Bp: 5, Br: 1, Acol: 15, torque: 0, nr: 1, collective: 0, onGround: true };
    this._pilot = { pitch: 0, roll: 0, yaw: 0, leverDelta: 0 };
    this._ctl = { cLon: 0, cLat: 0, cPed: 0, collective: NaN };
    this._engP = [0, 0];
    this._govI = 0;
    this._wow = 1;
    this._visual = null;
    this._vrsN = [0, 0, 0];
    this._dyn = false;

    this._buildContacts(contacts);
    // failures (CONTRACTS-SF.md §12)
    this._fire = [{ on: false, t: 0, delay: 30, handle: false, ext: 0 }, { on: false, t: 0, delay: 30, handle: false, ext: 0 }];
    this._trFail = '';             // '' | 'drive' | 'fixed' (tail rotor)
    this._trPed = 0;               // frozen tail-rotor pedal ('fixed')
    this.failInfo = { fireUnhandled: false, fireIndex: -1, restartable: false, relighting: false, gearAlt: false, gearAltOk: true, apuAvail: false, glideKt: 80 };
    this.failures = new FailureManager(this);
    this._resetInternals();
  }

  // ------------------------------------------------------------------------------------------------
  // setup
  // ------------------------------------------------------------------------------------------------
  _buildContacts(rigContacts) {
    const g = this.spec.gear;
    let list = (rigContacts || []).filter((c) => c && c.position).map((c) => ({
      name: c.name, kind: c.kind || (/tail/.test(c.name) ? 'tail' : /nose/.test(c.name) ? 'nose' : 'main'),
      p: new THREE.Vector3(c.position.x, c.position.y, c.position.z),
    }));
    const valid = (l) => {
      if (l.length < 3) return false;
      const shares = this._loadShares(l);
      return shares && shares.every((s) => s > 0.03 && s < 0.9);
    };
    if (!valid(list)) {
      list = g.contacts.map((c) => ({ name: c.name, kind: c.kind, p: new THREE.Vector3(...c.position) }));
    }
    this._contactsSrc = list;
    const shares = this._loadShares(list);
    this._shares = shares;
    this._hStatic = -Math.min(...list.map((c) => c.p.y));   // CG height above the lowest contact at static load
    const s0 = g.staticCompression, bump = 0.3;
    this._s0 = s0; this._bump = bump;
    this._wheels = list.map((c, i) => ({
      name: c.name, kind: c.kind, rDraw: c.p.clone(), r: new THREE.Vector3(c.p.x, c.p.y - s0, c.p.z),
      share: shares[i], k: 0, c: 0, contact: false, load: 0, comp: 0, brake: c.kind === 'main', castor: c.kind !== 'main',
    }));
    this._updateStruts();
    // structure points that must never touch the surface (body frame)
    const hub = this.P.hub, tp = this.P.tpos, RT = this.P.RT;
    this._structure = [
      { r: new THREE.Vector3(0, -1.0, -5.3), reason: 'Burun yere çarptı' },
      { r: new THREE.Vector3(0, -1.3, -0.5), reason: 'Gövde yere çarptı' },
      { r: new THREE.Vector3(0, -0.6, 5.0), reason: 'Kuyruk konisi yere çarptı' },
      { r: new THREE.Vector3(tp[0] + RT * this.P.tdy, tp[1] - RT * this.P.tdx, tp[2]), reason: 'Kuyruk rotoru yere çarptı' },
      { r: new THREE.Vector3(-2.2, -0.2, 8.8), reason: 'Stabilatör yere çarptı' },
      { r: new THREE.Vector3(2.2, -0.2, 8.8), reason: 'Stabilatör yere çarptı' },
      { r: new THREE.Vector3(0, hub[1] + 0.4, hub[2]), reason: 'Helikopter ters döndü' },
    ];
    this._reach = 11;
  }

  /** Static load share of each contact for the CG at the origin (3 contacts: exact; otherwise least squares). */
  _loadShares(list) {
    const n = list.length;
    if (n < 3) return null;
    if (n === 3) {
      const A = [1, 1, 1, list[0].p.x, list[1].p.x, list[2].p.x, list[0].p.z, list[1].p.z, list[2].p.z];
      const b = [1, 0, 0];
      if (!solveLinear(A, b, 3)) return null;
      return b;
    }
    // minimum-norm solution of the 3 equilibrium equations: s = M^T (M M^T)^-1 [1,0,0]
    const M = [list.map(() => 1), list.map((c) => c.p.x), list.map((c) => c.p.z)];
    const MMt = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) MMt.push(M[i].reduce((s, v, k) => s + v * M[j][k], 0));
    const y = [1, 0, 0];
    if (!solveLinear(MMt, y, 3)) return null;
    return list.map((_, k) => y[0] * M[0][k] + y[1] * M[1][k] + y[2] * M[2][k]);
  }

  _updateStruts() {
    const W = this.mass * G, s0 = this._s0, bump = this._bump;
    for (const w of this._wheels) {
      w.k = (w.share * W) / (s0 * (1 + (s0 / bump) ** 2));
      w.c = 2 * 0.7 * Math.sqrt(w.k * w.share * this.mass);
    }
  }

  _inertia() {
    const I = this.spec.inertia, f = this.mass / this.spec.mass.typical;
    return { x: I.pitch * f, y: I.yaw * f, z: I.roll * f };
  }

  /** Change the gross weight (kg, fuel kept); the payload absorbs the difference. */
  setMass(kg) {
    const m = clamp(kg, this.spec.mass.empty + 100, this.spec.mass.max + 500);
    this._payload = m - this.spec.mass.empty - this.fuel;
    this.mass = m;
    this._updateStruts();
    this._computeHoverTrim();
  }

  /** Engine failure (i = 0 or 1, or 'both'); failed = false restores it (failures.inject / clear). Emits 'warning' {type: 'engine', on}. */
  failEngine(i, failed = true) {
    if (failed) this.failures.inject(i === 'both' ? 'engineAll' : 'engine', { index: i === 'both' ? 0 : i });
    else this.failures.clear(i === 'both' ? undefined : this.failures.has('engineAll') ? 'engineAll' : 'engine');
    this._emit('warning', { type: 'engine', on: this.engines.some((e) => !e.running) });
  }

  // ---- failures.js hooks
  _failNormalize(kind, o) {
    const index = Number.isInteger(o.index) ? o.index : 0;
    switch (kind) {
      case 'engine': return index === 0 || index === 1 ? { index, restartable: false, cause: o.cause || 'failure' } : null;
      case 'engineAll': return { restartable: false, cause: o.cause || 'failure' };
      case 'fire': return index === 0 || index === 1 ? { index, delay: Number.isFinite(o.delay) ? Math.max(0, o.delay) : 30 } : null;
      case 'tailRotor': return { mode: o.mode === 'fixed' ? 'fixed' : 'drive' };
      default: return null;       // hydraulic / gear: not modelled on the UH-60 (fixed gear, transmission-driven hydraulics)
    }
  }
  _failApply(kind, o, on) {
    switch (kind) {
      case 'engine': this.engines[o.index].running = !on; if (!on) this.engines[o.index].cause = ''; else this.engines[o.index].cause = o.cause; break;
      case 'engineAll': for (const e of this.engines) { e.running = !on; e.cause = on ? o.cause : ''; } break;
      case 'fire':
        if (on) Object.assign(this._fire[o.index], { on: true, t: 0, delay: o.delay, handle: false, ext: 0 });
        else for (const f of this._fire) { f.on = false; f.handle = false; }
        break;
      case 'tailRotor': this._trFail = on ? o.mode : ''; this._trPed = this._s.cPed; break;
      default: break;
    }
    if (!on && !this.failures.active.size) {
      for (const e of this.engines) { e.running = true; e.cause = ''; }
      for (const f of this._fire) { f.on = false; f.handle = false; }
      this._trFail = '';
    }
    this._failInfo();
  }
  _failInfo() {
    const i = this._fire[0].on && !this._fire[0].handle ? 0 : this._fire[1].on && !this._fire[1].handle ? 1 : -1;
    this.failInfo.fireIndex = i; this.failInfo.fireUnhandled = i >= 0;
  }
  _failPhase() {
    if (this.crashed || this._contact) return 'parked';
    const V = Math.hypot(this.velocity.x, this.velocity.z), vs = this.velocity.y;
    if (this._airTime < 60 && this.agl < 150) return 'takeoff';
    if (vs < -2 && (this.agl < 300 || V < 25)) return 'approach';
    if (vs > 2.5) return 'climb';
    if (vs < -2.5) return 'descent';
    return 'cruise';
  }
  _failRandomOpts(kind, rng) {
    const out = this.engines.some((e) => !e.running);
    switch (kind) {
      case 'engine': if (out) return null; return rng ? { index: rng() < 0.5 ? 0 : 1 } : true;
      case 'engineAll': if (out) return null; return rng ? {} : true;
      case 'fire': if (out) return null; return rng ? { index: rng() < 0.5 ? 0 : 1 } : true;
      case 'tailRotor': if (this._trFail) return null; return rng ? { mode: rng() < 0.6 ? 'drive' : 'fixed' } : true;
      default: return null;
    }
  }
  /** Fire timers (per frame): the engine fails after the delay unless shut down; handle → agent → out after 4 s. */
  _failFrame(dt) {
    for (let i = 0; i < 2; i++) {
      const f = this._fire[i];
      if (!f.on) continue;
      f.t += dt;
      const e = this.engines[i];
      if (!f.handle && e.running && f.t >= f.delay) {
        e.running = false; e.cause = 'fire';
        this.failures._set('engine', { index: i, restartable: false, cause: 'fire' });
      }
      if (f.handle && (f.ext += dt) >= 4) { f.on = false; f.handle = false; this.failures._drop('fire', { extinguished: true }); this._failInfo(); }
    }
  }
  _failCommand(action) {
    if (action === 'fireHandle' || action === 'emergency') {
      const i = this._fire.findIndex((f) => f.on && !f.handle);
      if (i < 0) { this._emit('warning', { type: 'noEmergency', on: true }); return false; }
      const f = this._fire[i], e = this.engines[i];
      f.handle = true; f.ext = 0;
      if (e.running) { e.running = false; e.cause = 'shutdown'; this.failures._set('engine', { index: i, restartable: false, cause: 'shutdown' }); }
      this._emit('warning', { type: 'fireHandle', on: true, index: i });
      this._failInfo();
      return true;
    }
    return false;
  }

  on(event, cb) { (this._handlers[event] ||= []).push(cb); }
  _emit(event, info) { for (const cb of this._handlers[event] || []) cb(info); }

  _resetInternals() {
    const P = this.P;
    this.velocity.set(0, 0, 0);
    this._omega.set(0, 0, 0);
    this._acc = 0;
    this.crashed = false; this.crashReason = ''; this.crashCause = ''; this._lowColAt = -1e9;
    this.stalled = false; this.onGround = true;
    this._contact = true; this._airTime = 0; this._noContactTime = 0; this._groundTime = 0; this._takeoffArmed = true;
    this._gSmooth = 1; this._loadAcc = 0; this._loadN = 0;
    this._s.Om = P.Om0; this._s.aLon = 0; this._s.aLat = 0; this._s.vi = 0; this._s.viT = 0;
    this._col = 0; this._leverMode = 'direct'; this._leverHeld = 0; this._leverPrev = null; this._leverWritten = null;
    this._leverBefore = null; this._leverRestore = 0; this._leverWritable = true; this._syncLever = false;
    this._wow = 1; this._hitTimer = 0; this._pullUpTimer = 0;
    this._stepCount = 0;
    this._leverPickupPrev = null; this._surfCG = 0;
    for (const k of Object.keys(this.warnings)) if (this.warnings[k]) { this.warnings[k] = false; this._emit('warning', { type: k, on: false }); }
    for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
    this.afcs.disengage();
    this.autopilot.on = false; this.autopilot.mode = null;
  }

  // ------------------------------------------------------------------------------------------------
  // aerodynamics
  // ------------------------------------------------------------------------------------------------
  /** Main rotor with the given flapping/inflow states; writes forces/moments (body) and targets into o. */
  _mainRotorEval(aLon, aLat, vi) {
    const P = this.P, s = this._s, o = this._o;
    const Om = Math.max(s.Om, 0.5), OR = Om * P.R, rho = s.rho, rhoA = rho * P.A;
    const q0 = rhoA * OR * OR;
    const [hx, hy, hz] = P.hub;
    const vhx = s.vx + (s.wy * hz - s.wz * hy);
    const vhy = s.vy + (s.wz * hx - s.wx * hz);
    const vhz = s.vz + (s.wx * hy - s.wy * hx);
    const p = -s.wz, q = s.wx;
    // tip-path-plane normal
    const tl = Math.tan(aLon), tt = Math.tan(aLat);
    let nx = tt, ny = P.sy + tl * P.fy, nz = P.sz + tl * P.fz;
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const Vn = vhx * nx + vhy * ny + vhz * nz;
    const ipx = vhx - Vn * nx, ipy = vhy - Vn * ny, ipz = vhz - Vn * nz;
    const u = Math.hypot(ipx, ipy, ipz);
    const mu = u / OR, mu2 = mu * mu;
    const lam = (Vn + vi) / OR;
    const th75 = P.thMin + s.col * (P.thMax - P.thMin);
    const th0 = th75 - 0.75 * P.twist;
    const B = B_TIP, B2 = B * B, B3 = B2 * B, B4 = B2 * B2;
    const sa2 = 0.5 * P.sigma * P.a;
    let CT = sa2 * (th0 * (B3 / 3 + (B * mu2) / 2) + P.twist * (B4 / 4 + (B2 * mu2) / 4) - (lam * B2) / 2);
    // retreating-blade stall: soft thrust saturation above the (advance-ratio dependent) onset
    const onset = P.stallC0 - P.stallC2 * mu2 - P.stallC4 * mu2 * mu2;
    const CTs = CT / P.sigma;
    let sev = 0;
    if (CTs > onset) {
      const x = (CTs - onset) / P.stallW;
      sev = x;
      CT = P.sigma * (onset + P.stallW * Math.tanh(x));
    } else if (CTs < -0.08) {
      CT = P.sigma * (-0.08 - 0.02 * Math.tanh((-0.08 - CTs) / 0.02));
    }
    let T = q0 * CT;
    // vortex-ring state: unsteady recirculating wake → thrust fluctuations and uncommanded disc tilt (dynamic only)
    let vrs = 0;
    if (this._dyn && T > 0) {
      const vh0 = Math.sqrt(T / (2 * rhoA));
      const xv = Vn / vh0, mv = u / vh0;
      vrs = Math.max(0, 1 - Math.abs(xv + 1.1) / 0.8) * (1 - smoothstep(0.4, 1.0, mv));
      if (vrs > 0) T *= 1 + 0.15 * vrs * this._vrsN[0];
    }
    o.vrs = vrs;
    // inflow target (momentum theory + ground effect)
    const vh = Math.sqrt(Math.abs(T) / (2 * rhoA));
    let viss = 0;
    if (vh > 0.05) {
      const ge = groundEffect(s.zHub, P.R, u, vh);
      viss = T >= 0 ? vh * inducedRatio(Vn / vh, u / vh) * ge : -vh * inducedRatio(-Vn / vh, u / vh) * ge;
    }
    // flapping targets (disc tilt relative to the shaft: + forward, + right)
    const flapback = (2 * mu * ((4 / 3) * th0 + P.twist - lam)) / (1 - 0.5 * mu2);
    const Kb = P.Kb0 * (Om / P.Om0) ** 2;
    const coning = clamp(((T / P.Nb) * 0.7 * P.R - P.bladeMass * G * (P.R - P.e) * 0.5) / (P.Ib * Om * Om + Kb / P.Nb + 1), -0.04, 0.2);
    const lamI = vi / OR;
    const chi = Math.atan2(mu, Math.max(lam, 1e-3));
    const transverse = (4 / 3) * (1 - 1.8 * mu2) * Math.tan(chi / 2) * Math.max(lamI, 0);
    const sevC = Math.min(sev, 3);
    // retreating-blade stall: lift loss on the retreating (left) side → disc pitches up and rolls left (≤ 2°)
    const sevM = 2 * Math.tanh(sev / 2);
    const OmG = Math.max(Om, 0.3 * P.Om0);
    o.tgtLon = s.cLon * P.Blon - flapback + p / OmG - 0.017 * sevM;
    o.tgtLat = s.cLat * P.Blat + ((4 / 3) * mu * coning) / (1 + 0.5 * mu2) + Math.max(transverse, 0) + q / OmG - 0.014 * sevM;
    o.tauF = 16 / (P.lockBase * rho * OmG);
    if (vrs > 0) { o.tgtLon += 0.03 * vrs * this._vrsN[1]; o.tgtLat += 0.03 * vrs * this._vrsN[2]; }
    // slow rotor: the blades settle on the droop/anti-flap stops
    o.maxTilt = 0.03 + 0.42 * smoothstep(0.25, 0.7, Om / P.Om0);
    // profile power: blade loading, advancing-tip compressibility, stall
    const abar = (6 * CT) / (P.sigma * P.a);
    const Mat = ((1 + mu) * OR) / s.aSnd;
    const dM = Math.max(0, Mat - P.mdd);
    // stall adds a bounded drag increment: the stalled region is the slow retreating side of the disc
    const Cd = P.cd0 + P.cd2 * Math.min(abar * abar, 0.04) + P.kComp * dM * dM + 0.015 * Math.tanh(sev / 1.5);
    const CQ = CT * lam + ((P.sigma * Cd) / 8) * (1 + 4.65 * mu2);
    const Q = q0 * P.R * CQ;
    // forces: thrust along the TPP normal, H-force against the edgewise flow
    const Hf = (q0 * P.sigma * Cd * mu) / 4;
    let fx = T * nx, fy = T * ny, fz = T * nz;
    if (u > 1e-4) { fx -= (Hf * ipx) / u; fy -= (Hf * ipy) / u; fz -= (Hf * ipz) / u; }
    o.fx = fx; o.fy = fy; o.fz = fz;
    // moments: force at the hub + hinge-offset hub moment
    o.mx = hy * fz - hz * fy - Kb * aLon;
    o.my = hz * fx - hx * fz;
    o.mz = hx * fy - hy * fx - Kb * aLat;
    o.T = T; o.CT = T / q0; o.mu = mu; o.lam = lam; o.Vn = Vn; o.u = u; o.vh = vh; o.viss = viss;
    o.tauI = clamp(0.849 / (4 * Om * Math.max(Math.sqrt(mu2 + lam * lam), 0.02)), 0.02, 0.3);
    o.Pmr = Q * Om; o.Qmr = Q; o.sev = sev; o.coning = coning; o.Kb = Kb; o.nx = nx; o.ny = ny; o.nz = nz;
    o.skew = Vn + vi > 0.3 ? u / (Vn + vi) : 50;
    // control sensitivity for the AFCS: thrust per unit collective (with inflow relief)
    const dCTdth = sa2 * (B3 / 3 + (B * mu2) / 2);
    const relief = 1 / (1 + (sa2 * B2 * 0.5) / Math.max(2 * Math.sqrt(mu2 + lam * lam), 0.02));
    o.dTdcol = q0 * dCTdth * (P.thMax - P.thMin) * relief;
    o.stall = sevC;
  }

  /** Tail rotor with inflow state viT: adds force/moment into o (accumulate). */
  _tailRotorEval(viT) {
    const P = this.P, s = this._s, o = this._o;
    if (this._trFail === 'drive') {
      // tail-rotor drive failure: no thrust, no power (the main-rotor torque is no longer balanced)
      o.Ttr = 0; o.Ptr = 0; o.vissT = 0; o.thT = 0; o.tauIT = 0.05; o.dTtrdped = 1;
      return;
    }
    const Om = Math.max(s.Om, 0.5) * P.gearT, OR = Om * P.RT, rho = s.rho, rhoA = rho * P.AT;
    const q0 = rhoA * OR * OR;
    const [tx, ty, tz] = P.tpos;
    const dx = P.tdx, dy = P.tdy;
    const vtx = s.vx + (s.wy * tz - s.wz * ty);
    const vty = s.vy + (s.wz * tx - s.wx * tz);
    const vtz = s.vz + (s.wx * ty - s.wy * tx);
    const Vn = vtx * dx + vty * dy;
    const u = Math.hypot(vtx - Vn * dx, vty - Vn * dy, vtz);
    const mu = u / OR, mu2 = mu * mu;
    const lam = (Vn + viT) / OR;
    const thT = clamp(P.thT0 + P.thTmix * s.col - P.thTrange * s.cPed, P.thTmin, P.thTmax);
    const th0 = thT - 0.75 * P.twistT;
    const B = B_TIP, B2 = B * B, B3 = B2 * B, B4 = B2 * B2;
    const sa2 = 0.5 * P.sigmaT * P.aT;
    let CT = sa2 * (th0 * (B3 / 3 + (B * mu2) / 2) + P.twistT * (B4 / 4 + (B2 * mu2) / 4) - (lam * B2) / 2);
    const lim = 0.18 * P.sigmaT;
    if (Math.abs(CT) > lim) CT = Math.sign(CT) * (lim + 0.03 * P.sigmaT * Math.tanh((Math.abs(CT) - lim) / (0.03 * P.sigmaT)));
    const T = q0 * CT;
    const vh = Math.sqrt(Math.abs(T) / (2 * rhoA));
    let viss = 0;
    if (vh > 0.05) viss = T >= 0 ? vh * inducedRatio(Vn / vh, u / vh) : -vh * inducedRatio(-Vn / vh, u / vh);
    const abar = (6 * CT) / (P.sigmaT * P.aT);
    const Cd = P.cd0T + 0.3 * abar * abar;
    const CQ = CT * lam + ((P.sigmaT * Cd) / 8) * (1 + 4.65 * mu2);
    const fx = T * dx, fy = T * dy;
    o.fx += fx; o.fy += fy;
    o.mx += -tz * fy;
    o.my += tz * fx;
    o.mz += tx * fy - ty * fx;
    o.Ttr = T; o.Ptr = q0 * P.RT * CQ * Om; o.vissT = viss; o.thT = thT;
    o.tauIT = clamp(0.849 / (4 * Om * Math.max(Math.sqrt(mu2 + lam * lam), 0.02)), 0.01, 0.2);
    const dCT = sa2 * (B3 / 3) / (1 + (sa2 * B2 * 0.5) / Math.max(2 * Math.abs(lam), 0.03));
    o.dTtrdped = q0 * dCT * P.thTrange;
  }

  /** Fuselage, stabilator and fin (accumulate into o). */
  _airframeEval() {
    const P = this.P, s = this._s, o = this._o;
    const rho = s.rho;
    const vx = s.vx, vy = s.vy, vz = s.vz;
    const V = Math.hypot(vx, vy, vz);
    const hq = 0.5 * rho;
    // fuselage drag (equivalent flat-plate areas per axis) + rotor-wake download
    o.fx -= hq * P.fdx * V * vx;
    o.fy -= hq * P.fdy * V * vy;
    o.fz -= hq * P.fdz * V * vz;
    const dl = P.download * Math.max(o.T, 0) * Math.exp(-((o.u / Math.max(o.vh, 1)) ** 2));
    o.fy -= dl;
    // unstable fuselage moments
    if (V > 2) {
      const qbar = hq * V * V;
      const alpha = Math.atan2(-vy, -vz), beta = Math.asin(clamp(vx / V, -1, 1));
      o.mx += qbar * P.volP * 0.5 * Math.sin(2 * alpha) * smoothstep(2, 12, V);
      o.my += qbar * P.volY * 0.5 * Math.sin(2 * beta) * smoothstep(2, 12, V);
    }
    // stabilator (in the main-rotor wake at transition speeds)
    {
      const [x, y, z] = P.hpos;
      const tanChi = o.skew;
      const wake = smoothstep(0.35, 1.0, tanChi) * (1 - smoothstep(7, 14, tanChi));
      const w = 1.6 * Math.max(s.vi, 0) * wake;
      o.wake = wake;
      const lvy = vy + (s.wz * x - s.wx * z) + w;
      const lvz = vz + (s.wx * y - s.wy * x);
      const v2 = lvy * lvy + lvz * lvz;
      if (v2 > 0.01) {
        const vl = Math.sqrt(v2);
        const alpha = Math.atan2(-lvy, -lvz) + s.stab;
        surfaceCoefficients(alpha, P.CLah, 16 * DEG, P.ARh, _coef);
        const qd = hq * v2 * 0.9 * P.Sh;
        const L = qd * _coef.cl, D = qd * _coef.cd;
        const dy = lvy / vl, dz = lvz / vl;
        const fy = -D * dy + L * -dz, fz = -D * dz + L * dy;
        o.fy += fy; o.fz += fz;
        o.mx += y * fz - z * fy;
        o.my += -x * fz;
        o.mz += x * fy;
      }
    }
    // vertical fin (cambered: side force toward +X unloads the tail rotor in forward flight)
    {
      const [x, y, z] = P.vpos;
      const lvx = vx + (s.wy * z - s.wz * y);
      const lvz = vz + (s.wx * y - s.wy * x);
      const v2 = lvx * lvx + lvz * lvz;
      if (v2 > 0.01) {
        const vl = Math.sqrt(v2);
        const fwd = smoothstep(0, 0.5, -lvz / vl);
        const alpha = Math.atan2(lvx, -lvz) - P.finCamber * fwd;
        surfaceCoefficients(alpha, P.CLav, 18 * DEG, P.ARv, _coef);
        const qd = hq * v2 * 0.9 * P.Sv;
        const L = qd * _coef.cl, D = qd * _coef.cd;
        const dx = lvx / vl, dz = lvz / vl;
        const fx = -D * dx + L * dz, fz = -D * dz - L * dx;
        o.fx += fx; o.fz += fz;
        o.mx += y * fz;
        o.my += z * fx - x * fz;
        o.mz += -y * fx;
      }
    }
  }

  /**
   * Full aerodynamic evaluation. h > 0: dynamic (advances flapping and inflow states by h);
   * h = 0: steady state (flapping at its quasi-static value, inflow converged) for trimming.
   */
  _aero(h) {
    const s = this._s, o = this._o;
    const p = -s.wz, q = s.wx;
    this._dyn = h > 0;
    if (h > 0) {
      this._mainRotorEval(s.aLon, s.aLat, s.vi);
      this._tailRotorEval(s.viT);
      this._airframeEval();
      // advance rotor states (exact first-order updates)
      const kF = Math.exp(-h / o.tauF);
      const tLon = o.tgtLon + o.tauF * q, tLat = o.tgtLat - o.tauF * p;
      s.aLon = tLon + (s.aLon - tLon) * kF;
      s.aLat = tLat + (s.aLat - tLat) * kF;
      s.aLon = clamp(s.aLon, -o.maxTilt, o.maxTilt); s.aLat = clamp(s.aLat, -o.maxTilt, o.maxTilt);
      s.vi = o.viss + (s.vi - o.viss) * Math.exp(-h / o.tauI);
      s.viT = o.vissT + (s.viT - o.vissT) * Math.exp(-h / o.tauIT);
      return;
    }
    // steady state (no VRS unsteadiness)
    let aLon = s.aLon, aLat = s.aLat, vi = s.vi, viT = s.viT;
    for (let it = 0; it < 80; it++) {
      this._mainRotorEval(aLon, aLat, vi);
      const nLon = clamp(o.tgtLon + o.tauF * q, -0.45, 0.45), nLat = clamp(o.tgtLat - o.tauF * p, -0.45, 0.45);
      const dv = o.viss - vi;
      aLon = nLon; aLat = nLat; vi += 0.6 * dv;
      if (it > 5 && Math.abs(dv) < 1e-7) break;
    }
    for (let it = 0; it < 60; it++) {
      this._tailRotorEval(viT);
      const dv = o.vissT - viT;
      viT += 0.6 * dv;
      if (it > 5 && Math.abs(dv) < 1e-7) break;
    }
    s.aLon = aLon; s.aLat = aLat; s.vi = vi; s.viT = viT;
    this._mainRotorEval(aLon, aLat, vi);
    this._tailRotorEval(viT);
    this._airframeEval();
  }

  _stabilatorAngle(iasKt, collective, qDegS) {
    const P = this.P;
    if (!this.stabilatorAuto) return 0;
    let a = stabScheduleDeg(P.stabSched, iasKt) * DEG;
    const hi = smoothstep(25, 45, iasKt);
    a += hi * P.stabCol * (collective - 0.5);
    a += hi * P.stabQ * qDegS * DEG;
    return clamp(a, P.stabMin, P.stabMax);
  }

  // ------------------------------------------------------------------------------------------------
  // trim
  // ------------------------------------------------------------------------------------------------
  /**
   * Steady trim: solves collective, cyclic, pedal, pitch and roll so all accelerations vanish.
   * opts: { speed (m/s TAS, along the nose), climb (m/s), altitude (m MSL), zHub (hub height above the surface, for
   *         ground effect; default out of ground effect), turnRate (rad/s, coordinated) }
   * Returns { converged, collective, cLon, cLat, cPed, pitch, roll (rad), power (W shaft), torque, thrust, ... }.
   */
  trim(opts = {}) {
    const V = opts.speed || 0;
    if (!opts.guess && V > 20) {
      // continuation in airspeed from the hover solution (robust convergence at high speed), adaptive step
      let t = this._trimSolve({ ...opts, speed: 0 });
      let v = 0, dv = 5;
      while (v < V && t.converged) {
        const vn = Math.min(V, v + dv);
        const tn = this._trimSolve({ ...opts, speed: vn, guess: [t.collective, t.cLon, t.cLat, t.cPed, t.pitch, t.roll] });
        if (tn.converged) { t = tn; v = vn; dv = Math.min(dv * 1.5, 10); }
        else if (dv > 0.3) dv *= 0.4;
        else break;
      }
      // best converged solution; `speed` tells how far the continuation got (beyond the stall boundary: less than asked)
      if (v < V) { t = { ...t, converged: false, requestedSpeed: V }; }
      return t;
    }
    return this._trimSolve(opts);
  }

  _trimSolve(opts) {
    const P = this.P, s = this._s, o = this._o;
    const V = opts.speed || 0, climb = opts.climb || 0;
    isa(opts.altitude ?? 0, this._atm);
    const saved = { ...s };
    s.rho = this._atm.rho; s.aSnd = this._atm.a; s.Om = P.Om0; s.zHub = opts.zHub ?? 1e9;
    s.wx = 0; s.wy = 0; s.wz = 0;
    const m = this.mass;
    const I = this._inertia();
    const x = [0.6, 0, 0, 0, 3 * DEG, 0];     // collective, cLon, cLat, cPed, theta, phi
    if (opts.guess) for (let i = 0; i < 6; i++) x[i] = opts.guess[i];
    else if (V > 20) { x[1] = 0.4; x[4] = -2 * DEG; }
    const sq = Math.sqrt(this._atm.sigma);
    const res = new Float64Array(6);
    const evalRes = (xx, out) => {
      s.col = xx[0]; s.cLon = xx[1]; s.cLat = xx[2]; s.cPed = xx[3];
      const th = xx[4], ph = xx[5];
      _euler.set(th, 0, -ph, 'YXZ');
      _qTrim.setFromEuler(_euler);
      _qInv.copy(_qTrim).invert();
      _v1.set(0, climb, -V).applyQuaternion(_qInv);
      s.vx = _v1.x; s.vy = _v1.y; s.vz = _v1.z;
      s.stab = this._stabilatorAngle((Math.max(0, -_v1.z) * sq) / KT, xx[0], 0);
      this._aero(0);
      _v2.set(0, -m * G, 0).applyQuaternion(_qInv);   // gravity in body axes
      const Qsh = (o.Pmr) / P.Om0;                      // steady: shaft torque = aero torque
      const myS = -Qsh * P.sy, mzS = -Qsh * P.sz;
      out[0] = (o.fx + _v2.x) / m;
      out[1] = (o.fy + _v2.y) / m;
      out[2] = (o.fz + _v2.z) / m;
      out[3] = ((o.mx) / I.x) * 5;
      out[4] = ((o.my + myS) / I.y) * 5;
      out[5] = ((o.mz + mzS) / I.z) * 5;
      return out;
    };
    const J = new Float64Array(36), r0 = new Float64Array(6), r1 = new Float64Array(6), xx = new Float64Array(6);
    const step = [0.08, 0.1, 0.1, 0.1, 0.05, 0.05];
    let converged = false, err = 1e9;
    for (let iter = 0; iter < 60; iter++) {
      evalRes(x, r0);
      err = Math.hypot(...r0);
      if (err < 1e-6) { converged = true; break; }
      for (let j = 0; j < 6; j++) {
        for (let i = 0; i < 6; i++) xx[i] = x[i];
        const d = j < 4 ? 1e-4 : 1e-5;
        xx[j] += d;
        evalRes(xx, r1);
        for (let i = 0; i < 6; i++) J[i * 6 + j] = (r1[i] - r0[i]) / d;
      }
      const b = Array.from(r0, (v) => -v);
      const A = Array.from(J);
      if (!solveLinear(A, b, 6)) break;
      let scale = 1;
      for (let i = 0; i < 6; i++) scale = Math.min(scale, step[i] / Math.max(Math.abs(b[i]), 1e-12));
      // backtracking line search: never accept a step that increases the residual (keeps off the stalled branch)
      let accepted = false;
      for (let k = 0; k < 8; k++) {
        for (let i = 0; i < 6; i++) xx[i] = x[i] + b[i] * scale;
        xx[0] = clamp(xx[0], -0.1, 1.2);
        evalRes(xx, r1);
        if (Math.hypot(...r1) < err) { accepted = true; break; }
        scale *= 0.5;
      }
      for (let i = 0; i < 6; i++) x[i] = xx[i];
      if (!accepted && scale < 1e-3) break;
    }
    evalRes(x, res);
    const Pshaft = (o.Pmr + o.Ptr + P.Pacc) / P.eta;
    const out = {
      converged, error: err, speed: V, collective: x[0], cLon: x[1], cLat: x[2], cPed: x[3], pitch: x[4], roll: x[5],
      theta: x[4], phi: x[5],
      power: Pshaft, torque: Pshaft / P.Pxmsn, powerAvailable: 2 * P.Peng * Math.pow(this._atm.sigma, P.lapse),
      thrust: o.T, CTsigma: o.CT / P.sigma, mu: o.mu, tiltLon: s.aLon, tiltLat: s.aLat, vi: s.vi, viT: s.viT,
      tailThrust: o.Ttr, mainRotorPower: o.Pmr, tailRotorPower: o.Ptr, stabilator: s.stab / DEG, stall: o.sev,
      bodyVel: [s.vx, s.vy, s.vz],
    };
    // restore the dynamic state
    Object.assign(s, saved);
    return out;
  }

  _computeHoverTrim() {
    const t = this.trim({ speed: 0, altitude: 0 });
    const ht = this.afcs.hoverTrim;
    if (t.converged) { ht.cLon = t.cLon; ht.cLat = t.cLat; ht.cPed = t.cPed; ht.theta = t.pitch; ht.phi = t.roll; ht.collective = t.collective; }
    // trim pitch attitude vs airspeed (0…90 m/s) for the FPS airspeed hold, by continuation from the hover
    if (this._trimMass !== this.mass) {
      const tp = new Float64Array(19);
      let g = t.converged ? [t.collective, t.cLon, t.cLat, t.cPed, t.pitch, t.roll] : null;
      let last = t.pitch;
      for (let i = 0; i < tp.length; i++) {
        const ti = i === 0 ? t : this._trimSolve({ speed: i * 5, altitude: 0, guess: g });
        if (ti.converged) { g = [ti.collective, ti.cLon, ti.cLat, ti.cPed, ti.pitch, ti.roll]; last = ti.pitch; }
        tp[i] = last;
      }
      this.afcs.trimPitch = tp;
      this._trimMass = this.mass;
    }
    return t;
  }

  // ------------------------------------------------------------------------------------------------
  // reset
  // ------------------------------------------------------------------------------------------------
  /** start: { x, z, heading (rad), altitude? (m MSL: airborne trimmed at speed), speed? (m/s) } */
  reset(start, world) {
    const P = this.P, s = this._s;
    this.failures.reset();          // a new flight: no failures (missions inject after the reset)
    this._resetInternals();
    this.fuel = this.spec.mass.fuel;
    this.mass = this.spec.mass.empty + this._payload + this.fuel;
    for (const en of this.engines) en.running = true;
    this._updateStruts();
    this._computeHoverTrim();
    const heading = start.heading || 0;
    const x = start.x || 0, z = start.z || 0;
    this._world = world;
    const ground = this._groundAt(world, x, z);
    const airborne = start.altitude !== undefined && start.altitude !== null;
    if (!airborne) {
      // parked, rotor turning at 100 % NR, collective full down
      this._quat.setFromAxisAngle(_AXIS_Y, -heading);
      let g = ground;
      for (const w of this._wheels) {
        _v1.copy(w.rDraw).applyQuaternion(this._quat);
        g = Math.max(g, this._surfaceAt(world, x + _v1.x, z + _v1.z, 1e9));
      }
      this._pos.set(x, g + this._hStatic, z);
      this._col = 0;
      // collective full down: ask the input lever to follow (and hold it down until the lever comes back)
      this._leverMode = 'pickup'; this._leverHeld = 0; this._syncLever = true; this.pendingThrottle = 0;
      Object.assign(s, { Om: P.Om0, aLon: 0, aLat: 0, vi: 0, viT: 0, col: 0, cLon: this.afcs.hoverTrim.cLon, cLat: this.afcs.hoverTrim.cLat, cPed: 0 });
      this._initEnvAt(world);
      this.afcs.reset(null, heading);
      // settle the rotor states at flat pitch
      s.vx = 0; s.vy = 0; s.vz = 0; s.wx = 0; s.wy = 0; s.wz = 0; s.stab = this._stabilatorAngle(0, 0, 0);
      this._aero(0);
      this._contact = true; this.onGround = true; this._wow = 1;
      this._airTime = 0; this._groundTime = 5; this._takeoffArmed = true;
    } else {
      const speed = Math.max(0, start.speed || 0);
      const agl0 = start.altitude - ground;
      const alt = ground + Math.max(agl0, 20);
      const zHub = alt - ground + this.P.hub[1];
      let t = this.trim({ speed, altitude: alt, zHub });
      if (!t.converged && !(t.speed >= 0)) t = this.trim({ speed: 0, altitude: alt, zHub });
      const v0 = t.speed ?? speed;     // clipped to the trimmable speed (retreating-blade stall boundary)
      _euler.set(t.pitch, -heading, -t.roll, 'YXZ');
      this._quat.setFromEuler(_euler);
      this._pos.set(x, alt, z);
      this.velocity.set(Math.sin(heading), 0, -Math.cos(heading)).multiplyScalar(v0);
      Object.assign(s, { Om: P.Om0, col: t.collective, cLon: t.cLon, cLat: t.cLat, cPed: t.cPed });
      this._initEnvAt(world);
      // steady rotor states for the actual attitude
      _qInv.copy(this._quat).invert();
      _v1.copy(this.velocity).applyQuaternion(_qInv);
      s.vx = _v1.x; s.vy = _v1.y; s.vz = _v1.z; s.wx = 0; s.wy = 0; s.wz = 0;
      s.stab = this._stabilatorAngle((Math.max(0, -_v1.z) * Math.sqrt(this._atm.sigma)) / KT, t.collective, 0);
      this._aero(0);
      this._col = t.collective;
      this.afcs.reset({ cLon: t.cLon, cLat: t.cLat, cPed: t.cPed, theta: t.pitch, phi: t.roll, collective: t.collective, speed: Math.max(0, -_v1.z) }, heading);
      this._leverMode = 'pickup'; this._leverHeld = t.collective; this._syncLever = true; this.pendingThrottle = t.collective;
      this._contact = false; this.onGround = false; this._wow = 0;
      this._airTime = 5; this._noContactTime = 5; this._groundTime = 0; this._takeoffArmed = false;
      for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
    }
    // engines at the power the rotor needs
    const o = this._o;
    const need = Math.max(0, (o.Pmr + o.Ptr + P.Pacc) / P.eta);
    this._engP[0] = this._engP[1] = need / 2;
    this._govI = 0;
    this.power = need; this.torque = need / P.Pxmsn;
    this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
    this._updateReadouts(world, 1, 0);
    // an attached route is flown again from the new position
    if (this.route) { this.route.restart(this._pos.x, this._pos.z, heading); this._lnav.reset(); this._updateNav(0); }
  }

  _initEnvAt(world) {
    isa(this._pos.y, this._atm);
    this._s.rho = this._atm.rho; this._s.aSnd = this._atm.a;
    const hubY = this._pos.y + this.P.hub[1];
    this._surfCG = this._surfaceAt(world, this._pos.x, this._pos.z, this._pos.y - this._hStatic);
    this._s.zHub = hubY - this._surfCG;
  }

  // ------------------------------------------------------------------------------------------------
  // world queries
  // ------------------------------------------------------------------------------------------------
  _groundAt(world, x, z) {
    const g = world && world.getGroundHeight ? world.getGroundHeight(x, z) : 0;
    return Number.isFinite(g) ? g : 0;
  }

  /** Supporting surface under (x, z) for a point at height y: terrain/water, or an obstacle roof/deck the point is on or above. */
  _surfaceAt(world, x, z, y) {
    let h = this._groundAt(world, x, z);
    this._surfKind = world && world.isWater && world.isWater(x, z) && h <= 0.5 ? 'water' : 'ground';
    if (world && world.getObstacleHeight) {
      const o = world.getObstacleHeight(x, z);
      if (Number.isFinite(o) && o > h && y >= o - 1.2) { h = o; this._surfKind = 'obstacle'; }
    }
    return h;
  }

  // ------------------------------------------------------------------------------------------------
  // commands
  // ------------------------------------------------------------------------------------------------
  command(action) {
    if (this.crashed) return;
    switch (action) {
      case 'nav': this.engageNav(); break;
      case 'autopilot': {
        if (this.afcs.ap.on) { this.afcs.disengage(); this._leverMode = 'pickup'; this._leverHeld = this._col; this.pendingThrottle = this._col; }
        else if (!this.afcs.engage(this._sens)) { this._emit('autopilot', { on: false, mode: null, refused: true }); return; }
        this._syncAutopilot();
        this._emit('autopilot', { on: this.autopilot.on, mode: this.autopilot.mode });
        break;
      }
      case 'lights': this.lights.landing = !this.lights.landing; this.lights.taxi = this.lights.landing; break;
      case 'canopy': this.doors = this.doors > 0.5 ? 0 : 1; break;
      case 'sas': case 'afcs':
        this.afcs.enabled = !this.afcs.enabled;
        if (!this.afcs.enabled) { this.afcs.frozenLon = this._s.cLon; this.afcs.frozenLat = this._s.cLat; this.afcs.frozenPed = this._s.cPed; this.afcs.disengage(); }
        else { this.afcs.trimLon = this._s.cLon; this.afcs.trimLat = this._s.cLat; this.afcs.trimPed = this._s.cPed; this.afcs.thRef = this._sens.theta; this.afcs.phRef = this._sens.phi; }
        this._syncAutopilot();
        this._emit('afcs', { on: this.afcs.enabled });
        break;
      case 'stabilator': this.stabilatorAuto = !this.stabilatorAuto; break;
      case 'emergency': case 'fireHandle':
        if (action === 'emergency' && this._emergAt === this._stepCount) return false;   // one press per frame
        if (action === 'emergency') this._emergAt = this._stepCount;
        return this._failCommand(action);
      default: break;   // gear (fixed), flaps, speedbrake, reverser: not applicable
    }
  }

  // ------------------------------------------------------------------------------------------------
  // route (LNAV)
  // ------------------------------------------------------------------------------------------------
  /** Attach a src/nav/route.js Route (or null); the AFCS flies it in 'nav' mode and hovers at its last point. */
  setRoute(route) {
    this.route = route || null;
    this._lnav.reset();
    this.nav = null;
    this.afcs.nav = null;
    if (this.route) this._updateNav(0);
  }

  /** Fly the route ("Rotayı uç" on the map): engage the AFCS in nav, or switch the engaged hold to nav. */
  engageNav() {
    if (this.crashed || !this.route) return false;
    this._updateNav(0);
    const was = this.afcs.ap.on;
    if (this.route.active === 0) this.route.restartLeg();
    if (!this.afcs.engageNav(this._sens)) return false;
    this._syncAutopilot();
    if (!was) this._emit('autopilot', { on: true, mode: this.autopilot.mode });
    return true;
  }

  _updateNav(dt) {
    if (!this.route) return;
    const S = this._navIn;
    S.x = this._pos.x; S.z = this._pos.z; S.vx = this.velocity.x; S.vz = this.velocity.z; S.alt = this._pos.y;
    S.hdg = this.heading * DEG; S.onGround = this.onGround;
    this.nav = this._lnav.update(this.route, S, dt);
    this.afcs.nav = this.nav;
    // guided hover reached the route's last point: the route is complete, the hover hold stays
    const A = this.afcs;
    if (A.navHover && this.nav.valid && this.nav.hover && this.nav.dist < 3 && Math.hypot(S.vx, S.vz) < 1) {
      A.navHover = false;                  // plain hover hold on the point from here (xRef / zRef stay on it)
      this.route.sequence();
      this.nav = this._lnav.update(this.route, S, 0);
      this.afcs.nav = this.nav;
    }
  }

  _syncAutopilot() {
    const ap = this.afcs.ap, a = this.autopilot;
    a.on = ap.on; a.mode = ap.mode; a.altitude = ap.altitude; a.speed = ap.speed; a.radar = !!(ap.on && ap.radar);
    a.lnav = !!(ap.on && (ap.mode === 'nav' || this.afcs.navHover));
    a.heading = ((ap.heading / DEG) % 360 + 360) % 360;
  }

  // ------------------------------------------------------------------------------------------------
  // simulation
  // ------------------------------------------------------------------------------------------------
  step(dt, input, world) {
    if (this.crashed) return;
    this._world = world;
    this._acc += clamp(dt || 0, 0, MAX_FRAME_DT);
    this._loadAcc = 0; this._loadN = 0;
    const inp = input || {};
    this._handleLever(inp);
    this._updateNav(dt);
    const apWasOn = this.afcs.ap.on;
    while (this._acc >= H) {
      this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
      this._substep(H, inp, world);
      this._acc -= H;
      if (this.crashed) { this._acc = 0; break; }
    }
    if (apWasOn && !this.afcs.ap.on && !this.crashed) {
      // the FPS released the collective (weight on wheels, …): the lever takes over from the current collective
      this._leverMode = 'pickup'; this._leverHeld = this._col; this.pendingThrottle = this._col; this._syncLever = true;
      this._syncAutopilot();
      this._emit('autopilot', { on: false, mode: null });
    }
    if (this._loadN > 0) {
      const g = this._loadAcc / this._loadN;
      this._gSmooth += (g - this._gSmooth) * clamp(dt / 0.12, 0, 1);
    }
    this._backdriveLever(inp);
    if (!this.crashed) { this._failFrame(dt); this.failures.frame(dt); }
    this._updateReadouts(world, this.crashed ? 1 : this._acc / H, dt);
  }

  /** Collective lever: direct, pickup (after a reset / AP disengage) or coupled (altitude hold back-drives the lever). */
  _handleLever(inp) {
    const raw = Number.isFinite(inp.throttle) ? clamp(inp.throttle, 0, 1) : 0;
    let delta = 0;
    if (this._leverWritten !== null) {
      delta = raw - this._leverWritten;
      if (Math.abs(delta) > 1e-9 && this._leverBefore !== null && Math.abs(raw - this._leverBefore) < 1e-9) {
        if (++this._leverRestore >= 3) this._leverWritable = false;   // the input module does not keep written values
      } else if (Math.abs(delta) <= 1e-9) this._leverRestore = 0;
    } else if (this._leverPrev !== null) delta = raw - this._leverPrev;
    this._leverPrev = raw;
    this._leverWritten = null;
    this._lever = raw;
    this._pilot.leverDelta = 0;
    if (this.afcs.ap.on) {
      if (Math.abs(delta) > 0.12) {        // a big jump (preset key): the pilot takes the collective
        this.afcs.disengage(); this._syncAutopilot(); this._leverMode = 'direct';
        this._emit('autopilot', { on: false, mode: null });
      } else this._pilot.leverDelta = delta;
    } else if (this._leverMode === 'pickup') {
      const prev = this._leverPickupPrev ?? raw;
      const crossed = (prev - this._leverHeld) * (raw - this._leverHeld) <= 0;
      if (crossed || Math.abs(raw - this._leverHeld) < 0.015) this._leverMode = 'direct';
    }
    this._leverPickupPrev = raw;
  }

  _backdriveLever(inp) {
    const coupled = this.afcs.ap.on;
    if (!(coupled || this._syncLever) || !this._leverWritable) { this._syncLever = false; return; }
    const v = this._syncLever && !coupled ? this._leverHeld : this._col;
    try {
      this._leverBefore = this._lever;
      inp.throttle = v;
      this._leverWritten = inp.throttle === v ? v : null;
      if (this._leverWritten === null) this._leverWritable = false;
      else this._leverPickupPrev = v;          // the lever now sits at the written value
    } catch (e) { this._leverWritable = false; this._leverWritten = null; }
    this._syncLever = false;
  }

  _substep(h, inp, world) {
    const P = this.P, s = this._s, o = this._o;
    const m = this.mass;
    const pos = this._pos, quat = this._quat, vel = this.velocity, omega = this._omega;
    this._stepCount++;

    // ---- atmosphere & air data ----
    isa(pos.y, this._atm);
    s.rho = this._atm.rho; s.aSnd = this._atm.a;
    _qInv.copy(quat).invert();
    _vb.copy(vel).applyQuaternion(_qInv);
    const V = _vb.length();
    const e = _euler.setFromQuaternion(quat, 'YXZ');
    const theta = e.x, phi = -e.z, psi = -e.y;
    const p = -omega.z, q = omega.x, r = -omega.y;
    const sps = Math.sin(psi), cps = Math.cos(psi);
    const gsF = vel.x * sps - vel.z * cps, gsR = vel.x * cps + vel.z * sps;
    // pitot-static airspeed: the flow along the fuselage axis (≈ 0 in vertical flight / sideways / backwards)
    const iasKt = (Math.max(0, -_vb.z) * Math.sqrt(this._atm.sigma)) / KT;

    // surface below the hub (ground effect), AGL
    const hubY = pos.y + P.hub[1];
    const surf = this._surfaceAt(world, pos.x, pos.z, pos.y - this._hStatic);
    this._surfCG = surf;
    s.zHub = hubY - surf;
    const agl = pos.y - this._hStatic - surf;

    // ---- AFCS ----
    const S = this._sens;
    S.theta = theta; S.phi = phi; S.psi = psi; S.p = p; S.q = q; S.r = r; S.V = V; S.gsF = gsF; S.gsR = gsR;
    S.vz = vel.y; S.alt = pos.y; S.agl = agl; S.x = pos.x; S.z = pos.z;
    S.beta = V > 5 ? Math.asin(clamp(_vb.x / V, -1, 1)) : 0;
    S.u = Math.max(0, -_vb.z);
    S.wow = this._wow;
    const Mflap = o.Kb + Math.max(o.T, 0) * P.hub[1];
    const I = this._inertia();
    S.Bq = (Mflap * P.Blon) / I.x;
    S.Bp = (Mflap * P.Blat) / I.z;
    S.Br = (Math.max(o.dTtrdped, 1) * P.tdx * P.tpos[2]) / I.y;
    S.Acol = o.dTdcol / m;
    S.nr = s.Om / P.Om0;
    S.torque = this.torque;
    S.collective = this._col;
    S.onGround = this._contact;
    const pil = this._pilot;
    pil.pitch = clamp(inp.pitch || 0, -1, 1); pil.roll = clamp(inp.roll || 0, -1, 1); pil.yaw = clamp(inp.yaw || 0, -1, 1);
    const ctl = this.afcs.update(h, pil, S, this._ctl);
    pil.leverDelta = 0;
    // collective: coupled (AP), held (pickup) or the pilot's lever (servo rate limited)
    let colTarget;
    if (!Number.isNaN(ctl.collective)) colTarget = ctl.collective;
    else if (this._leverMode === 'pickup') colTarget = this._leverHeld;
    else colTarget = this._lever;
    this._col = moveToward(this._col, colTarget, h * 1.0);
    // actuators (fast first-order servos)
    const ks = 1 - Math.exp(-h / 0.04);
    s.cLon += (ctl.cLon - s.cLon) * ks;
    s.cLat += (ctl.cLat - s.cLat) * ks;
    s.cPed += (ctl.cPed - s.cPed) * ks;
    if (this._trFail === 'fixed') s.cPed = this._trPed;     // tail-rotor pitch frozen
    s.col = this._col;
    s.stab = moveToward(s.stab, this._stabilatorAngle(iasKt, this._col, q / DEG), h * 12 * DEG);

    // ---- aerodynamics ----
    s.vx = _vb.x; s.vy = _vb.y; s.vz = _vb.z; s.wx = omega.x; s.wy = omega.y; s.wz = omega.z;
    const tn = this._stepCount * H, TAU = 2 * Math.PI;   // deterministic pseudo-turbulence for the VRS
    this._vrsN[0] = (Math.sin(TAU * 1.3 * tn) + 0.7 * Math.sin(TAU * 2.9 * tn + 1) + 0.5 * Math.sin(TAU * 0.7 * tn + 2)) / 2.2;
    this._vrsN[1] = (Math.sin(TAU * 0.9 * tn + 0.5) + 0.6 * Math.sin(TAU * 2.3 * tn + 2.5)) / 1.6;
    this._vrsN[2] = (Math.sin(TAU * 1.1 * tn + 4) + 0.6 * Math.sin(TAU * 1.9 * tn + 1.2)) / 1.6;
    this._aero(h);

    // ---- engines, governor and rotor speed ----
    const Preq = o.Pmr + o.Ptr;
    const nr = s.Om / P.Om0;
    const avail = P.Peng * Math.pow(this._atm.sigma, P.lapse);
    const ff = Math.max(0, (Preq + P.Pacc) / P.eta) / 2;
    const err = 1 - nr;
    let dem = ff + (8 * err) * P.Peng + this._govI;
    const kE = 1 - Math.exp(-h / P.tauE);
    let Psh = 0;
    for (let i = 0; i < 2; i++) {
      const eng = this.engines[i];
      const running = eng.running && this.fuel > 0;
      const tgt = running ? clamp(dem, P.idle * P.Peng, avail) : 0;
      this._engP[i] += (tgt - this._engP[i]) * (running ? kE : 1 - Math.exp(-h / 2));
      Psh += this._engP[i];
    }
    const saturatedHigh = dem > avail && err > 0, saturatedLow = dem < P.idle * P.Peng && err < 0;
    if (!saturatedHigh && !saturatedLow) this._govI = clamp(this._govI + 4 * err * P.Peng * h, -P.Peng, P.Peng);
    const Pnet = P.eta * Psh - P.Pacc - Preq;
    const OmPrev = Math.max(s.Om, 2);
    s.Om = Math.max(0, s.Om + (Pnet / (P.IR * OmPrev)) * h);
    // shaft torque on the main rotor reacts on the airframe (rotor turns CCW seen from above)
    const Qsh = (P.eta * Psh - P.Pacc - o.Ptr) / OmPrev;
    o.my -= Qsh * P.sy;
    o.mz -= Qsh * P.sz;
    this.power = Psh;
    this.torque = (Psh * P.Om0) / (OmPrev * P.Pxmsn);
    // fuel
    let ffTot = 0;
    for (let i = 0; i < 2; i++) {
      const f = this._engP[i] > 1 ? P.ffIdle + (P.ffMax - P.ffIdle) * (this._engP[i] / P.Peng) : 0;
      this.engines[i].fuelFlow = f;
      ffTot += f;
    }
    if (this.fuel > 0) { this.fuel = Math.max(0, this.fuel - (ffTot / 3600) * h); this.mass = this.spec.mass.empty + this._payload + this.fuel; }

    // ---- forces to world ----
    _Fw.set(o.fx, o.fy, o.fz).applyQuaternion(quat);
    _Tw.set(0, 0, 0);
    _up.set(0, 1, 0).applyQuaternion(quat);
    _fwd.set(0, 0, -1).applyQuaternion(quat);

    // ---- ground contact & collisions ----
    if (this._ground(h, inp, world, V)) return;
    if (this._collisions(h, world)) return;

    // ---- load factor ----
    this._loadAcc += _Fw.dot(_up) / (m * G);
    this._loadN++;

    // ---- integrate translation ----
    vel.addScaledVector(_Fw, h / m);
    vel.y -= G * h;
    if (this._stuck) {
      vel.x = 0; vel.z = 0;
      _omegaW.copy(omega).applyQuaternion(quat); _omegaW.y = 0;
      omega.copy(_omegaW.applyQuaternion(_qInv));
    }
    pos.addScaledVector(vel, h);

    // ---- rotation (body frame, Euler's equations, diagonal inertia) ----
    _Tw.applyQuaternion(_qInv);
    const Mx = o.mx + _Tw.x, My = o.my + _Tw.y, Mz = o.mz + _Tw.z;
    const Ix = I.x, Iy = I.y, Iz = I.z;
    const wx = omega.x, wy = omega.y, wz = omega.z;
    const gx = wy * (Iz * wz) - wz * (Iy * wy);
    const gy = wz * (Ix * wx) - wx * (Iz * wz);
    const gz = wx * (Iy * wy) - wy * (Ix * wx);
    const damp = this._contact ? 0.3 : 0.02;
    omega.x += ((Mx - gx) / Ix - damp * wx) * h;
    omega.y += ((My - gy) / Iy - damp * wy) * h;
    omega.z += ((Mz - gz) / Iz - damp * wz) * h;
    if (this._stuck) {   // held by the tyres: no yawing either
      _omegaW.copy(omega).applyQuaternion(quat); _omegaW.y = 0;
      omega.copy(_omegaW.applyQuaternion(_qInv));
    }
    if (omega.lengthSq() > 36) omega.setLength(6);
    const ang = omega.length() * h;
    if (ang > 1e-12) {
      _dq.setFromAxisAngle(_v1.copy(omega).normalize(), ang);
      quat.multiply(_dq).normalize();
    }
    if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z + omega.x + omega.y + omega.z + s.Om + s.vi)) this._crash('Sayısal hata', 'num');
  }

  /** Wheels, stiction, touchdown/takeoff events. Returns true if crashed. */
  _ground(h, inp, world, V) {
    const P = this.P, gear = this.spec.gear, m = this.mass;
    const pos = this._pos, quat = this._quat, vel = this.velocity, omega = this._omega;
    const nearGround = pos.y - this._surfCG < this._reach + 4 || this._contact;
    this._stuck = false;
    let anyContact = false, wheelsDown = 0, capLong = 0, capLat = 0, capYaw = 0, totalLoad = 0;
    _omegaW.copy(omega).applyQuaternion(quat);
    _Ffric.set(0, 0, 0); _Tfric.set(0, 0, 0);
    if (nearGround) {
      if (this._checkStructure(world)) return true;
      const brake = clamp(Number(inp.brake) || 0, 0, 1);
      this.brakes = brake;
      const groundSpeed = Math.hypot(vel.x, vel.z);
      const tailFree = Math.abs(inp.yaw || 0) > 0.2 && groundSpeed < 8;
      for (const w of this._wheels) {
        w.contact = false; w.load = 0; w.comp = 0;
        _rw.copy(w.r).applyQuaternion(quat);
        _pw.copy(pos).add(_rw);
        const gh = this._surfaceAt(world, _pw.x, _pw.z, _pw.y + 0.3);
        const pen = gh - _pw.y;
        if (pen <= 0) continue;
        if (this._surfKind === 'water') { this._crash('Helikopter suya düştü'); return true; }
        if (this._surfKind === 'obstacle') _n.set(0, 1, 0);
        else this._groundNormal(world, _pw.x, _pw.z, gh, _n);
        if (_n.y < 0.5) { this._crash('Helikopter yamaca çarptı'); return true; }
        const d = pen * _n.y;
        if (d > this._s0 + gear.stroke) { this._crash('İniş takımı çöktü'); return true; }
        _vc.crossVectors(_omegaW, _rw).add(vel);
        const vn = _vc.dot(_n);
        let N = w.k * d * (1 + (d / this._bump) ** 2) - w.c * vn;
        N = clamp(N, 0, 20 * m * G);
        w.contact = true; w.load = N; w.comp = clamp(d / (this._s0 + gear.stroke), 0, 1);
        anyContact = true; wheelsDown++; totalLoad += N;
        _wf.copy(_fwd).addScaledVector(_n, -_fwd.dot(_n)).normalize();
        _wl.crossVectors(_wf, _n);
        const vLong = _vc.dot(_wf), vLat = _vc.dot(_wl);
        const onRunway = world && world.isOnRunway ? world.isOnRunway(_pw.x, _pw.z) : true;
        let mu = this._surfKind === 'obstacle' || onRunway ? gear.rollingFriction : gear.rollingFrictionRough;
        if (w.brake) mu += gear.brakeFriction * brake;
        const muLat = w.castor ? (tailFree ? 0.04 : 0.45) : gear.lateralFriction;
        const fLong = -clamp(vLong * 30000, -mu * N, mu * N);
        const fLat = -clamp(vLat * 30000, -muLat * N, muLat * N);
        capLong += mu * N; capLat += muLat * N; capYaw += muLat * N * Math.hypot(w.r.x, w.r.z);
        _v1.copy(_n).multiplyScalar(N);
        _Fw.add(_v1);
        _Tw.add(_v2.crossVectors(_rw, _v1));
        _v1.copy(_wf).multiplyScalar(fLong).addScaledVector(_wl, fLat);
        _Ffric.add(_v1);
        _Tfric.add(_v2.crossVectors(_rw, _v1));
      }
    } else {
      for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
    }

    // weight on wheels (AFCS ground mode)
    const wowTarget = anyContact && totalLoad > 0.25 * m * G ? 1 : 0;
    this._wow = moveToward(this._wow, wowTarget, h * 3);

    // ---- events on first contact ----
    const e = _euler.setFromQuaternion(quat, 'YXZ');
    const pitchDeg = e.x / DEG, rollDeg = -e.z / DEG;
    if (anyContact && !this._contact) {
      const vs = vel.y;
      if (vs < -gear.hardLanding) { this._crash('Çok sert iniş'); return true; }
      if (Math.abs(rollDeg) > 20) { this._crash('Yan yatarak yere çarptı (dinamik devrilme)'); return true; }
      if (pitchDeg > 25) { this._crash('Kuyruk yere çarptı'); return true; }
      if (pitchDeg < -15) { this._crash('Burun yere çarptı'); return true; }
      if (this._airTime > 1) {
        this._emit('touchdown', {
          verticalSpeed: vs, onRunway: world && world.isOnRunway ? world.isOnRunway(pos.x, pos.z) : false,
          pitch: pitchDeg, roll: rollDeg, groundSpeed: Math.hypot(vel.x, vel.z),
        });
        if (this.afcs.ap.on && !this.afcs.isLanding()) this.afcs.disengage();   // handed over in step()
      }
      this._airTime = 0;
    }
    if (anyContact && (Math.abs(rollDeg) > 32 || pitchDeg > 30 || pitchDeg < -25)) { this._crash('Helikopter devrildi (dinamik devrilme)'); return true; }
    const aglNow = this._aglCG;
    if (anyContact) {
      this._noContactTime = 0;
      this._groundTime += h;
      if (this._groundTime > 1 && this._wow > 0.9) this._takeoffArmed = true;   // settled on the wheels (not a bounce)
    } else {
      this._noContactTime += h;
      this._groundTime = 0;
      if (aglNow > 0.5) this._airTime += h;
      if (this._takeoffArmed && this._noContactTime > 0.5 && aglNow > 0.5) {
        this._takeoffArmed = false;
        this._emit('takeoff', { x: pos.x, z: pos.z, airspeed: V });
      }
    }
    this._contact = anyContact;

    // ---- static friction: at rest the tyres hold the aircraft (forces and yaw moment) ----
    if (wheelsDown === this._wheels.length && Math.hypot(vel.x, vel.z) < 0.05 && Math.abs(vel.y) < 0.3 && omega.lengthSq() < 0.0025) {
      _v1.copy(_Fw); _v1.y -= m * G;
      _wf.copy(_fwd); _wf.y = 0; _wf.normalize();
      _wl.set(-_wf.z, 0, _wf.x);
      const o = this._o;
      _v3.set(o.mx, o.my, o.mz).applyQuaternion(quat);
      const yawM = _v3.y + _Tw.y;
      this._stuck = Math.abs(_v1.dot(_wf)) < capLong && Math.abs(_v1.dot(_wl)) < capLat && Math.abs(yawM) < capYaw;
    }
    if (!this._stuck) { _Fw.add(_Ffric); _Tw.add(_Tfric); }
    return false;
  }

  /** Airframe structure and main-rotor tip path vs terrain / roofs. */
  _checkStructure(world) {
    const P = this.P, s = this._s;
    _v3.set(0, 1, 0).applyQuaternion(this._quat);
    const tipped = this._contact && _v3.y < Math.cos(25 * DEG);    // on the wheels and past 25° of tilt: rolling over
    for (const st of this._structure) {
      _pw.copy(st.r).applyQuaternion(this._quat).add(this._pos);
      const gh = this._surfaceAt(world, _pw.x, _pw.z, _pw.y + 0.5);
      if (_pw.y < gh) {
        this._crash(this._surfKind === 'water' ? 'Helikopter suya düştü' : tipped ? 'Helikopter devrildi (dinamik devrilme)' : st.reason,
          this._surfKind === 'obstacle' ? 'obstacle' : 'ground');
        return true;
      }
    }
    // main rotor tip path (12 points on the coned, tilted disc)
    const hubY = this._pos.y + P.hub[1];
    if (hubY - this._surfCG < P.R + 25 && (this._stepCount & 1) === 0) {
      this._discFrame();
      const lift = Math.sin(this._o.coning) * P.R;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        _pw.copy(this._hubW).addScaledVector(_e1, Math.cos(a) * P.R * 0.98).addScaledVector(_e2, Math.sin(a) * P.R * 0.98).addScaledVector(_n, lift);
        const gh = this._surfaceAt(world, _pw.x, _pw.z, _pw.y + 0.3);
        if (_pw.y < gh) {
          this._crash(this._surfKind === 'water' ? 'Ana rotor suya çarptı' : this._surfKind === 'obstacle' ? 'Ana rotor binaya çarptı'
            : tipped ? 'Helikopter devrildi (dinamik devrilme)' : 'Ana rotor yere çarptı', this._surfKind === 'obstacle' ? 'obstacle' : 'ground');
          return true;
        }
      }
    }
    return false;
  }

  _discFrame() {
    const P = this.P, s = this._s;
    if (!this._hubW) this._hubW = new THREE.Vector3();
    this._hubW.set(P.hub[0], P.hub[1], P.hub[2]).applyQuaternion(this._quat).add(this._pos);
    const tl = Math.tan(s.aLon), tt = Math.tan(s.aLat);
    _n.set(tt, P.sy + tl * P.fy, P.sz + tl * P.fz).normalize().applyQuaternion(this._quat);
    _e1.set(1, 0, 0).applyQuaternion(this._quat);
    _e1.addScaledVector(_n, -_e1.dot(_n)).normalize();
    _e2.crossVectors(_n, _e1);
  }

  /** Obstacles (buildings, bridges, towers): rotor disc and airframe spheres via world.hitTest (≈ 60 Hz). */
  _collisions(h, world) {
    if (!world || !world.hitTest) return false;
    this._hitTimer -= h;
    if (this._hitTimer > 0) return false;
    this._hitTimer = 1 / 60;
    const P = this.P;
    this._discFrame();
    const hub = this._hubW;
    const broad = world.hitTest(hub.x, hub.y - 0.8, hub.z, P.R + 1.2);
    if (!broad) return false;
    const lift = Math.sin(this._o.coning) * P.R;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const f of RIM_FRACTIONS) {
        if (f < 0.5 && i % 2) continue;
        _pw.copy(hub).addScaledVector(_e1, Math.cos(a) * P.R * f).addScaledVector(_e2, Math.sin(a) * P.R * f).addScaledVector(_n, lift * f);
        const hit = world.hitTest(_pw.x, _pw.y, _pw.z, 0.6);
        if (hit) { this._crash(`Ana rotor çarpması: ${hit}`, 'obstacle'); return true; }
      }
    }
    const parts = this._hitParts || (this._hitParts = [
      { r: new THREE.Vector3(0, 0.1, -0.5), rad: 1.3, label: 'Gövde çarpması' },
      { r: new THREE.Vector3(0, -0.2, -4.4), rad: 1.0, label: 'Gövde çarpması' },
      { r: new THREE.Vector3(0, 0.6, 4.5), rad: 0.8, label: 'Kuyruk çarpması' },
      { r: new THREE.Vector3(P.tpos[0], P.tpos[1], P.tpos[2]), rad: P.RT + 0.1, label: 'Kuyruk rotoru çarpması' },
    ]);
    for (const part of parts) {
      _pw.copy(part.r).applyQuaternion(this._quat).add(this._pos);
      const hit = world.hitTest(_pw.x, _pw.y, _pw.z, part.rad);
      if (hit) { this._crash(`${part.label}: ${hit}`, 'obstacle'); return true; }
    }
    return false;
  }

  _groundNormal(world, x, z, h0, out) {
    const hx = this._groundAt(world, x + 0.5, z) - h0;
    const hz = this._groundAt(world, x, z + 0.5) - h0;
    return out.set(-hx / 0.5, 1, -hz / 0.5).normalize();
  }

  /** kind: 'ground' (terrain / water / roof contact), 'obstacle' (world.hitTest, roofs), 'num'. */
  _crash(reason, kind = 'ground') {
    if (this.crashed) return;
    // the collective lowered to the bottom (in the last 6 s, engines running) into a hard impact (ground, water, falling
    // onto a building) names the real cause first: "Kolektif çok düşük, çok sert iniş" (src/ui/hints.js explains it)
    let cause = '';
    if (kind !== 'num' && this._stepCount * H - this._lowColAt < 6 && this.velocity.y < -2.5 && this.fuel > 0 && this.engines.every((e) => e.running)) {
      cause = 'collective';
      reason = `Kolektif çok düşük, ${reason.charAt(0).toLocaleLowerCase('tr')}${reason.slice(1)}`;
    }
    this.crashed = true;
    this.crashReason = reason;
    this.crashCause = cause;
    this.velocity.set(0, 0, 0);
    this._omega.set(0, 0, 0);
    this.afcs.disengage();
    this._syncAutopilot();
    this._emit('crash', { reason, cause, position: this._pos.clone() });
  }

  // ------------------------------------------------------------------------------------------------
  // readouts
  // ------------------------------------------------------------------------------------------------
  _updateReadouts(world, alpha, dt) {
    const P = this.P, s = this._s, o = this._o;
    this.position.lerpVectors(this._prevPos, this._pos, alpha);
    this.quaternion.slerpQuaternions(this._prevQuat, this._quat, alpha);
    const V = this.velocity.length();
    this.airspeed = V;
    _qInv.copy(this._quat).invert();
    _vb.copy(this.velocity).applyQuaternion(_qInv);
    this.ias = Math.max(0, -_vb.z) * Math.sqrt(this._atm.sigma);   // pitot-static (forward axis) airspeed
    this.mach = V / this._atm.a;
    this.altitude = this.position.y;
    const surf = this._surfaceAt(world, this._pos.x, this._pos.z, this._pos.y - this._hStatic);
    this._aglCG = this._pos.y - this._hStatic - surf;
    this.agl = Math.max(0, this._aglCG);
    const e = _euler.setFromQuaternion(this._quat, 'YXZ');
    this.heading = ((-e.y / DEG) % 360 + 360) % 360;
    this.pitch = e.x / DEG;
    this.roll = -e.z / DEG;
    this.verticalSpeed = this.velocity.y;
    this.gForce = this._gSmooth;
    this.collective = this._col;
    this.throttle = this._col;
    this.rotorRPM = s.Om / P.Om0;
    this.aileron = s.cLat; this.elevator = -s.cLon; this.rudder = s.cPed;
    this.onGround = this._contact;
    this.thrust = o.T;
    this.stabilator = s.stab / DEG;
    this.aoa = V > 10 ? Math.atan2(-_vb.y, -_vb.z) / DEG : 0;
    this.sideslip = V > 5 ? Math.asin(clamp(_vb.x / V, -1, 1)) / DEG : 0;
    this.stalled = !this._contact && o.sev > 0.3;
    for (let i = 0; i < 2; i++) {
      const en = this.engines[i];
      const f = this._engP[i] / P.Peng;
      en.power = this._engP[i];
      en.torque = (this._engP[i] * P.Om0) / (Math.max(s.Om, 2) * (P.Pxmsn / 2));
      en.n1 = en.running && this.fuel > 0 ? clamp(0.63 + 0.37 * Math.pow(clamp(f, 0, 1.2), 0.6), 0, 1.05) : Math.max(0, en.n1 - dt * 0.2);
      en.thrust = 0;
    }
    // vibration: ETL shudder (10–25 kt), blade stall, advancing-tip Mach / VNE
    const kt = this.ias / KT;
    const etl = Math.exp(-(((kt - 16) / 7) ** 2)) * 0.35 * (this._contact ? 0 : 1);
    this.vibration = clamp(etl + 0.35 * o.stall + 0.6 * o.vrs + 0.5 * smoothstep(P.vne * 0.95, P.vne * 1.08, this.ias), 0, 1);
    this._syncAutopilot();
    if (dt > 0) this._updateWarnings(world, dt);
  }

  _updateWarnings(world, dt) {
    const P = this.P, w = this.warnings, o = this._o;
    const set = (k, v) => { if (w[k] !== v) { w[k] = v; this._emit('warning', { type: k, on: v }); } };
    const air = !this._contact;
    const nr = this.rotorRPM;
    // LOW ROTOR RPM warning light + tone below 96 % NR (TM 1-1520-237-10); NR above the limit: 107 % power on, 110 %
    // power off (autorotation, engines not driving) — the UH-60 has no high-rotor light or tone, the flag is for displays
    set('lowRotor', nr < (w.lowRotor ? 0.97 : 0.96) && (air || this._col > 0.2));
    const nrMax = this.torque < 0.15 ? 1.10 : 1.07;
    set('highRotor', nr > (w.highRotor ? nrMax - 0.01 : nrMax));
    // collective at the bottom while airborne (crash cause, see _crash)
    if (air && this.agl > 2 && this._col < 0.2) this._lowColAt = this._stepCount * H;
    set('overtorque', this.torque > (w.overtorque ? 0.99 : 1.0));
    set('stall', this.stalled);
    set('overspeed', this.ias > P.vne);
    set('bank', air && Math.abs(this.roll) > 60);
    const vs = this.verticalSpeed, gs = Math.hypot(this.velocity.x, this.velocity.z);
    set('sinkRate', air && ((this.agl < 30 && vs < -4 && gs < 25) || (this.agl < 300 && vs < -12)));
    const x = o.vh > 1 ? o.Vn / o.vh : 0;
    set('vrs', air && x < -0.5 && x > -1.7 && o.u / Math.max(o.vh, 1) < 1.0 && vs < -3);
    set('lowFuel', this.fuel < 0.1 * this.spec.mass.fuel);
    set('engineFail', !this.engines[0].running || !this.engines[1].running);
    set('engineFire', this._fire[0].on || this._fire[1].on);
    set('tailRotor', !!this._trFail);
    // pull up: terrain / obstacle look-ahead along the velocity (not in slow landing configurations)
    this._pullUpTimer -= dt;
    if (this._pullUpTimer <= 0) {
      this._pullUpTimer = 0.25;
      let danger = false;
      if (air && (gs > 20 || vs < -8) && world) {
        for (const t of [2, 4, 6, 9]) {
          const px = this._pos.x + this.velocity.x * t, pz = this._pos.z + this.velocity.z * t;
          const py = this._pos.y + this.velocity.y * t - this._hStatic;
          let hgt = this._groundAt(world, px, pz);
          if (world.getObstacleHeight) { const ob = world.getObstacleHeight(px, pz); if (Number.isFinite(ob)) hgt = Math.max(hgt, ob); }
          if (py < hgt + 8) { danger = true; break; }
        }
      }
      set('pullUp', danger);
    }
  }

  getVisualState() {
    const P = this.P, s = this._s;
    const v = this._visual || (this._visual = {
      time: 0, airspeed: 0, mach: 0, onGround: true, aoa: 0, aileron: 0, elevator: 0, rudder: 0, flaps: 0, slats: 0, spoilers: 0,
      speedbrake: 0, gear: 1, gearCompression: this._wheels.map(() => 0), wheelSpeed: 0,
      engines: [0, 1].map(() => ({ n1: 0, throttle: 0, afterburner: 0, nozzle: 0, reverser: 0 })),
      tvc: { pitch: 0, yaw: 0 },
      rotor: { rpm: 1, collective: 0, cyclicX: 0, cyclicY: 0, pedal: 0, omega: P.Om0, tailOmega: P.Om0 * P.gearT, coning: 0, tiltLon: 0, tiltLat: 0 },
      canopy: 0, lights: this.lights, stabilator: 0, vibration: 0,
    });
    v.time = this._stepCount * H;
    v.airspeed = this.airspeed; v.mach = this.mach; v.onGround = this.onGround; v.aoa = this.aoa;
    v.aileron = this.aileron; v.elevator = this.elevator; v.rudder = this.rudder;
    for (let i = 0; i < this._wheels.length; i++) v.gearCompression[i] = this._wheels[i].comp;
    v.wheelSpeed = this._contact ? Math.hypot(this.velocity.x, this.velocity.z) : 0;
    for (let i = 0; i < 2; i++) { v.engines[i].n1 = this.engines[i].n1; v.engines[i].throttle = this._col; }
    const rt = v.rotor;
    rt.rpm = this.rotorRPM; rt.collective = this._col; rt.cyclicX = s.cLat; rt.cyclicY = -s.cLon; rt.pedal = s.cPed;
    rt.omega = s.Om; rt.tailOmega = s.Om * P.gearT; rt.coning = this._o.coning; rt.tiltLon = s.aLon; rt.tiltLat = s.aLat;
    v.canopy = this.doors;
    v.stabilator = s.stab;
    v.vibration = this.vibration;
    return v;
  }
}
