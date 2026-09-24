// Leaderboard tests: nickname filter, viewer address / rate-limit buckets, payload validation and plausibility, the
// request handler end to end on the in-memory store (infra/leaderboard/lambda), and the browser client with a fake fetch.
// Run: node tests/leaderboard.test.mjs   (no AWS, no network; prints a PASS/FAIL table, exits 1 on failure)
import { createHash } from 'node:crypto';
import { cleanName, NAME_MAX } from '../src/net/names.js';
import { viewerIp, ipBucket, isCloudflare } from '../infra/leaderboard/lambda/net.mjs';
import { checkScore, checkTop, dayMs, utcDay, rankKey, boardKey, missionRule } from '../infra/leaderboard/lambda/validate.mjs';
import { createApp } from '../infra/leaderboard/lambda/app.mjs';
import { createMemoryDb } from '../infra/leaderboard/lambda/memdb.mjs';

const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }

// ---- nickname filter ------------------------------------------------------------------------------------------------
const GOOD = ['Çağrı Pilot', 'İpek_34', 'ÖĞÜŞÇİ', 'Şükrü', 'Işık', 'Nazif', 'Kemal', 'Resmiye', 'Ahmet Kayarak', 'Pilot 1903',
  'Top Gun', 'Kanka-42', 'Hancock', 'Mehmet Efe', 'Işıktır', 'José', 'a'.repeat(NAME_MAX)];
const BAD = {
  bad: ['orospu çocuğu', 'O R O S P U', '0r0spu', 'orrrrospu', 'a m k', 'AMK', 'amk_ase', 'siktir git', 'SİKTİR', 'fuck', 'f u c k',
    'Piç Kurusu', 'sexy pilot', 'y4rr4k', 'pezevenk', 'Hitler'],
  link: ['www site com', 'site com', 'discord gg', 'instagram pilot', 'benim_insta', 'https'],
  chars: ['gokyuzu.com', '<script>', 'a@b', 'x/y', 'Пилот', '飞行员', '😀', '__'],
  reserved: ['Admin', 'admin_1', 'Moderatör', 'Gökyüzü', 'Resmi', 'sistem'],
  digits: ['05321234567', 'TC 12345678901'],
  long: ['a'.repeat(NAME_MAX + 1)],
};
for (const n of GOOD) { const r = cleanName(n); check(`name ok: ${n}`, r.ok && r.name, JSON.stringify(r)); }
for (const [reason, list] of Object.entries(BAD)) {
  for (const n of list) { const r = cleanName(n); check(`name rejected (${reason}): ${n}`, !r.ok && r.reason === reason && r.name === null, JSON.stringify(r)); }
}
check('name: empty / spaces / missing → anonymous', [undefined, null, '', '   '].every((n) => { const r = cleanName(n); return r.ok && r.name === null; }));
check('name: not a string rejected', !cleanName(42).ok && !cleanName({}).ok);
check('name: normalized (NFKC, spaces, zero-width)', cleanName('  Ali   Veli ').name === 'Ali Veli' && cleanName('ＡＢＣ').name === 'ABC'
  && cleanName(`Ali${String.fromCharCode(0x200b)}Veli`).name === 'AliVeli');

// ---- viewer address -----------------------------------------------------------------------------------------------
check('ip: CloudFront viewer v4', viewerIp({ 'cloudfront-viewer-address': '203.0.113.9:51234' }) === '203.0.113.9');
check('ip: CloudFront viewer v6', viewerIp({ 'cloudfront-viewer-address': '2001:db8:e0:2::7:443' }) === '2001:db8:e0:2::7');
check('ip: CF-Connecting-IP trusted from Cloudflare', viewerIp({ 'cloudfront-viewer-address': '172.70.1.2:443', 'cf-connecting-ip': '198.51.100.23' }) === '198.51.100.23');
check('ip: CF-Connecting-IP trusted from Cloudflare v6', viewerIp({ 'cloudfront-viewer-address': '2a06:98c1:3120::3:443', 'cf-connecting-ip': '198.51.100.23' }) === '198.51.100.23');
check('ip: CF-Connecting-IP ignored from others (spoofing)', viewerIp({ 'cloudfront-viewer-address': '203.0.113.9:1', 'cf-connecting-ip': '1.1.1.1' }) === '203.0.113.9');
check('ip: garbage CF-Connecting-IP ignored', viewerIp({ 'cloudfront-viewer-address': '172.70.1.2:443', 'cf-connecting-ip': 'x' }) === '172.70.1.2');
check('ip: Cloudflare ranges', isCloudflare('104.16.0.1') && isCloudflare('162.159.255.255') && !isCloudflare('104.32.0.1') && !isCloudflare('8.8.8.8')
  && isCloudflare('2606:4700::1') && !isCloudflare('2607:4700::1'));
