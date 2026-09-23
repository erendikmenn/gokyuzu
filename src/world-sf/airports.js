// W4 airports layer: SFO (KSFO), Oakland (KOAK) and the fictional military air base "Alameda Hava Üssü" (KNGZ).
// Data: assets/sf/airports/<icao>.json + .bin (tools/geo/airports_build.py), buildings/props GLBs (blender/airports/*).
// Everything is draped on ctx.terrain (getHeight + small offsets); the layer implements the contract Layer interface.
import * as THREE from 'three';
import { readArrays, buildGround, buildStructures } from './airports_ground.js';
import { buildLights, updateLights } from './airports_lights.js';
import { buildSigns } from './airports_signs.js';
import { loadBuildings, updateBuildingLights } from './airports_buildings.js';
import { buildProps, updateProps } from './airports_props.js';
import { buildFence, buildCables, buildFloodPools } from './airports_extras.js';
import { Draper, meshJob, lightsJob, instancedJob, rigidJob } from './airports_drape.js';

const BASE = 'assets/sf/airports/';
const ICAOS = ['ksfo', 'kngz', 'koak'];

export async function createAirports(ctx) {
  const group = new THREE.Group();
  group.name = 'airports';
  const airports = [];
  const lightMeshes = [];
  const colliders = new Colliders();
  const state = { time: 0, day: 1, dayOverride: null, sunCheck: 0, sun: null };
  const focus = ctx.focus || { x: 0, z: 0 };

  const loadMeta = async (icao) => {
    const meta = await ctx.loader.loadJSON(BASE + icao + '.json');
    const buf = await ctx.loader.loadBinary(BASE + meta.bin);
    return { meta, A: readArrays(meta, buf) };
  };
  // nearest airport first so the spawn area is ready first
  const order = ICAOS.slice();
  const metas = {};

  const timing = { t0: performance.now() };
  let resolveFirst;
  const firstReady = new Promise((r) => { resolveFirst = r; });
  const all = (async () => {
    if (ctx.terrain && ctx.terrain.ready) {
      await Promise.race([Promise.resolve(ctx.terrain.ready).catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
    }
    const loaded = await Promise.all(order.map((i) => loadMeta(i).catch((e) => { console.warn('[airports]', i, e.message); return null; })));
    loaded.forEach((l, k) => { if (l) metas[order[k]] = l; });
    const dist = (m) => Math.hypot(m.meta.origin[0] - focus.x, m.meta.origin[1] - focus.z);
    const list = Object.values(metas).sort((a, b) => dist(a) - dist(b));
    for (const [n, { meta, A }] of list.entries()) {
      if (n === 1) { timing.first = performance.now() - timing.t0; resolveFirst(); }
      const apt = { meta, root: new THREE.Group(), lights: null, fixtures: [], buildings: null, props: null };
      apt.root.name = `airport-${meta.icao}`;
      const gridRot = meta.icao === 'KSFO' ? -27.42 * Math.PI / 180 : meta.icao === 'KNGZ' ? -75 * Math.PI / 180 : -21.7 * Math.PI / 180;
      const { group: ground } = buildGround(meta, A, ctx, { gridRot });
      apt.root.add(ground);
      const structs = buildStructures(meta, A, ctx);
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
      colliders.addAirport(meta, ctx);
      group.add(apt.root);
      airports.push(apt);
      try {
        apt.buildings = await loadBuildings(meta, ctx, colliders);
        if (apt.buildings) apt.root.add(apt.buildings.object);
      } catch (e) { console.warn('[airports] buildings', meta.icao, e); }
      try {
        apt.props = await buildProps(meta, ctx, colliders);
        if (apt.props) apt.root.add(apt.props.object);
      } catch (e) { console.warn('[airports] props', meta.icao, e); }
      // re-draping jobs (terrain LOD refines as the camera approaches)
      try {
        const O = meta.origin;
        const dr = new Draper(ctx.terrain);
        ground.traverse((o) => { if (o.isMesh && o.userData.off != null) dr.add(meshJob(o, O, o.userData.off)); });
        if (apt.lights) dr.add(lightsJob(apt.lights, O, apt.lights.userData.heights, apt.lights.userData.modes, ctx.terrain.isWater ? (x, z) => ctx.terrain.isWater(x, z) : null));
        structs.traverse((o) => { if (o.isInstancedMesh && o.userData.drapeDy != null) dr.add(instancedJob(o, O, o.userData.drapeDy)); });
        if (apt.pools) dr.add(instancedJob(apt.pools, O, 0.12));
        if (apt.signMat) apt.root.traverse((o) => { if (o.userData.drapeGroups && o.userData.drapeGroups.length) dr.add(rigidJob(o.userData.drapeGroups)); });
        if (apt.buildings && apt.buildings.drapeGroups.length) dr.add(rigidJob(apt.buildings.drapeGroups));
        if (apt.props) {
          dr.add(apt.props.drapeJob);
          for (const lm of apt.props.lampMeshes) dr.add(instancedJob(lm, O, 0));
        }
        apt.draper = dr;
        apt.drapeDue = 0;
      } catch (e) { console.warn('[airports] drape', meta.icao, e); }
      group.updateMatrixWorld(true);
    }
    timing.all = performance.now() - timing.t0;
    resolveFirst();
  })();
  // the layer is "ready" once the airport nearest to the spawn is complete; the others stream in afterwards
  const ready = firstReady;
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
    /** Force the light/day factor (0 = night … 1 = day); null returns to automatic (sun elevation). */
    setDaylight(v) { state.dayOverride = v; },
    update(dt, camera) {
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
        apt.root.visible = d < R + 30000;
        if (!apt.root.visible) continue;
        for (const f of apt.fixtures) {
          // fixture meshes are small: show them only when the camera is close to (some part of) the field
          f.visible = d < R + f.userData.lodDist;
        }
        if (apt.buildings) updateBuildingLights(apt.buildings, day, d, _cam);
        if (apt.pools) apt.pools.userData.setNight(1 - day);
        if (apt.signMat) apt.signMat.emissiveIntensity = (1 - day) * 0.9;
        if (apt.props) {
          // distance LOD: parked aircraft / vehicles are invisible specks beyond ~8 km
          apt.props.object.visible = d < R + 8000;
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
    this.add({
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
      if (x < it.minX || x > it.maxX || z < it.minZ || z > it.maxZ) continue;
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
          if (x + r < it.minX || x - r > it.maxX || z + r < it.minZ || z - r > it.maxZ) continue;
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
