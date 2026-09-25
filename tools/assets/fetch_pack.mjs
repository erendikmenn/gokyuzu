#!/usr/bin/env node
// Downloads the public asset pack (tools/assets/pack_public.mjs) from a GitHub release, checks every part and every
// file against the manifest's SHA-256 and installs it: assets/ -> <dest>/, assets-gpl/audio/ -> <dest>/audio/ (the
// GPL-2.0 sounds), licence / notice / readme -> <dest>/_pack/ (not published by build_dist: `_` directories are
// skipped). Node built-ins only (Node >= 22). Downloads are cached in node_modules/.cache/gokyuzu/asset-pack/ and
// resumed file by file (a part already there with the right SHA-256 is not fetched again).
//
// usage: node tools/assets/fetch_pack.mjs [--version <v>] [--dest assets] [--force]
//                                         [--from <directory or base URL holding the manifest and parts>] [--keep]
//   --force  install into a non-empty destination (files of the pack overwrite files of the same name; nothing else is
//            deleted). Without it a non-empty assets/ is left alone: it may be your own build of the assets.
//   --keep   keep the downloaded parts after installing (default: deleted once installed)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listZip, readEntry } from './lib/zip.mjs';

// The public repository whose releases hold the pack (placeholder until the repository name is decided), the pack
// version this code expects, and optionally the manifest's SHA-256 from the release notes (pins the whole download).
const GITHUB_REPO = 'erendikmenn/REPO_NAME';
const PACK_VERSION = '2026.09.25';
const MANIFEST_SHA256 = '';
const USER_AGENT = 'gokyuzu-sf-pipeline/1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const VERSION = opt('--version', PACK_VERSION);
const DEST = path.resolve(ROOT, opt('--dest', 'assets'));
const FROM = opt('--from', `https://github.com/${GITHUB_REPO}/releases/download/assets-v${VERSION}`);
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'gokyuzu', 'asset-pack', VERSION);
const NAME = `gokyuzu-assets-${VERSION}`;
const remote = /^https?:\/\//.test(FROM);

const log = (...a) => console.log('[fetch-pack]', ...a);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fileSha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(8 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** A file of the release (downloaded into the cache, or read from a local --from directory). */
async function obtain(name, expected) {
  if (!remote) {
    const p = path.resolve(FROM, name);
    if (!fs.existsSync(p)) throw new Error(`${p} not found`);
    return p;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const p = path.join(CACHE, name);
  if (expected && fs.existsSync(p) && fileSha256(p) === expected) { log(`${name}: cached`); return p; }
  const url = `${FROM.replace(/\/$/, '')}/${name}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${p}.part`;
  const fd = fs.openSync(tmp, 'w');
  let got = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      fs.writeSync(fd, chunk);
      got += chunk.length;
      if (total && Date.now() - last > 1000) { last = Date.now(); process.stdout.write(`\r[fetch-pack] ${name}: ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB   `); }
    }
  } finally { fs.closeSync(fd); }
  if (total) process.stdout.write('\n');
  fs.renameSync(tmp, p);
  return p;
}

/** Where a pack entry is installed (null: not installed). */
function target(entry) {
  if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\\')) throw new Error(`unsafe entry ${entry}`);
  if (entry.startsWith('assets/')) return path.join(DEST, entry.slice('assets/'.length));
  if (entry.startsWith('assets-gpl/audio/')) return path.join(DEST, entry.slice('assets-gpl/'.length));
  return path.join(DEST, '_pack', entry);
}

async function main() {
  if (!remote && !fs.existsSync(FROM)) throw new Error(`--from ${FROM}: not found`);
  if (remote && /REPO_NAME/.test(FROM)) throw new Error('GITHUB_REPO in tools/assets/fetch_pack.mjs is still a placeholder: set it, or pass --from <URL or directory>');
  if (fs.existsSync(DEST) && fs.readdirSync(DEST).some((f) => !f.startsWith('.')) && !argv.includes('--force')) {
    throw new Error(`${DEST} is not empty (it may hold your own build of the assets): move it away, or pass --force to install the pack over it`);
  }
  const mfName = `${NAME}.manifest.json`;
  const mfPath = await obtain(mfName, null);
  const mfBuf = fs.readFileSync(mfPath);
  if (MANIFEST_SHA256 && sha256(mfBuf) !== MANIFEST_SHA256) throw new Error(`${mfName}: SHA-256 differs from the pinned MANIFEST_SHA256`);
  const man = JSON.parse(mfBuf);
  if (man.name !== 'gokyuzu-assets' || man.version !== VERSION) throw new Error(`${mfName}: not the manifest of gokyuzu-assets ${VERSION}`);
  const want = new Map(man.files.map((f) => [f.path, f]));
  log(`gokyuzu-assets ${VERSION}: ${man.totals.files} files, ${(man.totals.bytes / 1e9).toFixed(2)} GB in ${man.parts.length} parts -> ${path.relative(ROOT, DEST) || '.'}`);
  let installed = 0;
  for (const part of man.parts) {
    const p = await obtain(part.file, part.sha256);
    if (fileSha256(p) !== part.sha256) throw new Error(`${part.file}: SHA-256 mismatch (download again)`);
    const fd = fs.openSync(p, 'r');
    try {
      for (const e of listZip(p)) {
        const f = want.get(e.name);
        if (!f) throw new Error(`${part.file}: ${e.name} is not in the manifest`);
        const data = readEntry(fd, e);
        if (data.length !== f.bytes || sha256(data) !== f.sha256) throw new Error(`${e.name}: SHA-256 mismatch`);
        const out = target(e.name);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = `${out}.tmp-${process.pid}`;          // new inode: never writes through a hard link (dist/)
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, out);
        want.delete(e.name);
        installed++;
      }
    } finally { fs.closeSync(fd); }
    log(`${part.file}: ${part.entries} files installed`);
    if (remote && !argv.includes('--keep')) fs.rmSync(p, { force: true });
  }
  if (want.size) throw new Error(`${want.size} files of the manifest were in no part, e.g. ${[...want.keys()][0]}`);
  fs.writeFileSync(path.join(DEST, '_pack', 'installed.json'), `${JSON.stringify({ name: man.name, version: VERSION, files: installed, installedAt: new Date().toISOString() }, null, 1)}\n`);
  log(`done: ${installed} files verified and installed; licence and notices in ${path.relative(ROOT, path.join(DEST, '_pack')) || '_pack'}/`);
}

main().catch((e) => { console.error(`[fetch-pack] ${e.message}`); process.exit(1); });
