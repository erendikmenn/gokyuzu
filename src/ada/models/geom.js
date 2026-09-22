// Procedural geometry helpers shared by the aircraft and airport models.
// Everything here is plain math on BufferGeometry: lofts, airfoils, tubes and a
// per-material "builder" that merges static parts into as few meshes as possible.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const DEG = Math.PI / 180;
export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const KEEP = new Set(['position', 'normal', 'uv', 'color']);

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

// Monotone cubic (Fritsch-Carlson) interpolation: smooth, never overshoots the keys.
export function monotone(xs, ys) {
  const n = xs.length;
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Grid surfaces
// ---------------------------------------------------------------------------

// rows: array of arrays of Vector3 (all rows same length). Triangles (a,c,b) where
// a=(i,j), b=(i+1,j), c=(i,j+1) have normal (colDir x rowDir); `flip` reverses that.
export function gridGeometry(rows, { flip = false, closed = false, uvFn = null, colorFn = null } = {}) {
  const R = rows.length, C = rows[0].length;
  const pos = new Float32Array(R * C * 3);
  const uv = new Float32Array(R * C * 2);
  const col = colorFn ? new Float32Array(R * C * 3) : null;
  let p = 0, q = 0, k = 0;
  const tmp = new THREE.Color();
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const v = rows[i][j];
      pos[p++] = v.x; pos[p++] = v.y; pos[p++] = v.z;
      if (uvFn) { const [u, w] = uvFn(v, i, j); uv[q++] = u; uv[q++] = w; } else { uv[q++] = j / (C - 1); uv[q++] = i / (R - 1); }
      if (col) { tmp.copy(colorFn(v, i, j)); col[k++] = tmp.r; col[k++] = tmp.g; col[k++] = tmp.b; }
    }
  }
  const idx = [];
  const cc = closed ? C : C - 1;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < cc; j++) {
      const j2 = (j + 1) % C;
      const a = i * C + j, b = (i + 1) * C + j, c = i * C + j2, d = (i + 1) * C + j2;
      if (!flip) idx.push(a, c, b, c, d, b); else idx.push(a, b, c, c, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Flat polygon fan (convex-ish outline) facing `facing` (a Vector3). Returns non-indexed geometry.
export function fanCap(points, facing, uvFn = null) {
  const c = V3();
  for (const p of points) c.add(p);
  c.multiplyScalar(1 / points.length);
  const pos = [], uv = [];
  const n = points.length;
  // decide winding from the first non-degenerate triangle
  let sign = 1;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const nn = V3().subVectors(a, c).cross(V3().subVectors(b, c));
    if (nn.lengthSq() > 1e-12) { sign = nn.dot(facing) >= 0 ? 1 : -1; break; }
  }
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const tri = sign > 0 ? [c, a, b] : [c, b, a];
    for (const v of tri) {
      pos.push(v.x, v.y, v.z);
      if (uvFn) uv.push(...uvFn(v)); else uv.push(0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Airfoils
// ---------------------------------------------------------------------------

// NACA 4-digit style: returns { yc, yt } at chord fraction x (closed trailing edge).
export function naca(x, t, m = 0, p = 0.4) {
  const xx = clamp(x, 0, 1);
  const yt = 5 * t * (0.2969 * Math.sqrt(xx) - 0.1260 * xx - 0.3516 * xx * xx + 0.2843 * xx ** 3 - 0.1036 * xx ** 4);
  let yc = 0;
  if (m > 0) yc = xx < p ? (m / (p * p)) * (2 * p * xx - xx * xx) : (m / ((1 - p) ** 2)) * ((1 - 2 * p) + 2 * p * xx - xx * xx);
  return { yc, yt };
}

// 2D closed profile of one section (in chord-normalised units). Returns
// { upper: [[f,h]...] from rear to front, lower: [[f,h]...] from front to rear, truncated }
//   x0 > 0 gives a control surface with a rounded nose centred on the hinge (x0, yc(x0)).
//   x1 < 1 truncates the rear (the part in front of a control surface).
function profile2D(sec, N) {
  const { t, m = 0, p = 0.4 } = sec;
  const x0 = sec.x0 ?? 0, x1 = sec.x1 ?? 1;
  const upper = [], lower = [];
  if (x0 <= 1e-6) {
    const xs = [];
    for (let i = 0; i <= N; i++) xs.push(x1 * (1 - Math.cos((Math.PI / 2) * (i / N))));
    for (let i = N; i >= 0; i--) { const { yc, yt } = naca(xs[i], t, m, p); upper.push([xs[i], yc + yt]); }
    for (let i = 0; i <= N; i++) { const { yc, yt } = naca(xs[i], t, m, p); lower.push([xs[i], yc - yt]); }
  } else {
    const { yc: c0, yt: r } = naca(x0, t, m, p);
    const K = 4;
    for (let i = N; i >= 0; i--) {
      const x = x0 + (x1 - x0) * (i / N);
      const { yc, yt } = naca(x, t, m, p);
      upper.push([x, yc + yt]);
    }
    for (let k = 1; k <= K; k++) { const a = (Math.PI / 2) * (k / K); upper.push([x0 - r * Math.sin(a), c0 + r * Math.cos(a)]); }
    for (let k = K; k >= 1; k--) { const a = (Math.PI / 2) * (k / K); lower.push([x0 - r * Math.sin(a), c0 - r * Math.cos(a)]); }
    for (let i = 0; i <= N; i++) {
      const x = x0 + (x1 - x0) * (i / N);
      const { yc, yt } = naca(x, t, m, p);
      lower.push([x, yc - yt]);
    }
  }
  return { upper, lower, truncated: x1 < 0.999 };
}

// Point on a section: o + cdir * c * f + up * c * h * (thickScale)
function secPoint(sec, f, h) {
  const k = sec.c;
  return V3().copy(sec.o).addScaledVector(sec.cdir, k * f).addScaledVector(sec.up, k * h);
}

// Loft an airfoil through `sections` ({o, cdir, up, c, t, m, p, x0, x1}).
// Options: N (points per surface), split (separate upper/lower strips; needed for side-projected UVs),
// uvFn(v, side) -> [u,v] (side +1 = upper strip, -1 = lower strip), color, caps [start,end].
// Returns an array of geometries (strips + caps).
export function airfoilLoft(sections, { N = 12, split = false, uvFn = null, caps = [true, true] } = {}) {
  const profs = sections.map((s) => profile2D(s, N));
  const L = V3().subVectors(sections[sections.length - 1].o, sections[0].o).normalize();
  const s0 = sections[0];
  // winding: the loop runs upper(rear->front) -> lower(front->rear); outward on upper = +up
  const flip = V3().copy(s0.cdir).negate().cross(L).dot(s0.up) < 0;
  const out = [];
  const mk = (pick, side) => {
    const rows = sections.map((s, i) => pick(profs[i]).map(([f, h]) => secPoint(s, f, h)));
    const g = gridGeometry(rows, { flip, uvFn: uvFn ? (v) => uvFn(v, side) : null });
    return g;
  };
  if (split) {
    const gu = mk((pr) => pr.upper, 1);
    const gl = mk((pr) => pr.lower, -1);
    // smooth the leading-edge seam: remove the component along `up` of the seam normals
    for (const [g, col] of [[gu, (sections.length && profs[0].upper.length - 1)], [gl, 0]]) {
      const nrm = g.attributes.normal, C = (col === 0 ? profs[0].lower.length : profs[0].upper.length);
      for (let i = 0; i < sections.length; i++) {
        const vi = i * C + col;
        const n = V3().fromBufferAttribute(nrm, vi);
        n.addScaledVector(sections[i].up, -n.dot(sections[i].up)).normalize();
        nrm.setXYZ(vi, n.x, n.y, n.z);
      }
    }
    out.push(gu, gl);
  } else {
    out.push(mk((pr) => pr.upper.concat(pr.lower.slice(1)), 1));
  }
  if (profs[0].truncated) {
    // flat rear face: lower-rear -> upper-rear
    out.push(mk((pr) => [pr.lower[pr.lower.length - 1], pr.upper[0]], 1));
  }
  const capAt = (i, facing) => {
    const pr = profs[i];
    const pts = pr.upper.concat(pr.lower.slice(1, pr.truncated ? undefined : -1)).map(([f, h]) => secPoint(sections[i], f, h));
    out.push(fanCap(pts, facing, uvFn ? (v) => uvFn(v, 1) : null));
  };
  if (caps[0]) capAt(0, L.clone().negate());
  if (caps[1]) capAt(sections.length - 1, L.clone());
  return out;
}

// ---------------------------------------------------------------------------
// Tubes
// ---------------------------------------------------------------------------

// Tube along a polyline of centres with per-station elliptical radii.
// stations: [{ p: Vector3, a: radius along e1, b: radius along e2 }], e1 hint = `chordAxis`.
// The cross-section keeps its major axis as close to `chordAxis` as possible.
export function tube(stations, { segs = 10, chordAxis = V3(0, 0, 1), capStart = false, capEnd = false, shape = null } = {}) {
  const rows = [];
  const frames = [];
  for (let i = 0; i < stations.length; i++) {
    const prev = stations[Math.max(0, i - 1)].p, next = stations[Math.min(stations.length - 1, i + 1)].p;
    const d = V3().subVectors(next, prev).normalize();
    let e1 = V3().copy(chordAxis).addScaledVector(d, -chordAxis.dot(d));
    if (e1.lengthSq() < 1e-8) e1 = Math.abs(d.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
    e1.normalize();
    const e2 = V3().crossVectors(d, e1).normalize(); // e1 x e2 = d
    frames.push({ d, e1, e2 });
    const s = stations[i];
    const row = [];
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      let ca = Math.cos(a), sa = Math.sin(a);
      if (shape) [ca, sa] = shape(a);
      row.push(V3().copy(s.p).addScaledVector(e1, s.a * ca).addScaledVector(e2, s.b * sa));
    }
    rows.push(row);
  }
  const geos = [gridGeometry(rows, { closed: true })];
  if (capStart) geos.push(fanCap(rows[0], frames[0].d.clone().negate()));
  if (capEnd) geos.push(fanCap(rows[rows.length - 1], frames[frames.length - 1].d.clone()));
  return geos.length === 1 ? geos[0] : mergeClean(geos);
}

// Streamlined strut between two points (chord along `chordAxis`).
export function strut(A, B, chord, thick, segs = 10, chordAxis = V3(0, 0, 1)) {
  // teardrop-ish section: round nose, tapered tail
  const shape = (a) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    return [ca, ca > 0 ? sa * (1 - 0.45 * ca) : sa];
  };
  return tube([{ p: A, a: chord / 2, b: thick / 2 }, { p: B, a: chord / 2, b: thick / 2 }], { segs, chordAxis, shape });
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export function flipWindingNonIndexed(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name], s = a.itemSize, arr = a.array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (i + 1) * s + k, i2 = (i + 2) * s + k;
        const t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
      }
    }
    a.needsUpdate = true;
  }
}

