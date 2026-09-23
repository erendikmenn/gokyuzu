// Procedural SVG art: the Golden Gate Bridge (line art for the loading screen, layered silhouette for the menu)
// and blueprint-style aircraft planforms (menu card / hero fallback when no thumbnail render exists).

const f1 = (v) => (Math.round(v * 10) / 10).toString();

// ---------- Golden Gate Bridge geometry (viewBox units) ----------
// Main span 1280 m, side spans 343 m, towers 227 m above water, deck ~67 m. Heights are exaggerated ~2× for the
// silhouette so the towers read at thumbnail size.
function bridgeGeometry({ W = 1600, water = 330, deck = 262, towerTop = 58, t1 = 540, t2 = 1060, anchorL = 300, anchorR = 1300 } = {}) {
  const cableTop = towerTop + 16;
  const mid = (t1 + t2) / 2, half = (t2 - t1) / 2;
  const sag = deck - 8 - cableTop;                 // lowest cable point just above the deck
  const mainY = (x) => cableTop + sag * (1 - ((x - mid) / half) ** 2);
  // side spans: cable from the tower top down to the anchorage at deck level (slight sag)
  const sideY = (x, tx, ax) => {
    const u = (x - tx) / (ax - tx);
    return cableTop + (deck - 4 - cableTop) * u + 26 * u * (1 - u);
  };
  return { W, water, deck, towerTop, cableTop, t1, t2, anchorL, anchorR, mainY, sideY, mid };
}

function towerPath(cx, top, bottom, legW = 13, gap = 30) {
  // Art-deco tower: two tapering legs, stepped tops and four portal struts.
  const out = [];
  const h = bottom - top;
  for (const s of [-1, 1]) {
    const xi = cx + s * gap / 2, xo = cx + s * (gap / 2 + legW);
    const xiT = cx + s * (gap / 2 - 1), xoT = cx + s * (gap / 2 + legW - 3.5);
    out.push(`M${f1(xi)} ${f1(bottom)} L${f1(xiT)} ${f1(top + 6)} L${f1(xiT + s * 1.5)} ${f1(top)} L${f1(xoT - s * 1.5)} ${f1(top)} L${f1(xoT)} ${f1(top + 6)} L${f1(xo)} ${f1(bottom)} Z`);
  }
  // portal struts (between the legs), shrinking upward like the real setbacks
  const levels = [0.04, 0.26, 0.47, 0.66];
  for (const l of levels) {
    const y = top + h * l;
    const hh = 7 - l * 3;
    out.push(`M${f1(cx - gap / 2)} ${f1(y)} H${f1(cx + gap / 2)} V${f1(y + hh)} H${f1(cx - gap / 2)} Z`);
  }
  return out.join(' ');
}

