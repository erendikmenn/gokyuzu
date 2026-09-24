// In-flight mission UI (CONTRACTS-SF.md §12): the mission strip (goal, timer, next gate: arrow + distance + height),
// a screen-space pointer to the current target, the briefing card and the results screen (stars, score breakdown,
// "Tekrar dene", "Sonraki görev", "Paylaş", "Menü", the optional top-10 of src/net/leaderboard.js). Part of the lazily
// loaded mission chunk (src/missions/runtime.js). Plain glass panels like the rest of the HUD; never over the attitude
// / speed area: desktop — the strip under the info panel (top left); touch — the strip at the top centre between the
// speed and altitude columns (the landing card and the tutorial stack move below it via --gkm-strip-h).
//
//   const ui = createMissionUI(hud, { touch, input, category })
//   ui.setMission(m) · ui.setObjective(o, i, n) · ui.update({ t, limit, objective, phase, s }) (10 Hz)
//   ui.pointer(camera, target, s) (every frame; allocation-free) · ui.flash(text, kind)
//   ui.showBrief(m, { start, menu, again, best }) · ui.showResult(result, { retry, next, nextTitle, menu, share }) · ui.hideCard()
import { injectCSS, BASE_CSS } from './styles.js';
import { el, keyChips } from './util.js';
import { essentialKeys } from './tutorial-keys.js';
import { shared } from './shared.js';
import { AIRCRAFT_SHORT, LEVEL_LABEL, MISSIONS } from '../missions/catalog.js';
import { fmtDist, fmtInt, fmtTime, bearing, wrap180, dayLabel, FT } from '../missions/util.js';

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.3l-5.8 3.1 1.2-6.5L2.6 9.4l6.5-.8z"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l6.5 16L12 15.2 5.5 19z"/></svg>';

