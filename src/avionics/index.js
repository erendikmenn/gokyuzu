// Avionics: live cockpit displays drawn with Canvas2D and exposed as THREE.CanvasTexture (CONTRACTS-SF §6.4).
//   createDisplay(type, { size?, width?, height?, shared?, fovDeg?, boresight?, variant?, mesh?, eye?, root? })
//     → { canvas, texture, update(dt, flight, world), type, aspect, enabled, drawMs }
// Each type draws in a fixed virtual coordinate system (see DISPLAY_SPECS: vw×vh) whose aspect ratio follows the real
// instrument (square DUs, portrait 6×8" UH-60M MFDs, wide F-16 DED, 4:3 F-22 UFD, CDU). The canvas pixel size is
// `size` on the longer side (default 1024 for PFD/ND/HUD/TSD, 512 otherwise). Screen meshes map UV 0..1 onto it.
// Two displays of the same type and size share one canvas/texture and are drawn once per tick (e.g. captain + F/O
// PFD) unless { shared: false }. Pass { mesh } (the screen mesh) to redraw only while the mesh is actually rendered
// (cockpit view, in the frustum); for HUDs also pass { eye: rig.eye.pilot, root: rig.object } for a conformal
// calibration from the real combiner geometry. display.enabled = false also suspends redraws.
import * as THREE from 'three';
import { createFlightState, readFlight, makeCanvas, Layer, font, text } from './core.js';
import { navData } from './nav.js';
import { calibrateHud } from './hud.js';
import { AIRBUS } from './airbus.js';
import { BOEING } from './boeing.js';
import { F16 } from './f16.js';
import { F22 } from './f22.js';
import { UH60 } from './uh60.js';

const NODATA = {
  vw: 1000, vh: 1000, size: 512,
  create(env) {
    return (g) => {
      g.fillStyle = '#05070a'; g.fillRect(0, 0, 1000, 1000);
      g.strokeStyle = '#2a3440'; g.lineWidth = 6; g.strokeRect(30, 30, 940, 940);
      text(g, 'NO DATA', 500, 500, '#ffffff', 'center', font(90));
      text(g, env.type || '?', 500, 600, '#7f8b99', 'center', font(40, false, true));
    };
  },
};

/** Registry of all display types: { vw, vh, size, transparent?, create(env) → draw(g, S, ctx) }. */
export const DISPLAY_SPECS = { ...AIRBUS, ...BOEING, ...F16, ...F22, ...UH60 };
export const DISPLAY_TYPES = Object.keys(DISPLAY_SPECS).filter((k) => !DISPLAY_SPECS[k].variants);

const sharedCores = new Map();

const variantCounters = new Map();

export function createDisplay(type, opts = {}) {
  opts = opts || {};
  let def = DISPLAY_SPECS[type] || NODATA;
  // generic types with several pages (e.g. 'f22.smfd' on three screens): successive instances cycle through the pages
  if (def.variants) {
    const n = variantCounters.get(type) || 0;
    variantCounters.set(type, n + 1);
    // page from the mesh name when known (screen_smfd_L → 0, _R → 1, _C → 2), else creation order
    const nm = String((opts.mesh && opts.mesh.name) || opts.name || '');
    const byName = /_(L|LEFT)$/i.test(nm) ? 0 : /_(R|RIGHT)$/i.test(nm) ? 1 : /_(C|CENTER|CENTRE)$/i.test(nm) ? 2 : -1;
    const vi = opts.variant ?? (byName >= 0 && byName < def.variants.length ? byName : n);
    const vt = def.variants[vi % def.variants.length];
    return createDisplay(vt, { ...opts, shared: false });
  }
  // HUD: optional conformal calibration from the cockpit geometry ({ mesh: screen_hud, eye: rig.eye.pilot, root: rig.object })
  if (type.endsWith('.hud') && opts.mesh && opts.eye && !opts.fovDeg && DISPLAY_SPECS[type]) {
    const cal = calibrateHud(THREE, opts.mesh, opts.eye, opts.root || null);
    if (cal) { def = { ...def, vw: Math.round(1000 * cal.aspect), vh: 1000 }; opts = { ...opts, fovDeg: cal.fovDeg, boresight: cal.boresight }; }
  }
  const aspect = def.vw / def.vh;
  const base = Math.max(16, Math.round(opts.size || def.size || 512));
  const w = Math.round(opts.width || (aspect >= 1 ? base : base * aspect));
  const h = Math.round(opts.height || (aspect >= 1 ? base / aspect : base));
  const shareable = opts.shared !== false && !opts.fovDeg && !Number.isFinite(opts.boresight) && !(type.endsWith('.hud') && opts.mesh);
  const key = `${type}|${w}|${h}`;
  let core = shareable ? sharedCores.get(key) : null;
  if (!core) {
    core = createCore(type, def, w, h, opts, shareable);
    if (shareable) sharedCores.set(key, core);
  }
  if (opts.mesh) watchMesh(core, opts.mesh);
  return core;
}

