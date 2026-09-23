// Baked Bay Area map (src/ui/assets/bay-map.jpg, see tools/bake_bay_map.py): shared loader for the HUD minimap
// and the menu's spawn map card (runways, bridges, airport labels, clickable spawn markers).
import { el, clamp } from './util.js';
import { loadRunways } from './shared.js';
import { AIRPORTS } from './data.js';

const IMG_URL = new URL('./assets/bay-map.jpg', import.meta.url).href;
const META_URL = new URL('./assets/bay-map.json', import.meta.url).href;

// bridge decks (local meters) — drawn as vectors, too thin for the 24 m/px bake
export const BRIDGES = [
  { name: 'Golden Gate', a: [-9153, -21189], b: [-9389, -23617] },
  { name: 'Bay Bridge', a: [-1432, -18777], b: [599, -21231] },
  { name: 'Bay Bridge', a: [1036, -21789], b: [6572, -22847] },
];

let mapPromise = null;
/** Promise<{ img: HTMLImageElement, meta: {minX,maxX,minZ,maxZ,width,height} } | null> */
export function loadBayMap() {
  if (!mapPromise) {
    mapPromise = fetch(META_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => (meta ? new Promise((res) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => res({ img, meta });
        img.onerror = () => res(null);
        img.src = IMG_URL;
      }) : null))
      .catch(() => null);
  }
  return mapPromise;
}

const CSS_PLANE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

/**
 * Menu map card. opts: { spawns, onSelect(id), onHover(id|null) }.
 * Returns { el, setSelected(id), setHover(id) }.
 */
