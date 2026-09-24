// Mission runtime (CONTRACTS-SF.md §12): runs one mission on the live game — start state, briefing, timer, objectives,
// scheduled failures, fail conditions (crash, out of bounds, time), score / stars, results, restart, telemetry,
// progress. Lazily imported by src/app/main.js only when a mission is started (menu "Görevler" or ?mission=<id>), so
// free flight pays nothing for it (its own chunk in the production bundle, with the markers and the mission UI).
//
//   const plan = await planMission({ id, daily }, runways, map)   // → { mission, spawn, aircraft, catalog } | null (map: src/maps/index.js id)
//   const rt = createMissionRuntime(plan, ctx)                // after the flight model exists
//   rt.resetFlight()                                           // main.js resetFlight(): the mission's start state
//   rt.begin()                                                 // briefing (flight held until "Başla")
//   rt.update(dt, { paused, view })                            // every frame, after flight.step
//   rt.hold                                                    // true: main.js does not step the flight
//   rt.claimCrash(flight)                                      // a water contact the ditching mission rates itself
// ctx = { state, scene, camera, hud, input, audio, navRoute, landing, touch, via, resetFlight(), goToMenu(), leave(url), snapshot(), map (src/maps/index.js entry) }
// Telemetry `mission` (CONTRACTS-SF.md §11): brief (via = menu | daily | link | ff), start, done, fail, quit, and the
// players' choices on the cards: retry, next (to), menu (ph = brief | result).
import { loadMissionCatalog, AIRCRAFT_SHORT } from './catalog.js';
import { createObjective } from './objectives.js';
import { DEG, KT, FPM, clamp, dirOf } from './util.js';
import { runwayEnds } from '../flight/fixedwing-autopilot.js';
import { LANDING_BANDS } from './landing-score.js';
import { createMarkers } from '../world-sf/markers.js';
import { createMissionUI } from '../ui/missions-hud.js';
import { trackEvent } from '../core/telemetry.js';

const GS_TAN = Math.tan(3 * DEG);
const AIM = 300;

/** Start spec (catalog) → { x, z, heading (rad), altitude?, speed? (m/s), opts }. */
export function resolveStart(start, ends) {
  if (start.runway || start.final) {
    const e = ends.find((r) => r.name === (start.runway || start.final));
    if (!e) throw new Error(`mission start: runway ${start.runway || start.final} not found`);
    if (start.runway) return { x: e.x + e.dx * 45, z: e.z + e.dz * 45, heading: e.course, opts: {} };
    const d = start.dist || 8000;
    return { x: e.x - e.dx * d, z: e.z - e.dz * d, heading: e.course, altitude: e.elevation + (d + AIM) * GS_TAN, opts: {} };
  }
  const opts = {};
  if (start.gear != null) opts.gearDown = !!start.gear;
  if (start.flaps != null) opts.flapIndex = start.flaps;
  return { x: start.x, z: start.z, heading: start.hdg * DEG, altitude: start.alt, speed: start.kt * KT, opts };
}

/** Mission request ({ id, daily }) → { mission, spawn (main.js spawn object), aircraft, catalog } or null for an unknown id. */
export async function planMission(req, runways, map = 'sf') {
  if (!req || !req.id) return null;
  const catalog = await loadMissionCatalog(map, runways);   // (another map: its missions from these runways' thresholds)
  const mission = catalog && catalog.buildMission(req.id, req.daily || null);
  if (!mission) return null;
  const s = resolveStart(mission.start, runwayEnds(runways));
  const spawn = { id: `M-${mission.id}`, name: mission.title, x: s.x, z: s.z, heading: s.heading, altitude: s.altitude, airborne: s.altitude != null, mission: true };
  return { mission, spawn, start: s, aircraft: mission.aircraft, catalog };
}

