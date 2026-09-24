// Boeing 737-800 (NG) displays: PFD, ND (MAP mode), upper EICAS (primary engine display) and a CDU page.
import { font, text, line, poly, circle, stripes, rrect, clamp, lerp, wrap360, wrap180, pad, num, DEG, NM, FT, smoothK } from './core.js';
import { MapView, drawRunways, terrainGrid, TerrainAlertImage, pickDestination, bearingTo, distTo, traffic, clockSeconds, ilsFor, drawCenterline, drawRouteND, routeIdent } from './nav.js';
import { localToLonLat } from '../geo.js';

export const BC = {
  white: '#ffffff', magenta: '#ff4dff', green: '#29ff4a', cyan: '#2ee6ff', amber: '#ffb300', red: '#ff2a2a',
  sky: '#1a8ee6', gnd: '#94592c', tape: '#454b52', grey: '#8c949c', black: '#000000',
};

// ---------------------------------------------------------------- mode annunciations (FMA)
function b737Fma(S) {
  const ap = S.ap, altErr = ap.alt - S.alt;
  let at = '', roll = '', pitch = '', rollArm = '', pitchArm = '', status = 'FD';
  if (S.onGround && !(ap.on && (ap.vert === 'ROLLOUT' || ap.vert === 'FLARE'))) {
    if (S.throttle > 0.8) { at = S.gs < 84 ? 'N1' : 'THR HLD'; pitch = 'TO/GA'; rollArm = 'LNAV'; pitchArm = 'VNAV'; }
  } else if (ap.on) {
    status = 'CMD';
    const v = ap.vert || (Math.abs(altErr) < 60 ? 'ALT' : altErr > 0 ? 'CLB' : 'DES');
    if (ap.athr) at = v === 'CLB' ? 'N1' : v === 'DES' ? (S.throttle < 0.3 ? 'ARM' : 'RETARD') : v === 'FLARE' ? 'RETARD' : v === 'ROLLOUT' ? 'ARM' : 'MCP SPD';
    roll = ap.lat === 'LOC' ? 'VOR/LOC' : ap.lat === 'NAV' ? 'LNAV' : ap.lat === 'LAND' ? 'ROLLOUT' : 'HDG SEL';
    if (v === 'G/S') pitch = 'G/S';
    else if (v === 'FLARE' || v === 'LAND') { pitch = 'FLARE'; roll = 'VOR/LOC'; }
    else if (v === 'ROLLOUT') { pitch = 'FLARE'; roll = 'ROLLOUT'; }
    else if (v === 'V/S') pitch = 'V/S';
    else if (v === 'CLB' || v === 'DES') pitch = Math.abs(altErr) < 300 ? 'ALT ACQ' : 'LVL CHG';
    else pitch = 'ALT HOLD';
    if (ap.appArmed) { if (ap.lat !== 'LOC') rollArm = 'VOR/LOC'; if (v !== 'G/S') pitchArm = 'G/S'; }
    else if (v === 'G/S' && S.agl > 50) pitchArm = 'FLARE';
    if (v === 'G/S' && S.agl < 1500 || v === 'FLARE' || v === 'LAND' || v === 'ROLLOUT') status = 'LAND 3';
  } else if (S.throttle > 0.95) { at = 'N1'; pitch = 'TO/GA'; }
  return { at, roll, pitch, rollArm, pitchArm, status };
}

