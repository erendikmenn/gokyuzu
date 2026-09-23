// UH-60M Black Hawk CAAS multifunction displays (6×8" portrait, virtual 750×1000):
// flight page (attitude, tapes, radar altitude, TRQ/NR, HSI), moving map, engine page (VIDS-style vertical scales).
import { font, text, line, poly, circle, rrect, clamp, wrap360, wrap180, pad, DEG, NM, FT, smoothK } from './core.js';
import { MapView, drawRunways, terrainGrid, reliefFor, LocalRelief, traffic, clockSeconds, nearestAirport, pickDestination, bearingTo, distTo, LANDMARKS } from './nav.js';

export const HC = { white: '#ffffff', green: '#35ff5a', cyan: '#35e1ff', magenta: '#ff54ff', yellow: '#ffe23a', amber: '#ffae00', red: '#ff3434', grey: '#8d969f', tape: '#3d434a', sky: '#1f86d8', gnd: '#7c4f25' };
const W = 750, H = 1000;

function tabs(g, sel) {
  const names = ['PFD', 'ND', 'ENG', 'FUEL', 'SYS'];
  g.font = font(26);
  names.forEach((s, i) => {
    const x = 75 + i * 150;
    if (s === sel) { g.fillStyle = HC.cyan; g.fillRect(x - 52, 966, 104, 32); text(g, s, x, 991, '#000', 'center'); }
    else text(g, s, x, 991, HC.cyan, 'center');
  });
}

