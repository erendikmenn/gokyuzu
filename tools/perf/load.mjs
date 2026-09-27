#!/usr/bin/env node
// Load benchmark: cold and warm cache, with and without network throttling, through the real menu.
//   time to menu (menu + aircraft thumbnails shown), click "Uç" → first playable frame (__game.readyAt), the first-frame
//   hitch (worst frames / shader-compile stalls in the first seconds, from tools/perf/probe.js), requests and bytes by
//   type and phase (menu / load / after start), the JavaScript module waterfall, and a Chrome trace summary per thread
//   (script compile/evaluate, GC, worker time = Draco / image / Basis decode, image decode tasks).
// Serve a publish build with tools/perf/serve-prod.mjs (HTTP/2, Brotli, deploy.sh cache headers) for realistic numbers.
//
// usage: node tools/perf/load.mjs [--base https://localhost:5443/] [--nets none,4g,slow3g] [--runs cold,warm]
//          [--size 1920x1080] [--after 8000] [--timeout 900000] [--trace] [--tag name] [--direct f16:KSFO-28R]
//          [--engine chromium|firefox|webkit] [--shaper cdp|server] [--extra '&device=integrated'] [--cpu 2]
//          [--quality high|auto] [--dpr 1] [--touch] [--repeat n]
// --engine firefox / webkit: Playwright's builds (Firefox has no KHR_parallel_shader_compile and no WEBGL_multi_draw, like
//   Firefox on Windows); their network is shaped by serve-prod.mjs itself (--shaper server, the default there: GET
//   /__shape before each run), since CDP's emulation exists in Chromium only. Bytes then come from the server's counters.
// Runs: cold (empty profile), warm (same profile again), expired (same profile after the server's --expire copies ran out).
// Per run also: the shader programs linked after the first playable frame (three.js program names = material names),
// the game's pre-warm breakdown (state.prewarmInfo) and long tasks before / after the first playable frame.
import { chromium, firefox, webkit } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GPU_ARGS, NETWORKS, arg, flag, save, OUT, sleep } from './lib.mjs';

const base = arg('--base', 'https://localhost:5443/');
const nets = arg('--nets', 'none,4g').split(',');
const runs = arg('--runs', 'cold,warm').split(',');
const [width, height] = arg('--size', '1920x1080').split('x').map(Number);
const after = Number(arg('--after', 8000));
const timeout = Number(arg('--timeout', 900000));
const tag = arg('--tag', 'load');
const doTrace = flag('--trace');
const direct = arg('--direct', '');   // aircraft:spawn → skip the menu (index.html?aircraft=&spawn=)
const engine = arg('--engine', 'chromium');
const shaper = arg('--shaper', engine === 'chromium' ? 'cdp' : 'server');
const extra = arg('--extra', '');             // more URL switches (e.g. &device=integrated)
const cpu = Number(arg('--cpu', 1));          // CDP CPU throttling (Chromium)
const quality = arg('--quality', 'high');     // stored preset ('auto': none, the game's own default for the device)
const dpr = Number(arg('--dpr', 1));
const touch = flag('--touch');
const repeat = Number(arg('--repeat', 1));    // the whole run list again in a fresh profile (noise)
const settle = !flag('--no-settle');          // keep the page open until its downloads are done (see flow())
const settleMax = Number(arg('--settle-max', 240000));
const PROBE = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
if (/^https:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // serve-prod's self-signed key (its /__shape, /__stats)
// Chrome keeps no HTTP cache for origins with certificate errors, so --ignore-certificate-errors would make every "warm"
// run cold: trust serve-prod's self-signed key by its SPKI hash instead (as WebPageReplay does).
const certDir = arg('--certs', path.join(os.tmpdir(), 'gokyuzu-perf', 'certs'));   // same default as serve-prod.mjs
const spki = fs.existsSync(`${certDir}/cert.pem`) ? execSync(`openssl x509 -in ${certDir}/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`, { encoding: 'utf8' }).trim() : null;

function classify(url, type) {
  const u = url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0];
  if (/\.m?js$/.test(u)) return u.startsWith('node_modules/three/build') ? 'js-three' : u.startsWith('node_modules/') ? (/draco|basis/.test(u) ? 'js-decoder' : 'js-addons') : 'js-game';
  if (/\.wasm$/.test(u)) return 'wasm';
  if (u === '' || u.endsWith('.html')) return 'html';
  if (u.startsWith('assets/aircraft/')) return /_cockpit\.glb$/.test(u) ? 'aircraft-cockpit' : 'aircraft';
  if (u.startsWith('assets/sf/terrain/img/')) return 'terrain-img';
  if (u.startsWith('assets/sf/terrain/h/')) return 'terrain-h';
  if (u.startsWith('assets/sf/terrain/')) return 'terrain-other';
  if (u.startsWith('assets/sf/city/trees/')) return 'trees';
  if (u.startsWith('assets/sf/city/obst/')) return 'city-obst';
  if (u.startsWith('assets/sf/city/')) return /\.glb$/.test(u) ? 'city-tiles' : 'city-other';
  if (u.startsWith('assets/sf/landmarks/')) return 'landmarks';
  if (u.startsWith('assets/sf/airports/')) return 'airports';
  if (u.startsWith('assets/sf/')) return 'sf-other';
  if (u.startsWith('assets/audio/')) return 'audio';
  if (u.startsWith('renders/')) return 'thumbs';
  if (/\.json$/.test(u)) return 'json';
  return type || 'other';
}

