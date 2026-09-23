// Loading screen: Golden Gate line art drawing itself, progress bar with the current step, rotating tips.
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp } from './util.js';
import { goldenGateLineSVG } from './art.js';
import { TIPS, AIRCRAFT_INFO, AIRPORTS } from './data.js';
import { shared } from './shared.js';
import { spawnLabel } from './menu.js';
import { AIRCRAFT } from '../aircraft/registry.js';

const CSS = `
.gkl { position: fixed; inset: 0; z-index: 40; overflow: hidden; color: var(--gk-fg); font-family: var(--gk-sans);
  --u: 1; --u1: calc(1px * var(--u)); -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none;
  background:
    radial-gradient(ellipse 60% 45% at 50% 58%, rgba(255, 120, 70, .16), rgba(255, 120, 70, 0) 70%),
    radial-gradient(ellipse 120% 80% at 50% 40%, #13213a 0%, #0a1223 55%, #04080f 100%);
  animation: gkl-in .35s ease both; font-variant-numeric: tabular-nums; }
@keyframes gkl-in { from { opacity: 0; } to { opacity: 1; } }
.gkl.gkl-out { animation: gkl-out .8s cubic-bezier(.4, 0, .2, 1) forwards; pointer-events: none; }
@keyframes gkl-out { to { opacity: 0; transform: scale(1.02); } }
.gkl-grain { position: absolute; inset: 0; opacity: .06; mix-blend-mode: overlay; pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
.gkl-fog { position: absolute; left: -20%; right: -20%; top: 50%; height: 22%; pointer-events: none; opacity: .5;
  background: radial-gradient(ellipse 50% 50% at 30% 50%, rgba(220, 200, 210, .10), transparent 70%), radial-gradient(ellipse 40% 45% at 72% 55%, rgba(220, 200, 210, .08), transparent 70%);
  animation: gkl-fog 26s ease-in-out infinite alternate; }
@keyframes gkl-fog { from { transform: translateX(-5%); } to { transform: translateX(5%); } }
.gkl-main { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: calc(40 * var(--u1)); }
.gkl-art { width: min(86vw, calc(980 * var(--u1))); aspect-ratio: 1600 / 380; }
.gkl-art svg { width: 100%; height: 100%; overflow: visible; }
.gg-line path { fill: none; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: var(--len, 3000); stroke-dashoffset: var(--len, 3000); animation: gkl-draw 2.6s cubic-bezier(.45, 0, .2, 1) forwards; }
@keyframes gkl-draw { to { stroke-dashoffset: 0; } }
.gg-line .gg-tower { stroke: #ff8a5c; stroke-width: 1.5; filter: drop-shadow(0 0 6px rgba(255, 110, 60, .55)); }
.gg-line .gg-cable { stroke: #ff9d6c; stroke-width: 1.6; filter: drop-shadow(0 0 5px rgba(255, 110, 60, .5)); animation-delay: .5s; }
.gg-line .gg-deck { stroke: #ffb48f; stroke-width: 1.7; animation-delay: .25s; }
.gg-line .gg-truss { stroke: rgba(255, 170, 130, .55); stroke-width: 1; animation-delay: .35s; }
.gg-line .gg-susp { stroke: rgba(255, 160, 120, .42); stroke-width: .8; animation-delay: .95s; animation-duration: 2.2s; }
.gg-line .gg-pier { stroke: rgba(255, 170, 130, .7); stroke-width: 1.4; }
.gg-line .gg-hill { stroke: rgba(170, 196, 235, .45); stroke-width: 1.2; animation-duration: 3.2s; }
.gg-line .gg-far { stroke: rgba(170, 196, 235, .28); }
.gg-line .gg-city { stroke: rgba(170, 196, 235, .35); stroke-width: 1; animation-delay: .8s; }
.gg-line .gg-water { stroke: rgba(150, 190, 240, .22); stroke-width: 1; animation-delay: 1.1s; }
.gg-light { fill: #ffd2b0; opacity: 0; animation: gkl-tw 2.2s ease-in-out infinite; }
.gg-beacon { fill: #ff3b30; opacity: 0; animation: gkl-beacon 1.6s steps(1, end) 2.4s infinite; filter: drop-shadow(0 0 4px #ff3b30); }
@keyframes gkl-tw { 0%, 100% { opacity: .15; } 50% { opacity: .9; } }
@keyframes gkl-beacon { 0% { opacity: 1; } 30% { opacity: .1; } }
.gkl-title { margin-top: calc(26 * var(--u1)); text-align: center; animation: gkl-up .8s .6s cubic-bezier(.2, .8, .2, 1) both; }
.gkl-title h1 { margin: 0; font-family: var(--gk-display); font-size: calc(44 * var(--u1)); font-weight: 800; letter-spacing: -.03em;
  background: linear-gradient(180deg, #fff 30%, #ffd9bf 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.gkl-title div { margin-top: calc(6 * var(--u1)); font-size: calc(12.5 * var(--u1)); font-weight: 650; letter-spacing: .38em; text-transform: uppercase; color: rgba(255, 255, 255, .7); }
@keyframes gkl-up { from { opacity: 0; transform: translateY(calc(10 * var(--u1))); } to { opacity: 1; transform: none; } }
.gkl-flight { margin-top: calc(18 * var(--u1)); display: flex; align-items: center; gap: calc(10 * var(--u1)); font-size: calc(13.5 * var(--u1)); color: rgba(226, 236, 250, .82);
  animation: gkl-up .8s .75s cubic-bezier(.2, .8, .2, 1) both; }
.gkl-flight b { color: #fff; font-weight: 700; }
.gkl-flight i { width: 4px; height: 4px; border-radius: 50%; background: var(--gk-orange-2); }
.gkl-prog { width: min(78vw, calc(560 * var(--u1))); margin-top: calc(34 * var(--u1)); animation: gkl-up .8s .85s cubic-bezier(.2, .8, .2, 1) both; }
.gkl-row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-size: calc(12.5 * var(--u1)); color: var(--gk-dim); margin-bottom: calc(9 * var(--u1)); }
.gkl-step { font-weight: 600; color: rgba(236, 244, 255, .9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkl-pct { font-family: var(--gk-mono); font-weight: 600; color: #ffc9a8; }
.gkl-track { position: relative; height: calc(4 * var(--u1)); border-radius: 4px; background: rgba(255, 255, 255, .09); overflow: hidden; }
.gkl-fill { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); border-radius: inherit;
  background: linear-gradient(90deg, #ff5d33, #ff9a4a 70%, #ffd08a); box-shadow: 0 0 16px rgba(255, 120, 60, .7); }
.gkl-track::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .28), transparent);
  width: 30%; animation: gkl-scan 1.8s ease-in-out infinite; }
@keyframes gkl-scan { from { transform: translateX(-100%); } to { transform: translateX(400%); } }
.gkl-tip { position: absolute; left: 0; right: 0; margin: 0 auto; bottom: calc(42 * var(--u1)); width: min(88vw, calc(720 * var(--u1)));
  display: flex; gap: calc(14 * var(--u1)); align-items: flex-start; padding: calc(14 * var(--u1)) calc(18 * var(--u1));
  border-radius: calc(14 * var(--u1)); background: rgba(255, 255, 255, .045); border: 1px solid rgba(255, 255, 255, .08);
  animation: gkl-up .8s 1s cubic-bezier(.2, .8, .2, 1) both; }
.gkl-tip-l { flex: 0 0 auto; font-size: calc(10.5 * var(--u1)); font-weight: 800; letter-spacing: .2em; text-transform: uppercase; color: #073026;
  background: var(--gk-teal); padding: calc(3 * var(--u1)) calc(7 * var(--u1)); border-radius: 5px; margin-top: calc(2 * var(--u1)); }
.gkl-tip-t { flex: 1 1 auto; font-size: calc(14.5 * var(--u1)); line-height: 1.5; color: rgba(236, 244, 255, .88); transition: opacity .45s ease, transform .45s ease; text-wrap: pretty; }
.gkl-tip-t.gkl-fade { opacity: 0; transform: translateY(4px); }
.gkl-dots { position: absolute; left: 0; right: 0; bottom: calc(-18 * var(--u1)); display: flex; justify-content: center; gap: 6px; }
.gkl-dots i { width: 5px; height: 5px; border-radius: 50%; background: rgba(255, 255, 255, .18); transition: background .3s; }
.gkl-dots i.on { background: var(--gk-orange-2); }
@media (prefers-reduced-motion: reduce) { .gkl *, .gkl { animation-duration: .001s !important; } }
`;