/** Line-art Golden Gate for the loading screen: returns SVG markup with stroke-only paths (class hooks for animation). */
export function goldenGateLineSVG() {
  const g = bridgeGeometry();
  const { W, water, deck, towerTop, t1, t2, anchorL, anchorR } = g;
  const parts = [];
  // hills (Marin headlands left, Presidio right) and distant city
  parts.push(`<path class="gg-hill" d="M0 ${water - 40} C 60 ${water - 110}, 150 ${water - 150}, 230 ${water - 128} S 330 ${water - 70}, 400 ${water - 30} L 470 ${water}"/>`);
  parts.push(`<path class="gg-hill gg-far" d="M1240 ${water} C 1300 ${water - 26}, 1360 ${water - 40}, 1420 ${water - 34} S 1540 ${water - 18}, 1600 ${water - 22}"/>`);
  parts.push(`<path class="gg-city" d="M1440 ${water - 20} V${water - 38} H1452 V${water - 50} H1462 V${water - 26} H1472 V${water - 44} L1478 ${water - 96} L1484 ${water - 44} V${water - 30} H1494 V${water - 58} Q1500 ${water - 70} 1506 ${water - 58} V${water - 24} H1520 V${water - 40} H1530 V${water - 22}"/>`);
  // deck
  parts.push(`<path class="gg-deck" d="M${anchorL - 90} ${deck + 10} L${anchorL} ${deck} H${anchorR} L${anchorR + 110} ${deck + 12}"/>`);
  parts.push(`<path class="gg-truss" d="M${anchorL} ${deck + 7} H${anchorR}"/>`);
  // towers
  parts.push(`<path class="gg-tower" d="${towerPath(t1, towerTop, water)}"/>`);
  parts.push(`<path class="gg-tower" d="${towerPath(t2, towerTop, water)}"/>`);
  // piers
  parts.push(`<path class="gg-pier" d="M${t1 - 30} ${water} h60 M${t2 - 30} ${water} h60"/>`);
  // main cable + side cables
  let d = `M${t1} ${f1(g.cableTop)}`;
  for (let x = t1; x <= t2; x += 8) d += ` L${f1(x)} ${f1(g.mainY(x))}`;
  parts.push(`<path class="gg-cable" d="${d}"/>`);
  let dl = `M${t1} ${f1(g.cableTop)}`;
  for (let x = t1; x >= anchorL; x -= 8) dl += ` L${f1(x)} ${f1(g.sideY(x, t1, anchorL))}`;
  let dr = `M${t2} ${f1(g.cableTop)}`;
  for (let x = t2; x <= anchorR; x += 8) dr += ` L${f1(x)} ${f1(g.sideY(x, t2, anchorR))}`;
  parts.push(`<path class="gg-cable" d="${dl}"/><path class="gg-cable" d="${dr}"/>`);
  // suspenders
  let s = '';
  for (let x = t1 + 14; x < t2 - 6; x += 14) s += `M${x} ${f1(g.mainY(x) + 1)} V${deck}`;
  for (let x = t1 - 14; x > anchorL + 6; x -= 14) s += `M${x} ${f1(g.sideY(x, t1, anchorL) + 1)} V${deck}`;
  for (let x = t2 + 14; x < anchorR - 6; x += 14) s += `M${x} ${f1(g.sideY(x, t2, anchorR) + 1)} V${deck}`;
  parts.push(`<path class="gg-susp" d="${s}"/>`);
  // water lines
  parts.push(`<path class="gg-water" d="M0 ${water} H${W} M180 ${water + 16} H560 M760 ${water + 14} H1260 M420 ${water + 30} H900 M1100 ${water + 28} H1480"/>`);
  // cable lights (twinkle)
  let lights = '';
  for (let i = 1; i < 12; i++) {
    const x = t1 + (t2 - t1) * i / 12;
    lights += `<circle class="gg-light" style="animation-delay:${(i * 0.37) % 2.2}s" cx="${f1(x)}" cy="${f1(g.mainY(x))}" r="2.2"/>`;
  }
  lights += `<circle class="gg-beacon" cx="${t1}" cy="${towerTop - 6}" r="3"/><circle class="gg-beacon" style="animation-delay:.6s" cx="${t2}" cy="${towerTop - 6}" r="3"/>`;
  return `<svg class="gg-line" viewBox="0 0 ${W} 380" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts.join('')}${lights}</svg>`;
}

/**
 * Layered silhouette scene for the menu background (sky/sun are CSS; this is hills + bridge + fog + water).
 * Looking west into the sunset through the Golden Gate: Presidio low on the left, Marin Headlands tall on the
 * right. viewBox 1600 × 760; the water line is at y = 332 (the menu positions the SVG so it sits on the horizon).
 */
