// Lead-owned placeholder rig used by aircraft stubs until the real Blender model lands: the island Cessna, scaled.
import * as THREE from 'three';
import { createAircraft } from '../ada/models/aircraft.js';
export function stubRig(scale = 1) {
  const a = createAircraft();
  const object = new THREE.Group();
  a.object.scale.setScalar(scale);
  object.add(a.object);
  const gh = a.gearHeight * scale;
  return {
    object,
    eye: { pilot: a.cockpitOffset.clone().multiplyScalar(scale) },
    contacts: [
      { name: 'contact_nose', position: new THREE.Vector3(0, -gh, -1.6 * scale), kind: 'nose' },
      { name: 'contact_main_L', position: new THREE.Vector3(-1.25 * scale, -gh, 0.45 * scale), kind: 'main' },
      { name: 'contact_main_R', position: new THREE.Vector3(1.25 * scale, -gh, 0.45 * scale), kind: 'main' },
    ],
    screens: {},
    bounds: { length: 8.3 * scale, span: 11 * scale, height: 2.7 * scale, radius: 6 * scale },
    update(dt, v) {
      a.update(dt, { throttle: v.engines?.[0]?.throttle ?? 0, aileron: v.aileron, elevator: v.elevator, rudder: v.rudder, flaps: v.flaps, airspeed: v.airspeed });
    },
    setView() {},
  };
}
