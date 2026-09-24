// İstanbul map module (src/maps/index.js; its own lazily loaded chunk): start points, place names and water bodies,
// the minimap's labels and bridges, loading tips, avionics data and credits. Coordinates: local meters of
// data/ist/region.json (UTM 35N, origin Galata Kulesi; x = east, z = south), from OpenStreetMap (© OpenStreetMap
// contributors, ODbL): bridge decks, runway thresholds (fallback when data/ist/runways.json has no such runway),
// district centres (admin_level 6). The engine's shared tables come in through register() / activate() (src/maps/index.js
// mapHooks) instead of imports, so the San Francisco entry's modules stay in their chunks.
import { createUtm } from './utm.js';

/** Projection of data/ist/region.json (src/geo.js setGeoRegion). */
export const utm = createUtm('EPSG:32635');

const rad = (d) => d * Math.PI / 180;
const TAN3 = Math.tan(rad(3));

/** Runway spawns: the first ident found per entry (data/ist/runways.json names, e.g. "LTFM 35L"). */
const RUNWAY_STARTS = [
  ['LTFM', ['35L', '35R', '36', '34L', '34R'], 'İstanbul Havalimanı · Pist {rw} (kuzeye, Karadeniz)'],
  ['LTFM', ['34L', '34R', '16R', '16L'], 'İstanbul Havalimanı · Pist {rw}'],
  ['LTFJ', ['06L', '06R', '06', '24R', '24L'], 'Sabiha Gökçen · Pist {rw} (Anadolu yakası)'],
  ['LTBA', ['05', '23', '35L', '35R'], 'Atatürk · Pist {rw} (Marmara kıyısı)'],
];
// final approaches: threshold from runways.json, else these OSM thresholds (x, z, true heading, elevation m)
const FINALS = [
  { id: 'IST-AIR-LTFM-FINAL', icao: 'LTFM', idents: ['35L', '35R', '36', '34L'], fb: { ident: '35L', x: -21450, z: -25795, h: 358.03, elev: 99 },
    name: 'Havada · İstanbul Havalimanı {rw} son yaklaşma' },
  { id: 'IST-AIR-LTFJ-FINAL', icao: 'LTFJ', idents: ['06L', '06R', '06'], fb: { ident: '06L', x: 27211, z: 14100, h: 62.6, elev: 95 },
    name: 'Havada · Sabiha Gökçen {rw} son yaklaşma (Marmara üstünden)' },
];

/** Start points (src/app/spawns.js format) from the map's runways.json ({ airports: [] } while it does not exist). */
export function buildSpawns(runways) {
  const list = [];
  const ends = new Map();
  for (const a of (runways && runways.airports) || []) {
    for (const r of a.runways || []) for (const e of r.ends || []) ends.set(`${a.icao} ${e.ident}`, { ...e, elev: r.elevation ?? a.elevation ?? 0 });
  }
  const used = new Set();
  for (const [icao, idents, name] of RUNWAY_STARTS) {
    const ident = idents.find((i) => ends.has(`${icao} ${i}`) && !used.has(`${icao} ${i}`));
    if (!ident) continue;
    used.add(`${icao} ${ident}`);
    const e = ends.get(`${icao} ${ident}`), h = rad(e.headingTrue), back = 45;
    list.push({ id: `${icao}-${ident}`, name: name.replace('{rw}', ident), x: e.x + Math.sin(h) * back, z: e.z - Math.cos(h) * back, heading: h, airport: icao });
  }
  // airborne: over the Bosphorus toward 15 Temmuz Şehitler Köprüsü, Kız Kulesi and the old city, the Golden Horn
  list.push({ id: 'IST-AIR-BOGAZ', name: 'Havada · Boğaz, 15 Temmuz Şehitler Köprüsü’ne doğru (300 m)', x: 1925, z: 225, heading: rad(50.4), altitude: 300, airborne: true });
  list.push({ id: 'IST-AIR-KIZKULESI', name: 'Havada · Kız Kulesi ve Tarihi Yarımada (200 m)', x: 2700, z: 2800, heading: rad(340), altitude: 200, airborne: true });
  list.push({ id: 'IST-AIR-HALIC', name: 'Havada · Haliç ve Galata üstü (350 m)', x: 1300, z: 1500, heading: rad(303), altitude: 350, airborne: true });
  for (const f of FINALS) {
    const ident = f.idents.find((i) => ends.has(`${f.icao} ${i}`));
    const e = ident ? ends.get(`${f.icao} ${ident}`) : null;
    const t = e ? { ident, x: e.x, z: e.z, h: e.headingTrue, elev: e.elev } : f.fb;
    const h = rad(t.h), d = 9000;
    list.push({ id: f.id, name: f.name.replace('{rw}', t.ident), x: t.x - Math.sin(h) * d, z: t.z + Math.cos(h) * d, heading: h, altitude: Math.round(t.elev + d * TAN3), airborne: true, final: true });
  }
  // helicopters start in a hover (speed 0; fixed wing aircraft fly it at their airborne start speed)
  list.push({ id: 'IST-HOVER-GALATA', name: 'Havada · Galata Kulesi önünde askıda (helikopter, 180 m)', x: -150, z: 750, heading: rad(10), altitude: 180, airborne: true, hover: true });
  return list;
}

