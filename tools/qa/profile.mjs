// CPU-profiles a downtown low pass (Chromium, CDP) and attributes main-thread long tasks (>100 ms) to functions.
// usage: node tools/qa/profile.mjs [aircraft] [spawn] [--secs 60] [--dpr 2]
import { launch, openGame, startSampling, tap, fly, sleep } from './lib.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const id = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'f16';
const spawn = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'AIR-CITY';
const { browser, page } = await launch({ dpr: Number(arg('--dpr', 2)) });
await openGame(page, id, spawn);
await startSampling(page);
await page.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 100) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ entryTypes: ['longtask'] }); });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
const t0 = await page.evaluate(() => performance.now());
await cdp.send('Profiler.start');
await tap(page, 'Digit7');
if (process.argv.includes('--tour')) {
  // autopilot tour of the bay (same legs as perf.mjs / hitchprobe.mjs)
  await tap(page, 'Digit6'); await sleep(300); await tap(page, 'KeyO');
  const legs = [340, 250, 160, 90, 20, 290]; const ts = Date.now();
  while (Date.now() - ts < Number(arg('--secs', 60)) * 1000) {
    const target = legs[Math.floor((Date.now() - ts) / 50000) % legs.length];
    const s = await page.evaluate(() => ({ hdg: window.__game.flight.autopilot.heading, ap: window.__game.flight.autopilot.on }));
    if (!s.ap) await tap(page, 'KeyO');
    const e = ((target - s.hdg + 540) % 360) - 180;
    if (Math.abs(e) > 5) { const k = e > 0 ? 'KeyD' : 'KeyA'; await page.keyboard.down(k); await sleep(Math.min(1500, Math.abs(e) * 30)); await page.keyboard.up(k); }
    await sleep(1000);
  }
} else await fly(page, { alt: 250, heading: 350, maxBank: 30, maxMs: Number(arg('--secs', 60)) * 1000 });
const { profile } = await cdp.send('Profiler.stop');
const lts = await page.evaluate(() => window.__lt);
// sample times (µs, profile clock) -> map to performance.now() via profile.startTime offset: profile times are monotonic µs;
// use relative offsets: first sample ~ t0
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
let t = profile.startTime; const times = profile.timeDeltas.map((d) => (t += d));
const toPerf = (us) => t0 + (us - profile.startTime) / 1000;
const label = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*localhost:5173\//, '')}:${n.callFrame.lineNumber + 1}`;
console.log('long tasks > 100 ms:', lts.length, JSON.stringify(lts.map((l) => [Math.round(l.s - t0), Math.round(l.d)])));
for (const lt of lts.sort((a, b) => b.d - a.d).slice(0, 4)) {
  const self = new Map(), incl = new Map();
  profile.samples.forEach((sid, i) => {
    const pt = toPerf(times[i]);
    if (pt < lt.s || pt > lt.s + lt.d) return;
    const n = nodes.get(sid); self.set(label(n), (self.get(label(n)) || 0) + 1);
    const seen = new Set(); let cur = sid;
    while (cur != null) { const nn = nodes.get(cur); const lb = label(nn); if (!seen.has(lb)) { seen.add(lb); incl.set(lb, (incl.get(lb) || 0) + 1); } cur = parent.get(cur); }
  });
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, c]) => `${(c * 0.5).toFixed(0)}ms ${l}`);
  console.log(`\n== long task at +${Math.round(lt.s - t0)} ms, ${Math.round(lt.d)} ms\n self:\n  ${top(self, 8).join('\n  ')}\n inclusive (src only):\n  ${top(new Map([...incl].filter(([l]) => /src\/|three|draco|GLTF/.test(l))), 12).join('\n  ')}`);
}
await browser.close();
