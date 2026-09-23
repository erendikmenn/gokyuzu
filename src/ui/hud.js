// Screen-space HUD. Exterior views get a glass HUD adapted per aircraft category (fighter / airliner /
// helicopter): conformal pitch ladder + flight path marker (chase camera), speed/altitude/heading tapes, VSI,
// category readouts, a systems panel (throttle/AB, N1, torque/NR…), a minimap and an info panel. The cockpit
// view keeps only a minimal strip + warnings (the real instruments take over). Toasts, help and pause overlays.
// Canvases are redrawn every frame; DOM nodes are only touched when their value changes.
import * as THREE from 'three';
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp, smoothstep, wrap360, wrap180, num, fmtInt, fmtDist, keyChips, richText, codeForKeyLabel, pressKey, storageGet, storageSet, KT, FT, FPM, DEG } from './util.js';
import { createMinimap } from './minimap.js';
import { AIRPORTS, LANDMARK_NAMES, CATEGORY_LABEL, AIRCRAFT_INFO } from './data.js';
import { shared } from './shared.js';
import { CAMERA_NAMES } from './camera.js';
import { createCameraBar } from './camera-bar.js';   // camera selector hook (src/ui/camera-bar.js)
import { openSettings, openCredits, qualityHintSeen, markQualityHintSeen, qualityHintText } from './panels.js';
import { explainCrash } from './hints.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { goToMenu } from '../core/leave.js';

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
const C = {
  fg: 'rgba(240,246,255,0.96)', dim: 'rgb(170,188,210)', faint: 'rgba(200,216,236,0.45)', halo: 'rgba(2,8,16,0.42)',
  accent: '#5cf2c8', cyan: '#6fd8ff', magenta: '#ff6ee7', warn: '#ff4d4f', caution: '#ffb020', green: '#4be37a', ab: '#ff8a3d',
  tapeBg: 'rgba(6,12,22,0.36)', tapeEdge: 'rgba(255,255,255,0.12)', boxBg: 'rgba(3,8,14,0.9)',
};
// instrument canvas (design units; 1 du = s CSS px, s ≈ viewport height / 900)
const CW = 1000, CH = 720;
const SPD = { x1: -330, w: 86, h: 300 };
const ALT = { x0: 330, w: 100, h: 300 };
const HDG = { y0: -300, h: 34, w: 480 };
const ROLL_R = 214;
const MAP_DU = 214;
const SYS = { fighter: [280, 118], airliner: [304, 172], helicopter: [304, 172] };

const WARNINGS = [
  ['pullUp', 'PULL UP', 'Burnu kaldır!', 'red'],
  ['stall', 'STALL', 'Hız kaybı', 'red'],
  ['overspeed', 'OVERSPEED', 'Aşırı hız', 'red'],
  ['sinkRate', 'SINK RATE', 'Alçalma hızı yüksek', 'amber'],
  ['bank', 'BANK ANGLE', 'Yatış açısı fazla', 'amber'],
  ['gear', 'GEAR', 'İniş takımı yukarıda', 'amber'],
];

const CSS = `
.gkh { position: absolute; inset: 0; overflow: hidden; pointer-events: none; user-select: none; -webkit-user-select: none;
  color: var(--gk-fg); font-family: var(--gk-sans); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  --s: 1; --ps: 1; }
.gkh-layer { position: absolute; inset: 0; transition: opacity .3s ease; }
.gkh-layer.gkh-off { opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility 0s linear .3s; }
.gkh-cv { position: absolute; display: block; }
.gkh-tape { position: absolute; border-radius: calc(9px * var(--s)); border: 1px solid rgba(255, 255, 255, 0.13);
  background: linear-gradient(180deg, rgba(10, 18, 32, 0.34), rgba(4, 9, 18, 0.42));
  -webkit-backdrop-filter: blur(9px) saturate(1.15); backdrop-filter: blur(9px) saturate(1.15);
  box-shadow: 0 8px 26px rgba(0, 0, 0, .16), inset 0 1px 0 rgba(255, 255, 255, .06); }
.gkh.gkh-compact .gkh-tape { background: linear-gradient(180deg, rgba(10, 18, 32, 0.12), rgba(4, 9, 18, 0.2)); border-color: rgba(255, 255, 255, 0.08);
  -webkit-backdrop-filter: blur(6px) saturate(1.1); backdrop-filter: blur(6px) saturate(1.1); box-shadow: none; }
.gkh.gkh-compact .gkh-fma { top: var(--fma-top, 80px); }
.gkh-panel { position: absolute; overflow: hidden;
  background: linear-gradient(180deg, rgba(16, 26, 42, 0.52), rgba(6, 11, 20, 0.5));
  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: calc(14px * var(--ps));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  -webkit-backdrop-filter: blur(12px) saturate(1.2); backdrop-filter: blur(12px) saturate(1.2); }
.gkh-panel canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.gkh-map { left: calc(18px * var(--ps)); bottom: calc(18px * var(--ps)); width: calc(${MAP_DU}px * var(--ps)); height: calc(${MAP_DU}px * var(--ps)); }
.gkh-sys { right: calc(18px * var(--ps)); bottom: calc(18px * var(--ps)); }
.gkh-info { left: calc(18px * var(--ps)); top: calc(18px * var(--ps)); padding: calc(11px * var(--ps)) calc(15px * var(--ps)) calc(11px * var(--ps)) calc(14px * var(--ps)); min-width: calc(210px * var(--ps)); max-width: calc(320px * var(--ps)); }
.gkh-i-name { display: flex; align-items: center; gap: calc(8px * var(--ps)); font-size: calc(10.5px * var(--ps)); font-weight: 750; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-teal); white-space: nowrap; }
.gkh-i-name::before { content: ""; width: calc(6px * var(--ps)); height: calc(6px * var(--ps)); border-radius: 50%; background: var(--gk-teal); box-shadow: 0 0 8px var(--gk-teal); }
.gkh-i-loc { margin-top: calc(5px * var(--ps)); font-size: calc(14.5px * var(--ps)); font-weight: 650; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkh-i-apt { margin-top: calc(4px * var(--ps)); font: 600 calc(12px * var(--ps)) var(--gk-mono); color: var(--gk-dim); white-space: nowrap; }
.gkh-i-apt b { color: var(--gk-fg); font-weight: 700; }
.gkh-i-cam { margin-top: calc(7px * var(--ps)); display: flex; gap: calc(6px * var(--ps)); font-size: calc(10.5px * var(--ps)); color: var(--gk-faint); font-weight: 600; letter-spacing: .06em; }
.gkh-i-cam b { color: var(--gk-dim); font-weight: 700; }

/* FMA (autopilot) */
.gkh-fma { position: absolute; left: 50%; top: calc(50% - 362px * var(--s)); transform: translateX(-50%); display: none;
  padding: calc(5px * var(--s)) calc(8px * var(--s)); gap: calc(4px * var(--s)); border-radius: calc(10px * var(--s)); }
.gkh-fma.on { display: flex; }
.gkh-fma span { font: 700 calc(12.5px * var(--s)) var(--gk-mono); padding: calc(3px * var(--s)) calc(10px * var(--s)); border-radius: calc(6px * var(--s)); color: var(--gk-dim); white-space: nowrap; }
.gkh-fma span.v { color: #6fd8ff; background: rgba(111, 216, 255, .08); }
.gkh-fma span.ap { color: #4be37a; border: 1px solid rgba(75, 227, 122, .6); }

/* warnings */
.gkh-warn { position: absolute; left: 50%; top: calc(50% - 236px * var(--s)); transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: calc(6px * var(--s)); }
.gkh-warn.gkh-cockpit { top: calc(132px * var(--ps)); }
.gkh.gkh-top .gkh-toast { top: calc(72px * var(--ps)); }
.gkh-w { display: none; flex-direction: column; align-items: center; padding: calc(4px * var(--s)) calc(16px * var(--s)) calc(5px * var(--s));
  border-radius: calc(8px * var(--s)); border: 2px solid currentColor; background: rgba(24, 4, 6, 0.6);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); text-shadow: 0 0 10px rgba(0, 0, 0, .6); }
.gkh-w.on { display: flex; animation: gkh-flash .6s steps(1, end) infinite; }
.gkh-w b { font-size: calc(21px * var(--s)); font-weight: 850; letter-spacing: .18em; padding-left: .18em; line-height: 1.1; }
.gkh-w small { font-size: calc(11px * var(--s)); font-weight: 650; letter-spacing: .06em; color: rgba(255, 255, 255, .85); }
.gkh-w.red { color: var(--gk-warn); box-shadow: 0 0 22px rgba(255, 77, 79, .35); }
.gkh-w.amber { color: var(--gk-caution); background: rgba(26, 17, 2, .6); animation-duration: 1.1s; }
.gkh-w.amber b { font-size: calc(17px * var(--s)); }
@keyframes gkh-flash { 0% { opacity: 1; } 50% { opacity: .35; } }

/* cockpit strip */
.gkh-strip { position: absolute; left: 50%; top: calc(12px * var(--ps)); transform: translateX(-50%); display: flex; gap: calc(3px * var(--ps));
  padding: calc(4px * var(--ps)); border-radius: calc(12px * var(--ps)); }
.gkh-st { display: flex; flex-direction: column; align-items: center; min-width: calc(62px * var(--ps)); padding: calc(3px * var(--ps)) calc(9px * var(--ps)); border-radius: calc(8px * var(--ps)); }
.gkh-st i { font-style: normal; font-size: calc(9px * var(--ps)); font-weight: 750; letter-spacing: .14em; color: var(--gk-dim); }
.gkh-st b { font: 700 calc(15px * var(--ps)) var(--gk-mono); color: var(--gk-fg); letter-spacing: -.02em; }
.gkh-st.warn b { color: var(--gk-caution); }
.gkh-st.hot b { color: #ff9a55; }

/* toast + chip */
.gkh-toast { position: absolute; left: 50%; top: calc(50% - 400px * var(--s)); transform: translateX(-50%);
  max-width: min(86vw, calc(760px * var(--s))); width: max-content; text-wrap: balance; text-align: center;
  padding: calc(10px * var(--s)) calc(26px * var(--s)); border-radius: calc(26px * var(--s));
  font-size: calc(22px * var(--s)); font-weight: 700; letter-spacing: -.005em; line-height: 1.25; color: #fff;
  background: rgba(6, 12, 20, 0.52); border: 1px solid rgba(255, 255, 255, 0.14);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
  opacity: 0; transition: opacity .45s ease; }
.gkh-toast.show { opacity: 1; transition: opacity .12s ease; }
.gkh-chip { position: absolute; left: 50%; bottom: max(calc(92px * var(--ps)), calc(var(--gk-bottom, 0px) + 8px)); transform: translateX(-50%);
  padding: calc(7px * var(--ps)) calc(16px * var(--ps)); border-radius: 999px; font-size: calc(14px * var(--ps)); font-weight: 650; white-space: nowrap;
  background: rgba(6, 12, 20, 0.6); border: 1px solid rgba(255, 255, 255, 0.14); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  opacity: 0; transition: opacity .35s ease; }
.gkh-chip.show { opacity: 1; transition: opacity .1s ease; }
.gkh-chip b { color: var(--gk-teal); font-weight: 750; margin-left: 4px; }

/* overlays */
.gkh-g { position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background: radial-gradient(ellipse 60% 55% at 50% 50%, transparent 30%, rgba(0, 0, 0, .96) 100%); }
.gkh-g.red { background: radial-gradient(ellipse 60% 55% at 50% 50%, rgba(120, 0, 0, .25) 20%, rgba(90, 0, 0, .95) 100%); }
.gkh-crash { position: absolute; inset: 0; opacity: 0; pointer-events: none; transition: opacity .5s ease;
  background: radial-gradient(ellipse 75% 70% at 50% 50%, rgba(80, 0, 0, 0) 40%, rgba(120, 0, 10, .55) 100%); }
.gkh-crash.on { opacity: 1; transition: opacity .12s ease; }
.gkh-ccard { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) scale(.96); min-width: calc(340px * var(--ps)); text-align: center;
  padding: calc(18px * var(--ps)) calc(28px * var(--ps)) calc(16px * var(--ps)); border-radius: calc(18px * var(--ps));
  background: rgba(24, 4, 8, 0.62); border: 1px solid rgba(255, 90, 90, 0.35); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .45); opacity: 0; visibility: hidden; transition: opacity .25s ease, transform .25s ease, visibility 0s linear .25s; }
.gkh-ccard.on { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); transition: opacity .2s ease .15s, transform .35s cubic-bezier(.2, .9, .3, 1.2) .15s; }
.gkh-ccard b { display: block; font-size: calc(34px * var(--ps)); font-weight: 850; letter-spacing: .26em; padding-left: .26em; color: #ff5a5f; text-shadow: 0 0 24px rgba(255, 60, 60, .5); }
.gkh-ccard span { display: block; margin-top: calc(4px * var(--ps)); font-size: calc(16px * var(--ps)); font-weight: 650; color: #fff; }
.gkh-ccard p.gkh-ctip { max-width: min(80vw, calc(430px * var(--ps))); margin: calc(10px * var(--ps)) auto 0; font-size: calc(13.5px * var(--ps)); font-weight: 550; line-height: 1.45;
  color: rgba(255, 236, 236, .9); text-wrap: balance; }
.gkh-ccard p.gkh-ctip:empty { display: none; }
.gkh-ccard p.gkh-ctip em { font-style: normal; font-weight: 750; color: #ffb4b4; }
.gkh-ccard p.gkh-ctip kbd.gk-ikbd { font-size: calc(11.5px * var(--ps)); }
.gkh-ccard small { display: block; margin-top: calc(12px * var(--ps)); font-size: calc(11px * var(--ps)); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: rgba(255, 220, 220, .6); }
.gkh-ccard i { display: block; height: 3px; margin-top: calc(8px * var(--ps)); border-radius: 3px; background: rgba(255, 255, 255, .12); overflow: hidden; }
.gkh-ccard i::after { content: ""; display: block; height: 100%; width: 100%; background: #ff5a5f; transform-origin: 0 50%; transform: scaleX(0); }
.gkh-ccard.on i::after { animation: gkh-countdown 3.85s linear .15s forwards; }
@keyframes gkh-countdown { to { transform: scaleX(1); } }

.gkh-help { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(3, 8, 14, 0.42);
  opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility 0s linear .2s; }
.gkh-help.show { opacity: 1; visibility: visible; transition: opacity .2s ease; pointer-events: auto; z-index: 2; }   /* above the pause screen ("Kontroller") */
.gkh-help-card { position: relative; width: min(94vw, 900px); max-height: 90vh; overflow: auto; padding: 26px 30px 20px; border-radius: 18px;
  background: linear-gradient(180deg, rgba(16, 26, 42, 0.86), rgba(6, 11, 20, 0.86)); }
.gkh-help h2 { margin: 0; font-size: 22px; font-weight: 750; letter-spacing: -.01em; }
.gkh-help .gkh-sub { margin: 4px 0 16px; font-size: 13px; color: var(--gk-dim); }
.gkh-help-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 30px; }
.gkh-hrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.07); font-size: 14px; }
.gkh-hrow .gkh-hl { color: var(--gk-fg); font-weight: 500; flex: 1 1 auto; min-width: 0; }
.gkh-help-sec { margin: 18px 0 4px; font-size: 11px; font-weight: 750; letter-spacing: .18em; text-transform: uppercase; color: var(--gk-teal); }
.gkh-hrow-wide { justify-content: flex-start; gap: 14px; }
.gkh-hrow-wide .gkh-hl { color: var(--gk-dim); font-size: 13px; line-height: 1.35; }
.gkh-cams { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.gkh-cams span { font-size: 12.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .14); color: var(--gk-dim); }
.gkh-cams span.on { color: #04140f; background: var(--gk-teal); border-color: var(--gk-teal); }
.gkh-help .gkh-foot { margin-top: 16px; font-size: 12px; color: var(--gk-dim); text-align: center; }
.gkh-help-tut { position: absolute; top: 22px; right: 26px; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; max-width: 46%; }
.gkh-help-tut .gkh-pbtn { padding: 8px 13px; font-size: 13px; gap: 8px; border-color: rgba(92, 242, 200, .4); background: rgba(92, 242, 200, .08); }
.gkh-help-tut .gkh-pbtn:hover { background: rgba(92, 242, 200, .16); }
.gkh-help-tut .gkh-pbtn svg { width: 15px; height: 15px; }
.gkh-help-tut span { font-size: 11.5px; line-height: 1.35; color: var(--gk-faint); text-align: right; }

.gkh-pause { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
  background: radial-gradient(ellipse at center, rgba(4, 10, 18, 0.5), rgba(2, 6, 12, 0.8));
  -webkit-backdrop-filter: blur(4px) saturate(.8); backdrop-filter: blur(4px) saturate(.8);
  opacity: 0; visibility: hidden; transition: opacity .22s ease, visibility 0s linear .22s; }
.gkh-pause.show { opacity: 1; visibility: visible; transition: opacity .22s ease; pointer-events: auto; }
.gkh-pt { font-size: 46px; font-weight: 850; letter-spacing: .24em; padding-left: .24em; }
.gkh-ps { display: flex; align-items: center; gap: 12px; font-size: 15px; color: var(--gk-dim); }
.gkh-ps i { width: 64px; height: 2px; background: var(--gk-teal); border-radius: 2px; box-shadow: 0 0 10px var(--gk-teal); }
.gkh-pbtns { display: flex; gap: 10px; margin-top: 6px; }
.gkh-pbtn { pointer-events: auto; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-radius: 12px; font: 650 15px var(--gk-sans); color: var(--gk-fg);
  background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .16); transition: background .15s, transform .15s; }
.gkh-pbtn:hover { background: rgba(255, 255, 255, .13); transform: translateY(-1px); }
.gkh-pbtn.primary { background: var(--gk-teal); color: #04140f; border-color: var(--gk-teal); }
.gkh-pbtn.primary:hover { background: #7ff7d6; }
.gkh-pbtn kbd { font: 700 11px var(--gk-sans); padding: 2px 6px; border-radius: 5px; background: rgba(0, 0, 0, .18); border: 1px solid rgba(0, 0, 0, .2); }
.gkh-plink { pointer-events: auto; margin-top: 4px; border: 0; background: none; color: var(--gk-faint); font: 600 12px var(--gk-sans); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.gkh-plink:hover { color: var(--gk-dim); }
.gkh-pinfo { display: grid; grid-template-columns: repeat(3, auto); gap: 6px 26px; margin-top: 10px; font-size: 13px; color: var(--gk-dim); }
.gkh-pinfo span { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
`;

