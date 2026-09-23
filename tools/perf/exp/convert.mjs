#!/usr/bin/env node
// Research converter (never used by the game build): writes variants of sample GLBs for the decode / quality benches.
//   draco  = original file (copied)
//   meshopt = Draco decoded → EXT_meshopt_compression (+ quantization), textures unchanged
//   ktx2   = original geometry, textures → KTX2 (UASTC + zstd for normal/data maps, ETC1S for colour; or --uastc-all)
//   meshopt+ktx2
// Needs glTF-Transform, draco3dgltf, meshoptimizer, ktx2-encoder and sharp in PERF_NODE_MODULES (see bundle-audit.mjs).
// usage: node tools/perf/exp/convert.mjs --out <dir> [--root <worktree>] [--uastc-all] file.glb ...
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(opt('--out', 'exp-assets'));
const root = path.resolve(opt('--root', '.'));
const files = argv.filter((a, i) => a.endsWith('.glb') && argv[i - 1] !== '--out' && argv[i - 1] !== '--root');
const nm = process.env.PERF_NODE_MODULES || path.join(os.tmpdir(), 'gokyuzu-perf', 'node', 'node_modules');
const req = createRequire(path.join(nm, 'x.js'));
const imp = (p) => import(pathToFileURL(req.resolve(p)).href);
const { NodeIO } = await imp('@gltf-transform/core');
const { ALL_EXTENSIONS, EXTMeshoptCompression } = await imp('@gltf-transform/extensions');
const { meshopt, dedup, prune } = await imp('@gltf-transform/functions');
const draco3d = req('draco3dgltf');
const { MeshoptDecoder, MeshoptEncoder } = await imp('meshoptimizer');
const { encodeToKTX2 } = await import(pathToFileURL(path.join(nm, 'ktx2-encoder/dist/node/index.js')).href);
const { KHRTextureBasisu } = await imp('@gltf-transform/extensions');
/** Textures → KTX2: UASTC (+zstd) for normal / ORM data maps and, with uastcAll, colour too; ETC1S for colour otherwise. */
const downscaled = [];
async function toKTX2(doc, uastcAll) {
  const slot = new Map();
  for (const m of doc.getRoot().listMaterials()) {
    const add = (t, s) => { if (t) slot.set(t, (slot.get(t) || new Set()).add(s)); };
    add(m.getBaseColorTexture(), 'color'); add(m.getEmissiveTexture(), 'color'); add(m.getNormalTexture(), 'data');
    add(m.getMetallicRoughnessTexture(), 'data'); add(m.getOcclusionTexture(), 'data');
  }
  let n = 0;
  for (const t of doc.getRoot().listTextures()) {
    if (!/image\/(jpeg|png|webp)/.test(t.getMimeType())) continue;
    const kinds = slot.get(t) || new Set(['color']);
    const uastc = uastcAll || kinds.has('data');
    let img = t.getImage();
    const meta = await sharp(img).metadata();
    if (meta.width * meta.height > 12582912) {   // the wasm Basis encoder stops at ~12 Mpix: 4096² → 2048² (reported)
      img = new Uint8Array(await sharp(img).resize(meta.width >> 1, meta.height >> 1).png().toBuffer());
      downscaled.push(`${t.getName() || t.getURI() || '?'} ${meta.width}→${meta.width >> 1}`);
    }
    const data = await encodeToKTX2(img, uastc
      ? { isUASTC: true, generateMipmap: true, needSupercompression: true, isNormalMap: kinds.has('data') && !kinds.has('color'), isPerceptual: !kinds.has('data'), imageDecoder }
      : { isUASTC: false, generateMipmap: true, qualityLevel: 230, compressionLevel: 2, isPerceptual: true, imageDecoder });
    t.setImage(data); t.setMimeType('image/ktx2'); n++;
  }
  if (n) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return n;
}
const sharp = req('sharp');
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(),
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const imageDecoder = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const sizes = (b) => ({ KB: Math.round(b.length / 1024), gzipKB: Math.round(zlib.gzipSync(b, { level: 6 }).length / 1024), brotliKB: Math.round(zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length / 1024) });
fs.mkdirSync(out, { recursive: true });
const report = {};
for (const rel of files) {
  const src = path.resolve(root, rel);
  const name = path.basename(rel, '.glb');
  const r = (report[name] = { src: rel });
  const orig = fs.readFileSync(src);
  fs.writeFileSync(path.join(out, `${name}.draco.glb`), orig);
  r.draco = sizes(orig);
  const t0 = Date.now();
  // meshopt
  let doc = await io.read(src);
  for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose();
  await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  let b = Buffer.from(await io.writeBinary(doc));
  fs.writeFileSync(path.join(out, `${name}.meshopt.glb`), b);
  r.meshopt = sizes(b);
  // ktx2 (keeps Draco)
  doc = await io.read(src);
  const hasImages = doc.getRoot().listTextures().length > 0;
  if (hasImages) {
    const t1 = Date.now();
    r.ktx2Textures = await toKTX2(doc, argv.includes('--uastc-all'));
    r.ktx2EncodeS = (Date.now() - t1) / 1000;
    r.downscaled = downscaled.splice(0);
    b = Buffer.from(await io.writeBinary(doc));
    fs.writeFileSync(path.join(out, `${name}.ktx2.glb`), b);
    r.ktx2 = sizes(b);
    for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose();
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    b = Buffer.from(await io.writeBinary(doc));
    fs.writeFileSync(path.join(out, `${name}.meshopt-ktx2.glb`), b);
    r['meshopt+ktx2'] = sizes(b);
  }
  r.seconds = (Date.now() - t0) / 1000;
  console.log(name, JSON.stringify(r));
}
fs.writeFileSync(path.join(out, 'convert-report.json'), JSON.stringify(report, null, 1));