// ---------------------------------------------------------------------------------------------------- places
// district centres (OSM admin_level 6 relation centres)
const DISTRICTS = [
  ['Büyükçekmece', -38875, -2722], ['Beylikdüzü', -27386, 4753], ['Arnavutköy', -27275, -24178], ['Esenyurt', -26361, -2044],
  ['Avcılar', -21436, -874], ['Başakşehir', -19432, -8259], ['Küçükçekmece', -16350, 905], ['Bakırköy', -11621, 5246],
  ['Bağcılar', -11297, -1911], ['Bahçelievler', -10751, 1984], ['Esenler', -9080, -3893], ['Eyüpsultan', -8823, -15321],
  ['Sultangazi', -8753, -10375], ['Güngören', -7837, 780], ['Bayrampaşa', -6193, -2663], ['Gaziosmanpaşa', -5780, -5134],
  ['Zeytinburnu', -5379, 2381], ['Fatih', -1668, 1294], ['Beyoğlu', -300, -1300], ['Kâğıthane', 177, -6031], ['Şişli', 1133, -4570],
  ['Sarıyer', 3848, -16315], ['Beşiktaş', 3000, -3600], ['Üsküdar', 5200, -800], ['Adalar', 11500, 17800], ['Kadıköy', 5600, 4200],
  ['Ümraniye', 13729, -507], ['Ataşehir', 13878, 4258], ['Maltepe', 15474, 8698], ['Kartal', 19019, 11765], ['Beykoz', 17000, -12000],
  ['Çekmeköy', 24748, -5849], ['Sancaktepe', 25371, 2289], ['Sultanbeyli', 25739, 5732], ['Tuzla', 32479, 14069], ['Pendik', 32735, 6781],
];
// the Bosphorus and the Golden Horn as centre lines (water within `w` m of them)
const BOGAZ = [[1400, 1100], [2400, -300], [3600, -1200], [5007, -2325], [6100, -4300], [7142, -7470], [8600, -11200], [9500, -14500], [11083, -19967], [12200, -21800]];
const HALIC = [[-60, 617], [-760, 160], [-1700, -600], [-2750, -1950], [-3900, -3300], [-4700, -4700]];
function segDist(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}
/** HUD place line ("Boğaz üzeri", "Kadıköy üzeri"). */
function regionName(x, z, water) {
  if (water) {
    if (segDist(HALIC, x, z) < 450) return 'Haliç üzeri';
    if (segDist(BOGAZ, x, z) < 1300) return 'İstanbul Boğazı üzeri';
    if (z < -20500) return 'Karadeniz üzeri';
    if (Math.hypot(x + 17500, z - 1500) < 3500) return 'Küçükçekmece Gölü üzeri';
    if (Math.hypot(x + 36000, z + 500) < 5000) return 'Büyükçekmece Gölü üzeri';
    return z > -1000 ? 'Marmara Denizi üzeri' : 'Baraj gölü üzeri';
  }
  let best = null, bd = Infinity;
  for (const d of DISTRICTS) { const e = (d[1] - x) ** 2 + (d[2] - z) ** 2; if (e < bd) { bd = e; best = d; } }
  return bd < 12000 ** 2 ? `${best[0]} üzeri` : 'İstanbul üzeri';
}

const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
/**
 * Place names on the minimap / navigation map (src/ui/minimap.js, src/ui/map.js): label(text, x, y, color, font) places
 * one (it keeps labels apart and inside the map); zoom = map scale relative to the district names' threshold (≥ 1: shown).
 */
function drawPlaces(ctx, X, Y, label, zoom, big = false) {
  for (const l of MAP.labels) {
    if (l.min ? zoom * 0.012 < l.min : l.k !== 'water' && zoom < 1) continue;
    const w = l.k === 'water';
    label(l.t, X(l.x), Y(l.z), w ? 'rgba(150,200,240,0.8)' : 'rgba(220,232,248,0.64)', `${w ? 'italic 650' : '700'} ${big ? (w ? 12 : 11) : (w ? 9.5 : 9)}px ${SANS}`);
  }
}

