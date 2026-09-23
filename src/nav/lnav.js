// LNAV: lateral guidance along a Route (src/nav/route.js) for the fixed-wing autopilot and the helicopter AFCS.
//
//   const lnav = createLnav();
//   lnav.update(route, S, dt)   S: { x, z, vx, vz, alt, hdg (rad), category, bankMax (rad), rollTime (s to reach it), onGround }
//   lnav.out                     guidance (reused object, never reallocated):
//     valid        a leg is being followed           index / count / name   active waypoint (0-based) / total / label
//     dist, brg    direct distance (m) / true bearing (deg) to the active waypoint
//     course       true course of the active leg (deg)                        xtk  cross-track error (m, + = right)
//     trackCmd     commanded true track (rad): asymptotic intercept of the leg (≤ 45°), turns anticipated (fly-by)
//     alt          altitude target (m MSL) or NaN (keep)                      speed  speed target (m/s) or NaN (keep)
//     phase        '' | 'enroute' | 'approach' | 'final' | 'hover' | 'done'
//     appArm       fixed wing: the ILS logic may capture `rw` (the selected runway end) now
//     hover        helicopter: fly to (hx, hz) and hover there at hAlt (m MSL)
//     seq          increments when a waypoint is sequenced (AP: new altitude target)
//
// Lateral law: the leg is intercepted with a lateral closure speed of −xtk/τ (τ per category, capped at 45° to the
// leg), and the next leg becomes active R·tan(Δψ/2) before the waypoint (R = turn radius at the bank limit), so the
// turn rolls out on the new leg. The host turns trackCmd into bank with its heading law. No allocations per update.
import { courseTo, NM } from './route.js';

const G = 9.81, DEG = Math.PI / 180, KT = 0.514444;
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); return a < 0 ? a + Math.PI : a - Math.PI; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Per category: intercept time constant τ (s), default bank limit, approach speeds (m/s), helicopter cruise/decel. */
export const LNAV = {
  airliner: { tau: 18, bank: 25, maxIntercept: 45, ifSpeed: 210 * KT, finalSpeed: 180 * KT, slowFrom: 12 * NM },
  fighter: { tau: 12, bank: 45, maxIntercept: 45, ifSpeed: 250 * KT, finalSpeed: 200 * KT, slowFrom: 12 * NM },
  helicopter: { tau: 10, bank: 20, maxIntercept: 50, cruise: 110 * KT, decel: 0.75, hoverRange: 120 },
};