const CSS = `
.gkq { position: absolute; inset: 0; pointer-events: none; font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
.gkq-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .8), rgba(6, 11, 20, .76)); border: 1px solid rgba(255, 255, 255, .13);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .06); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }

/* strip */
.gkq-strip { position: absolute; left: calc(18px * var(--ps, 1)); top: calc(108px * var(--ps, 1)); width: calc(262px * var(--ps, 1)); box-sizing: border-box;
  padding: calc(8px * var(--ps, 1)) calc(12px * var(--ps, 1)) calc(9px * var(--ps, 1)); border-radius: calc(14px * var(--ps, 1)); display: none; }
.gkq.on .gkq-strip { display: block; }
.gkq-s1 { display: flex; align-items: center; gap: calc(8px * var(--ps, 1)); }
.gkq-tag { font-size: calc(9.5px * var(--ps, 1)); font-weight: 780; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-orange-2); white-space: nowrap; }
.gkq-title { font-size: calc(12px * var(--ps, 1)); font-weight: 650; color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
.gkq-time { margin-left: auto; font: 750 calc(14px * var(--ps, 1)) var(--gk-mono); white-space: nowrap; }
.gkq-time.warn { color: var(--gk-caution); } .gkq-time.hot { color: var(--gk-warn); animation: gkq-blink 1s steps(1, end) infinite; }
@keyframes gkq-blink { 50% { opacity: .45; } }
.gkq-s2 { display: flex; align-items: baseline; gap: calc(8px * var(--ps, 1)); margin-top: calc(4px * var(--ps, 1)); }
.gkq-obj { font-size: calc(15px * var(--ps, 1)); font-weight: 750; letter-spacing: -.01em; line-height: 1.2; min-width: 0; flex: 1 1 auto; }
.gkq-prog { font: 700 calc(12.5px * var(--ps, 1)) var(--gk-mono); color: var(--gk-teal); white-space: nowrap; }
.gkq-s3 { display: none; align-items: center; gap: calc(10px * var(--ps, 1)); margin-top: calc(5px * var(--ps, 1)); font: 650 calc(12.5px * var(--ps, 1)) var(--gk-mono); color: rgba(226, 236, 250, .86); }
.gkq-s3.on { display: flex; }
.gkq-s3 svg { width: calc(18px * var(--ps, 1)); height: calc(18px * var(--ps, 1)); fill: var(--gk-orange-2); flex: 0 0 auto; transition: transform .12s linear; }
.gkq-dv.up { color: #9fe0ff; } .gkq-dv.down { color: #ffd08a; }
.gkq-steps { display: flex; gap: 3px; margin-top: calc(6px * var(--ps, 1)); }
.gkq-steps i { flex: 1 1 0; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .14); }
.gkq-steps i.done { background: var(--gk-teal); } .gkq-steps i.cur { background: rgba(255, 162, 74, .8); }

/* pointer to the target */
.gkq-ptr { position: absolute; left: 0; top: 0; width: 0; height: 0; display: none; will-change: transform; }
.gkq-ptr.on { display: block; }
.gkq-ptr i { position: absolute; left: -9px; top: -9px; width: 14px; height: 14px; border: 2.5px solid #ffa24a; transform: rotate(45deg); border-radius: 3px;
  box-shadow: 0 0 10px rgba(255, 162, 74, .6); }
.gkq-ptr b { position: absolute; left: 50%; top: 13px; transform: translateX(-50%); font: 700 12px var(--gk-mono); white-space: nowrap; color: #ffe2c8;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9), 0 0 6px rgba(0, 0, 0, .6); }
.gkq-ptr svg { display: none; position: absolute; left: -13px; top: -13px; width: 26px; height: 26px; fill: #ffa24a; filter: drop-shadow(0 0 6px rgba(0, 0, 0, .7)); }
.gkq-ptr.edge i { display: none; } .gkq-ptr.edge svg { display: block; }

/* briefing / results */
.gkq-back { position: absolute; inset: 0; z-index: 4; display: none; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
  background: radial-gradient(ellipse at center, rgba(4, 10, 18, .25), rgba(2, 6, 12, .6)); pointer-events: auto; }
.gkq-back.on { display: flex; animation: gkq-fade .25s ease both; }
@keyframes gkq-fade { from { opacity: 0; } to { opacity: 1; } }
.gkq-card { position: relative; width: min(560px, 100%); max-height: 100%; overflow-y: auto; box-sizing: border-box; padding: 20px 24px 18px; border-radius: 18px;
  scrollbar-width: thin; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; animation: gkq-in .35s cubic-bezier(.2, .9, .3, 1.15) both; }
@keyframes gkq-in { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }
.gkq-kick { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 11px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; color: var(--gk-dim); }
.gkq-kick b { color: var(--gk-orange-2); font-weight: 800; }
.gkq-kick b.daily { color: #04140f; background: var(--gk-teal); padding: 2px 7px; border-radius: 5px; letter-spacing: .1em; }
.gkq-card h2 { margin: 6px 0 6px; font-size: 27px; line-height: 1.12; font-weight: 800; letter-spacing: -.02em; }
.gkq-brief { margin: 0; font-size: 14.5px; line-height: 1.5; color: rgba(226, 236, 250, .86); text-wrap: pretty; }
.gkq-goal { margin-top: 10px; padding: 9px 12px; border-radius: 11px; background: rgba(255, 162, 74, .1); border: 1px solid rgba(255, 162, 74, .3);
  font-size: 14px; font-weight: 650; line-height: 1.35; }
.gkq-goal span { display: block; font-size: 10px; font-weight: 800; letter-spacing: .16em; color: var(--gk-orange-2); margin-bottom: 2px; }
.gkq-note { margin-top: 6px; font-size: 12.5px; color: var(--gk-teal); font-weight: 650; }
.gkq-crit { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 12.5px; color: var(--gk-dim); }
.gkq-crit span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.gkq-crit svg, .gkq-sm svg { width: 12px; height: 12px; fill: #ffc94a; }
.gkq-keys { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px 14px; margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(255, 255, 255, .08); }
.gkq-keys div { display: flex; align-items: center; gap: 7px; font-size: 12px; color: rgba(226, 236, 250, .8); min-width: 0; }
.gkq-keys div > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gkq-keys .gk-keys { flex: 0 0 auto; }
.gkq-keys .gk-keys kbd { font-size: 11.5px; padding: 2px 6px; }
.gkq-best { margin-top: 10px; font-size: 12.5px; color: var(--gk-dim); }
.gkq-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.gkq-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 10px 18px; border-radius: 12px; cursor: pointer;
  font: 700 15px var(--gk-sans); color: var(--gk-fg); background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .16); transition: background .15s, transform .15s; }
.gkq-btn:hover { background: rgba(255, 255, 255, .13); }
.gkq-btn:active { transform: scale(.98); }
.gkq-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gkq-btn.primary { background: linear-gradient(135deg, #ff5d33, #ff8a45 60%, #ffb257); color: #1c0e06; border-color: transparent; }
.gkq-btn.primary:hover { filter: brightness(1.06); }
.gkq-btn.teal { color: var(--gk-teal); border-color: rgba(92, 242, 200, .45); background: rgba(92, 242, 200, .08); }
.gkq-btn kbd { font: 700 10.5px var(--gk-sans); padding: 2px 6px; border-radius: 5px; background: rgba(40, 14, 0, .16); border: 1px solid rgba(40, 14, 0, .25); }
.gkq-btn.ghost { margin-left: auto; }
.gkq-res-h { display: flex; align-items: center; gap: 18px; margin-top: 12px; }
.gkq-big { display: flex; gap: 4px; }
.gkq-big svg { width: 38px; height: 38px; fill: rgba(255, 255, 255, .14); }
.gkq-big svg.on { fill: #ffc94a; filter: drop-shadow(0 0 10px rgba(255, 201, 74, .55)); animation: gkq-pop .45s cubic-bezier(.2, .9, .3, 1.5) both; }
.gkq-big svg.on:nth-child(2) { animation-delay: .15s; } .gkq-big svg.on:nth-child(3) { animation-delay: .3s; }
@keyframes gkq-pop { from { transform: scale(.3); opacity: 0; } to { transform: none; opacity: 1; } }
.gkq-score { font: 800 30px var(--gk-mono); letter-spacing: -.03em; line-height: 1; }
.gkq-score small { display: block; margin-top: 4px; font: 650 12px var(--gk-sans); letter-spacing: .04em; color: var(--gk-dim); }
.gkq-ok { color: var(--gk-teal) !important; } .gkq-bad { color: var(--gk-warn) !important; }
.gkq-reason { margin-top: 10px; font-size: 15px; font-weight: 650; color: #ffb4b4; }
.gkq-rows { margin-top: 12px; }
.gkq-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid rgba(255, 255, 255, .06); font-size: 13.5px; }
.gkq-row span { color: rgba(226, 236, 250, .86); white-space: nowrap; } .gkq-row em { font-style: normal; color: var(--gk-dim); font-size: 12.5px; flex: 1 1 auto; text-align: right; }
.gkq-row b { font: 700 13px var(--gk-mono); min-width: 52px; text-align: right; color: var(--gk-teal); }
.gkq-new { display: inline-block; margin-left: 8px; font-size: 10px; font-weight: 800; letter-spacing: .12em; padding: 2px 6px; border-radius: 5px; background: #ffc94a; color: #2a1a00; vertical-align: 3px; }
.gkq-lb { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, .08); display: none; }
.gkq-lb.on { display: block; }
.gkq-lb h3 { margin: 0 0 6px; font-size: 11px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkq-lb ol { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 20px; }
.gkq-lb li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: 12.5px; break-inside: avoid; }
.gkq-lb li i { font-style: normal; font: 700 11px var(--gk-mono); color: var(--gk-faint); min-width: 18px; }
.gkq-lb li span { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkq-lb li b { font: 700 12px var(--gk-mono); }
.gkq-lb li.me span, .gkq-lb li.me b { color: var(--gk-teal); }
.gkq-lb form { display: flex; gap: 8px; margin-top: 8px; }
.gkq-lb input { flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 10px; border-radius: 9px; border: 1px solid rgba(255, 255, 255, .2); background: rgba(0, 0, 0, .25);
  color: var(--gk-fg); font: 600 14px var(--gk-sans); user-select: text; -webkit-user-select: text; }
.gkq-lb .gkq-btn { min-height: 36px; padding: 6px 14px; font-size: 13.5px; }
.gkq-lb small { display: block; margin-top: 5px; font-size: 11.5px; color: var(--gk-dim); }
.gkq-lb small.bad { color: #ffb4b4; }

/* touch */
html.gk-touch .gkq-strip { left: 50%; top: var(--gkx-top, 60px); transform: translateX(-50%); width: min(400px, var(--gkx-top-w, 400px));
  padding: 5px 10px 6px; border-radius: 12px; }
html.gk-touch .gkq-title { display: none; }
html.gk-touch .gkq-s2 { margin-top: 2px; }
html.gk-touch .gkq-obj { font-size: 13.5px; }
html.gk-touch .gkq-s3 { margin-top: 2px; }
html.gk-touch.gk-mis.gkx-phone .gkt-stack { top: calc(var(--gkx-top, 60px) + var(--gkm-strip-h, 0px)) !important; }
html.gk-touch.gk-mis .gkh-toast { translate: 0 var(--gkm-strip-h, 0px); }
html.gk-touch .gkq-keys { grid-template-columns: repeat(2, minmax(0, 1fr)); }
html.gk-mis .gkh-ccard small, html.gk-mis .gkh-ccard > i { display: none; }   /* missions: no automatic restart after a crash */
@media (max-height: 520px) {
  .gkq-back { padding: 8px; }
  .gkq-card { padding: 12px 16px 12px; border-radius: 14px; }
  .gkq-card h2 { font-size: 21px; margin: 3px 0 4px; }
  .gkq-brief { font-size: 13px; line-height: 1.4; }
  .gkq-goal { margin-top: 7px; padding: 6px 10px; font-size: 13px; }
  .gkq-keys { margin-top: 8px; padding-top: 7px; gap: 5px 14px; }
  .gkq-btns { margin-top: 10px; }
  .gkq-btn { min-height: 40px; padding: 8px 14px; font-size: 14px; }
  .gkq-res-h { margin-top: 6px; } .gkq-big svg { width: 30px; height: 30px; } .gkq-score { font-size: 24px; }
  .gkq-rows { margin-top: 6px; } .gkq-row { padding: 3px 0; font-size: 12.5px; }
  .gkq-card.again .gkq-keys, .gkq-card.again .gkq-brief { display: none; }
}
`;

