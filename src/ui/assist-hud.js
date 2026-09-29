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
//   createAssistChipFlow({ patch, track, now }) // the chip's switch: off in two steps, on in one (pure; tests/assist.test.mjs)
//
// Setting semantics (src/core/settings.js `assist`, owned by the settings module): on unless the player turned it off.
// Only the player changes it: in Ayarlar → Destekli uçuş, or with the "DESTEKLİ UÇUŞ" chip on the flight screen, which
// does the same as that switch through patchSettings (the `set` beacon follows from src/ui/settings-live.js, the open
// settings panel shows the change, the flight switches through the settings event): on → "Destekli uçuşu kapat?" →
// Kapat writes false; off → one tap writes true. Those two writes are the only ones here, and true only on a real tap
// (e.isTrusted): nothing turns it on by itself — the tutorial, the progression, missions, the callouts and updates only
// read it. A mission flown by hand (catalog `manual: true`) suspends the layer for its duration without touching the
// setting (no chip then), and its briefing says so (src/ui/missions-hud.js, ASSIST_MANUAL_NOTE).
// Guidance: a cue pill for the next step (throttle, rotation, gear), the approach panel (runway, distance, a direction
// arrow, the glide-path dot, "sola / sağa · yüksek / alçak", auto thrust), the approach path drawn as gates in the sky,
// a short line when a protection acts, and the "İNİŞE GEÇ" button. Desktop: under the heading tape; touch: bottom
// centre between the stick and the buttons. The chip sits at the top in every flight but a hand-flown mission
// (desktop: right of the heading tape / cockpit strip; touch: in the top row between the button groups, under the
// heading tape): "DESTEKLİ UÇUŞ" with a green dot and ✕ while on, dimmed "DESTEKLİ UÇUŞ · KAPALI" while off. Callouts
// point at it (a bubble under it, never over a toast, a card or a result): at the start of the first flights, once
// after two crashes with the assist off (a suggestion only), and after a few assisted landings one dismissible tip (once
// per browser).
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

// { landed: successful assisted landings, tip: 1 once the tip was shown, hs: start callouts shown (one per flight, the
// first START_CALLS flights), hc: 1 once the suggestion after crashes was shown }
const STATS_KEY = 'gokyuzu.assist';
const TIP_AFTER = 3;
const START_CALLS = 3, START_CALL_S = 5, CRASH_CALL_AFTER = 2, CRASH_CALL_S = 7;
export const ASSIST_MANUAL_NOTE = 'Destekli uçuş bu görevde kapalı: görev elle uçulur. Ayarın değişmez, görevden sonra yine açık.';

export { assistWanted };

/**
 * The chip's switch. On → off in two steps, so a brush on a final does not cost a beginner the assist: tap(true) asks
 * ("Destekli uçuşu kapat?"); confirm() within the question (not in its first `guard` s: a double tap is not a yes)
 * writes patch({ assist: false }); cancel(via) ("Vazgeç", a second tap on the chip, the chip hidden) and the `timeout`
 * keep it. Off → on in one tap: tap(false) writes patch({ assist: true }). These are the only writes, one per player
 * action; a tap within `settle` s of the chip's last change is ignored (a double click on "Kapat" does not undo it).
 * `on` is the setting as the chip shows it. track(data) → telemetry `assist`: st = chip · off (via chip) · keep (via
 * cancel / tap / timeout / hide / off) · on (via chip). now() in seconds. state: 'idle' | 'ask'.
 * tap() returns 'ask' | 'keep' | 'on' | '' (ignored).
 */