export function createLnav() {
  const out = {
    valid: false, index: 0, count: 0, name: '', kind: '', dist: 0, brg: 0, course: 0, xtk: 0, along: 0, legLength: 0,
    trackCmd: 0, alt: NaN, speed: NaN, phase: '', appArm: false, rw: null, hover: false, hx: 0, hz: 0, hAlt: NaN,
    remaining: 0, seq: 0, finished: false, route: null, turnRadius: 0,
  };
  let lastSeq = -1, lastVersion = -1, legStartAlt = NaN;

  function computeLeg(route, S) {
    const B = route.waypoints[route.active];
    const A = route.legFrom();
    let c;
    const L = Math.hypot(B.x - A.x, B.z - A.z);
    if (L > 1) c = courseTo(A.x, A.z, B.x, B.z);
    else c = courseTo(S.x, S.z, B.x, B.z);
    const dx = Math.sin(c), dz = -Math.cos(c);
    const rx = S.x - A.x, rz = S.z - A.z;
    out.along = rx * dx + rz * dz;
    out.xtk = rx * -dz + rz * dx;
    out.legLength = L;
    out.course = c;
    return B;
  }

  function update(route, S, dt) {
    out.route = route;
    const cat = S.category || 'airliner';
    const P = LNAV[cat] || LNAV.airliner;
    const gs = Math.hypot(S.vx, S.vz);
    const track = gs > 3 ? Math.atan2(S.vx, -S.vz) : S.hdg;
    if (!route) { out.valid = false; out.phase = ''; return out; }
    route.setPosition(S.x, S.z, track);
    out.finished = route.finished;
    if (!route.hasActive) {
      out.valid = false; out.appArm = false; out.hover = false; out.count = route.length;
      out.phase = route.finished && route.length ? 'done' : '';
      return out;
    }
    const bankMax = S.bankMax || P.bank * DEG;
    const R = (Math.max(gs, cat === 'helicopter' ? 20 : 50) ** 2) / (G * Math.tan(bankMax));
    out.turnRadius = R;
    const W = route.waypoints;
    let B = computeLeg(route, S);
    // ---- sequencing (fly-by with turn anticipation; abeam passage; the helicopter's last point is a hover)
    for (let guard = 0; guard < 4 && route.hasActive; guard++) {
      const i = route.active, next = W[i + 1];
      const toGo = out.legLength - out.along;
      let dTA = 0;
      if (next && !B.flyover) {
        const c2 = courseTo(B.x, B.z, next.x, next.z);
        const d = Math.abs(wrapPi(c2 - out.course));
        // turn radius at the bank limit + the distance flown while rolling into the bank
        // plus the roll-out band of a proportional heading law (bank = K·Δψ below bankMax/K): the last part of the
        // turn widens, so the turn starts a little earlier (S.headingGain = K)
        let lead = d > 8 * DEG ? gs * (S.rollTime || 0) * 0.5 : 0;
        if (S.headingGain > 0) {
          const eb = Math.min(bankMax / S.headingGain, d);
          lead += Math.max(0, (gs * gs * eb) / (G * S.headingGain) - R * (1 - Math.cos(eb))) * Math.sin(Math.min(d, Math.PI / 2));
        }
        dTA = Math.min(R * Math.tan(Math.min(d, 120 * DEG) / 2) + lead, 0.9 * Math.hypot(next.x - B.x, next.z - B.z));
      }
      const lastHover = cat === 'helicopter' && !next;
      if (lastHover) break;
      const near = Math.abs(out.xtk) < 2.5 * R + 1500;
      if ((toGo <= dTA && near) || toGo <= 0) {
        route.sequence();
        if (!route.hasActive) break;
        B = computeLeg(route, S);
      } else break;
    }
    if (!route.hasActive) {
      out.valid = false; out.appArm = false; out.hover = false; out.finished = true; out.phase = 'done'; out.seq = route.seq;
      return out;
    }
    if (route.seq !== lastSeq || route.version !== lastVersion) {
      if (route.seq !== lastSeq) legStartAlt = S.alt;
      if (!Number.isFinite(legStartAlt)) legStartAlt = S.alt;
      lastSeq = route.seq; lastVersion = route.version;
    }
    out.seq = route.seq;
    out.valid = true;
    out.index = route.active; out.count = W.length;
    out.name = B.name; out.kind = B.kind;
    out.dist = Math.hypot(B.x - S.x, B.z - S.z);
    out.brg = ((courseTo(S.x, S.z, B.x, B.z) / DEG) % 360 + 360) % 360;
    out.remaining = route.remaining();
    // ---- lateral: closure speed −xtk/τ, at most maxIntercept to the leg
    const gsRef = Math.max(gs, 20);
    const vMax = gsRef * Math.sin(P.maxIntercept * DEG);
    const vLat = clamp(-out.xtk / P.tau, -vMax, vMax);
    out.trackCmd = out.course + Math.asin(clamp(vLat / gsRef, -0.95, 0.95));
    // ---- vertical / speed targets and phase
    out.alt = B.kind === 'thr' ? NaN : route.altFor(B) ?? NaN;   // the threshold: the glide slope takes over
    out.speed = NaN;
    out.appArm = false; out.rw = null; out.hover = false;
    const onApp = route.onApproach;
    out.phase = onApp ? 'approach' : 'enroute';
    if (cat === 'helicopter') {
      const last = !W[route.active + 1];
      const dEnd = out.remaining;
      out.speed = Math.min(P.cruise, Math.max(2.5, Math.sqrt(2 * P.decel * Math.max(dEnd - 15, 0))));
      if (last) {
        // final leg: descend on a straight path toward the hover point, then hover there
        const Af = route.legFrom();
        const a0 = Number.isFinite(route.altFor(Af)) ? route.altFor(Af) : legStartAlt;
        if (B.kind === 'hov' && Number.isFinite(a0)) {
          const f = out.legLength > 1 ? clamp((out.legLength - out.along) / out.legLength, 0, 1) : 0;
          out.alt = B.alt + (a0 - B.alt) * f;
        }
        out.hover = out.dist < P.hoverRange || (out.dist < 400 && gs < 12);
        out.hx = B.x; out.hz = B.z; out.hAlt = route.altFor(B) ?? NaN;   // NaN: hover at the present altitude
        if (out.hover) out.phase = 'hover';
      }
    } else if (onApp) {
      const rw = route.approach.rw;
      if (B.kind === 'faf' || B.kind === 'thr') { out.appArm = true; out.rw = rw; out.phase = 'final'; out.speed = P.finalSpeed; }
      else if (out.remaining - distAfterIf(route) < P.slowFrom || B.kind === 'if') out.speed = P.ifSpeed;
    }
    return out;
  }

  /** Distance along the route from the IF to the end (so the deceleration starts `slowFrom` before the IF). */
  function distAfterIf(route) {
    const W = route.waypoints;
    let k = -1;
    for (let i = route.active; i < W.length; i++) if (W[i].kind === 'if') { k = i; break; }
    if (k < 0) return 0;
    let d = 0;
    for (let i = k + 1; i < W.length; i++) d += Math.hypot(W[i].x - W[i - 1].x, W[i].z - W[i - 1].z);
    return d;
  }

  function reset() { lastSeq = -1; lastVersion = -1; legStartAlt = NaN; out.valid = false; out.phase = ''; }

  return { out, update, reset };
}
