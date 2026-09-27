// Retention tests: daily streak and badges, the weekly challenge (ISO weeks of the Istanbul calendar, the pick, its
// board ids against the leaderboard's rules), challenge links, the "Yenilikler" selection, and the landing challenges
// (İniş serisi, Günün inişi) on the free-flight tracker with real landing scores. The UI is covered by the Playwright
// scripts. Run: node tests/retention.test.mjs   (no framework, no network: PASS/FAIL table, exit 1 on failure)
import { readFileSync } from 'node:fs';
import { readStreak, writeStreak, recordDay, recordLanding, streakView, badgeProgress, pickedBadge, bucket, dayDiff, BADGES, STORE } from '../src/retention/streak.js';
import { isoWeek, parseWeek, weekMonday, addWeeks, currentWeek, weekIndex, secondsToNextWeek, weekLabel, fmtLeft, weeklyPick, weeklyFor, WEEKLY_POOL } from '../src/retention/weekly.js';
import { parseChallenge, challengeUrl, challengeOutcome, briefLine, resultLine, challengeCap, CHALLENGE_MAX } from '../src/retention/challenge-link.js';
import { missionMaxScore } from '../src/missions/score-max.js';
import { buildMission as buildSfMission } from '../src/missions/catalog.js';
import { buildMission as buildIstMission } from '../src/missions/ist/catalog.js';
import { pendingNews } from '../src/retention/news.js';
import { landingChallenges, landingEndNames, dailyLandingEnd, endLabel, maxLandingChallengeScore, NO_DAILY_LANDING } from '../src/missions/landing-challenges.js';
import { BACKUP_RUNWAYS } from '../src/missions/ist/catalog.js';
import { createChallengeTracker, CHALLENGES, maxChallengeScore } from '../src/missions/challenges.js';
import { MISSIONS } from '../src/missions/catalog.js';
import { MISSIONS as IST_MISSIONS } from '../src/missions/ist/catalog.js';
import { CHALLENGES as IST_CHALLENGES } from '../src/missions/ist/challenges.js';
import { scoreLanding } from '../src/missions/landing-score.js';
import { runwayEnds } from '../src/flight/fixedwing-autopilot.js';
import { istanbulDay, DEG, FPM } from '../src/missions/util.js';
import { checkScore, checkTop, istWeek } from '../infra/leaderboard/lambda/validate.mjs';
import CHANGELOG from '../src/data/changelog.json' with { type: 'json' };

const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

