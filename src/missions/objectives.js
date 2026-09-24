// Mission objectives (CONTRACTS-SF.md §12): small evaluators over a per-frame flight sample. No DOM, no three.js
// (tests/missions.test.mjs and tests/missions-ist.test.mjs drive them with scripted samples).
//
//   const o = createObjective(def, env)     // def from a mission catalog; env = { ends, bridges, spanAt, score }
//   o.update(s)                              // s = { t, dt, x, y, z, px, py, pz, agl, ias, gs, vs, hdg, pitch, roll, onGround, first }
//   o.onLanding(card, td) / o.onDitch(d)     // landing score (src/missions/landing-score.js) / water contact
//   o.status 'active' | 'done' | 'fail', o.failReason, o.points, o.parts [[label, value, points]], o.progress (short text),
//   o.target { x, y, z } | null (HUD pointer / distance), o.message (one-shot text for the HUD, read and cleared by the runtime)
// Allocation-free per frame: every objective keeps its own scratch numbers; strings only change on events or at
// progress changes the HUD reads at 10 Hz.
//
// Types (the İstanbul map added the optional gate / hover fields and the orbit / goaround types; without them every
// type behaves exactly as before):
//   altitude { min }                             reach an altitude (m MSL)
//   bridge   { bridge }                          under the deck between the towers (env.bridges[bridge])
//   gates    { shape, gates, tol, ceiling?, grace?, kt?, ktTol? }
//            ordered frames / rings; optional corridor: after gate 1 stay below `ceiling` m MSL (more than `grace` s
//            above it in total fails; the time above costs the "Alçak kalma" points, score.low, default 300); optional
//            speed window: crossing a gate at `kt` (gate.kt or def.kt) ± ktTol knots earns score.gateKt (default 100)
//   hover    { x, z, y, r, hmin, hmax, t, maxKt, ty?, doneMsg? }   ty: pointer height above y (default 8)
//   pad      { x, z, y, r, profile?, outFail? }   helicopter touchdown on a pad (outFail: a touchdown outside fails)
//   land     { runways?, airports?, any?, heli?, minStars, target, profile?, exclude? }   exclude: runway ends that fail
//            (departures-only runways)
//   ditch    {}
//   orbit    { x, z, rmin, rmax, ymin, ymax, dir: 'left'|'right', deg?, grace?, n?, shape: 'ring' }
//            fly `deg` (360) degrees around (x, z) in the given direction (left = counter-clockwise seen from above)
//            inside the radius band and the altitude band (m MSL). Outside the band nothing counts; more than `grace`
//            s (default 8) outside starts the circle again. Points: 400 radius accuracy + 200 altitude accuracy + 200
//            for no restart. For markers it exposes the gates interface: `gates` = n (default 8) checkpoint rings on
//            the ideal circle (ordered in the flight direction from the start side), `index`, `orient(x0, z0)`.
//   goaround { min, call? }                      a go-around now: climb to `min` m MSL without touching the ground; the
//            height lost after the call costs points (400 for ≤ 8 m, 0 at 60 m)
import { band, clamp, dirOf, FT, KT, FPM, fmtDist } from './util.js';
import { scoreDitch } from './landing-score.js';

export { scoreDitch };

const fmtFt = (m) => String(Math.round(m / FT / 10) * 10).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Point where the segment p0 → p1 crosses the vertical plane through (cx, cz) with horizontal normal (nx, nz), or null. */
function crossPlane(s, cx, cz, nx, nz, out) {
  if (s.first) return null;
  const d0 = (s.px - cx) * nx + (s.pz - cz) * nz, d1 = (s.x - cx) * nx + (s.z - cz) * nz;
  if ((d0 < 0) === (d1 < 0) || d0 === d1) return null;
  const k = d0 / (d0 - d1);
  out.x = s.px + (s.x - s.px) * k; out.y = s.py + (s.y - s.py) * k; out.z = s.pz + (s.z - s.pz) * k;
  out.dir = d1 > d0 ? 1 : -1;
  return out;
}

