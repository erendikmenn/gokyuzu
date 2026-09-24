// End-to-end check of the leaderboard service through the real CloudFront origin, plus latency from this machine.
//
//   node infra/leaderboard/verify.mjs staging [--cold 3] [--samples 12]   # full check (writes to the `selftest` board)
//   node infra/leaderboard/verify.mjs production [--host d123.cloudfront.net]   # read-only: never writes a score
//
// Staging: submit → top, best-score logic, nickname filter, bad payloads (400/405/413/415), the POST rate limit (429),
// direct calls to the Lambda function URL refused (403), edge caching of /api/top. --cold N forces N cold starts (a
// configuration touch through the admin profile "gokyuzu-admin", passed explicitly) and times the first request after each.
// Prints PASS/FAIL lines and a latency table (edge PoP, connection + TLS, time to first byte on an open connection).
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) || 'staging';
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const HOST = opt('host', target === 'production' ? 'fs.erenailab.com' : 'staging.fs.erenailab.com');
const BASE = `https://${HOST}`;
const FUNCTION = `gokyuzu-sf-leaderboard-${target}`;
const AWS = ['--profile', process.env.AWS_PROFILE_ADMIN || 'gokyuzu-admin', '--region', 'eu-central-1'];
const COLD = Number(opt('cold', 0));
const SAMPLES = Number(opt('samples', 10));
const WRITE = target !== 'production';

const rows = [];
const check = (name, ok, detail = '') => { rows.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => randomBytes(16).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
async function nextMinute() { const ms = 61000 - (Date.now() % 60000); console.log(`  (waiting ${Math.round(ms / 1000)} s for a fresh rate-limit minute)`); await sleep(ms); }

async function post(body, { type = 'application/json', hash = true, raw } = {}) {
  const text = raw !== undefined ? raw : JSON.stringify(body);
  const headers = { 'content-type': type, origin: BASE };
  if (hash) headers['x-amz-content-sha256'] = sha(text);
  const r = await fetch(`${BASE}/api/score`, { method: 'POST', headers, body: text });
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers };
}
async function get(query, { method = 'GET', path = '/api/top', base = BASE } = {}) {
  const r = await fetch(`${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`, { method });
  let json = null;
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers };
}

function functionUrl() {
  if (opt('direct')) return opt('direct').replace(/\/$/, '');
  try {
    return execFileSync('aws', [...AWS, 'lambda', 'get-function-url-config', '--function-name', FUNCTION, '--query', 'FunctionUrl', '--output', 'text'],
      { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: '' } }).trim().replace(/\/$/, '');
  } catch { return null; }
}

// curl gives the phases: DNS, TCP, TLS, first byte (a fresh connection each time, like a first request from a page)
function curl(url, { method = 'GET', body, headers = {} } = {}) {
  const a = ['-s', '-o', '/dev/null', '-X', method, '-D', '-', '-w', '\n%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code}'];
  for (const [k, v] of Object.entries(headers)) a.push('-H', `${k}: ${v}`);
  if (body !== undefined) a.push('--data-binary', body);
  const out = execFileSync('curl', [...a, url], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const [dns, tcp, tls, ttfb, total, code] = lines[lines.length - 1].split(' ').map(Number);
  const hdr = (name) => (lines.find((l) => l.toLowerCase().startsWith(`${name}:`)) || '').split(':').slice(1).join(':').trim();
  return { dns, tcp, tls, ttfb, total, code, server: ttfb - tls, pop: hdr('x-amz-cf-pop'), cache: hdr('x-cache') };
}
const ms = (s) => `${Math.round(s * 1000)}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : NaN; };
const lat = {};
const record = (label, m) => { (lat[label] ||= []).push(m); };

console.log(`Leaderboard check · ${target} · ${BASE}${WRITE ? '' : ' (read-only)'}\n`);
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const M = 'selftest';

// ---- reads ----------------------------------------------------------------------------------------------------------
let r = await get({ mission: M, n: '10' });
check('GET /api/top → 200 JSON', r.status === 200 && r.json && Array.isArray(r.json.entries), `${r.status} ${JSON.stringify(r.json)}`);
check('GET /api/top edge-cacheable (s-maxage=30)', /s-maxage=30/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
r = await get({ mission: M, n: '10' });
check('GET /api/top second request served by the edge cache', /Hit from cloudfront/i.test(r.headers.get('x-cache') || ''), r.headers.get('x-cache'));
check('GET n=7 → 400', (await get({ mission: M, n: '7' })).status === 400);
check('GET day older than 31 days → 400', (await get({ mission: M, day: '20250101', n: '10' })).status === 400);
check('GET bad mission id → 400', (await get({ mission: '../etc', n: '10' })).status === 400);
check('GET /api/score → 405', (await get(null, { path: '/api/score' })).status === 405);
check('GET /api/nothing → 404', (await get(null, { path: '/api/nothing' })).status === 404);

// ---- direct function URL -----------------------------------------------------------------------------------------
const direct = functionUrl();
if (direct) {
  const d1 = await get({ mission: M, n: '10' }, { base: direct });
  check('direct function URL GET refused (403)', d1.status === 403, `${d1.status}`);
  const d2 = await fetch(`${direct}/api/score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('direct function URL POST refused (403)', d2.status === 403, `${d2.status}`);
} else {
  console.log('SKIP  direct function URL (no --direct and no admin session)');
}

