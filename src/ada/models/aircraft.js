// Player aircraft: a Cessna-172-like high-wing single, built procedurally.
// Local axes: nose -> -Z, up +Y, right wing +X. Origin = centre of gravity. Real metres.
//
//   createAircraft()          animated player aircraft (control surfaces, prop, lights, cockpit)
//   createAircraftMesh(opts)  static copy with a custom livery (parked aircraft)
import * as THREE from 'three';
import {
  DEG, V3, monotone, lerp, clamp, smoothstep, gridGeometry, fanCap, airfoilLoft, tube, strut,
  clean, mergeClean, mirrorX, Builder, mat4, makeCanvas, canvasTexture, glowTexture, naca,
} from './geom.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const LIVERY_DEFAULT = {
  base: '#f4f5f2',
  stripe1: '#1f3f8f',
  stripe2: '#f2801a',
  registration: 'TC-GKY',
  regColor: '#15244c',
  spinner: '#1f3f8f',
  wingtip: '#1f3f8f',
  flag: true,
  name: 'Gökyüzü',
  textureSize: 2048,
};

// Side-projection livery canvas: u <- z, v <- y. Top half of the canvas = left side, bottom half = right side.
const TZ0 = -2.7, TZ1 = 5.9;
const TY1 = 1.60, TY0 = TY1 - 560 / (2048 / (TZ1 - TZ0));
const uvSide = (v, side) => [(v.z - TZ0) / (TZ1 - TZ0), (side > 0 ? 0 : 0.5) + 0.5 * (v.y - TY0) / (TY1 - TY0)];
const uvInterior = (v) => [(v.z - TZ0) / (TZ1 - TZ0), (v.y - TY0) / (TY1 - TY0)];

// Plain-colour parts (wings, gear, tyres, ...) share the livery material: their UVs point at small
// reserved patches of the livery canvas (white colour; roughness in G, metalness in B of the rough map),
// and their colour comes from vertex colours. So a whole static aircraft is a single draw call.
const PATCH = {
  paint: { z0: 5.76, z1: 5.9, y0: 1.46, y1: 1.58, rough: 'rgb(0,97,0)' },
  dark: { z0: 5.76, z1: 5.9, y0: 1.32, y1: 1.44, rough: 'rgb(0,217,0)' },
  metal: { z0: 5.76, z1: 5.9, y0: 1.18, y1: 1.30, rough: 'rgb(0,90,140)' },
};
const patchUV = (key) => { const P = PATCH[key]; return uvSide(V3(0, (P.y0 + P.y1) / 2, (P.z0 + P.z1) / 2), -1); };
function setUV(geo, [u, v]) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  uv.needsUpdate = true;
  return geo;
}

// Fuselage cross-section keys: z, top, bottom, half-width, superellipse exponent, tumblehome
const FUS_KEYS = [
  [-2.20, 0.215, -0.135, 0.175, 2.0, 0.00],
  [-2.16, 0.290, -0.250, 0.320, 2.3, 0.00],
  [-2.08, 0.345, -0.345, 0.430, 2.6, 0.03],
  [-1.90, 0.378, -0.418, 0.495, 2.9, 0.06],
  [-1.55, 0.405, -0.465, 0.530, 3.2, 0.08],
  [-1.02, 0.430, -0.520, 0.555, 3.5, 0.10],
  [-0.75, 0.620, -0.555, 0.565, 3.7, 0.12],
  [-0.45, 0.800, -0.580, 0.570, 3.9, 0.13],
  [-0.30, 0.845, -0.590, 0.570, 4.0, 0.13],
  [0.00, 0.838, -0.590, 0.570, 4.0, 0.13],
  [0.60, 0.838, -0.580, 0.565, 4.0, 0.13],
  [1.20, 0.842, -0.540, 0.540, 3.8, 0.13],
  [1.35, 0.790, -0.515, 0.525, 3.6, 0.11],
  [1.75, 0.680, -0.430, 0.465, 3.3, 0.09],
  [2.25, 0.600, -0.320, 0.385, 3.0, 0.07],
  [3.00, 0.540, -0.170, 0.280, 2.7, 0.05],
  [3.80, 0.500, -0.040, 0.190, 2.5, 0.03],
  [4.50, 0.470, 0.070, 0.110, 2.3, 0.00],
  [5.06, 0.450, 0.150, 0.040, 2.1, 0.00],
];
const FUS = (() => {
  const zs = FUS_KEYS.map((k) => k[0]);
  const f = [1, 2, 3, 4, 5].map((i) => monotone(zs, FUS_KEYS.map((k) => k[i])));
  return (z) => ({ top: f[0](z), bot: f[1](z), hw: f[2](z), n: f[3](z), tb: f[4](z) });
})();
const FUS_Z0 = -2.20, FUS_Z1 = 5.06;

// Wing (right half, wing-local frame: x = span, y relative to root chord line, z absolute)
const WING = {
  rootY: 0.86, teZ: 1.27, rootChord: 1.63, tipChord: 1.12, taperStart: 2.55, taperEnd: 5.40,
  dihedral: 1.73 * DEG, t: 0.12, m: 0.02,
  flap: [0.60, 2.60], flapHinge: 0.84,
  aileron: [3.04, 5.08], aileronHinge: 0.925,
};
const wingChord = (s) => s <= WING.taperStart ? WING.rootChord
  : lerp(WING.rootChord, WING.tipChord, clamp((s - WING.taperStart) / (WING.taperEnd - WING.taperStart), 0, 1));
const WING_M = new THREE.Matrix4().makeTranslation(0, WING.rootY, 0).multiply(new THREE.Matrix4().makeRotationZ(WING.dihedral));
const WING_Q = new THREE.Quaternion().setFromAxisAngle(V3(0, 0, 1), WING.dihedral);

// Tail
const STAB = { y: 0.24, hinge: 5.00, t: 0.09, elevIn: 0.34, elevOut: 1.70 };
const FIN = {
  le: monotone([0.12, 0.38, 0.55, 1.40, 1.46], [3.85, 3.97, 4.05, 4.72, 4.86]),
  te: monotone([0.12, 0.38, 0.55, 1.40, 1.46], [5.66, 5.73, 5.73, 5.60, 5.48]),
  hinge: (y) => 5.06 + (y - 0.12) * (0.14 / 1.34),
  t: (y) => (y > 1.42 ? 0.035 : lerp(0.068, 0.058, clamp((y - 0.38) / 1.0, 0, 1))),
};
const RUDDER_AXIS_A = V3(0, 0.12, FIN.hinge(0.12));
const RUDDER_AXIS_B = V3(0, 1.46, FIN.hinge(1.46));

// Gear
const GEAR = {
  mainX: 1.27, mainZ: 0.45, mainAxleY: -1.045, mainR: 0.128, mainTube: 0.066,
  noseZ: -1.19, noseR: 0.118, noseTube: 0.058,
};
GEAR.noseAxleY = GEAR.mainAxleY - (GEAR.mainR + GEAR.mainTube) + (GEAR.noseR + GEAR.noseTube);

const PROP = { pos: V3(0, 0.04, -2.29), radius: 0.955 };
const COCKPIT_EYE = V3(-0.27, 0.585, 0.08);
const PANEL_Z = -0.62;

// ---------------------------------------------------------------------------
// Fuselage
// ---------------------------------------------------------------------------

function denseHalfRing(p, inset = 0) {
  const top = p.top - inset, bot = p.bot + inset, hw = Math.max(0.004, p.hw - inset);
  const ym = (top + bot) / 2, hh = (top - bot) / 2, e = 2 / p.n;
  const S = 160, pts = [];
  for (let i = 0; i <= S; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / S;
    const c = Math.cos(t), s = Math.sin(t);
    const yy = Math.sign(s) * Math.pow(Math.abs(s), e);
    let x = i === 0 || i === S ? 0 : hw * Math.pow(Math.abs(c), e);
    if (yy > 0) x *= 1 - p.tb * yy * yy;
    pts.push([x, ym + hh * yy]);
  }
  return pts;
}

