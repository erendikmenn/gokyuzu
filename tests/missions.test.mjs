// Missions tests (CONTRACTS-SF.md §12): landing score, daily mission, catalog, objectives with scripted samples, and
// missions flown by the real flight models against a fake bay world (the autopilot, simple stick controllers or a
// reposition stand in for the player). The in-game runtime / UI is covered by the Playwright scripts.
// Run: node tests/missions.test.mjs   (no framework: PASS/FAIL table, exit 1 on failure)
import { readFileSync } from 'node:fs';
import { createFixedWingModel } from '../src/flight/fixedwing.js';
import { createHelicopterModel } from '../src/flight/helicopter.js';
import { runwayEnds } from '../src/flight/fixedwing-autopilot.js';
import { createRoute } from '../src/nav/route.js';
import { MISSIONS, BRIDGES, buildMission, dailyMissionId, dailyMission } from '../src/missions/catalog.js';
import { createObjective } from '../src/missions/objectives.js';
import { scoreLanding, sampleTouchdown, scoreDitch, landingFields, findLandingRunway } from '../src/missions/landing-score.js';
import { istanbulDay, secondsToNextDay, dirOf, bearing, clamp, wrap180, KT, FT, FPM, DEG } from '../src/missions/util.js';
import { CHALLENGES, challengesFor, createChallengeTracker, maxChallengeScore, recordChallenge, loadChallengeProgress } from '../src/missions/challenges.js';

const RUNWAYS = JSON.parse(readFileSync(new URL('../data/sf/runways.json', import.meta.url), 'utf8'));
const REGION = JSON.parse(readFileSync(new URL('../data/sf/region.json', import.meta.url), 'utf8'));
const ENDS = runwayEnds(RUNWAYS);
const SPECS = {};
for (const id of ['a320neo', 'b737', 'f16', 'f22', 'uh60']) SPECS[id] = (await import(`../src/aircraft/${id}/spec.js`)).default;

const rows = [];
function check(name, ok, detail = '') { rows.push({ name, ok: !!ok, detail }); }
const input = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...o });

// ---- fake bay world: water everywhere except the runway rectangles (+ 150 m of land around them) and Alcatraz' pad ----
const RECTS = [];
for (const apt of RUNWAYS.airports) for (const r of apt.runways) {
  const [a, b] = r.ends; const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  RECTS.push({ ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, half: r.width / 2, elev: apt.elevation });
}
const inRect = (r, x, z, m) => { const px = x - r.ax, pz = z - r.az, al = px * r.ux + pz * r.uz; return al >= -m && al <= r.len + m && Math.abs(px * -r.uz + pz * r.ux) <= r.half + m; };
const PAD = { x: -4250, z: -22922, y: 19.7 };
const onPad = (x, z) => Math.hypot(x - PAD.x, z - PAD.z) < 60;
const GG = BRIDGES.golden_gate, GGA = dirOf(GG.axis), GGN = { dx: -GGA.dz, dz: GGA.dx };
const ggLocal = (x, z) => ({ along: (x - GG.x) * GGA.dx + (z - GG.z) * GGA.dz, across: (x - GG.x) * GGN.dx + (z - GG.z) * GGN.dz });
const world = {
  runways: RUNWAYS, region: REGION,
  getGroundHeight: (x, z) => (onPad(x, z) ? PAD.y : RECTS.some((r) => inRect(r, x, z, 150)) ? 3.5 : 0),
  isWater: (x, z) => !onPad(x, z) && !RECTS.some((r) => inRect(r, x, z, 150)),
  isOnRunway: (x, z) => RECTS.some((r) => inRect(r, x, z, 0)),
  getObstacleHeight: (x, z) => { const g = ggLocal(x, z); return Math.abs(g.along) < 1400 && Math.abs(g.across) < 14 ? 72 : -Infinity; },
  getObstacleSpan: (x, z, out = {}) => { const g = ggLocal(x, z); if (Math.abs(g.along) < 1400 && Math.abs(g.across) < 14) { out.bottom = 66; out.top = 72; } else { out.bottom = -Infinity; out.top = -Infinity; } return out; },
  hitTest: (x, y, z) => { const g = ggLocal(x, z); return Math.abs(g.along) < 1400 && Math.abs(g.across) < 14 && y > 64 && y < 74 ? 'Golden Gate Köprüsü' : null; },
};
const env = (mission) => ({ ends: ENDS, bridges: BRIDGES, score: mission ? mission.score : {}, spanAt: (x, z, o) => world.getObstacleSpan(x, z, o) });

// sample like src/missions/runtime.js
function sampler() {
  const s = { t: 0, dt: 0, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, agl: 0, ias: 0, gs: 0, vs: 0, hdg: 0, pitch: 0, roll: 0, onGround: true, first: true };
  return {
    s,
    fill(f, dt) {
      s.px = s.x; s.py = s.y; s.pz = s.z;
      s.x = f.position.x; s.y = f.position.y; s.z = f.position.z;
      s.dt = dt; s.t += dt; s.agl = f.agl; s.ias = f.ias; s.gs = Math.hypot(f.velocity.x, f.velocity.z); s.vs = f.verticalSpeed;
      s.hdg = f.heading; s.pitch = f.pitch; s.roll = f.roll; s.onGround = f.onGround;
    },
  };
}
function start(m, f) {
  const st = m.start;
  if (st.runway || st.final) {
    const e = ENDS.find((r) => r.name === (st.runway || st.final));
    if (st.runway) f.reset({ x: e.x + e.dx * 45, z: e.z + e.dz * 45, heading: e.course }, world);
    else f.reset({ x: e.x - e.dx * st.dist, z: e.z - e.dz * st.dist, heading: e.course, altitude: e.elevation + (st.dist + 300) * Math.tan(3 * DEG) }, world);
  } else {
    const opts = {};
    if (st.gear != null) opts.gearDown = !!st.gear;
    if (st.flaps != null) opts.flapIndex = st.flaps;
    f.reset({ x: st.x, z: st.z, heading: st.hdg * DEG, altitude: st.alt, speed: st.kt * KT }, world, opts);
  }
}
/** Step at 60 Hz until each(t) returns false, the model crashes, or `secs` pass. */
function fly(f, inp, secs, each) {
  const dt = 1 / 60;
  f.step(0, inp, world);
  let t = 0;
  for (; t < secs; t += dt) {
    f.step(dt, inp, world);
    if (each && each(t, dt) === false) break;
    if (f.crashed) break;
  }
  return t;
}
/** Stick toward a pitch / bank target (simple P with rate damping), yaw 0. */
function stick(f, inp, pitchT, rollT) {
  inp.pitch = clamp((pitchT - f.pitch) * 0.12 - (f.angularVelocity ? f.angularVelocity.x * 0.8 : 0), -1, 1);
  inp.roll = clamp((rollT - f.roll) * 0.05, -1, 1);
}
const headingBank = (f, hdgT, max = 30) => clamp(wrap180(hdgT - f.heading) * 1.5, -max, max);

