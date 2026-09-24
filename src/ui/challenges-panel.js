// Free-flight challenges panel ("Görevler", CONTRACTS-SF.md §12.1): a small tab on the right that opens a list of the
// challenges the current aircraft can do (progress, best score and stars, tracking, "Başlat" for emergencies, "Görev
// olarak oyna"), a result view (stars, score breakdown, personal best, top 10 + nickname of src/net/leaderboard.js) and,
// after a crash, the flight's results. Gameplay UI in the HUD's language (glass cards, orange / teal accents); it never
// pauses the flight. Part of the lazily loaded free-flight chunk (src/missions/ff-runtime.js); never built in missions.
//
// Placement: desktop — the tab at the right edge under the camera bar, the open panel beside it, left of the compact
// altitude column (full HUD: at the right edge) and above the systems panel (measured at open, on resize and once a
// second while open). Touch — the tab is a button in the top-right row (src/ui/touch.js --gkx-slot-*), the panel fills
// the free side area between the stick's ring, the altitude column and the buttons next to the lever (--gkx-side-*);
// collapsed by default, a tap outside closes it, and results show first as a compact card at the top centre.
// No backdrop blur (phones): slightly more opaque glass instead.
//
//   const p = createChallengesPanel(hud, { touch, keyLabel, onTrack, onStart, onCancel, onPlay, onBoard, onToggle })
//   p.setEntries(views) · p.render(views) (≤ 10 Hz, only while open or after a change) · p.setCount(done, total, badge)
//   p.open() · p.close() · p.toggle() · p.isOpen · p.showResult(r, o) · p.notify(r, onOpen) · p.pointer(camera, target, label)
import { injectCSS } from './styles.js';
import { el } from './util.js';
import { STAR, injectPartsCSS, starRow, createPointer, showLeaderboard } from './mission-parts.js';
import { AIRCRAFT_SHORT } from '../missions/catalog.js';
import { fmtInt, fmtTime } from '../missions/util.js';

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>';

