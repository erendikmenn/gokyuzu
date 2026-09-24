// Route model for the navigation map and LNAV (no DOM: also runs in Node for tests/nav.test.mjs).
//
//   const route = createRoute();
//   route.add(x, z)                   user waypoint (appended, or inserted at an index)
//   route.move(id, x, z) / remove(id) / setAlt(id, altM | null) / setDefaultAlt(altM | null) / clear()
//   route.setSpeed(id, { ias, mach }) / setDefaultSpeed({ ias, mach })   leg speed (m/s CAS or Mach; nulls = automatic,
//                                     src/nav/speed.js); final approach legs keep their procedure speeds
//   route.directTo(id)                "Direkt git": that waypoint becomes the active one, from the present position
//   route.directToPoint(x, z)         direct-to a free point (the route becomes that single point)
//   route.setApproach(runwayEnd, category, env)   "Bu piste yaklaş": procedure points appended after the user points
//
// `waypoints` is the compiled list (user points, then approach points); `active` indexes the TO waypoint of the
// active leg, whose FROM point is waypoints[active − 1] or, for the first leg / after a direct-to, `origin` (the
// present position at that moment). Every edit increments `version` (UI caches) and notifies listeners; LNAV
// sequencing increments `seq`. Positions are local meters (x east, z south), altitudes meters MSL.
import { runwayEnds } from '../flight/fixedwing-autopilot.js';

export const NM = 1852;
const FT = 0.3048;
const KT = 0.514444;
const DEG = Math.PI / 180;
const GS_TAN = Math.tan(3 * DEG);
const AIM = 300;                  // glide path origin past the threshold (fixedwing-autopilot.js AIM_DIST)

/**
 * Approach procedure parameters per category.
 *   dIf       preferred distance of the intermediate fix (IF) from the threshold (NM), shortened down to dIfMin when the
 *             point would leave the map or terrain / obstacles rise too close to the glide path
 *   capture   level segment after the IF before the glide slope is intercepted from below (NM)
 *   base      lateral offset of the base-turn point for a 45° intercept of the final (m)
 *   cone      the IF is flown to directly when the previous point lies within ±cone of the extended centreline behind it
 */
export const APPROACH = {
  airliner: { dIf: 8, dIfMin: 5, capture: 1.3, base: 5200, cone: 50, minAgl: 1500 * FT, baseAbove: 1000 * FT },
  fighter: { dIf: 6, dIfMin: 4, capture: 1.0, base: 4200, cone: 55, minAgl: 1500 * FT, baseAbove: 1000 * FT },
  helicopter: { dIf: 1.5, dIfMin: 0.8, capture: 0, base: 1500, cone: 60, minAgl: 500 * FT, baseAbove: 300 * FT, hoverAgl: 7.5, hoverPast: 60 },
};

let nextId = 1;
const round100ft = (m) => Math.round(m / (100 * FT)) * 100 * FT;
const floor100ft = (m) => Math.floor(m / (100 * FT) + 1e-6) * 100 * FT;
const ceil100ft = (m) => Math.ceil(m / (100 * FT) - 1e-6) * 100 * FT;
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); return a < 0 ? a + Math.PI : a - Math.PI; };

/** True course (rad, 0 = north, clockwise) from (x0,z0) to (x1,z1). */
export function courseTo(x0, z0, x1, z1) { return Math.atan2(x1 - x0, -(z1 - z0)); }

/** Runway end by name ('KSFO 28R') or null. */
export function findRunwayEnd(runways, name) {
  for (const r of runwayEnds(runways)) if (r.name === name) return r;
  return null;
}

export function createRoute() { return new Route(); }

export class Route {
  constructor() {
    this.user = [];              // { id, x, z, alt (m MSL | null), kind: 'wpt' }
    this.approach = null;        // { rw, category, points: [...], name }
    this.waypoints = [];         // compiled: user points, then approach points
    this.defaultAlt = null;      // m MSL used by points without their own altitude (null: keep the present altitude)
    this.defaultSpd = null;      // m/s CAS for points without their own speed (null with defaultMach null: automatic)
    this.defaultMach = null;
    this.active = 0;
    this.origin = { x: 0, z: 0 };
    this.version = 0;            // edits
    this.seq = 0;                // LNAV sequencing
    this.finished = false;       // last waypoint passed (fixed wing) / hover reached (helicopter)
    this.px = 0; this.pz = 0; this.ptrack = 0; this.pValid = false;   // last known aircraft position / track (LNAV)
    this.category = 'airliner';
    this.env = null;             // { groundAt(x,z), obstacleAt(x,z), bounds } for approach building and MSA checks
    this._listeners = [];
  }

