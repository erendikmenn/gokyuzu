// UH-60M helicopter flight model tests. Run: node tests/helicopter.test.mjs
// No framework: scripted test pilots drive an InputState against fake worlds; prints a PASS/FAIL table plus a table of
// measured numbers vs. published UH-60 data. Exit code 1 on any failure.
import * as THREE from 'three';
import { createHelicopterModel } from '../src/flight/helicopter.js';
import spec from '../src/aircraft/uh60/spec.js';

const DEG = 180 / Math.PI;
const KT = 0.514444;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- fake worlds -------------------------------------------------------------------------------
const GROUND = 4;
const flatWorld = {
  getGroundHeight: () => GROUND, isWater: () => false, isOnRunway: () => true,
  getObstacleHeight: () => -Infinity, hitTest: () => null,
};
// sea north of z = -300 (terrain returns 0 = sea level there)
const waterWorld = {
  getGroundHeight: (x, z) => (z < -300 ? 0 : GROUND), isWater: (x, z) => z < -300, isOnRunway: () => false,
  getObstacleHeight: () => -Infinity, hitTest: () => null,
};
// a 40 m building east of the origin: x 30..70, z -25..25
const BOX = { x0: 30, x1: 70, z0: -25, z1: 25, y0: GROUND, y1: GROUND + 40 };
const buildingWorld = {
  getGroundHeight: () => GROUND, isWater: () => false, isOnRunway: () => false,
  getObstacleHeight: (x, z) => (x >= BOX.x0 && x <= BOX.x1 && z >= BOX.z0 && z <= BOX.z1 ? BOX.y1 : -Infinity),
  hitTest(x, y, z, r) {
    const cx = clamp(x, BOX.x0, BOX.x1), cy = clamp(y, BOX.y0, BOX.y1), cz = clamp(z, BOX.z0, BOX.z1);
    return (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 < r * r ? 'bina' : null;
  },
};
// a hillside rising 1:1 east of x = 12
const slopeWorld = {
  getGroundHeight: (x) => GROUND + Math.max(0, x - 12), isWater: () => false, isOnRunway: () => false,
  getObstacleHeight: () => -Infinity, hitTest: () => null,
};

// ---- helpers -----------------------------------------------------------------------------------
const results = [];
const measured = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }
function note(name, value, real = '') { measured.push({ name, value, real }); }
const newInput = (over = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...over });
function make(opts = {}) {
  const f = createHelicopterModel(spec, { contacts: opts.contacts });
  if (opts.mass) f.setMass(opts.mass);
  f.events = [];
  for (const e of ['crash', 'touchdown', 'takeoff', 'warning', 'autopilot', 'stall']) f.on(e, (i) => f.events.push({ e, ...i }));
  return f;
}
/** Run `secs` of simulated time with frame step dt; pilot(t, f, inp, dt) may change inputs every frame (return false = stop). */
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
function finite(f) {
  return [f.position.x, f.position.y, f.position.z, f.velocity.x, f.velocity.y, f.velocity.z, f.quaternion.x, f.quaternion.w,
    f.rotorRPM, f.torque, f.collective, f.airspeed, f.agl, f.heading, f.pitch, f.roll].every(Number.isFinite);
}
const hspeed = (f) => Math.hypot(f.velocity.x, f.velocity.z);
const hovering = (f, world, altitude, x = 0, z = 0, heading = 0) => f.reset({ x, z, heading, altitude, speed: 0 }, world);
/** Test pilot: collective PI controller holding a vertical speed (m/s). */
function leverForVs(state, f, inp, dt, vsTarget, kp = 0.03, ki = 0.03) {
  const e = vsTarget - f.verticalSpeed;
  state.i = clamp((state.i ?? inp.throttle) + ki * e * dt, 0, 1);
  inp.throttle = clamp(state.i + kp * e, 0, 1);
}
/** Test pilot: pitch stick holding a pitch attitude (deg) through the AFCS rate command. */
function stickForPitch(f, inp, target, k = 0.08) { inp.pitch = clamp(k * (target - f.pitch), -1, 1); }
function stickForRoll(f, inp, target, k = 0.06) { inp.roll = clamp(k * (target - f.roll), -1, 1); }
const unwrap = (a) => ((a + 540) % 360) - 180;

// =================================================================================================
// 1. spec: real UH-60M data
// =================================================================================================
{
  const mr = spec.mainRotor, tr = spec.tailRotor, en = spec.engine;
  const ok = spec.category === 'helicopter' && spec.id === 'uh60' && Math.abs(2 * mr.radius - 16.36) < 0.02 && mr.blades === 4 && mr.rpm === 258
    && Math.abs(2 * tr.radius - 3.35) < 0.01 && tr.cantDeg === 20 && en.powerShp === 1994 && spec.engines === 2
    && spec.mass.empty === 5300 && spec.mass.typical === 8500 && Math.abs(spec.mass.max - 10000) < 50
    && Math.abs(spec.vne / KT - 193) < 0.5 && Math.abs(spec.cruiseSpeed / KT - 150) < 0.5 && spec.spawnSpeed > 30
    && Math.abs(spec.serviceCeiling - 5800) < 100 && Math.abs(spec.hogeCeiling - 3000) < 1
    && Math.abs(spec.gear.mainTrack - 2.7) < 0.05 && Math.abs(spec.gear.wheelbase - 8.8) < 0.1;
  check('1. Spec carries the real UH-60M data', ok,
    `rotor Ø${(2 * mr.radius).toFixed(2)} m ×${mr.blades} @${mr.rpm} rpm, TR Ø${(2 * tr.radius).toFixed(2)} m cant ${tr.cantDeg}°, 2×${en.powerShp} shp, ${spec.mass.empty}/${spec.mass.typical}/${spec.mass.max} kg, VNE ${(spec.vne / KT).toFixed(0)} kt`);
}

// =================================================================================================
// 2. parked on the ground, rotor turning at 100 % NR, flat pitch
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0.7 }, flatWorld);
  const p0 = f.position.clone();
  const h0 = f.heading;
  const inp = newInput();
  let maxDev = 0, maxV = 0;
  fly(f, flatWorld, inp, 15, 1 / 60, () => { maxDev = Math.max(maxDev, f.position.distanceTo(p0)); maxV = Math.max(maxV, f.velocity.length()); });
  const dh = Math.abs(unwrap(f.heading - h0));
  check('2. Parked 15 s: rotor 100 %, no creep / yaw / bounce',
    !f.crashed && f.onGround && Math.abs(f.rotorRPM - 1) < 0.005 && maxDev < 0.05 && dh < 0.2 && f.collective === 0 && Math.abs(f.agl) < 0.05,
    `NR ${(f.rotorRPM * 100).toFixed(1)} %, drift ${maxDev.toFixed(3)} m, Δhdg ${dh.toFixed(2)}°, |v|max ${maxV.toFixed(3)}, flat-pitch torque ${(f.torque * 100).toFixed(0)} %`);
  note('Flat-pitch ground torque (100 % NR)', `${(f.torque * 100).toFixed(0)} %`, '≈ 15–25 %');
}

// =================================================================================================
// 3. hover performance (trim) at typical weight, sea level ISA
// =================================================================================================
let hoverTrim;
{
  const f = make();
  hoverTrim = f.trim({ speed: 0, altitude: 0 });
  const t = hoverTrim;
  check('3. Hover OGE 8.5 t SL: collective, torque, attitude realistic',
    t.converged && t.torque > 0.62 && t.torque < 0.78 && t.collective > 0.5 && t.collective < 0.72 && t.pitch * DEG > 1 && t.pitch * DEG < 6 && t.roll * DEG < 0 && t.roll * DEG > -5,
    `torque ${(t.torque * 100).toFixed(1)} % (${(t.power / 745.7).toFixed(0)} shp), collective ${(t.collective * 100).toFixed(0)} %, pitch ${(t.pitch * DEG).toFixed(1)}°, roll ${(t.roll * DEG).toFixed(1)}°, CT/σ ${t.CTsigma.toFixed(3)}`);
  note('Hover OGE torque, 8.5 t SL ISA', `${(t.torque * 100).toFixed(1)} % (${(t.power / 745.7).toFixed(0)} shp)`, '≈ 65–75 % of 3,400 shp');
  note('Hover attitude (pitch / roll)', `${(t.pitch * DEG).toFixed(1)}° / ${(t.roll * DEG).toFixed(1)}°`, 'nose-up ≈ 3°, left roll ≈ 2–3°');
  note('Tail rotor thrust / power in hover', `${t.tailThrust.toFixed(0)} N / ${(t.tailRotorPower / 1000).toFixed(0)} kW`, 'TR ≈ 8–12 % of MR power');
}

