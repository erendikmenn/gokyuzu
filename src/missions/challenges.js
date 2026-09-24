// Free-flight challenges ("Serbest uçuş görevleri", CONTRACTS-SF.md §12.1): the missions' objectives, detected while the
// player flies freely — no start button, no fixed start, any fitting aircraft. Siblings of the missions: the same
// catalog data (src/missions/catalog.js), objectives (src/missions/objectives.js) and landing score; their own
// leaderboards (`ff-<id>`: free-flight runs are not comparable to mission runs) and their own progress
// (localStorage `gokyuzu.ffc`; the missions' `gokyuzu.missions` is untouched). No DOM, no three.js (Node tests); the game
// glue is src/missions/ff-runtime.js.
//
//   const tr = createChallengeTracker({ aircraft, category, ends, bridges, spanAt, isOnRunway, isWater, hooks, emit,
//                                        challenges?, catalog? })   another map: its CHALLENGES + mission catalog (loadChallengeSet)
//   tr.update(s)                 every flying frame; s = the runtime's flight sample (t, dt, x, y, z, px, py, pz, agl, gs, onGround, first, …)
//   tr.onLanding(card, td)       final landing score (src/ui/landing.js onResult)
//   tr.onDitch(d)                water landing the flight model rated survivable (fixed wing 'ditch' event)
//   tr.onCrash(reason, d)        → true when the crash was a rated ditching (no crash card); running runs fail
//   tr.onReset()                 flight reset: running runs end silently
//   tr.canStart(id, s, flight)   → { ok, reason } (emergencies)   tr.start(id, s, flight) → { ok, reason }   tr.cancel(id)
//   tr.entries                   [{ def, id, board, status: 'idle'|'armed'|'run', t0, target, markers(), view(s) }]
// emit(type, entry, data): 'start' (a run began), 'done' / 'fail' (data = result), 'abort' (silently ended; data = why:
// 'time' | 'gap' | 'far' | 'landed' (timed run abandoned), 'cancel' (Vazgeç), 'reset', 'stopped' (rejected take-off)),
// 'message' (text).
// result = { id, board, title, ok, reason, score, stars, time (s from the run start | null), rows [[label, value, points]], ac, landing? }
//
// Detection (per frame only a distance check until the aircraft is near a target; objectives are allocation-free):
//   bridge    any aircraft: the bridge objective within 3 km of the Golden Gate; a pass under the deck between the
//             towers completes it (base + the objective's centre / height points); re-armed after each pass
//   gates     low-pass frames / bay-tour rings: crossing gate 1 starts the clock, all gates in order complete it (gate
//             points + a time bonus from gate 1); abandoned silently after a long gap, far away or at the run limit
//   climb     fixed wing: armed at a standstill on a runway, the clock starts when the take-off roll begins, done at
//             10,000 ft MSL (1000 + 25 per second under 120 s)
//   alcatraz  UH-60: hover 5 s over the pad (the mission's hover objective), then land on it (pad objective)
//   landing   every runway landing (landing card ≥ 1★): points × 20, the landing's stars
//   emergency explicit start ("Başlat", airborne, fitting aircraft / place): inject the failure now; land safely
//             (land objective on any runway; ditch objective; autorotation profile) → base + landing points
import { buildMission, BRIDGES, SF_CATALOG, loadMissionCatalog } from './catalog.js';
import { createObjective } from './objectives.js';
import { FT, KT, FPM, fmtTime, fmtInt } from './util.js';

const ALL = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];
const FIXED = ['f16', 'f22', 'a320neo', 'b737'];
const CLIMB_FT = 10000;
const NEAR_BRIDGE = 3000;          // m: the bridge objective runs only this close to the bridge
const GATE_GAP = 150;              // s between two gates before a started run is dropped (a helicopter needs ~70 s per bay-tour leg)
const GATE_FAR = 10000;            // m from the next gate before a started run is dropped
const PAD_NEAR = 800, PAD_FAR = 1500;

const fmtFt = (ft) => fmtInt(Math.round(ft));

