// HUD camera selector: a small glass bar of camera icons (top right, under the "F1 Kontroller" chip). The active camera
// is highlighted and shows its name; the others show their name and direct key on hover. A click goes through the same
// path as the key (Alt / Option + 1 … 7 → input 'cameraSelect'), so the toast and the cockpit-loading message match;
// clicking the active bird's-eye camera flips north-up / track-up. In the bird's-eye view a small compass needle shows
// where north is on screen. Mounted by the HUD (src/ui/hud.js), updated from hud.update().
import { injectCSS, BASE_CSS } from './styles.js';
import { el, svgEl } from './util.js';
import { shared } from './shared.js';
import { CAMERA_ORDER, CAMERA_NAMES, BIRDSEYE_ORIENT, cameraKeyLabel } from './camera-modes.js';

// 24×24 stroke icons (currentColor)
const ICONS = {
  // looking out through the windshield: glareshield arc, frame posts
  cockpit: '<path d="M3.2 15.5l2.6-7h12.4l2.6 7z"/><path d="M12 8.5v7M2.5 19h19"/>',
  // an aircraft seen from behind
  chase: '<circle cx="12" cy="13.6" r="2.2"/><path d="M2.6 15.2l7.3-1.3M21.4 15.2l-7.3-1.3M12 11.4V5.4M8.9 10.2h6.2"/>',
  // fuselage and a swept wing from above, camera near the tip
  wing: '<path d="M5 3v18M5 8.2l14.5 7.3v2.3L5 14.2"/><circle cx="16.5" cy="10.6" r="1.6"/>',
  // free orbit around the aircraft
  orbit: '<circle cx="12" cy="12" r="2.3"/><path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4"/><path d="M19.8 3.8v3.5h-3.5"/>',
  // flyby: the aircraft passing with speed lines
  flyby: '<path d="M12.5 7.2l8.3 4.8-8.3 4.8 2.1-4.8z"/><path d="M3 9h6.5M1.8 12h9M3 15h6.5"/>',
  // control tower
  tower: '<path d="M6.6 6.8h10.8l-1.7 4.4H8.3z"/><path d="M12 3.2v3.6M9.3 11.2l-.9 9.6M14.7 11.2l.9 9.6M5 20.8h14"/>',
  // aircraft from above inside view-finder corners
  birdseye: '<path d="M3.5 8V3.5H8M16 3.5h4.5V8M20.5 16v4.5H16M8 20.5H3.5V16"/><path d="M12 6.8v10.4M7.2 12.6l4.8-1.7 4.8 1.7M10 16.9h4"/>',
};

const CSS = `
.gkc { position: absolute; top: calc(52px * var(--ps, 1)); right: calc(14px * var(--ps, 1)); display: flex; align-items: center; gap: calc(2px * var(--ps, 1));
  padding: calc(3px * var(--ps, 1)); border-radius: calc(12px * var(--ps, 1)); pointer-events: auto;
  background: linear-gradient(180deg, rgba(16, 26, 42, 0.52), rgba(6, 11, 20, 0.5)); border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  -webkit-backdrop-filter: blur(12px) saturate(1.2); backdrop-filter: blur(12px) saturate(1.2);
  transition: opacity .3s ease, visibility 0s linear 0s; }
.gkc.gkc-off { opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility 0s linear .3s; }
.gkc button { position: relative; display: flex; align-items: center; gap: calc(6px * var(--ps, 1)); height: calc(32px * var(--ps, 1)); min-width: calc(32px * var(--ps, 1));
  padding: 0 calc(6px * var(--ps, 1)); border: 0; border-radius: calc(9px * var(--ps, 1)); background: transparent; cursor: pointer;
  color: var(--gk-dim); font: 650 calc(12.5px * var(--ps, 1)) var(--gk-sans); white-space: nowrap; transition: background .15s ease, color .15s ease; }
.gkc button:hover { color: var(--gk-fg); background: rgba(255, 255, 255, .08); }
.gkc button:focus-visible { outline: 2px solid var(--gk-teal); outline-offset: 1px; }
.gkc button.on { color: var(--gk-teal); background: rgba(92, 242, 200, .12); box-shadow: inset 0 0 0 1px rgba(92, 242, 200, .35); padding-right: calc(10px * var(--ps, 1)); }
.gkc svg { width: calc(20px * var(--ps, 1)); height: calc(20px * var(--ps, 1)); flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.gkc .gkc-name { display: none; }
.gkc button.on .gkc-name { display: inline; color: var(--gk-fg); }
.gkc .gkc-n { display: none; width: calc(16px * var(--ps, 1)); height: calc(16px * var(--ps, 1)); margin-left: calc(-1px * var(--ps, 1)); }
.gkc button.on .gkc-n { display: block; }
.gkc .gkc-n svg { width: 100%; height: 100%; stroke: none; }
.gkc .gkc-tip { position: absolute; top: calc(100% + 7px * var(--ps, 1)); right: 0; padding: calc(5px * var(--ps, 1)) calc(9px * var(--ps, 1)); border-radius: calc(8px * var(--ps, 1));
  background: rgba(6, 12, 20, 0.86); border: 1px solid rgba(255, 255, 255, 0.14); color: var(--gk-fg); font-size: calc(12px * var(--ps, 1)); font-weight: 600;
  pointer-events: none; opacity: 0; transform: translateY(-3px); transition: opacity .12s ease, transform .12s ease; }
.gkc .gkc-tip kbd { margin-left: 6px; font: 650 calc(11px * var(--ps, 1)) var(--gk-sans); padding: 1px 5px; border-radius: 4px; background: rgba(255, 255, 255, .1); border: 1px solid rgba(255, 255, 255, .16); color: var(--gk-dim); }
.gkc button:hover .gkc-tip, .gkc button:focus-visible .gkc-tip { opacity: 1; transform: none; transition-delay: .15s; }
@media (max-width: 720px) { .gkc button.on .gkc-name { display: none; } }
`;

