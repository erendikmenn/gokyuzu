#!/usr/bin/env node
// Retained JS heap after a forced GC and resident memory per browser process type (renderer = page, gpu-process) (CDP HeapProfiler.collectGarbage) at fixed poses, for comparing two builds.
// usage: node tools/perf/heapcheck.mjs --bases prod=http://localhost:5197/,new=http://localhost:5198/ [--preset high] [--reps 2]
import { launch, openGame, setPose, settle, sleep, arg, save } from './lib.mjs';
import { execSync } from 'node:child_process';
/** Resident memory (MB) of a browser and all its child processes (renderer, GPU, utility), by process type. */
async function processMB(browser) {
  const s = await browser.newBrowserCDPSession();
  const { processInfo } = await s.send('SystemInfo.getProcessInfo');
  const rss = new Map(execSync('ps -axo pid=,rss=', { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)));
  const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] || 0) + Math.round((rss.get(p.id) || 0) / 1024);
  return by;
}
const bases = arg('--bases', 'base=http://localhost:5195/').split(',').map((s) => s.split('='));
const preset = arg('--preset', 'high'), reps = Number(arg('--reps', 2));
const poses = arg('--poses', 'downtown-300,sfo-ground').split(',');
const out = {};
for (let r = 0; r < reps; r++) for (const [name, base] of bases) {
  const { browser, page, cdp } = await launch({ width: 1600, height: 900, gl: 'mem' });
  await openGame(page, { aircraft: 'f16', quality: preset, base });
  await cdp.send('HeapProfiler.enable');
  for (const pose of poses) {
    await setPose(page, pose); await settle(page, { minMs: 4000, maxMs: 30000 }); await sleep(12000);   // > one texture sweep (8 s)
    for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); }
    const m = await page.evaluate(() => { const b = window.__perf.gpuBytes(); return { heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), gpuMB: Math.round((b.tex + b.buf + b.rb) / 1048576) }; });
    const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage');
    const k = `${pose}|${name}`;
    (out[k] || (out[k] = [])).push({ ...m, v8UsedMB: Math.round(usedSize / 1048576), v8TotalMB: Math.round(totalSize / 1048576), rssMB: await processMB(browser) });
    console.log(k, JSON.stringify(out[k][out[k].length - 1]));
  }
  await browser.close();
}
save(`heapcheck-${preset}.json`, out);
