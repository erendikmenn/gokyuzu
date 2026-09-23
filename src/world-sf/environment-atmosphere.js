// W1: physically based atmosphere shared by the sky dome, the environment map and the aerial perspective of every
// material. One model (Rayleigh + background aerosol + a low marine haze layer + ozone, single scattering with a cheap
// multiple-scattering term) is evaluated three ways:
//   - numerically on the GPU into a sky-view LUT (sky dome + PMREM environment),
//   - analytically per fragment in three's shared shader chunks (aerial perspective for terrain, city, aircraft ...),
//   - numerically on the CPU for the sun color at the ground and the ambient color used by the chunk.
import * as THREE from 'three';

export const ATMO = {
  Rg: 6360e3,
  Rt: 6440e3,
  betaR: [5.802e-6, 13.558e-6, 33.1e-6], HR: 8000,
  betaMs: 3.2e-6, betaMe: 3.6e-6, HM: 1200,             // background aerosol
  betaHs: 1.6e-5, betaHe: 1.8e-5, HH: 650,              // SF marine boundary-layer haze (~60 km visibility)
  betaO: [0.65e-6, 1.881e-6, 0.085e-6],                  // ozone absorption (tent 10..40 km)
  g: 0.70,
  sunE: 3.4,                                             // sun irradiance at the top of the atmosphere (three.js units)
  ms: 0.55,                                              // multiple scattering gain (isotropic)
};

// ---------------------------------------------------------------- CPU helpers
function density(h) {
  const A = ATMO;
  return {
    r: Math.exp(-h / A.HR),
    m: Math.exp(-h / A.HM),
    hz: Math.exp(-h / A.HH),
    o: Math.max(0, 1 - Math.abs(h - 25000) / 15000),
  };
}

/** Transmittance from altitude h (m) toward direction with elevation sine mu to the top of the atmosphere. */
export function sunTransmittance(h, mu, steps = 64) {
  const A = ATMO;
  const r = A.Rg + h;
  // ray-sphere distance to the top
  const b = r * mu;
  const c = r * r - A.Rt * A.Rt;
  const t = -b + Math.sqrt(Math.max(0, b * b - c));
  const out = [0, 0, 0];
  const dt = t / steps;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const px = s * Math.sqrt(Math.max(0, 1 - mu * mu));
    const py = r + s * mu;
    const hs = Math.hypot(px, py) - A.Rg;
    const d = density(hs);
    for (let k = 0; k < 3; k++) out[k] += (A.betaR[k] * d.r + A.betaMe * d.m + A.betaHe * d.hz + A.betaO[k] * d.o) * dt;
  }
  return out.map((v) => Math.exp(-v));
}

// ---------------------------------------------------------------- GLSL: shared model
export function atmoGLSL() {
  const A = ATMO;
  const v3 = (a) => `vec3(${a.map((x) => x.toExponential(6)).join(',')})`;
  const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : x.toExponential(6));
  return /* glsl */`
#define ATM_RG ${f(A.Rg)}
#define ATM_RT ${f(A.Rt)}
const vec3 ATM_BR = ${v3(A.betaR)};
const vec3 ATM_BO = ${v3(A.betaO)};
#define ATM_HR ${f(A.HR)}
#define ATM_BMS ${f(A.betaMs)}
#define ATM_BME ${f(A.betaMe)}
#define ATM_HM ${f(A.HM)}
#define ATM_BHS ${f(A.betaHs)}
#define ATM_BHE ${f(A.betaHe)}
#define ATM_HH ${f(A.HH)}
#define ATM_G ${f(A.g)}
#define ATM_PI 3.14159265
float atmPhaseR(float mu) { return 3.0 / (16.0 * ATM_PI) * (1.0 + mu * mu); }
float atmPhaseM(float mu) {
  float g = ATM_G, g2 = g * g;
  return 3.0 / (8.0 * ATM_PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
`;
}

