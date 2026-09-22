// Fast-forward integration test, run inside the game page (headless) via:
//   node tools/shot.mjs ada.html out.png --eval "import('/tools/autopilot.js').then(m => m.run(__game))"
// A simple autopilot flies the real FlightModel over the real World through the real Missions:
// take-off, every ring in order, then an approach and landing on the runway. Returns a JSON summary.
import { SPAWN } from '../src/ada/config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap180 = (d) => ((d + 540) % 360) - 180;
const bearingTo = (from, to) => (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI + 360) % 360;

export function run(game, { dt = 1 / 60, maxTime = 1200, traceFrom = Infinity } = {}) {
  const trace = [];
  const { flight, world, missions } = game;
  flight.reset(SPAWN.x, SPAWN.z, SPAWN.heading, world);
  missions.reset();

  const input = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: false };
  const log = [];
  let t = 0, state = missions.update(0, flight), ringsSeen = 0;
  let minAgl = Infinity, maxRoll = 0, touchdown = null, crash = null;
  flight.on('touchdown', (i) => { touchdown = touchdown || { t: +t.toFixed(1), ...i }; });
  flight.on('crash', (i) => { crash = crash || { t: +t.toFixed(1), reason: flight.crashReason }; });

  while (t < maxTime && !flight.crashed) {
    const p = flight.position;
    const landing = !!state.landing || (state.ringsDone >= state.ringsTotal && state.ringsTotal > 0);

    if (flight.onGround && !landing) {
      // take-off roll: full power, rotate at 28 m/s, keep straight down the centerline
      input.throttle = 1; input.flaps = 0; input.brake = false;
      input.pitch = flight.airspeed > 28 ? 0.6 : 0;
      input.roll = 0;
      input.yaw = clamp(-p.x * 0.05 - wrap180(flight.heading) * 0.05, -1, 1);
    } else if (!landing) {
      // ring navigation: follow the ring's approach line (through its center along its normal)
      const target = state.nextTarget;
      const ring = (state.rings || []).find((r) => r.position.distanceTo(target) < 1);
      let wantHdg = bearingTo(p, target);
      if (ring) {
        // cross-track line following: fly the ring's course, correcting toward its center line
        const n = ring.normal;
        const s = (p.x - target.x) * n.x + (p.z - target.z) * n.z;    // along-track, negative before the ring
        const e = (p.x - target.x) * -n.z + (p.z - target.z) * n.x;   // cross-track, + = right of the line
        const course = Math.atan2(n.x, -n.z) * 180 / Math.PI;
        if (s > -2500) wantHdg = course - clamp(e * 0.35, -70, 70);
      }
      const hdgErr = wrap180(wantHdg - flight.heading);
      const bank = clamp(hdgErr * 1.2, -35, 35);
      input.roll = clamp((bank - flight.roll) * 0.06, -1, 1);
      const agl = flight.agl;
      // terrain look-ahead along the current track
      let ahead = 0;
      const vh = Math.hypot(flight.velocity.x, flight.velocity.z) || 1;
      for (let d = 100; d <= 700; d += 100) {
        ahead = Math.max(ahead, world.getGroundHeight(p.x + flight.velocity.x / vh * d, p.z + flight.velocity.z / vh * d));
      }
      const wantAlt = Math.max(target.y, ahead + 70, p.y - flight.agl + 60);
      const wantVs = clamp((wantAlt - p.y) * 0.12, -6, agl < 60 ? 6 : 5);
      input.pitch = clamp((wantVs - flight.verticalSpeed) * 0.12 + Math.abs(flight.roll) * 0.004, -1, 1);
      input.throttle = 0.9; input.flaps = 0; input.yaw = 0;
    } else {
      // approach and landing toward -Z on the runway centerline (runway along Z at x = 0)
      const aim = { x: 0, z: Math.min(p.z - 500, 600) };
      const hdgErr = wrap180(bearingTo(p, aim) - flight.heading);
      const bank = clamp(hdgErr * 1.2, -25, 25);
      input.roll = clamp((bank - flight.roll) * 0.06, -1, 1);
      const threshold = 700 - 150;                        // touchdown aim point z
      const dist = Math.max(0, p.z - threshold);
      const ground = 20;
      const glideAlt = ground + dist * Math.tan(3.5 * Math.PI / 180);
      let wantVs = clamp((glideAlt - p.y) * 0.15 - (flight.airspeed * Math.tan(3.5 * Math.PI / 180)), -5, 2);
      if (flight.agl < 8) wantVs = -0.7;                   // flare
      input.pitch = clamp((wantVs - flight.verticalSpeed) * 0.12 + 0.05, -1, 1);
      input.flaps = 1;
      input.throttle = flight.agl < 4 ? 0 : clamp(0.35 + (30 - flight.airspeed) * 0.06, 0, 1);
      if (flight.onGround) { input.throttle = 0; input.brake = true; input.pitch = 0; input.roll = 0; input.yaw = clamp(-p.x * 0.05, -1, 1); }
    }

    flight.step(dt, input, world);
    state = missions.update(dt, flight);
    t += dt;

    if (!flight.onGround) { minAgl = Math.min(minAgl, flight.agl); maxRoll = Math.max(maxRoll, Math.abs(flight.roll)); }
    if (state.ringsDone !== ringsSeen) {
      ringsSeen = state.ringsDone;
      log.push({ ring: ringsSeen, t: +t.toFixed(1), alt: Math.round(p.y), agl: Math.round(flight.agl), spd: +flight.airspeed.toFixed(1) });
    }
    if (state.ringsDone >= traceFrom && Math.abs(t % 2) < dt) trace.push([+t.toFixed(0), Math.round(p.x), Math.round(p.z), Math.round(p.y), Math.round(flight.agl), Math.round(flight.heading), Math.round(flight.roll), state.nextTarget ? Math.round(Math.hypot(state.nextTarget.x - p.x, state.nextTarget.z - p.z)) : null]);
    if (state.complete) break;
    if (landing && flight.onGround && flight.airspeed < 0.5) break;
  }

  return {
    simTime: +t.toFixed(1),
    rings: `${state.ringsDone}/${state.ringsTotal}`,
    objective: state.objective,
    complete: !!state.complete,
    crashed: flight.crashed, crash,
    touchdown,
    final: { x: Math.round(flight.position.x), z: Math.round(flight.position.z), onRunway: world.isOnRunway(flight.position.x, flight.position.z), speed: +flight.airspeed.toFixed(1) },
    minAglAirborne: +minAgl.toFixed(1), maxRoll: Math.round(maxRoll),
    ringLog: log,
    trace,
  };
}
