// W1: decoder of the cacheable terrain height files (built by tools/geo/terrain_heightfiles.py, format in its header and
// in assets/sf/terrain/README.md). hz/<L>/<gi>_<gj>.bin = deflated group of the 4 children of one node; every tile
// decodes to exactly the TILE_BYTES record of the h/<L>.bin level packs it was built from (same heights bit for bit).
// No three.js here, so tests/terrain.test.mjs runs it in Node against the packs.

export const NS = 67, NV = 65;                           // samples per edge (1 border), vertices per edge
export const WB = (NS * NS + 7) >> 3;                    // packbits(water)
export const TILE_BYTES = 8 + NS * NS * 2 + WB + NV * NV;

/** Inflated height file -> Map((dj << 8) | di -> byte offset of that tile's transformed record). */
export function parseHeightFile(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint16(0, true);
  let off = 4 + 2 * n;
  off += (4 - (off & 3)) & 3;
  if (n === 0 || buf.byteLength !== off + n * TILE_BYTES) throw new Error(`bad terrain height file (${n} tiles, ${buf.byteLength} bytes)`);
  const tiles = new Map();
  for (let k = 0; k < n; k++) tiles.set((dv.getUint8(5 + 2 * k) << 8) | dv.getUint8(4 + 2 * k), off + k * TILE_BYTES);
  return tiles;
}

/**
 * Transformed tile record at `off` of `src` (Uint8Array of an inflated height file) -> the original TILE_BYTES record
 * (new ArrayBuffer): f32 hmin, f32 scale | u16 heights (gradient-predictor residuals, zigzag, high/low byte planes) |
 * packbits water | u8 sunVis (gradient-predictor residuals mod 256).
 */
export function decodeTile(src, off) {
  const out = new ArrayBuffer(TILE_BYTES);
  const o8 = new Uint8Array(out);
  o8.set(src.subarray(off, off + 8), 0);
  const n = NS * NS, hi = off + 8, lo = hi + n;
  const v = new Uint16Array(out, 8, n);                  // stores wrap mod 2^16 like the encoder
  for (let y = 0, k = 0; y < NS; y++) {
    for (let x = 0; x < NS; x++, k++) {
      const z = (src[hi + k] << 8) | src[lo + k];
      const p = y === 0 ? (x === 0 ? 0 : v[k - 1]) : x === 0 ? v[k - NS] : v[k - 1] + v[k - NS] - v[k - NS - 1];
      v[k] = p + ((z >>> 1) ^ -(z & 1));
    }
  }
  const w = lo + n, so = 8 + 2 * n + WB, si = w + WB;
  o8.set(src.subarray(w, w + WB), 8 + 2 * n);
  for (let y = 0, k = 0; y < NV; y++) {
    for (let x = 0; x < NV; x++, k++) {
      const p = y === 0 ? (x === 0 ? 0 : o8[so + k - 1]) : x === 0 ? o8[so + k - NV] : o8[so + k - 1] + o8[so + k - NV] - o8[so + k - NV - 1];
      o8[so + k] = p + src[si + k];                      // Uint8Array store = mod 256
    }
  }
  return out;
}

/** Path of the height file holding tile (L, i, j) under the terrain folder, and the tile's key inside it. */
export function heightFileOf(hf, L, i, j) {
  const g = hf.group, gi = i >> g, gj = j >> g;
  return { path: `${hf.dir}/${L}/${gi}_${gj}.bin`, key: ((j - (gj << g)) << 8) | (i - (gi << g)) };
}
