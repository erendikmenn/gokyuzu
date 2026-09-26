// Assisted flight ("Destekli uçuş"): a beginner layer on top of the flight models, on by default (settings.assist).
//
//   const a = flight.setAssist(true)        // FixedWingModel / HelicopterModel: creates the layer (null = off)
//   a.on                                    // false: the model runs exactly as without the layer
//   a.requestApproach() / a.cancelApproach()   // "İnişe geç": assisted approach to the nearest suitable runway
//   a.cue, a.prot, a.app, a.at, a.phase     // read by the HUD guidance (src/ui/assist-hud.js); numbers / short codes
//   flight.on('assist', (e) => …)           // e.type: 'power' | 'overspeed' | 'pullUp' | 'gear' | 'flaps' | 'speedbrake' |
//                                           //   'atOff' | 'approach' | 'noRunway' | 'goAround' | 'landed' | 'hover' |
//                                           //   'rotate' | 'takeoffPower' | 'water' | 'forward' | 'brake' (UI messages)
//
// The layer never changes the flight model's physics: it shapes the player's inputs before the model step and, in
// flight, sends demands through the model's own flight-control path (the autopilot's apOut: load factor, roll rate and
// thrust, which every control law already tracks with its NDI loops). Hooks in the models: FixedWingModel.step
// (input filter), createAutopilot().update (the assisted law when the autopilot is off), reset(); HelicopterModel.step.
// With the layer off (or never created) every hook is skipped: behaviour identical to the plain models.
//
// Fixed wing, phase by phase:
//   ground      stick sideways = nose-wheel steering (no aileron on the wheels: wing-tip strikes on the take-off roll
//               were the most common phone crash); the first throttle push goes to take-off power (lever moved, the
//               player sees it); centreline tracking on the take-off roll and the landing roll-out; no nose-up before
//               VR − 3 kt; at VR "Burnu kaldır": holding pitch-up rotates to a safe attitude (below the tail-strike
//               angle), a runway running out rotates by itself.
//   initial     lift-off → the flight law: climb attitude, wings level (≤ 10°), gear-up cue at a positive rate.
//   flight      assisted law: stick = flight-path rate (pitch) and roll rate; released = hold, then level (wings level,
//               level flight; after take-off a climb to a safe height); limits: bank 35° (less near the ground),
//               pitch, flight path, AoA (below the stall, all types), load factor; low speed → nose down + take-off
//               power; overspeed → nose up + less power; terrain / obstacle look-ahead (PULL UP) and a sink floor near the
//               ground → climb, wings level; gear down near the ground: sink rate limited (assisted flare).
//   approach    "İnişe geç" or the gear lowered near a runway: the nearest runway end that takes landings (not
//               departure-only, not a backup runway, long enough); a gate on the extended centreline, then the
//               localizer and the 3° glide path (the flight-director "magnet" acts when the stick is released: the
//               player steers whenever they want), approach speed held (auto thrust; moving the lever gives the thrust
//               back), gear / flaps / speedbrake automation, flare + retard, then idle, autobrake / wheel brakes and the
//               centreline on the roll-out.
// Helicopter: collective raised on the ground → assisted lift-off (the lever rises to the hover collective) and the
// hover hold (AFCS) at ~8 m; pushing forward for a while hands over to forward flight; near the ground the sink rate is
// limited (the lever comes up), attitude limits; "İnişe geç" = slow down, hover, coupled vertical descent (not onto water).
// Units: SI, radians inside; no DOM (runs in Node: tests/assist.test.mjs). No allocations per frame.
import { DEG, KT, G0, clamp, lerp, smoothstep, moveToward, wrapPi } from './fixedwing-util.js';
import { runwayEnds, approachGeometry, findApproach } from './fixedwing-autopilot.js';

const TAN_GS = Math.tan(3 * DEG);
const AIM = 300;                               // glide-path aim point past the threshold (fixedwing-autopilot.js)
/** İstanbul Havalimanı's backup runways ("yedek pist", src/missions/ist/catalog.js): never an assisted approach target. */
export const BACKUP_RUNWAYS = new Set(['LTFM 16L', 'LTFM 34R', 'LTFM 17R', 'LTFM 35L']);

// tunables per category (degrees, knots, metres, seconds)
const FW = {
  airliner: {
    bank: 35, bankApp: 25, pitchUp: 18, pitchDown: -10, gMax: 12, gMin: -8, gdot: 4, pRate: 12, climb: 6, climbPitch: 12,
    nMax: 1.8, nMin: 0.3, safeAgl: 450, gate: 7000, pull: 6, sinkMin: 0.9, sinkMax: 6, retard: 6, minRunway: 1600,
    appKt: 210, kth: 0.10, kq: 0.10,
  },
  fighter: {
    bank: 35, bankApp: 30, pitchUp: 25, pitchDown: -15, gMax: 20, gMin: -12, gdot: 8, pRate: 50, climb: 10, climbPitch: 14,
    nMax: 4, nMin: -0.5, safeAgl: 450, gate: 5500, pull: 10, sinkMin: 1.2, sinkMax: 8, retard: 4, minRunway: 1400,
    appKt: 250, kth: 0.06, kq: 0.05,
  },
};

const HOLD = null;

/** The layer for a model (FixedWingModel or HelicopterModel). */
export function createAssist(m) {
  return (m.spec && m.spec.category === 'helicopter') ? new HeliAssist(m) : new FixedWingAssist(m);
}

/** Runway-end candidates of a world for an assisted approach (landing ends, no backup runways, long enough). */
export function landingEnds(runways, minLength = 0) {
  const out = [];
  for (const e of runwayEnds(runways)) {
    if (!e.landing || BACKUP_RUNWAYS.has(e.name) || e.backup) continue;
    if (e.length - (e.displaced || 0) < minLength) continue;
    out.push(e);
  }
  return out;
}

/** Runway (end) the point lies on, pointing within 35° of `psi` (take-off roll / roll-out), or null. */
export function runwayUnder(runways, x, z, psi) {
  let best = null, bestLat = Infinity;
  for (const e of runwayEnds(runways)) {
    const vx = x - e.px, vz = z - e.pz;
    const along = vx * e.dx + vz * e.dz, lat = vx * -e.dz + vz * e.dx;
    if (along < -60 || along > e.length + 60 || Math.abs(lat) > e.width / 2 + 20) continue;
    if (Math.abs(wrapPi(psi - e.course)) > 35 * DEG) continue;
    if (Math.abs(lat) < bestLat) { bestLat = Math.abs(lat); best = e; }
  }
  return best;
}

/**
 * Pick the runway end for "İnişe geç": an end whose final the aircraft is already on (findApproach), else the end with
 * the shortest way to its gate (distance + the turns on the way there, 1 km per 45°).
 */
