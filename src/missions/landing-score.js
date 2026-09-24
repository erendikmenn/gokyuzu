// Landing score (CONTRACTS-SF.md §12): one touchdown → sink rate, centreline offset, touchdown distance from the
// threshold, bank / crab, bounces, runway yes/no → 0–100 points, 0–3 stars and a Turkish rating. Pure functions (no DOM,
// no three.js): the landing card (src/ui/landing.js), the missions (src/missions/runtime.js) and tests/missions.test.mjs
// share them.
//
//   const td = sampleTouchdown(flight, info, out)                 // numbers at the moment of contact
//   const card = scoreLanding(td, { category, ends, bounces })   // ends = runwayEnds(world.runways)
//
// Thresholds follow airline / military practice: airliners 100–250 ft/min is a normal landing, > 360 ft/min is firm and
// above ~600 ft/min a hard-landing report; the touchdown zone is the first 3,000 ft (914 m) with the aiming point at
// 1,000–1,300 ft (300–400 m); fighters land firmer and a little shorter; helicopters want almost no sink and no drift.
import { band, clamp, wrap180, FPM, KT, DEG } from './util.js';

export const LANDING_BANDS = {
  //            butter  good  firm  hard (ft/min)   bad: 0 points
  airliner:   { butter: 120, good: 180, hard: 480, bad: 600, tdzIdeal: [250, 550], tdzOk: [150, 914] },
  fighter:    { butter: 180, good: 300, hard: 650, bad: 850, tdzIdeal: [150, 550], tdzOk: [60, 914] },
  helicopter: { butter: 60, good: 120, hard: 300, bad: 420, drift: [2, 15] },
  // power-off (autorotation) touchdown: a run-on landing with some sink is the normal outcome (UH-60 gear: ≈ 10 ft/s)
  autorotation: { butter: 250, good: 350, hard: 700, bad: 950, drift: [15, 60] },
};

/** Rating label (Turkish) and a short code for telemetry. */
export const LABELS = {
  butter: 'Tereyağı gibi', great: 'Mükemmel', good: 'Güzel', ok: 'İdare eder', bounce: 'Zıplamalı', hard: 'Sert',
  veryHard: 'Çok sert', off: 'Pist dışı', bad: 'Kötü',
};

/**
 * Touchdown sample from the flight model at the 'touchdown' event (info = the event payload). `out` is reused.
 * heading / track in degrees true; vs in m/s (negative = sinking).
 */
export function sampleTouchdown(flight, info = {}, out = {}) {
  const p = flight.position, v = flight.velocity;
  out.x = p.x; out.y = p.y; out.z = p.z;
  out.heading = Number(flight.heading) || 0;
  out.gs = v ? Math.hypot(v.x, v.z) : 0;
  out.track = v && out.gs > 1 ? ((Math.atan2(v.x, -v.z) / DEG) + 360) % 360 : out.heading;
  out.vs = Number.isFinite(info.verticalSpeed) ? info.verticalSpeed : Number(flight.verticalSpeed) || 0;
  out.roll = Number.isFinite(info.roll) ? info.roll : Number(flight.roll) || 0;
  out.pitch = Number.isFinite(info.pitch) ? info.pitch : Number(flight.pitch) || 0;
  out.ias = Number.isFinite(flight.ias) ? flight.ias : Number(flight.airspeed) || 0;
  out.onRunway = !!info.onRunway;
  if (Number.isFinite(info.groundSpeed)) out.gs = info.groundSpeed;
  return out;
}

/**
 * The runway end the touchdown belongs to: on the pavement in the landing direction, or (off the runway) the nearest end
 * whose extended rectangle the aircraft is near. → { end, along (m past the threshold), lateral (m, + right), on } | null
 */
