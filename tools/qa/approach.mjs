// Airliner autoland from AIR-SFO-FINAL: O (as the README says), then gear + landing flaps, let the autopilot land on
// 28L, reversers (N) at touchdown, observe spoilers / autobrake / stop position.
// usage: node tools/qa/approach.mjs <a320neo|b737> [--webkit] [--o-only]
import { launch, openGame, startSampling, getLog, frameStats, tap, shot, save, sleep } from './lib.mjs';

const id = process.argv[2] || 'a320neo';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const tag = `${id}-app-${engine}`;
const { browser, page, log } = await launch({ engine });
const note = (s) => console.log(s);
const st = () => page.evaluate(() => {
  const f = window.__game.flight, w = window.__game.world;
  return { alt: +f.altitude.toFixed(1), agl: +f.agl.toFixed(1), ias: +(f.ias / 0.514444).toFixed(0), vs: +f.verticalSpeed.toFixed(1), pitch: +f.pitch.toFixed(1), roll: +f.roll.toFixed(1), hdg: +f.heading.toFixed(1), ground: f.onGround, ap: `${f.autopilot.on ? 'ON' : 'off'} ${f.autopilot.mode}`, gear: +f.gear.toFixed(2), flaps: f.flapsLabel, spoil: +f.spoilers.toFixed(2), rev: +f.reverser.toFixed(2), brk: +f.brakes.toFixed(2), abrk: f.autobrake, gs: +(f.groundSpeed ?? 0).toFixed(1), crashed: f.crashed, reason: f.crashReason, onRwy: w.isOnRunway(f.position.x, f.position.z), x: +f.position.x.toFixed(0), z: +f.position.z.toFixed(0), lever: +window.__game.input.state.throttle.toFixed(2), n1: +f.engines[0].n1.toFixed(2) };
});
try {
  const loadS = await openGame(page, id, 'AIR-SFO-FINAL');
  note(`load ${loadS.toFixed(1)} s`);
  await page.evaluate(() => { const f = window.__game.flight; for (const ev of ['crash', 'touchdown', 'takeoff', 'gear', 'flaps', 'warning', 'autopilot', 'reverser']) f.on(ev, (i) => (window.__qa.ev ||= []).push({ t: +((performance.now() - window.__qa.t0) / 1000).toFixed(2), ev, i: JSON.stringify(i ?? null) })); });
  await startSampling(page);
  note(`spawn ${JSON.stringify(await st())}`);
  await shot(page, `${tag}-0-spawn`);
  await tap(page, 'KeyO');
  await sleep(6000);
  note(`O only, 6 s later: ${JSON.stringify(await st())}`);
  if (!process.argv.includes('--o-only')) {
    await tap(page, 'KeyG');
    const nFlaps = await page.evaluate(() => window.__game.def.spec.landingFlapIndex ?? window.__game.def.spec.flapDetents.length - 1);
    for (let i = 0; i < nFlaps; i++) { await tap(page, 'KeyF'); await sleep(1200); }
    note(`gear+flaps ${nFlaps}: ${JSON.stringify(await st())}`);
  }
  let s, shotAt = { 150: false, 30: false };
  const t0 = Date.now();
  let touchdown = false, revDone = false;
  while (Date.now() - t0 < 240000) {
    s = await st();
    if (s.crashed) { note(`CRASH ${JSON.stringify(s)}`); await shot(page, `${tag}-crash`); break; }
    if (!shotAt[150] && s.agl < 150) { shotAt[150] = true; note(`150 m: ${JSON.stringify(s)}`); await shot(page, `${tag}-1-150m`); }
    if (!shotAt[30] && s.agl < 30) { shotAt[30] = true; note(`30 m: ${JSON.stringify(s)}`); await shot(page, `${tag}-2-30m`); }
    if (s.ground && !touchdown) { touchdown = true; note(`touchdown: ${JSON.stringify(s)}`); await sleep(700); await shot(page, `${tag}-3-touchdown`); }
    if (touchdown && !revDone && s.lever < 0.05) { revDone = true; await tap(page, 'KeyN'); await sleep(100); await page.keyboard.down('KeyX'); await sleep(1500); await page.keyboard.up('KeyX'); note(`reverser: ${JSON.stringify(await st())}`); await shot(page, `${tag}-4-reverse`); }
    if (touchdown && s.gs < 15 && revDone) { await page.keyboard.down('KeyZ'); await sleep(1500); await page.keyboard.up('KeyZ'); await tap(page, 'KeyN'); }
    if (touchdown && s.gs < 1) break;
    await sleep(250);
  }
  await sleep(1500);
  note(`final: ${JSON.stringify(await st())}`);
  await shot(page, `${tag}-5-stopped`);
  const ev = await page.evaluate(() => window.__qa.ev || []);
  note('events ' + JSON.stringify(ev));
  const lg = await getLog(page);
  save(tag, { lg, ev, errors: log.errors });
  lg.filter((_, i) => i % 8 === 0).forEach((r) => console.log(r.t, 'agl', r.agl, 'ias', r.ias, 'vs', r.vs, 'p', r.pitch, 'r', r.roll, 'hdg', r.hdg, 'ap', r.ap, 'gear', r.gear, 'fl', r.flapL, 'spoil', r.spoil, 'rev', r.rev, 'brk', r.brk, r.abrk, 'lev', r.lever, 'n1', r.n1, 'gnd', r.ground));
  note(`frames ${JSON.stringify(await frameStats(page))} hitches ${JSON.stringify(await page.evaluate(() => window.__qa.hitches))}`);
} catch (e) { console.error('TEST ERROR', e); await shot(page, `${tag}-error`); }
console.log('errors', JSON.stringify(log.errors.slice(0, 20)));
await browser.close();
