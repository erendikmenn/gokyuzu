// F-22A Raptor displays: HUD, UFD (up-front display: CNI + ICAWS), PMFD (tactical situation display over a dark
// relief map) and SMFD (engine / fuel page).
import { font, text, line, poly, circle, clamp, wrap360, wrap180, pad, DEG, NM, FT, smoothK, clockUTC } from './core.js';
import { MapView, drawRunways, terrainGrid, reliefFor, traffic, clockSeconds, STEERPOINTS, steerpoint, bearingTo, distTo, LANDMARKS } from './nav.js';
import { createHud } from './hud.js';

export const RC = { green: '#3dff6a', cyan: '#3fdcff', white: '#f2f6fa', grey: '#8f9aa6', dgrey: '#4a525c', amber: '#ffb000', yellow: '#ffe24a', red: '#ff3a30', magenta: '#ff5cff' };

function bezel(g, labels) {
  g.font = font(28);
  (labels.top || []).forEach((s, i) => s && text(g, s, 170 + i * 165, 40, RC.cyan, 'center'));
  (labels.bottom || []).forEach((s, i) => s && text(g, s, 170 + i * 165, 985, RC.cyan, 'center'));
}

// ---------------------------------------------------------------- PMFD: tactical situation display
function f22Pmfd(env) {
  const OX = 500, OY = 620, R = 420;
  const view = new MapView();
  const frame = env.layer((g) => { bezel(g, { top: ['TSD', 'RNG', 'DCLTR', 'HDG UP', 'ZOOM'], bottom: ['ENG', 'FUEL', 'SMS', 'CNI', 'TSD'] }); });
  return (g, S, ctx) => {
    g.fillStyle = '#05080c'; g.fillRect(0, 0, 1000, 1000);
    const range = S.alt > 30000 ? 40 : S.alt > 15000 ? 20 : 10, k = R / (range * NM);
    view.set(OX, OY, S.x, S.z, S.hdg, k);
    const G = terrainGrid(ctx.world);
    g.save(); g.beginPath(); g.rect(20, 60, 960, 880); g.clip();
    if (G) {
      G.tick();
      const rel = reliefFor(G, 'dark');
      if (rel && rel.hasContent) { g.save(); view.apply(g); rel.draw(g); g.restore(); }
    }
    // rings + compass
    g.strokeStyle = RC.dgrey; g.lineWidth = 3; g.setLineDash([16, 14]);
    circle(g, OX, OY, R / 2); g.stroke(); g.setLineDash([]);
    g.strokeStyle = RC.grey; circle(g, OX, OY, R); g.stroke();
    g.font = font(28); g.textAlign = 'center'; g.fillStyle = RC.grey;
    for (let d = 0; d < 360; d += 10) {
      const a = (d - S.hdg) * DEG, s = Math.sin(a), c = Math.cos(a), l = d % 30 === 0 ? 24 : 12;
      line(g, OX + s * R, OY - c * R, OX + s * (R - l), OY - c * (R - l));
      if (d % 30 === 0) {
        const lbl = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
        g.fillText(lbl, OX + s * (R - 48), OY - c * (R - 48) + 10);
      }
    }
    // runways, airports, landmarks
    drawRunways(g, ctx.nav, view, RC.white, 4, 'rgba(255,255,255,0.25)');
    g.font = font(22); g.textAlign = 'left'; g.fillStyle = RC.grey;
    for (const a of ctx.nav.airports) { view.project(a.x, a.z); g.fillText(a.icao, view.px + 24, view.py + 30); }
    const placed = [];
    for (const l of LANDMARKS) {
      view.project(l.x, l.z);
      if (placed.some((p) => Math.abs(p[0] - view.px) < 170 && Math.abs(p[1] - view.py) < 30)) continue;
      placed.push([view.px, view.py]);
      g.strokeStyle = RC.grey; g.lineWidth = 2; poly(g, [view.px, view.py - 8, view.px + 7, view.py + 5, view.px - 7, view.py + 5]); g.stroke();
      g.fillText(l.name, view.px + 12, view.py + 6);
    }
    // route
    const sp = steerpoint(ctx.flight, S.x, S.z);
    g.strokeStyle = RC.cyan; g.lineWidth = 3; g.beginPath();
    STEERPOINTS.forEach((p, i) => { view.project(p.x, p.z); if (i) g.lineTo(view.px, view.py); else g.moveTo(view.px, view.py); });
    view.project(STEERPOINTS[0].x, STEERPOINTS[0].z); g.lineTo(view.px, view.py); g.stroke();
    g.font = font(24); g.textAlign = 'center';
    STEERPOINTS.forEach((p, i) => {
      view.project(p.x, p.z);
      g.fillStyle = i === sp.i ? RC.cyan : '#05080c'; circle(g, view.px, view.py, 14); g.fill(); g.stroke();
      text(g, String(p.n), view.px, view.py + 9, i === sp.i ? '#000' : RC.cyan, 'center');
    });
    // tracks
    for (const o of traffic(clockSeconds())) {
      view.project(o.x, o.z); const x = view.px, y = view.py;
      let c = RC.white;
      if (o.kind === 'hostile') {
        c = RC.red;
        g.strokeStyle = 'rgba(255,58,48,0.55)'; g.lineWidth = 2.5; g.setLineDash([10, 10]); circle(g, x, y, 12 * NM * k); g.stroke(); g.setLineDash([]);
      } else if (o.kind === 'fighter') c = RC.green;
      g.strokeStyle = c; g.lineWidth = 3.5;
      if (o.kind === 'hostile') { poly(g, [x, y - 16, x + 14, y + 10, x - 14, y + 10]); g.stroke(); }
      else if (o.kind === 'fighter') { circle(g, x, y, 13); g.stroke(); }
      else { poly(g, [x - 12, y + 6, x - 12, y - 10, x + 12, y - 10, x + 12, y + 6], false); g.stroke(); }
      const va = (o.hdg - S.hdg) * DEG, vl = 18 + o.gs * 0.12;
      line(g, x, y, x + Math.sin(va) * vl, y - Math.cos(va) * vl);
      text(g, String(Math.round(o.alt * FT / 1000)), x, y + 38, c, 'center', font(24));
    }
    g.restore();
    // ownship
    g.fillStyle = RC.white;
    poly(g, [OX, OY - 26, OX + 10, OY - 6, OX + 24, OY + 8, OX + 10, OY + 8, OX + 8, OY + 20, OX - 8, OY + 20, OX - 10, OY + 8, OX - 24, OY + 8, OX - 10, OY - 6]); g.fill();
    frame.blit(g);
    const p = STEERPOINTS[sp.i];
    text(g, 'RNG ' + range, 40, 96, RC.cyan, 'left', font(30));
    text(g, `STPT ${p.n} ${pad(Math.round(wrap360(bearingTo(S.x, S.z, p.x, p.z) - S.decl)), 3)}/${(distTo(S.x, S.z, p.x, p.z) / NM).toFixed(1)}`, 960, 96, RC.cyan, 'right', font(30));
    text(g, pad(Math.round(S.hdgMag), 3), OX, 96, RC.white, 'center', font(34));
    text(g, `${Math.round(S.gs)} GS`, 40, 930, RC.white, 'left', font(28));
    text(g, `${Math.round(S.alt / 100) * 100}`, 960, 930, RC.white, 'right', font(28));
  };
}