// ---------------------------------------------------------------- sky-view LUT pass
const LUT_W = 192, LUT_H = 128;

export function createSkyLUT(renderer) {
  const target = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uCamH: { value: 100 }, uSunE: { value: ATMO.sunE }, uHaze: { value: 1 } },
    vertexShader: /* glsl */`
      in vec3 position; out vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      in vec2 vUv; out vec4 outColor;
      uniform vec3 uSunDir; uniform float uCamH; uniform float uSunE; uniform float uHaze;
      ${atmoGLSL()}
      vec3 extinction(float h) {
        float dr = exp(-h / ATM_HR), dm = exp(-h / ATM_HM), dh = exp(-h / ATM_HH) * uHaze;
        float dox = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
        return ATM_BR * dr + vec3(ATM_BME * dm + ATM_BHE * dh) + ATM_BO * dox;
      }
      bool sphere(vec3 o, vec3 d, float R, out float t0, out float t1) {
        float b = dot(o, d), c = dot(o, o) - R * R, disc = b * b - c;
        if (disc < 0.0) return false;
        float s = sqrt(disc); t0 = -b - s; t1 = -b + s; return true;
      }
      vec3 sunT(vec3 p, vec3 s) {
        float t0, t1;
        if (sphere(p, s, ATM_RG, t0, t1) && t0 > 0.0) return vec3(0.0);
        sphere(p, s, ATM_RT, t0, t1);
        float dt = t1 / 12.0; vec3 od = vec3(0.0);
        for (int i = 0; i < 12; i++) { vec3 q = p + s * ((float(i) + 0.5) * dt); od += extinction(length(q) - ATM_RG) * dt; }
        return exp(-od);
      }
      void main() {
        float h = max(uCamH, 1.0);
        float r = ATM_RG + h;
        float horizon = -acos(clamp(ATM_RG / r, -1.0, 1.0));
        // v: 0..0.5 below the horizon, 0.5..1 above (squared toward the horizon for resolution)
        float el;
        if (vUv.y >= 0.5) { float c = (vUv.y - 0.5) * 2.0; el = horizon + c * c * (1.5707963 - horizon); }
        else { float c = (0.5 - vUv.y) * 2.0; el = horizon - c * c * (horizon + 1.5707963); }
        float az = vUv.x * ATM_PI;   // azimuth relative to the sun (symmetric)
        float sunEl = asin(clamp(uSunDir.y, -1.0, 1.0));
        vec3 sun = vec3(cos(sunEl), sin(sunEl), 0.0);
        vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
        vec3 o = vec3(0.0, r, 0.0);
        float t0, t1, tMax;
        sphere(o, dir, ATM_RT, t0, t1); tMax = t1;
        bool ground = false;
        if (sphere(o, dir, ATM_RG, t0, t1) && t0 > 0.0) { tMax = t0; ground = true; }
        tMax = min(tMax, 400000.0);
        float mu = dot(dir, sun);
        float pr = atmPhaseR(mu), pm = atmPhaseM(mu);
        vec3 L = vec3(0.0), T = vec3(1.0);
        const int N = 40;
        float prevT = 0.0;
        for (int i = 0; i < N; i++) {
          float f = (float(i) + 1.0) / float(N);
          float tt = tMax * f * f;
          float dt = tt - prevT; float tm = (tt + prevT) * 0.5; prevT = tt;
          vec3 p = o + dir * tm;
          float hs = length(p) - ATM_RG;
          float dr = exp(-hs / ATM_HR), dm = exp(-hs / ATM_HM), dh = exp(-hs / ATM_HH) * uHaze;
          vec3 sR = ATM_BR * dr; float sM = ATM_BMS * dm + ATM_BHS * dh;
          vec3 ext = extinction(hs);
          vec3 up = normalize(p);
          vec3 Ts = sunT(p, sun);
          vec3 S = uSunE * Ts;
          // single scattering + isotropic multiple-scattering approximation (lit by sun and sky)
          vec3 scat = (sR * pr + sM * pm) * S + (sR + sM) * (S * ${ATMO.ms.toFixed(3)} * 0.25 / ATM_PI + uSunE * 0.012 * max(dot(up, sun) + 0.2, 0.0));
          vec3 Tstep = exp(-ext * dt);
          L += T * scat * (1.0 - Tstep) / max(ext, vec3(1e-9));
          T *= Tstep;
        }
        if (ground) {
          vec3 p = o + dir * tMax;
          vec3 n = normalize(p);
          vec3 Ts = sunT(p + n * 2.0, sun);
          vec3 albedo = vec3(0.075, 0.085, 0.08);
          L += T * albedo / ATM_PI * (uSunE * Ts * max(dot(n, sun), 0.0) + uSunE * 0.18);
        }
        outColor = vec4(L, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    texture: target.texture,
    uniforms: mat.uniforms,
    render() {
      const prev = renderer.getRenderTarget();
      const xr = renderer.xr.enabled; renderer.xr.enabled = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
      renderer.xr.enabled = xr;
    },
  };
}

// GLSL to sample the LUT for a world direction (used by the sky dome)
export const SKY_LUT_SAMPLE = /* glsl */`
vec3 sampleSkyLUT(sampler2D lut, vec3 dir, vec3 sunDir, float camH) {
  float r = ATM_RG + max(camH, 1.0);
  float horizon = -acos(clamp(ATM_RG / r, -1.0, 1.0));
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float v;
  if (el >= horizon) v = 0.5 + 0.5 * sqrt(clamp((el - horizon) / (1.5707963 - horizon), 0.0, 1.0));
  else v = 0.5 - 0.5 * sqrt(clamp((horizon - el) / (horizon + 1.5707963), 0.0, 1.0));
  vec2 a = normalize(dir.xz + vec2(1e-6, 0.0)), b = normalize(sunDir.xz + vec2(1e-6, 0.0));
  float u = acos(clamp(dot(a, b), -1.0, 1.0)) / 3.14159265;
  return texture(lut, vec2(u, v)).rgb;
}
`;

// ---------------------------------------------------------------- aerial perspective chunk patch
/**
 * Shared atmosphere state for every material with fog:true (time & weather change it live, no recompiles).
 * Uploaded as `uniform vec4 sfAtm[6]` (one Float32Array shared by reference by all materials):
 *   [0] key light direction (sun by day, moon at night) xyz, night factor (0 day … 1 night)
 *   [1] key light irradiance at the ground (rgb) — scatters in the haze
 *   [2] ambient (sky) irradiance (rgb) — isotropic in-scatter
 *   [3] in-layer fog/cloud colour (rgb), extinction inside the layer (1/m)
 *   [4] camera inside a fog/cloud layer (0..1), layer top above the camera (m), layer bottom below the camera (m), -
 *   [5] rain/wetness (0..1), -, -, -
 */
export const SF_ATM = new Float32Array(24);

/**
 * Replace three's fog chunks so every material with fog:true gets physically based aerial perspective, applied in
 * linear HDR right before tone mapping. scene.fog is a THREE.Fog used as a parameter block: fog.near = marine haze
 * multiplier (1 = default), fog.far = animation time (s). Everything else comes from SF_ATM (see above), which is
 * registered as a uniform of every built-in material and of THREE.UniformsLib.fog (custom ShaderMaterials that merge it).
 * Call once, before any material is compiled.
 */
export function patchAerialPerspective() {
  if (THREE.UniformsLib.fog.sfAtm) return;
  THREE.UniformsLib.fog.sfAtm = { value: SF_ATM };
  for (const k of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[k].uniforms;
    if (u && u.fogColor && !u.sfAtm) u.sfAtm = { value: SF_ATM };   // cloned per material; the Float32Array stays shared
  }
  const C_ = THREE.ShaderChunk;
  C_.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif
`;
  C_.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif
