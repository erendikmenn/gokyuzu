#!/usr/bin/env node
// Device matrix: both maps × device profiles × aircraft, one command, JSON + markdown (docs/perf/findings-2026-09.md).
//
//   node tools/perf/matrix.mjs [--profiles desktop-high,desktop-ultra,laptop-igpu,tablet-chromium,tablet-webkit,phone-cpu4,phone-cpu6]
//        [--maps sf,ist] [--aircraft f16,a320neo] [--ms 6000] [--startup 30] [--fly 60] [--poses sf:a,b;ist:c,d]
//        [--lanes 1] [--rounds 1] [--tag name] [--base URL] [--no-profile] [--settle-max 25000]
//   node tools/perf/matrix.mjs --report <matrix-json> [--report <second-json> …]   (markdown only, merges rounds → noise)
//
// Per run (one browser per profile × map × aircraft, the game's own device overrides; the pixel ratio is pinned at the
// value the game starts with on that class (min(devicePixelRatio, preset pixelRatioMax)) so GPU contention from other
// processes cannot lower it through dynamic resolution; --dynres leaves it to the game):
//   1. load straight into a flight at the map's ground spawn (menu skipped): time to first playable frame (the game's
//      `readyAt`, ms since navigation start), bytes (response body + headers, every request) before it
//   2. first `--startup` s on the runway (chase view, flight running): worst frame, frames > 50 / 100 ms, long tasks,
//      shader programs linked after the start (probe link calls + renderer.info.programs), uploads
//   3. `--fly` s of flying (first aircraft only): autopilot at 70 % throttle from above the spawn toward the city; bytes
//      downloaded, frame statistics, CPU per system (Chromium: CPU profile aggregated by source file, plus a trace
//      window for style / layout / paint / GC), heap and GPU memory growth
//   4. poses (flight paused, the world keeps updating / streaming; settle, then `--ms` of measurement): fps, frame
//      p50 / p95 / p99, CPU per frame and per system (probe wrappers), main-thread busy % (Chromium CPU profile, 1 ms
//      sampling; WebKit: rAF share), long tasks, renderer.info (calls, triangles, textures, geometries, programs), the
//      game's GPU memory meter (src/core/gpu-meter.js), JS heap, allocation rate, pixel ratio and preset in effect
// Frame times depend on GPU contention (other agents share this Mac's GPU): the tables flag them and prefer counts,
// bytes, memory and CPU shares under throttling. --rounds 2 repeats every run in a different order (noise report).
import { launch, openGame, attach, setPose, settle, sleep, arg, flag, save, OUT, POSES, BASE, gpuBusy } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const PROFILES = {
  'desktop-high': { label: 'Desktop 1920×1080, high', engine: 'chromium', width: 1920, height: 1080, dpr: 1, quality: 'high', cpu: 1, pr: 1, extra: '' },
  'desktop-ultra': { label: 'Desktop 1920×1080, ultra', engine: 'chromium', width: 1920, height: 1080, dpr: 1, quality: 'ultra', cpu: 1, pr: 1, extra: '' },
  'laptop-igpu': { label: 'Integrated laptop 1366×768, medium, CPU 2×', engine: 'chromium', width: 1366, height: 768, dpr: 1, quality: 'medium', cpu: 2, pr: 1, extra: '&device=integrated' },
  'tablet-chromium': { label: 'iPad 1024×768 @2 (tablet class, default preset), Chromium', engine: 'chromium', width: 1024, height: 768, dpr: 2, quality: 'auto', cpu: 1, pr: 1.25, extra: '&device=tablet&touch=1', touch: true },
  'phone-portrait': { label: 'Phone 390×844 @3 portrait (rotate prompt, flight paused), CPU 4×', engine: 'chromium', width: 390, height: 844, dpr: 3, quality: 'auto', cpu: 4, pr: 1, extra: '&device=phone&touch=1', touch: true, mobile: true },
  'tablet-webkit': { label: 'iPad 1024×768 @2 (tablet class, default preset), WebKit', engine: 'webkit', width: 1024, height: 768, dpr: 2, quality: 'auto', cpu: 1, pr: 1.25, extra: '&device=tablet&touch=1', touch: true },
  // phones play in landscape: in portrait the game pauses behind a "Telefonu yan çevir" prompt (src/ui/touch.js)
  'phone-cpu4': { label: 'Phone 844×390 @3 landscape (iPhone 390×844; phone class, default preset), CPU 4×', engine: 'chromium', width: 844, height: 390, dpr: 3, quality: 'auto', cpu: 4, pr: 1, extra: '&device=phone&touch=1', touch: true, mobile: true },
  'phone-cpu6': { label: 'Phone 844×390 @3 landscape (phone class, default preset), CPU 6×', engine: 'chromium', width: 844, height: 390, dpr: 3, quality: 'auto', cpu: 6, pr: 1, extra: '&device=phone&touch=1', touch: true, mobile: true },
};
export const MAPS = {
  sf: { spawn: 'KSFO-28R', extra: '', poses: ['downtown-300', 'ggb-low', 'sfo-ground', 'bay-3000ft', 'cockpit'], ground: 'sfo-ground', cockpit: 'cockpit',
    // fly segment: from above SFO toward downtown (streams the Peninsula and the city)
    fly: { x: 0, z: -600, alt: 700, hdg: 353 } },
  ist: { spawn: 'LTFM-35L', extra: '&map=ist', poses: ['ist-peninsula', 'ist-levent', 'ist-bogaz', 'ist-ltfm-ground', 'ist-bagcilar', 'ist-cockpit'], ground: 'ist-ltfm-ground', cockpit: 'ist-cockpit',
    // from above LTFM toward the historic peninsula (Arnavutköy, Başakşehir: dense city, forests)
    fly: { x: -21000, z: -24800, alt: 500, hdg: 142 } },
};

