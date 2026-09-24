// Stand-in terrain for a map whose terrain is not built yet (src/maps/index.js: another map while its layers are
// produced): the sea at 0 m everywhere and every airport of runways.json on a flat neutral pad at its elevation (the
// runway starts work, the airports layer drapes onto it). Loaded only in that case (its own chunk).
import * as THREE from 'three';

/** A map without terrain data yet (other maps while they are built): sea at 0 m, the airport grounds as flat neutral pads. */
export function seaPlaceholder({ runways }) {
  const object = new THREE.Group();
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(300000, 300000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b3444, roughness: 0.3 }));
  sea.receiveShadow = true;
  object.add(sea);
  const pads = [], ground = new THREE.MeshStandardMaterial({ color: 0x77786a, roughness: 1 });
  for (const a of (runways && runways.airports) || []) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of a.runways) for (const e of r.ends) { x0 = Math.min(x0, e.x - 800); x1 = Math.max(x1, e.x + 800); z0 = Math.min(z0, e.z - 800); z1 = Math.max(z1, e.z + 800); }
    const y = Math.max(a.elevation || 0, 0.5);
    if (!(x1 > x0)) continue;
    pads.push({ x0, x1, z0, z1, y });
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y, z1 - z0), ground);
    m.position.set((x0 + x1) / 2, y / 2, (z0 + z1) / 2);
    m.receiveShadow = true;
    object.add(m);
  }
  const pad = (x, z) => pads.find((p) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1);
  return { object, getHeight: (x, z) => { const p = pad(x, z); return p ? p.y : 0; }, isWater: (x, z) => !pad(x, z),
    getNormal: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0), update() {}, ready: Promise.resolve(), stats: {}, dispose() {} };
}

