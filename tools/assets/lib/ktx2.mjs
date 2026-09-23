// KTX2 (Basis Universal) encoding for one image, plus decoding back to RGBA for quality checks.
// Encoder: KTX-Software `ktx create` (Basis Universal; native, multithreaded, no source size limit). Decoder for the
// quality checks: the Basis Universal WebAssembly transcoder of npm `ktx2-encoder`. Image decode / resize: sharp.
// Only ETC1S and UASTC LDR 4x4 are produced: both are part of the KTX2 / KHR_texture_basisu baseline that three.js'
// KTX2Loader transcodes (to ASTC / BC7 / ETC2 / BC1-3 / RGBA fallbacks).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { read as readKTX2, write as writeKTX2 } from 'ktx-parse';
import { KTX_BIN } from '../setup.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
// the Emscripten module of ktx2-encoder (hidden by the package's exports map): its KTX2File transcoder decodes our
// output back to RGBA for the quality checks
const BASIS_JS = path.join(path.dirname(fileURLToPath(import.meta.resolve('ktx2-encoder'))), '../basis/basis_encoder.js');
const { default: BASIS } = await import(pathToFileURL(BASIS_JS).href);
sharp.concurrency(1);   // parallelism comes from worker processes

let modP = null;
export function basis() {
  if (!modP) modP = BASIS({ print: () => {}, printErr: () => {} }).then((m) => { m.initializeBasis(); return m; });
  return modP;
}

/** Decode + (optionally) downscale to maxSize → { data: RGBA Uint8Array, width, height, srcW, srcH, alphaMin }. */
export async function loadRGBA(buf, maxSize = Infinity) {
  const img = sharp(buf, { limitInputPixels: false });
  const meta = await img.metadata();
  const srcW = meta.width, srcH = meta.height;
  const s = Math.min(1, maxSize / Math.max(srcW, srcH));
  let p = sharp(buf, { limitInputPixels: false }).ensureAlpha();
  const width = Math.max(1, Math.round(srcW * s)), height = Math.max(1, Math.round(srcH * s));
  if (s < 1) p = p.resize(width, height, { kernel: 'lanczos3', fit: 'fill' });
  const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
  let alphaMin = 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < alphaMin) { alphaMin = data[i]; if (!alphaMin) break; }
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, srcW, srcH, alphaMin };
}

/**
 * Encode RGBA pixels to KTX2 with a full mip chain, with the KTX-Software `ktx create` tool (Basis Universal inside;
 * installed by tools/assets/setup.mjs).
 *   mode   'uastc' | 'etc1s'
 *   kind   'color' (sRGB transfer, perceptual) | 'normal' | 'data' (linear)
 *   uastcLevel 0-4 (effort; 2 = slower / better), rdo = UASTC RDO lambda (0 = off), etc1sQuality 1-255, etc1sEffort 0-5,
 *   wrap   mip filtering wraps around the edges (tiling textures) instead of clamping (atlases)
 * UASTC levels are zstd-supercompressed (level 19); ETC1S uses BasisLZ.
 */