// =====================================================================================================================
// 1. landing score
{
  const e = ENDS.find((r) => r.name === 'KSFO 28R');
  const at = (along, lat) => ({ x: e.x + e.dx * along - e.dz * lat, z: e.z + e.dz * along + e.dx * lat });
  const td = (o) => ({ ...at(o.along ?? 380, o.lat ?? 0), heading: e.course / DEG + (o.crab || 0), track: e.course / DEG, vs: -(o.fpm ?? 120) / FPM, roll: o.roll || 0, pitch: 4, gs: 70, onRunway: o.on ?? true });
  const butter = scoreLanding(td({ fpm: 90 }), { category: 'airliner', ends: ENDS });
  const good = scoreLanding(td({ fpm: 260, lat: 6, along: 620 }), { category: 'airliner', ends: ENDS });
  const hard = scoreLanding(td({ fpm: 560 }), { category: 'airliner', ends: ENDS });
  const off = scoreLanding(td({ fpm: 100, lat: 45, on: false }), { category: 'airliner', ends: ENDS });
  const bounce = scoreLanding(td({ fpm: 90 }), { category: 'airliner', ends: ENDS, bounces: 1 });
  const long = scoreLanding(td({ fpm: 150, along: 1500 }), { category: 'airliner', ends: ENDS });
  check('Landing score: butter on the centreline in the TDZ → 3★ "Tereyağı gibi"', butter.stars === 3 && butter.label === 'Tereyağı gibi' && butter.runway === 'KSFO 28R' && butter.tdz === 380 && butter.cl === 0,
    `${butter.points} pts ${butter.stars}★ ${butter.label} ${butter.runway} tdz ${butter.tdz} cl ${butter.cl}`);
  check('Landing score: 260 ft/min, 6 m off, 620 m → 2★ "Güzel"; 560 ft/min → ≤1★ "Sert"', good.stars === 2 && good.label === 'Güzel' && hard.stars <= 1 && hard.label === 'Sert',
    `${good.points}/${good.stars}★ ${good.label}; ${hard.points}/${hard.stars}★ ${hard.label}`);
  check('Landing score: off the pavement → 0★ "Pist dışı"; one bounce → ≤2★; 1.500 m long → worse zone rating',
    off.stars === 0 && off.label === 'Pist dışı' && !off.onRunway && bounce.stars <= 2 && long.ok.tdz === 'bad' && long.points < butter.points,
    `off ${off.points} ${off.label}; bounce ${bounce.stars}★; long ${long.points}`);
  const lf = landingFields(good);
  check('Landing score: telemetry fields fpm / cl / tdz / st', lf.fpm === 260 && lf.cl === 6 && lf.tdz === 620 && lf.st === 2, JSON.stringify(lf));
  const heli = scoreLanding({ x: PAD.x, z: PAD.z, heading: 0, track: 0, vs: -0.3, roll: 1, pitch: 2, gs: 0.5 }, { category: 'helicopter', ends: ENDS });
  const heliHard = scoreLanding({ x: PAD.x, z: PAD.z, heading: 0, track: 0, vs: -2.2, roll: 1, pitch: 2, gs: 4 }, { category: 'helicopter', ends: ENDS });
  check('Landing score: helicopter soft vertical landing 3★ (no runway needed), 430 ft/min drifting → 0★', heli.stars === 3 && heliHard.stars === 0, `${heli.points} ${heli.label}; ${heliHard.points} ${heliHard.label}`);
  const f16 = scoreLanding(td({ fpm: 380, along: 250 }), { category: 'fighter', ends: ENDS });
  check('Landing score: fighter 380 ft/min at 250 m → 2★ or better (fighters land firmer)', f16.stars >= 2, `${f16.points} ${f16.stars}★ ${f16.label}`);
  const d1 = scoreDitch({ fpm: 220, pitch: 9.5, roll: 1, kt: 128, gear: 0 }), d2 = scoreDitch({ fpm: 1100, pitch: 4, roll: 3, kt: 150, gear: 0 }), d3 = scoreDitch({ fpm: 300, pitch: 8, roll: 3, kt: 150, gear: 1 });
  check('Ditching score: Hudson-like → 3★; 1.100 ft/min → not survivable; gear down → not survivable', d1.stars === 3 && d1.survivable && !d2.survivable && !d3.survivable, `${d1.points} ${d1.label}; ${d2.label}; ${d3.label}`);
}

// 2. daily mission, catalog
{
  const a = dailyMissionId('20260924'), b = dailyMissionId('20260924'), m1 = dailyMission('20260924'), m2 = dailyMission('20260924');
  let repeats = 0, counts = {};
  let prev = null;
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400e3);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const id = dailyMissionId(key);
    if (id === prev) repeats++;
    prev = id; counts[id] = (counts[id] || 0) + 1;
  }
  check('Daily: same day → same mission and variation; never the same mission two days running; every mission in rotation',
    a === b && JSON.stringify(m1.params) === JSON.stringify(m2.params) && m1.day === '20260924' && repeats === 0 && Object.keys(counts).length === MISSIONS.length,
    `${a} ${JSON.stringify(m1.params)}; 400 days: ${repeats} repeats, ${JSON.stringify(counts)}`);
  const d0 = istanbulDay(new Date('2026-09-24T20:59:59Z')), d1 = istanbulDay(new Date('2026-09-24T21:00:00Z'));
  const left = secondsToNextDay(new Date('2026-09-24T20:00:00Z'));
  check('Daily: Istanbul day boundary at 21:00 UTC (UTC+3), countdown to the next day', d0 === '20260924' && d1 === '20260925' && left === 3600, `${d0} ${d1} ${left} s`);
  // every mission and 90 days of variations build, start inside the map, targets exist
  let bad = [];
  const b0 = REGION.local;
  const inside = (x, z) => x > b0.minX && x < b0.maxX && z > b0.minZ && z < b0.maxZ;
  for (const def of MISSIONS) {
    for (let i = -1; i < 90; i++) {
      const day = i < 0 ? null : `2026${String(10 + Math.floor(i / 28)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`;
      const m = buildMission(def.id, day);
      const st = m.start;
      const e = st.runway || st.final ? ENDS.find((r) => r.name === (st.runway || st.final)) : null;
      if ((st.runway || st.final) && !e) bad.push(`${def.id} ${day} start runway`);
      if (!e && !inside(st.x, st.z)) bad.push(`${def.id} ${day} start outside`);
      for (const o of m.objectives) {
        if (o.target && !ENDS.find((r) => r.name === o.target)) bad.push(`${def.id} target ${o.target}`);
        for (const g of o.gates || []) if (!inside(g.x, g.z) || world.isWater(g.x, g.z) === false && o.shape === 'frame') bad.push(`${def.id} gate`);
      }
      if (!m.title || !m.brief || !m.goal || /\{\w+\}/.test(m.brief + m.goal)) bad.push(`${def.id} text`);
      if (m.brief.split(/[.!?](\s|$)/).filter((x) => x && x.trim().length > 2).length > 4) bad.push(`${def.id} brief too long`);
      if (!(m.stars === 'landing' || m.stars === 'ditch' || (Array.isArray(m.stars) && m.stars.length === 3))) bad.push(`${def.id} stars`);
    }
  }
  check(`Catalog: ${MISSIONS.length} missions × 90 daily variations build (starts in the map, runways exist, texts filled, 1–3 sentence briefs)`,
    MISSIONS.length >= 8 && MISSIONS.length <= 10 && bad.length === 0, bad.slice(0, 6).join('; '));
  // the runtime reads the flag from mission.def (buildMission does not copy it): Bay / Golden Gate targets must stay in sight
  const noFog = MISSIONS.filter((d) => buildMission(d.id).def.fogBank === false).map((d) => d.id).sort().join(',');
  check('Catalog: fog bank off for the Bay / Golden Gate missions', noFog === 'alcatraz,bay-tour,ditch,gg-under,low-pass', noFog);
}

