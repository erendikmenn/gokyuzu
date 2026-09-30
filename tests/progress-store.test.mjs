// Progress stores with corrupted or wrong-shaped data (localStorage edited by hand, another tool, an old build): the
// missions' `gokyuzu.missions(.<map>)` (src/missions/catalog.js) and the free-flight challenges' `gokyuzu.ffc(.<map>)`
// (src/missions/challenges.js) start over instead of throwing. A string / number / array where an object was expected
// used to throw in recordResult() inside the mission's finish (the result card never came) or in recordChallenge().
// Run: node tests/progress-store.test.mjs (an in-memory localStorage).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; },
};
const { SF_CATALOG } = await import('../src/missions/catalog.js');
const { recordChallenge, loadChallengeProgress } = await import('../src/missions/challenges.js');

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });
const tryRun = (fn) => { try { return { v: fn() }; } catch (e) { return { err: e.message }; } };

const BAD_MISSIONS = [
  ['m a string', { v: 1, m: 'x', daily: {} }],
  ['m an array', { v: 1, m: [1, 2], daily: {} }],
  ['daily a string', { v: 1, m: {}, daily: 'x' }],
  ['an entry a number', { v: 1, m: { climb: 5 }, daily: {} }],
  ['a daily entry a string', { v: 1, m: {}, daily: { 20260927: 'x' } }],
  ['the whole store an array', [1, 2, 3]],
  ['not JSON', '{oops'],
];
for (const [what, val] of BAD_MISSIONS) {
  mem.clear();
  localStorage.setItem('gokyuzu.missions', typeof val === 'string' ? val : JSON.stringify(val));
  const r = tryRun(() => SF_CATALOG.recordResult('climb', { ok: true, score: 2400, stars: 3, day: '20260927' }));
  const p = tryRun(() => SF_CATALOG.loadProgress());
  const saved = p.v && p.v.missions.climb;
  check(`missions store, ${what}: the result is recorded, no throw`, !r.err && !p.err && saved && saved.best === 2400 && saved.stars === 3 && p.v.daily['20260927'], r.err || p.err || JSON.stringify(saved));
}
// a good store keeps its other entries
mem.clear();
localStorage.setItem('gokyuzu.missions', JSON.stringify({ v: 1, m: { 'gg-under': { stars: 2, best: 1800, runs: 3, done: true } }, daily: { 20260926: { id: 'climb', stars: 1, best: 1100 } } }));
SF_CATALOG.recordResult('climb', { ok: true, score: 2000, stars: 2 });
const kept = SF_CATALOG.loadProgress();
check('missions store: valid entries are kept', kept.missions['gg-under'].best === 1800 && kept.daily['20260926'].best === 1100 && kept.missions.climb.best === 2000);

const BAD_FFC = [
  ['e a string', { v: 1, e: 'x' }],
  ['e an array', { v: 1, e: [] }],
  ['an entry a number', { v: 1, e: { bridge: 7 } }],
  ['a daily entry null', { v: 1, e: { 'dland@20260927': null } }],
];
for (const [what, val] of BAD_FFC) {
  mem.clear();
  localStorage.setItem('gokyuzu.ffc', JSON.stringify(val));
  const r = tryRun(() => recordChallenge('bridge', { ok: true, score: 1500, stars: 2, ac: 'f16' }));
  const p = tryRun(() => loadChallengeProgress());
  check(`challenges store, ${what}: the result is recorded, no throw`, !r.err && !p.err && p.v.bridge && p.v.bridge.best === 1500, r.err || p.err || JSON.stringify(p.v));
}

let failed = 0;
console.log('\n=== progress stores (corrupted data) ' + '='.repeat(40));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(80)} ${x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