export async function encodeKTX2(px, { mode, kind, uastcLevel = 2, rdo = 0, etc1sQuality = 255, etc1sEffort = 3, wrap = false, threads = 0, mipFilter = 'lanczos4' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-ktx-'));
  try {
    const alpha = px.alphaMin < 255;
    const png = path.join(dir, 'in.png'), out = path.join(dir, 'out.ktx2');
    let img = sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.length), { raw: { width: px.width, height: px.height, channels: 4 } });
    if (!alpha) img = img.removeAlpha();
    await img.png({ compressionLevel: 1 }).toFile(png);
    const srgb = kind === 'color';
    const args = ['create', '--format', `${alpha ? 'R8G8B8A8' : 'R8G8B8'}_${srgb ? 'SRGB' : 'UNORM'}`, '--assign-tf', srgb ? 'srgb' : 'linear',
      '--assign-primaries', 'bt709', '--generate-mipmap', '--mipmap-filter', mipFilter, '--mipmap-wrap', wrap ? 'wrap' : 'clamp'];
    if (mode === 'uastc') {
      args.push('--encode', 'uastc', '--uastc-quality', String(uastcLevel), '--zstd', '19');
      if (rdo > 0) args.push('--uastc-rdo', '--uastc-rdo-l', String(rdo));
    } else args.push('--encode', 'basis-lz', '--qlevel', String(etc1sQuality), '--clevel', String(etc1sEffort));
    if (threads) args.push('--threads', String(threads));
    args.push(png, out);
    await new Promise((resolve, reject) => execFile(KTX_BIN, args, { maxBuffer: 1 << 24 }, (e, so, se) => (e ? reject(new Error(`ktx create failed: ${se || e.message}`)) : resolve())));
    return new Uint8Array(fs.readFileSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Level 0 (or `level`) of a KTX2 file transcoded to RGBA32 → { data, width, height, levels, hasAlpha, isUASTC }. */
export async function decodeKTX2(bytes, level = 0) {
  const m = await basis();
  const f = new m.KTX2File(new Uint8Array(bytes));
  try {
    if (!f.isValid()) throw new Error('invalid KTX2');
    if (!f.startTranscoding()) throw new Error('startTranscoding failed');
    const info = f.getImageLevelInfo(level, 0, 0);
    const fmt = m.transcoder_texture_format.cTFRGBA32.value;
    const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(level, 0, 0, fmt));
    if (!f.transcodeImage(dst, level, 0, 0, fmt, 0, -1, -1)) throw new Error('transcode failed');
    return { data: dst, width: info.origWidth, height: info.origHeight, levels: f.getLevels(), hasAlpha: f.getHasAlpha(), isUASTC: f.isUASTC() };
  } finally {
    f.close(); f.delete();
  }
}

/**
 * Quality of `b` against reference `a` (same size, RGBA): PSNR over RGB, mean SSIM of luma (8×8 windows, step 4) and
 * the worst 64×64 tile's mean SSIM (fine text / labels show up there first). For normal maps also the mean / p99
 * angle error in degrees.
 */
export function compare(a, b, { normal = false } = {}) {
  const { width: w, height: h } = a;
  const n = w * h;
  let se = 0;
  const la = new Float32Array(n), lb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) { const d = a.data[o + c] - b.data[o + c]; se += d * d; }
    la[i] = 0.299 * a.data[o] + 0.587 * a.data[o + 1] + 0.114 * a.data[o + 2];
    lb[i] = 0.299 * b.data[o] + 0.587 * b.data[o + 1] + 0.114 * b.data[o + 2];
  }
  const mse = se / (n * 3);
  const psnr = mse > 0 ? 10 * Math.log10(255 * 255 / mse) : 99;
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, W = 8, S = 4;
  const TW = Math.ceil(w / 64), TH = Math.ceil(h / 64);
  const tSum = new Float64Array(TW * TH), tCnt = new Float64Array(TW * TH);
  let sum = 0, cnt = 0;
  for (let y = 0; y + W <= h; y += S) for (let x = 0; x + W <= w; x += S) {
    let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
    for (let yy = 0; yy < W; yy++) for (let xx = 0; xx < W; xx++) { const i = (y + yy) * w + x + xx; ma += la[i]; mb += lb[i]; }
    ma /= W * W; mb /= W * W;
    for (let yy = 0; yy < W; yy++) for (let xx = 0; xx < W; xx++) {
      const i = (y + yy) * w + x + xx; const da = la[i] - ma, db = lb[i] - mb;
      va += da * da; vb += db * db; cov += da * db;
    }
    va /= W * W - 1; vb /= W * W - 1; cov /= W * W - 1;
    const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    sum += s; cnt++;
    const t = Math.floor((y + 4) / 64) * TW + Math.floor((x + 4) / 64);
    tSum[t] += s; tCnt[t]++;
  }
  let tileMin = 1;
  for (let t = 0; t < tSum.length; t++) if (tCnt[t]) tileMin = Math.min(tileMin, tSum[t] / tCnt[t]);
  const r = { psnr: +psnr.toFixed(2), ssim: +(sum / Math.max(1, cnt)).toFixed(5), tileMin: +tileMin.toFixed(4) };
  if (normal) {
    const errs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const v = (d, k) => d[o + k] / 127.5 - 1;
      let ax = v(a.data, 0), ay = v(a.data, 1), az = v(a.data, 2), bx = v(b.data, 0), by = v(b.data, 1), bz = v(b.data, 2);
      const na = Math.hypot(ax, ay, az) || 1, nb = Math.hypot(bx, by, bz) || 1;
      errs[i] = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (na * nb)))) * 180 / Math.PI;
    }
    const sorted = errs.slice().sort();
    r.angMean = +(errs.reduce((s, e) => s + e, 0) / n).toFixed(3);
    r.angP99 = +sorted[Math.floor(n * 0.99)].toFixed(2);
  }
  return r;
}

/**
 * The same KTX2 file without its top mip levels, so that the largest side is ≤ maxSize (no re-encoding: UASTC levels
 * are independent zstd blobs; for ETC1S / BasisLZ only the per-level image descriptors of the global data go with
 * them). Returns the input when nothing needs to go.
 */
export function dropLevels(bytes, maxSize) {
  const c = readKTX2(new Uint8Array(bytes));
  let k = 0;
  while (k < c.levels.length - 1 && Math.max(c.pixelWidth >> k, c.pixelHeight >> k) > maxSize) k++;
  if (!k) return bytes;
  const perLevel = Math.max(1, c.layerCount) * c.faceCount;   // image descriptors per level (BasisLZ)
  c.levels = c.levels.slice(k);
  c.levelCount = c.levels.length;
  c.pixelWidth = Math.max(1, c.pixelWidth >> k);
  c.pixelHeight = Math.max(1, c.pixelHeight >> k);
  if (c.globalData) c.globalData.imageDescs = c.globalData.imageDescs.slice(k * perLevel);
  return writeKTX2(c, { keepWriter: true });
}
