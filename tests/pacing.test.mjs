// Frame pacing tests (src/app/frame-pacing.js): flight caps per device class and setting, the rates behind the menu /
// loading screen / overlays / parked, a regular cadence at 60, 90, 120 and 144 Hz, jittery timestamps, a device that
// cannot reach the cap, and the tablet 60 → 30 fallback. Run: node tests/pacing.test.mjs
// No framework: prints a PASS/FAIL table, exits 1 on failure.
import { createFramePacer, flightCap, parseFpsSetting, PACE } from '../src/app/frame-pacing.js';

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

/** Run `secs` of rAF callbacks at `hz` (optional jitter in ms, optional per-draw cost that delays the next callback). */
function run(p, { hz = 60, secs = 10, mode = 'flight', jitter = 0, o = {}, cost = 0, t0 = 0 } = {}) {
  let ts = t0, draws = 0, sims = 0, maxGap = 0, lastDraw = null, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const period = 1000 / hz, gaps = [];
  while (ts < t0 + secs * 1000) {
    p.raf(ts);
    const m = typeof mode === 'function' ? mode(ts) : mode;
    const d = p.decide(ts, m, typeof o === 'function' ? o(ts) : o);
    if (d.sim) sims++;
    if (d.draw) {
      draws++;
      if (lastDraw !== null) { const g = ts - lastDraw; gaps.push(g); maxGap = Math.max(maxGap, g); }
      lastDraw = ts;
      p.drawn(ts, m);
    }
    // next vsync; a slow frame (cost > period) misses refreshes
    let next = ts + period;
    const c = typeof cost === 'function' ? cost(ts) : cost;
    if (d.draw && c > period) next = ts + Math.ceil(c / period) * period;
    ts = next + (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
  }
  gaps.sort((a, b) => a - b);
  return { draws, sims, fps: draws / secs, simFps: sims / secs, maxGap, p50: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)] };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- settings and caps ----
check('parse: auto / null / garbage → null', parseFpsSetting('auto') === null && parseFpsSetting(null) === null && parseFpsSetting('45') === null);
check('parse: 30 / 60 / 0 (string or number)', parseFpsSetting('30') === 30 && parseFpsSetting(60) === 60 && parseFpsSetting('0') === 0);
check('cap: phone auto 30, tablet auto 60, desktop auto 0', flightCap('phone', null) === 30 && flightCap('tablet', null) === 60 && flightCap('desktop', null) === 0 && flightCap('integrated', null) === 0);
check('cap: the setting wins (phone 60, desktop 30, tablet 0)', flightCap('phone', 60) === 60 && flightCap('desktop', 30) === 30 && flightCap('tablet', 0) === 0);

// ---- cadence per display rate ----
for (const hz of [60, 90, 120, 144]) {
  const r = run(createFramePacer({ deviceClass: 'phone' }), { hz });
  check(`phone 30 fps cap at ${hz} Hz: ~30 fps, regular`, near(r.fps, 30, 1) && r.p95 - r.p50 < 1, `${r.fps.toFixed(1)} fps, gaps p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} ms`);
}
{
  const r = run(createFramePacer({ deviceClass: 'phone' }), { hz: 60, jitter: 2 });
  check('phone 30 fps at 60 Hz with ±2 ms timestamp jitter: no dropped cadence', near(r.fps, 30, 0.6) && r.maxGap < 40, `${r.fps.toFixed(1)} fps, max gap ${r.maxGap.toFixed(1)} ms`);
}
{
  const r = run(createFramePacer({ deviceClass: 'desktop' }), { hz: 120 });
  check('desktop auto: every refresh at 120 Hz', near(r.fps, 120, 1), `${r.fps.toFixed(1)} fps`);
}
{
  const r = run(createFramePacer({ deviceClass: 'desktop', setting: 60 }), { hz: 144 });
  check('desktop 60 setting at 144 Hz: ~60 fps (every 2nd / 3rd refresh, never above 60)', r.fps <= 60.5 && r.fps > 57, `${r.fps.toFixed(1)} fps`);
}
{
  const r = run(createFramePacer({ deviceClass: 'phone' }), { hz: 60, cost: 40 });
  check('phone that needs 40 ms per frame: draws on every refresh it gets (~20 fps, no extra skipping)', near(r.fps, 20, 1), `${r.fps.toFixed(1)} fps`);
}
{
  const r = run(createFramePacer({ deviceClass: 'phone', enabled: false }), { hz: 120 });
  check('?pace=0: every refresh (old behaviour)', near(r.fps, 120, 1), `${r.fps.toFixed(1)} fps`);
}

