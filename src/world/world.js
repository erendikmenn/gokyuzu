// STUB: replaced by Agent B. Flat green ground, gray runway, basic lights.
import * as THREE from 'three';
import { RUNWAY } from '../config.js';

export function createWorld(scene, renderer) {
  scene.background = new THREE.Color(0x9cc6ec);
  scene.fog = new THREE.Fog(0x9cc6ec, 1500, 9000);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  const sunDirection = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  sun.position.copy(sunDirection).multiplyScalar(1000);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x5f8f47 }));
  ground.position.y = RUNWAY.elevation;
  scene.add(ground);
  const rw = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x333333 }));
  rw.position.set(RUNWAY.x, RUNWAY.elevation + 0.05, RUNWAY.z);
  scene.add(rw);
  return {
    getGroundHeight: () => RUNWAY.elevation,
    isWater: () => false,
    isOnRunway: (x, z) => Math.abs(x - RUNWAY.x) < RUNWAY.width / 2 && Math.abs(z - RUNWAY.z) < RUNWAY.length / 2,
    sunDirection,
    update() {},
  };
}