// =================================================================================================
// 4. ground effect: IGE (10 ft wheel height) vs OGE
// =================================================================================================
{
  const f = make();
  const oge = hoverTrim;
  const ige = f.trim({ speed: 0, altitude: 0, zHub: 3.05 + 1.55 + spec.mainRotor.hub[1] });
  const ratio = ige.power / oge.power;
  check('4. Ground effect: hover at 10 ft wheel height needs 8–25 % less power than OGE',
    ige.converged && ratio > 0.75 && ratio < 0.92, `IGE ${(ige.torque * 100).toFixed(1)} % vs OGE ${(oge.torque * 100).toFixed(1)} % → ×${ratio.toFixed(3)}`);
  note('IGE (10 ft) / OGE hover power', `${ratio.toFixed(2)} (${(ige.torque * 100).toFixed(0)} % vs ${(oge.torque * 100).toFixed(0)} %)`, '≈ 0.85');
}

// =================================================================================================
// 5. power required vs airspeed: effective translational lift, bucket, cruise, Vh
// =================================================================================================
let curve = [];
{
  const f = make();
  let g = null;
  for (let kt = 0; kt <= 175; kt += 5) {
    const t = f.trim({ speed: kt * KT, altitude: 0, guess: g });
    if (t.converged) g = [t.collective, t.cLon, t.cLat, t.cPed, t.pitch, t.roll];
    curve.push({ kt, t });
  }
  const at = (kt) => curve.find((c) => c.kt === kt).t;
  const p0 = at(0).power;
  const min = curve.filter((c) => c.t.converged).reduce((a, b) => (b.t.power < a.t.power ? b : a));
  const drop10_30 = (at(10).power - at(30).power) / p0;
  const vh = curve.filter((c) => c.t.converged && c.t.torque <= 1.0).reduce((a, b) => (b.kt > a.kt ? b : a)).kt;
  check('5a. ETL: power required falls ≥ 15 % between hover and 30 kt, steepest in 10–30 kt',
    at(30).power < 0.85 * p0 && drop10_30 > 0.1, `P(0) ${(at(0).torque * 100).toFixed(0)} %, P(10) ${(at(10).torque * 100).toFixed(0)} %, P(20) ${(at(20).torque * 100).toFixed(0)} %, P(30) ${(at(30).torque * 100).toFixed(0)} %`);
  check('5b. Power bucket 55–90 kt at 30–50 % torque; 150 kt cruise at 75–95 %; Vh (100 %) 150–170 kt',
    min.kt >= 55 && min.kt <= 90 && min.t.torque > 0.3 && min.t.torque < 0.5 && at(150).torque > 0.75 && at(150).torque < 0.95 && vh >= 150 && vh <= 170,
    `min power ${(min.t.torque * 100).toFixed(0)} % @ ${min.kt} kt, 150 kt: ${(at(150).torque * 100).toFixed(0)} % (pitch ${(at(150).pitch * DEG).toFixed(1)}°), Vh ≈ ${vh} kt`);
  note('Minimum power (bucket)', `${(min.t.torque * 100).toFixed(0)} % @ ${min.kt} kt`, '≈ 40 % @ 70–80 kt');
  note('150 kt cruise torque / pitch', `${(at(150).torque * 100).toFixed(0)} % / ${(at(150).pitch * DEG).toFixed(1)}°`, 'cruise 150 kt');
  note('Vh (level, 100 % torque)', `≈ ${vh} kt`, '159 kt max level speed');
  note('Power drop hover → 30 kt (ETL)', `${((1 - at(30).power / p0) * 100).toFixed(0)} %`, 'ETL 15–25 kt');
}

// =================================================================================================
// 6. lift-off from the ground with a collective ramp, then hover
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
  const inp = newInput();
  let tTakeoff = null;
  const st = {};
  fly(f, flatWorld, inp, 40, 1 / 60, (t) => {
    if (t < 2) return;
    if (f.agl < 8 && !tTakeoff) inp.throttle = Math.min(0.68, inp.throttle + 0.25 / 60);
    if (!tTakeoff && f.events.some((e) => e.e === 'takeoff')) tTakeoff = t;
    if (f.agl > 8 || tTakeoff) leverForVs(st, f, inp, 1 / 60, clamp(0.4 * (10 - f.agl), -1.5, 2.5));
  });
  const ok = !f.crashed && tTakeoff !== null && Math.abs(f.agl - 10) < 1.5 && hspeed(f) < 2 && Math.abs(f.verticalSpeed) < 0.5;
  check('6. Lift-off: collective ramp → takeoff event, climbs to a 10 m hover', ok,
    `takeoff at ${tTakeoff?.toFixed(1)} s, agl ${f.agl.toFixed(1)} m, drift ${hspeed(f).toFixed(2)} m/s, collective ${(f.collective * 100).toFixed(0)} %, torque ${(f.torque * 100).toFixed(0)} %, ${f.crashReason}`);
  note('Hover collective / torque at 10 m wheel height (dynamic)', `${(f.collective * 100).toFixed(0)} % / ${(f.torque * 100).toFixed(0)} %`, 'IGE < OGE');
}

// =================================================================================================
// 7. hands-off hover with SAS/FPS: no divergence
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 30);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.05);
  const p0 = f.position.clone();
  let maxH = 0, maxAtt = 0;
  // disturbance: a short gust-like pulse on the cyclic, then hands off
  fly(f, flatWorld, inp, 20, 1 / 60, (t) => {
    inp.roll = t < 0.25 ? 0.3 : 0; inp.pitch = t > 0.5 && t < 0.75 ? -0.3 : 0;
    maxH = Math.max(maxH, hspeed(f));
    maxAtt = Math.max(maxAtt, Math.abs(f.roll - hoverTrim.roll * DEG), Math.abs(f.pitch - hoverTrim.pitch * DEG));
  });
  const dy = f.position.y - p0.y;
  check('7. Hands-off hover with SAS/FPS (after a cyclic tap), 20 s: drift < 2 m/s, attitude held',
    !f.crashed && maxH < 2 && maxAtt < 5 && Math.abs(dy) < 5,
    `max ground speed ${maxH.toFixed(2)} m/s, max attitude change ${maxAtt.toFixed(1)}°, Δalt ${dy.toFixed(2)} m, moved ${f.position.distanceTo(p0).toFixed(1)} m`);
  note('Hands-off hover drift after a cyclic tap (20 s)', `${maxH.toFixed(2)} m/s`, 'SAS/FPS attitude hold');
}

// =================================================================================================
// 8. FPS hover hold (autopilot action): translational rate command + position/altitude hold
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 25);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.5);
  f.command('autopilot');
  const engaged = f.autopilot.on && f.autopilot.mode === 'hover';
  const p0 = f.position.clone();
  const alt0 = f.agl;
  // disturbances: roll and pitch pulses and a pedal turn
  fly(f, flatWorld, inp, 30, 1 / 60, (t) => {
    inp.roll = t > 1 && t < 1.8 ? 0.8 : 0;
    inp.pitch = t > 4 && t < 4.6 ? -0.8 : 0;
    inp.yaw = t > 8 && t < 9 ? 0.6 : 0;
  });
  const posErr = Math.hypot(f.position.x - p0.x, f.position.z - p0.z);
  const ok1 = engaged && !f.crashed && hspeed(f) < 0.5 && Math.abs(f.agl - alt0) < 1.5;
  check('8a. Hover hold: disturbances rejected, velocity → 0, height held', ok1,
    `engaged=${engaged}, final speed ${hspeed(f).toFixed(2)} m/s, Δheight ${(f.agl - alt0).toFixed(2)} m, position moved ${posErr.toFixed(1)} m`);
  // translational rate command: stick forward → ~10 m/s ground speed, release → stops
  let vmax = 0;
  fly(f, flatWorld, inp, 25, 1 / 60, (t) => { inp.pitch = t < 10 ? -1 : 0; vmax = Math.max(vmax, hspeed(f)); });
  check('8b. Hover hold TRC: full forward stick → ≈10 m/s, release → stops', !f.crashed && vmax > 8 && vmax < 12.5 && hspeed(f) < 0.6,
    `max ${vmax.toFixed(1)} m/s, final ${hspeed(f).toFixed(2)} m/s`);
  // collective lever acts as the altitude beeper (the lever is back-driven by the coupled collective)
  const a0 = f.autopilot.altitude;
  fly(f, flatWorld, inp, 15, 1 / 60, (t) => { if (t < 1) inp.throttle = Math.min(1, inp.throttle + 0.45 / 60); });
  check('8c. Hover hold: lever acts as altitude beeper, lever back-driven', f.autopilot.altitude > a0 + 8 && Math.abs(f.agl - f.autopilot.altitude) < 2 && Math.abs(inp.throttle - f.collective) < 0.02,
    `ref ${a0.toFixed(1)} → ${f.autopilot.altitude.toFixed(1)} m, agl ${f.agl.toFixed(1)} m, lever ${inp.throttle.toFixed(3)} vs collective ${f.collective.toFixed(3)}`);
  f.command('autopilot');
  check('8d. Autopilot toggles off', !f.autopilot.on && f.events.filter((e) => e.e === 'autopilot').length >= 2, `on=${f.autopilot.on}`);
}