export function pickRunway(runways, x, z, psi, { gate = 7000, minLength = 1600 } = {}) {
  const ends = landingEnds(runways, minLength);
  if (!ends.length) return null;
  const onFinal = findApproach(runways, x, z, psi, gate + 6000);
  if (onFinal && ends.includes(onFinal)) return onFinal;
  let best = null, bestCost = Infinity;
  for (const e of ends) {
    const gx = e.x - e.dx * gate, gz = e.z - e.dz * gate;
    const d = Math.hypot(gx - x, gz - z);
    const brg = Math.atan2(gx - x, -(gz - z));
    const turn1 = Math.abs(wrapPi(brg - psi)), turn2 = Math.abs(wrapPi(e.course - brg));
    const cost = d + ((turn1 + turn2) / (45 * DEG)) * 1000;
    if (cost < bestCost) { bestCost = cost; best = e; }
  }
  return best;
}

// ================================================================================================ fixed wing
class FixedWingAssist {
  constructor(m) {
    this.m = m;
    this.kind = 'fixedwing';
    this.cat = m.spec.category === 'fighter' ? 'fighter' : 'airliner';
    this.C = FW[this.cat];
    const spec = m.spec;
    this.Kg = spec.autopilot?.Kgamma ?? (this.cat === 'fighter' ? 1.2 : 0.8);
    this.toPower = this.cat === 'fighter' ? (spec.abDetent ?? 0.9) : 0.9;
    this.rotPitch = this.cat === 'fighter' ? 11 : Math.min(10, (m.tailStrikeDeg ?? 12) - 2.5);
    this.on = false;
    this.out = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
    this.app = null;                              // assisted approach (see requestApproach)
    this.at = { on: false, tgt: 0, I: 0, rate: 0, prev: -1, lever0: 0 };   // auto thrust (approach speed)
    this.geo = {};
    this.reset();
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    if (!on) { this.cancelApproach(true); this.at.on = false; this.cue = ''; this.prot = ''; }
    this.lawT = -1;
  }

  reset() {
    this.phase = 'ground';
    this.cue = ''; this.prot = ''; this.protT = 0;
    this.gRef = 0; this.gT = 0; this.gFloor = -Infinity; this.gCeil = Infinity; this.relP = 9; this.gSlew = DEG;
    this.phiRef = HOLD; this.phiT = 0; this.relR = 9; this.bankMax = this.C.bank * DEG; this.thMax = this.C.pitchUp * DEG;
    this.nAlpha = 9; this.retard = false; this.power = null;
    this.airT = 0; this.gndT = 0; this.climbout = false; this.theta0 = 0;
    this.toSet = false; this.powerSet = false; this.overSet = false; this.pullSet = false; this.rotAuto = false;
    this.rw = null; this.rwT = 0; this.lastLever = 0; this.lawT = -1; this.idleSet = false; this.touchT = 0;
    this.gearCueT = 0; this.landedApp = false;
    this.app = null;
    this.at.on = false;
  }

  _emit(type, extra) { this.m._emit('assist', extra ? Object.assign({ type }, extra) : { type }); }

  // ------------------------------------------------------------------------------------------ approach mode
  /** "İnişe geç": the nearest suitable runway, guidance, auto thrust and the configuration. false when not possible. */
  requestApproach(world = this.world) {
    const m = this.m;
    if (!this.on || m.crashed || m.wow || m.onGround) { this._emit('noRunway', { why: 'ground' }); return false; }
    const runways = world && world.runways;
    const rw = runways ? pickRunway(runways, m._pos.x, m._pos.z, m.ad.psi, { gate: this.C.gate, minLength: this.C.minRunway }) : null;
    if (!rw) { this._emit('noRunway', { why: 'none' }); return false; }
    this._startApproach(rw, 'button');
    return true;
  }

  _startApproach(rw, via) {
    const m = this.m;
    this.app = {
      rw, name: rw.name, via, stage: 'gate', gateDist: this.C.gate, gT: 0, phiT: 0, trackCmd: rw.course,
      along: 0, lateral: 0, dist: 0, vert: 0, dir: 0, glide: 0, cfgT: 1, sb: false, gearSet: false, t: 0,
    };
    this.climbout = false;
    if (m.autopilot.on) m.ap.disengage('assist');
    this._atEngage();
    this._emit('approach', { runway: rw.name, via });
  }

  cancelApproach(silent = false) {
    if (!this.app) return;
    const a = this.app;
    this.app = null;
    if (a.sb && this.m.sys.speedbrakeCmd) this.m.command('speedbrake');
    if (this.at.on) this._atOff(false);
    if (!silent) this._emit('approach', { off: true });
  }

  _atEngage() {
    const at = this.at, m = this.m;
    at.on = true; at.I = m._leverPower(); at.prev = -1; at.rate = 0; at.lever0 = this.lastLever; at.tgt = m.ias; at.bias = 0;
  }

  /** Auto thrust off: the lever takes the present thrust (no jump), or idle. */
  _atOff(toIdle) {
    const m = this.m;
    this.at.on = false;
    m.pendingThrottle = toIdle ? 0 : clamp(m._effectiveLever(), 0, 1);
    m._leverTarget = m.pendingThrottle; m._leverLatched = true; m._leverRef = null; m._lever = m._leverTarget;
  }

