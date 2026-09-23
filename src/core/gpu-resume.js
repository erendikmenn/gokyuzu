// "Continue the same flight" after a graphics failure (robustness, src/core/gpu-guard.js):
// a compact snapshot of the flight (aircraft, position, heading, speed, attitude, gear/flaps, autopilot targets, route,
// camera) is kept in sessionStorage while flying; after a WebGL context loss the page reloads with
// ?resume=1 and main.js restores it. If the tab itself was killed (iOS reloads a crashed tab: no `pagehide` was seen)
// the next load of this tab resumes too.
import { findRunwayEnd } from '../nav/route.js';

const KEY = 'gokyuzu.resume';
const MAX_AGE = 10 * 60 * 1000;      // a ?resume=1 reload uses snapshots up to 10 min old
const CRASH_AGE = 3 * 60 * 1000;     // an unannounced tab restart resumes only a very recent flight
const HIDDEN_AGE = 30 * 60 * 1000;   // … or one left in a background tab (mobile browsers discard those under memory pressure)
const DEG = Math.PI / 180;
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const r1 = (v) => Math.round(fin(v) * 10) / 10;

function store(o) { try { sessionStorage.setItem(KEY, JSON.stringify(o)); return true; } catch { return false; } }
function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } }
export function clearResume() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } }

function routeState(route) {
  if (!route || !route.waypoints || !route.waypoints.length || route.finished) return null;
  const nu = route.user.length, active = route.active || 0;
  const user = route.user.slice(Math.min(active, nu)).map((w) => ({ x: r1(w.x), z: r1(w.z), alt: w.alt, spd: w.spd, mach: w.mach }));
  return {
    user, defaultAlt: route.defaultAlt, defaultSpd: route.defaultSpd, defaultMach: route.defaultMach,
    approach: route.approach ? { name: route.approach.name, category: route.approach.category } : null,
    approachActive: active >= nu && route.approach ? active - nu : -1,
  };
}

/** Snapshot of the running flight (null when there is nothing worth resuming). */
export function flightSnapshot(state) {
  const f = state.flight, choice = state.choice;
  if (!f || !choice || f.crashed || !Number.isFinite(f.position.x) || !Number.isFinite(f.position.y)) return null;
  const ap = f.autopilot || {};
  return {
    v: 1, t: Date.now(), alive: true,
    aircraft: choice.aircraftId, spawn: choice.spawnId,
    x: r1(f.position.x), y: r1(f.position.y), z: r1(f.position.z),
    heading: r1(fin(f.heading)),                          // deg
    speed: r1(fin(f.airspeed)),                           // TAS m/s
    vs: r1(fin(f.verticalSpeed)), roll: r1(fin(f.roll)),  // m/s, deg
    onGround: !!f.onGround, gear: !!f.gearHandleDown, flaps: f.flapsIndex | 0, throttle: r1(fin(f.throttle) * 100) / 100,
    ap: ap.on ? { lnav: !!ap.lnav, altitude: r1(ap.altitude), heading: r1(ap.heading), speed: r1(ap.speed) } : null,
    route: routeState(state.navRoute),
    camera: state.cameraRig ? state.cameraRig.mode : null,
  };
}

/** Save now (while flying). */
export function saveSnapshot(state, extra) {
  const s = flightSnapshot(state);
  if (!s) return null;
  if (extra) Object.assign(s, extra);
  store(s);
  return s;
}
/** The page is going away normally (navigation, close, bfcache): an unannounced restart must not resume. */
export function markSnapshotClosed() { const s = load(); if (s && s.alive) { s.alive = false; store(s); } }
export function markSnapshotAlive() { const s = load(); if (s && !s.alive && !s.reason) { s.alive = true; store(s); } }

/**
 * The snapshot to resume at startup, or null: after our own reload (?resume=1) or when the previous page of this tab
 * died without unloading (tab crash). `crash` tells the caller to treat it as a graphics failure too.
 */
function navigationType() {
  try { return (performance.getEntriesByType('navigation')[0] || {}).type || ''; } catch { return ''; }
}