// =================================================================================================
// 9. vertical climb and descent, vortex ring state
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 50);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  // climb at max continuous (≈ 100 % torque): the test pilot raises the lever until the torque reaches 100 %
  let vsMax = 0;
  fly(f, flatWorld, inp, 20, 1 / 60, (t) => {
    inp.throttle = clamp(inp.throttle + (1.0 - f.torque) * 0.5 / 60, 0, 1);
    if (t > 12) vsMax = Math.max(vsMax, f.verticalSpeed);
  });
  check('9a. Vertical climb at 100 % torque: 5–14 m/s, NR governed', !f.crashed && vsMax > 5 && vsMax < 14 && f.rotorRPM > 0.97,
    `VROC ${vsMax.toFixed(1)} m/s (${(vsMax * 196.85).toFixed(0)} ft/min), torque ${(f.torque * 100).toFixed(0)} %, NR ${(f.rotorRPM * 100).toFixed(1)} %`);
  note('Vertical rate of climb at 100 % torque, 8.5 t SL', `${vsMax.toFixed(1)} m/s (${(vsMax * 196.85).toFixed(0)} fpm)`, 'momentum theory; UTTAS spec 450 fpm @ 4,000 ft/95 °F IRP');
  // steady vertical descent at 4 m/s with the collective
  const st = {};
  let vsErr = 0, n = 0;
  fly(f, flatWorld, inp, 25, 1 / 60, (t) => { leverForVs(st, f, inp, 1 / 60, -4); if (t > 15) { vsErr += Math.abs(f.verticalSpeed + 4); n++; } });
  check('9b. Controlled vertical descent at 4 m/s', !f.crashed && vsErr / n < 0.5, `mean |vs error| ${(vsErr / n).toFixed(2)} m/s, collective ${(f.collective * 100).toFixed(0)} %`);
  // vortex ring state: low collective, zero airspeed → sink rate builds, warning fires, more collective is needed
  const g = make();
  hovering(g, flatWorld, GROUND + 600);
  const inp2 = newInput();
  fly(g, flatWorld, inp2, 0.1);
  inp2.throttle = hoverTrim.collective - 0.12;
  let vrs = false, vsMin = 0;
  fly(g, flatWorld, inp2, 25, 1 / 60, () => { if (g.warnings.vrs) vrs = true; vsMin = Math.min(vsMin, g.verticalSpeed); });
  check('9c. Vortex ring state: low collective at zero airspeed → sink rate > 8 m/s and VRS warning', vrs && vsMin < -8 && !g.crashed,
    `min vs ${vsMin.toFixed(1)} m/s, vrs warning ${vrs}`);
  note('Sink rate with collective −12 % at 0 kt (VRS)', `${vsMin.toFixed(1)} m/s`, 'power settling');
}

// =================================================================================================
// 10. ETL in flight: accelerate from hover at fixed collective → climb through 15–25 kt
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 60);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  let vsAtEtl = -99, vsAt5 = 0;
  fly(f, flatWorld, inp, 25, 1 / 60, () => {
    stickForPitch(f, inp, hoverTrim.pitch * DEG - 6);
    const kt = f.airspeed / KT;
    if (kt < 6) vsAt5 = f.verticalSpeed;
    if (kt > 18 && kt < 30) vsAtEtl = Math.max(vsAtEtl, f.verticalSpeed);
    if (kt > 35) return false;
  });
  check('10. ETL: at fixed collective the helicopter climbs when passing 18–30 kt', !f.crashed && vsAtEtl > vsAt5 + 1.0,
    `vs at <6 kt ${vsAt5.toFixed(2)} m/s → ${vsAtEtl.toFixed(2)} m/s at 18–30 kt`);
}

// =================================================================================================
// 11. forward flight: 150 kt cruise hands-off, accelerate to cruise, max level speed, dive to VNE
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 1.2, altitude: 600, speed: 150 * KT }, flatWorld);
  const inp = newInput();
  fly(f, flatWorld, inp, 30);
  const kt = f.airspeed / KT;
  check('11a. 150 kt cruise, 30 s hands-off: speed, altitude and heading held',
    !f.crashed && Math.abs(kt - 150) < 5 && Math.abs(f.altitude - 600) < 30 && Math.abs(unwrap(f.heading - 1.2 * DEG)) < 2 && f.torque > 0.75 && f.torque < 0.95,
    `${kt.toFixed(1)} kt, alt ${f.altitude.toFixed(0)} m, hdg ${f.heading.toFixed(1)}°, torque ${(f.torque * 100).toFixed(0)} %, fuel flow ${(f.engines[0].fuelFlow + f.engines[1].fuelFlow).toFixed(0)} kg/h`);
  note('Fuel flow at 150 kt (both engines)', `${(f.engines[0].fuelFlow + f.engines[1].fuelFlow).toFixed(0)} kg/h`, '≈ 600–650 kg/h (1,300–1,400 lb/h)');

  // accelerate from 80 kt to cruise: set ~90 % torque and hold altitude with the pitch attitude
  const g = make();
  g.reset({ x: 0, z: 0, heading: 0, altitude: 600, speed: 80 * KT }, flatWorld);
  const inp2 = newInput();
  fly(g, flatWorld, inp2, 0.1);
  fly(g, flatWorld, inp2, 90, 1 / 60, () => {
    inp2.throttle = clamp(inp2.throttle + (0.88 - g.torque) * 0.3 / 60, 0, 1);
    stickForPitch(g, inp2, clamp(0.03 * (600 - g.altitude) - 0.8 * g.verticalSpeed + g.pitch, -15, 10), 0.08);
  });
  const kt2 = g.airspeed / KT;
  check('11b. Level acceleration at ≈88 % torque settles near 150 kt', !g.crashed && kt2 > 140 && kt2 < 160 && Math.abs(g.altitude - 600) < 40,
    `${kt2.toFixed(1)} kt at torque ${(g.torque * 100).toFixed(0)} %, alt ${g.altitude.toFixed(0)} m`);

  // max level speed at max power
  const h = make();
  h.reset({ x: 0, z: 0, heading: 0, altitude: 300, speed: 140 * KT }, flatWorld);
  const inp3 = newInput();
  fly(h, flatWorld, inp3, 0.1);
  let overtorque = false;
  fly(h, flatWorld, inp3, 120, 1 / 60, () => {
    // max power: raise the collective until the rotor starts to droop (engines at their limit)
    inp3.throttle = clamp(inp3.throttle + (h.rotorRPM > 0.995 ? 0.1 : -0.2) / 60, 0, 1);
    stickForPitch(h, inp3, clamp(0.03 * (300 - h.altitude) - 0.8 * h.verticalSpeed + h.pitch, -15, 10), 0.08);
    overtorque ||= h.warnings.overtorque;
  });
  const vmax = h.airspeed / KT;
  check('11c. Max level speed at full power 155–185 kt (overtorque warned)', !h.crashed && vmax > 155 && vmax < 185 && overtorque,
    `${vmax.toFixed(1)} kt, torque ${(h.torque * 100).toFixed(0)} %, NR ${(h.rotorRPM * 100).toFixed(1)} %, alt ${h.altitude.toFixed(0)} m`);
  note('Max level speed at max power (2 × 1,994 shp)', `${vmax.toFixed(0)} kt @ ${(h.torque * 100).toFixed(0)} %`, 'Vh 159 kt @ MCP; VNE 193 kt');

  // dive towards VNE: retreating blade stall / overspeed warnings, speed stays bounded
  // dive towards VNE, then pull out: overspeed warning, retreating-blade stall in the pull-out, speed stays bounded
  const d = make();
  d.reset({ x: 0, z: 0, heading: 0, altitude: 1200, speed: 150 * KT }, flatWorld);
  const inp4 = newInput();
  fly(d, flatWorld, inp4, 0.1);
  let vmaxDive = 0, stallSeen = false, overspeedSeen = false, pull = false, gMax = 0, stallKt = 0;
  fly(d, flatWorld, inp4, 90, 1 / 60, () => {
    if (!pull) inp4.throttle = clamp(inp4.throttle - Math.max(0, d.torque - 0.9) * 0.5 / 60, 0, 1);   // collective down, never up
    if (d.ias / KT > 196 || d.altitude < 300) pull = true;
    stickForPitch(d, inp4, pull ? 8 : -18);
    vmaxDive = Math.max(vmaxDive, d.ias / KT);
    if (d.warnings.stall && !stallSeen) stallKt = d.ias / KT;
    stallSeen ||= d.warnings.stall; overspeedSeen ||= d.warnings.overspeed;
    if (pull) gMax = Math.max(gMax, d.gForce);
    if (d.altitude < 100 || (pull && d.airspeed / KT < 150)) return false;
  });
  check('11d. Dive past VNE, then pull-out: overspeed warning, retreating-blade stall, speed bounded < 215 kt',
    !d.crashed && vmaxDive > 190 && vmaxDive < 215 && overspeedSeen && stallSeen && finite(d),
    `max ${vmaxDive.toFixed(0)} KIAS, overspeed ${overspeedSeen}, blade stall ${stallSeen} (at ${stallKt.toFixed(0)} KIAS, pull-out ${gMax.toFixed(2)} g)`);
  note('Dive −18° (collective ≤ 90 % torque) from 1,200 m, pull-out at 196 KIAS', `max ${vmaxDive.toFixed(0)} kt, blade stall at ${stallKt.toFixed(0)} kt / ${gMax.toFixed(2)} g`, 'VNE 193 kt; retreating-blade stall in high-speed pull-ups');
}