export function createAssistChipFlow({ patch, track = () => {}, now = () => performance.now() / 1000, timeout = 4, guard = 0.3, settle = 0.8 } = {}) {
  let state = 'idle', askAt = 0, changedAt = -Infinity;
  const flow = {
    get state() { return state; },
    /** Seconds left of the question (0 when not asking). */
    get left() { return state === 'ask' ? Math.max(0, timeout - (now() - askAt)) : 0; },
    tap(on) {
      if (state === 'ask') { flow.cancel('tap'); return 'keep'; }
      if (now() - changedAt < settle) return '';
      if (!on) {
        changedAt = now();
        track({ st: 'on', via: 'chip' });
        patch({ assist: true });
        return 'on';
      }
      state = 'ask'; askAt = now();
      track({ st: 'chip' });
      return 'ask';
    },
    confirm() {
      if (state !== 'ask' || now() - askAt < guard) return false;
      state = 'idle'; changedAt = now();
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
html.gk-touch .gka-tip { left: var(--gkx-mid-x, 50%); translate: -50% 0; width: max-content; bottom: calc(62px + env(safe-area-inset-bottom, 0px));
  max-width: min(calc(var(--gkx-mid-w, 50vw) - 24px), 420px); font-size: 12px; }
.gka-tip.on { display: flex; pointer-events: auto; animation: gka-in .35s ease both; }
.gka-tip.meas { display: flex; visibility: hidden; }
.gka-path { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.gka-path path { fill: none; stroke: rgba(92, 242, 200, .85); stroke-width: 2; stroke-linejoin: round; filter: drop-shadow(0 0 2px rgba(0, 0, 0, .6)); }
.gka.gka-hide .gka-col, .gka.gka-hide .gka-path, .gka.gka-hide .gka-tip, .gka.gka-hide .gka-chip, .gka.gka-hide .gka-call { visibility: hidden; }
/* "DESTEKLİ UÇUŞ" chip: on → ✕ → the question → Kapat / Vazgeç; off (dimmed, "KAPALI") → one tap turns it on */
.gka-chip { position: absolute; left: 0; top: 0; display: none; align-items: center; pointer-events: auto; border-radius: 999px;
  border-color: rgba(92, 242, 200, .38); font: 750 calc(11px * var(--as)) var(--gk-sans); letter-spacing: .1em; white-space: nowrap; color: var(--gk-fg); }
.gka-chip.show { display: flex; }
html:not(.gk-touch) .gka-chip { left: calc(50% + max(214px * var(--ps, 1), 172px * var(--s, 1)) + 10px); top: calc(10px * var(--ps, 1)); }
.gka-chip button { font: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.gka-chip button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gka-chip-main { display: flex; align-items: center; gap: calc(7px * var(--as)); background: none; border: 0; border-radius: 999px;
  padding: calc(4px * var(--as)) calc(5px * var(--as)) calc(4px * var(--as)) calc(10px * var(--as)); }
.gka-chip-dot { width: calc(7px * var(--as)); height: calc(7px * var(--as)); border-radius: 50%; background: var(--gk-teal); box-shadow: 0 0 7px rgba(92, 242, 200, .85); flex: 0 0 auto; }
.gka-chip-x { display: inline-flex; align-items: center; justify-content: center; width: calc(18px * var(--as)); height: calc(18px * var(--as)); border-radius: 50%;
  background: rgba(255, 255, 255, .1); color: var(--gk-dim); font-size: calc(10px * var(--as)); letter-spacing: 0; flex: 0 0 auto; }
.gka-chip-st { display: none; align-items: center; padding: calc(1px * var(--as)) calc(7px * var(--as)); border-radius: 999px; border: 1px solid rgba(255, 255, 255, .24);
  font-size: calc(9.5px * var(--as)); letter-spacing: .12em; color: var(--gk-dim); flex: 0 0 auto; }
.gka-chip.off { border-color: rgba(255, 255, 255, .15); color: var(--gk-dim); background: linear-gradient(180deg, rgba(16, 26, 42, .6), rgba(6, 11, 20, .56)); box-shadow: 0 6px 18px rgba(0, 0, 0, .22); }
.gka-chip.off .gka-chip-dot { background: transparent; box-shadow: inset 0 0 0 calc(1.5px * var(--as)) rgba(255, 255, 255, .5); }
.gka-chip.off .gka-chip-x { display: none; }
.gka-chip.off .gka-chip-st { display: inline-flex; }
.gka-chip.off .gka-chip-main { padding-right: calc(5px * var(--as)); }
@media (hover: hover) {   /* (a touch screen keeps :hover after a tap: the chip would look on right after Kapat) */
  .gka-chip-main:hover .gka-chip-x { background: rgba(255, 255, 255, .2); color: var(--gk-fg); }
  .gka-chip.off:hover { color: var(--gk-fg); border-color: rgba(92, 242, 200, .38); }
  .gka-chip.off:hover .gka-chip-st { color: var(--gk-teal); border-color: rgba(92, 242, 200, .45); }
}
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
.gka-chip.off.hint { color: var(--gk-fg); border-color: rgba(92, 242, 200, .45); }
/* a callout under the chip, its caret pointing at it (placed and kept clear of toasts / cards / results in JS) */
.gka-call { position: absolute; left: 0; top: 0; display: none; align-items: center; box-sizing: border-box; max-width: min(calc(100vw - 24px), calc(320px * var(--as)));
  padding: calc(7px * var(--as)) calc(13px * var(--as)); border-radius: calc(12px * var(--as)); border-color: rgba(92, 242, 200, .4);
  font-size: calc(12.5px * var(--as)); font-weight: 650; line-height: 1.35; text-align: center; text-wrap: balance; pointer-events: none; visibility: hidden; }
.gka-call::before { content: ''; position: absolute; left: var(--cx, 50%); top: calc(-6px * var(--as)); width: calc(10px * var(--as)); height: calc(10px * var(--as));
  margin-left: calc(-5px * var(--as)); transform: rotate(45deg); background: rgba(16, 26, 42, .9); border-left: 1px solid rgba(92, 242, 200, .4); border-top: 1px solid rgba(92, 242, 200, .4); }
html.gk-noblur .gka-call::before { background: rgba(8, 14, 24, .86); }
.gka-call.on { display: flex; }
.gka-call.on.vis { visibility: visible; animation: gka-in .3s ease both; }
html.gk-touch .gka-call { font-size: 12px; max-width: min(calc(100vw - 24px), 300px); padding: 6px 12px; }
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
  // "DESTEKLİ UÇUŞ" chip (every flight but a hand-flown mission; on / off), its question, the callouts pointing at it
  const chip = el('div', 'gka-chip gka-glass', root);
  chip.setAttribute('role', 'group');
  chip.setAttribute('aria-label', 'Destekli uçuş');
  const chipMain = el('button', 'gka-chip-main', chip);
  chipMain.type = 'button';
  el('i', 'gka-chip-dot', chipMain);
  el('span', 'gka-chip-lbl', chipMain, 'DESTEKLİ UÇUŞ');
  el('span', 'gka-chip-x', chipMain, '✕').setAttribute('aria-hidden', 'true');
  el('span', 'gka-chip-st', chipMain, 'KAPALI').setAttribute('aria-hidden', 'true');
  const ask = el('div', 'gka-chip-ask', chip);
  ask.setAttribute('role', 'alertdialog');
  el('span', 'gka-chip-q', ask, 'Destekli uçuşu kapat?');
  const yesBtn = el('button', 'gka-chip-yes', ask, 'Kapat');
  const noBtn = el('button', 'gka-chip-no', ask, 'Vazgeç');
  yesBtn.type = 'button'; noBtn.type = 'button';
  const askBar = el('i', 'gka-chip-bar', ask);
  const call = el('div', 'gka-call gka-glass', root);
  call.setAttribute('role', 'status');

  let flightRef = null, def = null, wanted = true, settings = null, heli = false;
  let lastCue = null, lastProt = null, lastDot = null, lastRot = null, lastTurn = null, lastAt = null, appCueT = 0, pathT = 0;
  let tipPending = false, tipCheckT = 0, startT = 0;
  let appOn = false, btnOn = false, btnPulse = false, tipOn = false, tipT = 0, hideOn = false, pathOn = false;
  let tdAt = -1, tdOk = false, now = 0, device = 'kb', k = keySet('kb');
  const stats = Object.assign({ landed: 0, tip: 0, hs: 0, hc: 0 }, storageGet(STATS_KEY) || {});
  let chipOn = false, chipOff = null, chipAsk = false, chipHint = false, byChip = false, placeT = 0, placeBurst = 0, placeKey = '', lastView = '', chipT = 0;
  // callouts: kind '' | 'start' | 'crash', seconds left on screen, seconds since it was due (gives up after CALL_WAIT)
  let callKind = '', callLeft = 0, callAge = 0, callVis = false, callSeen = false, callCheckT = 0, startCalled = false, crashes = 0, callStartT = 0;
  // (the start line waits for the flight's opening cards and toasts: the key card is up for 10 s on every start)
  const CALL_WAIT = 20, CALL_START_WINDOW = 30;
  const flow = createAssistChipFlow({ patch: (p) => patchSettings(p), track: (d) => trackEvent('assist', { ...d, ac: def && def.id }) });
  /** The player's setting (the chip shows it; a hand-flown mission hides the chip). */
  const settingOn = () => (settings || storedSettings()).assist !== false;
  const manualMission = () => { const m = currentMission(); return !!(m && m.manual); };
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
    if (f && was !== want && hud && hud.showMessage && f.assist) {
      const tap = device === 'touch' ? 'dokun' : 'tıkla';
      if (byChip && !want) hud.showMessage(`Destekli uçuş kapatıldı · açmak için tekrar ${tap}`, 3600);
      else if (byChip && want) hud.showMessage(`Destekli uçuş açıldı · kapatmak için tekrar ${tap}`, 3600);
      else hud.showMessage(want ? 'Destekli uçuş açık' : 'Destekli uçuş kapalı: uçak tamamen sende', 2200);
    }
    byChip = false;
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
  // the chip: on → the question; off → on at once, but only from the player's own tap (a script's click is not one)
  chipMain.addEventListener('click', (e) => {
    e.preventDefault(); chipMain.blur();
    if (!chipOn) return;
    const on = settingOn();
    if (!on && !e.isTrusted) return;
    byChip = !on;                       // (apply() shows the chip's own message)
    const r = flow.tap(on);
    byChip = false;
    if (r && callKind) endCall();   // (the player found it)
    syncChip();
  });
  noBtn.addEventListener('click', (e) => { e.preventDefault(); noBtn.blur(); flow.cancel('cancel'); syncChip(); });
  yesBtn.addEventListener('click', (e) => {
    e.preventDefault(); yesBtn.blur();
    if (flow.state !== 'ask') return;
    byChip = true;
    flow.confirm();
    byChip = false;
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
  /** The chip's look from the setting: on (green dot, ✕) or off (dimmed, KAPALI). */
  function chipState(on) {
    const off = !on;
    if (off === chipOff) return;
    chipOff = off;
    toggle(chip, 'off', off);
    chipMain.setAttribute('aria-pressed', String(on));
    chipMain.title = on ? 'Destekli uçuş açık · kapatmak için tıkla' : 'Destekli uçuş kapalı · açmak için tıkla';
    chipMain.setAttribute('aria-label', on ? 'Destekli uçuş açık. Kapatmak için dokun' : 'Destekli uçuş kapalı. Açmak için dokun');
    placeT = 0;   // (its width changed)
  }
  chipState(true);

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

  // ---- callouts under the chip, the caret pointing at it: shown only where they cover none of these (a toast, the
  // HUD's panels and warnings, the tutorial / key cards and hints, the mission strip and cards, the landing card, the
  // free-flight panels, the touch controls, this layer's own panel / button / tip) and while no result is open
  const CALL_CLEAR = '.gkh-toast, .gkh-panel, .gkh-tape, .gkh-warn > *, .gkh-info, .gkh-map, .gkh-sys, .gkh-chip, .gkc, .gkt-card, .gkt-kc, .gkt-hint, .gkt-f1, .gkq-strip, '
    + '.gkq-back, .gkls-card, .gkf-panel, .gkf-note, .gkf-tab, .gkx-btn, .gkx-thr, .gkx-ped, .gkx-stick, .gka-col > .on, .gka-tip.on';
  let callBlock = '', tipBlock = '';
  function placeCall() {
    const cr = chip.getBoundingClientRect();
    if (!cr.width) return false;
    const W = window.innerWidth, H = window.innerHeight;
    const cx = cr.left + cr.width / 2;
    const touchUI = document.documentElement.classList.contains('gk-touch');
    const els = [...document.querySelectorAll(CALL_CLEAR)].filter((e) => e !== call && shown(e));
    // an instrument right under the chip (the cockpit view's top strip on touch screens): below it, the caret still
    // pointing up at the chip; cards and toasts there are waited for instead
    let top = Math.round(cr.bottom + 9);
    for (const e of els) {
      if (!/\bgkh-(panel|tape)\b/.test(e.className)) continue;
      const q = e.getBoundingClientRect();
      if (q.width && q.left < cx + 60 && q.right > cx - 60 && q.top < top + 24 && q.bottom > top - 6) top = Math.max(top, Math.round(q.bottom + 9));
    }
    // the room beside the chip in the callout's band (desktop: the camera bar on the right; touch: the throttle and the
    // buttons): the bubble wraps into it rather than run over them
    let lo = 8, hi = W - 8;
    for (const e of els) {
      const q = e.getBoundingClientRect();
      if (!q.width || q.bottom <= top - 6 || q.top >= top + 64) continue;
      if (q.right <= cx) lo = Math.max(lo, q.right + 8); else if (q.left >= cx) hi = Math.min(hi, q.left - 8);
    }
    if (!touchUI) lo = Math.max(lo, Math.min(cr.left, cx - 20));   // (desktop: from the chip's left edge, the tape is left of it)
    const cap = Math.min(W - 24, touchUI ? 300 : 320 * (parseFloat(root.style.getPropertyValue('--as')) || 1));
    call.style.maxWidth = `${Math.round(clamp(hi - lo, 160, cap))}px`;
    const w = call.offsetWidth, h = call.offsetHeight;
    const left = Math.round(clamp(touchUI ? cx - w / 2 : cr.left, lo, Math.max(lo, hi - w)));
    call.style.left = `${left}px`; call.style.top = `${top}px`;
    call.style.setProperty('--cx', `${Math.round(clamp(cx - left, 14, w - 14))}px`);
    callBlock = top + h + 4 > H ? 'screen' : blockedBy(left - 4, top - 6, left + w + 4, top + h + 4, els);
    return !callBlock;
  }
  /** What a box (px) would cover: '' when nothing of CALL_CLEAR and no result is open, else its class. */
  function blockedBy(l, t, r, b, els = null) {
    if (resultOnScreen()) return 'result';
    for (const e of els || document.querySelectorAll(CALL_CLEAR)) {
      if (e === call || e === tip || !shown(e)) continue;
      const q = e.getBoundingClientRect();
      if (q.width && q.height && q.left < r && q.right > l && q.top < b && q.bottom > t) return String(e.className);
    }
    return '';
  }
  /** The tip where it would show is clear of everything above (measured invisible first). */
  function tipClear() {
    tip.classList.add('meas');
    const q = tip.getBoundingClientRect();
    tip.classList.remove('meas');
    tipBlock = q.width ? blockedBy(q.left - 4, q.top - 4, q.right + 4, q.bottom + 4) : 'size';
    return !tipBlock;
  }
  function openCall(kind, text, secs) {
    callKind = kind; callLeft = secs; callAge = 0; callVis = false; callSeen = false; callCheckT = 0;
    call.textContent = text;
    call.classList.add('on');   // (laid out but invisible until placed clear of everything)
  }
  function endCall() {
    if (callKind === 'start') startCalled = true;
    callKind = ''; callVis = false;
    call.classList.remove('on', 'vis');
  }
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
    startT = 20;   // a new flight: a waiting tip and the start callout may show in its first seconds
    startCalled = false; callStartT = CALL_START_WINDOW;
    if (callKind) endCall();
    heli = !!(f.spec && f.spec.category === 'helicopter');
    f.on('assist', onAssistEvent);
    // successful assisted landings (on a runway, no crash 3 s later) → the "you can turn it off" tip after a few
    f.on('touchdown', (i) => {
      if (!i || f.crashed || !(f.assist && f.assist.on)) return;
      tdAt = now; tdOk = heli ? !i.water : !!i.onRunway;
    });
    // crashes with the assist off (the setting, not a hand-flown mission) → the suggestion after CRASH_CALL_AFTER
    f.on('crash', () => { tdAt = -1; if (!settingOn() && !manualMission()) crashes++; });
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
    if (callStartT > 0) callStartT -= dt;
    tipPending = !stats.tip && stats.landed >= TIP_AFTER && on && !callKind;
    if (tipPending && !tipOn && !info.tutorial && (tipCheckT -= dt) <= 0) {
      tipCheckT = 0.5;
      const stopped = f.onGround && Math.hypot(f.velocity.x, f.velocity.z) < 2;
      tipTxt.textContent = `İnişlerin çok iyi! Kendin uçmak istersen üstteki “Destekli uçuş” düğmesine ${device === 'touch' ? 'dokun' : 'tıkla'}; istediğinde aynı düğmeyle yeniden açarsın. Ayarlar’dan da olur.`;
      if ((stopped || startT > 0) && !f.crashed && chipOn && tipClear()) {
        stats.tip = 1; storageSet(STATS_KEY, stats);
        tipOn = true; tipT = 14; tip.classList.add('on');
        trackEvent('assist', { st: 'tip', lc: stats.landed });   // (lc: assisted landings so far; `n` is a reserved key)
      }
    }
    if (tipOn) {   // (a result panel opening meanwhile closes it: the tip has been seen)
      tipT -= dt;
      if ((tipCheckT -= dt) <= 0) { tipCheckT = 0.5; if (resultOnScreen()) tipT = 0; }
      if (tipT <= 0 || !on) { tipOn = false; tip.classList.remove('on'); }
    }
    // ---- "DESTEKLİ UÇUŞ" chip: every flight but a hand-flown mission, while the layer shows; on or off per the setting
    const setOn = settingOn();
    const showChip = !hide && !manualMission();
    if (showChip !== chipOn) { chipOn = showChip; toggle(chip, 'show', showChip); placeT = 0; }
    chipState(setOn);
    if (flow.state === 'ask' && (!showChip || !setOn)) flow.cancel(setOn ? 'hide' : 'off');
    flow.tick();
    syncChip();
    if (showChip) {
      const view = info.view || '';
      // (a new view moves the instruments over a few frames: placed again soon after, then every 2 s)
      if (view !== lastView) { lastView = view; placeT = 0; placeBurst = 4; }
      if ((placeT -= dt) <= 0) { placeT = placeBurst > 0 ? 0.25 : 2; placeBurst--; placeChip(); }
    }
    // ---- callouts pointing at the chip (one at a time, not with the tip): the first flights' start line, and once
    // after crashes with the assist off a suggestion (it only suggests: the setting stays the player's)
    chipT = showChip ? chipT + dt : 0;
    if (!callKind && chipT > 1.5 && !tipOn && !chipAsk && (callCheckT -= dt) <= 0) {
      callCheckT = 0.5;
      if (!startCalled && callStartT > 0 && stats.hs < START_CALLS && !info.tutorial) {
        openCall('start', setOn ? 'Destekli uçuşu buradan açıp kapatabilirsin' : 'Zorlanırsan destekli uçuşu buradan açabilirsin', START_CALL_S);
      } else if (!setOn && crashes >= CRASH_CALL_AFTER && !stats.hc && !f.crashed) {
        openCall('crash', `Destekli uçuş kalkış ve inişte yardım eder, açmak için ${device === 'touch' ? 'dokun' : 'tıkla'}`, CRASH_CALL_S);
      }
    }
    if (callKind) {
      callAge += dt;
      const ok = showChip && !chipAsk && !tipOn && !f.crashed && !(callKind === 'crash' && setOn);
      if (!ok || (callCheckT -= dt) <= 0) {
        callCheckT = 0.25;
        const vis = ok && placeCall();
        if (vis !== callVis) {
          callVis = vis; toggle(call, 'vis', vis);
          if (vis && !callSeen) {   // first time on screen: counted once
            callSeen = true;
            if (callKind === 'start') { stats.hs++; startCalled = true; } else stats.hc = 1;
            storageSet(STATS_KEY, stats);
            trackEvent('assist', { st: 'hint', k: callKind, as: setOn ? 1 : 0, ac: def && def.id });
          }
        }
      }
      if (callVis) callLeft -= dt;
      // (gives up when it could not show in time: the start line within the flight's first CALL_START_WINDOW s, the
      // suggestion after CALL_WAIT s (and is due again); once seen, CALL_WAIT s for the rest of its time between toasts)
      const late = callSeen ? callAge > CALL_WAIT + callLeft : callKind === 'start' ? callStartT <= 0 : callAge > CALL_WAIT;
      if (callLeft <= 0 || (callKind === 'crash' && setOn) || late) endCall();
    }
    const hint = (tipOn || callVis) && showChip;
    if (hint !== chipHint) { chipHint = hint; toggle(chip, 'hint', hint); }
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
        path: pathOn, tip: tipOn, tipBlock, stats: { ...stats },
        chip: chipOn ? { state: chipOff ? 'off' : 'on', ask: flow.state === 'ask', hint: chipHint, text: tip.classList.contains('on') ? tipTxt.textContent : null } : null,
        call: callKind ? { kind: callKind, vis: callVis, text: call.textContent, left: +callLeft.toFixed(1), block: callBlock } : null, crashes,
      };
    },
  };
}
