// Navigation data for the displays: airports/runways, a shared terrain height grid sampled progressively from
// world.getGroundHeight (EGPWS terrain + relief maps), map projection, synthetic air traffic (TCAS/radar) and a
// fighter steerpoint route. Everything is cached and budgeted so that no display update spends > ~0.4 ms here.
import { DEG, NM, FT, clamp, wrap360, makeCanvas, touchCanvas, font } from './core.js';

// ---------------------------------------------------------------- airports & runways
import { activeMap } from '../maps/index.js';
let fallbackJSON = null, fetching = false;
const prepared = new WeakMap();
const EMPTY = { airports: [], runways: [], decl: 12.9 };

function prepare(json) {
  let P = prepared.get(json);
  if (P) return P;
  const airports = [], runways = [];
  for (const a of json.airports || []) {
    const ap = { icao: a.icao || '----', name: a.name || '', x: +a.center?.x || 0, z: +a.center?.z || 0, elev: +a.elevation || 0, military: !!a.military, runways: [] };
    for (const r of a.runways || []) {
      const [e0, e1] = r.ends || [];
      if (!e0 || !e1) continue;
      const dx = e1.x - e0.x, dz = e1.z - e0.z, len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len, hw = (r.width || 45) / 2;
      const rw = {
        id: r.id, airport: ap.icao, width: r.width || 45, length: len, elev: +r.elevation || ap.elev,
        ends: [e0, e1], x0: e0.x, z0: e0.z, x1: e1.x, z1: e1.z, ux, uz,
        corners: [e0.x - uz * hw, e0.z + ux * hw, e1.x - uz * hw, e1.z + ux * hw, e1.x + uz * hw, e1.z - ux * hw, e0.x + uz * hw, e0.z - ux * hw],
      };
      ap.runways.push(rw); runways.push(rw);
    }
    airports.push(ap);
  }
  P = { airports, runways, decl: Number.isFinite(json.magneticDeclination) ? json.magneticDeclination : 12.9 };
  prepared.set(json, P);
  return P;
}

/** { airports, runways, decl } from world.runways (or the active map's runways.json fetched once when no world is given). */
export function navData(world) {
  const j = world && world.runways;
  if (j && Array.isArray(j.airports)) return prepare(j);
  if (!fallbackJSON && !fetching && typeof fetch === 'function') {
    fetching = true;
    fetch(new URL(`../../${activeMap().data}runways.json`, import.meta.url).href).then((r) => r.json()).then((d) => { fallbackJSON = d; }).catch(() => {});
  }
  return fallbackJSON ? prepare(fallbackJSON) : EMPTY;
}

export const LANDMARKS = [
  { id: 'GGB', name: 'GOLDEN GATE', x: -9249, z: -22236 },
  { id: 'ALCTZ', name: 'ALCATRAZ', x: -4393, z: -23016 },
  { id: 'BAYBR', name: 'BAY BRIDGE', x: 1200, z: -20900 },
  { id: 'SFDWN', name: 'DOWNTOWN', x: -2300, z: -19200 },
  { id: 'SUTRO', name: 'SUTRO', x: -5900, z: -17300 },
];

/** Bearing (true deg) and distance (m) from (x,z) to (tx,tz). */
export function bearingTo(x, z, tx, tz) { return wrap360(Math.atan2(tx - x, -(tz - z)) / DEG); }
export function distTo(x, z, tx, tz) { return Math.hypot(tx - x, tz - z); }

