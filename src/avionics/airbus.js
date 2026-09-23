// Airbus A320neo displays: PFD, ND (ARC), E/WD, SD (WHEEL / DOOR / CRUISE auto-paging) and ISIS standby.
// Virtual coordinates 1000×1000 for every unit (square DUs).
import { font, text, line, poly, circle, stripes, clamp, lerp, wrap360, wrap180, pad, num, DEG, NM, FT, smoothK } from './core.js';
import { MapView, drawRunways, terrainGrid, TerrainAlertImage, pickDestination, bearingTo, distTo, traffic, clockSeconds, ilsFor, drawCenterline } from './nav.js';

export const AC = {
  green: '#00ff00', cyan: '#00e8ff', amber: '#ff9a00', magenta: '#ff6cff', white: '#ffffff', yellow: '#ffff00',
  red: '#ff2020', grey: '#8e949a', tape: '#5a5e64', sky: '#1386e2', gnd: '#8b4a18', black: '#000000', dark: '#2e3237',
};

// ---------------------------------------------------------------- speeds (kt) for the A320 speed tape
function a320Speeds(S) {
  const f = S.flaps, lbl = S.flapsLabel.toUpperCase(), V = S.vsp;
  const vfeTable = { '1': 230, '1+F': 215, '2': 200, '3': 185, 'FULL': 177, '4': 177 };
  const clean = f < 0.01 && S.slats < 0.01;
  let vfe = V.vfe > 0 ? V.vfe : clean ? 0 : (vfeTable[lbl] ?? Math.round(lerp(230, 177, f)));
  let vmax = V.vmo > 0 ? V.vmo : 350;
  if (vfe > 0) vmax = Math.min(vmax, vfe);
  if (!S.gearUp) vmax = Math.min(vmax, V.vle > 0 ? V.vle : 280);
  const mmo = V.mmo > 0 ? V.mmo : 0.82;
  if (S.mach > 0.3) vmax = Math.min(vmax, S.ias * mmo / S.mach);
  let vls, aprot, amax;
  if (V.valid) { vls = V.vls; aprot = V.vs1g * 1.1; amax = V.vs1g * 1.02; }
  else { vls = lerp(158, 124, f); aprot = vls - 13; amax = vls - 21; }
  const idx = S.flapsIndex;
  let vfeNext = V.valid ? V.vfeNext : (clean ? 230 : f < 0.3 ? 215 : f < 0.55 ? 200 : f < 0.8 ? 185 : 0);
  if (lbl === 'FULL' || vfeNext <= vfe && vfe > 0 && idx >= 5) vfeNext = 0;
  return {
    vmax, vls, aprot, amax, vfeNext,
    greenDot: clean ? (V.greenDot > 0 ? V.greenDot : 206) : 0,
    sSpeed: lbl === '1' || lbl === '1+F' ? (V.vs1g > 0 ? V.vs1g * 1.23 * 1.08 : 182) : 0,
    fSpeed: lbl === '2' || lbl === '3' ? (V.vs1g > 0 ? V.vs1g * 1.23 * 1.12 : 146) : 0,
  };
}