// ---- writes (staging) -----------------------------------------------------------------------------------------------
const base = { mission: M, ac: 'uh60', v: 'verify', stars: 0 };
if (WRITE) {
  await nextMinute();
  const A = key(), B = key(), C = key();
  r = await post({ ...base, sid: A, score: 50, name: 'Çağrı Test' });
  check('POST first score → 200, improved, ranked', r.status === 200 && r.json.improved && r.json.rank >= 1 && r.json.name === 'Çağrı Test', `${r.status} ${JSON.stringify(r.json)}`);
  r = await post({ ...base, sid: A, score: 30, name: 'Çağrı Test' });
  check('POST lower score keeps the best', r.status === 200 && !r.json.improved && r.json.best.score === 50, JSON.stringify(r.json));
  r = await post({ ...base, sid: A, score: 70, sec: 42.5, name: 'Çağrı Test' });
  check('POST higher score replaces it', r.status === 200 && r.json.improved && r.json.best.score === 70 && r.json.best.sec === 42.5, JSON.stringify(r.json));
  check('POST answer carries the fresh top 10', r.json.top.some((e) => e.name === 'Çağrı Test' && e.score === 70), JSON.stringify(r.json.top));
  r = await post({ ...base, sid: B, score: 60, name: 'a m k' });
  check('nickname filter: offensive → stored anonymously', r.status === 200 && r.json.nameRejected && r.json.name === null, JSON.stringify(r.json));
  r = await post({ ...base, sid: C, score: 61, name: 'www site com' });
  check('nickname filter: link → stored anonymously', r.status === 200 && r.json.nameRejected && r.json.name === null, JSON.stringify(r.json));
  r = await post({ ...base, sid: C, score: 62, name: 'Şükrü_34' });
  check('nickname filter: Turkish letters accepted', r.status === 200 && r.json.name === 'Şükrü_34', JSON.stringify(r.json));
  r = await post({ ...base, sid: key(), score: 5, day: today });
  check('POST daily board (today)', r.status === 200 && r.json.rank >= 1, JSON.stringify(r.json));
  const t = await get({ mission: M, day: today, n: '10' });
  check('GET daily board', t.status === 200 && t.json.day === today && t.json.entries.length >= 1, JSON.stringify(t.json));

  await nextMinute();
  const bad = async (label, body, expect, o) => { const x = await post(body, o); check(`${label} → ${expect}`, x.status === expect, `${x.status} ${JSON.stringify(x.json)}`); };
  await bad('malformed JSON', null, 400, { raw: '{"mission":' });
  await bad('stars 9', { ...base, sid: key(), score: 1, stars: 9 }, 400);
  await bad('negative score', { ...base, sid: key(), score: -5 }, 400);
  await bad('unknown aircraft', { ...base, sid: key(), score: 1, ac: 'cessna' }, 400);
  await bad('day two days ahead', { ...base, sid: key(), score: 1, day: '20991231' }, 400);
  await bad('short player key', { ...base, sid: 'abc', score: 1 }, 400);
  await bad('body over 1 KB', { ...base, sid: key(), score: 1, pad: 'x'.repeat(1200) }, 413);
  await bad('text/plain (cross-site form)', { ...base, sid: key(), score: 1 }, 415, { type: 'text/plain' });
  const nohash = await post({ ...base, sid: key(), score: 1 }, { hash: false });
  check('POST without body hash refused by the signed origin', nohash.status >= 400, `${nohash.status}`);
  const put = await fetch(`${BASE}/api/score`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-amz-content-sha256': sha('{}') }, body: '{}' });
  check('PUT /api/score → 405', put.status === 405, `${put.status}`);

  await nextMinute();
  const codes = [];
  for (let i = 0; i < 15; i++) codes.push((await post({ ...base, sid: key(), score: i })).status);
  const ok = codes.filter((c) => c === 200).length, limited = codes.filter((c) => c === 429).length;
  check(`rate limit: 15 POSTs in a minute → ${ok} accepted, ${limited} × 429`, ok === 12 && limited === 3, codes.join(','));
} else {
  const x = await post({ ...base, sid: key(), score: 1, stars: 9 });
  check('POST invalid payload → 400 (nothing stored)', x.status === 400, `${x.status}`);
}

// ---- latency --------------------------------------------------------------------------------------------------------
console.log('\nLatency from this machine (ms):');
for (let i = 0; i < SAMPLES; i++) {
  record('GET edge hit', curl(`${BASE}/api/top?mission=${M}&n=10`));
}
const past = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
for (let i = 0; i < SAMPLES; i++) {   // distinct cache keys: each is an origin fetch (warm function)
  record('GET origin (warm)', curl(`${BASE}/api/top?mission=${M}&day=${past((i % 30) + 1)}&n=${[10, 20, 50][Math.floor(i / 30) % 3]}`));
  await sleep(200);
}
if (WRITE) {
  await nextMinute();
  for (let i = 0; i < Math.min(SAMPLES, 10); i++) {
    const body = JSON.stringify({ ...base, sid: key(), score: 1 });
    record('POST (warm)', curl(`${BASE}/api/score`, { method: 'POST', body, headers: { 'content-type': 'application/json', origin: BASE, 'x-amz-content-sha256': sha(body) } }));
  }
}
for (let i = 0; i < COLD; i++) {
  try {
    execFileSync('aws', [...AWS, 'lambda', 'update-function-configuration', '--function-name', FUNCTION, '--description',
      `Gokyuzu SF leaderboard /api/* (${target}); managed by infra/leaderboard/setup.py`, '--memory-size', String(i % 2 ? 256 : 257)],
    { env: { ...process.env, AWS_PROFILE: '' }, stdio: 'ignore' });
    execFileSync('aws', [...AWS, 'lambda', 'wait', 'function-updated-v2', '--function-name', FUNCTION], { env: { ...process.env, AWS_PROFILE: '' } });
    await sleep(2000);
    record('GET origin (cold start)', curl(`${BASE}/api/top?mission=${M}&day=${past(i + 1)}&n=50&cold=${Date.now()}`));
  } catch (e) {
    console.log(`  cold start ${i + 1}: skipped (${e.message.split('\n')[0]})`);
  }
}
if (COLD) {
  try {
    execFileSync('aws', [...AWS, 'lambda', 'update-function-configuration', '--function-name', FUNCTION, '--memory-size', '256'], { env: { ...process.env, AWS_PROFILE: '' }, stdio: 'ignore' });
  } catch { /* already 256 */ }
}
const pops = new Set(Object.values(lat).flat().map((m) => m.pop).filter(Boolean));
console.log(`  edge location(s): ${[...pops].join(', ') || '?'}`);
console.log(`  ${'request'.padEnd(24)} ${'n'.padStart(3)}  ${'TLS ready'.padStart(9)}  ${'first byte on open conn. (median / p90)'.padStart(40)}  ${'total fresh conn. (median)'.padStart(26)}`);
for (const [label, m] of Object.entries(lat)) {
  const srv = m.map((x) => x.server), tot = m.map((x) => x.total), tls = m.map((x) => x.tls);
  const codes = [...new Set(m.map((x) => x.code))].join('/');
  console.log(`  ${label.padEnd(24)} ${String(m.length).padStart(3)}  ${ms(median(tls)).padStart(9)}  ${`${ms(median(srv))} / ${ms(p90(srv))}`.padStart(40)}  ${ms(median(tot)).padStart(26)}   HTTP ${codes}`);
}
const failed = rows.filter((x) => !x.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} checks passed`);
process.exit(failed ? 1 : 0);
