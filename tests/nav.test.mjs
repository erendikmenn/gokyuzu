// Navigation tests: route model, approach geometry, LNAV (fixed wing + helicopter), route approach → ILS of the
// selected runway → autoland. Run: node tests/nav.test.mjs
// No framework: scripted scenarios against fake worlds; prints a PASS/FAIL table, exits 1 on failure.
import { readFileSync } from 'node:fs';
import { createFixedWingModel } from '../src/flight/fixedwing.js';
import { createHelicopterModel } from '../src/flight/helicopter.js';
import { approachGeometry, findApproach } from '../src/flight/fixedwing-autopilot.js';
import { createRoute, findRunwayEnd, buildApproach, courseTo, NM } from '../src/nav/route.js';
import { createLnav } from '../src/nav/lnav.js';

const KT = 0.514444, FT = 0.3048, DEG = 180 / Math.PI, RAD = Math.PI / 180;
const RUNWAYS = JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8'));
const REGION = JSON.parse(readFileSync(new URL('../data/sf/region.json', import.meta.url), 'utf8'));
const SPECS = {};
for (const id of ['a320neo', 'b737', 'f16', 'f22', 'uh60']) SPECS[id] = (await import(`../src/aircraft/${id}/spec.js`)).default;

// ---- fake world: flat ground at 4 m, the real runway rectangles ---------------------------------------------------
const ELEV = 4;
const RECTS = [];
for (const apt of RUNWAYS.airports) for (const r of apt.runways) {
  const [a, b] = r.ends; const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  RECTS.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2 });
}
const onRunway = (x, z) => RECTS.some((r) => { const px = x - r.ax, pz = z - r.az, al = px * r.ux + pz * r.uz; return al >= 0 && al <= r.len && Math.abs(px * -r.uz + pz * r.ux) <= r.half; });
const world = { runways: RUNWAYS, getGroundHeight: () => ELEV, isWater: () => false, isOnRunway: onRunway, getObstacleHeight: () => -Infinity, hitTest: () => null };
const ENV = { groundAt: () => ELEV, bounds: REGION.local };
const SPAWN = {
  CITY: { x: -1500, z: -14500, heading: 340 * RAD, altitude: 600 },
  GGB: { x: -14500, z: -23500, heading: 100 * RAD, altitude: 450 },
};

// ---- helpers --------------------------------------------------------------------------------------------------------
const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }
const input = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...o });
const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;
function fixedWing(id, spawn) {
  const f = createFixedWingModel(SPECS[id], {});
  f.reset({ ...spawn, speed: SPECS[id].spawnSpeed }, world);
  const route = createRoute();
  route.env = ENV;
  f.setRoute(route);
  return { f, route, inp: input({ throttle: f.throttle }) };
}
/** Step `secs` at 60 Hz; each(t) may return false to stop. */
function fly(f, inp, secs, each) {
  const dt = 1 / 60;
  f.step(0, inp, world);
  for (let t = 0; t < secs; t += dt) {
    f.step(dt, inp, world);
    if (f.crashed) break;
    if (each && each(t) === false) break;
  }
}

// ======================================================================================================================
// 1. route model
{
  const r = createRoute();
  r.setPosition(0, 0, 0);
  const a = r.add(1000, -5000), b = r.add(3000, -8000), c = r.add(2000, -3000, { index: 1 });
  const order = r.waypoints.map((w) => w.id).join(',') === [a.id, c.id, b.id].join(',');
  const names = r.waypoints.map((w) => w.name).join('');
  r.setDefaultAlt(1500);
  r.setAlt(b.id, 900);
  const alts = [r.altFor(r.waypoints[0]), r.altFor(r.waypoints[2])];
  const v0 = r.version;
  r.move(c.id, 2100, -3100);
  r.remove(a.id);
  const afterRemove = r.waypoints.length === 2 && r.waypoints[0].id === c.id && r.version > v0;
  r.setPosition(500, -500, 0);
  r.directTo(b.id);
  const direct = r.waypoints.length === 1 && r.active === 0 && r.origin.x === 500 && r.origin.z === -500;
  r.clear();
  check('Route: insert / order / numbering, default + own altitude, move, remove, direct-to, clear',
    order && names === '123' && alts[0] === 1500 && alts[1] === 900 && afterRemove && direct && r.empty && !r.hasActive,
    `names ${names}, alts ${alts.join('/')}, direct ${direct}`);
}