class Objective {
  constructor(def, env) {
    this.def = def; this.env = env; this.label = def.label || '';
    this.status = 'active'; this.failReason = ''; this.points = 0; this.parts = []; this.progress = ''; this.message = null;
    this.target = null;
  }
  start() { this.status = 'active'; this.failReason = ''; this.points = 0; this.parts = []; this.progress = ''; this.message = null; }
  done(points = 0) { this.status = 'done'; this.points = Math.round(points); }
  fail(reason) { this.status = 'fail'; this.failReason = reason; }
  say(text) { this.message = text; }
  update() {}
  onTouchdown() {}
  onLanding() {}
  onDitch() {}
}

// ------------------------------------------------------------------------------------------------------- altitude
class Altitude extends Objective {
  constructor(def, env) { super(def, env); this.lastFt = -1; }
  start() { super.start(); this.lastFt = -1; }
  update(s) {
    const ft = Math.round(s.y / FT / 100) * 100;
    if (ft !== this.lastFt) { this.lastFt = ft; this.progress = `${fmtFt(Math.max(0, s.y))} / ${fmtFt(this.def.min)} ft`; }
    if (!s.onGround && s.y >= this.def.min) this.done(0);
  }
}

// ---------------------------------------------------------------------------------------------------------- bridge
class Bridge extends Objective {
  constructor(def, env) {
    super(def, env);
    const b = env.bridges[def.bridge];
    this.b = b;
    this.axis = dirOf(b.axis);                          // along the deck (towards the south end)
    this.n = { dx: -this.axis.dz, dz: this.axis.dx };   // horizontal normal of the bridge plane
    this.target = { x: b.x, y: 35, z: b.z };
    this.p = { x: 0, y: 0, z: 0, dir: 0 };
    this.span = { bottom: -Infinity, top: -Infinity };
  }
  update(s) {
    const b = this.b;
    const hit = crossPlane(s, b.x, b.z, this.n.dx, this.n.dz, this.p);
    if (!hit) return;
    const along = (hit.x - b.x) * this.axis.dx + (hit.z - b.z) * this.axis.dz;
    if (Math.abs(along) > b.half + 400) return;         // crossed the line far from the bridge (approach spans, hills)
    // the landmark's own collision (world.getObstacleSpan) gives the deck underside at the crossing point
    let bottom = b.clear;
    const sp = this.env.spanAt ? this.env.spanAt(hit.x, hit.z, this.span) : null;
    if (sp && Number.isFinite(sp.bottom) && sp.bottom > 5 && sp.bottom < 120) bottom = sp.bottom;
    const top = sp && Number.isFinite(sp.top) && sp.top > bottom ? sp.top : bottom + 8;
    if (Math.abs(along) > b.half - 40) { this.say('Kulelerin arasından geçmelisin'); return; }
    if (hit.y >= bottom) { this.say(hit.y > top ? 'Köprünün üstünden geçtin: altından geçmelisin!' : 'Tabliyeye çok yakın!'); return; }
    const centre = band(Math.abs(along), 80, b.half - 60);
    const h = hit.y < 15 ? clamp((hit.y - 3) / 12, 0, 1) : clamp((bottom - 8 - hit.y) / (bottom - 8 - 50), 0, 1);
    const height = hit.y >= 15 && hit.y <= 50 ? 1 : h;
    const pc = Math.round(500 * centre), ph = Math.round(300 * height);
    this.parts = [['Kuleler arası konum', `${Math.round(Math.abs(along))} m merkezden`, pc], ['Geçiş yüksekliği', `${Math.round(hit.y)} m (tabliye ${Math.round(bottom)} m)`, ph]];
    this.say('Köprünün altından geçtin!');
    this.done(pc + ph);
  }
}