export function createMissionRuntime(plan, ctx) {
  const { mission } = plan;
  const { MISSIONS, BRIDGES, recordResult, loadProgress, isUnlocked } = plan.catalog;
  const { state } = ctx;
  const world = state.world;
  const ends = runwayEnds(world.runways);
  const bounds = (world.region && world.region.local) || { minX: -16467, maxX: 20799, minZ: -28016, maxZ: 7745 };
  const cat = (state.def && state.def.spec && state.def.spec.category) || 'airliner';
  const spanScratch = { bottom: -Infinity, top: -Infinity };
  // missions around the Golden Gate / the Bay need the targets in sight: the drifting fog bank can swallow the bridge
  if (world.environment && world.environment.setFogBank) world.environment.setFogBank(mission.def.fogBank !== false);
  const env = {
    ends, bridges: BRIDGES, score: mission.score || {}, cat,
    spanAt: world.getObstacleSpan ? (x, z, out) => world.getObstacleSpan(x, z, out || spanScratch) : null,
  };
  const objectives = mission.objectives.map((d) => createObjective(d, env));
  const groundAt = (x, z) => { const h = world.getGroundHeight(x, z); return Number.isFinite(h) ? h : 0; };
  const markers = createMarkers(ctx.scene);
  const ui = createMissionUI(ctx.hud, { touch: !!ctx.touch, input: ctx.input, category: cat, missions: MISSIONS });
  const idx = MISSIONS.findIndex((m) => m.id === mission.id);
  /** The next mission in the list that is unlocked (progress after this run), wrapping around. */
  function nextMission() {
    const prog = loadProgress();
    for (let k = 1; k < MISSIONS.length; k++) { const m = MISSIONS[(idx + k) % MISSIONS.length]; if (isUnlocked(m, prog)) return m; }
    return null;
  }

  // per-frame flight sample (reused; objectives read it)
  const s = { t: 0, dt: 0, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, agl: 0, ias: 0, gs: 0, vs: 0, hdg: 0, pitch: 0, roll: 0, onGround: true, first: true };
  const lastAir = { vs: 0, pitch: 0, roll: 0, ias: 0, gear: 0, flaps: 0 };
  let phase = 'brief';        // brief | run | ending | result
  let cur = 0, endT = 0, result = null, failures = [], started = false, holdAudio = false, uiT = 0, runs = 0, gearT = 0, gearHinted = false;
  const flight = () => state.flight;

  function applyStart() {
    const f = flight();
    const st = plan.start;
    // route for the NAV autopilot (bay tour): the gates as waypoints, flown from the start position
    const nr = ctx.navRoute;
    if (nr) {
      nr.clear();
      if (mission.route) {
        if (nr.setPosition) nr.setPosition(st.x, st.z, st.heading);
        for (const p of mission.route) nr.add(p.x, p.z, { alt: p.alt });
      }
    }
    f.reset({ x: st.x, z: st.z, heading: st.heading, altitude: st.altitude, speed: st.speed }, world, st.opts);
    if (f.failures) { try { f.failures.clear(); if (f.failures.random) f.failures.random.suspended = true; } catch (e) { console.warn('[missions] failures', e); } }
    stub.clear();
  }

  // ---- failures (src/flight/failures.js; a minimal stand-in until a model has flight.failures) ----
  const stub = {
    fuel: null,
    inject(kind, opts) {
      const f = flight();
      if (f.failures && f.failures.inject) return f.failures.inject(kind, opts);
      if (f.failEngine) { f.failEngine(kind === 'engineAll' ? 'both' : (opts && opts.index) || 0, true); return true; }   // UH-60
      if (kind === 'engineAll' || (kind === 'engine' && (f.spec.engines || 1) === 1)) { this.fuel = f.fuel; f.fuel = 0; return true; }   // no fuel: windmilling
      return false;
    },
    clear() { this.fuel = null; },
  };

  function scheduleFailures() {
    failures = (mission.failures || []).map((x) => ({ ...x, done: false }));
  }
  function checkFailures() {
    for (const x of failures) {
      if (x.done) continue;
      const a = x.at || {};
      const due = (a.t != null && s.t >= a.t) || (a.agl != null && !s.onGround && s.agl >= a.agl && s.t > 1) || (a.ias != null && s.ias >= a.ias * KT);
      if (!due) continue;
      x.done = true;
      const ok = stub.inject(x.kind, x.opts || {});
      if (!ok) console.warn('[missions] failure not applied', x.kind);
      if (x.message) ui.flash(x.message, 'warn');
      if (mission.approachOnFailure && ctx.navRoute) {
        const e = ends.find((r) => r.name === mission.approachOnFailure);
        const envR = { groundAt: (px, pz) => { const h = world.getGroundHeight(px, pz); return Number.isFinite(h) ? h : 0; }, obstacleAt: (px, pz) => world.getObstacleHeight(px, pz), bounds };
        try { ctx.navRoute.clear(); ctx.navRoute.setApproach(e, cat, envR); } catch (err) { console.warn('[missions] approach', err); }
      }
    }
  }

  // ---- markers of the current objective ----
  let orbitA0;
  function showMarkers() {
    markers.clear();
    const o = objectives[cur];
    if (!o) return;
    const d = o.def;
    if (d.type === 'gates' || d.type === 'orbit') {   // (orbit: checkpoint rings on its circle + a beacon at the centre)
      if (!o.gates[0].nx && !o.gates[0].nz) o.orient(plan.start.x, plan.start.z);
      markers.setGates(d.shape || 'ring', o.gates);
      markers.setActiveGate(o.index);
      orbitA0 = o.a0;
      if (d.type === 'orbit') markers.setBeacon({ x: d.x, y: groundAt(d.x, d.z), z: d.z, h: 250, w: 2.5 });
    } else if (d.type === 'bridge') {
      const b = BRIDGES[d.bridge], ax = dirOf(b.axis);
      markers.setGates('frame', [{ x: b.x, y: 33, z: b.z, hw: b.half - 70, hh: 27, nx: -ax.dz, nz: ax.dx }]);
    } else if (d.type === 'hover' || d.type === 'pad') {
      const y = Math.max(d.y, groundAt(d.x, d.z));
      markers.setPad({ x: d.x, y: y + 0.15, z: d.z, r: d.r });
      markers.setBeacon({ x: d.x, y, z: d.z, h: 250, w: 2.5 });
    } else if (d.type === 'land' && o.targetEnd) {
      const e = o.targetEnd;
      const B = LANDING_BANDS[cat === 'fighter' ? 'fighter' : 'airliner'];
      // (logarithmic depth ignores polygon offset: the box floats a little above the drawn runway surface)
      const mid = (B.tdzIdeal[0] + B.tdzIdeal[1]) / 2;
      const y = Math.max(e.elevation, groundAt(e.x + e.dx * mid, e.z + e.dz * mid)) + 0.3;
      if (cat !== 'helicopter') markers.setRunwayBox({ x: e.x, z: e.z, y, course: e.course, from: B.tdzIdeal[0], to: B.tdzIdeal[1], width: e.width * 0.92 });
      else markers.setBeacon({ x: e.aimX, y, z: e.aimZ, h: 300, w: 3 });
    }
  }

  // ---- lifecycle ----
  function resetMission() {
    for (const o of objectives) o.start();
    for (const o of objectives) if (o.def.type === 'gates' || o.def.type === 'orbit') o.orient(plan.start.x, plan.start.z);
    cur = 0; s.t = 0; s.first = true; endT = 0; result = null; gearT = 0; gearHinted = false;
    scheduleFailures();
    showMarkers();
    if (ctx.landing) ctx.landing.reset();
    ui.setObjective(objectives[0], 0, objectives.length);
  }

  function setHold(on) {
    rt.hold = on;
    if (ctx.audio && ctx.audio.setPaused && holdAudio !== on) { holdAudio = on; ctx.audio.setPaused(on); }
  }

  function startRun() {
    if (phase === 'run') return;
    ui.hideCard();
    phase = 'run';
    setHold(false);
    runs++;
    started = true;
    s.first = true;   // no gate / bridge crossing against a stale previous position
    trackEvent('mission', { id: mission.id, st: 'start', ac: mission.aircraft, d: mission.day ? 1 : undefined, run: runs });   // (run: the attempt on this page; `n` is the envelope's sequence)
    ui.flash(objectives[0] ? objectives[0].label : mission.goal, 'go');
  }

  function finish(ok, reason = '') {
    if (phase !== 'run') return;
    phase = 'ending';
    endT = ok ? (objectives.some((o) => o.def.type === 'land' || o.def.type === 'pad') ? 1.2 : 1.6) : 2.6;
    const t = s.t;
    const sc = mission.score || {};
    const rows = [];
    let score = 0, stars = 0;
    if (ok) {
      score = sc.base || 0;
      if (sc.base) rows.push(['Görev tamamlandı', '', sc.base]);
      for (const o of objectives) { score += o.points; for (const p of o.parts) rows.push(p); }
      if (sc.par && sc.perSec) {
        const bonus = Math.round(Math.max(0, sc.par - t) * sc.perSec);
        rows.push(['Süre', fmtT(t), bonus]);
        score += bonus;
      }
      score = Math.round(score);
      if (mission.stars === 'landing') { const l = objectives.find((o) => o.landing); stars = l ? l.landing.stars : 1; }
      else if (mission.stars === 'ditch') { const o = objectives.find((x) => x.def.type === 'ditch'); stars = o && o.ditch ? o.ditch.stars : o && o.landing ? o.landing.stars : 1; }
      else stars = mission.stars.filter((th) => score >= th).length;
      stars = clamp(stars, 1, 3);
    }
    const prog = recordResult(mission.id, { ok, score, stars, day: mission.day });
    result = { ok, reason, score, stars, time: t, rows, newBest: prog.newBest, prevBest: prog.prevBest, mission };
    trackEvent('mission', { id: mission.id, st: ok ? 'done' : 'fail', stars: ok ? stars : 0, score: ok ? score : 0, sec: t.toFixed(1), d: mission.day ? 1 : undefined, why: ok ? undefined : failCode(reason) });
    if (!ok) ui.flash(reason, 'warn');
  }

  function failCode(r) {
    if (/Süre/.test(r)) return 'time';
    if (/alan/.test(r)) return 'bounds';
    if (/Pist dışı/.test(r)) return 'offrw';
    if (/Yanlış/.test(r)) return 'wrongrw';
    if (/sert|Sert/.test(r)) return 'hard';
    return flight() && flight().crashed ? 'crash' : 'obj';
  }

  function showResult() {
    phase = 'result';
    setHold(true);
    markers.clear();
    prepareShare();
    const next = nextMission();
    const act = (st, extra) => trackEvent('mission', { id: mission.id, st, d: mission.day ? 1 : undefined, ...extra });
    ui.showResult(result, {
      retry: () => { act('retry', { ok: result && result.ok ? 1 : 0 }); ctx.resetFlight(); },
      next: next && next.id !== mission.id ? () => { act('next', { to: next.id }); ctx.leave(missionUrl(next.id)); } : null,
      nextTitle: next ? next.title : '',
      menu: () => { act('menu', { ph: 'result' }); ctx.goToMenu(); },
      share: (o) => shareResult(o),
    });
  }

  function missionUrl(id, day = null) {
    const q = new URLSearchParams();
    q.set('mission', id);
    if (day) q.set('daily', day);
    q.set('from', 'next');   // "Sonraki görev": the next briefing reports via=next
    return `${location.pathname}?${q}`;
  }

  // share card: prepared when the result shows (image encoded in the background) so the tap can share at once
  let shareP = null, shareH = null;
  function prepareShare() {
    shareH = null;
    const r = result;
    shareP = import('../ui/share.js').then((mod) => mod.prepareMission({
      id: mission.id, day: mission.day, title: mission.title, aircraft: AIRCRAFT_SHORT[mission.aircraft] || mission.aircraft,
      ok: r && r.ok, score: r ? r.score : 0, stars: r ? r.stars : 0, time: r ? r.time : 0, snapshot: ctx.snapshot, map: ctx.map,
    })).then((h) => { shareH = h; return h; });
    shareP.catch((e) => console.warn('[missions] share', e));
  }
  function shareResult({ anchor = null } = {}) {
    if (shareH) return shareH.run(anchor);
    if (!shareP) prepareShare();
    return shareP.then((h) => h.run(anchor));
  }

  // ---- flight events ----
  const f0 = flight();
  if (f0 && f0.on) {
    // airliner ditching (src/flight/fixedwing.js _tryDitch: the model decides it was survivable, then floats)
    f0.on('ditch', (i) => {
      if (phase !== 'run') return;
      const o = objectives[cur];
      const d = ditchSample();
      if (i) {
        if (Number.isFinite(i.verticalSpeed)) d.fpm = Math.max(0, -i.verticalSpeed * FPM);
        if (Number.isFinite(i.pitch)) d.pitch = i.pitch;
        if (Number.isFinite(i.roll)) d.roll = i.roll;
        if (Number.isFinite(i.ias)) d.kt = i.ias / KT;
      }
      d.gear = 0; d.survived = true;
      if (o && o.def.type === 'ditch') o.onDitch(d);
      else finish(false, 'Suya indin');
    });
  }
  if (ctx.landing) {
    ctx.landing.onResult((card, td) => {
      if (phase !== 'run') return;
      const o = objectives[cur];
      if (o) o.onLanding(card, td);
      // a later objective may be the one this landing is for (e.g. landing before the hover is complete is ignored)
    });
  }
  function ditchSample() {
    return { fpm: Math.max(0, -lastAir.vs * FPM), pitch: lastAir.pitch, roll: lastAir.roll, kt: lastAir.ias / KT, gear: lastAir.gear, flaps: lastAir.flaps };
  }

  const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  // ---- the object main.js drives ----
  const rt = {
    mission, hold: true,
    get phase() { return phase; },
    get result() { return result; },
    get objective() { return objectives[cur] || null; },
    objectives, markers, ui,
    /** main.js resetFlight(): the start state; a restart after the first run shows the briefing again (compact). */
    resetFlight() {
      applyStart();
      resetMission();
      if (phase === 'result' || phase === 'ending' || phase === 'run') {
        if (phase === 'run') trackEvent('mission', { id: mission.id, st: 'quit', sec: s.t.toFixed(1), why: 'restart' });
        phase = 'brief';
        setHold(true);
        ui.showBrief(mission, { start: startRun, menu: () => { trackEvent('mission', { id: mission.id, st: 'menu', ph: 'brief' }); ctx.goToMenu(); }, again: true, best: loadProgress().missions[mission.id] });
      }
    },
    begin() {
      phase = 'brief';
      setHold(true);
      ui.setMission(mission);
      // the briefing is shown (tests with ?mbrief=0 skip it but still count as reached): where the player came from
      trackEvent('mission', { id: mission.id, st: 'brief', via: ctx.via || 'link', ac: mission.aircraft, d: mission.day ? 1 : undefined });
      if (new URLSearchParams(location.search).get('mbrief') === '0') { startRun(); return; }   // tests / tools: no briefing
      if (ctx.hud) ctx.hud.showMessage(`Görev: ${mission.title}`, 1300);   // replaces the free-flight start message
      ui.showBrief(mission, { start: startRun, menu: () => { trackEvent('mission', { id: mission.id, st: 'menu', ph: 'brief' }); ctx.goToMenu(); }, again: false, best: loadProgress().missions[mission.id] });
    },
    /** A crash the mission rates itself (water contact during the ditching objective): true = no crash card / reset. */
    claimCrash(f) {
      if (phase !== 'run') return false;
      const o = objectives[cur];
      if (!o || o.def.type !== 'ditch' || !/su/i.test(f.crashReason || '')) return false;
      // a model with ditching ('ditched' in flight) already judged this contact unsurvivable: the objective says why
      const modelDitch = 'ditched' in f;
      o.onDitch({ ...ditchSample(), survived: modelDitch ? false : undefined });
      if (o.status === 'done') { ui.flash('Suya iniş başarılı!', 'go'); return true; }
      return false;
    },
    update(dt, { paused = false } = {}) {
      const f = flight();
      if (!f) return;
      markers.update(paused ? 0 : dt, ctx.camera);
      if (!paused) {   // the sample (the strip shows distance / height to the target before the start too)
        s.px = s.x; s.py = s.y; s.pz = s.z;
        const p = f.position, v = f.velocity;
        s.x = p.x; s.y = p.y; s.z = p.z;
        s.agl = Number(f.agl) || 0; s.ias = Number.isFinite(f.ias) ? f.ias : Number(f.airspeed) || 0;
        s.gs = v ? Math.hypot(v.x, v.z) : 0; s.vs = Number(f.verticalSpeed) || 0;
        s.hdg = Number(f.heading) || 0; s.pitch = Number(f.pitch) || 0; s.roll = Number(f.roll) || 0; s.onGround = !!f.onGround;
      }
      if (phase === 'run' && !paused) {
        s.dt = dt; s.t += dt;
        if (!f.crashed) { lastAir.vs = s.vs; lastAir.pitch = s.pitch; lastAir.roll = s.roll; lastAir.ias = s.ias; lastAir.gear = Number(f.gear) || 0; lastAir.flaps = Number(f.flaps) || 0; }
        if (!f.crashed) checkFailures();
        if (mission.manual && f.autopilot && f.autopilot.on && f.command) { f.command('autopilot'); ui.flash('Bu görevde otopilot yok: elle uç', 'warn'); }
        // gear handle down but the gear stays up with a failure (F-16 flameout: hydraulic B; airliners without engines):
        // one reminder of the alternate extension (the emergency key)
        if (!gearHinted && f.gearHandleDown && (f.gear ?? 1) < 0.05 && f.failures && f.failures.active && f.failures.active.size) {
          if ((gearT += dt) > 3) { gearHinted = true; ui.flash(ctx.touch ? 'Takım inmiyor: ACİL ile acil indirme' : 'Takım inmiyor: I (ACİL) ile acil indirme', 'warn'); }
        } else gearT = 0;
        const o = objectives[cur];
        if (o && o.status === 'active' && !f.crashed) o.update(s);
        s.first = false;
        if (o && o.message) { ui.flash(o.message, o.status === 'done' ? 'go' : 'info'); o.message = null; }
        if (o && o.status === 'fail') finish(false, o.failReason);
        else if (o && o.status === 'done') {
          cur++;
          if (cur >= objectives.length) finish(true);
          else { ui.setObjective(objectives[cur], cur, objectives.length); showMarkers(); }
        } else if (o && (o.def.type === 'gates' || o.def.type === 'orbit')) {
          if (o.a0 !== orbitA0) { orbitA0 = o.a0; markers.setGates(o.def.shape || 'ring', o.gates); }   // an orbit started on another side
          markers.setActiveGate(o.index);
        }
        if (phase === 'run') {
          if (f.crashed) finish(false, f.crashReason ? `Kaza: ${f.crashReason}` : 'Kaza');
          else if (f.ditched) finish(false, 'Suya indin');
          else if (s.x < bounds.minX || s.x > bounds.maxX || s.z < bounds.minZ || s.z > bounds.maxZ) finish(false, 'Görev alanının dışına çıktın');
          else if (mission.limit && s.t > mission.limit) finish(false, 'Süre doldu');
        }
      } else if (phase === 'ending' && !paused) {
        s.t += 0;   // the clock stops at the finish
        if ((endT -= dt) <= 0) showResult();
      }
      if ((uiT -= dt) <= 0 || phase !== 'run') {
        uiT = 0.1;
        ui.update({ s, t: s.t, limit: mission.limit, objective: objectives[cur] || null, phase, flight: f });
      }
      if (phase === 'run' || phase === 'ending') ui.pointer(ctx.camera, objectives[cur] && objectives[cur].status === 'active' ? objectives[cur].target : null, s);
      else ui.pointer(null, null, s);
    },
    /** Page hide / menu: a running mission is reported as quit. */
    quit(why = 'menu') {
      if (phase === 'run') trackEvent('mission', { id: mission.id, st: 'quit', sec: s.t.toFixed(1), why });
      phase = 'result';
    },
    share: (x) => shareResult(x),
    debug() {
      return { id: mission.id, day: mission.day, phase, t: +s.t.toFixed(2), cur, hold: rt.hold, objective: objectives[cur] ? { type: objectives[cur].def.type, status: objectives[cur].status, progress: objectives[cur].progress } : null, result: result && { ok: result.ok, reason: result.reason, score: result.score, stars: result.stars } };
    },
  };
  addEventListener('pagehide', () => rt.quit('leave'));
  if (ctx.landing && ctx.landing.setMissionMode) ctx.landing.setMissionMode(true);
  if (ctx.landing && ctx.landing.setProfile) ctx.landing.setProfile((mission.objectives.find((o) => o.profile) || {}).profile || null);
  return rt;
}

