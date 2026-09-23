// Avionics core: fonts, units, flight-state normalisation and Canvas2D drawing helpers shared by every display.
// Every display draws in a fixed *virtual* coordinate system (e.g. 1000×1000) that is scaled to the canvas size,
// so layouts are resolution independent and text is rasterised crisply at the real canvas resolution.

export const KT = 1.943844;      // m/s → knots
export const FT = 3.28084;       // m → feet
export const FPM = 196.8504;     // m/s → ft/min
export const NM = 1852;          // meters per nautical mile
export const DEG = Math.PI / 180;

// ---------------------------------------------------------------- fonts
// B612 is the open-source cockpit typeface designed for Airbus flight decks (SIL OFL 1.1, see fonts/OFL.txt).
let fontEpoch = 0;
export const fontVersion = () => fontEpoch;
(function loadFonts() {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  const files = [
    ['B612', 'B612-Regular.ttf', '400'], ['B612', 'B612-Bold.ttf', '700'],
    ['B612 Mono', 'B612Mono-Regular.ttf', '400'], ['B612 Mono', 'B612Mono-Bold.ttf', '700'],
  ];
  for (const [family, file, weight] of files) {
    try {
      const face = new FontFace(family, `url("${new URL(`./fonts/${file}`, import.meta.url).href}")`, { weight });
      document.fonts.add(face);
      face.load().then(() => { fontEpoch++; }, () => {});
    } catch { /* fall back to system fonts */ }
  }
})();
const SANS = "B612, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'B612 Mono', Menlo, Consolas, monospace";
const fontCache = new Map();
/** Cached CSS font string. size in virtual px. */
export function font(size, bold = true, mono = false) {
  const key = size * 4 + (bold ? 1 : 0) + (mono ? 2 : 0);
  let f = fontCache.get(key);
  if (!f) { f = `${bold ? '700 ' : '400 '}${size}px ${mono ? MONO : SANS}`; fontCache.set(key, f); }
  return f;
}

// ---------------------------------------------------------------- math
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => { a = wrap360(a); return a > 180 ? a - 360 : a; };
export const pad = (v, n) => { const s = String(Math.abs(Math.round(v))); return s.length >= n ? s : '0'.repeat(n - s.length) + s; };
/** Exponential smoothing factor for time constant tau. */
export const smoothK = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

// ---------------------------------------------------------------- flight state
/**
 * Normalised, display-friendly snapshot of a FlightModel (units: kt, ft, ft/min, deg, %).
 * Never throws on missing fields; every value has a sane default.
 */
export function createFlightState() {
  return {
    t: 0, dt: 0, valid: false,
    ias: 0, tas: 0, gs: 0, mach: 0, alt: 0, agl: 0, radioAlt: 0, vs: 0,
    hdg: 0, hdgMag: 0, track: 0, trackMag: 0, decl: 12.9, pitch: 0, roll: 0, aoa: 0, beta: 0, g: 1, fpa: 0, drift: 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    throttle: 0, engines: [], engineCount: 0,
    gear: 1, gearDown: true, gearUp: false, gearHandleDown: true, gearTransit: false,
    flaps: 0, flapsIndex: 0, flapsLabel: 'UP', slats: 0, spoilers: 0, speedbrake: 0, reverser: 0, brakes: 0,
    fuel: 0, onGround: true, stalled: false, crashed: false,
    warn: { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false, lowRotor: false, highRotor: false, overtorque: false, vrs: false, lowFuel: false },
    ap: { on: false, alt: 0, hdg: 0, hdgMag: 0, spd: 0, mode: '', hasAlt: false, hasHdg: false, hasSpd: false, athr: false, lat: '', vert: '', appArmed: false },
    // model-provided reference speeds in kt (0 = unknown): vls, vs1g, vapp, vref, vr, v2, vmo, mmo (Mach), vfe, vfeNext, vle, greenDot
    vsp: { valid: false, vls: 0, vs1g: 0, vapp: 0, vref: 0, vr: 0, v2: 0, vmo: 0, mmo: 0, vfe: 0, vfeNext: 0, vle: 0, greenDot: 0 },
    autobrake: '', parkingBrake: false, canopy: 0,
    rotorRPM: 0, collective: 0, torque: 0, isHeli: false,
    iasTrend: 0, turnRate: 0, windDir: 0, windSpd: 0, maxG: 1,
    spec: null, category: '',
    _prevIas: NaN, _prevHdg: NaN, _windX: 0, _windZ: 0,
  };
}

