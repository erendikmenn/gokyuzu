#!/usr/bin/env node
// Installs the texture tool chain for tools/assets/textures.mjs, without Homebrew or admin rights:
//   1. npm packages (sharp, ktx-parse, ktx2-encoder for its WebAssembly Basis transcoder, gltf-validator):
//        npm ci --prefix tools/assets
//   2. the Khronos KTX-Software command line tool `ktx` (Basis Universal encoder, native and multithreaded, no source
//      size limit) from the pinned GitHub release, SHA-256 checked, unpacked into tools/assets/.bin/<platform>/
//      (macOS: the .pkg is expanded with pkgutil, nothing is installed system-wide; Linux: the .tar.bz2).
// usage: node tools/assets/setup.mjs            (idempotent; prints the ktx path)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '4.4.2';
const URL_BASE = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}/`;
const RELEASES = {
  'darwin-arm64': { file: `KTX-Software-${VERSION}-Darwin-arm64.pkg`, sha256: '500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c' },
  'darwin-x64': { file: `KTX-Software-${VERSION}-Darwin-x86_64.pkg`, sha256: 'efecc685ab891a6e119a9fdc8cbe038e135f9a367eb2f5d8a059553f947f1fea' },
  'linux-x64': { file: `KTX-Software-${VERSION}-Linux-x86_64.tar.bz2`, sha256: 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245' },
  'linux-arm64': { file: `KTX-Software-${VERSION}-Linux-arm64.tar.bz2`, sha256: '60382e7b842177b8048bd58ccdc770383f8ef65b94452a25d3afdb55f2405c5a' },
};
const platform = `${os.platform()}-${os.arch()}`;
export const KTX_DIR = path.join(HERE, '.bin', `ktx-${VERSION}-${platform}`);
export const KTX_BIN = path.join(KTX_DIR, 'bin', 'ktx');

function run(cmd, args, opts = {}) { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString(); }

export function ktxVersion() {
  try { return run(KTX_BIN, ['--version']).trim(); } catch { return null; }
}

async function install() {
  const rel = RELEASES[platform];
  if (!rel) throw new Error(`no pinned KTX-Software build for ${platform}; install KTX-Software ${VERSION} and put ktx at ${KTX_BIN}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktxsw-'));
  try {
    const dl = path.join(tmp, rel.file);
    console.log(`downloading ${rel.file} …`);
    const r = await fetch(URL_BASE + rel.file);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${URL_BASE + rel.file}`);
    fs.writeFileSync(dl, Buffer.from(await r.arrayBuffer()));
    const sum = crypto.createHash('sha256').update(fs.readFileSync(dl)).digest('hex');
    if (sum !== rel.sha256) throw new Error(`SHA-256 mismatch for ${rel.file}: ${sum}`);
    fs.rmSync(KTX_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(KTX_DIR, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(KTX_DIR, 'lib'), { recursive: true });
    let root;
    if (rel.file.endsWith('.pkg')) {
      const x = path.join(tmp, 'x');
      run('pkgutil', ['--expand-full', dl, x]);
      const sub = (name) => path.join(x, fs.readdirSync(x).find((d) => d.endsWith(`${name}.pkg`)), 'Payload', 'usr', 'local');
      fs.cpSync(path.join(sub('tools'), 'bin', 'ktx'), KTX_BIN);
      root = sub('library');
    } else {
      run('tar', ['-xjf', dl, '-C', tmp]);
      root = path.join(tmp, fs.readdirSync(tmp).find((d) => d.startsWith('KTX-Software') && !d.endsWith('.bz2')));
      fs.cpSync(path.join(root, 'bin', 'ktx'), KTX_BIN);
    }
    // the binary finds libktx through @executable_path/../lib (macOS) / $ORIGIN/../lib (Linux)
    for (const f of fs.readdirSync(path.join(root, 'lib'))) if (/^libktx\./.test(f)) fs.cpSync(path.join(root, 'lib', f), path.join(KTX_DIR, 'lib', f), { verbatimSymlinks: true });
    fs.chmodSync(KTX_BIN, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(HERE, 'node_modules', 'sharp'))) {
    console.log('npm ci --prefix tools/assets …');
    run('npm', ['ci', '--prefix', HERE], { stdio: 'inherit' });
  }
  if (!ktxVersion()) await install();
  const v = ktxVersion();
  if (!v || !v.includes(VERSION)) { console.error(`ktx not usable at ${KTX_BIN}`); process.exit(1); }
  console.log(`${v} at ${path.relative(process.cwd(), KTX_BIN)}`);
}
