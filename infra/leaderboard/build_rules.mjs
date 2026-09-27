// Plausibility rules for the leaderboard Lambda, derived from the missions catalog (src/missions/catalog.js, owned by
// the missions agent). Writes infra/leaderboard/lambda/rules.json; infra/leaderboard/setup.py runs this before every
// upload, so a new or changed mission only needs `setup.py <target> --code`.
//
// Per mission: the only allowed aircraft, the highest score the scoring can give (base + the full time bonus + every
// objective's maximum, over the default and 120 daily variations, +10 % margin), the time limit (+60 s), the star
// thresholds (a submission may not claim more stars than its score earns; landing/ditch missions rate the touchdown
// instead) and at least one star (only completed runs are submitted). Unknown mission ids are refused (strict).
// Free-flight challenges (src/missions/challenges.js) get their own boards `ff-<id>` (not comparable to the missions:
// any start, every fitting aircraft): the challenge's aircraft, its highest score (+10 %), its run limit (+60 s; no
// limit: the default) and star thresholds; no daily boards.
// Maps: San Francisco (src/missions/catalog.js + challenges.js) and İstanbul (src/missions/ist/catalog.js +
// challenges.js: missions `ist-<name>`, boards `ff-ist-<name>`), one rules file for both.
// Landing challenges on every map (src/missions/landing-challenges.js): İniş serisi `ff-land-series` / `ff-ist-land-series`
// and Günün inişi `ff-daily-land` / `ff-ist-daily-land` (daily boards only). Weekly boards `w-<yyyyww>-<board>` of any
// board above (src/retention/weekly.js) are enabled by `weekly` (read back 8 weeks, expire 35 days after their week);
// assisted boards `as-<board>` / `w-<yyyyww>-as-<board>` (the "Destekli" list, src/retention/boards.js) by `assisted`.
//   node infra/leaderboard/build_rules.mjs
import { writeFileSync, readFileSync } from 'node:fs';
import { missionMaxScore } from '../../src/missions/score-max.js';

const OUT = new URL('./lambda/rules.json', import.meta.url);
const AIRCRAFT = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];

// the most points a mission can give (src/missions/score-max.js, also used by the challenge links)
const maxScore = (m, warn) => missionMaxScore(m, warn);

const warnings = new Set();
const missions = {};
const DAY0 = Date.UTC(2026, 8, 1);
const counts = [];
/** Rules of one map's catalog (+ free-flight challenges): missions and ff- boards into `missions`. */
async function addMap(name, mapId, catalogPath, challengesPath) {
  let catalog;
  try {
    catalog = await import(catalogPath);
  } catch (e) {
    console.error(`build_rules: ${catalogPath} not usable (${e.message}); ${name} skipped`);
    return false;
  }
  const { MISSIONS, buildMission } = catalog;
  for (const def of MISSIONS) {
    if (missions[def.id]) { warnings.add(`${def.id}: duplicate mission id (${name})`); continue; }
    let max = 0, limit = 0;
    const variants = [buildMission(def.id)];
    for (let i = 0; i < 120; i++) variants.push(buildMission(def.id, new Date(DAY0 + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, '')));
    for (const m of variants) {
      max = Math.max(max, maxScore(m, (w) => warnings.add(w)));
      limit = Math.max(limit, m.limit || 0);
    }
    const stars = variants[0].stars;
    missions[def.id] = {
      aircraft: AIRCRAFT.includes(def.aircraft) ? [def.aircraft] : AIRCRAFT,
      scoreMin: 0, scoreMax: Math.ceil(max * 1.1), secMin: 3, secMax: limit ? limit + 60 : 7200, starsMin: 1,
      ...(Array.isArray(stars) && stars.length === 3 ? { stars } : {}),
      daily: typeof def.daily === 'function',
    };
  }
  // free-flight challenges: boards ff-<id>
  let challenges = [];
  try {
    const ch = await import(challengesPath);
    challenges = ch.CHALLENGES;
    for (const c of challenges) {
      if (missions[c.board]) { warnings.add(`${c.board}: clashes with a mission id or another board`); continue; }
      missions[c.board] = {
        aircraft: c.aircraft.filter((a) => AIRCRAFT.includes(a)),
        scoreMin: 0, scoreMax: Math.ceil(ch.maxChallengeScore(c) * 1.1), secMin: 1, secMax: c.limit ? c.limit + 60 : 7200, starsMin: 1,
        ...(Array.isArray(c.stars) && c.stars.length === 3 ? { stars: c.stars } : {}),
        daily: false,
      };
    }
  } catch (e) {
    console.error(`build_rules: ${challengesPath} not usable (${e.message}); no ${name} free-flight boards`);
  }
  // landing challenges (every map): İniş serisi, Günün inişi (daily boards only)
  let landing = [];
  try {
    const lc = await import('../../src/missions/landing-challenges.js');
    landing = lc.landingChallenges(mapId);
    for (const c of landing) {
      if (missions[c.board]) { warnings.add(`${c.board}: clashes with a mission id or another board`); continue; }
      missions[c.board] = {
        aircraft: c.aircraft.filter((a) => AIRCRAFT.includes(a)),
        scoreMin: 0, scoreMax: Math.ceil(lc.maxLandingChallengeScore(c) * 1.1), secMin: 1, secMax: 7200, starsMin: 1,
        daily: !!c.daily, ...(c.daily ? { dailyOnly: true } : {}),
      };
    }
  } catch (e) {
    console.error(`build_rules: landing challenges not usable (${e.message}); no ${name} landing boards`);
  }
  counts.push(`${name}: ${MISSIONS.length} missions + ${challenges.length + landing.length} free-flight boards`);
  return true;
}
const sfOk = await addMap('San Francisco', 'sf', '../../src/missions/catalog.js', '../../src/missions/challenges.js');
if (!sfOk) { console.error(`build_rules: keeping ${OUT.pathname}`); process.exit(0); }
await addMap('İstanbul', 'ist', '../../src/missions/ist/catalog.js', '../../src/missions/ist/challenges.js');
const rules = {
  source: `${counts.join('; ')} (src/missions/catalog.js, challenges.js, landing-challenges.js, ist/catalog.js, ist/challenges.js) via infra/leaderboard/build_rules.mjs`,
  strict: true,
  aircraft: AIRCRAFT,
  default: { scoreMin: 0, scoreMax: 100000, secMin: 1, secMax: 7200 },
  weekly: { back: 8, ttlDays: 35 },
  assisted: true,
  missions,
  test: ['selftest'],
};
const text = `${JSON.stringify(rules, null, 1)}\n`;
let old = '';
try { old = readFileSync(OUT, 'utf8'); } catch { /* first run */ }
if (old !== text) writeFileSync(OUT, text);
for (const w of warnings) console.error(`build_rules: ${w}`);
console.error(`build_rules: ${counts.join('; ')} → lambda/rules.json${old === text ? ' (unchanged)' : ''}`);
