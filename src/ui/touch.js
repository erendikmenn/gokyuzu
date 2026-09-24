// On-screen touch controls for phones and tablets (landscape), feeding the same input as the keyboard / gamepad
// (src/flight/input.js: input.touch axes, setTouchLever, trigger(action)).
//
//   Fixed wing   left thumb   floating stick (pitch + roll; dead zone, expo, springs back). No rudder pedals: in the air
//                             the fly-by-wire / yaw dampers coordinate the turns, on the ground the stick's sideways
//                             travel also steers the nose wheel ("auto rudder") — two thumbs are already busy with the
//                             stick and the lever, and a third control would be missed exactly on the takeoff roll.
//                right thumb  throttle slider that stays where it is left (relative drag, 1:1); fighters: the lever stops
//                             at MIL and passes into afterburner with a little extra push (and back); airliners: below
//                             IDLE on the ground is the reverse range (engages / stows the reversers).
//                buttons      FLAP ▲ / FLAP ▼, TAKIM, FREN (hold) next to the lever; AP, H.FREN top right;
//                             ❚❚, HARİTA, KAMERA, KOKPİT top left.
//   Helicopter   left stick = cyclic, right slider = collective (no spring, follows the hover-hold back-drive), a
//                spring-loaded PEDAL strip, HOVER (hover hold) and FREN.
//   Tilt         optional (Ayarlar): phone rotation / tilt added to the stick (src/ui/touch-tilt.js), "ORTALA" button.
// Touches in the middle of the screen still reach the canvas (camera look / orbit, double tap = centre) and two fingers
// there zoom. Portrait on a phone pauses the flight behind a "telefonu yan çevir" prompt; leaving the page pauses too.
// Layout: safe-area insets, sizes from the short screen side; the HUD's compact columns, the tutorial stack and the map
// are fitted around the controls (hud.setTouchLayout, CSS variables on <html class="gk-touch">).
//
//   createTouchControls(hudRoot, { input, hud, getState }) → { update(dt, flight, info), enable(), get active(), debug() }
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp } from './util.js';
import { shared } from './shared.js';
import { touchMode, isPhoneSize, mobileOS } from './touch-env.js';
import { getTilt } from './touch-tilt.js';
import { CAMERA_NAMES } from './camera-modes.js';
import { loadSettings } from '../core/settings.js';
import { trackEvent } from '../core/telemetry.js';

const STICK_DEAD = 0.07;
const GATE = 0.07;                 // slider travel (fraction of the track) to push through the MIL / IDLE gates
const REV_ZONE = 0.16;             // airliner slider: reverse range below IDLE (fraction of the track)
const MIL_POS = 0.75;              // fighter slider: MIL detent drawn at 75 % of the track (AB gets the top quarter)
const GATE_HOLD_MS = 400;          // a swipe arriving at MIL / IDLE stays there this long before it can push through

