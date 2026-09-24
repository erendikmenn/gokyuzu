// High-zoom detail layer for the navigation map: the terrain's imagery pyramid (assets/<map>/terrain/img/<L>/i_j.webp,
// the same files the 3D terrain streams, so they usually come from the HTTP cache), restyled like the baked minimap
// image (src/ui/tools/bake_bay_map.py: desaturated, darkened, cool tint) with canvas blend modes, water left transparent
// so the base map's navy water and shelf show through. Tile existence comes from world.terrain.nodes (the terrain
// quadtree); without it the layer stays empty and the base map alone is drawn.
import { assetData } from '../core/assets.js';
import { activeMap } from '../maps/index.js';

const KEY = (L, i, j) => L * 1048576 + i * 1024 + j;   // src/world-sf/terrain.js node key
const MAX_TILES = 72;                                   // processed 512² canvases kept (≈ 1 MB each)
const MAX_INFLIGHT = 4;

export function createDetailTiles() {
  let nodes = null, root = null;
  const cache = new Map();          // key → { state: 'load' | 'ready' | 'fail', canvas, used, L, x0, z0, size }
  let inflight = 0, frame = 0;
  const want = [];                  // requests of this frame (reused): [key, prio, …]

  function setWorld(world) {
    const t = world && world.terrain;
    if (!t || !t.nodes || typeof t.nodes.get !== 'function' || nodes === t.nodes) return;
    nodes = t.nodes;
    root = nodes.get(KEY(0, 0, 0)) || null;
  }
  const available = () => !!(nodes && root);

  function style(bmp) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    // desaturate 58 %, darken with the bake's cool tint (0.78 / 0.84 / 0.92 × 0.62), then restore the land mask
    g.globalCompositeOperation = 'saturation'; g.fillStyle = 'rgba(128,128,128,0.58)'; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(123,133,146)'; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(bmp, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (bmp.close) bmp.close();
    return c;
  }

  function load(n) {
    const key = KEY(n.L, n.i, n.j);
    const e = { state: 'load', canvas: null, used: frame, L: n.L, x0: n.x0, z0: n.z0, size: n.size };
    cache.set(key, e);
    inflight++;
    assetData(new URL(`../../${activeMap().assets}terrain/img/${n.L}/${n.i}_${n.j}.webp`, import.meta.url).href, 'blob')
      .then((b) => createImageBitmap(b))
      .then((bmp) => { e.canvas = style(bmp); e.state = 'ready'; })
      .catch(() => { e.state = 'fail'; })
      .finally(() => { inflight--; });
  }

  function evict() {
    if (cache.size <= MAX_TILES) return;
    const list = [...cache.entries()].filter(([, e]) => e.state !== 'load').sort((a, b) => a[1].used - b[1].used);
    for (let k = 0; k < list.length && cache.size > MAX_TILES; k++) {
      const [key, e] = list[k];
      if (e.used === frame) break;
      if (e.canvas) { e.canvas.width = 0; e.canvas.height = 0; }
      cache.delete(key);
    }
  }

  /**
   * Draw the detail tiles over the view (world rect x0..x1, z0..z1) at the level matching `mpp` (meters per device
   * pixel) and request the missing ones. X / Y project world → CSS px, s = CSS px per meter. Returns true while tiles
   * are still loading (the map keeps redrawing). onlyLevel: draw just that level (the coarse layer under the base map,
   * which continues the land past the baked map's edges).
   */
  function draw(ctx, x0, z0, x1, z1, X, Y, s, mpp, onlyLevel = 0) {
    if (!onlyLevel) frame++;
    if (!available() || (!onlyLevel && mpp > 15)) return false;
    const Lwant = onlyLevel || Math.max(4, Math.min(8, Math.ceil(Math.log2(256 / (1.25 * mpp)))));
    const R = root.size, RX = root.x0, RZ = root.z0;
    want.length = 0;
    // coarser loaded levels first (no holes while the wanted level streams), then the wanted level
    for (let L = onlyLevel || Math.max(4, Lwant - 2); L <= Lwant; L++) {
      const size = R / (1 << L);
      const i0 = Math.floor((x0 - RX) / size), i1 = Math.floor((x1 - RX) / size);
      const j0 = Math.floor((z0 - RZ) / size), j1 = Math.floor((z1 - RZ) / size);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) continue;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const key = KEY(L, i, j);
        const e = cache.get(key);
        if (e && e.state === 'ready') {
          e.used = frame;
          const px = X(e.x0), py = Y(e.z0), w = e.size * s;
          ctx.drawImage(e.canvas, px, py, w + 0.5, w + 0.5);
        } else if (!e && L === Lwant) {
          const n = nodes.get(key);
          if (n && n.img) want.push(key, Math.hypot(RX + (i + 0.5) * size - (x0 + x1) / 2, RZ + (j + 0.5) * size - (z0 + z1) / 2));
          else if (n || L > 4) {
            // no image at this level: its parent's (the terrain uses the nearest ancestor's image too)
            const p = nodes.get(KEY(L - 1, i >> 1, j >> 1));
            const pk = KEY(L - 1, i >> 1, j >> 1);
            if (p && p.img && !cache.has(pk)) want.push(pk, 1e9);
          }
        } else if (e) e.used = frame;
      }
    }
    // nearest first
    let loading = inflight > 0;
    while (inflight < MAX_INFLIGHT && want.length) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < want.length; k += 2) if (want[k + 1] < bd && !cache.has(want[k])) { bd = want[k + 1]; best = k; }
      if (best < 0) break;
      const key = want[best];
      want.splice(best, 2);
      const L = Math.floor(key / 1048576), i = Math.floor((key % 1048576) / 1024), j = key % 1024;
      const n = nodes.get(KEY(L, i, j));
      if (n) { load(n); loading = true; }
    }
    evict();
    return loading || want.length > 0;
  }

  return { setWorld, draw, get available() { return available(); } };
}