`;
  C_.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  #define SF_AERIAL 1
  uniform vec3 fogColor;
  uniform vec4 sfAtm[6];
  varying float vFogDepth;
  varying vec3 vFogView;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${atmoGLSL()}
  #ifdef FOG_EXP2
    #define SF_TIME 0.0
  #else
    #define SF_TIME fogFar
  #endif
  #define SF_SUN_DIR sfAtm[0].xyz
  #define SF_NIGHT sfAtm[0].w
  #define SF_SUN_E sfAtm[1].rgb
  #define SF_AMB sfAtm[2].rgb
  #define SF_FOG_COL sfAtm[3].rgb
  #define SF_FOG_K sfAtm[3].w
  #define SF_WET sfAtm[5].x
  float sfOD(float h0, float h1, float D, float dy, float H) {
    float x = D * dy;
    if (abs(x) < 1e-3 * H) return D * exp(-0.5 * (h0 + h1) / H);
    return (exp(-h0 / H) - exp(-h1 / H)) * H / dy;
  }
  vec3 sfAerial(vec3 col) {
    vec3 ray = vFogView * mat3(viewMatrix);
    float D = length(ray);
    if (D < 0.5) return col;
    vec3 dir = ray / D;
    float h0 = max(cameraPosition.y, -5.0);
    float h1 = max(h0 + ray.y, -5.0);
    float dy = dir.y;
    #ifdef FOG_EXP2
      float haze = fogDensity;
    #else
      float haze = fogNear;
    #endif
    float odR = sfOD(h0, h1, D, dy, ATM_HR);
    float odM = sfOD(h0, h1, D, dy, ATM_HM);
    float odH = sfOD(h0, h1, D, dy, ATM_HH) * haze;
    // inside a fog bank / cloud layer: the ray leaves it through the layer top (up) or bottom (down); the part of the
    // path inside the layer is covered by the layer's own scattering, so the haze only acts on the rest
    vec4 lay = sfAtm[4];
    if (lay.x > 0.001) {
      float tExit = dy > 1e-3 ? lay.y / dy : (dy < -1e-3 ? lay.z / -dy : 1e9);
      float a = (1.0 - exp(-SF_FOG_K * min(D, tExit))) * lay.x;
      col = mix(col, SF_FOG_COL, a);
      float keep = 1.0 - a;
      odR *= keep; odM *= keep; odH *= keep;
    }
    vec3 tau = ATM_BR * odR + vec3(ATM_BME * odM + ATM_BHE * odH);
    float mu = dot(dir, SF_SUN_DIR);
    vec3 sR = ATM_BR * odR;
    float sM = ATM_BMS * odM + ATM_BHS * odH;
    vec3 inscat = (sR * atmPhaseR(mu) + sM * atmPhaseM(mu)) * SF_SUN_E + (sR + sM) * SF_AMB;
    vec3 T = exp(-tau);
    return col * T + (1.0 - T) * inscat / max(tau, vec3(1e-9));
  }
#endif
`;
  // applied in tonemapping_fragment (linear HDR, before tone mapping); fog_fragment is a fallback for custom shaders that
  // include the fog chunks but not tonemapping_fragment
  C_.fog_fragment = /* glsl */`
#if defined( USE_FOG ) && defined( SF_AERIAL ) && !defined( SF_AERIAL_DONE )
  gl_FragColor.rgb = sfAerial( gl_FragColor.rgb );
#endif
`;
  C_.tonemapping_fragment = /* glsl */`
#if defined( USE_FOG ) && defined( SF_AERIAL )
  gl_FragColor.rgb = sfAerial( gl_FragColor.rgb );
  #define SF_AERIAL_DONE 1
#endif
#if defined( TONE_MAPPING )
  gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif
`;
}
