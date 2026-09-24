#!/usr/bin/env node
// Runtime packs: lighter / merged variants of published map files, written next to the originals (never replacing
// them) and listed in assets/<map>/packs.json, which the game reads at start (src/world-sf/index.js → ctx.packs). Every
// layer falls back to the original files when an entry is missing, so a stale or absent packs.json is never fatal.
//
//   terrain.waterDepthSmall   terrain/packs/water_depth_2048.png   water_depth.png box-filtered 4096² → 2048² (= its mip 1)
//                             for tablets: 85 → 21 MB of GPU memory, 1.4 → 0.3 MB download
//   terrain.waterDepthTiny    terrain/packs/water_depth_1024.png   … → 1024² (mip 2) for phones: 5 MB
//   city.atlasSmall           city/packs/atlas_256/                the facade atlas with 256² instead of 512² cells (2×2 box
//                             filter inside each cell = mip 1 of every array layer) for tablets: 3 × 49 → 3 × 12 MB
//   city.atlasTiny            city/packs/atlas_128/                128² cells (mip 2) for phones: 3 × 3 MB
//   city.trees                city/packs/trees/species_lod1.glb   the 9 species' far LODs in one file, each texture once
//                             city/packs/trees/species_lod0.glb   the near LODs; textures the far file already has are
//                             bound from it at runtime (material extras `packShared`); Draco geometry as before
//   terrain.pins              terrain/packs/pins/index.json + <group>.bin   pins.bin (full-depth heights under airports and
//                             landmarks) split into the coarse levels (≤ L6, 'base') and one file per level-6 cell (2 km):
//                             the start loads base + the cells around the spawn, the rest streams near the camera
//   airports.groundMobile     packs/airport-ground-1024/           the airport ground textures larger than 1024² cut to 1024²
//                             (what phones / tablets keep anyway, src/world-sf/airports_ground.js): −2.2 MB at their start
//   city.treesLow             city/packs/trees_d30/, trees_d50/    tree tiles holding only the trees a density of 0.3 /
//                             0.5 draws (phones, low preset / tablets): per 250 m bin the first round(n × d) records by
//                             the rotation byte, exactly the subset src/world-sf/city_trees.js keeps from a full tile
//
// Sources are identified by content: a map whose sources are byte-identical to another map's (İstanbul copies San
// Francisco's atlas and tree models) points at that map's pack files instead of a second copy (one download, one cache
// entry for players of both maps).
//
// usage: node tools/assets/packs.mjs [--maps sf,ist] [--only water,atlas,trees] [--force]
//        node tools/assets/packs.mjs --check      exit 1 when a packs.json is missing or its sources changed since
// Run it again after a terrain (water_depth.png) or city (atlas, tree models) rebuild. Outputs are deterministic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(HERE, 'package.json'));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const MAPS = (opt('--maps', 'sf,ist')).split(',');
const ONLY = new Set((opt('--only', 'water,atlas,trees,treeslow,airtex,pins')).split(','));
const FORCE = argv.includes('--force');
const CHECK = argv.includes('--check');
const VERSION = 2;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const fileSha = (p) => sha(fs.readFileSync(p));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const mapDir = (m) => path.join(ROOT, 'assets', m);
const readPacks = (m) => { try { return JSON.parse(fs.readFileSync(path.join(mapDir(m), 'packs.json'), 'utf8')); } catch { return null; } };

/** 2×2 box filter of raw interleaved 8-bit pixels (what generateMipmap computes for mip 1). */
function box2(buf, w, h, c) {
  const W = w >> 1, H = h >> 1, out = Buffer.alloc(W * H * c);
  for (let y = 0; y < H; y++) {
    const r0 = 2 * y * w * c, r1 = r0 + w * c;
    for (let x = 0; x < W; x++) {
      const i = r0 + 2 * x * c, j = r1 + 2 * x * c, o = (y * W + x) * c;
      for (let k = 0; k < c; k++) out[o + k] = (buf[i + k] + buf[i + c + k] + buf[j + k] + buf[j + c + k] + 2) >> 2;
    }
  }
  return out;
}

