// Coastal town: street grid of houses (pitched terracotta roofs) and a few apartment blocks, a
// mosque with a minaret on the central square, a harbor pier with moored boats, a lighthouse on
// the headland, and the road to the airport. All buildings are merged into ONE mesh (1 draw call);
// roads/streets are two more meshes.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { sampleGrid, pointOnPoly } from './terrain.js';
import { makeFacadeTexture, makeAsphaltTexture } from './textures.js';

const WALLS = ['#f3eee3', '#efe2c6', '#ead3b2', '#f1dccb', '#e2e8ea', '#f3e6a8', '#f6f1ea', '#e7d9c9'];
const ROOFS = ['#b4532f', '#a8492a', '#c2653b', '#9c4a31', '#b85c35'];
const PLAIN_UV = [0.05, 0.05];

class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
  tri(a, b, c, n, ua, ub, uc, col) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.nor.push(n[0], n[1], n[2]);
    this.uv.push(...ua, ...ub, ...uc);
    for (let i = 0; i < 3; i++) this.col.push(col.r, col.g, col.b);
  }
  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a, b, c, d, col, uvs = null) {
    const e1 = sub(b, a), e2 = sub(d, a);
    const n = norm(cross(e1, e2));
    const [ua, ub, uc, ud] = uvs || [PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV];
    this.tri(a, b, c, n, ua, ub, uc, col);
    this.tri(a, c, d, n, ua, uc, ud, col);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Oriented box building. (cx, cz) center, yaw rotation, w (local x) × d (local z), walls from y0 to y1.
 * roof: 'gable' | 'flat' | 'none'.
 */
function building(B, cx, cz, yaw, w, d, y0, y1, wallCol, roofCol, roof = 'gable', roofH = 3, facade = true) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx, y, lz) => [cx + lx * c + lz * s, y, cz - lx * s + lz * c];
  const hw = w / 2, hd = d / 2;
  const floors = (y1 - y0) / 3.0;
  const wallUV = (len) => {
    const bays = Math.max(1, Math.round(len / 3.3));
    return facade ? [[0, 0], [bays, 0], [bays, floors], [0, floors]] : null;
  };
  // corners (counter-clockwise from above): front = +z side
  const c0 = [-hw, hd], c1 = [hw, hd], c2 = [hw, -hd], c3 = [-hw, -hd];
  const edges = [[c0, c1, w], [c1, c2, d], [c2, c3, w], [c3, c0, d]];
  for (const [a, b, len] of edges) {
    B.quad(P(a[0], y0, a[1]), P(b[0], y0, b[1]), P(b[0], y1, b[1]), P(a[0], y1, a[1]), wallCol, wallUV(len));
  }
  if (roof === 'flat') {
    B.quad(P(c0[0], y1, c0[1]), P(c1[0], y1, c1[1]), P(c2[0], y1, c2[1]), P(c3[0], y1, c3[1]), roofCol);
    // small parapet rim
    const r = 0.5;
    for (const [a, b] of [[c0, c1], [c1, c2], [c2, c3], [c3, c0]]) {
      B.quad(P(a[0], y1, a[1]), P(b[0], y1, b[1]), P(b[0], y1 + r, b[1]), P(a[0], y1 + r, a[1]), wallCol);
      B.quad(P(b[0] * 0.97, y1, b[1] * 0.97), P(a[0] * 0.97, y1, a[1] * 0.97), P(a[0] * 0.97, y1 + r, a[1] * 0.97), P(b[0] * 0.97, y1 + r, b[1] * 0.97), wallCol);
    }
  } else if (roof === 'gable') {
    // ridge along the longer local axis, small eave overhang
    const o = 0.5;
    const alongX = w >= d;
    const yr = y1 + roofH;
    if (alongX) {
      const r0 = P(-hw - o, yr, 0), r1 = P(hw + o, yr, 0);
      B.quad(P(-hw - o, y1 - 0.3, hd + o), P(hw + o, y1 - 0.3, hd + o), r1, r0, roofCol);
      B.quad(P(hw + o, y1 - 0.3, -hd - o), P(-hw - o, y1 - 0.3, -hd - o), r0, r1, roofCol);
      const g0 = P(-hw, yr - 0.02, 0), g1 = P(hw, yr - 0.02, 0);
      B.tri(P(-hw, y1, hd), g0, P(-hw, y1, -hd), norm(sub(P(-1, 0, 0), P(0, 0, 0))), PLAIN_UV, PLAIN_UV, PLAIN_UV, wallCol);
      B.tri(P(hw, y1, -hd), g1, P(hw, y1, hd), norm(sub(P(1, 0, 0), P(0, 0, 0))), PLAIN_UV, PLAIN_UV, PLAIN_UV, wallCol);
    } else {
      const r0 = P(0, yr, -hd - o), r1 = P(0, yr, hd + o);
      B.quad(P(hw + o, y1 - 0.3, hd + o), P(hw + o, y1 - 0.3, -hd - o), r0, r1, roofCol);
      B.quad(P(-hw - o, y1 - 0.3, -hd - o), P(-hw - o, y1 - 0.3, hd + o), r1, r0, roofCol);
      const g0 = P(0, yr - 0.02, hd), g1 = P(0, yr - 0.02, -hd);
      B.tri(P(-hw, y1, hd), P(hw, y1, hd), g0, norm(sub(P(0, 0, 1), P(0, 0, 0))), PLAIN_UV, PLAIN_UV, PLAIN_UV, wallCol);
      B.tri(P(hw, y1, -hd), P(-hw, y1, -hd), g1, norm(sub(P(0, 0, -1), P(0, 0, 0))), PLAIN_UV, PLAIN_UV, PLAIN_UV, wallCol);
    }
    // underside of eaves is not needed (never seen from below at gameplay distances)
  }
}

