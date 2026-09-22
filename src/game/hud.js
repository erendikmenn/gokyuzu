// Glass-cockpit HUD.
// - Flight instruments (pitch ladder, roll scale, speed/altitude/heading tapes, VSI, flight path marker,
//   target cue) are drawn on one centered 2D canvas each frame (no DOM layout work).
// - Panels (mission, minimap, engine/config), warnings, toast, help and pause are DOM elements whose
//   text nodes / transforms are only touched when their value changes.
import * as THREE from 'three';
import { WORLD, RUNWAY } from '../config.js';

const KT = 1.943844;     // m/s → knots
const FT = 3.28084;      // m → feet
const FPM = FT * 60;     // m/s → ft/min
const DEG = Math.PI / 180;

const C = {
  fg: 'rgba(238,246,255,0.96)',
  dim: 'rgb(176,194,214)',
  halo: 'rgba(2,10,20,0.38)',
  accent: '#5cf2c8',
  warn: '#ff4d4f',
  caution: '#ffb020',
  tapeBg: 'rgba(6,12,22,0.34)',
  tapeEdge: 'rgba(255,255,255,0.12)',
  boxBg: 'rgba(3,8,14,0.88)',
};
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

// Instrument geometry in design units (du); 1 du = s CSS px, s = viewport height / 900.
const PPD = 12;                     // pitch ladder px per degree (≈ chase camera's px/deg at 900 px height)
const CANVAS_W = 980, CANVAS_H = 660;
const SPD = { x1: -348, w: 84, h: 320, ppk: 3.2 };    // x1 = inner (right) edge
const ALT = { x0: 348, w: 96, h: 320, ppf: 0.34 };    // x0 = inner (left) edge
const HDG = { y0: -318, h: 34, w: 500, ppd: 3.3 };
const ROLL_R = 212;

const MAP_SPAN = 7000;   // meters shown across the minimap
const MAP_N = 240;       // terrain samples per side (over WORLD.size)

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./ui.css', import.meta.url).href;
  document.head.appendChild(link);
}

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;

