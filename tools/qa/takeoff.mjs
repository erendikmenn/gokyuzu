// Ground → takeoff → climb → 90° turn → level off, flown with the keyboard in real time.
// usage: node tools/qa/takeoff.mjs <f16|f22|a320neo|b737> [spawn] [--webkit]
import { launch, openGame, startSampling, getLog, frameStats, renderInfo, tap, hold, shot, fly, summarize, save, sleep } from './lib.mjs';

const id = process.argv[2] || 'f16';
const spawn = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const tag = `${id}-to-${engine}`;
const { browser, page, log } = await launch({ engine });
const events = [];
const note = (s) => { events.push(s); console.log(s); };
try {
  const loadS = await openGame(page, id, spawn);
  note(`load ${loadS.toFixed(1)} s (app ready ${log.ready} s)`);
  await page.evaluate(() => { const f = window.__game.flight; for (const ev of ['crash', 'touchdown', 'takeoff', 'gear', 'flaps', 'warning', 'afterburner', 'stall']) f.on(ev, (i) => (window.__qa.ev ||= []).push({ t: +((performance.now() - window.__qa.t0) / 1000).toFixed(2), ev, i: JSON.stringify(i ?? null) })); });
  await startSampling(page);
  await sleep(1500);
  const s0 = await page.evaluate(() => { const f = window.__game.flight; return { vr: f.vSpeeds.vr / 0.514444, v2: f.vSpeeds.v2 / 0.514444, y: f.position.y, alt: f.altitude, agl: f.agl, gear: f.gear, spawn: window.__game.spawn.id, flaps: f.flapsLabel, cam: window.__game.cameraRig.mode, rigY: window.__game.rig.object.position.y, ground: window.__game.world.getGroundHeight(f.position.x, f.position.z) }; });
  note(`start ${JSON.stringify(s0)}`);
  await shot(page, `${tag}-0-spawn`);
  const fighter = id === 'f16' || id === 'f22';
  if (!fighter) { await tap(page, 'KeyF'); await sleep(300); }            // takeoff flap
  // throttle: hold X to the stop (fighters stop at MIL), then a fresh press for afterburner
  await hold(page, 'KeyX', 2600);
  if (fighter) { await hold(page, 'KeyX', 700); }
  await sleep(500);
  const thr = await page.evaluate(() => ({ lever: window.__game.input.state.throttle, ab: window.__game.flight.engines[0].afterburner }));
  note(`throttle after keys ${JSON.stringify(thr)}`);
  const vr = s0.vr || 140;
  let s = await fly(page, { roll: 0, heading: null, until: (s) => s.ias >= vr, maxMs: 60000 });
  note(`reached VR ${vr.toFixed(0)} kt: ${JSON.stringify(s)}`);
  await shot(page, `${tag}-1-rotate`);
  // rotate to ~12° and hold until airborne and climbing
  s = await fly(page, { pitch: fighter ? 12 : 10, until: (s) => !s.ground && s.agl > 15, maxMs: 25000 });
  note(`airborne: ${JSON.stringify(s)}`);
  await tap(page, 'KeyG');
  await sleep(200);
  s = await fly(page, { pitch: fighter ? 15 : 12, until: (s) => s.agl > 150, maxMs: 30000 });
  note(`150 m AGL: ${JSON.stringify(s)}`);
  await shot(page, `${tag}-2-gearup`);
  if (!fighter) { await tap(page, 'KeyV'); }
  // climb to 1000 m
  s = await fly(page, { pitch: fighter ? 18 : 10, until: (s) => s.alt > 850, maxMs: 90000 });
  note(`850 m: ${JSON.stringify(s)}`);
  if (fighter) { await hold(page, 'KeyZ', 150); await sleep(200); await tap(page, 'Digit6'); } // out of AB, then ~60 % lever
  else { await tap(page, 'Digit7'); }
  s = await fly(page, { alt: 1000, roll: 0, until: (s) => Math.abs(s.alt - 1000) < 30 && Math.abs(s.vs) < 3, maxMs: 30000 });
  note(`level 1000: ${JSON.stringify(s)}`);
  await shot(page, `${tag}-3-level`);
  // 90° right turn at 1000 m
  const hdg0 = s.hdg;
  const target = (hdg0 + 90) % 360;
  s = await fly(page, { alt: 1000, heading: target, maxBank: fighter ? 45 : 25, until: (st) => Math.abs(((target - st.hdg + 540) % 360) - 180) < 3, maxMs: 90000 });
  note(`turn to ${target.toFixed(0)}: ${JSON.stringify(s)}`);
  await shot(page, `${tag}-4-turn`);
  s = await fly(page, { alt: 1000, roll: 0, maxMs: 8000 });
  note(`level after turn: ${JSON.stringify(s)}`);
  await shot(page, `${tag}-5-final`);
  // cameras: cycle all modes with C, then T to the cockpit and back
  for (let i = 0; i < 6; i++) {
    await tap(page, 'KeyC');
    await sleep(1800);
    const m = await page.evaluate(() => ({ mode: window.__game.cameraRig.mode, view: window.__game.cameraRig.view, cam: window.__game.camera.position.toArray().map((v) => +v.toFixed(1)), ac: window.__game.flight.position.toArray().map((v) => +v.toFixed(1)) }));
    note(`camera ${JSON.stringify(m)}`);
    await shot(page, `${tag}-cam-${i}-${m.mode}`);
  }
  await tap(page, 'KeyT'); await sleep(1200);
  note(`T -> ${await page.evaluate(() => window.__game.cameraRig.mode)}`);
  await shot(page, `${tag}-cam-T1`);
  await tap(page, 'KeyT'); await sleep(1200);
  note(`T -> ${await page.evaluate(() => window.__game.cameraRig.mode)}`);
  const fs = await frameStats(page);
  const ri = await renderInfo(page);
  note(`frames ${JSON.stringify(fs)} render ${JSON.stringify(ri)}`);
  const lg = await getLog(page);
  const ev = await page.evaluate(() => window.__qa.ev || []);
  save(tag, { events, lg, ev, errors: log.errors, warnings: log.warnings });
  console.log(summarize(lg, undefined, 8));
  console.log('events', JSON.stringify(ev));
} catch (e) { console.error('TEST ERROR', e); await shot(page, `${tag}-error`); }
console.log('errors', JSON.stringify(log.errors.slice(0, 20)));
console.log('warnings', JSON.stringify([...new Set(log.warnings)].slice(0, 20)));
await browser.close();