const ZERO_WARN = { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false };
/** Updates S from the flight model. dt in seconds. */
export function readFlight(S, f, world, dt) {
  dt = clamp(num(dt, 1 / 30), 0, 0.5);
  S.dt = dt; S.t += dt;
  f = f || {};
  S.valid = !!f && typeof f === 'object' && ('altitude' in f || 'ias' in f || 'position' in f);
  const pos = f.position || {}, vel = f.velocity || {};
  S.x = num(pos.x); S.y = num(pos.y); S.z = num(pos.z);
  S.vx = num(vel.x); S.vy = num(vel.y); S.vz = num(vel.z);
  const tasMs = num(f.airspeed, num(f.ias, Math.hypot(S.vx, S.vy, S.vz)));
  S.tas = tasMs * KT;
  S.ias = num(f.ias, tasMs) * KT;
  S.gs = Math.hypot(S.vx, S.vz) * KT;
  S.mach = num(f.mach, tasMs / 340.3);
  S.alt = num(f.altitude, S.y) * FT;
  S.agl = Math.max(0, num(f.agl, num(f.altitude, S.y)) * FT);
  S.radioAlt = S.agl;
  S.vs = num(f.verticalSpeed, S.vy) * FPM;
  S.decl = num(world && world.runways && world.runways.magneticDeclination, 12.9);
  S.hdg = wrap360(num(f.heading));
  S.hdgMag = wrap360(S.hdg - S.decl);
  S.pitch = num(f.pitch); S.roll = num(f.roll); S.aoa = num(f.aoa);
  S.beta = clamp(num(f.sideslip), -30, 30);
  S.g = num(f.gForce, 1);
  S.onGround = !!f.onGround;
  const hs = Math.hypot(S.vx, S.vz);
  S.track = hs > 2 ? wrap360(Math.atan2(S.vx, -S.vz) / DEG) : S.hdg;
  S.trackMag = wrap360(S.track - S.decl);
  S.fpa = hs > 5 || Math.abs(S.vy) > 1 ? Math.atan2(S.vy, Math.max(hs, 1)) / DEG : S.pitch;
  S.drift = hs > 10 ? clamp(wrap180(S.track - S.hdg), -30, 30) : 0;
  S.throttle = clamp(num(f.throttle), 0, 1);
  // engines (n1 as 0..1 fraction or percent)
  const eng = Array.isArray(f.engines) ? f.engines : [];
  S.engineCount = eng.length;
  for (let i = 0; i < Math.max(eng.length, 2); i++) {
    const e = eng[i] || null;
    let o = S.engines[i];
    if (!o) o = S.engines[i] = { n1: 0, thrust: 0, ab: 0, ff: 0, torque: NaN, running: true, present: false };
    o.present = !!e;
    if (!e) { o.n1 = 0; o.thrust = 0; o.ab = 0; o.ff = 0; o.torque = NaN; o.running = false; continue; }
    const tq = num(e.torque, NaN);
    o.torque = Number.isFinite(tq) ? (tq <= 1.6 ? tq * 100 : tq) : NaN;
    o.running = e.running !== false;
    const n1 = num(e.n1);
    o.n1 = n1 <= 1.5 ? n1 * 100 : n1;
    o.thrust = num(e.thrust);
    o.ab = clamp(num(e.afterburner), 0, 1);
    const ff = num(e.fuelFlow);
    o.ff = ff < 30 ? ff * 3600 : ff;   // kg/h (contract is SI: kg/s)
  }
  // gear / high lift
  S.gear = clamp(num(f.gear, 1), 0, 1);
  S.gearDown = S.gear > 0.99; S.gearUp = S.gear < 0.01; S.gearTransit = !S.gearDown && !S.gearUp;
  S.gearHandleDown = typeof f.gearHandleDown === 'boolean' ? f.gearHandleDown : S.gear > 0.5;
  S.flaps = clamp(num(f.flaps), 0, 1);
  S.flapsIndex = num(f.flapsIndex, Math.round(S.flaps * 4));
  S.flapsLabel = typeof f.flapsLabel === 'string' || typeof f.flapsLabel === 'number' ? String(f.flapsLabel) : (S.flaps < 0.01 ? 'UP' : String(S.flapsIndex));
  S.slats = clamp(num(f.slats, S.flaps > 0 ? Math.min(1, S.flaps * 2) : 0), 0, 1);
  S.spoilers = clamp(num(f.spoilers), 0, 1);
  S.speedbrake = clamp(num(f.speedbrake), 0, 1);
  S.reverser = clamp(num(f.reverser), 0, 1);
  S.brakes = clamp(num(f.brakes), 0, 1);
  S.fuel = Math.max(0, num(f.fuel));
  S.stalled = !!f.stalled; S.crashed = !!f.crashed;
  const w = f.warnings && typeof f.warnings === 'object' ? f.warnings : ZERO_WARN;
  const W = S.warn;
  W.stall = !!w.stall || S.stalled; W.overspeed = !!w.overspeed; W.gear = !!w.gear; W.bank = !!w.bank; W.sinkRate = !!w.sinkRate; W.pullUp = !!w.pullUp;
  W.lowRotor = !!w.lowRotor; W.highRotor = !!w.highRotor; W.overtorque = !!w.overtorque; W.vrs = !!w.vrs; W.lowFuel = !!w.lowFuel;
  // autopilot (SI units in the model)
  const ap = f.autopilot && typeof f.autopilot === 'object' ? f.autopilot : null;
  const A = S.ap;
  A.on = !!(ap && ap.on);
  A.hasAlt = !!ap && Number.isFinite(ap.altitude) && ap.altitude !== 0;
  A.hasHdg = !!ap && Number.isFinite(ap.heading);
  A.hasSpd = !!ap && Number.isFinite(ap.speed) && ap.speed > 0;
  A.alt = A.hasAlt ? ap.altitude * FT : Math.round(S.alt / 100) * 100;
  A.hdg = A.hasHdg ? wrap360(ap.heading) : S.hdg;
  A.hdgMag = wrap360(A.hdg - S.decl);
  A.spd = A.hasSpd ? ap.speed * KT : S.ias;
  A.mode = ap && typeof ap.mode === 'string' ? ap.mode.toUpperCase() : '';
  A.athr = ap && typeof ap.athr === 'boolean' ? ap.athr : A.on && A.hasSpd;
  // mode tokens ('HDG CLB', 'LOC G/S', 'HDG ALT APP', 'FLARE', 'ROLLOUT', 'LAND' …)
  const m = A.mode;
  A.lat = /\bLOC\b/.test(m) ? 'LOC' : /NAV/.test(m) ? 'NAV' : /\bHDG\b/.test(m) ? 'HDG' : /FLARE|ROLLOUT|LAND/.test(m) ? 'LAND' : '';
  A.vert = /G\/S/.test(m) ? 'G/S' : /FLARE/.test(m) ? 'FLARE' : /ROLLOUT/.test(m) ? 'ROLLOUT' : /\bLAND\b/.test(m) ? 'LAND' : /V\/S/.test(m) ? 'V/S'
    : /\bCLB\b/.test(m) ? 'CLB' : /\bDES\b/.test(m) ? 'DES' : /\bALT\b/.test(m) ? 'ALT' : '';
  A.appArmed = /\bAPP\b/.test(m);
  // reference speeds (m/s in the model → kt)
  const v = f.vSpeeds && typeof f.vSpeeds === 'object' ? f.vSpeeds : null, V = S.vsp;
  V.valid = !!v && num(v.vls) > 0;
  for (const k of ['vls', 'vs1g', 'vapp', 'vref', 'vr', 'v2', 'vmo', 'vfe', 'vfeNext', 'vle', 'greenDot']) V[k] = v ? Math.max(0, num(v[k])) * KT : 0;
  V.mmo = v ? num(v.mmo) : 0;
  S.autobrake = typeof f.autobrake === 'string' ? f.autobrake.toUpperCase() : '';
  S.parkingBrake = !!f.parkingBrake;
  S.canopy = clamp(num(f.canopy), 0, 1);
  // helicopter
  const rpm = num(f.rotorRPM);
  S.rotorRPM = rpm <= 1.5 ? rpm * 100 : rpm;
  S.collective = clamp(num(f.collective), 0, 1);
  const tq = num(f.torque);
  S.torque = tq <= 1.5 ? tq * 100 : tq;
  S.spec = f.spec || null;
  S.category = (S.spec && S.spec.category) || '';
  S.isHeli = S.category === 'helicopter' || (rpm > 0 && !S.engines[0].n1);
  // derived trends
  if (dt > 0) {
    if (Number.isFinite(S._prevIas)) {
      const rate = (S.ias - S._prevIas) / dt;
      S.iasTrend += (clamp(rate, -20, 20) * 10 - S.iasTrend) * smoothK(dt, 1.2);
    }
    if (Number.isFinite(S._prevHdg)) {
      const r = wrap180(S.hdg - S._prevHdg) / dt;
      S.turnRate += (clamp(r, -20, 20) - S.turnRate) * smoothK(dt, 0.8);
    }
  }
  S._prevIas = S.ias; S._prevHdg = S.hdg;
  // wind estimate: ground velocity minus air velocity along the heading
  if (tasMs > 25 && !S.onGround) {
    const hr = S.hdg * DEG, cp = Math.cos(S.pitch * DEG);
    const wx = S.vx - Math.sin(hr) * tasMs * cp, wz = S.vz + Math.cos(hr) * tasMs * cp;
    const k = smoothK(dt, 3);
    S._windX += (wx - S._windX) * k; S._windZ += (wz - S._windZ) * k;
  } else { S._windX *= 0.98; S._windZ *= 0.98; }
  const ws = Math.hypot(S._windX, S._windZ) * KT;
  S.windSpd = ws < 2 ? 0 : ws;
  // wind direction = where it blows FROM (true → magnetic)
  S.windDir = wrap360(Math.atan2(-S._windX, S._windZ) / DEG - S.decl);
  if (!S.onGround) S.maxG = Math.max(S.maxG, S.g);
  return S;
}

