// W4 airports: buildings (terminals, piers, hangars, garages, towers, jet bridges, military structures) from the
// Blender-built GLB assets/sf/airports/<icao>_buildings.glb. Every top-level node is one building whose origin sits on
// its footprint anchor at ground level; at runtime each node is dropped on the terrain, then all meshes are merged per
// material (few draw calls). Night: window materials (userData / name containing "glass" or "win") glow.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isNetworkError } from '../core/assets.js';

const BASE = 'assets/sf/airports/';
let manifestP = null;
export function assetManifest(loader) {
  if (!manifestP) {
    manifestP = loader.loadJSON(BASE + 'manifest.json').catch((e) => {
      if (isNetworkError(e)) { manifestP = null; throw e; }   // connection lost: asked again by the next caller
      return {};                                              // not built: fallback extrusions
    });
  }
  return manifestP;
}

export async function loadBuildings(meta, ctx, colliders) {
  const icao = meta.icao.toLowerCase();
  const man = await assetManifest(ctx.loader);
  const file = man.buildings && man.buildings[icao];
  const root = new THREE.Group();
  root.name = `apt-buildings-${meta.icao}`;
  const [ox, oz] = meta.origin;
  root.position.set(ox, 0, oz);
  let emissive = [];
  const drapeGroups = [];
  if (file) {
    const gltf = await ctx.loader.loadGLTF(BASE + file);
    const merged = groundAndMerge(gltf.scene, meta, ctx, { groups: drapeGroups });
    for (const m of merged) root.add(m);
    emissive = collectEmissive(merged);
  } else {
    const m = fallbackExtrusions(meta, ctx);
    root.add(m);
  }
  void colliders;
  return { object: root, emissive, lastDay: -1, drapeGroups };
}

/** Drop every top-level node onto the terrain (its origin = footprint anchor), then merge meshes by material. */
export function groundAndMerge(scene, meta, ctx, { castShadow = true, groups = null } = {}) {
  const [ox, oz] = meta.origin;
  const byMat = new Map();
  scene.updateMatrixWorld(true);
  const nodeInfo = [];
  for (const node of scene.children.slice()) {
    const ax = node.position.x, az = node.position.z;
    const g = ctx.terrain.getHeight(ax + ox, az + oz);
    node.position.y += g;
    node.updateMatrixWorld(true);
    const info = { ax: ax + ox, az: az + oz, g, ranges: [] };
    nodeInfo.push(info);
    node.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      if (Array.isArray(o.material)) {
        // split multi-material meshes by group
        for (const grp of geo.groups) {
          const sub = subGeometry(geo, grp.start, grp.count);
          push(byMat, mats[grp.materialIndex], sub, info);
        }
      } else push(byMat, o.material, geo, info);
    });
  }
  const out = [];
  for (const [mat, entries] of byMat) {
    const norm = entries.map((e) => normalizeGeo(e.geo));
    const merged = mergeGeometries(norm, false);
    if (!merged) continue;
    let start = 0;
    norm.forEach((g, k) => {
      const count = g.attributes.position.count;
      entries[k].info.ranges.push([merged, start, count]);
      start += count;
    });
    merged.computeBoundingSphere();
    const m = new THREE.Mesh(merged, mat);
    m.name = `apt-bld-${mat.name || 'mat'}`;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    out.push(m);
  }
  if (groups) groups.push(...nodeInfo.filter((n) => n.ranges.length));
  return out;
}

function push(map, mat, geo, info) {
  if (!map.has(mat)) map.set(mat, []);
  map.get(mat).push({ geo, info });
}

function subGeometry(geo, start, count) {
  const g = geo.index ? geo.clone() : geo.clone();
  if (g.index) {
    const idx = g.index.array.slice(start, start + count);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.clearGroups();
  return g;
}

function normalizeGeo(g) {
  let geo = g.index ? g : g;
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  } else if (!(geo.index.array instanceof Uint32Array)) {
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(geo.index.array), 1));
  }
  geo.morphAttributes = {};
  return geo;
}

function collectEmissive(meshes) {
  const out = [];
  for (const m of meshes) {
    const mat = m.material;
    if (mat.emissiveMap || /glass|win|night|lamp|light/i.test(mat.name)) {
      const NIGHT = { fac_terminal: 1.1, fac_glass: 1.0, fac_office: 1.2, fac_garage: 1.0, fac_mil_stucco: 1.0, glass_cab: 0.8 };
      mat.userData.nightMax = mat.userData.nightMax ?? NIGHT[mat.name] ?? (mat.emissiveMap ? 1.2 : 1.0);
      if (!mat.emissiveMap && mat.emissive && mat.emissive.getHex() === 0) mat.emissive.set(0xffc98a);
      out.push(mat);
    }
  }
  return out;
}

export function updateBuildingLights(b, day, dist, cam) {
  const v = Math.round((1 - day) * 50) / 50;
  if (v === b.lastDay) return;
  b.lastDay = v;
  for (const mat of b.emissive) mat.emissiveIntensity = v * mat.userData.nightMax;
  void dist; void cam;
}

// ---------------------------------------------------------------- fallback (before the Blender GLB exists)
const COLORS = { terminal: 0xc9ccd0, pier: 0xd4d7da, hangar: 0xe2e3e0, garage: 0xa9a7a0, tower_cab: 0x6c7e8c, office: 0xb8b4aa,
  industrial: 0xbcb6a8, service: 0xb0aa9c, hotel: 0xc8c0b0, station: 0xc0c4c8, cargo: 0xc4c0b4, fire: 0xb86a52 };

function fallbackExtrusions(meta, ctx) {
  const [ox, oz] = meta.origin;
  const groups = new Map();
  for (const b of meta.buildings || []) {
    const g = ctx.terrain.getHeight(b.anchor[0] + ox, b.anchor[1] + oz);
    const geo = extrude(b.poly, b.holes || [], g + (b.minh || 0) - (b.minh ? 0 : 2), g + b.h);
    if (!geo) continue;
    const col = COLORS[b.kind] || 0xbbbbbb;
    if (!groups.has(col)) groups.set(col, []);
    groups.get(col).push(geo);
  }
  const grp = new THREE.Group();
  for (const [col, geos] of groups) {
    const m = new THREE.Mesh(mergeGeometries(geos.map(normalizeGeo)), new THREE.MeshStandardMaterial({ color: col, roughness: 0.8, side: THREE.DoubleSide }));
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
  }
  return grp;
}

export function extrude(poly, holes, y0, y1) {
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
  if (contour.length < 3) return null;
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const hs = holes.map((h) => { const v = h.map(([x, z]) => new THREE.Vector2(x, z)); if (!THREE.ShapeUtils.isClockWise(v)) v.reverse(); return v; });
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  const all = contour.concat(...hs);
  const pos = [], idx = [];
  for (const p of all) pos.push(p.x, y1, p.y);
  for (const t of tris) idx.push(t[0], t[2], t[1]);
  const ring = (pts, flip) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const k = pos.length / 3;
      pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y1, b.y, a.x, y1, a.y);
      if (flip) idx.push(k, k + 2, k + 1, k, k + 3, k + 2); else idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    }
  };
  ring(contour, true);
  for (const h of hs) ring(h, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const ng = geo.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}
