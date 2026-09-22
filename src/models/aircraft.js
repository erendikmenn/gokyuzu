// STUB: replaced by Agent A. Box plane, nose toward -Z.
import * as THREE from 'three';

export function createAircraft() {
  const object = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 8), mat);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.15, 1.5), mat);
  wing.position.set(0, 0.7, -0.5);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 1), mat);
  tail.position.set(0, 0.2, 3.6);
  object.add(fuselage, wing, tail);
  return { object, gearHeight: 1.2, cockpitOffset: new THREE.Vector3(0, 0.9, -1), update() {} };
}