/** Vertical cylinder / cone frustum (open), optional top cap. */
function cylinder(B, cx, cz, y0, y1, r0, r1, seg, col, cap = false) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p00 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
    const p10 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
    const p01 = [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1];
    const p11 = [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1];
    B.quad(p00, p01, p11, p10, col);
    if (cap && r1 > 0) B.tri([cx, y1, cz], p11, p01, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, col);
  }
}

/** Dome (upper hemisphere). */
function dome(B, cx, cy, cz, r, col, seg = 16, rings = 6) {
  for (let j = 0; j < rings; j++) {
    const t0 = (j / rings) * Math.PI / 2, t1 = ((j + 1) / rings) * Math.PI / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (t, a) => [cx + Math.cos(a) * Math.cos(t) * r, cy + Math.sin(t) * r, cz + Math.sin(a) * Math.cos(t) * r];
      const a = p(t0, a0), b = p(t0, a1), c = p(t1, a1), d = p(t1, a0);
      const mid = norm([(a[0] + c[0]) / 2 - cx, (a[1] + c[1]) / 2 - cy, (a[2] + c[2]) / 2 - cz]);
      B.tri(a, d, c, mid, PLAIN_UV, PLAIN_UV, PLAIN_UV, col);
      B.tri(a, c, b, mid, PLAIN_UV, PLAIN_UV, PLAIN_UV, col);
    }
  }
}