// ---------------------------------------------------------------- SMFD: engine + fuel
function f22Smfd(env) {
  const st = { nh: [0, 0], temp: [0, 0], noz: [0, 0], ff: 0 };
  const cols = [300, 700];
  const bars = [['NH', '%', 0, 110, 104], ['TEMP', '°C', 0, 1100, 1000], ['NOZ', '%', 0, 100, 100]];
  const frame = env.layer((g) => {
    g.fillStyle = '#05080c'; g.fillRect(0, 0, 1000, 1000);
    bezel(g, { top: ['ENG', 'FUEL', 'HYD', 'ELEC', 'ICAW'], bottom: ['TSD', 'SMS', 'CNI', 'CKLST', 'MENU'] });
    text(g, 'L ENG', cols[0], 110, RC.white, 'center', font(34)); text(g, 'R ENG', cols[1], 110, RC.white, 'center', font(34));
    g.strokeStyle = RC.dgrey; g.lineWidth = 2; line(g, 500, 80, 500, 560); line(g, 40, 580, 960, 580);
    for (const cx of cols) {
      bars.forEach(([lbl, unit, lo, hi, red], i) => {
        const x = cx - 120 + i * 120;
        g.strokeStyle = RC.grey; g.lineWidth = 2.5; g.strokeRect(x - 18, 190, 36, 300);
        const ry = 490 - (red - lo) / (hi - lo) * 300;
        g.strokeStyle = RC.red; g.lineWidth = 4; line(g, x - 26, ry, x + 26, ry);
        text(g, lbl, x, 530, RC.cyan, 'center', font(24)); text(g, unit, x, 556, RC.grey, 'center', font(20));
      });
    }
    // fuel plan view
    g.strokeStyle = RC.grey; g.lineWidth = 3;
    const pv = [500, 610, 530, 680, 540, 760, 690, 850, 690, 880, 545, 860, 540, 900, 590, 940, 410, 940, 460, 900, 455, 860, 310, 880, 310, 850, 460, 760, 470, 680];
    poly(g, pv.map((v, i) => (i % 2 ? 610 + (v - 610) * 0.95 : 560 + (v - 500) * 0.72))); g.stroke();
    text(g, 'FUEL', 80, 640, RC.white, 'left', font(34));
    for (const [s, y] of [['TOTAL', 700], ['INT', 750], ['EXT', 800], ['BINGO', 870], ['JOKER', 920]]) text(g, s, 80, y, RC.cyan, 'left', font(28));
    for (const [s, y] of [['FF', 700], ['HYD A', 800], ['HYD B', 850], ['OIL L/R', 920]]) text(g, s, 740, y, RC.cyan, 'left', font(26));
  });
  return (g, S) => {
    frame.blit(g);
    const k = smoothK(S.dt, 1.5);
    const n = Math.max(1, S.engineCount);
    let ffTot = 0;
    for (let i = 0; i < 2; i++) {
      const e = S.engines[Math.min(i, n - 1)] || { n1: 0, ab: 0, ff: 0 };
      // fighter models report a core-speed-like N (idle ≈ 68 %, MIL = 100 %): use it as NH directly
      const nh = e.n1;
      st.nh[i] += (nh - st.nh[i]) * k;
      st.temp[i] += ((e.n1 < 5 ? 30 : 300 + clamp((e.n1 - 60) / 40, 0, 1) * 560 + e.ab * 140) - st.temp[i]) * k;
      st.noz[i] += ((e.ab > 0.02 ? 70 + e.ab * 30 : clamp(40 - e.n1 * 0.3, 8, 40)) - st.noz[i]) * k;
      ffTot += e.ff > 0 ? e.ff * 2.2046 : (e.n1 < 5 ? 0 : 1500 + e.n1 * e.n1 * 1.1 + e.ab * 30000);
      const cx = cols[i], vals = [st.nh[i], st.temp[i], st.noz[i]];
      bars.forEach(([lbl, unit, lo, hi, red], j) => {
        const x = cx - 120 + j * 120, v = vals[j], f = clamp((v - lo) / (hi - lo), 0, 1);
        const c = v > red ? RC.red : j === 1 && v > red * 0.93 ? RC.amber : RC.green;
        g.fillStyle = c; g.fillRect(x - 14, 490 - f * 300, 28, f * 300 - 3);
        text(g, j === 1 ? String(Math.round(v / 5) * 5) : String(Math.round(v)), x, 172, c, 'center', font(30));
      });
      if (e.ab > 0.02) { g.fillStyle = RC.amber; g.fillRect(cx + 86, 86, 70, 32); text(g, 'AB', cx + 121, 112, '#000', 'center', font(28)); }
    }
    st.ff += (ffTot - st.ff) * k;
    const lbs = S.fuel * 2.2046;
    const tot = Math.round(lbs / 10) * 10;
    text(g, String(tot), 370, 700, lbs < 3500 ? RC.amber : RC.green, 'right', font(32));
    text(g, String(tot), 370, 750, RC.green, 'right', font(30));
    text(g, '0', 370, 800, RC.green, 'right', font(30));
    text(g, '3500', 370, 870, RC.white, 'right', font(30));
    text(g, '5000', 370, 920, RC.white, 'right', font(30));
    text(g, String(Math.round(st.ff / 10) * 10), 960, 740, RC.green, 'right', font(30));
    text(g, '4000', 960, 800, RC.green, 'right', font(28)); text(g, '4000', 960, 850, RC.green, 'right', font(28));
    text(g, `${Math.round(40 + st.nh[0] * 0.1)}/${Math.round(40 + st.nh[1] * 0.1)}`, 960, 920, RC.green, 'right', font(28));
    // fuel quantity fill in the plan view (wing + fuselage tanks)
    const fr = clamp(lbs / 18000, 0, 1);
    g.fillStyle = 'rgba(61,255,106,0.35)';
    g.fillRect(538, 920 - 230 * fr, 44, 230 * fr);
    g.fillRect(439, 865 - 18 * fr, 86, 18 * fr); g.fillRect(595, 865 - 18 * fr, 86, 18 * fr);
  };
}