// 3. objectives with scripted samples
{
  const m = buildMission('low-pass');
  const o = createObjective(m.objectives[0], env(m));
  o.orient(m.start.x, m.start.z); o.start();
  const smp = sampler();
  const move = (x, y, z) => { smp.s.px = smp.s.x; smp.s.py = smp.s.y; smp.s.pz = smp.s.z; smp.s.x = x; smp.s.y = y; smp.s.z = z; smp.s.dt = 0.1; o.update(smp.s); smp.s.first = false; };
  const g = o.gates[0];
  move(g.x - g.nx * 100, 45, g.z - g.nz * 100);
  move(g.x - g.nx * 100 + 0, 150, g.z - g.nz * 100);      // climbing, not crossing
  move(g.x + g.nx * 50, 150, g.z + g.nz * 50);            // crossing above the gate: missed
  const missed = o.index === 0 && /üstünden/.test(o.message || '');
  o.message = null;
  move(g.x - g.nx * 50, 45, g.z - g.nz * 50);             // back through the plane (the other way, high → ignored: above)
  move(g.x + g.nx * 60 + 20 * -g.nz, 42, g.z + g.nz * 60 + 20 * g.nx);   // through, 20 m off centre
  const passed = o.index === 1 && o.gates[0].acc > 0.6;
  for (let i = 1; i < o.gates.length; i++) { const q = o.gates[i]; move(q.x - q.nx * 80, 40, q.z - q.nz * 80); move(q.x + q.nx * 80, 40, q.z + q.nz * 80); }
  check('Objective gates: over the frame → "üstünden" and stays; through → next; all 5 → done with points', missed && passed && o.status === 'done' && o.points > 1000,
    `missed ${missed}, passed ${passed}, status ${o.status}, ${o.points} pts`);

  const gm = buildMission('gg-under');
  const br = createObjective(gm.objectives[0], env(gm));
  br.start();
  const s2 = sampler().s;
  const cross = (y, along) => {
    const c = { x: GG.x + GGA.dx * along, z: GG.z + GGA.dz * along };
    Object.assign(s2, { first: false, px: c.x - GGN.dx * 40, pz: c.z - GGN.dz * 40, py: y, x: c.x + GGN.dx * 40, z: c.z + GGN.dz * 40, y, dt: 0.2 });
    br.update(s2);
  };
  cross(90, 0);
  const over = br.status === 'active' && /üstünden/.test(br.message || '');
  cross(40, 900);
  const outside = br.status === 'active';
  cross(38, 60);
  check('Objective bridge: over the deck → message, beyond the towers → no, under the deck (span 66 m) mid-span → done',
    over && outside && br.status === 'done' && br.points > 700, `${br.status} ${br.points} ${JSON.stringify(br.parts)}`);

  const am = buildMission('alcatraz');
  const hv = createObjective(am.objectives[0], env(am));
  hv.start();
  const s3 = sampler().s;
  Object.assign(s3, { x: PAD.x + 3, z: PAD.z - 2, y: PAD.y + 9, onGround: false, gs: 0.5, dt: 0.1 });
  for (let i = 0; i < 60 && hv.status === 'active'; i++) hv.update(s3);
  check('Objective hover: 3 m off the pad at 9 m for 5 s → done', hv.status === 'done' && hv.points > 200, `${hv.status} ${hv.points} ${hv.progress}`);

  const sm = buildMission('sfo-28r');
  const ld = createObjective(sm.objectives[0], env(sm));
  ld.start();
  const e = ENDS.find((r) => r.name === 'KSFO 28L');
  ld.onLanding(scoreLanding({ x: e.x + e.dx * 400, z: e.z + e.dz * 400, heading: e.course / DEG, track: e.course / DEG, vs: -1, roll: 0, pitch: 4, gs: 70 }, { category: 'airliner', ends: ENDS }));
  check('Objective land: 28L when 28R was asked → fail "Yanlış pist"', ld.status === 'fail' && /Yanlış pist/.test(ld.failReason), ld.failReason);
}

// =====================================================================================================================
// 4. missions flown by the flight models (fake bay world)

// 4a. "Dik tırmanış" (F-22): full afterburner, rotate at VR, 30° climb → 10,000 ft
{
  const m = buildMission('climb');
  const f = createFixedWingModel(SPECS.f22, {});
  start(m, f);
  const o = createObjective(m.objectives[0], env(m)); o.start();
  const smp = sampler(); const inp = input({ throttle: 1 });
  const t = fly(f, inp, 120, (t, dt) => {
    const kt = f.ias / KT;
    const pT = f.onGround ? (kt > 125 ? 10 : 0) : Math.min(35, 10 + smp.s.t * 3);
    stick(f, inp, pT, 0);
    if (!f.onGround && f.gearHandleDown && f.agl > 20) f.command('gear');
    smp.fill(f, dt); o.update(smp.s); smp.s.first = false;
    return o.status === 'active';
  });
  const score = 1000 + Math.max(0, 120 - t) * 25;
  const stars = m.stars.filter((x) => score >= x).length;
  check('Mission climb (F-22): 10,000 ft reached, time → ≥ 2★ for a clean max-performance climb', o.status === 'done' && !f.crashed && stars >= 2,
    `${t.toFixed(1)} s, score ${Math.round(score)}, ${stars}★, ${Math.round(f.altitude / FT)} ft, ${Math.round(f.ias / KT)} kt`);
}

// 4b. "Golden Gate'in altından geç" (F-16): hold 35 m and the crossing heading, then climb to 1,500 ft
{
  const m = buildMission('gg-under');
  const f = createFixedWingModel(SPECS.f16, {});
  start(m, f);
  const obs = m.objectives.map((d) => createObjective(d, env(m)));
  obs.forEach((o) => o.start());
  let cur = 0;
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  const t = fly(f, inp, 150, (t, dt) => {
    const climb = cur >= 1;
    const altT = climb ? 700 : 35;
    const vsT = clamp((altT - f.altitude) * 0.25, -12, climb ? 40 : 12);
    const pT = clamp(f.pitch + (vsT - f.verticalSpeed) * 0.35, -8, 25);
    stick(f, inp, pT, headingBank(f, m.start.hdg));
    smp.fill(f, dt);
    obs[cur].update(smp.s); smp.s.first = false;
    if (obs[cur].status === 'done') cur++;
    return cur < obs.length;
  });
  check('Mission gg-under (F-16): under the deck between the towers (fake bridge span), then 1,500 ft', cur === 2 && !f.crashed,
    `${t.toFixed(1)} s, ${obs.map((o) => `${o.def.type}:${o.status}:${o.points}`).join(' ')}, crashed ${f.crashed} ${f.crashReason}`);
}

// 4c. "SFO 28R'ye iniş" (A320): from the mission's final, the autopilot (ILS + autoland) stands in for the pilot →
//     the touchdown event gives a landing score on 28R
{
  const m = buildMission('sfo-28r');
  const f = createFixedWingModel(SPECS.a320neo, {});
  start(m, f);
  const inp = input({ throttle: f.throttle });
  let td = null, card = null;
  f.on('touchdown', (i) => { if (!td) { td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); } });
  fly(f, inp, 1, () => true);
  f.command('autopilot');
  fly(f, inp, 240, () => !td || f.groundSpeed > 20);
  check('Mission sfo-28r (A320 final): touchdown on 28R scored (autoland: ≥ 2★, in the touchdown zone, near the centreline)',
    card && card.runway === 'KSFO 28R' && card.onRunway && card.stars >= 2 && card.tdz > 100 && card.tdz < 914 && card.cl < 5,
    card ? `${card.points} pts ${card.stars}★ ${card.label}: ${card.fpm} ft/min, cl ${card.cl} m ${card.side}, ${card.tdz} m, bank ${card.bank}°` : `no touchdown, crashed ${f.crashed} ${f.crashReason}`);
}

