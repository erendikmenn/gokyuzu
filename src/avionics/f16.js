// F-16C Block 50 displays: HUD, left MFD (FCR, RWS B-scope), right MFD (HSD), DED (UFC data entry display), RWR scope.
import { font, text, line, poly, circle, clamp, wrap360, wrap180, pad, DEG, NM, FT, clockUTC } from './core.js';
import { MapView, drawRunways, traffic, clockSeconds, STEERPOINTS, steerpoint, bearingTo, distTo } from './nav.js';
import { localToLonLat } from '../geo.js';
import { createHud } from './hud.js';

export const FC = { green: '#3dff5c', dim: '#1f8a33', white: '#ffffff', cyan: '#44d8ff', yellow: '#ffe640', red: '#ff3b30', amber: '#ffae00' };

/** OSB label frame for 4" MFDs (virtual 1000×1000). labels: { top, bottom, left, right }, selected label is inverse video. */
export function drawOsb(g, labels, selected = '', color = FC.green) {
  g.font = font(34); g.textBaseline = 'alphabetic';
  const put = (s, x, y, align) => {
    if (!s) return;
    const lines = s.split('\n');
    lines.forEach((ln, i) => {
      const yy = y + (i - (lines.length - 1) / 2) * 36;
      if (ln === selected) {
        g.font = font(34); const w = g.measureText(ln).width;
        const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
        g.fillStyle = color; g.fillRect(x0 - 6, yy - 30, w + 12, 38);
        text(g, ln, x, yy, '#000', align);
      } else text(g, ln, x, yy, color, align);
    });
  };
  (labels.top || []).forEach((s, i) => put(s, 190 + i * 155, 52, 'center'));
  (labels.bottom || []).forEach((s, i) => put(s, 190 + i * 155, 976, 'center'));
  (labels.left || []).forEach((s, i) => put(s, 14, 212 + i * 146, 'left'));
  (labels.right || []).forEach((s, i) => put(s, 986, 212 + i * 146, 'right'));
}

// ---------------------------------------------------------------- FCR (RWS B-scope)
function f16Fcr(env) {
  const X0 = 120, X1 = 880, Y0 = 110, Y1 = 880, CXs = 500;
  const mem = new Map();
  const frame = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    drawOsb(g, { top: ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL'], bottom: ['SWAP', 'FCR', 'DTE', 'WPN', 'SMS'], left: ['▲', '', '▼', 'A6', '4B'], right: ['', '', '', '', ''] }, 'FCR');
    g.strokeStyle = FC.green; g.lineWidth = 3;
    // azimuth ticks (bottom) and range ticks (sides)
    for (const a of [-60, -30, 0, 30, 60]) { const x = CXs + a / 60 * (X1 - CXs); line(g, x, Y1, x, Y1 - (a === 0 ? 30 : 18)); }
    for (const f of [0.25, 0.5, 0.75]) { const y = Y1 - f * (Y1 - Y0); line(g, X0, y, X0 + 20, y); line(g, X1, y, X1 - 20, y); }
    for (const f of [0.25, 0.5, 0.75]) for (const a of [-30, 0, 30]) {
      const x = CXs + a / 60 * (X1 - CXs), y = Y1 - f * (Y1 - Y0);
      line(g, x - 6, y, x + 6, y); line(g, x, y - 6, x, y + 6);
    }
  });
  return (g, S, ctx) => {
    frame.blit(g);
    const range = S.alt > 15000 ? 40 : 20;
    text(g, String(range), 14, 358, FC.green, 'left', font(34));
    const t = clockSeconds();
    const ph = (t * 60) % 240, antAz = ph < 120 ? -60 + ph : 180 - ph;
    const antEl = clamp(-S.pitch * 0.4, -10, 10);
    // horizon line
    g.save(); g.beginPath(); g.rect(X0, Y0, X1 - X0, Y1 - Y0); g.clip();
    g.translate(CXs, (Y0 + Y1) / 2 + clamp(S.pitch * 7, -300, 300)); g.rotate(-S.roll * DEG);
    g.strokeStyle = FC.cyan; g.lineWidth = 3; line(g, -330, 0, -60, 0); line(g, 60, 0, 330, 0);
    line(g, -330, 0, -330, 16); line(g, 330, 0, 330, 16);
    g.restore();
    // targets (sweep-refreshed, fading)
    for (const o of traffic(t)) {
      const az = wrap180(bearingTo(S.x, S.z, o.x, o.z) - S.hdg), r = distTo(S.x, S.z, o.x, o.z) / NM;
      let m = mem.get(o.id);
      if (!m) { m = { x: 0, y: 0, seen: -99, alt: 0 }; mem.set(o.id, m); }
      if (Math.abs(az) < 60 && r < range && Math.abs(az - antAz) < 4) { m.x = CXs + az / 60 * (X1 - CXs); m.y = Y1 - r / range * (Y1 - Y0); m.seen = t; m.alt = o.alt * FT; m.hdg = o.hdg; }
      const age = t - m.seen;
      if (age < 6) {
        g.globalAlpha = clamp(1 - age / 6, 0, 1);
        g.fillStyle = o.kind === 'hostile' ? FC.yellow : FC.green;
        g.fillRect(m.x - 12, m.y - 7, 24, 14);
        text(g, pad(Math.round(m.alt / 1000), 2), m.x + 18, m.y + 22, g.fillStyle, 'left', font(22));
        g.globalAlpha = 1;
      }
    }
    // antenna carets
    g.strokeStyle = FC.green; g.lineWidth = 3.5;
    const ax = CXs + antAz / 60 * (X1 - CXs);
    line(g, ax, Y1 + 6, ax, Y1 + 30); line(g, ax - 12, Y1 + 30, ax + 12, Y1 + 30);
    const ey = (Y0 + Y1) / 2 - antEl * 20;
    line(g, X0 - 6, ey, X0 - 30, ey); line(g, X0 - 30, ey - 12, X0 - 30, ey + 12);
    // acquisition cursor
    const cy = Y1 - 0.45 * (Y1 - Y0), cx = CXs + 60;
    line(g, cx - 8, cy - 22, cx - 8, cy + 22); line(g, cx + 8, cy - 22, cx + 8, cy + 22);
    text(g, pad(Math.round(S.alt / 1000) + 12, 2), cx + 24, cy - 6, FC.green, 'left', font(24));
    text(g, pad(Math.max(0, Math.round(S.alt / 1000) - 8), 2), cx + 24, cy + 22, FC.green, 'left', font(24));
    // ownship data
    text(g, S.mach.toFixed(2), X0 + 10, Y0 + 30, FC.green, 'left', font(26));
    text(g, pad(Math.round(S.hdgMag), 3), CXs, Y0 + 30, FC.green, 'center', font(26));
  };
}

