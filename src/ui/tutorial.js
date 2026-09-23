// Onboarding for new players: a step-by-step flight tutorial on the first flight of each aircraft category, an opening
// key card (the 5–6 essential controls) that shrinks to a persistent "F1 · Kontroller" chip, contextual hints
// (src/ui/hints.js) and gameplay telemetry (takeoff / land / crash / tutorial steps, src/core/telemetry.js).
//
//   createOnboarding(container, { input, hud, restart }) → {
//     begin({ flight, def, spawn }): boolean   // after the first resetFlight(); true when the tutorial runs
//     update(dt, flight, { view, paused })     // every frame (also while paused: hides the cards)
//     reset()                                  // the flight was reset (R, crash): the running tutorial starts over
//     restart()                                // "Eğitimi yeniden başlat" (F1 help): resets the flight + tutorial
//     debug()                                  // test hook: current tutorial / key card / hint state
//   }
// Everything sits in a bottom-centre stack (hint pill above the tutorial card or the key card) that never covers the
// attitude / speed area of the HUD; the HUD's status chip moves above the stack (--gk-bottom on the HUD root).
// Key labels follow the platform (Shift / Ctrl on macOS, X / Z elsewhere) and switch to gamepad controls when a
// standard gamepad is connected, to the on-screen controls in touch mode (src/ui/tutorial-keys.js; the named controls
// pulse through shared.tutorialChips, src/ui/touch.js). Completion is remembered per category in localStorage.
import { injectCSS, BASE_CSS } from './styles.js';
import { el, keyChips, richText, pressKey, storageGet, storageSet, clamp, wrap180, KT } from './util.js';
import { keySet, essentialKeys } from './tutorial-keys.js';
import { pickScenario } from './tutorial-steps.js';
import { createHints, explainCrash } from './hints.js';
import { AIRCRAFT_INFO } from './data.js';
import { shared } from './shared.js';
import { loadSettings } from '../core/settings.js';
import { trackEvent } from '../core/telemetry.js';

const DONE_KEY = 'gokyuzu.tutorial';          // { airliner: 'done' | 'skipped', fighter: …, helicopter: … }
const KEYCARD_SECONDS = 10;
const OK_SECONDS = 0.75;                      // check mark between two steps
// flight-model warning flags → short codes for the crash event (src/flight: fixedwing.js, helicopter.js)
const WARN_CODES = {
  stall: 'st', overspeed: 'os', gear: 'gr', bank: 'bk', sinkRate: 'sr', pullUp: 'pu', lowEnergy: 'le', alphaFloor: 'af',
  togaLock: 'tl', lowSpeed: 'ls', lowRotor: 'lr', highRotor: 'hr', overtorque: 'ot', vrs: 'vrs', lowFuel: 'lf',
};

/** Tutorial state per category ('done' | 'skipped' | undefined). */
export function tutorialStatus(category) { const s = storageGet(DONE_KEY); return s && typeof s === 'object' ? s[category] : undefined; }
function markTutorial(category, value) { const s = storageGet(DONE_KEY) || {}; s[category] = value; storageSet(DONE_KEY, s); }
/** Forget every completed / skipped tutorial (Ayarlar → "Eğitimleri sıfırla"). */
export function resetTutorials() { storageSet(DONE_KEY, {}); }

