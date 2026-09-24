// Lead-owned: persistent player settings (localStorage 'gokyuzu.settings').
// The UI edits them (menu / pause screen) through saveSettings(); main.js listens for the
// 'gokyuzu:settings' window event and applies changes live.
import { detectQuality, capQuality, getQualityCap, clearQualityCap, qualityRank } from './quality.js';

const KEY = 'gokyuzu.settings';
export const DEFAULT_SETTINGS = {
  quality: null,            // 'low' | 'medium' | 'high' | 'ultra'; null = auto-detect from the GPU
  volumes: { master: 0.9, engine: 1, voice: 1, atc: 0.8, ambient: 0.8 },
  invertPitch: false,
  hudMode: null,            // owned by the HUD (full/compact/off); null = HUD default
  atc: true,                // automatic ATC radio in solo mode
  tutorial: true,           // first-flight tutorial, opening key card and contextual hints (src/ui/tutorial.js)
  units: 'aviation',        // kt / ft (the only option for now)
  failures: 'off',          // random failures in free flight: 'off' | 'rare' | 'realistic' (src/flight/failures.js)
};

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  const merged = { ...DEFAULT_SETTINGS, ...s, volumes: { ...DEFAULT_SETTINGS.volumes, ...(s.volumes || {}) } };
  if (!merged.quality) merged.quality = detectQuality();
  merged.quality = capQuality(merged.quality);   // ceiling left by a graphics-memory failure on this device (gpu-guard.js)
  return merged;
}

/** Persist and broadcast: window event 'gokyuzu:settings' with detail = the full settings object. */
export function saveSettings(settings) {
  // the player raised the quality above the post-failure ceiling themselves: respect that from now on
  const cap = getQualityCap();
  if (cap && settings && qualityRank(settings.quality) > qualityRank(cap.q)) clearQualityCap();
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('gokyuzu:settings', { detail: settings }));
  return settings;
}
