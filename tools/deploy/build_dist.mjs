#!/usr/bin/env node
// Builds dist/ = exactly the files the published game needs (no Blender sources, caches, raw data, tests, dev pages).
// Files are hard-linked (no extra disk space). The JavaScript is bundled (tools/build/bundle.mjs: minified, code-split,
// content-hashed chunks in dist/js/, pages rewritten with modulepreload); development keeps serving src/ unbundled.
// Usage: node tools/deploy/build_dist.mjs [--gallery] [--out <dir>]   (--out: build elsewhere than dist/, e.g. a scratch dir)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundlePage, JS_DIR } from '../build/bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outIdx = process.argv.indexOf('--out');
const dist = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(root, 'dist');
// --out gets emptied first: only ever an empty/new directory or an earlier build (never the repo or one of its parents)
if (outIdx > 0 && (root === dist || root.startsWith(dist + path.sep) || (fs.existsSync(dist) && fs.readdirSync(dist).length && !fs.existsSync(path.join(dist, 'build.json'))))) {
  throw new Error(`--out ${dist}: not an earlier build output`);
}
const withGallery = process.argv.includes('--gallery');

// directory names and file patterns that are build inputs / caches, never loaded by the game
const SKIP_DIRS = new Set(['_bake', 'bake', 'build', 'render', 'cache', 'raw', 'src_img', '__pycache__', 'before', 'fidelity', 'ref', 'candidates']);   // candidates: audio research material (dev/sesler.html), never shipped
// aircraft textures are embedded in the GLBs (tex/ holds bake inputs); other layers (airports) load tex/ at runtime.
// Terrain heights: the game reads the small cacheable files in hz/; the 0.7 GB h/<L>.bin level packs are only the
// input of tools/geo/terrain_heightfiles.py (deploy.sh leaves the copies already in the bucket alone for old pages).
// Maps (src/maps/index.js): every data/<id>/ with a region.json — San Francisco and İstanbul — ships its data/<id>/*.json
// and assets/<id>/ (build caches in _* directories and raw/ never do).
const MAPS = fs.readdirSync(path.join(root, 'data')).filter((m) => fs.existsSync(path.join(root, 'data', m, 'region.json')));
const SKIP_UNDER = [['assets/aircraft', 'tex'], ...MAPS.map((m) => [`assets/${m}/terrain`, 'h'])];
const SKIP_FILE = /(\.(blend\d?|exr|tif|tiff|py|pyc|psd|kra|log)$)|(^\.)|(^compare)|(^cmp)/i;

let files = 0, bytes = 0;
const published = new Map();   // dist-relative posix path -> file whose content is published (for versions.json)
function link(src, rel) {
  const dst = path.join(dist, rel);
  if (fs.existsSync(dst)) return;   // already added (e.g. menu thumbnails + gallery)
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch (e) { if (e.code === 'EXDEV') fs.copyFileSync(src, dst); else throw e; }
  files++; bytes += fs.statSync(src).size;
  published.set(rel.split(path.sep).join('/'), src);
}
function addTree(relDir, filter = () => true) {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, ent.name);
    if (ent.isDirectory()) {
      const skipHere = SKIP_UNDER.some(([under, name]) => ent.name === name && rel.split(path.sep).join('/').startsWith(under));
      if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('_') && !skipHere) addTree(rel, filter);
    }
    else if (ent.isFile() && !SKIP_FILE.test(ent.name) && filter(rel)) link(path.join(root, rel), rel);
  }
}
function addFile(rel) { if (fs.existsSync(path.join(root, rel))) link(path.join(root, rel), rel); }

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// pages (index.html and ada.html are written by the JavaScript bundle step below)
for (const f of ['favicon.ico', 'favicon.svg', 'favicon-180.png', 'apple-touch-icon.png', 'apple-touch-icon-precomposed.png', 'manifest.json', 'robots.txt']) addFile(f);   // site icons (iOS probes the root apple-touch-icon names), web app manifest, crawler rules
// code: the modules are bundled into js/ below; src/ keeps the files the code loads by URL (fonts, map image, CSS);
// no per-agent dev/test pages
addTree('src', (rel) => !/\.m?js$/.test(rel) && !/\/(preview|view|cockpit_check)\.html$/.test(rel) && !rel.includes(`${path.sep}tools${path.sep}`));
// shared data of every map (runways, landmarks, region, …)
for (const m of MAPS) addTree(`data/${m}`, (rel) => rel.endsWith('.json'));
// three.js is bundled too; the Draco / Basis decoders stay files (loaded at runtime from src/core/assets.js LIBS)
addFile('node_modules/three/LICENSE');
addTree('node_modules/three/examples/jsm/libs/draco');
addTree('node_modules/three/examples/jsm/libs/basis');
// game assets
addTree('assets');
// menu thumbnails (and optionally the render gallery)
for (const id of fs.readdirSync(path.join(root, 'renders/aircraft'))) addFile(`renders/aircraft/${id}/thumb.jpg`);
if (withGallery) {
  addFile('galeri.html');
  addFile('renders/manifest.json');
  addTree('renders', (rel) => /\.(png|jpe?g|webp)$/i.test(rel));
}

