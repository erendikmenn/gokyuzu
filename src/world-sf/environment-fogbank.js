// W1: the Golden Gate fog bank ("Karl"): a low marine layer over the Pacific that pours through the Golden Gate.
// Rendered as the fog's top surface: a camera-centred polar grid displaced in the vertex shader (smooth octaves),
// shaded per fragment (billows from analytic noise gradients), depth-tested against the scene so hills, bridge towers
// and aircraft poke through naturally. Being inside the layer is handled cheaply by the aerial-perspective chunk
// (CPU evaluates the layer at the camera once per frame).
import * as THREE from 'three';
import { NOISE_GLSL } from './environment-clouds.js';

export const BANK_GLSL = /* glsl */`
// cheap analytic footprint (no noise): offshore marine layer west of the coast + tongue through the Golden Gate
float sfBankFoot(vec2 p) {
  float edge = p.y > -22800.0 ? -12300.0 : -12300.0 + (p.y + 22800.0) * 1.55;
  edge += 2600.0 * (sfVNoise(vec2(p.y / 6500.0, p.x / 9000.0) + 21.7) - 0.5);
  float off = smoothstep(edge + 900.0, edge - 2600.0, p.x);
  vec2 a = vec2(-14500.0, -22750.0), b = vec2(-6900.0, -21900.0);
  vec2 ab = b - a; float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  float d = length(p - (a + ab * t));
  float w = mix(1350.0, 520.0, t);
  float tongue = smoothstep(w + 700.0, w * 0.3, d) * (1.0 - smoothstep(0.35, 1.0, t));
  float m = max(off, tongue);
  return m * smoothstep(-62000.0, -46000.0, p.x) * smoothstep(-54000.0, -40000.0, p.y) * smoothstep(18000.0, 5000.0, p.y);
}
float sfBankMask(vec2 p, float f) {
  if (f <= 0.001) return 0.0;
  if (f >= 0.97) return 1.0;
  float n = sfFbm3(p / 3900.0 + 3.0) + 0.3 * sfVNoise(p / 700.0);
  return smoothstep(0.3, 0.75, f + (n - 0.6) * 0.9);
}
// top height (+ gradient): broad swells + billows drifting east with the sea breeze; thins toward the edges.
// detail = 0 drops the smallest octave (vertex displacement), 1 = full (fragment shading)
vec3 sfBankTopD(vec2 p, float f, float t, float detail) {
  vec2 q = p - vec2(2.2, 0.4) * t;
  vec3 n1 = sfVNoiseD(q / 2100.0 + 11.0); n1.yz /= 2100.0;
  vec3 n2 = sfVNoiseD(q / 980.0 + 16.3); n2.yz /= 980.0;
  vec3 b1 = sfVNoiseD(q / 260.0); b1.yz /= 260.0;
  vec3 b2 = detail > 0.5 ? sfVNoiseD(q / 95.0 + 3.1) : vec3(0.5, 0.0, 0.0); b2.yz /= 95.0;
  vec3 big = 0.62 * n1 + 0.38 * n2;
  vec3 bil = 0.6 * b1 + 0.4 * b2;
  float thick = smoothstep(0.0, 0.85, f);
  float k = 0.25 + 0.75 * thick;
  float h = (40.0 + 230.0 * (big.x - 0.2) + 55.0 * bil.x * bil.x) * k - 30.0 * (1.0 - thick);
  vec2 g = (230.0 * big.yz + 110.0 * bil.x * bil.yz) * k;
  return vec3(h, g);
}
`;