// ---- streak ---------------------------------------------------------------------------------------------------------
{
  const st = memStore();
  let s = readStreak(st);
  check('streak: empty store → fresh state, 0 days', s.days.length === 0 && streakView(s, '20260927').current === 0 && !streakView(s, '20260927').today);
  let r = recordDay(s, '20260925');
  check('streak: first day → 1, new day, no badge', r.newDay && r.current === 1 && r.unlocked.length === 0);
  check('streak: same day twice counts once', !recordDay(s, '20260925').newDay && s.days.length === 1);
  r = recordDay(s, '20260926'); const r3 = recordDay(s, '20260927');
  check('streak: 3 days in a row → 3, badge d3 (Düzenli pilot) unlocked once', r.current === 2 && r3.current === 3 && r3.unlocked.map((b) => b.id).join() === 'd3' && s.badges.d3 === '20260927');
  writeStreak(s, st);
  s = readStreak(st);
  check('streak: stored and read back', s.days.join() === '20260925,20260926,20260927' && s.best === 3 && s.badges.d3);
  const v1 = streakView(s, '20260928');
  check('streak: the next day, not flown yet → still 3, at risk', v1.current === 3 && v1.atRisk && !v1.today);
  const v2 = streakView(s, '20260929');
  check('streak: a day missed → 0 (best stays 3)', v2.current === 0 && v2.best === 3);
  r = recordDay(s, '20260929');
  check('streak: after a gap it starts over at 1', r.current === 1 && r.best === 3 && r.newDay);
  const t = memStore(); const q = readStreak(t);
  for (let i = 0; i < 31; i++) recordDay(q, new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''));
  check('streak: 30+ days in a row → d3, d7, d14, d30 unlocked; bucket 30+', ['d3', 'd7', 'd14', 'd30'].every((id) => q.badges[id]) && streakView(q, '20261001').current === 31 && bucket(31) === '30+');
  check('streak: kept days capped at 60, a longer run still counts (it stopped at 60)', (() => { const z = readStreak(memStore()); for (let i = 0; i < 90; i++) recordDay(z, new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, '')); return z.days.length === 60 && streakView(z, '20260331').current === 90 && z.best === 90; })());
  check('streak: a 75-day run survives a write / read and goes on; a gap after it starts over', (() => {
    const st = memStore(); let z = readStreak(st);
    for (let i = 0; i < 75; i++) recordDay(z, new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, ''));
    writeStreak(z, st); z = readStreak(st);
    const a = streakView(z, '20260317').current, b = recordDay(z, '20260317').current, c = recordDay(z, '20260320').current;
    return a === 75 && b === 76 && c === 1 && z.best === 76 && z.run0 === null;
  })());
  check('streak: stored days of the wrong type are dropped (a number threw in the menu)', (() => { const g = memStore(); g.setItem(STORE, JSON.stringify({ days: [20260926, '20260927'], run0: 5 })); const z = readStreak(g); return z.days.join() === '20260927' && z.run0 === null && streakView(z, '20260927').current === 1; })());
  check('streak: clock set back → later days dropped, no negative run', (() => { const z = readStreak(memStore()); recordDay(z, '20260910'); recordDay(z, '20260911'); const x = recordDay(z, '20260905'); return z.days.join() === '20260905' && x.current === 1; })());
  check('streak: buckets', bucket(0) === '0' && bucket(1) === '1' && bucket(2) === '2' && bucket(3) === '3-6' && bucket(7) === '7-13' && bucket(14) === '14-29' && dayDiff('20261231', '20270101') === 1);
  const garbage = memStore(); garbage.setItem(STORE, JSON.stringify({ days: ['x', '20260101', '20260101'], best: -3, badges: { d3: '20260101', bogus: 1 }, pick: 'bogus', land: { cur: 'a' } }));
  const gs = readStreak(garbage);
  check('streak: bad stored data sanitised', gs.days.join() === '20260101' && gs.best === 0 && gs.badges.d3 && !gs.badges.bogus && gs.pick === null && gs.land.cur === 0);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  check('streak: storage throwing (private mode) → fresh state, write ignored', readStreak(broken).days.length === 0 && (writeStreak(gs, broken), true));
  // landing streak badge
  const L = readStreak(memStore());
  recordLanding(L, true, '20260927'); recordLanding(L, true, '20260927');
  const l3 = recordLanding(L, true, '20260927');
  recordLanding(L, false, '20260927');
  check('landing streak: 3 successful landings in a row → l3 (İniş serisi) badge; a bad one resets the run, best kept', l3.cur === 3 && l3.unlocked.map((b) => b.id).join() === 'l3' && L.land.cur === 0 && L.land.best === 3);
  check('badges: progress and pick', badgeProgress(L, BADGES.find((b) => b.id === 'l10'), '20260927').have === 3 && (L.pick = 'l3', pickedBadge(L).title === 'İniş serisi')
    && (L.pick = 'd30', pickedBadge(L) === null) && BADGES.every((b) => /^#[0-9a-f]{6}$/.test(b.color) && b.title && b.colorName));
}

// ---- weekly ---------------------------------------------------------------------------------------------------------
{
  check('weekly: ISO weeks (Monday first, week 1 holds 4 January, 53-week years)', isoWeek('20260101') === '202601' && isoWeek('20251229') === '202601' && isoWeek('20260104') === '202601'
    && isoWeek('20260105') === '202602' && isoWeek('20260927') === '202639' && isoWeek('20260928') === '202640' && isoWeek('20270103') === '202653' && isoWeek('20270104') === '202701'
    && isoWeek('20210103') === '202053');
  check('weekly: parse / Monday / add', parseWeek('202653') === '202653' && parseWeek('202753') === null && parseWeek('202600') === null && parseWeek('x') === null
    && weekMonday('202640') === '20260928' && addWeeks('202601', -1) === '202552' && addWeeks('202653', 1) === '202701' && weekIndex('202601') === 0);
  // the Istanbul week changes at Sunday 21:00 UTC (Monday 00:00 UTC+3), the same boundary the server uses
  const a = new Date(Date.UTC(2026, 8, 27, 20, 59)), b = new Date(Date.UTC(2026, 8, 27, 21, 0));
  check('weekly: Istanbul week boundary = the server\'s (validate.mjs istWeek)', currentWeek(a) === '202639' && currentWeek(b) === '202640' && istWeek(a.getTime()) === '202639' && istWeek(b.getTime()) === '202640');
  let agree = true;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 7 * 3600e3) if (currentWeek(new Date(t)) !== istWeek(t)) { agree = false; break; }
  check('weekly: client and server weeks agree every 7 h over two years', agree);
  check('weekly: countdown to Monday 00:00 Istanbul', secondsToNextWeek(new Date(Date.UTC(2026, 8, 27, 20, 0))) === 3600 && secondsToNextWeek(new Date(Date.UTC(2026, 8, 27, 21, 0))) === 7 * 86400
    && fmtLeft(3 * 86400 + 4 * 3600) === '3 gün 4 sa' && fmtLeft(3600 * 5 + 1200) === '5 sa 20 dk' && fmtLeft(30) === '1 dk');
  check('weekly: labels', weekLabel('202640') === '40. hafta · 28 Eylül – 4 Ekim' && weekLabel('202639') === '39. hafta · 21–27 Eylül');
  const picks = [];
  for (let i = 0; i < WEEKLY_POOL.length * 2; i++) picks.push(weeklyPick(addWeeks('202640', i)));
  check('weekly: deterministic rotation from week 2026-40 (pool order), every entry once per round, never the same twice running',
    picks[0].key === 'low-pass' && picks[WEEKLY_POOL.length].key === 'low-pass' && new Set(picks.slice(0, WEEKLY_POOL.length).map((p) => p.key)).size === WEEKLY_POOL.length
    && picks.every((p, i) => i === 0 || p.key !== picks[i - 1].key) && JSON.stringify(weeklyPick('202645')) === JSON.stringify(weeklyPick('202645')));
  const ids = new Set([...MISSIONS.map((m) => m.id), ...IST_MISSIONS.map((m) => m.id)]);
  const ff = new Set([...CHALLENGES, ...IST_CHALLENGES, ...landingChallenges('sf'), ...landingChallenges('ist')].map((c) => `${c.id}|${c.board}`));
  const locked = new Set([...MISSIONS, ...IST_MISSIONS].filter((m) => m.unlock).map((m) => m.id));
  const bad = WEEKLY_POOL.filter((p) => (p.mission ? !ids.has(p.mission) || locked.has(p.mission) : !ff.has(`${p.ff}|${p.board}`) || !p.spawn) || (p.map && p.map !== 'ist'));
  check('weekly: pool = unlocked missions and free-flight challenges of both maps (with a start point), both maps and kinds', bad.length === 0 && WEEKLY_POOL.some((p) => p.ff) && WEEKLY_POOL.some((p) => p.map === 'ist'),
    bad.map((p) => p.mission || p.ff).join(' '));
  const rules = JSON.parse(readFileSync(new URL('../infra/leaderboard/lambda/rules.json', import.meta.url), 'utf8'));
  const now = Date.UTC(2026, 8, 30, 12);   // week 40
  const refused = [];
  for (const p of picks) {
    const r = rules.missions[p.base];
    const body = { mission: p.board, score: Math.min(r.scoreMax, Array.isArray(r.stars) ? r.stars[0] : 1000), stars: 1, ac: r.aircraft[0], sid: 'WeeklyTestPlayerKey_01' };
    if (p.board.length > 40 || !checkTop({ mission: p.board }, { rules, stage: 'production', now }).ok) refused.push(`${p.board} top`);
    if (p.week === '202640' && !checkScore(body, { rules, stage: 'production', now }).ok) refused.push(`${p.board} score ${JSON.stringify(checkScore(body, { rules, stage: 'production', now }))}`);
  }
  check('weekly: every pick\'s board is accepted by the shipped leaderboard rules (this week: scores; ≤ 8 weeks back: reads)', refused.filter((x) => !/top/.test(x) || !/w-20264[2-9]|w-20265|w-2027/.test(x)).length === 0, refused.join(' '));
  const d = new Date(Date.UTC(2026, 8, 30, 12)), wp = weeklyPick('202640');
  check('weekly: a run belongs to the week\'s pick (plain mission, not the daily variation; or the free-flight challenge)', weeklyFor({ mission: wp.mission }, d) && !weeklyFor({ mission: wp.mission, daily: '20260930' }, d)
    && !weeklyFor({ mission: 'climb' }, d) && !weeklyFor({ ff: 'bridge' }, d) && weeklyFor({ ff: 'bridge' }, new Date(Date.UTC(2026, 9, 6, 12))).board === 'w-202641-ff-bridge');
}