  // ------------------------------------------------------------------------------------------ per frame
  /** Input filter (FixedWingModel.step): returns the input the model flies this frame. */
  input(dt, raw, world) {
    const m = this.m, o = this.out, C = this.C;
    this.world = world;
    o.pitch = clamp(Number(raw.pitch) || 0, -1, 1); o.roll = clamp(Number(raw.roll) || 0, -1, 1);
    o.yaw = clamp(Number(raw.yaw) || 0, -1, 1); o.brake = clamp(Number(raw.brake) || 0, 0, 1);
    o.throttle = clamp(Number.isFinite(raw.throttle) ? raw.throttle : 0, 0, 1);
    const lever = o.throttle;
    if (m.crashed || m.ditched || dt <= 0) { this.lastLever = lever; return raw; }
    const ground = m.wow || m.onGround;
    // ---- phase
    if (ground) {
      this.gndT += dt;
      if ((this.phase === 'flight' || this.phase === 'initial') && this.climbout && this.airT < 6 && !this.app) {
        this.phase = 'takeoff'; this.toSet = true;              // a hop during the rotation: still the take-off
      } else if (this.phase === 'flight' || this.phase === 'initial') {
        this.phase = m.groundSpeed > 15 ? 'rollout' : 'ground';
        this.touchT = 0; this.idleSet = false;
        this.rw = this.app ? this.app.rw : (world && world.runways ? runwayUnder(world.runways, m._pos.x, m._pos.z, m.ad.psi) : null);
        if (this.app) { this.landedApp = true; this.app.stage = 'rollout'; }
        if (this.at.on) this._atOff(true);
      }
      this.airT = 0;
    } else {
      this.gndT = 0; this.airT += dt;
      if (this.phase === 'ground' || this.phase === 'takeoff' || this.phase === 'rollout') {
        this.climbout = this.phase === 'takeoff' || (this.phase === 'ground' && !this.landedApp);
        if (this.phase === 'rollout') this.climbout = false;
        this.phase = 'initial'; this.theta0 = m.ad.theta;
        this.rw = null; this.rotAuto = false;
      }
      if (this.phase === 'initial' && this.airT > 1 && m.fcs.st.blend > 0.95) { this.phase = 'flight'; this.lawT = -1; }
    }
    if (m.autopilot.on) {   // the autopilot flies: no assisted law, the guidance stays for the HUD
      if (this.app) { this._approachFrame(dt, world); if (this.at.on) this.at.on = false; }
      this.cue = ''; this.prot = '';
      this.lastLever = lever;
      return raw;
    }
    let res = o;
    if (ground) res = this._groundFrame(dt, raw, world, lever);
    else if (this.phase === 'initial') this._initialFrame(dt);
    else this._flightFrame(dt, world, lever);
    // the player moves the lever while the thrust is automatic: small moves nudge the speed target (like the autopilot's
    // speed knob), a big one (take-off / go-around power, or back to idle from high up) gives the thrust back
    if (this.at.on) {
      const d = lever - this.lastLever;
      if (lever > 0.95 && d > 0) { this.at.on = false; this._emit('atOff'); }      // full power: the player's go-around
      else if (d) this.at.bias = clamp((this.at.bias || 0) + d * 60 * KT, -10 * KT, 25 * KT);
    }
    this.lastLever = lever;
    return res;
  }

  _groundFrame(dt, raw, world, lever) {
    const m = this.m, o = this.out, C = this.C, ad = m.ad;
    const gs = m.groundSpeed, kt = m.ias / KT;
    this.prot = ''; this.power = null;
    // stick sideways steers the nose wheel, less and less with speed (a full pedal at take-off speed rolls a fighter onto
    // a wing tip); the ailerons keep the wings level on the wheels instead of rolling the aircraft
    const steer = Math.abs(o.yaw) >= Math.abs(o.roll) ? o.yaw : o.roll;
    o.yaw = steer * clamp(1 - (gs - 6) / 20, 0.06, 1);
    if (gs > 12) o.yaw -= clamp(0.06 * (ad.r / DEG), -0.3, 0.3);            // yaw-rate damping at speed
    o.roll = gs > 12 ? clamp(-0.15 * (ad.phi / DEG) - 0.05 * (ad.p / DEG), -1, 1) : 0;
    // ---- phase on the ground: take-off roll / roll-out / stopped
    if (this.phase === 'rollout') {
      this.touchT += dt;
      if (gs < 1) {
        this.phase = 'ground';
        if (lever < 0.08) m.sys.parkingBrake = true;          // stays put until the throttle moves (the model releases it)
        if (this.app) { this.app = null; this._emit('landed', { runway: this.rw ? this.rw.name : '' }); }
      }
    } else if (this.phase === 'ground' && lever > 0.12 && gs < 30) {
      this.phase = 'takeoff'; this.toSet = false; this.landedApp = false;
      this.rw = world && world.runways ? runwayUnder(world.runways, m._pos.x, m._pos.z, ad.psi) : null;
    } else if (this.phase === 'takeoff' && gs < 2 && lever < 0.1) this.phase = 'ground';
    // ---- throttle: the first push goes to take-off power (once per roll)
    if (this.phase === 'takeoff' && !this.toSet && lever < this.toPower - 0.03 && lever > this.lastLever && gs < 25) {
      this.toSet = true;
      m.pendingThrottle = this.toPower;
      this._emit('takeoffPower');
    }
    if (this.phase === 'takeoff' && lever >= this.toPower - 0.03) this.toSet = true;
    // ---- centreline (take-off roll, roll-out)
    if ((this.phase === 'takeoff' || this.phase === 'rollout') && gs > 12) {
      if (!this.rw && world && world.runways && (this.rwT -= dt) <= 0) { this.rwT = 0.5; this.rw = runwayUnder(world.runways, m._pos.x, m._pos.z, ad.psi); }
      const rw = this.rw;
      if (rw) {
        const vx = m._pos.x - rw.px, vz = m._pos.z - rw.pz;
        const lat = vx * -rw.dz + vz * rw.dx;
        const hdgE = wrapPi(ad.psi - rw.course) / DEG;
        if (Math.abs(lat) < rw.width / 2 + 10 && Math.abs(hdgE) < 30) {   // on the runway only: never a swerve at speed
          const k = Math.abs(steer) > 0.3 ? 0.35 : 1, lim = gs > 20 ? 0.12 : 0.4;
          o.yaw = clamp(o.yaw + k * clamp(-(clamp(lat * 0.04, -0.3, 0.3) + hdgE * 0.12), -lim, lim), -1, 1);
        }
      }
    }
    // ---- rotation
    this.cue = '';
    if (this.phase === 'takeoff') {
      const vr = m.vSpeeds.vr || 60;
      if (lever < 0.1 && gs < 5) this.cue = 'thr';
      if (o.pitch < 0 && gs > 10) o.pitch = 0;  // no push on the roll (the nose wheel carries it: "wheelbarrowing")
      if (m.ias < vr - 3 * KT) {
        if (o.pitch > 0) o.pitch = 0;           // no early rotation (tail strike, a stall just after lift-off)
      } else {
        this.cue = 'rotate';
        // runway running out at rotation speed: rotate anyway
        let short = false;
        if (this.rw && m.ias > vr + 3 * KT) {
          const along = (m._pos.x - this.rw.px) * this.rw.dx + (m._pos.z - this.rw.pz) * this.rw.dz;
          short = this.rw.length - along < Math.max(600, 0.3 * this.rw.length);
        }
        if (short && !this.rotAuto) { this.rotAuto = true; this._emit('rotate'); }
        if (o.pitch > 0.15 || this.rotAuto) {
          const th = ad.theta / DEG, q = ad.q / DEG;
          o.pitch = clamp(0.25 * (this.rotPitch - th) - 0.15 * q + 0.15, 0, 1);
          if (th > this.rotPitch + 0.5) o.pitch = Math.min(o.pitch, 0);
        }
      }
    } else if (this.phase === 'rollout') {
      // idle once (ground spoilers / autobrake); wheel brakes for types without autobrake
      if (!this.idleSet) { this.idleSet = true; if (lever > 0.08) m.pendingThrottle = 0; o.throttle = 0; }
      const advancing = lever > 0.6 && lever > this.lastLever;   // touch-and-go: the player's call
      if (advancing) this.phase = 'takeoff';
      else if (!m.sys.autobrake && this.touchT > 1 && gs > 0.3 && o.brake < 0.6) o.brake = 0.6;   // wheel brakes to a stop
      if (o.pitch > 0 && m.ias < (m.vSpeeds.vr || 60) - 10 * KT) o.pitch *= 0.5;
    } else if (lever < 0.1 && gs < 3 && this.gndT > 3 && this._onRunway(world)) this.cue = 'thr';
    return o;
  }

