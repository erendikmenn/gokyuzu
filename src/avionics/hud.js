// Fighter HUD renderer shared by the F-16 and F-22 (transparent canvas, drawn for additive blending on the combiner).
// The symbology is conformal when the canvas spans `fovDeg` degrees vertically at the pilot's eye (opts.fovDeg, default
// 26° F-16 / 30° F-22) and the nose boresight sits at `boresight` (fraction of the height from the top; default 0.30 / 0.33).
import { font, text, line, poly, circle, clamp, wrap360, wrap180, pad, DEG, NM, FT } from './core.js';
import { STEERPOINTS, steerpoint, bearingTo, distTo, ilsFor } from './nav.js';

export const HUD_GREEN = '#2bff55';

function drawFpm(g, x, y, r) {
  circle(g, x, y, r); g.stroke();
  line(g, x - r, y, x - r - 22, y); line(g, x + r, y, x + r + 22, y); line(g, x, y - r, x, y - r - 14);
}

/** Pitch ladder rotated around (ox, oy), rung positions relative to the flight-path angle. style: 'f16' | 'f22'. */
function drawLadder(g, S, ox, oy, ppd, style) {
  g.save();
  g.translate(ox, oy); g.rotate(-S.roll * DEG);
  const fpa = S.fpa;
  g.font = font(26); g.textAlign = 'center';
  const lo = Math.ceil((fpa - 16) / 5), hi = Math.floor((fpa + 16) / 5);
  for (let i = lo; i <= hi; i++) {
    const a = i * 5; if (Math.abs(a) > 90) continue;
    const y = (fpa - a) * ppd;
    if (a === 0) {
      line(g, -440, y, -70, y); line(g, 70, y, 440, y);
      continue;
    }
    const gap = 60, len = 110, tick = a > 0 ? 18 : -18;
    for (const s of [-1, 1]) {
      const x0 = s * gap, x1 = s * (gap + len);
      if (a > 0) { line(g, x0, y, x1, y); }
      else {
        // negative: dashed; F-22 bars also slant toward the horizon
        const slant = style === 'f22' ? Math.min(40, -a * 0.8) : 0;
        g.setLineDash([22, 12]); line(g, x0, y, x1, y - slant); g.setLineDash([]);
      }
      const ty = a > 0 ? y : y - (style === 'f22' ? Math.min(40, -a * 0.8) : 0);
      line(g, x1, ty, x1, ty + tick);
      g.fillText(String(Math.abs(a)), s * (gap + len + 30), ty + (a > 0 ? 10 : 2));
    }
  }
  g.restore();
}