export const SCENE_VB = { w: 1600, h: 760, water: 332, sunX: 650 };
export function goldenGateSceneSVG() {
  const g = bridgeGeometry({ W: 1600, water: 332, deck: 266, towerTop: 44, t1: 380, t2: 920, anchorL: 170, anchorR: 1130 });
  const { W, water, deck, towerTop, t1, t2, anchorL, anchorR } = g;
  let cable = `M${t1} ${f1(g.cableTop)}`;
  for (let x = t1; x <= t2; x += 6) cable += ` L${f1(x)} ${f1(g.mainY(x))}`;
  let cl = `M${t1} ${f1(g.cableTop)}`;
  for (let x = t1; x >= anchorL; x -= 6) cl += ` L${f1(x)} ${f1(g.sideY(x, t1, anchorL))}`;
  let cr = `M${t2} ${f1(g.cableTop)}`;
  for (let x = t2; x <= anchorR; x += 6) cr += ` L${f1(x)} ${f1(g.sideY(x, t2, anchorR))}`;
  let susp = '';
  for (let x = t1 + 10; x < t2 - 4; x += 10) susp += `M${x} ${f1(g.mainY(x))} V${deck}`;
  for (let x = t1 - 10; x > anchorL + 4; x -= 10) susp += `M${x} ${f1(g.sideY(x, t1, anchorL))} V${deck}`;
  for (let x = t2 + 10; x < anchorR - 4; x += 10) susp += `M${x} ${f1(g.sideY(x, t2, anchorR))} V${deck}`;
  // sun reflection streaks under the sun
  let streaks = '';
  for (let i = 0; i < 22; i++) {
    const y = water + 5 + i * i * 0.5 + i * 2.2;
    const w = 30 + i * 8 + (i % 3) * 16;
    const cx = SCENE_VB.sunX + ((i * 37) % 29) - 14;
    streaks += `<rect class="gm-streak" style="animation-delay:${((i * 0.41) % 3).toFixed(2)}s" x="${f1(cx - w / 2)}" y="${f1(y)}" width="${f1(w)}" height="${f1(1.3 + i * 0.1)}" rx="1"/>`;
  }
  return `<svg class="gm-scene" viewBox="0 0 ${W} ${SCENE_VB.h}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
  <defs>
    <linearGradient id="gmWater" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2f48"/><stop offset=".25" stop-color="#141c30"/><stop offset="1" stop-color="#060a14"/>
    </linearGradient>
    <linearGradient id="gmFog" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f3d4c0" stop-opacity="0"/><stop offset=".45" stop-color="#f0cdb8" stop-opacity=".5"/><stop offset="1" stop-color="#c9b3b2" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gmRim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff7a45" stop-opacity="0"/><stop offset=".45" stop-color="#ffb070" stop-opacity=".95"/><stop offset="1" stop-color="#ff7a45" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path class="gm-far" d="M0 ${water - 36} C 120 ${water - 56}, 240 ${water - 40}, 330 ${water - 22} L 330 ${water} L0 ${water} Z"/>
  <path class="gm-far" d="M980 ${water} C 1060 ${water - 30}, 1150 ${water - 90}, 1260 ${water - 104} S 1440 ${water - 88}, 1600 ${water - 110} L1600 ${water} Z"/>
  <g class="gm-fog gm-fog-back"><rect x="-200" y="${water - 50}" width="2200" height="62" fill="url(#gmFog)"/></g>
  <path class="gm-near" d="M0 ${water - 70} C 60 ${water - 84}, 130 ${water - 70}, 190 ${water - 40} S 250 ${water - 8}, 300 ${water} L0 ${water} Z"/>
  <path class="gm-near" d="M1060 ${water} C 1120 ${water - 40}, 1180 ${water - 150}, 1290 ${water - 196} S 1450 ${water - 214}, 1600 ${water - 200} L1600 ${water} Z"/>
  <g class="gm-bridge">
    <path class="gm-tower" d="${towerPath(t1, towerTop, water + 4, 15, 34)}"/>
    <path class="gm-tower" d="${towerPath(t2, towerTop, water + 4, 15, 34)}"/>
    <path d="M${anchorL - 140} ${deck + 18} L${anchorL} ${deck} H${anchorR} L${anchorR + 120} ${deck + 22} V${deck + 30} L${anchorR} ${deck + 9} H${anchorL} L${anchorL - 140} ${deck + 27} Z"/>
    <path class="gm-cable" d="${cable}"/><path class="gm-cable" d="${cl}"/><path class="gm-cable" d="${cr}"/>
    <path class="gm-susp" d="${susp}"/>
    <path class="gm-rim" d="M${anchorL} ${deck + .5} H${anchorR}" stroke="url(#gmRim)"/>
  </g>
  <rect x="-400" y="${water}" width="${W + 800}" height="${SCENE_VB.h - water + 600}" fill="url(#gmWater)"/>
  <g class="gm-streaks">${streaks}</g>
  <g class="gm-fog gm-fog-front"><rect x="-200" y="${water - 18}" width="2200" height="34" fill="url(#gmFog)"/></g>
</svg>`;
}