  on(cb) { this._listeners.push(cb); return () => { this._listeners = this._listeners.filter((c) => c !== cb); }; }
  _changed(kind) {
    this.version++;
    for (const cb of this._listeners) { try { cb(kind, this); } catch (e) { console.error(e); } }
  }

  /** Aircraft position / track (called every frame by LNAV; also used as the FROM point of a new first leg). */
  setPosition(x, z, trackRad) { this.px = x; this.pz = z; if (Number.isFinite(trackRad)) this.ptrack = trackRad; this.pValid = true; }

  get length() { return this.waypoints.length; }
  get empty() { return this.waypoints.length === 0; }
  /** A leg is there to fly. */
  get hasActive() { return !this.finished && this.active < this.waypoints.length; }
  get activeWaypoint() { return this.hasActive ? this.waypoints[this.active] : null; }
  /** FROM point of the active leg. */
  legFrom() { return this.active > 0 ? this.waypoints[this.active - 1] : this.origin; }
  indexOf(id) { return this.waypoints.findIndex((w) => w.id === id); }
  byId(id) { return this.waypoints.find((w) => w.id === id) || null; }
  /** Index of the first approach point in `waypoints` (= user.length) or -1. */
  get approachStart() { return this.approach ? this.user.length : -1; }
  get onApproach() { return !!this.approach && this.hasActive && this.active >= this.user.length; }

  /** Altitude flown toward waypoint w (m MSL) or null (keep the present one). */
  altFor(w) {
    if (!w) return null;
    if (w.alt != null) return w.alt;
    if (w.kind === 'wpt' && this.defaultAlt != null) return this.defaultAlt;
    return null;
  }

  _resetOrigin() {
    this.origin.x = this.px; this.origin.z = this.pz;
  }

  _compile() {
    const list = this.user.slice();
    if (this.approach) list.push(...this.approach.points);
    this.user.forEach((w, i) => { w.name = String(i + 1); });
    this.waypoints = list;
    if (this.active > list.length) this.active = list.length;
    if (!list.length) { this.active = 0; this.finished = false; }
  }

  /** Append (or insert at `index` of the user list) a user waypoint; returns it. */
  add(x, z, { index = this.user.length, alt = null } = {}) {
    const w = { id: nextId++, x, z, alt, spd: null, mach: null, kind: 'wpt', name: '' };
    const wasEmpty = !this.hasActive;
    index = Math.max(0, Math.min(this.user.length, index));
    this.user.splice(index, 0, w);
    if (wasEmpty) { this.active = this.finished ? index : Math.min(this.active, index); this.finished = false; this._resetOrigin(); }
    else if (index < this.active) this.active++;
    this._rebuildApproach();
    this._compile();
    this._changed('add');
    return w;
  }

  move(id, x, z) {
    const w = this.user.find((p) => p.id === id);
    if (!w) return false;
    w.x = x; w.z = z;
    this._rebuildApproach();
    this._compile();
    this._changed('move');
    return true;
  }

  remove(id) {
    const i = this.user.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.user.splice(i, 1);
    if (i < this.active) this.active--;
    else if (i === this.active) this._resetOrigin();          // TO waypoint deleted: direct to the next one
    this._rebuildApproach();
    this._compile();
    this._changed('remove');
    return true;
  }

  setAlt(id, alt) {
    const w = this.waypoints.find((p) => p.id === id);
    if (!w || w.fixedAlt) return false;
    w.alt = alt == null ? null : Math.max(0, alt);
    this._changed('alt');
    return true;
  }

  setDefaultAlt(alt) {
    this.defaultAlt = alt == null ? null : Math.max(0, alt);
    this._changed('alt');
  }

  /** Leg speed into waypoint `id`: { ias } (m/s CAS) or { mach }; both null = automatic. */
  setSpeed(id, { ias = null, mach = null } = {}) {
    const w = this.waypoints.find((p) => p.id === id);
    if (!w || w.fixedSpd) return false;
    w.spd = ias == null ? null : Math.max(0, ias);
    w.mach = ias == null && mach != null ? Math.max(0, mach) : null;
    this._changed('spd');
    return true;
  }