const ICON = {
  pause: '<path d="M8 5v14M16 5v14"/>',
  map: '<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  cockpit: '<path d="M3.2 15.5l2.6-7h12.4l2.6 7z"/><path d="M12 8.5v7M2.5 19h19"/>',
  gear: '<circle cx="12" cy="16" r="3.6"/><path d="M12 3v9.4M8 6.5h8"/>',
  flapUp: '<path d="M4 13h11l5-2"/><path d="M12 9l3-3 3 3"/>',
  flapDn: '<path d="M4 9h11l4 5"/><path d="M12 15l3 3 3-3"/>',
  brake: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.6"/><path d="M3 12h1.5M19.5 12H21"/>',
  speedbrake: '<path d="M3 15h18"/><path d="M8 15l4-7 4 7"/>',
  ap: '<circle cx="12" cy="12" r="8"/><path d="M4 12h5l3 4 3-4h5"/>',
  hover: '<path d="M3 7h18M12 7v4"/><path d="M7 14h10l-1.5 4h-7z"/><path d="M12 20.5v.5"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  tilt: '<rect x="6" y="3" width="12" height="18" rx="2.5" transform="rotate(-20 12 12)"/><path d="M11 18h2" transform="rotate(-20 12 12)"/>',
};
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const CSS = `
html.gk-touch, html.gk-touch body { overscroll-behavior: none; -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
html.gk-touch body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: none; }
html.gk-touch #app canvas { touch-action: none; }
.gkx { position: absolute; inset: 0; pointer-events: none; font-family: var(--gk-sans); color: var(--gk-fg); --u: 1; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; touch-action: none; transition: opacity .25s ease; }
.gkx * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.gkx.gkx-off { opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s; }
.gkx-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .58), rgba(6, 11, 20, .56)); border: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25), inset 0 1px 0 rgba(255, 255, 255, .07); -webkit-backdrop-filter: blur(10px) saturate(1.2); backdrop-filter: blur(10px) saturate(1.2); }

/* buttons */
.gkx-btn { position: absolute; pointer-events: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(1px * var(--u));
  width: var(--b); height: var(--b); padding: 0; border-radius: calc(14px * var(--u)); color: rgba(236, 244, 255, .92); cursor: pointer; touch-action: none;
  font: 750 calc(9.5px * var(--u)) var(--gk-sans); letter-spacing: .06em; transition: transform .08s ease, background .15s ease, border-color .15s ease, color .15s ease; }
.gkx-btn svg { width: calc(var(--b) * .42); height: calc(var(--b) * .42); flex: 0 0 auto; }
.gkx-btn span { line-height: 1; white-space: nowrap; }
.gkx-btn small { position: absolute; bottom: calc(3px * var(--u)); font: 700 calc(8px * var(--u)) var(--gk-mono); letter-spacing: 0; color: var(--gk-dim); white-space: nowrap; }
.gkx-btn.has-sub span { margin-bottom: calc(6px * var(--u)); }
.gkx-btn.down { transform: scale(.92); background: rgba(92, 242, 200, .22); border-color: rgba(92, 242, 200, .7); }
.gkx-btn.on { color: #4be37a; border-color: rgba(75, 227, 122, .75); box-shadow: 0 0 0 1px rgba(75, 227, 122, .25), 0 0 18px rgba(75, 227, 122, .22), inset 0 1px 0 rgba(255, 255, 255, .07); }
.gkx-btn.amber { color: var(--gk-caution); border-color: rgba(255, 176, 32, .75); }
.gkx-btn.hot { color: #ff9a55; border-color: rgba(255, 138, 61, .8); }
.gkx-btn i.led { position: absolute; top: calc(5px * var(--u)); right: calc(5px * var(--u)); width: calc(6px * var(--u)); height: calc(6px * var(--u)); border-radius: 50%; background: rgba(255, 255, 255, .16); }
.gkx-btn.on i.led { background: #4be37a; box-shadow: 0 0 6px #4be37a; }
.gkx-btn.amber i.led { background: var(--gk-caution); box-shadow: 0 0 6px var(--gk-caution); }
.gkx-btn.flash { animation: gkx-flash .9s ease-in-out infinite; }
@keyframes gkx-flash { 50% { border-color: rgba(92, 242, 200, .95); box-shadow: 0 0 0 2px rgba(92, 242, 200, .35), 0 0 22px rgba(92, 242, 200, .45); } }

/* stick */
.gkx-zone { position: absolute; pointer-events: auto; touch-action: none; }
.gkx-stick { position: absolute; left: 0; top: 0; width: calc(var(--R) * 2); height: calc(var(--R) * 2); margin: calc(var(--R) * -1) 0 0 calc(var(--R) * -1);
  border-radius: 50%; pointer-events: none; transition: opacity .25s ease; opacity: .55;
  background: radial-gradient(circle, rgba(6, 12, 22, .1) 0 55%, rgba(6, 12, 22, .32) 100%); border: 1.5px solid rgba(255, 255, 255, .28); }
.gkx-stick::before, .gkx-stick::after { content: ""; position: absolute; background: rgba(255, 255, 255, .16); }
.gkx-stick::before { left: 50%; top: 12%; bottom: 12%; width: 1px; }
.gkx-stick::after { top: 50%; left: 12%; right: 12%; height: 1px; }
.gkx-stick.live { opacity: 1; border-color: rgba(92, 242, 200, .55); transition: none; }
.gkx-stick b { position: absolute; left: 50%; top: 50%; width: calc(var(--K) * 2); height: calc(var(--K) * 2); margin: calc(var(--K) * -1) 0 0 calc(var(--K) * -1); border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, rgba(255, 255, 255, .95), rgba(200, 222, 240, .78) 60%, rgba(150, 180, 210, .7));
  box-shadow: 0 4px 14px rgba(0, 0, 0, .35); z-index: 1; transition: transform .16s cubic-bezier(.2, .9, .3, 1.3); }
.gkx-stick.live b { transition: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .35), 0 0 18px rgba(92, 242, 200, .45); }
.gkx-stick em { position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, -6px); font: 700 calc(9.5px * var(--u)) var(--gk-sans); font-style: normal; letter-spacing: .12em;
  color: rgba(236, 244, 255, .6); white-space: nowrap; text-shadow: 0 1px 3px rgba(0, 0, 0, .8); }
.gkx-stick.live em { display: none; }
.gkx-stick.flash { animation: gkx-flash .9s ease-in-out infinite; opacity: .9; }

/* throttle / collective slider */
.gkx-thr { position: absolute; pointer-events: auto; touch-action: none; border-radius: calc(18px * var(--u)); }
.gkx-track { position: absolute; left: 50%; top: calc(26px * var(--u)); bottom: calc(10px * var(--u)); width: calc(10px * var(--u)); margin-left: calc(-5px * var(--u)); border-radius: 6px;
  background: rgba(255, 255, 255, .1); overflow: hidden; }
.gkx-fill { position: absolute; left: 0; right: 0; bottom: 0; border-radius: 6px; background: linear-gradient(0deg, rgba(92, 242, 200, .35), rgba(92, 242, 200, .85)); }
.gkx-zab { position: absolute; left: 0; right: 0; top: 0; background: linear-gradient(0deg, rgba(255, 138, 61, .25), rgba(255, 138, 61, .6)); }
.gkx-zrev { position: absolute; left: 0; right: 0; bottom: 0; background: repeating-linear-gradient(135deg, rgba(255, 176, 32, .45) 0 4px, rgba(255, 176, 32, .12) 4px 8px); }
.gkx-mark { position: absolute; left: calc(5px * var(--u)); right: calc(5px * var(--u)); height: 0; border-top: 1.5px solid rgba(255, 255, 255, .45); pointer-events: none; }
.gkx-mark i { position: absolute; left: 0; bottom: 1px; font: 750 calc(7.5px * var(--u)) var(--gk-sans); font-style: normal; letter-spacing: 0;
  color: rgba(236, 244, 255, .78); white-space: nowrap; text-shadow: 0 1px 2px rgba(0, 0, 0, .9); }
.gkx-mark.low i { bottom: auto; top: 2px; }
.gkx-mark.mil { border-color: rgba(255, 170, 110, .9); }
.gkx-mark.mil i { color: #ffc7a1; }
.gkx-mark.idle { border-color: rgba(255, 196, 90, .9); }
.gkx-thr-h { position: absolute; left: calc(4px * var(--u)); right: calc(4px * var(--u)); height: calc(34px * var(--u)); margin-top: calc(-17px * var(--u)); border-radius: calc(10px * var(--u));
  display: flex; align-items: center; justify-content: center; font: 750 calc(12px * var(--u)) var(--gk-mono); letter-spacing: -.02em; color: #04140f;
  background: linear-gradient(180deg, #e9fff8, #9fe9d2); box-shadow: 0 4px 14px rgba(0, 0, 0, .4), inset 0 1px 0 rgba(255, 255, 255, .8); }
.gkx-thr-h::before, .gkx-thr-h::after { content: ""; position: absolute; left: 22%; right: 22%; height: 1px; background: rgba(4, 20, 15, .25); }
.gkx-thr-h::before { top: 5px; } .gkx-thr-h::after { bottom: 5px; }
.gkx-thr.ab .gkx-thr-h { background: linear-gradient(180deg, #ffe0c8, #ff9a55); color: #2a0e00; }
.gkx-thr.rev .gkx-thr-h { background: linear-gradient(180deg, #ffe7b8, #ffb020); color: #2a1a00; }
.gkx-thr.live .gkx-thr-h { box-shadow: 0 4px 14px rgba(0, 0, 0, .4), 0 0 0 2px rgba(255, 255, 255, .55); }
.gkx-thr-t { position: absolute; left: 0; right: 0; top: calc(6px * var(--u)); text-align: center; font: 800 calc(8.5px * var(--u)) var(--gk-sans); letter-spacing: .12em; color: var(--gk-dim); }
.gkx-thr.flash { animation: gkx-flash .9s ease-in-out infinite; }

/* pedal strip (helicopter) */
.gkx-ped { position: absolute; pointer-events: auto; touch-action: none; border-radius: calc(14px * var(--u)); }
.gkx-ped::before { content: ""; position: absolute; left: 50%; top: 22%; bottom: 22%; width: 1px; background: rgba(255, 255, 255, .3); }
.gkx-ped b { position: absolute; top: 50%; left: 50%; width: calc(40px * var(--u)); height: calc(30px * var(--u)); margin: calc(-15px * var(--u)) 0 0 calc(-20px * var(--u)); border-radius: calc(9px * var(--u));
  background: linear-gradient(180deg, #e9fff8, #9fe9d2); box-shadow: 0 3px 10px rgba(0, 0, 0, .35); transition: transform .16s cubic-bezier(.2, .9, .3, 1.3); }
.gkx-ped.live b { transition: none; }
.gkx-ped span { position: absolute; top: 50%; transform: translateY(-50%); font: 800 calc(9px * var(--u)) var(--gk-sans); letter-spacing: .1em; color: var(--gk-dim); pointer-events: none; }
.gkx-ped span.l { left: calc(10px * var(--u)); } .gkx-ped span.r { right: calc(10px * var(--u)); }
.gkx-ped.flash { animation: gkx-flash .9s ease-in-out infinite; }

/* portrait prompt */
.gkx-rot { position: fixed; inset: 0; z-index: 90; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px;
  text-align: center; pointer-events: auto; touch-action: none; font-family: var(--gk-sans); color: var(--gk-fg);
  background: radial-gradient(ellipse 90% 60% at 50% 40%, #16233d, #04070d); }
.gkx-rot.on { display: flex; }
.gkx-rot svg { width: 92px; height: 92px; color: var(--gk-teal); animation: gkx-rot 2.4s cubic-bezier(.6, 0, .3, 1) infinite; }
@keyframes gkx-rot { 0%, 20% { transform: rotate(0); } 55%, 80% { transform: rotate(-90deg); } 100% { transform: rotate(-90deg); opacity: 0; } }
.gkx-rot h2 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -.01em; }
.gkx-rot p { margin: 0; max-width: 300px; font-size: 14.5px; line-height: 1.5; color: rgba(226, 236, 250, .8); }

/* Android (Chromium): no backdrop blur over the live 3D view. Every blurred element (12 control buttons, the slider,
   the tapes, the autopilot strip…) costs the compositor an extra render pass of the screen area behind it, every
   frame: measured in Chromium at a phone's pixel ratio 3 and the 30 fps flight cap, the GPU process spends 150–180 ms
   of CPU per second with the blur and 55–65 without (M4 Max; several times that on a phone). The glass keeps its tint,
   a little denser. iOS / iPadOS keep the blur (WebKit hands it to the system compositor). */
html.gk-touch.gk-noblur * { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
html.gk-touch.gk-noblur .gkx-glass { background: linear-gradient(180deg, rgba(16, 26, 42, .7), rgba(6, 11, 20, .68)); }
html.gk-touch.gk-noblur .gkh-tape { background: linear-gradient(180deg, rgba(10, 18, 32, .5), rgba(4, 9, 18, .56)); }
html.gk-touch.gk-noblur .gkh.gkh-compact .gkh-tape { background: linear-gradient(180deg, rgba(10, 18, 32, .26), rgba(4, 9, 18, .34)); }
html.gk-touch.gk-noblur .gkh-panel { background: linear-gradient(180deg, rgba(16, 26, 42, .66), rgba(6, 11, 20, .64)); }
html.gk-touch.gk-noblur .gkn-win { background: rgba(7, 13, 24, .95); }

/* the rest of the game UI in touch mode */
html.gk-touch .gkh-map, html.gk-touch .gkh-sys, html.gk-touch .gkh-info, html.gk-touch .gkc, html.gk-touch .gkt-f1, html.gk-touch .gkh-pinfo, html.gk-touch .gkh-pbtn kbd { display: none !important; }
html.gk-touch .gkt-stack { left: var(--gkx-mid-x, 50%); bottom: var(--gkx-mid-b, 12px); max-width: var(--gkx-mid-w, calc(100vw - 32px)); }
html.gk-touch .gkt-card { width: min(calc(500px * var(--ts)), var(--gkx-mid-w, 100vw)); pointer-events: none; }
html.gk-touch .gkt-kc { min-width: 0; max-width: var(--gkx-mid-w, 100vw); pointer-events: none; }
html.gk-touch .gkt-kc-grid { grid-template-columns: repeat(2, auto); }
html.gk-touch .gkt-skip { pointer-events: auto; padding: 6px 6px; }
html.gk-touch .gkt-hint { max-width: var(--gkx-mid-w, 100vw); }
html.gk-touch .gkt.gkt-cockpit .gkt-stack { top: auto; bottom: var(--gkx-mid-b, 12px); left: var(--gkx-mid-x, 50%); transform: translateX(-50%); align-items: center; flex-direction: column; }
/* phones: tutorial / hints / key card as a banner at the top centre, HUD toasts and warnings below it */
html.gk-touch.gkx-phone .gkt-stack, html.gk-touch.gkx-phone .gkt.gkt-cockpit .gkt-stack { top: var(--gkx-top, 60px); bottom: auto; left: 50%;
  transform: translateX(-50%); flex-direction: column-reverse; align-items: center; max-width: var(--gkx-top-w, calc(100vw - 32px)); }
html.gk-touch.gkx-phone .gkt-card { width: min(calc(480px * var(--ts)), var(--gkx-top-w, 100vw)); }
html.gk-touch.gkx-phone .gkt-kc, html.gk-touch.gkx-phone .gkt-hint { max-width: var(--gkx-top-w, 100vw); }
html.gk-touch.gkx-phone .gkt-glass { background: linear-gradient(180deg, rgba(12, 20, 34, .72), rgba(5, 9, 16, .68)); }
html.gk-touch.gkx-phone .gkh-toast, html.gk-touch.gkx-phone .gkh-warn { translate: 0 var(--gk-top-stack, 0px); transition: opacity .45s ease, translate .25s ease; }
html.gk-touch.gkx-phone .gkh-toast { font-size: 17px; padding: 8px 18px; }
html.gk-touch.gkx-phone .gkt-chips { display: none; }
html.gk-touch.gkx-phone .gkt-card { padding: 8px 12px 10px; }
html.gk-touch.gkx-phone .gkt-body { margin-top: 4px; }
html.gk-touch.gkx-phone .gkt-title { font-size: 14.5px; }
html.gk-touch.gkx-phone .gkt-text { font-size: 12.5px; line-height: 1.4; }
html.gk-touch.gkx-phone .gkt-prog i { width: 10px; }
html.gk-touch .gkh-pause { gap: 12px; padding: 12px; }
html.gk-touch.gkx-phone .gkh-pt { font-size: 30px; }
html.gk-touch .gkh-pbtns { flex-wrap: wrap; justify-content: center; max-width: 560px; }
html.gk-touch .gkh-pbtn { min-height: 46px; touch-action: manipulation; }
html.gk-touch .gkh-help-card { box-sizing: border-box; max-height: calc(100dvh - 24px); padding: 18px 18px 14px; width: min(calc(100vw - 48px), 900px); }
html.gk-touch.gkx-phone .gkh-help-grid { column-gap: 18px; }
html.gk-touch.gkx-phone .gkh-hrow { font-size: 12.5px; padding: 5px 0; }
html.gk-touch.gkx-phone .gkh-help-tut { position: static; flex-direction: row; align-items: center; max-width: none; margin: 8px 0 4px; }
html.gk-touch .gkh-ccard { min-width: 0; width: min(86vw, calc(420px * var(--ps))); }
html.gk-touch .gkn-win { left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); top: max(6px, env(safe-area-inset-top)); bottom: max(6px, env(safe-area-inset-bottom)); border-radius: 14px; }
html.gk-touch .gkn-x kbd, html.gk-touch .gkn-hint span:last-child { display: none; }
html.gk-touch .gkn-x { min-height: 40px; }
html.gk-touch .gkn-ctl button { width: 42px; height: 42px; }
html.gk-touch.gkx-phone .gkn-head { min-height: 44px; padding: 5px 8px 5px 12px; gap: 10px; }
html.gk-touch.gkx-phone .gkn-title small, html.gk-touch.gkx-phone .gkn-hint { display: none; }
html.gk-touch.gkx-phone .gkn-strip > span { min-width: 0; padding: 2px 6px; }
html.gk-touch.gkx-phone .gkn-strip > span:nth-child(4) { display: none; }
html.gk-touch.gkx-phone .gkn-side { flex-basis: clamp(200px, 34vw, 280px); }
html.gk-touch .gkn-btn, html.gk-touch .gkn-step button { min-height: 34px; }
`;