// 2. approach geometry (KSFO 28R from Golden Gate: base turn; from the south-east: straight in; established on final)
{
  const rw = findRunwayEnd(RUNWAYS, 'KSFO 28R');
  const pts = buildApproach(rw, 'airliner', { x: SPAWN.GGB.x, z: SPAWN.GGB.z, track: SPAWN.GGB.heading }, ENV);
  const kinds = pts.map((p) => p.kind).join(' ');
  const IF = pts.find((p) => p.kind === 'if'), FAF = pts.find((p) => p.kind === 'faf'), base = pts.find((p) => p.kind === 'base');
  const gIf = approachGeometry(rw, IF.x, IF.z), gF = approachGeometry(rw, FAF.x, FAF.z), gB = approachGeometry(rw, base.x, base.z);
  const ifNm = gIf.distThreshold / NM;
  // procedure points stay within 3 km of the map area (the 3D world continues beyond it)
  const inMap = pts.every((p) => p.x > REGION.local.minX - 3000 && p.x < REGION.local.maxX + 3000 && p.z > REGION.local.minZ - 3000 && p.z < REGION.local.maxZ + 3000);
  // the IF sits below the glide slope so the G/S is intercepted from below after a level segment, at the FAF
  const belowGs = IF.alt < gIf.gsAlt - 20 && Math.abs(FAF.alt - gF.gsAlt) < 15;
  // 45° intercept from the base point
  const baseAngle = Math.atan2(Math.abs(gB.lateral), gB.along - gIf.along) * DEG;
  check('Approach KSFO 28R from Golden Gate: base → IF (7–8 NM, on the centreline) → FAF (G/S intercept) → threshold',
    kinds === 'base if faf thr' && Math.abs(gIf.lateral) < 1 && ifNm > 6.9 && ifNm < 8.01 && belowGs && inMap && Math.abs(baseAngle - 45) < 1,
    `${kinds}; IF ${ifNm.toFixed(2)} NM @ ${(IF.alt / FT).toFixed(0)} ft, FAF ${(gF.distThreshold / NM).toFixed(2)} NM, base ${(base.alt / FT).toFixed(0)} ft at ${baseAngle.toFixed(0)}°`);
  const straight = buildApproach(rw, 'airliner', { x: rw.x - rw.dx * 30000, z: rw.z - rw.dz * 30000 + 1500, track: rw.course }, { groundAt: () => ELEV });
  const est = buildApproach(rw, 'airliner', { x: rw.x - rw.dx * 9000, z: rw.z - rw.dz * 9000, track: rw.course }, ENV);
  check('Approach: straight in from behind the final (no base), established on final → join ahead only',
    straight.map((p) => p.kind).join(' ') === 'if faf thr' && est.map((p) => p.kind).join(' ') === 'faf thr',
    `${straight.map((p) => p.kind).join(' ')} / ${est.map((p) => p.kind).join(' ')}`);
  // terrain: a ridge under the far final shortens the IF; helicopters end in a hover just past the threshold
  const ridge = { groundAt: (x, z) => (approachGeometry(rw, x, z).distThreshold > 6.2 * NM ? 700 : ELEV), bounds: REGION.local };
  const short = buildApproach(rw, 'airliner', { x: SPAWN.GGB.x, z: SPAWN.GGB.z, track: 0 }, ridge).find((p) => p.kind === 'if');
  const heli = buildApproach(rw, 'helicopter', { x: SPAWN.GGB.x, z: SPAWN.GGB.z, track: 0 }, ENV);
  const hov = heli[heli.length - 1];
  check('Approach: IF moved in front of a ridge; helicopter: IF 1.5 NM / 500 ft → hover point over the runway',
    approachGeometry(rw, short.x, short.z).distThreshold < 6.2 * NM && hov.kind === 'hov' && onRunway(hov.x, hov.z) && heli.some((p) => p.kind === 'if' && Math.abs(p.alt - ELEV - 500 * FT) < 31),
    `IF ${(approachGeometry(rw, short.x, short.z).distThreshold / NM).toFixed(1)} NM; heli ${heli.map((p) => p.kind).join(' ')}`);
}