// ---------------------------------------------------------------- FMA logic
function createFma() {
  const cols = [['', '', ''], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', '']];
  const changed = [0, 0, 0, 0, 0];
  const prev = ['', '', '', '', ''];
  const F = { cols, changed, merged: '' };
  F.update = (S, t) => {
    const ap = S.ap, altErr = ap.alt - S.alt, athr = ap.on && ap.athr;
    const toga = S.throttle > 0.95;
    let c1 = ['', '', ''], c2 = ['', '', ''], c3 = ['', '', ''], c4 = ['', '', ''], c5 = ['', '1 FD 2', ''];
    F.merged = '';
    const land = ap.on && (ap.vert === 'LAND' || ap.vert === 'FLARE' || ap.vert === 'ROLLOUT');
    const appr = ap.on && (ap.appArmed || ap.lat === 'LOC' || ap.vert === 'G/S' || land);
    if (S.onGround && !land) {
      if (toga) { c1 = ['MAN', 'TOGA', '']; c2 = ['SRS', 'CLB', '']; c3 = ['RWY', 'NAV', '']; c5 = ['', '1 FD 2', 'A/THR*']; }
    } else if (ap.on) {
      const v = ap.vert || (Math.abs(altErr) < 60 ? 'ALT' : altErr > 0 ? 'CLB' : 'DES');
      if (athr) c1 = [v === 'CLB' ? 'THR CLB' : v === 'DES' ? 'THR IDLE' : v === 'ROLLOUT' ? '' : v === 'FLARE' ? 'IDLE' : 'SPEED', '', ''];
      else if (toga) c1 = ['MAN', 'TOGA', ''];
      if (land) F.merged = v === 'ROLLOUT' ? 'ROLL OUT' : v === 'FLARE' ? 'FLARE' : 'LAND';
      else {
        if (v === 'G/S') c2 = ['G/S', '', ''];
        else if (v === 'V/S') c2 = ['V/S', '', ''];
        else if (v === 'CLB') c2 = [Math.abs(altErr) < 250 ? 'ALT*' : 'OP CLB', 'ALT', ''];
        else if (v === 'DES') c2 = [Math.abs(altErr) < 250 ? 'ALT*' : 'OP DES', 'ALT', ''];
        else c2 = ['ALT', '', ''];
        c3 = [ap.lat === 'LOC' ? 'LOC' : ap.lat === 'NAV' ? 'NAV' : 'HDG', '', ''];
        if (ap.appArmed) { if (v !== 'G/S') c2[1] = 'G/S'; if (ap.lat !== 'LOC') c3[1] = 'LOC'; }
      }
      c5 = ['AP1', '1 FD 2', athr ? 'A/THR' : ''];
      if (appr) c4 = ['CAT 3', 'DUAL', 'DH 100'];
    } else {
      if (toga) { c1 = ['MAN', 'TOGA', '']; c2 = ['SRS', '', '']; c3 = [S.agl < 30 ? 'RWY' : 'RWY TRK', '', '']; c5 = ['', '1 FD 2', 'A/THR*']; }
      else { c2 = [Math.abs(S.vs) > 300 ? 'V/S' : 'ALT', '', '']; c3 = ['HDG', '', '']; }
    }
    if (S.speedbrake > 0.05 && S.throttle > 0.2 && !S.onGround) c2[2] = 'SPD BRK';
    const all = [c1, c2, c3, c4, c5];
    for (let i = 0; i < 5; i++) {
      const key = (i === 1 && F.merged ? F.merged : all[i][0]) + '|' + all[i][1];
      if (key !== prev[i]) { if (all[i][0] || (i === 1 && F.merged)) changed[i] = t + 10; prev[i] = key; }
      cols[i][0] = all[i][0]; cols[i][1] = all[i][1]; cols[i][2] = all[i][2];
    }
  };
  return F;
}

// ---------------------------------------------------------------- PFD
function a320Pfd(env) {
  const CX = 440, CY = 500, PPD = 11.5;
  const SP = { x0: 36, x1: 152, y0: 265, y1: 735, k: 5.9 };
  const AL = { x0: 718, x1: 818, y0: 265, y1: 735, k: 0.44 };
  const HD = { x0: 236, x1: 644, y0: 850, y1: 906, k: 9 };
  const VS = { x0: 862, x1: 960, y0: 290, y1: 710 };
  const fma = createFma();
  const vsY = (v) => {
    const a = Math.abs(v), s = Math.sign(v), half = (VS.y1 - VS.y0) / 2 - 22;
    const f = a <= 1000 ? 0.36 * a / 1000 : a <= 2000 ? 0.36 + 0.3 * (a - 1000) / 1000 : 0.66 + 0.34 * Math.min(1, (a - 2000) / 4000);
    return CY - s * f * half;
  };
  const clipAtt = (g) => {
    g.beginPath();
    g.moveTo(216, 290); g.quadraticCurveTo(CX, 238, 664, 290);
    g.lineTo(664, 712); g.quadraticCurveTo(CX, 764, 216, 712); g.closePath();
  };
  const under = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    g.strokeStyle = '#a8adb2'; g.lineWidth = 3;
    for (const x of [214, 452, 650, 812]) line(g, x, 12, x, 128);
    // V/S background + scale
    g.fillStyle = AC.tape;
    poly(g, [VS.x0, VS.y0, VS.x0 + 42, VS.y0, VS.x1, VS.y0 + 80, VS.x1, VS.y1 - 80, VS.x0 + 42, VS.y1, VS.x0, VS.y1]); g.fill();
    g.strokeStyle = AC.white; g.lineWidth = 3;
    g.font = font(26); g.fillStyle = AC.white; g.textAlign = 'left';
    for (const v of [500, 1000, 1500, 2000, 6000]) {
      for (const s of [1, -1]) {
        const y = vsY(s * v), big = v === 1000 || v === 2000 || v === 6000;
        line(g, VS.x0 + 6, y, VS.x0 + (big ? 26 : 18), y);
        if (big) g.fillText(String(v / 1000), VS.x0 + 30, y + 9);
      }
    }
    g.strokeStyle = AC.yellow; g.lineWidth = 5; line(g, VS.x0 + 4, CY, VS.x0 + 30, CY);
    // tapes backgrounds
    g.fillStyle = AC.tape;
    g.fillRect(SP.x0, SP.y0, SP.x1 - SP.x0, SP.y1 - SP.y0);
    g.fillRect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0);
    g.fillRect(HD.x0, HD.y0, HD.x1 - HD.x0, HD.y1 - HD.y0);
    g.strokeStyle = AC.white; g.lineWidth = 3;
    line(g, SP.x0, SP.y0, SP.x1 + 4, SP.y0); line(g, SP.x0, SP.y1, SP.x1 + 4, SP.y1);
    line(g, AL.x0, AL.y0, AL.x1 + 30, AL.y0); line(g, AL.x0, AL.y1, AL.x1 + 30, AL.y1);
    line(g, AL.x1, AL.y0, AL.x1, AL.y1);
  });
  const over = env.layer((g) => {
    // aircraft symbol
    g.lineWidth = 3.5; g.strokeStyle = AC.yellow; g.fillStyle = '#000';
    for (const s of [-1, 1]) {
      poly(g, [CX + s * 150, CY - 6, CX + s * 60, CY - 6, CX + s * 60, CY + 30, CX + s * 72, CY + 30, CX + s * 72, CY + 6, CX + s * 150, CY + 6]);
      g.fill(); g.stroke();
    }
    g.fillRect(CX - 8, CY - 8, 16, 16); g.strokeRect(CX - 8, CY - 8, 16, 16);
    // fixed bank scale
    const R = 236;
    g.strokeStyle = AC.white; g.lineWidth = 3.5;
    g.beginPath(); g.arc(CX, CY, R, (-90 - 45) * DEG, (-90 + 45) * DEG); g.stroke();
    for (const a of [-45, -30, -20, -10, 10, 20, 30, 45]) {
      const r2 = R + (Math.abs(a) >= 30 ? 26 : 15), c = Math.cos((a - 90) * DEG), s = Math.sin((a - 90) * DEG);
      line(g, CX + c * R, CY + s * R, CX + c * r2, CY + s * r2);
    }
    g.strokeStyle = AC.green; g.lineWidth = 3;
    for (const a of [-67, 67]) {
      const c = Math.cos((a - 90) * DEG), s = Math.sin((a - 90) * DEG);
      for (const d of [-5, 5]) {
        const px = -s * d, py = c * d;
        line(g, CX + c * (R - 4) + px, CY + s * (R - 4) + py, CX + c * (R + 12) + px, CY + s * (R + 12) + py);
      }
    }
    g.fillStyle = AC.yellow;
    poly(g, [CX, CY - R - 2, CX - 13, CY - R - 24, CX + 13, CY - R - 24]); g.fill();
    // speed index
    g.fillStyle = AC.yellow; g.strokeStyle = AC.yellow; g.lineWidth = 5;
    line(g, SP.x0 - 6, CY, SP.x1 - 8, CY);
    poly(g, [SP.x1 - 12, CY, SP.x1 + 16, CY - 13, SP.x1 + 16, CY + 13]); g.fill();
    // heading reference
    g.lineWidth = 5; line(g, CX, HD.y0 - 12, CX, HD.y0 + 30);
    // altitude window
    g.lineWidth = 3.5; g.strokeStyle = AC.yellow;
    poly(g, [AL.x0 - 6, CY - 36, AL.x1 + 4, CY - 36, AL.x1 + 4, CY - 56, AL.x1 + 58, CY - 56, AL.x1 + 58, CY + 56, AL.x1 + 4, CY + 56, AL.x1 + 4, CY + 36, AL.x0 - 6, CY + 36]);
    g.stroke();
  });

  return (g, S, ctx) => {
    fma.update(S, S.t);
    under.blit(g);
    const V = a320Speeds(S);
    // ---------------- attitude
    g.save(); clipAtt(g); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const py = S.pitch * PPD;
    g.fillStyle = AC.sky; g.fillRect(-700, -1400 + py, 1400, 1400);
    g.fillStyle = AC.gnd; g.fillRect(-700, py, 1400, 1400);
    g.strokeStyle = AC.white; g.lineWidth = 3.5; line(g, -700, py, 700, py);
    // heading marks on the horizon
    g.lineWidth = 3;
    for (let d = Math.ceil((S.hdgMag - 24) / 10) * 10; d <= S.hdgMag + 24; d += 10) {
      const x = wrap180(d - S.hdgMag) * HD.k; line(g, x, py, x, py + 12);
    }
    g.restore();
    // pitch scale (clipped narrower)
    g.save();
    g.beginPath(); g.rect(CX - 150, CY - 205, 300, 395); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    g.strokeStyle = AC.white; g.fillStyle = AC.white; g.lineWidth = 3.5; g.font = font(28); g.textAlign = 'center';
    const p0 = Math.ceil((S.pitch - 22) / 2.5), p1 = Math.floor((S.pitch + 22) / 2.5);
    for (let i = p0; i <= p1; i++) {
      if (i === 0) continue;
      const a = i * 2.5, y = (S.pitch - a) * PPD;
      const w = i % 4 === 0 ? 62 : i % 2 === 0 ? 34 : 14;
      if (Math.abs(a) > 90) continue;
      line(g, -w, y, w, y);
      if (i % 4 === 0) { const s = String(Math.abs(a)); g.fillText(s, -w - 30, y + 10); g.fillText(s, w + 30, y + 10); }
    }
    g.restore();
    // roll index + sideslip (sky pointer)
    g.save(); g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const bankAmber = Math.abs(S.roll) > 45;
    g.strokeStyle = bankAmber ? AC.amber : AC.yellow; g.lineWidth = 3.5;
    poly(g, [0, -234, -13, -212, 13, -212]); g.stroke();
    const sl = clamp(S.beta * 3, -30, 30);
    g.fillStyle = bankAmber ? AC.amber : AC.yellow;
    g.strokeRect(-15 + sl, -206, 30, 9);
    g.restore();
    // flight directors
    if (!S.onGround || S.gs > 30) {
      const apCmd = S.ap.on;
      if (apCmd || S.throttle > 0.95) {
        const pc = clamp((S.ap.on ? clamp((S.ap.alt - S.alt) / 150, -5, 8) : 12) - S.pitch, -15, 15);
        const rc = clamp((S.ap.on ? clamp(wrap180(S.ap.hdg - S.hdg) * 1.5, -25, 25) : 0) - S.roll, -20, 20);
        g.strokeStyle = AC.green; g.lineWidth = 5;
        const fy = CY - pc * 8, fx = CX + rc * 4;
        line(g, CX - 110, fy, CX + 110, fy);
        line(g, fx, CY - 110, fx, CY + 110);
      }
    }
    // radio altitude
    if (S.radioAlt < 2500 && !S.crashed) {
      const ra = S.radioAlt < 50 ? Math.round(S.radioAlt) : S.radioAlt < 100 ? Math.round(S.radioAlt / 5) * 5 : Math.round(S.radioAlt / 10) * 10;
      text(g, String(ra), CX, 700, S.radioAlt < 100 && S.gearDown ? AC.amber : AC.green, 'center', font(40));
    }
    over.blit(g);
    // ---------------- ILS deviation (LOC under the attitude, G/S left of the altitude tape)
    const ils = ilsFor(ctx.nav, S);
    const lsOn = ils.valid && !S.onGround && (S.ap.lat === 'LOC' || S.ap.vert === 'G/S' || S.ap.appArmed || (S.gearHandleDown && ils.dme < 20));
    if (lsOn) {
      g.strokeStyle = AC.white; g.lineWidth = 3;
      for (const k of [-2, -1, 1, 2]) { circle(g, CX + k * 34, 752, 6); g.stroke(); circle(g, 690, CY + k * 34, 6); g.stroke(); }
      g.strokeStyle = AC.yellow; g.lineWidth = 4; line(g, CX, 740, CX, 764); line(g, 678, CY, 702, CY);
      g.fillStyle = AC.magenta; g.strokeStyle = AC.magenta; g.lineWidth = 3;
      const lx = CX + clamp(ils.loc, -2.2, 2.2) * 34;
      poly(g, [lx - 16, 752, lx, 742, lx + 16, 752, lx, 762]); if (Math.abs(ils.loc) < 2.2) g.fill(); else g.stroke();
      if (ils.gsValid) {
        const gy = CY - clamp(ils.gs, -2.2, 2.2) * 34;
        poly(g, [690, gy - 16, 700, gy, 690, gy + 16, 680, gy]); if (Math.abs(ils.gs) < 2.2) g.fill(); else g.stroke();
      }
      text(g, ils.ident, 20, 834, AC.magenta, 'left', font(30));
      text(g, ils.freq, 20, 870, AC.magenta, 'left', font(28));
      text(g, ils.dme.toFixed(1), 20, 906, AC.magenta, 'left', font(28)); text(g, 'NM', 90, 906, AC.cyan, 'left', font(22));
    }

    // ---------------- speed tape
    const ias = Math.max(30, S.ias);
    g.save(); g.beginPath(); g.rect(SP.x0, SP.y0, SP.x1 - SP.x0 + 30, SP.y1 - SP.y0); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.font = font(32); g.fillStyle = AC.white; g.textAlign = 'right';
    const yOf = (v) => CY - (v - ias) * SP.k;
    for (let v = Math.max(30, Math.floor((ias - 42) / 10) * 10); v <= ias + 42; v += 10) {
      const y = yOf(v);
      line(g, SP.x1 - 16, y, SP.x1, y);
      if (v % 20 === 0) g.fillText(pad(v, 3), SP.x1 - 22, y + 11);
    }
    if (!S.onGround) {
      const bx = SP.x1 - 1;
      // VMAX barber pole
      const yv = yOf(V.vmax);
      if (yv > SP.y0) stripes(g, bx, SP.y0, yv, 12, AC.red, '#000', 12);
      // VLS / alpha prot / alpha max
      const yls = yOf(V.vls), yap = yOf(V.aprot), yam = yOf(V.amax);
      g.fillStyle = AC.amber; g.fillRect(bx, yls, 4, Math.max(0, yap - yls));
      if (yap < SP.y1) stripes(g, bx, yap, Math.min(SP.y1, yam), 12, AC.amber, '#000', 10);
      if (yam < SP.y1) { g.fillStyle = AC.red; g.fillRect(bx, yam, 12, SP.y1 - yam); }
      // green dot / S / F / VFE next
      if (V.greenDot) { g.strokeStyle = AC.green; g.lineWidth = 3.5; circle(g, SP.x1 + 10, yOf(V.greenDot), 8); g.stroke(); }
      if (V.sSpeed) text(g, 'S', SP.x1 + 4, yOf(V.sSpeed) + 11, AC.green, 'left', font(30));
      if (V.fSpeed) text(g, 'F', SP.x1 + 4, yOf(V.fSpeed) + 11, AC.green, 'left', font(30));
      if (V.vfeNext) { g.strokeStyle = AC.amber; g.lineWidth = 3; const y = yOf(V.vfeNext); line(g, SP.x1 + 2, y - 4, SP.x1 + 16, y - 4); line(g, SP.x1 + 2, y + 4, SP.x1 + 16, y + 4); }
    }
    // takeoff V-speeds: V1 cyan '1', VR cyan circle; V2 becomes the (SRS) speed target
    const VT = S.vsp, tko = VT.vr > 0 && (S.onGround ? S.throttle > 0.5 || S.gs > 30 : S.agl < 1500 && S.vs > 0 && S.flaps > 0.05 && !S.ap.on);
    if (tko && S.onGround) {
      text(g, '1', SP.x1 + 4, yOf(VT.vr * 0.97) + 11, AC.cyan, 'left', font(30));
      g.strokeStyle = AC.cyan; g.lineWidth = 3.5; circle(g, SP.x1 + 12, yOf(VT.vr), 8); g.stroke();
    }
    // target speed
    const tgt = S.ap.on && S.ap.hasSpd ? S.ap.spd : tko && VT.v2 > 0 ? VT.v2 + (S.onGround ? 0 : 10) : 0;
    if (tgt > 30) {
      const y = yOf(tgt), col = AC.magenta;
      if (y > SP.y0 + 8 && y < SP.y1 - 8) { g.strokeStyle = col; g.lineWidth = 3.5; poly(g, [SP.x1 + 2, y, SP.x1 + 26, y - 14, SP.x1 + 26, y + 14]); g.stroke(); }
    }
    g.restore();
    if (tgt > 30) {
      const y = CY - (tgt - ias) * SP.k;
      if (y <= SP.y0 + 8) text(g, String(Math.round(tgt)), (SP.x0 + SP.x1) / 2, SP.y0 - 10, AC.magenta, 'center', font(32));
      else if (y >= SP.y1 - 8) text(g, String(Math.round(tgt)), (SP.x0 + SP.x1) / 2, SP.y1 + 36, AC.magenta, 'center', font(32));
    }
    // speed trend
    if (Math.abs(S.iasTrend) > 2 && !S.onGround) {
      const y2 = clamp(CY - S.iasTrend * SP.k, SP.y0, SP.y1);
      g.strokeStyle = AC.yellow; g.fillStyle = AC.yellow; g.lineWidth = 3.5;
      const x = SP.x1 - 4; line(g, x, CY, x, y2);
      const d = Math.sign(CY - y2);
      poly(g, [x - 9, y2 + d * 14, x, y2, x + 9, y2 + d * 14], false); g.stroke();
    }
    // mach
    if (S.mach >= 0.5) text(g, '.' + pad(Math.floor(S.mach * 100) % 100, 2), (SP.x0 + SP.x1) / 2 + 10, 790, AC.green, 'center', font(38));

    // ---------------- altitude tape
    const alt = S.alt;
    g.save(); g.beginPath(); g.rect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.font = font(32); g.fillStyle = AC.white; g.textAlign = 'left';
    const ay = (a) => CY - (a - alt) * AL.k;
    for (let a = Math.floor((alt - 560) / 100) * 100; a <= alt + 560; a += 100) {
      const y = ay(a);
      line(g, AL.x1 - 14, y, AL.x1, y);
      if (a % 500 === 0) g.fillText((a < 0 ? '-' : '') + pad(Math.abs(a) / 100, 3), AL.x0 + 10, y + 11);
    }
    // ground reference (red ribbon)
    const gnd = S.alt - S.agl;
    if (ay(gnd) < AL.y1) { g.fillStyle = AC.red; g.fillRect(AL.x1 - 10, ay(gnd), 10, AL.y1 - ay(gnd)); }
    // target altitude symbol
    if (S.ap.on) {
      const y = ay(S.ap.alt);
      if (y > AL.y0 - 30 && y < AL.y1 + 30) {
        g.strokeStyle = AC.cyan; g.lineWidth = 3.5;
        poly(g, [AL.x0 + 2, y - 26, AL.x0 + 30, y - 26, AL.x0 + 30, y - 12, AL.x0 + 18, y, AL.x0 + 30, y + 12, AL.x0 + 30, y + 26, AL.x0 + 2, y + 26]); g.stroke();
      }
    }
    g.restore();
    if (S.ap.on) {
      const y = ay(S.ap.alt), s = String(Math.round(S.ap.alt / 100) * 100);
      if (y <= AL.y0) text(g, s, AL.x0 + 50, AL.y0 - 10, AC.cyan, 'center', font(32));
      else if (y >= AL.y1) text(g, s, AL.x0 + 50, AL.y1 + 36, AC.cyan, 'center', font(32));
    }
    // altitude readout (big digits + drum)
    g.fillStyle = '#000';
    g.fillRect(AL.x0 - 4, CY - 34, AL.x1 - AL.x0 + 8, 68);
    g.fillRect(AL.x1 + 6, CY - 54, 50, 108);
    const altCol = S.ap.on && Math.abs(S.ap.alt - alt) < 200 && Math.abs(S.ap.alt - alt) > 60 ? AC.amber : AC.green;
    const hund = Math.floor(Math.abs(alt) / 100);
    const hs = hund >= 100 ? String(hund) : hund >= 10 ? ' ' + hund : '  ' + hund;
    g.font = font(46); g.fillStyle = altCol; g.textAlign = 'right';
    g.fillText((alt < 0 ? '-' : '') + hs.trim(), AL.x1 + 2, CY + 17);
    g.save(); g.beginPath(); g.rect(AL.x1 + 6, CY - 54, 50, 108); g.clip();
    const tens = ((Math.abs(alt) % 100) + 100) % 100;
    g.font = font(29); g.textAlign = 'left';
    const base = Math.floor(tens / 20) * 20;
    for (let k = -2; k <= 3; k++) {
      const v = base + k * 20, y = CY + 11 + (tens - v) * 1.65;
      g.fillText(pad(((v % 100) + 100) % 100, 2), AL.x1 + 10, y);
    }
    g.restore();
    // baro
    if (S.alt > 18000 || S.ap.on && S.ap.alt > 18000) {
      g.strokeStyle = AC.yellow; g.lineWidth = 3; g.strokeRect(AL.x0 + 4, 772, 86, 44);
      text(g, 'STD', AL.x0 + 47, 806, AC.cyan, 'center', font(34));
    } else {
      text(g, 'QNH', AL.x0 - 6, 808, AC.white, 'left', font(28));
      text(g, '1013', AL.x0 + 66, 808, AC.cyan, 'left', font(32));
    }

    // ---------------- vertical speed
    const vs = clamp(S.vs, -6500, 6500), vy = vsY(vs);
    const vsAmber = Math.abs(S.vs) > 6000 || (S.radioAlt < 2500 && S.vs < -2000 && !S.onGround) || (S.radioAlt < 1000 && S.vs < -1200 && !S.onGround);
    g.strokeStyle = vsAmber ? AC.amber : AC.green; g.lineWidth = 5;
    line(g, VS.x0 + 10, vy, VS.x1 - 2, CY + (vy - CY) * 0.35);
    if (Math.abs(S.vs) >= 200) {
      const vv = String(Math.round(Math.abs(S.vs) / 100));
      const ty = S.vs > 0 ? vy - 10 : vy + 34;
      g.fillStyle = '#000'; g.fillRect(VS.x0 + 44, ty - 27, 46, 32);
      text(g, pad(+vv, 2), VS.x0 + 67, ty, vsAmber ? AC.amber : AC.green, 'center', font(27));
    }

    // ---------------- heading tape
    g.save(); g.beginPath(); g.rect(HD.x0, HD.y0, HD.x1 - HD.x0, HD.y1 - HD.y0 + 30); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.fillStyle = AC.white; g.textAlign = 'center';
    const h0 = S.hdgMag;
    for (let d = Math.ceil((h0 - 26) / 5) * 5; d <= h0 + 26; d += 5) {
      const x = CX + (d - h0) * HD.k, dd = wrap360(d);
      line(g, x, HD.y0, x, HD.y0 + (dd % 10 === 0 ? 20 : 12));
      if (dd % 10 === 0) { g.font = font(dd % 30 === 0 ? 34 : 27); g.fillText(String(dd / 10), x, HD.y0 + 52); }
    }
    // track diamond
    const tx = CX + wrap180(S.trackMag - h0) * HD.k;
    g.strokeStyle = AC.green; g.lineWidth = 3;
    poly(g, [tx, HD.y1 - 16, tx + 9, HD.y1 - 4, tx, HD.y1 + 8, tx - 9, HD.y1 - 4]); g.stroke();
    // selected heading
    if (S.ap.on) {
      const d = wrap180(S.ap.hdgMag - h0), x = CX + d * HD.k;
      g.strokeStyle = AC.cyan; g.lineWidth = 3.5;
      if (Math.abs(d) < 22) { poly(g, [x, HD.y0 + 2, x - 11, HD.y0 - 16, x + 11, HD.y0 - 16]); g.stroke(); }
    }
    g.restore();
    if (S.ap.on) {
      const d = wrap180(S.ap.hdgMag - h0);
      if (Math.abs(d) >= 22) text(g, pad(Math.round(S.ap.hdgMag) % 360, 3), d > 0 ? HD.x1 - 34 : HD.x0 + 34, HD.y0 - 14, AC.cyan, 'center', font(30));
    }

    // ---------------- FMA
    const fx = [114, 332, 551, 731, 906];
    const t = S.t;
    if (fma.merged) {
      g.fillStyle = '#000'; g.fillRect(446, 8, 12, 124);
      text(g, fma.merged, 450, 44, AC.green, 'center', font(29));
      if (fma.changed[1] > t) { g.strokeStyle = AC.white; g.lineWidth = 3; g.strokeRect(330, 12, 240, 40); }
    }
    for (let i = 0; i < 5; i++) {
      const c = fma.cols[i];
      for (let r = 0; r < 3; r++) {
        const s = c[r]; if (!s) continue;
        let col = AC.green;
        if (i === 4) col = s === 'A/THR*' ? AC.cyan : AC.white;
        else if (i === 3) col = AC.white;
        else if (r === 1 && i > 0) col = AC.cyan;
        else if (r === 2) col = s === 'SPD BRK' ? AC.amber : AC.white;
        if (s === 'MAN' || s === 'TOGA') col = AC.white;
        text(g, s === 'A/THR*' ? 'A/THR' : s, fx[i], 44 + r * 40, col, 'center', font(29));
      }
      if (fma.changed[i] > t && c[0]) {
        const w = i === 0 ? 190 : i === 4 ? 150 : 170;
        g.strokeStyle = AC.white; g.lineWidth = 3;
        g.strokeRect(fx[i] - w / 2, 12, w, c[0] === 'MAN' ? 76 : 40);
      }
    }
    // warnings flags
    if (S.warn.stall && Math.floor(S.t * 3) % 2 === 0) text(g, 'STALL', CX, 610, AC.red, 'center', font(44));
    if (S.warn.overspeed) text(g, 'OVERSPEED', CX, 610, AC.red, 'center', font(40));
  };
}

