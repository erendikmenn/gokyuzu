#!/usr/bin/env node
// KTX2 (Basis Universal) textures for the exported GLBs: aircraft (exterior, cockpit, LOD), landmarks, airport buildings.
// Post-processes the files the Blender scripts write, in place, so it runs after any export (idempotent, cached):
//   - every embedded JPEG / PNG / WebP texture ≥ 128² → KTX2 (KHR_texture_basisu) at its own size (no downscale) with
//     a full box-filtered mip chain, sRGB transfer for colour maps and linear for data / normal maps; the codec per
//     texture follows lib/policy.mjs: ETC1S where the decoded result passes a quality gate (colour / data maps), else
//     UASTC (+ mild RDO when it stays above a floor); normal maps UASTC; every result is decoded and measured
//     against its source (PSNR / SSIM / worst tile / normal angle error, in --report)
//   - geometry and every other buffer (Draco, meshopt, animation) are copied byte for byte
//   - airport textures used by several GLBs go to assets/sf/airports/shared/*.ktx2 (one download, one GPU copy)
//   - GLBs with textures > 1024² also get <name>.phone.glb (top mip levels dropped, listed in assets/phone-variants.json)
//     for phones, which cap textures at 1024² anyway (src/core/assets.js loads the variant on phones)
//   - the exported original is kept as <dir>/_orig/<name>.glb (not published: build_dist skips `_` directories) so a
//     policy change re-encodes from the source, and `--restore` puts it back (Blender re-imports, renders)
// Encoded textures are cached by content + settings in tools/assets/.cache/, so a re-run after one export only encodes
// the changed images. Setup once: node tools/assets/setup.mjs (npm packages + the pinned KTX-Software `ktx` encoder)
//
// usage: node tools/assets/textures.mjs [--root <repo>] [--only <path part>] [--jobs N] [--force] [--check] [--dry]
//                                       [--restore] [--colour uastc|auto|etc1s] [--report <file.json>]
//   --check    exit 1 when a GLB still has convertible textures or is out of date (for the publish build: a fresh
//              Blender export must be converted before it ships, or phones would get a stale .phone.glb)
//   --dry      analyse and print the plan, write nothing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readGlb, writeGlb, imageBytes, relayoutBuffer, materialSlots, textureSource, writeFileAtomic } from './lib/glb.mjs';
import { PIPELINE_VERSION, MAX_SIZE, MIN_TEXELS, FAMILIES, POLICY_FAMILIES, PROFILES, UASTC, ETC1S, ETC1S_GATE, GROWTH_GUARD, PHONE_SIZE, PHONE_MANIFEST, tooBig } from './lib/policy.mjs';
import { dropLevels } from './lib/ktx2.mjs';
import { KTX_BIN, ktxVersion } from './setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const ROOT = path.resolve(opt('--root', path.join(HERE, '../..')));
const ONLY = opt('--only', '');
const JOBS = Math.max(1, Number(opt('--jobs', 4)));
const THREADS = Math.max(1, Math.floor(os.cpus().length / JOBS));   // ktx create threads per job
const FORCE = flag('--force'), CHECK = flag('--check'), DRY = flag('--dry') || CHECK, RESTORE = flag('--restore');
const COLOUR = opt('--colour', '');
const REPORT = opt('--report', '');
const CACHE = path.join(HERE, '.cache', 'ktx2');
const EXT = 'KHR_texture_basisu';
const SKIP_DIRS = /^(_|\.)|^(tex|src|render|renders|dev|bake|build|raw|ref|before|shared)$/;

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const SETTINGS = JSON.stringify({ PIPELINE_VERSION, MAX_SIZE, UASTC, ETC1S, ETC1S_GATE, PROFILES });
const GUARD = JSON.stringify(GROWTH_GUARD);
const policyKey = sha1(JSON.stringify({ SETTINGS, GUARD, PHONE_SIZE, MIN_TEXELS, FAMILIES: POLICY_FAMILIES.map((f) => ({ ...f, profile: String(f.profile) })), COLOUR })).slice(0, 12);
const MB = (b) => (b / 1048576).toFixed(2);

