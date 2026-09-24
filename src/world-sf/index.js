// Lead-owned: composes the world from the environment/terrain (W1), city (W2), landmarks (W3) and airports (W4), for the
// active map (src/maps/index.js; default San Francisco): every file comes from its data/<id>/ and assets/<id>/. Another
// map may still lack layers while it is built: a missing file (404 / 403) skips that layer (terrain: sea level).
import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { createTerrain } from './terrain.js';
import { createCity } from './city.js';
import { prepareTreeMaterial } from './city_trees.js';
import { createLandmarks, prepareLandmarkStandIn } from './landmarks.js';
import { createAirports } from './airports.js';
import { isNetworkError } from '../core/assets.js';

export async function createSFWorld({ scene, renderer, camera, loader, quality = null, focus = { x: 0, z: 0 }, onProgress = () => {}, map = null, runways: given = null }) {
  const other = map && map.id !== 'sf', D = map ? map.data : 'data/sf/';
  const A = map ? map.assets : 'assets/sf/';
  const optional = (p, empty) => (other ? p.catch((e) => { if (e && (e.status === 404 || e.status === 403)) return empty; throw e; }) : p);
  // packs.json (tools/assets/packs.mjs): the map's repackaged runtime files (lighter variants per device class, merged
  // files); every layer falls back to the original files when an entry (or the whole file) is missing
  const packsP = loader.loadJSON(A + 'packs.json').catch((e) => { if (isNetworkError(e)) throw e; return {}; });
  const [runways, landmarks, region, packs] = await Promise.all([
    given || optional(loader.loadJSON(D + 'runways.json'), { airports: [] }), optional(loader.loadJSON(D + 'landmarks.json'), { landmarks: [] }), loader.loadJSON(D + 'region.json'), packsP,
  ]);
  // playable: the first playable frame has been shown (loading screen gone). Until then the layers load only what the
  // start needs (post-start streaming would compete with the aircraft download and the shader pre-warm, whose frames
  // already call update()). Set by setPlayable() (main.js), else by the page's readyAt, else after 4 s of updates.
  const ctx = { scene, renderer, camera, loader, runways, landmarks, region, focus, quality, map, packs: packs || {}, assets: A, playable: false };   // quality: src/core/quality.js preset (factories may read it at creation)
  // Content that arrives after the start (trees, airport buildings, landmark LODs, new city materials) compiles its
  // shader programs here before it is shown: with KHR_parallel_shader_compile off the main thread, otherwise at least
  // not in a frame that draws (a first draw compiled synchronously: 25-160 ms per program with a 4x slower CPU)
  ctx.precompile = (obj) => {
    try { return renderer && renderer.compileAsync && !renderer.getContext().isContextLost() ? renderer.compileAsync(obj, camera, scene).then(() => obj, () => obj) : Promise.resolve(obj); } catch { return Promise.resolve(obj); }
  };
  // Shader pre-warm stand-ins (packs.json prewarm, tools/assets/packs.mjs): one per shader variant of the materials
  // that only appear after the start (near tree LODs, airport buildings, parked-aircraft LODs, landmark LODs), on a
  // hidden 1-triangle mesh of the kind the layer draws them with (same material processing, instancing and shadow
  // flags), so the loading screen's pre-warm (main.js: compileAsync of the scene, hidden objects included) links their
  // programs and the real materials find them in three.js' program cache. Never drawn, never disposed (disposing would
  // release the programs).
  let prewarmGroup = null, prewarmMake = null, prewarmTimer = 0;
  const prewarmLater = [], PREWARM_R = 15000;
  const prewarmP = packs && packs.prewarm ? loader.loadGLTF(A + packs.prewarm).then((g) => {
    const group = new THREE.Group();
    group.name = 'prewarm';
    // drawn (as zero-area triangles) only while the loading screen is up, so the pre-warm frame also links their
    // shadow-pass variants; hidden from the first playable frame on (update())
    prewarmGroup = group;
    const stand = [];
    g.scene.traverse((o) => { if (o.isMesh) stand.push(o); });
    const shadowsOn = !quality || quality.shadows !== false;
    const inst = (geo, mat, color) => {
      const m = new THREE.InstancedMesh(geo, mat, 1);
      if (color) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
      return m;
    };
    const near = (at, r) => !at || at.some(([ax, az]) => Math.hypot(ax - focus.x, az - focus.z) < r);
    for (const o of stand) {
      const x = o.userData && o.userData.prewarm ? o.userData : (o.parent && o.parent.userData) || {};
      // landmark variants of landmarks far from the spawn: compiled later, when the camera comes within 20 km
      if (x.prewarm === 'landmark' && !near(x.at, PREWARM_R)) { prewarmLater.push([o, x]); continue; }
      group.add(makeStandIn(o, x));
    }
    function makeStandIn(o, x) {
      let m;
      if (x.prewarm === 'tree') m = inst(o.geometry, prepareTreeMaterial(o.material, o.geometry), true);   // city_trees.js
      else if (x.prewarm === 'agent') m = inst(o.geometry, o.material, false);                             // airports_props.js NearSet
      else if (x.prewarm === 'landmark') {
        m = x.instanced ? inst(o.geometry, o.material, false) : new THREE.Mesh(o.geometry, o.material);
        prepareLandmarkStandIn(m, x.lod | 0, shadowsOn && !x.noShadow);
      } else m = new THREE.Mesh(o.geometry, o.material);   // airport buildings: merged plain meshes
      if (x.prewarm !== 'landmark') { m.castShadow = true; m.receiveShadow = true; }
      m.frustumCulled = false;
      const pos = m.geometry.getAttribute('position');
      if (pos) { pos.array.fill(0); pos.needsUpdate = true; }   // zero area: nothing rasterized
      return m;
    }
    prewarmMake = makeStandIn;
    // parked aircraft: the parts without their own material share one vertex-coloured material (loadAgentLod)
    const flat = new THREE.BufferGeometry();
    flat.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    flat.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
    flat.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12), 4));
    flat.setIndex([0, 1, 2]);
    const fm = inst(flat, new THREE.MeshStandardMaterial({ vertexColors: true }), false);
    fm.castShadow = true; fm.receiveShadow = true; fm.frustumCulled = false;
    group.add(fm);
    scene.add(group);
  }).catch((e) => { if (isNetworkError(e)) throw e; console.warn('[world] prewarm stand-ins unavailable', e && e.message); }) : null;
  if (prewarmP) prewarmP.catch(() => {});
  onProgress(0.05, 'Gökyüzü ve ışık');
  const environment = await createEnvironment(ctx);
  onProgress(0.15, 'Arazi ve hava fotoğrafları');
  const terrain = await createTerrain(ctx);
  scene.add(terrain.object);
  ctx.terrain = terrain;

  // the three layers are independent once the terrain exists: their index / manifest / atlas downloads run in parallel
  // (they used to wait for each other); scene and hit-test order stay airports, city, landmarks
  const steps = [['Havalimanları', createAirports], ['Şehir', createCity], ['Simge yapılar', createLandmarks]];
  let made = 0;
  const pendingLabel = () => (steps.find((st) => !st.done) || steps[steps.length - 1])[0];
  onProgress(0.3, steps.map((st) => st[0]).join(', '));
  const built = await Promise.all(steps.map(async (st) => {
    const [label, factory] = st;
    try {
      return await factory(ctx);
    } catch (e) {
      if (isNetworkError(e)) throw e;   // connection lost: main.js shows the connection error screen
      if (other && e && (e.status === 404 || e.status === 403)) console.info(`[world] ${map.id}: no ${label.toLowerCase()} yet (${e.message})`);
      else console.error(`[world] ${label} failed to load`, e);
      return null;
    } finally {
      st.done = true;
      onProgress(0.3 + 0.3 * ++made / steps.length, pendingLabel());
    }
  }));
  const layers = built.filter(Boolean);
  for (const l of layers) scene.add(l.object);
  // readiness of the start area: progress = parts done (terrain + each layer)
  const parts = [['Arazi', terrain.ready], ...layers.map((l, k) => [steps[built.indexOf(l)][0], l.ready])];
  let readyN = 0;
  onProgress(0.6, 'Detaylar yükleniyor');
  await Promise.all(parts.map(([, p]) => Promise.resolve(p).catch((e) => { if (isNetworkError(e)) throw e; console.error(e); }).then(() => {
    onProgress(0.6 + 0.35 * ++readyN / parts.length, 'Detaylar yükleniyor');
  })));
  if (prewarmP) await prewarmP;
  onProgress(1, 'Hazır');
  if (quality) for (const part of [environment, terrain, ...layers]) if (part && part.setQuality) { try { part.setQuality(quality); } catch (e) { console.error('[world] setQuality', e); } }

  // runway rectangles for isOnRunway
  const rects = [];
  for (const apt of runways.airports) for (const r of apt.runways) {
    const [a, b] = r.ends;
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    rects.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2, airport: apt.icao, id: r.id });
  }

  const spanScratch = { bottom: -Infinity, top: -Infinity };
  let updateTime = 0;
  return {
    runways, landmarks, region, environment, terrain, layers,
    towers: layers.flatMap((l) => l.towers || []),   // control-tower cab eye points (airports layer) for the tower camera
    sunDirection: environment.sunDirection,
    /** Apply a src/core/quality.js preset to every part that supports it (CONTRACTS-SF.md §8). */
    setQuality(q) {
      ctx.quality = q;
      for (const part of [environment, terrain, ...layers]) if (part && part.setQuality) { try { part.setQuality(q); } catch (e) { console.error('[world] setQuality', e); } }
    },
    getGroundHeight: (x, z) => terrain.getHeight(x, z),
    isWater: (x, z) => terrain.isWater(x, z),
    runwayAt(x, z) {
      for (const r of rects) {
        const px = x - r.ax, pz = z - r.az;
        const along = px * r.ux + pz * r.uz;
        if (along < 0 || along > r.len) continue;
        if (Math.abs(px * -r.uz + pz * r.ux) <= r.half) return r;
      }
      return null;
    },
    isOnRunway(x, z) { return this.runwayAt(x, z) !== null; },
    getObstacleHeight(x, z) {
      let h = -Infinity;
      for (const l of layers) { const v = l.heightAt(x, z); if (v > h) h = v; }
      return h;
    },
    /**
     * Vertical extent of the obstacles above (x, z): { bottom, top }. Solid obstacles (buildings, towers) have
     * bottom = -Infinity; bridge decks report their underside as bottom so flying under them is not a pull-up.
     */
    getObstacleSpan(x, z, out = { bottom: -Infinity, top: -Infinity }) {
      let solidTop = -Infinity, spanTop = -Infinity, spanBottom = Infinity;
      for (const l of layers) {
        if (l.spanAt) {
          const s = l.spanAt(x, z, spanScratch);
          if (Number.isFinite(s.bottom)) { if (s.top > spanTop) { spanTop = s.top; spanBottom = s.bottom; } }
          else if (s.top > solidTop) solidTop = s.top;
        } else {
          const t = l.heightAt(x, z);
          if (t > solidTop) solidTop = t;
        }
      }
      if (spanTop === -Infinity || solidTop >= spanTop) { out.bottom = -Infinity; out.top = solidTop; }
      else { out.bottom = Math.max(spanBottom, solidTop); out.top = spanTop; }
      return out;
    },
    hitTest(x, y, z, r) {
      for (const l of layers) { const hit = l.hitTest(x, y, z, r); if (hit) return hit; }
      return null;
    },
    /** The first playable frame is on screen (main.js, after the loading screen): post-start streaming may begin. */
    setPlayable() { ctx.playable = true; },
    get playable() { return ctx.playable; },
    update(dt, cam) {
      if (!ctx.playable) {
        updateTime += dt;
        if ((typeof window !== 'undefined' && window.__game && window.__game.readyAt) || updateTime > 4) ctx.playable = true;
      }
      if (ctx.playable && prewarmGroup && prewarmGroup.visible) prewarmGroup.visible = false;
      // remaining stand-ins: one at a time when the camera gets within 20 km of a landmark they stand in for
      if (ctx.playable && prewarmLater.length && (prewarmTimer -= dt) <= 0) {
        prewarmTimer = 2;
        const k = prewarmLater.findIndex(([, x]) => x.at.some(([ax, az]) => Math.hypot(ax - cam.position.x, az - cam.position.z) < 20000));
        if (k >= 0) { const [o, x] = prewarmLater.splice(k, 1)[0]; const m = prewarmMake(o, x); prewarmGroup.add(m); ctx.precompile(m); }
      }
      environment.update(dt, cam);
      terrain.update(dt, cam);
      for (const l of layers) l.update(dt, cam);
    },
  };
}
