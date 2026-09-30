// Daily streak ("seri") and cosmetic badges, kept only in this browser (localStorage `gokyuzu.streak`: no account, no id,
// nothing sent anywhere). A day counts when the player finishes at least one flight or mission on that Istanbul calendar
// day (src/missions/util.js istanbulDay, the daily mission's day): a landing, 2 minutes in the air, a finished free-flight
// challenge or a mission result (src/retention/activity.js decides; this module only keeps the days). The streak is the
// run of consecutive days ending today, or yesterday while today is still open.
// Badges: streak milestones (3, 7, 14, 30 days) and the landing streak (successful runway landings in a row in free
// flight: 3 and 10). Each unlocks a title and a HUD accent colour the player can pick in the menu (cheap UI, no art).
// Pure functions over a plain object + an optional storage (tests/retention.test.mjs runs them in Node).
//
//   const s = readStreak(storage?)                    { v, days: ['YYYYMMDD', …], run0?, best, land: { cur, best }, badges: { id: day }, pick }
// (`days` keeps the last 60 days; `run0` is the first day of the run ending at the last one, so a run longer than the
// kept days still counts on: without it the streak stopped at 60)
//   recordDay(s, today) → { newDay, current, best, unlocked: [badge] }     (write it back with writeStreak)
//   recordLanding(s, ok, today) → { cur, best, unlocked: [badge] }
//   streakView(s, today) → { current, best, today (flew today), atRisk (yesterday was the last day), last }
//   bucket(n) → telemetry bucket '1' | '2' | '3-6' | '7-13' | '14-29' | '30+'
export const STORE = 'gokyuzu.streak';
const KEEP_DAYS = 60;

/** Milestones: kind 'streak' (days in a row) or 'landing' (successful runway landings in a row). */
export const BADGES = [
  { id: 'd3', kind: 'streak', need: 3, title: 'Düzenli pilot', color: '#6cc8ff', colorName: 'Gök mavisi' },
  { id: 'd7', kind: 'streak', need: 7, title: 'Sadık pilot', color: '#ffc94a', colorName: 'Altın' },
  { id: 'd14', kind: 'streak', need: 14, title: 'Kıdemli pilot', color: '#b9a2ff', colorName: 'Lavanta' },
  { id: 'd30', kind: 'streak', need: 30, title: 'Gökyüzü ustası', color: '#ff8f7a', colorName: 'Mercan' },
  { id: 'l3', kind: 'landing', need: 3, title: 'İniş serisi', color: '#8dffb0', colorName: 'Nane' },
  { id: 'l10', kind: 'landing', need: 10, title: 'Yumuşak eller', color: '#f2f6ff', colorName: 'Kar beyazı' },
];
export const badgeById = (id) => BADGES.find((b) => b.id === id) || null;

const ymd = (day) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
/** Whole days from a to b ('YYYYMMDD'). */
export const dayDiff = (a, b) => Math.round((ymd(b) - ymd(a)) / 86400e3);
const DAY_RE = /^\d{8}$/;

function fresh() { return { v: 1, days: [], run0: null, best: 0, land: { cur: 0, best: 0 }, badges: {}, pick: null }; }
function sane(s) {
  if (!s || typeof s !== 'object') return fresh();
  const out = fresh();
  if (Array.isArray(s.days)) out.days = [...new Set(s.days.filter((d) => typeof d === 'string' && DAY_RE.test(d)))].sort().slice(-KEEP_DAYS);
  if (typeof s.run0 === 'string' && DAY_RE.test(s.run0) && out.days.length && s.run0 < out.days[0]) out.run0 = s.run0;
  out.best = Number.isFinite(s.best) ? Math.max(0, Math.floor(s.best)) : 0;
  if (s.land && typeof s.land === 'object') out.land = { cur: Math.max(0, Math.floor(+s.land.cur || 0)), best: Math.max(0, Math.floor(+s.land.best || 0)) };
  if (s.badges && typeof s.badges === 'object') for (const b of BADGES) if (s.badges[b.id]) out.badges[b.id] = String(s.badges[b.id]).slice(0, 8);
  out.pick = s.pick && out.badges[s.pick] ? s.pick : null;
  return out;
}
const store = (storage) => storage || (typeof localStorage !== 'undefined' ? localStorage : null);
export function readStreak(storage) {
  try { const st = store(storage); return sane(st ? JSON.parse(st.getItem(STORE) || 'null') : null); } catch { return fresh(); }
}
export function writeStreak(s, storage) {
  try { const st = store(storage); if (st) st.setItem(STORE, JSON.stringify(s)); } catch { /* private mode */ }
}

