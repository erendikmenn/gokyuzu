// Telemetry without identifiers (src/core/telemetry.js, CONTRACTS-SF.md §11): the visit record behind the retention
// fields of `open` (d0 = days since the first visit, vn = visit days, vd = first page of the day, vo = played before the
// record existed) and their buckets. Run: node tests/telemetry.test.mjs (no browser: the module sends nothing in Node).
const { updateVisits, bucketD0, bucketVn, localDay } = await import('../src/core/telemetry.js');

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

let failed = 0;
console.log('\n=== telemetry (retention without identifiers) ' + '='.repeat(40));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(90)} ${x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
