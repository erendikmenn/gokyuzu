// UH-60: collective lift-off to a hover, O hover hold, forward flight to ~120 kt, back to a hover, landing.
// usage: node tools/qa/heli.mjs [spawn] [--webkit]
import { launch, openGame, startSampling, getLog, frameStats, tap, hold, shot, save, sleep } from './lib.mjs';

const spawn = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const tag = `uh60-${engine}`;
const { browser, page, log } = await launch({ engine });
const note = (s) => console.log(s);
const st = () => page.evaluate(() => {
  const f = window.__game.flight;
  return { alt: +f.altitude.toFixed(1), agl: +f.agl.toFixed(1), ias: +(f.ias / 0.514444).toFixed(0), gs: +(Math.hypot(f.velocity.x, f.velocity.z) / 0.514444).toFixed(0), vs: +f.verticalSpeed.toFixed(2), pitch: +f.pitch.toFixed(1), roll: +f.roll.toFixed(1), hdg: +f.heading.toFixed(1), ground: f.onGround, ap: `${f.autopilot.on ? 'ON' : 'off'} ${f.autopilot.mode || ''}`, coll: +(f.collective ?? 0).toFixed(3), lever: +window.__game.input.state.throttle.toFixed(3), rpm: +(f.rotorRPM ?? 0).toFixed(3), tq: +(f.torque ?? 0).toFixed(2), crashed: f.crashed, reason: f.crashReason, x: +f.position.x.toFixed(1), z: +f.position.z.toFixed(1), ip: +window.__game.input.state.pitch.toFixed(2) };
});
const held = new Set();
const set = async (code, on) => {
  if (on && !held.has(code)) { await page.keyboard.down(code); held.add(code); }
  if (!on && held.has(code)) { await page.keyboard.up(code); held.delete(code); }
};
const releaseAll = async () => { for (const c of [...held]) await set(c, false); };
/** player loop: collective keeps a vertical-speed target, cyclic keeps a pitch target, roll wings level */
async function loop({ vs = 0, pitch = null, until, maxMs = 60000, label }) {
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < maxMs) {
    s = await st();
    if (s.crashed || (until && until(s))) break;
    const vsT = typeof vs === 'function' ? vs(s) : vs;
    await set('KeyX', s.vs < vsT - 0.4); await set('KeyZ', s.vs > vsT + 0.4);
    if (pitch != null) { const pT = typeof pitch === 'function' ? pitch(s) : pitch; await set('KeyS', s.pitch < pT - 1.5); await set('KeyW', s.pitch > pT + 1.5); }
    await set('KeyD', s.roll < -3); await set('KeyA', s.roll > 3);
    await sleep(80);
  }
  await releaseAll();
  note(`${label}: ${JSON.stringify(s)}`);
  return s;
}
try {
  note(`load ${(await openGame(page, 'uh60', spawn)).toFixed(1)} s`);
  await page.evaluate(() => { const f = window.__game.flight; for (const ev of ['crash', 'touchdown', 'takeoff', 'warning', 'autopilot']) f.on(ev, (i) => (window.__qa.ev ||= []).push({ t: +((performance.now() - window.__qa.t0) / 1000).toFixed(2), ev, i: JSON.stringify(i ?? null) })); });
  await startSampling(page);
  await sleep(1500);
  note(`spawn ${JSON.stringify(await st())}`);
  await shot(page, `${tag}-0-spawn`);
  // lift-off: raise collective until airborne, then climb to ~10 m AGL
  let s = await loop({ vs: 1.5, until: (s) => s.agl > 10, maxMs: 40000, label: 'lift-off to 10 m' });
  s = await loop({ vs: 0, until: () => false, maxMs: 5000, label: 'hover (manual) 5 s' });
  await shot(page, `${tag}-1-hover`);
  await tap(page, 'KeyO');
  const h0 = await st();
  await sleep(10000);
  const h1 = await st();
  note(`hover hold 10 s: drift ${Math.hypot(h1.x - h0.x, h1.z - h0.z).toFixed(1)} m, dAlt ${(h1.alt - h0.alt).toFixed(1)} m, ${JSON.stringify(h1)}`);
  await shot(page, `${tag}-2-hoverhold`);
  if (process.argv.includes('--short')) {
    // land from the hover hold: the collective is the altitude beeper while O is on
    const t0 = Date.now(); let s2 = await st();
    while (!s2.ground && !s2.crashed && Date.now() - t0 < 60000) { await hold(page, 'KeyZ', 400); await sleep(300); s2 = await st(); }
    note(`hover-hold descent: ${JSON.stringify(s2)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await sleep(1500);
    await shot(page, `${tag}-short-landed`);
    s2 = await st(); if (s2.ap.startsWith('ON')) await tap(page, 'KeyO');
    await hold(page, 'KeyZ', 3000); await sleep(1500);
    note(`landed (short): ${JSON.stringify(await st())}`);
    note('events ' + JSON.stringify(await page.evaluate(() => (window.__qa.ev || []).filter((e) => e.ev !== 'warning'))));
    await browser.close(); process.exit(0);
  }
  await tap(page, 'KeyO');   // off
  await sleep(500);
  // climb to 120 m and accelerate: nose down ~10°
  s = await loop({ vs: (s) => Math.max(-4, Math.min(5, (120 - s.agl) * 0.1)), pitch: (s) => (s.ias < 118 ? -10 : -4), until: (s) => s.ias >= 120, maxMs: 90000, label: 'accelerate to 120 kt' });
  await shot(page, `${tag}-3-120kt`);
  s = await loop({ vs: (s) => Math.max(-4, Math.min(5, (120 - s.agl) * 0.1)), pitch: -4, until: () => false, maxMs: 8000, label: 'cruise 8 s' });
  // T: cockpit
  await tap(page, 'KeyT'); await sleep(1500); await shot(page, `${tag}-4-cockpit`); await tap(page, 'KeyT');
  // decelerate
  s = await loop({ vs: (s) => Math.max(-3, Math.min(3, (60 - s.agl) * 0.1)), pitch: (s) => (s.gs > 25 ? 12 : s.gs > 8 ? 6 : 2), until: (s) => s.gs < 6, maxMs: 90000, label: 'decelerate to hover' });
  await tap(page, 'KeyO');
  await sleep(6000);
  note(`hover hold after decel: ${JSON.stringify(await st())}`);
  await shot(page, `${tag}-5-hover2`);
  await tap(page, 'KeyO');
  // descend and land
  s = await loop({ vs: (s) => (s.agl > 15 ? -2.5 : s.agl > 3 ? -1.0 : -0.5), pitch: 2, until: (s) => s.ground, maxMs: 120000, label: 'touchdown' });
  s = await loop({ vs: -3, until: (s) => s.lever < 0.05, maxMs: 6000, label: 'collective down' });
  await sleep(2000);
  note(`landed: ${JSON.stringify(await st())}`);
  await shot(page, `${tag}-6-landed`);
  const ev = await page.evaluate(() => window.__qa.ev || []);
  note('events ' + JSON.stringify(ev));
  const lg = await getLog(page);
  save(tag, { lg, ev, errors: log.errors });
  lg.filter((_, i) => i % 12 === 0).forEach((r) => console.log(r.t, 'agl', r.agl, 'ias', r.ias, 'vs', r.vs, 'p', r.pitch, 'r', r.roll, 'hdg', r.hdg, 'ap', r.ap, 'coll', r.coll, 'lev', r.lever, 'rpm', r.rpm, 'tq', r.tq, 'gnd', r.ground, r.reason));
  note(`frames ${JSON.stringify(await frameStats(page))} hitches ${JSON.stringify(await page.evaluate(() => window.__qa.hitches))}`);
} catch (e) { console.error('TEST ERROR', e); await shot(page, `${tag}-error`); }
console.log('errors', JSON.stringify(log.errors.slice(0, 20)));
await browser.close();
