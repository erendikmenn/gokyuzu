// Modal panels shared by the menu and the pause overlay: Ayarlar (settings), Künye (credits / disclaimer) and the
// one-time "quality can be changed" hint. (Phones and tablets: the start gate src/ui/touch-gate.js replaced the old
// touch-only notice; Ayarlar shows the tilt-steering switch in touch mode.)
// Settings are read / written through src/core/settings.js (saveSettings broadcasts 'gokyuzu:settings'; main.js applies
// quality + volumes + fps live, the audio muted + alerts, the HUD hudMode, src/ui/settings-live.js the warning display
// classes and the `set` telemetry).
//
// Ayarlar sections: Grafik kalitesi · Kare hızı · Ses (Sesi kapat, Genel ses, Motor, Uyarılar, Telsiz, Ortam) · Uyarılar
// (Sesli uyarılar Hepsi / Sadece kritik / Kapalı, Uyarı sesleri (çan), Ekrandaki uyarı yazıları, Yanıp sönme efektlerini
// azalt) · Kontroller (Destekli uçuş, …) · Göstergeler · sections added by other modules. A speaker button next to × mutes
// everything (= M key).
//
// Hook for other modules: add a section without editing this file
//   const off = registerSettingsSection(id, render, { order = 100 } = {})
//     render(sec, ui) runs each time Ayarlar opens; `sec` is an empty section box (after the built-in sections, sorted
//     by order, then by registration). ui = {
//       settings        the panel's current settings object (read it; change it only through update)
//       update(patch)   merge { key: value } (nested volumes / alerts key by key), save, broadcast; returns the settings
//       heading(text)   section title · note(text, hot?) grey explanation line · label(text) small row title
//       toggle(label, hint, value, onChange(v)) → { set(v) }   switch row
//       segmented(items [[id, label, badge?]…], value, onPick(id), ariaLabel) → { set(id) }
//       choice(label, hint, items, value, onPick(id)) → { set(id) }   title + hint left, segmented control right
//       touch           the on-screen controls are in use (phone / tablet wording)
//     }
//     It may return a function (called when the panel closes) or { refresh(settings), close() }: refresh runs after
//     "Varsayılanlara dön" (which never resets keys of registered sections) and after a change made elsewhere.
//     Same id again replaces the section; off() removes it. A throwing render is logged and skipped.
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp } from './util.js';
import { shared } from './shared.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import { QUALITY, QUALITY_ORDER, detectQuality } from '../core/quality.js';
import { resetTutorials } from './tutorial.js';
import { isTouchOnly, touchMode, inAppBrowser, mobileOS } from './touch-env.js';
import { requestTiltSetting } from './touch.js';
import { createMuteButton } from './settings-live.js';   // (also: warning display classes, settings telemetry)

export { isTouchOnly };

// The public source repository (NOTICE, README.md): the only place the game names it.
export const SOURCE_REPO = 'github.com/erendikmenn/gokyuzu';
export const CREDITS_LINE = 'Harita verisi © OpenStreetMap katkıcıları (ODbL) · Arazi ve hava fotoğrafları: USGS 3DEP, USDA NAIP · Batimetri: NOAA · Bina ve ağaç verisi: DataSF · Three.js (MIT) · B612 font (OFL)';
export const DISCLAIMER = 'Bu ücretsiz ve resmî olmayan bir hayran projesidir. Airbus, Boeing, Lockheed Martin, General Dynamics, Sikorsky, Turkish Airlines, Turkish Technic, Star Alliance ile oyunda görünen bina ve şirket adları sahiplerinin ticari markalarıdır; yalnızca neyin gösterildiğini belirtmek için kullanılmıştır. Bu kuruluşların hiçbiri projeyle bağlantılı değildir ve projeyi desteklemez. ABD Hava Kuvvetleri ve ABD Kara Kuvvetleri işaretleri, gösterildikleri yerde yalnızca gerçekçilik içindir; ABD Savunma Bakanlığı (DoD) görsellerinin yer alması DoD onayı anlamına gelmez.';

// antialias is fixed when the renderer is created: remember the preset the page started with
const STARTUP_QUALITY = safe(() => loadSettings().quality, 'high');
let detected = null;
function detected_() { if (!detected) detected = safe(() => detectQuality(), 'medium'); return detected; }
function safe(fn, d) { try { return fn(); } catch { return d; } }

