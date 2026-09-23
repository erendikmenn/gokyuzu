// Fixed-wing flight model (P1): a 6-DOF rigid body parameterized entirely by `spec` (src/aircraft/<id>/spec.js).
//
//   createFixedWingModel(spec, { contacts }) -> FlightModel (CONTRACTS-SF.md §6.3)
//
// Physics: body-axis forces and moments integrated with fixed sub-steps (spec.substep, default 1/240 s; semi-implicit
// Euler, frames of up to 0.25 s are split, the rendered pose is interpolated between the last two sub-steps).
//   - ISA atmosphere, CAS/Mach, lift curve with flap/slat increments, rounded stall, post-stall toward the flat plate,
//     drag polar (Mach tables, transonic wave drag, leading-edge suction loss at high AoA, gear/spoilers/speedbrake),
//     ground effect, sideslip, stability & damping derivatives (fixedwing-aero.js)
//   - turbofans with spool dynamics, thrust lapse tables, afterburner, reversers, fuel flow (fixedwing-engine.js)
//   - flight control laws: F-16 / F-22 FBW, A320 normal law, 737 conventional + assist (fixedwing-fcs.js)
//   - autopilot / autothrust / ILS approach & autoland (fixedwing-autopilot.js); route following (LNAV, src/nav/lnav.js):
//     setRoute(route) attaches a src/nav/route.js Route, `nav` is the guidance (active leg, distance, bearing…)
//   - systems here: gear, flaps (real detents), slats, spoilers (flight + auto ground spoilers), speedbrake, brakes,
//     parking brake, autobrake (landing + RTO), reversers, nose-wheel steering, canopy, lights
//   - ground contact: per-contact spring-damper struts (from the rig contacts), tire friction, static friction hold,
//     tail skid; crash detection (hard touchdown, attitude, water, structure strike, world.hitTest obstacles)
//   - warnings: stall, overspeed (VMO/MMO/VFE/VLE), gear, bank, sink rate, pull up (terrain + obstacle look-ahead)
//
// Body axes (Three.js): nose -Z, up +Y, right wing +X. Internally p = -omega.z (roll right), q = omega.x (nose up),
// r = -omega.y (yaw right). No DOM access: runs in Node (tests/fixedwing.test.mjs).
import * as THREE from 'three';
import { DEG, KT, G0, clamp, lerp, smoothstep, moveToward, wrap360, turkishDative } from './fixedwing-util.js';
import { isa, casFromTas, tasFromCas, RHO0 } from './fixedwing-atmosphere.js';
import { createAero, flapConfig } from './fixedwing-aero.js';
import { createPowerplant } from './fixedwing-engine.js';
import { createFCS } from './fixedwing-fcs.js';
import { createAutopilot, findApproach, approachGeometry, runwayEnds } from './fixedwing-autopilot.js';
import { createLnav } from '../nav/lnav.js';

const MAX_FRAME_DT = 0.25;

// scratch (no allocations in the hot loop)
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _vb = new THREE.Vector3(), _Fb = new THREE.Vector3(), _Tb = new THREE.Vector3();
const _Fw = new THREE.Vector3(), _Tw = new THREE.Vector3(), _Ffric = new THREE.Vector3(), _Tfric = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _n = new THREE.Vector3(), _pw = new THREE.Vector3(), _rw = new THREE.Vector3(), _vc = new THREE.Vector3();
const _wf = new THREE.Vector3(), _wl = new THREE.Vector3(), _omegaW = new THREE.Vector3();
const _qInv = new THREE.Quaternion(), _dq = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _air = {};

function groundAt(world, x, z) {
  const g = world && world.getGroundHeight ? world.getGroundHeight(x, z) : 0;
  return Number.isFinite(g) ? g : 0;
}
function isWater(world, x, z) { return !!(world && world.isWater && world.isWater(x, z)); }
function guessKind(name = '') { return /nose/i.test(name) ? 'nose' : /tail/i.test(name) ? 'tail' : 'main'; }

export function createFixedWingModel(spec, { contacts } = {}) {
  return new FixedWingModel(spec, contacts);
}

export class FixedWingModel {
  constructor(spec, contacts) {
    this.spec = spec;
    this.category = spec.category;
    this.fighter = spec.category === 'fighter';
    this.H = spec.substep ?? 1 / 240;
    this.aero = createAero(spec);
    this.pp = createPowerplant(spec);

    // ---- public readable state (CONTRACTS-SF.md §6.3) ----
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();   // body rad/s (three axes)
    this.airspeed = 0; this.ias = 0; this.mach = 0; this.altitude = 0; this.agl = 0;
    this.heading = 0; this.pitch = 0; this.roll = 0; this.verticalSpeed = 0; this.gForce = 1; this.aoa = 0; this.sideslip = 0;
    this.throttle = 0; this.onGround = true; this.stalled = false; this.crashed = false; this.crashReason = '';
    this.aileron = 0; this.elevator = 0; this.rudder = 0; this.trim = 0;
    this.engines = this.pp.engines;
    this.gear = 1; this.gearHandleDown = true; this.flaps = 0; this.flapsIndex = 0; this.flapsLabel = '';
    this.slats = 0; this.spoilers = 0; this.speedbrake = 0; this.reverser = 0; this.brakes = 0; this.fuel = 0;
    this.parkingBrake = false; this.autobrake = ''; this.groundSpeed = 0; this.mass = spec.mass.typical;
    this.warnings = { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false };
    this.autopilot = { on: false, altitude: 0, heading: 0, speed: 0, mode: '', athr: false };
    this.rotorRPM = 0; this.collective = 0; this.torque = 0;
    this.canopy = 0; this.tvc = { pitch: 0, yaw: 0 }; this.buffet = 0;
    this.vSpeeds = { vs1g: 0, vls: 0, vapp: 0, vr: 0, v2: 0, vref: 0, vmo: spec.limits.vmo, mmo: spec.limits.mmo, vfe: 0, vfeNext: 0, vle: spec.limits.vle ?? 0 };
    this.pendingThrottle = null;    // lever value the input module should adopt (reset / autopilot disconnect)
    this.law = spec.fcs.law;
    this.tailStrike = false;

    // ---- internal state ----
    this._pos = new THREE.Vector3(); this._quat = new THREE.Quaternion();
    this._prevPos = new THREE.Vector3(); this._prevQuat = new THREE.Quaternion();
    this._omega = this.angularVelocity;
    this._acc = 0;
    this._handlers = {};
    this.I = { pitch: 1, yaw: 1, roll: 1 };
    this.ad = { V: 0, alpha: 0, beta: 0, M: 0, qbar: 0, ias: 0, p: 0, q: 0, r: 0, phi: 0, theta: 0, psi: 0, gamma: 0, vs: 0, nz: 1, h: 0, rho: RHO0, a: 340, sigma: 1, theta0: 1, delta: 1 };
    this.cfg = {}; this.lp = {}; this.co = {}; this.cd = {};
    this.mom = { Mbase: 0, Mde: 1, MalphaDim: -1, Lbase: 0, Lda: 1, Nbase: 0, Ndr: 1 };
    this.act = { elevator: 0, aileron: 0, rudder: 0, trim: 0, tvc: 0 };
    this.apOut = { active: false, nCmd: null, pCmd: null, power: null, pedal: null, groundPitch: null };
    this.sys = {
      gearHandleDown: true, gear: 1, flapIndex: 0, flapPos: 0, speedbrakeCmd: false, speedbrake: 0, spoilers: 0,
      groundSpoilers: false, gsArmed: false, reverserCmd: false, canopyCmd: false, canopy: 0, altFlaps: false,
      autobrake: '', autobrakeActive: false, rtoArmed: false, lightsOn: true, brake: 0, parkingBrake: false, leverLock: false,
    };
    this.wow = true;               // weight on (main) wheels
    this.flapIndexTarget = 0; this.flapIndexActual = 0;
    this._buildGeometry(contacts);
    this.fcs = createFCS(this);
    this.ap = createAutopilot(this);
    // route following (src/nav): the host attaches a Route with setRoute(); `nav` = LNAV guidance (null without a route)
    this.route = null;
    this.nav = null;
    this._lnav = createLnav();
    this._navIn = { x: 0, z: 0, vx: 0, vz: 0, alt: 0, hdg: 0, category: spec.category, bankMax: (spec.autopilot?.bankMax ?? (this.fighter ? 45 : 25)) * DEG, onGround: true,
      rollTime: (spec.autopilot?.bankMax ?? (this.fighter ? 45 : 25)) / (spec.autopilot?.rollRate ?? (this.fighter ? 30 : 5)),
      headingGain: this.fighter ? 3.5 : (spec.autopilot?.Khdg ?? 2.0) };
    this._visual = {
      time: 0, airspeed: 0, mach: 0, onGround: true, aoa: 0, aileron: 0, elevator: 0, rudder: 0, flaps: 0, slats: 0,
      spoilers: 0, speedbrake: 0, gear: 1, gearCompression: this._wheels.map(() => 0), wheelSpeed: 0,
      engines: this.engines.map(() => ({ n1: 0, throttle: 0, afterburner: 0, nozzle: 0, reverser: 0 })),
      tvc: { pitch: 0, yaw: 0 }, rotor: null, canopy: 0, lights: { nav: true, strobe: false, beacon: true, landing: false, taxi: false },
    };
    this._time = 0;
    this._resetInternals();
    this.flapsLabel = spec.flapDetents[0].label;
  }

