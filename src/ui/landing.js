// Landing score card (CONTRACTS-SF.md §12), free flight and missions: after every touchdown a compact card with 0–3
// stars, a Turkish rating and the sink rate; a tap / click expands it (centreline, touchdown distance, bank / crab,
// bounces, runway). It never blocks flying: no pointer capture outside the card, it fades after a few seconds and sits
// clear of the attitude / speed area (desktop: under the camera bar, top right; touch: top centre between the tapes).
// Bounces are counted for 2.5 s after the first contact before the final rating; the telemetry `land` event gains
// fpm / cl / tdz / st (src/core/telemetry.js setEventExtras). Loaded lazily by src/app/main.js after the start.
//
//   const lc = createLandingCard({ hud, getWorld, prepareShare })   // prepareShare(card) → Promise<{ run(anchor) }> (src/ui/share.js)
//   lc.attach(flight, def)          // once per flight model
//   lc.update(dt, flight)           // every frame (cheap: returns at once without a pending touchdown)
//   lc.onResult(cb)                 // cb(card, touchdown) when a landing is final (missions)
//   lc.setMissionMode(on)           // missions: no share button on the card (the results screen has it)
import { injectCSS, BASE_CSS } from './styles.js';
import { el } from './util.js';
import { sampleTouchdown, scoreLanding, landingFields, scoreDitch } from '../missions/landing-score.js';
import { runwayEnds } from '../flight/fixedwing-autopilot.js';
import { setEventExtras } from '../core/telemetry.js';

const BOUNCE_WINDOW = 2.5;     // s on the ground after the last contact before the card is final
const SHOW_S = 7;              // compact card visible (s)
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.3l-5.8 3.1 1.2-6.5L2.6 9.4l6.5-.8z"/></svg>';

const CSS = `
.gkls { position: absolute; inset: 0; pointer-events: none; font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; }
.gkls-card { position: absolute; right: calc(18px * var(--ps, 1)); top: calc(92px * var(--ps, 1)); width: calc(250px * var(--ps, 1)); box-sizing: border-box;
  padding: calc(9px * var(--ps, 1)) calc(12px * var(--ps, 1)) calc(10px * var(--ps, 1)); border-radius: calc(14px * var(--ps, 1)); pointer-events: auto; cursor: pointer;
  background: linear-gradient(180deg, rgba(16, 26, 42, .8), rgba(6, 11, 20, .76)); border: 1px solid rgba(255, 255, 255, .13);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .06); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  opacity: 0; visibility: hidden; transform: translateY(-6px); transition: opacity .35s ease, transform .35s ease, visibility 0s linear .35s; }
.gkls-card.on { opacity: 1; visibility: visible; transform: none; transition: opacity .2s ease, transform .3s cubic-bezier(.2, .9, .3, 1.2); }
.gkls-top { display: flex; align-items: center; gap: calc(8px * var(--ps, 1)); }
.gkls-tag { font-size: calc(9.5px * var(--ps, 1)); font-weight: 750; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkls-x { margin-left: auto; display: none; width: calc(22px * var(--ps, 1)); height: calc(22px * var(--ps, 1)); border-radius: 6px; border: 0; padding: 0;
  background: rgba(255, 255, 255, .08); color: var(--gk-dim); font: 700 calc(13px * var(--ps, 1)) var(--gk-sans); cursor: pointer; }
.gkls-card.open .gkls-x { display: block; }
.gkls-main { display: flex; align-items: center; gap: calc(10px * var(--ps, 1)); margin-top: calc(4px * var(--ps, 1)); }
.gkls-stars { display: flex; gap: 2px; flex: 0 0 auto; }
.gkls-stars svg { width: calc(19px * var(--ps, 1)); height: calc(19px * var(--ps, 1)); fill: rgba(255, 255, 255, .18); }
.gkls-stars svg.on { fill: #ffc94a; filter: drop-shadow(0 0 5px rgba(255, 201, 74, .5)); }
.gkls-lbl { font-size: calc(17px * var(--ps, 1)); font-weight: 780; letter-spacing: -.01em; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkls-sub { margin-top: calc(3px * var(--ps, 1)); font: 600 calc(12px * var(--ps, 1)) var(--gk-mono); color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkls-rows { display: none; margin-top: calc(8px * var(--ps, 1)); border-top: 1px solid rgba(255, 255, 255, .08); padding-top: calc(6px * var(--ps, 1)); }
.gkls-card.open .gkls-rows { display: block; }
.gkls-row { display: flex; align-items: center; gap: calc(7px * var(--ps, 1)); padding: calc(2.5px * var(--ps, 1)) 0; font-size: calc(12.5px * var(--ps, 1)); }
.gkls-row i { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--gk-faint); }
.gkls-row i.good { background: var(--gk-teal); } .gkls-row i.ok { background: var(--gk-caution); } .gkls-row i.bad { background: var(--gk-warn); }
.gkls-row span { color: rgba(226, 236, 250, .8); flex: 1 1 auto; }
.gkls-row b { font: 700 calc(12px * var(--ps, 1)) var(--gk-mono); white-space: nowrap; }
.gkls-foot { display: flex; align-items: center; gap: calc(8px * var(--ps, 1)); margin-top: calc(7px * var(--ps, 1)); }
.gkls-more { font-size: calc(11px * var(--ps, 1)); font-weight: 650; color: var(--gk-faint); }
.gkls-card.open .gkls-more { display: none; }
.gkls-share { display: none; margin-left: auto; padding: calc(5px * var(--ps, 1)) calc(11px * var(--ps, 1)); border-radius: 8px; border: 1px solid rgba(92, 242, 200, .45);
  background: rgba(92, 242, 200, .1); color: var(--gk-teal); font: 700 calc(11.5px * var(--ps, 1)) var(--gk-sans); cursor: pointer; }
.gkls-card.can-share .gkls-share { display: inline-block; }
.gkls-share:hover { background: rgba(92, 242, 200, .2); }
/* touch: top centre, below the top buttons and the mission strip, between the speed and altitude columns */
html.gk-touch .gkls-card { right: auto; left: 50%; top: calc(var(--gkx-top, 60px) + var(--gkm-strip-h, 0px)); transform: translate(-50%, -6px);
  width: min(300px, var(--gkx-top-w, 300px)); }
html.gk-touch .gkls-card.on { transform: translate(-50%, 0); }
html.gk-touch .gkls-card.open { max-height: calc(100vh - var(--gkx-top, 60px) - 12px); overflow-y: auto; }
`;

