// Lead-owned: graphics quality presets. World layers receive the preset object via setQuality(q)
// and pick what they need; unknown fields are ignored. main.js applies the renderer-level fields.
export const QUALITY = {
  low: {
    id: 'low', label: 'Düşük',
    pixelRatioMax: 1, shadows: false, shadowMapSize: 1024, shadowCascades: 1,
    terrainError: 2.5,      // multiplier on terrain screen-space error (higher = coarser)
    imageryMaxLevel: -2,    // drop the two finest imagery levels
    cityLodScale: 0.55, cityShadows: false, treeDensity: 0.3, treeDistance: 0.5,
    landmarkLodScale: 0.6, airportLodScale: 0.6,
    clouds: 'low', water: 'simple', anisotropy: 2, antialias: false,
  },
  medium: {
    id: 'medium', label: 'Orta',
    pixelRatioMax: 1.25, shadows: true, shadowMapSize: 2048, shadowCascades: 1,
    terrainError: 1.6, imageryMaxLevel: -1,
    cityLodScale: 0.75, cityShadows: false, treeDensity: 0.6, treeDistance: 0.75,
    landmarkLodScale: 0.8, airportLodScale: 0.8,
    clouds: 'medium', water: 'medium', anisotropy: 4, antialias: true,
  },
  high: {
    id: 'high', label: 'Yüksek',
    pixelRatioMax: 1.5, shadows: true, shadowMapSize: 4096, shadowCascades: 2,
    terrainError: 1, imageryMaxLevel: 0,
    cityLodScale: 1, cityShadows: true, treeDensity: 1, treeDistance: 1,
    landmarkLodScale: 1, airportLodScale: 1,
    clouds: 'high', water: 'high', anisotropy: 8, antialias: true,
  },
  ultra: {
    id: 'ultra', label: 'Ultra',
    pixelRatioMax: 2, shadows: true, shadowMapSize: 4096, shadowCascades: 2,
    terrainError: 0.8, imageryMaxLevel: 0,
    cityLodScale: 1.25, cityShadows: true, treeDensity: 1, treeDistance: 1.3,
    landmarkLodScale: 1.2, airportLodScale: 1.2,
    clouds: 'high', water: 'high', anisotropy: 16, antialias: true,
  },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

/** Best-guess default from the GPU name: Apple M-series Pro/Max → ultra, other Apple → high, discrete → high, integrated → medium/low. */
export function detectQuality() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl && gl.getParameter(gl.RENDERER)) || '');
    if (/Apple M\d+ (Max|Ultra|Pro)/i.test(name)) return 'ultra';
    if (/Apple (M\d|GPU)/i.test(name)) return 'high';
    if (/(NVIDIA|GeForce|RTX|Radeon RX|Radeon Pro)/i.test(name)) return 'high';
    if (/(Intel|UHD|Iris|Mali|Adreno)/i.test(name)) return 'low';
    return 'medium';
  } catch { return 'medium'; }
}
