// Free-flight challenges on the live game (CONTRACTS-SF.md §12.1): the tracker (src/missions/challenges.js) fed from
// the flight every frame, the "Görevler" panel (src/ui/challenges-panel.js), markers and the screen pointer for the
// tracked entry, results with the leaderboard, progress (localStorage `gokyuzu.ffc`) and the `ffc` telemetry event.
// Lazily imported by src/app/main.js in free flight only, when the main thread is idle after the first playable frame
// (its own chunk in the production bundle). Never created in mission mode.
// Telemetry (CONTRACTS-SF.md §11): `ffc` = the challenges (start | done | fail | cancel | drop), `ffp` = the panel UI
// (open with src, track / untrack, play, final) — separate types so panel clicks can never use up the `ffc` event cap.
// Retention (src/retention/**): the landing challenges of every map (İniş serisi, Günün inişi: src/missions/
// landing-challenges.js) with "Son yaklaşmaya git" (a reposition onto the 3° glide path of the day's / the nearest runway),
// the daily streak (a landing, 2 minutes in the air or a finished challenge joins today), the landing streak badge, the
// weekly challenge's board (a finished run of this week's free-flight pick is also submitted to w-<yyyyww>-<board>), the
// menu's intent (shared.retentionIntent = { track, final }: follow a challenge right away) and, on phones after a
// 2-star landing, the "Ana ekrana ekle" suggestion (src/retention/install.js). Landings with assisted flight or on the
// autopilot go to the "Destekli" list of each board (src/retention/boards.js), never to the manual one. One landing can
// finish several challenges:
// the most important result shows (emergency › series › daily landing › pad › best landing) with the others, the streak
// and a new badge listed in it ("Bu inişte"); the others are submitted quietly. Nothing stacks over a result: the landing
// card hides while it is open (src/retention/result-flag.js, <html class="gk-result-open">).
//
//   const set = await loadChallengeSet(map)   the map's challenges + mission catalog (null: none, no panel)
//   const ffc = createFreeFlightChallenges(ctx)
//   ffc.update(dt, { paused })   every frame (idle: the flight sample + a few distance checks; no allocation)
//   ffc.onCrash(flight)          main.js crash handler → true when a ditching was rated a success (no crash card)
//   ffc.onReset()                main.js resetFlight()
//   ffc.toggle()
// ctx = { state, scene, camera, hud, landing, touch, aircraft, set, leave(url), compile(object3d) → Promise, canToggle() }
import { createChallengeTracker, loadChallengeProgress, recordChallenge, loadChallengeSet, CHALLENGES } from './challenges.js';

export { loadChallengeSet };
import { LANDING_BANDS } from './landing-score.js';
import { dirOf, fmtDist, fmtInt, FPM, KT, resolveStart } from './util.js';
import { landingChallenges, endLabel } from './landing-challenges.js';
import { noteActivity, noteLanding, applyAccent, streakLine } from '../retention/activity.js';
import { weeklyFor } from '../retention/weekly.js';
import { submitQuiet } from '../retention/lb.js';
import { boardFor } from '../retention/boards.js';
import { suggestInstall } from '../retention/install.js';
import { resultOpen } from '../retention/result-flag.js';
import { runwayEnds } from '../flight/fixedwing-autopilot.js';
import { createMarkers } from '../world-sf/markers.js';
import { createChallengesPanel } from '../ui/challenges-panel.js';
import { shared } from '../ui/shared.js';
import { trackEvent } from '../core/telemetry.js';

const TELE_ID = { bridge: 'bridge', 'low-pass': 'lowpass', 'bay-tour': 'baytour', climb: 'climb', alcatraz: 'alcatraz', landing: 'land', eng: 'eng', flameout: 'flameout', ditch: 'ditch', autorot: 'autorot',
  'land-series': 'lseries', 'daily-land': 'dland', 'ist-land-series': 'lseries', 'ist-daily-land': 'dland' };   // (other maps: `mp` tells them apart)