const ROT_SVG = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="15" y="5" width="18" height="34" rx="3.5"/><path d="M22 34h4"/><path d="M38 20a14 14 0 0 1-4 12M36 33l-2.5-.8.6-2.6"/></svg>';

export function createTouchControls(hudRoot, { input, hud, getState = () => ({}) } = {}) {
  let active = false, built = false;
  const api = {
    get active() { return active; },
    enable() { if (!active) { active = true; build(); } },
    update() {},
    debug() { return { active }; },
  };
  if (touchMode()) api.enable();
  else if (typeof window !== 'undefined') {
    // hybrids (touch laptop / tablet with a keyboard): the controls appear with the first finger on the game
    const first = (e) => {
      if (e.pointerType !== 'touch' || !getState().flying) return;
      window.removeEventListener('pointerdown', first, true);
      api.enable();
    };
    window.addEventListener('pointerdown', first, true);
  }

  function build() {
    if (built) return;
    built = true;
    injectCSS('base', BASE_CSS);
    injectCSS('touch', CSS);
    const html = document.documentElement;
    html.classList.add('gk-touch');
    if (mobileOS() === 'android') html.classList.add('gk-noblur');   // (see the CSS: backdrop blur is a compositor pass per frame)
    shared.touchMode = true;
    if (input && input.setTouchMode) input.setTouchMode(true);
    // iOS Safari: no pinch / double-tap page zoom over the game
    for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('contextmenu', (e) => { if (!/INPUT|TEXTAREA/.test(e.target.tagName || '')) e.preventDefault(); });
    Object.assign(api, createControls(hudRoot, { input, hud, getState, api }));
  }
  return api;
}