function describeChoice() {
  const c = shared.choice;
  if (c) return { aircraft: c.aircraftName || c.aircraftId, spawn: c.spawnName ? spawnText(c.spawnName) : '' };
  const q = new URLSearchParams(location.search);
  const id = q.get('aircraft');
  if (!id) return null;
  const info = AIRCRAFT_INFO[id];
  const sp = q.get('spawn') || '';
  const m = sp.match(/^(K[A-Z]{3})-(.+)$/);
  let spawn = '';
  if (m) spawn = `${AIRPORTS[m[1]] ? AIRPORTS[m[1]].short : m[1]} · Pist ${m[2]}`;
  else if (/^AIR/.test(sp)) spawn = { 'AIR-GGB': 'Golden Gate yaklaşımı', 'AIR-SFO-FINAL': 'SFO 28L son yaklaşma', 'AIR-CITY': 'Şehir merkezi üstü' }[sp] || 'Havada başlangıç';
  const entry = AIRCRAFT.find((a) => a.id === id);
  return { aircraft: entry ? entry.name : info ? info.short : id, spawn };
}
function spawnText(name) {
  const dot = name.indexOf('·');
  const apt = dot >= 0 ? name.slice(0, dot).trim() : '';
  const l = spawnLabel({ name });
  return apt && apt !== 'Havada' ? `${apt} · ${l.title}` : l.title;
}