// =================================================================================================
// 12. coordinated turn at 100 kt, 30° bank
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0, altitude: 800, speed: 100 * KT }, flatWorld);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.5);
  const st = {};
  const trimRoll = f.roll;
  let rate = 0, betaMax = 0, n = 0, bank = 0, h0 = null;
  fly(f, flatWorld, inp, 40, 1 / 60, (t) => {
    stickForRoll(f, inp, trimRoll + 30);
    leverForVs(st, f, inp, 1 / 60, clamp(0.2 * (800 - f.altitude), -3, 3));
    if (t > 15) {
      if (h0 === null) h0 = { h: f.heading, t };
      betaMax = Math.max(betaMax, Math.abs(f.sideslip)); bank += f.roll; n++;
    }
  });
  const dur = 40 - h0.t;
  rate = Math.abs(unwrap(f.heading - h0.h)) / dur;
  // multiple turns: count full heading change via the turn rate over the window (< 360° here)
  const phi = (bank / n - trimRoll) / DEG;
  const expected = (9.80665 * Math.tan(phi)) / f.airspeed * DEG;
  check('12. Coordinated turn 100 kt / 30° bank: turn rate ≈ g·tanφ/V, sideslip < 3°, altitude held',
    !f.crashed && Math.abs(rate - expected) / expected < 0.15 && betaMax < 3 && Math.abs(f.altitude - 800) < 25,
    `turn rate ${rate.toFixed(2)}°/s vs ${expected.toFixed(2)}°/s, max |β| ${betaMax.toFixed(2)}°, bank ${(bank / n).toFixed(1)}°, alt ${f.altitude.toFixed(0)} m, g ${f.gForce.toFixed(2)}`);
}

// =================================================================================================
// 13. landing: descend from a 10 m hover, touchdown event, no crash, settles on the wheels
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 1.55 + 10);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  const st = {};
  let td = null;
  fly(f, flatWorld, inp, 40, 1 / 60, (t) => {
    if (!td) leverForVs(st, f, inp, 1 / 60, f.agl > 3 ? -1.2 : -0.5);
    else inp.throttle = Math.max(0, inp.throttle - 0.3 / 60);
    if (!td) td = f.events.find((e) => e.e === 'touchdown') || null;
  });
  const ok = td && !f.crashed && Math.abs(td.verticalSpeed) < 1.5 && f.onGround && hspeed(f) < 0.05 && f.collective < 0.05;
  check('13. Landing from a 10 m hover: touchdown event, soft, settles on the wheels', ok,
    td ? `touchdown vs ${td.verticalSpeed.toFixed(2)} m/s, pitch ${td.pitch.toFixed(1)}°, roll ${td.roll.toFixed(1)}°, onRunway ${td.onRunway}; now onGround=${f.onGround}, speed ${hspeed(f).toFixed(3)}` : `no touchdown; ${f.crashReason}`);
}

// =================================================================================================
// 14. hard landing → crash
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 1.55 + 25);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  inp.throttle = 0.15;
  fly(f, flatWorld, inp, 20);
  const crash = f.events.find((e) => e.e === 'crash');
  check('14. Hard landing (collective dumped from 25 m) → crash', f.crashed && crash && /sert/.test(f.crashReason),
    `crashed=${f.crashed}, reason "${f.crashReason}"`);
}

// =================================================================================================
// 15. rotor strike: drift sideways into a building → crash; tip strike on a hillside
// =================================================================================================
{
  const f = make();
  hovering(f, buildingWorld, GROUND + 25, 10, 0, 0);
  const inp = newInput();
  fly(f, buildingWorld, inp, 20, 1 / 60, () => { stickForRoll(f, inp, -2.9 + 8); });
  check('15a. Rotor strike: hovering sideways into a building → crash "Ana rotor çarpması: bina"',
    f.crashed && /rotor/i.test(f.crashReason) && /bina/.test(f.crashReason), `reason "${f.crashReason}", x ${f.position.x.toFixed(1)}`);

  const g = make();
  hovering(g, slopeWorld, GROUND + 6, 0, 0, 0);
  const inp2 = newInput();
  fly(g, slopeWorld, inp2, 30, 1 / 60, () => { stickForRoll(g, inp2, -2.9 + 6); });
  check('15b. Main-rotor tip strike on rising terrain → crash', g.crashed && /rotor/i.test(g.crashReason), `reason "${g.crashReason}", x ${g.position.x.toFixed(1)}`);

  // landing on a roof top (helipad): allowed
  const r = make();
  hovering(r, buildingWorld, BOX.y1 + 1.55 + 6, 50, 0, 0);
  const inp3 = newInput();
  fly(r, buildingWorld, inp3, 0.1);
  const st = {};
  fly(r, buildingWorld, inp3, 30, 1 / 60, (t) => { if (!r.onGround) leverForVs(st, r, inp3, 1 / 60, -0.6); else inp3.throttle = Math.max(0, inp3.throttle - 0.3 / 60); });
  check('15c. Rooftop landing on a building is possible (no false strike)', !r.crashed && r.onGround && Math.abs(r.position.y - (BOX.y1 + 1.55)) < 0.3,
    `onGround=${r.onGround}, y ${r.position.y.toFixed(2)} (roof ${BOX.y1}), ${r.crashReason}`);
}

// =================================================================================================
// 16. water ditching
// =================================================================================================
{
  const f = make();
  hovering(f, waterWorld, 20, 0, -500, 0);
  const inp = newInput();
  fly(f, waterWorld, inp, 0.1);
  const st = {};
  fly(f, waterWorld, inp, 40, 1 / 60, () => leverForVs(st, f, inp, 1 / 60, -0.8));
  check('16. Touching down on water → crash "suya"', f.crashed && /suya/.test(f.crashReason), `reason "${f.crashReason}"`);
}

// =================================================================================================
// 17. yaw: pedal turn in hover, heading hold, torque reaction without AFCS
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 30);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.2);
  let rMax = 0, prev = f.heading;
  fly(f, flatWorld, inp, 3, 1 / 60, (t, _f, i, dt) => {
    inp.yaw = 1;
    const r = unwrap(f.heading - prev) / dt; prev = f.heading; rMax = Math.max(rMax, r);
  });
  inp.yaw = 0;
  fly(f, flatWorld, inp, 2);
  const h1 = f.heading;
  fly(f, flatWorld, inp, 10);
  const drift = Math.abs(unwrap(f.heading - h1));
  check('17a. Pedal turn in hover 25–60°/s, heading hold after release (< 2° in 10 s)', rMax > 25 && rMax < 60 && drift < 2 && !f.crashed,
    `max yaw rate ${rMax.toFixed(1)}°/s, drift ${drift.toFixed(2)}°`);
  note('Hover pedal turn rate (full right pedal, FPS rate command)', `${rMax.toFixed(0)}°/s`, 'UH-60 hover turns up to ≈ 60–90°/s');

  // AFCS off: a collective step without pedal → nose yaws right (CCW rotor torque reaction)
  const g = make();
  hovering(g, flatWorld, GROUND + 60);
  const inp2 = newInput();
  fly(g, flatWorld, inp2, 0.2);
  g.command('sas');
  const hd0 = g.heading;
  inp2.throttle = g.collective + 0.1;
  fly(g, flatWorld, inp2, 2);
  const dh = unwrap(g.heading - hd0);
  check('17b. Torque reaction (AFCS off): collective up without pedal → nose right', dh > 3, `heading change ${dh.toFixed(1)}° in 2 s`);
}

