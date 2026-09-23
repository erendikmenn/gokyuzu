#!/usr/bin/env node
// Runtime cost per scene and quality preset: CPU vs GPU frame time (EXT_disjoint_timer_query_webgl2, shadow pass
// separately), per-subsystem CPU (world layers, renderer.render, HUD, avionics, audio, camera, rig), draw calls /
// triangles / programs / textures / geometries, uploads, compile stalls, long tasks, heap, GPU memory (GL-level) and,
// optionally, per-layer draw calls and GPU time by ablation.
//
// usage: node tools/perf/scenes.mjs [--presets low,medium,high,ultra] [--poses sfo-ground,downtown-300,...]
//          [--cockpits f16,f22,a320neo,b737,uh60] [--ms 8000] [--ablation high] [--size 2560x1440] [--dpr 1]
//          [--cpu 4] [--webkit] [--uncapped] [--tag name] [--gl light|mem] [--page perf-exp.html --extra '&exp=revz']
//          [--ablation-poses downtown-300,...] [--no-frag] [--pr 2 (pinned pixel ratio, with --dpr 2 for Retina/5K)]
//          [--quiet 30 (wait until other processes keep the GPU < 30 % busy before each measurement; default 0 = off)] [--quiet-max ms]
// Output: $PERF_OUT/scenes-<tag>.json + a table on stdout. Screenshots: $PERF_OUT/scenes-<tag>/<preset>-<pose>.png
import { launch, openGame, attach, setPose, settle, measure, layerReport, layerCalls, layerGpuAblation, worldStats, fragmentReport, save, arg, flag, fmtTable, OUT, sleep, waitQuiet, gpuBusy } from './lib.mjs';
import fs from 'node:fs';

const presets = arg('--presets', 'low,medium,high,ultra').split(',');
const poses = arg('--poses', 'sfo-ground,downtown-300,golden-gate,bay-3000,birdseye').split(',').filter(Boolean);
const cockpits = arg('--cockpits', 'f16,f22,a320neo,b737,uh60').split(',').filter(Boolean);
const ms = Number(arg('--ms', 8000));
const ablation = (arg('--ablation', '') || '').split(',').filter(Boolean);
const ablationPoses = (arg('--ablation-poses', '') || '').split(',').filter(Boolean);
const [width, height] = arg('--size', '2560x1440').split('x').map(Number);
const dpr = Number(arg('--dpr', 1));
const cpu = Number(arg('--cpu', 1));
const engine = flag('--webkit') ? 'webkit' : 'chromium';
const gl = arg('--gl', 'light');
const quietPct = Number(arg('--quiet', 0)), quietMax = Number(arg('--quiet-max', 120000));
const tag = arg('--tag', `${engine}${cpu > 1 ? `-cpu${cpu}` : ''}-${width}x${height}`);
const shots = `${OUT}/scenes-${tag}`;
fs.mkdirSync(shots, { recursive: true });
const results = [];

async function runPage(preset, aircraft, spawn, poseList) {
  const { browser, page, log } = await launch({ engine, width, height, dpr, gl, uncapped: flag('--uncapped'), cpuThrottle: cpu });
  try {
    const t = await openGame(page, { aircraft, spawn, quality: preset, pr: Number(arg('--pr', 1)), pageName: arg('--page', 'index.html'), extra: arg('--extra', '') });
    await attach(page, { gpu: true, subs: true });
    for (const pose of poseList) {
      await setPose(page, pose);
      const st = await settle(page, { minMs: 4000, maxMs: 40000 });
      // shared GPU: park the game, wait for other processes to leave the GPU idle (--quiet <busy %>, 0 = off), measure
      let quiet = null;
      if (quietPct > 0) {
        await page.evaluate(() => window.__perf.hold(true));
        quiet = await waitQuiet({ threshold: quietPct, maxMs: quietMax });
        await page.evaluate(() => window.__perf.hold(false));
      }
      await sleep(500);
      const m = await measure(page, ms);
      m.contention = { quiet, busyAfter: gpuBusy() };
      const calls = await layerCalls(page);
      const mem = await layerReport(page);
      const ws = await worldStats(page);
      const frag = flag('--no-frag') ? null : await fragmentReport(page);
      await page.screenshot({ path: `${shots}/${preset}-${pose}${pose === 'cockpit' ? `-${aircraft}` : ''}.png` });
      const row = { preset, pose: pose === 'cockpit' ? `cockpit-${aircraft}` : pose, aircraft, loadS: t, settleMs: st.ms, settled: st.idle, ...m, layerCalls: calls, memory: mem, world: ws, fragments: frag };
      if (ablation.includes(preset) && pose !== 'cockpit' && (!ablationPoses.length || ablationPoses.includes(pose))) row.ablation = await layerGpuAblation(page, 1200, 3);
      results.push(row);
      const g = m.gpuMs || {};
      console.log(`${preset.padEnd(6)} ${row.pose.padEnd(16)} [quiet ${m.contention.quiet ? m.contention.quiet.quiet + ' ' + m.contention.quiet.busy.join('/') : '-'}] fps ${m.fps} frame p50 ${m.frameMs.p50} p95 ${m.frameMs.p95} | cpu ${m.cpuMs.mean} (render ${m.subMean.render}, world ${m.subMean.world}, hud ${m.subMean.hud}, avi ${m.subMean.avionics ?? 0}) | gpu ${g.mean} p10 ${g.p10} (shadow ${g.shadowMean}) | calls ${m.info.calls} tris ${(m.info.triangles / 1e6).toFixed(2)}M prog ${m.info.programs} tex ${m.info.textures} geo ${m.info.geometries} | heap ${m.heapMB} MB${m.gpuBytesMB && m.gpuBytesMB.texCount ? ` gpu tex ${m.gpuBytesMB.tex} buf ${m.gpuBytesMB.buf} MB` : ''}${frag ? ` | shaded ${frag.totalShadedMpx} Mpx x${frag.overdraw}` : ''}`);
      save(`scenes-${tag}.json`, results);
    }
    if (log.errors.length) console.log('  errors:', log.errors.slice(0, 5).join(' | '));
  } catch (e) {
    console.error(`FAILED ${preset} ${aircraft}:`, e.message);
    results.push({ preset, aircraft, error: e.message });
  } finally {
    await browser.close();
  }
}

for (const preset of presets) {
  if (poses.length) await runPage(preset, 'f16', 'KSFO-28R', poses.filter((p) => p !== 'cockpit'));
  for (const ac of cockpits) await runPage(preset, ac, 'KSFO-28R', ['cockpit']);
}
save(`scenes-${tag}.json`, results);
const rows = results.filter((r) => !r.error).map((r) => ({
  preset: r.preset, pose: r.pose, fps: r.fps, 'frame p95': r.frameMs.p95, 'cpu ms': r.cpuMs.mean, 'cpu p95': r.cpuMs.p95, render: r.subMean.render, world: r.subMean.world,
  hud: r.subMean.hud, avio: r.subMean.avionics, 'gpu ms': r.gpuMs && r.gpuMs.mean, shadow: r.gpuMs && r.gpuMs.shadowMean, calls: r.info.calls, 'tris M': (r.info.triangles / 1e6).toFixed(2),
  progs: r.info.programs, 'heap MB': r.heapMB, 'gpu MB': r.gpuBytesMB ? (r.gpuBytesMB.tex + r.gpuBytesMB.buf + r.gpuBytesMB.rb).toFixed(0) : '',
}));
console.log('\n' + fmtTable(rows, Object.keys(rows[0] || {})));
console.log(`\nsaved ${OUT}/scenes-${tag}.json`);
