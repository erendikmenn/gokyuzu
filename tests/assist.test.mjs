// Assisted flight tests (src/flight/assist.js, "Destekli uçuş"). Run: node tests/assist.test.mjs (≈ 15 s)
// No framework: scripted "novice" pilots fly the real flight models through the real keyboard input module
// (src/flight/input.js: key ramps, lever rates, the AB detent, the lever sync) against flat worlds built from the San
// Francisco and İstanbul runway data, once with the assist and once without, with the same seeds. Prints a PASS/FAIL
// table and the success rates, exits 1 on failure.
//   - setting semantics: on by default, off stays off (other settings changes, new versions), nothing else writes it
//   - assist off: the models fly exactly as without the layer (trajectory hashes)
//   - novice take-offs (random taps, keys held too long, a guessed rotation speed) and novice landings from 5–10 km at
//     SF and İstanbul airports: assisted ≥ 2× the successes without, and a high absolute rate
//   - hands-off "İnişe geç" from awkward starts; runway choice (no departure-only / backup runways)
//   - pulling back too long (idle and full power): no stall, no crash
//   - helicopter: assisted lift-off into the hover hold, a dumped collective, the vertical landing, never onto water
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFixedWingModel } from '../src/flight/fixedwing.js';
import { createHelicopterModel } from '../src/flight/helicopter.js';
import { createInput } from '../src/flight/input.js';
import { runwayEnds } from '../src/flight/fixedwing-autopilot.js';
import { assistWanted, pickRunway, landingEnds, BACKUP_RUNWAYS } from '../src/flight/assist.js';

const KT = 0.514444, DEG = Math.PI / 180;
const FIXED = ['a320neo', 'b737', 'f16', 'f22'];
const SPECS = {};
for (const id of [...FIXED, 'uh60']) SPECS[id] = (await import(`../src/aircraft/${id}/spec.js`)).default;
const RUNWAYS = {
  sf: JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8')),
  ist: JSON.parse(readFileSync(new URL('../data/ist/runways.json', import.meta.url), 'utf8')),
};

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: String(detail) }); }

// ---- worlds, input, helpers -------------------------------------------------------------------------------------
function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const U = (r, a, b) => a + (b - a) * r();
/** Flat world at `elev` with the map's runways; `water(x, z)` optional. */
function makeWorld(map, elev, water = null) {
  const runways = RUNWAYS[map];
  const rects = [];
  for (const apt of runways.airports) for (const r of apt.runways) {
    const [a, b] = r.ends; const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    rects.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2 });
  }
  const onRw = (x, z) => rects.some((r) => { const px = x - r.ax, pz = z - r.az, al = px * r.ux + pz * r.uz; return al >= 0 && al <= r.len && Math.abs(px * -r.uz + pz * r.ux) <= r.half; });
  return { runways, getGroundHeight: () => elev, isWater: water || (() => false), isOnRunway: onRw, getObstacleHeight: () => -Infinity, hitTest: () => null };
}
const endOf = (map, name) => runwayEnds(RUNWAYS[map]).find((e) => e.name === name);
function model(id) { return SPECS[id].category === 'helicopter' ? createHelicopterModel(SPECS[id], {}) : createFixedWingModel(SPECS[id], {}); }
/** The game's keyboard input module with a fake event target; the lever follows flight.pendingThrottle (globalThis.__game). */
function keyboard() {
  const h = {};
  const input = createInput({ addEventListener: (t, f) => { h[t] = f; } });
  const held = new Set();
  const ev = (code) => ({ code, key: '', repeat: false, metaKey: false, altKey: false, target: null, isTrusted: true, preventDefault() {} });
  return {
    input, held,
    down(code) { if (!held.has(code)) { held.add(code); h.keydown(ev(code)); } },
    up(code) { if (held.has(code)) { held.delete(code); h.keyup(ev(code)); } },
    tap(code) { h.keydown(ev(code)); h.keyup(ev(code)); },
    upAll() { for (const c of [...held]) this.up(c); },
  };
}
/** Key presses scheduled at t for dur seconds (several keys at once, like a person). */
function actions() {
  const list = [];
  return {
    add(t, code, dur) { list.push({ t, code, end: t + dur, on: false, done: false }); },
    run(t, kb) {
      for (const a of list) {
        if (!a.on && !a.done && t >= a.t && t < a.end) { a.on = true; kb.down(a.code); }
        if (a.on && t >= a.end) { a.on = false; a.done = true; kb.up(a.code); }
      }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].done) list.splice(i, 1);
    },
  };
}
const DT = 1 / 30;   // a phone's frame rate