const CSS = `
.gkt { position: absolute; inset: 0; pointer-events: none; --ts: 1; font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; }
.gkt-stack { position: absolute; left: 50%; bottom: calc(18px * var(--ts)); transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px);
  display: flex; flex-direction: column; align-items: center; gap: calc(8px * var(--ts)); transition: opacity .25s ease, visibility 0s linear 0s; }
.gkt.gkt-hide .gkt-stack, .gkt.gkt-hide .gkt-f1 { opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s; }
.gkt.gkt-crash .gkt-card, .gkt.gkt-crash .gkt-kc { opacity: 0; visibility: hidden; }
.gkt.gkt-hide .gkt-kc-timer, .gkt.gkt-crash .gkt-kc-timer { animation-play-state: paused !important; }
.gkt-glass { background: linear-gradient(180deg, rgba(16, 26, 42, 0.8), rgba(6, 11, 20, 0.78)); border: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: 0 14px 38px rgba(0, 0, 0, .34), inset 0 1px 0 rgba(255, 255, 255, .07); -webkit-backdrop-filter: blur(14px) saturate(1.2); backdrop-filter: blur(14px) saturate(1.2); }
.gkt-tag { font-size: calc(10.5px * var(--ts)); font-weight: 750; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-teal); white-space: nowrap; }

/* tutorial card */
.gkt-card { display: none; position: relative; width: calc(500px * var(--ts)); max-width: calc(100vw - 32px); box-sizing: border-box;
  padding: calc(10px * var(--ts)) calc(14px * var(--ts)) calc(13px * var(--ts)); border-radius: calc(16px * var(--ts)); pointer-events: auto;
  transition: border-color .4s ease, box-shadow .4s ease; }
.gkt-card.on { display: block; animation: gkt-in .38s cubic-bezier(.2, .9, .3, 1.15) both; }
.gkt-card.gkt-out { animation: gkt-out .32s ease forwards; }
@keyframes gkt-in { from { opacity: 0; transform: translateY(12px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes gkt-out { to { opacity: 0; transform: translateY(10px) scale(.97); } }
.gkt-head { display: flex; align-items: center; gap: calc(8px * var(--ts)); }
.gkt-step { font-size: calc(11px * var(--ts)); font-weight: 650; color: var(--gk-dim); white-space: nowrap; }
.gkt-opt { display: none; font-size: calc(9.5px * var(--ts)); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px;
  color: var(--gk-dim); border: 1px solid rgba(255, 255, 255, .18); }
.gkt-opt.on { display: inline-block; }
.gkt-prog { display: flex; gap: 3px; margin-left: auto; }
.gkt-prog i { width: calc(16px * var(--ts)); height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .16); transition: background .3s ease; }
.gkt-prog i.done { background: var(--gk-teal); }
.gkt-prog i.cur { background: rgba(92, 242, 200, .5); }
.gkt-skip { margin-left: calc(6px * var(--ts)); padding: 2px 4px; border: 0; background: none; cursor: pointer; font: 600 calc(11.5px * var(--ts)) var(--gk-sans);
  color: var(--gk-faint); text-decoration: underline; text-decoration-color: rgba(208, 222, 240, .25); text-underline-offset: 3px; white-space: nowrap; }
.gkt-skip:hover { color: var(--gk-fg); text-decoration-color: currentColor; }
.gkt-skip:focus-visible { outline: 2px solid var(--gk-teal); outline-offset: 2px; border-radius: 4px; }
.gkt-body { display: flex; align-items: center; gap: calc(14px * var(--ts)); margin-top: calc(8px * var(--ts)); }
.gkt-chips { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; min-width: calc(56px * var(--ts)); min-height: calc(44px * var(--ts)); }
.gkt-chips .gk-keys { flex-wrap: wrap; justify-content: center; max-width: calc(150px * var(--ts)); row-gap: 4px; }
.gkt-chips .gk-keys kbd { font-size: calc(15px * var(--ts)); padding: calc(5px * var(--ts)) calc(10px * var(--ts)); border-radius: calc(8px * var(--ts)); min-width: calc(18px * var(--ts));
  border-bottom-width: 3px; background: rgba(255, 255, 255, .12); }
.gkt-check { display: none; width: calc(40px * var(--ts)); height: calc(40px * var(--ts)); border-radius: 50%; background: var(--gk-teal); color: #04140f;
  align-items: center; justify-content: center; box-shadow: 0 0 22px rgba(92, 242, 200, .45); }
.gkt-check svg { width: 58%; height: 58%; }
.gkt-card.ok .gkt-check, .gkt-card.fin .gkt-check { display: flex; animation: gkt-pop .35s cubic-bezier(.2, .9, .3, 1.4) both; }
.gkt-card.ok .gkt-chips .gk-keys, .gkt-card.fin .gkt-chips .gk-keys { display: none; }
@keyframes gkt-pop { from { transform: scale(.4); opacity: 0; } to { transform: none; opacity: 1; } }
.gkt-main { flex: 1 1 auto; min-width: 0; }
.gkt-title { font-size: calc(16.5px * var(--ts)); font-weight: 750; letter-spacing: -.01em; line-height: 1.25; }
.gkt-text { margin-top: calc(3px * var(--ts)); font-size: calc(13.5px * var(--ts)); line-height: 1.45; color: rgba(226, 236, 250, .86); text-wrap: pretty; }
.gkt-text kbd.gk-ikbd { font-size: calc(11.5px * var(--ts)); }
.gkt-meter { display: none; align-items: center; gap: calc(8px * var(--ts)); margin-top: calc(7px * var(--ts)); font-size: calc(11.5px * var(--ts)); }
.gkt-meter.on { display: flex; }
.gkt-meter span { color: var(--gk-dim); font-weight: 650; letter-spacing: .04em; min-width: calc(58px * var(--ts)); }
.gkt-meter b { font: 700 calc(12.5px * var(--ts)) var(--gk-mono); white-space: nowrap; min-width: calc(92px * var(--ts)); text-align: right; }
.gkt-bar { flex: 1 1 auto; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, .1); overflow: hidden; }
.gkt-bar i { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, rgba(92, 242, 200, .55), var(--gk-teal)); border-radius: 3px;
  transform-origin: 0 50%; transform: scaleX(0); transition: transform .2s linear; }
.gkt-meter.warn b { color: var(--gk-caution); }
.gkt-meter.warn .gkt-bar i { background: linear-gradient(90deg, rgba(255, 176, 32, .6), var(--gk-caution)); }
.gkt-card.nudge { border-color: rgba(255, 176, 32, .55); box-shadow: 0 14px 38px rgba(0, 0, 0, .34), 0 0 0 1px rgba(255, 176, 32, .18), 0 0 28px rgba(255, 176, 32, .16); }
.gkt-card.nudge .gkt-chips .gk-keys kbd { animation: gkt-key 1.3s ease-in-out infinite; }
@keyframes gkt-key { 0%, 100% { transform: none; box-shadow: none; } 45% { transform: translateY(1px); border-color: rgba(255, 196, 90, .9); box-shadow: 0 0 14px rgba(255, 176, 32, .45); } }
.gkt-card.ok { border-color: rgba(92, 242, 200, .5); }

/* opening key card */
.gkt-kc { display: none; position: relative; box-sizing: border-box; width: max-content; min-width: calc(470px * var(--ts)); max-width: calc(100vw - 32px); overflow: hidden;
  padding: calc(11px * var(--ts)) calc(16px * var(--ts)) calc(13px * var(--ts)); border-radius: calc(16px * var(--ts)); pointer-events: auto; cursor: pointer; }
.gkt-kc.on { display: block; animation: gkt-in .45s cubic-bezier(.2, .9, .3, 1.15) both; }
.gkt-kc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gkt-kc-f1 { font-size: calc(12px * var(--ts)); color: var(--gk-dim); white-space: nowrap; }
.gkt-kc-f1 kbd.gk-ikbd { font-size: calc(11px * var(--ts)); }
.gkt-kc-grid { display: grid; grid-template-columns: repeat(3, auto); justify-content: space-between; gap: calc(10px * var(--ts)) calc(22px * var(--ts)); margin-top: calc(10px * var(--ts)); }
.gkt-kc-cell { display: flex; align-items: center; gap: calc(9px * var(--ts)); min-width: 0; }
.gkt-kc-cell .gk-keys { flex: 0 0 auto; }
.gkt-kc-cell .gk-keys kbd { font-size: calc(13px * var(--ts)); padding: calc(4px * var(--ts)) calc(8px * var(--ts)); }
.gkt-kc-cell small { font-size: calc(12.5px * var(--ts)); font-weight: 600; color: rgba(226, 236, 250, .86); line-height: 1.2; white-space: nowrap; }
.gkt-kc-timer { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(92, 242, 200, .75); transform-origin: 0 50%; }
.gkt-kc.on .gkt-kc-timer { animation: gkt-timer ${KEYCARD_SECONDS}s linear forwards; }
@keyframes gkt-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }

/* persistent "F1 · Kontroller" chip */
.gkt-f1 { position: absolute; top: calc(12px * var(--ts)); right: calc(14px * var(--ts)); display: flex; align-items: center; gap: calc(7px * var(--ts));
  padding: calc(4px * var(--ts)) calc(11px * var(--ts)) calc(4px * var(--ts)) calc(5px * var(--ts)); border-radius: calc(10px * var(--ts)); cursor: pointer; pointer-events: auto;
  font: 650 calc(12.5px * var(--ts)) var(--gk-sans); color: var(--gk-dim); opacity: 0; visibility: hidden; transform: scale(.9);
  transition: opacity .3s ease, transform .3s ease, visibility 0s linear .3s, color .15s ease; }
.gkt-f1.on { opacity: 1; visibility: visible; transform: none; transition: opacity .3s ease, transform .35s cubic-bezier(.2, .9, .3, 1.3), color .15s ease; }
.gkt-f1:hover { color: var(--gk-fg); }
.gkt-f1 kbd.gk-kbd { font-size: calc(11.5px * var(--ts)); padding: 2px 6px; }
.gkt-f1:focus-visible { outline: 2px solid var(--gk-teal); outline-offset: 2px; }
@media (max-width: 720px) { .gkt-kc-grid { grid-template-columns: repeat(2, 1fr); } }

/* cockpit view: compact, more transparent cards at the upper left, clear of the HUD combiner, the top strip and the
   main instrument panel (MFDs, PFD/ND) the player is being taught to watch */
.gkt.gkt-cockpit .gkt-stack { left: calc(14px * var(--ts)); top: calc(12px * var(--ts)); bottom: auto; transform: none; align-items: flex-start;
  flex-direction: column-reverse; gap: calc(6px * var(--ts)); max-width: min(calc(100vw - 32px), calc(400px * var(--ts))); }
.gkt.gkt-cockpit .gkt-glass { background: linear-gradient(180deg, rgba(12, 20, 34, 0.6), rgba(5, 9, 16, 0.56)); box-shadow: 0 10px 28px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .06); }
.gkt.gkt-cockpit .gkt-card { width: calc(380px * var(--ts)); padding: calc(8px * var(--ts)) calc(12px * var(--ts)) calc(10px * var(--ts)); border-radius: calc(13px * var(--ts)); }
.gkt.gkt-cockpit .gkt-prog i { width: calc(11px * var(--ts)); }
.gkt.gkt-cockpit .gkt-body { gap: calc(10px * var(--ts)); margin-top: calc(6px * var(--ts)); }
.gkt.gkt-cockpit .gkt-chips { min-width: calc(42px * var(--ts)); min-height: calc(34px * var(--ts)); }
.gkt.gkt-cockpit .gkt-chips .gk-keys { max-width: calc(110px * var(--ts)); }
.gkt.gkt-cockpit .gkt-chips .gk-keys kbd { font-size: calc(13px * var(--ts)); padding: calc(4px * var(--ts)) calc(8px * var(--ts)); border-bottom-width: 2px; }
.gkt.gkt-cockpit .gkt-check { width: calc(32px * var(--ts)); height: calc(32px * var(--ts)); }
.gkt.gkt-cockpit .gkt-title { font-size: calc(14.5px * var(--ts)); }
.gkt.gkt-cockpit .gkt-text { font-size: calc(12.5px * var(--ts)); line-height: 1.4; }
.gkt.gkt-cockpit .gkt-text kbd.gk-ikbd { font-size: calc(10.5px * var(--ts)); }
.gkt.gkt-cockpit .gkt-meter { margin-top: calc(5px * var(--ts)); }
.gkt.gkt-cockpit .gkt-meter b { min-width: calc(80px * var(--ts)); }
.gkt.gkt-cockpit .gkt-kc { min-width: 0; padding: calc(9px * var(--ts)) calc(13px * var(--ts)) calc(11px * var(--ts)); border-radius: calc(13px * var(--ts)); }
.gkt.gkt-cockpit .gkt-kc-grid { grid-template-columns: repeat(2, auto); gap: calc(8px * var(--ts)) calc(18px * var(--ts)); }
.gkt.gkt-cockpit .gkt-kc-cell .gk-keys kbd { font-size: calc(12px * var(--ts)); padding: calc(3px * var(--ts)) calc(7px * var(--ts)); }
.gkt.gkt-cockpit .gkt-kc-cell small { font-size: calc(11.5px * var(--ts)); }
.gkt.gkt-cockpit .gkt-hint { max-width: calc(380px * var(--ts)); border-radius: calc(14px * var(--ts)); font-size: calc(13px * var(--ts)); }
`;

