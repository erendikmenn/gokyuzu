// W3: San Francisco Bay landmarks layer (Golden Gate, Bay Bridge, towers, Alcatraz, ...).
// Assets are built offline in Blender (blender/landmarks/*.py) → assets/sf/landmarks/*.glb + index.json
// (placements, LOD distances, collision primitives, light positions). See CONTRACTS-SF.md §6.1 (Layer).
import * as THREE from 'three';
import { createTraffic } from './landmarks_traffic.js';
import { isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';

const BASE = 'assets/sf/landmarks/';
const CELL = 128;                     // collision grid cell (m)
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

// ---------------------------------------------------------------------------------------------- glow lights
// Additive point sprites with a minimum on-screen size so aviation lights stay visible from far away.
function createGlow(maxCount) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(maxCount * 3);
  const col = new Float32Array(maxCount * 3);
  const size = new Float32Array(maxCount);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 }, uMinPx: { value: 2.2 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize;
      uniform float uScale; uniform float uMinPx;
      varying vec3 vColor; varying float vFade;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float px = aSize * uScale / max(-mv.z, 0.1);
        vFade = clamp(px / uMinPx, 0.35, 1.0);
        gl_PointSize = clamp(px, uMinPx, 256.0);
        vColor = aColor;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vFade;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float halo = exp(-r * r * 5.0);
        float core = smoothstep(0.32, 0.0, r);
        gl_FragColor = vec4(vColor * (halo * 0.9 + core * 1.6) * vFade, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 10;
  points.name = 'landmark_lights';
  const lights = [];
  let lastT = -1, lastNight = -1, lastCount = -1;
  return {
    points, lights,
    clear() { lights.length = 0; geo.setDrawRange(0, 0); },
    add(worldPos, color, sizeM, period, duty, phase, intensity, kind) {
      if (lights.length >= maxCount) return;
      const i = lights.length;
      pos.set([worldPos.x, worldPos.y, worldPos.z], i * 3);
      size[i] = sizeM;
      const c = new THREE.Color(color);
      lights.push({ r: c.r, g: c.g, b: c.b, period, duty, phase, intensity, kind });
      geo.setDrawRange(0, lights.length);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.computeBoundingSphere();
    },
    update(t, camera, renderer, night) {
      const h = renderer ? renderer.domElement.height : 900;
      mat.uniforms.uScale.value = h / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      // colors only change with blinking (>= 0.75 s periods) and the day/night factor: refresh at ~20 Hz
      if (t - lastT < 0.05 && Math.abs(night - lastNight) < 0.01 && lights.length === lastCount) return;
      lastT = t; lastNight = night; lastCount = lights.length;
      for (let i = 0; i < lights.length; i++) {
        const L = lights[i];
        let on = 1;
        if (L.period > 0) on = ((t / L.period + L.phase) % 1) < L.duty ? 1 : 0.04;
        // aviation lights are dimmer by day; navigation/street lights only at night
        const k = (L.kind === 'warn' ? 0.7 + 1.3 * night : L.kind === 'lamp' ? night * 1.2 : 0.25 + 0.9 * night) * L.intensity * on;
        col[i * 3] = L.r * k; col[i * 3 + 1] = L.g * k; col[i * 3 + 2] = L.b * k;
      }
      geo.attributes.aColor.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------------------------- collision grid
// Each primitive stores its vertical extent at build time: `top` and `bot`. `bot` is -Infinity for grounded obstacles
// (towers, piers, buildings: their bottom is at/below the terrain) and the real underside for floating ones (bridge
// decks, portal struts, cables, crane booms) so that flying *under* them is not treated as an obstacle.
const FLOAT_CLEARANCE = 3.0;   // m: a primitive whose bottom is this far above the ground under it is "floating"

function createCollision(groundAt = () => 0) {
  const cells = new Map();
  const key = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  const prims = [];
  let stamp = 0;
  const ground = (x, z) => { const g = groundAt(x, z); return Number.isFinite(g) ? g : 0; };
  function insert(p, minX, minZ, maxX, maxZ) {
    p.stamp = 0;
    prims.push(p);
    for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
      for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
        const k = key(ix, iz);
        let a = cells.get(k);
        if (!a) cells.set(k, a = []);
        a.push(p);
      }
    }
  }
  // vertical extent [bot, top] of primitive p over the ground point (x, z), or null if p does not cover it
  function column(p, x, z, out) {
    if (p.t === 0) {
      const dx = x - p.cx, dz = z - p.cz;
      const lx = dx * p.c - dz * p.s, lz = dx * p.s + dz * p.c;
      if (Math.abs(lx) > p.hx || Math.abs(lz) > p.hz) return null;
      out.top = p.cy + p.hy;
      out.bot = p.bot;
      return out;
    }
    // capsule: interval of the segment parameter t whose horizontal distance to (x, z) is <= r
    const ux = p.bx - p.ax, uz = p.bz - p.az, wx = x - p.ax, wz = z - p.az;
    const L2 = ux * ux + uz * uz, r2 = p.r * p.r, ww = wx * wx + wz * wz;
    let t0, t1;
    if (L2 < 1e-6) {                               // vertical capsule (mast, leg segment)
      if (ww > r2) return null;
      t0 = 0; t1 = 1;
    } else {
      const wu = wx * ux + wz * uz;
      const disc = wu * wu - L2 * (ww - r2);
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      t0 = Math.max(0, (wu - sq) / L2); t1 = Math.min(1, (wu + sq) / L2);
      if (t0 > t1) {                               // only the end spheres can cover the point
        const e = Math.min((x - p.ax) ** 2 + (z - p.az) ** 2, (x - p.bx) ** 2 + (z - p.bz) ** 2);
        if (e > r2) return null;
        t0 = t1 = (x - p.ax) ** 2 + (z - p.az) ** 2 < (x - p.bx) ** 2 + (z - p.bz) ** 2 ? 0 : 1;
      }
    }
    const y0 = p.ay + (p.by - p.ay) * t0, y1 = p.ay + (p.by - p.ay) * t1;
    out.top = Math.max(y0, y1) + p.r;
    out.bot = p.grounded ? -Infinity : Math.min(y0, y1) - p.r;
    return out;
  }
  const tmp = { top: 0, bot: 0 };
  return {
    prims,
    addBox(cx, cy, cz, hx, hy, hz, yaw, name) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const ex = Math.abs(hx * c) + Math.abs(hz * s), ez = Math.abs(hx * s) + Math.abs(hz * c);
      // highest ground under the footprint (center + corners)
      let g = ground(cx, cz);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = sx * hx, lz = sz * hz;
        g = Math.max(g, ground(cx + lx * c + lz * s, cz - lx * s + lz * c));
      }
      const bottom = cy - hy;
      insert({ t: 0, cx, cy, cz, hx, hy, hz, c, s, name, bot: bottom > g + FLOAT_CLEARANCE ? bottom : -Infinity },
        cx - ex, cz - ez, cx + ex, cz + ez);
    },
    addCapsule(ax, ay, az, bx, by, bz, r, name, solid = false) {
      const g = Math.max(ground(ax, az), ground(bx, bz), ground((ax + bx) / 2, (az + bz) / 2));
      const grounded = solid || Math.min(ay, by) - r <= g + FLOAT_CLEARANCE;
      insert({ t: 1, ax, ay, az, bx, by, bz, r, name, grounded },
        Math.min(ax, bx) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(az, bz) + r);
    },
    /** Top of the tallest primitive (box or capsule: towers, masts, cables, decks) covering (x, z), or -Infinity. */
    heightAt(x, z) {
      const a = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      let h = -Infinity;
      if (!a) return h;
      for (const p of a) {
        if (column(p, x, z, tmp) && tmp.top > h) h = tmp.top;
      }
      return h;
    },
    /** Vertical span of the obstacles covering (x, z): { bottom, top }. bottom = -Infinity when a grounded obstacle
     * covers the point; for bridge decks/cables/struts it is the underside of the lowest floating part. Nothing
     * there: { bottom: -Infinity, top: -Infinity }. Writes into `out` when given (no allocation). */
    spanAt(x, z, out = { bottom: -Infinity, top: -Infinity }) {
      out.bottom = Infinity; out.top = -Infinity;
      const a = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (a) {
        for (const p of a) {
          if (!column(p, x, z, tmp)) continue;
          if (tmp.top > out.top) out.top = tmp.top;
          if (tmp.bot < out.bottom) out.bottom = tmp.bot;
        }
      }
      if (out.top === -Infinity) out.bottom = -Infinity;
      return out;
    },
    hitTest(x, y, z, r) {
      stamp++;
      const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
      const k0 = Math.floor((z - r) / CELL), k1 = Math.floor((z + r) / CELL);
      for (let ix = i0; ix <= i1; ix++) for (let iz = k0; iz <= k1; iz++) {
        const a = cells.get(key(ix, iz));
        if (!a) continue;
        for (const p of a) {
          if (p.stamp === stamp) continue;
          p.stamp = stamp;
          if (p.t === 0) {
            const dx = x - p.cx, dz = z - p.cz, dy = y - p.cy;
            const lx = dx * p.c - dz * p.s, lz = dx * p.s + dz * p.c;
            const qx = lx - Math.max(-p.hx, Math.min(p.hx, lx));
            const qy = dy - Math.max(-p.hy, Math.min(p.hy, dy));
            const qz = lz - Math.max(-p.hz, Math.min(p.hz, lz));
            if (qx * qx + qy * qy + qz * qz <= r * r) return p.name;
          } else {
            const ux = p.bx - p.ax, uy = p.by - p.ay, uz = p.bz - p.az;
            const wx = x - p.ax, wy = y - p.ay, wz = z - p.az;
            const L2 = ux * ux + uy * uy + uz * uz;
            const t = L2 > 0 ? Math.max(0, Math.min(1, (wx * ux + wy * uy + wz * uz) / L2)) : 0;
            const qx = wx - ux * t, qy = wy - uy * t, qz = wz - uz * t;
            const rr = r + p.r;
            if (qx * qx + qy * qy + qz * qz <= rr * rr) return p.name;
          }
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------------------------- materials
// Thin ropes (suspenders, hand ropes) are centimetres wide: without MSAA they break into dashes at a distance.
// *_cable materials push their vertices out along the normal so that a rope stays about 1 px wide (fades out at 4 km).
const ROPE = { uLmPixel: { value: 0.001 } };
function widenRopes(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLmPixel = ROPE.uLmPixel;
    sh.vertexShader = 'uniform float uLmPixel;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 lmView = modelViewMatrix * vec4(transformed, 1.0);
        float lmDist = max(-lmView.z, 0.0);
        transformed += normalize(objectNormal) * (lmDist * uLmPixel * 0.5) * (1.0 - smoothstep(2500.0, 4000.0, lmDist));
      }`);
  };
  m.customProgramCacheKey = () => 'lm-rope';
}

function applyShadows(root, cast, receive) {
  root.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
}

function prepareMaterials(root, sink, { shadows = true, cast = shadows } = {}) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = cast;
    o.receiveShadow = shadows;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.userData.__lmPrepared) continue;
      m.userData.__lmPrepared = true;
      const n = m.name || '';
      if (n.endsWith('_clip')) {
        m.transparent = false; m.alphaTest = 0.5; m.side = THREE.DoubleSide; m.depthWrite = true;
        m.alphaToCoverage = true;
      }
      if (n.endsWith('_blend')) { m.transparent = true; m.depthWrite = false; }
      if (n.includes('_emit')) {
        m.userData.baseEmissive = m.emissiveIntensity;
        if (n.includes('warn')) sink.warn.push(m); else sink.lamp.push(m);
      }
      if (n.includes('_glass')) { m.envMapIntensity = 1.4; }
      if (n.endsWith('_cable')) widenRopes(m);
    }
  });
}

// ---------------------------------------------------------------------------------------------- landmarks
function placementY(def, terrain) {
  if (def.base !== 'terrain' || !terrain) return def.y || 0;
  // lowest ground under the footprint (foundations extend below the model origin)
  const pts = def.footprint || [[0, 0]];
  const c = Math.cos(-def.heading), s = Math.sin(-def.heading);
  let h = Infinity;
  for (const [lx, lz] of pts) {
    const wx = def.origin.x + lx * c + lz * s, wz = def.origin.z - lx * s + lz * c;
    h = Math.min(h, terrain.getHeight(wx, wz));
  }
  if (!Number.isFinite(h)) h = 0;
  return Math.max(h, def.minY ?? -Infinity) + (def.dy || 0);
}

// Ground anchors: buildings of multi-building sites (Alcatraz, Painted Ladies, ...) carry their design ground height;
// each one is re-snapped to the loaded terrain (over water the design height is kept, e.g. piers).
function anchorShift(ctx, group, ax, g, az, cache) {
  if (g <= -99) return 0;
  const key = `${Math.round(ax * 2)},${Math.round(az * 2)}`;
  let s = cache.get(key);
  if (s !== undefined) return s;
  s = 0;
  const t = ctx.terrain;
  if (t) {
    _v.set(ax, 0, az).applyMatrix4(group.matrixWorld);
    const h = t.getHeight(_v.x, _v.z);
    const water = t.isWater ? t.isWater(_v.x, _v.z) : false;
    if (Number.isFinite(h) && !water) s = THREE.MathUtils.clamp(h - g, -40, 40) - group.position.y;
  }
  cache.set(key, s);
  return s;
}

class Landmark {
  constructor(def, ctx, parent, sink, qs) {
    this.def = def;
    this.ctx = ctx;
    this.sink = sink;
    this.qs = qs;                 // shared quality state { lodScale, shadows }
    this.group = new THREE.Group();
    this.group.name = `landmark_${def.id}`;
    this.inst = def.instances || null;
    this.group.rotation.y = -def.heading;
    this.place();
    parent.add(this.group);
    this.lods = def.lods.map(() => null);     // loaded Object3D per LOD
    this.pending = def.lods.map(() => null);
    this.retryAt = def.lods.map(() => 0);     // LOD downloads that failed on a lost connection are asked again after this
    this.fails = 0;
    this.shown = -1;
    const b = def.bounds || { min: [-100, 0, -100], max: [100, 100, 100] };
    this.bmin = b.min; this.bmax = b.max;
  }

  /** (Re)compute the vertical placement from the terrain (called again once the terrain has streamed in). */
  place() {
    const { def, ctx } = this;
    this.baseY = this.def.instances && def.base === 'terrain' ? 0 : placementY(def, ctx.terrain);
    this.group.position.set(def.origin.x, this.baseY, def.origin.z);
    this.group.updateMatrixWorld(true);
    this.inv = this.group.matrixWorld.clone().invert();
    if (def.instances && def.base === 'terrain' && ctx.terrain) {
      // every copy sits on the ground under it
      this.inst = def.instances.map((p) => {
        _v.set(p[0], 0, p[2]).applyMatrix4(this.group.matrixWorld);
        const g = ctx.terrain.getHeight(_v.x, _v.z);
        return [p[0], (Number.isFinite(g) ? Math.max(g, def.minY ?? -Infinity) : 0) + (p[1] || 0), p[2], p[3] || 0, p[4] || 1];
      });
    }
    // refresh already-built instanced meshes / anchored buildings
    this.anchorCache = new Map();
    for (const holder of this.lods || []) {
      if (!holder) continue;
      if (holder.userData.instanced) this.writeInstances(holder);
      this.applyAnchors(holder);
    }
  }

  applyAnchors(obj) {
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes._anchor) return;
      const geo = o.geometry;
      const pos = geo.attributes.position, an = geo.attributes._anchor;
      if (!geo.userData.y0) geo.userData.y0 = Float32Array.from({ length: pos.count }, (_, i) => pos.getY(i));
      const y0 = geo.userData.y0;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, y0[i] + anchorShift(this.ctx, this.group, an.getX(i), an.getY(i), an.getZ(i), this.anchorCache));
      }
      pos.needsUpdate = true;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
    });
  }

  writeInstances(holder) {
    const tmp = new THREE.Object3D();
    for (const im of holder.children) {
      this.inst.forEach((p, k) => {
        tmp.position.set(p[0], p[1] || 0, p[2]);
        tmp.rotation.set(0, p[3] || 0, 0);
        tmp.scale.setScalar(p[4] || 1);
        tmp.updateMatrix();
        _m.multiplyMatrices(tmp.matrix, im.userData.base);
        im.setMatrixAt(k, _m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }

  distanceTo(pos) {
    _v.copy(pos).applyMatrix4(this.inv);
    const dx = Math.max(this.bmin[0] - _v.x, 0, _v.x - this.bmax[0]);
    const dy = Math.max(this.bmin[1] - _v.y, 0, _v.y - this.bmax[1]);
    const dz = Math.max(this.bmin[2] - _v.z, 0, _v.z - this.bmax[2]);
    return Math.hypot(dx, dy, dz);
  }

  wantedLod(dist) {
    const L = this.def.lods, k = this.qs.lodScale;
    for (let i = 0; i < L.length; i++) if (dist < L[i].dist * k) return i;
    return L.length - 1;
  }

  /** Shadow flags for LOD i under the current quality: only the nearest LOD casts, LOD0/LOD1 receive. */
  shadowFlags(i) {
    const on = this.qs.shadows && this.def.shadows !== false;
    return { cast: on && i === 0, receive: on && i < 2 };
  }

  applyQuality() {
    this.lods.forEach((o, i) => { if (o) { const f = this.shadowFlags(i); applyShadows(o, f.cast, f.receive); } });
  }

  load(i) {
    if (this.lods[i] || this.pending[i]) return this.pending[i] || Promise.resolve(this.lods[i]);
    if (this.retryAt[i] > performance.now()) return Promise.resolve(null);
    const url = this.def.lods[i].url;
    this.pending[i] = this.ctx.loader.loadGLTF(url).then((gltf) => {
      let obj = gltf.scene;
      if (obj.parent) obj = obj.clone();
      const f = this.shadowFlags(i);
      prepareMaterials(obj, this.sink, { shadows: f.receive, cast: f.cast });
      if (this.inst) obj = this.instantiate(obj);
      if (this.def.anchored) this.applyAnchors(obj);
      obj.visible = false;
      this.group.add(obj);
      obj.updateMatrixWorld(true);
      this.lods[i] = obj;
      return obj;
    }).catch((e) => {
      if (isNetworkError(e)) {   // connection lost: coarser/other LODs stay on screen, this one is requested again later
        this.pending[i] = null;
        this.retryAt[i] = performance.now() + retryDelay(++this.fails);
        reportLoadFailure('landmarks', url, e);
        return null;
      }
      console.error(`[landmarks] ${url}`, e);   // missing / broken model: not retried
      this.failed = true;
    });
    return this.pending[i];
  }

  // many copies of the same model (cranes, ...): one InstancedMesh per mesh
  instantiate(obj) {
    const holder = new THREE.Group();
    holder.userData.instanced = true;
    obj.updateMatrixWorld(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, this.inst.length);
      im.castShadow = o.castShadow; im.receiveShadow = o.receiveShadow;
      im.userData.base = o.matrixWorld.clone();
      holder.add(im);
    });
    this.writeInstances(holder);
    return holder;
  }

  update(camPos) {
    const d = this.distanceTo(camPos);
    const want = this.wantedLod(d);
    // prefetch the next finer LOD a bit early
    const pre = this.wantedLod(Math.max(0, d - 800));
    if (!this.lods[want]) this.load(want);
    if (pre !== want && !this.lods[pre]) this.load(pre);
    // show the wanted LOD if loaded, else the nearest loaded one (prefer coarser → finer)
    let show = -1;
    if (this.lods[want]) show = want;
    else {
      for (let k = want + 1; k < this.lods.length && show < 0; k++) if (this.lods[k]) show = k;
      for (let k = want - 1; k >= 0 && show < 0; k--) if (this.lods[k]) show = k;
    }
    if (show !== this.shown) {
      this.lods.forEach((o, k) => { if (o) o.visible = k === show; });
      this.shown = show;
    }
  }
}

export async function createLandmarks(ctx) {
  const root = new THREE.Group();
  root.name = 'landmarks';
  const empty = { object: root, update() {}, heightAt: () => -Infinity, spanAt: (x, z, out = {}) => Object.assign(out, { bottom: -Infinity, top: -Infinity }), hitTest: () => null, ready: Promise.resolve() };
  let index;
  try {
    index = await ctx.loader.loadJSON(`${BASE}index.json`);
  } catch (e) {
    if (isNetworkError(e)) throw e;   // connection lost, not a missing build
    console.warn('[landmarks] no index.json yet', e);
    return empty;
  }
  const sink = { warn: [], lamp: [] };
  // graphics quality (CONTRACTS-SF.md §8): LOD distance scale + shadow policy, shared by every landmark
  const qs = { lodScale: 1, shadows: true, traffic: 1 };
  const readQuality = (q) => {
    if (!q) return;
    if (Number.isFinite(q.landmarkLodScale)) qs.lodScale = q.landmarkLodScale;
    if (typeof q.shadows === 'boolean') qs.shadows = q.shadows;
    qs.traffic = q.id === 'low' ? 0.35 : q.id === 'medium' ? 0.7 : 1;
  };
  readQuality(ctx.quality);
  const items = index.landmarks.map((def) => new Landmark(def, ctx, root, sink, qs));
  const groundAt = (x, z) => (ctx.terrain ? ctx.terrain.getHeight(x, z) : 0);
  let collision = createCollision(groundAt);
  const glow = createGlow(8192);
  root.add(glow.points);

  // world-space collision primitives and lights (rebuilt when the terrain placement changes)
  function buildWorldData() {
    collision = createCollision(groundAt);
    glow.clear();
    const q = new THREE.Vector3();
    for (const it of items) {
      const { def, group } = it;
      const yawW = -def.heading;
      const copies = it.inst ? it.inst : [[0, 0, 0, 0, 1]];
      for (const inst of copies) {
        const tm = new THREE.Matrix4().compose(new THREE.Vector3(inst[0], inst[1] || 0, inst[2]),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), inst[3] || 0), new THREE.Vector3().setScalar(inst[4] || 1));
        const world = group.matrixWorld.clone().multiply(tm);
        const yawI = yawW + (inst[3] || 0);
        const sc = inst[4] || 1;
        if (!it.anchorCache) it.anchorCache = new Map();
        const dy = (p) => (p.ga ? anchorShift(ctx, group, p.ga[0], p.ga[1], p.ga[2], it.anchorCache) : 0);
        for (const p of def.collision || []) {
          const nm = p.n || def.name;
          if (p.t === 'box') {
            q.set(p.c[0], p.c[1] + dy(p), p.c[2]).applyMatrix4(world);
            collision.addBox(q.x, q.y, q.z, p.h[0] * sc, p.h[1] * sc, p.h[2] * sc, yawI + (p.yaw || 0), nm);
          } else if (p.t === 'cap') {
            const s = dy(p);
            const a = new THREE.Vector3(p.a[0], p.a[1] + s, p.a[2]).applyMatrix4(world);
            const b = new THREE.Vector3(p.b[0], p.b[1] + s, p.b[2]).applyMatrix4(world);
            collision.addCapsule(a.x, a.y, a.z, b.x, b.y, b.z, p.r * sc, nm, !!p.g);
          }
        }
        for (const L of def.lights || []) {
          q.set(L.p[0], L.p[1] + dy(L), L.p[2]).applyMatrix4(world);
          glow.add(q, L.c, L.s, L.per, L.duty, L.ph, L.i ?? 1, L.k || 'warn');
        }
      }
    }
  }
  buildWorldData();
  // the terrain may still be streaming: re-place terrain-based landmarks once it is ready
  if (ctx.terrain && ctx.terrain.ready && typeof ctx.terrain.ready.then === 'function') {
    ctx.terrain.ready.then(() => {
      if (!items.some((it) => it.def.base === 'terrain')) return;
      for (const it of items) if (it.def.base === 'terrain') it.place();
      buildWorldData();
    }).catch(() => {});
  }

  // moving traffic on the bridges (loaded in the background; never blocks the layer)
  let traffic = null;
  createTraffic(ctx, items, (obj) => prepareMaterials(obj, sink, { shadows: false }))
    .then((tr) => { if (tr) { traffic = tr; tr.setDensity(qs.traffic); root.add(tr.object); } })
    .catch((e) => console.warn('[landmarks] traffic', e));

  // initial loads: coarsest LOD everywhere, the LOD needed at the focus point for nearby landmarks
  const focus = new THREE.Vector3(ctx.focus?.x ?? 0, 300, ctx.focus?.z ?? 0);
  const initial = [];
  for (const it of items) {
    const last = it.def.lods.length - 1;
    initial.push(it.load(last));
    const w = it.wantedLod(it.distanceTo(focus));
    if (w !== last) initial.push(it.load(w));
  }
  const ready = Promise.all(initial).then(() => { for (const it of items) it.update(focus); });

  // day/night from the scene's sun (directional light elevation)
  let sunLight = null;
  let night = 0;
  let t = 0;
  const camPos = new THREE.Vector3();
  function findSun() {
    let best = null;
    ctx.scene.traverse((o) => { if (o.isDirectionalLight && (!best || o.intensity > best.intensity)) best = o; });
    return best;
  }

  return {
    object: root,
    ready,
    update(dt, camera) {
      t += dt;
      camera.getWorldPosition(camPos);
      for (const it of items) it.update(camPos);
      if (traffic) traffic.update(dt, camPos);
      if (!sunLight || !sunLight.parent) sunLight = findSun();
      if (sunLight) {
        _v.copy(sunLight.position);
        if (sunLight.target) _v.sub(sunLight.target.position);
        const el = _v.normalize().y;
        night = THREE.MathUtils.clamp((0.12 - el) / 0.2, 0, 1);
      }
      for (const m of sink.lamp) m.emissiveIntensity = m.userData.baseEmissive * (0.02 + night);
      const blinkOn = ((t / 1.5) % 1) < 0.5;
      for (const m of sink.warn) m.emissiveIntensity = m.userData.baseEmissive * (blinkOn ? 1 : 0.05);
      glow.update(t, camera, ctx.renderer, night);
      const hpx = ctx.renderer ? ctx.renderer.domElement.height : 900;
      ROPE.uLmPixel.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, hpx);
    },
    heightAt: (x, z) => collision.heightAt(x, z),
    // { bottom, top } of the obstacles at (x, z); bottom is the deck/cable underside for bridges, -Infinity for grounded
    // obstacles (see createCollision). Pass `out` to avoid allocating.
    spanAt: (x, z, out) => collision.spanAt(x, z, out),
    hitTest: (x, y, z, r) => collision.hitTest(x, y, z, r),
    replace() { for (const it of items) it.place(); buildWorldData(); },
    /** Live quality change (CONTRACTS-SF.md §8): q.landmarkLodScale scales the LOD switch distances, q.shadows
     * (false = no landmark shadows; otherwise only the nearest LOD casts), traffic density 35 % / 70 % / 100 %. */
    setQuality(q) {
      readQuality(q);
      for (const it of items) { it.applyQuality(); it.shown = -2; }    // force the LOD re-selection on next update
      if (traffic) traffic.setDensity(qs.traffic);
    },
    // debug / tooling
    items, get collision() { return collision; },
  };
}
