// Leaderboard request handling (Lambda Function URL event → response), independent of AWS so it runs in the unit tests
// with the in-memory store (memdb.mjs). index.mjs wires it to DynamoDB.
//
//   POST /api/score  {mission, day?, score, stars, ac, name?, sid, v, sec?}  → keeps each player's best per board
//   GET  /api/top?mission=&day=&n=10|20|50                                    → top N, cacheable 30 s at the edge
//
// Privacy: players are a random key made by the browser (`sid`), stored only as a salted hash; the optional nickname is
// filtered (src/net/names.js). No IP address is stored or logged: the rate limit counts per 20-bit salted hash of the
// address and the current minute (not reversible, unlinkable from one minute to the next), expiring after 2 minutes.
import { createHmac } from 'node:crypto';
import { viewerIp, ipBucket } from './net.mjs';
import { checkScore, checkTop, boardKey, rankKey, MAX_BODY, DAY_MS } from './validate.mjs';

const TOP_CACHE = 'public, max-age=15, s-maxage=30';
const RANK_CAP = 1000;   // "1000+" beyond that (counting costs reads)
const TEST_TTL = 86400;  // selftest boards (staging checks) expire after a day
const DAILY_TTL = 31;    // days a daily board lives after its day

function reply(status, body, cache = 'no-store', extra = {}) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin', ...extra,
    },
    body: JSON.stringify(body),
  };
}

const entry = (it, i) => ({ rank: i + 1, name: it.n || null, score: it.sc, stars: it.st, ac: it.ac, sec: it.sec ?? null });

/**
 * @param {object} o
 * @param {object} o.db       store: { hit, putBest, top, countAbove } (dynamo.mjs / memdb.mjs)
 * @param {string} o.salt     secret for the player and rate-limit hashes (≥ 32 chars)
 * @param {object} o.rules    rules.json
 * @param {string} [o.stage]  'staging' | 'production'
 * @param {string[]} [o.origins] allowed Origin values for POST (empty: not checked)
 * @param {() => number} [o.now]
 * @param {{post: number, get: number}} [o.limits] requests per minute and address
 */
export function createApp({ db, salt, rules, stage = 'staging', origins = [], now = () => Date.now(), limits = { post: 12, get: 90 } }) {
  if (!salt || salt.length < 32) throw new Error('salt missing');
  const hash = (text, len) => createHmac('sha256', salt).update(text).digest('base64url').slice(0, len);
  // Per-container counters for the current minute: GETs are limited here only (no store write for reads; most are
  // answered by the edge cache), POSTs are pre-checked here so a flood that already hit this container is refused
  // without a store write (the store counter stays the authority across containers).
  let minuteNow = -1, hits = new Map();
  function local(kind, bucket, minute) {
    if (minute !== minuteNow) { minuteNow = minute; hits = new Map(); }
    const k = `${kind}|${bucket}`;
    const c = (hits.get(k) || 0) + 1;
    hits.set(k, c);
    return c;
  }

  async function top(q) {
    const items = await db.top(boardKey(q.mission, q.day), q.n);
    return items.map(entry);
  }

  async function score(event, headers, bucket, minute, t) {
    const origin = headers.origin;
    if (origins.length && origin && !origins.includes(origin)) return reply(403, { error: 'origin' });
    if (headers['sec-fetch-site'] && !['same-origin', 'none'].includes(headers['sec-fetch-site'])) return reply(403, { error: 'origin' });
    if (!/^application\/json\b/i.test(headers['content-type'] || '')) return reply(415, { error: 'type' });
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8')) : Buffer.alloc(0);
    if (raw.length > MAX_BODY) return reply(413, { error: 'size' });

    const retry = { 'retry-after': String(60 - Math.floor((t / 1000) % 60)) };
    if (local('post', bucket, minute) > limits.post) return reply(429, { error: 'rate' }, 'no-store', retry);
    // 20 bits of a salted hash: each stored key stands for thousands of possible addresses, so it cannot be turned back
    // into one even with the salt; two players sharing a bucket in the same minute only share the limit
    const rl = createHmac('sha256', salt).update(`${bucket}|${minute}|post`).digest('hex').slice(0, 5);
    const count = await db.hit(`rl#${minute}#${rl}`, Math.floor(t / 1000) + 120);
    if (count > limits.post) return reply(429, { error: 'rate' }, 'no-store', retry);

    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'json' }); }
    const chk = checkScore(body, { rules, stage, now: t });
    if (!chk.ok) return reply(400, { error: chk.error });
    const s = chk.value;

    const tSec = Math.floor(t / 1000);
    const pk = boardKey(s.mission, s.day);
    const item = {
      pk, sk: `p#${hash(`player|${s.sid}`, 22)}`, rk: rankKey(s.score, tSec, s.lower),
      sc: s.score, st: s.stars, ac: s.ac, t: tSec, v: s.v,
      ...(s.name ? { n: s.name } : {}), ...(s.sec !== null ? { sec: s.sec } : {}),
      ...(s.test ? { exp: tSec + TEST_TTL } : s.day ? { exp: Math.floor((s.dayMs + DAILY_TTL * DAY_MS) / 1000) } : {}),
    };
    const put = await db.putBest(item);
    let best = put.written || !put.old ? item : put.old;
    // the game submits a finished run at once without a nickname; a nickname sent afterwards (same or lower score)
    // names the player's existing best entry on this board
    if (!put.written && put.old && s.name && put.old.n !== s.name) {
      await db.setName(pk, item.sk, s.name);
      best = { ...put.old, n: s.name };
    }
    const [above, board] = await Promise.all([db.countAbove(pk, best.rk, RANK_CAP), db.top(pk, 10)]);
    // the rank index is eventually consistent: show the fresh nickname on the player's own row at once
    const top = board.map((it) => (it.rk === best.rk && best.n && !it.n ? { ...it, n: best.n } : it)).map(entry);
    return reply(200, {
      ok: true, improved: put.written,
      best: { score: best.sc, stars: best.st, ac: best.ac, sec: best.sec ?? null },
      rank: above >= RANK_CAP ? null : above + 1,
      name: best.n || null, nameRejected: s.nameRejected,
      top,
    });
  }

  return async function handle(event) {
    const t = now();
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    const headers = event.headers || {};
    const bucket = ipBucket(viewerIp(headers));
    const minute = Math.floor(t / 60000);
    try {
      if (path === '/api/top') {
        if (method !== 'GET' && method !== 'HEAD') return reply(405, { error: 'method' }, 'no-store', { allow: 'GET, HEAD' });
        if (local('get', bucket, minute) > limits.get) return reply(429, { error: 'rate' }, 'no-store', { 'retry-after': '60' });
        const chk = checkTop(event.queryStringParameters || {}, { rules, stage, now: t });
        if (!chk.ok) return reply(400, { error: chk.error }, 'public, max-age=60');
        const q = chk.value;
        return reply(200, { mission: q.mission, day: q.day, entries: await top(q), at: new Date(t).toISOString() }, TOP_CACHE);
      }
      if (path === '/api/score') {
        if (method !== 'POST') return reply(405, { error: 'method' }, 'no-store', { allow: 'POST' });
        return await score(event, headers, bucket, minute, t);
      }
      return reply(404, { error: 'path' }, 'public, max-age=300');
    } catch (e) {
      // never log the request (addresses, keys, names): only what failed
      console.error(JSON.stringify({ msg: 'leaderboard error', name: e && e.name, code: e && (e.code || e.$metadata?.httpStatusCode) }));
      return reply(503, { error: 'unavailable' });
    }
  };
}
