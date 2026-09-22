// STUB: replaced by Agent D. Simple chase camera.
import * as THREE from 'three';
export function createCameraRig(camera, aircraft, dom) {
  const off = new THREE.Vector3(0, 4, 16);
  return {
    mode: 'chase', next() { return 'Takip'; },
    update(dt, flight) {
      const target = off.clone().applyQuaternion(flight.quaternion).add(flight.position);
      camera.position.lerp(target, 1 - Math.exp(-dt * 6));
      camera.lookAt(flight.position);
    },
  };
}
