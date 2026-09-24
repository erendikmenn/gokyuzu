// Main menu: cinematic Golden Gate dusk scene, aircraft cards, grouped spawn list, controls summary, "Uç".
import { injectCSS, BASE_CSS } from './styles.js';
import { el, clamp, rootUrl, storageGet, storageSet, keyChips } from './util.js';
import { assetUrl } from '../core/assets.js';
import { goldenGateSceneSVG, planformSVG, SCENE_VB } from './art.js';
import { AIRCRAFT_INFO, CATEGORY_LABEL, AIRPORTS, AIRPORT_ORDER, MENU_CONTROLS } from './data.js';
import { shared } from './shared.js';
import { createSpawnMap, SPAWN_MAP_CSS } from './baymap.js';
import { openSettings, openCredits, showQualityHint, CREDITS_LINE } from './panels.js';
import { touchMode } from './touch-env.js';             // touch hook: phones / tablets (src/ui/touch*.js)
import { MENU_TOUCH_CSS } from './touch-menu.js';
import { showInAppHint } from './touch-gate.js';
import { enterFullscreen } from './touch.js';

const STORE_KEY = 'gokyuzu-sf.menu';

// ---------- controls summary from the live key bindings (src/flight/input.js), per aircraft category ----------
const SHORT = [
  [/^Burun/i, 'Burun'], [/^Cyclic ileri/i, 'Cyclic ileri / geri'], [/^Cyclic sola/i, 'Cyclic yan'], [/yatış/i, 'Yatış'],
  [/^Pedal/i, 'Pedal'], [/^Dümen/i, 'Dümen'], [/^Kolektif artır/i, 'Kolektif'], [/^Gaz artır/i, 'Gaz'],
  [/^Art yakıcı/i, 'Art yakıcı'], [/^İniş takımı/i, 'İniş takımı'], [/^Flap/i, 'Flap'], [/^Otomatik havada asılı/i, 'Hover tutma'],
  [/^Otopilot(?! açıkken)/i, 'Otopilot'], [/^Kamera/i, 'Kamera'], [/^Kokpit/i, 'Kokpit'], [/^Arkaya bak/i, 'Arkaya bak'],
  [/^Duraklat/i, 'Duraklat'], [/^Yardım/i, 'Tüm kontroller'],
];
const PRIORITY = {
  airliner: ['Burun', 'Yatış', 'Dümen', 'Gaz', 'İniş takımı', 'Flap', 'Otopilot', 'Kamera', 'Kokpit', 'Tüm kontroller'],
  fighter: ['Burun', 'Yatış', 'Dümen', 'Gaz', 'Art yakıcı', 'İniş takımı', 'Kamera', 'Kokpit', 'Duraklat', 'Tüm kontroller'],
  helicopter: ['Cyclic ileri / geri', 'Cyclic yan', 'Pedal', 'Kolektif', 'Hover tutma', 'Kamera', 'Kokpit', 'Arkaya bak', 'Duraklat', 'Tüm kontroller'],
};
let inputModPromise = null;
const bindingRows = new Map();          // category → [[keys, label], …] | null
/** Promise<[keys, label][] | null> built from createInput(null).bindings for the category (null → use the static list). */
function controlRows(category) {
  if (bindingRows.has(category)) return Promise.resolve(bindingRows.get(category));
  if (!inputModPromise) inputModPromise = import(new URL('../flight/input.js', import.meta.url).href).catch(() => null);
  return inputModPromise.then((mod) => {
    let rows = null;
    try {
      const inp = mod && mod.createInput ? mod.createInput(null) : null;
      if (inp && typeof inp.setAircraft === 'function') inp.setAircraft({ category, abDetent: category === 'fighter' ? 0.9 : null });
      const list = inp && Array.isArray(inp.bindings) ? inp.bindings : [];
      const found = new Map();
      for (const b of list) {
        const label = String(b.label || '');
        const hit = SHORT.find(([re]) => re.test(label));
        if (!hit || found.has(hit[1])) continue;
        let keys = String(b.keys || '').split('·')[0].trim();
        if (hit[1] === 'Art yakıcı') keys = '2× Shift';
        if (hit[1] === 'Tüm kontroller') keys = keys.split('/')[0].trim();
        found.set(hit[1], [keys, hit[1]]);
      }
      rows = (PRIORITY[category] || PRIORITY.airliner).map((k) => found.get(k)).filter(Boolean);
      if (rows.length < 6) rows = null;
    } catch { rows = null; }
    bindingRows.set(category, rows);
    return rows;
  });
}
const thumbCache = new Map();     // aircraft id → Promise<string|null> (resolved thumbnail URL)

/** Resolve an aircraft's menu thumbnail (from its model module), or null. */
export function loadThumbnail(id) {
  if (typeof shared.thumbOverride === 'function') return Promise.resolve(shared.thumbOverride(id));   // dev preview hook
  if (!thumbCache.has(id)) {
    const p = import(new URL(`../aircraft/${id}/model.js`, import.meta.url).href)
      .then((m) => (m && m.model && m.model.thumbnail ? assetUrl(rootUrl(m.model.thumbnail)) : null))   // §9: ?v=<hash>
      .then((url) => (url ? new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth > 8 ? url : null);
        img.onerror = () => res(null);
        img.src = url;
      }) : null))
      .catch(() => null);
    thumbCache.set(id, p);
  }
  return thumbCache.get(id);
}

/** Split a spawn name like "SFO · Pist 28R (batı, körfez)" into { title, detail }. */
export function spawnLabel(s) {
  let name = String(s.name || s.id || '');
  const dot = name.indexOf('·');
  if (dot >= 0) name = name.slice(dot + 1).trim();
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  return m ? { title: m[1], detail: m[2] } : { title: name, detail: '' };
}
export function spawnIdent(s) {
  if (s.airborne || s.altitude) return null;
  const m = String(s.id || '').match(/-([0-9]{2}[LRC]?)$/);
  return m ? m[1] : null;
}
export function groupSpawns(spawns) {
  const groups = [];
  const byKey = new Map();
  const keyOf = (s) => (s.airborne || s.altitude ? 'AIR' : s.airport || String(s.id).split('-')[0]);
  for (const s of spawns) {
    const k = keyOf(s);
    if (!byKey.has(k)) { const g = { key: k, items: [] }; byKey.set(k, g); groups.push(g); }
    byKey.get(k).items.push(s);
  }
  const order = [...AIRPORT_ORDER, 'AIR'];
  groups.sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)));
  return groups;
}

