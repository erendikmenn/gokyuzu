// W4 airports layer: SFO (KSFO), Oakland (KOAK) and the fictional military air base "Alameda Hava Üssü" (KNGZ).
// Data: assets/sf/airports/<icao>.json + .bin (tools/geo/airports_build.py), buildings/props GLBs (blender/airports/*).
// Everything is draped on ctx.terrain (getHeight + small offsets); the layer implements the contract Layer interface.
import * as THREE from 'three';
import { isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';
import { readArrays, buildGround, buildStructures, airportFiles } from './airports_ground.js';
import { buildLights, updateLights } from './airports_lights.js';
import { buildSigns } from './airports_signs.js';
import { loadBuildings, updateBuildingLights } from './airports_buildings.js';
import { buildProps, updateProps, setPropsDensity, addAgentLods } from './airports_props.js';
import { buildFence, buildCables, buildFloodPools } from './airports_extras.js';
import { Draper, meshJob, lightsJob, instancedJob, rigidJob } from './airports_drape.js';

const SF_ICAOS = ['ksfo', 'kngz', 'koak'];

export async function createAirports(ctx) {
  // the active map's airports (src/maps/index.js): San Francisco's three; another map's manifest.json in its
  // <assets>/airports/ ({ airports?: ['ltfm', …] (default: every airport of runways.json), tex?: ground texture
  // directory, props?: props GLB, as root-relative paths (e.g. San Francisco's generic ones); no file = no airports yet)
  const BASE = ctx.map ? `${ctx.map.assets}airports/` : 'assets/sf/airports/';
  let ICAOS = SF_ICAOS;
  Object.assign(airportFiles, { base: BASE, tex: BASE + 'tex/', props: BASE + 'props.glb' });
  if (ctx.map && ctx.map.id !== 'sf') {
    const man = await ctx.loader.loadJSON(BASE + 'manifest.json');   // (missing: the world skips the layer)
    ICAOS = man.airports || ((ctx.runways && ctx.runways.airports) || []).map((a) => a.icao.toLowerCase());
    if (man.tex) airportFiles.tex = man.tex;
    if (man.props) airportFiles.props = man.props;
  }
  const group = new THREE.Group();
  group.name = 'airports';
  const airports = [];
  const lightMeshes = [];
  const colliders = new Colliders();
  const state = { time: 0, day: 1, dayOverride: null, sunCheck: 0, sun: null };
  // graphics quality (CONTRACTS-SF.md §8): airportLodScale scales every LOD distance, shadows toggles casting,
  // low presets thin out parked aircraft / service vehicles
  const Q = { lod: 1, shadows: true, acFrac: 1, vehFrac: 1 };
  const applyQuality = (apt) => {
    apt.root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh)) return;
      if (o.userData.castOrig === undefined) o.userData.castOrig = o.castShadow;
      o.castShadow = o.userData.castOrig && Q.shadows;
    });
    if (apt.props) setPropsDensity(apt.props, Q.acFrac, Q.vehFrac, Q.lod);
    if (apt.lights) apt.lights.material.uniforms.uFarFade.value = 30000 * Math.max(0.6, Q.lod);
  };
  const setQ = (q) => {
    if (!q) return;
    Q.lod = q.airportLodScale ?? 1;
    Q.shadows = q.shadows !== false;
    Q.acFrac = Q.lod <= 0.65 ? 0.55 : Q.lod <= 0.85 ? 0.8 : 1;
    Q.vehFrac = Q.lod <= 0.65 ? 0.3 : Q.lod <= 0.85 ? 0.65 : 1;
  };
  setQ(ctx.quality);
  const focus = ctx.focus || { x: 0, z: 0 };

  const loadMeta = async (icao) => {
    const meta = await ctx.loader.loadJSON(BASE + icao + '.json');
    const buf = await ctx.loader.loadBinary(BASE + meta.bin);
    return { meta, A: readArrays(meta, buf) };
  };
  const metas = {};
  // airports in distance order from the spawn (centres from data/sf/runways.json, no download needed)
  const RADIUS = { KSFO: 3500, KOAK: 3000, KNGZ: 2200 };
  const order = (ctx.runways ? ctx.runways.airports.map((a) => ({ icao: a.icao, x: a.center.x, z: a.center.z })) : [])
    .filter((a) => ICAOS.includes(a.icao.toLowerCase()))
    .map((a) => ({ ...a, d: Math.hypot(a.x - focus.x, a.z - focus.z) }))
    .sort((a, b) => a.d - b.d);
  const timing = { t0: performance.now() };
  // the game loop calls update() only once the player can play: that starts the background loading
  let resolveStart;
  const started = new Promise((r) => { resolveStart = r; });
  state.started = false;
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /** Core of an airport: pavement, paint, lights, light fixtures, signs, fence, props.glb props, collisions. */
  async function buildCore(icao) {
    const { meta, A } = await loadMeta(icao);
    metas[icao] = { meta, A };
    const apt = { meta, root: new THREE.Group(), lights: null, fixtures: [], buildings: null, props: null };
    apt.root.name = `airport-${meta.icao}`;
    const gridRot = meta.gridRot ?? (meta.icao === 'KSFO' ? -27.42 * Math.PI / 180 : meta.icao === 'KNGZ' ? -75 * Math.PI / 180 : -21.7 * Math.PI / 180);
    const { group: ground } = buildGround(meta, A, ctx, { gridRot });
    apt.ground = ground;
    apt.root.add(ground);
    const structs = buildStructures(meta, A, ctx);
    apt.structs = structs;
    apt.root.add(structs);
    structs.traverse((o) => { if (o.userData.lodDist) apt.fixtures.push(o); });
    apt.lights = buildLights(meta, A, ctx);
    if (apt.lights) { apt.root.add(apt.lights); lightMeshes.push(apt.lights); }
    try {
      for (const f of [buildFence(meta, ctx), buildCables(meta, ctx)]) {
        if (f) { apt.root.add(f); apt.fixtures.push(f); }
      }
      apt.pools = buildFloodPools(meta, ctx);
      if (apt.pools) apt.root.add(apt.pools);
    } catch (e) { console.warn('[airports] extras', e); }
    try {
      const signs = buildSigns(meta, ctx);
      if (signs) { apt.root.add(signs); apt.fixtures.push(signs); signs.userData.lodDist = 3500; apt.signMat = signs.material; }
    } catch (e) { console.warn('[airports] signs', e); }
    colliders.addAirport(meta, ctx);       // buildings / towers / jet bridges collide from here on (footprints from the json)
    try {
      apt.props = await buildProps(meta, ctx, colliders);
      if (apt.props) apt.root.add(apt.props.object);
    } catch (e) { console.warn('[airports] props', meta.icao, e); }
    setupDrape(apt);
    applyQuality(apt);
    group.add(apt.root);
    airports.push(apt);
    group.updateMatrixWorld(true);
    return apt;
  }

  /** Heavy optional parts, loaded in the background: buildings GLB and the aircraft agents' LOD models. */
  /** Returns true when a part failed on a lost connection (the background loop tries the airport again later). */
  async function buildHeavy(apt) {
    let again = false;
    if (!apt.buildings) {
      try {
        apt.buildings = await loadBuildings(apt.meta, ctx, colliders);
        if (apt.buildings) apt.root.add(apt.buildings.object);
      } catch (e) { again = isNetworkError(e); reportLoadFailure('airports', `buildings ${apt.meta.icao}`, e); }
    }
    await frame();
    if (!apt.lodsDone) {
      try { await addAgentLods(apt.props, ctx); apt.lodsDone = true; } catch (e) { console.warn('[airports] lods', apt.meta.icao, e); }
    }
    setupDrape(apt);
    applyQuality(apt);
    group.updateMatrixWorld(true);
    return again;
  }

  function setupDrape(apt) {
    try {
      const O = apt.meta.origin;
      const dr = new Draper(ctx.terrain);
      apt.ground.traverse((o) => { if (o.isMesh && o.userData.off != null) dr.add(meshJob(o, O, o.userData.off)); });
      if (apt.lights) dr.add(lightsJob(apt.lights, O, apt.lights.userData.heights, apt.lights.userData.modes, ctx.terrain.isWater ? (x, z) => ctx.terrain.isWater(x, z) : null));
      apt.structs.traverse((o) => { if (o.isInstancedMesh && o.userData.drapeDy != null) dr.add(instancedJob(o, O, o.userData.drapeDy)); });
      if (apt.pools) dr.add(instancedJob(apt.pools, O, 0.12));
      if (apt.signMat) apt.root.traverse((o) => { if (o.userData.drapeGroups && o.userData.drapeGroups.length) dr.add(rigidJob(o.userData.drapeGroups)); });
      if (apt.buildings && apt.buildings.drapeGroups.length) dr.add(rigidJob(apt.buildings.drapeGroups));
      if (apt.props) {
        dr.add(apt.props.drapeJob);
        for (const lm of apt.props.lampMeshes) dr.add(instancedJob(lm, O, 0));
      }
      apt.draper = dr;
      apt.drapeDue = 0;
    } catch (e) { console.warn('[airports] drape', apt.meta.icao, e); }
  }

  // ready = the airport at the spawn (its pavement, markings, lights, collisions). Spawns far from every airport
  // (airborne starts over the city / Golden Gate) do not wait for any airport data at all.
  const near = order[0];
  const nearNeeded = near && near.d < (RADIUS[near.icao] || 3000) + 6000;
  const ready = (async () => {
    if (!nearNeeded) return;
    if (ctx.terrain && ctx.terrain.ready) {
      await Promise.race([Promise.resolve(ctx.terrain.ready).catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    }
    try { await buildCore(near.icao.toLowerCase()); } catch (e) {
      if (isNetworkError(e)) throw e;   // connection lost before the start (the background loop below retries it too)
      console.warn('[airports]', near.icao, e.message);
    }
    timing.first = performance.now() - timing.t0;
  })();
  const all = (async () => {
    await ready.catch(() => {});
    // start after the first game frame (or after 12 s on pages that never call update)
    await Promise.race([started, new Promise((r) => setTimeout(r, 12000))]);
    await frame();
    // airports (or their buildings) that failed on a lost connection are tried again in later rounds
    let todo = order;
    for (let round = 1; todo.length; round++) {
      const again = [];
      for (const a of todo) {
        const icao = a.icao.toLowerCase();
        try {
          let apt = airports.find((x) => x.meta.icao === a.icao);
          if (!apt) { apt = await buildCore(icao); await frame(); }
          if (await buildHeavy(apt)) again.push(a);
          await frame();
        } catch (e) {
          if (isNetworkError(e)) again.push(a);
          reportLoadFailure('airports', a.icao, e);
        }
      }
      todo = again;
      if (todo.length) await new Promise((r) => setTimeout(r, retryDelay(round)));
    }
    timing.all = performance.now() - timing.t0;
  })();
  all.catch((e) => console.error('[airports]', e));

  const _cam = new THREE.Vector3();
  function findSun() {
    let best = null;
    ctx.scene.traverse((o) => { if ((o.isDirectionalLight || o.isSunLight) && (!best || o.intensity > best.intensity)) best = o; });
    return best;
  }

  // control tower cab eye points (world) for a 'tower' camera: filled when the airports are built
  const towers = [];
  all.then(() => {
    for (const { meta } of Object.values(metas)) {
      const [ox, oz] = meta.origin;
      for (const s of meta.structures || []) {
        if (s.kind === 'sfo_tower' && s.x != null) towers.push({ icao: meta.icao, name: 'SFO kulesi', x: s.x + ox, z: s.z + oz, y: ctx.terrain.getHeight(s.x + ox, s.z + oz) + s.cab0 + 2.5 });
        if (s.kind === 'tower_mil') towers.push({ icao: meta.icao, name: 'Alameda kulesi', x: s.x + ox, z: s.z + oz, y: ctx.terrain.getHeight(s.x + ox, s.z + oz) + s.h - 4.0 });
      }
      for (const s of meta.structures || []) {
        if (s.kind === 'tower_generic') towers.push({ icao: meta.icao, name: s.name || 'kule', x: s.x + ox, z: s.z + oz, y: ctx.terrain.getHeight(s.x + ox, s.z + oz) + s.cab0 + 2.5 });
      }
    }
  });

  return {
    object: group,
    airports,
    towers,
    ready,
    allReady: all,
    timing,
    colliders,
    /** Apply a src/core/quality.js preset live (airportLodScale, shadows). */
    setQuality(q) { setQ(q); for (const apt of airports) applyQuality(apt); },
    /** Force the light/day factor (0 = night … 1 = day); null returns to automatic (sun elevation). */
    setDaylight(v) { state.dayOverride = v; },
    update(dt, camera) {
      if (!state.started) { state.started = true; resolveStart(); }
      state.time += dt;
      state.sunCheck -= dt;
      if (state.sunCheck <= 0) { state.sun = findSun(); state.sunCheck = state.sun ? 20 : 2; }
      let day = 1;
      if (state.dayOverride != null) day = state.dayOverride;
      else if (state.sun) {
        // DirectionalLight: position - target; SunLight (r186 addon): direction = position (shines toward the origin)
        const d = _cam.copy(state.sun.position);
        if (state.sun.isDirectionalLight && state.sun.target) d.sub(state.sun.target.position);
        d.normalize();
        day = THREE.MathUtils.smoothstep(d.y, -0.05, 0.22);
        day = Math.min(day, THREE.MathUtils.clamp(state.sun.intensity / 1.2, 0, 1) * 0.5 + 0.5 * day);
      }
      state.day = day;
      camera.getWorldPosition(_cam);
      for (const apt of airports) {
        const [ox, oz] = apt.meta.origin;
        const d = Math.hypot(_cam.x - ox, _cam.z - oz);
        const R = apt.meta.radius || 3000;
        apt.root.visible = d < R + 30000 * Math.max(0.6, Q.lod);
        if (!apt.root.visible) continue;
        for (const f of apt.fixtures) {
          // fixture meshes are small: show them only when the camera is close to (some part of) the field
          f.visible = d < R + f.userData.lodDist * Q.lod;
        }
        if (apt.buildings) apt.buildings.object.visible = d < R + 22000 * Q.lod;
        if (apt.buildings) updateBuildingLights(apt.buildings, day, d, _cam);
        if (apt.pools) apt.pools.userData.setNight(1 - day);
        if (apt.signMat) apt.signMat.emissiveIntensity = (1 - day) * 0.9;
        if (apt.props) {
          // distance LOD: parked aircraft / vehicles are invisible specks beyond ~8 km
          apt.props.object.visible = d < R + 8000 * Q.lod;
          if (apt.props.object.visible) updateProps(apt.props, dt, _cam, day);
        }
      }
      // incremental re-drape of the nearest airport in range (a few thousand height samples per frame)
      let best = null, bestD = Infinity;
      for (const apt of airports) {
        if (!apt.draper) continue;
        const d = Math.hypot(_cam.x - apt.meta.origin[0], _cam.z - apt.meta.origin[1]);
        if (d < (apt.meta.radius || 3000) + 7000 && d < bestD) { best = apt; bestD = d; }
      }
      if (best) {
        best.drapeDue -= dt;
        if (best.drapeDue <= 0 || best.draper.busy) {
          if (best.draper.step(4000)) {
            best.drapeDue = best.draper.changed ? 1.5 : 6.0;
            best.draper.changed = false;
          }
        }
      }
      updateLights(lightMeshes, { time: state.time, day, camera, renderer: ctx.renderer, scene: ctx.scene });
    },
    heightAt(x, z) { return colliders.heightAt(x, z); },
    hitTest(x, y, z, r) { return colliders.hitTest(x, y, z, r); },
  };
}

// ---------------------------------------------------------------- collisions
// Buildings (extruded footprints), jet bridges (capsules), towers (cylinders) and parked aircraft (oriented boxes)
// in a uniform 64 m grid. heightAt returns the tallest top covering (x, z); hitTest checks a sphere.
export class Colliders {
  constructor() { this.cell = 64; this.grid = new Map(); this.items = []; }
  _key(i, j) { return i * 100003 + j; }
  add(item) {
    // item: { minX, maxX, minZ, maxZ, base, top, name, test(x,z,r) -> bool (2D inside/within r), ground?() }
    // with item.ground set, base/top are relative to the (current) terrain height at the item's anchor
    this.items.push(item);
    const c = this.cell;
    for (let i = Math.floor(item.minX / c); i <= Math.floor(item.maxX / c); i++) {
      for (let j = Math.floor(item.minZ / c); j <= Math.floor(item.maxZ / c); j++) {
        const k = this._key(i, j);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(item);
      }
    }
    return item;
  }
  addPolygon(pts, base, top, name) {
    // pts: [[x,z],...] world coordinates
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const flat = new Float64Array(pts.flat());
    this.add({ minX, maxX, minZ, maxZ, base, top, name, test: (x, z, r) => polyDist(flat, x, z) <= r });
  }
  addCapsule(ax, az, bx, bz, rad, base, top, name) {
    this.add({
      minX: Math.min(ax, bx) - rad, maxX: Math.max(ax, bx) + rad, minZ: Math.min(az, bz) - rad, maxZ: Math.max(az, bz) + rad, base, top, name,
      test: (x, z, r) => segDist(ax, az, bx, bz, x, z) <= rad + r,
    });
  }
  addCircle(cx, cz, rad, base, top, name) {
    this.add({ minX: cx - rad, maxX: cx + rad, minZ: cz - rad, maxZ: cz + rad, base, top, name, test: (x, z, r) => Math.hypot(x - cx, z - cz) <= rad + r });
  }
  addBox(cx, cz, hdg, halfLen, halfWid, base, top, name) {
    const s = Math.sin(hdg), c = Math.cos(hdg);
    const R = Math.hypot(halfLen, halfWid);
    return this.add({
      minX: cx - R, maxX: cx + R, minZ: cz - R, maxZ: cz + R, base, top, name,
      test: (x, z, r) => {
        const dx = x - cx, dz = z - cz;
        const along = dx * s - dz * c, across = dx * c + dz * s;
        const ex = Math.max(Math.abs(along) - halfLen, 0), ey = Math.max(Math.abs(across) - halfWid, 0);
        return Math.hypot(ex, ey) <= r;
      },
    });
  }
  addAirport(meta, ctx) {
    const [ox, oz] = meta.origin;
    const T = ctx.terrain;
    const rel = (item, ax, az) => { item.ground = () => T.getHeight(ax, az); return item; };
    for (const b of meta.buildings || []) {
      const pts = b.poly.map(([x, z]) => [x + ox, z + oz]);
      this.addPolygon(pts, b.minh || 0, b.h, b.name);
      rel(this.items[this.items.length - 1], b.anchor[0] + ox, b.anchor[1] + oz);
    }
    for (const j of meta.jetbridges || []) {
      const c = j.c;
      for (let k = 0; k + 1 < c.length; k++) {
        const ax = c[k][0] + ox, az = c[k][1] + oz, bx = c[k + 1][0] + ox, bz = c[k + 1][1] + oz;
        this.addCapsule(ax, az, bx, bz, 1.8, 2.5, 7.5, 'yolcu köprüsü');
        rel(this.items[this.items.length - 1], ax, az);
      }
    }
    for (const s of meta.structures || []) {
      if (s.collide) {
        const [x, z, r, h] = s.collide;
        this.addCircle(x + ox, z + oz, r, 0, h, s.name || 'kule');
        rel(this.items[this.items.length - 1], x + ox, z + oz);
      }
    }
  }
  heightAt(x, z) {
    const l = this.grid.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!l) return -Infinity;
    let h = -Infinity;
    for (const it of l) {
      if (it.off || x < it.minX || x > it.maxX || z < it.minZ || z > it.maxZ) continue;
      const top = it.ground ? it.ground() + it.top : it.top;
      if (top <= h) continue;
      if (it.test(x, z, 0)) h = top;
    }
    return h;
  }
  hitTest(x, y, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const l = this.grid.get(this._key(i, j));
        if (!l) continue;
        for (const it of l) {
          if (it.off || x + r < it.minX || x - r > it.maxX || z + r < it.minZ || z - r > it.maxZ) continue;
          const g = it.ground ? it.ground() : 0;
          if (y - r > g + it.top || y + r < g + it.base) continue;
          if (it.test(x, z, r)) return it.name;
        }
      }
    }
    return null;
  }
}

function segDist(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

function polyDist(f, x, z) {
  // 0 inside, else distance to the boundary
  let inside = false, d = Infinity;
  const n = f.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = f[2 * i], zi = f[2 * i + 1], xj = f[2 * j], zj = f[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    d = Math.min(d, segDist(xi, zi, xj, zj, x, z));
  }
  return inside ? 0 : d;
}