// ------------------------------------------------------------------ water depth
async function packWater(m, sources) {
  const sharp = require('sharp');
  const src = path.join(mapDir(m), 'terrain', 'water_depth.png');
  if (!fs.existsSync(src)) return null;
  const h = fileSha(src);
  sources[rel(src)] = h;
  const out2 = path.join(mapDir(m), 'terrain', 'packs', 'water_depth_2048.png'), out1 = path.join(mapDir(m), 'terrain', 'packs', 'water_depth_1024.png');
  if (FORCE || !fs.existsSync(out2) || !fs.existsSync(out1) || prevSource(m, rel(src)) !== h) {
    const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
    fs.mkdirSync(path.dirname(out2), { recursive: true });
    let px = data, w = info.width;
    for (const out of [out2, out1]) {
      px = box2(px, w, w, info.channels); w >>= 1;
      await sharp(px, { raw: { width: w, height: w, channels: info.channels } }).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toFile(out);
      console.log(`[${m}] water ${rel(out)} ${(fs.statSync(out).size / 1024).toFixed(0)} KB (source ${(fs.statSync(src).size / 1024).toFixed(0)} KB)`);
    }
  }
  return { waterDepthSmall: 'terrain/packs/water_depth_2048.png', waterDepthTiny: 'terrain/packs/water_depth_1024.png' };
}

// ------------------------------------------------------------------ facade atlas
// lossy WebP subsamples chroma (4:2:0): fine for albedo / normals, not for the material map whose three channels are
// independent data (tint mask, roughness, window mask) → near-lossless there
const ATLAS_ENC = { albedo: { quality: 95, effort: 6 }, nrm: { quality: 95, effort: 6 }, mat: { nearLossless: true, quality: 60, effort: 6 } };
async function packAtlas(m, sources, shared) {
  const sharp = require('sharp');
  const dir = path.join(mapDir(m), 'city', 'atlas');
  const metaPath = path.join(dir, 'atlas.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const files = [metaPath, ...Object.values(meta.images).map((f) => path.join(dir, f))];
  const key = sha(Buffer.from(files.map(fileSha).join(',')));
  for (const f of files) sources[rel(f)] = fileSha(f);
  const reuse = shared.atlas.get(key);
  const entry = (d) => ({ atlasSmall: `${d}/atlas_256/`, atlasTiny: `${d}/atlas_128/` });
  if (reuse) return entry(path.posix.relative(`assets/${m}`, reuse));
  const outBase = path.join(mapDir(m), 'city', 'packs');
  const dirs = [[path.join(outBase, 'atlas_256'), 1], [path.join(outBase, 'atlas_128'), 2]];
  const fresh = !FORCE && dirs.every(([d]) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'atlas.json'), 'utf8')).packSource === key; } catch { return false; } });
  if (!fresh) {
    const px = {};
    for (const [k, f] of Object.entries(meta.images)) {
      const { data, info } = await sharp(path.join(dir, f)).raw().toBuffer({ resolveWithObject: true });
      if (info.width !== meta.size || info.height !== meta.size) throw new Error(`${f}: ${info.width}x${info.height}, atlas.json says ${meta.size}`);
      px[k] = { data, w: info.width, c: info.channels };
    }
    for (const [outDir, steps] of dirs) {
      fs.mkdirSync(outDir, { recursive: true });
      const small = { ...meta, cell: meta.cell >> steps, size: meta.size >> steps, packSource: key, packNote: `tools/assets/packs.mjs: ${2 ** steps}x${2 ** steps} box filter of every cell (mip ${steps})` };
      for (const [k, f] of Object.entries(meta.images)) {
        const p = px[k];
        p.data = box2(p.data, p.w, p.w, p.c); p.w >>= 1;   // one more level (the 256 pass feeds the 128 pass)
        await sharp(p.data, { raw: { width: p.w, height: p.w, channels: p.c } }).webp(ATLAS_ENC[k] || { quality: 95 }).toFile(path.join(outDir, f));
      }
      fs.writeFileSync(path.join(outDir, 'atlas.json'), JSON.stringify(small, null, 1));
      const kb = fs.readdirSync(outDir).reduce((a, f) => a + fs.statSync(path.join(outDir, f)).size, 0) / 1024;
      console.log(`[${m}] atlas ${rel(outDir)}/ ${kb.toFixed(0)} KB (cell ${small.cell}, size ${small.size})`);
    }
  }
  shared.atlas.set(key, rel(outBase));
  return entry('city/packs');
}

