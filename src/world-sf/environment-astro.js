// Time & weather: sun and moon positions for the San Francisco Bay (low-precision ephemerides, ~0.01° sun, ~0.3° moon)
// and the equatorial → local rotation for the star field. Pure math, no three.js objects are created per call.
//
// Local frame (CONTRACTS-SF.md §1): +X east, -Z north, +Y up. UTM grid north differs from true north by the meridian
// convergence (≈ 0.38° at SFO, zone 10 central meridian -123°), applied so bearings match the terrain.

const D2R = Math.PI / 180;
export const SITE = { lat: 37.62, lon: -122.38 };
// grid convergence gamma = atan(tan(lon - lon0) * sin(lat)); a true azimuth A has grid azimuth A - gamma
const GAMMA = Math.atan(Math.tan((SITE.lon + 123) * D2R) * Math.sin(SITE.lat * D2R));

/**
 * The simulated date. Summer (PDT, UTC-7): 06:30 is sunrise glow, 19:45 golden hour, 22:00 night with a waxing
 * gibbous moon in the south over the bay. `?date=YYYY-MM-DD` overrides it (the offset stays -7 h).
 */
export const DEFAULT_DATE = { y: 2026, m: 7, d: 25, utcOffset: -7 };

/** Local time used when neither the menu nor ?time= chose one (late afternoon, close to the original fixed sun). */
export const DEFAULT_TIME = 18.25;
/** Quick picks for the menu / pause screen (Turkish labels). */
export const TIME_PRESETS = [
  { id: 'dawn', label: 'Şafak', hours: 6.5 },
  { id: 'noon', label: 'Öğle', hours: 12 },
  { id: 'afternoon', label: 'İkindi', hours: 18.25 },
  { id: 'golden', label: 'Akşam', hours: 19.75 },
  { id: 'night', label: 'Gece', hours: 22 },
];

export function parseDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d, utcOffset: DEFAULT_DATE.utcOffset };
}

/** '21:30' | '21.5' | 21.5 → hours 0..24, or null. */
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? ((v % 24) + 24) % 24 : null;
  const s = String(v).trim();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 24 || mi > 59) return null;
    return ((h + mi / 60) % 24 + 24) % 24;
  }
  const f = Number(s);
  return Number.isFinite(f) ? ((f % 24) + 24) % 24 : null;
}

export function formatTime(h) {
  const t = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function julianDay(y, m, d, hUT) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + hUT / 24;
}

function sunEquatorial(jd) {
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  return { ra: Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec: Math.asin(Math.sin(eps) * Math.sin(lam)) };
}

function moonEquatorial(jd) {
  const T = (jd - 2451545.0) / 36525;
  const Lp = 218.316 + 481267.881 * T, M = 134.963 + 477198.867 * T, F = 93.272 + 483202.018 * T;
  const Ms = 357.529 + 35999.050 * T, Dd = 297.850 + 445267.111 * T;
  const s = (x) => Math.sin(x * D2R);
  const lam = (Lp + 6.289 * s(M) + 1.274 * s(2 * Dd - M) + 0.658 * s(2 * Dd) + 0.214 * s(2 * M) - 0.186 * s(Ms) - 0.114 * s(2 * F)) * D2R;
  const beta = (5.128 * s(F) + 0.281 * s(M + F) + 0.278 * s(M - F)) * D2R;
  const eps = 23.439 * D2R;
  const x = Math.cos(beta) * Math.cos(lam);
  const y = Math.cos(eps) * Math.cos(beta) * Math.sin(lam) - Math.sin(eps) * Math.sin(beta);
  const z = Math.sin(eps) * Math.cos(beta) * Math.sin(lam) + Math.cos(eps) * Math.sin(beta);
  return { ra: Math.atan2(y, x), dec: Math.asin(z) };
}

/** Local sidereal time (rad) at the site. */
function lst(jd) {
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
  return (((gmst + SITE.lon) % 360) + 360) % 360 * D2R;
}

/** Equatorial (ra, dec) → local world direction (x east, y up, z south) written into out {x,y,z}. */
function toLocal(ra, dec, L, out) {
  const lat = SITE.lat * D2R;
  const H = L - ra;
  const E = -Math.cos(dec) * Math.sin(H);
  const N = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H);
  const U = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  // rotate true north → grid north (clockwise by -GAMMA)
  const c = Math.cos(GAMMA), s = Math.sin(GAMMA);
  const Eg = E * c + N * s, Ng = -E * s + N * c;
  out.x = Eg; out.y = U; out.z = -Ng;
  return out;
}

/**
 * Sun + moon for a local clock time (hours) on the given date.
 * Returns { sun: {x,y,z}, moon: {x,y,z}, moonIllum (0..1 lit fraction), sunElDeg, moonElDeg, lst (rad),
 *           starMatrix: number[9] (column-major 3x3: equatorial J2000 unit vector → local world direction) }.
 */
export function skyAt(hoursLocal, date = DEFAULT_DATE, out = null) {
  const o = out || { sun: { x: 0, y: 1, z: 0 }, moon: { x: 0, y: 1, z: 0 }, moonIllum: 0, sunElDeg: 0, moonElDeg: 0, lst: 0, starMatrix: new Array(9).fill(0) };
  const jd = julianDay(date.y, date.m, date.d, hoursLocal - date.utcOffset);
  const L = lst(jd);
  const se = sunEquatorial(jd), me = moonEquatorial(jd);
  toLocal(se.ra, se.dec, L, o.sun);
  toLocal(me.ra, me.dec, L, o.moon);
  const cosE = Math.sin(me.dec) * Math.sin(se.dec) + Math.cos(me.dec) * Math.cos(se.dec) * Math.cos(me.ra - se.ra);
  o.moonIllum = (1 - cosE) / 2;
  o.sunElDeg = Math.asin(Math.max(-1, Math.min(1, o.sun.y))) / D2R;
  o.moonElDeg = Math.asin(Math.max(-1, Math.min(1, o.moon.y))) / D2R;
  o.lst = L;
  // columns = images of the equatorial basis vectors (ra 0 dec 0, ra 90° dec 0, north celestial pole)
  const v = { x: 0, y: 0, z: 0 };
  const cols = [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]];
  for (let k = 0; k < 3; k++) {
    toLocal(cols[k][0], cols[k][1], L, v);
    o.starMatrix[k * 3] = v.x; o.starMatrix[k * 3 + 1] = v.y; o.starMatrix[k * 3 + 2] = v.z;
  }
  return o;
}