// ------------------------------------------------------------------------------------------ CPU profile → systems
/** System of a source URL (the game's own files; three.js and browser work separately). */
export function systemOf(url) {
  const u = url.replace(/^.*?\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
  if (u.startsWith('src/flight/') || u.startsWith('src/nav/')) return 'flight model + nav';
  if (u.startsWith('src/world-sf/terrain')) return 'world: terrain';
  if (u.startsWith('src/world-sf/city')) return 'world: city + trees';
  if (u.startsWith('src/world-sf/landmarks')) return 'world: landmarks';
  if (u.startsWith('src/world-sf/airports')) return 'world: airports';
  if (u.startsWith('src/world-sf/environment')) return 'world: sky / clouds / fog';
  if (u.startsWith('src/world-sf/')) return 'world: other';
  if (u === 'src/ui/minimap.js') return 'HUD: minimap';
  if (u === 'src/ui/hud.js' || u === 'src/ui/camera-bar.js') return 'HUD';
  if (u.startsWith('src/ui/map')) return 'nav map';
  if (u.startsWith('src/ui/touch')) return 'touch UI';
  if (u.startsWith('src/ui/camera')) return 'camera';
  if (u.startsWith('src/ui/')) return 'UI other';
  if (u.startsWith('src/avionics/')) return 'avionics (cockpit canvases)';
  if (u.startsWith('src/audio/')) return 'audio';
  if (u.startsWith('src/missions/')) return 'missions / ffc';
  if (u.startsWith('src/aircraft/')) return 'aircraft rig';
  if (u.startsWith('src/app/')) return 'render + loop (three.js)';
  if (u.startsWith('src/core/')) return 'core (assets, gpu guard)';
  if (u.startsWith('src/maps/')) return 'maps';
  if (u.startsWith('src/')) return 'other game';
  return null;
}
/** Aggregate a CDP CPU profile: each sample goes to the nearest game source frame on its stack (so three.js / WebGL /
 * native calls count for the system that made them); samples without one: three.js loaders, three.js (async), GC,
 * browser (program: style, layout, paint, compositing, GPU command submission), other JS; idle separately. */
export function aggregateProfile(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const memo = new Map();
  const bucketOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    let b = null, three = null;
    for (let c = id; c != null; c = parent.get(c)) {
      const cf = nodes.get(c).callFrame;
      const s = cf.url ? systemOf(cf.url) : null;
      if (s) { b = s; break; }
      if (!three && /three\/examples\/jsm\//.test(cf.url)) three = 'three.js loaders (GLTF / Draco / meshopt / KTX2)';
      else if (!three && /three\/build\//.test(cf.url)) three = 'three.js (outside a game call)';
    }
    if (!b) {
      const n = nodes.get(id).callFrame.functionName;
      b = n === '(idle)' ? '(idle)' : n === '(garbage collector)' ? 'GC' : n === '(program)' ? 'browser (style / layout / paint / GPU submit)' : three || 'other JS (fetch, workers glue, …)';
    }
    memo.set(id, b);
    return b;
  };
  const counts = {};
  let t = profile.startTime, total = 0, idle = 0;
  const dts = profile.timeDeltas || [];
  profile.samples.forEach((sid, i) => {
    const dt = dts[i + 1] != null ? dts[i + 1] : dts[i] || 0;   // µs until the next sample
    t += dts[i] || 0;
    const b = bucketOf(sid);
    total += dt;
    if (b === '(idle)') { idle += dt; return; }
    counts[b] = (counts[b] || 0) + dt;
  });
  const secs = total / 1e6;
  const busy = total - idle;
  const systems = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { pctOfBusy: +(100 * v / Math.max(1, busy)).toFixed(1), msPerSec: +(v / 1000 / Math.max(secs, 1e-3)).toFixed(1) }]));
  return { secs: +secs.toFixed(1), busyPct: +(100 * busy / Math.max(1, total)).toFixed(1), systems };
}

