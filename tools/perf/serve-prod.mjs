#!/usr/bin/env node
// Production-like static server for load measurements: HTTP/2 over TLS (self-signed; Chromium runs with
// --ignore-certificate-errors), the Cache-Control policy of tools/deploy/deploy.sh (node_modules 7 d, assets/renders
// 1 d, JSON under assets 5 min, the rest 5 min), ETag revalidation (304), byte ranges (206), and Brotli for text
// types like Cloudflare (optionally also for binaries: --br-binary glb,bin to measure that option).
// usage: node tools/perf/serve-prod.mjs --root <dist dir> [--port 5443] [--br-binary glb,bin] [--no-compress] [--revalidate]
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(opt('--root', 'dist'));
const port = Number(opt('--port', 5443));
const brBinary = new Set((opt('--br-binary', '') || '').split(',').filter(Boolean).map((e) => '.' + e));
const compress = !argv.includes('--no-compress');
// --revalidate: every response max-age=0 (a returning player whose 1-day copies expired: every file costs a 304 round trip)
const revalidate = argv.includes('--revalidate');
const certDir = opt('--certs', path.join(os.tmpdir(), 'gokyuzu-perf', 'certs'));
fs.mkdirSync(certDir, { recursive: true });
const key = path.join(certDir, 'key.pem'), cert = path.join(certDir, 'cert.pem');
if (!fs.existsSync(key)) execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${key} -out ${cert} -days 30 -subj /CN=localhost 2>/dev/null`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.gz': 'application/gzip',
};
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.wasm', '.ttf']);   // Cloudflare compresses these (checked live: js, json, font/ttf; wasm is on its list)
const cacheControl = (rel, ext) => {
  if (revalidate) return 'public, max-age=0, must-revalidate';
  if (rel.startsWith('node_modules/')) return 'public, max-age=604800';
  if (rel === 'assets/versions.json' || (rel.startsWith('assets/') && ext === '.json')) return 'public, max-age=300';
  if (rel.startsWith('assets/') || rel.startsWith('renders/')) return 'public, max-age=86400';
  return 'public, max-age=300';
};
const brCache = new Map();
const stats = { requests: 0, bytes: 0 };

const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true });
server.on('stream', (stream, headers) => {
  try {
    const url = new URL(headers[':path'], 'https://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel === '_e') { stream.respond({ ':status': 204, 'cache-control': 'no-store' }); stream.end(); return; }
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { stream.respond({ ':status': 404 }); stream.end('not found'); return; }
    const st = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const base = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cacheControl(rel, ext), etag, 'accept-ranges': 'bytes', vary: 'accept-encoding' };
    stats.requests++;
    if (headers['if-none-match'] === etag) { stream.respond({ ':status': 304, ...base }); stream.end(); return; }
    const range = headers.range && /bytes=(\d*)-(\d*)/.exec(headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      stream.respond({ ':status': 206, ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (headers[':method'] === 'HEAD') { stream.end(); return; }
      stats.bytes += end - start + 1;
      fs.createReadStream(file, { start, end }).pipe(stream);
      return;
    }
    const wantsBr = compress && /\bbr\b/.test(headers['accept-encoding'] || '') && (TEXT.has(ext) || brBinary.has(ext));
    if (wantsBr) {
      let buf = brCache.get(file);
      if (!buf || buf.mtime !== st.mtimeMs) {
        const q = TEXT.has(ext) ? 11 : 9;   // static text: precompressible at 11 (like a build step); binaries 9
        buf = Object.assign(zlib.brotliCompressSync(fs.readFileSync(file), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: st.size } }), { mtime: st.mtimeMs });
        brCache.set(file, buf);
      }
      stream.respond({ ':status': 200, ...base, 'content-encoding': 'br', 'content-length': buf.length });
      stats.bytes += buf.length;
      stream.end(headers[':method'] === 'HEAD' ? undefined : buf);
      return;
    }
    stream.respond({ ':status': 200, ...base, 'content-length': st.size });
    if (headers[':method'] === 'HEAD') { stream.end(); return; }
    stats.bytes += st.size;
    fs.createReadStream(file).pipe(stream);
  } catch (e) {
    try { stream.respond({ ':status': 500 }); stream.end(String(e)); } catch { /* closed */ }
  }
});
server.on('sessionError', () => {});
server.listen(port, () => console.log(`serve-prod: https://localhost:${port}/ root ${root} (h2, brotli text${brBinary.size ? ' + ' + [...brBinary].join(',') : ''})`));
process.on('SIGUSR2', () => console.log(JSON.stringify(stats)));
