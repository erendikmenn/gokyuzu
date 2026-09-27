// Assisted flight ("Destekli uçuş", src/flight/assist.js) on the screen, and the link between the player's setting and
// the flight model's layer.
//
//   const ah = createAssistHud({ hud, input })   // created by the onboarding (src/ui/tutorial.js)
//   ah.attach(flight, def)                       // per flight model: flight.setAssist(wanted), events → messages
//   ah.update(dt, flight, info)                  // every frame: cue, approach panel, path, button (DOM only on change)
//   ah.reset()                                   // the flight was reset (R, crash)
//   ah.on                                        // the layer is active (telemetry `as`)
//   ah.requestApproach()                         // "İnişe geç" (button)
//   assistWanted(settings, mission)              // the setting and the mission → on / off (main.js `fly` event)
//   createAssistOffFlow({ patch, track, now })   // the chip's two-step off switch (pure; tests/assist.test.mjs)
//
// Setting semantics (src/core/settings.js `assist`, owned by the settings module): on unless the player turned it off.
// The one write here is the chip's off switch ("DESTEKLİ UÇUŞ" ✕ → "Destekli uçuşu kapat?" → Kapat), which does what
// Ayarlar → Destekli uçuş → Kapalı does: patchSettings({ assist: false }) (the `set` beacon follows from
// src/ui/settings-live.js) and the flight hands over through the same settings event. Nothing ever writes true: only the
// player, in Ayarlar, turns it back on; the tutorial, the progression and missions only read it. A mission that is flown
// by hand (catalog `manual: true`) suspends the layer for its duration without touching the setting (no chip then), and
// its briefing says so (src/ui/missions-hud.js, ASSIST_MANUAL_NOTE).
// Guidance: a cue pill for the next step (throttle, rotation, gear), the approach panel (runway, distance, a direction
// arrow, the glide-path dot, "sola / sağa · yüksek / alçak", auto thrust), the approach path drawn as gates in the sky,
// a short line when a protection acts, and the "İNİŞE GEÇ" button. Desktop: under the heading tape; touch: bottom
// centre between the stick and the buttons. While the assist flies, a "DESTEKLİ UÇUŞ" chip at the top (desktop: right of
// the heading tape / cockpit strip; touch: in the top row between the button groups, under the heading tape) shows it is
// on and turns it off in two steps. After a few assisted landings one dismissible tip points at the chip (once per
// browser).
import * as THREE from 'three';
import { injectCSS, BASE_CSS } from './styles.js';
import { el, richText, clamp, storageGet, storageSet, fmtDist, KT } from './util.js';
import { keySet } from './tutorial-keys.js';
import { shared } from './shared.js';
import { AIRPORTS } from './data.js';
import { loadSettings, storedSettings, patchSettings } from '../core/settings.js';
import { trackEvent, setEventExtras } from '../core/telemetry.js';
import { assistWanted } from '../flight/assist.js';
import { resultOpen } from '../retention/result-flag.js';   // <html class="gk-result-open">

const STATS_KEY = 'gokyuzu.assist';          // { landed: successful assisted landings, tip: 1 once the tip was shown }
const TIP_AFTER = 3;
export const ASSIST_MANUAL_NOTE = 'Destekli uçuş bu görevde kapalı: görev elle uçulur. Ayarın değişmez, görevden sonra yine açık.';

export { assistWanted };

/**
 * The chip's off switch, in two steps so a brush does not cost a beginner the assist: tap() asks ("Destekli uçuşu
 * kapat?"); confirm() within the question (not in its first `guard` s: a double tap is not a yes) writes the setting
 * off once, patch({ assist: false }) — never anything else, never true; cancel(via) ("Vazgeç", a second tap on the chip,
 * the chip hidden) and the `timeout` keep it. track(data) → telemetry `assist`: st = chip · off (via chip) · keep (via
 * cancel / tap / timeout / hide). now() in seconds. state: 'idle' | 'ask' | 'done' (off; reset() when the player turns
 * the assist back on in Ayarlar).
 */
export function createAssistOffFlow({ patch, track = () => {}, now = () => performance.now() / 1000, timeout = 4, guard = 0.3 } = {}) {
  let state = 'idle', askAt = 0;
  const flow = {
    get state() { return state; },
    /** Seconds left of the question (0 when not asking). */
    get left() { return state === 'ask' ? Math.max(0, timeout - (now() - askAt)) : 0; },
    tap() {
      if (state === 'idle') { state = 'ask'; askAt = now(); track({ st: 'chip' }); return true; }
      if (state === 'ask') flow.cancel('tap');
      return false;
    },
    confirm() {
      if (state !== 'ask' || now() - askAt < guard) return false;
      state = 'done';
      track({ st: 'off', via: 'chip' });
      patch({ assist: false });
      return true;
    },
    cancel(via = 'cancel') {
      if (state !== 'ask') return false;
      state = 'idle';
      track({ st: 'keep', via });
      return true;
    },
    /** Every frame: the question runs out after `timeout` s. true when it just did. */
    tick() {
      if (state === 'ask' && now() - askAt >= timeout) { state = 'idle'; track({ st: 'keep', via: 'timeout' }); return true; }
      return false;
    },
    reset() { state = 'idle'; },
  };
  return flow;
}
/** The mission being flown (src/missions/runtime.js via the test hook), or null. */
function currentMission() {
  const g = globalThis.__game;
  return (g && g.mission && g.mission.mission) || null;
}