// ------------------------------------------------------------------------------------------------ map data
export const MAP = {
  drawPlaces,
  mapImage: 'ist-map',         // src/ui/assets/ist-map.jpg + .json (src/ui/tools/bake_ist_map.py)
  declination: 6.2,            // magnetic declination (° E), when runways.json has none
  defaultSpawns: { f16: 'LTBA-05', f22: 'LTBA-05', a320neo: 'LTFM-35L', b737: 'LTFM-34L', uh60: 'IST-HOVER-GALATA' },
  shareTitle: 'İstanbul uçuş simülatörü',
  creditsLine: 'Harita verisi © OpenStreetMap katkıcıları (ODbL) · Overture Maps Foundation · Copernicus Sentinel verisi / Copernicus DEM (ESA) · Three.js (MIT) · B612 font (OFL)',
  credits: [
    ['Harita verisi', '© OpenStreetMap katkıcıları (ODbL)'],
    ['Bina verisi', 'OpenStreetMap, Overture Maps Foundation'],
    ['Uydu görüntüsü', 'Değiştirilmiş Copernicus Sentinel verisi (ESA)'],
    ['Yükseklik verisi', 'Copernicus DEM GLO-30 (ESA)'],
  ],
  // labels on the menu map / minimap / navigation map (water bodies, districts); menu: shown on the menu's small map
  labels: [
    { t: 'Karadeniz', x: 4000, z: -29500, k: 'water', menu: true }, { t: 'Marmara Denizi', x: 6000, z: 12500, k: 'water', menu: true },
    { t: 'Boğaz', x: 7400, z: -5600, k: 'water', menu: true }, { t: 'Haliç', x: -2300, z: -1000, k: 'water' },
    { t: 'Fatih', x: -1400, z: 1500, k: 'city' }, { t: 'Beyoğlu', x: 300, z: -1500, k: 'city' }, { t: 'Beşiktaş', x: 2700, z: -3300, k: 'city' },
    { t: 'Üsküdar', x: 5200, z: -700, k: 'city' }, { t: 'Kadıköy', x: 5400, z: 4000, k: 'city' },
    { t: 'Şişli', x: 1200, z: -4800, k: 'city' }, { t: 'Sarıyer', x: 6000, z: -14500, k: 'city' }, { t: 'Bakırköy', x: -11600, z: 4600, k: 'city' },
    { t: 'Adalar', x: 11500, z: 17800, k: 'city' }, { t: 'Beykoz', x: 14500, z: -11000, k: 'city' }, { t: 'Pendik', x: 31000, z: 9500, k: 'city' },
    { t: 'Başakşehir', x: -19400, z: -8300, k: 'city' }, { t: 'Arnavutköy', x: -27000, z: -20000, k: 'city' }, { t: 'Ataşehir', x: 13800, z: 4200, k: 'city' },
    { t: 'Tarihi Yarımada', x: 300, z: 1600, k: 'lm', min: 0.05 },
  ],
  menuTitle: { x: -2600, z: 1800, t: 'İstanbul' },
  // bridge decks (OSM), drawn on the maps
  bridges: [
    { name: '15 Temmuz Şehitler Köprüsü', a: [4512, -2924], b: [5502, -1726] },
    { name: 'Fatih Sultan Mehmet Köprüsü', a: [7720, -7525], b: [6563, -7428] },
    { name: 'Yavuz Sultan Selim Köprüsü', a: [10223, -20457], b: [11943, -19478] },
    { name: 'Galata Köprüsü', a: [-166, 821], b: [46, 414] },
    { name: 'Atatürk Köprüsü', a: [-544, 26], b: [-972, 302] },
    { name: 'Haliç Köprüsü', a: [-3000, -1521], b: [-2493, -2374] },
  ],
  regionName,
  // terrain water shader (src/world-sf/terrain-material.js): open-sea colour and surf on the Black Sea side
  oceanGLSL: 'float ocean = smoothstep(-20800.0, -22800.0, vSfWorld.z);',
  // horizon ring beyond the terrain (src/world-sf/terrain-horizon.js): Black Sea north, Sea of Marmara south, land elsewhere
  horizonGLSL: 'hzOcean = max(smoothstep(-40000.0, -46000.0, p.y), smoothstep(8000.0, 14000.0, p.y) * smoothstep(70000.0, 62000.0, p.y) * smoothstep(-126000.0, -116000.0, p.x) * smoothstep(60000.0, 50000.0, p.x));',
};

