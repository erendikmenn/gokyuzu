// Runtime packs (tools/assets/packs.mjs, tools/assets/city_meshopt.mjs → assets/<map>/packs.json). Run: node tests/packs.test.mjs
// Needs the built assets (not in git): skipped per map when assets/<map>/packs.json is missing. Node built-ins only.
//   1. packs.json: every listed file exists and its sources are unchanged since the packs were written (else: re-run
//      node tools/assets/packs.mjs)
//   2. sizes: water depth variants 2048² / 1024², atlas variants with half / quarter cells and matching images
//   3. tree models: both packs hold every species' LOD, near-LOD textures shared with the far pack are named there
//   4. thinned tree tiles: exactly the trees src/world-sf/city_trees.js keeps from the full tile at that density
//   5. meshopt city tiles: one per index tile, meshopt-compressed, same triangle count as the Draco original
//   6. shader pre-warm stand-ins: every kind present, 1-triangle meshes, placeholder textures
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const glbJson = (p) => { const b = fs.readFileSync(p); const n = b.readUInt32LE(12); return JSON.parse(b.subarray(20, 20 + n).toString('utf8')); };
function pngSize(p) { const b = fs.readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; }
function jpegSize(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0x89) return pngSize(p);
  for (let i = 2; i < b.length;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); }
  return [0, 0];
}
function webpSize(p) {
  const b = fs.readFileSync(p), c = b.toString('latin1', 12, 16);
  if (c === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (c === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];   // VP8
}

/** The runtime's subset of one tree tile at density `density` (city_trees.js processTile): records per 250 m bin. */
function runtimeSubset(buf, size, density, fileD = 1) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(12, true), ti = dv.getInt32(4, true), tj = dv.getInt32(8, true);
  const x0 = ti * size, z0 = tj * size, CELL = 250, nc = Math.ceil(size / CELL);
  const bins = new Map();
  for (let k = 0; k < n; k++) {
    const o = 16 + k * 12;
    const x = dv.getFloat32(o, true), z = dv.getFloat32(o + 4, true), r = dv.getUint8(o + 10);
    const ci = Math.min(nc - 1, Math.max(0, Math.floor((x - x0) / CELL))), cj = Math.min(nc - 1, Math.max(0, Math.floor((z - z0) / CELL)));
    const bk = ci * nc + cj;
    let b = bins.get(bk); if (!b) bins.set(bk, (b = [])); b.push([r, buf.subarray(o, o + 12).toString('hex')]);
  }
  const frac = Math.min(1, density / fileD);
  const out = new Map();
  for (const [bk, list] of bins) {
    const ord = new Uint32Array(list.length).map((_, k) => k).sort((a, c) => list[a][0] - list[c][0]);
    const cnt = frac >= 1 ? list.length : Math.max(1, Math.round(list.length * frac));
    out.set(bk, Array.from(ord.subarray(0, cnt), (k) => list[k][1]).join(','));
  }
  return out;
}