async function profileStart(cdp, intervalUs = 1000) {
  if (!cdp) return false;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });
  await cdp.send('Profiler.start');
  return true;
}
async function profileStop(cdp) { const { profile } = await cdp.send('Profiler.stop'); return aggregateProfile(profile); }

/** Chrome trace window: main-thread busy %, style / layout / paint / commit / GC ms per second. */
async function traceWindow(cdp, secs) {
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline', 'toplevel'] } });
  await sleep(secs * 1000);
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let data = '';
  for (;;) { const c = await cdp.send('IO.read', { handle: stream, size: 1 << 22 }); data += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  const j = JSON.parse(data); const ev = Array.isArray(j) ? j : j.traceEvents;
  const tn = new Map(); for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = ev.filter((e) => e.ph === 'X' && tn.get(`${e.pid}:${e.tid}`) === 'CrRendererMain');
  // top-level tasks (no nesting): busy share of the main thread
  const tasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').sort((a, b) => a.ts - b.ts);
  let busy = 0, end = 0; for (const e of tasks) { const s = Math.max(e.ts, end), f = e.ts + e.dur; if (f > s) busy += f - s; end = Math.max(end, f); }
  const by = {};
  for (const e of main) if (/^(Layout|UpdateLayoutTree|Paint|PrePaint|Layerize|Commit|MinorGC|MajorGC|V8.GC_SCAVENGER|FireAnimationFrame|Decode Image|ImageDecodeTask|ParseHTML|EvaluateScript|v8.compile|FunctionCall|TimerFire|RunMicrotasks|HitTest)$/.test(e.name)) by[e.name] = (by[e.name] || 0) + e.dur / 1000;
  const workers = {};
  for (const e of ev) { if (e.ph !== 'X' || e.name !== 'RunTask') continue; const n = tn.get(`${e.pid}:${e.tid}`) || ''; if (/Worker|DedicatedWorker|ThreadPool/.test(n)) workers[n.replace(/\d+$/, '')] = (workers[n.replace(/\d+$/, '')] || 0) + e.dur / 1000; }
  return { secs, mainBusyPct: +(100 * busy / 1000 / (secs * 1000)).toFixed(1), msPerSec: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / secs).toFixed(2)])), workerMsPerSec: Object.fromEntries(Object.entries(workers).map(([k, v]) => [k, +(v / secs).toFixed(1)])) };
}