// ---------------------------------------------------------------- ND (ARC mode)
function a320Nd(env) {
  const ACX = 500, ACY = 792, R = 612;
  const view = new MapView();
  const terr = new TerrainAlertImage();
  let range = 20, rangeHold = 0;
  const arcClip = (g) => { g.beginPath(); g.arc(ACX, ACY, R, 0, Math.PI * 2); g.rect(0, 0, 0, 0); };
  const under = env.layer((g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000); });
  const over = env.layer((g) => {
    // aircraft symbol
    g.strokeStyle = AC.yellow; g.lineWidth = 6;
    line(g, ACX, ACY - 6, ACX, ACY + 58); line(g, ACX - 40, ACY + 14, ACX + 40, ACY + 14); line(g, ACX - 16, ACY + 48, ACX + 16, ACY + 48);
    // lubber line
    g.strokeStyle = AC.yellow; g.lineWidth = 5; line(g, ACX, ACY - R - 34, ACX, ACY - R + 6);
  });
  return (g, S, ctx) => {
    const nav = ctx.nav, G = terrainGrid(ctx.world);
    // automatic range selection
    const want = S.onGround || S.agl < 2500 ? 10 : S.alt < 12000 ? 20 : 40;
    if (want !== range) { rangeHold += S.dt; if (rangeHold > 3 || S.t < 1) { range = want; rangeHold = 0; } } else rangeHold = 0;
    const k = R / (range * NM);
    under.blit(g);
    const up = S.hdg;
    view.set(ACX, ACY, S.x, S.z, up, k);
    // terrain
    let floorFt = 0;
    if (G) {
      G.tick();
      let bestD = Infinity;
      for (const a of nav.airports) { const d = distTo(S.x, S.z, a.x, a.z); if (d < bestD) { bestD = d; floorFt = a.elev * FT + 400; } }
      terr.update(G, S.alt, floorFt, S.gearDown);
      if (terr.hasContent) {
        g.save(); circle(g, ACX, ACY, R); g.clip();
        view.apply(g); terr.draw(g);
        g.restore();
      }
    }
    // range rings
    g.save();
    g.beginPath(); g.rect(0, 150, 1000, 850); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.setLineDash([14, 14]);
    for (const f of [0.25, 0.5, 0.75]) { g.beginPath(); g.arc(ACX, ACY, R * f, Math.PI * 1.02, Math.PI * 1.98); g.stroke(); }
    g.setLineDash([]);
    g.font = font(30); g.fillStyle = AC.cyan; g.textAlign = 'center';
    for (const f of [0.5, 0.75]) {
      const rr = R * f, a = 58 * DEG;
      const s = String(range * f % 1 === 0 ? range * f : (range * f).toFixed(1));
      g.fillText(s, ACX - Math.sin(a) * rr - 12, ACY - Math.cos(a) * rr + 10);
      g.fillText(s, ACX + Math.sin(a) * rr + 12, ACY - Math.cos(a) * rr + 10);
    }
    g.restore();
    // map content (clipped to arc)
    g.save(); circle(g, ACX, ACY, R + 2); g.clip();
    drawRunways(g, nav, view, AC.white, 4);
    { const il = ilsFor(nav, S); if (il.valid && !S.onGround && il.dme < 25 && (S.gearHandleDown || S.ap.lat === 'LOC' || S.ap.appArmed)) drawCenterline(g, il, view, AC.white); }
    const dest = pickDestination(nav, S.x, S.z, S.track);
    // flight plan leg
    if (dest) {
      view.project(dest.x, dest.z);
      g.strokeStyle = AC.green; g.lineWidth = 4; line(g, ACX, ACY, view.px, view.py);
    }
    g.font = font(28); g.textAlign = 'left';
    for (const a of nav.airports) {
      view.project(a.x, a.z);
      const x = view.px, y = view.py;
      if (x < -50 || x > 1050 || y < 100 || y > 1000) continue;
      g.strokeStyle = AC.magenta; g.lineWidth = 3.5;
      line(g, x - 14, y, x + 14, y); line(g, x, y - 14, x, y + 14); line(g, x - 10, y - 10, x + 10, y + 10); line(g, x - 10, y + 10, x + 10, y - 10);
      text(g, a.icao, x + 20, y + 28, a === dest ? AC.white : AC.magenta, 'left');
    }
    // TCAS traffic
    const tt = traffic(clockSeconds());
    for (const o of tt) {
      const rel = (o.alt * FT - S.alt) / 100;
      if (Math.abs(rel) > 27 || o.kind === 'hostile') continue;
      view.project(o.x, o.z);
      const x = view.px, y = view.py;
      if (x < 20 || x > 980 || y < 150 || y > 980) continue;
      const d = Math.hypot(x - ACX, y - ACY) / k / NM;
      const prox = d < 6 && Math.abs(rel) < 12;
      g.strokeStyle = prox ? AC.cyan : AC.white; g.fillStyle = AC.cyan; g.lineWidth = 3;
      poly(g, [x, y - 13, x + 10, y, x, y + 13, x - 10, y]);
      if (prox) g.fill(); else g.stroke();
      const rs = (rel >= 0 ? '+' : '-') + pad(Math.abs(rel), 2);
      text(g, rs, x, rel >= 0 ? y - 20 : y + 40, prox ? AC.cyan : AC.white, 'center', font(24));
      if (Math.abs(o.vs * 196.85) > 500) { g.lineWidth = 3; const dir = o.vs > 0 ? -1 : 1; line(g, x + 20, y - 10 * dir, x + 20, y + 10 * dir); line(g, x + 14, y + 4 * dir, x + 20, y + 10 * dir); line(g, x + 26, y + 4 * dir, x + 20, y + 10 * dir); }
    }
    g.restore();
    // compass arc
    g.save(); g.beginPath(); g.rect(0, 120, 1000, 880); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3.5;
    g.beginPath(); g.arc(ACX, ACY, R, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    g.fillStyle = AC.white; g.textAlign = 'center';
    const h0 = S.hdgMag;
    for (let d = Math.ceil((h0 - 60) / 5) * 5; d <= h0 + 60; d += 5) {
      const a = (d - h0) * DEG, s = Math.sin(a), c = Math.cos(a), dd = wrap360(d);
      const len = dd % 10 === 0 ? 24 : 12;
      line(g, ACX + s * R, ACY - c * R, ACX + s * (R + len), ACY - c * (R + len));
      if (dd % 10 === 0) {
        g.save(); g.translate(ACX + s * (R + 50), ACY - c * (R + 50)); g.rotate(a);
        g.font = font(dd % 30 === 0 ? 40 : 30); g.fillText(String(dd / 10), 0, 12);
        g.restore();
      }
    }
    // track diamond
    const ta = wrap180(S.trackMag - h0) * DEG;
    g.save(); g.translate(ACX + Math.sin(ta) * (R - 16), ACY - Math.cos(ta) * (R - 16)); g.rotate(ta);
    g.strokeStyle = AC.green; g.lineWidth = 3.5; poly(g, [0, -14, 10, 0, 0, 14, -10, 0]); g.stroke(); g.restore();
    // selected heading
    if (S.ap.on) {
      const a = wrap180(S.ap.hdgMag - h0) * DEG;
      g.save(); g.translate(ACX + Math.sin(a) * R, ACY - Math.cos(a) * R); g.rotate(a);
      g.strokeStyle = AC.cyan; g.lineWidth = 4; poly(g, [0, 0, -12, -26, 12, -26]); g.stroke(); g.restore();
    }
    g.restore();
    over.blit(g);
    // ---------------- data
    g.font = font(30); g.textAlign = 'left';
    text(g, 'GS', 18, 48, AC.white, 'left', font(28));
    text(g, pad(S.gs, 1), 70, 48, AC.green, 'left', font(36));
    text(g, 'TAS', 170, 48, AC.white, 'left', font(28));
    text(g, S.tas < 100 ? '---' : String(Math.round(S.tas)), 235, 48, AC.green, 'left', font(36));
    if (S.tas >= 100 && !S.onGround) {
      text(g, (S.windSpd ? pad(Math.round(S.windDir) % 360, 3) : '000') + '/' + Math.round(S.windSpd), 18, 92, AC.green, 'left', font(34));
      if (S.windSpd >= 2) {
        const wa = (S.windDir + 180 - S.hdgMag) * DEG;
        g.save(); g.translate(46, 150); g.rotate(wa); g.strokeStyle = AC.green; g.lineWidth = 4;
        line(g, 0, -28, 0, 28); line(g, 0, 28, -10, 14); line(g, 0, 28, 10, 14); g.restore();
      }
    } else text(g, '---/---', 18, 92, AC.green, 'left', font(34));
    if (dest) {
      const brg = wrap360(bearingTo(S.x, S.z, dest.x, dest.z) - S.decl);
      const dnm = distTo(S.x, S.z, dest.x, dest.z) / NM;
      text(g, dest.icao, 760, 48, AC.white, 'left', font(34));
      text(g, pad(brg, 3) + '°', 985, 48, AC.green, 'right', font(34));
      text(g, dnm < 20 ? dnm.toFixed(1) : String(Math.round(dnm)), 900, 92, AC.green, 'right', font(36));
      text(g, 'NM', 985, 92, AC.cyan, 'right', font(28));
      const eta = S.gs > 30 ? dnm / S.gs * 3600 : 0;
      const d = new Date(Date.now() + eta * 1000);
      text(g, pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2), 985, 136, AC.green, 'right', font(34));
    }
    if (G) {
      text(g, 'TERR', 985, 900, AC.cyan, 'right', font(30));
      if (terr.hasContent) {
        const pk = Math.round(terr.peak / 100);
        text(g, pad(pk, 3), 985, 944, terr.peak - S.alt > 2000 ? AC.red : terr.peak - S.alt > -500 ? AC.amber : AC.green, 'right', font(30));
        text(g, '000', 985, 984, AC.green, 'right', font(30));
      }
    }
    if (S.warn.pullUp && Math.floor(S.t * 2.5) % 2 === 0) text(g, 'PULL UP', 500, 560, AC.red, 'center', font(56));
    else if (S.warn.gear) text(g, 'L/G NOT DOWN', 500, 560, AC.red, 'center', font(40));
  };
}

