// Free-flight challenges on the live game (CONTRACTS-SF.md §12.1): the tracker (src/missions/challenges.js) fed from
// the flight every frame, the "Görevler" panel (src/ui/challenges-panel.js), markers and the screen pointer for the
// tracked entry, results with the leaderboard, progress (localStorage `gokyuzu.ffc`) and the `ffc` telemetry event.
// Lazily imported by src/app/main.js in free flight only, when the main thread is idle after the first playable frame
// (its own chunk in the production bundle). Never created in mission mode.
//
//   const ffc = createFreeFlightChallenges(ctx)
//   ffc.update(dt, { paused })   every frame (idle: the flight sample + a few distance checks; no allocation)
//   ffc.onCrash(flight)          main.js crash handler → true when a ditching was rated a success (no crash card)
//   ffc.onReset()                main.js resetFlight()
//   ffc.toggle()
// ctx = { state, scene, camera, hud, landing, touch, aircraft, leave(url), compile(object3d) → Promise, canToggle() }
import { createChallengeTracker, loadChallengeProgress, recordChallenge } from './challenges.js';
import { BRIDGES } from './catalog.js';
import { LANDING_BANDS } from './landing-score.js';
import { dirOf, fmtDist, fmtInt, FPM, KT } from './util.js';
import { runwayEnds } from '../flight/fixedwing-autopilot.js';
import { createMarkers } from '../world-sf/markers.js';
import { createChallengesPanel } from '../ui/challenges-panel.js';
import { shared } from '../ui/shared.js';
import { trackEvent } from '../core/telemetry.js';

const TELE_ID = { bridge: 'bridge', 'low-pass': 'lowpass', 'bay-tour': 'baytour', climb: 'climb', alcatraz: 'alcatraz', landing: 'land', eng: 'eng', flameout: 'flameout', ditch: 'ditch', autorot: 'autorot' };

