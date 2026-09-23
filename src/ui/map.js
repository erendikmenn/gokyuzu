// Navigation map (J or a click on the minimap): a large north-up map over the running game — the player keeps flying —
// with pan (drag), zoom (wheel / pinch / buttons), the aircraft, its track trail, airports with their real runways
// (data/sf/runways.json incl. KNGZ), landmarks, bridges, scale bars, and route planning on the shared Route
// (src/nav/route.js) that the autopilot flies (LNAV):
//   click on the map            add a waypoint (appended before an approach)       drag a waypoint   move it
//   click on a leg              insert a waypoint there (drag to place)            click a waypoint  altitude, Direkt git, Sil
//   click a runway end          "Bu piste yaklaş" (approach procedure → ILS / hover) or "Direkt git"
//   side panel                  default altitude + cruise speed, per-point altitude and speed (automatic values shown
//                               as "oto": 250 kt below 10,000 ft for airliners, approach speeds on the procedure legs;
//                               click a set value to return to automatic), "Rotayı uç" (autopilot in NAV), clear
// Same imagery and style as the minimap (baked bay map), sharpened at high zoom by the terrain's NAIP tiles
// (src/ui/map-tiles.js). Esc closes it before it can pause the game. Anonymous telemetry: 'map' (opened) and
// 'route' (flown: point count, approach runway) through src/core/telemetry.js (CONTRACTS-SF.md §11).
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp, fmtInt, fmtDec } from './util.js';
import { loadBayMap, BRIDGES } from './baymap.js';
import { AIRPORTS, LANDMARK_NAMES } from './data.js';
import { shared } from './shared.js';
import { REGION } from '../geo.js';
import { runwayEnds } from '../flight/fixedwing-autopilot.js';
import { NM } from '../nav/route.js';
import { legSpeed, autoCruise, ROUTE_SPEED, FIXED_SPEED_KINDS } from '../nav/speed.js';
import { drawRoute, drawAircraft, drawTrail, fmtFt } from './map-draw.js';
import { createDetailTiles } from './map-tiles.js';
import { trackEvent } from '../core/telemetry.js';

const FT = 0.3048, KT = 0.514444, DEG = Math.PI / 180;
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const TRAIL_CAP = 480;                       // track trail points (one per ~60 m / 2 s)
const S_MAX = 1.1;                           // max zoom (CSS px per meter)
const MAJOR_LANDMARKS = ['golden_gate_bridge', 'alcatraz', 'salesforce_tower', 'sutro_tower', 'coit_tower', 'bay_bridge_west'];
const ICON = {
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  rwy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3 7 21M15 3l2 18M12 5v2.5M12 11v2.5M12 17v2.5"/></svg>',
};

