// Small deterministic noise toolkit: seeded PRNG, 2D simplex noise, fBm, ridged
// multifractal, integer hashes and tileable value noise (for generated textures).
// Pure JS, no Three.js dependency (so it also runs in Node for offline checks).

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of two ints (+ seed) to a float in [0, 1). */
export function hash2(ix, iz, seed = 0) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Seeded 2D simplex noise. Returns noise2D(x, y) in roughly [-1, 1]. */
export function createNoise2D(seed = 1) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const perm12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; perm12[i] = perm[i] % 12; }

  return function noise2D(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm12[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm12[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm12[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
    }
    return 70 * n;
  };
}

/** Fractional Brownian motion: normalized to roughly [-1, 1]. */
export function fbm(noise, x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.13, y * f - o * 11.71);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal (Musgrave-style): sharp crests, smooth valleys. Returns [0, 1].
 * Each octave is weighted by the previous one so detail concentrates on the ridges.
 */
export function ridged(noise, x, y, octaves = 6, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1, weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * f + o * 31.7, y * f - o * 23.3));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 1.6));
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

/** Polynomial smooth minimum (k = blend radius in output units). */
export function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return lerp(b, a, h) - k * h * (1 - h);
}

/**
 * Tileable 2D value-noise fBm sampled on a size×size grid (period = size).
 * Returns a Float32Array in [0, 1]. `baseCells` = lattice cells across the tile for octave 0.
 */
export function tileableFbm(size, baseCells, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const s = seed + o * 101;
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const iy = Math.floor(fy);
      let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
      const y0 = iy % cells, y1 = (iy + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const ix = Math.floor(fx);
        let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const a = hash2(x0, y0, s), b = hash2(x1, y0, s);
        const c = hash2(x0, y1, s), d = hash2(x1, y1, s);
        const v = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
        out[y * size + x] += v * amp;
      }
    }
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
