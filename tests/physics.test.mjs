// Flight model tests. Run: node tests/physics.test.mjs
// No framework: scripted pilots drive an InputState against fake worlds; prints a PASS/FAIL table.
import { FlightModel } from '../src/ada/flight/physics.js';

const GEAR = 1.2;
const DEG = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- fake worlds -------------------------------------------------------------------------------
const flatWorld = {
  getGroundHeight: () => 20,
  isWater: () => false,
  isOnRunway: (x, z) => Math.abs(x) < 22.5 && Math.abs(z) < 700,
};
// lake north of z = -200 (ground = sea level 0 there)
const waterWorld = {
  getGroundHeight: (x, z) => (z < -200 ? 0 : 20),
  isWater: (x, z) => z < -200,
  isOnRunway: (x, z) => Math.abs(x) < 22.5 && Math.abs(z) < 700 && z > -200,
};
// a cliff 280 m high north of z = -400
const cliffWorld = {
  getGroundHeight: (x, z) => (z < -400 ? 300 : 20),
  isWater: () => false,
  isOnRunway: () => false,
};

// ---- helpers -----------------------------------------------------------------------------------
const results = [];
const measured = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }
function note(name, value) { measured.push({ name, value }); }

function newInput(over = {}) { return { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: false, ...over }; }

/** Run `secs` of simulated time with frame step dt; pilot(t, f, inp, dt) may change inputs every frame. */
function fly(f, world, inp, secs, dt = 1 / 60, pilot = null, t0 = 0) {
  const n = Math.round(secs / dt);
  let t = t0;
  for (let i = 0; i < n; i++) {
    if (pilot && pilot(t, f, inp, dt) === false) break;
    f.step(dt, inp, world);
    t += dt;
    if (f.crashed) break;
  }
  return t;
}

function makeTracker(f) {
  let prev = f.heading, total = 0;
  return () => { let d = f.heading - prev; if (d > 180) d -= 360; if (d < -180) d += 360; total += d; prev = f.heading; return total; };
}

function finite(f) {
  return [f.position.x, f.position.y, f.position.z, f.velocity.x, f.velocity.y, f.velocity.z, f.quaternion.x, f.quaternion.w].every(Number.isFinite);
}

const spawnZ = 640;

// ---- 1. parked -------------------------------------------------------------------------------
{
  const f = new FlightModel({ gearHeight: GEAR });
  f.reset(0, spawnZ, 0, flatWorld);
  const p0 = f.position.clone();
  const onGroundAtReset = f.onGround && Math.abs(p0.y - (20 + GEAR)) < 1e-9;
  let maxDev = 0, maxV = 0, maxY = 0;
  const inp = newInput();
  fly(f, flatWorld, inp, 10, 1 / 60, () => {
    maxDev = Math.max(maxDev, f.position.distanceTo(p0));
    maxY = Math.max(maxY, Math.abs(f.position.y - p0.y));
    maxV = Math.max(maxV, f.velocity.length());
  });
  check('1. Parked at idle 10 s: no creep, no sink, no jitter',
    onGroundAtReset && maxDev < 0.05 && maxY < 0.005 && maxV < 0.01 && !f.crashed && f.onGround,
    `wheels on ground at reset=${onGroundAtReset}, drift ${maxDev.toExponential(1)} m, dy ${maxY.toExponential(1)} m, |v|max ${maxV.toExponential(1)}`);

  // parked with brakes at 30% throttle: must hold still-ish, and on a heading of 90 deg as well
  const g = new FlightModel({ gearHeight: GEAR });
  g.reset(100, 0, Math.PI / 2, flatWorld);
  const q0 = g.position.clone();
  fly(g, flatWorld, newInput({ throttle: 0.3, brake: true }), 8);
  const hdgOk = Math.abs(g.heading - 90) < 0.5;
  check('1b. Brakes hold at 30% throttle, heading 90 = east', g.position.distanceTo(q0) < 0.3 && hdgOk,
    `moved ${g.position.distanceTo(q0).toFixed(3)} m, heading ${g.heading.toFixed(1)}`);
}

