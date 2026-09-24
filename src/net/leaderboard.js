// Online leaderboard client (CONTRACTS-SF.md §12). The service lives on the game's own origin under /api/ (CloudFront →
// Lambda, infra/leaderboard), so there are no third-party calls and no CORS. Every function resolves `null` when the
// service is unavailable, slow (3 s), or answers with an error: the UI then hides the table.
//
// Players are anonymous: a random key made here and kept in localStorage (`gokyuzu.player`; the server stores only a
// salted hash of it) and an optional nickname (≤ 16 characters, filtered by src/net/names.js on both sides).
// Submitting is an explicit player action, so it is not tied to the telemetry opt-outs (Do Not Track etc.).
//
//   const r = await submitScore({ mission: 'ggb-ring', day: '20260924', score: 8450, stars: 3, ac: 'f16', name: 'Çağrı', sec: 74.2 });
//   // r → { improved, best: { score, stars, ac, sec }, rank /* 1-based, null beyond 1000 */, name, nameRejected, top: [...] } | null
//   const t = await topScores({ mission: 'ggb-ring', day: '20260924', n: 10 });
//   // t → { mission, day, entries: [{ rank, name /* null = anonymous */, score, stars, ac, sec }], at } | null
// The submit answer already carries the fresh top 10 (the /api/top answer may be up to 30 s old at the edge).
import { loadBuildInfo } from '../core/assets.js';
import { cleanName, NAME_MAX } from './names.js';

export { cleanName, NAME_MAX };   // cleanName(name) → { ok, name, reason }: instant feedback before submitting

const API = '/api/';
const TIMEOUT_MS = 3000;
const PLAYER_KEY = 'gokyuzu.player';
const NAME_KEY = 'gokyuzu.lbName';
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

let pageKey = null;   // fallback when localStorage is unavailable (private mode): one key for this page

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** This browser's anonymous player key (created on first use). */
export function playerKey() {
  try {
    let k = localStorage.getItem(PLAYER_KEY);
    if (!k || !KEY_RE.test(k)) { k = randomKey(); localStorage.setItem(PLAYER_KEY, k); }
    return k;
  } catch {
    return pageKey || (pageKey = randomKey());
  }
}

/** The nickname last accepted by the server ('' if none), to prefill the name field. */
export function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

const dayString = (day) => (day === undefined || day === null || day === '' ? '' : String(day).replace(/-/g, ''));

async function call(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API + path, { ...init, signal: ctl.signal, credentials: 'omit' });
    // hosts without the service (local dev server, S3 403 pages) answer without JSON
    if (!r.ok || !(r.headers.get('content-type') || '').includes('application/json')) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildVersion() {
  try {
    const b = await Promise.race([loadBuildInfo(), new Promise((res) => setTimeout(res, 300, null))]);
    return (b && String(b.version || '').slice(0, 40)) || '';
  } catch { return ''; }
}

/**
 * Submit a finished mission's result. The server keeps each player's best per mission (and per day for the daily
 * mission). `name` is optional; a name the filter rejects is dropped (the entry stays anonymous, `nameRejected: true`).
 */
export async function submitScore({ mission, day, score, stars, ac, name, sec } = {}) {
  try {
    const nm = typeof name === 'string' ? name.trim() : undefined;
    const body = JSON.stringify({
      mission, day: dayString(day) || undefined, score, stars, ac, name: nm || undefined, sid: playerKey(), v: await buildVersion(),
      sec: typeof sec === 'number' && Number.isFinite(sec) ? Math.round(sec * 10) / 10 : undefined,
    });
    // the API origin is a Lambda function URL behind CloudFront origin access control: the body's SHA-256 must be sent
    const hash = await sha256Hex(body);
    const r = await call('score', {
      method: 'POST', body, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-amz-content-sha256': hash },
    });
    if (!r || !r.ok) return null;
    try {
      if (r.name && nm !== undefined && cleanName(nm).name === r.name) localStorage.setItem(NAME_KEY, r.name);
      else if (nm === '') localStorage.removeItem(NAME_KEY);
    } catch { /* private mode */ }
    return { improved: !!r.improved, best: r.best, rank: r.rank ?? null, name: r.name ?? null, nameRejected: !!r.nameRejected, top: r.top || [] };
  } catch {
    return null;
  }
}

/** Top N (10, 20 or 50) of a mission's board, or of its daily board when `day` (YYYYMMDD) is given. */
export async function topScores({ mission, day, n = 10 } = {}) {
  if (typeof mission !== 'string' || !mission) return null;
  const size = n <= 10 ? 10 : n <= 20 ? 20 : 50;
  const q = new URLSearchParams({ mission });   // fixed parameter order: one edge cache entry per board
  const d = dayString(day);
  if (d) q.set('day', d);
  q.set('n', String(size));
  const r = await call(`top?${q}`, { method: 'GET' });
  return r && Array.isArray(r.entries) ? { mission: r.mission, day: r.day ?? null, entries: r.entries, at: r.at } : null;
}
