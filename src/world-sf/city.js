// W2 city layer: San Francisco + Bay Area buildings (DataSF LiDAR footprints + OSM, meshes built in Blender) and trees.
// Streams four LOD levels (L0 500 m tiles with full detail < 1.3 km, L1 1 km simplified < 3.6 km, L2 2 km merged
// blocks < 8 km, L3 2 km tall blocks only beyond) chosen per 2 km cell by camera distance, swaps a cell's level only
// once every tile of the new level is loaded (no holes), drops every building onto the live terrain
// (ctx.terrain.getHeight) and answers heightAt / hitTest from 4 m building obstacle rasters (trees are not obstacles).
import * as THREE from 'three';
import { createCityMaterial, prepareCityGeometry } from './city_material.js';
import { createCityObstacles } from './city_obstacles.js';
import { createCityTrees } from './city_trees.js';

const BASE = 'assets/sf/city/';
const DEFAULTS = { r0: 1300, r1: 3600, r2: 8000, rMax: 26000, maxLoads: 4, unloadAfter: 20, frameBudgetMs: 3, uploadsPerFrame: 1, warmUpload: true, lodScale: 1 };

export async function createCity(ctx, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const base = options.base || BASE;
  const { terrain, focus = { x: 0, z: 0 } } = ctx;
  const getH = (x, z) => (terrain ? terrain.getHeight(x, z) : 0);
  const index = await (await fetch(base + 'index.json')).json();
  const { material, materialFar, uniforms } = await createCityMaterial(ctx.renderer, base + 'atlas/');
  const gltf = ctx.loader?.gltf || (await import('../core/assets.js')).createAssetLoader(ctx.renderer).gltf;

  const group = new THREE.Group();
  group.name = 'city';
  const buildings = new THREE.Group();
  buildings.name = 'city_buildings';
  group.add(buildings);

  // ---- tile registry ------------------------------------------------------------------------------------------
  const levels = index.levels.map((l) => ({ ...l, map: new Map() }));
  const cells = new Map();   // L2 cell key -> { i, j, bounds, l2, kids: [{ key, l1, l0: [...] }], display, want }
  const tkey = (i, j) => i + '_' + j;
  const cellOf = (i, j, lvl) => { const f = lvl === 0 ? 4 : lvl === 1 ? 2 : 1; return [Math.floor(i / f), Math.floor(j / f)]; };
  for (const L of levels) {
    for (const t of L.tiles) {
      const rec = { ...t, level: L.level, dir: L.dir, placement: L.placement, state: 'none', mesh: null, lastUsed: 0 };
      L.map.set(tkey(t.i, t.j), rec);
      const [ci, cj] = cellOf(t.i, t.j, L.level);
      const ck = tkey(ci, cj);
      let c = cells.get(ck);
      if (!c) {
        c = { i: ci, j: cj, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: 0, display: null, displayKey: '' };
        cells.set(ck, c);
      }
      c.minX = Math.min(c.minX, t.minX); c.maxX = Math.max(c.maxX, t.maxX);
      c.minZ = Math.min(c.minZ, t.minZ); c.maxZ = Math.max(c.maxZ, t.maxZ); c.maxY = Math.max(c.maxY, t.maxY);
    }
  }
  const lvlMap = (n) => (levels.find((l) => l.level === n) || { map: new Map() }).map;
  const L0 = lvlMap(0), L1 = lvlMap(1), L2 = lvlMap(2), L3 = lvlMap(3);

  function dist(cam, b) {
    const dx = Math.max(b.minX - cam.x, 0, cam.x - b.maxX);
    const dz = Math.max(b.minZ - cam.z, 0, cam.z - b.maxZ);
    const dy = Math.max(0, cam.y - (b.maxY + 150));
    return Math.hypot(dx, dz, dy);
  }

  // ---- loading ----------------------------------------------------------------------------------------------------
  const queue = [];
  let active = 0;
  const loadedTiles = new Set();

  function request(rec, prio) {
    if (rec.state !== 'none') return;
    rec.state = 'queued';
    rec.prio = prio;
    queue.push(rec);
  }

  // Loaded GLBs go through a per-frame time-budgeted pipeline so streaming never stalls a frame:
  //   'place'  terrain placement of the vertices in slices (≈ 8k vertices per slice, budget opt.frameBudgetMs)
  //   'upload' GPU upload of the finished tile, one tile per frame, by drawing it into a 1x1 render target
  const jobs = [];
  const warm = { scene: new THREE.Scene(), target: new THREE.WebGLRenderTarget(1, 1), camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  warm.scene.matrixWorldAutoUpdate = false;

  function pump() {
    if (!queue.length || active >= opt.maxLoads) return;
    queue.sort((a, b) => a.prio - b.prio);
    while (queue.length && active < opt.maxLoads) {
      const rec = queue.shift();
      active++;
      gltf.loadAsync(`${base}${rec.dir}/${rec.i}_${rec.j}.glb`).then((g) => {
        let mesh = null;
        g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
        if (!mesh) throw new Error('no mesh');
        mesh.updateWorldMatrix(true, false);
        mesh.removeFromParent();
        prepareCityGeometry(mesh.geometry);
        jobs.push({ rec, mesh, cx: mesh.position.x, cz: mesh.position.z, v: 0, phase: 'place', lastA: NaN, lastB: NaN, lastG: 0 });
        rec.state = 'processing';
      }).catch((e) => {
        console.warn('[city] tile failed', rec.dir, rec.i, rec.j, e.message);
        rec.state = 'failed';
      }).finally(() => { active--; });
    }
  }

  /** Place a slice of vertices on the terrain; returns true when the tile is done. */
  function placeSlice(job, count) {
    const geo = job.mesh.geometry;
    const pos = geo.getAttribute('position');
    const P = pos.array, n = pos.count;
    const anc = geo.getAttribute('uv1');
    const { cx, cz } = job;
    const end = Math.min(n, job.v + count);
    if (job.rec.placement === 'anchor' && anc) {
      const A = anc.array;
      for (let v = job.v; v < end; v++) {
        const a = A[v * 2], b = A[v * 2 + 1];
        let g = job.lastG;
        if (a !== job.lastA || b !== job.lastB) { g = getH(a + cx, b + cz); job.lastA = a; job.lastB = b; job.lastG = g; }
        const y = P[v * 3 + 1];
        if (y < 0.05) {
          const gv = getH(P[v * 3] + cx, P[v * 3 + 2] + cz);
          P[v * 3 + 1] = (gv < g ? gv : g) - 1.5;
        } else {
          P[v * 3 + 1] = y + g;
        }
      }
    } else {
      for (let v = job.v; v < end; v++) {
        const g = getH(P[v * 3] + cx, P[v * 3 + 2] + cz);
        const y = P[v * 3 + 1];
        P[v * 3 + 1] = y < 0.05 ? g - 2.0 : y + g;
      }
    }
    job.v = end;
    if (end < n) return false;
    if (anc) geo.deleteAttribute('uv1');
    pos.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return true;
  }

  function finish(job) {
    const { rec, mesh } = job;
    mesh.material = rec.level === 0 ? material : materialFar;
    mesh.castShadow = rec.level === 0;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.name = `city_L${rec.level}_${rec.i}_${rec.j}`;
    // GPU upload now (1x1 target, frustum culling off) instead of in the frame where the LOD swap reveals the tile
    if (ctx.renderer && opt.warmUpload) {
      const r = ctx.renderer, prev = r.getRenderTarget(), prevAuto = r.shadowMap.autoUpdate;
      mesh.frustumCulled = false;
      warm.scene.add(mesh);
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(warm.target);
      r.render(warm.scene, warm.camera);
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = prevAuto;
      warm.scene.remove(mesh);
      mesh.frustumCulled = true;
    }
    mesh.visible = false;
    buildings.add(mesh);
    rec.mesh = mesh;
    rec.state = 'ready';
    loadedTiles.add(rec);
  }

  function processJobs(budgetMs, maxUploads = opt.uploadsPerFrame) {
    const t0 = performance.now();
    let uploads = 0;
    while (jobs.length && performance.now() - t0 < budgetMs) {
      const job = jobs[0];
      if (job.rec.state !== 'processing') { jobs.shift(); continue; }
      if (job.phase === 'place') {
        if (placeSlice(job, 8192)) job.phase = 'upload';
        continue;
      }
      if (uploads >= maxUploads) break;
      finish(jobs.shift());
      uploads++;
    }
  }

  function unload(rec) {
    if (rec.state === 'processing') {
      const k = jobs.findIndex((j) => j.rec === rec);
      if (k >= 0) { jobs[k].mesh.geometry.dispose(); jobs.splice(k, 1); }
    }
    if (rec.mesh) {
      rec.mesh.removeFromParent();
      rec.mesh.geometry.dispose();
      rec.mesh = null;
    }
    rec.state = 'none';
    loadedTiles.delete(rec);
  }

  // ---- LOD selection per 2 km cell ------------------------------------------------------------------------------
  const camPos = new THREE.Vector3();
  let clock = 0, lastSelect = -1;
  const lastCam = new THREE.Vector3(1e9, 0, 0);

  function wanted(c, cam) {
    const d = dist(cam, c) / opt.lodScale;
    if (d > opt.rMax) return { key: 'none', tiles: [] };
    if (d > opt.r2 && L3.size) {
      const t = L3.get(tkey(c.i, c.j));
      return { key: 'L3', tiles: t ? [t] : [] };
    }
    if (d > opt.r1) {
      const t = L2.get(tkey(c.i, c.j));
      return { key: 'L2', tiles: t ? [t] : [] };
    }
    const tiles = [];
    let key = 'S';
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const i1 = c.i * 2 + a, j1 = c.j * 2 + b;
      const t1 = L1.get(tkey(i1, j1));
      const bb = t1 || { minX: i1 * 1000, maxX: i1 * 1000 + 1000, minZ: j1 * 1000, maxZ: j1 * 1000 + 1000, maxY: 50 };
      if (dist(cam, bb) / opt.lodScale > opt.r0) {
        key += '1';
        if (t1) tiles.push(t1);
      } else {
        key += '0';
        for (let s = 0; s < 4; s++) {
          const t0 = L0.get(tkey(i1 * 2 + (s & 1), j1 * 2 + (s >> 1)));
          if (t0) tiles.push(t0);
        }
      }
    }
    return { key, tiles };
  }

  function select(cam) {
    const now = clock;
    for (const c of cells.values()) {
      const w = wanted(c, cam);
      const d = dist(cam, c);
      let allReady = true;
      for (const t of w.tiles) {
        t.lastUsed = now;
        if (t.state !== 'ready' && t.state !== 'failed') {
          allReady = false;
          if (t.state === 'processing') continue;
          request(t, dist(cam, t) + (t.level >= 2 ? 2000 : 0));
        }
      }
      if (allReady && w.key !== c.displayKey) {
        if (c.display) for (const t of c.display) if (t.mesh) t.mesh.visible = false;
        c.display = w.tiles;
        c.displayKey = w.key;
        for (const t of c.display) if (t.mesh) t.mesh.visible = true;
      }
      if (c.display) for (const t of c.display) t.lastUsed = now;
      c.dist = d;
    }
    // evict tiles unused for a while (L2 tiles are small: keep them)
    for (const rec of [...loadedTiles]) {
      if (rec.level < 2 && now - rec.lastUsed > opt.unloadAfter) unload(rec);
    }
    // drop queued requests that are no longer wanted
    for (let k = queue.length - 1; k >= 0; k--) {
      if (now - queue[k].lastUsed > 2) { queue[k].state = 'none'; queue.splice(k, 1); }
    }
  }

  // ---- obstacles, trees -----------------------------------------------------------------------------------------
  const obstacles = createCityObstacles({ base, index: index.obstacles, terrain });
  let trees = null;
  if (index.trees) {
    try {
      trees = await createCityTrees({ ...ctx, base, getH, indexUrl: base + index.trees });
      group.add(trees.object);
    } catch (e) {
      console.warn('[city] trees unavailable:', e.message);
    }
  }

  // ---- initial load around the focus --------------------------------------------------------------------------------
  const focusCam = new THREE.Vector3(focus.x, getH(focus.x, focus.z) + 300, focus.z);
  select(focusCam);
  const ready = (async () => {
    const need = () => {
      let pendingCount = 0;
      for (const c of cells.values()) {
        if (dist(focusCam, c) > opt.r1 * 1.2) continue;
        const w = wanted(c, focusCam);
        for (const t of w.tiles) if (t.state !== 'ready' && t.state !== 'failed') pendingCount++;
      }
      return pendingCount;
    };
    const t0 = performance.now();
    while (need() > 0 && performance.now() - t0 < 45000) {
      pump();
      processJobs(25, 64);
      await new Promise((r) => setTimeout(r, 30));
      clock += 0.03;
      select(focusCam);
    }
    await obstacles.preload(focus.x, focus.z, 2500);
    if (trees) await trees.ready;
  })();

  return {
    object: group,
    ready,
    material,
    materialFar,
    uniforms,
    get stats() {
      let tris = 0, visible = 0;
      for (const r of loadedTiles) if (r.mesh && r.mesh.visible) { visible++; tris += r.tris; }
      return { loaded: loadedTiles.size, visible, tris, queued: queue.length, active, trees: trees ? trees.stats : null };
    },
    setNight(v) { uniforms.uCityNight.value = v; },
    /** LOD distance multiplier (e.g. 0.8 on very high resolutions / low-end GPUs, 1.3 for screenshots). */
    setLodScale(s) { opt.lodScale = Math.max(0.3, s); lastSelect = -1; },
    update(dt, camera) {
      clock += dt;
      camera.getWorldPosition(camPos);
      const moved = camPos.distanceToSquared(lastCam) > 15 * 15;
      if (moved || clock - lastSelect > 0.5) {
        select(camPos);
        lastSelect = clock;
        lastCam.copy(camPos);
      }
      pump();
      processJobs(opt.frameBudgetMs);
      if (trees) trees.update(dt, camera);
    },
    // buildings only: trees are not obstacles for physics/GPWS (a helicopter must not land on treetops)
    heightAt(x, z) { return obstacles.heightAt(x, z); },
    hitTest(x, y, z, r) { return obstacles.hitTest(x, y, z, r); },
  };
}