/** First day of the run of consecutive days ending at the last recorded day (before the kept days: s.run0). */
function runStart(s) {
  const days = s.days;
  if (!days.length) return null;
  let i = days.length - 1;
  while (i > 0 && dayDiff(days[i - 1], days[i]) === 1) i--;
  return i === 0 && s.run0 && s.run0 < days[0] ? s.run0 : days[i];
}
/** Length of the run of consecutive days ending at the last recorded day. */
function runEndingAtLast(s) {
  const a = runStart(s);
  return a ? dayDiff(a, s.days[s.days.length - 1]) + 1 : 0;
}
/** { current, best, today, atRisk, last }: the streak shown in the menu. */
export function streakView(s, today) {
  const last = s.days[s.days.length - 1] || null;
  const gap = last ? dayDiff(last, today) : Infinity;
  const current = gap <= 1 && gap >= 0 ? runEndingAtLast(s) : 0;
  return { current, best: Math.max(s.best, current), today: gap === 0, atRisk: gap === 1, last };
}

function unlock(s, kind, value, today) {
  const got = [];
  for (const b of BADGES) if (b.kind === kind && value >= b.need && !s.badges[b.id]) { s.badges[b.id] = today; got.push(b); }
  return got;
}

/** Today had a finished flight or mission. */
export function recordDay(s, today) {
  if (!DAY_RE.test(today)) return { newDay: false, current: 0, best: s.best, unlocked: [] };
  if (s.days.includes(today)) { const v = streakView(s, today); return { newDay: false, current: v.current, best: v.best, unlocked: [] }; }
  // (a clock set back: days after `today` are dropped so the streak cannot run backwards)
  const kept = s.days.filter((d) => d < today);
  const prev = kept.length ? kept[kept.length - 1] : null;
  const start = prev && dayDiff(prev, today) === 1 ? runStart({ ...s, days: kept }) : today;
  s.days = [...kept, today].slice(-KEEP_DAYS);
  s.run0 = start < s.days[0] ? start : null;
  const current = runEndingAtLast(s);
  s.best = Math.max(s.best, current);
  return { newDay: true, current, best: s.best, unlocked: unlock(s, 'streak', current, today) };
}

/** A landing in free flight: ok = a runway landing with at least one star; anything else (or a crash) breaks the run. */
export function recordLanding(s, ok, today) {
  s.land.cur = ok ? s.land.cur + 1 : 0;
  s.land.best = Math.max(s.land.best, s.land.cur);
  return { cur: s.land.cur, best: s.land.best, unlocked: ok ? unlock(s, 'landing', s.land.cur, today) : [] };
}

/** Progress towards a badge: { have, need, done }. */
export function badgeProgress(s, b, today) {
  const have = b.kind === 'streak' ? Math.max(s.best, streakView(s, today).current) : s.land.best;
  return { have: Math.min(have, b.need), need: b.need, done: !!s.badges[b.id] };
}

/** The badge the player picked (title + accent), if still unlocked. */
export const pickedBadge = (s) => (s.pick && s.badges[s.pick] ? badgeById(s.pick) : null);

export const bucket = (n) => (n >= 30 ? '30+' : n >= 14 ? '14-29' : n >= 7 ? '7-13' : n >= 3 ? '3-6' : String(Math.max(0, n)));
