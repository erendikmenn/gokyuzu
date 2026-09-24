// Lead-owned: graphics quality presets. World layers receive the preset object via setQuality(q)
// and pick what they need; unknown fields are ignored. main.js applies the renderer-level fields.
//
// Memory fields (robustness): every preset carries a GPU memory budget and caps that bound what streaming may keep
// resident, and resolveQuality() lowers them further for memory-limited device classes (src/core/gpu-device.js):
//   gpuBudgetMB      resident WebGL allocations the budget monitor (src/core/gpu-guard.js) steps the quality down at
//   maxImageryTiles  resident terrain imagery tiles (≈ 1.4 MB of GPU memory each with mipmaps; LRU-evicted by terrain)
//   textureMaxSize   GLB textures larger than this are downscaled at load (src/core/gpu-textures.js)
//   releaseImages    drop the decoded CPU copy of GLB / terrain images once they are on the GPU (the context-loss
//                    policy reloads instead of restoring in place, so nothing needs to re-upload them)
//   lazyCockpit      stream the detailed cockpit GLB only when the cockpit view is first entered
//   cityUnloadAfter  seconds a city tile may stay loaded after it was last needed (default 20)
import { detectDevice } from './gpu-device.js';

export const QUALITY = {
  low: {
    id: 'low', label: 'Düşük',
    pixelRatioMax: 1, shadows: false, shadowMapSize: 1024, shadowCascades: 1,
    terrainError: 2.5,      // multiplier on terrain screen-space error (higher = coarser)
    imageryMaxLevel: -2,    // drop the two finest imagery levels
    cityLodScale: 0.55, cityShadows: false, treeDensity: 0.3, treeDistance: 0.5,
    landmarkLodScale: 0.6, airportLodScale: 0.6,
    clouds: 'low', water: 'simple', anisotropy: 2, antialias: false,
    gpuBudgetMB: 1700, maxImageryTiles: 200, textureMaxSize: 2048, releaseImages: true, lazyCockpit: false,
  },
  medium: {
    id: 'medium', label: 'Orta',
    pixelRatioMax: 1.25, shadows: true, shadowMapSize: 2048, shadowCascades: 1,
    terrainError: 1.6, imageryMaxLevel: -1,
    cityLodScale: 0.75, cityShadows: false, treeDensity: 0.6, treeDistance: 0.75,
    landmarkLodScale: 0.8, airportLodScale: 0.8,
    clouds: 'medium', water: 'medium', anisotropy: 4, antialias: true,
    gpuBudgetMB: 2000, maxImageryTiles: 320, textureMaxSize: 4096, releaseImages: true, lazyCockpit: false,
  },
  high: {
    id: 'high', label: 'Yüksek',
    pixelRatioMax: 1.5, shadows: true, shadowMapSize: 4096, shadowCascades: 2,
    terrainError: 1, imageryMaxLevel: 0,
    cityLodScale: 1, cityShadows: true, treeDensity: 1, treeDistance: 1,
    landmarkLodScale: 1, airportLodScale: 1,
    clouds: 'high', water: 'high', anisotropy: 8, antialias: true,
    gpuBudgetMB: 3000, maxImageryTiles: 520, textureMaxSize: 4096, releaseImages: true, lazyCockpit: false, cityUnloadAfter: 12,
  },
  ultra: {
    id: 'ultra', label: 'Ultra',
    pixelRatioMax: 2, shadows: true, shadowMapSize: 4096, shadowCascades: 2,
    terrainError: 0.8, imageryMaxLevel: 0,
    cityLodScale: 1.25, cityShadows: true, treeDensity: 1, treeDistance: 1.3,
    landmarkLodScale: 1.2, airportLodScale: 1.2,
    clouds: 'high', water: 'high', anisotropy: 16, antialias: true,
    gpuBudgetMB: 3800, maxImageryTiles: 520, textureMaxSize: 4096, releaseImages: true, lazyCockpit: false, cityUnloadAfter: 12,
  },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

/**
 * Per device-class caps, applied on top of any preset (numbers: the smaller value wins; booleans: forced).
 * Phones/tablets are limited by what iOS/Android let one tab keep (GPU process + web process), not by GPU speed;
 * integrated GPUs share system memory with the browser.
 */
export const DEVICE_CAPS = {
  phone: {
    pixelRatioMax: 1.25, shadowMapSize: 1024, shadowCascades: 1, maxImageryTiles: 90, textureMaxSize: 512,
    cityLodScale: 0.4, treeDensity: 0.3, treeDistance: 0.5, landmarkLodScale: 0.5, airportLodScale: 0.5, anisotropy: 2,
    cityUnloadAfter: 6, gpuBudgetMB: 900, lazyCockpit: true,
  },
  tablet: {
    pixelRatioMax: 1.25, shadowMapSize: 2048, shadowCascades: 1, maxImageryTiles: 130, textureMaxSize: 2048,
    cityLodScale: 0.5, treeDensity: 0.5, treeDistance: 0.6, landmarkLodScale: 0.7, airportLodScale: 0.7, anisotropy: 4,
    cityUnloadAfter: 8, gpuBudgetMB: 1400, lazyCockpit: true,
  },
  integrated: { maxImageryTiles: 200, textureMaxSize: 2048, shadowMapSize: 2048, cityUnloadAfter: 12, gpuBudgetMB: 1700, lazyCockpit: true },
  unknown: { textureMaxSize: 2048, gpuBudgetMB: 2000 },
  software: { pixelRatioMax: 1, shadowMapSize: 1024, maxImageryTiles: 120, textureMaxSize: 1024, gpuBudgetMB: 800, lazyCockpit: true },
};

/**
 * GPU-meter budgets for WebKit phones / tablets (docs/perf/findings-2026-09.md T5). WebKit's WebContent + GPU process
 * footprint was 2.5–4× the meter (≈ 270 MB for any WebGL page + 2.5 × meter); iOS kills the page or drops the context on
 * the footprint. Budgets from the footprint that held on the owner's iPad (medium, meter 0.8–1.0 GB → ~2.8 GB) and that
 * failed (high, meter 1.3–1.4 GB → ~3.7 GB), phones from the low preset's 1.5–2.2 GB: tablet ≈ 3.0 GB, phone ≈ 2.1 GB.
 */
export const WEBKIT_FOOTPRINT_MB = { tablet: 3000, phone: 2100 };
export const webkitMeterBudget = (footprintMB) => Math.round((footprintMB - 270) / 2.5);

/** Device-class key into DEVICE_CAPS (null = no extra caps). */
export function capClass(d = detectDevice()) {
  if (d.kind === 'phone' || d.kind === 'tablet') return d.kind;
  if (d.tier === 'integrated' || d.tier === 'software' || d.tier === 'unknown') return d.tier;
  return null;
}

const resolved = new Map();
/**
 * The preset to run with on this device: QUALITY[id] with the device caps applied (memoized per id, so identity
 * comparisons in main.js keep working).
 */
export function resolveQuality(id, device = detectDevice()) {
  const base = QUALITY[id] || QUALITY.high;
  const cls = capClass(device);
  const key = `${base.id}|${cls}|${device.engine || ''}`;
  if (resolved.has(key)) return resolved.get(key);
  const q = { ...base };
  const caps = cls ? DEVICE_CAPS[cls] : null;
  if (caps) {
    for (const [k, v] of Object.entries(caps)) {
      if (typeof v === 'number' && typeof q[k] === 'number') q[k] = Math.min(q[k], v);
      else q[k] = v;
    }
    if (q.shadowCascades < 2 && q.shadowMapSize > 2048) q.shadowMapSize = 2048;
  }
  if (device.engine === 'webkit' && WEBKIT_FOOTPRINT_MB[cls]) q.gpuBudgetMB = Math.min(q.gpuBudgetMB, webkitMeterBudget(WEBKIT_FOOTPRINT_MB[cls]));
  q.deviceClass = cls || 'desktop';
  resolved.set(key, q);
  return q;
}

/** One step down (null below 'low'). */
export function lowerQuality(id) {
  const i = QUALITY_ORDER.indexOf(id);
  return i > 0 ? QUALITY_ORDER[i - 1] : null;
}
export const qualityRank = (id) => QUALITY_ORDER.indexOf(id);

// ---- quality ceiling after a graphics-memory failure (localStorage 'gokyuzu.gpuCap') ----
// A WebGL context loss on this device stores the preset the game was reloaded with; later sessions start no higher
// until the player picks a quality themselves (settings.js clears it then).
const CAP_KEY = 'gokyuzu.gpuCap';
export function getQualityCap() {
  try { const c = JSON.parse(localStorage.getItem(CAP_KEY) || 'null'); return c && QUALITY[c.q] ? c : null; } catch { return null; }
}
export function setQualityCap(q) {
  try { const c = getQualityCap(); localStorage.setItem(CAP_KEY, JSON.stringify({ q, t: Date.now(), n: ((c && c.n) || 0) + 1 })); } catch { /* private mode */ }
}
export function clearQualityCap() { try { localStorage.removeItem(CAP_KEY); } catch { /* ignore */ } }
/** `id` limited by the stored ceiling. */
export function capQuality(id) {
  const c = getQualityCap();
  return c && qualityRank(id) > qualityRank(c.q) ? c.q : id;
}

/**
 * Best-guess default from the device class and GPU name: phones → low, tablets → medium (+ tablet caps),
 * Apple M-series Pro/Max → ultra, other Apple / discrete → high, integrated / software → low, unknown → medium.
 */
export function detectQuality() {
  try {
    const d = detectDevice();
    if (d.kind === 'phone') return 'low';
    if (d.kind === 'tablet') return 'medium';
    switch (d.tier) {
      case 'apple-pro': return 'ultra';
      case 'apple': case 'discrete': return 'high';
      case 'integrated': case 'software': return 'low';
      default: return 'medium';
    }
  } catch { return 'medium'; }
}
