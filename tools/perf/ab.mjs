#!/usr/bin/env node
// A/B(/C…) experiment runner, robust to a shared GPU: every variant is loaded in its own page of one browser, all
// pages are parked (tools/perf/probe.js hold: the game loop stops) and each variant runs alone for short interleaved
// windows (A B C A B C …). Other processes' GPU load then hits every variant alike; results are medians over rounds
// plus the per-round ratio to the first variant. GPU busy from other processes (ioreg "Device Utilization %", sampled
// while every page is parked) is recorded as a contention indicator.
// A variant is name=<page>|<url extras>|<runtime patches joined by +>; pages/extras select e.g. the three.js shim
// experiments (tools/perf/exp/three-shim.js via perf-exp.html in a scratch worktree, see tools/perf/exp/setup.mjs);
// patches are PATCHES in tools/perf/patches.mjs (applied in the running page; research only, nothing is written to game code).
//
// usage: node tools/perf/ab.mjs --variants "base=index.html||,nolog=perf-exp.html|&exp=nolog|" --poses downtown-300
//   (4th field = server base URL: compare two commits served side by side, e.g. "prod=index.html|||http://localhost:5197/")
//          [--gl mem  (GL-level GPU bytes per variant after settling)]
//          [--preset high] [--rounds 5] [--ms 3000] [--size 2560x1440] [--aircraft f16] [--tag name] [--shots]
import { launch, openGame, attach, setPose, settle, measure, save, arg, flag, OUT, sleep, gpuBusy } from './lib.mjs';
import { PATCHES } from './patches.mjs';
import fs from 'node:fs';


const variants = arg('--variants', 'base=index.html||').split(',').map((v) => {
  const [name, rest] = v.split('=');
  const [pageName, extra, patch, base] = (rest || '').split('|');
  return { name, pageName: pageName || 'index.html', extra: extra || '', patch: patch || '', base: base || undefined };
});
const poses = arg('--poses', 'downtown-300').split(',');
const preset = arg('--preset', 'high');
const rounds = Number(arg('--rounds', 5));
const ms = Number(arg('--ms', 3000));
const [width, height] = arg('--size', '2560x1440').split('x').map(Number);
const aircraft = arg('--aircraft', 'f16');
const spawn = arg('--spawn', 'KSFO-28R');
const tag = arg('--tag', `ab-${Date.now()}`);
if (flag('--shots')) fs.mkdirSync(`${OUT}/${tag}`, { recursive: true });

const { browser } = await launch({ width, height, gl: 'off' });   // only for the browser; pages come from contexts below
const pages = [];
for (const v of variants) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const probe = fs.readFileSync(new URL('./probe.js', import.meta.url), 'utf8');
  await page.addInitScript(({ probe, gl }) => { window.__PERF_CFG = { gl, clock: 'real' }; try { localStorage.setItem('gokyuzu.settings', JSON.stringify({ tutorial: false })); } catch {} (0, eval)(probe); }, { probe, gl: arg('--gl', 'light') });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // load one variant at a time (the others are parked)
  for (const p of pages) await p.page.evaluate(() => window.__perf.hold(true));
  await openGame(page, { aircraft, spawn, quality: preset, pageName: v.pageName, extra: v.extra, base: v.base });
  await attach(page, { gpu: true, subs: true });
  pages.push({ v, page, errors });
}
const res = {}, busy = [], mem = {};
for (const pose of poses) {
  for (const { v, page } of pages) {
    for (const p of pages) await p.page.evaluate((on) => window.__perf.hold(on), p.page !== page);
    await setPose(page, pose);
    await settle(page, { minMs: 3000, maxMs: 30000 });
    if (v.patch) for (const p of v.patch.split('+')) await page.evaluate(`(${PATCHES[p].toString()})()`);
    await sleep(600);
    if (flag('--shots')) await page.screenshot({ path: `${OUT}/${tag}/${pose}-${v.name}.png` });
    // memory after settling (GL-level bytes with --gl mem), JS heap, the preset actually running (budget step-downs)
    mem[`${pose}|${v.name}`] = await page.evaluate(() => { const P = window.__perf, g = window.__game; const b = P.gpuBytes ? P.gpuBytes() : null; return { gpuMB: b ? Math.round((b.tex + b.buf + b.rb) / 1048576) : null, texMB: b ? Math.round(b.tex / 1048576) : null, bufMB: b ? Math.round(b.buf / 1048576) : null, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, quality: g.quality && g.quality.id, programs: g.renderer.info.programs.length, textures: g.renderer.info.memory.textures, geometries: g.renderer.info.memory.geometries }; });
  }
  for (let r = 0; r < rounds; r++) {
    for (const p of pages) await p.page.evaluate(() => window.__perf.hold(true));
    await sleep(300);
    busy.push(gpuBusy());
    // random order each round (no variant always runs right after the settle or at the same phase of others' load)
    const order = pages.map((p, i) => [Math.random(), p]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const round = {};
    for (const { v, page } of order) {
      for (const p of pages) await p.page.evaluate((on) => window.__perf.hold(on), p.page !== page);
      await sleep(400);
      const m = await measure(page, ms);
      round[v.name] = { gpu: m.gpuMs && m.gpuMs.mean, gpuP10: m.gpuMs && m.gpuMs.p10, shadow: m.gpuMs && m.gpuMs.shadowMean, cpu: m.cpuMs.mean, render: m.subMean.render, fps: m.fps, p95: m.frameMs.p95, calls: m.info.calls, tris: m.info.triangles };
    }
    const base = round[variants[0].name];
    for (const v of variants) {
      const row = round[v.name];
      row.gpuRatio = base.gpu && row.gpu ? +(row.gpu / base.gpu).toFixed(3) : null;
      row.gpuP10Ratio = base.gpuP10 && row.gpuP10 ? +(row.gpuP10 / base.gpuP10).toFixed(3) : null;
      row.cpuRatio = base.cpu && row.cpu ? +(row.cpu / base.cpu).toFixed(3) : null;
      (res[`${pose}|${v.name}`] || (res[`${pose}|${v.name}`] = [])).push(row);
    }
  }
}
await browser.close();
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = {};
for (const [k, list] of Object.entries(res)) summary[k] = Object.fromEntries(Object.keys(list[0]).map((f) => [f, med(list.map((x) => x[f]))]));
console.log(`\nmedians over ${rounds} interleaved rounds (preset ${preset}, ${width}x${height}); other-process GPU busy while parked: ${JSON.stringify(busy)}`);
for (const [k, s] of Object.entries(summary)) console.log(`${k.padEnd(30)} gpu ${String(s.gpu).padEnd(6)} (x${s.gpuRatio}) p10 ${String(s.gpuP10).padEnd(6)} (x${s.gpuP10Ratio}) shadow ${String(s.shadow).padEnd(5)} cpu ${String(s.cpu).padEnd(5)} (x${s.cpuRatio}) render ${s.render} fps ${s.fps} calls ${s.calls}`);
for (const [k, m] of Object.entries(mem)) console.log(`${k.padEnd(30)} memory ${JSON.stringify(m)}`);
for (const p of pages) if (p.errors.length) console.log(`errors ${p.v.name}:`, p.errors.slice(0, 3));
save(`${tag}.json`, { variants, poses, preset, rounds, busy, summary, memory: mem, raw: res });