// ---- modes ----
{
  const p = createFramePacer({ deviceClass: 'desktop' });
  const idle = run(p, { mode: 'idle', secs: 3 });
  const hidden = run(p, { mode: 'hidden', secs: 3, t0: 3000 });
  check('menu (idle) and hidden tab: nothing simulated or drawn', idle.draws === 0 && idle.sims === 0 && hidden.draws === 0 && hidden.sims === 0);
  const load = run(p, { mode: 'loading', secs: 5, t0: 6000 });
  check(`loading screen: ${PACE.loading} draws/s, streaming (simulation) every refresh`, near(load.fps, PACE.loading, 0.3) && near(load.simFps, 60, 1), `${load.fps.toFixed(1)} draws/s, ${load.simFps.toFixed(1)} sims/s`);
  const warm = run(p, { mode: 'loading', secs: 2, t0: 11000, o: { warming: true } });
  check('pre-warm (warming = true): no draw', warm.draws === 0);
  const now = run(p, { mode: 'loading', secs: 0.1, t0: 13000, o: { warming: 'render' } });
  check("pre-warm frame (warming = 'render'): drawn at once", now.draws >= 5);
  const pause = run(p, { mode: 'overlay', secs: 5, t0: 14000 });
  check(`pause / mission card: ${PACE.overlay} draws/s, ${PACE.overlaySim} simulation steps/s`, near(pause.fps, PACE.overlay, 0.3) && near(pause.simFps, PACE.overlaySim, 0.5), `${pause.fps.toFixed(1)} / ${pause.simFps.toFixed(1)}`);
  const drag = run(p, { mode: 'overlay', secs: 2, t0: 19000, o: { interacting: true } });
  check('pause while the player drags the camera: full rate', near(drag.fps, 60, 1), `${drag.fps.toFixed(1)} fps`);
  const map = run(p, { mode: 'map', secs: 5, t0: 21000 });
  check(`big map open: draws ${PACE.overlay} fps, the flight simulates every refresh`, near(map.fps, PACE.overlay, 0.3) && near(map.simFps, 60, 1), `${map.fps.toFixed(1)} / ${map.simFps.toFixed(1)}`);
  const parked = run(p, { mode: 'parked', secs: 5, t0: 26000 });
  check(`parked, desktop: ${PACE.parked.desktop} fps`, near(parked.fps, PACE.parked.desktop, 0.5), `${parked.fps.toFixed(1)} fps`);
}
{
  const r = run(createFramePacer({ deviceClass: 'phone' }), { mode: 'parked', secs: 5 });
  check(`parked, phone: ${PACE.parked.phone} fps`, near(r.fps, PACE.parked.phone, 0.5), `${r.fps.toFixed(1)} fps`);
  const r2 = run(createFramePacer({ deviceClass: 'desktop', setting: 30 }), { mode: 'parked', secs: 5 });
  check('parked never above the flight cap (desktop at a 30 cap: 30)', near(r2.fps, 30, 0.5), `${r2.fps.toFixed(1)} fps`);
}
{   // leaving an overlay: the first flight frame comes on the next refresh
  const p = createFramePacer({ deviceClass: 'desktop' });
  run(p, { mode: 'overlay', secs: 2 });
  const r = run(p, { mode: 'flight', secs: 0.05, t0: 2000 });
  check('back from pause: drawn on the very next refresh', r.draws >= 2);
}

{   // a frozen test clock (the timestamp stops advancing): every callback draws, as before pacing
  const p = createFramePacer({ deviceClass: 'phone' });
  run(p, { mode: 'overlay', secs: 1 });
  let draws = 0;
  for (let i = 0; i < 10; i++) { p.raf(5000); if (p.decide(5000, 'overlay', {}).draw) draws++; }
  check('frozen clock (timestamp does not advance): every callback draws', draws >= 9, `${draws}/10`);
}

// ---- tablet: 60, or 30 when 60 is not held ----
{
  const p = createFramePacer({ deviceClass: 'tablet' });
  const fast = run(p, { secs: 10 });
  check('tablet that holds 60: stays at 60', near(fast.fps, 60, 1) && !p.stats.locked30, `${fast.fps.toFixed(1)} fps`);
  const slow = run(p, { secs: 10, cost: 22, t0: 10000 });   // 22 ms per frame → 30 fps at 60 Hz (every 2nd refresh)
  check('tablet that cannot hold 60 (≈30–45 fps): locks to a steady 30', p.stats.locked30 && p.cap(20000) === 30, `${slow.fps.toFixed(1)} fps, cap ${p.cap(20000)}`);
  const later = p.cap(10000 + 3000 + PACE.backoffSecs[0] * 1000 + 2000);
  check(`tablet tries 60 again after ${PACE.backoffSecs[0]} s`, later === 60, `cap ${later}`);
  const h = createFramePacer({ deviceClass: 'tablet' });
  run(h, { secs: 20, cost: (ts) => (Math.floor(ts / 1000) !== Math.floor((ts + 16.7) / 1000) ? 150 : 5) });   // a 150 ms hitch every second
  check('tablet at 60 with a streaming hitch every second: not locked to 30', !h.stats.locked30 && h.cap(20000) === 60);
  const q = createFramePacer({ deviceClass: 'tablet', setting: 60 });
  run(q, { secs: 10, cost: 22 });
  check('tablet with the 60 setting: never locked to 30', !q.stats.locked30 && q.cap(10000) === 60);
}

let failed = 0;
console.log('\n=== frame pacing (caps, idle / overlay / parked rates, cadence, tablet fallback) ' + '='.repeat(26));
for (const r of rows) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(86)} ${r.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