// 3. LNAV: A320 from AIR-CITY flies a 3-waypoint route (turns onto the legs, sequencing, altitudes, end → HDG)
for (const id of ['a320neo', 'f16']) {
  const { f, route, inp } = fixedWing(id, SPAWN.CITY);
  route.add(-4000, -21000, { alt: 900 });
  route.add(3000, -25000, { alt: 1200 });
  route.add(9000, -17000, { alt: 1000 });
  const legs = route.waypoints.map((w, i) => ({ a: i ? route.waypoints[i - 1] : { x: SPAWN.CITY.x, z: SPAWN.CITY.z }, b: w }));
  f.step(0, inp, world);
  f.command('autopilot');
  const nav0 = f.autopilot.lnav && /^NAV/.test(f.autopilot.mode);
  const seqAt = [], altAt = [];
  let maxBank = 0, lastIdx = 0, maxSettledXtk = 0, settled = false, end = null;
  fly(f, inp, 420, (t) => {
    maxBank = Math.max(maxBank, Math.abs(f.roll));
    const n = f.nav;
    if (n.valid) {
      if (n.index !== lastIdx) { seqAt.push(t); altAt.push(f.altitude); lastIdx = n.index; settled = false; }
      // once the turn onto a leg is done (track within 3° of the leg) the aircraft stays on it
      const trk = Math.atan2(f.velocity.x, -f.velocity.z) * DEG;
      if (!settled && Math.abs(wrap180(trk - n.course * DEG)) < 3) settled = true;
      if (settled) maxSettledXtk = Math.max(maxSettledXtk, Math.abs(n.xtk));
    } else if (!end) end = { t, mode: f.autopilot.mode, lnav: f.autopilot.lnav, alt: f.altitude };
    if (end && t > end.t + 5) return false;
  });
  const bankLim = id === 'f16' ? 47 : 27;   // bank limit + the roll loop's overshoot
  const legOk = seqAt.length === 2 && Math.abs(altAt[1] - 1200) < 25;
  check(`${SPECS[id].name}: AP engages in NAV, sequences 3 waypoints in order, holds the waypoint altitudes`,
    nav0 && legOk && end && Math.abs(end.alt - 1000) < 25 && !f.crashed,
    `modes NAV=${nav0}, sequenced at ${seqAt.map((t) => t.toFixed(0)).join('/')} s, alts ${altAt.map((a) => a.toFixed(0)).join('/')} m, end ${end && end.alt.toFixed(0)} m`);
  check(`${SPECS[id].name}: bank-limited turns (≤ ${bankLim - 2}°), rolls out on each leg (xtk < ${id === 'f16' ? 300 : 150} m), route end → HDG`,
    maxBank < bankLim && maxSettledXtk < (id === 'f16' ? 300 : 150) && end && end.mode.startsWith('HDG') && !end.lnav,
    `max bank ${maxBank.toFixed(1)}°, settled xtk ${maxSettledXtk.toFixed(0)} m, end mode ${end && end.mode}`);
}