// ---------------------------------------------------------------- E/WD
function a320Ewd(env) {
  const E = [{ x: 190, y: 225 }, { x: 510, y: 225 }], R = 142;
  const n1Ang = (n) => (158 + clamp(n, 0, 112) / 110 * 214) * DEG;
  const egtAng = (t) => (180 + clamp(t, 0, 1200) / 1200 * 180) * DEG;
  const egtR = 92, egtY = 470, MX = 350;
  const state = { egt: [0, 0], ff: [0, 0], n2: [0, 0], flapAnim: 0, slatAnim: 0 };
  const under = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    for (const e of E) {
      // N1 dial
      g.strokeStyle = AC.white; g.lineWidth = 4.5;
      g.beginPath(); g.arc(e.x, e.y, R, n1Ang(0), n1Ang(101)); g.stroke();
      g.strokeStyle = AC.red; g.lineWidth = 8;
      g.beginPath(); g.arc(e.x, e.y, R, n1Ang(101.2), n1Ang(110)); g.stroke();
      g.strokeStyle = AC.white; g.lineWidth = 4.5;
      for (const v of [0, 25, 50, 75, 100]) {
        const a = n1Ang(v), l = v % 50 === 0 ? 22 : 12;
        line(g, e.x + Math.cos(a) * R, e.y + Math.sin(a) * R, e.x + Math.cos(a) * (R - l), e.y + Math.sin(a) * (R - l));
      }
      g.font = font(32); g.fillStyle = AC.white; g.textAlign = 'center';
      for (const [v, s] of [[50, '5'], [100, '10']]) { const a = n1Ang(v); g.fillText(s, e.x + Math.cos(a) * (R - 46), e.y + Math.sin(a) * (R - 46) + 11); }
      g.strokeStyle = '#7b8086'; g.lineWidth = 3; g.strokeRect(e.x - 4, e.y + 26, 132, 58);
      // EGT dial
      g.strokeStyle = AC.white; g.lineWidth = 4.5;
      g.beginPath(); g.arc(e.x, egtY, egtR, egtAng(0), egtAng(1060)); g.stroke();
      g.strokeStyle = AC.red; g.lineWidth = 7; g.beginPath(); g.arc(e.x, egtY, egtR, egtAng(1083), egtAng(1200)); g.stroke();
      g.strokeStyle = AC.amber; g.lineWidth = 5; const a = egtAng(1060);
      line(g, e.x + Math.cos(a) * egtR, egtY + Math.sin(a) * egtR, e.x + Math.cos(a) * (egtR - 18), egtY + Math.sin(a) * (egtR - 18));
      g.strokeStyle = '#7b8086'; g.lineWidth = 3; g.strokeRect(e.x - 50, egtY + 8, 100, 50);
    }
    // centre labels
    text(g, 'N1', MX, 300, AC.white, 'center', font(36)); text(g, '%', MX, 338, AC.cyan, 'center', font(30));
    text(g, 'EGT', MX, 488, AC.white, 'center', font(34)); text(g, '°C', MX, 524, AC.cyan, 'center', font(28));
    text(g, 'N2', MX - 8, 578, AC.white, 'right', font(32)); text(g, '%', MX + 8, 578, AC.cyan, 'left', font(28));
    text(g, 'FF', MX - 8, 626, AC.white, 'right', font(32)); text(g, 'KG/H', MX + 6, 626, AC.cyan, 'left', font(24));
    // right side
    text(g, 'FOB :', 690, 300, AC.white, 'left', font(34));
    text(g, 'KG', 985, 300, AC.cyan, 'right', font(28));
    text(g, 'S', 700, 450, AC.white, 'center', font(34)); text(g, 'F', 960, 450, AC.white, 'center', font(34));
    // memo separators
    g.strokeStyle = AC.white; g.lineWidth = 3;
    line(g, 10, 660, 990, 660); line(g, 640, 680, 640, 985);
  });
  // flap/slat indicator geometry (slats go down-left, flaps down-right)
  const slatPt = (p) => ({ x: 800 - p * 100, y: 432 + p * 44 });
  const flapPt = (p) => ({ x: 852 + p * 120, y: 432 + p * 54 });
  return (g, S) => {
    under.blit(g);
    const k = smoothK(S.dt, 2.5);
    for (let i = 0; i < 2; i++) {
      const e = E[i], en = S.engines[i];
      if (!en) continue;
      const n1 = en.present ? en.n1 : 0;
      const egtT = en.present ? (n1 < 5 ? 40 : 380 + 5.6 * n1 + 1.4 * Math.max(0, n1 - 80) ** 1.5) : 20;
      state.egt[i] += (egtT - state.egt[i]) * k;
      state.n2[i] += ((en.present ? (n1 < 5 ? n1 * 3 : 58 + 0.42 * n1) : 0) - state.n2[i]) * k;
      const ffT = en.present ? (en.ff > 0 ? en.ff : n1 < 5 ? 0 : 280 + 0.42 * n1 * n1 * (1 - S.alt / 70000)) : 0;
      state.ff[i] += (ffT - state.ff[i]) * k;
      // N1 needle + thrust lever position + limit
      const a = n1Ang(n1);
      g.strokeStyle = AC.green; g.lineWidth = 7;
      line(g, e.x + Math.cos(a) * R * 0.28, e.y + Math.sin(a) * R * 0.28, e.x + Math.cos(a) * (R + 8), e.y + Math.sin(a) * (R + 8));
      const lim = n1Ang(S.onGround ? 101 : 89.4);
      g.strokeStyle = AC.cyan; g.lineWidth = 5;
      line(g, e.x + Math.cos(lim) * (R - 6), e.y + Math.sin(lim) * (R - 6), e.x + Math.cos(lim) * (R + 14), e.y + Math.sin(lim) * (R + 14));
      const tla = n1Ang(19 + S.throttle * 82);
      g.strokeStyle = AC.cyan; g.lineWidth = 4; circle(g, e.x + Math.cos(tla) * (R + 22), e.y + Math.sin(tla) * (R + 22), 9); g.stroke();
      // N1 digits
      const n1c = n1 > 101.2 ? AC.red : AC.green;
      text(g, String(Math.floor(n1)), e.x + 92, e.y + 74, n1c, 'right', font(48));
      text(g, '.' + (Math.floor(n1 * 10) % 10), e.x + 124, e.y + 74, n1c, 'right', font(36));
      if (S.reverser > 0.05) text(g, 'REV', e.x, e.y - 50, S.reverser > 0.95 ? AC.green : AC.amber, 'center', font(38));
      // EGT
      const ea = egtAng(state.egt[i]);
      g.strokeStyle = AC.green; g.lineWidth = 6;
      line(g, e.x + Math.cos(ea) * 14, egtY + Math.sin(ea) * 14, e.x + Math.cos(ea) * (egtR + 6), egtY + Math.sin(ea) * (egtR + 6));
      text(g, String(Math.round(state.egt[i] / 5) * 5), e.x + 42, egtY + 48, state.egt[i] > 1060 ? AC.amber : AC.green, 'right', font(40));
      // N2 / FF
      const n2 = state.n2[i];
      text(g, String(Math.floor(n2)), e.x + 42, 578, AC.green, 'right', font(40));
      text(g, '.' + (Math.floor(n2 * 10) % 10), e.x + 70, 578, AC.green, 'right', font(30));
      text(g, String(Math.round(state.ff[i] / 20) * 20), e.x + 70, 626, AC.green, 'right', font(40));
    }
    // thrust limit
    const mode = S.onGround || (S.throttle > 0.95 && S.agl < 1500) ? 'TOGA' : S.throttle > 0.9 ? 'MCT' : 'CL';
    const lim = mode === 'TOGA' ? 101.0 : mode === 'MCT' ? 95.1 : 89.4 - Math.min(4, S.alt / 10000);
    text(g, mode, 700, 70, AC.cyan, 'left', font(38));
    text(g, lim.toFixed(1), 930, 70, AC.green, 'right', font(42));
    text(g, '%', 945, 70, AC.cyan, 'left', font(32));
    const both = S.engines[0] && S.engines[1];
    if (!S.onGround && both && S.engines[0].n1 < 30 && S.engines[1].n1 < 30 && S.engines[0].n1 > 5 && Math.floor(S.t) % 20 < 10) text(g, 'IDLE', MX, 110, AC.green, 'center', font(36));
    // FOB
    text(g, String(Math.round(S.fuel / 10) * 10 || 0), 935, 300, AC.green, 'right', font(42));
    // flaps / slats
    const k2 = smoothK(S.dt, 0.3);
    const pw = (v, xs, ys) => { for (let i = 1; i < xs.length; i++) if (v <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (v - xs[i - 1]) / (xs[i] - xs[i - 1]); return 1; };
    const fT = pw(S.flaps, [0, 0.29, 0.43, 0.57, 1], [0, 0.25, 0.5, 0.75, 1]), sT = pw(S.slats, [0, 0.67, 0.81, 1], [0, 1 / 3, 2 / 3, 1]);
    state.flapAnim += (fT - state.flapAnim) * k2;
    state.slatAnim += (sT - state.slatAnim) * k2;
    g.fillStyle = AC.white;
    for (const p of [0.33, 0.66, 1]) { const q = slatPt(p); circle(g, q.x, q.y, 4.5); g.fill(); }
    for (const p of [0.25, 0.5, 0.75, 1]) { const q = flapPt(p); circle(g, q.x, q.y, 4.5); g.fill(); }
    g.fillStyle = AC.white;
    poly(g, [800, 414, 848, 414, 858, 432, 792, 432]); g.fill();
    const sp = slatPt(state.slatAnim), fp = flapPt(state.flapAnim);
    const tr = Math.abs(state.flapAnim - fT) > 0.02 || Math.abs(state.slatAnim - sT) > 0.02;
    g.fillStyle = AC.green; g.strokeStyle = AC.green; g.lineWidth = 3;
    poly(g, [sp.x + 2, sp.y - 16, sp.x + 26, sp.y - 6, sp.x + 20, sp.y + 8, sp.x - 6, sp.y - 2]); g.fill();
    poly(g, [fp.x - 26, fp.y - 12, fp.x + 4, fp.y - 4, fp.x - 2, fp.y + 10, fp.x - 32, fp.y + 2]); g.fill();
    const f = S.flaps;
    const lbl = f < 0.01 && S.slats < 0.01 ? '' : /^(1\+F|1|2|3|FULL)$/i.test(S.flapsLabel) ? S.flapsLabel.toUpperCase() : f < 0.2 ? '1' : f < 0.45 ? '1+F' : f < 0.65 ? '2' : f < 0.85 ? '3' : 'FULL';
    if (lbl) text(g, lbl, 830, 552, tr ? AC.cyan : AC.green, 'center', font(40));
    if (lbl || tr) text(g, 'FLAP', 830, 396, AC.white, 'center', font(28));
    // ---------------- memo
    const L = [], Rm = [];
    const onRwy = S.onGround && S.gs < 40;
    if (S.warn.overspeed) L.push(['OVERSPEED', AC.red], ['-VMO/MMO.....350/.82', AC.cyan]);
    else if (S.warn.gear && !S.gearDown) L.push(['L/G GEAR NOT DOWN', AC.red]);
    else if (S.warn.stall) L.push(['STALL', AC.red]);
    else if (onRwy && S.engines[0] && S.engines[0].n1 > 15) {
      L.push([S.autobrake === 'RTO' || S.autobrake === 'MAX' ? 'T.O AUTO BRK MAX' : 'T.O AUTO BRK.....MAX', S.autobrake ? AC.green : AC.cyan], ['    SIGNS ON', AC.green], ['    CABIN....CHECK', AC.cyan], ['    SPLRS......ARM', AC.cyan],
        [S.flaps > 0.05 ? '    FLAPS T.O' : '    FLAPS......T.O', S.flaps > 0.05 ? AC.green : AC.cyan], ['    T.O CONFIG..TEST', AC.cyan]);
    } else if (!S.onGround && S.agl < 2000 && (S.gearHandleDown || S.flaps > 0.3)) {
      L.push([S.gearDown ? 'LDG LDG GEAR DN' : 'LDG LDG GEAR....DN', S.gearDown ? AC.green : AC.cyan], ['    SIGNS ON', AC.green], ['    CABIN....CHECK', AC.cyan],
        ['    SPLRS......ARM', AC.cyan], [S.flaps > 0.9 ? '    FLAPS FULL' : '    FLAPS.....FULL', S.flaps > 0.9 ? AC.green : AC.cyan]);
    }
    if (!S.onGround && S.agl < 1500 && S.vs > 100 && S.ias > 80) Rm.push(['T.O INHIBIT', AC.magenta]);
    if (!S.onGround && S.agl < 800 && S.vs < -100) Rm.push(['LDG INHIBIT', AC.magenta]);
    if (S.speedbrake > 0.05) Rm.push(['SPEED BRK', S.throttle > 0.25 && Math.floor(S.t * 2) % 2 ? AC.amber : AC.green]);
    if (S.spoilers > 0.05 && S.onGround) Rm.push(['GND SPLRS', AC.green]);
    if (S.autobrake && S.autobrake !== 'RTO' && !S.onGround) Rm.push(['AUTO BRK ' + S.autobrake, AC.green]);
    if (S.parkingBrake && S.onGround) Rm.push(['PARK BRK', AC.amber]);
    if (S.onGround || S.agl < 10000) Rm.push(['SEAT BELTS', AC.green], ['NO SMOKING', AC.green]);
    if (S.onGround && S.engines[0] && S.engines[0].n1 < 5) Rm.push(['APU AVAIL', AC.green]);
    if (S.ap.on && !S.onGround && Rm.length < 3) Rm.push(['AP 1 ENGD', AC.green]);
    g.font = font(31, true, true); g.textAlign = 'left';
    for (let i = 0; i < Math.min(7, L.length); i++) { g.fillStyle = L[i][1]; g.fillText(L[i][0], 24, 712 + i * 44); }
    for (let i = 0; i < Math.min(7, Rm.length); i++) { g.fillStyle = Rm[i][1]; g.fillText(Rm[i][0], 664, 712 + i * 44); }
  };
}

