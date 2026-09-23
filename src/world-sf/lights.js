// Time & weather: night lights of the Bay Area (the SF night view).
//   - ground light map (assets/sf/lights/night_*.png, tools/geo/lights_build.py): street-light pools + road glow +
//     diffuse building light from OpenStreetMap, emissive in the terrain shader (every distance, one texture fetch);
//     its blurred mips also light fog and clouds from below (orange glow over the city)
//   - street lamps (assets/sf/lights/lamps.bin, 235k lamps in 1 km tiles): instanced camera-facing glow sprites,
//     gathered around the camera (radius by quality), one draw call; LED white / warm LED / sodium / metal halide
//   - reflections: lamps near the water get a mirrored, vertically stretched, shimmering streak on the water surface
//     (second instanced draw; land in front hides it through the depth test)
// Everything streams only once it gets dark (SKY_STATE.lights > 0) and costs nothing in daylight.
import * as THREE from 'three';
import { assetData } from '../core/assets.js';
import { SKY_STATE } from './environment.js';

const BASE = new URL('../../assets/sf/lights/', import.meta.url).href;
// lamp colours (linear): LED 4000 K, LED 3000 K, high-pressure sodium, metal halide
const LAMP_COL = [[1.0, 0.9, 0.78], [1.0, 0.76, 0.5], [1.0, 0.5, 0.14], [0.82, 0.9, 1.0]];

/**
 * Water reflection streak of a light at world position P: a quad lying ON the water plane (so the water surface does
 * not hide it and land in front does), starting at the mirror reflection point and running toward the camera, with a
 * constant on-screen width. corner.y = +1 at the reflection point … -1 at the near end. Needs <common> (cameraPosition).
 */
export const WATER_STREAK_GLSL = /* glsl */`
vec3 sfWaterStreakAt(vec3 P, vec2 corner, float sizeM, float pxScale, float minPx, float planeY, out float dist, out float graze, out float natural) {
  float hc = max(cameraPosition.y - planeY, 0.5);
  float t = hc / (hc + max(P.y - planeY, 0.3));
  vec3 R = cameraPosition + (vec3(P.x, 2.0 * planeY - P.y, P.z) - cameraPosition) * t;
  R.y = planeY + 0.2;
  vec3 toC = cameraPosition - R;
  dist = max(length(toC), 1.0);
  graze = clamp((toC.y) / dist, 0.02, 1.0);
  natural = sizeM * pxScale / dist;
  float px = clamp(natural, minPx, minPx * 9.0);
  float pxL = px * (6.0 + 18.0 * (1.0 - graze));
  vec2 hv = toC.xz;
  float hl = max(length(hv), 1e-3);
  vec2 al = hv / hl, sd = vec2(-al.y, al.x);
  float Lw = min(pxL * dist / (pxScale * graze), hl * 0.5);
  float s = (0.5 - 0.5 * corner.y) * Lw * 1.06 - 0.06 * Lw;
  float W = max(px * 0.8, minPx * 1.9) * (dist - s) / pxScale;   // >= ~2.5 px so thin streaks still rasterize
  return R + vec3(al.x, 0.0, al.y) * s + vec3(sd.x, 0.0, sd.y) * corner.x * W * 0.5;
}
vec3 sfWaterStreak(vec3 P, vec2 corner, float sizeM, float pxScale, float minPx, out float dist, out float graze, out float natural) {
  return sfWaterStreakAt(P, corner, sizeM, pxScale, minPx, 0.0, dist, graze, natural);
}
`;

/**
 * Fragment part of a reflection streak: broken, shimmering glitter (wave facets catch the light in patches that drift
 * with time), per-light length, a slight sideways wobble; mostly dark with bright sparkles (the energy of one light is
 * spread over the whole path). Inputs: vQ (quad corner), vSeed, uTime; output: float c.
 */