/** Airport "ahead" of the aircraft (smallest distance weighted by bearing error), used as the active waypoint. */
export function pickDestination(nav, x, z, trackDeg) {
  let best = null, bestScore = Infinity;
  for (const a of nav.airports) {
    const d = distTo(x, z, a.x, a.z);
    const off = Math.abs(((bearingTo(x, z, a.x, a.z) - trackDeg + 540) % 360) - 180);
    const score = d * (1 + (off / 30) ** 2) + (d < 2500 ? 50000 : 0);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best;
}
export function nearestAirport(nav, x, z) {
  let best = null, bd = Infinity;
  for (const a of nav.airports) { const d = distTo(x, z, a.x, a.z); if (d < bd) { bd = d; best = a; } }
  return best;
}

// ---------------------------------------------------------------- map projection
export class MapView {
  constructor() { this.cx = 0; this.cy = 0; this.ax = 0; this.az = 0; this.up = 0; this.k = 1; this.c = 1; this.s = 0; this.px = 0; this.py = 0; }
  /** Screen center (cx,cy) = aircraft (ax,az); upDeg = true direction shown at the top; k = px per meter. */
  set(cx, cy, ax, az, upDeg, k) {
    this.cx = cx; this.cy = cy; this.ax = ax; this.az = az; this.up = upDeg; this.k = k;
    this.c = Math.cos(upDeg * DEG); this.s = Math.sin(upDeg * DEG);
    return this;
  }
  project(x, z) {
    const dx = x - this.ax, dz = z - this.az;
    this.px = this.cx + this.k * (dx * this.c + dz * this.s);
    this.py = this.cy + this.k * (-dx * this.s + dz * this.c);
    return this;
  }
  /** Multiply the current transform so that subsequent drawing uses world (x,z) meters. */
  apply(g) { g.translate(this.cx, this.cy); g.rotate(-this.up * DEG); g.scale(this.k, this.k); g.translate(-this.ax, -this.az); }
  /** Screen x of a true bearing on a rose centred on (cx,cy). */
}

/** Draws every runway as an outlined rectangle (projected). */
export function drawRunways(g, nav, view, color, minWidthPx = 3, fill = null) {
  g.strokeStyle = color; g.lineWidth = 2;
  for (const r of nav.runways) {
    const c = r.corners;
    view.project(c[0], c[1]); const x0 = view.px, y0 = view.py;
    view.project(c[4], c[5]); const x2 = view.px, y2 = view.py;
    if ((x0 < -200 && x2 < -200) || (x0 > 1300 && x2 > 1300) || (y0 < -200 && y2 < -200) || (y0 > 1300 && y2 > 1300)) continue;
    const wpx = r.width * view.k;
    if (wpx < minWidthPx) {
      // thin: draw as a fat line with a centre line
      view.project(r.x0, r.z0); const ax = view.px, ay = view.py;
      view.project(r.x1, r.z1); const bx = view.px, by = view.py;
      const L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L * minWidthPx / 2, ny = (bx - ax) / L * minWidthPx / 2;
      g.beginPath(); g.moveTo(ax + nx, ay + ny); g.lineTo(bx + nx, by + ny); g.lineTo(bx - nx, by - ny); g.lineTo(ax - nx, ay - ny); g.closePath();
    } else {
      g.beginPath(); g.moveTo(x0, y0);
      view.project(c[2], c[3]); g.lineTo(view.px, view.py);
      g.lineTo(x2, y2);
      view.project(c[6], c[7]); g.lineTo(view.px, view.py);
      g.closePath();
    }
    if (fill) { g.fillStyle = fill; g.fill(); }
    g.stroke();
  }
}

// ---------------------------------------------------------------- terrain grid (shared per world)
const GX0 = -18500, GX1 = 22800, GZ0 = -30000, GZ1 = 9800, GN = 256;
const grids = new WeakMap();
let frameStart = 0, frameSpent = 0;

class TerrainGrid {
  constructor(world) {
    this.world = world;
    this.n = GN; this.x0 = GX0; this.z0 = GZ0; this.dx = (GX1 - GX0) / GN; this.dz = (GZ1 - GZ0) / GN;
    this.w = GX1 - GX0; this.h = GZ1 - GZ0;
    this.height = new Float32Array(GN * GN);
    this.water = new Uint8Array(GN * GN);
    this.cursor = 0; this.passes = 0; this.version = 0; this.changed = false; this.maxH = 1;
  }
  /** Samples the world for up to budgetMs (shared across all displays in the same frame). */
  tick(budgetMs = 0.4) {
    const now = performance.now();
    if (now - frameStart > 6) { frameStart = now; frameSpent = 0; }
    const budget = (this.passes === 0 ? budgetMs : budgetMs * 0.25) - frameSpent;
    if (budget <= 0) return;
    const world = this.world, N = this.n, H = this.height, Wt = this.water;
    const hasWater = typeof world.isWater === 'function';
    let n = 0;
    for (;;) {
      const i = this.cursor, row = (i / N) | 0, col = i - row * N;
      const x = this.x0 + (col + 0.5) * this.dx, z = this.z0 + (row + 0.5) * this.dz;
      let h = 0, wet = 0;
      try {
        h = +world.getGroundHeight(x, z);
        if (!Number.isFinite(h)) h = 0;
        wet = hasWater ? (world.isWater(x, z) ? 1 : 0) : (h <= 0.3 ? 1 : 0);
      } catch { h = 0; wet = 0; }
      if (Math.abs(H[i] - h) > 2 || Wt[i] !== wet) this.changed = true;
      H[i] = h; Wt[i] = wet;
      if (h > this.maxH) this.maxH = h;
      this.cursor++;
      if (this.passes === 0 && (this.cursor % (N * 32)) === 0) { this.version++; this.changed = false; }
      if (this.cursor >= N * N) {
        this.cursor = 0; this.passes++;
        if (this.changed || this.passes === 1) this.version++;
        this.changed = false;
      }
      if ((++n & 31) === 0) {
        const dt = performance.now() - now;
        if (dt > budget || n >= N * N) { frameSpent += dt; break; }   // (at most one pass: a frozen or coarse clock never hangs here)
      }
    }
  }
  get ready() { return this.passes > 0 || this.cursor > this.n * 32; }
  heightAt(x, z) {
    const fx = (x - this.x0) / this.dx - 0.5, fz = (z - this.z0) / this.dz - 0.5;
    const N = this.n, i = clamp(Math.floor(fx), 0, N - 2), j = clamp(Math.floor(fz), 0, N - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1), H = this.height, k = j * N + i;
    return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + N] * (1 - tx) + H[k + N + 1] * tx) * tz;
  }
}