function createControls(hudRoot, { input, hud, getState }) {
  const root = el('div', 'gkx');
  root.setAttribute('lang', 'tr');
  // under the onboarding cards, the map, toasts, help and pause (they cover the controls), above the instruments
  const before = hudRoot.querySelector('.gkt') || hudRoot.querySelector('.gkn') || null;
  if (before) hudRoot.insertBefore(root, before); else if (hud && hud.mountLayer) hud.mountLayer(root); else hudRoot.appendChild(root);
  const safeProbe = el('div', null, document.body);
  safeProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  const rot = el('div', 'gkx-rot', document.body);
  rot.innerHTML = ROT_SVG;
  el('h2', null, rot, 'Telefonu yan çevir');
  el('p', null, rot, 'Uçuş kontrolleri yatay ekranda: sol başparmak çubuk, sağ başparmak gaz. Uçuş bu sırada duraklatıldı.');

  const flightRef = { f: null, cat: 'airliner', det: null, hasRev: false };
  const vib = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ } };

  // ---------- generic button ----------
  const buttons = {};
  function button(id, icon, label, { onDown, onUp, title = label } = {}) {
    const b = el('button', 'gkx-btn gkx-glass', root);
    b.type = 'button';
    b.dataset.id = id;
    b.setAttribute('aria-label', title);
    if (icon) b.insertAdjacentHTML('beforeend', svg(ICON[icon]));
    const lab = label ? el('span', null, b, label) : null;
    el('i', 'led', b);
    const sub = el('small', null, b, '');
    let pid = null;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (pid != null) return;
      pid = e.pointerId;
      try { b.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      b.classList.add('down');
      vib(8);
      if (onDown) onDown();
    });
    const up = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      b.classList.remove('down');
      if (onUp) onUp();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });   // actions fire on pointerdown
    const o = { b, lab, sub, id, subText: '', cls: '', label, release() { if (pid != null) { pid = null; b.classList.remove('down'); if (onUp) onUp(); } } };
    buttons[id] = o;
    return o;
  }
  const act = (a) => () => input.trigger(a);
  const setSub = (o, t) => { if (o.subText !== t) { o.subText = t; o.sub.textContent = t; o.b.classList.toggle('has-sub', !!t); } };
  const setState = (o, cls) => { if (o.cls !== cls) { o.b.classList.remove('on', 'amber', 'hot'); if (cls) o.b.classList.add(cls); o.cls = cls; } };

  // top left: game / view
  const bPause = button('pause', 'pause', '', { onDown: act('pause'), title: 'Duraklat' });
  const bMap = button('map', 'map', 'HARİTA', { onDown: act('map') });
  const bCam = button('camera', 'camera', 'KAMERA', { onDown: act('camera') });
  const bView = button('view', 'cockpit', 'KOKPİT', { onDown: act('view') });
  const fsOk = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  const bFull = fsOk ? button('full', 'full', '', { onDown: () => enterFullscreen(), title: 'Tam ekran' }) : null;
  // systems
  const bAP = button('ap', 'ap', 'AP', { onDown: act('autopilot'), title: 'Otopilot' });
  const bSB = button('speedbrake', 'speedbrake', 'H.FREN', { onDown: act('speedbrake'), title: 'Hava freni' });
  const bFlUp = button('flapsUp', 'flapUp', 'FLAP ▲', { onDown: act('flapsUp'), title: 'Flap topla' });
  const bFlDn = button('flapsDown', 'flapDn', 'FLAP ▼', { onDown: act('flapsDown'), title: 'Flap indir' });
  const bGear = button('gear', 'gear', 'TAKIM', { onDown: act('gear'), title: 'İniş takımı' });
  const bBrake = button('brake', 'brake', 'FREN', { onDown: () => { input.touch.brake = 1; }, onUp: () => { input.touch.brake = 0; }, title: 'Tekerlek freni' });
  const bHover = button('hover', 'hover', 'HOVER', { onDown: act('autopilot'), title: 'Havada asılı kal' });
  const bTilt = button('tilt', 'tilt', 'ORTALA', { onDown: () => { tilt.calibrate(); hud && hud.showMessage && hud.showMessage('Eğim ortalandı', 900); }, title: 'Eğimi ortala' });
  // failures hook (src/flight/failures.js): emergency procedure (fire handle, alternate gear, APU, relight), shown while a failure is active
  const bEmerg = button('emergency', null, 'ACİL', { onDown: act('emergency'), title: 'Acil durum prosedürü' });
  bEmerg.b.style.display = 'none';

  // ---------- stick ----------
  const zone = el('div', 'gkx-zone', root);
  const stick = el('div', 'gkx-stick', zone);
  const knob = el('b', null, stick);
  el('em', null, stick, 'ÇUBUK');
  const st = { pid: null, ox: 0, oy: 0, x: 0, y: 0, hx: 0, hy: 0, R: 60 };
  function stickSet(dx, dy) {
    const R = st.R;
    let vx = dx / R, vy = dy / R;
    const m = Math.hypot(vx, vy);
    if (m > 1) { vx /= m; vy /= m; }
    st.x = vx; st.y = vy;
    knob.style.transform = `translate(${(vx * R).toFixed(1)}px, ${(vy * R).toFixed(1)}px)`;
  }
  zone.addEventListener('pointerdown', (e) => {
    if (st.pid != null) return;
    e.preventDefault();
    st.pid = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const r = zone.getBoundingClientRect();
    // floating origin at the thumb, kept fully inside the screen
    st.ox = clamp(e.clientX, r.left + st.R * 0.6, window.innerWidth - st.R);
    st.oy = clamp(e.clientY, st.R + 4, window.innerHeight - st.R * 0.6);
    stick.style.left = `${(st.ox - r.left).toFixed(1)}px`;
    stick.style.top = `${(st.oy - r.top).toFixed(1)}px`;
    stick.classList.add('live');
    stickSet(e.clientX - st.ox, e.clientY - st.oy);
  });
  const stickMove = (e) => { if (e.pointerId === st.pid) stickSet(e.clientX - st.ox, e.clientY - st.oy); };
  const stickUp = (e) => {
    if (e.pointerId !== st.pid) return;
    st.pid = null;
    stickSet(0, 0);
    stick.classList.remove('live');
    stick.style.left = `${st.hx}px`; stick.style.top = `${st.hy}px`;
  };
  // (window listeners only: captured and bubbling pointer events all reach it once)
  window.addEventListener('pointermove', stickMove);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, stickUp);
  const shapeAxis = (v) => {
    const a = Math.abs(v);
    if (a < STICK_DEAD) return 0;
    const x = (a - STICK_DEAD) / (1 - STICK_DEAD);
    return Math.sign(v) * (0.4 * x + 0.6 * x * x * x);   // expo: fine corrections near the centre
  };

  // ---------- throttle / collective slider ----------
  const thr = el('div', 'gkx-thr gkx-glass', root);
  const thrT = el('div', 'gkx-thr-t', thr, 'GAZ');
  const track = el('div', 'gkx-track', thr);
  const zRev = el('div', 'gkx-zrev', track);
  const zAB = el('div', 'gkx-zab', track);
  const fill = el('div', 'gkx-fill', track);
  const marks = el('div', null, thr);
  const handle = el('div', 'gkx-thr-h', thr, '0');
  const sl = { pid: null, y0: 0, p0: 0, off: 0, H: 200, top: 0, pos: 0, gateAt: -1e9 };
  // lever ↔ track position (0 = bottom … 1 = top)
  function posOf(lever, rev) {
    const c = flightRef.cat;
    if (c === 'fighter' && flightRef.det) { const d = flightRef.det; return lever <= d ? (lever / d) * MIL_POS : MIL_POS + ((lever - d) / (1 - d)) * (1 - MIL_POS); }
    if (flightRef.hasRev) return rev ? REV_ZONE * (1 - lever) : REV_ZONE + lever * (1 - REV_ZONE);
    return lever;
  }
  function leverOf(p) {
    const c = flightRef.cat;
    if (c === 'fighter' && flightRef.det) { const d = flightRef.det; return p <= MIL_POS ? (p / MIL_POS) * d : d + ((p - MIL_POS) / (1 - MIL_POS)) * (1 - d); }
    if (flightRef.hasRev) return p >= REV_ZONE ? (p - REV_ZONE) / (1 - REV_ZONE) : (REV_ZONE - p) / REV_ZONE;
    return p;
  }
  const revCmd = () => { const f = flightRef.f; return !!(f && ((f.sys && f.sys.reverserCmd) || false)); };
  function buildMarks() {
    marks.textContent = '';
    const mark = (p, text, cls = '') => {
      const m = el('div', `gkx-mark ${cls}${p > 0.9 ? ' low' : ''}`, marks);
      m.style.top = `${(sl.top + (1 - p) * sl.H).toFixed(1)}px`;
      if (text) el('i', null, m, text);
    };
    const c = flightRef.cat;
    zAB.style.display = c === 'fighter' && flightRef.det ? '' : 'none';
    zRev.style.display = flightRef.hasRev ? '' : 'none';
    zAB.style.height = `${(1 - MIL_POS) * 100}%`;
    zRev.style.height = `${REV_ZONE * 100}%`;
    if (c === 'fighter' && flightRef.det) { mark(1, 'AB'); mark(MIL_POS, 'MIL', 'mil'); mark(MIL_POS / 2, '%50'); mark(0, 'IDLE'); }
    else if (flightRef.hasRev) { mark(1, 'TOGA'); mark(REV_ZONE + 0.9 * (1 - REV_ZONE), '%90'); mark(REV_ZONE + 0.5 * (1 - REV_ZONE), '%50'); mark(REV_ZONE, 'IDLE', 'idle'); mark(0, 'REV'); }
    else { mark(1, '%100'); mark(0.75, '%75'); mark(0.5, '%50'); mark(0.25, '%25'); mark(0, '%0'); }
    thrT.textContent = c === 'helicopter' ? 'KOLEKTİF' : 'GAZ';
  }
  function setLeverFromPos(p) {
    const lever = clamp(leverOf(clamp(p, 0, 1)), 0, 1);
    input.setTouchLever(lever);
  }
  thr.addEventListener('pointerdown', (e) => {
    if (sl.pid != null) return;
    e.preventDefault(); e.stopPropagation();
    sl.pid = e.pointerId;
    try { thr.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    sl.y0 = e.clientY; sl.p0 = posOf(input.state.throttle, revCmd()); sl.off = 0; sl.gateAt = -1e9;   // a fresh touch is not latched
    thr.classList.add('live');
  });
  function sliderMove(e) {
    if (e.pointerId !== sl.pid) return;
    const f = flightRef.f;
    const raw = sl.p0 + (sl.y0 - e.clientY) / sl.H;
    let p = raw + sl.off;
    const cur = posOf(input.state.throttle, revCmd());
    const EPS = 1e-4, now = performance.now();
    // stop at a gate: the handle stays there and the finger's extra travel so far is discarded; a swipe that arrives
    // at the gate stays latched for GATE_HOLD_MS (a fast full swipe ends at MIL / IDLE, passing is a second push)
    const hold = (at) => { sl.off = at - raw; sl.gateAt = now; return at; };
    const latched = now - sl.gateAt < GATE_HOLD_MS;
    if (flightRef.cat === 'fighter' && flightRef.det) {
      // MIL detent: however fast the swipe, the lever stops at MIL; GATE more travel pushes through (both ways)
      if (cur < MIL_POS - EPS && p > MIL_POS) p = hold(MIL_POS);
      else if (cur > MIL_POS + EPS && p < MIL_POS) p = hold(MIL_POS);
      else if (Math.abs(cur - MIL_POS) <= EPS) {
        if (latched && p !== MIL_POS) { sl.off = MIL_POS - raw; p = MIL_POS; }   // (rebased, the latch is not extended)
        else if (p > MIL_POS) { if (p - MIL_POS < GATE) p = MIL_POS; else { sl.off -= GATE; p -= GATE; vib(22); } }
        else if (p < MIL_POS) { if (MIL_POS - p < GATE) p = MIL_POS; else { sl.off += GATE; p += GATE; vib(22); } }
      }
    } else if (flightRef.hasRev) {
      const rev = revCmd();
      if (!rev && p < REV_ZONE) {
        // IDLE gate: stop at IDLE; pulling on (on the ground) engages the reversers, the depth sets reverse thrust
        const canRev = f && f.onGround && !f.crashed;
        if (cur > REV_ZONE + EPS) p = hold(REV_ZONE);
        else if (latched && canRev) { sl.off = REV_ZONE - raw; p = REV_ZONE; }
        else if (!canRev || REV_ZONE - p < GATE * 0.6) p = REV_ZONE;
        else {
          input.setTouchLever(0);
          input.trigger('reverser');
          if (revCmd()) { vib(22); sl.off += GATE * 0.6; p += GATE * 0.6; } else p = REV_ZONE;
        }
      } else if (rev && p > REV_ZONE) {
        // back above IDLE: stow the reversers; forward thrust after the lever has been at idle (the model's lever lock)
        input.setTouchLever(0);
        input.trigger('reverser');
        vib(15);
        p = hold(REV_ZONE);
      }
    }
    setLeverFromPos(p);
  }
  const sliderUp = (e) => { if (e.pointerId !== sl.pid) return; sl.pid = null; thr.classList.remove('live'); };
  window.addEventListener('pointermove', sliderMove);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, sliderUp);

  // ---------- pedal strip (helicopter) ----------
  const ped = el('div', 'gkx-ped gkx-glass', root);
  el('span', 'l', ped, '◀ PEDAL');
  el('span', 'r', ped, 'PEDAL ▶');
  const pedKnob = el('b', null, ped);
  const pd = { pid: null, v: 0, r: null };
  function pedSet(clientX) {
    const r = pd.r || (pd.r = ped.getBoundingClientRect());   // measured once per touch (no layout read per move)
    const half = Math.max(20, r.width / 2 - 22);
    const v = clamp((clientX - (r.left + r.width / 2)) / half, -1, 1);
    pd.v = Math.abs(v) < 0.08 ? 0 : v;
    pedKnob.style.transform = `translateX(${(v * half).toFixed(1)}px)`;
  }
  ped.addEventListener('pointerdown', (e) => {
    if (pd.pid != null) return;
    e.preventDefault(); e.stopPropagation();
    pd.pid = e.pointerId; pd.r = null;
    try { ped.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    ped.classList.add('live');
    pedSet(e.clientX);
  });
  const pedMove = (e) => { if (e.pointerId === pd.pid) pedSet(e.clientX); };
  const pedUp = (e) => { if (e.pointerId !== pd.pid) return; pd.pid = null; pd.v = 0; pedKnob.style.transform = ''; ped.classList.remove('live'); };
  window.addEventListener('pointermove', pedMove);
  for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, pedUp);

  // ---------- two-finger zoom on the canvas (camera.js zooms on wheel events) ----------
  const canvas = document.querySelector('#app canvas');
  if (canvas) {
    const pts = new Map();
    let d0 = 0;
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 2) d0 = 0; } });
    canvas.addEventListener('pointermove', (e) => {
      const q = pts.get(e.pointerId);
      if (!q) return;
      q[0] = e.clientX; q[1] = e.clientY;
      if (pts.size !== 2) return;
      let a = null, b = null;
      for (const v of pts.values()) { if (a) b = v; else a = v; }
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d0 > 0 && d > 0) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.log(d0 / d) * 600, deltaMode: 0, bubbles: true, cancelable: true }));
      d0 = d;
    });
    const end = (e) => { pts.delete(e.pointerId); d0 = 0; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ---------- tilt ----------
  const tilt = getTilt();
  const tiltOut = { pitch: 0, roll: 0 };
  let tiltOn = false;
  function applyTiltSetting(s) {
    const want = !!(s && s.tilt);
    if (want === tiltOn) return;
    tiltOn = want;
    if (tiltOn) { tilt.start(); tilt.calibrate(); } else tilt.stop();
    layout();
  }
  window.addEventListener('gokyuzu:settings', (e) => applyTiltSetting(e.detail));

  // ---------- layout ----------
  let W = 0, H = 0, phone = false, u = 1, B = 48;
  const place = (node, x, y, w, h) => {
    node.style.left = `${Math.round(x)}px`; node.style.top = `${Math.round(y)}px`;
    if (w != null) node.style.width = `${Math.round(w)}px`;
    if (h != null) node.style.height = `${Math.round(h)}px`;
  };
  function safeInsets() {
    try {
      const cs = getComputedStyle(safeProbe);
      return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    } catch { return { t: 0, r: 0, b: 0, l: 0 }; }
  }
  function layout() {
    W = window.innerWidth; H = window.innerHeight;
    if (!(W > 1 && H > 1)) return;
    const sa = safeInsets();
    phone = isPhoneSize();
    document.documentElement.classList.toggle('gkx-phone', phone);
    u = clamp(Math.min(W, H) / 390, 0.82, 1.4);
    root.style.setProperty('--u', u.toFixed(3));
    const heli = flightRef.cat === 'helicopter';
    const gap = 8 * u, m = 10 * u;
    const L = sa.l + m, R = sa.r + m, T = sa.t + 8 * u, Bm = sa.b + 10 * u;
    // top rows: 4 buttons each side of the HUD heading tape (≈ 210 px at phone scale)
    const headW = 230 * clamp(Math.min(H / 900, W / 1240), 0.6, 2.4) / 0.6 * 0.6;
    const sideW = (W - headW) / 2 - Math.max(L, R) - gap;
    const nLeft = 4 + (bFull ? 1 : 0);
    B = Math.round(clamp(Math.min(50 * u, (sideW - gap * (nLeft - 1)) / nLeft), 38, 62));
    root.style.setProperty('--b', `${B}px`);
    let x = L;
    for (const o of [bPause, bMap, bCam, bView, ...(bFull ? [bFull] : [])]) { place(o.b, x, T); x += B + gap; }
    // throttle / collective slider at the right edge
    const sw = Math.round(58 * u);
    const sTop = T + B + gap * 1.5, sBot = H - Bm;
    place(thr, W - R - sw, sTop, sw, sBot - sTop);
    sl.top = 26 * u; sl.H = Math.max(60, (sBot - sTop) - sl.top - 10 * u);
    buildMarks();
    // top right: AP, H.FREN (fixed wing) / FREN (helicopter), tilt centre
    const topR = heli ? [bHover, bEmerg] : [bAP, bSB, bEmerg];
    if (tiltOn) topR.push(bTilt);
    let xr = W - R - B;
    for (const o of topR) { place(o.b, xr, T); xr -= B + gap; }
    // next to the slider: FLAP ▲ / FLAP ▼ | TAKIM / FREN (fixed wing), pedal strip + FREN (helicopter)
    const colR = W - R - sw - gap - B, colL = colR - gap - B;
    const row2 = H - Bm - B, row1 = row2 - gap - B;
    let bandR = colL - gap;
    if (heli) {
      place(bBrake.b, colR, row1);
      const pw = Math.round(clamp(W * 0.26, 150, 260)), ph = Math.round(46 * u);
      place(ped, W - R - sw - gap - pw, H - Bm - ph, pw, ph);
      bandR = W - R - sw - gap - pw - gap;
    } else {
      place(bFlUp.b, colL, row1); place(bFlDn.b, colL, row2);
      place(bGear.b, colR, row1); place(bBrake.b, colR, row2);
    }
    for (const o of [bFlUp, bFlDn, bGear, bSB, bAP]) o.b.style.display = heli ? 'none' : '';
    bHover.b.style.display = heli ? '' : 'none';
    bTilt.b.style.display = tiltOn ? '' : 'none';
    ped.style.display = heli ? '' : 'none';
    // stick: the zone is the lower left of the screen; the idle ring sits in the corner
    st.R = Math.round(clamp(Math.min(W, H) * 0.16, 50, 84));
    stick.style.setProperty('--R', `${st.R}px`);
    stick.style.setProperty('--K', `${Math.round(st.R * 0.42)}px`);
    const zTop = T + B + gap;
    const zW = Math.min(W * 0.46, bandR - gap);
    place(zone, 0, zTop, zW, H - zTop);
    st.hx = Math.round(L + st.R + 12 * u); st.hy = Math.round(H - zTop - Bm - st.R - 10 * u);
    if (st.pid == null) { stick.style.left = `${st.hx}px`; stick.style.top = `${st.hy}px`; }
    // the free band at the bottom centre (tutorial cards, hints) and the HUD columns
    const bandL = L + st.R * 2 + 24 * u;
    const html = document.documentElement.style;
    html.setProperty('--gkx-mid-x', `${Math.round((bandL + bandR) / 2)}px`);
    html.setProperty('--gkx-mid-w', `${Math.round(Math.max(220, bandR - bandL))}px`);
    html.setProperty('--gkx-mid-b', `${Math.round(Bm)}px`);
    html.setProperty('--gkx-top', `${Math.round(T + B + gap)}px`);
    if (hud && hud.setTouchLayout) {
      hud.setTouchLayout({ left: L, right: R + sw + gap, top: T + B + gap, bottom: H - Math.min(row1, st.hy + zTop - st.R) + gap });
    }
    // phones: the top banner fits between the HUD's speed and altitude columns
    const tapes = hudRoot.querySelectorAll('.gkh-layer .gkh-tape');
    const lt = tapes[0] && tapes[0].getBoundingClientRect(), rt = tapes[1] && tapes[1].getBoundingClientRect();
    const topW = lt && rt && lt.width > 0 && rt.left > lt.right ? rt.left - lt.right - 16 : W - 2 * (L + 110);
    html.setProperty('--gkx-top-w', `${Math.round(clamp(topW, 240, 560))}px`);
    // free-flight challenges hook (src/ui/challenges-panel.js): the tab takes the next free slot of the top-right row;
    // the open panel uses the side area right of the stick's ring (preferably right of the stick zone), left of the
    // altitude column and of the buttons next to the lever, between the top row and the bottom controls
    html.setProperty('--gkx-slot-l', `${Math.round(xr)}px`);
    html.setProperty('--gkx-slot-t', `${Math.round(T)}px`);
    html.setProperty('--gkx-slot-s', `${B}px`);
    const colLeft = rt && rt.width > 0 ? rt.left : W - R - sw - gap - 70 * u;
    const sx1 = Math.min(colLeft, heli ? colR : colL) - gap;
    const ring = st.hx + st.R + 16 * u;
    const sx0 = Math.max(ring, Math.min(zW + gap, sx1 - 260 * u));
    let sy1 = H - Bm;
    if (heli && sx1 > W - R - sw - gap - Math.round(clamp(W * 0.26, 150, 260))) sy1 = H - Bm - Math.round(46 * u) - gap;   // above the pedal strip
    html.setProperty('--gkx-side-x0', `${Math.round(sx0)}px`);
    html.setProperty('--gkx-side-x1', `${Math.round(sx1)}px`);
    html.setProperty('--gkx-side-y0', `${Math.round(T + B + gap)}px`);
    html.setProperty('--gkx-side-y1', `${Math.round(sy1)}px`);
    orient();
  }

  // ---------- portrait (phones) ----------
  let autoPaused = false;
  function orient() {
    const portrait = H > W && W < 700;
    rot.classList.toggle('on', portrait && flightRef.f != null);
    const s = getState();
    if (portrait && s.flying && !s.paused && !autoPaused) { autoPaused = true; input.trigger('pause'); }
    else if (!portrait && autoPaused) { autoPaused = false; if (getState().paused) input.trigger('pause'); }
  }
  // leaving the page (app switch, notification, lock) pauses the flight and lets go of every control
  function releaseAll() {
    st.pid = null; stickSet(0, 0); stick.classList.remove('live');
    stick.style.left = `${st.hx}px`; stick.style.top = `${st.hy}px`;
    sl.pid = null; thr.classList.remove('live');
    pd.pid = null; pd.v = 0; pedKnob.style.transform = '';
    for (const o of Object.values(buttons)) o.release();
    input.touch.pitch = input.touch.roll = input.touch.yaw = input.touch.brake = 0;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    releaseAll();
    const s = getState();
    if (s.flying && !s.paused) input.trigger('pause');
  });
  window.addEventListener('blur', releaseAll);
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => { setTimeout(layout, 250); setTimeout(layout, 800); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
  layout();
  applyTiltSetting(safeSettings());   // (after the layout state above exists: it re-lays out when tilt is on)

  // ---------- per frame ----------
  let tutKey = '', lastCam = '', hideOn = null;
  function setAircraft(f) {
    flightRef.f = f;
    const spec = (f && f.spec) || {};
    const cat = spec.category === 'fighter' || spec.category === 'helicopter' ? spec.category : 'airliner';
    flightRef.cat = cat;
    flightRef.det = cat === 'fighter' && spec.abDetent ? spec.abDetent : null;
    flightRef.hasRev = cat === 'airliner' && !!(f && f.pp ? f.pp.hasRev : true);
    releaseAll();
    layout();
  }

  let wasPaused = false;
  // last values written to the DOM: update() only touches what changed (the lever position includes the layout's sl.top / sl.H)
  const ui = { top: NaN, fill: NaN, ab: null, rev: null, txtRev: null, txtAb: null, pct: NaN, fail: false, fs: null };
  function update(dt, f, info = {}) {
    if (f !== flightRef.f) setAircraft(f);
    if (!f) return;
    const s = getState();
    // tilt: the pose the phone is held in when the flight resumes becomes the new neutral (it may have been put down)
    if (wasPaused && !s.paused && tiltOn) tilt.calibrate();
    wasPaused = !!s.paused;
    const nav = s.mapOpen;
    const hide = !!nav;
    if (hide !== hideOn) { hideOn = hide; root.classList.toggle('gkx-off', hide); if (hide) releaseAll(); }
    // axes: stick (+ tilt), ground steering from the stick for fixed wing, pedals for the helicopter
    let px = shapeAxis(st.x), py = shapeAxis(st.y);
    if (tiltOn && tilt.read(tiltOut)) { px = clamp(px + tiltOut.roll, -1, 1); py = clamp(py + tiltOut.pitch, -1, 1); }
    input.touch.roll = px;
    input.touch.pitch = py;
    if (flightRef.cat === 'helicopter') input.touch.yaw = pd.v * Math.abs(pd.v) * 0.5 + pd.v * 0.5;
    else input.touch.yaw = f.onGround ? px : 0;
    // slider readout (the lever may also move by keys, a reset or the hover hold)
    // (DOM written only on change: a still lever costs no style work)
    const rev = revCmd();
    const lever = input.state.throttle;
    const p = posOf(lever, rev);
    const top = Math.round((sl.top + (1 - p) * sl.H) * 10), fillH = Math.round(clamp(p, 0, 1) * 1000);
    if (top !== ui.top) { ui.top = top; handle.style.top = `${(top / 10).toFixed(1)}px`; }
    if (fillH !== ui.fill) { ui.fill = fillH; fill.style.height = `${(fillH / 10).toFixed(1)}%`; }
    const ab = !!(flightRef.det && lever > flightRef.det + 0.004);
    if (ab !== ui.ab) { ui.ab = ab; thr.classList.toggle('ab', ab); }
    if (rev !== ui.rev) { ui.rev = rev; thr.classList.toggle('rev', rev); }
    const pct = Math.round(lever * 100);
    if (rev !== ui.txtRev || ab !== ui.txtAb || pct !== ui.pct) {
      ui.txtRev = rev; ui.txtAb = ab; ui.pct = pct;
      const txt = rev ? 'REV' : ab ? 'AB' : `${pct}`;
      if (handle.textContent !== txt) handle.textContent = txt;
    }
    // button states
    if (flightRef.cat !== 'helicopter') {
      const g = Number.isFinite(f.gear) ? f.gear : (f.gearHandleDown ? 1 : 0);
      setState(bGear, f.gearHandleDown ? (g > 0.98 ? 'on' : 'amber') : (g > 0.02 ? 'amber' : ''));
      setSub(bGear, f.gearHandleDown ? 'AŞAĞI' : 'YUKARI');
      setSub(bFlDn, String(f.flapsLabel ?? ''));
      setState(bSB, (f.speedbrake || 0) > 0.05 || (f.spoilers || 0) > 0.3 ? 'amber' : '');
      setState(bAP, f.autopilot && f.autopilot.on ? 'on' : '');
    } else setState(bHover, f.autopilot && f.autopilot.on ? 'on' : '');
    const fail = !!(f.failures && f.failures.active && f.failures.active.size);   // failures hook
    if (fail !== ui.fail) { ui.fail = fail; bEmerg.b.style.display = fail ? '' : 'none'; }
    setState(bEmerg, fail ? 'hot' : '');
    setState(bBrake, input.state.brake > 0.05 || f.parkingBrake ? 'amber' : '');
    setSub(bBrake, f.parkingBrake ? 'PARK' : '');
    const cockpit = info.view === 'cockpit';
    setState(bView, cockpit ? 'on' : '');
    const cam = shared.cameraMode || '';
    if (cam !== lastCam) { lastCam = cam; setSub(bCam, (CAMERA_NAMES[cam] || '').toLocaleUpperCase('tr')); }
    const fs = !!document.fullscreenElement;
    if (bFull && fs !== ui.fs) { ui.fs = fs; bFull.b.style.display = fs ? 'none' : ''; }
    // tutorial focus: the controls named on the current tutorial card pulse
    const chips = shared.tutorialChips || '';
    if (chips !== tutKey) { tutKey = chips; highlight(chips); }
  }
  const CHIP_TARGETS = [
    [/çubuk/i, () => stick], [/sürgü|gaz ▲|gaz ▼|kolektif/i, () => thr], [/pedal/i, () => ped],
    [/^TAKIM$/, () => bGear.b], [/^FLAP ▲$/, () => bFlUp.b], [/^FLAP ▼$/, () => bFlDn.b], [/^FREN$/, () => bBrake.b],
    [/^H\.FREN$/, () => bSB.b], [/^AP$/, () => bAP.b], [/^HOVER$/, () => bHover.b], [/^KAMERA$/, () => bCam.b], [/^KOKPİT$/, () => bView.b],
  ];
  function highlight(chips) {
    const list = chips ? chips.split('|') : [];
    for (const [, get] of CHIP_TARGETS) get().classList.remove('flash');
    for (const c of list) for (const [re, get] of CHIP_TARGETS) if (re.test(c)) get().classList.add('flash');
  }

  return {
    update,
    layout,
    debug() {
      return {
        active: true, W, H, phone, u, B, stick: { x: st.x, y: st.y, live: st.pid != null }, slider: { live: sl.pid != null, pos: posOf(input.state.throttle, revCmd()) },
        pedal: pd.v, tilt: { on: tiltOn, receiving: tilt.receiving }, rotate: rot.classList.contains('on'),
        rects: Object.fromEntries(['.gkx-thr', '.gkx-zone', '.gkx-ped'].map((q) => { const r = root.querySelector(q).getBoundingClientRect(); return [q, { x: r.left, y: r.top, w: r.width, h: r.height }]; })),
      };
    },
  };
}

function safeSettings() { try { return loadSettings(); } catch { return {}; } }

/** Fullscreen + landscape lock where the browser allows it (Android Chrome; not iPhone Safari or social-app webviews). */
export function enterFullscreen() {
  try {
    const d = document.documentElement;
    if (!document.fullscreenEnabled || document.fullscreenElement || !d.requestFullscreen) return;
    d.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch { /* ignore */ }
    }).catch(() => {});
  } catch { /* ignore */ }
}

/** Tilt steering switch (Ayarlar): asks for the sensor permission (iOS) inside the tap, then saves the setting. */
export function requestTiltSetting(on) {
  const tilt = getTilt();
  if (!on) { trackEvent('touchctl', { tilt: 0 }); return Promise.resolve('off'); }
  return tilt.request().then((r) => {
    trackEvent('touchctl', { tilt: r === 'granted' ? 1 : 0, why: r === 'granted' ? '' : r });
    return r;
  });
}
