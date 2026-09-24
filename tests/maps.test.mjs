// Maps (src/maps/index.js, CONTRACTS-IST.md §6 Engine): map choice, İstanbul start points, the geo frame per map,
// mission catalogs / challenge sets / progress per map, telemetry `mp` tag. Run: node tests/maps.test.mjs
// No framework: prints a PASS/FAIL table, exits 1 on failure.
import { readFileSync, existsSync } from 'node:fs';

// ---- browser stand-ins (localStorage, location, beacons) before the modules load ----
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { search: '?telemetry=1', hostname: 'localhost', origin: 'http://localhost', pathname: '/index.html' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'tr', doNotTrack: null }, configurable: true });
const beacons = [];
globalThis.fetch = (url) => { beacons.push(new URLSearchParams(String(url).split('?')[1])); return Promise.resolve({ ok: true }); };
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1440; globalThis.innerHeight = 900; globalThis.devicePixelRatio = 2;
globalThis.document = { referrer: '' };
globalThis.window = globalThis;

const M = await import('../src/maps/index.js');
const G = await import('../src/geo.js');
const IST = await import('../src/maps/ist.js');
const C = await import('../src/missions/catalog.js');
const CH = await import('../src/missions/challenges.js');
const T = await import('../src/core/telemetry.js');

const results = [];
const check = (name, ok, info = '') => results.push({ name, ok: !!ok, info });
const q = (s) => new URLSearchParams(s);

// ---- map choice ----
check('pickMap: default San Francisco', M.pickMap(q('')) === 'sf');
check('pickMap: ?map=ist', M.pickMap(q('map=ist')) === 'ist');
check('pickMap: unknown ?map falls back', M.pickMap(q('map=xyz')) === 'sf');
check('pickMap: mission id names its map', M.pickMap(q('mission=ist-bogaz')) === 'ist' && M.pickMap(q('mission=gg-under')) === 'sf');
check('pickMap: direct link spawn names its map', M.pickMap(q('aircraft=f16&spawn=LTFM-35L')) === 'ist' && M.pickMap(q('aircraft=f16&spawn=IST-AIR-BOGAZ')) === 'ist'
  && M.pickMap(q('aircraft=f16&spawn=AIR-GGB')) === 'sf' && M.pickMap(q('aircraft=f16')) === 'sf');
check('pickMap: resumed flight keeps its map', M.pickMap(q('resume=1'), { aircraft: 'f16', map: 'ist' }) === 'ist' && M.pickMap(q('resume=1'), { aircraft: 'f16' }) === 'sf');
M.rememberMap('ist');
check('pickMap: the menu remembers the last choice', M.pickMap(q('')) === 'ist' && M.pickMap(q('aircraft=f16&spawn=KSFO-28R')) === 'sf', store.get('gokyuzu.map'));
M.rememberMap('sf');
check('mapOfId', M.mapOfId('LTFJ-06L') === 'ist' && M.mapOfId('ist-x') === 'ist' && M.mapOfId('KSFO-28R') === 'sf' && M.mapOfId(null) === 'sf');
check('registry: paths per map', M.MAPS.sf.assets === 'assets/sf/' && M.MAPS.ist.assets === 'assets/ist/' && M.MAPS.ist.data === 'data/ist/' && M.MAPS.sf.fogBank && !M.MAPS.ist.fogBank);

