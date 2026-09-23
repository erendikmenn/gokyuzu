// W2 city: instanced trees (street trees, parks, forests, back yards, scrub) — 9 Blender species, 2 LODs each.
// Tree tiles (2 km, assets/sf/city/trees/<i>_<j>.bin) stream around the camera; each tile is binned into 250 m cells
// with precomputed instance matrices per species, so rebuilding the global per-species InstancedMeshes (LOD0 near,
// LOD1 far) is mostly bulk copies. Trees sit on ctx.terrain. heightAt/hitTest here are available for tools but the
// city layer does not report trees as obstacles (helicopters must be able to land next to / GPWS ignores canopy).
import * as THREE from 'three';
import { assetData, withRetry, isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';

const CELL = 250;
const DEF = { r0: 260, r1: 1900, rShrub: 650, tileRadius: 2300, maxPerSpecies: 40000, maxNearPerSpecies: 4000, frameBudgetMs: 2 };

export async function createCityTrees(ctx) {
  const opt = { ...DEF, ...(ctx.treeOptions || {}) };
  if (ctx.quality && ctx.quality.treeDensity != null && !(ctx.treeOptions || {}).maxPerSpecies) {
    // instance buffer capacity follows the preset (low 0.3 -> 16k per species); raising it live just caps the count
    opt.maxPerSpecies = Math.round(opt.maxPerSpecies * Math.min(1, Math.max(0.4, ctx.quality.treeDensity * (ctx.quality.treeDistance || 1) * 1.3)));
    opt.maxNearPerSpecies = Math.round(opt.maxNearPerSpecies * Math.min(1, Math.max(0.5, ctx.quality.treeDensity * 1.5)));
  }
  const { base, getH } = ctx;
  const meta = await assetData(ctx.indexUrl, 'json');
  const species = meta.species;
  const refH = meta.refHeight;
  const gltf = ctx.loader?.gltf || (await import('../core/assets.js')).createAssetLoader(ctx.renderer).gltf;
  const group = new THREE.Group();
  group.name = 'city_trees';

  // ---- species models ---------------------------------------------------------------------------------------------
  const models = await Promise.all(species.map(async (sp) => {
    const url = `${base}trees/${sp}.glb`;
    const g = await withRetry(() => gltf.loadAsync(url), url);
    const lods = [null, null];
    g.scene.traverse((o) => {
      if (!o.isMesh && !o.isGroup) return;
      const m = /_lod(\d)$/.exec(o.name);
      if (m) lods[Number(m[1])] = o;
    });
    const out = [];
    for (let l = 0; l < 2; l++) {
      const node = lods[l];
      const parts = [];
      node?.traverse((o) => { if (o.isMesh) parts.push(o); });
      // one InstancedMesh per (lod, material); the parts of a LOD share one instance matrix/colour buffer
      let shared = null;
      out.push(parts.map((p) => {
        p.updateWorldMatrix(true, false);
        const geo = p.geometry.clone().applyMatrix4(p.matrixWorld);
        const mat = p.material;
        mat.vertexColors = !!geo.getAttribute('color');
        if (mat.alphaTest > 0 || mat.transparent) { mat.transparent = false; mat.alphaTest = 0.45; mat.side = THREE.DoubleSide; }
        const cap = l === 0 ? opt.maxNearPerSpecies : opt.maxPerSpecies;
        if (!shared) {
          shared = { m: new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16), c: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3) };
          shared.m.setUsage(THREE.DynamicDrawUsage);
          shared.c.setUsage(THREE.DynamicDrawUsage);
        }
        const im = new THREE.InstancedMesh(geo, mat, 0);
        im.instanceMatrix = shared.m;
        im.instanceColor = shared.c;
        im.count = 0;
        im.frustumCulled = false;
        im.castShadow = l === 0;
        im.receiveShadow = true;
        im.name = `tree_${sp}_lod${l}`;
        group.add(im);
        return im;
      }));
    }
    return out;
  }));

  // ---- tiles ------------------------------------------------------------------------------------------------------
  const tiles = new Map();
  const avail = new Map(meta.tiles.map((t) => [`${t.i}_${t.j}`, t]));
  const size = meta.size;
  const nS = species.length;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let loading = 0;

  // Tile processing (terrain lookup + instance matrices for up to ~150k trees) runs as a generator, advanced in
  // update() under a per-frame time budget, so a forest tile never freezes a frame.
  const jobs = [];

  const fails = new Map();   // tile key -> failed downloads on a lost connection (retried with growing delays)
  async function loadTile(key) {
    const t = { state: 'loading', cells: [], key, lastUsed: performance.now() };
    tiles.set(key, t);
    loading++;
    try {
      const buf = await assetData(`${base}trees/${key}.bin`, 'arrayBuffer');
      t.state = 'processing';
      fails.delete(key);
      jobs.push({ t, it: processTile(t, buf) });
    } catch (e) {
      t.state = 'failed';
      if (isNetworkError(e)) { const n = (fails.get(key) || 0) + 1; fails.set(key, n); t.retryAt = performance.now() + retryDelay(n); }
      else avail.delete(key);   // missing tile: never asked again
      reportLoadFailure('city', `tree tile ${key}`, e);
    } finally {
      loading--;
    }
  }

  function* processTile(t, buf) {
    const dv = new DataView(buf);
    const n = dv.getUint32(12, true);
    const ti = dv.getInt32(4, true), tj = dv.getInt32(8, true);
    const x0 = ti * size, z0 = tj * size;
    const nc = Math.ceil(size / CELL);
    const bins = new Map();
    for (let k = 0; k < n; k++) {
      const o = 16 + k * 12;
      const x = dv.getFloat32(o, true), z = dv.getFloat32(o + 4, true);
      const s = dv.getUint8(o + 8), h = dv.getUint8(o + 9) / 4, r = dv.getUint8(o + 10), c = dv.getUint8(o + 11);
      const ci = Math.min(nc - 1, Math.max(0, Math.floor((x - x0) / CELL))), cj = Math.min(nc - 1, Math.max(0, Math.floor((z - z0) / CELL)));
      const bk = ci * nc + cj;
      let b = bins.get(bk);
      if (!b) { b = { x: x0 + (ci + 0.5) * CELL, z: z0 + (cj + 0.5) * CELL, list: [] }; bins.set(bk, b); }
      b.list.push(x, z, s, h, r, c);
      if ((k & 8191) === 8191) yield;
    }
    t.density = qual.density;
    for (const b0 of bins.values()) {
      // order the bin by a per-tree random rank (rotation byte) so treeDensity keeps the first n of every species;
      // only that subset is kept in memory (raising the density later reloads the tiles)
      const cnt0 = b0.list.length / 6;
      const cnt = qual.density >= 1 ? cnt0 : Math.max(1, Math.round(cnt0 * qual.density));
      const ord = new Uint32Array(cnt0).map((_, k) => k).sort((a, c) => b0.list[a * 6 + 4] - b0.list[c * 6 + 4]);
      const b = { x: b0.x, z: b0.z, list: new Float32Array(cnt * 6) };
      for (let k = 0; k < cnt; k++) for (let m = 0; m < 6; m++) b.list[k * 6 + m] = b0.list[ord[k] * 6 + m];
      const counts = new Uint32Array(nS);
      for (let k = 0; k < cnt; k++) counts[b.list[k * 6 + 2]]++;
      const mats = Array.from(counts, (c) => new Float32Array(c * 16));
      const cols = Array.from(counts, (c) => new Float32Array(c * 3));
      const pts = Array.from(counts, (c) => new Float32Array(c * 4));   // x, y, z, top
      const fill = new Uint32Array(nS);
      let yMin = Infinity, yMax = -Infinity;
      for (let k = 0; k < cnt; k++) {
        const x = b.list[k * 6], z = b.list[k * 6 + 1], s = b.list[k * 6 + 2], h = b.list[k * 6 + 3], r = b.list[k * 6 + 4], c = b.list[k * 6 + 5];
        const y = getH(x, z) - 0.15;
        const sc = h / refH[species[s]];
        pos.set(x, y, z);
        q.setFromAxisAngle(up, r / 255 * Math.PI * 2);
        const wobble = 0.9 + 0.2 * ((r * 7) % 13) / 13;
        scl.set(sc * wobble, sc, sc * (2 - wobble));
        m4.compose(pos, q, scl);
        const f = fill[s]++;
        m4.toArray(mats[s], f * 16);
        const v = 0.78 + 0.34 * (c / 255);
        col.setRGB(v * (0.94 + 0.12 * ((c * 5) % 17) / 17), v, v * (0.9 + 0.1 * ((c * 3) % 11) / 11));
        col.toArray(cols[s], f * 3);
        pts[s][f * 4] = x; pts[s][f * 4 + 1] = y; pts[s][f * 4 + 2] = z; pts[s][f * 4 + 3] = y + h;
        if (y < yMin) yMin = y;
        if (y + h > yMax) yMax = y + h;
        if ((k & 2047) === 2047) yield;
      }
      t.cells.push({ x: b.x, z: b.z, yMin, yMax, counts, mats, cols, pts, sphere: new THREE.Sphere(new THREE.Vector3(b.x, (yMin + yMax) / 2, b.z), Math.hypot(CELL * 0.71, (yMax - yMin) / 2 + 5)) });
      yield;
    }
    t.state = 'ready';
    dirty = true;
  }

  function processJobs(budgetMs) {
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < budgetMs) {
      const j = jobs[0];
      if (j.t.state !== 'processing' || j.it.next().done) jobs.shift();
    }
  }

  // ---- per-frame instance rebuild ---------------------------------------------------------------------------------
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  const camPos = new THREE.Vector3(), lastPos = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let dirty = true, timer = 0, streamTimer = 1, instances = 0;
  const qual = { density: 1, dist: 1, shadows: true };
  if (ctx.quality) {
    const q = ctx.quality;
    if (q.treeDensity != null) qual.density = Math.max(0, Math.min(1, q.treeDensity));
    if (q.treeDistance != null) qual.dist = Math.max(0.2, q.treeDistance);
    if (q.cityShadows != null) qual.shadows = !!q.cityShadows;
  }
  const counts0 = new Uint32Array(nS), counts1 = new Uint32Array(nS);

  function rebuild(camera) {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    counts0.fill(0); counts1.fill(0);
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;
    const R0 = opt.r0 * qual.dist, R1 = opt.r1 * qual.dist, RS = opt.rShrub * qual.dist;
    const r0sq = R0 * R0;
    for (const t of tiles.values()) {
      if (t.state !== 'ready') continue;
      for (const c of t.cells) {
        const dx = Math.max(0, Math.abs(c.x - cx) - CELL / 2), dz = Math.max(0, Math.abs(c.z - cz) - CELL / 2);
        const dy = Math.max(0, cy - c.yMax, c.yMin - cy);
        const d = Math.hypot(dx, dz, dy);
        if (d > R1) continue;
        if (!frustum.intersectsSphere(c.sphere)) continue;
        t.lastUsed = performance.now();
        for (let s = 0; s < nS; s++) {
          const rel = t.density ? Math.min(1, qual.density / t.density) : 1;
          const n = rel >= 1 ? c.counts[s] : Math.floor(c.counts[s] * rel + 0.5);
          if (!n) continue;
          const shrub = species[s] === 'shrub';
          if (shrub && d > RS) continue;
          if (d > R0) {
            // whole cell at LOD1: bulk copy (the first n instances = density subset)
            const im = models[s][1];
            const k = counts1[s];
            if (k + n > opt.maxPerSpecies) continue;
            if (im.length) { im[0].instanceMatrix.array.set(c.mats[s].subarray(0, n * 16), k * 16); im[0].instanceColor.array.set(c.cols[s].subarray(0, n * 3), k * 3); }
            counts1[s] = k + n;
          } else {
            const P = c.pts[s];
            for (let i = 0; i < n; i++) {
              const ex = P[i * 4] - cx, ey = P[i * 4 + 1] - cy, ez = P[i * 4 + 2] - cz;
              const near = ex * ex + ey * ey + ez * ez < r0sq;
              const lod = near ? 0 : 1;
              const cap = near ? opt.maxNearPerSpecies : opt.maxPerSpecies;
              const cnt = near ? counts0 : counts1;
              if (cnt[s] >= cap) continue;
              const m = models[s][lod][0];
              if (m) {
                m.instanceMatrix.array.set(c.mats[s].subarray(i * 16, i * 16 + 16), cnt[s] * 16);
                m.instanceColor.array.set(c.cols[s].subarray(i * 3, i * 3 + 3), cnt[s] * 3);
              }
              cnt[s]++;
            }
          }
        }
      }
    }
    instances = 0;
    for (let s = 0; s < nS; s++) {
      for (const [lod, cnt] of [[0, counts0[s]], [1, counts1[s]]]) {
        for (const m of models[s][lod]) {
          m.count = cnt;
          if (cnt) {
            m.instanceMatrix.clearUpdateRanges();
            m.instanceMatrix.addUpdateRange(0, cnt * 16);
            m.instanceMatrix.needsUpdate = true;
            m.instanceColor.clearUpdateRanges();
            m.instanceColor.addUpdateRange(0, cnt * 3);
            m.instanceColor.needsUpdate = true;
          }
        }
        instances += cnt;
      }
    }
  }

  function stream(x, z) {
    const R = opt.tileRadius * Math.max(qual.dist, 0.4);
    for (let i = Math.floor((x - R) / size); i <= Math.floor((x + R) / size); i++)
      for (let j = Math.floor((z - R) / size); j <= Math.floor((z + R) / size); j++) {
        const key = `${i}_${j}`;
        const old = tiles.get(key);
        if (old && old.state === 'failed' && performance.now() >= old.retryAt) tiles.delete(key);   // retry a failed download
        if (!avail.has(key) || tiles.has(key)) continue;
        const dx = Math.max(0, i * size - x, x - (i + 1) * size), dz = Math.max(0, j * size - z, z - (j + 1) * size);
        if (Math.hypot(dx, dz) > R) continue;
        if (loading < 3) loadTile(key);
      }
    // evict far tiles
    for (const [key, t] of tiles) {
      if (t.state !== 'ready' && t.state !== 'processing') continue;
      const [i, j] = key.split('_').map(Number);
      const dx = Math.max(0, i * size - x, x - (i + 1) * size), dz = Math.max(0, j * size - z, z - (j + 1) * size);
      if (Math.hypot(dx, dz) > R * 1.6) { t.state = 'evicted'; tiles.delete(key); dirty = true; }
    }
  }

  // initial tiles around the focus
  const f = ctx.focus || { x: 0, z: 0 };
  const initial = [];
  const R0 = 1500 * Math.min(1, qual.dist);
  for (let i = Math.floor((f.x - R0) / size); i <= Math.floor((f.x + R0) / size); i++)
    for (let j = Math.floor((f.z - R0) / size); j <= Math.floor((f.z + R0) / size); j++) {
      const key = `${i}_${j}`;
      if (avail.has(key)) initial.push(loadTile(key));
    }

  function treeTopAt(x, z, rad) {
    let best = -Infinity;
    const i = Math.floor(x / size), j = Math.floor(z / size);
    const t = tiles.get(`${i}_${j}`);
    if (!t || t.state !== 'ready') return best;
    for (const c of t.cells) {
      if (Math.abs(c.x - x) > CELL / 2 + 15 || Math.abs(c.z - z) > CELL / 2 + 15) continue;
      for (let s = 0; s < nS; s++) {
        const P = c.pts[s], n = c.counts[s];
        const cr = species[s] === 'shrub' ? 1.5 : (species[s].startsWith('palm') ? 2.5 : 4.5);
        for (let k = 0; k < n; k++) {
          const dx = P[k * 4] - x, dz = P[k * 4 + 2] - z;
          const rr = cr * (P[k * 4 + 3] - P[k * 4 + 1]) / refH[species[s]] + rad;
          if (dx * dx + dz * dz < rr * rr && P[k * 4 + 3] > best) best = P[k * 4 + 3];
        }
      }
    }
    return best;
  }

  return {
    object: group,
    ready: Promise.all(initial).then(async () => {
      while (jobs.length) { processJobs(20); await new Promise((r) => setTimeout(r, 0)); }
    }),
    get stats() { return { tiles: tiles.size, instances }; },
    update(dt, camera) {
      timer += dt;
      streamTimer += dt;
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(camDir);
      if (streamTimer > 0.4) { stream(camPos.x, camPos.z); streamTimer = 0; }
      processJobs(opt.frameBudgetMs);
      const moved = camPos.distanceToSquared(lastPos) > 12 * 12 || camDir.dot(lastDir) < 0.995;
      if ((moved && timer > 0.12) || (dirty && timer > 0.25) || timer > 1.0) {
        rebuild(camera);
        lastPos.copy(camPos);
        lastDir.copy(camDir);
        dirty = false;
        timer = 0;
      }
    },
    /** CONTRACTS-SF §8: treeDensity (fraction drawn), treeDistance (multiplier), cityShadows, anisotropy. */
    setQuality(q) {
      if (!q) return;
      if (q.treeDensity != null) {
        qual.density = Math.max(0, Math.min(1, q.treeDensity));
        // tiles hold only the subset they were built with: reload those that are now too sparse
        for (const [key, t] of tiles) if (t.density != null && t.density < qual.density) { t.state = 'evicted'; tiles.delete(key); }
        streamTimer = 1;
      }
      if (q.treeDistance != null) qual.dist = Math.max(0.2, q.treeDistance);
      if (q.cityShadows != null) qual.shadows = !!q.cityShadows;
      for (const sp of models) for (const m of sp[0]) m.castShadow = qual.shadows;
      if (q.anisotropy != null) {
        for (const sp of models) for (const lod of sp) for (const m of lod) {
          const map = m.material.map;
          if (map && map.anisotropy !== q.anisotropy) { map.anisotropy = q.anisotropy; map.needsUpdate = true; }
        }
      }
      dirty = true;
    },
    heightAt(x, z) { return treeTopAt(x, z, 0); },
    hitTest(x, y, z, r) {
      const top = treeTopAt(x, z, r);
      return top > y - r * 0.5 ? 'ağaç' : null;
    },
  };
}
