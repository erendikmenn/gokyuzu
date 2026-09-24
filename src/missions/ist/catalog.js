// İstanbul mission catalog (CONTRACTS-IST.md §6 Missions; format of CONTRACTS-SF.md §12 / src/missions/catalog.js):
// missions as data — start state, objectives, scheduled failures, time limit, score and star thresholds — plus the
// İstanbul daily mission ("Günün görevi": a deterministic pick + variation per Istanbul day). No DOM, no three.js: the
// menu, the mission runtime and tests/missions-ist.test.mjs read it. Lazily imported by the engine for map `ist`.
//
// Units: meters (local frame of data/ist/region.json: x = east, z = −north, origin Galata Kulesi), m MSL, headings in
// degrees true, speeds in knots, times in seconds. Start states and objectives as in the San Francisco catalog; the
// İstanbul missions also use the objective types `orbit` and `goaround` and the corridor / speed-window fields of
// `gates` and the `outFail` field of `pad` (src/missions/objectives.js).
//
// Geometry: runway ends = data/ist/runways.json (OpenStreetMap + AIP elevations); bridges = data/ist/bridges.json of the
// landmarks pipeline (towers from OpenStreetMap, 15 Temmuz / FSM / YSS main spans 1074 / 1090 / 1408 m, navigation
// clearance 64 m); places, helipads and the Boğaz / Haliç centrelines from OpenStreetMap and the Copernicus DEM
// (water = the DEM's sea level): tests/missions-ist.test.mjs checks them against those files.
//
// The engine wraps it with src/missions/catalog.js createCatalog (loadMissionCatalog('ist'): progress
// `gokyuzu.missions.ist`, this module's buildMission / dailyMissionId); tests and infra/leaderboard/build_rules.mjs use
// the exports directly.
import { hashString, rng, istanbulDay, parseDay, dirOf, bearing, FT } from '../util.js';

export { istanbulDay, parseDay };

export const MAP_ID = 'ist';

/**
 * Bridges the missions fly under (ids of data/ist/bridges.json): centre of the main span, deck axis bearing (from the
 * European to the Asian tower), half the tower spacing, fallback clearance (the landmark collision's span is used
 * when the world has it).
 */
export const BRIDGES = {
  // data/ist/bridges.json (landmarks pipeline): towers from OpenStreetMap; the deck underside is 64 m at mid-span
  // (15 Temmuz, FSM) / 73 m (YSS) and lowest beside the towers — `clear` is that lowest underside between the towers
  bogazici: { name: '15 Temmuz Şehitler Köprüsü', x: 4998.8, z: -2344.2, axis: 140.5, half: 537, clear: 57 },
  fsm: { name: 'Fatih Sultan Mehmet Köprüsü', x: 7161.7, z: -7468.6, axis: 85.1, half: 545, clear: 60 },
  yss: { name: 'Yavuz Sultan Selim Köprüsü', x: 11083.6, z: -19977.1, axis: 119.2, half: 704, clear: 70 },
};

/** Places (OpenStreetMap; y = ground / water level used for pads and hovers, m MSL). */
export const PLACES = {
  galataKulesi: { name: 'Galata Kulesi', x: 4, z: -9, y: 35, top: 98 },
  kizKulesi: { name: 'Kız Kulesi', x: 2530, z: 433, y: 2, top: 30 },
  sarayburnu: { name: 'Sarayburnu', x: 1056, z: 1081 },
  topkapi: { name: 'Topkapı Sarayı', x: 860, z: 1396 },
  ayasofya: { name: 'Ayasofya', x: 522, z: 1887 },
  sultanahmet: { name: 'Sultanahmet Camii', x: 259, z: 2232 },
  suleymaniye: { name: 'Süleymaniye Camii', x: -846, z: 1054 },
  dolmabahce: { name: 'Dolmabahçe Sarayı', x: 2108, z: -1543 },
  rumeliHisari: { name: 'Rumeli Hisarı', x: 6733, z: -6749 },
  camlicaCamii: { name: 'Çamlıca Camii', x: 8060, z: -1172, y: 217, top: 324 },
  camlicaKulesi: { name: 'Çamlıca Kulesi', x: 7700, z: 834, y: 218, top: 587 },
};
/** Helicopter pads: OpenStreetMap aeroway=helipad (y = terrain there). */
export const PADS = {
  yenikapi: { name: 'Yenikapı', x: -2360, z: 2664, y: 5 },        // Samatya Sahil Helipad TR-0049, the Yenikapı event area
  kisikli: { name: 'Kısıklı', x: 6910, z: 69, y: 137 },           // İSPARK Kısıklı Heliport TR-0165, below Çamlıca
};
/** The open, flat Yenikapı event area (reclaimed land, ≈ 1 km × 350 m at 3–6 m MSL): an autorotation field. */
const YENIKAPI_FIELD = { x: -2400, z: 2650, y: 5, r: 130 };

/** Water centrelines (south → north / east → west; DEM water mask, Dijkstra ridge, simplified). */
export const PATHS = {
  bogaz: [[1979, 3408], [1931, -24], [2648, -776], [4784, -2150], [5656, -2976], [6025, -4224], [6326, -4752], [6360, -5640],
    [6962, -6107], [7143, -6408], [7178, -7296], [6992, -8184], [7171, -8904], [8634, -10680], [8584, -11616], [7298, -13104],
    [7208, -15144], [7305, -15576], [7640, -16008], [8439, -16656], [8727, -17568], [10712, -19416], [11566, -20544],
    [12169, -21792], [12971, -22728], [13352, -23472]],
  halic: [[1440, 912], [1355, 625], [1112, 470], [848, 473], [440, 632], [200, 664], [-328, 531], [-586, 374], [-1130, -404],
    [-1288, -522], [-1648, -665], [-1822, -809], [-2374, -1631], [-2885, -2091], [-3102, -2568], [-3029, -3096]],
};

// ---- runway thresholds (data/ist/runways.json) ----
/**
 * Runway ends of a runways.json object as { 'LTFM 35L': { x, z, hdg (true heading of the landing direction), elev } },
 * read like the engine (src/flight/fixedwing-autopilot.js runwayEnds): the end's own elevation on sloped runways
 * (ends[i].elevation), else the runway's, else the airport's. x / z = the physical runway end (a displaced threshold is
 * `displaced` m further on, as in the file).
 */
export function runwayThresholds(runways) {
  const out = {};
  for (const a of (runways && runways.airports) || []) {
    for (const r of a.runways || []) {
      for (const e of r.ends || []) out[`${a.icao} ${e.ident}`] = { x: e.x, z: e.z, hdg: e.headingTrue, elev: e.elevation ?? r.elevation ?? a.elevation ?? 0 };
    }
  }
  return out;
}
/** Runway ends nobody may land on (runways.json `departureOnly` runways / ends with `landing: false`). */
export function departureOnlyEnds(runways) {
  const out = [];
  for (const a of (runways && runways.airports) || []) {
    for (const r of a.runways || []) for (const e of r.ends || []) if (r.departureOnly || e.landing === false) out.push(`${a.icao} ${e.ident}`);
  }
  return out;
}
/**
 * The thresholds the missions are built on until the engine hands over the map's runways.json (useRunways): the file's
 * values (DHMİ AIP; tests/missions-ist.test.mjs keeps this table equal to it).
 */