  /** Route default speed for points without their own: { ias } or { mach }; both null = automatic per category. */
  setDefaultSpeed({ ias = null, mach = null } = {}) {
    this.defaultSpd = ias == null ? null : Math.max(0, ias);
    this.defaultMach = ias == null && mach != null ? Math.max(0, mach) : null;
    this._changed('spd');
  }

  clear() {
    this.user = []; this.approach = null; this.waypoints = []; this.active = 0; this.finished = false;
    this._changed('clear');
  }

  /** "Direkt git" to an existing waypoint: the points before it are dropped, the leg starts at the present position. */
  directTo(id) {
    const i = this.indexOf(id);
    if (i < 0) return false;
    const nu = this.user.length;
    if (i < nu) this.user.splice(0, i);
    else {
      this.user = [];
      this.approach.points.splice(0, i - nu);
    }
    this.active = 0; this.finished = false;
    this._resetOrigin();
    this._compile();
    this._changed('direct');
    return true;
  }

  /** Direct-to a free point: the route becomes that single point (flown from the present position). */
  directToPoint(x, z, alt = null) {
    this.user = []; this.approach = null; this.waypoints = [];
    this.active = 0; this.finished = false;
    const w = this.add(x, z, { alt });
    this._changed('direct');
    return w;
  }

  /** Called by LNAV: the active waypoint was passed. */
  sequence() {
    if (!this.hasActive) return;
    this.active++;
    if (this.active >= this.waypoints.length) this.finished = true;
    this.seq++;
  }
  /** Re-fly the route from the present position (AP engaged in NAV while the first leg is active). */
  restartLeg() { if (this.active === 0) this._resetOrigin(); }
  /** Flight reset: fly the whole route again from the new position (x, z). */
  restart(x, z, trackRad) {
    if (!this.waypoints.length) return;
    this.setPosition(x, z, trackRad);
    this.active = 0; this.finished = false;
    this._resetOrigin();
    this.seq++;
    this._changed('restart');
  }

  // ------------------------------------------------------------------------------------------ approach
  /**
   * "Bu piste yaklaş": build the approach to runway end `rw` (an entry of runwayEnds()) for the aircraft category.
   * Replaces a previous approach; user points stay in front of it. env: { groundAt, obstacleAt, bounds }.
   */
  setApproach(rw, category, env = this.env) {
    if (!rw || rw.landing === false) return null;     // departure-only runway end: no approach
    if (env) this.env = env;
    this.category = category || this.category;
    this.approach = { rw, category: this.category, name: rw.name, points: [] };
    const wasIdle = !this.hasActive;
    this._rebuildApproach(true);
    if (wasIdle) { this.active = this.user.length; this.finished = false; this._resetOrigin(); }
    this._compile();
    this._changed('approach');
    return this.approach;
  }

  clearApproach() {
    if (!this.approach) return;
    const nu = this.user.length;
    this.approach = null;
    if (this.active > nu) this.active = nu;
    this._compile();
    if (this.active >= this.waypoints.length && this.waypoints.length) this.finished = true;
    this._changed('approach');
  }

  /** Recompute the approach points from the point before them (only while the approach is not being flown yet). */
  _rebuildApproach(force = false) {
    const A = this.approach;
    if (!A) return;
    const nu = this.user.length;
    if (!force && this.active >= nu && A.points.length && this.hasActive) return;
    let from;
    if (nu) {
      const last = this.user[nu - 1], prev = nu > 1 ? this.user[nu - 2] : (this.active < nu ? this.origin : null);
      from = { x: last.x, z: last.z, track: prev ? courseTo(prev.x, prev.z, last.x, last.z) : NaN };
    } else from = { x: this.px, z: this.pz, track: this.pValid ? this.ptrack : NaN };
    const old = A.points;
    A.points = buildApproach(A.rw, A.category, from, this.env);
    A.from = from;
    // speeds the player set on the entry legs survive the rebuild
    for (const p of A.points) { const o = old.find((q) => q.kind === p.kind); if (o && !p.fixedSpd) { p.spd = o.spd; p.mach = o.mach; } }
  }

