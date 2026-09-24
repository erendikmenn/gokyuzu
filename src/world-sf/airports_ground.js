// W4 airports: draped pavement surfaces (runway, blast pad, shoulder, taxiway, apron) and paint markings.
// Geometry comes from tools/geo/airports_build.py (<icao>.bin, x/z relative to the airport origin); heights are sampled
// from ctx.terrain.getHeight per vertex. Log-depth aware depth bias keeps the layers ordered without z-fighting.
import * as THREE from 'three';
import { assetBitmap, isNetworkError, reportLoadFailure, retryDelay } from '../core/assets.js';

/** The active map's airport files (createAirports sets them): base = <assets>/airports/, tex = ground textures, props = props GLB. */
export const airportFiles = { base: 'assets/sf/airports/', tex: 'assets/sf/airports/tex/', props: 'assets/sf/airports/props.glb' };

// ---------------------------------------------------------------- shared helpers
export function readArrays(meta, buf) {
  const T = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array, i16: Int16Array };
  const out = {};
  for (const [k, [off, n, t]] of Object.entries(meta.arrays)) out[k] = new T[t](buf, off, n);
  return out;
}

/** Patch a built-in material so its fragments are pulled toward the camera by a relative amount (log depth) or
 *  polygonOffset (linear depth). layer: 1 = lowest (shoulder) … 5 = paint. */
export function depthBias(mat, layer, onCompile) {
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1 * layer;
  mat.polygonOffsetUnits = -4 * layer;
  const scale = 1 - 6e-5 * layer;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>', `
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( max( 1.0, vFragDepth * ${scale.toFixed(7)} - ${(0.04 * layer).toFixed(3)} ) ) * logDepthBufFC * 0.5;
#endif`);
    if (onCompile) onCompile(shader);
  };
  mat.customProgramCacheKey = () => `apt-bias-${layer}-${mat.name}`;
  return mat;
}

let texCache = null;
let texOpts = null;
/** Fill `t` with the image at url (versioned, retried); after a lost connection it tries again later. Until then the
 *  texture has no image (three.js skips the upload), like a THREE.TextureLoader texture that is still loading.
 *  Decoded off the main thread (an <img> is decoded synchronously at upload: 2048² JPEGs, ~20-40 ms each, 4x that on
 *  a phone) and cut to the device class's size (groundTextures). */
function loadInto(t, url, fails = 0) {
  assetBitmap(url, { maxSize: texOpts.maxSize }).then(({ image, flipY, from }) => {
    t.image = image; t.flipY = flipY;
    if (from[0] !== image.width) t.userData.downscaledFrom = from;
    t.needsUpdate = true;
  }).catch((e) => {
    reportLoadFailure('airports', url, e);
    if (isNetworkError(e)) setTimeout(() => loadInto(t, url, fails + 1), retryDelay(fails + 1));
  });
}
/** Ground textures, each loaded on first use (an airport only downloads what its pavements use). */
export function groundTextures(loader, renderer, quality = null, ctx = null) {
  if (texCache) return texCache;
  // phones and tablets: 1024² (5.3 instead of 21 MB each, 8 mm per texel on an 8 m asphalt tile); other classes the
  // files' 2048² unless their texture cap is lower (software rendering)
  const cls = quality && quality.deviceClass, cap = quality && quality.textureMaxSize;
  const max = cls === 'phone' || cls === 'tablet' ? 1024 : cap && cap < 2048 ? cap : 0;
  texOpts = { aniso: renderer ? renderer.capabilities.getMaxAnisotropy() : 8, maxSize: max };
  // phones / tablets download the 1024² copies of packs.json (tools/assets/packs.mjs) where the originals are larger
  const gm = max === 1024 && ctx && ctx.assets && ctx.packs && ctx.packs.airports && ctx.packs.airports.groundMobile;
  const fromPack = new Set(gm ? gm.files : []);
  const urlOf = (name) => (fromPack.has(name) ? ctx.assets + gm.dir + name : airportFiles.tex + name);
  const FILES = {
    asphaltRwy: ['asphalt_rwy.jpg', true], asphaltTwy: ['asphalt_twy.jpg', true], shoulder: ['shoulder.jpg', true],
    concrete: ['concrete.jpg', true], concreteRwy: ['concrete_rwy.jpg', true],
    macro: ['macro.jpg', false], rubber: ['rubber.jpg', false], paint: ['paintwear.jpg', false], detailN: ['detail_n.jpg', false],
  };
  texCache = {};
  for (const [key, [name, srgb]] of Object.entries(FILES)) {
    let t = null;
    Object.defineProperty(texCache, key, {
      enumerable: true,
      get() {
        if (!t) {
          t = new THREE.Texture();
          loadInto(t, urlOf(name));
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = texOpts.aniso;
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        }
        return t;
      },
    });
  }
  return texCache;
}