// Normalise a geometry for merging: non-indexed, only position/normal/uv(/color).
export function clean(geo, { matrix = null, color = null, withColor = false } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.clearGroups();
  for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (matrix) {
    g.applyMatrix4(matrix);
    if (matrix.determinant() < 0) flipWindingNonIndexed(g);
  }
  if (color !== null && color !== undefined) {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  } else if (withColor && !g.attributes.color) {
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  } else if (!withColor && g.attributes.color && color === undefined) {
    // keep existing colours
  }
  return g;
}

export function mergeClean(list) {
  const hasColor = list.some((g) => g.attributes.color);
  const cl = list.map((g) => clean(g, { withColor: hasColor }));
  return mergeGeometries(cl, false);
}

// Mirror a geometry across the YZ plane (x -> -x), fixing winding.
export function mirrorX(geo) {
  const m = new THREE.Matrix4().makeScale(-1, 1, 1);
  return clean(geo, { matrix: m });
}

// Collects geometries per material key, then merges them.
export class Builder {
  constructor() { this.parts = new Map(); }
  add(key, geo, { color, matrix } = {}) {
    const list = Array.isArray(geo) ? geo : [geo];
    if (!this.parts.has(key)) this.parts.set(key, []);
    for (const g of list) this.parts.get(key).push(clean(g, { matrix, color, withColor: color !== undefined }));
    return this;
  }
  has(key) { return this.parts.has(key) && this.parts.get(key).length > 0; }
  geometry(key) {
    const list = this.parts.get(key);
    if (!list || !list.length) return null;
    const hasColor = list.some((g) => g.attributes.color);
    const fixed = list.map((g) => {
      if (hasColor && !g.attributes.color) return clean(g, { withColor: true });
      if (!hasColor && g.attributes.color) { const c = g.clone(); c.deleteAttribute('color'); return c; }
      return g;
    });
    return mergeGeometries(fixed, false);
  }
  keys() { return [...this.parts.keys()]; }
}

export function mat4(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], order = 'XYZ') {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], order)),
    new THREE.Vector3(...scale),
  );
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat = false, anisotropy = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// Radial glow sprite texture (white; tint with material colour).
let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = makeCanvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = canvasTexture(c);
  return glowTex;
}

// Deterministic PRNG
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
