// Procedural island heightfield + per-vertex surface data (colors, forest / farmland masks).
// Pure JS (no Three.js) so it can also run in Node for offline checks.
//
// Grid: (N+1)×(N+1) vertices covering the WORLD.size square centered on the origin.
// The rendered mesh triangulates every grid cell along the (ix+1,iz)–(ix,iz+1) diagonal and
// heightAt() interpolates exactly the same triangles, so physics matches the visible surface.

import { WORLD, RUNWAY } from '../config.js';
import { createNoise2D, fbm, ridged, smoothstep, lerp, clamp, smin } from './noise.js';

export const GRID_N = 1024;                 // cells per side (cell ≈ 11.7 m)
const SIZE = WORLD.size;
const HALF = SIZE / 2;
const SEED = 7331;

// ---------------------------------------------------------------------------------------------
// Map layout (world meters, -Z = north). Exported so other modules (and missions) can use it.
// ---------------------------------------------------------------------------------------------
export const LAYOUT = {
  // Main valley that cuts through the northern range, from the plain to a fjord on the north coast.
  valley: [[-150, -1500], [-480, -2550], [220, -3450], [1150, -4250], [2250, -4950], [2950, -5800]],
  lake: { x: 2300, z: -2080, rx: 720, rz: 420, angle: 0.45, level: 0 }, // level computed below
  town: { x: 3450, z: 2830, radius: 320, blend: 300, level: 7, angle: -0.5 },
  // Road from the airport area (east of the apron) to the town.
  road: [[430, 80], [900, 330], [1650, 820], [2350, 1500], [2950, 2250], [3450, 2830]],
  roadWidth: 9,
  lighthouse: { x: 0, z: 0 },               // placed on the coast below
};

const nWarp = createNoise2D(SEED);
const nBase = createNoise2D(SEED + 1);
const nHill = createNoise2D(SEED + 2);
const nMount = createNoise2D(SEED + 3);
const nEnv = createNoise2D(SEED + 4);
const nDetail = createNoise2D(SEED + 5);
const nForest = createNoise2D(SEED + 6);
const nFarm = createNoise2D(SEED + 7);
const nColor = createNoise2D(SEED + 8);

// ---- geometry helpers ----------------------------------------------------------------------
function makePolyline(pts) {
  const segs = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    segs.push({ ax, az, dx, dz, len, l2: len * len, start: acc });
    acc += len;
  }
  return { segs, length: acc, pts };
}

/** Distance from (x,z) to a polyline; also writes the arc-length parameter into out.t. */
function polyDist(poly, x, z, out) {
  let best = Infinity, bestT = 0;
  for (const s of poly.segs) {
    let u = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = s.ax + s.dx * u - x, pz = s.az + s.dz * u - z;
    const d = px * px + pz * pz;
    if (d < best) { best = d; bestT = s.start + u * s.len; }
  }
  if (out) out.t = bestT;
  return Math.sqrt(best);
}

const valleyPoly = makePolyline(LAYOUT.valley);
const roadPoly = makePolyline(LAYOUT.road);

/** Distance to the runway rectangle (0 inside). */
export function runwayRectDist(x, z) {
  const dx = Math.max(0, Math.abs(x - RUNWAY.x) - RUNWAY.width / 2);
  const dz = Math.max(0, Math.abs(z - RUNWAY.z) - RUNWAY.length / 2);
  return Math.hypot(dx, dz);
}

/**
 * 1 where obstacles (trees, buildings) must not stand: approach / departure corridors beyond both
 * runway ends and the airport area on the +X side (apron, hangars, tower). Smooth 0..1.
 */
export function clearZone(x, z) {
  const ax = Math.abs(x - RUNWAY.x);
  const ez = Math.abs(z - RUNWAY.z) - RUNWAY.length / 2;
  let c = 0;
  if (ez > -50 && ez < 1500) {
    const w = 130 + Math.max(0, ez) * 0.15;
    c = Math.max(c, smoothstep(w + 60, w, ax) * smoothstep(1500, 1300, ez));
  }
  const dx = x - RUNWAY.x;
  if (dx > 0) c = Math.max(c, smoothstep(760, 640, dx) * smoothstep(RUNWAY.length / 2 + 420, RUNWAY.length / 2 + 300, Math.abs(z - RUNWAY.z)));
  return c;
}

