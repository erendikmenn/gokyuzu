// W4 airports: parked aircraft at stands, ground service vehicles, windsocks and flood masts.
// Models: assets/sf/airports/props.glb (blender/airports/build_props.py): top-level nodes = prop types, origin on the
// ground (aircraft: nose-wheel contact point, nose -Z). All props.glb parts share one vertex-coloured material and are
// drawn by ONE BatchedMesh per airport (per-instance livery colour on the tails, per-instance visibility for LOD).
// The aircraft agents' LOD models (model.lodUrl) replace the props LODs for the aircraft closest to the camera; their
// untextured materials are collapsed into one vertex-coloured part so each agent LOD costs only a few draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isNetworkError } from '../core/assets.js';
import { airportFiles } from './airports_ground.js';

const ROOT = new URL('../../', import.meta.url).href;
const NEAR_DIST = 900;
const NEAR_TRI_BUDGET = 0.7e6;

// ---------------------------------------------------------------- deterministic RNG
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
/** Uniform [0, 1) from a position (quantized to 25 cm) and a type name: the same stand keeps its rank whatever the list. */
function stableRank(x, z, type) {
  let h = Math.imul(Math.round(x * 4), 73856093) ^ Math.imul(Math.round(z * 4), 19349663);
  for (let k = 0; k < type.length; k++) h = Math.imul(h ^ type.charCodeAt(k), 16777619);
  const r = rng(h >>> 0);
  r();
  return r();
}

// generic livery tail colours (sRGB hex) — no logos, only colour schemes
const TAILS_NARROW = ['#1b3a78', '#0e2a5a', '#0b6f78', '#7a1422', '#1f4fb0', '#f0b21a', '#e9ecef', '#0d1d44', '#3b73c4', '#1a1a1d', '#7fa6cf', '#1e5c3a'];
const TAILS_WIDE = ['#b3121c', '#0d1d44', '#e9ecef', '#1b3a78', '#006654', '#1a1a1d', '#8a1a2c', '#7fa6cf', '#c8102e', '#274b8c'];

// aircraft metrics for placement / collisions (along = metres forward of the nose wheel)
const AC = {
  airliner_narrow: { fus: [-13.7, 18.8, 2.0, 1.9, 11.8], wing: [-13.0, 3.6, 17.9, 1.0, 5.0] },
  airliner_wide: { fus: [-24.6, 31.4, 3.0, 2.5, 17.0], wing: [-22.0, 6.0, 30.0, 1.6, 7.5] },
  fighter_f16: { fus: [-2.5, 7.6, 4.8, 0.3, 4.9] },
  fighter_f22: { fus: [-3.85, 9.5, 6.8, 0.3, 5.1] },
  heli_uh60: { fus: [-2.2, 7.7, 1.3, 0.2, 4.0], rotor: [0, 8.2, 8.2, 3.0, 3.9] },
};
const AGENT_ID = { airliner_narrow: ['a320neo', 'b737'], fighter_f16: ['f16'], fighter_f22: ['f22'], heli_uh60: ['uh60'] };

// ---------------------------------------------------------------- geometry helpers
function toFloat(a) {
  if (a.array instanceof Float32Array && !a.normalized) return a;
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c);
  return new THREE.BufferAttribute(out, k);
}

/** Indexed geometry with exactly position, normal and a float RGBA colour attribute (fallback colour if missing). */
function normColorGeo(geo, fallback) {
  let g = geo.index ? geo.clone() : geo.clone();
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4);
  const src = g.attributes.color;
  for (let i = 0; i < n; i++) {
    if (src) {
      col[4 * i] = src.getX(i); col[4 * i + 1] = src.getY(i); col[4 * i + 2] = src.getZ(i);
      col[4 * i + 3] = src.itemSize > 3 ? src.getW(i) : 1;
    } else {
      col[4 * i] = fallback.r; col[4 * i + 1] = fallback.g; col[4 * i + 2] = fallback.b; col[4 * i + 3] = 1;
    }
  }
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.setAttribute('position', toFloat(g.attributes.position));
  g.setAttribute('normal', toFloat(g.attributes.normal));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(g.index.array), 1));
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

