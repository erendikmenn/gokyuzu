// Lead-owned placeholder: wraps the island FlightModel in the v2 FlightModel interface until P1/P2 deliver.
import { FlightModel } from '../ada/flight/physics.js';
export function stubFlightModel(spec, { contacts } = {}) {
  const gh = contacts && contacts.length ? Math.max(...contacts.map((c) => -c.position.y)) : 1.2;
  const m = new FlightModel({ gearHeight: gh });
  Object.assign(m, {
    spec, engines: Array.from({ length: spec.engines || 1 }, () => ({ n1: 0, thrust: 0, afterburner: 0, fuelFlow: 0 })),
    gear: 1, gearHandleDown: true, flapsIndex: 0, flapsLabel: 'UP', slats: 0, spoilers: 0, speedbrake: 0, reverser: 0,
    brakes: 0, fuel: 1000, mach: 0, ias: 0, warnings: { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false },
    autopilot: { on: false, altitude: 0, heading: 0, speed: 0 }, rotorRPM: 0, collective: 0, torque: 0,
  });
  let flapsCmd = 0;
  const reset1 = m.reset.bind(m), step1 = m.step.bind(m);
  m.reset = (s, world) => reset1(s.x, s.z, s.heading, world);
  m.step = (dt, inp, world) => {
    step1(dt, { pitch: inp.pitch, roll: inp.roll, yaw: inp.yaw, throttle: inp.throttle, flaps: flapsCmd, brake: inp.brake > 0.5 }, world);
    m.ias = m.airspeed; m.mach = m.airspeed / 340; m.brakes = inp.brake;
    for (const e of m.engines) e.n1 = 0.2 + 0.8 * m.throttle;
  };
  m.command = (a) => {
    if (a === 'flapsDown') flapsCmd = Math.min(1, flapsCmd + 0.5);
    if (a === 'flapsUp') flapsCmd = Math.max(0, flapsCmd - 0.5);
    if (a === 'gear') { m.gearHandleDown = !m.gearHandleDown; m.gear = m.gearHandleDown ? 1 : 0; }
    m.flapsLabel = flapsCmd === 0 ? 'UP' : flapsCmd === 0.5 ? '1' : 'FULL';
  };
  m.getVisualState = () => ({
    time: performance.now() / 1000, airspeed: m.airspeed, mach: m.mach, onGround: m.onGround, aoa: m.aoa || 0,
    aileron: m.aileron, elevator: m.elevator, rudder: m.rudder, flaps: m.flaps, slats: 0, spoilers: 0, speedbrake: 0,
    gear: m.gear, gearCompression: [0, 0, 0], wheelSpeed: m.airspeed,
    engines: m.engines.map((e) => ({ n1: e.n1, throttle: m.throttle, afterburner: 0, nozzle: 0, reverser: 0 })),
    tvc: { pitch: 0, yaw: 0 }, rotor: null, canopy: 0, lights: { nav: true, strobe: true, beacon: true, landing: false, taxi: false },
  });
  return m;
}