export const RW_FALLBACK = {
  'LTFJ 06L': { x: 27211.9, z: 14099.1, hdg: 62.6, elev: 89.0 },
  'LTFJ 06R': { x: 28024.8, z: 14944.9, hdg: 62.6, elev: 82.3 },
  'LTBA 05': { x: -13664.5, z: 6949.5, hdg: 57.38, elev: 28.3 },
  'LTBA 23': { x: -11491.8, z: 5559.1, hdg: 237.38, elev: 27.4 },
  'LTFM 35L': { x: -21447.2, z: -25794.4, hdg: 358.02, elev: 94.5 },
  'LTFM 35R': { x: -21237.4, z: -25801.7, hdg: 358.02, elev: 94.5 },
  'LTFM 09': { x: -17992.7, z: -24953.1, hdg: 87.98, elev: 83.5 },
};
const RW_ENDS = { ...RW_FALLBACK };
/**
 * LTFM 09/27 (opened 18 Sep 2026) is for departures only: land objectives on "any" runway exclude these ends (the same
 * array, refreshed in place by useRunways).
 */
export const DEPARTURE_ONLY = ['LTFM 09', 'LTFM 27'];
/** The map's runways.json (src/maps/index.js loadMap): mission geometry from the file's thresholds from now on. */
export function useRunways(runways) {
  const t = runwayThresholds(runways);
  for (const k of Object.keys(t)) RW_ENDS[k] = t[k];
  if (runways && runways.airports && runways.airports.length) DEPARTURE_ONLY.splice(0, DEPARTURE_ONLY.length, ...departureOnlyEnds(runways));
  return RW_ENDS;
}
export { RW_ENDS };

const GS = Math.tan(3 * Math.PI / 180);
/** A point `d` m before a runway threshold on its extended centreline (+ the 3° glide path height to the aim point). */
function onFinal(name, d) {
  const e = RW_ENDS[name], { dx, dz } = dirOf(e.hdg);
  return { x: e.x - dx * d, z: e.z - dz * d, y: e.elev + (d + 300) * GS, hdg: e.hdg };
}
/** Point `d` m beyond ring `r` on the line from `from` (the NAV autopilot turns after the ring, never before it). */
function lead(r, from, d) { const L = Math.hypot(r.x - from.x, r.z - from.z); return { x: r.x + (r.x - from.x) / L * d, z: r.z + (r.z - from.z) / L * d }; }
const P = (a) => ({ x: a[0], z: a[1] });
const fmtFt = (ft) => String(Math.round(ft)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const km = (m) => (m / 1000).toFixed(1).replace('.', ',').replace(',0', '');
/** Distance along a polyline of points from a start point to a target (≈ the path length a pilot flies). */
function pathLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return L; }

// ---- Boğaz starts (on the centreline, heading to the next centreline point) ----
const B = PATHS.bogaz.map(P);
/** Start on Boğaz centreline point i, flying towards point i + step (±1). */
function bogazStart(i, step) { const a = B[i], b = B[i + step]; return { x: a.x, z: a.z, hdg: Math.round(bearing(a.x, a.z, b.x, b.z)) }; }
/** Path length from a start point along the centreline (from point i, direction step) to the target (x, z): the way a
 *  pilot follows the Boğaz (for the briefing's distance). */
function bogazDist(S, i, step, x, z) {
  let best = i, bd = Infinity;
  for (let k = 0; k < B.length; k++) { const d = Math.hypot(B[k].x - x, B[k].z - z); if (d < bd) { bd = d; best = k; } }
  const pts = [S];
  for (let k = i; step > 0 ? k < best : k > best; k += step) pts.push(B[k]);
  pts.push({ x, z });
  return pathLen(pts);
}

const tk = BRIDGES.bogazici, fsm = BRIDGES.fsm, yss = BRIDGES.yss;