// ----------------------------------------------------------------------------------------------------------- gates
class Gates extends Objective {
  constructor(def, env) {
    super(def, env);
    this.gates = def.gates.map((g) => ({ ...g, nx: 0, nz: 1, acc: 0 }));
    this.i = 0;
    this.p = { x: 0, y: 0, z: 0, dir: 0 };
    this.target = { x: 0, y: 0, z: 0 };
    this.missT = 0;
    // optional corridor (ceiling) and speed windows (İstanbul missions); absent in the San Francisco catalog
    this.ceil = Number.isFinite(def.ceiling) ? def.ceiling : null;
    this.above = 0; this.hiT = 0;
    this.spd = def.kt != null || def.gates.some((g) => g.kt != null);
  }
  /** Plane normals: towards each gate from its `from` point, else from the previous gate (or the start). */
  orient(x0, z0) {
    let px = x0, pz = z0;
    for (const g of this.gates) {
      const fx = g.from ? g.from[0] : px, fz = g.from ? g.from[1] : pz;
      const dx = g.x - fx, dz = g.z - fz, L = Math.hypot(dx, dz) || 1;
      g.nx = dx / L; g.nz = dz / L; px = g.x; pz = g.z;
    }
  }
  start() {
    super.start(); this.i = 0; this.missT = 0; for (const g of this.gates) g.acc = 0; this.aim();
    this.above = 0; this.hiT = 0;
    if (this.spd) for (const g of this.gates) { g.sp = 0; g.kts = 0; }
  }
  aim() {
    const g = this.gates[Math.min(this.i, this.gates.length - 1)];
    this.target.x = g.x; this.target.y = g.y; this.target.z = g.z;
    this.progress = `${Math.min(this.i + 1, this.gates.length)}/${this.gates.length}`;
  }
  get index() { return this.i; }
  update(s) {
    if (this.missT > 0) this.missT -= s.dt;
    const g = this.gates[this.i];
    if (!g) return;
    if (this.ceil !== null && this.i >= 1 && this.corridor(s)) return;
    const hit = crossPlane(s, g.x, g.z, g.nx, g.nz, this.p);
    if (!hit) return;
    const lat = (hit.x - g.x) * -g.nz + (hit.z - g.z) * g.nx, dy = hit.y - g.y;
    const tol = this.def.tol ?? 10;
    let inside, acc;
    if (this.def.shape === 'ring') {
      const r = Math.hypot(lat, dy);
      inside = r <= g.r + tol; acc = 1 - clamp(r / g.r, 0, 1);
    } else {
      inside = Math.abs(lat) <= g.hw + tol && Math.abs(dy) <= g.hh + tol;
      acc = 1 - clamp(Math.max(Math.abs(lat) / g.hw, Math.abs(dy) / g.hh), 0, 1);
    }
    if (!inside) {
      const size = this.def.shape === 'ring' ? g.r : Math.max(g.hw, g.hh);
      if (Math.abs(lat) < size * 4 + 200 && this.missT <= 0) {
        this.missT = 2;
        this.say(dy > 0 && Math.abs(lat) <= (g.hw || g.r) ? 'Kapının üstünden geçtin: dönüp yeniden dene' : 'Kapı kaçtı: dönüp yeniden dene');
      }
      return;
    }
    g.acc = acc;
    if (this.spd) {
      const want = g.kt ?? this.def.kt;
      g.kts = s.ias / KT;
      g.sp = want == null ? 1 : band(Math.abs(g.kts - want), 5, this.def.ktTol ?? 30);
    }
    this.i++;
    const sc = this.env.score || {};
    if (this.i >= this.gates.length) {
      let pts = 0;
      const n = this.gates.length;
      for (const x of this.gates) pts += (sc.gate ?? 200) + (sc.gateAcc ?? 100) * x.acc;
      const avg = this.gates.reduce((a, x) => a + x.acc, 0) / n;
      this.parts = [[`${n} ${this.def.shape === 'ring' ? 'halka' : 'kapı'}`, `ortalama isabet %${Math.round(avg * 100)}`, Math.round(pts)]];
      if (this.spd) {
        let sp = 0, dev = 0, m = 0;
        for (const x of this.gates) {
          sp += (sc.gateKt ?? 100) * x.sp;
          const want = x.kt ?? this.def.kt;
          if (want != null) { dev += Math.abs(x.kts - want); m++; }
        }
        this.parts.push(['Hız', m ? `ortalama sapma ${Math.round(dev / m)} kt` : '', Math.round(sp)]);
        pts += sp;
      }
      if (this.ceil !== null) {
        const lp = Math.round((sc.low ?? 300) * band(this.above, 0, this.def.grace ?? 3));
        this.parts.push(['Alçak kalma', this.above < 0.05 ? `hep ${fmtFt(this.ceil)} ft altında` : `${this.above.toFixed(1).replace('.', ',')} sn yüksekte`, lp]);
        pts += lp;
      }
      this.say(this.def.shape === 'ring' ? 'Son halka!' : 'Son kapı!');
      this.done(pts);
      return;
    }
    this.say(`${g.name ? `${g.name} ✓ · ` : ''}${this.i}/${this.gates.length}`);
    this.aim();
  }
  /** Corridor: time above the ceiling after gate 1; → true when the objective failed. */
  corridor(s) {
    if (s.y <= this.ceil) { this.hiT = 0; return false; }
    this.above += s.dt;
    if (this.hiT === 0) this.say(`Çok yüksek: ${fmtFt(this.ceil)} ft altında kal!`);
    this.hiT += s.dt;
    const grace = this.def.grace ?? 3;
    if (this.above > grace) { this.fail(`Alçak kalmadın: ${fmtFt(this.ceil)} ft üstünde ${Math.round(this.above)} sn`); return true; }
    return false;
  }
}