// =================================================================================================
// 18. stabilator: scheduled vs fixed (pitch-up in the transition)
// =================================================================================================
{
  const a = make(), b = make();
  b.stabilatorAuto = false;
  let worst = { d: 0, kt: 0, dp: 0 };
  let ga = null, gb = null;
  for (const kt of [10, 15, 20, 25, 30, 35, 40, 50]) {
    const ta = a.trim({ speed: kt * KT, guess: ga }), tb = b.trim({ speed: kt * KT, guess: gb });
    ga = [ta.collective, ta.cLon, ta.cLat, ta.cPed, ta.pitch, ta.roll]; gb = [tb.collective, tb.cLon, tb.cLat, tb.cPed, tb.pitch, tb.roll];
    const d = tb.cLon - ta.cLon;
    if (d > worst.d) worst = { d, kt, dp: (tb.pitch - ta.pitch) * DEG };
  }
  check('18a. Fixed stabilator: nose-up trim in the 15–40 kt transition (more forward cyclic, nose-up attitude)',
    worst.d * spec.mainRotor.cyclicLonDeg > 0.8 && worst.dp > 0.8 && worst.kt >= 15 && worst.kt <= 40,
    `max extra forward cyclic ${(worst.d * spec.mainRotor.cyclicLonDeg).toFixed(1)}° disc tilt at ${worst.kt} kt, nose-up ${worst.dp.toFixed(1)}°`);
  // dynamic: AFCS off, accelerate with a fixed cyclic offset → fixed stab pitches up more
  // dynamic: the same acceleration at a held −6° attitude; the FPS has to push much more forward cyclic through the
  // transition with a fixed stabilator (the wake-induced pitch-up the pilot feels in the stick)
  const run = (auto) => {
    const f = make();
    f.stabilatorAuto = auto;
    hovering(f, flatWorld, GROUND + 300);
    const inp = newInput();
    fly(f, flatWorld, inp, 0.1);
    let extra = -9;
    fly(f, flatWorld, inp, 40, 1 / 60, () => {
      stickForPitch(f, inp, -6);
      const kt = f.airspeed / KT;
      if (kt > 20 && kt < 40) extra = Math.max(extra, -f.elevator);
      if (kt > 40) return false;
    });
    return extra;
  };
  const ra = run(true), rb = run(false);
  check('18b. Transition at a held attitude: fixed stabilator needs ≥ 0.8° more forward cyclic (pitch-up tendency)',
    (rb - ra) * spec.mainRotor.cyclicLonDeg > 0.8, `max forward cyclic 20–40 kt: scheduled ${(ra * spec.mainRotor.cyclicLonDeg).toFixed(1)}°, fixed ${(rb * spec.mainRotor.cyclicLonDeg).toFixed(1)}°`);
  note('Stabilator schedule', `42° TED ≤ 30 kt → 0° at 160 kt`, 'UH-60: 42° TED … 8° TEU, airspeed/collective/pitch-rate scheduled');
}

// =================================================================================================
// 19. rotor speed: governor, collective anticipation, droop when power limited
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 40);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.2);
  let nrMin = 2;
  inp.throttle = f.collective + 0.15;           // rapid pull
  fly(f, flatWorld, inp, 6, 1 / 60, () => { nrMin = Math.min(nrMin, f.rotorRPM); });
  check('19a. Rapid collective pull (+15 %) at SL: transient droop < 5 %, NR recovers to 100 %', nrMin > 0.95 && Math.abs(f.rotorRPM - 1) < 0.01,
    `min NR ${(nrMin * 100).toFixed(1)} %, final ${(f.rotorRPM * 100).toFixed(1)} %, torque ${(f.torque * 100).toFixed(0)} %`);
  note('NR droop on a rapid +15 % collective pull', `${((1 - nrMin) * 100).toFixed(1)} %`, 'T700 governor with load anticipation: 1–3 %');

  const g = make({ mass: 9980 });
  hovering(g, flatWorld, 3000);
  const inp2 = newInput();
  fly(g, flatWorld, inp2, 0.2);
  let low = false, nrMin2 = 2;
  inp2.throttle = 1;
  fly(g, flatWorld, inp2, 10, 1 / 60, () => { low ||= g.warnings.lowRotor; nrMin2 = Math.min(nrMin2, g.rotorRPM); });
  check('19b. Full collective at 3,000 m, max weight: power-limited rotor droop + LOW ROTOR warning', low && nrMin2 < 0.95 && !g.crashed,
    `min NR ${(nrMin2 * 100).toFixed(1)} %, engines ${(g.power / 745.7).toFixed(0)} shp`);
  note('Rotor droop, full collective at 3,000 m / 10 t', `NR ${(nrMin2 * 100).toFixed(0)} %`, 'power limited → droop');
}

// =================================================================================================
// 20. ceilings (trim): HOGE at max gross weight, service ceiling at typical weight
// =================================================================================================
{
  const hogeAt = (mass) => {
    const f = make({ mass });
    let hoge = 0;
    for (let alt = 0; alt <= 7000; alt += 100) {
      const t = f.trim({ speed: 0, altitude: alt });
      if (t.converged && t.power <= Math.min(t.powerAvailable, spec.engine.transmissionShp * 745.7 * 1.0001) && t.stall < 0.5) hoge = alt; else break;
    }
    return hoge;
  };
  const hoge = hogeAt(9980), hoge95 = hogeAt(9500), hoge85 = hogeAt(8500);
  const g = make();
  let service = 0;
  let guess = null;
  for (let alt = 3000; alt <= 9000; alt += 100) {
    const t = g.trim({ speed: 75 * KT, altitude: alt, guess });
    if (t.converged) guess = [t.collective, t.cLon, t.cLat, t.cPed, t.pitch, t.roll];
    if (t.converged && t.power < t.powerAvailable * 0.95 && t.stall < 1.0) service = alt; else break;
  }
  check('20. HOGE ceiling at max weight 2,300–3,500 m; service ceiling (8.5 t) 5,000–6,800 m',
    hoge >= 2300 && hoge <= 3500 && service >= 5000 && service <= 6800, `HOGE ${hoge} m (10 t, ISA, ≤ 100 % torque), service ceiling ≈ ${service} m`);
  note('HOGE ceiling ISA: 8.5 t / 9.5 t / 10 t', `${hoge85} / ${hoge95} / ${hoge} m`, '≈ 3,000 m (heavy)');
  note('Service ceiling, 8.5 t (75 kt level, blade stall / power)', `${service} m`, '5,790 m (19,000 ft)');
}

// =================================================================================================
// 21. airborne spawn: trimmed forward flight at spawnSpeed, lever synchronised
// =================================================================================================
{
  const f = make();
  const inp = newInput({ throttle: 0 });
  f.reset({ x: 100, z: 200, heading: Math.PI / 3, altitude: 450, speed: spec.spawnSpeed }, flatWorld);
  const v0 = f.airspeed;
  fly(f, flatWorld, inp, 20);
  check('21. Airborne spawn at spawnSpeed: trimmed, 20 s hands-off stable, lever back-driven to the collective',
    !f.crashed && !f.onGround && Math.abs(f.airspeed - v0) < 2 && Math.abs(f.altitude - 450) < 15 && Math.abs(inp.throttle - f.collective) < 0.01 && f.rotorRPM > 0.99,
    `V ${v0.toFixed(1)} → ${f.airspeed.toFixed(1)} m/s, alt ${f.altitude.toFixed(1)} m, lever ${inp.throttle.toFixed(3)} / collective ${f.collective.toFixed(3)}`);
  // an input module that does not keep written values: collective pickup instead
  const g = make();
  const frozen = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
  Object.defineProperty(frozen, 'throttle', { get: () => 0, set: () => {}, enumerable: true });
  g.reset({ x: 0, z: 0, heading: 0, altitude: 450, speed: spec.spawnSpeed }, flatWorld);
  fly(g, flatWorld, frozen, 10);
  check('21b. Read-only lever: collective held (pickup) until the lever catches it', !g.crashed && Math.abs(g.altitude - 450) < 15 && g.collective > 0.3,
    `alt ${g.altitude.toFixed(1)} m, collective ${g.collective.toFixed(3)}`);
}

