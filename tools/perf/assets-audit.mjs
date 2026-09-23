#!/usr/bin/env node
// Static asset audit (no browser): bytes per asset family, glTF encoding (Draco / meshopt / KTX2 / quantization),
// embedded image formats and sizes, the GPU memory those textures take uncompressed (RGBA8 + mips) vs. as GPU block
// compression (BC7/ASTC 4x4 = 1 B/texel, BC1/ETC2-RGB = 0.5 B/texel), and what Brotli / gzip would save on each binary
// type (sampled files; terrain height tiles sampled as the 9.5 KB ranges the game requests).
// usage: node tools/perf/assets-audit.mjs [--root <repo or worktree>] [--samples 40]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { arg, save } from './lib.mjs';

const root = path.resolve(arg('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')));
const samples = Number(arg('--samples', 40));
const A = (p) => path.join(root, p);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || ['bake', 'build', 'render', 'raw', 'src', 'tex', 'candidates', 'before', 'dev', 'ref'].includes(e.name) && e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (!/\.(blend\d?|py|log|exr|tif)$/i.test(e.name)) out.push(p);
  }
  return out;
}
function imgDims(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { fmt: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length) { if (b[o] !== 0xff) { o++; continue; } const m = b[o + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { fmt: 'jpeg', h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) }; o += 2 + b.readUInt16BE(o + 2); }
    return { fmt: 'jpeg', w: 0, h: 0 };
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const c = b.toString('ascii', 12, 16);
    if (c === 'VP8 ') return { fmt: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (c === 'VP8L') { const v = b.readUInt32LE(21); return { fmt: 'webp', w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (c === 'VP8X') return { fmt: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (b.toString('ascii', 1, 5) === 'KTX ') return { fmt: 'ktx2', w: b.readUInt32LE(20), h: b.readUInt32LE(24) };
  return { fmt: '?', w: 0, h: 0 };
}
function glbInfo(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) return null;
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.toString('utf8', 20, 20 + jl));
  const binStart = 20 + jl + 8;
  let tris = 0, verts = 0;
  for (const m of j.meshes || []) for (const p of m.primitives || []) {
    const pos = j.accessors[p.attributes.POSITION]; verts += pos ? pos.count : 0;
    if (p.indices != null) tris += j.accessors[p.indices].count / 3; else if (pos) tris += pos.count / 3;
  }
  const images = (j.images || []).map((im) => {
    if (im.bufferView == null) return { fmt: 'uri', bytes: 0, w: 0, h: 0 };
    const bv = j.bufferViews[im.bufferView];
    const data = b.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);
    return { ...imgDims(data), bytes: bv.byteLength };
  });
  const imgBytes = images.reduce((a, i) => a + i.bytes, 0);
  const texels = images.reduce((a, i) => a + i.w * i.h, 0);
  return {
    bytes: b.length, ext: j.extensionsUsed || [], meshes: (j.meshes || []).length, prims: (j.meshes || []).reduce((a, m) => a + m.primitives.length, 0),
    materials: (j.materials || []).length, tris: Math.round(tris), verts, images: images.length, imgBytes, texels,
    gpuTexMB_rgba: texels * 4 * 4 / 3 / 1048576, gpuTexMB_bc7: texels * 1 * 4 / 3 / 1048576,
    imgFormats: [...new Set(images.map((i) => i.fmt))], maxDim: Math.max(0, ...images.map((i) => Math.max(i.w, i.h))),
  };
}
const pick = (arr, n) => { if (arr.length <= n) return arr; const step = arr.length / n; return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]); };
function compressStats(buffers) {
  let raw = 0, gz = 0, br = 0, br5 = 0;
  for (const b of buffers) {
    raw += b.length; gz += zlib.gzipSync(b, { level: 6 }).length;
    br += zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    br5 += zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
  }
  return { n: buffers.length, rawKB: Math.round(raw / 1024), gzip6: +(1 - gz / raw).toFixed(3), brotli5: +(1 - br5 / raw).toFixed(3), brotli11: +(1 - br / raw).toFixed(3) };
}

