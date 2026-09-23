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
  for (const k of ['chime', 'apDisconnect', 'altAlert', 'retard']) if (p.alerts?.[k]) files.add(p.alerts[k]);
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
