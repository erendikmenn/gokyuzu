// QA flight-test harness: launches the game in Chromium (real GPU) or WebKit, samples __game state in the page every
// 250 ms, logs frame times with an independent rAF loop, and offers keyboard helpers + a simple "player" autopilot
// that flies with the same keys a person would press.
import { chromium, webkit } from 'playwright';
import fs from 'node:fs';

export const OUT = '<scratch>/51ed110b-e91a-4455-a1ac-30e1072065cb/scratchpad/qa';
fs.mkdirSync(OUT, { recursive: true });
export const BASE = 'http://localhost:5173/';

export async function launch({ engine = 'chromium', width = 1440, height = 900, dpr = 1 } = {}) {
  const browser = engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const log = { errors: [], warnings: [], console: [], ready: null };
  page.on('console', (m) => {
    const t = m.text();
    if (/GL Driver Message|GPU stall/.test(t)) return;
    if (m.type() === 'error') log.errors.push(t);
    else if (m.type() === 'warning') log.warnings.push(t);
    const r = /\[app\] ready in ([\d.]+) s/.exec(t);
    if (r) log.ready = Number(r[1]);
    log.console.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => log.errors.push(`[pageerror] ${e.message}`));
  // Chromium reports streamed GLB bodies as net::ERR_ABORTED although they load: keep those apart, flag real HTTP errors
  log.aborted = 0;
  page.on('requestfailed', (r) => { const e = r.failure()?.errorText || ''; if (/ERR_ABORTED|cancelled/i.test(e)) log.aborted++; else log.errors.push(`[requestfailed] ${r.url()} ${e}`); });
  page.on('response', (r) => { if (r.status() >= 400) log.errors.push(`[http ${r.status()}] ${r.url()}`); });
  await page.addInitScript(() => {
    // independent frame-time logger
    const q = (window.__qa = { frames: [], hitches: [], log: [], t0: 0, sampling: false });
    let last = 0;
    const tick = (t) => {
      if (last) { const d = t - last; q.frames.push(d); if (d > 50) q.hitches.push({ t: +((t - q.t0) / 1000).toFixed(2), ms: +d.toFixed(0), cam: window.__game && window.__game.cameraRig ? window.__game.cameraRig.mode : '' }); }
      last = t; requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { browser, page, log };
}

/** Open index.html?aircraft=&spawn= and wait until the game loop has a flight model. */
export async function openGame(page, aircraft, spawn, extra = '') {
  const t0 = Date.now();
  const url = `${BASE}index.html?aircraft=${aircraft}${spawn ? `&spawn=${spawn}` : ''}${extra}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.world && window.__game.rig, null, { timeout: 120000, polling: 250 });
  await page.waitForTimeout(500);
  return (Date.now() - t0) / 1000;
}

/** Start in-page sampling of the flight state every `ms`. */
export async function startSampling(page, ms = 250) {
  await page.evaluate((ms) => {
    const q = window.__qa;
    q.log = []; q.t0 = performance.now(); q.frames = []; q.hitches = [];
    clearInterval(q.timer);
    q.timer = setInterval(() => {
      const g = window.__game; const f = g && g.flight;
      if (!f) return;
      const e0 = f.engines && f.engines[0];
      q.log.push({
        t: +((performance.now() - q.t0) / 1000).toFixed(2),
        x: +f.position.x.toFixed(1), y: +f.position.y.toFixed(1), z: +f.position.z.toFixed(1),
        alt: +f.altitude.toFixed(1), agl: +f.agl.toFixed(1), ias: +(f.ias / 0.514444).toFixed(1), tas: +(f.airspeed / 0.514444).toFixed(1),
        vs: +f.verticalSpeed.toFixed(2), pitch: +f.pitch.toFixed(1), roll: +f.roll.toFixed(1), hdg: +f.heading.toFixed(1),
        aoa: +(f.aoa ?? 0).toFixed?.(1), g: +(f.gForce ?? 1).toFixed(2),
        ground: f.onGround, crashed: f.crashed, reason: f.crashReason || '', stalled: f.stalled,
        gear: +(f.gear ?? 0).toFixed(2), gearH: f.gearHandleDown, flaps: +(f.flaps ?? 0).toFixed(2), flapL: f.flapsLabel,
        thr: +(f.throttle ?? 0).toFixed(2), lever: +g.input.state.throttle.toFixed(2), n1: e0 ? +(e0.n1 ?? 0).toFixed(2) : null, ab: e0 ? +(e0.afterburner ?? 0).toFixed(2) : null,
        spoil: +(f.spoilers ?? 0).toFixed(2), rev: +(f.reverser ?? 0).toFixed(2), brk: +(f.brakes ?? 0).toFixed(2), abrk: f.autobrake,
        ap: f.autopilot ? `${f.autopilot.on ? 'ON' : 'off'} ${f.autopilot.mode || ''}` : '',
        rpm: f.rotorRPM ? +f.rotorRPM.toFixed(2) : undefined, coll: f.collective ? +f.collective.toFixed(2) : undefined, tq: f.torque ? +f.torque.toFixed(2) : undefined,
        ip: +g.input.state.pitch.toFixed(2), ir: +g.input.state.roll.toFixed(2),
        cam: g.cameraRig ? g.cameraRig.mode : '', paused: g.paused, fps: window.__fps ? +window.__fps.toFixed(0) : null,
        rigY: g.rig ? +g.rig.object.position.y.toFixed(2) : null,
      });
    }, ms);
  }, ms);
}

export async function getLog(page) { return page.evaluate(() => window.__qa.log); }
export async function state(page) {
  return page.evaluate(() => { const l = window.__qa.log; return l[l.length - 1]; });
}

export async function frameStats(page, reset = true) {
  return page.evaluate((reset) => {
    const f = window.__qa.frames.slice(5);
    if (reset) window.__qa.frames = [];
    if (!f.length) return null;
    const sum = f.reduce((a, b) => a + b, 0);
    const sorted = [...f].sort((a, b) => a - b);
    const p = (x) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))];
    return { frames: f.length, avgFps: +(1000 * f.length / sum).toFixed(1), p50ms: +p(0.5).toFixed(1), p95ms: +p(0.95).toFixed(1), p99ms: +p(0.99).toFixed(1), maxMs: +sorted[sorted.length - 1].toFixed(1), hitches50: f.filter((x) => x > 50).length, hitches100: f.filter((x) => x > 100).length, minFps1s: null };
  }, reset);
}

export async function renderInfo(page) {
  return page.evaluate(() => {
    const r = window.__game.renderer; if (!r) return null;
    const i = r.info;
    const m = performance.memory;
    return { calls: i.render.calls, tris: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : null, heapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(0) : null };
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function tap(page, code, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.down(code); await page.waitForTimeout(60); await page.keyboard.up(code); await page.waitForTimeout(80); } }
export async function hold(page, code, ms) { await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code); }
export async function shot(page, name) { const p = `${OUT}/${name}.png`; await page.screenshot({ path: p }); return p; }

/**
 * Player-like pilot: every ~80 ms reads pitch/roll/heading and taps/holds keys to track a pitch target and a roll
 * target (or heading target). Stops when `until(state)` is true or after `maxMs`. Returns the last state.
 */
export async function fly(page, { pitch = null, roll = 0, heading = null, maxBank = 30, until = null, maxMs = 30000, vs = null, alt = null, pitchLimits = [-15, 25] } = {}) {
  const t0 = Date.now();
  const held = new Set();
  const set = async (code, on) => {
    if (on && !held.has(code)) { await page.keyboard.down(code); held.add(code); }
    if (!on && held.has(code)) { await page.keyboard.up(code); held.delete(code); }
  };
  let s;
  while (Date.now() - t0 < maxMs) {
    s = await page.evaluate(() => { const f = window.__game.flight; return { pitch: f.pitch, roll: f.roll, hdg: f.heading, vs: f.verticalSpeed, alt: f.altitude, agl: f.agl, ias: f.ias / 0.514444, ground: f.onGround, crashed: f.crashed, ip: window.__game.input.state.pitch, ir: window.__game.input.state.roll }; });
    if (s.crashed) break;
    if (until && until(s)) break;
    // roll target
    let rollT = roll;
    if (heading != null) { let e = ((heading - s.hdg + 540) % 360) - 180; rollT = Math.max(-maxBank, Math.min(maxBank, e * 1.5)); }
    const re = rollT - s.roll;
    await set('KeyD', re > 3 && s.ir < 0.5); await set('KeyA', re < -3 && s.ir > -0.5);
    // pitch target (from alt/vs if given)
    let pT = pitch;
    if (alt != null) { const vsT = Math.max(-15, Math.min(15, (alt - s.alt) * 0.15)); pT = Math.max(pitchLimits[0], Math.min(pitchLimits[1], s.pitch + (vsT - s.vs) * 0.4)); }
    else if (vs != null) pT = Math.max(pitchLimits[0], Math.min(pitchLimits[1], s.pitch + (vs - s.vs) * 0.4));
    if (pT != null) {
      const pe = pT - s.pitch;
      await set('KeyS', pe > 1.5 && s.ip < 0.6); await set('KeyW', pe < -1.5 && s.ip > -0.6);
    }
    await page.waitForTimeout(80);
  }
  for (const c of [...held]) await set(c, false);
  return s;
}

export function summarize(log, keys = ['t', 'alt', 'agl', 'ias', 'vs', 'pitch', 'roll', 'hdg', 'ground', 'gear', 'flaps', 'lever', 'n1', 'ab', 'ap', 'crashed', 'reason', 'fps'], every = 4) {
  return log.filter((_, i) => i % every === 0).map((r) => keys.map((k) => `${k}=${r[k]}`).join(' ')).join('\n');
}

export function save(name, obj) { fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(obj, null, 1)); }
