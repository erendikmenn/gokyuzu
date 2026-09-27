// Payload validation and plausibility for the leaderboard (pure functions, unit-tested in tests/leaderboard.test.mjs).
// Rules come from rules.json (built from src/missions by infra/leaderboard/build_rules.mjs): per mission the score and
// time ranges, allowed aircraft, whether a lower score is better, whether it has daily boards and star thresholds.
// Weekly boards ("Haftanın görevi", src/retention/weekly.js): `w-<yyyyww>-<base>` where base is any known board (a
// mission or a free-flight board) and yyyyww an ISO week of the Istanbul calendar (UTC+3). A weekly board inherits its
// base's rule, has no daily boards, takes scores only in the current week (± 1 day of clock skew), can be read for the
// last `weekly.back` weeks and expires `weekly.ttlDays` after its week ended. rules.weekly missing: no weekly boards.
// Assisted boards ("Destekli" list: runs flown with assisted flight or landed on the autopilot): `as-<board>` for every
// board, inside a weekly id as `w-<yyyyww>-as-<base>` (one spelling per board: `as-w-…` and `as-as-…` are refused). An
// assisted board inherits its base's rule (score, stars, aircraft, time, daily days, TTL) and has the same nickname flow.
// rules.assisted missing: no assisted boards.
import { cleanName } from '../../../src/net/names.js';

export const DAY_MS = 86400000;
export const MAX_BODY = 1024;          // bytes; a real submission is ~200
export const TOP_SIZES = [10, 20, 50]; // allowed ?n= values (a small, fixed set keeps the edge cache effective)
const MISSION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const VERSION_RE = /^[\w.+-]{0,40}$/;
const PAD = 10, SCORE_CAP = 1e9, INV = 9999999999;
const WEEKLY_RE = /^w-(\d{4})(\d{2})-([a-z0-9][a-z0-9_-]*)$/;
const IST_OFFSET = 3 * 3600000;   // Europe/Istanbul: UTC+3 all year (since 2016)
const WEEK_MS = 7 * 86400000;

const fail = (field) => ({ ok: false, error: field });

/** 'YYYYMMDD' (UTC) of a time in ms. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Midnight UTC of a 'YYYYMMDD' day in ms, or NaN when it is not a real date. */
export function dayMs(day) {
  if (typeof day !== 'string' || !/^\d{8}$/.test(day)) return NaN;
  const y = +day.slice(0, 4), m = +day.slice(4, 6), d = +day.slice(6, 8);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : NaN;
}

/** Monday 00:00 UTC (ms) of ISO week 1 of year y. */
const week1Monday = (y) => { const jan4 = Date.UTC(y, 0, 4); return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS; };
/** ISO week 'YYYYWW' of the Istanbul calendar day at time `ms`. */
export function istWeek(ms) {
  const d = new Date(ms + IST_OFFSET);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const y = new Date(t + (3 - dow) * DAY_MS).getUTCFullYear();
  const w = 1 + Math.round((t - dow * DAY_MS - week1Monday(y)) / WEEK_MS);
  return `${y}${String(w).padStart(2, '0')}`;
}
/** Monday 00:00 UTC (ms) of a 'YYYYWW' week, or NaN when it is not a real ISO week. */
export function weekStartMs(week) {
  const m = /^(\d{4})(\d{2})$/.exec(String(week || ''));
  if (!m || +m[2] < 1 || +m[2] > 53) return NaN;
  const t = week1Monday(+m[1]) + (+m[2] - 1) * WEEK_MS;
  return istWeek(t - IST_OFFSET) === week ? t : NaN;
}
const ASSISTED = 'as-';
/** An assisted board id → its base board (or null: not an assisted board). */
export const parseAssisted = (mission) => (String(mission || '').startsWith(ASSISTED) ? String(mission).slice(ASSISTED.length) : null);
/** A weekly board id → { week, base } (or null: not a weekly board). */
export function parseWeekly(mission) {
  const m = WEEKLY_RE.exec(String(mission || ''));
  return m ? { week: `${m[1]}${m[2]}`, base: m[3] } : null;
}

/** The rule for a mission (defaults merged), or null when the mission is unknown and the rules are strict. */
export function missionRule(rules, mission, stage) {
  const as = parseAssisted(mission);
  if (as !== null) {   // an assisted board: its base's rule (not a weekly id: that spelling is w-<week>-as-<base>)
    if (!rules.assisted || parseAssisted(as) !== null || parseWeekly(as)) return null;
    const base = missionRule(rules, as, stage);
    return base ? { ...base, assisted: true } : null;
  }
  const wk = parseWeekly(mission);
  if (wk) {   // a weekly board: its base's rule (not another weekly board), weekly boards enabled, a real week
    if (!rules.weekly || parseWeekly(wk.base) || Number.isNaN(weekStartMs(wk.week))) return null;
    const base = missionRule(rules, wk.base, stage);
    return base ? { ...base, daily: false, dailyOnly: false, weekly: wk.week } : null;
  }
  const own = rules.missions && Object.prototype.hasOwnProperty.call(rules.missions, mission) ? rules.missions[mission] : null;
  const test = stage !== 'production' && (rules.test || []).includes(mission);
  if (!own && !test && rules.strict) return null;
  return { ...rules.default, aircraft: rules.aircraft, ...(own || {}), test };
}