const IST_TIPS = [
  'İstanbul Boğazı Karadeniz’i Marmara Denizi’ne bağlar; üç asma köprü Avrupa ile Asya’yı birleştirir.',
  '15 Temmuz Şehitler Köprüsü’nün tabliyesi denizden yaklaşık 64 metre yüksektedir.',
  'Galata Kulesi Haliç’in kuzey kıyısında yaklaşık 67 metre yükselir; alçak uçarken dikkat.',
  'Kız Kulesi, Üsküdar açıklarında küçük bir adacığın üzerinde durur.',
  'Yavuz Sultan Selim Köprüsü’nün kuleleri 320 metreyi aşar; Boğaz’ın Karadeniz ağzına yakındır.',
  'İstanbul Havalimanı şehrin kuzeyinde, Karadeniz kıyısına yakındır.',
  'Sabiha Gökçen Havalimanı Anadolu yakasında, Pendik’in kuzeyindedir.',
];
const SF_TIP = /Golden Gate|SFO|Alcatraz|Sutro|San Francisco/;

/** The flight is on İstanbul (once per page, before the world is built): the shared UI / avionics tables switch over. */
export function activate({ BRIDGES, TIPS, TOUCH_TIPS, TOWERS, setNavData }) {
  BRIDGES.splice(0, BRIDGES.length, ...MAP.bridges);
  for (const list of [TIPS, TOUCH_TIPS]) { const keep = list.filter((t) => !SF_TIP.test(t)); list.splice(0, list.length, ...keep); }
  TIPS.push(...IST_TIPS);
  for (const k of Object.keys(TOWERS)) delete TOWERS[k];   // (tower cameras: the airports layer's towers, else the fields)
  setNavData({
    origin: 'LTFM',
    landmarks: [
      { id: '15TMZ', name: '15 TEMMUZ KPR', x: 5007, z: -2325 }, { id: 'FSM', name: 'FSM KOPRUSU', x: 7142, z: -7470 },
      { id: 'YSS', name: 'YSS KOPRUSU', x: 11083, z: -19967 }, { id: 'GLT', name: 'GALATA', x: 0, z: 0 }, { id: 'KIZK', name: 'KIZ KULESI', x: 2526, z: 435 },
    ],
    steerpoints: [
      { n: 1, name: 'ATATURK', x: -12500, z: 6200, elev: 50 }, { n: 2, name: 'GALATA', x: 0, z: 0, elev: 35 },
      { n: 3, name: '15 TEMMUZ', x: 5007, z: -2325, elev: 64 }, { n: 4, name: 'YSS KOPRU', x: 11083, z: -19967, elev: 70 },
      { n: 5, name: 'IST HVL', x: -21000, z: -27800, elev: 99 }, { n: 6, name: 'SABIHA', x: 29000, z: 13800, elev: 95 },
    ],
    traffic: [
      { id: 'THY7', cx: -21000, cz: -18000, r: 9000, v: 125, alt: 1500, ph: 0.3, dir: 1, kind: 'airliner' },
      { id: 'PGT31', cx: 24000, cz: 16000, r: 6000, v: 110, alt: 900, ph: 2.1, dir: -1, kind: 'airliner' },
      { id: 'TCKAD', cx: 11000, cz: 16500, r: 1600, v: 50, alt: 450, ph: 4.0, dir: 1, kind: 'ga' },
      { id: 'EMN12', cx: 5500, cz: -3500, r: 900, v: 35, alt: 250, ph: 1.0, dir: -1, kind: 'heli' },
      { id: 'SOLOTR', cx: -8000, cz: -12000, r: 9000, v: 190, alt: 4600, ph: 5.2, dir: 1, kind: 'fighter' },
      { id: 'AJA24', cx: 0, cz: -10000, r: 14000, v: 150, alt: 3300, ph: 3.3, dir: -1, kind: 'airliner' },
      { id: 'BANDIT', cx: 20000, cz: -40000, r: 8000, v: 230, alt: 8500, ph: 0.8, dir: -1, kind: 'hostile' },
    ],
    ils: { LTFM: ['111.10', '110.10', '109.50', '108.70', '110.90', '111.50', '109.10', '108.30'], LTFJ: ['110.50', '109.90', '111.30', '108.90'], LTBA: ['109.30', '110.30'] },
  });
}

/** Loaded (menu or flight): the airport labels join src/ui/data.js AIRPORTS (the menu groups the start points by airport). */
export function register({ AIRPORTS, AIRPORT_ORDER }) {
  Object.assign(AIRPORTS, {
    LTFM: { code: 'IST', name: 'İstanbul Havalimanı', short: 'İstanbul' },
    LTFJ: { code: 'SAW', name: 'Sabiha Gökçen Havalimanı', short: 'Sabiha Gökçen' },
    LTBA: { code: 'ISL', name: 'Atatürk Havalimanı', short: 'Atatürk' },
  });
  for (const k of ['LTFM', 'LTFJ', 'LTBA']) if (!AIRPORT_ORDER.includes(k)) AIRPORT_ORDER.push(k);
}
