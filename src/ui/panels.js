// Modal panels shared by the menu and the pause overlay: Ayarlar (settings), Künye (credits / disclaimer),
// the touch-device notice and the one-time "quality can be changed" hint.
// Settings are read / written through src/core/settings.js (saveSettings broadcasts 'gokyuzu:settings';
// main.js applies quality + volumes live, the HUD picks up hudMode).
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp } from './util.js';
import { shared } from './shared.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import { QUALITY, QUALITY_ORDER, detectQuality } from '../core/quality.js';
import { resetTutorials } from './tutorial.js';

export const CREDITS_LINE = 'Harita verisi © OpenStreetMap katkıcıları (ODbL) · Arazi ve hava fotoğrafları: USGS 3DEP, USDA NAIP · Batimetri: NOAA · Bina verisi: DataSF · Three.js (MIT) · B612 font (OFL)';
export const DISCLAIMER = 'Bu ücretsiz, ticari olmayan bir hayran projesidir. Turkish Airlines, Airbus, Boeing, Lockheed Martin, General Dynamics ve Sikorsky ile hiçbir bağlantısı yoktur; isimler ve boyalar yalnızca tanımlayıcı amaçla kullanılmıştır.';

// antialias is fixed when the renderer is created: remember the preset the page started with
const STARTUP_QUALITY = safe(() => loadSettings().quality, 'high');
let detected = null;
function detected_() { if (!detected) detected = safe(() => detectQuality(), 'medium'); return detected; }
function safe(fn, d) { try { return fn(); } catch { return d; } }

const VOLUMES = [
  ['master', 'Genel'],
  ['engine', 'Motor'],
  ['voice', 'Sesli uyarılar'],
  ['atc', 'Telsiz (ATC)'],
  ['ambient', 'Ortam'],
];
const HUD_MODES = [['full', 'Tam'], ['compact', 'Sade'], ['off', 'Kapalı']];