// 4. override: a roll input in NAV selects HDG (route kept); O again → NAV; pitch input moves the altitude target
{
  const { f, route, inp } = fixedWing('b737', SPAWN.CITY);
  route.add(-4000, -24000, { alt: 700 });
  f.step(0, inp, world);
  f.command('autopilot');
  const events = [];
  f.on('nav', (e) => events.push(e.type));
  fly(f, inp, 8, (t) => { inp.roll = t > 3 && t < 4 ? 0.6 : 0; });
  const hdg = !f.autopilot.lnav && f.autopilot.mode.startsWith('HDG') && route.hasActive && events.includes('hdg');
  const re = f.engageNav();
  const a0 = f.autopilot.altitude;
  fly(f, inp, 3, (t) => { inp.pitch = t < 2 ? 0.8 : 0; });
  check('Override: roll input in NAV → HDG (route kept); "Rotayı uç" → NAV again; W/S move the altitude target',
    hdg && re && f.autopilot.lnav && f.autopilot.altitude > a0 + 10, `after roll ${hdg}, re-engage ${re}, alt target ${a0.toFixed(0)} → ${f.autopilot.altitude.toFixed(0)} m`);
}

// 5. fighter direct-to a point behind (180° turn at 45° bank)
{
  const { f, route, inp } = fixedWing('f22', SPAWN.CITY);
  f.step(0, inp, world);
  route.setPosition(f.position.x, f.position.z, SPAWN.CITY.heading);
  const back = { x: f.position.x + Math.sin(SPAWN.CITY.heading + Math.PI) * 12000, z: f.position.z - Math.cos(SPAWN.CITY.heading + Math.PI) * 12000 };
  route.directToPoint(back.x, back.z, 1500);
  f.command('autopilot');
  let maxBank = 0, closest = Infinity, done = null;
  fly(f, inp, 200, (t) => {
    maxBank = Math.max(maxBank, Math.abs(f.roll));
    closest = Math.min(closest, Math.hypot(f.position.x - back.x, f.position.z - back.z));
    if (!done && route.finished) done = t;
    if (done && t > done + 3) return false;
  });
  check('F-22 direct-to a point 12 km behind: 180° turn at ≤ 45° bank, passes the point, 1,500 m reached',
    done && maxBank < 47 && closest < 300 && Math.abs(f.altitude - 1500) < 40, `max bank ${maxBank.toFixed(1)}°, closest ${closest.toFixed(0)} m, done at ${done && done.toFixed(0)} s, alt ${f.altitude.toFixed(0)} m`);
}