// 4d. "Körfeze mecburi iniş" (A320): dual engine failure at 2,500 ft, wings level glide at ~150 kt, flare → ditching
{
  const m = buildMission('ditch');
  const f = createFixedWingModel(SPECS.a320neo, {});
  start(m, f);
  const inp = input({ throttle: f.throttle });
  const o = createObjective(m.objectives[0], env(m)); o.start();
  let injected = false, ditch = null, t0 = 0;
  f.on('ditch', (i) => { ditch = i; o.onDitch({ fpm: Math.max(0, -i.verticalSpeed * FPM), pitch: i.pitch, roll: i.roll, kt: i.ias / KT, gear: 0, survived: true }); });
  const trace = [];
  fly(f, inp, 300, (t) => {
    if (!injected && t >= 3) { injected = f.failures ? f.failures.inject('engineAll', { restartable: false }) : false; t0 = t; }
    const agl = f.agl, kt = f.ias / KT;
    // glide at ~150 kt (pitch for speed), below 60 m trade speed for a shallow sink: vs target → pitch
    const vsT = agl > 60 ? null : -Math.max(1.0, agl * 0.05);
    const pT = vsT === null ? clamp(f.pitch + (kt - 150) * 0.12, -6, 8) : clamp(f.pitch + (vsT - f.verticalSpeed) * 0.6, 2, 11.5);
    stick(f, inp, pT, 0);
    inp.throttle = 0;
    if (Math.round(t * 60) % 60 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(agl)}m ${Math.round(kt)}kt vs${f.verticalSpeed.toFixed(1)} p${f.pitch.toFixed(1)}`);
    return !f.ditched && !f.crashed;
  });
  check('Mission ditch (A320): engineAll injected, glide, flare → survivable ditching (flight.ditched), ditch objective done ≥ 1★',
    injected && f.ditched && !f.crashed && o.status === 'done' && o.ditch.stars >= 1,
    `${f.crashed ? trace.slice(-6).join(' | ') + ' ' : ''}injected ${injected}; ${ditch ? `${Math.round(-ditch.verticalSpeed * FPM)} ft/min, pitch ${ditch.pitch.toFixed(1)}°, roll ${ditch.roll.toFixed(1)}°, ${Math.round(ditch.ias / KT)} kt` : 'no ditch'}; ${o.status} ${o.ditch ? `${o.ditch.points} pts ${o.ditch.stars}★ ${o.ditch.label}` : o.failReason}; crashed ${f.crashed} ${f.crashReason}`);
}

// 4e. "Körfez turu" (737): the mission's route on LNAV, autopilot NAV → the three rings in order
{
  const m = buildMission('bay-tour');
  const f = createFixedWingModel(SPECS.b737, {});
  const route = createRoute();
  route.env = { groundAt: (x, z) => world.getGroundHeight(x, z), bounds: REGION.local };
  f.setRoute(route);
  route.setPosition(m.start.x, m.start.z, m.start.hdg * DEG);
  for (const p of m.route) route.add(p.x, p.z, { alt: p.alt });
  start(m, f);
  const o = createObjective(m.objectives[0], env(m)); o.orient(m.start.x, m.start.z); o.start();
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  fly(f, inp, 0.5, () => true);
  f.command('autopilot');
  const nav = f.autopilot.lnav;
  const t = fly(f, inp, 300, (t, dt) => { smp.fill(f, dt); o.update(smp.s); smp.s.first = false; return o.status === 'active'; });
  check('Mission bay-tour (737): route loaded, AP in NAV flies Bay Bridge → Alcatraz → Golden Gate rings', nav && o.status === 'done',
    `NAV ${nav}, ${t.toFixed(0)} s, rings ${o.index}/3, ${o.points} pts, acc ${o.gates.map((g) => g.acc.toFixed(2)).join('/')}`);
}

// 4f. "Alcatraz'a hassas iniş" (UH-60): repositioned 10 m over the pad, hover hold → hover objective; collective down →
//     touchdown on the pad (pad objective, helicopter landing score)
{
  const m = buildMission('alcatraz');
  const f = createHelicopterModel(SPECS.uh60, {});
  f.reset({ x: PAD.x + 2, z: PAD.z - 1, heading: 0, altitude: PAD.y + 10, speed: 0 }, world);
  const obs = m.objectives.map((d) => createObjective(d, env(m)));
  obs.forEach((o) => o.start());
  let cur = 0, card = null;
  f.on('touchdown', (i) => { const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'helicopter', ends: ENDS }); if (obs[cur] && obs[cur].def.type === 'pad') obs[cur].onLanding(card, td); });
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  fly(f, inp, 0.3, () => true);
  f.command('autopilot');   // hover hold
  let lowerT = null;
  const trace = [];
  fly(f, inp, 90, (t, dt) => {
    smp.fill(f, dt);
    if (obs[cur] && obs[cur].status === 'active') obs[cur].update(smp.s);
    smp.s.first = false;
    if (obs[cur] && obs[cur].status === 'done') cur++;
    if (cur === 1 && lowerT === null) { lowerT = t; inp.throttle = f.collective; if (f.autopilot && f.autopilot.on) f.command('autopilot'); }
    if (cur >= 1) {   // collective for a gentle sink: 1 m/s high, 0.3 m/s near the ground
      const vsT = -clamp((f.agl - 1.5) * 0.25, 0.3, 1.0);
      inp.throttle = clamp(inp.throttle + (vsT - f.verticalSpeed) * 0.004, 0, 1);
    }
    if (Math.round(t * 60) % 30 === 0) trace.push(`${t.toFixed(1)}s ${f.agl.toFixed(1)}m vs${f.verticalSpeed.toFixed(2)} c${(f.collective || 0).toFixed(2)} in${inp.throttle.toFixed(2)}`);
    return cur < obs.length && !f.crashed;
  });
  check('Mission alcatraz (UH-60): hover 5 s over the pad, then touchdown on the pad → both objectives done',
    cur === 2 && !f.crashed, `${f.crashed ? trace.slice(-8).join(' | ') + ' ' : ''}${obs.map((o) => `${o.def.type}:${o.status}:${o.points}`).join(' ')}; card ${card ? `${card.points} ${card.label} ${card.fpm} ft/min` : '—'}; crashed ${f.crashed} ${f.crashReason}`);
}

// 4g. "Otorotasyon" (UH-60): both engines out at 1,500 ft over Alameda 24 → collective down, ~75 kt glide, flare,
//     cushion with the collective → a survivable touchdown (helicopter landing score ≥ 1★)
{
  const m = buildMission('autorotation');
  const f = createHelicopterModel(SPECS.uh60, {});
  start(m, f);
  const o = createObjective(m.objectives[0], env(m)); o.start();
  const inp = input({ throttle: f.collective });
  let injected = false, card = null, minNr = 9, cush = null;
  const trace = [];
  f.on('touchdown', (i) => { if (card) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'helicopter', ends: ENDS, profile: m.objectives[0].profile }); o.onLanding(card, td); });
  fly(f, inp, 150, (t) => {
    if (!injected && t >= 3) injected = f.failures.inject('engineAll', {});
    const kt = f.ias / KT, agl = f.agl;
    if (injected) {
      // collective down (rotor RPM), ~70 kt glide; flare from 35 m (nose up, speed and sink bleed off, RPM builds);
      // level at 6 m and cushion the last metres with the collective (the rotor's stored energy)
      if (agl > 25) { inp.throttle = 0.1; stick(f, inp, clamp(2 + (kt - 60) * 0.4, -6, 12), 0); }   // 60 kt glide
      else if (agl > 8 && kt > 12) { inp.throttle = 0.1; stick(f, inp, 18, 0); }                    // flare: trade speed
      else { cush = clamp((cush ?? 0.3) + (-0.8 - f.verticalSpeed) * 0.02, 0.1, 1); inp.throttle = cush; stick(f, inp, 5, 0); }   // cushion
      if (t > 6 && agl > 25) minNr = Math.min(minNr, f.rotorRPM || 0);   // the steady autorotation (the cushion spends RPM)
    } else stick(f, inp, f.pitch, 0);
    if (Math.round(t * 60) % 60 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(agl)}m ${Math.round(kt)}kt vs${f.verticalSpeed.toFixed(1)} nr${(f.rotorRPM || 0).toFixed(2)}`);
    return !card && !f.crashed;
  });
  check('Mission autorotation (UH-60): engines out, autorotation glide + flare → survivable touchdown, rotor RPM kept in the green',
    injected && card && !f.crashed && o.status === 'done' && minNr >= 0.9,
    `${f.crashed ? trace.slice(-6).join(' | ') + ' ' : ''}${card ? `${card.points} pts ${card.stars}★ ${card.label}, ${card.fpm} ft/min, drift ${card.drift} kt, ${card.runway || 'off runway'}` : 'no touchdown'}; NR min ${minNr.toFixed(2)}; ${o.status} ${o.failReason}; crashed ${f.crashed} ${f.crashReason}`);
}