// volume sliders (settings.volumes, src/audio/index.js categories): master · engines and rotors · spoken alerts and
// alert tones · ATC radio · wind, gear, wheels, switches
const VOLUMES = [
  ['master', 'Genel ses'],
  ['engine', 'Motor'],
  ['voice', 'Uyarılar'],
  ['atc', 'Telsiz (ATC)'],
  ['ambient', 'Ortam'],
];
// spoken alerts (settings.alerts.voice, src/audio/alert-prefs.js)
const VOICE_MODES = [['all', 'Hepsi'], ['critical', 'Sadece kritik'], ['off', 'Kapalı']];
const VOICE_NOTES = {
  all: 'İrtifa anonsları, MINIMUMS, RETARD, BANK ANGLE, SINK RATE, PULL UP, STALL: hepsi duyulur.',
  critical: 'Yalnız hayati uyarılar: PULL UP / TERRAIN, SINK RATE, STALL, SPEED, motor ve yangın. İrtifa anonsları, MINIMUMS, RETARD ve BANK ANGLE susar.',
  off: 'Hiçbir sesli uyarı duyulmaz. Uyarı çanları ve ekrandaki yazılar ayrı ayarlanır.',
};
const ON_OFF = [['on', 'Açık'], ['off', 'Kapalı']];

// sections added by other modules (registerSettingsSection)
const extraSections = new Map();
let extraSeq = 0;
/** Add a section to Ayarlar (see the header of this file). Returns a function that removes it. */
export function registerSettingsSection(id, render, { order = 100 } = {}) {
  if (!id || typeof render !== 'function') return () => {};
  const key = String(id);
  const prev = extraSections.get(key);
  const entry = { render, order: Number.isFinite(order) ? order : 100, seq: prev ? prev.seq : extraSeq++ };
  extraSections.set(key, entry);
  return () => { if (extraSections.get(key) === entry) extraSections.delete(key); };
}
const HUD_MODES = [['full', 'Tam'], ['compact', 'Sade'], ['off', 'Kapalı']];
// frame rate cap in flight (settings.fps, src/app/frame-pacing.js): null = auto | 30 | 60 | 0 = no limit
const FPS_MODES = [['auto', 'Otomatik'], ['30', '30', 'Pil dostu'], ['60', '60'], ['0', 'Sınırsız']];
const fpsId = (v) => (v === 30 || v === 60 || v === 0 ? String(v) : 'auto');
const fpsValue = (id) => (id === 'auto' ? null : Number(id));
// random failures in free flight (src/flight/failures.js RANDOM_RATES)
const FAILURE_MODES = [['off', 'Kapalı'], ['rare', 'Nadir'], ['realistic', 'Gerçekçi']];

