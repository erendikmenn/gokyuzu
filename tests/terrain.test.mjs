// Terrain height files (src/world-sf/terrain-heights.js, built by tools/geo/terrain_heightfiles.py). Run: node tests/terrain.test.mjs
// 1. synthetic tiles (extreme and wrapping values) through a JS copy of the encoder -> the decoder returns the same bytes
// 2. with the built data present (assets/ is not in git): every index node has a height file entry, and sampled tiles
//    of every level decode to exactly the bytes of the h/<L>.bin level packs (so heights, water flags and sun
//    visibility, i.e. collisions, getGroundHeight and the rendered mesh, are unchanged); fflate (the fallback for
//    browsers without DecompressionStream) inflates the files like zlib does
import fs from 'node:fs';
import zlib from 'node:zlib';
import { NS, NV, WB, TILE_BYTES, parseHeightFile, decodeTile, heightFileOf } from '../src/world-sf/terrain-heights.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const TERRAIN = new URL('../assets/sf/terrain/', import.meta.url);

// ---- encoder (same transform as tools/geo/terrain_heightfiles.py encode_tile / pack_group)
function pred(a, k, x, y, w) { return y === 0 ? (x === 0 ? 0 : a[k - 1]) : x === 0 ? a[k - w] : a[k - 1] + a[k - w] - a[k - w - 1]; }
function encodeTile(rec) {
  const src = new Uint8Array(rec), out = new Uint8Array(TILE_BYTES);
  out.set(src.subarray(0, 8), 0);
  const n = NS * NS, v = new Uint16Array(rec, 8, n);
  for (let y = 0, k = 0; y < NS; y++) for (let x = 0; x < NS; x++, k++) {
    let r = (v[k] - pred(v, k, x, y, NS)) & 0xffff;
    if (r >= 32768) r -= 65536;
    const z = r >= 0 ? 2 * r : -2 * r - 1;
    out[8 + k] = z >> 8; out[8 + n + k] = z & 255;
  }
  out.set(src.subarray(8 + 2 * n, 8 + 2 * n + WB), 8 + 2 * n);
  const s = src.subarray(8 + 2 * n + WB);
  for (let y = 0, k = 0; y < NV; y++) for (let x = 0; x < NV; x++, k++) out[8 + 2 * n + WB + k] = (s[k] - pred(s, k, x, y, NV)) & 255;
  return out;
}
function packGroup(tiles) {   // [{ di, dj, rec }] -> inflated file bytes (as the browser sees them after DecompressionStream)
  let head = 4 + 2 * tiles.length;
  head += (4 - (head & 3)) & 3;
  const buf = new Uint8Array(head + tiles.length * TILE_BYTES);
  new DataView(buf.buffer).setUint16(0, tiles.length, true);
  tiles.forEach((t, k) => { buf[4 + 2 * k] = t.di; buf[5 + 2 * k] = t.dj; buf.set(encodeTile(t.rec), head + k * TILE_BYTES); });
  return buf.buffer;
}

// ---- 1. synthetic tiles
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const makeTile = (fill) => {
    const rec = new ArrayBuffer(TILE_BYTES), u8 = new Uint8Array(rec);
    new Float32Array(rec, 0, 2).set([-12.345, 0.0123]);
    const v = new Uint16Array(rec, 8, NS * NS);
    for (let k = 0; k < v.length; k++) v[k] = fill(k % NS, Math.floor(k / NS), k);
    for (let k = 8 + NS * NS * 2; k < TILE_BYTES; k++) u8[k] = Math.floor(rnd() * 256);   // water bits + sun visibility
    return rec;
  };
  const kinds = {
    'random 0..65535': () => Math.floor(rnd() * 65536),
    'alternating 0 / 65535 (predictor wraps)': (x, y) => ((x + y) & 1 ? 65535 : 0),
    'smooth ramp': (x, y) => Math.round((x * 700 + y * 280) % 65536),
    'constant 65535': () => 65535,
    'checkerboard blocks + noise': (x, y) => (((x >> 3) + (y >> 3)) & 1 ? 60000 : 3000) + Math.floor(rnd() * 900),
  };
  const tiles = Object.entries(kinds).map(([name, f], i) => ({ name, di: i & 1, dj: (i >> 1) & 1, rec: makeTile(f) }));
  // four tiles in one file (a full sibling group), the fifth alone (like the root file)
  for (const group of [tiles.slice(0, 4), tiles.slice(4)]) {
    const file = packGroup(group);
    const map = parseHeightFile(file);
    check(`synthetic: header of a ${group.length}-tile file lists every tile`, map.size === group.length, `${map.size}`);
    for (const t of group) {
      const off = map.get((t.dj << 8) | t.di);
      const out = off === undefined ? null : decodeTile(new Uint8Array(file), off);
      check(`synthetic: ${t.name} decodes bit-exactly`, out && Buffer.from(out).equals(Buffer.from(t.rec)));
    }
  }
  const file = packGroup(tiles.slice(0, 4));
  let threw = false;
  try { parseHeightFile(file.slice(0, file.byteLength - 1)); } catch { threw = true; }
  check('synthetic: a truncated file is rejected', threw);
  check('heightFileOf: tile -> file of its parent + position', (() => {
    const a = heightFileOf({ dir: 'hz', group: 1 }, 10, 1235, 776);
    return a.path === 'hz/10/617_388.bin' && a.key === ((0 << 8) | 1);
  })());
}