const starRow = (n, cls = 'gkq-sm') => { const s = el('span', cls); s.innerHTML = STAR.repeat(n); return s; };

export function createMissionUI(hud, { touch = false, input = null, category = 'airliner' } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('missions-hud', CSS);
  const root = el('div', 'gkq');
  root.setAttribute('lang', 'tr');
  if (hud && hud.mountLayer) hud.mountLayer(root); else document.body.appendChild(root);
  document.documentElement.classList.add('gk-mis');

  // ---- strip ----
  const strip = el('div', 'gkq-strip gkq-glass', root);
  strip.setAttribute('role', 'status');
  const s1 = el('div', 'gkq-s1', strip);
  const tag = el('span', 'gkq-tag', s1, 'Görev');
  const title = el('span', 'gkq-title', s1, '');
  const time = el('span', 'gkq-time', s1, '0:00');
  const s2 = el('div', 'gkq-s2', strip);
  const objEl = el('span', 'gkq-obj', s2, '');
  const progEl = el('span', 'gkq-prog', s2, '');
  const s3 = el('div', 'gkq-s3', strip);
  const arrowWrap = el('span', null, s3);
  arrowWrap.innerHTML = ARROW;
  const arrow = arrowWrap.firstChild;
  const distEl = el('span', null, s3, '');
  const dvEl = el('span', 'gkq-dv', s3, '');
  const steps = el('div', 'gkq-steps', strip);
  if (hud && hud.element && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      const h = root.classList.contains('on') && touch ? strip.getBoundingClientRect().height + 8 : 0;
      document.documentElement.style.setProperty('--gkm-strip-h', `${Math.round(h)}px`);
    }).observe(strip);
  }

  // ---- pointer ----
  const ptr = el('div', 'gkq-ptr', root);
  el('i', null, ptr);
  ptr.insertAdjacentHTML('beforeend', ARROW);
  const ptrArrow = ptr.lastChild;
  const ptrLbl = el('b', null, ptr, '');
  let W = innerWidth, H = innerHeight, lastX = -1, lastY = -1, lastRot = 999;
  addEventListener('resize', () => { W = root.clientWidth || innerWidth; H = root.clientHeight || innerHeight; lastX = -1; });

  // ---- modal card ----
  const back = el('div', 'gkq-back', root);
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  let card = null, onEnter = null, modal = false;
  function openCard(cls) {
    back.textContent = '';
    card = el('div', `gkq-card gkq-glass ${cls || ''}`, back);
    back.classList.add('on');
    if (!modal) { modal = true; shared.modalOpen = (shared.modalOpen || 0) + 1; }
    return card;
  }
  function hideCard() {
    back.classList.remove('on');
    back.textContent = '';
    card = null; onEnter = null;
    if (modal) { modal = false; shared.modalOpen = Math.max(0, (shared.modalOpen || 1) - 1); }
  }
  // Enter = the card's main button (captured before the game input; Space stays the brake)
  window.addEventListener('keydown', (e) => {
    if (!onEnter || !back.classList.contains('on')) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopPropagation(); const fn = onEnter; fn(); }
  }, true);
  const btn = (parent, label, cls, fn, key) => {
    const b = el('button', `gkq-btn ${cls || ''}`, parent, label);
    b.type = 'button';
    if (key && !touch) el('kbd', null, b, key);
    b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); fn(); });
    return b;
  };
  const device = () => (input && input.gamepadConnected ? 'pad' : touch || (input && input.touchMode) ? 'touch' : 'kb');

  let mission = null, lastObj = null, dist = '', lastTime = '', timeCls = '';
  const setCls = (node, cls, on) => { if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on); };

  function kicker(parent, m) {
    const k = el('div', 'gkq-kick', parent);
    if (m.day) { el('b', 'daily', k, 'Günün görevi'); el('span', null, k, dayLabel(m.day)); }
    else el('b', null, k, `Görev ${MISSIONS.findIndex((x) => x.id === m.id) + 1}/${MISSIONS.length}`);
    el('span', null, k, AIRCRAFT_SHORT[m.aircraft] || m.aircraft);
    el('span', null, k, `~${m.minutes} dk`);
    el('span', null, k, LEVEL_LABEL[m.level] || '');
    return k;
  }
  function criteria(parent, m) {
    const c = el('div', 'gkq-crit', parent);
    if (m.stars === 'landing') { const s = el('span', null, c); s.append(starRow(3)); s.append(' iniş puanın kadar yıldız'); }
    else if (m.stars === 'ditch') { const s = el('span', null, c); s.append(starRow(3)); s.append(' suya iniş kalitesine göre'); }
    else {
      const labels = ['tamamla', `${fmtInt(m.stars[1])} puan`, `${fmtInt(m.stars[2])} puan`];
      for (let i = 0; i < 3; i++) { const s = el('span', null, c); s.append(starRow(i + 1)); s.append(` ${labels[i]}`); }
    }
    if (m.limit) el('span', null, c, `· süre sınırı ${fmtTime(m.limit)}`);
  }

  const api = {
    setMission(m) {
      mission = m;
      title.textContent = m.title;
      tag.textContent = m.day ? 'Günün görevi' : 'Görev';
      root.classList.add('on');
    },
    setObjective(o, i, n) {
      lastObj = null;
      steps.textContent = '';
      for (let k = 0; k < n; k++) el('i', k < i ? 'done' : k === i ? 'cur' : '', steps);
      steps.style.display = n > 1 ? '' : 'none';
      objEl.textContent = o ? o.label : '';
    },
    /** 10 Hz: timer, objective progress, distance / height to the target. */
    update({ s, t, limit, objective: o, phase }) {
      const rem = limit ? limit - t : null;
      const txt = rem != null ? fmtTime(Math.max(0, Math.ceil(rem))) : fmtTime(t);
      if (txt !== lastTime) { lastTime = txt; time.textContent = txt; }
      const cls = phase === 'run' && rem != null ? (rem < 15 ? 'hot' : rem < 40 ? 'warn' : '') : '';
      if (cls !== timeCls) { setCls(time, 'warn', cls === 'warn'); setCls(time, 'hot', cls === 'hot'); timeCls = cls; }
      if (!o) { s3.classList.remove('on'); return; }
      if (o !== lastObj) { lastObj = o; objEl.textContent = o.label; }
      if (progEl.textContent !== o.progress) progEl.textContent = o.progress;
      const tg = o.status === 'active' ? o.target : null;
      setCls(s3, 'on', !!tg);
      if (!tg) return;
      const d = Math.hypot(tg.x - s.x, tg.z - s.z);
      const rel = wrap180(bearing(s.x, s.z, tg.x, tg.z) - s.hdg);
      arrow.style.transform = `rotate(${Math.round(rel)}deg)`;
      dist = fmtDist(d);
      if (distEl.textContent !== dist) distEl.textContent = dist;
      const showDv = o.def.type === 'gates' || o.def.type === 'hover' || o.def.type === 'bridge';
      const dv = (tg.y - s.y) / FT;
      const dvTxt = showDv && Math.abs(dv) >= 40 ? `${dv > 0 ? '▲' : '▼'} ${fmtInt(Math.abs(Math.round(dv / 10) * 10))} ft` : '';
      if (dvEl.textContent !== dvTxt) { dvEl.textContent = dvTxt; setCls(dvEl, 'up', dv > 0); setCls(dvEl, 'down', dv < 0); }
    },
    /** Every frame: screen position of the target (diamond on screen, edge arrow off screen). No allocation. */
    pointer(camera, tg, s) {
      if (!camera || !tg) { if (ptr.classList.contains('on')) ptr.classList.remove('on'); return; }
      const e = camera.matrixWorldInverse.elements;
      const x = tg.x, y = tg.y, z = tg.z;
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const ty = Math.tan((camera.fov * Math.PI) / 360), tx = ty * camera.aspect;
      let nx, ny, edge = false;
      if (vz < -1) { nx = vx / -vz / tx; ny = vy / -vz / ty; }
      else { nx = vx; ny = vy; edge = true; }             // behind: only the direction counts
      const mx = touch ? 0.62 : 0.86, my = touch ? 0.5 : 0.78;
      if (edge || Math.abs(nx) > mx || Math.abs(ny) > my) {
        edge = true;
        const k = Math.min(mx / Math.max(Math.abs(nx), 1e-6), my / Math.max(Math.abs(ny), 1e-6));
        nx *= k; ny *= k;
      }
      const sx = (nx * 0.5 + 0.5) * W, sy = (-ny * 0.5 + 0.5) * H;
      if (Math.abs(sx - lastX) >= 0.5 || Math.abs(sy - lastY) >= 0.5) {   // (no style write, no string, when it did not move)
        lastX = sx; lastY = sy;
        ptr.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      }
      if (edge) {
        const rot = Math.round(Math.atan2(nx, ny) * 180 / Math.PI);
        if (rot !== lastRot) { lastRot = rot; ptrArrow.style.transform = `rotate(${rot}deg)`; }
      }
      setCls(ptr, 'edge', edge);
      if (ptrLbl.textContent !== dist) ptrLbl.textContent = dist;
      if (!ptr.classList.contains('on')) ptr.classList.add('on');
    },
    flash(text, kind = 'info') {
      if (!text || /^kaza/i.test(text)) return;          // the HUD's crash card already says it
      if (hud && hud.showMessage) hud.showMessage(text, kind === 'warn' ? 3200 : 2200);
    },
    hideCard,
    showBrief(m, { start, menu, again = false, best = null }) {
      mission = m;
      const c = openCard(again ? 'again' : '');
      kicker(c, m);
      el('h2', null, c, m.title);
      el('p', 'gkq-brief', c, m.brief);
      const g = el('div', 'gkq-goal', c);
      el('span', null, g, 'Hedef');
      g.append(m.goal);
      if (m.note) el('div', 'gkq-note', c, `Bugünün farkı: ${m.note}`);
      criteria(c, m);
      const keys = el('div', 'gkq-keys', c);
      for (const [k, label] of essentialKeys(category, device())) { const d = el('div', null, keys); keyChips(d, k); el('span', null, d, label); }
      if (best && best.done) {
        const b = el('div', 'gkq-best', c, `En iyin: ${fmtInt(best.best)} puan · `);
        b.append(starRow(best.stars || 0));
      }
      const bs = el('div', 'gkq-btns', c);
      const go = btn(bs, again ? 'Yeniden başla' : 'Başla', 'primary', start, 'Enter');
      btn(bs, 'Menü', 'ghost', menu);
      onEnter = start;
      if (!touch) requestAnimationFrame(() => { try { go.focus({ preventScroll: true }); go.blur(); } catch { /* ignore */ } });
    },
    showResult(r, { retry, next, nextTitle = '', menu, share }) {
      const m = r.mission;
      const c = openCard('result');
      const k = el('div', 'gkq-kick', c);
      el('b', r.ok ? 'gkq-ok' : 'gkq-bad', k, r.ok ? 'Görev tamamlandı' : 'Görev başarısız');
      if (m.day) el('span', null, k, `Günün görevi · ${dayLabel(m.day)}`);
      el('h2', null, c, m.title);
      const h = el('div', 'gkq-res-h', c);
      const big = el('div', 'gkq-big', h);
      big.innerHTML = STAR.repeat(3);
      for (let i = 0; i < 3; i++) setCls(big.children[i], 'on', r.ok && i < r.stars);
      const sc = el('div', 'gkq-score', h, r.ok ? fmtInt(r.score) : '—');
      const sm = el('small', null, sc, `puan · ${fmtTime(r.time)}`);
      if (r.ok && r.newBest && r.prevBest > 0) el('span', 'gkq-new', sm, 'Yeni rekor');
      if (!r.ok) el('div', 'gkq-reason', c, r.reason);
      if (r.ok && r.rows.length) {
        const rows = el('div', 'gkq-rows', c);
        for (const [label, value, pts] of r.rows) {
          const row = el('div', 'gkq-row', rows);
          el('span', null, row, label); el('em', null, row, value || ''); el('b', null, row, pts ? `+${fmtInt(pts)}` : '');
        }
      }
      if (r.ok && !r.newBest && r.prevBest > 0) el('div', 'gkq-best', c, `En iyin: ${fmtInt(r.prevBest)} puan`);
      const bs = el('div', 'gkq-btns', c);
      const primary = r.ok && next ? next : retry;
      btn(bs, 'Tekrar dene', r.ok && next ? '' : 'primary', retry, r.ok && next ? '' : 'Enter');
      if (next) { const b = btn(bs, 'Sonraki görev', r.ok ? 'primary' : '', next, r.ok ? 'Enter' : ''); b.title = nextTitle; }
      const shareBtn = btn(bs, 'Paylaş', 'teal', () => share({ anchor: shareBtn }));
      btn(bs, 'Menü', 'ghost', menu);
      onEnter = primary;
      // leaderboard (src/net/leaderboard.js): shown only when the service answers
      const lb = el('div', 'gkq-lb', c);
      showLeaderboard(lb, r, m).catch(() => {});
    },
    debug() { return { strip: root.classList.contains('on') ? `${objEl.textContent} ${progEl.textContent} ${time.textContent}` : null, card: card ? card.className : null, pointer: ptr.classList.contains('on') ? (ptr.classList.contains('edge') ? 'edge' : 'on') : null, dist }; },
  };

  async function showLeaderboard(lb, r, m) {
    // the local dev server (tools/serve.mjs) has no /api/: no request there (each 404 would be a console error) unless ?lb=1
    if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && new URLSearchParams(location.search).get('lb') !== '1') return;
    let mod;
    try { mod = await import('../net/leaderboard.js'); } catch { return; }
    const day = m.day || '';
    const ac = m.aircraft;
    const render = (top, meRank) => {
      if (!top || !top.entries || !top.entries.length) { lb.classList.toggle('on', r.ok); return; }
      lb.classList.add('on');
      list.textContent = '';
      for (const x of top.entries.slice(0, 10)) {
        const li = el('li', x.rank === meRank ? 'me' : '', list);
        el('i', null, li, String(x.rank));
        el('span', null, li, x.name || 'İsimsiz pilot');
        el('b', null, li, fmtInt(x.score));
      }
    };
    lb.textContent = '';
    el('h3', null, lb, m.day ? 'Günün sıralaması' : 'Sıralama');
    const list = el('ol', null, lb);
    let form = null, note = null;
    if (r.ok) {
      form = el('form', null, lb);
      const input = el('input', null, form);
      input.type = 'text'; input.maxLength = mod.NAME_MAX || 16; input.placeholder = 'Takma ad (isteğe bağlı)'; input.autocomplete = 'off'; input.enterKeyHint = 'send';
      input.value = mod.savedName ? mod.savedName() : '';
      input.addEventListener('keydown', (e) => e.stopPropagation());   // typing never flies the aircraft
      input.addEventListener('keyup', (e) => e.stopPropagation());
      const send = el('button', 'gkq-btn teal', form, 'Skoru gönder');
      send.type = 'submit';
      note = el('small', null, lb, 'İsim yazmazsan "İsimsiz pilot" görünür. Başka bir bilgi gönderilmez.');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        const chk = mod.cleanName ? mod.cleanName(name) : { ok: true };
        if (!chk.ok) { note.textContent = 'Bu takma ad kullanılamıyor: harf, rakam, boşluk, _ ve - (en çok 16).'; note.className = 'bad'; return; }
        send.disabled = true; send.textContent = 'Gönderiliyor…';
        const res = await mod.submitScore({ mission: m.id, day, score: r.score, stars: r.stars, ac, name: chk.name || undefined, sec: Math.round(r.time * 10) / 10 });
        if (!res) { send.disabled = false; send.textContent = 'Tekrar dene'; note.textContent = 'Sıralama şu an ulaşılamıyor.'; note.className = 'bad'; return; }
        form.remove();
        note.className = res.nameRejected ? 'bad' : '';
        note.textContent = res.nameRejected ? 'Takma ad kabul edilmedi: skor isimsiz kaydedildi.' : res.rank ? `Sıran: ${res.rank}${res.improved ? '' : ' (en iyi skorun duruyor)'}` : 'Skor kaydedildi.';
        render(res.top ? { entries: res.top } : null, res.rank);
      });
    }
    const top = await mod.topScores({ mission: m.id, day, n: 10 });
    if (top === null) { lb.classList.remove('on'); return; }   // service unavailable: hide the table
    render(top, null);
    if (!top.entries || !top.entries.length) { el('small', null, list, 'Henüz skor yok: ilk sen ol!'); lb.classList.toggle('on', r.ok); }
  }
  return api;
}