// 4h. "Alev sönmesi" (F-16): engine out at 7,000 ft 12 km out on the SFO 28L centreline: best glide, then a 6° path with
//     the speed brake burning the extra height, G + ACİL (alternate gear: hydraulic B is lost), flare → touchdown on 28L
{
  const m = buildMission('flameout');
  const f = createFixedWingModel(SPECS.f16, {});
  start(m, f);
  const o = createObjective(m.objectives[0], env(m)); o.start();
  const e = ENDS.find((r) => r.name === 'KSFO 28L');
  const inp = input({ throttle: f.throttle });
  let injected = false, card = null, gear = false, sb = false;
  const trace = [];
  f.on('touchdown', (i) => { if (card) return; card = scoreLanding(sampleTouchdown(f, i, {}), { category: 'fighter', ends: ENDS }); o.onLanding(card); });
  fly(f, inp, 300, (t) => {
    if (!injected && t >= 4) injected = f.failures.inject('engine', { index: 0, restartable: false });
    inp.throttle = 0;
    const kt = f.ias / KT, agl = f.agl;
    const along = -((f.position.x - e.x) * e.dx + (f.position.z - e.z) * e.dz), lat = (f.position.x - e.x) * -e.dz + (f.position.z - e.z) * e.dx;
    const pathAlt = e.elevation + Math.max(0, along + 600) * Math.tan(6 * DEG);    // 6° to a point 600 m past the threshold
    if (!gear && along < 4500) { gear = true; f.command('gear'); }
    if (gear && f.gear < 0.5 && f.gearHandleDown) f.command('emergency');         // hydraulic B lost: ALT GEAR (I / ACİL)
    const wantSb = f.altitude > pathAlt + 40 && kt > 185;                          // speed brake burns the extra height
    if (wantSb !== sb) { sb = wantSb; f.command('speedbrake'); }
    const vsT = clamp(-kt * KT * Math.tan(6 * DEG) + (pathAlt - f.altitude) * 0.12, -40, 3);
    let pT = clamp(f.pitch + (vsT - f.verticalSpeed) * 0.3, -16, 12);
    if (kt < 175 && agl > 35) pT = Math.min(pT, f.pitch - 0.5);                    // never slower than ~175 kt before the flare
    if (agl < 35) pT = clamp(3 + (35 - agl) * (8 / 35), 3, 11);                    // flare
    stick(f, inp, pT, clamp(-lat * 0.08 + wrap180(e.course / DEG - f.heading) * 1.5, -30, 30));
    if (Math.round(t * 60) % 300 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(agl)}m ${Math.round(kt)}kt al${Math.round(along)} path${Math.round(pathAlt)} gear${f.gear.toFixed(2)}`);
    return !card && !f.crashed;
  });
  check('Mission flameout (F-16): engine out at 7,000 ft, straight-in glide with gear + speed brake → touchdown on 28L ≥ 1★',
    injected && card && card.onRunway && o.status === 'done',
    `${!card || f.crashed ? trace.slice(-8).join(' | ') + ' ' : ''}${card ? `${card.points} pts ${card.stars}★ ${card.label}, ${card.fpm} ft/min, ${card.runway}, ${card.tdz} m` : 'no touchdown'}; ${o.status} ${o.failReason}; crashed ${f.crashed} ${f.crashReason}`);
}

// 4i. "Kalkışta motor arızası" (737): take-off 01R over the bay, engine 1 fails at 400 ft → climb on one engine to
//     1,500 ft; then (standing in for the player's turn back) repositioned 8 km out on the 19L final with the engine still
//     failed, the autopilot's ILS + autoland on one engine → an SFO landing completes the mission
{
  const m = buildMission('eng-takeoff');
  const f = createFixedWingModel(SPECS.b737, {});
  start(m, f);
  const obs = m.objectives.map((d) => createObjective(d, env(m)));
  obs.forEach((o) => o.start());
  let cur = 0, injected = false, card = null, climbT = 0, relanded = false;
  const smp = sampler(); const inp = input({ throttle: 1 });
  const trace = [];
  f.on('touchdown', (i) => { if (card || !relanded) return; const td = sampleTouchdown(f, i, {}); card = scoreLanding(td, { category: 'airliner', ends: ENDS }); if (obs[cur]) obs[cur].onLanding(card, td); });
  fly(f, inp, 500, (t, dt) => {
    const kt = f.ias / KT;
    smp.fill(f, dt);
    if (!injected && !f.onGround && f.agl >= m.failures[0].at.agl) injected = f.failures.inject('engine', { index: 0 });
    if (cur === 0) {   // hand-flown engine-out climb: V2 + 10 (≈ 160 kt), wings level, gear up
      const pT = f.onGround ? (kt > 145 ? 8 : 0) : clamp(f.pitch + (kt - 165) * 0.12, 2, 12);
      stick(f, inp, pT, headingBank(f, 27));
      inp.throttle = 1;
      if (!f.onGround && f.gearHandleDown && f.agl > 30) f.command('gear');
      if (injected) climbT += dt;
    }
    if (obs[cur] && obs[cur].status === 'active') obs[cur].update(smp.s);
    smp.s.first = false;
    if (obs[cur] && obs[cur].status === 'done') {
      cur++;
      if (cur === 1 && !relanded) {   // the turn back, abbreviated: 8 km final of 19L, one engine still out
        const e = ENDS.find((r) => r.name === 'KSFO 19L');
        f.reset({ x: e.x - e.dx * 8000, z: e.z - e.dz * 8000, heading: e.course, altitude: e.elevation + 8300 * Math.tan(3 * DEG) }, world);
        f.failures.inject('engine', { index: 0 });
        inp.pitch = 0; inp.roll = 0; inp.throttle = f.throttle;   // hands off: the autopilot flies
        f.step(0, inp, world);
        f.command('autopilot');
        relanded = true;
      }
    }
    if (relanded) {   // the pilot's rudder against the live engine (the autopilot's LOC alone settles ~35 m off the centreline)
      const e = ENDS.find((r) => r.name === 'KSFO 19L');
      inp.yaw = clamp(-((f.position.x - e.x) * -e.dz + (f.position.z - e.z) * e.dx) * 0.01, -0.6, 0.6);
    }
    if (Math.round(t * 60) % 600 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(f.agl)}m ${Math.round(kt)}kt ${f.autopilot.mode || ''} n1 ${f.engines.map((x) => x.n1.toFixed(2)).join('/')}`);
    return !(card && f.groundSpeed < 30) && !f.crashed;
  });
  check('Mission eng-takeoff (737): engine failure at 400 ft, one-engine climb to 1,500 ft, single-engine ILS → SFO landing',
    injected && climbT > 0 && cur === 2 && card && card.onRunway && !f.crashed,
    `${!card || f.crashed ? trace.join(' | ') + ' ' : ''}climb ${climbT.toFixed(0)} s; ${obs.map((o) => `${o.def.type}:${o.status}`).join(' ')}; ${card ? `${card.points} pts ${card.stars}★ ${card.label}, ${card.fpm} ft/min, ${card.runway} cl ${card.cl} tdz ${card.tdz}` : 'no landing'}; crashed ${f.crashed} ${f.crashReason}`);
}

