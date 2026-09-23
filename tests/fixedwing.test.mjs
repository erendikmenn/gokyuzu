// Fixed-wing flight model tests (P1). Run: node tests/fixedwing.test.mjs [aircraftId ...]
// No framework: scripted pilots drive an InputState against fake worlds; prints a PASS/FAIL table per aircraft and a
// "measured vs real" table, exits 1 on failure.
import { readFileSync } from 'node:fs';
import { createFixedWingModel } from '../src/flight/fixedwing.js';
import { casFromTas, tasFromCas, isa } from '../src/flight/fixedwing-atmosphere.js';
import { turkishDative } from '../src/flight/fixedwing-util.js';
import { runwayEnds, approachGeometry } from '../src/flight/fixedwing-autopilot.js';
import { createInput } from '../src/flight/input.js';

const KT = 0.514444, FT = 0.3048, FPM = FT / 60, DEG = 180 / Math.PI, RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ALL = ['a320neo', 'b737', 'f16', 'f22'];
const only = process.argv.slice(2).filter((a) => ALL.includes(a));
const IDS = only.length ? only : ALL;
const SPECS = {};
for (const id of ALL) SPECS[id] = (await import(`../src/aircraft/${id}/spec.js`)).default;
const RUNWAYS = JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8'));

// ---- fake worlds ---------------------------------------------------------------------------------
const ELEV = 4;
// a long straight test runway along -Z from the origin (heading 0), 4000 m x 60 m, plus the real SF runway list
function flatWorld(extra = {}) {
  return {
    runways: RUNWAYS,
    getGroundHeight: () => ELEV,
    isWater: () => false,
    isOnRunway: (x, z) => (Math.abs(x) < 30 && z < 50 && z > -4050) || realRunway(x, z),
    getObstacleHeight: () => -Infinity,
    hitTest: () => null,
    ...extra,
  };
}
const RECTS = [];
for (const apt of RUNWAYS.airports) for (const r of apt.runways) {
  const [a, b] = r.ends; const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  RECTS.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2 });
}
function realRunway(x, z) {
  for (const r of RECTS) {
    const px = x - r.ax, pz = z - r.az, along = px * r.ux + pz * r.uz;
    if (along >= 0 && along <= r.len && Math.abs(px * -r.uz + pz * r.ux) <= r.half) return true;
  }
  return false;
}

// ---- helpers ---------------------------------------------------------------------------------------
const results = {};          // id -> [{ name, ok, detail }]
const measured = {};         // id -> [{ name, value, real }]
function check(id, name, ok, detail = '') { (results[id] ||= []).push({ name, ok: !!ok, detail }); }
function note(id, name, value, real) { (measured[id] ||= []).push({ name, value, real }); }
const input = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...o });
function finite(f) {
  return [f.position.x, f.position.y, f.position.z, f.velocity.x, f.velocity.y, f.velocity.z, f.quaternion.x, f.quaternion.w, f.ias, f.aoa].every(Number.isFinite);
}
/** Run `secs` with frame step dt; pilot(t, f, inp) may change inputs or return false to stop. */
function fly(f, world, inp, secs, dt = 1 / 60, pilot = null) {
  const n = Math.round(secs / dt);
  let t = 0;
  f.step(0, inp, world);          // the model sees the (synced) lever before the pilot acts, like input.js + main.js
  for (let i = 0; i < n; i++) {
    if (pilot && pilot(t, f, inp) === false) break;
    f.step(dt, inp, world);
    t += dt;
    if (f.crashed) break;
  }
  return t;
}
function model(id, contacts) { return createFixedWingModel(SPECS[id], { contacts }); }
const fighter = (id) => SPECS[id].category === 'fighter';
const kt = (ms) => ms / KT;

/** Pitch-attitude pilot: stick from attitude error (deg) and pitch rate. */
function pitchStick(f, target, k = 0.12, kd = 0.12) {
  const q = f.ad.q * DEG;
  return clamp(k * (target - f.pitch) - kd * q, -1, 1);
}
/** Roll pilot toward a bank angle (deg). */
function rollStick(f, target, k = 0.05) { return clamp(k * (target - f.roll) - 0.02 * f.ad.p * DEG, -1, 1); }

/** Scripted takeoff: brakes released at full thrust, rotate at VR toward `pitchTarget`, measure distances. */
function takeoff(id, opts = {}) {
  const spec = SPECS[id];
  const world = flatWorld();
  const f = model(id);
  f.reset({ x: 0, z: 0, heading: 0 }, world, opts.mass ? { mass: opts.mass } : {});
  // standard procedure: run the engines up on the brakes (airliners 50 % → TOGA, fighters MIL), release, then
  // full thrust (fighters: afterburner past the detent)
  const inp = input({ throttle: fighter(id) ? spec.abDetent : 0.5, brake: 1 });
  fly(f, world, inp, 12, 1 / 60, () => { if (f.engines[0].n1 > (fighter(id) ? 0.97 : 0.5)) return false; });
  inp.brake = 0; inp.throttle = 1;
  const res = { crash: null, lof: null, d35: null, vr: f.vSpeeds.vr, maxPitchGround: 0, tailStrike: false, takeoffEvent: null };
  f.on('crash', (e) => { res.crash = e.reason; });
  f.on('takeoff', (e) => { res.takeoffEvent = e; });
  f.on('warning', (e) => { if (e.type === 'tailStrike') res.tailStrike = true; });
  let rotating = false;
  const pt = opts.pitchTarget ?? (fighter(id) ? 12 : 15);
  fly(f, world, inp, 90, 1 / 60, (t, f, inp) => {
    if (!rotating && f.ias >= f.vSpeeds.vr) rotating = true;
    if (rotating) {
      // like a pilot: a firm pull at VR (the ground laws limit the rotation rate), hold ~2.5° below the tail-strike
      // attitude until airborne, then fly the target climb attitude
      if (f.onGround) {
        const lim = fighter(id) ? pt : Math.min(pt, f.tailStrikeDeg - 2.5);
        inp.pitch = f.pitch < lim - 1 ? Math.min(1, inp.pitch + 1.8 / 60) : pitchStick(f, lim, 0.2, 0.1);
      } else inp.pitch = pitchStick(f, pt, 0.12, 0.12);
    }
    if (f.onGround) res.maxPitchGround = Math.max(res.maxPitchGround, f.pitch);
    if (!res.lof && !f.onGround && f.agl > 0.3) res.lof = { d: -f.position.z, ias: f.ias, t };
    if (!res.d35 && f.agl > 35 * FT) res.d35 = { d: -f.position.z, ias: f.ias, t };
    if (res.d35 && t > res.d35.t + 2) return false;
  });
  res.f = f;
  return res;
}


/** Test runway 36 at the origin (threshold z = 0, landing toward -Z), for scripted landings. */
const TEST_RUNWAYS = { airports: [{ icao: 'TEST', elevation: ELEV, runways: [{ id: '18/36', width: 60, elevation: ELEV,
  ends: [{ ident: '36', x: 0, z: 0, headingTrue: 0 }, { ident: '18', x: 0, z: -4000, headingTrue: 180 }] }] }] };

/** Scripted manual approach from 6 km on the 3° path: pilot tracks the glide path, flares, reverses and brakes. */
function manualLanding(id, opts = {}) {
  const spec = SPECS[id];
  const isF = fighter(id);
  const world = flatWorld({ runways: TEST_RUNWAYS });
  const f = model(id);
  const d0 = 6000;
  f.reset({ x: 0, z: d0, heading: 0, altitude: ELEV + (d0 + 300) * Math.tan(3 * RAD), speed: 70 }, world, { approach: true, ...(opts.gearUp ? { gearDown: false } : {}) });
  const res = { td: null, crash: null, spoilers: false, revOk: false, revInAirRefused: false, stopped: false };
  f.command('reverser');
  res.revInAirRefused = f.pp.st.rev === 0 && !f.sys.reverserCmd;
  f.on('touchdown', (e) => { if (!res.td) { res.td = e; res.tdZ = f.position.z; res.tdIas = f.ias; res.tdDist = -f.position.z; } });
  f.on('crash', (e) => { res.crash = e.reason; });
  const inp = input({ throttle: f.throttle });
  const vapp = f.vSpeeds.vapp;
  let thetaBase = f.pitch, thrI = f.throttle, flare = false, revDone = false;
  fly(f, world, inp, 200, 1 / 60, (t, f, inp) => {
    const dt = 1 / 60;
    if (!res.td) {
      const along = f.position.z + 300;            // m before the aim point
      const hgs = ELEV + Math.max(along, 0) * Math.tan(3 * RAD);
      const hw = f.agl;
      let vsT = -Math.hypot(f.velocity.x, f.velocity.z) * Math.tan(3 * RAD) + clamp((hgs - f.altitude) * 0.12, -1.5, 1.5);
      if (hw < (isF ? 10 : 15)) { flare = true; }
      if (flare) vsT = -(0.35 + hw / 3.5);
      // pilot: attitude inner loop, vertical speed outer loop (attitude trimmed by a slow integrator)
      const e = vsT - f.verticalSpeed;
      thetaBase = clamp(thetaBase + e * 0.25 * dt, -8, 14);
      const tht = thetaBase + clamp(e * 1.2, -5, 6);
      inp.pitch = pitchStick(f, tht, 0.12, 0.1);
      inp.roll = rollStick(f, clamp(-f.position.x * 0.3, -10, 10));
      // speed by throttle; idle in the flare
      const se = vapp - f.ias;
      thrI = clamp(thrI + se * 0.004, 0, 1);
      inp.throttle = flare && hw < 6 ? 0 : clamp(thrI + se * 0.05, 0, isF ? spec.abDetent : 1);
    } else {
      // rollout: nose down, idle / reverse, brakes, keep the centerline
      inp.throttle = 0;
      inp.pitch = f.pitch > 1 ? -0.2 : 0;
      inp.roll = 0;
      inp.yaw = clamp(-f.position.x * 0.1 - (f.heading > 180 ? f.heading - 360 : f.heading) * 0.2, -1, 1);
      if (!isF && !revDone && f.onGround) { f.command('reverser'); revDone = true; }
      if (f.sys.reverserCmd && f.pp.st.rev > 0.98) { res.revOk = true; inp.throttle = f.groundSpeed > 35 ? 1 : 0; }
      if (f.spoilers > 0.9) res.spoilers = true;
      inp.brake = t > 0 && f.onGround ? 1 : 0;
      if (f.groundSpeed < 0.5 && f.onGround) { res.stopped = true; return false; }
    }
  });
  if (res.tdZ != null) res.stop = res.tdZ - f.position.z;
  res.f = f;
  return res;
}