const CSS = `
.gkn { position: absolute; inset: 0; pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .22s ease, visibility 0s linear .22s;
  font-family: var(--gk-sans); color: var(--gk-fg); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; --gkn-mag: #ff6ee7; }
.gkn.open { opacity: 1; visibility: visible; transition: opacity .18s ease; }
.gkn-scrim { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(3, 8, 16, .34), rgba(2, 6, 12, .6)); }
.gkn-win { position: absolute; left: max(16px, 2.2vw); right: max(16px, 2.2vw); top: max(14px, 2.6vh); bottom: max(14px, 2.6vh);
  max-width: 1640px; margin: 0 auto; display: flex; flex-direction: column; pointer-events: auto; overflow: hidden;
  border-radius: 18px; border: 1px solid rgba(170, 205, 255, .16); background: rgba(7, 13, 24, .86);
  -webkit-backdrop-filter: blur(22px) saturate(1.2); backdrop-filter: blur(22px) saturate(1.2);
  box-shadow: 0 30px 80px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06); transform: scale(.985); transition: transform .22s cubic-bezier(.2, .9, .3, 1); }
.gkn.open .gkn-win { transform: none; }
.gkn-head { display: flex; align-items: center; gap: 18px; padding: 10px 12px 10px 18px; border-bottom: 1px solid rgba(255, 255, 255, .07); min-height: 50px; box-sizing: border-box; }
.gkn-title { display: flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 750; letter-spacing: .01em; white-space: nowrap; }
.gkn-title svg { width: 19px; height: 19px; color: var(--gk-teal); }
.gkn-title small { font-size: 12px; font-weight: 600; color: var(--gk-faint); letter-spacing: .02em; }
.gkn-strip { flex: 1 1 auto; display: flex; justify-content: center; gap: 4px; min-width: 0; overflow: hidden; }
.gkn-strip > span { display: flex; flex-direction: column; align-items: center; padding: 2px 11px; border-radius: 8px; min-width: 54px; }
.gkn-strip i { font-style: normal; font-size: 9px; font-weight: 750; letter-spacing: .14em; color: var(--gk-dim); }
.gkn-strip b { font: 700 14px var(--gk-mono); letter-spacing: -.02em; white-space: nowrap; }
.gkn-strip .gkn-ap b { color: #4be37a; }
.gkn-strip .gkn-ap.off b { color: var(--gk-faint); }
.gkn-strip .gkn-ap.nav b { color: var(--gkn-mag); }
.gkn-strip .gkn-wn { display: none; justify-content: center; padding: 4px 12px; font: 850 12.5px var(--gk-sans); letter-spacing: .14em; border-radius: 8px; border: 2px solid currentColor; }
.gkn-strip .gkn-wn.red { display: flex; color: var(--gk-warn); background: rgba(40, 6, 8, .7); animation: gkn-flash .6s steps(1, end) infinite; }
.gkn-strip .gkn-wn.amber { display: flex; color: var(--gk-caution); background: rgba(30, 20, 2, .7); }
@keyframes gkn-flash { 50% { opacity: .35; } }
.gkn-x { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 12px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .12);
  background: rgba(255, 255, 255, .05); color: var(--gk-dim); font: 650 12px var(--gk-sans); cursor: pointer; transition: background .15s, color .15s; }
.gkn-x:hover { background: rgba(255, 255, 255, .12); color: var(--gk-fg); }
.gkn-x svg { width: 15px; height: 15px; }
.gkn-x kbd { font: 700 10.5px var(--gk-sans); padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, .16); color: var(--gk-dim); }
.gkn-body { flex: 1 1 auto; display: flex; min-height: 0; }
.gkn-map { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; background: #0a1729; touch-action: none; cursor: crosshair; }
.gkn-map.pan { cursor: grabbing; }
.gkn-map.over-wp { cursor: grab; }
.gkn-map.over-rw, .gkn-map.over-leg { cursor: pointer; }
.gkn-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.gkn-ctl { position: absolute; right: 12px; top: 12px; display: flex; flex-direction: column; gap: 6px; }
.gkn-ctl button { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(8, 14, 26, .78); color: var(--gk-fg); cursor: pointer; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); transition: background .15s, border-color .15s; }
.gkn-ctl button:hover { background: rgba(30, 44, 66, .9); }
.gkn-ctl button.on { border-color: rgba(92, 242, 200, .7); color: var(--gk-teal); }
.gkn-ctl button svg { width: 17px; height: 17px; }
.gkn-ctl hr { width: 22px; margin: 2px auto; border: 0; border-top: 1px solid rgba(255, 255, 255, .1); }
.gkn-hint { position: absolute; left: 0; bottom: 0; right: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; pointer-events: none; padding: 16px 14px 9px;
  background: linear-gradient(180deg, rgba(4, 9, 18, 0), rgba(4, 9, 18, .62));
  font-size: 11.5px; font-weight: 600; color: rgba(220, 232, 248, .62); text-shadow: 0 1px 3px rgba(0, 0, 0, .9); }
.gkn-hint b { color: rgba(240, 246, 255, .92); font-weight: 750; }
.gkn-cur { position: absolute; left: 12px; top: 12px; padding: 5px 9px; border-radius: 8px; background: rgba(8, 14, 26, .72); pointer-events: none;
  font: 650 11.5px var(--gk-mono); color: rgba(236, 244, 255, .85); opacity: 0; transition: opacity .15s; }
.gkn-cur.on { opacity: 1; }
.gkn-pop { position: absolute; z-index: 3; min-width: 214px; max-width: 290px; padding: 12px 12px 11px; border-radius: 13px; display: none;
  background: rgba(10, 17, 30, .95); border: 1px solid rgba(170, 205, 255, .2); box-shadow: 0 16px 44px rgba(0, 0, 0, .5);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.gkn-pop.on { display: block; animation: gkn-pop .16s cubic-bezier(.2, .9, .3, 1.2); }
@keyframes gkn-pop { from { opacity: 0; transform: translateY(4px) scale(.97); } }
.gkn-pop h4 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 750; }
.gkn-pop h4 svg { width: 16px; height: 16px; color: var(--gk-teal); flex: 0 0 auto; }
.gkn-pop p { margin: 4px 0 0; font-size: 12px; line-height: 1.4; color: var(--gk-dim); }
.gkn-pop .gkn-row { display: flex; gap: 6px; margin-top: 10px; }
.gkn-pop .gkn-row .gkn-btn { flex: 1 1 auto; }
.gkn-pop .gkn-altrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 11.5px; color: var(--gk-dim); font-weight: 650; }
.gkn-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 12px; border-radius: 10px; cursor: pointer; white-space: nowrap;
  font: 700 12.5px var(--gk-sans); color: var(--gk-fg); background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .15); transition: background .15s, transform .15s, opacity .15s; }
.gkn-btn:hover { background: rgba(255, 255, 255, .13); }
.gkn-btn:active { transform: translateY(1px); }
.gkn-btn svg { width: 15px; height: 15px; }
.gkn-btn.primary { background: var(--gk-teal); color: #04140f; border-color: var(--gk-teal); }
.gkn-btn.primary:hover { background: #7ff7d6; }
.gkn-btn.mag { background: rgba(255, 110, 231, .16); border-color: rgba(255, 110, 231, .55); color: #ffd4f8; }
.gkn-btn.mag:hover { background: rgba(255, 110, 231, .26); }
.gkn-btn.ghost { background: none; border-color: rgba(255, 255, 255, .1); color: var(--gk-dim); font-weight: 650; }
.gkn-btn.ghost:hover { color: var(--gk-fg); background: rgba(255, 255, 255, .06); }
.gkn-btn:disabled { opacity: .42; cursor: default; transform: none; }
.gkn-btn.primary:disabled { opacity: 1; background: rgba(92, 242, 200, .08); border-color: rgba(92, 242, 200, .22); color: rgba(92, 242, 200, .55); }
.gkn-step { display: inline-flex; align-items: center; gap: 2px; border-radius: 9px; background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .1); }
.gkn-step button { width: 23px; height: 26px; display: grid; place-items: center; border: 0; background: none; color: var(--gk-dim); cursor: pointer; border-radius: 8px; }
.gkn-step button:hover { color: var(--gk-fg); background: rgba(255, 255, 255, .08); }
.gkn-step button svg { width: 13px; height: 13px; }
.gkn-step b { min-width: 56px; text-align: center; font: 700 12.5px var(--gk-mono); color: var(--gk-fg); }
.gkn-step b small { font: 600 10px var(--gk-sans); color: var(--gk-faint); margin-left: 2px; }
.gkn-step b.auto { color: var(--gk-dim); }
.gkn-step b i { font: 800 8px var(--gk-sans); font-style: normal; letter-spacing: .08em; color: var(--gk-teal); margin-left: 3px; vertical-align: 1px; }
.gkn-step b.reset { cursor: pointer; }
.gkn-step b.reset:hover { color: var(--gk-teal); }
.gkn-side { flex: 0 0 clamp(282px, 24vw, 350px); min-width: 0; overflow: hidden; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid rgba(255, 255, 255, .07); background: rgba(5, 10, 19, .5); }
.gkn-sh { padding: 14px 16px 12px; border-bottom: 1px solid rgba(255, 255, 255, .06); }
.gkn-sh h3 { margin: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 13px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--gk-teal); }
.gkn-sh h3 span { font: 650 11.5px var(--gk-mono); letter-spacing: 0; text-transform: none; color: var(--gk-dim); }
.gkn-status { display: flex; align-items: center; gap: 8px; margin: 10px 0 10px; font-size: 12.5px; font-weight: 600; color: var(--gk-dim); line-height: 1.35; }
.gkn-status i { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, .25); }
.gkn-status.nav i { background: var(--gkn-mag); box-shadow: 0 0 10px var(--gkn-mag); }
.gkn-status.nav { color: #ffd4f8; }
.gkn-status.on i { background: #4be37a; }
.gkn-fly { width: 100%; padding: 10px 12px; font-size: 13.5px; }
.gkn-defs { border-bottom: 1px solid rgba(255, 255, 255, .06); padding: 4px 0; }
.gkn-def { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 16px;
  font-size: 12px; font-weight: 650; color: var(--gk-dim); }
.gkn-list { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0; padding: 6px 8px 8px; list-style: none; }
.gkn-list::-webkit-scrollbar { width: 8px; } .gkn-list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .1); border-radius: 8px; }
.gkn-wp { display: flex; align-items: flex-start; gap: 7px; padding: 6px 4px 7px 7px; border-radius: 10px; border-left: 3px solid transparent; cursor: pointer; transition: background .12s; }
.gkn-wp:hover, .gkn-wp.sel { background: rgba(255, 255, 255, .06); }
.gkn-wp.act { border-left-color: var(--gkn-mag); background: rgba(255, 110, 231, .08); }
.gkn-wp.done { opacity: .45; }
.gkn-n { flex: 0 0 auto; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; border: 2px solid var(--gkn-mag); font: 800 11px var(--gk-sans); color: #ffe6fb; }
.gkn-wp.app .gkn-n { border-radius: 5px; transform: rotate(45deg) scale(.82); }
.gkn-wp.app .gkn-n span { transform: rotate(-45deg); font-size: 9px; }
.gkn-wp.act .gkn-n { background: var(--gkn-mag); color: #1a0716; }
.gkn-wm { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.gkn-wt { display: flex; align-items: center; gap: 2px; min-width: 0; }
.gkn-wc { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.gkn-wc .gkn-alt { font: 650 11.5px var(--gk-mono); color: rgba(236, 244, 255, .72); }
.gkn-n { margin-top: 2px; }
.gkn-wl { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.gkn-wl b { font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkn-wl small { font: 600 10.5px var(--gk-mono); color: var(--gk-faint); white-space: nowrap; }
.gkn-wl small.low { color: var(--gk-caution); }
.gkn-alt { font: 700 12px var(--gk-mono); color: rgba(236, 244, 255, .8); white-space: nowrap; }
.gkn-ic { flex: 0 0 auto; width: 24px; height: 26px; display: grid; place-items: center; border-radius: 8px; border: 0; background: none; color: var(--gk-faint); cursor: pointer; }
.gkn-ic:hover { color: var(--gk-fg); background: rgba(255, 255, 255, .09); }
.gkn-ic svg { width: 14px; height: 14px; }
.gkn-apph { display: flex; align-items: center; gap: 8px; margin: 10px 4px 4px 8px; font-size: 10.5px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #ffb3f1; }
.gkn-apph span { flex: 1 1 auto; }
.gkn-empty { padding: 14px 16px; font-size: 12.5px; line-height: 1.55; color: var(--gk-dim); }
.gkn-empty b { color: var(--gk-fg); }
.gkn-empty ul { margin: 8px 0 0; padding-left: 18px; } .gkn-empty li { margin: 3px 0; }
.gkn-warn { margin: 0 12px 8px; padding: 8px 10px; border-radius: 9px; background: rgba(255, 176, 32, .1); border: 1px solid rgba(255, 176, 32, .35); color: #ffd48a; font-size: 11.5px; line-height: 1.4; font-weight: 600; }
.gkn-warn:empty { display: none; }
.gkn-foot { padding: 10px 12px 12px; border-top: 1px solid rgba(255, 255, 255, .06); display: flex; gap: 8px; }
.gkn-foot .gkn-btn { flex: 1 1 auto; }
@media (max-width: 860px) {
  .gkn-body { flex-direction: column; }
  .gkn-side { flex: 0 0 auto; max-height: 42%; border-left: 0; border-top: 1px solid rgba(255, 255, 255, .08); }
  .gkn-strip { display: none; }
  .gkn-hint { display: none; }
}
@media (max-height: 560px) { .gkn-hint { display: none; } }
`;

function nmStr(m) { const nm = m / NM; return nm < 10 ? `${fmtDec(nm, 1)} NM` : `${fmtInt(nm)} NM`; }
const pad3 = (d) => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, '0');
const bearing = (x0, z0, x1, z1) => ((Math.atan2(x1 - x0, -(z1 - z0)) / DEG) + 360) % 360;

/**
 * createNavMap({ hud, route }) → { element, open(src), close(), toggle(src), isOpen, setFlight(flight, def),
 *   update(dt, flight, world), drawMinimapOverlay(ctx, X, Y, scale) }.
 * hud: the HUD (showMessage, mountMap); route: the shared src/nav/route.js Route (attached to the flight model).
 */