/** A weekly rule's week against the clock: scores in the current Istanbul week (± 1 day), reads `back` weeks back + next. */
function checkWeek(rule, rules, now, write) {
  if (!rule.weekly) return { ok: true };
  const start = weekStartMs(rule.weekly);
  if (write) {
    const ok = [now - DAY_MS, now, now + DAY_MS].some((t) => istWeek(t) === rule.weekly);
    return ok ? { ok: true, endMs: start + WEEK_MS - IST_OFFSET } : { ok: false };
  }
  const cur = weekStartMs(istWeek(now)), back = (rules.weekly && rules.weekly.back) || 8;
  return start >= cur - back * WEEK_MS && start <= cur + WEEK_MS ? { ok: true } : { ok: false };
}

/** The day argument of a request: null (no daily board) or a valid 'YYYYMMDD' within [today - back, today + ahead]. */
function checkDay(day, now, back, ahead) {
  if (day === undefined || day === null || day === '') return { ok: true, day: null };
  if (typeof day !== 'string' && typeof day !== 'number') return { ok: false };   // (an array or object would stringify)
  const d = String(day);
  const t = dayMs(d), today = dayMs(utcDay(now));
  if (Number.isNaN(t) || t < today - back * DAY_MS || t > today + ahead * DAY_MS) return { ok: false };
  return { ok: true, day: d, ms: t };
}

/**
 * POST /api/score body → { ok: true, value } | { ok: false, error: '<field>' }.
 * Daily submissions are accepted for yesterday … tomorrow (UTC), which covers every time zone's "today".
 */
export function checkScore(body, { rules, stage, now }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('body');
  const { mission, score, stars, ac, name, sid, v, sec } = body;
  if (typeof mission !== 'string' || !MISSION_RE.test(mission)) return fail('mission');
  const rule = missionRule(rules, mission, stage);
  if (!rule) return fail('mission');
  const day = checkDay(body.day, now, 1, 1);
  if (!day.ok || (day.day && rule.daily === false) || (!day.day && rule.dailyOnly)) return fail('day');
  const wk = checkWeek(rule, rules, now, true);
  if (!wk.ok) return fail('week');
  if (typeof score !== 'number' || !Number.isFinite(score)) return fail('score');
  const sc = Math.round(score);
  if (sc < rule.scoreMin || sc > rule.scoreMax || sc < 0 || sc > SCORE_CAP) return fail('score');
  if (!Number.isInteger(stars) || stars < (rule.starsMin || 0) || stars > 3) return fail('stars');
  // star thresholds [1★, 2★, 3★] (score needed; for lower-is-better missions the maximum): more stars than the
  // score earns is not plausible
  if (Array.isArray(rule.stars) && rule.stars.length === 3) {
    const earned = rule.stars.filter((t) => (rule.lower ? sc <= t : sc >= t)).length;
    if (stars > earned) return fail('stars');
  }
  if (typeof ac !== 'string' || !rule.aircraft.includes(ac)) return fail('ac');
  let seconds = null;
  if (sec !== undefined && sec !== null) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < rule.secMin || sec > rule.secMax) return fail('sec');
    seconds = Math.round(sec * 10) / 10;
  } else if (rule.secRequired) return fail('sec');
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return fail('sid');
  if (v !== undefined && v !== null && (typeof v !== 'string' || !VERSION_RE.test(v))) return fail('v');
  const nm = cleanName(name);
  return {
    ok: true,
    value: { mission, day: day.day, dayMs: day.ms ?? null, score: sc, stars, ac, sec: seconds, sid, v: v || '',
      name: nm.name, nameRejected: !nm.ok, lower: !!rule.lower, test: rule.test, assisted: !!rule.assisted,
      weekEndMs: wk.endMs ?? null, weeklyTtlDays: rule.weekly ? (rules.weekly && rules.weekly.ttlDays) || 35 : null },
  };
}

/** GET /api/top query → { ok: true, value: { mission, day, n, lower } } | { ok: false, error }. Days: the last 31 + tomorrow. */
export function checkTop(q, { rules, stage, now }) {
  const mission = q.mission;
  if (typeof mission !== 'string' || !MISSION_RE.test(mission)) return fail('mission');
  const rule = missionRule(rules, mission, stage);
  if (!rule) return fail('mission');
  const day = checkDay(q.day, now, 31, 1);
  if (!day.ok || (day.day && rule.daily === false)) return fail('day');
  if (!checkWeek(rule, rules, now, false).ok) return fail('week');
  let n = 10;
  if (q.n !== undefined && q.n !== '') {
    n = Number(q.n);
    if (!TOP_SIZES.includes(n)) return fail('n');
  }
  return { ok: true, value: { mission, day: day.day, n, lower: !!rule.lower } };
}

/** DynamoDB partition key of a board: one per mission, one per mission and day for daily boards. */
export const boardKey = (mission, day) => (day ? `b#${mission}#${day}` : `b#${mission}`);

/**
 * Sort key of an entry on its board's rank index (sorted descending): the better score first, then the earlier time.
 * Lower-is-better missions store the inverted score.
 */
export function rankKey(score, tSec, lower) {
  const s = lower ? INV - score : score;
  return `${String(s).padStart(PAD, '0')}#${String(INV - tSec).padStart(PAD, '0')}`;
}
