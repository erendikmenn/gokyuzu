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
// usage: node tools/perf/soak.mjs [--minutes 10] [--map sf|ist] [--profile <tools/perf/matrix.mjs profile, e.g. phone-cpu4>]
//          [--preset high] [--cpu 1] [--size 1920x1080] [--every 20] [--aircraft f16] [--spawn AIR-CITY] [--tag name] [--webkit]
//          [--alt 700] [--base URL]
import { launch, openGame, attach, save, arg, flag, sleep, OUT, BASE } from './lib.mjs';
import { PROFILES } from './matrix.mjs';

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
  sf: { spawn: 'AIR-CITY', extra: '', legs: [340, 250, 160, 90, 20, 290], alt: 0 },
  // start over the Boğaz; legs over Levent / Sarıyer, the European side (Bağcılar, Başakşehir), the historic peninsula,
  // the Asian side (Kadıköy, Ataşehir) and back: every city / tree / terrain area of the core streams in and out
  ist: { spawn: 'IST-AIR-BOGAZ', extra: '&map=ist', legs: [20, 300, 230, 140, 90, 350], alt: 700 },
}[map];

const { browser, page, cdp, log } = await launch({ engine, width, height, dpr: prof ? prof.dpr : 1, gl: 'mem', heap: true, cpuThrottle: cpu, hasTouch: prof && prof.touch, isMobile: prof && prof.mobile });
const out = { map, profile: arg('--profile', null), preset, cpu, engine, width, height, series: [], windows: {} };
const loadS = await openGame(page, { aircraft: arg('--aircraft', 'f16'), spawn: arg('--spawn', MAP.spawn), quality: preset, pr: prof ? prof.pr : 1, extra: `${prof ? prof.extra : ''}${MAP.extra}&telemetry=0`, base: arg('--base', BASE) });
await attach(page, { gpu: engine === 'chromium', subs: true });
out.loadS = loadS;
console.log(`loaded in ${loadS}s`);
const alt = Number(arg('--alt', MAP.alt || 0));
if (alt) await page.evaluate((alt) => { const g = window.__game, s = g.spawn; g.flight.reset({ x: s.x, z: s.z, heading: s.heading, altitude: alt, speed: g.def.spec.spawnSpeed }, g.world); }, alt);

const tap = async (code) => { await page.keyboard.down(code); await sleep(60); await page.keyboard.up(code); };
// camera chase, autopilot on (heading hold); steer the AP heading with A/D like a player
await page.evaluate(() => window.__game.cameraRig.setMode('chase'));
await tap('Digit7');   // throttle 70 %
await sleep(300);
await tap('KeyO');
const legs = MAP.legs;
const t0 = Date.now();
let nextSample = 0, traceAt = 90, profAt = 200, allocAt = 320;
const secs = () => (Date.now() - t0) / 1000;
await page.evaluate(() => window.__perf.mark());

async function sample() {
  const s = await page.evaluate(() => {
    const P = window.__perf, g = window.__game, w = g.world;
    const sum = P.summary(); P.mark();
    const city = (w.layers || []).find((l) => l.object && l.object.name === 'city');
    const f = g.flight;
    const m = g.gpu && g.gpu.meter && g.gpu.meter.snapshot ? g.gpu.meter.snapshot() : null;
    return { ...sum, meter: m, quality: g.quality && g.quality.id, pos: [Math.round(f.position.x), Math.round(f.position.y), Math.round(f.position.z)], crashed: f.crashed, terrain: { ...(w.terrain.stats || {}) }, city: city && city.stats ? { loaded: city.stats.loaded, visible: city.stats.visible, queued: city.stats.queued, trees: city.stats.trees } : null };
  });
  const row = { t: Math.round(secs()), pos: s.pos, crashed: s.crashed, fps: s.fps, p50: s.frameMs.p50, p95: s.frameMs.p95, p99: s.frameMs.p99, max: s.frameMs.max, over50: s.hitches.over50, over100: s.hitches.over100,
    cpu: s.cpuMs.mean, cpuP95: s.cpuMs.p95, gpu: s.gpuMs && s.gpuMs.mean, sub: s.subMean, subP95: s.subP95, upMBs: s.uploadMBPerSec, up: s.uploadMsPerFrame, compileMs: s.compileMs, links: s.links,
    longTasks: s.longTasks, alloc: s.alloc, heapMB: s.heapMB, gpuMB: s.gpuBytesMB, meterMB: s.meter ? s.meter.gpu : null, meterPeakMB: s.meter ? s.meter.peak : null, quality: s.quality, calls: s.info.calls, tris: s.info.triangles, programs: s.info.programs, textures: s.info.textures, geometries: s.info.geometries,
    terrain: s.terrain, city: s.city };
  out.series.push(row);
  console.log(`t=${row.t}s pos ${row.pos} fps ${row.fps} p95 ${row.p95} p99 ${row.p99} max ${row.max} >50ms ${row.over50} | cpu ${row.cpu} gpu ${row.gpu} | up ${row.upMBs} MB/s compile ${row.compileMs} ms (${row.links}) | alloc ${row.alloc && row.alloc.MBperSec} MB/s gc ${row.alloc && row.alloc.gcDrops} | heap ${row.heapMB} gpu ${row.gpuMB && (row.gpuMB.tex + row.gpuMB.buf).toFixed(0)} MB tex ${row.textures} geo ${row.geometries} | terrain ${row.terrain.loaded}/${row.terrain.textures} city ${row.city && row.city.loaded}`);
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

async function steerOnce() {
  const target = legs[Math.floor(secs() / 50) % legs.length];
  const s = await page.evaluate(() => { const f = window.__game.flight; return { hdg: f.autopilot ? f.autopilot.heading : f.heading, ap: f.autopilot ? f.autopilot.on : true, crashed: f.crashed }; });
  if (!s.ap && !s.crashed) await tap('KeyO');
  const e = ((target - s.hdg + 540) % 360) - 180;
  if (Math.abs(e) > 5) { const k = e > 0 ? 'KeyD' : 'KeyA'; await page.keyboard.down(k); await sleep(Math.min(1500, Math.abs(e) * 30)); await page.keyboard.up(k); }
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
out.secondHalfSlopePerMin = { heapMB: slope((r) => r.heapMB), meterMB: slope((r) => r.meterMB), glMB: slope((r) => (r.gpuMB ? r.gpuMB.tex + r.gpuMB.buf : null)), textures: slope((r) => r.textures), geometries: slope((r) => r.geometries) };
out.maxima.meterMB = Math.max(...out.series.map((r) => r.meterMB || 0));
out.maxima.meterPeakMB = Math.max(...out.series.map((r) => r.meterPeakMB || 0));
out.qualitySteps = [...new Set(out.series.map((r) => r.quality))];
out.verdict = Object.entries(out.secondHalfSlopePerMin).filter(([k, v]) => v != null && ((/MB$/.test(k) && v > 10) || (!/MB$/.test(k) && v > 20))).map(([k, v]) => `${k} +${v}/min`).join(', ') || 'flat (no growth in the second half)';
console.log('second-half slope per minute', JSON.stringify(out.secondHalfSlopePerMin), '->', out.verdict);
out.errors = log.errors.slice(0, 10);
console.log('growth', JSON.stringify(out.growth), 'maxima', JSON.stringify(out.maxima));
save(`${tag}.json`, out);
await browser.close();
console.log(`saved ${OUT}/${tag}.json`);
