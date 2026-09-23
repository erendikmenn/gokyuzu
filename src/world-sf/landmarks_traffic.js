// W3: moving traffic on the bridges. Lanes come from the landmark metadata (index.json: def.traffic, local polylines in
// driving order); vehicles are the Blender-made low-poly models in assets/sf/landmarks/cars.glb, drawn as one
// InstancedMesh per vehicle type (4 draw calls in total), updated only for landmarks near the camera.
import * as THREE from 'three';

const TYPES = [
  { node: 'car_sedan', w: 0.52, len: 4.7 },
  { node: 'car_suv', w: 0.33, len: 4.9 },
  { node: 'car_truck', w: 0.10, len: 8.8 },
  { node: 'car_bus', w: 0.05, len: 12.2 },
];
// US fleet colors (linear-ish sRGB): white, black, greys, silver, blue, red, beige, green
const COLORS = [
  [0.92, 0.92, 0.9, 0.24], [0.05, 0.05, 0.055, 0.2], [0.35, 0.36, 0.37, 0.14], [0.62, 0.63, 0.64, 0.14],
  [0.12, 0.2, 0.42, 0.09], [0.55, 0.06, 0.05, 0.09], [0.66, 0.6, 0.5, 0.05], [0.12, 0.26, 0.16, 0.05],
];
const ACTIVE_DIST = 3800;      // m from the landmark bounds

function pick(rnd, table, key = 'w') {
  let r = rnd() * table.reduce((a, t) => a + (Array.isArray(t) ? t[3] : t[key]), 0);
  for (const t of table) { r -= Array.isArray(t) ? t[3] : t[key]; if (r <= 0) return t; }
  return table[table.length - 1];
}

function mulberry(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export async function createTraffic(ctx, items, prepare) {
  const lanes = [];
  for (const it of items) {
    for (const ln of it.def.traffic || []) {
      const n = ln.p.length;
      const pts = new Float32Array(n * 3);
      const cum = new Float32Array(n);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.set(ln.p[i][0], ln.p[i][1], ln.p[i][2]).applyMatrix4(it.group.matrixWorld);
        pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
        if (i) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 2] - pts[i * 3 - 1]);
      }
      lanes.push({ it, pts, cum, len: cum[n - 1], speed: ln.v, gap: ln.gap || [22, 70], cars: [] });
    }
  }
  if (!lanes.length) return null;
  let gltf;
  try { gltf = await ctx.loader.loadGLTF('assets/sf/landmarks/cars.glb'); } catch (e) { console.warn('[landmarks] no cars.glb', e); return null; }
  const root = new THREE.Group();
  root.name = 'landmark_traffic';
  const scene = gltf.scene.parent ? gltf.scene.clone() : gltf.scene;
  prepare(scene);
  const meshes = TYPES.map((t) => {
    const src = scene.getObjectByName(t.node);
    return src && src.isMesh ? src : (src && src.children.find((c) => c.isMesh)) || null;
  });

  // populate lanes with vehicles at random gaps (deterministic)
  const rnd = mulberry(1234567);
  const counts = TYPES.map(() => 0);
  for (const L of lanes) {
    let s = rnd() * L.gap[1];
    while (s < L.len) {
      const ti = TYPES.indexOf(pick(rnd, TYPES));
      const c = pick(rnd, COLORS);
      const tint = 0.85 + 0.3 * rnd();
      L.cars.push({ s, type: ti, r: c[0] * tint, g: c[1] * tint, b: c[2] * tint, keep: rnd() });
      counts[ti]++;
      s += TYPES[ti].len + L.gap[0] + rnd() * (L.gap[1] - L.gap[0]);
    }
  }
  const inst = TYPES.map((t, k) => {
    if (!meshes[k]) return null;
    const im = new THREE.InstancedMesh(meshes[k].geometry, meshes[k].material, Math.max(1, counts[k]));
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.setColorAt(0, new THREE.Color(1, 1, 1));
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = true;
    im.name = `traffic_${t.node}`;
    root.add(im);
    return im;
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const n = inst.map(() => 0);

  function place(L, car, k) {
    // binary search the segment
    let lo = 0, hi = L.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L.cum[mid] <= car.s) lo = mid; else hi = mid; }
    const t = (car.s - L.cum[lo]) / Math.max(1e-3, L.cum[hi] - L.cum[lo]);
    const a = lo * 3, b = hi * 3;
    p.set(L.pts[a] + (L.pts[b] - L.pts[a]) * t, L.pts[a + 1] + (L.pts[b + 1] - L.pts[a + 1]) * t, L.pts[a + 2] + (L.pts[b + 2] - L.pts[a + 2]) * t);
    const dx = L.pts[b] - L.pts[a], dz = L.pts[b + 2] - L.pts[a + 2];
    q.setFromAxisAngle(up, Math.atan2(-dx, -dz));       // model forward = -Z (Blender +Y)
    m.compose(p, q, sc);
    inst[car.type].setMatrixAt(k, m);
    col.setRGB(car.r, car.g, car.b);
    inst[car.type].setColorAt(k, col);
  }

  const active = new Set();
  let density = 1;
  return {
    object: root,
    /** Fraction of the vehicles drawn (quality: low 0.35, medium 0.7, high/ultra 1). */
    setDensity(d) { density = Math.max(0, Math.min(1, d)); },
    update(dt, camPos) {
      n.fill(0);
      active.clear();
      for (const L of lanes) {
        if (!active.has(L.it)) {
          if (L.it.distanceTo(camPos) > ACTIVE_DIST) continue;
          active.add(L.it);
        }
      }
      for (const L of lanes) {
        if (!active.has(L.it)) continue;
        const ds = L.speed * dt;
        for (const car of L.cars) {
          car.s += ds;
          if (car.s > L.len) car.s -= L.len;
          const im = inst[car.type];
          if (!im || car.keep > density) continue;
          place(L, car, n[car.type]++);
        }
      }
      inst.forEach((im, k) => {
        if (!im) return;
        im.count = n[k];
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      });
    },
  };
}