// ---------------------------------------------------------------- PFD
function b737Pfd(env) {
  const CX = 490, CY = 470, PPD = 9.6;
  const SP = { x0: 58, x1: 178, y0: 196, y1: 744, k: 4.4 };
  const AL = { x0: 770, x1: 872, y0: 196, y1: 744, k: 0.68 };
  const VS = { x0: 912, x1: 992, y0: 236, y1: 704 };
  const HR = { cx: CX, cy: 1215, r: 400 };
  const prev = { at: '', roll: '', pitch: '' }, boxT = { at: 0, roll: 0, pitch: 0 };
  const vsY = (v) => {
    const a = Math.abs(v), s = Math.sign(v), half = (VS.y1 - VS.y0) / 2 - 20;
    const f = a <= 1000 ? 0.4 * a / 1000 : a <= 2000 ? 0.4 + 0.3 * (a - 1000) / 1000 : 0.7 + 0.3 * Math.min(1, (a - 2000) / 4000);
    return CY - s * f * half;
  };
  const attClip = (g) => rrect(g, 244, 196, 492, 548, 42);
  const under = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    g.strokeStyle = BC.white; g.lineWidth = 2.5;
    line(g, 386, 12, 386, 96); line(g, 600, 12, 600, 96);
    // VSI
    g.fillStyle = '#3a3f45';
    poly(g, [VS.x0, VS.y0 + 30, VS.x0 + 30, VS.y0, VS.x1, VS.y0, VS.x1, VS.y0 + 150, VS.x1 - 30, CY - 40, VS.x1 - 30, CY + 40, VS.x1, VS.y1 - 150, VS.x1, VS.y1, VS.x0 + 30, VS.y1, VS.x0, VS.y1 - 30]);
    g.fill();
    g.strokeStyle = BC.white; g.lineWidth = 3; g.font = font(26); g.fillStyle = BC.white; g.textAlign = 'center';
    for (const v of [500, 1000, 1500, 2000, 4000, 6000]) for (const s of [1, -1]) {
      const y = vsY(s * v), big = v === 1000 || v === 2000 || v === 6000;
      line(g, VS.x0 + 22, y, VS.x0 + (big ? 42 : 34), y);
      if (big) g.fillText(String(v / 1000), VS.x0 + 11, y + 9);
    }
    line(g, VS.x0 + 18, CY, VS.x0 + 48, CY);
    // tapes
    g.fillStyle = BC.tape;
    g.fillRect(SP.x0, SP.y0, SP.x1 - SP.x0, SP.y1 - SP.y0);
    g.fillRect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0);
  });
  const over = env.layer((g) => {
    // aircraft symbol (white outline, black fill)
    g.lineWidth = 4; g.strokeStyle = BC.white; g.fillStyle = '#000';
    for (const s of [-1, 1]) { poly(g, [CX + s * 150, CY - 7, CX + s * 58, CY - 7, CX + s * 58, CY + 34, CX + s * 72, CY + 34, CX + s * 72, CY + 7, CX + s * 150, CY + 7]); g.fill(); g.stroke(); }
    g.fillRect(CX - 9, CY - 9, 18, 18); g.strokeRect(CX - 9, CY - 9, 18, 18);
    // bank scale (fixed)
    const R = 250;
    g.strokeStyle = BC.white; g.lineWidth = 3.5;
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const c = Math.cos((a - 90) * DEG), s = Math.sin((a - 90) * DEG), l = Math.abs(a) === 30 || Math.abs(a) === 60 ? 28 : Math.abs(a) === 45 ? 0 : 16;
      if (l) line(g, CX + c * R, CY + s * R, CX + c * (R + l), CY + s * (R + l));
      else { g.save(); g.translate(CX + c * R, CY + s * R); g.rotate(a * DEG); poly(g, [0, 0, -8, -16, 8, -16]); g.stroke(); g.restore(); }
    }
    poly(g, [CX, CY - R, CX - 14, CY - R - 24, CX + 14, CY - R - 24]); g.stroke();
    // heading rose pointer
    g.fillStyle = BC.white; poly(g, [CX, HR.cy - HR.r + 2, CX - 13, HR.cy - HR.r - 20, CX + 13, HR.cy - HR.r - 20]); g.fill();
  });
  // readout boxes with the taller rolling-digit windows (speed: last digit, altitude: last two digits)
  const SB = { x0: SP.x0 - 6, x1: SP.x1 - 22, d0: SP.x1 - 58 };
  const AB = { x0: AL.x0 + 18, x1: AL.x1 + 34, d0: AL.x1 - 12 };
  const boxes = env.layer((g) => {
    g.fillStyle = '#000'; g.strokeStyle = BC.white; g.lineWidth = 3.5;
    poly(g, [SB.x0, CY - 34, SB.d0, CY - 34, SB.d0, CY - 54, SB.x1, CY - 54, SB.x1, CY - 14, SB.x1 + 16, CY, SB.x1, CY + 14, SB.x1, CY + 54, SB.d0, CY + 54, SB.d0, CY + 34, SB.x0, CY + 34]);
    g.fill(); g.stroke();
    poly(g, [AB.x0 - 16, CY, AB.x0, CY - 14, AB.x0, CY - 34, AB.d0, CY - 34, AB.d0, CY - 54, AB.x1, CY - 54, AB.x1, CY + 54, AB.d0, CY + 54, AB.d0, CY + 34, AB.x0, CY + 34, AB.x0, CY + 14]);
    g.fill(); g.stroke();
  });
  return (g, S, ctx) => {
    under.blit(g);
    const f = b737Fma(S);
    for (const k of ['at', 'roll', 'pitch']) { if (f[k] !== prev[k]) { if (f[k]) boxT[k] = S.t + 10; prev[k] = f[k]; } }
    // ---------------- attitude
    g.save(); attClip(g); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const py = S.pitch * PPD;
    g.fillStyle = BC.sky; g.fillRect(-800, -1600 + py, 1600, 1600);
    g.fillStyle = BC.gnd; g.fillRect(-800, py, 1600, 1600);
    g.strokeStyle = BC.white; g.lineWidth = 3.5; line(g, -800, py, 800, py);
    g.restore();
    g.save(); g.beginPath(); g.arc(CX, CY, 238, 0, Math.PI * 2); g.clip();
    g.translate(CX, CY); g.rotate(-S.roll * DEG);
    g.strokeStyle = BC.white; g.fillStyle = BC.white; g.lineWidth = 3.5; g.font = font(28); g.textAlign = 'center';
    for (let i = Math.ceil((S.pitch - 25) / 2.5); i <= Math.floor((S.pitch + 25) / 2.5); i++) {
      if (!i || Math.abs(i) > 36) continue;
      const a = i * 2.5, y = (S.pitch - a) * PPD, w = i % 4 === 0 ? 90 : i % 2 === 0 ? 46 : 22;
      line(g, -w, y, w, y);
      if (i % 4 === 0) { const s = String(Math.abs(a)); g.fillText(s, -w - 30, y + 10); g.fillText(s, w + 30, y + 10); }
    }
    g.restore();
    // bank pointer + slip
    g.save(); g.translate(CX, CY); g.rotate(-S.roll * DEG);
    const amber = Math.abs(S.roll) > 35;
    g.fillStyle = amber ? BC.amber : BC.white; g.strokeStyle = g.fillStyle;
    poly(g, [0, -248, -14, -224, 14, -224]); if (amber) g.fill(); else { g.lineWidth = 3.5; g.stroke(); }
    const sl = clamp(S.beta * 3, -30, 30);
    g.fillRect(-16 + sl, -218, 32, 9);
    g.restore();
    // flight director
    if ((S.ap.on || S.throttle > 0.95) && (!S.onGround || S.gs > 40)) {
      const pc = clamp((S.ap.on ? clamp((S.ap.alt - S.alt) / 150, -5, 8) : 15) - S.pitch, -15, 15);
      const rc = clamp((S.ap.on ? clamp(wrap180(S.ap.hdg - S.hdg) * 1.5, -25, 25) : 0) - S.roll, -20, 20);
      g.strokeStyle = BC.magenta; g.lineWidth = 6;
      line(g, CX - 120, CY - pc * 7, CX + 120, CY - pc * 7);
      line(g, CX + rc * 4.5, CY - 120, CX + rc * 4.5, CY + 120);
    }
    over.blit(g);
    // ILS deviation (LOC scale at the bottom of the ADI, G/S scale on its right edge) + ident block
    const ils = ilsFor(ctx.nav, S);
    if (ils.valid && !S.onGround && (S.ap.lat === 'LOC' || S.ap.vert === 'G/S' || S.ap.appArmed || (S.gearHandleDown && ils.dme < 20))) {
      g.strokeStyle = BC.white; g.lineWidth = 3;
      for (const k of [-2, -1, 1, 2]) { circle(g, CX + k * 40, 722, 7); g.stroke(); circle(g, 712, CY + k * 40, 7); g.stroke(); }
      line(g, CX, 708, CX, 736); line(g, 698, CY, 726, CY);
      g.fillStyle = BC.magenta; g.strokeStyle = BC.magenta;
      const lx = CX + clamp(ils.loc, -2.3, 2.3) * 40;
      poly(g, [lx - 18, 722, lx, 710, lx + 18, 722, lx, 734]); if (Math.abs(ils.loc) < 2.3) g.fill(); else g.stroke();
      if (ils.gsValid) { const gy = CY - clamp(ils.gs, -2.3, 2.3) * 40; poly(g, [712, gy - 18, 724, gy, 712, gy + 18, 700, gy]); if (Math.abs(ils.gs) < 2.3) g.fill(); else g.stroke(); }
      text(g, ils.ident + '/' + pad(Math.round(ils.course) % 360, 3) + '°', 262, 232, BC.white, 'left', font(26));
      text(g, 'DME ' + ils.dme.toFixed(1), 262, 264, BC.white, 'left', font(26));
    }
    // radio altitude
    if (S.radioAlt < 2500) {
      const belowMins = S.radioAlt < 200 && !S.onGround && S.gearDown;
      text(g, 'RADIO', CX + 170, 250, BC.green, 'center', font(24));
      text(g, '200', CX + 170, 282, BC.green, 'center', font(30));
      const ra = S.radioAlt < 100 ? Math.round(S.radioAlt / 2) * 2 : Math.round(S.radioAlt / 10) * 10;
      g.fillStyle = '#000'; g.fillRect(CX - 58, 662, 116, 44);
      text(g, String(ra), CX, 698, belowMins ? BC.amber : BC.white, 'center', font(38));
    }
    // ---------------- speed tape
    const ias = Math.max(45, S.ias);
    g.save(); g.beginPath(); g.rect(SP.x0, SP.y0, SP.x1 - SP.x0 + 40, SP.y1 - SP.y0); g.clip();
    g.strokeStyle = BC.white; g.lineWidth = 3; g.fillStyle = BC.white; g.font = font(32); g.textAlign = 'right';
    const yOf = (v) => CY - (v - ias) * SP.k;
    for (let v = Math.max(40, Math.floor((ias - 66) / 10) * 10); v <= ias + 66; v += 10) {
      const y = yOf(v);
      line(g, SP.x1 - 18, y, SP.x1, y);
      if (v % 20 === 0) g.fillText(String(v), SP.x1 - 24, y + 11);
    }
    if (!S.onGround) {
      const V = S.vsp;
      let vmo = V.vmo > 0 ? V.vmo : 340;
      if (V.mmo > 0 && S.mach > 0.3) vmo = Math.min(vmo, S.ias * V.mmo / S.mach);
      const vfe = V.vfe > 0 ? V.vfe : S.flaps > 0.01 ? lerp(250, 162, S.flaps) : 0;
      if (vfe > 0) vmo = Math.min(vmo, vfe);
      if (!S.gearUp) vmo = Math.min(vmo, V.vle > 0 ? V.vle : 320);
      const vmin = V.valid ? V.vs1g * 1.3 : lerp(215, 130, S.flaps), vshake = V.valid ? V.vs1g * 1.07 : vmin - 25;
      if (yOf(vmo) > SP.y0) stripes(g, SP.x1 - 2, SP.y0, yOf(vmo), 12, BC.red, '#000', 12);
      g.strokeStyle = BC.amber; g.lineWidth = 3;
      g.strokeRect(SP.x1 - 2, yOf(vmin), 10, Math.max(0, yOf(vshake) - yOf(vmin)));
      if (yOf(vshake) < SP.y1) stripes(g, SP.x1 - 2, yOf(vshake), SP.y1, 12, BC.red, '#000', 12);
      // flap manoeuvre speeds (by detent) and the VREF bug
      g.font = font(24); g.textAlign = 'left'; g.fillStyle = BC.green; g.strokeStyle = BC.green; g.lineWidth = 3;
      const L = S.flapsLabel.toUpperCase();
      const fm = L === 'UP' || L === '0' || S.flaps < 0.01 ? [['UP', 212]] : L === '1' ? [['UP', 212], ['1', 192]] : L === '2' || L === '5' ? [['1', 192], ['5', 172]] : L === '10' || L === '15' ? [['5', 172], ['15', 152]] : [['15', 152]];
      for (const [l, v] of fm) { const y = yOf(v); line(g, SP.x1, y, SP.x1 + 12, y); g.fillText(l, SP.x1 + 14, y + 9); }
      const vref = V.vref > 0 ? V.vref : V.vapp > 0 ? V.vapp - 5 : 0;
      if (vref > 0 && (S.gearHandleDown || S.flaps > 0.5)) { const y = yOf(vref); line(g, SP.x1, y, SP.x1 + 12, y); g.fillText('REF', SP.x1 + 14, y + 9); }
    }
    // takeoff V1 / VR bugs (V2 is the selected speed)
    const V = S.vsp, tko = V.vr > 0 && (S.onGround ? S.throttle > 0.5 || S.gs > 30 : S.agl < 1500 && S.vs > 0 && S.flaps > 0.01 && !S.ap.on);
    if (tko && S.onGround) {
      g.font = font(24); g.textAlign = 'left'; g.fillStyle = BC.green; g.strokeStyle = BC.green; g.lineWidth = 3;
      for (const [l, v] of [['V1', V.vr * 0.97], ['VR', V.vr]]) { const y = yOf(v); line(g, SP.x1, y, SP.x1 + 12, y); g.fillText(l, SP.x1 + 14, y + 9); }
    }
    // speed bug
    const tgt = S.ap.on && S.ap.hasSpd ? S.ap.spd : tko && V.v2 > 0 ? V.v2 + (S.onGround ? 0 : 15) : S.onGround ? 145 : 0;
    if (tgt) {
      const y = clamp(yOf(tgt), SP.y0, SP.y1);
      g.strokeStyle = BC.magenta; g.lineWidth = 4;
      poly(g, [SP.x1 + 2, y - 18, SP.x1 + 20, y - 18, SP.x1 + 20, y + 18, SP.x1 + 2, y + 18, SP.x1 + 2, y + 6, SP.x1 + 12, y, SP.x1 + 2, y - 6]); g.stroke();
    }
    g.restore();
    text(g, tgt ? String(Math.round(tgt)) : '', 118, 180, BC.magenta, 'center', font(36));
    // trend vector
    if (Math.abs(S.iasTrend) > 2 && !S.onGround) {
      const y2 = clamp(CY - S.iasTrend * SP.k, SP.y0, SP.y1), x = SP.x1 - 6;
      g.strokeStyle = BC.green; g.lineWidth = 3.5; line(g, x, CY, x, y2);
      const d = Math.sign(CY - y2); poly(g, [x - 9, y2 + d * 14, x, y2, x + 9, y2 + d * 14], false); g.stroke();
    }
    text(g, S.mach >= 0.4 ? '.' + pad(Math.round(S.mach * 1000), 3) : 'GS ' + Math.round(S.gs), 118, 800, BC.white, 'center', font(36));
    // ---------------- altitude tape
    const alt = S.alt, ay = (a) => CY - (a - alt) * AL.k;
    g.save(); g.beginPath(); g.rect(AL.x0, AL.y0, AL.x1 - AL.x0, AL.y1 - AL.y0); g.clip();
    g.strokeStyle = BC.white; g.lineWidth = 3; g.fillStyle = BC.white; g.textAlign = 'right';
    for (let a = Math.floor((alt - 420) / 100) * 100; a <= alt + 420; a += 100) {
      const y = ay(a);
      line(g, AL.x0, y, AL.x0 + 16, y);
      if (a % 200 === 0) {
        const th = Math.floor(Math.abs(a) / 1000), hu = Math.abs(a) % 1000;
        g.font = font(22); g.fillText(pad(hu, 3), AL.x1 - 6, y + 9);
        if (th) { g.font = font(30); g.fillText((a < 0 ? '-' : '') + th, AL.x1 - 50, y + 11); }
        if (a % 1000 === 0) { line(g, AL.x0 + 22, y - 18, AL.x1, y - 18); line(g, AL.x0 + 22, y + 18, AL.x1, y + 18); }
      }
    }
    const gnd = S.alt - S.agl;
    if (ay(gnd) < AL.y1) { g.fillStyle = BC.amber; g.fillRect(AL.x0, ay(gnd), AL.x1 - AL.x0, 6); }
    const selAlt = S.ap.on ? S.ap.alt : 0;
    if (selAlt) {
      const y = clamp(ay(selAlt), AL.y0, AL.y1);
      g.strokeStyle = BC.magenta; g.lineWidth = 4;
      poly(g, [AL.x0 + 2, y - 26, AL.x0 + 34, y - 26, AL.x0 + 34, y + 26, AL.x0 + 2, y + 26, AL.x0 + 2, y + 8, AL.x0 + 14, y, AL.x0 + 2, y - 8]); g.stroke();
    }
    g.restore();
    if (selAlt) {
      const s = String(Math.round(selAlt / 100) * 100);
      text(g, s.length > 3 ? s.slice(0, -3) : '', 850, 180, BC.magenta, 'right', font(36));
      text(g, s.slice(-3), 852, 180, BC.magenta, 'left', font(28));
    }
    boxes.blit(g);
    // speed readout (rolling last digit)
    const iv = Math.max(0, S.ias), ones = iv % 10, tens = Math.floor(iv / 10);
    g.font = font(50); g.fillStyle = BC.white; g.textAlign = 'right';
    if (iv >= 45) g.fillText(String(tens), SB.d0 - 2, CY + 18);
    g.save(); g.beginPath(); g.rect(SB.d0 + 2, CY - 52, SB.x1 - SB.d0 - 4, 104); g.clip();
    for (let k = -2; k <= 2; k++) {
      const d = Math.floor(ones) + k, y = CY + 18 + (ones - d) * 40;
      g.fillText(iv < 45 ? '-' : String(((d % 10) + 10) % 10), SB.x1 - 4, y);
    }
    g.restore();
    // altitude readout (thousands large, hundreds, rolling 20-ft drum)
    const aa = Math.abs(alt), thou = Math.floor(aa / 1000), hund = Math.floor((aa % 1000) / 100), twenty = aa % 100;
    g.fillStyle = BC.white; g.textAlign = 'right';
    g.font = font(46); if (thou) g.fillText((alt < 0 ? '-' : '') + thou, AB.d0 - 26, CY + 17);
    g.font = font(36); g.fillText(String(hund), AB.d0 - 2, CY + 15);
    g.save(); g.beginPath(); g.rect(AB.d0 + 2, CY - 52, AB.x1 - AB.d0 - 4, 104); g.clip();
    g.font = font(30);
    const b20 = Math.floor(twenty / 20) * 20;
    for (let k = -2; k <= 3; k++) { const v = b20 + k * 20, y = CY + 11 + (twenty - v) * 1.55; g.fillText(pad(((v % 100) + 100) % 100, 2), AB.x1 - 4, y); }
    g.restore();
    text(g, S.alt > 18000 ? 'STD' : '29.92 IN', 830, 800, BC.green, 'center', font(32));
    // ---------------- VSI
    const vy = vsY(clamp(S.vs, -6200, 6200));
    g.strokeStyle = BC.white; g.lineWidth = 5;
    line(g, VS.x0 + 26, vy, VS.x1 + 60, CY + (vy - CY) * -0.1);
    if (Math.abs(S.vs) >= 400) text(g, String(Math.round(Math.abs(S.vs) / 50) * 50), 952, S.vs > 0 ? VS.y0 - 12 : VS.y1 + 36, BC.white, 'center', font(28));
    // ---------------- heading rose
    g.save(); g.beginPath(); g.rect(200, 790, 600, 210); g.clip();
    g.fillStyle = '#2c3137'; circle(g, HR.cx, HR.cy, HR.r); g.fill();
    g.strokeStyle = BC.white; g.lineWidth = 3; g.fillStyle = BC.white; g.textAlign = 'center';
    const h0 = S.hdgMag;
    for (let d = Math.ceil((h0 - 50) / 5) * 5; d <= h0 + 50; d += 5) {
      const a = (d - h0) * DEG, s = Math.sin(a), c = Math.cos(a), dd = wrap360(d), l = dd % 10 === 0 ? 24 : 13;
      line(g, HR.cx + s * HR.r, HR.cy - c * HR.r, HR.cx + s * (HR.r - l), HR.cy - c * (HR.r - l));
      if (dd % 30 === 0 || dd % 10 === 0) {
        g.save(); g.translate(HR.cx + s * (HR.r - 46), HR.cy - c * (HR.r - 46)); g.rotate(a);
        g.font = font(dd % 30 === 0 ? 34 : 26); g.fillText(String(dd / 10), 0, 12); g.restore();
      }
    }
    // track line
    const ta = wrap180(S.trackMag - h0) * DEG;
    g.lineWidth = 3; line(g, HR.cx + Math.sin(ta) * (HR.r - 60), HR.cy - Math.cos(ta) * (HR.r - 60), HR.cx + Math.sin(ta) * (HR.r - 180), HR.cy - Math.cos(ta) * (HR.r - 180));
    if (S.ap.on) {
      const a = wrap180(S.ap.hdgMag - h0) * DEG;
      g.save(); g.translate(HR.cx + Math.sin(a) * HR.r, HR.cy - Math.cos(a) * HR.r); g.rotate(a);
      g.strokeStyle = BC.magenta; g.lineWidth = 4; poly(g, [-16, 0, -16, 16, 16, 16, 16, 0, 6, 0, 0, 10, -6, 0]); g.stroke(); g.restore();
    }
    g.restore();
    text(g, 'MAG', CX + 100, 818, BC.green, 'left', font(26));
    // ---------------- FMA
    g.textAlign = 'center';
    const fmaCol = [[f.at, '', 285, 'at'], [f.roll, f.rollArm, 493, 'roll'], [f.pitch, f.pitchArm, 700, 'pitch']];
    for (const [act, arm, x, k] of fmaCol) {
      if (act) text(g, act, x, 50, BC.green, 'center', font(34));
      if (arm) text(g, arm, x, 88, BC.white, 'center', font(26));
      if (act && boxT[k] > S.t) { g.strokeStyle = BC.green; g.lineWidth = 3; g.strokeRect(x - 96, 16, 192, 44); }
    }
    text(g, f.status, CX, 150, BC.green, 'center', font(40));
    if (S.warn.pullUp && Math.floor(S.t * 2.5) % 2 === 0) text(g, 'PULL UP', CX, 610, BC.red, 'center', font(48));
    else if (S.warn.stall) text(g, 'STALL', CX, 610, BC.red, 'center', font(44));
  };
}

