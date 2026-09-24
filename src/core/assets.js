// Shared asset loading: one GLTFLoader configured with Draco, Meshopt and KTX2 decoders, and the asset URL rules of
// CONTRACTS-SF.md §9:
//  - every request for a file under assets/ or renders/ carries ?v=<content hash of its directory> once published
//    (dist/assets/versions.json, written by tools/deploy/build_dist.mjs; unchanged in local development)
//  - fetches retry transient failures (network errors, 5xx, 429) with backoff; 404 and other client errors are final
// Three.js loaders get the version through the loading manager's URL modifier; plain fetches use assetFetch/assetData.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { detectDevice } from './gpu-device.js';

const ROOT = new URL('../../', import.meta.url);   // repo root = site root of the publish build (dist/)
const LIBS = new URL('node_modules/three/examples/jsm/libs/', ROOT).href;
const VERSIONED = /^(assets|renders)\//;
const ATTEMPTS = 3;

// ---------------------------------------------------------------- errors / retry policy

/** A request that failed for good. `transient` = the connection (or the server) failed, not the file: worth retrying later. */
export class AssetLoadError extends Error {
  constructor(url, status = 0, cause = null) {
    const where = shortUrl(url);
    super(status ? `HTTP ${status} ${where}` : `network error ${where}${cause && cause.message ? ` (${cause.message})` : ''}`);
    this.name = 'AssetLoadError';
    this.url = url;
    this.status = status;
    this.cause = cause;
    this.transient = transientStatus(status);
  }
}