// 6. route approach → IF aligned with the runway → ILS of the SELECTED runway (28R, not the parallel 28L) → autoland
for (const [id, rwName, spawn] of [['a320neo', 'KSFO 28R', 'GGB'], ['b737', 'KSFO 28L', 'CITY'], ['f16', 'KSFO 28R', 'GGB'], ['f22', 'KNGZ 24', 'CITY']]) {
  const isF = SPECS[id].category === 'fighter';
  const { f, route, inp } = fixedWing(id, SPAWN[spawn]);
  const rw = findRunwayEnd(RUNWAYS, rwName);
  f.step(0, inp, world);
  route.setApproach(rw, SPECS[id].category);
  f.command('autopilot');
  const ifPt = route.waypoints.find((p) => p.kind === 'if' || p.kind === 'faf');
  const ifDist = approachGeometry(rw, ifPt.x, ifPt.z).distThreshold;
  let atIf = null, gsCap = null, td = null, warn = [];
  const modes = new Set();
  f.on('touchdown', (e) => { if (!td) td = { ...e, lat: approachGeometry(rw, f.position.x, f.position.z).lateral }; });
  f.on('warning', (e) => { if (e.on && !td && ['pullUp', 'sinkRate', 'gear', 'stall', 'overspeed', 'bank'].includes(e.type)) warn.push(e.type); });
  fly(f, inp, 900, (t) => {
    modes.add(f.autopilot.mode.split(' ')[0]);
    const n = f.nav;
    // 0.5 NM past the IF (a fly-by waypoint: the turn is centred on it): on the final, the ILS of the runway armed
    const g = approachGeometry(rw, f.position.x, f.position.z);
    if (!atIf && route.active > route.indexOf(ifPt.id) && g.distThreshold <= ifDist - 0.5 * NM) {
      atIf = { lat: g.lateral, hdgErr: wrap180(f.heading - rw.course * DEG), alt: f.altitude, app: f.ap.st.app && f.ap.st.app.name };
    }
    if (!gsCap && f.ap.st.phase === 'GS') {
      const g = approachGeometry(rw, f.position.x, f.position.z);
      gsCap = { lat: g.lateral, hdgErr: wrap180(f.heading - rw.course * DEG), app: f.ap.st.app.name, gear: f.gearHandleDown, dist: g.distThreshold / NM,
        locDeg: Math.atan2(Math.abs(g.lateral), g.distThreshold + rw.length + 300) * DEG };
    }
    if (td && !f.autopilot.on) { inp.throttle = 0; if (isF) inp.brake = 1; }
    if (td && f.groundSpeed < 1) return false;
  });
  check(`${SPECS[id].name} → ${rwName} (from ${spawn}): 0.5 NM past the IF aligned with the final (|lat| < 250 m, |Δhdg| < 10°), ILS ${rwName} armed`,
    atIf && Math.abs(atIf.lat) < 250 && Math.abs(atIf.hdgErr) < 10 && atIf.app === rwName,
    atIf ? `lateral ${atIf.lat.toFixed(0)} m, Δhdg ${atIf.hdgErr.toFixed(0)}°, alt ${(atIf.alt / FT).toFixed(0)} ft, ILS ${atIf.app}` : 'IF not reached');
  check(`${SPECS[id].name} → ${rwName}: G/S captured on the selected runway, established (LOC < 0.5°, |Δhdg| < 6°), gear down`,
    gsCap && gsCap.app === rwName && gsCap.locDeg < 0.5 && Math.abs(gsCap.hdgErr) < 6 && gsCap.gear && modes.has('LOC'),
    gsCap ? `ILS ${gsCap.app} at ${gsCap.dist.toFixed(1)} NM, lateral ${gsCap.lat.toFixed(0)} m (${gsCap.locDeg.toFixed(2)}°), Δhdg ${gsCap.hdgErr.toFixed(1)}°, gear ${gsCap.gear}` : 'no G/S capture');
  check(`${SPECS[id].name} → ${rwName}: ${isF ? 'touchdown on the runway, hand-over' : 'autoland: touchdown on the centreline, rollout to a stop'}, no GPWS warnings`,
    td && td.onRunway && Math.abs(td.lat) < 12 && Math.abs(td.verticalSpeed) < 2.5 && !f.crashed && f.groundSpeed < 1 && f.flapsIndex >= (isF ? 1 : SPECS[id].landingFlapIndex) && warn.length === 0,
    td ? `V/S ${td.verticalSpeed.toFixed(2)} m/s, ${td.lat.toFixed(1)} m off CL, flaps ${f.flapsLabel}, warnings ${warn.join(',') || 'none'}` : f.crashReason || 'no touchdown');
}

// 7. the selected runway also restricts the plain (gear-down) approach arming; findApproach(only)
{
  const a = findApproach(RUNWAYS, 1464 + Math.sin(117.4 * RAD) * 9000, 796 - Math.cos(117.4 * RAD) * 9000, 297.4 * RAD, 35000, null);
  const b = findApproach(RUNWAYS, 1464 + Math.sin(117.4 * RAD) * 9000, 796 - Math.cos(117.4 * RAD) * 9000, 297.4 * RAD, 35000, 'KSFO 28R');
  // the AIR-SFO-FINAL spawn (28L final, gear down) with 28R selected and no route
  const { f, inp } = fixedWing('a320neo', { x: 1464 + Math.sin(117.4 * RAD) * 9000, z: 796 - Math.cos(117.4 * RAD) * 9000, heading: 297.4 * RAD, altitude: 480 });
  f.setRoute(null);
  f.autopilot.approachRunway = 'KSFO 28R';
  f.step(0, inp, world);
  f.command('autopilot');
  fly(f, inp, 6);
  check('Selected runway: gear-down APP arming uses it (28R from the 28L final), findApproach(only)',
    a && a.name === 'KSFO 28L' && b && b.name === 'KSFO 28R' && f.ap.st.app && f.ap.st.app.name === 'KSFO 28R', `default ${a && a.name}, only → ${b && b.name}, armed ${f.ap.st.app && f.ap.st.app.name}`);
}