/** Lake shape metric: < 1 inside the lake, 1 on the shore, grows outward. */
export function lakeMetric(x, z) {
  const L = LAYOUT.lake;
  const c = Math.cos(L.angle), s = Math.sin(L.angle);
  const dx = x - L.x, dz = z - L.z;
  const u = (dx * c - dz * s) / L.rx;
  const v = (dx * s + dz * c) / L.rz;
  const wob = 0.12 * nDetail(x / 380 + 40, z / 380 - 12) + 0.05 * nDetail(x / 130, z / 130);
  return Math.hypot(u, v) * (1 + wob);
}

/** Town-local coordinates (rotated so streets align with the grid). */
export function townLocal(x, z) {
  const T = LAYOUT.town;
  const c = Math.cos(T.angle), s = Math.sin(T.angle);
  const dx = x - T.x, dz = z - T.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

// ---- natural terrain -----------------------------------------------------------------------
/** Island factor e: > 0 on land (roughly 1 at the center), 0 at the coastline, < 0 at sea. */
function islandE(x, z) {
  const wx = x + 800 * fbm(nWarp, x / 2900 + 5.3, z / 2900 + 1.7, 4);
  const wz = z + 800 * fbm(nWarp, x / 2900 - 3.1, z / 2900 + 8.2, 4);
  let d = Math.hypot(wx / 5250, (wz + 330) / 5200);
  // Bay to the south-east of the town (harbor).
  const bx = (x - 4150) / 1150, bz = (z - 3650) / 1000;
  d += 0.12 * Math.exp(-(bx * bx + bz * bz));
  // Small cove on the west coast.
  const cx = (x + 4700) / 700, cz = (z - 1900) / 600;
  d += 0.07 * Math.exp(-(cx * cx + cz * cz));
  // Guarantee deep water along the edge of the world square.
  d += 0.25 * smoothstep(5250, 5950, Math.max(Math.abs(x), Math.abs(z)));
  return 1 - d;
}

const valleyOut = { t: 0 };
const MOUNT_AMP = 1000;
const FLAT_BLEND = 850;            // plain → natural terrain blend width (m)

function inlandHeight(x, z) {
  const dR = runwayRectDist(x, z);
  // Gentle base everywhere, rising a bit away from the airport plain.
  const baseAmp = 16 + 46 * smoothstep(1500, 4200, dR);
  let h = 30 + baseAmp * fbm(nBase, x / 1700, z / 1700, 5)
    + 4 * nDetail(x / 210, z / 210);

  // Rolling hills to the west.
  const hillMask = smoothstep(-1200, -3000, x) * (1 - 0.35 * smoothstep(1500, 3500, z));
  if (hillMask > 0) {
    const n = 0.5 + 0.5 * fbm(nHill, x / 1700 + 7, z / 1700 - 3, 4);
    h += hillMask * 380 * Math.pow(n, 1.8);
  }
  // A few low hills east of the plain / north of the town.
  const eastMask = smoothstep(1800, 3000, x) * smoothstep(1800, 0, z) * smoothstep(-2600, -900, z);
  if (eastMask > 0) {
    const n = 0.5 + 0.5 * fbm(nHill, x / 900 - 30, z / 900 + 12, 4);
    h += eastMask * 170 * n * n;
  }

  // Northern range.
  const mMask = smoothstep(-1500, -3100, z) * (1 - smoothstep(4000, 5400, x)) * (1 - smoothstep(-4400, -5700, x));
  if (mMask > 0) {
    const env = 0.7 + 0.3 * fbm(nEnv, x / 3000 + 40, z / 3000, 3);
    const r = ridged(nMount, x / 2700 + 3.3, z / 2700 - 8.1, 6);
    h += mMask * (90 + MOUNT_AMP * env * Math.pow(r, 1.35));
  }

  // Carve the main valley (smooth U shape, floor rising then falling to the fjord).
  const dv = polyDist(valleyPoly, x, z, valleyOut);
  if (dv < 1200) {
    const t = valleyOut.t / valleyPoly.length;
    const floor = 24 + 120 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.9);
    const e = Math.max(0, dv - 140);
    const prof = floor + 0.0021 * e * e + 6 * nDetail(x / 160, z / 160);
    h = smin(h, prof, 45);
  }
  return h;
}

