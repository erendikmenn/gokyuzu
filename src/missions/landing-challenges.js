// Landing-focused free-flight challenges, on every map (CONTRACTS-SF.md §12.1; run by the tracker in
// src/missions/challenges.js, added to a map's set by src/missions/ff-runtime.js and to the leaderboard rules by
// infra/leaderboard/build_rules.mjs):
//   İniş serisi   3 successful runway landings in a row (≥ 1★, any airport); a crash, an off-runway or a 0★ touchdown
//                 starts it over, a flight reset does not (land, R, land again). Score: the three landings' points × 10,
//                 stars: the weakest landing's. Board ff-land-series (İstanbul ff-ist-land-series).
//   Günün inişi   one runway end per Istanbul day, the same for everyone (a runway of at least 2 km that takes landings):
//                 land on it, landing points × 20, the landing's stars. Daily board ff-daily-land (&day=YYYYMMDD).
// Both offer "Son yaklaşmaya git" in the panel: a reposition onto the 3° glide path (src/missions/ff-runtime.js).
// Pure data and functions (no DOM): the menu (src/ui/missions-menu.js) picks the same runway from runways.json.
import { hashString, rng, istanbulDay, parseDay } from './util.js';

const ALL = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];
export const DAILY_LAND_MIN_LENGTH = 2000;   // m: short runways (Oakland's 1 km 15/33) are no daily target
const SIBLING = { sf: 'sfo-28r', ist: 'ist-ltfm-inis' };   // "Görev olarak oyna": the map's landing mission
const AIRPORT_SHORT = { KSFO: 'SFO', KOAK: 'Oakland', KNGZ: 'Alameda', LTFM: 'İstanbul Havalimanı', LTFJ: 'Sabiha Gökçen', LTBA: 'Atatürk' };

/** The challenges of a map: ids / boards 'land-series' + 'daily-land' (San Francisco), '<map>-…' elsewhere. */
export function landingChallenges(map = 'sf') {
  const pre = map === 'sf' ? '' : `${map}-`;
  const mission = SIBLING[map] || SIBLING.sf;
  return [
    {
      id: `${pre}land-series`, kind: 'series', need: 3, mission, aircraft: ALL, trackable: false, final: true, title: 'İniş serisi',
      hint: 'Üst üste 3 başarılı pist inişi, herhangi bir havalimanında (en az 1 yıldız). Kaza, pist dışı ya da 0 yıldız seriyi sıfırlar; R ile yeniden başlamak sıfırlamaz. Puan: üç inişin puanı × 10.',
      score: { landing: 10 }, stars: 'landing', board: `ff-${pre}land-series`,
    },
    {
      id: `${pre}daily-land`, kind: 'daily-land', daily: true, mission, aircraft: ALL, trackable: true, final: true, title: 'Günün inişi',
      hint: 'Her gün başka bir pist, herkes için aynı. Bugünün pistine in: iniş puanın × 20. Sıralama her gece yenilenir.',
      score: { landing: 20 }, stars: 'landing', board: `ff-${pre}daily-land`,
    },
  ];
}

/** Runway end names that take landings and are long enough, sorted: 'KSFO 28R', … (runways.json). */
export function landingEndNames(runways, minLength = DAILY_LAND_MIN_LENGTH) {
  const out = [];
  for (const apt of (runways && runways.airports) || []) {
    for (const r of apt.runways || []) {
      const [a, b] = r.ends || [];
      const len = r.length || (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0);
      if (len < minLength || r.departureOnly) continue;
      for (const e of r.ends || []) if (e.landing !== false) out.push(`${apt.icao} ${e.ident}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * The day's runway end name ('KSFO 28R'), the same for everyone on that Istanbul day and map: every runway once per cycle
 * of N days in a shuffled order (like the daily mission), never the same runway two days running.
 */
export function dailyLandingEnd(names, day = istanbulDay(), map = 'sf') {
  const d = parseDay(day) || istanbulDay();
  if (!names || !names.length) return null;
  const list = [...new Set(names)].sort(), n = list.length;
  const order = (cycle) => {
    const ids = [...list], r = rng(hashString(`gokyuzu-land-${map}-cycle-${cycle}`));
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    return ids;
  };
  const i = Math.round((Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - Date.UTC(2026, 0, 1)) / 86400e3);
  const cycle = Math.floor(i / n), pos = ((i % n) + n) % n;
  const o = order(cycle);
  // a new cycle must not start with yesterday's runway (the swap only touches positions 0 and 1, never the last one)
  if (n > 2 && pos <= 1 && o[0] === order(cycle - 1)[n - 1]) [o[0], o[1]] = [o[1], o[0]];
  return o[pos];
}

/** 'SFO 28R' / 'Sabiha Gökçen 06L' */
export function endLabel(name) {
  const [icao, ident] = String(name || '').split(' ');
  return ident ? `${AIRPORT_SHORT[icao] || icao} ${ident}` : String(name || '');
}

/** The highest score a landing challenge gives (build_rules adds a margin). */
export function maxLandingChallengeScore(c) {
  return c.kind === 'series' ? (c.need || 3) * 100 * (c.score.landing || 10) : 100 * (c.score.landing || 20);
}