  /** Leg list for drawing: [{ x0, z0, x1, z1, active, done, approach }]. */
  legs(out = []) {
    out.length = 0;
    const W = this.waypoints;
    for (let i = 0; i < W.length; i++) {
      const a = i === 0 ? (this.active === 0 && this.hasActive ? this.origin : null) : W[i - 1];
      if (!a) continue;
      const b = W[i];
      out.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, index: i, active: i === this.active && this.hasActive, done: i < this.active || this.finished, approach: b.kind !== 'wpt' });
    }
    return out;
  }

  /** Total distance (m) from the present position along the remaining route. */
  remaining() {
    if (!this.hasActive) return 0;
    const W = this.waypoints;
    let d = Math.hypot(W[this.active].x - this.px, W[this.active].z - this.pz);
    for (let i = this.active + 1; i < W.length; i++) d += Math.hypot(W[i].x - W[i - 1].x, W[i].z - W[i - 1].z);
    return d;
  }

  /**
   * Terrain / obstacle clearance per leg (called by the UI after edits, not per frame): for each waypoint index the
   * highest ground or obstacle (m MSL) along the leg into it, sampled every 150 m. Needs env.groundAt.
   */
  clearance(env = this.env) {
    const res = [];
    if (!env || !env.groundAt) return res;
    const W = this.waypoints;
    for (let i = 0; i < W.length; i++) {
      const a = i === 0 ? (this.hasActive && this.active === 0 ? this.origin : null) : W[i - 1];
      if (!a) { res.push(-Infinity); continue; }
      const b = W[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 150));
      let top = -Infinity;
      const end = b.kind === 'thr' || b.kind === 'hov' ? n - 1 : n;   // the runway itself is not an obstacle
      for (let k = 1; k <= end; k++) {
        const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        let h = env.groundAt(x, z);
        if (env.obstacleAt) { const o = env.obstacleAt(x, z); if (Number.isFinite(o) && o > h) h = o; }
        if (h > top) top = h;
      }
      res.push(top);
    }
    return res;
  }
}

// ------------------------------------------------------------------------------------------ approach geometry
/** Point `along` m out on the approach side of the threshold and `lateral` m right of the final course. */
function approachPoint(rw, along, lateral = 0) {
  return { x: rw.x - rw.dx * along - rw.dz * lateral, z: rw.z - rw.dz * along + rw.dx * lateral };
}
// glide path height at dThr m before the threshold (its origin is AIM m past the threshold, as in approachGeometry)
const gsAltAt = (rw, dThr) => rw.elevation + Math.max(dThr + AIM, 0) * GS_TAN;
// procedure points may lie a little outside the map area: the 3D world (terrain, water) continues ~10 km beyond it
function inBounds(p, b, margin = -3000) {
  if (!b) return true;
  return p.x > b.minX + margin && p.x < b.maxX - margin && p.z > b.minZ + margin && p.z < b.maxZ - margin;
}
function topAlong(env, a, b, step = 200) {
  if (!env || !env.groundAt) return -Infinity;
  const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / step));
  let top = -Infinity;
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    let h = env.groundAt(x, z);
    if (env.obstacleAt) { const o = env.obstacleAt(x, z); if (Number.isFinite(o) && o > h) h = o; }
    if (h > top) top = h;
  }
  return top;
}

/**
 * Approach points for runway end `rw` flown from `from` { x, z, track (rad, NaN = unknown) }.
 * Fixed wing: [BASE?] → IF (on the extended centreline, level below the glide slope) → FAF (glide-slope intercept)
 * → threshold; the autopilot hands over to the ILS logic of that runway on the IF → FAF leg.
 * Helicopter: [BASE?] → IF (500 ft above the field) → hover point just past the threshold (6 m).
 */