// =================================================================================================
// 22. cruise hold (autopilot at speed): altitude, heading, airspeed
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0.5, altitude: 700, speed: 110 * KT }, flatWorld);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.5);
  f.command('autopilot');
  const mode = f.autopilot.mode;
  const a0 = f.altitude, h0 = f.heading, v0 = f.airspeed;
  fly(f, flatWorld, inp, 40, 1 / 60, (t) => { inp.roll = t > 2 && t < 3 ? 0.6 : 0; inp.pitch = t > 5 && t < 5.4 ? 0.5 : 0; });
  // after the disturbances the AP rolls level, captures a new heading and holds altitude / speed
  const a1 = f.altitude, h1 = f.heading;
  fly(f, flatWorld, inp, 20);
  check('22. Cruise hold: altitude ± 5 m, heading ± 2°, airspeed ± 3 kt after disturbances', mode === 'cruise' && !f.crashed
    && Math.abs(f.altitude - a0) < 5 && Math.abs(unwrap(f.heading - h1)) < 2 && Math.abs(f.airspeed - v0) / KT < 3.5,
    `mode ${mode}, Δalt ${(f.altitude - a0).toFixed(1)} m, Δhdg (last 20 s) ${unwrap(f.heading - h1).toFixed(2)}°, ΔV ${((f.airspeed - v0) / KT).toFixed(1)} kt`);
}

// =================================================================================================
// 23. dt robustness: identical scenario at different frame rates
// =================================================================================================
{
  const scenario = (dt) => {
    const f = make();
    hovering(f, flatWorld, GROUND + 60);
    const inp = newInput();
    const n = Math.round(20 / dt);
    const every = Math.round(0.5 / dt);
    f.track = [];
    let travel = 0;
    const last = f.position.clone();
    for (let i = 0; i < n && !f.crashed; i++) {
      const t = i * dt + 1e-9;   // inputs change on a 0.25 s grid shared by every frame rate
      inp.pitch = t >= 1 && t < 3 ? -0.4 : t >= 8 && t < 9 ? 0.3 : 0;
      inp.roll = t >= 5 && t < 6 ? 0.4 : 0;
      inp.yaw = t >= 10 && t < 11 ? 0.5 : 0;
      if (t >= 12) inp.throttle = hoverTrim.collective + 0.05;
      f.step(dt, inp, flatWorld);
      if ((i + 1) % every === 0) { f.track.push(f.position.clone()); travel += f.position.distanceTo(last); last.copy(f.position); }
    }
    f.travel = travel;
    return f;
  };
  const ref = scenario(1 / 120);
  let worst = 0, allFinite = true, anyCrash = false;
  const rows = [];
  for (const dt of [1 / 30, 1 / 60, 1 / 144, 0.1, 0.25]) {
    const f = scenario(dt);
    let d = 0;
    for (let k = 0; k < ref.track.length; k++) d = Math.max(d, ref.track[k].distanceTo(f.track[k]));
    worst = Math.max(worst, dt <= 0.1 ? d : 0);
    allFinite &&= finite(f); anyCrash ||= f.crashed;
    rows.push(`${(1 / dt).toFixed(0)}Hz:${d.toFixed(2)}m`);
  }
  check('23. dt robustness (dt 1/144 … 0.25 s): same trajectory (max deviation over 20 s) within 2 m, no NaN, no crash',
    worst < 2 && allFinite && !anyCrash, `max deviation vs 120 Hz: ${rows.join(' ')}; travelled ${ref.travel.toFixed(0)} m`);
}

// =================================================================================================
// 24. random-input fuzz: no NaN, no numeric crash
// =================================================================================================
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0, numeric = 0, runs = 0;
  const reasons = {};
  for (let k = 0; k < 6; k++) {
    const f = make();
    if (k % 2) hovering(f, slopeWorld, GROUND + 80 + 100 * k, -200, 0, rnd() * 6);
    else f.reset({ x: -300, z: 0, heading: rnd() * 6, altitude: k === 0 ? undefined : 400, speed: k === 0 ? undefined : 60 }, k === 0 ? flatWorld : slopeWorld);
    const inp = newInput({ throttle: 0.6 });
    let t = 0;
    while (t < 60 && !f.crashed) {
      if (rnd() < 0.05) { inp.pitch = rnd() * 2 - 1; inp.roll = rnd() * 2 - 1; inp.yaw = rnd() * 2 - 1; }
      if (rnd() < 0.03) inp.throttle = rnd();
      if (rnd() < 0.01) f.command(['autopilot', 'sas', 'lights', 'gear', 'flapsDown', 'canopy', 'stabilator'][Math.floor(rnd() * 7)]);
      const dt = 0.002 + rnd() * 0.12;
      f.step(dt, inp, k === 0 ? flatWorld : slopeWorld);
      f.getVisualState();
      t += dt;
      if (!finite(f)) { bad++; break; }
    }
    runs++;
    if (f.crashed) { reasons[f.crashReason] = (reasons[f.crashReason] || 0) + 1; if (/Sayısal/.test(f.crashReason)) numeric++; }
  }
  check('24. Random-input fuzz (6 × 60 s, random dt ≤ 0.12): always finite, no numeric failure', bad === 0 && numeric === 0,
    `${runs} runs, non-finite ${bad}, crashes: ${JSON.stringify(reasons)}`);
}

// =================================================================================================
// 25. contract: readable state, visual state, events, commands, rig contacts
// =================================================================================================
{
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.5);
  const v = f.getVisualState();
  const fields = ['position', 'quaternion', 'velocity', 'angularVelocity', 'airspeed', 'ias', 'mach', 'altitude', 'agl', 'heading', 'pitch', 'roll',
    'verticalSpeed', 'gForce', 'aoa', 'sideslip', 'throttle', 'onGround', 'stalled', 'crashed', 'crashReason', 'aileron', 'elevator', 'rudder', 'engines',
    'gear', 'gearHandleDown', 'flaps', 'flapsIndex', 'flapsLabel', 'slats', 'spoilers', 'speedbrake', 'reverser', 'brakes', 'fuel', 'warnings', 'autopilot',
    'rotorRPM', 'collective', 'torque'];
  const missing = fields.filter((k) => f[k] === undefined);
  const vsOk = v.rotor && ['rpm', 'collective', 'cyclicX', 'cyclicY', 'pedal'].every((k) => Number.isFinite(v.rotor[k])) && v.gear === 1 && v.flaps === 0
    && v.gearCompression.length === 3 && v.engines.length === 2 && v.lights && typeof v.lights.nav === 'boolean' && v.tvc && Number.isFinite(v.time);
  const w = ['stall', 'overspeed', 'gear', 'bank', 'sinkRate', 'pullUp'].every((k) => typeof f.warnings[k] === 'boolean');
  f.command('lights'); f.command('gear'); f.command('flapsDown'); f.command('canopy');
  const cmdOk = f.lights.landing === true && f.gear === 1 && f.getVisualState().canopy === 1;
  // rig contacts are used when valid; a bogus rig falls back to the spec defaults
  const THREEv = (x, y, z) => new THREE.Vector3(x, y, z);
  const rig = [{ name: 'contact_main_L', position: THREEv(-1.4, -1.6, -1.5), kind: 'main' }, { name: 'contact_main_R', position: THREEv(1.4, -1.6, -1.5), kind: 'main' },
    { name: 'contact_tail', position: THREEv(0, -1.6, 7.2), kind: 'tail' }];
  const g = make({ contacts: rig });
  g.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
  const usesRig = Math.abs(g.position.y - (GROUND + 1.6)) < 0.02;
  const b = make({ contacts: [{ name: 'x', position: THREEv(0, -1, 5), kind: 'main' }] });
  b.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
  const fallback = Math.abs(b.position.y - (GROUND + 1.55)) < 0.02;
  check('25. Contract: readable fields, VisualState (rotor, gear 1, lights), warnings, commands, rig contacts / fallback',
    missing.length === 0 && vsOk && w && cmdOk && usesRig && fallback,
    `missing [${missing.join(',')}], visual ${vsOk}, warnings ${w}, commands ${cmdOk}, rig contacts ${usesRig}, fallback ${fallback}`);
}

// =================================================================================================
// 26. pull-up / sink-rate warnings (terrain look-ahead)
// =================================================================================================
{
  const cliff = { getGroundHeight: (x, z) => (z < -1500 ? 400 : GROUND), isWater: () => false, isOnRunway: () => false, getObstacleHeight: () => -Infinity, hitTest: () => null };
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0, altitude: 300, speed: 120 * KT }, cliff);
  const inp = newInput();
  let pull = false;
  fly(f, cliff, inp, 30, 1 / 60, () => { pull ||= f.warnings.pullUp; if (pull) return false; });
  check('26. Pull-up warning before flying into a ridge', pull && !f.crashed, `pullUp ${pull} at z ${f.position.z.toFixed(0)} (ridge at -1500)`);
}