const CSS = `
.gkp { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(2, 6, 12, .58); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  font-family: var(--gk-sans); color: var(--gk-fg); pointer-events: auto; animation: gkp-in .2s ease both;
  -webkit-font-smoothing: antialiased; }
.gkp * { box-sizing: border-box; }
@keyframes gkp-in { from { opacity: 0; } to { opacity: 1; } }
.gkp.gkp-out { animation: gkp-out .16s ease forwards; }
@keyframes gkp-out { to { opacity: 0; } }
.gkp-card { position: relative; width: min(100%, 600px); max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); overflow: auto; border-radius: 20px;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain; touch-action: pan-y;
  padding: 24px 26px 20px; background: linear-gradient(180deg, rgba(16, 26, 42, .94), rgba(6, 11, 20, .95));
  border: 1px solid rgba(255, 255, 255, .12); box-shadow: 0 30px 80px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
  animation: gkp-card .28s cubic-bezier(.2, .9, .3, 1.1) both; scrollbar-width: thin; }
@keyframes gkp-card { from { transform: translateY(10px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }
.gkp-card h2 { margin: 0; font-size: 22px; font-weight: 750; letter-spacing: -.01em; }
.gkp-sub { margin: 4px 0 0; font-size: 13px; color: var(--gk-dim); }
.gkp-x { position: absolute; top: 16px; right: 16px; width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .06); color: var(--gk-fg); font-size: 18px; line-height: 1; cursor: pointer; }
.gkp-x:hover { background: rgba(255, 255, 255, .12); }
.gkp-sec { margin-top: 20px; }
.gkp-h { font-size: 11px; font-weight: 750; letter-spacing: .18em; text-transform: uppercase; color: var(--gk-teal); margin-bottom: 10px; }
.gkp-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; padding: 4px; border-radius: 12px; background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .08); }
.gkp-seg button { position: relative; padding: 10px 6px 9px; border-radius: 9px; border: 0; background: transparent; color: rgba(236, 244, 255, .8);
  font: 650 14px var(--gk-sans); cursor: pointer; transition: background .15s, color .15s; }
.gkp-seg button:hover { background: rgba(255, 255, 255, .07); }
.gkp-seg button[aria-checked="true"] { background: linear-gradient(135deg, #ff5d33, #ff9a4a); color: #1c0e06; box-shadow: 0 6px 18px rgba(255, 96, 50, .3); }
.gkp-seg button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.gkp-auto { display: block; margin-top: 2px; font-size: 9.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--gk-teal); }
.gkp-seg button[aria-checked="true"] .gkp-auto { color: #3a1606; }
.gkp-note { margin-top: 8px; font-size: 12px; line-height: 1.45; color: var(--gk-dim); }
.gkp-note.hot { color: #ffc28f; }
.gkp-row { display: grid; grid-template-columns: 130px 1fr 44px; align-items: center; gap: 12px; padding: 6px 0; font-size: 14px; }
.gkp-row label { color: rgba(236, 244, 255, .9); }
.gkp-row output { text-align: right; font: 600 13px var(--gk-mono); color: var(--gk-dim); }
.gkp-row input[type="range"] { width: 100%; accent-color: #ff7a45; height: 22px; cursor: pointer; }
.gkp-tog { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 9px 0; font-size: 14px; cursor: pointer; }
.gkp-tog small { display: block; margin-top: 2px; font-size: 12px; color: var(--gk-dim); }
.gkp-sw { position: relative; flex: 0 0 auto; width: 44px; height: 26px; border-radius: 13px; background: rgba(255, 255, 255, .14); border: 0; cursor: pointer; transition: background .15s; }
.gkp-sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform .18s cubic-bezier(.2, .9, .3, 1.2); }
.gkp-sw[aria-checked="true"] { background: #ff7a45; }
.gkp-sw[aria-checked="true"]::after { transform: translateX(18px); }
.gkp-sw:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gkp-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 22px; padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, .08);
  font-size: 12px; color: var(--gk-dim); }
.gkp-btn { padding: 9px 16px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .07); color: var(--gk-fg);
  font: 650 13.5px var(--gk-sans); cursor: pointer; }
.gkp-btn:hover { background: rgba(255, 255, 255, .13); }
.gkp-btn.primary { background: var(--gk-teal); border-color: var(--gk-teal); color: #04140f; }
.gkp-link { margin: 0; padding: 0; border: 0; background: none; cursor: pointer; font: 600 12px var(--gk-sans); color: var(--gk-dim);
  text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(208, 222, 240, .3); }
.gkp-link:hover { color: var(--gk-fg); }
.gkp-link:disabled { cursor: default; text-decoration: none; color: var(--gk-teal); }
.gkp-credits p { margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(236, 244, 255, .88); text-wrap: pretty; }
.gkp-credits ul { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 7px; }
.gkp-credits li { display: grid; grid-template-columns: 150px 1fr; gap: 12px; font-size: 13.5px; line-height: 1.4; }
.gkp-credits li b { color: var(--gk-dim); font-weight: 650; }
.gkp-credits li a { color: inherit; overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(208, 222, 240, .35); }
.gkp-credits li a:hover { color: #fff; text-decoration-color: rgba(208, 222, 240, .7); }
.gkp-credits li a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 3px; }
.gkp-card.gkp-snd-card h2, .gkp-card.gkp-snd-card .gkp-sub { padding-right: 90px; }
.gkp-snd { position: absolute; top: 16px; right: 58px; width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .06); color: var(--gk-fg); padding: 0; }
.gkp-snd:hover { background: rgba(255, 255, 255, .12); }
.gkp-snd[aria-pressed="true"] { border-color: rgba(255, 194, 143, .5); background: rgba(255, 122, 69, .14); }
.gkp-snd:focus-visible, .gkp-x:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gkp-vols { transition: opacity .15s; }
.gkp-vols.muted { opacity: .45; }
.gkp-row.gkp-main label { font-weight: 700; }
.gkp-lab { padding: 9px 0 7px; font-size: 14px; }
.gkp-choice { display: grid; grid-template-columns: 1fr minmax(150px, 200px); align-items: center; gap: 14px; padding: 8px 0; font-size: 14px; }
.gkp-choice small { display: block; margin-top: 2px; font-size: 12px; color: var(--gk-dim); }
.gkp-disc { margin-top: 16px !important; padding: 12px 14px; border-radius: 12px; background: rgba(255, 176, 32, .08); border: 1px solid rgba(255, 176, 32, .22); font-size: 13px !important; color: rgba(255, 232, 200, .92) !important; }
/* touch devices (phones: small screens, finger-sized targets) */
@media (max-height: 520px), (max-width: 560px) {
  .gkp { padding: max(8px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); }
  .gkp-card { max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); padding: 16px 16px 14px; border-radius: 16px; }
  .gkp-card h2 { font-size: 19px; }
  .gkp-sec { margin-top: 14px; }
}
html.gk-touch .gkp-x { width: 42px; height: 42px; top: 10px; right: 10px; }
html.gk-touch .gkp-seg button { min-height: 44px; }
html.gk-touch .gkp-row input[type="range"] { height: 32px; }
html.gk-touch .gkp-row { grid-template-columns: 110px 1fr 44px; }
html.gk-touch .gkp-tog { min-height: 48px; }
html.gk-touch .gkp-btn { min-height: 44px; padding: 10px 16px; }
html.gk-touch .gkp-snd { width: 42px; height: 42px; top: 10px; right: 60px; }
html.gk-touch .gkp-snd svg { width: 22px; height: 22px; }
@media (max-width: 420px) { .gkp-choice { grid-template-columns: 1fr; gap: 8px; } }
/* one-time hint */
.gkp-hint { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 55; display: flex; align-items: center; gap: 14px;
  max-width: min(92vw, 640px); padding: 12px 14px 12px 18px; border-radius: 14px; font-family: var(--gk-sans); color: var(--gk-fg); font-size: 14px; line-height: 1.4;
  background: rgba(8, 14, 26, .9); border: 1px solid rgba(92, 242, 200, .35); box-shadow: 0 16px 40px rgba(0, 0, 0, .4); pointer-events: auto;
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); animation: gkp-card .35s cubic-bezier(.2, .9, .3, 1.1) both; }
.gkp-hint b { color: var(--gk-teal); }
.gkp-hint .gkp-btns { display: flex; gap: 8px; flex: 0 0 auto; }
`;

