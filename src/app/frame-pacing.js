// Frame pacing (render agent): how often the loop in main.js simulates and draws, per device class and game state.
//
// Why: the loop used to run everything at the display's refresh rate in every state: 60 Hz (90–120 Hz on Android and
// ProMotion screens) in flight, and also behind the menu, the loading screen, the pause screen and the mission cards.
// Phones heat up and drain; nothing is gained by drawing a scene nobody sees. Rates (frames per second, 0 = no draw):
//
//   tab hidden, menu (no world yet), error / graphics notice          0
//   loading screen                                                     0 (streaming keeps going every frame; the pre-warm
//                                                                        frame draws at once). Drawing the half-built
//                                                                        world there compiled the sky, clouds and fog bank
//                                                                        before the aircraft's lights existed: programs
//                                                                        thrown away when the light count changed.
//   pause, mission briefing / results card                             5 draws, 15 simulation steps (world streaming
//                                                                        has per-step budgets); the full rate for a
//                                                                        moment after a touch, drag, wheel or key (the
//                                                                        camera can be moved there)
//   big map open (the flight goes on underneath)                       draw 5, simulate at the flight rate
//   parked on the ground with nothing moving (no input, still camera,  phones / tablets 20, desktop 30
//     no rotor turning) for 4 s
//   flight                                                             the cap: phones 30, tablets 60 (30 when 60 cannot
//                                                                        be held), desktop the display rate; the player's
//                                                                        setting (settings.fps: 30 | 60 | 0 = no limit)
//
// Frame skipping keeps the cadence regular: rAF still fires every refresh (cheap), and a frame is drawn on the first
// refresh within half a refresh of its ideal time (a phase accumulator: 60 Hz → every 2nd refresh for 30 fps, 90 Hz →
// every 3rd, 120 Hz → every 4th; 144 Hz → 2/3/2/3 for 60 fps, never faster than the target on average). The simulation
// gets the real time since its last step, so motion speed never depends on the rate. A device that cannot reach the
// cap draws on every refresh it gets (the phase restarts instead of catching up with short frames).
// ?pace=0 turns all of this off (every refresh simulates and draws, the old behaviour; A/B measurements), ?fps=30|60|0
// overrides the flight cap.

export const PACE = {
  loading: 0,
  overlay: 5,
  overlaySim: 15,
  parked: { phone: 20, tablet: 20, desktop: 30 },
  interactMs: 1200,        // full rate this long after an interaction in an overlay
  parkedAfterMs: 4000,     // parked mode after this long without input / camera movement / aircraft movement
  // tablets on 'auto': 60, or 30 when 60 is not held (below 50 fps for 3 s of flight); 60 is tried again after a backoff
  tabletLowFps: 50, tabletLowSecs: 3, backoffSecs: [30, 60, 120, 300],
};

/** Normalized fps setting: null ('auto') | 30 | 60 | 0 (no limit). */
export function parseFpsSetting(v) {
  if (v === null || v === undefined || v === '' || v === 'auto') return null;
  const n = Number(v);
  return n === 30 || n === 60 || n === 0 ? n : null;
}

/** Flight frame cap for a device class and the player's setting (0 = the display's rate). */
export function flightCap(deviceClass, setting) {
  const s = parseFpsSetting(setting);
  if (s !== null) return s;
  if (deviceClass === 'phone') return 30;
  if (deviceClass === 'tablet') return 60;
  return 0;
}

/**
 * createFramePacer({ deviceClass, setting, enabled })
 *   raf(ts)            once per rAF callback: returns the real time since the previous callback (s, clamped)
 *   decide(ts, mode, o) → { sim, draw }; mode: 'hidden' | 'idle' | 'loading' | 'overlay' | 'map' | 'parked' | 'flight';
 *                        o.interacting (overlay boost), o.warming (true: no draw; 'render': draw now)
 *   drawn(ts, mode, judge)  after a drawn frame: the tablet 60 → 30 fallback (judge = false: start-up seconds, ignored)
 *   setSetting(v)      player's fps setting changed
 *   stats              { mode, target, drawFps, simFps, vsync, cap, locked30 } (test hook / telemetry)
 */