/** AIR-SFO-FINAL spawn (9 km from KSFO 28L, 480 m) → autopilot approach, autoland, rollout. */
function autoland(id, opts = {}) {
  const world = flatWorld();
  const f = model(id);
  const rad = (d) => d * Math.PI / 180;
  const start = { x: 1464 + Math.sin(rad(117.4)) * 9000, z: 796 - Math.cos(rad(117.4)) * 9000, heading: rad(297.4), altitude: 480, speed: SPECS[id].spawnSpeed };
  f.reset(start, world);
  const res = { td: null, crash: null, modes: [], stopped: false, lat: NaN, dist: NaN, warnings: [] };
  f.on('touchdown', (e) => { if (!res.td) res.td = e; });
  f.on('warning', (e) => { if (e.on && !res.td && ['pullUp', 'sinkRate', 'gear', 'stall', 'overspeed', 'bank'].includes(e.type)) res.warnings.push(e.type); });
  f.on('crash', (e) => { res.crash = e.reason; });
  const inp = input({ throttle: f.throttle });
  f.command('autopilot');
  const rw = runwayEnds(RUNWAYS).find((r) => r.name === 'KSFO 28L');
  fly(f, world, inp, 300, 1 / 60, (t, f, inp) => {
    if (f.autopilot.mode && res.modes[res.modes.length - 1] !== f.autopilot.mode) res.modes.push(f.autopilot.mode);
    if (res.td && !f.autopilot.on) { inp.throttle = 0; if (fighter(id)) inp.brake = 1; }  // idle after disconnect (fighters: no autobrake)
    if (res.td && isNaN(res.lat)) { const g = approachGeometry(rw, f.position.x, f.position.z); res.lat = g.lateral; res.dist = g.distThreshold * -1; }
    if (res.td && f.groundSpeed < 1) { res.stopped = true; return false; }
  });
  res.modes = res.modes.map((m) => m.split(' ').pop()).concat(res.modes);
  res.f = f;
  return res;
}

/** Clean, idle, level flight (altitude held by a pilot): mean deceleration in kt/s through kts ± 5 KIAS. */
function levelDecel(id, alt, kts, speedbrake) {
  const spec = SPECS[id];
  const world = flatWorld();
  const f = model(id);
  f.reset({ x: 0, z: 0, heading: 0, altitude: alt, speed: tasFromCas((kts + 12) * KT, alt) }, world,
    { throttle: 0, gearDown: false, flapIndex: 0, approach: false, verticalSpeed: 0 });
  if (speedbrake) f.command('speedbrake');
  const inp = input({ throttle: 0 });
  let tA = null, tB = null, thetaBase = f.pitch, dh = 0;
  fly(f, world, inp, 120, 1 / 60, (t, f, inp) => {
    const e = clamp((alt - f.altitude) * 0.1, -3, 3) - f.verticalSpeed;
    thetaBase = clamp(thetaBase + e * 0.3 / 60, -5, 25);
    inp.pitch = spec.fcs.law === 'airbus' ? clamp(0.1 * e + (thetaBase - f.pitch) * 0.05, -1, 1) : pitchStick(f, thetaBase + clamp(e, -3, 3), 0.12, 0.1);
    if (tA == null && f.ias <= (kts + 5) * KT) tA = t;
    if (tA != null) dh = Math.max(dh, Math.abs(f.altitude - alt));
    if (f.ias <= (kts - 5) * KT) { tB = t; return false; }
  });
  return { decel: tA != null && tB != null ? 10 / (tB - tA) : NaN, dh, f };
}

/** Clean idle descent, IAS held by pitch: mean vertical speed in ft/min (positive down) over 20–50 s. */
function idleDescent(id, alt, kts, speedbrake) {
  const world = flatWorld();
  const f = model(id);
  f.reset({ x: 0, z: 0, heading: 0, altitude: alt, speed: tasFromCas(kts * KT, alt) }, world,
    { throttle: 0, gearDown: false, flapIndex: 0, approach: false, verticalSpeed: 0 });
  if (speedbrake) f.command('speedbrake');
  const inp = input({ throttle: 0 });
  let sum = 0, n = 0, err = 0;
  fly(f, world, inp, 50, 1 / 60, (t, f, inp) => {
    inp.pitch = clamp(pitchStick(f, clamp(f.pitch + (f.ias - kts * KT) * 0.5, -25, 20), 0.12, 0.2), -1, 1);
    if (t > 20) { sum += f.verticalSpeed; err = Math.max(err, Math.abs(f.ias / KT - kts)); n++; }
  });
  return { fpm: -sum / Math.max(n, 1) / FPM, err, f };
}

// ======================================================================================================
// 0. module sanity: atmosphere, airspeed conversion, Turkish text
{
  const s = isa(11000);
  const ok = Math.abs(s.T - 216.65) < 0.01 && Math.abs(s.rho - 0.3639) < 0.002 && Math.abs(s.a - 295.07) < 0.1;
  const cas = casFromTas(0.78 * isa(10668).a, 10668) / KT;
  const back = tasFromCas(250 * KT, 3000) / KT;
  check('common', 'ISA (11 km: 216.65 K, 0.364 kg/m³, 295 m/s), CAS/TAS', ok && Math.abs(cas - 268) < 4 && Math.abs(back - 288) < 3,
    `M0.78 @FL350 = ${cas.toFixed(1)} KCAS (real ≈268), 250 KCAS @3 km = ${back.toFixed(1)} KTAS`);
  const d1 = turkishDative('Golden Gate Köprüsü'), d2 = turkishDative('bina'), d3 = turkishDative('Salesforce Kulesi'), d4 = turkishDative('Alcatraz');
  check('common', 'Turkish dative for crash reasons', d1 === "Golden Gate Köprüsü'ne" && d2 === 'binaya' && d3 === "Salesforce Kulesi'ne" && d4 === "Alcatraz'a", `${d1} · ${d2} · ${d3} · ${d4}`);
}

// 0b. input module (fake keyboard target, no DOM)
{
  const listeners = {};
  const target = { addEventListener: (t, cb) => { (listeners[t] ||= []).push(cb); } };
  const key = (type, code, extra = {}) => { for (const cb of listeners[type] || []) cb({ code, key: '', repeat: false, preventDefault() {}, target: null, ...extra }); };
  const inp = createInput(target);
  const acts = [];
  for (const a of ['gear', 'flapsDown', 'flapsUp', 'speedbrake', 'reverser', 'canopy', 'lights', 'autopilot', 'camera', 'cameraPrev', 'view', 'lookBack', 'reset', 'pause', 'hud', 'mute', 'help', 'menu']) inp.on(a, () => acts.push(a));
  inp.setAircraft(SPECS.a320neo);
  // pitch ramps: a short tap is a small input, a long hold reaches full deflection, release returns to 0
  key('keydown', 'KeyS'); inp.update(0.05); const tap = inp.state.pitch;
  for (let i = 0; i < 40; i++) inp.update(0.016);
  const full = inp.state.pitch;
  key('keyup', 'KeyS'); for (let i = 0; i < 20; i++) inp.update(0.016);
  check('common', 'Input: keyboard pitch ramps (tap small, hold full, release to 0)', tap > 0 && tap < 0.15 && full === 1 && inp.state.pitch === 0, `tap ${tap.toFixed(2)}, hold ${full}, released ${inp.state.pitch}`);
  // throttle keys (Mac: X/Z) and presets
  key('keydown', 'KeyX'); for (let i = 0; i < 60; i++) inp.update(1 / 60); key('keyup', 'KeyX');
  const t1 = inp.state.throttle;
  key('keydown', 'Digit0'); key('keyup', 'Digit0');
  check('common', 'Input: throttle lever rate (X 1 s ≈ 0.45) and presets (0 = 100 %)', Math.abs(t1 - 0.45) < 0.02 && inp.state.throttle === 1, `${t1.toFixed(3)} → ${inp.state.throttle}`);
  // analog brakes
  key('keydown', 'Space'); inp.update(0.1); const b1 = inp.state.brake; inp.update(0.1); inp.update(0.1); const b2 = inp.state.brake; key('keyup', 'Space'); inp.update(0.1); inp.update(0.1);
  check('common', 'Input: analog brake ramps (Space / B)', b1 > 0.2 && b1 < 0.6 && b2 === 1 && inp.state.brake === 0, `${b1.toFixed(2)} → ${b2} → ${inp.state.brake}`);
  // fighter afterburner detent
  inp.setAircraft(SPECS.f16);
  key('keydown', 'ShiftLeft'); for (let i = 0; i < 180; i++) inp.update(1 / 60);
  const atDet = inp.state.throttle;
  key('keyup', 'ShiftLeft'); key('keydown', 'ShiftLeft'); for (let i = 0; i < 30; i++) inp.update(1 / 60); key('keyup', 'ShiftLeft');
  const inAB = inp.state.throttle;
  key('keydown', 'ControlLeft'); for (let i = 0; i < 60; i++) inp.update(1 / 60); key('keyup', 'ControlLeft');
  const backDet = inp.state.throttle;
  check('common', 'Input: fighter AB detent (stops at MIL, fresh press enters AB, stops again coming back)', atDet === SPECS.f16.abDetent && inAB > atDet + 0.05 && backDet === SPECS.f16.abDetent,
    `MIL ${atDet}, AB ${inAB.toFixed(3)}, back ${backDet}`);
  // actions + momentary speedbrake + model throttle sync
  acts.length = 0;
  for (const c of ['KeyG', 'KeyF', 'KeyV', 'KeyN', 'KeyU', 'KeyL', 'KeyO', 'KeyC', 'Comma', 'KeyT', 'KeyY', 'KeyR', 'KeyP', 'KeyH', 'KeyM', 'F1', 'Tab']) { key('keydown', c); key('keyup', c); }
  key('keydown', 'KeyK'); for (let i = 0; i < 40; i++) inp.update(1 / 60); key('keyup', 'KeyK');
  const all = ['gear', 'flapsDown', 'flapsUp', 'reverser', 'canopy', 'lights', 'autopilot', 'camera', 'cameraPrev', 'view', 'lookBack', 'reset', 'pause', 'hud', 'mute', 'help', 'menu'];
  const sbCount = acts.filter((a) => a === 'speedbrake').length;
  globalThis.__game = { flight: { pendingThrottle: 0.37 } };
  inp.update(0.016);
  const synced = inp.state.throttle === 0.37 && globalThis.__game.flight.pendingThrottle === null;
  delete globalThis.__game;
  key('keydown', 'KeyS', { metaKey: true }); inp.update(0.1); const cmd = inp.state.pitch;
  check('common', 'Input: every action bound, held K = momentary speedbrake, model throttle sync, Cmd ignored', all.every((a) => acts.includes(a)) && sbCount === 2 && synced && cmd === 0,
    `missing ${all.filter((a) => !acts.includes(a)).join(',') || 'none'}, speedbrake ×${sbCount}, sync ${synced}`);
  inp.setAircraft((await import('../src/aircraft/uh60/spec.js')).default);
  check('common', 'Input: helicopter mode (collective labels, no AB detent)', inp.afterburnerDetent === null && inp.bindings.some((b) => /Kolektif/.test(b.label)) && inp.bindings.some((b) => /hover/.test(b.label)), `${inp.bindings.length} bindings`);
}