export function readResume(params, navType = navigationType()) {
  const s = load();
  if (!s || s.v !== 1 || !Number.isFinite(s.x) || !s.aircraft) return null;
  const age = Date.now() - (s.t || 0);
  if (params.get('resume') === '1') return age < MAX_AGE ? { ...s, crash: false } : null;
  // A killed or discarded tab comes back as a *reload*. A new tab opened from the game (window.open, target=_blank,
  // "Duplicate tab") gets a copy of sessionStorage too but navigates normally: it must not take over the other tab's flight.
  if (navType !== 'reload') return null;
  if (s.alive && s.hidden && age < HIDDEN_AGE) return { ...s, crash: false, background: true };   // discarded in the background
  if (s.alive && age < CRASH_AGE) return { ...s, crash: true };
  return null;
}

/** Start definition for flight.reset / the world focus. */
export function resumeStart(s) {
  const heading = fin(s.heading) * DEG;
  return s.onGround
    ? { id: s.spawn, x: s.x, z: s.z, heading }
    : { id: s.spawn, x: s.x, z: s.z, heading, altitude: s.y, speed: Math.max(30, fin(s.speed, 80)) };
}

/**
 * Put the flight back where the snapshot left it (after main.js loaded the world + aircraft): flight state, lever,
 * route, autopilot, camera. Returns a short Turkish summary.
 */
export function applyResume(state, s, { input } = {}) {
  const { flight: f, world } = state;
  const start = resumeStart(s);
  const fixedWing = typeof f.command === 'function' && f.spec && f.spec.category !== 'helicopter';
  const opts = fixedWing && !s.onGround ? {
    approach: false, flapIndex: s.flaps, gearDown: !!s.gear,
    verticalSpeed: Math.max(-12, Math.min(12, fin(s.vs))), bank: Math.max(-30, Math.min(30, fin(s.roll))),
  } : {};
  f.reset(start, world, opts);
  if (input && input.setThrottle) input.setThrottle(Number.isFinite(s.throttle) ? s.throttle : (f.throttle ?? 0));
  // route (remaining user points + approach), then the autopilot with the saved targets
  const route = state.navRoute, r = s.route;
  if (route && r) {
    try {
      route.clear();
      if (r.defaultAlt != null) route.setDefaultAlt(r.defaultAlt);
      if ((r.defaultSpd != null || r.defaultMach != null) && route.setDefaultSpeed) route.setDefaultSpeed({ ias: r.defaultSpd, mach: r.defaultMach });
      for (const p of r.user) {
        const w = route.add(p.x, p.z, { alt: p.alt ?? null });
        if (w && (p.spd != null || p.mach != null) && route.setSpeed) route.setSpeed(w.id, { ias: p.spd, mach: p.mach });
      }
      if (r.approach && world && world.runways) {
        const rw = findRunwayEnd(world.runways, r.approach.name);
        if (rw) {
          route.setApproach(rw, r.approach.category, {
            groundAt: (x, z) => { const h = world.getGroundHeight(x, z); return Number.isFinite(h) ? h : 0; },
            obstacleAt: world.getObstacleHeight ? (x, z) => world.getObstacleHeight(x, z) : null,
            bounds: (world.region && world.region.local) || undefined,
          });
          if (r.approachActive > 0 && !r.user.length) {
            const w = route.waypoints[r.approachActive];
            if (w) route.directTo(w.id);
          }
        }
      }
    } catch (e) { console.warn('[resume] route', e); }
  }
  if (s.ap && !s.onGround && f.command) {
    try {
      if (s.ap.lnav && f.engageNav) f.engageNav(); else f.command('autopilot');
      const A = f.autopilot;
      if (A && A.on) {
        if (Number.isFinite(s.ap.altitude)) A.altitude = s.ap.altitude;
        if (Number.isFinite(s.ap.heading) && !A.lnav) A.heading = s.ap.heading;
        if (Number.isFinite(s.ap.speed)) A.speed = s.ap.speed;
      }
    } catch (e) { console.warn('[resume] autopilot', e); }
  }
  if (s.camera && state.cameraRig && state.cameraRig.select) { try { state.cameraRig.select(s.camera); } catch { /* ignore */ } }
  return s.ap ? (s.ap.lnav ? 'otopilot rotada' : 'otopilot açık') : '';
}