  _onRunway(world) {
    const m = this.m;
    return !!(world && world.isOnRunway && world.isOnRunway(m._pos.x, m._pos.z));
  }

  /** Lift-off → flight law (the control law blends from ground to flight): climb attitude, wings level. */
  _initialFrame(dt) {
    const m = this.m, o = this.out, C = this.C, ad = m.ad;
    const th = ad.theta / DEG, q = ad.q / DEG, phi = ad.phi / DEG, p = ad.p / DEG;
    let tt = this.climbout ? Math.min(C.climbPitch, this.rotPitch + 2) : clamp(this.theta0 / DEG, 2, 8);
    if (o.pitch < -0.3) tt -= 5;
    // stall protection before the flight law: nose down when slow
    const vMin = this._vProt();
    if (m.ias < vMin) tt -= clamp((vMin - m.ias) / KT, 0, 10);
    const kth = C.kth * (m.law === 'conventional' ? 1.4 : 1);
    o.pitch = clamp(kth * (tt - th) - C.kq * q, -1, 1);
    const rollIn = o.roll;
    o.roll = clamp(0.05 * (0 - phi) - 0.03 * p, -0.4, 0.4);
    if (Math.abs(phi) < 10 || Math.sign(rollIn) !== Math.sign(phi)) o.roll = clamp(o.roll + 0.35 * rollIn, -1, 1);
    this.cue = m.gearHandleDown && m.verticalSpeed > 1 && m.agl > 8 ? 'gearUp' : '';
    this.prot = '';
    this.gRef = ad.gamma; this.phiRef = HOLD;
  }

  _flightFrame(dt, world, lever) {
    const m = this.m, C = this.C, ad = m.ad, sys = m.sys, w = m.warnings;
    const V = Math.max(ad.V, 30), agl = m.agl, ias = m.ias, vs = m.verticalSpeed;
    let gT = 0, phiT = 0, gFloor = -Infinity, gCeil = Infinity, prot = '';
    let bankMax = C.bank * DEG;
    this.power = null; this.retard = false;
    // automatic approach mode: gear lowered near a runway
    if (!this.app && sys.gearHandleDown && agl > 60 && world && world.runways && (this.rwT -= dt) <= 0) {
      this.rwT = 1;
      const rw = findApproach(world.runways, m._pos.x, m._pos.z, ad.psi, 16000);
      if (rw && landingEnds(world.runways, C.minRunway).includes(rw)) this._startApproach(rw, 'gear');
    }
    // ---- targets when the stick is released
    this.relDelayP = 0.8; this.relDelayR = 1.5; this.levelRate = 4 * DEG; this.gSlew = 1 * DEG;
    if (this.app) {
      this._approachFrame(dt, world);
      gT = this.app.gT; phiT = this.app.phiT; bankMax = C.bankApp * DEG;
      this.relDelayP = 0.5; this.relDelayR = 0.6; this.levelRate = 8 * DEG; this.gSlew = 2.5 * DEG;
    } else if (this.climbout) {
      const hT = (m._pos.y - agl) + C.safeAgl;
      gT = Math.min(C.climb * DEG, Math.asin(clamp((0.08 * (hT - m._pos.y)) / V, -0.07, 0.3)));
      this.gSlew = 1.5 * DEG;
      if (agl > C.safeAgl - 30) this.climbout = false;
    }
    this.gT = gT; this.phiT = phiT;
    // ---- limits near the ground
    bankMax = Math.min(bankMax, lerp(6, C.bank, smoothstep(4, 70, agl)) * DEG);
    this.thMax = (agl < 8 && !this.climbout ? Math.min(C.pitchUp, (m.tailStrikeDeg ?? 12) - 2.5) : C.pitchUp) * DEG;
    // ---- low speed: nose down, take-off power
    const vProt = this._vProt();
    if (ias < vProt && !m.wow) {
      gCeil = Math.min(gCeil, ad.gamma + 0.5 * DEG * ((ias - vProt) / KT));
      prot = 'stall';
      if (!this.powerSet && !this.at.on && lever < this.toPower - 0.05) { this.powerSet = true; m.pendingThrottle = this.toPower; this._emit('power'); }
      if (this.at.on) this.power = 1;
    } else if (ias > vProt + 15 * KT) this.powerSet = false;
    // ---- overspeed: nose up, less power (gear down in the climb: the gear comes up instead)
    const L = m.spec.limits;
    const vle = sys.gearHandleDown && L.vle ? L.vle : Infinity;
    const vLim = Math.min((L.vmo ?? 300) - 5 * KT, vle - 5 * KT);
    const over = Math.max(ias - vLim, (ad.M - ((L.mmo ?? 2) - 0.01)) * 650);
    if (over > 0) {
      if (vle < Infinity && ias > vle - 5 * KT && !this.app && agl > 100 && sys.gearHandleDown) { m.command('gear'); this._emit('gear', { down: false }); }
      else {
        gFloor = Math.max(gFloor, ad.gamma + 0.5 * DEG * (over / KT));
        prot = prot || 'overspeed';
        if (!this.overSet && !this.at.on && lever > 0.35) { this.overSet = true; m.pendingThrottle = Math.max(0.25, lever - 0.35); this._emit('overspeed'); }
      }
    } else if (over < -15 * KT) this.overSet = false;
    // ---- terrain / obstacles ahead (EGPWS look-ahead) and a sink floor near the ground
    const landing = sys.gearHandleDown && !this.climbout && (this.app || (vs < 0 && agl < 60));
    if (w.pullUp) {
      gFloor = Math.max(gFloor, C.pull * DEG);
      phiT = 0; bankMax = Math.min(bankMax, 15 * DEG); this.relR = Math.max(this.relR, this.relDelayR);
      prot = 'pullUp';
      if (!this.pullSet && !this.at.on && lever < 0.85) { this.pullSet = true; m.pendingThrottle = Math.max(lever, Math.min(this.toPower, 0.9)); this._emit('pullUp'); }
    } else {
      this.pullSet = false;
      if (!landing && agl < 300) {
        const vsMin = -agl / 8;                      // at least 8 s from the ground at the present sink
        gFloor = Math.max(gFloor, Math.asin(clamp(vsMin / V, -0.5, 0)));
        if (agl < 60) gFloor = Math.max(gFloor, 0);
        if (vs < vsMin - 1) prot = prot || 'terrain';
      }
    }
    // ---- gear down near the ground: sink rate limited, down to the touchdown (assisted flare) + thrust retard
    if (sys.gearHandleDown && agl < 60) {
      const vsMin = -Math.min(C.sinkMin + agl * 0.25, C.sinkMax);
      gFloor = Math.max(gFloor, Math.asin(clamp(vsMin / V, -0.5, 0)));
      if (agl < C.retard && vs < 0 && (this.app || this._overRunwayArea(world))) { this.retard = true; this.power = 0; }
      if (vs < vsMin - 0.5) prot = prot || 'sink';
    }
    // ---- AoA protection: the load factor the wing gives below the stall (all types; the F-22 law allows post-stall)
    const lp = m.lp, st = m.fcs.st;
    let aSafe = Math.min(lp.alphaStall - 2 * DEG, (m.spec.fcs.alphaLimit ?? 99) * DEG);
    if (st.alphaProtA > 0) aSafe = Math.min(aSafe, st.alphaProtA);
    this.nAlpha = Math.max(m.nForAlpha(aSafe), 0.2);
    // bank protection flag (the player holds the stick into the limit)
    if (!prot && Math.abs(ad.phi) > bankMax - 2 * DEG && Math.abs(this.lastRoll || 0) > 0.3) prot = 'bank';
    this.gFloor = gFloor; this.gCeil = gCeil; this.bankMax = bankMax;
    // prot shown for a moment at least (no flicker)
    if (prot) { this.prot = prot; this.protT = 1; } else if ((this.protT -= dt) <= 0) this.prot = '';
    // cues
    this.cue = '';
    if (sys.gearHandleDown && !this.app && this.airT < 90 && vs > 1 && agl > 8 && agl < 600 && !landing) this.cue = 'gearUp';
    else if (!this.app && !this.climbout && !sys.gearHandleDown && this.airT > 45 && world && world.runways) this.cue = 'approach';
  }