export function createLandingCard({ hud, getWorld = () => null, prepareShare = null } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('landing', CSS);
  const root = el('div', 'gkls');
  root.setAttribute('lang', 'tr');
  if (hud && hud.mountLayer) hud.mountLayer(root); else document.body.appendChild(root);
  const card = el('div', 'gkls-card', root);
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const top = el('div', 'gkls-top', card);
  el('span', 'gkls-tag', top, 'İniş puanı');
  const xBtn = el('button', 'gkls-x', top, '✕');
  xBtn.type = 'button'; xBtn.title = 'Kapat';
  const main = el('div', 'gkls-main', card);
  const starsEl = el('div', 'gkls-stars', main);
  starsEl.innerHTML = STAR + STAR + STAR;
  const txt = el('div', null, main);
  txt.style.minWidth = '0';
  const lbl = el('div', 'gkls-lbl', txt, '');
  const sub = el('div', 'gkls-sub', txt, '');
  const rows = el('div', 'gkls-rows', card);
  const foot = el('div', 'gkls-foot', card);
  el('span', 'gkls-more', foot, 'Ayrıntılar ▾');
  const shareBtn = el('button', 'gkls-share', foot, 'Paylaş');
  shareBtn.type = 'button';

  let flightRef = null, def = null, cat = 'airliner', missionMode = false, profile = null;
  let pending = null;          // { td, card0, bounces, air, airT, groundT, t }
  let shown = null, hideT = 0, open = false;
  let last = null;             // immediate (pre-bounce) card of the latest touchdown, for the telemetry event
  let shareP = null, shareH = null;   // share prepared when a good landing shows (the tap then shares at once)
  const listeners = [];

  const ends = () => { const w = getWorld(); return w && w.runways ? runwayEnds(w.runways) : []; };
  const score = (td, bounces) => scoreLanding(td, { category: cat, ends: ends(), bounces, profile });

  // telemetry: the `land` event (src/ui/tutorial.js) gains the score fields; computed here when this module's own
  // touchdown handler has not run yet for this contact (listener order)
  setEventExtras('land', (data) => {
    if (!flightRef) return null;
    let c = last && performance.now() - last.at < 250 ? last.card : null;
    if (!c) {
      const td = sampleTouchdown(flightRef, { verticalSpeed: Number(data && data.vs), onRunway: data && Number(data.rw) === 1 });
      c = score(td, 0);
    }
    return landingFields(c);
  });

  function onTouchdown(info) {
    const f = flightRef;
    if (!f || f.crashed) return;
    if (info && info.water) { pending = null; showDitch(f, info); return; }   // airliner ditching (flight.ditched)
    if (pending && !pending.final) {                 // back on the ground within the window: a bounce
      pending.bounces++;
      const td = sampleTouchdown(f, info);
      if (-td.vs > -pending.td.vs) { pending.td.vs = td.vs; }   // the worst sink counts
      pending.groundT = 0; pending.air = false;
      last = { at: performance.now(), card: score(pending.td, pending.bounces) };
      return;
    }
    const td = sampleTouchdown(f, info, {});
    const c0 = score(td, 0);
    last = { at: performance.now(), card: c0 };
    pending = { td, bounces: 0, air: false, airT: 0, groundT: 0, t: 0, final: false };
  }

  function finalize() {
    const p = pending;
    pending = null;
    if (!p || !flightRef || flightRef.crashed) return;
    const c = score(p.td, p.bounces);
    show(c);
    for (const cb of listeners) { try { cb(c, p.td); } catch (e) { console.error(e); } }
  }

  function fmtNum(v, d = 1) { return v.toFixed(d).replace('.', ',').replace('-', '−'); }
  function show(c) {
    shown = c;
    const stars = starsEl.children;
    for (let i = 0; i < 3; i++) stars[i].classList.toggle('on', i < c.stars);
    starsEl.setAttribute('aria-label', `${c.stars} yıldız`);
    lbl.textContent = c.label;
    const rwName = c.runway ? c.runway.replace(/^K/, '').replace(/^SFO|^OAK|^NGZ/, (m) => ({ SFO: 'SFO', OAK: 'OAK', NGZ: 'Alameda' }[m])) : '';
    sub.textContent = `−${c.fpm} ft/dk${c.onRunway && rwName ? ` · ${rwName}` : ''}`;
    rows.textContent = '';
    const row = (label, value, ok) => { const r = el('div', 'gkls-row', rows); el('i', ok || '', r); el('span', null, r, label); el('b', null, r, value); };
    row('Dikey hız', `${c.fpm} ft/dk`, c.ok.sink);
    if (c.cat === 'helicopter') {
      row('Yatay kayma', `${fmtNum(c.drift)} kt`, c.ok.drift);
      row('Yatış', `${fmtNum(c.bank)}°`, c.ok.att);
    } else {
      row('Merkez çizgi', c.cl == null ? '—' : `${fmtNum(c.cl)} m${c.side ? ` ${c.side}` : ''}`, c.cl == null ? 'bad' : c.ok.cl);
      row('Eşikten mesafe', c.tdz == null ? '—' : `${c.tdz} m${c.tdz < 150 ? ' · kısa' : c.tdz > 914 ? ' · uzun' : ' · TDZ'}`, c.ok.tdz);
      row('Yatış / yengeç', `${fmtNum(c.bank)}° / ${fmtNum(c.crab)}°`, c.ok.att);
    }
    row('Zıplama', c.bounces ? String(c.bounces) : 'yok', c.ok.bounce);
    row('Pist', c.onRunway ? (rwName || 'evet') : c.cat === 'helicopter' ? 'hayır' : 'pist dışı', c.onRunway ? 'good' : c.cat === 'helicopter' ? '' : 'bad');
    row('Puan', `${c.points}/100`, '');
    const canShare = !missionMode && !!prepareShare && c.stars >= 2;
    card.classList.toggle('can-share', canShare);
    shareP = null; shareH = null;
    if (canShare) {
      const p = Promise.resolve().then(() => prepareShare(c));
      shareP = p;
      p.then((h) => { if (shareP === p) shareH = h; }, (e) => console.warn('[landing] share', e));
    }
    open = false;
    card.classList.remove('open');
    card.classList.add('on');
    hideT = SHOW_S;
  }
  /** Water landing card (airliner ditching): the ditching rating instead of the runway score; not a landing for missions. */
  function showDitch(f, info) {
    const kt = (Number.isFinite(f.ias) ? f.ias : 0) / 0.514444;
    const d = { fpm: Math.max(0, -(info.verticalSpeed || 0) * 196.85), pitch: info.pitch || 0, roll: info.roll || 0, kt, gear: 0 };
    const r = scoreDitch(d);
    const stars = Math.max(1, r.stars);
    for (let i = 0; i < 3; i++) starsEl.children[i].classList.toggle('on', i < stars);
    lbl.textContent = r.survivable ? r.label : 'Suya iniş';
    sub.textContent = `−${Math.round(d.fpm)} ft/dk · suya iniş`;
    rows.textContent = '';
    const row = (label, value, ok) => { const x = el('div', 'gkls-row', rows); el('i', ok || '', x); el('span', null, x, label); el('b', null, x, value); };
    const rate = (v) => (v >= 0.8 ? 'good' : v >= 0.4 ? 'ok' : 'bad');
    row('Suya temas hızı', `${Math.round(d.fpm)} ft/dk`, rate(r.parts.sink));
    row('Burun açısı', `${fmtNum(d.pitch)}°`, rate(r.parts.pitch));
    row('Kanatlar', `${fmtNum(Math.abs(d.roll))}° yatış`, rate(r.parts.bank));
    row('Hız', `${Math.round(kt)} kt`, rate(r.parts.speed));
    row('Puan', `${r.points}/100`, '');
    shown = null;
    card.classList.remove('can-share', 'open');
    open = false;
    card.classList.add('on');
    hideT = SHOW_S + 3;
  }
  function hide() { card.classList.remove('on', 'open'); open = false; hideT = 0; }

  card.addEventListener('click', (e) => {
    if (e.target === xBtn) { hide(); return; }
    if (e.target === shareBtn) return;
    open = !open;
    card.classList.toggle('open', open);
    hideT = open ? 25 : SHOW_S;
  });
  // keep the keyboard for flying: the card's buttons never keep the focus
  card.addEventListener('pointerup', () => { if (document.activeElement && card.contains(document.activeElement)) document.activeElement.blur(); });
  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (shareH) shareH.run(shareBtn);
    else if (shareP) shareP.then((h) => h && h.run(shareBtn));
    hideT = Math.max(hideT, 12);
  });

  return {
    attach(flight, d) {
      if (!flight || flight === flightRef || !flight.on) return;
      flightRef = flight; def = d || null;
      const c = (d && d.spec && d.spec.category) || (flight.spec && flight.spec.category) || 'airliner';
      cat = c === 'fighter' || c === 'helicopter' ? c : 'airliner';
      flight.on('touchdown', onTouchdown);
      flight.on('crash', () => { pending = null; hide(); });
    },
    update(dt, f) {
      if (hideT > 0 && (hideT -= dt) <= 0) hide();
      const p = pending;
      if (!p || !f) return;
      if (f.crashed) { pending = null; return; }
      p.t += dt;
      if (!f.onGround) {
        p.airT += dt;
        if (p.airT > 0.2 && !p.air) p.air = true;
        if (p.airT > 4) finalize();                      // touch-and-go / go-around: rated as it was
      } else {
        if (p.air) { p.bounces++; p.air = false; }      // a short hop (the model only reports contacts after 1 s of flight)
        p.airT = 0;
        p.groundT += dt;
        if (p.groundT >= BOUNCE_WINDOW) finalize();
      }
    },
    onResult(cb) { listeners.push(cb); },
    setMissionMode(on) { missionMode = !!on; },
    /** Scoring profile for the flight (missions): null or 'autorotation' (helicopter power-off landing). */
    setProfile(p) { profile = p || null; },
    /** Clear a pending touchdown and the card (flight reset / mission restart). */
    reset() { pending = null; hide(); },
    get last() { return shown; },
    debug() { return { pending: pending ? { t: +pending.t.toFixed(2), bounces: pending.bounces } : null, shown, visible: card.classList.contains('on'), open }; },
  };
}