// ---------------------------------------------------------------- HSD (heading-up, depressed)
function f16Hsd(env) {
  const OX = 500, OY = 640, R1 = 390;
  const view = new MapView();
  const frame = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    drawOsb(g, { top: ['DEP', 'DCPL', 'NORM', '', 'CNTL'], bottom: ['SWAP', 'HSD', 'FCR', 'WPN', 'SMS'], left: ['▲', '', '▼', '', ''], right: ['', '', '', 'FRZ', ''] }, 'HSD');
  });
  return (g, S, ctx) => {
    frame.blit(g);
    const range = S.alt > 20000 ? 40 : 20;
    text(g, String(range), 14, 358, FC.green, 'left', font(34));
    const k = R1 / (range * NM);
    view.set(OX, OY, S.x, S.z, S.hdg, k);
    g.save(); g.beginPath(); g.rect(70, 80, 860, 850); g.clip();
    // rings + compass
    g.strokeStyle = FC.cyan; g.lineWidth = 2.5;
    for (const r of [R1 / 3, R1 * 2 / 3, R1]) { circle(g, OX, OY, r); g.stroke(); }
    g.lineWidth = 3;
    for (let d = 0; d < 360; d += 30) {
      const a = (d - S.hdg) * DEG, s = Math.sin(a), c = Math.cos(a);
      line(g, OX + s * R1, OY - c * R1, OX + s * (R1 - 22), OY - c * (R1 - 22));
      if (d === 0) { g.fillStyle = FC.cyan; poly(g, [OX + s * (R1 + 4), OY - c * (R1 + 4), OX + s * (R1 + 30) - c * 10, OY - c * (R1 + 30) - s * 10, OX + s * (R1 + 30) + c * 10, OY - c * (R1 + 30) + s * 10]); g.fill(); }
    }
    // runways + airports
    drawRunways(g, ctx.nav, view, FC.green, 4);
    for (const a of ctx.nav.airports) { view.project(a.x, a.z); text(g, a.icao, view.px + 26, view.py - 20, FC.green, 'left', font(24)); }
    // route
    const sp = steerpoint(ctx.flight, S.x, S.z);
    g.strokeStyle = FC.white; g.lineWidth = 3; g.beginPath();
    STEERPOINTS.forEach((p, i) => { view.project(p.x, p.z); if (i) g.lineTo(view.px, view.py); else g.moveTo(view.px, view.py); });
    view.project(STEERPOINTS[0].x, STEERPOINTS[0].z); g.lineTo(view.px, view.py); g.stroke();
    STEERPOINTS.forEach((p, i) => {
      view.project(p.x, p.z);
      g.fillStyle = '#000'; circle(g, view.px, view.py, 11); g.fill(); g.stroke();
      if (i === sp.i) { g.fillStyle = FC.white; circle(g, view.px, view.py, 6); g.fill(); }
    });
    // tracks
    for (const o of traffic(clockSeconds())) {
      view.project(o.x, o.z); const x = view.px, y = view.py;
      const hostile = o.kind === 'hostile';
      g.strokeStyle = hostile ? FC.red : o.kind === 'fighter' ? FC.green : FC.yellow; g.lineWidth = 3;
      if (hostile) { poly(g, [x, y - 13, x + 12, y + 9, x - 12, y + 9]); g.stroke(); }
      else if (o.kind === 'fighter') { circle(g, x, y, 11); g.stroke(); }
      else g.strokeRect(x - 9, y - 9, 18, 18);
      const va = (o.hdg - S.hdg) * DEG; line(g, x, y, x + Math.sin(va) * 34, y - Math.cos(va) * 34);
    }
    g.restore();
    // ownship
    g.strokeStyle = FC.cyan; g.fillStyle = FC.cyan; g.lineWidth = 4;
    line(g, OX, OY - 26, OX, OY + 22); line(g, OX - 22, OY - 4, OX + 22, OY - 4); line(g, OX - 10, OY + 20, OX + 10, OY + 20);
    // steerpoint readout
    const p = STEERPOINTS[sp.i];
    text(g, `${pad(Math.round(wrap360(bearingTo(S.x, S.z, p.x, p.z) - S.decl)), 3)}° ${(distTo(S.x, S.z, p.x, p.z) / NM).toFixed(0)}`, 880, 130, FC.green, 'right', font(28));
    text(g, 'STPT ' + p.n, 120, 130, FC.green, 'left', font(28));
  };
}