// ---- 2. takeoff ------------------------------------------------------------------------------
{
  const f = new FlightModel({ gearHeight: GEAR });
  f.reset(0, spawnZ, 0, flatWorld);
  const start = f.position.clone();
  let takeoffs = [];
  f.on('takeoff', (i) => takeoffs.push(i));
  const inp = newInput({ throttle: 1 });
  let rotating = false, tLift = null, climbSamples = [], lastV = 0, maxDrift = 0;
  fly(f, flatWorld, inp, 70, 1 / 60, (t, f, inp, dt) => {
    maxDrift = Math.max(maxDrift, Math.abs(f.position.x));
    if (!rotating && f.airspeed >= 28) rotating = true;
    const dV = (f.airspeed - lastV) / dt; lastV = f.airspeed;
    if (!takeoffs.length) { inp.pitch = rotating ? 0.5 : 0; return; }
    if (tLift === null) tLift = t;
    // hold ~30 m/s with pitch (PD on airspeed)
    inp.pitch = clamp(0.12 * (f.airspeed - 30) + 0.25 * dV, -0.6, 0.6);
    if (t - tLift > 15 && t - tLift < 45) climbSamples.push({ vs: f.verticalSpeed, v: f.airspeed });
  });
  const tk = takeoffs[0];
  const dist = tk ? Math.hypot(tk.x - start.x, tk.z - start.z) : NaN;
  const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / Math.max(1, a.length);
  const vs = avg(climbSamples, 'vs'), va = avg(climbSamples, 'v');
  note('Liftoff distance (rotate at 28 m/s)', `${dist.toFixed(0)} m at ${tk ? tk.airspeed.toFixed(1) : '?'} m/s`);
  note('Climb at ~30 m/s, full throttle', `${vs.toFixed(2)} m/s at ${va.toFixed(1)} m/s`);
  check('2. Full-throttle takeoff: liftoff 200-450 m, one takeoff event', takeoffs.length === 1 && dist >= 200 && dist <= 450 && !f.crashed,
    `liftoff at ${dist.toFixed(0)} m, ${takeoffs.length} event(s), lateral drift ${maxDrift.toFixed(2)} m`);
  check('2b. Climb > 3 m/s at ~30 m/s', vs > 3 && Math.abs(va - 30) < 2 && !f.crashed, `vs ${vs.toFixed(2)} m/s at ${va.toFixed(1)} m/s`);
}

// bounce after liftoff (pilot lets it settle back onto the runway): still exactly one takeoff event
{
  const f = new FlightModel({ gearHeight: GEAR });
  f.reset(0, spawnZ, 0, flatWorld);
  let takeoffs = 0, touchdowns = 0, contactsAfter = 0, wasGround = true, lifted = false;
  f.on('takeoff', () => { takeoffs++; lifted = true; });
  f.on('touchdown', () => touchdowns++);
  const inp = newInput({ throttle: 1 });
  fly(f, flatWorld, inp, 45, 1 / 60, (t) => {
    if (lifted && f.onGround && !wasGround) contactsAfter++;
    wasGround = f.onGround;
    if (!lifted) inp.pitch = f.airspeed > 28 ? 0.5 : 0;
    else if (contactsAfter === 0) inp.pitch = -0.4;   // push it back down
    else inp.pitch = f.airspeed > 32 ? 0.4 : 0;        // then fly away
  });
  check('2c. Bounce after liftoff: single takeoff event', takeoffs === 1 && contactsAfter >= 1 && !f.crashed && f.agl > 20,
    `${takeoffs} takeoff event(s), ${contactsAfter} re-contact(s), ${touchdowns} touchdown event(s), agl ${f.agl.toFixed(0)} m`);
}

// ---- 3. cruise -------------------------------------------------------------------------------
function levelSpeed(throttle, secs = 150) {
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 50, flatWorld, { throttle });
  const inp = newInput({ throttle });
  const s = [];
  fly(f, flatWorld, inp, secs, 1 / 60, (t) => { if (t > secs - 20) s.push({ v: f.airspeed, vs: f.verticalSpeed }); });
  return {
    f,
    v: s.reduce((a, x) => a + x.v, 0) / s.length,
    vsAvg: s.reduce((a, x) => a + x.vs, 0) / s.length,
    vsMax: Math.max(...s.map((x) => Math.abs(x.vs))),
  };
}
{
  const c = levelSpeed(0.75);
  note('Cruise speed, 75% throttle, hands-off', `${c.v.toFixed(1)} m/s (${(c.v * 1.944).toFixed(0)} kt), pitch ${c.f.pitch.toFixed(1)} deg`);
  check('3. Hands-off cruise at 75%: 50-60 m/s, ~0 vertical speed', c.v > 50 && c.v < 60 && Math.abs(c.vsAvg) < 0.3 && c.vsMax < 0.5 && !c.f.crashed,
    `V ${c.v.toFixed(1)} m/s, vs avg ${c.vsAvg.toFixed(3)} max ${c.vsMax.toFixed(3)} m/s`);
  const top = levelSpeed(1.0, 240);
  note('Top speed, level, 100% throttle', `${top.v.toFixed(1)} m/s (${(top.v * 1.944).toFixed(0)} kt)`);
  check('3b. Top speed 65-75 m/s', top.v > 65 && top.v < 75, `${top.v.toFixed(1)} m/s`);
}

