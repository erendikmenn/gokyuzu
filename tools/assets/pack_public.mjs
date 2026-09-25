#!/usr/bin/env node
// Public asset pack: the game's published assets (what tools/deploy/build_dist.mjs ships from assets/) without any
// third-party trademark, as versioned ZIP parts for GitHub Releases plus a manifest (every file with size and SHA-256)
// and SHA256SUMS. Built locally, never uploaded: the maintainer attaches the files of <out>/<version>/ to the release
// `assets-v<version>`; tools/assets/fetch_pack.mjs downloads, verifies and installs them. Licence: CC BY-NC 4.0
// (ASSETS-LICENSE.md) except assets-gpl/ (GPL-2.0 FlightGear-derived sounds) and the map data inside (ODbL, NOTICE).
//
// What differs from the live game's assets/ (which is only read, never written):
//   - textures regenerated with every local brand opt-in off (GOKYUZU_BRAND=off, blender/common/brand.py): the
//     fictional airliner liveries, neutral hangar lettering, generic military markings; tools/assets/pack_public_tex.py
//     plans which images of which exported GLB (_orig/) change, this script swaps them and converts the GLBs to KTX2
//     with tools/assets/textures.mjs --root <work> (geometry byte for byte as exported; no Blender run)
//   - OSM building names that carry company names of BRAND_TERMS are cut to their generic label in the airport JSON
//   - the FlightGear-derived (GPL-2.0) sounds move to assets-gpl/ with their licence (fetch_pack puts them back)
//   - build inputs the game never loads (aircraft src/, audio research candidates, _* caches) are left out
//
// usage: node tools/assets/pack_public.mjs [--version YYYY.MM.DD] [--out build/public-assets] [--part-size 1850000000]
//                                          [--fresh]      (regenerate the textures even if <out>/work has them)
// Needs: the built assets/ and build caches of a machine that built them (pack_public_tex.py NEEDS), the project venv
// (.venv), node tools/assets/setup.mjs (KTX encoder). About 10-20 min, ~3 GB in <out>/work + the parts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlb, writeGlb, relayoutBuffer } from './lib/glb.mjs';
import { ZipWriter, compress, store, entryOverhead, MAX_ENTRIES } from './lib/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
const VERSION = opt('--version', today);
const OUT = path.resolve(ROOT, opt('--out', 'build/public-assets'));
const PART_SIZE = Number(opt('--part-size', 1.85e9));   // GitHub Releases take files below 2 GiB; parts stay below 1.9 GB
const WORK = path.join(OUT, 'work');
const WROOT = path.join(WORK, 'root');          // exported GLBs with swapped images -> KTX2 (textures.mjs --root)
const OVERLAY = path.join(WORK, 'overlay');     // rewritten small files (airport JSON, phone-variants.json)
const DIST = path.join(OUT, VERSION);
const NAME = `gokyuzu-assets-${VERSION}`;
const PY = path.join(ROOT, '.venv', 'bin', 'python');

// company names that must not appear in the pack (checked in every text / metadata chunk, see scan())
export const BRAND_TERMS = [/\bTHY\b/, /turkish/i, /t[üu]rk hava/i, /technic/i, /star alliance/i, /\bcoke\b|_coke\b|coca.?cola/i];
// object / material names in GLBs that carry a brand are renamed (names only: geometry and textures stay)
const NAME_FIX = [[/coca.?cola|coke/gi, 'bottle']];
// FlightGear-derived sounds, GPL-2.0 (tools/audio/gen_fgsounds.py): shipped in assets-gpl/ with their licence
const GPL_SOUNDS = ['audio/a320neo/cavalry', 'audio/a320neo/cavalry_loop', 'audio/a320neo/ap_button', 'audio/b737/wailer'];
// assets/ filters: the files build_dist.mjs publishes (keep in step with it), minus build inputs the game never loads
const SKIP_DIRS = new Set(['_bake', 'bake', 'build', 'render', 'cache', 'raw', 'src_img', '__pycache__', 'before', 'fidelity', 'ref', 'candidates']);
const SKIP_FILE = /(\.(blend\d?|exr|tif|tiff|py|pyc|psd|kra|log)$)|(^\.)|(^compare)|(^cmp)/i;
const MAPS = fs.readdirSync(path.join(ROOT, 'data')).filter((m) => fs.existsSync(path.join(ROOT, 'data', m, 'region.json')));
const SKIP_UNDER = [['aircraft', 'tex'], ['aircraft', 'src'], ...MAPS.map((m) => [`${m}/terrain`, 'h'])];
const NO_DEFLATE = /\.(ktx2|jpe?g|png|webp|m4a|mp3|ogg|zip)$/i;