const CSS = `
.gkm { position: fixed; inset: 0; z-index: 30; overflow: hidden; color: var(--gk-fg); font-family: var(--gk-sans);
  background: #0a1322; --u: 1; --u1: calc(1px * var(--u)); --px: 0; --py: 0;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; font-variant-numeric: tabular-nums; }
.gkm * { box-sizing: border-box; }
.gkm button { font: inherit; color: inherit; }

/* ---------- scene ---------- */
.gkm-sky { position: absolute; inset: -4%; transform: translate(calc(var(--px) * -6px), calc(var(--py) * -4px));
  background:
    radial-gradient(circle at var(--sunx, 40%) 64%, rgba(255, 246, 220, .95) 0, rgba(255, 214, 150, .8) 1.6%, rgba(255, 170, 100, .35) 5%, rgba(255, 140, 90, 0) 16%),
    radial-gradient(ellipse 38% 26% at var(--sunx, 40%) 64%, rgba(255, 170, 110, .75), rgba(255, 130, 85, .3) 45%, rgba(255, 120, 80, 0) 75%),
    radial-gradient(ellipse 90% 34% at var(--sunx, 40%) 66%, rgba(255, 128, 84, .5), rgba(255, 128, 84, 0) 72%),
    linear-gradient(180deg, #050b18 0%, #0b1830 20%, #1b2b4d 38%, #43406a 50%, #9b5f6f 58.5%, #e0845f 63%, #f5ad78 65.5%, #1d2338 66%, #0b1322 100%); }
.gkm-stars { position: absolute; inset: 0 0 50% 0; opacity: .55;
  background-image:
    radial-gradient(1px 1px at 12% 18%, #fff, transparent), radial-gradient(1px 1px at 22% 8%, #fff, transparent),
    radial-gradient(1.2px 1.2px at 35% 22%, #fff, transparent), radial-gradient(1px 1px at 48% 12%, #fff, transparent),
    radial-gradient(1px 1px at 63% 6%, #fff, transparent), radial-gradient(1.3px 1.3px at 71% 19%, #fff, transparent),
    radial-gradient(1px 1px at 83% 11%, #fff, transparent), radial-gradient(1px 1px at 91% 25%, #fff, transparent),
    radial-gradient(1px 1px at 5% 30%, #fff, transparent), radial-gradient(1px 1px at 57% 27%, #fff, transparent);
  mask-image: linear-gradient(180deg, #000 0%, transparent 80%); -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 80%);
  animation: gkm-twinkle 6s ease-in-out infinite alternate; }
@keyframes gkm-twinkle { from { opacity: .35; } to { opacity: .65; } }
.gkm-scene { position: absolute; left: -3%; width: 106%; top: 40%; height: 60%;
  transform: translate(calc(var(--px) * -14px), calc(var(--py) * -6px)); }
.gkm-scene svg { width: 100%; height: 100%; display: block; overflow: visible; }
.gm-far { fill: #3a3553; opacity: .85; }
.gm-city { fill: #2e2d45; }
.gm-near { fill: #10141f; }
.gm-bridge path { fill: #0b0f1b; }
.gm-bridge .gm-tower { stroke: rgba(255, 140, 90, .28); stroke-width: .8; }
.gm-bridge .gm-cable { fill: none; stroke: #0c101c; stroke-width: 3.2; }
.gm-bridge .gm-susp { fill: none; stroke: #0c101c; stroke-width: .9; opacity: .9; }
.gm-bridge .gm-rim { fill: none; stroke-width: 1.2; opacity: .75; }
.gm-streak { fill: #ffb27a; opacity: .5; animation: gkm-shimmer 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes gkm-shimmer { 0%, 100% { opacity: .15; transform: scaleX(.7); } 50% { opacity: .6; transform: scaleX(1.1); } }
.gm-fog { opacity: .75; }
.gm-fog-back { animation: gkm-fog 70s linear infinite alternate; }
.gm-fog-front { animation: gkm-fog 46s linear infinite alternate-reverse; opacity: .5; }
@keyframes gkm-fog { from { transform: translateX(-120px); } to { transform: translateX(60px); } }
.gkm-jet { position: absolute; left: 0; top: 10%; width: calc(16 * var(--u1)); height: calc(16 * var(--u1)); opacity: 0;
  animation: gkm-jet 52s linear 3s infinite; }
.gkm-jet .pf { width: 100%; height: 100%; overflow: visible; }
.gkm-jet .pf-body { fill: #ffe6d4; stroke: none; filter: drop-shadow(0 0 3px rgba(255, 200, 160, .9)); }
.gkm-jet .pf-canopy, .gkm-jet .pf-line, .gkm-jet .pf-nacelle { display: none; }
.gkm-jet::after { content: ""; position: absolute; left: 70%; top: 50%; width: calc(420 * var(--u1)); height: 2px; transform: translateY(-50%);
  background: linear-gradient(90deg, rgba(255, 236, 222, .75), rgba(255, 220, 200, .25) 40%, rgba(255, 220, 200, 0)); border-radius: 2px; filter: blur(.4px); }
@keyframes gkm-jet { 0% { transform: translate(104vw, 0); opacity: 0; } 3% { opacity: .9; } 55% { opacity: .9; }
  62% { transform: translate(-40vw, 7vh); opacity: 0; } 100% { transform: translate(-40vw, 7vh); opacity: 0; } }
.gkm-scrim { position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(90deg, rgba(4, 8, 16, .78) 0%, rgba(4, 8, 16, .42) 34%, rgba(4, 8, 16, 0) 58%),
    linear-gradient(0deg, rgba(3, 6, 12, .86) 0%, rgba(3, 6, 12, .35) 26%, rgba(3, 6, 12, 0) 42%),
    radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0, 0, 0, .45) 100%); }
.gkm-grain { position: absolute; inset: 0; pointer-events: none; opacity: .07; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }

/* ---------- layout ---------- */
.gkm-ui { position: absolute; inset: 0; display: grid;
  grid-template-columns: minmax(0, 1fr) calc(380 * var(--u1)); grid-template-rows: auto minmax(0, 1fr) auto auto;
  column-gap: calc(34 * var(--u1)); padding: calc(38 * var(--u1)) calc(40 * var(--u1)) calc(26 * var(--u1)); }
.gkm-brand { grid-column: 1; grid-row: 1; animation: gkm-in .9s cubic-bezier(.2, .8, .2, 1) both; }
.gkm-hero { grid-column: 1; grid-row: 2; align-self: center; display: flex; align-items: center; gap: calc(24 * var(--u1)); min-height: 0;
  animation: gkm-in .9s .12s cubic-bezier(.2, .8, .2, 1) both; }
.gkm-cards { grid-column: 1; grid-row: 3; animation: gkm-in .9s .22s cubic-bezier(.2, .8, .2, 1) both; }
.gkm-foot { grid-column: 1; grid-row: 4; animation: gkm-in .9s .4s cubic-bezier(.2, .8, .2, 1) both; }
.gkm-side { grid-column: 2; grid-row: 1 / span 4; animation: gkm-in-r .9s .18s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkm-in { from { opacity: 0; transform: translateY(calc(18 * var(--u1))); } to { opacity: 1; transform: none; } }
@keyframes gkm-in-r { from { opacity: 0; transform: translateX(calc(26 * var(--u1))); } to { opacity: 1; transform: none; } }
.gkm.gkm-out { animation: gkm-out .55s cubic-bezier(.4, 0, .2, 1) forwards; pointer-events: none; }
@keyframes gkm-out { to { opacity: 0; transform: scale(1.03); filter: blur(4px); } }

/* ---------- brand ---------- */
.gkm-over { display: flex; align-items: center; gap: calc(10 * var(--u1)); font-size: calc(12 * var(--u1)); font-weight: 700;
  letter-spacing: .42em; text-transform: uppercase; color: var(--gk-orange-2); }
.gkm-over::before { content: ""; width: calc(26 * var(--u1)); height: 2px; border-radius: 2px; background: linear-gradient(90deg, var(--gk-orange), var(--gk-orange-2)); }
.gkm-brand h1 { margin: calc(4 * var(--u1)) 0 0; font-family: var(--gk-display); font-size: calc(96 * var(--u1)); line-height: .98;
  font-weight: 800; letter-spacing: -.04em;
  background: linear-gradient(180deg, #ffffff 30%, #ffd9bf 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 6px 30px rgba(255, 140, 90, .25)); }
.gkm-sub { margin-top: calc(10 * var(--u1)); font-size: calc(17 * var(--u1)); font-weight: 600; letter-spacing: .34em;
  text-transform: uppercase; color: rgba(255, 255, 255, .82); }

/* ---------- hero ---------- */
.gkm-hero-text { flex: 0 0 calc(530 * var(--u1)); min-width: 0; }
.gkm-hero-text.gkm-swap { animation: gkm-swap .45s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkm-swap { from { opacity: 0; transform: translateX(calc(-14 * var(--u1))); } to { opacity: 1; transform: none; } }
.gkm-chip { display: inline-flex; align-items: center; gap: calc(7 * var(--u1)); padding: calc(4 * var(--u1)) calc(11 * var(--u1));
  border-radius: 999px; border: 1px solid rgba(255, 170, 120, .45); color: #ffcfae; background: rgba(255, 107, 61, .1);
  font-size: calc(11 * var(--u1)); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.gkm-chip::before { content: ""; width: calc(6 * var(--u1)); height: calc(6 * var(--u1)); border-radius: 50%; background: var(--gk-orange); box-shadow: 0 0 8px var(--gk-orange); }
.gkm-hero h2 { margin: calc(12 * var(--u1)) 0 calc(8 * var(--u1)); font-family: var(--gk-display); font-size: calc(42 * var(--u1));
  line-height: 1.05; font-weight: 750; letter-spacing: -.025em; text-shadow: 0 2px 24px rgba(0, 0, 0, .35); }
.gkm-blurb { margin: 0; max-width: calc(520 * var(--u1)); font-size: calc(15.5 * var(--u1)); line-height: 1.5; color: rgba(226, 236, 250, .8); text-wrap: pretty; }
.gkm-specs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.45fr); gap: calc(10 * var(--u1)); margin-top: calc(20 * var(--u1)); max-width: calc(600 * var(--u1)); }
.gkm-spec { padding: calc(11 * var(--u1)) calc(13 * var(--u1)); border-radius: calc(12 * var(--u1));
  background: linear-gradient(180deg, rgba(255, 255, 255, .075), rgba(255, 255, 255, .03)); border: 1px solid rgba(255, 255, 255, .09);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.gkm-spec b { display: block; font-size: calc(10.5 * var(--u1)); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--gk-dim); }
.gkm-spec span { display: block; margin-top: calc(5 * var(--u1)); font-size: calc(15 * var(--u1)); font-weight: 680; line-height: 1.25; color: var(--gk-fg); }
.gkm-spec small { display: block; margin-top: calc(2 * var(--u1)); font-size: calc(12 * var(--u1)); font-weight: 550; color: var(--gk-dim); }
.gkm-extra { display: flex; flex-wrap: wrap; gap: calc(6 * var(--u1)) calc(18 * var(--u1)); margin-top: calc(14 * var(--u1)); font-size: calc(13 * var(--u1)); color: var(--gk-dim); }
.gkm-extra b { color: var(--gk-fg); font-weight: 600; margin-left: calc(6 * var(--u1)); }
.gkm-hero-art { flex: 1 1 auto; align-self: stretch; min-width: 0; position: relative; display: flex; align-items: center; justify-content: flex-end; max-height: calc(420 * var(--u1)); }
.gkm-hero-art > * { animation: gkm-art .7s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes gkm-art { from { opacity: 0; transform: scale(.94) translateY(calc(8 * var(--u1))); } to { opacity: 1; transform: none; } }

.pf-body { fill: rgba(140, 190, 255, .07); stroke: rgba(190, 220, 255, .82); stroke-width: .55; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.pf-canopy { fill: rgba(190, 220, 255, .2); stroke: rgba(190, 220, 255, .6); stroke-width: .4; vector-effect: non-scaling-stroke; }
.pf-nacelle { fill: rgba(140, 190, 255, .1); stroke: rgba(190, 220, 255, .75); stroke-width: .5; vector-effect: non-scaling-stroke; }
.pf-line { fill: none; stroke: rgba(190, 220, 255, .38); stroke-width: .4; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
.pf-disc { fill: rgba(140, 190, 255, .05); stroke: rgba(190, 220, 255, .4); stroke-width: .4; stroke-dasharray: 3 2; vector-effect: non-scaling-stroke; }
.pf-blade { fill: none; stroke: rgba(190, 220, 255, .7); stroke-width: 1.6; stroke-linecap: round; }
.pf-hub { fill: rgba(190, 220, 255, .8); }

/* ---------- cards ---------- */
.gkm-cards-h { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 calc(10 * var(--u1)); }
.gkm-h { font-size: calc(11.5 * var(--u1)); font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: var(--gk-dim); }
.gkm-row { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: calc(12 * var(--u1)); }
.gkm-card { position: relative; display: block; text-align: left; padding: 0; overflow: hidden; cursor: pointer;
  border-radius: calc(14 * var(--u1)); border: 1px solid rgba(255, 255, 255, .1);
  background: linear-gradient(180deg, rgba(20, 30, 48, .72), rgba(8, 13, 24, .78));
  -webkit-backdrop-filter: blur(12px) saturate(1.2); backdrop-filter: blur(12px) saturate(1.2);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .25);
  transition: transform .28s cubic-bezier(.2, .8, .2, 1), border-color .2s, box-shadow .28s, background .2s; outline: none; }
.gkm-card:hover { transform: translateY(calc(-3 * var(--u1))); border-color: rgba(255, 255, 255, .22); }
.gkm-card[aria-checked="true"] { transform: translateY(calc(-7 * var(--u1))); border-color: rgba(255, 140, 90, .9);
  box-shadow: 0 16px 40px rgba(0, 0, 0, .35), 0 0 0 1px rgba(255, 120, 70, .5), 0 0 34px rgba(255, 107, 61, .25); }
.gkm-card:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 5px rgba(255, 107, 61, .6); }
.gkm-card-img { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: var(--cg, linear-gradient(160deg, #26405f, #0d1626)); }
.gkm-card-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .6s cubic-bezier(.2, .8, .2, 1); }
.gkm-card:hover .gkm-card-img img, .gkm-card[aria-checked="true"] .gkm-card-img img { transform: scale(1.05); }
.gkm-card-img .pf { position: absolute; inset: 4% 8%; width: 84%; height: 92%; }
.gkm-card-img .pf .pf-body { fill: rgba(235, 244, 255, .9); stroke: rgba(255, 255, 255, .95); }
.gkm-card-img .pf .pf-canopy { fill: rgba(30, 50, 80, .7); stroke: none; }
.gkm-card-img .pf .pf-nacelle { fill: rgba(220, 232, 248, .95); stroke: rgba(255, 255, 255, .8); }
.gkm-card-img .pf .pf-line { stroke: rgba(40, 60, 90, .35); }
.gkm-card-img .pf .pf-disc { fill: rgba(255, 255, 255, .08); stroke: rgba(255, 255, 255, .35); }
.gkm-card-img .pf .pf-blade { stroke: rgba(235, 244, 255, .9); }
.gkm-card-img .gkm-shadow { position: absolute; inset: 14% 10% 0 18%; opacity: .35; filter: blur(3px); transform: translate(6%, 10%); }
.gkm-card-img .gkm-shadow .pf { inset: 0; width: 100%; height: 100%; }
.gkm-card-img .gkm-shadow .pf * { fill: #000 !important; stroke: none !important; }
.gkm-card-img::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 55%, rgba(6, 10, 18, .55)); }
.gkm-card-body { padding: calc(9 * var(--u1)) calc(11 * var(--u1)) calc(10 * var(--u1)); }
.gkm-card-name { font-size: calc(13.5 * var(--u1)); font-weight: 700; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-card-role { margin-top: calc(2 * var(--u1)); font-size: calc(11.5 * var(--u1)); color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-card-key { position: absolute; top: calc(8 * var(--u1)); left: calc(8 * var(--u1)); z-index: 2; min-width: calc(20 * var(--u1)); height: calc(20 * var(--u1));
  padding: 0 calc(5 * var(--u1)); border-radius: calc(6 * var(--u1)); display: grid; place-items: center;
  font: 700 calc(11 * var(--u1)) var(--gk-mono); color: rgba(255, 255, 255, .85); background: rgba(6, 10, 18, .55); border: 1px solid rgba(255, 255, 255, .18); }
.gkm-card[aria-checked="true"] .gkm-card-key { background: var(--gk-orange); color: #1b0f08; border-color: transparent; }
.gkm-card-cat { position: absolute; top: calc(8 * var(--u1)); right: calc(8 * var(--u1)); z-index: 2; font-size: calc(9.5 * var(--u1)); font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase; padding: calc(3 * var(--u1)) calc(7 * var(--u1)); border-radius: 999px;
  background: rgba(6, 10, 18, .5); color: rgba(255, 255, 255, .8); border: 1px solid rgba(255, 255, 255, .14); }

/* ---------- side panel ---------- */
.gkm-side { display: flex; flex-direction: column; min-height: 0; border-radius: calc(20 * var(--u1));
  background: linear-gradient(180deg, rgba(14, 22, 38, .66), rgba(6, 10, 20, .72)); border: 1px solid rgba(255, 255, 255, .1);
  -webkit-backdrop-filter: blur(22px) saturate(1.25); backdrop-filter: blur(22px) saturate(1.25);
  box-shadow: 0 24px 60px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .06); overflow: hidden; }
.gkm-side-top { padding: calc(18 * var(--u1)) calc(20 * var(--u1)) calc(4 * var(--u1)); }
.gkm-side-top .gkm-h { display: flex; justify-content: space-between; align-items: center; }
.gkm-sel { margin-top: calc(6 * var(--u1)); font-size: calc(18 * var(--u1)); font-weight: 700; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-spawns { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 calc(12 * var(--u1)) calc(10 * var(--u1)); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.2) transparent;
  -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - 22px), transparent); mask-image: linear-gradient(180deg, #000 calc(100% - 22px), transparent); }
.gkm-group { margin-top: calc(6 * var(--u1)); }
.gkm-group-h { display: flex; align-items: center; gap: calc(8 * var(--u1)); padding: calc(4 * var(--u1)) calc(8 * var(--u1)) calc(3 * var(--u1));
  font-size: calc(12 * var(--u1)); font-weight: 650; color: rgba(236, 244, 255, .86); }
.gkm-group-h .gkm-code { font: 700 calc(10.5 * var(--u1)) var(--gk-mono); letter-spacing: .06em; padding: calc(2 * var(--u1)) calc(6 * var(--u1));
  border-radius: calc(5 * var(--u1)); background: rgba(255, 255, 255, .08); color: var(--gk-dim); }
.gkm-group-h .gkm-mil { font-size: calc(9.5 * var(--u1)); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #9fd0ff; }
.gkm-group-h::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, rgba(255, 255, 255, .12), transparent); }
.gkm-spawn { position: relative; display: grid; grid-template-columns: calc(48 * var(--u1)) minmax(0, 1fr) auto; align-items: center; gap: calc(10 * var(--u1));
  width: 100%; text-align: left; cursor: pointer; padding: calc(5 * var(--u1)) calc(10 * var(--u1)); margin: calc(1 * var(--u1)) 0;
  border-radius: calc(11 * var(--u1)); border: 1px solid transparent; background: transparent; outline: none;
  transition: background .18s, border-color .18s; }
.gkm-spawn:hover { background: rgba(255, 255, 255, .055); }
.gkm-spawn:focus-visible { border-color: rgba(255, 255, 255, .6); }
.gkm-spawn[aria-checked="true"] { background: linear-gradient(90deg, rgba(255, 107, 61, .2), rgba(255, 107, 61, .06)); border-color: rgba(255, 130, 80, .45); }
.gkm-spawn[aria-checked="true"]::before { content: ""; position: absolute; left: -1px; top: 22%; bottom: 22%; width: 3px; border-radius: 3px; background: var(--gk-orange); box-shadow: 0 0 10px var(--gk-orange); }
.gkm-sp-id { display: grid; place-items: center; height: calc(30 * var(--u1)); border-radius: calc(8 * var(--u1));
  font: 700 calc(14 * var(--u1)) var(--gk-mono); letter-spacing: -.02em; color: #fff; background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .1); }
.gkm-sp-id svg { width: calc(18 * var(--u1)); height: calc(18 * var(--u1)); }
.gkm-spawn[aria-checked="true"] .gkm-sp-id { background: rgba(255, 107, 61, .22); border-color: rgba(255, 140, 90, .5); color: #ffe2d2; }
.gkm-sp-txt { min-width: 0; font-size: calc(13.5 * var(--u1)); font-weight: 600; line-height: 1.25; }
.gkm-sp-txt small { display: block; font-size: calc(11.5 * var(--u1)); font-weight: 500; color: var(--gk-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-sp-rec { display: inline-block; margin-left: calc(6 * var(--u1)); vertical-align: 1px; font-size: calc(9 * var(--u1)); font-weight: 800; letter-spacing: .12em;
  text-transform: uppercase; color: #073026; background: var(--gk-teal); padding: calc(2 * var(--u1)) calc(5 * var(--u1)); border-radius: 4px; }
.gkm-sp-hdg { display: flex; align-items: center; gap: calc(5 * var(--u1)); font: 600 calc(11.5 * var(--u1)) var(--gk-mono); color: var(--gk-dim); }
.gkm-sp-hdg i { display: block; width: calc(14 * var(--u1)); height: calc(14 * var(--u1)); border-radius: 50%; border: 1px solid rgba(255, 255, 255, .25); position: relative; }
.gkm-sp-hdg i::after { content: ""; position: absolute; left: 50%; top: 8%; width: 1.5px; height: 46%; margin-left: -.75px; background: var(--gk-orange-2); border-radius: 2px; }
.gkm-ctrl { padding: calc(10 * var(--u1)) calc(20 * var(--u1)) calc(2 * var(--u1)); border-top: 1px solid rgba(255, 255, 255, .07); }
.gkm-ctrl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: calc(3 * var(--u1)) calc(14 * var(--u1)); margin-top: calc(8 * var(--u1)); }
.gkm-ctrl-row { display: flex; align-items: center; justify-content: space-between; gap: calc(6 * var(--u1)); font-size: calc(11.5 * var(--u1)); color: rgba(226, 236, 250, .78); min-width: 0; }
.gkm-ctrl-row > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-ctrl-row .gk-keys kbd { font-size: calc(10 * var(--u1)); padding: calc(1 * var(--u1)) calc(5 * var(--u1)); border-radius: 5px; }
.gkm-fly-wrap { padding: calc(10 * var(--u1)) calc(16 * var(--u1)) calc(16 * var(--u1)); }
.gkm-fly { position: relative; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: calc(12 * var(--u1));
  padding: calc(14 * var(--u1)) calc(18 * var(--u1)) calc(14 * var(--u1)) calc(22 * var(--u1)); border: 0; border-radius: calc(15 * var(--u1)); cursor: pointer; overflow: hidden;
  background: linear-gradient(135deg, #ff5d33 0%, #ff8a45 60%, #ffb257 100%); color: #1c0e06 !important; outline: none;
  box-shadow: 0 14px 36px rgba(255, 96, 50, .38), inset 0 1px 0 rgba(255, 255, 255, .45);
  transition: transform .2s cubic-bezier(.2, .8, .2, 1), box-shadow .2s, filter .2s; }
.gkm-fly:hover { transform: translateY(-2px); filter: brightness(1.06); box-shadow: 0 18px 44px rgba(255, 96, 50, .5), inset 0 1px 0 rgba(255, 255, 255, .5); }
.gkm-fly:active { transform: translateY(1px) scale(.99); }
.gkm-fly:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 6px rgba(255, 107, 61, .55); }
.gkm-fly::after { content: ""; position: absolute; top: 0; bottom: 0; width: 40%; left: -60%; transform: skewX(-20deg);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .45), transparent); animation: gkm-sheen 4.5s ease-in-out 1.5s infinite; }
@keyframes gkm-sheen { 0% { left: -60%; } 30%, 100% { left: 130%; } }
.gkm-fly-l { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.gkm-fly-t { font-family: var(--gk-display); font-size: calc(30 * var(--u1)); font-weight: 850; letter-spacing: .01em; line-height: 1; }
.gkm-fly-s { margin-top: calc(4 * var(--u1)); font-size: calc(11.5 * var(--u1)); font-weight: 650; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: calc(230 * var(--u1)); }
.gkm-fly-k { display: flex; align-items: center; gap: calc(8 * var(--u1)); }
.gkm-fly-k kbd { font: 700 calc(11 * var(--u1)) var(--gk-sans); padding: calc(4 * var(--u1)) calc(8 * var(--u1)); border-radius: calc(6 * var(--u1));
  background: rgba(40, 14, 0, .16); border: 1px solid rgba(40, 14, 0, .25); border-bottom-width: 2px; }
.gkm-fly-k svg { width: calc(22 * var(--u1)); height: calc(22 * var(--u1)); }

.gkm-foot { display: flex; flex-wrap: wrap; gap: calc(6 * var(--u1)) calc(22 * var(--u1)); margin-top: calc(14 * var(--u1)); font-size: calc(12 * var(--u1)); color: var(--gk-faint); }
.gkm-foot span { display: inline-flex; align-items: center; gap: calc(6 * var(--u1)); }
.gkm-foot-r { margin-left: auto; display: flex; gap: calc(8 * var(--u1)); }
.gkm-foot-r button { display: inline-flex; align-items: center; gap: calc(6 * var(--u1)); padding: calc(5 * var(--u1)) calc(11 * var(--u1)); border-radius: calc(9 * var(--u1));
  border: 1px solid rgba(255, 255, 255, .16); background: rgba(8, 14, 26, .45); color: rgba(236, 244, 255, .88) !important; cursor: pointer;
  font: 650 calc(12 * var(--u1)) var(--gk-sans) !important; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); transition: background .15s, border-color .15s; }
.gkm-foot-r button:hover { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .3); }
.gkm-foot-r button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.gkm-foot-r svg { width: calc(14 * var(--u1)); height: calc(14 * var(--u1)); }
.gkm .gkp-hint.gkm-hint { position: absolute; left: calc(470 * var(--u1)); right: auto; top: calc(46 * var(--u1)); bottom: auto; transform: none;
  max-width: calc(500 * var(--u1)); font-size: calc(13.5 * var(--u1)); z-index: 5; }
.gkm-credit { position: absolute; left: calc(40 * var(--u1)); right: calc(440 * var(--u1)); bottom: calc(7 * var(--u1)); font-size: calc(10 * var(--u1));
  color: rgba(208, 222, 240, .38); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.gkm-credit:hover { color: rgba(208, 222, 240, .7); }
.gkm-foot kbd { font: 600 calc(10.5 * var(--u1)) var(--gk-sans); padding: calc(1 * var(--u1)) calc(6 * var(--u1)); border-radius: 5px; color: var(--gk-dim);
  background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .12); }

@media (prefers-reduced-motion: reduce) {
  .gkm *, .gkm { animation-duration: .001s !important; animation-iteration-count: 1 !important; }
}
`;