// Half ring (bottom centre -> top centre, x >= 0), resampled by arc length + curvature.
function halfRing(p, count, inset = 0) {
  const pts = denseHalfRing(p, inset);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    let w = Math.hypot(dx, dy);
    if (i > 1) {
      const ax = pts[i - 1][0] - pts[i - 2][0], ay = pts[i - 1][1] - pts[i - 2][1];
      const ang = Math.abs(Math.atan2(ax * dy - ay * dx, ax * dx + ay * dy));
      w += ang * 0.07;
    }
    acc.push(acc[i - 1] + w);
  }
  const total = acc[acc.length - 1];
  const out = [];
  let k = 1;
  for (let j = 0; j <= count; j++) {
    const target = (total * j) / count;
    while (k < acc.length - 1 && acc[k] < target) k++;
    const t = (target - acc[k - 1]) / Math.max(1e-9, acc[k] - acc[k - 1]);
    out.push([lerp(pts[k - 1][0], pts[k][0], clamp(t, 0, 1)), lerp(pts[k - 1][1], pts[k][1], clamp(t, 0, 1))]);
  }
  out[0][0] = 0; out[count][0] = 0;
  return out;
}

// Half-width of the fuselage section at (z, y), optionally inset.
export function fuselageHalfWidth(z, y, inset = 0) {
  const pts = denseHalfRing(FUS(z), inset);
  if (y <= pts[0][1] || y >= pts[pts.length - 1][1]) return 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] >= y) {
      const t = (y - pts[i - 1][1]) / Math.max(1e-9, pts[i][1] - pts[i - 1][1]);
      return lerp(pts[i - 1][0], pts[i][0], t);
    }
  }
  return 0;
}

function stationList(z0, z1, step, extra = []) {
  const set = new Set();
  const n = Math.ceil((z1 - z0) / step);
  for (let i = 0; i <= n; i++) set.add(+(z0 + ((z1 - z0) * i) / n).toFixed(4));
  for (const k of FUS_KEYS) if (k[0] > z0 && k[0] < z1) set.add(k[0]);
  for (const e of extra) if (e > z0 && e < z1) set.add(e);
  const arr = [...set].sort((a, b) => a - b);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) if (arr[i] - out[out.length - 1] > 0.025 || i === arr.length - 1) out.push(arr[i]);
  return out;
}

function fixSeamNormals(g, rows, cols) {
  const n = g.attributes.normal;
  for (let i = 0; i < rows; i++) {
    for (const j of [0, cols - 1]) {
      const vi = i * cols + j;
      const v = V3(0, n.getY(vi), n.getZ(vi)).normalize();
      n.setXYZ(vi, v.x, v.y, v.z);
    }
  }
}

// Exterior fuselage: two halves (for the mirrored livery UVs), UV'd with the side projection.
function fuselageGeometries() {
  const zs = stationList(FUS_Z0, FUS_Z1, 0.09, [-2.18, -2.12, -2.04, -1.98]);
  const COUNT = 28;
  const rowsR = zs.map((z) => halfRing(FUS(z), COUNT).map(([x, y]) => V3(x, y, z)));
  const rowsL = rowsR.map((r) => r.map((v) => V3(-v.x, v.y, v.z)));
  const gR = gridGeometry(rowsR, { flip: false, uvFn: (v) => uvSide(v, 1) });
  const gL = gridGeometry(rowsL, { flip: true, uvFn: (v) => uvSide(v, -1) });
  fixSeamNormals(gR, zs.length, COUNT + 1);
  fixSeamNormals(gL, zs.length, COUNT + 1);
  const ringFull = (rows, i) => rows[i].concat(rowsL[i].slice(1, -1).reverse());
  const noseCap = fanCap(ringFull(rowsR, 0), V3(0, 0, -1));
  const tailCap = fanCap(ringFull(rowsR, zs.length - 1), V3(0, 0, 1), (v) => uvSide(v, 1));
  return { body: [gR, gL, tailCap], noseCap };
}

// Dorsal fillet in front of the fin
function dorsalGeometries() {
  const topLine = monotone([2.30, 3.00, 3.60, 4.00, 4.22, 4.40], [FUS(2.30).top + 0.005, FUS(3.0).top + 0.035, 0.585, 0.66, 0.76, 0.92]);
  const zs = [];
  for (let i = 0; i <= 18; i++) zs.push(2.30 + (4.40 - 2.30) * (i / 18));
  const prof = [[1, 0], [0.9, 0.3], [0.62, 0.6], [0.32, 0.85], [0, 1]]; // (width frac, height frac)
  const W0 = 0.05;
  const rowsR = zs.map((z) => {
    const yb = FUS(z).top - 0.05, yt = Math.max(topLine(z), yb + 0.051);
    return prof.map(([w, h]) => V3(W0 * w, lerp(yb, yt, h), z));
  });
  const rowsL = rowsR.map((r) => r.map((v) => V3(-v.x, v.y, v.z)));
  const gR = gridGeometry(rowsR, { flip: false, uvFn: (v) => uvSide(v, 1) });
  const gL = gridGeometry(rowsL, { flip: true, uvFn: (v) => uvSide(v, -1) });
  fixSeamNormals(gR, zs.length, prof.length);
  fixSeamNormals(gL, zs.length, prof.length);
  return [gR, gL];
}

// ---------------------------------------------------------------------------
// Flying surfaces
// ---------------------------------------------------------------------------

function wingSection(s, extra = {}) {
  const c = extra.c ?? wingChord(s);
  const zLE = extra.zLE ?? WING.teZ - c;
  return { o: V3(s, extra.y ?? 0, zLE), cdir: V3(0, 0, 1), up: V3(0, 1, 0), c, t: extra.t ?? WING.t, m: WING.m, p: 0.4, x0: extra.x0 ?? 0, x1: extra.x1 ?? 1 };
}
const noseRadius = (sec, x0) => naca(x0, sec.t, sec.m, sec.p).yt * sec.c;

// Returns wing-local (right) geometry lists: { main: [], tip: [], flap: geo, aileron: geo, flapHinge, aileronHinge }
function wingGeometries() {
  const GAP = 0.012;
  const trunc = (hingeZ) => (s) => {
    const sec = wingSection(s);
    const x0 = (hingeZ - sec.o.z) / sec.c;
    const r = noseRadius(sec, x0);
    return wingSection(s, { x1: (hingeZ - r - GAP - sec.o.z) / sec.c });
  };
  const surf = (hingeZ) => (s) => {
    const sec = wingSection(s);
    return wingSection(s, { x0: (hingeZ - sec.o.z) / sec.c });
  };
  const main = [];
  const N = 14;
  main.push(...airfoilLoft([wingSection(0), wingSection(WING.flap[0] - 0.02)], { N, caps: [false, true] }));
  main.push(...airfoilLoft([WING.flap[0] - 0.02, WING.taperStart, WING.flap[1] + 0.02].map(trunc(WING.flapHinge)), { N }));
  main.push(...airfoilLoft([wingSection(WING.flap[1] + 0.02), wingSection(WING.aileron[0] - 0.02)], { N }));
  main.push(...airfoilLoft([WING.aileron[0] - 0.02, WING.aileron[1] + 0.02].map(trunc(WING.aileronHinge)), { N }));
  main.push(...airfoilLoft([wingSection(WING.aileron[1] + 0.02), wingSection(WING.taperEnd)], { N, caps: [true, false] }));
  // rounded tip (accent colour)
  const tc = WING.tipChord;
  const tip = airfoilLoft([
    wingSection(WING.taperEnd),
    wingSection(5.46, { c: tc * 0.97, zLE: WING.teZ - tc * 0.97 + 0.0, t: 0.1 }),
    wingSection(5.505, { c: tc * 0.88, zLE: WING.teZ - tc * 0.9 + 0.04, t: 0.065, y: 0.004 }),
    wingSection(5.53, { c: tc * 0.7, zLE: WING.teZ - tc * 0.75 + 0.1, t: 0.03, y: 0.008 }),
  ], { N, caps: [false, true] });

  const flapSecs = [WING.flap[0], WING.flap[1]].map(surf(WING.flapHinge));
  const ailSecs = [WING.aileron[0], WING.aileron[1]].map(surf(WING.aileronHinge));
  const flap = mergeClean(airfoilLoft(flapSecs, { N: 6 }));
  const aileron = mergeClean(airfoilLoft(ailSecs, { N: 6 }));
  const hy = (secs) => { const s = secs[0]; return naca(s.x0, s.t, s.m, s.p).yc * s.c; };
  return {
    main, tip, flap, aileron,
    flapHinge: V3(WING.flap[0], hy(flapSecs), WING.flapHinge),
    aileronHinge: V3(WING.aileron[0], hy(ailSecs), WING.aileronHinge),
  };
}