// ---------------------------------------------------------------- UFDs (4:3): left = CNI, right = ICAWS
function f22UfdCni(env) {
  return (g, S, ctx) => {
    g.fillStyle = '#04070a'; g.fillRect(0, 0, 1000, 750);
    const sp = steerpoint(ctx.flight, S.x, S.z), p = STEERPOINTS[sp.i];
    const brg = pad(Math.round(wrap360(bearingTo(S.x, S.z, p.x, p.z) - S.decl)), 3), rng = (distTo(S.x, S.z, p.x, p.z) / NM).toFixed(1);
    const ttg = S.gs > 30 ? distTo(S.x, S.z, p.x, p.z) / NM / S.gs * 3600 : 0;
    const row = (y, parts) => { let x = 36; for (const [s2, c, w] of parts) { text(g, s2, x, y, c, 'left', font(52, true, true)); x += w; } };
    row(90, [['COM1', RC.cyan, 170], ['305.00', RC.green, 0]]);
    row(170, [['COM2', RC.cyan, 170], ['121.50', RC.green, 0]]);
    row(250, [['NAV ', RC.cyan, 170], ['TCN 071X', RC.green, 0]]);
    row(330, [['IFF ', RC.cyan, 170], ['M3 4432 C', RC.green, 0]]);
    g.strokeStyle = RC.dgrey; g.lineWidth = 3; line(g, 20, 365, 980, 365);
    row(440, [['STPT', RC.cyan, 170], [`${p.n} ${p.name}`, RC.white, 0]]);
    row(520, [['BRG ', RC.cyan, 170], [brg + '°', RC.green, 250], ['RNG', RC.cyan, 160], [rng, RC.green, 0]]);
    row(600, [['TTG ', RC.cyan, 170], [pad(Math.floor(ttg / 60), 2) + ':' + pad(Math.floor(ttg % 60), 2), RC.green, 250], ['GS', RC.cyan, 160], [String(Math.round(S.gs)), RC.green, 0]]);
    const lbs = Math.round(S.fuel * 2.2046 / 10) * 10;
    row(690, [['FUEL', RC.cyan, 170], [String(lbs), lbs < 5000 ? RC.amber : RC.green, 250], ['BNGO', RC.cyan, 160], ['3500', RC.white, 0]]);
  };
}
function f22UfdIcaws(env) {
  return (g, S) => {
    g.fillStyle = '#04070a'; g.fillRect(0, 0, 1000, 750);
    text(g, 'ICAWS', 36, 80, RC.grey, 'left', font(44, true, true));
    text(g, clockUTC() + 'Z', 964, 80, RC.green, 'right', font(48, true, true));
    g.strokeStyle = RC.dgrey; g.lineWidth = 3; line(g, 20, 110, 980, 110);
    const msgs = [];
    if (S.warn.pullUp) msgs.push(['PULL UP', RC.red]);
    if (S.warn.stall) msgs.push(['AOA LIMIT', RC.red]);
    if (S.warn.overspeed) msgs.push(['OVERSPEED', RC.red]);
    if (S.warn.gear && !S.gearDown) msgs.push(['GEAR NOT DOWN', RC.red]);
    if (S.warn.sinkRate) msgs.push(['SINK RATE', RC.amber]);
    if (S.warn.bank) msgs.push(['BANK ANGLE', RC.amber]);
    if (S.fuel * 2.2046 < 5000) msgs.push(['FUEL LOW', RC.amber]);
    if (S.canopy > 0.02) msgs.push(['CANOPY', RC.amber]);
    if (S.parkingBrake) msgs.push(['PARK BRAKE', RC.amber]);
    if (S.engines[0] && S.engines[0].ab > 0.02) msgs.push(['AB ON', RC.green]);
    if (!S.gearUp && !S.onGround) msgs.push([S.gearDown ? 'GEAR DOWN' : 'GEAR TRANSIT', S.gearDown ? RC.green : RC.amber]);
    if (S.speedbrake > 0.05) msgs.push(['SPD BRK', RC.green]);
    if (S.ap.on) msgs.push(['AUTOPILOT', RC.green]);
    if (!msgs.length) msgs.push(['NO ALERTS', RC.grey]);
    msgs.slice(0, 6).forEach(([m, c], i) => {
      const flash = c === RC.red && Math.floor(S.t * 2) % 2 === 0;
      if (flash) { g.fillStyle = c; g.fillRect(30, 140 + i * 96, 940, 80); }
      text(g, m, 60, 200 + i * 96, flash ? '#000' : c, 'left', font(56, true, true));
    });
  };
}

