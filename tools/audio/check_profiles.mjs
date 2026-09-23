#!/usr/bin/env node
// Static check of the sound profiles: every referenced file exists, every layer function returns finite values
// over a sweep of flight states. Usage: node tools/audio/check_profiles.mjs
import fs from 'node:fs';
const ids = ['f16', 'f22', 'a320neo', 'b737', 'uh60'];
let bad = 0;
const exists = (rel) => fs.existsSync(new URL(`../../assets/audio/${rel}.wav`, import.meta.url));
for (const id of ids) {
  const p = (await import(`../../src/audio/profiles/${id}.js`)).default;
  const files = new Set();
  for (const l of p.layers) files.add(l.file);
  for (const f of Object.values(p.shots || {})) files.add(f);
  for (const r of p.alerts?.rules || []) { if (r.voice) files.add(r.voice); if (r.loop) files.add(r.loop); }
  for (const c of p.alerts?.callouts || []) files.add(c.voice);
  for (const k of ['chime', 'apDisconnect', 'apDisconnectLoop', 'apButton', 'altAlert', 'retard']) if (p.alerts?.[k]) files.add(p.alerts[k]);
  // real-system alert logic: declared files + a sweep through flight states with a mock io (no exceptions, every
  // requested sound exists and was declared)
  for (const mk of p.alerts?.systems || []) {
    const sys = mk();
    const decl = new Set([...sys.files, ...Object.values(sys.loops).map((l) => l.file)]);
    decl.forEach((f) => files.add(f));
    const heard = new Set();
    let now = 0, voice = null;
    const io = { now: 0, say: (tag, rel) => { heard.add(rel); voice = { tag, end: now + 1 }; }, speaking: (t) => !!voice && (t == null || voice.tag === t),
      speakingSystem: () => !!voice, endedAt: () => -99, stop: (t) => { if (voice && voice.tag === t) voice = null; },
      loop: (id, on) => { if (on) { if (!sys.loops[id]) throw new Error(`undeclared loop ${id}`); heard.add(sys.loops[id].file); } }, tone: (rel) => heard.add(rel) };
    let threw = false;
    for (const onGround of [0, 1]) for (const ft of [3000, 2400, 1200, 900, 600, 350, 250, 150, 60, 35, 15, 4]) for (const kt of [60, 140, 230, 400])
      for (const fpm of [-6000, -1500, -700, 0, 800]) for (const gear of [0, 1]) for (const flapsIndex of [0, 2, 4, 7]) for (const thr of [0, 0.5, 1]) {
        now += 0.05; io.now = now; if (voice && now > voice.end) voice = null;
        if (threw) break;
        const e = { n1: thr > 0.4 ? 0.9 : 0.5 };
        const st = { t: now, dt: 0.05, ft, kt, fpm, agl: ft / 3.28, ias: kt * 0.514, vs: fpm / 196.85, gs: kt * 0.514, altFt: ft + 500, alt: (ft + 500) / 3.28,
          roll: fpm > 0 ? 50 : 10, pitch: fpm > 0 ? 60 : 2, aoa: thr ? 5 : 18, gear, gearHandle: !!gear, flapsIndex, landIdx: 5, gpwsLandIdx: 4, thr, rev: 0,
          onGround, apOn: thr === 0.5, apMode: thr === 0.5 ? 'HDG ALT' : '', apAlt: 900, fcuValid: true, athr: thr === 0.5, fuelKg: kt < 100 ? 200 : 5000,
          fuelFrac: kt < 100 ? 0.05 : 0.8, vlsKt: 130, vmoKt: 340, mmo: 0.82, mach: kt / 600, n1min: e.n1, n1max: e.n1, eng: [e, e], canopy: 0, speedbrake: 0,
          parkBrake: false, rotor: thr ? 0.99 : 0.9, gsDots: ft < 1000 ? -2.5 : null, locDots: 0.5,
          wHas: { fire: true }, w: { stall: thr === 0 && kt < 100, overspeed: kt > 350, gear: false, bank: false, sinkRate: fpm < -2000, pullUp: fpm < -5000,
            fire: kt === 60 && ft === 600 } };
        try { sys.update(st, io, {}); } catch (e2) { bad++; threw = true; console.log(id, sys.name, 'update threw', e2.message); }
      }
    const undeclared = [...heard].filter((f) => !decl.has(f));
    if (undeclared.length) { bad++; console.log(id, sys.name, 'plays undeclared files', undeclared); }
    console.log(`${id}/${sys.name}: ${decl.size} files declared, ${heard.size} exercised`);
  }
  const missing = [...files].filter((f) => !exists(f));
  if (missing.length) { bad++; console.log(id, 'MISSING', missing); }
  let evals = 0;
  for (const n1 of [0, 0.1, 0.25, 0.5, 0.8, 1, 1.1]) for (const tas of [0, 50, 150, 400]) for (const ab of [0, 1]) for (const cockpit of [false, true]) {
    const e = { i: 0, n1, n1s: n1, pow: Math.max(0, n1 - 0.2) / 0.8, ab, rev: ab, on: n1 > 0 ? 1 : 0 };
    const s = { cockpit, t: 0, dt: 0.016, eng: [e, e], n1, n1s: n1, pow: e.pow, ab, rev: ab, thr: n1, tas, ias: tas, mach: tas / 340, qn: (tas / 150) ** 2,
      gs: tas, vs: -3, agl: 100, g: 1 + ab * 8, onGround: tas < 60 ? 1 : 0, gear: 1, flaps: 0.5, flapsIndex: 1, flapsCount: 5, spoilers: ab, speedbrake: ab,
      brakes: ab, canopy: ab, gearMoving: ab, flapMoving: ab, canopyMoving: ab, rotor: n1, collective: n1, torque: n1, stalled: !!ab, dead: false,
      w: { stall: !!ab, overspeed: !!ab, gear: !!ab, bank: !!ab, sinkRate: !!ab, pullUp: !!ab }, fuelFrac: 1, rotorLow: !!ab, pitch: 0 };
    for (const l of p.layers) for (const fn of ['gain', 'rate', 'lp', 'ext', 'int']) {
      const f = l[fn];
      if (f === undefined) continue;
      const v = typeof f === 'function' ? f(s, e) : f;
      evals++;
      if (!Number.isFinite(v) || v < 0) { bad++; console.log(id, l.id, fn, 'bad value', v, { n1, tas, ab }); }
    }
    for (const r of p.alerts?.rules || []) { const v = r.when(s); if (typeof v !== 'boolean') { bad++; console.log(id, r.id, 'when() not boolean'); } }
  }
  console.log(`${id}: ${p.layers.length} layers, ${files.size} files, ${evals} evaluations ok`);
}
console.log(bad ? `${bad} problems` : 'all profiles OK');
process.exit(bad ? 1 : 0);
