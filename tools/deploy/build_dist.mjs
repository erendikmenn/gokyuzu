#!/usr/bin/env node
// Builds dist/ = exactly the files the published game needs (no Blender sources, caches, raw data, tests, dev pages).
// Files are hard-linked (no extra disk space). Usage: node tools/deploy/build_dist.mjs [--gallery]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist');
const withGallery = process.argv.includes('--gallery');

// directory names and file patterns that are build inputs / caches, never loaded by the game
const SKIP_DIRS = new Set(['_bake', 'bake', 'build', 'render', 'cache', 'raw', 'src_img', '__pycache__', 'before', 'fidelity', 'ref']);
// aircraft textures are embedded in the GLBs (tex/ holds bake inputs); other layers (airports) load tex/ at runtime
const SKIP_UNDER = [['assets/aircraft', 'tex']];
const SKIP_FILE = /(\.(blend\d?|exr|tif|tiff|py|pyc|psd|kra|log)$)|(^\.)|(^compare)|(^cmp)/i;

let files = 0, bytes = 0;
function link(src, rel) {
  const dst = path.join(dist, rel);
  if (fs.existsSync(dst)) return;   // already added (e.g. menu thumbnails + gallery)
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch (e) { if (e.code === 'EXDEV') fs.copyFileSync(src, dst); else throw e; }
  files++; bytes += fs.statSync(src).size;
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

console.log(`dist/: ${files} files, ${(bytes / 1e9).toFixed(2)} GB`);
