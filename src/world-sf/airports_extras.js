// W4 airports: perimeter fence (chain-link + barbed wire), arresting cables (BAK-12) and night floodlight pools.
import * as THREE from 'three';
import { depthBias } from './airports_ground.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function chainLinkTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(190,196,200,1)';
  g.lineWidth = 3;
  const step = 32;
  for (let k = -128; k <= 256; k += step) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(k, 128); g.lineTo(k + 128, 0); g.stroke();
  }
  // top / bottom rails
  g.fillStyle = 'rgba(170,176,180,1)';
  g.fillRect(0, 0, 128, 5);
  g.fillRect(0, 123, 128, 5);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Perimeter fence along meta.fence rings (local coords): 2.4 m chain-link + 45° outrigger with 3 barbed wires. */
export function buildFence(meta, ctx) {
  const rings = meta.fence;
  if (!rings || !rings.length) return null;
  const [ox, oz] = meta.origin;
  const H = 2.4;
  const pos = [], uv = [], idx = [], wire = [];
  const posts = [];
  const gate = meta.gate;
  for (const ring of rings) {
    // resample every 3 m
    const pts = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / 3));
      for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    pts.push(ring[ring.length - 1]);
    let u = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      // leave an opening at the gate
      if (gate && Math.hypot((ax + bx) / 2 - gate[0], (az + bz) / 2 - gate[1]) < 14) { u += 3; continue; }
      if (ctx.terrain.isWater && ctx.terrain.isWater(ax + ox, az + oz)) { u += 3; continue; }
      const ya = ctx.terrain.getHeight(ax + ox, az + oz), yb = ctx.terrain.getHeight(bx + ox, bz + oz);
      const L = Math.hypot(bx - ax, bz - az);
      const b = pos.length / 3;
      pos.push(ax, ya, az, bx, yb, bz, bx, yb + H, bz, ax, ya + H, az);
      uv.push(u / 2.4, 0, (u + L) / 2.4, 0, (u + L) / 2.4, 1, u / 2.4, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      u += L;
      posts.push([ax, ya, az, Math.atan2(bx - ax, -(bz - az))]);
      wire.push([ax, ya, az, bx, yb, bz]);
    }
  }
  const group = new THREE.Group();
  group.name = `apt-fence-${meta.icao}`;
  group.position.set(ox, 0, oz);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: chainLinkTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6, color: 0xd0d4d8 });
  mat.name = 'apt-fence';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  group.add(mesh);
  // posts + outriggers (instanced), barbed wire as thin boxes
  const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 5).translate(0, 0.5, 0);
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.7 });
  const im = new THREE.InstancedMesh(postGeo, steel, posts.length * 2);
  let k = 0;
  const e = new THREE.Euler();
  for (const [x, y, z, hdg] of posts) {
    im.setMatrixAt(k++, _m.compose(_p.set(x, y - 0.3, z), _q.identity(), _s.set(1, H + 0.3, 1)));
    // outrigger arm leaning outward 45 deg (0.6 m)
    e.set(0, -hdg, 0);
    _q.setFromEuler(e);
    const arm = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
    _q.multiply(arm);
    im.setMatrixAt(k++, _m.compose(_p.set(x, y + H, z), _q, _s.set(1, 0.6, 1)));
  }
  im.count = k;
  im.computeBoundingSphere();
  group.add(im);
  const wireGeo = new THREE.BoxGeometry(0.02, 0.02, 1);
  const wim = new THREE.InstancedMesh(wireGeo, steel, wire.length * 3);
  k = 0;
  for (const [ax, ya, az, bx, yb, bz] of wire) {
    const L = Math.hypot(bx - ax, bz - az);
    const hdg = Math.atan2(bx - ax, -(bz - az));
    _q.setFromAxisAngle(UP, -hdg);
    // outward offset direction (perpendicular, to the left of travel): lean of the outriggers
    const nx = Math.cos(hdg) * 0, nz = 0;
    for (let j = 1; j <= 3; j++) {
      const off = 0.14 * j;
      _p.set((ax + bx) / 2 - Math.cos(hdg) * off + nx, (ya + yb) / 2 + H + off, (az + bz) / 2 - Math.sin(hdg) * off + nz);
      wim.setMatrixAt(k++, _m.compose(_p, _q, _s.set(1, 1, L)));
    }
  }
  wim.count = k;
  wim.computeBoundingSphere();
  group.add(wim);
  group.userData.lodDist = 2500;
  return group;
}