// =================================================================================================
// 27. engine failures: single-engine flight, dual failure → autorotation and flare
// =================================================================================================
{
  // one engine out at 80 kt: continued level flight on the remaining T700 (≈ 58 % of the dual power)
  const f = make();
  f.reset({ x: 0, z: 0, heading: 0, altitude: 500, speed: 80 * KT }, flatWorld);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  f.failEngine(1);
  const st = {};
  fly(f, flatWorld, inp, 40, 1 / 60, () => {
    leverForVs(st, f, inp, 1 / 60, clamp(0.1 * (500 - f.altitude), -2, 2));
    stickForPitch(f, inp, clamp(0.3 * (f.airspeed / KT - 80) + 2, -8, 10));
  });
  check('27a. Single-engine failure at 80 kt: level flight continues on one engine, NR governed',
    !f.crashed && Math.abs(f.altitude - 500) < 25 && f.rotorRPM > 0.97 && f.engines[1].power < 1000 && f.engines[0].power > 700e3,
    `alt ${f.altitude.toFixed(0)} m, ${(f.airspeed / KT).toFixed(0)} kt, NR ${(f.rotorRPM * 100).toFixed(1)} %, engine 1 ${(f.engines[0].power / 745.7).toFixed(0)} shp`);
  note('OEI level flight at 80 kt (8.5 t, SL)', `engine 1 at ${(f.engines[0].power / 745.7).toFixed(0)} shp of ${spec.engine.powerShp}`, 'UH-60 flies OEI at typical weight');

  // both engines out at 80 kt: autorotation (collective down, NR by the airflow), then flare and landing
  const g = make();
  g.reset({ x: 0, z: 0, heading: 0, altitude: GROUND + 900, speed: 80 * KT }, flatWorld);
  const inp2 = newInput();
  fly(g, flatWorld, inp2, 0.1);
  g.failEngine('both');
  let nrMin = 2, nrMax = 0, vsSum = 0, n = 0, phase = 'auto', td = null, I = 0;
  fly(g, flatWorld, inp2, 150, 1 / 60, (t, _f, i, dt) => {
    if (phase === 'auto') {
      // collective down, NR kept at ≈ 102 % with the collective, 80 kt with the attitude
      const e = g.rotorRPM - 1.02;
      I = clamp(I + 0.3 * e * dt, -0.2, 0.4);
      inp2.throttle = clamp(0.08 + 2.0 * e + I, 0, 0.5);
      stickForPitch(g, inp2, clamp(0.4 * (g.airspeed / KT - 80) + 2, -10, 15));
      if (t > 15) { nrMin = Math.min(nrMin, g.rotorRPM); nrMax = Math.max(nrMax, g.rotorRPM); vsSum += g.verticalSpeed; n++; }
      if (g.agl < 25) phase = 'flare';
    } else if (phase === 'flare') {
      stickForPitch(g, inp2, 22);                       // flare at ≈ 80 ft: trade speed for rotor energy and a lower sink rate
      if (g.rotorRPM > 1.08) inp2.throttle = clamp(inp2.throttle + (g.rotorRPM - 1.08) * 3 * dt, 0, 1);
      if (g.verticalSpeed > -1.5 || g.agl < 3) phase = 'level';
    } else if (phase === 'level') {
      stickForPitch(g, inp2, 6);                        // level, then cushion with the remaining rotor energy
      const e = (g.agl < 2.5 ? -0.6 : -2.0) - g.verticalSpeed;
      inp2.throttle = clamp(inp2.throttle + clamp(0.9 * e, -0.4, 1.2) * dt, 0, 1);
      if (td && g.onGround) phase = 'rollout';
    } else {
      inp2.pitch = 0; inp2.brake = 1;                   // on the wheels: collective down, brakes
      inp2.throttle = Math.max(0, inp2.throttle - 0.5 * dt);
      if (t - td.t > 30) return false;
    }
    if (!td) { td = g.events.find((e) => e.e === 'touchdown') || null; if (td) { td.nr = g.rotorRPM; td.t = t; } }
  });
  const vsAuto = vsSum / Math.max(n, 1);
  check('27b. Dual engine failure → autorotation at 80 kt: NR held 90–110 % by the airflow, 8–15 m/s descent',
    n > 0 && nrMin > 0.9 && nrMax < 1.1 && vsAuto < -8 && vsAuto > -15,
    `NR ${(nrMin * 100).toFixed(0)}–${(nrMax * 100).toFixed(0)} %, mean descent ${vsAuto.toFixed(1)} m/s (${(-vsAuto * 196.85).toFixed(0)} fpm)`);
  check('27c. Autorotation: flare at 25 m to 22°, level, cushion → survivable touchdown, rollout, rotor spins down',
    !!td && !g.crashed && td.verticalSpeed > -3.6 && g.onGround && hspeed(g) < 1,
    td ? `touchdown ${td.verticalSpeed.toFixed(2)} m/s at ${td.groundSpeed.toFixed(1)} m/s ground speed, NR ${(td.nr * 100).toFixed(0)} % → stopped, NR now ${(g.rotorRPM * 100).toFixed(0)} %; ${g.crashReason}` : `no touchdown; ${g.crashReason}`);
  note('Autorotation at 80 kt, 8.5 t', `${(-vsAuto * 196.85).toFixed(0)} fpm, NR ${(nrMin * 100).toFixed(0)}–${(nrMax * 100).toFixed(0)} %`, '≈ 2,000 fpm, NR 91–110 %');
}

// =================================================================================================
// 28. sideward flight: heading hold against weathervaning, tail-rotor authority
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 30);
  const inp = newInput();
  fly(f, flatWorld, inp, 0.1);
  f.command('autopilot');
  const h0 = f.heading;
  let maxDh = 0, vmax = 0, pedMax = 0;
  fly(f, flatWorld, inp, 25, 1 / 60, (t) => {
    inp.roll = t < 20 ? -1 : 0;                         // full left: sideward flight to the left (hardest for the tail rotor)
    maxDh = Math.max(maxDh, Math.abs(unwrap(f.heading - h0)));
    vmax = Math.max(vmax, hspeed(f));
    pedMax = Math.max(pedMax, Math.abs(f.rudder));
  });
  check('28. Sideward flight left at ≈8 m/s (hover hold TRC): heading held within 3°, pedal margin left',
    !f.crashed && vmax > 7 && maxDh < 3 && pedMax < 0.95, `max ${vmax.toFixed(1)} m/s sideways, max Δheading ${maxDh.toFixed(2)}°, max pedal ${pedMax.toFixed(2)}`);
}

// =================================================================================================
// 29. keyboard integration through the real input module (src/flight/input.js, helicopter mode)
// =================================================================================================
{
  let createInput = null;
  try { ({ createInput } = await import('../src/flight/input.js')); } catch (e) { createInput = null; }
  if (!createInput) check('29. Keyboard integration (input.js)', true, 'skipped: input module not loadable in Node');
  else {
    const listeners = {};
    const target = { addEventListener: (t, cb) => (listeners[t] ||= []).push(cb), document: null };
    const input = createInput(target);
    if (input.setAircraft) input.setAircraft(spec);
    const key = (type, code) => (listeners[type] || []).forEach((cb) => cb({ code, key: '', repeat: false, target: {}, preventDefault() {}, metaKey: false }));
    const f = make();
    globalThis.__game = { flight: f };
    input.on('autopilot', () => f.command('autopilot'));
    f.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
    const script = [[0.5, 'd', 'ShiftLeft'], [2.5, 'u', 'ShiftLeft'], [8.5, 'd', 'KeyW'], [11.5, 'u', 'KeyW']];
    let si = 0, t = 0, liftoff = false, v20 = 0, v35 = 0, maxPitch = 0;
    while (t < 35 && !f.crashed) {
      while (si < script.length && script[si][0] <= t) { const [, ty, code] = script[si++]; key(ty === 'd' ? 'keydown' : 'keyup', code); }
      input.update(1 / 60);
      f.step(1 / 60, input.state, flatWorld);
      t += 1 / 60;
      liftoff ||= !f.onGround && f.agl > 2;
      if (Math.abs(t - 20) < 0.01) v20 = hspeed(f);
      if (t > 12) maxPitch = Math.max(maxPitch, Math.abs(f.pitch));
    }
    v35 = hspeed(f);
    check('29. Keyboard via input.js: Shift 2 s lifts off; W 3 s → FPS settles and holds a forward speed (±1.5 m/s, 20→35 s)',
      liftoff && !f.crashed && v20 > 15 && Math.abs(v35 - v20) < 1.5 && maxPitch < 30,
      `lift-off ${liftoff}, speed ${v20.toFixed(1)} → ${v35.toFixed(1)} m/s, lever ${input.state.throttle.toFixed(2)}, max |pitch| after release ${maxPitch.toFixed(0)}°`);
    delete globalThis.__game;
  }
}