// ----------------------------------------------------------------------------------------------------------- hover
class Hover extends Objective {
  constructor(def, env) { super(def, env); this.target = { x: def.x, y: def.y + (def.ty ?? 8), z: def.z }; this.held = 0; this.sumH = 0; this.n = 0; this.lastTenth = -1; }
  start() { super.start(); this.held = 0; this.sumH = 0; this.n = 0; this.lastTenth = -1; this.progress = `0 / ${this.def.t} sn`; }
  update(s) {
    const d = this.def;
    const h = Math.hypot(s.x - d.x, s.z - d.z);
    const hgt = s.y - d.y;
    const ok = !s.onGround && h <= d.r && hgt >= d.hmin && hgt <= d.hmax + 4 && s.gs <= d.maxKt * KT;
    if (ok) { this.held += s.dt; this.sumH += h * s.dt; this.n += s.dt; }
    else this.held = Math.max(0, this.held - s.dt * 1.5);
    const tenth = Math.floor(this.held * 2);
    if (tenth !== this.lastTenth) { this.lastTenth = tenth; this.progress = `${(Math.floor(this.held * 2) / 2).toFixed(1).replace('.', ',')} / ${d.t} sn`; }
    if (this.held >= d.t) {
      const avg = this.n > 0 ? this.sumH / this.n : d.r;
      const pts = Math.round(300 * band(avg, 2, d.r));
      this.parts = [['Asılı kalma', `ortalama ${avg.toFixed(1).replace('.', ',')} m sapma`, pts]];
      this.say(d.doneMsg || 'Güzel hover! Şimdi dikey in.');
      this.done(pts);
    }
  }
  onLanding(card, td) {
    if (Math.hypot(td.x - this.def.x, td.z - this.def.z) <= this.def.r) this.say(`Önce pedin üstünde ${this.def.t} sn asılı kal`);
  }
}