const CARD_GRADIENTS = {
  fighter: 'radial-gradient(ellipse at 30% 20%, #5d7896 0%, #2a3b55 45%, #111a2b 100%)',
  airliner: 'radial-gradient(ellipse at 30% 20%, #7fa6cc 0%, #3d5f86 45%, #152338 100%)',
  helicopter: 'radial-gradient(ellipse at 30% 20%, #7b8f6c 0%, #3d4f41 45%, #151f1c 100%)',
};

const PLANE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
const ARROW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

export function createMenu(container, { aircraft = [], spawns = [] } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('menu', CSS);
  injectCSS('spawnmap', SPAWN_MAP_CSS);
  const touch = touchMode();
  if (touch) injectCSS('menu-touch', MENU_TOUCH_CSS);
  return new Promise((resolve) => {
    const list = aircraft.filter(Boolean);
    const stored = storageGet(STORE_KEY) || {};
    let acIndex = Math.max(0, list.findIndex((a) => a.id === stored.aircraftId));
    let spawnManual = !!stored.spawnManual && spawns.some((s) => s.id === stored.spawnId);
    let spawnId = spawnManual ? stored.spawnId : (list[acIndex] && list[acIndex].defaultSpawn) || (spawns[0] && spawns[0].id);
    if (!spawns.some((s) => s.id === spawnId)) spawnId = spawns[0] ? spawns[0].id : null;
    let closed = false, hintBox = null;

    const root = el('div', touch ? 'gkm gkm-touch' : 'gkm', container);
    root.setAttribute('lang', 'tr');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Gökyüzü ana menü');
    el('div', 'gkm-sky', root);
    el('div', 'gkm-stars', root);
    const jet = el('div', 'gkm-jet', root);
    jet.innerHTML = planformSVG('a320neo', { rotate: -86 });
    const scene = el('div', 'gkm-scene', root);
    scene.innerHTML = goldenGateSceneSVG();
    el('div', 'gkm-scrim', root);
    el('div', 'gkm-grain', root);
    const ui = el('div', 'gkm-ui', root);

    // brand
    const brand = el('header', 'gkm-brand', ui);
    el('div', 'gkm-over', brand, 'Uçuş simülatörü');
    el('h1', null, brand, 'Gökyüzü');
    el('div', 'gkm-sub', brand, 'San Francisco Körfezi');

    // hero
    const hero = el('section', 'gkm-hero', ui);
    const heroText = el('div', 'gkm-hero-text', hero);
    const heroArt = el('div', 'gkm-hero-art', hero);
    const spawnMap = createSpawnMap({ spawns, onSelect: (id) => selectSpawn(id, true) });
    heroArt.appendChild(spawnMap.el);

    // cards
    const cardsWrap = el('section', 'gkm-cards', ui);
    const ch = el('div', 'gkm-cards-h', cardsWrap);
    el('div', 'gkm-h', ch, 'Uçak seç');
    el('div', 'gkm-h', ch, `${list.length} uçak`);
    const row = el('div', 'gkm-row', cardsWrap);
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Uçak');
    const cards = list.map((a, i) => {
      const cat = a.category || 'airliner';
      const b = el('button', 'gkm-card', row);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.id = a.id;
      const img = el('div', 'gkm-card-img', b);
      img.style.setProperty('--cg', CARD_GRADIENTS[cat] || CARD_GRADIENTS.airliner);
      const shadow = el('div', 'gkm-shadow', img);
      shadow.innerHTML = planformSVG(a.id, { rotate: 52 });
      img.insertAdjacentHTML('beforeend', planformSVG(a.id, { rotate: 52 }));
      el('span', 'gkm-card-key', b, String(i + 1));
      el('span', 'gkm-card-cat', b, (CATEGORY_LABEL[cat] || a.role || '').split(' ')[0]);
      const body = el('div', 'gkm-card-body', b);
      el('div', 'gkm-card-name', body, a.name || a.id);
      el('div', 'gkm-card-role', body, a.role || CATEGORY_LABEL[cat] || '');
      b.addEventListener('click', () => selectAircraft(i, true));
      b.addEventListener('dblclick', () => { selectAircraft(i, true); fly(); });
      loadThumbnail(a.id).then((url) => {
        if (!url || closed) return;
        img.textContent = '';
        const im = el('img', null, img);
        im.alt = '';
        im.src = url;
      });
      return b;
    });

    // footer hints
    const foot = el('footer', 'gkm-foot', ui);
    const hint = (keys, label) => { const s = el('span', null, foot); for (const k of keys) el('kbd', null, s, k); s.append(label); };
    hint(['←', '→'], 'uçak');
    hint(['↑', '↓'], 'başlangıç noktası');
    hint(['1', '…', String(list.length)], 'hızlı seçim');
    hint(['Enter'], 'uç');
    const footR = el('span', 'gkm-foot-r', foot);
    const setBtn = el('button', null, footR);
    setBtn.type = 'button';
    setBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    setBtn.append('Ayarlar');
    const credBtn = el('button', null, footR, 'Künye');
    credBtn.type = 'button';
    setBtn.addEventListener('click', () => openSettings(container));
    credBtn.addEventListener('click', () => openCredits(container));
    const credit = el('div', 'gkm-credit', root, `${CREDITS_LINE} · Ticari olmayan hayran projesi`);
    credit.title = 'Künye';
    credit.addEventListener('click', () => openCredits(container));

    // side panel
    const side = el('aside', 'gkm-side', ui);
    const top = el('div', 'gkm-side-top', side);
    const sh = el('div', 'gkm-h', top);
    el('span', null, sh, 'Başlangıç noktası');
    const selLabel = el('div', 'gkm-sel', top, '');
    const spWrap = el('div', 'gkm-spawns', side);
    spWrap.setAttribute('role', 'radiogroup');
    spWrap.setAttribute('aria-label', 'Başlangıç noktası');
    const spawnButtons = new Map();
    const order = [];
    for (const g of groupSpawns(spawns)) {
      const grp = el('div', 'gkm-group', spWrap);
      const gh = el('div', 'gkm-group-h', grp);
      if (g.key === 'AIR') el('span', null, gh, 'Havada başla');
      else {
        const apt = AIRPORTS[g.key];
        el('span', null, gh, apt ? apt.name : g.key);
        el('span', 'gkm-code', gh, apt ? apt.code : g.key);
        if (g.key === 'KNGZ') el('span', 'gkm-mil', gh, 'Askeri');
      }
      for (const s of g.items) {
        const b = el('button', 'gkm-spawn', grp);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        const idBox = el('span', 'gkm-sp-id', b);
        const ident = spawnIdent(s);
        if (ident) idBox.textContent = ident; else idBox.innerHTML = PLANE_ICON;
        const txt = el('span', 'gkm-sp-txt', b);
        const lab = spawnLabel(s);
        const t = el('span', null, txt, lab.title);
        const rec = el('span', 'gkm-sp-rec', t, 'Önerilen');
        rec.style.display = 'none';
        if (lab.detail) el('small', null, txt, lab.detail);
        const hdg = el('span', 'gkm-sp-hdg', b);
        const deg = Math.round(((((s.heading || 0) * 180 / Math.PI) % 360) + 360) % 360);
        const dial = el('i', null, hdg);
        dial.style.transform = `rotate(${deg}deg)`;
        el('span', null, hdg, `${String(deg).padStart(3, '0')}°`);
        b.addEventListener('click', () => selectSpawn(s.id, true));
        b.addEventListener('dblclick', () => { selectSpawn(s.id, true); fly(); });
        b.addEventListener('mouseenter', () => spawnMap.setHover(s.id));
        b.addEventListener('mouseleave', () => spawnMap.setHover(null));
        b.addEventListener('focus', () => spawnMap.setHover(null));
        spawnButtons.set(s.id, { b, rec });
        order.push(s.id);
      }
    }

    // controls
    const ctrl = el('div', 'gkm-ctrl', side);
    el('div', 'gkm-h', ctrl, 'Temel kontroller');
    const ctrlGrid = el('div', 'gkm-ctrl-grid', ctrl);

    // fly
    const flyWrap = el('div', 'gkm-fly-wrap', side);
    const flyBtn = el('button', 'gkm-fly', flyWrap);
    flyBtn.type = 'button';
    const fl = el('span', 'gkm-fly-l', flyBtn);
    el('span', 'gkm-fly-t', fl, 'Uç');
    const flySub = el('span', 'gkm-fly-s', fl, '');
    const fk = el('span', 'gkm-fly-k', flyBtn);
    el('kbd', null, fk, 'Enter');
    fk.insertAdjacentHTML('beforeend', ARROW_ICON);
    flyBtn.addEventListener('click', fly);
    if (touch) el('div', 'gkm-touch-note', side, 'Uçuş yatay ekranda: telefonu yan çevir');

    // ---------- behaviour ----------
    function currentAircraft() { return list[acIndex] || null; }
    function currentSpawn() { return spawns.find((s) => s.id === spawnId) || null; }

    function renderHero(animate) {
      const a = currentAircraft();
      if (!a) return;
      const info = AIRCRAFT_INFO[a.id] || {};
      const cat = a.category || 'airliner';
      heroText.textContent = '';
      if (animate) { heroText.classList.remove('gkm-swap'); void heroText.offsetWidth; heroText.classList.add('gkm-swap'); }
      el('div', 'gkm-chip', heroText, a.role || CATEGORY_LABEL[cat] || '');
      el('h2', null, heroText, a.name || a.id);
      if (info.blurb) el('p', 'gkm-blurb', heroText, info.blurb);
      if (info.specs) {
        const sp = el('div', 'gkm-specs', heroText);
        for (const [k, v] of info.specs) {
          const t = el('div', 'gkm-spec', sp);
          el('b', null, t, k);
          const [main, ...rest] = String(v).split(' · ');
          el('span', null, t, main);
          if (rest.length) el('small', null, t, rest.join(' · '));
        }
      }
      if (info.extra) {
        const ex = el('div', 'gkm-extra', heroText);
        for (const [k, v] of info.extra) { const s = el('span', null, ex, k); el('b', null, s, v); }
      }
    }
    function renderControls() {
      const a = currentAircraft();
      const cat = (a && a.category) || 'airliner';
      controlRows(cat).then((rows) => {
        if (closed || !rows || ((currentAircraft() && currentAircraft().category) || 'airliner') !== cat) return;
        ctrlGrid.textContent = '';
        for (const [keys, label] of rows.slice(0, 10)) {
          const r = el('div', 'gkm-ctrl-row', ctrlGrid);
          el('span', null, r, label);
          keyChips(r, keys);
        }
      });
      ctrlGrid.textContent = '';
      const common = MENU_CONTROLS.common;
      const extra = MENU_CONTROLS[cat] || [];
      // helicopters replace the stick/throttle rows with cyclic / pedals / collective
      const rows = cat === 'helicopter' ? [extra[2], extra[1], extra[0], ...common.slice(4)] : [...common, ...extra];
      for (const [keys, label] of rows.filter(Boolean).slice(0, 10)) {
        const r = el('div', 'gkm-ctrl-row', ctrlGrid);
        el('span', null, r, label);
        keyChips(r, keys);
      }
    }

    function refresh() {
      const a = currentAircraft();
      cards.forEach((b, i) => { b.setAttribute('aria-checked', String(i === acIndex)); b.tabIndex = i === acIndex ? 0 : -1; });
      for (const [id, { b, rec }] of spawnButtons) {
        const on = id === spawnId;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        rec.style.display = a && a.defaultSpawn === id ? '' : 'none';
      }
      const s = currentSpawn();
      const lab = s ? spawnLabel(s) : { title: '' };
      const apt = s && !s.airborne && !s.altitude ? AIRPORTS[s.airport] : null;
      selLabel.textContent = s ? `${apt ? `${apt.short} · ` : ''}${lab.title}` : '—';
      spawnMap.setSelected(spawnId);
      const info = a ? AIRCRAFT_INFO[a.id] : null;
      flySub.textContent = a ? `${(info && info.short) || a.name} · ${apt ? `${apt.short} ` : ''}${lab.title}` : '';
    }

    function selectAircraft(i, user) {
      if (!list.length) return;
      i = (i + list.length) % list.length;
      const changed = i !== acIndex;
      acIndex = i;
      const a = currentAircraft();
      if (!spawnManual && a && a.defaultSpawn && spawns.some((s) => s.id === a.defaultSpawn)) spawnId = a.defaultSpawn;
      refresh();
      if (changed || !user) { renderHero(changed); renderControls(); }
      if (user) cards[acIndex].focus({ preventScroll: true });
      persist();
    }
    function selectSpawn(id, user) {
      if (!spawns.some((s) => s.id === id)) return;
      spawnId = id;
      const a = currentAircraft();
      if (user) spawnManual = !(a && a.defaultSpawn === id);
      refresh();
      const sb = spawnButtons.get(id);
      if (sb) sb.b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      persist();
    }
    function persist() { storageSet(STORE_KEY, { aircraftId: currentAircraft() && currentAircraft().id, spawnId, spawnManual }); }

    function fly() {
      if (closed) return;
      const a = currentAircraft();
      if (!a) return;
      closed = true;
      persist();
      if (touch) enterFullscreen();   // touch hook: Android Chrome goes fullscreen + landscape inside this tap
      const s = currentSpawn();
      const result = { aircraftId: a.id, spawnId: spawnId || a.defaultSpawn };
      shared.choice = { ...result, aircraftName: a.name, spawnName: s ? s.name : '', category: a.category };
      cleanup();
      if (hintBox && hintBox.el.isConnected) hintBox.el.remove();
      root.classList.add('gkm-out');
      setTimeout(() => root.remove(), 600);
      resolve(result);
    }

    // missions hook (src/ui/missions-menu.js, CONTRACTS-SF.md §12): "Görevler" + "Günün görevi" entry and panel, loaded
    // once the menu is on screen; a mission closes the menu like "Uç" with { aircraftId, spawnId, mission: { id, daily } }
    function startMission(sel) {
      if (closed || !sel) return;
      closed = true;
      if (touch) enterFullscreen();
      const a = list.find((x) => x.id === (sel.aircraft || '')) || currentAircraft();
      const result = { aircraftId: a ? a.id : list[0].id, spawnId: spawnId || (a && a.defaultSpawn), mission: { id: sel.id, daily: sel.daily || null } };
      cleanup();
      if (hintBox && hintBox.el.isConnected) hintBox.el.remove();
      root.classList.add('gkm-out');
      setTimeout(() => root.remove(), 600);
      resolve(result);
    }
    setTimeout(() => {
      if (closed) return;
      import(new URL('./missions-menu.js', import.meta.url).href)
        .then((m) => { if (!closed) shared.missionsMenu = m.mountMissions({ root, brand, foot, container, touch, start: startMission }); })
        .catch((e) => console.warn('[menu] missions', e));
    }, 0);

    // ---------- keyboard (captured before the game input sees it) ----------
    function onKey(e) {
      if (closed || shared.modalOpen) return;            // the settings / credits modal handles its own keys
      e.stopPropagation();
      if (e.type !== 'keydown' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.code;
      if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); selectAircraft(acIndex + (k === 'ArrowRight' ? 1 : -1), true); }
      else if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        const i = order.indexOf(spawnId);
        const n = order[(i + (k === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
        selectSpawn(n, true);
        const sb = spawnButtons.get(n);
        if (sb && document.activeElement && document.activeElement.classList.contains('gkm-spawn')) sb.b.focus({ preventScroll: true });
      } else if (k === 'Enter' || k === 'NumpadEnter') { e.preventDefault(); fly(); }
      else if (/^(Digit|Numpad)[1-9]$/.test(k)) { const i = Number(k.slice(-1)) - 1; if (i < list.length) selectAircraft(i, true); }
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);

    // ---------- parallax + scale ----------
    let raf = 0, tx = 0, ty = 0;
    function onMove(e) {
      tx = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1);
      ty = clamp((e.clientY / window.innerHeight) * 2 - 1, -1, 1);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; root.style.setProperty('--px', tx.toFixed(3)); root.style.setProperty('--py', ty.toFixed(3)); });
    }
    function layout() {
      const W = window.innerWidth, H = window.innerHeight;
      const u = clamp(Math.min(W / 1440, H / 900), 0.66, 2.6);
      root.style.setProperty('--u', u.toFixed(4));
      // the scene SVG is width-fitted (106% of the viewport); put its water line on the sky's horizon (65.5%)
      const k = (W * 1.06) / SCENE_VB.w;
      const top = H * 0.655 - SCENE_VB.water * k;
      scene.style.top = `${top.toFixed(1)}px`;
      scene.style.height = `${(SCENE_VB.h * k).toFixed(1)}px`;
      const sunX = (-0.03 * W + (SCENE_VB.sunX / SCENE_VB.w) * W * 1.06) / W * 100;
      root.style.setProperty('--sunx', `${sunX.toFixed(2)}%`);
    }
    root.addEventListener('pointermove', onMove);
    window.addEventListener('resize', layout);
    layout();
    function cleanup() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('resize', layout);
      root.removeEventListener('pointermove', onMove);
    }

    renderHero(false);
    renderControls();
    refresh();
    // touch: the chosen start point in view (scrolls the list only: scrollIntoView would also shift the menu itself)
    if (touch) {
      const sb = spawnButtons.get(spawnId);
      if (sb) requestAnimationFrame(() => { const r = sb.b.getBoundingClientRect(), w = spWrap.getBoundingClientRect(); spWrap.scrollTop += (r.top + r.height / 2) - (w.top + w.height / 2); });
    }
    if (touch) showInAppHint(root);   // social-app webviews: "Tarayıcıda aç"
    else setTimeout(() => { if (!closed && !shared.modalOpen) hintBox = showQualityHint(root, () => openSettings(container), 'gkm-hint'); }, 1600);
    if (!touch) requestAnimationFrame(() => { if (!closed) flyBtn.focus({ preventScroll: true }); });
  });
}