// ------------------------------------------------------------------ trees
async function packTrees(m, sources, shared) {
  const dir = path.join(mapDir(m), 'city', 'trees');
  const metaPath = path.join(dir, 'trees.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const species = Object.keys(meta.refHeight).filter((sp) => fs.existsSync(path.join(dir, `${sp}.glb`)));
  const files = species.map((sp) => path.join(dir, `${sp}.glb`));
  const key = sha(Buffer.from(species.map((sp, i) => `${sp}:${fileSha(files[i])}`).join(',')));
  files.forEach((f) => { sources[rel(f)] = fileSha(f); });
  const reuse = shared.trees.get(key);
  const entry = (d) => ({ lod1: `${d}/species_lod1.glb`, lod0: `${d}/species_lod0.glb`, species });
  if (reuse) return { trees: entry(path.posix.relative(`assets/${m}`, reuse)) };
  const outDir = path.join(mapDir(m), 'city', 'packs', 'trees');
  const stampPath = path.join(outDir, 'source.json');
  let fresh = !FORCE && fs.existsSync(stampPath);
  if (fresh) { try { fresh = JSON.parse(fs.readFileSync(stampPath, 'utf8')).key === key; } catch { fresh = false; } }
  if (!fresh) {
    const { NodeIO, Document, PropertyType } = await import(require.resolve('@gltf-transform/core'));
    const { ALL_EXTENSIONS, KHRDracoMeshCompression } = await import(require.resolve('@gltf-transform/extensions'));
    const { mergeDocuments, dedup, prune, unpartition } = await import(require.resolve('@gltf-transform/functions'));
    const { EXTTextureWebP } = await import(require.resolve('@gltf-transform/extensions'));
    const sharp = require('sharp');
    const draco3d = require('draco3dgltf');
    const { MeshoptEncoder, MeshoptDecoder } = await import(require.resolve('meshoptimizer'));
    await MeshoptEncoder.ready; await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule(), 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
    });
    const hashOf = (tex) => sha(Buffer.from(tex.getImage()));
    const build = async (lod, farTextures) => {
      const doc = new Document();
      doc.createBuffer();
      for (const f of files) mergeDocuments(doc, await io.read(f));
      const root = doc.getRoot();
      const scene = root.listScenes()[0];
      for (const s of root.listScenes().slice(1)) { for (const n of s.listChildren()) scene.addChild(n); s.dispose(); }
      for (const n of [...scene.listChildren()]) if (!new RegExp(`_lod${lod}$`).test(n.getName())) n.dispose();
      root.setDefaultScene(scene);
      await doc.transform(prune({ keepAttributes: true, keepLeaves: false }), dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE, PropertyType.MATERIAL] }), prune({ keepAttributes: true, keepLeaves: false }), unpartition());
      const own = new Map();
      if (farTextures) {
        // near LOD: textures the far file already carries are not stored again; the runtime binds them by name
        for (const mat of root.listMaterials()) {
          const shareMap = {};
          const slots = [['map', mat.getBaseColorTexture(), (t) => mat.setBaseColorTexture(t)], ['normalMap', mat.getNormalTexture(), (t) => mat.setNormalTexture(t)]];
          for (const [slot, tex, set] of slots) {
            if (!tex) continue;
            const far = farTextures.get(hashOf(tex));
            if (far) { shareMap[slot] = far; set(null); }
          }
          if (Object.keys(shareMap).length) mat.setExtras({ ...mat.getExtras(), packShared: shareMap });
        }
        await doc.transform(prune({ keepAttributes: true, keepLeaves: false }));
      }
      for (const t of root.listTextures()) own.set(hashOf(t), t.getName());
      // PNG leaves / fronds / cards (alpha) as lossless WebP (EXT_texture_webp): the same pixels in ~45 % of the bytes;
      // `exact` keeps the colour under fully transparent texels (the mip levels average it into the leaf edges)
      let webp = false;
      for (const t of root.listTextures()) {
        if (t.getMimeType() !== 'image/png') continue;
        t.setImage(new Uint8Array(await sharp(Buffer.from(t.getImage())).webp({ lossless: true, exact: true, effort: 6 }).toBuffer())).setMimeType('image/webp');
        webp = true;
      }
      if (webp) doc.createExtension(EXTTextureWebP).setRequired(true);
      // geometry stays Draco (decoded in DRACOLoader's workers; the landmarks need that decoder on every map anyway),
      // SEQUENTIAL (keeps the vertex / face order), finer quantization than the sources: positions, normals, colours exact, uv within 1e-4
      for (const ext of root.listExtensionsUsed()) if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
      doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
        method: KHRDracoMeshCompression.EncoderMethod.SEQUENTIAL, encodeSpeed: 5, decodeSpeed: 5,
        quantizationBits: { POSITION: 16, NORMAL: 12, TEX_COORD: 16, COLOR: 10, GENERIC: 16 },
      });
      root.getAsset().generator = 'gokyuzu tools/assets/packs.mjs';
      return { glb: Buffer.from(await io.writeBinary(doc)), textures: own };
    };
    const far = await build(1, null);
    const near = await build(0, far.textures);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'species_lod1.glb'), far.glb);
    fs.writeFileSync(path.join(outDir, 'species_lod0.glb'), near.glb);
    fs.writeFileSync(stampPath, JSON.stringify({ key, species, note: 'tools/assets/packs.mjs (not loaded by the game)' }, null, 1));
    const was = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    console.log(`[${m}] trees ${rel(outDir)}/ lod1 ${(far.glb.length / 1024).toFixed(0)} KB + lod0 ${(near.glb.length / 1024).toFixed(0)} KB (was ${species.length} files, ${(was / 1024).toFixed(0)} KB)`);
  }
  shared.trees.set(key, rel(outDir));
  return { trees: entry('city/packs/trees') };
}

