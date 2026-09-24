// İstanbul menu / loading art (src/maps/ist.js, lazy chunk): the counterparts of src/ui/art.js's Golden Gate pieces in
// the same classes, viewBoxes and layering, so the menu (SCENE_VB 1600 × 760, water line y = 332, sun at x = 650) and
// the loading screen animate them unchanged: a Bosphorus suspension bridge (slender portal towers, cables anchored
// on the hills, no suspended side spans) with a mosque on the hill (dome, half domes, four minarets) and Galata Kulesi.
const f1 = (v) => (Math.round(v * 10) / 10).toString();

function bridge({ water, deck, towerTop, t1, t2, anchorL, anchorR }) {
  const cableTop = towerTop + 10, mid = (t1 + t2) / 2, half = (t2 - t1) / 2, sag = deck - 8 - cableTop;
  const mainY = (x) => cableTop + sag * (1 - ((x - mid) / half) ** 2);
  const sideY = (x, tx, ax) => { const u = (x - tx) / (ax - tx); return cableTop + (deck - 30 - cableTop) * u + 18 * u * (1 - u); };
  return { water, deck, towerTop, cableTop, t1, t2, anchorL, anchorR, mainY, sideY };
}
/** Modern steel tower: two slightly tapering legs and three portal beams. */
function tower(cx, top, bottom, legW = 11, gap = 30) {
  const out = [];
  for (const s of [-1, 1]) {
    const xi = cx + s * gap / 2, xo = cx + s * (gap / 2 + legW), xoT = cx + s * (gap / 2 + legW - 3);
    out.push(`M${f1(xi)} ${f1(bottom)} L${f1(xi)} ${f1(top)} L${f1(xoT)} ${f1(top)} L${f1(xo)} ${f1(bottom)} Z`);
  }
  for (const l of [0, 0.36, 0.7]) { const y = top + (bottom - top) * l; out.push(`M${f1(cx - gap / 2)} ${f1(y)} H${f1(cx + gap / 2)} V${f1(y + 8)} H${f1(cx - gap / 2)} Z`); }
  return out.join(' ');
}
function cables(g, step) {
  let main = `M${g.t1} ${f1(g.cableTop)}`, l = `M${g.t1} ${f1(g.cableTop)}`, r = `M${g.t2} ${f1(g.cableTop)}`, susp = '';
  for (let x = g.t1; x <= g.t2; x += step) main += ` L${f1(x)} ${f1(g.mainY(x))}`;
  for (let x = g.t1; x >= g.anchorL; x -= step) l += ` L${f1(x)} ${f1(g.sideY(x, g.t1, g.anchorL))}`;
  for (let x = g.t2; x <= g.anchorR; x += step) r += ` L${f1(x)} ${f1(g.sideY(x, g.t2, g.anchorR))}`;
  for (let x = g.t1 + step * 2; x < g.t2 - step; x += step * 2) susp += `M${x} ${f1(g.mainY(x))} V${g.deck}`;
  return { main, l, r, susp };
}
/** Mosque on a base line y: prayer hall, drum + main dome, half domes, four minarets (pencil tips, balconies). */
function mosque(cx, y, k = 1) {
  const w = 110 * k, h = 34 * k, R = 34 * k, r = 20 * k, parts = [];
  parts.push(`M${f1(cx - w)} ${f1(y)} V${f1(y - h)} H${f1(cx + w)} V${f1(y)} Z`);
  parts.push(`M${f1(cx - R)} ${f1(y - h)} V${f1(y - h - 10 * k)} A${f1(R)} ${f1(R * 0.95)} 0 0 1 ${f1(cx + R)} ${f1(y - h - 10 * k)} V${f1(y - h)} Z`);
  parts.push(`M${f1(cx)} ${f1(y - h - 10 * k - R * 0.95)} v${f1(-12 * k)}`);
  for (const s of [-1, 1]) {
    const hx = cx + s * (R + r * 0.9);
    parts.push(`M${f1(hx - r)} ${f1(y - h)} A${f1(r)} ${f1(r)} 0 0 1 ${f1(hx + r)} ${f1(y - h)} Z`);
    for (const m of [w * 0.92, w * 1.18]) {
      const mx = cx + s * m, top = y - (m > w ? 150 : 175) * k, mw = 3.2 * k;
      parts.push(`M${f1(mx - mw)} ${f1(y)} V${f1(top)} L${f1(mx)} ${f1(top - 22 * k)} L${f1(mx + mw)} ${f1(top)} V${f1(y)} Z`);
      for (const b of [0.42, 0.7]) { const by = y - (y - top) * b; parts.push(`M${f1(mx - mw - 3 * k)} ${f1(by)} H${f1(mx + mw + 3 * k)} V${f1(by + 3 * k)} H${f1(mx - mw - 3 * k)} Z`); }
    }
  }
  return parts.join(' ');
}
/** Galata Kulesi: round stone shaft, gallery, conical roof. */
function galata(cx, y, k = 1) {
  const w = 12 * k, h = 70 * k;
  return `M${f1(cx - w)} ${f1(y)} V${f1(y - h)} H${f1(cx - w - 3 * k)} V${f1(y - h - 5 * k)} H${f1(cx + w + 3 * k)} V${f1(y - h)} H${f1(cx + w)} V${f1(y)} Z `
    + `M${f1(cx - w - 1 * k)} ${f1(y - h - 5 * k)} L${f1(cx)} ${f1(y - h - 34 * k)} L${f1(cx + w + 1 * k)} ${f1(y - h - 5 * k)} Z`;
}