// ---------------------------------------------------------------- JS port (camera-in-fog test)
function fract(x) { return x - Math.floor(x); }
function hash2(x, y) {
  let qx = fract(x * 0.1031), qy = fract(y * 0.1031), qz = fract(x * 0.1031);
  const d = qx * (qy + 33.33) + qy * (qz + 33.33) + qz * (qx + 33.33);
  qx += d; qy += d; qz += d;
  return fract((qx + qy) * qz);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
const smooth = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };
function fbm3(x, y) { return 0.5 * vnoise(x, y) + 0.25 * vnoise(x * 2.07 + 5.3, y * 2.07 + 5.3) + 0.125 * vnoise(x * 4.13 + 9.1, y * 4.13 + 9.1); }
export function bankFoot(x, z) {
  let edge = z > -22800 ? -12300 : -12300 + (z + 22800) * 1.55;
  edge += 2600 * (vnoise(z / 6500 + 21.7, x / 9000 + 21.7) - 0.5);
  const off = smooth(edge + 900, edge - 2600, x);
  const ax = -14500, az = -22750, bx = -6900, bz = -21900;
  const abx = bx - ax, abz = bz - az;
  const t = Math.min(Math.max(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0), 1);
  const d = Math.hypot(x - (ax + abx * t), z - (az + abz * t));
  const w = 1350 + (520 - 1350) * t;
  const tongue = smooth(w + 700, w * 0.3, d) * (1 - smooth(0.35, 1, t));
  return Math.max(off, tongue) * smooth(-62000, -46000, x) * smooth(-54000, -40000, z) * smooth(18000, 5000, z);
}
export function bankTop(x, z, time) {
  const f = bankFoot(x, z);
  if (f <= 0.001) return { f, h: -100, m: 0 };
  const qx = x - 2.2 * time, qz = z - 0.4 * time;
  const big = 0.62 * vnoise(qx / 2100 + 11, qz / 2100 + 11) + 0.38 * vnoise(qx / 980 + 16.3, qz / 980 + 16.3);
  const bil = 0.6 * vnoise(qx / 260, qz / 260) + 0.4 * vnoise(qx / 95 + 3.1, qz / 95 + 3.1);
  const thick = smooth(0, 0.85, f);
  const h = (40 + 230 * (big - 0.2) + 55 * bil * bil) * (0.25 + 0.75 * thick) - 30 * (1 - thick);
  let m = 1;
  if (f < 0.97) m = smooth(0.3, 0.75, f + (fbm3(x / 3900 + 3, z / 3900 + 3) + 0.3 * vnoise(x / 700, z / 700) - 0.6) * 0.9);
  return { f, h, m };
}

