// W2 city: shared building material. The 4K facade/roof atlas (Cycles-rendered cells, see blender/city/facade_atlas.py)
// is split into texture-array layers so every cell tiles with hardware REPEAT and proper mipmaps; a MeshStandardMaterial
// is patched (onBeforeCompile) to sample albedo / (tint mask, roughness, window mask) / (normal xy, metalness) by the
// per-vertex layer index, apply the per-building tint through the tint mask and light windows at night.
import * as THREE from 'three';
import { assetData } from '../core/assets.js';

async function loadPixels(url, size) {
  const blob = await assetData(url, 'blob');
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, size, size);
  bmp.close?.();
  return g.getImageData(0, 0, size, size).data;
}

function toArrayTexture(pixels, meta, srgb, anisotropy) {
  const { grid, cell, size } = meta;
  const n = meta.layers.length;
  const data = new Uint8Array(cell * cell * 4 * n);
  const rowBytes = cell * 4;
  for (let l = 0; l < n; l++) {
    const gx = l % grid, gy = Math.floor(l / grid);
    for (let r = 0; r < cell; r++) {
      const src = ((gy * cell + r) * size + gx * cell) * 4;
      data.set(pixels.subarray(src, src + rowBytes), (l * cell + r) * rowBytes);
    }
  }
  const tex = new THREE.DataArrayTexture(data, cell, cell, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  // release the ~37 MB CPU copy once uploaded (anisotropy changes go straight to GL, see setAnisotropy)
  tex.onUpdate = () => { tex.image.data = null; tex.onUpdate = null; };
  return tex;
}

/** Change the anisotropic filtering of already-uploaded array textures without re-uploading them. */
export function setAnisotropy(renderer, textures, value) {
  if (!renderer) return;
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (!ext) return;
  const v = Math.max(1, Math.min(value, renderer.capabilities.getMaxAnisotropy()));
  for (const t of textures) {
    t.anisotropy = v;
    const wt = renderer.properties.get(t).__webglTexture;
    if (!wt) continue;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, wt);
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, v);
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  renderer.state.reset();
}

/** Loads the atlas and returns { material, uniforms, meta }. */
export async function createCityMaterial(renderer, base, anisotropy = null) {
  const meta = await assetData(base + 'atlas.json', 'json');
  const aniso = Math.min(anisotropy || 16, renderer?.capabilities?.getMaxAnisotropy?.() || 8);
  const [alb, mat, nrm] = await Promise.all(['albedo', 'mat', 'nrm'].map((k) => loadPixels(base + meta.images[k], meta.size)));
  const tAlbedo = toArrayTexture(alb, meta, true, aniso);
  const tMat = toArrayTexture(mat, meta, false, aniso);
  const tNrm = toArrayTexture(nrm, meta, false, aniso);
  const uniforms = {
    tCityAlbedo: { value: tAlbedo },
    tCityMat: { value: tMat },
    tCityNrm: { value: tNrm },
    uCityNight: { value: 0 },            // 0 = day, 1 = night (window lights)
    uCityNormalScale: { value: 1.0 },
  };
  const make = (far) => {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0, envMapIntensity: 1.0 });
  material.name = far ? 'city_atlas_far' : 'city_atlas';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aFacade;
attribute vec2 aLayer;
attribute vec4 aTint;
varying vec2 vFacade;
varying float vLayer;
varying float vSeed;
varying vec3 vTint;
varying vec3 vCityWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFacade = aFacade;
vLayer = aLayer.x;
vSeed = aLayer.y;
vTint = aTint.rgb;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tCityAlbedo;
uniform sampler2DArray tCityMat;
uniform sampler2DArray tCityNrm;
uniform float uCityNight;
uniform float uCityNormalScale;
varying vec2 vFacade;
varying float vLayer;
varying float vSeed;
varying vec3 vTint;
varying vec3 vCityWorld;
vec4 cityMat;
vec4 cityNrm;
float cityHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
vec3 cityUV = vec3(vFacade.x, -vFacade.y, floor(vLayer + 0.5));
vec4 cityAlb = texture(tCityAlbedo, cityUV);
cityMat = texture(tCityMat, cityUV);
cityNrm = texture(tCityNrm, cityUV);
vec3 cityTint = mix(vec3(1.0), vTint, cityMat.r);
diffuseColor.rgb *= cityAlb.rgb * cityTint;`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(cityMat.g, 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = cityNrm.b;`)
      .replace('#include <normal_fragment_maps>', far ? '' : `{
  vec2 nxy = cityNrm.rg * 2.0 - 1.0;
  float fade = uCityNormalScale * clamp(1.0 - length(vViewPosition) / 900.0, 0.0, 1.0);
  nxy *= fade;
  vec3 mapN = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(vFacade), st1 = dFdy(vFacade);
  vec3 N = normal;
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  if (fade > 0.001 && scale > 0.0) normal = normalize(mat3(T * scale, B * scale, N) * mapN);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (uCityNight > 0.0 && cityMat.b > 0.05) {
  float cell = cityHash(floor(vFacade * vec2(2.0, 4.0)) + vSeed * 91.7);
  float on = step(cell, cityMat.b * 0.7) * uCityNight;
  totalEmissiveRadiance += on * vec3(1.0, 0.78, 0.5) * 1.6 * cityAlb.rgb * 4.0;
}`);
  };
  material.customProgramCacheKey = () => (far ? 'city_atlas_far_v1' : 'city_atlas_v1');
  return material;
  };
  // near (L0): full shading incl. the atlas normal map; far (L1-L3, > 1.3 km): no normal-map TBN work
  const material = make(false), materialFar = make(true);
  return { material, materialFar, uniforms, meta, textures: [tAlbedo, tMat, tNrm] };
}

/** Rename the glTF attributes of a city tile geometry to the material's custom names. */
export function prepareCityGeometry(geo) {
  const ren = (from, to) => { const a = geo.getAttribute(from); if (a) { geo.setAttribute(to, a); geo.deleteAttribute(from); } };
  ren('uv', 'aFacade');
  ren('uv2', 'aLayer');
  ren('color', 'aTint');   // COLOR_0: normalized RGBA8 tint multiplier
  for (const k of Object.keys(geo.attributes)) if (/^color_\d|^_/.test(k)) geo.deleteAttribute(k);
}