// ------------------------------------------------------------------------------------------------------------ missions
// Every mission: id, title, aircraft, minutes (typical), level (1–3), unlock? (total İstanbul stars), teaches, brief (1–3
// sentences), goal (one line), params (defaults) → build(p) → { start, objectives, failures?, limit, manual?, score,
// stars, route? }, daily(r) → params, dailyNote(p).
export const MISSIONS = [
  // ============================================================================================ level 1
  {
    id: 'ist-15temmuz', fogBank: false, title: '15 Temmuz Şehitler Köprüsü\'nün altından', aircraft: 'f16', minutes: 2, level: 1,
    teaches: 'Alçak irtifada hassas kontrol',
    brief: 'Köprü Boğaz boyunca yaklaşık {dist} km ileride. Kuleler arası 1.074 m, deniz ile tabliye arası 64 m: Boğaz\'ı izle, alçal ve tam ortadan, 30–40 m\'den geç.',
    goal: 'Tabliyenin altından geç, sonra 1.500 ft\'e tırman.',
    params: { from: 0, alt: 120, kt: 300 },
    build: (p) => {
      // 0: the Boğaz mouth off Kabataş, northbound; 1: off Kız Kulesi, northbound; 2: Bebek, southbound; 3: Rumeli Hisarı
      const S = [bogazStart(1, 1), { x: 1960, z: 1500, hdg: 359 }, bogazStart(7, -1), bogazStart(9, -1)][p.from] || bogazStart(1, 1);
      const next = [2, 1, 6, 8][p.from] ?? 2, step = p.from >= 2 ? -1 : 1;
      return {
        start: { x: S.x, z: S.z, hdg: S.hdg, alt: p.alt, kt: p.kt },
        dist: bogazDist(S, next, step, tk.x, tk.z),
        objectives: [
          { type: 'bridge', bridge: 'bogazici', label: 'Köprünün altından geç' },
          { type: 'altitude', min: 1500 * FT, label: '1.500 ft\'e tırman' },
        ],
        limit: 150, manual: true,
        score: { base: 1000, par: 90, perSec: 10 },    // + bridge: up to 500 for the centre, 300 for mid-gap height
        stars: [1000, 1750, 2250],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 4), alt: 100 + Math.round(r() * 60), kt: 280 + Math.round(r() * 60) }),
    dailyNote: (p) => ['Kabataş açıklarından, kuzeye', 'Kız Kulesi\'nden, kuzeye', 'Bebek\'ten, güneye', 'Rumeli Hisarı\'ndan, güneye'][p.from] || '',
  },
  {
    id: 'ist-fsm', fogBank: false, title: 'Fatih Sultan Mehmet Köprüsü\'nün altından', aircraft: 'f22', minutes: 2, level: 1,
    teaches: 'Kıvrımlı Boğaz\'da alçak uçuş',
    brief: 'Boğaz burada dar ve kıvrımlı: köprüye Boğaz boyunca yaklaşık {dist} km var. Kıyıları izle, alçal ve kuleler arasından, tabliyenin (64 m) altından geç.',
    goal: 'Tabliyenin altından geç, sonra 1.500 ft\'e tırman.',
    params: { from: 0, alt: 110, kt: 300 },
    build: (p) => {
      // 0: Bebek, northbound (Rumeli Hisarı bend); 1: off Yeniköy, southbound; 2: off İstinye, southbound
      const plan = [[5, 1], [14, -1], [13, -1]][p.from] || [5, 1];
      const S = bogazStart(plan[0], plan[1]);
      return {
        start: { x: S.x, z: S.z, hdg: S.hdg, alt: p.alt, kt: p.kt },
        dist: bogazDist(S, plan[0] + plan[1], plan[1], fsm.x, fsm.z),
        objectives: [
          { type: 'bridge', bridge: 'fsm', label: 'Köprünün altından geç' },
          { type: 'altitude', min: 1500 * FT, label: '1.500 ft\'e tırman' },
        ],
        limit: 150, manual: true,
        score: { base: 1000, par: 90, perSec: 10 },
        stars: [1000, 1750, 2250],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 3), alt: 90 + Math.round(r() * 60), kt: 270 + Math.round(r() * 60) }),
    dailyNote: (p) => ['Bebek\'ten, kuzeye', 'Yeniköy açıklarından, güneye', 'İstinye açıklarından, güneye'][p.from] || '',
  },
  {
    id: 'ist-ltfm-inis', title: 'İstanbul Havalimanı\'na iniş', aircraft: 'a320neo', minutes: 2, level: 1, teaches: 'Son yaklaşma ve yumuşak iniş',
    brief: 'İstanbul Havalimanı\'na son yaklaşmadasın: takım ve flaplar açık, hız ayarlı. Merkez hattında ve 3°\'lik süzülüşte kal, eşiği geçince gazı kes ve hafifçe burnu kaldır.',
    goal: '{rw} pistine iniş: temas bölgesine, 200 ft/dk civarında.',
    params: { rw: '35L', dist: 8000 },
    build: (p) => ({
      start: { final: `LTFM ${p.rw}`, dist: p.dist },
      objectives: [{ type: 'land', runways: [`LTFM ${p.rw}`], minStars: 1, target: `LTFM ${p.rw}`, label: `${p.rw} pistine in` }],
      limit: 240, manual: true,                           // no autoland: the landing is the test
      score: { base: 0, landing: 20 },                     // landing points × 20 (0–2000)
      stars: 'landing',
    }),
    // all ten ends (sloped runways: each threshold's own elevation, ≈ 33 m lower at the north ends — the southbound
    // landings run uphill); southbound finals start over the Black Sea coast: the map ends ≈ 7.7 km north of those
    // thresholds
    daily: (r) => {
      const rw = ['35L', '35R', '34L', '34R', '36', '17L', '17R', '16L', '16R', '18'][Math.floor(r() * 10)];
      return { rw, dist: rw < '30' ? 5500 + Math.round(r() * 1500) : 7000 + Math.round(r() * 4000) };
    },
    dailyNote: (p) => `Pist ${p.rw} · ${(p.dist / 1852).toFixed(1).replace('.', ',')} NM`,
  },
  {
    id: 'ist-kiz-kulesi', fogBank: false, title: 'Kız Kulesi turu', aircraft: 'uh60', minutes: 3, level: 1, teaches: 'Helikopterle sabit yarıçaplı tur ve hover',
    brief: 'Kız Kulesi\'nin çevresinde {dirText} bir tam tur at: kuleden 120–320 m uzakta, 100–500 ft arasında kal. Sonra kulenin batısında, denizin üstünde 5 sn asılı kal.',
    goal: 'Kulenin çevresinde 360° tur, sonra kulenin yanında hover.',
    params: { from: 0, dir: 'right' },
    build: (p) => {
      const k = PLACES.kizKulesi;
      const froms = [[1400, 500], [3000, 1400], [2300, -1100]];
      const [x, z] = froms[p.from] || froms[0];
      return {
        start: { x, z, hdg: Math.round(bearing(x, z, k.x, k.z)), alt: 120, kt: 80 },
        objectives: [
          { type: 'orbit', shape: 'ring', x: k.x, z: k.z, rmin: 120, rmax: 320, ymin: 30, ymax: 150, dir: p.dir, grace: 8, label: `Kız Kulesi'nin çevresinde tur (${p.dir === 'left' ? 'sola' : 'sağa'})` },
          { type: 'hover', x: k.x - 90, z: k.z + 30, y: 0, r: 20, hmin: 8, hmax: 35, t: 5, maxKt: 6, ty: 20, doneMsg: 'Harika! Kız Kulesi turu tamam.', label: 'Kulenin yanında 5 sn asılı kal' },
        ],
        limit: 300,
        score: { base: 1000, par: 170, perSec: 4 },     // + orbit up to 800, hover steadiness up to 300
        stars: [1000, 1750, 2200],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 3), dir: r() < 0.5 ? 'right' : 'left' }),
    dailyNote: (p) => `${['Sarayburnu tarafından', 'Harem tarafından', 'Kabataş tarafından'][p.from] || ''} · ${p.dir === 'left' ? 'sola' : 'sağa'}`,
  },
  {
    id: 'ist-tirmanis', title: 'İstanbul Havalimanı\'ndan dik tırmanış', aircraft: 'f22', minutes: 1, level: 1, teaches: 'Art yakıcı, kalkış ve tırmanış',
    brief: 'İstanbul Havalimanı, pist {rw}. F-22\'nin itkisi ağırlığından fazla: art yakıcıyı aç, rotasyondan sonra burnu dikçe kaldır ve tırman.',
    goal: '{alt} ft\'e olabildiğince çabuk çık.',
    params: { rw: '35R', altFt: 10000 },
    build: (p) => {
      // as the San Francisco climb (1000 + 25 per second under 120 s; ★★ / ★★★ times scale with the target); the field
      // is at 325 ft, the same height to climb within 3 %
      const k = p.altFt / 10000, at = (t) => 1000 + Math.round((120 - t * k) * 25);
      return {
        start: { runway: `LTFM ${p.rw}` },
        objectives: [{ type: 'altitude', min: p.altFt * FT, label: `${fmtFt(p.altFt)} ft'e tırman` }],
        limit: 120, manual: true,
        score: { base: 1000, par: 120, perSec: 25 },
        stars: [1000, at(75), at(55)],
      };
    },
    // (09: the departures-only runway opened on 18 Sep 2026, eastbound)
    daily: (r) => ({ rw: ['35R', '35L', '34L', '17L', '16R', '36', '09'][Math.floor(r() * 7)], altFt: [8000, 10000, 12000][Math.floor(r() * 3)] }),
    dailyNote: (p) => `Pist ${p.rw} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'ist-bogaz-turu', fogBank: false, title: 'Boğaz turu', aircraft: 'b737', minutes: 4, level: 1, teaches: 'Rota uçuşu ve otopilot (NAV)',
    brief: 'Boğaz\'ın dört simgesini tek uçuşta gör: Kız Kulesi, 15 Temmuz, Fatih Sultan Mehmet ve Yavuz Sultan Selim köprüleri. Rota hazır: otopilotu açıp NAV ile uçurabilir ya da elle uçabilirsin.',
    goal: 'Dört halkadan sırayla geç.',
    params: { altFt: 2000, north: true },
    build: (p) => {
      const y = p.altFt * FT;
      const k = PLACES.kizKulesi;
      const rings = [{ x: k.x, z: k.z, name: 'Kız Kulesi' }, { x: tk.x, z: tk.z, name: '15 Temmuz' }, { x: fsm.x, z: fsm.z, name: 'Fatih Sultan Mehmet' }, { x: yss.x, z: yss.z, name: 'Yavuz Sultan Selim' }];
      if (!p.north) rings.reverse();
      // northbound: from the Marmara on the line 15 Temmuz → Kız Kulesi (the first two rings on one straight leg)
      const u = Math.hypot(rings[0].x - rings[1].x, rings[0].z - rings[1].z);
      const s = p.north ? { x: Math.round(rings[0].x + (rings[0].x - rings[1].x) / u * 4000), z: Math.round(rings[0].z + (rings[0].z - rings[1].z) / u * 4000) } : { x: 13600, z: -24300 };
      // rings on straight legs: after each ring the route runs on for 1.5–2 km before it turns (fly-by turns of the NAV
      // autopilot never cut a ring)
      const route = [], gates = [];
      let from = s;
      rings.forEach((r, i) => {
        gates.push({ x: r.x, z: r.z, y, r: 150, name: r.name, from: [from.x, from.z] });
        route.push({ x: r.x, z: r.z, alt: y });
        if (i > 0 && i < rings.length - 1) { const t = lead(r, from, 1800); route.push({ x: t.x, z: t.z, alt: y }); from = t; } else from = r;
      });
      return {
        start: { x: s.x, z: s.z, hdg: Math.round(bearing(s.x, s.z, rings[0].x, rings[0].z)), alt: y, kt: 230 },
        objectives: [{ type: 'gates', shape: 'ring', gates, tol: 20, label: 'Halkalardan geç' }],
        route,
        limit: 420,
        score: { base: 0, par: 300, perSec: 3, gate: 300, gateAcc: 150 },
        stars: [1150, 1700, 2050],
      };
    },
    daily: (r) => ({ altFt: [1800, 2000, 2500][Math.floor(r() * 3)], north: r() < 0.6 }),
    dailyNote: (p) => `${p.north ? 'Marmara\'dan Karadeniz\'e' : 'Karadeniz\'den Marmara\'ya'} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'ist-saw-inis', title: 'Sabiha Gökçen\'e iniş', aircraft: 'b737', minutes: 2, level: 1, teaches: 'Son yaklaşma ve yumuşak iniş',
    brief: 'Pendik açıklarından Sabiha Gökçen\'e son yaklaşmadasın: takım ve flaplar açık, hız ayarlı. Merkez hattında ve 3°\'lik süzülüşte kal, eşikten sonra gazı kes ve burnu hafifçe kaldır.',
    goal: '{rw} pistine iniş: temas bölgesine, 200 ft/dk civarında.',
    params: { rw: '06L', dist: 8000 },
    build: (p) => ({
      start: { final: `LTFJ ${p.rw}`, dist: p.dist },
      objectives: [{ type: 'land', runways: [`LTFJ ${p.rw}`], minStars: 1, target: `LTFJ ${p.rw}`, label: `${p.rw} pistine in` }],
      limit: 240, manual: true,
      score: { base: 0, landing: 20 },
      stars: 'landing',
    }),
    daily: (r) => ({ rw: r() < 0.5 ? '06L' : '06R', dist: 7000 + Math.round(r() * 3000) }),
    dailyNote: (p) => `Pist ${p.rw} · ${(p.dist / 1852).toFixed(1).replace('.', ',')} NM`,
  },

  // ============================================================================================ level 2
  {
    id: 'ist-yarimada', fogBank: false, title: 'Tarihi Yarımada turu', aircraft: 'uh60', minutes: 5, level: 2, teaches: 'Alçak şehir uçuşu ve pede iniş',
    brief: 'Galata Kulesi, Haliç, Süleymaniye, Ayasofya ile Sultanahmet, Topkapı Sarayı ve Sarayburnu: altı halkadan sırayla geç. Sonra surların boyunca Yenikapı sahilindeki helikopter pedine uç, üstünde 5 sn asılı kal ve pedin ortasına in.',
    goal: 'Altı halka, Yenikapı pedinde hover ve iniş.',
    params: { alt: 0 },
    build: (p) => {
      const d = p.alt || 0;         // daily: all rings a little higher (m)
      const gates = [
        { x: 60, z: 80, y: 125 + d, r: 40, name: 'Galata Kulesi' },
        { x: -344, z: 491, y: 90 + d, r: 40, name: 'Haliç' },
        { x: -600, z: 960, y: 170 + d, r: 45, name: 'Süleymaniye' },
        { x: 395, z: 2060, y: 150 + d, r: 45, name: 'Ayasofya · Sultanahmet' },
        { x: 900, z: 1430, y: 125 + d, r: 45, name: 'Topkapı Sarayı' },
        { x: 1300, z: 900, y: 70 + d, r: 45, name: 'Sarayburnu' },
      ];
      const pad = PADS.yenikapi;
      return {
        start: { x: 1500, z: 200, hdg: Math.round(bearing(1500, 200, gates[0].x, gates[0].z)), alt: 150, kt: 70 },
        objectives: [
          { type: 'gates', shape: 'ring', gates, tol: 12, label: 'Halkalardan geç' },
          { type: 'hover', x: pad.x, z: pad.z, y: pad.y, r: 14, hmin: 3, hmax: 20, t: 5, maxKt: 6, label: 'Pedin üstünde 5 sn asılı kal' },
          { type: 'pad', x: pad.x, z: pad.z, y: pad.y, r: 12, label: 'Yenikapı pedine in' },
        ],
        limit: 540,
        score: { base: 1000, par: 400, perSec: 3, gate: 150, gateAcc: 100, landing: 6 },   // + hover up to 300, pad accuracy up to 400
        stars: [1000, 2900, 3550],
      };
    },
    daily: (r) => ({ alt: [0, 15, 30][Math.floor(r() * 3)] }),
    dailyNote: (p) => (p.alt ? `Halkalar ${p.alt} m daha yüksek` : 'Alçak halkalar'),
  },
  {
    id: 'ist-heli-tur', fogBank: false, title: 'İstanbul helikopter turu', aircraft: 'uh60', minutes: 8, level: 2, teaches: 'Uzun görsel uçuş: hover, halkalar, köprü altı, pede iniş',
    brief: 'Galata Kulesi\'nin yanında asılı kal, sonra Haliç, Sarayburnu, Kız Kulesi ve Dolmabahçe halkalarından geç. 15 Temmuz Şehitler Köprüsü\'nün altından Rumeli Hisarı\'na uç, Çamlıca\'dan geçip Kısıklı pedine in.',
    goal: 'Galata\'da hover, 6 halka, köprü altı, Kısıklı pedine iniş.',
    params: { dir: 0 },
    build: (p) => {
      const g = PLACES.galataKulesi, pad = PADS.kisikli;
      const hov = { x: g.x + 60, z: g.z + 60 };      // ≈ 85 m south-east of the tower, at the balcony height
      const ringsA = [
        { x: -344, z: 491, y: 90, r: 45, name: 'Haliç' },
        { x: 1300, z: 900, y: 70, r: 45, name: 'Sarayburnu' },
        { x: 2380, z: 380, y: 50, r: 45, name: 'Kız Kulesi' },
        { x: 2350, z: -1400, y: 60, r: 45, name: 'Dolmabahçe' },
      ];
      ringsA[0].from = [hov.x, hov.z];
      const ringsB = [
        { x: 6950, z: -6550, y: 80, r: 45, name: 'Rumeli Hisarı', from: [6200, -4400] },
        { x: 7700, z: -1250, y: 330, r: 50, name: 'Çamlıca' },
      ];
      return {
        start: { x: 1500, z: 200, hdg: Math.round(bearing(1500, 200, hov.x, hov.z)), alt: 150, kt: 70 },
        objectives: [
          { type: 'hover', x: hov.x, z: hov.z, y: 0, r: 25, hmin: 80, hmax: 110, t: 5, maxKt: 6, ty: 95, doneMsg: 'Güzel! Şimdi Haliç\'e.', label: 'Galata Kulesi\'nin yanında 5 sn asılı kal' },
          { type: 'gates', shape: 'ring', gates: ringsA, tol: 12, label: 'Haliç, Sarayburnu, Kız Kulesi, Dolmabahçe' },
          { type: 'bridge', bridge: 'bogazici', label: '15 Temmuz Şehitler Köprüsü\'nün altından geç' },
          { type: 'gates', shape: 'ring', gates: ringsB, tol: 12, label: 'Rumeli Hisarı ve Çamlıca' },
          { type: 'pad', x: pad.x, z: pad.z, y: pad.y, r: 12, label: 'Kısıklı pedine in' },
        ],
        limit: 900,
        score: { base: 1000, par: 540, perSec: 2, gate: 150, gateAcc: 100, landing: 6 },
        stars: [1000, 3600, 4400],
      };
    },
    daily: () => ({ dir: 0 }),
    dailyNote: () => 'Galata\'dan Çamlıca\'ya',
  },
  {
    id: 'ist-kiz-kulesi-jet', fogBank: false, title: 'Kız Kulesi\'nde alçak geçiş', aircraft: 'f16', minutes: 3, level: 2, teaches: 'Sabit yarıçaplı dönüş, hız ve irtifa hassasiyeti',
    brief: 'Kız Kulesi\'nin çevresinde {dirText} bir tam tur at: 1–2 km yarıçapta ve 700–1.450 ft arasında. Sonra alçal ve kulenin batısındaki kapıdan 30 m\'de, {kt} kt ile geç.',
    goal: 'Tur, sonra {kt} kt ile hassas alçak geçiş.',
    params: { dir: 'left', kt: 300 },
    build: (p) => {
      const k = PLACES.kizKulesi;
      const s = { x: 2400, z: 6800 };
      return {
        start: { x: s.x, z: s.z, hdg: 0, alt: 330, kt: 300 },
        objectives: [
          { type: 'orbit', shape: 'ring', x: k.x, z: k.z, rmin: 1000, rmax: 2000, ymin: 210, ymax: 440, dir: p.dir, grace: 6, label: `Kız Kulesi'nin çevresinde tur (${p.dir === 'left' ? 'sola' : 'sağa'})` },
          { type: 'gates', shape: 'frame', gates: [{ x: 2150, z: 433, y: 30, hw: 60, hh: 15, name: 'Kız Kulesi', from: [2100, -1600] }], tol: 5, kt: p.kt, ktTol: 40, label: `${p.kt} kt ile kapıdan geç` },
        ],
        limit: 240, manual: true,
        score: { base: 1000, par: 150, perSec: 5, gate: 200, gateAcc: 300, gateKt: 200 },   // + orbit up to 800
        stars: [1000, 1900, 2400],
      };
    },
    daily: (r) => ({ dir: r() < 0.5 ? 'left' : 'right', kt: [250, 300, 350][Math.floor(r() * 3)] }),
    dailyNote: (p) => `${p.dir === 'left' ? 'Sola' : 'Sağa'} tur · ${p.kt} kt`,
  },
  {
    id: 'ist-bogaz-alcak', fogBank: false, title: 'Boğaz\'da alçak geçiş', aircraft: 'f22', minutes: 2, level: 2, teaches: 'Alçak irtifa, kıvrımlı rota ve hız yönetimi',
    brief: 'Rumeli Hisarı ile Kız Kulesi arasına, denizin 15–65 m üstünde 6 kapı dizildi. 1. kapıdan sonra 500 ft\'in altında kal: 15 Temmuz\'un altından da geçebilirsin, tabliyenin üstünden de.',
    goal: '6 kapıdan sırayla, alçak ve hızlı geç.',
    params: { south: true, jit: [0, 0, 0, 0, 0, 0], y: 40 },
    build: (p) => {
      // frames on the water centreline (Rumeli Hisarı, Bebek, Arnavutköy, Ortaköy, Beşiktaş, Kız Kulesi); the daily
      // jitter moves them across the stream within the water (k = the room either side)
      const base = [[6962, -6107, 0.5], [6326, -4752, 0.6], [5656, -2976, 1], [4297, -1885, 0.9], [2993, -1009, 1], [2150, 350, 0.5]];
      let gates = base.map(([x, z, k], i) => ({ x: x + Math.round((p.jit[i] || 0) * k), z, y: p.y, hw: 90, hh: 25 }));
      let s = { x: 7178, z: -7300, hdg: 188 };
      if (!p.south) { gates = gates.reverse(); s = { x: 1960, z: 1500, hdg: 359 }; }
      return {
        start: { x: s.x, z: s.z, hdg: s.hdg, alt: 60, kt: 360 },
        objectives: [{ type: 'gates', shape: 'frame', gates, tol: 8, ceiling: 500 * FT, grace: 3, label: 'Kapılardan geç, 500 ft altında kal' }],
        limit: 150, manual: true,
        score: { base: 0, par: 110, perSec: 15, gate: 200, gateAcc: 100, low: 300 },
        stars: [1000, 2300, 2800],
      };
    },
    daily: (r) => ({ south: r() < 0.6, jit: [0, 0, 0, 0, 0, 0].map(() => Math.round((r() - 0.5) * 300)), y: 30 + Math.round(r() * 20) }),
    dailyNote: (p) => (p.south ? 'Kuzeyden güneye' : 'Güneyden kuzeye'),
  },
  {
    id: 'ist-halic', fogBank: false, title: 'Haliç\'te alçak uçuş', aircraft: 'f16', minutes: 2, level: 2, teaches: 'Dar vadide alçak uçuş',
    brief: 'Haliç boyunca, denizin 75–125 m üstünde 6 kapı var. Galata, Haliç Metro, Atatürk ve Haliç köprülerinin hepsinin üstünden geç: altları alçak, metro köprüsünün kuleleri 65 m. Son kapıdan sonra 2.000 ft\'e tırman.',
    goal: '6 kapıdan sırayla geç, sonra 2.000 ft\'e tırman.',
    params: { up: true, y: 100 },
    build: (p) => {
      // Haliç centreline frames: the mouth, Galata–Metro, Fener–Kasımpaşa, Balat–Hasköy, Ayvansaray–Sütlüce, Eyüp
      const base = [[844, 420], [-344, 491], [-1136, -432], [-1849, -777], [-2380, -1630], [-3080, -2480]];
      let gates = base.map(([x, z]) => ({ x, z, y: p.y, hw: 80, hh: 25 }));
      let s = { x: 2600, z: -200, hdg: 0 };
      if (!p.up) { gates = gates.reverse(); s = { x: -3300, z: -4400, hdg: 0 }; }
      s.hdg = Math.round(bearing(s.x, s.z, gates[0].x, gates[0].z));
      return {
        start: { x: s.x, z: s.z, hdg: s.hdg, alt: p.up ? 150 : 250, kt: 260 },
        objectives: [
          { type: 'gates', shape: 'frame', gates, tol: 8, label: 'Haliç kapılarından geç' },
          { type: 'altitude', min: 2000 * FT, label: '2.000 ft\'e tırman' },
        ],
        limit: 150, manual: true,
        score: { base: 0, par: 100, perSec: 15, gate: 200, gateAcc: 100 },
        stars: [1000, 1800, 2200],
      };
    },
    daily: (r) => ({ up: r() < 0.6, y: [90, 100, 110][Math.floor(r() * 3)] }),
    dailyNote: (p) => (p.up ? 'Sarayburnu\'ndan Eyüp\'e' : 'Eyüp\'ten Sarayburnu\'na'),
  },
  {
    id: 'ist-aktarma', fogBank: false, title: 'İstanbul\'dan Sabiha Gökçen\'e', aircraft: 'a320neo', minutes: 11, level: 2, teaches: 'Kalkış, NAV rotası, yaklaşma ve iniş',
    brief: 'İstanbul Havalimanı\'nın {rw} pistinden kalk, Fatih Sultan Mehmet Köprüsü ve Çamlıca üstündeki halkalardan geçip Sabiha Gökçen 06L\'ye in. Rota hazır: kalkıştan sonra otopilotu NAV ile açabilirsin.',
    goal: 'İki halka, sonra Sabiha Gökçen\'e iniş.',
    params: { rw: '35R', altFt: 4000 },
    build: (p) => {
      const y = p.altFt * FT;
      const r1 = { x: fsm.x, z: fsm.z }, r2 = { x: 9500, z: 0 };
      // south of the Princes' Islands, then the 06L final joined at 10 km with a 35° intercept (the map ends 3 km
      // south of it)
      const fi = onFinal('LTFJ 06L', 10000), fa = onFinal('LTFJ 06L', 3000);
      const w2 = { x: 13500, z: 18000 };
      const e = RW_ENDS[`LTFM ${p.rw}`] || RW_ENDS['LTFM 35R'];
      const dep = { x: e.x + dirOf(e.hdg).dx * 6000, z: e.z + dirOf(e.hdg).dz * 6000 };   // runway heading to 6 km
      return {
        start: { runway: `LTFM ${p.rw}` },
        objectives: [
          { type: 'gates', shape: 'ring', gates: [{ ...r1, y, r: 200, name: 'Fatih Sultan Mehmet', from: [dep.x, dep.z] }, { ...r2, y, r: 200, name: 'Çamlıca' }], tol: 30, label: 'Halkalardan geç' },
          { type: 'land', airports: ['LTFJ'], minStars: 1, target: 'LTFJ 06L', label: 'Sabiha Gökçen\'e in' },
        ],
        // the route ends on the 06L centreline below the glide path: gear down there arms the approach (APP)
        route: [{ ...dep, alt: Math.min(y, 3000 * FT) }, { ...r1, alt: y }, { ...lead(r1, dep, 2500), alt: y }, { ...r2, alt: y }, { ...w2, alt: 3000 * FT },
          { x: fi.x, z: fi.z, alt: 2000 * FT }, { x: fa.x, z: fa.z, alt: 1500 * FT }],
        limit: 1200,
        score: { base: 1000, gate: 200, gateAcc: 100, landing: 12, par: p.rw === '09' ? 730 : 840, perSec: 1 },   // (09: ≈ 110 s shorter)
        stars: [1000, 2250, 2700],
      };
    },
    daily: (r) => ({ rw: ['35R', '35L', '09'][Math.floor(r() * 3)], altFt: [4000, 5000][Math.floor(r() * 2)] }),
    dailyNote: (p) => `Pist ${p.rw} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'ist-ataturk-pas', title: 'Atatürk\'te pas geçme', aircraft: 'b737', minutes: 5, level: 2, teaches: 'Pas geçme ve trafik paterni',
    brief: 'Atatürk Havalimanı\'nın {rw} pistine yaklaşıyorsun. Karar noktasındaki kapıdan geçince pistte bir araç görünecek: tam güç, burnu kaldır, pozitif tırmanışta takımı topla ve 2.000 ft\'e tırman, sonra dönüp in.',
    goal: 'Kapı, pas geçme (2.000 ft), sonra Atatürk\'e iniş.',
    params: { rw: '05', dist: 9000 },
    build: (p) => {
      const g = onFinal(`LTBA ${p.rw}`, 2000);
      const e = RW_ENDS[`LTBA ${p.rw}`];
      return {
        start: { final: `LTBA ${p.rw}`, dist: p.dist },
        objectives: [
          { type: 'gates', shape: 'frame', gates: [{ x: g.x, z: g.z, y: Math.round(g.y), hw: 80, hh: 40, name: 'Karar noktası', from: [g.x - dirOf(e.hdg).dx * 3000, g.z - dirOf(e.hdg).dz * 3000] }], tol: 20, label: 'Süzülüşte kal: karar noktası' },
          { type: 'goaround', min: 2000 * FT, call: 'PAS GEÇ! Pistte araç var: tam güç, burun yukarı', label: 'Pas geç: 2.000 ft\'e tırman' },
          { type: 'land', airports: ['LTBA'], minStars: 1, target: `LTBA ${p.rw}`, label: 'Dön ve Atatürk\'e in' },
        ],
        limit: 600,
        score: { base: 1000, gate: 100, gateAcc: 100, landing: 12 },   // + go-around up to 400
        stars: [1000, 2200, 2700],
      };
    },
    daily: (r) => ({ rw: r() < 0.6 ? '05' : '23', dist: 8000 + Math.round(r() * 3000) }),
    dailyNote: (p) => `Pist ${p.rw} · ${(p.dist / 1852).toFixed(1).replace('.', ',')} NM`,
  },

  // ============================================================================================ level 3
  {
    id: 'ist-uc-kopru', fogBank: false, title: 'Üç köprü', aircraft: 'f22', minutes: 3, level: 3, unlock: 3, teaches: 'Uzun alçak uçuş, zamana karşı',
    brief: 'Boğaz\'ın üç köprüsünün altından sırayla ve olabildiğince hızlı geç: 15 Temmuz, Fatih Sultan Mehmet, Yavuz Sultan Selim. Boğaz 25 km boyunca kıvrılıyor, tabliyeler denizin 60–70 m üstünde.',
    goal: 'Üç köprünün altından sırayla geç.',
    params: { north: true, kt: 350 },
    build: (p) => {
      const ids = p.north ? ['bogazici', 'fsm', 'yss'] : ['yss', 'fsm', 'bogazici'];
      const s = p.north ? { x: 1960, z: 1500, hdg: 359 } : { x: 13352, z: -23472, hdg: 205 };
      return {
        start: { x: s.x, z: s.z, hdg: s.hdg, alt: 80, kt: p.kt },
        objectives: ids.map((b) => ({ type: 'bridge', bridge: b, label: `${BRIDGES[b].name}'nün altından geç` })),
        limit: 300, manual: true,
        score: { base: 1000, par: 200, perSec: 15 },   // + 3 × bridge (up to 800 each)
        stars: [1000, 3400, 4200],
      };
    },
    daily: (r) => ({ north: r() < 0.6, kt: 330 + Math.round(r() * 50) }),
    dailyNote: (p) => (p.north ? 'Marmara\'dan Karadeniz\'e' : 'Karadeniz\'den Marmara\'ya'),
  },
  {
    id: 'ist-saw-motor', title: 'Sabiha Gökçen\'de kalkışta motor arızası', aircraft: 'b737', minutes: 5, level: 3, unlock: 3, teaches: 'Tek motorla uçuş ve dönüş',
    brief: 'Sabiha Gökçen pist {rw}, batıya kalkış. {ftFail} ft\'te {side} motor duracak: burnu biraz indir, hızı koru, dümenle düz uç. 2.000 ft\'e tırman, Pendik açıklarında geri dön ve in ({back} en yakını).',
    goal: 'Sabiha Gökçen\'de herhangi bir piste güvenli iniş.',
    params: { rw: '24R', index: 0, ftFail: 400 },
    build: (p) => ({
      start: { runway: `LTFJ ${p.rw}` },
      failures: [{ at: { agl: p.ftFail * FT }, kind: 'engine', opts: { index: p.index }, message: `${p.index === 0 ? 'Sol' : 'Sağ'} motor arızası!` }],
      objectives: [
        { type: 'altitude', min: 2000 * FT, label: '2.000 ft\'e tırman' },
        { type: 'land', airports: ['LTFJ'], minStars: 1, target: `LTFJ ${p.rw === '24R' ? '06L' : '06R'}`, label: 'Sabiha Gökçen\'e geri dön ve in' },
      ],
      limit: 540,
      score: { base: 1000, landing: 12, par: 400, perSec: 3 },
      stars: [1000, 1750, 2150],
    }),
    daily: (r) => ({ rw: r() < 0.5 ? '24R' : '24L', index: r() < 0.5 ? 0 : 1, ftFail: 300 + Math.round(r() * 3) * 100 }),
    dailyNote: (p) => `Pist ${p.rw} · ${p.index === 0 ? 'sol' : 'sağ'} motor · ${p.ftFail} ft`,
  },
  {
    id: 'ist-alev', title: 'Alev sönmesi', aircraft: 'f16', minutes: 3, level: 3, unlock: 3, teaches: 'Süzülüş ve enerji yönetimi',
    brief: '{altFt} ft\'te motor sönecek ve yeniden yanmayacak. F-16 en iyi 200 kt civarında süzülür: fazla yüksekliği S dönüşleri ve hava freniyle harca. Hidrolik B gider: takım için önce G, sonra ACİL (klavyede I) ile acil indirme.',
    goal: '{target} pistine motorsuz, güvenli iniş (başka pist de olur; yalnız kalkışa açık 09/27 hariç).',
    params: { from: 0, altFt: 7000 },
    build: (p) => {
      // straight-in: Sabiha Gökçen 06L / 06R (from the Marmara over Pendik), Atatürk 05 (off Yeşilköy), İstanbul
      // Havalimanı 35L (from the south, over the Belgrad forest)
      const plans = [{ final: 'LTFJ 06L', dist: 12000 }, { final: 'LTBA 05', dist: 12000 }, { final: 'LTFJ 06R', dist: 12500 }, { final: 'LTFM 35L', dist: 12000 }];
      const pl = plans[p.from] || plans[0];
      const e = RW_ENDS[pl.final], { dx, dz } = dirOf(e.hdg);
      const apt = { LTFJ: 'Sabiha Gökçen', LTBA: 'Atatürk', LTFM: 'İstanbul Havalimanı' }[pl.final.slice(0, 4)];
      return {
        start: { x: e.x - dx * pl.dist, z: e.z - dz * pl.dist, hdg: e.hdg, alt: p.altFt * FT, kt: 250 },
        targetName: `${apt} ${pl.final.slice(5)}`,
        failures: [{ at: { t: 4 }, kind: 'engine', opts: { index: 0, restartable: false }, message: 'Motor söndü: süzül!' }],
        objectives: [{ type: 'land', any: true, exclude: DEPARTURE_ONLY, minStars: 1, target: pl.final, label: 'Bir piste süzül ve in' }],
        limit: 300,
        score: { base: 1000, landing: 10 },
        stars: [1000, 1650, 1900],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 4), altFt: [6000, 7000, 8000][Math.floor(r() * 3)] }),
    dailyNote: (p) => `${['Sabiha Gökçen 06L', 'Atatürk 05', 'Sabiha Gökçen 06R', 'İstanbul Havalimanı 35L'][p.from] || ''} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'ist-marmara', fogBank: false, title: 'Marmara\'ya mecburi iniş', aircraft: 'a320neo', minutes: 3, level: 3, unlock: 3, teaches: 'Çift motor arızası, suya iniş',
    brief: 'Atatürk\'ün 23 pistinden kalktın ve Marmara\'nın üstünde kuş sürüsüne girdin: iki motor birden durdu. Takım kapalı, kanatlar düz, burun hafif yukarıda ve hız en düşük güvenli değerdeyken denize koy.',
    goal: 'Marmara\'ya kontrollü suya iniş (ditching).',
    params: { hdg: 232, altFt: 2000 },
    build: (p) => {
      // 2 km past the Atatürk 23 departure end (Yeşilköy coast), out over the open Marmara (a glide of ≤ 14 km stays
      // inside the map: 2.4 km from its western edge at worst)
      const e = RW_ENDS['LTBA 05'], { dx, dz } = dirOf(RW_ENDS['LTBA 23'].hdg);
      return {
        start: { x: Math.round(e.x + dx * 2000), z: Math.round(e.z + dz * 2000), hdg: p.hdg, alt: p.altFt * FT, kt: 210, gear: false, flaps: 0 },
        failures: [{ at: { t: 3 }, kind: 'engineAll', opts: { restartable: false }, message: 'Çift motor arızası!' }],
        objectives: [{ type: 'ditch', label: 'Suya kontrollü iniş' }],
        limit: 300,
        score: { base: 1000, ditch: 10 },
        stars: 'ditch',
      };
    },
    daily: (r) => ({ hdg: 220 + Math.round(r() * 20), altFt: 1800 + Math.round(r() * 2) * 200 }),
    dailyNote: (p) => `${fmtFt(p.altFt)} ft · ${String(p.hdg).padStart(3, '0')}°`,
  },
  {
    id: 'ist-otorotasyon', fogBank: false, title: 'Yenikapı\'ya otorotasyon', aircraft: 'uh60', minutes: 2, level: 3, unlock: 3, teaches: 'Motorsuz helikopter inişi',
    brief: '{altFt} ft\'te iki motor birden duracak. Kolektifi hemen tam indir, 60–80 kt ile Yenikapı\'daki geniş meydana süzül. 25 m civarında burnu kaldırıp hızı kes, son metrelerde kolektifle yumuşat.',
    goal: 'Yenikapı meydanına (işaretli alan) sağlam iniş.',
    params: { from: 0, altFt: 1500 },
    build: (p) => {
      // from the Marmara: south, south-west or south-east of the field, ≈ 3.4 × the height away (autorotation ≈ 4:1)
      const f = YENIKAPI_FIELD;
      const brg = [180, 210, 150][p.from] ?? 180;
      const d = p.altFt * FT * 3.4;
      const b = dirOf(brg);
      const x = Math.round(f.x + b.dx * d), z = Math.round(f.z + b.dz * d);
      return {
        start: { x, z, hdg: Math.round(bearing(x, z, f.x, f.z)), alt: p.altFt * FT, kt: 80 },
        failures: [{ at: { t: 3 }, kind: 'engineAll', opts: {}, message: 'İki motor durdu: otorotasyon!' }],
        objectives: [{ type: 'pad', x: f.x, z: f.z, y: f.y, r: f.r, profile: 'autorotation', outFail: 'Meydanın dışına indin', label: 'Yenikapı meydanına otorotasyonla in' }],
        limit: 150,
        score: { base: 1000, landing: 8 },             // + field accuracy up to 400
        stars: [1000, 1600, 1900],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 3), altFt: 1200 + Math.round(r() * 4) * 200 }),
    dailyNote: (p) => `${['Güneyden', 'Güneybatıdan', 'Güneydoğudan'][p.from] || ''} · ${fmtFt(p.altFt)} ft`,
  },
];

export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

/**
 * A playable mission: the definition built with its parameters (daily: the day's variation). Text placeholders in
 * brief / goal are filled from the parameters and the built mission.
 * → { id, def, title, aircraft, brief, goal, day, note, params, map: 'ist', ...build(params) }
 */
export function buildMission(id, day = null) {
  const def = missionById(id);
  if (!def) return null;
  const d = parseDay(day);
  const params = { ...def.params, ...(d && def.daily ? def.daily(rng(hashString(`gokyuzu-var-${d}-${id}`))) : {}) };
  const built = def.build(params);
  const fill = (s) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'alt' || k === 'altFt') return fmtFt(params.altFt);
    if (k === 'dist') return km(built.dist ?? params.dist ?? 0);
    if (k === 'side') return params.index === 1 ? 'sağ' : 'sol';
    if (k === 'back') return params.rw === '24L' ? '06R' : '06L';
    if (k === 'target') return built.targetName || '';
    if (k === 'dirText') return params.dir === 'left' ? 'sola (saat yönünün tersine)' : 'sağa (saat yönünde)';
    return params[k] != null ? String(params[k]) : m;
  });
  return {
    ...built, id, def, day: d, params, map: MAP_ID, title: def.title, aircraft: def.aircraft, level: def.level, minutes: def.minutes,
    teaches: def.teaches, brief: fill(def.brief), goal: fill(def.goal), note: d && def.dailyNote ? def.dailyNote(params) : '',
  };
}

// ---------------------------------------------------------------------------------------------------- daily mission
const DAY0 = Date.UTC(2026, 0, 1);
const dayIndex = (day) => Math.round((Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) - DAY0) / 86400e3);
function cycleOrder(cycle) {
  const ids = MISSIONS.map((m) => m.id);
  const r = rng(hashString(`gokyuzu-ist-daily-cycle-${cycle}`));
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids;
}
/**
 * The İstanbul daily mission id for an Istanbul day ('YYYYMMDD'): every mission once per cycle of N days in a shuffled
 * order (the same for everyone; its own order, independent of San Francisco's), never the same mission two days running.
 */
export function dailyMissionId(day = istanbulDay()) {
  const d = parseDay(day) || istanbulDay();
  const n = MISSIONS.length, i = dayIndex(d);
  const cycle = Math.floor(i / n), pos = ((i % n) + n) % n;
  const order = cycleOrder(cycle);
  if (pos <= 1 && order[0] === cycleOrder(cycle - 1)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order[pos];
}
/** Today's (or `day`'s) İstanbul daily mission, built with the day's variation. */
export function dailyMission(day = istanbulDay()) {
  const d = parseDay(day) || istanbulDay();
  return buildMission(dailyMissionId(d), d);
}