/** Shared terrain grid for this world, or null when the world has no height function. */
export function terrainGrid(world) {
  if (!world || typeof world.getGroundHeight !== 'function') return null;
  let G = grids.get(world);
  if (!G) { G = new TerrainGrid(world); grids.set(world, G); }
  return G;
}

/** EGPWS-style dotted terrain image relative to the aircraft altitude (recoloured progressively). */
export class TerrainAlertImage {
  constructor() {
    this.canvas = makeCanvas(GN, GN);
    this.g = this.canvas.getContext('2d');
    this.img = this.g.createImageData(GN, GN);
    this.row = GN; this.alt = -1e9; this.ver = -1; this.floor = 0; this.pending = false; this.hasContent = false;
    this.peak = 0; this.low = 0;
  }
  /** altFt: aircraft altitude; floorFt: terrain below this is suppressed (runway elevation + 400 ft). */
  update(G, altFt, floorFt, gearDown) {
    if (!G) return;
    if (this.row >= GN && (G.version !== this.ver || Math.abs(altFt - this.alt) > 60)) {
      this.row = 0; this.ver = G.version; this.alt = altFt; this.floor = floorFt; this.gear = gearDown; this._peak = -1e9;
    }
    if (this.row >= GN) return;
    const d = this.img.data, H = G.height, W = G.water, alt = this.alt, lowLim = this.gear ? -250 : -500;
    const rows = 48, r1 = Math.min(GN, this.row + rows);
    for (let j = this.row; j < r1; j++) {
      for (let i = 0; i < GN; i++) {
        const k = j * GN + i, p = k * 4;
        const hf = H[k] * FT;
        if (hf > this._peak) this._peak = hf;
        const rel = hf - alt;
        let r = 0, gr = 0, b = 0, a = 0, dens = 0;
        if (W[k] || hf < this.floor) dens = 0;
        else if (rel > 2000) { r = 255; gr = 20; dens = 2; }
        else if (rel > 1000) { r = 255; gr = 230; dens = 2; }
        else if (rel > lowLim) { r = 255; gr = 230; dens = 1; }
        else if (rel > -1000) { gr = 210; dens = 2; }
        else if (rel > -2000) { gr = 190; dens = 1; }
        if (dens === 2 ? ((i + j) & 1) === 0 : dens === 1 ? ((i & 1) === 0 && (j & 1) === 0) : false) a = 255;
        d[p] = r; d[p + 1] = gr; d[p + 2] = b; d[p + 3] = a;
      }
    }
    this.g.putImageData(this.img, 0, 0, 0, this.row, GN, r1 - this.row);
    touchCanvas(this.canvas);   // content version for the displays' upload skipping
    this.row = r1;
    if (this.row >= GN) { this.hasContent = true; this.peak = this._peak; }
  }
  /** Draws the image in world coordinates (call after view.apply). */
  draw(g) {
    g.imageSmoothingEnabled = false;
    g.drawImage(this.canvas, GX0, GZ0, GX1 - GX0, GZ1 - GZ0);
    g.imageSmoothingEnabled = true;
  }
}

