// W1: GLSL noise helpers and the procedural high cloud layer of the sky dome (the fog bank lives in environment-fogbank.js).
// All GLSL identifiers are prefixed with sf to avoid clashes.
export const NOISE_GLSL = /* glsl */`
float sfHash2(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float sfVNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sfHash2(i), sfHash2(i + vec2(1.0, 0.0)), u.x), mix(sfHash2(i + vec2(0.0, 1.0)), sfHash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sfFbm3(vec2 p) { return 0.5 * sfVNoise(p) + 0.25 * sfVNoise(p * 2.07 + 5.3) + 0.125 * sfVNoise(p * 4.13 + 9.1); }
// value noise with analytic gradient: (value, d/dx, d/dy)
vec3 sfVNoiseD(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = sfHash2(i), b = sfHash2(i + vec2(1.0, 0.0)), c = sfHash2(i + vec2(0.0, 1.0)), d = sfHash2(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
`;
// Night: city light under clouds/fog, from the blurred mips of the ground light map (lights.js); 1 without the map.
export const GLOW_GLSL = /* glsl */`
uniform sampler2D uGlowMap;
uniform vec4 uGlowXf;
float sfCityGlow(vec2 xz) {
  if (uGlowXf.x <= 0.0) return 1.0;
  vec2 uv = xz * uGlowXf.xy + uGlowXf.zw;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec2 g = textureLod(uGlowMap, clamp(uv, 0.0, 1.0), 6.5).rg;
  return inside * clamp(dot(g * g, vec2(1.0)) * 14.0, 0.0, 3.0);
}
`;
// High, thin clouds on the sky dome (altocumulus patches + cirrus streaks), lit by the sun with forward scattering.
export const CLOUD_GLSL = /* glsl */`
float sfCloudDens(vec2 p, float t) {
  vec2 pw = p + vec2(4.0, -1.5) * t;
  vec2 w = vec2(sfFbm3(pw / 5200.0), sfFbm3(pw / 5200.0 + 7.7)) * 1900.0;   // domain warp -> cell-like patches
  vec2 q = pw + w;
  float base = sfFbm3(q / 2500.0);
  float det = sfVNoise(q / 540.0) * 0.5 + sfVNoise(q / 190.0) * 0.28 + sfVNoise(q / 72.0) * 0.14;
  float cov = smoothstep(0.38, 0.62, sfFbm3(p / 21000.0 + 4.0));             // regional coverage: mostly clear
  return clamp((base + det * 0.6 - (1.0 - 0.22 * cov)) * 3.2, 0.0, 1.0);
}
vec3 skyClouds(vec3 col, vec3 dir, vec3 camPos, float t) {
  const float H = 6200.0;
  if (dir.y <= 0.004 || camPos.y > H) return col;
  float dist = (H - camPos.y) / dir.y;
  vec2 p = camPos.xz + dir.xz * dist;
  float d = sfCloudDens(p, t);
  // thin cirrus streaks higher up
  vec2 q = vec2(dot(p, vec2(0.93, 0.37)) / 9000.0, dot(p, vec2(-0.37, 0.93)) / 2200.0);
  float ci = smoothstep(0.63, 0.88, sfFbm3(q + t * 0.0004)) * 0.3 * smoothstep(0.45, 0.7, sfVNoise(p / 30000.0 + 1.1));
  float fade = smoothstep(0.004, 0.06, dir.y) * exp(-dist / 70000.0);
  if (d + ci <= 0.001) return col;
  // self shadowing: density toward the sun darkens; edges facing the sun get a silver lining
  vec2 sdir = normalize(uSunDir.xz + 1e-5);
  float ds = sfCloudDens(p + sdir * 350.0, t);
  float shade = exp(-ds * 1.6);
  float mu = dot(dir, uSunDir);
  float silver = pow(max(mu, 0.0), 12.0) * (1.0 - d) * 2.5;
  vec3 lit = uSunE * (0.05 + 0.20 * shade + 0.25 * silver) + uAmb * (1.2 + 0.8 * (1.0 - d));
  float a = clamp(d * 0.95 + ci, 0.0, 1.0) * fade;
  return mix(col, lit, a);
}
`;