const log = (...a) => console.log('[pack]', ...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (${r.status})`);
}

/** Published files under dir (relative to assets/, posix) -> absolute path, with the build_dist filters. */
function walkAssets(base, out = new Map(), rel = '') {
  const abs = path.join(base, rel);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('_')) continue;
      if (SKIP_UNDER.some(([under, name]) => e.name === name && r.startsWith(`${under}/`))) continue;
      walkAssets(base, out, r);
    } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.set(r, path.join(base, r));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ 1. textures
function textures() {
  if (!fs.existsSync(PY)) throw new Error('.venv missing (python3 -m venv .venv; see README)');
  run(PY, [path.join(HERE, 'pack_public_tex.py'), WORK, ...(argv.includes('--fresh') ? ['--fresh'] : [])]);
  return JSON.parse(fs.readFileSync(path.join(WORK, 'swap', 'plan.json'), 'utf8'));
}

// ------------------------------------------------------------------------------------------------ 2. GLBs
function swapGlbs(plan) {
  fs.rmSync(WROOT, { recursive: true, force: true });
  const rels = new Set(Object.keys(plan));
  // families whose textures are shared across GLBs (assets/<map>/airports/shared/*.ktx2): convert the whole family
  for (const rel of [...rels]) {
    const dir = path.posix.dirname(rel);
    if (!/^assets\/[^/]+\/airports$/.test(dir)) continue;
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.glb') && !f.endsWith('.phone.glb')) rels.add(`${dir}/${f}`);
  }
  for (const rel of [...rels].sort()) {
    const abs = path.join(ROOT, rel);
    const orig = path.join(path.dirname(abs), '_orig', path.basename(abs));
    const src = plan[rel] ? plan[rel].src : fs.existsSync(orig) ? orig : abs;
    const { json, bin } = readGlb(fs.readFileSync(src));
    if (json.asset && json.asset.extras && json.asset.extras.gokyuzuKtx2) throw new Error(`${rel}: no exported original (_orig/)`);
    const images = plan[rel] ? plan[rel].images : {};
    const replace = new Map();
    let n = 0;
    (json.images || []).forEach((im) => {
      const f = images[im.name];
      if (!f) return;
      replace.set(im.bufferView, fs.readFileSync(f));
      im.mimeType = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
      n++;
    });
    if (n !== Object.keys(images).length) throw new Error(`${rel}: ${Object.keys(images).length - n} planned images not found`);
    const out = path.join(WROOT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, writeGlb(json, relayoutBuffer(json, bin, replace)));
    log(`${rel}: ${n} images swapped`);
  }
  // KTX2 (same policy as the live assets; unchanged textures come from the encoder cache)
  run(process.execPath, [path.join(HERE, 'textures.mjs'), '--root', WROOT]);
}

// ------------------------------------------------------------------------------------------------ 3. file tree
function scrubAirport(text) {
  // "name": "<generic label> (<OSM name>)" -> "<generic label>" when the OSM name carries a company name of BRAND_TERMS
  let n = 0;
  const out = text.replace(/"name":"((?:[^"\\]|\\.)*)"/g, (m, v) => {
    const s = JSON.parse(`"${v}"`);
    const k = s.indexOf(' (');
    if (k < 0 || !BRAND_TERMS.some((re) => re.test(s))) return m;
    n++;
    return `"name":${JSON.stringify(s.slice(0, k))}`;
  });
  return { out, n };
}

function tree() {
  const files = new Map();                      // pack path -> source file
  const live = walkAssets(path.join(ROOT, 'assets'));
  const work = walkAssets(path.join(WROOT, 'assets'));
  for (const [rel, abs] of live) files.set(`assets/${rel}`, abs);
  for (const [rel, abs] of work) files.set(`assets/${rel}`, abs);
  // phone variants: the live list, entries of the regenerated GLBs replaced by the work tree's
  const pv = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'phone-variants.json'), 'utf8'));
  const wpv = JSON.parse(fs.readFileSync(path.join(WROOT, 'assets', 'phone-variants.json'), 'utf8'));
  for (const k of Object.keys(pv)) if (fs.existsSync(path.join(WROOT, k))) delete pv[k];
  Object.assign(pv, wpv);
  for (const [k, v] of Object.entries(pv)) if (!files.has(k) || !files.has(v)) throw new Error(`phone variant ${k} -> ${v} missing`);
  const put = (rel, text) => { const p = path.join(OVERLAY, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); files.set(rel, p); };
  fs.rmSync(OVERLAY, { recursive: true, force: true });
  put('assets/phone-variants.json', `${JSON.stringify(pv, null, 1)}\n`);
  for (const m of MAPS) {
    const dir = path.join(ROOT, 'assets', m, 'airports');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const { out, n } = scrubAirport(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (n) { put(`assets/${m}/airports/${f}`, out); log(`assets/${m}/airports/${f}: ${n} building names cut to their generic label`); }
    }
  }
  // GPL-2.0 sounds -> assets-gpl/ (same relative paths; fetch_pack.mjs installs them into assets/)
  for (const s of GPL_SOUNDS) for (const ext of ['m4a', 'wav']) {
    const k = `assets/${s}.${ext}`;
    if (!files.has(k)) throw new Error(`GPL sound ${k} not found`);
    files.set(`assets-gpl/${s}.${ext}`, files.get(k));
    files.delete(k);
  }
  const fg = path.join(ROOT, 'tools', 'audio', 'third_party', 'flightgear');
  for (const f of fs.readdirSync(fg)) if (!f.startsWith('.')) files.set(`assets-gpl/flightgear-originals/${f}`, path.join(fg, f));
  files.set('assets-gpl/LICENSE-GPL-2.0.txt', path.join(fg, 'LICENSE-GPL-2.0.txt'));
  put('assets-gpl/README.md', gplReadme());
  // licence and notices
  const lic = ['ASSETS-LICENSE.md', 'ASSETS.md'].find((f) => fs.existsSync(path.join(ROOT, f)));
  if (!lic) throw new Error('ASSETS-LICENSE.md missing (the asset licence terms)');
  files.set(lic, path.join(ROOT, lic));
  if (fs.existsSync(path.join(ROOT, 'NOTICE'))) files.set('NOTICE', path.join(ROOT, 'NOTICE'));
  files.set('LICENSE-CC-BY-NC-4.0.txt', path.join(HERE, 'pack', 'CC-BY-NC-4.0.txt'));
  put('README.md', readme(lic));
  fixGlbNames(files, put);
  prewarm(files, put);
  return files;
}

/** The shader pre-warm pack (packs.mjs) of the pack's own GLBs, and packs.json recording them as its sources: runs
 *  packs.mjs --only prewarm on a tree of hard links to the pack's files, except the files it writes (copies). */
function prewarm(files, put) {
  const tree = path.join(WORK, 'prewarm-root');
  fs.rmSync(tree, { recursive: true, force: true });
  const writes = new Set(MAPS.flatMap((m) => [`assets/${m}/packs.json`, `assets/${m}/packs/prewarm.glb`, `assets/${m}/packs/prewarm.json`]));
  for (const [rel, abs] of files) {
    if (!rel.startsWith('assets/') && rel !== 'assets') continue;
    const dst = path.join(tree, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (writes.has(rel)) fs.copyFileSync(abs, dst);
    else try { fs.linkSync(abs, dst); } catch { fs.copyFileSync(abs, dst); }
  }
  for (const rel of writes) {             // prewarm.json is not published, but packs.mjs keys its freshness on it
    const src = path.join(ROOT, rel);
    const dst = path.join(tree, rel);
    if (!fs.existsSync(dst) && fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
  run(process.execPath, [path.join(HERE, 'packs.mjs'), '--root', tree, '--only', 'prewarm', '--maps', MAPS.join(',')]);
  for (const rel of writes) if (files.has(rel) || rel.endsWith('packs.json')) put(rel, fs.readFileSync(path.join(tree, rel)));
}

/** Rename GLB objects / materials whose names carry a brand (NAME_FIX); the rewritten GLB goes to the overlay. */
function fixGlbNames(files, put) {
  for (const [rel, abs] of [...files]) {
    if (!rel.endsWith('.glb')) continue;
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8', 20, 20 + buf.readUInt32LE(12));
    if (!NAME_FIX.some(([re]) => { re.lastIndex = 0; return re.test(text); })) continue;
    const { json, bin } = readGlb(buf);
    let n = 0;
    for (const key of ['nodes', 'meshes', 'materials', 'images', 'textures', 'scenes', 'animations']) {
      for (const o of json[key] || []) {
        if (typeof o.name !== 'string') continue;
        const v = NAME_FIX.reduce((t, [re, to]) => t.replace(re, to), o.name);
        if (v !== o.name) { o.name = v; n++; }
      }
    }
    if (!n) continue;
    const p = path.join(OVERLAY, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, writeGlb(json, bin));
    files.set(rel, p);
    log(`${rel}: ${n} object / material names without the brand`);
  }
}

function gplReadme() {
  return `# FlightGear-derived sounds (GPL-2.0)

These files are **not** under the pack's CC BY-NC 4.0 licence. They are derived (resampled to 48 kHz, level-matched,
80 Hz high-pass, the 737 wailer cut to a seamless loop by tools/audio/gen_fgsounds.py) from two FlightGear aircraft
licensed under the GNU General Public License, version 2, and are distributed under GPL-2.0 as well
(LICENSE-GPL-2.0.txt):

