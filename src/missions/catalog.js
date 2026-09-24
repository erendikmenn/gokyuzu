// Mission catalog (CONTRACTS-SF.md §12): missions as data — start state, objectives, scheduled failures, time limit,
// score and star thresholds — plus the daily mission ("Günün görevi": a deterministic pick + variation per Istanbul
// day) and the player's progress (localStorage). No DOM, no three.js: the menu's "Görevler" tab, the runtime
// (src/missions/runtime.js) and tests/missions.test.mjs all read it.
//
// Units: meters, m MSL, headings in degrees true, speeds in knots (converted by the runtime), times in seconds.
//
// Start state (resolved by runtime.resolveStart with runways.json):
//   { runway: 'KSFO 28R' }                        on the runway, 45 m past the threshold, ready for take-off
//   { final: 'KSFO 28R', dist: 8000 }             airborne on the 3° glide path, landing configuration
//   { x, z, hdg, alt, kt, gear?, flaps? }          airborne (fixed wing: trimmed; helicopter: trimmed at kt)
// Objectives (evaluated in order by src/missions/objectives.js):
//   altitude { min (m MSL) }                      reach an altitude
//   bridge   { bridge: 'golden_gate' }            pass under the deck between the towers (landmark collision validates)
//   gates    { shape: 'frame'|'ring', gates: [{ x, z, y, hw, hh } | { x, z, y, r }] }   ordered gates, tolerance `tol` m
//   hover    { x, z, y, r, hmin, hmax, t, maxKt } hold a hover over a point
//   pad      { x, z, y, r }                       helicopter touchdown on a pad
//   land     { runways?, airports?, any?, minStars, target }   touchdown on a runway (landing score ≥ minStars)
//   ditch    {}                                   controlled water landing (sink, attitude, wings level, speed, gear)
// Failures: [{ at: { t } | { agl } | { ias }, kind, opts }] → flight.failures.inject(kind, opts) (src/flight/failures.js).
import { hashString, rng, istanbulDay, parseDay, dirOf, bearing, FT } from './util.js';

export { istanbulDay, parseDay };

/** Bridges the missions fly under: centre, axis bearing (towards the south end), half the tower spacing, fallback clearance. */
export const BRIDGES = {
  // assets/sf/landmarks/index.json golden_gate: origin (-9273.28, -22220.97), heading 6.18518 rad → local +Z (deck axis)
  // points 174.38° true; towers at ±640 m; deck underside 64–68 m above the water (real: 67 m / 220 ft at mid-span)
  golden_gate: { name: 'Golden Gate Köprüsü', x: -9273.28, z: -22220.97, axis: 174.38, half: 640, clear: 64 },
};

// Alcatraz: the old parade ground on the island's south-east side is flat at 19.7 m (terrain probe, 60 × 45 m clear)
const ALCATRAZ_PAD = { x: -4250, z: -22922, y: 19.7 };

// runway thresholds used to place starts (data/sf/runways.json: x, z, true heading)
const RW_ENDS = { 'KSFO 28L': { x: 1464, z: 796, hdg: 297.42 }, 'KSFO 28R': { x: 1572, z: 594, hdg: 297.43 } };

const gg = BRIDGES.golden_gate;
/** Point `d` m from the Golden Gate mid-span along the crossing direction (hdg 84.38° = into the bay). */
function ggApproach(d, eastbound) {
  const hdg = eastbound ? gg.axis - 90 : gg.axis + 90;   // 84.38 / 264.38
  const { dx, dz } = dirOf(hdg);
  return { x: gg.x - dx * d, z: gg.z - dz * d, hdg };
}