/** Menu background silhouette (src/ui/menu.js; same layers and classes as goldenGateSceneSVG). */
export function sceneSVG(VB) {
  const W = VB.w, water = VB.water;
  const g = bridge({ water, deck: 262, towerTop: 70, t1: 400, t2: 900, anchorL: 250, anchorR: 1040 });
  const c = cables(g, 6);
  let streaks = '';
  for (let i = 0; i < 22; i++) {
    const y = water + 5 + i * i * 0.5 + i * 2.2, w = 30 + i * 8 + (i % 3) * 16, cx = VB.sunX + ((i * 37) % 29) - 14;
    streaks += `<rect class="gm-streak" style="animation-delay:${((i * 0.41) % 3).toFixed(2)}s" x="${f1(cx - w / 2)}" y="${f1(y)}" width="${f1(w)}" height="${f1(1.3 + i * 0.1)}" rx="1"/>`;
  }
  return `<svg class="gm-scene" viewBox="0 0 ${W} ${VB.h}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
  <defs>
    <linearGradient id="gmWater" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2f48"/><stop offset=".25" stop-color="#141c30"/><stop offset="1" stop-color="#060a14"/></linearGradient>
    <linearGradient id="gmFog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3d4c0" stop-opacity="0"/><stop offset=".45" stop-color="#f0cdb8" stop-opacity=".35"/><stop offset="1" stop-color="#c9b3b2" stop-opacity="0"/></linearGradient>
    <linearGradient id="gmRim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff7a45" stop-opacity="0"/><stop offset=".45" stop-color="#ffb070" stop-opacity=".95"/><stop offset="1" stop-color="#ff7a45" stop-opacity="0"/></linearGradient>
  </defs>
  <path class="gm-far" d="M0 ${water - 44} C 90 ${water - 60}, 200 ${water - 64}, 300 ${water - 48} L 330 ${water} L0 ${water} Z"/>
  <path class="gm-far" d="M960 ${water} C 1040 ${water - 40}, 1120 ${water - 58}, 1230 ${water - 60} S 1450 ${water - 50}, 1600 ${water - 64} L1600 ${water} Z"/>
  <g class="gm-fog gm-fog-back"><rect x="-200" y="${water - 50}" width="2200" height="62" fill="url(#gmFog)"/></g>
  <path class="gm-city" d="${mosque(1330, water - 88, 1)} ${galata(1085, water - 56, 1)}"/>
  <path class="gm-near" d="M0 ${water - 76} C 70 ${water - 92}, 170 ${water - 86}, 250 ${water - 58} S 320 ${water - 10}, 360 ${water} L0 ${water} Z"/>
  <path class="gm-near" d="M1000 ${water} C 1040 ${water - 30}, 1080 ${water - 56}, 1140 ${water - 62} C 1220 ${water - 74}, 1260 ${water - 90}, 1340 ${water - 92} S 1500 ${water - 96}, 1600 ${water - 110} L1600 ${water} Z"/>
  <g class="gm-bridge">
    <path class="gm-tower" d="${tower(g.t1, g.towerTop, water + 4, 12, 30)}"/>
    <path class="gm-tower" d="${tower(g.t2, g.towerTop, water + 4, 12, 30)}"/>
    <path d="M${g.anchorL - 90} ${g.deck + 26} L${g.anchorL} ${g.deck} H${g.anchorR} L${g.anchorR + 70} ${g.deck + 24} V${g.deck + 30} L${g.anchorR} ${g.deck + 8} H${g.anchorL} L${g.anchorL - 90} ${g.deck + 33} Z"/>
    <path class="gm-cable" d="${c.main}"/><path class="gm-cable" d="${c.l}"/><path class="gm-cable" d="${c.r}"/>
    <path class="gm-susp" d="${c.susp}"/>
    <path class="gm-rim" d="M${g.anchorL} ${g.deck + 0.5} H${g.anchorR}" stroke="url(#gmRim)"/>
  </g>
  <rect x="-400" y="${water}" width="${W + 800}" height="${VB.h - water + 600}" fill="url(#gmWater)"/>
  <g class="gm-streaks">${streaks}</g>
  <g class="gm-fog gm-fog-front"><rect x="-200" y="${water - 18}" width="2200" height="34" fill="url(#gmFog)"/></g>
</svg>`;
}