// compass needle (north half teal, south half grey), rotated to screen north in the bird's-eye view
const NEEDLE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l2.6 6.5H5.4z" fill="#5cf2c8"/><path d="M8 14.5L5.4 8h5.2z" fill="rgba(208,222,240,.55)"/></svg>';

/**
 * createCameraBar(parent, { select }) → { root, update(visible), setVisible(v) }
 * select(id) defaults to a synthetic Alt + digit key press (handled by src/flight/input.js → main.js 'cameraSelect').
 */
export function createCameraBar(parent, { select = pressCameraKey } = {}) {
  injectCSS('base', BASE_CSS);
  injectCSS('camera-bar', CSS);
  const root = el('div', 'gkc', parent);
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Kamera');
  const buttons = {};
  let needle = null;
  for (const id of CAMERA_ORDER) {
    const b = el('button', null, root);
    b.type = 'button';
    b.dataset.cam = id;
    b.setAttribute('aria-label', `${CAMERA_NAMES[id]} (${cameraKeyLabel(id)})`);
    b.append(svgEl(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg>`));
    el('span', 'gkc-name', b, CAMERA_NAMES[id]);
    if (id === 'birdseye') { needle = el('span', 'gkc-n', b); needle.append(svgEl(NEEDLE)); }
    const tip = el('span', 'gkc-tip', b, CAMERA_NAMES[id]);
    el('kbd', null, tip, cameraKeyLabel(id));
    // keep keyboard focus off the button after a mouse click (Space = brake must not re-click it)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => { b.blur(); select(id); });
    buttons[id] = { b, tip };
  }
  const tipBird = buttons.birdseye.tip;

  let active = null, shown = true, tipKey = '', lastDeg = null;
  function update(visible = true) {
    if (visible !== shown) { shown = visible; root.classList.toggle('gkc-off', !visible); }
    shared.hudVisible = visible;
    const m = shared.cameraMode;
    if (m !== active) {
      if (active && buttons[active]) buttons[active].b.classList.remove('on');
      active = m;
      if (buttons[m]) buttons[m].b.classList.add('on');
    }
    // bird's-eye: compass needle (north on screen) and what a click does in the tooltip
    const bird = m === 'birdseye', tu = !!shared.birdseyeTrackUp;
    const tk = `${bird}${tu}`;
    if (tk !== tipKey) {
      tipKey = tk;
      tipBird.firstChild.textContent = bird ? `${tu ? BIRDSEYE_ORIENT.track : BIRDSEYE_ORIENT.north} · tıkla: ${tu ? 'kuzey' : 'uçuş yönü'} yukarı`
        : CAMERA_NAMES.birdseye;
    }
    if (bird) {
      const deg = Math.round(-(shared.birdseyeBearing || 0) * 180 / Math.PI);
      if (deg !== lastDeg) { lastDeg = deg; needle.style.transform = `rotate(${deg}deg)`; }
    }
  }
  update();
  return { root, update, setVisible: (v) => update(!!v) };
}

/** Same path as the keyboard: Alt / Option + the camera's digit (window keydown / keyup, like util.pressKey). */
function pressCameraKey(id) {
  const n = CAMERA_ORDER.indexOf(id) + 1;
  if (n < 1) return;
  const opts = { code: `Digit${n}`, key: String(n), altKey: true, bubbles: true };
  window.dispatchEvent(new KeyboardEvent('keydown', opts));
  setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { ...opts, altKey: false })), 60);
}