  // ------------------------------------------------------------------------------------------ geometry
  _buildGeometry(contacts) {
    const spec = this.spec, G = spec.gear;
    const src = contacts && contacts.length >= 2 ? contacts : spec.contacts;
    const list = src.map((c) => {
      const p = c.position || c;
      return { name: c.name || '', kind: c.kind || guessKind(c.name), x: p.x, y: p.y, z: p.z };
    });
    const s0 = G.staticCompression ?? 0.2;
    this._s0 = s0;
    this._bump = G.bumpStop ?? 0.3;
    this._wheels = list.map((c) => ({
      name: c.name, kind: c.kind, r0: new THREE.Vector3(c.x, c.y, c.z), r: new THREE.Vector3(c.x, c.y - s0, c.z),
      k: 1, c: 1, steer: c.kind !== 'main', brake: c.kind === 'main', contact: false, load: 0, comp: 0, share: 0,
    }));
    const mains = this._wheels.filter((w) => w.kind === 'main');
    const others = this._wheels.filter((w) => w.kind !== 'main');
    const zm = mains.length ? mains.reduce((a, w) => a + w.r0.z, 0) / mains.length : 1;
    const zn = others.length ? others.reduce((a, w) => a + w.r0.z, 0) / others.length : -5;
    const noseShare = others.length ? clamp(zm / (zm - zn), 0.04, 0.4) : 0;
    for (const w of mains) w.share = (1 - noseShare) / Math.max(mains.length, 1);
    for (const w of others) w.share = noseShare / others.length;
    this._zMain = zm;
    const yG = Math.min(...list.map((c) => c.y));   // static ground plane in body coordinates
    this._yGround = yG;
    this.gearHeight = -yG;
    // structure points (body coordinates) that must never touch the ground
    const T = spec.structure || {};
    const pts = [];
    const add = (x, y, z, kind, reason) => pts.push({ r: new THREE.Vector3(x, y, z), kind, reason });
    if (T.tail) add(0, yG + (T.tail.z - zm) * Math.tan(T.tail.strikeDeg * DEG), T.tail.z, 'tail', 'Kuyruk yere çarptı');
    if (T.nose) add(0, yG + T.nose.height, T.nose.z, 'nose', 'Burun yere çarptı');
    if (T.belly) { add(0, yG + T.belly.height, T.belly.z, 'belly', 'Gövde yere çarptı'); add(0, yG + T.belly.height + 0.2, (T.nose ? T.nose.z : -5) * 0.5, 'belly', 'Gövde yere çarptı'); }
    if (T.nacelle) for (const s of [-1, 1]) add(s * T.nacelle.x, yG + T.nacelle.clearance, T.nacelle.z, 'nacelle', 'Motor yere çarptı');
    if (T.wingtip) for (const s of [-1, 1]) add(s * T.wingtip.x, yG + T.wingtip.height, T.wingtip.z, 'wing', 'Kanat ucu yere çarptı');
    if (T.top) add(0, yG + T.top.height, T.top.z ?? 0, 'top', 'Uçak ters döndü ve yere çakıldı');
    this._structure = pts;
    this.tailStrikeDeg = T.tail ? T.tail.strikeDeg : 15;
    this._reach = Math.max(spec.span / 2, (spec.length || 20) / 2) + 2;
    // obstacle collision spheres (body): nose, center, tail, wing halves
    const L = spec.length || 20, B = spec.span, R = spec.fuselageRadius || 2;
    this._hitSpheres = [
      { r: new THREE.Vector3(0, 0, -L * 0.33), rad: R * 1.1 }, { r: new THREE.Vector3(0, 0, 0), rad: R * 1.2 },
      { r: new THREE.Vector3(0, R * 0.8, L * 0.36), rad: R * 1.2 },
      { r: new THREE.Vector3(-B * 0.3, 0, L * 0.05), rad: B * 0.14 }, { r: new THREE.Vector3(B * 0.3, 0, L * 0.05), rad: B * 0.14 },
    ];
    this._hitRadius = Math.max(L, B) * 0.55;
  }

  _setupStruts() {
    const G = this.spec.gear;
    const W = this.mass * G0;
    const s0 = this._s0, bump = this._bump;
    for (const w of this._wheels) {
      w.k = (w.share * W) / (s0 * (1 + (s0 / bump) ** 2));
      w.c = 2 * (G.damping ?? 0.7) * Math.sqrt(w.k * w.share * this.mass);
    }
  }

  _updateInertia() {
    const I0 = this.spec.inertia, mr = this.mass / (I0.mass ?? this.spec.mass.typical);
    const f = 0.35 + 0.65 * mr;
    this.I.pitch = I0.pitch * f; this.I.yaw = I0.yaw * f; this.I.roll = I0.roll * f;
  }

  on(event, cb) { (this._handlers[event] ||= []).push(cb); }
  _emit(event, info) { for (const cb of this._handlers[event] || []) { try { cb(info); } catch (e) { console.error(e); } } }

  // ------------------------------------------------------------------------------------------ reset
  _resetInternals() {
    this.velocity.set(0, 0, 0); this._omega.set(0, 0, 0); this._acc = 0;
    this.crashed = false; this.crashReason = ''; this.stalled = false; this.tailStrike = false;
    this._airTime = 0; this._noContactTime = 0; this._groundTime = 0; this._fastRoll = false; this._takeoffArmed = true;
    this._liftoff = null; this._contact = true; this._gSmooth = 1; this._loadAcc = 0; this._loadN = 0; this._aglCG = 0;
    this._tailWas = false; this._hitTimer = 0; this._warnTimer = 0; this._runwayTimer = 0; this._onRunway = true;
    this._leverRef = null; this._leverTarget = 0; this._leverLatched = false; this._alphaFloorT = 0; this._lastBrakeIn = 0; this._abLatched = false;
    for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
    for (const k in this.warnings) this.warnings[k] = false;
    const act = this.act; act.elevator = 0; act.aileron = 0; act.rudder = 0; act.trim = 0; act.tvc = 0;
    this.ap.reset && this.ap.reset();
    this.autopilot.on = false; this.autopilot.mode = '';
    if (this._lnav) this._lnav.reset();
  }

  /**
   * start: { x, z, heading (rad), altitude? (m MSL → airborne), speed? (m/s TAS) }.
   * opts (tests / tools): { mass, fuel, flapIndex, gearDown, throttle, verticalSpeed, approach: bool, bank (deg) }.
   */
  reset(start, world, opts = {}) {
    const spec = this.spec;
    this._resetInternals();
    this.fuel = clamp(opts.fuel ?? spec.mass.fuelTypical, 0, spec.mass.fuelCapacity);
    this.mass = opts.mass ?? spec.mass.typical;
    this._zfw = this.mass - this.fuel;
    this._updateInertia();
    this._setupStruts();
    const heading = start.heading ?? 0;
    const sys = this.sys;
    sys.speedbrakeCmd = false; sys.speedbrake = 0; sys.spoilers = 0; sys.groundSpoilers = false; sys.gsArmed = false;
    sys.reverserCmd = false; sys.canopyCmd = false; sys.canopy = 0; sys.altFlaps = false; sys.autobrake = ''; sys.autobrakeActive = false;
    sys.rtoArmed = false; sys.brake = 0; sys.leverLock = false;
    this.pp.setSpool(0);
    const airborne = start.altitude != null && Number.isFinite(start.altitude);
    if (!airborne) this._resetGround(start, world, heading, opts);
    else this._resetAir(start, world, heading, opts);
    this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
    this._airData(world);
    this._updateVSpeeds();
    this._updateReadouts(world, 1);
    this.pendingThrottle = this._leverTarget;
    // airborne: keep the trimmed lever until the input lever is synced / moved (see _frameInput)
    this._leverLatched = airborne; this._leverRef = null;
    // an attached route is flown again from the new position
    if (this.route) { this.route.restart(this._pos.x, this._pos.z, heading); this._updateNav(0); }
  }