const AIR_DAY_S = 120;   // s in the air that make a flight "finished" for the daily streak (without a landing)
// which result of one landing shows (lower first); the others are toasts and quiet submissions
const SHOW_ORDER = { emergency: 0, series: 1, 'daily-land': 2, alcatraz: 3, landing: 4 };

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
  let tracked = null, crashing = false, pendingSession = false, dirty = true, uiT = 0, hudT = 0, distLabel = '';
  let sessionShown = 0;   // session results already shown in a crash view (a crash reopens it only for something new)
  const set = ctx.set || { map: 'sf' };   // (loadChallengeSet)
  let progress = loadChallengeProgress(set.map);
  const submitted = new Set();
  applyAccent();   // retention: the picked badge's HUD accent
  // progress key: a daily challenge keeps its best per day (id@YYYYMMDD)
  const pkey = (e) => (e.def.daily ? `${e.id}@${e.day}` : e.id);
  let batch = null, batchNotes = null, airT = 0, airNoted = false;   // (batch / batchNotes: one landing's results and messages, see flushBatch)

  // the landing challenges join the map's list after its best-landing entry (before the emergencies)
  const baseList = set.challenges || CHALLENGES;
  let at = baseList.findIndex((c) => c.kind === 'landing');
  at = at >= 0 ? at + 1 : baseList.findIndex((c) => c.group === 'emergency');
  if (at < 0) at = baseList.length;
  const challengeList = [...baseList.slice(0, at), ...landingChallenges(set.map), ...baseList.slice(at)];

  const tracker = (set.tracker || createChallengeTracker)({
    aircraft: ac, category: cat, ends, challenges: challengeList, catalog: set.catalog, map: set.map,
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
    onTrack: (id) => { const prev = tracked; setTracked(id); if (id) trackEvent('ffp', { st: 'track', id: TELE_ID[id] || id }); else if (prev) trackEvent('ffp', { st: 'untrack', id: TELE_ID[prev] || prev }); },
    onStart: (id) => startEmergency(id),
    onCancel: (id) => { tracker.cancel(id); dirty = true; },
    onPlay: (id) => playMission(id),
    onBoard: (id) => showBoard(id),
    onFinal: (id) => goFinal(id),
    onToggle: (open, src) => { dirty = true; if (open) { updateCount(false); trackEvent('ffp', { st: 'open', src }); } },
  });
  const views = entries.map((e) => ({
    id: e.id, title: e.def.title, hint: e.def.hint, group: e.def.group || '', emergency: e.def.kind === 'emergency', final: !!e.def.final,
    trackable: e.def.trackable ?? (e.def.kind === 'bridge' || e.def.kind === 'gates' || e.def.kind === 'alcatraz'),
    status: 'idle', done: false, stars: 0, sub: '', subWarn: false, tracked: false, canStart: null, autoSelect: false,
  }));
  panel.setEntries(views);
  updateCount();

  function updateCount(badge = false) {
    let done = 0;
    for (const e of entries) if (progress[pkey(e)] && progress[pkey(e)].done) done++;
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
  let gateX = NaN, gateZ = NaN;   // first gate's position: an orbit's rings move when the circle starts elsewhere
  function syncMarkers(force = false) {
    const e = tracked ? byId[tracked] : null;
    const spec = e ? e.markers() : null;
    const key = spec ? `${e.id}|${spec.type}|${e.status}` : '';
    const g0 = spec && spec.type === 'gates' ? spec.gates[0] : null;
    if (g0 && (g0.x !== gateX || g0.z !== gateZ)) { gateX = g0.x; gateZ = g0.z; force = true; }
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
    trackEvent('ffp', { st: 'play', id: TELE_ID[id] || id });
    const q = new URLSearchParams();
    q.set('mission', e.def.mission);
    q.set('from', 'ff');   // the mission's `brief` event reports via=ff
    const tel = new URLSearchParams(location.search).get('telemetry');
    if (tel) q.set('telemetry', tel);   // an explicit opt-out (or a test's opt-in) carries over
    ctx.leave(`${location.pathname}?${q}`);
  }
  function resultExtras(e, r, prog = null) {
    return {
      newBest: prog ? prog.newBest : false, prevBest: prog ? prog.prevBest : 0, best: progress[pkey(e)] || null,
      submit: r.ok && !r.submitted ? { score: r.score, stars: r.stars, sec: r.time == null ? undefined : r.time, ac, assisted: !!r.assisted } : null,
      onPlay: () => playMission(e.id),
      onSubmitted: () => { r.submitted = true; submitted.add(pkey(e)); },
      weekly: r.weekly || null,
    };
  }
  function showBoard(id) {
    const e = byId[id];
    if (!e) return;
    const best = progress[pkey(e)];
    const r = { id, board: e.board, title: e.def.title, ac, ok: false, noRun: true, day: e.def.daily ? e.day : undefined };
    panel.showResult(r, {
      best, onPlay: () => playMission(id), onSubmitted: () => submitted.add(pkey(e)),
      submit: best && best.done && !submitted.has(pkey(e)) ? { score: best.best, stars: best.stars, ac: best.ac || ac, assisted: !!best.as } : null,
    });
  }
  /**
   * How far out a final approach can start: the longest of the usual distances whose 3° path (aimed 300 m past the
   * threshold, as src/missions/util.js resolveStart) stays 25 m over the terrain and the obstacles all the way in; 0: none.
   */
  function finalDist(end, heli) {
    const T = Math.tan(3 * Math.PI / 180);
    const top = (x, z) => { const o = world.getObstacleHeight ? world.getObstacleHeight(x, z) : -Infinity; return Math.max(groundAt(x, z), Number.isFinite(o) ? o : -Infinity); };
    for (const D of heli ? [1500, 1000] : cat === 'fighter' ? [7000, 4500, 3000, 2000] : [6000, 4500, 3000, 2000]) {
      let ok = true;
      for (let d = D; d >= 400 && ok; d -= 150) ok = (end.elevation || 0) + (d + 300) * T - top(end.x - end.dx * d, end.z - end.dz * d) >= 25;
      if (ok) return D;
    }
    return 0;
  }
  /** "Son yaklaşmaya git": onto the 3° glide path of the day's runway (Günün inişi) or the nearest runway (İniş serisi). */
  function goFinal(id) {
    const e = byId[id];
    if (!e || !f.reset) return;
    if (f.crashed || f.ditched) { if (hud) hud.showMessage('Önce yeniden başla (R)', 2000); return; }
    if (entries.some((x) => x.def.kind === 'emergency' && x.status === 'run')) { if (hud) hud.showMessage('Önce süren acil durumu bitir', 2000); return; }
    const heli = cat === 'helicopter';
    let end = e.targetEnd || null, dist = end ? finalDist(end, heli) : 0;
    if (!end) {   // İniş serisi: the nearest runway whose final is clear of the terrain
      let best = Infinity;
      for (const x of ends) {
        if (x.landing === false || (!heli && (x.length || 0) < 1800)) continue;
        const d = Math.hypot((x.aimX ?? x.x) - s.x, (x.aimZ ?? x.z) - s.z);
        if (d >= best) continue;
        const fd = finalDist(x, heli);
        if (fd) { best = d; end = x; dist = fd; }
      }
    }
    if (!end || !dist) { if (hud) hud.showMessage('Bu pistin son yaklaşması arazi yüzünden kapalı', 2400); return; }
    let st;
    try { st = resolveStart({ final: end.name, dist }, ends); } catch { return; }
    tracker.onReset();   // (timed runs end; the landing series goes on)
    f.reset({ x: st.x, z: st.z, heading: st.heading, altitude: st.altitude, speed: heli ? 25 : undefined }, world);
    const inp = state.input;
    if (inp && inp.setThrottle) inp.setThrottle(f.throttle ?? 0);   // the lever follows the trimmed approach thrust
    if (landing && landing.reset) landing.reset();
    s.first = true;
    trackEvent('ffp', { st: 'final', id: TELE_ID[id] || id });
    if (touch) panel.close();
    if (hud) hud.showMessage(`${e.def.title}: ${endLabel(end.name)} son yaklaşması${heli ? '' : ' · takım ve flaplar açık'}`, 2600);
    dirty = true;
  }

  // ---- tracker events ----
  function onEvent(type, e, data) {
    dirty = true;
    if (type === 'message') {
      if (!crashing && hud && (tracked === e.id || e.status === 'run')) { if (batchNotes) batchNotes.push(data); else hud.showMessage(data, 2200); }
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
      // "Vazgeç" on an emergency / a timed run abandoned (time limit, too far, landed before 10,000 ft) / a landing series
      // broken; a flight reset and a rejected take-off (the climb re-arms) are not reported
      const sec = Math.max(0, s.t - e.t0).toFixed(1);
      if (data === 'cancel') trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: 'cancel', ac, sec });
      else if (data === 'time' || data === 'gap' || data === 'far' || data === 'landed') trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: 'drop', why: data, ac, sec });
      else if (data === 'broken') trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: 'drop', why: 'broken', ac });
      if (hud && tracked === e.id && (data === 'time' || data === 'gap' || data === 'far')) hud.showMessage(`${e.def.title}: ${data === 'time' ? 'süre doldu' : 'yarıda kaldı'}`, 2200);
      if (tracked === e.id) syncMarkers(true);
      updateCount();
      return;
    }
    // done / fail
    const r = data;
    if (e.def.objective && e.def.objective.profile && landing && landing.setProfile) landing.setProfile(null);
    const prog = recordChallenge(pkey(e), { ok: r.ok, score: r.score, stars: r.stars, ac, assisted: !!r.assisted }, set.map);
    progress = loadChallengeProgress(set.map);
    session.push(r);
    if (session.length > 20) session.shift();
    trackEvent('ffc', { id: TELE_ID[e.id] || e.id, st: r.ok ? 'done' : 'fail', score: r.ok ? r.score : undefined, stars: r.ok ? r.stars : undefined, ac,
      sec: r.time != null ? r.time.toFixed(1) : undefined, as: r.assisted ? 1 : undefined });
    if (tracked === e.id) syncMarkers(true);
    updateCount(r.ok);
    if (r.ok) {   // retention: the day joins the streak; this week's free-flight pick also goes to its weekly board
      const st = noteActivity('ffc');
      if (st && st.newDay) streakToast(st);
      // (the week the run started in: one begun on Sunday evening and finished after Monday 00:00 still counts for it;
      // an assisted result: the weekly board's "Destekli" list)
      const wk = weeklyFor({ ff: e.id }, new Date(Date.now() - 1000 * (Number.isFinite(r.time) ? r.time : 0)));
      if (wk) r.weekly = { pick: wk, p: submitQuiet({ board: boardFor(wk.board, r.assisted), score: r.score, stars: r.stars, sec: r.time == null ? undefined : r.time, ac, weekly: wk.key, assisted: !!r.assisted }) };
    }
    if (crashing) return;   // the crash handler shows the flight's results
    if (batch) { batch.push({ e, r, prog }); return; }   // a landing's results: flushBatch() picks the one to show
    if (opens({ e, r, prog })) present(e, r, prog); else if (hud) hud.showMessage(toastText({ e, r, prog }), 2600);
  }
  /** One landing's results: the most important shows, the others are toasts (a new best is submitted quietly). */
  /**
   * One landing's results and notes (other results, "İniş serisi: 2/3", the streak, a new badge): the most important
   * result that opens shows with the rest folded into it under "Bu inişte" (nothing stacks over it); without one, the
   * lines are toasts, on phones only after the landing card (top centre, 7 s) has faded. New bests of the results that
   * did not open are submitted quietly.
   */
  const opens = (x) => !x.r.ok || !(x.e.def.kind === 'landing' || x.e.def.kind === 'daily-land') || x.prog.newBest;   // (a landing's own result: only a new best)
  function flushBatch(list, notes = []) {
    list.sort((a, b) => (SHOW_ORDER[a.e.def.kind] ?? 9) - (SHOW_ORDER[b.e.def.kind] ?? 9));
    const primary = list.find(opens) || null;
    const lines = [...list.filter((x) => x !== primary).map(toastText), ...notes].filter(Boolean);
    // (a result still open from an earlier landing goes back to the list: this landing's card must not hide behind it)
    if (!primary && panel.view === 'result') panel.showList();
    if (primary) present(primary.e, primary.r, primary.prog, lines);
    else if (hud) lines.forEach((t, i) => setTimeout(() => { if (!crashing) hud.showMessage(t, 2600); }, (touch ? 7500 : 0) + 2800 * i));
    for (const x of list) {
      if (x === primary) continue;
      const worth = x.r.ok && (x.prog.newBest || x.e.def.kind === 'series');
      if (worth && !x.r.submitted) {
        x.r.submitted = true; submitted.add(pkey(x.e));
        submitQuiet({ board: boardFor(x.e.board, x.r.assisted), day: x.r.day || '', score: x.r.score, stars: x.r.stars, sec: x.r.time == null ? undefined : x.r.time, ac, assisted: !!x.r.assisted });
      }
    }
  }
  function toastText({ e, r, prog }) {
    if (!r.ok) return `${r.title}: ${r.reason || 'başarısız'}`;
    const best = e.def.daily ? 'bugünkü en iyin' : 'en iyin';
    return `${e.def.kind === 'landing' ? 'İniş' : r.title}: ${fmtInt(r.score)} puan${prog.newBest && prog.prevBest > 0 ? ' · yeni rekor!' : prog.prevBest > 0 && !prog.newBest ? ` · ${best} ${fmtInt(prog.prevBest)}` : ''}`;
  }
  function streakToast(st) {
    if (batchNotes) { batchNotes.push(streakLine(st)); return; }   // (a landing: folded into its result)
    if (hud) setTimeout(() => { if (!crashing) hud.showMessage(streakLine(st), 3200); }, 3000);
  }
  function present(e, r, prog, notes = []) {
    const x = resultExtras(e, r, prog);
    x.notes = notes;
    // touch: the compact card at the top centre says it (a tap opens the result + top 10); desktop: a toast, then the
    // panel opens beside the view with the result
    if (touch) { panel.notify(r, () => panel.showResult(r, x)); return; }
    if (hud) hud.showMessage(r.ok ? `✓ ${r.title}: ${fmtInt(r.score)} puan${prog.newBest && prog.prevBest > 0 ? ' · yeni rekor!' : ''}` : `${r.title}: ${r.reason || 'başarısız'}`, 2600);
    setTimeout(() => panel.showResult(r, x), r.ok ? 1200 : 600);
  }

  // ---- flight events ----
  if (landing && landing.onResult) {
    landing.onResult((card0, td) => {
      if (f.crashed) return;
      // a landing with assisted flight (src/ui/landing.js card.assisted) or on the autopilot (autoland): the challenges and
      // the streak as any landing; its leaderboard entries go to the "Destekli" lists
      const card = card0 && !card0.assisted && apAtTouchdown ? { ...card0, assisted: true } : card0;
      const list = batch = [], notes = batchNotes = [];
      try {
        tracker.onLanding(card, td);
        // retention: a landing finishes a flight (streak); runway landings in a row (badge)
        const lr = noteLanding(!!(card && card.onRunway && card.stars >= 1));
        const st = noteActivity('landing');
        if (st && st.newDay) streakToast(st);
        for (const b of (lr && lr.unlocked) || []) notes.push(`Yeni rozet: ${b.title}`);
      } finally { batch = null; batchNotes = null; }
      flushBatch(list, notes);
      // phones: after a good landing, the home-screen suggestion once the landing card has faded and no result is open
      if (touch && card && card.stars >= 2) {
        let tries = 0;
        const later = () => { if (f.crashed || tries++ > 12) return; if (resultOpen()) { setTimeout(later, 2500); return; } suggestInstall({ via: 'land', mount: (n) => panel.root.appendChild(n) }); };
        setTimeout(later, 9500);
      }
    });
  }
  let apAtTouchdown = false;   // the autopilot at the (first) contact of the landing being rated: an autoland
  if (f.on) {
    f.on('touchdown', () => {   // (the landing card may have seen this contact first: then it is pending with no bounce yet)
      const p = landing && landing.debug ? landing.debug().pending : null;
      if (!p || p.bounces === 0) apAtTouchdown = !!(f.autopilot && f.autopilot.on);
    });
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
      noteLanding(false);   // retention: a crash ends the landing streak
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
        // retention: 2 minutes in the air finish a flight for the daily streak (once per page)
        if (!airNoted && !s.onGround && (airT += dt) >= AIR_DAY_S) { airNoted = true; const st = noteActivity('air'); if (st && st.newDay) streakToast(st); }
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
      const pr = progress[pkey(e)];
      v.status = e.status; v.done = !!(pr && pr.done); v.stars = pr ? pr.stars || 0 : 0;
      v.subWarn = false;
      if (v.emergency) v.canStart = tracker.canStart(e.id, s, f);
      if (e.status === 'run' || e.status === 'armed') v.sub = e.progress(s) || 'Sürüyor';
      else if (v.emergency) { const c = v.canStart; v.sub = c.ok ? (pr && pr.done ? `Hazır · en iyin ${fmtInt(pr.best)}` : 'Hazır: Başlat ile arızayı şimdi başlat') : c.reason; v.subWarn = !c.ok; }
      else if (v.tracked && distLabel) v.sub = `Hedef ${distLabel}${e.progress(s) ? ` · ${e.progress(s)}` : ''}`;
      else if (e.def.kind === 'daily-land') v.sub = `${e.progress(s)}${pr && pr.done ? ` · en iyin ${fmtInt(pr.best)}` : ''}`;
      else if (e.progress(s)) v.sub = e.progress(s);
      else if (pr && pr.done) v.sub = `En iyin ${fmtInt(pr.best)} puan`;
      else v.sub = v.trackable ? (touch ? 'Henüz yok · takip için dokun' : 'Henüz yok · takip için tıkla') : 'Henüz yok';
    }
    panel.render(views);
    for (const v of views) v.autoSelect = false;
  }

  // the menu's intent (Haftanın görevi / Günün inişi started free flight): follow that challenge now, onto its final
  const intent = shared.retentionIntent;
  shared.retentionIntent = null;
  const ie = intent && byId[intent.track];
  if (ie) {
    const v = views.find((x) => x.id === ie.id);
    if (v && v.trackable) setTracked(ie.id);
    panel.select(ie.id);
    if (intent.final) goFinal(ie.id);
    else if (hud) hud.showMessage(`${ie.def.title}: ${touch ? 'GÖREV' : 'Enter'} ile ayrıntılar`, 2600);
    if (!touch) panel.open();
    dirty = true;
  }

  return api;
}