// JavaScript bundle (tools/build/bundle.mjs): each page's module graph → dist/js/<name>-<content hash>.js (+ external
// source maps, never uploaded: deploy.sh skips *.map), the page rewritten to load it. Hashed names are the cache busting
// for code (deploy.sh: js/ a year + immutable, the pages no-cache). Deploy builds also keep their maps in
// node_modules/.cache/gokyuzu/sourcemaps/<target>/ so errors of a live build can be mapped back after dist/ was rebuilt
// (tools/build/symbolicate.mjs).
{
  const t0 = Date.now();
  const jsDir = path.join(dist, JS_DIR);
  fs.rmSync(jsDir, { recursive: true, force: true });
  const summary = [];
  for (const page of ['index.html', 'ada.html']) {
    if (!fs.existsSync(path.join(root, page))) continue;
    const r = await bundlePage({ root, dist, page });
    summary.push(`${page} → ${r.entry} + ${r.preload.length} preloaded chunks`);
    files++;
  }
  let jsBytes = 0, jsFiles = 0;
  for (const f of fs.readdirSync(jsDir)) if (f.endsWith('.js')) { jsFiles++; jsBytes += fs.statSync(path.join(jsDir, f)).size; }
  files += jsFiles; bytes += jsBytes;
  const target = process.env.DEPLOY_TARGET;
  if (target) {
    const archive = path.join(root, 'node_modules/.cache/gokyuzu/sourcemaps', target);
    fs.mkdirSync(archive, { recursive: true });
    for (const f of fs.readdirSync(jsDir)) {
      if (!f.endsWith('.map')) continue;
      const dst = path.join(archive, f);
      fs.rmSync(dst, { force: true });
      try { fs.linkSync(path.join(jsDir, f), dst); } catch { fs.copyFileSync(path.join(jsDir, f), dst); }
    }
    const old = Date.now() - 90 * 864e5;   // S3 keeps old versions 30 days (rollback.py); errors of older builds are unlikely
    for (const f of fs.readdirSync(archive)) if (fs.statSync(path.join(archive, f)).mtimeMs < old) fs.rmSync(path.join(archive, f));
  }
  console.log(`js/: ${jsFiles} chunks, ${(jsBytes / 1e6).toFixed(2)} MB (${summary.join('; ')}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// Cache busting for sounds: write each file's content hash into dist's copy of the audio manifest
// (a new file, not the hard link, so the source stays untouched); the audio loader appends ?v=<hash>.
{
  const manPath = path.join(dist, 'assets/audio/manifest.json');
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    for (const [rel, entry] of Object.entries(man)) {
      if (!entry || typeof entry !== 'object') continue;
      const h = {};
      for (const ext of ['m4a', 'wav']) {
        const f = path.join(root, 'assets/audio', `${rel}.${ext}`);
        if (fs.existsSync(f)) h[ext] = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
      }
      entry.h = h;
    }
    fs.unlinkSync(manPath);
    fs.writeFileSync(manPath, JSON.stringify(man));
    published.set('assets/audio/manifest.json', manPath);
  }
}

// Cache busting for every asset (CONTRACTS-SF.md §9): dist/assets/versions.json maps each directory under assets/ and
// renders/ that holds published files to a short hash over the names + contents of those files; the game appends
// ?v=<hash> to every request in that directory (src/core/assets.js assetUrl). File hashes are cached by path + size +
// mtime in node_modules/.cache/ (gitignored), so a rebuild only reads files that changed (first build: ~2 GB, seconds).
const VERSIONS_REL = 'assets/versions.json';
{
  const t0 = Date.now();
  const cacheFile = path.join(root, 'node_modules/.cache/gokyuzu/file-hashes.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first build */ }
  const seen = {};
  const buf = Buffer.allocUnsafe(8 << 20);
  let hashedFiles = 0, hashedBytes = 0;
  const fileHash = (abs) => {
    const st = fs.statSync(abs);
    const key = path.relative(root, abs).split(path.sep).join('/');
    const c = cache[key];
    if (c && c[0] === st.size && c[1] === st.mtimeMs) { seen[key] = c; return c[2]; }
    const h = crypto.createHash('sha256');   // hardware-accelerated on Apple silicon (~2 GB/s)
    const fd = fs.openSync(abs, 'r');
    try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    seen[key] = [st.size, st.mtimeMs, h.digest('hex').slice(0, 20)];
    hashedFiles++; hashedBytes += st.size;
    return seen[key][2];
  };
  const dirs = new Map();
  for (const [rel, src] of published) {
    if (!/^(assets|renders)\//.test(rel) || rel === VERSIONS_REL) continue;
    const k = rel.lastIndexOf('/');
    const dir = rel.slice(0, k);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push([rel.slice(k + 1), fileHash(src)]);
  }
  const versions = {};
  for (const dir of [...dirs.keys()].sort()) {
    const h = crypto.createHash('sha256');
    for (const [name, fh] of dirs.get(dir).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) h.update(`${name}\0${fh}\n`);
    versions[dir] = h.digest('hex').slice(0, 10);
  }
  const out = path.join(dist, VERSIONS_REL);
  fs.rmSync(out, { force: true });   // never write through a hard link into the source tree
  fs.writeFileSync(out, JSON.stringify(versions, null, 0));
  // keep cache entries of files that still exist (e.g. gallery renders skipped by a build without --gallery)
  for (const [key, c] of Object.entries(cache)) if (!seen[key] && !key.startsWith('dist/') && fs.existsSync(path.join(root, key))) seen[key] = c;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(seen));
  console.log(`versions.json: ${Object.keys(versions).length} directories (${hashedFiles} files / ${(hashedBytes / 1e6).toFixed(0)} MB hashed, rest cached) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// Build stamp: shown in the game (STAGING ribbon on staging) and used for support/rollback.
{
  const git = (c) => { try { return execSync(`git ${c}`, { cwd: root }).toString().trim(); } catch { return ''; } };
  const stamp = {
    version: git('describe --tags --always --dirty'), commit: git('rev-parse --short HEAD'), branch: git('branch --show-current'),
    builtAt: new Date().toISOString(), target: process.env.DEPLOY_TARGET || 'local',
    versions: VERSIONS_REL,   // tells the game to load the asset version map (dev servers have none: no 404 probe)
  };
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify(stamp));
}

console.log(`dist/: ${files} files, ${(bytes / 1e9).toFixed(2)} GB`);
