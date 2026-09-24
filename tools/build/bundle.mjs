// Production JavaScript bundle for the publish build (called by tools/deploy/build_dist.mjs; development is unchanged:
// tools/serve.mjs serves src/ unbundled through each page's import map).
//
// Per page (index.html, ada.html):
//  - esbuild bundles the page's module script into minified ES modules with code splitting, written flat to dist/js/ as
//    <name>-<content hash>.js: lazily imported modules (aircraft model/spec, sound profiles, …) become their own chunks.
//    Bare imports resolve through the page's own import map ("three", "three/addons/").
//  - `import.meta.url` keeps meaning "where this file is in the source tree": a module that uses it gets a constant
//    new URL('../<source path>', import.meta.url) (every chunk lives one level below the site root), so asset, font, data
//    and decoder URLs (src/core/assets.js ROOT, three's Draco/Basis defaults, …) resolve exactly as in development.
//  - Dynamic imports of a runtime URL, `import(new URL('…', import.meta.url).href)`, become `import('…')` so esbuild can
//    split them. A template literal becomes a glob over the matching files; its lookup throws synchronously for a path that
//    is not in the bundle, so it is wrapped in a promise (like import(), it rejects instead). A glob that matches no file
//    yet (a map's optional module, e.g. src/missions/<map>/challenges.js before it is written) is allowed: it rejects at
//    runtime like a missing module. Any other import esbuild cannot follow fails the build (it would load an unbundled
//    second copy of a module).
//  - The page is rewritten: no import map, the entry chunk as its module script, <link rel="modulepreload"> for every chunk
//    the entry imports statically (they would otherwise be discovered only after the entry has downloaded).
//  - Source maps are written next to the chunks as external files without a sourceMappingURL comment (browsers never ask
//    for them); deploy.sh does not upload *.map, build_dist.mjs archives them locally (see tools/build/symbolicate.mjs).
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

export const JS_DIR = 'js';
// Browsers that run the unbundled site (import maps: Chrome/Edge 89, Safari 16.4, Firefox 108); esbuild only lowers syntax
// newer than these, so the bundle runs wherever the source ran.
export const TARGET = ['chrome89', 'edge89', 'safari16.4', 'firefox108'];
// Telemetry reports errors as file:line only (src/core/telemetry.js): short lines keep that line number meaningful.
const LINE_LIMIT = 500;

const IMPORT_MAP_RE = /\n?[ \t]*<script type="importmap">([\s\S]*?)<\/script>/;
const MODULE_RE = /<script type="module" src="([^"]+)"><\/script>/g;
const posix = (p) => p.split(path.sep).join('/');

/** esbuild plugin: bare specifiers through the page's import map (exact keys and "prefix/" keys, longest prefix first). */
function importMapPlugin(pageDir, imports) {
  const exact = new Map(), prefixes = [];
  for (const [k, v] of Object.entries(imports)) {
    if (k.endsWith('/')) prefixes.push([k, path.resolve(pageDir, v)]);
    else exact.set(k, path.resolve(pageDir, v));
  }
  prefixes.sort((a, b) => b[0].length - a[0].length);
  return {
    name: 'import-map',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (a) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(a.path)) return undefined;   // URLs: esbuild reports them
        if (exact.has(a.path)) return { path: exact.get(a.path) };
        for (const [k, dir] of prefixes) if (a.path.startsWith(k)) return { path: path.join(dir, a.path.slice(k.length)) };
        return { errors: [{ text: `"${a.path}" is not in the import map of the page` }] };
      });
    },
  };
}