  /** Lowest speed the protections allow: 1.15 VS1g of the present configuration + 3 kt (≈ V2 after take-off). */
  _vProt() {
    const vs1g = this.m.vSpeeds.vs1g || 40;
    return vs1g * 1.15 + 3 * KT;
  }

  _overRunwayArea(world) {
    const m = this.m;
    if (world && world.isOnRunway && world.isOnRunway(m._pos.x + m.velocity.x * 2, m._pos.z + m.velocity.z * 2)) return true;
    if (this.app) return true;
    return false;
  }

  /** Approach guidance (per frame): stage, lateral / vertical targets, speed target, configuration. */
  _approachFrame(dt, world) {
    const m = this.m, a = this.app, C = this.C, ad = m.ad, rw = a.rw;
    a.t += dt;
    const g = approachGeometry(rw, m._pos.x, m._pos.z, this.geo);
    const V = Math.max(ad.V, 30), y = m._pos.y;
    const vx = m.velocity.x, vz = m.velocity.z, gsp = Math.max(Math.hypot(vx, vz), 30);
    const track = Math.hypot(vx, vz) > 20 ? Math.atan2(vx, -vz) : ad.psi;
    a.along = g.along; a.lateral = g.lateral; a.dist = Math.hypot(g.distThreshold, g.lateral);
    // Lateral path, three stages. 'in': intercept the extended centreline (vector field: up to 60° toward it, the angle
    // shrinking with the offset over one turn radius); 'out': too close / behind / crossing at a steep angle: fly outbound
    // two turn radii to the side, then turn back in (a U-turn onto the centreline); 'final': localizer + glide path.
    const R = clamp((V * V) / (G0 * Math.tan(C.bankApp * DEG)), 800, 4000);
    const gateMin = Math.max(a.gateDist * 0.6, 2500);
    const trkRel = wrapPi(track - rw.course);                     // 0 = flying the final's direction
    if (a.stage === 'gate') a.stage = g.along > gateMin && (Math.cos(trkRel) > 0.2 || g.along > gateMin + 2 * R) ? 'in' : 'out';
    if (a.stage === 'in') {
      if (Math.abs(g.lateral) < 300 && Math.abs(trkRel) < 30 * DEG && g.along > 1500) a.stage = 'final';
      else if (g.along < gateMin * 0.7 && (Math.abs(g.lateral) > 400 || Math.abs(trkRel) > 50 * DEG)) a.stage = 'out';
    } else if (a.stage === 'out') {
      if (g.along > gateMin + R && (Math.abs(g.lateral) > 1.2 * R || Math.cos(trkRel) > 0)) a.stage = 'in';
    } else if (a.stage === 'final') {
      // not stabilised low on the final (far off the centreline / crossing it), or past the threshold in the air: go around
      const unstable = m.agl < 90 && g.along > 300 && (Math.abs(g.lateral) > 90 || Math.abs(trkRel) > 25 * DEG);
      if (unstable || (g.along < -300 && m.agl > 30)) { a.stage = 'out'; a.goAround = true; this._emit('goAround'); }
    }
    let trackCmd;
    if (a.stage === 'final') {
      const vLatDes = clamp(-g.lateral / 22, -gsp * 0.5, gsp * 0.5);
      trackCmd = rw.course + Math.asin(clamp(vLatDes / gsp, -0.5, 0.5));
    } else if (a.stage === 'in') {
      trackCmd = rw.course - (60 * DEG) * (2 / Math.PI) * Math.atan((2 * g.lateral) / R);
    } else {
      const side = a.side || (a.side = g.lateral >= 0 ? 1 : -1);
      trackCmd = rw.course + Math.PI + (60 * DEG) * (2 / Math.PI) * Math.atan((g.lateral - side * 2 * R) / R);
    }
    if (a.stage !== 'out') a.side = 0;
    a.trackCmd = trackCmd;
    let trkErr = wrapPi(trackCmd - track);
    // a turn of more than ~100° goes toward the centreline (a U-turn onto it, not away from it)
    if (a.stage !== 'final' && Math.abs(trkErr) > 100 * DEG && Math.abs(g.lateral) > 50) {
      const toward = -Math.sign(g.lateral) * Math.sign(Math.cos(trkRel) || -1);
      if (Math.sign(trkErr) !== toward) trkErr = toward * (2 * Math.PI - Math.abs(trkErr));
    }
    const lim = (m.agl < 60 ? 10 : C.bankApp) * DEG;
    a.phiT = clamp(trkErr * 2.0, -lim, lim);
    a.dir = Math.abs(trkErr) > 4 * DEG ? Math.sign(trkErr) : 0;                    // where the path is: sola / sağa
    const dPhi = a.phiT - ad.phi;
    a.cueRoll = Math.abs(dPhi) > 6 * DEG ? Math.sign(dPhi) : 0;                   // flight director: stick left / right
    // vertical: the gate altitude until the final, then the 3° glide path (from below: level until it is intercepted)
    let vsCmd;
    const nominal = gsp * TAN_GS;
    if (a.stage === 'final') {
      a.gsAlt = g.gsAlt; a.vert = y - g.gsAlt;
      vsCmd = -nominal + clamp((g.gsAlt - y) * 0.15, -4, nominal + 1);
    } else {
      // the gate altitude; inside the gate the glide path's height (the final then starts on it), never below 150 m
      // (250 m outbound)
      const gateAlt = rw.elevation + (a.gateDist + AIM) * TAN_GS;
      let altT = Math.max(Math.min(gateAlt, g.gsAlt), rw.elevation + (a.stage === 'out' ? 250 : 150));
      if (a.goAround) altT = Math.max(altT, gateAlt + 150);
      a.gsAlt = altT; a.vert = y - altT;
      vsCmd = clamp((altT - y) * 0.08, this.cat === 'fighter' ? -15 : -8, a.goAround ? 10 : 6);
      if (a.goAround && y > altT - 30) a.goAround = false;
    }
    a.glide = a.vert > 30 ? 1 : a.vert < -30 ? -1 : 0;                           // yüksek / alçak
    a.gT = Math.asin(clamp(vsCmd / V, -0.2, 0.2));
    const dG = a.gT - ad.gamma;
    a.cuePitch = Math.abs(dG) > 1.5 * DEG ? -Math.sign(dG) : 0;                    // flight director: 1 = nose down
    this._approachConfig(dt, g);
  }

