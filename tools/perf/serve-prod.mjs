#!/usr/bin/env node
// Production-like static server for load measurements: HTTP/2 over TLS (self-signed; Chromium runs with
// --ignore-certificate-errors), the Cache-Control policy of tools/deploy/deploy.sh (--policy deploy: js/ a year +
// immutable, pages no-cache, node_modules 7 d, assets/renders 1 d, JSON under assets 5 min, the rest 5 min), ETag
// revalidation (304), byte ranges (206), and Brotli for text types like Cloudflare (optionally also for binaries:
// --br-binary glb,bin, which production's Cloudflare zone does).
// --origin-ms <ms>: every no-cache / revalidated request (pages, build.json, versions.json, expired copies) waits that long
// before its answer, like a CDN edge asking S3 (staging from Türkiye: 40–220 ms); cached answers are immediate.
// --policy <name>: a candidate Cache-Control policy instead of deploy.sh's (see POLICIES below).
// --expire: every max-age except the immutable chunks' is 1 s, so a second visit 2 s later is a player returning after the
// copies expired (a day later in production); stale-while-revalidate windows are kept.
// Network shaping in the server (any browser engine, unlike CDP's emulation, which only Chromium has): one link shared
// by every connection, `down` kbit/s paced in 5 ms slices round-robin over the responses in flight, each response's
// headers delayed by `lat` ms (like DevTools' request latency). Set per run: GET /__shape?down=9000&lat=60 (down=0: off).
// usage: node tools/perf/serve-prod.mjs --root <dist dir> [--port 5443] [--br-binary glb,bin] [--no-compress] [--revalidate]
//          [--origin-ms 150] [--policy deploy|deploy0] [--expire]
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
const originMs = Number(opt('--origin-ms', 0));
const policy = opt('--policy', 'deploy');   // (the version map itself stays 5 min without a stale window, like deploy.sh)
const expire = argv.includes('--expire');
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
// tools/deploy/deploy.sh; 'deploy0' = its policy before stale-while-revalidate (2026-09-27): versioned game files 1 day
// (JSON 5 min) with a blocking revalidation after that
const POLICIES = {
  deploy0: { js: 'public, max-age=31536000, immutable', html: 'no-cache', node: 'public, max-age=604800', json: 'public, max-age=300', assets: 'public, max-age=86400', rest: 'public, max-age=300' },
};
POLICIES.deploy = { ...POLICIES.deploy0, assets: 'public, max-age=86400, stale-while-revalidate=2592000', json: 'public, max-age=300, stale-while-revalidate=2592000' };
POLICIES.swr = POLICIES.deploy;
if (!POLICIES[policy]) throw new Error(`--policy ${policy}: one of ${Object.keys(POLICIES).join(', ')}`);
const cacheControl = (rel, ext) => {
  const cc = cacheControlOf(rel, ext);
  return expire && !/immutable/.test(cc) ? cc.replace(/max-age=\d+/, 'max-age=1') : cc;
};
const cacheControlOf = (rel, ext) => {
  const P = POLICIES[policy];
  if (revalidate) return 'public, max-age=0, must-revalidate';
  if (rel.startsWith('js/')) return P.js;
  if (ext === '.html') return P.html;
  if (rel.startsWith('node_modules/')) return P.node;
  if (rel === 'assets/versions.json') return POLICIES.deploy0.json;
  if (rel.startsWith('assets/') && ext === '.json') return P.json;
  if (rel.startsWith('assets/') || rel.startsWith('renders/')) return P.assets;
  return P.rest;
};
// a request the browser sends without a fresh copy of its own: a CDN edge has to ask the origin for no-cache pages and
// for conditional requests (If-None-Match), since deploys invalidate the edges' copies (a first request per edge too)
const originWait = (headers, cc) => (originMs > 0 && (headers['if-none-match'] || /no-cache|max-age=0\b/.test(cc) || headers['cache-control'] === 'no-cache') ? originMs : 0);
const brCache = new Map();
const stats = { requests: 0, bytes: 0, r304: 0 };