export function createHud(env, style = 'f16') {
  // defaults measured by ray casting eye_pilot through screen_hud (dev/avionics.html?mode=cockpit): the F-22 combiner is
  // conformal with 17.6° over the canvas height, boresight 22.3 % from the top; the F-16 combiner currently lies entirely
  // below the eye line (−5.7°…−18.2°) so it gets a compressed, non-conformal scale. createDisplay(type, { mesh, eye })
  // recalibrates automatically from the real geometry.
  const fov = env.opts.fovDeg || (style === 'f22' ? 17.6 : 26);
  const ppd = 1000 / fov;
  // boresight / gun cross: opts.boresight = fraction of the canvas height from the top (conformal calibration)
  const BX = 500, BY = Number.isFinite(env.opts.boresight) ? env.opts.boresight * 1000 : style === 'f22' ? 223 : 300;
  const col = HUD_GREEN;
  const st = { maxG: 1, flash: 0 };
  const ox = (env.vw - 1000) / 2;
  return (g, S, ctx) => {
    if (ox) g.translate(ox, 0);
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 3.4; g.lineCap = 'round';
    g.font = font(30);
    const sp = steerpoint(ctx.flight, S.x, S.z);
    const stpt = STEERPOINTS[sp.i];
    const brg = bearingTo(S.x, S.z, stpt.x, stpt.z), dist = distTo(S.x, S.z, stpt.x, stpt.z);
    if (!S.onGround) st.maxG = Math.max(st.maxG, S.g);
    // gun cross / waterline
    if (style === 'f16') { line(g, BX - 20, BY, BX - 7, BY); line(g, BX + 7, BY, BX + 20, BY); line(g, BX, BY - 20, BX, BY - 7); line(g, BX, BY + 7, BX, BY + 20); }
    else { poly(g, [BX - 44, BY + 6, BX - 22, BY + 6, BX - 11, BY - 12, BX, BY + 6, BX + 11, BY - 12, BX + 22, BY + 6, BX + 44, BY + 6], false); g.stroke(); }
    // flight path marker
    const fx = clamp(BX + S.drift * ppd, 230, 770);
    const fy = clamp(BY + (S.pitch - S.fpa) * ppd, 120, 780);
    // ladder (clipped to the central area)
    g.save(); g.beginPath(); g.rect(225, style === 'f22' ? 130 : 40, 550, style === 'f22' ? 690 : 780); g.clip();
    drawLadder(g, S, fx, fy, ppd, style);
    g.restore();
    g.lineWidth = 3.8; drawFpm(g, fx, fy, 14); g.lineWidth = 3.4;
    // steering cue (great-circle steering tadpole) and steerpoint diamond
    const az = wrap180(brg - S.hdg);
    const cx = fx + clamp(az, -10, 10) * ppd * 0.5;
    circle(g, cx, fy - 44, 7); g.stroke(); line(g, cx, fy - 51, cx, fy - 70);
    const el = Math.atan2(stpt.elev - S.alt / FT, Math.max(dist, 1)) / DEG;
    {
      const dx = az * ppd, dy = -(el - S.pitch) * ppd, c = Math.cos(-S.roll * DEG), s = Math.sin(-S.roll * DEG);
      const sx = BX + dx * c - dy * s, sy = BY + dx * s + dy * c;
      if (sx > 240 && sx < 760 && sy > 60 && sy < 800) { poly(g, [sx, sy - 14, sx + 14, sy, sx, sy + 14, sx - 14, sy]); g.stroke(); }
    }
    // ILS bars (gear down, localizer captured)
    if (S.gearHandleDown && !S.onGround) {
      const ils = ilsFor(ctx.nav, S);
      if (ils.valid && ils.dme < 15) {
        const lx = fx + clamp(ils.loc, -2.5, 2.5) * 36;
        line(g, lx, fy - 110, lx, fy + 110);
        if (ils.gsValid) { const gy = fy - clamp(ils.gs, -2.5, 2.5) * 36; line(g, fx - 110, gy, fx + 110, gy); }
        text(g, ils.ident + ' ' + ils.dme.toFixed(1), 826, 780, col, 'left', font(26));
      }
    }
    // AoA bracket (gear down)
    if (S.gearHandleDown && !S.onGround) {
      const bx = fx - 60, by = fy + (S.aoa - 13) * 9;
      line(g, bx, by - 18, bx, by + 18); line(g, bx, by - 18, bx + 12, by - 18); line(g, bx, by + 18, bx + 12, by + 18); line(g, bx, by, bx + 8, by);
    }
    // ------------------------------------------------ airspeed / altitude
    const ias = Math.round(S.ias), altv = Math.round(S.alt / 10) * 10;
    const commas = (v) => { const a = Math.abs(v); const th = Math.floor(a / 1000); return (v < 0 ? '-' : '') + (th ? th + ',' + pad(a % 1000, 3) : String(a % 1000)); };
    const TY = style === 'f22' ? 470 : 400;
    if (style === 'f16') {
      // speed scale (labels hidden behind the readout box)
      g.save(); g.beginPath(); g.rect(40, TY - 170, 200, 340); g.clip();
      g.font = font(24); g.textAlign = 'right';
      for (let v = Math.floor((S.ias - 130) / 10) * 10; v <= S.ias + 130; v += 10) {
        if (v < 0) continue;
        const y = TY - (v - S.ias) * 1.25;
        line(g, 206, y, v % 50 === 0 ? 182 : 194, y);
        if (v % 50 === 0 && Math.abs(y - TY) > 34) g.fillText(String(v), 174, y + 9);
      }
      g.restore();
      g.strokeRect(70, TY - 22, 104, 44);
      text(g, String(ias), 122, TY + 12, col, 'center', font(32));
      text(g, 'C', 50, TY + 12, col, 'center', font(26));
      // altitude scale
      g.save(); g.beginPath(); g.rect(760, TY - 170, 230, 340); g.clip();
      g.font = font(24); g.textAlign = 'left';
      for (let a = Math.floor((S.alt - 1100) / 100) * 100; a <= S.alt + 1100; a += 100) {
        const y = TY - (a - S.alt) * 0.15;
        line(g, 794, y, a % 500 === 0 ? 818 : 806, y);
        if (a % 500 === 0 && Math.abs(y - TY) > 34) { const th = Math.floor(Math.abs(a) / 1000); g.fillText((a < 0 ? '-' : '') + th + ',' + (Math.abs(a) % 1000) / 100, 828, y + 9); }
      }
      g.restore();
      g.strokeRect(826, TY - 22, 140, 44);
      text(g, commas(altv), 896, TY + 12, col, 'center', font(32));
      if (S.radioAlt < 5000) { g.strokeRect(826, TY + 178, 140, 40); text(g, 'R ' + pad(Math.round(S.radioAlt / 10) * 10, 5), 896, TY + 208, col, 'center', font(28)); }
    } else {
      // F-22: boxed values only, with small AoA/Mach/G block
      g.strokeRect(80, TY - 26, 130, 50); text(g, String(ias), 145, TY + 12, col, 'center', font(36));
      g.strokeRect(780, TY - 26, 150, 50); text(g, commas(altv), 855, TY + 12, col, 'center', font(36));
      text(g, 'M ' + S.mach.toFixed(2), 80, TY + 70, col, 'left', font(28));
      text(g, 'α ' + S.aoa.toFixed(1), 80, TY + 108, col, 'left', font(28));
      text(g, S.g.toFixed(1) + 'G', 80, TY - 50, col, 'left', font(30));
      if (S.radioAlt < 5000) text(g, 'R ' + commas(Math.round(S.radioAlt / 10) * 10), 780, TY + 70, col, 'left', font(28));
      text(g, (S.vs >= 0 ? '+' : '-') + pad(Math.abs(Math.round(S.vs / 10) * 10), 4), 780, TY - 50, col, 'left', font(26));
    }
    // ------------------------------------------------ heading scale
    const HY = style === 'f22' ? 70 : 850, hd = S.hdgMag;
    g.save(); g.beginPath(); g.rect(330, HY - 50, 340, 100); g.clip();
    g.font = font(26); g.textAlign = 'center';
    for (let d = Math.ceil((hd - 18) / 5) * 5; d <= hd + 18; d += 5) {
      const x = 500 + (d - hd) * 9, dd = wrap360(d);
      if (style === 'f22') { line(g, x, HY + 22, x, HY + (dd % 10 === 0 ? 8 : 14)); if (dd % 10 === 0) g.fillText(pad(dd / 10, 2), x, HY); }
      else { line(g, x, HY - 18, x, HY - (dd % 10 === 0 ? 2 : 10)); if (dd % 10 === 0) g.fillText(pad(dd / 10, 2), x, HY + 26); }
    }
    // steerpoint bearing marker
    const sb = wrap180(wrap360(brg - S.decl) - hd);
    if (Math.abs(sb) < 18) { const x = 500 + sb * 9; if (style === 'f22') line(g, x, HY + 22, x, HY + 36); else line(g, x, HY - 18, x, HY - 34); }
    g.restore();
    if (style === 'f22') {
      g.fillStyle = '#000'; g.fillRect(462, HY - 32, 76, 42);
      g.fillStyle = col; g.strokeRect(462, HY - 32, 76, 42); text(g, pad(Math.round(hd) % 360, 3), 500, HY, col, 'center', font(30));
    } else { poly(g, [500, HY - 20, 490, HY - 36, 510, HY - 36]); g.stroke(); }
    // ------------------------------------------------ bank scale (gear down on the F-16, always on the F-22)
    if (style === 'f22' || (S.gearHandleDown && !S.onGround)) {
      const rx = 500, ry = style === 'f22' ? 690 : 610, R = 110;
      for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
        const c = Math.cos((a + 90) * DEG), s = Math.sin((a + 90) * DEG), l = a % 30 === 0 ? 20 : 12;
        line(g, rx + c * R, ry + s * R, rx + c * (R + l), ry + s * (R + l));
      }
      g.save(); g.translate(rx, ry); g.rotate(-S.roll * DEG);
      poly(g, [0, R - 2, -10, R - 20, 10, R - 20]); g.stroke(); g.restore();
    }
    // ------------------------------------------------ data blocks
    const dnm = dist / NM, ttg = S.gs > 30 ? dnm / S.gs * 3600 : 0;
    if (style === 'f16') {
      text(g, S.g.toFixed(1), 80, 180, col, 'left', font(30));
      text(g, S.mach.toFixed(2), 80, 600, col, 'left', font(30));
      text(g, st.maxG.toFixed(1), 80, 640, col, 'left', font(30));
      text(g, 'NAV', 80, 720, col, 'left', font(30));
      text(g, 'AL 500', 826, 650, col, 'left', font(28));
      text(g, pad(Math.round(dnm), 3) + '>' + pad(stpt.n, 2), 826, 700, col, 'left', font(30));
      text(g, pad(Math.floor(ttg / 60), 2) + ':' + pad(Math.floor(ttg % 60), 2), 826, 740, col, 'left', font(30));
    } else {
      text(g, 'NAV', 80, 800, col, 'left', font(30));
      text(g, 'STPT ' + stpt.n, 780, 760, col, 'left', font(28));
      text(g, dnm.toFixed(1) + ' NM', 780, 800, col, 'left', font(28));
      text(g, pad(Math.floor(ttg / 60), 2) + ':' + pad(Math.floor(ttg % 60), 2), 780, 840, col, 'left', font(28));
      text(g, 'GUN 480', 80, 840, col, 'left', font(28));
    }
    // ------------------------------------------------ warnings
    if (S.warn.pullUp) { g.lineWidth = 6; line(g, 320, 220, 680, 580); line(g, 680, 220, 320, 580); }
    if ((S.warn.stall || S.aoa > 25) && Math.floor(S.t * 3) % 2 === 0) text(g, 'STALL', 500, 700, col, 'center', font(40));
    if (S.warn.gear && !S.gearDown && Math.floor(S.t * 2) % 2 === 0) text(g, 'GEAR', 500, 740, col, 'center', font(36));
    g.lineCap = 'butt';
  };
}

