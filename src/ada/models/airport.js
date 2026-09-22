// Airport buildings on the +X side of the runway: apron, taxiways, hangars (one open with a plane
// inside), control tower with a rotating beacon, terminal, fuel farm, parked aircraft, windsock,
// light poles, fence and a car park. Static parts are merged per material.
//
//   createAirport(world) -> THREE.Group   (group.userData.update(dt) animates windsock + beacon)
import * as THREE from 'three';
import { RUNWAY } from '../config.js';
import { createAircraftMesh } from './aircraft.js';
import { Builder, mat4, V3, makeCanvas, canvasTexture, glowTexture, rng, lerp } from './geom.js';

// Layout, in metres relative to the runway centre (x across, +X = east; z along, +Z = south).
const L = {
  apron: { x0: 64, x1: 206, z0: 180, z1: 440 },
  taxiways: [212, 410],            // z of taxiway centre lines (runway edge -> apron)
  taxiWidth: 18,
  hangars: [
    { type: 'arch', z: 228, W: 30, D: 34, open: false, label: 'HANGAR 1' },
    { type: 'arch', z: 270, W: 30, D: 34, open: true, label: 'HANGAR 2' },
    { type: 'gable', z: 332, W: 44, D: 40, open: false, label: 'GÖKYÜZÜ UÇUŞ OKULU' },
  ],
  hangarX: 206,                    // hangar door line
  terminal: { x0: 88, x1: 158, z0: 146, z1: 170, h: 8.2 },
  tower: { x: 184, z: 158 },
  parking: { x0: 88, x1: 158, z0: 104, z1: 138 },
  fuel: { x: 170, z: 462 },
  stands: [{ z: 372 }, { z: 390 }, { z: 408 }, { z: 426 }],
  standX: 152,
  windsock: { x: 58, z: 590 },
  fence: { x: 256, z0: 96, z1: 482 },
};

const COL = {
  wallLight: '#e6e2d8', wallWarm: '#d9d2c3', plinth: '#8d8a84', roofDark: '#4b5058', trim: '#2f3440',
  hangarA: '#aab4bf', hangarB: '#b7c0c9', hangarRoof: '#8f9aa6', gableWall: '#cfd5da', gableRoof: '#3d5a86',
  door: '#9ea9b5', doorDark: '#7d8894', concrete: '#c9c6bd', steel: '#8a9097', white: '#f2f2ee',
  red: '#c8262b', orange: '#f2801a', blue: '#1f3f8f', dark: '#26292e', tank: '#f1f1ec',
};

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function ribTexture() {
  const c = makeCanvas(64, 16), g = c.getContext('2d');
  for (let x = 0; x < 64; x++) {
    const ph = (x / 64) * Math.PI * 2 * 4; // 4 ribs per metre
    const v = 222 + 26 * Math.sin(ph) + 8 * Math.sin(ph * 2);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, 0, 1, 16);
  }
  const t = canvasTexture(c, { repeat: true });
  return t;
}

function concreteNoise(g, w, h, seed, base, amp, count) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const a = (r() - 0.5) * amp;
    g.fillStyle = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    const s = 1 + r() * 3;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