// 8. helicopter: route with turns ending in a hover; runway approach ending in a hover over the runway
{
  const run = (setup, secs = 700) => {
    const f = createHelicopterModel(SPECS.uh60, {});
    f.reset({ x: -1500, z: -14500, heading: 340 * RAD, altitude: 300, speed: SPECS.uh60.spawnSpeed }, world);
    const route = createRoute();
    route.env = ENV;
    f.setRoute(route);
    setup(route);
    const inp = input({ throttle: f.collective });
    f.step(1 / 60, inp, world);
    f.command('autopilot');
    const mode0 = f.autopilot.mode;
    let maxBank = 0, maxAltErr = 0, doneAt = null, lastIdx = 0, seqs = 0, since = 0;
    fly(f, inp, secs, (t) => {
      maxBank = Math.max(maxBank, Math.abs(f.roll));
      const n = f.nav;
      if (n && n.valid && n.index !== lastIdx) { seqs++; lastIdx = n.index; since = t; }
      // altitude held once the new waypoint altitude has been reached (≤ 6 m/s climb / descent)
      if (n && n.valid && !n.hover && Number.isFinite(n.alt) && t - since > 35 && route.waypoints[n.index].kind === 'wpt') maxAltErr = Math.max(maxAltErr, Math.abs(f.altitude - n.alt));
      if (!doneAt && route.finished) doneAt = t;
      if (doneAt && t > doneAt + 15) return false;
    });
    const last = route.waypoints[route.waypoints.length - 1];
    return { f, route, mode0, maxBank, maxAltErr, doneAt, seqs, dLast: Math.hypot(f.position.x - last.x, f.position.z - last.z), last };
  };
  const r1 = run((route) => { route.add(-3000, -18000, { alt: 300 }); route.add(0, -20000, { alt: 250 }); route.add(2500, -17000, { alt: 120 }); });
  check('UH-60: AFCS in nav, flies the legs (bank ≤ 23°, altitude ± 15 m), hovers at the last point (< 3 m, 120 m)',
    r1.mode0 === 'nav' && r1.seqs === 2 && r1.maxBank < 23 && r1.maxAltErr < 15 && r1.doneAt && r1.dLast < 3 && Math.abs(r1.f.altitude - 120) < 3 && r1.f.autopilot.mode === 'hover' && Math.hypot(r1.f.velocity.x, r1.f.velocity.z) < 0.5,
    `mode ${r1.mode0}, max bank ${r1.maxBank.toFixed(1)}°, alt err ${r1.maxAltErr.toFixed(1)} m, hover ${r1.dLast.toFixed(2)} m from the point at ${r1.f.altitude.toFixed(1)} m after ${r1.doneAt && r1.doneAt.toFixed(0)} s`);
  const r2 = run((route) => route.setApproach(findRunwayEnd(RUNWAYS, 'KSFO 28R'), 'helicopter'));
  check('UH-60 "Bu piste yaklaş" KSFO 28R: approach legs → hover over the runway, 4–8 m wheel height',
    r2.doneAt && r2.dLast < 3 && onRunway(r2.f.position.x, r2.f.position.z) && r2.f.agl > 4 && r2.f.agl < 8 && !r2.f.crashed,
    `hover ${r2.dLast.toFixed(2)} m from the point, agl ${r2.f.agl.toFixed(1)} m, on runway ${onRunway(r2.f.position.x, r2.f.position.z)}, ${r2.doneAt && r2.doneAt.toFixed(0)} s`);
}

