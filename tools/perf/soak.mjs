#!/usr/bin/env node
// Long flight (default 10 min): an F-16 on autopilot tours the map (San Francisco: downtown → Golden Gate → Oakland →
// SFO …, same legs as tools/qa/perf.mjs; İstanbul (--map ist): Boğaz → Levent → Bağcılar → historic peninsula → Kadıköy …
// at 700 m) while the probe records, every --every seconds: frame time percentiles, CPU per subsystem, uploads, compile
// stalls, long tasks, allocation rate + GC drops, JS heap, GPU bytes (GL-level and the game's own meter), textures /
// geometries, terrain / city / tree streaming counters. Three windows add CDP detail:
//   - a Chrome trace (--trace-secs, default 40 s): GC pauses (MinorGC / MajorGC) and main-thread event totals
//   - a CPU profile (--profile-secs, default 40 s): top self-time functions and the functions inside long tasks
//   - heap allocation sampling (--alloc-secs, default 30 s): top allocating functions (per-frame garbage)
// At the end: growth (first sample after 1 min → last) and a leak verdict: least-squares slope of the JS heap, the GPU
// meter and the texture / geometry counts over the second half of the flight (caches should be full by then), per minute.
// Memory trend (every sample, both engines): renderer.info.memory, the GL-level texture / buffer bytes and counts, a scene
// census (objects, and the geometries / materials / textures reachable from the scene: renderer.info counts that grow
// while the reachable ones stay flat are resources removed from the scene without dispose()), the game's streaming
// counters (terrain, city, trees, landmark LODs, airports), the CPU arrays the game still references and the decoder
// workers' WebAssembly heaps. WebKit (--webkit or a WebKit profile): the physical footprint (what iOS jetsam counts;
// macOS `footprint`) of this browser's WebContent and GPU processes, split by memory category, plus a least-squares slope
// per minute of each over the second half of the flight. In WebContent, "WebAssembly Memory" is JavaScriptCore's
// Gigacage: the contents of every ArrayBuffer / typed array (live or awaiting collection); "WebKit Malloc" holds the JS
// heap, WebCore and the decoder workers' wasm heaps. At the end a forced full GC separates garbage from held memory.
// Routes (--route): tour (default: the legs above, a new area every 50 s), line (out and back between two points across
// the map: every area streams in and out again on each pass; --line x1,z1,x2,z2), orbit (circles over one area, the
// control: little streaming churn; --orbit x,z,r).
// usage: node tools/perf/soak.mjs [--minutes 10] [--map sf|ist] [--profile <tools/perf/matrix.mjs profile, e.g. phone-cpu4>]
//          [--preset high] [--cpu 1] [--size 1920x1080] [--every 20] [--aircraft f16] [--spawn AIR-CITY] [--tag name] [--webkit]
//          [--alt 700] [--base URL] [--extra '&x=y' (URL switches for A/B)] [--route tour|line|orbit] [--line x1,z1,x2,z2]
//          [--orbit x,z,r] [--throttle 7] [--gc-every n (a forced full GC before every n-th sample)]
//          [--heap-snapshot (WebKit: JavaScriptCore heap snapshot at the end)] [--init <page script> (diagnostics; a
//          window.__allocStats() it defines is recorded with every sample)]
import { launch, openGame, attach, save, arg, flag, sleep, OUT, BASE } from './lib.mjs';
import { PROFILES } from './matrix.mjs';
import { execSync } from 'node:child_process';

