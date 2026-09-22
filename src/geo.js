// Local game frame: UTM 10N (EPSG:32610) minus the SFO origin. x = east, z = -north, y = meters MSL.
// Same constants as data/sf/region.json and tools/geo/geo.py. The lat/lon helpers here are local
// approximations (good to ~1 m inside the map) for display/UI only; pipelines use pyproj.
export const REGION = {
  origin: { lon: -122.374889, lat: 37.618972 },
  originUTM: [555166.105, 4163724.242],
  bounds: { minX: -16467, maxX: 20799, minZ: -28016, maxZ: 7745 },
};

const R = 6378137;
const k0 = 0.9996;
const lat0 = REGION.origin.lat * Math.PI / 180;
// UTM grid convergence at the origin (grid north vs true north), degrees
const zoneLon0 = -123;
const gamma = Math.atan(Math.tan((REGION.origin.lon - zoneLon0) * Math.PI / 180) * Math.sin(lat0));
const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0) + 1.175 * Math.cos(4 * lat0);
const mPerDegLon = 111412.84 * Math.cos(lat0) - 93.5 * Math.cos(3 * lat0);

export function lonLatToLocal(lon, lat) {
  const east = (lon - REGION.origin.lon) * mPerDegLon * k0;
  const north = (lat - REGION.origin.lat) * mPerDegLat * k0;
  const c = Math.cos(gamma), s = Math.sin(gamma);
  const gx = east * c - north * s;
  const gy = east * s + north * c;
  return { x: gx, z: -gy };
}

export function localToLonLat(x, z) {
  const c = Math.cos(gamma), s = Math.sin(gamma);
  const gx = x, gy = -z;
  const east = gx * c + gy * s;
  const north = -gx * s + gy * c;
  return { lon: REGION.origin.lon + east / (mPerDegLon * k0), lat: REGION.origin.lat + north / (mPerDegLat * k0) };
}

export const deg = (r) => r * 180 / Math.PI;
export const rad = (d) => d * Math.PI / 180;
/** Heading (radians, 0 = north/-Z, clockwise) of the direction vector (dx, dz). */
export const headingOf = (dx, dz) => Math.atan2(dx, -dz);