// ---------------------------------------------------------------- SD (auto paging WHEEL / DOOR / CRUISE)
function a320Sd(env) {
  const st = { temps: [60, 60, 60, 60], page: 'WHEEL', hold: 0, fuelUsed: [0, 0] };
  const title = (g, s) => {
    text(g, s, 28, 58, AC.white, 'left', font(40));
    g.font = font(40); const w = g.measureText(s).width;
    g.strokeStyle = AC.white; g.lineWidth = 3; line(g, 28, 66, 28 + w, 66);
  };
  const base = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    g.strokeStyle = AC.white; g.lineWidth = 3;
    line(g, 10, 870, 990, 870); line(g, 340, 870, 340, 990); line(g, 660, 870, 660, 990);
    text(g, 'TAT', 26, 912, AC.white, 'left', font(28)); text(g, 'SAT', 26, 962, AC.white, 'left', font(28));
    text(g, '°C', 290, 912, AC.cyan, 'left', font(26)); text(g, '°C', 290, 962, AC.cyan, 'left', font(26));
    text(g, 'H', 505, 936, AC.cyan, 'center', font(28));
    text(g, 'GW', 680, 936, AC.white, 'left', font(28)); text(g, 'KG', 972, 936, AC.cyan, 'right', font(26));
  });
  const wheelBg = env.layer((g) => {
    g.strokeStyle = AC.white; g.lineWidth = 3;
    text(g, 'WHEEL', 28, 58, AC.white, 'left', font(40)); g.font = font(40); line(g, 28, 66, 28 + g.measureText('WHEEL').width, 66);
    text(g, 'NORM BRK', 500, 640, AC.green, 'center', font(30));
    text(g, 'ANTI SKID', 500, 600, AC.white, 'center', font(26));
    for (const [x, a, b] of [[250, '1', '2'], [750, '3', '4']]) {
      text(g, a, x - 60, 780, AC.white, 'center', font(30)); text(g, b, x + 60, 780, AC.white, 'center', font(30));
      text(g, '°C', x, 744, AC.cyan, 'center', font(26));
      text(g, 'REL', x, 820, AC.white, 'center', font(24));
      g.strokeStyle = AC.white; g.lineWidth = 3;
      g.beginPath(); g.arc(x - 60, 760, 46, -Math.PI * 0.85, -Math.PI * 0.15); g.stroke();
      g.beginPath(); g.arc(x + 60, 760, 46, -Math.PI * 0.85, -Math.PI * 0.15); g.stroke();
    }
    text(g, 'SPD BRK', 500, 150, AC.white, 'center', font(26));
  });
  const doorBg = env.layer((g) => {
    text(g, 'DOOR/OXY', 28, 58, AC.white, 'left', font(40)); g.font = font(40);
    g.strokeStyle = AC.white; g.lineWidth = 3; line(g, 28, 66, 28 + g.measureText('DOOR/OXY').width, 66);
    // fuselage outline
    g.strokeStyle = AC.white; g.lineWidth = 4;
    g.beginPath();
    g.moveTo(500, 110); g.bezierCurveTo(560, 120, 580, 190, 580, 260); g.lineTo(580, 700); g.bezierCurveTo(580, 770, 540, 820, 500, 840);
    g.bezierCurveTo(460, 820, 420, 770, 420, 700); g.lineTo(420, 260); g.bezierCurveTo(420, 190, 440, 120, 500, 110); g.stroke();
    text(g, 'CKPT', 820, 150, AC.white, 'left', font(24));
    text(g, 'OXY', 780, 110, AC.white, 'left', font(28)); text(g, 'PSI', 960, 110, AC.cyan, 'right', font(24));
    const doors = [[415, 250, 'CABIN'], [585, 250, 'CABIN'], [415, 740, 'CABIN'], [585, 740, 'CABIN'], [415, 450, 'EMER EXIT'], [585, 450, 'EMER EXIT'], [415, 500, ''], [585, 500, '']];
    g.font = font(24);
    for (const [x, y, s] of doors) {
      g.strokeStyle = AC.green; g.lineWidth = 3; g.strokeRect(x - 9, y - 16, 18, 32);
      if (s) { g.fillStyle = AC.white; g.textAlign = x < 500 ? 'right' : 'left'; g.fillText(s, x < 500 ? x - 20 : x + 20, y + 8); }
    }
    g.strokeStyle = AC.green; g.strokeRect(470, 330, 60, 24); g.strokeRect(470, 620, 60, 24); g.strokeRect(488, 178, 24, 34);
    g.fillStyle = AC.white; g.textAlign = 'left';
    g.fillText('FWD CARGO', 600, 350); g.fillText('AFT CARGO', 600, 640); g.fillText('AVIONIC', 600, 200);
    text(g, 'SLIDE', 330, 290, AC.white, 'right', font(22)); text(g, 'SLIDE', 670, 290, AC.white, 'left', font(22));
  });
  const cruiseBg = env.layer((g) => {
    text(g, 'CRUISE', 28, 58, AC.white, 'left', font(40)); g.font = font(40);
    g.strokeStyle = AC.white; g.lineWidth = 3; line(g, 28, 66, 28 + g.measureText('CRUISE').width, 66);
    text(g, 'ENG', 500, 110, AC.green, 'center', font(32));
    text(g, 'F.USED', 500, 170, AC.white, 'center', font(28)); text(g, 'KG', 500, 204, AC.cyan, 'center', font(24));
    text(g, 'OIL', 500, 270, AC.white, 'center', font(28)); text(g, 'QT', 500, 304, AC.cyan, 'center', font(24));
    text(g, 'VIB', 500, 370, AC.white, 'center', font(28)); text(g, '(N1)', 500, 404, AC.white, 'center', font(24)); text(g, '(N2)', 500, 440, AC.white, 'center', font(24));
    g.strokeStyle = AC.white; line(g, 30, 480, 970, 480);
    text(g, 'AIR', 60, 530, AC.green, 'left', font(32));
    text(g, 'LDG ELEV', 90, 580, AC.white, 'left', font(28)); text(g, 'AUTO', 330, 580, AC.green, 'left', font(28));
    text(g, 'ΔP', 620, 580, AC.white, 'left', font(28)); text(g, 'PSI', 900, 580, AC.cyan, 'left', font(24));
    text(g, 'CAB V/S', 620, 650, AC.white, 'left', font(28)); text(g, 'FT/MIN', 900, 680, AC.cyan, 'left', font(22));
    text(g, 'CAB ALT', 620, 730, AC.white, 'left', font(28)); text(g, 'FT', 900, 760, AC.cyan, 'left', font(22));
    text(g, 'CKPT', 60, 700, AC.white, 'left', font(26)); text(g, 'FWD', 200, 700, AC.white, 'left', font(26)); text(g, 'AFT', 330, 700, AC.white, 'left', font(26));
    text(g, '°C', 460, 740, AC.cyan, 'left', font(24));
  });
  const gearSym = (g, x, y, S) => {
    // two triangles (one per LGCIU)
    if (S.gearUp) return;
    const col = S.gearDown ? AC.green : AC.red;
    for (const dx of [-26, 26]) {
      g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 3;
      poly(g, [x + dx - 20, y - 16, x + dx + 20, y - 16, x + dx, y + 20]);
      if (S.gearDown) g.fill(); else g.stroke();
    }
  };
  return (g, S) => {
    // page selection with hysteresis
    const want = S.onGround && S.gs < 3 && (!S.engines[0] || S.engines[0].n1 < 15) ? 'DOOR' : (!S.onGround && S.gearUp && S.agl > 1500) ? 'CRUISE' : 'WHEEL';
    if (want !== st.page) { st.hold += S.dt; if (st.hold > 2 || S.t < 0.5) { st.page = want; st.hold = 0; } } else st.hold = 0;
    // brake temperatures
    for (let i = 0; i < 4; i++) {
      const heat = S.onGround ? S.brakes * S.gs * 0.9 * (1 + 0.1 * i) : 0;
      st.temps[i] += heat * S.dt - (st.temps[i] - 40) * 0.004 * S.dt * (S.gearUp ? 1 : 3);
      st.temps[i] = clamp(st.temps[i], 20, 900);
    }
    for (let i = 0; i < 2; i++) { const e = S.engines[i]; if (e && e.present) st.fuelUsed[i] += (e.ff > 0 ? e.ff : 1200 * e.n1 / 85) / 3600 * S.dt; }
    base.blit(g);
    if (st.page === 'WHEEL') {
      wheelBg.blit(g);
      // spoilers
      const sp = Math.max(S.spoilers, S.speedbrake * 0.6);
      for (let i = 0; i < 5; i++) {
        for (const s of [-1, 1]) {
          const x = 500 + s * (110 + i * 60), y = 190;
          g.strokeStyle = AC.green; g.fillStyle = AC.green; g.lineWidth = 4;
          const up = S.spoilers > 0.05 || (S.speedbrake > 0.05 && i >= 1 && i <= 3);
          line(g, x - 20, y, x + 20, y);
          if (up) { poly(g, [x - 13, y - 8, x + 13, y - 8, x, y - 34 * clamp(sp * 1.6, 0.4, 1)]); g.fill(); }
        }
      }
      gearSym(g, 500, 330, S);
      gearSym(g, 250, 520, S);
      gearSym(g, 750, 520, S);
      if (S.gearTransit || S.gearHandleDown !== (S.gear > 0.5)) { text(g, 'L/G CTL', 500, 250, AC.amber, 'center', font(26)); text(g, 'UNLK', 500, 395, AC.red, 'center', font(26)); }
      // doors (green closed, amber in transit)
      g.strokeStyle = S.gearTransit ? AC.amber : AC.green; g.lineWidth = 5;
      for (const [x, y] of [[500, 290], [250, 480], [750, 480]]) { line(g, x - 50, y, x - 12, y); line(g, x + 12, y, x + 50, y); }
      // brake temps
      for (let i = 0; i < 4; i++) {
        const x = [190, 310, 690, 810][i], t = Math.round(st.temps[i] / 5) * 5;
        text(g, String(t), x, 710, t > 300 ? AC.amber : AC.green, 'center', font(34));
        if (t > 300 && t === Math.max(...st.temps.map((v) => Math.round(v / 5) * 5))) { g.strokeStyle = AC.amber; g.lineWidth = 3; g.strokeRect(x - 42, 676, 84, 46); }
      }
      if (S.onGround && S.brakes > 0.2) { text(g, 'REL', 250, 820, AC.green, 'center', font(24)); text(g, 'REL', 750, 820, AC.green, 'center', font(24)); }
      const ab = S.autobrake || (!S.onGround && S.gearHandleDown && !S.vsp.valid ? 'MED' : '');
      if (ab) { text(g, 'AUTO BRK', 500, 440, AC.green, 'center', font(30)); text(g, ab === 'RTO' ? 'MAX' : ab, 500, 476, AC.green, 'center', font(30)); }
      if (S.parkingBrake) text(g, 'PARK BRK', 500, 520, AC.amber, 'center', font(26));
    } else if (st.page === 'DOOR') {
      doorBg.blit(g);
      text(g, '1850', 940, 110, AC.green, 'right', font(30));
    } else {
      cruiseBg.blit(g);
      for (let i = 0; i < 2; i++) {
        const x = i === 0 ? 260 : 740, e = S.engines[i];
        const n1 = e ? e.n1 : 0;
        text(g, String(Math.round(st.fuelUsed[i] / 10) * 10), x, 185, AC.green, 'center', font(34));
        text(g, (17.5 - st.fuelUsed[i] / 2000).toFixed(1), x, 285, AC.green, 'center', font(34));
        text(g, (0.2 + n1 / 400).toFixed(1), x, 404, AC.green, 'center', font(30));
        text(g, (0.3 + n1 / 300).toFixed(1), x, 440, AC.green, 'center', font(30));
      }
      const cabAlt = clamp(S.alt * 0.2, 0, 8000);
      text(g, (cabAlt > 0 ? (S.alt - cabAlt) / 4400 : 0).toFixed(1), 880, 580, AC.green, 'right', font(32));
      text(g, String(Math.round(S.vs * 0.2 / 50) * 50), 880, 650, AC.green, 'right', font(32));
      text(g, String(Math.round(cabAlt / 50) * 50), 880, 730, AC.green, 'right', font(32));
      text(g, '22', 80, 740, AC.green, 'left', font(32)); text(g, '23', 210, 740, AC.green, 'left', font(32)); text(g, '23', 340, 740, AC.green, 'left', font(32));
    }
    // permanent data
    const sat = 15 - 1.98 * S.alt / 1000, tat = (sat + 273.15) * (1 + 0.2 * S.mach * S.mach) - 273.15;
    const sg = (v) => (v >= 0 ? '+' : '') + Math.round(v);
    text(g, sg(tat), 270, 912, AC.green, 'right', font(32));
    text(g, sg(sat), 270, 962, AC.green, 'right', font(32));
    const d = new Date();
    text(g, pad(d.getUTCHours(), 2), 480, 940, AC.green, 'right', font(36));
    text(g, pad(d.getUTCMinutes(), 2), 530, 940, AC.green, 'left', font(32));
    const specMass = num(S.spec && (S.spec.emptyMass ?? S.spec.mass?.empty ?? S.spec.massEmpty), 44300);
    text(g, String(Math.round((specMass + 9000 + S.fuel) / 100) * 100), 930, 936, AC.green, 'right', font(34));
    if (Math.abs(S.g - 1) > 0.4 && !S.onGround) text(g, 'G LOAD ' + S.g.toFixed(1), 500, 985, AC.amber, 'center', font(24));
  };
}