export function createFramePacer({ deviceClass = 'desktop', setting = null, enabled = true } = {}) {
  let userSetting = parseFpsSetting(setting);
  let vsync = 1000 / 60;
  const deltas = new Float32Array(32);
  let nDeltas = 0, lastTs = -1, stalled = false;
  const D = { next: -1e9, last: -1e9 }, S = { next: -1e9, last: -1e9 };   // ideal time of the next / last draw, simulation step
  // tablet 'auto' adaptation
  let lowFor = 0, lockUntil = 0, lockCount = 0, winT = 0, winFrames = 0, winStart = -1, winGap = 0, lastDrawTs = 0;
  const stats = { mode: 'idle', target: 0, drawFps: 0, simFps: 0, vsync: 16.7, cap: 0, locked30: false, draws: 0, sims: 0 };
  let secT = -1, secDraws = 0, secSims = 0;

  const displayFps = () => 1000 / vsync;
  function cap(ts) {
    const c = flightCap(deviceClass, userSetting);
    if (deviceClass === 'tablet' && userSetting === null && ts < lockUntil) return 30;
    return c;
  }
  /** Draw (or simulate) on this refresh for a target rate? Advances the stream's phase when it does. */
  function due(ts, st, fps) {
    if (!(fps > 0)) return fps === 0;   // 0 = every refresh (no cap); negative / NaN = never
    if (fps >= displayFps() - 0.5) { st.next = st.last = ts; return true; }
    const interval = 1000 / fps, half = vsync * 0.5;
    // (or a full interval since the last one, less a quarter refresh: a display whose refresh wanders against the ideal
    // phase must not skip one refresh too many)
    if (ts < st.next - half && ts - st.last < interval - vsync * 0.25) return false;
    st.next = ts > st.next + half ? ts + interval : st.next + interval;
    st.last = ts;
    return true;
  }
  function targets(ts, mode, o) {
    const c = cap(ts);
    switch (mode) {
      case 'hidden': case 'idle': return [-1, -1];
      case 'loading': return [0, o.warming === true || !(PACE.loading > 0) ? -1 : PACE.loading];
      case 'overlay': return o.interacting ? [c, c] : [c > 0 ? Math.min(c, PACE.overlaySim) : PACE.overlaySim, PACE.overlay];
      case 'map': return [c, PACE.overlay];
      case 'parked': { const p = PACE.parked[deviceClass] || PACE.parked.desktop; return c > 0 && c < p ? [c, c] : [p, p]; }
      default: return [c, c];
    }
  }

  return {
    stats,
    get enabled() { return enabled; },
    raf(ts) {
      let dt = 0;
      // a timestamp that does not advance never happens in a browser; test harnesses that freeze time (tools/perf probe
      // virtual clock) do it, and expect every callback to draw as before: pacing steps aside then
      stalled = lastTs >= 0 && ts === lastTs;
      if (lastTs >= 0) {
        dt = ts - lastTs;
        if (dt > 2 && dt < 70) {   // refresh interval estimate: 25th percentile of recent callback intervals
          deltas[nDeltas++ % deltas.length] = dt;
          const n = Math.min(nDeltas, deltas.length);
          if (n >= 8 && (nDeltas & 7) === 0) {
            const s = Array.from(deltas.subarray(0, n)).sort((a, b) => a - b);
            vsync = s[Math.floor(n * 0.25)];
            stats.vsync = Math.round(vsync * 10) / 10;
          }
        }
      }
      lastTs = ts;
      return Math.min(Math.max(dt, 0), 1000) / 1000;
    },
    decide(ts, mode, o = {}) {
      stats.mode = mode;
      if (!enabled) { stats.target = 0; return { sim: mode !== 'hidden', draw: mode !== 'hidden' && !(mode === 'loading' && o.warming === true) }; }
      if (o.warming === 'render' || (stalled && mode !== 'hidden' && mode !== 'idle' && mode !== 'loading')) return { sim: true, draw: true };
      const [simFps, drawFps] = targets(ts, mode, o);
      stats.target = drawFps; stats.cap = cap(ts); stats.locked30 = ts < lockUntil;
      const draw = due(ts, D, drawFps);
      const sim = simFps === drawFps ? draw : due(ts, S, simFps) || draw;
      if (sim) secSims++;
      if (draw) { secDraws++; stats.draws++; }
      if (secT < 0) secT = ts;
      if (ts - secT >= 1000) { stats.drawFps = Math.round(secDraws * 10000 / (ts - secT)) / 10; stats.simFps = Math.round(secSims * 10000 / (ts - secT)) / 10; secT = ts; secDraws = secSims = 0; }
      return { sim, draw };
    },
    /** After a drawn flight frame: tablets on 'auto' drop to 30 fps when 60 is not held, and try 60 again later. */
    drawn(ts, mode, judge = true) {
      if (!enabled || deviceClass !== 'tablet' || userSetting !== null || mode !== 'flight' || ts < lockUntil || !judge) { winStart = -1; return; }
      if (winStart < 0) { winStart = lastDrawTs = ts; winFrames = 0; winGap = 0; return; }
      winFrames++;
      winGap = Math.max(winGap, ts - lastDrawTs);
      lastDrawTs = ts;
      winT = ts - winStart;
      if (winT < 1000) return;
      const fps = (winFrames * 1000) / winT, hitch = winGap > 100;
      winStart = ts; winFrames = 0; winGap = 0;
      if (hitch) return;   // a streaming / shader-compile hitch is not a rate the tablet cannot hold
      lowFor = fps < PACE.tabletLowFps ? lowFor + winT / 1000 : 0;
      if (lowFor >= PACE.tabletLowSecs) {
        lowFor = 0;
        lockUntil = ts + 1000 * PACE.backoffSecs[Math.min(lockCount, PACE.backoffSecs.length - 1)];
        lockCount++;
      }
    },
    setSetting(v) { userSetting = parseFpsSetting(v); lockUntil = 0; lowFor = 0; },
    /** The flight cap now (0 = display rate). */
    cap,
    /** Drawn frames per second the current mode aims at (display rate when the target is 0). */
    targetFps(ts, mode, o = {}) { const t = targets(ts, mode, o)[1]; return t === 0 ? displayFps() : Math.max(t, 0); },
    get vsyncMs() { return vsync; },
    /** The last callback's timestamp did not advance (a frozen test clock). */
    get stalled() { return stalled; },
  };
}