// ------------------------------------------------------------------------------------------------------------ missions
// Every mission: id, title, aircraft, minutes (typical), level (1–3), teaches, brief (1–3 sentences), goal (one line),
// params (defaults) → build(p) → { start, objectives, failures, limit, manual (no autopilot), score, stars, route? },
// daily(r) → params, dailyNote(p).
export const MISSIONS = [
  {
    id: 'climb', title: 'Dik tırmanış', aircraft: 'f22', minutes: 1, level: 1, teaches: 'Art yakıcı, kalkış ve tırmanış',
    brief: 'Alameda Hava Üssü, pist {rw}. F-22\'nin itkisi ağırlığından fazla: art yakıcıyı aç, rotasyondan sonra burnu dikçe kaldır ve tırman.',
    goal: '{alt} ft\'e olabildiğince çabuk çık.',
    params: { rw: '24', altFt: 10000 },
    build: (p) => {
      // 1000 for reaching it + 25 per second under the 120 s limit; ★★ / ★★★ times scale with the target (10,000 ft:
      // 75 / 55 s — a clean max-performance climb from brake release takes ~45 s in the model)
      const k = p.altFt / 10000, at = (t) => 1000 + Math.round((120 - t * k) * 25);
      return {
        start: { runway: `KNGZ ${p.rw}` },
        objectives: [{ type: 'altitude', min: p.altFt * FT, label: `${fmtFt(p.altFt)} ft'e tırman` }],
        limit: 120, manual: true,
        score: { base: 1000, par: 120, perSec: 25 },
        stars: [1000, at(75), at(55)],
      };
    },
    daily: (r) => ({ rw: r() < 0.5 ? '24' : '06', altFt: [8000, 10000, 12000][Math.floor(r() * 3)] }),
    dailyNote: (p) => `Pist ${p.rw} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'gg-under', fogBank: false, title: 'Golden Gate\'in altından geç', aircraft: 'f16', minutes: 2, level: 1, teaches: 'Alçak irtifada hassas kontrol',
    brief: 'Köprü {dist} km önünde. Kuleler arası 1.280 m, deniz ile tabliye arası yaklaşık 65 m: tam ortadan, 30–40 m\'den geç.',
    goal: 'Tabliyenin altından geç, sonra 1.500 ft\'e tırman.',
    params: { east: true, dist: 5500, alt: 120, kt: 300 },
    build: (p) => {
      const s = ggApproach(p.dist, p.east);
      return {
        start: { x: s.x, z: s.z, hdg: s.hdg, alt: p.alt, kt: p.kt },
        objectives: [
          { type: 'bridge', bridge: 'golden_gate', label: 'Köprünün altından geç' },
          { type: 'altitude', min: 1500 * FT, label: '1.500 ft\'e tırman' },
        ],
        limit: 150, manual: true,
        score: { base: 1000, par: 90, perSec: 10 },     // + bridge: up to 500 for the centre, 300 for mid-gap height
        stars: [1000, 1700, 2100],
      };
    },
    daily: (r) => ({ east: r() < 0.6, dist: 5000 + Math.round(r() * 1500), alt: 100 + Math.round(r() * 80), kt: 280 + Math.round(r() * 60) }),
    dailyNote: (p) => (p.east ? 'Batıdan, körfeze doğru' : 'Körfezden, okyanusa doğru'),
  },
  {
    id: 'sfo-28r', title: 'SFO 28R\'ye iniş', aircraft: 'a320neo', minutes: 2, level: 1, teaches: 'Son yaklaşma ve yumuşak iniş',
    brief: 'SFO\'ya son yaklaşmadasın: takım ve flaplar açık, hız ayarlı. Merkez hattında ve 3°\'lik süzülüşte kal, eşiği geçince gazı kes ve hafifçe burnu kaldır.',
    goal: 'Pist {rw}\'ye iniş: temas bölgesine, 200 ft/dk civarında.',
    params: { rw: '28R', dist: 8000 },
    build: (p) => ({
      start: { final: `KSFO ${p.rw}`, dist: p.dist },
      objectives: [{ type: 'land', runways: [`KSFO ${p.rw}`], minStars: 1, target: `KSFO ${p.rw}`, label: `Pist ${p.rw}'ye in` }],
      limit: 240, manual: true,                           // no autoland: the landing is the test
      score: { base: 0, landing: 20 },                     // landing points × 20 (0–2000)
      stars: 'landing',
    }),
    daily: (r) => ({ rw: r() < 0.5 ? '28R' : '28L', dist: 7000 + Math.round(r() * 3000) }),
    dailyNote: (p) => `Pist ${p.rw} · ${(p.dist / 1852).toFixed(1).replace('.', ',')} NM`,
  },
  {
    id: 'alcatraz', fogBank: false, title: 'Alcatraz\'a hassas iniş', aircraft: 'uh60', minutes: 2, level: 2, teaches: 'Hover ve hassas iniş',
    brief: 'Alcatraz\'ın güneydoğusundaki eski tören alanına bir iniş pedi işaretlendi. Yavaşla, pedin üstünde asılı kal, sonra dikey in.',
    goal: 'Pedin üstünde 5 sn asılı kal ve pedin ortasına in.',
    params: { from: 0 },
    build: (p) => {
      const froms = [[-2900, -21400], [-3000, -24300], [-5900, -22000]];
      const [x, z] = froms[p.from] || froms[0];
      return {
        start: { x, z, hdg: bearing(x, z, ALCATRAZ_PAD.x, ALCATRAZ_PAD.z), alt: 150, kt: 80 },
        objectives: [
          { type: 'hover', ...ALCATRAZ_PAD, r: 12, hmin: 3, hmax: 20, t: 5, maxKt: 6, label: 'Pedin üstünde asılı kal' },
          { type: 'pad', ...ALCATRAZ_PAD, r: 10, label: 'Pede in' },
        ],
        limit: 240,
        score: { base: 1000, par: 150, perSec: 5, landing: 8 },   // + pad accuracy up to 400, hover steadiness up to 300
        stars: [1000, 1700, 2150],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 3) }),
    dailyNote: (p) => ['Pier 39 tarafından', 'Kuzeyden, Marin tarafından', 'Batıdan, Golden Gate tarafından'][p.from] || '',
  },
  {
    id: 'low-pass', fogBank: false, title: 'Alçak geçiş', aircraft: 'f22', minutes: 2, level: 2, teaches: 'Alçak irtifa ve hız yönetimi',
    brief: 'Körfezin ortasına 5 kapı dizildi, her biri deniz üstünde 10–70 m arası. Sırayla geç; kapının üstünden ya da yanından geçersen sayılmaz, dönüp yeniden dene.',
    goal: '5 kapıdan sırayla, olabildiğince hızlı geç.',
    params: { jit: [0, 0, 0, 0, 0], y: 40 },
    build: (p) => {
      // a gentle slalom up the middle of the bay (legs 3.2 km, ±18° either side of north: 35–40° turns at 360 kt)
      const base = [[3500, -3500], [4500, -6500], [3500, -9500], [4500, -12500], [3500, -15500]];
      const gates = base.map(([x, z], i) => ({ x: x + (p.jit[i] || 0), z, y: p.y, hw: 60, hh: 30 }));
      const s = { x: 3200, z: -500 };
      return {
        start: { x: s.x, z: s.z, hdg: bearing(s.x, s.z, gates[0].x, gates[0].z), alt: 60, kt: 380 },
        objectives: [{ type: 'gates', shape: 'frame', gates, tol: 8, label: 'Kapılardan geç' }],
        limit: 150, manual: true,
        score: { base: 0, par: 120, perSec: 15, gate: 200, gateAcc: 100 },
        stars: [1000, 1500, 1800],
      };
    },
    daily: (r) => ({ jit: [0, 0, 0, 0, 0].map(() => Math.round((r() - 0.5) * 800)), y: 30 + Math.round(r() * 20) }),
    dailyNote: () => 'Kapılar yer değiştirdi',
  },
  {
    id: 'bay-tour', fogBank: false, title: 'Körfez turu', aircraft: 'b737', minutes: 3, level: 2, teaches: 'Rota uçuşu ve otopilot (NAV)',
    brief: 'Körfezin üç simgesini tek turda gör: Bay Köprüsü, Alcatraz ve Golden Gate. Rota hazır: istersen otopilotu açıp NAV ile uçur, istersen elle.',
    goal: 'Üç halkadan sırayla geç.',
    params: { altFt: 2000 },
    build: (p) => {
      const y = p.altFt * FT, low = Math.min(y, 1500 * FT);
      // rings on straight legs: each ring's leg starts at a turn point in line with it (so a fly-by turn of the NAV
      // autopilot never cuts a ring) — Bay Bridge (west span), then Alcatraz, then the Golden Gate mid-span
      const s = { x: 3000, z: -15500 };
      const r1 = { x: -358, z: -19922 }, r2 = { x: -4393, z: -23017 }, r3 = { x: gg.x, z: gg.z };
      const lead = (r, from, d) => { const L = Math.hypot(r.x - from.x, r.z - from.z); return { x: r.x + (r.x - from.x) / L * d, z: r.z + (r.z - from.z) / L * d }; };
      const t1 = lead(r1, s, 2500), t2 = lead(r2, t1, 2000);
      const gates = [
        { ...r1, y, r: 150, name: 'Bay Köprüsü', from: [s.x, s.z] },
        { ...r2, y: low, r: 150, name: 'Alcatraz', from: [t1.x, t1.z] },
        { ...r3, y: low, r: 150, name: 'Golden Gate', from: [t2.x, t2.z] },
      ];
      return {
        start: { x: s.x, z: s.z, hdg: bearing(s.x, s.z, r1.x, r1.z), alt: y, kt: 230 },
        objectives: [{ type: 'gates', shape: 'ring', gates, tol: 20, label: 'Halkalardan geç' }],
        route: [{ ...r1, alt: y }, { ...t1, alt: low }, { ...r2, alt: low }, { ...t2, alt: low }, { ...r3, alt: low }],
        limit: 300,
        score: { base: 0, par: 180, perSec: 5, gate: 300, gateAcc: 150 },
        stars: [900, 1250, 1500],
      };
    },
    daily: (r) => ({ altFt: [1800, 2000, 2500][Math.floor(r() * 3)] }),
    dailyNote: (p) => `${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'eng-takeoff', title: 'Kalkışta motor arızası', aircraft: 'b737', minutes: 4, level: 3, unlock: 3, teaches: 'Tek motorla uçuş ve dönüş',
    brief: 'SFO pist {rw}, körfeze doğru kalkış. {ftFail} ft\'te {side} motor duracak: burnu biraz indir, hızı koru, dümenle düz uç. 1.500 ft\'e tırman, körfezin üstünde geri dön ve in ({back} en yakını).',
    goal: 'SFO\'da herhangi bir piste güvenli iniş.',
    params: { rw: '01R', index: 0, ftFail: 400 },
    build: (p) => {
      const back = p.rw === '01R' ? '19L' : '19R';   // the reciprocal of the departure runway: a teardrop over the bay
      return {
        start: { runway: `KSFO ${p.rw}` },
        failures: [{ at: { agl: p.ftFail * FT }, kind: 'engine', opts: { index: p.index }, message: `${p.index === 0 ? 'Sol' : 'Sağ'} motor arızası!` }],
        objectives: [
          { type: 'altitude', min: 1500 * FT, label: '1.500 ft\'e tırman' },
          { type: 'land', airports: ['KSFO'], minStars: 1, target: `KSFO ${back}`, label: 'SFO\'ya geri dön ve in' },
        ],
        limit: 480,
        score: { base: 1000, landing: 12, par: 360, perSec: 3 },
        stars: [1000, 1750, 2150],
      };
    },
    daily: (r) => ({ rw: r() < 0.5 ? '01R' : '01L', index: r() < 0.5 ? 0 : 1, ftFail: 300 + Math.round(r() * 3) * 100 }),
    dailyNote: (p) => `Pist ${p.rw} · ${p.index === 0 ? 'sol' : 'sağ'} motor · ${p.ftFail} ft`,
  },
  {
    id: 'flameout', title: 'Alev sönmesi', aircraft: 'f16', minutes: 3, level: 3, unlock: 3, teaches: 'Süzülüş ve enerji yönetimi',
    brief: '{altFt} ft\'te motor sönecek ve yeniden yanmayacak. F-16 en iyi 200 kt civarında süzülür: fazla yüksekliği S dönüşleri ve hava freniyle harca. Hidrolik B gider: takım için önce G, sonra ACİL (klavyede I) ile acil indirme.',
    goal: '{target} pistine motorsuz, güvenli iniş (başka pist de olur).',
    params: { from: 0, altFt: 7000 },
    build: (p) => {
      // 0: straight in to SFO 28L from 12 km over the bay; 1: Alameda from the south (a pattern over the field);
      // 2: straight in to SFO 28R from 14 km
      const plans = [
        { final: 'KSFO 28L', dist: 12000 }, { x: 6000, z: -8000, hdg: 350, target: 'KNGZ 24' }, { final: 'KSFO 28R', dist: 14000 },
      ];
      const pl = plans[p.from] || plans[0];
      let start, target = pl.target;
      if (pl.final) {
        const e = RW_ENDS[pl.final];
        const c = e.hdg * Math.PI / 180;
        start = { x: e.x - Math.sin(c) * pl.dist, z: e.z + Math.cos(c) * pl.dist, hdg: e.hdg, alt: p.altFt * FT, kt: 250 };
        target = pl.final;
      } else start = { x: pl.x, z: pl.z, hdg: pl.hdg, alt: p.altFt * FT, kt: 250 };
      return {
        start, targetName: target.replace(/^K/, ''),
        failures: [{ at: { t: 4 }, kind: 'engine', opts: { index: 0, restartable: false }, message: 'Motor söndü: süzül!' }],
        objectives: [{ type: 'land', any: true, minStars: 1, target, label: 'Bir piste süzül ve in' }],
        limit: 300,
        score: { base: 1000, landing: 10 },
        stars: [1000, 1650, 1900],
      };
    },
    daily: (r) => ({ from: Math.floor(r() * 3), altFt: [6000, 7000, 8000][Math.floor(r() * 3)] }),
    dailyNote: (p) => `${['SFO 28L', 'Alameda (güneyden)', 'SFO 28R'][p.from] || ''} · ${fmtFt(p.altFt)} ft`,
  },
  {
    id: 'ditch', fogBank: false, title: 'Körfeze mecburi iniş', aircraft: 'a320neo', minutes: 3, level: 3, unlock: 3, teaches: 'Çift motor arızası, suya iniş',
    brief: 'Kuş sürüsü: iki motor birden durdu ve hiçbir piste yetişemezsin. Takım kapalı, kanatlar düz, burun hafif yukarıda ve hız en düşük güvenli değerdeyken suya koy.',
    goal: 'Körfeze kontrollü suya iniş (ditching).',
    params: { hdg: 100, altFt: 2500 },
    build: (p) => ({
      start: { x: 3000, z: -4000, hdg: p.hdg, alt: p.altFt * FT, kt: 210, gear: false, flaps: 0 },
      failures: [{ at: { t: 3 }, kind: 'engineAll', opts: { restartable: false }, message: 'Çift motor arızası!' }],
      objectives: [{ type: 'ditch', label: 'Suya kontrollü iniş' }],
      limit: 300,
      score: { base: 1000, ditch: 10 },
      stars: 'ditch',
    }),
    daily: (r) => ({ hdg: 70 + Math.round(r() * 60), altFt: 2000 + Math.round(r() * 2) * 500 }),
    dailyNote: (p) => `${fmtFt(p.altFt)} ft · ${String(p.hdg).padStart(3, '0')}°`,
  },
  {
    id: 'autorotation', title: 'Otorotasyon', aircraft: 'uh60', minutes: 2, level: 3, unlock: 3, teaches: 'Motorsuz helikopter inişi',
    brief: '{altFt} ft\'te iki motor birden duracak. Kolektifi hemen tam indir ki rotor devri düşmesin ve 60–80 kt ile süzül. 25 m civarında burnu kaldırıp hızı kes, son metrelerde kolektifle yumuşat.',
    goal: 'Yere sağlam iniş (pist en iyisi).',
    params: { rw: '24', altFt: 1500 },
    build: (p) => {
      const t = p.rw === '24' ? { x: 6376, z: -18956, hdg: 255 } : { x: 3768, z: -18257, hdg: 75 };
      return {
        start: { x: t.x, z: t.z, hdg: t.hdg, alt: p.altFt * FT + 3, kt: 80 },
        failures: [{ at: { t: 3 }, kind: 'engineAll', opts: {}, message: 'İki motor durdu: otorotasyon!' }],
        objectives: [{ type: 'land', any: true, heli: true, minStars: 1, profile: 'autorotation', target: `KNGZ ${p.rw}`, label: 'Otorotasyonla in' }],
        limit: 150,
        score: { base: 1000, landing: 10, runwayBonus: 200 },
        stars: [1000, 1650, 1950],
      };
    },
    daily: (r) => ({ rw: r() < 0.5 ? '24' : '06', altFt: 1200 + Math.round(r() * 4) * 200 }),
    dailyNote: (p) => `Alameda ${p.rw} · ${fmtFt(p.altFt)} ft`,
  },
];

function fmtFt(ft) { return String(Math.round(ft)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

/**
 * A playable mission: the definition built with its parameters (daily: the day's variation). Text placeholders
 * ({rw}, {alt}, …) in brief / goal are filled from the parameters.
 * → { id, def, title, aircraft, brief, goal, day, note, params, ...build(params) }
 */
export function buildMission(id, day = null) {
  const def = missionById(id);
  if (!def) return null;
  const d = parseDay(day);
  const params = { ...def.params, ...(d && def.daily ? def.daily(rng(hashString(`gokyuzu-var-${d}-${id}`))) : {}) };
  const built = def.build(params);
  const fill = (s) => String(s || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'alt') return fmtFt(params.altFt);
    if (k === 'altFt') return fmtFt(params.altFt);
    if (k === 'dist') return (params.dist / 1000).toFixed(1).replace('.', ',').replace(',0', '');
    if (k === 'side') return params.index === 1 ? 'sağ' : 'sol';
    if (k === 'back') return params.rw === '01L' ? '19R' : '19L';
    if (k === 'target') return built.targetName || '';
    return params[k] != null ? String(params[k]) : m;
  });
  return {
    ...built, id, def, day: d, params, title: def.title, aircraft: def.aircraft, level: def.level, minutes: def.minutes,
    teaches: def.teaches, brief: fill(def.brief), goal: fill(def.goal), note: d && def.dailyNote ? def.dailyNote(params) : '',
  };
}

// ---------------------------------------------------------------------------------------------------- daily mission
const DAY0 = Date.UTC(2026, 0, 1);
const dayIndex = (day) => Math.round((Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) - DAY0) / 86400e3);
function cycleOrder(cycle) {
  const ids = MISSIONS.map((m) => m.id);
  const r = rng(hashString(`gokyuzu-daily-cycle-${cycle}`));
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids;
}
/**
 * The daily mission id for an Istanbul day ('YYYYMMDD'): every mission once per cycle of N days in a shuffled order
 * (the same for everyone), never the same mission two days running.
 */
export function dailyMissionId(day = istanbulDay()) {
  const d = parseDay(day) || istanbulDay();
  const n = MISSIONS.length, i = dayIndex(d);
  const cycle = Math.floor(i / n), pos = ((i % n) + n) % n;
  const order = cycleOrder(cycle);
  // a new cycle must not start with yesterday's mission (the swap only touches positions 0 and 1, never the last one)
  if (pos <= 1 && order[0] === cycleOrder(cycle - 1)[n - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order[pos];
}
/** Today's (or `day`'s) daily mission, built with the day's variation. */
export function dailyMission(day = istanbulDay()) {
  const d = parseDay(day) || istanbulDay();
  return buildMission(dailyMissionId(d), d);
}

// --------------------------------------------------------------------------------------------------------- progress
const STORE = 'gokyuzu.missions';
function readStore() {
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); return s && typeof s === 'object' && s.m ? s : { v: 1, m: {}, daily: {} }; } catch { return { v: 1, m: {}, daily: {} }; }
}
function writeStore(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode */ } }

/** { [id]: { stars, best, runs, done } } and { [day]: { id, stars, best } } */
export function loadProgress() { const s = readStore(); return { missions: s.m, daily: s.daily || {} }; }
export function totalStars(progress = loadProgress()) {
  return Object.values(progress.missions).reduce((a, p) => a + (p && p.stars ? p.stars : 0), 0);
}
/** Unlocked in the menu (deep links and the daily mission always play). */
export function isUnlocked(def, progress = loadProgress()) { return !def.unlock || totalStars(progress) >= def.unlock; }

/** Record a finished run → { newBest, prevBest, prevStars }. Daily runs also count for the mission itself. */
export function recordResult(id, { ok, score, stars, day = null }) {
  const s = readStore();
  const p = s.m[id] || (s.m[id] = { stars: 0, best: 0, runs: 0, done: false });
  const prev = { prevBest: p.best || 0, prevStars: p.stars || 0 };
  p.runs = (p.runs || 0) + 1;
  let newBest = false;
  if (ok) {
    p.done = true;
    if (score > (p.best || 0)) { p.best = score; newBest = true; }
    p.stars = Math.max(p.stars || 0, stars || 0);
  }
  if (day && ok) {
    s.daily = s.daily || {};
    const dd = s.daily[day] || (s.daily[day] = { id, stars: 0, best: 0 });
    if (score > dd.best) dd.best = score;
    dd.stars = Math.max(dd.stars, stars || 0);
    const keys = Object.keys(s.daily).sort();
    while (keys.length > 60) delete s.daily[keys.shift()];   // keep two months
  }
  writeStore(s);
  return { newBest, ...prev };
}

export const AIRCRAFT_SHORT = { f16: 'F-16C', f22: 'F-22A', a320neo: 'A320neo', b737: '737-800', uh60: 'UH-60M' };
export const LEVEL_LABEL = ['', 'Kolay', 'Orta', 'Zor'];
