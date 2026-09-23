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
// Loaded with the first display (or earlier through loadAvionicsFonts() when the cockpit starts to stream), not with the
// module: nothing needs them before the cockpit, and the 0.5 MB would compete with the menu and the world downloads.
let fontsRequested = false;
export function loadAvionicsFonts() {
  if (fontsRequested || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  fontsRequested = true;
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
}
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
    route: null,          // src/nav/route.js Route with an active leg (flight.nav), for the NDs; null otherwise
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
  S.route = f.nav && f.nav.valid && f.nav.route ? f.nav.route : null;   // planned route (src/nav), ND display
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
      // drawn through a recorder: a layer that starts with an opaque fill of its whole area counts as a complete
      // repaint when a display blits it first (upload skipping, see CanvasRecorder)
      const rec = new CanvasRecorder(lg), rg = rec.ctx;
      rec.begin(0);
      rg.setTransform(this.sx, 0, 0, this.sy, 0, 0);
      rg.lineJoin = 'round'; rg.lineCap = 'butt';
      this.draw(rg);
      rec.end();
      this.canvas.__opaque = rec.opaqueCover;
      this.canvas.__v = (this.canvas.__v || 0) + 1;   // content version for recorders that draw this canvas
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.canvas, 0, 0);
    g.restore();
  }
}

/** Marks a canvas as changed for CanvasRecorder (call after drawing into a canvas that displays blit). */
export function touchCanvas(c) { if (c) c.__v = (c.__v || 0) + 1; }