function transientStatus(status) { return !status || status >= 500 || status === 429 || status === 408; }
function shortUrl(url) {
  try { const u = new URL(url, baseHref()); return u.origin === ROOT.origin ? u.pathname + u.search : u.href; } catch { return String(url); }
}
function baseHref() { return typeof document !== 'undefined' && document.baseURI ? document.baseURI : ROOT.href; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Backoff before attempt n+1 of one request: ~0.5 s, ~1.5 s. */
function backoff(n) { return (n === 1 ? 500 : 1500) * (0.8 + 0.4 * Math.random()); }

/**
 * True when `e` means "the connection failed" (offline, reset, DNS, 5xx, 429), as opposed to a missing/broken file or a
 * bug: fetch/body TypeErrors, AssetLoadError.transient, three.js HttpError with a transient status. Used to decide between
 * the connection error screen and other handling, and whether a retry can help.
 */
export function isNetworkError(e) {
  if (!e) return false;
  if (e instanceof AssetLoadError) return e.transient;
  if (e.name === 'AbortError') return false;
  if (e.response && typeof e.response.status === 'number') return transientStatus(e.response.status);   // three.js HttpError
  if (e instanceof TypeError) return /fetch|network|load failed/i.test(e.message || '');                  // Chrome, Safari, Firefox wording
  return false;
}

/**
 * Shared connection state: after several network failures in a row (from any request) every request pauses briefly
 * (0.5 s doubling up to 10 s) before its next attempt, so a dropped connection during flight does not turn tile
 * streaming into a storm of failing requests (each one logged by the browser). Any answer from the server resets it.
 */
const link = { fails: 0, pauseUntil: 0 };
function linkOk() { link.fails = 0; link.pauseUntil = 0; }
function linkFailed() {
  link.fails++;
  if (link.fails >= 4) link.pauseUntil = Math.max(link.pauseUntil, performance.now() + Math.min(10000, 500 * 2 ** Math.min(5, link.fails - 4)));
}
async function linkReady() {
  for (let w; (w = link.pauseUntil - performance.now()) > 0;) await sleep(w);
}

/**
 * Run `fn` (a loader call) up to 3 times while it fails with a network error. The final failure is rethrown as an
 * AssetLoadError when it was a network error (so callers can classify it), otherwise unchanged.
 */
export async function withRetry(fn, label = '') {
  for (let attempt = 1; ; attempt++) {
    await linkReady();
    try { const v = await fn(); linkOk(); return v; } catch (e) {
      if (!isNetworkError(e)) throw e;
      linkFailed();
      if (attempt >= ATTEMPTS) throw e instanceof AssetLoadError ? e : new AssetLoadError(label, e.response ? e.response.status : 0, e);
      await sleep(backoff(attempt));
    }
  }
}

/** fetch with retries. With `read`, the body is read inside the retry loop too (a download that breaks midway is retried). */
async function fetchWithRetry(url, init, read) {
  for (let attempt = 1; ; attempt++) {
    let err, wait = 0;
    await linkReady();
    try {
      const r = await fetch(url, init);
      if (transientStatus(r.status)) linkFailed(); else linkOk();
      if (r.ok || !transientStatus(r.status)) {
        if (!read) return r;                                 // caller checks r.ok (404 is final, not retried)
        if (!r.ok) throw new AssetLoadError(url, r.status);
        return await read(r);
      }
      err = new AssetLoadError(url, r.status);
      if (r.body) r.body.cancel().catch(() => {});
      const ra = Number(r.headers.get('Retry-After'));      // 429/503 may say how long to wait (capped: a game is waiting)
      if (ra > 0) wait = Math.min(ra, 5) * 1000;
    } catch (e) {
      if (e instanceof AssetLoadError && !e.transient) throw e;
      if (e && e.name === 'AbortError') throw e;
      if (!(e instanceof AssetLoadError) && !isNetworkError(e)) throw e;   // bad JSON, decode errors: not a network problem
      if (!(e instanceof AssetLoadError)) linkFailed();                     // (a transient status was counted above)
      err = e;
    }
    if (attempt >= ATTEMPTS) throw err instanceof AssetLoadError ? err : new AssetLoadError(url, 0, err);
    await sleep(wait || backoff(attempt));
  }
}

// ---------------------------------------------------------------- versions (cache busting)

let versions = null;       // { 'assets/sf/city/l0': '1a2b3c4d5e', ... }; null/{} = no versions (local development)
let versionsP = null;
let buildP = null;

/** The publish build stamp (dist/build.json; the dev server answers with a local stamp). Memoized; null if unavailable. */
export function loadBuildInfo() {
  if (!buildP) {
    buildP = fetchWithRetry(new URL('build.json', ROOT).href, { cache: 'no-cache' }, (r) => r.json()).catch((e) => {
      if (isNetworkError(e)) { buildP = null; throw e; }   // offline: a later call tries again
      return null;    // 404 on other static servers, bad JSON: treat as a development build
    });
  }
  return buildP;
}

/**
 * Load the asset version map once (call at startup, before any asset request). Resolves with the map ({} when the
 * build has none, e.g. local development). Rejects with an AssetLoadError when the connection fails; calling it again
 * after a failure retries.
 * The publish build marks itself in build.json (`versions`), so development servers are never asked for a missing
 * versions.json (a 404 would show up as a console error).
 */
export function loadAssetVersions() {
  if (!versionsP) {
    versionsP = (async () => {
      const build = await loadBuildInfo();
      if (!build || !build.versions) { versions = {}; return versions; }
      const url = new URL(build.versions, ROOT).href;
      try {
        versions = await fetchWithRetry(url, { cache: 'no-cache' }, (r) => r.json());
      } catch (e) {
        if (isNetworkError(e)) throw e;
        console.warn('[assets] no usable versions.json, loading unversioned', e.message);
        versions = {};
      }
      return versions;
    })();
    versionsP.catch(() => { versionsP = null; });
  }
  return versionsP;
}

/**
 * Wait for the version map before a request (requests started meanwhile would go out unversioned). If the page never
 * called loadAssetVersions(), the first asset request starts it once (a failure there is left to the explicit call,
 * which the game uses to show its connection error screen).
 */
let autoLoaded = false;
function versionsSettled() {
  if (!versionsP && !autoLoaded && versions === null) { autoLoaded = true; loadAssetVersions(); }
  return versionsP ? versionsP.then(() => {}, () => {}) : Promise.resolve();
}

/**
 * URL of an asset with its content version: 'assets/sf/city/l0/1_2.glb' → 'assets/sf/city/l0/1_2.glb?v=1a2b3c4d5e'.
 * Accepts page-relative, root-relative and absolute same-origin URLs (the form of the input is kept). Anything else
 * (code, data/, blob:, data:, other hosts, files not in the map, URLs that already carry v=) is returned unchanged.
 */
export function assetUrl(path) {
  if (!versions || typeof path !== 'string' || path.startsWith('blob:') || path.startsWith('data:')) return path;
  let abs;
  try { abs = new URL(path, baseHref()); } catch { return path; }
  if (abs.origin !== ROOT.origin || !abs.pathname.startsWith(ROOT.pathname) || abs.searchParams.has('v')) return path;
  let rel = abs.pathname.slice(ROOT.pathname.length);
  if (!VERSIONED.test(rel)) return path;
  try { rel = decodeURIComponent(rel); } catch { /* keep encoded */ }
  const v = versions[rel.slice(0, rel.lastIndexOf('/'))];
  if (!v) return path;
  const h = path.indexOf('#');
  const body = h >= 0 ? path.slice(0, h) : path, frag = h >= 0 ? path.slice(h) : '';
  return `${body}${body.includes('?') ? '&' : '?'}v=${v}${frag}`;
}

/** Every three.js loader on this manager requests versioned URLs (GLTF + its textures/buffers, KTX2, images). */
export function applyAssetUrls(manager = THREE.DefaultLoadingManager) {
  manager.setURLModifier(assetUrl);
  return manager;
}
applyAssetUrls(THREE.DefaultLoadingManager);   // loaders created without a manager (new THREE.TextureLoader())

/**
 * fetch() for game files: versioned URL, 3 attempts on network errors / 5xx / 429 (with backoff). Resolves with the
 * Response like fetch (check `ok`: a 404 is returned, not retried; Range requests work unchanged); rejects with an
 * AssetLoadError when every attempt failed.
 */
export async function assetFetch(path, init) {
  await versionsSettled();
  return fetchWithRetry(assetUrl(path), init);
}

/**
 * Download and read a game file: as = 'arrayBuffer' | 'json' | 'blob' | 'text'. Like assetFetch, and a download that
 * breaks midway is retried too. Rejects with an AssetLoadError (status 404 etc. = final, `transient` = connection).
 */
export async function assetData(path, as = 'arrayBuffer', init) {
  await versionsSettled();
  return fetchWithRetry(assetUrl(path), init, (r) => r[as]());
}

/**
 * True when createImageBitmap honours its options (imageOrientation / resize): the same rule as three's GLTFLoader
 * (Safari and iOS web views before 17 and Firefox before 98 ignore them and would upload images upside down).
 */
export function bitmapDecodeOk() {
  if (typeof createImageBitmap !== 'function' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const ios = /(?:iPhone|iPad|iPod).* OS (\d+)_/.exec(ua);
  if (ios && Number(ios[1]) < 17) return false;
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) ? /Version\/(\d+)/.exec(ua) : null;
  if (safari && Number(safari[1]) < 17) return false;
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (ff && Number(ff[1]) < 98) return false;
  return true;
}

/**
 * A game image for a THREE.Texture, decoded off the main thread where the browser can (createImageBitmap: an <img>
 * is decoded again, synchronously, when the texture is uploaded), optionally cut to `maxSize` (the device class's
 * texture cap: the same box/high-quality downscale the GLB texture policy does). Resolves with
 * { image, flipY, width, height, from: [w, h] }: set texture.flipY = flipY (a bitmap is already flipped like
 * THREE.TextureLoader's images are at upload; the <img> fallback keeps three's default flipY = true).
 * The fallback (old Safari / Firefox) is the plain <img> path, capped with a canvas when needed.
 */
export async function assetBitmap(path, { maxSize = 0, init } = {}) {
  if (!bitmapDecodeOk()) {
    const img = await assetImage(path, init);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (maxSize && Math.max(w, h) > maxSize) {
      const s = maxSize / Math.max(w, h), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return { image: c, flipY: true, width: c.width, height: c.height, from: [w, h] };
    }
    return { image: img, flipY: true, width: w, height: h, from: [w, h] };
  }
  const blob = await assetData(path, 'blob', init);
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
  } catch (e) {
    throw new Error(`image decode failed ${shortUrl(path)} (${e && e.message})`);
  }
  const w = bmp.width, h = bmp.height;
  if (maxSize && Math.max(w, h) > maxSize) {
    const s = maxSize / Math.max(w, h);
    try {
      const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(w * s)), resizeHeight: Math.max(1, Math.round(h * s)), resizeQuality: 'high', premultiplyAlpha: 'none' });
      bmp.close();
      bmp = small;
    } catch { /* resize unsupported: keep the full image (the renderer still uploads it) */ }
  }
  return { image: bmp, flipY: false, width: bmp.width, height: bmp.height, from: [w, h] };
}