${GPL_SOUNDS.map((s) => `- \`${s}.m4a\`, \`${s}.wav\``).join('\n')}

- A320-family for FlightGear: Josh Davidson (Octal450), Jonathan Redpath (legoboyvdlp) and contributors,
  https://github.com/legoboyvdlp/A320-family (the A320 "cavalry charge" is a GPL re-synthesis from an Airbus
  waveform diagram, not a recording)
- Boeing 737-800YV for FlightGear: YV3399 and contributors, https://github.com/YV3399/737-800YV

The unmodified originals and their provenance are in \`flightgear-originals/\` (also in the source repository,
tools/audio/third_party/flightgear/). The game expects these sounds under \`assets/audio/\`: tools/assets/fetch_pack.mjs
puts them there; by hand, copy \`assets-gpl/audio/\` into \`assets/audio/\`.
`;
}

function readme(lic) {
  return `# Gökyüzü asset pack ${VERSION}

The generated game assets of Gökyüzü (3D models, textures, terrain, city and airport data, sounds) for running and
modifying the game locally. The code is in the source repository (Apache-2.0); these assets are licensed separately.

## Licence

- \`assets/\`: **CC BY-NC 4.0** (${lic}, legal code: LICENSE-CC-BY-NC-4.0.txt), with the exceptions listed in
  ${lic}: map data derived from OpenStreetMap / Overture (ODbL 1.0) and third-party elevation, imagery and
  bathymetry data (NOTICE keeps their attributions; keep them with any asset that contains that data).
- \`assets-gpl/\`: sounds derived from FlightGear aircraft, **GPL-2.0** (assets-gpl/README.md).
- Voice/sound effects generated with ElevenLabs (paid plan) — licensed as part of this pack under CC BY-NC 4.0.
  No real person's voice was cloned.
- Credit: "Gökyüzü assets © 2026 Mehmet Eren Dikmen, CC BY-NC 4.0" and say if you changed them.

## No third-party trademarks

The airliners carry the fictional Gökyüzü house livery with fictional registrations; the military aircraft carry
fictional tail codes and serials and generic roundels; hangars carry neutral lettering; company names of operators are
cut from airport building labels. Aircraft type names (A320neo, 737-800, F-16C, F-22A, UH-60M) and the names of real
places and buildings appear only descriptively and belong to their owners; no licence here grants any trademark right.

## Install

From the source repository: \`node tools/assets/fetch_pack.mjs\` downloads the parts of this release, checks every
SHA-256 against the manifest and unpacks them into \`assets/\` (GPL sounds included). By hand: unzip every part into
one folder, then move \`assets/\` into the repository and copy \`assets-gpl/audio/\` into \`assets/audio/\`.
`;
}