// 8b. helicopter: a route engaged from the hover (waypoint behind): accelerates, turns, climbs, hovers at the end
{
  const f = createHelicopterModel(SPECS.uh60, {});
  f.reset({ x: 0, z: 0, heading: 0, altitude: ELEV + 30, speed: 0 }, world);
  const route = createRoute();
  f.setRoute(route);
  route.add(0, 3000, { alt: 200 });
  route.add(2500, 4000, { alt: 150 });
  const inp = input({ throttle: f.collective });
  fly(f, inp, 1);
  f.command('autopilot');
  const mode0 = f.autopilot.mode;
  let done = null;
  fly(f, inp, 400, (t) => { if (!done && route.finished) done = t; if (done && t > done + 15) return false; });
  const d = Math.hypot(f.position.x - 2500, f.position.z - 4000);
  check('UH-60: route engaged in a 30 m hover (first point behind): accelerates, turns, climbs, hovers at the end',
    mode0 === 'nav' && done && d < 3 && Math.abs(f.altitude - 150) < 3 && !f.crashed, `mode ${mode0}, done ${done && done.toFixed(0)} s, ${d.toFixed(2)} m from the point at ${f.altitude.toFixed(1)} m`);
}

// 8c. route edits while a leg is flown (FMS-like): a point inserted before a passed one keeps the TO waypoint; a point
//     inserted on the active leg becomes the TO waypoint; deleting the TO waypoint flies on to the next one
{
  const { f, route, inp } = fixedWing('a320neo', SPAWN.CITY);
  const a = route.add(-3000, -19000), b = route.add(-1000, -24000), c = route.add(4000, -24000);
  f.step(0, inp, world);
  f.command('autopilot');
  fly(f, inp, 200, () => (route.active >= 1 ? false : undefined));
  route.add(-2000, -16000, { index: 0 });                 // before the passed point a
  const keep = route.waypoints[route.active].id === b.id && route.active === 2;
  const m = route.add(-2400, -21500, { index: 2 });       // on the active leg a → b
  const becomesTo = route.waypoints[route.active].id === m.id;
  route.remove(m.id); route.remove(b.id);                 // delete the TO waypoints
  const next = route.waypoints[route.active].id === c.id && f.autopilot.lnav;
  let reached = false;
  fly(f, inp, 200, () => { if (route.finished) { reached = true; return false; } });
  check('Route edits in flight: insert before a passed point keeps the TO point, on the active leg → new TO, delete TO → next',
    keep && becomesTo && next && reached && !f.crashed, `keep ${keep}, new TO ${becomesTo}, next ${next}, reached ${reached}`);
}

// 9. LNAV cost: the output object is reused (no allocation per update) and an update costs microseconds
{
  const route = createRoute();
  route.setPosition(0, 0, 0);
  for (let i = 0; i < 6; i++) route.add(i * 3000, -(i % 2) * 4000 - 5000);
  const lnav = createLnav();
  const S = { x: 0, z: 0, vx: 0, vz: -120, alt: 1000, hdg: 0, category: 'airliner', bankMax: 25 * RAD, rollTime: 5, headingGain: 2 };
  const o = lnav.update(route, S, 1 / 60);
  for (let i = 0; i < 50000; i++) { S.x = i % 1000; lnav.update(route, S, 1 / 60); }   // warm-up (JIT)
  const t0 = performance.now();
  let same = true;
  for (let i = 0; i < 200000; i++) { S.x = (i % 1000); if (lnav.update(route, S, 1 / 60) !== o) same = false; }
  const us = ((performance.now() - t0) / 200000) * 1000;
  check('LNAV update reuses its output object and costs < 5 µs', same && us < 5, `${us.toFixed(3)} µs per update`);
}

// ======================================================================================================================
let failed = 0;
console.log('\n=== navigation (route, LNAV, route approach) ' + '='.repeat(50));
for (const r of rows) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(112)} ${r.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
