// STUB: replaced by Agent C. Kinematic "fly where you point" placeholder.
import * as THREE from 'three';

export class FlightModel {
  constructor({ gearHeight }) {
    this.gearHeight = gearHeight;
    this.position = new THREE.Vector3(); this.quaternion = new THREE.Quaternion(); this.velocity = new THREE.Vector3();
    this.airspeed = 0; this.altitude = 0; this.agl = 0; this.heading = 0; this.pitch = 0; this.roll = 0;
    this.verticalSpeed = 0; this.gForce = 1; this.throttle = 0; this.flaps = 0;
    this.aileron = 0; this.elevator = 0; this.rudder = 0;
    this.onGround = true; this.stalled = false; this.crashed = false; this.crashReason = '';
    this.handlers = {};
  }
  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); }
  reset(x, z, heading, world) {
    this.position.set(x, world.getGroundHeight(x, z) + this.gearHeight, z);
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    this.airspeed = 0; this.crashed = false; this.onGround = true;
  }
  step(dt, input, world) {
    this.throttle = input.throttle; this.flaps = input.flaps;
    this.aileron = input.roll; this.elevator = input.pitch; this.rudder = input.yaw;
    this.airspeed += (input.throttle * 60 - this.airspeed) * dt * 0.3;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(input.pitch * dt, -input.yaw * dt * 0.5, -input.roll * dt * 1.5));
    this.quaternion.multiply(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    this.position.addScaledVector(fwd, this.airspeed * dt);
    const g = world.getGroundHeight(this.position.x, this.position.z) + this.gearHeight;
    if (this.position.y < g) this.position.y = g;
    this.altitude = this.position.y; this.agl = this.position.y - g;
    const e = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
    this.heading = ((-e.y * 180 / Math.PI) % 360 + 360) % 360; this.pitch = e.x * 180 / Math.PI; this.roll = -e.z * 180 / Math.PI;
  }
}