function inject() { injectCSS('base', BASE_CSS); injectCSS('panels', CSS); }

// Key capture while a modal is open: Esc closes, nothing reaches the game input (default actions such as slider
// arrows / button activation still work because stopPropagation does not cancel them).
function modalKeys(onEsc) {
  const h = (e) => {
    e.stopPropagation();
    if (e.type === 'keydown' && (e.code === 'Escape' || e.key === 'Escape')) { e.preventDefault(); onEsc(); }
  };
  window.addEventListener('keydown', h, true);
  window.addEventListener('keyup', h, true);
  return () => { window.removeEventListener('keydown', h, true); window.removeEventListener('keyup', h, true); };
}

function modal(container, title, sub) {
  inject();
  const root = el('div', 'gkp', container || document.body);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', title);
  root.setAttribute('lang', 'tr');
  const card = el('div', 'gkp-card', root);
  el('h2', null, card, title);
  if (sub) el('p', 'gkp-sub', card, sub);
  const x = el('button', 'gkp-x', card, '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Kapat');
  let resolveFn, closed = false;
  const done = new Promise((r) => { resolveFn = r; });
  const prevFocus = document.activeElement;
  shared.modalOpen = (shared.modalOpen || 0) + 1;
  const close = () => {
    if (closed) return;
    closed = true;
    unkeys();
    shared.modalOpen = Math.max(0, (shared.modalOpen || 1) - 1);
    root.classList.add('gkp-out');
    setTimeout(() => root.remove(), 170);
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    resolveFn();
  };
  const unkeys = modalKeys(close);
  x.addEventListener('click', close);
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  requestAnimationFrame(() => { if (!closed) x.focus({ preventScroll: true }); });
  return { root, card, close, done };
}

