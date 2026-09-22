// STUB (W1 replaces): flat sky color, fog, hemisphere + sun.
import * as THREE from 'three';
export async function createEnvironment({ scene }) {
  scene.background = new THREE.Color(0x9cc6ec);
  scene.fog = new THREE.Fog(0x9cc6ec, 2000, 40000);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x55604a, 1.3));
  const sunDirection = new THREE.Vector3(-0.4, 0.75, 0.5).normalize();
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.copy(sunDirection).multiplyScalar(5000);
  scene.add(sun);
  return { sunDirection, update() {} };
}