  _resetGround(start, world, heading, opts) {
    const spec = this.spec, sys = this.sys;
    sys.gearHandleDown = true; sys.gear = 1;
    const to = opts.flapIndex ?? spec.takeoffFlapIndex ?? 0;
    sys.flapIndex = to; sys.flapPos = to;
    sys.parkingBrake = opts.parkingBrake ?? true;
    // attitude: both nose and main contacts on the ground
    const nose = this._wheels.find((w) => w.kind !== 'main'), main = this._wheels.find((w) => w.kind === 'main');
    const pitch = nose && main && Math.abs(nose.r0.z - main.r0.z) > 0.1 ? Math.atan((nose.r0.y - main.r0.y) / (nose.r0.z - main.r0.z)) : 0;
    _euler.set(pitch, -heading, 0, 'YXZ');
    this._quat.setFromEuler(_euler);
    let g = groundAt(world, start.x, start.z), low = Infinity;
    for (const w of this._wheels) {
      _v1.copy(w.r0).applyQuaternion(this._quat);
      g = Math.max(g, groundAt(world, start.x + _v1.x, start.z + _v1.z));
      low = Math.min(low, _v1.y);
    }
    this._pos.set(start.x, g - low, start.z);
    this.velocity.set(0, 0, 0);
    this._contact = true; this.wow = true;
    this.act.trim = spec.fcs.takeoffTrim ?? 0;
    this._leverTarget = 0; this._effLever = 0;
    this.fcs.reset({ airborne: false });
    for (const w of this._wheels) { w.contact = true; w.load = w.share * this.mass * G0; w.comp = 0.35; }
  }

  _resetAir(start, world, heading, opts) {
    const spec = this.spec, sys = this.sys;
    // approach configuration when the start lies on a runway's final approach (e.g. AIR-SFO-FINAL) or the speed is
    // too low for the clean wing
    const rw = world && world.runways ? findApproach(world.runways, start.x, start.z, heading, 25000) : null;
    let onFinal = false;
    if (rw) {
      const g = approachGeometry(rw, start.x, start.z);
      const dAlt = start.altitude - g.gsAlt;
      onFinal = Math.abs(g.lateral) < 300 && Math.abs(dAlt) < 150 && Math.abs(wrap360((heading - rw.course) / DEG + 180) - 180) < 20;
    }
    this.mass = this._zfw + this.fuel;
    const vsClean = this._vs1g(0, 0.3);
    let speed = start.speed ?? spec.spawnSpeed;
    const tooSlow = speed < vsClean * (this.fighter ? 1.25 : 1.3);
    const approach = opts.approach ?? (onFinal || tooSlow);
    let flapIndex = 0, gearDown = false;
    if (approach) {
      flapIndex = spec.landingFlapIndex ?? spec.flapDetents.length - 1;
      gearDown = true;
      const vapp = this._vs1g(flapIndex, 0.2) * (spec.vlsFactor ?? (this.fighter ? 1.2 : 1.23)) + 5 * KT;
      if (onFinal || !(start.speed > vapp)) speed = tasFromCas(vapp, start.altitude);
    }
    if (opts.flapIndex != null) flapIndex = opts.flapIndex;
    if (opts.gearDown != null) gearDown = opts.gearDown;
    sys.flapIndex = flapIndex; sys.flapPos = flapIndex;
    sys.gearHandleDown = gearDown; sys.gear = gearDown ? 1 : 0;
    sys.parkingBrake = false;
    if (gearDown && spec.category === 'airliner') { sys.gsArmed = true; sys.autobrake = spec.autobrake?.landing ?? 'MED'; }
    const vs = opts.verticalSpeed ?? (onFinal ? -speed * Math.tan(3 * DEG) : 0);
    const gamma = Math.asin(clamp(vs / speed, -0.5, 0.5));
    // trim: alpha for 1 g on the path, thrust for the drag, elevator for the moment
    this._pos.set(start.x, start.altitude, start.z);
    this._aglCG = start.altitude - groundAt(world, start.x, start.z) - this.gearHeight;
    const bank = (opts.bank ?? 0) * DEG;
    this.velocity.set(Math.sin(heading) * Math.cos(gamma), Math.sin(gamma), -Math.cos(heading) * Math.cos(gamma)).multiplyScalar(speed);
    let alpha = 3 * DEG, T = 0;
    _euler.set(alpha + gamma, -heading, -bank, 'YXZ');
    this._quat.setFromEuler(_euler);
    this._contact = false; this.wow = false;
    for (let it = 0; it < 8; it++) {
      this._airData(world);
      const n = Math.cos(gamma) / Math.cos(bank);
      this.pp.st.thrust = T;
      alpha = this.alphaForN(n);
      _euler.set(alpha + gamma, -heading, -bank, 'YXZ');
      this._quat.setFromEuler(_euler);
      this._airData(world);
      const D = this.ad.qbar * spec.wingArea * this.cd.CD;
      T = (D + this.mass * G0 * Math.sin(gamma)) / Math.max(Math.cos(alpha), 0.5);
    }
    // engines
    this.pp.limits(this.ad.h, this.ad.M, this.ad.sigma);
    const count = spec.engines || 1;
    const Te = T / count;
    let power = this.pp.powerFor(Te), ab = 0;
    if (power >= 1 && this.pp.hasAB) {
      const st = this.pp.st;
      ab = clamp((Te - st.tmil) / Math.max(st.twet - st.tmil, 1), 0, 1);
    }
    this.pp.setSpool(this.pp.spoolFor(power), ab);
    this.pp.st.thrust = this.pp.thrustAt(this.pp.st.x, ab, 0) * count;
    this._leverTarget = opts.throttle ?? this._leverFromPower(power, ab);
    this._effLever = this._leverTarget;
    // elevator trim for zero pitching moment
    this._airData(world);
    this._airMoments(this.pp.st.thrust);
    const u = clamp(-this.mom.Mbase / Math.max(this.mom.Mde, 1), -2, 2);
    if (spec.fcs.trimRange) { this.act.trim = clamp(u, spec.fcs.trimRange[0], spec.fcs.trimRange[1]); this.act.elevator = clamp(u - this.act.trim, -1, 1); }
    else { this.act.trim = 0; this.act.elevator = clamp(u, -1, 1); }
    this._omega.set(0, 0, 0);
    this.fcs.reset({ airborne: true, gamma, phi: bank });
    this._airTime = 10; this._noContactTime = 10; this._fastRoll = false; this._takeoffArmed = false;
    for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
  }

  // ------------------------------------------------------------------------------------------ helpers
  _vs1g(flapIndex, M = 0.2) {
    const cfg = flapConfig(this.spec.flapDetents, flapIndex, {});
    const lp = this.aero.liftParams(M, cfg, {});
    return Math.sqrt((2 * this.mass * G0) / (RHO0 * this.spec.wingArea * lp.CLmax));
  }

  _leverFromPower(power, ab) {
    const det = this.spec.abDetent;
    if (this.pp.hasAB && det) return ab > 0 ? det + ab * (1 - det) : power * det;
    return power;
  }
  /** Current dry power fraction commanded (for autothrust initialization). */
  _leverPower() { return clamp(Math.pow(this.pp.st.x, this.spec.engine.thrustExp ?? 1.5), 0, 1); }
  /** Lever position equivalent to the thrust the engines are commanded to (A/THR, alpha floor). */
  _effectiveLever() { return this._effLever ?? this.throttle; }