/** The free-flight challenges. `mission` = the sibling mission (deep link ?mission=<id>); `board` = the leaderboard id. */
export const CHALLENGES = [
  {
    id: 'bridge', kind: 'bridge', mission: 'gg-under', aircraft: ALL, title: 'Golden Gate\'in altından geç',
    hint: 'Kuleler arasından, tabliyenin altından geç (tabliye ≈ 65 m). Ortadan ve 15–50 m\'den geçmek tam puan.',
    score: { base: 1000 }, stars: [1000, 1450, 1650],
  },
  {
    id: 'low-pass', kind: 'gates', mission: 'low-pass', aircraft: ALL, title: 'Alçak geçiş',
    hint: 'Körfezin ortasındaki 5 alçak kapı (deniz üstü 10–70 m). 1. kapıdan geçince süre başlar; sırayla geç.',
    near: 1500, limit: 600, score: { par: 100, perSec: 15 }, stars: [1000, 1500, 1800],
  },
  {
    id: 'bay-tour', kind: 'gates', mission: 'bay-tour', aircraft: ALL, title: 'Körfez turu',
    hint: 'Bay Köprüsü → Alcatraz → Golden Gate halkaları (≈ 2.000 / 1.500 ft). 1. halkada süre başlar.',
    near: 1500, limit: 600, score: { par: 135, perSec: 5 }, stars: [900, 1250, 1500],
  },
  {
    id: 'climb', kind: 'climb', mission: 'climb', aircraft: FIXED, title: 'Dik tırmanış',
    hint: 'Bir pistte dur ve kalkışa başla: süre tekerlekler dönünce başlar, 10.000 ft\'te biter.',
    limit: 300, score: { base: 1000, par: 120, perSec: 25 }, stars: [1000, 2125, 2625],
  },
  {
    id: 'alcatraz', kind: 'alcatraz', mission: 'alcatraz', aircraft: ['uh60'], title: 'Alcatraz pedi',
    hint: 'Alcatraz\'daki pedin üstünde 5 sn asılı kal, sonra pedin ortasına yumuşakça in.',
    limit: 240, score: { base: 1000, landing: 8 }, stars: [1000, 1650, 2050],
  },
  {
    id: 'landing', kind: 'landing', mission: 'sfo-28r', aircraft: ALL, title: 'En iyi iniş',
    hint: 'Her pist inişin puanlanır (dikey hız, merkez çizgi, temas bölgesi): en iyisi sayılır.',
    score: { landing: 20 }, stars: 'landing',
  },
  {
    id: 'eng', kind: 'emergency', group: 'emergency', mission: 'eng-takeoff', aircraft: ['a320neo', 'b737'], title: 'Motor arızası',
    hint: 'Bir motor şimdi duracak: dümenle düz uç, hızı koru, en yakın piste güvenli in.',
    need: { agl: 400 * FT }, failure: { kind: 'engine', opts: { index: 'random' } },
    objective: { type: 'land', any: true, minStars: 1 }, limit: 900, score: { base: 1000, landing: 12 }, stars: 'landing',
    message: (o) => `${o.index === 1 ? 'Sağ' : 'Sol'} motor arızası! Dümenle düz uç, en yakın piste in.`,
  },
  {
    id: 'flameout', kind: 'emergency', group: 'emergency', mission: 'flameout', aircraft: ['f16'], title: 'Alev sönmesi',
    hint: 'Motor sönecek ve yeniden yanmayacak: 200 kt ile süzül, takım için G sonra ACİL (I), bir piste in.',
    need: { agl: 4000 * FT }, failure: { kind: 'engine', opts: { index: 0, restartable: false } },
    objective: { type: 'land', any: true, minStars: 1 }, limit: 900, score: { base: 1000, landing: 10 }, stars: 'landing',
    message: () => 'Motor söndü: süzül ve en yakın piste in!',
  },
  {
    id: 'ditch', kind: 'emergency', group: 'emergency', mission: 'ditch', aircraft: ['a320neo', 'b737'], title: 'Suya mecburi iniş',
    hint: 'İki motor birden duracak: takım kapalı, kanatlar düz, burun hafif yukarıda körfeze kontrollü in.',
    need: { agl: 1000 * FT, water: true }, failure: { kind: 'engineAll', opts: { restartable: false } },
    objective: { type: 'ditch' }, limit: 900, score: { base: 1000, ditch: 10 }, stars: 'ditch',
    message: () => 'Çift motor arızası! Körfeze kontrollü suya iniş yap.',
  },
  {
    id: 'autorot', kind: 'emergency', group: 'emergency', mission: 'autorotation', aircraft: ['uh60'], title: 'Otorotasyon',
    hint: 'İki motor birden duracak: kolektifi hemen indir, 60–80 kt süzül, 25 m\'de burnu kaldır ve yumuşat.',
    need: { agl: 500 * FT }, failure: { kind: 'engineAll', opts: {} },
    objective: { type: 'land', any: true, heli: true, minStars: 1, profile: 'autorotation' }, limit: 600,
    score: { base: 1000, landing: 10, runwayBonus: 200 }, stars: 'landing',
    message: () => 'İki motor durdu: kolektifi indir, otorotasyon!',
  },
];
for (const c of CHALLENGES) c.board = `ff-${c.id}`;

