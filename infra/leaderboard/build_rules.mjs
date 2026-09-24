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
//   node infra/leaderboard/build_rules.mjs
import { writeFileSync, readFileSync } from 'node:fs';

const OUT = new URL('./lambda/rules.json', import.meta.url);
const AIRCRAFT = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];

// objective type → the most points it can award (src/missions/objectives.js)
const OBJECTIVE_MAX = {
  altitude: () => 0,
  bridge: () => 500 + 300,                                            // centre + height
  // gates + optional speed windows (score.gateKt per gate) and corridor (score.low)
  gates: (o, sc) => (o.gates || []).length * ((sc.gate ?? 200) + (sc.gateAcc ?? 100) + (o.kt != null || (o.gates || []).some((g) => g.kt != null) ? sc.gateKt ?? 100 : 0))
    + (Number.isFinite(o.ceiling) ? sc.low ?? 300 : 0),
  hover: () => 300,
  pad: (o, sc) => 400 + (sc.landing ?? 8) * 100,                      // accuracy + landing card (0–100 points)
  land: (o, sc) => (sc.landing ?? 10) * 100 + (sc.runwayBonus ?? 0),
  ditch: (o, sc) => (sc.ditch ?? 10) * 100,
  orbit: () => 400 + 200 + 200,                                       // radius + height + no restart
  goaround: () => 400,                                                // height kept after the call
};

function maxScore(m, warn) {
  const sc = m.score || {};
  let max = (sc.base || 0) + (sc.par && sc.perSec ? sc.par * sc.perSec : 0);
  for (const o of m.objectives || []) {
    const f = OBJECTIVE_MAX[o.type];
    if (!f) { warn(`${m.id}: unknown objective type "${o.type}" (counted as 2000)`); max += 2000; } else max += f(o, sc);
  }
  return max;
}

const warnings = new Set();
const missions = {};
const DAY0 = Date.UTC(2026, 8, 1);
const counts = [];
/** Rules of one map's catalog (+ free-flight challenges): missions and ff- boards into `missions`. */
async function addMap(name, catalogPath, challengesPath) {
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
  counts.push(`${name}: ${MISSIONS.length} missions + ${challenges.length} free-flight boards`);
  return true;
}
const sfOk = await addMap('San Francisco', '../../src/missions/catalog.js', '../../src/missions/challenges.js');
if (!sfOk) { console.error(`build_rules: keeping ${OUT.pathname}`); process.exit(0); }
await addMap('İstanbul', '../../src/missions/ist/catalog.js', '../../src/missions/ist/challenges.js');
const rules = {
  source: `${counts.join('; ')} (src/missions/catalog.js, challenges.js, ist/catalog.js, ist/challenges.js) via infra/leaderboard/build_rules.mjs`,
  strict: true,
  aircraft: AIRCRAFT,
  default: { scoreMin: 0, scoreMax: 100000, secMin: 1, secMax: 7200 },
  missions,
  test: ['selftest'],
};
const text = `${JSON.stringify(rules, null, 1)}\n`;
let old = '';
try { old = readFileSync(OUT, 'utf8'); } catch { /* first run */ }
if (old !== text) writeFileSync(OUT, text);
for (const w of warnings) console.error(`build_rules: ${w}`);
console.error(`build_rules: ${counts.join('; ')} → lambda/rules.json${old === text ? ' (unchanged)' : ''}`);
