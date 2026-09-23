// Asset URL versioning and retrying fetch (CONTRACTS-SF.md §9, src/core/assets.js). Run: node tests/assets.test.mjs
// No framework and no network: fetch is replaced by scripted responses, backoff waits run immediately.
// Each scenario imports its own instance of the module (?dev, ?dist, ?offline) because the version map is module state.
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

let calls = [];
let handler = () => { throw new TypeError('Failed to fetch'); };
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return handler(String(url), init, calls.length);
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, 0, ...args);   // no real backoff waits
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const notFound = () => new Response('not found', { status: 404 });
const MAP = { 'assets/sf/city/l0': 'aaaaaaaaaa', 'assets/sf/terrain/h': 'bbbbbbbbbb', 'renders/aircraft/f16': 'cccccccccc', 'assets/aircraft/f16': 'dddddddddd' };
const ROOT = new URL('../', import.meta.url).href;   // repo root = what assets.js resolves against outside a page

// ---- local development: build.json has no `versions` -> versions.json is never requested (no console-visible 404)
{
  const A = await import('../src/core/assets.js?dev');
  handler = (url) => (url.endsWith('/build.json') ? json({ version: 'dev', target: 'local' }) : notFound());
  calls = [];
  check('dev: URL unchanged before the map is loaded', A.assetUrl('assets/sf/city/l0/1_2.glb') === 'assets/sf/city/l0/1_2.glb');
  const v = await A.loadAssetVersions();
  check('dev: empty map', v && Object.keys(v).length === 0);
  check('dev: only build.json requested', calls.length === 1 && calls[0].url.endsWith('/build.json'), calls.map((c) => c.url).join(', '));
  check('dev: URLs stay unversioned', A.assetUrl('assets/sf/city/l0/1_2.glb') === 'assets/sf/city/l0/1_2.glb');
}

// ---- publish build: every file under assets/ and renders/ gets ?v=<hash of its directory>
const A = await import('../src/core/assets.js?dist');
handler = (url) => (url.endsWith('/build.json') ? json({ versions: 'assets/versions.json' }) : url.includes('/assets/versions.json') ? json(MAP) : notFound());
calls = [];
await A.loadAssetVersions();
check('dist: versions.json revalidated on load (cache: no-cache)', calls.some((c) => c.url.endsWith('/assets/versions.json') && c.init && c.init.cache === 'no-cache'));
const cases = [
  ['relative', 'assets/sf/city/l0/1_2.glb', 'assets/sf/city/l0/1_2.glb?v=aaaaaaaaaa'],
  ['./relative', './assets/sf/city/l0/1_2.glb', './assets/sf/city/l0/1_2.glb?v=aaaaaaaaaa'],
  ['absolute (model.js URLs)', ROOT + 'assets/aircraft/f16/f16.glb', ROOT + 'assets/aircraft/f16/f16.glb?v=dddddddddd'],
  ['renders/ (menu thumbnails)', 'renders/aircraft/f16/thumb.jpg', 'renders/aircraft/f16/thumb.jpg?v=cccccccccc'],
  ['existing query + fragment', 'assets/sf/terrain/h/5.bin?x=1#f', 'assets/sf/terrain/h/5.bin?x=1&v=bbbbbbbbbb#f'],
  ['already versioned (audio per-file hash)', 'assets/sf/city/l0/1_2.glb?v=zzz', 'assets/sf/city/l0/1_2.glb?v=zzz'],
  ['directory not in the map', 'assets/sf/city/l1/1_2.glb', 'assets/sf/city/l1/1_2.glb'],
  ['only the file\'s own directory counts', 'assets/sf/city/l0/sub/x.glb', 'assets/sf/city/l0/sub/x.glb'],
  ['data/ is not versioned', 'data/sf/runways.json', 'data/sf/runways.json'],
  ['code is not versioned', 'src/core/assets.js', 'src/core/assets.js'],
  ['other origin', 'https://example.com/assets/sf/city/l0/1_2.glb', 'https://example.com/assets/sf/city/l0/1_2.glb'],
  ['blob: (GLB-embedded images)', 'blob:null/1234', 'blob:null/1234'],
  ['data: URL', 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
];
for (const [name, input, want] of cases) { const got = A.assetUrl(input); check(`assetUrl: ${name}`, got === want, got); }
check('three.js loaders: URL modifier installed on a manager', (() => {
  const m = { setURLModifier(f) { this.f = f; return this; } };
  A.applyAssetUrls(m);
  return m.f('assets/sf/city/l0/1_2.glb') === 'assets/sf/city/l0/1_2.glb?v=aaaaaaaaaa';
})());

// ---- assetFetch / assetData: 3 attempts on network errors, 5xx, 429; 404 final; Range kept
{
  handler = (url, init, k) => { if (k < 3) throw new TypeError('Failed to fetch'); return new Response(new Uint8Array([1, 2, 3]), { status: 206 }); };
  calls = [];
  const r = await A.assetFetch('assets/sf/terrain/h/5.bin', { headers: { Range: 'bytes=0-2' } });
  check('retry: 2 network errors then 206', r.status === 206 && calls.length === 3, `${calls.length} calls`);
  check('retry: versioned URL and Range header on every attempt', calls.every((c) => c.url.endsWith('5.bin?v=bbbbbbbbbb') && c.init.headers.Range === 'bytes=0-2'));
}
{
  handler = notFound; calls = [];
  const r = await A.assetFetch('assets/sf/city/l0/9_9.glb');
  check('404: returned to the caller, not retried', r.status === 404 && calls.length === 1);
  let err = null; calls = [];
  try { await A.assetData('assets/sf/city/l0/9_9.glb', 'json'); } catch (e) { err = e; }
  check('404 via assetData: final AssetLoadError', err instanceof A.AssetLoadError && err.status === 404 && !err.transient && !A.isNetworkError(err) && calls.length === 1);
}
{
  handler = () => new Response('busy', { status: 503 }); calls = [];
  let err = null;
  try { await A.assetFetch('assets/sf/city/l0/1_2.glb'); } catch (e) { err = e; }
  check('503 three times: transient AssetLoadError after 3 attempts', err instanceof A.AssetLoadError && err.transient && A.isNetworkError(err) && calls.length === 3);
}
{
  handler = (url, init, k) => (k === 1 ? json({}, 429, { 'Retry-After': '1' }) : json({ ok: 1 })); calls = [];
  const d = await A.assetData('assets/sf/city/l0/index.json', 'json');
  check('429 then 200: retried', d.ok === 1 && calls.length === 2);
}
{
  handler = (url, init, k) => {
    if (k > 1) return new Response(new Uint8Array([7, 7]), { status: 200 });
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new TypeError('network error')); } });
    return new Response(body, { status: 200 });
  };
  calls = [];
  const buf = await A.assetData('assets/sf/city/l0/1_2.glb', 'arrayBuffer');
  check('download broken midway: retried by assetData', buf.byteLength === 2 && calls.length === 2);
}
{
  handler = () => new Response('{nope', { status: 200 }); calls = [];
  let err = null;
  try { await A.assetData('assets/sf/city/l0/x.json', 'json'); } catch (e) { err = e; }
  check('bad JSON: not a network error, not retried', err && !A.isNetworkError(err) && calls.length === 1);
}