export function createLoadingScreen(container) {
  injectCSS('base', BASE_CSS);
  injectCSS('loading', CSS);
  const root = el('div', 'gkl', container);
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-label', 'Yükleniyor');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  el('div', 'gkl-fog', root);
  el('div', 'gkl-grain', root);
  const main = el('div', 'gkl-main', root);
  const art = el('div', 'gkl-art', main);
  art.innerHTML = goldenGateLineSVG();
  // measure path lengths for the draw-on animation
  for (const p of art.querySelectorAll('path')) {
    try { const L = Math.ceil(p.getTotalLength()) + 2; p.style.setProperty('--len', String(L)); } catch { /* not rendered */ }
  }
  const title = el('div', 'gkl-title', main);
  el('h1', null, title, 'Gökyüzü');
  el('div', null, title, 'San Francisco Körfezi');
  const ch = describeChoice();
  if (ch) {
    const fl = el('div', 'gkl-flight', main);
    el('b', null, fl, ch.aircraft);
    if (ch.spawn) { el('i', null, fl); el('span', null, fl, ch.spawn); }
  }
  const prog = el('div', 'gkl-prog', main);
  const row = el('div', 'gkl-row', prog);
  const step = el('div', 'gkl-step', row, 'Hazırlanıyor…');
  const pct = el('div', 'gkl-pct', row, '0%');
  const track = el('div', 'gkl-track', prog);
  const fill = el('div', 'gkl-fill', track);

  // tips
  const tipBox = el('div', 'gkl-tip', root);
  el('div', 'gkl-tip-l', tipBox, 'İpucu');
  const tipText = el('div', 'gkl-tip-t', tipBox, '');
  const dots = el('div', 'gkl-dots', tipBox);
  const N_DOTS = 5;
  const dotEls = Array.from({ length: N_DOTS }, () => el('i', null, dots));
  const order = TIPS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  // put a category-relevant tip first when we know the aircraft
  const qid = new URLSearchParams(location.search).get('aircraft');
  const qEntry = qid ? AIRCRAFT.find((a) => a.id === qid) : null;
  const cat = (shared.choice && shared.choice.category) || (qEntry && qEntry.category);
  const firstKey = cat === 'fighter' ? 'art yakıcı' : cat === 'helicopter' ? 'kolektif' : 'Kalkış';
  const fi = order.findIndex((i) => TIPS[i].includes(firstKey));
  if (fi > 0) [order[0], order[fi]] = [order[fi], order[0]];
  let tipIdx = 0;
  function showTip(i) {
    tipText.textContent = TIPS[order[i % order.length]];
    dotEls.forEach((d, k) => d.classList.toggle('on', k === i % N_DOTS));
  }
  showTip(0);
  const tipTimer = setInterval(() => {
    tipText.classList.add('gkl-fade');
    setTimeout(() => { tipIdx++; showTip(tipIdx); tipText.classList.remove('gkl-fade'); }, 450);
  }, 5200);

  // smooth progress
  let target = 0, shown = 0, raf = 0, hidden = false;
  function tick() {
    raf = 0;
    shown += (target - shown) * 0.12;
    if (Math.abs(target - shown) < 0.002) shown = target;
    fill.style.transform = `scaleX(${shown.toFixed(4)})`;
    pct.textContent = `${Math.round(shown * 100)}%`;
    root.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
    if (shown !== target) raf = requestAnimationFrame(tick);
  }
  function layout() {
    const u = clamp(Math.min(window.innerWidth / 1440, window.innerHeight / 900), 0.66, 2.6);
    root.style.setProperty('--u', u.toFixed(4));
  }
  layout();
  window.addEventListener('resize', layout);

  return {
    setProgress(p, text) {
      if (hidden) return;
      const v = clamp(Number.isFinite(p) ? p : 0, 0, 1);
      target = Math.max(target, v);
      if (text) { const t = String(text).replace(/[.…]+$/, ''); step.textContent = /^hazır$/i.test(t) ? t : `${t}…`; }
      if (!raf) raf = requestAnimationFrame(tick);
    },
    hide() {
      if (hidden) return;
      hidden = true;
      target = 1; shown = 1;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      step.textContent = 'Hazır';
      fill.style.transition = 'transform .35s ease-out';
      fill.style.transform = 'scaleX(1)';
      pct.textContent = '100%';
      clearInterval(tipTimer);
      window.removeEventListener('resize', layout);
      root.classList.add('gkl-out');
      setTimeout(() => root.remove(), 850);
    },
  };
}
