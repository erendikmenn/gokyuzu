// Main menu "Görevler" (CONTRACTS-SF.md §12): an entry in the menu (a "Görevler" button and the "Günün görevi" card
// with the countdown to the next one) and the missions panel over the menu scene — mission cards (stars, best score,
// locked state), the selected mission's briefing and "Başla". Loaded lazily by src/ui/menu.js once the menu is on
// screen (the catalog is small; the mission runtime itself only loads when a mission starts).
//
//   mountMissions({ root, brand, foot, container, touch, start })   // start({ id, daily }) closes the menu into the mission
import { injectCSS } from './styles.js';
import { el } from './util.js';
import { shared } from './shared.js';
import { MISSIONS, buildMission, dailyMissionId, loadProgress, totalStars, isUnlocked, AIRCRAFT_SHORT, LEVEL_LABEL } from '../missions/catalog.js';
import { istanbulDay, secondsToNextDay, fmtClock, fmtInt, fmtTime, dayLabel } from '../missions/util.js';

const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.3l-5.8 3.1 1.2-6.5L2.6 9.4l6.5-.8z"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const TARGET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>';
const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';

const CSS = `
.gkmm-entry { display: flex; flex-wrap: wrap; gap: calc(10 * var(--u1)); margin-top: calc(18 * var(--u1)); }
.gkmm-eb { display: flex; align-items: center; gap: calc(10 * var(--u1)); padding: calc(9 * var(--u1)) calc(14 * var(--u1)); border-radius: calc(13 * var(--u1)); cursor: pointer;
  border: 1px solid rgba(255, 255, 255, .16); background: rgba(8, 14, 26, .5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); text-align: left;
  color: var(--gk-fg) !important; transition: background .15s, border-color .15s, transform .15s; outline: none; font: inherit; }
.gkmm-eb:hover { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .3); transform: translateY(-1px); }
.gkmm-eb:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkmm-eb svg { width: calc(22 * var(--u1)); height: calc(22 * var(--u1)); flex: 0 0 auto; color: var(--gk-orange-2); }
.gkmm-eb b { display: block; font-size: calc(15 * var(--u1)); font-weight: 780; letter-spacing: -.01em; white-space: nowrap; }
.gkmm-eb small { display: block; margin-top: 1px; font-size: calc(11.5 * var(--u1)); font-weight: 600; color: var(--gk-dim); white-space: nowrap; }
.gkmm-eb.main { border-color: rgba(255, 140, 90, .6); background: linear-gradient(135deg, rgba(255, 93, 51, .28), rgba(255, 162, 74, .14)); }
.gkmm-eb.daily svg { color: var(--gk-teal); }
.gkmm-eb.daily small b { display: inline; font: 700 calc(11.5 * var(--u1)) var(--gk-mono); color: var(--gk-teal); }
.gkmm-stars { display: inline-flex; gap: 1px; vertical-align: -1px; }
.gkmm-stars svg { width: calc(12 * var(--u1)); height: calc(12 * var(--u1)); fill: rgba(255, 255, 255, .2); color: inherit; }
.gkmm-stars svg.on { fill: #ffc94a; }

/* panel */
.gkmm { position: absolute; inset: 0; z-index: 8; display: grid; grid-template-columns: minmax(0, 1fr) calc(400 * var(--u1)); grid-template-rows: auto minmax(0, 1fr);
  column-gap: calc(24 * var(--u1)); padding: calc(30 * var(--u1)) calc(40 * var(--u1)) calc(24 * var(--u1)); box-sizing: border-box;
  background: linear-gradient(90deg, rgba(4, 8, 16, .9), rgba(4, 8, 16, .72)); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  animation: gkmm-in .3s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkmm-in { from { opacity: 0; } to { opacity: 1; } }
.gkmm-head { grid-column: 1 / span 2; display: flex; align-items: center; gap: calc(14 * var(--u1)); margin-bottom: calc(16 * var(--u1)); }
.gkmm-back { display: inline-flex; align-items: center; gap: 6px; padding: calc(7 * var(--u1)) calc(13 * var(--u1)); border-radius: calc(10 * var(--u1)); cursor: pointer;
  border: 1px solid rgba(255, 255, 255, .18); background: rgba(255, 255, 255, .06); color: var(--gk-fg) !important; font: 650 calc(13 * var(--u1)) var(--gk-sans) !important; }
.gkmm-back:hover { background: rgba(255, 255, 255, .12); }
.gkmm-head h2 { margin: 0; font-family: var(--gk-display); font-size: calc(34 * var(--u1)); font-weight: 800; letter-spacing: -.02em; }
.gkmm-total { margin-left: auto; display: flex; align-items: center; gap: 6px; font: 700 calc(14 * var(--u1)) var(--gk-mono); color: #ffc94a; }
.gkmm-total svg { width: calc(16 * var(--u1)); height: calc(16 * var(--u1)); fill: #ffc94a; }
.gkmm-list { grid-column: 1; grid-row: 2; min-height: 0; overflow-y: auto; padding: 4px 6px 12px 2px; scrollbar-width: thin; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.gkmm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(220 * var(--u1)), 1fr)); gap: calc(10 * var(--u1)); }
.gkmm-day { position: relative; display: flex; align-items: center; gap: calc(16 * var(--u1)); width: 100%; margin-bottom: calc(14 * var(--u1)); padding: calc(14 * var(--u1)) calc(18 * var(--u1));
  border-radius: calc(16 * var(--u1)); border: 1px solid rgba(92, 242, 200, .45); background: linear-gradient(120deg, rgba(92, 242, 200, .16), rgba(20, 40, 60, .5));
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; outline: none; }
.gkmm-day[aria-selected="true"] { box-shadow: 0 0 0 2px var(--gk-teal); }
.gkmm-day > svg { width: calc(34 * var(--u1)); height: calc(34 * var(--u1)); color: var(--gk-teal); flex: 0 0 auto; }
.gkmm-day i { font-style: normal; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-teal); }
.gkmm-day b { display: block; margin-top: 2px; font-size: calc(19 * var(--u1)); font-weight: 780; letter-spacing: -.01em; }
.gkmm-day small { display: block; margin-top: 2px; font-size: calc(12.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-day .gkmm-cd { margin-left: auto; text-align: right; font: 700 calc(18 * var(--u1)) var(--gk-mono); color: var(--gk-fg); white-space: nowrap; }
.gkmm-day .gkmm-cd small { font: 650 calc(10.5 * var(--u1)) var(--gk-sans); letter-spacing: .08em; color: var(--gk-dim); }
.gkmm-card { position: relative; display: flex; flex-direction: column; gap: 4px; min-height: calc(112 * var(--u1)); padding: calc(12 * var(--u1)) calc(14 * var(--u1));
  border-radius: calc(14 * var(--u1)); border: 1px solid rgba(255, 255, 255, .11); background: linear-gradient(180deg, rgba(20, 30, 48, .75), rgba(8, 13, 24, .8));
  cursor: pointer; text-align: left; color: var(--gk-fg) !important; font: inherit; outline: none; transition: border-color .15s, transform .15s; }
.gkmm-card:hover { border-color: rgba(255, 255, 255, .26); transform: translateY(-2px); }
.gkmm-card[aria-selected="true"] { border-color: rgba(255, 140, 90, .9); box-shadow: 0 0 0 1px rgba(255, 120, 70, .5), 0 0 26px rgba(255, 107, 61, .2); }
.gkmm-card:focus-visible { box-shadow: 0 0 0 2px #fff; }
.gkmm-card .n { font: 700 calc(11 * var(--u1)) var(--gk-mono); color: var(--gk-faint); }
.gkmm-card .t { font-size: calc(15.5 * var(--u1)); font-weight: 750; line-height: 1.2; letter-spacing: -.01em; }
.gkmm-card .m { font-size: calc(11.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-card .f { margin-top: auto; display: flex; align-items: center; gap: 8px; font: 650 calc(11.5 * var(--u1)) var(--gk-mono); color: var(--gk-dim); }
.gkmm-card .f .gkmm-stars { margin-left: auto; }
.gkmm-card.locked { opacity: .55; }
.gkmm-card.locked .t::after { content: ""; }
.gkmm-lock { position: absolute; top: calc(10 * var(--u1)); right: calc(10 * var(--u1)); display: flex; align-items: center; gap: 4px; font-size: calc(10.5 * var(--u1)); font-weight: 700; color: var(--gk-dim); }
.gkmm-lock svg { width: calc(14 * var(--u1)); height: calc(14 * var(--u1)); }
.gkmm-lvl { display: inline-block; padding: 1px 6px; border-radius: 5px; font-size: calc(9.5 * var(--u1)); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; background: rgba(255, 255, 255, .08); }
.gkmm-lvl.l3 { color: #ffb4b4; background: rgba(255, 77, 79, .14); } .gkmm-lvl.l2 { color: #ffd08a; background: rgba(255, 176, 32, .12); } .gkmm-lvl.l1 { color: #aef5df; background: rgba(92, 242, 200, .12); }
.gkmm-side { grid-column: 2; grid-row: 2; min-height: 0; display: flex; flex-direction: column; border-radius: calc(18 * var(--u1)); overflow: hidden;
  background: linear-gradient(180deg, rgba(14, 22, 38, .8), rgba(6, 10, 20, .85)); border: 1px solid rgba(255, 255, 255, .1); }
.gkmm-det { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: calc(18 * var(--u1)) calc(20 * var(--u1)) calc(8 * var(--u1)); }
.gkmm-det .k { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: calc(11 * var(--u1)); font-weight: 750; letter-spacing: .12em; text-transform: uppercase; color: var(--gk-dim); }
.gkmm-det .k b { color: var(--gk-orange-2); }
.gkmm-det h3 { margin: calc(8 * var(--u1)) 0; font-size: calc(24 * var(--u1)); font-weight: 800; letter-spacing: -.02em; line-height: 1.12; }
.gkmm-det p { margin: 0; font-size: calc(14 * var(--u1)); line-height: 1.5; color: rgba(226, 236, 250, .86); }
.gkmm-goal { margin-top: calc(12 * var(--u1)); padding: calc(9 * var(--u1)) calc(12 * var(--u1)); border-radius: 11px; background: rgba(255, 162, 74, .1); border: 1px solid rgba(255, 162, 74, .3);
  font-size: calc(13.5 * var(--u1)); font-weight: 650; }
.gkmm-goal span { display: block; font-size: calc(10 * var(--u1)); font-weight: 800; letter-spacing: .16em; color: var(--gk-orange-2); }
.gkmm-crit { margin-top: calc(10 * var(--u1)); display: flex; flex-direction: column; gap: 4px; font-size: calc(12.5 * var(--u1)); color: var(--gk-dim); }
.gkmm-crit .gkmm-stars svg { fill: rgba(255, 255, 255, .18); } .gkmm-crit .gkmm-stars svg.on { fill: #ffc94a; }
.gkmm-best { margin-top: calc(10 * var(--u1)); font-size: calc(12.5 * var(--u1)); color: var(--gk-fg); }
.gkmm-note { margin-top: 8px; font-size: calc(12.5 * var(--u1)); color: var(--gk-teal); font-weight: 650; }
.gkmm-lockmsg { margin-top: calc(12 * var(--u1)); font-size: calc(13 * var(--u1)); color: #ffd08a; }
.gkmm-go { margin: calc(8 * var(--u1)) calc(16 * var(--u1)) calc(16 * var(--u1)); display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: calc(14 * var(--u1)) calc(18 * var(--u1)); border: 0; border-radius: calc(15 * var(--u1)); cursor: pointer; color: #1c0e06 !important;
  background: linear-gradient(135deg, #ff5d33 0%, #ff8a45 60%, #ffb257 100%); box-shadow: 0 14px 36px rgba(255, 96, 50, .38); font: inherit; outline: none; }
.gkmm-go:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 6px rgba(255, 107, 61, .55); }
.gkmm-go b { font-family: var(--gk-display); font-size: calc(26 * var(--u1)); font-weight: 850; }
.gkmm-go small { font-size: calc(11.5 * var(--u1)); font-weight: 650; opacity: .8; }
.gkmm-go kbd { font: 700 calc(11 * var(--u1)) var(--gk-sans); padding: 3px 8px; border-radius: 6px; background: rgba(40, 14, 0, .16); border: 1px solid rgba(40, 14, 0, .25); }
.gkmm-go.alt { background: rgba(255, 255, 255, .1); color: var(--gk-fg) !important; box-shadow: none; }

/* phones (landscape and portrait): one column, the list or the detail */
.gkmm.gkmm-narrow { grid-template-columns: minmax(0, 1fr); padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
.gkmm.gkmm-narrow .gkmm-head { grid-column: 1; margin-bottom: 8px; }
.gkmm.gkmm-narrow .gkmm-head h2 { font-size: 22px; }
.gkmm.gkmm-narrow .gkmm-side { grid-column: 1; display: none; }
.gkmm.gkmm-narrow.detail .gkmm-side { display: flex; }
.gkmm.gkmm-narrow.detail .gkmm-list { display: none; }
.gkmm.gkmm-narrow .gkmm-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.gkmm.gkmm-narrow .gkmm-card { min-height: 92px; padding: 9px 11px; }
.gkmm.gkmm-narrow .gkmm-day { padding: 10px 12px; margin-bottom: 8px; }
.gkmm.gkmm-narrow .gkmm-day b { font-size: 16px; }
.gkmm.gkmm-narrow .gkmm-det { padding: 12px 14px 6px; }
.gkmm.gkmm-narrow .gkmm-det h3 { font-size: 20px; margin: 4px 0 6px; }
.gkmm.gkmm-narrow .gkmm-det p { font-size: 13px; line-height: 1.4; }
.gkmm.gkmm-narrow .gkmm-go { margin: 6px 10px 10px; padding: 10px 14px; }
.gkmm.gkmm-narrow .gkmm-go b { font-size: 22px; }
.gkm.gkm-touch .gkmm-entry.in-foot { margin: 0; gap: 8px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb { padding: 6px 12px; min-height: 36px; border-radius: 11px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb b { font-size: 13.5px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb small { font-size: 10.5px; }
.gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb svg { width: 18px; height: 18px; }
@media (max-height: 380px) { .gkm.gkm-touch .gkmm-entry.in-foot .gkmm-eb small { display: none; } }
`;