/** Visibility tracking: the display only redraws while one of its meshes is actually rendered (≤ 1 redraw / 2 s otherwise). */
function watchMesh(core, mesh) {
  if (!mesh || typeof mesh !== 'object' || mesh.userData?.avionicsWatched === core) return;
  const prev = mesh.onBeforeRender;
  mesh.onBeforeRender = function (...a) { core.lastSeen = performance.now(); if (typeof prev === 'function') return prev.apply(this, a); };
  if (mesh.userData) mesh.userData.avionicsWatched = core;
  core.watched = true;
}

function createCore(type, def, w, h, opts, shareable) {
  const canvas = makeCanvas(w, h);
  const transparent = !!def.transparent;
  const g = canvas.getContext('2d', { alpha: transparent });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  // HUDs: straight (non-premultiplied) alpha upload → correct with THREE.AdditiveBlending (SRC_ALPHA, ONE).
  texture.premultiplyAlpha = false;
  texture.name = `avionics:${type}`;
  const sx = w / def.vw, sy = h / def.vh;
  const env = {
    type, w, h, vw: def.vw, vh: def.vh, opts,
    layer: (draw) => new Layer(w, h, def.vw, def.vh, draw),
  };
  const S = createFlightState();
  let draw;
  try { draw = def.create(env); } catch (e) { console.warn('[avionics] create failed', type, e); draw = NODATA.create(env); }
  const ctx = { world: null, flight: null, nav: null, dt: 0, now: 0 };
  let lastDraw = -1, lastFlight = undefined, errors = 0, pendingDt = 0;
  const minInterval = def.hz ? 1000 / def.hz - 4 : 0;

  const display = {
    type, canvas, texture, aspect: w / h, enabled: true, draws: 0, drawMs: 0, watched: false, lastSeen: 0,
    /** Redraws the display. dt: seconds since the previous update. Never throws. */
    update(dt, flight, world) {
      const now = performance.now();
      pendingDt += Number.isFinite(dt) ? dt : 1 / 30;
      if (display.enabled === false) return;
      if (shareable && lastFlight === flight && now - lastDraw < 8) return;   // shared instance already drawn this tick
      if (minInterval && lastDraw >= 0 && now - lastDraw < minInterval) return; // slow pages (CDU, DED, SD…) refresh less often
      if (display.watched && lastDraw >= 0 && now - display.lastSeen > 400 && now - lastDraw < 2000) return;   // not on screen
      lastDraw = now; lastFlight = flight;
      const step = Math.min(pendingDt, 0.5); pendingDt = 0;
      try {
        readFlight(S, flight, world, step);
        ctx.world = world || null; ctx.flight = flight || null; ctx.nav = navData(world); ctx.dt = step; ctx.now = now / 1000;
        g.setTransform(sx, 0, 0, sy, 0, 0);
        g.lineJoin = 'round'; g.lineCap = 'butt'; g.textBaseline = 'alphabetic'; g.globalAlpha = 1; g.setLineDash([]);
        if (transparent) g.clearRect(0, 0, def.vw, def.vh);
        draw(g, S, ctx);
      } catch (e) {
        if (++errors <= 3) console.warn(`[avionics] ${type} draw error`, e);
        try {
          if (typeof g.reset === 'function') g.reset(); else canvas.width = w;
          g.setTransform(sx, 0, 0, sy, 0, 0);
          if (!transparent) { g.fillStyle = '#000'; g.fillRect(0, 0, def.vw, def.vh); }
          g.strokeStyle = '#ff2020'; g.lineWidth = 8;
          g.beginPath(); g.moveTo(def.vw * 0.2, def.vh * 0.2); g.lineTo(def.vw * 0.8, def.vh * 0.8);
          g.moveTo(def.vw * 0.8, def.vh * 0.2); g.lineTo(def.vw * 0.2, def.vh * 0.8); g.stroke();
        } catch { /* ignore */ }
      }
      texture.needsUpdate = true;
      const ms = performance.now() - now;
      display.draws++; display.drawMs = display.draws < 5 ? ms : display.drawMs * 0.95 + ms * 0.05;
    },
    dispose() { texture.dispose(); for (const [k, v] of sharedCores) if (v === display) sharedCores.delete(k); },
  };
  return display;
}