function makeRoadTexture() {
  const W = 64, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a4b4d';
  ctx.fillRect(0, 0, W, H);
  const rand = mulberry32(17);
  for (let i = 0; i < 1400; i++) {
    const v = 60 + Math.floor(rand() * 30);
    ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
    ctx.fillRect(rand() * W, rand() * H, 1.5, 1.5);
  }
  ctx.fillStyle = '#d8d8d0';
  ctx.fillRect(3, 0, 2, H);            // edge lines
  ctx.fillRect(W - 5, 0, 2, H);
  ctx.fillRect(W / 2 - 1, 0, 2, H * 0.4); // center dash
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function createTown(terrain, renderer) {
  const { heights, layout } = terrain;
  const T = layout.town;
  const rand = mulberry32(2024);
  const pick = (arr) => new THREE.Color(arr[Math.floor(rand() * arr.length)]);
  const ground = (x, z) => sampleGrid(heights, x, z);
  const c = Math.cos(T.angle), s = Math.sin(T.angle);
  const toWorld = (u, v) => [T.x + u * c + v * s, T.z - u * s + v * c];

  const B = new Builder();
  const lots = []; // occupied footprints (world-space circles) for exclusion of trees
  const PU = 82, PV = 62, STREET = 8;
  const R = T.radius - 12;

  function place(u, v, yawLocal, w, d, floors, roof, wallCol, roofCol) {
    const [x, z] = toWorld(u, v);
    const yaw = T.angle + yawLocal;
    // footprint corners must be on dry, fairly flat ground
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let lo = Infinity, hi = -Infinity;
    for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, 0]]) {
      const h = ground(x + lx * cy + lz * sy, z - lx * sy + lz * cy);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (lo < 1.8 || hi - lo > 4) return false;
    const y0 = lo - 0.8;
    const y1 = hi + floors * 3.0;
    building(B, x, z, yaw, w, d, y0, y1, wallCol, roofCol, roof, roof === 'gable' ? 1.6 + Math.min(w, d) * 0.22 : 0);
    lots.push([x, z, Math.hypot(w, d) / 2 + 3]);
    return true;
  }

  // ---- blocks -------------------------------------------------------------------------------
  const BU = PU - STREET, BV = PV - STREET;
  for (let i = -5; i <= 5; i++) {
    for (let j = -6; j <= 6; j++) {
      const bu = i * PU, bv = j * PV;
      const dist = Math.hypot(bu, bv);
      if (dist + 20 > R) continue;
      if (i === 0 && j === 0) continue; // central square (mosque)
      if (rand() < 0.1 + 0.25 * Math.max(0, dist / R - 0.6)) continue; // gardens / empty lots, sparser edge
      const central = dist < 150;
      if (central && rand() < 0.75) {
        // apartment blocks: 2 per block
        for (const side of [-1, 1]) {
          const floors = 3 + Math.floor(rand() * 4);
          place(bu + side * BU * 0.25, bv, 0, BU * 0.42, BV * 0.72, floors, 'flat', pick(WALLS), new THREE.Color('#8d8a84'));
        }
        continue;
      }
      // houses along the block perimeter
      const inset = 2.0;
      for (const edge of [0, 1, 2, 3]) {
        const alongU = edge % 2 === 0;
        const len = alongU ? BU : BV;
        const sign = edge < 2 ? 1 : -1;
        let t = -len / 2 + inset + (alongU ? 0 : 11);
        const tEnd = len / 2 - inset - (alongU ? 0 : 11);
        while (t < tEnd - 7) {
          const w = Math.min(tEnd - t, 8 + rand() * 5);
          const d = 7.5 + rand() * 3;
          const center = t + w / 2;
          const off = (alongU ? BV : BU) / 2 - inset - d / 2;
          let u, v, yaw;
          if (alongU) { u = bu + center; v = bv + sign * off; yaw = 0; }
          else { u = bu + sign * off; v = bv + center; yaw = Math.PI / 2; }
          const [hx, hz] = [u, v];
          const edgeSkip = 0.08 + 0.55 * Math.max(0, Math.hypot(hx, hz) / R - 0.7);
          if (rand() > edgeSkip) {
            const floors = 1 + Math.floor(rand() * 2.4);
            place(u, v, yaw, w, d, floors, 'gable', pick(WALLS), pick(ROOFS));
          }
          t += w + 1.5 + rand() * 4;
        }
      }
    }
  }

  // ---- mosque on the central square ----------------------------------------------------------
  {
    const [mx, mz] = toWorld(0, 0);
    const g = ground(mx, mz);
    const white = new THREE.Color('#f1ede4'), lead = new THREE.Color('#7d8a92');
    building(B, mx, mz, T.angle, 20, 20, g - 0.5, g + 9, white, white, 'flat', 0, false);
    cylinder(B, mx, mz, g + 9, g + 11.5, 8.2, 8.2, 20, white);
    dome(B, mx, g + 11.5, mz, 8.2, lead, 20, 7);
    cylinder(B, mx, mz, g + 19.6, g + 21.2, 0.25, 0.1, 6, new THREE.Color('#c9a94a'));
    // small corner half-domes
    for (const [du, dv] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
      const [x, z] = toWorld(du, dv);
      dome(B, x, g + 9, z, 2.6, lead, 10, 3);
    }
    // minaret
    const [nx, nz] = toWorld(13.5, -9);
    cylinder(B, nx, nz, g - 0.5, g + 30, 1.7, 1.5, 12, white);
    cylinder(B, nx, nz, g + 30, g + 31, 2.4, 2.4, 12, white, true);     // balcony
    cylinder(B, nx, nz, g + 31, g + 37, 1.3, 1.25, 12, white);
    cylinder(B, nx, nz, g + 37, g + 43, 1.35, 0.05, 12, lead);          // pencil cone
    lots.push([mx, mz, 22]);
  }

  // ---- harbor pier + boats -------------------------------------------------------------------
  const bay = layout.harbor || { x: 4150, z: 3650 };
  {
    const dx = bay.x - T.x, dz = bay.z - T.z;
    const l = Math.hypot(dx, dz);
    const ux = dx / l, uz = dz / l;
    let t = 0;
    while (t < 2000 && ground(T.x + ux * t, T.z + uz * t) > 0.3) t += 5;
    const sx = T.x + ux * (t - 25), sz = T.z + uz * (t - 25);
    const yaw = Math.atan2(-uz, ux); // local +x along the pier
    const len = 150;
    const px = sx + ux * len / 2, pz = sz + uz * len / 2;
    const concrete = new THREE.Color('#b9b4aa');
    building(B, px, pz, yaw, len, 7, -3, 1.6, concrete, concrete, 'flat', 0, false);
    // T-head
    building(B, sx + ux * (len - 4), sz + uz * (len - 4), yaw, 8, 40, -3, 1.6, concrete, concrete, 'flat', 0, false);
    layout.harbor = { x: sx + ux * len, z: sz + uz * len, pierStart: [sx, sz] };
    // boats moored along the pier
    const hull = [new THREE.Color('#f4f4f2'), new THREE.Color('#2f5f8f'), new THREE.Color('#c7412f'), new THREE.Color('#f0f0e8')];
    for (let k = 0; k < 8; k++) {
      const along = 25 + k * 15 + rand() * 4;
      const side = k % 2 ? 1 : -1;
      const bx = sx + ux * along + (-uz) * side * 8.5 * -1, bz = sz + uz * along + (ux) * side * 8.5 * -1;
      const bw = 8 + rand() * 4, bd = 3 + rand() * 0.8;
      building(B, bx, bz, yaw, bw, bd, -0.4, 0.9, hull[k % hull.length], new THREE.Color('#ddd6c8'), 'flat', 0, false);
      building(B, bx - ux * 1, bz - uz * 1, yaw, bw * 0.35, bd * 0.7, 0.9, 2.4, new THREE.Color('#f7f7f5'), new THREE.Color('#e5e5e0'), 'flat', 0, false);
    }
  }

  // ---- lighthouse ----------------------------------------------------------------------------
  {
    const lh = layout.lighthouse;
    const g = ground(lh.x, lh.z);
    const white = new THREE.Color('#f5f3ee'), red = new THREE.Color('#c23a2c');
    const H = 24, bands = 6;
    for (let k = 0; k < bands; k++) {
      const y0 = g - 1 + (k / bands) * (H + 1), y1 = g - 1 + ((k + 1) / bands) * (H + 1);
      const r0 = 3.4 - (k / bands) * 1.1, r1 = 3.4 - ((k + 1) / bands) * 1.1;
      cylinder(B, lh.x, lh.z, y0, y1, r0, r1, 16, k % 2 ? red : white);
    }
    cylinder(B, lh.x, lh.z, g + H, g + H + 0.6, 3.1, 3.1, 16, new THREE.Color('#333'), true);
    cylinder(B, lh.x, lh.z, g + H + 0.6, g + H + 3.4, 1.7, 1.7, 12, new THREE.Color('#fff4c0'));
    cylinder(B, lh.x, lh.z, g + H + 3.4, g + H + 5.4, 2.0, 0.2, 12, red);
    building(B, lh.x + 8, lh.z + 4, 0.3, 9, 6, g - 1, g + 3.5, white, new THREE.Color('#a8492a'), 'gable', 2.2);
    lots.push([lh.x, lh.z, 16]);
  }

  const facade = makeFacadeTexture();
  const bMat = new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.82, metalness: 0 });
  const buildings = new THREE.Mesh(B.build(), bMat);
  buildings.castShadow = true;
  buildings.receiveShadow = true;
  buildings.name = 'townBuildings';

  // ---- streets (flat town grid) ---------------------------------------------------------------
  const sPos = [], sUv = [];
  const pushQuad = (a, b, c2, d, ua, ub, uc, ud) => {
    sPos.push(...a, ...b, ...c2, ...a, ...c2, ...d);
    sUv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  const yS = T.level + 0.07;
  const street = (u0, v0, u1, v1, width) => {
    const du = u1 - u0, dv = v1 - v0, l = Math.hypot(du, dv);
    const nu = -dv / l * width / 2, nv = du / l * width / 2;
    const p = (u, v) => { const [x, z] = toWorld(u, v); return [x, yS, z]; };
    const tw = (u, v) => { const [x, z] = toWorld(u, v); return [x / 6, z / 6]; };
    const a = [u0 - nu, v0 - nv], b = [u1 - nu, v1 - nv], c2 = [u1 + nu, v1 + nv], d = [u0 + nu, v0 + nv];
    pushQuad(p(...a), p(...d), p(...c2), p(...b), tw(...a), tw(...d), tw(...c2), tw(...b));
  };
  for (let i = -5; i <= 5; i++) {
    const u = (i + 0.5) * PU;
    if (Math.abs(u) >= R) continue;
    const h = Math.sqrt(R * R - u * u);
    street(u, -h, u, h, STREET);
  }
  for (let j = -6; j <= 6; j++) {
    const v = (j + 0.5) * PV;
    if (Math.abs(v) >= R) continue;
    const h = Math.sqrt(R * R - v * v);
    street(-h, v, h, v, STREET);
  }
  // central square paving
  {
    const sq = 30;
    const p = (u, v) => { const [x, z] = toWorld(u, v); return [x, yS - 0.01, z]; };
    const tw = (u, v) => { const [x, z] = toWorld(u, v); return [x / 6, z / 6]; };
    pushQuad(p(-sq, -sq), p(-sq, sq), p(sq, sq), p(sq, -sq), tw(-sq, -sq), tw(-sq, sq), tw(sq, sq), tw(sq, -sq));
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
  sGeo.setAttribute('uv', new THREE.Float32BufferAttribute(sUv, 2));
  sGeo.computeVertexNormals();
  const asphalt = makeAsphaltTexture(renderer);
  const streetMat = new THREE.MeshStandardMaterial({
    map: asphalt, color: new THREE.Color(1.75, 1.7, 1.62), roughness: 0.92,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const streets = new THREE.Mesh(sGeo, streetMat);
  streets.receiveShadow = true;
  streets.name = 'townStreets';

  // ---- road to the airport (follows the terrain) --------------------------------------------
  const road = terrain.roadPoly;
  const rw = layout.roadWidth;
  const rPos = [], rUv = [];
  const STEP = 5;
  const nSteps = Math.ceil(road.length / STEP);
  let prev = null;
  let vAcc = 0;
  for (let k = 0; k <= nSteps; k++) {
    const t = Math.min(road.length, k * STEP);
    const [x, z] = pointOnPoly(road, t);
    const [x2, z2] = pointOnPoly(road, Math.min(road.length, t + 1));
    const [x0, z0] = pointOnPoly(road, Math.max(0, t - 1));
    let dx = x2 - x0, dz = z2 - z0;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = -dz * rw / 2, nz = dx * rw / 2;
    const L = [x - nx, 0, z - nz], Rt = [x + nx, 0, z + nz];
    L[1] = Math.max(ground(L[0], L[2]), ground(x, z)) + 0.12;
    Rt[1] = Math.max(ground(Rt[0], Rt[2]), ground(x, z)) + 0.12;
    const v = vAcc / 12;
    if (prev) {
      rPos.push(...prev.L, ...Rt, ...L, ...prev.L, ...prev.R, ...Rt);
      rUv.push(0, prev.v, 1, v, 0, v, 0, prev.v, 1, prev.v, 1, v);
    }
    prev = { L, R: Rt, v };
    vAcc += STEP;
  }
  const rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
  rGeo.setAttribute('uv', new THREE.Float32BufferAttribute(rUv, 2));
  rGeo.computeVertexNormals();
  const roadMat = new THREE.MeshStandardMaterial({
    map: makeRoadTexture(), roughness: 0.9,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -3,
  });
  const roadMesh = new THREE.Mesh(rGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'road';

  const group = new THREE.Group();
  group.name = 'town';
  group.add(buildings, streets, roadMesh);

  const excluder = (x, z) => {
    for (const [lx, lz, r] of lots) {
      const dx = x - lx, dz = z - lz;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  return { group, excluder, lots };
}