// ---- withRetry (three.js loader calls) and error classification
{
  let k = 0;
  const v = await A.withRetry(async () => { k++; if (k < 3) throw new TypeError('Failed to fetch'); return 'ok'; }, 'x.glb');
  check('withRetry: network errors retried', v === 'ok' && k === 3);
  k = 0; let err = null;
  try { await A.withRetry(async () => { k++; throw new TypeError('Load failed'); }, 'x.glb'); } catch (e) { err = e; }
  check('withRetry: gives up after 3 with a transient AssetLoadError', k === 3 && err instanceof A.AssetLoadError && A.isNetworkError(err));
  k = 0; err = null;
  try { await A.withRetry(async () => { k++; const e = new Error('fetch for "x" responded with 404'); e.response = { status: 404 }; throw e; }, 'x.glb'); } catch (e) { err = e; }
  check('withRetry: three.js HttpError 404 not retried', err && k === 1 && !A.isNetworkError(err));
  k = 0; err = null;
  try { await A.withRetry(async () => { k++; throw new TypeError("Cannot read properties of undefined (reading 'x')"); }, 'x.glb'); } catch (e) { err = e; }
  check('withRetry: code bugs are not network errors', err && k === 1 && !A.isNetworkError(err));
}
check('retryDelay: grows, capped at ~60 s', A.retryDelay(1) < A.retryDelay(3) && A.retryDelay(30) <= 60000 * 1.25);

// ---- offline at startup: loadAssetVersions rejects (-> error screen), a later call (Tekrar dene) tries again
{
  const B = await import('../src/core/assets.js?offline');
  let online = false;
  handler = (url) => { if (!online) throw new TypeError('Failed to fetch'); return url.endsWith('/build.json') ? json({ versions: 'assets/versions.json' }) : json(MAP); };
  let err = null;
  try { await B.loadAssetVersions(); } catch (e) { err = e; }
  check('offline: loadAssetVersions rejects with a network error', err && B.isNetworkError(err), err && err.message);
  online = true;
  const v = await B.loadAssetVersions();
  check('offline: the next call loads the map', v['assets/sf/city/l0'] === 'aaaaaaaaaa' && B.assetUrl('assets/sf/city/l0/a.glb') === 'assets/sf/city/l0/a.glb?v=aaaaaaaaaa');
}

globalThis.setTimeout = realSetTimeout;
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