/** Shaded relief map (land colour ramp + hillshade, water colour). palette: 'chart' | 'dark'. */
const PALETTES = {
  chart: { water: [38, 84, 140], shore: [52, 104, 160], ramp: [[0, 150, 170, 120], [60, 170, 176, 118], [150, 188, 172, 116], [300, 186, 150, 104], [600, 160, 124, 90], [1200, 205, 190, 170]] },
  dark: { water: [8, 22, 40], shore: [12, 32, 54], ramp: [[0, 46, 50, 40], [100, 58, 60, 46], [300, 72, 68, 52], [700, 88, 80, 62], [1200, 110, 104, 92]] },
};
const RN = 512;   // relief image resolution (bilinear from the 256² grid → smooth coastlines)
export class ReliefImage {
  constructor(palette = 'chart') {
    this.canvas = makeCanvas(RN, RN);
    this.g = this.canvas.getContext('2d');
    this.img = this.g.createImageData(RN, RN);
    this.pal = PALETTES[palette] || PALETTES.chart;
    this.row = RN; this.ver = -1; this.hasContent = false;
  }
  update(G) {
    if (!G) return;
    if (this.row >= RN && G.version !== this.ver) { this.row = 0; this.ver = G.version; }
    if (this.row >= RN) return;
    const d = this.img.data, H = G.height, W = G.water, P = this.pal, ramp = P.ramp, N = GN;
    const r1 = Math.min(RN, this.row + 48), sc = N / RN;
    const cellX = G.dx * sc * 2, cellZ = G.dz * sc * 2;
    for (let j = this.row; j < r1; j++) {
      const fz = (j + 0.5) * sc - 0.5, j0 = clamp(Math.floor(fz), 0, N - 2), tz = clamp(fz - j0, 0, 1);
      for (let i = 0; i < RN; i++) {
        const fx = (i + 0.5) * sc - 0.5, i0 = clamp(Math.floor(fx), 0, N - 2), tx = clamp(fx - i0, 0, 1);
        const k = j0 * N + i0;
        const w00 = 1 - tx - tz + tx * tz, w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
        const h = H[k] * w00 + H[k + 1] * w10 + H[k + N] * w01 + H[k + N + 1] * w11;
        const wet = W[k] * w00 + W[k + 1] * w10 + W[k + N] * w01 + W[k + N + 1] * w11;
        const p = (j * RN + i) * 4;
        let r, gg, b;
        if (wet > 0.5) {
          const c = wet < 0.8 ? P.shore : P.water; r = c[0]; gg = c[1]; b = c[2];
        } else {
          let q = 0;
          while (q < ramp.length - 2 && h > ramp[q + 1][0]) q++;
          const a0 = ramp[q], a1 = ramp[q + 1], t = clamp((h - a0[0]) / (a1[0] - a0[0]), 0, 1);
          r = a0[1] + (a1[1] - a0[1]) * t; gg = a0[2] + (a1[2] - a0[2]) * t; b = a0[3] + (a1[3] - a0[3]) * t;
          // hillshade (light from the north-west) from the grid cell gradient
          const sx = ((H[k + 1] - H[k]) * (1 - tz) + (H[k + N + 1] - H[k + N]) * tz) / (cellX / 2);
          const sz = ((H[k + N] - H[k]) * (1 - tx) + (H[k + N + 1] - H[k + 1]) * tx) / (cellZ / 2);
          const shade = clamp(1 + (sx + sz) * 1.8, 0.55, 1.4);
          r *= shade; gg *= shade; b *= shade;
        }
        d[p] = r; d[p + 1] = gg; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    this.g.putImageData(this.img, 0, 0, 0, this.row, RN, r1 - this.row);
    touchCanvas(this.canvas);   // content version for the displays' upload skipping
    this.row = r1;
    if (this.row >= RN) this.hasContent = true;
  }
  draw(g) { g.drawImage(this.canvas, GX0, GZ0, GX1 - GX0, GZ1 - GZ0); }
}

// ---------------------------------------------------------------- synthetic traffic (TCAS / radar / TSD)
// Circular tracks over the bay: { cx, cz, r (m), v (m/s), alt (m), ph (rad), dir (+1 cw / -1 ccw), kind, id }
const TRAFFIC = [
  { id: 'UAL123', cx: 6500, cz: -2500, r: 7000, v: 120, alt: 1500, ph: 0.3, dir: 1, kind: 'airliner' },
  { id: 'SWA456', cx: 12000, cz: -15000, r: 5000, v: 110, alt: 900, ph: 2.1, dir: -1, kind: 'airliner' },
  { id: 'N172SP', cx: -4300, cz: -23000, r: 1600, v: 50, alt: 450, ph: 4.0, dir: 1, kind: 'ga' },
  { id: 'CHP12', cx: -9200, cz: -22000, r: 900, v: 35, alt: 250, ph: 1.0, dir: -1, kind: 'heli' },
  { id: 'VIPER2', cx: 2000, cz: -14000, r: 9000, v: 190, alt: 4600, ph: 5.2, dir: 1, kind: 'fighter' },
  { id: 'ASA88', cx: -1000, cz: -9000, r: 12000, v: 150, alt: 3300, ph: 3.3, dir: -1, kind: 'airliner' },
  { id: 'BANDIT', cx: -9000, cz: -36000, r: 8000, v: 230, alt: 8500, ph: 0.8, dir: -1, kind: 'hostile' },
];
let trafficOut = TRAFFIC.map((t) => ({ id: t.id, kind: t.kind, x: 0, z: 0, alt: 0, hdg: 0, gs: 0, vs: 0 }));
/** Positions of the synthetic traffic at time t (s). Returned array is reused. */
export function traffic(t) {
  for (let i = 0; i < TRAFFIC.length; i++) {
    const T = TRAFFIC[i], o = trafficOut[i];
    const a = T.ph + T.dir * T.v * t / T.r;
    o.x = T.cx + T.r * Math.sin(a); o.z = T.cz - T.r * Math.cos(a);
    o.hdg = wrap360(a / DEG + T.dir * 90);
    o.alt = T.alt + 120 * Math.sin(t * 0.02 + i);
    o.vs = 120 * 0.02 * Math.cos(t * 0.02 + i);
    o.gs = T.v;
  }
  return trafficOut;
}
export const clockSeconds = () => performance.now() / 1000;

// ---------------------------------------------------------------- fighter route (steerpoints)
export const STEERPOINTS = [
  { n: 1, name: 'ALAMEDA', x: 5072, z: -18606, elev: 3 },
  { n: 2, name: 'GOLDEN GATE', x: -9249, z: -22236, elev: 67 },
  { n: 3, name: 'SUTRO', x: -5900, z: -17300, elev: 250 },
  { n: 4, name: 'SFO', x: -51, z: 49, elev: 4 },
  { n: 5, name: 'OAKLAND', x: 13595, z: -11860, elev: 3 },
];
const routeStates = new WeakMap();
/** Current steerpoint index for this flight (sequences automatically within 1 NM). */
export function steerpoint(key, x, z) {
  const k = key && typeof key === 'object' ? key : STEERPOINTS;
  let st = routeStates.get(k);
  if (!st) {
    // start with the steerpoint after the closest one
    let bi = 0, bd = Infinity;
    STEERPOINTS.forEach((s, i) => { const d = distTo(x, z, s.x, s.z); if (d < bd) { bd = d; bi = i; } });
    st = { i: (bi + 1) % STEERPOINTS.length, changedAt: -1e9, x, z };
    routeStates.set(k, st);
  }
  const sp = STEERPOINTS[st.i];
  if (distTo(x, z, sp.x, sp.z) < NM) { st.i = (st.i + 1) % STEERPOINTS.length; st.changedAt = performance.now() / 1000; }
  // teleports (reset) → re-evaluate
  if (distTo(x, z, st.x, st.z) > 3000) {
    let bi = 0, bd = Infinity;
    STEERPOINTS.forEach((s, i) => { const d = distTo(x, z, s.x, s.z); if (d < bd) { bd = d; bi = i; } });
    st.i = (bi + 1) % STEERPOINTS.length;
  }
  st.x = x; st.z = z;
  return st;
}

const reliefCache = new WeakMap();
/** Shared relief image for a terrain grid and palette (progressively rendered). */
export function reliefFor(G, palette = 'chart') {
  if (!G) return null;
  let m = reliefCache.get(G);
  if (!m) { m = {}; reliefCache.set(G, m); }
  if (!m[palette]) m[palette] = new ReliefImage(palette);
  m[palette].update(G);
  return m[palette];
}

// ---------------------------------------------------------------- ILS (computed from runway geometry)
let ILS_FREQ = { KSFO: ['109.55', '111.70', '108.90', '109.30', '111.30', '108.50', '110.75', '109.90'], KOAK: ['111.90', '108.70', '109.90', '110.90', '111.50', '109.30', '108.10', '110.30'], KNGZ: ['110.10', '109.10'] };
const ilsOut = { valid: false, ident: '', freq: '', course: 0, courseTrue: 0, dme: 0, loc: 0, gs: 0, gsValid: false, runway: '', airport: '', elev: 0, thx: 0, thz: 0, ux: 0, uz: 0 };
/**
 * Best ILS for the aircraft: a runway end ahead of it (within 25 NM, ±35° of track, inside the ±10° localizer sector).
 * loc/gs deviations in dots (+loc = course is to the right, +gs = glide path is above). Returned object is reused.
 */
export function ilsFor(nav, S) {
  const o = ilsOut; o.valid = false; o.gsValid = false;
  let best = Infinity;
  for (const ap of nav.airports) {
    ap.runways.forEach((r, ri) => {
      for (let e = 0; e < 2; e++) {
        const th = r.ends[e], far = r.ends[1 - e];
        const ux = (far.x - th.x) / r.length, uz = (far.z - th.z) / r.length;   // landing direction
        const dx = S.x - th.x, dz = S.z - th.z;
        const along = dx * ux + dz * uz;           // < 0 before the threshold
        if (along > 300 || along < -25 * NM) continue;
        const crs = wrap360(Math.atan2(ux, -uz) / DEG);
        const trkErr = Math.abs(((S.track - crs + 540) % 360) - 180);
        if (trkErr > 35 && S.gs > 30) continue;
        const lat = -dx * uz + dz * ux;            // + = aircraft right of the centreline (looking along the landing direction)
        const dLoc = r.length - along + 300;       // localizer antenna beyond the far end
        const locAng = Math.atan2(lat, dLoc) / DEG;
        if (Math.abs(locAng) > 10) continue;
        const score = -along + Math.abs(locAng) * 800;
        if (score < best) {
          best = score;
          o.valid = true; o.airport = ap.icao; o.runway = th.ident || ''; o.elev = Number.isFinite(th.elevation) ? th.elevation : r.elev; o.thx = th.x; o.thz = th.z; o.ux = ux; o.uz = uz;   // (sloped runways: the threshold's own elevation)
          o.courseTrue = crs; o.course = wrap360(crs - nav.decl);
          o.loc = clamp(-locAng / 1.0, -2.5, 2.5);
          const dGpi = Math.max(50, 300 - along);
          const gpa = Math.atan2(S.alt / FT - o.elev, dGpi) / DEG;
          o.gs = clamp((3 - gpa) / 0.35, -2.5, 2.5);
          o.gsValid = along < 0 && dGpi < 18 * NM;
          o.dme = Math.hypot(dx, dz) / NM;
          o.ident = 'I' + ap.icao.slice(1) ;
          const fl = ILS_FREQ[ap.icao] || ['110.30'];
          o.freq = fl[(ri * 2 + e) % fl.length];
        }
      }
    });
  }
  return o;
}

/** Dashed extended centreline (10 NM) of the ILS runway, projected with `view`. */
export function drawCenterline(g, ils, view, color) {
  if (!ils.valid) return;
  view.project(ils.thx, ils.thz); const x0 = view.px, y0 = view.py;
  view.project(ils.thx - ils.ux * 10 * NM, ils.thz - ils.uz * 10 * NM);
  g.strokeStyle = color; g.lineWidth = 2.5; g.setLineDash([18, 14]); line2(g, x0, y0, view.px, view.py); g.setLineDash([]);
}
function line2(g, a, b, c, d) { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); }

// ---------------------------------------------------------------- planned route (src/nav/route.js, map + LNAV)
/** FMS-style identifier of a route waypoint: WPT01…, BS28R (base), IF28R, FF28R (FAF), RW28R, HV28R (hover). */
const ID_PREFIX = { base: 'BS', if: 'IF', faf: 'FF', thr: 'RW', hov: 'HV' };
export function routeIdent(route, w) {
  if (w._ndIdV === route.version) return w._ndId;            // cached until the route is edited
  const rw = route.approach ? route.approach.rw.ident : '';
  w._ndId = w.kind === 'wpt' ? `WPT${String(route.user.indexOf(w) + 1).padStart(2, '0')}` : (ID_PREFIX[w.kind] || 'WP') + rw;
  w._ndIdV = route.version;
  return w._ndId;
}

/**
 * Route on an ND: the active leg from the aircraft to the TO waypoint, then the remaining legs, with waypoint
 * symbols ('star' Boeing / 'diamond' Airbus) and identifiers. c: { active, legs, sym, toSym, label, toLabel }.
 * Returns the TO waypoint (or null). The caller has clipped the canvas to the map area.
 */
export function drawRouteND(g, S, view, c, symbol = 'star') {
  const route = S.route;
  if (!route || !route.hasActive) return null;
  const W = route.waypoints, a = route.active;
  view.project(S.x, S.z);
  let px = view.px, py = view.py;
  g.lineWidth = 4;
  for (let i = a; i < W.length; i++) {
    view.project(W[i].x, W[i].z);
    g.strokeStyle = i === a ? c.active : c.legs;
    line2(g, px, py, view.px, view.py);
    px = view.px; py = view.py;
  }
  g.font = font(28); g.textAlign = 'left';
  for (let i = W.length - 1; i >= a; i--) {
    const w = W[i];
    view.project(w.x, w.z);
    const x = view.px, y = view.py;
    if (x < -40 || x > 1040 || y < -40 || y > 1040) continue;
    const to = i === a;
    g.strokeStyle = to ? c.toSym : c.sym; g.lineWidth = 3.5;
    g.beginPath();
    if (symbol === 'diamond') { g.moveTo(x, y - 13); g.lineTo(x + 13, y); g.lineTo(x, y + 13); g.lineTo(x - 13, y); g.closePath(); }
    else { g.moveTo(x, y - 20); g.lineTo(x + 5, y - 5); g.lineTo(x + 20, y); g.lineTo(x + 5, y + 5); g.lineTo(x, y + 20); g.lineTo(x - 5, y + 5); g.lineTo(x - 20, y); g.lineTo(x - 5, y - 5); g.closePath(); }
    g.stroke();
    g.fillStyle = to ? c.toLabel : c.label;
    g.fillText(routeIdent(route, w), x + 22, y + 30);
  }
  return W[a];
}

// ---------------------------------------------------------------- local high-resolution relief (helicopter map)
/**
 * Moving n×n height/water grid centred on the aircraft (half size `half` metres), sampled progressively within a
 * per-frame budget and rendered as a shaded relief image. Double buffered: the previous image stays visible while a
 * re-centred one is being built.
 */
export class LocalRelief {
  constructor(n = 384, palette = 'chart') {
    this.n = n; this.pal = PALETTES[palette] || PALETTES.chart;
    this.h = new Float32Array(n * n); this.w = new Uint8Array(n * n);
    this.canvas = makeCanvas(n, n); this.g = this.canvas.getContext('2d'); this.img = this.g.createImageData(n, n);
    this.front = makeCanvas(n, n); this.fg = this.front.getContext('2d');
    this.cx = 0; this.cz = 0; this.half = 0; this.cursor = -1; this.row = 0; this.shown = null; this.world = null;
  }
  _start(world, x, z, half) { this.world = world; this.cx = x; this.cz = z; this.half = half; this.cursor = 0; this.row = 0; }
  /** Call every update with the aircraft position and the wanted half size (m). */
  update(world, x, z, half, budgetMs = 0.5) {
    if (!world || typeof world.getGroundHeight !== 'function') return;
    const moved = Math.hypot(x - this.cx, z - this.cz) > this.half * 0.35 || Math.abs(half - this.half) > this.half * 0.2;
    if (this.cursor < 0 && (moved || world !== this.world || !this.shown)) this._start(world, x, z, half);
    if (this.cursor < 0) return;
    const n = this.n, N2 = n * n, t0 = performance.now(), d = (2 * this.half) / n, hasW = typeof world.isWater === 'function';
    let k = 0;
    while (this.cursor < N2) {
      const i = this.cursor, row = (i / n) | 0, col = i - row * n;
      const px = this.cx - this.half + (col + 0.5) * d, pz = this.cz - this.half + (row + 0.5) * d;
      let h = 0, wet = 0;
      try { h = +world.getGroundHeight(px, pz); if (!Number.isFinite(h)) h = 0; wet = hasW ? (world.isWater(px, pz) ? 1 : 0) : h <= 0.3 ? 1 : 0; } catch { /* keep 0 */ }
      this.h[i] = h; this.w[i] = wet; this.cursor++;
      if ((++k & 31) === 0 && performance.now() - t0 > budgetMs) return;
    }
    // render in row chunks (once all samples are in), then swap buffers
    const D = this.img.data, H = this.h, W = this.w, P = this.pal, ramp = P.ramp;
    const r1 = Math.min(n, this.row + 64);
    for (let j = this.row; j < r1; j++) for (let i = 0; i < n; i++) {
      const q = j * n + i, p = q * 4;
      let r, gg, b;
      if (W[q]) {
        const shore = (i > 0 && !W[q - 1]) || (i < n - 1 && !W[q + 1]) || (j > 0 && !W[q - n]) || (j < n - 1 && !W[q + n]);
        const c = shore ? P.shore : P.water; r = c[0]; gg = c[1]; b = c[2];
      } else {
        const hh = H[q]; let a = 0;
        while (a < ramp.length - 2 && hh > ramp[a + 1][0]) a++;
        const a0 = ramp[a], a1 = ramp[a + 1], t = clamp((hh - a0[0]) / (a1[0] - a0[0]), 0, 1);
        r = a0[1] + (a1[1] - a0[1]) * t; gg = a0[2] + (a1[2] - a0[2]) * t; b = a0[3] + (a1[3] - a0[3]) * t;
        const sx = (H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)]) / (2 * d);
        const sz = (H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i]) / (2 * d);
        const sh = clamp(1 + (sx + sz) * 1.2, 0.55, 1.45); r *= sh; gg *= sh; b *= sh;
      }
      D[p] = r; D[p + 1] = gg; D[p + 2] = b; D[p + 3] = 255;
    }
    this.g.putImageData(this.img, 0, 0, 0, this.row, n, r1 - this.row);
    touchCanvas(this.canvas);   // content version for the displays' upload skipping
    this.row = r1;
    if (this.row < n) return;
    this.fg.drawImage(this.canvas, 0, 0);
    touchCanvas(this.front);
    this.shown = { x0: this.cx - this.half, z0: this.cz - this.half, size: 2 * this.half };
    this.cursor = -1;
  }
  /** Draw in world coordinates (after view.apply). */
  draw(g) { const s = this.shown; if (s) g.drawImage(this.front, s.x0, s.z0, s.size, s.size); }
}

// ---------------------------------------------------------------- other maps (src/maps/<id>.js activate())
/** Origin shown by the CDU progress page. */
export const navOrigin = { icao: 'KSFO' };
/** Replace the San Francisco tables with another map's (landmarks, steerpoints, synthetic traffic, ILS frequencies). */
export function setNavData({ origin, landmarks, steerpoints, traffic, ils }) {
  if (origin) navOrigin.icao = origin;
  if (landmarks) LANDMARKS.splice(0, LANDMARKS.length, ...landmarks);
  if (steerpoints) STEERPOINTS.splice(0, STEERPOINTS.length, ...steerpoints);
  if (traffic) {
    TRAFFIC.splice(0, TRAFFIC.length, ...traffic);
    trafficOut = TRAFFIC.map((t) => ({ id: t.id, kind: t.kind, x: 0, z: 0, alt: 0, hdg: 0, gs: 0, vs: 0 }));
  }
  if (ils) ILS_FREQ = ils;
}