export const challengeById = (id) => CHALLENGES.find((c) => c.id === id) || null;
/** The challenges an aircraft can do (the panel lists only these). */
export const challengesFor = (aircraft) => CHALLENGES.filter((c) => c.aircraft.includes(aircraft));

/** The highest score a challenge can give (infra/leaderboard/build_rules.mjs adds a margin); build = its map's buildMission. */
export function maxChallengeScore(c, build = buildMission) {
  const sc = c.score || {};
  if (c.kind === 'bridge') return (sc.base || 0) + 500 + 300;
  if (c.kind === 'gates') {
    const m = build(c.mission), ms = m.score || {};
    return m.objectives[0].gates.length * ((ms.gate ?? 200) + (ms.gateAcc ?? 100)) + sc.par * sc.perSec;
  }
  if (c.kind === 'climb') return (sc.base || 0) + sc.par * sc.perSec;
  if (c.kind === 'alcatraz') return (sc.base || 0) + 300 + 400 + (sc.landing ?? 8) * 100;
  if (c.kind === 'landing') return (sc.landing ?? 20) * 100;
  if (c.objective && c.objective.type === 'ditch') return (sc.base || 0) + (sc.ditch ?? 10) * 100;
  return (sc.base || 0) + (sc.landing ?? 10) * 100 + (sc.runwayBonus || 0);
}

// ------------------------------------------------------------------------------------------------------- progress
// per map: San Francisco `gokyuzu.ffc`, another map `gokyuzu.ffc.<id>`
const storeKey = (map) => (map && map !== 'sf' ? `gokyuzu.ffc.${map}` : 'gokyuzu.ffc');
function readStore(map) {
  try { const s = JSON.parse(localStorage.getItem(storeKey(map)) || 'null'); return s && typeof s === 'object' && s.e ? s : { v: 1, e: {} }; } catch { return { v: 1, e: {} }; }
}
function writeStore(s, map) { try { localStorage.setItem(storeKey(map), JSON.stringify(s)); } catch { /* private mode / Node */ } }
/** { [id]: { best, stars, runs, done, ac } } */
export function loadChallengeProgress(map) { return readStore(map).e; }
/** Record a finished run → { newBest, prevBest, prevStars }. */
export function recordChallenge(id, { ok, score, stars, ac }, map) {
  const s = readStore(map);
  const p = s.e[id] || (s.e[id] = { best: 0, stars: 0, runs: 0, done: false });
  const prev = { prevBest: p.best || 0, prevStars: p.stars || 0 };
  p.runs = (p.runs || 0) + 1;
  let newBest = false;
  if (ok) {
    p.done = true;
    if (score > (p.best || 0)) { p.best = score; p.ac = ac; newBest = true; }
    p.stars = Math.max(p.stars || 0, stars || 0);
  }
  writeStore(s, map);
  return { newBest, ...prev };
}