// ---------------------------------------------------------------- flight page
function uh60Pfd(env) {
  const CX = 375, CY = 395, PPD = 8.5;
  const SP = { x0: 8, x1: 104, y0: 190, y1: 600, k: 4 };
  const AL = { x0: 646, x1: 742, y0: 190, y1: 600, k: 0.5 };
  const HS = { cx: 375, cy: 812, r: 140 };
  const st = { trq: [0, 0] };
  const under = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = HC.tape; g.fillRect(SP.x0, SP.y0, SP.x1 - SP.x0, SP.y1 - SP.y0); g.fillRect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0);
    // top engine strip
    g.strokeStyle = HC.grey; g.lineWidth = 2.5; line(g, 10, 130, 740, 130);
    text(g, 'TRQ', 30, 40, HC.white, 'left', font(26)); text(g, 'NR', 520, 40, HC.white, 'left', font(26));
    text(g, '1', 60, 116, HC.grey, 'center', font(22)); text(g, '2', 190, 116, HC.grey, 'center', font(22));
    tabs(g, 'PFD');
  });
  const over = env.layer((g) => {
    g.strokeStyle = HC.yellow; g.lineWidth = 5;
    line(g, CX - 120, CY, CX - 50, CY); line(g, CX - 50, CY, CX - 35, CY + 16); line(g, CX + 120, CY, CX + 50, CY); line(g, CX + 50, CY, CX + 35, CY + 16);
    g.fillStyle = HC.yellow; g.fillRect(CX - 5, CY - 5, 10, 10);
    // bank scale
    const R = 185; g.strokeStyle = HC.white; g.lineWidth = 3;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const c = Math.cos((a - 90) * DEG), s = Math.sin((a - 90) * DEG), l = a % 30 === 0 ? 22 : 12;
      line(g, CX + c * R, CY + s * R, CX + c * (R + l), CY + s * (R + l));
    }
    // readout boxes
    g.fillStyle = '#000'; g.strokeStyle = HC.white; g.lineWidth = 3;
    poly(g, [SP.x0, CY - 26, SP.x1 - 4, CY - 26, SP.x1 + 12, CY, SP.x1 - 4, CY + 26, SP.x0, CY + 26]); g.fill(); g.stroke();
    poly(g, [AL.x0 - 14, CY, AL.x0 + 2, CY - 26, AL.x1, CY - 26, AL.x1, CY + 26, AL.x0 + 2, CY + 26]); g.fill(); g.stroke();
    // HSI lubber
    g.fillStyle = HC.white; poly(g, [HS.cx, HS.cy - HS.r + 4, HS.cx - 10, HS.cy - HS.r - 14, HS.cx + 10, HS.cy - HS.r - 14]); g.fill();
    g.strokeStyle = HC.white; g.lineWidth = 3.5;
    line(g, HS.cx, HS.cy - 22, HS.cx, HS.cy + 26); line(g, HS.cx - 22, HS.cy - 4, HS.cx + 22, HS.cy - 4); line(g, HS.cx - 10, HS.cy + 22, HS.cx + 10, HS.cy + 22);
  });
  return (g, S, ctx) => {
    under.blit(g);
    const k = smoothK(S.dt, 0.6);
    for (let i = 0; i < 2; i++) {
      const e = S.engines[i], tq = e && Number.isFinite(e.torque) ? e.torque : (S.torque || (e ? e.n1 * 0.8 : 0)) * (i ? 0.985 : 1);
      st.trq[i] += (tq - st.trq[i]) * k;
    }
    // TRQ / NR digital
    for (let i = 0; i < 2; i++) {
      const v = st.trq[i], c = v > 100 || S.warn.overtorque ? HC.red : v > 90 ? HC.yellow : HC.green;
      g.strokeStyle = HC.white; g.lineWidth = 2.5; g.strokeRect(20 + i * 130, 52, 120, 50);
      text(g, String(Math.round(v)), 130 + i * 130, 94, c, 'right', font(42));
    }
    const nr = S.rotorRPM || 0;
    g.strokeRect(510, 52, 120, 50);
    text(g, String(Math.round(nr)), 620, 94, nr > 107 || (nr < 91 && nr > 5) || S.warn.lowRotor || S.warn.highRotor ? HC.red : HC.green, 'right', font(42));
    text(g, '%', 640, 94, HC.grey, 'left', font(24));
    text(g, S.onGround ? 'GND' : S.gs < 20 && S.agl < 200 ? 'HOVER' : 'CRZ', 375, 94, HC.cyan, 'center', font(30));
    // attitude
    g.save(); rrect(g, 118, 180, 514, 430, 30); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const py = S.pitch * PPD;
    g.fillStyle = HC.sky; g.fillRect(-700, -1500 + py, 1400, 1500);
    g.fillStyle = HC.gnd; g.fillRect(-700, py, 1400, 1500);
    g.strokeStyle = HC.white; g.lineWidth = 3; line(g, -700, py, 700, py);
    g.font = font(24); g.fillStyle = HC.white; g.textAlign = 'center';
    for (let i = Math.ceil((S.pitch - 22) / 5); i <= Math.floor((S.pitch + 22) / 5); i++) {
      if (!i) continue;
      const a = i * 5, y = (S.pitch - a) * PPD, w = i % 2 === 0 ? 70 : 34;
      line(g, -w, y, w, y);
      if (i % 2 === 0) { g.fillText(String(Math.abs(a)), -w - 26, y + 8); g.fillText(String(Math.abs(a)), w + 26, y + 8); }
    }
    g.fillStyle = HC.white; poly(g, [0, -185, -11, -166, 11, -166]); g.fill();
    g.fillRect(-14 + clamp(S.beta * 3, -26, 26), -160, 28, 8);
    g.restore();
    over.blit(g);
    // radar altitude
    if (S.radioAlt < 1500) {
      const v = S.radioAlt < 200 ? Math.round(S.radioAlt) : Math.round(S.radioAlt / 10) * 10;
      g.fillStyle = '#000'; g.fillRect(CX - 70, 522, 140, 48); g.strokeStyle = HC.white; g.lineWidth = 2.5; g.strokeRect(CX - 70, 522, 140, 48);
      text(g, v + ' R', CX + 56, 559, S.radioAlt < 50 && !S.onGround ? HC.yellow : HC.green, 'right', font(34));
    }
    // speed tape
    const ias = S.ias;
    g.save(); g.beginPath(); g.rect(SP.x0, SP.y0, SP.x1 - SP.x0, SP.y1 - SP.y0); g.clip();
    g.strokeStyle = HC.white; g.lineWidth = 3; g.font = font(26); g.fillStyle = HC.white; g.textAlign = 'right';
    for (let v = Math.max(0, Math.floor((ias - 55) / 5) * 5); v <= ias + 55; v += 5) {
      const y = CY - (v - ias) * SP.k;
      line(g, SP.x1 - (v % 10 === 0 ? 16 : 9), y, SP.x1, y);
      if (v % 20 === 0) g.fillText(String(v), SP.x1 - 20, y + 9);
    }
    g.restore();
    g.fillStyle = '#000'; g.fillRect(SP.x0 + 3, CY - 23, SP.x1 - SP.x0 - 8, 46);
    text(g, S.ias < 20 ? '--' : String(Math.round(S.ias)), SP.x1 - 10, CY + 13, HC.white, 'right', font(38));
    text(g, 'KIAS', 56, 180, HC.grey, 'center', font(22));
    text(g, 'GS ' + Math.round(S.gs), 56, 632, HC.white, 'center', font(26));
    // altitude tape
    g.save(); g.beginPath(); g.rect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0); g.clip();
    g.strokeStyle = HC.white; g.lineWidth = 3; g.font = font(24); g.fillStyle = HC.white; g.textAlign = 'right';
    for (let a = Math.floor((S.alt - 450) / 50) * 50; a <= S.alt + 450; a += 50) {
      const y = CY - (a - S.alt) * AL.k;
      line(g, AL.x0, y, AL.x0 + (a % 100 === 0 ? 16 : 9), y);
      if (a % 200 === 0) g.fillText(String(a), AL.x1 - 4, y + 9);
    }
    const gy = CY - (S.alt - S.agl - S.alt) * AL.k;
    if (gy < AL.y1) {
      g.fillStyle = '#5a3a14'; g.fillRect(AL.x0, gy, AL.x1 - AL.x0, AL.y1 - gy);
      g.strokeStyle = '#c08a3a'; g.lineWidth = 3; line(g, AL.x0, gy, AL.x1, gy);
      g.lineWidth = 2; for (let yy = gy + 14; yy < AL.y1 + 40; yy += 18) line(g, AL.x0, yy, AL.x0 + 30, yy - 30);
    }
    g.restore();
    g.fillStyle = '#000'; g.fillRect(AL.x0 + 5, CY - 23, AL.x1 - AL.x0 - 8, 46);
    text(g, String(Math.round(S.alt / 10) * 10), AL.x1 - 6, CY + 13, HC.white, 'right', font(34));
    text(g, 'FT', 694, 180, HC.grey, 'center', font(22));
    text(g, (S.vs >= 0 ? '↑' : '↓') + Math.abs(Math.round(S.vs / 50) * 50), 694, 632, Math.abs(S.vs) > 2000 ? HC.yellow : HC.white, 'center', font(26));
    // HSI
    g.save(); g.translate(HS.cx, HS.cy);
    g.strokeStyle = HC.white; g.lineWidth = 3; circle(g, 0, 0, HS.r); g.stroke();
    g.rotate(-S.hdgMag * DEG);
    g.font = font(26); g.textAlign = 'center'; g.fillStyle = HC.white;
    for (let d = 0; d < 360; d += 5) {
      const s = Math.sin(d * DEG), c = Math.cos(d * DEG), l = d % 10 === 0 ? 18 : 10;
      line(g, s * HS.r, -c * HS.r, s * (HS.r - l), -c * (HS.r - l));
      if (d % 30 === 0) {
        g.save(); g.translate(s * (HS.r - 38), -c * (HS.r - 38)); g.rotate(d * DEG);
        g.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), 0, 9); g.restore();
      }
    }
    // course to the active waypoint (magenta) + bearing pointer to the nearest airport (cyan)
    const dest = pickDestination(ctx.nav, S.x, S.z, S.track), near = nearestAirport(ctx.nav, S.x, S.z);
    if (dest) {
      const b = wrap360(bearingTo(S.x, S.z, dest.x, dest.z) - S.decl);
      g.save(); g.rotate(b * DEG);
      g.strokeStyle = HC.magenta; g.fillStyle = HC.magenta; g.lineWidth = 5;
      line(g, 0, -HS.r + 30, 0, -40); poly(g, [0, -HS.r + 22, -12, -HS.r + 46, 12, -HS.r + 46]); g.fill();
      line(g, 0, 40, 0, HS.r - 30);
      g.restore();
    }
    if (near) {
      const b = wrap360(bearingTo(S.x, S.z, near.x, near.z) - S.decl);
      g.save(); g.rotate(b * DEG); g.strokeStyle = HC.cyan; g.lineWidth = 3;
      line(g, 0, -HS.r - 2, 0, -HS.r + 60); line(g, -8, -HS.r + 12, 0, -HS.r - 2); line(g, 8, -HS.r + 12, 0, -HS.r - 2);
      line(g, 0, HS.r + 2, 0, HS.r - 50);
      g.restore();
    }
    g.restore();
    g.fillStyle = '#000'; g.fillRect(HS.cx - 42, HS.cy - HS.r - 62, 84, 42);
    g.strokeStyle = HC.white; g.lineWidth = 2.5; g.strokeRect(HS.cx - 42, HS.cy - HS.r - 62, 84, 42);
    text(g, pad(Math.round(S.hdgMag) % 360, 3), HS.cx, HS.cy - HS.r - 29, HC.white, 'center', font(32));
    if (dest) {
      const d = distTo(S.x, S.z, dest.x, dest.z) / NM, ete = S.gs > 10 ? d / S.gs * 3600 : 0;
      text(g, dest.icao, 20, 700, HC.magenta, 'left', font(30));
      text(g, d.toFixed(1) + ' NM', 20, 740, HC.white, 'left', font(28));
      text(g, 'ETE ' + pad(Math.floor(ete / 60), 2) + ':' + pad(Math.floor(ete % 60), 2), 20, 780, HC.white, 'left', font(26));
    }
    if (near) { text(g, near.icao, 730, 700, HC.cyan, 'right', font(30)); text(g, (distTo(S.x, S.z, near.x, near.z) / NM).toFixed(1) + ' NM', 730, 740, HC.white, 'right', font(28)); }
    const sat = 15 - 1.98 * S.alt / 1000;
    text(g, 'OAT ' + Math.round(sat) + '°C', 730, 900, HC.white, 'right', font(24));
    text(g, 'BARO 29.92', 20, 900, HC.white, 'left', font(24));
    const flash = Math.floor(S.t * 2.5) % 2 === 0;
    if (S.warn.pullUp && flash) text(g, 'PULL UP', CX, 470, HC.red, 'center', font(48));
    else if (S.warn.lowRotor && flash) text(g, 'LOW ROTOR RPM', CX, 470, HC.red, 'center', font(40));
    else if (S.warn.overtorque) text(g, 'OVERTORQUE', CX, 470, HC.red, 'center', font(40));
    else if (S.warn.vrs) text(g, 'VRS', CX, 470, HC.yellow, 'center', font(44));
    else if (S.agl < 100 && S.vs < -800 && !S.onGround) text(g, 'LOW ALT', CX, 470, HC.yellow, 'center', font(40));
    if (S.warn.lowFuel) text(g, 'LOW FUEL', 730, 940, HC.yellow, 'right', font(26));
  };
}

