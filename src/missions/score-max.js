// The highest score a mission can give (base + the full time bonus + every objective's maximum), shared by the
// leaderboard's plausibility rules (infra/leaderboard/build_rules.mjs adds a 10 % margin over 120 daily variations) and
// the challenge links (src/retention/mission-hooks.js: a "Beni geç" link claiming more than the mission can give is
// ignored). Pure; `m` is a built mission (src/missions/catalog.js buildMission).

// objective type → the most points it can award (src/missions/objectives.js)
export const OBJECTIVE_MAX = {
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
export const UNKNOWN_OBJECTIVE_MAX = 2000;

/** Highest score of a built mission; `warn(text)` hears about objective types missing from OBJECTIVE_MAX. */
export function missionMaxScore(m, warn = () => {}) {
  const sc = (m && m.score) || {};
  let max = (sc.base || 0) + (sc.par && sc.perSec ? sc.par * sc.perSec : 0);
  for (const o of (m && m.objectives) || []) {
    const f = Object.prototype.hasOwnProperty.call(OBJECTIVE_MAX, o.type) ? OBJECTIVE_MAX[o.type] : null;
    if (!f) { warn(`${m.id}: unknown objective type "${o.type}" (counted as ${UNKNOWN_OBJECTIVE_MAX})`); max += UNKNOWN_OBJECTIVE_MAX; } else max += f(o, sc);
  }
  return max;
}