// ---------------------------------------------------------------- DED (UFC data entry display, 24×5 chars)
function f16Ded(env) {
  const COL = '#c7ff3a', COLS = 25, CW = 1000 / COLS, VH = env.vh, LH = VH / 5.2;
  let xScale = 1, measured = -1;
  const put = (g, row, col, s, inv = false) => {
    g.save(); g.translate(col * CW + 6, VH * 0.055 + row * LH + LH * 0.78); g.scale(xScale, 1);
    if (inv) { const w = s.length * CW / xScale; g.fillStyle = COL; g.fillRect(-2, -LH * 0.72, w, LH * 0.86); g.fillStyle = '#000'; }
    else g.fillStyle = COL;
    g.fillText(s, 0, 0); g.restore();
  };
  let lastStpt = -1, stptPageUntil = 0;
  return (g, S, ctx) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, VH);
    g.font = font(Math.round(LH * 0.84), true, true); g.textAlign = 'left';
    if (measured !== env.w) { const w = g.measureText('MMMMMMMMMM').width / 10; xScale = (CW * 0.97) / w; measured = env.w; }
    const sp = steerpoint(ctx.flight, S.x, S.z), p = STEERPOINTS[sp.i];
    if (sp.i !== lastStpt) { if (lastStpt >= 0) stptPageUntil = S.t + 8; lastStpt = sp.i; }
    if (S.t < stptPageUntil) {
      const ll = localToLonLat(p.x, p.z);
      const dm = (v, w) => { const a = Math.abs(v), d = Math.floor(a); return pad(d, w) + '°' + ((a - d) * 60).toFixed(3).padStart(6, '0') + "'"; };
      put(g, 0, 4, 'STPT'); put(g, 0, 9, '↕'); put(g, 0, 10, pad(p.n, 3), true); put(g, 0, 16, 'AUTO ↕');
      put(g, 1, 5, 'LAT  N ' + dm(ll.lat, 2));
      put(g, 2, 5, 'LNG  W' + dm(ll.lon, 3));
      put(g, 3, 4, 'ELEV    ' + String(Math.round(p.elev * FT)).padStart(5) + 'FT');
      const tos = new Date(Date.now() + (S.gs > 30 ? distTo(S.x, S.z, p.x, p.z) / NM / S.gs * 3600e3 : 0));
      put(g, 4, 5, 'TOS  ' + pad(tos.getUTCHours(), 2) + ':' + pad(tos.getUTCMinutes(), 2) + ':' + pad(tos.getUTCSeconds(), 2));
    } else {
      put(g, 0, 0, 'UHF  292.30  STPT ↕' + String(p.n).padStart(3));
      put(g, 1, 16, clockUTC());
      put(g, 2, 0, 'VHF  1');
      put(g, 3, 0, ' M1 3 C 6400  MAN  T 75X');
      if (S.warn.gear || S.warn.pullUp || S.warn.stall) put(g, 4, 0, S.warn.pullUp ? ' ** PULL UP **' : S.warn.stall ? ' ** AOA **' : ' ** GEAR **', Math.floor(S.t * 2) % 2 === 0);
    }
  };
}

