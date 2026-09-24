// Leaderboard: the game submits a finished run at once without a nickname, and the player may add one afterwards.
// The later submission (same or lower score) names the player's existing best entry; a better score still replaces it.
// Run: node tests/leaderboard-names.test.mjs   (in-memory store, no AWS, no network)
import { readFileSync } from 'node:fs';
import { createApp } from '../infra/leaderboard/lambda/app.mjs';
import { createMemoryDb } from '../infra/leaderboard/lambda/memdb.mjs';

const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }

const RULES = JSON.parse(readFileSync(new URL('../infra/leaderboard/lambda/rules.json', import.meta.url), 'utf8'));
let clock = Date.UTC(2026, 8, 24, 16, 0);
const db = createMemoryDb();
const app = createApp({ db, salt: 'x'.repeat(48), rules: RULES, stage: 'production', origins: ['https://fs.erenailab.com'], now: () => clock, limits: { post: 50, get: 50 } });
let ipN = 1;
function post(body) {
  clock += 61000;   // a fresh rate-limit minute per request
  return app({
    requestContext: { http: { method: 'POST' } }, rawPath: '/api/score',
    headers: { 'content-type': 'application/json', 'cloudfront-viewer-address': `198.51.100.${ipN++}:4444`, origin: 'https://fs.erenailab.com', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body), isBase64Encoded: false,
  });
}
const J = (r) => JSON.parse(r.body);
const A = 'PlayerKeyAAAAAAAAAAAAA', B = 'PlayerKeyBBBBBBBBBBBBB';
const run = { mission: 'gg-under', score: 2100, stars: 3, ac: 'f16', sec: 44.2, v: 'test' };

let r = await post({ ...run, sid: A });
check('automatic submission: anonymous entry, rank 1', r.statusCode === 200 && J(r).improved && J(r).rank === 1 && J(r).name === null && J(r).top[0].name === null, r.body);
r = await post({ ...run, sid: A, name: 'Çağrı' });
check('nickname afterwards (same run): names the entry', r.statusCode === 200 && !J(r).improved && J(r).name === 'Çağrı' && J(r).top[0].name === 'Çağrı' && J(r).best.score === 2100, r.body);
r = await post({ ...run, sid: B, score: 1800, stars: 2 });
check('another player below: rank 2, own row anonymous', J(r).rank === 2 && J(r).top[0].name === 'Çağrı' && J(r).top[1].name === null, r.body);
r = await post({ ...run, sid: A, score: 1500, stars: 1, name: 'Kaptan' });
check('lower score with a new nickname: best score kept, renamed', !J(r).improved && J(r).best.score === 2100 && J(r).name === 'Kaptan' && J(r).top[0].name === 'Kaptan', r.body);
r = await post({ ...run, sid: A, score: 2300, stars: 3 });
check('better score without a nickname: replaces the entry (anonymous until named again)', J(r).improved && J(r).best.score === 2300 && J(r).name === null, r.body);
r = await post({ ...run, sid: A, score: 2300, stars: 3, name: 'orospu' });
check('rejected nickname: entry stays anonymous', !J(r).improved && J(r).name === null && J(r).nameRejected === true, r.body);

let failed = 0;
const w = Math.max(...rows.map((x) => x.name.length));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