// ------------------------------------------------------------------------------------------ in-page helpers
/** Wrap the per-frame functions the probe does not know (touch UI, ffc, landing card, missions) and keep them wrapped. */
async function wrapExtras(page) {
  await page.evaluate(() => {
    const g = window.__game, P = window.__perf;
    const timed = (obj, name, label) => {
      if (!obj || typeof obj[name] !== 'function' || obj[name].__perfWrapped) return;
      const f = obj[name];
      const w = function (...a) { const t0 = P.realNow(); try { return f.apply(this, a); } finally { P.addSub(label, P.realNow() - t0); } };
      w.__perfWrapped = true; obj[name] = w;
    };
    timed(g.touch, 'update', 'touchUI'); timed(g.ffc, 'update', 'ffc'); timed(g.landing, 'update', 'landing'); timed(g.mission, 'update', 'mission');
    if (g.gpu) timed(g.gpu, 'tick', 'gpuGuard');
  });
}
/** Frame / hitch statistics of the probe frames in [t0, t1] (performance.now ms). */
async function windowStats(page, t0, t1) {
  return page.evaluate(([a, b]) => {
    const P = window.__perf;
    const fr = P.frames.filter((f) => f.t >= a && f.t <= b && f.dt > 0);
    const dts = fr.map((f) => f.dt).sort((x, y) => x - y);
    const pct = (p) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] : null);
    const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const worst = [...fr].sort((x, y) => y.dt - x.dt).slice(0, 3).map((f) => ({ atS: r2((f.t - a) / 1000), dt: r2(f.dt), cpu: r2(f.cpu), compileMs: r2(f.compileMs), links: f.linkCount, upMB: r2(f.upBytes / 1048576), up: Object.fromEntries(Object.entries(f.up).filter(([, v]) => v > 1).map(([k, v]) => [k, r2(v)])), sub: Object.fromEntries(Object.entries(f.sub).filter(([, v]) => v > 1).map(([k, v]) => [k, r2(v)])) }));
    const lts = P.longTasks.filter((l) => l.t >= a && l.t <= b);
    const secs = (b - a) / 1000;
    return {
      secs: r2(secs), frames: fr.length, fps: r2(fr.length / Math.max(secs, 1e-3)),
      frameMs: { p50: r2(pct(0.5)), p95: r2(pct(0.95)), p99: r2(pct(0.99)), max: r2(dts[dts.length - 1] || 0) },
      over50: dts.filter((d) => d > 50).length, over100: dts.filter((d) => d > 100).length, over250: dts.filter((d) => d > 250).length,
      links: fr.reduce((s, f) => s + f.linkCount, 0), compileMs: r2(fr.reduce((s, f) => s + f.compileMs, 0)),
      uploadMB: r2(fr.reduce((s, f) => s + f.upBytes, 0) / 1048576), uploadMs: r2(fr.reduce((s, f) => s + Object.values(f.up).reduce((x, y) => x + y, 0), 0)),
      rafCpuMs: r2(fr.reduce((s, f) => s + f.cpu, 0)), rafBusyPct: r2(100 * fr.reduce((s, f) => s + f.cpu, 0) / Math.max(1, b - a)),
      longTasks: { count: lts.length, totalMs: Math.round(lts.reduce((s, l) => s + l.ms, 0)), max: Math.round(Math.max(0, ...lts.map((l) => l.ms))) },
      worst,
    };
  }, [t0, t1]);
}
/** Game state snapshot: preset in effect, pixel ratio, renderer.info, GPU meter, heap, streaming counters. */
async function gameState(page) {
  return page.evaluate(() => {
    const g = window.__game, r = g.renderer, w = g.world;
    const m = g.gpu && g.gpu.meter;
    const snap = m && m.snapshot ? m.snapshot() : null;
    const city = (w.layers || []).find((l) => l.object && l.object.name === 'city');
    const cs = city && city.stats ? city.stats : null;
    let trees = null;
    if (cs && cs.trees) { try { trees = typeof cs.trees === 'object' ? JSON.parse(JSON.stringify(cs.trees)) : cs.trees; } catch { trees = null; } }
    return {
      quality: g.quality && g.quality.id, deviceClass: g.quality && g.quality.deviceClass, pr: +r.getPixelRatio().toFixed(2), canvas: [r.domElement.width, r.domElement.height],
      info: { calls: r.info.render.calls, triangles: r.info.render.triangles, textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs ? r.info.programs.length : null },
      gpuMB: snap ? snap.gpu : null, gpuPeakMB: snap ? snap.peak : null, gpuTexMB: snap ? snap.tex : null, gpuBufMB: snap ? snap.buf : null, gpuFbMB: snap ? snap.fb : null,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      terrain: w.terrain && w.terrain.stats ? { loaded: w.terrain.stats.loaded, textures: w.terrain.stats.textures } : null,
      city: cs ? { loaded: cs.loaded, visible: cs.visible, trees } : null,
      crashed: !!(g.flight && g.flight.crashed), fps: window.__fps ? +window.__fps.toFixed(1) : null,
    };
  });
}
/** Probe summary since the last mark (per-system CPU means, allocation rate). */
const probeSummary = (page) => page.evaluate(() => { const s = window.__perf.summary(); return { cpuMs: s.cpuMs, subMean: s.subMean, subP95: s.subP95, alloc: s.alloc, uploadMBPerSec: s.uploadMBPerSec, mipmapsPerSec: s.mipmapsPerSec, glDraws: s.glDraws, gpuMs: s.gpuMs, links: s.links }; });