const CSS = `
.gkp { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(2, 6, 12, .58); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  font-family: var(--gk-sans); color: var(--gk-fg); pointer-events: auto; animation: gkp-in .2s ease both;
  -webkit-font-smoothing: antialiased; }
.gkp * { box-sizing: border-box; }
@keyframes gkp-in { from { opacity: 0; } to { opacity: 1; } }
.gkp.gkp-out { animation: gkp-out .16s ease forwards; }
@keyframes gkp-out { to { opacity: 0; } }
.gkp-card { position: relative; width: min(100%, 600px); max-height: calc(100vh - 48px); overflow: auto; border-radius: 20px;
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
.gkp-disc { margin-top: 16px !important; padding: 12px 14px; border-radius: 12px; background: rgba(255, 176, 32, .08); border: 1px solid rgba(255, 176, 32, .22); font-size: 13px !important; color: rgba(255, 232, 200, .92) !important; }
/* device notice */
.gkp-dev { position: fixed; inset: 0; z-index: 70; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px 24px;
  text-align: center; font-family: var(--gk-sans); color: var(--gk-fg); pointer-events: auto;
  background: radial-gradient(ellipse 80% 60% at 50% 40%, #16233d, #070d18 70%, #04070d); }
.gkp-dev svg { width: 86px; height: 86px; opacity: .9; }
.gkp-dev h1 { margin: 0; font-family: var(--gk-display); font-size: 30px; font-weight: 800; letter-spacing: -.02em;
  background: linear-gradient(180deg, #fff 30%, #ffd9bf); -webkit-background-clip: text; background-clip: text; color: transparent; }
.gkp-dev h2 { margin: 0; font-size: 19px; font-weight: 700; }
.gkp-dev p { margin: 0; max-width: 440px; font-size: 15px; line-height: 1.55; color: rgba(226, 236, 250, .82); }
.gkp-dev button { margin-top: 8px; padding: 11px 18px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, .2); background: rgba(255, 255, 255, .06);
  color: rgba(236, 244, 255, .8); font: 600 14px var(--gk-sans); }
.gkp-dev small { max-width: 440px; font-size: 11px; line-height: 1.5; color: rgba(208, 222, 240, .45); }
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

/** Ayarlar panel. Resolves when closed. */
export function openSettings(container) {
  const m = modal(container, 'Ayarlar', 'Değişiklikler hemen uygulanır ve bu tarayıcıda saklanır.');
  let s = loadSettings();
  const commit = () => { s = saveSettings({ ...s, volumes: { ...s.volumes } }); };

  // graphics
  const g = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', g, 'Grafik kalitesi');
  const auto = detected_();
  const items = QUALITY_ORDER.filter((id) => QUALITY[id]).map((id) => [id, QUALITY[id].label || id, id === auto ? 'Otomatik' : '']);
  let note = null;
  const updateNote = () => {
    const now = QUALITY[s.quality], start = QUALITY[STARTUP_QUALITY];
    const aaChange = now && start && !!now.antialias !== !!start.antialias;
    note.textContent = `Bu bilgisayar için önerilen: ${QUALITY[auto] ? QUALITY[auto].label : auto}. Kenar yumuşatma değişikliği yeniden başlatınca geçerli.`;
    note.classList.toggle('hot', aaChange);
  };
  const qs = segmented(g, items, s.quality, (id) => { s.quality = id; commit(); updateNote(); }, 'Grafik kalitesi');
  note = el('div', 'gkp-note', g, '');
  updateNote();

  // audio
  const a = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', a, 'Ses');
  const sliders = {};
  for (const [key, label] of VOLUMES) {
    if (!(key in (DEFAULT_SETTINGS.volumes || {})) && !(key in s.volumes)) continue;
    const row = el('div', 'gkp-row', a);
    const id = `gkp-vol-${key}`;
    const lab = el('label', null, row, label);
    lab.htmlFor = id;
    const r = el('input', null, row);
    r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '1'; r.id = id;
    const out = el('output', null, row, '');
    const show = () => { out.textContent = `${r.value}%`; };
    r.value = String(Math.round(clamp(Number(s.volumes[key] ?? 1), 0, 1) * 100));
    show();
    r.addEventListener('input', () => { s.volumes[key] = Number(r.value) / 100; show(); commit(); });
    sliders[key] = { r, show };
  }

  // controls
  const c = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', c, 'Kontroller');
  const inv = toggle(c, 'Burun kontrolünü ters çevir', 'Yukarı ok / W burnu kaldırır', s.invertPitch, (v) => { s.invertPitch = v; commit(); });
  const atc = 'atc' in s ? toggle(c, 'Otomatik ATC telsizi', 'Kule ve yaklaşma anonsları', s.atc, (v) => { s.atc = v; commit(); }) : null;
  // onboarding (src/ui/tutorial.js): first-flight tutorial per aircraft category, opening key card, contextual hints
  const tut = toggle(c, 'Eğitim ve ipuçları', 'İlk uçuşta adım adım eğitim, tuş kartı ve durumsal ipuçları', s.tutorial !== false, (v) => { s.tutorial = v; commit(); });
  const tutNote = el('div', 'gkp-note', c);
  const tutReset = el('button', 'gkp-link', tutNote, 'Tamamlanan eğitimleri sıfırla');
  tutReset.type = 'button';
  tutReset.addEventListener('click', () => { resetTutorials(); tutReset.textContent = 'Sıfırlandı: her uçak türünün eğitimi bir sonraki uçuşta yeniden başlar.'; tutReset.disabled = true; });

  // HUD
  const h = el('div', 'gkp-sec', m.card);
  el('div', 'gkp-h', h, 'Göstergeler');
  const hud = segmented(h, HUD_MODES, s.hudMode || 'compact', (id) => { s.hudMode = id; commit(); }, 'Göstergeler');
  el('div', 'gkp-note', h, 'Oyunda H tuşu Tam → Sade → Kapalı arasında geçiş yapar.');

  // footer
  const f = el('div', 'gkp-foot', m.card);
  const reset = el('button', 'gkp-btn', f, 'Varsayılanlara dön');
  reset.type = 'button';
  const okb = el('button', 'gkp-btn primary', f, 'Tamam');
  okb.type = 'button';
  okb.addEventListener('click', m.close);
  reset.addEventListener('click', () => {
    s = { ...s, quality: auto, volumes: { ...DEFAULT_SETTINGS.volumes }, invertPitch: DEFAULT_SETTINGS.invertPitch, atc: DEFAULT_SETTINGS.atc, tutorial: DEFAULT_SETTINGS.tutorial, hudMode: null };
    commit();
    qs.set(s.quality); updateNote();
    for (const [key, { r, show }] of Object.entries(sliders)) { r.value = String(Math.round((s.volumes[key] ?? 1) * 100)); show(); }
    inv.set(s.invertPitch); if (atc) atc.set(s.atc); tut.set(s.tutorial !== false); hud.set('compact');
  });
  return m.done;
}

/** Künye (credits + disclaimer). Resolves when closed. */
export function openCredits(container) {
  const m = modal(container, 'Künye', 'Gökyüzü SF · San Francisco Körfezi uçuş simülatörü');
  const box = el('div', 'gkp-credits', m.card);
  const ul = el('ul', null, box);
  const rows = [
    ['Harita verisi', '© OpenStreetMap katkıcıları (ODbL)'],
    ['Arazi ve hava fotoğrafları', 'USGS 3DEP, USDA NAIP'],
    ['Batimetri', 'NOAA'],
    ['Bina verisi', 'DataSF'],
    ['Yazılım', 'Three.js (MIT)'],
    ['Yazı tipi', 'B612 font (OFL)'],
    ['Sesli uyarılar', 'ElevenLabs ile üretildi'],
    ['Otopilot ayırma sesleri', 'FlightGear A320-family (legoboyvdlp, Octal450 ve katkıda bulunanlar) ve Boeing 737-800YV (YV3399 ve katkıda bulunanlar) projelerinden türetilmiştir · GNU GPL-2.0'],
  ];
  for (const [k, v] of rows) { const li = el('li', null, ul); el('b', null, li, k); el('span', null, li, v); }
  el('p', 'gkp-disc', box, DISCLAIMER);
  // CONTRACTS-SF.md §11 (src/core/telemetry.js)
  el('p', 'gkp-disc', box, 'Gizlilik: Oyunu geliştirmek için anonim kullanım istatistikleri toplanır (seçilen uçak, oynama süresi, kare hızı, hatalar, kalkış / iniş / kaza sayıları ve eğitim adımlarının süresi). Çerez kullanılmaz, kişisel bilgi toplanmaz, sunucu kayıtları 30 gün sonra silinir. Tarayıcında “Do Not Track” veya “Global Privacy Control” açıksa istatistik gönderilmez.');
  const f = el('div', 'gkp-foot', m.card);
  el('span', null, f, 'Ücretsiz · ticari olmayan hayran projesi');
  const okb = el('button', 'gkp-btn primary', f, 'Kapat');
  okb.type = 'button';
  okb.addEventListener('click', m.close);
  return m.done;
}

// ---------- device notice (touch-only / phone) ----------
export function isTouchOnly() {
  try {
    const mm = (q) => window.matchMedia && window.matchMedia(q).matches;
    const coarse = mm('(pointer: coarse)');
    const anyFine = mm('(any-pointer: fine)');
    const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    return touch && coarse && !anyFine;
  } catch { return false; }
}

/** Full-screen friendly note on touch-only devices (once per session). Resolves when dismissed (or immediately). */
export function deviceNotice(container) {
  if (!isTouchOnly() || safe(() => sessionStorage.getItem('gokyuzu.deviceOk'), null)) return Promise.resolve();
  inject();
  return new Promise((resolve) => {
    const root = el('div', 'gkp-dev', container || document.body);
    root.setAttribute('lang', 'tr');
    root.setAttribute('role', 'dialog');
    root.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="#ff9a6a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/><path d="M7 8h2M11 8h2M15 8h2M7 11h10" stroke="#5cf2c8"/></svg>');
    el('h1', null, root, 'Gökyüzü');
    el('h2', null, root, 'Bu oyun bir bilgisayar gerektirir');
    el('p', null, root, 'San Francisco Körfezi uçuş simülatörü klavye (veya oyun kolu) ile oynanır ve güçlü bir ekran kartı ister. Lütfen bir masaüstü ya da dizüstü bilgisayardan aç — seni orada bekliyoruz!');
    const b = el('button', null, root, 'Yine de devam et');
    b.type = 'button';
    el('small', null, root, DISCLAIMER);
    b.addEventListener('click', () => {
      safe(() => sessionStorage.setItem('gokyuzu.deviceOk', '1'), null);
      root.remove();
      resolve();
    });
  });
}

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