function naturalHeight(x, z) {
  const e = islandE(x, z);
  if (e <= 0) {
    // Sea floor: shallow sandy shelf then deeper water.
    return -72 * (1 - Math.exp(e * 7)) + 2 * nDetail(x / 300, z / 300) * smoothstep(0, -0.02, e);
  }
  const inland = inlandHeight(x, z);
  const ramp = smoothstep(0.0, 0.15, e);
  const coastal = e * 230;
  return lerp(coastal, inland, ramp);
}

// ---- features on top of the natural terrain ------------------------------------------------
function lakeBlend(x, z, h) {
  const m = lakeMetric(x, z);
  if (m > 2) return h;
  const level = LAYOUT.lake.level;
  const prof = m <= 1 ? level + (m - 1) * 13 : level + (m - 1) * 16;
  return lerp(prof, h, smoothstep(1.05, 1.95, m));
}

function flattenRunway(x, z, h) {
  const d = runwayRectDist(x, z);
  if (d <= RUNWAY.flatRadius) return RUNWAY.elevation;
  return lerp(RUNWAY.elevation, h, smoothstep(RUNWAY.flatRadius, RUNWAY.flatRadius + FLAT_BLEND, d));
}

function flattenTown(x, z, h) {
  const T = LAYOUT.town;
  const d = Math.hypot(x - T.x, z - T.z);
  if (d > T.radius + T.blend) return h;
  return lerp(T.level, h, smoothstep(T.radius, T.radius + T.blend, d));
}

function preRoadHeight(x, z) {
  let h = naturalHeight(x, z);
  h = lakeBlend(x, z, h);
  h = flattenRunway(x, z, h);
  h = flattenTown(x, z, h);
  return h;
}

// Road profile: smoothed pre-road terrain along the road centerline.
let roadProfile = null;
const ROAD_STEP = 10;
function buildRoadProfile() {
  const n = Math.ceil(roadPoly.length / ROAD_STEP) + 1;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [x, z] = pointOnPoly(roadPoly, Math.min(roadPoly.length, i * ROAD_STEP));
    raw[i] = Math.max(1.5, preRoadHeight(x, z));
  }
  const out = new Float32Array(n);
  const W = 14; // ±140 m moving average
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -W; k <= W; k++) {
      const j = clamp(i + k, 0, n - 1);
      s += raw[j]; c++;
    }
    out[i] = s / c;
  }
  // Pin the ends to the flat plain / town level.
  out[0] = RUNWAY.elevation;
  roadProfile = out;
}

export function pointOnPoly(poly, t) {
  for (const s of poly.segs) {
    if (t <= s.start + s.len) {
      const u = (t - s.start) / s.len;
      return [s.ax + s.dx * u, s.az + s.dz * u];
    }
  }
  const p = poly.pts[poly.pts.length - 1];
  return [p[0], p[1]];
}

const roadOut = { t: 0 };
function roadHeightAt(t) {
  const f = t / ROAD_STEP;
  const i = Math.min(roadProfile.length - 2, Math.floor(f));
  return lerp(roadProfile[i], roadProfile[i + 1], f - i);
}

export function roadDistance(x, z) {
  return polyDist(roadPoly, x, z, roadOut);
}

