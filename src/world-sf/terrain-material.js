// W1: terrain + water material. A MeshStandardMaterial per tile (so three's lights, SunLight cascades, environment
// map, log depth and the aerial-perspective chunk all apply) patched with onBeforeCompile:
//   - diffuse = aerial photo (alpha = land coverage); water where alpha -> 0 (bay, ocean, lakes)
//   - water: procedural multi-scale wave normals, low roughness (sun glitter + sky reflection with fresnel via the PMREM
//     environment), subsurface color from real bathymetry (assets/sf/terrain/water_depth.png), shore foam/turbidity
// All tiles share one GPU program (customProgramCacheKey).
import * as THREE from 'three';

/** Tileable wave slope texture (RG = d h/dx, d h/dz), from a sum of directional waves with integer wave numbers. */
export function createWaveTexture(size = 256, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const waves = [];
  const wind = -0.35;   // radians: dominant travel direction (roughly from the WNW)
  for (let k = 0; k < 42; k++) {
    const mag = 1 + Math.floor(Math.pow(rnd(), 1.6) * 22);
    const ang = wind + (rnd() - 0.5) * (k < 20 ? 1.3 : 3.2);
    const kx = Math.round(Math.cos(ang) * mag), ky = Math.round(Math.sin(ang) * mag);
    if (kx === 0 && ky === 0) continue;
    const len = Math.hypot(kx, ky);
    const amp = 1 / Math.pow(len, 1.25);
    waves.push({ kx, ky, amp, ph: rnd() * Math.PI * 2 });
  }
  const dx = new Float32Array(size * size), dy = new Float32Array(size * size);
  let maxs = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sx = 0, sy = 0;
    for (const w of waves) {
      const a = 2 * Math.PI * (w.kx * x + w.ky * y) / size + w.ph;
      // sharpened crests: derivative of a trochoid-ish profile
      const c = Math.cos(a);
      const d = c * (1 + 0.35 * Math.sin(a));
      sx += w.amp * w.kx * d;
      sy += w.amp * w.ky * d;
    }
    dx[y * size + x] = sx; dy[y * size + x] = sy;
    maxs = Math.max(maxs, Math.abs(sx), Math.abs(sy));
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(127.5 + 127 * dx[i] / maxs);
    data[i * 4 + 1] = Math.round(127.5 + 127 * dy[i] / maxs);
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createTerrainShared({ depthTex, waveTex, detailTex, rootMinX, rootMinZ }) {
  return {
    uDetailTex: { value: detailTex },
    uTime: { value: 0 },
    uWaveTex: { value: waveTex },
    uDepthTex: { value: depthTex },
    uDepthXform: { value: new THREE.Vector4(1 / (32 * 4096), 1 / (32 * 4096), -rootMinX / (32 * 4096) + 0.5 / 4096, -rootMinZ / (32 * 4096) + 0.5 / 4096) },
    uLand: { value: new THREE.Vector4(1.0, 1.0, 1.0, 1.1) },   // rgb gain, saturation
    uWaterDeep: { value: new THREE.Color(0.010, 0.027, 0.033) },
    uWaterShallow: { value: new THREE.Color(0.050, 0.066, 0.052) },
    uWaterOcean: { value: new THREE.Color(0.007, 0.024, 0.044) },
    uWaveScale: { value: 1.0 },
    uLandSpec: { value: 0.3 },
    uSunVisOn: { value: 0 },
    uDebug: { value: 0 },
    // time & weather (src/world-sf/lights.js): ground light map at night (street light pools, road glow)
    uNightMap: { value: null },
    uNightXf: { value: new THREE.Vector4(0, 0, -10, -10) },   // uv = xz * xy + zw (outside [0,1] = no light)
    uNightGain: { value: 0 },
  };
}

const VERT_PARS = /* glsl */`
uniform vec4 uImgXform;
uniform float uMorph;
attribute float parentY;
attribute float sunVis;
varying float vSunVis;
varying vec2 vSfUv;
varying vec3 vSfWorld;
`;
const VERT_MAIN = /* glsl */`
vSunVis = sunVis;
vSfUv = position.xz * uImgXform.xy + uImgXform.zw;
vSfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_PARS = /* glsl */`
uniform sampler2D uImg;
uniform vec4 uTile;   // x = vertex spacing (m), y = imagery texel size (m)
uniform sampler2D uWaveTex;
uniform sampler2D uDepthTex;
uniform sampler2D uDetailTex;
uniform vec4 uDepthXform;
uniform vec4 uLand;
uniform vec3 uWaterDeep;
uniform vec3 uWaterShallow;
uniform vec3 uWaterOcean;
uniform float uTime;
uniform float uWaveScale;
uniform float uLandSpec;
uniform float uSunVisOn;
uniform float uDebug;
uniform sampler2D uNightMap;
uniform vec4 uNightXf;
uniform float uNightGain;
varying float vSunVis;
varying vec2 vSfUv;
varying vec3 vSfWorld;
float sfLandA;
float sfShore;
float sfDist;
vec3 sfWaterN;
const mat2 SF_R1 = mat2(0.8776, 0.4794, -0.4794, 0.8776);
const mat2 SF_R2 = mat2(0.4536, -0.8912, 0.8912, 0.4536);
const mat2 SF_R3 = mat2(-0.6663, 0.7457, -0.7457, -0.6663);
#ifndef SF_WATER
  #define SF_WATER 2
#endif
vec2 sfWaveSlope(vec2 p, float dist) {
  vec2 s = vec2(0.0);
#if SF_WATER >= 1
  // regional choppiness variation breaks up any visible repetition
  float region = texture2D(uWaveTex, p / 2900.0).b;
  float region2 = texture2D(uWaveTex, SF_R2 * p / 1100.0 + 0.37).b;
#else
  float region = 0.5, region2 = 0.5;
#endif
  s += SF_R1 * (texture2D(uWaveTex, SF_R1 * p / 67.0 + uTime * vec2(0.012, 0.007)).xy - 0.5) * (0.6 + 0.8 * region);
  s += SF_R2 * (texture2D(uWaveTex, SF_R2 * p / 23.3 + uTime * vec2(-0.021, 0.029)).xy - 0.5) * (0.4 + 0.6 * region2) * (1.0 - smoothstep(900.0, 3500.0, dist));
#if SF_WATER >= 1
  s += SF_R3 * (texture2D(uWaveTex, SF_R3 * p / 241.0 + uTime * vec2(0.0041, -0.0019)).xy - 0.5) * 0.7;
#endif
#if SF_WATER >= 2
  s += (texture2D(uWaveTex, p / 7.9 + uTime * vec2(0.06, 0.04)).xy - 0.5) * 0.35 * (1.0 - smoothstep(60.0, 350.0, dist));
#endif
  return s * 0.6 * uWaveScale;
}
`;

// replaces <map_fragment>
const FRAG_MAP = /* glsl */`
{
  vec4 img = texture2D(uImg, vSfUv);
  // sharpen the 1 m coastline when magnified, keep coverage when minified
  float texels = length(fwidth(vSfUv * 512.0));
  float a = img.a;
  a = mix(a, smoothstep(0.25, 0.75, a), clamp(1.0 - texels, 0.0, 1.0));
  // water only on (near) flat faces: seawalls / banks between a water vertex and a land vertex are land. The allowed
  // slope grows with the tile's vertex spacing so coarse distant tiles keep the imagery coastline.
  vec3 fn = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);   // interpolated vertex normal, world space
  float faceSlope = length(fn.xz) / max(abs(fn.y), 1e-3);
  float maxSlope = 0.2 + uTile.x * 0.035;
  a = max(a, smoothstep(maxSlope, maxSlope * 1.8, faceSlope));
  sfLandA = a;
  vec3 land = img.rgb * uLand.rgb;
  float l = dot(land, vec3(0.2126, 0.7152, 0.0722));
  land = max(mix(vec3(l), land, uLand.a), 0.0);
  sfDist = length(vSfWorld - cameraPosition);
  // close-range ground detail: fine grain + metre-scale variation break up the magnified 1 m photo
  float dfade = 1.0 - smoothstep(80.0, 600.0, sfDist);
  if (SF_WATER >= 1 && dfade > 0.0) {
    float g1 = texture2D(uDetailTex, vSfWorld.xz / 23.0).r;
    float g2 = texture2D(uDetailTex, vSfWorld.xz / 97.0 + 0.31).g;
    land *= 1.0 + ((g1 - 0.5) * 0.45 + (g2 - 0.5) * 0.35) * dfade;
  }

  // water
  vec2 dUv = vSfWorld.xz * uDepthXform.xy + uDepthXform.zw;
  vec2 dEnc = texture2D(uDepthTex, dUv).rg;
  float depth = dEnc.r * dEnc.r * 60.0;
  float shoreDist = dEnc.g * dEnc.g * 2000.0;              // global distance to shore (m), smooth at 32 m/texel
  sfShore = smoothstep(160.0, 0.0, shoreDist) * (1.0 - a);
  // Pacific side: west of the SF/Peninsula coast south of Lands End, west of the bridge in the Golden Gate strait
  float coastX = vSfWorld.z > -21200.0 ? -11100.0 : -9700.0;
  float ocean = smoothstep(coastX + 500.0, coastX - 900.0, vSfWorld.x);
  vec3 deep = mix(uWaterDeep, uWaterOcean, ocean);
  vec3 wcol = mix(uWaterShallow, deep, smoothstep(0.5, 14.0, depth));
  wcol = mix(wcol, uWaterShallow * 1.35, sfShore * 0.6);
  vec2 slope = sfWaveSlope(vSfWorld.xz, sfDist);
  float fade = 1.0 - smoothstep(800.0, 12000.0, sfDist) * 0.6;
  slope *= fade * mix(0.55, 1.0, smoothstep(0.5, 6.0, depth)) * mix(0.35, 1.0, 1.0 - smoothstep(0.4, 1.2, abs(vSfWorld.y)));
  sfWaterN = normalize(vec3(-slope.x, 1.0, -slope.y));
  // keep the mirror direction above the horizon (a facet reflecting downward would see more water, not dark ground)
  vec3 Vw = normalize(cameraPosition - vSfWorld);
  float ry = reflect(-Vw, sfWaterN).y;
  sfWaterN = normalize(mix(sfWaterN, vec3(0.0, 1.0, 0.0), clamp((0.06 - ry) * 6.0, 0.0, 1.0)));
  // thin swash line at the waterline + breaking surf on the exposed Pacific beaches: bands follow the iso-lines of a
  // ~160 m blurred land coverage (parallel to the coast) and travel shoreward
  float seaLvl = 1.0 - smoothstep(0.4, 1.2, abs(vSfWorld.y));   // lakes/lagoons above sea level: calm, no surf
  float foamN = texture2D(uWaveTex, vSfWorld.xz / 31.0 + uTime * vec2(0.013, 0.021)).b;
  float swash = smoothstep(0.45, 0.02, 1.0 - img.a) * (1.0 - a);
  float surfZone = ocean * smoothstep(280.0, 40.0, shoreDist) * smoothstep(11.0, 1.5, depth) * (1.0 - a);
#if SF_WATER >= 1
  float sets = texture2D(uWaveTex, vSfWorld.xz / 610.0 + vec2(0.37, uTime * 0.0015)).b;   // breaking sections vary along the shore
  float crest = smoothstep(0.74, 0.97, sin(shoreDist * 0.075 + uTime * 0.55 + foamN * 1.6 + sets * 4.0) * 0.5 + 0.5) * smoothstep(0.3, 0.62, sets);
  float surf = surfZone * (crest * 0.85 + 0.5 * smoothstep(100.0, 15.0, shoreDist)) * smoothstep(0.25, 0.7, foamN + 0.15);
#else
  float surf = surfZone * 0.35 * smoothstep(100.0, 15.0, shoreDist);
#endif
  float foam = (swash * 0.6 * smoothstep(0.3, 0.7, foamN) + surf) * seaLvl;
  wcol = mix(wcol, vec3(0.62), clamp(foam, 0.0, 1.0) * 0.85);
  #ifdef SF_WET
    land *= 1.0 - 0.28 * SF_WET;   // time & weather: wet ground is darker
  #endif
  diffuseColor.rgb = mix(wcol, land, sfLandA);
  if (uDebug > 0.5) {
    float dv = uDebug < 1.5 ? ocean : uDebug < 2.5 ? shoreDist / 500.0 : uDebug < 3.5 ? depth / 20.0 : uDebug < 4.5 ? surfZone : uDebug < 5.5 ? sfShore : uDebug < 6.5 ? vSunVis
      : uDebug < 7.5 ? sfLandA : uDebug < 8.5 ? uTile.x / 32.0 : uDebug < 9.5 ? img.a * 10.0 : abs(vSfWorld.y) * 0.5;
    diffuseColor.rgb = vec3(dv);
  }
}
`;

const FRAG_ROUGH = /* glsl */`
float roughnessFactor = roughness;
{
  float wr = mix(0.05, 0.24, smoothstep(200.0, 7000.0, sfDist));
  float lr = roughness;
  #ifdef SF_WET
    lr = mix(roughness, 0.42, SF_WET);   // time & weather: wet ground has a sheen
  #endif
  roughnessFactor = mix(wr, lr, sfLandA);
}
`;
// time & weather: street lights seen from above (light pools + road glow) from the ground light map, land only
const FRAG_NIGHT = /* glsl */`
if (uNightGain > 0.0) {
  vec2 nuv = vSfWorld.xz * uNightXf.xy + uNightXf.zw;
  if (nuv.x > 0.0 && nuv.x < 1.0 && nuv.y > 0.0 && nuv.y < 1.0) {
    vec2 nl = texture2D(uNightMap, nuv).rg;
    nl = nl * nl * 1.6;
    // near the camera the lamp sprites and their pools carry the street; the blurred map fades back
    totalEmissiveRadiance += (nl.r * vec3(1.0, 0.86, 0.66) + nl.g * vec3(1.0, 0.52, 0.16)) * uNightGain * sfLandA * mix(0.4, 1.0, smoothstep(150.0, 1400.0, sfDist));
  }
}
`;

const FRAG_NORMAL = /* glsl */`
{
  vec3 wn = normalize((viewMatrix * vec4(sfWaterN, 0.0)).xyz);
  normal = normalize(mix(wn, normal, sfLandA));
}
`;

// land: photo already contains the surface's look -> weak, non-fresnel-boosted specular; water: F0 = 0.02
const FRAG_SPEC = /* glsl */`
material.specularColor = mix(vec3(0.02), vec3(0.04 * uLandSpec), sfLandA);
material.specularColorBlended = material.specularColor;
material.specularF90 = mix(1.0, uLandSpec, sfLandA);
`;

// three's lights_fragment_begin with the baked terrain sun visibility applied to the sun (and directional) lights only
const LIGHTS_BEGIN_SUNVIS = THREE.ShaderChunk.lights_fragment_begin
  .replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= mix( 1.0, vSunVis, uSunVisOn );')
  .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= mix( 1.0, vSunVis, uSunVisOn );');

let _id = 0;
/** One material per tile; `tile` = { uImg: {value}, uImgXform: {value: Vector4} }. */
const WATER_LEVEL = { simple: 0, medium: 1, high: 2 };
export const terrainMaterialState = { water: 2 };
/** 'simple' | 'medium' | 'high' → applied to materials created afterwards; returns true if it changed. */
export function setTerrainWaterQuality(w) {
  const v = WATER_LEVEL[w] ?? 2;
  if (v === terrainMaterialState.water) return false;
  terrainMaterialState.water = v;
  return true;
}
export function applyWaterDefine(m) {
  m.defines = m.defines || {};
  if (m.defines.SF_WATER !== terrainMaterialState.water) { m.defines.SF_WATER = terrainMaterialState.water; m.needsUpdate = true; }
}

export function createTerrainMaterial(shared, tile) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0, color: 0xffffff });
  m.name = 'sf-terrain';
  m.defines = { SF_WATER: terrainMaterialState.water };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, tile);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y = mix(parentY, transformed.y, uMorph);')
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_MAIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + FRAG_SPEC)
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN_SUNVIS)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_NIGHT);
  };
  m.customProgramCacheKey = () => 'sf-terrain-5';   // defines (SF_WATER) are part of three's program key
  m.userData.sfId = _id++;
  return m;
}