const CSS = `
.gka { position: absolute; inset: 0; pointer-events: none; font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; --as: 1; }
.gka-col { position: absolute; left: 50%; top: max(calc(58px * var(--as)), calc(50% - 310px * var(--as))); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
  gap: calc(6px * var(--as)); max-width: calc(100vw - 32px); }
html.gk-touch .gka-col { top: auto; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); flex-direction: column-reverse; }
.gka-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .78), rgba(6, 11, 20, .74)); border: 1px solid rgba(255, 255, 255, .13);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .06); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
html.gk-noblur .gka-glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(8, 14, 24, .86); }
.gka-row { display: flex; align-items: center; gap: calc(8px * var(--as)); }
.gka-cue { display: none; align-items: center; gap: 8px; padding: calc(5px * var(--as)) calc(14px * var(--as)) calc(5px * var(--as)) calc(8px * var(--as));
  border-radius: 999px; font-size: calc(13.5px * var(--as)); font-weight: 650; line-height: 1.3; border-color: rgba(92, 242, 200, .4); }
.gka-cue.on { display: flex; animation: gka-in .3s cubic-bezier(.2, .9, .3, 1.2) both; }
.gka-cue b { font-size: calc(10px * var(--as)); font-weight: 750; letter-spacing: .14em; color: var(--gk-teal); padding: 2px 6px; border-radius: 6px; background: rgba(92, 242, 200, .12); }
.gka-cue kbd.gk-ikbd { font-size: calc(11.5px * var(--as)); }
@keyframes gka-in { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: none; } }
.gka-btn { display: none; pointer-events: auto; cursor: pointer; border-radius: 999px; padding: calc(6px * var(--as)) calc(14px * var(--as));
  font: 750 calc(12.5px * var(--as)) var(--gk-sans); letter-spacing: .08em; color: #04140f; background: var(--gk-teal); border: 0;
  box-shadow: 0 6px 18px rgba(92, 242, 200, .28); white-space: nowrap; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.gka-btn.on { display: inline-flex; align-items: center; gap: 6px; }
.gka-btn.ghost { color: var(--gk-fg); background: rgba(255, 255, 255, .1); box-shadow: none; border: 1px solid rgba(255, 255, 255, .2); }
.gka-btn.pulse { animation: gka-pulse 1.3s ease-in-out infinite; }
@keyframes gka-pulse { 0%, 100% { box-shadow: 0 6px 18px rgba(92, 242, 200, .28); } 50% { box-shadow: 0 0 0 6px rgba(92, 242, 200, .25), 0 6px 22px rgba(92, 242, 200, .5); } }
.gka-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
html.gk-touch .gka-btn { min-height: 40px; padding: 8px 18px; font-size: 13.5px; }
html.gk-touch .gka-cue { max-width: 44vw; font-size: 12.5px; }
html.gk-touch .gka-app { max-width: 64vw; }
html.gk-touch .gka-txt { min-width: 0; }
html.gk-touch .gka-t2, html.gk-touch .gka-t3 { overflow: hidden; text-overflow: ellipsis; }
.gka-app { display: none; align-items: center; gap: calc(10px * var(--as)); padding: calc(6px * var(--as)) calc(12px * var(--as)); border-radius: calc(14px * var(--as)); }
.gka-app.on { display: flex; }
.gka-arrow { width: calc(34px * var(--as)); height: calc(34px * var(--as)); flex: 0 0 auto; }
.gka-arrow path { fill: var(--gk-teal); transition: fill .2s ease; }
.gka-arrow.turn path { fill: var(--gk-caution); }
.gka-txt { display: flex; flex-direction: column; gap: 1px; min-width: calc(128px * var(--as)); }
.gka-t1 { font-size: calc(10px * var(--as)); font-weight: 750; letter-spacing: .14em; color: var(--gk-dim); white-space: nowrap; }
.gka-t2 { font-size: calc(14.5px * var(--as)); font-weight: 750; white-space: nowrap; }
.gka-t3 { font: 600 calc(11.5px * var(--as)) var(--gk-mono); color: var(--gk-dim); white-space: nowrap; }
.gka-gs { position: relative; width: calc(10px * var(--as)); height: calc(40px * var(--as)); border-radius: 5px; background: rgba(255, 255, 255, .08); flex: 0 0 auto; }
.gka-gs::before { content: ''; position: absolute; left: -3px; right: -3px; top: 50%; height: 2px; margin-top: -1px; background: var(--gk-teal); border-radius: 1px; }
.gka-gs i { position: absolute; left: 50%; top: 50%; width: calc(10px * var(--as)); height: calc(10px * var(--as)); margin: calc(-5px * var(--as)) 0 0 calc(-5px * var(--as));
  border-radius: 50%; background: #fff; box-shadow: 0 0 6px rgba(0, 0, 0, .5); transition: transform .12s linear; }
.gka-x { pointer-events: auto; cursor: pointer; border: 0; background: rgba(255, 255, 255, .08); color: var(--gk-dim); width: calc(24px * var(--as)); height: calc(24px * var(--as));
  border-radius: 7px; font: 700 calc(12px * var(--as)) var(--gk-sans); flex: 0 0 auto; }
html.gk-touch .gka-x { width: 32px; height: 32px; }
.gka-at { font: 700 calc(10px * var(--as)) var(--gk-sans); letter-spacing: .1em; color: var(--gk-teal); border: 1px solid rgba(92, 242, 200, .4); padding: 1px 5px; border-radius: 5px; white-space: nowrap; }
.gka-prot { display: none; font-size: calc(12px * var(--as)); font-weight: 650; color: var(--gk-caution); padding: 2px 10px; border-radius: 999px; background: rgba(12, 16, 24, .55); }
.gka-prot.on { display: block; }
.gka-tip { display: none; position: absolute; left: calc(16px * var(--as)); bottom: calc(206px * var(--as)); align-items: center; gap: 10px;
  padding: calc(7px * var(--as)) calc(8px * var(--as)) calc(7px * var(--as)) calc(14px * var(--as)); border-radius: 16px;
  max-width: min(calc(100vw - 32px), calc(400px * var(--as))); font-size: calc(13px * var(--as)); line-height: 1.4; border-color: rgba(92, 242, 200, .35); }
html.gk-touch .gka-tip { left: 0; right: 0; margin: 0 auto; width: max-content; bottom: calc(62px + env(safe-area-inset-bottom, 0px));
  max-width: min(50vw, 420px); font-size: 12px; }
.gka-tip.on { display: flex; pointer-events: auto; animation: gka-in .35s ease both; }
.gka-path { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.gka-path path { fill: none; stroke: rgba(92, 242, 200, .85); stroke-width: 2; stroke-linejoin: round; filter: drop-shadow(0 0 2px rgba(0, 0, 0, .6)); }
.gka.gka-hide .gka-col, .gka.gka-hide .gka-path, .gka.gka-hide .gka-tip, .gka.gka-hide .gka-chip { visibility: hidden; }
/* "DESTEKLİ UÇUŞ" chip: on while the assist flies; ✕ → the question → Kapat / Vazgeç */
.gka-chip { position: absolute; left: 0; top: 0; display: none; align-items: center; pointer-events: auto; border-radius: 999px;
  border-color: rgba(92, 242, 200, .38); font: 750 calc(11px * var(--as)) var(--gk-sans); letter-spacing: .1em; white-space: nowrap; color: var(--gk-fg); }
.gka-chip.on { display: flex; }
html:not(.gk-touch) .gka-chip { left: calc(50% + max(214px * var(--ps, 1), 172px * var(--s, 1)) + 10px); top: calc(10px * var(--ps, 1)); }
.gka-chip button { font: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.gka-chip button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gka-chip-main { display: flex; align-items: center; gap: calc(7px * var(--as)); background: none; border: 0; border-radius: 999px;
  padding: calc(4px * var(--as)) calc(5px * var(--as)) calc(4px * var(--as)) calc(10px * var(--as)); }
.gka-chip-dot { width: calc(7px * var(--as)); height: calc(7px * var(--as)); border-radius: 50%; background: var(--gk-teal); box-shadow: 0 0 7px rgba(92, 242, 200, .85); flex: 0 0 auto; }
.gka-chip-x { display: inline-flex; align-items: center; justify-content: center; width: calc(18px * var(--as)); height: calc(18px * var(--as)); border-radius: 50%;
  background: rgba(255, 255, 255, .1); color: var(--gk-dim); font-size: calc(10px * var(--as)); letter-spacing: 0; flex: 0 0 auto; }
.gka-chip-main:hover .gka-chip-x { background: rgba(255, 255, 255, .2); color: var(--gk-fg); }
.gka-chip-ask { display: none; position: relative; align-items: center; gap: calc(6px * var(--as)); letter-spacing: 0; font-weight: 650; font-size: calc(12.5px * var(--as));
  padding: calc(3px * var(--as)) calc(4px * var(--as)) calc(3px * var(--as)) calc(12px * var(--as)); }
.gka-chip.ask .gka-chip-ask { display: flex; }
html:not(.gk-touch) .gka-chip.ask .gka-chip-main { display: none; }
.gka-chip-yes, .gka-chip-no { border-radius: 999px; padding: calc(3px * var(--as)) calc(11px * var(--as)); font-weight: 750 !important; }
.gka-chip-yes { background: var(--gk-caution); color: #1a1204 !important; border: 0; }
.gka-chip-no { background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .22); }
.gka-chip-bar { position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; border-radius: 1px; background: rgba(92, 242, 200, .75); transform-origin: 0 50%; }
.gka-chip.ask .gka-chip-bar { animation: gka-timer 4s linear forwards; }
@keyframes gka-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
/* the tip points here: the chip glows while it shows */
.gka-chip.hint { animation: gka-hint 1.4s ease-in-out infinite; }
@keyframes gka-hint { 0%, 100% { box-shadow: 0 10px 28px rgba(0, 0, 0, .3), 0 0 0 0 rgba(92, 242, 200, 0); }
  50% { box-shadow: 0 10px 28px rgba(0, 0, 0, .3), 0 0 0 5px rgba(92, 242, 200, .35), 0 0 18px rgba(92, 242, 200, .55); } }
html.gk-calm .gka-chip.hint { animation: none; box-shadow: 0 0 0 2px rgba(92, 242, 200, .7); }
/* touch: a thumb-sized chip in the top row, the question as a small card under it */
html.gk-touch .gka-chip { font-size: 11px; }
html.gk-touch .gka-chip-main { min-height: 24px; padding: 2px 4px 2px 11px; gap: 7px; }
html.gk-touch .gka-chip-dot { width: 7px; height: 7px; }
html.gk-touch .gka-chip-x { width: 19px; height: 19px; font-size: 10px; }
html.gk-touch .gka-chip-ask { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); flex-wrap: wrap; justify-content: center;
  width: max-content; max-width: min(300px, calc(100vw - 24px)); padding: 9px 12px 11px; gap: 8px; border-radius: 14px; font-size: 13.5px;
  background: linear-gradient(180deg, rgba(16, 26, 42, .94), rgba(6, 11, 20, .92)); border: 1px solid rgba(255, 255, 255, .16); box-shadow: 0 10px 28px rgba(0, 0, 0, .35); }
html.gk-touch .gka-chip-q { flex: 0 0 100%; text-align: center; }
html.gk-touch .gka-chip-yes, html.gk-touch .gka-chip-no { min-height: 36px; min-width: 88px; padding: 6px 16px; font-size: 13.5px; }
`;