async function readTrace(cdp) {
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let data = '';
  for (;;) { const c = await cdp.send('IO.read', { handle: stream, size: 1 << 22 }); data += c.base64Encoded ? Buffer.from(c.data, 'base64').toString() : c.data; if (c.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  const j = JSON.parse(data);
  return Array.isArray(j) ? j : j.traceEvents;
}

function summarizeTrace(ev, t0us) {
  const threads = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const per = {};
  const main = [...threads.entries()].filter(([, n]) => n === 'CrRendererMain').map(([k]) => k);
  const byThread = new Map();
  for (const e of ev) {
    if (e.ph !== 'X' || !e.dur) continue;
    const k = `${e.pid}:${e.tid}`;
    (byThread.get(k) || byThread.set(k, []).get(k)).push(e);
  }
  for (const [k, list] of byThread) {
    const tname = threads.get(k) || k;
    if (!/CrRendererMain|DedicatedWorker|ThreadPool|Compositor|Media|AudioOutputDevice|CrGpuMain|VizCompositor/.test(tname)) continue;
    // exclusive-ish: count only top-level events (not nested in another event of the same thread)
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    let end = -1; const names = {}; let busy = 0;
    const names2 = {};
    for (const e of list) {
      if (e.ts >= end) { busy += e.dur; end = e.ts + e.dur; }
      if (/compile|Compile|Evaluate|evaluate|GC|Decode|decode|Parse|parse|FunctionCall|RunMicrotasks|Layout|UpdateLayoutTree|Paint|TimerFire|FireAnimationFrame|XHRLoad|ResourceReceivedData/.test(e.name)) names2[e.name] = (names2[e.name] || 0) + e.dur;
    }
    const key = main.includes(k) ? 'main' : tname.replace(/\d+$/, '');
    const p = per[key] || (per[key] = { threads: 0, busyMs: 0, events: {} });
    p.threads++; p.busyMs += busy / 1000;
    for (const [n, d] of Object.entries(names2)) p.events[n] = (p.events[n] || 0) + d / 1000;
    void names;
  }
  for (const p of Object.values(per)) {
    p.busyMs = Math.round(p.busyMs);
    p.events = Object.fromEntries(Object.entries(p.events).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([n, d]) => [n, Math.round(d)]));
  }
  void t0us;
  return per;
}

const serverStats = async () => { try { return await (await fetch(new URL('__stats', base))).json(); } catch { return null; } };
async function setShape(net) {
  const n = NETWORKS[net];
  const r = await fetch(new URL(`__shape?down=${n ? n.down : 0}&lat=${n ? n.latency : 0}`, base));
  if (!r.ok) throw new Error(`--shaper server: ${base} is not serve-prod.mjs (GET /__shape → ${r.status})`);
}

async function flow(context, net, label) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/GL Driver Message|GPU stall/.test(m.text())) errors.push(m.text().slice(0, 300)); });
  await page.addInitScript(({ probe, quality }) => {
    window.__PERF_CFG = { gl: 'light', clock: 'real' };
    try { localStorage.setItem('gokyuzu.settings', JSON.stringify(quality === 'auto' ? { tutorial: false } : { tutorial: false, quality })); } catch {}
    (0, eval)(probe);
    // loading-screen stages (src/ui/loading.js .gkl-step / .gkl-pct) with their times: where a slow start spends its time
    window.__perfSteps = [];
    let lastStep = '';
    const poll = setInterval(() => {
      const st = document.querySelector('.gkl-step'), pc = document.querySelector('.gkl-pct');
      const k = st ? `${st.textContent}|${pc ? pc.textContent : ''}` : '';
      if (k && k !== lastStep) { lastStep = k; window.__perfSteps.push([Math.round(performance.now()), k]); }
      if (window.__game && window.__game.readyAt) clearInterval(poll);
    }, 25);
  }, { probe: PROBE, quality });
  const reqs = new Map();
  let wallBase = null, cdp = null;
  if (engine === 'chromium') {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    if (shaper === 'cdp' && NETWORKS[net]) { const n = NETWORKS[net]; await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: n.latency, downloadThroughput: n.down * 125, uploadThroughput: (n.up || n.down) * 125 }); }
    cdp.on('Network.requestWillBeSent', (e) => { if (wallBase == null) wallBase = e.timestamp; reqs.set(e.requestId, { url: e.request.url, type: e.type, start: e.timestamp, method: e.request.method, range: !!(e.request.headers && (e.request.headers.Range || e.request.headers.range)) }); });
    cdp.on('Network.responseReceived', (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.resp = e.timestamp; r.cache = r.memCache ? 'memory' : e.response.fromDiskCache ? 'disk' : e.response.fromServiceWorker ? 'sw' : e.response.fromPrefetchCache ? 'prefetch' : e.response.status === 304 ? '304' : ''; r.proto = e.response.protocol; r.mime = e.response.mimeType; } });
    cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.memCache = true; });
    cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
    cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.failed = e.errorText; } });
  } else {
    // Firefox / WebKit: Playwright's request events (seconds since the navigation); bytes from the server's counters
    let id = 0;
    const t00 = Date.now() / 1000;
    page.on('request', (q) => { const r = { url: q.url(), type: q.resourceType(), start: Date.now() / 1000, method: q.method(), range: !!q.headers().range }; if (wallBase == null) wallBase = t00; q.__id = ++id; reqs.set(q.__id, r); });
    page.on('requestfinished', async (q) => { const r = reqs.get(q.__id); if (!r) return; r.end = Date.now() / 1000; try { const resp = await q.response(); r.status = resp && resp.status(); r.cache = r.status === 304 ? '304' : ''; const sz = await q.sizes(); r.bytes = sz.responseBodySize + sz.responseHeadersSize; } catch { /* page closed */ } });
    page.on('requestfailed', (q) => { const r = reqs.get(q.__id); if (r) { r.end = Date.now() / 1000; r.failed = q.failure() && q.failure().errorText; } });
  }
  if (shaper === 'server') await setShape(net);
  const s0 = await serverStats();
  const tracing = cdp && doTrace && label.endsWith('/cold');   // one trace per network profile (large traces crash warm runs)
  if (tracing) await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'loading', 'disabled-by-default-v8.compile'] } });
  const marks = {};
  const t0 = Date.now();
  const q = direct ? `index.html?aircraft=${direct.split(':')[0]}&spawn=${direct.split(':')[1]}${quality === 'auto' ? '' : `&quality=${quality}`}${extra}` : `index.html${extra ? '?' + extra.replace(/^&/, '') : ''}`;
  await page.goto(base + q, { waitUntil: 'commit', timeout });
  const pnow = () => page.evaluate(() => performance.now());
  let clickAt = null, sClick = null;
  if (!direct) {
    await page.waitForSelector('.gkm-fly', { timeout, state: 'visible' });
    marks.menuDom = await pnow();
    await page.waitForFunction(() => { const im = [...document.querySelectorAll('.gkm-card-img img')]; return im.length >= 5 && im.every((i) => i.complete && i.naturalWidth > 0); }, null, { timeout, polling: 100 }).catch(() => {});
    marks.menu = await pnow();
    marks.menuImgs = await page.evaluate(() => document.querySelectorAll('.gkm-card-img img').length);
    await sleep(300);
    sClick = await serverStats();
    clickAt = await pnow();
    await page.evaluate((t) => { window.__perfClickAt = t; }, clickAt);
    await page.click('.gkm-fly');
    marks.click = clickAt;
  }
  await page.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout, polling: 100 });
  marks.ready = await page.evaluate(() => window.__game.readyAt);
  const sReady = await serverStats();
  marks.loadWallS = (Date.now() - t0) / 1000;
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, ttfb: n.responseStart } : null; });
  // programs at the first playable frame (three.js names them after the material; the cache key's head tells the kind)
  const progKey = () => window.__game.renderer.info.programs.map((p) => `${p.name || '?'}|${p.cacheKey.length > 40 ? p.cacheKey.slice(0, 24) + '…' + p.cacheKey.length : p.cacheKey}`);
  const progAtReady = await page.evaluate(progKey);
  await sleep(after);
  const progAfter = await page.evaluate(progKey);
  // settle: the page stays open until the post-start downloads are done (full aircraft model, cockpit, sounds, …) —
  // otherwise the next "warm" run would find them missing from the cache (a player flies for minutes, not seconds)
  if (settle) {
    const t1 = Date.now();
    let last = -1, quietSince = Date.now();
    while (Date.now() - t1 < settleMax) {
      const st = await serverStats();
      const swapped = await page.evaluate(() => !window.__game.standIn && !window.__game.upgrade);
      if (!st) break;
      if (st.bytes !== last) { last = st.bytes; quietSince = Date.now(); }
      if (swapped && Date.now() - quietSince > 3000) break;
      await sleep(500);
    }
    marks.settledS = Math.round((Date.now() - t1) / 100) / 10;
  }
  const readySet = new Set(progAtReady);
  const newPrograms = progAfter.filter((k) => !readySet.has(k));
  const warm = await page.evaluate(() => ({ steps: window.__perfSteps, early: window.__game.earlyCompile || null, prewarm: window.__game.prewarmInfo || null, swap: window.__game.swapInfo ? Object.fromEntries(Object.entries(window.__game.swapInfo).map(([k, v]) => [k, Math.round(v - window.__game.readyAt)])) : null }));
  const sEnd = await serverStats();
  const hitch = await page.evaluate((readyAt) => {
    const f = window.__perf.frames.filter((x) => x.t >= readyAt);
    const first5 = f.filter((x) => x.t - readyAt < 5000);
    const w = [...first5].sort((a, b) => b.dt - a.dt).slice(0, 5).map((x) => ({ at: Math.round(x.t - readyAt), dt: Math.round(x.dt), cpu: Math.round(x.cpu), compileMs: Math.round(x.compileMs), links: x.linkCount, upMB: +(x.upBytes / 1048576).toFixed(1) }));
    const firstFrame = f[0] ? { dt: Math.round(f[0].dt), cpu: Math.round(f[0].cpu), compileMs: Math.round(f[0].compileMs), links: f[0].linkCount } : null;
    const pre = window.__perf.frames.filter((x) => x.t < readyAt);
    return {
      firstFrame, worstFirst5s: w, over50First5s: first5.filter((x) => x.dt > 50).length, over100First5s: first5.filter((x) => x.dt > 100).length,
      compileMsFirst5s: Math.round(first5.reduce((a, x) => a + x.compileMs, 0)), linksFirst5s: first5.reduce((a, x) => a + x.linkCount, 0),
      compileMsBeforeReady: Math.round(pre.reduce((a, x) => a + x.compileMs, 0)), linksBeforeReady: pre.reduce((a, x) => a + x.linkCount, 0),
      // main-thread time spent in the render loop while the loading screen is up (the loop renders from the start)
      rafCpuDuringLoadMs: Math.round(pre.filter((x) => x.t >= (window.__perfClickAt || 0)).reduce((a, x) => a + x.cpu, 0)), framesDuringLoad: pre.filter((x) => x.t >= (window.__perfClickAt || 0)).length,
      programs: window.__game.renderer.info.programs.length,
      longTasks: window.__perf.longTasks.map((l) => ({ at: Math.round(l.t - readyAt), ms: Math.round(l.ms) })).filter((l) => l.ms > 100).slice(-40),
      // long tasks (≥ 50 ms) after the click, split at the first playable frame (Chromium only: Firefox / WebKit have no
      // longtask entries; their frames > 50 ms above stand in)
      longBefore: (() => { const l = window.__perf.longTasks.filter((x) => x.t >= (window.__perfClickAt || 0) && x.t < readyAt); return { n: l.length, ms: Math.round(l.reduce((a, x) => a + x.ms, 0)), max: Math.round(Math.max(0, ...l.map((x) => x.ms))) }; })(),
      longAfter: (() => { const l = window.__perf.longTasks.filter((x) => x.t >= readyAt); return { n: l.length, ms: Math.round(l.reduce((a, x) => a + x.ms, 0)), max: Math.round(Math.max(0, ...l.map((x) => x.ms))) }; })(),
      framesOver50After: f.filter((x) => x.dt > 50).length, worstAfter: Math.round(Math.max(0, ...f.map((x) => x.dt))),
      // main-thread time in WebGL uploads (probe.js, ms by kind: textures from images / bitmaps / arrays, buffers, mips)
      // after the click until the first playable frame, and in the first 5 s after it
      uploadsBeforeReady: (() => { const o = {}; for (const x of pre.filter((y) => y.t >= (window.__perfClickAt || 0))) for (const [k, v] of Object.entries(x.up || {})) o[k] = Math.round((o[k] || 0) + v); return o; })(),
      uploadsFirst5s: (() => { const o = {}; for (const x of first5) for (const [k, v] of Object.entries(x.up || {})) o[k] = Math.round((o[k] || 0) + v); return o; })(),
      linksAfter: f.reduce((a, x) => a + x.linkCount, 0), compileMsAfter: Math.round(f.reduce((a, x) => a + x.compileMs, 0)),
      // the programs linked after the first playable frame (probe.js: material type / name / variant flags), with the
      // seconds after it: in Chromium they link off the main thread (KHR_parallel_shader_compile) but the first draw
      // still waits for them; Firefox links synchronously
      linkedBefore: (() => { const o = {}; for (const l of (window.__perf.links || []).filter((x) => x.t < readyAt)) { const k = `${l.type}${l.name ? ' "' + l.name + '"' : ''}${l.flags ? ' [' + l.flags + ']' : ''}`; o[k] = (o[k] || 0) + 1; } return o; })(),
      linkedAfter: (window.__perf.links || []).filter((l) => l.t >= readyAt).map((l) => `${((l.t - readyAt) / 1000).toFixed(1)}s ${l.type}${l.name ? ' "' + l.name + '"' : ''}${l.flags ? ' [' + l.flags + ']' : ''}`),
    };
  }, marks.ready);
  Object.assign(hitch, { newPrograms, prewarm: warm.prewarm, early: warm.early, swap: warm.swap, steps: warm.steps });
  const trace = tracing ? summarizeTrace(await readTrace(cdp)) : null;
  const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  await page.close();
  // requests by phase / type (CDP timestamps are seconds on the network clock; phases via the navigation-relative ms)
  const navStart = wallBase;
  const list = [...reqs.values()].filter((r) => !/^(data|blob):/.test(r.url));
  const phaseOf = (r) => { const ms = (r.start - navStart) * 1000; return clickAt != null && ms < clickAt ? 'menu' : ms <= marks.ready ? 'load' : 'after'; };
  const agg = {};
  for (const r of list) {
    const k = classify(r.url, r.type), ph = phaseOf(r);
    const a = agg[k] || (agg[k] = { req: 0, KB: 0, cached: 0, menu: 0, load: 0, after: 0, KBload: 0 });
    a.req++; a.KB += (r.bytes || 0) / 1024; a[ph]++; if (r.cache) a.cached++; if (ph !== 'after') a.KBload += (r.bytes || 0) / 1024;
  }
  for (const a of Object.values(agg)) { a.KB = Math.round(a.KB); a.KBload = Math.round(a.KBload); }
  const js = list.filter((r) => /\.m?js(\?|$)/.test(r.url) && phaseOf(r) === 'menu').sort((a, b) => a.start - b.start);
  const jsWaterfall = js.length ? {
    modules: js.length, KB: Math.round(js.reduce((a, r) => a + (r.bytes || 0), 0) / 1024),
    firstStartMs: Math.round((js[0].start - navStart) * 1000), lastEndMs: Math.round((Math.max(...js.map((r) => r.end || r.start)) - navStart) * 1000),
    rows: js.map((r) => ({ u: r.url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0], s: Math.round((r.start - navStart) * 1000), e: Math.round(((r.end || r.start) - navStart) * 1000), KB: Math.round((r.bytes || 0) / 1024), c: r.cache || '' })),
  } : null;
  const topFiles = list.filter((r) => phaseOf(r) !== 'after' && r.bytes).sort((a, b) => b.bytes - a.bytes).slice(0, 30)
    .map((r) => ({ u: r.url.replace(/^https?:\/\/[^/]+\//, '').split('?')[0], KB: Math.round(r.bytes / 1024), phase: phaseOf(r), startMs: Math.round((r.start - navStart) * 1000), endMs: Math.round(((r.end || r.start) - navStart) * 1000) }));
  const totals = { requests: list.length, MB: +(list.reduce((a, r) => a + (r.bytes || 0), 0) / 1048576).toFixed(1), MBuntilReady: +(list.filter((r) => phaseOf(r) !== 'after').reduce((a, r) => a + (r.bytes || 0), 0) / 1048576).toFixed(1), rangeRequests: list.filter((r) => r.range).length, failed: list.filter((r) => r.failed && !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(r.failed)).length, protocols: [...new Set(list.map((r) => r.proto).filter(Boolean))],
    requestsUntilReady: list.filter((r) => phaseOf(r) !== 'after').length, revalidatedUntilReady: list.filter((r) => phaseOf(r) !== 'after' && r.cache === '304').length };
  // the server's own counters (payload bytes it sent, requests it answered): the same for every engine
  const sd = (a, b) => (a && b ? { req: b.requests - a.requests, r304: b.r304 - a.r304, MB: +((b.bytes - a.bytes) / 1048576).toFixed(2) } : null);
  const server = { menu: sd(s0, sClick), load: sd(sClick || s0, sReady), untilReady: sd(s0, sReady), after: sd(sReady, sEnd) };
  // every request until the first playable frame, in start order (the critical path; --dump)
  const reqList = flag('--dump') ? list.filter((r) => phaseOf(r) !== 'after').sort((a, b) => a.start - b.start).map((r) => ({ u: r.url.replace(/^https?:\/\/[^/]+\//, ''), s: Math.round((r.start - navStart) * 1000), e: Math.round(((r.end || r.start) - navStart) * 1000), KB: Math.round((r.bytes || 0) / 1024), c: r.cache || '', st: r.status })) : undefined;
  const res = { reqList, label, net, engine, marks: { ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])), nav }, timeToMenuS: marks.menu ? +(marks.menu / 1000).toFixed(2) : null, clickToPlayableS: +((marks.ready - (clickAt || 0)) / 1000).toFixed(2), totals, server, byType: agg, topFiles, hitch, heapMB: heap, trace, jsWaterfall, errors: errors.slice(0, 20) };
  const pw = hitch.prewarm || {};
  console.log(`${label.padEnd(14)} menu ${res.timeToMenuS}s  click→playable ${res.clickToPlayableS}s  | ${server.untilReady ? `${server.untilReady.req} req to the server (${server.untilReady.r304} × 304) ${server.untilReady.MB}` : `${totals.requestsUntilReady} req ${totals.MBuntilReady}`} MB until ready | prewarm ${pw.totalMs ?? '-'} ms (compile ${pw.compileMs ?? '-'}, programs ${pw.programs0 ?? '-'}→${pw.programs1 ?? '-'}→${pw.programs2 ?? '-'}) | after ready: ${hitch.newPrograms.length} new programs, ${hitch.linksAfter} links ${hitch.compileMsAfter} ms, worst ${hitch.worstAfter} ms, >50 ms ${hitch.framesOver50After}, long ${hitch.longAfter.n}/${hitch.longAfter.ms} ms (before ready ${hitch.longBefore.n}/${hitch.longBefore.ms} ms) | errors ${errors.length}`);
  return res;
}

const results = [];
// a persistent profile (disk cache like a real browser): Playwright's default contexts are off-the-record with a small
// in-memory HTTP cache that the 75+ MB of a flight evicts, which would make every "warm" run cold
fs.mkdirSync(OUT, { recursive: true });
for (let rep = 0; rep < repeat; rep++) for (const net of nets) {
  const dir = fs.mkdtempSync(`${OUT}/profile-`);
  const ctxOpts = { viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: touch, ignoreHTTPSErrors: engine !== 'chromium' };
  const context = engine === 'firefox' ? await firefox.launchPersistentContext(dir, { ...ctxOpts, firefoxUserPrefs: { 'webgl.force-enabled': true } })
    : engine === 'webkit' ? await webkit.launchPersistentContext(dir, ctxOpts)
    : await chromium.launchPersistentContext(dir, { ...ctxOpts, args: [...GPU_ARGS, spki ? `--ignore-certificate-errors-spki-list=${spki}` : '--ignore-certificate-errors'] });
  try {
    for (const run of runs) {
      if (run === 'expired') await sleep(2500);   // serve-prod --expire: every 1 s copy is stale now
      results.push(await flow(context, net, `${net}/${run}${repeat > 1 ? `#${rep + 1}` : ''}`));
    }
  } catch (e) { console.error(`FAILED ${net}:`, e.message); results.push({ net, error: e.message }); }
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
  save(`load-${tag}.json`, results);
}
if (shaper === 'server') await setShape('none');
console.log(`saved ${OUT}/load-${tag}.json`);
