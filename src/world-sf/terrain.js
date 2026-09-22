// STUB (W1 replaces): one flat land plane at 4 m over the whole map.
import * as THREE from 'three';
export async function createTerrain({ region }) {
  const b = region.local, w = b.maxX - b.minX, d = b.maxZ - b.minZ;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x6d8a5a }));
  mesh.position.set((b.minX + b.maxX) / 2, 4, (b.minZ + b.maxZ) / 2);
  return { object: mesh, getHeight: () => 4, isWater: () => false, update() {}, ready: Promise.resolve() };
}