// ------------------------------------------------------------------------------------------ network accounting
function netLog(page) {
  const reqs = [];
  page.on('requestfinished', async (req) => {
    const t = Date.now();
    if (/^(blob|data):/.test(req.url())) return;   // WebKit reports GLTFLoader's blob: image URLs as requests (not network)
    let bytes = 0;
    try { const s = await req.sizes(); bytes = (s.responseBodySize || 0) + (s.responseHeadersSize || 0); } catch { /* ignore */ }
    reqs.push({ t, bytes, url: req.url() });
  });
  return reqs;
}
function netFamily(url) {
  const u = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
  let m;
  if ((m = /^assets\/(sf|ist)\/(terrain|city|airports|landmarks)\/(img|h|hz|trees|l\d|obst)?/.exec(u))) return `${m[2]}${m[3] ? '/' + m[3] : ''}`;
  if (u.startsWith('assets/aircraft/')) return 'aircraft';
  if (u.startsWith('assets/audio/')) return 'audio';
  if (u.startsWith('src/') || u.startsWith('node_modules/') || u.endsWith('.html')) return 'code';
  if (u.startsWith('renders/')) return 'renders';
  if (u.startsWith('data/')) return 'data';
  return 'other';
}
function netSum(reqs, t0, t1) {
  const sel = reqs.filter((r) => r.t >= t0 && r.t <= t1);
  const fam = {};
  for (const r of sel) { const f = netFamily(r.url); fam[f] = (fam[f] || 0) + r.bytes; }
  const MB = (b) => +(b / 1048576).toFixed(2);
  return { requests: sel.length, MB: MB(sel.reduce((s, r) => s + r.bytes, 0)), byFamily: Object.fromEntries(Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, MB(v)])) };
}