for (const id of IDS) {
  const spec = SPECS[id];
  const isF = fighter(id);
  const world = flatWorld();

  // ---------------------------------------------------------------------------------------------- 1 parked
  {
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0.7 }, world);
    const p0 = f.position.clone();
    let maxV = 0, maxDy = 0;
    const inp = input();
    fly(f, world, inp, 20, 1 / 60, () => { maxV = Math.max(maxV, f.velocity.length()); maxDy = Math.max(maxDy, Math.abs(f.position.y - p0.y)); });
    const drift = f.position.distanceTo(p0);
    check(id, 'Parked 20 s (idle, parking brake): perfectly still', !f.crashed && f.onGround && drift < 0.01 && maxDy < 0.01 && maxV < 0.02,
      `drift ${drift.toExponential(1)} m, dy ${maxDy.toExponential(1)}, |v| ${maxV.toExponential(1)}`);
    // releasing the brake at idle: airliners stay put (breakaway), fighters may creep slowly
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0 }, world, { parkingBrake: false });
    fly(g, world, input(), 10);
    check(id, 'Idle, brakes off 10 s: no runaway', g.groundSpeed < (isF ? 5 : 1.5) && !g.crashed, `ground speed ${g.groundSpeed.toFixed(2)} m/s`);
  }

  // ---------------------------------------------------------------------------------------------- 2 engines
  {
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0 }, world);
    const inp = input({ throttle: isF ? spec.abDetent : 1, brake: 1 });
    let t95 = null;
    const tMax = () => f.pp.st.tmil * spec.engines;
    fly(f, world, inp, 15, 1 / 60, (t) => { if (t95 == null && t > 0 && f.pp.st.thrust >= 0.95 * tMax()) t95 = t; });
    const range = isF ? [2.5, 5] : [4.5, 7.5];
    note(id, isF ? 'Spool idle → 95 % MIL thrust' : 'Spool idle → 95 % TOGA thrust', `${t95?.toFixed(1)} s`, isF ? '~3–4 s' : '~5–7 s');
    check(id, `Engine spool-up idle → 95 % thrust in ${range[0]}–${range[1]} s`, t95 != null && t95 >= range[0] && t95 <= range[1], `${t95?.toFixed(2)} s, N1 ${f.engines[0].n1.toFixed(3)}`);
    const staticT = f.pp.st.thrust / spec.engines;
    check(id, 'Static max dry thrust per engine = spec', Math.abs(staticT - spec.engine.thrust) / spec.engine.thrust < 0.03, `${(staticT / 1000).toFixed(1)} kN`);
    if (isF) {
      inp.throttle = 1;
      let abEv = false; f.on('afterburner', (e) => { if (e.on) abEv = true; });
      fly(f, world, inp, 4);
      const tAB = f.pp.st.thrust / spec.engines;
      note(id, 'Max AB static thrust / engine', `${(tAB / 1000).toFixed(1)} kN`, `${(spec.engine.thrustAB / 1000).toFixed(0)} kN`);
      check(id, 'Afterburner above the detent: full AB thrust + event', abEv && Math.abs(tAB - spec.engine.thrustAB) / spec.engine.thrustAB < 0.03 && f.engines[0].afterburner > 0.99,
        `${(tAB / 1000).toFixed(1)} kN, ab ${f.engines[0].afterburner.toFixed(2)}, nozzle ${f.engines[0].nozzle.toFixed(2)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- 3 takeoff
  {
    const runs = isF ? [['typical', takeoff(id)]] : [['MTOW', takeoff(id, { mass: spec.mass.mtow })], ['typical', takeoff(id)]];
    for (const [label, r] of runs) {
      const ok = !r.crash && r.lof && r.d35;
      const lofKt = r.lof ? kt(r.lof.ias) : NaN, vrKt = kt(r.vr);
      if (!isF) {
        const fact = r.d35 ? r.d35.d * 1.15 : NaN;
        note(id, `Takeoff ${label}: ground roll / to 35 ft (×1.15)`, `${r.lof?.d.toFixed(0)} / ${r.d35?.d.toFixed(0)} (${fact.toFixed(0)}) m`,
          label === 'MTOW' ? (id === 'a320neo' ? 'TOD ≈1.9–2.1 km' : 'TOD ≈2.3–2.6 km') : 'shorter');
        note(id, `Takeoff ${label}: VR / VLOF`, `${vrKt.toFixed(0)} / ${lofKt.toFixed(0)} kt`, label === 'MTOW' ? (id === 'a320neo' ? 'VR≈150, VLOF≈158' : 'VR≈158, VLOF≈165') : '');
        // published TOFL is the one-engine-out balanced field length, the all-engine ×1.15 distance is a little shorter
        const pub = spec.published.takeoffDistanceMTOW;
        const range = label === 'MTOW' ? [pub[0] * 0.9, pub[1] * 1.02] : [900, pub[0] * 0.85];
        check(id, `Takeoff ${label}: factored distance to 35 ft in ${range[0]}–${range[1]} m`, ok && fact >= range[0] && fact <= range[1], `${fact.toFixed(0)} m ${r.crash || ''}`);
        check(id, `Takeoff ${label}: liftoff IAS VR+2…VR+20 kt, no tail strike`, ok && lofKt >= vrKt + 2 && lofKt <= vrKt + 20 && !r.tailStrike && r.maxPitchGround < spec.structure.tail.strikeDeg,
          `VR ${vrKt.toFixed(0)} kt, VLOF ${lofKt.toFixed(0)} kt, max pitch on ground ${r.maxPitchGround.toFixed(1)}°`);
      } else {
        note(id, 'Takeoff (max AB): ground roll / to 35 ft', `${r.lof?.d.toFixed(0)} / ${r.d35?.d.toFixed(0)} m`, id === 'f16' ? 'roll ≈450–600 m' : 'roll ≈300–450 m');
        note(id, 'Takeoff: VR / VLOF', `${vrKt.toFixed(0)} / ${lofKt.toFixed(0)} kt`, id === 'f16' ? '≈140 / 160–170' : '≈125 / 145–155');
        const range = id === 'f16' ? [350, 600] : [250, 500];
        check(id, `Takeoff with AB: ground roll ${range[0]}–${range[1]} m`, ok && r.lof.d >= range[0] && r.lof.d <= range[1], `${r.lof?.d.toFixed(0)} m, 35 ft at ${r.d35?.d.toFixed(0)} m ${r.crash || ''}`);
        check(id, 'Takeoff: liftoff IAS VR+5…VR+40 kt', ok && lofKt >= vrKt + 5 && lofKt <= vrKt + 40, `VR ${vrKt.toFixed(0)}, VLOF ${lofKt.toFixed(0)} kt`);
      }
      check(id, `Takeoff ${label}: 'takeoff' event`, !!r.takeoffEvent, r.takeoffEvent ? `at ${kt(r.takeoffEvent.ias).toFixed(0)} KIAS` : 'none');
    }
  }

  // ---------------------------------------------------------------------------------------------- 4 climb
  {
    const f = model(id);
    if (!isF) {
      // clean climb at 250 KIAS through 3,000 m with max climb thrust (speed held by pitch)
      const alt = 2500;
      f.reset({ x: 0, z: 0, heading: 0, altitude: alt, speed: tasFromCas(250 * KT, alt) }, world, { throttle: 1 });
      const inp = input({ throttle: 1 });
      let vs = [];
      fly(f, world, inp, 90, 1 / 60, (t, f, inp) => {
        const e = (f.ias - 250 * KT);                 // too fast → pitch up
        inp.pitch = clamp(pitchStick(f, clamp(f.pitch + e * 0.5, -5, 20), 0.12, 0.2), -1, 1);
        if (t > 40) vs.push(f.verticalSpeed);
      });
      const v = vs.reduce((a, b) => a + b, 0) / Math.max(vs.length, 1);
      note(id, 'Climb 250 KIAS @ ~3 km, max thrust, 65 t', `${(v / FPM).toFixed(0)} ft/min`, '≈2,000–3,500 ft/min');
      check(id, 'Climb rate at 250 KIAS / 3 km: 1,800–4,000 ft/min', v / FPM > 1800 && v / FPM < 4000 && !f.crashed, `${(v / FPM).toFixed(0)} fpm, IAS ${kt(f.ias).toFixed(0)} kt`);
    } else {
      // specific excess power at sea level, 450 KIAS, max AB (steady climb rate at constant speed)
      f.reset({ x: 0, z: 0, heading: 0, altitude: 300, speed: 450 * KT }, world, { throttle: 1 });
      const inp = input({ throttle: 1 });
      fly(f, world, inp, 6);
      const m = f.mass, V = f.airspeed;
      const T = f.pp.st.thrust, D = f.ad.qbar * spec.wingArea * f.cd.CD;
      const ps = ((T - D) * V) / (m * 9.80665);
      note(id, 'Climb (Ps) SL 450 KIAS max AB', `${(ps / FPM).toFixed(0)} ft/min`, id === 'f16' ? '≈50,000 ft/min' : '> 50,000 ft/min');
      check(id, 'Sea-level excess power (max AB, 450 kt) 40,000–75,000 ft/min', ps / FPM > 40000 && ps / FPM < 75000, `Ps ${ps.toFixed(0)} m/s`);
    }
  }

  // ---------------------------------------------------------------------------------------------- 5 cruise / max speed
  if (!isF) {
    // cruise M0.78 at FL350 on autopilot: fuel flow, thrust margin
    const h = spec.cruiseAltitude, M = spec.cruiseMach;
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0, altitude: h, speed: M * isa(h).a }, world);
    const inp = input({ throttle: f.throttle });
    f.command('autopilot');
    fly(f, world, inp, 120);
    const ff = f.pp.st.fuelFlow * 3600;
    note(id, `Cruise M${M} FL350 (65 t): fuel flow / N1`, `${ff.toFixed(0)} kg/h / ${(f.engines[0].n1 * 100).toFixed(1)} %`, id === 'a320neo' ? '≈2,100–2,400 kg/h' : '≈2,300–2,600 kg/h');
    note(id, `Cruise M${M} FL350: IAS / L/D`, `${kt(f.ias).toFixed(0)} kt / ${(f._CLtotal(f.ad.alpha) / f.cd.CD).toFixed(1)}`, '≈268 kt / 16–18');
    check(id, 'Cruise FL350 on AP: altitude ±15 m, Mach ±0.01, fuel flow 1,800–2,900 kg/h', f.autopilot.on && Math.abs(f.altitude - h) < 15 && Math.abs(f.mach - M) < 0.01 && ff > 1800 && ff < 2900,
      `alt ${f.altitude.toFixed(0)} m, M${f.mach.toFixed(3)}, ${ff.toFixed(0)} kg/h, mode ${f.autopilot.mode}`);
    // max level speed with max thrust at FL350
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: h, speed: 0.8 * isa(h).a }, world, { throttle: 1 });
    const inp2 = input({ throttle: 1 });
    let warn = false, maxM = 0; g.on('warning', (e) => { if (e.type === 'overspeed' && e.on) warn = true; });
    fly(g, world, inp2, 400, 1 / 60, () => { maxM = Math.max(maxM, g.mach); });
    note(id, 'Max Mach FL350, max climb thrust', `M${maxM.toFixed(3)}`, spec.fcs.law === 'airbus' ? 'MMO 0.82 (protection +0.01…0.02)' : 'MMO 0.82 (drag rise ≈0.84–0.86)');
    if (spec.fcs.law === 'airbus') {
      // normal law high-speed protection pitches the aircraft up before the drag rise stops it
      check(id, 'Max thrust at FL350: overspeed warning, protection keeps M ≤ MMO+0.025 (pitches up)', warn && maxM > spec.limits.mmo && maxM <= spec.limits.mmo + 0.025, `max M${maxM.toFixed(3)}, end alt ${g.altitude.toFixed(0)} m, warning ${warn}`);
    } else check(id, 'Max level speed FL350: M0.82–0.87 (above MMO → overspeed warning)', g.mach > 0.82 && g.mach < 0.87 && warn && Math.abs(g.altitude - h) < 60, `M${g.mach.toFixed(3)}, warning ${warn}`);
    // VMO: idle, nose-down dive. A320: high-speed protection; 737: overspeed clacker only
    const d = model(id);
    d.reset({ x: 0, z: 0, heading: 0, altitude: 6000, speed: tasFromCas(300 * KT, 6000) }, world, { throttle: 0 });
    const inp3 = input({ throttle: 0 });
    let maxIas = 0, ow = false;
    d.on('warning', (e) => { if (e.type === 'overspeed' && e.on) ow = true; });
    fly(d, world, inp3, 60, 1 / 60, (t, d, inp) => {
      inp.pitch = spec.fcs.law === 'airbus' ? -1 : pitchStick(d, -10);
      maxIas = Math.max(maxIas, d.ias);
      if (d.altitude < 1500) return false;
    });
    const vmo = spec.limits.vmo;
    if (spec.fcs.law === 'airbus') {
      note(id, 'Full-forward-stick dive (idle): max IAS', `${kt(maxIas).toFixed(0)} kt`, 'VMO 350 kt, protection ≈ VMO+16');
      check(id, 'High-speed protection: full forward stick, IAS < VMO+20 kt, overspeed warning', maxIas < vmo + 20 * KT && ow, `max ${kt(maxIas).toFixed(0)} kt`);
    } else {
      note(id, '-10° dive (idle): max IAS', `${kt(maxIas).toFixed(0)} kt`, 'VMO 340 kt');
      check(id, 'Dive past VMO: overspeed warning fires', ow && maxIas > vmo, `max ${kt(maxIas).toFixed(0)} kt`);
    }
  } else {
    // max speed at altitude (max AB) and at sea level; F-22 supercruise in MIL
    const runMax = (alt, lever, M0, secs) => {
      const f = model(id);
      f.reset({ x: 0, z: 0, heading: 0, altitude: alt, speed: M0 * isa(alt).a }, world, { fuel: spec.mass.fuelCapacity, throttle: lever });
      const inp = input({ throttle: lever });
      let prev = f.mach, t0 = 0;
      fly(f, world, inp, secs, 1 / 30, (t, f) => {
        if (t - t0 > 10) { if (Math.abs(f.mach - prev) < 0.002) return false; prev = f.mach; t0 = t; }
      });
      return f;
    };
    const hi = runMax(12000, 1, 1.4, 600);
    note(id, 'Max Mach @ 12 km (max AB)', `M${hi.mach.toFixed(2)}`, id === 'f16' ? 'M2.05' : 'M2.25');
    const target = id === 'f16' ? [1.9, 2.2] : [2.1, 2.4];
    check(id, `Max Mach at 12 km with AB ${target[0]}–${target[1]} (level, stick free)`, hi.mach > target[0] && hi.mach < target[1] && Math.abs(hi.altitude - 12000) < 150, `M${hi.mach.toFixed(3)}, alt ${hi.altitude.toFixed(0)}`);
    const sl = runMax(300, 1, 0.95, 300);
    note(id, 'Max Mach @ sea level (max AB)', `M${sl.mach.toFixed(2)} (${kt(sl.ias).toFixed(0)} KIAS)`, id === 'f16' ? '≈M1.2 (800 KIAS)' : '≈M1.2+');
    check(id, `Max Mach at sea level 1.1–${id === 'f16' ? 1.35 : 1.4}`, sl.mach > 1.1 && sl.mach < (id === 'f16' ? 1.35 : 1.4), `M${sl.mach.toFixed(3)}`);
    const sc = runMax(12000, spec.abDetent, 0.95, 900);
    note(id, 'Max Mach @ 12 km in MIL (no AB)', `M${sc.mach.toFixed(2)}`, id === 'f22' ? 'supercruise M1.5–1.8' : '≈M1.1 (no supercruise)');
    if (id === 'f22') check(id, 'Supercruise: from M0.95 accelerates to M ≥ 1.5 at 12 km without afterburner', sc.mach >= 1.5 && sc.engines[0].afterburner === 0, `M${sc.mach.toFixed(3)}`);
    else check(id, 'No real supercruise: MIL power at 12 km from M0.95 stays below M1.15', sc.mach < 1.15, `M${sc.mach.toFixed(3)}`);
    // overspeed warning past VMO / MMO
    let ow = false;
    const o = model(id);
    o.reset({ x: 0, z: 0, heading: 0, altitude: 300, speed: spec.limits.vmo * 1.02 }, world, { throttle: 1 });
    o.on('warning', (e) => { if (e.type === 'overspeed' && e.on) ow = true; });
    fly(o, world, input({ throttle: 1 }), 2);
    check(id, 'Overspeed warning above VMO', ow, `${kt(o.ias).toFixed(0)} KIAS`);
  }


  // ---------------------------------------------------------------------------------------------- 6 stall speeds
  if (!isF) {
    const pub = spec.published.stallSpeedsKt;
    const massRef = pub.mass;
    for (const [label, vsPub] of Object.entries(pub)) {
      if (label === 'mass') continue;
      const idx = spec.flapDetents.findIndex((d) => d.label === label);
      const f = model(id);
      const h0 = 3000;
      f.reset({ x: 0, z: 0, heading: 0, altitude: h0, speed: tasFromCas(vsPub * 1.35 * KT, h0) }, world,
        { flapIndex: idx, gearDown: false, throttle: 0, mass: massRef, approach: false });
      const inp = input({ throttle: 0 });
      let minIas = Infinity, stallIas = null, shakerIas = null, floor = false, thetaBase = f.pitch;
      fly(f, world, inp, 150, 1 / 60, (t, f, inp) => {
        // pilot: hold altitude (attitude inner loop, vertical speed outer loop) while the speed bleeds off at idle
        const vsT = clamp((h0 - f.altitude) * 0.1, -3, 3);
        const e = vsT - f.verticalSpeed;
        thetaBase = clamp(thetaBase + e * 0.3 / 60, -5, 25);
        inp.pitch = spec.fcs.law === 'airbus' ? clamp(0.1 * e + (thetaBase - f.pitch) * 0.05, -1, 1) : pitchStick(f, thetaBase + clamp(e, -3, 3), 0.12, 0.1);
        if (!stallIas && f.stalled) stallIas = f.ias;
        if (!shakerIas && f.warnings.stall) shakerIas = f.ias;
        if (f.fcs.st.alphaFloor) floor = true;
        if (!floor && !stallIas) minIas = Math.min(minIas, f.ias);
        if (stallIas && t > 5) return false;
        if (floor) return false;
      });
      if (spec.fcs.law === 'airbus') {
        const r = kt(minIas) / vsPub;
        note(id, `Min speed CONF ${label} (α max, ${massRef / 1000} t)`, `${kt(minIas).toFixed(0)} kt (×${r.toFixed(2)} VS1g)`, `VS1g ${vsPub} kt`);
        check(id, `CONF ${label}: normal law holds α ≤ α max, min speed 0.97–1.12 × VS1g, alpha floor`, !f.stalled && r > 0.97 && r < 1.12 && floor,
          `min ${kt(minIas).toFixed(1)} kt vs VS1g ${vsPub}, α floor ${floor}`);
      } else {
        const v = stallIas ? kt(stallIas) : NaN;
        note(id, `Stall flaps ${label} (${massRef / 1000} t, 1 kt/s)`, `${v.toFixed(0)} kt (shaker ${kt(shakerIas ?? NaN).toFixed(0)})`, `VS1g ${vsPub} kt`);
        check(id, `Flaps ${label}: stalls at 0.93–1.07 × VS1g, stick shaker ≥ 3 kt before`, stallIas && v / vsPub > 0.93 && v / vsPub < 1.07 && shakerIas && kt(shakerIas) >= v + 3,
          `stall ${v.toFixed(1)} kt (VS1g ${vsPub}), shaker ${kt(shakerIas ?? NaN).toFixed(1)} kt`);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- 7 control laws
  if (isF) {
    // g limits at 450 kt, AoA limit at low speed, roll rate
    const gRun = (stick, secs) => {
      const f = model(id);
      f.reset({ x: 0, z: 0, heading: 0, altitude: 4000, speed: tasFromCas(450 * KT, 4000) }, world, { throttle: 1 });
      const inp = input({ throttle: 1 });
      let gMax = -99, gMin = 99, aMax = 0;
      fly(f, world, inp, secs, 1 / 60, (t, f, inp) => {
        inp.pitch = clamp(t * 1.8, 0, 1) * stick;
        gMax = Math.max(gMax, f.gForce); gMin = Math.min(gMin, f.gForce); aMax = Math.max(aMax, f.aoa);
      });
      return { gMax, gMin, aMax, f };
    };
    const up = gRun(1, 4), dn = gRun(-1, 3);
    note(id, 'Full aft stick @450 KIAS: peak g', up.gMax.toFixed(2), '+9 g limit');
    note(id, 'Full forward stick @450 KIAS: min g', dn.gMin.toFixed(2), '−3 g limit');
    check(id, 'FLCS g limiter: full aft 8.5–9.4 g, full forward −2.6…−3.3 g', up.gMax > 8.5 && up.gMax < 9.4 && dn.gMin < -2.6 && dn.gMin > -3.3, `+${up.gMax.toFixed(2)} / ${dn.gMin.toFixed(2)} g`);
    // low speed, full aft
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0, altitude: 5000, speed: tasFromCas(180 * KT, 5000) }, world, { throttle: 1 });
    const inp = input({ throttle: 1 });
    let aMax = 0, tvcMax = 0, crashed = false;
    let rateMax = 0;
    fly(f, world, inp, 8, 1 / 60, (t, f, inp) => { inp.pitch = 1; aMax = Math.max(aMax, f.aoa); tvcMax = Math.max(tvcMax, Math.abs(f.tvc.pitch)); });
    // release: the FBW recovers (no departure / spin), the jet unloads and accelerates
    fly(f, world, inp, id === 'f16' ? 4 : 15, 1 / 60, (t, f, inp) => { inp.pitch = 0; rateMax = Math.max(rateMax, Math.abs(f.ad.r) * DEG, Math.abs(f.ad.p) * DEG); });
    const aEnd = f.aoa;
    if (id === 'f16') {
      note(id, 'Full aft stick @180 KIAS: max AoA', `${aMax.toFixed(1)}°`, 'AoA limiter 25°');
      check(id, 'AoA limiter: full aft at low speed stays ≤ 26.5°, unloads when released', aMax > 20 && aMax < 26.5 && aEnd < 21 && !f.crashed, `max α ${aMax.toFixed(1)}°, 4 s after release ${aEnd.toFixed(1)}°`);
    } else {
      note(id, 'Full aft stick @180 KIAS: max AoA / TVC', `${aMax.toFixed(1)}° / ${(tvcMax * 20).toFixed(0)}°`, 'controllable to ~60°, TVC ±20°');
      check(id, 'High AoA with thrust vectoring: ≥ 45° reached, ≤ 62°, no departure, recovers after release', aMax >= 45 && aMax <= 62 && tvcMax > 0.3 && aEnd < 20 && rateMax < 30 && !f.crashed,
        `max α ${aMax.toFixed(1)}°, TVC ${(tvcMax * 20).toFixed(0)}°, α 15 s after release ${aEnd.toFixed(1)}°, max yaw/roll rate ${rateMax.toFixed(1)}°/s`);
    }
    // roll rate
    const r = model(id);
    r.reset({ x: 0, z: 0, heading: 0, altitude: 4000, speed: tasFromCas(350 * KT, 4000) }, world);
    const ri = input({ throttle: r.throttle });
    let pMax = 0;
    fly(r, world, ri, 2.5, 1 / 60, (t, f, inp) => { inp.roll = 1; pMax = Math.max(pMax, Math.abs(f.ad.p) * DEG); });
    const pr = spec.fcs.rollRateMax;
    note(id, 'Full roll stick @350 KIAS: roll rate', `${pMax.toFixed(0)}°/s`, `${pr}°/s`);
    check(id, `Roll-rate command: max ${(pr * 0.85).toFixed(0)}–${(pr * 1.05).toFixed(0)}°/s`, pMax > pr * 0.85 && pMax < pr * 1.05, `${pMax.toFixed(0)}°/s`);
  } else if (spec.fcs.law === 'airbus') {
    // bank protection
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: tasFromCas(250 * KT, 3000) }, world);
    const inp = input({ throttle: f.throttle });
    let bankMax = 0, pMax = 0;
    fly(f, world, inp, 12, 1 / 60, (t, f, inp) => { inp.roll = 1; bankMax = Math.max(bankMax, f.roll); pMax = Math.max(pMax, f.ad.p * DEG); });
    inp.roll = 0;
    fly(f, world, inp, 25);
    note(id, 'Full roll sidestick: roll rate / max bank', `${pMax.toFixed(1)}°/s / ${bankMax.toFixed(1)}°`, '15°/s, 67°');
    check(id, 'Normal law: roll ≤ 15°/s, bank ≤ 67°, released → back to 33°', pMax < 16 && pMax > 12 && bankMax < 68 && bankMax > 60 && Math.abs(f.roll - 33) < 3,
      `p ${pMax.toFixed(1)}°/s, max ${bankMax.toFixed(1)}°, after release ${f.roll.toFixed(1)}°`);
    // bank below 33° is held
    const hb = model(id);
    hb.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: tasFromCas(250 * KT, 3000) }, world, { bank: 25 });
    const hi = input({ throttle: hb.throttle });
    fly(hb, world, hi, 60);
    check(id, 'Bank 25° held hands-off with altitude (bank compensation)', Math.abs(hb.roll - 25) < 2 && Math.abs(hb.altitude - 3000) < 30, `bank ${hb.roll.toFixed(1)}°, alt ${hb.altitude.toFixed(0)} m`);
    // load factor and pitch protections
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: tasFromCas(300 * KT, 3000) }, world, { throttle: 1 });
    const gi = input({ throttle: 1 });
    let nMax = 0, thMax = -99;
    fly(g, world, gi, 20, 1 / 60, (t, f, inp) => { inp.pitch = 1; nMax = Math.max(nMax, f.gForce); thMax = Math.max(thMax, f.pitch); });
    const d = model(id);
    d.reset({ x: 0, z: 0, heading: 0, altitude: 5000, speed: tasFromCas(250 * KT, 5000) }, world, { throttle: 0 });
    const di = input();
    let nMin = 9, thMin = 99;
    fly(d, world, di, 12, 1 / 60, (t, f, inp) => { inp.pitch = -1; nMin = Math.min(nMin, f.gForce); thMin = Math.min(thMin, f.pitch); });
    note(id, 'Full back / forward sidestick: n and pitch', `${nMax.toFixed(2)} g, ${thMax.toFixed(1)}° / ${nMin.toFixed(2)} g, ${thMin.toFixed(1)}°`, '+2.5/−1 g, +30°/−15°');
    check(id, 'Protections: n ≤ 2.6 g, ≥ −1.1 g; pitch ≤ 30.5°, ≥ −15.5°', nMax < 2.6 && nMax > 2.2 && nMin > -1.1 && thMax < 30.5 && thMin > -15.5 && !g.crashed,
      `n ${nMax.toFixed(2)} / ${nMin.toFixed(2)} g, θ ${thMax.toFixed(1)} / ${thMin.toFixed(1)}°`);
  } else {
    // conventional: yoke authority ~ elevator feel
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: tasFromCas(280 * KT, 3000) }, world, { throttle: 1 });
    const gi = input({ throttle: 1 });
    let nMax = 0;
    fly(g, world, gi, 3, 1 / 60, (t, f, inp) => { inp.pitch = 1; nMax = Math.max(nMax, f.gForce); });
    note(id, 'Full yoke pull @280 KIAS: peak load factor', `${nMax.toFixed(2)} g`, 'no protection (limit 2.5 g)');
    check(id, 'Conventional pitch: full pull 2.0–3.2 g at 280 kt (elevator feel), no g protection', nMax > 2.0 && nMax < 3.2, `${nMax.toFixed(2)} g`);
    const r = model(id);
    r.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: tasFromCas(250 * KT, 3000) }, world);
    const ri = input({ throttle: r.throttle });
    let pMax = 0;
    fly(r, world, ri, 3, 1 / 60, (t, f, inp) => { inp.roll = 1; pMax = Math.max(pMax, f.ad.p * DEG); });
    note(id, 'Full wheel @250 KIAS: roll rate', `${pMax.toFixed(0)}°/s`, '≈20–35°/s');
    check(id, 'Roll performance: full wheel 18–40°/s', pMax > 18 && pMax < 40, `${pMax.toFixed(1)}°/s`);
  }

  // ---------------------------------------------------------------------------------------------- 8 hands-off
  {
    const speed = isF ? tasFromCas(350 * KT, 3000) : tasFromCas(250 * KT, 3000);
    const law = spec.fcs.law;
    // (a) trimmed, rolled into 25° of bank, hands off for 3 minutes
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed }, world, { bank: 25 });
    const inp = input({ throttle: f.throttle });
    let maxAbsRoll = 0;
    fly(f, world, inp, 180, 1 / 60, () => { maxAbsRoll = Math.max(maxAbsRoll, Math.abs(f.roll)); });
    const dAlt = f.altitude - 3000, dV = f.airspeed / speed - 1;
    const bankOk = law === 'conventional' ? Math.abs(f.roll) < 5 : Math.abs(f.roll - 25) < 3;
    check(id, `Hands-off 180 s at 25° bank: no divergence, ${law === 'conventional' ? 'wings level (assist)' : 'bank + altitude held'}`,
      !f.crashed && finite(f) && bankOk && Math.abs(dAlt) < (law === 'conventional' ? 150 : 60) && Math.abs(dV) < 0.15 && !f.stalled && maxAbsRoll < 35,
      `alt ${dAlt >= 0 ? '+' : ''}${dAlt.toFixed(0)} m, bank ${f.roll.toFixed(1)}°, speed ${(dV * 100).toFixed(1)} %`);
    // (b) a short pull, then released: the new flight path is held (FBW) / kept by the assist (737)
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed }, world);
    const gi = input({ throttle: g.throttle });
    let g10 = null;
    fly(g, world, gi, 40, 1 / 60, (t, f, inp) => { inp.pitch = t < 1 ? 0.3 : 0; if (g10 == null && t >= 10) g10 = f.ad.gamma * DEG; });
    const g40 = g.ad.gamma * DEG;
    check(id, 'Pull 1 s then release: flight path held within 1.5° over 30 s', g10 != null && Math.abs(g40 - g10) < 1.5 && !g.crashed && Math.abs(g.roll) < 2,
      `γ ${g10?.toFixed(2)}° → ${g40.toFixed(2)}°`);
  }

  // ---------------------------------------------------------------------------------------------- 9 landing
  {
    const res = manualLanding(id);
    note(id, 'Manual landing: touchdown V/S / pitch', `${res.td ? (res.td.verticalSpeed / FPM).toFixed(0) : '—'} fpm / ${res.td?.pitch.toFixed(1)}°`, isF ? '≈ −300…−600 fpm' : '≈ −120…−300 fpm');
    note(id, 'Manual landing: touchdown → stop (max brakes' + (isF ? '' : ' + rev + spoilers') + ')', `${res.stop?.toFixed(0)} m from ${kt(res.tdIas ?? NaN).toFixed(0)} kt`, id === 'a320neo' ? '≈700–1,000 m' : id === 'b737' ? '≈800–1,200 m' : '≈800–1,500 m (no chute)');
    check(id, `Manual approach & landing: touchdown event on the runway, |V/S| < ${isF ? 3.5 : 3} m/s, no crash`, res.td && res.td.onRunway && Math.abs(res.td.verticalSpeed) < (isF ? 3.5 : 3) && !res.crash,
      res.crash ? res.crash : `V/S ${res.td?.verticalSpeed.toFixed(2)} m/s, ${res.tdDist?.toFixed(0)} m past threshold`);
    if (!isF) check(id, 'Ground spoilers deploy at touchdown, reversers only on the ground', res.spoilers && res.revOk && res.revInAirRefused, `spoilers ${res.spoilers}, reverser ${res.revOk}, refused in flight ${res.revInAirRefused}`);
    const range = id === 'a320neo' ? [550, 1100] : id === 'b737' ? [650, 1300] : [600, 1700];
    check(id, `Stopping distance from touchdown ${range[0]}–${range[1]} m`, res.stop > range[0] && res.stop < range[1] && res.stopped, `${res.stop?.toFixed(0)} m, stopped ${res.stopped}`);
  }

  // ---------------------------------------------------------------------------------------------- 10 autoland
  {
    const res = autoland(id);
    note(id, 'Autoland (AIR-SFO-FINAL → 28L): touchdown', res.td ? `${(res.td.verticalSpeed / FPM).toFixed(0)} fpm, ${res.td.pitch.toFixed(1)}°, ${res.lat.toFixed(1)} m off CL, ${res.dist.toFixed(0)} m past thr.` : '—', isF ? 'no real autoland (bonus)' : 'CAT III autoland');
    check(id, `Autopilot APP: LOC/GS capture, flare, touchdown on 28L, ${isF ? 'hand-over at touchdown' : 'rollout to a stop (autobrake)'}`, res.td && res.td.onRunway && Math.abs(res.td.verticalSpeed) < 2.5 && Math.abs(res.lat) < 15 && res.stopped && !res.crash && res.modes.includes('G/S') && res.modes.includes('FLARE') && res.td.pitch < spec.structure.tail.strikeDeg - 1,
      res.crash || `modes ${[...new Set(res.modes)].join(' → ')}, V/S ${res.td?.verticalSpeed.toFixed(2)}, lateral ${res.lat?.toFixed(1)} m`);
  }

  // ---------------------------------------------------------------------------------------------- 10b ground ops
  {
    // no nuisance warnings on a stabilized approach (the autoland run above)
    const al = autoland(id, { watchWarnings: true });
    check(id, 'Stabilized ILS approach: no PULL UP / SINK RATE / GEAR / STALL / OVERSPEED warnings', al.td && al.warnings.length === 0, al.warnings.join(', ') || 'none');
    // taxi: tiller steering at walking pace turns tightly without skidding off / tipping
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0 }, world);
    const inp = input({ throttle: isF ? 0.25 : 0.3 });
    let h0 = null, turned = 0, prevH = null;
    fly(f, world, inp, 60, 1 / 60, (t, f, inp) => {
      if (f.groundSpeed > 5) inp.throttle = 0.0;
      inp.brake = f.groundSpeed > 6 ? 0.3 : 0;       // riding the brakes like a real taxi (fighter idle thrust is high)
      if (t > 8) inp.yaw = 1;
      if (prevH != null) { let d = f.heading - prevH; if (d > 180) d -= 360; if (d < -180) d += 360; turned += d; }
      prevH = f.heading;
      if (turned > 180) return false;
    });
    const r = f.groundSpeed / Math.max(Math.abs(f.ad.r), 1e-3);
    check(id, 'Taxi: full tiller turns 180° (nose-wheel steering), stays upright, no crash', turned > 180 && !f.crashed && Math.abs(f.roll) < 3, `turned ${turned.toFixed(0)}°, radius ≈ ${r.toFixed(0)} m at ${f.groundSpeed.toFixed(1)} m/s`);
    // fuel exhaustion → flameout (no thrust), aircraft still flies (glide)
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: 3000, speed: isF ? 200 : 130 }, world, { fuel: 5 });
    const gi = input({ throttle: g.throttle });
    fly(g, world, gi, 30);
    check(id, 'Fuel exhaustion: engines flame out (N1 → 0, no thrust), glide stays controllable', g.fuel === 0 && g.engines[0].n1 < 0.05 && g.pp.st.thrust <= 0 && !g.crashed && Math.abs(g.roll) < 5,
      `fuel ${g.fuel.toFixed(1)} kg, N1 ${g.engines[0].n1.toFixed(2)}, thrust ${(g.pp.st.thrust / 1000).toFixed(1)} kN`);
    if (!isF) {
      // rejected takeoff: the RTO autobrake and the ground spoilers stop the aircraft when the levers go to idle
      const k = model(id);
      k.reset({ x: 0, z: 0, heading: 0 }, world);
      const ki = input({ throttle: 1 });
      let d0 = null, maxDecel = 0, prevV = 0;
      fly(k, world, ki, 90, 1 / 60, (t, f, inp) => {
        if (d0 == null && f.ias > 110 * KT) { inp.throttle = 0; d0 = -f.position.z; }
        if (d0 != null) { maxDecel = Math.max(maxDecel, (prevV - f.groundSpeed) * 60); if (f.groundSpeed < 0.3) return false; }
        prevV = f.groundSpeed;
      });
      const dist = -k.position.z - d0;
      check(id, 'RTO at 110 kt: autobrake MAX + ground spoilers, stop < 900 m', d0 != null && dist < 900 && k.groundSpeed < 0.5 && k.spoilers > 0.5 && k.autobrake === 'RTO',
        `${dist.toFixed(0)} m, max decel ${(maxDecel / 9.81).toFixed(2)} g, spoilers ${k.spoilers.toFixed(2)}, autobrake ${k.autobrake}`);
      // flap load relief: flaps selected above VFE stay at the highest permitted detent
      const l = model(id);
      l.reset({ x: 0, z: 0, heading: 0, altitude: 2000, speed: tasFromCas(240 * KT, 2000) }, world);
      const li = input({ throttle: l.throttle });
      for (let i = 0; i < spec.flapDetents.length; i++) l.command('flapsDown');
      fly(l, world, li, 60);
      const allowed = spec.flapDetents.filter((d) => !d.vfe || d.vfe >= 240 * KT - 3 * KT).length - 1;
      check(id, 'Flap load relief: full flaps selected at 240 kt go only to the detent within VFE (label follows)', l.flapsIndex === allowed && Math.abs(l.sys.flapPos - allowed) < 0.01 && l.flapsLabel === spec.flapDetents[allowed].label,
        `label ${l.flapsLabel}, surfaces at ${spec.flapDetents[Math.round(l.sys.flapPos)].label}`);
      // takeoff flaps retract automatically when the speed passes their VFE (A320 1+F → 1, 737 5 → UP);
      // the label and the 'flaps' event follow the blown-back position
      const ti = spec.takeoffFlapIndex, vfe = spec.flapDetents[ti].vfe;
      const a = model(id);
      a.reset({ x: 0, z: 0, heading: 0, altitude: 1500, speed: tasFromCas(vfe - 12 * KT, 1500) }, world, { flapIndex: ti, gearDown: false, approach: false, throttle: 1 });
      const ai = input({ throttle: 1 });
      const fev = [];
      a.on('flaps', (e) => fev.push(e));
      const lbl0 = a.flapsLabel;
      fly(a, world, ai, 60, 1 / 60, (t, f) => { if (f.ias > vfe + 12 * KT) return false; });
      const exp = spec.flapDetents.filter((d, i) => i < ti && (!d.vfe || d.vfe + 3 * KT >= a.ias)).length - 1;
      const last = fev[fev.length - 1];
      check(id, `Auto flap retraction past VFE: ${lbl0} → ${spec.flapDetents[exp].label}, label + 'flaps' event follow`, a.flapsLabel === spec.flapDetents[exp].label && last && last.auto && last.label === a.flapsLabel && a.sys.flapPos < ti,
        `${lbl0} → ${a.flapsLabel} at ${kt(a.ias).toFixed(0)} kt, events ${fev.map((e) => e.label).join(',')}`);
    }
  }

  // ---------------------------------------------------------------------------------------------- 11 crashes
  {
    // obstacle (bridge) via world.hitTest
    const bridge = flatWorld({ hitTest: (x, y, z, r) => (Math.abs(x) < 40 + r && z < -3000 + r && z > -3030 - r && y < 90 + r && y > 60 - r ? 'Golden Gate Köprüsü' : null),
      getObstacleHeight: (x, z) => (Math.abs(x) < 40 && z < -3000 && z > -3030 ? 90 : -Infinity) });
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0, altitude: 80, speed: isF ? 150 : 110 }, bridge);
    const inp = input({ throttle: f.throttle });
    let crash = null, pull = false;
    f.on('crash', (e) => { crash = e.reason; });
    f.on('warning', (e) => { if (e.type === 'pullUp' && e.on) pull = true; });
    fly(f, bridge, inp, 60);
    check(id, "Obstacle hitTest → crash \"Golden Gate Köprüsü'ne çarptı\" (pull-up warned before)", f.crashed && crash === "Golden Gate Köprüsü'ne çarptı" && pull, `${crash}, pull up ${pull}`);
    // flying under the bridge deck is fine
    const g = model(id);
    g.reset({ x: 0, z: 0, heading: 0, altitude: 35, speed: isF ? 150 : 110 }, bridge);
    fly(g, bridge, input({ throttle: g.throttle }), 30);
    check(id, 'Flying under the bridge deck (35 m): no false collision', !g.crashed && g.position.z < -3100, g.crashReason || `z ${g.position.z.toFixed(0)}`);
    // with world.getObstacleSpan (deck 60–90 m): no PULL UP under the deck, still PULL UP (and the crash) into it
    const spanWorld = { ...bridge, getObstacleSpan: (x, z) => (Math.abs(x) < 40 && z < -3000 && z > -3030 ? { bottom: 60, top: 90 } : null) };
    const u = model(id);
    u.reset({ x: 0, z: 0, heading: 0, altitude: 35, speed: isF ? 150 : 110 }, spanWorld);
    let puUnder = false; u.on('warning', (e) => { if (e.type === 'pullUp' && e.on) puUnder = true; });
    fly(u, spanWorld, input({ throttle: u.throttle }), 30);
    const o = model(id);
    o.reset({ x: 0, z: 0, heading: 0, altitude: 80, speed: isF ? 150 : 110 }, spanWorld);
    let puInto = false; o.on('warning', (e) => { if (e.type === 'pullUp' && e.on) puInto = true; });
    fly(o, spanWorld, input({ throttle: o.throttle }), 60);
    check(id, 'Obstacle spans: no PULL UP under a bridge deck, PULL UP + crash when flying into it', !puUnder && !u.crashed && puInto && o.crashed,
      `under: pull up ${puUnder}, crash ${u.crashed}; into deck: pull up ${puInto}, ${o.crashReason}`);
    // water ditching
    const water = flatWorld({ getGroundHeight: (x, z) => (z < -1500 ? 0 : ELEV), isWater: (x, z) => z < -1500 });
    const w = model(id);
    w.reset({ x: 0, z: 0, heading: 0, altitude: 60, speed: isF ? 120 : 90 }, water, { throttle: 0 });
    fly(w, water, input(), 80);
    check(id, 'Descending into the bay → crash "suya"', w.crashed && /suya/.test(w.crashReason), w.crashReason);
    // hard landing
    const hl = model(id);
    hl.reset({ x: 0, z: -500, heading: 0, altitude: ELEV + 6, speed: isF ? 80 : 75 }, world, { approach: true, verticalSpeed: -7 });
    hl.reset({ x: 0, z: -500, heading: 0, altitude: ELEV + hl.gearHeight + 4, speed: isF ? 80 : 75 }, world, { approach: true, verticalSpeed: -7 });
    const hi = input({ throttle: 0 });
    fly(hl, world, hi, 10);
    check(id, 'Hard touchdown (−7 m/s) → crash', hl.crashed && /sert|kırıldı|çakıldı/.test(hl.crashReason), hl.crashReason);
    // gear-up landing
    const gu = manualLanding(id, { gearUp: true });
    check(id, 'Landing with the gear up → crash (belly)', gu.crash && /takım|Gövde|Motor/.test(gu.crash), gu.crash || 'no crash');
    // terrain ahead: pull up warning, then crash into the hillside
    const cliff = flatWorld({ getGroundHeight: (x, z) => (z < -4000 ? 400 : ELEV) });
    const c = model(id);
    c.reset({ x: 0, z: 0, heading: 0, altitude: 250, speed: isF ? 180 : 120 }, cliff);
    let pu = null; c.on('warning', (e) => { if (e.type === 'pullUp' && e.on && pu == null) pu = -c.position.z; });
    fly(c, cliff, input({ throttle: c.throttle }), 60);
    check(id, 'Terrain ahead: PULL UP ≥ 5 s before impact, then crash', c.crashed && pu != null && (4000 - pu) / c.spec.spawnSpeed > 3, `warning at ${pu?.toFixed(0)} m (${((4000 - pu) / (isF ? 180 : 120)).toFixed(1)} s early), ${c.crashReason}`);
  }

  // ---------------------------------------------------------------------------------------------- 12 dt robustness
  {
    const runDt = (dt) => {
      const f = model(id);
      f.reset({ x: 0, z: 0, heading: 0, altitude: 2000, speed: isF ? 200 : 120 }, world);
      const inp = input({ throttle: f.throttle });
      fly(f, world, inp, 40, dt, (t, f, inp) => {
        inp.pitch = t >= 2 && t < 4 ? 0.3 : 0;
        inp.roll = t >= 10 && t < 12 ? 0.5 : t >= 20 && t < 22 ? -0.5 : 0;
        inp.throttle = t >= 25 ? 1 : f.throttle;
      });
      return f;
    };
    const a = runDt(1 / 60), b = runDt(0.1), c = runDt(0.25);
    const dp = a.position.distanceTo(b.position), dist = a.position.length();
    check(id, 'dt robustness: dt 0.1 s vs 1/60 s after 40 s of maneuvers (< 0.5 % of the path), dt 0.25 finite', finite(a) && finite(b) && finite(c) && !b.crashed && !c.crashed && dp < 0.005 * dist + 5,
      `Δpos ${dp.toFixed(2)} m over ${dist.toFixed(0)} m, Δalt ${(a.altitude - b.altitude).toFixed(2)} m`);
  }

  // ---------------------------------------------------------------------------------------------- 13 systems & warnings
  {
    const f = model(id);
    f.reset({ x: 0, z: 0, heading: 0 }, world);
    const ev = [];
    for (const e of ['gear', 'flaps', 'reverser', 'warning']) f.on(e, (i) => ev.push([e, i]));
    f.command('gear');
    check(id, 'Gear handle refuses to retract on the ground', f.gearHandleDown && f.gear === 1, `handle ${f.gearHandleDown}`);
    if (isF) {
      f.command('canopy');
      fly(f, world, input(), 5);
      check(id, 'Canopy opens on the ground (4 s)', f.getVisualState().canopy > 0.99, `canopy ${f.getVisualState().canopy.toFixed(2)}`);
      f.command('canopy');
      fly(f, world, input(), 5);
    } else {
      f.command('reverser');
      fly(f, world, input(), 3);
      const vsRev = f.getVisualState().engines[0].reverser;
      f.command('reverser');
      check(id, 'Reversers deploy on the ground at idle', vsRev > 0.99, `reverser ${vsRev.toFixed(2)}`);
      // flap detents
      const labels = [];
      for (let i = 0; i < spec.flapDetents.length; i++) { f.command('flapsDown'); labels.push(f.flapsLabel); }
      const exp = spec.flapDetents.slice(Math.min(spec.takeoffFlapIndex + 1, spec.flapDetents.length - 1)).map((d) => d.label);
      check(id, `Flap detents ${spec.flapDetents.map((d) => d.label).join(' / ')}`, exp.every((l) => labels.includes(l)) && ev.some(([e]) => e === 'flaps'), labels.join(','));
    }
    // airborne: gear retraction time, flaps, speedbrake drag, warnings
    const a = model(id);
    a.reset({ x: 0, z: 0, heading: 0, altitude: 1500, speed: isF ? 150 : 120 }, world, { approach: false });
    const ai = input({ throttle: a.throttle });
    let gearEv = 0; a.on('gear', () => gearEv++);
    a.command('gear');                    // down
    let tDown = null, tUp = null;
    fly(a, world, ai, 15, 1 / 60, (t, f) => { if (tDown == null && f.gear === 1) tDown = t; });
    a.command('gear');                    // up
    fly(a, world, ai, 15, 1 / 60, (t, f) => { if (tUp == null && f.gear === 0) tUp = t; });
    const gRange = isF ? [4, 7] : [6, 11];
    check(id, `Gear cycle in flight: down / up each in ${gRange[0]}–${gRange[1]} s, 'gear' events`, tUp > gRange[0] - 0.1 && tUp < gRange[1] && tDown > gRange[0] - 0.1 && tDown < gRange[1] + 1 && gearEv === 2,
      `down ${tDown?.toFixed(1)} s, up ${tUp?.toFixed(1)} s, events ${gearEv}`);
    if (isF) {
      a.command('canopy');
      check(id, 'Canopy refused in flight', a.getVisualState().canopy === 0, '');
    } else {
      const before = a.pp.st.rev;
      a.command('reverser');
      fly(a, world, ai, 2);
      check(id, 'Reverser refused in flight', a.pp.st.rev === 0 && before === 0, `rev ${a.pp.st.rev}`);
    }
    const cd0 = a.cd.CD;
    a.command('speedbrake');
    fly(a, world, ai, 3);
    check(id, 'Speedbrake raises drag', a.cd.CD > cd0 * 1.15 && a.speedbrake > 0.9, `CD ${cd0.toFixed(4)} → ${a.cd.CD.toFixed(4)}`);
    // bank angle + gear + sink rate warnings (airliners)
    if (!isF) {
      const w = model(id);
      w.reset({ x: 0, z: 0, heading: 0, altitude: 150, speed: 80 }, world, { throttle: 0, gearDown: false, flapIndex: spec.landingFlapIndex, bank: 40, verticalSpeed: -9 });
      fly(w, world, input({ throttle: 0 }), 1);
      const W = w.warnings;
      check(id, 'GPWS: BANK ANGLE, TOO LOW GEAR, SINK RATE', W.bank && W.gear && W.sinkRate, JSON.stringify(W));
    }
    const vis = a.getVisualState();
    const keys = ['time', 'airspeed', 'mach', 'onGround', 'aoa', 'aileron', 'elevator', 'rudder', 'flaps', 'slats', 'spoilers', 'speedbrake', 'gear', 'gearCompression', 'wheelSpeed', 'engines', 'tvc', 'rotor', 'canopy', 'lights'];
    check(id, 'VisualState has every contract field', keys.every((k) => k in vis) && vis.engines.length === spec.engines && vis.gearCompression.length === 3, Object.keys(vis).length + ' fields');
    // stub rig contacts (placeholder Cessna scaled) are accepted as well
    const sc = [{ name: 'contact_nose', kind: 'nose', position: { x: 0, y: -2.5, z: -5 } }, { name: 'contact_main_L', kind: 'main', position: { x: -4, y: -2.5, z: 1.4 } }, { name: 'contact_main_R', kind: 'main', position: { x: 4, y: -2.5, z: 1.4 } }];
    const r = model(id, sc);
    r.reset({ x: 0, z: 0, heading: 0 }, world);
    fly(r, world, input(), 5);
    const gc = r.getVisualState().gearCompression;
    check(id, 'Rig contacts: aircraft rests on the given wheels, gearCompression ≈ 0.35 at static load', !r.crashed && r.onGround && Math.abs(r.position.y - (ELEV + 2.5)) < 0.05 && gc.every((c) => Math.abs(c - 0.35) < 0.03),
      `y ${r.position.y.toFixed(3)}, compression ${gc.map((c) => c.toFixed(2)).join('/')}`);
  }

  // ---------------------------------------------------------------------------------------------- 13b speedbrake
  // in-flight effectiveness against published data (sources in each spec.js next to speedbrakeMax / speedbrakeCD)
  {
    const lvl = (alt, kts) => { const a = levelDecel(id, alt, kts, false), b = levelDecel(id, alt, kts, true); return { a, b, d: b.decel - a.decel, x: b.decel / a.decel }; };
    const dsc = (alt, kts) => { const a = idleDescent(id, alt, kts, false), b = idleDescent(id, alt, kts, true); return { a, b, d: b.fpm - a.fpm }; };
    const held = (...r) => r.every((o) => !o.a.f.crashed && !o.b.f.crashed && (o.a.dh ?? 0) < 30 && (o.b.dh ?? 0) < 30 && (o.a.err ?? 0) < 12 && (o.b.err ?? 0) < 12);
    const fmtL = (r) => `${r.a.decel.toFixed(2)} → ${r.b.decel.toFixed(2)} kt/s (×${r.x.toFixed(2)})`;
    const fmtD = (r) => `${r.a.fpm.toFixed(0)} → ${r.b.fpm.toFixed(0)} fpm (+${r.d.toFixed(0)})`;
    if (id === 'b737') {
      // Boeing 737 FCTM 4.20: idle descent clean → speedbrake 250 kt 1,700 → 2,300 fpm, M.78/280 kt 2,200 → 3,100 fpm,
      // VREF40+70 1,100 → 1,400 fpm; level 280 → 250 kt: speedbrakes cut the time by ≈ 50 %
      const d250 = dsc(3000, 250), d280 = dsc(3000, 280), d215 = dsc(2000, 215), l280 = lvl(3000, 280);
      note(id, 'Speedbrake: idle descent 250 KIAS (3 km)', fmtD(d250), 'FCTM 1,700 → 2,300 fpm (+600)');
      note(id, 'Speedbrake: idle descent 280 KIAS (3 km)', fmtD(d280), 'FCTM 2,200 → 3,100 fpm (+900)');
      note(id, 'Speedbrake: idle descent 215 KIAS (≈VREF40+70)', fmtD(d215), 'FCTM 1,100 → 1,400 fpm (+300)');
      note(id, 'Speedbrake: level idle deceleration 280 KIAS', fmtL(l280), 'FCTM 1.2 kt/s, time −50 % with speedbrake');
      check(id, 'Speedbrake (FLIGHT detent) adds idle descent rate like the FCTM: +450…+800 fpm @250 KIAS, +650…+1,150 @280, +200…+500 @215',
        held(d250, d280, d215) && d250.d > 450 && d250.d < 800 && d280.d > 650 && d280.d < 1150 && d215.d > 200 && d215.d < 500,
        `+${d250.d.toFixed(0)} / +${d280.d.toFixed(0)} / +${d215.d.toFixed(0)} fpm`);
      check(id, 'Speedbrake: level idle deceleration at 280 KIAS ×1.4–2.2', held(l280) && l280.x > 1.4 && l280.x < 2.2, fmtL(l280));
    } else if (id === 'a320neo') {
      // Airbus FCTM PR-NP-SOP-190: level deceleration ≈ 10 kt/NM, "twice i.e. 20 kt/NM, with the use of the speedbrakes";
      // PR-NP-SOP-170: "Speedbrake is very effective in increasing descent rate"
      const l250 = lvl(3000, 250), l210 = lvl(1500, 210), d250 = dsc(3000, 250);
      note(id, 'Speedbrake: level idle deceleration 250 KIAS', fmtL(l250), 'FCTM: ×2 (10 → 20 kt/NM)');
      note(id, 'Speedbrake: level idle deceleration 210 KIAS', fmtL(l210), '×2, "limited effect at low speeds"');
      note(id, 'Speedbrake: idle descent 250 KIAS (3 km)', fmtD(d250), '"very effective in increasing descent rate"');
      check(id, 'A320 at 250 KIAS idle: speedbrake adds ≥ 0.7 kt/s of deceleration, ×1.7–2.5 (FCTM 10 → 20 kt/NM); 210 KIAS ×1.5–2.3',
        held(l250, l210) && l250.d >= 0.7 && l250.x > 1.7 && l250.x < 2.5 && l210.x > 1.5 && l210.x < 2.3, `${fmtL(l250)}; 210 KIAS ${fmtL(l210)}`);
      check(id, 'Speedbrake: idle descent rate at 250 KIAS ×1.6–2.8, VLS effect (1 g AoA rises 0.4–2°)',
        held(d250) && d250.b.fpm / d250.a.fpm > 1.6 && d250.b.fpm / d250.a.fpm < 2.8 && l250.b.f.aoa - l250.a.f.aoa > 0.4 && l250.b.f.aoa - l250.a.f.aoa < 2,
        `${fmtD(d250)}, AoA ${l250.a.f.aoa.toFixed(1)} → ${l250.b.f.aoa.toFixed(1)}°`);
    } else {
      // fighters: drag-area estimates (F-16 split petals 1.38 m² at 60°, F-22 deflected control surfaces), see spec.js
      const l250 = lvl(3000, 250), l350 = lvl(3000, 350), l450 = lvl(3000, 450);
      note(id, 'Speedbrake: level idle deceleration 250 / 350 / 450 KIAS', `${l250.a.decel.toFixed(1)}→${l250.b.decel.toFixed(1)} / ${l350.a.decel.toFixed(1)}→${l350.b.decel.toFixed(1)} / ${l450.a.decel.toFixed(1)}→${l450.b.decel.toFixed(1)} kt/s`,
        id === 'f16' ? 'ΔCD ≈ 0.055 (60° petals)' : 'ΔCD ≈ 0.03 (split surfaces)');
      const r = id === 'f16' ? [3.3, 5.2] : [1.8, 3.6];
      check(id, `Speedbrake at 350 KIAS idle (3 km): +${r[0]}…+${r[1]} kt/s of deceleration, grows with dynamic pressure`,
        held(l250, l350, l450) && l350.d > r[0] && l350.d < r[1] && l450.d > l350.d * 1.3 && l350.d > l250.d * 1.5, `${fmtL(l350)}; +${l250.d.toFixed(1)} / +${l350.d.toFixed(1)} / +${l450.d.toFixed(1)} kt/s at 250 / 350 / 450`);
    }
    if (!isF) {
      // airliners: the drag comes from the spoilers' extension (no instant separate board), ground spoilers stay stronger
      const g = levelDecel(id, 3000, 250, true).f;
      check(id, 'Airliner speedbrake = in-flight spoilers at speedbrakeMax (< ground-spoiler travel), no separate board',
        Math.abs(g.spoilers - spec.speedbrakeMax) < 0.01 && spec.speedbrakeMax < 0.5 && (spec.aero.speedbrakeCD ?? 0.05) === 0, `spoilers ${g.spoilers.toFixed(2)}, speedbrakeCD ${spec.aero.speedbrakeCD}`);
    }
  }
}

// ======================================================================================================
// report
let failed = 0;
const pad = (s, n) => String(s).padEnd(n);
for (const id of ['common', ...IDS]) {
  const rows = results[id] || [];
  if (!rows.length) continue;
  console.log(`\n=== ${id === 'common' ? 'common' : SPECS[id].name} ${'='.repeat(Math.max(0, 90 - id.length))}`);
  for (const r of rows) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 78)} ${r.detail}`);
  }
  if (measured[id]) {
    console.log(`  --- measured vs real ---`);
    for (const m of measured[id]) console.log(`  ${pad(m.name, 52)} ${pad(m.value, 26)} real: ${m.real}`);
  }
}
const total = Object.values(results).reduce((a, r) => a + r.length, 0);
console.log(`\n${total - failed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
