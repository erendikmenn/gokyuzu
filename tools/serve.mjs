#!/usr/bin/env node
// Static dev server for the repo root with correct MIME types, byte ranges and no caching.
// Handles many parallel requests (several agents screenshot at once).
//
//   node tools/serve.mjs [port] [--root <dir>] [--assets-from [<base URL>]]
//
//   port                 default 5173
//   --root <dir>         default: the repo; e.g. --root dist to test the publish build
//   --assets-from [URL]  for a checkout without the built game files (assets/ and renders/ are not in git; about 2.8 GB
//                        are published): a file under /assets/ or /renders/ that is missing locally is fetched on
//                        demand from URL (default https://fs.erenailab.com), one exact file per request, and cached in
//                        .cache/assets/ (gitignored). Local files always win. Only GET, at most 6 upstream requests in
//                        flight, no prefetching or mirroring. Upstream URLs carry the file's ?v=<directory hash> from the
//                        site's assets/versions.json (or the request's own ?v=), so a changed file is fetched again
//                        once and the CDN answers from the same cached objects the players get.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : null;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = rootArg ? path.resolve(repo, rootArg) : repo;
const port = Number(argv.find((a) => /^\d+$/.test(a)) || 5173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.f32': 'application/octet-stream', '.u16': 'application/octet-stream',
};

// ---------------------------------------------------------------------------------------- remote game files (opt-in)
const REMOTE_DEFAULT = 'https://fs.erenailab.com';
const remoteBase = (() => {
  const i = argv.indexOf('--assets-from');
  if (i < 0) return null;
  const next = argv[i + 1];
  return (next && /^https?:\/\//i.test(next) ? next : REMOTE_DEFAULT).replace(/\/+$/, '');
})();
const REMOTE_PATH = /^\/(assets|renders)\//;
const CACHE = path.join(repo, '.cache', 'assets');   // .cache/assets/<site path>, plus <file>.meta.json (version, time)
const MAX_IN_FLIGHT = 6;
const USER_AGENT = 'gokyuzu-dev-server';
const UNVERSIONED_TTL = 24 * 3600e3;   // files not in versions.json: refetched after a day (the site's own max-age)
const VERSIONS_TTL = 5 * 60e3;         // versions.json is re-read at most every 5 min (the site's max-age for it)
const MISSING_TTL = 10 * 60e3;         // a 404 upstream is remembered for 10 min

let inFlight = 0;
const waiting = [];
const acquire = () => (inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };   // a waiter inherits the slot
const stats = { files: 0, bytes: 0, errors: 0, printed: '' };
const missing = new Map();    // site path -> time until which a 404 is remembered
const pending = new Map();    // "path?v" -> promise of the download (concurrent requests share one fetch)
let versions = null, versionsAt = 0, versionsP = null, challengeHint = false;

async function upstream(url, dest) {
  await acquire();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
    const challenged = /challenge/i.test(r.headers.get('cf-mitigated') || '');
    if (challenged && !challengeHint) {
      challengeHint = true;
      console.warn(`[assets-from] ${remoteBase} answered with a Cloudflare challenge: pass the CloudFront host instead, e.g. --assets-from https://dXXXXXXXXXXXXX.cloudfront.net`);
    }
    if (!r.ok || !dest) {
      if (!r.ok && r.body) r.body.cancel().catch(() => {});
      return { status: r.status, challenged, json: r.ok ? await r.json() : null };
    }
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      if (r.body) await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
      else fs.writeFileSync(tmp, '');
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return { status: 200 };
  } finally {
    release();
  }
}

/** The site's directory → content hash map (assets/versions.json), refreshed at most every VERSIONS_TTL. */
async function remoteVersions() {
  if (versions && Date.now() - versionsAt < VERSIONS_TTL) return versions;
  if (!versionsP) {
    versionsP = upstream(`${remoteBase}/assets/versions.json`, null).then((r) => {
      if (r.status === 200 && r.json && typeof r.json === 'object') versions = r.json;
      else { stats.errors++; console.warn(`[assets-from] versions.json: HTTP ${r.status}, fetching unversioned`); }
    }, (e) => {
      stats.errors++; console.warn(`[assets-from] versions.json: ${e.message}, fetching unversioned`);
    }).then(() => { versions = versions || {}; versionsAt = Date.now(); versionsP = null; return versions; });
  }
  return versionsP;
}