// ---- 4. hands-off stability -----------------------------------------------------------------
function rollPulse(amount) {
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 55, flatWorld, { throttle: 0.75 });
  const inp = newInput({ throttle: 0.75 });
  let maxBankAfter = 0, bankAtRelease = 0, minAlt = Infinity;
  fly(f, flatWorld, inp, 33, 1 / 60, (t) => {
    inp.roll = t >= 2 && t < 3 ? amount : 0;
    if (t >= 3) { if (!bankAtRelease) bankAtRelease = f.roll; maxBankAfter = Math.max(maxBankAfter, Math.abs(f.roll)); }
    minAlt = Math.min(minAlt, f.altitude);
  });
  return { f, maxBankAfter, bankAtRelease, altLoss: 800 - minAlt };
}
{
  const r = rollPulse(0.5);
  check('4. Half roll input 1 s, release: bank < 45 deg, levels, no crash', r.maxBankAfter < 45 && Math.abs(r.f.roll) < 5 && !r.f.crashed && r.altLoss < 30,
    `bank at release ${r.bankAtRelease.toFixed(1)}, max ${r.maxBankAfter.toFixed(1)}, after 30 s ${r.f.roll.toFixed(1)} deg, alt loss ${r.altLoss.toFixed(1)} m`);
  const r2 = rollPulse(1.0);
  check('4b. Full roll input 1 s, release: stops promptly, no divergence', r2.maxBankAfter <= r2.bankAtRelease + 12 && Math.abs(r2.f.roll) < 5 && !r2.f.crashed && r2.altLoss < 120,
    `bank at release ${r2.bankAtRelease.toFixed(1)}, max ${r2.maxBankAfter.toFixed(1)}, after 30 s ${r2.f.roll.toFixed(1)} deg, alt loss ${r2.altLoss.toFixed(1)} m`);

  // pitch pulse: must not porpoise
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 55, flatWorld, { throttle: 0.75 });
  const inp = newInput({ throttle: 0.75 });
  let crossings = 0, lastSign = 0, maxPitch = -99, pitchAtRelease = 0;
  fly(f, flatWorld, inp, 40, 1 / 60, (t) => {
    inp.pitch = t >= 2 && t < 3 ? 1 : 0;
    if (t >= 3) {
      if (!pitchAtRelease) pitchAtRelease = f.pitch;
      maxPitch = Math.max(maxPitch, f.pitch);
      const q = f.angularVelocity.x * DEG;
      const s = q > 0.5 ? 1 : q < -0.5 ? -1 : 0;
      if (s && lastSign && s !== lastSign) crossings++;
      if (s) lastSign = s;
    }
  });
  check('4c. Full pitch-up 1 s, release: holds attitude, no porpoising', crossings <= 2 && maxPitch < pitchAtRelease + 6 && Math.abs(f.verticalSpeed) < 2.5 && !f.crashed,
    `pitch at release ${pitchAtRelease.toFixed(1)}, max ${maxPitch.toFixed(1)}, pitch-rate reversals ${crossings}, vs after 37 s ${f.verticalSpeed.toFixed(2)} m/s`);

  // roll rate at cruise, full aileron
  const g = new FlightModel({ gearHeight: GEAR });
  g.resetAirborne(0, 800, 0, 0, 55, flatWorld, { throttle: 0.75 });
  let pMax = 0;
  fly(g, flatWorld, newInput({ throttle: 0.75, roll: 1 }), 1.2, 1 / 60, () => { pMax = Math.max(pMax, -g.angularVelocity.z * DEG); });
  note('Roll rate, full aileron, 55 m/s', `${pMax.toFixed(0)} deg/s`);
  check('4d. Roll rate at cruise 60-90 deg/s', pMax >= 60 && pMax <= 90, `${pMax.toFixed(0)} deg/s`);
}