// ---- İstanbul start points ----
const REG = JSON.parse(readFileSync(new URL('../data/ist/region.json', import.meta.url), 'utf8'));
const inside = (s) => s.x > REG.local.minX && s.x < REG.local.maxX && s.z > REG.local.minZ && s.z < REG.local.maxZ;
const empty = IST.buildSpawns({ airports: [] });
check('ist spawns without runways.json: airborne ones only', empty.length === 6 && empty.every((s) => s.altitude > 0 && s.airborne && inside(s)), empty.map((s) => s.id).join(' '));
check('ist spawn ids are İstanbul ids', empty.every((s) => M.mapOfId(s.id) === 'ist'));
const hover = empty.find((s) => s.id === 'IST-HOVER-GALATA');
check('helicopter hover start near Galata', hover && hover.hover && Math.hypot(hover.x, hover.z) < 1000);
const RW_PATH = new URL('../data/ist/runways.json', import.meta.url);
if (existsSync(RW_PATH)) {
  const rw = JSON.parse(readFileSync(RW_PATH, 'utf8'));
  const sp = IST.buildSpawns(rw);
  const ids = sp.map((s) => s.id);
  check('ist runway starts from runways.json', ['LTFM-35L', 'LTFM-34L', 'LTFJ-06L', 'LTBA-05'].every((id) => ids.includes(id)), ids.join(' '));
  let worst = 0;
  for (const s of sp.filter((x) => x.airport)) {
    const [icao, ident] = s.id.split('-');
    const e = rw.airports.find((a) => a.icao === icao).runways.flatMap((r) => r.ends).find((x) => x.ident === ident);
    worst = Math.max(worst, Math.abs(Math.hypot(s.x - e.x, s.z - e.z) - 45), Math.abs(s.heading - e.headingTrue * Math.PI / 180));
  }
  check('runway starts 45 m past the threshold, runway heading', worst < 1e-6, worst);
  const fin = sp.find((s) => s.id === 'IST-AIR-LTFM-FINAL');
  const r35 = rw.airports.find((a) => a.icao === 'LTFM').runways.find((r) => r.ends.some((x) => x.ident === '35L')), e = r35.ends.find((x) => x.ident === '35L');
  const elev = e.elevation ?? r35.elevation;
  const d = Math.hypot(fin.x - e.x, fin.z - e.z), along = ((e.x - fin.x) * Math.sin(fin.heading) - (e.z - fin.z) * Math.cos(fin.heading));
  check('LTFM final: 9 km out on the centre line, 3° path', Math.abs(d - 9000) < 1 && Math.abs(along - 9000) < 1 && Math.abs(fin.altitude - (elev + 9000 * Math.tan(3 * Math.PI / 180))) < 1 && fin.final, `${d.toFixed(1)} m, ${fin.altitude} m`);
  check('every ist spawn inside the map', sp.every(inside));
  check('default spawns exist when the runways do', Object.values(IST.MAP.defaultSpawns).every((id) => ids.includes(id)));
} else check('ist runway starts (data/ist/runways.json not built: skipped)', true);

// ---- geo frame ----
const sfA = G.lonLatToLocal(-122.4194, 37.7749), sfB = G.localToLonLat(-9250, -22240);
check('geo: San Francisco unchanged', Math.abs(sfA.x - -4043.2074128918957) < 1e-9 && Math.abs(sfA.z - -17272.865672213367) < 1e-9 && Math.abs(sfB.lon - -122.47802450754085) < 1e-12);
G.setGeoRegion(REG, IST.utm);
// pyproj (tools/geo/geo.py, GEO_REGION=ist) reference points: corners of the bbox, LTFM, Kız Kulesi, the origin
const REF = [[28.62, 40.82, -29353.786733384128, 23432.911599789746], [29.4, 41.37, 34747.314679992734, -39139.88467329461],
  [28.7274, 41.2627, -21269.391355783795, -25887.468759883195], [29.3, 40.9, 27762.17393022566, 13268.384386472404], [29.0042, 41.0211, 2536.421706092544, 437.1369306445122]];
let geoErr = 0;
for (const [lon, lat, x, z] of REF) {
  const p = G.lonLatToLocal(lon, lat), b = G.localToLonLat(x, z);
  geoErr = Math.max(geoErr, Math.abs(p.x - x), Math.abs(p.z - z), Math.abs(b.lon - lon) * 84000, Math.abs(b.lat - lat) * 111000);
}
check('geo: İstanbul UTM 35N matches pyproj (< 1 cm)', geoErr < 0.01, `${geoErr.toFixed(4)} m`);
check('geo: REGION bounds follow the map', G.REGION.bounds.minX === REG.local.minX && G.REGION.bounds.maxZ === REG.local.maxZ);

