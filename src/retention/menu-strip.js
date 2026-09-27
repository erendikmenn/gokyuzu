// Main menu: the daily streak ("🔥 3 gün seri") and the next daily mission's countdown ("Yarınki görev 14 sa sonra") under
// the title, and the streak card (a tap on the streak): today's status, the longest streak and the badges (src/retention/
// streak.js) with the title and HUD accent the player picks. Local only (localStorage), phone-friendly (the card is a
// centred sheet over a dim backdrop on narrow screens).
//
//   const strip = mountStreakStrip({ root, brand, sub, touch })   root: the menu (.gkm), sub: the subtitle it follows
//   strip.refresh() · strip.destroy()
import { injectCSS } from '../ui/styles.js';
import { el } from '../ui/util.js';
import { shared } from '../ui/shared.js';
import { istanbulDay, secondsToNextDay } from '../missions/util.js';
import { readStreak, writeStreak, streakView, BADGES, badgeProgress, pickedBadge } from './streak.js';
import { applyAccent } from './activity.js';
import { trackEvent } from '../core/telemetry.js';

const CSS = `
.gkr-strip { display: flex; flex-wrap: wrap; align-items: center; gap: calc(8 * var(--u1)); margin-top: calc(14 * var(--u1)); }
.gkr-pill { display: inline-flex; align-items: center; gap: calc(7 * var(--u1)); padding: calc(5 * var(--u1)) calc(12 * var(--u1)) calc(5 * var(--u1)) calc(9 * var(--u1));
  border-radius: 999px; cursor: pointer; font: 700 calc(13 * var(--u1)) var(--gk-sans); color: var(--gk-fg) !important; white-space: nowrap;
  border: 1px solid rgba(255, 170, 110, .5); background: linear-gradient(120deg, rgba(255, 93, 51, .26), rgba(255, 162, 74, .1)); outline: none;
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); transition: border-color .15s, transform .15s; }
.gkr-pill:hover { border-color: rgba(255, 190, 140, .85); transform: translateY(-1px); }
.gkr-pill:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkr-pill .fl { font-size: calc(15 * var(--u1)); line-height: 1; }
.gkr-pill em { font-style: normal; font-weight: 650; color: var(--gk-dim); }
.gkr-pill i { font-style: normal; font-size: calc(11 * var(--u1)); font-weight: 750; padding: 1px calc(7 * var(--u1)); border-radius: 999px; color: #1b1206;
  background: var(--gkr-badge, #ffc94a); }
.gkr-pill.risk { border-color: rgba(255, 201, 74, .8); }
.gkr-pill.risk em { color: #ffd98a; }
.gkr-pill.zero { border-color: rgba(255, 255, 255, .2); background: rgba(8, 14, 26, .5); }
.gkr-cd { font: 650 calc(12.5 * var(--u1)) var(--gk-sans); color: var(--gk-dim); white-space: nowrap; }
.gkr-cd b { font-weight: 750; color: var(--gk-teal); }
.gkm.gkm-touch .gkr-strip { margin-top: 8px; gap: 6px; }
.gkm.gkm-touch .gkr-pill { font-size: 12.5px; padding: 5px 11px 5px 8px; min-height: 32px; }
.gkm.gkm-touch .gkr-pill .fl { font-size: 14px; }
.gkm.gkm-touch .gkr-pill i { font-size: 10.5px; }
.gkm.gkm-touch .gkr-cd { font-size: 11.5px; }
/* landscape phones: beside the title (the menu's rows have no height to spare) */
@media (max-height: 520px) and (orientation: landscape) {
  .gkm.gkm-touch .gkm-brand { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 14px; align-items: center; }
  .gkm.gkm-touch .gkm-brand h1 { grid-column: 1; grid-row: 1; }
  .gkm.gkm-touch .gkm-brand .gkm-sub { grid-column: 1; grid-row: 2; }
  .gkm.gkm-touch .gkr-strip { grid-column: 2; grid-row: 1 / span 2; margin: 0; flex-direction: column; align-items: flex-start; flex-wrap: nowrap; gap: 3px; min-width: 0; }
  .gkm.gkm-touch .gkr-pill { max-width: 100%; min-height: 30px; overflow: hidden; }
  .gkm.gkm-touch .gkr-pill i { display: none; }
  .gkm.gkm-touch .gkr-cd { font-size: 11px; padding-left: 4px; }
}

/* streak card: opaque like the settings card (src/ui/panels.js), no fade (a transform-only entrance); phones: a centred
   sheet over a dim backdrop that closes it */
.gkr-pop { position: absolute; z-index: 40; width: min(360px, calc(100vw - 24px)); max-height: calc(100% - 24px); overflow-y: auto; box-sizing: border-box;
  padding: 14px 14px 12px; border-radius: 16px; font-family: var(--gk-sans); color: var(--gk-fg); text-align: left; user-select: none; -webkit-user-select: none;
  background: linear-gradient(180deg, #111b2c, #060b15); border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 22px 60px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .06);
  animation: gkr-in .2s cubic-bezier(.2, .8, .2, 1) both; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
@keyframes gkr-in { from { transform: translateY(6px); } to { transform: none; } }
.gkr-pop.sheet { left: 50% !important; top: 50% !important; transform: translate(-50%, -50%); animation: none; }
.gkr-pop-back { position: absolute; inset: 0; z-index: 39; background: rgba(2, 6, 12, .62); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.gkr-h { display: flex; align-items: center; gap: 12px; }
.gkr-big { display: grid; place-items: center; width: 54px; height: 54px; border-radius: 14px; flex: 0 0 auto; font: 800 22px var(--gk-mono);
  background: linear-gradient(135deg, rgba(255, 93, 51, .35), rgba(255, 162, 74, .15)); border: 1px solid rgba(255, 170, 110, .5); }
.gkr-big small { display: block; font: 700 9.5px var(--gk-sans); letter-spacing: .08em; color: #ffd2a8; margin-top: -4px; }
.gkr-h b { display: block; font-size: 17px; font-weight: 800; }
.gkr-h span { display: block; margin-top: 2px; font-size: 12.5px; color: var(--gk-dim); }
.gkr-x { margin-left: auto; align-self: flex-start; width: 32px; height: 32px; border-radius: 9px; border: 0; cursor: pointer; background: rgba(255, 255, 255, .08);
  color: var(--gk-dim) !important; font: 700 14px var(--gk-sans) !important; flex: 0 0 auto; }
.gkr-st { margin: 10px 0 4px; padding: 8px 10px; border-radius: 10px; font-size: 13px; line-height: 1.4; background: rgba(255, 255, 255, .05); }
.gkr-st.ok { background: rgba(92, 242, 200, .1); color: #bff7e6; }
.gkr-st.risk { background: rgba(255, 201, 74, .12); color: #ffe3a6; }
.gkr-sec { margin: 12px 2px 6px; font-size: 10.5px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkr-b { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; margin: 2px 0; border-radius: 10px; border: 1px solid transparent; background: none;
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; }
.gkr-b:hover:not(:disabled) { background: rgba(255, 255, 255, .06); }
.gkr-b:disabled { cursor: default; opacity: .5; }
.gkr-b[aria-checked="true"] { border-color: rgba(255, 162, 74, .7); background: rgba(255, 162, 74, .08); }
.gkr-dot { width: 18px; height: 18px; border-radius: 50%; flex: 0 0 auto; background: var(--c); box-shadow: 0 0 10px var(--c); }
.gkr-b:disabled .gkr-dot { background: transparent; box-shadow: none; border: 2px dashed rgba(255, 255, 255, .3); }
.gkr-b span { flex: 1 1 auto; min-width: 0; }
.gkr-b span b { display: block; font-size: 13.5px; font-weight: 750; }
.gkr-b span small { display: block; font-size: 11.5px; color: var(--gk-dim); }
.gkr-b em { font-style: normal; font: 700 11.5px var(--gk-mono); color: var(--gk-dim); white-space: nowrap; }
.gkr-b[aria-checked="true"] em { color: var(--gk-orange-2); }
.gkr-foot { margin-top: 8px; font-size: 11px; color: var(--gk-faint); }
`;