for (const map of ['sf', 'ist']) {
  const dir = path.join(ROOT, 'assets', map);
  const pj = path.join(dir, 'packs.json');
  if (!fs.existsSync(pj)) { console.log(`(${map}: no packs.json, skipped)`); continue; }
  const packs = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const at = (rel) => path.join(dir, rel);
  // 1. freshness + files
  const stale = Object.entries(packs.sources || {}).filter(([r, h]) => !fs.existsSync(path.join(ROOT, r)) || sha(path.join(ROOT, r)) !== h).map(([r]) => r);
  check(`${map}: pack sources unchanged`, !stale.length, stale.slice(0, 5).join(', '));
  const t = packs.terrain || {}, c = packs.city || {};
  // 2. sizes
  if (t.waterDepthSmall) check(`${map}: water depth 2048²`, pngSize(at(t.waterDepthSmall)).join() === '2048,2048', pngSize(at(t.waterDepthSmall)).join());
  if (t.waterDepthTiny) check(`${map}: water depth 1024²`, pngSize(at(t.waterDepthTiny)).join() === '1024,1024', pngSize(at(t.waterDepthTiny)).join());
  const orig = JSON.parse(fs.readFileSync(path.join(dir, 'city', 'atlas', 'atlas.json'), 'utf8'));
  for (const [k, div] of [['atlasSmall', 2], ['atlasTiny', 4]]) {
    if (!c[k]) continue;
    const m = JSON.parse(fs.readFileSync(at(c[k] + 'atlas.json'), 'utf8'));
    const dims = Object.values(m.images).map((f) => webpSize(at(c[k] + f)).join('x'));
    check(`${map}: ${k} cells ${orig.cell / div}² in ${orig.size / div}² images`, m.cell === orig.cell / div && m.size === orig.size / div && m.grid === orig.grid && m.layers.length === orig.layers.length && dims.every((d) => d === `${m.size}x${m.size}`), dims.join(' '));
  }
  const gm = packs.airports && packs.airports.groundMobile;
  if (gm) {
    const dims = gm.files.map((f) => jpegSize(at(gm.dir + f)));
    check(`${map}: airport ground textures for phones / tablets ≤ ${gm.maxSize}²`, dims.every(([w, h]) => Math.max(w, h) === gm.maxSize), dims.map((d) => d.join('x')).join(' '));
  }
  // 3. tree models
  if (c.trees) {
    const lod1 = glbJson(at(c.trees.lod1)), lod0 = glbJson(at(c.trees.lod0));
    const names = (j) => new Set(j.nodes.map((n) => n.name));
    const n1 = names(lod1), n0 = names(lod0);
    check(`${map}: tree packs hold every species' two LODs`, c.trees.species.every((sp) => n1.has(`${sp}_lod1`) && n0.has(`${sp}_lod0`)));
    const srcOf = (tx) => (tx.source != null ? tx.source : tx.extensions && tx.extensions.EXT_texture_webp ? tx.extensions.EXT_texture_webp.source : -1);
    const farTex = new Set(lod1.textures.map((tx) => tx.name || (lod1.images[srcOf(tx)] || {}).name));
    const shared = lod0.materials.flatMap((mt) => Object.values((mt.extras && mt.extras.packShared) || {}));
    check(`${map}: near-LOD shared textures exist in the far pack`, shared.length > 0 && shared.every((nm) => farTex.has(nm)), shared.filter((nm) => !farTex.has(nm)).join(', '));
  }
  // shader pre-warm stand-ins: 1-triangle meshes for every kind of late material, placeholder textures only
  if (packs.prewarm) {
    const j = glbJson(at(packs.prewarm));
    const kinds = new Set(j.nodes.map((n) => n.extras && n.extras.prewarm));
    const tiny = j.accessors.every((a) => a.count <= 3);
    check(`${map}: pre-warm stand-ins (${j.nodes.length}: ${[...kinds].join(', ')})`, ['tree', 'building', 'landmark'].every((k) => kinds.has(k)) && tiny && (j.images || []).length <= 2);
  }
  // 4. thinned tree tiles (sample)
  const tmeta = JSON.parse(fs.readFileSync(path.join(dir, 'city', 'trees', 'trees.json'), 'utf8'));
  for (const e of c.treesLow || []) {
    const sample = tmeta.tiles.filter((_, k) => k % Math.max(1, Math.floor(tmeta.tiles.length / 25)) === 0);
    let bad = 0;
    for (const tile of sample) {
      const full = fs.readFileSync(path.join(dir, 'city', 'trees', `${tile.i}_${tile.j}.bin`));
      const low = fs.readFileSync(at(`${e.dir}/${tile.i}_${tile.j}.bin`));
      const a = runtimeSubset(full, tmeta.size, e.density), b = runtimeSubset(low, tmeta.size, e.density, e.density);
      if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) bad++;
    }
    check(`${map}: trees at density ${e.density}: thinned tiles = the runtime's subset (${sample.length} tiles)`, bad === 0, `${bad} differ`);
  }
  // 5. meshopt city tiles
  if (c.tiles) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'city', 'index.json'), 'utf8'));
    for (const L of index.levels) {
      const d = c.tiles[L.dir];
      if (!d) continue;
      let missing = 0, notMeshopt = 0, triDiff = 0;
      L.tiles.forEach((tile, k) => {
        const p = at(`${d}/${tile.i}_${tile.j}.glb`);
        if (!fs.existsSync(p)) { missing++; return; }
        if (k % 7) return;   // full JSON checks on a seventh of the tiles
        const j = glbJson(p), src = glbJson(path.join(dir, 'city', L.dir, `${tile.i}_${tile.j}.glb`));
        if (!(j.extensionsRequired || []).includes('EXT_meshopt_compression')) notMeshopt++;
        const tris = (g) => g.meshes.reduce((a, m) => a + m.primitives.reduce((b, pr) => b + g.accessors[pr.indices].count / 3, 0), 0);
        if (tris(j) !== tris(src)) triDiff++;
      });
      check(`${map}: meshopt ${L.dir} (${L.tiles.length} tiles)`, !missing && !notMeshopt && !triDiff, `missing ${missing}, not meshopt ${notMeshopt}, triangle counts differ ${triDiff}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
