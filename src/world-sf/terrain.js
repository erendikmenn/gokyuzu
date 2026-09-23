// W1: streaming quadtree terrain of the San Francisco Bay Area (USGS 3DEP 2 m lidar/topobathy + USGS NAIP 1 m imagery).
// Format: assets/sf/terrain/README.md (built by tools/geo/terrain_build.py + imagery_build.py).
//  - chunked LOD: each node = 64x64 quads (+ skirts), refined by screen-space geometric error and imagery texel size
//  - streaming: height tiles via HTTP range requests into per-level packs, imagery as WebP, a few uploads per frame
//  - getHeight(x,z) samples exactly the triangles that are rendered near the camera (same data, same diagonal split)
import * as THREE from 'three';
import { createTerrainShared, createTerrainMaterial, setTerrainWaterQuality, applyWaterDefine } from './terrain-material.js';
import { createHorizonRing } from './terrain-horizon.js';

const BASE = new URL('../../assets/sf/terrain/', import.meta.url).href;
const Q = 64, NV = 65, NS = 67;          // quads, vertices per edge, samples per edge (1 border)
const PERIM = 4 * Q;
const VERT_COUNT = NV * NV + PERIM;
const UNLOADED = 0, LOADING = 1, LOADED = 2, READY = 3, FAILED = 4;

let sharedIndex = null;
function getSharedIndex() {
  if (sharedIndex) return sharedIndex;
  const idx = [];
  for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) {
    const a = j * NV + i, b = a + 1, c = a + NV, d = c + 1;   // a=(i,j) b=(i+1,j) c=(i,j+1) d=(i+1,j+1)
    idx.push(a, c, d, a, d, b);                               // diagonal a-d (matches sampleNode)
  }
  const perim = perimeter();
  for (let k = 0; k < PERIM; k++) {
    const p0 = perim[k], p1 = perim[(k + 1) % PERIM];
    const s0 = NV * NV + k, s1 = NV * NV + (k + 1) % PERIM;
    idx.push(p0, p1, s0, p1, s1, s0);
  }
  sharedIndex = new THREE.BufferAttribute(new Uint16Array(idx), 1);
  return sharedIndex;
}
/** Compact index (tools/geo/terrain_pinpack.py): deflated header JSON + 12-byte node records -> index.json layout. */
async function loadIndexBin() {
  const r = await fetch(BASE + 'index.bin');
  if (!r.ok || typeof DecompressionStream === 'undefined') throw new Error(`index.bin ${r.status}`);
  const buf = await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const nodes = new Array(index.nodeCount);
  let o = 4 + hl;
  for (let k = 0; k < nodes.length; k++, o += 12) {
    const f = dv.getUint8(o + 5);
    nodes[k] = [dv.getUint8(o), dv.getUint16(o + 1, true), dv.getUint16(o + 3, true), f & 1, dv.getUint16(o + 6, true) / 100,
      dv.getInt16(o + 8, true) / 10, dv.getInt16(o + 10, true) / 10, (f >> 2) & 3, (f >> 1) & 1];
  }
  index.nodes = nodes;
  return index;
}

function flatPlaceholder({ region }) {
  const b = region.local;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6d7a5a, roughness: 1 }));
  mesh.position.set((b.minX + b.maxX) / 2, 4, (b.minZ + b.maxZ) / 2);
  mesh.receiveShadow = true;
  return { object: mesh, getHeight: () => 4, isWater: () => false, getNormal: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0), update() {}, ready: Promise.resolve(), stats: {}, dispose() {} };
}

let _perim = null;
function perimeter() {
  if (_perim) return _perim;
  const p = [];
  for (let i = 0; i < Q; i++) p.push(i);                          // north edge, eastward
  for (let j = 0; j < Q; j++) p.push(j * NV + Q);                 // east edge, southward
  for (let i = Q; i > 0; i--) p.push(Q * NV + i);                 // south edge, westward
  for (let j = Q; j > 0; j--) p.push(j * NV);                     // west edge, northward
  _perim = p;
  return p;
}