// ---------------------------------------------------------------- ND (MAP)
// planned route (map + LNAV): Boeing draws the active route magenta, waypoints white stars, the active one magenta
const B_ROUTE = { active: BC.magenta, legs: BC.magenta, sym: BC.white, toSym: BC.magenta, label: BC.white, toLabel: BC.magenta };
function b737Nd(env) {
  const ACX = 500, ACY = 810, R = 600;
  const view = new MapView();
  const terr = new TerrainAlertImage();
  let range = 20;
  const bg = env.layer((g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000); });
  const over = env.layer((g) => {
    g.strokeStyle = BC.white; g.lineWidth = 4;
    poly(g, [ACX, ACY - 4, ACX - 22, ACY + 44, ACX + 22, ACY + 44]); g.stroke();
    // track box
    g.fillStyle = '#000'; g.fillRect(ACX - 58, 128, 116, 52);
    g.strokeStyle = BC.white; g.lineWidth = 3; g.strokeRect(ACX - 58, 128, 116, 52);
    text(g, 'TRK', ACX - 72, 168, BC.green, 'right', font(28)); text(g, 'MAG', ACX + 72, 168, BC.green, 'left', font(28));
  });
  return (g, S, ctx) => {
    const nav = ctx.nav, G = terrainGrid(ctx.world);
    range = S.onGround || S.agl < 2500 ? 10 : S.alt < 12000 ? 20 : 40;
    const k = R / (range * NM);
    bg.blit(g);
    view.set(ACX, ACY, S.x, S.z, S.track, k);
    if (G) {
      G.tick();
      let floorFt = 0, bd = Infinity;
      for (const a of nav.airports) { const d = distTo(S.x, S.z, a.x, a.z); if (d < bd) { bd = d; floorFt = a.elev * FT + 400; } }
      terr.update(G, S.alt, floorFt, S.gearDown);
      if (terr.hasContent) { g.save(); circle(g, ACX, ACY, R); g.clip(); view.apply(g); terr.draw(g); g.restore(); }
    }
    // half range arc
    g.save(); g.beginPath(); g.rect(0, 190, 1000, 810); g.clip();
    g.strokeStyle = BC.white; g.lineWidth = 3;
    g.beginPath(); g.arc(ACX, ACY, R / 2, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
    text(g, String(range / 2), ACX - R / 2 * Math.sin(66 * DEG) - 8, ACY - R / 2 * Math.cos(66 * DEG) + 4, BC.white, 'right', font(30));
    g.restore();
    // map
    g.save(); circle(g, ACX, ACY, R); g.clip();
    drawRunways(g, nav, view, BC.white, 4);
    { const il = ilsFor(nav, S); if (il.valid && !S.onGround && il.dme < 25 && (S.gearHandleDown || S.ap.lat === 'LOC' || S.ap.appArmed)) drawCenterline(g, il, view, BC.white); }
    const to = S.route ? drawRouteND(g, S, view, B_ROUTE, 'star') : null;   // planned route, else the airport ahead
    const dest = to ? null : pickDestination(nav, S.x, S.z, S.track);
    if (dest) { view.project(dest.x, dest.z); g.strokeStyle = BC.magenta; g.lineWidth = 4; line(g, ACX, ACY, view.px, view.py); }
    for (const a of nav.airports) {
      view.project(a.x, a.z); const x = view.px, y = view.py;
      if (x < -40 || x > 1040 || y < 150 || y > 1000) continue;
      g.strokeStyle = BC.cyan; g.lineWidth = 3.5; circle(g, x, y, 14); g.stroke();
      text(g, a.icao, x + 22, y + 32, BC.cyan, 'left', font(28));
      if (a === dest) { g.strokeStyle = BC.magenta; g.lineWidth = 3.5; poly(g, [x, y - 24, x + 7, y - 7, x + 24, y, x + 7, y + 7, x, y + 24, x - 7, y + 7, x - 24, y, x - 7, y - 7]); g.stroke(); }
    }
    // trend vector
    if (Math.abs(S.turnRate) > 0.3 && S.gs > 60 && !S.onGround) {
      g.strokeStyle = BC.white; g.lineWidth = 3.5; g.setLineDash([22, 16]);
      g.beginPath(); g.moveTo(ACX, ACY);
      let hx = 0, x = ACX, y = ACY; const v = S.gs * 0.5144 * k;
      for (let t = 0; t <= 90; t += 5) { hx += S.turnRate * 5 * DEG; x += Math.sin(hx) * v * 5; y -= Math.cos(hx) * v * 5; g.lineTo(x, y); }
      g.stroke(); g.setLineDash([]);
    }
    for (const o of traffic(clockSeconds())) {
      const rel = (o.alt * FT - S.alt) / 100;
      if (Math.abs(rel) > 27 || o.kind === 'hostile') continue;
      view.project(o.x, o.z); const x = view.px, y = view.py;
      if (x < 20 || x > 980 || y < 190 || y > 980) continue;
      const prox = Math.hypot(x - ACX, y - ACY) / k / NM < 6 && Math.abs(rel) < 12;
      g.strokeStyle = prox ? BC.cyan : BC.white; g.fillStyle = BC.cyan; g.lineWidth = 3;
      poly(g, [x, y - 13, x + 10, y, x, y + 13, x - 10, y]); if (prox) g.fill(); else g.stroke();
      text(g, (rel >= 0 ? '+' : '-') + pad(Math.abs(rel), 2), x, rel >= 0 ? y - 20 : y + 40, prox ? BC.cyan : BC.white, 'center', font(24));
    }
    g.restore();
    // compass rose (track up)
    g.save(); g.beginPath(); g.rect(0, 186, 1000, 814); g.clip();
    g.strokeStyle = BC.white; g.lineWidth = 3.5;
    g.beginPath(); g.arc(ACX, ACY, R, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    g.fillStyle = BC.white; g.textAlign = 'center';
    const t0 = S.trackMag;
    for (let d = Math.ceil((t0 - 60) / 5) * 5; d <= t0 + 60; d += 5) {
      const a = (d - t0) * DEG, s = Math.sin(a), c = Math.cos(a), dd = wrap360(d), l = dd % 10 === 0 ? 26 : 13;
      line(g, ACX + s * R, ACY - c * R, ACX + s * (R - l), ACY - c * (R - l));
      if (dd % 10 === 0) {
        g.save(); g.translate(ACX + s * (R - 50), ACY - c * (R - 50)); g.rotate(a);
        g.font = font(dd % 30 === 0 ? 36 : 28); g.fillText(String(dd / 10), 0, 12); g.restore();
      }
    }
    // heading pointer
    const ha = wrap180(S.hdgMag - t0) * DEG;
    g.save(); g.translate(ACX + Math.sin(ha) * R, ACY - Math.cos(ha) * R); g.rotate(ha);
    g.strokeStyle = BC.white; g.lineWidth = 3.5; poly(g, [0, 0, -12, -26, 12, -26]); g.stroke(); g.restore();
    if (S.ap.on) {
      const a = wrap180(S.ap.hdgMag - t0) * DEG;
      g.save(); g.translate(ACX + Math.sin(a) * R, ACY - Math.cos(a) * R); g.rotate(a);
      g.strokeStyle = BC.magenta; g.lineWidth = 4; poly(g, [-18, 0, -18, -20, 18, -20, 18, 0, 7, 0, 0, -10, -7, 0]); g.stroke(); g.restore();
      g.setLineDash([14, 12]); g.strokeStyle = BC.magenta; g.lineWidth = 2.5;
      line(g, ACX, ACY, ACX + Math.sin(a) * R, ACY - Math.cos(a) * R); g.setLineDash([]);
    }
    // track line with range ticks
    g.strokeStyle = BC.white; g.lineWidth = 3; line(g, ACX, ACY - 50, ACX, ACY - R + 30);
    line(g, ACX - 12, ACY - R / 2, ACX + 12, ACY - R / 2);
    g.restore();
    over.blit(g);
    text(g, pad(Math.round(t0) % 360, 3), ACX, 170, BC.white, 'center', font(40));
    // data blocks
    text(g, 'GS', 16, 50, BC.white, 'left', font(26)); text(g, String(Math.round(S.gs)), 60, 50, BC.white, 'left', font(38));
    text(g, 'TAS', 150, 50, BC.white, 'left', font(26)); text(g, S.tas < 100 ? '---' : String(Math.round(S.tas)), 206, 50, BC.white, 'left', font(38));
    if (S.tas >= 100 && !S.onGround) {
      text(g, (S.windSpd ? pad(Math.round(S.windDir) % 360, 3) : '000') + '°/' + Math.round(S.windSpd), 16, 96, BC.white, 'left', font(32));
      if (S.windSpd >= 2) {
        g.save(); g.translate(44, 150); g.rotate((S.windDir + 180 - S.trackMag) * DEG);
        g.strokeStyle = BC.white; g.lineWidth = 4; line(g, 0, -28, 0, 28); line(g, 0, 28, -10, 14); line(g, 0, 28, 10, 14); g.restore();
      }
    }
    const tgt = to || dest;
    if (tgt) {
      const dnm = distTo(S.x, S.z, tgt.x, tgt.z) / NM;
      text(g, to ? routeIdent(S.route, to) : dest.icao, 984, 50, BC.magenta, 'right', font(36));
      const eta = new Date(Date.now() + (S.gs > 30 ? dnm / S.gs * 3600e3 : 0));
      text(g, pad(eta.getUTCHours(), 2) + pad(eta.getUTCMinutes(), 2) + '.' + Math.floor(eta.getUTCSeconds() / 6) + 'z', 984, 96, BC.white, 'right', font(32));
      text(g, (dnm < 100 ? dnm.toFixed(1) : Math.round(dnm)) + ' NM', 984, 140, BC.white, 'right', font(32));
    }
    if (G) text(g, 'TERR', 984, 980, BC.cyan, 'right', font(30));
    text(g, 'TFC', 16, 980, BC.cyan, 'left', font(30));
    if (S.warn.pullUp && Math.floor(S.t * 2.5) % 2 === 0) text(g, 'PULL UP', 500, 560, BC.red, 'center', font(56));
  };
}

// ---------------------------------------------------------------- upper EICAS (primary engine display)
function b737Eicas(env) {
  const E = [{ x: 205, y: 250 }, { x: 505, y: 250 }], R = 118;
  const n1A = (n) => (180 + clamp(n, 0, 112) / 110 * 210) * DEG;
  const egR = 88, egY = 540;
  const egA = (t) => (180 + clamp(t, 0, 1000) / 1000 * 210) * DEG;
  const st = { egt: [0, 0], n2: [0, 0], ff: [0, 0], flap: 0 };
  const DET = [['UP', 0], ['1', 0.1], ['2', 0.2], ['5', 0.3], ['10', 0.45], ['15', 0.55], ['25', 0.7], ['30', 0.85], ['40', 1]];
  const bg = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    for (const e of E) {
      g.strokeStyle = BC.white; g.lineWidth = 4;
      g.beginPath(); g.arc(e.x, e.y, R, n1A(0), n1A(104)); g.stroke();
      g.strokeStyle = BC.red; g.lineWidth = 6; const a = n1A(104);
      line(g, e.x + Math.cos(a) * (R - 12), e.y + Math.sin(a) * (R - 12), e.x + Math.cos(a) * (R + 16), e.y + Math.sin(a) * (R + 16));
      g.strokeStyle = BC.white; g.lineWidth = 3.5; g.font = font(26); g.fillStyle = BC.white; g.textAlign = 'center';
      for (let v = 0; v <= 100; v += 10) {
        const b = n1A(v), l = v % 20 === 0 ? 16 : 9;
        line(g, e.x + Math.cos(b) * R, e.y + Math.sin(b) * R, e.x + Math.cos(b) * (R - l), e.y + Math.sin(b) * (R - l));
        if (v % 20 === 0 && v > 0) g.fillText(String(v / 10), e.x + Math.cos(b) * (R - 34), e.y + Math.sin(b) * (R - 34) + 9);
      }
      g.strokeStyle = BC.white; g.lineWidth = 3; g.strokeRect(e.x + 10, e.y - R - 60, 128, 52);
      // EGT
      g.strokeStyle = BC.white; g.lineWidth = 4;
      g.beginPath(); g.arc(e.x, egY, egR, egA(0), egA(950)); g.stroke();
      g.strokeStyle = BC.red; g.lineWidth = 6; const b = egA(950);
      line(g, e.x + Math.cos(b) * (egR - 10), egY + Math.sin(b) * (egR - 10), e.x + Math.cos(b) * (egR + 14), egY + Math.sin(b) * (egR + 14));
      g.strokeStyle = BC.amber; g.lineWidth = 4; const c = egA(925);
      line(g, e.x + Math.cos(c) * (egR - 10), egY + Math.sin(c) * (egR - 10), e.x + Math.cos(c) * egR, egY + Math.sin(c) * egR);
      g.strokeStyle = BC.white; g.lineWidth = 3; g.strokeRect(e.x + 6, egY - egR - 52, 104, 46);
    }
    text(g, 'N1', 355, 290, BC.cyan, 'center', font(32));
    text(g, 'EGT', 355, 560, BC.cyan, 'center', font(30));
    g.font = font(28);
    for (const [s, y] of [['N2', 735], ['FF', 790], ['OIL P', 845], ['OIL T', 900], ['VIB', 955]]) text(g, s, 355, y, BC.cyan, 'center');
    text(g, 'TAT', 20, 44, BC.cyan, 'left', font(28));
    // flap gauge
    g.strokeStyle = BC.white; g.lineWidth = 3;
    text(g, 'FLAPS', 870, 250, BC.cyan, 'center', font(26));
    line(g, 870, 280, 870, 600);
    g.font = font(22);
    for (const [l, v] of DET) { const y = 280 + v * 320; line(g, 858, y, 882, y); text(g, l, 900, y + 8, BC.white, 'left'); }
    // fuel
    text(g, 'FUEL', 830, 700, BC.cyan, 'center', font(28));
    text(g, 'LBS', 830, 955, BC.cyan, 'center', font(24));
    for (const [s, x, y] of [['1', 730, 770], ['CTR', 830, 770], ['2', 930, 770]]) {
      text(g, s, x, y - 10, BC.cyan, 'center', font(22));
      g.strokeStyle = BC.white; g.lineWidth = 2.5; g.strokeRect(x - 48, y, 96, 46);
    }
    g.strokeStyle = BC.white; g.strokeRect(760, 870, 140, 48);
    text(g, 'TOTAL', 830, 862, BC.cyan, 'center', font(20));
  });
  return (g, S) => {
    bg.blit(g);
    const k = smoothK(S.dt, 2.2);
    for (let i = 0; i < 2; i++) {
      const e = E[i], en = S.engines[i], n1 = en && en.present ? en.n1 : 0;
      st.egt[i] += ((n1 < 5 ? 30 : 330 + 5.2 * n1 + 0.012 * Math.max(0, n1 - 60) ** 2.2) - st.egt[i]) * k;
      st.n2[i] += ((n1 < 5 ? n1 * 3 : 60 + 0.38 * n1) - st.n2[i]) * k;
      st.ff[i] += (((en && en.ff) || (n1 < 5 ? 0 : 700 + 0.5 * n1 * n1 * (1 - S.alt / 60000))) - st.ff[i]) * k;
      // N1 needle + ref bug
      const a = n1A(n1);
      g.strokeStyle = BC.white; g.lineWidth = 6;
      line(g, e.x, e.y, e.x + Math.cos(a) * (R - 4), e.y + Math.sin(a) * (R - 4));
      const ref = S.onGround || S.agl < 1500 ? 95.2 : S.ap.on && Math.abs(S.ap.alt - S.alt) < 300 ? 88.4 : 93.1;
      const ra = n1A(ref); g.fillStyle = BC.green;
      g.save(); g.translate(e.x + Math.cos(ra) * (R + 6), e.y + Math.sin(ra) * (R + 6)); g.rotate(ra + Math.PI / 2);
      poly(g, [0, 0, -9, -14, 9, -14]); g.fill(); g.restore();
      text(g, n1.toFixed(1), e.x + 130, e.y - R - 18, n1 > 104 ? BC.red : BC.white, 'right', font(42));
      if (S.reverser > 0.05) text(g, 'REV', e.x + 74, e.y - R - 72, S.reverser > 0.95 ? BC.green : BC.amber, 'center', font(30));
      // EGT
      const b = egA(st.egt[i]);
      g.strokeStyle = BC.white; g.lineWidth = 5; line(g, e.x, egY, e.x + Math.cos(b) * (egR - 4), egY + Math.sin(b) * (egR - 4));
      text(g, String(Math.round(st.egt[i])), e.x + 102, egY - egR - 16, st.egt[i] > 925 ? BC.amber : BC.white, 'right', font(36));
      // secondary
      const x = i === 0 ? 205 : 505;
      text(g, st.n2[i].toFixed(1), x, 735, BC.white, 'center', font(32));
      text(g, (st.ff[i] * 2.2046 / 1000).toFixed(2), x, 790, BC.white, 'center', font(32));
      text(g, String(Math.round(n1 < 5 ? 0 : 38 + n1 * 0.12)), x, 845, BC.white, 'center', font(32));
      text(g, String(Math.round(n1 < 5 ? 25 : 70 + n1 * 0.3)), x, 900, BC.white, 'center', font(32));
      text(g, (n1 < 5 ? 0 : 0.3 + n1 / 250).toFixed(1), x, 955, BC.white, 'center', font(32));
    }
    const sat = 15 - 1.98 * S.alt / 1000, tat = (sat + 273.15) * (1 + 0.2 * S.mach * S.mach) - 273.15;
    text(g, (tat >= 0 ? '+' : '') + Math.round(tat) + 'c', 80, 44, BC.white, 'left', font(32));
    const mode = S.onGround || S.agl < 400 ? 'TO' : S.ap.on && Math.abs(S.ap.alt - S.alt) < 300 ? 'CRZ' : 'CLB';
    const refv = mode === 'TO' ? 95.2 : mode === 'CRZ' ? 88.4 : 93.1;
    text(g, mode, 780, 44, BC.green, 'right', font(32));
    text(g, refv.toFixed(1), 900, 44, BC.green, 'right', font(40));
    // flaps
    const FV = [0, 0.025, 0.05, 0.125, 0.25, 0.375, 0.625, 0.75, 1], GP = DET.map((d) => d[1]);
    let gp = 1;
    for (let i = 1; i < FV.length; i++) if (S.flaps <= FV[i]) { gp = GP[i - 1] + (GP[i] - GP[i - 1]) * (S.flaps - FV[i - 1]) / (FV[i] - FV[i - 1]); break; }
    const gpPrev = st.flap;
    st.flap += (gp - st.flap) * smoothK(S.dt, 0.6);
    const fy = 280 + st.flap * 320;
    g.fillStyle = Math.abs(st.flap - gp) > 0.02 || Math.abs(st.flap - gpPrev) > 0.002 ? BC.amber : BC.green;
    poly(g, [852, fy, 830, fy - 12, 830, fy + 12]); g.fill();
    // fuel
    const lbs = S.fuel * 2.2046, ctr = Math.max(0, lbs - 2 * 8600), wing = (lbs - ctr) / 2;
    const f3 = [wing, ctr, wing];
    for (let i = 0; i < 3; i++) text(g, String(Math.round(f3[i] / 10) * 10), [730, 830, 930][i], 805, f3[i] < 1000 && i !== 1 ? BC.amber : BC.white, 'center', font(28));
    text(g, String(Math.round(lbs / 10) * 10), 830, 906, BC.white, 'center', font(32));
  };
}