export function createSpawnMap({ spawns = [], onSelect = () => {} } = {}) {
  const root = el('div', 'gkm-map');
  const inner = el('div', 'gkm-map-in', root);
  const imgEl = el('img', 'gkm-map-img', inner);
  imgEl.alt = '';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'gkm-map-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  inner.appendChild(svg);
  const labels = el('div', 'gkm-map-labels', inner);
  const markers = el('div', 'gkm-map-markers', inner);
  const cap = el('div', 'gkm-map-cap', root);
  const capT = el('span', null, cap, '');
  el('span', 'gkm-map-n', cap, 'K ↑');
  let meta = null, selected = null, hover = null;
  const mk = new Map();

  const pct = (x, z) => [((x - meta.minX) / (meta.maxX - meta.minX)) * 100, ((z - meta.minZ) / (meta.maxZ - meta.minZ)) * 100];

  function line(a, b, cls) {
    const l = document.createElementNS(svgNS, 'line');
    l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]); l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]);
    l.setAttribute('class', cls);
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(l);
  }

  function build(rw) {
    svg.setAttribute('viewBox', `${meta.minX} ${meta.minZ} ${meta.maxX - meta.minX} ${meta.maxZ - meta.minZ}`);
    for (const b of BRIDGES) line(b.a, b.b, 'gkm-map-bridge');
    for (const a of (rw && rw.airports) || []) {
      for (const r of a.runways || []) {
        const [e0, e1] = r.ends || [];
        if (e0 && e1) line([e0.x, e0.z], [e1.x, e1.z], 'gkm-map-rwy');
      }
      const c = a.center || (a.runways && a.runways[0] && a.runways[0].center);
      if (!c) continue;
      const [px, py] = pct(c.x, c.z);
      const lab = el('span', 'gkm-map-apt', labels, (AIRPORTS[a.icao] && AIRPORTS[a.icao].code) || a.icao);
      // labels sit beside the field, away from the runways
      const dx = a.icao === 'KSFO' ? -9 : a.icao === 'KOAK' ? 7 : 0;
      const dy = a.icao === 'KNGZ' ? -5.5 : a.icao === 'KSFO' ? 3 : 5;
      lab.style.left = `${px + dx}%`; lab.style.top = `${py + dy}%`;
    }
    const gg = pct(-9600, -22600);
    const t = el('span', 'gkm-map-lm', labels, 'Golden Gate');
    t.style.left = `${gg[0] + 8.5}%`; t.style.top = `${gg[1] - 1.5}%`;
    const sf = pct(-5600, -17200);
    const t2 = el('span', 'gkm-map-city', labels, 'San Francisco');
    t2.style.left = `${sf[0]}%`; t2.style.top = `${sf[1]}%`;
    const oak = pct(12500, -16500);
    const t3 = el('span', 'gkm-map-city', labels, 'Oakland');
    t3.style.left = `${oak[0]}%`; t3.style.top = `${oak[1]}%`;

    for (const s of spawns) {
      const [px, py] = pct(s.x, s.z);
      const b = el('button', `gkm-mk${s.altitude ? ' air' : ''}`, markers);
      b.type = 'button';
      b.tabIndex = -1;
      b.title = s.name || s.id;
      b.style.left = `${clamp(px, 1, 99)}%`; b.style.top = `${clamp(py, 1, 99)}%`;
      const deg = ((s.heading || 0) * 180) / Math.PI;
      const arrow = el('i', 'gkm-mk-dir', b);
      arrow.style.transform = `rotate(${deg + 180}deg)`;
      if (s.altitude) { const p = el('span', 'gkm-mk-plane', b); p.innerHTML = CSS_PLANE; p.style.transform = `rotate(${deg}deg)`; }
      b.addEventListener('click', (e) => { e.stopPropagation(); onSelect(s.id); });
      mk.set(s.id, b);
    }
    refresh();
  }

  function refresh() {
    for (const [id, b] of mk) {
      b.classList.toggle('sel', id === selected);
      b.classList.toggle('hov', id === hover && id !== selected);
    }
    const s = spawns.find((x) => x.id === (hover || selected));
    capT.textContent = s ? (s.name || s.id) : '';
  }

  Promise.all([loadBayMap(), loadRunways()]).then(([m, rw]) => {
    if (!m) { root.classList.add('gkm-map-none'); return; }
    meta = m.meta;
    imgEl.src = m.img.src;
    inner.style.aspectRatio = `${meta.width} / ${meta.height}`;
    build(rw);
    root.classList.add('ready');
  });

  return {
    el: root,
    setSelected(id) { selected = id; refresh(); },
    setHover(id) { hover = id; refresh(); },
  };
}