// GLSL shared by the pavement + paint shaders: rubber deposits in the touchdown zones, macro variation.
const RUBBER_GLSL = /* glsl */`
uniform sampler2D tMacro; uniform sampler2D tRubber; uniform float uMacroScale; uniform float uRubber;
varying vec4 vRw; varying vec2 vWxz;
float rubberAmount(vec4 rw) {
  if (rw.z < -1000.0 && rw.w < -1000.0) return 0.0;
  float at = abs(rw.x);
  float lat = 1.0 - smoothstep(4.0, 12.5, abs(at - 3.5) + 0.0 * at);
  lat = max(lat, 0.55 * (1.0 - smoothstep(0.0, 2.2, abs(at - 6.2))));
  float a = smoothstep(60.0, 260.0, rw.z) * (1.0 - smoothstep(550.0, 1250.0, rw.z));
  float b = smoothstep(60.0, 260.0, rw.w) * (1.0 - smoothstep(550.0, 1250.0, rw.w));
  float tail = 0.18 * (1.0 - smoothstep(1200.0, 2200.0, min(max(rw.z, 0.0), max(rw.w, 0.0))));
  float env = max(max(a, b), tail) * lat;
  float streak = texture2D(tRubber, vec2(rw.x / 16.0, rw.y / 128.0)).r;
  return clamp(env * (0.35 + 0.9 * streak), 0.0, 1.0) * uRubber;
}`;

function pavementMaterial({ name, map, tile, layer, rough, rubber = false, tint = 0xffffff, detailN, macroScale = 1 / 512 }) {
  const mat = new THREE.MeshStandardMaterial({ name, map, color: tint, roughness: rough, metalness: 0 });
  if (detailN) { mat.normalMap = detailN; mat.normalScale = new THREE.Vector2(0.12, 0.12); }
  const t = groundTextures();
  const uniforms = { tMacro: { value: t.macro }, tRubber: { value: t.rubber }, uMacroScale: { value: macroScale }, uRubber: { value: rubber ? 1 : 0 } };
  depthBias(mat, layer, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aRw; varying vec4 vRw; varying vec2 vWxz;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n vRw = aRw; vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RUBBER_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  float mac = texture2D(tMacro, vWxz * uMacroScale).r * 2.0 - 1.0;
  float mac2 = texture2D(tMacro, vWxz * uMacroScale * 7.3 + 0.37).r * 2.0 - 1.0;
  diffuseColor.rgb *= 1.0 + 0.30 * mac + 0.12 * mac2;
  float rub = ${rubber ? 'rubberAmount(vRw)' : '0.0'};
  ${rubber ? `// paving lanes (7.6 m wide, parallel to the runway): per-lane tone + thin joints; oily centre band
  float lane = floor((vRw.x + 60.0) / 7.62);
  float lh = fract(sin(lane * 12.9898 + floor(vRw.y / 400.0) * 3.1) * 43758.5453);
  diffuseColor.rgb *= 0.965 + 0.07 * lh;
  float lj = abs(fract((vRw.x + 60.0) / 7.62) - 0.5) * 7.62;
  diffuseColor.rgb *= 1.0 - 0.10 * (1.0 - smoothstep(3.70, 3.79, lj));
  float oil = (1.0 - smoothstep(0.6, 2.2, abs(vRw.x))) * (0.5 + 0.5 * texture2D(tRubber, vec2(vRw.x / 5.0, vRw.y / 60.0)).r);
  diffuseColor.rgb *= 1.0 - 0.12 * oil;` : ''}
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.018, 0.02), rub * 0.85);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.62, rub * 0.8);`);
  });
  mat.userData.tile = tile;
  return mat;
}

function paintMaterial(layer) {
  const t = groundTextures();
  const mat = new THREE.MeshStandardMaterial({ name: 'apt-paint', vertexColors: true, roughness: 0.58, metalness: 0 });
  const uniforms = { tMacro: { value: t.macro }, tRubber: { value: t.rubber }, uMacroScale: { value: 1 / 512 }, uRubber: { value: 1 }, tPaint: { value: t.paint } };
  depthBias(mat, layer, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aRw; varying vec4 vRw; varying vec2 vWxz;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n vRw = aRw; vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RUBBER_GLSL}\nuniform sampler2D tPaint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  float wear = texture2D(tPaint, vWxz / 4.0).r;
  float wear2 = texture2D(tMacro, vWxz / 60.0).r;
  float cover = clamp(wear * (0.75 + 0.5 * wear2), 0.0, 1.0);
  diffuseColor.rgb = mix(vec3(0.075, 0.075, 0.078), diffuseColor.rgb, 0.35 + 0.65 * cover);
  float rub = rubberAmount(vRw);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), rub * 0.8);`);
  });
  return mat;
}