// ---- 2. built data
const indexPath = new URL('index.json', TERRAIN);
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;
if (!index || !index.heightFiles || !fs.existsSync(new URL('h/0.bin', TERRAIN))) {
  console.log('SKIP  built data checks (assets/sf/terrain with h/ and hz/ not present: run tools/geo/terrain_pinpack.py)');
} else {
  const hf = index.heightFiles;
  check('index: height files format 1, tile record size as in the packs', hf.format === 1 && index.tileBytes === TILE_BYTES, JSON.stringify(hf));
  // every node -> an existing file (existence of all files; header entries checked for the sampled files below)
  const rank = {}, byFile = new Map();
  let missing = 0;
  for (const [L, i, j] of index.nodes) {
    const r = (rank[L] = (rank[L] ?? -1) + 1);
    const { path, key } = heightFileOf(hf, L, i, j);
    if (!byFile.has(path)) { byFile.set(path, []); if (!fs.existsSync(new URL(path, TERRAIN))) missing++; }
    byFile.get(path).push({ L, i, j, rank: r, key });
  }
  check(`index: all ${index.nodes.length} nodes have a height file (${byFile.size} files)`, missing === 0, `${missing} missing`);
  // sample: every 29th file, plus the first and last file of each level
  const files = [...byFile.keys()];
  const pick = new Set(files.filter((_, k) => k % 29 === 0));
  const perLevel = {};
  for (const f of files) { const L = f.split('/')[1]; (perLevel[L] ||= []).push(f); }
  for (const list of Object.values(perLevel)) { pick.add(list[0]); pick.add(list[list.length - 1]); }
  const { unzlibSync } = await import('../node_modules/three/examples/jsm/libs/fflate.module.js');
  const fds = {};
  let tiles = 0, exact = 0, keysOk = 0, fflateOk = 0;
  for (const path of pick) {
    const z = fs.readFileSync(new URL(path, TERRAIN));
    const raw = zlib.inflateSync(z);
    if (Buffer.from(unzlibSync(new Uint8Array(z))).equals(raw)) fflateOk++;
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const map = parseHeightFile(buf), bytes = new Uint8Array(buf);
    const nodes = byFile.get(path);
    if (map.size === nodes.length && nodes.every((n) => map.has(n.key))) keysOk++;
    for (const n of nodes) {
      tiles++;
      const fd = (fds[n.L] ??= fs.openSync(new URL(`h/${n.L}.bin`, TERRAIN), 'r'));
      const ref = Buffer.alloc(TILE_BYTES);
      fs.readSync(fd, ref, 0, TILE_BYTES, n.rank * TILE_BYTES);
      const off = map.get(n.key);
      if (off !== undefined && Buffer.from(decodeTile(bytes, off)).equals(ref)) exact++;
    }
  }
  for (const fd of Object.values(fds)) fs.closeSync(fd);
  check(`data: ${pick.size} sampled files list exactly their tiles`, keysOk === pick.size, `${keysOk}/${pick.size}`);
  check(`data: ${tiles} sampled tiles (all levels) decode to the h/<L>.bin bytes`, tiles > 0 && exact === tiles, `${exact}/${tiles}`);
  check('data: fflate (no DecompressionStream) inflates like zlib', fflateOk === pick.size, `${fflateOk}/${pick.size}`);
}

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
