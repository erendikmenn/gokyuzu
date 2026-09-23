// Performance: fps / hitches / renderer.info / JS heap at SFO ground, downtown low pass, Golden Gate, and a long flight.
// usage: node tools/qa/perf.mjs [--dpr 2] [--webkit] [--long 300]
import { launch, openGame, startSampling, frameStats, renderInfo, tap, shot, fly, sleep } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const dpr = Number(arg('--dpr', 2));
const longS = Number(arg('--long', 300));
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const { browser, page, log } = await launch({ engine, dpr });
const out = {};
const hitches = () => page.evaluate(() => { const h = window.__qa.hitches; window.__qa.hitches = []; return h; });
async function measure(name, fn, ms) {
  await frameStats(page); await hitches();
  const t0 = Date.now();
  if (fn) await fn(ms); else await sleep(ms);
  const fsx = await frameStats(page), ri = await renderInfo(page), h = await hitches();
  out[name] = { ...fsx, ...ri, hitchList: h.slice(0, 8) };
  console.log(name, JSON.stringify(out[name]));
  await shot(page, `perf-${engine}-${name}`);
}
try {
  const l1 = await openGame(page, 'a320neo', 'KSFO-28R');
  console.log('load SFO', l1, 'app ready', log.ready);
  await startSampling(page);
  await sleep(3000);
  await measure('sfo-ground', null, 15000);
  await tap(page, 'KeyT'); await sleep(1500);
  await measure('sfo-ground-cockpit', null, 10000);
  await tap(page, 'KeyT');

  await openGame(page, 'f16', 'AIR-CITY');
  await startSampling(page);
  await tap(page, 'Digit7');
  // descend to 300 m heading north over downtown
  await fly(page, { alt: 300, heading: 350, maxBank: 30, maxMs: 12000 });
  await measure('city-300m', (ms) => fly(page, { alt: 300, heading: 350, maxBank: 30, maxMs: ms }), 20000);
  await tap(page, 'KeyT'); await sleep(1000);
  await measure('city-300m-cockpit', (ms) => fly(page, { alt: 300, heading: 350, maxBank: 30, maxMs: ms }), 10000);
  await tap(page, 'KeyT');

  await openGame(page, 'b737', 'AIR-GGB');
  await startSampling(page);
  await measure('ggb-approach', (ms) => fly(page, { alt: 300, heading: 100, maxBank: 25, maxMs: ms }), 25000);

  // long flight: F-16 on autopilot around the bay; heap / geometry / texture counts over time
  await openGame(page, 'f16', 'AIR-CITY');
  await startSampling(page);
  await tap(page, 'Digit6');
  await sleep(500);
  await tap(page, 'KeyO');
  const legs = [340, 250, 160, 90, 20, 290];
  const series = [];
  const t0 = Date.now();
  let leg = 0;
  await frameStats(page); await hitches();
  while (Date.now() - t0 < longS * 1000) {
    // steer the autopilot heading target with A/D (as the help says)
    const target = legs[Math.floor((Date.now() - t0) / 50000) % legs.length];
    const s = await page.evaluate(() => ({ hdg: window.__game.flight.autopilot.heading, ap: window.__game.flight.autopilot.on, crashed: window.__game.flight.crashed }));
    if (!s.ap && !s.crashed) await tap(page, 'KeyO');
    const e = ((target - s.hdg + 540) % 360) - 180;
    if (Math.abs(e) > 5) { const k = e > 0 ? 'KeyD' : 'KeyA'; await page.keyboard.down(k); await sleep(Math.min(1500, Math.abs(e) * 30)); await page.keyboard.up(k); }
    if ((Date.now() - t0) / 1000 > series.length * 30) {
      const ri = await renderInfo(page); const fsx = await frameStats(page);
      const pos = await page.evaluate(() => { const f = window.__game.flight; return [Math.round(f.position.x), Math.round(f.position.y), Math.round(f.position.z), f.crashed]; });
      series.push({ t: Math.round((Date.now() - t0) / 1000), pos, ...ri, fps: fsx && fsx.avgFps, p99: fsx && fsx.p99ms, h50: fsx && fsx.hitches50, max: fsx && fsx.maxMs });
      console.log('long', JSON.stringify(series[series.length - 1]));
      if (series.length % 4 === 0) await shot(page, `perf-${engine}-long-${series.length}`);
    }
    await sleep(1000);
  }
  out.long = series;
} catch (e) { console.error('TEST ERROR', e); await shot(page, 'perf-error'); }
console.log('errors', JSON.stringify(log.errors.slice(0, 20)));
await browser.close();