export async function createTerrain(ctx) {
  const { renderer, loader } = ctx;
  const focus = ctx.focus || { x: 0, z: 0 };
  const q = new URLSearchParams(location.search);
  let index;
  try {
    index = await loadIndexBin().catch(() => fetch(BASE + 'index.json').then((r) => { if (!r.ok) throw new Error(`terrain index ${r.status}`); return r.json(); }));
  } catch (e) {
    console.error('[terrain] assets/sf/terrain missing - run tools/geo/terrain_build.py + imagery_build.py. Using a flat placeholder.', e);
    return flatPlaceholder(ctx);
  }
  const ROOT = index.rootSize, RX = index.rootMinX, RZ = index.rootMinZ;
  const TILE_BYTES = index.tileBytes;

  // ---------------- nodes ----------------
  const key = (L, i, j) => L * 1048576 + i * 1024 + j;
  const nodes = new Map();
  const rankCounter = new Array(16).fill(0);
  for (const r of index.nodes) {
    const [L, i, j, hasKids, err, hmin, hmax, water, img] = r;
    const size = ROOT / (1 << L);
    nodes.set(key(L, i, j), {
      L, i, j, size, x0: RX + i * size, z0: RZ + j * size, err, hmin, hmax, water, img: !!img, hasKids: !!hasKids,
      rank: rankCounter[L]++, parent: null, children: null, state: UNLOADED, heights: null, wbits: null,
      mesh: null, tex: null, texNode: null, lastUsed: 0, selected: -1, prio: 0, childImg: false, retry: 0,
    });
  }
  for (const n of nodes.values()) {
    if (n.L > 0) n.parent = nodes.get(key(n.L - 1, n.i >> 1, n.j >> 1)) || null;
    if (n.hasKids) {
      n.children = [];
      for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) n.children.push(nodes.get(key(n.L + 1, 2 * n.i + di, 2 * n.j + dj)));
      if (n.children.some((c) => !c)) n.children = null;
    }
  }
  const root = nodes.get(key(0, 0, 0));

  // ---------------- quality (CONTRACTS-SF.md §8) ----------------
  const IMG_DEEPEST = Math.max(...index.nodes.filter((r) => r[8]).map((r) => r[0]));   // 8 (1 m/px)
  const qual = { geo: 1, tex: 1, imgCap: IMG_DEEPEST, maxTex: 520, aniso: 8 };
  const hasImg = (n) => n.img && n.L <= qual.imgCap;
  function refreshChildImg() { for (const n of nodes.values()) if (n.children) n.childImg = n.children.some(hasImg); }
  function readQuality(q) {
    if (!q) return;
    const te = q.terrainError ?? 1;
    qual.geo = te; qual.tex = te;
    qual.imgCap = IMG_DEEPEST + Math.min(0, q.imageryMaxLevel ?? 0);
    qual.maxTex = q.imageryMaxLevel <= -2 ? 200 : q.imageryMaxLevel === -1 ? 320 : 520;
    qual.aniso = q.anisotropy ?? 8;
    setTerrainWaterQuality(q.water || 'high');
  }
  readQuality(ctx.quality);
  refreshChildImg();

  // ---------------- shared GPU resources ----------------
  const texLoader = new THREE.TextureLoader();
  // non-essential textures load after start (placeholders until then): bathymetry/shore distance and ground detail
  const flat = (r, g, b) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  const depthTex = flat(150, 255, 0);   // ~20 m deep, far from shore
  const lateTextures = () => {
    texLoader.loadAsync(BASE + 'water_depth.png').then((t) => {
      t.flipY = false;   // row 0 = north (rootMinZ), like every other terrain texture
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      shared.uDepthTex.value = t;
    }).catch((e) => console.warn('[terrain] water_depth', e));
    texLoader.loadAsync(BASE + 'detail.png').then((t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(qual.aniso, maxAniso);
      shared.uDetailTex.value = t;
    }).catch((e) => console.warn('[terrain] detail', e));
  };
  const waveTex = await texLoader.loadAsync(BASE + 'waves.png');
  waveTex.colorSpace = THREE.NoColorSpace;
  waveTex.wrapS = waveTex.wrapT = THREE.RepeatWrapping;
  waveTex.minFilter = THREE.LinearMipmapLinearFilter;
  waveTex.anisotropy = 8;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const detailTex = flat(128, 128, 128);
  const shared = createTerrainShared({ depthTex, waveTex, detailTex, rootMinX: RX, rootMinZ: RZ });
  // baked terrain shadows are valid only for the sun they were computed for
  if (index.bakedSun && ctx.sunDirection) {
    const el = index.bakedSun.elevationDeg * Math.PI / 180, az = index.bakedSun.azimuthDeg * Math.PI / 180;
    const b = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    shared.uSunVisOn.value = b.angleTo(ctx.sunDirection) < 0.035 && q.get('terrainShadows') !== '0' ? 1 : 0;
  }
  if (q.has('landSpec')) shared.uLandSpec.value = +q.get('landSpec');
  if (q.has('landGain')) { const g = +q.get('landGain'); shared.uLand.value.set(g, g, g, shared.uLand.value.w); }
  if (q.has('landSat')) shared.uLand.value.w = +q.get('landSat');
  if (q.has('terrainDebug')) shared.uDebug.value = +q.get('terrainDebug');   // 1 ocean, 2 coast blur, 3 depth, 4 surf zone, 5 shore, 6 sun vis
  const emptyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  emptyTex.needsUpdate = true;

  const object = new THREE.Group();
  object.name = 'sf-terrain';
  object.add(createHorizonRing({ rootMinX: RX, rootMinZ: RZ, rootSize: ROOT, waveTex }));

  // ---------------- loading ----------------
  const MAX_INFLIGHT = 12;
  let inflight = 0;
  const pending = new Set();
  const built = [];                // loaded, waiting for GPU upload/build
  let loadedCount = 0, texCount = 0;
  const loadedSet = new Set();

  function request(n, prio) {
    if (n.state !== UNLOADED) return;
    n.prio = prio;
    pending.add(n);
  }

  async function loadNode(n) {
    n.state = LOADING;
    inflight++;
    try {
      const hp = n.heights && !n.packed ? Promise.resolve(null) : fetchHeights(n);
      const ip = hasImg(n) ? fetch(`${BASE}img/${n.L}/${n.i}_${n.j}.webp`).then((r) => {
        if (!r.ok) throw new Error(`img ${n.L}/${n.i}/${n.j}: ${r.status}`);
        return r.blob();
      }).then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })) : null;
      const [buf, bmp] = await Promise.all([hp, ip]);
      if (buf) decodeHeights(n, buf);
      n.bitmap = bmp;
      n.state = LOADED;
      built.push(n);
    } catch (e) {
      n.retry++;
      n.state = n.retry < 3 ? UNLOADED : FAILED;
      if (n.state === FAILED) console.warn('[terrain]', e.message);
    } finally {
      inflight--;
    }
  }

  function fetchHeights(n) {
    const start = n.rank * TILE_BYTES;
    return fetch(`${BASE}h/${n.L}.bin`, { headers: { Range: `bytes=${start}-${start + TILE_BYTES - 1}` } }).then((r) => {
      if (!r.ok) throw new Error(`height ${n.L}/${n.i}/${n.j}: ${r.status}`);
      return r.arrayBuffer();
    });
  }
  function decodeHeights(n, buf) {
    let ab = buf;
    if (ab.byteLength > TILE_BYTES) ab = ab.slice(n.rank * TILE_BYTES, n.rank * TILE_BYTES + TILE_BYTES); // server ignored Range
    const hdr = new Float32Array(ab, 0, 2);
    n.hBase = hdr[0]; n.hScale = hdr[1];
    n.heights = new Uint16Array(ab, 8, NS * NS);   // quantized; h = hBase + v * hScale
    n.packed = false;
    const wOff = 8 + NS * NS * 2, wLen = (NS * NS + 7) >> 3;
    n.wbits = new Uint8Array(ab, wOff, wLen);
    n.sunVis = ab.byteLength >= wOff + wLen + NV * NV ? new Uint8Array(ab, wOff + wLen, NV * NV) : null;
  }

  /** Precomputed compressed height pack (tools/geo/terrain_pinpack.py): airports at full depth + landmarks.
   *  Tiles get heights + water bits (no baked sun visibility: the full tile is fetched when it is first rendered). */
  async function loadPinPack() {
    const r = await fetch(BASE + 'pins.bin');
    if (!r.ok || typeof DecompressionStream === 'undefined') throw new Error(`pins.bin ${r.status}`);
    const buf = await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    const dv = new DataView(buf);
    const hl = dv.getUint32(0, true);
    const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const q = hdr.q, WB = (NS * NS + 7) >> 3, TS = NS * NS * 2 + WB;
    let off = 4 + hl, count = 0;
    const acc = new Int32Array(NS * NS);
    for (const [L, i, j] of hdr.tiles) {
      const n = nodes.get(key(L, i, j));
      if (n && !n.heights) {
        // undo the 2D delta: c[y][x] = d[y][x] + c[y-1][x] + c[y][x-1] - c[y-1][x-1]
        const d = new Int16Array(buf.slice(off, off + NS * NS * 2));
        let cmin = Infinity;
        for (let y = 0; y < NS; y++) for (let x = 0; x < NS; x++) {
          const k = y * NS + x;
          const up = y ? acc[k - NS] : 0, left = x ? acc[k - 1] : 0, ul = x && y ? acc[k - NS - 1] : 0;
          const c = d[k] + up + left - ul;
          acc[k] = c;
          if (c < cmin) cmin = c;
        }
        const u = new Uint16Array(NS * NS);
        for (let k = 0; k < u.length; k++) u[k] = acc[k] - cmin;
        n.heights = u; n.hBase = cmin * q; n.hScale = q;
        n.wbits = new Uint8Array(buf.slice(off + NS * NS * 2, off + TS));
        n.sunVis = null; n.packed = true; n.pinned = true;
        count++;
      }
      off += TS;
    }
    return count;
  }

  /** Height data (no mesh/texture) at full depth over areas other layers sample at build time (airports, landmarks).
   *  Tiles of one level with consecutive ranks are fetched with a single range request. */
  async function pinHeights(areas, maxLevel = 99) {
    const list = [];
    const hit = (n) => areas.some((a) => n.x0 < a.x1 && n.x0 + n.size > a.x0 && n.z0 < a.z1 && n.z0 + n.size > a.z0);
    const walk = (n) => {
      if (!hit(n) || n.L > maxLevel) return;
      n.pinned = true;
      if (!n.heights) list.push(n);
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(root);
    list.sort((a, b) => a.L - b.L || a.rank - b.rank);
    const runs = [];
    for (const n of list) {
      const r = runs[runs.length - 1];
      if (r && r.L === n.L && r.nodes[r.nodes.length - 1].rank + 1 === n.rank && r.nodes.length < 256) r.nodes.push(n);
      else runs.push({ L: n.L, nodes: [n] });
    }
    let k = 0;
    const worker = async () => {
      while (k < runs.length) {
        const run = runs[k++];
        const a = run.nodes[0].rank * TILE_BYTES, b = (run.nodes[run.nodes.length - 1].rank + 1) * TILE_BYTES - 1;
        try {
          const r = await fetch(`${BASE}h/${run.L}.bin`, { headers: { Range: `bytes=${a}-${b}` } });
          if (!r.ok) throw new Error(`pin ${run.L}: ${r.status}`);
          const buf = await r.arrayBuffer();
          const off0 = buf.byteLength > b - a + 1 ? a : 0;   // server ignored Range -> whole file
          run.nodes.forEach((n, t) => { if (!n.heights) decodeHeights(n, buf.slice(off0 + t * TILE_BYTES, off0 + (t + 1) * TILE_BYTES)); });
        } catch (e) { console.warn('[terrain]', e.message); }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return list.length;
  }

  function pump() {
    if (!pending.size || inflight >= MAX_INFLIGHT) return;
    const arr = [...pending].sort((a, b) => a.prio - b.prio);
    for (const n of arr) {
      if (inflight >= MAX_INFLIGHT) break;
      pending.delete(n);
      if (n.state === UNLOADED) loadNode(n);
    }
    pending.clear();   // re-requested next selection if still needed
  }

  function texSourceOf(n) {
    let s = n;
    while (s && !(hasImg(s) && s.tex)) s = s.parent;
    return s;
  }

  function buildNode(n) {
    if (n.bitmap && !hasImg(n)) { if (n.bitmap.close) n.bitmap.close(); n.bitmap = null; }   // level dropped by quality
    // texture
    if (n.bitmap) {
      const t = new THREE.Texture(n.bitmap);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.premultiplyAlpha = false;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = Math.min(qual.aniso, maxAniso);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      const tt = performance.now();
      renderer.initTexture(t);
      prof.tex = Math.max(prof.tex || 0, performance.now() - tt);
      n.tex = t;
      texCount++;
    }
    const src = texSourceOf(n);
    n.texNode = src;
    // geometry
    const hq = n.heights, hb = n.hBase, hs = n.hScale;
    const h = new Float32Array(NS * NS);
    for (let k = 0; k < h.length; k++) h[k] = hb + hq[k] * hs;
    const d = n.size / Q;
    const pos = new Float32Array(VERT_COUNT * 3);
    const nor = new Int8Array(VERT_COUNT * 3);
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
      const k = j * NV + i;
      const s = (j + 1) * NS + (i + 1);
      pos[k * 3] = i * d; pos[k * 3 + 1] = h[s]; pos[k * 3 + 2] = j * d;
      const dx = h[s + 1] - h[s - 1], dz = h[s + NS] - h[s - NS];
      const nx = -dx, ny = 2 * d, nz = -dz;
      const il = 127 / Math.hypot(nx, ny, nz);
      nor[k * 3] = Math.round(nx * il); nor[k * 3 + 1] = Math.round(ny * il); nor[k * 3 + 2] = Math.round(nz * il);
    }
    const perim = perimeter();
    const skirt = Math.max(2, n.err * 2.5 + n.size * 0.004);
    for (let k = 0; k < PERIM; k++) {
      const p = perim[k], o = NV * NV + k;
      pos[o * 3] = pos[p * 3]; pos[o * 3 + 1] = pos[p * 3 + 1] - skirt; pos[o * 3 + 2] = pos[p * 3 + 2];
      nor[o * 3] = nor[p * 3]; nor[o * 3 + 1] = nor[p * 3 + 1]; nor[o * 3 + 2] = nor[p * 3 + 2];
    }
    // parent surface under each vertex (same triangle split) for geomorphing when this tile replaces its parent
    const py = new Float32Array(VERT_COUNT);
    const par = n.parent && n.parent.heights ? n.parent : null;
    for (let k = 0; k < VERT_COUNT; k++) py[k] = par ? sampleNode(par, n.x0 + pos[k * 3], n.z0 + pos[k * 3 + 2]) - (k >= NV * NV ? skirt : 0) : pos[k * 3 + 1];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('parentY', new THREE.BufferAttribute(py, 1));
    // baked sun visibility per vertex (terrain cast shadows); skirts copy their edge vertex
    const sv = new Uint8Array(VERT_COUNT).fill(255);
    if (n.sunVis) {
      sv.set(n.sunVis);
      for (let k = 0; k < PERIM; k++) sv[NV * NV + k] = n.sunVis[perim[k]];
    }
    g.setAttribute('sunVis', new THREE.BufferAttribute(sv, 1, true));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    g.setIndex(getSharedIndex());
    const hmin = Math.min(n.hmin, n.hmax) - skirt, hmax = n.hmax;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, hmin, 0), new THREE.Vector3(n.size, hmax, n.size));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const xf = new THREE.Vector4(1, 1, 0, 0);
    let tex = emptyTex;
    if (src && src.tex) {
      tex = src.tex;
      xf.set(1 / src.size, 1 / src.size, (n.x0 - src.x0) / src.size, (n.z0 - src.z0) / src.size);
    }
    const texel = (src ? src.size : n.size) / 512;
    n.uMorph = { value: 1 };
    const mat = createTerrainMaterial(shared, { uImg: { value: tex }, uImgXform: { value: xf }, uTile: { value: new THREE.Vector4(n.size / Q, texel, 0, 0) }, uMorph: n.uMorph });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(n.x0, 0, n.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.visible = false;
    mesh.name = `terrain ${n.L}/${n.i}/${n.j}`;
    mesh.userData.node = n;
    object.add(mesh);
    n.mesh = mesh;
    n.bitmap = null;
    n.state = READY;
    loadedCount++;
    loadedSet.add(n);
  }

  function unloadNode(n) {
    loadedSet.delete(n);
    if (n.mesh) {
      object.remove(n.mesh);
      n.mesh.geometry.index = null;   // the index buffer is shared by all tiles: never delete it
      n.mesh.geometry.dispose();
      n.mesh.material.dispose();
      n.mesh = null;
    }
    if (n.tex) {
      if (n.tex.image && n.tex.image.close) n.tex.image.close();
      n.tex.dispose();
      n.tex = null;
      texCount--;
    }
    if (!n.pinned) { n.heights = null; n.wbits = null; }
    n.state = UNLOADED; n.retry = 0; n.drawn = false;
    loadedCount--;
  }

  // ---------------- LOD selection ----------------
  const GEO_PX = +(q.get('geoPx') || 3);           // max geometric error on screen (px, at <= 1200 px viewport height)
  const TEX_PX = +(q.get('texPx') || 1.6);         // max imagery texel size on screen (px)
  const MAX_TILES = 950;   // + qual.maxTex resident imagery tiles (520 x 1.4 MB with mips at high)
  let frame = 0;
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const box = new THREE.Box3();
  const camPos = new THREE.Vector3();
  let K = 1000;
  const visibleNow = [];
  let selectedCount = 0, pendingNear = 0;
  const stats = { selected: 0, loaded: 0, textures: 0, inflight: 0, pending: 0 };

  function distTo(n) {
    const dx = Math.max(n.x0 - camPos.x, 0, camPos.x - (n.x0 + n.size));
    const dz = Math.max(n.z0 - camPos.z, 0, camPos.z - (n.z0 + n.size));
    const dy = Math.max(n.hmin - camPos.y, 0, camPos.y - n.hmax);
    return Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1);
  }
  function inFrustum(n) {
    box.min.set(n.x0, n.hmin - 50, n.z0);
    box.max.set(n.x0 + n.size, n.hmax + 10, n.z0 + n.size);
    return frustum.intersectsBox(box);
  }

  function traverse(n, omni) {
    n.lastUsed = frame;
    const d = distTo(n);
    let refine = false;
    if (n.children) {
      const sseG = n.err * K / d;
      const sseT = n.childImg ? (n.size / 512) * K / d : 0;
      const relax = omni ? (isReady ? 4 : 3) : 1;   // pre-start omni selection: coarse view around the focus
      refine = sseG > GEO_PX * qual.geo * relax * (n.L >= 9 ? 2 : 1) || sseT > TEX_PX * qual.tex * relax;
      if (refine && !omni && d > 1200 && !inFrustum(n)) refine = false;
    }
    if (refine) {
      let ready = true, fresh = 0;
      for (const c of n.children) {
        if (c.state !== READY) {
          ready = false;
          if (c.state === UNLOADED) request(c, c.L * 0.5 + distTo(c) / 1000);
        } else if (!c.drawn) fresh++;
      }
      // GPU buffers of a tile are uploaded on its first draw: cap first-time activations per frame (no upload spikes)
      if (ready && fresh && !omni) {
        if (activations + fresh > MAX_ACTIVATIONS) ready = false;
        else activations += fresh;
      }
      if (ready) {
        for (const c of n.children) traverse(c, omni);
        return;
      }
      if (d < 3000) pendingNear++;
    }
    n.selected = frame;
    selectedCount++;
    if (n.mesh) { visibleNow.push(n.mesh); n.drawn = true; }
  }

  const prevVisible = [];
  let morphStep = 0.05;
  const MAX_ACTIVATIONS = 8;   // ~8 x 90 KB of vertex data per frame
  let activations = 0;
  function select(cam, omni = false) {
    activations = 0;
    frame++;
    cam.updateMatrixWorld();
    camPos.setFromMatrixPosition(cam.matrixWorld);
    const hPx = Math.min(renderer.domElement.clientHeight || renderer.domElement.height || 900, 1200);
    K = hPx / (2 * Math.tan((cam.fov || 60) * Math.PI / 360));
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    visibleNow.length = 0;
    selectedCount = 0; pendingNear = 0;
    if (root.state !== READY) { request(root, 0); return; }
    traverse(root, omni);
    for (const m of prevVisible) m.visible = false;
    prevVisible.length = 0;
    for (const m of visibleNow) {
      const n = m.userData.node;
      if (!m.visible && n.parent && n.parent.selected === frame - 1 && !omni) n.uMorph.value = 0;   // refined: rise from the parent
      m.visible = true; prevVisible.push(m);
      if (n.uMorph.value < 1) n.uMorph.value = Math.min(1, n.uMorph.value + morphStep);
    }
  }

  function processBuilt(budgetMs, maxTex) {
    const t0 = performance.now();
    // parents first so texture sources exist
    built.sort((a, b) => a.L - b.L);
    let k = 0, tex = 0;
    while (k < built.length && performance.now() - t0 < budgetMs) {
      const n = built[k];
      if (n.parent && n.parent.state !== READY) { k++; continue; }
      if (n.bitmap && tex >= maxTex) { k++; continue; }
      if (n.bitmap) tex++;
      built.splice(k, 1);
      buildNode(n);
    }
  }

  function evict() {
    const MAX_TEX = qual.maxTex;
    if (loadedCount <= MAX_TILES && texCount <= MAX_TEX) return;
    const cands = [];
    for (const n of loadedSet) {
      if (n.state !== READY || n.L <= 3 || n.lastUsed >= frame - 90) continue;
      if (n.children && n.children.some((c) => c.state !== UNLOADED && c.state !== FAILED)) continue;
      cands.push(n);
    }
    cands.sort((a, b) => a.lastUsed - b.lastUsed || b.L - a.L);
    let over = Math.max(loadedCount - MAX_TILES, 0) + 20;
    let overTex = texCount - MAX_TEX;
    let budget = 12;   // spread disposal over frames
    for (const n of cands) {
      if ((over <= 0 && overTex <= 0) || budget-- <= 0) break;
      if (n.tex) overTex--;
      unloadNode(n);
      over--;
    }
  }

  // ---------------- height queries ----------------
  // deepest node whose height data is loaded: identical to the rendered surface near the camera (the rendered cut is
  // the finest data there), and the full-resolution surface wherever finer data is cached or pinned
  function nodeAt(x, z) {
    if (!root.heights) return null;
    const lx = (x - RX) / ROOT, lz = (z - RZ) / ROOT;
    if (lx < 0 || lz < 0 || lx >= 1 || lz >= 1) return null;
    let n = root;
    while (n.children) {
      const s = 1 << (n.L + 1);
      const ci = Math.floor(lx * s) - 2 * n.i, cj = Math.floor(lz * s) - 2 * n.j;
      const c = n.children[cj * 2 + ci];
      if (!c || !c.heights) break;
      n = c;
    }
    return n;
  }
  function sampleNode(n, x, z) {
    const d = n.size / Q;
    let fx = (x - n.x0) / d, fz = (z - n.z0) / d;
    fx = Math.min(Math.max(fx, 0), Q); fz = Math.min(Math.max(fz, 0), Q);
    const i = Math.min(Math.floor(fx), Q - 1), j = Math.min(Math.floor(fz), Q - 1);
    const u = fx - i, v = fz - j;
    const h = n.heights, s = (j + 1) * NS + (i + 1), b = n.hBase, k = n.hScale;
    const h00 = b + h[s] * k, h10 = b + h[s + 1] * k, h01 = b + h[s + NS] * k, h11 = b + h[s + NS + 1] * k;
    return v >= u ? h00 + v * (h01 - h00) + u * (h11 - h01) : h00 + u * (h10 - h00) + v * (h11 - h10);
  }
  function getHeight(x, z) {
    const n = nodeAt(x, z);
    return n ? sampleNode(n, x, z) : 0;
  }
  function isWater(x, z) {
    const n = nodeAt(x, z);
    if (!n) return true;
    const d = n.size / Q;
    const i = Math.min(Math.max(Math.round((x - n.x0) / d), 0), Q), j = Math.min(Math.max(Math.round((z - n.z0) / d), 0), Q);
    const b = (j + 1) * NS + (i + 1);
    return (n.wbits[b >> 3] >> (7 - (b & 7)) & 1) === 1;
  }

  // ---------------- update / ready ----------------
  let lastExternal = -1e9;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  let isReady = false;
  const focusCam = new THREE.PerspectiveCamera(60, 16 / 9, 1, 80000);
  const t0 = performance.now();

  function focusLeafReady() {
    let n = root;
    const lx = (focus.x - RX) / ROOT, lz = (focus.z - RZ) / ROOT;
    while (n) {
      if (n.state !== READY) return false;
      if (!n.children) return true;
      const s = 1 << (n.L + 1);
      n = n.children[(Math.floor(lz * s) - 2 * n.j) * 2 + (Math.floor(lx * s) - 2 * n.i)];
    }
    return true;
  }

  const prof = { select: 0, pump: 0, build: 0, evict: 0 };
  function step(cam, omni, dt) {
    morphStep = Math.min(dt / 0.35, 1);
    let t = performance.now(), t2;
    select(cam, omni);
    t2 = performance.now(); prof.select = Math.max(prof.select, t2 - t); t = t2;
    pump();
    t2 = performance.now(); prof.pump = Math.max(prof.pump, t2 - t); t = t2;
    processBuilt(omni ? 12 : 3, omni ? 16 : 2);
    t2 = performance.now(); prof.build = Math.max(prof.build, t2 - t); t = t2;
    if ((frame & 7) === 0) evict();
    t2 = performance.now(); prof.evict = Math.max(prof.evict, t2 - t);
    shared.uTime.value += dt;
    stats.selected = selectedCount; stats.loaded = loadedCount; stats.textures = texCount;
    stats.inflight = inflight; stats.pending = built.length;
  }

  function internalPump() {
    if (isReady && lastExternal < 0) {
      processBuilt(4, 2);   // started, but the game loop is not running yet: no new downloads before playable
    } else if (performance.now() - lastExternal > 400) {
      const g = getHeight(focus.x, focus.z);
      focusCam.position.set(focus.x, g + 40, focus.z);
      focusCam.lookAt(focus.x + 100, g + 30, focus.z);
      step(focusCam, true, 0.016);
      if (!isReady && ((root.state === READY && pinsDone && pendingNear === 0 && inflight === 0 && built.length === 0) || performance.now() - t0 > 25000)) {
        isReady = true;
        readyResolve();
        lateTextures();
      }
    }
    if (!disposed) setTimeout(internalPump, isReady ? 100 : 8);
  }
  let disposed = false;
  // pin full-depth heights where other layers sample the terrain while they build (runways/aprons/taxiways, landmarks)
  const pinAreas = [];
  for (const apt of (ctx.runways && ctx.runways.airports) || []) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of apt.runways) for (const e of r.ends) { x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x); z0 = Math.min(z0, e.z); z1 = Math.max(z1, e.z); }
    const m = 1500;
    pinAreas.push({ x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m });
  }
  for (const l of (ctx.landmarks && ctx.landmarks.landmarks) || []) {
    const m = l.kind === 'bridge' ? 1600 : 450;
    pinAreas.push({ x0: l.x - m, x1: l.x + m, z0: l.z - m, z1: l.z + m });
  }
  let pinsDone = false;
  request(root, 0);
  internalPump();   // start streaming the coarse focus view while the pinned heights load
  const tp = performance.now();
  let pinned = 0;
  try {
    pinned = await loadPinPack();
  } catch (e) {
    // fallback (no pack / no DecompressionStream): range-request the airport + landmark tiles
    console.warn('[terrain] pin pack unavailable, fetching tiles', e.message);
    pinned = await pinHeights(pinAreas, ctx.quality && (ctx.quality.imageryMaxLevel ?? 0) < 0 ? 9 : 99);
  }
  pinsDone = true;
  stats.pinned = pinned; stats.pinSeconds = +((performance.now() - tp) / 1000).toFixed(2);

  return {
    object,
    getHeight,
    isWater,
    ready,
    stats,
    prof,
    nodes,
    shared,
    /** Local terrain normal (for placing objects), from the rendered surface. */
    getNormal(x, z, out = new THREE.Vector3()) {
      const e = 1.0;
      const hx = getHeight(x + e, z) - getHeight(x - e, z), hz = getHeight(x, z + e) - getHeight(x, z - e);
      return out.set(-hx, 2 * e, -hz).normalize();
    },
    update(dt, camera) {
      lastExternal = performance.now();
      step(camera, false, dt);
    },
    /** Live quality change (CONTRACTS-SF.md §8): terrainError, imageryMaxLevel, water, anisotropy. */
    setQuality(q) {
      const oldCap = qual.imgCap;
      const waterChanged = setTerrainWaterQuality(q.water || 'high');
      readQuality(q);
      if (qual.imgCap !== oldCap) {
        // tiles finer than the lower cap reference / should reference different imagery: re-stream them
        refreshChildImg();
        const cut = Math.min(oldCap, qual.imgCap);
        for (const n of [...loadedSet]) if (n.L > cut) unloadNode(n);
        for (const n of built.splice(0)) { if (n.bitmap && n.bitmap.close) n.bitmap.close(); n.bitmap = null; n.state = UNLOADED; }
      }
      if (waterChanged) for (const n of loadedSet) if (n.mesh) applyWaterDefine(n.mesh.material);
      waveTex.anisotropy = shared.uDetailTex.value.anisotropy = Math.min(qual.aniso, maxAniso);
    },
    get quality() { return { ...qual }; },
    dispose() {
      disposed = true;
      for (const n of nodes.values()) if (n.state === READY) unloadNode(n);
    },
  };
}