// ---------------------------------------------------------------- discovery

function listGlbs(fam) {
  const out = [];
  const walk = (dir, depth) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (depth > 1 && !SKIP_DIRS.test(e.name)) walk(path.join(dir, e.name), depth - 1); }
      else if (e.isFile() && e.name.endsWith('.glb') && !e.name.endsWith('.phone.glb')) out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(ROOT, fam.dir), fam.depth);
  return out.sort().filter((f) => !ONLY || path.relative(ROOT, f).includes(ONLY));
}
const origPath = (file) => path.join(path.dirname(file), '_orig', path.basename(file));
const phonePath = (file) => file.replace(/\.glb$/, '.phone.glb');
const stateOf = (json) => (json.asset && json.asset.extras && json.asset.extras.gokyuzuKtx2) || null;

/** Per image: how it is sampled (colour / normal / data) and by which materials. */
function imageUse(json) {
  const use = new Map();
  for (const m of json.materials || []) for (const s of materialSlots(m)) {
    const t = json.textures && json.textures[s.index];
    if (!t) continue;
    const src = textureSource(t);
    if (src == null) continue;
    let u = use.get(src);
    if (!u) use.set(src, (u = { kinds: new Set(), materials: new Set(), clamp: false }));
    u.kinds.add(s.kind);
    u.materials.add(m.name || '');
    const smp = t.sampler != null && json.samplers ? json.samplers[t.sampler] || {} : {};
    if ((smp.wrapS != null && smp.wrapS !== 10497) || (smp.wrapT != null && smp.wrapT !== 10497)) u.clamp = true;   // 10497 = REPEAT (glTF default)
  }
  return use;
}

const sharp = createRequire(import.meta.url)('sharp');
async function dims(bytes) {
  const m = await sharp(bytes, { limitInputPixels: false }).metadata();
  return { w: m.width, h: m.height };
}

/** The conversion plan of one GLB source: which images become KTX2 and how. */
async function planGlb(fam, file, src) {
  const { json, bin } = readGlb(src);
  const use = imageUse(json);
  const items = [];
  for (let i = 0; i < (json.images || []).length; i++) {
    const im = json.images[i];
    const bytes = imageBytes(json, bin, i);
    const u = use.get(i);
    const why = (reason) => items.push({ i, name: im.name || `image${i}`, keep: reason });
    if (!bytes) { why(im.mimeType === 'image/ktx2' ? 'already KTX2' : 'external or missing'); continue; }
    if (!/^image\/(jpeg|png|webp)$/.test(im.mimeType || '')) { why(`mime ${im.mimeType}`); continue; }
    if (!u) { why('unused by materials'); continue; }
    const kinds = [...u.kinds];
    const lin = kinds.filter((k) => k !== 'color');
    if (lin.length && kinds.includes('color')) { why('used as colour and data'); continue; }
    const { w, h } = await dims(bytes);
    const s = Math.min(1, MAX_SIZE / Math.max(w, h));
    const cw = Math.round(w * s), ch = Math.round(h * s);
    if (w * h < MIN_TEXELS) { why(`small ${w}x${h}`); continue; }
    if (cw % 4 || ch % 4) { why(`size ${cw}x${ch} not a multiple of 4`); continue; }
    const kind = kinds.includes('normal') ? 'normal' : lin.length ? 'data' : 'color';
    const profile = fam.profile(path.basename(file));
    const colour = kind === 'normal' ? 'uastc' : COLOUR || (kind === 'data' ? PROFILES[profile].data : PROFILES[profile].colour);
    items.push({ i, name: im.name || `image${i}`, bytes, hash: sha1(bytes), kind, colour, profile, wrap: !u.clamp, w, h, cw, ch, srcMime: im.mimeType });
  }
  return { json, bin, items };
}

// ---------------------------------------------------------------- encoding (worker pool + cache)