check('ip: v6 bucket is the /64', ipBucket('2001:db8:e0:2::7') === '2a02:e0:1:2::/64' && ipBucket('2a02:e0:1:2:ffff::1') === '2a02:e0:1:2::/64');
check('ip: v4 bucket is the address, missing → unknown', ipBucket('203.0.113.9') === '203.0.113.9' && ipBucket('') === 'unknown');

// ---- validation ---------------------------------------------------------------------------------------------------
const NOW = Date.UTC(2026, 8, 24, 10, 30);   // 2026-09-24 10:30 UTC
const RULES = {
  strict: true, aircraft: ['f16', 'f22', 'a320neo', 'b737', 'uh60'],
  default: { scoreMin: 0, scoreMax: 10000, secMin: 5, secMax: 3600 },
  missions: {
    'ggb-ring': { scoreMax: 5000, secMin: 20, aircraft: ['f16', 'f22'], stars: [1000, 2500, 4000] },
    'time-trial': { lower: true, scoreMin: 30, scoreMax: 900 },
    'free-land': { daily: false },
  },
  test: ['selftest'],
};
const ctx = { rules: RULES, stage: 'staging', now: NOW };
const SID = 'AbCdEfGhIjKlMnOpQrSt12';
const good = { mission: 'ggb-ring', score: 4200, stars: 3, ac: 'f16', sid: SID, v: '20260924-1', sec: 61.24 };
const v = checkScore(good, ctx);
check('score: valid payload', v.ok && v.value.score === 4200 && v.value.sec === 61.2 && v.value.day === null && v.value.name === null, JSON.stringify(v));
const bad = (patch, field) => { const r = checkScore({ ...good, ...patch }, ctx); check(`score rejected: ${JSON.stringify(patch)}`, !r.ok && r.error === field, JSON.stringify(r)); };
bad({ mission: 'unknown-mission' }, 'mission');
bad({ mission: 'GGB Ring' }, 'mission');
bad({ mission: 'x'.repeat(41) }, 'mission');
bad({ score: -1 }, 'score');
bad({ score: 5001 }, 'score');
bad({ score: '4200' }, 'score');
bad({ score: NaN }, 'score');
bad({ score: Infinity }, 'score');
bad({ stars: 4 }, 'stars');
bad({ stars: 1.5 }, 'stars');
bad({ stars: 3, score: 3000 }, 'stars');           // 3000 earns only 2 stars
bad({ ac: 'b737' }, 'ac');                           // not allowed on this mission
bad({ ac: 'cessna' }, 'ac');
bad({ sec: 3 }, 'sec');                              // faster than the mission allows
bad({ sec: 99999 }, 'sec');
bad({ sec: '61' }, 'sec');
bad({ sid: 'short' }, 'sid');
bad({ sid: 'x'.repeat(65) }, 'sid');
bad({ sid: 'has spaces in the key!!' }, 'sid');
bad({ v: '<script>' }, 'v');
bad({ day: '20260926' }, 'day');                     // two days ahead
bad({ day: '20260922' }, 'day');                     // two days back
bad({ day: '20260230' }, 'day');                     // not a date
bad({ day: 'today' }, 'day');
check('score rejected: not an object', !checkScore([], ctx).ok && !checkScore(null, ctx).ok && !checkScore('x', ctx).ok);
for (const d of ['20260923', '20260924', '20260925']) check(`score: daily ${d} accepted`, checkScore({ ...good, day: d }, ctx).ok);
check('score: daily refused for a mission without daily boards', checkScore({ ...good, mission: 'free-land', ac: 'b737', stars: 0, score: 10, day: '20260924' }, ctx).error === 'day');
check('score: selftest mission only outside production', checkScore({ ...good, mission: 'selftest', stars: 0, score: 1 }, ctx).ok
  && checkScore({ ...good, mission: 'selftest', stars: 0, score: 1 }, { ...ctx, stage: 'production' }).error === 'mission');
