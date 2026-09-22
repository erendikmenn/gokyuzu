// The world: island terrain, ocean + lake, sky / fog / lights, runway, trees, town, clouds.
// See CONTRACTS.md (Agent B) for the public interface.
import { WORLD, RUNWAY } from '../config.js';
import { generateTerrain, lakeMetric, GRID_N } from './terrain.js';
import { createTerrainMesh } from './terrainMesh.js';
import { createSky } from './sky.js';
import { createWater } from './water.js';
import { createRunway } from './runway.js';
import { createTrees } from './trees.js';
import { createTown } from './town.js';
import { createClouds } from './clouds.js';

export function createWorld(scene, renderer) {
  const t0 = performance.now();
  const terrain = generateTerrain();
  const tGen = performance.now();

  const sky = createSky(scene, renderer);
  const terrainMesh = createTerrainMesh(terrain, renderer);
  scene.add(terrainMesh.group);
  const water = createWater(terrain, sky);
  scene.add(water.group);
  const runway = createRunway(renderer);
  scene.add(runway.group);
  const town = createTown(terrain, renderer);
  scene.add(town.group);
  const trees = createTrees(terrain, [town.excluder]);
  scene.add(trees.group);
  const clouds = createClouds(sky);
  scene.add(clouds.mesh);

  // ---- queries -------------------------------------------------------------------------
  const H = terrain.heights;
  const V = GRID_N + 1;
  const HALF = WORLD.size / 2;
  const INV = GRID_N / WORLD.size;
  const SEA = WORLD.seaLevel;
  const LAKE = terrain.lakeLevel;
  const TOP = Math.max(LAKE, SEA); // above this no water can exist
  const L = terrain.layout.lake;
  const lakeR = Math.max(L.rx, L.rz) * 2.1;

  /** Raw terrain surface height, interpolated exactly like the rendered triangles. */
  function terrainHeight(x, z) {
    const gx = (x + HALF) * INV;
    const gz = (z + HALF) * INV;
    if (!(gx >= 0 && gz >= 0 && gx < GRID_N && gz < GRID_N)) return -80;
    const ix = gx | 0, iz = gz | 0;
    const fx = gx - ix, fz = gz - iz;
    const i = iz * V + ix;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + V], h11 = H[i + V + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Water surface level at (x, z): the lake level inside the lake basin, else sea level. */
  function waterLevelAt(x, z) {
    const dx = x - L.x, dz = z - L.z;
    if (dx * dx + dz * dz < lakeR * lakeR && lakeMetric(x, z) < 2) return LAKE;
    return SEA;
  }

  function getGroundHeight(x, z) {
    const h = terrainHeight(x, z);
    if (h >= TOP) return h;
    const wl = waterLevelAt(x, z);
    return h > wl ? h : wl;
  }

  function isWater(x, z) {
    const h = terrainHeight(x, z);
    if (h >= TOP) return false;
    return h < waterLevelAt(x, z);
  }

  function isOnRunway(x, z) {
    return Math.abs(x - RUNWAY.x) <= RUNWAY.width / 2 && Math.abs(z - RUNWAY.z) <= RUNWAY.length / 2;
  }

  // ---- per-frame --------------------------------------------------------------------------
  function update(dt, camera) {
    sky.update(dt, camera);
    water.update(dt, camera);
    runway.update(dt, camera);
    trees.update(camera);
    clouds.update(dt, camera);
  }

  const tEnd = performance.now();
  console.info(`world: terrain ${(tGen - t0).toFixed(0)} ms, total ${(tEnd - t0).toFixed(0)} ms, ${trees.count} trees, ${clouds.count} cloud puffs`);

  return {
    getGroundHeight,
    isWater,
    isOnRunway,
    sunDirection: sky.sunDirection,
    update,
    // extras (not part of the contract, handy for missions / debugging)
    terrainHeight,
    layout: terrain.layout,
    lakeLevel: LAKE,
  };
}