// ----------------------------------------------------------------------------------------------------------- orbit
class Orbit extends Objective {
  constructor(def, env) {
    super(def, env);
    const n = def.n || 8;
    this.rMid = (def.rmin + def.rmax) / 2; this.yMid = (def.ymin + def.ymax) / 2;
    this.sgn = def.dir === 'left' ? -1 : 1;          // bearings grow clockwise: right = +1, left = -1
    this.deg = def.deg || 360;
    this.gates = [];
    for (let i = 0; i < n; i++) this.gates.push({ x: def.x, y: this.yMid, z: def.z, r: Math.max(8, Math.min(150, (def.rmax - def.rmin) / 2)), nx: 0, nz: 0, a: 0 });   // (r: marker size only)
    this.target = { x: def.x, y: this.yMid, z: def.z };
    this.a0 = 0; this.setOrigin(0);
    this.reset();
  }
  reset() {
    this.swept = 0; this.prevA = NaN; this.outT = 0; this.exits = 0; this.sumR = 0; this.sumY = 0; this.n = 0;
    this.inside = false; this.began = false; this.wrongT = 0; this.lastDeg = -1; this.lastIdx = -1; this.warnT = 0;
  }
  start() { super.start(); this.reset(); this.progress = `0° / ${this.deg}°`; this.aim(); }
  /** Checkpoint rings on the ideal circle, starting `step` beyond bearing a0 (deg) in the flight direction. */
  setOrigin(a0) {
    this.a0 = a0;
    const n = this.gates.length, step = this.deg / n, d = this.def;
    for (let i = 0; i < n; i++) {
      const a = (a0 + this.sgn * step * (i + 1)) * Math.PI / 180;
      const g = this.gates[i];
      g.a = a; g.x = d.x + Math.sin(a) * this.rMid; g.z = d.z - Math.cos(a) * this.rMid;
      // plane normal = the flight direction along the circle (tangent)
      g.nx = Math.cos(a) * this.sgn; g.nz = Math.sin(a) * this.sgn;
    }
  }
  /** Markers before the first sample: the rings start on the side of (x0, z0) (usually the mission start). */
  orient(x0, z0) { this.setOrigin(bearingDeg(this.def.x, this.def.z, x0, z0)); }
  get index() { return Math.min(this.gates.length - 1, Math.floor(this.swept / (this.deg / this.gates.length))); }
  aim() {
    const g = this.gates[this.index];
    this.target.x = g.x; this.target.y = g.y; this.target.z = g.z;
  }
  update(s) {
    const d = this.def;
    const dx = s.x - d.x, dz = s.z - d.z, r = Math.hypot(dx, dz);
    const a = bearingDeg(d.x, d.z, s.x, s.z);
    const inR = r >= d.rmin && r <= d.rmax, inY = s.y >= d.ymin && s.y <= d.ymax;
    const inside = inR && inY && !s.onGround;
    if (this.warnT > 0) this.warnT -= s.dt;
    if (inside) {
      if (!this.began) {                               // first time in the band: the circle starts here
        this.began = true;
        if (Math.abs(wrap180d(a - this.a0)) > 25) this.setOrigin(a);
        else this.setOrigin(this.a0);
        this.say(`Tur başladı: ${d.dir === 'left' ? 'sola (saat yönünün tersine)' : 'sağa (saat yönünde)'} dön`);
      }
      if (!Number.isNaN(this.prevA) && this.inside) {
        const da = wrap180d(a - this.prevA) * this.sgn;
        this.swept = Math.max(0, this.swept + da);
        if (da < 0) {
          this.wrongT += s.dt;
          if (this.wrongT > 2 && this.warnT <= 0) { this.warnT = 4; this.say(`Ters yöne dönüyorsun: ${d.dir === 'left' ? 'sola' : 'sağa'} dön`); }
        } else this.wrongT = 0;
      }
      this.outT = 0;
      this.sumR += Math.abs(r - this.rMid) * s.dt; this.sumY += Math.abs(s.y - this.yMid) * s.dt; this.n += s.dt;
    } else if (this.began) {
      if (this.inside && this.warnT <= 0) {
        this.warnT = 3;
        this.say(!inY ? (s.y < d.ymin ? 'Çok alçak: tur sayılmıyor' : 'Çok yüksek: tur sayılmıyor') : r > d.rmax ? 'Çok uzaklaştın: kuleye yaklaş' : 'Çok yakın: çemberi genişlet');
      }
      this.outT += s.dt;
      if (this.outT > (d.grace ?? 8) && this.swept > 0) {
        this.exits++; this.swept = 0; this.outT = 0; this.began = false; this.sumR = 0; this.sumY = 0; this.n = 0;
        this.say('Çemberden çıktın: tur baştan başlıyor');
      }
    }
    this.inside = inside;
    this.prevA = a;
    const deg = Math.floor(this.swept / 5) * 5;
    if (deg !== this.lastDeg) { this.lastDeg = deg; this.progress = `${Math.min(deg, this.deg)}° / ${this.deg}°`; }
    const idx = this.index;
    if (idx !== this.lastIdx) { this.lastIdx = idx; this.aim(); }
    if (this.swept >= this.deg) {
      const t = this.n || 1;
      const rAcc = 1 - clamp((this.sumR / t) / ((d.rmax - d.rmin) / 2), 0, 1);
      const yAcc = 1 - clamp((this.sumY / t) / ((d.ymax - d.ymin) / 2), 0, 1);
      const clean = this.exits === 0 ? 1 : this.exits === 1 ? 0.5 : 0;
      const pr = Math.round(400 * rAcc), py = Math.round(200 * yAcc), pc = Math.round(200 * clean);
      this.parts = [
        ['Tur yarıçapı', `ortalama ${Math.round(this.sumR / t)} m sapma`, pr],
        ['Tur yüksekliği', `ortalama ${Math.round(this.sumY / t / FT)} ft sapma`, py],
        ['Kesintisiz tur', this.exits ? `${this.exits} kez baştan` : 'baştan başlamadan', pc],
      ];
      this.say('Tur tamam!');
      this.done(pr + py + pc);
    }
  }
}