check('score: loose rules accept unknown ids with default ranges', checkScore({ ...good, mission: 'new-one', stars: 1 }, { ...ctx, rules: { ...RULES, strict: false } }).ok
  && checkScore({ ...good, mission: 'new-one', score: 10001 }, { ...ctx, rules: { ...RULES, strict: false } }).error === 'score');
check('score: bad name → accepted anonymously', (() => { const r = checkScore({ ...good, name: 'a m k' }, ctx); return r.ok && r.value.name === null && r.value.nameRejected; })());
check('score: good name kept', checkScore({ ...good, name: ' Çağrı ' }, ctx).value.name === 'Çağrı');
check('dayMs / utcDay', utcDay(NOW) === '20260924' && Number.isNaN(dayMs('20261301')) && dayMs('20260924') === Date.UTC(2026, 8, 24));
check('top: valid', (() => { const r = checkTop({ mission: 'ggb-ring', day: '20260901', n: '20' }, ctx); return r.ok && r.value.n === 20 && r.value.day === '20260901'; })());
check('top: default n = 10', checkTop({ mission: 'ggb-ring' }, ctx).value.n === 10);
check('top: n outside 10/20/50 rejected', checkTop({ mission: 'ggb-ring', n: '7' }, ctx).error === 'n' && checkTop({ mission: 'ggb-ring', n: '1000' }, ctx).error === 'n');
check('top: day older than 31 days rejected', checkTop({ mission: 'ggb-ring', day: '20260820' }, ctx).error === 'day' && checkTop({ mission: 'ggb-ring', day: '20260824' }, ctx).ok);
check('top: unknown mission rejected (strict)', checkTop({ mission: 'nope' }, ctx).error === 'mission');
check('rank key: higher score first, then earlier', rankKey(500, 1000, false) > rankKey(499, 900, false) && rankKey(500, 900, false) > rankKey(500, 1000, false));
check('rank key: lower-is-better inverted', rankKey(40, 1000, true) > rankKey(41, 900, true));
check('rule: defaults merged', missionRule(RULES, 'ggb-ring', 'staging').secMax === 3600 && missionRule(RULES, 'ggb-ring', 'staging').scoreMax === 5000);
check('board keys', boardKey('m', null) === 'b#m' && boardKey('m', '20260924') === 'b#m#20260924');

// ---- the shipped rules (infra/leaderboard/lambda/rules.json, built from src/missions/catalog.js) --------------------
const { readFileSync } = await import('node:fs');
const SHIPPED = JSON.parse(readFileSync(new URL('../infra/leaderboard/lambda/rules.json', import.meta.url), 'utf8'));
const sctx = { rules: SHIPPED, stage: 'production', now: NOW };
const ids = Object.keys(SHIPPED.missions);
check('shipped rules: strict, built from the catalog', SHIPPED.strict === true && ids.length >= 5, `${ids.length} missions`);
let catalogOk = true;
try {
  const { MISSIONS } = await import('../src/missions/catalog.js');
  catalogOk = MISSIONS.every((m) => SHIPPED.missions[m.id] && SHIPPED.missions[m.id].aircraft.includes(m.aircraft));
} catch { /* catalog not present: nothing to compare */ }
check('shipped rules: every catalog mission present with its aircraft (rerun build_rules.mjs if not)', catalogOk);
for (const id of ids) {
  const r = SHIPPED.missions[id];
  const three = Array.isArray(r.stars) ? r.stars[2] : Math.min(r.scoreMax, 1500);
  const p = { mission: id, score: three, stars: 3, ac: r.aircraft[0], sid: SID, sec: Math.max(r.secMin, 30) };
  check(`shipped rules ${id}: a 3-star run accepted (also as daily)`, checkScore(p, sctx).ok && checkScore({ ...p, day: '20260924' }, sctx).ok, JSON.stringify(checkScore(p, sctx)));
  check(`shipped rules ${id}: impossible score / aircraft / 0 stars refused`, checkScore({ ...p, score: r.scoreMax + 1 }, sctx).error === 'score'
    && (r.aircraft.length === SHIPPED.aircraft.length || checkScore({ ...p, ac: SHIPPED.aircraft.find((a) => !r.aircraft.includes(a)) }, sctx).error === 'ac')
    && checkScore({ ...p, stars: 0 }, sctx).error === 'stars');
}
check('shipped rules: selftest refused in production, unknown ids refused', checkScore({ ...good, mission: 'selftest' }, sctx).error === 'mission'
  && checkScore({ ...good, mission: 'made-up' }, sctx).error === 'mission');