export function createNavMap({ hud, route }) {
  injectCSS('base', BASE_CSS);
  injectCSS('navmap', CSS);
  const root = el('div', 'gkn');
  root.setAttribute('lang', 'tr');
  el('div', 'gkn-scrim', root);
  const win = el('div', 'gkn-win', root);
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'Harita');
  // header: title, flight strip, close
  const head = el('div', 'gkn-head', win);
  const title = el('div', 'gkn-title', head);
  title.innerHTML = ICON.map;
  title.append('Harita');
  el('small', null, title, 'rota planlama');
  const strip = el('div', 'gkn-strip', head);
  const cell = (label, cls) => { const c = el('span', cls, strip); el('i', null, c, label); return el('b', null, c, '—'); };
  const sIas = cell('HIZ KT'), sAlt = cell('İRTİFA FT'), sHdg = cell('BAŞ'), sGs = cell('YER HIZI');
  const apCell = el('span', 'gkn-ap off', strip); el('i', null, apCell, 'OTOPİLOT'); const sAp = el('b', null, apCell, 'KAPALI');
  // the HUD's warnings sit under the map: the most urgent one is repeated here
  const wCell = el('span', 'gkn-wn', strip);
  const closeBtn = el('button', 'gkn-x', head);
  closeBtn.type = 'button';
  closeBtn.innerHTML = ICON.close;
  closeBtn.append('Kapat');
  el('kbd', null, closeBtn, 'J');
  // body: map + side panel
  const body = el('div', 'gkn-body', win);
  const mapEl = el('div', 'gkn-map', body);
  const cv = el('canvas', null, mapEl);
  const ctx = cv.getContext('2d');
  const ctl = el('div', 'gkn-ctl', mapEl);
  const mkCtl = (icon, t) => { const b = el('button', null, ctl); b.type = 'button'; b.innerHTML = icon; b.title = t; b.setAttribute('aria-label', t); return b; };
  const zIn = mkCtl(ICON.plus, 'Yakınlaştır'), zOut = mkCtl(ICON.minus, 'Uzaklaştır');
  el('hr', null, ctl);
  const bFollow = mkCtl(ICON.target, 'Uçağı ortala ve takip et'), bFit = mkCtl(ICON.fit, 'Tüm harita / rota');
  const cur = el('div', 'gkn-cur', mapEl);
  const hint = el('div', 'gkn-hint', mapEl);
  hint.innerHTML = '<span><b>Tıkla</b> nokta ekle</span><span><b>Sürükle</b> noktayı taşı · haritayı kaydır</span><span><b>Tekerlek</b> yakınlaştır</span><span><b>Pist ucuna tıkla</b> yaklaşma</span><span><b>J / Esc</b> kapat</span>';
  const pop = el('div', 'gkn-pop', mapEl);
  const side = el('aside', 'gkn-side', body);

  // ---------------------------------------------------------------- state
  let isOpen = false, flight = null, def = null, world = null, category = 'airliner';
  let W = 0, H = 0, dpr = 1;
  const view = { cx: 0, cz: -9000, s: 0.03 };
  let follow = true, viewInit = false, dirty = true, redrawT = 0, stripT = 0, loadingTiles = false;
  let base = null;                               // { img, meta } baked bay map
  loadBayMap().then((m) => { base = m; dirty = true; });
  const tiles = createDetailTiles();
  const trail = new Float32Array(TRAIL_CAP * 2);
  let trailHead = 0, trailCount = 0, trailT = 0;
  let sel = null, hover = null;                   // { type: 'wpt' | 'rw' | 'leg', id?, rw?, index? }
  let lastRouteVersion = -1, lastPanelKey = '', low = [];
  const pointers = new Map();
  let gesture = null;                            // { mode: 'pan' | 'drag' | 'pinch' | 'maybe', … }
  const X = (x) => W / 2 + (x - view.cx) * view.s;
  const Y = (z) => H / 2 + (z - view.cz) * view.s;
  const wx = (px) => view.cx + (px - W / 2) / view.s;
  const wz = (py) => view.cz + (py - H / 2) / view.s;
  const bounds = REGION.bounds;

  function sMin() { return Math.min(W / (bounds.maxX - bounds.minX), H / (bounds.maxZ - bounds.minZ)) * 0.82; }
  function clampView() {
    view.s = clamp(view.s, sMin(), S_MAX);
    const mx = 6000, mz = 6000;
    view.cx = clamp(view.cx, bounds.minX - mx, bounds.maxX + mx);
    view.cz = clamp(view.cz, bounds.minZ - mz, bounds.maxZ + mz);
  }
  function zoomAt(px, py, k) {
    const x = wx(px), z = wz(py);
    view.s = clamp(view.s * k, sMin(), S_MAX);
    view.cx = x - (px - W / 2) / view.s;
    view.cz = z - (py - H / 2) / view.s;
    clampView();
    dirty = true;
  }
  function fit(x0, z0, x1, z1, pad = 90) {
    const w = Math.max(x1 - x0, 1500), h = Math.max(z1 - z0, 1500);
    view.s = clamp(Math.min((W - pad * 2) / w, (H - pad * 2) / h), sMin(), 0.25);
    view.cx = (x0 + x1) / 2; view.cz = (z0 + z1) / 2;
    clampView();
    dirty = true;
  }
  function fitRoute() {
    const p = flight && flight.position;
    let x0 = p ? p.x : 0, x1 = x0, z0 = p ? p.z : 0, z1 = z0;
    for (const w of route.waypoints) { x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x); z0 = Math.min(z0, w.z); z1 = Math.max(z1, w.z); }
    if (route.waypoints.length) fit(x0, z0, x1, z1);
    else fit(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, 20);
  }

  function layout() {
    const r = mapEl.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    clampView();
    dirty = true;
  }
  window.addEventListener('resize', () => { if (isOpen) layout(); });

  // ---------------------------------------------------------------- world data
  const airports = () => { const r = (world && world.runways) || shared.runways; return r && Array.isArray(r.airports) ? r.airports : []; };
  const rwEnds = () => runwayEnds((world && world.runways) || shared.runways);
  const landmarks = () => (world && world.landmarks && Array.isArray(world.landmarks.landmarks) ? world.landmarks.landmarks : []);
  const heli = () => category === 'helicopter';
  const altStep = () => (heli() ? 100 : 500) * FT;

  // ---------------------------------------------------------------- hit testing (CSS px)
  function hitTest(px, py) {
    const Wp = route.waypoints;
    let best = null, bd = 14;
    for (let i = Wp.length - 1; i >= 0; i--) {
      const d = Math.hypot(X(Wp[i].x) - px, Y(Wp[i].z) - py);
      if (d < bd) { bd = d; best = { type: 'wpt', id: Wp[i].id }; }
    }
    if (best) return best;
    // runway ends: the threshold and the first ~12 % of the runway
    let rb = null, rd = 16;
    for (const e of rwEnds()) {
      const tx = X(e.x), ty = Y(e.z);
      let d = Math.hypot(tx - px, ty - py);
      const ux = e.dx, uz = e.dz, L = Math.min(e.length * 0.14, 500) * view.s;
      const ax = px - tx, ay = py - ty, t = clamp(ax * ux + ay * uz, 0, L);
      d = Math.min(d, Math.hypot(ax - ux * t, ay - uz * t) + 3);
      if (d < rd) { rd = d; rb = e; }
    }
    if (rb) return { type: 'rw', rw: rb };
    // legs into user points and into the first approach point: insert a user waypoint
    const nu = route.user.length;
    for (let i = 0; i < Wp.length && i <= nu; i++) {
      if (i < route.active && route.hasActive) continue;
      const a = i === 0 ? (route.hasActive && route.active === 0 ? route.origin : null) : Wp[i - 1];
      if (!a) continue;
      const x0 = X(a.x), y0 = Y(a.z), x1 = X(Wp[i].x), y1 = Y(Wp[i].z);
      const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
      if (L2 < 400) continue;
      const t = clamp(((px - x0) * dx + (py - y0) * dy) / L2, 0.08, 0.92);
      if (Math.hypot(x0 + dx * t - px, y0 + dy * t - py) < 7) return { type: 'leg', index: i };
    }
    return null;
  }

  // ---------------------------------------------------------------- actions
  function say(text, ms = 2200) { if (hud && hud.showMessage) hud.showMessage(text, ms); }
  function airborne() { return !!flight && !flight.crashed && !flight.onGround && !(flight.agl < 25); }
  function acId() { return (def && def.id) || (flight && flight.spec && flight.spec.id) || ''; }
  function ensureDefaultAlt() {
    if (route.defaultAlt != null || !flight) return;
    const cur = Math.round((flight.altitude || 0) / (500 * FT)) * 500 * FT;
    const floor = (flight.onGround ? (heli() ? 1000 : 3000) : (heli() ? 500 : 1500)) * FT;
    route.setDefaultAlt(Math.max(cur, floor));
  }
  function envForRoute() {
    if (!world) return null;
    return {
      groundAt: (x, z) => { const h = world.getGroundHeight(x, z); return Number.isFinite(h) ? h : 0; },
      obstacleAt: world.getObstacleHeight ? (x, z) => world.getObstacleHeight(x, z) : null,
      bounds: (world.region && world.region.local) || bounds,
    };
  }
  /** Engage / switch the autopilot to the route (LNAV). */
  function flyRoute(kind = 'fly') {
    if (!flight || !route.hasActive) return false;
    if (!airborne()) { say('Otopilot yerde açılamaz: kalkıştan sonra O tuşu ya da «Rotayı uç»', 2600); return false; }
    const was = flight.autopilot && flight.autopilot.on;
    const man = was && flight.autopilot.athr === false;
    const ok = flight.engageNav ? flight.engageNav() : false;
    if (!ok) { say('Otopilot şu an rotaya bağlanamıyor', 1800); return false; }
    const A = route.approach;
    // anonymous: aircraft, number of user points, approach runway (e.g. KSFO28R), how it was engaged (fly / dir / app)
    trackEvent('route', { ac: acId(), pt: route.user.length, rw: A ? A.name.replace(/\s+/g, '') : '', k: kind });
    if (!was) say(heli() ? 'AFCS rotada: NAV' : 'Otopilot rotada: LNAV', 1600);
    else if (man) say('A/THR: rota hızı yeniden tutuluyor', 1400);
    dirty = true; lastPanelKey = '';
    return true;
  }
  function addPoint(x, z, index) {
    ensureDefaultAlt();
    const w = route.add(x, z, index == null ? {} : { index });
    sel = { type: 'wpt', id: w.id };
    return w;
  }
  function directTo(id) {
    route.directTo(id);
    if (!flyRoute('dir') && !airborne()) say('Direkt rota hazır: kalkıştan sonra O ile otopilotu aç', 2200);
    sel = null; closePop();
  }
  function approach(rw) {
    const cat = category;
    route.env = envForRoute();
    route.setApproach(rw, cat, route.env);
    const code = (AIRPORTS[rw.airport] && AIRPORTS[rw.airport].code) || rw.airport;
    sel = null; closePop();
    const cfg = category === 'airliner' ? ' · flap ve iniş takımı zamanında otomatik iner' : category === 'fighter' ? ' · iniş takımı zamanında otomatik iner' : '';
    if (flyRoute('app')) say(`${code} ${rw.ident} yaklaşması: otopilot ${heli() ? 'piste getirip askıda tutacak' : 'ILS ile indirecek'}${cfg}`, 3400);
    else if (!airborne()) say(`${code} ${rw.ident} yaklaşması hazır: kalkıştan sonra «Rotayı uç»`, 2400);
    const apt = route.approach;
    if (apt) {                                        // show the whole procedure
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const w of apt.points) { x0 = Math.min(x0, w.x); x1 = Math.max(x1, w.x); z0 = Math.min(z0, w.z); z1 = Math.max(z1, w.z); }
      if (flight) { x0 = Math.min(x0, flight.position.x); x1 = Math.max(x1, flight.position.x); z0 = Math.min(z0, flight.position.z); z1 = Math.max(z1, flight.position.z); }
      follow = false; bFollow.classList.remove('on');
      fit(x0, z0, x1, z1, 70);
    }
  }
  function setAlt(id, dir) {
    const w = route.byId(id);
    if (!w || w.fixedAlt) return;
    const cur = route.altFor(w) ?? (flight ? flight.altitude : 1000);
    const st = altStep();
    route.setAlt(id, clamp(Math.round(cur / st) * st + dir * st, (heli() ? 200 : 1000) * FT, (heli() ? 10000 : 39000) * FT));
  }
  function setDefault(dir) {
    const st = altStep();
    const cur = route.defaultAlt ?? (flight ? flight.altitude : 1000);
    route.setDefaultAlt(clamp(Math.round(cur / st) * st + dir * st, (heli() ? 200 : 1000) * FT, (heli() ? 10000 : 39000) * FT));
  }
  // speeds: the leg's effective speed (own / route default / automatic), stepped in 10 kt or Mach 0.01–0.05
  const _sp = { ias: NaN, mach: NaN, auto: true, src: 'auto' };
  const legAlt = (w) => route.altFor(w) ?? (flight ? flight.altitude : 0);
  const spdOf = (w) => legSpeed(route, w, category, legAlt(w), _sp);
  const spdNum = (sp) => (Number.isFinite(sp.mach) ? `M${sp.mach.toFixed(2)}` : String(Math.round(sp.ias / KT)));
  const spdUnit = (sp) => (Number.isFinite(sp.mach) ? '' : 'kt');
  function stepSpeed(sp, dir) {
    const P = ROUTE_SPEED[category] || ROUTE_SPEED.airliner;
    if (Number.isFinite(sp.mach)) {
      const st = P.machStep || 0.05;
      return { mach: Math.round(clamp(Math.round(sp.mach / st) * st + dir * st, P.machMin, P.machMax) * 100) / 100 };
    }
    return { ias: clamp(Math.round(sp.ias / KT / P.step) * P.step + dir * P.step, P.min, P.max) * KT };
  }
  function setSpd(id, dir) { const w = route.byId(id); if (w && !w.fixedSpd) route.setSpeed(id, stepSpeed({ ...spdOf(w) }, dir)); }
  function defaultSpd() {
    if (route.defaultSpd != null) return { ias: route.defaultSpd, mach: NaN, auto: false };
    if (route.defaultMach != null) return { ias: NaN, mach: route.defaultMach, auto: false };
    const a = autoCruise(category, route.defaultAlt ?? (flight ? flight.altitude : 0), {});
    a.auto = true;
    return a;
  }
  function spdStepper(w) {
    const sp = spdOf(w);
    const view = () => { const v = spdOf(w); return { text: spdNum(v), unit: spdUnit(v), dim: v.src !== 'wpt', auto: v.auto, reset: v.src === 'wpt' }; };
    return stepper(view, (d) => setSpd(w.id, d), () => route.setSpeed(w.id, {}));
  }
  /** Map label: "250 kt" (automatic values too), '' where the final's own logic flies. */
  function speedText(w) {
    if (w.kind === 'thr' || w.kind === 'hov') return '';
    const sp = spdOf(w);
    return Number.isFinite(sp.mach) ? `M${sp.mach.toFixed(2)}` : `${Math.round(sp.ias / KT)} kt`;
  }

  // ---------------------------------------------------------------- popup
  function closePop() { pop.classList.remove('on'); pop.textContent = ''; popFor = null; popStale = false; }
  let popFor = null;
  function showPop(target) {
    popFor = target; popStale = false;
    pop.textContent = '';
    if (target.type === 'wpt') {
      const w = route.byId(target.id);
      if (!w) { closePop(); return; }
      const h4 = el('h4', null, pop);
      if (w.kind === 'wpt') {
        h4.append(`Nokta ${w.name}`);
        const i = route.indexOf(w.id);
        const prev = i > 0 ? route.waypoints[i - 1] : (flight ? { x: flight.position.x, z: flight.position.z } : null);
        if (prev) el('p', null, pop, `${i > 0 ? 'Önceki noktadan' : 'Uçaktan'} ${nmStr(Math.hypot(w.x - prev.x, w.z - prev.z))} · ${pad3(bearing(prev.x, prev.z, w.x, w.z))}°`);
        const ar = el('div', 'gkn-altrow', pop);
        el('span', null, ar, 'İrtifa');
        ar.append(altStepper(w));
        const sr = el('div', 'gkn-altrow', pop);
        el('span', null, sr, 'Hız');
        sr.append(spdStepper(w));
        const row = el('div', 'gkn-row', pop);
        btn(row, 'mag', `${ICON.go}Direkt git`, () => directTo(w.id));
        btn(row, 'ghost', `${ICON.del}Sil`, () => { route.remove(w.id); sel = null; closePop(); });
      } else {
        h4.innerHTML = ICON.rwy;
        const rwN = w.rw ? w.rw.replace(/^(\w+)\s/, (m, a) => `${(AIRPORTS[a] && AIRPORTS[a].code) || a} `) : '';
        const what = { base: 'Giriş noktası (45° ile son yaklaşmaya bağlanır)', if: 'IF · ara yaklaşma noktası', faf: 'FAF · süzülüş başlangıcı', thr: 'Pist eşiği', hov: 'Askıda kalma noktası' }[w.kind] || w.name;
        h4.append(w.kind === 'thr' ? `Pist ${w.name}` : w.name);
        const rwEnd = route.approach && route.approach.rw;
        const dThr = rwEnd ? Math.hypot(w.x - rwEnd.x, w.z - rwEnd.z) : 0;
        el('p', null, pop, `${what}${rwN ? ` · ${rwN}` : ''}${w.kind !== 'thr' && w.kind !== 'hov' && dThr ? ` · ${nmStr(dThr)}` : ''}${w.alt != null && w.kind !== 'thr' ? ` · ${fmtFt(w.alt)} ft` : ''}`);
        if (!w.fixedSpd) { const sr = el('div', 'gkn-altrow', pop); el('span', null, sr, 'Hız'); sr.append(spdStepper(w)); }
        else if (w.kind === 'faf') el('p', null, pop, `Hız ${speedText(w)}, G/S yakalanınca yaklaşma hızına iner.`);
        const row = el('div', 'gkn-row', pop);
        if (w.kind !== 'thr') btn(row, 'mag', `${ICON.go}Direkt git`, () => directTo(w.id));
        btn(row, 'ghost', `${ICON.del}Yaklaşmayı kaldır`, () => { route.clearApproach(); sel = null; closePop(); });
      }
    } else if (target.type === 'rw') {
      const e = target.rw;
      const code = (AIRPORTS[e.airport] && AIRPORTS[e.airport].code) || e.airport;
      const h4 = el('h4', null, pop);
      h4.innerHTML = ICON.rwy;
      h4.append(`${code} · Pist ${e.ident}`);
      el('p', null, pop, `${(AIRPORTS[e.airport] && AIRPORTS[e.airport].name) || e.airport} · ${pad3(e.course / DEG)}° · ${fmtInt(e.length)} m`);
      el('p', null, pop, heli() ? 'Yaklaşma: 1,5 NM son yaklaşma, pist başında askıda kalma.' : 'Yaklaşma: giriş, IF, ILS ile süzülüş ve otomatik iniş.');
      const row = el('div', 'gkn-row', pop);
      btn(row, 'primary', `${ICON.rwy}Bu piste yaklaş`, () => approach(e));
      btn(row, 'ghost', `${ICON.go}Direkt git`, () => { ensureDefaultAlt(); route.directToPoint(e.x, e.z); directTo(route.waypoints[0].id); });
    }
    pop.classList.add('on');
    placePop();
  }
  function placePop() {
    if (!popFor) return;
    let x, z;
    if (popFor.type === 'wpt') { const w = route.byId(popFor.id); if (!w) { closePop(); return; } x = w.x; z = w.z; }
    else { x = popFor.rw.x; z = popFor.rw.z; }
    const px = X(x), py = Y(z);
    const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 120;
    let left = px + 22, top = py - ph / 2;
    if (left + pw > W - 56) left = px - 22 - pw;
    left = clamp(left, 8, Math.max(8, W - pw - 8)); top = clamp(top, 8, Math.max(8, H - ph - 8));
    pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`;
  }
  function btn(parent, cls, html, fn) {
    const b = el('button', `gkn-btn ${cls}`, parent);
    b.type = 'button'; b.innerHTML = html;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); b.blur(); fn(); dirty = true; });
    return b;
  }
  /**
   * −/+ stepper. view() → { text, unit, dim (from a default), auto ("oto" tag), reset (a click on the value returns to
   * the default) }. The value re-renders in place and the panel / popup rebuild waits for a pause in the clicking, so
   * quick repeated clicks all land on the same buttons.
   */
  function stepper(view, fn, reset = null) {
    const s = el('span', 'gkn-step');
    const m = el('button', null, s); m.type = 'button'; m.innerHTML = ICON.minus; m.title = 'Azalt';
    const b = el('b', null, s);
    const p = el('button', null, s); p.type = 'button'; p.innerHTML = ICON.plus; p.title = 'Artır';
    const render = () => {
      const v = view();
      b.textContent = '';
      b.className = `${v.dim ? 'auto' : ''}${v.reset && reset ? ' reset' : ''}`;
      b.title = v.reset && reset ? 'Otomatiğe / varsayılana dön' : '';
      b.append(v.text);
      if (v.unit) el('small', null, b, v.unit);
      if (v.auto) el('i', null, b, 'oto');
    };
    const act = (ev, f) => { ev.stopPropagation(); f(); uiHoldUntil = performance.now() + 700; render(); dirty = true; };
    b.addEventListener('click', (ev) => { if (reset && b.classList.contains('reset')) act(ev, reset); });
    m.addEventListener('click', (ev) => act(ev, () => fn(-1)));
    p.addEventListener('click', (ev) => act(ev, () => fn(1)));
    render();
    return s;
  }
  let uiHoldUntil = 0, popStale = false;
  function altStepper(w) {
    const view = () => { const a = route.altFor(w); return { text: a != null ? fmtFt(a) : 'mevcut', unit: a != null ? 'ft' : '', dim: w.alt == null, reset: w.alt != null }; };
    return stepper(view, (d) => setAlt(w.id, d), () => route.setAlt(w.id, null));
  }

  // ---------------------------------------------------------------- side panel (rebuilt when the route / AP state changes)
  function panelKey() {
    const ap = flight && flight.autopilot;
    return `${route.version}|${route.active}|${route.finished}|${ap && ap.on}|${ap && ap.lnav}|${ap && ap.athr}|${ap && ap.mode}|${airborne()}|${sel && (sel.id || '')}`;
  }
  function buildPanel() {
    side.textContent = '';
    const sh = el('div', 'gkn-sh', side);
    const h3 = el('h3', null, sh, 'Rota');
    const n = route.waypoints.length;
    if (n) el('span', null, h3, `${n} nokta · ${nmStr(route.hasActive ? route.remaining() : 0)}${gsEta()}`);
    const ap = flight && flight.autopilot;
    const onNav = !!(ap && ap.on && ap.lnav);
    const st = el('div', `gkn-status${onNav ? ' nav' : ap && ap.on ? ' on' : ''}`, sh);
    el('i', null, st);
    let txt;
    if (!n) txt = 'Rota yok: haritaya tıklayarak nokta ekle.';
    else if (!route.hasActive) txt = 'Rota tamamlandı.';
    else if (onNav && ap.athr === false) txt = 'Otopilot rotada, gaz sende (A/THR kapalı). «A/THR aç» ile hız yeniden tutulur.';
    else if (onNav) txt = heli() ? 'AFCS rotayı uçuyor (NAV).' : `Otopilot rotayı uçuyor (${String(ap.mode || 'NAV').split(' ')[0]}${category === 'fighter' ? ', A/THR' : ''}).`;
    else if (ap && ap.on) txt = 'Otopilot açık, rota beklemede (HDG).';
    else if (!airborne()) txt = 'Yerde: kalkıştan sonra otopilot rotaya bağlanır.';
    else txt = 'Otopilot kapalı: rota rehber olarak gösteriliyor.';
    el('span', null, st, txt);
    const manThr = onNav && ap.athr === false;
    const fly = btn(sh, 'primary gkn-fly', `${ICON.plane}${manThr ? 'A/THR aç' : onNav ? 'Rotada' : 'Rotayı uç'}`, () => flyRoute('fly'));
    fly.disabled = !route.hasActive || (onNav && !manThr) || !airborne();
    fly.title = 'Otopilotu rotada (LNAV) açar · O tuşu da rota varken rotayı uçar';
    // route defaults: altitude and cruise speed
    const defs = el('div', 'gkn-defs', side);
    const dRow = el('div', 'gkn-def', defs);
    el('span', null, dRow, 'Varsayılan irtifa');
    dRow.append(stepper(() => ({ text: route.defaultAlt != null ? fmtFt(route.defaultAlt) : 'mevcut', unit: route.defaultAlt != null ? 'ft' : '', dim: route.defaultAlt == null }), setDefault));
    const sRow = el('div', 'gkn-def', defs);
    el('span', null, sRow, 'Seyir hızı');
    const dsView = () => { const v = defaultSpd(); return { text: spdNum(v), unit: spdUnit(v), dim: v.auto, auto: v.auto, reset: !v.auto }; };
    sRow.append(stepper(dsView, (d) => route.setDefaultSpeed(stepSpeed(defaultSpd(), d)), () => route.setDefaultSpeed({})));
    sRow.title = category === 'airliner' ? 'Otomatik: 10.000 ft altında 250 kt, üstünde 290 kt / M0.78' : category === 'fighter' ? 'Otomatik: 350 kt, 25.000 ft üstünde M0.85' : 'Otomatik: 110 kt (40–150 kt)';
    // list
    const list = el('ol', 'gkn-list', side);
    if (!n) {
      const e = el('div', 'gkn-empty', side);
      e.innerHTML = '<b>Nasıl kullanılır</b><ul><li>Haritaya tıkla: nokta ekle, sürükle: taşı.</li><li>Bir noktaya tıkla: irtifa, <b>Direkt git</b>, sil.</li><li>Bir pist ucuna tıkla: <b>Bu piste yaklaş</b>. Otopilot yaklaşmayı uçar' + (heli() ? ', pist başında askıda kalır.' : ', ILS ile indirir.') + '</li><li><b>Rotayı uç</b> ya da O: otopilot rotayı izler; A / D ile dönmek yön moduna geçirir.</li></ul>';
      list.remove();
    }
    const W0 = route.waypoints, act = route.hasActive ? route.active : n;
    const warn = [];
    for (let i = 0; i < n; i++) {
      const w = W0[i];
      if (route.approach && i === route.user.length) {
        const hdr = el('li', 'gkn-apph', list);
        const rw = route.approach.rw;
        el('span', null, hdr, `Yaklaşma · ${(AIRPORTS[rw.airport] && AIRPORTS[rw.airport].code) || rw.airport} ${rw.ident}`);
        const x = el('button', 'gkn-ic', hdr); x.type = 'button'; x.innerHTML = ICON.del; x.title = 'Yaklaşmayı kaldır';
        x.addEventListener('click', (ev) => { ev.stopPropagation(); route.clearApproach(); dirty = true; });
      }
      const li = el('li', `gkn-wp${w.kind !== 'wpt' ? ' app' : ''}${i === act ? ' act' : ''}${i < act ? ' done' : ''}${sel && sel.id === w.id ? ' sel' : ''}`, list);
      const nEl = el('span', 'gkn-n', li);
      el('span', null, nEl, w.kind === 'wpt' ? w.name : w.kind === 'thr' ? '▲' : w.kind === 'hov' ? 'H' : w.kind === 'base' ? 'G' : w.kind === 'if' ? 'IF' : 'F');
      const main = el('div', 'gkn-wm', li);
      const top = el('div', 'gkn-wt', main);
      const wl = el('span', 'gkn-wl', top);
      el('b', null, wl, w.kind === 'wpt' ? `Nokta ${w.name}` : w.kind === 'thr' ? `Pist ${w.name}` : w.kind === 'hov' ? `Askı · ${w.name}` : w.name);
      const prev = i > 0 ? W0[i - 1] : (route.hasActive && act === 0 ? route.origin : null);
      const small = el('small', low[i] ? 'low' : null, wl, prev ? `${nmStr(Math.hypot(w.x - prev.x, w.z - prev.z))} · ${pad3(bearing(prev.x, prev.z, w.x, w.z))}°` : '');
      if (low[i]) { small.textContent += ' · alçak!'; }
      if (i >= act && w.kind !== 'thr') {
        const d = el('button', 'gkn-ic', top); d.type = 'button'; d.innerHTML = ICON.go; d.title = 'Direkt git';
        d.addEventListener('click', (ev) => { ev.stopPropagation(); directTo(w.id); dirty = true; });
      }
      if (w.kind === 'wpt') {
        const x = el('button', 'gkn-ic', top); x.type = 'button'; x.innerHTML = ICON.del; x.title = 'Sil';
        x.addEventListener('click', (ev) => { ev.stopPropagation(); route.remove(w.id); if (sel && sel.id === w.id) { sel = null; closePop(); } dirty = true; });
      }
      // altitude + speed of the leg into this point (steppers ahead of the aircraft, text for the rest)
      const cr = el('div', 'gkn-wc', main);
      const altTxt = w.kind === 'thr' ? '' : route.altFor(w) != null ? `${fmtFt(route.altFor(w))} ft` : '';
      if (w.kind === 'thr') el('span', 'gkn-alt', cr, heli() ? '' : category === 'airliner' ? 'ILS · otomatik iniş' : 'ILS · teker koyunca devir');
      else if (w.kind === 'hov') el('span', 'gkn-alt', cr, `${altTxt ? `${altTxt} · ` : ''}yavaşla, askıda kal`);
      else if (i < act) el('span', 'gkn-alt', cr, `${altTxt}${altTxt ? ' · ' : ''}${speedText(w)}`);
      else {
        if (w.kind === 'wpt') cr.append(altStepper(w)); else if (altTxt) el('span', 'gkn-alt', cr, altTxt);
        if (w.fixedSpd) el('span', 'gkn-alt', cr, `${altTxt ? '· ' : ''}${speedText(w)}`);
        else cr.append(spdStepper(w));
      }
      li.addEventListener('click', () => { sel = { type: 'wpt', id: w.id }; follow = false; bFollow.classList.remove('on'); centerOn(w.x, w.z); showPop(sel); dirty = true; lastPanelKey = ''; });
      if (low[i] && i >= act) warn.push(`${i > 0 ? W0[i - 1].name : 'Uçak'} → ${w.name}: arazi / engel ${fmtFt(lowTop[i])} ft, rota ${fmtFt(route.altFor(w) ?? (flight ? flight.altitude : 0))} ft`);
    }
    const wEl = el('div', 'gkn-warn', side);
    if (warn.length) wEl.textContent = `Dikkat, alçak bacak: ${warn.slice(0, 2).join(' · ')}`;
    const foot = el('div', 'gkn-foot', side);
    const clr = btn(foot, 'ghost', `${ICON.del}Rotayı temizle`, () => { route.clear(); sel = null; closePop(); });
    clr.disabled = !n;
    const fitB = btn(foot, 'ghost', `${ICON.fit}Rotayı göster`, () => { follow = false; bFollow.classList.remove('on'); fitRoute(); });
    fitB.disabled = !n;
  }
  function gsEta() {
    const gs = flight && flight.velocity ? Math.hypot(flight.velocity.x, flight.velocity.z) : 0;
    if (gs < 20 || !route.hasActive) return '';
    const min = route.remaining() / gs / 60;
    return ` · ~${min < 1 ? '<1' : Math.round(min)} dk`;
  }
  function centerOn(x, z) { view.cx = x; view.cz = z; clampView(); dirty = true; }

  // terrain / obstacle clearance of the legs (recomputed after edits)
  let lowTop = [];
  function updateClearance() {
    const env = envForRoute();
    if (!env) { low = []; lowTop = []; return; }
    const tops = route.clearance(env);
    lowTop = tops;
    low = tops.map((t, i) => {
      const w = route.waypoints[i];
      if (!w || w.kind === 'thr' || w.kind === 'hov' || w.kind === 'faf') return false;
      const a = route.altFor(w) ?? (flight ? flight.altitude : Infinity);
      return Number.isFinite(t) && a < t + (heli() ? 60 : 150);
    });
  }

  // ---------------------------------------------------------------- pointer input
  function localXY(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  mapEl.addEventListener('pointerdown', (e) => {
    if (e.target !== cv) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone (iOS cancel) or synthetic: keep going without capture */ }
    const [px, py] = localXY(e);
    pointers.set(e.pointerId, { x: px, y: py });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, wx: wx((a.x + b.x) / 2), wz: wz((a.y + b.y) / 2) };
      return;
    }
    gesture = { mode: 'maybe', x0: px, y0: py, cx: view.cx, cz: view.cz, hit: hitTest(px, py), id: e.pointerId };
  });
  mapEl.addEventListener('pointermove', (e) => {
    const [px, py] = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: px, y: py });
    if (!gesture) {
      // hover feedback + cursor readout
      const h = e.target === cv ? hitTest(px, py) : null;
      const key = h ? `${h.type}${h.id || (h.rw && h.rw.name) || h.index}` : '';
      const old = hover ? `${hover.type}${hover.id || (hover.rw && hover.rw.name) || hover.index}` : '';
      if (key !== old) { hover = h; dirty = true; }
      mapEl.classList.toggle('over-wp', !!h && h.type === 'wpt');
      mapEl.classList.toggle('over-rw', !!h && h.type === 'rw');
      mapEl.classList.toggle('over-leg', !!h && h.type === 'leg');
      if (flight && e.target === cv) {
        const x = wx(px), z = wz(py), p = flight.position;
        cur.textContent = h && h.type === 'rw' ? `${(AIRPORTS[h.rw.airport] && AIRPORTS[h.rw.airport].code) || h.rw.airport} ${h.rw.ident} · ${pad3(h.rw.course / DEG)}°` : `${pad3(bearing(p.x, p.z, x, z))}° · ${nmStr(Math.hypot(x - p.x, z - p.z))}`;
        cur.classList.add('on');
      }
      return;
    }
    if (gesture.mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      view.s = clamp(gesture.s0 * d / Math.max(gesture.d0, 1), sMin(), S_MAX);
      view.cx = gesture.wx - (mx - W / 2) / view.s; view.cz = gesture.wz - (my - H / 2) / view.s;
      clampView(); follow = false; bFollow.classList.remove('on'); dirty = true;
      return;
    }
    if (e.pointerId !== gesture.id) return;
    const moved = Math.hypot(px - gesture.x0, py - gesture.y0);
    if (gesture.mode === 'maybe' && moved > 5) {
      const h = gesture.hit;
      if (h && h.type === 'wpt' && route.byId(h.id) && route.byId(h.id).kind === 'wpt') gesture.mode = 'drag';
      else if (h && h.type === 'leg') {
        const w = addPoint(wx(px), wz(py), h.index);
        gesture.hit = { type: 'wpt', id: w.id }; gesture.mode = 'drag';
      } else { gesture.mode = 'pan'; mapEl.classList.add('pan'); follow = false; bFollow.classList.remove('on'); }
      closePop();
    }
    if (gesture.mode === 'drag') { route.move(gesture.hit.id, wx(px), wz(py)); sel = { type: 'wpt', id: gesture.hit.id }; dirty = true; }
    else if (gesture.mode === 'pan') {
      view.cx = gesture.cx - (px - gesture.x0) / view.s; view.cz = gesture.cz - (py - gesture.y0) / view.s;
      clampView(); dirty = true;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.mode === 'pinch') { if (pointers.size === 0) gesture = null; return; }
    if (e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    mapEl.classList.remove('pan');
    if (e.type === 'pointercancel') return;
    if (g.mode === 'drag') { sel = { type: 'wpt', id: g.hit.id }; lastPanelKey = ''; return; }
    if (g.mode !== 'maybe') return;
    // a click
    const h = g.hit;
    // (a click on the empty map while a popup is open only dismisses it; otherwise it adds a point — no popup, so a
    // route is built with a quick series of clicks)
    if (h && (h.type === 'wpt' || h.type === 'rw')) { sel = h; showPop(h); }
    else if (popFor) { sel = null; closePop(); }
    else if (h && h.type === 'leg') { const [px, py] = localXY(e); addPoint(wx(px), wz(py), h.index); }
    else { const [px, py] = localXY(e); addPoint(wx(px), wz(py)); }
    dirty = true; lastPanelKey = '';
  };
  mapEl.addEventListener('pointerup', endPointer);
  mapEl.addEventListener('pointercancel', endPointer);
  mapEl.addEventListener('pointerleave', () => { if (!gesture) { cur.classList.remove('on'); if (hover) { hover = null; dirty = true; } } });
  mapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = localXY(e);
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022) * (e.deltaMode === 1 ? 16 : 1));
    zoomAt(px, py, k);
    follow = false; bFollow.classList.remove('on');
    placePop();
  }, { passive: false });
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());
  zIn.addEventListener('click', () => { zoomAt(W / 2, H / 2, 1.6); placePop(); });
  zOut.addEventListener('click', () => { zoomAt(W / 2, H / 2, 1 / 1.6); placePop(); });
  bFollow.addEventListener('click', () => { follow = true; bFollow.classList.add('on'); if (view.s < 0.05) view.s = 0.07; clampView(); dirty = true; });
  bFit.addEventListener('click', () => { follow = false; bFollow.classList.remove('on'); fitRoute(); });
  closeBtn.addEventListener('click', () => api.close());
  // Esc closes the popup, then the map (before the game's pause); Delete / Backspace removes the selected point
  window.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (popFor) { sel = null; closePop(); dirty = true; } else api.close();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && sel && sel.type === 'wpt') {
      const w = route.byId(sel.id);
      if (w && w.kind === 'wpt') { e.preventDefault(); route.remove(w.id); sel = null; closePop(); dirty = true; }
    }
  }, true);
  let clearT = 0, clearDirty = true;
  route.on(() => { dirty = true; clearDirty = true; });
  // buttons never keep the keyboard focus (Space = brake, Enter … must reach the game, not click a focused button)
  root.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });

  // ---------------------------------------------------------------- drawing
  const placed = [];
  function label(str, x, y, color, font, prefer = 'right', halo = 'rgba(4,9,18,0.8)') {
    ctx.font = font;
    const w = ctx.measureText(str).width, h = 13;
    const cands = prefer === 'center' ? [[x - w / 2, y]] : [[x + 7, y], [x - 7 - w, y]];
    for (const [x0, cy] of cands) {
      const y0 = cy - h / 2;
      if (x0 < 4 || x0 + w > W - 4 || y0 < 4 || y0 + h > H - 4) continue;
      let hit = false;
      for (let k = 0; k < placed.length; k += 4) if (x0 < placed[k + 2] && x0 + w > placed[k] && y0 < placed[k + 3] && y0 + h > placed[k + 1]) { hit = true; break; }
      if (hit) continue;
      placed.push(x0, y0, x0 + w, y0 + h);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.2; ctx.strokeStyle = halo; ctx.strokeText(str, x0, cy);
      ctx.fillStyle = color; ctx.fillText(str, x0, cy);
      return true;
    }
    return false;
  }

  function draw() {
    const s = view.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a1729';
    ctx.fillRect(0, 0, W, H);
    const x0 = wx(0), x1 = wx(W), z0 = wz(0), z1 = wz(H);
    // coarse imagery under the baked map: the land goes on past the map's edges
    const under = tiles.draw(ctx, x0, z0, x1, z1, X, Y, s, 1 / (s * dpr), 4);
    if (base) {
      const m = base.meta;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base.img, X(m.minX), Y(m.minZ), (m.maxX - m.minX) * s, (m.maxZ - m.minZ) * s);
    }
    loadingTiles = tiles.draw(ctx, x0, z0, x1, z1, X, Y, s, 1 / (s * dpr)) || under;
    const tilesOn = tiles.available && 1 / (s * dpr) < 15;
    // grid (km)
    const grid = s > 0.25 ? 500 : s > 0.08 ? 1000 : s > 0.03 ? 2000 : 5000;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / grid) * grid; x < x1; x += grid) { ctx.moveTo(Math.round(X(x)) + 0.5, 0); ctx.lineTo(Math.round(X(x)) + 0.5, H); }
    for (let z = Math.ceil(z0 / grid) * grid; z < z1; z += grid) { ctx.moveTo(0, Math.round(Y(z)) + 0.5); ctx.lineTo(W, Math.round(Y(z)) + 0.5); }
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.stroke();
    // bridges
    ctx.lineCap = 'round';
    for (const br of BRIDGES) {
      ctx.beginPath(); ctx.moveTo(X(br.a[0]), Y(br.a[1])); ctx.lineTo(X(br.b[0]), Y(br.b[1]));
      ctx.lineWidth = Math.max(2.2, 27 * s); ctx.strokeStyle = 'rgba(255,122,74,0.85)'; ctx.stroke();
    }
    // runways (real width), then end labels when zoomed in
    ctx.lineCap = 'butt';
    const apts = airports();
    for (const a of apts) for (const r of a.runways || []) {
      const [e0, e1] = r.ends || [];
      if (!e0 || !e1) continue;
      ctx.beginPath(); ctx.moveTo(X(e0.x), Y(e0.z)); ctx.lineTo(X(e1.x), Y(e1.z));
      const w = Math.max(2.4, r.width * s);
      if (w < 14 || !tilesOn) {
        ctx.lineWidth = w + 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        ctx.lineWidth = w; ctx.strokeStyle = a.military ? '#cfe3ff' : '#e9eef5'; ctx.stroke();
      } else {
        // zoomed in over the aerial imagery: the real runway shows, outlined
        const ux = (e1.x - e0.x) / r.length, uz = (e1.z - e0.z) / r.length, hw = r.width / 2;
        ctx.beginPath();
        ctx.moveTo(X(e0.x - uz * hw), Y(e0.z + ux * hw)); ctx.lineTo(X(e1.x - uz * hw), Y(e1.z + ux * hw));
        ctx.lineTo(X(e1.x + uz * hw), Y(e1.z - ux * hw)); ctx.lineTo(X(e0.x + uz * hw), Y(e0.z - ux * hw)); ctx.closePath();
        ctx.fillStyle = 'rgba(233,238,245,0.08)'; ctx.fill();
        ctx.lineWidth = 1.6; ctx.strokeStyle = a.military ? 'rgba(207,227,255,0.85)' : 'rgba(233,238,245,0.85)'; ctx.stroke();
      }
    }
    placed.length = 0;
    // reserved: controls (top right), cursor readout, scale bars (bottom left)
    placed.push(W - 58, 0, W, 190, 0, H - 80, 240, H);
    // route waypoints and their labels (right side) win the label space over landmark / airport names
    for (const w of route.waypoints) { const x = X(w.x), y = Y(w.z); placed.push(x - 14, y - 14, x + 86, y + 16); }
    const hovRw = hover && hover.type === 'rw' ? hover.rw : null, selRw = sel && sel.type === 'rw' ? sel.rw : null;
    const appRw = route.approach ? route.approach.rw.name : null;
    if (s > 0.018) {
      for (const e of rwEnds()) {
        const hl = e === hovRw || e === selRw, app = e.name === appRw;
        const tx = X(e.x), ty = Y(e.z);
        if (tx < -40 || tx > W + 40 || ty < -40 || ty > H + 40) continue;
        if (hl || app) {
          ctx.beginPath(); ctx.arc(tx, ty, 9, 0, Math.PI * 2);
          ctx.lineWidth = 2.4; ctx.strokeStyle = app && !hl ? '#ff6ee7' : '#5cf2c8'; ctx.stroke();
        }
        if (s > 0.045 || hl || app) {
          const off = 16 + Math.min(e.width * s, 30);
          label(e.ident, tx - e.dx * off, ty - e.dz * off, hl ? '#5cf2c8' : app ? '#ffc6f5' : 'rgba(236,244,255,0.82)', `800 ${hl ? 12.5 : 11}px ${MONO}`, 'center');
        }
      }
    }
    // airports
    for (const a of apts) {
      const c = a.center; if (!c) continue;
      const x = X(c.x), y = Y(c.z);
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
      const info = AIRPORTS[a.icao];
      const off = 26 + Math.min(s * 900, 60);
      label(info ? info.code : a.icao, x, y - off, '#5cf2c8', `800 13px ${MONO}`, 'center');
      if (s > 0.035 && info) label(info.name, x, y - off + 15, 'rgba(160,250,222,0.75)', `650 11px ${SANS}`, 'center');
    }
    // landmarks
    for (const l of landmarks()) {
      if (l.id === 'sfo_tower') continue;
      const major = MAJOR_LANDMARKS.includes(l.id);
      if (!major && s < 0.045) continue;
      const x = X(l.x), y = Y(l.z);
      if (x < 2 || x > W - 2 || y < 2 || y > H - 2) continue;
      ctx.beginPath(); ctx.arc(x, y, major ? 3 : 2.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,190,150,0.9)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(4,9,18,0.8)'; ctx.stroke();
      if (major || s > 0.06) label(LANDMARK_NAMES[l.id] || l.name, x, y, 'rgba(255,214,190,0.9)', `650 ${major ? 11.5 : 10.5}px ${SANS}`);
    }
    // track trail, route, aircraft
    const f = flight;
    drawTrail(ctx, trail, trailHead, trailCount, TRAIL_CAP, X, Y, 2.6);
    drawRoute(ctx, route, X, Y, { big: true, selectedId: sel && sel.type === 'wpt' ? sel.id : null, hoverId: hover && hover.type === 'wpt' ? hover.id : null, low, speedText, width: W - 52, height: H - 70 });
    if (f && f.position) {
      const px = X(f.position.x), py = Y(f.position.z);
      const gs = f.velocity ? Math.hypot(f.velocity.x, f.velocity.z) : 0;
      if (gs > 3) {
        // one minute ahead along the present track
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + f.velocity.x * 60 * s, py + f.velocity.z * 60 * s);
        ctx.setLineDash([4, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(92,242,200,0.75)'; ctx.stroke(); ctx.setLineDash([]);
      }
      drawAircraft(ctx, px, py, f.heading || 0, 28, heli());
    }
    // north arrow + scale bars (km and NM)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 13px ${SANS}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText('K', W - 80, 22);
    ctx.fillStyle = '#ff9a6a'; ctx.fillText('K', W - 80, 22);
    ctx.beginPath(); ctx.moveTo(W - 80, 30); ctx.lineTo(W - 84, 40); ctx.lineTo(W - 80, 37); ctx.lineTo(W - 76, 40); ctx.closePath();
    ctx.fillStyle = '#ff9a6a'; ctx.fill();
    scaleBar(16, H - 62, s, 1000, 'km');
    scaleBar(16, H - 42, s, NM, 'NM');
  }
  function scaleBar(x, y, s, unit, name) {
    const nice = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20];
    let n = nice[0];
    for (const v of nice) if (v * unit * s <= 150) n = v;
    const w = n * unit * s;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.moveTo(x + w, y - 4); ctx.lineTo(x + w, y + 4);
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
    ctx.font = `700 11px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const t = `${String(n).replace('.', ',')} ${name}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,9,18,0.8)'; ctx.strokeText(t, x + w + 8, y);
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(t, x + w + 8, y);
  }

  function updateStrip() {
    const f = flight;
    if (!f) return;
    sIas.textContent = String(Math.round(Math.max(0, f.ias || 0) / KT));
    sAlt.textContent = fmtInt(Math.round((f.altitude || 0) / FT / 10) * 10);
    sHdg.textContent = `${pad3(f.heading || 0)}°`;
    sGs.textContent = String(Math.round(Math.hypot(f.velocity.x, f.velocity.z) / KT));
    const ap = f.autopilot;
    const on = !!(ap && ap.on), nav = on && !!ap.lnav;
    apCell.className = `gkn-ap${on ? (nav ? ' nav' : '') : ' off'}`;
    sAp.textContent = !on ? 'KAPALI' : heli() ? String(ap.mode || '').toUpperCase() || 'AFCS' : String(ap.mode || 'AP').split(' ').slice(0, 2).join(' ');
    const w = f.warnings || {};
    const red = w.pullUp ? 'PULL UP' : w.stall ? 'STALL' : w.overspeed ? 'OVERSPEED' : '';
    const amber = red ? '' : w.sinkRate ? 'SINK RATE' : w.bank ? 'BANK ANGLE' : w.gear ? 'GEAR' : '';
    wCell.className = `gkn-wn${red ? ' red' : amber ? ' amber' : ''}`;
    wCell.textContent = red || amber;
  }

  // ---------------------------------------------------------------- public
  const api = {
    element: root,
    get isOpen() { return isOpen; },
    open(src = 'key') {
      if (isOpen || !flight) return;                     // only in flight (J is live in the menu too)
      isOpen = true;
      root.classList.add('open');
      layout();
      if (!viewInit && flight) {
        viewInit = true;
        if (route.waypoints.length) { follow = false; fitRoute(); }
        else { view.cx = flight.position.x; view.cz = flight.position.z; view.s = clamp(Math.min(W, H) / 22000, sMin(), S_MAX); follow = true; }
      } else if (follow && flight) { view.cx = flight.position.x; view.cz = flight.position.z; }
      bFollow.classList.toggle('on', follow);
      clampView();
      clearDirty = true; clearT = 0;
      lastPanelKey = ''; dirty = true;
      trackEvent('map', { ac: acId(), src });
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove('open');
      closePop(); sel = null; hover = null; gesture = null; pointers.clear();
      cur.classList.remove('on');
      // hand the keyboard back to the game (a focused button would swallow Space / keys)
      if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
    },
    toggle(src) { if (isOpen) api.close(); else api.open(src); },
    /** The flight model changed (aircraft loaded): route messages, category. */
    setFlight(f, d) {
      flight = f; def = d || def;
      category = (f && f.spec && f.spec.category) || 'airliner';
      // another aircraft category: its own approach procedure to the same runway (airliner ILS ↔ helicopter hover)
      if (route.approach && route.approach.category !== category) route.setApproach(route.approach.rw, category);
      trailCount = 0; trailHead = 0;
      if (f && f.on) {
        f.on('nav', (e) => {
          if (e.type === 'hdg') say('Rota: yön moduna geçildi (HDG) · haritada «Rotayı uç» ile geri dön', 2600);
          else if (e.type === 'end') say('Rota tamamlandı: otopilot yönü koruyor', 2200);
          else if (e.type === 'athr') say('A/THR kapandı: gaz sende · haritada «A/THR aç» ile geri aç', 2600);
        });
      }
      lastPanelKey = '';
    },
    /** Every frame: trail sampling (always), redraw (open, ≤ 30 Hz or on interaction). */
    update(dt, f, w) {
      if (f && f !== flight) api.setFlight(f);
      if (w && w !== world) { world = w; tiles.setWorld(w); if (!route.env) route.env = envForRoute(); }
      if (f && f.position && !f.crashed) {
        trailT += dt;
        const p = f.position;
        const li = ((trailHead - 1 + TRAIL_CAP) % TRAIL_CAP) * 2;
        const moved = trailCount ? Math.hypot(p.x - trail[li], p.z - trail[li + 1]) : Infinity;
        if (moved > 3000) { trailCount = 0; }                     // reset / teleport: new trail
        if (moved > 60 || (trailT > 2 && moved > 5)) {
          trail[trailHead * 2] = p.x; trail[trailHead * 2 + 1] = p.z;
          trailHead = (trailHead + 1) % TRAIL_CAP; trailCount = Math.min(trailCount + 1, TRAIL_CAP); trailT = 0;
        }
      }
      if (!isOpen) return;
      if (f && f.crashed) { api.close(); return; }          // the crash card (under the map) takes over
      if (follow && f && !gesture) { view.cx = f.position.x; view.cz = f.position.z; clampView(); }
      redrawT += dt; stripT -= dt;
      if (stripT <= 0) {
        stripT = 0.25;
        updateStrip();
        const key = panelKey();
        if (key !== lastPanelKey && performance.now() > uiHoldUntil) { lastPanelKey = key; buildPanel(); }
      }
      if (popStale && performance.now() > uiHoldUntil && popFor) { popStale = false; showPop(popFor); }   // e.g. edited in the list
      if (route.version !== lastRouteVersion) {
        lastRouteVersion = route.version; dirty = true;
        if (popFor && !(gesture && gesture.mode === 'drag')) popStale = true;
      }
      clearT -= dt;
      if (clearDirty && clearT <= 0 && !(gesture && gesture.mode === 'drag')) { clearDirty = false; clearT = 0.3; updateClearance(); lastPanelKey = ''; }
      if (dirty || loadingTiles || redrawT > 1 / 30) {
        dirty = false; redrawT = 0;
        draw();
        placePop();
      }
    },
    /** Test hook: centre the open map on (x, z) at scale s (CSS px per m), follow off. */
    lookAt(x, z, s) { follow = false; bFollow.classList.remove('on'); if (s) view.s = s; centerOn(x, z); },
    /** Test hook: client (page) coordinates of a world point on the open map. */
    project(x, z) { const r = cv.getBoundingClientRect(); return { x: r.left + X(x), y: r.top + Y(z) }; },
    /** HUD minimap hook: the route over the minimap (projection of the minimap). */
    drawMinimapOverlay(c, PX, PY) { if (route.waypoints.length) drawRoute(c, route, PX, PY, { big: false }); },
  };
  if (hud && hud.mountMap) hud.mountMap(root);
  else if (hud && hud.mountLayer) hud.mountLayer(root);
  else document.body.appendChild(root);
  return api;
}