// -------------------------------------------------------------------------------------------------------- goaround
class GoAround extends Objective {
  constructor(def, env) { super(def, env); this.target = null; this.y0 = NaN; this.yMin = 0; this.called = false; this.lastFt = -1; }
  start() { super.start(); this.y0 = NaN; this.yMin = 0; this.called = false; this.lastFt = -1; }
  update(s) {
    if (!this.called) { this.called = true; this.y0 = s.y; this.yMin = s.y; this.say(this.def.call || 'PAS GEÇ! Tam güç, burnu kaldır, pozitif tırmanışta takımı topla'); }
    if (s.onGround) { this.fail('Piste değdin: pas geçerken tekerlekler yere değmemeli'); return; }
    if (s.y < this.yMin) this.yMin = s.y;
    const ft = Math.round(s.y / FT / 100) * 100;
    if (ft !== this.lastFt) { this.lastFt = ft; this.progress = `${fmtFt(Math.max(0, s.y))} / ${fmtFt(this.def.min)} ft`; }
    if (s.y >= this.def.min) {
      const dip = Math.max(0, this.y0 - this.yMin);
      const pts = Math.round(400 * band(dip, 8, 60));
      this.parts = [['Pas geçiş', `${Math.round(dip / FT)} ft irtifa kaybı`, pts]];
      this.done(pts);
    }
  }
  onLanding() { if (this.status === 'active') this.fail('Piste değdin: pas geçerken tekerlekler yere değmemeli'); }
}

const DEGR = 180 / Math.PI;
/** Bearing (deg, 0 = north, clockwise) from (x0, z0) to (x1, z1). */
const bearingDeg = (x0, z0, x1, z1) => { const b = Math.atan2(x1 - x0, -(z1 - z0)) * DEGR; return b < 0 ? b + 360 : b; };
const wrap180d = (v) => ((v % 360) + 540) % 360 - 180;

// ------------------------------------------------------------------------------------------------------------- pad
class Pad extends Objective {
  constructor(def, env) { super(def, env); this.target = { x: def.x, y: def.y + 2, z: def.z }; }
  onLanding(card, td) {
    const d = this.def, dist = Math.hypot(td.x - d.x, td.z - d.z);
    if (dist > d.r) {
      if (d.outFail) this.fail(`${d.outFail} (${Math.round(dist - d.r)} m)`);   // e.g. an autorotation: no second try
      else this.say(`Ped dışı (${Math.round(dist)} m): kalk ve pedin ortasına in`);
      return;
    }
    if (card.stars < 1) { this.fail(`Sert iniş (${card.fpm} ft/dk)`); return; }
    const sc = this.env.score || {};
    const pAcc = Math.round(400 * band(dist, 1.5, d.r));
    const pLand = Math.round((sc.landing ?? 8) * card.points);
    this.landing = card;
    this.parts = [['Ped isabeti', `${dist.toFixed(1).replace('.', ',')} m`, pAcc], ['İniş', `${card.label} · ${card.points}/100`, pLand], ...landingRows(card)];
    this.done(pAcc + pLand);
  }
}

// ------------------------------------------------------------------------------------------------------------ land
class Land extends Objective {
  constructor(def, env) {
    super(def, env);
    const want = def.target && (env.ends || []).find((e) => e.name === def.target);
    this.targetEnd = want || null;
    this.target = want ? { x: want.aimX ?? want.x, y: want.elevation ?? 4, z: want.aimZ ?? want.z } : null;
  }
  onLanding(card) {
    const d = this.def;
    const apt = card.runway ? card.runway.split(' ')[0] : '';
    if (d.exclude && card.runway && d.exclude.includes(card.runway)) { this.fail(`Pist ${card.runway.split(' ')[1]} yalnız kalkışa açık: iniş sayılmaz`); return; }
    let allowed;
    if (d.runways) allowed = card.onRunway && d.runways.includes(card.runway);
    else if (d.airports) allowed = card.onRunway && d.airports.includes(apt);
    else allowed = d.heli ? true : card.onRunway;
    if (!allowed) {
      if (!card.onRunway && !d.heli) this.fail('Pist dışına indin');
      else if (d.runways) this.fail(`Yanlış pist: ${d.runways[0].replace(/^K/, '').replace(' ', ' ')} olmalıydı`);
      else this.fail('Yanlış havalimanı');
      return;
    }
    if (card.stars < (d.minStars ?? 1)) { this.fail(`İniş çok sert (${card.fpm} ft/dk)`); return; }
    const sc = this.env.score || {};
    this.landing = card;
    const pl = Math.round((sc.landing ?? 10) * card.points);
    this.parts = [['İniş', `${card.label} · ${card.points}/100`, pl], ...landingRows(card)];
    let pts = pl;
    if (d.heli && sc.runwayBonus && card.onRunway) { this.parts.push(['Piste iniş', card.runway || 'pist', sc.runwayBonus]); pts += sc.runwayBonus; }
    this.done(pts);
  }
}