// ---- network shaping (see the header)
const shape = { down: 0, lat: 0 };
const flows = new Set();   // responses being paced: { stream, buf, off }
let lastTick = 0, carry = 0, ticking = null;
function tick() {
  const now = performance.now();
  const dt = Math.min(50, now - lastTick);
  lastTick = now;
  for (const f of flows) if (f.stream.destroyed || f.stream.closed) flows.delete(f);
  if (!flows.size) { clearInterval(ticking); ticking = null; carry = 0; return; }
  let budget = carry + shape.down * 125 * dt / 1000;   // kbit/s → bytes per ms
  // round-robin in 1 KB steps: every response in flight gets an equal share of the link, like parallel TCP streams
  const list = [...flows];
  const give = new Map(list.map((f) => [f, 0]));
  for (let active = list.length; budget >= 1024 && active > 0;) {
    active = 0;
    for (const f of list) {
      const left = f.buf.length - f.off - give.get(f);
      if (left <= 0) continue;
      const n = Math.min(1024, left, budget);
      give.set(f, give.get(f) + n); budget -= n; active++;
      if (budget < 1024) break;
    }
  }
  carry = Math.min(budget, 64 * 1024);
  for (const [f, n] of give) {
    if (!n) continue;
    f.stream.write(f.buf.subarray(f.off, f.off + n));
    f.off += n;
    stats.bytes += n;
    if (f.off >= f.buf.length) { f.stream.end(); flows.delete(f); }
  }
}
/** Respond with `buf` (a Buffer) through the shaper, or at once when shaping is off. */
function send(stream, hdrs, buf, head) {
  const go = () => {
    if (stream.destroyed || stream.closed) return;
    stream.respond(hdrs);
    if (head || !buf || !buf.length) { stream.end(); return; }
    if (!shape.down) { stats.bytes += buf.length; stream.end(buf); return; }
    flows.add({ stream, buf, off: 0 });
    if (!ticking) { lastTick = performance.now(); ticking = setInterval(tick, 5); }
  };
  if (shape.lat) setTimeout(go, shape.lat); else go();
}

const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true });
server.on('stream', (stream, headers) => {
  try {
    const url = new URL(headers[':path'], 'https://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (rel === '_e') { stream.respond({ ':status': 204, 'cache-control': 'no-store' }); stream.end(); return; }
    if (rel === '__shape') {   // network shaping for the next runs (load.mjs --shaper server)
      shape.down = Number(url.searchParams.get('down')) || 0; shape.lat = Number(url.searchParams.get('lat')) || 0;
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'cache-control': 'no-store' }); stream.end(JSON.stringify(shape)); return;
    }
    if (rel === '__stats') { stream.respond({ ':status': 200, 'content-type': 'application/json', 'cache-control': 'no-store' }); stream.end(JSON.stringify(stats)); return; }
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { stream.respond({ ':status': 404 }); stream.end('not found'); return; }
    const st = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const base = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cacheControl(rel, ext), etag, 'accept-ranges': 'bytes', vary: 'accept-encoding' };
    stats.requests++;
    const wait = originWait(headers, base['cache-control']);
    if (wait) { setTimeout(() => answer(stream, headers, { rel, file, st, ext, etag, base }), wait); return; }
    answer(stream, headers, { rel, file, st, ext, etag, base });
  } catch (e) {
    try { stream.respond({ ':status': 500 }); stream.end(String(e)); } catch { /* closed */ }
  }
});
function answer(stream, headers, { file, st, ext, etag, base }) {
  try {
    if (stream.destroyed) return;
    const head = headers[':method'] === 'HEAD';
    if (headers['if-none-match'] === etag) { stats.r304++; send(stream, { ':status': 304, ...base }, null, true); return; }
    const range = headers.range && /bytes=(\d*)-(\d*)/.exec(headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      const buf = head ? null : readRange(file, start, end);
      send(stream, { ':status': 206, ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 }, buf, head);
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
      send(stream, { ':status': 200, ...base, 'content-encoding': 'br', 'content-length': buf.length }, buf, head);
      return;
    }
    send(stream, { ':status': 200, ...base, 'content-length': st.size }, head ? null : fs.readFileSync(file), head);
  } catch (e) {
    try { stream.respond({ ':status': 500 }); stream.end(String(e)); } catch { /* closed */ }
  }
}
function readRange(file, start, end) {
  const buf = Buffer.allocUnsafe(end - start + 1);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  return buf;
}
server.on('sessionError', () => {});
server.listen(port, () => console.log(`serve-prod: https://localhost:${port}/ root ${root} (h2, brotli text${brBinary.size ? ' + ' + [...brBinary].join(',') : ''}, policy ${policy}${expire ? ' (expiring)' : ''}${originMs ? `, origin ${originMs} ms` : ''})`));
process.on('SIGUSR2', () => console.log(JSON.stringify(stats)));
