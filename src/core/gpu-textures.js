// Texture memory policy (robustness; wired by main.js through src/core/gpu-guard.js):
//  - GLBs loaded through the shared loader: textures larger than quality.textureMaxSize are downscaled once at load
//    (tablets / phones / integrated GPUs: a 4096² aircraft atlas is 89 MB of GPU memory with mipmaps, 22 MB at 2048²)
//  - with quality.releaseImages, sweep(scene) drops the decoded CPU copy (ImageBitmap / <img>, as large as the GPU copy
//    and kept for the page's lifetime by three.js) of every image texture in the scene once all textures sharing it are
//    on the GPU. Nothing needs it again: after a WebGL context loss the game reloads into the same flight instead of
//    restoring in place (src/core/gpu-guard.js). Canvas / video / data textures are never touched.
// Rules for code with image textures in the scene: do not dispose() one and draw it again, and do not clone() it after
// its first frame (a released texture has no image to upload from). needsUpdate on a released texture is ignored
// unless a new image was assigned (e.g. an anisotropy change applies from the next load).

const KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap',
  'displacementMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap', 'specularIntensityMap', 'specularColorMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap'];

function texturesOf(root) {
  const bySource = new Map();
  root.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m) continue;
      for (const k of KEYS) {
        const t = m[k];
        if (!t || !t.isTexture || t.isCompressedTexture || t.isDataTexture || !t.source) continue;
        let set = bySource.get(t.source);
        if (!set) bySource.set(t.source, (set = new Set()));
        set.add(t);
      }
    }
  });
  return bySource;
}

/** Downscaled copy of a decoded image (ImageBitmap / HTMLImageElement / canvas) or null when not needed / possible. */
export async function shrinkImage(img, maxSize) {
  const w = img && (img.naturalWidth || img.width), h = img && (img.naturalHeight || img.height);
  if (!w || !h || Math.max(w, h) <= maxSize) return null;
  const s = maxSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(img, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (b.width === nw && b.height === nh) return b;
      if (b.close) b.close();
    } catch { /* resize options unsupported: canvas below */ }
  }
  try {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(nw, nh) : Object.assign(document.createElement('canvas'), { width: nw, height: nh });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, nw, nh);
    if (typeof createImageBitmap === 'function') {
      const b = await createImageBitmap(c, { premultiplyAlpha: 'none' });
      if (!(typeof OffscreenCanvas === 'function' && c instanceof OffscreenCanvas)) { c.width = c.height = 0; }   // free the canvas backing store
      return b;
    }
    return c;
  } catch { return null; }
}

function freeze(tex) {
  // a released texture keeps its GPU copy: ignore re-upload requests while it has no image (a newly assigned image
  // uploads normally)
  Object.defineProperty(tex, 'needsUpdate', {
    configurable: true, get() { return false; },
    set(v) { if (v === true && tex.source && tex.source.data) { tex.version++; tex.source.needsUpdate = true; } },
  });
}
const isImage = (d) => !!d && ((typeof ImageBitmap !== 'undefined' && d instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && d instanceof HTMLImageElement));
const MIN_PIXELS = 256 * 256;   // small images are not worth the bookkeeping

/**
 * createTexturePolicy(renderer, getQuality) → { plugin, sweep(), stats }
 *   plugin   GLTFLoader plugin factory: loader.register(policy.plugin)
 *   sweep(scene)  releases the CPU images whose textures are all on the GPU (call every few seconds)
 */
export function createTexturePolicy(renderer, getQuality) {
  const stats = { downscaled: 0, savedMB: 0, released: 0, releasedMB: 0 };
  const maxTex = () => Math.min((renderer && renderer.capabilities && renderer.capabilities.maxTextureSize) || 16384, (getQuality() || {}).textureMaxSize || 16384);

  async function apply(root) {
    const limit = maxTex();
    const jobs = [];
    for (const [source, set] of texturesOf(root)) {
      const img = source.data;
      if (!img) continue;
      jobs.push((async () => {
        const small = await shrinkImage(img, limit).catch(() => null);
        if (small) {
          const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          stats.downscaled++;
          stats.savedMB += ((w * h - small.width * small.height) * 4 * 4 / 3) / 1048576;
          source.data = small;
          for (const t of set) { t.needsUpdate = true; t.userData.downscaledFrom = [w, h]; }
          if (img.close) img.close();
        }
      })());
    }
    await Promise.all(jobs);
  }

  /** Release the CPU copies of uploaded image textures found in `root` (every texture sharing a source must be uploaded). */
  function sweep(root) {
    const q = getQuality() || {};
    if (!q.releaseImages || !renderer || !root) return;
    const props = renderer.properties;
    const bySource = new Map();
    const visit = (t) => {
      if (!t || !t.isTexture || !t.source || t.isRenderTargetTexture) return;
      const d = t.source.data;
      if (!isImage(d) || (d.naturalWidth || d.width) * (d.naturalHeight || d.height) < MIN_PIXELS) return;
      let set = bySource.get(t.source);
      if (!set) bySource.set(t.source, (set = new Set()));
      set.add(t);
    };
    root.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        if (!m) continue;
        for (const k of KEYS) visit(m[k]);
        if (m.envMap) visit(m.envMap);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) visit(u.value);
      }
    });
    for (const [source, set] of bySource) {
      let ready = true;
      for (const t of set) {
        const p = props.get(t);
        if (!p.__webglTexture || p.__version !== t.version) { ready = false; break; }
      }
      if (!ready) continue;
      const img = source.data;
      const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
      source.data = null;
      if (img.close) img.close();
      for (const t of set) freeze(t);
      stats.released++;
      stats.releasedMB += (w * h * 4) / 1048576;
    }
  }

  return {
    stats,
    /** GLTFLoader plugin (loader.gltf.register(policy.plugin)). */
    plugin: () => ({ name: 'gokyuzu_texture_policy', afterRoot: (result) => apply(result.scene || (result.scenes && result.scenes[0]) || { traverse() {} }) }),
    apply,
    sweep,
  };
}
