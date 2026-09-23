// LOD-first aircraft start (docs/perf/plan.md, change #2): on a cold start the game starts with the aircraft's small
// `_lod.glb` (0.4–0.6 MB) instead of the full exterior GLB (2.7–6.6 MB) and swaps the full model in after the first
// playable frame (main.js).
//
// The stand-in must behave exactly like the full rig for everything but the look of the mesh: the flight model takes
// its gear contacts from the rig once (they must be the full model's), the camera its eye point and bounds, the rig
// code its animated nodes, lights and the afterburner/rotor effects. So the stand-in is the aircraft's own createRig()
// run on a *skeleton* of the full GLB: its JSON chunk (the first 45–110 KB of the file, fetched with a Range request)
// parsed by GLTFLoader with meshes replaced by invisible placeholders (same node tree, names, extras and transforms;
// each placeholder carries the bounding box GLTFLoader would give the real primitive, from the accessor min/max), and
// the LOD meshes grafted onto it (a LOD mesh under a node that the full model also has, e.g. the UH-60 rotor blades,
// moves with that node). Eye points, contacts and bounds therefore come out bit-identical to the full rig's.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetFetch, assetUrl } from '../core/assets.js';

// Returning players: a full model this browser has already downloaded (same versioned URL) is most likely still in its
// HTTP cache and loads as fast as the LOD, so the game starts with it directly. Remembered in localStorage (asking the
// cache itself with fetch(…, { cache: 'only-if-cached' }) logs a console error on every miss).
const SEEN_KEY = 'gokyuzu.models';
const modelKey = (url) => { try { return new URL(url, document.baseURI).pathname; } catch { return String(url); } };
function seenModels() { try { const s = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
/** True when this browser downloaded exactly this version of the model before. */
export function modelSeen(url) { return seenModels()[modelKey(url)] === assetUrl(url); }
/** Remember a completed download of the model (see modelSeen). */
export function noteModelLoaded(url) {
  try { const s = seenModels(); s[modelKey(url)] = assetUrl(url); localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/**
 * Download rate (Mbit/s) seen by this page so far (Resource Timing: bytes over the time any response body was
 * arriving), or null with too little data (everything from the cache). On a fast connection the full model costs well
 * under a second: the game then starts with it (no LOD phase, no swap after the start).
 */
export function measuredMbps() {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return null;
  let bytes = 0;
  const spans = [];
  for (const e of performance.getEntriesByType('resource')) {
    if (!(e.transferSize > 0) || !(e.responseEnd > e.responseStart)) continue;
    bytes += e.encodedBodySize || e.transferSize;
    spans.push([e.responseStart, e.responseEnd]);
  }
  if (bytes < 300e3) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let busy = 0, s = spans[0][0], t = spans[0][1];
  for (const [a, b] of spans) { if (a > t) { busy += t - s; s = a; t = b; } else if (b > t) t = b; }
  busy += t - s;
  return busy > 0 ? (bytes * 8) / (busy * 1000) : null;
}

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a;

/** The glTF JSON of a GLB, read from the start of the file (Range request; a server that ignores Range is cut short). */
export async function loadGlbJson(url, guess = 128 * 1024) {
  let buf = new Uint8Array(0), need = 20;
  const append = (v) => { const b = new Uint8Array(buf.length + v.length); b.set(buf); b.set(v, buf.length); buf = b; };
  const header = () => {
    const dv = new DataView(buf.buffer, buf.byteOffset, 20);
    if (dv.getUint32(0, true) !== GLB_MAGIC || dv.getUint32(16, true) !== CHUNK_JSON) throw new Error(`not a GLB ${url}`);
    need = 20 + dv.getUint32(12, true);
  };
  for (let attempt = 0; attempt < 3 && buf.length < need; attempt++) {
    const from = buf.length, to = Math.max(need, from + guess) - 1;
    const r = await assetFetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    if (!r.ok) { if (r.body) r.body.cancel().catch(() => {}); throw new Error(`HTTP ${r.status} ${url}`); }
    if (from > 0 && r.status !== 206) { if (r.body) r.body.cancel().catch(() => {}); throw new Error(`no range support ${url}`); }
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(value);
      if (need === 20 && buf.length >= 20) header();
      if (buf.length >= need) { reader.cancel().catch(() => {}); break; }
    }
  }
  if (buf.length < need) throw new Error(`short GLB header ${url}`);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, need)));
}

// Placeholder geometry: empty vertex attributes with the real primitive's names and sizes (a material the rig puts on a
// placeholder then compiles the same shader variant as on the real mesh, and draws nothing), and GLTFLoader's
// computeBounds (boundingBox/Sphere from the POSITION accessor min/max).
const NORM = { 5120: 1 / 127, 5121: 1 / 255, 5122: 1 / 32767, 5123: 1 / 65535 };
const ATTR = { POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'uv', TEXCOORD_1: 'uv1', TEXCOORD_2: 'uv2', TEXCOORD_3: 'uv3', COLOR_0: 'color' };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function placeholderGeometry(json, prim) {
  const geo = new THREE.BufferGeometry();
  for (const [k, i] of Object.entries(prim.attributes || {})) {
    const name = ATTR[k], acc = json.accessors[i];
    if (name && acc) geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), SIZE[acc.type] || 3));
  }
  const a = prim.attributes && prim.attributes.POSITION !== undefined ? json.accessors[prim.attributes.POSITION] : null;
  if (!a || !a.min || !a.max) return geo;
  const box = new THREE.Box3(new THREE.Vector3().fromArray(a.min), new THREE.Vector3().fromArray(a.max));
  if (a.normalized && NORM[a.componentType]) { box.min.multiplyScalar(NORM[a.componentType]); box.max.multiplyScalar(NORM[a.componentType]); }
  if (prim.targets) {
    const d = new THREE.Vector3(), v = new THREE.Vector3();
    for (const t of prim.targets) {
      const ta = t.POSITION !== undefined ? json.accessors[t.POSITION] : null;
      if (!ta || !ta.min || !ta.max) continue;
      v.set(Math.max(Math.abs(ta.min[0]), Math.abs(ta.max[0])), Math.max(Math.abs(ta.min[1]), Math.abs(ta.max[1])), Math.max(Math.abs(ta.min[2]), Math.abs(ta.max[2])));
      if (ta.normalized && NORM[ta.componentType]) v.multiplyScalar(NORM[ta.componentType]);
      d.max(v);
    }
    box.expandByVector(d);
  }
  geo.boundingBox = box;
  const sphere = new THREE.Sphere();
  box.getCenter(sphere.center);
  sphere.radius = box.min.distanceTo(box.max) / 2;
  geo.boundingSphere = sphere;
  return geo;
}