// ---------------------------------------------------------------- SMFD pages: stores (SMS) and phase checklist
function f22Sms(env) {
  const frame = env.layer((g) => {
    g.fillStyle = '#05080c'; g.fillRect(0, 0, 1000, 1000);
    bezel(g, { top: ['SMS', 'A/A', 'A/G', 'JETT', 'INV'], bottom: ['TSD', 'ENG', 'CNI', 'CKLST', 'MENU'] });
    // planform
    g.strokeStyle = RC.grey; g.lineWidth = 3;
    poly(g, [500, 120, 540, 250, 560, 420, 820, 600, 820, 660, 600, 660, 640, 760, 680, 900, 560, 880, 540, 820, 460, 820, 440, 880, 320, 900, 360, 760, 400, 660, 180, 660, 180, 600, 440, 420, 460, 250]); g.stroke();
    text(g, 'MAIN BAY', 500, 470, RC.cyan, 'center', font(26));
    text(g, 'L SIDE', 330, 520, RC.cyan, 'center', font(24)); text(g, 'R SIDE', 670, 520, RC.cyan, 'center', font(24));
  });
  const missile = (g, x, y, w, h, c, sel) => {
    g.fillStyle = c; rrectFill(g, x - w / 2, y - h / 2, w, h, w / 2);
    if (sel) { g.strokeStyle = RC.white; g.lineWidth = 3; g.strokeRect(x - w / 2 - 8, y - h / 2 - 8, w + 16, h + 16); }
  };
  return (g, S) => {
    frame.blit(g);
    for (let i = 0; i < 6; i++) missile(g, 440 + (i % 3) * 60, 540 + Math.floor(i / 3) * 110, 26, 96, RC.green, i === 0);
    missile(g, 330, 600, 22, 90, RC.green, false); missile(g, 670, 600, 22, 90, RC.green, false);
    text(g, 'AIM-120C  6', 60, 180, RC.white, 'left', font(34)); text(g, 'AIM-9X    2', 60, 230, RC.white, 'left', font(34));
    text(g, 'GUN  480', 60, 280, RC.white, 'left', font(34));
    g.strokeStyle = RC.white; g.lineWidth = 3; g.strokeRect(48, 146, 290, 46);
    text(g, 'BAY DOORS', 940, 180, RC.cyan, 'right', font(28)); text(g, 'CLSD', 940, 220, RC.green, 'right', font(32));
    text(g, 'MASTER ARM', 940, 300, RC.cyan, 'right', font(28)); text(g, 'SAFE', 940, 340, RC.white, 'right', font(32));
    text(g, S.gearDown ? 'GEAR DN - ARM INHIBIT' : 'READY', 500, 950, S.gearDown ? RC.amber : RC.green, 'center', font(28));
  };
}
function rrectFill(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill(); }