// ---- novice pilots ------------------------------------------------------------------------------------------------
/** Take-off: throttle pushed briefly or a preset, random taps every few seconds (a quarter held 2–5 s), a pull at a
 *  guessed speed (VR −25 … +20 kt) held 1–10 s, the gear maybe, another long pull later maybe. */
function noviceTakeoff(seed) {
  const r = rng(seed * 7919 + 17), q = actions();
  const style = r(), thrT = U(r, 0.5, 3);
  if (style < 0.45) q.add(thrT, 'KeyX', U(r, 0.3, 2.5)); else if (style < 0.75) q.add(thrT, 'Digit9', 0.05); else q.add(thrT, 'KeyX', 4);
  const rotateAt = U(r, -25, 20), pullFor = U(r, 1, 10), gearAfter = r() < 0.5 ? U(r, 3, 25) : Infinity;
  let nextTap = U(r, 1, 4), pulled = false, liftoff = null, geared = false, pulled2 = false;
  const KEYS = ['KeyA', 'KeyD', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyW', 'KeyS'];
  return (t, f, kb) => {
    if (!pulled && f.onGround && f.ias > f.vSpeeds.vr + rotateAt * KT && t > 3) { pulled = true; q.add(t, 'KeyS', pullFor); }
    if (liftoff == null && !f.onGround && f.agl > 3) liftoff = t;
    if (liftoff != null && !geared && t > liftoff + gearAfter) { geared = true; kb.tap('KeyG'); }
    if (liftoff != null && !pulled2 && t > liftoff + 15 && r() < 0.002) { pulled2 = true; q.add(t, 'KeyS', U(r, 3, 12)); }
    if (t > nextTap) { q.add(t, KEYS[Math.floor(r() * KEYS.length)], r() < 0.25 ? U(r, 2, 5) : U(r, 0.1, 0.8)); nextTap = t + U(r, 1.5, 5); }
    q.run(t, kb);
  };
}
/**
 * Landing: late bang-bang taps (reaction 0.3–0.9 s, taps 0.15–0.5 s) toward the runway by eye — or, with the assist,
 * after the "İnişe geç" tap, toward the HUD's cue (sola / sağa, burnu indir / kaldır); throttle fiddling, the gear
 * (70 %), flaps at random, a flare at a random height, random noise keys every 3–8 s, brakes on the ground.
 */
function noviceLanding(seed, { assist, world }) {
  const r = rng(seed * 104729 + 3), q = actions();
  const gearAt = r() < 0.7 ? U(r, 5, 60) : Infinity, flaps = Math.floor(U(r, 0, 5));
  const flareAgl = U(r, 4, 25), flareFor = U(r, 0.5, 3), pressApp = U(r, 1, 5);
  let react = 0, nextNoise = U(r, 3, 8), geared = false, flapN = 0, flared = false, appDone = false, cut = false;
  q.add(U(r, 0.5, 2), 'KeyZ', U(r, 0.3, 1.5));
  const KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyX', 'KeyZ'];
  return (t, f, kb, rw) => {
    if (assist && !appDone && t > pressApp) { appDone = true; if (f.assist) f.assist.requestApproach(world); }
    if (!geared && t > gearAt) { geared = true; kb.tap('KeyG'); }
    if (flapN < flaps && t > 8 + flapN * 6) { flapN++; kb.tap('KeyF'); }
    if (!f.onGround && t > react) {
      react = t + U(r, 0.3, 0.9);
      const app = f.assist && f.assist.app;
      let dir = 0;
      if (app) dir = app.cueRoll;
      else {
        const brg = Math.atan2(rw.x - f.position.x, -(rw.z - f.position.z));
        let e = brg / DEG - f.heading; e = ((e + 540) % 360) - 180;
        dir = Math.abs(e) > 6 ? Math.sign(e) : 0;
      }
      if (dir && Math.abs(f.roll) < 30) q.add(t, dir > 0 ? 'KeyD' : 'KeyA', U(r, 0.15, 0.5));
      else if (Math.abs(f.roll) > 8 && !app) q.add(t, f.roll > 0 ? 'KeyA' : 'KeyD', U(r, 0.1, 0.4));
      const d = Math.hypot(rw.x - f.position.x, rw.z - f.position.z);
      const ang = Math.atan2(f.position.y - rw.elevation, d) / DEG;
      const glide = app ? app.cuePitch : ang > 4.5 ? 1 : ang < 2 ? -1 : 0;
      if (f.agl > flareAgl) {
        if (glide > 0 && f.pitch > -8) q.add(t, 'KeyW', U(r, 0.15, 0.5));
        else if (glide < 0 && f.pitch < 10) q.add(t, 'KeyS', U(r, 0.15, 0.5));
      }
      if (f.ias > (f.vSpeeds.vref || 70) * 1.45 && kb.input.state.throttle > 0.05) q.add(t, 'KeyZ', U(r, 0.2, 0.6));
      else if (f.ias < (f.vSpeeds.vref || 70) * 1.05) q.add(t, 'KeyX', U(r, 0.2, 0.6));
    }
    if (!flared && !f.onGround && f.agl < flareAgl) { flared = true; q.add(t, 'KeyS', flareFor); }
    if (!cut && !f.onGround && f.agl < 10) { cut = true; q.add(t, 'KeyZ', 1.5); }
    if (f.onGround && t > 5) kb.down('KeyB');
    if (t > nextNoise) { q.add(t, KEYS[Math.floor(r() * KEYS.length)], U(r, 0.1, 1.2)); nextNoise = t + U(r, 3, 8); }
    q.run(t, kb);
  };
}

// ---- runs ---------------------------------------------------------------------------------------------------------
/** Take-off from a runway end: success = the take-off event, 150 m above the ground, no crash in `secs`. */
function takeoffRun({ id, map, rwName, seed, assist, secs = 110 }) {
  const rw = endOf(map, rwName), world = makeWorld(map, rw.elevation);
  const f = model(id), kb = keyboard();
  globalThis.__game = { flight: f };
  f.reset({ x: rw.px + rw.dx * 60, z: rw.pz + rw.dz * 60, heading: rw.course }, world);
  if (assist) f.setAssist(true);
  kb.input.setAircraft(f.spec);
  const pilot = noviceTakeoff(seed);
  let t = 0, took = false, high = false;
  f.on('takeoff', () => { took = true; });
  for (let i = 0; i < secs / DT; i++) {
    pilot(t, f, kb);
    kb.input.update(DT); f.step(DT, kb.input.state, world); t += DT;
    if (f.agl > 150) high = true;
    if (f.crashed) break;
  }
  return { ok: took && high && !f.crashed, crashed: f.crashed, reason: f.crashReason };
}
/** Approach start `dist` m before the threshold, `lat` m right of the centreline, heading / altitude offsets; the gear up.
 *  Success = a touchdown on a runway and 25 s without a crash after it (or stopped). */
function landRun({ id, map, rwName, dist, lat = 0, hdgOff = 0, altOff = 0, assist, pilot = null, request = true, maxT = 300 }) {
  const rw = endOf(map, rwName), world = makeWorld(map, rw.elevation);
  const f = model(id), kb = keyboard();
  globalThis.__game = { flight: f };
  const x = rw.x - rw.dx * dist - rw.dz * lat, z = rw.z - rw.dz * dist + rw.dx * lat;
  const alt = rw.elevation + (dist + 300) * Math.tan(3 * DEG) + altOff;
  f.reset({ x, z, heading: rw.course + hdgOff * DEG, altitude: alt, speed: (f.spec.category === 'fighter' ? 250 : 200) * KT }, world, { approach: false, gearDown: false, flapIndex: 0 });
  if (assist) f.setAssist(true);
  kb.input.setAircraft(f.spec);
  kb.input.setThrottle(f.pendingThrottle ?? 0.5); f.pendingThrottle = null;
  let t = 0, td = null;
  f.on('touchdown', (i) => { if (!td) td = { t, vs: i.verticalSpeed, rw: i.onRunway }; });
  for (let i = 0; i < maxT / DT; i++) {
    if (assist && request && i === 30) f.assist.requestApproach(world);
    if (pilot) pilot(t, f, kb, rw);
    kb.input.update(DT); f.step(DT, kb.input.state, world); t += DT;
    if (f.crashed) break;
    if (td && ((f.onGround && f.groundSpeed < 2) || t > td.t + 25)) break;
  }
  return { ok: !!td && td.rw && !f.crashed, td, crashed: f.crashed, reason: f.crashReason };
}

// =================================================================================================================
// 1. setting semantics: on by default, off stays off; nothing but the settings panel writes it
{
  const mem = {};
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  try {
    const S = await import('../src/core/settings.js');
    const stored = S.storedSettings || (() => ({ ...S.DEFAULT_SETTINGS, ...JSON.parse(mem['gokyuzu.settings'] || '{}') }));
    check('Setting: a new player (nothing stored) has assisted flight on', stored().assist === true && assistWanted(stored(), null));
    mem['gokyuzu.settings'] = JSON.stringify({ volumes: { master: 0.5 }, quality: 'low' });   // an older version's object
    check('Setting: an existing player without the key (older version) gets it on', stored().assist === true);
    mem['gokyuzu.settings'] = JSON.stringify({ assist: false, quality: 'low' });
    check('Setting: turned off → off after a reload', stored().assist === false && !assistWanted(stored(), null));
    if (S.patchSettings) S.patchSettings({ muted: true, volumes: { engine: 0.3 } });
    const after = JSON.parse(mem['gokyuzu.settings']);
    check('Setting: other settings changes keep it off (new versions add keys, the stored false stays)', stored().assist === false && after.assist === false, JSON.stringify(after));
    check('Setting: a manual mission suspends it without writing the setting', !assistWanted({ assist: true }, { manual: true }) && assistWanted({ assist: true }, { manual: false }) && JSON.parse(mem['gokyuzu.settings']).assist === false);
    check('Setting: a mission never turns it on when the player turned it off', !assistWanted({ assist: false }, { manual: false }));
  } finally { globalThis.localStorage = prevLS; }
  // only the settings module / panel may write the key: no other source file saves settings with `assist` in them, and
  // the assisted-flight code, the tutorial, missions and the progression never save settings at all
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(new URL('../src', import.meta.url).pathname);
  const writers = [], forbidden = [];
  for (const p of files) {
    const src = readFileSync(p, 'utf8'), rel = p.slice(p.indexOf('/src/') + 1);
    if (rel === 'src/core/settings.js' || rel === 'src/ui/panels.js') continue;
    if (/(save|patch)Settings\([^;]*\bassist\b/.test(src) || /localStorage\.setItem\([^;]*gokyuzu\.settings[^;]*assist/.test(src)) writers.push(rel);
    if (/^src\/(flight|missions|retention)\//.test(rel) || /^src\/ui\/(tutorial|assist-hud|hints|landing)/.test(rel)) {
      if (/\b(save|patch)Settings\s*\(/.test(src)) forbidden.push(rel);
    }
  }
  check('Setting: no module but the settings panel writes `assist`', !writers.length, writers.join(', '));
  check('Setting: the assisted flight, tutorial, hints, landing card, missions and progression never save settings', !forbidden.length, forbidden.join(', '));
}

// telemetry: `as` on the outcome events, no data key that would overwrite an envelope key (t, s, n, m, v)
{
  const bad = [], outcome = {};
  for (const rel of ['src/ui/assist-hud.js', 'src/ui/tutorial.js']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/trackEvent\('(\w+)', \{([^}]*)\}/g)) {
      const keys = [...m[2].matchAll(/(?:^|,)\s*(\w+)\s*(?::|,|$)/g)].map((k) => k[1]);
      for (const k of keys) if (['t', 's', 'n', 'm', 'v'].includes(k)) bad.push(`${rel}: ${m[1]}.${k}`);
      if (['takeoff', 'land', 'crash'].includes(m[1])) outcome[m[1]] = /\bas:/.test(m[2]);
    }
    for (const m of src.matchAll(/setEventExtras\('(\w+)'/g)) outcome[`extras:${m[1]}`] = true;
  }
  check('Telemetry: takeoff / land / crash carry `as`, fly / end get it as event extras', outcome.takeoff && outcome.land && outcome.crash && outcome['extras:fly'] && outcome['extras:end'], JSON.stringify(outcome));
  check('Telemetry: no assisted-flight data key clashes with the envelope keys t / s / n / m / v', !bad.length, bad.join(', '));
}

// 2. assist off: identical flights (the layer never created, created and switched off)
{
  const world = makeWorld('sf', 4, (x) => x > 3000);
  const hashes = [];
  for (const id of [...FIXED, 'uh60']) for (const air of [false, true]) {
    const run = (mode) => {
      const f = model(id);
      f.reset(air ? { x: 0, z: 0, heading: 0.3, altitude: 600, speed: SPECS[id].spawnSpeed } : { x: 0, z: 0, heading: 0 }, world);
      if (mode === 'offAfterOn') { f.setAssist(true); f.setAssist(false); }
      if (mode === 'off') f.setAssist(false);
      const r = rng(id.length * 7 + (air ? 1 : 0));
      const inp = { pitch: 0, roll: 0, yaw: 0, throttle: air ? 0.6 : 0, brake: 0 };
      const h = createHash('sha256');
      for (let i = 0; i < 60 * 60; i++) {
        if (f.pendingThrottle != null) { inp.throttle = f.pendingThrottle; f.pendingThrottle = null; }
        if (i % 20 === 0) { inp.pitch = (r() - 0.45) * 0.6; inp.roll = (r() - 0.5) * 0.5; inp.yaw = (r() - 0.5) * 0.3; }
        if (i % 90 === 0) inp.throttle = Math.min(1, Math.max(0, inp.throttle + (r() - 0.3) * 0.4));
        if (i === 1200 && f.command) f.command('autopilot');
        f.step(1 / 60, inp, world);
        h.update(`${f.position.x},${f.position.y},${f.position.z},${f.quaternion.x},${f.quaternion.w},${f.throttle},${f.crashed}`);
        if (f.crashed) break;
      }
      return { hash: h.digest('hex'), assist: f.assist };
    };
    const a = run('never'), b = run('offAfterOn'), c = run('off');
    hashes.push(a.hash === b.hash && a.hash === c.hash && a.assist === null);
    check(`Assist off: ${id} ${air ? 'airborne' : 'on the ground'} flies exactly as without the layer`, a.hash === b.hash && a.hash === c.hash && a.assist === null, a.hash.slice(0, 12));
  }
}

// 3. novice take-offs: assisted vs not, same seeds
const summary = {};
{
  const N = 10;
  const runways = [['sf', 'KSFO 28R'], ['ist', 'LTFM 35R']];
  let on = 0, off = 0, n = 0, crashOn = 0;
  for (const id of FIXED) {
    let a = 0, b = 0, ca = 0;
    for (let s = 1; s <= N; s++) {
      const [map, rwName] = runways[s % 2];
      const ra = takeoffRun({ id, map, rwName, seed: s, assist: true }), rb = takeoffRun({ id, map, rwName, seed: s, assist: false });
      a += ra.ok; b += rb.ok; ca += ra.crashed;
    }
    check(`Novice take-off ${id}: assisted ${a}/${N} vs without ${b}/${N}`, a >= Math.max(Math.ceil(0.85 * N), 2 * b) && ca === 0, `crashes with the assist: ${ca}`);
    on += a; off += b; n += N; crashOn += ca;
  }
  summary.takeoff = { on, off, n, crashOn };
  check(`Novice take-offs overall: assisted ≥ 2× without (${on}/${n} vs ${off}/${n})`, on >= 2 * off && on >= 0.9 * n);
}

// 4. novice landings from 5–10 km at SF and İstanbul
{
  const AIRPORTS = [['sf', 'KSFO 28R'], ['sf', 'KOAK 30'], ['sf', 'KNGZ 24'], ['ist', 'LTFM 35R'], ['ist', 'LTBA 05'], ['ist', 'LTFJ 06R']];
  const N = 2;
  let on = 0, off = 0, n = 0, crashOn = 0;
  for (const id of FIXED) {
    let a = 0, b = 0, ca = 0, m = 0;
    for (let s = 1; s <= N; s++) for (const [ai, [map, rwName]] of AIRPORTS.entries()) {
      const r = rng(s * 31 + ai * 7 + id.length);
      const start = { dist: 5000 + r() * 5000, lat: (r() - 0.5) * 2000, hdgOff: (r() - 0.5) * 50, altOff: (r() - 0.5) * 300 };
      const rw = endOf(map, rwName), world = makeWorld(map, rw.elevation);
      const pa = noviceLanding(s * 13 + ai, { assist: true, world }), pb = noviceLanding(s * 13 + ai, { assist: false, world });
      const ra = landRun({ id, map, rwName, ...start, assist: true, request: false, pilot: pa, maxT: 420 });
      const rb = landRun({ id, map, rwName, ...start, assist: false, request: false, pilot: pb, maxT: 420 });
      a += ra.ok; b += rb.ok; ca += ra.crashed; m++;
    }
    check(`Novice landing ${id}: assisted ${a}/${m} vs without ${b}/${m}`, a >= Math.max(Math.ceil(0.7 * m), 2 * b) && ca <= 1, `crashes with the assist: ${ca}`);
    on += a; off += b; n += m; crashOn += ca;
  }
  summary.landing = { on, off, n, crashOn };
  check(`Novice landings overall: assisted ≥ 2× without (${on}/${n} vs ${off}/${n})`, on >= 2 * Math.max(off, 1) && on >= 0.8 * n);
}

// 5. hands-off "İnişe geç" from awkward starts (the player taps it and lets go)
{
  const cases = [['sf', 'KSFO 28R', 9000, 0, 0, 0], ['sf', 'KOAK 30', 10000, -2000, -40, -100], ['ist', 'LTFM 35R', 8000, 800, 20, 150],
    ['ist', 'LTBA 05', 6000, -600, 0, 0], ['sf', 'KNGZ 24', 5000, 0, 90, 0], ['ist', 'LTFJ 06R', 7000, 1500, 30, 200]];
  for (const id of FIXED) {
    const bad = [];
    for (const [map, rwName, dist, lat, hdgOff, altOff] of cases) {
      const r = landRun({ id, map, rwName, dist, lat, hdgOff, altOff, assist: true, maxT: 480 });
      if (!r.ok || Math.abs(r.td.vs) > 2) bad.push(`${rwName}: ${r.td ? `vs ${r.td.vs.toFixed(2)} rw ${r.td.rw}` : 'no touchdown'} ${r.reason}`);
    }
    check(`Hands-off assisted approach ${id}: every start lands on the runway, sink < 2 m/s`, !bad.length, bad.join('; '));
  }
}

// 6. runway choice: never a departure-only or backup runway, never too short
{
  const ends = landingEnds(RUNWAYS.ist, 1600);
  const names = ends.map((e) => e.name);
  check('Runway choice: İstanbul departure-only (LTFM 09/27) and backup ends (16L/34R, 17R/35L) are never candidates',
    !names.some((n) => /LTFM (09|27)$/.test(n) || BACKUP_RUNWAYS.has(n)) && names.includes('LTFM 35R') && names.includes('LTFJ 06R'), names.join(', '));
  const r = rng(99);
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const map = i % 2 ? 'ist' : 'sf';
    const x = map === 'sf' ? U(r, -20000, 25000) : U(r, -40000, 40000), z = map === 'sf' ? U(r, -30000, 15000) : U(r, -45000, 30000);
    const e = pickRunway(RUNWAYS[map], x, z, U(r, -Math.PI, Math.PI), { gate: 7000, minLength: 1600 });
    if (!e || !e.landing || BACKUP_RUNWAYS.has(e.name) || e.length - (e.displaced || 0) < 1600) bad++;
  }
  check('Runway choice: 300 random positions pick a landing end, long enough, never a backup runway', bad === 0, `${bad} bad`);
  const sf = landingEnds(RUNWAYS.sf, 1600).map((e) => e.name);
  check('Runway choice: short runways (OAK 15/33, 1029 m) are left out for airliners', !sf.some((n) => /KOAK (15|33)$/.test(n)), sf.join(', '));
}

// 7. pulling back too long: no stall, no crash (idle and full power)
{
  for (const id of FIXED) for (const idle of [true, false]) {
    const world = makeWorld('sf', 4);
    const f = model(id), kb = keyboard();
    globalThis.__game = { flight: f };
    f.reset({ x: 0, z: 0, heading: 0, altitude: 900, speed: SPECS[id].spawnSpeed }, world);
    f.setAssist(true);
    kb.input.setAircraft(f.spec); kb.input.setThrottle(idle ? 0 : 1); f.pendingThrottle = null;
    let stalled = 0, minAgl = Infinity, maxAoa = 0;
    kb.down('KeyS');
    for (let t = 0; t < 90; t += DT) {
      kb.input.update(DT); f.step(DT, kb.input.state, world);
      if (f.stalled) stalled++; minAgl = Math.min(minAgl, f.agl); maxAoa = Math.max(maxAoa, f.aoa);
      if (f.crashed) break;
    }
    check(`Pull back held 90 s, ${idle ? 'idle' : 'full power'}, ${id}: no stall, no crash, no height lost`,
      !f.crashed && stalled === 0 && minAgl > 850 && maxAoa < f.lp.alphaStall / DEG, `max AoA ${maxAoa.toFixed(1)}° (stall ${(f.lp.alphaStall / DEG).toFixed(1)}°), min ${minAgl.toFixed(0)} m`);
  }
}

// 8. helicopter: assisted lift-off, a novice's collective, the vertical landing, water
{
  const N = 16;
  let on = 0, off = 0, hover = 0;
  for (let s = 1; s <= N; s++) {
    for (const assist of [true, false]) {
      const world = makeWorld('sf', 4);
      const f = model('uh60'), kb = keyboard();
      globalThis.__game = { flight: f };
      f.reset({ x: 0, z: 0, heading: 0 }, world);
      if (assist) f.setAssist(true);
      kb.input.setAircraft(f.spec);
      const r = rng(s);
      const holdUp = 0.5 + r() * 4, dumpAt = 30 + r() * 20, dumpFor = 1 + r() * 3;
      let nextTap = 5, rel = null, took = false, hovered = false;
      f.on('takeoff', () => { took = true; });
      for (let t = 0; t < 90; t += DT) {
        if (t > 1 && t < 1 + holdUp) kb.down('KeyX'); else kb.up('KeyX');
        if (t > dumpAt && t < dumpAt + dumpFor) kb.down('KeyZ'); else kb.up('KeyZ');
        if (t > nextTap) { const k = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'][Math.floor(r() * 6)]; kb.down(k); rel = [k, t + 0.2 + r() * 1.5]; nextTap = t + 1 + r() * 4; }
        if (rel && t > rel[1]) { kb.up(rel[0]); rel = null; }
        kb.input.update(DT); f.step(DT, kb.input.state, world);
        if (f.autopilot.on && f.autopilot.mode === 'hover' && f.agl > 4) hovered = true;
        if (f.crashed) break;
      }
      if (assist) { on += took && !f.crashed; hover += hovered; } else off += took && !f.crashed;
    }
  }
  summary.heli = { on, off, n: N };
  check(`Helicopter novice lift-off: assisted ${on}/${N} vs without ${off}/${N} (take-off, no crash in 90 s)`, on >= Math.max(Math.ceil(0.9 * N), 2 * off));
  check('Helicopter: the assisted lift-off engages the hover hold', hover >= Math.ceil(0.9 * N), `${hover}/${N}`);
  for (const [alt, kt, water] of [[150, 60, false], [300, 120, false], [100, 40, true]]) {
    const world = makeWorld('sf', 4, water ? () => true : null);
    world.isWater = water ? () => true : () => false;
    const f = model('uh60'), kb = keyboard();
    globalThis.__game = { flight: f };
    f.reset({ x: 0, z: 0, heading: 0, altitude: 4 + alt, speed: kt * KT }, world);
    f.setAssist(true); kb.input.setAircraft(f.spec);
    let td = null;
    f.on('touchdown', (i) => { td = td || i; });
    for (let t = 0; t < 200; t += DT) {
      if (Math.abs(t - 1) < DT / 2) f.assist.requestApproach(world);
      kb.input.update(DT); f.step(DT, kb.input.state, world);
      if (f.crashed || (td && f.onGround && t > 5)) break;
    }
    if (water) check('Helicopter "İnişe geç" over water: hovers, never descends onto it', !f.crashed && !td && f.agl > 5, `agl ${f.agl.toFixed(1)}`);
    else check(`Helicopter "İnişe geç" from ${alt} m at ${kt} kt: slows down and lands vertically`, !f.crashed && td && Math.abs(td.verticalSpeed) < 1.5 && Math.hypot(f.velocity.x, f.velocity.z) < 1, td ? `vs ${td.verticalSpeed.toFixed(2)}` : 'no touchdown');
  }
}

// helicopter over a city block: no vertical descent between buildings
{
  const world = makeWorld('sf', 4);
  world.getObstacleHeight = (x, z) => (Math.abs(x - 20) < 15 && Math.abs(z) < 15 ? 60 : -Infinity);   // a 56 m building 20 m east
  const f = model('uh60'), kb = keyboard();
  globalThis.__game = { flight: f };
  f.reset({ x: 0, z: 0, heading: 0, altitude: 120, speed: 0 }, world);
  f.setAssist(true); kb.input.setAircraft(f.spec);
  let td = null, stage = '';
  f.on('touchdown', (i) => { td = td || i; });
  for (let t = 0; t < 90; t += DT) {
    if (Math.abs(t - 1) < DT / 2) f.assist.requestApproach(world);
    kb.input.update(DT); f.step(DT, kb.input.state, world);
    if (f.assist.app) stage = f.assist.app.stage;
    if (f.crashed || td) break;
  }
  check('Helicopter "İnişe geç" next to a building: holds the hover, no descent between the buildings', !f.crashed && !td && stage === 'blocked' && f.agl > 7, `stage ${stage}, agl ${f.agl.toFixed(1)}`);
}

// 9. cost per frame (phones): the layer's own work is a small fraction of the model step
{
  const world = makeWorld('sf', 4);
  const time = (assist) => {
    const f = model('a320neo');
    f.reset({ x: 0, z: 0, heading: 0, altitude: 900, speed: SPECS.a320neo.spawnSpeed }, world);
    if (assist) f.setAssist(true);
    const inp = { pitch: 0.1, roll: 0.2, yaw: 0, throttle: 0.6, brake: 0 };
    const t0 = performance.now();
    for (let i = 0; i < 1500; i++) f.step(DT, inp, world);
    return performance.now() - t0;
  };
  time(true); time(false);
  const a = Math.min(time(true), time(true)), b = Math.min(time(false), time(false));
  check('Cost: 1500 assisted frames take < 2× the plain model (no per-frame allocation, a few trig calls per sub-step)', a < b * 2, `${a.toFixed(0)} ms vs ${b.toFixed(0)} ms`);
}

// ---- report --------------------------------------------------------------------------------------------------------
const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
console.log(`\nNovice success, assisted vs without (same seeds):`);
if (summary.takeoff) console.log(`  take-off: ${summary.takeoff.on}/${summary.takeoff.n} vs ${summary.takeoff.off}/${summary.takeoff.n}`);
if (summary.landing) console.log(`  landing:  ${summary.landing.on}/${summary.landing.n} vs ${summary.landing.off}/${summary.landing.n}`);
if (summary.heli) console.log(`  UH-60 lift-off: ${summary.heli.on}/${summary.heli.n} vs ${summary.heli.off}/${summary.heli.n}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