// marking colour classes (see airports_lib.py): white, yellow, black, red, rubber, orange, green
const PAINT = [[0.74, 0.74, 0.72], [0.92, 0.55, 0.035], [0.012, 0.012, 0.012], [0.50, 0.018, 0.02], [0.03, 0.03, 0.03], [0.9, 0.25, 0.02], [0.03, 0.35, 0.08]];

const LAYERS = {
  shoulder: { layer: 1, off: 0.03 }, apron: { layer: 2, off: 0.05 }, taxiway: { layer: 2, off: 0.05 }, pad: { layer: 3, off: 0.06 },
  blast: { layer: 3, off: 0.06 }, runway: { layer: 4, off: 0.07 }, marks: { layer: 5, off: 0.09 },
};

/** Build all ground meshes of one airport. Returns { group, meshes } (group positioned at the airport origin). */
export function buildGround(meta, A, ctx, opts = {}) {
  const { terrain } = ctx;
  const [ox, oz] = meta.origin;
  const tex = groundTextures(ctx.loader, ctx.renderer, ctx.quality, ctx);
  const group = new THREE.Group();
  group.name = `apt-ground-${meta.icao}`;
  group.position.set(ox, 0, oz);
  const mil = meta.military;
  const gridRot = opts.gridRot || 0;
  const cr = Math.cos(gridRot), sr = Math.sin(gridRot);
  const MAT = {
    shoulder: () => pavementMaterial({ name: 'apt-shoulder', map: tex.shoulder, tile: 8, layer: 1, rough: 0.95, tint: 0xf2efe8 }),
    apron: () => pavementMaterial({ name: 'apt-apron', map: tex.concrete, tile: 30.48, layer: 2, rough: 0.86, tint: mil ? 0xe8e8e2 : 0xffffff }),
    taxiway: () => pavementMaterial({ name: 'apt-taxiway', map: mil ? tex.concrete : tex.asphaltTwy, tile: mil ? 30.48 : 8, layer: 2, rough: 0.9 }),
    pad: () => pavementMaterial({ name: 'apt-pad', map: tex.concrete, tile: 30.48, layer: 3, rough: 0.86, tint: 0xf4f2ec }),
    blast: () => pavementMaterial({ name: 'apt-blast', map: tex.asphaltTwy, tile: 8, layer: 3, rough: 0.93, tint: 0xd8d8d8 }),
    runway: () => pavementMaterial({ name: 'apt-runway', map: mil ? tex.concreteRwy : tex.asphaltRwy, tile: mil ? 15.24 : 8, layer: 4, rough: 0.9, rubber: true, detailN: tex.detailN }),
  };
  const mats = {};
  for (const key of Object.keys(MAT)) if (A[`surf.${key}.p`]) mats[key] = MAT[key]();
  const meshes = {};
  const hBuf = new Map();
  const height = (x, z) => terrain.getHeight(x, z);
  for (const key of ['shoulder', 'apron', 'taxiway', 'pad', 'blast', 'runway']) {
    const p = A[`surf.${key}.p`];
    if (!p) continue;
    const idx = A[`surf.${key}.i`];
    const n = p.length / 2;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), rw = new Float32Array(n * 4);
    const e = A[`surf.${key}.e`];
    const tile = mats[key].userData.tile;
    const off = LAYERS[key].off;
    for (let i = 0; i < n; i++) {
      const x = p[2 * i], z = p[2 * i + 1];
      pos[3 * i] = x; pos[3 * i + 1] = height(x + ox, z + oz) + off; pos[3 * i + 2] = z;
      if (e) {
        rw.set([e[4 * i], e[4 * i + 1], e[4 * i + 2], e[4 * i + 3]], 4 * i);
        uv[2 * i] = e[4 * i] / tile; uv[2 * i + 1] = e[4 * i + 1] / tile;
      } else {
        rw.set([0, -1, -5000, -5000], 4 * i);
        const wx = x + ox, wz = z + oz;
        uv[2 * i] = (wx * cr - wz * sr) / tile; uv[2 * i + 1] = (wx * sr + wz * cr) / tile;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aRw', new THREE.BufferAttribute(rw, 4));
    g.setIndex(new THREE.BufferAttribute(idx.length > 65535 * 3 || n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[key]);
    m.name = `apt-${key}`;
    m.userData.off = off;
    m.receiveShadow = true;
    m.renderOrder = -10 + LAYERS[key].layer;
    if (key === 'runway') mats[key].normalMap.repeat.set(tile / 2, tile / 2);
    group.add(m);
    meshes[key] = m;
  }
  // ---- markings
  if (A['marks.p']) {
    const p = A['marks.p'], idx = A['marks.i'], c = A['marks.c'];
    let e = A['marks.e'];
    if (!e && A['marks.e16']) {         // int16-quantised runway coords (see airports_build.py export)
      const q = A['marks.e16'], k = meta.e16Scale || [0.01, 0.125, 0.2, 0.2];
      e = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) e[i] = q[i] * k[i & 3];
    }
    const n = p.length / 2;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), rw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = p[2 * i], z = p[2 * i + 1];
      pos[3 * i] = x; pos[3 * i + 1] = height(x + ox, z + oz) + LAYERS.marks.off; pos[3 * i + 2] = z;
      const pc = PAINT[c[i]] || PAINT[0];
      col[3 * i] = pc[0]; col[3 * i + 1] = pc[1]; col[3 * i + 2] = pc[2];
      rw[4 * i] = e[4 * i]; rw[4 * i + 1] = e[4 * i + 1]; rw[4 * i + 2] = e[4 * i + 2]; rw[4 * i + 3] = e[4 * i + 3];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRw', new THREE.BufferAttribute(rw, 4));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, paintMaterial(LAYERS.marks.layer));
    m.name = 'apt-marks';
    m.userData.off = LAYERS.marks.off;
    m.receiveShadow = true;
    m.renderOrder = -4;
    group.add(m);
    meshes.marks = m;
  }
  return { group, meshes };
}

