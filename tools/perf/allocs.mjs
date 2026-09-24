#!/usr/bin/env node
// Per-frame garbage by source line at fixed poses (CDP HeapProfiler sampling incl. objects collected by minor / major GC):
// which functions allocate the MB/s that tools/perf/matrix.mjs reports as "alloc".
//   node tools/perf/allocs.mjs [--profile desktop-high] [--map ist] [--poses ist-ltfm-ground,ist-cockpit,ist-peninsula] [--secs 10] [--fly]
// --fly: poses are flown (autopilot) instead of paused.
import { launch, openGame, attach, setPose, settle, sleep, arg, flag, save, BASE } from './lib.mjs';
import { PROFILES, MAPS } from './matrix.mjs';

const profile = arg('--profile', 'desktop-high'), map = arg('--map', 'ist');
const P = PROFILES[profile], M = MAPS[map];
const poses = arg('--poses', `${M.ground},${M.cockpit},${M.poses[0]}`).split(',');
const secs = Number(arg('--secs', 10));
const { browser, page, cdp } = await launch({ engine: 'chromium', width: P.width, height: P.height, dpr: P.dpr, gl: 'light', heap: true, cpuThrottle: P.cpu, hasTouch: P.touch, isMobile: P.mobile });
await openGame(page, { aircraft: arg('--aircraft', 'f16'), spawn: M.spawn, quality: P.quality, pr: P.pr, extra: `${P.extra}${M.extra}&telemetry=0`, base: arg('--base', BASE) });
await attach(page, { gpu: false, subs: true });
await cdp.send('HeapProfiler.enable');
const out = {};
for (const pose of poses) {
  await setPose(page, pose);
  await settle(page, { minMs: 3000, maxMs: 25000 });
  if (flag('--fly')) await page.evaluate(() => { window.__game.paused = false; });
  await page.evaluate(() => window.__perf.mark());
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await sleep(secs * 1000);
  const { profile: prof } = await cdp.send('HeapProfiler.stopSampling');
  const sum = await page.evaluate(() => window.__perf.summary());
  const self = new Map(), byFile = new Map();
  (function walk(n, stack) {
    const cf = n.callFrame;
    const file = cf.url.replace(/^.*?\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
    const l = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    self.set(l, (self.get(l) || 0) + n.selfSize);
    // attribute to the nearest game frame (src/…) on the stack
    const game = /^src\//.test(file) ? l : stack;
    if (n.selfSize) byFile.set(game || '(no game frame)', (byFile.get(game || '(no game frame)') || 0) + n.selfSize);
    for (const c of n.children || []) walk(c, game);
  })(prof.head, null);
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, b]) => ({ fn, MBperSec: +(b / 1048576 / secs).toFixed(2), pct: +(100 * b / total).toFixed(1) }));
  out[pose] = { MBperSec: +(total / 1048576 / secs).toFixed(1), probeAlloc: sum.alloc, fps: sum.fps, topSelf: top(self), topGameFrame: top(byFile) };
  console.log(`\n${pose}: ${out[pose].MBperSec} MB/s sampled (probe ${sum.alloc && sum.alloc.MBperSec} MB/s)`);
  for (const x of out[pose].topGameFrame.slice(0, 10)) console.log(`  ${x.MBperSec} MB/s ${x.pct}%  ${x.fn}`);
}
save(`allocs-${profile}-${map}.json`, out);
await browser.close();
