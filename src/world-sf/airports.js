// STUB (W4 replaces): dark runway rectangles from data/sf/runways.json.
import * as THREE from 'three';
export async function createAirports({ runways, terrain }) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x2c2c2e, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const apt of runways.airports) for (const r of apt.runways) {
    const [a, b] = r.ends;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r.width, r.length).rotateX(-Math.PI / 2), mat);
    m.position.set((a.x + b.x) / 2, terrain.getHeight((a.x + b.x) / 2, (a.z + b.z) / 2) + 0.05, (a.z + b.z) / 2);
    m.rotation.y = -Math.atan2(b.x - a.x, -(b.z - a.z));
    group.add(m);
  }
  return { object: group, update() {}, heightAt: () => -Infinity, hitTest: () => null, ready: Promise.resolve() };
}