// ---------- aircraft planforms ----------
// Right-half outlines in a frame with the nose at y = 0 and the tail at y = 100 (x scaled by the real
// span/length ratio). Mirrored for the left half.
const PLANFORMS = {
  f16: {
    body: [[0, 0], [1.4, 4], [2.6, 9], [3.4, 15], [3.9, 22], [4.4, 29], [5.4, 34], [8.2, 43], [10.6, 49], [31, 69], [32.6, 70], [32.6, 78], [11, 80], [8.4, 82], [8.4, 84.5], [21.5, 94.5], [21.8, 98.5], [7.8, 97.5], [4.6, 98.2], [3.9, 100]],
    lines: [[[0, 22], [0, 96]], [[2.2, 15], [0, 11]]],
    canopy: [[0, 11], [1.8, 14], [2.2, 20], [1.6, 26], [0, 28]],
  },
  f22: {
    body: [[0, 0], [1.6, 5], [3.2, 11], [4.6, 18], [6.8, 26], [8.8, 33], [9.6, 42], [35.4, 66.5], [35.8, 70.8], [13.2, 78.4], [11.4, 80], [11.2, 81], [24.4, 93.2], [24.6, 97.4], [12.6, 99.2], [6.2, 97.6], [5.2, 100]],
    lines: [[[8.6, 74], [15.8, 92]], [[0, 24], [0, 97]]],
    canopy: [[0, 8], [2.2, 12], [2.8, 19], [2.2, 25], [0, 27]],
  },
  a320neo: {
    body: [[0, 0], [1.3, 0.9], [2.8, 2.6], [4.0, 5.4], [4.9, 9.2], [5.25, 14], [5.25, 37.6], [17, 43.4], [46, 57.2], [47.6, 57.4], [47.8, 60.6], [46.2, 61], [17, 54.6], [5.25, 54.6], [5.25, 78], [4.4, 83.6], [16.2, 91.6], [16.8, 94.8], [3.6, 94.6], [2.4, 97.6], [0.9, 99.4], [0, 100]],
    nacelles: [[15.4, 31.5, 3.2, 12.5]],
    lines: [[[0, 84], [0, 100]]],
    canopy: [[0, 2.2], [2.2, 3.2], [3.0, 5.6], [0, 5.2]],
  },
  b737: {
    body: [[0, 0], [1.2, 0.8], [2.6, 2.4], [3.7, 5], [4.5, 8.8], [4.76, 13], [4.76, 38.4], [15.6, 43.2], [44, 56.8], [45.2, 57], [45.4, 60], [44, 60.4], [15.6, 55.2], [4.76, 55.2], [4.76, 80], [4.0, 84.6], [15, 92.8], [15.6, 96], [3.2, 95.6], [2.2, 98], [0.8, 99.5], [0, 100]],
    nacelles: [[12.4, 33.4, 2.9, 10.4]],
    lines: [[[0, 85], [0, 100]]],
    canopy: [[0, 2], [2, 2.9], [2.8, 5.2], [0, 4.8]],
  },
  uh60: {
    body: [[0, 10.5], [2.6, 11.2], [4.4, 13.2], [5.6, 16.4], [6.0, 21], [6.0, 44], [4.8, 50], [2.4, 55], [1.8, 70], [1.4, 84], [1.4, 85.2], [11.4, 86.4], [11.6, 89.2], [1.2, 89.6], [1.1, 93], [0, 94]],
    rotor: { cx: 0, cy: 33, r: 41.4, blades: 4, tail: [[2.2, 84.5], [2.2, 101.5]] },
    lines: [[[0, 45], [0, 92]]],
    canopy: [[0, 11.2], [3.4, 12.6], [4.6, 16], [4.4, 18.4], [0, 18.4]],
  },
};
PLANFORMS.default = PLANFORMS.a320neo;

function mirrorPath(pts) {
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += ` L${f1(pts[i][0])} ${f1(pts[i][1])}`;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] !== 0 || i === 0) d += ` L${f1(-pts[i][0])} ${f1(pts[i][1])}`;
  return `${d} Z`;
}

/**
 * Blueprint-style planform. opts: { rotate (deg), dims: { span, length } labels → dimension lines, className }.
 * Returns SVG markup (viewBox centred on the aircraft).
 */