/** BAK-12 arresting cables across the runway: steel cable on rubber support discs, energy absorber housings. */
export function buildCables(meta, ctx) {
  const cables = meta.cables;
  if (!cables || !cables.length) return null;
  const [ox, oz] = meta.origin;
  const group = new THREE.Group();
  group.name = `apt-cables-${meta.icao}`;
  group.position.set(ox, 0, oz);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1c, roughness: 0.6, metalness: 0.4 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8e8b84, roughness: 0.9 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe0a800, roughness: 0.6 });
  const discs = [], lines = [], boxes = [], markers = [];
  for (const [[ax, az], [bx, bz]] of cables) {
    const L = Math.hypot(bx - ax, bz - az);
    const hdg = Math.atan2(bx - ax, -(bz - az));
    const n = Math.floor(L / 2.5);
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      discs.push([x, ctx.terrain.getHeight(x + ox, z + oz) + 0.08, z, hdg]);
    }
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    lines.push([mx, ctx.terrain.getHeight(mx + ox, mz + oz) + 0.1, mz, hdg, L]);
    for (const [x, z, sg] of [[ax, az, -1], [bx, bz, 1]]) {
      const ex = x + Math.sin(hdg) * sg * 6, ez = z - Math.cos(hdg) * sg * 6;
      boxes.push([ex, ctx.terrain.getHeight(ex + ox, ez + oz), ez, hdg]);
      markers.push([x - Math.sin(hdg) * sg * 1.5, ctx.terrain.getHeight(x + ox, z + oz), z + Math.cos(hdg) * sg * 1.5, hdg]);
    }
  }
  const discGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.09, 10).rotateZ(Math.PI / 2);
  const di = new THREE.InstancedMesh(discGeo, rubber, discs.length);
  discs.forEach(([x, y, z, h], i) => { _q.setFromAxisAngle(UP, -h); di.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1))); });
  const cabGeo = new THREE.CylinderGeometry(0.016, 0.016, 1, 5).rotateX(Math.PI / 2);
  const ci = new THREE.InstancedMesh(cabGeo, dark, lines.length);
  lines.forEach(([x, y, z, h, L], i) => { _q.setFromAxisAngle(UP, -h); ci.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, L + 8))); });
  const boxGeo = new THREE.BoxGeometry(3.0, 0.6, 4.0).translate(0, 0.3, 0);
  const bi = new THREE.InstancedMesh(boxGeo, concrete, boxes.length);
  boxes.forEach(([x, y, z, h], i) => { _q.setFromAxisAngle(UP, -h); bi.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1))); });
  // arresting gear marker: yellow disc sign on a post at the runway edge
  const mGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 16).rotateX(Math.PI / 2).translate(0, 1.1, 0);
  const mi = new THREE.InstancedMesh(mGeo, yellow, markers.length);
  markers.forEach(([x, y, z, h], i) => { _q.setFromAxisAngle(UP, -h + Math.PI / 2); mi.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1))); });
  for (const im of [di, ci, bi, mi]) { im.computeBoundingSphere(); im.castShadow = true; group.add(im); }
  group.userData.lodDist = 3000;
  return group;
}

let poolTex = null;
function poolTexture() {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}

/** Additive light pools on the apron under the floodlight masts (visible at night). */
export function buildFloodPools(meta, ctx) {
  const floods = meta.floods;
  if (!floods || !floods.length) return null;
  const [ox, oz] = meta.origin;
  const R = 48;
  const geo = new THREE.PlaneGeometry(2 * R, 2 * R).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: poolTexture(), color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  depthBias(mat, 6);
  mat.name = 'apt-floodpool';
  const im = new THREE.InstancedMesh(geo, mat, floods.length);
  floods.forEach(([x, z], i) => im.setMatrixAt(i, _m.makeTranslation(x, ctx.terrain.getHeight(x + ox, z + oz) + 0.12, z)));
  im.computeBoundingSphere();
  im.position.set(ox, 0, oz);
  im.renderOrder = 5;
  im.userData.setNight = (night) => { mat.opacity = 0.42 * night; im.visible = night > 0.02; };
  im.visible = false;
  return im;
}
