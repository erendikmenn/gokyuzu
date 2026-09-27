// Persistent player settings (localStorage 'gokyuzu.settings'). Owner: the settings / audio module.
// The UI edits them (menu / pause screen, src/ui/panels.js) through saveSettings() or patchSettings(); both broadcast
// the 'gokyuzu:settings' window event (detail = the full settings object) and every module applies what it reads live:
//   main.js       quality, volumes, fps          src/audio/index.js   muted, alerts.voice / alerts.chimes
//   src/ui/hud.js hudMode                         src/ui/settings-live.js   alerts.hud / alerts.reduceFlash, telemetry
//   src/ui/touch.js tilt                          src/ui/tutorial.js   tutorial
// Old stored objects miss newer keys: loadSettings() fills every missing key (nested ones too) from DEFAULT_SETTINGS, so a
// stored { volumes: { master: .4 } } keeps its levels and gets muted: false, assist: true, the default alerts, …
import { detectQuality, capQuality, getQualityCap, clearQualityCap, qualityRank } from './quality.js';

const KEY = 'gokyuzu.settings';
export const DEFAULT_SETTINGS = {
  quality: null,            // 'low' | 'medium' | 'high' | 'ultra'; null = auto-detect from the GPU
  volumes: { master: 0.9, engine: 1, voice: 1, atc: 0.8, ambient: 0.8 },   // 0..1 (the audio applies them squared)
  muted: false,             // "Sesi kapat" / M key: everything silent, the levels above are kept; the AudioContext sleeps
  alerts: {
    voice: 'all',           // spoken alerts: 'all' | 'critical' (PULL UP / TERRAIN, SINK RATE, STALL, SPEED, engine, fire)
                            // | 'off' (src/audio/alert-prefs.js classifies them)
    chimes: true,           // alert tones: master caution / warning chimes, horns, stick shaker, clacker, A/P disconnect
    hud: true,              // warning texts on the HUD and the map strip (PULL UP, STALL, OVERSPEED …)
    reduceFlash: false,     // accessibility: warnings and highlights stay steady instead of flashing
  },
  assist: true,             // "Destekli uçuş": beginner help on take-off, in flight and on landing (the assisted-flight
                            // module reads it). Once the player turns it off it stays false: nothing but that switch sets
                            // it back to true (the settings panel's "Varsayılanlara dön" leaves it alone).
  invertPitch: false,
  hudMode: null,            // owned by the HUD (full/compact/off); null = HUD default
  atc: true,                // automatic ATC radio in solo mode
  tutorial: true,           // first-flight tutorial, opening key card and contextual hints (src/ui/tutorial.js)
  units: 'aviation',        // kt / ft (the only option for now)
  failures: 'off',          // random failures in free flight: 'off' | 'rare' | 'realistic' (src/flight/failures.js)
  fps: null,                // frame rate cap in flight: null = auto (phones 30, tablets 60 → 30 when not held, desktop
                            // the display's rate) | 30 | 60 | 0 = no limit (src/app/frame-pacing.js)
};
export const ALERT_VOICE_MODES = ['all', 'critical', 'off'];

// storage: localStorage, or this page's memory when it is unavailable (private mode quirks, blocked site data), so a
// change still holds for the rest of the visit
// (after a failed write, e.g. storage full, the memo is newer than what storage holds: it wins, or the next change made
// elsewhere, such as the M key's patch, would rebuild the settings from the stale stored object: assisted flight turned
// off came back on)
let memo = null, memoNewer = false;
function readRaw() {
  if (memo && memoNewer) { try { return JSON.parse(memo) || {}; } catch { /* */ } }
  try {
    const s = localStorage.getItem(KEY);
    if (s != null) return JSON.parse(s) || {};
  } catch { /* unavailable / corrupt: fall through */ }
  if (memo) { try { return JSON.parse(memo) || {}; } catch { /* */ } }
  return {};
}
function writeRaw(obj) {
  const json = JSON.stringify(obj);
  memo = json;
  try { localStorage.setItem(KEY, json); memoNewer = false; } catch { memoNewer = true; /* private mode / full: memo keeps it for this page */ }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const unit = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** Stored object + defaults for every missing / invalid key; no device detection (quality stays null when auto). */
export function storedSettings() {
  const s = readRaw();
  const raw = isObj(s) ? s : {};
  const D = DEFAULT_SETTINGS;
  const v = isObj(raw.volumes) ? raw.volumes : {};
  const a = isObj(raw.alerts) ? raw.alerts : {};
  const volumes = {};
  for (const k of new Set([...Object.keys(D.volumes), ...Object.keys(v)])) volumes[k] = unit(v[k], D.volumes[k] ?? 1);
  return {
    ...D, ...raw,
    volumes,
    muted: bool(raw.muted, D.muted),
    alerts: {
      ...D.alerts, ...a,
      voice: ALERT_VOICE_MODES.includes(a.voice) ? a.voice : D.alerts.voice,
      chimes: bool(a.chimes, D.alerts.chimes),
      hud: bool(a.hud, D.alerts.hud),
      reduceFlash: bool(a.reduceFlash, D.alerts.reduceFlash),
    },
    assist: bool(raw.assist, D.assist),
  };
}

export function loadSettings() {
  const merged = storedSettings();
  if (!merged.quality) merged.quality = detectQuality();
  merged.quality = capQuality(merged.quality);   // ceiling left by a graphics-memory failure on this device (gpu-guard.js)
  return merged;
}

function broadcast(settings) {
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('gokyuzu:settings', { detail: settings }));
}

/** Persist and broadcast: window event 'gokyuzu:settings' with detail = the full settings object. */
export function saveSettings(settings) {
  // the player raised the quality above the post-failure ceiling themselves: respect that from now on
  const cap = getQualityCap();
  if (cap && settings && qualityRank(settings.quality) > qualityRank(cap.q)) clearQualityCap();
  writeRaw(settings);
  broadcast(settings);
  return settings;
}

/**
 * Change a few keys without touching the others (nested `volumes` / `alerts` are merged key by key), persist, broadcast.
 * Unlike saveSettings(loadSettings()) it does not write the auto-detected quality into storage (it stays "auto").
 * patch: object, or fn(current settings) → object. Returns the full settings (as loadSettings()).
 */
export function patchSettings(patch) {
  const raw = readRaw();
  const base = isObj(raw) ? raw : {};
  const p = typeof patch === 'function' ? patch(storedSettings()) : patch;
  if (!isObj(p)) return loadSettings();
  const next = { ...base, ...p };
  for (const k of ['volumes', 'alerts']) if (isObj(p[k])) next[k] = { ...(isObj(base[k]) ? base[k] : {}), ...p[k] };
  writeRaw(next);
  const full = loadSettings();
  broadcast(full);
  return full;
}