// ---------------------------------------------------------------- change detection (skip unchanged uploads)
// A display whose drawing did not change since its last upload does not need another canvas → texture upload (the
// upload, and the GPU raster of the canvas it triggers, are the cost of the cockpit displays). CanvasRecorder stands in
// for the CanvasRenderingContext2D: every call and property write goes straight to the real context and into a 64-bit
// hash of the command stream (numbers at float32 precision, strings, the content version of every canvas drawn). end() reports a
// change unless the frame provably produced the same pixels as the previous one: the same commands from the same
// starting state (context properties, transform, save stack, font epoch) on a canvas the frame repaints completely
// (its first painting operation clears or opaquely fills the whole canvas, or blits an opaque full-size layer).
// Anything the recorder cannot vouch for (style objects, drawn images without a version, pixel writes, a clip before the
// first paint, unbalanced save/restore) counts as a change.
// Numbers are hashed as float32, the precision Skia (Chrome's and Safari's canvas rasterizer) draws with.
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
const STR = new Map();
function strKey(s) {
  let k = STR.get(s);
  if (k === undefined) {
    let a = 0x811c9dc5 ^ s.length, b = 0x9747b28c;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; }
    if (STR.size > 8192) STR.clear();
    k = [a | 0, b | 0];
    STR.set(s, k);
  }
  return k;
}
const OBJ_IDS = new WeakMap();
let objSeq = 1;
const objId = (o) => { let id = OBJ_IDS.get(o); if (!id) { id = objSeq++; OBJ_IDS.set(o, id); } return id; };
const isOpaqueColor = (c) => {
  if (typeof c !== 'string') return false;
  const s = c.trim().toLowerCase();
  if (s[0] === '#') return s.length === 4 || s.length === 7 || (s.length === 9 && s.endsWith('ff')) || (s.length === 5 && s.endsWith('f'));
  if (s.startsWith('rgba(') || s.startsWith('hsla(')) { const m = /,\s*([\d.]+)\s*\)$/.exec(s); return !!m && Number(m[1]) >= 1; }
  if (s.startsWith('rgb(') || s.startsWith('hsl(')) return !s.includes('/');
  return /^[a-z]+$/.test(s) && s !== 'transparent';
};
const PAINT = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'drawImage', 'putImageData', 'drawFocusIfNeeded']);
let RecorderProto = null, PROPS = null;
function recorderProto() {
  if (RecorderProto) return RecorderProto;
  RecorderProto = {};
  PROPS = [];
  const P = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : {};
  let id = 0;
  for (const name of Object.getOwnPropertyNames(P)) {
    if (name === 'constructor') continue;
    const d = Object.getOwnPropertyDescriptor(P, name);
    const key = ++id;
    if (typeof d.value === 'function') {
      const special = RecorderMethods[name];
      RecorderProto[name] = special ? function () { return special.call(this, key, arguments); }
        : PAINT.has(name) ? function () { this._paint(false); this._call(key, arguments); return this._g[name].apply(this._g, arguments); }
          : function () { this._call(key, arguments); return this._g[name].apply(this._g, arguments); };
    } else if (d.get) {
      if (name === 'canvas' || !d.set) { Object.defineProperty(RecorderProto, name, { get() { return this._g[name]; } }); continue; }
      const slot = PROPS.length;
      PROPS.push(name);
      Object.defineProperty(RecorderProto, name, {
        get() { return this._g[name]; },
        set(v) { this._i(key); this._v(v); this._s[slot] = v; this._g[name] = v; },
      });
    }
  }
  Object.assign(RecorderProto, RECORDER_API);
  [S_FILL, S_ALPHA, S_OP, S_FILTER] = ['fillStyle', 'globalAlpha', 'globalCompositeOperation', 'filter'].map((n) => PROPS.indexOf(n));
  return RecorderProto;
}
let S_FILL = -1, S_ALPHA = -1, S_OP = -1, S_FILTER = -1;
const RecorderMethods = {
  save(key) { this._i(key); this._stack.push({ s: this._s.slice(), m: this._m.slice(), clip: this._clip, dash: this._dash }); this._g.save(); },
  restore(key) { this._i(key); const t = this._stack.pop(); if (t) { this._s = t.s; this._m = t.m; this._clip = t.clip; this._dash = t.dash; } this._g.restore(); },
  reset(key) { this._i(key); this._s = []; this._m = [1, 0, 0, 1, 0, 0]; this._stack.length = 0; this._clip = false; this._dash = ''; this._paint('clear'); this._g.reset(); },
  setTransform(key, a) {
    this._call(key, a);
    if (a.length >= 6) this._m = [a[0], a[1], a[2], a[3], a[4], a[5]]; else this._unknown = true;
    return this._g.setTransform.apply(this._g, a);
  },
  resetTransform(key, a) { this._call(key, a); this._m = [1, 0, 0, 1, 0, 0]; return this._g.resetTransform(); },
  translate(key, a) { this._call(key, a); this._mul(1, 0, 0, 1, a[0], a[1]); return this._g.translate(a[0], a[1]); },
  scale(key, a) { this._call(key, a); this._mul(a[0], 0, 0, a[1], 0, 0); return this._g.scale(a[0], a[1]); },
  rotate(key, a) { this._call(key, a); const c = Math.cos(a[0]), s = Math.sin(a[0]); this._mul(c, s, -s, c, 0, 0); return this._g.rotate(a[0]); },
  transform(key, a) { this._call(key, a); this._mul(a[0], a[1], a[2], a[3], a[4], a[5]); return this._g.transform.apply(this._g, a); },
  clip(key, a) { this._call(key, a); this._clip = true; return this._g.clip.apply(this._g, a); },
  setLineDash(key, a) { this._call(key, a); this._dash = a[0] ? Array.from(a[0]).join(',') : ''; return this._g.setLineDash(a[0]); },
  fillRect(key, a) {
    const st = this._s[S_FILL];
    this._paint(this._covers(a[0], a[1], a[2], a[3]) && this._plain() && isOpaqueColor(st === undefined ? '#000' : st) ? 'opaque' : false);
    this._call(key, a); return this._g.fillRect(a[0], a[1], a[2], a[3]);
  },
  clearRect(key, a) { this._paint(this._covers(a[0], a[1], a[2], a[3]) ? 'clear' : false); this._call(key, a); return this._g.clearRect(a[0], a[1], a[2], a[3]); },
  drawImage(key, a) {
    const src = a[0];
    let full = false;
    if (src && src.__opaque && this._plain() && (a.length === 3 || a.length === 5)) {
      const w = a.length === 5 ? a[3] : src.width, h = a.length === 5 ? a[4] : src.height;
      full = this._covers(a[1], a[2], w, h) ? 'opaque' : false;
    }
    this._paint(full);
    this._call(key, a); return this._g.drawImage.apply(this._g, a);
  },
  putImageData(key, a) { this._unknown = true; this._paint(false); return this._g.putImageData.apply(this._g, a); },
};