/**
 * A map's challenge set: San Francisco's at once; another map's from src/missions/<id>/challenges.js (CHALLENGES in
 * this file's format; a bridge entry names its bridge in `bridge`, a pad entry its mission in `mission`) with its mission
 * catalog, and the module's own createChallengeTracker when it has one (its own kinds). Boards: `board`, else ff-<id>
 * (ids starting with "<map>-") / ff-<map>-<id>. Progress: per map (recordChallenge). null: no challenges (yet).
 */
export async function loadChallengeSet(map = 'sf') {
  if (map === 'sf') return { map, challenges: CHALLENGES, catalog: SF_CATALOG };
  const catalog = await loadMissionCatalog(map);
  const mod = catalog && await import(`./${map}/challenges.js`).catch((e) => { console.info(`[challenges] none for ${map} yet`, e && e.message); return null; });
  if (!mod || !mod.CHALLENGES || !mod.CHALLENGES.length) return null;
  for (const c of mod.CHALLENGES) if (!c.board) c.board = c.id.startsWith(`${map}-`) ? `ff-${c.id}` : `ff-${map}-${c.id}`;
  return { map, challenges: mod.CHALLENGES, catalog, tracker: mod.createChallengeTracker || null };
}

// -------------------------------------------------------------------------------------------------------- tracker
const starsFor = (def, score) => Math.min(3, Math.max(1, def.stars.filter((th) => score >= th).length));