function prevSource(m, r) { const p = readPacks(m); return p && p.sources ? p.sources[r] : null; }

// ------------------------------------------------------------------ pinned heights split by area
async function packPins(m, sources) {
  const zlib = await import('node:zlib');
  const src = path.join(mapDir(m), 'terrain', 'pins.bin'), idxBin = path.join(mapDir(m), 'terrain', 'index.bin');
  if (!fs.existsSync(src) || !fs.existsSync(idxBin)) return null;
  const h = fileSha(src);
  sources[rel(src)] = h;
  const outDir = path.join(mapDir(m), 'terrain', 'packs', 'pins');
  const entry = { pins: 'terrain/packs/pins/index.json' };
  if (!FORCE && prevSource(m, rel(src)) === h && fs.existsSync(path.join(outDir, 'index.json'))) return entry;
  const raw = zlib.inflateSync(fs.readFileSync(src));
  const hl = raw.readUInt32LE(0), hdr = JSON.parse(raw.subarray(4, 4 + hl).toString('utf8'));
  const ib = zlib.inflateSync(fs.readFileSync(idxBin)), ihl = ib.readUInt32LE(0), idx = JSON.parse(ib.subarray(4, 4 + ihl).toString('utf8'));
  const NS = 67, TS = NS * NS * 2 + ((NS * NS + 7) >> 3), G = 6, S = idx.rootSize / (1 << G);
  // one group per level-6 cell with the cell's own deep tiles AND its ancestor chain (levels 0-6, shared by neighbours:
  // duplicated, a few KB): height data along any root path must stay a prefix (terrain.js nodeAt)
  const groups = new Map(), coarse = new Map();
  let off = 4 + hl;
  const recs = [];
  for (const t of hdr.tiles) { recs.push([t, raw.subarray(off, off + TS)]); off += TS; }
  if (off !== raw.length) throw new Error(`pins.bin: ${raw.length - off} bytes left after ${hdr.tiles.length} tiles`);
  for (const [t, part] of recs) if (t[0] <= G) coarse.set(`${t[0]}/${t[1]}/${t[2]}`, [t, part]);
  for (const [t, part] of recs) {
    const [L, i, j] = t;
    if (L <= G) continue;
    const key = `${i >> (L - G)}_${j >> (L - G)}`;
    let g = groups.get(key);
    if (!g) {
      groups.set(key, (g = { key, tiles: [], parts: [] }));
      const gi = i >> (L - G), gj = j >> (L - G);
      for (let l = 0; l <= G; l++) { const c = coarse.get(`${l}/${gi >> (G - l)}/${gj >> (G - l)}`); if (c) { g.tiles.push(c[0]); g.parts.push(c[1]); } }
    }
    g.tiles.push(t); g.parts.push(part);
  }
  // coarse tiles of no deep cell (landmark areas ending at level ≤ 6): a group of their own
  const used = new Set(); for (const g of groups.values()) for (const t of g.tiles) if (t[0] <= G) used.add(t.join('/'));
  const rest = [...coarse.values()].filter(([t]) => !used.has(t.join('/')));
  if (rest.length) groups.set('base', { key: 'base', tiles: rest.map((r) => r[0]), parts: rest.map((r) => r[1]) });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const list = [];
  for (const g of groups.values()) {
    const hb = Buffer.from(JSON.stringify({ q: hdr.q, tiles: g.tiles }));
    const lb = Buffer.alloc(4); lb.writeUInt32LE(hb.length, 0);
    const z = zlib.deflateSync(Buffer.concat([lb, hb, ...g.parts]), { level: 9 });
    fs.writeFileSync(path.join(outDir, `${g.key}.bin`), z);
    const e = { key: g.key, file: `${g.key}.bin`, tiles: g.tiles.length, bytes: z.length };
    if (g.key !== 'base') { const [gi, gj] = g.key.split('_').map(Number); e.box = [idx.rootMinX + gi * S, idx.rootMinZ + gj * S, S]; }
    list.push(e);
  }
  list.sort((a, b) => (a.key === 'base' ? -1 : b.key === 'base' ? 1 : a.key < b.key ? -1 : 1));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ version: 1, q: hdr.q, level: G, groups: list }));
  console.log(`[${m}] pins ${hdr.tiles.length} tiles → ${list.length} files, ${(list.reduce((a, e) => a + e.bytes, 0) / 1e6).toFixed(2)} MB (pins.bin ${(fs.statSync(src).size / 1e6).toFixed(2)} MB)`);
  return entry;
}

