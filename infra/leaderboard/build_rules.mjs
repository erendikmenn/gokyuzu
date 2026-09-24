// Plausibility rules for the leaderboard Lambda, derived from the missions catalog (src/missions/catalog.js, owned by
// the missions agent). Writes infra/leaderboard/lambda/rules.json; infra/leaderboard/setup.py runs this before every
// upload, so a new or changed mission only needs `setup.py <target> --code`.
//
// Per mission: the only allowed aircraft, the highest score the scoring can give (base + the full time bonus + every
// objective's maximum, over the default and 120 daily variations, +10 % margin), the time limit (+60 s), the star
// thresholds (a submission may not claim more stars than its score earns; landing/ditch missions rate the touchdown
// instead) and at least one star (only completed runs are submitted). Unknown mission ids are refused (strict).
//   node infra/leaderboard/build_rules.mjs
import { writeFileSync, readFileSync } from 'node:fs';

const OUT = new URL('./lambda/rules.json', import.meta.url);
const AIRCRAFT = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];

// objective type → the most points it can award (src/missions/objectives.js)
const OBJECTIVE_MAX = {
  altitude: () => 0,
  bridge: () => 500 + 300,                                            // centre + height
  gates: (o, sc) => (o.gates || []).length * ((sc.gate ?? 200) + (sc.gateAcc ?? 100)),
  hover: () => 300,
  pad: (o, sc) => 400 + (sc.landing ?? 8) * 100,                      // accuracy + landing card (0–100 points)
  land: (o, sc) => (sc.landing ?? 10) * 100 + (sc.runwayBonus ?? 0),
  ditch: (o, sc) => (sc.ditch ?? 10) * 100,
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

let catalog;
try {
  catalog = await import('../../src/missions/catalog.js');
} catch (e) {
  console.error(`build_rules: src/missions/catalog.js not usable (${e.message}); keeping ${OUT.pathname}`);
  process.exit(0);
}
const { MISSIONS, buildMission } = catalog;
const warnings = new Set();
const missions = {};
const DAY0 = Date.UTC(2026, 8, 1);
for (const def of MISSIONS) {
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
const rules = {
  source: `src/missions/catalog.js (${MISSIONS.length} missions) via infra/leaderboard/build_rules.mjs`,
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
console.error(`build_rules: ${MISSIONS.length} missions → lambda/rules.json${old === text ? ' (unchanged)' : ''}`);
