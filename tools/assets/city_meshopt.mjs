#!/usr/bin/env node
// City tiles Draco → meshopt (runtime repackaging; the San Francisco city pipeline is not re-run). Every tile of
// assets/<map>/city/l0…l3 that is Draco-compressed (San Francisco; İstanbul's are meshopt already) is decoded and
// written again in the format of tools/geo/city_glb.py (the İstanbul tiles): EXT_meshopt_compression +
// KHR_mesh_quantization, POSITION / NORMAL / TEXCOORD_0 / TEXCOORD_1 (anchors, 'anchor' levels only) / TEXCOORD_2 as
// float32 through the meshopt EXPONENTIAL filter, COLOR_0 as normalised uint8 RGBA, vertices in cache / fetch order,
// meshopt TRIANGLES index codec. Why: meshopt decodes 10–30× faster than Draco (70 ms per tile on an M4 Max, 0.5 s
// with the CPU throttled 4×: the phone's heat while streaming San Francisco) and compresses much better under the
// edge's Brotli (Draco tiles are already entropy-coded: −5–10 %, meshopt −45–57 %).
// Outputs: assets/<map>/city/packs/meshopt/l<k>/<i>_<j>.glb + packs.json `city.tiles = { l0: 'city/packs/meshopt/l0', … }`
// (src/world-sf/city.js loads a level from there when listed). Originals are never touched.
//
// Precision (per level, mantissa bits of the shared-exponent filter; |v| ≤ 512 m → step = 2^(10 − bits + 1)):
//   POSITION 17/16/15/15 bits (1.6 / 3.1 / 6.3 cm), anchor 16, NORMAL 12, TEXCOORD_0 14 (facade repeats), TEXCOORD_2
//   16 (atlas layer: integers stay exact; per-building seed within 1/1024), COLOR_0 8-bit (tint 0.66–1.0).
//   --verify decodes every written tile and reports the largest deviation from the Draco-decoded source.
// usage: node tools/assets/city_meshopt.mjs [--map sf] [--levels 0,1,2,3] [--limit N] [--force] [--verify] [--jobs 8]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(HERE, 'package.json'));

const BITS = { 0: { P: 16, N: 8, UV: 14, A: 14, L: 12 }, 1: { P: 15, N: 8, UV: 13, A: 13, L: 12 }, 2: { P: 14, N: 8, UV: 12, A: 12, L: 12 }, 3: { P: 14, N: 8, UV: 12, A: 12, L: 12 } };
const F32 = 5126, U8 = 5121, U16 = 5123, U32 = 5125;

async function tools() {
  const { NodeIO } = await import(require.resolve('@gltf-transform/core'));
  const { ALL_EXTENSIONS } = await import(require.resolve('@gltf-transform/extensions'));
  const draco3d = require('draco3dgltf');
  const { MeshoptEncoder, MeshoptDecoder } = await import(require.resolve('meshoptimizer'));
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder });
  return { io, MeshoptEncoder, MeshoptDecoder };
}

/** Float32 copy of an accessor's elements (dequantised if normalised). */
function floats(acc) {
  const n = acc.getCount(), k = acc.getElementSize(), out = new Float32Array(n * k), e = [];
  for (let i = 0; i < n; i++) { acc.getElement(i, e); for (let j = 0; j < k; j++) out[i * k + j] = e[j]; }
  return out;
}

/** Decode the meshopt exponential filter output (for --verify): uint32 (int24 mantissa | int8 exponent << 24) → float. */
function expDecode(u8, count) {
  const u = new Uint32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4), out = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) { const v = u[i]; const m = (v << 8) >> 8, e = v >> 24; out[i] = m * 2 ** e; }
  void count;
  return out;
}