function f22Checklist(env) {
  const frame = env.layer((g) => { g.fillStyle = '#05080c'; g.fillRect(0, 0, 1000, 1000); bezel(g, { top: ['CKLST', 'NORM', 'EMER', '', 'PAGE'], bottom: ['TSD', 'ENG', 'SMS', 'CNI', 'MENU'] }); });
  return (g, S) => {
    frame.blit(g);
    let title, items;
    const eng = S.engines[0] || { n1: 0 };
    if (S.onGround && S.gs < 30) {
      title = 'BEFORE TAKEOFF';
      items = [['CANOPY', 'CLOSED', S.canopy < 0.02], ['FLAPS', 'AUTO', true], ['TRIM', 'SET', true], ['IFF', 'ON', true],
        ['MASTER ARM', 'SAFE', true], ['ENGINES', 'CHECKED', eng.n1 > 60], ['PARK BRAKE', 'RELEASED', !S.parkingBrake]];
    } else if (!S.onGround && (S.gearHandleDown || S.agl < 3000) && S.vs < 200) {
      title = 'LANDING';
      items = [['GEAR', 'DOWN 3 GREEN', S.gearDown], ['SPEEDBRAKE', 'AS REQD', true], ['HOOK', 'UP', true], ['LDG LIGHT', 'ON', S.gearDown],
        ['AOA', 'ON SPEED', S.aoa > 11 && S.aoa < 15], ['FUEL', 'CHECKED', S.fuel > 500]];
    } else if (!S.onGround && S.agl < 5000) {
      title = 'AFTER TAKEOFF';
      items = [['GEAR', 'UP', S.gearUp], ['FLAPS', 'AUTO', true], ['AB', 'AS REQD', true], ['CLIMB', 'CHECKED', S.vs > 0]];
    } else if (!S.onGround) {
      title = 'CRUISE';
      items = [['FUEL', 'BALANCED', true], ['OXYGEN', 'CHECKED', true], ['ALTIMETER', S.alt > 18000 ? 'STD' : '29.92', true], ['ICAWS', 'CLEAR', !S.warn.stall && !S.warn.overspeed]];
    } else {
      title = 'AFTER LANDING';
      items = [['SPEEDBRAKE', 'RETRACT', S.speedbrake < 0.05], ['FLAPS', 'AUTO', true], ['MASTER ARM', 'SAFE', true], ['CANOPY', 'AS REQD', true]];
    }
    text(g, title, 500, 140, RC.white, 'center', font(44));
    g.strokeStyle = RC.dgrey; g.lineWidth = 3; line(g, 60, 170, 940, 170);
    items.forEach(([a, b, ok], i) => {
      const y = 250 + i * 90;
      text(g, a, 80, y, ok ? RC.green : RC.white, 'left', font(36));
      g.font = font(36); const wa = g.measureText(a).width, wb = g.measureText(b).width;
      g.setLineDash([4, 10]); g.strokeStyle = RC.dgrey; g.lineWidth = 3; line(g, 96 + wa, y - 10, 884 - wb, y - 10); g.setLineDash([]);
      text(g, b, 900, y, ok ? RC.green : RC.cyan, 'right', font(36));
      if (ok) { g.strokeStyle = RC.green; g.lineWidth = 5; poly(g, [920, y - 18, 932, y - 4, 956, y - 34], false); g.stroke(); }
    });
    const done = items.filter((x) => x[2]).length;
    text(g, done === items.length ? 'CHECKLIST COMPLETE' : `${done}/${items.length}`, 500, 920, done === items.length ? RC.green : RC.amber, 'center', font(32));
  };
}

export const F22 = {
  'f22.hud': { vw: 1300, vh: 1000, size: 1024, transparent: true, create: (env) => createHud(env, 'f22') },
  'f22.ufd': { vw: 1000, vh: 750, size: 512, variants: ['f22.ufd.cni', 'f22.ufd.icaws'] },
  'f22.ufd.cni': { vw: 1000, vh: 750, size: 512, hz: 4, create: f22UfdCni },
  'f22.ufd.icaws': { vw: 1000, vh: 750, size: 512, hz: 4, create: f22UfdIcaws },
  'f22.pmfd': { vw: 1000, vh: 1000, size: 1024, hz: 10, create: f22Pmfd },
  'f22.smfd': { vw: 1000, vh: 1000, size: 512, variants: ['f22.smfd.sms', 'f22.smfd.cklst', 'f22.smfd.eng'] },
  'f22.smfd.sms': { vw: 1000, vh: 1000, size: 512, hz: 2, create: f22Sms },
  'f22.smfd.cklst': { vw: 1000, vh: 1000, size: 512, hz: 4, create: f22Checklist },
  'f22.smfd.eng': { vw: 1000, vh: 1000, size: 512, hz: 10, create: f22Smfd },
};