/** Decoded HTMLImageElement of a game image (same orientation/colour handling as THREE.ImageLoader), with retries. */
export async function assetImage(path, init) {
  const blob = await assetData(path, 'blob', init);
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`image decode failed ${shortUrl(path)}`));
      img.src = src;
    });
    return img;
  } finally {
    URL.revokeObjectURL(src);
  }
}

// ---------------------------------------------------------------- streaming helpers (tiles)

/** Delay before a failed streaming tile is requested again: ~3 s, 6 s, 12 s … capped at 60 s. */
export function retryDelay(failures) {
  return Math.min(60000, 3000 * 2 ** Math.max(0, failures - 1)) * (0.75 + 0.5 * Math.random());
}

const failLog = new Map();
/**
 * Rate-limited console report of streaming failures: one warning per tag at most every 30 s, with the number of
 * failures suppressed since the last one (a dropped connection during flight must not flood the console).
 */
export function reportLoadFailure(tag, what, err) {
  const now = performance.now();
  let s = failLog.get(tag);
  if (!s) failLog.set(tag, (s = { last: -Infinity, suppressed: 0 }));
  if (now - s.last < 30000) { s.suppressed++; return; }
  const more = s.suppressed ? ` (+${s.suppressed} more)` : '';
  const retry = isNetworkError(err) ? ', retrying later' : '';
  console.warn(`[${tag}] ${what} failed${more}${retry}: ${(err && err.message) || err}`);
  s.last = now;
  s.suppressed = 0;
}