  /** Total lift coefficient incl. ground effect and spoilers at alpha for the current air data. */
  _CLtotal(alpha) {
    const cl = this.aero.CL(alpha, this.lp);
    const sp = this.sys.spoilers;
    return cl * this._geLift - (cl > 0 ? (this.spec.aero.spoilerCL ?? 0.6) * sp * sp : 0);
  }
  nForAlpha(alpha) {
    const ad = this.ad;
    const T = this.pp.st.thrust;
    return (ad.qbar * this.spec.wingArea * this._CLtotal(alpha) + T * Math.sin(alpha)) / (this.mass * G0);
  }
  alphaForN(n) {
    let lo = this.lp.alphaStallNeg, hi = this.lp.alphaStall;
    if (this.ad.qbar < 1) return n >= 0 ? hi : lo;
    if (this.nForAlpha(hi) <= n) return hi;
    if (this.nForAlpha(lo) >= n) return lo;
    for (let i = 0; i < 18; i++) {
      const mid = 0.5 * (lo + hi);
      if (this.nForAlpha(mid) < n) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  // ------------------------------------------------------------------------------------------ commands
  command(action) {
    const spec = this.spec, sys = this.sys;
    if (this.crashed && action !== 'lights') return;
    switch (action) {
      case 'gear': {
        if (sys.gearHandleDown && (this.wow || this.onGround)) { this._emit('warning', { type: 'gearLocked', on: true }); return; }
        sys.gearHandleDown = !sys.gearHandleDown;
        this._emit('gear', { down: sys.gearHandleDown });
        break;
      }
      case 'flapsDown': case 'flapsUp': {
        const n = spec.flapDetents.length;
        if (this.fighter) {
          // fighters: automatic LEF/TEF schedule; the key toggles the alternate (landing) flaps
          sys.altFlaps = action === 'flapsDown';
        } else {
          const i = clamp(sys.flapIndex + (action === 'flapsDown' ? 1 : -1), 0, n - 1);
          if (i === sys.flapIndex) return;
          sys.flapIndex = i;
        }
        const idx = this.fighter ? (sys.altFlaps ? 1 : 0) : sys.flapIndex;
        this._emit('flaps', { index: idx, label: spec.flapDetents[Math.min(idx, n - 1)].label });
        break;
      }
      case 'speedbrake': sys.speedbrakeCmd = !sys.speedbrakeCmd; break;
      case 'reverser': {
        if (!this.pp.hasRev) return;
        if (!sys.reverserCmd) {
          if (!this.wow || this._lever > 0.06) { this._emit('warning', { type: 'reverserInhibit', on: true }); return; }
          sys.reverserCmd = true;
        } else { sys.reverserCmd = false; sys.leverLock = true; }
        this._emit('reverser', { on: sys.reverserCmd });
        break;
      }
      case 'canopy': {
        if (!this.fighter) return;
        if (!this.onGround || this.groundSpeed > 5) return;
        sys.canopyCmd = !sys.canopyCmd;
        break;
      }
      case 'lights': sys.lightsOn = !sys.lightsOn; break;
      case 'autopilot': this.ap.toggle(); break;
      case 'nav': this.engageNav(); break;
      default: break;
    }
    // readouts that change immediately with the lever / switch
    this.gearHandleDown = sys.gearHandleDown;
    const det = spec.flapDetents;
    this.flapsIndex = this.fighter ? (sys.altFlaps || sys.gearHandleDown ? 1 : 0) : sys.flapIndex;
    this.flapsLabel = det[Math.min(this.flapsIndex, det.length - 1)].label;
  }

  // ------------------------------------------------------------------------------------------ route (LNAV)
  /** Attach a src/nav/route.js Route (or null). The autopilot flies it in NAV; `nav` carries the guidance. */
  setRoute(route) {
    this.route = route || null;
    this._lnav.reset();
    this.nav = null;
    if (!route) { this.autopilot.approachRunway = null; if (this.autopilot.lnav) this.autopilot.lnav = false; }
    else this._updateNav(0);
  }

  /** Fly the route: engage the autopilot in NAV (or switch HDG → NAV). false when there is nothing to fly / on the ground. */
  engageNav() { return this.crashed ? false : this.ap.engageNav(); }

  _updateNav(dt) {
    if (!this.route) return;
    const S = this._navIn;
    S.x = this._pos.x; S.z = this._pos.z; S.vx = this.velocity.x; S.vz = this.velocity.z; S.alt = this._pos.y;
    S.hdg = this.ad.psi; S.onGround = this.wow;
    this.nav = this._lnav.update(this.route, S, dt);
    this.autopilot.approachRunway = this.route.approach ? this.route.approach.name : null;
  }

  // ------------------------------------------------------------------------------------------ step
  step(dt, input, world) {
    if (this.crashed) return;
    const inp = input || {};
    this._acc += clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_FRAME_DT);
    this._loadAcc = 0; this._loadN = 0;
    this._frameInput(inp);
    this._updateNav(dt);
    const h = this.H;
    while (this._acc >= h) {
      this._prevPos.copy(this._pos); this._prevQuat.copy(this._quat);
      this._substep(h, inp, world);
      this._acc -= h;
      this._time += h;
      if (this.crashed) { this._acc = 0; break; }
    }
    if (this._loadN > 0) {
      const g = this._loadAcc / this._loadN;
      this._gSmooth += (g - this._gSmooth) * clamp(dt / 0.1, 0, 1);
    }
    this._frameSystems(dt, inp, world);
    if (this.route) this.ap.frame(dt);
    this._updateReadouts(world, this.crashed ? 1 : this._acc / h);
  }

  /** Lever pickup: after a reset the model keeps its own (trimmed) lever until the input lever moves. */
  _frameInput(inp) {
    const x = clamp(Number.isFinite(inp.throttle) ? inp.throttle : 0, 0, 1);
    if (this._leverLatched) {
      if (this._leverRef == null) this._leverRef = x;
      if (Math.abs(x - this._leverRef) > 1e-4 || Math.abs(x - this._leverTarget) < 0.02) this._leverLatched = false;
    }
    this._lever = this._leverLatched ? this._leverTarget : x;
    // reverser lever lock: after stowing, forward thrust only once the lever has been back to idle
    if (this.sys.leverLock && this._lever <= 0.05) this.sys.leverLock = false;
  }

  _substep(h, inp, world) {
    const spec = this.spec, sys = this.sys, ad = this.ad;
    this._systems(h, inp);
    this._airData(world);
    // autopilot → demands; engines; control laws
    this.ap.update(h, inp, world);
    const thrust = this._engines(h);
    this._airMoments(thrust);
    this.fcs.update(h, inp, this.apOut);
    const act = this.act;

    // ---- aerodynamic forces (body) ----
    const S = spec.wingArea, b = spec.span, c = spec.chord;
    const qS = ad.qbar * S;
    _Fb.set(0, 0, 0); _Tb.set(0, 0, 0);
    const V = ad.V;
    if (V > 0.5) {
      const CL = this._CLtotal(ad.alpha);
      const CD = this.cd.CD;
      const co = this.co;
      const CY = co.CY + co.CYdr * act.rudder;
      const dx = _vb.x / V, dy = _vb.y / V, dz = _vb.z / V;
      const ln = Math.hypot(dy, dz) || 1;
      const L = qS * CL, D = qS * CD, Y = qS * CY;
      _Fb.x += -dx * D + Y;
      _Fb.y += -dy * D + L * (-dz / ln);
      _Fb.z += -dz * D + L * (dy / ln);
      const Cm = co.Cm + co.Cmde * (act.elevator + act.trim);
      const Cl = co.Cl + co.Clda * act.aileron + co.Cldr * act.rudder;
      const Cn = co.Cn + co.Cndr * act.rudder + co.Cnda * act.aileron;
      _Tb.x += qS * c * Cm;
      _Tb.z += -qS * b * Cl;
      _Tb.y += -qS * b * Cn;
    }
    // ---- thrust (+ pitch thrust vectoring) ----
    const E = spec.engine;
    const dT = spec.fcs.tvc ? act.tvc * spec.fcs.tvc.max * DEG : 0;
    const Tc = thrust * Math.cos(dT), Ts = thrust * Math.sin(dT);
    _Fb.z -= Tc; _Fb.y -= Ts;
    _Tb.x += -(E.thrustLineY ?? 0) * Tc + (spec.fcs.tvc ? spec.fcs.tvc.arm : 0) * Ts;

    // ---- to world ----
    const pos = this._pos, quat = this._quat, vel = this.velocity, omega = this._omega;
    _Fw.copy(_Fb).applyQuaternion(quat);
    _Tw.set(0, 0, 0);
    // non-gravitational load factor (aero + thrust), for the FBW hold capture
    _up.set(0, 1, 0).applyQuaternion(quat);

    // ---- ground contact ----
    if (this._ground(h, inp, world)) return;
    const m = this.mass;
    this._loadAcc += _Fw.dot(_up) / (m * G0); this._loadN++;
    ad.nz = _Fw.dot(_up) / (m * G0);

    // ---- integrate ----
    vel.addScaledVector(_Fw, h / m);
    vel.y -= G0 * h;
    if (this._stuck) {
      vel.x = 0; vel.z = 0;
      _omegaW.copy(omega).applyQuaternion(quat); _omegaW.y = 0;
      _qInv.copy(quat).invert();
      omega.copy(_omegaW.applyQuaternion(_qInv));
    }
    pos.addScaledVector(vel, h);
    _qInv.copy(quat).invert();
    _Tw.applyQuaternion(_qInv);
    _Tb.add(_Tw);
    const I = this.I;
    const Ix = I.pitch, Iy = I.yaw, Iz = I.roll;
    const wx = omega.x, wy = omega.y, wz = omega.z;
    const gx = wy * wz * (Iz - Iy), gy = wz * wx * (Ix - Iz), gz = wx * wy * (Iy - Ix);
    const dampK = 0.02;
    omega.x += ((_Tb.x - gx) / Ix - dampK * wx) * h;
    omega.y += ((_Tb.y - gy) / Iy - dampK * wy) * h;
    omega.z += ((_Tb.z - gz) / Iz - dampK * wz) * h;
    if (omega.lengthSq() > 144) omega.setLength(12);
    const ang = omega.length() * h;
    if (ang > 1e-12) { _dq.setFromAxisAngle(_v1.copy(omega).normalize(), ang); quat.multiply(_dq).normalize(); }

    // ---- fuel ----
    if (this.fuel > 0) {
      this.fuel = Math.max(0, this.fuel - this.pp.st.fuelFlow * h);
      this.mass = this._zfw + this.fuel;
    }
    // ---- obstacles (bridges, buildings, towers) ----
    this._hitTimer -= h;
    if (this._hitTimer <= 0 && world && world.hitTest) {
      this._hitTimer = 1 / 60;
      if (this._obstacleHit(world)) return;
    }
    if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z + quat.w)) this._crash('Sayısal hata');
  }

  // ------------------------------------------------------------------------------------------ air data
  _airData(world) {
    const spec = this.spec, ad = this.ad, sys = this.sys;
    const quat = this._quat, vel = this.velocity, omega = this._omega;
    _qInv.copy(quat).invert();
    _vb.copy(vel).applyQuaternion(_qInv);
    const V = _vb.length();
    const h = this._pos.y;
    isa(h, _air);
    ad.h = h; ad.rho = _air.rho; ad.a = _air.a; ad.sigma = _air.sigma; ad.theta0 = _air.theta; ad.delta = _air.delta;
    ad.V = V; ad.M = V / _air.a; ad.qbar = 0.5 * _air.rho * V * V;
    ad.ias = casFromTas(V, h);
    if (V > 0.5) { ad.alpha = Math.atan2(-_vb.y, -_vb.z); ad.beta = Math.asin(clamp(_vb.x / V, -1, 1)); }
    else { ad.alpha = 0; ad.beta = 0; }
    ad.p = -omega.z; ad.q = omega.x; ad.r = -omega.y;
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    _right.set(1, 0, 0).applyQuaternion(quat);
    _up.set(0, 1, 0).applyQuaternion(quat);
    ad.theta = Math.asin(clamp(_fwd.y, -1, 1));
    ad.phi = Math.atan2(-_right.y, _up.y);
    ad.psi = Math.atan2(_fwd.x, -_fwd.z);
    ad.vs = vel.y;
    ad.gamma = V > 1 ? Math.asin(clamp(vel.y / V, -1, 1)) : 0;
    // configuration and aero coefficients
    flapConfig(spec.flapDetents, sys.flapPos, this.cfg);
    this.aero.liftParams(ad.M, this.cfg, this.lp);
    const wingH = Math.max(this._aglCG + this.gearHeight * 0.6, 0.3);
    const phiGE = this.aero.groundEffect(wingH);
    this._phiGE = phiGE;
    this._geLift = 1 + (spec.aero.groundEffectLift ?? 0.1) * (1 - phiGE);
    const Vs = Math.max(V, 1);
    const st = this._aeroSt || (this._aeroSt = {});
    st.alpha = ad.alpha; st.beta = ad.beta; st.M = ad.M; st.cfg = this.cfg; st.lp = this.lp; st.qbar = ad.qbar;
    st.phat = (ad.p * spec.span) / (2 * Vs); st.qhat = (ad.q * spec.chord) / (2 * Vs); st.rhat = (ad.r * spec.span) / (2 * Vs);
    st.CL = this._CLtotal(ad.alpha); st.phiGE = phiGE;
    st.gear = sys.gear; st.spoilers = sys.spoilers; st.speedbrake = sys.speedbrake;
    this.aero.drag(st, this.cd);
    this.aero.moments(st, this.co);
  }

  /** Dimensional base moments and control powers for the NDI laws. */
  _airMoments(thrust) {
    const spec = this.spec, ad = this.ad, co = this.co, mom = this.mom, act = this.act;
    const qS = ad.qbar * spec.wingArea;
    const E = spec.engine;
    mom.Mbase = qS * spec.chord * co.Cm - (E.thrustLineY ?? 0) * thrust;
    mom.Mde = qS * spec.chord * co.Cmde;
    mom.MalphaDim = qS * spec.chord * (typeof spec.aero.Cmalpha === 'number' ? spec.aero.Cmalpha : -0.5);
    mom.Lbase = qS * spec.span * (co.Cl + co.Cldr * act.rudder);
    mom.Lda = qS * spec.span * co.Clda;
    mom.Nbase = qS * spec.span * (co.Cn + co.Cnda * act.aileron);
    mom.Ndr = qS * spec.span * co.Cndr;
  }

  // ------------------------------------------------------------------------------------------ engines
  _engines(h) {
    const spec = this.spec, sys = this.sys, ad = this.ad, fcs = this.fcs.st;
    let lever = this._lever;
    if (sys.leverLock) lever = 0;
    const det = this.pp.hasAB ? spec.abDetent ?? 0.9 : 1;
    let power = Math.min(lever / det, 1);
    let ab = this.pp.hasAB && lever > det + 0.004 ? (lever - det) / (1 - det) : 0;
    // autothrust
    if (this.apOut.active && this.apOut.power != null) { power = this.apOut.power; ab = 0; }
    // alpha floor (airbus): TOGA when the AoA passes alpha floor in flight
    if (this.law === 'airbus' && !this.wow && this.agl > 30) {
      if (ad.alpha > fcs.alphaFloorA && fcs.alphaFloorA > 0) this._alphaFloorT = 5;
    }
    if (this._alphaFloorT > 0) {
      this._alphaFloorT -= h;
      if (ad.alpha > fcs.alphaProtA - 2 * DEG) this._alphaFloorT = Math.max(this._alphaFloorT, 1);
      power = 1; ab = 0;
    }
    fcs.alphaFloor = this._alphaFloorT > 0;
    this._effLever = this._leverFromPower(power, ab);
    const reverse = sys.reverserCmd;
    return this.pp.update(h, { power: reverse ? lever : power, ab, reverse, fuel: this.fuel }, { h: ad.h, M: ad.M, sigma: ad.sigma, theta: ad.theta0, delta: ad.delta });
  }

  // ------------------------------------------------------------------------------------------ systems
  _systems(h, inp) {
    const spec = this.spec, sys = this.sys;
    // gear (refuses to retract with weight on wheels: the handle is locked in command())
    const G = spec.gear;
    sys.gear = moveToward(sys.gear, sys.gearHandleDown ? 1 : 0, h / (sys.gearHandleDown ? (G.extendTime ?? 8) : (G.retractTime ?? 8)));
    // flaps: fighters schedule automatically; airliners move between detents at the detent's travel time
    let target;
    if (this.fighter) target = (sys.gearHandleDown || sys.altFlaps) && this.ad.ias < (spec.limits.vfeAuto ?? 190) ? 1 : 0;
    else {
      // flap load relief / automatic retraction: above a detent's VFE (+3 kt) the flaps are commanded to the highest
      // detent still within its limit (A320 1+F → 1 at ~210 kt, 737 blow-back). The selected position follows
      // (label + 'flaps' event), so the pilot re-selects the flaps once slow enough.
      const det = spec.flapDetents, ias = this.ad.ias;
      target = sys.flapIndex;
      while (target > 0 && det[target].vfe && ias > det[target].vfe + 3 * KT) target--;
      if (target !== sys.flapIndex) {
        sys.flapIndex = target;
        this.flapsIndex = target; this.flapsLabel = det[target].label;
        this._emit('flaps', { index: target, label: det[target].label, auto: true });
      }
    }
    const from = sys.flapPos;
    if (from !== target) {
      const seg = target > from ? Math.floor(from) + 1 : Math.ceil(from);
      const det = spec.flapDetents[clamp(seg, 0, spec.flapDetents.length - 1)];
      const time = det.time ?? spec.flapTime ?? 5;
      sys.flapPos = moveToward(from, target, h / time);
    }
    this.flapIndexTarget = target; this.flapIndexActual = sys.flapPos;
    // speedbrake / spoilers
    const onGround = this.wow;
    // with autothrust engaged the thrust the engines are commanded to counts as the lever position
    const lever = this.apOut.active && this.apOut.power != null ? (this._effLever ?? 0) : (this._lever ?? 0);
    const idle = lever < 0.06 || sys.reverserCmd;
    if (spec.category === 'airliner') {
      if (!onGround && sys.gearHandleDown) sys.gsArmed = true;
      if (onGround && this.groundSpeed > 25 && sys.gsArmed && idle) sys.groundSpoilers = true;
      if (sys.rtoArmed && onGround && idle && this.groundSpeed > 36) sys.groundSpoilers = true;
      if (sys.groundSpoilers && ((lever > 0.2 && !sys.reverserCmd) || !onGround && this._airTime > 1)) { sys.groundSpoilers = false; if (lever > 0.2) sys.gsArmed = false; }
      if (sys.groundSpoilers && this.groundSpeed < 0.3 && onGround) { sys.groundSpoilers = false; sys.gsArmed = false; }
      const flight = sys.speedbrakeCmd ? (spec.speedbrakeMax ?? 0.5) : 0;
      const tgt = sys.groundSpoilers ? 1 : onGround ? 0 : flight;
      sys.spoilers = moveToward(sys.spoilers, tgt, h / (sys.groundSpoilers ? 0.8 : 2));
      sys.speedbrake = sys.speedbrakeCmd ? 1 : 0;
      // autobrake: landing (armed by gear down in flight) and RTO (armed on the takeoff roll)
      if (!onGround && sys.gearHandleDown && !sys.autobrake) sys.autobrake = spec.autobrake?.landing ?? 'MED';
      if (onGround && lever > 0.7 && this.groundSpeed < 30) { sys.rtoArmed = true; sys.autobrake = 'RTO'; }
      if (!onGround && this._airTime > 5) { sys.rtoArmed = false; if (sys.autobrake === 'RTO') sys.autobrake = ''; }
    } else {
      sys.speedbrake = moveToward(sys.speedbrake, sys.speedbrakeCmd ? 1 : 0, h / (spec.speedbrakeTime ?? 1.5));
      sys.spoilers = 0;
    }
    // canopy
    if (this.fighter) {
      if (sys.canopyCmd && (this.groundSpeed > 15 || !onGround)) sys.canopyCmd = false;
      sys.canopy = moveToward(sys.canopy, sys.canopyCmd ? 1 : 0, h / 4);
    }
    // brakes: pedal brake (analog), parking brake, autobrake
    const pedal = clamp(Number(inp.brake) || 0, 0, 1);
    if (sys.parkingBrake && (lever > 0.08 || (this._lastBrakeIn > 0.3 && pedal < 0.05))) sys.parkingBrake = false;
    this._lastBrakeIn = pedal;
    let brake = pedal;
    if (sys.parkingBrake) brake = 1;
    sys.autobrakeActive = false;
    if (onGround && sys.autobrake && !sys.parkingBrake) {
      const rto = sys.autobrake === 'RTO';
      if (pedal > 0.6 || (!rto && lever > 0.2 && !sys.reverserCmd)) { sys.autobrake = ''; this._abLatched = false; }
      else {
        // landing: brakes with the ground spoilers; RTO: full braking when the levers come back to idle above 70 kt
        if (!this._abLatched) this._abLatched = rto ? (idle && this.groundSpeed > 36) : sys.groundSpoilers;
        if (rto && lever > 0.2) this._abLatched = false;
        if (this._abLatched) {
          sys.autobrakeActive = true;
          const decel = rto ? 20 : (spec.autobrake?.decel?.[sys.autobrake] ?? 3);
          const a = this._decel ?? 0;
          this._abI = clamp((this._abI ?? 0.3) + (decel - a) * 0.4 * h, 0, 1);
          // below taxi speed the autobrake brings the aircraft to a firm stop and holds it
          brake = Math.max(brake, rto || this.groundSpeed < 8 ? 1 : clamp(this._abI + (decel - a) * 0.05, 0, 1));
        }
      }
    }
    if (!sys.autobrakeActive) this._abI = 0.25;
    if (!onGround || !sys.autobrake) this._abLatched = false;
    sys.brake = brake;
  }

  /** Slower systems, warnings and look-ahead (once per frame). */
  _frameSystems(dt, inp, world) {
    const spec = this.spec, sys = this.sys, ad = this.ad;
    this._updateVSpeeds();
    // runway check (for friction and events)
    this._runwayTimer -= dt;
    if (this._runwayTimer <= 0) { this._runwayTimer = 0.1; this._onRunway = world && world.isOnRunway ? !!world.isOnRunway(this._pos.x, this._pos.z) : true; }
    // afterburner event
    const abOn = this.pp.st.ab > 0.02;
    if (abOn !== !!this._abWas) { this._abWas = abOn; this._emit('afterburner', { on: abOn }); }
    // stall event
    if (this.stalled !== !!this._stallWas) { this._stallWas = this.stalled; this._emit('stall', { on: this.stalled }); }
    // warnings
    this._warnTimer -= dt;
    if (this._warnTimer <= 0) { this._warnTimer = 0.2; this._updateWarnings(world); }
  }

  _updateVSpeeds() {
    const spec = this.spec, v = this.vSpeeds, sys = this.sys;
    const idx = Math.round(sys.flapPos);
    v.vs1g = this._vs1g(sys.flapPos, 0.2);
    v.vls = v.vs1g * (spec.vlsFactor ?? (this.fighter ? 1.2 : 1.23));
    v.vapp = v.vls + 5 * KT;
    const r = Math.sqrt(this.mass / (spec.vSpeedMass ?? spec.mass.typical));
    v.vr = spec.vRotate * r; v.v2 = (spec.v2 ?? spec.vRotate * 1.05) * r; v.vref = spec.vRef * r;
    const det = spec.flapDetents;
    v.vfe = det[clamp(idx, 0, det.length - 1)].vfe ?? 0;
    v.vfeNext = det[clamp(idx + 1, 0, det.length - 1)].vfe ?? 0;
    v.greenDot = this._vs1g(0, 0.3) * 1.28;
  }

  _updateWarnings(world) {
    const spec = this.spec, ad = this.ad, sys = this.sys, w = this.warnings, L = spec.limits;
    const air = !this.wow && this.agl > 3;
    const set = (k, on) => { if (w[k] !== on) { w[k] = on; this._emit('warning', { type: k, on }); } };
    // stall: 737 stick shaker ahead of the stall; FBW jets only when actually stalled
    let stall = this.stalled;
    if (this.law === 'conventional' && air) stall = stall || ad.alpha > this.fcs.st.alphaForCL((spec.fcs.shakerCL ?? 0.9) * this.lp.CLmax);
    set('stall', air && stall);
    // overspeed: VMO/MMO, flaps VFE, gear VLE
    const vfe = this.vSpeeds.vfe;
    const over = ad.ias > L.vmo + 1 || ad.M > L.mmo + 0.004 || (vfe > 0 && sys.flapPos > 0.05 && ad.ias > vfe + 2) || (sys.gear > 0.02 && L.vle && ad.ias > L.vle + 2);
    set('overspeed', over && !this.wow);
    // gear not down
    const landingFlaps = !this.fighter && sys.flapIndex >= (spec.landingFlapIndex ?? 99) - 1;
    const lowIdle = this.agl < 230 && this._lever < 0.15 && ad.vs < -1 && ad.ias < (this.fighter ? 110 : 95);
    set('gear', air && sys.gear < 0.98 && (landingFlaps || lowIdle));
    // bank angle (airliners)
    set('bank', air && !this.fighter && Math.abs(ad.phi) > 35 * DEG);
    // sink rate (GPWS mode 1 like), fighters only with the gear down
    const sinkLim = 5 + this.agl * 0.035;
    const sink = air && this.agl < 750 && -ad.vs > sinkLim && (!this.fighter || sys.gearHandleDown);
    set('sinkRate', sink);
    // pull up: predicted terrain / obstacle impact along the flight path, or an extreme sink rate close to the ground
    set('pullUp', air && (this._lookAhead(world) || (this.agl < 600 && -ad.vs > sinkLim * 1.6 + 3)));
  }

  _lookAhead(world) {
    if (!world) return false;
    const ad = this.ad;
    if (this.agl > 2500 || ad.V < 20) return false;
    const T = this.fighter ? 8 : 14;
    const vel = this.velocity, p = this._pos;
    const landing = this.sys.gear > 0.9;
    const rw = landing && world.runways ? runwayEnds(world.runways) : null;
    for (let t = 1; t <= T; t += 1) {
      const x = p.x + vel.x * t, z = p.z + vel.z * t, y = p.y + vel.y * t - this.gearHeight;
      let g = groundAt(world, x, z);
      const terrainHit = y < g;
      let obstacleHit;
      if (world.getObstacleSpan) {
        // spans ({ bottom, top }, bottom = -Infinity for solids): passing well below a bridge deck is not a threat
        const sp = world.getObstacleSpan(x, z);
        obstacleHit = !!sp && Number.isFinite(sp.top) && y < sp.top + 10 && !(y < sp.bottom - 10);
      } else {
        const obs = world.getObstacleHeight ? world.getObstacleHeight(x, z) : -Infinity;
        obstacleHit = Number.isFinite(obs) && y < obs + 10;
      }
      if (!terrainHit && !obstacleHit) continue;
      if (terrainHit && !obstacleHit && landing) {
        // landing: an impact point on or just short of a runway is the touchdown, not terrain
        if (world.isOnRunway && world.isOnRunway(x, z)) return false;
        if (rw) for (const r of rw) {
          const g2 = approachGeometry(r, x, z, this._geoTmp || (this._geoTmp = {}));
          if (Math.abs(g2.lateral) < 150 && g2.distThreshold > -3000 && g2.distThreshold < 1500) return false;
        }
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------ ground contact
  _ground(h, inp, world) {
    const spec = this.spec, G = spec.gear, sys = this.sys, ad = this.ad;
    const pos = this._pos, quat = this._quat, vel = this.velocity, omega = this._omega;
    const m = this.mass;
    const gCG = groundAt(world, pos.x, pos.z);
    this._aglCG = pos.y - gCG - this.gearHeight;
    this._stuck = false;
    const near = pos.y - gCG < this._reach + 8 || this._contact;
    let anyContact = false, wheelContact = false, wheelsDown = 0, mainLoad = 0, capLong = 0, capLat = 0;
    _omegaW.copy(omega).applyQuaternion(quat);
    _Ffric.set(0, 0, 0); _Tfric.set(0, 0, 0);
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    if (!near) {
      for (const w of this._wheels) { w.contact = false; w.load = 0; w.comp = 0; }
      this._tailWas = false;
    } else {
      if (this._checkStructure(world, h)) return true;
      const gs = Math.hypot(vel.x, vel.z);
      const onRunway = this._onRunway;
      // nose wheel steering: tiller at taxi speeds, pedal range at speed
      const tiller = (G.steerMax ?? 70) * DEG / (1 + (gs / 6) ** 2);
      const steerMax = Math.max(tiller, (G.steerPedal ?? 7) * DEG);
      const pedalIn = this.apOut.active && this.apOut.pedal != null ? this.apOut.pedal : clamp(inp.yaw ?? 0, -1, 1);
      const steer = sys.gear > 0.98 ? pedalIn * steerMax : 0;
      this._steer = steer;
      const locked = sys.gear > 0.98;
      for (const w of this._wheels) {
        w.contact = false; w.load = 0; w.comp = 0;
        if (!locked) continue;
        _rw.copy(w.r).applyQuaternion(quat);
        _pw.copy(pos).add(_rw);
        const gh = groundAt(world, _pw.x, _pw.z);
        const pen = gh - _pw.y;
        if (pen <= 0) continue;
        if (isWater(world, _pw.x, _pw.z)) { this._crash('Uçak suya düştü'); return true; }
        this._groundNormal(world, _pw.x, _pw.z, gh, _n);
        if (_n.y < 0.6) { this._crash('Uçak araziye çarptı'); return true; }
        const d = pen * _n.y;
        _vc.crossVectors(_omegaW, _rw).add(vel);
        const vn = _vc.dot(_n);
        if (!this._contact && vn < -(G.maxSink ?? 4.5)) { this._crash(vn < -8 ? 'Uçak yere çakıldı' : 'Çok sert iniş: iniş takımı kırıldı'); return true; }
        if (d > this._s0 + (G.stroke ?? 0.35) + 0.15) { this._crash('İniş takımı kırıldı'); return true; }
        let N = w.k * d * (1 + (d / this._bump) ** 2) - w.c * vn;
        N = clamp(N, 0, 20 * m * G0);
        // VisualState.gearCompression: 0 = fully extended, 0.35 at the static load, 1 ≈ bottomed
        w.contact = true; w.load = N; w.comp = clamp((0.35 * d) / this._s0, 0, 1);
        anyContact = true; wheelContact = true; wheelsDown++;
        if (w.kind === 'main') mainLoad += N;
        // tire frame
        _wf.copy(_fwd).addScaledVector(_n, -_fwd.dot(_n)).normalize();
        if (w.steer && steer !== 0) _wf.applyAxisAngle(_n, -steer);
        _wl.crossVectors(_wf, _n);
        const vLong = _vc.dot(_wf), vLat = _vc.dot(_wl);
        let mu = onRunway ? (G.rollingFriction ?? 0.015) : (G.rollingFrictionGrass ?? 0.05);
        if (w.brake) mu += (G.brakeFriction ?? 0.45) * (onRunway ? 1 : 0.6) * sys.brake;
        const muLat = onRunway ? (G.lateralFriction ?? 0.7) : 0.5;
        const kLong = N / 0.08, kLat = N / 0.06;
        const fLong = -clamp(vLong * kLong, -mu * N, mu * N);
        const fLat = -clamp(vLat * kLat, -muLat * N, muLat * N);
        const muS = mu + (w.brake ? 0 : 0) + (Math.abs(vLong) < 0.3 ? (G.breakaway ?? 0.012) : 0);
        capLong += muS * N; capLat += muLat * N;
        _v1.copy(_n).multiplyScalar(N);
        _Fw.add(_v1); _Tw.add(_v2.crossVectors(_rw, _v1));
        _v1.copy(_wf).multiplyScalar(fLong).addScaledVector(_wl, fLat);
        _Ffric.add(_v1); _Tfric.add(_v2.crossVectors(_rw, _v1));
      }
      // tail skid (soft structure contact: tail strike)
      const tail = this._structure.find((s) => s.kind === 'tail');
      this.tailStrike = false;
      if (tail) {
        _rw.copy(tail.r).applyQuaternion(quat);
        _pw.copy(pos).add(_rw);
        const ght = groundAt(world, _pw.x, _pw.z);
        const pent = ght - _pw.y;
        if (pent > 0) {
          _vc.crossVectors(_omegaW, _rw).add(vel);
          if (isWater(world, _pw.x, _pw.z)) { this._crash('Uçak suya düştü'); return true; }
          if ((!this._tailWas && _vc.y < -2.5) || pent > 0.6) { this._crash(sys.gear < 0.98 ? 'İniş takımları açılmadan gövde üzerine inildi' : 'Kuyruk yere sert çarptı'); return true; }
          let N = 8 * m * G0 * pent - 0.5 * m * _vc.y;
          if (N < 0) N = 0;
          _v1.set(0, N, 0);
          _v3.set(_vc.x, 0, _vc.z);
          const sp = _v3.length();
          if (sp > 1e-4) _v1.addScaledVector(_v3, -Math.min(0.5 * N, sp * m) / sp);
          _Fw.add(_v1); _Tw.add(_v2.crossVectors(_rw, _v1));
          anyContact = true; this.tailStrike = true;
        }
        if (this.tailStrike && !this._tailWas) this._emit('warning', { type: 'tailStrike', on: true });
        this._tailWas = this.tailStrike;
      }
    }
    this.wow = mainLoad > 0.05 * m * G0 || (wheelContact && this._contact && this.groundSpeed < 1);

    // ---- touchdown / takeoff events ----
    const V = ad.V;
    if (wheelContact && !this._contact) {
      const vs = vel.y;
      const e = _euler.setFromQuaternion(quat, 'YXZ');
      const pitchDeg = e.x / DEG, rollDeg = -e.z / DEG;
      if (vs < -(G.maxSink ?? 4.5)) { this._crash('Çok sert iniş'); return true; }
      if (Math.abs(rollDeg) > (spec.structure?.maxTouchdownBank ?? 20)) { this._crash('Yatış açısı çok fazlaydı, kanat yere vurdu'); return true; }
      if (pitchDeg < -8) { this._crash('Burun tekerleği önce yere çarptı'); return true; }
      if (this._airTime > 1) {
        this._takeoffArmed = true;
        this._emit('touchdown', { verticalSpeed: vs, onRunway: world && world.isOnRunway ? !!world.isOnRunway(pos.x, pos.z) : false, pitch: pitchDeg, roll: rollDeg });
      }
      this._airTime = 0;
    }
    if (anyContact) {
      this._noContactTime = 0; this._groundTime += h;
      if (this._groundTime > 2) this._takeoffArmed = true;
      this._liftoff = null;
      if (V > 25 && wheelContact) this._fastRoll = true;
    } else {
      if (this._noContactTime === 0 && this._fastRoll) this._liftoff = { x: pos.x, z: pos.z, airspeed: V, ias: ad.ias };
      this._noContactTime += h; this._groundTime = 0;
      if (this._aglCG > 1) this._airTime += h;
      if (this._fastRoll && this._noContactTime > 0.5 && this._liftoff) {
        this._fastRoll = false;
        if (this._takeoffArmed) { this._takeoffArmed = false; this._emit('takeoff', { ...this._liftoff }); }
      }
    }
    this._contact = anyContact;

    // ---- static friction: hold still when the tires can take everything ----
    if (wheelsDown >= 2 && V < 0.05 && omega.lengthSq() < 0.0025) {
      _v1.copy(_Fw); _v1.y -= m * G0;
      _wf.copy(_fwd); _wf.y = 0; _wf.normalize();
      _wl.set(-_wf.z, 0, _wf.x);
      this._stuck = Math.abs(_v1.dot(_wf)) < capLong && Math.abs(_v1.dot(_wl)) < capLat;
    }
    if (!this._stuck) { _Fw.add(_Ffric); _Tw.add(_Tfric); }
    // deceleration along the track (autobrake feedback)
    const gsNow = Math.hypot(vel.x, vel.z);
    if (gsNow > 0.5) this._decel = lerp(this._decel ?? 0, -(_Fw.x * vel.x + _Fw.z * vel.z) / (gsNow * m), 0.05);
    this.groundSpeed = gsNow;
    return false;
  }

  _groundNormal(world, x, z, h0, out) {
    const hx = groundAt(world, x + 0.5, z) - h0;
    const hz = groundAt(world, x, z + 0.5) - h0;
    return out.set(-hx / 0.5, 1, -hz / 0.5).normalize();
  }

  _checkStructure(world, h) {
    for (const s of this._structure) {
      if (s.kind === 'tail') continue;
      _pw.copy(s.r).applyQuaternion(this._quat).add(this._pos);
      const g = groundAt(world, _pw.x, _pw.z);
      if (_pw.y < g) {
        const water = isWater(world, _pw.x, _pw.z);
        let reason = s.reason;
        if (water) reason = 'Uçak suya düştü';
        else if (s.kind === 'belly' && this.sys.gear < 0.98) reason = 'İniş takımları açılmadan gövde üzerine inildi';
        else if (this.ad.V > 40 && this._airTime > 2 && (s.kind === 'nose' || s.kind === 'top')) reason = 'Uçak yere çakıldı';
        this._crash(reason);
        return true;
      }
    }
    return false;
  }

  _obstacleHit(world) {
    const p = this._pos;
    // broad phase: bounding sphere; narrow phase: fuselage / wing spheres
    const coarse = world.hitTest(p.x, p.y, p.z, this._hitRadius);
    if (!coarse) return false;
    for (const s of this._hitSpheres) {
      _pw.copy(s.r).applyQuaternion(this._quat).add(p);
      const hit = world.hitTest(_pw.x, _pw.y, _pw.z, s.rad);
      if (hit) { this._crash(`${turkishDative(hit)} çarptı`); return true; }
    }
    return false;
  }

  _crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.velocity.set(0, 0, 0);
    this._omega.set(0, 0, 0);
    if (this.autopilot.on) { this.autopilot.on = false; this.autopilot.mode = ''; this.apOut.active = false; }
    this._emit('crash', { reason, position: this._pos.clone() });
  }

  // ------------------------------------------------------------------------------------------ readouts
  _updateReadouts(world, t) {
    const spec = this.spec, ad = this.ad, sys = this.sys;
    this.position.lerpVectors(this._prevPos, this._pos, t);
    this.quaternion.slerpQuaternions(this._prevQuat, this._quat, t);
    this._airData(world);
    this.airspeed = ad.V; this.ias = ad.ias; this.mach = ad.M;
    this.altitude = this.position.y;
    const g = groundAt(world, this.position.x, this.position.z);
    this.agl = Math.max(0, this.position.y - this.gearHeight - g);
    const e = _euler.setFromQuaternion(this._quat, 'YXZ');
    this.heading = wrap360(-e.y / DEG);
    this.pitch = e.x / DEG;
    this.roll = -e.z / DEG;
    this.verticalSpeed = this.velocity.y;
    this.gForce = this._gSmooth;
    this.aoa = ad.alpha / DEG;
    this.sideslip = ad.beta / DEG;
    this.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.throttle = this._effectiveLever();
    this.onGround = this._contact;
    this.aileron = this.act.aileron; this.elevator = this.act.elevator; this.rudder = this.act.rudder; this.trim = this.act.trim;
    this.gear = sys.gear; this.gearHandleDown = sys.gearHandleDown;
    this.flaps = this.cfg.flap; this.slats = this.cfg.slats;
    const det = spec.flapDetents;
    this.flapsIndex = this.fighter ? (sys.altFlaps || sys.gearHandleDown ? 1 : 0) : sys.flapIndex;
    this.flapsLabel = det[Math.min(this.flapsIndex, det.length - 1)].label;
    this.spoilers = sys.spoilers; this.speedbrake = sys.speedbrake;
    this.reverser = this.pp.st.rev; this.brakes = sys.brake; this.parkingBrake = sys.parkingBrake;
    this.autobrake = sys.autobrake;
    this.canopy = sys.canopy;
    this.tvc.pitch = this.act.tvc;
    // buffet 0..1 (extra readout for camera shake / audio): approach to the stall, Mach buffet, speedbrake
    const stallBuf = smoothstep(this.lp.alphaStall - 4 * DEG, this.lp.alphaStall + 2 * DEG, ad.alpha);
    const machBuf = this.fighter ? 0.25 * smoothstep(0.93, 1.0, ad.M) * (1 - smoothstep(1.05, 1.15, ad.M)) : smoothstep(spec.limits.mmo, spec.limits.mmo + 0.05, ad.M);
    const sbBuf = (sys.speedbrake * 0.25 + sys.spoilers * 0.15) * smoothstep(60, 160, ad.V);
    this.buffet = this._contact ? 0 : clamp(Math.max(stallBuf, machBuf, sbBuf), 0, 1);
    // stall state (hysteresis)
    const as = this.lp.alphaStall;
    if (this._contact || ad.V < 5) this.stalled = false;
    else if (!this.stalled && ad.alpha > as + 0.5 * DEG) this.stalled = true;
    else if (this.stalled && ad.alpha < as - 1 * DEG) this.stalled = false;
  }

  getVisualState() {
    const v = this._visual, sys = this.sys, spec = this.spec;
    // VisualState follows the contract unit rule (radians); the readable flight.aoa / pitch / roll are degrees
    v.time = this._time; v.airspeed = this.airspeed; v.mach = this.mach; v.onGround = this.onGround; v.aoa = this.ad.alpha;
    v.aileron = this.act.aileron; v.elevator = clamp(this.act.elevator + (this.fighter ? 0 : 0), -1, 1); v.rudder = this.act.rudder;
    v.flaps = this.cfg.flap; v.slats = this.cfg.slats;
    if (this.fighter) {
      // leading-edge flaps: F-16 schedule 1.38 alpha - 9.05 qbar/ps + 1.45 (deg), 0..25°
      const ad = this.ad;
      const lef = clamp(1.38 * (ad.alpha / DEG) - 9.05 * (ad.qbar / Math.max(ad.delta * 101325, 1)) + 1.45, 0, 25) / 25;
      v.slats = this.wow && ad.V < 30 ? 0 : lef;
    }
    v.spoilers = sys.spoilers; v.speedbrake = sys.speedbrake; v.gear = sys.gear;
    for (let i = 0; i < this._wheels.length; i++) v.gearCompression[i] = this._wheels[i].comp;
    v.wheelSpeed = this.onGround ? this.groundSpeed : v.wheelSpeed * 0.995;
    const lever = this._effectiveLever();
    for (let i = 0; i < this.engines.length; i++) {
      const e = this.engines[i], o = v.engines[i];
      o.n1 = e.n1; o.throttle = lever; o.afterburner = e.afterburner; o.nozzle = e.nozzle; o.reverser = e.reverser;
    }
    v.tvc.pitch = this.act.tvc; v.tvc.yaw = 0;
    v.canopy = sys.canopy;
    v.buffet = this.buffet;
    v.steer = this.onGround && sys.gear > 0.98 ? (this._steer ?? 0) : 0;     // nose-wheel angle (rad, + = right), extra
    const L = v.lights, on = sys.lightsOn;
    L.nav = on; L.beacon = on;
    L.strobe = on && (!this.onGround || this.groundSpeed > 15 || this._lever > 0.5);
    L.landing = on && sys.gear > 0.5 && (this.altitude < 3050 || this.onGround) && (!this.onGround || this.groundSpeed > 10 || this._lever > 0.5);
    L.taxi = on && this.onGround && sys.gear > 0.9;
    return v;
  }
}