const CSS = `
.gkf { position: absolute; inset: 0; pointer-events: none; font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums; --fk: 1; }
.gkf-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .9), rgba(6, 11, 20, .88)); border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .32), inset 0 1px 0 rgba(255, 255, 255, .06); }
.gkf.gkf-hide .gkf-tab, .gkf.gkf-hide .gkf-panel, .gkf.gkf-hide .gkf-note { display: none; }

/* tab */
.gkf-tab { position: absolute; right: calc(14px * var(--ps, 1)); top: calc(200px * var(--ps, 1)); display: flex; align-items: center; gap: calc(7px * var(--fk));
  height: calc(34px * var(--fk)); padding: 0 calc(10px * var(--fk)) 0 calc(9px * var(--fk)); border-radius: calc(11px * var(--fk)); pointer-events: auto; cursor: pointer;
  color: var(--gk-fg); font: 750 calc(12px * var(--fk)) var(--gk-sans); letter-spacing: .06em; white-space: nowrap; transition: border-color .15s, background .15s; }
.gkf-tab:hover { border-color: rgba(255, 162, 74, .55); }
.gkf-tab:focus-visible { outline: 2px solid var(--gk-teal); outline-offset: 1px; }
.gkf-tab svg { width: calc(17px * var(--fk)); height: calc(17px * var(--fk)); color: var(--gk-orange-2); flex: 0 0 auto; }
.gkf-tab b { font: 700 calc(11.5px * var(--fk)) var(--gk-mono); color: var(--gk-teal); letter-spacing: 0; }
.gkf-tab kbd { font: 650 calc(10px * var(--fk)) var(--gk-sans); padding: 1px 5px; border-radius: 4px; background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .16); color: var(--gk-dim); letter-spacing: 0; }
.gkf-tab i { position: absolute; right: -3px; top: -3px; width: 9px; height: 9px; border-radius: 50%; background: #ffc94a; box-shadow: 0 0 8px rgba(255, 201, 74, .8); display: none; }
.gkf-tab.badge i { display: block; }
.gkf-tab.run { border-color: rgba(255, 162, 74, .7); }
.gkf.open .gkf-tab { display: none; }

/* panel */
.gkf-panel { position: absolute; right: calc(14px * var(--ps, 1)); top: calc(200px * var(--ps, 1)); width: 300px; max-height: 60vh; box-sizing: border-box;
  display: none; flex-direction: column; border-radius: calc(14px * var(--fk)); pointer-events: auto; overflow: hidden; }
.gkf.open .gkf-panel { display: flex; animation: gkf-in .22s cubic-bezier(.2, .9, .3, 1.1) both; }
@keyframes gkf-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.gkf-head { display: flex; align-items: center; gap: calc(8px * var(--fk)); padding: calc(9px * var(--fk)) calc(8px * var(--fk)) calc(8px * var(--fk)) calc(12px * var(--fk));
  border-bottom: 1px solid rgba(255, 255, 255, .08); flex: 0 0 auto; }
.gkf-head svg { width: calc(16px * var(--fk)); height: calc(16px * var(--fk)); color: var(--gk-orange-2); flex: 0 0 auto; }
.gkf-head h2 { margin: 0; font-size: calc(11px * var(--fk)); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--gk-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.gkf-head b { font: 700 calc(11.5px * var(--fk)) var(--gk-mono); color: var(--gk-teal); white-space: nowrap; }
.gkf-head kbd { margin-left: auto; font: 650 calc(10px * var(--fk)) var(--gk-sans); padding: 1px 5px; border-radius: 4px; background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .16); color: var(--gk-dim); }
.gkf-x { flex: 0 0 auto; width: calc(28px * var(--fk)); height: calc(28px * var(--fk)); border-radius: 8px; border: 0; padding: 0; margin-left: auto; cursor: pointer;
  background: rgba(255, 255, 255, .08); color: var(--gk-dim); font: 700 calc(14px * var(--fk)) var(--gk-sans); }
.gkf-head kbd + .gkf-x { margin-left: 0; }
.gkf-x:hover { color: var(--gk-fg); background: rgba(255, 255, 255, .14); }
.gkf-body { overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; padding: calc(6px * var(--fk)) calc(8px * var(--fk)) calc(10px * var(--fk)); }
.gkf-intro { margin: calc(2px * var(--fk)) calc(4px * var(--fk)) calc(6px * var(--fk)); font-size: calc(11.5px * var(--fk)); line-height: 1.4; color: var(--gk-dim); }
.gkf-grp { margin: calc(10px * var(--fk)) calc(4px * var(--fk)) calc(4px * var(--fk)); font-size: calc(10px * var(--fk)); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-caution); }

/* entries */
.gkf-item { position: relative; padding: calc(7px * var(--fk)) calc(9px * var(--fk)) calc(7px * var(--fk)) calc(10px * var(--fk)); margin: 2px 0; border-radius: calc(10px * var(--fk)); cursor: pointer;
  border: 1px solid transparent; transition: background .12s, border-color .12s; }
.gkf-item:hover { background: rgba(255, 255, 255, .05); }
.gkf-item.sel { background: rgba(255, 255, 255, .06); border-color: rgba(255, 255, 255, .12); }
.gkf-item.tracked { border-color: rgba(255, 162, 74, .6); background: rgba(255, 162, 74, .08); }
.gkf-i1 { display: flex; align-items: center; gap: calc(7px * var(--fk)); }
.gkf-i1 > i { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: rgba(255, 255, 255, .22); }
.gkf-item.done .gkf-i1 > i { background: var(--gk-teal); box-shadow: 0 0 6px rgba(92, 242, 200, .6); }
.gkf-item.run .gkf-i1 > i, .gkf-item.armed .gkf-i1 > i { background: var(--gk-orange-2); box-shadow: 0 0 8px rgba(255, 162, 74, .8); animation: gkf-pulse 1s ease-in-out infinite; }
@keyframes gkf-pulse { 50% { opacity: .35; } }
.gkf-ti { font-size: calc(13.5px * var(--fk)); font-weight: 700; letter-spacing: -.005em; min-width: 0; flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkf-i1 .gkq-sm { flex: 0 0 auto; display: inline-flex; gap: 1px; }
.gkf-i1 .gkq-sm svg { width: calc(11px * var(--fk)); height: calc(11px * var(--fk)); }
.gkf-i1 .gkq-sm svg.off { fill: rgba(255, 255, 255, .16); }
.gkf-sub { margin-top: 2px; padding-left: calc(14px * var(--fk)); font: 550 calc(11.5px * var(--fk)) var(--gk-sans); color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkf-item.run .gkf-sub, .gkf-item.armed .gkf-sub, .gkf-item.tracked .gkf-sub { color: #ffd2a8; font-family: var(--gk-mono); font-weight: 650; }
.gkf-sub.warn { color: rgba(255, 196, 120, .85); }
.gkf-more { display: none; margin-top: calc(6px * var(--fk)); padding-left: calc(14px * var(--fk)); }
.gkf-item.sel .gkf-more { display: block; }
.gkf-more p { margin: 0 0 calc(7px * var(--fk)); font-size: calc(12px * var(--fk)); line-height: 1.4; color: rgba(226, 236, 250, .82); text-wrap: pretty; }
.gkf-acts { display: flex; flex-wrap: wrap; gap: calc(6px * var(--fk)); align-items: center; }
.gkf .gkq-btn { min-height: calc(32px * var(--fk)); padding: calc(5px * var(--fk)) calc(12px * var(--fk)); border-radius: calc(9px * var(--fk)); font-size: calc(12.5px * var(--fk)); }
.gkf-link { border: 0; background: none; padding: calc(6px * var(--fk)) calc(4px * var(--fk)); cursor: pointer; color: var(--gk-dim); font: 650 calc(12px * var(--fk)) var(--gk-sans);
  text-decoration: underline; text-underline-offset: 3px; text-decoration-color: rgba(208, 222, 240, .35); }
.gkf-link:hover { color: var(--gk-fg); }
.gkf-link.play { color: var(--gk-orange-2); text-decoration-color: rgba(255, 162, 74, .45); }

/* result view */
.gkf-back { border: 0; background: none; padding: calc(4px * var(--fk)) calc(4px * var(--fk)); cursor: pointer; color: var(--gk-dim); font: 700 calc(12px * var(--fk)) var(--gk-sans); }
.gkf-back:hover { color: var(--gk-fg); }
.gkf-res { padding: calc(2px * var(--fk)) calc(4px * var(--fk)) 0; }
.gkf-kick { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-top: calc(4px * var(--fk)); font-size: calc(10.5px * var(--fk)); font-weight: 750; letter-spacing: .14em;
  text-transform: uppercase; color: var(--gk-dim); }
.gkf-res > h3 { margin: calc(3px * var(--fk)) 0 calc(6px * var(--fk)); font-size: calc(18px * var(--fk)); line-height: 1.15; font-weight: 800; letter-spacing: -.015em; }
.gkf-rh { display: flex; align-items: center; gap: calc(12px * var(--fk)); }
.gkf .gkq-big svg { width: calc(26px * var(--fk)); height: calc(26px * var(--fk)); }
.gkf .gkq-score { font-size: calc(22px * var(--fk)); }
.gkf .gkq-score small { font-size: calc(11px * var(--fk)); }
.gkf-reason { margin-top: calc(6px * var(--fk)); font-size: calc(13px * var(--fk)); font-weight: 650; color: #ffb4b4; }
.gkf-rows { margin-top: calc(8px * var(--fk)); }
.gkf .gkq-row { padding: 3px 0; font-size: calc(12px * var(--fk)); gap: 8px; }
.gkf .gkq-row span { white-space: normal; }
.gkf .gkq-row em { font-size: calc(11px * var(--fk)); }
.gkf .gkq-row b { font-size: calc(11.5px * var(--fk)); min-width: 40px; }
.gkf-best { margin-top: calc(6px * var(--fk)); font-size: calc(12px * var(--fk)); color: var(--gk-dim); }
.gkf-sess { margin-top: calc(8px * var(--fk)); padding: calc(6px * var(--fk)) calc(8px * var(--fk)); border-radius: 9px; background: rgba(255, 255, 255, .04); }
.gkf-sess h4 { margin: 0 0 3px; font-size: calc(10px * var(--fk)); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--gk-dim); }
.gkf-sess div { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: calc(12px * var(--fk)); }
.gkf-sess div span { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkf-sess div b { font: 700 calc(11.5px * var(--fk)) var(--gk-mono); color: var(--gk-teal); white-space: nowrap; }
.gkf-sess div b.bad { color: #ffb4b4; font-family: var(--gk-sans); font-weight: 650; }
.gkf .gkq-lb { margin-top: calc(10px * var(--fk)); }
.gkf .gkq-lb ol { columns: 1; }
.gkf .gkq-lb li { font-size: calc(12px * var(--fk)); }
.gkf .gkq-lb input { height: calc(34px * var(--fk)); font-size: 14px; }
.gkf-res .gkf-acts { margin-top: calc(10px * var(--fk)); }

/* compact result card (touch: top centre, below the top buttons / landing card) */
.gkf-note { position: absolute; left: 50%; top: calc(var(--gkx-top, 60px) + var(--gkm-strip-h, 0px)); transform: translate(-50%, -6px); width: min(300px, var(--gkx-top-w, 300px));
  box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 12px; border-radius: 13px; pointer-events: auto; cursor: pointer;
  opacity: 0; visibility: hidden; transition: opacity .3s ease, transform .3s ease, visibility 0s linear .3s; }
.gkf-note.on { opacity: 1; visibility: visible; transform: translate(-50%, 0); transition: opacity .2s ease, transform .3s cubic-bezier(.2, .9, .3, 1.2); }
.gkf-note .gkq-sm { display: inline-flex; gap: 1px; } .gkf-note .gkq-sm svg { width: 15px; height: 15px; } .gkf-note .gkq-sm svg.off { fill: rgba(255, 255, 255, .18); }
.gkf-note div { min-width: 0; flex: 1 1 auto; }
.gkf-note b { display: block; font-size: 13.5px; font-weight: 750; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkf-note small { display: block; font: 650 11.5px var(--gk-mono); color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkf-note em { font-style: normal; flex: 0 0 auto; font-size: 12px; font-weight: 750; color: var(--gk-teal); padding: 6px 10px; border-radius: 9px; border: 1px solid rgba(92, 242, 200, .45); background: rgba(92, 242, 200, .08); }
.gkf-note.bad b { color: #ffb4b4; }

/* touch: the tab is a button of the top-right row (src/ui/touch.js) */
html.gk-touch .gkf-tab { right: auto; left: var(--gkx-slot-l, auto); top: var(--gkx-slot-t, 8px); width: var(--gkx-slot-s, 50px); height: var(--gkx-slot-s, 50px);
  padding: 0; flex-direction: column; justify-content: center; gap: 2px; border-radius: 14px; font-size: 9.5px; letter-spacing: .06em; }
html.gk-touch .gkf-tab svg { width: 19px; height: 19px; }
html.gk-touch .gkf-tab b { font-size: 10px; }
html.gk-touch .gkf-tab kbd { display: none; }
html.gk-touch .gkf-head kbd { display: none; }
html.gk-touch .gkf-x { width: 34px; height: 34px; }
html.gk-touch .gkf-item { padding-top: 8px; padding-bottom: 8px; }
html.gk-touch .gkf-ti { white-space: normal; line-height: 1.2; font-size: 13px; }
html.gk-touch .gkf-intro { font-size: 11px; }
`;