export function createChallengeTracker(o = {}) {
  const aircraft = o.aircraft || 'f16';
  const category = o.category || 'airliner';
  const ends = o.ends || [];
  const catalog = o.catalog || SF_CATALOG;
  const bridges = o.bridges || catalog.BRIDGES || BRIDGES;
  const isOnRunway = o.isOnRunway || (() => false);
  const isWater = o.isWater || (() => false);
  const hooks = o.hooks || {};         // inject(kind, opts) → bool, clearFailure(kind), suspendRandom(on)
  const emit = o.emit || (() => {});
  const env = (score) => ({ ends, bridges, score, cat: category, spanAt: o.spanAt || null });

  function base(def) {
    return {
      def, id: def.id, board: def.board, status: 'idle', t0: 0, runs: 0, last: null,
      get target() { return null; },
      markers: () => null,
      update() {}, onLanding() {}, onDitch() {}, crash() { return false; }, reset() {},
      progress: () => '',
    };
  }
  function finish(e, ok, { score = 0, stars = 0, time = null, rows = [], reason = '', landing = null } = {}) {
    e.status = 'idle';
    const r = { id: e.id, board: e.board, title: e.def.title, ok, reason, score: ok ? Math.round(score) : 0, stars: ok ? stars : 0, time, rows, ac: aircraft, landing };
    e.last = r;
    emit(ok ? 'done' : 'fail', e, r);
    return r;
  }
  const say = (e, obj) => { if (obj.message) { const m = obj.message; obj.message = null; emit('message', e, m); } };

  // ---- Golden Gate: under the deck between the towers ----
  function bridgeEntry(def) {
    const e = base(def);
    const bridge = def.bridge || 'golden_gate', b = bridges[bridge];
    const obj = createObjective({ type: 'bridge', bridge, label: def.title }, env(def.score));
    obj.start();
    let cool = 0;
    Object.defineProperty(e, 'target', { get: () => obj.target });
    e.obj = obj;
    e.update = (s) => {
      if (cool > 0) { cool -= s.dt; return; }
      const dx = s.x - b.x, dz = s.z - b.z;
      if (dx * dx + dz * dz > NEAR_BRIDGE * NEAR_BRIDGE) return;
      obj.update(s);
      if (obj.status === 'done') {
        obj.message = null;
        const bs = def.score.base || 0;
        const score = bs + obj.points;
        finish(e, true, { score, stars: starsFor(def, score), rows: [['Köprünün altından geçiş', '', bs], ...obj.parts] });
        e.runs++;
        obj.start(); cool = 2;
        return;
      }
      say(e, obj);
    };
    e.reset = () => { obj.start(); cool = 0; };
    e.markers = () => ({ type: 'bridge', bridge: b });
    e.progress = () => '';
    return e;
  }

  // ---- gates / rings: gate 1 starts the clock ----
  function gatesEntry(def) {
    const e = base(def);
    const m = catalog.buildMission(def.mission);
    const od = m.objectives[0];
    const sc = { ...(m.score || {}), ...def.score };
    const obj = createObjective(od, env(sc));
    obj.orient(m.start.x, m.start.z);
    obj.start();
    const n = obj.gates.length;
    let lastT = 0;
    e.obj = obj; e.gates = obj.gates; e.shape = od.shape;
    Object.defineProperty(e, 'target', { get: () => obj.target });
    Object.defineProperty(e, 'index', { get: () => obj.index });
    const drop = (why) => { e.status = 'idle'; obj.start(); emit('abort', e, why); };
    e.update = (s) => {
      if (e.status === 'idle') {
        const g = obj.gates[0], dx = s.x - g.x, dz = s.z - g.z;
        if (dx * dx + dz * dz > def.near * def.near) return;
        obj.update(s);
        say(e, obj);
        if (obj.index >= 1) {
          obj.message = null;
          e.status = 'run'; e.t0 = s.t; lastT = s.t; e.runs++;
          emit('start', e, null);
          emit('message', e, `${def.title}: süre başladı · 1/${n}`);
        }
        return;
      }
      const el = s.t - e.t0;
      e.lastT = el;
      const g = obj.gates[obj.index], dx = s.x - g.x, dz = s.z - g.z;
      if (el > def.limit) { drop('time'); return; }
      if (s.t - lastT > GATE_GAP) { drop('gap'); return; }
      if (dx * dx + dz * dz > GATE_FAR * GATE_FAR) { drop('far'); return; }
      const i0 = obj.index;
      obj.update(s);
      if (obj.index !== i0) lastT = s.t;
      if (obj.status === 'done') {
        obj.message = null;
        const bonus = Math.round(Math.max(0, sc.par - el) * sc.perSec);
        const score = obj.points + bonus;
        finish(e, true, { score, stars: starsFor(def, score), time: el, rows: [...obj.parts, ['Süre (1. kapıdan)', fmtTime(el), bonus]] });
        obj.start();
        return;
      }
      say(e, obj);
    };
    e.crash = (reason) => { if (e.status !== 'run') return false; finish(e, false, { reason, time: e.lastT }); obj.start(); return true; };
    e.reset = () => { e.status = 'idle'; obj.start(); };
    e.markers = () => ({ type: 'gates', shape: od.shape, gates: obj.gates, index: obj.index });
    e.progress = (s) => (e.status === 'run' ? `${obj.index}/${n} · ${fmtTime(s.t - e.t0)}` : '');
    return e;
  }

  // ---- climb: take-off roll → 10,000 ft ----
  function climbEntry(def) {
    const e = base(def);
    const obj = createObjective({ type: 'altitude', min: CLIMB_FT * FT, label: def.title }, env(def.score));
    obj.start();
    let air = 0, armT = 0, lastY = 0;
    e.obj = obj;
    const drop = (why) => { e.status = 'idle'; obj.start(); emit('abort', e, why); };
    e.update = (s) => {
      lastY = s.y;
      if (e.status === 'run') {
        const el = s.t - e.t0;
        e.lastT = el;
        if (!s.onGround) air += s.dt;
        else if (air > 3) { drop('landed'); return; }
        else if (air === 0 && s.gs < 1) { e.status = 'armed'; obj.start(); emit('abort', e, 'stopped'); return; }   // rejected take-off
        obj.update(s);
        if (obj.status === 'done') {
          const sc = def.score;
          const bonus = Math.round(Math.max(0, sc.par - el) * sc.perSec);
          const score = sc.base + bonus;
          finish(e, true, { score, stars: starsFor(def, score), time: el, rows: [[`${fmtFt(CLIMB_FT)} ft'e tırmanış`, '', sc.base], ['Süre (kalkış koşusundan)', fmtTime(el), bonus]] });
          obj.start();
        } else if (el > def.limit) drop('time');
        return;
      }
      if (!s.onGround) { e.status = 'idle'; return; }
      if (e.status === 'idle') {
        // armed at a standstill on a runway (the runway lookup at most 4× a second, only while slow on the ground)
        if (s.gs < 2 && (armT -= s.dt) <= 0) { armT = 0.25; if (isOnRunway(s.x, s.z)) e.status = 'armed'; }
        return;
      }
      if (s.gs >= 3) {   // armed → the take-off roll begins
        if (isOnRunway(s.x, s.z)) { e.status = 'run'; e.t0 = s.t; air = 0; obj.start(); e.runs++; emit('start', e, null); }
        else e.status = 'idle';
      }
    };
    e.crash = (reason) => { if (e.status === 'armed') e.status = 'idle'; if (e.status !== 'run') return false; finish(e, false, { reason, time: e.lastT }); obj.start(); return true; };
    e.reset = () => { e.status = 'idle'; obj.start(); armT = 0; };
    e.progress = (s) => (e.status === 'run' ? `${fmtTime(s.t - e.t0)} · ${fmtFt(Math.round(Math.max(0, lastY) / FT / 100) * 100)} / ${fmtFt(CLIMB_FT)} ft`
      : e.status === 'armed' ? 'Hazır: kalkış koşusuna başla' : '');
    return e;
  }

  // ---- Alcatraz: hover over the pad, then land on it (UH-60) ----
  function alcatrazEntry(def) {
    const e = base(def);
    const m = catalog.buildMission(def.mission || 'alcatraz');
    const hd = m.objectives.find((x) => x.type === 'hover'), pd = m.objectives.find((x) => x.type === 'pad');
    const hover = createObjective(hd, env(def.score)), pad = createObjective(pd, env(def.score));
    hover.start(); pad.start();
    e.hover = hover; e.pad = pad; e.padDef = pd;
    Object.defineProperty(e, 'target', { get: () => (e.status === 'run' ? pad.target : hover.target) });
    const drop = (why) => { e.status = 'idle'; hover.start(); pad.start(); emit('abort', e, why); };
    e.update = (s) => {
      const dx = s.x - hd.x, dz = s.z - hd.z, d2 = dx * dx + dz * dz;
      if (e.status === 'idle') {
        if (d2 > PAD_NEAR * PAD_NEAR) { if (hover.held > 0) hover.start(); return; }
        hover.update(s);
        if (hover.status === 'done') {
          hover.message = null;
          e.status = 'run'; e.t0 = s.t; e.runs++; pad.start();
          emit('start', e, null);
          emit('message', e, 'Güzel hover! Şimdi pedin ortasına dikey in.');
        }
        return;
      }
      if (d2 > PAD_FAR * PAD_FAR || s.t - e.t0 > def.limit) drop(d2 > PAD_FAR * PAD_FAR ? 'far' : 'time');
    };
    e.onLanding = (card, td) => {
      if (e.status !== 'run') {
        if (Math.hypot(td.x - hd.x, td.z - hd.z) < 60) { hover.onLanding(card, td); say(e, hover); }
        return;
      }
      pad.onLanding(card, td);
      if (pad.status === 'done') {
        const bs = def.score.base || 0;
        const score = bs + hover.points + pad.points;
        finish(e, true, { score, stars: starsFor(def, score), time: null, rows: [['Pede iniş', '', bs], ...hover.parts, ...pad.parts], landing: card });
        hover.start(); pad.start();
      } else if (pad.status === 'fail') {
        finish(e, false, { reason: pad.failReason });
        hover.start(); pad.start();
      } else say(e, pad);
    };
    e.crash = (reason) => { if (e.status !== 'run') { hover.start(); return false; } finish(e, false, { reason }); hover.start(); pad.start(); return true; };
    e.reset = () => { e.status = 'idle'; hover.start(); pad.start(); };
    e.markers = () => ({ type: 'pad', x: pd.x, y: pd.y, z: pd.z, r: pd.r });
    e.progress = () => (e.status === 'run' ? 'Şimdi pede in' : hover.held > 0 ? `Asılı kal: ${hover.progress}` : '');
    return e;
  }

  // ---- best landing: every runway landing ----
  function landingEntry(def) {
    const e = base(def);
    const obj = createObjective({ type: 'land', any: true, minStars: 1, label: def.title }, env(def.score));
    e.onLanding = (card, td) => {
      if (!card || !card.onRunway || card.stars < 1) return;
      obj.start();
      obj.onLanding(card, td);
      obj.message = null;
      if (obj.status === 'done') { e.runs++; finish(e, true, { score: obj.points, stars: card.stars, rows: obj.parts, landing: card }); }
    };
    return e;
  }

  // ---- emergencies: explicit start ----
  function emergencyEntry(def) {
    const e = base(def);
    let obj = null, kindOn = null;
    Object.defineProperty(e, 'target', { get: () => (obj && e.status === 'run' ? obj.target : null) });
    e.targetEnd = null;
    const end = () => {
      e.status = 'idle';
      if (kindOn && hooks.clearFailure) { try { hooks.clearFailure(kindOn); } catch { /* ignore */ } }
      if (hooks.suspendRandom) hooks.suspendRandom(false);
      kindOn = null;
    };
    const check = () => {
      if (!obj) return;
      if (obj.status === 'done') {
        const bs = def.score.base || 0;
        const score = bs + obj.points;
        const stars = obj.ditch ? obj.ditch.stars : obj.landing ? obj.landing.stars : 1;
        end();
        finish(e, true, { score, stars: Math.max(1, stars), time: e.lastT, rows: [['Güvenli iniş', '', bs], ...obj.parts], landing: obj.landing || null });
        obj = null;
      } else if (obj.status === 'fail') {
        const reason = obj.failReason;
        end();
        finish(e, false, { reason, time: e.lastT });
        obj = null;
      } else say(e, obj);
    };
    e.canStart = (s, flight) => {
      if (e.status === 'run') return { ok: false, running: true, reason: 'Sürüyor' };
      if (entries.some((x) => x !== e && x.def.kind === 'emergency' && x.status === 'run')) return { ok: false, reason: 'Önce süren acil durumu bitir' };
      if (flight && (flight.crashed || flight.ditched)) return { ok: false, reason: 'Önce yeniden başla' };
      if (!s || s.onGround || s.agl < 15) return { ok: false, reason: 'Önce havalan' };
      const need = def.need || {};
      if (need.agl && s.agl < need.agl) return { ok: false, reason: `En az ${fmtFt(Math.round(need.agl / FT / 100) * 100)} ft yükseklikte başlat` };
      if (need.water && !isWater(s.x, s.z)) return { ok: false, reason: need.waterText || 'Körfezin (suyun) üstündeyken başlat' };
      if (flight && flight.failures && flight.failures.active && flight.failures.active.size) return { ok: false, reason: 'Zaten bir arıza var' };
      return { ok: true, reason: '' };
    };
    e.start = (s, flight) => {
      const c = e.canStart(s, flight);
      if (!c.ok) return c;
      let target = null;
      if (def.objective.type === 'land') {   // the nearest runway end: pointer / marker target
        let best = Infinity;
        for (const x of ends) {
          const d = Math.hypot((x.aimX ?? x.x) - s.x, (x.aimZ ?? x.z) - s.z);
          if (d < best) { best = d; target = x; }
        }
      }
      e.targetEnd = target;
      obj = createObjective({ ...def.objective, target: target ? target.name : undefined, label: def.title }, env(def.score));
      obj.start();
      const opts = { ...def.failure.opts };
      if (opts.index === 'random') opts.index = Math.random() < 0.5 ? 0 : 1;
      if (hooks.suspendRandom) hooks.suspendRandom(true);
      const ok = hooks.inject ? hooks.inject(def.failure.kind, opts) : false;
      if (!ok) { if (hooks.suspendRandom) hooks.suspendRandom(false); obj = null; return { ok: false, reason: 'Bu uçakta bu arıza yok' }; }
      kindOn = def.failure.kind;
      e.status = 'run'; e.t0 = s.t; e.lastT = 0; e.runs++;
      emit('start', e, null);
      emit('message', e, def.message ? def.message(opts) : def.title);
      return { ok: true, reason: '' };
    };
    e.cancel = () => { if (e.status !== 'run') return; end(); obj = null; emit('abort', e, 'cancel'); };
    e.update = (s) => {
      if (e.status !== 'run') return;
      e.lastT = s.t - e.t0;
      if (e.lastT > def.limit) { end(); obj = null; finish(e, false, { reason: 'Süre doldu', time: e.lastT }); }
    };
    e.onLanding = (card, td) => { if (e.status === 'run' && obj) { obj.onLanding(card, td); check(); } };
    e.onDitch = (d) => {
      if (e.status !== 'run' || !obj) return;
      if (obj.def.type === 'ditch') { obj.onDitch(d); check(); } else { end(); obj = null; finish(e, false, { reason: 'Suya indin', time: e.lastT }); }
    };
    e.crash = (reason, d) => {
      if (e.status !== 'run') return false;
      // a water contact during the ditching: the objective says why (or rates it, for a model without ditching)
      if (obj && obj.def.type === 'ditch' && d && /su/i.test(reason || '')) {
        obj.onDitch(d);
        if (obj.status === 'done') { check(); return 'claimed'; }
      }
      if (obj && obj.status === 'fail') { check(); return true; }
      end(); obj = null;
      finish(e, false, { reason, time: e.lastT });
      return true;
    };
    e.reset = () => { if (e.status === 'run') { end(); obj = null; emit('abort', e, 'reset'); } };
    e.markers = () => {
      if (e.status !== 'run' || !e.targetEnd) return null;
      return { type: 'runway', end: e.targetEnd, heli: category === 'helicopter' };
    };
    e.progress = (s) => (e.status === 'run' ? `Sürüyor · ${fmtTime(s.t - e.t0)}${e.targetEnd ? ` · en yakın pist ${e.targetEnd.name.replace(/^K/, '')}` : ''}` : '');
    return e;
  }

  const MAKE = { bridge: bridgeEntry, gates: gatesEntry, climb: climbEntry, alcatraz: alcatrazEntry, landing: landingEntry, emergency: emergencyEntry };
  const entries = (o.challenges ? o.challenges.filter((c) => c.aircraft.includes(aircraft)) : challengesFor(aircraft)).map((def) => MAKE[def.kind](def));
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

  return {
    entries, byId, aircraft, category,
    update(s) { for (let i = 0; i < entries.length; i++) entries[i].update(s); },
    onLanding(card, td) {
      // emergencies first: their result is the one shown for this landing (the landing entry still records it)
      for (const e of entries) if (e.def.kind === 'emergency') e.onLanding(card, td);
      for (const e of entries) if (e.def.kind !== 'emergency') e.onLanding(card, td);
    },
    onDitch(d) { for (const e of entries) e.onDitch(d); },
    /** A crash: running runs fail. → true when a ditching emergency rated the water contact a success (no crash). */
    onCrash(reason = 'Kaza', d = null) {
      let claimed = false;
      for (const e of entries) { const r = e.crash(reason, d); if (r === 'claimed') claimed = true; }
      return claimed;
    },
    onReset() { for (const e of entries) e.reset(); },
    canStart(id, s, flight) { const e = byId[id]; return e && e.canStart ? e.canStart(s, flight) : { ok: false, reason: '' }; },
    start(id, s, flight) { const e = byId[id]; return e && e.start ? e.start(s, flight) : { ok: false, reason: '' }; },
    cancel(id) { const e = byId[id]; if (e && e.cancel) e.cancel(); },
    running() { return entries.filter((e) => e.status === 'run'); },
  };
}

/** ft/min and kt helpers for the runtime's ditching sample (the same numbers the mission runtime uses). */
export { FPM, KT };