// ---------------------------------------------------------------- moving map
function uh60Nd(env) {
  const OX = 375, OY = 640, R = 400;
  const view = new MapView();
  const local = new LocalRelief(384, 'chart');
  const frame = env.layer((g) => {
    g.fillStyle = 'rgba(0,0,0,0.8)'; g.fillRect(0, 0, W, 90); g.fillRect(0, 956, W, 44);
    tabs(g, 'ND');
  });
  return (g, S, ctx) => {
    g.fillStyle = '#0b1a2a'; g.fillRect(0, 0, W, H);
    const range = S.agl > 3000 || S.gs > 110 ? 10 : 5, k = R / (range * NM);
    view.set(OX, OY, S.x, S.z, S.hdg, k);
    const G = terrainGrid(ctx.world);
    if (G) {
      G.tick();
      local.update(ctx.world, S.x, S.z, range * NM * 1.45, 0.45);
      const rel = reliefFor(G, 'chart');
      g.save(); view.apply(g);
      if (rel && rel.hasContent) rel.draw(g);   // coarse whole-bay background
      local.draw(g);                            // sharp local relief on top
      g.restore();
    }
    drawRunways(g, ctx.nav, view, '#1a1a1a', 4, '#6e6e6e');
    // rings
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 2.5;
    g.setLineDash([12, 10]); circle(g, OX, OY, R / 2); g.stroke(); g.setLineDash([]);
    circle(g, OX, OY, R); g.stroke();
    g.font = font(24); g.textAlign = 'center'; g.fillStyle = HC.white;
    for (let d = 0; d < 360; d += 10) {
      const a = (d - S.hdgMag) * DEG, s = Math.sin(a), c = Math.cos(a), l = d % 30 === 0 ? 20 : 10;
      line(g, OX + s * R, OY - c * R, OX + s * (R - l), OY - c * (R - l));
      if (d % 30 === 0) g.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), OX + s * (R - 36), OY - c * (R - 36) + 8);
    }
    text(g, String(range / 2), OX + R / 2 * 0.72 + 8, OY - R / 2 * 0.7, HC.white, 'left', font(24));
    // labels
    g.font = font(24); g.textAlign = 'left';
    for (const a of ctx.nav.airports) {
      view.project(a.x, a.z);
      g.strokeStyle = HC.magenta; g.lineWidth = 3; circle(g, view.px, view.py, 12); g.stroke();
      text(g, a.icao, view.px + 16, view.py - 12, HC.magenta, 'left');
    }
    const placed = [];
    for (const l of LANDMARKS) {
      view.project(l.x, l.z);
      if (view.px < 0 || view.px > W || view.py < 90 || view.py > 950) continue;
      if (placed.some((p) => Math.abs(p[0] - view.px) < 150 && Math.abs(p[1] - view.py) < 34)) continue;
      placed.push([view.px, view.py]);
      g.fillStyle = '#111'; poly(g, [view.px, view.py - 10, view.px + 8, view.py + 6, view.px - 8, view.py + 6]); g.fill();
      text(g, l.name, view.px + 12, view.py + 6, '#111', 'left');
    }
    // route to destination
    const dest = pickDestination(ctx.nav, S.x, S.z, S.track);
    if (dest) { view.project(dest.x, dest.z); g.strokeStyle = HC.magenta; g.lineWidth = 4; line(g, OX, OY, view.px, view.py); }
    // traffic
    for (const o of traffic(clockSeconds())) {
      if (o.kind === 'hostile') continue;
      view.project(o.x, o.z); const x = view.px, y = view.py;
      const rel = Math.round((o.alt * FT - S.alt) / 100);
      if (Math.abs(rel) > 30) continue;
      g.fillStyle = Math.abs(rel) < 10 && Math.hypot(x - OX, y - OY) < R / 2 ? HC.amber : HC.cyan;
      poly(g, [x, y - 11, x + 9, y, x, y + 11, x - 9, y]); g.fill();
      text(g, (rel >= 0 ? '+' : '-') + pad(Math.abs(rel), 2), x, y - 16, g.fillStyle, 'center', font(22));
    }
    // ownship
    g.fillStyle = HC.white; g.strokeStyle = '#000'; g.lineWidth = 2;
    poly(g, [OX, OY - 30, OX + 7, OY - 8, OX + 30, OY, OX + 7, OY + 4, OX + 5, OY + 24, OX - 5, OY + 24, OX - 7, OY + 4, OX - 30, OY, OX - 7, OY - 8]); g.fill(); g.stroke();
    // hover / velocity vector
    if (S.gs > 2) {
      const va = (S.track - S.hdg) * DEG, vl = clamp(S.gs * 2.5, 10, 160);
      g.strokeStyle = HC.green; g.lineWidth = 4; line(g, OX, OY, OX + Math.sin(va) * vl, OY - Math.cos(va) * vl);
    }
    frame.blit(g);
    text(g, 'MAP', 20, 40, HC.cyan, 'left', font(28)); text(g, 'HDG UP', 20, 76, HC.white, 'left', font(24));
    g.fillStyle = '#000'; g.fillRect(OX - 44, 18, 88, 44); g.strokeStyle = HC.white; g.lineWidth = 2.5; g.strokeRect(OX - 44, 18, 88, 44);
    text(g, pad(Math.round(S.hdgMag) % 360, 3), OX, 52, HC.white, 'center', font(32));
    text(g, range + ' NM', 730, 40, HC.white, 'right', font(28));
    text(g, 'GS ' + Math.round(S.gs), 730, 76, HC.white, 'right', font(24));
    if (dest) text(g, `${dest.icao} ${(distTo(S.x, S.z, dest.x, dest.z) / NM).toFixed(1)}NM`, OX, 940, HC.magenta, 'center', font(26));
  };
}