const ARROW = '<svg class="gka-arrow" viewBox="-20 -20 40 40" aria-hidden="true"><path d="M0 -15 L11 1 L4 1 L4 14 L-4 14 L-4 1 L-11 1 Z"/></svg>';
const CUES = {
  thr: (k) => (k.touch ? 'Kalkış: gaz sürgüsünü biraz yukarı it, gerisini destek yapar' : `Kalkış: ${k.chip('thrUp')} ile gazı biraz artır, gerisini destek yapar`),
  rotate: (k) => (k.touch ? 'Burnu kaldır: çubuğu geri çekip tut' : `Burnu kaldır: ${k.chip('pitchUp')} basılı tut`),
  gearUp: (k) => (k.touch ? 'Tırmanıyorsun: TAKIM ile iniş takımını topla' : `Tırmanıyorsun: ${k.chip('gear')} ile iniş takımını topla`),
  approach: () => 'İnmek istediğinde: İNİŞE GEÇ',
  lift: (k) => (k.touch ? 'Kalkış: kolektif sürgüsünü biraz yukarı it' : `Kalkış: ${k.chip('thrUp')} ile kolektifi biraz artır`),
};
const PROT = {
  stall: 'Destek: hız düşük, burun indiriliyor', overspeed: 'Destek: hız çok yüksek', pullUp: 'Destek: yere yaklaşıyorsun, tırmanılıyor',
  terrain: 'Destek: yere yaklaşıyorsun', sink: 'Destek: alçalma yavaşlatılıyor', bank: 'Destek: yatış sınırında', pitch: 'Destek: burun açısı sınırında',
};
const MESSAGES = {
  takeoffPower: (e, heli) => (heli ? 'Destek: kolektif kaldırılıyor' : 'Destek: kalkış gücü verildi'),
  rotate: () => 'Pist bitiyor: destek burnu kaldırdı',
  power: () => 'Hız düştü: destek gaz verdi, burnu indiriyor',
  overspeed: () => 'Aşırı hız: destek gazı azalttı',
  pullUp: () => 'Yere ya da bir engele yaklaşıyorsun: destek tırmanıyor',
  gear: (e) => (e.down ? 'Destek: iniş takımı indirildi' : 'Destek: iniş takımı toplandı'),
  // (flap and speedbrake steps: the HUD's own readouts show them; a toast for each would crowd the approach)
  atOff: () => 'Otomatik gaz kapandı: gaz sende',
  noRunway: (e) => (e.why === 'ground' ? 'Önce kalk: İNİŞE GEÇ havada çalışır' : 'Yakında inilebilecek bir pist yok'),
  goAround: () => 'Yaklaşma düzgün değil: pas geçiliyor, yeniden yaklaşılacak',
  hover: () => 'Havada asılı kalıyor: çubukla yavaşça hareket et, kolektifle yüksel / alçal',
  forward: () => 'İleri uçuş: askıda tutma kapandı',
  water: () => 'Altında su var: inmek için karaya ya da bir piste git',
  obstacle: () => 'Altında bina var: inmek için açık bir alana ya da bir piste git',
};

