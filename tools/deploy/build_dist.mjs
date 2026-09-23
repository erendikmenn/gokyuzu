#!/usr/bin/env node
// Builds dist/ = exactly the files the published game needs (no Blender sources, caches, raw data, tests, dev pages).
// Files are hard-linked (no extra disk space). Usage: node tools/deploy/build_dist.mjs [--gallery]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist');
const withGallery = process.argv.includes('--gallery');

// directory names and file patterns that are build inputs / caches, never loaded by the game
const SKIP_DIRS = new Set(['_bake', 'bake', 'build', 'render', 'cache', 'raw', 'src_img', '__pycache__', 'before', 'fidelity', 'ref', 'candidates']);   // candidates: audio research material (dev/sesler.html), never shipped
// aircraft textures are embedded in the GLBs (tex/ holds bake inputs); other layers (airports) load tex/ at runtime
const SKIP_UNDER = [['assets/aircraft', 'tex']];
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

// pages
addFile('index.html');
addFile('ada.html');
for (const f of ['favicon.ico', 'favicon.svg', 'favicon-180.png', 'robots.txt']) addFile(f);   // site icons + crawler rules
// code (no per-agent dev/test pages inside src)
addTree('src', (rel) => !/\/(preview|view|cockpit_check)\.html$/.test(rel) && !rel.includes(`${path.sep}tools${path.sep}`));
// shared data (runways, landmarks, region, …)
addTree('data/sf', (rel) => rel.endsWith('.json'));
// three.js runtime (import map points at node_modules/three/…)
addFile('node_modules/three/LICENSE');
addTree('node_modules/three/build');
addTree('node_modules/three/examples/jsm');
// game assets
addTree('assets');
// menu thumbnails (and optionally the render gallery)
for (const id of fs.readdirSync(path.join(root, 'renders/aircraft'))) addFile(`renders/aircraft/${id}/thumb.jpg`);
if (withGallery) {
  addFile('galeri.html');
  addFile('renders/manifest.json');
  addTree('renders', (rel) => /\.(png|jpe?g|webp)$/i.test(rel));
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