// ---------------------------------------------------------------- ISIS (standby)
function a320Isis(env) {
  const CX = 500, CY = 480, PPD = 13;
  const over = env.layer((g) => {
    // aircraft symbol
    g.fillStyle = '#000'; g.strokeStyle = AC.yellow; g.lineWidth = 4;
    for (const s of [-1, 1]) { poly(g, [CX + s * 170, CY - 7, CX + s * 70, CY - 7, CX + s * 70, CY + 26, CX + s * 84, CY + 26, CX + s * 84, CY + 7, CX + s * 170, CY + 7]); g.fill(); g.stroke(); }
    g.fillRect(CX - 9, CY - 9, 18, 18); g.strokeRect(CX - 9, CY - 9, 18, 18);
    // bank scale
    g.strokeStyle = AC.white; g.lineWidth = 4; const R = 300;
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const c = Math.cos((a - 90) * DEG), s = Math.sin((a - 90) * DEG), r2 = R + (Math.abs(a) % 30 === 0 ? 30 : 16);
      line(g, CX + c * R, CY + s * R, CX + c * r2, CY + s * r2);
    }
    g.fillStyle = AC.yellow; poly(g, [CX, CY - R + 2, CX - 15, CY - R - 24, CX + 15, CY - R - 24]); g.fill();
    // tape frames
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 150, 180, 700); g.fillRect(800, 150, 200, 700);
    g.strokeStyle = AC.white; g.lineWidth = 3; line(g, 180, 150, 180, 850); line(g, 800, 150, 800, 850);
    g.fillStyle = '#000'; g.fillRect(0, 850, 1000, 150); g.fillRect(0, 0, 1000, 150);
  });
  return (g, S) => {
    g.save(); g.beginPath(); g.rect(0, 150, 1000, 700); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const py = S.pitch * PPD;
    g.fillStyle = '#1f8ae6'; g.fillRect(-900, -1800 + py, 1800, 1800);
    g.fillStyle = '#7d4a1e'; g.fillRect(-900, py, 1800, 1800);
    g.strokeStyle = AC.white; g.lineWidth = 4; line(g, -900, py, 900, py);
    g.lineWidth = 3.5; g.fillStyle = AC.white; g.font = font(34); g.textAlign = 'center';
    for (let i = Math.ceil((S.pitch - 24) / 5); i <= Math.floor((S.pitch + 24) / 5); i++) {
      if (!i) continue;
      const a = i * 5, y = (S.pitch - a) * PPD, w = i % 2 === 0 ? 90 : 40;
      line(g, -w, y, w, y);
      if (i % 2 === 0) { g.fillText(String(Math.abs(a)), -w - 40, y + 12); g.fillText(String(Math.abs(a)), w + 40, y + 12); }
    }
    g.fillStyle = AC.white; poly(g, [0, -300, -14, -276, 14, -276]); g.fill();
    g.restore();
    over.blit(g);
    // speed tape
    g.save(); g.beginPath(); g.rect(0, 150, 180, 700); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.fillStyle = AC.white; g.font = font(40); g.textAlign = 'right';
    const ias = Math.max(30, S.ias);
    for (let v = Math.max(30, Math.floor((ias - 70) / 10) * 10); v <= ias + 70; v += 10) {
      const y = CY - (v - ias) * 5;
      line(g, 160, y, 180, y);
      if (v % 20 === 0) g.fillText(String(v), 145, y + 14);
    }
    g.restore();
    g.fillStyle = '#000'; g.strokeStyle = AC.yellow; g.lineWidth = 4;
    poly(g, [4, CY - 34, 150, CY - 34, 150, CY - 14, 176, CY, 150, CY + 14, 150, CY + 34, 4, CY + 34]); g.fill(); g.stroke();
    text(g, S.ias < 30 ? '---' : String(Math.round(S.ias)), 140, CY + 17, AC.white, 'right', font(50));
    // altitude tape
    g.save(); g.beginPath(); g.rect(800, 150, 200, 700); g.clip();
    g.strokeStyle = AC.white; g.lineWidth = 3; g.fillStyle = AC.white; g.font = font(34); g.textAlign = 'left';
    for (let a = Math.floor((S.alt - 700) / 100) * 100; a <= S.alt + 700; a += 100) {
      const y = CY - (a - S.alt) * 0.5;
      line(g, 800, y, 818, y);
      if (a % 500 === 0) g.fillText(String(a), 828, y + 12);
    }
    g.restore();
    g.fillStyle = '#000'; g.strokeStyle = AC.yellow; g.lineWidth = 4;
    poly(g, [800, CY, 826, CY - 14, 826, CY - 34, 996, CY - 34, 996, CY + 34, 826, CY + 34, 826, CY + 14]); g.fill(); g.stroke();
    text(g, String(Math.round(S.alt / 10) * 10), 988, CY + 17, AC.white, 'right', font(48));
    // bottom / top data
    text(g, '1013', 890, 930, AC.cyan, 'right', font(44)); text(g, 'HPA', 900, 930, AC.cyan, 'left', font(26));
    text(g, 'M', 30, 930, AC.white, 'left', font(36));
    text(g, S.mach.toFixed(2).replace(/^0/, ''), 70, 930, AC.white, 'left', font(44));
    text(g, 'BUGS', 500, 100, '#8e949a', 'center', font(30));
    if (S.tas > 20 && Math.abs(S.beta) > 0.1) {
      g.fillStyle = AC.white; const bx = CX + clamp(S.beta * 6, -60, 60); g.fillRect(bx - 18, CY - 272, 36, 10);
    }
  };
}

export const AIRBUS = {
  'a320.pfd': { vw: 1000, vh: 1000, size: 1024, create: a320Pfd },
  'a320.nd': { vw: 1000, vh: 1000, size: 1024, create: a320Nd },
  'a320.ewd': { vw: 1000, vh: 1000, size: 512, hz: 15, create: a320Ewd },
  'a320.sd': { vw: 1000, vh: 1000, size: 512, hz: 10, create: a320Sd },
  'a320.isis': { vw: 1000, vh: 1000, size: 512, create: a320Isis },
};
