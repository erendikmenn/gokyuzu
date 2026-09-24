// UTM (WGS 84, northern hemisphere) for src/geo.js on maps other than San Francisco: the transverse Mercator series of
// Snyder (1987), sub-metre over a map (checked against pyproj). Part of the map modules' lazy chunks.
const R = 6378137, k0 = 0.9996;
const E2 = 0.00669437999014, EP2 = E2 / (1 - E2);
const M1 = 1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256, M2 = 3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 ** 3 / 1024;
const M3 = 15 * E2 * E2 / 256 + 45 * E2 ** 3 / 1024, M4 = 35 * E2 ** 3 / 3072;
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

/** Projection of a region.json crs 'EPSG:326NN' (zone NN, central meridian 6·NN − 183°): { fwd(lon, lat) → [e, n], inv(e, n) → { lon, lat } }. */
export function createUtm(crs) {
  const zone = Number((/^EPSG:326(\d\d)$/.exec(crs || '') || [])[1]) || 10;
  const utmLon0 = (zone * 6 - 183) * Math.PI / 180;
  /** [easting, northing] of lon/lat (deg), northern hemisphere. */
  function fwd(lon, lat) {
    const p = lat * Math.PI / 180, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
    const N = R / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, A = (lon * Math.PI / 180 - utmLon0) * c;
    const M = R * (M1 * p - M2 * Math.sin(2 * p) + M3 * Math.sin(4 * p) - M4 * Math.sin(6 * p));
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * A ** 5 / 120);
    const y = k0 * (M + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * A ** 6 / 720));
    return [x + 500000, y];
  }
  /** lon/lat (deg) of an easting / northing. */
  function inv(e, n) {
    const mu = n / k0 / (R * M1);
    const p1 = mu + (3 * E1 / 2 - 27 * E1 ** 3 / 32) * Math.sin(2 * mu) + (21 * E1 * E1 / 16 - 55 * E1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * E1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * E1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1), C = EP2 * c * c, T = t * t, q = 1 - E2 * s * s;
    const N = R / Math.sqrt(q), Rm = R * (1 - E2) / q ** 1.5, D = (e - 500000) / (N * k0);
    const lat = p1 - (N * t / Rm) * (D * D / 2 - (5 + 3 * T + 10 * C - 4 * C * C - 9 * EP2) * D ** 4 / 24
      + (61 + 90 * T + 298 * C + 45 * T * T - 252 * EP2 - 3 * C * C) * D ** 6 / 720);
    const lon = utmLon0 + (D - (1 + 2 * T + C) * D ** 3 / 6 + (5 - 2 * C + 28 * T - 3 * C * C + 8 * EP2 + 24 * T * T) * D ** 5 / 120) / c;
    return { lon: lon * 180 / Math.PI, lat: lat * 180 / Math.PI };
  }
  return { fwd, inv };
}