// ---- challenge links ------------------------------------------------------------------------------------------------
{
  const c = parseChallenge('?mission=low-pass&challenge=2450');
  check('challenge link: parsed', c && c.id === 'low-pass' && c.score === 2450 && c.day === null);
  check('challenge link: daily day kept', parseChallenge('?mission=climb&daily=20260927&challenge=1800').day === '20260927');
  check('challenge link: bad values ignored', [
    '?mission=low-pass', '?challenge=100', '?mission=low-pass&challenge=0', '?mission=low-pass&challenge=-5', '?mission=low-pass&challenge=12.5', '?mission=low-pass&challenge=99999999',
    '?mission=<x>&challenge=5', '?mission=low-pass&challenge=1e3', '?mission=low-pass&challenge=%3Cscript%3E',
  ].every((q) => parseChallenge(q) === null));
  const u = challengeUrl('https://fs.erenailab.com/?aircraft=f16#x', { id: 'low-pass', score: 2450.4 });
  check('challenge link: built on the page origin + path, only mission / daily / challenge', u === 'https://fs.erenailab.com/?mission=low-pass&challenge=2450'
    && challengeUrl('https://staging.example/index.html', { id: 'climb', day: '20260927', score: 1800 }) === 'https://staging.example/index.html?mission=climb&daily=20260927&challenge=1800', u);
  check('challenge link: outcome beat / tie / short / fail', challengeOutcome(c, { ok: true, score: 2610 }) === 'beat' && challengeOutcome(c, { ok: true, score: 2450 }) === 'tie'
    && challengeOutcome(c, { ok: true, score: 2000 }) === 'short' && challengeOutcome(c, { ok: false, score: 0 }) === 'fail' && challengeOutcome(null, { ok: true }) === null);
  check('challenge link: Turkish lines (thousands separator, diacritics)', briefLine(c) === 'Arkadaşın 2.450 puan yaptı — geçebilir misin?'
    && resultLine(c, { ok: true, score: 2610 }).title === 'Arkadaşını geçtin!' && /160 puan kaldı/.test(resultLine(c, { ok: true, score: 2290 }).text)
    && /2\.610 > 2\.450/.test(resultLine(c, { ok: true, score: 2610 }).text));
  // a crafted link cannot put an impossible score on the briefing ("Arkadaşın 999.999 puan yaptı")
  const RULES = JSON.parse(readFileSync(new URL('../infra/leaderboard/lambda/rules.json', import.meta.url), 'utf8'));
  const caps = [...MISSIONS.map((m) => [m.id, buildSfMission(m.id)]), ...IST_MISSIONS.map((m) => [m.id, buildIstMission(m.id)])]
    .map(([id, built]) => ({ id, cap: challengeCap(missionMaxScore(built)), stars: built.stars, rule: RULES.missions[id] }));
  const capBad = caps.filter((x) => !(x.cap > 0 && x.cap < CHALLENGE_MAX && (!x.rule || x.cap <= x.rule.scoreMax)
    && (!Array.isArray(x.stars) || x.cap >= x.stars[2])));
  check('challenge link: every mission has a cap above its 3-star score and within the leaderboard maximum', caps.length >= 20 && capBad.length === 0,
    capBad.map((x) => `${x.id}:${x.cap}`).join(' '));
  const lp = caps.find((x) => x.id === 'low-pass');
  check('challenge link: a score above the mission cap is ignored, the cap itself accepted', parseChallenge(`?mission=low-pass&challenge=${lp.cap + 1}`, { max: lp.cap }) === null
    && parseChallenge(`?mission=low-pass&challenge=${lp.cap}`, { max: lp.cap }).score === lp.cap && parseChallenge('?mission=low-pass&challenge=999999', { max: lp.cap }) === null
    && parseChallenge('?mission=low-pass&challenge=999999').score === 999999 && challengeCap(0) === CHALLENGE_MAX && challengeCap(NaN) === CHALLENGE_MAX, JSON.stringify(lp));
}

