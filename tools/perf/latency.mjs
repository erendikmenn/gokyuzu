#!/usr/bin/env node
// Touch input latency (docs/perf/findings-2026-09.md follow-up): time from a touch move on the on-screen stick to
//   (1) the flight model step that first uses the new stick position (input → simulation), and
//   (2) the drawn frame that shows that step (simulation → render call; frame pacing: phones draw every 2nd refresh).
// The GPU and the compositor add their own time after (2) (on a phone typically one more refresh + scan-out); headless
// browsers cannot observe that part, so the numbers are the game's own share of the input-to-photon path.
//
//   node tools/perf/latency.mjs [--profile phone-cpu4] [--map sf] [--trials 40] [--base URL] [--tag name]
//
// Each trial: a finger lands on the stick zone (CDP touchStart), waits a random 0–120 ms (random phase against the
// frame pacing), then moves 70 px right (touchMove = full right roll); the page records the move's event time, the
// first flight step whose input.state.roll is past the dead zone, and the first main render after that step. The finger
// lifts, the stick centres, the aircraft is reset to straight and level flight before the next trial.
import { launch, openGame, sleep, arg, save, BASE } from './lib.mjs';
import { PROFILES, MAPS } from './matrix.mjs';

const profile = arg('--profile', 'phone-cpu4'), map = arg('--map', 'sf'), trials = Number(arg('--trials', 40));
const P = PROFILES[profile], M = MAPS[map];
if (!P || !P.touch) throw new Error(`--profile must be a touch profile of tools/perf/matrix.mjs (${profile})`);
const base = arg('--base', BASE);
const { browser, page, cdp } = await launch({ engine: P.engine, width: P.width, height: P.height, dpr: P.dpr, gl: 'light', cpuThrottle: P.cpu, hasTouch: true, isMobile: P.mobile });
const out = { profile, map, base, trials: [] };
try {
  await openGame(page, { aircraft: arg('--aircraft', 'f16'), spawn: M.spawn, quality: P.quality, pr: P.pr, extra: `${P.extra}${M.extra}&telemetry=0`, base, timeout: 300000 });
  await sleep(4000);
  const place = () => page.evaluate((f) => {
    const g = window.__game, rad = (d) => d * Math.PI / 180;
    g.flight.reset({ x: f.x, z: f.z, heading: rad(f.hdg), altitude: f.alt + 800, speed: g.def.spec.spawnSpeed * 1.6 }, g.world);
    g.paused = false;
  }, M.fly);
  await place();
  await sleep(2500);
  // page hooks: event time of the last stick move, first step that consumed it, first main render after that step
  await page.evaluate(() => {
    const g = window.__game, L = (window.__lat = { armed: false, evT: 0, stepT: 0, drawT: 0, steps: 0, draws: 0 });
    addEventListener('pointermove', (e) => { if (L.armed && !L.evT && e.pointerType === 'touch') L.evT = e.timeStamp; }, { capture: true, passive: true });
    const wrapStep = () => {
      const f = g.flight;
      if (f.__latWrapped) return;
      const step = f.step;
      f.step = function (dt, inp, w) {
        if (L.armed && L.evT && !L.stepT && inp && Math.abs(inp.roll) > 0.3) { L.stepT = performance.now(); L.steps++; }
        return step.call(this, dt, inp, w);
      };
      f.__latWrapped = true;
    };
    wrapStep();
    L.wrapStep = wrapStep;
    const r = g.renderer, render = r.render;
    r.render = function (s, c) {
      const res = render.call(this, s, c);
      if (!r.getRenderTarget() && L.stepT && !L.drawT) { L.drawT = performance.now(); L.draws++; }
      return res;
    };
  });
  const zone = await page.evaluate(() => { const d = window.__game.touch.debug(); return d.rects && d.rects['.gkx-zone']; });
  if (!zone) throw new Error('no touch stick (touch controls inactive?)');
  const x0 = Math.round(zone.x + zone.w * 0.45), y0 = Math.round(zone.y + zone.h * 0.55);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  for (let i = 0; i < trials; i++) {
    await page.evaluate(() => { const L = window.__lat; L.wrapStep(); L.armed = false; L.evT = L.stepT = L.drawT = 0; });
    await touch('touchStart', x0, y0);
    await sleep(40 + Math.random() * 120);
    await page.evaluate(() => { window.__lat.armed = true; });
    await touch('touchMove', x0 + 70, y0);
    let r = null;
    for (let k = 0; k < 40 && !(r && r.drawT); k++) { await sleep(25); r = await page.evaluate(() => ({ ...window.__lat, pacing: window.__game.pacing && { mode: window.__game.pacing.mode, target: window.__game.pacing.target } })); }
    await touch('touchEnd', 0, 0);
    if (r && r.evT && r.stepT && r.drawT) out.trials.push({ toStep: +(r.stepT - r.evT).toFixed(2), toDraw: +(r.drawT - r.evT).toFixed(2), mode: r.pacing && r.pacing.mode });
    await sleep(250);
    if (i % 8 === 7) { await place(); await sleep(1500); }
  }
} finally {
  await browser.close();
}
const s = (k) => { const v = out.trials.map((t) => t[k]).sort((a, b) => a - b); return v.length ? { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), p50: v[Math.floor(v.length / 2)], p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))], max: v[v.length - 1] } : null; };
out.summary = { n: out.trials.length, toStep: s('toStep'), toDraw: s('toDraw'), modes: [...new Set(out.trials.map((t) => t.mode))] };
console.log(`${profile} ${map}: ${out.summary.n} trials | touch → flight step ${JSON.stringify(out.summary.toStep)} ms | touch → drawn frame ${JSON.stringify(out.summary.toDraw)} ms | modes ${out.summary.modes}`);
save(`${arg('--tag', `latency-${profile}-${map}`)}.json`, out);