// ------------------------------------------------------------------------------------------------ 4. checks
/** Text / metadata of a file where a company name could hide: JSON, text, GLB JSON chunks, KTX2 key/value data, PNG
 *  text chunks, JPEG comment / APP segments. */
function metaText(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (/\.(json|txt|md|csv|html|js|svg)$/.test(ext) || !ext) return buf.toString('utf8');
  if (ext === '.glb') { const n = buf.readUInt32LE(12); return buf.toString('utf8', 20, 20 + n); }
  if (ext === '.ktx2') { const off = buf.readUInt32LE(56), len = buf.readUInt32LE(60); return buf.toString('latin1', off, off + len); }
  if (ext === '.png') {
    let s = '';
    for (let o = 8; o + 8 <= buf.length;) { const n = buf.readUInt32BE(o), t = buf.toString('latin1', o + 4, o + 8); if (/^(tEXt|zTXt|iTXt)$/.test(t)) s += buf.toString('latin1', o + 8, o + 8 + n); if (t === 'IEND') break; o += 12 + n; }
    return s;
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let s = '';
    for (let o = 2; o + 4 <= buf.length && buf[o] === 0xff;) { const m = buf[o + 1]; if (m === 0xda) break; const n = buf.readUInt16BE(o + 2); if (m === 0xfe || (m >= 0xe0 && m <= 0xef)) s += buf.toString('latin1', o + 4, o + 2 + n); o += 2 + n; }
    return s;
  }
  return '';
}