  /** Approach speed (auto thrust target) and the configuration: gear, flaps one detent at a time, speedbrake. */
  _approachConfig(dt, g) {
    const m = this.m, a = this.app, C = this.C, sys = m.sys;
    // speed
    const v = m.vSpeeds;
    let tgt;
    if (sys.gearHandleDown && sys.flapIndex >= (m.spec.landingFlapIndex ?? 0)) tgt = (v.vapp || v.vls + 5 * KT) + 5 * KT;
    else if (this.cat === 'fighter') tgt = sys.gearHandleDown ? (v.vapp || 70) + 10 * KT : Math.min(C.appKt * KT, (m.spec.limits.vle ?? 999) - 25 * KT);
    else tgt = Math.max((v.vls || 60) + 12 * KT, (v.vapp || 60) + 5 * KT);
    if (a.stage !== 'final' && !sys.gearHandleDown) tgt = Math.max(tgt, Math.min(C.appKt * KT, (v.vls || 60) + 50 * KT, (m.spec.limits.vle ?? 999) - 25 * KT));
    if (a.stage === 'final') this.at.bias = Math.min(this.at.bias || 0, m.agl < 100 ? 0 : 10 * KT);   // no fast finals
    tgt += this.at.bias || 0;
    this.at.tgt = clamp(tgt, (v.vls || 50) + 2 * KT, (m.spec.limits.vmo ?? 300) - 10 * KT);
    // configuration: gear, flaps (one detent at a time, below the next VFE), speedbrake when too fast
    const dThr = g.distThreshold;
    if (!sys.gearHandleDown && !a.gearSet && (a.stage === 'final' || dThr < 8000) && dThr < 12000 && m.ias < ((m.spec.limits.vle ?? 999) - 5 * KT)) {
      a.gearSet = true; m.command('gear'); this._emit('gear', { down: true });
    }
    if (this.cat === 'airliner' && (a.cfgT -= dt) <= 0) {
      const det = m.spec.flapDetents, k = sys.flapIndex, kL = m.spec.landingFlapIndex ?? det.length - 1;
      if (k < kL && (a.stage === 'final' || dThr < 15000)) {
        const vfeNext = det[k + 1].vfe || Infinity;
        if (m.ias < vfeNext - 6 * KT) { m.command('flapsDown'); a.cfgT = 3; this._emit('flaps', { label: det[k + 1].label }); }
      }
    }
    if (!a.sb && !sys.speedbrakeCmd && m.ias > this.at.tgt + 20 * KT && m.agl > 150) { a.sb = true; m.command('speedbrake'); this._emit('speedbrake', { on: true }); }
    else if (a.sb && sys.speedbrakeCmd && (m.ias < this.at.tgt + 5 * KT || m.agl < 150)) { a.sb = false; m.command('speedbrake'); }
  }