const families = {
  aircraft: walk(A('assets/aircraft')).filter((f) => f.endsWith('.glb') && !f.includes('/tex/')),
  landmarks: walk(A('assets/sf/landmarks')).filter((f) => f.endsWith('.glb')),
  airports: walk(A('assets/sf/airports')).filter((f) => f.endsWith('.glb')),
  'city l0': walk(A('assets/sf/city/l0')), 'city l1': walk(A('assets/sf/city/l1')), 'city l2': walk(A('assets/sf/city/l2')), 'city l3': walk(A('assets/sf/city/l3')),
  'trees models': walk(A('assets/sf/city/trees')).filter((f) => f.endsWith('.glb')),
};
const out = { root, families: {}, glb: {}, sizes: {}, compression: {} };
for (const [fam, files] of Object.entries(families)) {
  const infos = files.map((f) => [path.relative(root, f), glbInfo(f)]).filter(([, i]) => i);
  const sum = (k) => infos.reduce((a, [, i]) => a + i[k], 0);
  out.families[fam] = {
    files: infos.length, MB: +(sum('bytes') / 1048576).toFixed(1), ext: [...new Set(infos.flatMap(([, i]) => i.ext))], tris: sum('tris'), images: sum('images'),
    imgMB: +(sum('imgBytes') / 1048576).toFixed(1), gpuTexMB_rgba: +sum('gpuTexMB_rgba').toFixed(0), gpuTexMB_bc7: +sum('gpuTexMB_bc7').toFixed(0),
    imgFormats: [...new Set(infos.flatMap(([, i]) => i.imgFormats))], maxDim: Math.max(0, ...infos.map(([, i]) => i.maxDim)),
  };
  if (['aircraft', 'airports', 'trees models'].includes(fam) || fam === 'landmarks') for (const [f, i] of infos) if (i.bytes > 300000) out.glb[f] = { MB: +(i.bytes / 1048576).toFixed(2), ext: i.ext, tris: i.tris, prims: i.prims, mats: i.materials, images: i.images, imgMB: +(i.imgBytes / 1048576).toFixed(2), maxDim: i.maxDim, gpuTexMB_rgba: +i.gpuTexMB_rgba.toFixed(1), gpuTexMB_bc7: +i.gpuTexMB_bc7.toFixed(1) };
}
// runtime-loaded textures outside GLBs
const loose = walk(A('assets/sf')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !f.includes('/terrain/img/'));
out.looseTextures = loose.map((f) => { const d = imgDims(fs.readFileSync(f)); return { f: path.relative(root, f), KB: Math.round(fs.statSync(f).size / 1024), ...d, gpuMB_rgba: +(d.w * d.h * 4 * 4 / 3 / 1048576).toFixed(1) }; }).sort((a, b) => b.gpuMB_rgba - a.gpuMB_rgba).slice(0, 30);
// terrain imagery: 512² WebP tiles → GPU RGBA8 + mips vs BC7 / BC1
const img = walk(A('assets/sf/terrain/img'));
out.terrainImagery = { tiles: img.length, MB: +(img.reduce((a, f) => a + fs.statSync(f).size, 0) / 1048576).toFixed(0), perTileGpuKB_rgba: Math.round(512 * 512 * 4 * 4 / 3 / 1024), perTileGpuKB_bc7: Math.round(512 * 512 * 4 / 3 / 1024), perTileGpuKB_bc1: Math.round(512 * 512 * 0.5 * 4 / 3 / 1024) };
// compression of binaries (as served)
const hFiles = ['6', '7', '8', '9', '10'].map((l) => A(`assets/sf/terrain/h/${l}.bin`)).filter(fs.existsSync);
const hSlices = [];
for (const f of hFiles) { const fd = fs.openSync(f, 'r'); const size = fs.statSync(f).size; for (let k = 0; k < 8; k++) { const off = Math.floor((size / 9548) * Math.random()) * 9548; const b = Buffer.alloc(9548); fs.readSync(fd, b, 0, 9548, off); hSlices.push(b); } fs.closeSync(fd); }
const read = (list) => pick(list, samples).map((f) => fs.readFileSync(f));
out.compression = {
  'city l0 glb': compressStats(read(families['city l0'])), 'city l1 glb': compressStats(read(families['city l1'])), 'city l2 glb': compressStats(read(families['city l2'])),
  'city obst .gz': compressStats(read(walk(A('assets/sf/city/obst')))), 'trees tiles .bin': compressStats(read(walk(A('assets/sf/city/trees')).filter((f) => f.endsWith('.bin')))),
  'trees models glb': compressStats(read(families['trees models'])), 'terrain h tile (range)': compressStats(hSlices), 'terrain img webp': compressStats(read(img)),
  'landmarks glb': compressStats(read(families.landmarks)), 'airports glb': compressStats(read(families.airports)), 'airports .bin': compressStats(read(walk(A('assets/sf/airports')).filter((f) => f.endsWith('.bin')))),
  'aircraft glb': compressStats(read(families.aircraft)), 'audio m4a': compressStats(read(walk(A('assets/audio')).filter((f) => f.endsWith('.m4a')))),
  'landmarks json': compressStats(read(walk(A('assets/sf/landmarks')).filter((f) => f.endsWith('.json')))),
};
console.log(JSON.stringify(out, null, 1));
save('assets-audit.json', out);