const minutes = Number(arg('--minutes', 10));
const map = arg('--map', 'sf');
const prof = arg('--profile', '') ? PROFILES[arg('--profile')] : null;
if (arg('--profile', '') && !prof) throw new Error(`unknown profile ${arg('--profile')}`);
const preset = prof ? prof.quality : arg('--preset', 'high');
const cpu = prof ? prof.cpu : Number(arg('--cpu', 1));
const every = Number(arg('--every', 20));
const [width, height] = prof ? [prof.width, prof.height] : arg('--size', '1920x1080').split('x').map(Number);
const engine = prof ? prof.engine : flag('--webkit') ? 'webkit' : 'chromium';
const tag = arg('--tag', `soak-${map}-${prof ? arg('--profile') : `${engine}-${preset}${cpu > 1 ? `-cpu${cpu}` : ''}`}`);
const traceSecs = Number(arg('--trace-secs', 40)), profileSecs = Number(arg('--profile-secs', 40)), allocSecs = Number(arg('--alloc-secs', 30));
const MAP = {
  // line: SFO → the Peninsula → downtown → the Presidio; orbit: downtown
  sf: { spawn: 'AIR-CITY', extra: '', legs: [340, 250, 160, 90, 20, 290], alt: 0, line: [1000, 2000, -4000, -21000], orbit: [-1800, -16500, 3500] },
  // start over the Boğaz; legs over Levent / Sarıyer, the European side (Bağcılar, Başakşehir), the historic peninsula,
  // the Asian side (Kadıköy, Ataşehir) and back: every city / tree / terrain area of the core streams in and out
  // line: Başakşehir / Bağcılar → the historic peninsula → Kadıköy / Ataşehir; orbit: the historic peninsula
  ist: { spawn: 'IST-AIR-BOGAZ', extra: '&map=ist', legs: [20, 300, 230, 140, 90, 350], alt: 700, line: [-19000, -3000, 14000, 3500], orbit: [600, 2600, 3500] },
}[map];
const route = arg('--route', 'tour');
if (!['tour', 'line', 'orbit'].includes(route)) throw new Error(`unknown route ${route}`);
const LINE = arg('--line', '') ? arg('--line').split(',').map(Number) : MAP.line;
const ORBIT = arg('--orbit', '') ? arg('--orbit').split(',').map(Number) : MAP.orbit;

