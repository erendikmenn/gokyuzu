// Route speeds (src/nav): what the autopilot flies along each leg, the automatic defaults per category and leg, Mach
// legs for fighters up high, and the aircraft limits the autothrottle respects. No DOM (tests/nav.test.mjs).
//
//   legSpeed(route, w, category, altM, out)   → out { ias (m/s CAS) | mach, auto, src: 'wpt' | 'default' | 'auto' }
//   iasOf(out, h)                              → CAS (m/s) at altitude h (Mach converted)
//   clampFixedWing(model, ias)                 → within VLS + 5 kt … VMO / MMO − 5 kt, VFE / VLE − 10 kt, present state
//   clampHeli(spec, ias)                       → 40 kt … the helicopter's cruise speed
// Speeds are stored on the waypoint (w.spd m/s IAS or w.mach) or as the route default (route.defaultSpd / defaultMach);
// null = automatic. Final approach legs (FAF, threshold, hover point) keep their procedure speeds.
import { casFromTas, tasFromMach } from '../flight/fixedwing-atmosphere.js';

const KT = 0.514444, FT = 0.3048;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Per category (knots unless noted): editing range and step, automatic cruise speed (low: below limitAlt ft, as
 * the 250 kt rule; high: above), Mach above machAbove ft, and the procedure speeds of the approach legs.
 */
export const ROUTE_SPEED = {
  airliner: { min: 160, max: 340, step: 10, low: 250, high: 290, limitAlt: 10000, machAbove: 28000, mach: 0.78, machMin: 0.6, machMax: 0.82, machStep: 0.01,
    app: { base: 210, if: 210, faf: 180, thr: 180 } },
  fighter: { min: 180, max: 550, step: 10, low: 350, high: 350, limitAlt: 0, machAbove: 25000, mach: 0.85, machMin: 0.6, machMax: 0.95, machStep: 0.05,
    app: { base: 250, if: 250, faf: 200, thr: 200 } },
  helicopter: { min: 40, max: 150, step: 10, low: 110, high: 110, limitAlt: 0, machAbove: 0,
    app: { base: 100, if: 80, hov: 60 } },
};
/** Waypoint kinds whose speed belongs to the final approach (not editable: the ILS / hover logic has priority). */
export const FIXED_SPEED_KINDS = new Set(['faf', 'thr', 'hov']);

/** Speed flown on the leg into waypoint w (altM: the leg's target altitude, for the automatic choice). */
export function legSpeed(route, w, category, altM, out = {}) {
  const P = ROUTE_SPEED[category] || ROUTE_SPEED.airliner;
  out.ias = NaN; out.mach = NaN; out.auto = false; out.src = 'wpt';
  if (!w) { out.auto = true; out.src = 'auto'; out.ias = P.low * KT; return out; }
  const fixed = FIXED_SPEED_KINDS.has(w.kind);
  if (!fixed) {
    if (w.mach != null) { out.mach = w.mach; return out; }
    if (w.spd != null) { out.ias = w.spd; return out; }
    if (w.kind === 'wpt') {
      out.src = 'default';
      if (route.defaultMach != null) { out.mach = route.defaultMach; return out; }
      if (route.defaultSpd != null) { out.ias = route.defaultSpd; return out; }
    }
  }
  out.auto = true; out.src = 'auto';
  if (w.kind !== 'wpt' && P.app[w.kind] != null) { out.ias = P.app[w.kind] * KT; return out; }
  return autoCruise(category, altM, out);
}

/** The automatic cruise speed of a category at a target altitude (250 kt below 10,000 ft for airliners). */
export function autoCruise(category, altM, out = {}) {
  const P = ROUTE_SPEED[category] || ROUTE_SPEED.airliner;
  const ft = (Number.isFinite(altM) ? altM : 0) / FT;
  out.ias = NaN; out.mach = NaN;
  if (P.machAbove && ft >= P.machAbove) out.mach = P.mach;
  else out.ias = (P.limitAlt && ft < P.limitAlt ? P.low : P.high) * KT;
  return out;
}

/** CAS (m/s) of a legSpeed result at altitude h (m). */
export function iasOf(s, h) {
  if (Number.isFinite(s.mach)) return casFromTas(tasFromMach(s.mach, Math.max(h, 0)), Math.max(h, 0));
  return s.ias;
}

/**
 * The autothrottle's target on a route, kept inside the present limits of a fixed-wing model: at least VLS + 5 kt,
 * at most VMO / MMO (as IAS at the present Mach) − 5 kt and VFE of the extended flaps / VLE with the gear out − 10 kt
 * (the autothrust overshoots a few knots when it accelerates; past VFE + 3 kt the flap load relief would retract).
 */
export function clampFixedWing(m, ias) {
  const V = m.vSpeeds || {}, L = (m.spec && m.spec.limits) || {};
  let hi = (V.vmo || L.vmo || 180) - 5 * KT;
  if (L.mmo && m.mach > 0.2 && m.ias > 10) hi = Math.min(hi, (L.mmo * m.ias) / m.mach - 5 * KT);
  // flap detent position (the A320's CONF 1 is slats only: flaps = 0 but a VFE of 230 kt)
  const flapOut = m.sys ? m.sys.flapPos > 0.05 : m.flaps > 0.02;
  if (flapOut && V.vfe > 0) hi = Math.min(hi, V.vfe - 10 * KT);
  if (m.gear > 0.02 && (V.vle || L.vle)) hi = Math.min(hi, (V.vle || L.vle) - 10 * KT);
  const lo = (V.vls || 0) + 5 * KT;
  return clamp(ias, lo, Math.max(lo, hi));
}

/** Helicopter route speed: 40 kt (forward flight) … the cruise speed (≈ 150 kt, well inside VNE). */
export function clampHeli(spec, ias) {
  const P = ROUTE_SPEED.helicopter;
  const hi = Math.min(P.max * KT, (spec && spec.cruiseSpeed) || P.max * KT, (spec && spec.vne ? spec.vne * 0.8 : Infinity));
  return clamp(ias, P.min * KT, hi);
}

/** Label: "250 kt" / "M0.85" (Turkish thousands separator not needed below 1,000 kt). */
export function speedLabel(s) {
  return Number.isFinite(s.mach) ? `M${s.mach.toFixed(2)}` : `${Math.round(s.ias / KT)} kt`;
}