export function findLandingRunway(td, ends, out = {}) {
  let best = null, bestScore = Infinity;
  for (const e of ends || []) {
    const hd = Math.abs(wrap180(td.heading - e.course / DEG));
    if (hd > 70) continue;                                    // landing the other way: the opposite end matches
    const vx = td.x - e.x, vz = td.z - e.z;
    const along = vx * e.dx + vz * e.dz;
    const lateral = vx * -e.dz + vz * e.dx;
    const half = (e.width || 45) / 2;
    const disp = e.displaced || 0;                             // (along is from the landing threshold; the pavement starts disp m before it)
    const on = along >= -disp && along <= e.length - disp && Math.abs(lateral) <= half + 1;
    if (!on && (along < -900 || along > e.length + 400 || Math.abs(lateral) > 300)) continue;
    const score = (on ? 0 : 1e6) + Math.abs(lateral) + hd * 2;
    if (score < bestScore) { bestScore = score; best = e; out.along = along; out.lateral = lateral; out.on = on; }
  }
  if (!best) return null;
  out.end = best;
  return out;
}

/**
 * Score a touchdown. opts: { category: 'airliner'|'fighter'|'helicopter', ends: runwayEnds(runways), bounces: 0..,
 * profile: 'autorotation' (helicopter power-off landing bands) }.
 * → { cat, fpm, cl, side, tdz, runway ('KSFO 28R' | null), onRunway, bank, crab, drift (kt), bounces, points (0..100),
 *     stars (0..3), label, code, parts: { sink, cl, tdz, att, bounce } each 0..1, ok: { sink, cl, tdz, att, bounce } 'good'|'ok'|'bad' }
 */
export function scoreLanding(td, { category = 'airliner', ends = [], bounces = 0, profile = null } = {}) {
  const cat = category === 'fighter' || category === 'helicopter' ? category : 'airliner';
  const B = LANDING_BANDS[cat === 'helicopter' && profile === 'autorotation' ? 'autorotation' : cat];
  const fpm = Math.max(0, -td.vs * FPM);
  const bank = Math.abs(td.roll || 0);
  const heli = cat === 'helicopter';
  const r = { cat, fpm: Math.round(fpm), bank: +bank.toFixed(1), bounces, drift: +((td.gs || 0) / KT).toFixed(1), runway: null, onRunway: !!td.onRunway, cl: null, side: '', tdz: null, crab: 0, parts: {}, ok: {} };
  const rate = (v) => (v >= 0.8 ? 'good' : v >= 0.4 ? 'ok' : 'bad');
  const sink = band(fpm, B.good, B.bad);
  r.parts.sink = sink;
  r.ok.sink = fpm <= B.good ? 'good' : fpm <= B.hard ? 'ok' : 'bad';
  const bounce = bounces === 0 ? 1 : bounces === 1 ? 0.3 : 0;
  r.parts.bounce = bounce; r.ok.bounce = bounces === 0 ? 'good' : bounces === 1 ? 'ok' : 'bad';
  let points;
  if (heli) {
    const drift = band(r.drift, B.drift[0], B.drift[1]), att = band(bank, 2, 10);
    r.parts.drift = drift; r.parts.att = att; r.ok.drift = rate(drift); r.ok.att = rate(att);
    const rw = findLandingRunway(td, ends);
    if (rw && rw.on) { r.runway = rw.end.name; r.onRunway = true; }
    points = 50 * sink + 30 * drift + 20 * att;
    points = points * (bounces === 0 ? 1 : bounces === 1 ? 0.85 : 0.7);
  } else {
    const rw = findLandingRunway(td, ends);
    let cl = 0, tdz = 0, att;
    if (rw) {
      r.runway = rw.end.name;
      r.onRunway = rw.on;
      r.cl = +Math.abs(rw.lateral).toFixed(1);
      r.side = Math.abs(rw.lateral) < 0.5 ? '' : rw.lateral > 0 ? 'sağ' : 'sol';
      r.tdz = Math.round(rw.along);
      r.crab = +Math.abs(wrap180(td.heading - rw.end.course / DEG)).toFixed(1);
      const half = (rw.end.width || 45) / 2;
      cl = band(Math.abs(rw.lateral), 2, half);
      const [i0, i1] = B.tdzIdeal, [o0, o1] = B.tdzOk;
      tdz = rw.along < i0 ? clamp((rw.along - o0 * 0.4) / (i0 - o0 * 0.4), 0, 1) : rw.along <= i1 ? 1 : clamp(1 - (rw.along - i1) / (o1 + 300 - i1), 0, 1);
      r.ok.tdz = rw.along >= i0 && rw.along <= i1 ? 'good' : rw.along >= o0 && rw.along <= o1 ? 'ok' : 'bad';
    } else {
      r.crab = +Math.abs(wrap180(td.heading - td.track)).toFixed(1);
      r.ok.tdz = 'bad';
    }
    att = 0.6 * band(bank, 2, 8) + 0.4 * band(r.crab, 2, 10);
    r.parts.cl = cl; r.parts.tdz = tdz; r.parts.att = att;
    r.ok.cl = rate(cl); r.ok.att = rate(att);
    points = 40 * sink + 20 * cl + 20 * tdz + 10 * att + 10 * bounce;
    if (!r.onRunway) points = Math.min(points, 20);
  }
  r.points = Math.round(clamp(points, 0, 100));
  let stars = r.points >= 90 ? 3 : r.points >= 70 ? 2 : r.points >= 40 ? 1 : 0;
  if (fpm > B.good * 1.25) stars = Math.min(stars, 2);   // three stars need a soft touchdown
  if (fpm > B.hard) stars = Math.min(stars, 1);
  if (fpm > B.bad) stars = 0;
  if (bounces >= 1) stars = Math.min(stars, bounces === 1 ? 2 : 1);
  if (!heli && !r.onRunway) stars = 0;
  r.stars = stars;
  let code;
  if (!heli && !r.onRunway) code = 'off';
  else if (stars === 3) code = fpm <= B.butter ? 'butter' : 'great';
  else if (stars === 2) code = 'good';
  else if (stars === 1) code = fpm > B.hard ? 'hard' : bounces ? 'bounce' : 'ok';
  else code = fpm > B.hard ? 'veryHard' : 'bad';
  r.code = code;
  r.label = LABELS[code];
  return r;
}