export const SPAWN_MAP_CSS = `
.gkm-map { position: relative; width: min(100%, calc(360 * var(--u1))); border-radius: calc(18 * var(--u1)); overflow: hidden;
  background: rgba(6, 12, 24, .82); border: 1px solid rgba(170, 205, 255, .16);
  -webkit-backdrop-filter: blur(24px) saturate(1.2); backdrop-filter: blur(24px) saturate(1.2);
  box-shadow: 0 24px 60px rgba(0, 0, 0, .38), inset 0 1px 0 rgba(255, 255, 255, .06); opacity: 0; transition: opacity .5s ease; }
.gkm-map.ready { opacity: 1; }
.gkm-map.gkm-map-none { display: none; }
.gkm-map-in { position: relative; width: 100%; aspect-ratio: 1553 / 1490; }
.gkm-map-img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; filter: saturate(1.05) brightness(1.08); }
.gkm-map-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.gkm-map-rwy { stroke: rgba(236, 242, 250, .92); stroke-width: 2.2; stroke-linecap: butt; }
.gkm-map-bridge { stroke: #ff7a4a; stroke-width: 1.8; stroke-linecap: round; opacity: .9; }
.gkm-map-labels, .gkm-map-markers { position: absolute; inset: 0; }
.gkm-map-labels > span { position: absolute; transform: translate(-50%, -50%); white-space: nowrap; pointer-events: none;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .8), 0 0 8px rgba(0, 0, 0, .6); }
.gkm-map-apt { font: 800 calc(10.5 * var(--u1)) var(--gk-mono); letter-spacing: .06em; color: #5cf2c8; }
.gkm-map-lm { font: 650 calc(9.5 * var(--u1)) var(--gk-sans); color: #ffb48f; }
.gkm-map-city { font: 700 calc(9 * var(--u1)) var(--gk-sans); letter-spacing: .22em; text-transform: uppercase; color: rgba(220, 232, 248, .55); }
.gkm-mk { position: absolute; width: calc(22 * var(--u1)); height: calc(22 * var(--u1)); margin: calc(-11 * var(--u1)) 0 0 calc(-11 * var(--u1)); padding: 0;
  border: 0; background: none; cursor: pointer; }
.gkm-mk::before { content: ""; position: absolute; left: 50%; top: 50%; width: calc(7 * var(--u1)); height: calc(7 * var(--u1)); transform: translate(-50%, -50%);
  border-radius: 50%; background: rgba(255, 255, 255, .8); box-shadow: 0 0 0 2px rgba(6, 12, 20, .6); transition: all .2s; }
.gkm-mk.air::before { display: none; }
.gkm-mk-plane { position: absolute; inset: calc(3 * var(--u1)); color: rgba(255, 255, 255, .85); filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .8)); transition: color .2s; }
.gkm-mk-plane svg { width: 100%; height: 100%; display: block; }
.gkm-mk-dir { position: absolute; left: 50%; top: 50%; width: 2px; height: calc(20 * var(--u1)); margin-left: -1px; transform-origin: 50% 0; opacity: 0; pointer-events: none; }
.gkm-mk-dir::after { content: ""; position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); border: calc(4 * var(--u1)) solid transparent; border-bottom: 0; border-top: calc(7 * var(--u1)) solid var(--gk-orange); }
.gkm-mk-dir::before { content: ""; position: absolute; left: 0; right: 0; top: 0; bottom: calc(6 * var(--u1)); background: var(--gk-orange); border-radius: 2px; }
.gkm-mk:hover::before, .gkm-mk.hov::before { background: #fff; width: calc(10 * var(--u1)); height: calc(10 * var(--u1)); }
.gkm-mk.hov .gkm-mk-plane { color: #fff; }
.gkm-mk.sel { z-index: 2; }
.gkm-mk.sel::before { width: calc(10 * var(--u1)); height: calc(10 * var(--u1)); background: var(--gk-orange); box-shadow: 0 0 0 2px #fff, 0 0 16px 3px rgba(255, 107, 61, .8); }
.gkm-mk.sel::after { content: ""; position: absolute; left: 50%; top: 50%; width: calc(34 * var(--u1)); height: calc(34 * var(--u1)); transform: translate(-50%, -50%);
  border-radius: 50%; border: 2px solid rgba(255, 140, 90, .8); animation: gkm-ping 1.8s ease-out infinite; pointer-events: none; }
.gkm-mk.sel .gkm-mk-dir { opacity: 1; }
.gkm-mk.sel .gkm-mk-plane { color: var(--gk-orange); filter: drop-shadow(0 0 6px rgba(255, 107, 61, .9)); }
.gkm-mk.air.sel::before { display: none; }
@keyframes gkm-ping { from { opacity: .9; transform: translate(-50%, -50%) scale(.4); } to { opacity: 0; transform: translate(-50%, -50%) scale(1.25); } }
.gkm-map-cap { display: flex; justify-content: space-between; align-items: center; gap: calc(10 * var(--u1)); padding: calc(9 * var(--u1)) calc(14 * var(--u1)) calc(10 * var(--u1));
  font-size: calc(11.5 * var(--u1)); font-weight: 650; color: rgba(236, 244, 255, .88); border-top: 1px solid rgba(255, 255, 255, .07); }
.gkm-map-cap > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gkm-map-n { flex: 0 0 auto; font: 800 calc(10 * var(--u1)) var(--gk-mono); color: #ff9a6a; }
`;