export function createChallengesPanel(hud, o = {}) {
  const touch = !!o.touch;
  injectPartsCSS();
  injectCSS('challenges-panel', CSS);
  const root = el('div', 'gkf');
  root.setAttribute('lang', 'tr');
  if (hud && hud.mountLayer) hud.mountLayer(root); else document.body.appendChild(root);
  const ptr = createPointer(root, { touch });   // (first: the tab, the panel and the card paint over it)

  // ---- tab ----
  const tab = el('button', 'gkf-tab gkf-glass', root);
  tab.type = 'button';
  tab.innerHTML = ICON;
  el('span', null, tab, touch ? 'GÖREV' : 'Görevler');
  const tabCnt = el('b', null, tab, '');
  if (!touch && o.keyLabel) el('kbd', null, tab, o.keyLabel);
  el('i', null, tab);
  tab.title = touch ? 'Serbest uçuş görevleri' : `Serbest uçuş görevleri (${o.keyLabel || 'Enter'})`;
  tab.setAttribute('aria-expanded', 'false');

  // ---- panel ----
  const panel = el('div', 'gkf-panel gkf-glass', root);
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Serbest uçuş görevleri');
  const head = el('div', 'gkf-head', panel);
  head.insertAdjacentHTML('beforeend', ICON);
  el('h2', null, head, 'Görevler');
  const headCnt = el('b', null, head, '');
  if (!touch && o.keyLabel) el('kbd', null, head, o.keyLabel);
  const xBtn = el('button', 'gkf-x', head, '✕');
  xBtn.type = 'button'; xBtn.title = 'Kapat';
  const body = el('div', 'gkf-body', panel);
  const listView = el('div', null, body);
  const resView = el('div', 'gkf-res', body);
  resView.style.display = 'none';

  // ---- compact result card (touch) + pointer ----
  const note = el('div', 'gkf-note gkf-glass', root);
  note.setAttribute('role', 'status');
  let noteT = null, noteOpen = null;

  let isOpen = false, view = 'list', rows = new Map(), selected = null, fresh = false, unseen = null, nextSrc = null;
  const fk = () => {
    if (touch) return 1;
    const ps = parseFloat(getComputedStyle(root).getPropertyValue('--ps')) || 1;
    return Math.min(1.15, Math.max(0.86, ps / 0.82));
  };

  // ---- placement ----
  const px = (v) => `${Math.round(v)}px`;
  function place() {
    const W = innerWidth, H = innerHeight;
    if (touch) {
      const cs = getComputedStyle(document.documentElement);
      const v = (k) => parseFloat(cs.getPropertyValue(k));
      let x0 = v('--gkx-side-x0'), x1 = v('--gkx-side-x1'), y0 = v('--gkx-side-y0'), y1 = v('--gkx-side-y1');
      if (!(x1 > x0 + 150)) { x1 = W - 130; x0 = Math.max(W * 0.45, x1 - 300); y0 = 66; y1 = H - 10; }
      Object.assign(panel.style, { left: px(x0), right: 'auto', top: px(y0), width: px(x1 - x0), maxHeight: px(Math.max(160, y1 - y0)) });
      return;
    }
    const k = fk();
    root.style.setProperty('--fk', k.toFixed(3));
    const tr = tab.getBoundingClientRect();
    const top = tr.height > 0 ? tr.top : parseFloat(getComputedStyle(tab).top) || 150;
    const edge = W - (tr.width > 0 ? tr.right : W - 14);
    // the altitude column: at the right edge (compact HUD) → beside it; in the middle (full HUD) → right of it
    const tape = document.querySelectorAll('.gkh-layer .gkh-tape')[1];
    const r = tape && !tape.closest('.gkh-off') ? tape.getBoundingClientRect() : null;
    let right = edge, width = Math.round(300 * k);
    if (r && r.width > 0 && r.bottom > top) {
      if (W - r.right < 60) right = W - r.left + 10;
      else { const space = W - edge - r.right - 10; width = Math.round(Math.max(Math.min(width, space), 230 * k)); }
    }
    // above the systems panel (bottom right) when they share columns
    let bottom = H - 14;
    const sys = document.querySelector('.gkh-sys');
    const sr = sys ? sys.getBoundingClientRect() : null;
    if (sr && sr.width > 0 && sr.left < W - right && sr.right > W - right - width) bottom = sr.top - 10;
    Object.assign(panel.style, { right: px(right), left: 'auto', top: px(top), width: px(width), maxHeight: px(Math.max(180, bottom - top)) });
  }
  addEventListener('resize', () => { if (isOpen) place(); });
  let placeT = 0;

  // src: how it opened — 'key' (Enter), 'tab' (the tab / GÖREV button), 'card' (the compact result card), 'auto' (a
  // result or a crash opened it)
  function setOpen(on, byUser = false, src = 'auto') {
    if (on === isOpen) return;
    // opened by the player (tab, Enter): a result announced by the compact card and not opened yet, else the list
    // (unless a result arrived that has not been seen yet)
    if (on && byUser && unseen) { const fn = unseen; unseen = null; hideNote(); nextSrc = src; fn(); nextSrc = null; return; }
    if (on && byUser && view === 'result' && !fresh) showList();
    if (!on) fresh = false;
    isOpen = on;
    root.classList.toggle('open', on);
    tab.setAttribute('aria-expanded', String(on));
    if (on) { place(); if (touch) hideNote(); }
    if (o.onToggle) o.onToggle(on, nextSrc || src);
  }
  const close = () => setOpen(false);
  tab.addEventListener('click', (e) => { e.stopPropagation(); tab.blur(); setOpen(!isOpen, true, 'tab'); });
  xBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  // keep the keyboard for flying: buttons never keep the focus
  root.addEventListener('pointerup', () => { const a = document.activeElement; if (a && root.contains(a) && a.tagName !== 'INPUT') a.blur(); });
  // touch: a tap outside closes the panel (the tap still does what it does: stick, lever, camera)
  if (touch) {
    document.addEventListener('pointerdown', (e) => {
      if (!isOpen || panel.contains(e.target) || tab.contains(e.target)) return;
      close();
    }, true);
  }
  // Enter toggles the panel (free flight only; not while typing, not with modifiers)
  if (o.keyCode) {
    addEventListener('keydown', (e) => {
      if (!o.keyCode.includes(e.code) || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName || ''))) return;
      if (o.canToggle && !o.canToggle()) return;
      e.preventDefault();
      setOpen(!isOpen, true, 'key');
    });
  }

  // ---- list ----
  function setEntries(views) {
    listView.textContent = '';
    rows = new Map();
    el('p', 'gkf-intro', listView, touch ? 'Uçarken kendiliğinden algılanır. Takip için bir göreve dokun.'
      : 'Uçarken kendiliğinden algılanır. Takip için bir göreve tıkla: hedef ekranda işaretlenir.');
    let grp = null;
    for (const v of views) {
      if (v.group === 'emergency' && grp !== 'emergency') { grp = 'emergency'; el('div', 'gkf-grp', listView, 'Acil durumlar'); }
      const item = el('div', 'gkf-item', listView);
      item.setAttribute('role', 'button');
      item.tabIndex = -1;
      const i1 = el('div', 'gkf-i1', item);
      el('i', null, i1);
      el('span', 'gkf-ti', i1, v.title);
      const stars = starRow(3);
      i1.append(stars);
      const sub = el('div', 'gkf-sub', item, '');
      const more = el('div', 'gkf-more', item);
      el('p', null, more, v.hint);
      const acts = el('div', 'gkf-acts', more);
      let startBtn = null;
      if (v.emergency) {
        startBtn = el('button', 'gkq-btn primary', acts, 'Başlat');
        startBtn.type = 'button';
        startBtn.addEventListener('click', (e) => { e.stopPropagation(); startBtn.blur(); if (row.running) o.onCancel && o.onCancel(v.id); else o.onStart && o.onStart(v.id); });
      }
      const boardBtn = el('button', 'gkf-link', acts, 'Sıralama');
      boardBtn.type = 'button';
      boardBtn.addEventListener('click', (e) => { e.stopPropagation(); if (o.onBoard) o.onBoard(v.id); });
      const play = el('button', 'gkf-link play', acts, 'Görev olarak oyna ›');
      play.type = 'button';
      play.title = 'Aynı görevi hazır başlangıçla, brifing ve görev sıralamasıyla oyna';
      play.addEventListener('click', (e) => { e.stopPropagation(); if (o.onPlay) o.onPlay(v.id); });
      item.addEventListener('click', () => {
        const was = selected === v.id;
        select(was ? null : v.id);
        if (v.trackable && o.onTrack) o.onTrack(was ? null : v.id);
      });
      const row = { item, sub, stars, startBtn, subTxt: null, cls: '', st: -1, running: false, warn: null, startTxt: null, startDis: null };
      rows.set(v.id, row);
    }
    render(views);
  }
  function select(id) {
    selected = id;
    for (const [k, r] of rows) r.item.classList.toggle('sel', k === id);
  }
  /** Row texts / classes from the runtime's view models (strings compared before any DOM write). */
  function render(views) {
    for (const v of views) {
      const r = rows.get(v.id);
      if (!r) continue;
      const cls = `${v.status}${v.done ? ' done' : ''}${v.tracked ? ' tracked' : ''}`;
      if (cls !== r.cls) {
        r.cls = cls;
        for (const c of ['run', 'armed', 'done', 'tracked']) r.item.classList.toggle(c, cls.split(' ').includes(c));
      }
      if (v.sub !== r.subTxt) { r.subTxt = v.sub; r.sub.textContent = v.sub; }
      if (!!v.subWarn !== r.warn) { r.warn = !!v.subWarn; r.sub.classList.toggle('warn', r.warn); }
      if (v.stars !== r.st) { r.st = v.stars; for (let i = 0; i < 3; i++) r.stars.children[i].classList.toggle('off', i >= v.stars); r.stars.style.visibility = v.stars > 0 ? '' : 'hidden'; }
      if (r.startBtn) {
        r.running = v.status === 'run';
        const txt = r.running ? 'Vazgeç' : 'Başlat';
        if (txt !== r.startTxt) { r.startTxt = txt; r.startBtn.textContent = txt; r.startBtn.classList.toggle('primary', !r.running); }
        const dis = !r.running && !(v.canStart && v.canStart.ok);
        if (dis !== r.startDis) { r.startDis = dis; r.startBtn.disabled = dis; }
      }
      if (v.tracked && selected !== v.id && v.autoSelect) select(v.id);
    }
    if (isOpen && (placeT += 1) >= 10) { placeT = 0; place(); }   // (≈ once a second at the 10 Hz render rate)
  }

  // ---- result view ----
  function showList() { view = 'list'; listView.style.display = ''; resView.style.display = 'none'; }
  function showResultView(r, x = {}) {
    view = 'result';
    listView.style.display = 'none';
    resView.style.display = '';
    resView.textContent = '';
    const back = el('button', 'gkf-back', resView, '‹ Tüm görevler');
    back.type = 'button';
    back.addEventListener('click', (e) => { e.stopPropagation(); showList(); });
    const k = el('div', 'gkf-kick', resView);
    if (x.crash) { el('b', 'gkq-bad', k, 'Kaza'); el('span', null, k, r.ok ? 'son görev: tamamlandı' : 'son görev: başarısız'); }
    else if (r.board && !r.noRun) el('b', r.ok ? 'gkq-ok' : 'gkq-bad', k, r.ok ? 'Tamamlandı' : 'Başarısız');
    else el('b', null, k, 'Sıralama');
    el('span', null, k, AIRCRAFT_SHORT[r.ac] || r.ac || '');
    el('h3', null, resView, r.title);
    if (!r.noRun) {
      const h = el('div', 'gkf-rh', resView);
      const big = el('div', 'gkq-big', h);
      big.innerHTML = STAR.repeat(3);
      for (let i = 0; i < 3; i++) big.children[i].classList.toggle('on', r.ok && i < r.stars);
      const sc = el('div', 'gkq-score', h, r.ok ? fmtInt(r.score) : '—');
      const sm = el('small', null, sc, `puan${r.time != null ? ` · ${fmtTime(r.time)}` : ''}`);
      if (r.ok && x.newBest && x.prevBest > 0) el('span', 'gkq-new', sm, 'Yeni rekor');
      if (!r.ok && r.reason) el('div', 'gkf-reason', resView, r.reason);
      if (r.ok && r.rows && r.rows.length) {
        const rw = el('div', 'gkf-rows', resView);
        for (const [label, value, pts] of r.rows) {
          const row = el('div', 'gkq-row', rw);
          el('span', null, row, label); el('em', null, row, value || ''); el('b', null, row, pts ? `+${fmtInt(pts)}` : '');
        }
      }
    }
    if (x.best && x.best.done && !(r.ok && x.newBest)) {
      const b = el('div', 'gkf-best', resView, `En iyin: ${fmtInt(x.best.best)} puan${x.best.ac ? ` (${AIRCRAFT_SHORT[x.best.ac] || x.best.ac})` : ''} · `);
      b.append(starRow(x.best.stars || 0));
    }
    if (x.session && x.session.length) {
      const s = el('div', 'gkf-sess', resView);
      el('h4', null, s, 'Bu uçuşta');
      for (const it of x.session.slice(-6)) {
        const d = el('div', null, s);
        el('span', null, d, it.title);
        el('b', it.ok ? '' : 'bad', d, it.ok ? `${fmtInt(it.score)} · ${'★'.repeat(it.stars)}` : 'başarısız');
      }
    }
    const lb = el('div', 'gkq-lb', resView);
    const sub = x.submit || null;   // { score, stars, sec, ac } to submit (a finished run, or the personal best)
    showLeaderboard(lb, { board: r.board, day: '', ok: !!sub, score: sub ? sub.score : 0, stars: sub ? sub.stars : 0, sec: sub ? sub.sec : undefined, ac: sub ? sub.ac : r.ac,
      title: 'Sıralama · serbest uçuş', showAc: true, onSubmitted: x.onSubmitted }).catch(() => {});
    const acts = el('div', 'gkf-acts', resView);
    if (x.onPlay) {
      const play = el('button', 'gkf-link play', acts, 'Görev olarak oyna ›');
      play.type = 'button';
      play.addEventListener('click', (e) => { e.stopPropagation(); x.onPlay(); });
    }
    body.scrollTop = 0;
  }

  function hideNote() { note.classList.remove('on'); if (noteT) { clearTimeout(noteT); noteT = null; } }
  note.addEventListener('click', (e) => { e.stopPropagation(); const fn = noteOpen; unseen = null; hideNote(); nextSrc = 'card'; if (fn) fn(); nextSrc = null; });

  return {
    root,
    setEntries,
    render,
    select,
    open() { setOpen(true); },
    close,
    toggle() { setOpen(!isOpen); },
    get isOpen() { return isOpen; },
    get view() { return view; },
    showList,
    setVisible(on) { root.classList.toggle('gkf-hide', !on); },
    setCount(done, total, { badge = false, running = false } = {}) {
      const t = `${done}/${total}${done ? ' ✓' : ''}`;
      if (tabCnt.textContent !== t) { tabCnt.textContent = t; headCnt.textContent = t; }
      tab.classList.toggle('badge', !!badge);
      tab.classList.toggle('run', !!running);
    },
    /** Result view (opens the panel). x = { newBest, prevBest, best, session, crash, submit, onPlay, onSubmitted } */
    showResult(r, x = {}) { showResultView(r, x); fresh = !isOpen; setOpen(true); place(); },
    /** Touch: a compact card at the top centre; a tap opens the result (onOpen). */
    notify(r, onOpen, secs = 9) {
      fresh = false;
      note.textContent = '';
      note.classList.toggle('bad', !r.ok);
      const st = starRow(3);
      for (let i = 0; i < 3; i++) st.children[i].classList.toggle('off', !r.ok || i >= r.stars);
      note.append(st);
      const d = el('div', null, note);
      el('b', null, d, r.ok ? r.title : `${r.title}: başarısız`);
      el('small', null, d, r.ok ? `${fmtInt(r.score)} puan${r.time != null ? ` · ${fmtTime(r.time)}` : ''}` : (r.reason || ''));
      el('em', null, note, 'Sıralama');
      noteOpen = onOpen; unseen = onOpen;
      note.classList.add('on');
      if (noteT) clearTimeout(noteT);
      noteT = setTimeout(hideNote, secs * 1000);
    },
    /** Every frame while tracking: the target pointer (label = distance text, set at 10 Hz). */
    pointer(camera, tg, label) { ptr.update(camera, tg, label); },
    debug() {
      const pr = panel.getBoundingClientRect(), tb = tab.getBoundingClientRect();
      return { open: isOpen, view, selected, tab: tabCnt.textContent, pointer: ptr.state, note: note.classList.contains('on') ? note.textContent : null,
        panelRect: isOpen ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) } : null,
        tabRect: { x: Math.round(tb.left), y: Math.round(tb.top), w: Math.round(tb.width), h: Math.round(tb.height) } };
    },
  };
}