/** Telemetry fields for the `land` event (§12): fpm, cl (m), tdz (m past the threshold), st (stars). */
export function landingFields(card) {
  if (!card) return {};
  return { fpm: card.fpm, cl: card.cl == null ? undefined : Math.round(card.cl * 10) / 10, tdz: card.tdz == null ? undefined : card.tdz, st: card.stars };
}

/**
 * Airliner ditching (controlled water landing), scored like the A320 ditching guidance (FCOM / US Airways 1549: 125 KIAS,
 * ~9.5° nose up, wings level, sink ≈ 200–300 ft/min, gear up). The survivable envelope matches the flight model's
 * (src/flight/fixedwing.js _tryDitch): sink < 905 ft/min, pitch 2–16°, bank ≤ 10°, < 190 kt, gear up.
 * d = { fpm, pitch (deg), roll (deg), kt, gear (0..1) } → { points (0..100), survivable, stars (0..3), label, parts }
 */
export function scoreDitch(d) {
  const sink = band(d.fpm, 250, 900);
  const pitch = d.pitch >= 7 && d.pitch <= 12 ? 1 : d.pitch < 7 ? clamp((d.pitch - 2) / 5, 0, 1) : clamp((16 - d.pitch) / 4, 0, 1);
  const bank = band(Math.abs(d.roll), 2, 10);
  const speed = band(d.kt, 135, 185);
  const gear = d.gear < 0.1 ? 1 : 0;
  const points = Math.round(35 * sink + 20 * pitch + 20 * bank + 15 * speed + 10 * gear);
  const survivable = d.fpm < 905 && Math.abs(d.roll) <= 10 && d.pitch > 2 && d.pitch < 16 && d.kt < 190 && d.gear < 0.1;
  const stars = !survivable ? 0 : points >= 85 ? 3 : points >= 65 ? 2 : 1;
  const label = !survivable ? 'Gövde parçalandı' : stars === 3 ? 'Hudson gibi!' : stars === 2 ? 'Kontrollü suya iniş' : 'Sert ama sağ salim';
  return { points, survivable, stars, label, parts: { sink, pitch, bank, speed, gear } };
}