// Cloud layer as geometry: a camera-following disc at 6.2 km, so clouds are seen from below and above, occlude terrain
// correctly and get the shared aerial perspective (fog chunk). Same density field as CLOUD_GLSL.
export const CLOUD_H = 6200;
export function createCloudLayer(THREE, { sunDir, sunE, amb }) {
  const geo = new THREE.CircleGeometry(80000, 96).rotateX(-Math.PI / 2);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uSunDir: { value: sunDir.clone() }, uSunE: { value: new THREE.Vector3(...sunE) },
    uAmb: { value: new THREE.Vector3(...amb) }, uCamPos: { value: new THREE.Vector3() },
    uAmount: { value: 1 },                        // weather: 0 = none, 1 = default scattered patches, 2 = broken
    uGlow: { value: new THREE.Vector3() },        // night: city light reflected by the cloud base
    uGlowXf: { value: new THREE.Vector4(0, 0, -10, -10) },
  }]);
  uniforms.uGlowMap = { value: null };
  const mat = new THREE.ShaderMaterial({
    name: 'sf-clouds',
    defines: { SF_CLOUD_Q: 2 },
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uCamPos;
      uniform float uAmount; uniform vec3 uGlow;
      ${GLOW_GLSL}
      varying vec3 vWorld;
      ${NOISE_GLSL}
      #ifndef SF_CLOUD_Q
        #define SF_CLOUD_Q 2
      #endif
      float sfCloudDens(vec2 p, float t) {
        vec2 pw = p + vec2(4.0, -1.5) * t;
      #if SF_CLOUD_Q >= 1
        vec2 w = vec2(sfFbm3(pw / 5200.0), sfFbm3(pw / 5200.0 + 7.7)) * 1900.0;   // domain warp -> cell-like patches
      #else
        vec2 w = vec2(sfVNoise(pw / 5200.0), sfVNoise(pw / 5200.0 + 7.7)) * 1900.0;
      #endif
        vec2 q = pw + w;
        float base = sfFbm3(q / 2500.0);
      #if SF_CLOUD_Q >= 1
        float det = sfVNoise(q / 540.0) * 0.5 + sfVNoise(q / 190.0) * 0.28 + sfVNoise(q / 72.0) * 0.14;
      #else
        float det = sfVNoise(q / 540.0) * 0.6 + 0.18;
      #endif
        float cov = smoothstep(0.38, 0.62, sfFbm3(p / 21000.0 + 4.0));
        return clamp((base + det * 0.6 - (1.0 - 0.22 * cov * uAmount - 0.12 * max(uAmount - 1.0, 0.0))) * 3.2, 0.0, 1.0);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vWorld.xz;
        vec3 ray = vWorld - uCamPos;
        float dist = length(ray);
        vec3 dir = ray / max(dist, 1.0);
        float d = sfCloudDens(p, uTime);
        vec2 q = vec2(dot(p, vec2(0.93, 0.37)) / 9000.0, dot(p, vec2(-0.37, 0.93)) / 2200.0);
        float ci = smoothstep(0.63, 0.88, sfFbm3(q + uTime * 0.0004)) * 0.3 * smoothstep(0.45, 0.7, sfVNoise(p / 30000.0 + 1.1)) * min(uAmount * 1.5, 1.0);
        float a = clamp(d * 0.95 + ci, 0.0, 1.0);
        a *= smoothstep(76000.0, 40000.0, dist) * smoothstep(0.0, 0.035, abs(dir.y));
        if (a < 0.003) discard;
      #if SF_CLOUD_Q >= 2
        vec2 sdir = normalize(uSunDir.xz + 1e-5);
        float ds = sfCloudDens(p + sdir * 350.0, uTime);
        float shade = exp(-ds * 1.6);
      #else
        float shade = exp(-d * 1.2);
      #endif
        float mu = dot(dir, uSunDir);
        vec3 lit;
        if (uCamPos.y < vWorld.y) {   // seen from below: dark bases, silver lining toward the sun
          float silver = pow(max(mu, 0.0), 12.0) * (1.0 - d) * 2.5;
          lit = uSunE * (0.05 + 0.20 * shade + 0.25 * silver) + uAmb * (1.2 + 0.8 * (1.0 - d));
        } else {                      // seen from above: sunlit tops
          lit = uSunE * (0.18 + 0.22 * shade) + uAmb * 1.9;
        }
        if (uGlow.r > 0.0005) lit += uGlow * sfCityGlow(p) * (0.6 + 0.4 * d);
        gl_FragColor = vec4(lit, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sf-clouds';
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  const LEVEL = { low: 0, medium: 1, high: 2 };
  return {
    mesh,
    /** 'low' | 'medium' | 'high' (shader variant: domain warp, detail octaves, self-shadowing) */
    setQuality(c) {
      const v = LEVEL[c] ?? 2;
      if (mat.defines.SF_CLOUD_Q !== v) { mat.defines.SF_CLOUD_Q = v; mat.needsUpdate = true; }
    },
    update(time, camera) {
      uniforms.uTime.value = time;
      uniforms.uCamPos.value.copy(camera.position);
      mesh.position.set(camera.position.x, CLOUD_H, camera.position.z);
    },
  };
}

// ---------------------------------------------------------------------------------------------- low cloud deck
// Weather clouds between 400 m and 2.5 km: cumulus (partly cloudy), stratus (overcast), nimbostratus (rain).
// N horizontal slices through one density field, drawn as one instanced draw (far slice first), give the layer a
// thickness: the coverage threshold rises toward the top (cumulus domes), sunlit tops, darker bases, city glow from
// below at night. Density comes from a small tileable noise texture (cheap), the same field is sampled on the CPU
// (cloudDeckDensity) to know when the camera is inside a cloud.

/** Tileable RGBA value-noise octaves (R coarse … A fine), size² texels. */
export function createNoiseData(size = 128, seed = 11) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = new Uint8Array(size * size * 4);
  const lat = (n) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const periods = [4, 8, 16, 32];                 // lattice cells per tile, one per channel
  for (let c = 0; c < 4; c++) {
    const n = periods[c];
    const L1 = lat(n), L2 = lat(n * 2);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0;
      for (const [L, m, w] of [[L1, n, 0.68], [L2, n * 2, 0.32]]) {
        const fx = x / size * m, fy = y / size * m;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
        const g = (i, j) => L[((j % m) * m) + (i % m)];
        const a = g(ix, iy), b = g(ix + 1, iy), cc = g(ix, iy + 1), d = g(ix + 1, iy + 1);
        v += w * (a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy);
      }
      out[(y * size + x) * 4 + c] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
    }
  }
  return { data: out, size };
}

// deck noise scales (m per texture tile) for the four channels
const DECK_SCALE = [9000, 3600, 1500, 520];
export const DECK_GLSL = /* glsl */`
uniform sampler2D uNoise;
uniform vec4 uDeck;       // base (m), thickness (m), cover 0..1, type (0 cumulus, 1 stratus, 2 nimbostratus)
uniform vec2 uWind;       // drift (m/s)
float sfDeckNoise(vec2 p) {
  return texture2D(uNoise, p / ${DECK_SCALE[0].toFixed(1)}).r * 0.40 + texture2D(uNoise, p / ${DECK_SCALE[1].toFixed(1)} + 0.31).g * 0.30
       + texture2D(uNoise, p / ${DECK_SCALE[2].toFixed(1)} + 0.57).b * 0.20 + texture2D(uNoise, p / ${DECK_SCALE[3].toFixed(1)} + 0.13).a * 0.10;
}
// fine billows of the cloud tops (seen from above)
float sfTopN(vec2 p) { return texture2D(uNoise, p / 760.0 + 0.21).b * 0.55 + texture2D(uNoise, p / 230.0 + 0.63).a * 0.45; }
// density 0..1 at horizontal position p, height fraction hf (0 base … 1 top)
float sfDeckDens(vec2 p, float hf, float t) {
  float n = sfDeckNoise(p - uWind * t);
  float cover = uDeck.z;
  float shape = uDeck.w < 0.5 ? mix(0.0, 0.22, hf * hf) + 0.05 * (1.0 - hf) : 0.03 * hf;   // cumulus: narrower toward the top
  float thr = mix(0.78, 0.18, cover) + shape;
  return smoothstep(thr, thr + (uDeck.w < 0.5 ? 0.09 : 0.2), n);
}
`;

/** CPU twin of sfDeckDens (bilinear, repeat) for the camera-inside-cloud test. */
export function cloudDeckDensity(noise, deck, x, z, hf, t) {
  const { data, size } = noise;
  const samp = (u, v, c) => {
    u = (u - Math.floor(u)) * size - 0.5; v = (v - Math.floor(v)) * size - 0.5;
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const g = (a, b) => data[((((b % size) + size) % size) * size + (((a % size) + size) % size)) * 4 + c] / 255;
    return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
  };
  // texture2D(v) with flipY = false: uv.y follows z
  const px = x - deck.wind[0] * t, pz = z - deck.wind[1] * t;
  const n = samp(px / DECK_SCALE[0], pz / DECK_SCALE[0], 0) * 0.40 + samp(px / DECK_SCALE[1] + 0.31, pz / DECK_SCALE[1] + 0.31, 1) * 0.30
    + samp(px / DECK_SCALE[2] + 0.57, pz / DECK_SCALE[2] + 0.57, 2) * 0.20 + samp(px / DECK_SCALE[3] + 0.13, pz / DECK_SCALE[3] + 0.13, 3) * 0.10;
  const cum = deck.type < 0.5;
  const shape = cum ? 0.22 * hf * hf + 0.05 * (1 - hf) : 0.03 * hf;
  const thr = 0.78 + (0.18 - 0.78) * deck.cover + shape;
  const w = cum ? 0.09 : 0.2;
  const tt = Math.min(Math.max((n - thr) / w, 0), 1);
  return tt * tt * (3 - 2 * tt);
}

export function createCloudDeck(THREE, { sunDir, sunE, amb, noise }) {
  const MAX_SLICES = 6;
  const base = new THREE.CircleGeometry(60000, 64).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  const sl = new Float32Array(MAX_SLICES);
  for (let i = 0; i < MAX_SLICES; i++) sl[i] = i;
  geo.setAttribute('aSlice', new THREE.InstancedBufferAttribute(sl, 1));
  geo.instanceCount = 3;
  const tex = new THREE.DataTexture(noise.data, noise.size, noise.size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uSunDir: { value: sunDir.clone() }, uSunE: { value: new THREE.Vector3(...sunE) },
    uAmb: { value: new THREE.Vector3(...amb) }, uCamPos: { value: new THREE.Vector3() }, uGlow: { value: new THREE.Vector3() },
    uDeck: { value: new THREE.Vector4(1200, 500, 0.4, 0) }, uWind: { value: new THREE.Vector2(3.0, 0.8) },
    uSlices: { value: 3 }, uDark: { value: 0 }, uGlowXf: { value: new THREE.Vector4(0, 0, -10, -10) },
    uFarCol: { value: new THREE.Vector3(0.3, 0.3, 0.3) },   // the sky dome's overcast colour: the far deck blends into it
  }]);
  uniforms.uNoise = { value: tex };
  uniforms.uGlowMap = { value: null };
  const mat = new THREE.ShaderMaterial({
    name: 'sf-cloud-deck',
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute float aSlice;
      uniform vec3 uCamPos; uniform vec4 uDeck; uniform float uSlices;
      varying vec3 vWorld; varying float vHf;
      void main() {
        // far slice first: below the layer draw top → base, above it base → top
        float i = aSlice;
        float k = uSlices > 1.5 ? i / (uSlices - 1.0) : 0.0;
        float mid = uDeck.x + 0.5 * uDeck.y;
        float hf = uSlices > 1.5 ? (uCamPos.y < mid ? 1.0 - k : k) : (uCamPos.y < mid ? 0.0 : 1.0);   // one slice: the side we see
        vHf = hf;
        vec3 p = vec3(position.x + uCamPos.x, uDeck.x + hf * uDeck.y * 0.85, position.z + uCamPos.z);
        vWorld = p;
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uCamPos; uniform vec3 uGlow;
      uniform float uSlices; uniform float uDark; uniform vec3 uFarCol;
      varying vec3 vWorld; varying float vHf;
      ${DECK_GLSL}
      ${GLOW_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 ray = vWorld - uCamPos;
        float dist = length(ray);
        vec3 dir = ray / max(dist, 1.0);
        float d = sfDeckDens(vWorld.xz, vHf, uTime);
        // alpha of one slice so that N slices stack to the layer opacity; full cover: the base slice is opaque
        float a = d * (uDeck.z > 0.97 ? mix(1.0, 0.75, vHf) : mix(0.9, 0.6, vHf));
        a *= smoothstep(58000.0, 30000.0, dist) * smoothstep(0.0, 25.0, abs(vWorld.y - uCamPos.y));
        if (a < 0.004) discard;
        float n = sfDeckNoise(vWorld.xz * 1.7 + 311.0 - uWind * uTime);
        bool below = uCamPos.y < vWorld.y;
        float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0);
        vec3 lit;
        if (below) {
          // base: diffuse light through the layer; thicker/denser = darker, the lowest slice darkest
          float thick = uDeck.y / 800.0;
          float trans = exp(-(0.35 + 0.9 * uDark) * thick * (0.6 + 0.4 * d)) * (0.75 + 0.25 * n);
          lit = uSunE * (0.16 * trans * sunUp) + uAmb * (0.9 + 1.2 * trans) * (0.55 + 0.45 * vHf);
          float mu = dot(dir, uSunDir);
          lit += uSunE * pow(max(mu, 0.0), 10.0) * (1.0 - d) * 0.5 * sunUp;   // silver lining on thin edges
        } else {
          // tops: billows lit from the side (normal from the gradient of a finer noise), brighter crests
          vec2 tp = vWorld.xz - uWind * uTime;
          float t0 = sfTopN(tp), tx = sfTopN(tp + vec2(30.0, 0.0)), tz = sfTopN(tp + vec2(0.0, 30.0));
          vec3 bn = normalize(vec3(-(tx - t0) * 9.0, 1.0, -(tz - t0) * 9.0));
          float sunL = clamp(dot(bn, uSunDir) * 0.85 + 0.2, 0.0, 1.0);
          float shade = (0.5 + 0.5 * sunL) * (0.78 + 0.3 * t0);
          lit = uSunE * (0.3 * shade * (0.6 + 0.4 * vHf)) + uAmb * (1.25 + 0.5 * vHf + 0.4 * t0);
        }
        lit *= 1.0 - 0.45 * uDark;
        if (uGlow.r > 0.0005) lit += uGlow * sfCityGlow(vWorld.xz) * (below ? 1.0 : 0.45) * (0.7 + 0.3 * n);
        if (below) lit = mix(lit, uFarCol, smoothstep(22000.0, 52000.0, dist) * step(0.97, uDeck.z));   // seamless with the sky beyond the edge
        gl_FragColor = vec4(lit, clamp(a, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sf-cloud-deck';
  mesh.frustumCulled = false;
  mesh.renderOrder = 19;
  mesh.visible = false;
  const deck = { base: 1200, thick: 500, cover: 0.4, type: 0, wind: [3.0, 0.8] };
  return {
    mesh, uniforms, deck,
    /** { base, thick, cover, type: 0 cumulus | 1 stratus | 2 nimbostratus, dark 0..1 } or null (no deck). */
    set(p) {
      mesh.visible = !!p;
      if (!p) return;
      Object.assign(deck, { base: p.base, thick: p.thick, cover: p.cover, type: p.type });
      uniforms.uDeck.value.set(p.base, p.thick, p.cover, p.type);
      uniforms.uDark.value = p.dark || 0;
    },
    setSlices(n) { const v = Math.max(1, Math.min(MAX_SLICES, n)); geo.instanceCount = v; uniforms.uSlices.value = v; },
    /** Cloud density (0..1) at a world point (camera-in-cloud test). */
    densityAt(x, y, z, t) {
      if (!mesh.visible) return 0;
      const hf = (y - deck.base) / (deck.thick * 0.85);
      if (hf < -0.05 || hf > 1.05) return 0;
      return cloudDeckDensity(noise, deck, x, z, Math.min(Math.max(hf, 0), 1), t);
    },
    update(time, camera) {
      uniforms.uTime.value = time;
      uniforms.uCamPos.value.copy(camera.position);
    },
  };
}