/** Path of the cached copy of `rel` (e.g. 'assets/sf/city/l0/1_2.glb') for version `v`, downloading it if needed. */
async function remoteFile(rel, requestedV) {
  const v = requestedV || (await remoteVersions())[rel.slice(0, rel.lastIndexOf('/'))] || '';
  const file = path.join(CACHE, rel);
  const metaFile = `${file}.meta.json`;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (fs.existsSync(file) && (v ? meta.v === v : !meta.v && Date.now() - meta.at < UNVERSIONED_TTL)) return { file };
  } catch { /* not cached yet */ }
  if ((missing.get(rel) || 0) > Date.now()) return { status: 404 };
  const key = `${rel}?${v}`;
  if (!pending.has(key)) {
    const url = `${remoteBase}/${rel.split('/').map(encodeURIComponent).join('/')}${v ? `?v=${encodeURIComponent(v)}` : ''}`;
    pending.set(key, upstream(url, file).then((r) => {
      if (r.status === 200) {
        fs.writeFileSync(metaFile, JSON.stringify({ v, at: Date.now() }));
        stats.files++; stats.bytes += fs.statSync(file).size;
        return 200;
      }
      // the bucket answers 403 for a key that does not exist (no public listing): a 4xx is a missing file, except a
      // Cloudflare challenge, a rate limit (429) or a timeout (408), which are passed on as 502 (the game retries those)
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 && !r.challenged) {
        missing.set(rel, Date.now() + MISSING_TTL);
        console.warn(`[assets-from] not on the site (HTTP ${r.status}): ${rel}`);
        return 404;
      }
      stats.errors++; console.warn(`[assets-from] HTTP ${r.status} ${rel}`);
      return 502;
    }, (e) => { stats.errors++; console.warn(`[assets-from] ${rel}: ${e.message}`); return 502; })
      .finally(() => pending.delete(key)));
  }
  const status = await pending.get(key);
  return status === 200 ? { file } : { status: status === 404 ? 404 : 502 };
}

if (remoteBase) {
  setInterval(() => {
    const line = `[assets-from] ${stats.files} files, ${(stats.bytes / 1e6).toFixed(1)} MB fetched, ${stats.errors} errors`;
    if (line !== stats.printed) { stats.printed = line; console.log(line); }
  }, 10000).unref();
}

// ------------------------------------------------------------------------------------------------------------ server
function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
  };
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const urlPath = decodeURIComponent(url.pathname);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    // usage beacons (src/core/telemetry.js, only sent here with ?telemetry=1): answered like the CloudFront Function, printed for checks
    if (urlPath === '/_e') { console.log(`[beacon] ${url.search}`); res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return; }
    // the publish build writes build.json into dist/; the repo root answers with a local stamp instead of a console-visible 404
    if (urlPath === '/build.json' && !fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"version":"dev","target":"local"}');
      return;
    }
    if (!fs.existsSync(file) && remoteBase && REMOTE_PATH.test(urlPath)) {
      const rel = path.posix.normalize(urlPath).slice(1);
      if (rel.split('/').includes('..') || !REMOTE_PATH.test(`/${rel}`)) { res.writeHead(403).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' }).end('only GET'); return; }
      const got = await remoteFile(rel, url.searchParams.get('v') || '');
      if (!got.file) { res.writeHead(got.status, { 'Content-Type': 'text/plain' }).end(got.status === 404 ? 'not found' : 'upstream error'); return; }
      sendFile(req, res, got.file);
      return;
    }
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    sendFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e));
  }
}).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}/`);
  if (remoteBase) console.log(`missing /assets/ and /renders/ files: fetched on demand from ${remoteBase}, cached in ${path.relative(repo, CACHE)}/`);
  else if (!fs.existsSync(path.join(root, 'assets'))) console.log('no assets/ here: add --assets-from to fetch the game files on demand from the published site (tools/README.md)');
});