// 4j. "Alçak geçiş" (F-22, no autopilot in this mission): hand-flown along each leg (cross-track guidance from the previous
//     gate to the next, 70° bank max, "released = flight path hold" pitch at 40 m, ~330 kt) through the five frames
{
  const m = buildMission('low-pass');
  const f = createFixedWingModel(SPECS.f22, {});
  start(m, f);
  const o = createObjective(m.objectives[0], env(m)); o.orient(m.start.x, m.start.z); o.start();
  const smp = sampler(); const inp = input({ throttle: f.throttle });
  const trace = [];
  const t = fly(f, inp, 150, (t, dt) => {
    const i = Math.min(o.index, o.gates.length - 1), g = o.gates[i];
    const a = i === 0 ? { x: m.start.x, z: m.start.z } : o.gates[i - 1];
    const lx = g.x - a.x, lz = g.z - a.z, L = Math.hypot(lx, lz), ux = lx / L, uz = lz / L;
    const xt = (f.position.x - a.x) * -uz + (f.position.z - a.z) * ux;           // + right of the leg
    const hdgT = bearing(0, 0, ux, uz) + clamp(-xt * 0.25, -40, 40);
    const vsT = clamp((g.y - f.altitude) * 0.5, -8, 8);
    inp.pitch = clamp((vsT - f.verticalSpeed) * 0.05, -0.5, 0.5);
    inp.roll = clamp((clamp(wrap180(hdgT - f.heading) * 2, -70, 70) - f.roll) * 0.02, -0.4, 0.4);   // roll-rate command
    inp.throttle = clamp(0.5 + (330 - f.ias / KT) * 0.02, 0, 0.89);            // ~330 kt without afterburner
    smp.fill(f, dt); o.update(smp.s); smp.s.first = false;
    if (Math.round(t * 60) % 120 === 0) trace.push(`${t.toFixed(0)}s ${Math.round(f.altitude)}m xt${Math.round(xt)} r${Math.round(f.roll)} g${o.index}`);
    return o.status === 'active';
  });
  const score = o.points + Math.max(0, m.score.par - t) * m.score.perSec;
  const stars = m.stars.filter((x) => score >= x).length;
  check('Mission low-pass (F-22): hand-flown through the 5 low frames in order → done, ≥ 2★ for a clean run',
    o.status === 'done' && !f.crashed && stars >= 2,
    `${o.status !== 'done' ? trace.slice(-12).join(' | ') + ' ' : ''}${t.toFixed(0)} s, ${o.points} pts + time → ${Math.round(score)} (${stars}★), acc ${o.gates.map((x) => x.acc.toFixed(2)).join('/')}; crashed ${f.crashed} ${f.crashReason}`);
}