// navigation hook (src/ui/map.js): clickable minimap, route leg in the FMA, ROTA cell in the cockpit strip
const NAV_CSS = `
.gkh-map.gkh-map-nav { pointer-events: auto; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.gkh-map.gkh-map-nav:hover { border-color: rgba(92, 242, 200, .55); box-shadow: 0 10px 30px rgba(0, 0, 0, .22), 0 0 0 1px rgba(92, 242, 200, .25); }
.gkh-map-open { position: absolute; right: calc(7px * var(--ps)); top: calc(7px * var(--ps)); width: calc(24px * var(--ps)); height: calc(24px * var(--ps));
  display: grid; place-items: center; border-radius: calc(7px * var(--ps)); background: rgba(6, 12, 22, .72); border: 1px solid rgba(255, 255, 255, .14); color: var(--gk-fg); }
.gkh-map-open svg { width: 62%; height: 62%; }
.gkh-map-open b { position: absolute; right: calc(-3px * var(--ps)); bottom: calc(-5px * var(--ps)); font: 800 calc(8.5px * var(--ps)) var(--gk-sans); padding: 0 3px; border-radius: 3px; background: rgba(255, 255, 255, .88); color: #06101c; }
.gkh-fma span.nav { color: #ff6ee7; background: rgba(255, 110, 231, .09); }
.gkh-st.gkh-hide { display: none; }
.gkh-st.nav b { color: #ff9cf0; font-size: calc(13px * var(--ps)); }
`;

// ---------- helpers ----------
const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

function attitude(f, out) {
  const q = f.quaternion;
  if (!q) { out.pitch = num(f.pitch); out.roll = num(f.roll); out.hdg = wrap360(num(f.heading)); return out; }
  _f.set(0, 0, -1).applyQuaternion(q);
  _r.set(1, 0, 0).applyQuaternion(q);
  _u.set(0, 1, 0).applyQuaternion(q);
  out.pitch = Math.asin(clamp(_f.y, -1, 1)) / DEG;
  out.roll = Math.atan2(-_r.y, _u.y) / DEG;
  const hz = Math.hypot(_f.x, _f.z);
  out.hdg = Number.isFinite(f.heading) ? wrap360(f.heading) : (hz > 1e-3 ? wrap360(Math.atan2(_f.x, -_f.z) / DEG) : 0);
  // angle of attack / sideslip from the body-frame velocity (robust to unit conventions of f.aoa)
  const v = f.velocity;
  if (v && v.lengthSq() > 25) {
    _q.copy(q).invert();
    _v.copy(v).applyQuaternion(_q);
    out.aoa = Math.atan2(-_v.y, -_v.z) / DEG;
    out.beta = Math.atan2(_v.x, -_v.z) / DEG;
  } else { out.aoa = 0; out.beta = 0; }
  return out;
}

// all speeds are SI (m/s) by contract
const toKt = (v) => (Number.isFinite(v) && v > 0 ? v * KT : null);

