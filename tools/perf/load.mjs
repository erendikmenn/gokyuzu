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
import { chromium } from 'playwright';
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
const PROBE = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
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

async function flow(context, net, label) {
  const page = await context.newPage();
  await page.addInitScript(({ probe }) => { window.__PERF_CFG = { gl: 'light', clock: 'real' }; try { localStorage.setItem('gokyuzu.settings', JSON.stringify({ tutorial: false, quality: 'high' })); } catch {} (0, eval)(probe); }, { probe: PROBE });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (NETWORKS[net]) { const n = NETWORKS[net]; await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: n.latency, downloadThroughput: n.down * 125, uploadThroughput: (n.up || n.down) * 125 }); }
  const reqs = new Map();
  let wallBase = null;
  cdp.on('Network.requestWillBeSent', (e) => { if (wallBase == null) wallBase = e.timestamp; reqs.set(e.requestId, { url: e.request.url, type: e.type, start: e.timestamp, method: e.request.method, range: !!(e.request.headers && (e.request.headers.Range || e.request.headers.range)) }); });
  cdp.on('Network.responseReceived', (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.resp = e.timestamp; r.cache = r.memCache ? 'memory' : e.response.fromDiskCache ? 'disk' : e.response.fromServiceWorker ? 'sw' : e.response.fromPrefetchCache ? 'prefetch' : e.response.status === 304 ? '304' : ''; r.proto = e.response.protocol; r.mime = e.response.mimeType; } });
  cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.memCache = true; });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.failed = e.errorText; } });
  const tracing = doTrace && label.endsWith('/cold');   // one trace per network profile (large traces crash warm runs)
  if (tracing) await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'v8.execute', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'loading', 'disabled-by-default-v8.compile'] } });
  const marks = {};
  const t0 = Date.now();
  const q = direct ? `index.html?aircraft=${direct.split(':')[0]}&spawn=${direct.split(':')[1]}&quality=high` : 'index.html';
  await page.goto(base + q, { waitUntil: 'commit', timeout });
  const pnow = () => page.evaluate(() => performance.now());
  let clickAt = null;
  if (!direct) {
    await page.waitForSelector('.gkm-fly', { timeout, state: 'visible' });
    marks.menuDom = await pnow();
    await page.waitForFunction(() => { const im = [...document.querySelectorAll('.gkm-card-img img')]; return im.length >= 5 && im.every((i) => i.complete && i.naturalWidth > 0); }, null, { timeout, polling: 100 }).catch(() => {});
    marks.menu = await pnow();
    marks.menuImgs = await page.evaluate(() => document.querySelectorAll('.gkm-card-img img').length);
    await sleep(300);
    clickAt = await pnow();
    await page.evaluate((t) => { window.__perfClickAt = t; }, clickAt);
    await page.click('.gkm-fly');
    marks.click = clickAt;
  }
  await page.waitForFunction(() => window.__game && window.__game.readyAt, null, { timeout, polling: 100 });
  marks.ready = await page.evaluate(() => window.__game.readyAt);
  marks.loadWallS = (Date.now() - t0) / 1000;
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, ttfb: n.responseStart } : null; });
  await sleep(after);
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
    };
  }, marks.ready);
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
  const totals = { requests: list.length, MB: +(list.reduce((a, r) => a + (r.bytes || 0), 0) / 1048576).toFixed(1), MBuntilReady: +(list.filter((r) => phaseOf(r) !== 'after').reduce((a, r) => a + (r.bytes || 0), 0) / 1048576).toFixed(1), rangeRequests: list.filter((r) => r.range).length, failed: list.filter((r) => r.failed && !/ERR_ABORTED/.test(r.failed)).length, protocols: [...new Set(list.map((r) => r.proto).filter(Boolean))] };
  const res = { label, net, marks: { ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])), nav }, timeToMenuS: marks.menu ? +(marks.menu / 1000).toFixed(2) : null, clickToPlayableS: +((marks.ready - (clickAt || 0)) / 1000).toFixed(2), totals, byType: agg, topFiles, hitch, heapMB: heap, trace, jsWaterfall };
  console.log(`${label.padEnd(14)} menu ${res.timeToMenuS}s  click→playable ${res.clickToPlayableS}s  | ${totals.requests} req ${totals.MB} MB (until ready ${totals.MBuntilReady} MB) | first frame ${JSON.stringify(hitch.firstFrame)} worst5s ${hitch.worstFirst5s[0] ? hitch.worstFirst5s[0].dt : '-'} ms, compile ${hitch.compileMsBeforeReady}+${hitch.compileMsFirst5s} ms (${hitch.linksBeforeReady}+${hitch.linksFirst5s} links) | JS ${jsWaterfall ? `${jsWaterfall.modules} mods ${jsWaterfall.KB} KB ${jsWaterfall.firstStartMs}-${jsWaterfall.lastEndMs} ms` : '-'}`);
  return res;
}

const results = [];
// a persistent profile (disk cache like a real browser): Playwright's default contexts are off-the-record with a small
// in-memory HTTP cache that the 75+ MB of a flight evicts, which would make every "warm" run cold
for (const net of nets) {
  const dir = fs.mkdtempSync(`${OUT}/profile-`);
  const context = await chromium.launchPersistentContext(dir, { args: [...GPU_ARGS, spki ? `--ignore-certificate-errors-spki-list=${spki}` : '--ignore-certificate-errors'], viewport: { width, height } });
  try {
    for (const run of runs) results.push(await flow(context, net, `${net}/${run}`));
  } catch (e) { console.error(`FAILED ${net}:`, e.message); results.push({ net, error: e.message }); }
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
  save(`load-${tag}.json`, results);
}
console.log(`saved ${OUT}/load-${tag}.json`);
