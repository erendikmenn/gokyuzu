// International Standard Atmosphere (ISA, troposphere + lower stratosphere) and airspeed conversions.
// All SI: meters, m/s, Pa, K, kg/m^3.
import { clamp, G0 } from './fixedwing-util.js';

export const R_AIR = 287.053;
export const GAMMA = 1.4;
export const P0 = 101325;
export const T0 = 288.15;
export const RHO0 = 1.225;
export const A0 = Math.sqrt(GAMMA * R_AIR * T0); // 340.29 m/s

/** Fills `out` with { T, p, rho, a, sigma, theta, delta } at geometric altitude h (m MSL). */
export function isa(h, out = {}) {
  h = clamp(h, -1000, 32000);
  let T, p;
  if (h < 11000) {
    T = T0 - 0.0065 * h;
    p = P0 * Math.pow(T / T0, 5.255877);
  } else if (h < 20000) {
    T = 216.65;
    p = 22632.06 * Math.exp((-G0 * (h - 11000)) / (R_AIR * T));
  } else {
    T = 216.65 + 0.001 * (h - 20000);
    p = 5474.889 * Math.pow(T / 216.65, -34.1632);
  }
  out.T = T;
  out.p = p;
  out.rho = p / (R_AIR * T);
  out.a = Math.sqrt(GAMMA * R_AIR * T);
  out.sigma = out.rho / RHO0;
  out.theta = T / T0;
  out.delta = p / P0;
  return out;
}

/** Impact pressure qc (Pa) for Mach M at static pressure p (subsonic isentropic / Rayleigh pitot above M 1). */
export function impactPressure(M, p) {
  if (M <= 1) return p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return p * ((166.92158 * Math.pow(M, 7)) / Math.pow(7 * M * M - 1, 2.5) - 1);
}

/** Mach number whose impact pressure at static pressure p equals qc. */
export function machFromImpact(qc, p) {
  const r = qc / p;
  if (r <= Math.pow(1.2, 3.5) - 1) return Math.sqrt(5 * (Math.pow(r + 1, 2 / 7) - 1));
  let M = 1.2;
  for (let i = 0; i < 12; i++) M = 0.881285 * Math.sqrt((r + 1) * Math.pow(1 - 1 / (7 * M * M), 2.5));
  return M;
}

const _a = {};
/** Calibrated airspeed (≈ IAS) from true airspeed at altitude h. */
export function casFromTas(tas, h) {
  const s = isa(h, _a);
  const M = Math.max(0, tas) / s.a;
  const qc = impactPressure(M, s.p);
  return A0 * machFromImpact(qc, P0);
}

/** True airspeed from calibrated airspeed at altitude h. */
export function tasFromCas(cas, h) {
  const s = isa(h, _a);
  const qc = impactPressure(Math.max(0, cas) / A0, P0);
  return machFromImpact(qc, s.p) * s.a;
}

/** True airspeed for a Mach number at altitude h. */
export function tasFromMach(M, h) { return M * isa(h, _a).a; }