// import(new URL(<string or template literal>, import.meta.url)[.href]) → import(<literal>)
const RUNTIME_URL_IMPORT_RE = /\bimport\(\s*new URL\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*,\s*import\.meta\.url\s*\)(?:\.href)?\s*\)/g;
// import(`…${x}…`) (an esbuild glob import) → Promise.resolve().then(() => import(`…`))
const GLOB_IMPORT_RE = /\bimport\(\s*(`[^`]*\$\{[^`]*`)\s*\)/g;

/** esbuild plugin: per-module import.meta.url (see the header) and analysable runtime-URL imports, for every file under root. */
function sourceUrlPlugin(root, jsDir) {
  const fromChunks = posix(path.relative(path.join(root, jsDir), root)) || '.';   // '..'
  return {
    name: 'source-url',
    setup(b) {
      b.onLoad({ filter: /\.m?js$/ }, (a) => {
        const rel = posix(path.relative(root, a.path));
        if (rel.startsWith('../')) return undefined;
        let code = fs.readFileSync(a.path, 'utf8');
        if (!code.includes('import.meta') && !/\bimport\(\s*`/.test(code)) return undefined;
        code = code.replace(RUNTIME_URL_IMPORT_RE, 'import($1)').replace(GLOB_IMPORT_RE, 'Promise.resolve().then(() => import($1))');
        const uses = /\bimport\.meta\.url\b/.test(code);
        code = code.replace(/\bimport\.meta\.url\b/g, '__moduleUrl');
        if (/\bimport\.meta\b/.test(code)) return { errors: [{ text: `${rel}: import.meta other than import.meta.url is not supported by the bundle` }] };
        // on the first source line, so the source map's line numbers stay those of the file
        if (uses) code = `const __moduleUrl = new URL(${JSON.stringify(`${fromChunks}/${rel}`)}, import.meta.url).href;` + code;
        return { contents: code, loader: 'js' };
      });
    },
  };
}

/** The static import closure of an output file in an esbuild metafile (output keys are relative to absWorkingDir). */
function staticClosure(outputs, key) {
  const seen = new Set();
  (function walk(k) {
    if (seen.has(k) || !outputs[k]) return;
    seen.add(k);
    for (const i of outputs[k].imports || []) if (i.kind === 'import-statement' && !i.external) walk(i.path);
  })(key);
  return [...seen];
}

/**
 * Bundle the module script of `page` (repo-relative, e.g. 'index.html') into dist/js and write the rewritten page to
 * dist/<page>. Returns { entry, preload, outputs } (file names relative to dist/js) and the esbuild metafile.
 * (Preloading the five lazily imported aircraft model chunks the menu needs for its thumbnails was measured too: 4G menu
 * 1.20 s either way, fast 3G 5.43 vs 5.51 s, so only the entry's static imports are preloaded.)
 */
export async function bundlePage({ root, dist, page }) {
  const pagePath = path.join(root, page);
  const pageDir = path.dirname(pagePath);
  let html = fs.readFileSync(pagePath, 'utf8');
  const map = IMPORT_MAP_RE.exec(html);
  const imports = map ? JSON.parse(map[1]).imports || {} : {};
  const scripts = [...html.matchAll(MODULE_RE)];
  if (scripts.length !== 1) throw new Error(`${page}: expected exactly one <script type="module" src>, found ${scripts.length}`);
  const entryAbs = path.resolve(pageDir, scripts[0][1]);
  const name = path.basename(path.dirname(entryAbs));   // src/app/main.js → "app", src/ada/main.js → "ada"
  const outdir = path.join(dist, JS_DIR);

  const res = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [{ in: entryAbs, out: name }],
    bundle: true, splitting: true, format: 'esm', outdir,
    entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]',
    minify: true, lineLimit: LINE_LIMIT, target: TARGET, charset: 'utf8', legalComments: 'eof',
    sourcemap: 'external', sourcesContent: true,
    metafile: true, logLevel: 'silent',
    plugins: [importMapPlugin(pageDir, imports), sourceUrlPlugin(root, JS_DIR)],
  });
  // a dynamic import esbuild could not follow would fetch an unbundled module at runtime: fail instead
  const noMatch = (w) => /^The glob pattern import\(.*\) did not match any files$/.test(w.text);
  const bad = res.warnings.filter((w) => /import|require|resolve/i.test(w.text) && !noMatch(w));
  if (bad.length) throw new Error(`${page}: ${bad.map((w) => `${w.location ? `${w.location.file}:${w.location.line} ` : ''}${w.text}`).join('; ')}`);
  for (const w of res.warnings) console.warn(`[bundle] ${page}: ${w.location ? `${w.location.file}:${w.location.line} ` : ''}${w.text}`);

  const outputs = res.metafile.outputs;
  const rel = (k) => posix(path.relative(outdir, path.resolve(root, k)));
  // esbuild leaves import(<expression>) alone without a warning: every dynamic import left must name a chunk
  for (const k of Object.keys(outputs)) {
    if (!k.endsWith('.js')) continue;
    const left = fs.readFileSync(path.resolve(root, k), 'utf8').match(/\bimport\((?!"\.\/[\w.-]+\.js"\))[^)]{0,60}/g);
    if (left) throw new Error(`${page}: ${rel(k)} keeps a runtime import esbuild could not follow: ${left[0]}… (use a string or template literal)`);
  }
  const entryKey = Object.keys(outputs).find((k) => outputs[k].entryPoint && path.resolve(root, outputs[k].entryPoint) === entryAbs);
  if (!entryKey) throw new Error(`${page}: entry chunk not found in the esbuild metafile`);
  const preload = staticClosure(outputs, entryKey).filter((k) => k !== entryKey).map(rel);
  const entry = rel(entryKey);

  // the page: import map out (nothing bare is left), modulepreload for the entry's static chunks, entry chunk as the script
  if (map) html = html.replace(IMPORT_MAP_RE, '');
  const links = preload.map((f) => `  <link rel="modulepreload" href="./${JS_DIR}/${f}" />\n`).join('');
  html = html.replace('</head>', `${links}</head>`);
  html = html.replace(MODULE_RE, `<script type="module" src="./${JS_DIR}/${entry}"></script>`);
  const out = path.join(dist, page);
  fs.rmSync(out, { force: true });   // dist holds hard links into the repo: never write through them
  fs.writeFileSync(out, html);

  return { page, entry, preload, outputs: Object.keys(outputs).filter((k) => k.endsWith('.js')).map(rel), metafile: res.metafile };
}
