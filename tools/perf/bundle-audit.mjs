#!/usr/bin/env node
// JavaScript delivery audit: the module graph the browser walks today (static closure of src/app/main.js through the
// import map, its depth = sequential round trips without modulepreload, bytes raw/gzip/brotli) versus an esbuild
// production bundle (ESM, minified, code splitting for the lazily imported aircraft modules).
// esbuild is not a repo dependency: install it anywhere and point PERF_NODE_MODULES at that node_modules
// (e.g. npm i --prefix /tmp/x esbuild; PERF_NODE_MODULES=/tmp/x/node_modules).
// usage: node tools/perf/bundle-audit.mjs [--root <repo or worktree>] [--write <outdir>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { arg, save, OUT } from './lib.mjs';

const root = path.resolve(arg('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')));
const nm = process.env.PERF_NODE_MODULES || path.join(os.tmpdir(), 'gokyuzu-perf', 'node', 'node_modules');
const esbuild = createRequire(path.join(nm, 'x.js'))('esbuild');
const gz = (b) => zlib.gzipSync(b, { level: 9 }).length;
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const threeAlias = { three: path.join(root, 'node_modules/three/build/three.module.js') };
const aliasPlugin = {
  name: 'importmap',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: threeAlias.three }));
    b.onResolve({ filter: /^three\/addons\// }, (a) => ({ path: path.join(root, 'node_modules/three/examples/jsm', a.path.slice('three/addons/'.length)) }));
  },
};

// 1) module graph as served today (metafile of an unminified, unbundled analysis build)
const meta = (await esbuild.build({ entryPoints: [path.join(root, 'src/app/main.js')], bundle: true, write: false, format: 'esm', metafile: true, splitting: true, outdir: '/tmp/perf-unused', plugins: [aliasPlugin], logLevel: 'silent' })).metafile;
const inputs = meta.inputs;
const staticClosure = new Set(), all = new Set(Object.keys(inputs));
const entry = path.relative(process.cwd(), path.join(root, 'src/app/main.js'));
const entryKey = Object.keys(inputs).find((k) => k.endsWith('src/app/main.js')) || entry;
const depth = new Map();
(function walk(k, d) {
  if (staticClosure.has(k) && depth.get(k) >= d) return;
  staticClosure.add(k); depth.set(k, Math.max(d, depth.get(k) || 0));
  for (const imp of inputs[k].imports || []) if (imp.kind === 'import-statement' && inputs[imp.path]) walk(imp.path, d + 1);
})(entryKey, 1);
const fileStats = (keys) => {
  let raw = 0, g = 0, b = 0;
  for (const k of keys) { const buf = fs.readFileSync(path.resolve(process.cwd(), k)); raw += buf.length; g += gz(buf); b += br(buf); }
  return { modules: keys.length, rawKB: Math.round(raw / 1024), gzipKB: Math.round(g / 1024), brotliKB: Math.round(b / 1024) };
};
const staticKeys = [...staticClosure];
const byArea = {};
for (const k of staticKeys) {
  const a = /three\/build/.test(k) ? 'three core' : /examples\/jsm/.test(k) ? 'three addons' : (/src\/([^/]+)/.exec(k) || [0, 'other'])[1];
  (byArea[a] || (byArea[a] = [])).push(k);
}
const graph = {
  staticClosure: fileStats(staticKeys),
  allIncludingLazy: fileStats([...all]),
  maxDepth: Math.max(...depth.values()),
  byArea: Object.fromEntries(Object.entries(byArea).map(([a, ks]) => [a, fileStats(ks)])),
  largest: staticKeys.map((k) => ({ k: k.replace(/^.*?(src|node_modules)\//, '$1/'), kb: Math.round(inputs[k].bytes / 1024) })).sort((a, b) => b.kb - a.kb).slice(0, 12),
};

// 2) production bundle: minified ESM with splitting (aircraft modules stay lazy chunks)
const outdir = arg('--write', path.join(OUT, 'bundle'));
fs.rmSync(outdir, { recursive: true, force: true });
const t0 = Date.now();
const res = await esbuild.build({ entryPoints: [path.join(root, 'src/app/main.js')], bundle: true, minify: true, format: 'esm', splitting: true, target: ['es2022', 'safari16'], outdir, metafile: true, plugins: [aliasPlugin], logLevel: 'silent', legalComments: 'none' });
const buildMs = Date.now() - t0;
const outs = Object.entries(res.metafile.outputs).filter(([k]) => k.endsWith('.js')).map(([k, v]) => {
  const buf = fs.readFileSync(path.resolve(process.cwd(), k));
  return { file: path.basename(k), entry: !!v.entryPoint, rawKB: Math.round(buf.length / 1024), gzipKB: Math.round(gz(buf) / 1024), brotliKB: Math.round(br(buf) / 1024) };
});
const main = outs.filter((o) => o.file === 'main.js');
const startupChunks = (() => {   // entry + the chunks it imports statically
  const o = res.metafile.outputs; const k0 = Object.keys(o).find((k) => o[k].entryPoint && o[k].entryPoint.endsWith('src/app/main.js')); const seen = new Set();
  (function w(k) { if (seen.has(k)) return; seen.add(k); for (const i of o[k].imports || []) if (i.kind === 'import-statement') w(i.path); })(k0);
  return [...seen];
})();
const sum = (list, f) => list.reduce((a, x) => a + x[f], 0);
const startup = outs.filter((x) => startupChunks.some((k) => k.endsWith(x.file)));
const bundle = { buildMs, files: outs.length, startup: { files: startup.length, rawKB: sum(startup, 'rawKB'), gzipKB: sum(startup, 'gzipKB'), brotliKB: sum(startup, 'brotliKB') }, total: { rawKB: sum(outs, 'rawKB'), gzipKB: sum(outs, 'gzipKB'), brotliKB: sum(outs, 'brotliKB') }, entry: main, chunks: outs.filter((o) => o.file !== 'main.js').sort((a, b) => b.rawKB - a.rawKB).slice(0, 8), lazyEntries: outs.filter((o) => o.entry && o.file !== 'main.js').length };
// modulepreload list for the unbundled site: every module of the static closure, as the import map resolves it
const rootRel = (k) => path.relative(root, path.resolve(process.cwd(), k)).split(path.sep).join('/');
const preload = staticKeys.map(rootRel).filter((p) => !p.startsWith('..')).sort((a, b) => depth.get(staticKeys.find((k) => rootRel(k) === a)) - depth.get(staticKeys.find((k) => rootRel(k) === b)));
fs.writeFileSync(path.join(OUT, 'modulepreload.html'), preload.map((p) => `  <link rel="modulepreload" href="./${p}">`).join('\n') + '\n');
const out = { root, graph, bundle, preloadCount: preload.length };
console.log(JSON.stringify(out, null, 1));
save('bundle-audit.json', out);