// ------------------------------------------------------------------------------------------ one run
export async function runOne({ profile, map, aircraft, full, ms, startupS, flyS, poses, base, doProfile, settleMax, log = console.log }) {
  const P = PROFILES[profile], M = MAPS[map];
  const res = { profile, map, aircraft, label: P.label, engine: P.engine, cpu: P.cpu, date: new Date().toISOString(), poses: {} };
  const { browser, page, cdp, log: plog } = await launch({ engine: P.engine, width: P.width, height: P.height, dpr: P.dpr, gl: 'light', heap: P.engine === 'chromium', cpuThrottle: P.cpu, hasTouch: P.touch, isMobile: P.mobile });
  const reqs = netLog(page);
  const tNav = Date.now();
  try {
    const loadWall = await openGame(page, { aircraft, spawn: M.spawn, quality: P.quality, pr: flag('--dynres') ? 0 : P.pr, extra: `${P.extra}${M.extra}&telemetry=0`, base, timeout: 300000 });
    const t = await page.evaluate(() => ({ readyAt: window.__game.readyAt, t0: window.__game.t0, origin: performance.timeOrigin, prewarm: window.__game.prewarmInfo || null, now: performance.now() }));
    const readyEpoch = t.origin + t.readyAt;
    res.load = { ttfpS: +(t.readyAt / 1000).toFixed(2), loadingS: +((t.readyAt - t.t0) / 1000).toFixed(2), wallS: loadWall, prewarm: t.prewarm, net: netSum(reqs, 0, readyEpoch) };
    await attach(page, { gpu: P.engine === 'chromium', subs: true });
    await wrapExtras(page);
    const programsAtReady = t.prewarm ? t.prewarm.programs2 : null;
    // 2. start-up window on the runway
    const left = startupS * 1000 - (t.now - t.readyAt);
    if (left > 0) await sleep(left);
    res.startup = await windowStats(page, t.readyAt, t.readyAt + startupS * 1000);
    const st0 = await gameState(page);
    res.startup.programsAfterStart = programsAtReady != null ? st0.info.programs - programsAtReady : null;
    res.startup.state = st0;
    res.startup.net = netSum(reqs, readyEpoch, Date.now());
    log(`  ${profile} ${map} ${aircraft}: ttfp ${res.load.ttfpS}s ${res.load.net.MB} MB | first ${startupS}s worst ${res.startup.frameMs.max} ms >50ms ${res.startup.over50} links ${res.startup.links} progs+${res.startup.programsAfterStart} | ${st0.quality}/${st0.deviceClass} pr ${st0.pr} gpu ${st0.gpuMB} MB heap ${st0.heapMB}`);
    // 3. fly segment (first aircraft)
    if (full && flyS > 0) {
      await page.evaluate((f) => {
        const g = window.__game; const rad = (d) => d * Math.PI / 180;
        g.flight.reset({ x: f.x, z: f.z, heading: rad(f.hdg), altitude: f.alt, speed: g.def.spec.spawnSpeed }, g.world);
        g.paused = false; g.cameraRig.setMode('chase'); if (g.cameraRig.reset) g.cameraRig.reset();
      }, M.fly);
      const tap = async (code) => { await page.keyboard.down(code); await sleep(60); await page.keyboard.up(code); };
      await tap('Digit7'); await sleep(200); await tap('KeyO'); await sleep(300);
      const ap = await page.evaluate(() => { const f = window.__game.flight; return f.autopilot ? !!f.autopilot.on : null; });
      if (ap === false) await tap('KeyO');
      const f0 = await page.evaluate(() => { window.__perf.mark(); return performance.now(); });
      const e0 = Date.now();
      const s0 = await gameState(page);
      let prof = null, trace = null;
      const profSecs = Math.min(flyS - 12, 40);
      if (doProfile && cdp && profSecs > 5) { await profileStart(cdp, 500); await sleep(profSecs * 1000); prof = await profileStop(cdp); }
      if (doProfile && cdp && flyS - profSecs >= 10) trace = await traceWindow(cdp, 8);
      const rest = flyS * 1000 - (Date.now() - e0); if (rest > 0) await sleep(rest);
      const f1 = await page.evaluate(() => performance.now());
      res.fly = { ...(await windowStats(page, f0, f1)), probe: await probeSummary(page), profile: prof, trace, net: netSum(reqs, e0, Date.now()), start: s0, end: await gameState(page) };
      res.fly.heapGrowthMB = res.fly.end.heapMB != null && s0.heapMB != null ? res.fly.end.heapMB - s0.heapMB : null;
      res.fly.gpuGrowthMB = res.fly.end.gpuMB != null && s0.gpuMB != null ? res.fly.end.gpuMB - s0.gpuMB : null;
      res.fly.pos = await page.evaluate(() => { const p = window.__game.flight.position; return [Math.round(p.x), Math.round(p.y), Math.round(p.z)]; });
      res.bytesAfterFlyMB = +(netSum(reqs, 0, Date.now()).MB).toFixed(2);
      log(`  ${profile} ${map} fly ${flyS}s: fps ${res.fly.fps} p95 ${res.fly.frameMs.p95} p99 ${res.fly.frameMs.p99} >50 ${res.fly.over50} | +${res.fly.net.MB} MB | busy ${prof ? prof.busyPct : res.fly.rafBusyPct}% | crashed ${res.fly.end.crashed} pos ${res.fly.pos}`);
      if (prof) log(`    cpu: ${Object.entries(prof.systems).slice(0, 8).map(([k, v]) => `${k} ${v.pctOfBusy}%`).join(', ')}`);
    }
    // 4. poses
    const list = full ? poses : poses.filter((p) => p === M.ground || p === M.cockpit || p === poses[0]);
    for (const pose of list) {
      await setPose(page, pose);
      await wrapExtras(page);
      const s = await settle(page, { minMs: 3000, maxMs: settleMax, quietMs: 1500 });
      await sleep(400);
      const a = await page.evaluate(() => { window.__perf.mark(); return performance.now(); });
      let prof = null;
      if (doProfile && cdp) { await profileStart(cdp, 1000); await sleep(ms); prof = await profileStop(cdp); } else await sleep(ms);
      const b = await page.evaluate(() => performance.now());
      const row = { settled: s.idle, settleMs: s.ms, ...(await windowStats(page, a, b)), probe: await probeSummary(page), state: await gameState(page), profile: prof, gpuBusy: gpuBusy() };
      res.poses[pose] = row;
      const sub = row.probe.subMean || {};
      log(`    ${pose.padEnd(16)} fps ${row.fps} p50 ${row.frameMs.p50} p95 ${row.frameMs.p95} p99 ${row.frameMs.p99} | cpu ${row.probe.cpuMs.mean} (render ${sub.render}, world ${sub.world}, hud ${sub.hud}, avi ${sub.avionics ?? 0}) busy ${prof ? prof.busyPct : row.rafBusyPct}% | calls ${row.state.info.calls} tris ${(row.state.info.triangles / 1e6).toFixed(2)}M tex ${row.state.info.textures} geo ${row.state.info.geometries} prog ${row.state.info.programs} | gpu ${row.state.gpuMB} MB heap ${row.state.heapMB} alloc ${row.probe.alloc ? row.probe.alloc.MBperSec : '-'} MB/s | ${row.state.quality} pr ${row.state.pr} [gpu busy ${row.gpuBusy}%]`);
    }
    res.totalNet = netSum(reqs, 0, Date.now());
  } catch (e) {
    res.error = String(e && e.stack || e);
    log(`  FAILED ${profile} ${map} ${aircraft}: ${e.message}`);
  } finally {
    res.errors = plog.errors.slice(0, 10);
    res.http = plog.http.slice(0, 10);
    res.wallS = +((Date.now() - tNav) / 1000).toFixed(1);
    await browser.close().catch(() => {});
  }
  return res;
}