const hoursLeft = (sec) => (sec >= 3600 ? `${Math.round(sec / 3600)} sa` : `${Math.max(1, Math.round(sec / 60))} dk`);

export function mountStreakStrip({ root, brand, sub = null, touch = false }) {
  injectCSS('retention-strip', CSS);
  applyAccent();
  const strip = el('div', 'gkr-strip');
  if (sub && sub.parentNode === brand) brand.insertBefore(strip, sub.nextSibling); else brand.appendChild(strip);
  const pill = el('button', 'gkr-pill', strip);
  pill.type = 'button';
  pill.setAttribute('aria-haspopup', 'dialog');
  const cd = el('span', 'gkr-cd', strip);
  let pop = null, back = null, timer = 0, destroyed = false;

  function refresh() {
    const today = istanbulDay();
    const s = readStreak(), v = streakView(s, today), b = pickedBadge(s);
    pill.textContent = '';
    el('span', 'fl', pill, '🔥');
    pill.classList.toggle('zero', v.current === 0);
    pill.classList.toggle('risk', v.current > 0 && !v.today);
    if (v.current === 0) el('b', null, pill, 'Seri başlat');
    else {
      el('b', null, pill, `${v.current} gün seri`);
      if (!v.today) el('em', null, pill, touch ? '· bugün uç' : '· bugün uç, sürsün');
    }
    if (b) { const t = el('i', null, pill, b.title); t.style.setProperty('--gkr-badge', b.color); }
    pill.title = v.current ? `Günlük seri: ${v.current} gün (en uzun ${v.best})` : 'Günlük seri: bugün bir uçuş ya da görev bitir';
    cd.textContent = 'Yarınki görev ';
    el('b', null, cd, hoursLeft(secondsToNextDay()));
    cd.append(' sonra');
    if (pop) renderPop();
  }

  // ---- the streak card ----
  function renderPop() {
    const today = istanbulDay();
    const s = readStreak(), v = streakView(s, today);
    pop.textContent = '';
    const h = el('div', 'gkr-h', pop);
    const big = el('div', 'gkr-big', h, String(v.current));
    el('small', null, big, 'GÜN');
    const ht = el('div', null, h);
    el('b', null, ht, 'Günlük seri');
    el('span', null, ht, v.best > 0 ? `En uzun serin: ${v.best} gün` : 'Her gün bir uçuş ya da görev bitir.');
    const x = el('button', 'gkr-x', h, '✕');
    x.type = 'button'; x.title = 'Kapat'; x.addEventListener('click', close);
    const st = el('div', `gkr-st${v.today ? ' ok' : v.current ? ' risk' : ''}`, pop);
    st.textContent = v.today ? `Bugün uçtun: seri ${v.current} gün. Yarın da bir uçuş ya da görev bitir, seri ${v.current + 1} gün olsun.`
      : v.current ? `Bugün bir uçuş ya da görev bitir: seri ${v.current + 1} gün olur. Yoksa gece yarısı sıfırlanır.`
        : 'Bir iniş yap, 2 dakika uç ya da bir görevi bitir: o gün seriye sayılır. 3, 7, 14 ve 30 günde yeni rozetler açılır.';
    el('div', 'gkr-sec', pop, 'Rozetler · unvan ve HUD rengi');
    const pick = (id) => {
      const s2 = readStreak();
      s2.pick = id;
      writeStreak(s2);
      applyAccent(s2);
      trackEvent('streak', { st: 'pick', id: id || 'none' });
      refresh();
    };
    const row = (b) => {
      const p = b ? badgeProgress(s, b, today) : { done: true };
      const btn = el('button', 'gkr-b', pop);
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(b ? s.pick === b.id : !s.pick));
      btn.disabled = !p.done;
      const dot = el('i', 'gkr-dot', btn);
      dot.style.setProperty('--c', b ? b.color : '#5cf2c8');
      const t = el('span', null, btn);
      el('b', null, t, b ? b.title : 'Varsayılan');
      el('small', null, t, b ? `${b.kind === 'streak' ? `${b.need} gün seri` : `Üst üste ${b.need} başarılı iniş`} · ${b.colorName}` : 'Unvan yok · turkuaz HUD');
      el('em', null, btn, !b ? '' : p.done ? (s.pick === b.id ? 'Seçili' : 'Seç') : `${p.have}/${p.need}`);
      if (p.done) btn.addEventListener('click', () => pick(b ? b.id : null));
    };
    row(null);
    for (const b of BADGES) row(b);
    el('div', 'gkr-foot', pop, 'Seri ve rozetler yalnızca bu cihazda tutulur; hiçbir yere gönderilmez.');
  }
  function place() {
    const narrow = touch || innerWidth < 640 || innerHeight < 520;
    pop.classList.toggle('sheet', narrow);
    if (narrow) {   // phones: a dim backdrop behind the sheet; a tap on it closes the card
      if (!back) { back = el('div', 'gkr-pop-back'); root.insertBefore(back, pop); back.addEventListener('click', (e) => { e.stopPropagation(); close(); }); }
      return;
    }
    const rr = root.getBoundingClientRect(), pr = pill.getBoundingClientRect();
    pop.style.left = `${Math.round(pr.left - rr.left)}px`;
    pop.style.top = `${Math.round(pr.bottom - rr.top + 8)}px`;
  }
  function onKey(e) {
    if (!pop) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  function outside(e) { if (pop && !back && !pop.contains(e.target) && !pill.contains(e.target)) close(); }   // (desktop; phones: the backdrop)
  function open() {
    if (pop) { close(); return; }
    pop = el('div', 'gkr-pop', root);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Günlük seri ve rozetler');
    shared.modalOpen = (shared.modalOpen || 0) + 1;
    renderPop();
    place();
    trackEvent('streak', { st: 'open' });
    window.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    if (back) { back.remove(); back = null; }
    shared.modalOpen = Math.max(0, (shared.modalOpen || 1) - 1);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', outside, true);
  }
  pill.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  refresh();
  timer = setInterval(() => { if (!root.isConnected || destroyed) { clearInterval(timer); close(); return; } refresh(); }, 30000);

  return {
    el: strip, refresh, open, close,
    destroy() { destroyed = true; clearInterval(timer); close(); strip.remove(); },
  };
}