export function createFreeFlightChallenges(ctx) {
  const { state, camera, hud, landing, touch = false } = ctx;
  const world = state.world;
  const f = state.flight;
  const spec = (state.def && state.def.spec) || f.spec || {};
  const cat = spec.category === 'fighter' || spec.category === 'helicopter' ? spec.category : 'airliner';
  const ac = ctx.aircraft || (state.def && state.def.id) || 'f16';
  const ends = runwayEnds(world.runways);
  const spanScratch = { bottom: -Infinity, top: -Infinity };
  const groundAt = (x, z) => { const h = world.getGroundHeight(x, z); return Number.isFinite(h) ? h : 0; };

  // flight sample (reused; the objectives read it) — the same fields the mission runtime fills
  const s = { t: 0, dt: 0, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, agl: 0, ias: 0, gs: 0, vs: 0, hdg: 0, pitch: 0, roll: 0, onGround: true, first: true };
  const lastAir = { vs: 0, pitch: 0, roll: 0, ias: 0, gear: 0, flaps: 0 };
  const session = [];
  let tracked = null, crashing = false, pendingSession = false, landingShown = false, dirty = true, uiT = 0, hudT = 0, distLabel = '';
  let sessionShown = 0;   // session results already shown in a crash view (a crash reopens it only for something new)
  let progress = loadChallengeProgress();
  const submitted = new Set();

  const tracker = createChallengeTracker({
    aircraft: ac, category: cat, ends, bridges: BRIDGES,
    spanAt: world.getObstacleSpan ? (x, z, out) => world.getObstacleSpan(x, z, out || spanScratch) : null,
    isOnRunway: (x, z) => (world.isOnRunway ? world.isOnRunway(x, z) : false),
    isWater: (x, z) => (world.isWater ? !!world.isWater(x, z) : false),
    hooks: {
      inject: (kind, opts) => (f.failures && f.failures.inject ? f.failures.inject(kind, opts) : false),
      clearFailure: (kind) => { if (f.failures && f.failures.clear && !f.crashed && !f.ditched) f.failures.clear(kind); },   // (a floating aircraft keeps its dead engines)
      suspendRandom: (on) => { if (f.failures && f.failures.random) f.failures.random.suspended = !!on; },
    },
    emit: onEvent,
  });
  const entries = tracker.entries;
  const byId = tracker.byId;

  // ---- panel ----
  const panel = createChallengesPanel(hud, {
    touch, keyLabel: 'Enter', keyCode: ['Enter', 'NumpadEnter'], canToggle: ctx.canToggle,
    onTrack: (id) => setTracked(id),
    onStart: (id) => startEmergency(id),
    onCancel: (id) => { tracker.cancel(id); dirty = true; },
    onPlay: (id) => playMission(id),
    onBoard: (id) => showBoard(id),
    onToggle: (open) => { dirty = true; if (open) updateCount(false); },
  });
  const views = entries.map((e) => ({
    id: e.id, title: e.def.title, hint: e.def.hint, group: e.def.group || '', emergency: e.def.kind === 'emergency',
    trackable: e.def.kind === 'bridge' || e.def.kind === 'gates' || e.def.kind === 'alcatraz',
    status: 'idle', done: false, stars: 0, sub: '', subWarn: false, tracked: false, canStart: null, autoSelect: false,
  }));
  panel.setEntries(views);
  updateCount();

  function updateCount(badge = false) {
    let done = 0;
    for (const e of entries) if (progress[e.id] && progress[e.id].done) done++;
    panel.setCount(done, entries.length, { badge, running: entries.some((e) => e.status === 'run') });
  }

  // ---- markers of the tracked entry (created on first use; programs compiled before they show) ----
  let markers = null, markersKey = '', compiled = false;
  function ensureMarkers() {
    if (markers) return markers;
    markers = createMarkers(ctx.scene);
    markers.group.visible = false;
    const done = () => { compiled = true; syncMarkers(true); };
    try { Promise.resolve(ctx.compile ? ctx.compile(markers.group) : null).then(done, done); } catch { done(); }
    return markers;
  }
  function syncMarkers(force = false) {
    const e = tracked ? byId[tracked] : null;
    const spec = e ? e.markers() : null;
    const key = spec ? `${e.id}|${spec.type}|${e.status}` : '';
    if (!force && key === markersKey) {
      if (spec && spec.type === 'gates' && markers) markers.setActiveGate(spec.index);
      return;
    }
    markersKey = key;
    if (!spec) { if (markers) { markers.clear(); markers.group.visible = false; } return; }
    const mk = ensureMarkers();
    mk.clear();
    if (spec.type === 'bridge') {
      const b = spec.bridge, ax = dirOf(b.axis);
      mk.setGates('frame', [{ x: b.x, y: 33, z: b.z, hw: b.half - 70, hh: 27, nx: -ax.dz, nz: ax.dx }]);
    } else if (spec.type === 'gates') {
      mk.setGates(spec.shape, spec.gates);
      mk.setActiveGate(spec.index);
    } else if (spec.type === 'pad') {
      const y = Math.max(spec.y, groundAt(spec.x, spec.z));
      mk.setPad({ x: spec.x, y: y + 0.15, z: spec.z, r: spec.r });
      mk.setBeacon({ x: spec.x, y, z: spec.z, h: 250, w: 2.5 });
    } else if (spec.type === 'runway') {
      const en = spec.end;
      if (spec.heli) mk.setBeacon({ x: en.aimX ?? en.x, y: Math.max(en.elevation || 0, groundAt(en.aimX ?? en.x, en.aimZ ?? en.z)), z: en.aimZ ?? en.z, h: 300, w: 3 });
      else {
        const B = LANDING_BANDS[cat === 'fighter' ? 'fighter' : 'airliner'];
        const mid = (B.tdzIdeal[0] + B.tdzIdeal[1]) / 2;
        const y = Math.max(en.elevation, groundAt(en.x + en.dx * mid, en.z + en.dz * mid)) + 0.3;
        mk.setRunwayBox({ x: en.x, z: en.z, y, course: en.course, from: B.tdzIdeal[0], to: B.tdzIdeal[1], width: en.width * 0.92 });
      }
    }
    mk.group.visible = compiled;
  }
  function setTracked(id, { auto = false } = {}) {
    tracked = id && byId[id] ? id : null;
    for (const v of views) { v.tracked = v.id === tracked; v.autoSelect = auto && v.tracked; }
    syncMarkers(true);
    if (!tracked) panel.pointer(null, null);
    dirty = true;
  }

  // ---- actions ----
  function startEmergency(id) {
    const r = tracker.start(id, s, f);
    if (!r.ok) { if (r.reason && hud) hud.showMessage(r.reason, 2200); dirty = true; return; }
    if (touch) panel.close();   // (desktop: the panel stays beside the view)
    dirty = true;
  }
  function playMission(id) {
    const e = byId[id];
    if (!e || !ctx.leave) return;
    const q = new URLSearchParams();
    q.set('mission', e.def.mission);
    ctx.leave(`${location.pathname}?${q}`);
  }
  function resultExtras(e, r, prog = null) {
    return {
      newBest: prog ? prog.newBest : false, prevBest: prog ? prog.prevBest : 0, best: progress[e.id] || null,
      submit: r.ok && !r.submitted ? { score: r.score, stars: r.stars, sec: r.time == null ? undefined : r.time, ac } : null,
      onPlay: () => playMission(e.id),
      onSubmitted: () => { r.submitted = true; submitted.add(e.id); },
    };
  }
  function showBoard(id) {
    const e = byId[id];
    if (!e) return;
    const best = progress[id];
    const r = { id, board: e.board, title: e.def.title, ac, ok: false, noRun: true };
    panel.showResult(r, {
      best, onPlay: () => playMission(id), onSubmitted: () => submitted.add(id),
      submit: best && best.done && !submitted.has(id) ? { score: best.best, stars: best.stars, ac: best.ac || ac } : null,
    });
  }

  // ---- tracker events ----
  function onEvent(type, e, data) {
    dirty = true;
    if (type === 'message') {
      if (!crashing && hud && (tracked === e.id || e.status === 'run')) hud.showMessage(data, 2200);
      return;
    }
    if (type === 'start') {
      trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: 'start', ac });
      if (e.def.objective && e.def.objective.profile && landing && landing.setProfile) landing.setProfile(e.def.objective.profile);
      // a run that just began is followed on screen (gates need their markers to be found)
      const cur = tracked ? byId[tracked] : null;
      if ((e.def.kind === 'gates' || e.def.kind === 'emergency') && (!cur || cur === e || cur.status !== 'run')) setTracked(e.id, { auto: true });
      else if (tracked === e.id) syncMarkers(true);
      updateCount();
      return;
    }
    if (type === 'abort') {
      if (e.def.objective && e.def.objective.profile && landing && landing.setProfile) landing.setProfile(null);
      if (hud && tracked === e.id && (data === 'time' || data === 'far')) hud.showMessage(`${e.def.title}: ${data === 'time' ? 'süre doldu' : 'yarıda kaldı'}`, 2200);
      if (tracked === e.id) syncMarkers(true);
      updateCount();
      return;
    }
    // done / fail
    const r = data;
    if (e.def.objective && e.def.objective.profile && landing && landing.setProfile) landing.setProfile(null);
    const prog = recordChallenge(e.id, { ok: r.ok, score: r.score, stars: r.stars, ac });
    progress = loadChallengeProgress();
    session.push(r);
    if (session.length > 20) session.shift();
    trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: r.ok ? 'done' : 'fail', score: r.ok ? r.score : undefined, stars: r.ok ? r.stars : undefined, ac,
      sec: r.time != null ? r.time.toFixed(1) : undefined });
    if (tracked === e.id) syncMarkers(true);
    updateCount(r.ok);
    if (crashing) return;   // the crash handler shows the flight's results
    if (e.def.kind === 'landing') {
      // every landing is scored by the landing card already: the result opens only for a new personal best (and never
      // on top of an emergency's result for the same landing)
      if (landingShown) { landingShown = false; return; }
      if (!prog.newBest) { if (hud) hud.showMessage(`İniş: ${fmtInt(r.score)} puan · en iyin ${fmtInt(prog.prevBest)}`, 2600); return; }
    }
    if (e.def.kind === 'emergency') landingShown = true;
    const x = resultExtras(e, r, prog);
    // touch: the compact card at the top centre says it (a tap opens the result + top 10); desktop: a toast, then the
    // panel opens beside the view with the result
    if (touch) { panel.notify(r, () => panel.showResult(r, x)); return; }
    if (hud) hud.showMessage(r.ok ? `✓ ${r.title}: ${fmtInt(r.score)} puan${prog.newBest && prog.prevBest > 0 ? ' · yeni rekor!' : ''}` : `${r.title}: ${r.reason || 'başarısız'}`, 2600);
    setTimeout(() => panel.showResult(r, x), r.ok ? 1200 : 600);
  }

  // ---- flight events ----
  if (landing && landing.onResult) landing.onResult((card, td) => { if (!f.crashed) { tracker.onLanding(card, td); landingShown = false; } });
  if (f.on) {
    f.on('ditch', (i) => {
      const d = ditchSample();
      if (i) {
        if (Number.isFinite(i.verticalSpeed)) d.fpm = Math.max(0, -i.verticalSpeed * FPM);
        if (Number.isFinite(i.pitch)) d.pitch = i.pitch;
        if (Number.isFinite(i.roll)) d.roll = i.roll;
        if (Number.isFinite(i.ias)) d.kt = i.ias / KT;
      }
      d.gear = 0; d.survived = true;
      tracker.onDitch(d);
    });
  }
  function ditchSample() {
    return { fpm: Math.max(0, -lastAir.vs * FPM), pitch: lastAir.pitch, roll: lastAir.roll, kt: lastAir.ias / KT, gear: lastAir.gear, flaps: lastAir.flaps };
  }

  function showSession() {
    const last = session[session.length - 1];
    if (!last) return;
    const e = byId[last.id];
    sessionShown = session.length;
    panel.showResult(last, { ...resultExtras(e, last), crash: true, session: session.slice() });
  }

  // ---- the object main.js drives ----
  const api = {
    tracker, panel, entries, session,
    get tracked() { return tracked; },
    toggle() { panel.toggle(); },
    track: (id) => setTracked(id),
    /** main.js crash handler: running runs fail; the flight's results show beside the crash card (touch: after the reset). */
    onCrash(flight) {
      const before = session.length;
      crashing = true;
      const d = { ...ditchSample(), survived: 'ditched' in flight ? false : undefined };
      let claimed = false;
      try { claimed = tracker.onCrash(flight.crashReason ? `Kaza: ${flight.crashReason}` : 'Kaza', d); } finally { crashing = false; }
      if (claimed) {
        if (hud) hud.showMessage('Suya iniş başarılı!', 2600);
        const r = session[session.length - 1];
        if (r) { const x = resultExtras(byId[r.id], r); if (touch) panel.notify(r, () => panel.showResult(r, x)); else panel.showResult(r, x); }
        return true;
      }
      // a run failed now, or results came in since the last crash view: the flight's results + top 10 of the last one
      if (session.length > sessionShown) { if (touch) pendingSession = true; else showSession(); }
      if (session.length > before) dirty = true;
      return false;
    },
    onReset() {
      tracker.onReset();
      s.first = true;
      if (landing && landing.setProfile) landing.setProfile(null);
      if (pendingSession) { pendingSession = false; showSession(); }
      dirty = true;
    },
    update(dt, { paused = false } = {}) {
      if (paused) return;
      const p = f.position, v = f.velocity;
      s.px = s.x; s.py = s.y; s.pz = s.z;
      s.x = p.x; s.y = p.y; s.z = p.z;
      // a jump (reset, reposition) is not a flight path: no gate / bridge crossing between the two positions
      const jx = s.x - s.px, jz = s.z - s.pz, jy = s.y - s.py;
      if (jx * jx + jz * jz + jy * jy > 250 * 250) s.first = true;
      s.dt = dt; s.t += dt;
      s.agl = Number(f.agl) || 0; s.ias = Number.isFinite(f.ias) ? f.ias : Number(f.airspeed) || 0;
      s.gs = v ? Math.hypot(v.x, v.z) : 0; s.vs = Number(f.verticalSpeed) || 0;
      s.hdg = Number(f.heading) || 0; s.pitch = Number(f.pitch) || 0; s.roll = Number(f.roll) || 0; s.onGround = !!f.onGround;
      if (!f.crashed) {
        lastAir.vs = s.vs; lastAir.pitch = s.pitch; lastAir.roll = s.roll; lastAir.ias = s.ias; lastAir.gear = Number(f.gear) || 0; lastAir.flaps = Number(f.flaps) || 0;
        tracker.update(s);
      }
      s.first = false;
      // tracked entry: markers + pointer (only while something is tracked)
      const te = tracked ? byId[tracked] : null;
      const tg = te && !f.crashed ? te.target : null;
      if (te) {
        if (markers && markers.group.visible) markers.update(dt, camera);
        panel.pointer(camera, tg, distLabel);
      }
      if ((uiT -= dt) > 0 && !dirty) return;
      uiT = 0.1;
      if (te) {
        syncMarkers();
        distLabel = tg ? fmtDist(Math.hypot(tg.x - s.x, tg.z - s.z)) : '';
      }
      if ((hudT -= 0.1) <= 0) { hudT = 0.5; panel.setVisible(shared.hudVisible !== false); }
      if (panel.isOpen || dirty) renderViews();
      dirty = false;
    },
    debug() {
      return { tracked, t: +s.t.toFixed(1), entries: entries.map((e) => ({ id: e.id, status: e.status, runs: e.runs })), session: session.map((r) => ({ id: r.id, ok: r.ok, score: r.score, stars: r.stars, reason: r.reason })),
        markers: markers ? { visible: markers.group.visible, key: markersKey } : null, panel: panel.debug() };
    },
  };

  /** Row view models from the tracker, progress and the flight (≤ 10 Hz, only while the panel is open or after a change). */
  function renderViews() {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], v = views[i];
      const pr = progress[e.id];
      v.status = e.status; v.done = !!(pr && pr.done); v.stars = pr ? pr.stars || 0 : 0;
      v.subWarn = false;
      if (v.emergency) v.canStart = tracker.canStart(e.id, s, f);
      if (e.status === 'run' || e.status === 'armed') v.sub = e.progress(s) || 'Sürüyor';
      else if (v.emergency) { const c = v.canStart; v.sub = c.ok ? (pr && pr.done ? `Hazır · en iyin ${fmtInt(pr.best)}` : 'Hazır: Başlat ile arızayı şimdi başlat') : c.reason; v.subWarn = !c.ok; }
      else if (v.tracked && distLabel) v.sub = `Hedef ${distLabel}${e.progress(s) ? ` · ${e.progress(s)}` : ''}`;
      else if (e.progress(s)) v.sub = e.progress(s);
      else if (pr && pr.done) v.sub = `En iyin ${fmtInt(pr.best)} puan`;
      else v.sub = v.trackable ? (touch ? 'Henüz yok · takip için dokun' : 'Henüz yok · takip için tıkla') : 'Henüz yok';
    }
    panel.render(views);
    for (const v of views) v.autoSelect = false;
  }

  return api;
}