function createPool(n) {
  const workers = [], idle = [], queue = [], waiting = new Map();
  let seq = 0;
  for (let k = 0; k < n; k++) {
    const w = new Worker(new URL('./lib/worker.mjs', import.meta.url));
    w.on('message', (m) => { const cb = waiting.get(m.id); waiting.delete(m.id); idle.push(w); pump(); cb(m); });
    w.on('error', (e) => { console.error('worker error', e); process.exit(2); });
    workers.push(w); idle.push(w);
  }
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const { msg, cb } = queue.shift();
      waiting.set(msg.id, cb);
      w.postMessage(msg);
    }
  }
  return {
    run(msg) { return new Promise((resolve) => { queue.push({ msg: { ...msg, id: ++seq }, cb: resolve }); pump(); }); },
    close() { for (const w of workers) w.terminate(); },
  };
}

const jobKey = (it) => sha1(`${it.hash}|${it.kind}|${it.colour}|${it.profile}|${it.wrap}|${SETTINGS}`).slice(0, 20);

async function encodeAll(items) {
  fs.mkdirSync(CACHE, { recursive: true });
  const byKey = new Map();
  for (const it of items) { it.key = jobKey(it); if (!byKey.has(it.key)) byKey.set(it.key, it); }
  const results = new Map();
  const todo = [];
  for (const [key, it] of byKey) {
    const k = path.join(CACHE, `${key}.ktx2`), j = path.join(CACHE, `${key}.json`);
    if (fs.existsSync(k) && fs.existsSync(j)) results.set(key, { ...JSON.parse(fs.readFileSync(j, 'utf8')), ktx2: fs.readFileSync(k), cached: true });
    else todo.push(it);
  }
  if (todo.length) {
    const pool = createPool(Math.min(JOBS, todo.length));
    let done = 0;
    const t0 = Date.now();
    await Promise.all(todo.map(async (it) => {
      const r = await pool.run({ bytes: it.bytes, kind: it.kind, maxSize: MAX_SIZE, colour: it.colour, profile: it.profile, wrap: it.wrap, threads: THREADS });
      if (r.error) throw new Error(`${it.name}: ${r.error}`);
      const ktx2 = Buffer.from(r.ktx2);
      const meta = { mode: r.mode, rdo: r.rdo, width: r.width, height: r.height, srcW: r.srcW, srcH: r.srcH, alpha: r.alpha, q: r.q, tried: r.tried, ms: r.ms, kind: it.kind };
      fs.writeFileSync(path.join(CACHE, `${it.key}.ktx2`), ktx2);
      fs.writeFileSync(path.join(CACHE, `${it.key}.json`), JSON.stringify(meta));
      results.set(it.key, { ...meta, ktx2 });
      done++;
      process.stdout.write(`\r  encoded ${done}/${todo.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
    }));
    process.stdout.write('\n');
    pool.close();
  }
  return results;
}

// ---------------------------------------------------------------- GLB rewrite

function rewrite(json, bin, items, results, sharedUri, pick = (r) => r.ktx2) {
  const replace = new Map(), drop = new Set();
  let converted = 0;
  for (const it of items) {
    if (it.keep) continue;
    const r = results.get(it.key);
    const im = json.images[it.i];
    const uri = sharedUri.get(it.hash);
    if (uri) {
      // referenced by URI: the bufferView holding the old image is dropped (images never share bufferViews here)
      const bvUsers = json.images.filter((x) => x.bufferView === im.bufferView).length;
      if (bvUsers === 1) drop.add(im.bufferView);
      delete im.bufferView;
      im.uri = uri;
    } else replace.set(im.bufferView, Buffer.from(pick(r)));
    im.mimeType = 'image/ktx2';
    for (const t of json.textures || []) {
      if (textureSource(t) !== it.i) continue;
      const ext = { ...(t.extensions || {}) };
      delete ext.EXT_texture_webp; delete ext.EXT_texture_avif;
      ext[EXT] = { source: it.i };
      t.extensions = ext;
      delete t.source;
    }
    converted++;
  }
  // extensions: KHR_texture_basisu required; WebP/AVIF only while a texture still uses them
  const used = new Set(json.extensionsUsed || []), req = new Set(json.extensionsRequired || []);
  used.add(EXT); req.add(EXT);
  for (const e of ['EXT_texture_webp', 'EXT_texture_avif']) {
    if (!(json.textures || []).some((t) => t.extensions && t.extensions[e])) { used.delete(e); req.delete(e); }
  }
  json.extensionsUsed = [...used];
  json.extensionsRequired = [...req];
  const newBin = relayoutBuffer(json, bin, replace, drop);
  return { newBin, converted };
}

// ---------------------------------------------------------------- GPU memory estimate (for the report)

const mipBytes = (w, h, bpt) => { let s = 0; for (;;) { s += Math.max(1, w) * Math.max(1, h) * bpt; if (w <= 1 && h <= 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); } return s; };
/** RGBA8 + mips of the source today (desktop class: no runtime cap below 4096). */
const gpuBefore = (it) => mipBytes(it.w, it.h, 4);
/** Block-compressed after transcoding: UASTC → ASTC 4x4 / BC7 = 1 B/texel; ETC1S → ETC1/ETC2 0.5 B/texel (Apple,
 *  mobile) or BC7 1 B/texel (Windows); `worst` uses 1 B/texel for both. */
const gpuAfter = (r, worst = false) => mipBytes(r.width, r.height, r.mode === 'etc1s' && !r.alpha && !worst ? 0.5 : 1);

// ---------------------------------------------------------------- download guard / shared textures

/** Keep the source image when its KTX2 would grow the download too much for what it saves (lib/policy.mjs). */
function guard(items, results) {
  for (const it of items) {
    if (it.keep) continue;
    const r = results.get(it.key || (it.key = jobKey(it)));
    if (r && tooBig(it.profile, it.bytes.length, r.ktx2.length)) it.keep = `KTX2 ${Math.round(r.ktx2.length / 1024)} KB vs ${Math.round(it.bytes.length / 1024)} KB source`;
  }
}

/** Textures converted in several GLBs of a family → shared/<name>.ktx2 (hash → URI). */
function sharedUris(entries) {
  const users = new Map(), uris = new Map(), names = new Map();
  for (const e of entries) for (const it of e.plan.items) if (!it.keep) users.set(it.hash, (users.get(it.hash) || new Set()).add(e.file));
  for (const e of entries) for (const it of e.plan.items) {
    if (it.keep || users.get(it.hash).size < 2 || uris.has(it.hash)) continue;
    let base = it.name.replace(/[^\w.-]+/g, '_');
    if (names.has(base) && names.get(base) !== it.hash) base += `_${it.hash.slice(0, 8)}`;
    names.set(base, it.hash);
    uris.set(it.hash, `shared/${base}.ktx2`);
  }
  return uris;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!RESTORE && !DRY && !ktxVersion()) { console.error(`ktx (KTX-Software) missing at ${KTX_BIN}: run node tools/assets/setup.mjs`); process.exit(2); }
  const report = { root: ROOT, policy: policyKey, version: PIPELINE_VERSION, glbs: [], shared: [] };
  const outOfDate = [];
  for (const fam of FAMILIES) {
    const files = listGlbs(fam);
    if (RESTORE) {
      for (const f of files) if (fs.existsSync(origPath(f))) { writeFileAtomic(f, fs.readFileSync(origPath(f))); fs.rmSync(phonePath(f), { force: true }); console.log('restored', path.relative(ROOT, f)); }
      continue;
    }
    // sources: the exported original of every GLB (the current file, or _orig/ once converted)
    const entries = [];
    for (const f of files) {
      const cur = fs.readFileSync(f);
      const st = stateOf(readGlb(cur).json);
      let src = cur, fromOrig = false;
      if (st) {
        const o = origPath(f);
        if (!fs.existsSync(o)) { console.warn(`! ${path.relative(ROOT, f)}: converted but ${path.relative(ROOT, o)} is missing; left as is`); continue; }
        src = fs.readFileSync(o); fromOrig = true;
        if (sha1(src).slice(0, 16) !== st.src) { console.warn(`! ${path.relative(ROOT, f)}: _orig does not match the converted file; left as is`); continue; }
      }
      const upToDate = !!st && st.policy === policyKey;
      entries.push({ file: f, cur, src, fromOrig, st, upToDate, plan: await planGlb(fam, f, src) });
    }
    const needs = entries.filter((e) => (FORCE || !e.upToDate) && e.plan.items.some((it) => !it.keep));
    for (const e of entries) if (!e.upToDate && e.plan.items.some((it) => !it.keep)) outOfDate.push(path.relative(ROOT, e.file));
    // a shared texture set spans the family: re-process all of it when any member changed
    const work = fam.share && needs.length ? entries.filter((e) => e.plan.items.some((it) => !it.keep)) : needs;
    let sharedUri = fam.share ? sharedUris(entries) : new Map();
    const items = work.flatMap((e) => e.plan.items.filter((it) => !it.keep));
    if (DRY) {
      if (CHECK) continue;
      for (const e of entries) {
        const conv = e.plan.items.filter((it) => !it.keep);
        console.log(`${e.upToDate ? '=' : '*'} ${path.relative(ROOT, e.file)}  ${conv.length} to KTX2, ${e.plan.items.length - conv.length} kept`);
        for (const it of e.plan.items) console.log(`    ${it.keep ? 'keep ' : 'ktx2 '} ${it.name}${it.keep ? ` (${it.keep})` : ` ${it.w}x${it.h}→${it.cw}x${it.ch} ${it.kind} ${it.colour}${sharedUri.has(it.hash) ? ' shared' : ''}`}`);
      }
      continue;
    }
    if (!items.length) { console.log(`${fam.id}: ${entries.length} GLBs up to date`); continue; }
    console.log(`${fam.id}: ${work.length} GLBs, ${items.length} textures (${new Set(items.map((it) => it.hash)).size} unique)`);
    const results = await encodeAll(items);
    // download guard, then the shared set of what is really converted
    for (const e of entries) guard(e.plan.items, results);
    if (fam.share) sharedUri = sharedUris(entries);
    // shared files first (a GLB never points at a file that is not there yet)
    if (sharedUri.size) {
      const sdir = path.join(ROOT, fam.dir, 'shared');
      fs.mkdirSync(sdir, { recursive: true });
      const keep = new Set();
      for (const it of items) {
        const uri = sharedUri.get(it.hash);
        if (!uri || keep.has(uri)) continue;
        keep.add(uri);
        const dst = path.join(ROOT, fam.dir, uri);
        const r = results.get(it.key);
        if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(r.ktx2)) writeFileAtomic(dst, r.ktx2);
        report.shared.push({ uri: path.join(fam.dir, uri), bytes: r.ktx2.length, mode: r.mode });
      }
      for (const f of fs.readdirSync(sdir)) if (f.endsWith('.ktx2') && !keep.has(`shared/${f}`)) fs.rmSync(path.join(sdir, f));
    }
    for (const e of work) {
      const { json, bin, items: its } = await planGlb(fam, e.file, e.src);   // fresh copy of the JSON to edit
      for (const it of its) if (!it.keep) it.key = jobKey(it);
      guard(its, results);
      const { newBin, converted } = rewrite(json, bin, its, results, sharedUri);
      json.asset = json.asset || { version: '2.0' };
      json.asset.extras = { ...(json.asset.extras || {}), gokyuzuKtx2: { v: PIPELINE_VERSION, policy: policyKey, src: sha1(e.src).slice(0, 16), converted, kept: its.length - converted } };
      const out = writeGlb(json, newBin);
      // phone variant: the same GLB with embedded KTX2 textures cut to PHONE_SIZE (only when one is larger)
      const ph = await planGlb(fam, e.file, e.src);
      for (const it of ph.items) if (!it.keep) it.key = jobKey(it);
      guard(ph.items, results);
      const cut = new Map();
      const pick = (r) => { if (!cut.has(r)) cut.set(r, dropLevels(r.ktx2, PHONE_SIZE)); return cut.get(r); };
      const phRw = rewrite(ph.json, ph.bin, ph.items, results, sharedUri, pick);
      const phoneSmaller = [...cut.entries()].some(([r, b]) => b !== r.ktx2);
      ph.json.asset = json.asset;
      if (!e.fromOrig) { fs.mkdirSync(path.dirname(origPath(e.file)), { recursive: true }); writeFileAtomic(origPath(e.file), e.src); }
      writeFileAtomic(e.file, out);
      if (phoneSmaller) writeFileAtomic(phonePath(e.file), writeGlb(ph.json, phRw.newBin));
      else fs.rmSync(phonePath(e.file), { force: true });
      const conv = its.filter((it) => !it.keep).map((it) => ({ it, r: results.get(it.key) }));
      const row = {
        file: path.relative(ROOT, e.file), bytesBefore: e.src.length, bytesAfter: out.length, converted, kept: its.length - converted,
        uastc: conv.filter((c) => c.r.mode === 'uastc').length, etc1s: conv.filter((c) => c.r.mode === 'etc1s').length,
        shared: conv.filter((c) => sharedUri.has(c.it.hash)).length,
        gpuBeforeMB: +(conv.reduce((s, c) => s + gpuBefore(c.it), 0) / 1048576).toFixed(1),
        gpuAfterMB: +(conv.reduce((s, c) => s + gpuAfter(c.r), 0) / 1048576).toFixed(1),
        gpuAfterWorstMB: +(conv.reduce((s, c) => s + gpuAfter(c.r, true), 0) / 1048576).toFixed(1),
        textures: conv.map((c) => ({ name: c.it.name, kind: c.it.kind, src: `${c.it.srcMime.split('/')[1]} ${c.it.w}x${c.it.h} ${Math.round(c.it.bytes.length / 1024)} KB`, out: `${c.r.mode}${c.r.rdo ? ` rdo ${c.r.rdo}` : ''} ${c.r.width}x${c.r.height} ${Math.round(c.r.ktx2.length / 1024)} KB`, profile: c.it.profile, psnr: c.r.q.psnr, ssim: c.r.q.ssim, tileMin: c.r.q.tileMin, tried: c.r.tried, shared: sharedUri.get(c.it.hash) })),
      };
      report.glbs.push(row);
      console.log(`  ${row.file}: ${MB(row.bytesBefore)} → ${MB(row.bytesAfter)} MB, ${converted} KTX2 (${row.uastc} UASTC, ${row.etc1s} ETC1S${row.shared ? `, ${row.shared} shared` : ''}), GPU ${row.gpuBeforeMB} → ${row.gpuAfterMB}–${row.gpuAfterWorstMB} MB`);
    }
  }
  // phone variant list (always written, so phones never ask for a missing file): converted GLB → its .phone.glb
  if (!DRY) {
    const map = {};
    for (const fam of FAMILIES) for (const f of listGlbs(fam)) {
      const p = phonePath(f);
      if (fs.existsSync(p) && stateOf(readGlb(fs.readFileSync(f)).json)) map[path.relative(ROOT, f).split(path.sep).join('/')] = path.relative(ROOT, p).split(path.sep).join('/');
    }
    const file = path.join(ROOT, PHONE_MANIFEST);
    const text = `${JSON.stringify(map, null, 1)}\n`;
    if (!ONLY && (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)) writeFileAtomic(file, text);
    else if (ONLY) {   // partial run: merge
      const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      for (const k of Object.keys(cur)) if (k.includes(ONLY) && !map[k]) delete cur[k];
      writeFileAtomic(file, `${JSON.stringify({ ...cur, ...map }, null, 1)}\n`);
    }
  }
  if (CHECK) {
    if (outOfDate.length) { console.log(`KTX2 textures out of date in ${outOfDate.length} GLBs (run node tools/assets/textures.mjs):\n  ${outOfDate.join('\n  ')}`); process.exit(1); }
    console.log('KTX2 textures up to date');
  }
  if (REPORT) { fs.mkdirSync(path.dirname(path.resolve(REPORT)), { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(report, null, 1)); }
}

main().catch((e) => { console.error(e); process.exit(1); });