// ---------------------------------------------------------------- mesh
/** Terrain height map under the fog bank (64 m, built by tools/geo/terrain_fogmap.py); null if missing. */
export async function loadBankHeight() {
  try {
    const base = new URL('../../assets/sf/terrain/', import.meta.url).href;
    const [meta, buf] = await Promise.all([
      fetch(base + 'bank_height.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(base + 'bank_height.bin').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    ]);
    const src = new Uint16Array(buf), n = meta.width * meta.height;
    const half = new Uint16Array(n);
    for (let k = 0; k < n; k++) half[k] = THREE.DataUtils.toHalfFloat(Math.max(src[k] / 10 - 100, 0));
    const tex = new THREE.DataTexture(half, meta.width, meta.height, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    // uv = (xz - origin) / (size); texel i covers [x0 + i*res, +res]
    return { tex, xform: new THREE.Vector4(1 / (meta.width * meta.res), 1 / (meta.height * meta.res), -meta.x0 / (meta.width * meta.res), -meta.z0 / (meta.height * meta.res)) };
  } catch (e) {
    return null;
  }
}

export function createFogBank({ sunDir, sunE, amb, ground }) {
  const RINGS = 150, SEGS = 288;
  const g = 1.041, r0 = 8;   // outer radius ~81 km
  const polar = new Float32Array((RINGS + 1) * SEGS * 2);
  let k = 0;
  for (let i = 0; i <= RINGS; i++) {
    const r = i === 0 ? 0 : r0 * (Math.pow(g, i) - 1) / (g - 1);
    for (let s = 0; s < SEGS; s++) { polar[k++] = r; polar[k++] = (s / SEGS) * Math.PI * 2; }
  }
  const idx = [];
  for (let i = 0; i < RINGS; i++) for (let s = 0; s < SEGS; s++) {
    const a = i * SEGS + s, b = i * SEGS + (s + 1) % SEGS, c = a + SEGS, d = b + SEGS;
    idx.push(a, b, c, b, d, c);   // counter-clockwise seen from above (+Y)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RINGS + 1) * SEGS * 3), 3));
  geo.setAttribute('polar', new THREE.BufferAttribute(polar, 2));
  geo.setIndex(idx);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uCamPos: { value: new THREE.Vector3() }, uTime: { value: 0 },
    uSunDir: { value: sunDir.clone() }, uSunE: { value: new THREE.Vector3(...sunE) }, uAmb: { value: new THREE.Vector3(...amb) },
    uGround: { value: ground ? ground.tex : null }, uGroundXf: { value: ground ? ground.xform : new THREE.Vector4() },
  }]);
  const mat = new THREE.ShaderMaterial({
    name: 'sf-fogbank',
    defines: ground ? { SF_GROUND: 1, SF_BANK_DETAIL: '1.0' } : { SF_BANK_DETAIL: '1.0' },
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute vec2 polar;
      uniform vec3 uCamPos; uniform float uTime;
      varying vec3 vWorld;
      varying float vEdge;
      ${NOISE_GLSL}
      ${BANK_GLSL}
      void main() {
        vEdge = 1.0 - smoothstep(55000.0, 80000.0, polar.x);
        vec2 xz = uCamPos.xz + polar.x * vec2(cos(polar.y), sin(polar.y));
        float f = sfBankFoot(xz);
        float h = f > 0.001 ? sfBankTopD(xz, f, uTime, 0.0).x : -80.0;
        vWorld = vec3(xz.x, h, xz.y);
        vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uCamPos; uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunE; uniform vec3 uAmb;
      uniform sampler2D uGround; uniform vec4 uGroundXf;
      varying vec3 vWorld;
      varying float vEdge;
      ${NOISE_GLSL}
      ${BANK_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float f = sfBankFoot(vWorld.xz);
        if (f < 0.002 || vWorld.y < -1.0) discard;
        float m = sfBankMask(vWorld.xz, f);
        if (m < 0.01) discard;
        vec3 tg = sfBankTopD(vWorld.xz, f, uTime, SF_BANK_DETAIL);
        vec3 n = normalize(vec3(-tg.y * 1.7, 1.0, -tg.z * 1.7));
        float sunL = clamp(dot(n, uSunDir) * 0.75 + 0.3, 0.05, 1.0);   // wrapped: light scatters through the fog top
        float trough = clamp((tg.x - 40.0) / 240.0, 0.0, 1.0);
        vec3 col = uSunE * (0.27 * sunL * (0.6 + 0.4 * trough)) + uAmb * (1.6 + 0.4 * trough);
        if (!gl_FrontFacing) col = uSunE * 0.05 + uAmb * 1.3;   // seen from inside/below: grey ceiling
        float alpha = smoothstep(0.01, 0.45, m) * smoothstep(-1.0, 10.0, vWorld.y) * vEdge;
        #ifdef SF_GROUND
          // thin and wispy where the fog top is close to rising ground (headlands, hills)
          float gh = texture2D(uGround, vWorld.xz * uGroundXf.xy + uGroundXf.zw).r;
          alpha *= smoothstep(0.0, 40.0, vWorld.y - gh);
        #endif
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sf-fogbank';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  let time = 0;
  return {
    mesh,
    uniforms,
    /** Terrain height map for soft fog edges on hills (loaded after start). */
    setGround(g) {
      if (!g) return;
      uniforms.uGround.value = g.tex; uniforms.uGroundXf.value.copy(g.xform);
      if (!mat.defines.SF_GROUND) { mat.defines.SF_GROUND = 1; mat.needsUpdate = true; }
    },
    /** clouds quality 'low' drops the finest billow octave */
    setQuality(c) {
      const v = c === 'low' ? '0.0' : '1.0';
      if (mat.defines.SF_BANK_DETAIL !== v) { mat.defines.SF_BANK_DETAIL = v; mat.needsUpdate = true; }
    },
    /** returns { inside (0..1), topAbove (m above the camera) } */
    update(dt, camera) {
      time += dt;
      uniforms.uTime.value = time;
      uniforms.uCamPos.value.copy(camera.position);
      const b = bankTop(camera.position.x, camera.position.z, time);
      const inside = b.f > 0.001 ? b.m * smooth(0, -15, camera.position.y - b.h) : 0;
      return { inside, topAbove: Math.max(b.h - camera.position.y, 0), time };
    },
  };
}