  // ------------------------------------------------------------------------------------------ substep law
  /**
   * Assisted flight law (createAutopilot().update with the autopilot off, every sub-step): the player's stick and the
   * frame's targets / protections → load factor, roll rate and thrust demands for the model's own control laws.
   */
  law(h, inp, out) {
    const m = this.m;
    if (!this.on || this.phase !== 'flight' || m.wow) return;
    const C = this.C, ad = m.ad;
    const V = Math.max(ad.V, 30);
    if (this.lawT < 0 || m._time - this.lawT > 0.1) { this.gRef = ad.gamma; this.phiRef = HOLD; this.at.prev = -1; }
    this.lawT = m._time;
    // ---- pitch: flight-path rate command, released = hold → target
    const sp = Math.abs(inp.pitch) > 0.04 ? clamp(inp.pitch, -1, 1) : 0;
    let gdot = 0;
    if (this.app) {
      // approach: the player's input adds to the path's pull (a partial deflection leaves part of it; full = theirs)
      gdot = sp * C.gdot * DEG;
      this.gRef += gdot * h + (1 - Math.abs(sp)) * clamp(this.gT - this.gRef, -this.gSlew * h, this.gSlew * h);
      this.relP = sp ? 0 : this.relP + h;
    } else if (sp) { this.relP = 0; gdot = sp * C.gdot * DEG; this.gRef += gdot * h; }
    else {
      this.relP += h;
      if (this.relP > this.relDelayP) this.gRef = moveToward(this.gRef, this.gT, this.gSlew * h);
    }
    this.gRef = clamp(this.gRef, ad.gamma - 4 * DEG, ad.gamma + 4 * DEG);
    const a0 = Math.max(ad.alpha, 0);
    let gHi = Math.min(C.gMax * DEG, this.thMax - a0, this.gCeil);
    const gLo = Math.max(C.gMin * DEG, C.pitchDown * DEG - ad.alpha, this.gFloor);
    if (gHi < gLo) gHi = gLo;
    this.gRef = clamp(this.gRef, gLo, gHi);
    let n = m.fcs.nLevel(ad.gamma, ad.phi, true) + (V * this.Kg * (this.gRef - ad.gamma)) / G0;
    if (sp && this.gRef > gLo && this.gRef < gHi) n += (V * gdot) / G0;
    n = Math.min(n, this.nAlpha);
    n = clamp(n, C.nMin, C.nMax);
    // ---- roll: rate command, released = hold the bank → level (or the approach's bank)
    const sr = Math.abs(inp.roll) > 0.04 ? clamp(inp.roll, -1, 1) : 0;
    this.lastRoll = sr;
    const bmax = this.bankMax, pMax = C.pRate * DEG;
    let p;
    if (this.app) {
      p = sr * pMax + (1 - Math.abs(sr)) * 0.8 * (clamp(this.phiT, -bmax, bmax) - ad.phi);
      this.relR = sr ? 0 : this.relR + h; this.phiRef = HOLD;
      const room = bmax - Math.sign(sr) * ad.phi;
      if (sr && room < 10 * DEG) p = Math.sign(p) === Math.sign(sr) ? Math.sign(sr) * Math.min(Math.abs(p), Math.max(0, room) * 1.5) : p;
    } else if (sr) {
      this.relR = 0; this.phiRef = HOLD;
      p = sr * pMax;
      const room = bmax - Math.sign(sr) * ad.phi;
      if (room < 10 * DEG) p = Math.sign(sr) * Math.min(Math.abs(p), Math.max(0, room) * 1.5);
    } else {
      this.relR += h;
      if (this.phiRef === HOLD) this.phiRef = clamp(ad.phi, -bmax, bmax);
      if (this.relR > this.relDelayR) this.phiRef = moveToward(this.phiRef, clamp(this.phiT, -bmax, bmax), this.levelRate * h);
      this.phiRef = clamp(this.phiRef, -bmax, bmax);
      p = 0.8 * (this.phiRef - ad.phi);
    }
    if (ad.phi > bmax) p = Math.min(p, 0.8 * (bmax - ad.phi));
    else if (ad.phi < -bmax) p = Math.max(p, 0.8 * (-bmax - ad.phi));
    p = clamp(p, -pMax, pMax);
    out.active = true; out.nCmd = n; out.pCmd = p; out.pedal = null; out.groundPitch = null;
    // ---- thrust: auto thrust (approach speed), retard in the flare, full power at the stall protection
    let power = this.power;
    const at = this.at;
    if (at.on && power == null) {
      const ias = m.ad.ias;
      if (at.prev >= 0) at.rate += (((ias - at.prev) / h) - at.rate) * Math.min(1, h / 0.6);
      at.prev = ias;
      const e = at.tgt - ias;
      at.I = clamp(at.I + 0.012 * e * h, 0, 1);
      power = clamp(at.I + 0.05 * e - 0.25 * at.rate, 0, 1);
    }
    out.power = power;
  }

  /** HUD summary (numbers only, no allocation). */
  get approach() { return this.app; }
}

// ================================================================================================ helicopter
class HeliAssist {
  constructor(m) {
    this.m = m;
    this.kind = 'helicopter';
    this.cat = 'helicopter';
    this.on = false;
    this.out = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
    this.at = { on: false };
    this.reset();
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    if (!on) { this.app = null; this.cue = ''; this.prot = ''; this.phase = this.m.onGround ? 'ground' : 'flight'; }
  }

  reset() {
    this.phase = 'ground'; this.cue = ''; this.prot = ''; this.protT = 0;
    this.app = null; this.liftT = 0; this.fwdT = 0; this.lastLever = 0; this.airT = 0;
  }

  _emit(type, extra) { this.m._emit('assist', extra ? Object.assign({ type }, extra) : { type }); }

  /** "İnişe geç" (helicopter): slow down, hover, then a coupled vertical descent to the ground below (not water). */
  requestApproach(world = this.world) {
    const m = this.m;
    if (!this.on || m.crashed || m.onGround) { this._emit('noRunway', { why: 'ground' }); return false; }
    if (!m.afcs.ap.on) { m.command('autopilot'); }
    if (!m.afcs.ap.on) { this._emit('noRunway', { why: 'none' }); return false; }
    this.app = { stage: 'slow', name: '', t: 0, dist: 0, dir: 0, glide: 0, vert: 0, lateral: 0, water: false };
    this._emit('approach', { runway: '', via: 'button' });
    return true;
  }

  cancelApproach(silent = false) {
    if (!this.app) return;
    this.app = null;
    const ap = this.m.afcs.ap;
    if (ap.on && ap.mode === 'hover' && ap.radar && ap.altitude < 0.5) ap.altitude = Math.max(this.m.agl, 5);
    if (!silent) this._emit('approach', { off: true });
  }