// ---- handler on the in-memory store ------------------------------------------------------------------------------
const SALT = 'x'.repeat(48);
let clock = NOW;
const db = createMemoryDb();
const app = createApp({ db, salt: SALT, rules: RULES, stage: 'staging', origins: ['https://staging.fs.erenailab.com'], now: () => clock, limits: { post: 5, get: 8 } });
const IP = '203.0.113.77';
function post(body, { ip = IP, headers = {}, raw } = {}) {
  return app({
    requestContext: { http: { method: 'POST' } }, rawPath: '/api/score',
    headers: { 'content-type': 'application/json', 'cloudfront-viewer-address': `${ip}:4444`, origin: 'https://staging.fs.erenailab.com', 'sec-fetch-site': 'same-origin', ...headers },
    body: raw !== undefined ? raw : JSON.stringify(body), isBase64Encoded: false,
  });
}
function get(query, { ip = IP, method = 'GET', path = '/api/top' } = {}) {
  return app({ requestContext: { http: { method } }, rawPath: path, headers: { 'cloudfront-viewer-address': `${ip}:1` }, queryStringParameters: query });
}
const J = (r) => JSON.parse(r.body);

let r = await post({ ...good, score: 3000, stars: 2, name: 'Çağrı' });
check('POST: first score stored', r.statusCode === 200 && J(r).improved && J(r).rank === 1 && J(r).name === 'Çağrı' && J(r).top.length === 1, r.body);
check('POST: no-store', r.headers['cache-control'] === 'no-store');
clock += 1000;
r = await post({ ...good, score: 2000, stars: 1, name: 'Çağrı' });
check('POST: worse score keeps the best', r.statusCode === 200 && !J(r).improved && J(r).best.score === 3000 && J(r).rank === 1, r.body);
clock += 1000;
r = await post({ ...good, score: 4500, stars: 3, name: 'Çağrı' });
check('POST: better score replaces', J(r).improved && J(r).best.score === 4500 && J(r).best.stars === 3, r.body);
clock += 61000;   // next minute: fresh rate-limit bucket
r = await post({ ...good, sid: 'OtherPlayerKey_000001', score: 4500, stars: 3 }, { ip: '198.51.100.1' });
check('POST: tie → the earlier entry ranks first', J(r).rank === 2 && J(r).top[0].name === 'Çağrı' && J(r).top[1].name === null, r.body);
r = await post({ ...good, sid: 'ThirdPlayerKey_000001', score: 4999, stars: 3, name: 'a m k' }, { ip: '198.51.100.2' });
check('POST: offensive name dropped, score kept anonymous', r.statusCode === 200 && J(r).nameRejected && J(r).name === null && J(r).rank === 1, r.body);
r = await get({ mission: 'ggb-ring', n: '10' });
check('GET top: order and fields', r.statusCode === 200 && J(r).entries.map((e) => e.score).join() === '4999,4500,4500' && J(r).entries[0].rank === 1
  && 'ac' in J(r).entries[0] && 'stars' in J(r).entries[0] && !('sk' in J(r).entries[0]) && !('rk' in J(r).entries[0]), r.body);
check('GET top: edge-cacheable', /s-maxage=30/.test(r.headers['cache-control']));
r = await post({ ...good, sid: 'DailyPlayerKey_000001', day: '20260924', score: 1200, stars: 1 }, { ip: '198.51.100.3' });
check('POST daily: separate board', J(r).rank === 1 && J(r).top.length === 1, r.body);
const daily = [...db.items.values()].find((it) => it.pk === 'b#ggb-ring#20260924');
check('POST daily: expires 31 days after its day', daily && daily.exp === Date.UTC(2026, 8, 24) / 1000 + 31 * 86400);
check('POST: all-time entries do not expire', [...db.items.values()].filter((it) => it.pk === 'b#ggb-ring').every((it) => it.exp === undefined));
r = await post({ mission: 'selftest', score: 5, stars: 0, ac: 'uh60', sid: 'SelftestPlayer_000001' }, { ip: '198.51.100.4' });
check('POST selftest: expires after a day', r.statusCode === 200 && [...db.items.values()].find((it) => it.pk === 'b#selftest').exp === Math.floor(clock / 1000) + 86400);
r = await get({ mission: 'ggb-ring', day: '20260924' });
check('GET top daily', J(r).entries.length === 1 && J(r).day === '20260924');