// ---- what's new ---------------------------------------------------------------------------------------------------------
{
  const E = [{ id: '2026-09-28', title: 'B', items: ['b'] }, { id: '2026-09-20', title: 'A', items: ['a'] }, { id: '2026-10-05', title: 'C', items: ['c'] }, { id: 'x', items: [] }];
  check('news: returning player with a stored version → newer entries, newest first', pendingNews(E, '2026-09-20', true).show.map((e) => e.id).join() === '2026-10-05,2026-09-28' && pendingNews(E, '2026-09-20', true).latest === '2026-10-05');
  check('news: up to date → nothing', pendingNews(E, '2026-10-05', true).show.length === 0);
  check('news: first visit → nothing (the newest id is stored)', pendingNews(E, null, false).show.length === 0 && pendingNews(E, null, false).latest === '2026-10-05');
  check('news: a returning player from before the card → the newest entry only', pendingNews(E, null, true).show.map((e) => e.id).join() === '2026-10-05');
  check('news: bad file → nothing', pendingNews(null, null, true).show.length === 0 && pendingNews([{ id: 1 }], 'x', true).show.length === 0);
  const bad = (CHANGELOG.entries || []).filter((e) => !/^\d{4}-\d{2}-\d{2}[a-z]?$/.test(e.id) || !e.title || !Array.isArray(e.items) || !e.items.length || e.items.some((t) => typeof t !== 'string' || t.length > 200));
  check('news: src/data/changelog.json entries well formed (id YYYY-MM-DD, title, 1+ short Turkish items)', (CHANGELOG.entries || []).length >= 1 && bad.length === 0, JSON.stringify(bad));
}

