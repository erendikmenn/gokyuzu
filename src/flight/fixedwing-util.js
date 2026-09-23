// Shared helpers for the fixed-wing flight model (no DOM, no THREE): math, table lookup, units, Turkish text.

export const DEG = Math.PI / 180;
export const KT = 0.514444;          // m/s per knot
export const FT = 0.3048;            // m per foot
export const FPM = FT / 60;          // m/s per foot/minute
export const G0 = 9.80665;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const moveToward = (v, target, maxDelta) => (Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta);
export const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => { d = wrap360(d); return d > 180 ? d - 360 : d; };
/** Exponential smoothing factor for time constant tau over dt. */
export const expK = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** Piecewise-linear lookup in a {x:[], y:[]} table (clamped at the ends). A plain number is returned as is. */
export function interp1(tab, x) {
  if (typeof tab === 'number') return tab;
  const xs = tab.x, ys = tab.y, n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
}

/** Bilinear lookup in { alt: [], mach: [], v: [[...per mach] per alt] } (clamped). */
export function interp2(tab, alt, mach) {
  const A = tab.alt, M = tab.mach, V = tab.v;
  let i = 0, ta = 0;
  if (alt <= A[0]) { i = 0; ta = 0; } else if (alt >= A[A.length - 1]) { i = A.length - 2; ta = 1; } else {
    while (A[i + 1] < alt) i++;
    ta = (alt - A[i]) / (A[i + 1] - A[i]);
  }
  let j = 0, tm = 0;
  if (mach <= M[0]) { j = 0; tm = 0; } else if (mach >= M[M.length - 1]) { j = M.length - 2; tm = 1; } else {
    while (M[j + 1] < mach) j++;
    tm = (mach - M[j]) / (M[j + 1] - M[j]);
  }
  if (A.length === 1) { const r = V[0]; return r[j] + (r[j + 1] - r[j]) * tm; }
  const r0 = V[i], r1 = V[i + 1];
  const a = r0[j] + (r0[j + 1] - r0[j]) * tm;
  const b = r1[j] + (r1[j + 1] - r1[j]) * tm;
  return a + (b - a) * ta;
}

// ---------------------------------------------------------------------------------------------
// Turkish: dative case for obstacle names ("Golden Gate Köprüsü" -> "Golden Gate Köprüsü'ne", "bina" -> "binaya").
const BACK = 'aıou', FRONT = 'eiöü', VOWELS = 'aıoueiöüâîû';
const lastVowel = (w) => { for (let i = w.length - 1; i >= 0; i--) if (VOWELS.includes(w[i])) return w[i]; return 'e'; };
export function turkishDative(name) {
  const s = String(name || '').trim();
  if (!s) return 'bir engele';
  const words = s.split(/\s+/);
  const last = words[words.length - 1].toLocaleLowerCase('tr');
  const proper = /^[A-ZÇĞİÖŞÜ0-9]/.test(s);
  const v = lastVowel(last);
  const a = BACK.includes(v) ? 'a' : FRONT.includes(v) ? 'e' : 'e';
  const endsVowel = VOWELS.includes(last[last.length - 1]);
  // compound nouns with the possessive suffix (Köprüsü, Kulesi, Piramidi) take -ne/-na
  const compound = words.length > 1 && /(s[ıiuü]|[ıiuü])$/.test(last) && endsVowel;
  let suffix;
  if (compound) suffix = 'n' + a;
  else if (endsVowel) suffix = 'y' + a;
  else suffix = a;
  return proper ? `${s}'${suffix}` : `${s}${suffix}`;
}
