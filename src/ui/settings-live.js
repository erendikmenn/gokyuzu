// Settings that act on the whole page rather than on one module, loaded with the settings panel (src/ui/panels.js):
//
//  1. Warning display (settings.alerts, src/core/settings.js) as classes on <html>, so every surface follows without
//     reading the settings itself:
//       html.gk-no-warntext  alerts.hud === false: no warning texts on the HUD (src/ui/hud.js .gkh-warn) or the map strip
//                            (src/ui/map.js .gkn-wn); the aural alerts and the cockpit instruments are not affected
//       html.gk-calm         alerts.reduceFlash: warnings, the mission timer and the touch highlights stay steady
//     Canvas-drawn instruments (src/avionics) can ask reducedFlash() / warningTextsOn() before blinking.
//  2. Telemetry: one small `set` beacon per changed setting (src/core/telemetry.js trackEvent), e.g. { k: 'master', v2: 50 },
//     { k: 'mute', v2: 1 }, { k: 'assist', v2: 0 }. Values are buckets / short codes (volumes 0 | 25 | 50 | 75 | 100),
//     nothing personal; a slider drag or a burst of changes sends only the settled values (1.5 s after the last change).
//  3. createMuteButton(): a speaker button bound to settings.muted (the M key and "Sesi kapat" are the same switch),
//     for the settings panel and any other surface (pause screen, touch controls).
import { injectCSS } from './styles.js';
import { el } from './util.js';
import { storedSettings, patchSettings } from '../core/settings.js';
import { detectQuality } from '../core/quality.js';
import { trackEvent } from '../core/telemetry.js';

const CSS = `
html.gk-no-warntext .gkh-warn, html.gk-no-warntext .gkn-strip .gkn-wn { display: none !important; }
html.gk-calm .gkh-w.on, html.gk-calm .gkn-strip .gkn-wn.red, html.gk-calm .gkq-time.hot { animation: none !important; }
html.gk-calm .gkx-btn.flash, html.gk-calm .gkx-stick.flash, html.gk-calm .gkx-thr.flash, html.gk-calm .gkx-ped.flash {
  animation: none !important; box-shadow: 0 0 0 2px rgba(92, 242, 200, .55) !important; }
.gk-mute { display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; }
.gk-mute svg { width: 20px; height: 20px; flex: 0 0 auto; }
.gk-mute[aria-pressed="true"] { color: #ffc28f; }
`;

const root = () => (typeof document !== 'undefined' ? document.documentElement : null);
let current = null;

function applyDisplay(st) {
  const r = root();
  if (!r || !st) return;
  const a = st.alerts || {};
  r.classList.toggle('gk-no-warntext', a.hud === false);
  r.classList.toggle('gk-calm', a.reduceFlash === true);
}

/** Warnings blink (false while the player asked for reduced flashing). */
export const reducedFlash = () => { const r = root(); return !!(r && r.classList.contains('gk-calm')); };
/** Warning texts are wanted on screen. */
export const warningTextsOn = () => { const r = root(); return !(r && r.classList.contains('gk-no-warntext')); };

// ---------- telemetry ----------
const bucket = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 4) * 25;
const VOICE_CODE = { all: 2, critical: 1, off: 0 };
let autoQuality = null;
function snapshot(st) {
  const v = st.volumes || {}, a = st.alerts || {};
  if (!st.quality && autoQuality === null) { try { autoQuality = detectQuality(); } catch { autoQuality = 'auto'; } }
  return {
    master: bucket(v.master), engine: bucket(v.engine), voice: bucket(v.voice), atc: bucket(v.atc), ambient: bucket(v.ambient),
    mute: st.muted ? 1 : 0,
    assist: st.assist === false ? 0 : 1,
    valert: VOICE_CODE[a.voice] ?? 2,
    chime: a.chimes === false ? 0 : 1,
    hudwarn: a.hud === false ? 0 : 1,
    calm: a.reduceFlash ? 1 : 0,
    quality: st.quality || autoQuality,
    fps: st.fps == null ? 'auto' : st.fps,
    fail: st.failures || 'off',
    hud: st.hudMode || 'auto',
    tut: st.tutorial === false ? 0 : 1,
    inv: st.invertPitch ? 1 : 0,
    tilt: st.tilt ? 1 : 0,
    radio: st.atc === false ? 0 : 1,
  };
}
let sent = null, timer = 0;
function flush() {
  clearTimeout(timer); timer = 0;
  let next;
  try { next = snapshot(storedSettings()); } catch { return; }
  if (sent) for (const k of Object.keys(next)) if (next[k] !== sent[k]) trackEvent('set', { k, v2: next[k] });
  sent = next;
}

// ---------- mute button ----------
const SPEAKER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke-width="1.6"/>';
const ICON_ON = `${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
const ICON_OFF = `${SPEAKER}<path d="m16 9 6 6"/><path d="m22 9-6 6"/></svg>`;
const buttons = new Set();

function paintButton(b, muted) {
  b.setAttribute('aria-pressed', String(muted));
  const label = muted ? 'Sesi aç' : 'Sesi kapat';
  b.setAttribute('aria-label', label);
  b.title = `${label}${b.dataset.key ? ` (${b.dataset.key})` : ''}`;
  b.innerHTML = muted ? ICON_OFF : ICON_ON;
  if (b.dataset.text) el('span', null, b, muted ? 'Ses kapalı' : 'Ses');
}

/**
 * Speaker button that mutes / unmutes everything (settings.muted; the audio suspends its context). The click is the user
 * gesture iOS needs to start sound. opts: { className (e.g. 'gkh-pbtn' for the pause screen), text: show "Ses" next to
 * the icon, key: shortcut named in the tooltip ('M'), onChange(muted) }. Remove the element to drop it.
 */
export function createMuteButton({ className = '', text = false, key = '', onChange = null } = {}) {
  init();
  const b = el('button', `gk-mute ${className}`.trim());
  b.type = 'button';
  if (text) b.dataset.text = '1';
  if (key) b.dataset.key = key;
  paintButton(b, !!(current && current.muted));
  b.addEventListener('click', () => {
    const muted = !(current && current.muted);
    patchSettings({ muted });
    if (onChange) { try { onChange(muted); } catch (e) { console.error(e); } }
  });
  buttons.add(b);
  return b;
}

// ---------- wiring ----------
let started = false;
function init() {
  if (started || typeof window === 'undefined') return;
  started = true;
  injectCSS('settings-live', CSS);
  try { current = storedSettings(); } catch { current = null; }
  applyDisplay(current);
  try { sent = snapshot(current || storedSettings()); } catch { sent = null; }
  window.addEventListener('gokyuzu:settings', (e) => {
    const st = e.detail;
    if (!st || typeof st !== 'object') return;
    current = st;
    applyDisplay(st);
    for (const b of buttons) { if (!b.isConnected) { buttons.delete(b); continue; } paintButton(b, !!st.muted); }
    clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  });
  window.addEventListener('pagehide', () => { if (timer) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && timer) flush(); });
}
init();