// ---- 5. 30 deg banked turn -------------------------------------------------------------------
{
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 55, flatWorld, { throttle: 0.75 });
  const inp = newInput({ throttle: 0.75 });
  const turned = makeTracker(f);
  let minAlt = Infinity, maxAlt = -Infinity, turnTime = null, bankSum = 0, bankN = 0;
  fly(f, flatWorld, inp, 120, 1 / 60, (t) => {
    const p = -f.angularVelocity.z * DEG;
    inp.roll = clamp(0.04 * (30 - f.roll) - 0.02 * p, -1, 1);
    inp.pitch = clamp(0.1 * (800 - f.altitude) * 0.05 - 0.08 * f.verticalSpeed, -1, 1);
    const h = turned();
    if (t > 3) { bankSum += f.roll; bankN++; minAlt = Math.min(minAlt, f.altitude); maxAlt = Math.max(maxAlt, f.altitude); }
    if (h >= 360) { turnTime = t; return false; }
  });
  note('360 deg turn at 30 deg bank, 55 m/s', `${turnTime ? turnTime.toFixed(1) : '-'} s`);
  check('5. 30 deg bank 360 deg turn, altitude loss < 50 m', turnTime !== null && 800 - minAlt < 50 && !f.crashed,
    `time ${turnTime?.toFixed(1)} s, mean bank ${(bankSum / bankN).toFixed(1)}, alt range ${(minAlt - 800).toFixed(1)} / +${(maxAlt - 800).toFixed(1)} m`);
}

// ---- 6. stall --------------------------------------------------------------------------------
function stallSpeed(flaps) {
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 38, flatWorld, { throttle: 0, flaps });
  const inp = newInput({ throttle: 0, flaps });
  let vStall = null;
  fly(f, flatWorld, inp, 60, 1 / 60, () => {
    if (f.stalled) { vStall = f.airspeed; return false; }
    // hold altitude while bleeding speed (classic stall-speed technique)
    inp.pitch = clamp(0.05 * (800 - f.altitude) - 0.25 * f.verticalSpeed + (f.pitch < 0 ? 0.1 : 0.15), -1, 1);
  });
  return vStall;
}
{
  const vs0 = stallSpeed(0), vs1 = stallSpeed(1);
  note('Stall speed (1 g, idle)', `clean ${vs0?.toFixed(1)} m/s, full flaps ${vs1?.toFixed(1)} m/s`);
  check('6a. Stall speed clean ~23, full flaps ~20 m/s', vs0 > 21 && vs0 < 25.5 && vs1 > 18 && vs1 < 22.5, `clean ${vs0?.toFixed(1)}, flaps ${vs1?.toFixed(1)}`);

  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 30, flatWorld, { throttle: 0 });
  const inp = newInput({ throttle: 0 });
  let stalledAt = null, pitchAtStall = null, minPitchAfter = 99, recoveredAt = null, maxPitch = -99;
  fly(f, flatWorld, inp, 45, 1 / 60, (t) => {
    if (t < 15) { inp.pitch = 1; inp.throttle = 0; }
    else { inp.pitch = 0; inp.throttle = 0.75; }
    if (t < 15) maxPitch = Math.max(maxPitch, f.pitch);
    if (f.stalled && stalledAt === null) { stalledAt = t; pitchAtStall = f.pitch; }
    if (stalledAt !== null && t < 15) minPitchAfter = Math.min(minPitchAfter, f.pitch);
    if (t >= 15 && recoveredAt === null && !f.stalled) recoveredAt = t;
  });
  const nosedrop = maxPitch - minPitchAfter;
  check('6b. Idle + full nose-up: stalls, nose drops', stalledAt !== null && nosedrop > 5,
    `stalled at t=${stalledAt?.toFixed(1)} s, max pitch ${maxPitch.toFixed(1)}, then down to ${minPitchAfter.toFixed(1)} deg (drop ${nosedrop.toFixed(1)})`);
  check('6c. Release + power: recovers, flies level', recoveredAt !== null && recoveredAt - 15 < 2 && !f.stalled && f.airspeed > 35 && Math.abs(f.verticalSpeed) < 3 && f.altitude > 650 && !f.crashed,
    `unstalled ${(recoveredAt - 15).toFixed(2)} s after release, V ${f.airspeed.toFixed(1)} m/s, vs ${f.verticalSpeed.toFixed(2)} m/s, alt ${f.altitude.toFixed(0)} m`);
}