// ---------------------------------------------------------------- loader

/**
 * KTX2 files that GLBs reference by URI (assets/sf/airports/shared/*.ktx2: facade textures used by several airports,
 * written by tools/assets/textures.mjs) load once per loader: every GLB gets the same texture object, so the file is
 * downloaded, transcoded and uploaded once instead of once per airport. Embedded images (blob: URLs) pass through.
 * The shared textures live as long as the page (airport buildings are never disposed; do not dispose them).
 */
function shareKTX2(ktx2) {
  const files = new Map();
  const load = ktx2.load.bind(ktx2);
  ktx2.load = (url, onLoad, onProgress, onError) => {
    if (typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return load(url, onLoad, onProgress, onError);
    let p = files.get(url);
    if (!p) {
      // keepData: the texture policy (src/core/gpu-textures.js) keeps its CPU copy, so a later GLB can still use it
      p = new Promise((resolve, reject) => load(url, (t) => { t.userData.keepData = true; resolve(t); }, onProgress, reject));
      files.set(url, p);
      p.catch(() => { if (files.get(url) === p) files.delete(url); });   // a failed download is tried again next time
    }
    p.then(onLoad, (e) => { if (onError) onError(e); });
  };
  return ktx2;
}

/**
 * Phones load <name>.phone.glb where tools/assets/textures.mjs wrote one (listed in assets/phone-variants.json): the
 * same GLB with its KTX2 textures cut to 1024², which is all a phone keeps anyway (src/core/gpu-textures.js), e.g. the
 * F-16 exterior 5.1 → 1.7 MB. Other devices, and GLBs without a variant, load the URL as given. The list is always
 * published with the assets; if it cannot be read, phones load the full files (the texture cap still applies).
 */
const PHONE_VARIANTS = 'assets/phone-variants.json';
let phoneMapP = null;
async function phoneVariant(url) {
  let isPhone = false;
  try { isPhone = detectDevice().kind === 'phone'; } catch { /* no DOM (tests) */ }
  if (!isPhone || typeof url !== 'string') return url;
  if (!phoneMapP) {
    phoneMapP = assetData(new URL(PHONE_VARIANTS, ROOT).href, 'json').catch((e) => {
      if (isNetworkError(e)) phoneMapP = null;   // connection problem: ask again next time
      return {};
    });
  }
  const map = await phoneMapP;
  let rel;
  try {
    const abs = new URL(url, baseHref());
    if (abs.origin !== ROOT.origin || !abs.pathname.startsWith(ROOT.pathname)) return url;
    rel = decodeURIComponent(abs.pathname.slice(ROOT.pathname.length));
  } catch { return url; }
  return map && map[rel] ? new URL(map[rel], ROOT).href : url;
}

/**
 * Meshopt geometry (EXT_meshopt_compression: the city tiles of both maps) decodes in worker threads instead of on the main
 * thread (GLTFLoader uses the decoder's async path when workers exist): 2 workers, 1 on phones. Once per page.
 */
let meshoptWorkers = false;
function useMeshoptWorkers() {
  if (meshoptWorkers || typeof Worker === 'undefined' || !MeshoptDecoder.supported) return;
  meshoptWorkers = true;
  let n = 2;
  try { if (detectDevice().kind === 'phone') n = 1; } catch { /* no DOM */ }
  try { MeshoptDecoder.useWorkers(n); } catch (e) { console.warn('[assets] meshopt workers unavailable', e && e.message); }
}

export function createAssetLoader(renderer, manager = THREE.DefaultLoadingManager) {
  applyAssetUrls(manager);
  useMeshoptWorkers();
  const draco = new DRACOLoader(manager).setDecoderPath(LIBS + 'draco/gltf/');
  const ktx2 = shareKTX2(new KTX2Loader(manager).setTranscoderPath(LIBS + 'basis/'));
  if (renderer) ktx2.detectSupport(renderer);
  const gltf = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const texture = new THREE.TextureLoader(manager);
  const file = new THREE.FileLoader(manager).setResponseType('arraybuffer');
  const cache = new Map();
  const loadOnce = (url) => versionsSettled().then(() => phoneVariant(url)).then((u) => withRetry(() => gltf.loadAsync(u), u));
  return {
    gltf, ktx2, draco, texture, file, manager,
    /**
     * Load a GLB (retries network failures). Cached by default: subsequent calls return the same promise (clone the
     * scene yourself if you need copies); a failed load is dropped from the cache so a later call tries again.
     * { cache: false } for streamed tiles that are loaded, disposed and loaded again.
     */
    loadGLTF(url, { cache: useCache = true } = {}) {
      if (!useCache) return loadOnce(url);
      if (!cache.has(url)) {
        const p = loadOnce(url);
        cache.set(url, p);
        p.catch(() => { if (cache.get(url) === p) cache.delete(url); });
      }
      return cache.get(url);
    },
    async loadTexture(url, { srgb = true } = {}) {
      const t = new THREE.Texture(await assetImage(url));
      t.needsUpdate = true;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    },
    loadJSON(url) { return assetData(url, 'json'); },
    loadBinary(url) { return assetData(url, 'arrayBuffer'); },
  };
}