// ------------------------------------------------------------------------------------------ markdown report
const f1 = (x) => (x == null ? '–' : typeof x === 'number' ? (Math.abs(x) >= 100 ? Math.round(x) : +x.toFixed(1)) : x);
/** Median and spread of repeated runs of the same key (noise). */
function mergeRuns(runs) {
  const by = new Map();
  for (const r of runs) { const k = `${r.profile}|${r.map}|${r.aircraft}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return by;
}
const med = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const spread = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)); if (s.length < 2) return null; const m = med(s); return m ? +(100 * (Math.max(...s) - Math.min(...s)) / Math.abs(m)).toFixed(0) : null; };
const cell = (vals) => { const m = med(vals), sp = spread(vals); return sp == null ? f1(m) : `${f1(m)} ±${sp}%`; };

export function markdown(runs) {
  const out = [];
  const by = mergeRuns(runs.filter((r) => !r.error));
  const keys = [...by.keys()];
  out.push('### Start-up (per profile × map × aircraft)', '');
  out.push('| profile | map | aircraft | preset / class | pr | first playable s | MB to first playable | MB after +60 s flying | worst frame first 30 s ms | frames > 50 ms (30 s) | programs linked after start | long tasks (30 s) | GPU MB (meter) | JS heap MB |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const rs = by.get(k), r = rs[0];
    const st = r.startup || {}, s = st.state || {};
    out.push(`| ${r.profile} | ${r.map} | ${r.aircraft} | ${s.quality}/${s.deviceClass} | ${s.pr} | ${cell(rs.map((x) => x.load && x.load.ttfpS))} | ${cell(rs.map((x) => x.load && x.load.net.MB))} | ${r.fly ? cell(rs.map((x) => x.fly && x.fly.net.MB + x.load.net.MB + (x.startup ? x.startup.net.MB : 0))) : '–'} | ${cell(rs.map((x) => x.startup && x.startup.frameMs.max))} | ${cell(rs.map((x) => x.startup && x.startup.over50))} | ${cell(rs.map((x) => x.startup && x.startup.links))} | ${cell(rs.map((x) => x.startup && x.startup.longTasks.count))} | ${cell(rs.map((x) => x.startup && x.startup.state.gpuMB))} | ${cell(rs.map((x) => x.startup && x.startup.state.heapMB))} |`);
  }
  out.push('', '### Flying 60 s (first aircraft): frame times, CPU per system, bytes', '');
  out.push('| profile | map | fps | frame p50 / p95 / p99 ms | > 50 ms | main thread busy % | top CPU systems (% of busy) | style+layout+paint ms/s | GC ms/s | MB downloaded | heap growth MB | GPU growth MB |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const rs = by.get(k).filter((x) => x.fly), r = rs[0];
    if (!r) continue;
    const fl = r.fly, pr = fl.profile, tr = fl.trace;
    const top = pr ? Object.entries(pr.systems).slice(0, 6).map(([n, v]) => `${n} ${v.pctOfBusy}`).join(', ') : Object.entries(fl.probe.subMean || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => `${n} ${v} ms`).join(', ');
    const slp = tr ? ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit'].reduce((s, n) => s + (tr.msPerSec[n] || 0), 0) : null;
    const gc = tr ? ['MinorGC', 'MajorGC', 'V8.GC_SCAVENGER'].reduce((s, n) => s + (tr.msPerSec[n] || 0), 0) : null;
    out.push(`| ${r.profile} | ${r.map} | ${cell(rs.map((x) => x.fly.fps))} | ${f1(fl.frameMs.p50)} / ${f1(fl.frameMs.p95)} / ${f1(fl.frameMs.p99)} | ${fl.over50} | ${pr ? cell(rs.map((x) => x.fly.profile && x.fly.profile.busyPct)) : `${f1(fl.rafBusyPct)} (rAF)`} | ${top} | ${f1(slp)} | ${f1(gc)} | ${cell(rs.map((x) => x.fly.net.MB))} | ${f1(fl.heapGrowthMB)} | ${f1(fl.gpuGrowthMB)} |`);
  }
  out.push('', '### Poses (flight paused, world streaming; frame times are GPU-contended, counts / memory are not)', '');
  out.push('| profile | map | aircraft | pose | fps | frame p50 / p95 / p99 | CPU ms/frame (render / world / HUD / avionics) | busy % | calls | tris M | tex | geo | prog | GPU MB | heap MB | alloc MB/s | preset, pr |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const rs = by.get(k), r = rs[0];
    for (const pose of Object.keys(r.poses || {})) {
      const ps = rs.map((x) => x.poses && x.poses[pose]).filter(Boolean), p = ps[0];
      const sub = p.probe.subMean || {};
      out.push(`| ${r.profile} | ${r.map} | ${r.aircraft} | ${pose} | ${cell(ps.map((x) => x.fps))} | ${f1(p.frameMs.p50)} / ${f1(p.frameMs.p95)} / ${f1(p.frameMs.p99)} | ${cell(ps.map((x) => x.probe.cpuMs.mean))} (${f1(sub.render)} / ${f1(sub.world)} / ${f1(sub.hud)} / ${f1(sub.avionics)}) | ${p.profile ? cell(ps.map((x) => x.profile && x.profile.busyPct)) : f1(p.rafBusyPct) + ' rAF'} | ${cell(ps.map((x) => x.state.info.calls))} | ${f1(p.state.info.triangles / 1e6)} | ${p.state.info.textures} | ${p.state.info.geometries} | ${p.state.info.programs} | ${cell(ps.map((x) => x.state.gpuMB))} | ${f1(p.state.heapMB)} | ${f1(p.probe.alloc && p.probe.alloc.MBperSec)} | ${p.state.quality}, ${p.state.pr} |`);
    }
  }
  const noisy = keys.filter((k) => by.get(k).length > 1);
  if (noisy.length) out.push('', `Rounds: ${Math.max(...keys.map((k) => by.get(k).length))}; "±n %" = (max − min) / median over the rounds (run-to-run noise incl. GPU contention from other processes).`);
  const errs = runs.filter((r) => r.error);
  if (errs.length) out.push('', `Failed runs: ${errs.map((r) => `${r.profile}/${r.map}/${r.aircraft}: ${r.error.split('\n')[0]}`).join('; ')}`);
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------ CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const reports = process.argv.flatMap((a, i) => (a === '--report' ? [process.argv[i + 1]] : []));
  if (reports.length) {
    const runs = reports.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).runs);
    console.log(markdown(runs));
    process.exit(0);
  }
  const profiles = arg('--profiles', Object.keys(PROFILES).join(',')).split(',');
  const maps = arg('--maps', 'sf,ist').split(',');
  const aircraft = arg('--aircraft', 'f16,a320neo').split(',');
  const ms = Number(arg('--ms', 6000)), startupS = Number(arg('--startup', 30)), flyS = Number(arg('--fly', 60));
  const lanes = Number(arg('--lanes', 1)), rounds = Number(arg('--rounds', 1));
  const settleMax = Number(arg('--settle-max', 25000));
  const base = arg('--base', BASE);
  const doProfile = !flag('--no-profile');
  const tag = arg('--tag', `matrix-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
  const poseArg = arg('--poses', '');
  const poseOverride = Object.fromEntries(poseArg ? poseArg.split(';').map((s) => { const [m, l] = s.split(':'); return [m, l.split(',')]; }) : []);
  for (const p of profiles) if (!PROFILES[p]) throw new Error(`unknown profile ${p}`);
  for (const m of maps) for (const p of poseOverride[m] || MAPS[m].poses) if (!POSES[p]) throw new Error(`unknown pose ${p}`);
  // job list: every profile × map × aircraft, rounds in alternating order (interleaved)
  const jobs = [];
  for (let r = 0; r < rounds; r++) {
    const one = [];
    for (const profile of profiles) for (const map of maps) aircraft.forEach((ac, i) => one.push({ profile, map, aircraft: ac, full: i === 0, round: r }));
    jobs.push(...(r % 2 ? one.reverse() : one));
  }
  const out = { tag, base, date: new Date().toISOString(), argv: process.argv.slice(2), host: { gpuBusyAtStart: gpuBusy() }, runs: [] };
  const file = `${tag}.json`;
  let next = 0;
  const logLines = [];
  const log = (s) => { console.log(s); logLines.push(s); };
  async function lane(id) {
    while (next < jobs.length) {
      const j = jobs[next++];
      log(`[lane ${id}] ${j.profile} ${j.map} ${j.aircraft} (round ${j.round + 1}/${rounds}, job ${next}/${jobs.length})`);
      const r = await runOne({ ...j, ms, startupS, flyS, poses: poseOverride[j.map] || MAPS[j.map].poses, base, doProfile, settleMax, log });
      r.round = j.round;
      out.runs.push(r);
      save(file, out);
      fs.writeFileSync(path.join(OUT, `${tag}.md`), markdown(out.runs));
    }
  }
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i + 1)));
  save(file, out);
  fs.writeFileSync(path.join(OUT, `${tag}.md`), markdown(out.runs));
  fs.writeFileSync(path.join(OUT, `${tag}.log`), logLines.join('\n'));
  console.log(`\nsaved ${OUT}/${file} and ${tag}.md`);
}