function stabGeometries() {
  const chordAt = (x) => {
    const le = monotone([0, 0.34, 1.60, 1.72], [4.28, 4.33, 4.56, 4.66])(x);
    const te = monotone([0, 0.34, 1.60, 1.72], [5.52, 5.52, 5.43, 5.36])(x);
    return { le, c: te - le };
  };
  const sec = (x, extra = {}) => {
    const { le, c } = chordAt(x);
    const s = { o: V3(x, STAB.y, le), cdir: V3(0, 0, 1), up: V3(0, 1, 0), c, t: extra.t ?? STAB.t, m: 0, p: 0.3, x0: 0, x1: 1 };
    return Object.assign(s, extra);
  };
  const trunc = (x, extra) => {
    const s = sec(x, extra);
    const x0 = (STAB.hinge - s.o.z) / s.c;
    s.x1 = (STAB.hinge - noseRadius(s, x0) - 0.012 - s.o.z) / s.c;
    return s;
  };
  const surf = (x) => { const s = sec(x); s.x0 = (STAB.hinge - s.o.z) / s.c; return s; };
  const fixed = airfoilLoft([trunc(0), trunc(STAB.elevIn - 0.015), trunc(1.60), trunc(1.715, { t: 0.06 })], { N: 10, caps: [false, true] });
  const elevR = mergeClean(airfoilLoft([surf(STAB.elevIn), surf(1.60), (() => { const s = surf(1.70); s.t = 0.065; return s; })()], { N: 6 }));
  return { fixed, elevR };
}

function finSection(y, extra = {}) {
  const le = FIN.le(y), te = FIN.te(y);
  return Object.assign({ o: V3(0, y, le), cdir: V3(0, 0, 1), up: V3(1, 0, 0), c: te - le, t: FIN.t(y), m: 0, p: 0.3, x0: 0, x1: 1 }, extra);
}
function finGeometries() {
  const uv = (v, side) => uvSide(v, side);
  const trunc = (y) => {
    const s = finSection(y);
    const x0 = (FIN.hinge(y) - s.o.z) / s.c;
    s.x1 = (FIN.hinge(y) - noseRadius(s, x0) - 0.012 - s.o.z) / s.c;
    return s;
  };
  const fin = airfoilLoft([trunc(0.38), trunc(0.55), trunc(1.40), trunc(1.46)], { N: 10, split: true, uvFn: uv, caps: [false, true] });
  const surf = (y) => { const s = finSection(y); s.x0 = (FIN.hinge(y) - s.o.z) / s.c; return s; };
  const rudder = airfoilLoft([surf(0.12), surf(0.38), surf(0.55), surf(1.40), surf(1.46)], { N: 6, split: true, uvFn: uv });
  return { fin, rudder };
}

// ---------------------------------------------------------------------------
// Propeller
// ---------------------------------------------------------------------------

function bladeGeometry(colors) {
  // blade along +Y, rotation plane XY, flight direction -Z. LE leads toward +X (clockwise from the cockpit).
  const sec = (r, c, betaDeg, t) => {
    const b = betaDeg * DEG;
    const cdir = V3(-Math.cos(b), 0, Math.sin(b));
    const up = V3(-Math.sin(b), 0, -Math.cos(b));
    const o = V3(0, r, 0).addScaledVector(cdir, -0.32 * c);
    return { o, cdir, up, c, t, m: 0.035, p: 0.4, x0: 0, x1: 1 };
  };
  const main = airfoilLoft([
    sec(0.10, 0.07, 48, 0.32), sec(0.18, 0.105, 38, 0.2), sec(0.32, 0.132, 29, 0.13),
    sec(0.52, 0.138, 21, 0.095), sec(0.72, 0.124, 16.5, 0.075), sec(0.86, 0.106, 14, 0.065),
  ], { N: 7, caps: [true, false] });
  const tip = airfoilLoft([
    sec(0.86, 0.106, 14, 0.065), sec(0.915, 0.092, 13, 0.06), sec(0.945, 0.07, 12.5, 0.055), sec(PROP.radius, 0.03, 12, 0.05),
  ], { N: 7, caps: [false, true] });
  const b = new Builder();
  b.add('blade', main, { color: colors.blade });
  b.add('blade', tip, { color: colors.tip });
  const one = b.geometry('blade');
  const two = one.clone().applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI));
  return mergeClean([one, two]);
}

function spinnerGeometry() {
  const pts = [];
  const R = 0.172, L = 0.34;
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    pts.push(new THREE.Vector2(Math.max(0.0001, R * Math.pow(1 - Math.pow(u, 1.9), 0.62)), u * L));
  }
  pts[14].x = 0.0001;
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateX(-Math.PI / 2); // lathe axis +Y -> -Z
  g.translate(0, 0, 0.085);   // base sits just in front of the cowling ring (relative to the prop plane)
  return g;
}