// ---------------------------------------------------------------- RWR azimuth indicator
const EMITTERS = [
  { sym: 'S', x: -51, z: 49, lethal: 0 },          // SFO airport surveillance radar
  { sym: 'S', x: 13595, z: -11860, lethal: 0 },    // Oakland ASR
  { sym: 'U', x: -5900, z: -17300, lethal: 1 },    // Sutro tower
  { sym: 'A', x: -10300, z: -24400, lethal: 2 },   // headlands (exercise AAA)
];
function f16Rwr(env) {
  const C = 500, RO = 440;
  const frame = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    g.strokeStyle = FC.dim; g.lineWidth = 3;
    circle(g, C, C, RO); g.stroke();
    circle(g, C, C, RO * 0.5); g.stroke();
    g.setLineDash([10, 14]); circle(g, C, C, RO * 0.75); g.stroke(); g.setLineDash([]);
    g.strokeStyle = FC.green;
    for (let a = 0; a < 360; a += 30) {
      const s = Math.sin(a * DEG), c = Math.cos(a * DEG), l = a % 90 === 0 ? 34 : 20;
      line(g, C + s * RO, C - c * RO, C + s * (RO - l), C - c * (RO - l));
    }
    line(g, C - 18, C, C + 18, C); line(g, C, C - 18, C, C + 18);
  });
  return (g, S) => {
    frame.blit(g);
    const t = clockSeconds();
    const list = [];
    for (const e of EMITTERS) list.push({ sym: e.sym, x: e.x, z: e.z, air: false, lethal: e.lethal });
    for (const o of traffic(t)) if (o.kind === 'fighter' || o.kind === 'hostile') list.push({ sym: o.kind === 'hostile' ? '29' : '16', x: o.x, z: o.z, air: true, lethal: o.kind === 'hostile' ? 3 : 1 });
    let pri = null, best = -1;
    for (const e of list) { e.d = distTo(S.x, S.z, e.x, e.z) / NM; const sc = e.lethal * 10 - e.d; if (sc > best) { best = sc; pri = e; } }
    g.textAlign = 'center';
    const placed = [];
    for (const e of list) {
      if (e.d > 60) continue;
      const rel = wrap180(bearingTo(S.x, S.z, e.x, e.z) - S.hdg) * DEG;
      let r = clamp(RO * (e.lethal >= 2 ? 0.3 : 0.55) + e.d * 5, 60, RO - 40);
      let x = C + Math.sin(rel) * r, y = C - Math.cos(rel) * r;
      for (let k = 0; k < 6 && placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 70); k++) {
        r = r > 200 ? r - 70 : r + 70; x = C + Math.sin(rel) * r; y = C - Math.cos(rel) * r;
      }
      placed.push([x, y]);
      const col = e.lethal >= 3 ? FC.red : FC.green;
      text(g, e.sym, x, y + 16, col, 'center', font(48));
      g.strokeStyle = col; g.lineWidth = 3.5;
      if (e.air) poly(g, [x - 24, y - 26, x, y - 44, x + 24, y - 26], false), g.stroke();
      if (e === pri && Math.floor(t * 2) % 2 === 0) { poly(g, [x, y - 50, x + 44, y, x, y + 50, x - 44, y]); g.stroke(); }
    }
    text(g, 'PRI', 70, 970, FC.green, 'left', font(34));
    text(g, 'SEARCH', 930, 970, FC.green, 'right', font(34));
  };
}

export const F16 = {
  'f16.hud': { vw: 1140, vh: 1000, size: 1024, transparent: true, create: (env) => createHud(env, 'f16') },
  'f16.mfd.left': { vw: 1000, vh: 1000, size: 512, create: f16Fcr },
  'f16.mfd.right': { vw: 1000, vh: 1000, size: 512, hz: 15, create: f16Hsd },
  'f16.ded': { vw: 1000, vh: 372, size: 512, hz: 4, create: f16Ded },
  'f16.rwr': { vw: 1000, vh: 1000, size: 512, hz: 15, create: f16Rwr },
};