function finalHeight(x, z) {
  let h = preRoadHeight(x, z);
  const d = polyDist(roadPoly, x, z, roadOut);
  if (d < 60) {
    const rh = roadHeightAt(roadOut.t);
    h = lerp(rh, h, smoothstep(LAYOUT.roadWidth * 0.5 + 3, 55, d));
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// Colors (sRGB 0..1, converted to linear when written)
// ---------------------------------------------------------------------------------------------
const C = {
  sand: [0.85, 0.79, 0.62],
  wetSand: [0.66, 0.6, 0.46],
  seabed: [0.55, 0.52, 0.4],
  deepBed: [0.25, 0.3, 0.28],
  grassA: [0.4, 0.56, 0.24],
  grassB: [0.55, 0.6, 0.3],
  forest: [0.2, 0.32, 0.14],
  alpine: [0.46, 0.48, 0.3],
  rock: [0.48, 0.45, 0.41],
  earth: [0.47, 0.42, 0.3],
  rockDark: [0.33, 0.31, 0.29],
  snow: [0.93, 0.95, 0.98],
  lakeShore: [0.55, 0.52, 0.42],
};
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------
export function generateTerrain() {
  const N = GRID_N, V = N + 1;
  const cell = SIZE / N;
  const heights = new Float32Array(V * V);

  // Lake level: slightly below the lowest natural ground on the ring around the lake.
  {
    const L = LAYOUT.lake;
    let minH = Infinity;
    for (let a = 0; a < 64; a++) {
      for (let r = 1.05; r <= 2.0; r += 0.1) {
        const ang = (a / 64) * Math.PI * 2;
        const c = Math.cos(L.angle), s = Math.sin(L.angle);
        const u = Math.cos(ang) * L.rx * r, v = Math.sin(ang) * L.rz * r;
        const x = L.x + u * c + v * s, z = L.z - u * s + v * c;
        let h = naturalHeight(x, z);
        h = flattenRunway(x, z, h);
        minH = Math.min(minH, h);
      }
    }
    L.level = Math.round((minH - 1.5) * 10) / 10;
  }
  buildRoadProfile();

  for (let iz = 0; iz < V; iz++) {
    const z = -HALF + iz * cell;
    for (let ix = 0; ix < V; ix++) {
      const x = -HALF + ix * cell;
      heights[iz * V + ix] = finalHeight(x, z);
    }
  }

  // Normals from central differences on the grid (seamless across chunks).
  const normals = new Float32Array(V * V * 3);
  for (let iz = 0; iz < V; iz++) {
    const zm = iz > 0 ? iz - 1 : iz, zp = iz < N ? iz + 1 : iz;
    for (let ix = 0; ix < V; ix++) {
      const xm = ix > 0 ? ix - 1 : ix, xp = ix < N ? ix + 1 : ix;
      const dhx = (heights[iz * V + xp] - heights[iz * V + xm]) / ((xp - xm) * cell);
      const dhz = (heights[zp * V + ix] - heights[zm * V + ix]) / ((zp - zm) * cell);
      const inv = 1 / Math.hypot(dhx, 1, dhz);
      const k = (iz * V + ix) * 3;
      normals[k] = -dhx * inv;
      normals[k + 1] = inv;
      normals[k + 2] = -dhz * inv;
    }
  }

  // Masks + colors.
  const forest = new Uint8Array(V * V);   // forest density (trees + darker floor)
  const farm = new Uint8Array(V * V);     // farmland on/off (sampled at field centers in the shader)
  const surf = new Uint8Array(V * V * 4); // per-vertex: farm suitability, forest, rock, sand
  const colors = new Uint8Array(V * V * 3);
  const T = LAYOUT.town;
  const lakeLevel = LAYOUT.lake.level;
  const col = [0, 0, 0];
  const mix = (a, t) => { col[0] += (a[0] - col[0]) * t; col[1] += (a[1] - col[1]) * t; col[2] += (a[2] - col[2]) * t; };

  for (let iz = 0; iz < V; iz++) {
    const z = -HALF + iz * cell;
    for (let ix = 0; ix < V; ix++) {
      const x = -HALF + ix * cell;
      const i = iz * V + ix;
      const h = heights[i];
      const ny = normals[i * 3 + 1];
      const dR = runwayRectDist(x, z);
      const dTown = Math.hypot(x - T.x, z - T.z);
      const dRoad = polyDist(roadPoly, x, z, null);
      const lm = lakeMetric(x, z);
      const cn = nColor(x / 700, z / 700) * 0.6 + nColor(x / 90, z / 90) * 0.4;
      const clear = clearZone(x, z); // 1 = must stay free of trees (runway corridors, airport side)

      // --- forest density ---
      let f = fbm(nForest, x / 800 + 50, z / 800 - 20, 4) - 0.08;
      f += 0.22 * smoothstep(-1500, -3200, x);                // western hills are wooded
      f += 0.1 * smoothstep(-1600, -2600, z);                 // mountain slopes
      f -= 0.3 * (1 - smoothstep(RUNWAY.flatRadius * 0.6, RUNWAY.flatRadius + 700, dR));
      let fd = smoothstep(0.1, 0.3, f);
      fd *= smoothstep(4, 9, h) * (1 - smoothstep(560, 700, h + cn * 40));
      fd *= smoothstep(0.72, 0.84, ny);
      fd *= smoothstep(T.radius + 60, T.radius + 250, dTown);
      fd *= smoothstep(14, 30, dRoad);
      fd *= smoothstep(1.15, 1.35, lm);
      fd *= smoothstep(360, 520, dR);
      fd *= 1 - clear;

      // --- farmland: suitability (per vertex) and on/off patches (texture) ---
      let ok = smoothstep(0.93, 0.965, ny) * smoothstep(3, 8, h) * (1 - smoothstep(70, 120, h));
      ok *= smoothstep(150, 220, dR);                         // mown grass strip around the runway
      if (x > 0 && x < 650 && Math.abs(z) < 850) ok = 0;      // airport side (+X) stays plain grass
      ok *= smoothstep(T.radius + 10, T.radius + 60, dTown);
      ok *= smoothstep(1.1, 1.3, lm);
      let fm = ok * smoothstep(0.02, 0.12, fbm(nFarm, x / 900 + 3, z / 900 - 9, 3) + 0.12 * (1 - smoothstep(1200, 3200, dR)) - 0.1);
      fm *= smoothstep(T.radius + 60, T.radius + 140, dTown);
      fm *= smoothstep(12, 22, dRoad);
      fm *= 1 - smoothstep(0.2, 0.45, fd);
      fd *= 1 - smoothstep(0.3, 0.6, fm);

      forest[i] = Math.round(fd * 255);
      farm[i] = Math.round(fm * 255);

      const steep = smoothstep(0.83, 0.66, ny);
      const rockW = clamp(Math.max(steep * smoothstep(60, 220, h), smoothstep(640, 820, h) * 0.8), 0, 1);
      const earthW = steep * (1 - smoothstep(60, 220, h));
      const sandW = lm < 1.6 ? smoothstep(lakeLevel + 2.0, lakeLevel + 0.3, h) : smoothstep(4.5 + cn * 1.5, 1.8, h) * smoothstep(0.7, 0.85, ny);
      surf[i * 4] = Math.round(ok * 255);
      surf[i * 4 + 1] = Math.round(fd * 255);
      surf[i * 4 + 2] = Math.round(rockW * 255);
      surf[i * 4 + 3] = Math.round(clamp(sandW, 0, 1) * 255);

      // --- color ---
      col[0] = C.grassA[0]; col[1] = C.grassA[1]; col[2] = C.grassA[2];
      mix(C.grassB, clamp(0.5 + cn * 0.9, 0, 1) * 0.8);
      mix(C.forest, fd * 0.75);
      mix(C.alpine, smoothstep(380, 620, h + cn * 50) * 0.85);
      // rock on steep slopes and high ground
      mix(C.earth, earthW * 0.7);
      const rk = smoothstep(-0.35, 0.35, cn);
      mix([lerp(C.rockDark[0], C.rock[0], rk), lerp(C.rockDark[1], C.rock[1], rk), lerp(C.rockDark[2], C.rock[2], rk)], rockW);
      // snow on high, not-too-steep ground
      const snowW = smoothstep(660 + cn * 70, 760 + cn * 40, h) * smoothstep(0.38, 0.62, ny);
      mix(C.snow, snowW);
      // beaches (ocean) and shore (lake)
      const inLakeZone = lm < 1.6;
      if (!inLakeZone) {
        mix(C.sand, sandW);
        if (h < 0.4) mix(C.wetSand, smoothstep(0.4, -0.3, h));
        if (h < -0.3) mix(C.seabed, smoothstep(-0.3, -3, h));
        if (h < -3) mix(C.deepBed, smoothstep(-3, -25, h));
      } else {
        mix(C.lakeShore, smoothstep(lakeLevel + 2.0, lakeLevel + 0.3, h));
        if (h < lakeLevel - 0.5) mix(C.deepBed, smoothstep(lakeLevel - 0.5, lakeLevel - 8, h));
      }
      // runway surroundings: slightly more even, mown grass
      mix([0.43, 0.58, 0.26], (1 - smoothstep(60, 220, dR)) * 0.6);

      colors[i * 3] = Math.round(srgbToLinear(col[0]) * 255);
      colors[i * 3 + 1] = Math.round(srgbToLinear(col[1]) * 255);
      colors[i * 3 + 2] = Math.round(srgbToLinear(col[2]) * 255);
    }
  }

  // Lighthouse: highest land point near the south-east headland, close to the water.
  {
    let best = null;
    for (let a = 0; a < 400; a++) {
      const x = 3900 + (a % 20) * 60, z = 1500 + Math.floor(a / 20) * 80;
      const h = sampleGrid(heights, x, z);
      const e = islandE(x, z);
      if (h > 6 && e > 0 && e < 0.03 && Math.hypot(x - T.x, z - T.z) > 800) {
        if (!best || h > best.h) best = { x, z, h };
      }
    }
    if (best) { LAYOUT.lighthouse.x = best.x; LAYOUT.lighthouse.z = best.z; }
  }

  // Mission helpers: highest peaks (≥ 900 m apart) and the valley floor profile every 250 m.
  {
    const peaks = [];
    const S = 8; // sample every 8 cells (~94 m)
    const cands = [];
    for (let iz = S; iz < V - S; iz += S) {
      for (let ix = S; ix < V - S; ix += S) {
        const h = heights[iz * V + ix];
        if (h > 300) cands.push([h, -HALF + ix * cell, -HALF + iz * cell]);
      }
    }
    cands.sort((a, b) => b[0] - a[0]);
    for (const [h, x, z] of cands) {
      if (peaks.every((p) => Math.hypot(p.x - x, p.z - z) > 900)) peaks.push({ x: Math.round(x), z: Math.round(z), h: Math.round(h) });
      if (peaks.length >= 8) break;
    }
    LAYOUT.peaks = peaks;
    const prof = [];
    for (let t = 0; t <= valleyPoly.length; t += 250) {
      const [x, z] = pointOnPoly(valleyPoly, t);
      prof.push({ x: Math.round(x), z: Math.round(z), ground: Math.round(sampleGrid(heights, x, z)) });
    }
    LAYOUT.valleyProfile = prof;
  }

  return {
    N, V, cell, size: SIZE, half: HALF,
    heights, normals, colors, forest, farm, surf,
    lakeLevel: LAYOUT.lake.level,
    layout: LAYOUT,
    roadPoly,
    valleyPoly,
  };
}

/** Exact mesh-matching interpolation of a height grid (same triangle split as the mesh). */
export function sampleGrid(heights, x, z) {
  const N = GRID_N, V = N + 1;
  const gx = (x + HALF) * (N / SIZE);
  const gz = (z + HALF) * (N / SIZE);
  if (!(gx >= 0 && gz >= 0 && gx < N && gz < N)) return -80;
  const ix = gx | 0, iz = gz | 0;
  const fx = gx - ix, fz = gz - iz;
  const i = iz * V + ix;
  const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + V], h11 = heights[i + V + 1];
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}