// ---------------------------------------------------------------- CDU (1000×800, 24 columns × 14 lines)
function b737Cdu(env) {
  const COLS = 24, LH = 800 / 14, CW = 1000 / COLS;
  let xScale = 1, measured = -1;
  const fmtLat = (v) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return (v >= 0 ? 'N' : 'S') + pad(d, 2) + '°' + m.toFixed(1).padStart(4, '0'); };
  const fmtLon = (v) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return (v >= 0 ? 'E' : 'W') + pad(d, 3) + '°' + m.toFixed(1).padStart(4, '0'); };
  // row: [text, color, large?, col]
  const put = (g, row, col, s, color, large) => {
    g.font = font(large ? 50 : 38, !!large, true);
    g.fillStyle = color;
    g.save(); g.translate(col * CW + 4, row * LH + LH * 0.82); g.scale(xScale, 1); g.fillText(s, 0, 0); g.restore();
  };
  const right = (g, row, s, color, large) => put(g, row, COLS - s.length, s, color, large);
  return (g, S, ctx) => {
    if (measured !== env.w) { g.font = font(50, true, true); const w = g.measureText('MMMMMMMMMM').width / 10; xScale = (CW * 0.98) / w; measured = env.w; }
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 800);
    g.textAlign = 'left';
    const ll = localToLonLat(S.x, S.z);
    const nav = ctx.nav;
    const dest = pickDestination(nav, S.x, S.z, S.track);
    const W = BC.white, Gr = BC.green, M = BC.magenta, Cy = BC.cyan;
    if (S.onGround && S.gs < 60) {
      put(g, 0, 8, 'POS REF', W, true); right(g, 0, '2/3 ', W, false);
      put(g, 1, 1, 'FMC POS (GPS L)', W); right(g, 1, 'GS ', W);
      const pos = fmtLat(ll.lat) + ' ' + fmtLon(ll.lon);
      put(g, 2, 0, pos, Gr, true); right(g, 2, Math.round(S.gs) + 'KT', Gr, true);
      put(g, 3, 1, 'IRS L', W); put(g, 4, 0, pos.replace(/\d$/, (d) => String((+d + 1) % 10)), W, true);
      put(g, 5, 1, 'IRS R', W); put(g, 6, 0, pos, W, true);
      put(g, 7, 1, 'GPS L', W); put(g, 8, 0, pos, W, true);
      put(g, 9, 1, 'GPS R', W); put(g, 10, 0, pos, W, true);
      put(g, 11, 1, 'RADIO', W); put(g, 12, 0, '<PURGE', W, true); right(g, 12, 'INHIBIT>', W, true);
    } else {
      put(g, 0, 8, 'PROGRESS', W, true); right(g, 0, '1/4 ', W, false);
      put(g, 1, 1, 'FROM', W); put(g, 1, 10, 'ALT', W); put(g, 1, 15, 'ATA', W); right(g, 1, 'FUEL ', W);
      const now = new Date();
      const hhmm = pad(now.getUTCHours(), 2) + pad(now.getUTCMinutes(), 2) + 'Z';
      put(g, 2, 0, navOrigin.icao, W, true); put(g, 2, 14, hhmm, W, true); right(g, 2, (S.fuel * 2.2046 / 1000 + 0.9).toFixed(1), W, true);
      put(g, 3, 1, 'TO', W); put(g, 3, 9, 'DTG', W); put(g, 3, 15, 'ETA', W); right(g, 3, 'FUEL ', W);
      if (dest) {
        const d = distTo(S.x, S.z, dest.x, dest.z) / NM;
        const eta = new Date(Date.now() + (S.gs > 30 ? d / S.gs * 3600e3 : 0));
        const etas = pad(eta.getUTCHours(), 2) + pad(eta.getUTCMinutes(), 2) + 'Z';
        put(g, 4, 0, dest.icao, M, true); put(g, 4, 8, String(Math.round(d)).padStart(4), M, true); put(g, 4, 14, etas, M, true);
        right(g, 4, (S.fuel * 2.2046 / 1000 - d * 0.02).toFixed(1), M, true);
        put(g, 5, 1, 'DEST', W);
        put(g, 6, 0, dest.icao, W, true); put(g, 6, 8, String(Math.round(d)).padStart(4), W, true); put(g, 6, 14, etas, W, true);
        right(g, 6, (S.fuel * 2.2046 / 1000 - d * 0.02).toFixed(1), W, true);
      }
      put(g, 7, 1, 'SEL SPD', W); right(g, 7, 'FUEL QTY ', W);
      put(g, 8, 0, (S.ap.on && S.ap.hasSpd ? Math.round(S.ap.spd) : Math.round(S.ias)) + '/.' + pad(Math.round(S.mach * 100), 2), Gr, true);
      right(g, 8, (S.fuel * 2.2046 / 1000).toFixed(1), W, true);
      put(g, 9, 1, 'WIND', W); put(g, 9, 13, 'ALT', W);
      put(g, 10, 0, (S.windSpd ? pad(Math.round(S.windDir) % 360, 3) : '000') + '°/' + String(Math.round(S.windSpd)).padStart(3), W, true);
      put(g, 10, 12, S.alt > 18000 ? 'FL' + pad(Math.round(S.alt / 100), 3) : String(Math.round(S.alt / 10) * 10), W, true);
      put(g, 11, 0, '------------------------', W);
      put(g, 12, 0, '<POS REPORT', W, true); right(g, 12, 'POS REF>', W, true);
    }
    // scratchpad
    const msg = S.warn.overspeed ? 'DRAG REQUIRED' : S.ap.on && S.gearDown ? 'VERIFY RNP' : '';
    if (msg) put(g, 13, 0, msg, W, true);
    // exec light style bar
    if (S.ap.on && Math.abs(S.ap.alt - S.alt) > 300) { g.fillStyle = BC.white; g.fillRect(0, 794, 1000, 6); }
  };
}