// ---- WebKit process footprint (the processes of this browser only: XPC services started by our launch)
const XPC = /^\s*(\d+)\s+.*ms-playwright\/webkit-[^/]+\/com\.apple\.WebKit\.(WebContent|GPU|Networking)\.xpc/;
function webkitPids() {
  const out = new Map();
  for (const l of execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n')) { const m = XPC.exec(l); if (m) out.set(Number(m[1]), m[2]); }
  return out;
}
const UNIT = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 };
/** `footprint <pid>`: total physical footprint and dirty MB per category (null when the process is gone). */
function footprint(pid) {
  let txt;
  try { txt = execSync(`footprint ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }); } catch { return null; }
  const tot = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/.exec(txt);
  if (!tot) return null;
  const cats = {};
  for (const l of txt.split('\n')) {
    const m = /^\s*([\d.]+)\s*(B|KB|MB|GB)\s+[\d.]+\s*(?:B|KB|MB|GB)\s+([\d.]+)\s*(B|KB|MB|GB)\s+\d+\s+(.+?)\s*$/.exec(l);
    if (m && m[5] !== 'TOTAL') cats[m[5]] = +(Number(m[1]) * UNIT[m[2]]).toFixed(1);
  }
  return { MB: Math.round(Number(tot[1]) * UNIT[tot[2]]), cats };
}

const pidsBefore = engine === 'webkit' ? webkitPids() : null;
const { browser, page, cdp, log } = await launch({ engine, width, height, dpr: prof ? prof.dpr : 1, gl: 'mem', heap: true, cpuThrottle: cpu, hasTouch: prof && prof.touch, isMobile: prof && prof.mobile });
const out = { map, profile: arg('--profile', null), preset, cpu, engine, width, height, series: [], windows: {} };
if (arg('--init', '')) await page.addInitScript({ path: arg('--init') });   // diagnostic page script (runs before the game)
const loadS = await openGame(page, { aircraft: arg('--aircraft', 'f16'), spawn: arg('--spawn', MAP.spawn), quality: preset, pr: prof ? prof.pr : 1, extra: `${prof ? prof.extra : ''}${MAP.extra}&telemetry=0${arg('--extra', '')}`, base: arg('--base', BASE) });
await attach(page, { gpu: engine === 'chromium', subs: true });
out.loadS = loadS;
console.log(`loaded in ${loadS}s`);
// WebKit: JavaScriptCore collections per sample window (Web Inspector Heap.garbageCollected: full vs eden)
const gcLog = { full: 0, partial: 0, fullMs: 0, partialMs: 0 };
if (engine === 'webkit') {
  try {
    const impl = page._connection.toImpl(page), d = impl.delegate || impl._delegate;
    d._session.on('Heap.garbageCollected', (p) => { const c = p.collection, k = c.type === 'full' ? 'full' : 'partial'; gcLog[k]++; gcLog[`${k}Ms`] += (c.endTime - c.startTime) * 1000; });
    await d._session.send('Heap.enable', {});
  } catch (e) { console.log('GC events unavailable:', e.message); }
}
// our WebKit processes: the XPC services that appeared with this launch (another browser started meanwhile would be
// counted too: the tool warns when it sees more than one WebContent process)
let ourPids = null;
if (pidsBefore) {
  ourPids = new Map([...webkitPids()].filter(([pid, kind]) => !pidsBefore.has(pid) && kind !== 'Networking'));
  const nWC = [...ourPids.values()].filter((k) => k === 'WebContent').length;
  out.pids = Object.fromEntries(ourPids);
  console.log(`WebKit processes: ${JSON.stringify(out.pids)}${nWC !== 1 ? `  WARNING: ${nWC} WebContent processes (another WebKit started meanwhile?)` : ''}`);
}
const alt = Number(arg('--alt', MAP.alt || (route === 'tour' ? 0 : 700)));
const bearing = (x, z, tx, tz) => ((Math.atan2(tx - x, -(tz - z)) * 180 / Math.PI) + 360) % 360;   // heading 0 = north (-Z), 90 = east (+X)
if (route === 'line') await page.evaluate(([x, z, h, alt]) => { const g = window.__game; g.flight.reset({ x, z, heading: h * Math.PI / 180, altitude: alt, speed: g.def.spec.spawnSpeed }, g.world); }, [LINE[0], LINE[1], bearing(LINE[0], LINE[1], LINE[2], LINE[3]), alt]);
else if (route === 'orbit') await page.evaluate(([x, z, alt]) => { const g = window.__game; g.flight.reset({ x, z, heading: Math.PI / 2, altitude: alt, speed: g.def.spec.spawnSpeed }, g.world); }, [ORBIT[0], ORBIT[1] - ORBIT[2], alt]);
else if (alt) await page.evaluate((alt) => { const g = window.__game, s = g.spawn; g.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: alt, speed: g.def.spec.spawnSpeed }, g.world); }, alt);

const tap = async (code) => { await page.keyboard.down(code); await sleep(60); await page.keyboard.up(code); };
// camera chase, autopilot on (heading hold); steer the AP heading with A/D like a player
await page.evaluate(() => window.__game.cameraRig.setMode('chase'));
await tap(`Digit${arg('--throttle', 7)}`);   // throttle 70 %
await sleep(300);
await tap('KeyO');
const legs = MAP.legs;
const t0 = Date.now();
let nextSample = 0, traceAt = 90, profAt = 200, allocAt = 320;
const secs = () => (Date.now() - t0) / 1000;
await page.evaluate(() => window.__perf.mark());

/** A full garbage collection now: CDP in Chromium, the Web Inspector protocol's Heap.gc in WebKit (Playwright's in-process
 *  server objects; false when unavailable). */
async function forceGC() {
  try {
    if (engine === 'chromium') { await cdp.send('HeapProfiler.collectGarbage'); return true; }
    const impl = page._connection.toImpl(page), d = impl.delegate || impl._delegate;
    await d._session.send('Heap.gc', {});
    return true;
  } catch (e) { console.log('forced GC unavailable:', e.message); return false; }
}
const gcEvery = Number(arg('--gc-every', 0));   // diagnostic: a forced full GC before every n-th sample (the live footprint)

/** WebAssembly heap (MB) of every worker by kind: three.js' decoder workers keep their wasm instance (and its heap, which
 *  only ever grows) for the page's lifetime. The decoders' worker scripts are the loaders' function bodies, so their state
 *  is reachable by name: Draco `decoderConfig` (emscripten module), KTX2 `BasisModule`, meshopt `self.ready`. */
async function workerHeaps() {
  const out = {};
  for (const w of page.workers()) {
    const r = await Promise.race([w.evaluate(async () => {
      const mb = (b) => +(b / 1048576).toFixed(1);
      /* global decoderConfig, BasisModule */
      try { if (typeof decoderConfig !== 'undefined' && decoderConfig) return ['draco', decoderConfig.HEAP8 ? mb(decoderConfig.HEAP8.byteLength) : null]; } catch { /* not this kind */ }
      try { if (typeof BasisModule !== 'undefined' && BasisModule) return ['basis', BasisModule.HEAP8 ? mb(BasisModule.HEAP8.byteLength) : null]; } catch { /* not this kind */ }
      if (self.ready && self.ready.then) { const i = await self.ready; return ['meshopt', mb(i.exports.memory.buffer.byteLength)]; }
      return ['other', null];
    }).catch(() => ['gone', null]), sleep(3000).then(() => ['busy', null])]);
    (out[r[0]] || (out[r[0]] = [])).push(r[1]);
  }
  return out;
}

let sampleN = 0;
async function sample() {
  if (gcEvery && ++sampleN % gcEvery === 0 && await forceGC()) await sleep(3000);
  const s = await page.evaluate(() => {
    const P = window.__perf, g = window.__game, w = g.world;
    const sum = P.summary();
    P.frames.length = 0; P.longTasks.length = 0; P.mark();   // (the probe keeps only the current window: its own memory stays flat)
    const city = (w.layers || []).find((l) => l.object && l.object.name === 'city');
    const f = g.flight;
    const m = g.gpu && g.gpu.meter && g.gpu.meter.snapshot ? g.gpu.meter.snapshot() : null;
    // scene census: what the scene graph still references (renderer.info counts every geometry / texture not disposed)
    const geos = new Set(), mats = new Set(), texs = new Set();
    let objects = 0, meshes = 0;
    const addTex = (v) => { if (v && v.isTexture) texs.add(v); };
    g.scene.traverse((o) => {
      objects++;
      if (!o.geometry) return;
      meshes++; geos.add(o.geometry);
      for (const mt of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!mt || mats.has(mt)) continue;
        mats.add(mt);
        for (const k in mt) addTex(mt[k]);
        if (mt.uniforms) for (const u of Object.values(mt.uniforms)) { const v = u && u.value; if (Array.isArray(v)) v.forEach(addTex); else addTex(v); }
      }
    });
    const lm = (w.layers || []).find((l) => l.object && l.object.name === 'landmarks');
    const ap = (w.layers || []).find((l) => l.object && l.object.name === 'airports');
    let lmLods = 0; if (lm && lm.items) for (const it of lm.items) for (const o of it.lods || []) if (o) lmLods++;
    // CPU copies the game still holds: vertex / index arrays (unique ArrayBuffers) of every geometry in the scene graph
    // (hidden LODs included) and of the loaded terrain tiles outside it, decoded images / KTX2 levels of scene textures;
    // landmark LODs loaded but not shown separately (the layer never unloads a LOD)
    const bufs = new Set();
    let imgMB = 0;
    const geoArrays = (geo) => { for (const a of [...Object.values(geo.attributes), geo.index]) { const arr = a && (a.isInterleavedBufferAttribute ? a.data.array : a.array); if (arr && arr.buffer) bufs.add(arr.buffer); } };
    for (const geo of geos) geoArrays(geo);
    if (w.terrain.nodes) for (const n of w.terrain.nodes.values()) { if (n.mesh && !geos.has(n.mesh.geometry)) geoArrays(n.mesh.geometry); if (n.heights && n.heights.buffer) bufs.add(n.heights.buffer); }
    for (const t of texs) { const d = t.source && t.source.data; if (d && d.width && !d.data && typeof d.close === 'function') imgMB += d.width * d.height * 4 / 1048576; if (t.mipmaps) for (const m of t.mipmaps) if (m && m.data && m.data.buffer) bufs.add(m.data.buffer); }
    let arraysMB = 0; for (const b of bufs) arraysMB += b.byteLength / 1048576;
    let lmHiddenMB = 0; const lmSeen = new Set();
    if (lm && lm.items) for (const it of lm.items) for (const o of it.lods || []) if (o && !o.visible) o.traverse((c) => { if (!c.geometry) return; for (const a of [...Object.values(c.geometry.attributes), c.geometry.index]) { const arr = a && (a.isInterleavedBufferAttribute ? a.data.array : a.array); if (arr && arr.buffer && !lmSeen.has(arr.buffer)) { lmSeen.add(arr.buffer); lmHiddenMB += arr.buffer.byteLength / 1048576; } } });
    const census = { objects, meshes, geos: geos.size, mats: mats.size, texs: texs.size, lmLods, arraysMB: Math.round(arraysMB), imagesMB: Math.round(imgMB), lmHiddenArraysMB: Math.round(lmHiddenMB), airportObjs: ap ? (() => { let n = 0; ap.object.traverse(() => n++); return n; })() : null };
    return { ...sum, meter: m, census, quality: g.quality && g.quality.id, pos: [Math.round(f.position.x), Math.round(f.position.y), Math.round(f.position.z)], crashed: f.crashed, terrain: { ...(w.terrain.stats || {}) }, city: city && city.stats ? { loaded: city.stats.loaded, visible: city.stats.visible, queued: city.stats.queued, trees: city.stats.trees } : null };
  });
  let fp = null;
  if (ourPids) {
    fp = { WebContent: 0, GPU: 0, cats: {}, gone: [] };
    for (const [pid, kind] of ourPids) {
      const r = footprint(pid);
      if (!r) { fp.gone.push(pid); continue; }
      fp[kind] += r.MB;
      for (const [c, v] of Object.entries(r.cats)) { const k = `${kind}:${c}`; fp.cats[k] = +((fp.cats[k] || 0) + v).toFixed(1); }
    }
    fp.total = fp.WebContent + fp.GPU;
  }
  const row = { t: Math.round(secs()), pos: s.pos, crashed: s.crashed, fps: s.fps, p50: s.frameMs.p50, p95: s.frameMs.p95, p99: s.frameMs.p99, max: s.frameMs.max, over50: s.hitches.over50, over100: s.hitches.over100,
    cpu: s.cpuMs.mean, cpuP95: s.cpuMs.p95, gpu: s.gpuMs && s.gpuMs.mean, sub: s.subMean, subP95: s.subP95, upMBs: s.uploadMBPerSec, up: s.uploadMsPerFrame, compileMs: s.compileMs, links: s.links,
    longTasks: s.longTasks, alloc: s.alloc, heapMB: s.heapMB, gpuMB: s.gpuBytesMB, meterMB: s.meter ? s.meter.gpu : null, meterPeakMB: s.meter ? s.meter.peak : null, quality: s.quality, calls: s.info.calls, tris: s.info.triangles, programs: s.info.programs, textures: s.info.textures, geometries: s.info.geometries,
    terrain: s.terrain, city: s.city, census: s.census, workers: await workerHeaps(), fp, gc: { ...gcLog, fullMs: Math.round(gcLog.fullMs), partialMs: Math.round(gcLog.partialMs) },
    allocs: await page.evaluate(() => (window.__allocStats ? window.__allocStats() : null)) };
  gcLog.full = gcLog.partial = gcLog.fullMs = gcLog.partialMs = 0;
  out.series.push(row);
  console.log(`t=${row.t}s pos ${row.pos} fps ${row.fps} p95 ${row.p95} p99 ${row.p99} max ${row.max} >50ms ${row.over50} | cpu ${row.cpu} gpu ${row.gpu} | up ${row.upMBs} MB/s compile ${row.compileMs} ms (${row.links}) | alloc ${row.alloc && row.alloc.MBperSec} MB/s gc ${row.alloc && row.alloc.gcDrops} | heap ${row.heapMB} gpu ${row.gpuMB && (row.gpuMB.tex + row.gpuMB.buf).toFixed(0)} MB tex ${row.textures} geo ${row.geometries} | terrain ${row.terrain.loaded}/${row.terrain.textures} city ${row.city && row.city.loaded} | scene geo ${s.census.geos} tex ${s.census.texs} lm ${s.census.lmLods} arrays ${s.census.arraysMB} MB (hidden LODs ${s.census.lmHiddenArraysMB}) images ${s.census.imagesMB} MB | GC full ${row.gc.full} eden ${row.gc.partial} | workers ${Object.entries(row.workers).map(([k, v]) => `${k} ${v.join('/')}`).join(', ')}${fp ? ` | WebContent ${fp.WebContent} GPU ${fp.GPU} MB (ArrayBuffers ${Math.round(fp.cats['WebContent:WebAssembly Memory'] || 0)}, WebKit malloc ${Math.round(fp.cats['WebContent:WebKit Malloc'] || 0)})` : ''}`);
  save(`${tag}.json`, out);
}

async function traceWindow() {
  if (engine !== 'chromium') return;
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-devtools.timeline'] } });
  await steerFor(traceSecs);
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let data = '';
  for (;;) { const c = await cdp.send('IO.read', { handle: stream, size: 1 << 22 }); data += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  const j = JSON.parse(data); const ev = Array.isArray(j) ? j : j.traceEvents;
  const tn = new Map(); for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = ev.filter((e) => e.ph === 'X' && tn.get(`${e.pid}:${e.tid}`) === 'CrRendererMain');
  const gc = main.filter((e) => /^(MinorGC|MajorGC|V8.GC_MARK_COMPACTOR|V8.GCScavenger|V8.GCFinalizeMC|BlinkGC)/.test(e.name));
  const byName = {};
  for (const e of gc) { const b = byName[e.name] || (byName[e.name] = { n: 0, ms: 0, max: 0 }); b.n++; b.ms += e.dur / 1000; b.max = Math.max(b.max, e.dur / 1000); }
  for (const b of Object.values(byName)) { b.ms = Math.round(b.ms); b.max = +b.max.toFixed(1); }
  const tops = {};
  for (const e of main) if (/^(Layout|UpdateLayoutTree|Paint|PrePaint|Layerize|Commit|RunMicrotasks|TimerFire|FireAnimationFrame|FunctionCall|ParseHTML|HitTest|ScheduleStyleRecalculation|Decode Image)$/.test(e.name)) tops[e.name] = (tops[e.name] || 0) + e.dur / 1000;
  out.windows.trace = { secs: traceSecs, gc: byName, gcPerSecMs: +(gc.filter((e) => /^(MinorGC|MajorGC)$/.test(e.name)).reduce((a, e) => a + e.dur, 0) / 1000 / traceSecs).toFixed(2), mainEventsMsPerSec: Object.fromEntries(Object.entries(tops).map(([k, v]) => [k, +(v / traceSecs).toFixed(2)])) };
  console.log('trace window:', JSON.stringify(out.windows.trace));
}

async function profileWindow() {
  if (engine !== 'chromium') return;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  const pt0 = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__perf.ltMark = window.__perf.longTasks.length; });
  await cdp.send('Profiler.start');
  await steerFor(profileSecs);
  const { profile } = await cdp.send('Profiler.stop');
  const lts = await page.evaluate(() => window.__perf.longTasks.slice(window.__perf.ltMark));
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const label = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*?\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
  const self = new Map(), incl = new Map();
  let t = profile.startTime; const times = profile.timeDeltas.map((d) => (t += d));
  const ltSelf = new Map();
  const toPerf = (us) => pt0 + (us - profile.startTime) / 1000;
  profile.samples.forEach((sid, i) => {
    const n = nodes.get(sid); const l = label(n);
    self.set(l, (self.get(l) || 0) + 1);
    const seen = new Set(); let c = sid;
    while (c != null) { const lb = label(nodes.get(c)); if (!seen.has(lb)) { seen.add(lb); incl.set(lb, (incl.get(lb) || 0) + 1); } c = parent.get(c); }
    const pt = toPerf(times[i]);
    if (lts.some((lt) => pt >= lt.t && pt <= lt.t + lt.ms)) ltSelf.set(l, (ltSelf.get(l) || 0) + 1);
  });
  const total = profile.samples.length;
  const top = (m, k, filter = () => true) => [...m].filter(([l]) => filter(l)).sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, c]) => ({ fn: l, pct: +(100 * c / total).toFixed(1), msPerSec: +(c * 0.25 / profileSecs).toFixed(2) }));
  out.windows.profile = { secs: profileSecs, samples: total, topSelf: top(self, 25, (l) => !/^\((idle|program|garbage collector)\)/.test(l)), special: top(self, 5, (l) => /^\((idle|program|garbage collector)\)/.test(l)), topInclusive: top(incl, 30, (l) => /src\/|three/.test(l)), longTasks: lts.map((l) => Math.round(l.ms)), longTaskSelf: top(ltSelf, 12) };
  console.log('profile top self:', out.windows.profile.topSelf.slice(0, 12).map((x) => `${x.pct}% ${x.fn}`).join('\n  '));
}

async function allocWindow() {
  if (engine !== 'chromium') return;
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });   // all allocations, not only survivors
  await steerFor(allocSecs);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const self = new Map();
  (function walk(n) {
    const cf = n.callFrame; const l = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*?\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
    self.set(l, (self.get(l) || 0) + n.selfSize);
    for (const c of n.children || []) walk(c);
  })(profile.head);
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  out.windows.alloc = { secs: allocSecs, sampledMB: +(total / 1048576).toFixed(1), MBperSec: +(total / 1048576 / allocSecs).toFixed(2), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([fn, b]) => ({ fn, MB: +(b / 1048576).toFixed(2), pct: +(100 * b / total).toFixed(1) })) };
  console.log('alloc top:', out.windows.alloc.top.slice(0, 10).map((x) => `${x.pct}% ${x.MB}MB ${x.fn}`).join('\n  '));
}

let lineLeg = 1;
async function steerOnce() {
  if (route !== 'tour') return steerTo();
  const target = legs[Math.floor(secs() / 50) % legs.length];
  const s = await page.evaluate(() => { const f = window.__game.flight; return { hdg: f.autopilot ? f.autopilot.heading : f.heading, ap: f.autopilot ? f.autopilot.on : true, crashed: f.crashed }; });
  if (!s.ap && !s.crashed) await tap('KeyO');
  const e = ((target - s.hdg + 540) % 360) - 180;
  if (Math.abs(e) > 5) { const k = e > 0 ? 'KeyD' : 'KeyA'; await page.keyboard.down(k); await sleep(Math.min(1500, Math.abs(e) * 30)); await page.keyboard.up(k); }
}
/** line / orbit: the autopilot's selected heading set directly (toward the current end of the line; along the circle
 *  with a correction toward its radius) */
async function steerTo() {
  const s = await page.evaluate(() => { const f = window.__game.flight; return { x: f.position.x, z: f.position.z, ap: f.autopilot ? f.autopilot.on : true, crashed: f.crashed }; });
  if (!s.ap && !s.crashed) await tap('KeyO');
  let hdg;
  if (route === 'line') {
    const [tx, tz] = lineLeg ? [LINE[2], LINE[3]] : [LINE[0], LINE[1]];
    if (Math.hypot(tx - s.x, tz - s.z) < 1500) lineLeg ^= 1;
    hdg = bearing(s.x, s.z, tx, tz);
  } else {
    const [cx, cz, r] = ORBIT, d = Math.hypot(s.x - cx, s.z - cz);
    const out = bearing(cx, cz, s.x, s.z);                                   // centre → aircraft
    hdg = (out + 90 + Math.max(-60, Math.min(60, (d - r) / r * 120)) + 360) % 360;   // clockwise, pulled in / out toward r
  }
  await page.evaluate((h) => { const f = window.__game.flight; if (f.autopilot && f.autopilot.on) f.autopilot.heading = h; }, hdg);
}
async function steerFor(s) { const end = Date.now() + s * 1000; while (Date.now() < end) { await steerOnce(); await sleep(1000); } }

while (secs() < minutes * 60) {
  await steerOnce();
  if (secs() >= nextSample) { await sample(); nextSample += every; }
  if (traceAt != null && secs() >= traceAt && secs() + traceSecs < minutes * 60) { traceAt = null; await traceWindow(); await page.evaluate(() => window.__perf.mark()); }
  if (profAt != null && secs() >= profAt && secs() + profileSecs < minutes * 60) { profAt = null; await profileWindow(); await page.evaluate(() => window.__perf.mark()); }
  if (allocAt != null && secs() >= allocAt && secs() + allocSecs < minutes * 60) { allocAt = null; await allocWindow(); await page.evaluate(() => window.__perf.mark()); }
  await sleep(1000);
}
await sample();
const first = out.series[1] || out.series[0], last = out.series[out.series.length - 1];
out.growth = { heapMB: +(last.heapMB - first.heapMB).toFixed(1), gpuMB: last.gpuMB && first.gpuMB ? +((last.gpuMB.tex + last.gpuMB.buf) - (first.gpuMB.tex + first.gpuMB.buf)).toFixed(1) : null, textures: last.textures - first.textures, geometries: last.geometries - first.geometries, overMinutes: +((last.t - first.t) / 60).toFixed(1) };
out.maxima = { heapMB: Math.max(...out.series.map((r) => r.heapMB || 0)), gpuMB: Math.max(...out.series.map((r) => (r.gpuMB ? r.gpuMB.tex + r.gpuMB.buf : 0))), frameMax: Math.max(...out.series.map((r) => r.max || 0)), over100: out.series.reduce((a, r) => a + (r.over100 || 0), 0), over50: out.series.reduce((a, r) => a + (r.over50 || 0), 0) };
// leak verdict: slope over the second half (caches are full by then; a steady rise there is growth, not warm-up)
const slope = (key) => {
  const tEnd = out.series[out.series.length - 1].t;
  const pts = out.series.filter((r) => r.t >= tEnd / 2 && key(r) != null).map((r) => [r.t / 60, key(r)]);
  if (pts.length < 3) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  return sxx ? +(sxy / sxx).toFixed(2) : null;
};
out.secondHalfSlopePerMin = { heapMB: slope((r) => r.heapMB), meterMB: slope((r) => r.meterMB), glMB: slope((r) => (r.gpuMB ? r.gpuMB.tex + r.gpuMB.buf : null)), textures: slope((r) => r.textures), geometries: slope((r) => r.geometries),
  sceneGeometries: slope((r) => r.census && r.census.geos), sceneTextures: slope((r) => r.census && r.census.texs) };
if (ourPids) {
  Object.assign(out.secondHalfSlopePerMin, { webContentMB: slope((r) => r.fp && r.fp.WebContent), gpuProcessMB: slope((r) => r.fp && r.fp.GPU) });
  // per category (the ten largest at the end): which kind of memory grows
  const lastFp = out.series[out.series.length - 1].fp;
  out.footprintCategorySlopePerMin = Object.fromEntries(Object.entries(lastFp ? lastFp.cats : {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, { endMB: v, slope: slope((r) => (r.fp ? r.fp.cats[k] || 0 : null)) }]));
  const f0 = (out.series[1] || out.series[0]).fp;
  out.growth.footprint = f0 && lastFp ? { webContentMB: lastFp.WebContent - f0.WebContent, gpuProcessMB: lastFp.GPU - f0.GPU, from: [f0.WebContent, f0.GPU], to: [lastFp.WebContent, lastFp.GPU] } : null;
  console.log('footprint categories (end MB, second-half slope / min):', JSON.stringify(out.footprintCategorySlopePerMin));
}
out.maxima.meterMB = Math.max(...out.series.map((r) => r.meterMB || 0));
out.maxima.meterPeakMB = Math.max(...out.series.map((r) => r.meterPeakMB || 0));
out.qualitySteps = [...new Set(out.series.map((r) => r.quality))];
out.verdict = Object.entries(out.secondHalfSlopePerMin).filter(([k, v]) => v != null && ((/MB$/.test(k) && v > 10) || (!/MB$/.test(k) && v > 20))).map(([k, v]) => `${k} +${v}/min`).join(', ') || 'flat (no growth in the second half)';
console.log('second-half slope per minute', JSON.stringify(out.secondHalfSlopePerMin), '->', out.verdict);
// WebKit: dead ArrayBuffers (tile downloads, decoded geometry) stay in the footprint until JavaScriptCore runs a full
// collection, which it may not do for minutes. A forced full GC at the end (the Web Inspector's Heap.gc) tells that
// garbage apart from memory the game still holds. (After the verdict: it changes the heap.)
if (ourPids) {
  const fpNow = () => { const r = { WebContent: 0, ab: 0, malloc: 0 }; for (const [pid, kind] of ourPids) { if (kind !== 'WebContent') continue; const f = footprint(pid); if (!f) continue; r.WebContent += f.MB; r.ab += f.cats['WebAssembly Memory'] || 0; r.malloc += f.cats['WebKit Malloc'] || 0; } return r; };
  const pre = fpNow();
  if (await forceGC()) {
    await sleep(5000);
    const post = fpNow();
    out.forcedGC = { before: pre, after: post };
    console.log(`forced GC: WebContent ${pre.WebContent} → ${post.WebContent} MB (ArrayBuffers ${Math.round(pre.ab)} → ${Math.round(post.ab)}, WebKit malloc ${Math.round(pre.malloc)} → ${Math.round(post.malloc)})`);
  }
  // --heap-snapshot: the JavaScriptCore heap snapshot (Web Inspector Heap.snapshot) for retainer analysis
  if (flag('--heap-snapshot')) {
    try {
      const impl = page._connection.toImpl(page), d = impl.delegate || impl._delegate;
      const { snapshotData } = await d._session.send('Heap.snapshot', {});
      console.log(`heap snapshot: ${save(`${tag}.heapsnapshot.json`, JSON.parse(snapshotData))}`);
    } catch (e) { console.log('heap snapshot failed:', e.message); }
  }
}
out.errors = log.errors.slice(0, 10);
console.log('growth', JSON.stringify(out.growth), 'maxima', JSON.stringify(out.maxima));
save(`${tag}.json`, out);
await browser.close();
console.log(`saved ${OUT}/${tag}.json`);