const stars = (n, total = 3) => { const s = document.createElement('span'); s.className = 'gkmm-stars'; s.innerHTML = STAR.repeat(total); for (let i = 0; i < n; i++) s.children[i].classList.add('on'); return s; };

export function mountMissions({ root, brand, foot, container, touch = false, start }) {
  injectCSS('missions-menu', CSS);
  const narrowQ = matchMedia('(max-height: 520px), (max-width: 560px)');
  const narrow = () => narrowQ.matches;
  let progress = loadProgress();
  let day = istanbulDay();
  let daily = buildMission(dailyMissionId(day), day);
  let panel = null, timer = 0, sel = null;

  // ---------- entry: "Görevler" + "Günün görevi" ----------
  const entry = el('div', 'gkmm-entry');
  const eMain = el('button', 'gkmm-eb main', entry);
  eMain.type = 'button';
  eMain.innerHTML = TARGET;
  const eMainT = el('span', null, eMain);
  el('b', null, eMainT, 'Görevler');
  const eMainS = el('small', null, eMainT, '');
  const eDay = el('button', 'gkmm-eb daily', entry);
  eDay.type = 'button';
  eDay.innerHTML = CAL;
  const eDayT = el('span', null, eDay);
  const eDayB = el('b', null, eDayT, '');
  const eDayS = el('small', null, eDayT, '');
  function place() {
    const inFoot = touch && narrow();
    entry.classList.toggle('in-foot', inFoot);
    if (inFoot) foot.insertBefore(entry, foot.firstChild); else brand.appendChild(entry);
  }
  place();
  if (narrowQ.addEventListener) narrowQ.addEventListener('change', () => { place(); if (panel) panel.classList.toggle('gkmm-narrow', narrow()); });
  function refreshEntry() {
    progress = loadProgress();
    const ts = totalStars(progress), done = MISSIONS.filter((m) => progress.missions[m.id] && progress.missions[m.id].done).length;
    eMainS.textContent = `${MISSIONS.length} görev · ${done} tamam · `;
    eMainS.append(stars(1, 1), ` ${ts}/${MISSIONS.length * 3}`);
    eDayB.textContent = `Günün görevi: ${daily.title}`;
    eDayS.textContent = '';
    const dp = progress.daily[day];
    eDayS.append(`${AIRCRAFT_SHORT[daily.aircraft]} · ${dp ? `${fmtInt(dp.best)} puan · ` : ''}yenisi `);
    el('b', null, eDayS, fmtClock(secondsToNextDay()));
  }
  refreshEntry();
  eMain.addEventListener('click', () => openPanel(null));
  eDay.addEventListener('click', () => { if (touch && narrow()) openPanel('daily'); else openPanel('daily'); });
  timer = setInterval(tick, 1000);
  function tick() {
    if (!root.isConnected) { clearInterval(timer); return; }
    const d = istanbulDay();
    if (d !== day) { day = d; daily = buildMission(dailyMissionId(day), day); if (panel) renderPanel(); }
    const cd = fmtClock(secondsToNextDay());
    const b = eDayS.querySelector('b');
    if (b) b.textContent = cd;
    if (panel) { const x = panel.querySelector('.gkmm-cd b'); if (x) x.textContent = cd; }
  }

  // ---------- panel ----------
  let cards = [], dayBtn = null, side = null, list = null;
  function openPanel(which) {
    if (panel) return;
    shared.modalOpen = (shared.modalOpen || 0) + 1;
    panel = el('div', 'gkmm', root);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Görevler');
    panel.classList.toggle('gkmm-narrow', narrow());
    renderPanel();
    const first = which === 'daily' ? 'daily' : MISSIONS.find((m) => isUnlocked(m, progress) && !(progress.missions[m.id] && progress.missions[m.id].stars === 3)) || MISSIONS[0];
    select(first === 'daily' ? 'daily' : first.id, which === 'daily' && narrow());
    window.addEventListener('keydown', onKey, true);
  }
  function closePanel() {
    if (!panel) return;
    panel.remove(); panel = null;
    shared.modalOpen = Math.max(0, (shared.modalOpen || 1) - 1);
    window.removeEventListener('keydown', onKey, true);
    refreshEntry();
  }
  function renderPanel() {
    panel.textContent = '';
    progress = loadProgress();
    const head = el('div', 'gkmm-head', panel);
    const back = el('button', 'gkmm-back', head, '← Serbest uçuş');
    back.type = 'button';
    back.addEventListener('click', () => { if (panel.classList.contains('detail')) { panel.classList.remove('detail'); return; } closePanel(); });
    el('h2', null, head, 'Görevler');
    const tot = el('div', 'gkmm-total', head);
    tot.innerHTML = STAR;
    tot.append(`${totalStars(progress)} / ${MISSIONS.length * 3}`);
    list = el('div', 'gkmm-list', panel);
    // daily
    dayBtn = el('button', 'gkmm-day', list);
    dayBtn.type = 'button';
    dayBtn.innerHTML = CAL;
    const dt = el('span', null, dayBtn);
    el('i', null, dt, `Günün görevi · ${dayLabel(day)}`);
    el('b', null, dt, daily.title);
    const dp = progress.daily[day];
    el('small', null, dt, `${AIRCRAFT_SHORT[daily.aircraft]} · ${daily.note}${dp ? ` · en iyin ${fmtInt(dp.best)}` : ''}`);
    const cd = el('span', 'gkmm-cd', dayBtn);
    el('small', null, cd, 'Yeni görev');
    el('b', null, cd, fmtClock(secondsToNextDay()));
    dayBtn.addEventListener('click', () => select('daily', true));
    dayBtn.addEventListener('dblclick', () => go());
    // cards
    const grid = el('div', 'gkmm-grid', list);
    cards = MISSIONS.map((m, i) => {
      const p = progress.missions[m.id];
      const locked = !isUnlocked(m, progress);
      const b = el('button', `gkmm-card${locked ? ' locked' : ''}`, grid);
      b.type = 'button';
      b.dataset.id = m.id;
      el('span', 'n', b, String(i + 1).padStart(2, '0'));
      el('span', 't', b, m.title);
      const meta = el('span', 'm', b, `${AIRCRAFT_SHORT[m.aircraft]} · ~${m.minutes} dk · `);
      el('span', `gkmm-lvl l${m.level}`, meta, LEVEL_LABEL[m.level]);
      const f = el('span', 'f', b, p && p.done ? `${fmtInt(p.best)} puan` : locked ? '' : 'yeni');
      f.append(stars(p ? p.stars || 0 : 0));
      if (locked) { const l = el('span', 'gkmm-lock', b); l.innerHTML = LOCK; l.append(`${m.unlock} yıldız`); }
      b.addEventListener('click', () => select(m.id, true));
      b.addEventListener('dblclick', () => { if (!locked) go(); });
      return b;
    });
    side = el('div', 'gkmm-side', panel);
    if (sel) select(sel, panel.classList.contains('detail'));
  }
  function select(id, userDetail = false) {
    sel = id;
    if (!panel) return;
    for (const c of cards) c.setAttribute('aria-selected', String(c.dataset.id === id));
    dayBtn.setAttribute('aria-selected', String(id === 'daily'));
    const m = id === 'daily' ? daily : buildMission(id);
    const def = MISSIONS.find((x) => x.id === m.id);
    const locked = id !== 'daily' && !isUnlocked(def, progress);
    side.textContent = '';
    const det = el('div', 'gkmm-det', side);
    const k = el('div', 'k', det);
    el('b', null, k, id === 'daily' ? `Günün görevi · ${dayLabel(day)}` : `Görev ${MISSIONS.indexOf(def) + 1}`);
    el('span', null, k, AIRCRAFT_SHORT[m.aircraft]);
    el('span', null, k, `~${m.minutes} dk`);
    el('span', null, k, LEVEL_LABEL[m.level]);
    el('h3', null, det, m.title);
    el('p', null, det, m.brief);
    const g = el('div', 'gkmm-goal', det);
    el('span', null, g, 'Hedef');
    g.append(m.goal);
    if (m.note) el('div', 'gkmm-note', det, `Bugünün farkı: ${m.note}`);
    const crit = el('div', 'gkmm-crit', det);
    if (m.stars === 'landing') { const r = el('div', null, crit); r.append(stars(3), ' İniş puanın kadar yıldız'); }
    else if (m.stars === 'ditch') { const r = el('div', null, crit); r.append(stars(3), ' Suya iniş kalitesine göre'); }
    else {
      const lab = ['Görevi tamamla', `${fmtInt(m.stars[1])} puan`, `${fmtInt(m.stars[2])} puan`];
      for (let i = 0; i < 3; i++) { const r = el('div', null, crit); r.append(stars(i + 1), ` ${lab[i]}`); }
    }
    if (m.limit) el('div', null, crit, `Süre sınırı: ${fmtTime(m.limit)}`);
    const p = id === 'daily' ? progress.daily[day] : progress.missions[m.id];
    if (p && (p.best || p.done)) { const b = el('div', 'gkmm-best', det, `En iyin: ${fmtInt(p.best || 0)} puan  `); b.append(stars(p.stars || 0)); }
    if (locked) el('div', 'gkmm-lockmsg', det, `Toplam ${def.unlock} yıldızla açılır (şu an ${totalStars(progress)}). Önceki görevlerden yıldız topla.`);
    const btn = el('button', `gkmm-go${locked ? ' alt' : ''}`, side);
    btn.type = 'button';
    const bl = el('span', null, btn);
    el('b', null, bl, locked ? 'Kilitli' : 'Başla');
    el('small', null, bl, ` ${AIRCRAFT_SHORT[m.aircraft]}${m.day ? ' · günün görevi' : ''}`);
    if (!touch && !locked) el('kbd', null, btn, 'Enter');
    btn.disabled = locked;
    btn.addEventListener('click', () => go());
    if (narrow() && userDetail) panel.classList.add('detail');
    const card = id === 'daily' ? dayBtn : cards.find((c) => c.dataset.id === id);
    if (card && !narrow()) card.scrollIntoView({ block: 'nearest' });
  }
  function go() {
    if (!sel) return;
    if (sel === 'daily') { closePanel(); clearInterval(timer); start({ id: daily.id, daily: day }); return; }
    const def = MISSIONS.find((x) => x.id === sel);
    if (!def || !isUnlocked(def, progress)) return;
    closePanel(); clearInterval(timer);
    start({ id: sel, daily: null });
  }
  function onKey(e) {
    if (!panel) return;
    e.stopPropagation();
    if (e.type !== 'keydown' || e.metaKey || e.ctrlKey || e.altKey) return;
    const ids = ['daily', ...MISSIONS.map((m) => m.id)];
    const i = ids.indexOf(sel);
    if (e.code === 'Escape') { e.preventDefault(); if (panel.classList.contains('detail')) panel.classList.remove('detail'); else closePanel(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); go(); }
    else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') { e.preventDefault(); select(ids[(i + 1) % ids.length]); }
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') { e.preventDefault(); select(ids[(i - 1 + ids.length) % ids.length]); }
  }

  return { open: openPanel, close: closePanel, get isOpen() { return !!panel; }, daily: () => ({ id: daily.id, day, title: daily.title }), select, go };
}