  /** Input filter (HelicopterModel.step). The collective lever (raw.throttle) may be moved (visible to the player). */
  input(dt, raw, world) {
    const m = this.m, o = this.out;
    this.world = world;
    if (m.crashed || dt <= 0) return raw;
    const ap = m.afcs.ap, ground = m.onGround || m._wow > 0.5;
    const lever = clamp(Number.isFinite(raw.throttle) ? raw.throttle : 0, 0, 1);
    const water = (x, z) => !!(world && world.isWater && world.isWater(x, z));
    this.cue = ''; let prot = '';
    if (ground) {
      this.airT = 0;
      if (this.app && !ap.on) { this.app = null; this._emit('landed', { runway: '' }); }
      if (this.phase !== 'lift') {
        this.phase = 'ground';
        if (lever < 0.1) this.cue = 'lift';
        if (lever > 0.12 && lever > this.lastLever + 1e-4) { this.phase = 'lift'; this.liftT = 0; this._emit('takeoffPower'); }
      }
      if (this.phase === 'lift') {
        this.liftT += dt;
        const target = m.afcs.hoverTrim.collective + 0.07;
        if (lever < this.lastLever - 0.02) this.phase = 'ground';            // the player lowered it: cancelled
        else if (lever < target) raw.throttle = Math.min(target, lever + 0.3 * dt);
        if (this.liftT > 20) this.phase = 'ground';
      }
    } else {
      this.airT += dt;
      if (this.phase === 'lift' || this.phase === 'ground') {
        if (this.phase === 'lift') {
          const target = m.afcs.hoverTrim.collective + 0.07;
          if (lever < target) raw.throttle = Math.min(target, lever + 0.3 * dt);
          if (m._wow < 0.3 && m.agl > 1.0 && !ap.on) {
            m.command('autopilot');
            if (ap.on) {
              if (ap.mode === 'hover' && ap.radar) ap.altitude = Math.max(ap.altitude, 8);
              this.phase = 'hover'; this._emit('hover');
            }
          }
          if (this.airT > 6 && this.phase === 'lift') this.phase = 'flight';
        } else this.phase = 'flight';
      }
      if (this.phase === 'hover' && !ap.on) this.phase = 'flight';
      // assisted hover: a firm forward push for a while hands over to forward flight (the hold limits the speed)
      if (this.phase === 'hover' && ap.on && ap.mode === 'hover' && !this.app) {
        this.fwdT = (Number(raw.pitch) || 0) < -0.7 ? this.fwdT + dt : 0;
        if (this.fwdT > 2.5 && Math.hypot(m._sens.gsF, m._sens.gsR) > 7 && m.agl > 25) { m.command('autopilot'); this.phase = 'flight'; this.fwdT = 0; this._emit('forward'); }
      }
      if (this.app) this._landingFrame(dt, world, water);
      // hover hold near the ground: the target beeped below 2.5 m means "land" (coupled vertical landing, no sideways
      // touchdown), and the cyclic moves it less there
      if (ap.on && ap.mode === 'hover' && ap.radar && !this.app) {
        if (ap.altitude < 2.5 && ap.altitude > -0.5 && !water(m._pos.x, m._pos.z)) { this.app = { stage: 'descend', name: '', t: 0, dist: 0, dir: 0, glide: 0, vert: 0, lateral: 0, water: false }; this._emit('approach', { runway: '', via: 'lever' }); }
      }
      if (ap.on && m.agl < 5) {
        const k = clamp((m.agl - 1) / 4, 0.2, 1);
        o.pitch = (Number(raw.pitch) || 0) * k; o.roll = (Number(raw.roll) || 0) * k; o.yaw = Number(raw.yaw) || 0;
        o.brake = Number(raw.brake) || 0; o.throttle = raw.throttle;
        this.lastLever = clamp(Number.isFinite(raw.throttle) ? raw.throttle : 0, 0, 1);
        if (prot) { this.prot = prot; this.protT = 1; } else if ((this.protT -= dt) <= 0) this.prot = '';
        return o;
      }
    }
    // ---- protections with the hold off: sink rate near the ground (the lever comes up), attitude limits
    let res = raw;
    if (!ground && !ap.on) {
      const agl = m.agl, vz = m.verticalSpeed;
      if (agl < 40) {
        const overWater = water(m._pos.x, m._pos.z);
        const fast = Math.hypot(m.velocity.x, m.velocity.z) > 12;       // not a landing: no descent into the ground
        const vzMin = overWater ? (agl < 6 ? 0.5 : -(0.5 + 0.1 * agl)) : fast ? -Math.max(0, (agl - 15) * 0.15) : -(1.0 + 0.3 * agl);
        if (vz < vzMin && m.torque < 1.02 && m.rotorRPM > 0.97) {
          raw.throttle = Math.min(1, Math.max(Number(raw.throttle) || 0, m.collective) + 0.5 * (vzMin - vz) * dt);
          prot = 'sink';
        }
      }
      o.pitch = clamp(Number(raw.pitch) || 0, -1, 1); o.roll = clamp(Number(raw.roll) || 0, -1, 1);
      o.yaw = Number(raw.yaw) || 0; o.brake = Number(raw.brake) || 0; o.throttle = raw.throttle;
      // attitude limits (tighter close to the ground): the stick stops pushing past them and the attitude is brought
      // back (the AFCS would hold whatever attitude it was left at); nose down + sinking low: pull out
      const th = m.pitch, ph = m.roll, agl2 = m.agl, low = agl2 < 15;
      const pLim = low ? 10 : 20, rLim = low ? 12 : 30;
      if (th > pLim - 3 && o.pitch > 0) { o.pitch = 0; prot = prot || 'pitch'; }
      if (th < -pLim + 3 && o.pitch < 0) { o.pitch = 0; prot = prot || 'pitch'; }
      if (th > pLim) o.pitch = -clamp(0.06 * (th - pLim), 0, 0.5);
      if (th < -pLim) o.pitch = clamp(0.06 * (-pLim - th), 0, 0.5);
      if (Math.abs(ph) > rLim - 3 && Math.sign(o.roll) === Math.sign(ph)) { o.roll = 0; prot = prot || 'bank'; }
      if (Math.abs(ph) > rLim) o.roll = -Math.sign(ph) * clamp(0.05 * (Math.abs(ph) - rLim), 0, 0.5);
      if (agl2 < 40 && m.verticalSpeed < -3 && th < 0) { o.pitch = Math.max(o.pitch, clamp(0.05 * -th, 0, 0.6)); prot = prot || 'terrain'; }
      if (agl2 < 25 && th < -3 && Math.hypot(m.velocity.x, m.velocity.z) > 12) { o.pitch = Math.max(o.pitch, clamp(0.05 * (-3 - th), 0, 0.5)); prot = prot || 'terrain'; }
      res = o;
    }
    if (prot) { this.prot = prot; this.protT = 1; } else if ((this.protT -= dt) <= 0) this.prot = '';
    this.lastLever = clamp(Number.isFinite(raw.throttle) ? raw.throttle : 0, 0, 1);
    return res;
  }

  _landingFrame(dt, world, water) {
    const m = this.m, a = this.app, ap = m.afcs.ap;
    a.t += dt;
    if (!ap.on) {                                     // the player took over (O / collective jump)
      this.app = null; this._emit('approach', { off: true }); return;
    }
    const gs = Math.hypot(m._sens.gsF, m._sens.gsR);
    a.water = water(m._pos.x, m._pos.z);
    if (ap.mode === 'cruise' || ap.mode === 'nav') { a.stage = 'slow'; ap.speed = moveToward(ap.speed, 0, 3 * dt); return; }
    if (ap.mode !== 'hover') return;
    if (a.water) {                                   // never down onto the water: hold the hover, the player moves on
      if (a.stage !== 'water') { a.stage = 'water'; this._emit('water'); }
      if (ap.radar && ap.altitude < 8) ap.altitude = 8;
      return;
    }
    if (gs > 2.5 && a.stage !== 'descend') { a.stage = 'slow'; return; }
    if (!ap.radar) { a.stage = 'descend'; ap.altitude = Math.min(ap.altitude, (m._pos.y - m.agl) + 60); return; }
    a.stage = 'descend';
    ap.altitude = -1;                                // AFCS coupled landing (helicopter-afcs.js isLanding)
    a.vert = m.agl;
  }

  law() {}
  get approach() { return this.app; }
}
