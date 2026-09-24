// W2 city layer: San Francisco + Bay Area buildings (DataSF LiDAR footprints + OSM, meshes built in Blender) and trees.
// Streams four LOD levels (L0 500 m tiles with full detail < 1.3 km, L1 1 km simplified < 3.6 km, L2 2 km merged
// blocks < 8 km, L3 2 km tall blocks only beyond) chosen per 2 km cell by camera distance, swaps a cell's level only
// once every tile of the new level is loaded (no holes), drops every building onto the live terrain
// (ctx.terrain.getHeight) and answers heightAt / hitTest from 4 m building obstacle rasters (trees are not obstacles).
import * as THREE from 'three';
import { assetData, isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';
import { createCityMaterial, prepareCityGeometry, setAnisotropy } from './city_material.js';
import { createCityObstacles } from './city_obstacles.js';
import { createCityTrees } from './city_trees.js';

const BASE = 'assets/sf/city/';
function freeArray() { this.array = null; }
const DEFAULTS = { r0: 1300, r1: 3600, r2: 8000, rMax: 26000, maxLoads: 4, unloadAfter: 20, frameBudgetMs: 3, uploadsPerFrame: 1, warmUpload: true, lodScale: 1, shadows: true, readyRadius: 900 };
// Streaming at speed (a fighter at 500 kt crosses a 1 km L0 tile in 4 s): the camera's smoothed ground speed shrinks the
// L0 and L1 rings (s = 0 below ~230 kt, 1 above ~500 kt; phones and tablets more), requests are ordered by the distance
// from where the camera will be in LOOKAHEAD s, tiles behind the view last, and downloads nobody wants any more are
// cancelled. Paused / slow flight (every reference pose) is unchanged.
const SPEED_LO = 120, SPEED_HI = 260, LOOKAHEAD = 2.5;
// far tiles (L2 blocks, L3 towers) are small but were never unloaded: a long flight kept every one it passed (a 10-min
// İstanbul flight: +37 geometries a minute, +75 MB of buffers on a phone); they go after FAR_UNLOAD_S unused seconds
const FAR_UNLOAD_S = { phone: 30, tablet: 45, default: 120 };

export async function createCity(ctx, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const q0 = ctx.quality;
  if (q0) {   // CONTRACTS-SF §8: pick the LOD scale before the first request so low never loads tiles it won't show
    if (q0.cityLodScale != null && options.lodScale == null) opt.lodScale = q0.cityLodScale;
    if (q0.cityShadows != null) opt.shadows = !!q0.cityShadows;
    if (q0.cityUnloadAfter != null && options.unloadAfter == null) opt.unloadAfter = q0.cityUnloadAfter;   // robustness: memory-limited devices drop passed tiles sooner
  }
  const base = options.base || (ctx.map ? `${ctx.map.assets}city/` : BASE);   // the active map's (src/maps/index.js)
  const { terrain, focus = { x: 0, z: 0 } } = ctx;
  const getH = (x, z) => (terrain ? terrain.getHeight(x, z) : 0);
  // facade atlas per device class (packs.json): tablets 256² cells (the 512² cells' mip 1), phones 128² (mip 2):
  // 3 × 49 → 3 × 12 / 3 × 3 MB of GPU memory, a quarter / a sixteenth of the decode work at start; loaded in parallel
  // with the tile index
  const cls = q0 && q0.deviceClass, cp = (ctx.packs && ctx.packs.city) || {};
  const atlasVar = ctx.assets && (cls === 'phone' ? cp.atlasTiny || cp.atlasSmall : cls === 'tablet' ? cp.atlasSmall : null);
  const farUnload = FAR_UNLOAD_S[cls] || FAR_UNLOAD_S.default;
  const materialP = createCityMaterial(ctx.renderer, atlasVar ? ctx.assets + atlasVar : base + 'atlas/', q0 && q0.anisotropy);
  materialP.catch(() => {});
  const index = await assetData(base + 'index.json', 'json');
  const { material, materialFar, uniforms, textures } = await materialP;
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
  // repackaged levels (packs.json city.tiles: San Francisco's Draco tiles as meshopt, tools/assets/city_meshopt.mjs)
  const packTiles = (ctx.packs && ctx.packs.city && ctx.packs.city.tiles && ctx.assets) ? ctx.packs.city.tiles : {};
  const tileUrl = (rec) => (packTiles[rec.dir] ? `${ctx.assets}${packTiles[rec.dir]}/${rec.i}_${rec.j}.glb` : `${base}${rec.dir}/${rec.i}_${rec.j}.glb`);
  const mobileClass = !!(q0 && (q0.deviceClass === 'phone' || q0.deviceClass === 'tablet'));
  const motion = { speed: 0, vx: 0, vz: 0, fx: 0, fz: -1, s: 0, init: false, px: 0, pz: 0 };
  const pred = new THREE.Vector3();
  /** Ring scales from the smoothed speed: L0 ring × (1 − 0.5 s) (phones / tablets 1 − 0.65 s), L1 × (1 − 0.25 s). */
  const ringScale = (level) => (level === 0 ? 1 - (mobileClass ? 0.65 : 0.5) * motion.s : 1 - 0.25 * motion.s);

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

  let preloadRadius = Infinity;   // while waiting for `ready`, only tiles this close to the focus are requested
  function request(rec, prio) {
    if (rec.state !== 'none') return;
    if (prio > preloadRadius) return;
    rec.state = 'queued';
    rec.prio = prio;
    queue.push(rec);
  }
  /** Request priority in flight: distance from the predicted camera position, tiles behind the view pushed back. */
  function flightPrio(t, cam) {
    const d = dist(pred, t);
    const cx = (t.minX + t.maxX) / 2 - cam.x, cz = (t.minZ + t.maxZ) / 2 - cam.z;
    const L = Math.hypot(cx, cz);
    const behind = L < 700 ? 0 : Math.max(0, -(cx * motion.fx + cz * motion.fz) / L);
    return d * (1 + 1.5 * behind) + (t.level >= 2 ? 2000 : 0);
  }

  // Loaded GLBs go through a per-frame time-budgeted pipeline so streaming never stalls a frame:
  //   'place'  terrain placement of the vertices in slices (2k vertices per slice, budget opt.frameBudgetMs)
  //   'upload' GPU upload of the finished tile, one tile per frame, by drawing it into a 1x1 render target
  const jobs = [];
  const warm = { scene: new THREE.Scene(), target: new THREE.WebGLRenderTarget(1, 1), camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  warm.scene.matrixWorldAutoUpdate = false;
  // the warm-up draw only has to upload the buffers (three.js uploads every attribute of a drawn geometry): a trivial
  // material instead of the city shader, whose render-target variant (linear output, no tone mapping) was a second
  // program per material, compiled synchronously in flight (~150 ms with a 4x slower CPU)
  warm.scene.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
  // the city shaders for the screen, compiled in the background before the first tile shows (not in the frame that
  // first draws a near / far tile)
  if (ctx.precompile) {
    const g = new THREE.BufferGeometry();
    for (const [k, n] of [['position', 3], ['normal', 3], ['aFacade', 2], ['aLayer', 2], ['aTint', 4]]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(3 * n), n));
    const pre = new THREE.Group();
    for (const m of [material, materialFar]) { const o = new THREE.Mesh(g, m); o.receiveShadow = true; pre.add(o); }
    ctx.precompile(pre).then(() => g.dispose());
  }

  function pump() {
    if (!queue.length || active >= opt.maxLoads) return;
    queue.sort((a, b) => a.prio - b.prio);
    while (queue.length && active < opt.maxLoads) {
      const rec = queue.shift();
      active++;
      rec.state = 'loading';
      loading.add(rec);
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      rec.abort = ac;
      // downloaded here (cancellable when the tile is no longer wanted), parsed by the shared GLTFLoader (meshopt in
      // its workers, Draco in DRACOLoader's)
      assetData(tileUrl(rec), 'arrayBuffer', ac ? { signal: ac.signal } : undefined).then((buf) => gltf.parseAsync(buf, '')).then((g) => {
        if (ac && ac.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        let mesh = null;
        g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
        if (!mesh) throw new Error('no mesh');
        mesh.updateWorldMatrix(true, false);
        mesh.removeFromParent();
        prepareCityGeometry(mesh.geometry);
        jobs.push({ rec, mesh, cx: mesh.position.x, cz: mesh.position.z, v: 0, phase: 'place', lastA: NaN, lastB: NaN, lastG: 0 });
        rec.state = 'processing';
        rec.fails = 0;
      }).catch((e) => {
        if ((e && e.name === 'AbortError') || (ac && ac.signal.aborted)) { rec.state = 'none'; aborted++; return; }   // no longer wanted
        // connection lost: asked again after a delay (select); missing/broken tile: stays failed (a hole, no retries)
        rec.fails = (rec.fails || 0) + 1;
        rec.retryAt = isNetworkError(e) ? clock + retryDelay(rec.fails) / 1000 : 0;
        rec.state = 'failed';
        reportLoadFailure('city', `tile ${rec.dir}/${rec.i}_${rec.j}`, e);
      }).finally(() => { active--; rec.abort = null; loading.delete(rec); });
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
    mesh.castShadow = rec.level === 0 && opt.shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
    mesh.name = `city_L${rec.level}_${rec.i}_${rec.j}`;
    // static tiles: free the JS copies of the vertex/index arrays once they are on the GPU (hundreds of MB otherwise)
    const geo = mesh.geometry;
    for (const a of Object.values(geo.attributes)) a.onUpload(freeArray);
    if (geo.index) geo.index.onUpload(freeArray);
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
    mesh.visible = true;   // (added to the scene graph when its cell displays it)
    rec.mesh = mesh;
    rec.state = 'ready';
    loadedTiles.add(rec);
  }

  // A tile is placed on the terrain as loaded when its placement starts, and never again (its CPU arrays are freed after
  // upload). Where the terrain pack has full-depth heights for the tile's area that are still on their way (the
  // pinned cells stream after the start), the tile waits for them (terrain.pinsPending also moves them up the queue).
  const waitsForPins = (job) => job.v === 0 && terrain && terrain.pinsPending && terrain.pinsPending(job.rec.minX, job.rec.minZ, job.rec.maxX, job.rec.maxZ);
  function processJobs(budgetMs, maxUploads = opt.uploadsPerFrame) {
    const t0 = performance.now();
    let uploads = 0, k = 0;
    while (k < jobs.length && performance.now() - t0 < budgetMs) {
      const job = jobs[k];
      if (job.rec.state !== 'processing') { jobs.splice(k, 1); continue; }
      if (job.phase === 'place') {
        if (waitsForPins(job)) { k++; continue; }
        if (placeSlice(job, 2048)) job.phase = 'upload';
        continue;
      }
      if (uploads >= maxUploads) { k++; continue; }
      finish(jobs.splice(k, 1)[0]);
      uploads++;
    }
  }

  function unload(rec) {
    if (rec.abort) rec.abort.abort();
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
  const camPos = new THREE.Vector3(), camFwd = new THREE.Vector3();
  let clock = 0, lastSelect = -1, aborted = 0;
  const loading = new Set();   // tiles being downloaded / parsed
  const lastCam = new THREE.Vector3(1e9, 0, 0);

  function wanted(c, cam) {
    const d = dist(cam, c) / opt.lodScale;
    if (d > opt.rMax) return { key: 'none', tiles: [] };
    if (d > opt.r2 && L3.size) {
      const t = L3.get(tkey(c.i, c.j));
      return { key: 'L3', tiles: t ? [t] : [] };
    }
    if (d > opt.r1 * ringScale(1)) {
      const t = L2.get(tkey(c.i, c.j));
      return { key: 'L2', tiles: t ? [t] : [] };
    }
    const tiles = [];
    let key = 'S';
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const i1 = c.i * 2 + a, j1 = c.j * 2 + b;
      const t1 = L1.get(tkey(i1, j1));
      const bb = t1 || { minX: i1 * 1000, maxX: i1 * 1000 + 1000, minZ: j1 * 1000, maxZ: j1 * 1000 + 1000, maxY: 50 };
      if (dist(cam, bb) / opt.lodScale > opt.r0 * ringScale(0)) {
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

  function select(cam, flying = false) {
    const now = clock;
    if (flying) pred.set(cam.x + motion.vx * LOOKAHEAD, cam.y, cam.z + motion.vz * LOOKAHEAD);
    for (const c of cells.values()) {
      const w = wanted(c, cam);
      const d = dist(cam, c);
      let allReady = true;
      for (const t of w.tiles) {
        t.lastUsed = now;
        if (t.state === 'failed' && t.retryAt && now >= t.retryAt) { t.state = 'none'; t.retryAt = 0; }
        if (t.state !== 'ready' && t.state !== 'failed') {
          allReady = false;
          if (t.state === 'processing' || t.state === 'loading') continue;
          request(t, flying ? flightPrio(t, cam) : dist(cam, t) + (t.level >= 2 ? 2000 : 0));
        }
      }
      if (allReady && w.key !== c.displayKey) {
        // only displayed tiles are in the scene graph (three.js walks every child each frame)
        if (c.display) for (const t of c.display) if (t.mesh) t.mesh.removeFromParent();
        c.display = w.tiles;
        c.displayKey = w.key;
        for (const t of c.display) if (t.mesh) buildings.add(t.mesh);
      }
      if (c.display) for (const t of c.display) t.lastUsed = now;
      c.dist = d;
    }
    // evict tiles unused for a while (the small far tiles after a longer time)
    for (const rec of loadedTiles) {
      if (now - rec.lastUsed > (rec.level < 2 ? opt.unloadAfter : farUnload)) unload(rec);
    }
    // drop queued requests that are no longer wanted, cancel such downloads (at speed: tiles already passed)
    for (let k = queue.length - 1; k >= 0; k--) {
      if (now - queue[k].lastUsed > 2) { queue[k].state = 'none'; queue.splice(k, 1); }
    }
    if (flying) for (const rec of loading) if (now - rec.lastUsed > 1.5 && rec.abort) rec.abort.abort();
  }

  // ---- obstacles, trees -----------------------------------------------------------------------------------------
  // obstacle rasters kept (LRU, ~140 KB of heap each): phones 48 (a 7 × 7 km neighbourhood), tablets 80, others 160
  const obstacles = createCityObstacles({ base, index: index.obstacles, terrain, maxTiles: cls === 'phone' ? 48 : cls === 'tablet' ? 80 : 160 });
  let trees = null, lastQuality = null;
  // tree models load with the start (with packs: the far LODs, 0.9 MB) so the loading screen's shader pre-warm
  // compiles their programs (WebKit has no parallel compile: linking them in flight froze iPads for 0.3-4 s ~10 s
  // into every flight); the tree tiles stream after the start (treesStarted)
  const loadTrees = async () => {
    if (!index.trees) return;
    for (let fails = 1; ; fails++) {
      try {
        const t = await createCityTrees({ ...ctx, base, getH, indexUrl: base + index.trees });
        if (lastQuality || q0) t.setQuality(lastQuality || q0);
        if (started && ctx.precompile) await ctx.precompile(t.object);   // arrived after the start: compile first
        trees = t;
        group.add(t.object);
        return;
      } catch (e) {
        if (!isNetworkError(e)) { console.warn('[city] trees unavailable:', e.message); return; }
        reportLoadFailure('city', 'trees', e);   // connection lost: try again later
        await new Promise((r) => setTimeout(r, retryDelay(fails)));
      }
    }
  };
  const treesP = loadTrees();

  // ---- initial load around the focus --------------------------------------------------------------------------------
  // `ready` = the obstacle grid around the spawn + the building tiles of the cells within opt.readyRadius at the LOD a
  // camera near the spawn would show. Everything else (farther tiles, finer LODs, trees) streams after the start.
  const focusCam = new THREE.Vector3(focus.x, getH(focus.x, focus.z) + 150, focus.z);
  preloadRadius = opt.readyRadius;
  select(focusCam);
  const ready = (async () => {
    const need = () => {
      let pendingCount = 0;
      for (const c of cells.values()) {
        if (dist(focusCam, c) > opt.readyRadius) continue;
        const w = wanted(c, focusCam);
        for (const t of w.tiles) if (t.state !== 'ready' && t.state !== 'failed' && dist(focusCam, t) <= opt.readyRadius) pendingCount++;
      }
      return pendingCount;
    };
    const t0 = performance.now();
    const obst = obstacles.preload(focus.x, focus.z, 1200);
    while (need() > 0 && performance.now() - t0 < 45000) {
      pump();
      processJobs(25, 64);
      await new Promise((r) => setTimeout(r, 30));
      clock += 0.03;
      select(focusCam);
    }
    await obst;
    // the facade atlas uploads here, behind the loading screen, one array texture per task (at the first draw the
    // three uploads came in one frame: 111 MB of texImage3D, 160 ms on a phone)
    if (ctx.renderer) for (const t of textures) { try { ctx.renderer.initTexture(t); } catch { /* at first use */ } await new Promise((r) => setTimeout(r, 0)); }
    await Promise.race([treesP, new Promise((r) => setTimeout(r, 20000))]);
    // the rest (farther tiles, tree tiles) starts after the first playable frame, so it doesn't compete with the other
    // layers / the aircraft for bandwidth before it
  })();
  let started = false;
  // mobile hook (docs/errors/audit.md #1): on phones / tablets the post-ready burst is staggered — tile uploads at most
  // one per two frames and no trees for the first STAGGER_S seconds of flight (iOS kills the page for memory otherwise)
  const STAGGER_S = 10;
  const mobile = !!(q0 && (q0.deviceClass === 'phone' || q0.deviceClass === 'tablet'));
  let flightT = 0, frameN = 0, treesStarted = false;

  return {
    object: group,
    ready,
    material,
    materialFar,
    uniforms,
    get stats() {
      let tris = 0, visible = 0;
      for (const r of loadedTiles) if (r.mesh && r.mesh.parent === buildings) { visible++; tris += r.tris; }
      return { loaded: loadedTiles.size, visible, tris, queued: queue.length, active, aborted, speed: Math.round(motion.speed), ringS: +motion.s.toFixed(2), trees: trees ? trees.stats : null };
    },
    setNight(v) { uniforms.uCityNight.value = v; },
    /** LOD distance multiplier (e.g. 0.8 on very high resolutions / low-end GPUs, 1.3 for screenshots). */
    setLodScale(s) { opt.lodScale = Math.max(0.3, s); lastSelect = -1; },
    /** CONTRACTS-SF §8 (live): cityLodScale, cityShadows, treeDensity, treeDistance, anisotropy. */
    setQuality(q) {
      if (!q) return;
      lastQuality = q;
      if (q.cityLodScale != null) this.setLodScale(q.cityLodScale);
      if (q.cityUnloadAfter != null) opt.unloadAfter = q.cityUnloadAfter;   // robustness (GPU budget)
      if (q.cityShadows != null) {
        opt.shadows = !!q.cityShadows;
        for (const r of loadedTiles) if (r.mesh) r.mesh.castShadow = r.level === 0 && opt.shadows;
      }
      if (q.anisotropy != null) setAnisotropy(ctx.renderer, textures, q.anisotropy);
      if (trees) trees.setQuality(q);
    },
    update(dt, camera) {
      const playable = ctx.playable !== false;   // (world index.js: after the first playable frame)
      if (!started && playable) { started = true; preloadRadius = Infinity; }
      if (started) { flightT += dt; frameN++; }
      if (!treesStarted && started && (!mobile || flightT >= STAGGER_S)) treesStarted = true;
      clock += dt;
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(camFwd);
      const fl = Math.hypot(camFwd.x, camFwd.z);
      if (fl > 1e-3) { motion.fx = camFwd.x / fl; motion.fz = camFwd.z / fl; }
      if (!motion.init || dt <= 0) { motion.init = true; motion.px = camPos.x; motion.pz = camPos.z; }
      else {
        // ground velocity of the camera, smoothed over ~1.5 s (a camera cut / reset is one frame: capped)
        const vx = (camPos.x - motion.px) / dt, vz = (camPos.z - motion.pz) / dt;
        motion.px = camPos.x; motion.pz = camPos.z;
        const sp = Math.hypot(vx, vz);
        if (sp < 1200) {
          const a = Math.min(1, dt / 1.5);
          motion.vx += (vx - motion.vx) * a; motion.vz += (vz - motion.vz) * a;
          motion.speed = Math.hypot(motion.vx, motion.vz);
          const s = Math.min(1, Math.max(0, (motion.speed - SPEED_LO) / (SPEED_HI - SPEED_LO)));
          motion.s = s * s * (3 - 2 * s);
        }
      }
      const moved = camPos.distanceToSquared(lastCam) > 15 * 15;
      if (moved || clock - lastSelect > 0.5) {
        select(camPos, started);
        lastSelect = clock;
        lastCam.copy(camPos);
      }
      pump();
      processJobs(opt.frameBudgetMs, mobile && flightT < STAGGER_S ? frameN & 1 : opt.uploadsPerFrame);
      if (trees && treesStarted) trees.update(dt, camera);
    },
    // buildings only: trees are not obstacles for physics/GPWS (a helicopter must not land on treetops)
    heightAt(x, z) { return obstacles.heightAt(x, z); },
    hitTest(x, y, z, r) { return obstacles.hitTest(x, y, z, r); },
  };
}