// ---------------------------------------------------------------- lower DU (secondary engine display)
function b737Lower(env) {
  const X = [250, 690];
  const st = { n2: [0, 0], fu: [0, 0], op: [0, 0], ot: [0, 0], vib: [0, 0] };
  const arc = (a0, a1, v, lo, hi) => a0 + (clamp(v, lo, hi) - lo) / (hi - lo) * (a1 - a0);
  const n2A = (v) => arc(180 * DEG, 390 * DEG, v, 0, 110);
  const opA = (v) => arc(200 * DEG, 340 * DEG, v, 0, 100);
  const otA = (v) => arc(200 * DEG, 340 * DEG, v, 0, 180);
  const bg = env.layer((g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 1000, 1000);
    for (const x of X) {
      g.strokeStyle = BC.white; g.lineWidth = 4;
      g.beginPath(); g.arc(x, 200, 110, n2A(0), n2A(105)); g.stroke();
      g.strokeStyle = BC.red; g.lineWidth = 6; const a = n2A(105);
      line(g, x + Math.cos(a) * 96, 200 + Math.sin(a) * 96, x + Math.cos(a) * 124, 200 + Math.sin(a) * 124);
      g.strokeStyle = BC.white; g.lineWidth = 3; g.strokeRect(x + 10, 60, 124, 50);
      for (const [cy, fn, lo, hi, red] of [[600, opA, 0, 100, 13], [770, otA, 0, 180, 165]]) {
        g.strokeStyle = BC.white; g.lineWidth = 3.5; g.beginPath(); g.arc(x, cy, 70, fn(lo), fn(hi)); g.stroke();
        g.strokeStyle = BC.red; g.lineWidth = 5; const b = fn(red);
        line(g, x + Math.cos(b) * 58, cy + Math.sin(b) * 58, x + Math.cos(b) * 82, cy + Math.sin(b) * 82);
      }
    }
    text(g, 'N2', 470, 230, BC.cyan, 'center', font(32));
    text(g, 'FF', 470, 380, BC.cyan, 'center', font(30)); text(g, 'FU', 470, 430, BC.cyan, 'center', font(30));
    text(g, 'OIL P', 470, 600, BC.cyan, 'center', font(28)); text(g, 'OIL T', 470, 770, BC.cyan, 'center', font(28));
    text(g, 'OIL QTY', 470, 895, BC.cyan, 'center', font(28)); text(g, 'VIB', 470, 955, BC.cyan, 'center', font(28));
    text(g, 'KGS X 1000', 470, 470, BC.grey, 'center', font(20));
  });
  return (g, S) => {
    bg.blit(g);
    const k = smoothK(S.dt, 1.5);
    for (let i = 0; i < 2; i++) {
      const e = S.engines[i], n1 = e && e.present ? e.n1 : 0, x = X[i];
      st.n2[i] += ((n1 < 5 ? n1 * 3 : 60 + 0.38 * n1) - st.n2[i]) * k;
      st.op[i] += ((n1 < 5 ? 0 : 38 + n1 * 0.12) - st.op[i]) * k;
      st.ot[i] += ((n1 < 5 ? 25 : 70 + n1 * 0.3) - st.ot[i]) * k;
      st.vib[i] += ((n1 < 5 ? 0 : 0.3 + n1 / 250) - st.vib[i]) * k;
      const ffk = (e && e.ff) ? e.ff : n1 < 5 ? 0 : 700 + 0.5 * n1 * n1;
      st.fu[i] += ffk / 3600 * S.dt;
      const a = n2A(st.n2[i]);
      g.strokeStyle = BC.white; g.lineWidth = 6; line(g, x, 200, x + Math.cos(a) * 104, 200 + Math.sin(a) * 104);
      text(g, st.n2[i].toFixed(1), x + 128, 100, BC.white, 'right', font(40));
      text(g, (ffk / 1000).toFixed(2), x, 380, BC.white, 'center', font(36));
      text(g, (st.fu[i] / 1000).toFixed(2), x, 430, BC.white, 'center', font(36));
      for (const [fn, v, cy] of [[opA, st.op[i], 600], [otA, st.ot[i], 770]]) {
        const b = fn(v); g.strokeStyle = BC.white; g.lineWidth = 4; line(g, x, cy, x + Math.cos(b) * 66, cy + Math.sin(b) * 66);
        text(g, String(Math.round(v)), x + (i ? 118 : -118), cy + 12, BC.white, 'center', font(30));
      }
      text(g, String(Math.round(n1 < 5 ? 88 : 86 - i)), x, 895, BC.white, 'center', font(34));
      text(g, st.vib[i].toFixed(1), x, 955, BC.white, 'center', font(34));
    }
  };
}

export const BOEING = {
  'b737.pfd': { vw: 1000, vh: 1000, size: 1024, create: b737Pfd },
  'b737.nd': { vw: 1000, vh: 1000, size: 1024, hz: 10, create: b737Nd },
  'b737.eicas': { vw: 1000, vh: 1000, size: 512, hz: 10, create: b737Eicas },
  'b737.cdu': { vw: 1000, vh: 800, size: 512, hz: 4, create: b737Cdu },
  'b737.lower': { vw: 1000, vh: 1000, size: 512, hz: 10, create: b737Lower },
};
