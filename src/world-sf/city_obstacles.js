// W2 city: O(1) building obstacle queries for physics, camera and GPWS.
// Per 1 km tile (assets/sf/city/obst/<i>_<j>.bin.gz, gzip): 4 m raster of the tallest solid per cell (uint16 index+1)
// and a solids table (anchor x, anchor z, top above the anchor ground). Heights are resolved against the live terrain
// exactly like the rendered buildings are placed: top = terrain(anchor) + topRel.

import { assetData, isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';

const HEADER = 4 + 4 + 4 + 4 + 4 + 2 + 2;

async function gunzip(buf) {
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

export function createCityObstacles({ base, index, terrain }) {
  const size = index.size, cell = index.cell;
  const available = new Set(index.tiles);
  const tiles = new Map();      // key -> { solids, raster, n, x0, z0, ground }
  const pending = new Map();
  const retry = new Map();      // key -> { at, fails }: tiles whose download failed on a lost connection
  const lru = [];
  const MAX = 160;
  const getH = (x, z) => (terrain ? terrain.getHeight(x, z) : 0);

  function key(i, j) { return i + '_' + j; }

  function load(i, j) {
    const k = key(i, j);
    if (tiles.has(k) || pending.has(k) || !available.has(k)) return pending.get(k) || Promise.resolve();
    const rt = retry.get(k);
    if (rt && performance.now() < rt.at) return Promise.resolve();
    const p = assetData(`${base}${index.dir}/${k}.bin.gz`, 'arrayBuffer')
      .then(gunzip).then((buf) => {
        const dv = new DataView(buf);
        const n = dv.getUint32(12, true), w = dv.getUint16(20, true), h = dv.getUint16(22, true);
        const solids = new Float32Array(buf, HEADER, n * 3);
        const raster = new Uint16Array(buf.slice(HEADER + n * 12, HEADER + n * 12 + w * h * 2));
        const ground = new Float32Array(n).fill(NaN);
        tiles.set(k, { solids, raster, n, w, x0: i * size, z0: j * size, ground });
        lru.push(k);
        while (lru.length > MAX) tiles.delete(lru.shift());
        pending.delete(k);
        retry.delete(k);
      }).catch((e) => {
        pending.delete(k);
        // connection lost: query again after a delay (buildings collide again once it is back); missing tile: give up
        if (isNetworkError(e)) { const fails = (rt ? rt.fails : 0) + 1; retry.set(k, { at: performance.now() + retryDelay(fails), fails }); }
        else available.delete(k);
        reportLoadFailure('city', `obstacle tile ${k}`, e);
      });
    pending.set(k, p);
    return p;
  }

  function solidTop(t, s) {
    let g = t.ground[s];
    if (Number.isNaN(g)) g = t.ground[s] = getH(t.solids[s * 3], t.solids[s * 3 + 1]);
    return g + t.solids[s * 3 + 2];
  }

  function cellTop(x, z) {
    const i = Math.floor(x / size), j = Math.floor(z / size);
    const t = tiles.get(key(i, j));
    if (!t) { if (available.has(key(i, j))) load(i, j); return -Infinity; }
    const c = Math.floor((x - t.x0) / cell), r = Math.floor((z - t.z0) / cell);
    if (c < 0 || r < 0 || c >= t.w || r >= t.w) return -Infinity;
    const v = t.raster[r * t.w + c];
    return v ? solidTop(t, v - 1) : -Infinity;
  }

  return {
    load,
    /** Preload all obstacle tiles within radius r of (x, z). */
    preload(x, z, r) {
      const ps = [];
      for (let i = Math.floor((x - r) / size); i <= Math.floor((x + r) / size); i++)
        for (let j = Math.floor((z - r) / size); j <= Math.floor((z + r) / size); j++) ps.push(load(i, j));
      return Promise.all(ps);
    },
    heightAt: cellTop,
    hitTest(x, y, z, r) {
      const rr = Math.max(r, 0.5);
      const n = Math.ceil(rr / cell);
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const px = x + a * cell, pz = z + b * cell;
        if ((a * cell) ** 2 + (b * cell) ** 2 > (rr + cell) ** 2) continue;
        const top = cellTop(px, pz);
        if (top > y - rr) return 'bina';
      }
      return null;
    },
    get loadedCount() { return tiles.size; },
  };
}