function propDiscTexture(tipColor) {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  const R = S / 2;
  const gr = g.createRadialGradient(R, R, 0, R, R, R);
  const k = (r) => r / PROP.radius;
  gr.addColorStop(0, 'rgba(30,30,30,0)');
  gr.addColorStop(k(0.2), 'rgba(30,30,30,0)');
  gr.addColorStop(k(0.24), 'rgba(35,35,35,0.30)');
  gr.addColorStop(k(0.55), 'rgba(40,40,40,0.24)');
  gr.addColorStop(k(0.84), 'rgba(45,45,45,0.16)');
  gr.addColorStop(k(0.87), tipColor.replace('ALPHA', '0.2'));
  gr.addColorStop(k(0.93), tipColor.replace('ALPHA', '0.16'));
  gr.addColorStop(k(0.955), 'rgba(60,60,60,0.05)');
  gr.addColorStop(1, 'rgba(60,60,60,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return canvasTexture(c);
}

// ---------------------------------------------------------------------------
// Landing gear
// ---------------------------------------------------------------------------

function tire(R, r) {
  const g = new THREE.TorusGeometry(R, r, 10, 24);
  g.rotateY(Math.PI / 2);
  return g;
}

function spat(len, halfW, halfH, front) {
  const st = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let f;
    if (u < 0.36) f = Math.sqrt(Math.max(0, 1 - ((0.36 - u) / 0.36) ** 2));
    else f = Math.pow(Math.max(0, 1 - Math.pow((u - 0.36) / 0.64, 2.2)), 0.85);
    f = Math.max(f, 0.03);
    st.push({ p: V3(0, 0.035 * u, front + len * u), a: halfW * f, b: halfH * f });
  }
  st[0].a = st[0].b = 0.004;
  return tube(st, { segs: 16, chordAxis: V3(1, 0, 0), capEnd: true });
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function roundedPath(ctx, pts, r) {
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const m0 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    if (i === 0) ctx.moveTo(m0[0], m0[1]);
    ctx.arcTo(p1[0], p1[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, r);
  }
  ctx.closePath();
}

// window outlines in (z, y) side projection
const WINDOWS = {
  windshield: [[-1.02, 0.30], [-0.36, 0.785], [-0.36, 1.4], [-1.02, 1.4]],
  door: [[-0.93, 0.175], [-0.93, 0.30], [-0.355, 0.735], [0.34, 0.735], [0.34, 0.175]],
  rearSide: [[0.44, 0.175], [0.44, 0.735], [1.13, 0.735], [0.97, 0.175]],
  rear: [[1.30, 0.752], [2.16, 0.575], [2.16, 1.4], [1.30, 1.4]],
};

// interior cut-out: windshield + door + rear side windows in one piece (frames are tubes)
const APILLAR = [[-1.02, 0.30], [-0.36, 0.785]];
const GREENHOUSE = [[-1.02, 0.30], [-1.02, 1.4], [-0.42, 1.4], [-0.42, 0.745], [1.13, 0.745], [0.97, 0.175], [-0.93, 0.175],
  [-0.93, 0.30 + (0.09 * 0.485) / 0.66]];

// stripe centre line (z, y) as a list of path commands in metres
function stripePath(ctx) {
  ctx.beginPath();
  ctx.moveTo(-2.16, -0.085);
  ctx.lineTo(1.1, -0.085);
  ctx.bezierCurveTo(2.3, -0.085, 3.2, -0.06, 3.85, 0.12);
  ctx.bezierCurveTo(4.5, 0.30, 5.1, 0.62, 5.95, 1.02);
}

function makeLivery(liv) {
  const W = liv.textureSize, S = W / (TZ1 - TZ0), HH = Math.round(W * 560 / 2048), H = HH * 2;
  const cv = makeCanvas(W, H), g = cv.getContext('2d');
  const rv = makeCanvas(W, H), r = rv.getContext('2d');
  g.fillStyle = liv.base; g.fillRect(0, 0, W, H);
  // roughness in G (0.36), metalness in B (0)
  r.fillStyle = 'rgb(0,92,0)'; r.fillRect(0, 0, W, H);
  const toPx = (z, y, half) => [(z - TZ0) * S, half * HH + (TY1 - y) * S];

  for (const half of [0, 1]) {
    for (const ctx of [g, r]) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, half * HH, W, HH); ctx.clip();
      ctx.setTransform(S, 0, 0, -S, -TZ0 * S, half * HH + TY1 * S);
    }
    // subtle belly shading line (panel join)
    g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 0.006;
    g.beginPath(); g.moveTo(-1.05, -0.47); g.lineTo(-1.05, 0.43); g.stroke(); // firewall / cowl joint
    g.beginPath(); g.moveTo(-2.12, 0.105); g.lineTo(-1.05, 0.105); g.stroke(); // cowling split
    // stripes: orange outer, white gap, blue core
    g.lineCap = 'butt'; g.lineJoin = 'round';
    stripePath(g); g.strokeStyle = liv.stripe2; g.lineWidth = 0.30; g.stroke();
    stripePath(g); g.strokeStyle = liv.base; g.lineWidth = 0.215; g.stroke();
    stripePath(g); g.strokeStyle = liv.stripe1; g.lineWidth = 0.17; g.stroke();
    // door seams + handle
    g.strokeStyle = 'rgba(25,30,40,0.45)'; g.lineWidth = 0.007;
    g.beginPath();
    g.moveTo(-0.33, 0.80); g.lineTo(-0.975, 0.315); g.lineTo(-0.975, -0.49); g.lineTo(0.385, -0.49); g.lineTo(0.385, 0.80);
    g.stroke();
    g.fillStyle = '#3b3f45';
    roundedPath(g, [[0.20, 0.105], [0.31, 0.105], [0.31, 0.13], [0.20, 0.13]], 0.01); g.fill();
    // step / fuel-drain dots on the cowling
    g.fillStyle = 'rgba(40,40,40,0.5)';
    for (const z of [-1.85, -1.6, -1.35]) { g.beginPath(); g.arc(z, 0.14, 0.008, 0, Math.PI * 2); g.fill(); }
    // windows
    const grad = g.createLinearGradient(0, 0.9, 0, 0.15);
    grad.addColorStop(0, '#5d7890');
    grad.addColorStop(0.35, '#2c3e50');
    grad.addColorStop(1, '#0e151d');
    for (const key of Object.keys(WINDOWS)) {
      const pts = WINDOWS[key];
      roundedPath(g, pts, 0.04);
      g.fillStyle = grad; g.fill();
      g.strokeStyle = 'rgba(30,34,40,0.9)'; g.lineWidth = 0.012; g.stroke();
      roundedPath(r, pts, 0.04);
      r.fillStyle = 'rgb(0,14,0)'; r.fill();
    }
    // flag on the fin
    if (liv.flag) drawFlag(g, 4.58, 1.13, 0.235);
    // material patches (referenced through the left-half UVs)
    if (half === 0) {
      for (const P of Object.values(PATCH)) {
        g.fillStyle = '#ffffff'; g.fillRect(P.z0, P.y0, P.z1 - P.z0, P.y1 - P.y0);
        r.fillStyle = P.rough; r.fillRect(P.z0, P.y0, P.z1 - P.z0, P.y1 - P.y0);
      }
    }
    for (const ctx of [g, r]) ctx.restore();

    // --- text (pixel space) ---
    const drawText = (txt, zc, yBase, capH, maxW, font, color, italic = false) => {
      const px = capH * S / 0.72;
      g.save();
      g.font = `${italic ? 'italic ' : ''}${font} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.fillStyle = color;
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      const w = g.measureText(txt).width;
      const sx = Math.min(1, (maxW * S) / w);
      const [cx, cy] = toPx(zc, yBase, half);
      g.beginPath(); g.rect(0, half * HH, W, HH); g.clip();
      g.translate(cx, cy);
      g.scale(half === 1 ? -sx : sx, 1);
      g.fillText(txt, 0, 0);
      g.restore();
    };
    drawText(liv.registration, 2.32, 0.20, 0.25, 1.45, '700', liv.regColor);
    if (liv.name) drawText(liv.name, -1.62, 0.155, 0.075, 0.55, '600', liv.stripe1, true);
  }
  const map = canvasTexture(cv);
  const roughnessMap = canvasTexture(rv, { srgb: false });
  return { map, roughnessMap };
}

function drawFlag(g, z0, y0, h) {
  const w = h * 1.5;
  g.fillStyle = '#e30a17';
  g.fillRect(z0, y0, w, h);
  const cy = y0 + h / 2;
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(z0 + 0.5 * h, cy, 0.25 * h, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e30a17';
  g.beginPath(); g.arc(z0 + 0.5625 * h, cy, 0.2 * h, 0, Math.PI * 2); g.fill();
  // star
  const sx = z0 + 0.5625 * h + 0.2 * h + 0.03 * h + 0.125 * h, R = 0.125 * h, r2 = R * 0.382;
  g.fillStyle = '#ffffff';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI + (i * Math.PI) / 5; // one point toward the hoist
    const rr = i % 2 === 0 ? R : r2;
    const px = sx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath(); g.fill();
}

function makeInteriorTexture() {
  const W = 2048, S = W / (TZ1 - TZ0), H = 560;
  const cv = makeCanvas(W, H), g = cv.getContext('2d');
  g.setTransform(S, 0, 0, -S, -TZ0 * S, TY1 * S);
  const band = (y0, y1, col) => { g.fillStyle = col; g.fillRect(TZ0, y0, TZ1 - TZ0, y1 - y0); };
  band(TY0, -0.44, '#3b3733');  // carpet
  band(-0.44, 0.10, '#6a655d'); // lower door panels
  band(0.10, 0.175, '#57534c'); // armrest line
  band(0.175, 0.74, '#9a958a'); // frames / posts
  band(0.74, TY1, '#cbc5b8');   // headliner
  // cut the windows (slightly larger than the painted exterior glass)
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  g.beginPath();
  for (const [z, y] of GREENHOUSE) g.lineTo(z, y);
  g.closePath(); g.fill();
  roundedPath(g, WINDOWS.rear, 0.05); g.fill();
  g.globalCompositeOperation = 'source-over';
  return canvasTexture(cv);
}

function makePanelTexture() {
  const W = 1024, H = 512;
  const cv = makeCanvas(W, H), g = cv.getContext('2d');
  // panel spans x in [-0.58, 0.58], y in [-0.22, 0.36]
  const X0 = -0.58, X1 = 0.58, Y0 = -0.22, Y1 = 0.36;
  const sx = W / (X1 - X0), sy = H / (Y1 - Y0);
  const P = (x, y) => [(x - X0) * sx, (Y1 - y) * sy];
  g.fillStyle = '#26282b'; g.fillRect(0, 0, W, H);
  // subtle texture
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  const R = 0.039 * sx;
  const gauge = (x, y, kind, label) => {
    const [cx, cy] = P(x, y);
    g.save();
    g.translate(cx, cy);
    g.fillStyle = '#0c0d0e';
    g.beginPath(); g.arc(0, 0, R * 1.12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6d6f73';
    g.beginPath(); g.arc(0, 0, R * 1.12, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#4a4c50'; g.stroke();
    g.fillStyle = '#141517';
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
    if (kind === 'attitude') {
      g.save(); g.beginPath(); g.arc(0, 0, R * 0.92, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#2f7fd0'; g.fillRect(-R, -R, 2 * R, R);
      g.fillStyle = '#8a5a2b'; g.fillRect(-R, 0, 2 * R, R);
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(-R, 0); g.lineTo(R, 0); g.stroke();
      for (const k of [-0.3, -0.15, 0.15, 0.3]) { g.beginPath(); g.moveTo(-R * 0.2, k * R); g.lineTo(R * 0.2, k * R); g.stroke(); }
      g.restore();
      g.strokeStyle = '#f2b31a'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(-R * 0.55, 0); g.lineTo(-R * 0.18, 0); g.lineTo(0, R * 0.12); g.lineTo(R * 0.18, 0); g.lineTo(R * 0.55, 0); g.stroke();
    } else {
      // ticks
      g.strokeStyle = '#e8e8e8';
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        const long = i % 3 === 0;
        g.lineWidth = long ? 2.2 : 1.2;
        g.beginPath();
        g.moveTo(Math.cos(a) * R * (long ? 0.72 : 0.8), Math.sin(a) * R * (long ? 0.72 : 0.8));
        g.lineTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9);
        g.stroke();
      }
      if (kind === 'asi') {
        const arc = (a0, a1, col, rr) => { g.strokeStyle = col; g.lineWidth = 5; g.beginPath(); g.arc(0, 0, R * rr, a0, a1); g.stroke(); };
        arc(-2.4, -0.2, '#2fa84f', 0.86); arc(-0.2, 0.9, '#e8c31a', 0.86); arc(-2.9, -1.6, '#eeeeee', 0.78);
      }
      if (kind === 'heading') {
        g.fillStyle = '#e8e8e8'; g.font = `bold ${R * 0.32}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
        ['N', 'E', 'S', 'W'].forEach((t, i) => { const a = i * Math.PI / 2 - Math.PI / 2; g.fillText(t, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5); });
        g.fillStyle = '#f2b31a'; g.beginPath(); g.moveTo(0, -R * 0.55); g.lineTo(-R * 0.1, -R * 0.25); g.lineTo(R * 0.1, -R * 0.25); g.fill();
      } else if (kind === 'turn') {
        g.strokeStyle = '#fff'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(-R * 0.6, R * 0.05); g.lineTo(R * 0.6, R * 0.05); g.stroke();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(0, R * 0.05, R * 0.1, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ddd'; g.fillRect(-R * 0.35, R * 0.45, R * 0.7, R * 0.14);
      } else {
        // needle
        const a = { asi: -2.0, alt: -0.9, vsi: Math.PI, tach: -1.1, small: -1.9 }[kind] ?? -1.4;
        g.strokeStyle = '#ffffff'; g.lineWidth = 3.5;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * 0.78, Math.sin(a) * R * 0.78); g.stroke();
        g.fillStyle = '#444'; g.beginPath(); g.arc(0, 0, R * 0.08, 0, Math.PI * 2); g.fill();
      }
    }
    if (label) {
      g.fillStyle = '#bfbfbf'; g.font = `${R * 0.2}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 0, R * 0.42);
    }
    g.restore();
  };
  // six-pack in front of the pilot (x = -0.27)
  const cx = -0.27;
  gauge(cx - 0.105, 0.215, 'asi', 'KNOTS');
  gauge(cx, 0.215, 'attitude');
  gauge(cx + 0.105, 0.215, 'alt', 'ALT');
  gauge(cx - 0.105, 0.11, 'turn');
  gauge(cx, 0.11, 'heading');
  gauge(cx + 0.105, 0.11, 'vsi', 'VSI');
  gauge(cx - 0.105, 0.005, 'tach', 'RPM');
  gauge(-0.49, 0.2, 'small');
  gauge(-0.49, 0.1, 'small');
  // radio stack
  const [rx0, ry0] = P(-0.08, 0.28), [rx1, ry1] = P(0.1, -0.08);
  g.fillStyle = '#101113'; g.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
  for (let i = 0; i < 5; i++) {
    const y = 0.25 - i * 0.07;
    const [a, b] = P(-0.07, y), [c, d] = P(0.09, y - 0.055);
    g.fillStyle = '#1b1d20'; g.fillRect(a, b, c - a, d - b);
    g.fillStyle = i % 2 ? '#45d06a' : '#f0a030';
    g.font = `bold ${0.022 * sy}px monospace`; g.textBaseline = 'middle'; g.textAlign = 'left';
    const txt = ['118.50  121.90', '113.90  110.30', '1200 ALT', 'COM2 124.00', 'GPS  LTBA'][i];
    g.fillText(txt, a + 8, (b + d) / 2);
  }
  // engine gauges + switches on the right
  gauge(0.2, 0.215, 'small', 'OIL');
  gauge(0.3, 0.215, 'small', 'FUEL');
  const [gx0, gy0] = P(0.18, 0.1), [gx1, gy1] = P(0.5, -0.1);
  g.strokeStyle = '#3c3f44'; g.lineWidth = 3; g.strokeRect(gx0, gy0, gx1 - gx0, gy1 - gy0); // glovebox
  g.fillStyle = '#d0d0d0';
  for (let i = 0; i < 8; i++) { const [a, b] = P(-0.5 + i * 0.035, -0.12); g.fillRect(a, b, 8, 22); }
  g.fillStyle = '#9a1c1c'; const [mx, my] = P(-0.02, -0.14); g.fillRect(mx, my, 26, 26); // mixture knob
  const tex = canvasTexture(cv);
  return { tex, X0, X1, Y0, Y1 };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

// Build all geometry for one livery. Returns categorised geometries and pivot data.
function buildParts(liv) {
  const B = new Builder();
  const col = (c) => new THREE.Color(c);
  const WHITE = col(liv.base), ACC = col(liv.wingtip), DARK = col('#1d1f22'), TIRE = col('#161616');
  const METAL = col('#a9adb2'), GREY = col('#5e6368');

  // fuselage + dorsal + fin (body material: livery texture)
  const fus = fuselageGeometries();
  B.add('body', fus.body);
  B.add('dark', fus.noseCap, { color: GREY });
  B.add('body', dorsalGeometries());
  const finG = finGeometries();
  B.add('body', finG.fin);

  // wings (right built in wing-local frame, then mirrored)
  const w = wingGeometries();
  B.add('paint', w.main, { color: WHITE, matrix: WING_M });
  B.add('paint', w.main, { color: WHITE, matrix: new THREE.Matrix4().makeScale(-1, 1, 1).multiply(WING_M) });
  B.add('paint', w.tip, { color: ACC, matrix: WING_M });
  B.add('paint', w.tip, { color: ACC, matrix: new THREE.Matrix4().makeScale(-1, 1, 1).multiply(WING_M) });

  // tail
  const st = stabGeometries();
  B.add('paint', st.fixed, { color: WHITE });
  B.add('paint', st.fixed, { color: WHITE, matrix: new THREE.Matrix4().makeScale(-1, 1, 1) });

  // wing struts
  const wingLocalToAc = (v) => v.clone().applyMatrix4(WING_M);
  for (const sx of [1, -1]) {
    const s = 2.55, c = wingChord(s), zLE = WING.teZ - c;
    const lower = naca(0.25, WING.t, WING.m).yc - naca(0.25, WING.t, WING.m).yt;
    const top = wingLocalToAc(V3(s, lower * c + 0.02, zLE + 0.22 * c));
    const yA = -0.36, zA = 0.14;
    const bot = V3(fuselageHalfWidth(zA, yA) - 0.02, yA, zA);
    top.x *= sx; bot.x *= sx;
    B.add('paint', strut(bot, top, 0.13, 0.042, 12), { color: WHITE });
    // small fairing at the wing attach
    B.add('paint', new THREE.SphereGeometry(0.05, 10, 8).scale(1, 0.6, 1.8), { color: WHITE, matrix: mat4([top.x, top.y - 0.01, top.z]) });
  }

  // main gear: spring legs, spats, tyres
  const mainBottom = [];
  for (const sx of [1, -1]) {
    const ax = sx * GEAR.mainX;
    const A = V3(sx * 0.40, -0.50, 0.30), Bp = V3(sx * (GEAR.mainX - 0.09), GEAR.mainAxleY + 0.06, GEAR.mainZ);
    B.add('paint', strut(A, Bp, 0.10, 0.034, 8), { color: WHITE });
    B.add('paint', spat(0.92, 0.135, 0.205, -0.38), { color: WHITE, matrix: mat4([ax, GEAR.mainAxleY + 0.05, GEAR.mainZ]) });
    B.add('dark', tire(GEAR.mainR, GEAR.mainTube), { color: TIRE, matrix: mat4([ax, GEAR.mainAxleY, GEAR.mainZ]) });
    B.add('metal', new THREE.CylinderGeometry(0.075, 0.075, 0.11, 14).rotateZ(Math.PI / 2), { color: METAL, matrix: mat4([ax, GEAR.mainAxleY, GEAR.mainZ]) });
    // step
    const stepP = V3().lerpVectors(A, Bp, 0.55);
    B.add('metal', new THREE.BoxGeometry(0.12, 0.012, 0.09), { color: GREY, matrix: mat4([stepP.x + sx * 0.02, stepP.y + 0.02, stepP.z - 0.09]) });
  }
  // nose gear
  B.add('metal', tube([{ p: V3(0, -0.36, -1.28), a: 0.034, b: 0.034 }, { p: V3(0, GEAR.noseAxleY + 0.12, GEAR.noseZ), a: 0.03, b: 0.03 }], { segs: 12 }), { color: METAL });
  B.add('dark', tube([{ p: V3(0, -0.34, -1.285), a: 0.055, b: 0.055 }, { p: V3(0, -0.58, -1.265), a: 0.05, b: 0.05 }], { segs: 12 }), { color: GREY });
  B.add('paint', spat(0.72, 0.105, 0.19, -0.3), { color: WHITE, matrix: mat4([0, GEAR.noseAxleY + 0.05, GEAR.noseZ]) });
  B.add('dark', tire(GEAR.noseR, GEAR.noseTube), { color: TIRE, matrix: mat4([0, GEAR.noseAxleY, GEAR.noseZ]) });

  // cowling details: air inlets, exhaust, spinner
  for (const sx of [1, -1]) {
    B.add('dark', new THREE.SphereGeometry(0.1, 16, 10).scale(1.45, 0.72, 0.5), { color: col('#141619'), matrix: mat4([sx * 0.245, 0.115, -2.125], [0, 0, sx * -0.12]) });
  }
  B.add('metal', tube([{ p: V3(0.2, -0.36, -1.45), a: 0.028, b: 0.028 }, { p: V3(0.22, -0.52, -1.38), a: 0.03, b: 0.03 }], { segs: 10 }), { color: col('#6b635a') });
  B.add('paint', spinnerGeometry(), { color: col(liv.spinner), matrix: mat4([PROP.pos.x, PROP.pos.y, PROP.pos.z]) });

  // antennas, pitot, wingtip light lenses
  B.add('dark', new THREE.BoxGeometry(0.012, 0.2, 0.09).translate(0, 0.1, 0), { color: DARK, matrix: mat4([0, FUS(2.45).top - 0.01, 2.45], [-0.35, 0, 0]) });
  B.add('dark', new THREE.BoxGeometry(0.01, 0.16, 0.07).translate(0, 0.08, 0), { color: DARK, matrix: mat4([0, FUS(3.1).top - 0.01, 3.1], [-0.35, 0, 0]) });
  B.add('dark', new THREE.BoxGeometry(0.01, 0.14, 0.06).translate(0, -0.07, 0), { color: DARK, matrix: mat4([0, FUS(1.6).bot + 0.01, 1.6], [0.3, 0, 0]) });
  {
    const s = 3.3, c = wingChord(s);
    const p = wingLocalToAc(V3(s, -0.06, WING.teZ - c + 0.12));
    B.add('metal', tube([{ p: V3(-p.x, p.y, p.z + 0.1), a: 0.01, b: 0.01 }, { p: V3(-p.x, p.y - 0.02, p.z - 0.32), a: 0.008, b: 0.008 }], { segs: 6 }), { color: METAL });
  }

  // fixed surfaces geometry for static meshes (control surfaces at neutral)
  const surfaces = {
    aileron: w.aileron, flap: w.flap, aileronHinge: w.aileronHinge, flapHinge: w.flapHinge,
    elevator: mergeClean([st.elevR, mirrorX(st.elevR)]),
    rudder: mergeClean(finG.rudder),
  };

  // wingtip positions (aircraft frame, right side)
  const tipC = WING.tipChord * 0.97;
  const tipNav = wingLocalToAc(V3(5.49, 0.0, WING.teZ - tipC + 0.07));
  const tipStrobe = wingLocalToAc(V3(5.505, 0.0, WING.teZ - tipC + 0.45));

  return { B, surfaces, tipNav, tipStrobe };
}

// Interior (cockpit) geometry, only for the player aircraft.
function buildInterior() {
  const B = new Builder();
  const col = (c) => new THREE.Color(c);
  // shell: inset fuselage loft with inward normals, alpha-cut windows
  const z0 = -1.02, z1 = 1.95, INSET = 0.03, COUNT = 28;
  const zs = stationList(z0, z1, 0.08);
  const rowsR = zs.map((z) => halfRing(FUS(z), COUNT, INSET).map(([x, y]) => V3(x, y, z)));
  const rowsL = rowsR.map((r) => r.map((v) => V3(-v.x, v.y, v.z)));
  const shell = [
    gridGeometry(rowsR, { flip: true, uvFn: uvInterior }),
    gridGeometry(rowsL, { flip: false, uvFn: uvInterior }),
  ];
  const ring = (i) => rowsR[i].concat(rowsL[i].slice(1, -1).reverse());
  const firewall = fanCap(ring(0), V3(0, 0, 1));
  const bulkhead = fanCap(ring(zs.length - 1), V3(0, 0, -1));

  // instrument panel: outline follows the cabin section
  const panel = makePanelTexture();
  const yA = -0.2, yB = 0.335, pts = [];
  const hwAt = (y) => fuselageHalfWidth(PANEL_Z, y, INSET) - 0.004;
  for (let i = 0; i <= 12; i++) { const y = lerp(yA, yB, i / 12); pts.push(new THREE.Vector2(hwAt(y), y)); }
  for (let i = 12; i >= 0; i--) { const y = lerp(yA, yB, i / 12); pts.push(new THREE.Vector2(-hwAt(y), y)); }
  const panelGeo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  {
    const p = panelGeo.attributes.position, uv = panelGeo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - panel.X0) / (panel.X1 - panel.X0), (p.getY(i) - panel.Y0) / (panel.Y1 - panel.Y0));
  }
  panelGeo.translate(0, 0, PANEL_Z);

  // glareshield deck (from the panel top forward to the firewall) + rounded lip
  const deckRows = [];
  const DZ = [PANEL_Z + 0.03, PANEL_Z, PANEL_Z - 0.05, -0.8, -0.9, -1.0];
  const DY = [0.30, 0.345, 0.36, 0.372, 0.378, 0.382];
  for (let i = 0; i < DZ.length; i++) {
    const w = fuselageHalfWidth(DZ[i], DY[i], INSET) - 0.004;
    const row = [];
    for (let j = 0; j <= 8; j++) row.push(V3(lerp(-w, w, j / 8), DY[i] + 0.012 * Math.sin((Math.PI * j) / 8), DZ[i]));
    deckRows.push(row);
  }
  B.add('interior', gridGeometry(deckRows, { flip: false }), { color: col('#2a2b2e') });

  // seats
  const seat = (x, z, w) => {
    const fabric = col('#5d6b82'), trimC = col('#3f4756');
    B.add('interior', new THREE.BoxGeometry(w, 0.12, 0.48), { color: fabric, matrix: mat4([x, -0.3, z]) });
    B.add('interior', new THREE.BoxGeometry(w + 0.02, 0.05, 0.5), { color: trimC, matrix: mat4([x, -0.38, z]) });
    B.add('interior', new THREE.BoxGeometry(w, 0.62, 0.11), { color: fabric, matrix: mat4([x, 0.02, z + 0.27], [0.2, 0, 0]) });
    for (const sx of [-1, 1]) B.add('interior', new THREE.BoxGeometry(0.05, 0.6, 0.13), { color: trimC, matrix: mat4([x + sx * (w / 2 + 0.01), 0.02, z + 0.27], [0.2, 0, 0]) });
    B.add('interior', new THREE.BoxGeometry(w * 0.55, 0.16, 0.09), { color: trimC, matrix: mat4([x, 0.41, z + 0.34], [0.2, 0, 0]) });
  };
  seat(-0.27, 0.32, 0.44);
  seat(0.27, 0.32, 0.44);
  seat(0, 1.28, 0.9);
  // window frames (smooth tubes hugging the cabin wall)
  const FRAME = col('#7a766e');
  const onWall = (z, y, side) => V3(side * fuselageHalfWidth(z, y, INSET + 0.012), y, z);
  const frame = (pts, side, r = 0.024) => {
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [z0, y0] = pts[i], [z1, y1] = pts[i + 1];
      const n = Math.max(2, Math.ceil(Math.hypot(z1 - z0, y1 - y0) / 0.05));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) dense.push([lerp(z0, z1, k / n), lerp(y0, y1, k / n)]);
    }
    B.add('interior', tube(dense.map(([z, y]) => ({ p: onWall(z, y, side), a: r, b: r })), { segs: 8, chordAxis: V3(0, 1, 0), capStart: true, capEnd: true }), { color: FRAME });
  };
  for (const side of [1, -1]) {
    frame([APILLAR[0], [-0.43, 0.755]], side, 0.019);             // A-pillar
    frame([[-0.43, 0.748], [1.13, 0.748]], side, 0.014);            // roof edge
    frame([[0.39, 0.17], [0.39, 0.748]], side, 0.024);              // door post
    frame([[0.97, 0.172], [1.13, 0.748]], side, 0.016);             // rear window post
    frame([[-0.93, 0.172], [0.97, 0.172]], side, 0.014);            // sill
    frame([[-0.93, 0.172], [-0.93, 0.366]], side, 0.014);           // door front edge
  }
  {
    // windshield top frame across the roof
    const pts = halfRing(FUS(-0.43), 40, INSET + 0.012).filter(([, y]) => y > 0.74).map(([x, y]) => V3(x, y, -0.43));
    const arc = pts.slice().reverse().map((v) => V3(-v.x, v.y, v.z)).concat(pts.slice(1));
    B.add('interior', tube(arc.map((p) => ({ p, a: 0.02, b: 0.016 })), { segs: 8, chordAxis: V3(0, 0, 1) }), { color: FRAME });
  }
  // compass on the windshield frame
  B.add('interior', new THREE.BoxGeometry(0.05, 0.045, 0.05), { color: col('#151515'), matrix: mat4([0, 0.755, -0.44]) });
  B.add('interior', new THREE.BoxGeometry(0.034, 0.024, 0.006), { color: col('#d8d2c0'), matrix: mat4([0, 0.755, -0.414]) });
  // rudder pedals
  for (const x of [-0.37, -0.17, 0.17, 0.37]) B.add('interior', new THREE.BoxGeometry(0.07, 0.12, 0.02), { color: col('#222'), matrix: mat4([x, -0.38, -0.88], [0.5, 0, 0]) });
  // throttle / mixture knobs
  B.add('interior', new THREE.CylinderGeometry(0.018, 0.018, 0.08, 10).rotateX(Math.PI / 2), { color: col('#151515'), matrix: mat4([0.0, -0.04, PANEL_Z + 0.04]) });

  return { B, shell, firewall, bulkhead, panelGeo, panelTex: panel.tex };
}

function yokeGeometry() {
  const b = new Builder();
  const c = new THREE.Color('#1a1a1c'), c2 = new THREE.Color('#2a2a2e');
  b.add('y', new THREE.CylinderGeometry(0.016, 0.016, 0.24, 10).rotateX(Math.PI / 2).translate(0, 0, -0.12), { color: new THREE.Color('#8d9197') });
  b.add('y', new THREE.BoxGeometry(0.08, 0.06, 0.04), { color: c2 });
  b.add('y', new THREE.BoxGeometry(0.30, 0.028, 0.03), { color: c, matrix: mat4([0, -0.01, 0.005]) });
  for (const sx of [1, -1]) b.add('y', new THREE.BoxGeometry(0.032, 0.12, 0.034), { color: c, matrix: mat4([sx * 0.15, 0.04, 0.005], [0, 0, sx * -0.12]) });
  return b.geometry('y');
}

function exteriorMaterial(liv) {
  const { map, roughnessMap } = makeLivery(liv);
  return new THREE.MeshStandardMaterial({
    map, roughnessMap, metalnessMap: roughnessMap, roughness: 1, metalness: 1, vertexColors: true,
  });
}

// Merge the categorised builder parts into one geometry for the shared exterior material.
function mergeExterior(B) {
  const list = [];
  for (const key of ['body', 'paint', 'dark', 'metal']) {
    const g = B.geometry(key);
    if (!g) continue;
    if (key !== 'body') setUV(g, patchUV(key));
    list.push(g);
  }
  return mergeClean(list);
}

function meshFrom(geo, mat, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

// Pivot: base (position + orientation) -> hinge (animated rotation) -> mesh.
function makePivot(parent, geoAircraft, mat, pos, quat = new THREE.Quaternion(), localGeo = false) {
  const base = new THREE.Object3D();
  base.position.copy(pos);
  base.quaternion.copy(quat);
  const hinge = new THREE.Object3D();
  base.add(hinge);
  let g = geoAircraft;
  if (!localGeo) {
    base.updateMatrix();
    g = clean(geoAircraft, { matrix: base.matrix.clone().invert() });
  }
  const mesh = meshFrom(g, mat);
  hinge.add(mesh);
  parent.add(base);
  return hinge;
}

// Distance from the origin (CG) down to the lowest tyre vertex, measured on the actual tyre geometry.
function gearHeightFromGeometry() {
  const probe = new THREE.Group();
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(tire(GEAR.mainR, GEAR.mainTube));
    m.position.set(sx * GEAR.mainX, GEAR.mainAxleY, GEAR.mainZ);
    m.userData.wheel = true;
    probe.add(m);
  }
  const n = new THREE.Mesh(tire(GEAR.noseR, GEAR.noseTube));
  n.position.set(0, GEAR.noseAxleY, GEAR.noseZ);
  n.userData.wheel = true;
  probe.add(n);
  return computeGearHeight(probe);
}

function computeGearHeight(object) {
  object.updateMatrixWorld(true);
  let minY = Infinity;
  const v = V3();
  object.traverse((o) => {
    if (!o.isMesh || !o.userData.wheel) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (v.y < minY) minY = v.y;
    }
  });
  return -minY;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Static aircraft with a custom livery (parked planes). Returns a Group; userData.gearHeight is set.
export function createAircraftMesh(options = {}) {
  const liv = { ...LIVERY_DEFAULT, textureSize: 1024, ...options };
  const { B, surfaces } = buildParts(liv);
  // control surfaces at neutral
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  for (const g of [surfaces.aileron, surfaces.flap]) {
    B.add('paint', g, { color: new THREE.Color(liv.base), matrix: WING_M });
    B.add('paint', g, { color: new THREE.Color(liv.base), matrix: mirror.clone().multiply(WING_M) });
  }
  B.add('paint', surfaces.elevator, { color: new THREE.Color(liv.base) });
  B.add('body', surfaces.rudder);
  B.add('dark', bladeGeometry({ blade: '#1b1b1b', tip: '#e8c21a' }), { matrix: mat4([PROP.pos.x, PROP.pos.y, PROP.pos.z], [0, 0, 0.6]) });
  const group = new THREE.Group();
  group.name = `aircraft-${liv.registration}`;
  group.add(meshFrom(mergeExterior(B), exteriorMaterial(liv)));
  group.userData.gearHeight = gearHeightFromGeometry();
  return group;
}

export function createAircraft() {
  const liv = { ...LIVERY_DEFAULT };
  const object = new THREE.Group();
  object.name = 'player-aircraft';
  const { B, surfaces, tipNav, tipStrobe } = buildParts(liv);
  const extMat = exteriorMaterial(liv);

  // --- static exterior (one mesh) ---
  const exterior = meshFrom(mergeExterior(B), extMat);
  exterior.name = 'exterior';
  object.add(exterior);
  const gearHeight = gearHeightFromGeometry();

  // --- control surfaces ---
  const paint = extMat;
  const WHITE = new THREE.Color(liv.base);
  const colorize = (g) => setUV(clean(g, { color: WHITE }), patchUV('paint'));
  // right side: geometry is wing-local; pivot base at M*hinge with orientation WING_Q
  const pivotFor = (geoLocal, hingeLocal, side) => {
    const local = colorize(geoLocal).translate(-hingeLocal.x, -hingeLocal.y, -hingeLocal.z);
    const pos = hingeLocal.clone().applyMatrix4(WING_M);
    if (side < 0) {
      pos.x = -pos.x;
      return makePivot(object, mirrorX(local), paint, pos, WING_Q.clone().invert(), true);
    }
    return makePivot(object, local, paint, pos, WING_Q, true);
  };
  const aileronR = pivotFor(surfaces.aileron, surfaces.aileronHinge, 1);
  const aileronL = pivotFor(surfaces.aileron, surfaces.aileronHinge, -1);
  const flapR = pivotFor(surfaces.flap, surfaces.flapHinge, 1);
  const flapL = pivotFor(surfaces.flap, surfaces.flapHinge, -1);
  const elevator = makePivot(object, colorize(surfaces.elevator), paint, V3(0, STAB.y, STAB.hinge));
  const rudderQ = new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), V3().subVectors(RUDDER_AXIS_B, RUDDER_AXIS_A).normalize());
  const rudder = makePivot(object, clean(surfaces.rudder, { color: 0xffffff }), extMat, RUDDER_AXIS_A, rudderQ);

  // --- propeller ---
  const prop = new THREE.Group();
  prop.position.copy(PROP.pos);
  object.add(prop);
  const bladeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, transparent: true, opacity: 1 });
  const blades = meshFrom(bladeGeometry({ blade: '#1b1b1b', tip: '#e8c21a' }), bladeMat);
  blades.castShadow = true;
  prop.add(blades);
  const discMat = new THREE.MeshBasicMaterial({
    map: propDiscTexture('rgba(232,194,26,ALPHA)'), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(PROP.radius + 0.01, 48), discMat);
  disc.renderOrder = 2;
  prop.add(disc);

  // --- lights ---
  const glow = glowTexture();
  const lightMat = (c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const spriteMat = (c, o) => new THREE.SpriteMaterial({ map: glow, color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
  const addLight = (parent, pos, color, size, glowSize, glowOpacity) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), lightMat(color));
    m.position.copy(pos);
    parent.add(m);
    const s = new THREE.Sprite(spriteMat(color, glowOpacity));
    s.position.copy(pos);
    s.scale.setScalar(glowSize);
    parent.add(s);
    return { mesh: m, sprite: s };
  };
  const navR = addLight(object, tipNav, 0x30ff60, 0.035, 0.5, 0.55);
  const navL = addLight(object, V3(-tipNav.x, tipNav.y, tipNav.z), 0xff2a2a, 0.035, 0.5, 0.55);
  const tail = addLight(rudder, V3(0, 1.36, 5.62).applyMatrix4(rudder.parent.matrix.clone().invert()), 0xffffff, 0.028, 0.35, 0.35);
  const strobeR = addLight(object, tipStrobe, 0xffffff, 0.03, 1.5, 0);
  const strobeL = addLight(object, V3(-tipStrobe.x, tipStrobe.y, tipStrobe.z), 0xffffff, 0.03, 1.5, 0);
  // beacon on the fin tip
  const beaconBase = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
  const beaconY = 1.475;
  beaconBase.position.set(0, beaconY, 4.99);
  object.add(beaconBase);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0x551010, toneMapped: false });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), beaconMat);
  beacon.scale.set(1, 1.3, 1);
  beacon.position.set(0, beaconY + 0.012, 4.99);
  object.add(beacon);
  const beaconGlow = new THREE.Sprite(spriteMat(0xff2020, 0));
  beaconGlow.position.set(0, beaconY + 0.04, 4.99);
  beaconGlow.scale.setScalar(0.8);
  object.add(beaconGlow);
  for (const l of [strobeR, strobeL]) l.mesh.material.color.set(0x777777);

  // --- cockpit interior ---
  const I = buildInterior();
  const interiorTex = makeInteriorTexture();
  const shellMat = new THREE.MeshStandardMaterial({ map: interiorTex, emissiveMap: interiorTex, emissive: 0x6a6a6a, alphaTest: 0.5, roughness: 0.92 });
  const shell = new THREE.Mesh(mergeClean(I.shell), shellMat);
  object.add(shell);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.95, emissive: 0x2a2826 });
  object.add(new THREE.Mesh(mergeClean([I.firewall, I.bulkhead]), capMat));
  const panelMat = new THREE.MeshStandardMaterial({ map: I.panelTex, emissiveMap: I.panelTex, emissive: 0xffffff, emissiveIntensity: 0.28, roughness: 0.75 });
  object.add(new THREE.Mesh(I.panelGeo, panelMat));
  const interiorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, emissive: 0x222222 });
  object.add(new THREE.Mesh(I.B.geometry('interior'), interiorMat));
  const yokeGeo = yokeGeometry();
  const yokes = [-0.27, 0.27].map((x) => {
    const y = new THREE.Mesh(yokeGeo, interiorMat);
    y.position.set(x, 0.1, PANEL_Z + 0.2);
    object.add(y);
    return y;
  });

  const cockpitOffset = COCKPIT_EYE.clone();

  // --- animation state ---
  let time = 0, omega = 8, propAngle = 0;
  const flapBase = [flapR.position.clone(), flapL.position.clone()];

  function update(dt, v) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += dt;
    const ail = clamp(v?.aileron ?? 0, -1, 1);
    const ele = clamp(v?.elevator ?? 0, -1, 1);
    const rud = clamp(v?.rudder ?? 0, -1, 1);
    const flp = clamp(v?.flaps ?? 0, 0, 1);
    const thr = clamp(v?.throttle ?? 0, 0, 1);
    const spd = Math.max(0, v?.airspeed ?? 0);

    // + aileron = roll right: right aileron trailing edge up, left down
    aileronR.rotation.x = -ail * 20 * DEG;
    aileronL.rotation.x = ail * 20 * DEG;
    // flaps: down up to 30 deg, sliding slightly aft (Fowler)
    flapR.rotation.x = flapL.rotation.x = flp * 30 * DEG;
    flapR.position.set(0, -0.025 * flp, 0.1 * flp).add(flapBase[0]);
    flapL.position.set(0, -0.025 * flp, 0.1 * flp).add(flapBase[1]);
    // + elevator = nose up: trailing edge up
    elevator.rotation.x = -ele * 24 * DEG;
    // + rudder = yaw right: trailing edge to +X
    rudder.rotation.y = rud * 22 * DEG;
    // yokes: turn with aileron, pull back with elevator
    for (const y of yokes) {
      y.rotation.z = -ail * 35 * DEG;
      y.position.z = PANEL_Z + 0.2 + ele * 0.06;
    }

    // propeller: idle still turns; blades fade into a blur disc at high rpm
    const target = 9 + 58 * Math.pow(thr, 0.85) + spd * 0.15;
    omega += (target - omega) * Math.min(1, dt * 2.2);
    propAngle -= omega * dt;
    prop.rotation.z = propAngle % (Math.PI * 2);
    const blur = smoothstep(16, 42, omega);
    bladeMat.opacity = 1 - 0.9 * blur;
    bladeMat.depthWrite = blur < 0.5;
    blades.castShadow = blur < 0.5;
    discMat.opacity = 0.85 * blur;
    disc.visible = blur > 0.01;

    // strobes: double flash every 1.2 s
    const ph = time % 1.2;
    const strobeOn = ph < 0.05 || (ph > 0.14 && ph < 0.19);
    for (const l of [strobeR, strobeL]) {
      l.sprite.material.opacity = strobeOn ? 1 : 0;
      l.mesh.material.color.set(strobeOn ? 0xffffff : 0x777777);
    }
    // beacon: red pulse once per second
    const bp = (time + 0.37) % 1.0;
    const bi = bp < 0.14 ? Math.sin((bp / 0.14) * Math.PI) : 0;
    beaconGlow.material.opacity = 0.75 * bi;
    beaconMat.color.setRGB(0.33 + 0.67 * bi, 0.06 + 0.1 * bi, 0.06 + 0.1 * bi);
  }

  update(0, { throttle: 0, aileron: 0, elevator: 0, rudder: 0, flaps: 0, airspeed: 0 });

  return { object, gearHeight, cockpitOffset, update };
}