export const STREAK_FS = /* glsl */`
  float along = vQ.y;
  float a = 0.5 - 0.5 * along;              // 0 at the reflection point … 1 at the near end
  float len = 0.5 + 0.9 * fract(vSeed * 7.31);
  if (a > len) discard;
  float an = a / len;
  float tt = uTime * (1.4 + vSeed * 1.8);
  float xw = vQ.x + 0.3 * sin(an * 17.0 + tt * 1.7 + vSeed * 9.0);
  float r2 = xw * xw;
  if (r2 > 1.0) discard;
  float w1 = 0.5 + 0.5 * sin(an * 31.0 + tt * 2.1 + vSeed * 40.0);
  float w2 = 0.5 + 0.5 * sin(an * 11.0 - tt * 1.3 + vSeed * 13.0);
  float sparkle = w1 * w2; sparkle *= sparkle * sparkle;
  float c = exp(-r2 * 4.0) * smoothstep(0.0, 0.05, an) * exp(-an * 2.2) * (0.1 + 1.7 * sparkle);
`;

// Shared light-sprite vertex/fragment code. SF_MIRROR: reflection streak on the water (WATER_STREAK_GLSL).
export const SPRITE_VS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iCol;      // rgb (intensity included), glow size (m)
uniform float uGain, uPxScale, uMinPx, uExt, uFar, uTime;
uniform vec2 uViewport;
varying vec3 vCol; varying vec2 vQ; varying float vSeed;
${WATER_STREAK_GLSL}
void main() {
  vec3 wp = iPos;
  float dist0 = max(length(cameraPosition - wp), 0.1);
  float I = uGain;
  vSeed = fract(iPos.x * 0.137 + iPos.z * 0.311);
  vQ = position.xy;
#ifdef SF_MIRROR
  float dist, graze, natural;
  vec3 sp = sfWaterStreak(wp, position.xy, iCol.w, uPxScale, uMinPx, dist, graze, natural);
  I *= 0.03 + 0.4 * (0.02 + 0.98 * pow(1.0 - graze, 5.0));
  I *= mix(0.3, 1.0, clamp(natural / uMinPx, 0.0, 1.0));
  I *= exp(-uExt * dist) * (1.0 - smoothstep(uFar * 0.72, uFar, dist0));
  vCol = iCol.rgb * I;
  gl_Position = projectionMatrix * viewMatrix * vec4(sp, 1.0);
#else
  vec3 toCam = cameraPosition - wp;
  float dist = max(length(toCam), 0.1);
  vec4 mv = viewMatrix * vec4(wp + normalize(toCam) * min(iCol.w * 1.5, dist * 0.3), 1.0);
  float natural = iCol.w * uPxScale / dist;
  float px = clamp(natural, uMinPx, uMinPx * 9.0);
  I *= mix(0.3, 1.0, clamp(natural / uMinPx, 0.0, 1.0));
  I *= exp(-uExt * dist) * (1.0 - smoothstep(uFar * 0.72, uFar, dist0));
  vCol = iCol.rgb * I;
  vec2 corner = position.xy;
  if (corner.y < 0.0) corner.y *= 0.5;
  gl_Position = projectionMatrix * mv;
  gl_Position.xy += corner * px / uViewport * 2.0 * gl_Position.w;
#endif
  if (I < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
}`;
export const SPRITE_FS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
varying vec3 vCol; varying vec2 vQ; varying float vSeed;
void main() {
  #include <logdepthbuf_fragment>
#ifdef SF_MIRROR
  ${STREAK_FS}
  vec3 col = vCol * c;
#else
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  vec3 col = vCol * (exp(-r2 * 16.0) * 2.0 + exp(-r2 * 4.0) * 0.18);
#endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSpriteMaterial(mirror) {
  return new THREE.ShaderMaterial({
    name: mirror ? 'sf-lamps-mirror' : 'sf-lamps',
    defines: mirror ? { SF_MIRROR: 1 } : {},
    uniforms: {
      uGain: { value: 0 }, uPxScale: { value: 800 }, uMinPx: { value: 1.5 }, uExt: { value: 5e-5 }, uFar: { value: 3000 },
      uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1440, 900) },
    },
    vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    side: mirror ? THREE.DoubleSide : THREE.FrontSide,   // the streak quad lies flat on the water
  });
}

function createSpriteMesh(max, mirror) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iCol', iCol);
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, createSpriteMaterial(mirror));
  mesh.name = mirror ? 'night-lamps-mirror' : 'night-lamps';
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;    // before the fog bank top (10) so fog hides the lamps below it
  mesh.visible = false;
  return { mesh, geo, iPos, iCol, max };
}

/** Per-frame sprite uniforms (pixel scale, viewport, extinction). */
const _v2 = new THREE.Vector2();
export function updateSpriteUniforms(mat, camera, renderer, gain, far, time) {
  const u = mat.uniforms;
  renderer.getDrawingBufferSize(_v2);
  u.uPxScale.value = _v2.y * (camera.zoom || 1) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  u.uMinPx.value = 1.35 * _v2.y / 900;
  u.uViewport.value.copy(_v2);
  u.uExt.value = SKY_STATE.extinction * 0.6;   // lights carry farther than the visibility of unlit objects (Allard)
  u.uGain.value = gain;
  u.uFar.value = far;
  u.uTime.value = time;
}

const MIRROR_RADIUS = 9000;   // m: shoreline reflections are gathered much farther than the lamps themselves
const QUAL = {
  low: { map: 2048, radius: 1700, max: 12000, mirror: false },
  medium: { map: 4096, radius: 2500, max: 22000, mirror: true },
  high: { map: 4096, radius: 3400, max: 34000, mirror: true },
  ultra: { map: 4096, radius: 4400, max: 50000, mirror: true },
};

export function createNightLights(ctx) {
  const { terrain, renderer } = ctx;
  const object = new THREE.Group();
  object.name = 'night-lights';
  let Q = QUAL[(ctx.quality && ctx.quality.id) || 'high'] || QUAL.high;
  const MAXI = QUAL.ultra.max;
  const lamps = createSpriteMesh(MAXI, false);
  const mirror = createSpriteMesh(20000, true);
  object.add(lamps.mesh, mirror.mesh);

  // ---------------- ground light map ----------------
  const nightMap = { tex: null, size: 0, loading: null, meta: null, xf: new THREE.Vector4(0, 0, -10, -10) };
  async function loadMap(size) {
    const meta = await assetData(BASE + 'night.json', 'json');
    const blob = await assetData(BASE + `night_${size}.png`, 'blob');
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close?.();
    const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const n = canvas.width * canvas.height;
    const rg = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { rg[2 * i] = px[4 * i]; rg[2 * i + 1] = px[4 * i + 1]; }
    const tex = new THREE.DataTexture(rg, canvas.width, canvas.height, THREE.RGFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    tex.onUpdate = () => { tex.image.data = null; tex.onUpdate = null; };   // free the CPU copy after upload
    const s = meta.size;
    nightMap.xf.set(1 / s, 1 / s, -meta.x0 / s, -meta.z0 / s);
    if (nightMap.tex) nightMap.tex.dispose();
    nightMap.tex = tex; nightMap.size = size; nightMap.meta = meta;
    if (terrain && terrain.shared) {
      terrain.shared.uNightMap.value = tex;
      terrain.shared.uNightXf.value.copy(nightMap.xf);
    }
    for (const cb of mapListeners) cb(tex, nightMap.xf);
  }
  const mapListeners = [];

  // ---------------- street lamps ----------------
  let L = null;   // { x, z, y, r, g, b, flags, tileStart[], n, x0, z0, tile }
  let lampsLoading = null;
  async function loadLamps() {
    const [meta, buf] = await Promise.all([assetData(BASE + 'lamps.json', 'json'), assetData(BASE + 'lamps.bin', 'arrayBuffer')]);
    const dv = new DataView(buf);
    const N = meta.count;
    const x = new Float32Array(N), z = new Float32Array(N), y = new Float32Array(N), col = new Float32Array(N * 3), flags = new Uint8Array(N);
    const start = new Int32Array(meta.n * meta.n + 1);
    let k = 0;
    for (let t = 0; t < meta.n * meta.n; t++) {
      start[t] = k;
      const ti = t % meta.n, tj = Math.floor(t / meta.n);
      const ox = meta.x0 + ti * meta.tile, oz = meta.z0 + tj * meta.tile;
      for (let c = 0; c < meta.counts[t]; c++, k++) {
        const o = k * 8;
        x[k] = ox + dv.getInt16(o, true) / 10;
        z[k] = oz + dv.getInt16(o + 2, true) / 10;
        y[k] = dv.getInt16(o + 4, true) / 10;
        const kind = dv.getUint8(o + 6), inten = dv.getUint8(o + 7) / 230;
        const cc = LAMP_COL[kind & 3];
        const e = inten * (kind & 8 ? 1.25 : 1.0) * 2.4;
        col[3 * k] = cc[0] * e; col[3 * k + 1] = cc[1] * e; col[3 * k + 2] = cc[2] * e;
        flags[k] = kind;
      }
    }
    start[meta.n * meta.n] = k;
    // near-water lamps (reflections) indexed separately: they are gathered over a much larger radius
    const wIdx = [], wStart = new Int32Array(meta.n * meta.n + 1);
    for (let t = 0; t < meta.n * meta.n; t++) {
      wStart[t] = wIdx.length;
      for (let q = start[t]; q < start[t + 1]; q++) if (flags[q] & 4) wIdx.push(q);
    }
    wStart[meta.n * meta.n] = wIdx.length;
    L = { x, z, y, col, flags, start, n: meta.n, x0: meta.x0, z0: meta.z0, tile: meta.tile, wIdx: Int32Array.from(wIdx), wStart };
  }

  const lastGather = new THREE.Vector3(1e9, 0, 1e9);
  let gatherAge = 99;
  function gather(cam) {
    if (!L) return;
    const R = Q.radius, R2 = R * R, cx = cam.x, cz = cam.z;
    const i0 = Math.max(0, Math.floor((cx - R - L.x0) / L.tile)), i1 = Math.min(L.n - 1, Math.floor((cx + R - L.x0) / L.tile));
    const j0 = Math.max(0, Math.floor((cz - R - L.z0) / L.tile)), j1 = Math.min(L.n - 1, Math.floor((cz + R - L.z0) / L.tile));
    const P = lamps.iPos.array, C = lamps.iCol.array, MP = mirror.iPos.array, MC = mirror.iCol.array;
    const max = Q.max, mmax = mirror.max;
    const useMirror = Q.mirror;
    let n = 0, m = 0;
    for (let j = j0; j <= j1 && n < max; j++) {
      for (let i = i0; i <= i1 && n < max; i++) {
        const t = j * L.n + i;
        for (let k = L.start[t], e = L.start[t + 1]; k < e; k++) {
          const dx = L.x[k] - cx, dz = L.z[k] - cz;
          if (dx * dx + dz * dz > R2) continue;
          P[3 * n] = L.x[k]; P[3 * n + 1] = L.y[k]; P[3 * n + 2] = L.z[k];
          C[4 * n] = L.col[3 * k]; C[4 * n + 1] = L.col[3 * k + 1]; C[4 * n + 2] = L.col[3 * k + 2];
          C[4 * n + 3] = L.flags[k] & 8 ? 2.6 : 1.9;
          n++;
          if (n >= max) break;
        }
      }
    }
    // reflections: the lit shorelines across the bay shimmer on the water from far away (only near-water lamps)
    if (useMirror) {
      const RM = MIRROR_RADIUS, RM2 = RM * RM;
      const a0 = Math.max(0, Math.floor((cx - RM - L.x0) / L.tile)), a1 = Math.min(L.n - 1, Math.floor((cx + RM - L.x0) / L.tile));
      const b0 = Math.max(0, Math.floor((cz - RM - L.z0) / L.tile)), b1 = Math.min(L.n - 1, Math.floor((cz + RM - L.z0) / L.tile));
      for (let j = b0; j <= b1 && m < mmax; j++) {
        for (let i = a0; i <= a1 && m < mmax; i++) {
          const t = j * L.n + i;
          for (let w = L.wStart[t], e = L.wStart[t + 1]; w < e && m < mmax; w++) {
            const k = L.wIdx[w];
            const dx = L.x[k] - cx, dz = L.z[k] - cz;
            if (dx * dx + dz * dz > RM2) continue;
            MP[3 * m] = L.x[k]; MP[3 * m + 1] = L.y[k]; MP[3 * m + 2] = L.z[k];
            MC[4 * m] = L.col[3 * k]; MC[4 * m + 1] = L.col[3 * k + 1]; MC[4 * m + 2] = L.col[3 * k + 2]; MC[4 * m + 3] = 1.9;
            m++;
          }
        }
      }
    }
    for (const [s, cnt] of [[lamps, n], [mirror, m]]) {
      s.geo.instanceCount = cnt;
      s.iPos.clearUpdateRanges(); s.iPos.addUpdateRange(0, cnt * 3); s.iPos.needsUpdate = true;
      s.iCol.clearUpdateRanges(); s.iCol.addUpdateRange(0, cnt * 4); s.iCol.needsUpdate = true;
    }
    lastGather.copy(cam);
    gatherAge = 0;
  }

  let time = 0;
  const camPos = new THREE.Vector3();
  const api = {
    object,
    lamps, mirror,
    get nightMap() { return nightMap; },
    /** cb(texture, xform) once the ground light map is loaded (fog/cloud glow). */
    onMap(cb) { mapListeners.push(cb); if (nightMap.tex) cb(nightMap.tex, nightMap.xf); },
    get stats() { return { lamps: lamps.geo.instanceCount, mirrored: mirror.geo.instanceCount, loaded: !!L, map: nightMap.size }; },
    setQuality(q) {
      const nq = QUAL[q && q.id] || QUAL.high;
      const reload = nightMap.tex && nq.map !== nightMap.size;
      Q = nq;
      if (reload) { nightMap.loading = loadMap(Q.map).catch((e) => console.warn('[lights] night map', e)); }
      gatherAge = 99;
      if (!Q.mirror) mirror.geo.instanceCount = 0;
    },
    update(dt, camera) {
      time += dt;
      const gain = SKY_STATE.lights;
      const on = gain > 0.01;
      if (terrain && terrain.shared) terrain.shared.uNightGain.value = on && nightMap.tex ? 0.26 * gain : 0;
      if (on && !nightMap.loading) nightMap.loading = loadMap(Q.map).catch((e) => { console.warn('[lights] night map unavailable', e.message || e); });
      if (on && !lampsLoading) lampsLoading = loadLamps().catch((e) => { console.warn('[lights] lamps unavailable', e.message || e); });
      lamps.mesh.visible = on && !!L;
      mirror.mesh.visible = on && !!L && Q.mirror;
      if (!lamps.mesh.visible) return;
      camera.getWorldPosition(camPos);
      gatherAge += dt;
      const moved = Math.hypot(camPos.x - lastGather.x, camPos.z - lastGather.z);
      if (moved > Math.max(120, Q.radius * 0.06) || gatherAge > 30) gather(camPos);
      // lamps dim with altitude a little less than the ground map: from high up the map carries the city
      updateSpriteUniforms(lamps.mesh.material, camera, renderer, gain, Q.radius, time);
      updateSpriteUniforms(mirror.mesh.material, camera, renderer, gain * (1 - SKY_STATE.inLayer), MIRROR_RADIUS, time);
    },
  };
  return api;
}
