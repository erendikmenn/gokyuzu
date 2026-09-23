#!/usr/bin/env node
// Overdraw / shaded-fragment report per pose and preset (lib.mjs fragmentReport): which layers make the GPU shade how
// many fragments, and how many of those end up visible. Contention-free (no timing).
// usage: node tools/perf/overdraw.mjs [--presets high] [--poses sfo-ground,downtown-300,...] [--size 2560x1440] [--page ..] [--extra ..]
import { launch, openGame, setPose, settle, fragmentReport, save, arg, sleep } from './lib.mjs';
const presets = arg('--presets', 'high').split(',');
const poses = arg('--poses', 'sfo-ground,downtown-300,golden-gate,bay-3000,birdseye,cockpit').split(',');
const [width, height] = arg('--size', '2560x1440').split('x').map(Number);
const out = {};
for (const preset of presets) {
  const { browser, page, log } = await launch({ width, height, gl: 'off' });
  try {
    await openGame(page, { aircraft: arg('--aircraft', 'f16'), quality: preset, pageName: arg('--page', 'index.html'), extra: arg('--extra', '') });
    for (const pose of poses) {
      await setPose(page, pose);
      await settle(page, { minMs: 4000, maxMs: 40000 });
      await sleep(500);
      const fr = await fragmentReport(page);
      out[`${preset}|${pose}`] = fr;
      console.log(`${preset} ${pose}: screen ${fr.screenMpx} Mpx, shaded ${fr.totalShadedMpx} Mpx (overdraw x${fr.overdraw})`);
      for (const l of fr.layers) console.log(`   ${l.layer.padEnd(22)} shaded ${String(l.shadedMpx).padStart(6)} Mpx (${String(l.shadedScreens).padStart(5)} screens)  visible ${String(l.visibleMpx).padStart(6)} Mpx  wasted ${l.wastedPct}%`);
      save(`overdraw-${width}x${height}.json`, out);
    }
    if (log.errors.length) console.log('errors', log.errors.slice(0, 3));
  } finally { await browser.close(); }
}