export function createHUD(container) {
  injectCSS('base', BASE_CSS);
  injectCSS('hud', CSS);
  const root = el('div', 'gkh', container);
  root.setAttribute('lang', 'tr');

  const gv = el('div', 'gkh-g', root);                 // g-induced vision loss (beneath every HUD element)
  // ---------- exterior layer ----------
  const ext = el('div', 'gkh-layer', root);
  const center = el('div', 'gkh-layer', ext);         // tapes + attitude (hidden in the cinematic cameras)
  const tapes = [el('div', 'gkh-tape', center), el('div', 'gkh-tape', center), el('div', 'gkh-tape', center)];
  const cv = el('canvas', 'gkh-cv', center);
  const mainCtx = cv.getContext('2d');
  let ctx = mainCtx;                                   // current drawing target (full canvas or a compact column)
  // compact mode: three small canvases at the screen edges (speed column, altitude column, heading tape)
  const cvL = el('canvas', 'gkh-cv', center), cvR = el('canvas', 'gkh-cv', center), cvT = el('canvas', 'gkh-cv', center);
  const lctx = cvL.getContext('2d'), rctx = cvR.getContext('2d'), tctx = cvT.getContext('2d');
  const info = el('div', 'gkh-panel gkh-info', ext);
  const iName = el('div', 'gkh-i-name', info, '');
  const iLoc = el('div', 'gkh-i-loc', info, '');
  const iApt = el('div', 'gkh-i-apt', info, '');
  const iCam = el('div', 'gkh-i-cam', info);
  el('span', null, iCam, 'KAMERA');
  const iCamName = el('b', null, iCam, '');
  const fma = el('div', 'gkh-panel gkh-fma', center);
  const mapPanel = el('div', 'gkh-panel gkh-map', ext);
  const mapCv = el('canvas', null, mapPanel);
  let navHooks = null;                                  // navigation hook: { open(src), overlay(ctx, X, Y, sc) } (src/ui/map.js)
  const mctx = mapCv.getContext('2d');
  const minimap = createMinimap();
  const sysPanel = el('div', 'gkh-panel gkh-sys', ext);
  const sysCv = el('canvas', null, sysPanel);
  const sctx = sysCv.getContext('2d');

  // ---------- cockpit strip ----------
  const strip = el('div', 'gkh-layer gkh-off', root);
  const stripBar = el('div', 'gkh-panel gkh-strip', strip);
  const stripCells = new Map();
  function stripCell(key, label) {
    const c = el('div', 'gkh-st', stripBar);
    el('i', null, c, label);
    const b = el('b', null, c, '—');
    stripCells.set(key, { c, b });
  }

  // ---------- warnings / effects ----------
  const crash = el('div', 'gkh-crash', root);
  const ccard = el('div', 'gkh-ccard', root);
  el('b', null, ccard, 'KAZA');
  const ccReason = el('span', null, ccard, '');
  const ccTip = el('p', 'gkh-ctip', ccard, '');     // plain-Turkish cause + one tip (src/ui/hints.js explainCrash)
  el('small', null, ccard, 'Yeniden başlatılıyor');
  el('i', null, ccard);
  const warnBox = el('div', 'gkh-warn', root);
  const warnEls = {};
  for (const [key, title, sub, tone] of WARNINGS) {
    const w = el('div', `gkh-w ${tone}`, warnBox);
    el('b', null, w, title);
    el('small', null, w, sub);
    warnEls[key] = { w, on: false };
  }

  // ---------- messages & overlays (not affected by setVisible) ----------
  // camera selector hook: clickable camera icons, top right under the F1 chip (src/ui/camera-bar.js)
  const camBar = createCameraBar(root);
  const toast = el('div', 'gkh-toast', root);
  const chip = el('div', 'gkh-chip', root);
  const help = el('div', 'gkh-help', root);
  const helpCard = el('div', 'gkh-panel gkh-help-card', help);
  let helpBindings = null;
  let tutorialRestart = null;                          // "Eğitimi yeniden başlat" (src/ui/tutorial.js)
  const pause = el('div', 'gkh-pause', root);
  el('div', 'gkh-pt', pause, 'DURAKLATILDI');
  const ps = el('div', 'gkh-ps', pause);
  el('i', null, ps);
  const psTxt = el('span', null, ps, 'Uçuş donduruldu');
  el('i', null, ps);
  const pbtns = el('div', 'gkh-pbtns', pause);
  const resumeBtn = el('button', 'gkh-pbtn primary', pbtns);
  resumeBtn.append('Devam et ');
  const resumeKbd = el('kbd', null, resumeBtn, 'P');
  const helpBtn = el('button', 'gkh-pbtn', pbtns);
  helpBtn.append('Kontroller ');
  const helpKbd = el('kbd', null, helpBtn, 'F1');
  const setBtn = el('button', 'gkh-pbtn', pbtns);
  setBtn.append('Ayarlar');
  const menuBtn = el('button', 'gkh-pbtn', pbtns);
  menuBtn.append('Ana menü');
  // touch hook: no R key on a phone — restart from the pause screen (reset, then resume)
  const restartBtn = el('button', 'gkh-pbtn', null, 'Yeniden başla');
  restartBtn.addEventListener('click', () => { pressKey('KeyR'); setTimeout(() => pressKey(pauseCode), 80); });
  const credLink = el('button', 'gkh-plink', pause, 'Künye');
  const pinfo = el('div', 'gkh-pinfo', pause);
  let pauseCode = 'KeyP', helpCode = 'F1';
  resumeBtn.addEventListener('click', () => pressKey(pauseCode));
  helpBtn.addEventListener('click', () => pressKey(helpCode));
  menuBtn.addEventListener('click', goToMenu);
  setBtn.addEventListener('click', () => openSettings(root));
  credLink.addEventListener('click', () => openCredits(root));

  // ---------- state ----------
  let def = null, category = 'airliner', spec = {};
  const MODE_KEY = 'gokyuzu-sf.hudMode';
  const MODES = ['full', 'compact', 'off'];
  const MODE_NAMES = { full: 'Tam', compact: 'Sade', off: 'Kapalı' };
  const settingsMode = (() => { try { return loadSettings().hudMode; } catch { return null; } })();
  let hudMode = MODES.includes(settingsMode) ? settingsMode : MODES.includes(storageGet(MODE_KEY)) ? storageGet(MODE_KEY) : 'compact';
  let visible = hudMode !== 'off', view = 'exterior', paused = false, cinematic = false;
  const compact = () => hudMode === 'compact';
  let lastT = performance.now(), pulse = 0;
  let lastKt = 0, ktTrend = 0, maxG = 1, gLoad = 0;
  let infoTimer = 0;
  const att = { pitch: 0, roll: 0, hdg: 0, aoa: 0, beta: 0 };
  const prev = { gear: null, flaps: null, ap: null, sb: null, rev: null, crashed: false };
  const cache = new Map();            // node → last text (setText / custom keys)
  const clsCache = new Map();         // node → { class: on }
  const opCache = new Map();          // node → opacity
  const setText = (node, str) => { if (cache.get(node) !== str) { cache.set(node, str); node.textContent = str; } };
  const setCls = (node, cls, on) => { const m = clsCache.get(node) || {}; if (m[cls] !== on) { m[cls] = on; clsCache.set(node, m); node.classList.toggle(cls, on); } };
  const setOpacity = (node, o) => { const v = Math.round(o * 100) / 100; if (opCache.get(node) !== v) { opCache.set(node, v); node.style.opacity = String(v); } };

  // ---------- layout ----------
  let s = 1, pscale = 1, dpr = 1, vw = 0, vh = 0, mapPx = MAP_DU, sysW = 0, sysH = 0;
  let touchInsets = null;                               // touch hook: { left, right, top, bottom } px kept free for the controls
  const CS = 0.7;                                       // compact instrument scale (relative to s)
  const colBox = { L: null, R: null, T: null };         // compact column boxes in design units
  function colDu() {
    const rowsL = category === 'fighter' ? 4 : 2, rowsR = category === 'helicopter' ? 3 : 2;
    return {
      L: { x0: SPD.x1 - SPD.w - 8, y0: -SPD.h / 2 - 28, w: SPD.w + 16, h: SPD.h + 28 + 12 + rowsL * 24 },
      R: { x0: ALT.x0 - 8, y0: -ALT.h / 2 - 28, w: ALT.w + 16 + 44, h: ALT.h + 28 + 12 + rowsR * 24 + (category === 'helicopter' ? 6 : 0) },
      T: { x0: -HDG.w / 2 - 4, y0: HDG.y0 - 4, w: HDG.w + 8, h: HDG.h + 34 },
    };
  }
  function layout() {
    vw = container.clientWidth || window.innerWidth;
    vh = container.clientHeight || window.innerHeight;
    s = clamp(Math.min(vh / 900, vw / 1240), 0.6, 2.4);
    pscale = clamp(s, 0.78, 2) * (compact() ? 0.82 : 1);
    root.style.setProperty('--s', s.toFixed(4));
    root.style.setProperty('--ps', pscale.toFixed(4));
    root.classList.toggle('gkh-compact', compact());
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.round(CW * s), cssH = Math.round(CH * s);
    cv.style.width = `${cssW}px`; cv.style.height = `${cssH}px`;
    cv.style.left = `${Math.round(vw / 2 - cssW / 2)}px`; cv.style.top = `${Math.round(vh / 2 - cssH / 2)}px`;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    const px = (node, l, t, w, h) => {
      node.style.left = `${Math.round(l)}px`; node.style.top = `${Math.round(t)}px`;
      node.style.width = `${Math.round(w)}px`; node.style.height = `${Math.round(h)}px`;
    };
    const place = (node, x, y, w, h) => px(node, vw / 2 + x * s, vh / 2 + y * s, w * s, h * s);
    // instrument columns: caption row + tape + readouts (row count depends on the category)
    const du = colDu();
    const cmp = compact();
    cv.style.display = cmp ? 'none' : '';
    for (const c of [cvL, cvR, cvT]) c.style.display = cmp ? '' : 'none';
    if (!cmp) {
      place(tapes[0], du.L.x0, du.L.y0, du.L.w, du.L.h);
      place(tapes[1], du.R.x0, du.R.y0, du.R.w, du.R.h);
      place(tapes[2], -HDG.w / 2, HDG.y0, HDG.w, HDG.h);
      root.style.removeProperty('--fma-top');
    } else {
      // compact: smaller columns pinned to the left / right screen edges, heading tape at the top centre
      let k = s * CS;
      const m = 16 * pscale;
      // touch hook (src/ui/touch.js): the columns fit between the on-screen controls (top buttons, stick, lever)
      const ti = touchInsets;
      const colH = Math.max(du.L.h, du.R.h);
      if (ti && colH * k > vh - ti.top - ti.bottom) k = Math.max(k * 0.72, (vh - ti.top - ti.bottom) / colH);
      const lh = du.L.h * k, rh = du.R.h * k;
      const top = ti ? ti.top + Math.max(0, (vh - ti.top - ti.bottom - Math.max(lh, rh)) * 0.3)
        : vh / 2 - (SPD.h / 2 + 28) * k - 24 * s;                     // both tapes centred at the same height
      const L = { l: ti ? ti.left : m, t: top, w: du.L.w * k, h: lh };
      const Rr = { l: vw - (ti ? ti.right : m) - du.R.w * k, t: top, w: du.R.w * k, h: rh };
      const T = { l: vw / 2 - (du.T.w * k) / 2, t: 12 * pscale, w: du.T.w * k, h: du.T.h * k };
      colBox.L = { ...du.L, k, ...L }; colBox.R = { ...du.R, k, ...Rr }; colBox.T = { ...du.T, k, ...T };
      px(tapes[0], L.l, L.t, L.w, L.h);
      px(tapes[1], Rr.l, Rr.t, Rr.w, Rr.h);
      px(tapes[2], T.l + 4 * k, T.t + 4 * k, HDG.w * k, HDG.h * k);
      for (const [c, b] of [[cvL, L], [cvR, Rr], [cvT, T]]) {
        c.style.left = `${Math.round(b.l)}px`; c.style.top = `${Math.round(b.t)}px`;
        c.style.width = `${Math.round(b.w)}px`; c.style.height = `${Math.round(b.h)}px`;
        c.width = Math.round(b.w * dpr); c.height = Math.round(b.h * dpr);
      }
      root.style.setProperty('--fma-top', `${Math.round(T.t + T.h + 4)}px`);
    }
    mapPx = Math.round(MAP_DU * pscale);
    mapCv.width = Math.round(mapPx * dpr); mapCv.height = Math.round(mapPx * dpr);
    layoutSys();
    positionTopStack();
  }
  // Top-of-screen stack, per mode, so toasts never cover the autopilot strip (FMA) or the warnings:
  //   full exterior: toast at the very top, FMA under it (vh/2 − 362 s), warnings below the heading tape
  //   compact:       heading tape → FMA → toast → warnings
  //   cockpit / flyby / tower / HUD off: top strip → toast → warnings
  function positionTopStack() {
    let toastTop, warnTop;
    if (view === 'cockpit' || cinematic || !visible) {
      toastTop = 66 * pscale; warnTop = toastTop + 62 * s;
    } else if (compact()) {
      const fmaTop = parseFloat(root.style.getPropertyValue('--fma-top')) || 64 * s;
      toastTop = fmaTop + 38 * s;
      warnTop = toastTop + 64 * s;
    } else {
      toastTop = Math.min(12 * pscale, vh / 2 - 362 * s - 58 * s);
      warnTop = vh / 2 - 236 * s;
    }
    toast.style.top = `${Math.round(Math.max(6, toastTop))}px`;
    warnBox.style.top = `${Math.round(warnTop)}px`;
  }
  function layoutSys() {
    const [w, h] = SYS[category] || SYS.airliner;
    sysW = Math.round(w * pscale); sysH = Math.round(h * pscale);
    sysPanel.style.width = `${sysW}px`; sysPanel.style.height = `${sysH}px`;
    sysCv.width = Math.round(sysW * dpr); sysCv.height = Math.round(sysH * dpr);
  }
  layout();
  window.addEventListener('resize', layout);

  // ---------- canvas helpers ----------
  function stroke(c, w, color) { c.lineWidth = w + 2; c.strokeStyle = C.halo; c.stroke(); c.lineWidth = w; c.strokeStyle = color; c.stroke(); }
  function fill(c, color) { c.lineWidth = 2; c.strokeStyle = C.halo; c.stroke(); c.fillStyle = color; c.fill(); }
  function text(c, str, x, y, color, halo = true) {
    if (halo) { c.lineWidth = 2.8; c.strokeStyle = C.halo; c.strokeText(str, x, y); }
    c.fillStyle = color; c.fillText(str, x, y);
  }
  function tapeBg(x, y, w, h) {
    // frosted DOM columns (.gkh-tape) sit behind the canvas; the tape window itself is slightly darker
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6);
    ctx.fillStyle = 'rgba(2,6,14,0.22)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.stroke();
  }

  // ---------- conformal attitude (chase camera) ----------
  const proj = { x: 0, y: 0 };
  let fdu = 800;
  const qInv = new THREE.Quaternion();
  function project(dir) {
    _d.copy(dir).applyQuaternion(qInv);
    if (_d.z > -1e-3) return false;
    proj.x = (_d.x / -_d.z) * fdu;
    proj.y = (-_d.y / -_d.z) * fdu;
    return true;
  }
  const _dir = new THREE.Vector3(), _dir2 = new THREE.Vector3();
  function dirAt(pitchDeg, az, out) {
    const p = pitchDeg * DEG;
    return out.set(Math.sin(az) * Math.cos(p), Math.sin(p), -Math.cos(az) * Math.cos(p));
  }

  let attAlpha = 1;
  function drawAttitude(f) {
    const cam = shared.camera;
    if (cam && cam.quaternion && shared.cameraMode === 'chase') {
      qInv.copy(cam.quaternion).invert();
      fdu = (vh / 2) / Math.tan((cam.fov || 60) * DEG / 2) / s;
    } else {
      // preview fallback: a camera looking along the heading, slightly lagging the pitch/roll
      _e.set((att.pitch * 0.85 - 4) * DEG, -att.hdg * DEG, -att.roll * 0.3 * DEG, 'YXZ');
      qInv.setFromEuler(_e).invert();
      fdu = (900 / 2) / Math.tan(30 * DEG) / 1;
    }
    const az = att.hdg * DEG;
    ctx.save();
    ctx.beginPath(); ctx.rect(-300, -262, 600, 520); ctx.clip();
    ctx.font = `600 12px ${MONO}`;
    const lo = Math.max(-90, Math.floor((att.pitch - 40) / 10) * 10), hi = Math.min(90, Math.ceil((att.pitch + 40) / 10) * 10);
    // nose projection for fading
    _dir.set(0, 0, -1).applyQuaternion(f.quaternion);
    const haveNose = project(_dir);
    const nx = proj.x, ny = proj.y;
    for (let p = lo; p <= hi; p += 10) {
      if (!project(dirAt(p, az, _dir))) continue;
      const cx = proj.x, cy = proj.y;
      if (!project(dirAt(p, az + 0.6 * DEG, _dir2))) continue;
      let ux = proj.x - cx, uy = proj.y - cy;
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-6) continue;
      ux /= ul; uy /= ul;
      const dist = haveNose ? Math.hypot(cx - nx, cy - ny) : Math.hypot(cx, cy);
      const a = p === 0 ? 0.8 : 0.62 * (1 - smoothstep(150, 250, dist));
      if (a <= 0.02) continue;
      ctx.globalAlpha = a * attAlpha;
      ctx.beginPath();
      if (p === 0) {
        ctx.moveTo(cx - ux * 520, cy - uy * 520); ctx.lineTo(cx - ux * 70, cy - uy * 70);
        ctx.moveTo(cx + ux * 70, cy + uy * 70); ctx.lineTo(cx + ux * 520, cy + uy * 520);
        stroke(ctx, 1.6, C.fg);
        continue;
      }
      const major = true;
      const x0 = 52, x1 = 104;
      if (p < 0) ctx.setLineDash([7, 6]);
      ctx.moveTo(cx - ux * x1, cy - uy * x1); ctx.lineTo(cx - ux * x0, cy - uy * x0);
      ctx.moveTo(cx + ux * x0, cy + uy * x0); ctx.lineTo(cx + ux * x1, cy + uy * x1);
      stroke(ctx, 1.2, C.fg);
      ctx.setLineDash([]);
      if (major) {
        // end ticks point toward the horizon
        const tx = -uy * (p > 0 ? 7 : -7), ty = ux * (p > 0 ? 7 : -7);
        ctx.beginPath();
        ctx.moveTo(cx - ux * x1, cy - uy * x1); ctx.lineTo(cx - ux * x1 + tx, cy - uy * x1 + ty);
        ctx.moveTo(cx + ux * x1, cy + uy * x1); ctx.lineTo(cx + ux * x1 + tx, cy + uy * x1 + ty);
        stroke(ctx, 1.4, C.fg);
        const lab = String(Math.abs(p));
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        text(ctx, lab, cx - ux * (x1 + 16), cy - uy * (x1 + 16), C.fg);
        text(ctx, lab, cx + ux * (x1 + 16), cy + uy * (x1 + 16), C.fg);
      }
    }
    ctx.globalAlpha = attAlpha;
    // nose (boresight) symbol
    if (haveNose && Math.abs(nx) < 290 && Math.abs(ny) < 250) {
      ctx.beginPath();
      ctx.moveTo(nx - 34, ny); ctx.lineTo(nx - 18, ny); ctx.lineTo(nx - 9, ny + 9); ctx.lineTo(nx, ny);
      ctx.lineTo(nx + 9, ny + 9); ctx.lineTo(nx + 18, ny); ctx.lineTo(nx + 34, ny);
      stroke(ctx, 2.2, C.fg);
    }
    // flight path marker
    if (f.velocity && f.velocity.lengthSq() > 15 * 15 && !(f.onGround && num(f.airspeed) < 20)) {
      _dir.copy(f.velocity).normalize();
      if (project(_dir)) {
        const x = clamp(proj.x, -280, 280), y = clamp(proj.y, -240, 240);
        ctx.beginPath();
        ctx.arc(x, y, 7.5, 0, Math.PI * 2);
        ctx.moveTo(x - 7.5, y); ctx.lineTo(x - 21, y);
        ctx.moveTo(x + 7.5, y); ctx.lineTo(x + 21, y);
        ctx.moveTo(x, y - 7.5); ctx.lineTo(x, y - 15);
        stroke(ctx, 1.8, C.accent);
      }
    }
    ctx.restore();

    // bank scale (fixed arc, pointer = aircraft roll)
    const R = ROLL_R;
    ctx.beginPath();
    ctx.arc(0, 0, R, (-90 - 60) * DEG, (-90 + 60) * DEG);
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const len = (Math.abs(a) === 30 || Math.abs(a) === 60) ? 13 : 7;
      const r = (a - 90) * DEG;
      ctx.moveTo(Math.cos(r) * R, Math.sin(r) * R);
      ctx.lineTo(Math.cos(r) * (R + len), Math.sin(r) * (R + len));
    }
    ctx.globalAlpha = 0.8 * attAlpha;
    stroke(ctx, 1.2, C.dim);
    ctx.globalAlpha = attAlpha;
    ctx.beginPath(); ctx.moveTo(0, -R - 2); ctx.lineTo(-7, -R - 14); ctx.lineTo(7, -R - 14); ctx.closePath();
    fill(ctx, C.fg);
    ctx.save();
    ctx.rotate(-clamp(att.roll, -180, 180) * DEG);
    ctx.beginPath(); ctx.moveTo(0, -R + 3); ctx.lineTo(-8, -R + 16); ctx.lineTo(8, -R + 16); ctx.closePath();
    const bankLim = category === 'airliner' ? 35 : category === 'helicopter' ? 45 : 80;
    fill(ctx, Math.abs(att.roll) > bankLim ? C.caution : C.fg);
    // slip/skid brick
    const slip = clamp(-att.beta * 1.6, -14, 14);
    ctx.beginPath(); ctx.roundRect(-9 + slip, -R + 19, 18, 5, 1.5);
    fill(ctx, C.fg);
    ctx.restore();
  }

  // ---------- tapes ----------
  // speed-tape limits in knots IAS: { lo: stall (VS1g), amber: VLS, hi: max (VMO / MMO / VFE / VLE / VNE) }
  const lim = { lo: null, amber: null, hi: null };
  function speedLimits(f) {
    const v = f.vSpeeds || {};
    const L = spec.limits || {};
    lim.lo = toKt(v.vs1g);
    lim.amber = toKt(v.vls);
    if (!lim.lo && spec.published && spec.published.stallSpeedsKt && f.flapsLabel != null) {
      const kt = spec.published.stallSpeedsKt[f.flapsLabel];
      if (Number.isFinite(kt)) { lim.lo = kt; lim.amber = kt * 1.23; }
    }
    let hi = toKt(v.vmo ?? L.vmo ?? spec.vne ?? spec.vmo);
    const mmo = v.mmo ?? L.mmo;
    if (Number.isFinite(mmo) && num(f.mach) > 0.15 && num(f.ias) > 1) hi = Math.min(hi || Infinity, mmo * f.ias / f.mach * KT);
    if (num(f.flaps) > 0.02 && toKt(v.vfe)) hi = Math.min(hi || Infinity, toKt(v.vfe));
    if (num(f.gear) > 0.02 && toKt(v.vle ?? L.vle)) hi = Math.min(hi || Infinity, toKt(v.vle ?? L.vle));
    lim.hi = Number.isFinite(hi) ? hi : category === 'fighter' ? 800 : category === 'helicopter' ? 159 : 350;
    return lim;
  }
  let lastFlapIdx = 0;

  function drawSpeedTape(f, kt) {
    const { x1, w, h } = SPD;
    const ppk = category === 'fighter' ? 1.6 : category === 'helicopter' ? 3.6 : 2.6;
    const step = category === 'fighter' ? 10 : 5;
    const labStep = category === 'fighter' ? 50 : category === 'helicopter' ? 10 : 20;
    const x0 = x1 - w, top = -h / 2;
    tapeBg(x0, top, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    const band = (a, b, color) => {
      const ya = -(a - kt) * ppk, yb = -(b - kt) * ppk;
      ctx.fillStyle = color; ctx.fillRect(x1 - 6, Math.min(ya, yb), 5, Math.abs(yb - ya));
    };
    speedLimits(f);
    if (!f.onGround) {
      if (lim.lo) band(0, lim.lo, 'rgba(255,77,79,0.85)');
      if (lim.amber && lim.lo && lim.amber > lim.lo) band(lim.lo, lim.amber, 'rgba(255,176,32,0.75)');
    }
    if (lim.hi) {
      band(lim.hi, lim.hi + 600, 'rgba(255,77,79,0.85)');
      band(lim.hi - 6, lim.hi, 'rgba(255,176,32,0.8)');
    }
    ctx.beginPath();
    const vlo = Math.max(0, Math.floor((kt - h / 2 / ppk) / step) * step), vhi = kt + h / 2 / ppk;
    const labels = [];
    for (let v = vlo; v <= vhi; v += step) {
      const y = -(v - kt) * ppk;
      const major = v % (step * 2) === 0;
      ctx.moveTo(x1 - 8, y); ctx.lineTo(x1 - (major ? 20 : 13), y);
      if (v % labStep === 0) labels.push([v, y]);
    }
    stroke(ctx, 1.2, C.fg);
    ctx.font = `600 13px ${MONO}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const [v, y] of labels) if (Math.abs(y) > 19 && Math.abs(y) < h / 2 - 7) text(ctx, String(v), x1 - 25, y, C.fg);
    // bugs: VR (ground), VREF (approach), AP speed
    const bug = (v, label, color) => {
      if (!v) return;
      const y = -(v - kt) * ppk;
      if (Math.abs(y) > h / 2 - 4) return;
      ctx.beginPath(); ctx.moveTo(x1 - 1, y); ctx.lineTo(x1 - 9, y - 5); ctx.lineTo(x1 - 9, y + 5); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
      ctx.font = `700 10px ${MONO}`; ctx.textAlign = 'right';
      if (Math.abs(y) > 20) text(ctx, label, x1 - 12, y - 9, color);
    };
    const vsp = f.vSpeeds || {};
    if (category !== 'helicopter') {
      if (f.onGround && num(f.throttle) > 0.2 || f.onGround && kt > 30) {
        bug(toKt(vsp.vr || spec.vRotate), 'VR', C.cyan);
        if (category === 'airliner') bug(toKt(vsp.v2 || spec.v2), 'V2', C.cyan);
      } else if (!f.onGround && (num(f.flaps) > 0.05 || num(f.gear) > 0.5)) {
        bug(toKt(vsp.vapp || vsp.vref || spec.vRef), category === 'airliner' ? 'VAPP' : 'VREF', C.cyan);
      } else if (!f.onGround && category === 'airliner' && toKt(vsp.greenDot)) {
        const y = -(toKt(vsp.greenDot) - kt) * ppk;
        if (Math.abs(y) < h / 2 - 6) { ctx.beginPath(); ctx.arc(x1 - 12, y, 4, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = C.green; ctx.stroke(); }
      }
    } else if (!f.onGround && toKt(spec.vRef)) bug(toKt(spec.vRef), '', C.cyan);
    const ap = f.autopilot;
    if (ap && ap.on && Number.isFinite(ap.speed) && ap.speed > 0) bug(toKt(ap.speed), '', C.magenta);
    ctx.restore();

    // trend vector (10 s)
    const trend = clamp(ktTrend * 10, -80, 80);
    if (Math.abs(trend) > 3 && !f.onGround) {
      const ty = clamp(-trend * ppk, -h / 2 + 4, h / 2 - 4);
      ctx.beginPath(); ctx.moveTo(x1 - 3, 0); ctx.lineTo(x1 - 3, ty); ctx.moveTo(x1 - 8, ty); ctx.lineTo(x1 + 2, ty);
      stroke(ctx, 1.6, C.accent);
    }
    // value box
    const bx0 = x0 + 4, bx1 = x1 - 12, bh = 18;
    ctx.beginPath();
    ctx.moveTo(bx0, -bh); ctx.lineTo(bx1, -bh); ctx.lineTo(bx1, -6); ctx.lineTo(x1 - 3, 0);
    ctx.lineTo(bx1, 6); ctx.lineTo(bx1, bh); ctx.lineTo(bx0, bh); ctx.closePath();
    ctx.fillStyle = C.boxBg; ctx.fill();
    const bad = !!(f.warnings && (f.warnings.stall || f.warnings.overspeed)) || !!f.stalled;
    ctx.lineWidth = 1.4; ctx.strokeStyle = bad ? C.warn : C.accent; ctx.stroke();
    ctx.font = `700 21px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ktShown = category === 'helicopter' && kt < 20 && !f.onGround ? '<20' : String(Math.round(kt));
    text(ctx, ktShown, bx1 - 6, 1, bad ? C.warn : C.fg, false);
    ctx.font = `650 11px ${SANS}`;
    ctx.textAlign = 'left'; text(ctx, 'HIZ', x0 + 2, top - 13, C.dim);
    ctx.textAlign = 'right'; text(ctx, 'KT', x1 - 2, top - 13, C.dim);
  }

  function drawAltTape(f, ft) {
    const { x0, w, h } = ALT;
    const ppf = category === 'helicopter' ? 0.5 : category === 'fighter' ? 0.2 : 0.3;
    const step = category === 'fighter' ? 200 : 100;
    const lab = category === 'fighter' ? 1000 : category === 'helicopter' ? 200 : 500;
    const x1 = x0 + w, top = -h / 2;
    tapeBg(x0, top, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    const aglM = Number.isFinite(f.agl) ? f.agl : null;
    if (aglM != null) {
      const gft = (num(f.altitude) - aglM) * FT;
      const gy = -(gft - ft) * ppf;
      if (gy < h / 2) {
        const y0 = Math.max(gy, top);
        ctx.fillStyle = 'rgba(120,72,24,0.45)'; ctx.fillRect(x0, y0, w, h / 2 - y0);
        ctx.beginPath();
        for (let x = x0 - h; x < x1; x += 10) { ctx.moveTo(x, h / 2 + 2); ctx.lineTo(x + (h / 2 - y0) + 2, y0); }
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,176,32,0.35)'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.lineWidth = 2; ctx.strokeStyle = C.caution; ctx.stroke();
      }
    }
    ctx.beginPath();
    const lo = Math.floor((ft - h / 2 / ppf) / step) * step, hi = ft + h / 2 / ppf;
    const labels = [];
    for (let v = lo; v <= hi; v += step) {
      const y = -(v - ft) * ppf;
      const major = v % (step * 2) === 0;
      ctx.moveTo(x0 + 3, y); ctx.lineTo(x0 + (major ? 15 : 9), y);
      if (v % lab === 0) labels.push([v, y]);
    }
    stroke(ctx, 1.2, C.fg);
    ctx.font = `600 13px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const [v, y] of labels) if (Math.abs(y) > 19 && Math.abs(y) < h / 2 - 7) text(ctx, String(v), x1 - 8, y, C.fg);
    const ap = f.autopilot;
    if (ap && ap.on && Number.isFinite(ap.altitude)) {
      const tft = ap.altitude * FT;
      const ty = clamp(-(tft - ft) * ppf, -h / 2 + 2, h / 2 - 2);
      ctx.beginPath();
      ctx.moveTo(x0 - 1, ty - 9); ctx.lineTo(x0 + 7, ty - 9); ctx.lineTo(x0 + 7, ty - 4); ctx.lineTo(x0 + 2, ty);
      ctx.lineTo(x0 + 7, ty + 4); ctx.lineTo(x0 + 7, ty + 9); ctx.lineTo(x0 - 1, ty + 9); ctx.closePath();
      ctx.fillStyle = C.cyan; ctx.fill();
    }
    ctx.restore();
    if (ap && ap.on && Number.isFinite(ap.altitude)) {
      ctx.font = `700 13px ${MONO}`; ctx.textAlign = 'right';
      text(ctx, String(Math.round(ap.altitude * FT / 10) * 10), x1, top - 13, C.cyan);
    } else {
      ctx.font = `650 11px ${SANS}`;
      ctx.textAlign = 'left'; text(ctx, 'İRTİFA', x0 + 2, top - 13, C.dim);
      ctx.textAlign = 'right'; text(ctx, 'FT', x1 - 2, top - 13, C.dim);
    }
    const bx0 = x0 + 12, bx1 = x1 - 3, bh = 18;
    ctx.beginPath();
    ctx.moveTo(bx1, -bh); ctx.lineTo(bx0, -bh); ctx.lineTo(bx0, -6); ctx.lineTo(x0 + 3, 0);
    ctx.lineTo(bx0, 6); ctx.lineTo(bx0, bh); ctx.lineTo(bx1, bh); ctx.closePath();
    ctx.fillStyle = C.boxBg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.font = `700 20px ${MONO}`; ctx.textAlign = 'right';
    text(ctx, String(Math.round(ft / (ft > 10000 ? 10 : 1)) * (ft > 10000 ? 10 : 1)), bx1 - 6, 1, C.fg, false);
    drawVSI(f);
  }

  function drawVSI(f) {
    const fpm = num(f.verticalSpeed) * FPM;
    const x = ALT.x0 + ALT.w + 9, H = 118;
    const big = category === 'fighter' ? 6000 : category === 'helicopter' ? 2000 : 6000;
    const map = (v) => {
      const a = Math.abs(v);
      const y = a <= 1000 ? a / 1000 * 64 : a <= 2000 ? 64 + (a - 1000) / 1000 * 26 : 90 + clamp((a - 2000) / (big - 2000), 0, 1) * (H - 90);
      return -Math.sign(v) * y;
    };
    ctx.beginPath();
    ctx.moveTo(x, -H); ctx.lineTo(x, H);
    const ticks = big > 2000 ? [-6000, -2000, -1000, -500, 500, 1000, 2000, 6000] : [-2000, -1000, -500, 500, 1000, 2000];
    for (const v of ticks) { const y = map(v); const l = Math.abs(v) === 500 ? 4 : 7; ctx.moveTo(x, y); ctx.lineTo(x + l, y); }
    ctx.moveTo(x - 3, 0); ctx.lineTo(x + 9, 0);
    stroke(ctx, 1, C.dim);
    ctx.font = `600 10px ${MONO}`; ctx.textAlign = 'left';
    for (const v of ticks) if (Math.abs(v) >= 1000) text(ctx, String(Math.abs(v / 1000)), x + 10, map(v), C.dim);
    const y = map(fpm);
    ctx.beginPath(); ctx.moveTo(x + 1, 0); ctx.lineTo(x + 1, y);
    ctx.lineWidth = 4; ctx.strokeStyle = fpm < -2000 && num(f.agl, 1e9) < 600 ? C.caution : C.accent; ctx.lineCap = 'butt'; ctx.stroke(); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 8, y);
    stroke(ctx, 2, C.fg);
  }

  function drawHeadingTape(f, apt) {
    const hdg = att.hdg;
    const { y0, h, w } = HDG;
    const ppd = 3.4;
    const x0 = -w / 2, yb = y0 + h;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.beginPath();
    const labels = [];
    const lo = Math.floor((hdg - w / 2 / ppd) / 5) * 5, hi = hdg + w / 2 / ppd;
    for (let d = lo; d <= hi; d += 5) {
      const x = (d - hdg) * ppd, dd = wrap360(d);
      ctx.moveTo(x, yb - 2); ctx.lineTo(x, yb - 2 - (dd % 10 === 0 ? 9 : 5));
      if (dd % 30 === 0) labels.push([dd, x]);
    }
    stroke(ctx, 1.1, C.fg);
    const card = { 0: 'K', 90: 'D', 180: 'G', 270: 'B' };
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [dd, x] of labels) {
      if (Math.abs(x) < 42) continue;
      if (card[dd]) { ctx.font = `750 15px ${SANS}`; text(ctx, card[dd], x, y0 + 12, dd === 0 ? '#ff9a6a' : C.fg); }
      else { ctx.font = `600 12px ${MONO}`; text(ctx, String(dd / 10).padStart(2, '0'), x, y0 + 12, C.dim); }
    }
    ctx.restore();
    const lim = w / 2 - 8;
    // nearest-airport bearing bug
    if (apt) {
      const rel = wrap180(apt.brg - hdg);
      const bx = clamp(rel * ppd, -lim, lim);
      ctx.beginPath();
      if (Math.abs(rel * ppd) <= lim) { ctx.moveTo(bx, yb + 2); ctx.lineTo(bx - 6, yb + 10); ctx.lineTo(bx + 6, yb + 10); ctx.closePath(); }
      else { const sg = Math.sign(rel); ctx.moveTo(bx + sg * 8, yb + 6); ctx.lineTo(bx - sg * 3, yb); ctx.lineTo(bx - sg * 3, yb + 12); ctx.closePath(); }
      fill(ctx, C.accent);
      ctx.font = `700 10.5px ${SANS}`; ctx.textAlign = 'center';
      text(ctx, apt.code, bx, yb + 20, C.accent);
    }
    // navigation hook: bearing to the active route waypoint (magenta diamond)
    const nv = f.nav;
    if (nv && nv.valid) {
      const bx = clamp(wrap180(nv.brg - hdg) * ppd, -lim, lim);
      ctx.beginPath(); ctx.moveTo(bx, yb + 1); ctx.lineTo(bx + 5.5, yb + 7.5); ctx.lineTo(bx, yb + 14); ctx.lineTo(bx - 5.5, yb + 7.5); ctx.closePath();
      fill(ctx, C.magenta);
    }
    // AP heading bug
    const ap = f.autopilot;
    if (ap && ap.on && Number.isFinite(ap.heading)) {
      const rel = wrap180(ap.heading - hdg);
      const bx = clamp(rel * ppd, -lim, lim);
      ctx.beginPath();
      ctx.moveTo(bx - 8, yb + 1); ctx.lineTo(bx - 8, yb + 7); ctx.lineTo(bx - 3, yb + 7); ctx.lineTo(bx, yb + 3);
      ctx.lineTo(bx + 3, yb + 7); ctx.lineTo(bx + 8, yb + 7); ctx.lineTo(bx + 8, yb + 1); ctx.closePath();
      ctx.fillStyle = C.cyan; ctx.fill();
    }
    ctx.beginPath(); ctx.roundRect(-31, y0 - 3, 62, h + 1, 6);
    ctx.fillStyle = C.boxBg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6, yb - 2); ctx.lineTo(0, yb + 5); ctx.lineTo(6, yb - 2);
    ctx.fillStyle = C.accent; ctx.fill();
    ctx.font = `700 19px ${MONO}`; ctx.textAlign = 'center';
    text(ctx, String(Math.round(hdg) % 360).padStart(3, '0'), 0, y0 + h / 2 - 1, C.fg, false);
  }

  function readout(label, value, x0, x1, y, color = C.fg, big = false) {
    ctx.font = `650 11px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    text(ctx, label, x0 + 2, y, C.dim);
    ctx.font = `700 ${big ? 18 : 16}px ${MONO}`; ctx.textAlign = 'right';
    text(ctx, value, x1 - 2, y, color);
  }

  function drawReadouts(f, kt, side) {
    const y = SPD.h / 2 + 22;
    const wantL = side !== 'R', wantR = side !== 'L';
    // route each readout to its column (compact mode draws the columns into separate canvases)
    const ro = (label, value, x0, x1, yy, color, big) => { if (x0 < 0 ? wantL : wantR) readout(label, value, x0, x1, yy, color, big); };
    const sx0 = SPD.x1 - SPD.w, sx1 = SPD.x1, ax0 = ALT.x0, ax1 = ALT.x0 + ALT.w;
    const fpm = num(f.verticalSpeed) * FPM;
    const vsStr = `${fpm > 5 ? '+' : ''}${Math.round(fpm / 10) * 10}`;
    const agl = Number.isFinite(f.agl) ? f.agl : null;
    const g = num(f.gForce, 1);
    const gs = f.velocity ? Math.hypot(f.velocity.x, f.velocity.z) * KT : kt;
    if (category === 'fighter') {
      const mach = Number.isFinite(f.mach) ? f.mach : num(f.airspeed) / 340;
      ro('M', mach.toFixed(2), sx0, sx1, y, mach > 1 ? C.ab : C.fg, true);
      ro('G', g.toFixed(1), sx0, sx1, y + 24, g > 8 || g < -2.5 ? C.warn : g > 6.5 ? C.caution : C.fg);
      ro('α', `${att.aoa.toFixed(1)}°`, sx0, sx1, y + 46, att.aoa > 20 ? C.caution : C.fg);
      ro('MAKS G', maxG.toFixed(1), sx0, sx1, y + 68, C.dim);
      ro('FT/DK', vsStr, ax0, ax1, y);
      if (agl != null && agl * FT < 2500 && !f.onGround) readout('RA', String(Math.round(agl * FT / 10) * 10), ax0, ax1, y + 24, agl < 60 ? C.caution : C.accent);
    } else if (category === 'helicopter') {
      ro('GS', String(Math.round(gs)), sx0, sx1, y);
      ro('TRQ', `${Math.round(torquePct(f))}%`, sx0, sx1, y + 24, torquePct(f) > 100 ? C.warn : C.fg);
      ro('FT/DK', vsStr, ax0, ax1, y);
      if (agl != null && wantR) {
        const ra = Math.max(0, agl * FT);
        // radar altitude box, prominent
        const yy = y + 34;
        ctx.beginPath(); ctx.roundRect(ax0, yy - 16, ALT.w, 32, 7);
        ctx.fillStyle = C.boxBg; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = ra < 50 ? C.caution : C.accent; ctx.stroke();
        ctx.font = `650 10px ${SANS}`; ctx.textAlign = 'left'; text(ctx, 'RAD', ax0 + 7, yy, C.dim, false);
        ctx.font = `700 19px ${MONO}`; ctx.textAlign = 'right';
        text(ctx, ra < 1500 ? String(Math.round(ra)) : '----', ax1 - 7, yy + 1, ra < 50 ? C.caution : C.fg, false);
      }
    } else {
      ro('GS', String(Math.round(gs)), sx0, sx1, y);
      ro('M', (Number.isFinite(f.mach) ? f.mach : num(f.airspeed) / 340).toFixed(2), sx0, sx1, y + 24, C.dim);
      ro('FT/DK', vsStr, ax0, ax1, y);
      if (agl != null && agl * FT < 2500 && !f.onGround) readout('RA', String(Math.round(agl * FT / 10) * 10), ax0, ax1, y + 24, agl < 60 ? C.caution : C.accent);
    }
  }

  function torquePct(f) {
    const t = num(f.torque);
    return t <= 2 ? t * 100 : t;
  }
  function nrPct(f) {
    const r = num(f.rotorRPM);
    return r <= 2 ? r * 100 : r > 150 ? (r / 258) * 100 : r;
  }

  // ---------- systems panel ----------
  function arcGauge(c, cx, cy, r, v, o) {
    const a0 = 150 * DEG, a1 = 390 * DEG;            // 240° sweep from lower-left, clockwise
    const t = (x) => a0 + clamp((x - o.min) / (o.max - o.min), 0, 1) * (a1 - a0);
    c.lineCap = 'butt';
    c.beginPath(); c.arc(cx, cy, r, a0, a1);
    c.lineWidth = 5; c.strokeStyle = 'rgba(255,255,255,0.1)'; c.stroke();
    if (o.green) { c.beginPath(); c.arc(cx, cy, r, t(o.green[0]), t(o.green[1])); c.lineWidth = 5; c.strokeStyle = 'rgba(75,227,122,0.7)'; c.stroke(); }
    if (o.amber) { c.beginPath(); c.arc(cx, cy, r, t(o.amber[0]), t(o.amber[1])); c.lineWidth = 5; c.strokeStyle = 'rgba(255,176,32,0.8)'; c.stroke(); }
    if (o.red != null) { c.beginPath(); c.arc(cx, cy, r, t(o.red), a1); c.lineWidth = 5; c.strokeStyle = 'rgba(255,77,79,0.85)'; c.stroke(); }
    const col = o.color || (o.red != null && v >= o.red ? C.warn : C.fg);
    c.beginPath(); c.arc(cx, cy, r, a0, t(v));
    c.lineWidth = 5; c.strokeStyle = o.fillColor || 'rgba(92,242,200,0.85)'; c.stroke();
    const tv = t(v);
    c.beginPath(); c.moveTo(cx + Math.cos(tv) * (r * 0.25), cy + Math.sin(tv) * (r * 0.25)); c.lineTo(cx + Math.cos(tv) * (r + 4), cy + Math.sin(tv) * (r + 4));
    c.lineWidth = 2.4; c.strokeStyle = col; c.lineCap = 'round'; c.stroke();
    c.font = `650 9.5px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = C.dim; c.fillText(o.label, cx, cy + r * 0.62);
    c.font = `700 ${o.big ? 16 : 14}px ${MONO}`;
    c.fillStyle = col; c.fillText(o.text, cx, cy + r * 0.2 + (o.big ? 1 : 0));
    if (o.tag) {
      c.font = `800 9px ${SANS}`;
      const tw = c.measureText(o.tag).width + 8;
      c.beginPath(); c.roundRect(cx - tw / 2, cy - r * 0.45 - 7, tw, 14, 3);
      c.fillStyle = o.tagColor || C.green; c.fill();
      c.fillStyle = '#05140c'; c.fillText(o.tag, cx, cy - r * 0.45);
    }
  }
  function hbar(c, x, y, w, h, v, color, marks) {
    c.beginPath(); c.roundRect(x, y, w, h, h / 2); c.fillStyle = 'rgba(255,255,255,0.1)'; c.fill();
    const vw = clamp(v, 0, 1) * w;
    if (vw > 0.5) { c.beginPath(); c.roundRect(x, y, Math.max(h, vw), h, h / 2); c.fillStyle = color; c.fill(); }
    if (marks) for (const m of marks) { c.fillStyle = 'rgba(6,12,20,0.85)'; c.fillRect(x + m * w - 1, y - 1, 2, h + 2); }
  }
  function pill(c, x, y, label, state) {
    // state: 0 off, 1 on (amber), 2 on (green), 3 on (orange/AB), 4 red
    c.font = `750 9.5px ${SANS}`;
    const w = c.measureText(label).width + 14, h = 17;
    c.beginPath(); c.roundRect(x, y, w, h, 8.5);
    const colors = [null, C.caution, C.green, C.ab, C.warn];
    if (state) { c.fillStyle = colors[state]; c.fill(); c.fillStyle = '#140c04'; }
    else { c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.16)'; c.stroke(); c.fillStyle = C.faint; }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2 + 0.5);
    return x + w + 5;
  }
  function gearLights(c, x, y, f) {
    const g = num(f.gear, 1);
    const handle = f.gearHandleDown !== undefined ? !!f.gearHandleDown : g > 0.5;
    const state = g > 0.99 ? 'down' : g < 0.01 ? 'up' : 'transit';
    c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillStyle = C.dim; c.fillText('TEKER', x, y + 6);
    const bx = x + 42;
    for (let i = 0; i < 3; i++) {
      const cx = bx + i * 15, cy = y + (i === 1 ? 2 : 8);
      c.beginPath(); c.moveTo(cx - 5.5, cy - 4); c.lineTo(cx + 5.5, cy - 4); c.lineTo(cx, cy + 5); c.closePath();
      if (state === 'down') { c.fillStyle = C.green; c.fill(); }
      else if (state === 'transit') { c.fillStyle = (pulse * 4) % 1 < 0.6 ? C.warn : 'rgba(255,77,79,0.35)'; c.fill(); }
      else { c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.22)'; c.stroke(); }
    }
    c.fillStyle = handle ? C.fg : C.dim;
    c.font = `700 10px ${MONO}`;
    c.fillText(state === 'up' ? 'YUKARI' : state === 'down' ? 'AŞAĞI' : 'HAREKET', bx + 44, y + 6);
  }

  function drawSystems(f) {
    const c = sctx, W = sysW / pscale, H = sysH / pscale;
    c.setTransform(dpr * pscale, 0, 0, dpr * pscale, 0, 0);
    c.clearRect(0, 0, W, H);
    c.textBaseline = 'middle';
    const eng = Array.isArray(f.engines) ? f.engines : [];
    const thr = clamp(num(f.throttle), 0, 1);
    const fuel = num(f.fuel, NaN);
    const fuelStr = Number.isFinite(fuel) ? (fuel > 1.5 ? `${fmtInt(fuel)} kg` : `${Math.round(fuel * 100)}%`) : '—';
    const brakes = num(f.brakes) > 0.1 || f.brakes === true;
    if (category === 'fighter') {
      const det = clamp(num(spec.abDetent, 0.9), 0.5, 1);
      const ab = eng.some((e) => num(e.afterburner) > 0.02) || thr > det + 0.005;
      c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.fillStyle = C.dim; c.fillText('GAZ', 14, 20);
      hbar(c, 48, 15, W - 116, 10, thr, ab ? C.ab : 'rgba(92,242,200,0.85)', [det]);
      c.fillStyle = 'rgba(255,138,61,0.28)'; c.fillRect(48 + det * (W - 116), 15, (1 - det) * (W - 116), 10);
      c.font = `700 14px ${MONO}`; c.textAlign = 'right'; c.fillStyle = ab ? C.ab : C.fg;
      c.fillText(`${Math.round(thr * 100)}%`, W - 14, 20);
      // RPM per engine
      c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.fillStyle = C.dim; c.fillText('RPM', 14, 45);
      c.font = `700 13px ${MONO}`; c.fillStyle = C.fg;
      const rpms = (eng.length ? eng : [{ n1: thr }]).map((e) => `${Math.round(num(e.n1) * 100)}%`).join('  ');
      c.fillText(rpms, 48, 45);
      c.font = `650 9.5px ${SANS}`; c.fillStyle = C.dim; c.textAlign = 'right'; c.fillText('YAKIT', W - 78, 45);
      c.font = `700 12px ${MONO}`; c.fillStyle = C.fg; c.fillText(fuelStr, W - 14, 45);
      gearLights(c, 14, 62, f);
      let x = 14;
      const y = H - 30;
      x = pill(c, x, y, 'A/B', ab ? 3 : 0);
      x = pill(c, x, y, 'SPD BRK', num(f.speedbrake) > 0.05 ? 1 : 0);
      x = pill(c, x, y, f.parkingBrake ? 'PARK' : 'FREN', brakes || f.parkingBrake ? 1 : 0);
      if (f.flapsLabel) pill(c, x, y, `FLAP ${f.flapsLabel}`, num(f.flaps) > 0.05 ? 2 : 0);
    } else if (category === 'helicopter') {
      const tq = torquePct(f), nr = nrPct(f);
      arcGauge(c, 52, 64, 36, tq, { min: 0, max: 120, green: [0, 100], amber: [100, 110], red: 110, label: 'TRQ %', text: String(Math.round(tq)), big: true });
      arcGauge(c, 138, 64, 36, nr, { min: 0, max: 120, green: [95, 101], red: 107, label: 'NR %', text: String(Math.round(nr)), big: true, fillColor: 'rgba(111,216,255,0.85)' });
      // collective
      const col = clamp(Number.isFinite(f.collective) ? f.collective : thr, 0, 1);
      c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.fillStyle = C.dim; c.fillText('KOLEKTİF', 14, H - 40);
      hbar(c, 72, H - 45, 104, 9, col, 'rgba(92,242,200,0.85)');
      c.font = `650 9.5px ${SANS}`; c.fillStyle = C.dim; c.fillText('YAKIT', 14, H - 20);
      c.font = `700 12px ${MONO}`; c.fillStyle = C.fg; c.fillText(fuelStr, 72, H - 20);
      // hover drift display: ground velocity in the body frame (fwd = up), rim = 20 kt
      const hx = W - 62, hy = 70, hr = 44;
      c.beginPath(); c.arc(hx, hy, hr, 0, Math.PI * 2); c.fillStyle = 'rgba(3,8,14,0.5)'; c.fill();
      c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.16)'; c.stroke();
      c.beginPath(); c.arc(hx, hy, hr / 2, 0, Math.PI * 2); c.strokeStyle = 'rgba(255,255,255,0.1)'; c.stroke();
      c.beginPath(); c.moveTo(hx - hr, hy); c.lineTo(hx + hr, hy); c.moveTo(hx, hy - hr); c.lineTo(hx, hy + hr); c.strokeStyle = 'rgba(255,255,255,0.08)'; c.stroke();
      if (f.velocity && f.quaternion) {
        _q.copy(f.quaternion).invert();
        _v.set(f.velocity.x, 0, f.velocity.z);
        // yaw-only body frame
        _e.setFromQuaternion(f.quaternion, 'YXZ');
        _qc.setFromAxisAngle(_u.set(0, 1, 0), -_e.y);
        _v.applyQuaternion(_qc);
        const sc = hr / (20 / KT);
        let vx = _v.x * sc, vy = _v.z * sc;
        const L = Math.hypot(vx, vy);
        if (L > hr) { vx *= hr / L; vy *= hr / L; }
        c.beginPath(); c.moveTo(hx, hy); c.lineTo(hx + vx, hy + vy); c.lineWidth = 2.4; c.strokeStyle = C.accent; c.lineCap = 'round'; c.stroke();
        c.beginPath(); c.arc(hx + vx, hy + vy, 3.5, 0, Math.PI * 2); c.fillStyle = C.accent; c.fill();
      }
      c.font = `650 9px ${SANS}`; c.textAlign = 'center'; c.fillStyle = C.dim; c.fillText('SÜRÜKLENME', hx, hy + hr + 12);
      c.font = `700 9px ${SANS}`; c.fillStyle = C.faint; c.fillText('20 kt', hx + hr - 10, hy - hr + 4);
    } else {
      // airliner: N1 per engine (up to 2 shown), flaps, gear, spoilers
      const list = eng.length ? eng.slice(0, 2) : [{ n1: thr }];
      const rev = num(f.reverser);
      list.forEach((e, i) => {
        const n1 = num(e.n1) * (num(e.n1) <= 1.5 ? 100 : 1);
        arcGauge(c, 48 + i * 82, 58, 32, n1, { min: 0, max: 110, red: 104, label: 'N1 %', text: n1.toFixed(1), tag: rev > 0.5 ? 'REV' : rev > 0.02 ? 'REV' : null, tagColor: rev > 0.5 ? C.green : C.caution });
      });
      const x0 = 186;
      c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.fillStyle = C.dim;
      c.fillText('FLAP', x0, 20);
      c.font = `750 15px ${MONO}`; c.fillStyle = num(f.flaps) > 0.02 ? C.cyan : C.fg;
      c.fillText(String(f.flapsLabel ?? '—'), x0, 38);
      hbar(c, x0, 50, W - x0 - 14, 6, num(f.flaps), 'rgba(111,216,255,0.85)');
      c.font = `650 9.5px ${SANS}`; c.fillStyle = C.dim; c.fillText('SPOILER', x0, 72);
      hbar(c, x0, 80, W - x0 - 14, 6, Math.max(num(f.spoilers), num(f.speedbrake)), 'rgba(255,176,32,0.9)');
      gearLights(c, 14, H - 58, f);
      let x = 14;
      const y = H - 30;
      c.font = `650 9.5px ${SANS}`; c.textAlign = 'left'; c.fillStyle = C.dim; c.fillText('GAZ', x0, 102);
      c.font = `700 12px ${MONO}`; c.fillStyle = C.fg; c.fillText(`${Math.round(thr * 100)}%`, x0 + 32, 102);
      c.font = `650 9.5px ${SANS}`; c.fillStyle = C.dim; c.fillText('YAKIT', x0, 120);
      c.font = `700 12px ${MONO}`; c.fillStyle = C.fg; c.fillText(fuelStr, x0 + 40, 120);
      const ap = f.autopilot;
      x = pill(c, x, y, 'AP', ap && ap.on ? 2 : 0);
      x = pill(c, x, y, f.parkingBrake ? 'PARK' : 'FREN', brakes || f.parkingBrake ? 1 : 0);
      x = pill(c, x, y, f.autobrake ? `A/BRK ${typeof f.autobrake === 'string' ? f.autobrake : ''}`.trim() : 'A/BRK', f.autobrake ? 2 : 0);
      x = pill(c, x, y, 'REV', rev > 0.02 ? (rev > 0.5 ? 2 : 1) : 0);
      pill(c, x, y, 'SPD BRK', num(f.speedbrake) > 0.05 ? 1 : 0);
    }
  }

  // ---------- info panel ----------
  function nearestAirport(world, p) {
    const rw = (world && world.runways) || shared.runways;
    if (!rw || !Array.isArray(rw.airports)) return null;
    let best = null, bd = Infinity;
    for (const a of rw.airports) {
      const c = a.center; if (!c) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return null;
    const brg = wrap360(Math.atan2(best.center.x - p.x, -(best.center.z - p.z)) / DEG);
    return { icao: best.icao, code: (AIRPORTS[best.icao] && AIRPORTS[best.icao].code) || best.icao, dist: bd, brg };
  }
  let aptCache = null;
  function updateInfo(f, world) {
    const p = f.position;
    aptCache = nearestAirport(world, p);
    const lms = world && world.landmarks && Array.isArray(world.landmarks.landmarks) ? world.landmarks.landmarks : [];
    let lm = null, ld = Infinity;
    for (const l of lms) {
      if (l.id === 'sfo_tower') continue;
      const d = Math.hypot(l.x - p.x, l.z - p.z);
      if (d < ld) { ld = d; lm = l; }
    }
    let loc;
    const water = world && typeof world.isWater === 'function' ? safeBool(() => world.isWater(p.x, p.z)) : false;
    let onRunway = null;
    if (world && typeof world.runwayAt === 'function') onRunway = safeVal(() => world.runwayAt(p.x, p.z));
    if (onRunway && f.onGround) loc = `${(AIRPORTS[onRunway.airport] && AIRPORTS[onRunway.airport].code) || onRunway.airport} · Pist ${onRunway.id}`;
    else if (aptCache && aptCache.dist < 2200) loc = (AIRPORTS[aptCache.icao] && AIRPORTS[aptCache.icao].name) || aptCache.icao;
    else if (lm && ld < 1800) loc = `${LANDMARK_NAMES[lm.id] || lm.name} yakını`;
    else loc = regionName(p.x, p.z, water);
    setText(iLoc, loc);
    if (aptCache) {
      const s2 = `${aptCache.code} ${fmtDist(aptCache.dist)} · ${String(Math.round(aptCache.brg) % 360).padStart(3, '0')}°`;
      if (cache.get(iApt) !== s2) { cache.set(iApt, s2); iApt.textContent = ''; el('b', null, iApt, aptCache.code); iApt.append(` ${fmtDist(aptCache.dist)} · ${String(Math.round(aptCache.brg) % 360).padStart(3, '0')}°`); }
    }
    setText(iCamName, shared.cameraSub === 'spotter' ? 'Kule · gözcü' : CAMERA_NAMES[shared.cameraMode] || '');
  }
  // coarse Bay Area regions in the local frame (x east, z south; SFO at the origin)
  function regionName(x, z, water) {
    if (water) {
      if (x < -10500 && z > -24000) return 'Pasifik kıyısı üzeri';
      if (z < -22300 && x < -7000) return 'Golden Gate Boğazı üzeri';
      return 'San Francisco Körfezi üzeri';
    }
    if (z < -22500 && x < -2500) return 'Marin tepeleri üzeri';
    if (x < -1000 && z < -9800 && z >= -22500) return 'San Francisco üzeri';
    if (x < 1500 && z >= -9800) return 'Yarımada üzeri';
    if (x > 3200 && x < 8600 && z < -16900 && z > -20400) return 'Alameda üzeri';
    if (x > 6000 && z < -8000) return 'Oakland üzeri';
    if (x > 6000) return 'Doğu Körfez üzeri';
    return 'Körfez kıyısı üzeri';
  }
  function safeBool(fn) { try { return !!fn(); } catch { return false; } }
  function safeVal(fn) { try { return fn(); } catch { return null; } }

  // ---------- FMA ----------
  /** Navigation hook: active route leg, e.g. "LNAV → 2/4 · 3,2 NM · 287° · 250 kt" ('' without an active leg). */
  function navLine(f) {
    const n = f.nav;
    if (!n || !n.valid) return '';
    const ap = f.autopilot, lnav = ap && ap.on && ap.lnav;
    const d = n.dist / 1852;
    const name = n.kind && n.kind !== 'wpt' ? `${n.name} ` : '';
    // on a route approach the localizer flies the final: "ILS 28R → …"
    const ils = lnav && n.rw && /^(LOC|LAND|FLARE|ROLLOUT)/.test(String(ap.mode || ''));
    // target speed: the leg's (Mach up high for fighters); on the ILS final the approach speed the autothrust flies
    const spd = ils && Number.isFinite(ap.speed) ? `${Math.round(ap.speed * KT)} kt` : Number.isFinite(n.spdMach) ? `M${n.spdMach.toFixed(2)}`
      : Number.isFinite(n.legSpeed) ? `${Math.round(n.legSpeed * KT)} kt` : '';
    return `${ils ? `ILS ${n.rw.ident}` : lnav ? 'LNAV' : 'ROTA'} → ${name}${n.index + 1}/${n.count} · ${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} NM · ${String(Math.round(n.brg) % 360).padStart(3, '0')}°${spd ? ` · ${spd}` : ''}`;
  }
  function updateFMA(f) {
    const ap = f.autopilot;
    const on = !!(ap && ap.on);
    const nav = navLine(f);
    setCls(fma, 'on', on || !!nav);
    if (!on && !nav) return;
    const parts = [];
    if (!on) { /* route guidance only */ } else if (category === 'helicopter') {
      const mode = String(ap.mode || '').toLowerCase();
      parts.push(['v', mode === 'hover' ? 'HOVER' : mode === 'nav' ? 'NAV' : 'CRUISE']);
      if (mode !== 'hover' && Number.isFinite(ap.speed)) parts.push(['v', `SPD ${Math.round(ap.speed * KT)}`]);
      parts.push(['v', `HDG ${String(Math.round(wrap360(num(ap.heading)))).padStart(3, '0')}`]);
      if (Number.isFinite(ap.altitude)) parts.push(['v', ap.radar ? `RALT ${Math.round(ap.altitude * FT)}` : `ALT ${Math.round(ap.altitude * FT / 10) * 10}`]);
      parts.push(['ap', 'AFCS']);
    } else {
      const spd = Number.isFinite(ap.speed) && ap.speed > 0 ? Math.round(ap.speed * KT) : null;
      if (spd != null) parts.push(['v', ap.athr === false ? 'MAN THR' : `A/THR SPD ${spd}`]);   // MAN THR: route A/THR taken over (fighter)
      const modes = String(ap.mode || '').split(/\s+/).filter(Boolean);
      const lat = modes.find((m) => /^(HDG|LOC|NAV|ROLLOUT|FLARE|LAND)$/.test(m)) || 'HDG';
      const vert = modes.find((m) => /^(ALT|CLB|DES|G\/S|VS|FLARE|LAND)$/.test(m) && m !== lat);
      parts.push(['v', lat === 'HDG' ? `HDG ${String(Math.round(wrap360(num(ap.heading)))).padStart(3, '0')}` : lat]);
      if (Number.isFinite(ap.altitude)) parts.push(['v', `${vert && vert !== 'ALT' ? `${vert} ` : 'ALT '}${Math.round(ap.altitude * FT / 10) * 10}`]);
      if (modes.includes('APP')) parts.push(['v', 'APP']);
      parts.push(['ap', category === 'airliner' ? 'AP1' : 'AP']);
    }
    if (nav) parts.push(['nav', nav]);
    const key = parts.map((p) => p[1]).join('|');
    if (cache.get(fma) !== key) {
      cache.set(fma, key);
      fma.textContent = '';
      for (const [cls, txt] of parts) el('span', cls, fma, txt);
    }
  }

  // ---------- cockpit strip ----------
  function buildStrip() {
    stripBar.textContent = '';
    stripCells.clear();
    stripCell('ias', 'HIZ KT');
    if (category === 'fighter') { stripCell('mach', 'MACH'); stripCell('g', 'G'); }
    stripCell('alt', 'İRTİFA FT');
    if (category === 'helicopter') stripCell('ra', 'RAD ALT');
    stripCell('vs', 'FT/DK');
    stripCell('hdg', 'BAŞ');
    if (category === 'helicopter') stripCell('trq', 'TRQ');
    else stripCell('thr', 'GAZ');
    stripCell('nav', 'ROTA');                            // navigation hook: active route leg (hidden without a route)
    stripCells.get('nav').c.classList.add('nav', 'gkh-hide');
  }
  function updateStrip(f, kt, ft) {
    const nc = stripCells.get('nav');
    if (nc) {                                            // navigation hook
      const n = f.nav, on = !!(n && n.valid);
      setCls(nc.c, 'gkh-hide', !on);
      if (on) { const d = n.dist / 1852; setText(nc.b, `${n.index + 1}/${n.count} · ${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} NM · ${String(Math.round(n.brg) % 360).padStart(3, '0')}°`); }
    }
    const set = (k, v, cls) => { const s2 = stripCells.get(k); if (!s2) return; setText(s2.b, v); setCls(s2.c, 'warn', cls === 'warn'); setCls(s2.c, 'hot', cls === 'hot'); };
    set('ias', String(Math.round(kt)));
    set('alt', fmtInt(Math.round(ft / 10) * 10));
    const fpm = num(f.verticalSpeed) * FPM;
    set('vs', `${fpm > 5 ? '+' : ''}${fmtInt(Math.round(fpm / 10) * 10)}`, fpm < -2000 && num(f.agl, 1e9) < 600 ? 'warn' : '');
    set('hdg', `${String(Math.round(att.hdg) % 360).padStart(3, '0')}°`);
    if (category === 'fighter') {
      const mach = Number.isFinite(f.mach) ? f.mach : num(f.airspeed) / 340;
      set('mach', mach.toFixed(2), mach > 1 ? 'hot' : '');
      const g = num(f.gForce, 1);
      set('g', g.toFixed(1), g > 7 ? 'warn' : '');
    }
    if (category === 'helicopter') {
      set('ra', Number.isFinite(f.agl) ? String(Math.round(Math.max(0, f.agl * FT))) : '—', num(f.agl, 99) < 15 ? 'warn' : '');
      set('trq', `${Math.round(torquePct(f))}%`, torquePct(f) > 100 ? 'warn' : '');
    } else {
      const thr = clamp(num(f.throttle), 0, 1);
      const ab = category === 'fighter' && (thr > num(spec.abDetent, 0.9) + 0.005 || (Array.isArray(f.engines) && f.engines.some((e) => num(e.afterburner) > 0.02)));
      set('thr', `${Math.round(thr * 100)}%${ab ? ' AB' : ''}`, ab ? 'hot' : '');
    }
  }

  // ---------- warnings ----------
  function updateWarnings(f) {
    const w = f.warnings || {};
    const air = !f.onGround && !f.crashed;
    for (const [key] of WARNINGS) {
      let on = !!w[key];
      if (key === 'stall' && f.warnings === undefined) on = air && !!f.stalled;
      if (f.crashed) on = false;
      const e = warnEls[key];
      if (e.on !== on) { e.on = on; e.w.classList.toggle('on', on); }
    }
  }

  // ---------- transitions → chips ----------
  function detectChanges(f) {
    const gear = f.gearHandleDown !== undefined ? !!f.gearHandleDown : num(f.gear, 1) > 0.5;
    if (prev.gear !== null && gear !== prev.gear && category !== 'helicopter') showChip('İniş takımı', gear ? 'AŞAĞI' : 'YUKARI');
    prev.gear = gear;
    const fl = f.flapsLabel != null ? String(f.flapsLabel) : null;
    if (prev.flaps !== null && fl !== null && fl !== prev.flaps) showChip('Flap', fl);
    prev.flaps = fl;
    if (Number.isFinite(f.flapsIndex)) lastFlapIdx = f.flapsIndex;
    const ap = !!(f.autopilot && f.autopilot.on);
    if (prev.ap !== null && ap !== prev.ap) showChip('Otopilot', ap ? 'AÇIK' : 'KAPALI');
    prev.ap = ap;
    const sb = num(f.speedbrake) > 0.05;
    if (prev.sb !== null && sb !== prev.sb) showChip('Hava freni', sb ? 'AÇIK' : 'KAPALI');
    prev.sb = sb;
    const rv = num(f.reverser) > 0.05;
    if (prev.rev !== null && rv !== prev.rev) showChip('Ters itki', rv ? 'AÇIK' : 'KAPALI');
    prev.rev = rv;
    const cr = !!f.crashed;
    if (cr !== prev.crashed) {
      crash.classList.toggle('on', cr);
      if (cr) setCrashText(f.crashReason);
      ccard.classList.toggle('on', cr);
      prev.crashed = cr;
    }
  }

  // ---------- g-effects (cockpit) ----------
  function updateG(f, dt) {
    const g = num(f.gForce, 1);
    // tolerance model: vision narrows with sustained load above ~6 g, redout below −2.5 g
    const k = g > 6 ? (g - 6) / 3.5 : g < -2.5 ? (g + 2.5) / 2 : 0;
    gLoad += (k - gLoad) * (1 - Math.exp(-dt * (Math.abs(k) > Math.abs(gLoad) ? 0.9 : 1.6)));
    const on = view === 'cockpit' && category === 'fighter' && !paused;
    const o = on ? clamp(Math.abs(gLoad), 0, 1) * 0.92 : 0;
    setCls(gv, 'red', gLoad < 0);
    setOpacity(gv, o);
  }

  // ---------- help ----------
  function buildHelp(bindings) {
    helpCard.textContent = '';
    el('h2', null, helpCard, 'Kontroller');
    const nm = def ? `${def.name || ''} · ${CATEGORY_LABEL[category] || ''}` : '';
    el('p', 'gkh-sub', helpCard, nm || 'Uçuş kontrolleri ve kamera');
    if (tutorialRestart) {                               // header action: replay the step-by-step flight tutorial
      const tr = el('div', 'gkh-help-tut', helpCard);
      const tb = el('button', 'gkh-pbtn', tr);
      tb.type = 'button';
      tb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/></svg>';
      tb.append('Eğitimi yeniden başlat');
      el('span', null, tr, 'Uçak başlangıç noktasına döner');
      tb.addEventListener('click', () => { tb.blur(); pressKey(helpCode); tutorialRestart(); });
    }
    const list = (Array.isArray(bindings) ? bindings : []).filter(Boolean);
    const isLong = (b) => String(b.label ?? '').length > 40 || String(b.keys ?? '').length > 24;
    const short = list.filter((b) => !isLong(b)), long = list.filter(isLong);
    const grid = el('div', 'gkh-help-grid', helpCard);
    const half = Math.ceil(short.length / 2);
    for (let i = 0; i < half; i++) {
      for (const b of [short[i], short[i + half]]) {
        const row = el('div', 'gkh-hrow', grid);
        if (!b) continue;
        el('span', 'gkh-hl', row, b.label ?? '');
        keyChips(row, b.keys);
      }
    }
    if (long.length) for (const b of long) {
      const row = el('div', 'gkh-hrow gkh-hrow-wide', helpCard);
      keyChips(row, b.keys);
      el('span', 'gkh-hl', row, b.label ?? '');
    }
    el('div', 'gkh-help-sec', helpCard, 'Kameralar');
    const cams = el('div', 'gkh-cams', helpCard);
    for (const [id, name] of Object.entries(CAMERA_NAMES)) el('span', id === shared.cameraMode ? 'on' : '', cams, name);
    const mouse = el('div', 'gkh-hrow gkh-hrow-wide', helpCard);
    keyChips(mouse, touchInsets ? 'Dokunmatik' : 'Fare');
    el('span', 'gkh-hl', mouse, touchInsets ? 'Ekranın ortasında sürükle: etrafa bak / döndür · İki parmak: yakınlaştır · Çift dokun: ortala'
      : 'Sürükle: kokpitte etrafa bak, dış kamerada döndür · Tekerlek: yakınlaştır · Çift tık: ortala');
    el('div', 'gkh-foot', helpCard, touchInsets ? 'Kapatmak için boş bir yere dokun' : 'Kapatmak için F1 veya ?');
    // mirror keys for the pause buttons
    const find = (re) => list.find((b) => re.test(String(b.label || '')));
    const pb = find(/duraklat/i), hb = find(/yardım|kontrol/i);
    if (pb) { const k = String(pb.keys).split(/[\s/·,]+/).filter(Boolean)[0]; const code = codeForKeyLabel(k); if (code) { pauseCode = code; resumeKbd.textContent = k; } }
    if (hb) { const k = String(hb.keys).split(/[\s/·,]+/).filter(Boolean)[0]; const code = codeForKeyLabel(k); if (code) { helpCode = code; helpKbd.textContent = k; } }
  }
  function buildPauseInfo() {
    pinfo.textContent = '';
    const rows = [['Kamera', 'C'], ['Kokpit', 'T'], ['Yeniden başla', 'R'], ['Göstergeler', 'H'], ['Ses', 'M'], ['Yardım', 'F1']];
    for (const [l, k] of rows) { const s2 = el('span', null, pinfo, l); el('kbd', 'gk-kbd', s2, k); }
  }
  buildPauseInfo();

  // ---------- crash card text ----------
  function setCrashText(reason) {
    const x = explainCrash(reason, category);
    ccReason.textContent = x.text;
    const frag = richText(document.createDocumentFragment(), x.tip);
    ccTip.textContent = '';
    ccTip.append(el('em', null, null, 'İpucu: '), frag);
  }

  // ---------- messages ----------
  let toastTimer = 0, chipTimer = 0;
  function showChip(label, value, ms = 1400) {
    chip.textContent = '';
    chip.append(label);
    if (value) el('b', null, chip, value);
    chip.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('show'), ms);
  }

  function applyVisibility() {
    const cockpit = view === 'cockpit';
    setCls(ext, 'gkh-off', !visible || cockpit);
    setCls(center, 'gkh-off', cinematic);
    setCls(strip, 'gkh-off', !visible || !(cockpit || cinematic));
    setCls(warnBox, 'gkh-off', !visible);
    warnBox.style.display = visible ? '' : 'none';
    setCls(warnBox, 'gkh-cockpit', cockpit || cinematic || compact());
    setCls(root, 'gkh-top', !visible || cockpit || cinematic || compact());
    positionTopStack();
  }
  function setMode(m, persist = true) {
    if (!MODES.includes(m)) return hudMode;
    if (m === hudMode && !persist) return hudMode;
    hudMode = m;
    visible = m !== 'off';
    storageSet(MODE_KEY, m);
    if (persist) { try { const st = loadSettings(); if (st.hudMode !== m) saveSettings({ ...st, hudMode: m }); } catch { /* ignore */ } }
    layout();
    applyVisibility();
    return hudMode;
  }

  const hud = {
    setAircraft(d) {
      if (!def && !qualityHintSeen() && !touchInsets) {   // (phones already start on the lowest preset)
        setTimeout(() => { if (!qualityHintSeen()) { markQualityHintSeen(); hud.showMessage(`${qualityHintText()} (${touchInsets ? '❚❚' : 'P'} → Ayarlar)`, 6500); } }, 7000);
      }
      def = d || null;
      spec = (d && d.spec) || {};
      category = spec.category || (d && d.category) || 'airliner';
      maxG = 1;
      Object.assign(prev, { gear: null, flaps: null, ap: null, sb: null, rev: null });
      setText(iName, (d && ((AIRCRAFT_INFO[d.id] && AIRCRAFT_INFO[d.id].short) || d.name)) || '');
      layout();
      buildStrip();
      helpBindings = null;
    },
    update(f, infoArg = {}) {
      if (!f || !f.position) return;
      const now = performance.now();
      const dt = clamp((now - lastT) / 1000, 0, 0.25);
      lastT = now;
      pulse += dt;
      const nv = infoArg && infoArg.view === 'cockpit' ? 'cockpit' : 'exterior';
      const cin = nv === 'exterior' && (shared.cameraMode === 'flyby' || shared.cameraMode === 'tower');
      if (nv !== view || cin !== cinematic) { view = nv; cinematic = cin; applyVisibility(); }
      if (!def && f.spec) hud.setAircraft({ spec: f.spec, name: f.spec.name, id: f.spec.id });
      attitude(f, att);
      const iasMs = Number.isFinite(f.ias) ? f.ias : num(f.airspeed);
      const kt = Math.max(0, iasMs * KT);
      const ft = num(f.altitude) * FT;
      if (dt > 0) {
        const a = (kt - lastKt) / dt;
        ktTrend += (clamp(a, -40, 40) - ktTrend) * (1 - Math.exp(-dt / 0.8));
      }
      lastKt = kt;
      if (!f.onGround) maxG = Math.max(maxG, num(f.gForce, 1));
      detectChanges(f);
      updateG(f, dt);
      camBar.update(visible);   // camera selector hook: active camera, hidden with the HUD
      if (!visible) return;
      updateWarnings(f);
      if (view === 'cockpit') { updateStrip(f, kt, ft); return; }
      if (cinematic) updateStrip(f, kt, ft);

      // exterior instruments
      if (cinematic) {
        drawSystems(f);
        infoTimer -= dt;
        if (infoTimer <= 0) { infoTimer = 0.25; updateInfo(f, infoArg.world); }
        mctx.setTransform(dpr * pscale, 0, 0, dpr * pscale, 0, 0);
        minimap.draw(mctx, MAP_DU, f, infoArg.world, att.hdg, pulse, navHooks && navHooks.overlay);
        return;
      }
      const prep = (c, canvas, k, ox, oy) => {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, canvas.width, canvas.height);
        c.setTransform(k, 0, 0, k, ox, oy);
        c.lineJoin = 'round'; c.lineCap = 'round'; c.textBaseline = 'middle'; c.setLineDash([]); c.globalAlpha = 1;
        ctx = c;
      };
      if (compact() && colBox.L) {
        // compact: edge columns, no attitude symbology
        const { L, R: Rb, T } = colBox;
        prep(lctx, cvL, dpr * L.k, -L.x0 * dpr * L.k, -L.y0 * dpr * L.k);
        drawSpeedTape(f, kt); drawReadouts(f, kt, 'L');
        prep(rctx, cvR, dpr * Rb.k, -Rb.x0 * dpr * Rb.k, -Rb.y0 * dpr * Rb.k);
        drawAltTape(f, ft); drawReadouts(f, kt, 'R');
        prep(tctx, cvT, dpr * T.k, -T.x0 * dpr * T.k, -T.y0 * dpr * T.k);
        drawHeadingTape(f, aptCache);
        ctx = mainCtx;
      } else {
        const k = dpr * s;
        prep(mainCtx, cv, k, cv.width / 2, cv.height / 2);
        const mode = shared.cameraMode;
        // attitude symbology only where it is meaningful: chase camera, airborne or rolling fast
        const attA = f.onGround ? smoothstep(25, 70, kt) : 1;
        if ((mode === 'chase' || !shared.camera) && !shared.lookingBack && f.quaternion && attA > 0.01) {
          attAlpha = attA; ctx.globalAlpha = attA; drawAttitude(f); ctx.globalAlpha = 1;
        }
        drawSpeedTape(f, kt);
        drawAltTape(f, ft);
        drawHeadingTape(f, aptCache);
        drawReadouts(f, kt);
      }
      drawSystems(f);
      updateFMA(f);
      infoTimer -= dt;
      if (infoTimer <= 0) { infoTimer = 0.25; updateInfo(f, infoArg.world); }
      mctx.setTransform(dpr * pscale, 0, 0, dpr * pscale, 0, 0);
      minimap.draw(mctx, MAP_DU, f, infoArg.world, att.hdg, pulse, navHooks && navHooks.overlay);
    },
    showMessage(textStr, ms = 1500) {
      const str = String(textStr ?? '');
      const km = str.match(/^kaza!?\s*(.*)$/i);
      if (km) {                                            // crash → the crash card instead of a toast
        if (km[1] || !ccReason.textContent) setCrashText(km[1]);
        if (!prev.crashed) { crash.classList.add('on'); ccard.classList.add('on'); prev.crashed = true; }
        return;
      }
      // short status messages ("Kamera: Takip") go to the small chip, the rest to the big toast
      const m = str.match(/^([^:]{2,18}):\s*(.{1,24})$/);
      if (ms <= 1200 && m) { showChip(m[1], m[2], Math.max(900, ms)); return; }
      if (ms <= 1000 && str.length <= 26) { showChip(str, '', Math.max(900, ms)); return; }
      toast.textContent = str;
      toast.classList.add('show');
      if (toast.animate) toast.animate([{ transform: 'translateX(-50%) scale(0.94)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), Math.max(300, ms));
    },
    /** H key: cycles the HUD full → compact → off (main.js calls this with a toggled boolean; the value is ignored). */
    setVisible() { return hud.cycleMode(); },
    /** Cycle full → compact → off; returns the Turkish mode name and shows a small chip. */
    cycleMode() {
      setMode(MODES[(MODES.indexOf(hudMode) + 1) % MODES.length]);
      showChip('Göstergeler', MODE_NAMES[hudMode], 1100);
      return MODE_NAMES[hudMode];
    },
    setMode(m) { setMode(m); return hudMode; },
    get mode() { return hudMode; },
    showHelp(bindings, show) {
      if (bindings !== helpBindings || !helpCard.firstChild || show) { helpBindings = bindings; buildHelp(bindings); }
      help.classList.toggle('show', !!show);
    },
    setPaused(p) {
      paused = !!p;
      pause.classList.toggle('show', paused);
      setText(psTxt, def && def.name ? `${def.name} · uçuş donduruldu` : 'Uçuş donduruldu');
      if (paused && !helpCard.firstChild) buildHelp(helpBindings || []);
    },
    get element() { return root; },
    /** Add an overlay layer (onboarding cards) above the instruments but below toasts, help and pause. */
    mountLayer(node) { root.insertBefore(node, toast); },
    /** Navigation hook (src/ui/map.js): the minimap opens the map (click) and draws the planned route. */
    setNavMap(hooks) {
      navHooks = hooks || null;
      injectCSS('hud-nav', NAV_CSS);
      mapPanel.classList.toggle('gkh-map-nav', !!navHooks);
      if (!mapPanel.dataset.nav) {
        mapPanel.dataset.nav = '1';
        mapPanel.title = 'Haritayı aç (J)';
        const ic = el('div', 'gkh-map-open', mapPanel);
        ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
        el('b', null, ic, 'J');
        mapPanel.addEventListener('click', () => { if (navHooks && navHooks.open) navHooks.open('mini'); });
      }
    },
    /**
     * Touch hook (src/ui/touch.js): px to keep free for the on-screen controls { left, right, top, bottom } — the compact
     * columns fit between them; minimap, systems panel, info panel and the camera bar give way (CSS in touch.js).
     */
    setTouchLayout(insets) {
      const first = !touchInsets;
      touchInsets = insets ? { left: insets.left || 0, right: insets.right || 0, top: insets.top || 0, bottom: insets.bottom || 0 } : null;
      root.classList.toggle('gkh-touch', !!touchInsets);
      if (first && touchInsets) {
        pbtns.insertBefore(restartBtn, menuBtn);
        help.addEventListener('click', (e) => { if (e.target === help && help.classList.contains('show')) pressKey(helpCode); });
        helpBindings = null;
      }
      layout();
    },
    /** Show "Eğitimi yeniden başlat" in the help overlay; fn restarts the flight tutorial. */
    setTutorialRestart(fn) { tutorialRestart = typeof fn === 'function' ? fn : null; helpBindings = null; },
  };
  window.addEventListener('gokyuzu:settings', (e) => {
    const m = e.detail && e.detail.hudMode;
    if (MODES.includes(m) && m !== hudMode) setMode(m, false);
  });
  applyVisibility();
  buildStrip();
  return hud;
}