/**
 * Conformal HUD calibration from the cockpit geometry: casts rays from the pilot eye (aircraft frame, nose −Z) through the
 * combiner mesh and returns { fovDeg, boresight, aspect } for createDisplay, or null when the boresight is not on the glass.
 * mesh: the screen_hud mesh (a quad facing aft, spanning X, tilted about X); eye: THREE.Vector3 in `root` space.
 */
export function calibrateHud(THREE, mesh, eye, root = null) {
  try {
    (root || mesh).updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(mesh);
    const eyeW = root ? eye.clone().applyMatrix4(root.matrixWorld) : eye.clone();
    const q = new THREE.Quaternion(); if (root) root.getWorldQuaternion(q);
    const rc = new THREE.Raycaster();
    const hit = (elev, az = 0) => {
      const e = elev * Math.PI / 180, a = az * Math.PI / 180;
      rc.set(eyeW, new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).applyQuaternion(q));
      const h = rc.intersectObject(mesh, false)[0];
      return h ? { fy: (box.max.y - h.point.y) / (box.max.y - box.min.y), fx: (h.point.x - box.min.x) / (box.max.x - box.min.x) } : null;
    };
    const b = hit(0), lo = hit(-8), side = hit(0, 5);
    if (!b || !lo || b.fy < 0.08 || b.fy > 0.6) return null;
    const fovDeg = 8 / Math.abs(lo.fy - b.fy);
    const hFov = side ? 5 / Math.abs(side.fx - b.fx) : fovDeg;
    return { fovDeg, boresight: b.fy, aspect: Math.min(1.6, Math.max(0.8, hFov / fovDeg)) };
  } catch { return null; }
}