// bad requests
const status = async (p, expect, label) => { const x = await p; check(label, x.statusCode === expect, `${x.statusCode} ${x.body}`); return x; };
await status(post(null, { raw: '{"mission":' }), 400, 'POST: malformed JSON → 400');
await status(post({ ...good, stars: 9 }), 400, 'POST: invalid field → 400');
await status(post(null, { raw: JSON.stringify({ ...good, pad: 'x'.repeat(1100) }) }), 413, 'POST: body > 1 KB → 413');
await status(post(good, { headers: { 'content-type': 'text/plain' } }), 415, 'POST: text/plain (cross-site simple request) → 415');
await status(post(good, { headers: { origin: 'https://evil.example' } }), 403, 'POST: foreign Origin → 403');
await status(post(good, { headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'POST: cross-site fetch → 403');
await status(get({ mission: 'ggb-ring' }, { method: 'POST' }), 405, 'POST /api/top → 405');
await status(get({}, { path: '/api/score' }), 405, 'GET /api/score → 405');
await status(get({}, { path: '/api/other' }), 404, 'unknown path → 404');
await status(get({ mission: 'ggb-ring', n: '7' }), 400, 'GET top: bad n → 400');

// rate limits (POST: store counter per salted address+minute; GET: per container)
clock += 60000;
const burst = [];
for (let i = 0; i < 8; i++) burst.push((await post({ ...good, sid: `BurstPlayerKey_${String(i).padStart(6, '0')}`, score: 100 + i, stars: 0 }, { ip: '192.0.2.50' })).statusCode);
check('rate limit: POST burst → 429 after 5/min', burst.slice(0, 5).every((s) => s === 200) && burst.slice(5).every((s) => s === 429), burst.join());
const other = await post({ ...good, sid: 'OtherAddressKey_00001', score: 50, stars: 0 }, { ip: '192.0.2.51' });
check('rate limit: other address unaffected', other.statusCode === 200);
const v6a = await post({ ...good, sid: 'V6PlayerKey_000000001', score: 51, stars: 0 }, { ip: '2001:db8:1:2::1' });
check('rate limit: 429 carries Retry-After', (await post(good, { ip: '192.0.2.50' })).headers['retry-after'] > 0 && v6a.statusCode === 200);
for (let i = 0; i < 4; i++) await post({ ...good, sid: `V6PlayerKey_00000000${i + 2}`, score: 52 + i, stars: 0 }, { ip: `2001:db8:1:2::${i + 2}` });
check('rate limit: IPv6 counted per /64', (await post({ ...good, sid: 'V6PlayerKey_000000009', score: 60, stars: 0 }, { ip: '2001:db8:1:2:aaaa::9' })).statusCode === 429);
clock += 60000;
check('rate limit: next minute allowed again', (await post({ ...good, sid: 'BurstPlayerKey_000099', score: 99, stars: 0 }, { ip: '192.0.2.50' })).statusCode === 200);
const gets = [];
for (let i = 0; i < 10; i++) gets.push((await get({ mission: 'ggb-ring' }, { ip: '192.0.2.60' })).statusCode);
check('rate limit: GET burst → 429 after 8/min', gets.slice(0, 8).every((s) => s === 200) && gets.slice(8).every((s) => s === 429), gets.join());

// privacy: nothing identifying in the store
const dump = JSON.stringify([...db.items.values()]);
check('privacy: no address stored', !/203\.0\.113|198\.51\.100|192\.0\.2|2001:db8/.test(dump));
check('privacy: player keys stored only hashed', !dump.includes(SID) && !dump.includes('OtherPlayerKey'));
check('privacy: rate-limit keys are 20-bit buckets that differ per minute', (() => {
  const keys = [...db.items.values()].filter((it) => it.pk.startsWith('rl#')).map((it) => it.pk);
  return new Set(keys).size === keys.length && keys.length >= 4 && keys.every((k) => /^rl#\d+#[0-9a-f]{5}$/.test(k));
})());
const failing = createApp({ db: { ...db, putBest: async () => { throw Object.assign(new Error('boom 203.0.113.77'), { name: 'ProvisionedThroughputExceededException' }); } }, salt: SALT, rules: RULES, now: () => clock });
const logs = [];
const origError = console.error;
console.error = (...a) => logs.push(a.join(' '));
const fr = await failing({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/score', headers: { 'content-type': 'application/json', 'cloudfront-viewer-address': '203.0.113.77:1' }, body: JSON.stringify(good) });
console.error = origError;
check('store failure → 503, log without request data', fr.statusCode === 503 && logs.length === 1 && !logs[0].includes('203.0.113') && !logs[0].includes(SID), logs.join('|'));
let threw = false;
try { createApp({ db, salt: 'short', rules: RULES }); } catch { threw = true; }
check('app refuses a missing/short salt', threw);

// ---- browser client (fake fetch, localStorage) --------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, val) => store.set(k, String(val)), removeItem: (k) => store.delete(k) };
const calls = [];
let respond = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('/api/')) return new Response('{}', { status: 404 });   // build.json in Node
  calls.push({ url: u, init });
  return respond(u, init);
};
const client = await import('../src/net/leaderboard.js');
// route the fake fetch into the real handler: the whole POST → store → response path
respond = async (url, init) => {
  const u = new URL(url, 'https://staging.fs.erenailab.com');
  const ev = {
    requestContext: { http: { method: init.method || 'GET' } }, rawPath: u.pathname,
    headers: { ...Object.fromEntries(Object.entries(init.headers || {}).map(([k, x]) => [k.toLowerCase(), x])), 'cloudfront-viewer-address': '203.0.113.200:1' },
    queryStringParameters: Object.fromEntries(u.searchParams), body: init.body, isBase64Encoded: false,
  };
  const res = await app(ev);
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
};
clock += 60000;
const sub = await client.submitScore({ mission: 'ggb-ring', score: 4100.4, stars: 3, ac: 'f22', name: 'Deniz', sec: 70.26 });
check('client: submit → result', sub && sub.improved && sub.best.score === 4100 && sub.rank >= 1 && Array.isArray(sub.top), JSON.stringify(sub));
const sent = calls[calls.length - 1];
check('client: POST /api/score with JSON and the body SHA-256 (CloudFront OAC)', sent.url === '/api/score' && sent.init.method === 'POST'
  && sent.init.headers['content-type'] === 'application/json'
  && sent.init.headers['x-amz-content-sha256'] === createHash('sha256').update(sent.init.body).digest('hex'));
const key1 = JSON.parse(sent.init.body).sid;
await client.submitScore({ mission: 'ggb-ring', score: 10, stars: 0, ac: 'f22' });
check('client: player key persists in localStorage', key1 === store.get('gokyuzu.player') && JSON.parse(calls[calls.length - 1].init.body).sid === key1 && /^[A-Za-z0-9_-]{22}$/.test(key1));
check('client: accepted name remembered', client.savedName() === 'Deniz');
const tp = await client.topScores({ mission: 'ggb-ring', n: 15 });
check('client: top → entries, n rounded up to 20, fixed parameter order', tp && tp.entries.length >= 3 && calls[calls.length - 1].url === '/api/top?mission=ggb-ring&n=20', calls[calls.length - 1].url);
await client.topScores({ mission: 'ggb-ring', day: '2026-09-24' });
check('client: day normalized', calls[calls.length - 1].url === '/api/top?mission=ggb-ring&day=20260924&n=10');
check('client: invalid submission → null', (await client.submitScore({ mission: 'ggb-ring', score: 1, stars: 3, ac: 'f16' })) === null);
respond = async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
check('client: no service (404 page) → null', (await client.submitScore({ mission: 'ggb-ring', score: 1, stars: 0, ac: 'f16' })) === null && (await client.topScores({ mission: 'ggb-ring' })) === null);
respond = async () => new Response('<Error/>', { status: 200, headers: { 'content-type': 'application/xml' } });
check('client: non-JSON 200 → null', (await client.topScores({ mission: 'ggb-ring' })) === null);
respond = async () => { throw new TypeError('Failed to fetch'); };
check('client: network error → null', (await client.topScores({ mission: 'ggb-ring' })) === null);
respond = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
const t0 = Date.now();
const slow = await client.topScores({ mission: 'ggb-ring' });
const waited = Date.now() - t0;
check('client: timeout after ~3 s → null', slow === null && waited >= 2900 && waited < 4000, `${waited} ms`);
store.clear();
globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
check('client: no localStorage → one key per page', client.playerKey() === client.playerKey() && /^[A-Za-z0-9_-]{22}$/.test(client.playerKey()));

// ---- report -------------------------------------------------------------------------------------------------------
const width = Math.max(...rows.map((x) => x.name.length));
for (const x of rows) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(width)}  ${x.ok ? '' : x.detail}`);
const failed = rows.filter((x) => !x.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