/** GLTFLoader plugin: every mesh becomes an invisible placeholder (no buffers, materials or textures are loaded). */
class SkeletonMeshes {
  constructor(parser) { this.parser = parser; this.name = 'gokyuzu_skeleton'; this.materials = new Map(); }
  material(index) {
    let m = this.materials.get(index);
    if (!m) {
      const def = index !== undefined ? this.parser.json.materials[index] : null;
      m = new THREE.MeshBasicMaterial({ visible: false });
      m.name = (def && def.name) || '';
      this.materials.set(index, m);
    }
    return m;
  }
  loadMesh(meshIndex) {
    const parser = this.parser, json = parser.json, def = json.meshes[meshIndex];
    const meshes = def.primitives.map((p, i) => {
      const mesh = new THREE.Mesh(placeholderGeometry(json, p), this.material(p.material));
      mesh.name = parser.createUniqueName(def.name || `mesh_${meshIndex}`);
      if (def.extras && typeof def.extras === 'object') Object.assign(mesh.userData, def.extras);
      mesh.userData.placeholder = true;
      parser.associations.set(mesh, { meshes: meshIndex, primitives: i });
      return mesh;
    });
    if (meshes.length === 1) return Promise.resolve(meshes[0]);
    const group = new THREE.Group();
    parser.associations.set(group, { meshes: meshIndex });
    for (const m of meshes) group.add(m);
    return Promise.resolve(group);
  }
}

/**
 * The node tree of a GLB from its JSON (GLTFLoader, so names, extras and transforms are exactly what a full load gives),
 * meshes as invisible placeholders with the real bounding boxes. Rejects for files it cannot represent (skins).
 */
export function parseSkeleton(json, dracoLoader) {
  if ((json.skins && json.skins.length) || (json.nodes || []).some((n) => n.skin !== undefined)) return Promise.reject(new Error('skinned GLB'));
  const j = { ...json, animations: undefined };   // animation clips would read buffers (none of the aircraft has any)
  const loader = new GLTFLoader();
  if (dracoLoader) loader.setDRACOLoader(dracoLoader);   // required by files that list KHR_draco_mesh_compression; nothing is decoded
  loader.register((parser) => new SkeletonMeshes(parser));
  return new Promise((resolve, reject) => loader.parse(j, '', (g) => resolve(g.scene), reject));
}

/**
 * Hang the LOD model's meshes onto the skeleton: a mesh below a node that the skeleton also has (same name) is attached
 * to that node, so the rig animates it (UH-60 rotor blades, discs); everything else goes under the skeleton root. The LOD
 * and the full GLB share the frame (origin = CG, nose −Z) and the rest poses of common nodes.
 * The LOD file is shared with the airports' parked aircraft (same cached load): the stand-in gets its own copies of the
 * materials (rigs change lens / light materials by name), geometries and textures stay shared and are never disposed.
 * Returns the copied materials (to dispose after the swap).
 */
export function graftLod(skeleton, lodScene) {
  skeleton.updateMatrixWorld(true);
  lodScene.updateMatrixWorld(true);
  const named = new Map();
  skeleton.traverse((o) => { if (o.name && !named.has(o.name)) named.set(o.name, o); });
  const meshes = [];
  lodScene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
  const copies = new Map();
  const own = (mat) => { if (!mat) return mat; let c = copies.get(mat); if (!c) { c = mat.clone(); copies.set(mat, c); } return c; };
  for (const m of meshes) {
    let anchor = m, target = null;
    for (; anchor && anchor !== lodScene; anchor = anchor.parent) if (anchor.name && named.has(anchor.name)) { target = named.get(anchor.name); break; }
    if (!target) { anchor = lodScene; target = skeleton; }
    const copy = new THREE.Mesh(m.geometry, Array.isArray(m.material) ? m.material.map(own) : own(m.material));
    rel.multiplyMatrices(inv.copy(anchor.matrixWorld).invert(), m.matrixWorld);
    rel.decompose(copy.position, copy.quaternion, copy.scale);
    copy.renderOrder = m.renderOrder;
    copy.frustumCulled = m.frustumCulled;
    copy.userData.lod = true;
    target.add(copy);
  }
  return { materials: new Set(copies.values()) };
}

/** Deep copy of a VisualState (the flight models reuse one object), for replaying it into the full rig. */
export function copyVisual(v) {
  if (typeof structuredClone === 'function') { try { return structuredClone(v); } catch { /* fall through */ } }
  return JSON.parse(JSON.stringify(v));
}
