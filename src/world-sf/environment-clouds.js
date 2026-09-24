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
    uFade: { value: new THREE.Vector2(76000, 40000) },   // distance fade (start of nothing, full): inside the far plane
  }]);
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
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunE; uniform vec3 uAmb; uniform vec3 uCamPos; uniform vec2 uFade;
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
        return clamp((base + det * 0.6 - (1.0 - 0.22 * cov)) * 3.2, 0.0, 1.0);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vWorld.xz;
        vec3 ray = vWorld - uCamPos;
        float dist = length(ray);
        vec3 dir = ray / max(dist, 1.0);
        // distance / grazing fade first: where it alone leaves nothing (a <= fade), skip the noise (same result)
        float fade = smoothstep(uFade.x, uFade.y, dist) * smoothstep(0.0, 0.035, abs(dir.y));
        if (fade < 0.003) discard;
        float d = sfCloudDens(p, uTime);
        vec2 q = vec2(dot(p, vec2(0.93, 0.37)) / 9000.0, dot(p, vec2(-0.37, 0.93)) / 2200.0);
        float ci = smoothstep(0.63, 0.88, sfFbm3(q + uTime * 0.0004)) * 0.3 * smoothstep(0.45, 0.7, sfVNoise(p / 30000.0 + 1.1));
        float a = clamp(d * 0.95 + ci, 0.0, 1.0) * fade;
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
      uniforms.uFade.value.set(Math.min(76000, camera.far * 0.95), Math.min(40000, camera.far * 0.5));
      mesh.position.set(camera.position.x, CLOUD_H, camera.position.z);
    },
  };
}
