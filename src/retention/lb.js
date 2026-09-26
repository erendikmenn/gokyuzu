// Leaderboard calls of the retention features (weekly boards w-<yyyyww>-<base>, quiet submissions of results that are
// not on screen) over the game's client (src/net/leaderboard.js: anonymous player key, optional saved nickname, 3 s
// timeout, null when the service is unavailable). Like the result screens (src/ui/mission-parts.js), no request is made
// on the local dev server (no /api/ there) unless ?lb=1.
// Telemetry: `wk` submit (id = the weekly pick's key, r = rank, im = 1 improved) / fail; `lb` submit with q = 1 for a
// quiet submission (b = board, never the nickname).
import { trackEvent } from '../core/telemetry.js';

const local = () => /^(localhost|127\.|\[::1\])/.test(location.hostname) && new URLSearchParams(location.search).get('lb') !== '1';
let modP = null;
const mod = () => (modP || (modP = import('../net/leaderboard.js').catch(() => { modP = null; return null; })));

/** Top N of a board (weekly / daily / all-time) → { entries } | null. */
export async function boardTop(board, { day = '', n = 10 } = {}) {
  if (local()) return null;
  const m = await mod();
  return m ? m.topScores({ mission: board, day, n }) : null;
}

const done = new Map();   // board|score|stars|sec|ac → Promise (one submission per result)
/**
 * Submit a finished run to a board without a result view of its own (the weekly board next to the mission's own board,
 * a second free-flight result of the same landing). → Promise<{ rank, improved, best, top } | null>
 */
export function submitQuiet({ board, day = '', score, stars, sec, ac, weekly = null }) {
  if (local() || !board || !(score >= 0) || !(stars >= 1)) return Promise.resolve(null);
  const k = `${board}|${day}|${score}|${stars}|${sec}|${ac}`;
  if (done.has(k)) return done.get(k);
  const p = mod().then(async (m) => {
    if (!m) return null;
    const saved = m.savedName ? m.savedName() : '';
    const r = await m.submitScore({ mission: board, day, score, stars, ac, sec, name: saved || undefined });
    if (weekly) trackEvent('wk', r ? { st: 'submit', id: weekly, r: r.rank ?? undefined, im: r.improved ? 1 : 0 } : { st: 'fail', id: weekly });
    else trackEvent('lb', r ? { st: 'submit', b: board, d: day ? 1 : undefined, r: r.rank ?? undefined, im: r.improved ? 1 : 0, nm: r.name ? 1 : 0, au: 1, q: 1 } : { st: 'fail', b: board, q: 1 });
    if (!r) done.delete(k);
    return r;
  }).catch(() => { done.delete(k); return null; });
  done.set(k, p);
  return p;
}
