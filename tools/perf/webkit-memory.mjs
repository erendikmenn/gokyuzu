#!/usr/bin/env node
// WebKit memory-pressure test (the iPad blank-screen history: docs/errors/audit.md #1, #4, #14). Playwright WebKit with
// the game's own tablet / phone class, per map:
//   1. tour: ground spawn → the map's matrix poses (tools/perf/matrix.mjs MAPS) → cockpit, settling at each; samples the
//      physical footprint (what iOS jetsam counts; macOS `footprint`) of this browser's WebKit WebContent and GPU
//      processes, the game's GPU meter (src/core/gpu-meter.js) and peak, the preset in effect (the budget monitor may step
//      it down) and page errors
//   2. context loss: WEBGL_lose_context on the game's context → the graphics guard must reload one step lower with
//      ?resume=1 into the same flight (src/core/gpu-guard.js); checks the reload, the new preset, the flight and errors,
//      then samples memory again
// Verdicts: meter peak vs the class budget (quality.js gpuBudgetMB), WebContent + GPU footprint vs --limit (default
// 1500 MB: a heuristic for a 4 GB iPad / 6 GB iPhone tab; the owner's iPad Pro stepped down at a 1,387 MB meter reading),
// recovery pass / fail.
//   node tools/perf/webkit-memory.mjs [--classes tablet,phone] [--maps sf,ist] [--limit 1500] [--no-loss] [--tag name] [--base URL]
// --timeline <s>: instead of the tour, sample the footprint continuously (about 3 times a second) from the navigation until
// <s> seconds after the first playable frame, flying the map's matrix route on autopilot after 10 s (the start-up burst:
// deferred world loading, the full aircraft model after a LOD start, the first streaming): peak, when it happens
// relative to the first playable frame, and the steady level of the last 20 s. --aircraft f16 (default) | a320neo …,
// --quality auto (default: the class's preset) | low | medium | high | ultra (a player's own choice on that device),
// --extra '&x=y' (URL switches for A/B, e.g. &prewarm=0)
import { launch, openGame, setPose, settle, sleep, arg, flag, save, BASE } from './lib.mjs';
import { MAPS } from './matrix.mjs';
import { execSync } from 'node:child_process';

const CLASSES = {
  tablet: { width: 1024, height: 768, dpr: 2, extra: '&device=tablet&touch=1', budget: 1400 },
  phone: { width: 844, height: 390, dpr: 3, extra: '&device=phone&touch=1', budget: 900 },
};
const classes = arg('--classes', 'tablet,phone').split(',');
const maps = arg('--maps', 'sf,ist').split(',');
const limit = Number(arg('--limit', 1500));
const base = arg('--base', BASE);
const tag = arg('--tag', 'webkit-memory');