/** Sentences may start with a phrase ("sol çubuğu geri çek…", gamepad / touch labels): upper-case the first letter. */
const capitalize = (t) => String(t ?? '').replace(/^(\s*)(\p{Ll})/u, (m, sp, ch) => sp + ch.toLocaleUpperCase('tr'));

const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export function createOnboarding(container, { input = null, hud = null, restart = null } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('onboarding', CSS);
  const root = el('div', 'gkt');
  root.setAttribute('lang', 'tr');
  // below the HUD's toasts, help and pause overlays (they cover the cards), above the instruments
  if (hud && hud.mountLayer) hud.mountLayer(root); else (container || document.body).appendChild(root);
  const stack = el('div', 'gkt-stack', root);

  // ---------- context read by the steps and the hint rules (filled every frame, numbers only) ----------
  const c = {
    f: null, inp: { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }, k: keySet('kb'), cat: 'airliner', spec: null, view: 'exterior',
    kt: 0, gsKt: 0, fwdKt: 0, vr: 140, flapKt: 180, flap0: '0', lever: 0, detent: 1, ab: false, ap: false, sinkFpm: 0, turned: 0,
    airborne: false, stepT: 0, acc: { pitch: 0, roll: 0, stick: 0 }, ev: { takeoff: false, touchdown: false },
    base: { idx0: 1, thr0: 0, hdg0: null, banked: false },
  };

  // ---------- hints ----------
  const hints = createHints(stack, { busy: (topic) => tut.active && !tut.okT && tut.steps[tut.i].topics.includes(topic) });

  // ---------- tutorial card ----------
  const card = el('div', 'gkt-card gkt-glass', stack);
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const head = el('div', 'gkt-head', card);
  el('span', 'gkt-tag', head, 'Eğitim');
  const stepLbl = el('span', 'gkt-step', head, '');
  const optLbl = el('span', 'gkt-opt', head, 'isteğe bağlı');
  const prog = el('span', 'gkt-prog', head);
  const skipBtn = el('button', 'gkt-skip', head, 'Eğitimi geç');
  skipBtn.type = 'button';
  const body = el('div', 'gkt-body', card);
  const chipBox = el('div', 'gkt-chips', body);
  const check = el('div', 'gkt-check', chipBox);
  check.innerHTML = CHECK_SVG;
  let chipKeys = null;
  const mainBox = el('div', 'gkt-main', body);
  const titleEl = el('div', 'gkt-title', mainBox, '');
  const textEl = el('div', 'gkt-text', mainBox, '');
  const meterEl = el('div', 'gkt-meter', mainBox);
  const meterLbl = el('span', null, meterEl, '');
  const meterBar = el('i', null, el('span', 'gkt-bar', meterEl));
  const meterVal = el('b', null, meterEl, '');
  skipBtn.addEventListener('click', (e) => { e.stopPropagation(); skipBtn.blur(); if (tut.active) (tut.steps[tut.i].final ? finishTutorial(false) : skipTutorial()); });

  // ---------- opening key card ----------
  const kc = el('div', 'gkt-kc gkt-glass', stack);
  kc.setAttribute('role', 'note');
  const kcHead = el('div', 'gkt-kc-head', kc);
  const kcTitle = el('span', 'gkt-tag', kcHead, 'Temel kontroller');
  const kcF1 = el('span', 'gkt-kc-f1', kcHead);
  richText(kcF1, '{F1} tüm kontroller');
  const kcGrid = el('div', 'gkt-kc-grid', kc);
  el('i', 'gkt-kc-timer', kc);
  kc.addEventListener('click', () => shrinkKeyCard());

  // ---------- persistent chip ----------
  const f1 = el('button', 'gkt-f1 gkt-glass', root);
  f1.type = 'button';
  el('kbd', 'gk-kbd', f1, 'F1');
  el('span', null, f1, 'Kontroller');
  f1.title = 'Tüm kontroller';
  f1.addEventListener('click', () => { f1.blur(); pressKey('F1'); });

  // the HUD's status chip ("İniş takımı YUKARI") sits above this stack
  const hudRoot = hud && hud.element;
  function syncBottom() {
    if (!hudRoot) return;
    // touch hook (src/ui/touch.js): on phones the stack sits at the top centre (the thumbs' controls fill the bottom and
    // the chase view shows the aircraft there); the HUD's toasts / warnings then move below it (--gk-top-stack)
    const top = document.documentElement.classList.contains('gkx-phone');
    const h = cockpitOn && !top ? 0 : stack.getBoundingClientRect().height;
    hudRoot.style.setProperty('--gk-bottom', `${top ? 0 : Math.round(h > 1 ? h + 18 * ts : 0)}px`);
    if (top || hudRoot.style.getPropertyValue('--gk-top-stack')) hudRoot.style.setProperty('--gk-top-stack', `${top && h > 1 ? Math.round(h + 8) : 0}px`);
  }
  if (hudRoot && typeof ResizeObserver !== 'undefined') new ResizeObserver(syncBottom).observe(stack);

  // ---------- state ----------
  let enabled = loadSettings().tutorial !== false;
  let started = false, def = null, spawn = null, flightRef = null, scenario = null, device = 'kb', devT = 0, meterT = 0;
  let paused = false, crashed = false, hudOff = false, ts = 1, cockpitOn = false;
  const tut = { active: false, forced: false, steps: [], i: 0, phase: -1, ripeT: 0, nudged: false, okT: 0, t0: 0, total: 0 };
  const key = { active: false, t: 0, shrinking: false };
  let f1On = false, hideOn = false, crashOn = false;
  const toggle = (node, cls, on) => node.classList.toggle(cls, on);
  // labels: gamepad when one is connected, the on-screen controls in touch mode (src/ui/touch.js), else the keyboard
  const deviceKind = () => (input && input.gamepadConnected ? 'pad' : input && input.touchMode ? 'touch' : 'kb');

  function layout() {
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
    ts = clamp(Math.min(vh / 900, vw / 1400), 0.86, 1.6);
    root.style.setProperty('--ts', ts.toFixed(3));
  }
  layout();
  window.addEventListener('resize', layout);

  // ---------- tutorial ----------
  function startTutorial(forced = false) {
    if (!scenario) return;
    hideKeyCard(true);
    setF1(false);
    Object.assign(tut, { active: true, forced, i: -1, t0: performance.now(), total: 0 });
    c.ev.takeoff = false; c.ev.touchdown = false;
    prog.textContent = '';
    for (let i = 0; i < tut.steps.length; i++) el('i', null, prog);
    card.classList.remove('gkt-out');
    card.classList.add('on');
    enterStep(0);
  }

  function enterStep(i) {
    tut.i = i;
    const st = tut.steps[i];
    tut.phase = st.phase ? st.phase(c) : 0;
    tut.ripeT = 0; tut.nudged = false; tut.okT = 0;
    c.stepT = 0; c.acc.pitch = 0; c.acc.roll = 0; c.acc.stick = 0;
    c.base.idx0 = 1; c.base.thr0 = c.lever; c.base.hdg0 = null; c.base.banked = false;
    if (st.enter) st.enter(c);
    card.classList.remove('ok', 'nudge');
    toggle(card, 'fin', !!st.final);       // last card: a check mark instead of key chips (the tips carry inline chips)
    renderStep(true);
    // re-trigger the entry animation for the new step
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  function renderStep(full) {
    const st = tut.steps[tut.i];
    const k = c.k;
    if (full) {
      stepLbl.textContent = `Adım ${tut.i + 1}/${tut.steps.length}`;
      toggle(optLbl, 'on', !!st.optional);
      for (let j = 0; j < prog.children.length; j++) {
        prog.children[j].className = j < tut.i ? 'done' : j === tut.i ? 'cur' : '';
      }
      skipBtn.textContent = st.final ? 'Kapat' : 'Eğitimi geç';
    }
    if (chipKeys) chipKeys.remove();
    chipKeys = keyChips(chipBox, st.keys(k, c));
    // touch hook (src/ui/touch.js): the on-screen controls named on the card pulse
    shared.tutorialChips = [...chipKeys.querySelectorAll('kbd')].map((x) => x.textContent).join('|');
    titleEl.textContent = st.title(k, c, tut.phase);
    const explicit = tut.nudged && st.explicit ? st.explicit(k, c, tut.phase) : null;
    richText(textEl, capitalize(explicit || st.text(k, c, tut.phase)));
    toggle(card, 'nudge', !!explicit);
    toggle(meterEl, 'on', !!st.meter);
    meterT = 0;
  }

  const meterOut = { label: '', value: '', frac: 0, warn: false };
  let lastLbl = null, lastVal = null, lastFrac = -1, lastWarn = null;
  function updateMeter(st) {
    meterOut.warn = false;
    st.meter(c, meterOut);
    if (meterOut.label !== lastLbl) { lastLbl = meterOut.label; meterLbl.textContent = meterOut.label; }
    if (meterOut.value !== lastVal) { lastVal = meterOut.value; meterVal.textContent = meterOut.value; }
    const fr = Math.round(clamp(meterOut.frac, 0, 1) * 100) / 100;
    if (fr !== lastFrac) { lastFrac = fr; meterBar.style.transform = `scaleX(${fr})`; }
    if (meterOut.warn !== lastWarn) { lastWarn = meterOut.warn; toggle(meterEl, 'warn', meterOut.warn); }
  }

  function tickTutorial(dt) {
    const st = tut.steps[tut.i];
    if (tut.okT > 0) {                       // check mark shown: next step (or the end) after a short beat
      tut.okT -= dt;
      if (tut.okT <= 0) { tut.okT = 0; if (tut.i + 1 < tut.steps.length) enterStep(tut.i + 1); else finishTutorial(true); }
      return;
    }
    c.stepT += dt;
    tut.total += dt;
    const ip = Math.abs(c.inp.pitch) > 0.25, ir = Math.abs(c.inp.roll) > 0.25;
    if (ip) c.acc.pitch += dt;
    if (ir) c.acc.roll += dt;
    if (ip || ir) c.acc.stick += dt;
    const ph = st.phase ? st.phase(c) : 0;
    if (ph !== tut.phase) { tut.phase = ph; renderStep(false); }
    if (!tut.nudged && st.explicit && (st.ripe ? st.ripe(c) : true)) {
      tut.ripeT += dt;
      if (tut.ripeT >= (st.nudge ?? 12) && st.explicit(c.k, c, tut.phase)) { tut.nudged = true; renderStep(false); }
    }
    if (st.meter && (meterT -= dt) <= 0) { meterT = 0.2; updateMeter(st); }
    if (st.done(c)) completeStep(st);
  }

  function completeStep(st) {
    trackEvent('tut', { ac: def && def.id, sc: scenario.id, st: st.id, i: tut.i + 1, sec: c.stepT.toFixed(1) });
    if (st.final) { finishTutorial(true); return; }
    card.classList.remove('nudge');
    card.classList.add('ok');
    prog.children[tut.i].className = 'done';
    tut.okT = OK_SECONDS;
    // all real steps done: remember it now (the last card only lists free-flight tips)
    if (tut.i + 1 < tut.steps.length && tut.steps[tut.i + 1].final) {
      markTutorial(c.cat, 'done');
      trackEvent('tut', { ac: def && def.id, sc: scenario.id, st: 'done', sec: tut.total.toFixed(0) });
    }
  }

  function finishTutorial() {
    tut.active = false;
    shared.tutorialChips = '';
    card.classList.add('gkt-out');
    setTimeout(() => { if (!tut.active) card.classList.remove('on', 'gkt-out', 'ok', 'nudge', 'fin'); }, 330);
    setF1(true);
  }

  function skipTutorial() {
    const st = tut.steps[tut.i];
    trackEvent('tut', { ac: def && def.id, sc: scenario.id, st: st.id, i: tut.i + 1, sec: c.stepT.toFixed(1), x: 'skip' });
    markTutorial(c.cat, tutorialStatus(c.cat) === 'done' ? 'done' : 'skipped');
    finishTutorial(false);
    if (hud) hud.showMessage('Eğitim kapatıldı. F1 ekranından istediğin zaman yeniden başlatabilirsin.', 3200);
  }

  // ---------- key card ----------
  function buildKeyCard() {
    const nm = def ? ((AIRCRAFT_INFO[def.id] && AIRCRAFT_INFO[def.id].short) || def.name || '') : '';
    kcTitle.textContent = nm ? `${nm} · temel kontroller` : 'Temel kontroller';
    richText(kcF1, `${c.k.chip('help')} tüm kontroller`);
    kcGrid.textContent = '';
    for (const [keys, label] of essentialKeys(c.cat, device)) {
      const cell = el('div', 'gkt-kc-cell', kcGrid);
      keyChips(cell, keys);
      el('small', null, cell, label);
    }
  }
  function showKeyCard() {
    buildKeyCard();
    key.active = true; key.t = KEYCARD_SECONDS; key.shrinking = false;
    kc.getAnimations().forEach((a) => a.cancel());
    kc.classList.add('on');
    setF1(false);
  }
  function hideKeyCard(now) {
    if (!key.active && !key.shrinking) return;
    key.active = false; key.shrinking = false;
    if (now) kc.classList.remove('on');
  }
  /** Shrink the key card into the corner chip (FLIP towards the chip's position). */
  function shrinkKeyCard() {
    if (!key.active || key.shrinking) return;
    key.active = false; key.shrinking = true;
    const a = kc.getBoundingClientRect(), b = f1.getBoundingClientRect();
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    const sc = Math.max(0.08, b.width / Math.max(a.width, 1));
    const done = () => { if (!key.shrinking) return; key.shrinking = false; kc.classList.remove('on'); setF1(true); };
    if (kc.animate && a.width > 0) {
      const anim = kc.animate([
        { transform: 'none', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${sc})`, opacity: 0 },
      ], { duration: 650, easing: 'cubic-bezier(.55, 0, .25, 1)', fill: 'forwards' });
      anim.onfinish = () => { done(); anim.cancel(); };
      setTimeout(done, 900);
    } else done();
  }

  function setF1(on) { f1On = on; }

  // ---------- flight events: tutorial progress + telemetry ----------
  function bindFlight(flight) {
    if (!flight || flight === flightRef || !flight.on) return;
    flightRef = flight;
    const ac = () => (def && def.id) || '';
    flight.on('takeoff', () => {
      c.ev.takeoff = true;
      trackEvent('takeoff', { ac: ac(), sp: spawn && spawn.id });
    });
    flight.on('touchdown', (i) => {
      c.ev.touchdown = true;
      if (flight.crashed || !i) return;
      trackEvent('land', { ac: ac(), sp: spawn && spawn.id, vs: Number(i.verticalSpeed || 0).toFixed(2), rw: i.onRunway ? 1 : 0 });
    });
    flight.on('crash', (i) => {
      const reason = (i && i.reason) || flight.crashReason || '';
      // w: warnings active at the impact, short codes (e.g. "le,pu" = low energy + pull up)
      const w = Object.entries(flight.warnings || {}).filter(([k, on]) => on && WARN_CODES[k]).map(([k]) => WARN_CODES[k]).join(',');
      trackEvent('crash', { ac: ac(), sp: spawn && spawn.id, r: explainCrash(reason, c.cat).code, d: reason.slice(0, 60), w });
      if (tut.active) trackEvent('tut', { ac: ac(), sc: scenario.id, st: tut.steps[tut.i].id, x: 'crash' });
    });
  }

  // ---------- context ----------
  function fillContext(f, info) {
    c.f = f;
    if (input && input.state) c.inp = input.state;
    c.view = (info && info.view) || 'exterior';
    const ias = Number.isFinite(f.ias) ? f.ias : (f.airspeed || 0);
    c.kt = Math.max(0, ias * KT);
    const v = f.velocity;
    const gs = v ? Math.hypot(v.x, v.z) : 0;
    c.gsKt = gs * KT;
    const h = (f.heading || 0) * Math.PI / 180;
    c.fwdKt = v ? (v.x * Math.sin(h) - v.z * Math.cos(h)) * KT : 0;
    c.lever = c.inp.throttle || 0;
    c.ab = !!(f.engines && f.engines[0] && f.engines[0].afterburner > 0.02);
    c.ap = !!(f.autopilot && f.autopilot.on);
    c.sinkFpm = -(f.verticalSpeed || 0) * 196.85;
    c.airborne = !f.onGround && f.agl > 3;
    c.turned = c.base.hdg0 == null ? 0 : Math.abs(wrap180((f.heading || 0) - c.base.hdg0));
    if (f.vSpeeds && f.vSpeeds.vr > 0) {
      c.vr = Math.round(f.vSpeeds.vr * KT);
      c.flapKt = Math.round((f.vSpeeds.vr * KT * 1.3) / 10) * 10;
    }
  }

  // ---------- visibility ----------
  function applyVisibility() {
    // cockpit view: the stack moves to the upper left (compact) so the instrument panel stays visible
    const cp = c.view === 'cockpit';
    if (cp !== cockpitOn) {
      cockpitOn = cp;
      toggle(root, 'gkt-cockpit', cp);
      if (stack.animate) stack.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      syncBottom();
    }
    const hide = paused || (shared.modalOpen || 0) > 0;
    if (hide !== hideOn) { hideOn = hide; toggle(root, 'gkt-hide', hide); }
    if (crashed !== crashOn) { crashOn = crashed; toggle(root, 'gkt-crash', crashed); }
    const showF1 = f1On && started && !tut.active && !key.active && !key.shrinking && !hudOff;
    if (showF1 !== f1.classList.contains('on')) toggle(f1, 'on', showF1);
  }

  window.addEventListener('gokyuzu:settings', (e) => {
    const on = !(e.detail && e.detail.tutorial === false);
    if (on === enabled) return;
    enabled = on;
    hints.setEnabled(on);
    if (!on) {
      if (tut.active && !tut.forced) { tut.active = false; card.classList.remove('on', 'ok', 'nudge'); }
      if (key.active) shrinkKeyCard();
      setF1(true);
    }
  });
  if (input && input.on) input.on('help', () => { if (key.active) shrinkKeyCard(); });

  const api = {
    begin({ flight, def: d, spawn: sp } = {}) {
      def = d || null; spawn = sp || null;
      const spec = (d && d.spec) || (flight && flight.spec) || {};
      c.spec = spec;
      c.cat = spec.category === 'fighter' || spec.category === 'helicopter' ? spec.category : 'airliner';
      c.detent = spec.category === 'fighter' && spec.abDetent ? spec.abDetent : c.cat === 'helicopter' ? 1 : 0.9;
      c.flap0 = (spec.flapDetents && spec.flapDetents[0] && spec.flapDetents[0].label) || '0';
      if (flight && flight.vSpeeds && flight.vSpeeds.vr > 0) c.vr = Math.round(flight.vSpeeds.vr * KT);
      else if (spec.vRotate) c.vr = Math.round(spec.vRotate * KT);
      bindFlight(flight);
      scenario = pickScenario(c.cat, sp, flight);
      tut.steps = scenario.steps;
      started = true;
      hints.begin(c.cat);
      hints.setEnabled(enabled);
      device = deviceKind();
      c.k = keySet(device, c.cat);
      shared.keyDevice = device;       // crash tips on the HUD use the same labels
      c.f = flight || null;
      const onFinal = !!(sp && sp.altitude != null && c.cat === 'airliner' && flight && flight.gearHandleDown);
      if (enabled && !tutorialStatus(c.cat)) { startTutorial(false); return true; }
      if (enabled) showKeyCard(); else setF1(true);
      if (hud) hud.showMessage(onFinal ? `Takım ve flaplar iniş konumunda · ${c.k.label('autopilot')}: otomatik ILS inişi` : 'İyi uçuşlar!', onFinal ? 4000 : 2000);
      return false;
    },

    update(dt, f, info) {
      if (!started || !f) return;
      paused = !!(info && info.paused);
      crashed = !!f.crashed;
      hudOff = !!(hud && hud.mode === 'off');
      fillContext(f, info);
      if ((devT -= dt) <= 0) {
        devT = 0.5;
        const d = deviceKind();
        if (d !== device) {
          device = d; c.k = keySet(d, c.cat); shared.keyDevice = d;
          if (tut.active && !tut.okT) renderStep(false);
          if (key.active) buildKeyCard();
        }
      }
      if (!paused && !crashed && !((shared.modalOpen || 0) > 0)) {
        if (tut.active) tickTutorial(dt);
        if (key.active && (key.t -= dt) <= 0) shrinkKeyCard();
        hints.update(dt, c);
      } else hints.update(0, null);
      applyVisibility();
    },

    /** The flight was reset to its spawn (R, crash, "Eğitimi yeniden başlat"): a running tutorial starts over. */
    reset() {
      hints.reset();
      c.ev.takeoff = false; c.ev.touchdown = false;
      if (tut.active && tut.okT === 0 && !tut.steps[tut.i].final) enterStep(0);
      else if (tut.active && tut.okT > 0 && !(tut.i + 1 < tut.steps.length && tut.steps[tut.i + 1].final)) enterStep(0);
    },

    /** "Eğitimi yeniden başlat": back to the spawn and the first step, even when finished, skipped or switched off. */
    restart() {
      if (!started) return;
      trackEvent('tut', { ac: def && def.id, sc: scenario && scenario.id, st: 'restart' });
      if (restart) restart();
      scenario = pickScenario(c.cat, spawn, flightRef);
      tut.steps = scenario.steps;
      startTutorial(true);
    },

    get tutorialActive() { return tut.active; },

    debug() {
      const st = tut.active ? tut.steps[tut.i] : null;
      return {
        enabled, device, category: c.cat, scenario: scenario && scenario.id,
        tutorial: tut.active ? {
          step: st.id, index: tut.i + 1, total: tut.steps.length, phase: tut.phase, nudged: tut.nudged, ok: tut.okT > 0,
          title: titleEl.textContent, text: textEl.textContent,
          chips: chipKeys ? [...chipKeys.querySelectorAll('kbd')].map((x) => x.textContent) : [],
          inline: [...textEl.querySelectorAll('kbd')].map((x) => x.textContent),
          meter: meterEl.classList.contains('on') ? meterVal.textContent : null,
        } : null,
        keyCard: key.active ? [...kcGrid.querySelectorAll('.gkt-kc-cell')].map((x) => x.textContent) : null,
        f1: f1.classList.contains('on'),
        hint: hints.current(),
        status: storageGet(DONE_KEY),
      };
    },
  };
  // the F1 help overlay offers "Eğitimi yeniden başlat" (src/ui/hud.js)
  if (hud && hud.setTutorialRestart) hud.setTutorialRestart(() => api.restart());
  return api;
}