function scan(files) {
  const hits = [];
  for (const [rel, abs] of files) {
    if (!rel.startsWith('assets')) continue;           // the licence / notice texts name the marks they disclaim
    const buf = fs.readFileSync(abs);
    const t = metaText(rel, buf);
    for (const re of BRAND_TERMS) { const m = re.exec(t); if (m) hits.push(`${rel}: "${t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"`); }
    // raw bytes of every file, for the long names (a 3-letter pattern would match compressed data by chance)
    for (const w of ['Turkish', 'TURKISH', 'Technic', 'TECHNIC', 'Star Alliance', 'STAR ALLIANCE']) if (buf.indexOf(w, 0, 'latin1') >= 0) hits.push(`${rel}: bytes "${w}"`);
  }
  return hits;
}

// ------------------------------------------------------------------------------------------------ 5. zip parts
function pack(files) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const docs = [...files.keys()].filter((k) => !k.startsWith('assets')).sort();
  const order = [...docs, ...[...files.keys()].filter((k) => k.startsWith('assets/')).sort(), ...[...files.keys()].filter((k) => k.startsWith('assets-gpl/')).sort()];
  const parts = [], entries = [];
  let zw = null, cur = null;
  const open = () => {
    const file = `${NAME}.part${String(parts.length + 1).padStart(2, '0')}.zip`;
    zw = new ZipWriter(path.join(DIST, file));
    cur = { file, entries: 0, central: 22 };
    parts.push(cur);
  };
  const t0 = Date.now();
  let done = 0, raw = 0;
  for (const rel of order) {
    const data = fs.readFileSync(files.get(rel));
    const c = NO_DEFLATE.test(rel) ? store(data) : compress(data);
    if (!zw || zw.off + cur.central + c.body.length + entryOverhead(rel) > PART_SIZE || cur.entries >= MAX_ENTRIES - 1) {
      if (zw) cur.bytes = zw.close();
      open();
    }
    zw.add(rel, c);
    cur.entries++;
    cur.central += 46 + Buffer.byteLength(rel);
    entries.push({ path: rel, bytes: data.length, sha256: sha256(data), part: parts.length });
    raw += data.length;
    if (++done % 2000 === 0) process.stdout.write(`\r[pack] ${done}/${order.length} files, ${(raw / 1e9).toFixed(2)} GB, ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
  }
  cur.bytes = zw.close();
  process.stdout.write('\n');
  for (const p of parts) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(path.join(DIST, p.file), 'r');
    const buf = Buffer.allocUnsafe(8 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
    fs.closeSync(fd);
    p.sha256 = h.digest('hex');
    if (p.bytes >= PART_SIZE) throw new Error(`${p.file}: ${p.bytes} bytes, above the part size`);
  }
  const manifest = {
    format: 1, name: 'gokyuzu-assets', version: VERSION, created: new Date().toISOString(),
    license: 'CC-BY-NC-4.0 (ASSETS-LICENSE.md); assets-gpl/: GPL-2.0-only; map data inside: ODbL-1.0 (NOTICE)',
    install: 'node tools/assets/fetch_pack.mjs (assets/ -> assets/, assets-gpl/audio/ -> assets/audio/)',
    parts: parts.map(({ file, bytes, sha256: s, entries: n }) => ({ file, bytes, sha256: s, entries: n })),
    totals: { files: entries.length, bytes: raw, zipBytes: parts.reduce((s, p) => s + p.bytes, 0) },
    files: entries,
  };
  const mf = `${NAME}.manifest.json`;
  fs.writeFileSync(path.join(DIST, mf), JSON.stringify(manifest));
  const sums = [...parts.map((p) => `${p.sha256}  ${p.file}`), `${sha256(fs.readFileSync(path.join(DIST, mf)))}  ${mf}`];
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return manifest;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  if (!/^[\w.-]+$/.test(VERSION)) throw new Error(`bad --version ${VERSION}`);
  const assetsDir = path.join(ROOT, 'assets');
  if (OUT === ROOT || OUT.startsWith(assetsDir) || assetsDir.startsWith(OUT)) throw new Error(`--out ${OUT}: not inside or above assets/`);
  fs.mkdirSync(OUT, { recursive: true });
  const buildDir = path.join(ROOT, 'build');
  if (OUT.startsWith(buildDir + path.sep) && !fs.existsSync(path.join(buildDir, '.gitignore'))) fs.writeFileSync(path.join(buildDir, '.gitignore'), '# local build outputs (tools/assets/pack_public.mjs)\n*\n');
  const t0 = Date.now();
  const plan = textures();
  swapGlbs(plan);
  const files = tree();
  const hits = scan(files);
  if (hits.length) { console.error(`[pack] company names found:\n  ${hits.slice(0, 40).join('\n  ')}`); process.exit(1); }
  log(`${files.size} files, no company names in text / metadata; zipping into parts below ${(PART_SIZE / 1e9).toFixed(2)} GB`);
  const m = pack(files);
  for (const p of m.parts) log(`${p.file}: ${(p.bytes / 1e9).toFixed(3)} GB, ${p.entries} files, sha256 ${p.sha256.slice(0, 16)}…`);
  log(`${m.totals.files} files, ${(m.totals.bytes / 1e9).toFixed(2)} GB -> ${(m.totals.zipBytes / 1e9).toFixed(2)} GB in ${m.parts.length} parts, ${path.relative(ROOT, DIST)}/ (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  log(`release: attach ${path.relative(ROOT, DIST)}/* to the GitHub release "assets-v${VERSION}"; set PACK_VERSION in tools/assets/fetch_pack.mjs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