function segmented(parent, items, value, onPick, labelledBy) {
  const seg = el('div', 'gkp-seg', parent);
  seg.setAttribute('role', 'radiogroup');
  if (labelledBy) seg.setAttribute('aria-label', labelledBy);
  const btns = items.map(([id, label, extra]) => {
    const b = el('button', null, seg, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    if (extra) el('span', 'gkp-auto', b, extra);
    b.addEventListener('click', () => { set(id); onPick(id); });
    return [id, b];
  });
  function set(id) { for (const [k, b] of btns) b.setAttribute('aria-checked', String(k === id)); }
  set(value);
  return { set };
}

function toggle(parent, label, hint, value, onChange) {
  const row = el('label', 'gkp-tog', parent);
  const t = el('span', null, row, label);
  if (hint) el('small', null, t, hint);
  const sw = el('button', 'gkp-sw', row);
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', label);
  let v = !!value;
  const set = (nv) => { v = !!nv; sw.setAttribute('aria-checked', String(v)); };
  set(v);
  row.addEventListener('click', (e) => { e.preventDefault(); set(!v); onChange(v); });
  return { set };
}

/** Title + hint on the left, a small segmented control on the right (stacked on narrow phones). */
function choice(parent, label, hint, items, value, onPick) {
  const row = el('div', 'gkp-choice', parent);
  const t = el('span', null, row, label);
  if (hint) el('small', null, t, hint);
  return segmented(row, items, value, onPick, label);
}

/** Ayarlar panel. Resolves when closed. */
export function openSettings(container) {
  const m = modal(container, 'Ayarlar', 'Değişiklikler hemen uygulanır ve bu tarayıcıda saklanır.');
  let s = loadSettings();
  let saving = false;
  const commit = () => {
    saving = true;
    try { s = saveSettings({ ...s, volumes: { ...s.volumes }, alerts: { ...s.alerts } }); } finally { saving = false; }
  };
  const refreshers = [];            // re-read `s` into the controls ("Varsayılanlara dön", a change made elsewhere)
  const refreshAll = () => { for (const fn of refreshers) { try { fn(s); } catch (e) { console.error(e); } } };
  const touch = touchMode();

  // header: speaker button next to × (the same switch as "Sesi kapat" and the M key)
  m.card.classList.add('gkp-snd-card');
  const snd = createMuteButton({ className: 'gkp-snd', key: touch ? '' : 'M' });
  m.card.insertBefore(snd, m.card.querySelector('.gkp-x'));

  // graphics
  const g = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', g, 'Grafik kalitesi');
  const auto = detected_();
  const items = QUALITY_ORDER.filter((id) => QUALITY[id]).map((id) => [id, QUALITY[id].label || id, id === auto ? 'Otomatik' : '']);
  let note = null;
  const updateNote = () => {
    const now = QUALITY[s.quality], start = QUALITY[STARTUP_QUALITY];
    const aaChange = now && start && !!now.antialias !== !!start.antialias;
    note.textContent = `Bu ${touch ? 'cihaz' : 'bilgisayar'} için önerilen: ${QUALITY[auto] ? QUALITY[auto].label : auto}. Kenar yumuşatma değişikliği yeniden başlatınca geçerli.`;
    note.classList.toggle('hot', aaChange);
  };
  const qs = segmented(g, items, s.quality, (id) => { s.quality = id; commit(); updateNote(); }, 'Grafik kalitesi');
  note = el('div', 'gkp-note', g, '');
  updateNote();
  refreshers.push(() => { qs.set(s.quality); updateNote(); });

  // frame rate (applies live: main.js hands it to the frame pacer)
  const fr = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', fr, 'Kare hızı');
  const fps = segmented(fr, FPS_MODES, fpsId(s.fps), (id) => { s.fps = fpsValue(id); commit(); }, 'Kare hızı');
  el('div', 'gkp-note', fr, touch
    ? 'Otomatik: telefonda 30 FPS, tablette 60 (tutturamazsa 30). 30 FPS cihazı daha az ısıtır ve pili daha uzun götürür.'
    : 'Otomatik: ekranın yenileme hızı. 30 ya da 60 seçmek dizüstünde pili uzatır.');
  refreshers.push(() => fps.set(fpsId(s.fps)));

  // sound: "Sesi kapat" keeps the levels (the audio suspends its context); moving a slider while muted turns sound on
  const a = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', a, 'Ses');
  const muteHint = touch ? 'Bütün sesler susar, seviyeler korunur. Hızlı erişim: sağ üstteki hoparlör.' : 'Bütün sesler susar, seviyeler korunur. Oyunda M tuşu.';
  const vols = el('div', 'gkp-vols');
  const muteSw = toggle(a, 'Sesi kapat', muteHint, s.muted, (v) => { s.muted = v; commit(); vols.classList.toggle('muted', v); });
  a.appendChild(vols);
  vols.classList.toggle('muted', !!s.muted);
  const sliders = {};
  for (const [key, label] of VOLUMES) {
    if (!(key in (DEFAULT_SETTINGS.volumes || {})) && !(key in s.volumes)) continue;
    const row = el('div', key === 'master' ? 'gkp-row gkp-main' : 'gkp-row', vols);
    const id = `gkp-vol-${key}`;
    const lab = el('label', null, row, label);
    lab.htmlFor = id;
    const r = el('input', null, row);
    r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1'; r.id = id;
    const out = el('output', null, row, '');
    out.htmlFor = id;
    const show = () => { out.textContent = `%${r.value}`; r.setAttribute('aria-valuetext', `%${r.value}`); };   // (Turkish: %50)
    const read = () => { r.value = String(Math.round(clamp(Number(s.volumes[key] ?? 1), 0, 1) * 100)); show(); };
    read();
    r.addEventListener('input', () => {
      s.volumes[key] = Number(r.value) / 100; show();
      if (s.muted) { s.muted = false; muteSw.set(false); vols.classList.remove('muted'); }
      commit();
    });
    sliders[key] = { read };
  }
  if (mobileOS() === 'ios') el('div', 'gkp-note', a, 'iPhone ve iPad’de sessiz mod açıkken (yan tuş ya da Denetim Merkezi) oyunun sesi duyulmaz.');
  refreshers.push(() => { muteSw.set(!!s.muted); vols.classList.toggle('muted', !!s.muted); for (const k in sliders) sliders[k].read(); });

  // warnings: spoken alerts, alert tones, on-screen texts, flashing (src/audio/alert-prefs.js, src/ui/settings-live.js)
  const w = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', w, 'Uyarılar');
  el('div', 'gkp-lab', w, 'Sesli uyarılar');
  let voiceNote = null;
  const voice = segmented(w, VOICE_MODES, s.alerts.voice, (id) => { s.alerts.voice = id; commit(); voiceNote.textContent = VOICE_NOTES[id]; }, 'Sesli uyarılar');
  voiceNote = el('div', 'gkp-note', w, VOICE_NOTES[s.alerts.voice] || VOICE_NOTES.all);
  const chimes = toggle(w, 'Uyarı sesleri (çan)', 'Uyarı çanları ve kornalar: master caution / warning, iniş takımı kornası, stall titreşimi, hız aşımı, otopilot ayrılma', s.alerts.chimes, (v) => { s.alerts.chimes = v; commit(); });
  const texts = toggle(w, 'Ekrandaki uyarı yazıları', 'PULL UP, STALL, OVERSPEED gibi yazılar (kokpit ekranları değişmez)', s.alerts.hud, (v) => { s.alerts.hud = v; commit(); });
  const calm = toggle(w, 'Yanıp sönme efektlerini azalt', 'Uyarılar ve vurgular yanıp sönmez, sabit yanar', s.alerts.reduceFlash, (v) => { s.alerts.reduceFlash = v; commit(); });
  refreshers.push(() => {
    voice.set(s.alerts.voice); voiceNote.textContent = VOICE_NOTES[s.alerts.voice] || VOICE_NOTES.all;
    chimes.set(s.alerts.chimes); texts.set(s.alerts.hud); calm.set(s.alerts.reduceFlash);
  });

  // controls
  const c = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', c, 'Kontroller');
  // assisted flight (src/flight assist module reads settings.assist): stays off once the player turns it off
  const assist = choice(c, 'Destekli uçuş', 'Yeni başlayanlar için kalkış, uçuş ve inişte yardım (varsayılan: açık)', ON_OFF, s.assist === false ? 'off' : 'on',
    (id) => { s.assist = id === 'on'; commit(); });
  const inv = toggle(c, 'Burun kontrolünü ters çevir', touch ? 'Çubuğu ileri itmek burnu kaldırır' : 'Yukarı ok / W burnu kaldırır', s.invertPitch, (v) => { s.invertPitch = v; commit(); });
  const atc = 'atc' in s ? toggle(c, 'Otomatik ATC telsizi', 'Kule ve yaklaşma anonsları', s.atc, (v) => { s.atc = v; commit(); }) : null;
  // onboarding (src/ui/tutorial.js): first-flight tutorial per aircraft category, opening key card, contextual hints
  const tut = toggle(c, 'Eğitim ve ipuçları', 'İlk uçuşta adım adım eğitim, tuş kartı ve durumsal ipuçları', s.tutorial !== false, (v) => { s.tutorial = v; commit(); });
  // touch hook (src/ui/touch.js, touch-tilt.js): tilt steering; iOS asks for the motion-sensor permission inside this tap
  let tiltSw = null;
  if (touch) {
    const tiltNote = el('div', 'gkp-note', null, '');
    tiltSw = toggle(c, 'Eğimle kumanda', 'Telefonu direksiyon gibi çevir: yatış; üst kenarı öne / arkaya eğ: burun. Çubuk da çalışmaya devam eder.', !!s.tilt, (v) => {
      if (!v) { s.tilt = false; commit(); requestTiltSetting(false); tiltNote.textContent = ''; return; }
      requestTiltSetting(true).then((r) => {
        if (r === 'granted') { s.tilt = true; commit(); tiltNote.classList.remove('hot'); tiltNote.textContent = 'Açık: telefonu rahat tuttuğun açı ortadır. Ekrandaki «ORTALA» düğmesi yeniden ayarlar.'; return; }
        tiltSw.set(false); s.tilt = false; commit();
        tiltNote.classList.add('hot');
        const iab = inAppBrowser();
        tiltNote.textContent = r === 'unsupported' ? 'Bu cihazda hareket sensörü yok.'
          : iab ? `${iab.name} içindeki tarayıcı hareket sensörüne izin vermiyor: menüden «Tarayıcıda aç» ile ${iab.os === 'ios' ? 'Safari' : 'Chrome'}’de dene.`
            : 'Hareket sensörü izni verilmedi. İzin için sayfayı yenileyip tekrar dene.';
      });
    });
    c.appendChild(tiltNote);
  }
  // failures hook: random failures in free flight (never during the tutorial or the first 60 s; missions have their own)
  el('div', 'gkp-lab', c, 'Rastgele arızalar');
  const fails = segmented(c, FAILURE_MODES, s.failures || 'off', (id) => { s.failures = id; commit(); }, 'Rastgele arızalar');
  el('div', 'gkp-note', c, 'Serbest uçuşta motor, yangın, hidrolik ve iniş takımı arızaları. Nadir: ortalama 30 dakikada bir. Gerçekçi: daha seyrek, çoğu kalkışta ve yaklaşmada. Acil durum tuşu: I (dokunmatik: ACİL).');
  const tutNote = el('div', 'gkp-note', c);
  const tutReset = el('button', 'gkp-link', tutNote, 'Tamamlanan eğitimleri sıfırla');
  tutReset.type = 'button';
  tutReset.addEventListener('click', () => { resetTutorials(); tutReset.textContent = 'Sıfırlandı: her uçak türünün eğitimi bir sonraki uçuşta yeniden başlar.'; tutReset.disabled = true; });
  refreshers.push(() => {
    assist.set(s.assist === false ? 'off' : 'on'); inv.set(s.invertPitch); if (atc) atc.set(s.atc); tut.set(s.tutorial !== false);
    fails.set(s.failures || 'off'); if (tiltSw) tiltSw.set(!!s.tilt);
  });

  // HUD
  const h = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', h, 'Göstergeler');
  const hud = segmented(h, HUD_MODES, s.hudMode || 'compact', (id) => { s.hudMode = id; commit(); }, 'Göstergeler');
  el('div', 'gkp-note', h, touch ? 'Telefonda «Sade» önerilir: göstergeler kumandaların arasına sığar.' : 'Oyunda H tuşu Tam → Sade → Kapalı arasında geçiş yapar.');
  refreshers.push(() => hud.set(s.hudMode || 'compact'));

  // sections of other modules (registerSettingsSection)
  const cleanups = [];
  const ui = {
    get settings() { return s; },
    update(patch) {
      if (!patch || typeof patch !== 'object') return s;
      const next = { ...s, ...patch };
      for (const k of ['volumes', 'alerts']) if (patch[k] && typeof patch[k] === 'object') next[k] = { ...s[k], ...patch[k] };
      s = next;
      commit();
      return s;
    },
    touch,
  };
  const extras = [...extraSections.entries()].sort((x, y) => x[1].order - y[1].order || x[1].seq - y[1].seq);
  for (const [id, { render }] of extras) {
    const sec = el('div', 'gkp-sec', m.card);
    sec.dataset.section = id;
    const api = {
      ...ui,
      get settings() { return s; },
      heading: (text) => el('div', 'gkp-h', sec, text),
      note: (text, hot) => el('div', hot ? 'gkp-note hot' : 'gkp-note', sec, text),
      label: (text) => el('div', 'gkp-lab', sec, text),
      toggle: (label, hint, value, onChange) => toggle(sec, label, hint, value, onChange),
      segmented: (list, value, onPick, ariaLabel) => segmented(sec, list, value, onPick, ariaLabel),
      choice: (label, hint, list, value, onPick) => choice(sec, label, hint, list, value, onPick),
    };
    try {
      const ret = render(sec, api);
      if (typeof ret === 'function') cleanups.push(ret);
      else if (ret && typeof ret === 'object') {
        if (typeof ret.close === 'function') cleanups.push(() => ret.close());
        if (typeof ret.refresh === 'function') refreshers.push((st) => ret.refresh(st));
      }
    } catch (e) {
      console.error(`[settings] section ${id}`, e);
      sec.remove();
    }
  }

  // footer
  const f = el('div', 'gkp-foot', m.card);
  const reset = el('button', 'gkp-btn', f, 'Varsayılanlara dön');
  reset.type = 'button';
  const okb = el('button', 'gkp-btn primary', f, 'Tamam');
  okb.type = 'button';
  okb.addEventListener('click', m.close);
  reset.addEventListener('click', () => {
    // (assist is not reset: once turned off it comes back only through its own switch; registered sections keep theirs)
    const D = DEFAULT_SETTINGS;
    s = { ...s, quality: auto, volumes: { ...D.volumes }, muted: D.muted, alerts: { ...D.alerts }, invertPitch: D.invertPitch, atc: D.atc,
      tutorial: D.tutorial, hudMode: null, failures: D.failures, fps: D.fps };
    if (tiltSw && s.tilt) { s.tilt = false; requestTiltSetting(false); }
    commit();
    refreshAll();
  });

  // a change made elsewhere while the panel is open (the speaker button, another module): show it
  const onOutside = (e) => {
    if (saving || !e.detail || typeof e.detail !== 'object') return;
    const d = e.detail;
    s = { ...s, ...d, volumes: { ...s.volumes, ...(d.volumes || {}) }, alerts: { ...s.alerts, ...(d.alerts || {}) } };
    refreshAll();
  };
  window.addEventListener('gokyuzu:settings', onOutside);
  m.done.then(() => {
    window.removeEventListener('gokyuzu:settings', onOutside);
    for (const fn of cleanups) { try { fn(); } catch (e) { console.error(e); } }
  });
  return m.done;
}

/** Künye (credits + disclaimer); map: another map's registry entry (src/maps/index.js: title, credits). Resolves when closed. */
export function openCredits(container, map = null) {
  const own = map && map.credits;
  const m = modal(container, 'Künye', own ? `Gökyüzü · ${map.title} uçuş simülatörü` : 'Gökyüzü SF · San Francisco Körfezi uçuş simülatörü');
  const box = el('div', 'gkp-credits', m.card);
  const ul = el('ul', null, box);
  const repo = `https://${SOURCE_REPO}`;
  // [label, text, link (optional: opens in a new tab)]
  const rows = [
    ...(own || [
      ['Harita verisi', '© OpenStreetMap katkıcıları (ODbL)'],
      ['Arazi ve hava fotoğrafları', 'USGS 3DEP, USDA NAIP (kamu malı)'],
      ['Batimetri', 'NOAA NCEI (kamu malı)'],
      ['Bina ve ağaç verisi', 'DataSF (ODC PDDL)'],
    ]),
    ['Havalimanı verisi', 'OurAirports (kamu malı); DHMİ AIP Türkiye. Gerçek uçuşlarda seyrüsefer amacıyla kullanılamaz.'],
    ['Uçak çizimleri', 'Airbus havalimanı planlama belgeleri; F-16 üç görünüş: Marek Cel (CC0); F-22: ABD Hava Kuvvetleri (kamu malı)'],
    ['Yazılım', 'Three.js (MIT) · Draco ve Basis Universal (Apache-2.0) · meshoptimizer, fflate, ktx-parse, zstddec (MIT)'],
    ['Yazı tipi', 'B612 font (OFL)'],
    ['Simgeler', 'Material Icons (Apache-2.0), Feather Icons (MIT)'],
    ['Sesler', 'Motor, rotor, rüzgâr, sistem ve uyarı sesleri projenin kendi ses sentezi betikleriyle üretildi'],
    ['Sesli uyarılar', 'Sesli uyarılar ve bazı ses efektleri ElevenLabs ile üretildi; gerçek bir kişinin sesi klonlanmadı'],
    ['Otopilot ayırma sesleri', 'FlightGear A320-family (legoboyvdlp, Octal450 ve katkıda bulunanlar) ve Boeing 737-800YV (YV3399 ve katkıda bulunanlar) projelerinden türetilmiştir · GNU GPL-2.0 · A320 "cavalry charge" bir kayıt değil, Airbus dalga şemasından yeniden sentezlenmiştir'],
    ['Ses referans kayıtları', 'Yalnız ölçüm için: Sygoletto (Air France A319, CC BY-SA 3.0) ve jan tisler (Adria Airways A319, CC BY 3.0), Wikimedia Commons; ABD Donanması (P-8A, DVIDS) ve ABD Hava Kuvvetleri (F-16), kamu malı'],
    ['Lisans', 'Kod: Apache-2.0 · Görsel/ses paketi: CC BY-NC 4.0 (markasız) · Harita verisi: ODbL · FlightGear sesleri: GPL-2.0'],
    ['Açık kaynak', SOURCE_REPO, repo],
    ['Katkıda bulunanlar', 'Mehmet Eren Dikmen ve GitHub’daki tüm katkıda bulunanlar', `${repo}/graphs/contributors`],
  ];
  for (const [k, v, href] of rows) {
    const li = el('li', null, ul);
    el('b', null, li, k);
    if (!href) { el('span', null, li, v); continue; }
    const a = el('a', null, el('span', null, li), v);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  }
  el('p', 'gkp-disc', box, DISCLAIMER);
  // CONTRACTS-SF.md §11 (src/core/telemetry.js)
  el('p', 'gkp-disc', box, 'Gizlilik: Oyunu geliştirmek için anonim kullanım istatistikleri toplanır (seçilen uçak, oynama süresi, kare hızı, ses ve uyarı gibi ayar tercihleri, hatalar, kalkış / iniş / kaza sayıları ve eğitim adımlarının süresi). Çerez kullanılmaz, kişisel bilgi toplanmaz, sunucu kayıtları 30 gün sonra silinir. Tarayıcında “Do Not Track” veya “Global Privacy Control” açıksa istatistik gönderilmez.');
  const f = el('div', 'gkp-foot', m.card);
  el('span', null, f, 'Ücretsiz · ticari olmayan hayran projesi');
  const okb = el('button', 'gkp-btn primary', f, 'Kapat');
  okb.type = 'button';
  okb.addEventListener('click', m.close);
  return m.done;
}

// ---------- device notice (replaced) ----------
/** Former full-screen "bu oyun bir bilgisayar gerektirir" notice: phones now play with touch controls, and devices that
 * cannot run the game are stopped earlier by the start gate (src/ui/touch-gate.js). Kept as a no-op for old callers. */
export function deviceNotice() { return Promise.resolve(); }

// ---------- one-time hint: quality can be changed ----------
const HINT_KEY = 'gokyuzu.qualityHintSeen';
export function qualityHintSeen() { return !!safe(() => localStorage.getItem(HINT_KEY), null); }
export function markQualityHintSeen() { safe(() => localStorage.setItem(HINT_KEY, '1'), null); }
export function qualityHintText() {
  const q = QUALITY[safe(() => loadSettings().quality, 'high')];
  return `Oyun yavaş çalışırsa grafik kalitesini Ayarlar’dan düşürebilirsin (şu an: ${q ? q.label : 'otomatik'}).`;
}
/** Small callout with "Ayarlar" / "Tamam" buttons, shown once per browser. */
export function showQualityHint(container, onSettings, extraClass = '') {
  if (qualityHintSeen() || isTouchOnly()) return null;
  inject();
  const box = el('div', `gkp-hint ${extraClass}`.trim(), container || document.body);
  box.setAttribute('role', 'status');
  box.setAttribute('lang', 'tr');
  const t = el('span', null, box);
  el('b', null, t, 'İpucu: ');
  t.append(qualityHintText());
  const btns = el('div', 'gkp-btns', box);
  const sb = el('button', 'gkp-btn', btns, 'Ayarlar');
  const ok = el('button', 'gkp-btn primary', btns, 'Tamam');
  sb.type = 'button'; ok.type = 'button';
  const close = () => { markQualityHintSeen(); box.remove(); };
  ok.addEventListener('click', close);
  sb.addEventListener('click', () => { close(); if (onSettings) onSettings(); });
  return { el: box, close };
}
