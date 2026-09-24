// Local game frame of the active map: UTM (zone from the map's region.json "crs") minus the map's origin. x = east,
// z = -north, y = meters MSL. San Francisco (default): UTM 10N (EPSG:32610) minus the SFO origin, the constants of
// data/sf/region.json and tools/geo/geo.py, with local approximations (good to ~1 m near the city) for display/UI only.
// Other maps call setGeoRegion(region.json, utm) when they become active (src/maps/index.js), with the transverse
// Mercator series of src/maps/utm.js (sub-metre over a map). Pipelines use pyproj.
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

let utm = null;   // another map's projection (setGeoRegion)

/**
 * Switch the frame to another map's region.json ({ crs, origin, originUTM, local }) projected by `u` (src/maps/utm.js
 * createUtm(crs): fwd(lon, lat) → [e, n], inv(e, n) → { lon, lat }). REGION is updated in place (modules keep their
 * reference to it and its bounds).
 */
export function setGeoRegion(region, u) {
  utm = u;
  REGION.origin = { lon: region.origin.lon, lat: region.origin.lat };
  REGION.originUTM = region.originUTM;
  Object.assign(REGION.bounds, region.local);
}

export function lonLatToLocal(lon, lat) {
  if (utm) { const [e, n] = utm.fwd(lon, lat); return { x: e - REGION.originUTM[0], z: REGION.originUTM[1] - n }; }
  const east = (lon - REGION.origin.lon) * mPerDegLon * k0;
  const north = (lat - REGION.origin.lat) * mPerDegLat * k0;
  const c = Math.cos(gamma), s = Math.sin(gamma);
  const gx = east * c - north * s;
  const gy = east * s + north * c;
  return { x: gx, z: -gy };
}

export function localToLonLat(x, z) {
  if (utm) return utm.inv(x + REGION.originUTM[0], REGION.originUTM[1] - z);
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
