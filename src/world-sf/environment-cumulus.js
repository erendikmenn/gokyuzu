// Time & weather: fair-weather cumulus for 'parçalı bulutlu' (partly cloudy). Each cloud is a cluster of soft,
// camera-facing puff impostors (flat base, domed top) lit like spheres: sunlit tops and flanks, darker bases, silver
// edges toward the sun, city glow at night. One instanced draw, sorted back to front on the CPU (a few thousand puffs),
// clouds placed deterministically on a 1.4 km grid around the camera and drifting with the wind. Fogged by the shared
// aerial perspective. densityAt() lets the environment know when the camera flies through a cloud.
import * as THREE from 'three';
import { GLOW_GLSL } from './environment-clouds.js';

const CELL = 1400;          // m, one potential cloud per cell
let RADIUS = 26000;         // m, clouds kept around the camera (quality: 16 / 21 / 26 km)
let PUFF_SCALE = 1;         // puffs per cloud (quality: overdraw is the cost)
const MAX_PUFFS = 12000;

function hash(i, j, k) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createCumulus({ sunDir, sunE, amb, noiseTex }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPuff = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iInfo = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPuff', iPuff);
  geo.setAttribute('iInfo', iInfo);
  geo.instanceCount = 0;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uSunDir: { value: sunDir.clone() }, uSunE: { value: new THREE.Vector3(...sunE) }, uAmb: { value: new THREE.Vector3(...amb) },
    uGlow: { value: new THREE.Vector3() }, uGlowXf: { value: new THREE.Vector4(0, 0, -10, -10) }, uDrift: { value: new THREE.Vector2() },
    uRadius: { value: 26000 },
  }]);
  uniforms.uNoise = { value: noiseTex };
  uniforms.uGlowMap = { value: null };
  const mat = new THREE.ShaderMaterial({
    name: 'sf-cumulus',
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 iPuff;   // centre (m, at drift 0), radius
      attribute vec4 iInfo;   // height fraction in the cloud, seed, cloud brightness, base height (m)
      uniform vec2 uDrift; uniform float uRadius;
      varying vec2 vUv; varying vec4 vInfo; varying float vFade; varying vec3 vCenter; varying float vBaseDy;
      void main() {
        vec3 c = iPuff.xyz + vec3(uDrift.x, 0.0, uDrift.y);
        vCenter = c;
        vec4 mvPosition = viewMatrix * vec4(c, 1.0);
        float d = length(c - cameraPosition);
        // pull the quad toward the camera by its radius so hills/other puffs do not slice it flat
        mvPosition.xyz += normalize(-mvPosition.xyz) * min(iPuff.w * 0.6, d * 0.5);
        mvPosition.xy += position.xy * iPuff.w;
        vUv = position.xy;
        vInfo = iInfo;
        // world height of this corner above the cloud base (flat bases)
        vBaseDy = c.y + position.y * iPuff.w - iInfo.w;
        vFade = smoothstep(iPuff.w * 0.5, iPuff.w * 1.6, d) * (1.0 - smoothstep(uRadius * 0.85, uRadius * 1.1, d));
        gl_Position = projectionMatrix * mvPosition;
        if (vFade < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDir; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uGlow;
      uniform sampler2D uNoise;
      ${GLOW_GLSL}
      varying vec2 vUv; varying vec4 vInfo; varying float vFade; varying vec3 vCenter; varying float vBaseDy;
      void main() {
        #include <logdepthbuf_fragment>
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        vec2 nuv = vUv * 0.42 + vInfo.y * 7.3;
        float n = texture2D(uNoise, nuv).g * 0.5 + texture2D(uNoise, nuv * 2.3 + 0.5).b * 0.3 + texture2D(uNoise, nuv * 5.1 + 0.2).a * 0.2;
        float r = sqrt(r2);
        // cauliflower edges: the noise eats into the disc, the centre stays dense
        float a = smoothstep(0.95, 0.2, r * 1.1 + (n - 0.5) * 1.0);
        a *= smoothstep(-6.0, 26.0, vBaseDy);   // flat, slightly soft base
        a *= vFade * 0.78;
        if (a < 0.02) discard;
        // sphere impostor normal (view space → world)
        vec3 nV = vec3(vUv, sqrt(max(1.0 - r2, 0.0)));
        vec3 nW = normalize((vec4(nV, 0.0) * viewMatrix).xyz);
        float sunUp = clamp(uSunDir.y * 5.0 + 0.2, 0.0, 1.0);
        float wrap = clamp(dot(nW, uSunDir) * 0.55 + 0.45, 0.0, 1.0);
        float h = clamp(vInfo.x + nW.y * 0.3, 0.0, 1.0);          // higher = brighter (light diffuses in from the top)
        float self = mix(0.35, 1.0, h) * (0.75 + 0.35 * n);
        vec3 V = normalize(vCenter - cameraPosition);
        float silver = pow(max(dot(V, uSunDir), 0.0), 8.0) * (1.0 - a) * 1.6;
        vec3 col = uSunE * (0.05 + 0.34 * wrap * self + 0.25 * silver) * sunUp + uAmb * (1.0 + 1.1 * h) * vInfo.z;
        col *= mix(0.55, 1.0, smoothstep(0.0, 160.0, vBaseDy));   // grey flat bases
        if (uGlow.r > 0.0005) col += uGlow * sfCityGlow(vCenter.xz) * (1.2 - h) * 0.8;   // night only (skips a fetch by day)
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sf-cumulus';
  mesh.frustumCulled = false;
  mesh.renderOrder = 19;
  mesh.visible = false;

  // CPU copy of the current puffs (for sorting and the in-cloud test)
  const P = new Float32Array(MAX_PUFFS * 4), I = new Float32Array(MAX_PUFFS * 4);
  let count = 0;
  const cfg = { base: 1250, thick: 650, cover: 0.4, wind: [3.0, 0.8] };
  const lastBuild = new THREE.Vector2(1e9, 1e9);
  let time = 0, sortTimer = 0;
  const order = new Uint32Array(MAX_PUFFS), dist = new Float32Array(MAX_PUFFS);

  function build(cx, cz) {
    // positions are generated in "drift space": the whole field moves with the wind (uDrift)
    const dx = cfg.wind[0] * time, dz = cfg.wind[1] * time;
    const fx = cx - dx, fz = cz - dz;
    const i0 = Math.floor((fx - RADIUS) / CELL), i1 = Math.floor((fx + RADIUS) / CELL);
    const j0 = Math.floor((fz - RADIUS) / CELL), j1 = Math.floor((fz + RADIUS) / CELL);
    count = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const hc = hash(i, j, 1);
      // regional variation: clusters and clear patches
      const reg = 0.55 + 0.45 * Math.sin(i * 0.37 + j * 0.23) * Math.cos(i * 0.11 - j * 0.29);
      if (hc > cfg.cover * reg * 1.25) continue;
      const ccx = (i + 0.2 + 0.6 * hash(i, j, 2)) * CELL, ccz = (j + 0.2 + 0.6 * hash(i, j, 3)) * CELL;
      if (Math.hypot(ccx - fx, ccz - fz) > RADIUS) continue;
      const size = 280 + 520 * Math.pow(hash(i, j, 4), 1.5);             // cloud half-width (m)
      const tall = Math.min(cfg.thick, size * (0.8 + 0.7 * hash(i, j, 5)));
      const cd = Math.hypot(ccx - fx, ccz - fz);
      const n = Math.max(4, Math.round((6 + size / 60) * (cd < 9000 ? 1 : cd < 16000 ? 0.6 : 0.35) * PUFF_SCALE));   // distance LOD
      const bright = 0.85 + 0.3 * hash(i, j, 6);
      for (let k = 0; k < n && count < MAX_PUFFS; k++) {
        const u = hash(i, j, 10 + k), v = hash(i, j, 40 + k), w = hash(i, j, 70 + k);
        const ang = u * Math.PI * 2, rr = Math.sqrt(v) * size * 0.75;
        const hf = Math.pow(w, 0.9);
        const spread = 1 - 0.55 * hf;                                     // dome: narrower toward the top
        const px = ccx + Math.cos(ang) * rr * spread, pz = ccz + Math.sin(ang) * rr * spread;
        const rad = size * (0.3 + 0.25 * hash(i, j, 100 + k)) * (1 - 0.3 * hf);
        const py = cfg.base + rad * 0.55 + hf * tall * 0.75;
        P[4 * count] = px; P[4 * count + 1] = py; P[4 * count + 2] = pz; P[4 * count + 3] = rad;
        I[4 * count] = hf; I[4 * count + 1] = hash(i, j, 130 + k); I[4 * count + 2] = bright; I[4 * count + 3] = cfg.base;
        count++;
      }
    }
    lastBuild.set(cx, cz);
    sortTimer = 0;
  }

  function sortUpload(cam) {
    const dx = cfg.wind[0] * time, dz = cfg.wind[1] * time;
    for (let k = 0; k < count; k++) {
      order[k] = k;
      const x = P[4 * k] + dx - cam.x, y = P[4 * k + 1] - cam.y, z = P[4 * k + 2] + dz - cam.z;
      dist[k] = x * x + y * y + z * z;
    }
    const ord = order.subarray(0, count);
    ord.sort((a, b) => dist[b] - dist[a]);   // far first
    const A = iPuff.array, B = iInfo.array;
    for (let k = 0; k < count; k++) {
      const s = ord[k];
      A[4 * k] = P[4 * s]; A[4 * k + 1] = P[4 * s + 1]; A[4 * k + 2] = P[4 * s + 2]; A[4 * k + 3] = P[4 * s + 3];
      B[4 * k] = I[4 * s]; B[4 * k + 1] = I[4 * s + 1]; B[4 * k + 2] = I[4 * s + 2]; B[4 * k + 3] = I[4 * s + 3];
    }
    geo.instanceCount = count;
    for (const at of [iPuff, iInfo]) { at.clearUpdateRanges(); at.addUpdateRange(0, count * 4); at.needsUpdate = true; }
  }

  return {
    mesh, uniforms,
    /** { base, thick, cover } or null. */
    set(p) {
      mesh.visible = !!p;
      if (!p) return;
      Object.assign(cfg, { base: p.base, thick: p.thick, cover: p.cover });
      lastBuild.set(1e9, 1e9);
    },
    /** Graphics quality: 'low' | 'medium' | 'high' cloud setting → field radius. */
    setQuality(c) {
      const r = c === 'low' ? 16000 : c === 'medium' ? 21000 : 26000;
      const k = c === 'low' ? 0.6 : c === 'medium' ? 0.8 : 1;
      if (r !== RADIUS || k !== PUFF_SCALE) { RADIUS = r; PUFF_SCALE = k; lastBuild.set(1e9, 1e9); }
    },
    /** 0..1 cloud density at a world point (camera inside a puff). */
    densityAt(x, y, z) {
      if (!mesh.visible || y < cfg.base - 20 || y > cfg.base + cfg.thick + 200) return 0;
      const dx = cfg.wind[0] * time, dz = cfg.wind[1] * time;
      let d = 0;
      for (let k = 0; k < count; k++) {
        const r = P[4 * k + 3] * 0.8;
        const ex = P[4 * k] + dx - x, ey = P[4 * k + 1] - y, ez = P[4 * k + 2] + dz - z;
        const q = (ex * ex + ey * ey + ez * ez) / (r * r);
        if (q < 1) d = Math.max(d, 1 - q);
      }
      return Math.min(1, d * 1.5);
    },
    update(dt, camera) {
      if (!mesh.visible) return;
      time += dt;
      uniforms.uDrift.value.set(cfg.wind[0] * time, cfg.wind[1] * time);
      uniforms.uRadius.value = RADIUS;
      const c = camera.position;
      if (Math.hypot(c.x - lastBuild.x, c.z - lastBuild.y) > 1500) build(c.x, c.z);
      sortTimer -= dt;
      if (sortTimer <= 0) { sortUpload(c); sortTimer = 0.2; }
    },
  };
}