// ---- landing challenges -------------------------------------------------------------------------------------------------
{
  const RW = { sf: JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8')), ist: JSON.parse(readFileSync(new URL('../data/ist/runways.json', import.meta.url), 'utf8')) };
  for (const map of ['sf', 'ist']) {
    const ends = runwayEnds(RW[map]);
    const fromEnds = [...new Set(ends.filter((x) => x.landing !== false && x.length >= 2000 && !NO_DAILY_LANDING.includes(x.name)).map((x) => x.name))].sort();
    const names = landingEndNames(RW[map]);
    check(`landing (${map}): the menu's runway list (runways.json) = the tracker's (runway ends ≥ 2 km that take landings)`, names.join() === fromEnds.join() && names.length >= 6
      && (map !== 'ist' || (!names.includes('LTFM 09') && !names.includes('LTFM 27') && BACKUP_RUNWAYS.every((r) => NO_DAILY_LANDING.includes(r) && !names.includes(r)))) && (map !== 'sf' || (!names.includes('KOAK 15') && !names.includes('KSFO 01R') && names.includes('KSFO 28R'))), names.join(' '));
    const seen = new Set(); let repeats = 0, prev = null;
    for (let i = 0; i < 120; i++) {
      const day = new Date(Date.UTC(2026, 8, 1) + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
      const e = dailyLandingEnd(names, day, map);
      seen.add(e); if (e === prev) repeats++; prev = e;
    }
    check(`landing (${map}): Günün inişi — one runway per day, the same for everyone, rotating over most runways, never twice in a row`,
      dailyLandingEnd(names, '20260927', map) === dailyLandingEnd([...names].reverse(), '20260927', map) && seen.size >= names.length - 2 && repeats === 0, `${seen.size}/${names.length}`);
    const lc = landingChallenges(map);
    check(`landing (${map}): İniş serisi + Günün inişi, boards ${lc.map((c) => c.board).join(' / ')}`, lc.length === 2 && lc.every((c) => c.board.startsWith('ff-') && c.board.length <= 31 && c.final && c.aircraft.length === 5)
      && maxLandingChallengeScore(lc[0]) === 3000 && maxLandingChallengeScore(lc[1]) === 2000 && maxChallengeScore(lc[0]) === 3000 && maxChallengeScore(lc[1]) === 2000);
  }
  check('landing: runway labels', endLabel('KSFO 28R') === 'SFO 28R' && endLabel('LTFJ 06L') === 'Sabiha Gökçen 06L' && endLabel('KXXX 01') === 'KXXX 01');

  // the tracker with real landing scores
  const ENDS = runwayEnds(RW.sf);
  const card = (name, o = {}) => {
    const e = ENDS.find((r) => r.name === name);
    const along = o.along ?? 380, lat = o.lat ?? 0;
    const td = { x: e.x + e.dx * along - e.dz * lat, z: e.z + e.dz * along + e.dx * lat, heading: e.course / DEG, track: e.course / DEG, vs: -(o.fpm ?? 120) / FPM, roll: 0, pitch: 4, gs: 70, onRunway: o.on ?? true };
    return { card: scoreLanding(td, { category: 'airliner', ends: ENDS }), td };
  };
  const ev = [];
  const tr = createChallengeTracker({ aircraft: 'a320neo', category: 'airliner', ends: ENDS, challenges: landingChallenges('sf'), map: 'sf', emit: (type, e, data) => ev.push({ type, id: e.id, data }) });
  const land = (name, o) => { const c = card(name, o); tr.onLanding(c.card, c.td); return c.card; };
  const c1 = land('KSFO 28R', { fpm: 90 }), c2 = land('KOAK 30', { fpm: 200 });
  const midRun = tr.byId['land-series'].status === 'run' && tr.byId['land-series'].count === 2;
  tr.onReset();   // R: the series goes on
  const c3 = land('KNGZ 24', { fpm: 150 });
  const done = ev.find((x) => x.type === 'done' && x.id === 'land-series');
  check('İniş serisi: 3 runway landings (reset between allowed) → done: points × 10, the weakest landing\'s stars, 3 rows', midRun && done && done.data.score === (c1.points + c2.points + c3.points) * 10
    && done.data.stars === Math.min(c1.stars, c2.stars, c3.stars) && done.data.rows.length === 3 && done.data.board === 'ff-land-series' && tr.byId['land-series'].status === 'idle',
    done && JSON.stringify(done.data.rows));
  ev.length = 0;
  land('KSFO 28L', { fpm: 100 }); land('KSFO 28L', { fpm: 100, lat: 45, on: false });
  check('İniş serisi: an off-runway landing breaks it (abort broken, message), no result', ev.some((x) => x.type === 'abort' && x.data === 'broken') && !ev.some((x) => x.type === 'done' && x.id === 'land-series') && tr.byId['land-series'].count === 0);
  land('KSFO 28L', { fpm: 100 });
  const crashAbort = (tr.onCrash('Kaza'), ev.filter((x) => x.type === 'abort' && x.data === 'broken').length === 2);
  check('İniş serisi: a crash breaks it (not a failed run)', crashAbort && !ev.some((x) => x.type === 'fail'));
  { // İstanbul: a good landing on a departure-only runway breaks the series with that reason (it said "en az 1 yıldız gerekli")
    const { loadMissionCatalog } = await import('../src/missions/catalog.js');
    const catalog = await loadMissionCatalog('ist', RW.ist);
    const msgs = [];
    const ti = createChallengeTracker({ aircraft: 'a320neo', category: 'airliner', ends: runwayEnds(RW.ist), catalog, map: 'ist', challenges: landingChallenges('ist'), emit: (type, e, data) => { if (type === 'message') msgs.push(data); } });
    const cardIst = (runway) => ({ onRunway: true, runway, stars: 3, points: 92, fpm: 150, cat: 'airliner' });
    ti.onLanding(cardIst('LTFM 35R'), { x: 0, z: 0 }); ti.onLanding(cardIst('LTFM 09'), { x: 0, z: 0 });
    check('İniş serisi (İstanbul): a 3★ landing on a departure-only runway breaks it with that reason', msgs.some((m) => /bozuldu: bu pist yalnız kalkışa açık/.test(m)), msgs.filter((m) => /bozuldu/.test(m)).join(' | '));
  }
  // Günün inişi: only the day's runway counts
  ev.length = 0;
  const e = tr.byId['daily-land'];
  const today = istanbulDay();
  const target = e.targetEnd.name, other = ENDS.find((x) => x.name !== target && x.landing !== false && x.length > 2000).name;
  land(other, { fpm: 100 });
  const wrong = ev.find((x) => x.type === 'message' && x.id === 'daily-land');
  const tc = land(target, { fpm: 110 });
  const dd = ev.find((x) => x.type === 'done' && x.id === 'daily-land');
  check(`Günün inişi: another runway → a hint only; the day's runway (${target}) → done, points × 20, day = today (daily board)`, wrong && /bugün/.test(wrong.data) && dd && dd.data.score === tc.points * 20
    && dd.data.stars === tc.stars && dd.data.day === today && e.day === today && e.target && Math.abs(e.target.x - (e.targetEnd.aimX ?? e.targetEnd.x)) < 1 && e.markers().type === 'runway',
    dd && JSON.stringify(dd.data).slice(0, 200));
  check('Günün inişi: same runway for the menu (runways.json) and the tracker today', dailyLandingEnd(landingEndNames(RW.sf), today, 'sf') === target);
}

// ---- report -------------------------------------------------------------------------------------------------------------
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