async function convertTile(T, src, dst, level, placement, verify) {
  const { io, MeshoptEncoder: E } = T;
  const doc = await io.read(src);
  const root = doc.getRoot();
  const node = root.listNodes().find((n) => n.getMesh());
  const prim = node.getMesh().listPrimitives()[0];
  if (node.getMesh().listPrimitives().length !== 1) throw new Error(`${src}: ${node.getMesh().listPrimitives().length} primitives`);
  const get = (s) => prim.getAttribute(s);
  const P0 = floats(get('POSITION')), n0 = get('POSITION').getCount();
  const N0 = floats(get('NORMAL')), UV0 = floats(get('TEXCOORD_0'));
  const A0 = placement === 'anchor' && get('TEXCOORD_1') ? floats(get('TEXCOORD_1')) : null;
  const L0 = get('TEXCOORD_2') ? floats(get('TEXCOORD_2')) : new Float32Array(n0 * 2);
  const colAcc = get('COLOR_0');
  const C0 = colAcc ? floats(colAcc) : null, ck = colAcc ? colAcc.getElementSize() : 0;
  const idxAcc = prim.getIndices();
  const I = new Uint32Array(idxAcc.getCount());
  for (let i = 0; i < I.length; i++) I[i] = idxAcc.getScalar(i);
  // vertex cache + fetch order (indices rewritten in place; unreferenced vertices dropped)
  const [remap, n] = E.reorderMesh(I, true, false);
  const re = (src0, k) => { const out = new Float32Array(n * k); for (let v = 0; v < n0; v++) { const r = remap[v]; if (r === 0xffffffff) continue; for (let j = 0; j < k; j++) out[r * k + j] = src0[v * k + j]; } return out; };
  const P = re(P0, 3), N = re(N0, 3), UV = re(UV0, 2), A = A0 ? re(A0, 2) : null, L = re(L0, 2);
  const C = new Uint8Array(n * 4);
  for (let v = 0; v < n0; v++) {
    const r = remap[v]; if (r === 0xffffffff) continue;
    for (let j = 0; j < 4; j++) C[r * 4 + j] = j < ck ? Math.max(0, Math.min(255, Math.round(C0[v * ck + j] * 255))) : 255;
  }
  const b = BITS[level] || BITS[0];
  const parts = [], views = [], accessors = [];
  let off = 0, fb = 0;
  const addView = (raw, count, stride, mode, filter, target) => {
    const enc = E.encodeGltfBuffer(raw, count, stride, mode);
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    const ext = { buffer: 0, byteOffset: off, byteLength: enc.length, byteStride: stride, mode, count };
    if (filter) ext.filter = filter;
    parts.push(Buffer.from(enc)); off += enc.length;
    const bv = { buffer: 1, byteOffset: fb, byteLength: count * stride, extensions: { EXT_meshopt_compression: ext }, target };
    if (mode === 'ATTRIBUTES') bv.byteStride = stride;   // (TRIANGLES: the index size stays in the extension's byteStride only)
    fb += Math.ceil((count * stride) / 4) * 4;
    views.push(bv);
    return views.length - 1;
  };
  const acc = (bv, ctype, count, type, extra = {}) => { accessors.push({ bufferView: bv, componentType: ctype, count, type, ...extra }); return accessors.length - 1; };
  const expView = (arr, k, bits) => { const u8 = E.encodeFilterExp(arr, n, k * 4, bits, 'SharedComponent'); return { u8, view: addView(u8, n, k * 4, 'ATTRIBUTES', 'EXPONENTIAL', 34962) }; };
  const attrs = {};
  const pv = expView(P, 3, b.P);
  const pd = expDecode(pv.u8, n);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) for (let j = 0; j < 3; j++) { const x = pd[v * 3 + j]; if (x < mn[j]) mn[j] = x; if (x > mx[j]) mx[j] = x; }
  attrs.POSITION = acc(pv.view, F32, n, 'VEC3', { min: mn, max: mx });
  const nv = expView(N, 3, b.N); attrs.NORMAL = acc(nv.view, F32, n, 'VEC3');
  const uv = expView(UV, 2, b.UV); attrs.TEXCOORD_0 = acc(uv.view, F32, n, 'VEC2');
  let av = null;
  if (A) { av = expView(A, 2, b.A); attrs.TEXCOORD_1 = acc(av.view, F32, n, 'VEC2'); }
  const lv = expView(L, 2, b.L); attrs.TEXCOORD_2 = acc(lv.view, F32, n, 'VEC2');
  attrs.COLOR_0 = acc(addView(C, n, 4, 'ATTRIBUTES', null, 34962), U8, n, 'VEC4', { normalized: true });
  let indices;
  if (n <= 65535) { const i16 = new Uint16Array(I); indices = acc(addView(new Uint8Array(i16.buffer), I.length, 2, 'TRIANGLES', null, 34963), U16, I.length, 'SCALAR'); }
  else indices = acc(addView(new Uint8Array(I.buffer), I.length, 4, 'TRIANGLES', null, 34963), U32, I.length, 'SCALAR');
  for (const v of views) if (v.extensions.EXT_meshopt_compression.mode === 'TRIANGLES') delete v.byteStride;
  const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
  const body = Buffer.concat(parts);
  const t = node.getTranslation();
  const gltf = {
    asset: { version: '2.0', generator: 'gokyuzu tools/assets/city_meshopt.mjs' },
    extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: node.getName(), translation: [t[0], t[1], t[2]] }],
    materials: [{ name: 'city', doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.8 } }],
    meshes: [{ name: node.getMesh().getName() || node.getName(), primitives: [{ attributes: attrs, indices, material: 0, mode: 4 }] }],
    accessors, bufferViews: views,
    buffers: [{ byteLength: body.length }, { byteLength: fb, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  let js = Buffer.from(JSON.stringify(gltf));
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + body.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(body.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([head, jh, js, bh, body]);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst + '.tmp', glb);
  fs.renameSync(dst + '.tmp', dst);
  const res = { src: fs.statSync(src).size, dst: glb.length, tris: I.length / 3 };
  if (verify) {
    // decode the written tile: every referenced source vertex against its new slot (remap), and the triangles as a
    // multiset (the cache optimisation reorders them; each keeps its corners and winding)
    const d2 = await io.readBinary(new Uint8Array(glb));
    const p2 = d2.getRoot().listMeshes()[0].listPrimitives()[0];
    const err = {};
    const cmp = (sem, a1, a2, k) => {
      if (!a1 || !a2) return;
      let e = 0; const x = [], y = [];
      for (let v = 0; v < n0; v++) { const r = remap[v]; if (r === 0xffffffff) continue; a1.getElement(v, x); a2.getElement(r, y); for (let j = 0; j < k; j++) e = Math.max(e, Math.abs(x[j] - y[j])); }
      err[sem] = e;
    };
    cmp('POSITION', get('POSITION'), p2.getAttribute('POSITION'), 3);
    cmp('NORMAL', get('NORMAL'), p2.getAttribute('NORMAL'), 3);
    cmp('TEXCOORD_0', get('TEXCOORD_0'), p2.getAttribute('TEXCOORD_0'), 2);
    if (A) cmp('TEXCOORD_1', get('TEXCOORD_1'), p2.getAttribute('TEXCOORD_1'), 2);
    cmp('TEXCOORD_2', get('TEXCOORD_2'), p2.getAttribute('TEXCOORD_2'), 2);
    cmp('COLOR_0', colAcc, p2.getAttribute('COLOR_0'), Math.min(ck, 3));
    const canon = (a, b2, c) => (a <= b2 && a <= c ? `${a},${b2},${c}` : b2 <= a && b2 <= c ? `${b2},${c},${a}` : `${c},${a},${b2}`);
    const tri = new Map();
    for (let t = 0; t < idxAcc.getCount(); t += 3) { const k = canon(remap[idxAcc.getScalar(t)], remap[idxAcc.getScalar(t + 1)], remap[idxAcc.getScalar(t + 2)]); tri.set(k, (tri.get(k) || 0) + 1); }
    const i2 = p2.getIndices();
    let bad = i2.getCount() !== idxAcc.getCount() ? 1 : 0;
    for (let t = 0; t < i2.getCount(); t += 3) { const k = canon(i2.getScalar(t), i2.getScalar(t + 1), i2.getScalar(t + 2)); const c = tri.get(k); if (!c) bad++; else tri.set(k, c - 1); }
    err.badTriangles = bad;
    res.err = err;
  }
  return res;
}

// ------------------------------------------------------------------ worker pool
if (!isMainThread) {
  const T = await tools();
  parentPort.on('message', async (job) => {
    try { parentPort.postMessage({ id: job.id, ok: true, res: await convertTile(T, job.src, job.dst, job.level, job.placement, job.verify) }); } catch (e) { parentPort.postMessage({ id: job.id, ok: false, error: String(e && e.stack || e) }); }
  });
} else {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const map = opt('--map', 'sf');
  const levels = opt('--levels', '0,1,2,3').split(',').map(Number);
  const limit = Number(opt('--limit', 0));
  const force = argv.includes('--force'), verify = argv.includes('--verify');
  const jobsN = Number(opt('--jobs', Math.max(1, Math.min(8, os.cpus().length - 2))));
  const cityDir = path.join(ROOT, 'assets', map, 'city');
  const index = JSON.parse(fs.readFileSync(path.join(cityDir, 'index.json'), 'utf8'));
  const todo = [];
  const outDirs = {};
  for (const L of index.levels) {
    if (!levels.includes(L.level)) continue;
    const out = `city/packs/meshopt/${L.dir}`;
    outDirs[L.dir] = out;
    let k = 0;
    for (const t of L.tiles) {
      const src = path.join(cityDir, L.dir, `${t.i}_${t.j}.glb`);
      if (!fs.existsSync(src)) continue;
      const head = fs.readFileSync(src).subarray(0, 4096).toString('latin1');
      if (!head.includes('KHR_draco_mesh_compression')) continue;   // already meshopt (İstanbul) or plain
      const dst = path.join(ROOT, 'assets', map, out, `${t.i}_${t.j}.glb`);
      if (!force && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
      todo.push({ src, dst, level: L.level, placement: L.placement, verify });
      if (limit && ++k >= limit) break;
    }
  }
  console.log(`${map}: ${todo.length} tiles to convert with ${jobsN} workers`);
  const t0 = Date.now();
  const stats = { n: 0, src: 0, dst: 0, tris: 0, err: {}, fails: 0 };
  const workers = Array.from({ length: Math.min(jobsN, todo.length) }, () => new Worker(fileURLToPath(import.meta.url)));
  let next = 0;
  await Promise.all(workers.map((w) => new Promise((resolve) => {
    const feed = () => { if (next >= todo.length) { w.terminate(); resolve(); return; } const id = next++; w.postMessage({ id, ...todo[id] }); };
    w.on('message', (m) => {
      if (m.ok) {
        stats.n++; stats.src += m.res.src; stats.dst += m.res.dst; stats.tris += m.res.tris;
        for (const [k, v] of Object.entries(m.res.err || {})) stats.err[k] = Math.max(stats.err[k] || 0, v);
      } else { stats.fails++; console.error(m.error); }
      if (stats.n % 250 === 0) console.log(`  ${stats.n}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      feed();
    });
    w.on('error', (e) => { console.error(e); stats.fails++; resolve(); });
    feed();
  })));
  console.log(`${map}: ${stats.n} tiles in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(stats.src / 1e6).toFixed(1)} MB Draco → ${(stats.dst / 1e6).toFixed(1)} MB meshopt, ${stats.fails} failed${verify ? `; max deviation ${JSON.stringify(Object.fromEntries(Object.entries(stats.err).map(([k, v]) => [k, +v.toPrecision(3)])))}` : ''}`);
  // packs.json: list the converted levels (every tile of a level must exist before the game switches that level)
  const packsPath = path.join(ROOT, 'assets', map, 'packs.json');
  const packs = fs.existsSync(packsPath) ? JSON.parse(fs.readFileSync(packsPath, 'utf8')) : { version: 2, terrain: {}, city: {} };
  packs.city = packs.city || {};
  const tiles = { ...(packs.city.tiles || {}) };
  for (const L of index.levels) {
    const dir = outDirs[L.dir];
    if (!dir) continue;
    const missing = L.tiles.filter((t) => !fs.existsSync(path.join(ROOT, 'assets', map, dir, `${t.i}_${t.j}.glb`)) && fs.readFileSync(path.join(cityDir, L.dir, `${t.i}_${t.j}.glb`)).subarray(0, 4096).toString('latin1').includes('KHR_draco'));
    if (!missing.length && fs.existsSync(path.join(ROOT, 'assets', map, dir))) tiles[L.dir] = dir; else console.log(`  ${L.dir}: ${missing.length} tiles not converted yet: not listed`);
  }
  if (Object.keys(tiles).length) {
    packs.city.tiles = tiles;
    fs.writeFileSync(packsPath, JSON.stringify(packs, null, 1) + '\n');
    console.log(`packs.json city.tiles = ${JSON.stringify(tiles)}`);
  }
  if (stats.fails) process.exit(1);
}
