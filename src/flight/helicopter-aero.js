// Helicopter aerodynamics helpers (pure functions, no allocations, no DOM): ISA atmosphere, rotor induced velocity
// (momentum theory + Glauert forward-flight inflow + empirical vortex-ring-state curve), ground effect, lifting surfaces.
//
// Conventions: SI units. "Inflow" is positive when air passes DOWN through the rotor disc (normal working state).

export const G = 9.80665;
export const RHO0 = 1.225;
export const DEG = Math.PI / 180;
export const KT = 0.514444;          // m/s per knot
export const SHP = 745.7;            // W per shaft horsepower

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const moveToward = (v, target, maxDelta) => (Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta);
export const wrapPi = (a) => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

/** International Standard Atmosphere (troposphere + lower stratosphere). Writes { rho, T, a, sigma } into `out`. */
export function isa(h, out) {
  const hh = clamp(h, -500, 20000);
  let T, rho;
  if (hh <= 11000) {
    T = 288.15 - 0.0065 * hh;
    rho = RHO0 * Math.pow(T / 288.15, 4.2559);
  } else {
    T = 216.65;
    rho = 0.36392 * Math.exp(-(hh - 11000) / 6341.6);
  }
  out.rho = rho;
  out.T = T;
  out.a = Math.sqrt(1.4 * 287.053 * T);
  out.sigma = rho / RHO0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Induced velocity. All values are normalized by the hover induced velocity v_h = sqrt(T / (2 rho A)).
//   x = climb (through-disc) velocity / v_h   (positive = air entering from above)
//   m = in-plane (edgewise) velocity / v_h
// Returns v_i / v_h including the induced power factor KAPPA (non-uniform inflow, tip losses).
// ---------------------------------------------------------------------------------------------
export const KAPPA = 1.15;
// Johnson's empirical fit for the vortex-ring / turbulent-wake region (-2 < x < 0), Helicopter Theory.
const VRS_K = [KAPPA, -1.125, -1.372, -1.718, -0.655];

/** Largest root of v * sqrt(m^2 + (x + v)^2) = 1 (Glauert, helicopter branch). */
export function glauert(x, m) {
  let v = Math.max(1, -x) + 1;   // start above the largest root: Newton then descends monotonically
  for (let i = 0; i < 30; i++) {
    const w = x + v;
    const s = Math.sqrt(m * m + w * w);
    const g = v * s - 1;
    const dg = s + (v * w) / Math.max(s, 1e-9);
    let dv = g / (Math.abs(dg) > 1e-9 ? dg : 1e-9);
    if (v - dv < 1e-5) dv = v * 0.5;        // stay positive
    v -= dv;
    if (Math.abs(dv) < 1e-9) break;
  }
  return v;
}

/** Axial-flight induced velocity: momentum theory in climb and windmill states, empirical curve in the vortex ring state. */
export function axialInduced(x) {
  if (x >= 0) return KAPPA * (-x / 2 + Math.sqrt(x * x / 4 + 1));
  if (x <= -2) return KAPPA * (-x / 2 - Math.sqrt(x * x / 4 - 1));
  const [k0, k1, k2, k3, k4] = VRS_K;
  return k0 + x * (k1 + x * (k2 + x * (k3 + x * k4)));
}

/**
 * v_i / v_h for any combination of climb/descent (x) and edgewise speed (m). Forward speed sweeps the wake away:
 * above m ~ 1.3 pure Glauert, at low speed in descent the empirical vortex-ring curve (scaled by the forward-speed
 * reduction so it is continuous at x = 0).
 */
export function inducedRatio(x, m) {
  const vg = KAPPA * glauert(x, m);
  if (x >= 0) return vg;
  const w = smoothstep(0.35, 1.3, m);
  if (w >= 1) return vg;
  const ve = axialInduced(x) * glauert(0, m);
  return ve + (vg - ve) * w;
}

/**
 * Ground effect: induced-velocity (= induced power at constant thrust) ratio IGE/OGE, Hayden's fit to flight data,
 * faded out as forward speed sweeps the wake behind the rotor. z = rotor hub height above the surface.
 */
export function groundEffect(z, R, u, vh) {
  const zz = Math.max(z, 0.35 * R);
  const k = Math.min(1, 1 / (0.9926 + 0.0379 * (2 * R / zz) ** 2));
  if (k >= 1) return 1;
  const s = u / Math.max(vh, 1);
  return 1 - (1 - k) * Math.exp(-0.8 * s * s);
}

// ---------------------------------------------------------------------------------------------
// Lifting surface section coefficients over the full +-180 deg range (stabilator, fin).
// ---------------------------------------------------------------------------------------------
/** Writes { cl, cd } into out for angle of attack alpha (rad, any value). */
export function surfaceCoefficients(alpha, clAlpha, alphaStall, aspect, out) {
  const a = wrapPiLocal(alpha);
  const aa = Math.abs(a);
  const plateCl = 1.1 * Math.sin(2 * a);
  const plateCd = 0.05 + 1.25 * Math.sin(a) ** 2;
  if (aa <= alphaStall) {
    out.cl = clAlpha * a;
    out.cd = 0.012 + (out.cl * out.cl) / (Math.PI * aspect * 0.8);
  } else if (aa >= Math.PI - alphaStall) {
    // reversed flow: weak lifting surface
    const ar = a > 0 ? a - Math.PI : a + Math.PI;
    out.cl = 0.6 * clAlpha * ar;
    out.cd = 0.03 + (out.cl * out.cl) / (Math.PI * aspect * 0.6);
  } else {
    // post stall: blend quickly from the linear value at the stall to the flat plate
    const edge = aa < Math.PI / 2 ? alphaStall : Math.PI - alphaStall;
    const t = smoothstep(0, 0.12, Math.abs(aa - edge));
    const linCl = aa < Math.PI / 2 ? clAlpha * alphaStall * Math.sign(a) : 0.6 * clAlpha * alphaStall * -Math.sign(a);
    out.cl = lerp(linCl * 0.85, plateCl, t);
    out.cd = lerp(0.05, plateCd, t) + (aa < Math.PI / 2 ? 0 : 0.02);
  }
  return out;
}
function wrapPiLocal(a) { return a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a; }

/** Solve a small dense linear system A x = b in place (Gaussian elimination, partial pivoting). Returns false if singular. */
export function solveLinear(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) return false;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * b[k];
    b[r] = s / A[r * n + r];
  }
  return true;
}