// ---------------------------------------------------------------- approach light structures, fixtures, PAPI boxes
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export function buildStructures(meta, A, ctx) {
  const { terrain } = ctx;
  const [ox, oz] = meta.origin;
  const group = new THREE.Group();
  group.name = `apt-structures-${meta.icao}`;
  group.position.set(ox, 0, oz);
  const ground = (x, z) => (terrain.isWater && terrain.isWater(x + ox, z + oz) ? 0 : terrain.getHeight(x + ox, z + oz));
  // --- ALS: poles, crossbars, catwalk + piles
  const poles = [], bars = [], decks = [];
  for (const als of meta.als || []) {
    for (const st of als.stations) {
      if (st.pave) continue;
      const g = ground(st.x, st.z);
      const top = st.y - 0.12;
      if (top - g > 0.2) poles.push([st.x, g - 1, st.z, top - g + 1]);
      const h = st.h * Math.PI / 180;
      bars.push([st.x, top, st.z, st.w, h]);
    }
    const [ax, az, bx, bz] = als.walk;
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(L / 15));
    const hdg = Math.atan2(bx - ax, -(bz - az));
    for (let k = 0; k < n; k++) {
      const x = ax + (bx - ax) * (k + 0.5) / n, z = az + (bz - az) * (k + 0.5) / n;
      const g = ground(x, z);
      if (als.y - g < 0.6) continue;
      decks.push([x, als.y, z, L / n, hdg]);
      poles.push([x, g - 1, z, als.y - g + 1]);
    }
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.55, metalness: 0.6 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xc8551e, roughness: 0.6, metalness: 0.3 });
  if (poles.length) {
    const geo = new THREE.CylinderGeometry(0.09, 0.12, 1, 6).translate(0, 0.5, 0);
    const im = new THREE.InstancedMesh(geo, steel, poles.length);
    poles.forEach(([x, y, z, h], i) => { im.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q.identity(), _s.set(1, h, 1))); });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  if (bars.length) {
    const geo = new THREE.BoxGeometry(1, 0.14, 0.14);
    const im = new THREE.InstancedMesh(geo, orange, bars.length);
    bars.forEach(([x, y, z, w, h], i) => { _q.setFromAxisAngle(UP, -h); im.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(w, 1, 1))); });
    im.castShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  if (decks.length) {
    const geo = new THREE.BoxGeometry(1.2, 0.25, 1);
    const im = new THREE.InstancedMesh(geo, steel, decks.length);
    decks.forEach(([x, y, z, len, h], i) => { _q.setFromAxisAngle(UP, -h); im.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, len))); });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  // --- light fixtures: 0 runway edge (elevated), 1 taxiway edge (blue globe), 2 runway guard light housing
  const F = A.fixtures;
  if (F) {
    const kinds = [[], [], []];
    for (let i = 0; i < F.length; i += 3) kinds[F[i + 2]].push([F[i], F[i + 1]]);
    const specs = [
      [new THREE.CylinderGeometry(0.07, 0.09, 0.36, 6).translate(0, 0.18, 0), new THREE.MeshStandardMaterial({ color: 0xd8c23a, roughness: 0.5 })],
      [new THREE.CylinderGeometry(0.05, 0.07, 0.36, 6).translate(0, 0.18, 0), new THREE.MeshStandardMaterial({ color: 0x2a4fb8, roughness: 0.4 })],
      [new THREE.BoxGeometry(0.9, 0.45, 0.35).translate(0, 0.6, 0), new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.5 })],
    ];
    kinds.forEach((list, k) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(specs[k][0], specs[k][1], list.length);
      list.forEach(([x, z], i) => im.setMatrixAt(i, _m.makeTranslation(x, terrain.getHeight(x + ox, z + oz) + 0.05, z)));
      im.computeBoundingSphere();
      im.userData.lodDist = k === 2 ? 2500 : 1500;
      im.userData.drapeDy = 0.05;
      group.add(im);
    });
  }
  // --- PAPI boxes
  if (meta.papi && meta.papi.length) {
    const geo = new THREE.BoxGeometry(1.4, 0.7, 0.9).translate(0, 0.75, 0);
    const legs = new THREE.MeshStandardMaterial({ color: 0x6a6c6e, roughness: 0.6, metalness: 0.3 });
    const im = new THREE.InstancedMesh(geo, legs, meta.papi.length);
    meta.papi.forEach(([x, z, h], i) => {
      _q.setFromAxisAngle(UP, -h * Math.PI / 180);
      im.setMatrixAt(i, _m.compose(_p.set(x, terrain.getHeight(x + ox, z + oz), z), _q, _s.set(1, 1, 1)));
    });
    im.castShadow = true;
    im.computeBoundingSphere();
    im.userData.drapeDy = 0;
    group.add(im);
  }
  return group;
}