export function planformSVG(id, { rotate = 0, dims = null, className = '' } = {}) {
  const p = PLANFORMS[id] || PLANFORMS.default;
  const pad = dims ? 26 : 8;
  const halfW = p.rotor ? p.rotor.r + 2 : Math.max(...p.body.map((q) => q[0]));
  const y0 = p.rotor ? Math.min(0, p.rotor.cy - p.rotor.r) : 0;
  const y1 = p.rotor ? Math.max(102, p.rotor.cy + p.rotor.r) : 100;
  const cx = 0, cy = (y0 + y1) / 2;
  const R = Math.max(halfW, (y1 - y0) / 2) + pad;
  const parts = [];
  if (p.rotor) {
    const { cx: rx, cy: ry, r, blades, tail } = p.rotor;
    parts.push(`<circle class="pf-disc" cx="${rx}" cy="${ry}" r="${r}"/>`);
    let bl = '';
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2 + Math.PI / 4;
      bl += `M${f1(rx)} ${f1(ry)} L${f1(rx + Math.cos(a) * r)} ${f1(ry + Math.sin(a) * r)}`;
    }
    parts.push(`<path class="pf-blade" d="${bl}"/>`);
    parts.push(`<path class="pf-body" d="${mirrorPath(p.body)}"/>`);
    parts.push(`<path class="pf-line" d="M${tail[0][0]} ${tail[0][1]} L${tail[1][0]} ${tail[1][1]}"/>`);
    parts.push(`<circle class="pf-hub" cx="${rx}" cy="${ry}" r="2.4"/>`);
  } else {
    parts.push(`<path class="pf-body" d="${mirrorPath(p.body)}"/>`);
  }
  if (p.nacelles) for (const [x, y, w, l] of p.nacelles) {
    for (const s of [-1, 1]) parts.push(`<rect class="pf-nacelle" x="${f1(s * x - w)}" y="${f1(y)}" width="${f1(2 * w)}" height="${f1(l)}" rx="${f1(w * 0.8)}"/>`);
  }
  if (p.canopy) parts.push(`<path class="pf-canopy" d="${mirrorPath(p.canopy)}"/>`);
  if (p.lines) {
    let d = '';
    for (const [[ax, ay], [bx, by]] of p.lines) {
      d += `M${f1(ax)} ${f1(ay)} L${f1(bx)} ${f1(by)}`;
      if (ax !== 0 || bx !== 0) d += `M${f1(-ax)} ${f1(ay)} L${f1(-bx)} ${f1(by)}`;
    }
    parts.push(`<path class="pf-line" d="${d}"/>`);
  }
  let dimMarkup = '';
  if (dims) {
    const yS = y0 - 12, xL = halfW + 12;
    dimMarkup += `<g class="pf-dim"><path d="M${f1(-halfW)} ${f1(yS)} H${f1(halfW)} M${f1(-halfW)} ${f1(yS - 4)} V${f1(yS + 4)} M${f1(halfW)} ${f1(yS - 4)} V${f1(yS + 4)}"/>`;
    dimMarkup += `<path d="M${f1(xL)} ${f1(y0)} V${f1(y1)} M${f1(xL - 4)} ${f1(y0)} H${f1(xL + 4)} M${f1(xL - 4)} ${f1(y1)} H${f1(xL + 4)}"/>`;
    if (dims.span) dimMarkup += `<text x="0" y="${f1(yS - 5)}" text-anchor="middle">${dims.span}</text>`;
    if (dims.length) dimMarkup += `<text x="${f1(xL + 6)}" y="${f1(cy)}" transform="rotate(90 ${f1(xL + 6)} ${f1(cy)})" text-anchor="middle">${dims.length}</text>`;
    dimMarkup += '</g>';
  }
  const vb = `${f1(cx - R)} ${f1(cy - R)} ${f1(2 * R)} ${f1(2 * R)}`;
  return `<svg class="pf ${className}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g transform="rotate(${rotate} ${cx} ${f1(cy)})">${parts.join('')}${dimMarkup}</g></svg>`;
}

export const HAS_PLANFORM = (id) => !!PLANFORMS[id];
