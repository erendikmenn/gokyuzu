// Minimal GLB container read/write for texture post-processing. Only image payloads are replaced; every other
// bufferView (Draco / meshopt / plain geometry, animation) is copied byte for byte, so geometry stays exactly as exported.
import fs from 'node:fs';

const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;

/** Parse a GLB → { json, bin } (bin = Buffer of buffer 0 or null). */
export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a GLB');
  let o = 12, json = null, bin = null;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK && !bin) bin = Buffer.from(data);
    o += 8 + len;
  }
  if (!json) throw new Error('GLB without JSON chunk');
  return { json, bin };
}

/** Serialize { json, bin } → GLB Buffer (chunks padded to 4 bytes: JSON with spaces, BIN with zeros). */
export function writeGlb(json, bin) {
  let jb = Buffer.from(JSON.stringify(json), 'utf8');
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
  let bb = bin || Buffer.alloc(0);
  if (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(4 - (bb.length % 4))]);
  const total = 12 + 8 + jb.length + (bin ? 8 + bb.length : 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
  const parts = [head, jh, jb];
  if (bin) { const bh = Buffer.alloc(8); bh.writeUInt32LE(bb.length, 0); bh.writeUInt32LE(BIN_CHUNK, 4); parts.push(bh, bb); }
  return Buffer.concat(parts);
}

/** Bytes of image i (embedded through a bufferView of buffer 0), or null. */
export function imageBytes(json, bin, i) {
  const im = json.images && json.images[i];
  if (!im || im.bufferView == null || !bin) return null;
  const bv = json.bufferViews[im.bufferView];
  if ((bv.buffer || 0) !== 0) return null;
  const off = bv.byteOffset || 0;
  return bin.subarray(off, off + bv.byteLength);
}

/**
 * Rebuild buffer 0 with new contents for some bufferViews (Map bufferViewIndex → Buffer) and drop unused ones
 * (`drop`: Set of bufferView indices no longer referenced). Views keep their order; each starts on a 16-byte
 * boundary (≥ every accessor / meshopt alignment rule). Returns the new bin; json.bufferViews / references are
 * updated in place.
 */
export function relayoutBuffer(json, bin, replace = new Map(), drop = new Set()) {
  const views = json.bufferViews || [];
  const remap = new Map();
  const kept = [];
  views.forEach((bv, i) => { if (!drop.has(i)) { remap.set(i, kept.length); kept.push([i, bv]); } });
  const parts = [];
  let off = 0;
  for (const [i, bv] of kept) {
    if ((bv.buffer || 0) !== 0) continue;   // other buffers (meshopt fallback, external .bin) untouched
    const data = replace.has(i) ? replace.get(i) : bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const pad = (16 - (off % 16)) % 16;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    bv.byteOffset = off;
    bv.byteLength = data.length;
    parts.push(data);
    off += data.length;
  }
  const out = Buffer.concat(parts);
  json.bufferViews = kept.map(([, bv]) => bv);
  // re-point every bufferView reference (accessors, images, sparse, Draco, meshopt-free)
  const fix = (v) => (remap.has(v) ? remap.get(v) : v);
  for (const a of json.accessors || []) {
    if (a.bufferView != null) a.bufferView = fix(a.bufferView);
    if (a.sparse) { a.sparse.indices.bufferView = fix(a.sparse.indices.bufferView); a.sparse.values.bufferView = fix(a.sparse.values.bufferView); }
  }
  for (const im of json.images || []) if (im.bufferView != null) im.bufferView = fix(im.bufferView);
  for (const m of json.meshes || []) for (const p of m.primitives || []) {
    const d = p.extensions && p.extensions.KHR_draco_mesh_compression;
    if (d && d.bufferView != null) d.bufferView = fix(d.bufferView);
  }
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = out.length;
  return out;
}

/** Texture slots of a glTF material: [{ key, index, texCoord, kind: 'color'|'normal'|'data' }]. */
export function materialSlots(m) {
  const out = [];
  const add = (key, info, kind) => { if (info && info.index != null) out.push({ key, index: info.index, kind }); };
  const pbr = m.pbrMetallicRoughness || {};
  add('baseColor', pbr.baseColorTexture, 'color');
  add('metallicRoughness', pbr.metallicRoughnessTexture, 'data');
  add('normal', m.normalTexture, 'normal');
  add('occlusion', m.occlusionTexture, 'data');
  add('emissive', m.emissiveTexture, 'color');
  const e = m.extensions || {};
  if (e.KHR_materials_clearcoat) {
    add('clearcoat', e.KHR_materials_clearcoat.clearcoatTexture, 'data');
    add('clearcoatRoughness', e.KHR_materials_clearcoat.clearcoatRoughnessTexture, 'data');
    add('clearcoatNormal', e.KHR_materials_clearcoat.clearcoatNormalTexture, 'normal');
  }
  if (e.KHR_materials_transmission) add('transmission', e.KHR_materials_transmission.transmissionTexture, 'data');
  if (e.KHR_materials_specular) {
    add('specular', e.KHR_materials_specular.specularTexture, 'data');
    add('specularColor', e.KHR_materials_specular.specularColorTexture, 'color');
  }
  if (e.KHR_materials_sheen) {
    add('sheenColor', e.KHR_materials_sheen.sheenColorTexture, 'color');
    add('sheenRoughness', e.KHR_materials_sheen.sheenRoughnessTexture, 'data');
  }
  if (e.KHR_materials_volume) add('thickness', e.KHR_materials_volume.thicknessTexture, 'data');
  return out;
}

/** Source image index of texture t (plain source, or the WebP / AVIF / KTX2 extension source). */
export function textureSource(t) {
  const e = t.extensions || {};
  for (const k of ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif']) if (e[k] && e[k].source != null) return e[k].source;
  return t.source;
}

/** Write a file atomically through a temp file + rename (a new inode: hard links, e.g. into dist/, keep the old content). */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
