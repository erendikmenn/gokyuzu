// Attributes long frames: wraps world.update / renderer.render / hud.update / display updates / flight.step and logs the
// breakdown + new programs / textures / geometries for frames > 80 ms while the F-16 flies an autopilot tour of the bay.
// usage: node tools/qa/hitchprobe.mjs [--dpr 2] [--secs 240] [--webkit]
import { launch, openGame, startSampling, tap, shot, sleep } from './lib.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const { browser, page, log } = await launch({ engine, dpr: Number(arg('--dpr', 2)) });
await openGame(page, 'f16', 'AIR-CITY');
await startSampling(page);
await page.evaluate(() => {
  const g = window.__game, r = g.renderer;
  const acc = { world: 0, render: 0, hud: 0, disp: 0, step: 0 };
  const wrap = (obj, name, key) => { const f = obj[name]; obj[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { acc[key] += performance.now() - t; } }; };
  wrap(g.world, 'update', 'world'); wrap(r, 'render', 'render'); wrap(g.hud, 'update', 'hud'); wrap(g.flight, 'step', 'step');
  for (const d of g.displays) wrap(d.display, 'update', 'disp');
  // world sub-layers if exposed
  const subs = {};
  const named = { terrain: g.world.terrain, env: g.world.environment };
  (g.world.layers || []).forEach((l, i) => { named['L' + i] = l; });
  for (const [k, l] of Object.entries(named)) if (l && l.update) { const f = l.update; subs[k] = 0; l.update = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { subs[k] += performance.now() - t; } }; }
  const slow = (window.__slow = []);
  let last = 0, prev = { p: 0, t: 0, g: 0 };
  const tick = (ts) => {
    const i = r.info; const now = { p: i.programs ? i.programs.length : 0, t: i.memory.textures, g: i.memory.geometries };
    if (last && ts - last > 80) slow.push({ at: +((ts - window.__qa.t0) / 1000).toFixed(1), dt: Math.round(ts - last), ...Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v)])), sub: Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, Math.round(v)])), newProg: now.p - prev.p, newTex: now.t - prev.t, newGeo: now.g - prev.g, pos: [Math.round(g.flight.position.x), Math.round(g.flight.position.z)] });
    for (const k in acc) acc[k] = 0; for (const k in subs) subs[k] = 0;
    prev = now; last = ts; requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // long tasks outside rAF
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 150) window.__lt.push({ at: +((e.startTime - window.__qa.t0) / 1000).toFixed(1), ms: Math.round(e.duration), name: e.name, attr: (e.attribution || []).map((a) => a.containerSrc || a.name).join(',') }); }).observe({ entryTypes: ['longtask'] }); } catch {}
});
await tap(page, 'Digit6'); await sleep(300); await tap(page, 'KeyO');
const legs = [340, 250, 160, 90, 20, 290];
const t0 = Date.now(); const secs = Number(arg('--secs', 240));
while (Date.now() - t0 < secs * 1000) {
  const target = legs[Math.floor((Date.now() - t0) / 50000) % legs.length];
  const s = await page.evaluate(() => ({ hdg: window.__game.flight.autopilot.heading, ap: window.__game.flight.autopilot.on }));
  if (!s.ap) await tap(page, 'KeyO');
  const e = ((target - s.hdg + 540) % 360) - 180;
  if (Math.abs(e) > 5) { const k = e > 0 ? 'KeyD' : 'KeyA'; await page.keyboard.down(k); await sleep(Math.min(1500, Math.abs(e) * 30)); await page.keyboard.up(k); }
  await sleep(1000);
}
const slow = await page.evaluate(() => window.__slow);
const lt = await page.evaluate(() => window.__lt);
console.log('world layers:', await page.evaluate(() => Object.keys(window.__game.world.layers || {})));
console.log('slow frames (>80 ms):', slow.length);
for (const s of slow.sort((a, b) => b.dt - a.dt).slice(0, 25)) console.log(JSON.stringify(s));
console.log('longtasks >150ms:', JSON.stringify(lt.slice(0, 20)));
await browser.close();