/** WebKit XPC service processes (WebContent / GPU / Networking) of Playwright's WebKit build: pid → kind. */
function webkitPids() {
  const out = new Map();
  for (const l of execSync('ps -axo pid=,command=', { encoding: 'utf8' }).split('\n')) {
    const m = /^\s*(\d+)\s+.*ms-playwright\/webkit-[^/]+\/com\.apple\.WebKit\.(WebContent|GPU|Networking)\.xpc/.exec(l);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}
/** Physical footprint in MB (jetsam's measure) of a pid, null if gone. */
function footprintMB(pid) {
  try {
    const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(execSync(`footprint ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]));
  } catch { return null; }
}

async function sample(page, ours, label) {
  const g = await page.evaluate(() => {
    const g = window.__game; const m = g && g.gpu && g.gpu.meter;
    const s = m && m.snapshot ? m.snapshot() : null;
    return g ? { quality: g.quality && g.quality.id, pr: +g.renderer.getPixelRatio().toFixed(2), meterMB: s && s.gpu, meterPeakMB: s && s.peak, textures: g.renderer.info.memory.textures, geometries: g.renderer.info.memory.geometries, url: location.search } : null;
  }).catch(() => null);
  const fp = {};
  for (const [pid, kind] of webkitPids()) if (ours.has(pid) || !ours.size) { if (kind !== 'Networking') fp[kind] = (fp[kind] || 0) + (footprintMB(pid) || 0); }
  const row = { label, ...g, webContentMB: fp.WebContent || null, gpuProcessMB: fp.GPU || null, totalMB: (fp.WebContent || 0) + (fp.GPU || 0) };
  console.log(`  ${label.padEnd(18)} ${row.quality}/pr ${row.pr} meter ${row.meterMB} (peak ${row.meterPeakMB}) MB | WebContent ${row.webContentMB} MB, GPU process ${row.gpuProcessMB} MB, total ${row.totalMB} MB | tex ${row.textures} geo ${row.geometries}`);
  return row;
}

async function runOne(cls, map) {
  const C = CLASSES[cls], M = MAPS[map];
  const before = webkitPids();
  const { browser, page, log } = await launch({ engine: 'webkit', width: C.width, height: C.height, dpr: C.dpr, gl: 'off', hasTouch: true });
  const res = { cls, map, budget: C.budget, limit, samples: [], loss: null };
  try {
    await openGame(page, { aircraft: 'f16', spawn: M.spawn, quality: 'auto', pr: 0, extra: `${C.extra}${M.extra}&telemetry=0`, base, timeout: 300000 });
    const ours = new Set([...webkitPids().keys()].filter((p) => !before.has(p)));
    res.pids = [...ours];
    res.samples.push(await sample(page, ours, 'start'));
    for (const pose of [...M.poses.filter((p) => p !== M.cockpit), M.cockpit]) {
      await setPose(page, pose);
      await settle(page, { minMs: 4000, maxMs: 25000 });
      await sleep(3000);
      res.samples.push(await sample(page, ours, pose));
    }
    if (!flag('--no-loss')) {
      const t0 = Date.now();
      const nav = page.waitForEvent('framenavigated', { timeout: 60000 }).catch(() => null);
      const lost = await page.evaluate(() => { const ext = window.__game.renderer.getContext().getExtension('WEBGL_lose_context'); if (!ext) return false; ext.loseContext(); return true; });
      const navigated = lost ? await nav : null;
      let resumed = false, info = null;
      if (navigated) {
        try {
          await page.waitForFunction(() => window.__game && window.__game.flight && window.__game.readyAt, null, { timeout: 120000, polling: 250 });
          resumed = true;
          info = await page.evaluate(() => ({ url: location.search, quality: window.__game.quality && window.__game.quality.id, pos: window.__game.flight ? [Math.round(window.__game.flight.position.x), Math.round(window.__game.flight.position.y), Math.round(window.__game.flight.position.z)] : null, halted: !!window.__game.halted }));
        } catch { /* not resumed */ }
      }
      const halted = !navigated ? await page.evaluate(() => ({ halted: !!(window.__game && window.__game.halted), notice: (document.body.innerText || '').slice(0, 200) })).catch(() => null) : null;
      res.loss = { lost, reloaded: !!navigated, resumed, secs: +((Date.now() - t0) / 1000).toFixed(1), info, halted, pass: !!(lost && resumed && info && /resume=1/.test(info.url)) };
      console.log(`  context loss: ${JSON.stringify(res.loss)}`);
      if (resumed) { await sleep(5000); res.samples.push(await sample(page, new Set([...webkitPids().keys()].filter((p) => !before.has(p))), 'after loss')); }
    }
  } catch (e) {
    res.error = String(e && e.stack || e);
    console.log(`  FAILED ${cls} ${map}: ${e.message}`);
  } finally {
    res.errors = log.errors.slice(0, 10);
    await browser.close().catch(() => {});
  }
  const pre = res.samples.filter((s) => s.label !== 'after loss');
  res.peak = { meterMB: Math.max(0, ...pre.map((s) => s.meterPeakMB || 0)), totalMB: Math.max(0, ...pre.map((s) => s.totalMB || 0)), webContentMB: Math.max(0, ...pre.map((s) => s.webContentMB || 0)), gpuProcessMB: Math.max(0, ...pre.map((s) => s.gpuProcessMB || 0)) };
  res.stepDowns = [...new Set(pre.map((s) => s.quality))];
  res.verdict = {
    meterWithinBudget: res.peak.meterMB <= C.budget,
    footprintWithinLimit: res.peak.totalMB <= limit,
    contextLossRecovered: res.loss ? res.loss.pass : null,
    noPageErrors: !res.errors.some((e) => /pageerror|TypeError|ReferenceError/.test(e)),
  };
  console.log(`  peak: meter ${res.peak.meterMB} MB of ${C.budget}, WebContent + GPU ${res.peak.totalMB} MB (limit ${limit}) | presets ${res.stepDowns.join(' → ')} | ${JSON.stringify(res.verdict)}`);
  return res;
}

/** Footprint time series from the navigation to `secs` after the first playable frame (see the header). */
async function timeline(cls, map, secs) {
  const C = CLASSES[cls], M = MAPS[map];
  const before = webkitPids();
  const { browser, page, log } = await launch({ engine: 'webkit', width: C.width, height: C.height, dpr: C.dpr, gl: 'off', hasTouch: true });
  const res = { cls, map, aircraft: arg('--aircraft', 'f16'), quality: arg('--quality', 'auto'), budget: C.budget, series: [], events: {} };
  const t0 = Date.now();
  let stop = false, ready = null;
  const sampler = (async () => {
    while (!stop) {
      const fp = {};
      for (const [pid, kind] of webkitPids()) if (!before.has(pid) && kind !== 'Networking') fp[kind] = (fp[kind] || 0) + (footprintMB(pid) || 0);
      const g = await page.evaluate(() => { const g = window.__game, m = g && g.gpu && g.gpu.meter, s = m && m.snapshot ? m.snapshot() : null; return { meter: s ? s.gpu : null, ready: !!(g && g.readyAt), swap: !!(g && g.swapAt) }; }).catch(() => ({}));
      const t = (Date.now() - t0) / 1000;
      res.series.push({ t: +t.toFixed(2), webContent: fp.WebContent || 0, gpu: fp.GPU || 0, total: (fp.WebContent || 0) + (fp.GPU || 0), meter: g.meter ?? null });
      if (g.ready && res.events.ready == null) res.events.ready = +t.toFixed(2);
      if (g.swap && res.events.swap == null) res.events.swap = +t.toFixed(2);
      await sleep(150);
    }
  })();
  try {
    await openGame(page, { aircraft: res.aircraft, spawn: M.spawn, quality: res.quality, pr: 0, extra: `${C.extra}${M.extra}&telemetry=0${arg('--extra', '')}`, base, timeout: 300000 });
    ready = Date.now();
    await sleep(10000);
    await page.evaluate((f) => {
      const g = window.__game, rad = (d) => d * Math.PI / 180;
      g.flight.reset({ x: f.x, z: f.z, heading: rad(f.hdg), altitude: f.alt, speed: g.def.spec.spawnSpeed }, g.world);
      g.paused = false; g.cameraRig.setMode('chase');
    }, M.fly);
    const tap = async (code) => { await page.keyboard.down(code); await sleep(60); await page.keyboard.up(code); };
    await tap('Digit7'); await sleep(200); await tap('KeyO');
    res.events.fly = +((Date.now() - t0) / 1000).toFixed(2);
    const left = secs * 1000 - (Date.now() - ready); if (left > 0) await sleep(left);
  } catch (e) {
    res.error = String(e && e.stack || e);
    console.log(`  FAILED ${cls} ${map}: ${e.message}`);
  } finally {
    stop = true; await sampler;
    res.errors = log.errors.slice(0, 10);
    await browser.close().catch(() => {});
  }
  const S = res.series, r = res.events.ready ?? 0;
  const peak = S.reduce((a, x) => (x.total > a.total ? x : a), { total: 0 });
  const tail = S.filter((x) => x.t >= S[S.length - 1].t - 20);
  res.peak = { totalMB: peak.total, atS: peak.t, relReadyS: +(peak.t - r).toFixed(1), webContentMB: peak.webContent, gpuMB: peak.gpu, meterMB: peak.meter };
  res.steady = { totalMB: Math.round(tail.reduce((a, x) => a + x.total, 0) / Math.max(1, tail.length)), meterMB: Math.round(tail.reduce((a, x) => a + (x.meter || 0), 0) / Math.max(1, tail.length)) };
  const at = (t) => { const x = S.find((y) => y.t >= t); return x ? x.total : null; };
  res.atReady = { '0s': at(r), '+2s': at(r + 2), '+5s': at(r + 5), '+10s': at(r + 10), '+30s': at(r + 30) };
  console.log(`  ${cls} ${map} ${res.aircraft} ${res.quality}: ready at ${r}s, peak ${res.peak.totalMB} MB (WebContent ${res.peak.webContentMB}, GPU ${res.peak.gpuMB}, meter ${res.peak.meterMB}) at ${res.peak.relReadyS >= 0 ? '+' : ''}${res.peak.relReadyS}s from ready | at ready ${JSON.stringify(res.atReady)} | steady ${res.steady.totalMB} MB (meter ${res.steady.meterMB}) | errors ${res.errors.length}`);
  return res;
}

const out = { date: new Date().toISOString(), base, limit, runs: [] };
const tl = Number(arg('--timeline', 0));
for (const cls of classes) for (const map of maps) {
  console.log(`== WebKit ${cls} ${map}${tl ? ` (timeline ${tl} s)` : ''}`);
  out.runs.push(tl ? await timeline(cls, map, tl) : await runOne(cls, map));
  save(`${tag}.json`, out);
}
if (tl) process.exit(out.runs.some((r) => r.error) ? 1 : 0);
const fails = out.runs.filter((r) => r.error || Object.values(r.verdict).some((v) => v === false));
console.log(fails.length ? `FAIL: ${fails.map((r) => `${r.cls}/${r.map}`).join(', ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