// ----------------------------------------------------------------------------------------------------------- ditch
class Ditch extends Objective {
  constructor(def, env) { super(def, env); this.target = null; }
  /** d = { fpm, pitch, roll, kt, gear, flaps, survived?: the flight model's verdict (src/flight: flight.ditched) } */
  onDitch(d) {
    const r = scoreDitch(d);
    if (d.survived === true && !r.survivable) { r.survivable = true; r.stars = 1; }
    if (d.survived === false) { r.survivable = false; r.stars = 0; }
    this.ditch = { ...d, ...r };
    if (!r.survivable) {
      this.fail(d.gear >= 0.1 ? 'İniş takımı açıkken suya girdin: takımı kapalı tut'
        : d.fpm > 900 ? `Suya çok sert çarptın (${Math.round(d.fpm)} ft/dk)`
        : Math.abs(d.roll) > 10 ? 'Kanat suya saplandı: kanatlar düz olmalı'
        : d.kt >= 190 ? `Suya çok hızlı girdin (${Math.round(d.kt)} kt)`
        : d.pitch <= 2 ? 'Burun suya gömüldü: burnu hafif yukarıda tut' : 'Burun çok yukarıdaydı: kuyruk suya çarptı');
      return;
    }
    const sc = this.env.score || {};
    const k = sc.ditch ?? 10;
    this.parts = [
      ['Suya temas hızı', `${Math.round(d.fpm)} ft/dk`, Math.round(k * 35 * r.parts.sink)],
      ['Burun açısı', `${d.pitch.toFixed(1).replace('.', ',')}°`, Math.round(k * 20 * r.parts.pitch)],
      ['Kanatlar', `${Math.abs(d.roll).toFixed(1).replace('.', ',')}° yatış`, Math.round(k * 20 * r.parts.bank)],
      ['Hız', `${Math.round(d.kt)} kt`, Math.round(k * 15 * r.parts.speed)],
      ['İniş takımı', d.gear < 0.1 ? 'kapalı' : 'açık', Math.round(k * 10 * r.parts.gear)],
    ];
    this.done(k * r.points);
  }
  onLanding(card) {   // a runway made it after all: even better (the card is the landing score)
    if (!card.onRunway) return;
    const sc = this.env.score || {};
    this.landing = card;
    this.parts = [['Piste iniş', `${card.label} · ${card.runway}`, Math.round((sc.ditch ?? 10) * card.points)]];
    this.say('Piste yetiştin!');
    this.done((sc.ditch ?? 10) * card.points);
  }
}

/** Detail rows of a landing card for the results breakdown (no points of their own). */
function landingRows(c) {
  const f1 = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  const rows = [['· Dikey hız', `${c.fpm} ft/dk`, 0]];
  if (c.cat === 'helicopter') rows.push(['· Yatay kayma', `${f1(c.drift)} kt`, 0]);
  else {
    if (c.cl != null) rows.push(['· Merkez çizgi', `${f1(c.cl)} m${c.side ? ` ${c.side}` : ''}`, 0]);
    if (c.tdz != null) rows.push(['· Eşikten', `${c.tdz} m`, 0]);
  }
  if (c.bounces) rows.push(['· Zıplama', String(c.bounces), 0]);
  return rows;
}

const TYPES = { altitude: Altitude, bridge: Bridge, gates: Gates, hover: Hover, pad: Pad, land: Land, ditch: Ditch, orbit: Orbit, goaround: GoAround };

export function createObjective(def, env) {
  const T = TYPES[def.type];
  if (!T) throw new Error(`unknown objective type ${def.type}`);
  return new T(def, env);
}

/** Distance text for the HUD ('3,2 km'). */
export { fmtDist, FPM };