export function buildApproach(rw, category, from, env) {
  const heli = category === 'helicopter';
  const P = APPROACH[category] || APPROACH.airliner;
  const bounds = env && env.bounds;
  const elev = rw.elevation;
  const ground = (x, z) => (env && env.groundAt ? env.groundAt(x, z) : elev);
  // ---- IF distance: as far out as the map and the terrain allow
  let dIf = P.dIfMin * NM;
  for (let d = P.dIf; d >= P.dIfMin - 1e-6; d -= 0.5) {
    const p = approachPoint(rw, d * NM);
    if (!inBounds(p, bounds)) continue;
    let ok = true;
    if (!heli && env && env.groundAt) {
      for (let s = 1500; s <= d * NM; s += 250) {
        const q = approachPoint(rw, s);
        let h = ground(q.x, q.z);
        if (env.obstacleAt) { const o = env.obstacleAt(q.x, q.z); if (Number.isFinite(o) && o > h) h = o; }
        // clearance below the glide path: 15 m near the runway, growing to 120 m further out
        if (h > gsAltAt(rw, s) - Math.min(120, Math.max(15, (s - 1000) * 0.03))) { ok = false; break; }
      }
    }
    if (ok) { dIf = d * NM; break; }
  }
  const IF = approachPoint(rw, dIf);
  const pts = [];
  let altIf;
  if (heli) {
    altIf = ceil100ft(Math.max(elev + P.minAgl, topAlong(env, IF, rw) + 100));
  } else {
    // level at the IF below the glide slope: intercept `capture` NM after the IF (shorter for a close-in IF)
    const capture = Math.min(P.capture, Math.max(0.5, dIf / NM - 4.2)) * NM;
    altIf = floor100ft(gsAltAt(rw, dIf - capture));
    altIf = Math.max(altIf, ceil100ft(elev + P.minAgl * 0.66));
    const top = topAlong(env, IF, approachPoint(rw, Math.max(dIf - capture - NM, 1500)));
    if (Number.isFinite(top)) altIf = Math.max(altIf, ceil100ft(top + 150));
  }
  // ---- entry: straight in, established on final, or via a base-turn point (45° intercept)
  const fx = from.x - rw.x, fz = from.z - rw.z;
  const aQ = -(fx * rw.dx + fz * rw.dz);            // m out on the approach side (negative: beyond the threshold)
  const lQ = -fx * rw.dz + fz * rw.dx;              // m right of the final course
  const trkOk = Number.isFinite(from.track);
  const trkErr = trkOk ? Math.abs(wrapPi(from.track - rw.course)) : Math.PI;
  const established = !heli && aQ > 2.5 * NM && aQ < dIf + 2 * NM && Math.abs(lQ) < aQ * Math.tan(25 * DEG) && trkErr < 50 * DEG;
  if (established) {
    // already on (or close to) the final: join the centreline ahead and let the ILS logic capture
    const dF = Math.max(Math.min(aQ - 1.5 * NM, dIf), 2 * NM);
    const F = approachPoint(rw, dF);
    pts.push({ ...F, kind: 'faf', name: 'FAF', alt: Math.max(floor100ft(gsAltAt(rw, dF)), ceil100ft(elev + 500 * FT)) });
  } else {
    const straight = aQ > dIf + 0.4 * P.base && Math.abs(lQ) <= (aQ - dIf) * Math.tan(P.cone * DEG);
    if (!straight) {
      let s = Math.abs(lQ) > 400 ? Math.sign(lQ) : (trkOk ? (Math.sin(from.track - rw.course) >= 0 ? -1 : 1) : 1);
      let L = P.base, B = approachPoint(rw, dIf + L, s * L);
      if (!inBounds(B, bounds)) {
        const B2 = approachPoint(rw, dIf + L, -s * L);
        if (inBounds(B2, bounds)) { s = -s; B = B2; }
        else {
          for (let k = 0.85; k >= 0.5 && !inBounds(B, bounds); k -= 0.05) { L = P.base * k; B = approachPoint(rw, dIf + L, s * L); }
        }
      }
      let altB = altIf + P.baseAbove;
      const top = Math.max(topAlong(env, B, IF), topAlong(env, from, B));
      if (Number.isFinite(top)) altB = Math.max(altB, ceil100ft(top + (heli ? 100 : 300)));
      pts.push({ ...B, kind: 'base', name: 'GİRİŞ', alt: round100ft(altB) });
    }
    pts.push({ ...IF, kind: 'if', name: 'IF', alt: altIf });
    if (!heli) {
      let dFaf = (altIf - elev) / GS_TAN - AIM;
      dFaf = Math.min(dFaf, dIf - 0.5 * NM);
      const F = approachPoint(rw, dFaf);
      pts.push({ ...F, kind: 'faf', name: 'FAF', alt: altIf });
    }
  }
  if (heli) {
    const H = approachPoint(rw, -P.hoverPast);
    pts.push({ ...H, kind: 'hov', name: rw.ident, alt: ground(H.x, H.z) + P.hoverAgl, hover: true });
  } else {
    pts.push({ x: rw.x, z: rw.z, kind: 'thr', name: rw.ident, alt: elev });
  }
  for (const p of pts) {
    p.id = nextId++; p.fixedAlt = true; p.rw = rw.name;
    p.spd = null; p.mach = null;
    p.fixedSpd = p.kind === 'faf' || p.kind === 'thr' || p.kind === 'hov';   // the final keeps its procedure speeds
  }
  return pts;
}

export { KT, FT };