/** Loading-screen line art (src/ui/loading.js; same classes as goldenGateLineSVG: drawn on stroke by stroke). */
export function lineSVG() {
  const W = 1600, water = 330;
  const g = bridge({ water, deck: 258, towerTop: 70, t1: 520, t2: 1040, anchorL: 360, anchorR: 1200 });
  const c = cables(g, 8);
  const parts = [
    `<path class="gg-hill" d="M0 ${water - 36} C 90 ${water - 96}, 220 ${water - 120}, 330 ${water - 92} S 430 ${water - 40}, 480 ${water}"/>`,
    `<path class="gg-hill gg-far" d="M1120 ${water} C 1180 ${water - 40}, 1260 ${water - 70}, 1360 ${water - 74} S 1520 ${water - 60}, 1600 ${water - 70}"/>`,
    `<path class="gg-city" d="${mosque(1400, water - 70, 0.62)}"/>`,
    `<path class="gg-deck" d="M${g.anchorL - 70} ${g.deck + 20} L${g.anchorL} ${g.deck} H${g.anchorR} L${g.anchorR + 60} ${g.deck + 20}"/>`,
    `<path class="gg-truss" d="M${g.anchorL} ${g.deck + 6} H${g.anchorR}"/>`,
    `<path class="gg-tower" d="${tower(g.t1, g.towerTop, water)}"/>`,
    `<path class="gg-tower" d="${tower(g.t2, g.towerTop, water)}"/>`,
    `<path class="gg-pier" d="M${g.t1 - 28} ${water} h56 M${g.t2 - 28} ${water} h56"/>`,
    `<path class="gg-cable" d="${c.main}"/><path class="gg-cable" d="${c.l}"/><path class="gg-cable" d="${c.r}"/>`,
    `<path class="gg-susp" d="${c.susp}"/>`,
    `<path class="gg-water" d="M0 ${water} H${W} M180 ${water + 16} H560 M760 ${water + 14} H1260 M420 ${water + 30} H900 M1100 ${water + 28} H1480"/>`,
  ];
  let lights = '';
  for (let i = 1; i < 12; i++) { const x = g.t1 + (g.t2 - g.t1) * i / 12; lights += `<circle class="gg-light" style="animation-delay:${(i * 0.37) % 2.2}s" cx="${f1(x)}" cy="${f1(g.mainY(x))}" r="2.2"/>`; }
  lights += `<circle class="gg-beacon" cx="${g.t1}" cy="${g.towerTop - 6}" r="3"/><circle class="gg-beacon" style="animation-delay:.6s" cx="${g.t2}" cy="${g.towerTop - 6}" r="3"/>`;
  return `<svg class="gg-line" viewBox="0 0 ${W} 380" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts.join('')}${lights}</svg>`;
}
