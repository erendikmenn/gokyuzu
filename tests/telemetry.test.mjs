// Telemetry without identifiers (src/core/telemetry.js, CONTRACTS-SF.md §11): the visit record behind the retention
// fields of `open` (d0 = days since the first visit, vn = visit days, vd = first page of the day, vo = played before the
// record existed) and their buckets. Run: node tests/telemetry.test.mjs (no browser: the module sends nothing in Node).
const { updateVisits, bucketD0, bucketVn, localDay, rejectionSource, isForeignError } = await import('../src/core/telemetry.js');

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

// first visit
let r = updateVisits(null, '20260927');
check('first visit: day 0, visit 1, first page of the day, not a legacy player', r.d0 === 0 && r.vn === 1 && r.vd === 1 && r.vo === 0 && r.rec.f === '20260927', JSON.stringify(r));
check('the record holds only days and a count (no id)', Object.keys(r.rec).sort().join(',') === 'f,l,n', Object.keys(r.rec).join(','));
// a second page the same day
r = updateVisits(r.rec, '20260927');
check('second page the same day: not counted again (vd 0)', r.d0 === 0 && r.vn === 1 && r.vd === 0);
// next day
r = updateVisits(r.rec, '20260928');
check('next day: d0 1, second visit day, first page of that day', r.d0 === 1 && r.vn === 2 && r.vd === 1);
// a week later (month boundary)
r = updateVisits(r.rec, '20261004');
check('7 days after the first visit across a month boundary: d0 7, third visit day', r.d0 === 7 && r.vn === 3 && r.vd === 1, JSON.stringify(r));
// clock set back: nothing un-counted, no new day
const back = updateVisits(r.rec, '20261001');
check('clock set back: same record, not a new visit day', back.vn === 3 && back.vd === 0 && back.rec.l === '20261004');
// legacy player (other game data before the record existed)
const legacy = updateVisits(null, '20260927', true);
check('a browser that played before the record existed is marked vo=1 (kept out of the cohorts)', legacy.vo === 1 && legacy.rec.o === 1 && updateVisits(legacy.rec, '20260930').vo === 1);
// corrupt record → a fresh one
check('corrupt record starts over', updateVisits({ f: 'x', l: 3, n: -1 }, '20260927').vn === 1 && updateVisits('garbage', '20260927').d0 === 0);
// buckets
check('d0 buckets: exact to 14 days, then 15-29 / 30+', bucketD0(0) === '0' && bucketD0(7) === '7' && bucketD0(14) === '14' && bucketD0(15) === '15-29' && bucketD0(29) === '15-29' && bucketD0(30) === '30+');
check('vn buckets: exact to 7 days, then 8-14 / 15+', bucketVn(1) === '1' && bucketVn(7) === '7' && bucketVn(8) === '8-14' && bucketVn(14) === '8-14' && bucketVn(15) === '15+');
check('local day format YYYYMMDD', /^\d{8}$/.test(localDay()) && localDay(new Date(2026, 0, 5)) === '20260105');

// opt-outs: Do Not Track / Global Privacy Control always win, also against a ?telemetry=1 link; ?telemetry=1 only switches
// the statistics on where they are off by default (localhost). Each case loads the module fresh in a child process.
{
  const { execFileSync } = await import('node:child_process');
  const mod = new URL('../src/core/telemetry.js', import.meta.url).href;
  const beaconsFor = ({ host, search, dnt = null, gpc = false }) => Number(execFileSync(process.execPath, ['--input-type=module', '-e', `
    let n = 0;
    globalThis.location = { search: ${JSON.stringify(search)}, hostname: ${JSON.stringify(host)}, origin: 'https://' + ${JSON.stringify(host)}, pathname: '/' };
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'tr', doNotTrack: ${JSON.stringify(dnt)}, globalPrivacyControl: ${gpc}, userAgent: '' }, configurable: true });
    globalThis.document = { referrer: '', hidden: false }; globalThis.window = globalThis; globalThis.addEventListener = () => {};
    globalThis.innerWidth = 800; globalThis.innerHeight = 600; globalThis.devicePixelRatio = 1; globalThis.setInterval = () => 0;
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }; globalThis.sessionStorage = globalThis.localStorage;
    globalThis.fetch = () => { n++; return Promise.resolve({ ok: true }); };
    const T = await import(${JSON.stringify(mod)});
    try { T.startTelemetry({ build: { version: 't' }, renderer: null, quality: 'low', state: () => null }); } catch { /* the count is what matters */ }
    T.trackEvent('x', { a: 1 });
    console.log(n);`], { encoding: 'utf8' }).trim());
  const site = 'game.example';
  check('beacons: sent on the site by default (control)', beaconsFor({ host: site, search: '' }) > 0);
  check('beacons: none under Do Not Track, even with ?telemetry=1', beaconsFor({ host: site, search: '?telemetry=1', dnt: '1' }) === 0);
  check('beacons: none under Global Privacy Control, even with ?telemetry=1', beaconsFor({ host: site, search: '?telemetry=1', gpc: true }) === 0);
  check('beacons: none with ?telemetry=0; localhost only with ?telemetry=1', beaconsFor({ host: site, search: '?telemetry=0' }) === 0
    && beaconsFor({ host: 'localhost', search: '' }) === 0 && beaconsFor({ host: 'localhost', search: '?telemetry=1' }) > 0);
}

// unhandled rejections: the frame's whole URL, so the game's own rejections are not tagged foreign (they all were:
// only the file name was kept, which never starts with the origin; e.g. "signal is aborted without reason" at app-….js)
const O = 'https://fs.example.test';
const chrome = { message: 'signal is aborted without reason', stack: `AbortError: signal is aborted without reason\n    at t (${O}/app-KSEBZH7Y.js:805:17)\n    at ${O}/app-KSEBZH7Y.js:9:3` };
const chromeAnon = { stack: `Error: x\n    at ${O}/app-A.js:12:5` };
const safari = { stack: `pump@${O}/app-B.js:44:9\n@${O}/app-B.js:1:1` };
const ext = { stack: `TypeError: x\n    at chrome-extension://abcdef/200.js:1:99` };
const s1 = rejectionSource(chrome), s2 = rejectionSource(chromeAnon), s3 = rejectionSource(safari), s4 = rejectionSource(ext);
check('rejection source: Chrome frame "at f (url:l:c)" keeps the whole URL and the line', s1.file === `${O}/app-KSEBZH7Y.js` && s1.line === 805, JSON.stringify(s1));
check('rejection source: Chrome anonymous frame and Safari "f@url:l:c"', s2.file === `${O}/app-A.js` && s2.line === 12 && s3.file === `${O}/app-B.js` && s3.line === 44, JSON.stringify([s2, s3]));
check('rejection source: no stack / no frame / a string reason', rejectionSource(null).file === '' && rejectionSource({ stack: 'AbortError: x' }).file === '' && rejectionSource('boom').file === '');
check('own rejections are not foreign; extensions and other origins are', !isForeignError(chrome.message, s1.file, O) && !isForeignError('x', s3.file, O) && isForeignError('x', s4.file, O) && isForeignError('x', 'https://other.example/a.js', O));
check('"Script error." is foreign, an error without a file is not, the game\'s blob: workers are its own', isForeignError('Script error.', '', O) && !isForeignError('x', '', O) && !isForeignError('x', `blob:${O}/1234-abcd`, O));

let failed = 0;
console.log('\n=== telemetry (retention without identifiers) ' + '='.repeat(40));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(90)} ${x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
