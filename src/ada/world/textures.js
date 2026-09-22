// Procedurally generated textures (no image files).
import * as THREE from 'three';
import { tileableFbm, mulberry32 } from './noise.js';

function dataTex(data, size, { srgb = false, repeat = true, anisotropy = 8 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Terrain detail: R = medium grain, G = large blotches, B = fine grain, A = "rock strata" noise. */
export function makeDetailTexture(renderer) {
  const S = 512;
  const r = tileableFbm(S, 8, 5, 11, 0.55);
  const g = tileableFbm(S, 3, 4, 23, 0.5);
  const b = tileableFbm(S, 32, 3, 37, 0.6);
  const a = tileableFbm(S, 16, 4, 51, 0.5);
  const data = new Uint8Array(S * S * 4);
  const stretch = (v) => Math.max(0, Math.min(1, (v - 0.5) * 2.2 + 0.5));
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = stretch(r[i]) * 255;
    data[i * 4 + 1] = stretch(g[i]) * 255;
    data[i * 4 + 2] = stretch(b[i]) * 255;
    data[i * 4 + 3] = stretch(a[i]) * 255;
  }
  return dataTex(data, S, { anisotropy: renderer ? renderer.capabilities.getMaxAnisotropy() : 8 });
}

/** Tileable water normal map (tangent space, xy in RG, z in B). */
export function makeWaterNormalTexture() {
  const S = 256;
  const h = tileableFbm(S, 8, 5, 77, 0.5);
  const h2 = tileableFbm(S, 4, 3, 91, 0.5);
  const H = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) H[i] = h[i] * 0.7 + h2[i] * 0.3;
  const data = new Uint8Array(S * S * 4);
  const k = 6.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xl = H[y * S + ((x - 1 + S) % S)], xr = H[y * S + ((x + 1) % S)];
      const yu = H[((y - 1 + S) % S) * S + x], yd = H[((y + 1) % S) * S + x];
      let nx = (xl - xr) * k, ny = (yu - yd) * k, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * S + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return dataTex(data, S);
}

/** Soft cumulus puff atlas: 2×2 variants, white RGB with alpha. */
export function makeCloudTexture() {
  const S = 256, cells = 2, C = S / cells;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const rand = mulberry32(4242);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const ox = cx * C, oy = cy * C;
      // Many overlapping soft blobs clustered around the center → fluffy, irregular silhouette.
      const n = 26;
      for (let k = 0; k < n; k++) {
        const ang = rand() * Math.PI * 2;
        const rad = Math.pow(rand(), 0.8) * C * 0.22;
        const px = ox + C / 2 + Math.cos(ang) * rad;
        const py = oy + C / 2 + Math.sin(ang) * rad * 0.85;
        const r = C * (0.1 + rand() * 0.16);
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        const a = 0.18 + rand() * 0.14;
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.35, `rgba(255,255,255,${a * 0.8})`);
        g.addColorStop(0.65, `rgba(255,255,255,${a * 0.35})`);
        g.addColorStop(0.85, `rgba(255,255,255,${a * 0.1})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Fade to zero at the cell borders so neighbors never bleed.
  const img = ctx.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lx = (x % C) / C - 0.5, ly = (y % C) / C - 0.5;
      const d = Math.hypot(lx, ly) * 2;
      const f = Math.max(0, Math.min(1, (1 - d) / 0.25));
      const i = (y * S + x) * 4;
      img.data[i + 3] = Math.min(255, img.data[i + 3] * 1.35 * f);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.premultiplyAlpha = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Asphalt grain (sRGB color map, tiles every few meters). */
export function makeAsphaltTexture(renderer) {
  const S = 256;
  const n1 = tileableFbm(S, 32, 3, 131, 0.6);
  const n2 = tileableFbm(S, 4, 3, 137, 0.5);
  const rand = mulberry32(99);
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    let v = 0.3 + (n1[i] - 0.5) * 0.12 + (n2[i] - 0.5) * 0.08 + (rand() - 0.5) * 0.06;
    if (rand() < 0.02) v += 0.12; // light aggregate specks
    const c = Math.max(0, Math.min(1, v)) * 255;
    data[i * 4] = c; data[i * 4 + 1] = c; data[i * 4 + 2] = c * 1.02; data[i * 4 + 3] = 255;
  }
  return dataTex(data, S, { srgb: true, anisotropy: renderer ? renderer.capabilities.getMaxAnisotropy() : 8 });
}

/** Runway designator glyphs: left half "36", right half "18" (white on transparent). */
export function makeRunwayNumbersTexture() {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [i, label] of [[0, '36'], [1, '18']]) {
    ctx.save();
    ctx.translate(W / 4 + i * (W / 2), H / 2);
    ctx.scale(0.6, 1.0);                      // tall, narrow runway font
    ctx.font = 'bold 500px "Helvetica Neue", Helvetica, Arial, sans-serif';
    // Wide letter spacing: draw each digit separately.
    ctx.fillText(label[0], -190, 22);
    ctx.fillText(label[1], 190, 22);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Facade texture for buildings: tile = one window bay (3 m × 3 m). Top-left 1/8 is plain wall. */
export function makeFacadeTexture() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  // subtle plaster noise
  const rand = mulberry32(5);
  for (let i = 0; i < 900; i++) {
    const v = 235 + Math.floor(rand() * 20);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rand() * S, rand() * S, 2, 2);
  }
  // window
  ctx.fillStyle = '#3d4a57';
  ctx.fillRect(S * 0.3, S * 0.3, S * 0.4, S * 0.42);
  ctx.fillStyle = '#6f8294';
  ctx.fillRect(S * 0.32, S * 0.32, S * 0.17, S * 0.18);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(S * 0.28, S * 0.72, S * 0.44, S * 0.04); // sill
  // wooden shutters (Mediterranean look)
  ctx.fillStyle = '#9a8f80';
  ctx.fillRect(S * 0.2, S * 0.3, S * 0.09, S * 0.42);
  ctx.fillRect(S * 0.71, S * 0.3, S * 0.09, S * 0.42);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Terrain heights → half-float texture used by the water shader for depth-based color/foam. */
export function makeHeightTexture(heights, V) {
  const data = new Uint16Array(V * V);
  for (let i = 0; i < V * V; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  const tex = new THREE.DataTexture(data, V, V, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;      // rows of V half-floats are not 4-byte aligned
  tex.needsUpdate = true;
  return tex;
}

/** A V×V Uint8 mask (one value per terrain grid vertex) as a single-channel texture. */
export function makeMaskTexture(mask, V) {
  const tex = new THREE.DataTexture(mask, V, V, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