export class CanvasRecorder {
  constructor(g) {
    this.ctx = Object.create(recorderProto());
    Object.assign(this.ctx, { _g: g, _s: [], _m: [1, 0, 0, 1, 0, 0], _stack: [], _clip: false, _dash: '', h1: 0, h2: 0, _unknown: false, _first: null });
    this.prev1 = 0; this.prev2 = 0; this.fresh = true;
    this.fullCover = false; this.opaqueCover = false;
  }
  /** Start of a frame: seeds the hash with the starting state (and `epoch`, e.g. the font epoch). */
  begin(epoch) {
    const r = this.ctx;
    r.h1 = 0x12345679; r.h2 = 0x7654321;
    r._unknown = false; r._first = null;
    r._n(epoch);
    for (let i = 0; i < r._s.length; i++) { r._i(i + 7919); r._v(r._s[i]); }
    for (const x of r._m) r._n(x);
    r._i(r._stack.length); r._i(r._clip ? 1 : 2); r._v(r._dash);
    this.depth = r._stack.length;
  }
  /** End of a frame: true when the canvas may differ from the previous frame (upload it). */
  end() {
    const r = this.ctx;
    this.fullCover = r._first === 'clear' || r._first === 'opaque';
    this.opaqueCover = r._first === 'opaque';
    const same = !this.fresh && !r._unknown && this.fullCover && r._stack.length === this.depth && r.h1 === this.prev1 && r.h2 === this.prev2;
    this.prev1 = r.h1; this.prev2 = r.h2; this.fresh = false;
    return !same;
  }
  /** The real context was reset behind the recorder's back (error recovery): forget its state, next frame uploads. */
  invalidate() { const r = this.ctx; r._s = []; r._m = [1, 0, 0, 1, 0, 0]; r._stack.length = 0; r._clip = false; r._dash = ''; this.fresh = true; }
}
const RECORDER_API = {
  _i(x) {
    let a = Math.imul(this.h1 ^ x, 0x9e3779b1); a ^= a >>> 16; this.h1 = a;
    let b = Math.imul(this.h2 ^ x, 0x85ebca77) + 0x27d4eb2f | 0; b ^= b >>> 13; this.h2 = b;
  },
  _n(v) { F32[0] = v > -1e-9 && v < 1e-9 ? 0 : v; this._i(U32[0]); },   // (|v| < 1e-9: no float32 coordinate moves)
  _v(v) {
    const t = typeof v;
    if (t === 'number') this._n(v);
    else if (t === 'string') { const k = strKey(v); this._i(k[0]); this._i(k[1]); }
    else if (t === 'boolean') this._i(v ? 0x51 : 0x52);
    else if (v == null) this._i(v === null ? 0x53 : 0x54);
    else if (ArrayBuffer.isView(v) || Array.isArray(v)) { this._i(v.length); for (let i = 0; i < v.length; i++) this._v(v[i]); }
    else if (t === 'object' && typeof v.__v === 'number') { this._i(objId(v)); this._n(v.__v); }   // versioned canvas (Layer, nav images)
    else { this._i(objId(v)); this._unknown = true; }   // gradients, patterns, bitmaps, Path2D, DOMMatrix: not tracked
  },
  _call(key, args) { this._i(key); this._i(args.length); for (let i = 0; i < args.length; i++) this._v(args[i]); },
  _paint(kind) { if (this._first === null) this._first = this._clip ? false : kind; },
  _plain() {
    const a = this._s[S_ALPHA], op = this._s[S_OP], f = this._s[S_FILTER];
    return (a === undefined || a === 1) && (op === undefined || op === 'source-over') && (f === undefined || f === 'none');
  },
  _covers(x, y, w, h) {
    const m = this._m, W = this._g.canvas.width, H = this._g.canvas.height;
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return false;
    const x0 = m[0] * x + m[4], x1 = m[0] * (x + w) + m[4], y0 = m[3] * y + m[5], y1 = m[3] * (y + h) + m[5];
    return Math.min(x0, x1) <= 1e-6 && Math.max(x0, x1) >= W - 1e-6 && Math.min(y0, y1) <= 1e-6 && Math.max(y0, y1) >= H - 1e-6;
  },
  _mul(a, b, c, d, e, f) {
    const m = this._m;
    this._m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  },
};

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