// ---- 7. gentle landing -----------------------------------------------------------------------
{
  const f = new FlightModel({ gearHeight: GEAR });
  const y0 = 20 + GEAR + 25;
  f.resetAirborne(0, y0, 500, 0, 30, flatWorld, { throttle: 0.3, flaps: 0.5, verticalSpeed: -1.5 });
  const inp = newInput({ throttle: 0.3, flaps: 0.5 });
  let td = null, tdPos = null, stopped = null, vsInt = 0, crashes = 0;
  f.on('touchdown', (i) => { if (!td) { td = i; tdPos = f.position.clone(); } });
  f.on('crash', () => crashes++);
  fly(f, flatWorld, inp, 80, 1 / 60, (t, f, inp, dt) => {
    if (!td) {
      const e = -1.5 - f.verticalSpeed;
      vsInt = clamp(vsInt + e * dt, -3, 3);
      inp.pitch = clamp(0.25 * e + 0.08 * vsInt, -1, 1);
      inp.throttle = clamp(0.35 + 0.08 * (30 - f.airspeed), 0, 1);
    } else {
      inp.pitch = 0; inp.throttle = 0; inp.brake = true;
      if (f.airspeed < 0.2) { stopped = f.position.clone(); return false; }
    }
  });
  const roll = stopped && tdPos ? stopped.distanceTo(tdPos) : NaN;
  note('Landing roll with brakes (from 30 m/s)', `${roll.toFixed(0)} m`);
  check('7. Gentle landing: touchdown event, no crash, stops < 400 m', td && !f.crashed && crashes === 0 && td.onRunway && roll < 400 && Math.abs(td.verticalSpeed + 1.5) < 0.6,
    `touchdown vs ${td?.verticalSpeed.toFixed(2)} m/s, pitch ${td?.pitch.toFixed(1)}, roll ${td?.roll.toFixed(1)}, onRunway ${td?.onRunway}, stop after ${roll.toFixed(0)} m`);
}

// ---- 8. crashes ------------------------------------------------------------------------------
function crashCase(world, setup, pilot, secs = 20) {
  const f = new FlightModel({ gearHeight: GEAR });
  setup(f);
  let events = 0, info = null, touchdowns = 0;
  f.on('crash', (i) => { events++; info = i; });
  f.on('touchdown', () => touchdowns++);
  const inp = newInput({ throttle: 0.3 });
  fly(f, world, inp, secs, 1 / 60, pilot);
  // stepping after the crash must be a no-op
  const p = f.position.clone();
  f.step(0.1, inp, world);
  return { f, events, info, touchdowns, frozen: p.equals(f.position) };
}
{
  const hard = crashCase(flatWorld, (f) => f.resetAirborne(0, 20 + GEAR + 3, 0, 0, 30, flatWorld, { throttle: 0.2, verticalSpeed: -7 }));
  check('8a. Hard landing (-7 m/s) crashes', hard.f.crashed && hard.events === 1 && hard.frozen, `reason "${hard.f.crashReason}", crash events ${hard.events}`);

  const firm = crashCase(flatWorld, (f) => f.resetAirborne(0, 20 + GEAR + 1.5, 0, 0, 30, flatWorld, { throttle: 0.2, verticalSpeed: -3.5 }), (t, f, inp) => { inp.throttle = 0; inp.brake = f.onGround; }, 30);
  check('8b. Firm landing (-3.5 m/s) survives', !firm.f.crashed && firm.touchdowns === 1, `crashed=${firm.f.crashed} ${firm.f.crashReason}`);

  const water = crashCase(waterWorld, (f) => f.resetAirborne(0, 12, -400, 0, 30, waterWorld, { throttle: 0.2, verticalSpeed: -1.5 }));
  check('8c. Water contact crashes', water.f.crashed && /su/i.test(water.f.crashReason), `reason "${water.f.crashReason}"`);

  const dive = crashCase(flatWorld, (f) => f.resetAirborne(0, 80, 0, 0, 50, flatWorld, { throttle: 0.5, pitch: -30, verticalSpeed: -25 }), (t, f, inp) => { inp.pitch = -0.3; });
  check('8d. Nose-down into terrain crashes', dive.f.crashed, `reason "${dive.f.crashReason}"`);

  const banked = crashCase(flatWorld, (f) => f.resetAirborne(0, 20 + GEAR + 1.0, 0, 0, 32, flatWorld, { throttle: 0.2, roll: 40, verticalSpeed: -1 }), (t, f, inp) => { inp.roll = 0.5; });
  check('8e. Touchdown with 40 deg bank crashes', banked.f.crashed, `reason "${banked.f.crashReason}"`);

  const cliff = crashCase(cliffWorld, (f) => f.resetAirborne(0, 150, 0, 0, 50, cliffWorld, { throttle: 0.75 }), null, 30);
  check('8f. Flying into a cliff crashes', cliff.f.crashed && cliff.f.position.z > -420, `reason "${cliff.f.crashReason}" at z=${cliff.f.position.z.toFixed(0)}`);

  // taxi into the lake
  const taxi = crashCase(waterWorld, (f) => f.reset(0, -150, 0, waterWorld), (t, f, inp) => { inp.throttle = 0.4; }, 60);
  check('8g. Taxiing into water crashes', taxi.f.crashed && /su/i.test(taxi.f.crashReason), `reason "${taxi.f.crashReason}"`);
}