export function fmtTime(t) {
  if (t == null || !Number.isFinite(t)) return '--:--.-';
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}
function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`;
}

export function createHUD(container, world) {
  injectCSS();
  const root = el('div', 'gk-hud', container);
  const inst = el('div', 'gk-inst', root);

  // ---------- instrument canvas ----------
  const cv = el('canvas', 'gk-cv', inst);
  const ctx = cv.getContext('2d');

  // ---------- warnings ----------
  const warnBox = el('div', 'gk-warn', inst);
  const wStall = el('div', 'gk-w gk-w-stall', warnBox, 'STALL');
  const wPull = el('div', 'gk-w gk-w-pull', warnBox, 'PULL UP');
  const wLow = el('div', 'gk-w gk-w-low', warnBox, 'ALÇAK İRTİFA');
  const warnState = { stall: false, pull: false, low: false };

  // ---------- mission panel ----------
  const mp = el('div', 'gk-panel gk-mission', inst);
  const mTitle = el('div', 'gk-m-title', mp, '');
  const mObj = el('div', 'gk-m-obj', mp, '');
  const mRow = el('div', 'gk-m-row', mp);
  const mRings = el('div', 'gk-m-rings', mRow);
  const mRingsDone = el('b', null, mRings, '0');
  const mRingsTot = document.createTextNode('/0');
  mRings.appendChild(mRingsTot);
  const mTime = el('div', 'gk-m-time', mRow, '00:00.0');
  const mProg = el('div', 'gk-m-prog', mp);
  const mProgBar = el('i', null, mProg);
  const mFoot = el('div', 'gk-m-foot', mp);
  const mBestWrap = el('span', null, mFoot, 'REKOR');
  const mBest = el('b', null, mBestWrap, '--:--.-');
  const mScoreWrap = el('span', null, mFoot, 'PUAN');
  const mScore = el('b', null, mScoreWrap, '0');

  // ---------- minimap ----------
  const mapPanel = el('div', 'gk-panel gk-map', inst);
  const mapCv = el('canvas', null, mapPanel);
  const mctx = mapCv.getContext('2d');
  let mapImg = null;         // offscreen canvas with the shaded terrain (MAP_N x MAP_N over WORLD.size)
  let mapSize = 204;

  // ---------- engine / config cluster ----------
  const eng = el('div', 'gk-panel gk-eng', inst);
  el('div', 'gk-cap', eng, 'GAZ');
  const thrBar = el('div', 'gk-bar gk-acc', eng);
  const thrFill = el('i', null, thrBar);
  const thrVal = el('div', 'gk-val', eng, '0%');
  el('div', 'gk-cap', eng, 'FLAP');
  const flapBar = el('div', 'gk-bar', eng);
  const flapFill = el('i', null, flapBar);
  el('span', 'gk-notch', flapBar).style.left = '50%';
  const flapVal = el('div', 'gk-val', eng, '0°');
  const engFoot = el('div', 'gk-eng-foot', eng);
  const pBrake = el('span', 'gk-pill', engFoot, 'FREN');
  const pGround = el('span', 'gk-pill gk-pill-acc', engFoot, 'YERDE');
  const fpsEl = el('span', 'gk-fps', engFoot, '');
  const showFps = /[?&]fps\b/.test(location.search);
  if (!showFps) fpsEl.style.display = 'none';

  // ---------- toast / help / pause (not affected by setVisible) ----------
  const toast = el('div', 'gk-toast', root);
  const help = el('div', 'gk-help', root);
  const helpCard = el('div', 'gk-panel gk-help-card', help);
  let helpBindings = null;
  const pause = el('div', 'gk-pause', root);
  el('div', 'gk-pt', pause, 'DURAKLATILDI');
  const ps = el('div', 'gk-ps', pause);
  el('span', 'gk-pl', ps);
  const psTxt = el('span', null, ps);
  psTxt.append('devam için ');
  el('kbd', null, psTxt, 'P');
  el('span', 'gk-pl', ps);

  // ---------- text caches (only write DOM when changed) ----------
  const cache = new Map();
  const setText = (node, str) => { if (cache.get(node) !== str) { cache.set(node, str); node.textContent = str; } };
  const setScale = (node, v) => {
    const k = Math.round(clamp(v, 0, 1) * 500) / 500;
    if (cache.get(node) !== k) { cache.set(node, k); node.style.transform = `scaleX(${k})`; }
  };
  const setClass = (node, cls, on) => {
    const key = `${cls}`;
    const map = cache.get(node) || {};
    if (map[key] !== on) { map[key] = on; cache.set(node, map); node.classList.toggle(cls, on); }
  };

  // ---------- brake state (FlightModel has no brake field in the contract; fall back to keys) ----------
  const brakeKeys = new Set();
  const onKey = (e) => {
    if (e.code === 'KeyB' || e.code === 'Space') {
      if (e.type === 'keydown') brakeKeys.add(e.code); else brakeKeys.delete(e.code);
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => brakeKeys.clear());

  // ---------- layout ----------
  let s = 1, dpr = 1, cssW = 0, cssH = 0, vw = 0, vh = 0;
  function layout() {
    vw = container.clientWidth || window.innerWidth;
    vh = container.clientHeight || window.innerHeight;
    s = clamp(Math.min(vh / 900, vw / 1180), 0.6, 1.8);
    const pscale = clamp(s, 0.8, 1.5);
    root.style.setProperty('--s', s.toFixed(4));
    root.style.setProperty('--ps', pscale.toFixed(4));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.round(CANVAS_W * s);
    cssH = Math.round(CANVAS_H * s);
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    cv.style.left = `${Math.round(vw / 2 - cssW / 2)}px`;
    cv.style.top = `${Math.round(vh / 2 - cssH / 2)}px`;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    mapSize = Math.round(204 * pscale);
    mapCv.width = Math.round(mapSize * dpr);
    mapCv.height = Math.round(mapSize * dpr);
  }
  layout();
  window.addEventListener('resize', layout);

  // ---------- minimap terrain (sampled once, in time-sliced chunks so startup doesn't stall) ----------
  buildMapImage();
  function buildMapImage() {
    if (!world || typeof world.getGroundHeight !== 'function') return;
    const N = MAP_N, S = WORLD.size, cell = S / N;
    const hts = new Float32Array(N * N);
    const wat = new Uint8Array(N * N);
    let row = 0;
    const slice = () => {
      const t0 = performance.now();
      while (row < N && performance.now() - t0 < 6) {
        const z = -S / 2 + (row + 0.5) * cell;
        for (let i = 0; i < N; i++) {
          const x = -S / 2 + (i + 0.5) * cell;
          let h = WORLD.seaLevel, w = false;
          try {
            h = world.getGroundHeight(x, z);
            w = typeof world.isWater === 'function' ? !!world.isWater(x, z) : h <= WORLD.seaLevel + 0.01;
          } catch { /* keep defaults */ }
          hts[row * N + i] = Number.isFinite(h) ? h : 0;
          wat[row * N + i] = w ? 1 : 0;
        }
        row++;
      }
      if (row < N) setTimeout(slice, 0);
      else paintMap(hts, wat);
    };
    setTimeout(slice, 30);
  }

  function paintMap(hts, wat) {
    const N = MAP_N, cell = WORLD.size / N;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const d = img.data;
    const stops = [
      [0, 190, 184, 142], [10, 96, 136, 72], [120, 108, 140, 74], [300, 132, 130, 90],
      [500, 128, 118, 104], [700, 172, 168, 164], [900, 228, 232, 236],
    ];
    const ramp = (h, out) => {
      if (h <= stops[0][0]) { out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3]; return; }
      for (let k = 1; k < stops.length; k++) {
        if (h <= stops[k][0] || k === stops.length - 1) {
          const a = stops[k - 1], b = stops[k];
          const t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
          out[0] = a[1] + (b[1] - a[1]) * t; out[1] = a[2] + (b[2] - a[2]) * t; out[2] = a[3] + (b[3] - a[3]) * t;
          return;
        }
      }
    };
    const rgb = [0, 0, 0];
    const L = new THREE.Vector3(-1, 1.6, -1).normalize();   // light from the north-west
    const flat = L.y;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, p = k * 4;
        if (wat[k]) {
          // shallow tint next to land
          let shore = 0;
          for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
            const jj = j + dj, ii = i + di;
            if (jj >= 0 && jj < N && ii >= 0 && ii < N && !wat[jj * N + ii]) shore = Math.max(shore, 1 - (Math.abs(di) + Math.abs(dj)) / 5);
          }
          d[p] = 26 + 26 * shore; d[p + 1] = 70 + 40 * shore; d[p + 2] = 104 + 34 * shore; d[p + 3] = 255;
          continue;
        }
        const h = hts[k];
        const hx = (hts[j * N + Math.min(N - 1, i + 1)] - hts[j * N + Math.max(0, i - 1)]) / (2 * cell);
        const hz = (hts[Math.min(N - 1, j + 1) * N + i] - hts[Math.max(0, j - 1) * N + i]) / (2 * cell);
        const nx = -hx * 2.2, nz = -hz * 2.2, inv = 1 / Math.hypot(nx, 1, nz);
        const shade = clamp(0.3 + 0.7 * ((nx * L.x + L.y + nz * L.z) * inv) / flat, 0.45, 1.25);
        ramp(h - WORLD.seaLevel, rgb);
        d[p] = clamp(rgb[0] * shade * 0.92, 0, 255);
        d[p + 1] = clamp(rgb[1] * shade * 0.92, 0, 255);
        d[p + 2] = clamp(rgb[2] * shade * 0.92, 0, 255);
        d[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    mapImg = c;
  }

  // ---------- drawing helpers ----------
  function stroke(w, color) {
    ctx.lineWidth = w + 2;
    ctx.strokeStyle = C.halo;
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  function fill(color) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.halo;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
  }
  function text(str, x, y, color, halo = true) {
    if (halo) { ctx.lineWidth = 2.6; ctx.strokeStyle = C.halo; ctx.strokeText(str, x, y); }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function tapeBg(x, y, w, h) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fillStyle = C.tapeBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.tapeEdge;
    ctx.stroke();
  }

  // ---------- per-frame derived state ----------
  const _q = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  const _d = new THREE.Vector3();
  let lastT = performance.now(), lastKt = 0, ktTrend = 0, lastFpsT = 0;
  let visible = true;
  let pulse = 0;

  // ---------- instruments ----------
  function drawInstruments(f, m) {
    const k = dpr * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(k, 0, 0, k, cv.width / 2, cv.height / 2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.textBaseline = 'middle';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const pitch = Number.isFinite(f.pitch) ? f.pitch : 0;
    const roll = Number.isFinite(f.roll) ? f.roll : 0;
    _q.copy(f.quaternion).invert();

    drawLadder(pitch, roll);
    drawRollScale(roll);
    drawFPM(f);
    drawTargetCue(f, m);
    drawAircraftSymbol();
    drawSpeedTape(f);
    drawAltTape(f, m);
    drawHeadingTape(f, m);
    drawReadouts(f);
  }

  function drawLadder(pitch, roll) {
    ctx.save();
    ctx.rotate(-roll * DEG);
    ctx.translate(0, pitch * PPD);
    ctx.font = `600 12px ${MONO}`;
    const lo = Math.ceil((pitch - 22) / 5) * 5, hi = Math.floor((pitch + 22) / 5) * 5;
    for (let p = lo; p <= hi; p += 5) {
      if (p < -90 || p > 90) continue;
      const dist = Math.abs(p - pitch) * PPD;
      const a = 1 - smoothstep(150, 245, dist);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      const y = -p * PPD;
      if (p === 0) {
        ctx.beginPath();
        ctx.moveTo(-318, y); ctx.lineTo(-58, y);
        ctx.moveTo(58, y); ctx.lineTo(318, y);
        stroke(1.7, C.fg);
        continue;
      }
      const major = p % 10 === 0;
      const x0 = 46, x1 = major ? 104 : 72;
      ctx.beginPath();
      if (p < 0) ctx.setLineDash([7, 6]);
      ctx.moveTo(-x1, y); ctx.lineTo(-x0, y);
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
      stroke(major ? 1.4 : 1.1, major ? C.fg : C.dim);
      ctx.setLineDash([]);
      if (major) {
        const t = p > 0 ? 7 : -7;
        ctx.beginPath();
        ctx.moveTo(-x1, y); ctx.lineTo(-x1, y + t);
        ctx.moveTo(x1, y); ctx.lineTo(x1, y + t);
        stroke(1.4, C.fg);
        const lab = String(Math.abs(p));
        ctx.textAlign = 'right'; text(lab, -x1 - 8, y, C.fg);
        ctx.textAlign = 'left'; text(lab, x1 + 8, y, C.fg);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawRollScale(roll) {
    const R = ROLL_R;
    // fixed scale
    ctx.beginPath();
    ctx.arc(0, 0, R, (-90 - 60) * DEG, (-90 + 60) * DEG);
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const len = (Math.abs(a) === 30 || Math.abs(a) === 60) ? 13 : 7;
      const r = (a - 90) * DEG;
      ctx.moveTo(Math.cos(r) * R, Math.sin(r) * R);
      ctx.lineTo(Math.cos(r) * (R + len), Math.sin(r) * (R + len));
    }
    stroke(1.2, C.dim);
    // fixed index (top)
    ctx.beginPath();
    ctx.moveTo(0, -R - 2); ctx.lineTo(-7, -R - 14); ctx.lineTo(7, -R - 14); ctx.closePath();
    fill(C.fg);
    // bank pointer (rotates with the horizon)
    ctx.save();
    ctx.rotate(-clamp(roll, -180, 180) * DEG);
    ctx.beginPath();
    ctx.moveTo(0, -R + 3); ctx.lineTo(-8, -R + 16); ctx.lineTo(8, -R + 16); ctx.closePath();
    fill(Math.abs(roll) > 45 ? C.caution : C.fg);
    ctx.restore();
  }

  function drawAircraftSymbol() {
    // "W" waterline mark + wing bars
    ctx.beginPath();
    ctx.moveTo(-40, 0); ctx.lineTo(-22, 0); ctx.lineTo(-11, 11); ctx.lineTo(0, 0);
    ctx.lineTo(11, 11); ctx.lineTo(22, 0); ctx.lineTo(40, 0);
    stroke(2.4, C.fg);
  }

  function drawFPM(f) {
    if (!f.velocity) return;
    _v.copy(f.velocity);
    const sp = _v.length();
    if (sp < 10 || (f.onGround && (f.airspeed || 0) < 15)) return;
    _v.applyQuaternion(_q);
    const az = Math.atan2(_v.x, -_v.z) / DEG;
    const elv = Math.atan2(_v.y, Math.hypot(_v.x, _v.z)) / DEG;
    let x = az * PPD, y = -elv * PPD;
    const r = Math.hypot(x, y), rmax = 185;
    if (r > rmax) { x *= rmax / r; y *= rmax / r; }
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.moveTo(x - 7.5, y); ctx.lineTo(x - 20, y);
    ctx.moveTo(x + 7.5, y); ctx.lineTo(x + 20, y);
    ctx.moveTo(x, y - 7.5); ctx.lineTo(x, y - 15);
    stroke(1.8, C.accent);
  }

  function drawTargetCue(f, m) {
    const tgt = m && m.nextTarget;
    if (!tgt) return;
    _d.subVectors(tgt, f.position);
    const dist = _d.length();
    if (dist < 1) return;
    _d.applyQuaternion(_q);
    const az = Math.atan2(_d.x, -_d.z) / DEG;
    const elv = Math.atan2(_d.y, Math.hypot(_d.x, _d.z)) / DEG;
    const x = az * PPD, y = -elv * PPD;
    ctx.font = `600 12px ${MONO}`;
    if (_d.z < 0 && Math.abs(x) < 200 && Math.abs(y) < 190) {
      // target diamond in the ladder frame: put the flight path marker on it
      const r = 11 + 2 * Math.sin(pulse * 5);
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      stroke(1.8, C.accent);
      ctx.textAlign = 'left';
      text(fmtDist(dist), x + r + 8, y + 1, C.accent);
      return;
    }
    // off-axis: arrow on a ring around the center
    let ax, ay;
    if (_d.z < 0) { ax = x; ay = y; } else { ax = _d.x; ay = -_d.y; }
    let len = Math.hypot(ax, ay);
    if (len < 1e-4) { ax = 1; ay = 0; len = 1; }
    ax /= len; ay /= len;
    const R = 150 + 3 * Math.sin(pulse * 5);
    const px = ax * R, py = ay * R;
    const ang = Math.atan2(ay, ax);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(-6, -11); ctx.lineTo(-1, 0); ctx.lineTo(-6, 11); ctx.closePath();
    fill(C.accent);
    ctx.restore();
    ctx.textAlign = 'center';
    text(fmtDist(dist), ax * (R - 30), ay * (R - 30), C.accent);
  }

  function drawSpeedTape(f) {
    const kt = Math.max(0, f.airspeed * KT);
    const { x1, w, h, ppk } = SPD;
    const x0 = x1 - w, top = -h / 2;
    tapeBg(x0, top, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    // speed bands (stall / normal / caution)
    const band = (a, b, color) => {
      const ya = -(a - kt) * ppk, yb = -(b - kt) * ppk;
      ctx.fillStyle = color;
      ctx.fillRect(x1 - 5, Math.min(ya, yb), 4, Math.abs(yb - ya));
    };
    band(0, 45, 'rgba(255,77,79,0.85)');
    band(45, 110, 'rgba(92,242,200,0.6)');
    band(110, 138, 'rgba(255,176,32,0.85)');
    band(138, 400, 'rgba(255,77,79,0.85)');
    ctx.beginPath();
    const vlo = Math.max(0, Math.floor((kt - h / 2 / ppk) / 5) * 5), vhi = kt + h / 2 / ppk;
    ctx.font = `600 13px ${MONO}`;
    ctx.textAlign = 'right';
    const labels = [];
    for (let v = vlo; v <= vhi; v += 5) {
      const y = -(v - kt) * ppk;
      const major = v % 10 === 0;
      ctx.moveTo(x1 - 7, y); ctx.lineTo(x1 - (major ? 18 : 12), y);
      if (major && v % 20 === 0) labels.push([v, y]);
    }
    stroke(1.2, C.fg);
    for (const [v, y] of labels) if (Math.abs(y) > 18 && Math.abs(y) < h / 2 - 7) text(String(v), x1 - 24, y, C.fg);
    ctx.restore();

    // trend vector (predicted speed in 6 s)
    const trend = clamp(ktTrend * 6, -60, 60);
    if (Math.abs(trend) > 2) {
      const ty = clamp(-trend * ppk, -h / 2 + 4, h / 2 - 4);
      ctx.beginPath();
      ctx.moveTo(x1 - 2, 0); ctx.lineTo(x1 - 2, ty);
      ctx.moveTo(x1 - 7, ty); ctx.lineTo(x1 + 3, ty);
      stroke(1.6, C.accent);
    }

    // current value box (pointing at the tape's inner edge)
    const bx0 = x0 + 4, bx1 = x1 - 12, bh = 17;
    ctx.beginPath();
    ctx.moveTo(bx0, -bh); ctx.lineTo(bx1, -bh); ctx.lineTo(bx1, -6); ctx.lineTo(x1 - 3, 0);
    ctx.lineTo(bx1, 6); ctx.lineTo(bx1, bh); ctx.lineTo(bx0, bh); ctx.closePath();
    ctx.fillStyle = C.boxBg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = f.stalled ? C.warn : C.accent; ctx.stroke();
    ctx.font = `700 21px ${MONO}`;
    ctx.textAlign = 'right';
    text(String(Math.round(kt)), bx1 - 6, 1, kt < 45 && !f.onGround ? C.warn : C.fg, false);

    // caption
    ctx.font = `600 11px ${SANS}`;
    ctx.textAlign = 'left'; text('HIZ', x0 + 2, top - 13, C.dim);
    ctx.textAlign = 'right'; text('KT', x1 - 2, top - 13, C.dim);
  }

  function drawAltTape(f, m) {
    const ft = f.altitude * FT;
    const { x0, w, h, ppf } = ALT;
    const x1 = x0 + w, top = -h / 2;
    tapeBg(x0, top, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, top, w, h); ctx.clip();
    // ground (terrain under the aircraft)
    const gft = (f.altitude - (Number.isFinite(f.agl) ? f.agl : 0)) * FT;
    const gy = -(gft - ft) * ppf;
    if (gy < h / 2) {
      const y0 = Math.max(gy, top);
      ctx.fillStyle = 'rgba(120,72,24,0.42)';
      ctx.fillRect(x0, y0, w, h / 2 - y0);
      ctx.beginPath();
      for (let x = x0 - h; x < x1; x += 10) { ctx.moveTo(x, h / 2 + 2); ctx.lineTo(x + (h / 2 - y0) + 2, y0); }
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,176,32,0.35)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy);
      ctx.lineWidth = 2; ctx.strokeStyle = C.caution; ctx.stroke();
    }
    ctx.beginPath();
    const lo = Math.floor((ft - h / 2 / ppf) / 100) * 100, hi = ft + h / 2 / ppf;
    const labels = [];
    for (let v = lo; v <= hi; v += 100) {
      const y = -(v - ft) * ppf;
      const major = v % 200 === 0;
      ctx.moveTo(x0 + 3, y); ctx.lineTo(x0 + (major ? 14 : 9), y);
      if (major && v >= 0) labels.push([v, y]);
    }
    stroke(1.2, C.fg);
    ctx.font = `600 13px ${MONO}`;
    ctx.textAlign = 'right';
    for (const [v, y] of labels) if (Math.abs(y) > 18 && Math.abs(y) < h / 2 - 7) text(String(v), x1 - 8, y, C.fg);
    ctx.restore();

    // target altitude bug
    const tgt = m && m.nextTarget;
    if (tgt) {
      const tft = tgt.y * FT;
      const ty = clamp(-(tft - ft) * ppf, -h / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x0 - 1, ty - 9); ctx.lineTo(x0 + 7, ty - 9); ctx.lineTo(x0 + 7, ty - 4); ctx.lineTo(x0 + 2, ty);
      ctx.lineTo(x0 + 7, ty + 4); ctx.lineTo(x0 + 7, ty + 9); ctx.lineTo(x0 - 1, ty + 9); ctx.closePath();
      fill(C.accent);
      ctx.font = `700 13px ${MONO}`;
      ctx.textAlign = 'right';
      text(String(Math.round(tft / 10) * 10), x1, top - 13, C.accent);
      ctx.beginPath();
      const ay = top - 13;
      const up = tft > ft;
      ctx.moveTo(x0 + 6, ay + (up ? 4 : -4)); ctx.lineTo(x0 + 11, ay + (up ? -3 : 3)); ctx.lineTo(x0 + 16, ay + (up ? 4 : -4));
      stroke(1.5, C.accent);
    } else {
      ctx.font = `600 11px ${SANS}`;
      ctx.textAlign = 'left'; text('İRTİFA', x0 + 2, top - 13, C.dim);
      ctx.textAlign = 'right'; text('FT', x1 - 2, top - 13, C.dim);
    }

    // current value box
    const bx0 = x0 + 12, bx1 = x1 - 3, bh = 17;
    ctx.beginPath();
    ctx.moveTo(bx1, -bh); ctx.lineTo(bx0, -bh); ctx.lineTo(bx0, -6); ctx.lineTo(x0 + 3, 0);
    ctx.lineTo(bx0, 6); ctx.lineTo(bx0, bh); ctx.lineTo(bx1, bh); ctx.closePath();
    ctx.fillStyle = C.boxBg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.font = `700 20px ${MONO}`;
    ctx.textAlign = 'right';
    text(String(Math.round(ft)), bx1 - 6, 1, C.fg, false);

    drawVSI(f);
  }

  function drawVSI(f) {
    const fpm = (Number.isFinite(f.verticalSpeed) ? f.verticalSpeed : 0) * FPM;
    const x = ALT.x0 + ALT.w + 8, H = 110;
    const map = (v) => {
      const a = Math.abs(v);
      const y = a <= 1000 ? a / 1000 * 70 : 70 + clamp((a - 1000) / 1000, 0, 1) * (H - 70);
      return -Math.sign(v) * y;
    };
    ctx.beginPath();
    ctx.moveTo(x, -H); ctx.lineTo(x, H);
    for (const v of [-2000, -1000, -500, 500, 1000, 2000]) {
      const y = map(v);
      const l = Math.abs(v) === 500 ? 4 : 7;
      ctx.moveTo(x, y); ctx.lineTo(x + l, y);
    }
    ctx.moveTo(x - 3, 0); ctx.lineTo(x + 9, 0);
    stroke(1, C.dim);
    ctx.font = `600 10px ${MONO}`;
    ctx.textAlign = 'left';
    for (const v of [-2000, -1000, 1000, 2000]) text(String(Math.abs(v / 1000)), x + 10, map(v), C.dim);
    const y = map(fpm);
    ctx.beginPath();
    ctx.moveTo(x + 1, 0); ctx.lineTo(x + 1, y);
    ctx.lineWidth = 4; ctx.strokeStyle = C.accent; ctx.lineCap = 'butt'; ctx.stroke(); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 4, y); ctx.lineTo(x + 8, y);
    stroke(2, C.fg);
  }

  function drawHeadingTape(f, m) {
    const hdg = ((f.heading % 360) + 360) % 360;
    const { y0, h, w, ppd } = HDG;
    const x0 = -w / 2, yb = y0 + h;
    tapeBg(x0, y0, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.beginPath();
    const labels = [];
    const lo = Math.floor((hdg - w / 2 / ppd) / 5) * 5, hi = hdg + w / 2 / ppd;
    for (let d = lo; d <= hi; d += 5) {
      const x = (d - hdg) * ppd;
      const dd = ((d % 360) + 360) % 360;
      const len = dd % 10 === 0 ? 9 : 5;
      ctx.moveTo(x, yb - 2); ctx.lineTo(x, yb - 2 - len);
      if (dd % 30 === 0) labels.push([dd, x]);
    }
    stroke(1.1, C.fg);
    const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    ctx.textAlign = 'center';
    for (const [dd, x] of labels) {
      if (Math.abs(x) < 40) continue;
      if (card[dd]) { ctx.font = `700 15px ${SANS}`; text(card[dd], x, y0 + 12, dd === 0 ? C.accent : C.fg); }
      else { ctx.font = `600 12px ${MONO}`; text(String(dd).padStart(3, '0'), x, y0 + 12, C.dim); }
    }
    ctx.restore();

    // bearing bug to the next target
    const tgt = m && m.nextTarget;
    if (tgt) {
      const brg = Math.atan2(tgt.x - f.position.x, -(tgt.z - f.position.z)) / DEG;
      const rel = wrap180(brg - hdg);
      const lim = w / 2 - 8;
      const bx = clamp(rel * ppd, -lim, lim);
      ctx.beginPath();
      if (Math.abs(rel * ppd) <= lim) {
        ctx.moveTo(bx - 8, yb + 1); ctx.lineTo(bx - 8, yb + 7); ctx.lineTo(bx - 3, yb + 7); ctx.lineTo(bx, yb + 3);
        ctx.lineTo(bx + 3, yb + 7); ctx.lineTo(bx + 8, yb + 7); ctx.lineTo(bx + 8, yb + 1); ctx.closePath();
      } else {
        const sgn = Math.sign(rel);
        ctx.moveTo(bx + sgn * 8, yb + 5); ctx.lineTo(bx - sgn * 3, yb - 1); ctx.lineTo(bx - sgn * 3, yb + 11); ctx.closePath();
      }
      fill(C.accent);
    }

    // current heading box
    ctx.beginPath();
    ctx.roundRect(-30, y0 - 3, 60, h + 1, 5);
    ctx.fillStyle = C.boxBg; ctx.fill();
    ctx.lineWidth = 1.4; ctx.strokeStyle = C.accent; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-6, yb - 2); ctx.lineTo(0, yb + 5); ctx.lineTo(6, yb - 2);
    ctx.fillStyle = C.accent; ctx.fill();
    ctx.font = `700 19px ${MONO}`;
    ctx.textAlign = 'center';
    text(String(Math.round(hdg) % 360).padStart(3, '0'), 0, y0 + h / 2 - 1, C.fg, false);
  }

  function drawReadouts(f) {
    const yA = SPD.h / 2 + 22;
    // G under the speed tape
    const gx0 = SPD.x1 - SPD.w;
    const g = Number.isFinite(f.gForce) ? f.gForce : 1;
    ctx.font = `600 11px ${SANS}`;
    ctx.textAlign = 'left';
    text('G', gx0 + 2, yA, C.dim);
    ctx.font = `700 16px ${MONO}`;
    ctx.textAlign = 'right';
    text(g.toFixed(1), SPD.x1 - 2, yA, g > 3.8 || g < -1 ? C.caution : C.fg);

    // vertical speed under the altitude tape
    const ax0 = ALT.x0, ax1 = ALT.x0 + ALT.w;
    const fpm = (Number.isFinite(f.verticalSpeed) ? f.verticalSpeed : 0) * FPM;
    const r = Math.round(fpm / 10) * 10;
    ctx.font = `600 11px ${SANS}`;
    ctx.textAlign = 'left';
    text('FT/DK', ax0 + 2, yA, C.dim);
    ctx.font = `700 16px ${MONO}`;
    ctx.textAlign = 'right';
    text(`${r > 0 ? '+' : ''}${r}`, ax1 - 2, yA, C.fg);

    // radar altitude when low
    const agl = Number.isFinite(f.agl) ? f.agl : 1e9;
    if (agl < 300 && !f.onGround) {
      const y = yA + 24;
      ctx.font = `600 11px ${SANS}`;
      ctx.textAlign = 'left';
      text('YER', ax0 + 2, y, C.dim);
      ctx.font = `700 16px ${MONO}`;
      ctx.textAlign = 'right';
      const aft = Math.max(0, agl * FT);
      text(String(aft < 100 ? Math.round(aft) : Math.round(aft / 10) * 10), ax1 - 2, y, agl < 30 ? C.caution : C.accent);
    }
  }

  // ---------- minimap ----------
  function drawMap(f, m) {
    const M = mapSize;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.fillStyle = '#17405f';
    mctx.fillRect(0, 0, M, M);
    const sc = M / MAP_SPAN;
    const px = f.position.x, pz = f.position.z;
    const ox = M / 2 - px * sc, oy = M / 2 - pz * sc;
    const X = (x) => ox + x * sc, Y = (z) => oy + z * sc;
    if (mapImg) {
      mctx.imageSmoothingEnabled = true;
      const S = WORLD.size;
      mctx.drawImage(mapImg, X(-S / 2), Y(-S / 2), S * sc, S * sc);
    }
    // 1 km grid
    mctx.beginPath();
    const g0x = Math.ceil((px - MAP_SPAN / 2) / 1000) * 1000, g0z = Math.ceil((pz - MAP_SPAN / 2) / 1000) * 1000;
    for (let x = g0x; x < px + MAP_SPAN / 2; x += 1000) { mctx.moveTo(X(x), 0); mctx.lineTo(X(x), M); }
    for (let z = g0z; z < pz + MAP_SPAN / 2; z += 1000) { mctx.moveTo(0, Y(z)); mctx.lineTo(M, Y(z)); }
    mctx.lineWidth = 1; mctx.strokeStyle = 'rgba(255,255,255,0.07)'; mctx.stroke();

    // runway
    const landing = !!(m && m.landing);
    mctx.beginPath();
    mctx.moveTo(X(RUNWAY.x), Y(RUNWAY.z - RUNWAY.length / 2));
    mctx.lineTo(X(RUNWAY.x), Y(RUNWAY.z + RUNWAY.length / 2));
    mctx.lineCap = 'butt';
    mctx.lineWidth = Math.max(3.5, RUNWAY.width * sc) + 2; mctx.strokeStyle = 'rgba(0,0,0,0.5)'; mctx.stroke();
    mctx.lineWidth = Math.max(3.5, RUNWAY.width * sc); mctx.strokeStyle = landing ? C.accent : '#dfe6ee'; mctx.stroke();

    // course
    const rings = m && Array.isArray(m.rings) ? m.rings : null;
    const tgt = m && m.nextTarget;
    if (rings && rings.length) {
      mctx.beginPath();
      let started = false;
      for (const r of rings) {
        if (r.passed) continue;
        const p = r.position;
        if (!started) { mctx.moveTo(X(p.x), Y(p.z)); started = true; } else mctx.lineTo(X(p.x), Y(p.z));
      }
      if (started) {
        mctx.lineTo(X(RUNWAY.x), Y(RUNWAY.z + RUNWAY.length / 2));
        mctx.setLineDash([3, 4]);
        mctx.lineWidth = 1.2; mctx.strokeStyle = 'rgba(255,255,255,0.45)'; mctx.stroke();
        mctx.setLineDash([]);
      }
      for (const r of rings) {
        if (r.passed) continue;
        const p = r.position;
        mctx.beginPath();
        mctx.arc(X(p.x), Y(p.z), 3.2, 0, Math.PI * 2);
        mctx.fillStyle = 'rgba(255,255,255,0.85)'; mctx.fill();
        mctx.lineWidth = 1.2; mctx.strokeStyle = 'rgba(0,0,0,0.5)'; mctx.stroke();
      }
    }
    if (tgt) {
      // line to the next target
      mctx.beginPath();
      mctx.moveTo(M / 2, M / 2); mctx.lineTo(X(tgt.x), Y(tgt.z));
      mctx.lineWidth = 1.6; mctx.strokeStyle = 'rgba(92,242,200,0.75)'; mctx.stroke();
      let tx = X(tgt.x), ty = Y(tgt.z);
      const inside = tx > 8 && tx < M - 8 && ty > 8 && ty < M - 8;
      if (inside) {
        const pr = 6 + 2.5 * (0.5 + 0.5 * Math.sin(pulse * 5));
        mctx.beginPath(); mctx.arc(tx, ty, pr, 0, Math.PI * 2);
        mctx.lineWidth = 2.2; mctx.strokeStyle = C.accent; mctx.stroke();
        mctx.beginPath(); mctx.arc(tx, ty, 2.6, 0, Math.PI * 2);
        mctx.fillStyle = C.accent; mctx.fill();
      } else {
        // edge chevron
        const dx = tx - M / 2, dy = ty - M / 2;
        const k = (M / 2 - 10) / Math.max(Math.abs(dx), Math.abs(dy));
        tx = M / 2 + dx * k; ty = M / 2 + dy * k;
        mctx.save();
        mctx.translate(tx, ty); mctx.rotate(Math.atan2(dy, dx));
        mctx.beginPath(); mctx.moveTo(7, 0); mctx.lineTo(-5, -6); mctx.lineTo(-5, 6); mctx.closePath();
        mctx.fillStyle = C.accent; mctx.fill();
        mctx.restore();
      }
    }

    // player arrow
    mctx.save();
    mctx.translate(M / 2, M / 2);
    mctx.rotate((f.heading || 0) * DEG);
    mctx.beginPath();
    mctx.moveTo(0, -9); mctx.lineTo(6.5, 7); mctx.lineTo(0, 3.5); mctx.lineTo(-6.5, 7); mctx.closePath();
    mctx.lineJoin = 'round';
    mctx.lineWidth = 3; mctx.strokeStyle = 'rgba(0,0,0,0.55)'; mctx.stroke();
    mctx.fillStyle = '#ffffff'; mctx.fill();
    mctx.restore();

    // north marker + scale
    mctx.font = `700 11px ${SANS}`;
    mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
    mctx.lineWidth = 3; mctx.strokeStyle = 'rgba(0,0,0,0.5)';
    mctx.strokeText('N', M / 2, 10); mctx.fillStyle = C.accent; mctx.fillText('N', M / 2, 10);
    const bar = 1000 * sc;
    mctx.beginPath();
    mctx.moveTo(M - 10 - bar, M - 10); mctx.lineTo(M - 10, M - 10);
    mctx.moveTo(M - 10 - bar, M - 13); mctx.lineTo(M - 10 - bar, M - 7);
    mctx.moveTo(M - 10, M - 13); mctx.lineTo(M - 10, M - 7);
    mctx.lineWidth = 3; mctx.strokeStyle = 'rgba(0,0,0,0.45)'; mctx.stroke();
    mctx.lineWidth = 1.2; mctx.strokeStyle = 'rgba(255,255,255,0.85)'; mctx.stroke();
    mctx.font = `700 10px ${SANS}`;
    mctx.textAlign = 'right';
    mctx.fillStyle = 'rgba(0,0,0,0.45)'; mctx.fillText('1 km', M - 9, M - 21);
    mctx.fillStyle = 'rgba(255,255,255,0.9)'; mctx.fillText('1 km', M - 10, M - 22);
  }

  // ---------- panels ----------
  function updatePanels(f, m) {
    if (m) {
      setText(mTitle, m.title || '');
      setText(mObj, m.objective || '');
      const hasRings = (m.ringsTotal || 0) > 0;
      setClass(mp, 'gk-free', !hasRings);
      setClass(mp, 'gk-done', !!m.complete);
      if (hasRings) {
        setText(mRingsDone, String(m.ringsDone || 0));
        setText(mRingsTot, `/${m.ringsTotal}`);
        setScale(mProgBar, (m.ringsDone || 0) / m.ringsTotal);
      }
      setText(mTime, fmtTime(m.time || 0));
      setText(mBest, m.bestTime != null ? fmtTime(m.bestTime) : '--:--.-');
      setText(mScore, String(Math.round(m.score || 0)));
    }
    const thr = clamp(f.throttle || 0, 0, 1);
    setScale(thrFill, thr);
    setText(thrVal, `${Math.round(thr * 100)}%`);
    const fl = clamp(f.flaps || 0, 0, 1);
    setScale(flapFill, fl);
    setText(flapVal, `${Math.round(fl * 30)}°`);
    const brake = typeof f.brake === 'boolean' ? f.brake : (typeof f.brakes === 'boolean' ? f.brakes : brakeKeys.size > 0);
    setClass(pBrake, 'on', !!brake);
    setClass(pGround, 'on', !!f.onGround);
  }

  let pullHold = 0;
  function terrainAhead(f, agl) {
    // simple GPWS: is the straight-line path over the next few seconds about to meet rising terrain?
    if (!world || typeof world.getGroundHeight !== 'function' || !f.velocity) return false;
    const v = f.velocity, p = f.position;
    const gBelow = p.y - agl;
    for (const T of [3, 6, 9]) {
      const x = p.x + v.x * T, z = p.z + v.z * T, y = p.y + v.y * T;
      let g;
      try { g = world.getGroundHeight(x, z); } catch { return false; }
      if (y < g + 15 && g > gBelow + 20) return true;
    }
    return false;
  }
  function updateWarnings(f, dt) {
    const vs = Number.isFinite(f.verticalSpeed) ? f.verticalSpeed : 0;
    const agl = Number.isFinite(f.agl) ? f.agl : 1e9;
    const air = !f.onGround && !f.crashed;
    const stall = air && !!f.stalled;
    const sink = air && vs < -5 && agl < 450 && agl / -vs < 7;
    if (air && (sink || ((f.airspeed || 0) > 15 && terrainAhead(f, agl)))) pullHold = 1.2;
    else pullHold = air ? Math.max(0, pullHold - dt) : 0;
    const pull = pullHold > 0;
    const low = air && !pull && agl < 45 && vs < -3.8;
    if (stall !== warnState.stall) { warnState.stall = stall; wStall.classList.toggle('on', stall); }
    if (pull !== warnState.pull) { warnState.pull = pull; wPull.classList.toggle('on', pull); }
    if (low !== warnState.low) { warnState.low = low; wLow.classList.toggle('on', low); }
  }

  // ---------- help panel ----------
  // keys strings look like "W / S  ·  ↑ / ↓", "B / Boşluk", "F1 / ?", "1 … 9  ·  0", "Oyun kolu"
  function keyGroups(keys) {
    const str = String(keys ?? '').trim();
    if (!str) return [];
    return str.split(/\s*·\s*|\s*,\s*|\s+veya\s+/i).filter(Boolean).map((g) => {
      let parts = g.split(/\s+\/\s+/);
      if (parts.length === 1 && g.length > 1 && g.length <= 5 && g.includes('/')) {
        const p = g.split('/');                          // "W/S", "+/-"
        if (p.every((x) => x.length > 0)) parts = p;
      }
      return parts.map((x) => x.trim()).filter(Boolean);
    });
  }
  function keyChips(parent, keys) {
    const wrap = el('span', 'gk-keys', parent);
    keyGroups(keys).forEach((grp, gi) => {
      if (gi) el('span', 'gk-dot', wrap, '·');
      grp.forEach((k, i) => {
        if (i) el('span', 'gk-or', wrap, '/');
        el('kbd', null, wrap, k);
      });
    });
    return wrap;
  }
  function buildHelp(bindings) {
    helpCard.textContent = '';
    el('h2', null, helpCard, 'Kontroller');
    el('p', 'gk-sub', helpCard, 'Kalkış yap, halkalardan sırayla geç, sonra piste geri in ve dur.');
    const list = (Array.isArray(bindings) ? bindings : []).filter(Boolean);
    const isLong = (b) => String(b.label ?? '').length > 38 || String(b.keys ?? '').length > 22;
    const short = list.filter((b) => !isLong(b));
    const long = list.filter(isLong);
    const grid = el('div', 'gk-help-grid', helpCard);
    const half = Math.ceil(short.length / 2);
    for (let i = 0; i < half; i++) {
      for (const b of [short[i], short[i + half]]) {
        const row = el('div', 'gk-hrow', grid);
        if (!b) continue;
        el('span', 'gk-hl', row, b.label ?? '');
        keyChips(row, b.keys);
      }
    }
    if (long.length) {
      const wide = el('div', 'gk-help-wide', helpCard);
      for (const b of long) {
        const row = el('div', 'gk-hrow gk-hrow-wide', wide);
        keyChips(row, b.keys);
        el('span', 'gk-hl', row, b.label ?? '');
      }
    }
    el('div', 'gk-foot', helpCard, 'Kapatmak için F1 veya ?');
  }

  // ---------- toast ----------
  let toastTimer = 0;

  const hud = {
    update(f, m) {
      if (!f || !f.position || !f.quaternion) return;
      const now = performance.now();
      const dt = clamp((now - lastT) / 1000, 0, 0.25);
      lastT = now;
      pulse += dt;
      const kt = (f.airspeed || 0) * KT;
      if (dt > 0) {
        const acc = (kt - lastKt) / dt;
        ktTrend += (clamp(acc, -40, 40) - ktTrend) * (1 - Math.exp(-dt / 0.6));
      }
      lastKt = kt;
      if (showFps && now - lastFpsT > 500) {
        lastFpsT = now;
        setText(fpsEl, window.__fps ? `${Math.round(window.__fps)} FPS` : '');
      }
      if (!visible) return;
      drawInstruments(f, m);
      drawMap(f, m);
      updatePanels(f, m);
      updateWarnings(f, dt);
    },
    showMessage(textStr, ms = 1500) {
      toast.textContent = textStr;
      toast.classList.add('show');
      if (toast.animate) {
        toast.animate(
          [{ transform: 'translateX(-50%) scale(0.94)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }],
          { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.2)' },
        );
      }
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), Math.max(300, ms));
    },
    setVisible(v) {
      visible = !!v;
      inst.classList.toggle('gk-hidden', !visible);
    },
    showHelp(bindings, show) {
      if (bindings !== helpBindings || !helpCard.firstChild) { helpBindings = bindings; buildHelp(bindings); }
      help.classList.toggle('show', !!show);
    },
    setPaused(p) {
      pause.classList.toggle('show', !!p);
    },
  };
  return hud;
}