// =====================================================================================================================
// 5. free-flight challenges (src/missions/challenges.js): passive detection with scripted samples and the flight models
function ffTracker(aircraft, category, hooks = {}) {
  const ev = [];
  const tr = createChallengeTracker({
    aircraft, category, ends: ENDS, bridges: BRIDGES, spanAt: (x, z, o) => world.getObstacleSpan(x, z, o),
    isOnRunway: world.isOnRunway, isWater: world.isWater, hooks, emit: (type, e, data) => ev.push({ type, id: e.id, data }),
  });
  const s = sampler().s;
  const put = (o, dt = 0.1) => { s.px = s.x; s.py = s.y; s.pz = s.z; Object.assign(s, o); s.dt = dt; s.t += dt; tr.update(s); s.first = false; };
  return { tr, ev, s, put, last: (type, id) => [...ev].reverse().find((x) => x.type === type && (!id || x.id === id)) };
}
{
  const ids = (ac) => challengesFor(ac).map((c) => c.id).join(',');
  const boards = new Set(CHALLENGES.map((c) => c.board));
  check('Free flight: catalog — ff-<id> boards, siblings of real missions, per-aircraft lists (Alcatraz / autorotation only UH-60, climb fixed wing, engine / ditching twin airliners, flameout F-16)',
    boards.size === CHALLENGES.length && CHALLENGES.every((c) => c.board === `ff-${c.id}` && buildMission(c.mission) && c.title && c.hint && maxChallengeScore(c) > 0)
    && ids('f22') === 'bridge,low-pass,bay-tour,climb,landing' && ids('uh60') === 'bridge,low-pass,bay-tour,alcatraz,landing,autorot'
    && ids('b737') === 'bridge,low-pass,bay-tour,climb,landing,eng,ditch' && ids('a320neo') === ids('b737') && ids('f16') === 'bridge,low-pass,bay-tour,climb,landing,flameout',
    ['f16', 'f22', 'a320neo', 'b737', 'uh60'].map((a) => `${a}: ${ids(a)}`).join(' | '));
}
// 5a. Golden Gate: not evaluated far away, over the deck → message only, under the deck → done (base + centre + height);
//     re-armed after a short cool-down
{
  const { tr, ev, s, put, last } = ffTracker('uh60', 'helicopter');
  const along = (d, a) => ({ x: GG.x + GGA.dx * a + GGN.dx * d, z: GG.z + GGA.dz * a + GGN.dz * d });
  put({ ...along(-40, 0), y: 90, first: true }); put({ ...along(40, 0), y: 90 });          // over the deck
  const over = ev.some((x) => x.type === 'message' && /üstünden/.test(x.data)) && !last('done');
  put({ ...along(-40, 60), y: 38, first: true }); put({ ...along(40, 60), y: 38 });        // under, 60 m from mid-span
  const d1 = last('done', 'bridge');
  put({ ...along(-40, 0), y: 38, first: true }); put({ ...along(40, 0), y: 38 });          // again at once: cool-down
  const n1 = ev.filter((x) => x.type === 'done').length;
  for (let i = 0; i < 25; i++) put({ ...along(-600, 0), y: 38, first: i === 0 });         // 2.5 s away from the bridge
  put({ ...along(-40, 0), y: 38, first: true }); put({ ...along(40, 0), y: 38 });
  const n2 = ev.filter((x) => x.type === 'done').length;
  // a crossing of the bridge line 20 km away is never looked at (distance check first)
  const { ev: ev2, put: put2 } = ffTracker('f16', 'fighter');
  put2({ x: GG.x + GGA.dx * 20000 - GGN.dx * 40, z: GG.z + GGA.dz * 20000 - GGN.dz * 40, y: 30, first: true });
  put2({ x: GG.x + GGA.dx * 20000 + GGN.dx * 40, z: GG.z + GGA.dz * 20000 + GGN.dz * 40, y: 30 });
  check('Free flight bridge: over the deck → message; under it → done 1000 + centre + height, stars; cool-down, then again; far crossings ignored',
    over && d1 && d1.data.ok && d1.data.score >= 1700 && d1.data.stars === 3 && d1.data.board === 'ff-bridge' && d1.data.time === null && n1 === 1 && n2 === 2 && ev2.length === 0,
    d1 ? `${d1.data.score} pts ${d1.data.stars}★ ${JSON.stringify(d1.data.rows)}; passes ${n1} → ${n2}` : `no pass: ${JSON.stringify(ev)}`);
  void tr; void s;
}
// 5b. gate runs: gate 1 starts the clock (auto-start), all gates in order → done with the time bonus from gate 1;
//     a started run far away is dropped silently; a crash fails it
{
  const { tr, ev, put, last } = ffTracker('f22', 'fighter');
  const lp = tr.byId['low-pass'];
  const G = lp.gates;
  const thru = (g, y, dt) => { put({ x: g.x - g.nx * 60, y, z: g.z - g.nz * 60 }, dt); put({ x: g.x + g.nx * 60, y, z: g.z + g.nz * 60 }, 0.6); };
  put({ x: 3200, y: 40, z: -500, first: true });
  thru(G[0], 40, 0.1);
  const started = last('start', 'low-pass') && lp.status === 'run';
  const t0 = lp.t0;
  for (let i = 1; i < G.length; i++) thru(G[i], 40, 14);     // ≈ 14.6 s per leg
  const d = last('done', 'low-pass');
  const el = d ? d.data.time : 0;
  const expectBonus = Math.round(Math.max(0, 100 - el) * 15);
  const okDone = d && d.data.ok && Math.abs(el - 4 * 14.6) < 0.01 && d.data.rows.some((r) => /Süre/.test(r[0]) && r[2] === expectBonus) && lp.status === 'idle';
  // second run: dropped far away
  thru(G[0], 40, 0.1);
  const run2 = lp.status === 'run';
  put({ x: 30000, y: 400, z: 20000, first: true }, 0.1); put({ x: 30010, y: 400, z: 20000 }, 0.1);
  const dropped = lp.status === 'idle' && last('abort', 'low-pass');
  // third run: a crash fails it (and the idle entries stay quiet)
  put({ x: 3200, y: 40, z: -500, first: true }); thru(G[0], 40, 0.1);
  const nFail = ev.filter((x) => x.type === 'fail').length;
  tr.onCrash('Kaza: Suya çarptı');
  const f = last('fail', 'low-pass');
  check('Free flight gates (low pass): gate 1 auto-starts the clock, 5 gates → done + time bonus from gate 1; far away → dropped; crash → fail',
    started && t0 > 0 && okDone && run2 && dropped && f && !f.data.ok && /Kaza/.test(f.data.reason) && ev.filter((x) => x.type === 'fail').length === nFail + 1,
    d ? `${d.data.score} pts ${d.data.stars}★ in ${el.toFixed(1)} s (bonus ${expectBonus}); fail "${f && f.data.reason}"` : `no done: ${JSON.stringify(ev.slice(-4))}`);
}
// 5c. climb clock: armed at a standstill on a runway, the clock starts with the take-off roll (not while parked),
//     a rejected take-off re-arms, 10,000 ft → done with the mission's score formula
{
  const { tr, ev, put, last } = ffTracker('f16', 'fighter');
  const cl = tr.byId.climb;
  const e = ENDS.find((r) => r.name === 'KNGZ 24');
  const at = (d) => ({ x: e.x + e.dx * d, z: e.z + e.dz * d });
  put({ ...at(50), y: 3.5, onGround: true, gs: 0, first: true });
  for (let i = 0; i < 20; i++) put({ ...at(50), y: 3.5, onGround: true, gs: 0 });     // 2 s parked: no clock
  const armed = cl.status === 'armed';
  put({ ...at(52), y: 3.5, onGround: true, gs: 4 });                                   // roll → start
  const t0 = cl.t0, started = cl.status === 'run';
  put({ ...at(55), y: 3.5, onGround: true, gs: 0.5 });                                 // rejected take-off
  const rearmed = cl.status === 'armed' && last('abort', 'climb');
  put({ ...at(56), y: 3.5, onGround: true, gs: 5 });
  const t1 = cl.t0;
  put({ ...at(900), y: 4, onGround: true, gs: 80 }, 10);
  for (let k = 1; k <= 40; k++) put({ ...at(900 + k * 200), y: 4 + k * 80, onGround: false, gs: 150 }, 1);   // 40 s climb → 3204 m
  const d = last('done', 'climb');
  const el = d ? d.data.time : 0;
  check('Free flight climb: armed parked on the runway, clock from the roll, rejected take-off re-arms, 10,000 ft → 1000 + 25/s under 120 s',
    armed && started && rearmed && t1 > t0 && d && d.data.ok && Math.abs(el - 49) < 0.05 && d.data.score === 1000 + Math.round((120 - el) * 25) && d.data.stars === 3,
    d ? `${el.toFixed(1)} s → ${d.data.score} pts ${d.data.stars}★` : JSON.stringify(ev));
}
// 5d. emergencies: gating by aircraft and state, the failure injected now, a runway landing completes it (the failure is
//     cleared), off-runway / crash fails it, a reset ends it silently; the landing entry counts every runway landing
{
  const calls = [];
  const hooks = { inject: (k, o) => { calls.push(['inject', k, o.index]); return true; }, clearFailure: (k) => calls.push(['clear', k]), suspendRandom: (on) => calls.push(['random', on]) };
  const { tr, ev, s, put, last } = ffTracker('b737', 'airliner', hooks);
  const land = ENDS.find((r) => r.name === 'KSFO 28R');
  put({ x: land.x, y: 3.5, z: land.z, onGround: true, agl: 0, first: true });
  const ground = tr.canStart('eng', s).reason;
  put({ x: 3000, y: 60, z: -4000, onGround: false, agl: 60 });
  const low = tr.canStart('eng', s).reason;
  put({ x: 3000, y: 400, z: -4000, onGround: false, agl: 400 });
  const water = tr.canStart('ditch', s).ok;
  put({ x: land.x - land.dx * 3000, y: 400, z: land.z - land.dz * 3000, onGround: false, agl: 330 });   // over the SFO land margin? (fake world: water)
  const f22 = ffTracker('f22', 'fighter');
  const noEng = !f22.tr.byId.eng && !f22.tr.start('eng', s).ok && !createChallengeTracker({ aircraft: 'f16' }).byId.ditch;
  const st = tr.start('eng', s);
  const other = tr.canStart('ditch', s).reason;
  const td = { x: land.x + land.dx * 400, z: land.z + land.dz * 400, heading: land.course / DEG, track: land.course / DEG, vs: -1.0, roll: 0, pitch: 4, gs: 70, onRunway: true };
  const card = scoreLanding(td, { category: 'airliner', ends: ENDS });
  tr.onLanding(card, td);
  const done = last('done', 'eng'), landDone = last('done', 'landing');
  const injected = calls.find((c) => c[0] === 'inject'), cleared = calls.find((c) => c[0] === 'clear' && c[1] === 'engine');
  check('Free flight emergency (737 engine): gated by state (ground / height / other running) and aircraft; injected now; runway landing → done 1000 + 12 × points, failure cleared; landing entry scores it too',
    /havalan/.test(ground) && /En az 400 ft/.test(low) && water && noEng && st.ok && /Önce süren/.test(other) && injected && [0, 1].includes(injected[2])
    && done && done.data.ok && done.data.score === 1000 + 12 * card.points && done.data.stars === card.stars && cleared
    && landDone && landDone.data.score === card.points * 20 && calls.some((c) => c[0] === 'random' && c[1] === true) && calls.some((c) => c[0] === 'random' && c[1] === false),
    `ground "${ground}", low "${low}", other "${other}", ${done ? `${done.data.score} pts ${done.data.stars}★` : 'no done'}, landing entry ${landDone ? landDone.data.score : '-'}; calls ${JSON.stringify(calls)}`);
  // off-runway landing / crash → fail; reset → silent abort
  put({ x: 3000, y: 500, z: -4000, onGround: false, agl: 500 });
  tr.start('eng', s);
  const offTd = { ...td, x: land.x + land.dx * 400 - land.dz * 300, z: land.z + land.dz * 400 + land.dx * 300, onRunway: false };
  tr.onLanding(scoreLanding(offTd, { category: 'airliner', ends: ENDS }), offTd);
  const off = last('fail', 'eng');
  tr.start('eng', s);
  tr.onCrash('Kaza: Yere çarptı');
  const crash = last('fail', 'eng');
  tr.start('eng', s);
  const nEv = ev.filter((x) => x.type === 'fail').length;
  tr.onReset();
  check('Free flight emergency: off-runway landing → fail "Pist dışına indin", crash → fail, reset → silent (no fail)',
    off && /Pist dışı/.test(off.data.reason) && crash && /Kaza/.test(crash.data.reason) && ev.filter((x) => x.type === 'fail').length === nEv && tr.byId.eng.status === 'idle' && last('abort', 'eng').data === 'reset',
    `${off && off.data.reason} / ${crash && crash.data.reason}`);
  // progress store (localStorage when present; in Node the calls must not throw)
  let storeOk = true;
  try { recordChallenge('bridge', { ok: true, score: 1500, stars: 2, ac: 'f16' }); loadChallengeProgress(); } catch { storeOk = false; }
  check('Free flight progress: recordChallenge / loadChallengeProgress safe without localStorage', storeOk);
}
// 5e. flown by the models through the tracker: F-22 climb from brake release (clock from the roll), F-22 low pass
//     from the mission start (clock from gate 1), A320 ditching started over the bay (the model's failures)
{
  const mk = (ac, cat, f) => ffTracker(ac, cat, { inject: (k, o) => f.failures.inject(k, o), clearFailure: (k) => f.failures.clear(k), suspendRandom: () => {} });
  // climb
  const f = createFixedWingModel(SPECS.f22, {});
  const e24 = ENDS.find((r) => r.name === 'KNGZ 24');
  f.reset({ x: e24.x + e24.dx * 45, z: e24.z + e24.dz * 45, heading: e24.course }, world);
  const A = mk('f22', 'fighter', f);
  const inp = input({ throttle: 0 });
  const smp = sampler();
  let parked = 0;
  const t = fly(f, inp, 200, (t, dt) => {
    parked += dt;
    inp.throttle = parked > 3 ? 1 : 0;   // 3 s parked, then full afterburner
    const kt = f.ias / KT, el = A.tr.byId.climb.status === 'run' ? smp.s.t - A.tr.byId.climb.t0 : 0;
    stick(f, inp, f.onGround ? (kt > 125 ? 10 : 0) : Math.min(35, 10 + el * 3), 0);
    if (!f.onGround && f.gearHandleDown && f.agl > 20) f.command('gear');
    smp.fill(f, dt); A.tr.update(smp.s); smp.s.first = false;
    return !A.last('done', 'climb');
  });
  const dc = A.last('done', 'climb');
  check('Free flight climb flown (F-22): 3 s parked (no clock), full AB roll → clock → 10,000 ft done, ≥ 2★ (clock from the roll, not the page)',
    dc && dc.data.ok && dc.data.stars >= 2 && dc.data.time > 30 && dc.data.time < t - 2.5,
    dc ? `${dc.data.time.toFixed(1)} s from the roll (${t.toFixed(1)} s flown), ${dc.data.score} pts ${dc.data.stars}★` : `no done, ${Math.round(f.altitude / FT)} ft`);

  // low pass
  const m = buildMission('low-pass');
  const f2 = createFixedWingModel(SPECS.f22, {});
  start(m, f2);
  const B = mk('f22', 'fighter', f2);
  const o = B.tr.byId['low-pass'];
  const smp2 = sampler(); const inp2 = input({ throttle: f2.throttle });
  const t2 = fly(f2, inp2, 150, (t, dt) => {
    const i = Math.min(o.index, o.gates.length - 1), g = o.gates[i];
    const a = i === 0 ? { x: m.start.x, z: m.start.z } : o.gates[i - 1];
    const lx = g.x - a.x, lz = g.z - a.z, L = Math.hypot(lx, lz), ux = lx / L, uz = lz / L;
    const xt = (f2.position.x - a.x) * -uz + (f2.position.z - a.z) * ux;
    const hdgT = bearing(0, 0, ux, uz) + clamp(-xt * 0.25, -40, 40);
    const vsT = clamp((g.y - f2.altitude) * 0.5, -8, 8);
    inp2.pitch = clamp((vsT - f2.verticalSpeed) * 0.05, -0.5, 0.5);
    inp2.roll = clamp((clamp(wrap180(hdgT - f2.heading) * 2, -70, 70) - f2.roll) * 0.02, -0.4, 0.4);
    inp2.throttle = clamp(0.5 + (330 - f2.ias / KT) * 0.02, 0, 0.89);
    smp2.fill(f2, dt); B.tr.update(smp2.s); smp2.s.first = false;
    return !B.last('done', 'low-pass');
  });
  const dl = B.last('done', 'low-pass'), sl = B.last('start', 'low-pass');
  check('Free flight low pass flown (F-22): clock from gate 1 (not from the start), 5 frames → done ≥ 2★',
    sl && dl && dl.data.ok && dl.data.stars >= 2 && dl.data.time < t2 - 10 && !f2.crashed,
    dl ? `${dl.data.time.toFixed(1)} s from gate 1 (${t2.toFixed(0)} s flown), ${dl.data.score} pts ${dl.data.stars}★` : `no done; crashed ${f2.crashed}`);

  // ditching (A320): started over the bay at 2,500 ft, the model's dual engine failure, 4d's glide and flare
  const md = buildMission('ditch');
  const f3 = createFixedWingModel(SPECS.a320neo, {});
  start(md, f3);
  const C = mk('a320neo', 'airliner', f3);
  f3.on('ditch', (i) => C.tr.onDitch({ fpm: Math.max(0, -i.verticalSpeed * FPM), pitch: i.pitch, roll: i.roll, kt: i.ias / KT, gear: 0, survived: true }));
  const smp3 = sampler(); const inp3 = input({ throttle: f3.throttle });
  let started = null;
  fly(f3, inp3, 300, (t, dt) => {
    smp3.fill(f3, dt); C.tr.update(smp3.s); smp3.s.first = false;
    if (!started && t >= 3) started = C.tr.start('ditch', smp3.s, f3);
    const agl = f3.agl, kt = f3.ias / KT;
    const vsT = agl > 60 ? null : -Math.max(1.0, agl * 0.05);
    const pT = vsT === null ? clamp(f3.pitch + (kt - 150) * 0.12, -6, 8) : clamp(f3.pitch + (vsT - f3.verticalSpeed) * 0.6, 2, 11.5);
    stick(f3, inp3, pT, 0);
    inp3.throttle = 0;
    return !f3.ditched && !f3.crashed;
  });
  const dd = C.last('done', 'ditch');
  check('Free flight ditching flown (A320): "Başlat" over the bay injects engineAll (model), glide + flare → ditch objective done, failure cleared after',
    started && started.ok && f3.ditched && dd && dd.data.ok && dd.data.stars >= 1 && !f3.failures.active.size,
    `${started ? started.reason || 'started' : 'not started'}; ${dd ? `${dd.data.score} pts ${dd.data.stars}★` : 'no done'}; ditched ${f3.ditched}, crashed ${f3.crashed} ${f3.crashReason || ''}; active ${[...f3.failures.active.keys()]}`);
}
// =====================================================================================================================
let failed = 0;
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