// ---- missions per map ----
check('SF daily mission unchanged', C.dailyMissionId('20260924') === 'autorotation' && C.dailyMission('20260101').id === C.dailyMissionId('20260101'));
C.recordResult('gg-under', { ok: true, score: 1500, stars: 2 });
check('SF progress in gokyuzu.missions', JSON.parse(store.get('gokyuzu.missions')).m['gg-under'].best === 1500);
const fake = C.createCatalog({ missions: [{ id: 'ist-a', params: {}, build: () => ({ start: {}, objectives: [], stars: [1, 2, 3] }), title: 'A' }, { id: 'ist-b', unlock: 2, params: {}, build: () => ({}), title: 'B' }], store: 'gokyuzu.missions.ist', seed: 'ist-', map: 'ist' });
fake.recordResult('ist-a', { ok: true, score: 900, stars: 3 });
check('another map: its own progress key, SF untouched', fake.loadProgress().missions['ist-a'].stars === 3 && !C.loadProgress().missions['ist-a'] && fake.totalStars() === 3 && fake.isUnlocked(fake.MISSIONS[1]));
check('another map: daily mission from its own list', ['ist-a', 'ist-b'].includes(fake.dailyMissionId('20260924')));
const istCat = await C.loadMissionCatalog('ist');
if (existsSync(new URL('../src/missions/ist/catalog.js', import.meta.url))) {
  check('İstanbul catalog loads (ist- ids, its BRIDGES)', istCat && istCat.MISSIONS.length > 0 && istCat.MISSIONS.every((m) => m.id.startsWith('ist-')) && Object.keys(istCat.BRIDGES).length > 0, istCat && istCat.MISSIONS.length);
  const dm = istCat.dailyMission('20260924');
  check('İstanbul daily mission builds', dm && dm.id.startsWith('ist-') && dm.day === '20260924');
} else check('no İstanbul catalog yet: none', istCat === null);
check('unknown map: no catalog', (await C.loadMissionCatalog('xx')) === null);
const sfSet = await CH.loadChallengeSet('sf');
check('SF challenge set: boards ff-<id>', sfSet.challenges.length === CH.CHALLENGES.length && sfSet.challenges.every((c) => c.board === `ff-${c.id}`));
CH.recordChallenge('bridge', { ok: true, score: 1200, stars: 2, ac: 'f16' }, 'ist');
check('challenge progress per map', CH.loadChallengeProgress('ist').bridge.best === 1200 && !CH.loadChallengeProgress().bridge);
const istSet = await CH.loadChallengeSet('ist');
if (istSet) check('İstanbul challenge boards ff-ist-*', istSet.challenges.every((c) => /^ff-ist-/.test(c.board)), istSet.challenges.map((c) => c.board).join(' '));
else check('no İstanbul challenges yet: no set (no panel)', !existsSync(new URL('../src/missions/ist/challenges.js', import.meta.url)));

// ---- telemetry tag ----
T.setTelemetryMap('sf');
T.trackEvent('mission', { id: 'gg-under', st: 'start' });
T.setTelemetryMap('ist');
T.trackEvent('mission', { id: 'ist-bogaz', st: 'start' });
T.trackEvent('ffc', { id: 'ist-x', st: 'done' });
T.trackEvent('land', { fpm: 120 });
T.trackFlight('f16', 'IST-AIR-BOGAZ', 3.2, 'high');
const byT = (t) => beacons.filter((b) => b.get('t') === t);
check('telemetry: San Francisco events carry no mp', byT('mission')[0].get('mp') === null);
check('telemetry: İstanbul mission / ffc / fly carry mp=ist', byT('mission')[1].get('mp') === 'ist' && byT('ffc')[0].get('mp') === 'ist' && byT('fly')[0].get('mp') === 'ist');
check('telemetry: other events untagged', byT('land')[0].get('mp') === null);
check('telemetry: envelope keys intact', byT('fly')[0].get('t') === 'fly' && /^\d+$/.test(byT('fly')[0].get('n')));

let fail = 0;
for (const r of results) { if (!r.ok) fail++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.info !== '' ? `  (${r.info})` : ''}`); }
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
