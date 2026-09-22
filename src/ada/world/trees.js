// Low-poly conifers and round deciduous trees as InstancedMeshes, split into a 4×4 grid of
// spatial chunks (per-chunk frustum culling, and the shadow pass only draws nearby chunks).
// Placement: jittered grid, probability from the forest-density mask, plus scattered lone
// trees / hedgerow trees; never on water, beach, runway zone, approach paths, roads or town.
import * as THREE from 'three';
import { RUNWAY } from '../config.js';
import { hash2, mulberry32 } from './noise.js';
import { sampleGrid, runwayRectDist, roadDistance, lakeMetric, clearZone } from './terrain.js';

const CHUNKS = 4;
const MAX_TREES = 70000;

function srgb(hex) { return new THREE.Color(hex); }

/** Merge simple (possibly indexed) geometries into one non-indexed geometry with a color attribute. */
function mergeColored(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nor.push(n[i], n[i + 1], n[i + 2]);
      col.push(color.r, color.g, color.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

function jitter(geo, amount, seed) {
  const rand = mulberry32(seed);
  const p = geo.attributes.position;
  // Deterministic per-position jitter so shared vertices stay welded.
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) { d = [(rand() - 0.5) * amount, (rand() - 0.5) * amount, (rand() - 0.5) * amount]; map.set(key, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  return geo;
}

function coniferGeometry() {
  const trunk = srgb('#5a4330');
  const g1 = srgb('#2c4a26'), g2 = srgb('#2f5229'), g3 = srgb('#35592d');
  return mergeColored([
    { geo: new THREE.CylinderGeometry(0.03, 0.045, 0.22, 5, 1, true).translate(0, 0.11, 0), color: trunk },
    { geo: new THREE.ConeGeometry(0.3, 0.46, 8, 1, false).translate(0, 0.36, 0), color: g1 },
    { geo: new THREE.ConeGeometry(0.235, 0.4, 8, 1, true).translate(0, 0.6, 0), color: g2 },
    { geo: new THREE.ConeGeometry(0.16, 0.36, 7, 1, true).translate(0, 0.82, 0), color: g3 },
  ]);
}

function deciduousGeometry() {
  const trunk = srgb('#5e4632');
  const leaf = srgb('#4a6e2a'), leaf2 = srgb('#557a30');
  const crown = jitter(new THREE.IcosahedronGeometry(0.34, 1), 0.07, 3).scale(1, 0.85, 1).translate(0, 0.62, 0);
  const crown2 = jitter(new THREE.IcosahedronGeometry(0.22, 0), 0.05, 7).translate(0.14, 0.8, 0.06);
  return mergeColored([
    { geo: new THREE.CylinderGeometry(0.035, 0.05, 0.42, 5, 1, true).translate(0, 0.21, 0), color: trunk },
    { geo: crown, color: leaf },
    { geo: crown2, color: leaf2 },
  ]);
}

function coniferLowGeometry() {
  return mergeColored([
    { geo: new THREE.CylinderGeometry(0.03, 0.045, 0.2, 4, 1, true).translate(0, 0.1, 0), color: srgb('#5a4330') },
    { geo: new THREE.ConeGeometry(0.29, 0.86, 6, 1, true).translate(0, 0.55, 0), color: srgb('#2f5229') },
  ]);
}

function deciduousLowGeometry() {
  return mergeColored([
    { geo: new THREE.CylinderGeometry(0.035, 0.05, 0.42, 4, 1, true).translate(0, 0.21, 0), color: srgb('#5e4632') },
    { geo: new THREE.IcosahedronGeometry(0.37, 0).scale(1, 0.9, 1).translate(0, 0.66, 0), color: srgb('#4d712c') },
  ]);
}

const LOD_DIST = 2200; // m from the camera to a chunk's bounding box → low-poly trees beyond

export function createTrees(terrain, excluders = []) {
  const { heights, forest, V, cell, half, size } = terrain;
  const T = terrain.layout.town;
  const L = terrain.layout.lake;
  const lakeLevel = terrain.lakeLevel;

  const forestAt = (x, z) => {
    const gx = (x + half) / cell, gz = (z + half) / cell;
    const ix = Math.min(V - 2, Math.max(0, gx | 0)), iz = Math.min(V - 2, Math.max(0, gz | 0));
    const fx = gx - ix, fz = gz - iz;
    const i = iz * V + ix;
    const a = forest[i], b = forest[i + 1], c = forest[i + V], d = forest[i + V + 1];
    return ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz) / 255;
  };

  // Per chunk & type instance lists.
  const lists = [];
  for (let i = 0; i < CHUNKS * CHUNKS; i++) lists.push({ conifer: [], decid: [] });
  const chunkSize = size / CHUNKS;

  const STEP = 10.5;
  const n = Math.floor(size / STEP);
  const cand = []; // x, y, z, scale, rot, variation, isConifer
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const r0 = hash2(gx, gz, 11);
      const x = -half + (gx + hash2(gx, gz, 1)) * STEP;
      const z = -half + (gz + hash2(gx, gz, 2)) * STEP;
      const fd = forestAt(x, z);
      // dense cores, sparse edges, very rare lone trees in open country
      let p = Math.pow(fd, 1.6) * 0.62;
      if (fd < 0.05) p = 0.0025;
      if (r0 >= p) continue;

      const h = sampleGrid(heights, x, z);
      if (h < 3.5 || h > 700) continue;
      if (runwayRectDist(x, z) < 330) continue;
      if (clearZone(x, z) > 0.01) continue;   // approach corridors + airport side
      if (Math.hypot(x - T.x, z - T.z) < T.radius + 70) continue;
      if (roadDistance(x, z) < 13) continue;
      if (Math.abs(x - L.x) < 2000 && Math.abs(z - L.z) < 2000 && h < lakeLevel + 2.5 && lakeMetric(x, z) < 2) continue;
      let skip = false;
      for (const ex of excluders) if (ex(x, z)) { skip = true; break; }
      if (skip) continue;
      // slope check (steep rock faces stay bare)
      const hx = sampleGrid(heights, x + 4, z) - h, hz = sampleGrid(heights, x, z + 4) - h;
      if (hx * hx + hz * hz > 16 * 0.9) continue;

      const r1 = hash2(gx, gz, 21), r2 = hash2(gx, gz, 22), r3 = hash2(gx, gz, 23);
      const coniferP = 0.18 + 0.75 * Math.min(1, Math.max(0, (h - 120) / 320)) + (z < -1500 ? 0.15 : 0);
      const isConifer = r1 < coniferP ? 1 : 0;
      const s = isConifer ? 10 + r2 * 9 : 7 + r2 * 6;
      cand.push(x, h - 0.3, z, s, r3 * Math.PI * 2, hash2(gx, gz, 24), isConifer);
    }
  }
  // Uniform thinning if there are more candidates than the budget.
  const total = cand.length / 7;
  const keep = Math.min(1, MAX_TREES / total);
  let count = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 7;
    if (keep < 1 && hash2(i, 7, 99) > keep) continue;
    const x = cand[o], z = cand[o + 2];
    const ci = Math.min(CHUNKS - 1, Math.floor((x + half) / chunkSize)) + CHUNKS * Math.min(CHUNKS - 1, Math.floor((z + half) / chunkSize));
    (cand[o + 6] ? lists[ci].conifer : lists[ci].decid).push(cand[o], cand[o + 1], cand[o + 2], cand[o + 3], cand[o + 4], cand[o + 5]);
    count++;
  }

  const coniferGeo = coniferGeometry();
  const decidGeo = deciduousGeometry();
  const coniferLow = coniferLowGeometry();
  const decidLow = deciduousLowGeometry();
  const chunks = []; // { box, high: [], low: [] }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });

  const group = new THREE.Group();
  group.name = 'trees';
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const color = new THREE.Color();
  for (let ci = 0; ci < lists.length; ci++) {
    const chunk = { box: new THREE.Box3(), high: [], low: [] };
    chunks.push(chunk);
    for (const type of ['conifer', 'decid']) {
      const arr = lists[ci][type];
      const k = arr.length / 6;
      if (!k) continue;
      const mesh = new THREE.InstancedMesh(type === 'conifer' ? coniferGeo : decidGeo, material, k);
      for (let i = 0; i < k; i++) {
        const o = i * 6;
        const s = arr[o + 3];
        pos.set(arr[o], arr[o + 1], arr[o + 2]);
        q.setFromAxisAngle(up, arr[o + 4]);
        const wide = type === 'conifer' ? 0.9 + arr[o + 5] * 0.25 : 0.85 + arr[o + 5] * 0.4;
        sc.set(s * wide, s, s * wide);
        m4.compose(pos, q, sc);
        mesh.setMatrixAt(i, m4);
        // color variation: slight hue/brightness shifts (multiplies the vertex colors)
        const v = arr[o + 5];
        color.setRGB(0.82 + v * 0.3, 0.85 + ((v * 7.13) % 1) * 0.25, 0.8 + ((v * 3.7) % 1) * 0.2);
        if (type === 'decid' && ((v * 13.7) % 1) > 0.8) color.multiply(new THREE.Color(1.25, 1.05, 0.7)); // yellowish
        mesh.setColorAt(i, color);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      mesh.name = `trees_${type}_${ci}`;
      group.add(mesh);
      // Low-poly twin sharing the same instance buffers (uploaded once).
      const low = new THREE.InstancedMesh(type === 'conifer' ? coniferLow : decidLow, material, k);
      low.instanceMatrix = mesh.instanceMatrix;
      low.instanceColor = mesh.instanceColor;
      low.boundingSphere = mesh.boundingSphere.clone();
      low.boundingBox = mesh.boundingBox.clone();
      low.castShadow = false;
      low.receiveShadow = false;
      low.visible = false;
      low.name = `treesLow_${type}_${ci}`;
      group.add(low);
      chunk.box.union(mesh.boundingBox);
      chunk.high.push(mesh);
      chunk.low.push(low);
    }
  }
  group.userData.count = count;

  function update(camera) {
    if (!camera) return;
    const p = camera.position;
    for (const c of chunks) {
      if (c.box.isEmpty()) continue;
      const near = c.box.distanceToPoint(p) < LOD_DIST;
      for (const m of c.high) m.visible = near;
      for (const m of c.low) m.visible = !near;
    }
  }
  return { group, count, update };
}