// ---------------------------------------------------------------- props.glb library
let libP = null, loggedMissing = false;
function loadLibrary(ctx) {
  if (!libP) {
    libP = ctx.loader.loadGLTF(ROOT + airportFiles.props).then((gltf) => {
      const lib = new Map();
      let shared = null;
      gltf.scene.updateMatrixWorld(true);
      for (const node of gltf.scene.children) {
        const inv = node.matrixWorld.clone().invert();
        const parts = [];
        node.traverse((o) => {
          if (!o.isMesh) return;
          const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
          let name = o.name;
          for (let p = o; p && p !== node; p = p.parent) if (/_tail|_lamp/.test(p.name)) name = p.name;
          const lamp = /_lamp/.test(name);
          if (!lamp && !o.material.map && !shared) shared = o.material;
          parts.push({ geo, mat: o.material, tail: /_tail/.test(name), lamp });
        });
        lib.set(node.name, parts);
      }
      // the batch material: vertex colours x per-instance colour
      const bmat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: shared ? shared.roughness : 0.6, metalness: shared ? shared.metalness : 0.1,
      });
      bmat.name = 'apt-props';
      return { lib, bmat };
    });
    libP.catch((e) => { if (isNetworkError(e)) libP = null; });   // a failed download is tried again by the next airport (a missing file is not)
  }
  return libP;
}

// ---------------------------------------------------------------- agent LODs (optional)
const agentCache = new Map();
function loadAgentLod(id, ctx) {
  if (!agentCache.has(id)) {
    agentCache.set(id, (async () => {
      try {
        // <map>/airports/manifest.json lists which agent LOD files existed at build time (no 404 probes)
        const man = await ctx.loader.loadJSON(airportFiles.base + 'manifest.json').catch(() => ({}));
        if (man.lods && man.lods[id] === false && !(ctx.airportLodOverride && ctx.airportLodOverride[id])) return null;
        const mod = await import(`../aircraft/${id}/model.js`);
        const rel = (ctx.airportLodOverride && ctx.airportLodOverride[id]) || (mod.model && mod.model.lodUrl);
        if (!rel) return null;
        const url = new URL(rel, ROOT).href;
        // no HEAD probe (Chromium reports HEAD/range probes as aborted); a missing file rejects -> props LOD stays
        const gltf = await ctx.loader.loadGLTF(url);
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        const contact = new THREE.Vector3();
        let found = false, minY = Infinity;
        scene.traverse((o) => {
          if (o.name === 'contact_nose') { o.getWorldPosition(contact); found = true; }
          if (/^contact_/.test(o.name)) { const v = new THREE.Vector3(); o.getWorldPosition(v); minY = Math.min(minY, v.y); }
        });
        if (!found) {
          if (!isFinite(minY)) { const b = new THREE.Box3().setFromObject(scene); minY = b.min.y; }
          contact.set(0, minY, 0);
        }
        const textured = new Map();       // material -> [geo]   (maps / transparency kept as their own parts)
        const flat = [];                  // untextured opaque parts -> one vertex-coloured part
        let tris = 0, rough = 0, metal = 0, wsum = 0;
        scene.traverse((o) => {
          if (!o.isMesh) return;
          for (let a = o; a; a = a.parent) if (a.visible === false || /^interior$|screen_|_blur$/i.test(a.name)) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const mat = mats[0];
          const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
          geo.translate(-contact.x, -contact.y, -contact.z);
          const t = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
          tris += t;
          if (mat.map || mat.transparent || mat.opacity < 1 || mat.alphaTest > 0) {
            if (!textured.has(mat)) textured.set(mat, []);
            textured.get(mat).push(geo);
          } else {
            flat.push(normColorGeo(geo, mat.color.clone().multiplyScalar(mat.emissive && mat.emissive.getHex() ? 1.2 : 1)));
            rough += (mat.roughness ?? 0.6) * t; metal += (mat.metalness ?? 0) * t; wsum += t;
          }
        });
        const parts = [];
        if (flat.length) {
          const merged = mergeGeometries(flat, false);
          if (merged) {
            merged.computeBoundingSphere();
            const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: wsum ? rough / wsum : 0.6, metalness: wsum ? metal / wsum : 0.1 });
            m.name = `apt-${id}-flat`;
            parts.push({ geo: merged, mat: m });
          }
        }
        for (const [mat, geos] of textured) {
          const norm = geos.map((g0) => {
            const g = g0.index ? g0.toNonIndexed() : g0;
            for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
            if (!g.attributes.normal) g.computeVertexNormals();
            if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
            g.morphAttributes = {};
            for (const k of Object.keys(g.attributes)) g.setAttribute(k, toFloat(g.attributes[k]));
            return g;
          });
          const merged = mergeGeometries(norm, false);
          if (!merged) continue;
          merged.computeBoundingSphere();
          parts.push({ geo: merged, mat });
        }
        return parts.length ? { parts, tris } : null;
      } catch (e) {
        if (isNetworkError(e)) agentCache.delete(id);   // connection lost: the next airport asks again
        return null;
      }
    })());
  }
  return agentCache.get(id);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