// ---------------------------------------------------------------- canvas helpers
export function makeCanvas(w, h) {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
  c.width = w; c.height = h;
  return c;
}

/** Offscreen layer drawn once (and again when fonts finish loading). */
export class Layer {
  constructor(w, h, vw, vh, draw) {
    this.canvas = makeCanvas(w, h);
    this.g = this.canvas.getContext('2d');
    this.sx = w / vw; this.sy = h / vh; this.draw = draw; this.epoch = -1;
  }
  blit(g) {
    if (this.epoch !== fontEpoch) {
      this.epoch = fontEpoch;
      const lg = this.g;
      lg.setTransform(1, 0, 0, 1, 0, 0);
      lg.clearRect(0, 0, this.canvas.width, this.canvas.height);
      lg.setTransform(this.sx, 0, 0, this.sy, 0, 0);
      lg.lineJoin = 'round'; lg.lineCap = 'butt';
      this.draw(lg);
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.canvas, 0, 0);
    g.restore();
  }
}

export function text(g, s, x, y, color, align = 'left', f = null) {
  if (f) g.font = f;
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(s, x, y);
}
export function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
export function stroke(g, color, width) { g.strokeStyle = color; g.lineWidth = width; }
export function poly(g, pts, close = true) {
  g.beginPath(); g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  if (close) g.closePath();
}
export function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); }
export function rrect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** Text with an outline box around it. */
export function boxedText(g, s, x, y, color, boxColor, f, align = 'center', padX = 6, h = 0) {
  g.font = f;
  const w = g.measureText(s).width;
  const size = h || parseFloat(f.split(' ')[1]) || 20;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  g.strokeStyle = boxColor; g.lineWidth = 2.5;
  g.strokeRect(x0 - padX, y - size * 0.86, w + padX * 2, size * 1.08);
  text(g, s, x, y, color, align);
}
/** Striped bar (barber pole) between y0 and y1. */
export function stripes(g, x, y0, y1, w, c1, c2, step = 12) {
  const top = Math.min(y0, y1), bot = Math.max(y0, y1);
  g.fillStyle = c1; g.fillRect(x, top, w, bot - top);
  g.fillStyle = c2;
  for (let y = top; y < bot; y += step * 2) g.fillRect(x, y, w, Math.min(step, bot - y));
}

/** Formats seconds as HH:MM:SS (UTC clock of the machine). */
export function clockUTC(sep = ':') {
  const d = new Date();
  return pad(d.getUTCHours(), 2) + sep + pad(d.getUTCMinutes(), 2) + sep + pad(d.getUTCSeconds(), 2);
}
