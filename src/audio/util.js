// Small math helpers shared by the audio system and the aircraft sound profiles (no allocations).
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const db = (d) => Math.pow(10, d / 20);
/** Linear map x∈[x0,x1] → [y0,y1], clamped. */
export const lin = (x, x0, x1, y0 = 0, y1 = 1) => y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0));
/** Linear map in dB, returned as a gain factor. */
export const linDb = (x, x0, x1, d0, d1) => db(lin(x, x0, x1, d0, d1));
export const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Smooth bump: 0 outside [a,d], 1 in [b,c]. */
export const band = (x, a, b, c, d) => sstep(a, b, x) * (1 - sstep(c, d, x));

/**
 * Equal-power crossfade weight of loop `i` among loops recorded at reference values `refs` (ascending),
 * for the current value x. Weights of neighbours sum in power to 1.
 */
export function xfade(x, refs, i) {
  const n = refs.length;
  if (n === 1) return 1;
  if (x <= refs[0]) return i === 0 ? 1 : 0;
  if (x >= refs[n - 1]) return i === n - 1 ? 1 : 0;
  let k = 0;
  while (k < n - 2 && x > refs[k + 1]) k++;
  const t = (x - refs[k]) / (refs[k + 1] - refs[k]);
  if (i === k) return Math.cos(t * Math.PI / 2);
  if (i === k + 1) return Math.sin(t * Math.PI / 2);
  return 0;
}