// ------------------------------------------------------------------ airport ground textures for phones / tablets
async function packAirportGround(m, sources, shared) {
  const sharp = require('sharp');
  // the map's ground texture directory (another map's airports manifest may point at San Francisco's)
  let texDir = path.join(mapDir(m), 'airports', 'tex');
  const man = path.join(mapDir(m), 'airports', 'manifest.json');
  if (fs.existsSync(man)) { try { const j = JSON.parse(fs.readFileSync(man, 'utf8')); if (j.tex) texDir = path.join(ROOT, j.tex); } catch { /* default */ } }
  if (!fs.existsSync(texDir)) return null;
  const big = [];
  for (const f of fs.readdirSync(texDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()) {
    const meta = await sharp(path.join(texDir, f)).metadata();
    if (Math.max(meta.width, meta.height) > 1024) big.push({ f, w: meta.width, h: meta.height });
  }
  if (!big.length) return null;
  const key = crypto.createHash('sha256').update(big.map((b) => `${b.f}:${fileSha(path.join(texDir, b.f))}`).join(',')).digest('hex').slice(0, 16);
  for (const b of big) sources[rel(path.join(texDir, b.f))] = fileSha(path.join(texDir, b.f));
  const reuse = shared.airtex.get(key);
  const entry = (d) => ({ groundMobile: { dir: `${d}/`, maxSize: 1024, files: big.map((b) => b.f) } });
  if (reuse) return entry(path.posix.relative(`assets/${m}`, reuse));
  const outDir = path.join(mapDir(m), 'packs', 'airport-ground-1024');
  const stamp = path.join(outDir, 'source.json');
  let fresh = !FORCE && fs.existsSync(stamp);
  if (fresh) { try { fresh = JSON.parse(fs.readFileSync(stamp, 'utf8')).key === key; } catch { fresh = false; } }
  if (!fresh) {
    fs.mkdirSync(outDir, { recursive: true });
    let a = 0, b2 = 0;
    for (const b of big) {
      const s = 1024 / Math.max(b.w, b.h);
      const src = path.join(texDir, b.f), dst = path.join(outDir, b.f);
      let img = sharp(src).resize(Math.round(b.w * s), Math.round(b.h * s), { kernel: 'lanczos3' });
      img = /\.png$/i.test(b.f) ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' });
      await img.toFile(dst);
      a += fs.statSync(src).size; b2 += fs.statSync(dst).size;
    }
    fs.writeFileSync(stamp, JSON.stringify({ key, note: 'tools/assets/packs.mjs (not loaded by the game)' }, null, 1));
    console.log(`[${m}] airport ground ${big.length} textures ${(a / 1e6).toFixed(2)} → ${(b2 / 1e6).toFixed(2)} MB (${rel(outDir)}/)`);
  }
  shared.airtex.set(key, rel(outDir));
  return entry('packs/airport-ground-1024');
}

// ------------------------------------------------------------------ low-density tree tiles
const TREE_CELL = 250, DENSITIES = [0.3, 0.5];
async function packTreesLow(m, sources) {
  const dir = path.join(mapDir(m), 'city', 'trees');
  const metaPath = path.join(dir, 'trees.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const size = meta.size, nc = Math.ceil(size / TREE_CELL);
  const key = fileSha(metaPath);
  sources[rel(metaPath)] = key;
  const out = [];
  // tiles / trees of the trees.json the tiles were thinned from: the runtime ignores the pack when they differ (a city
  // rebuild that has not been packed yet)
  const sig = { tiles: meta.tiles.length, trees: meta.tiles.reduce((a, t) => a + (t.n || 0), 0) };
  for (const d of DENSITIES) {
    const sub = `trees_d${Math.round(d * 100)}`, outDir = path.join(mapDir(m), 'city', 'packs', sub);
    out.push({ density: d, dir: `city/packs/${sub}`, ...sig });
    const stampPath = path.join(outDir, 'source.json');
    let fresh = !FORCE && fs.existsSync(stampPath);
    if (fresh) { try { fresh = JSON.parse(fs.readFileSync(stampPath, 'utf8')).key === key; } catch { fresh = false; } }
    if (fresh) continue;
    fs.mkdirSync(outDir, { recursive: true });
    let inB = 0, outB = 0;
    for (const t of meta.tiles) {
      const buf = fs.readFileSync(path.join(dir, `${t.i}_${t.j}.bin`));
      const n = buf.readUInt32LE(12), x0 = t.i * size, z0 = t.j * size;
      // bins exactly as processTile: 250 m cells from the tile corner, clamped; inside a bin a stable sort by the
      // rotation byte, the first max(1, round(count × d)) kept; written in file order (a stable sort of the kept
      // records by the same byte gives the same sequence at runtime)
      const bins = new Map();
      for (let k = 0; k < n; k++) {
        const o = 16 + k * 12, x = buf.readFloatLE(o), z = buf.readFloatLE(o + 4);
        const ci = Math.min(nc - 1, Math.max(0, Math.floor((x - x0) / TREE_CELL))), cj = Math.min(nc - 1, Math.max(0, Math.floor((z - z0) / TREE_CELL)));
        const bk = ci * nc + cj;
        let b = bins.get(bk); if (!b) bins.set(bk, (b = [])); b.push(k);
      }
      const keep = new Uint8Array(n);
      for (const b of bins.values()) {
        const ord = b.slice().sort((a, c) => buf[16 + a * 12 + 10] - buf[16 + c * 12 + 10] || a - c);
        const cnt = d >= 1 ? ord.length : Math.max(1, Math.round(ord.length * d));
        for (let q = 0; q < cnt; q++) keep[ord[q]] = 1;
      }
      let kept = 0; for (let k = 0; k < n; k++) kept += keep[k];
      const o2 = Buffer.alloc(16 + kept * 12);
      buf.copy(o2, 0, 0, 16); o2.writeUInt32LE(kept, 12);
      let w = 16;
      for (let k = 0; k < n; k++) if (keep[k]) { buf.copy(o2, w, 16 + k * 12, 28 + k * 12); w += 12; }
      fs.writeFileSync(path.join(outDir, `${t.i}_${t.j}.bin`), o2);
      inB += buf.length; outB += o2.length;
    }
    fs.writeFileSync(stampPath, JSON.stringify({ key, density: d, note: 'tools/assets/packs.mjs (not loaded by the game)' }, null, 1));
    console.log(`[${m}] trees d=${d}: ${meta.tiles.length} tiles ${(inB / 1e6).toFixed(1)} → ${(outB / 1e6).toFixed(1)} MB (${rel(outDir)}/)`);
  }
  return { treesLow: out };
}

// ------------------------------------------------------------------ main
const shared = { atlas: new Map(), trees: new Map(), airtex: new Map() };
let stale = 0;
for (const m of MAPS) {
  if (!fs.existsSync(mapDir(m))) continue;
  if (CHECK) {
    const p = readPacks(m);
    if (!p) { console.log(`[${m}] packs.json missing`); stale++; continue; }
    for (const [r, h] of Object.entries(p.sources || {})) {
      const f = path.join(ROOT, r);
      if (!fs.existsSync(f) || fileSha(f) !== h) { console.log(`[${m}] stale: ${r} changed since packs.json was written`); stale++; }
    }
    for (const r of packFiles(p, m)) if (!fs.existsSync(path.join(mapDir(m), r))) { console.log(`[${m}] missing pack file ${r}`); stale++; }
    continue;
  }
  const sources = {};
  const out = { version: VERSION, note: 'written by tools/assets/packs.mjs; paths relative to this directory', terrain: {}, city: {}, airports: {} };
  const old = readPacks(m) || {};
  Object.assign(out.terrain, old.terrain || {});
  if (ONLY.has('water')) Object.assign(out.terrain, await packWater(m, sources));
  if (ONLY.has('pins')) Object.assign(out.terrain, await packPins(m, sources) || {});
  if (ONLY.has('atlas')) Object.assign(out.city, await packAtlas(m, sources, shared) || {}); else if (old.city) for (const k of ['atlasSmall', 'atlasTiny']) if (old.city[k]) out.city[k] = old.city[k];
  if (ONLY.has('trees')) Object.assign(out.city, await packTrees(m, sources, shared) || {}); else if (old.city && old.city.trees) out.city.trees = old.city.trees;
  if (ONLY.has('airtex')) Object.assign(out.airports, await packAirportGround(m, sources, shared) || {}); else Object.assign(out.airports, old.airports || {});
  if (ONLY.has('treeslow')) Object.assign(out.city, await packTreesLow(m, sources) || {}); else if (old.city && old.city.treesLow) out.city.treesLow = old.city.treesLow;
  if (old.city && old.city.tiles) out.city.tiles = old.city.tiles;   // (tools/assets/city_meshopt.mjs)
  out.sources = { ...(old.sources || {}), ...sources };
  fs.writeFileSync(path.join(mapDir(m), 'packs.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`[${m}] packs.json: ${JSON.stringify({ terrain: out.terrain, city: { ...out.city, trees: out.city.trees && { lod1: out.city.trees.lod1, lod0: out.city.trees.lod0 } } })}`);
}
if (CHECK) { console.log(stale ? `${stale} problem(s): run node tools/assets/packs.mjs` : 'packs up to date'); process.exit(stale ? 1 : 0); }

function packFiles(p, m) {
  const out = [];
  for (const k of ['waterDepthSmall', 'waterDepthTiny', 'pins']) if (p.terrain && p.terrain[k]) out.push(p.terrain[k]);
  for (const k of ['atlasSmall', 'atlasTiny']) if (p.city && p.city[k]) out.push(p.city[k] + 'atlas.json');
  if (p.city && p.city.trees) out.push(p.city.trees.lod1, p.city.trees.lod0);
  for (const e of (p.city && p.city.treesLow) || []) out.push(`${e.dir}/source.json`);
  const g = p.airports && p.airports.groundMobile;
  if (g) for (const f of g.files) out.push(g.dir + f);
  void m;
  return out;
}
