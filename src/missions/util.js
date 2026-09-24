// Small helpers shared by the mission modules (no DOM, no three.js: the catalog, the daily pick and the landing score
// also run in Node for tests/missions.test.mjs).

export const DEG = Math.PI / 180;
export const KT = 0.514444;        // m/s per knot
export const FT = 0.3048;          // m per foot
export const FPM = 196.8504;       // ft/min per m/s
export const NM = 1852;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;
export const wrap360 = (d) => ((d % 360) + 360) % 360;
/** Linear score 1 at `good` or better, 0 at `bad` or worse (either direction). */
export const band = (v, good, bad) => clamp((bad - v) / (bad - good), 0, 1);

/** Unit direction (dx, dz) of a true heading in degrees (0 = north = -Z, 90 = east = +X). */
export function dirOf(hdgDeg, out = { dx: 0, dz: 0 }) {
  const h = hdgDeg * DEG;
  out.dx = Math.sin(h); out.dz = -Math.cos(h);
  return out;
}
/** True bearing in degrees from (x0, z0) to (x1, z1). */
export const bearing = (x0, z0, x1, z1) => wrap360(Math.atan2(x1 - x0, -(z1 - z0)) / DEG);

/** 32-bit FNV-1a hash of a string. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Deterministic PRNG (mulberry32) → () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the game's day: Europe/Istanbul (UTC+3 all year since 2016; Intl keeps it right if that ever changes) ----
let istFmt = null;
function istanbulParts(date) {
  try {
    istFmt ||= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = {};
    for (const x of istFmt.formatToParts(date)) p[x.type] = x.value;
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  } catch {   // no time zone data: fixed UTC+3
    const t = new Date(date.getTime() + 3 * 3600e3);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
  }
}
/** 'YYYYMMDD' of the Istanbul calendar day at `date`. */
export function istanbulDay(date = new Date()) {
  const p = istanbulParts(date);
  return `${p.y}${String(p.mo).padStart(2, '0')}${String(p.d).padStart(2, '0')}`;
}
/** Seconds until the next Istanbul midnight (the next daily mission). */
export function secondsToNextDay(date = new Date()) {
  const p = istanbulParts(date);
  return Math.max(1, 86400 - (p.h * 3600 + p.mi * 60 + p.s));
}
/** A valid 'YYYYMMDD' string or null. */
export function parseDay(s) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2024 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}
/** '24 Eylül' from 'YYYYMMDD'. */
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const dayLabel = (day) => (day && day.length === 8 ? `${+day.slice(6)} ${MONTHS[+day.slice(4, 6) - 1] || ''}` : '');

/** 'm:ss' */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** 'hh:mm:ss' */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** Turkish thousands separator. */
export const fmtInt = (v) => { const n = Math.round(v); const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return n < 0 ? `−${s}` : s; };
/** '1,2 km' / '850 m' */
export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (m >= 9950) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 10) * 10} m`;
}

/**
 * Mission start spec (catalog) → { x, z, heading (rad), altitude?, speed? (m/s), opts }. ends = runwayEnds(runways):
 * a take-off start stands 45 m down the runway from the pavement end (px / pz), a final start `dist` m before the landing
 * threshold (x / z: displaced thresholds included) on the 3° path aimed 300 m past it.
 */
export function resolveStart(start, ends) {
  if (start.runway || start.final) {
    const e = ends.find((r) => r.name === (start.runway || start.final));
    if (!e) throw new Error(`mission start: runway ${start.runway || start.final} not found`);
    if (start.runway) return { x: (e.px ?? e.x) + e.dx * 45, z: (e.pz ?? e.z) + e.dz * 45, heading: e.course, opts: {} };
    const d = start.dist || 8000;
    return { x: e.x - e.dx * d, z: e.z - e.dz * d, heading: e.course, altitude: e.elevation + (d + 300) * Math.tan(3 * DEG), opts: {} };
  }
  const opts = {};
  if (start.gear != null) opts.gearDown = !!start.gear;
  if (start.flaps != null) opts.flapIndex = start.flaps;
  return { x: start.x, z: start.z, heading: start.hdg * DEG, altitude: start.alt, speed: start.kt * KT, opts };
}