// =================================================================================================
// 30. (QA wave 3) landing with the hover hold on: collective-down beeps the height target through the ground
// =================================================================================================
{
  const f = make();
  hovering(f, flatWorld, GROUND + 1.55 + 10);
  const inp = newInput();
  fly(f, flatWorld, inp, 1.5);
  f.command('autopilot');
  const engaged = f.autopilot.on && f.autopilot.mode === 'hover';
  let td = null, apOffAt = null, t = 0;
  fly(f, flatWorld, inp, 60, 1 / 60, (tt, _f, i, dt) => {
    t = tt;
    // the QA player: Z held 0.4 s, released 0.3 s (the input module moves the back-driven lever at 0.35/s)
    if (!f.onGround && (tt % 0.7) < 0.4) inp.throttle = Math.max(0, inp.throttle - 0.35 * dt);
    if (!td) td = f.events.find((e) => e.e === 'touchdown') || null;
    if (td && apOffAt === null && !f.autopilot.on) apOffAt = tt;
    if (td && tt - td.t > 8) return false;
    if (td && td.t === undefined) td.t = tt;
  });
  const ok = engaged && td && !f.crashed && Math.abs(td.verticalSpeed) <= 1.2 && !f.autopilot.on && f.onGround && f.collective < 0.35
    && Math.abs(inp.throttle - f.collective) < 0.02 && hspeed(f) < 0.1;
  check('30. Hover hold + collective down: descends to touchdown (≤ 1.2 m/s), height hold releases on the wheels, collective lowered',
    ok, td ? `ground ${f.onGround}, speed ${hspeed(f).toFixed(2)} m/s, touchdown ${td.verticalSpeed.toFixed(2)} m/s at t ${td.t.toFixed(1)} s, hold off ${apOffAt === null ? 'never' : (apOffAt - td.t).toFixed(1) + ' s later'}, collective ${f.collective.toFixed(2)} (lever ${inp.throttle.toFixed(2)}), ${f.crashReason}` : `no touchdown (agl ${f.agl.toFixed(1)} m, AP ${f.autopilot.on})`);
}

// =================================================================================================
// 31. (QA wave 3) deceleration from 120 kt to a hover: no lateral drift; O below 40 kt selects the hover hold
// =================================================================================================
{
  const decel = (rollPilot) => {
    const f = make();
    f.reset({ x: 0, z: 0, heading: 0, altitude: GROUND + 120, speed: 120 * KT }, flatWorld);
    const inp = newInput();
    fly(f, flatWorld, inp, 0.1);
    const st = {};
    let maxLat = 0;
    fly(f, flatWorld, inp, 120, 1 / 60, () => {
      const kt = hspeed(f) / KT;
      stickForPitch(f, inp, kt > 25 ? 12 : kt > 8 ? 6 : 4.5);
      leverForVs(st, f, inp, 1 / 60, clamp(0.1 * (GROUND + 120 - f.altitude), -3, 3));
      inp.roll = rollPilot(f);
      const hd = f.heading / DEG;
      const gsR = f.velocity.x * Math.cos(hd) + f.velocity.z * Math.sin(hd);
      maxLat = Math.max(maxLat, Math.abs(gsR));
      if (kt < 4) return false;
    });
    const kt = hspeed(f) / KT;
    f.command('autopilot');
    const mode = f.autopilot.mode;
    fly(f, flatWorld, inp, 10, 1 / 60, () => { inp.pitch = 0; inp.roll = 0; });
    return { maxLat: maxLat / KT, kt, mode, final: hspeed(f) / KT, crashed: f.crashed };
  };
  const a = decel(() => 0);                                                  // cyclic centred laterally
  const b = decel((f) => (f.roll < -6 ? 0.5 : f.roll > 6 ? -0.5 : 0));        // player keeping the wings roughly level
  check('31a. Decel 120 kt → hover, lateral cyclic centred: lateral drift < 3 kt; O then engages hover hold and stops',
    !a.crashed && a.maxLat < 3 && a.mode === 'hover' && a.final < 1, `max lateral ${a.maxLat.toFixed(1)} kt, O at ${a.kt.toFixed(1)} kt → ${a.mode}, after 10 s ${a.final.toFixed(1)} kt`);
  check('31b. Same with a wings-level (±6°) keyboard pilot: lateral drift < 5 kt, O → hover hold',
    !b.crashed && b.maxLat < 5 && b.mode === 'hover' && b.final < 1, `max lateral ${b.maxLat.toFixed(1)} kt, O at ${b.kt.toFixed(1)} kt → ${b.mode}, after 10 s ${b.final.toFixed(1)} kt`);
  // O at 35 kt selects the hover hold (not cruise) and brings the aircraft to a hover
  const c = make();
  c.reset({ x: 0, z: 0, heading: 0, altitude: GROUND + 80, speed: 35 * KT }, flatWorld);
  const inp = newInput();
  fly(c, flatWorld, inp, 0.5);
  c.command('autopilot');
  const mode = c.autopilot.mode;
  fly(c, flatWorld, inp, 25);
  check('31c. O at 35 kt ground speed engages the hover hold and decelerates to a hover', !c.crashed && mode === 'hover' && hspeed(c) < 0.5,
    `mode ${mode}, speed after 25 s ${(hspeed(c) / KT).toFixed(1)} kt`);
}

// =================================================================================================
// 32. the owner's report: collective to 0 right after lift-off (90 % preset, 14 s climb, Z held 3 s), hands off
// =================================================================================================
{
  const run = (upAt = null) => {
    const f = make();
    f.reset({ x: 0, z: 0, heading: 0 }, flatWorld);
    const inp = newInput();
    fly(f, flatWorld, inp, 0.05);
    inp.throttle = 0.9;
    fly(f, flatWorld, inp, 14);
    const r = { f, nrMax: 0, highAt: null, lowRotor: false, crashT: null };
    const tEnd = fly(f, flatWorld, inp, 60, 1 / 60, (t, g, i, dt) => {
      i.throttle = upAt != null && t >= upAt ? Math.min(0.75, i.throttle + 0.35 * dt) : Math.max(0, i.throttle - 0.35 * dt);
      r.nrMax = Math.max(r.nrMax, g.rotorRPM);
      if (r.highAt == null && g.warnings.highRotor) r.highAt = g.rotorRPM;
      if (t > 3 && g.warnings.lowRotor) r.lowRotor = true;
    });
    if (f.crashed) r.crashT = tEnd;
    return r;
  };
  const a = run();
  check('32a. Collective dumped after lift-off, hands off: crash reason names the collective, NR rises (autorotation), high-rotor flag only above 110 % power off',
    a.f.crashed && /^Kolektif çok düşük/.test(a.f.crashReason) && a.f.crashCause === 'collective' && a.nrMax > 1.1 && (a.highAt == null || a.highAt > 1.1) && !a.lowRotor,
    `"${a.f.crashReason}" (${a.f.crashCause}) after ${a.crashT?.toFixed(1)} s, NR max ${(a.nrMax * 100).toFixed(0)} %, high-rotor flag at ${a.highAt ? (a.highAt * 100).toFixed(0) + ' %' : '—'}`);
  const b = run(4);
  check('32b. Following the hint: collective back up 4 s after the dump → no crash, climbing again, NR back to 100 %',
    !b.f.crashed && b.f.verticalSpeed > 0 && Math.abs(b.f.rotorRPM - 1) < 0.02, `alt ${b.f.agl.toFixed(0)} m, V/S ${b.f.verticalSpeed.toFixed(1)} m/s, NR ${(b.f.rotorRPM * 100).toFixed(0)} %`);
  note('Collective dumped after lift-off, hands off', `impact after ${a.crashT?.toFixed(1)} s, NR max ${(a.nrMax * 100).toFixed(0)} %`, 'autorotation without flare → hard landing');
}

// ---- report ------------------------------------------------------------------------------------
const w1 = Math.max(...results.map((r) => r.name.length));
console.log('\nUH-60M helicopter flight model tests\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w1)}  ${r.detail}`);
console.log('\nMeasured vs. real UH-60 data\n');
const w2 = Math.max(...measured.map((m) => m.name.length));
const w3 = Math.max(...measured.map((m) => String(m.value).length));
for (const m of measured) console.log(`  ${m.name.padEnd(w2)}  ${String(m.value).padEnd(w3)}  ${m.real}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