/** Instanced set for an agent LOD (one InstancedMesh per part). */
class NearSet {
  constructor(name, parts, capacity, group) {
    this.meshes = parts.map((pt) => {
      const im = new THREE.InstancedMesh(pt.geo, pt.mat, Math.max(1, capacity));
      im.name = `apt-prop-${name}`;
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.visible = false;
      group.add(im);
      return im;
    });
  }
  set(list) {
    for (const im of this.meshes) {
      im.count = list.length;
      list.forEach((it, i) => {
        _q.setFromAxisAngle(UP, -it.h);
        im.setMatrixAt(i, _m.compose(_p.set(it.x, it.y, it.z), _q, _s));
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.visible = list.length > 0;
    }
  }
}

export async function buildProps(meta, ctx, colliders) {
  const L = await loadLibrary(ctx).catch((e) => { if (!loggedMissing) (isNetworkError(e) ? console.warn : console.info)('[airports] props.glb', e.message); loggedMissing = !isNetworkError(e); return null; });
  if (!L) return null;
  const { lib, bmat } = L;
  const [ox, oz] = meta.origin;
  const group = new THREE.Group();
  group.name = `apt-props-${meta.icao}`;
  group.position.set(ox, 0, oz);
  const ground = (x, z) => ctx.terrain.getHeight(x + ox, z + oz);

  // ---------------- placements
  const aircraft = new Map();      // type -> [{x,y,z,h,color,pref}]
  const items = [];                // [{type, x, y, z, h, color?}] everything drawn from props.glb
  const addV = (type, x, z, h) => { if (lib.has(type)) items.push({ type, x, y: ground(x, z), z, h }); };
  const stands = meta.stands || [];
  stands.forEach((s, i) => {
    const r = rng(i * 7919 + 17 + (meta.icao.charCodeAt(1) << 8));
    const h = s.h * Math.PI / 180;
    const fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h);
    const at = (along, right) => [s.x + fx * along + rx * right, s.z + fz * along + rz * right];
    const cls = s.cls || 'narrow';
    let type;
    if (cls === 'wide' || cls === 'cargo_wide') type = 'airliner_wide';
    else if (cls === 'fighter' || cls === 'fighter_has') type = s.model === 'f22' ? 'fighter_f22' : 'fighter_f16';
    else if (cls === 'heli') type = 'heli_uh60';
    else type = 'airliner_narrow';
    if (s.occ) {
      const tails = type === 'airliner_wide' ? TAILS_WIDE : TAILS_NARROW;
      const color = new THREE.Color().setStyle(tails[Math.floor(r() * tails.length)], THREE.SRGBColorSpace);
      const y = ground(s.x, s.z);
      const it = { type, x: s.x, y, z: s.z, h, color, pref: s.model, ac: true };
      if (!aircraft.has(type)) aircraft.set(type, []);
      aircraft.get(type).push(it);
      items.push(it);
      const a = AC[type];
      for (const key of ['fus', 'wing', 'rotor']) {
        const b = a[key];
        if (!b) continue;
        const [cx, cz] = at(b[0], 0);
        const c = colliders.addBox(cx + ox, cz + oz, h, b[1], b[2], y + b[3], y + b[4], type === 'heli_uh60' ? 'park halindeki helikopter' : 'park halindeki uçak');
        if (c) (it.coll || (it.coll = [])).push(c);
      }
    }
    // service vehicles
    if (type === 'airliner_narrow' || type === 'airliner_wide') {
      const W = type === 'airliner_wide';
      const k = W ? 1.0 : 0;
      if (s.occ) {
        if (r() < 0.8) {
          const lat = W ? 10 : 7.5;
          const a0 = W ? -18 : -11;
          addV('baggage_tractor', ...at(a0, lat), h);
          const nc = 1 + Math.floor(r() * 3);
          for (let c = 0; c < nc; c++) addV('baggage_cart', ...at(a0 - 3.4 - c * 3.6, lat), h);
        }
        if (r() < 0.55) addV('catering_truck', ...at(W ? -10.5 : 0.8, W ? 9.5 : 7.8), h - Math.PI / 2);
        if (r() < 0.4) addV('fuel_truck', ...at(W ? -24 : -13.5, W ? 15 : 10.5), h + (r() < 0.5 ? 0 : Math.PI));
        if (r() < 0.35) addV('tug', ...at(W ? 6 : 4.5, 0), h + Math.PI);
        if (r() < 0.5) addV('gpu', ...at(W ? 3 : 2.2, -3.5), h + Math.PI / 2);
        if (!s.jb && r() < 0.8) addV('stairs_truck', ...at(W ? -0.5 : 0.6, W ? -7.5 : -5.8), h + Math.PI / 2);
        if (!s.jb && r() < 0.25) addV('bus', ...at(W ? 10 : 12, -14 - k * 4), h + Math.PI / 2);
      }
      if (r() < 0.16) addV('car', ...at(W ? 14 : 11, (r() - 0.5) * 30), h + (r() < 0.5 ? 1 : -1) * Math.PI / 2);
      if (r() < 0.035) addV('bus', ...at(W ? 16 : 14, (r() - 0.5) * 24), h + (r() < 0.5 ? 1 : -1) * Math.PI / 2);
    } else if (type === 'fighter_f16' || type === 'fighter_f22') {
      if (r() < 0.45) addV('hmmwv', ...at(5 + r() * 3, 6 + r() * 2), h + 2.1);
      if (s.occ && r() < 0.6) addV('gpu', ...at(-1.5, -3.2), h + Math.PI / 2);
      if (s.occ && r() < 0.2) addV('fuel_truck_mil', ...at(-4, 9), h);
    } else if (type === 'heli_uh60' && r() < 0.3) {
      addV('hmmwv', ...at(-6, 12), h + 1.2);
    }
  });
  for (const p of meta.props || []) {
    let hd = (p.h || 0) * Math.PI / 180;
    if (p.t === 'windsock' && !p.h) hd = 115 * Math.PI / 180;      // prevailing WNW wind -> sock points ESE
    addV(p.t, p.x, p.z, hd);
  }

  // ---------------- one BatchedMesh for every props.glb part (lamps: separate emissive InstancedMesh)
  const geoIds = new Map();          // type -> [{gid, tail}]
  const batchGeos = [];
  const lampParts = [];
  for (const type of new Set(items.map((it) => it.type))) {
    const list = [];
    for (const pt of lib.get(type)) {
      if (pt.lamp) { lampParts.push({ type, pt }); continue; }
      const g = normColorGeo(pt.geo, pt.mat.color || WHITE);
      batchGeos.push(g);
      list.push({ g, tail: pt.tail });
    }
    geoIds.set(type, list);
  }
  let nV = 0, nI = 0, nInst = 0;
  for (const g of batchGeos) { nV += g.attributes.position.count; nI += g.index.count; }
  for (const it of items) nInst += geoIds.get(it.type).length;
  const batch = new THREE.BatchedMesh(Math.max(1, nInst), Math.max(3, nV), Math.max(3, nI), bmat);
  batch.name = `apt-props-batch-${meta.icao}`;
  batch.castShadow = true;
  batch.receiveShadow = true;
  batch.sortObjects = false;   // opaque: no per-frame depth sort of every instance (11-15 MB/s of garbage at an airport)
  for (const list of geoIds.values()) for (const e of list) e.gid = batch.addGeometry(e.g);
  for (const it of items) {
    _q.setFromAxisAngle(UP, -it.h);
    _m.compose(_p.set(it.x, it.y, it.z), _q, _s);
    it.ids = [];
    for (const e of geoIds.get(it.type)) {
      const iid = batch.addInstance(e.gid);
      batch.setMatrixAt(iid, _m);
      batch.setColorAt(iid, e.tail && it.color ? it.color : WHITE);
      it.ids.push(iid);
    }
  }
  batch.computeBoundingSphere();
  group.add(batch);
  const lamps = [];
  for (const { type, pt } of lampParts) {
    const list = items.filter((it) => it.type === type);
    const im = new THREE.InstancedMesh(pt.geo, pt.mat, list.length);
    list.forEach((it, i) => { _q.setFromAxisAngle(UP, -it.h); im.setMatrixAt(i, _m.compose(_p.set(it.x, it.y, it.z), _q, _s)); });
    im.computeBoundingSphere();
    group.add(im);
    if (!lamps.includes(pt.mat)) lamps.push(pt.mat);
  }

  // agent LODs for the nearest aircraft are optional and loaded later (addAgentLods) so they never delay the start
  const nearSets = [];
  let count = 0;
  for (const l of aircraft.values()) count += l.length;
  // re-grounding job (see airports_drape.js): items keep x/z; y and the batch matrices follow the terrain
  const s2 = [0, 0];
  const drapeJob = {
    n: items.length,
    sample(i) { s2[0] = items[i].x + ox; s2[1] = items[i].z + oz; return s2; },
    apply(i, h) {
      const it = items[i];
      if (Math.abs(it.y - h) <= 0.03) return false;
      it.y = h;
      _q.setFromAxisAngle(UP, -it.h);
      _m.compose(_p.set(it.x, it.y, it.z), _q, _s);
      for (const iid of it.ids) batch.setMatrixAt(iid, _m);
      return true;
    },
    done() { batch.computeBoundingSphere(); for (const e of nearSets) for (const it of e.list) it.near = undefined; },
  };
  const lampMeshes = [];
  group.traverse((o) => { if (o.isInstancedMesh && lamps.includes(o.material)) lampMeshes.push(o); });
  // per-item rank for density thinning: the item's place among the aircraft (or among the vehicles) ordered by a hash
  // of its own position and type, so a fraction f keeps exactly round(f × n) of them and a data edit elsewhere moves
  // at most a few across the threshold (it was a random number from the item's index in the list: any edit before it
  // reshuffled which aircraft low presets / phones keep, and the kept count wandered: LTFM 170 → 179 on phones)
  for (const group of [items.filter((it) => it.ac), items.filter((it) => !it.ac)]) {
    group.map((it) => [stableRank(it.x, it.z, it.type), it]).sort((a, b) => a[0] - b[0]).forEach(([, it], k, all) => { it.rank = (k + 0.5) / all.length; });
  }
  return { object: group, batch, items, aircraft, nearSets, lamps, lampMeshes, drapeJob, timer: 0, origin: [ox, oz], lastDay: -1, aircraftCount: count };
}

const _cam = new THREE.Vector3();
export function updateProps(p, dt, camPos, day) {
  if (!p) return;
  const d = Math.round(day * 20) / 20;
  if (d !== p.lastDay) {
    p.lastDay = d;
    for (const m of p.lamps) m.emissiveIntensity = 0.15 + (1 - d) * 4.0;
  }
  if (!p.nearSets.length) return;
  p.timer -= dt;
  if (p.timer > 0) return;
  p.timer = 0.5;
  const [ox, oz] = p.origin;
  _cam.set(camPos.x - ox, camPos.y, camPos.z - oz);
  for (const e of p.nearSets) {
    const scored = e.list.map((it, i) => ({ it, i, d: Math.hypot(it.x - _cam.x, it.z - _cam.z, it.y - _cam.y) }));
    scored.sort((a, b) => a.d - b.d);
    const nearLists = e.near.map(() => []);
    let tris = 0;
    for (const s of scored) {
      if (s.it.hidden) continue;
      let k = e.near.findIndex((n) => n.id === s.it.pref);
      if (k < 0) k = s.i % e.near.length;
      const n = e.near[k];
      const ns = p.nearScale ?? 1;
      const near = s.d < NEAR_DIST * ns && tris + n.tris < NEAR_TRI_BUDGET * ns;
      if (near) { nearLists[k].push(s.it); tris += n.tris; }
      if (s.it.near !== near) {
        s.it.near = near;
        for (const iid of s.it.ids) p.batch.setVisibleAt(iid, !near);
      }
    }
    e.near.forEach((n, k) => n.set.set(nearLists[k]));
  }
}

// quality: keep only a fraction of the parked aircraft / service vehicles (floodlights and windsocks always stay).
// Hidden aircraft also stop colliding.
const ALWAYS = new Set(['floodlight', 'windsock']);
export function setPropsDensity(p, acFrac, vehFrac, lodScale = 1) {
  if (!p) return;
  p.nearScale = lodScale;          // distance (and triangle budget) for the aircraft agents' detailed LODs
  for (const it of p.items) {
    const keep = ALWAYS.has(it.type) || it.rank < (it.ac ? acFrac : vehFrac);
    it.hidden = !keep;
    for (const iid of it.ids) p.batch.setVisibleAt(iid, keep && !it.near);
    if (it.coll) for (const c of it.coll) c.off = !keep;
  }
  for (const e of p.nearSets) for (const it of e.list) it.near = undefined;
  p.timer = 0;
}

/** Load the aircraft agents' LOD models (background, after the game has started) and hook them into the near set. */
export async function addAgentLods(p, ctx) {
  if (!p) return;
  for (const [type, list] of p.aircraft) {
    const entry = { type, list, near: [] };
    for (const id of AGENT_ID[type] || []) {
      const lod = await loadAgentLod(id, ctx);
      if (!lod) continue;
      const set = new NearSet(`${type}-${id}`, lod.parts, list.length, p.object);
      if (ctx.precompile) for (const im of set.meshes) await ctx.precompile(im);   // shaders before the first draw
      entry.near.push({ id, set, tris: lod.tris });
    }
    if (entry.near.length) p.nearSets.push(entry);
  }
  p.timer = 0;
}