// what the tip must never sit on: a result view (src/retention/result-flag.js: the free-flight result, its compact card on
// phones, a mission result card), the landing card, a mission card (briefing) and the open free-flight panel
const RESULT_SEL = '.gkls-card.on, .gkq-back.on, .gkf.open, .gkf-note.on';
function resultOnScreen() {
  if (typeof document === 'undefined') return false;
  return resultOpen() || !!document.querySelector(RESULT_SEL);
}

/** "KSFO 28R" → "SFO 28R", "KNGZ 24" → "Alameda 24", "LTFM 35R" → "IST 35R" (the map's airport table). */
function rwLabel(name) {
  const [icao, ident] = String(name || '').split(' ');
  const a = AIRPORTS[icao];
  return `${a ? (a.short || a.code) : icao.replace(/^K/, '')} ${ident || ''}`.trim();
}

export function createAssistHud({ hud = null, input = null } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('assist', CSS);
  const root = el('div', 'gka');
  root.setAttribute('lang', 'tr');
  if (hud && hud.mountLayer) hud.mountLayer(root); else document.body.appendChild(root);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'gka-path');
  svg.setAttribute('aria-hidden', 'true');
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.appendChild(pathEl);
  root.appendChild(svg);
  const col = el('div', 'gka-col', root);
  // approach panel
  const app = el('div', 'gka-app gka-glass', col);
  app.setAttribute('role', 'status');
  app.insertAdjacentHTML('beforeend', ARROW);
  const arrow = app.lastElementChild;
  const gs = el('div', 'gka-gs', app);
  const gsDot = el('i', null, gs);
  const txt = el('div', 'gka-txt', app);
  const t1 = el('div', 'gka-t1', txt, '');
  const t2 = el('div', 'gka-t2', txt, '');
  const t3 = el('div', 'gka-t3', txt, '');
  const atTag = el('span', 'gka-at', app, 'OTO GAZ');
  const xBtn = el('button', 'gka-x', app, '✕');
  xBtn.type = 'button'; xBtn.title = 'İnişi bırak'; xBtn.setAttribute('aria-label', 'İnişi bırak');
  // cue + button row
  const row = el('div', 'gka-row', col);
  const cue = el('div', 'gka-cue gka-glass', row);
  cue.setAttribute('role', 'status');
  el('b', null, cue, 'DESTEK');
  const cueTxt = el('span', null, cue);
  const btn = el('button', 'gka-btn', row, 'İNİŞE GEÇ');
  btn.type = 'button'; btn.title = 'Destekli iniş: en yakın uygun piste yaklaş';
  const prot = el('div', 'gka-prot', col, '');
  const tip = el('div', 'gka-tip gka-glass', root);
  const tipTxt = el('span', null, tip, '');
  const tipX = el('button', 'gka-x', tip, '✕');
  tipX.type = 'button'; tipX.setAttribute('aria-label', 'Kapat');
  // "DESTEKLİ UÇUŞ" chip (on while the assist flies) and its question
  const chip = el('div', 'gka-chip gka-glass', root);
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', 'Destekli uçuş');
  const chipMain = el('button', 'gka-chip-main', chip);
  chipMain.type = 'button';
  el('i', 'gka-chip-dot', chipMain);
  el('span', 'gka-chip-lbl', chipMain, 'DESTEKLİ UÇUŞ');
  el('span', 'gka-chip-x', chipMain, '✕').setAttribute('aria-hidden', 'true');
  const ask = el('div', 'gka-chip-ask', chip);
  ask.setAttribute('role', 'alertdialog');
  el('span', 'gka-chip-q', ask, 'Destekli uçuşu kapat?');
  const yesBtn = el('button', 'gka-chip-yes', ask, 'Kapat');
  const noBtn = el('button', 'gka-chip-no', ask, 'Vazgeç');
  yesBtn.type = 'button'; noBtn.type = 'button';
  const askBar = el('i', 'gka-chip-bar', ask);

  let flightRef = null, def = null, wanted = true, settings = null, heli = false;
  let lastCue = null, lastProt = null, lastDot = null, lastRot = null, lastTurn = null, lastAt = null, appCueT = 0, pathT = 0;
  let tipPending = false, tipCheckT = 0, startT = 0;
  let appOn = false, btnOn = false, btnPulse = false, tipOn = false, tipT = 0, hideOn = false, pathOn = false;
  let tdAt = -1, tdOk = false, now = 0, device = 'kb', k = keySet('kb');
  const stats = Object.assign({ landed: 0, tip: 0 }, storageGet(STATS_KEY) || {});
  let chipOn = false, chipAsk = false, chipHint = false, offByChip = false, placeT = 0, placeKey = '', lastView = '';
  const flow = createAssistOffFlow({ patch: (p) => patchSettings(p), track: (d) => trackEvent('assist', { ...d, ac: def && def.id }) });
  // (a tip earned in an earlier visit but not shown yet waits for this flight's start)
  const toggle = (node, cls, on) => node.classList.toggle(cls, on);
  const flight = () => flightRef;
  const assist = () => (flightRef && flightRef.assist) || null;
  // telemetry `as` on the page's `fly` and `end` beacons (when src/core/telemetry.js applies event extras to them; the
  // outcome events take it from src/ui/tutorial.js): 1 = assisted flight on, 0 = off (setting or a manual mission)
  setEventExtras('fly', () => ({ as: assistWanted(storedSettings(), currentMission()) ? 1 : 0 }));
  setEventExtras('end', () => (flightRef ? { as: flightRef.assist && flightRef.assist.on ? 1 : 0 } : null));

  function layout() {
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
    root.style.setProperty('--as', clamp(Math.min(vh / 900, vw / 1400), 0.86, 1.5).toFixed(3));
  }
  layout();
  window.addEventListener('resize', layout);

  /** On / off from the setting and the mission (never writes the setting). */
  function apply(s) {
    settings = s || settings || loadSettings();
    const want = assistWanted(settings, currentMission());
    const f = flight();
    const was = !!(f && f.assist && f.assist.on);
    wanted = want;
    if (f && f.setAssist) f.setAssist(want);
    if (settings.assist !== false && flow.state === 'done') flow.reset();   // the player turned it back on in Ayarlar
    if (f && was !== want && hud && hud.showMessage && f.assist) {
      if (offByChip && !want) hud.showMessage('Destekli uçuş kapatıldı · Ayarlar’dan tekrar açabilirsin', 3600);
      else hud.showMessage(want ? 'Destekli uçuş açık' : 'Destekli uçuş kapalı: uçak tamamen sende', 2200);
    }
    offByChip = false;
  }
  window.addEventListener('gokyuzu:settings', (e) => apply(e.detail));

  function requestApproach() {
    const a = assist();
    if (!a || !a.on) return false;
    const ok = a.requestApproach();
    if (ok) trackEvent('assist', { st: 'app', ac: def && def.id, via: 'button' });
    return ok;
  }
  btn.addEventListener('click', (e) => { e.preventDefault(); btn.blur(); requestApproach(); });
  xBtn.addEventListener('click', (e) => { e.preventDefault(); xBtn.blur(); const a = assist(); if (a) a.cancelApproach(); });
  tipX.addEventListener('click', (e) => { e.preventDefault(); tipX.blur(); tipOn = false; tip.classList.remove('on'); });
  chipMain.addEventListener('click', (e) => { e.preventDefault(); chipMain.blur(); flow.tap(); syncChip(); });
  noBtn.addEventListener('click', (e) => { e.preventDefault(); noBtn.blur(); flow.cancel('cancel'); syncChip(); });
  yesBtn.addEventListener('click', (e) => {
    e.preventDefault(); yesBtn.blur();
    if (flow.state !== 'ask') return;
    offByChip = true;                   // (apply() shows the chip's own message)
    if (!flow.confirm()) offByChip = false;
    syncChip();
  });
  /** Chip classes from the flow (the question, its timer bar restarted each time it opens). */
  function syncChip() {
    const asking = flow.state === 'ask';
    if (asking === chipAsk) return;
    chipAsk = asking;
    if (asking) { askBar.style.animation = 'none'; void askBar.offsetWidth; askBar.style.animation = ''; }
    toggle(chip, 'ask', asking);
    chipMain.setAttribute('aria-expanded', String(asking));
  }
  chipMain.title = 'Destekli uçuş açık · kapatmak için tıkla';
  chipMain.setAttribute('aria-label', 'Destekli uçuş açık. Kapatmak için dokun');

  // touch: the chip sits in the top row between the button groups (under the heading tape in the chase views), clear of
  // the buttons, the GÖREV tab and what starts below the row (tutorial card, mission strip, toasts); measured when the
  // layout may have changed (resize, view, every 2 s), not every frame. Desktop: CSS (right of the tape / cockpit strip).
  const shown = (e) => {
    if (!e || !e.getClientRects().length) return false;
    if (e.checkVisibility) return e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    for (let n = e; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.display === 'none') return false; }
    return true;
  };
  function placeChip() {
    const touchUI = document.documentElement.classList.contains('gk-touch');
    if (!touchUI) {
      if (placeKey) { placeKey = ''; chip.style.left = ''; chip.style.top = ''; chip.style.maxWidth = ''; }
      return;
    }
    const W = window.innerWidth;
    let lo = 0, hi = W, rowTop = 8, rowBot = 0;
    for (const b of document.querySelectorAll('.gkx-btn, .gkf-tab')) {
      const r = b.getBoundingClientRect();
      if (!r.width || r.top > 40 || !shown(b)) continue;   // the top row only
      rowTop = Math.min(rowTop, r.top); rowBot = Math.max(rowBot, r.bottom);
      if (r.left + r.width / 2 < W / 2) lo = Math.max(lo, r.right); else hi = Math.min(hi, r.left);
    }
    if (!rowBot) rowBot = 52;
    const cw = chip.offsetWidth || 150, ch = chip.offsetHeight || 28;
    const below = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gkx-top')) || rowBot + 8;   // cards start here
    const tapes = document.querySelectorAll('.gkh-tape'), tape = tapes[2];
    let top = rowTop + (rowBot - rowTop - ch) / 2;
    // (under the tape, below its airport / waypoint bug labels: ≈ 10 px)
    if (tape && shown(tape)) { const tr = tape.getBoundingClientRect(); if (tr.width && tr.bottom < rowBot) top = tr.bottom + 11; }
    top = Math.max(2, Math.min(top, below - 2 - ch));
    let left = W / 2 - cw / 2;
    if (left < lo + 6) left = lo + 6;
    if (left + cw > hi - 6) left = Math.max(lo + 6, hi - 6 - cw);
    const key = `${Math.round(left)},${Math.round(top)},${Math.round(hi - lo)}`;
    if (key === placeKey) return;
    placeKey = key;
    chip.style.left = `${Math.round(left)}px`; chip.style.top = `${Math.round(top)}px`;
    chip.style.maxWidth = `${Math.max(120, Math.round(hi - lo - 12))}px`;
  }
  window.addEventListener('resize', () => { placeT = 0; });
  // keep the keyboard for flying: the buttons never keep the focus
  root.addEventListener('pointerup', () => { if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur(); });

  function onAssistEvent(e) {
    if (!e || !hud || !hud.showMessage) return;
    if (e.type === 'approach') {
      if (e.off) hud.showMessage('Destekli iniş bırakıldı', 1500);
      else if (e.runway) {
        hud.showMessage(`İnişe geçiliyor: ${rwLabel(e.runway)} · ${device === 'touch' ? 'okları izle ya da çubuğu bırak' : 'okları izle ya da tuşları bırak'}`, 3200);
        if (e.via === 'gear') trackEvent('assist', { st: 'app', ac: def && def.id, via: 'gear' });
      } else hud.showMessage(e.via === 'lever' ? 'Destek: yere iniliyor' : 'Destek: yavaşlanıyor, sonra dikey iniş', 2600);
      return;
    }
    const m = MESSAGES[e.type];
    if (m) hud.showMessage(m(e, heli), e.type === 'hover' || e.type === 'water' || e.type === 'obstacle' ? 3500 : 2200);
  }

  function attach(f, d) {
    if (d) def = d;   // (the per-frame update may attach the flight before the onboarding hands over its definition)
    if (!f || !f.on || f === flightRef) { apply(); return; }
    flightRef = f; def = d || def;
    startT = 20;   // a new flight: a waiting tip may show in its first seconds
    heli = !!(f.spec && f.spec.category === 'helicopter');
    f.on('assist', onAssistEvent);
    // successful assisted landings (on a runway, no crash 3 s later) → the "you can turn it off" tip after a few
    f.on('touchdown', (i) => {
      if (!i || f.crashed || !(f.assist && f.assist.on)) return;
      tdAt = now; tdOk = heli ? !i.water : !!i.onRunway;
    });
    f.on('crash', () => { tdAt = -1; });
    apply();
  }

  function setText(node, value, key) {
    if (value === key.v) return;
    key.v = value;
    node.textContent = value;
  }
  const c1 = { v: null }, c2 = { v: null }, c3 = { v: null };

  // ---- approach path: gates on the glide path, projected every frame (no allocation)
  const P = new THREE.Vector3();
  const pts = new Float32Array(40);
  function drawPath(a, f) {
    const cam = shared.camera;
    const rw = a && a.rw;
    if (!cam || !rw || a.stage !== 'final' || f.onGround) { if (pathOn) { pathOn = false; pathEl.setAttribute('d', ''); } return; }
    const W = window.innerWidth, H = window.innerHeight;
    const from = Math.min(Math.max(a.along - 300, 0), 9000);
    let d = '', n = 0;
    for (let s = from; s >= 0 && n < 18; s -= 500) {
      const along = s + 300;                                  // metres before the aim point
      const x = rw.aimX - rw.dx * along, z = rw.aimZ - rw.dz * along;
      const y = rw.elevation + along * Math.tan(3 * Math.PI / 180);
      // a gate: 60 m wide, 30 m tall, square to the final
      const hw = 30, hh = 15;
      let seg = '', ok = true;
      for (let c = 0; c < 5; c++) {
        const sx = c === 1 || c === 2 ? 1 : -1, sy = c === 2 || c === 3 ? 1 : -1;
        P.set(x + -rw.dz * hw * sx, y + hh * sy, z + rw.dx * hw * sx).project(cam);
        if (P.z > 1 || P.z < -1) { ok = false; break; }
        pts[c * 2] = (P.x * 0.5 + 0.5) * W; pts[c * 2 + 1] = (-P.y * 0.5 + 0.5) * H;
      }
      if (!ok) continue;
      for (let c = 0; c < 5; c++) seg += `${c ? 'L' : 'M'}${pts[c * 2].toFixed(0)} ${pts[c * 2 + 1].toFixed(0)}`;
      d += seg;
      n++;
    }
    pathOn = !!d;
    pathEl.setAttribute('d', d);
  }

  function update(dt, f, info = {}) {
    if (!f) return;
    if (f !== flightRef) attach(f, def);
    now += dt;
    const a = f.assist, on = !!(a && a.on);
    const paused = !!info.paused;
    const hide = paused || f.crashed || (shared.modalOpen || 0) > 0 || shared.mapOpen || !!info.hidden;
    if (hide !== hideOn) { hideOn = hide; toggle(root, 'gka-hide', hide); }
    const d = input && input.gamepadConnected ? 'pad' : input && input.touchMode ? 'touch' : 'kb';
    if (d !== device) { device = d; lastCue = null; }
    k = keySet(device, heli ? 'helicopter' : f.spec && f.spec.category === 'fighter' ? 'fighter' : 'airliner');
    // successful assisted landing → count; after a few the tip, once, but only when nothing else is on screen: at the
    // next stop on the ground or the next flight start, never over a result panel or the landing card
    if (tdAt >= 0 && now - tdAt > 3) {
      if (tdOk && !f.crashed) { stats.landed++; storageSet(STATS_KEY, stats); }
      tdAt = -1;
    }
    if (startT > 0) startT -= dt;
    tipPending = !stats.tip && stats.landed >= TIP_AFTER && on;
    if (tipPending && !tipOn && !info.tutorial && (tipCheckT -= dt) <= 0) {
      tipCheckT = 0.5;
      const stopped = f.onGround && Math.hypot(f.velocity.x, f.velocity.z) < 2;
      if ((stopped || startT > 0) && !f.crashed && !resultOnScreen() && chipOn) {
        stats.tip = 1; storageSet(STATS_KEY, stats);
        tipTxt.textContent = `İnişlerin çok iyi! Kendin uçmak istersen üstteki “Destekli uçuş” düğmesine ${device === 'touch' ? 'dokun' : 'tıkla'}. Ayarlar’dan da kapatabilirsin.`;
        tipOn = true; tipT = 14; tip.classList.add('on');
        trackEvent('assist', { st: 'tip', lc: stats.landed });   // (lc: assisted landings so far; `n` is a reserved key)
      }
    }
    if (tipOn) {   // (a result panel opening meanwhile closes it: the tip has been seen)
      tipT -= dt;
      if ((tipCheckT -= dt) <= 0) { tipCheckT = 0.5; if (resultOnScreen()) tipT = 0; }
      if (tipT <= 0 || !on) { tipOn = false; tip.classList.remove('on'); }
    }
    // ---- "DESTEKLİ UÇUŞ" chip: while the assist flies and the layer shows
    const showChip = on && !hide;
    if (showChip !== chipOn) { chipOn = showChip; toggle(chip, 'on', showChip); placeT = 0; }
    if (!showChip && flow.state === 'ask') flow.cancel(on ? 'hide' : 'off');
    flow.tick();
    syncChip();
    const hint = tipOn && showChip;
    if (hint !== chipHint) { chipHint = hint; toggle(chip, 'hint', hint); }
    if (showChip) {
      const view = info.view || '';
      if (view !== lastView) { lastView = view; placeT = 0; }
      if ((placeT -= dt) <= 0) { placeT = 2; placeChip(); }
    }
    if (!on) {
      if (appOn) { appOn = false; app.classList.remove('on'); }
      if (btnOn) { btnOn = false; btn.classList.remove('on'); }
      if (lastCue !== '') { lastCue = ''; cue.classList.remove('on'); }
      if (lastProt !== '') { lastProt = ''; prot.classList.remove('on'); }
      if (pathOn) { pathOn = false; pathEl.setAttribute('d', ''); }
      return;
    }
    if (hide) return;
    const ap = a.app;
    // ---- cue (quiet while the tutorial card shows the same step, and during an approach)
    let cueId = ap ? '' : a.cue || '';
    if (info.tutorialStep && (cueId === 'thr' || cueId === 'rotate' || cueId === 'gearUp' || cueId === 'lift')) cueId = '';
    // "İnmek istediğinde: İNİŞE GEÇ": shown for a few seconds once per flight, then the button alone
    if (cueId === 'approach') { appCueT += dt; if (appCueT > 9 || info.tutorialStep) cueId = ''; }
    if (cueId !== lastCue) {
      lastCue = cueId;
      if (cueId && CUES[cueId]) { richText(cueTxt, CUES[cueId](k)); cue.classList.add('on'); } else cue.classList.remove('on');
    }
    // ---- protection line
    const pr = a.prot && PROT[a.prot] ? PROT[a.prot] : '';
    if (pr !== lastProt) { lastProt = pr; prot.textContent = pr; toggle(prot, 'on', !!pr); }
    // ---- "İNİŞE GEÇ" button: airborne, no approach, not the autopilot
    // (helicopter: also over the hover hold, which the assisted landing uses itself)
    const showBtn = !ap && !f.crashed && (heli ? !f.onGround && f.agl > 3 : !f.onGround && f.agl > 15 && !(f.autopilot && f.autopilot.on));
    if (showBtn !== btnOn) { btnOn = showBtn; toggle(btn, 'on', showBtn); }
    const pulse = showBtn && (info.tutorialStep === 'app' || lastCue === 'approach');
    if (pulse !== btnPulse) { btnPulse = pulse; toggle(btn, 'pulse', pulse); }
    // ---- approach panel
    const showApp = !!ap && ap.stage !== 'rollout';
    if (showApp !== appOn) { appOn = showApp; toggle(app, 'on', showApp); }
    if (showApp) {
      if (heli) {
        setText(t1, 'DESTEKLİ İNİŞ', c1);
        setText(t2, ap.water ? 'Altında su var' : ap.blocked ? 'Altında bina var' : ap.stage === 'descend' ? 'Dikey iniş' : 'Yavaşlanıyor', c2);
        setText(t3, `${Math.round(f.agl * 3.28084 / 10) * 10} ft`, c3);
        if (lastDot !== 0) { lastDot = 0; gsDot.style.transform = 'translateY(0px)'; }
        if (lastRot !== 0) { lastRot = 0; arrow.style.transform = 'rotate(180deg)'; }
      } else {
        setText(t1, `İNİŞ · ${rwLabel(ap.name)}`, c1);
        const side = ap.dir < 0 ? 'Sola dön' : ap.dir > 0 ? 'Sağa dön' : 'Hizadasın';
        const vert = ap.glide > 0 ? 'yüksek' : ap.glide < 0 ? 'alçak' : 'süzülüşte';
        const t2v = ap.stage === 'final' ? `${side} · ${vert}` : ap.stage === 'out' ? 'Piste hizalanmak için dönüyor' : `${side} · piste hizalan`;
        setText(t2, t2v, c2);
        setText(t3, `${fmtDist(ap.dist)} · ${Math.round(f.ias * KT)} kt${a.at && a.at.on ? ` / ${Math.round(a.at.tgt * KT)}` : ''}`, c3);
        // arrow: the commanded track relative to the present one (up = straight ahead)
        const vx = f.velocity.x, vz = f.velocity.z;
        const track = Math.hypot(vx, vz) > 20 ? Math.atan2(vx, -vz) : (f.heading || 0) * Math.PI / 180;
        let rel = ((ap.trackCmd - track) * 180 / Math.PI) % 360; if (rel > 180) rel -= 360; if (rel < -180) rel += 360;
        const rot = Math.round(clamp(rel, -120, 120) / 3) * 3;
        if (rot !== lastRot) { lastRot = rot; arrow.style.transform = `rotate(${rot}deg)`; }
        const turn = Math.abs(rel) > 25;
        if (turn !== lastTurn) { lastTurn = turn; toggle(arrow, 'turn', turn); }
        // glide-path dot: above the centre line when the aircraft is high (±60 m full scale)
        const dot = Math.round(clamp(-ap.vert / 60, -1, 1) * 15);
        if (dot !== lastDot) { lastDot = dot; gsDot.style.transform = `translateY(${dot}px)`; }
      }
      const atOn = !!(a.at && a.at.on);
      if (atOn !== lastAt) { lastAt = atOn; atTag.style.display = atOn ? '' : 'none'; }
    }
    // (phones: at most 20 times a second; elsewhere every frame, the gates stay glued to the scene)
    if (!heli && ((pathT -= dt) <= 0 || !showApp)) { pathT = device === 'touch' ? 0.05 : 0; drawPath(showApp ? ap : null, f); }
  }

  return {
    attach, update, requestApproach,
    reset() { tdAt = -1; lastCue = null; appCueT = 0; },
    get on() { const a = assist(); return !!(a && a.on); },
    get wanted() { return wanted; },
    debug() {
      const a = assist();
      return {
        wanted, on: !!(a && a.on), phase: a ? a.phase : null, cue: lastCue, prot: lastProt, button: btnOn, approach: appOn ? { t1: c1.v, t2: c2.v, t3: c3.v, stage: a.app && a.app.stage } : null,
        path: pathOn, tip: tipOn, stats: { ...stats },
        chip: chipOn ? { ask: flow.state === 'ask', hint: chipHint, text: tip.classList.contains('on') ? tipTxt.textContent : null } : null,
      };
    },
  };
}
