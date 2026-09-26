// Weekly challenge ("Haftanın görevi"): one mission or free-flight challenge per ISO week of the Istanbul calendar, the
// same for everyone, with its own leaderboard board `w-<yyyyww>-<base>` (base = the mission id or the free-flight board,
// e.g. w-202640-low-pass, w-202641-ff-bridge). The server keeps a weekly board a few weeks and then drops it (TTL,
// infra/leaderboard/lambda/validate.mjs). Pure functions: no DOM (tests/retention.test.mjs runs them in Node).
//
//   currentWeek(date?)        'YYYYWW' of the Istanbul day at `date`
//   weeklyPick(week)          → { week, key, kind: 'mission' | 'ff', mission? | ff?, map, base, board, spawn? }
//   addWeeks(week, n) · weekMonday(week) · weekLabel(week) · secondsToNextWeek(date?)
//
// The pool is a fixed rotation (week index modulo its length; its first entry in week 2026-40). Changing it changes the
// picks from then on, possibly the current week's: append new entries on a Monday, never mid-week. Free-flight entries
// name the start point the menu uses (the challenge is detected in free flight: src/missions/challenges.js) and are
// played with the menu's aircraft.
import { istanbulDay, secondsToNextDay, dayLabel } from '../missions/util.js';

const DAY = 86400e3;
const ymd = (day) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
const fmtDay = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const mondayOfWeek1 = (y) => { const jan4 = Date.UTC(y, 0, 4); return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY; };

/** ISO 8601 week 'YYYYWW' (Monday first; week 1 holds 4 January) of a day 'YYYYMMDD'. */
export function isoWeek(day) {
  const t = ymd(day);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const y = new Date(t + (3 - dow) * DAY).getUTCFullYear();   // the week belongs to the year of its Thursday
  const w = 1 + Math.round((t - dow * DAY - mondayOfWeek1(y)) / (7 * DAY));
  return `${y}${String(w).padStart(2, '0')}`;
}
/** A valid 'YYYYWW' or null. */
export function parseWeek(s) {
  const m = /^(\d{4})(\d{2})$/.exec(String(s || ''));
  if (!m || +m[1] < 2024 || +m[1] > 2100 || +m[2] < 1 || +m[2] > 53) return null;
  return isoWeek(weekMonday(s)) === s ? s : null;   // (week 53 only in long years)
}
/** 'YYYYMMDD' of the Monday of a week. */
export const weekMonday = (week) => fmtDay(mondayOfWeek1(+week.slice(0, 4)) + (+week.slice(4, 6) - 1) * 7 * DAY);
/** The week `n` weeks after (negative: before) `week`. */
export const addWeeks = (week, n) => isoWeek(fmtDay(ymd(weekMonday(week)) + n * 7 * DAY));
/** The Istanbul week at `date`. */
export const currentWeek = (date = new Date()) => isoWeek(istanbulDay(date));
/** Weeks since 29 December 2025 (the Monday of 2026's week 1). */
export const weekIndex = (week) => Math.round((ymd(weekMonday(week)) - Date.UTC(2025, 11, 29)) / (7 * DAY));
/** Seconds until the next Istanbul Monday 00:00 (the next weekly challenge). */
export function secondsToNextWeek(date = new Date()) {
  const dow = (new Date(ymd(istanbulDay(date))).getUTCDay() + 6) % 7;
  return secondsToNextDay(date) + (6 - dow) * 86400;
}
/** '40. hafta · 28 Eylül – 4 Ekim' / '39. hafta · 21–27 Eylül' */
export function weekLabel(week) {
  const mon = weekMonday(week), sun = fmtDay(ymd(mon) + 6 * DAY);
  const a = dayLabel(mon), b = dayLabel(sun);
  const range = a.split(' ')[1] === b.split(' ')[1] ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
  return `${+week.slice(4)}. hafta · ${range}`;
}
/** '3 gün 4 sa' / '5 sa 20 dk' / '12 dk' */
export function fmtLeft(sec) {
  const s = Math.max(0, Math.round(sec)), d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d} gün${h ? ` ${h} sa` : ''}`;
  if (h) return `${h} sa${m ? ` ${m} dk` : ''}`;
  return `${Math.max(1, m)} dk`;
}

// ------------------------------------------------------------------------------------------------------------ pool
// mission: a mission id (its default parameters: the weekly run is the plain mission, not the daily variation);
// ff + board: a free-flight challenge and its board, with the start point the menu picks. Alternates maps and kinds.
export const WEEKLY_POOL = [
  { mission: 'low-pass' },
  { ff: 'bridge', board: 'ff-bridge', spawn: 'AIR-GGB' },
  { mission: 'ist-bogaz-alcak', map: 'ist' },
  { mission: 'sfo-28r' },
  { mission: 'ist-15temmuz', map: 'ist' },
  { ff: 'land-series', board: 'ff-land-series', spawn: 'AIR-SFO-FINAL' },
  { mission: 'climb' },
  { mission: 'ist-halic', map: 'ist' },
  { mission: 'gg-under' },
  { mission: 'ist-ltfm-inis', map: 'ist' },
  { mission: 'bay-tour' },
  { ff: 'ist-bogazici', board: 'ff-ist-bogazici', map: 'ist', spawn: 'IST-AIR-BOGAZ' },
  { mission: 'alcatraz' },
  { mission: 'ist-kiz-kulesi-jet', map: 'ist' },
  { ff: 'ist-land-series', board: 'ff-ist-land-series', map: 'ist', spawn: 'IST-AIR-LTFM-FINAL' },
];

const ANCHOR = 39;   // weekIndex('202640'): the rotation starts with the pool's first entry that week
export const weeklyBoard = (week, base) => `w-${week}-${base}`;

/** The weekly challenge of a week. */
export function weeklyPick(week, pool = WEEKLY_POOL) {
  const n = pool.length;
  const i = weekIndex(week) - ANCHOR;
  const p = pool[((i % n) + n) % n];
  const base = p.ff ? p.board : p.mission;
  return { ...p, week, kind: p.ff ? 'ff' : 'mission', key: p.ff ? `ff:${p.ff}` : p.mission, map: p.map || 'sf', base, board: weeklyBoard(week, base) };
}

/** The current weekly pick when a finished run belongs to it: a mission run (not the daily variation) or a free-flight challenge. */
export function weeklyFor({ mission = null, ff = null, daily = null } = {}, date = new Date()) {
  const p = weeklyPick(currentWeek(date));
  if (mission && !daily && p.kind === 'mission' && p.mission === mission) return p;
  if (ff && p.kind === 'ff' && p.ff === ff) return p;
  return null;
}
