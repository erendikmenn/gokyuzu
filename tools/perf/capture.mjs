#!/usr/bin/env node
// Quality harness, step 1: screenshots of fixed camera poses with time frozen (tools/perf/probe.js virtual clock: water,
// clouds, fog and animations stop), HUD hidden, streaming settled. Capture a baseline twice (the second capture is the
// run-to-run noise floor), then the candidate, and compare with tools/perf/ssim.py:
//   node tools/perf/capture.mjs --out base  --preset high
//   node tools/perf/capture.mjs --out noise --preset high
//   node tools/perf/capture.mjs --out cand  --preset high --page perf-exp.html --extra "&exp=revz"   (or another server)
//   .venv/bin/python tools/perf/ssim.py --dirs $OUT/cap/base $OUT/cap/cand --noise $OUT/cap/noise --heatmaps $OUT/cap/heat
// usage: node tools/perf/capture.mjs --out <name> [--poses a,b] [--preset high] [--size 1920x1080] [--base URL]
//          [--page index.html] [--extra '&time=12:00'] [--aircraft f16] [--patch skylast] [--webkit]
import { launch, openGame, setPose, settle, sleep, arg, flag, OUT, POSES } from './lib.mjs';
import { PATCHES } from './patches.mjs';
import fs from 'node:fs';

const name = arg('--out', 'base');
const poses = arg('--poses', 'sfo-ground,downtown-300,golden-gate,bay-3000,birdseye,cockpit,free-downtown,free-ggb,free-sfo').split(',');
const preset = arg('--preset', 'high');
const [width, height] = arg('--size', '1920x1080').split('x').map(Number);
const dir = `${OUT}/cap/${name}`;
fs.mkdirSync(dir, { recursive: true });
const { browser, page, log } = await launch({ engine: flag('--webkit') ? 'webkit' : 'chromium', width, height, gl: 'off', clock: 'virtual' });
await openGame(page, { aircraft: arg('--aircraft', 'f16'), spawn: 'KSFO-28R', quality: preset, pageName: arg('--page', 'index.html'), extra: arg('--extra', ''), base: arg('--base', undefined) });
// HUD hidden with CSS only: hud.setVisible() persists the HUD mode through saveSettings(), and the broadcast settings
// carry the stored/detected quality, which replaces a ?quality= preset (would turn every capture into the detected one)
await page.addStyleTag({ content: '#hud, #ui { display: none !important; }' });   // HUD, hints and messages are DOM: not part of the 3D comparison
const patch = arg('--patch', '');
const meta = {};
for (const pose of poses) {
  if (!POSES[pose]) { console.log('skip unknown pose', pose); continue; }
  await page.evaluate(() => window.__perf.freeze(false));
  await setPose(page, pose);
  if (patch) for (const p of patch.split('+')) await page.evaluate(`(${PATCHES[p].toString()})()`);
  const st = await settle(page, { minMs: 5000, maxMs: 45000, quietMs: 2500 });
  // a fixed number of frames with time running (same animation phase in every capture), then time stops
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 30 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  await page.evaluate(() => {
    window.__perf.freeze(true);
    // animation time → a fixed value, so water waves, clouds and the fog bank are in the same phase in every capture
    // (the virtual clock runs during loading/settling for a varying number of frames)
    const w = window.__game.world, T = 1000;
    if (w.terrain && w.terrain.shared && w.terrain.shared.uTime) w.terrain.shared.uTime.value = T;
    const e = w.environment;
    if (e && e.skyUniforms && e.skyUniforms.uTime) e.update(T - e.skyUniforms.uTime.value, window.__game.camera);
  });
  await sleep(1200);
  await page.screenshot({ path: `${dir}/${pose}.png` });
  // the preset actually running (the GPU budget monitor or a context-loss reload may have stepped it down)
  const q = await page.evaluate(() => ({ quality: window.__game.quality && window.__game.quality.id, meterMB: window.__game.gpu && window.__game.gpu.meter ? Math.round(window.__game.gpu.meter.bytes / 1048576) : null, url: location.search }));
  meta[pose] = { settled: st.idle, ms: st.ms, ...q };
  console.log(`${pose}: settled ${st.idle} in ${st.ms} ms, quality ${q.quality}, meter ${q.meterMB} MB`);
}
fs.writeFileSync(`${dir}/capture.json`, JSON.stringify({ preset, extra: arg('--extra', ''), base: arg('--base', ''), poses: meta, errors: log.errors.slice(0, 10) }, null, 1));
if (log.errors.length) console.log('errors:', log.errors.slice(0, 5));
await browser.close();
console.log(`saved ${dir}`);