// ---------------------------------------------------------------- engine page (vertical scales)
function uh60Eng(env) {
  const st = { trq: [0, 0], tgt: [0, 0], ng: [0, 0], nr: 0, np: [0, 0], ff: [0, 0] };
  const Y0 = 190, Y1 = 640;
  // [label, x positions, min, max, bands [[from,to,color]...]]
  const scales = [
    ['TRQ', [70, 130], 0, 140, [[0, 100, HC.green], [100, 120, HC.yellow], [120, 140, HC.red]]],
    ['TGT', [230, 290], 0, 1000, [[0, 810, HC.green], [810, 890, HC.yellow], [890, 1000, HC.red]]],
    ['NG', [390, 450], 0, 110, [[0, 102, HC.green], [102, 105, HC.yellow], [105, 110, HC.red]]],
    ['NR/NP', [560, 620, 680], 0, 120, [[0, 91, HC.red], [91, 95, HC.yellow], [95, 105, HC.green], [105, 107, HC.yellow], [107, 120, HC.red]]],
  ];
  const yOf = (v, lo, hi) => Y1 - clamp((v - lo) / (hi - lo), 0, 1) * (Y1 - Y0);
  const frame = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const [lbl, xs, lo, hi, bands] of scales) {
      for (const x of xs) {
        for (const [a, b, c] of bands) { g.fillStyle = c; g.globalAlpha = 0.9; g.fillRect(x + 16, yOf(b, lo, hi), 7, yOf(a, lo, hi) - yOf(b, lo, hi)); }
        g.globalAlpha = 1;
        g.strokeStyle = HC.grey; g.lineWidth = 2; g.strokeRect(x - 14, Y0, 28, Y1 - Y0);
      }
      const cx = (xs[0] + xs[xs.length - 1]) / 2;
      text(g, lbl, cx, 690, HC.white, 'center', font(28));
    }
    text(g, '1', 70, 720, HC.grey, 'center', font(22)); text(g, '2', 130, 720, HC.grey, 'center', font(22));
    text(g, '1', 230, 720, HC.grey, 'center', font(22)); text(g, '2', 290, 720, HC.grey, 'center', font(22));
    text(g, '1', 390, 720, HC.grey, 'center', font(22)); text(g, '2', 450, 720, HC.grey, 'center', font(22));
    text(g, '1', 560, 720, HC.grey, 'center', font(22)); text(g, 'R', 620, 720, HC.grey, 'center', font(22)); text(g, '2', 680, 720, HC.grey, 'center', font(22));
    g.strokeStyle = HC.grey; g.lineWidth = 2; line(g, 10, 745, 740, 745);
    text(g, 'FUEL', 30, 790, HC.white, 'left', font(28));
    text(g, 'MAIN 1', 30, 840, HC.cyan, 'left', font(26)); text(g, 'MAIN 2', 30, 885, HC.cyan, 'left', font(26)); text(g, 'TOTAL', 30, 930, HC.cyan, 'left', font(26));
    text(g, 'LB', 330, 930, HC.grey, 'left', font(22));
    text(g, 'OIL', 420, 790, HC.white, 'left', font(28));
    text(g, 'PSI', 420, 840, HC.cyan, 'left', font(24)); text(g, '°C', 420, 885, HC.cyan, 'left', font(24)); text(g, 'XMSN', 420, 930, HC.cyan, 'left', font(24));
    tabs(g, 'ENG');
  });
  return (g, S) => {
    frame.blit(g);
    const k = smoothK(S.dt, 0.8);
    const q = S.torque || (S.engines[0] ? S.engines[0].n1 * 0.8 : 0);
    for (let i = 0; i < 2; i++) {
      const e = S.engines[i], run = !e || e.running !== false;
      const trq = e && Number.isFinite(e.torque) ? e.torque : q * (i ? 0.985 : 1);
      const ngModel = e && e.present && S.isHeli && e.n1 > 0 ? e.n1 : NaN;
      st.trq[i] += (trq - st.trq[i]) * k;
      st.tgt[i] += ((run && S.rotorRPM > 5 ? 480 + trq * 3.6 : 60) - st.tgt[i]) * k;
      st.ng[i] += ((Number.isFinite(ngModel) ? ngModel : run && S.rotorRPM > 5 ? 72 + trq * 0.26 : 0) - st.ng[i]) * k;
      st.np[i] += (S.rotorRPM * (i ? 0.998 : 1.002) - st.np[i]) * k;
    }
    st.nr += (S.rotorRPM - st.nr) * k;
    const vals = [st.trq, st.tgt, st.ng, [st.np[0], st.nr, st.np[1]]];
    scales.forEach(([lbl, xs, lo, hi, bands], si) => {
      xs.forEach((x, j) => {
        const v = vals[si][j];
        let c = HC.white;
        for (const [a, b, cc] of bands) if (v >= a && v <= b) c = cc === HC.green ? HC.white : cc;
        const y = yOf(v, lo, hi);
        g.fillStyle = c === HC.white ? '#d8dde2' : c; g.fillRect(x - 10, y, 20, Y1 - y);
        g.fillStyle = HC.white; poly(g, [x + 14, y, x + 30, y - 9, x + 30, y + 9]); g.fill();
        text(g, String(Math.round(v)), x, Y0 - 14 - (xs.length === 3 && j === 1 ? 32 : 0), c === HC.white ? HC.green : c, 'center', font(26));
      });
    });
    // fuel & oil
    const lbs = S.fuel * 2.2046;
    text(g, String(Math.round(lbs / 2 / 10) * 10), 310, 840, lbs < 400 ? HC.yellow : HC.green, 'right', font(30));
    text(g, String(Math.round(lbs / 2 / 10) * 10 - 10), 310, 885, lbs < 400 ? HC.yellow : HC.green, 'right', font(30));
    text(g, String(Math.round(lbs / 10) * 10), 310, 930, HC.green, 'right', font(30));
    const run = S.rotorRPM > 5;
    text(g, run ? '48  47' : '0  0', 720, 840, HC.green, 'right', font(28));
    text(g, run ? '92  94' : '21  21', 720, 885, HC.green, 'right', font(28));
    text(g, run ? '41' : '0', 720, 930, HC.green, 'right', font(28));
    if (S.warn.lowRotor || S.warn.stall) text(g, 'LOW ROTOR RPM', 375, 120, HC.red, 'center', font(34));
    else if (S.warn.overtorque) text(g, 'OVERTORQUE', 375, 120, HC.red, 'center', font(34));
    else if (S.warn.lowFuel) text(g, 'LOW FUEL', 375, 120, HC.yellow, 'center', font(34));
    text(g, 'ENGINE', 375, 60, HC.white, 'center', font(32));
  };
}

export const UH60 = {
  'uh60.mfd.pfd': { vw: W, vh: H, size: 1024, create: uh60Pfd },
  'uh60.mfd.nd': { vw: W, vh: H, size: 1024, hz: 10, create: uh60Nd },
  'uh60.mfd.eng': { vw: W, vh: H, size: 512, hz: 10, create: uh60Eng },
};
