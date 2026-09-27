// Challenge links ("Beni geç"): a mission result shared as https://<site>/?mission=<id>&challenge=<score> (daily runs
// add &daily=YYYYMMDD; the weekly challenge is the plain mission, so its link is the plain one). The friend who opens it
// flies the same mission (src/app/main.js ?mission=) with "Arkadaşın 2.450 puan yaptı — geçebilir misin?" on the
// briefing, and the result says whether they beat it, with a share-back carrying their own score.
// Pure functions (tests/retention.test.mjs); the UI is src/retention/mission-hooks.js and src/ui/share.js.
import { parseDay, fmtInt } from '../missions/util.js';

export const CHALLENGE_MAX = 1000000;

/**
 * ?mission=<id>&challenge=<score>(&daily=) → { id, score, day } or null (no / bad challenge). `max`: the most the mission
 * can give (src/missions/score-max.js); a link claiming more is not a real result and shows nothing.
 */
export function parseChallenge(search, { max = CHALLENGE_MAX } = {}) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch { return null; }
  const id = q.get('mission'), c = q.get('challenge');
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !c || !/^\d{1,7}$/.test(c)) return null;
  const score = Number(c);
  if (score < 1 || score > CHALLENGE_MAX || !(score <= max)) return null;
  return { id, score, day: parseDay(q.get('daily')) };
}
/** The highest challenge a mission accepts: its maximum score with the leaderboard's 10 % margin (infra/leaderboard). */
export const challengeCap = (maxScore) => (Number.isFinite(maxScore) && maxScore > 0 ? Math.ceil(maxScore * 1.1) : CHALLENGE_MAX);

/** The link that challenges a friend to beat `score` on mission `id` (same origin and path as `base`). */
export function challengeUrl(base, { id, day = null, score }) {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  u.searchParams.set('mission', id);
  if (day) u.searchParams.set('daily', day);
  if (Number.isFinite(score) && score >= 1) u.searchParams.set('challenge', String(Math.min(CHALLENGE_MAX, Math.round(score))));
  return u.href;
}

/** The result against the challenge: 'beat' | 'tie' | 'short' (finished below) | 'fail' (not finished). */
export function challengeOutcome(ch, result) {
  if (!ch || !result) return null;
  if (!result.ok) return 'fail';
  const s = Math.round(result.score || 0);
  return s > ch.score ? 'beat' : s === ch.score ? 'tie' : 'short';
}

/** Turkish lines of the briefing banner and the result. */
export const briefLine = (ch) => `Arkadaşın ${fmtInt(ch.score)} puan yaptı — geçebilir misin?`;
export function resultLine(ch, result) {
  const o = challengeOutcome(ch, result);
  const s = Math.round((result && result.score) || 0);
  if (o === 'beat') return { o, title: 'Arkadaşını geçtin!', text: `${fmtInt(s)} > ${fmtInt(ch.score)} puan. Şimdi sıra onda: skorunu geri gönder.` };
  if (o === 'tie') return { o, title: 'Berabere!', text: `İkiniz de ${fmtInt(s)} puan. Bir puan daha ve geçiyorsun.` };
  if (o === 'short') return { o, title: 'Az kaldı', text: `Arkadaşın ${fmtInt(ch.score)} puan yaptı: ${fmtInt(ch.score - s)} puan kaldı. Tekrar dene!` };
  return { o, title: 'Arkadaşın hâlâ önde', text: `Arkadaşın ${fmtInt(ch.score)} puan yaptı. Görevi bitir ve geç!` };
}