// ---- 9. dt robustness ------------------------------------------------------------------------
function scripted(dt) {
  const f = new FlightModel({ gearHeight: GEAR });
  f.reset(0, spawnZ, 0, flatWorld);
  const inp = newInput();
  let bad = false;
  fly(f, flatWorld, inp, 20, dt, (t) => {
    inp.throttle = 1;
    inp.pitch = t > 11 && t < 14 ? 0.5 : 0;
    inp.roll = t > 15 && t < 16 ? 0.4 : 0;
    inp.yaw = t > 2 && t < 3 ? 0.3 : 0;
    if (!finite(f)) bad = true;
  });
  return { f, bad };
}
function scriptedAir(dt) {
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 800, 0, 0, 50, flatWorld, { throttle: 0.75 });
  const inp = newInput({ throttle: 0.75 });
  let bad = false;
  fly(f, flatWorld, inp, 20, dt, (t) => {
    inp.pitch = t > 2 && t < 4 ? 0.6 : t > 8 && t < 9 ? -0.5 : 0;
    inp.roll = t > 5 && t < 7 ? -0.7 : 0;
    inp.yaw = t > 12 && t < 14 ? 0.5 : 0;
    inp.throttle = t > 10 ? 0.2 : 0.75;
    if (!finite(f)) bad = true;
  });
  return { f, bad };
}
{
  for (const [label, fn] of [['ground roll + takeoff', scripted], ['air maneuvers', scriptedAir]]) {
    const a = fn(1 / 60), b = fn(0.1), c = fn(0.016);
    const d = a.f.position.distanceTo(b.f.position);
    const dc = a.f.position.distanceTo(c.f.position);
    const dv = Math.abs(a.f.airspeed - b.f.airspeed);
    const dh = Math.abs(((a.f.heading - b.f.heading + 540) % 360) - 180);
    check(`9. dt 0.1 vs 0.016 (${label}), 20 s`, !a.bad && !b.bad && !c.bad && d < 10 && dv < 1 && dh < 3 && !b.f.crashed,
      `position diff ${d.toFixed(2)} m (0.016 vs 1/60: ${dc.toFixed(2)} m), speed diff ${dv.toFixed(2)} m/s, heading diff ${dh.toFixed(2)} deg`);
  }
  // extreme: random inputs with dt = 0.1 never produce NaN
  const f = new FlightModel({ gearHeight: GEAR });
  f.resetAirborne(0, 1500, 0, 0, 50, flatWorld, { throttle: 0.75 });
  const inp = newInput({ throttle: 0.75 });
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  let bad = false;
  fly(f, flatWorld, inp, 60, 0.1, () => { inp.pitch = rnd(); inp.roll = rnd(); inp.yaw = rnd(); inp.throttle = (rnd() + 1) / 2; if (!finite(f)) bad = true; });
  check('9b. Random stick-stirring with dt = 0.1 for 60 s: finite state', !bad && finite(f), `alt ${f.altitude.toFixed(0)} m, V ${f.airspeed.toFixed(1)} m/s, crashed=${f.crashed}`);
}

// ---- report ----------------------------------------------------------------------------------
const w = Math.max(...results.map((r) => r.name.length));
console.log('\nFlight model tests\n' + '-'.repeat(w + 60));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
console.log('-'.repeat(w + 60));
console.log('Measured:');
for (const m of measured) console.log(`  ${m.name.padEnd(42)} ${m.value}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