// Apron: one non-repeating canvas with slab joints, stains and yellow markings.
function apronTexture(A, hangars, taxis, stands, standX) {
  const W = A.x1 - A.x0, D = A.z1 - A.z0;
  const S = 7.4; // px per metre
  const cw = Math.round(W * S), ch = Math.round(D * S);
  const c = makeCanvas(cw, ch), g = c.getContext('2d');
  const r = rng(7);
  g.fillStyle = COL.concrete; g.fillRect(0, 0, cw, ch);
  // slabs with slightly different tone
  const slab = 5;
  for (let x = 0; x < W; x += slab) {
    for (let z = 0; z < D; z += slab) {
      const v = (r() - 0.5) * 0.05;
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(60,55,50,${-v})`;
      g.fillRect(x * S, z * S, slab * S, slab * S);
    }
  }
  concreteNoise(g, cw, ch, 3, 0, 0.12, 26000);
  // joints
  g.strokeStyle = 'rgba(80,78,74,0.28)'; g.lineWidth = 1;
  for (let x = 0; x <= W; x += slab) { g.beginPath(); g.moveTo(x * S + 0.5, 0); g.lineTo(x * S + 0.5, ch); g.stroke(); }
  for (let z = 0; z <= D; z += slab) { g.beginPath(); g.moveTo(0, z * S + 0.5); g.lineTo(cw, z * S + 0.5); g.stroke(); }
  // metre-space drawing from here on
  g.setTransform(S, 0, 0, S, -A.x0 * S, -A.z0 * S);
  // oil stains around the stands and hangar doors
  for (const st of stands) {
    for (let i = 0; i < 5; i++) {
      const gr = g.createRadialGradient(standX - 1 + r() * 2, st.z + (r() - 0.5) * 3, 0, standX, st.z, 1.5 + r() * 2);
      gr.addColorStop(0, 'rgba(40,36,30,0.28)'); gr.addColorStop(1, 'rgba(40,36,30,0)');
      g.fillStyle = gr; g.fillRect(standX - 5, st.z - 5, 10, 10);
    }
  }
  // yellow taxi lines
  const Y = '#f0c020';
  g.strokeStyle = Y; g.lineWidth = 0.3; g.lineCap = 'round';
  const lineX = 95;
  g.beginPath();
  g.moveTo(A.x0, taxis[0]);
  g.quadraticCurveTo(lineX, taxis[0], lineX, taxis[0] + 30);
  g.lineTo(lineX, taxis[1] - 30);
  g.quadraticCurveTo(lineX, taxis[1], A.x0, taxis[1]);
  g.stroke();
  // lead-in lines to hangars
  for (const h of hangars) {
    g.beginPath();
    g.moveTo(lineX, h.z - 18);
    g.quadraticCurveTo(lineX, h.z, lineX + 18, h.z);
    g.lineTo(A.x1, h.z);
    g.stroke();
  }
  // parking stands: lead-in, stop bar, stand number
  g.font = 'bold 2.4px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  stands.forEach((st, i) => {
    g.strokeStyle = Y; g.lineWidth = 0.25;
    g.beginPath(); g.moveTo(lineX, st.z - 8); g.quadraticCurveTo(lineX, st.z, lineX + 8, st.z); g.lineTo(standX + 4.5, st.z); g.stroke();
    g.lineWidth = 0.35;
    g.beginPath(); g.moveTo(standX - 3.2, st.z - 1.8); g.lineTo(standX - 3.2, st.z + 1.8); g.stroke();
    // wingtip clearance box (white dashed)
    g.strokeStyle = 'rgba(245,245,240,0.85)'; g.lineWidth = 0.15; g.setLineDash([1, 0.8]);
    g.strokeRect(standX - 6, st.z - 7.6, 11.5, 15.2);
    g.setLineDash([]);
    g.save(); g.translate(standX + 3.5, st.z + 5.3); g.rotate(-Math.PI / 2);
    g.fillStyle = Y; g.fillText(`${i + 1}`, 0, 0); g.restore();
  });
  // apron edge line (runway side)
  g.strokeStyle = Y; g.lineWidth = 0.15;
  for (const off of [0.6, 1.0]) {
    g.beginPath(); g.moveTo(A.x0 + off, A.z0); g.lineTo(A.x0 + off, taxis[0] - 9.5); g.stroke();
    g.beginPath(); g.moveTo(A.x0 + off, taxis[0] + 9.5); g.lineTo(A.x0 + off, taxis[1] - 9.5); g.stroke();
    g.beginPath(); g.moveTo(A.x0 + off, taxis[1] + 9.5); g.lineTo(A.x0 + off, A.z1); g.stroke();
  }
  // big painted apron name
  g.save(); g.translate(125, 300); g.rotate(-Math.PI / 2);
  g.fillStyle = 'rgba(240,192,32,0.9)'; g.font = 'bold 7px Arial'; g.textAlign = 'center';
  g.fillText('APRON A', 0, 0); g.restore();
  return canvasTexture(c);
}

function asphaltCanvas(w, d, S, seed) {
  const cw = Math.round(w * S), ch = Math.round(d * S);
  const c = makeCanvas(cw, ch), g = c.getContext('2d');
  g.fillStyle = '#4a4c4f'; g.fillRect(0, 0, cw, ch);
  concreteNoise(g, cw, ch, seed, 0, 0.16, Math.round(cw * ch * 0.08));
  return { c, g };
}

// Taxiway canvas covering x in [x0, x1], z in [zc - hw, zc + hw]
function taxiwayTexture(x0, x1, zc, hw, halfW, holdX) {
  const S = 10;
  const { c, g } = asphaltCanvas(x1 - x0, hw * 2, S, 11 + zc);
  g.setTransform(S, 0, 0, S, -x0 * S, -(zc - hw) * S);
  const Y = '#f0c020';
  // centre line
  g.strokeStyle = Y; g.lineWidth = 0.3;
  g.beginPath(); g.moveTo(x0 + 3, zc); g.lineTo(x1, zc); g.stroke();
  // edge lines (double yellow)
  g.lineWidth = 0.15;
  for (const s of [-1, 1]) for (const o of [0.4, 0.8]) {
    g.beginPath(); g.moveTo(x0 + 12, zc + s * (halfW - o)); g.lineTo(x1, zc + s * (halfW - o)); g.stroke();
  }
  // runway holding position: two solid + two dashed lines across
  g.lineWidth = 0.3;
  for (const o of [0, 0.9]) { g.beginPath(); g.moveTo(holdX + o, zc - halfW + 1); g.lineTo(holdX + o, zc + halfW - 1); g.stroke(); }
  g.setLineDash([1, 1]);
  for (const o of [2.1, 3.0]) { g.beginPath(); g.moveTo(holdX + o, zc - halfW + 1); g.lineTo(holdX + o, zc + halfW - 1); g.stroke(); }
  g.setLineDash([]);
  return canvasTexture(c);
}

function parkingTexture(P) {
  const S = 8;
  const { c, g } = asphaltCanvas(P.x1 - P.x0, P.z1 - P.z0, S, 5);
  g.setTransform(S, 0, 0, S, -P.x0 * S, -P.z0 * S);
  g.strokeStyle = 'rgba(240,240,235,0.9)'; g.lineWidth = 0.14;
  for (const zr of [P.z0 + 1, P.z1 - 6]) {
    for (let x = P.x0 + 4; x <= P.x1 - 4; x += 2.6) { g.beginPath(); g.moveTo(x, zr); g.lineTo(x, zr + 5); g.stroke(); }
  }
  return canvasTexture(c);
}

function stripeTexture() {
  const c = makeCanvas(16, 160), g = c.getContext('2d');
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#f4f2ea' : '#f26a12'; g.fillRect(0, i * 32, 16, 32); }
  return canvasTexture(c);
}

function fenceTexture() {
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(150,158,165,1)'; g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64);
  g.moveTo(-32, 32); g.lineTo(32, -32); g.moveTo(32, 96); g.lineTo(96, 32);
  g.moveTo(32, -32); g.lineTo(96, 32); g.moveTo(-32, 32); g.lineTo(32, 96);
  g.stroke();
  return canvasTexture(c, { repeat: true });
}

// Text boards packed into one atlas; returns { texture, rect(name) -> [u0,v0,u1,v1], aspect(name) }
function signAtlas(list) {
  const W = 2048, RH = 128;
  const c = makeCanvas(W, RH * list.length), g = c.getContext('2d');
  const rects = {}, aspects = {};
  list.forEach((s, i) => {
    const y = i * RH;
    g.font = `${s.weight || 700} ${RH * 0.62}px "Helvetica Neue", Arial, sans-serif`;
    const tw = g.measureText(s.text).width;
    const w = Math.min(W, Math.ceil(tw + RH * 0.7));
    g.fillStyle = s.bg; g.fillRect(0, y, w, RH);
    if (s.border) { g.strokeStyle = s.border; g.lineWidth = 6; g.strokeRect(3, y + 3, w - 6, RH - 6); }
    g.fillStyle = s.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s.text, w / 2, y + RH * 0.54);
    const H = RH * list.length;
    rects[s.name] = [0, 1 - (y + RH) / H, w / W, 1 - y / H];
    aspects[s.name] = w / RH;
  });
  return { texture: canvasTexture(c), rects, aspects };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Flat polygon (u,v) -> geometry in the XY plane with UVs in metres (u / tile).
function shapeGeo(pts, tile = 1) {
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v))));
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, p.getY(i) / tile);
  return g;
}

// Plane of size w x h (XY, facing +Z) with metre UVs.
function planeGeo(w, h, tile = 1) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  return g;
}

// Sign quad using an atlas rect, facing +Z.
function signGeo(atlas, name, h) {
  const w = h * atlas.aspects[name];
  const g = new THREE.PlaneGeometry(w, h);
  const [u0, v0, u1, v1] = atlas.rects[name];
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, lerp(u0, u1, uv.getX(i)), lerp(v0, v1, uv.getY(i)));
  return { g, w };
}

// Ground slab from a polygon given in world (x, z); UVs map the bounding box to 0..1.
function slabGeo(pts, y, box) {
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z))));
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = -p.getY(i);
    uv.setXY(i, (x - box.x0) / (box.x1 - box.x0), 1 - (z - box.z0) / (box.z1 - box.z0));
  }
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

// Arched (Quonset-like) hangar, door facing -X at x = x0, centred on z = cz.
function archHangar(B, x0, cz, base, W, D, open, labelSign) {
  const Hw = 4.2, R = 20, half = W / 2;
  const th = Math.asin(half / R);
  const rise = R - R * Math.cos(th);
  const colWall = new THREE.Color(open ? COL.hangarB : COL.hangarA);
  const colRoof = new THREE.Color(COL.hangarRoof);
  const archPts = (n = 16) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = -th + (2 * th * i) / n;
      out.push([R * Math.sin(a), Hw + R * Math.cos(a) - R * Math.cos(th)]);
    }
    return out;
  };
  // roof (arch extruded along x), uv: u = x, v = arc length
  {
    const arc = archPts(20);
    const pos = [], uv = [], idx = [];
    const n = arc.length;
    let acc = 0;
    const len = [0];
    for (let i = 1; i < n; i++) { acc += Math.hypot(arc[i][0] - arc[i - 1][0], arc[i][1] - arc[i - 1][1]); len.push(acc); }
    const ov = 0.6; // eave / gable overhang
    for (const [k, x] of [[0, x0 - ov], [1, x0 + D + ov]]) {
      for (let i = 0; i < n; i++) {
        const [zz, yy] = arc[i];
        const s = 1 + ov / R;
        pos.push(x, base + yy + 0.05, cz + zz * s);
        uv.push((x - x0), len[i]);
      }
    }
    for (let i = 0; i < n - 1; i++) { const a = i, b = n + i, c2 = i + 1, d = n + i + 1; idx.push(a, c2, b, c2, d, b); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    // make sure normals point up/out
    if (g.attributes.normal.getY(Math.floor(n / 2)) < 0) { g.setIndex(idx.slice().reverse()); g.computeVertexNormals(); }
    B.add('metal', g, { color: colRoof });
  }
  // side walls (long, along x)
  for (const s of [-1, 1]) {
    const g = planeGeo(D, Hw + 1);
    B.add('metal', g, { color: colWall, matrix: mat4([x0 + D / 2, base + (Hw - 1) / 2, cz + s * half], [0, s > 0 ? 0 : Math.PI, 0]) });
  }
  // back wall (gable, facing +X)
  const backPts = [[-half, -1], [half, -1]].concat(archPts(16).slice().reverse());
  B.add('metal', shapeGeo(backPts), { color: colWall, matrix: mat4([x0 + D, base, cz], [0, Math.PI / 2, 0]) });
  // front wall with door opening (facing -X); door width Wd, height Hd
  const Wd = W - 10;
  const archY = (u) => Hw + Math.sqrt(R * R - u * u) - R * Math.cos(th);
  const Hd = archY(Wd / 2) - 0.7;
  const frontPts = [[-half, -1], [-Wd / 2, -1], [-Wd / 2, Hd], [Wd / 2, Hd], [Wd / 2, -1], [half, -1]].concat(archPts(16).slice().reverse());
  B.add('metal', shapeGeo(frontPts), { color: colWall, matrix: mat4([x0, base, cz], [0, -Math.PI / 2, 0]) });
  // door header beam + frame posts
  B.add('color', new THREE.BoxGeometry(0.6, 0.7, Wd + 0.6), { color: new THREE.Color(COL.trim), matrix: mat4([x0 - 0.3, base + Hd + 0.35, cz]) });
  for (const s of [-1, 1]) B.add('color', new THREE.BoxGeometry(0.6, Hd + 1, 0.4), { color: new THREE.Color(COL.trim), matrix: mat4([x0 - 0.3, base + (Hd - 1) / 2, cz + s * (Wd / 2 + 0.1)]) });
  // sliding doors: 4 panels
  const pw = Wd / 4 + 0.25;
  const slots = open ? [-(Wd / 2 + 1.2), -(Wd / 2 - 0.4), Wd / 2 - 0.4, Wd / 2 + 1.2] : [-1.5, -0.5, 0.5, 1.5].map((k) => k * (Wd / 4));
  slots.forEach((k, i) => {
    const zc = cz + k;
    const xOff = open ? (Math.abs(k) > Wd / 2 ? -0.55 : -0.95) : (i % 2 ? -0.55 : -0.95);
    const g = planeGeo(pw, Hd - 0.2);
    const c = new THREE.Color(i % 2 ? COL.door : COL.doorDark);
    B.add('metal', g, { color: c, matrix: mat4([x0 + xOff, base + (Hd - 0.2) / 2, zc], [0, -Math.PI / 2, 0]) });
    B.add('metal', g, { color: c, matrix: mat4([x0 + xOff + 0.12, base + (Hd - 0.2) / 2, zc], [0, Math.PI / 2, 0]) });
    // door rail
    B.add('color', new THREE.BoxGeometry(0.25, 0.25, pw), { color: new THREE.Color(COL.dark), matrix: mat4([x0 + xOff + 0.06, base + 0.12, zc]) });
  });
  // hangar floor
  B.add('concrete2', new THREE.BoxGeometry(D, 0.2, W).translate(0, -0.1, 0), { color: new THREE.Color('#b9b6ae'), matrix: mat4([x0 + D / 2, base + 0.12, cz]) });
  // sign above the door
  if (labelSign) {
    const { g, w } = labelSign(2.0);
    B.add('sign', g, { matrix: mat4([x0 - 0.62, base + Hd + 1.8, cz], [0, -Math.PI / 2, 0]) });
    B.add('color', new THREE.BoxGeometry(0.2, 2.3, w + 0.3), { color: new THREE.Color(COL.trim), matrix: mat4([x0 - 0.5, base + Hd + 1.8, cz]) });
  }
  // plinth strip
  B.add('color', new THREE.BoxGeometry(D, 0.6, 0.3), { color: new THREE.Color(COL.plinth), matrix: mat4([x0 + D / 2, base + 0.3, cz - half - 0.1]) });
  B.add('color', new THREE.BoxGeometry(D, 0.6, 0.3), { color: new THREE.Color(COL.plinth), matrix: mat4([x0 + D / 2, base + 0.3, cz + half + 0.1]) });
  return { doorH: Hd, height: Hw + rise };
}

// Gabled maintenance hangar, door facing -X.
function gableHangar(B, x0, cz, base, W, D, labelSign) {
  const Hw = 8.5, Hr = 12.5, half = W / 2;
  const wall = new THREE.Color(COL.gableWall), roof = new THREE.Color(COL.gableRoof), trim = new THREE.Color(COL.trim);
  // side walls
  for (const s of [-1, 1]) {
    B.add('metal', planeGeo(D, Hw + 1), { color: wall, matrix: mat4([x0 + D / 2, base + (Hw - 1) / 2, cz + s * half], [0, s > 0 ? 0 : Math.PI, 0]) });
    // high window band
    B.add('glass', new THREE.PlaneGeometry(D - 6, 1.2), { matrix: mat4([x0 + D / 2, base + Hw - 1.6, cz + s * (half + 0.05)], [0, s > 0 ? 0 : Math.PI, 0]) });
  }
  const gable = [[-half, -1], [half, -1], [half, Hw], [0, Hr], [-half, Hw]];
  B.add('metal', shapeGeo(gable), { color: wall, matrix: mat4([x0 + D, base, cz], [0, Math.PI / 2, 0]) });
  const Wd = W - 8, Hd = Hw - 0.6;
  const front = [[-half, -1], [-Wd / 2, -1], [-Wd / 2, Hd], [Wd / 2, Hd], [Wd / 2, -1], [half, -1], [half, Hw], [0, Hr], [-half, Hw]];
  B.add('metal', shapeGeo(front), { color: wall, matrix: mat4([x0, base, cz], [0, -Math.PI / 2, 0]) });
  // roof: two slabs
  const slope = Math.atan2(Hr - Hw, half);
  const rl = Math.hypot(half, Hr - Hw) + 0.8;
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(D + 1.2, 0.25, rl);
    B.add('color', g, { color: roof, matrix: mat4([x0 + D / 2, base + (Hw + Hr) / 2 + 0.2, cz + s * (half / 2 + 0.2)], [s * slope, 0, 0]) });
  }
  B.add('color', new THREE.BoxGeometry(D + 1.4, 0.35, 0.5), { color: trim, matrix: mat4([x0 + D / 2, base + Hr + 0.3, cz]) });
  // doors: 6 panels, one slightly open
  const pw = Wd / 6 + 0.2;
  for (let i = 0; i < 6; i++) {
    let zc = cz - Wd / 2 + pw / 2 - 0.1 + i * (Wd / 6);
    if (i === 5) zc -= 3.2;
    const xOff = i % 2 ? -0.5 : -0.9;
    const c = new THREE.Color(i % 2 ? COL.door : COL.doorDark);
    B.add('metal', planeGeo(pw, Hd - 0.2), { color: c, matrix: mat4([x0 + xOff, base + (Hd - 0.2) / 2, zc], [0, -Math.PI / 2, 0]) });
    B.add('metal', planeGeo(pw, Hd - 0.2), { color: c, matrix: mat4([x0 + xOff + 0.12, base + (Hd - 0.2) / 2, zc], [0, Math.PI / 2, 0]) });
  }
  B.add('color', new THREE.BoxGeometry(0.6, 0.8, Wd + 0.8), { color: trim, matrix: mat4([x0 - 0.3, base + Hd + 0.4, cz]) });
  B.add('concrete2', new THREE.BoxGeometry(D, 0.2, W).translate(0, -0.1, 0), { color: new THREE.Color('#b9b6ae'), matrix: mat4([x0 + D / 2, base + 0.12, cz]) });
  // lean-to workshop on the south side
  B.add('color', new THREE.BoxGeometry(D * 0.6, 4.2, 7), { color: new THREE.Color(COL.wallWarm), matrix: mat4([x0 + D * 0.55, base + 2.1, cz + half + 3.5]) });
  B.add('color', new THREE.BoxGeometry(D * 0.6 + 0.6, 0.3, 7.6), { color: new THREE.Color(COL.roofDark), matrix: mat4([x0 + D * 0.55, base + 4.3, cz + half + 3.5]) });
  B.add('glass', new THREE.PlaneGeometry(D * 0.45, 1.3), { matrix: mat4([x0 + D * 0.55, base + 2.4, cz + half + 7.02]) });
  B.add('color', new THREE.BoxGeometry(0.1, 2.2, 1.2), { color: trim, matrix: mat4([x0 + D * 0.25 - 0.05, base + 1.1, cz + half + 5.5]) });
  if (labelSign) {
    const { g, w } = labelSign(2.2);
    B.add('sign', g, { matrix: mat4([x0 - 0.12, base + Hw + 1.2, cz], [0, -Math.PI / 2, 0]) });
  }
}

function controlTower(B, x, z, base) {
  const light = new THREE.Color(COL.wallLight), trim = new THREE.Color(COL.trim), dark = new THREE.Color(COL.dark);
  // base building
  B.add('color', new THREE.BoxGeometry(12, 4.5, 10), { color: new THREE.Color(COL.wallWarm), matrix: mat4([x, base + 2.25 - 0.5, z]) });
  B.add('color', new THREE.BoxGeometry(12.6, 0.4, 10.6), { color: trim, matrix: mat4([x, base + 4.2, z]) });
  for (const s of [-1, 1]) B.add('glass', new THREE.PlaneGeometry(9, 1.4), { matrix: mat4([x, base + 2.4, z + s * 5.02], [0, s > 0 ? 0 : Math.PI, 0]) });
  B.add('glass', new THREE.PlaneGeometry(6, 1.4), { matrix: mat4([x - 6.02, base + 2.4, z], [0, -Math.PI / 2, 0]) });
  B.add('color', new THREE.BoxGeometry(0.1, 2.3, 1.4), { color: dark, matrix: mat4([x - 6.03, base + 1.15, z + 3]) });
  // shaft
  const H = 20;
  B.add('color', new THREE.BoxGeometry(4.6, H, 4.6), { color: light, matrix: mat4([x, base + H / 2, z]) });
  for (const [dx, dz, ry] of [[-2.32, 0, -Math.PI / 2], [0, 2.32, 0]]) {
    B.add('glass', new THREE.PlaneGeometry(0.9, H - 7), { matrix: mat4([x + dx, base + 4.5 + (H - 7) / 2, z + dz], [0, ry, 0]) });
  }
  // cab floor
  B.add('color', new THREE.CylinderGeometry(5.0, 4.2, 1.2, 8), { color: light, matrix: mat4([x, base + H + 0.6, z], [0, Math.PI / 8, 0]) });
  B.add('color', new THREE.CylinderGeometry(5.05, 5.05, 0.25, 8), { color: trim, matrix: mat4([x, base + H + 1.25, z], [0, Math.PI / 8, 0]) });
  // glass cab (outward-leaning), mullions, roof
  const cabH = 3.4, cy = base + H + 1.3 + cabH / 2;
  B.add('glass', new THREE.CylinderGeometry(4.75, 4.3, cabH, 8, 1, true), { matrix: mat4([x, cy, z], [0, Math.PI / 8, 0]) });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
    const r = 4.55, phi = Math.atan2(0.45, cabH);
    const g = new THREE.BoxGeometry(0.18, cabH + 0.1, 0.18);
    B.add('color', g, { color: trim, matrix: mat4([x + Math.cos(a) * r, cy, z + Math.sin(a) * r], [phi * Math.sin(a), 0, -phi * Math.cos(a)]) });
  }
  const roofY = cy + cabH / 2;
  B.add('color', new THREE.CylinderGeometry(5.6, 5.1, 0.6, 8), { color: light, matrix: mat4([x, roofY + 0.3, z], [0, Math.PI / 8, 0]) });
  B.add('color', new THREE.CylinderGeometry(5.62, 5.62, 0.18, 8), { color: trim, matrix: mat4([x, roofY + 0.05, z], [0, Math.PI / 8, 0]) });
  B.add('color', new THREE.CylinderGeometry(2.2, 2.6, 0.9, 8), { color: light, matrix: mat4([x, roofY + 1.05, z], [0, Math.PI / 8, 0]) });
  // antenna mast
  B.add('color', new THREE.CylinderGeometry(0.06, 0.09, 5, 6), { color: new THREE.Color(COL.steel), matrix: mat4([x + 1.2, roofY + 3.9, z - 1.2]) });
  B.add('color', new THREE.BoxGeometry(1.6, 0.05, 0.05), { color: new THREE.Color(COL.steel), matrix: mat4([x + 1.2, roofY + 5.6, z - 1.2]) });
  B.add('lamp_red', new THREE.SphereGeometry(0.14, 8, 6), { matrix: mat4([x + 1.2, roofY + 6.45, z - 1.2]) });
  return { beaconPos: V3(x, roofY + 1.5, z) };
}

function terminal(B, T, base, atlas) {
  const light = new THREE.Color(COL.wallLight), trim = new THREE.Color(COL.trim);
  const w = T.x1 - T.x0, d = T.z1 - T.z0, cx = (T.x0 + T.x1) / 2, cz = (T.z0 + T.z1) / 2, H = T.h;
  B.add('color', new THREE.BoxGeometry(w, H + 1, d), { color: light, matrix: mat4([cx, base + (H - 1) / 2, cz]) });
  B.add('color', new THREE.BoxGeometry(w + 0.2, 0.7, d + 0.2), { color: new THREE.Color(COL.plinth), matrix: mat4([cx, base + 0.35, cz]) });
  // parapet + roof
  B.add('color', new THREE.BoxGeometry(w + 0.6, 0.9, d + 0.6), { color: trim, matrix: mat4([cx, base + H + 0.15, cz]) });
  B.add('color', new THREE.BoxGeometry(w - 0.4, 0.2, d - 0.4), { color: new THREE.Color('#7b7f86'), matrix: mat4([cx, base + H + 0.55, cz]) });
  // glass bands: front (airside, +z) two floors, back one floor + entrance
  for (const yy of [2.1, 5.9]) {
    B.add('glass', new THREE.PlaneGeometry(w - 4, 2.4), { matrix: mat4([cx, base + yy, T.z1 + 0.03]) });
    B.add('glass', new THREE.PlaneGeometry(w - 4, 2.0), { matrix: mat4([cx, base + yy, T.z0 - 0.03], [0, Math.PI, 0]) });
    for (const s of [-1, 1]) B.add('glass', new THREE.PlaneGeometry(d - 5, 2.0), { matrix: mat4([s > 0 ? T.x1 + 0.03 : T.x0 - 0.03, base + yy, cz], [0, s * Math.PI / 2, 0]) });
  }
  // mullions on the front
  for (let x = T.x0 + 2; x <= T.x1 - 2 + 0.01; x += 3.3) B.add('color', new THREE.BoxGeometry(0.15, 6.6, 0.12), { color: trim, matrix: mat4([x, base + 4.0, T.z1 + 0.08]) });
  B.add('color', new THREE.BoxGeometry(w - 3.6, 0.35, 0.3), { color: trim, matrix: mat4([cx, base + 3.95, T.z1 + 0.12]) });
  // canopies with columns (front and back entrances)
  for (const [zz, s] of [[T.z1, 1], [T.z0, -1]]) {
    const ex = s > 0 ? cx - 10 : cx + 6;
    B.add('color', new THREE.BoxGeometry(14, 0.35, 5), { color: new THREE.Color('#f4f4f0'), matrix: mat4([ex, base + 3.6, zz + s * 2.5]) });
    for (const dx of [-6.5, 6.5]) B.add('color', new THREE.CylinderGeometry(0.18, 0.18, 3.5, 8), { color: new THREE.Color(COL.steel), matrix: mat4([ex + dx, base + 1.75, zz + s * 4.6]) });
  }
  // rooftop units
  const r = rng(21);
  for (let i = 0; i < 5; i++) B.add('color', new THREE.BoxGeometry(2 + r() * 2, 1.2, 1.6 + r()), { color: new THREE.Color('#b8bcc2'), matrix: mat4([T.x0 + 8 + i * 12 + r() * 3, base + H + 1.2, cz - 3 + r() * 5]) });
  // roof sign facing the apron
  const { g, w: sw } = signGeo(atlas, 'terminal', 2.6);
  B.add('sign', g, { matrix: mat4([cx, base + H + 2.3, T.z1 - 1.2]) });
  B.add('color', new THREE.BoxGeometry(sw + 0.4, 3.0, 0.25), { color: trim, matrix: mat4([cx, base + H + 2.3, T.z1 - 1.35]) });
  for (const dx of [-sw / 3, 0, sw / 3]) B.add('color', new THREE.BoxGeometry(0.2, 1.2, 0.2), { color: trim, matrix: mat4([cx + dx, base + H + 0.6, T.z1 - 1.4]) });
  // entrance boards
  const a = signGeo(atlas, 'gelis', 0.8), b = signGeo(atlas, 'gidis', 0.8), c = signGeo(atlas, 'otopark', 0.8);
  B.add('sign', a.g, { matrix: mat4([cx - 14, base + 4.2, T.z1 + 4.95]) });
  B.add('sign', b.g, { matrix: mat4([cx - 6, base + 4.2, T.z1 + 4.95]) });
  B.add('sign', c.g, { matrix: mat4([cx + 6, base + 4.2, T.z0 - 4.95], [0, Math.PI, 0]) });
}

function fuelFarm(B, x, z, base, atlas) {
  const tank = new THREE.Color(COL.tank), red = new THREE.Color(COL.red), steel = new THREE.Color(COL.steel);
  // bund pad + low wall
  B.add('concrete2', new THREE.BoxGeometry(26, 0.3, 16), { color: new THREE.Color('#aeaba3'), matrix: mat4([x, base + 0.05, z]) });
  for (const [dx, dz, w, d] of [[0, -8, 26, 0.3], [0, 8, 26, 0.3], [-13, 0, 0.3, 16], [13, 0, 0.3, 16]]) {
    B.add('color', new THREE.BoxGeometry(w, 0.9, d), { color: new THREE.Color('#a8a59d'), matrix: mat4([x + dx, base + 0.45, z + dz]) });
  }
  const tanks = [{ dz: -3.3, label: 'avgas' }, { dz: 3.3, label: 'jeta1' }];
  for (const t of tanks) {
    const tz = z + t.dz, ty = base + 2.2;
    B.add('color', new THREE.CylinderGeometry(1.6, 1.6, 12, 20).rotateZ(Math.PI / 2), { color: tank, matrix: mat4([x, ty, tz]) });
    for (const s of [-1, 1]) B.add('color', new THREE.SphereGeometry(1.6, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).rotateZ(-s * Math.PI / 2), { color: tank, matrix: mat4([x + s * 6, ty, tz]) });
    B.add('color', new THREE.CylinderGeometry(1.62, 1.62, 0.5, 20).rotateZ(Math.PI / 2), { color: red, matrix: mat4([x - 3.5, ty, tz]) });
    B.add('color', new THREE.CylinderGeometry(1.62, 1.62, 0.5, 20).rotateZ(Math.PI / 2), { color: red, matrix: mat4([x + 3.5, ty, tz]) });
    for (const dx of [-4, 4]) B.add('color', new THREE.BoxGeometry(0.5, 1.2, 2.6), { color: steel, matrix: mat4([x + dx, base + 0.6, tz]) });
    // ladder + walkway
    B.add('color', new THREE.BoxGeometry(0.5, 0.08, 1.2), { color: steel, matrix: mat4([x, ty + 1.62, tz]) });
    const { g } = signGeo(atlas, t.label, 0.75);
    const side = t.dz < 0 ? -1 : 1;
    B.add('sign', g, { matrix: mat4([x, ty, tz + side * 1.62], [0, side > 0 ? 0 : Math.PI, 0]) });
  }
  // pump island toward the apron
  B.add('color', new THREE.BoxGeometry(3, 0.25, 1.4), { color: new THREE.Color('#b5b2aa'), matrix: mat4([x - 17, base + 0.12, z - 3]) });
  B.add('color', new THREE.BoxGeometry(0.9, 1.6, 0.6), { color: red, matrix: mat4([x - 17, base + 1.05, z - 3]) });
  B.add('color', new THREE.BoxGeometry(3.4, 0.2, 2), { color: new THREE.Color(COL.white), matrix: mat4([x - 17, base + 3.2, z - 3]) });
  B.add('color', new THREE.CylinderGeometry(0.08, 0.08, 3, 6), { color: steel, matrix: mat4([x - 18.4, base + 1.6, z - 3]) });
  B.add('color', new THREE.CylinderGeometry(0.08, 0.08, 3, 6), { color: steel, matrix: mat4([x - 15.6, base + 1.6, z - 3]) });
}

function fuelTruck(B, x, z, base, rotY) {
  const m = (px, py, pz) => new THREE.Matrix4().makeRotationY(rotY).multiply(mat4([px, py, pz])).premultiply(mat4([x, base, z]));
  B.add('color', new THREE.BoxGeometry(2.2, 1.9, 2.3), { color: new THREE.Color(COL.red), matrix: m(0, 1.45, -3.1) });
  B.add('glass', new THREE.PlaneGeometry(2.0, 0.8), { matrix: m(0, 1.9, -4.26).multiply(mat4([0, 0, 0], [0, Math.PI, 0])) });
  B.add('color', new THREE.BoxGeometry(2.3, 0.5, 7.2), { color: new THREE.Color(COL.dark), matrix: m(0, 0.75, -0.2) });
  B.add('color', new THREE.CylinderGeometry(1.05, 1.05, 4.6, 18).rotateX(Math.PI / 2), { color: new THREE.Color(COL.tank), matrix: m(0, 1.95, 0.6) });
  B.add('color', new THREE.CylinderGeometry(1.07, 1.07, 0.35, 18).rotateX(Math.PI / 2), { color: new THREE.Color(COL.red), matrix: m(0, 1.95, 0.6) });
  for (const [dx, dz] of [[-1.05, -3.2], [1.05, -3.2], [-1.05, 1.3], [1.05, 1.3], [-1.05, 2.4], [1.05, 2.4]]) {
    B.add('dark', new THREE.CylinderGeometry(0.48, 0.48, 0.35, 12).rotateZ(Math.PI / 2), { color: new THREE.Color('#1b1b1b'), matrix: m(dx, 0.48, dz) });
  }
}

// Small aircraft tug, placed at (x, z) facing `yaw` (same convention as the aircraft: nose = local -Z).
function tug(B, x, z, base, yaw) {
  const m = (px, py, pz, rot = [0, 0, 0]) => mat4([x, base, z], [0, yaw, 0]).multiply(mat4([px, py, pz], rot));
  const yel = new THREE.Color('#f2c230'), dark = new THREE.Color('#1c1c1c');
  B.add('color', new THREE.BoxGeometry(1.3, 0.55, 2.4), { color: yel, matrix: m(0, 0.55, 0) });
  B.add('color', new THREE.BoxGeometry(1.1, 0.5, 0.8), { color: yel, matrix: m(0, 1.05, 0.5) });
  B.add('color', new THREE.BoxGeometry(0.5, 0.35, 0.4), { color: dark, matrix: m(0, 0.95, 0.9) }); // seat
  B.add('color', new THREE.CylinderGeometry(0.035, 0.035, 2.4, 6).rotateX(Math.PI / 2), { color: new THREE.Color('#e0e0e0'), matrix: m(0, 0.35, -2.2) }); // tow bar
  for (const [dx, dz] of [[-0.7, -0.8], [0.7, -0.8], [-0.7, 0.8], [0.7, 0.8]]) {
    B.add('dark', new THREE.CylinderGeometry(0.3, 0.3, 0.26, 12).rotateZ(Math.PI / 2), { color: dark, matrix: m(dx, 0.3, dz) });
  }
  B.add('lamp_red', new THREE.SphereGeometry(0.08, 6, 4), { matrix: m(0, 1.35, 0.5) });
}

function cone(B, x, z, base) {
  B.add('color', new THREE.ConeGeometry(0.18, 0.55, 10), { color: new THREE.Color(COL.orange), matrix: mat4([x, base + 0.3, z]) });
  B.add('color', new THREE.CylinderGeometry(0.105, 0.125, 0.09, 10), { color: new THREE.Color('#f4f4f0'), matrix: mat4([x, base + 0.33, z]) });
  B.add('color', new THREE.BoxGeometry(0.42, 0.04, 0.42), { color: new THREE.Color('#222'), matrix: mat4([x, base + 0.02, z]) });
}

function lightPole(B, x, z, base) {
  const steel = new THREE.Color(COL.steel);
  B.add('color', new THREE.CylinderGeometry(0.14, 0.24, 14, 8), { color: steel, matrix: mat4([x, base + 7, z]) });
  B.add('color', new THREE.BoxGeometry(0.2, 0.2, 3.2), { color: steel, matrix: mat4([x, base + 13.8, z]) });
  for (const dz of [-1.3, 1.3]) {
    B.add('color', new THREE.BoxGeometry(0.9, 0.3, 0.7), { color: new THREE.Color('#3a3e44'), matrix: mat4([x - 0.2, base + 13.6, z + dz]) });
    B.add('lamp_warm', new THREE.PlaneGeometry(0.75, 0.55).rotateX(Math.PI / 2), { matrix: mat4([x - 0.2, base + 13.44, z + dz]) });
  }
  B.add('color', new THREE.CylinderGeometry(0.45, 0.45, 0.6, 8), { color: new THREE.Color('#9a978f'), matrix: mat4([x, base + 0.3, z]) });
}

function fenceLine(B, pts, base, height = 2.2) {
  const steel = new THREE.Color('#8c939a');
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(-(z1 - z0), x1 - x0);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const n = Math.max(1, Math.round(len / 3));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      B.add('color', new THREE.CylinderGeometry(0.045, 0.045, height + 0.3, 5), { color: steel, matrix: mat4([lerp(x0, x1, t), base + (height + 0.3) / 2 - 0.1, lerp(z0, z1, t)]) });
    }
    B.add('color', new THREE.BoxGeometry(len, 0.05, 0.05), { color: steel, matrix: mat4([cx, base + height, cz], [0, ang, 0]) });
    B.add('fence', planeGeo(len, height, 0.6), { matrix: mat4([cx, base + height / 2, cz], [0, ang, 0]) });
  }
}

function carGeometry() {
  const b = new Builder();
  const white = new THREE.Color('#ffffff'), glass = new THREE.Color('#2a3138'), tyre = new THREE.Color('#151515');
  b.add('c', new THREE.BoxGeometry(1.8, 0.75, 4.3), { color: white, matrix: mat4([0, 0.62, 0]) });
  b.add('c', new THREE.BoxGeometry(1.6, 0.6, 2.2), { color: glass, matrix: mat4([0, 1.28, 0.2]) });
  b.add('c', new THREE.BoxGeometry(1.5, 0.08, 2.0), { color: white, matrix: mat4([0, 1.6, 0.2]) });
  for (const [x, z] of [[-0.85, -1.35], [0.85, -1.35], [-0.85, 1.35], [0.85, 1.35]]) {
    b.add('c', new THREE.CylinderGeometry(0.33, 0.33, 0.25, 10).rotateZ(Math.PI / 2), { color: tyre, matrix: mat4([x, 0.33, z]) });
  }
  return b.geometry('c');
}

// ---------------------------------------------------------------------------
// Windsock + beacon
// ---------------------------------------------------------------------------

function windsock(group, x, z, base) {
  const root = new THREE.Group();
  root.position.set(x, base, z);
  group.add(root);
  const B = new Builder();
  const white = new THREE.Color('#f0f0ea'), orange = new THREE.Color(COL.orange);
  B.add('p', new THREE.CylinderGeometry(0.07, 0.11, 6.2, 8), { color: white, matrix: mat4([0, 3.1, 0]) });
  for (let i = 0; i < 3; i++) B.add('p', new THREE.CylinderGeometry(0.095 - i * 0.008, 0.1 - i * 0.008, 0.5, 8), { color: orange, matrix: mat4([0, 1 + i * 1.8, 0]) });
  B.add('p', new THREE.CylinderGeometry(0.5, 0.5, 0.25, 10), { color: new THREE.Color('#9d9a92'), matrix: mat4([0, 0.12, 0]) });
  // small ring of white stones around the base
  const r = rng(4);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    B.add('p', new THREE.BoxGeometry(0.35, 0.18, 0.25), { color: white, matrix: mat4([Math.cos(a) * 4, 0.09, Math.sin(a) * 4], [0, r() * 3, 0]) });
  }
  const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const pole = new THREE.Mesh(B.geometry('p'), poleMat);
  pole.castShadow = true; pole.receiveShadow = true;
  root.add(pole);
  // swivel + sock
  const swivel = new THREE.Group();
  swivel.position.y = 6.25;
  root.add(swivel);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.035, 6, 20).rotateY(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.6 }));
  ring.position.x = 0.35;
  swivel.add(ring);
  const LEN = 3.6;
  const sockGeo = new THREE.CylinderGeometry(0.46, 0.18, LEN, 16, 12, true);
  sockGeo.rotateZ(-Math.PI / 2);          // axis along X, mouth (radiusTop) at +X ...
  sockGeo.rotateY(Math.PI);               // ... flipped so the mouth is at -X ...
  sockGeo.translate(LEN / 2 + 0.35, 0, 0); // ... and sits in the ring; the tail streams toward +X
  const base0 = sockGeo.attributes.position.array.slice();
  const sockMat = new THREE.MeshStandardMaterial({ map: stripeTexture(), side: THREE.DoubleSide, roughness: 0.8 });
  const sock = new THREE.Mesh(sockGeo, sockMat);
  sock.castShadow = true;
  swivel.add(sock);
  // wind from the north-north-west (a headwind for take-off on runway 36): the sock points SSE
  const dir = new THREE.Vector2(0.3, 0.95).normalize();
  const windYaw = Math.atan2(-dir.y, dir.x);
  let t = Math.random() * 10;
  return (dt) => {
    t += dt;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.35) * Math.sin(t * 0.13 + 1);
    swivel.rotation.y = windYaw + 0.18 * Math.sin(t * 0.5) + 0.07 * Math.sin(t * 1.7);
    swivel.rotation.z = -(0.32 - 0.22 * gust); // droop (negative z rotation drops the +X tip)
    const pos = sockGeo.attributes.position, arr = pos.array;
    for (let i = 0; i < pos.count; i++) {
      const bx = base0[i * 3], by = base0[i * 3 + 1], bz = base0[i * 3 + 2];
      const s = Math.max(0, (bx - 0.35) / LEN); // 0 at mouth .. 1 at tail
      const w = s * s;
      arr[i * 3] = bx;
      arr[i * 3 + 1] = by + w * 0.16 * Math.sin(t * 7.5 - s * 5) - w * 0.25 * (1 - gust);
      arr[i * 3 + 2] = bz + w * 0.2 * Math.sin(t * 5.3 - s * 4 + 1.3);
    }
    pos.needsUpdate = true;
  };
}

function rotatingBeacon(group, pos) {
  const root = new THREE.Group();
  root.position.copy(pos);
  group.add(root);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.7, 12), new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.5, metalness: 0.4 }));
  housing.position.y = 0.35;
  housing.castShadow = true;
  root.add(housing);
  const head = new THREE.Group();
  head.position.y = 0.95;
  root.add(head);
  const glow = glowTexture();
  const lamps = [];
  for (const [color, a] of [[0x3dff7a, 0], [0xffffff, Math.PI]]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 14).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    lens.position.set(Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3);
    lens.rotation.y = a;
    head.add(lens);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.copy(lens.position).multiplyScalar(1.6);
    s.scale.setScalar(2.4);
    head.add(s);
    lamps.push(s);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6 }));
  head.add(body);
  let t = 0;
  return (dt) => {
    t += dt;
    head.rotation.y += dt * 2.2;
    // brighter when the lamp faces roughly toward -X (the runway, where the player is)
    for (let i = 0; i < 2; i++) {
      const a = head.rotation.y + i * Math.PI;
      const facing = Math.max(0, -Math.cos(a));
      lamps[i].material.opacity = 0.25 + 0.75 * Math.pow(facing, 6);
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function createAirport(world) {
  const group = new THREE.Group();
  group.name = 'airport';
  const OX = RUNWAY.x, OZ = RUNWAY.z;
  const W = (x) => OX + x, Z = (z) => OZ + z;
  const gh = (x, z) => world.getGroundHeight(W(x), Z(z));
  const baseMax = (x0, x1, z0, z1) => Math.max(gh(x0, z0), gh(x1, z0), gh(x0, z1), gh(x1, z1), gh((x0 + x1) / 2, (z0 + z1) / 2));

  const B = new Builder();
  const atlas = signAtlas([
    { name: 'terminal', text: 'GÖKYÜZÜ HAVALİMANI', bg: '#1f3f8f', fg: '#ffffff', border: '#f2801a' },
    { name: 'hangar1', text: 'HANGAR 1', bg: '#f2801a', fg: '#1b1b1b' },
    { name: 'hangar2', text: 'HANGAR 2', bg: '#f2801a', fg: '#1b1b1b' },
    { name: 'school', text: 'GÖKYÜZÜ UÇUŞ OKULU', bg: '#f4f4f0', fg: '#1f3f8f', border: '#1f3f8f' },
    { name: 'avgas', text: 'AVGAS 100LL', bg: '#f1f1ec', fg: '#c8262b', weight: 800 },
    { name: 'jeta1', text: 'JET A-1', bg: '#f1f1ec', fg: '#1b1b1b', weight: 800 },
    { name: 'gelis', text: 'GELİŞ', bg: '#1b2330', fg: '#f0c020' },
    { name: 'gidis', text: 'GİDİŞ', bg: '#1b2330', fg: '#f0c020' },
    { name: 'otopark', text: 'P  OTOPARK', bg: '#1f3f8f', fg: '#ffffff' },
  ]);

  // ---- slabs: apron, taxiways, car park ----
  const A = L.apron;
  const apronY = baseMax(A.x0, A.x1, A.z0, A.z1) + 0.06;
  const apronGeo = slabGeo([[A.x0, A.z0], [A.x1, A.z0], [A.x1, A.z1], [A.x0, A.z1]].map(([x, z]) => [W(x), Z(z)]), apronY,
    { x0: W(A.x0), x1: W(A.x1), z0: Z(A.z0), z1: Z(A.z1) });
  const apronMat = new THREE.MeshStandardMaterial({
    map: apronTexture(A, L.hangars, L.taxiways, L.stands, L.standX), roughness: 0.92,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const apron = new THREE.Mesh(apronGeo, apronMat);
  apron.receiveShadow = true;
  group.add(apron);

  const edge = RUNWAY.width / 2;
  for (const tz of L.taxiways) {
    const hw = L.taxiWidth / 2, fil = 12, x0 = edge, x1 = A.x0 + 1;
    const ty = baseMax(x0, x1, tz - hw, tz + hw) + 0.05;
    const pts = [[x0, tz - hw - fil]];
    for (let i = 1; i <= 6; i++) { const a = (i / 6) * Math.PI / 2; pts.push([x0 + fil - fil * Math.cos(a), tz - hw - fil + fil * Math.sin(a)]); }
    pts.push([x1, tz - hw], [x1, tz + hw]);
    for (let i = 6; i >= 1; i--) { const a = (i / 6) * Math.PI / 2; pts.push([x0 + fil - fil * Math.cos(a), tz + hw + fil - fil * Math.sin(a)]); }
    pts.push([x0, tz + hw + fil]);
    const box = { x0: W(x0), x1: W(x1), z0: Z(tz - hw - fil), z1: Z(tz + hw + fil) };
    const geo = slabGeo(pts.map(([x, z]) => [W(x), Z(z)]), ty, box);
    const mat = new THREE.MeshStandardMaterial({
      map: taxiwayTexture(x0, x1, tz, hw + fil, hw, x0 + 18), roughness: 0.9,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    group.add(m);
  }
  {
    const P = L.parking;
    const py = baseMax(P.x0, P.x1, P.z0, P.z1) + 0.05;
    const geo = slabGeo([[P.x0, P.z0], [P.x1, P.z0], [P.x1, P.z1], [P.x0, P.z1]].map(([x, z]) => [W(x), Z(z)]), py,
      { x0: W(P.x0), x1: W(P.x1), z0: Z(P.z0), z1: Z(P.z1) });
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: parkingTexture(P), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    m.receiveShadow = true;
    group.add(m);
    // access road from the car park to the terminal front and east
    const roadY = py;
    B.add('asphalt', new THREE.BoxGeometry(260 - P.x0, 0.12, 8).translate(0, -0.06, 0), { color: new THREE.Color('#55585c'), matrix: mat4([W((P.x0 + 260) / 2), roadY, Z(P.z1 + 4)]) });
    // cars
    const r = rng(99);
    const carCols = ['#c8262b', '#f4f4f0', '#20252c', '#6d7780', '#1f3f8f', '#c9c3b5', '#2f6d4f', '#f2c230', '#9aa3ab', '#f4f4f0'];
    const spots = [];
    for (const [zr, dir] of [[P.z0 + 3.5, 0], [P.z1 - 3.5, Math.PI]]) {
      for (let x = P.x0 + 5.3; x <= P.x1 - 5.3; x += 2.6) if (r() < 0.55) spots.push([x, zr, dir]);
    }
    const cars = new THREE.InstancedMesh(carGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 }), spots.length);
    const m4 = new THREE.Matrix4(), c = new THREE.Color();
    spots.forEach(([x, z, dir], i) => {
      m4.makeRotationY(dir + (r() - 0.5) * 0.08).setPosition(W(x), py, Z(z));
      cars.setMatrixAt(i, m4);
      cars.setColorAt(i, c.set(carCols[Math.floor(r() * carCols.length)]));
    });
    cars.castShadow = true; cars.receiveShadow = true;
    group.add(cars);
  }

  // ---- hangars ----
  const labels = { 'HANGAR 1': 'hangar1', 'HANGAR 2': 'hangar2', 'GÖKYÜZÜ UÇUŞ OKULU': 'school' };
  let openHangar = null;
  for (const h of L.hangars) {
    const base = baseMax(L.hangarX, L.hangarX + h.D, h.z - h.W / 2, h.z + h.W / 2);
    const sign = (hh) => signGeo(atlas, labels[h.label], hh);
    if (h.type === 'arch') {
      archHangar(B, W(L.hangarX), Z(h.z), base, h.W, h.D, h.open, sign);
      if (h.open) openHangar = { x: L.hangarX + h.D * 0.55, z: h.z, base };
    } else {
      gableHangar(B, W(L.hangarX), Z(h.z), base, h.W, h.D, sign);
    }
  }

  // ---- tower, terminal, fuel ----
  const tw = L.tower;
  const towerInfo = controlTower(B, W(tw.x), Z(tw.z), baseMax(tw.x - 6, tw.x + 6, tw.z - 5, tw.z + 5));
  const T = L.terminal;
  terminal(B, { x0: W(T.x0), x1: W(T.x1), z0: Z(T.z0), z1: Z(T.z1), h: T.h }, baseMax(T.x0, T.x1, T.z0, T.z1), atlas);
  const F = L.fuel;
  fuelFarm(B, W(F.x), Z(F.z), baseMax(F.x - 13, F.x + 13, F.z - 8, F.z + 8), atlas);
  fuelTruck(B, W(128), Z(452), apronY - 0.02, -0.35);

  // ---- light poles, fence ----
  for (const [x, z] of [[70, 186], [70, 300], [70, 434], [198, 186], [198, 434], [134, 186]]) lightPole(B, W(x), Z(z), apronY);
  const fz = L.fence;
  fenceLine(B, [[fz.x, fz.z0], [fz.x, fz.z1], [60, fz.z1]].map(([x, z]) => [W(x), Z(z)]), gh(fz.x, (fz.z0 + fz.z1) / 2));
  fenceLine(B, [[T.x1 + 4, 176], [fz.x, 176]].map(([x, z]) => [W(x), Z(z)]), gh(200, 176));

  // ---- apron props: tug pushing a trainer out of hangar 2, cones ----
  const pushback = { x: L.hangarX - 14, z: L.hangars[1].z + 2, yaw: -Math.PI / 2 + 0.25 };
  {
    // tug faces the aircraft, its tow bar reaching the nose wheel
    const nx = -Math.sin(pushback.yaw), nz = -Math.cos(pushback.yaw);
    tug(B, W(pushback.x + nx * 4.6), Z(pushback.z + nz * 4.6), apronY, pushback.yaw + Math.PI);
  }
  for (const [x, z] of [[L.standX + 9, 372], [L.standX + 9, 426], [L.hangarX - 4, L.hangars[0].z - 9], [L.hangarX - 4, L.hangars[0].z + 9]]) cone(B, W(x), Z(z), apronY);

  // ---- build merged meshes ----
  const ribs = ribTexture();
  const mats = {
    color: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }),
    dark: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, map: ribs, roughness: 0.5, metalness: 0.15, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0x27415a, roughness: 0.08, metalness: 0.4 }),
    concrete2: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    asphalt: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    sign: new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.6, emissiveMap: atlas.texture, emissive: 0xffffff, emissiveIntensity: 0.12 }),
    lamp_warm: new THREE.MeshBasicMaterial({ color: 0xfff1d0 }),
    lamp_red: new THREE.MeshBasicMaterial({ color: 0xff3020, toneMapped: false }),
    fence: new THREE.MeshStandardMaterial({ map: fenceTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 }),
  };
  for (const key of B.keys()) {
    const geo = B.geometry(key);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, mats[key]);
    m.name = `airport-${key}`;
    const flat = key === 'concrete2' || key === 'asphalt';
    m.castShadow = !flat && key !== 'lamp_warm' && key !== 'lamp_red';
    m.receiveShadow = key !== 'lamp_warm' && key !== 'lamp_red';
    group.add(m);
  }

  // ---- parked aircraft ----
  const liveries = [
    { base: '#f3f1ea', stripe1: '#b3122e', stripe2: '#2b2b2b', registration: 'TC-KRM', regColor: '#5a0a16', spinner: '#b3122e', wingtip: '#b3122e', name: '' },
    { base: '#eef2f5', stripe1: '#0f6e4f', stripe2: '#e9c341', registration: 'TC-YSL', regColor: '#0b3b2c', spinner: '#e9c341', wingtip: '#0f6e4f', name: '' },
    { base: '#f6f6f2', stripe1: '#3a4b5c', stripe2: '#5fb4d9', registration: 'TC-MVI', regColor: '#23303c', spinner: '#f6f6f2', wingtip: '#3a4b5c', name: '' },
    { base: '#f4f5f2', stripe1: '#f2801a', stripe2: '#1f3f8f', registration: 'TC-GKZ', regColor: '#15244c', spinner: '#f2801a', wingtip: '#f2801a' },
  ];
  const parked = [];
  [0, 1, 2, 3].forEach((standIdx, i) => {
    const p = createAircraftMesh(liveries[i]);
    const x = L.standX, z = L.stands[standIdx].z;
    p.position.set(W(x), apronY + p.userData.gearHeight, Z(z));
    p.rotation.y = Math.PI / 2 + [0.03, -0.02, 0.05, -0.04][i];
    group.add(p);
    parked.push(p);
  });
  // a trainer being pushed back out of hangar 2 by a tug
  if (openHangar) {
    const p = createAircraftMesh({ base: '#eef1f4', stripe1: '#5b2a86', stripe2: '#f2c230', registration: 'TC-ATA', regColor: '#3a1a57', spinner: '#5b2a86', wingtip: '#5b2a86', name: '' });
    p.position.set(W(pushback.x), apronY + p.userData.gearHeight, Z(pushback.z));
    p.rotation.y = pushback.yaw; // nose toward the hangar
    group.add(p);
  }
  if (openHangar) {
    const p = createAircraftMesh({ base: '#f2c230', stripe1: '#1b1b1b', stripe2: '#f4f4f0', registration: 'TC-SRI', regColor: '#1b1b1b', spinner: '#1b1b1b', wingtip: '#1b1b1b', name: '' });
    p.position.set(W(openHangar.x), openHangar.base + 0.12 + p.userData.gearHeight, Z(openHangar.z));
    p.rotation.y = Math.PI / 2 + 0.05;
    group.add(p);
  }

  // ---- animated bits ----
  const wsPos = L.windsock;
  const sockUpdate = windsock(group, W(wsPos.x), Z(wsPos.z), gh(wsPos.x, wsPos.z));
  const beaconUpdate = rotatingBeacon(group, towerInfo.beaconPos);
  group.userData.update = (dt) => {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    sockUpdate(dt);
    beaconUpdate(dt);
  };
  group.userData.update(0);
  return group;
}
