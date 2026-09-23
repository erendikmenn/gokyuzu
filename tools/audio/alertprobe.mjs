#!/usr/bin/env node
// In-game check of the aural alerts: loads the real game headless (Chromium, real GPU), puts the aircraft into
// scripted situations with flight.reset() / commands / lever moves, and reads the audio system's alert trace
// (window.__audioSys.trace: voice / tone / loop+ / loop- / apd entries) to verify that each warning fires in the
// right situation and stops when it should.
// Usage: node tools/audio/alertprobe.mjs --ac a320neo [--only name,name] [--out results.json] [--record]
//   --record merges the pass/fail summary into tools/audio/research/alertprobe.json (shown on dev/sesler.html)
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ac = opt('ac', 'a320neo');
const only = opt('only') ? opt('only').split(',') : null;
const out = opt('out');
const FT = 0.3048, KTS = 0.514444;

// final approach to SFO 28L at distance d (m) from the threshold on the 3° path (same geometry as the AIR-SFO-FINAL spawn)
const final = (d) => {
  const h = 117.4 * Math.PI / 180;
  return { x: 1464 + Math.sin(h) * d, z: 796 - Math.cos(h) * d, heading: 297.4 * Math.PI / 180, alt: 4 + (d + 300) * Math.tan(3 * Math.PI / 180) };
};
const BAY = { x: 4000, z: -4000, heading: 120 * Math.PI / 180 };          // open water between SFO and Oakland

// scenario: { name, setup: { ...reset }, steps: [[t, action]], dur, expect: [check] }
//   action: 'ap' | 'gear' | 'flapsDown' | 'flapsUp' | {thr} | {key, ms} | {js}
//   check: { kind?, id?: regex, rel?: regex, why?: regex (loop cause), after?, before?, afterMark?, min?, max?, name }
//          — counts matching trace entries; { endLoops } / { order } / { period } / { silentAfterMark } are special
const S = {
  airliner: (id, a320) => [
    { name: 'autoland callouts', setup: { ...final(6500), speed: null }, steps: [[0.5, 'ap']], dur: 105,
      expect: a320 ? [
        { name: '1000', rel: /v_1000$/, min: 1, max: 1 }, { name: '500', rel: /v_500$/, min: 1, max: 1 },
        { name: '400', rel: /v_400$/, min: 1, max: 1 }, { name: 'HUNDRED ABOVE', rel: /v_hundredabove$/, min: 1, max: 1 },
        { name: 'MINIMUM', rel: /v_minimum$/, min: 1, max: 1 }, { name: 'no THREE/TWO HUNDRED (DH calls win)', rel: /v_(300|200)$/, max: 0 },
        { name: '100', rel: /v_100$/, min: 1, max: 1 }, { name: '50 40 30', rel: /v_(50|40|30)$/, min: 3, max: 3 },
        { name: 'TEN, RETARD (autoland)', rel: /v_10_retard$/, min: 1, max: 1 }, { name: 'no EGPWS alert', id: /^gpws:/, max: 0 },
        { name: 'no CRC', id: /crc/, kind: 'loop+', max: 0 },
      ] : [
        { name: '1000', rel: /v_1000$/, min: 1, max: 1 }, { name: '500', rel: /v_500$/, min: 1, max: 1 },
        { name: 'APPROACHING MINIMUMS', rel: /v_apprmin$/, min: 1, max: 1 }, { name: 'MINIMUMS', rel: /v_minimums$/, min: 1, max: 1 },
        { name: '100 50 40 30 20 10', rel: /v_(100|50|40|30|20|10)$/, min: 6, max: 6 },
        { name: 'no warning voices', rel: /v_(sinkrate|pullup|toolow|terrain|dontsink|glideslope|bankangle)/, max: 0 },
        { name: 'no horn', id: /horn/, kind: 'loop+', max: 0 },
      ] },
    ...(a320 ? [{ name: 'manual landing RETARD until idle', setup: { ...final(2600), speed: null }, steps: [], dur: 52, idleAfterRetard: 3.2,
      expect: [
        { name: 'TWENTY, RETARD once', rel: /v_20_retard$/, min: 1, max: 1 },
        { name: 'RETARD repeats while above idle', rel: /v_retard$/, min: 2 },
        { name: 'RETARD period 1.0-1.3 s', period: /v_retard$/, lo: 0.95, hi: 1.35 },
        { name: 'RETARD stops after idle', rel: /v_retard$/, afterMark: 'idle', afterDelay: 1.3, max: 0 },
        { name: 'no TEN/FIVE while RETARD', rel: /v_(10|5)$/, max: 0 },
      ] }] : []),
    { name: 'gear up on approach', setup: { ...BAY, alt: 700 * FT, speed: 150 * KTS, opts: { gearDown: false, flapIndex: a320 ? 4 : 7, verticalSpeed: -3.5 } },
      steps: [[13, 'gear']], dur: 26,
      expect: a320 ? [
        { name: 'CRC (L/G GEAR NOT DOWN) on', kind: 'loop+', id: /fwc:crc/, why: /gearNotDown/, before: 8, min: 1 },          // the first scenario after load starts a few s late
        { name: 'TOO LOW, GEAR', rel: /v_toolow_gear$/, min: 1 },
        { name: 'CRC off after gear down', kind: 'loop-', id: /fwc:crc/, after: 13, min: 1 },
        { name: 'no TOO LOW GEAR after gear down', rel: /v_toolow_gear$/, after: 24, max: 0 },
      ] : [
        { name: 'steady gear horn on', kind: 'loop+', id: /boeing:horn$/, before: 3.5, min: 1 },
        { name: 'TOO LOW, GEAR', rel: /v_toolow_gear$/, min: 1 },
        { name: 'horn off after gear down', kind: 'loop-', id: /boeing:horn$/, after: 13, min: 1 },
      ] },
    { name: 'sink rate then pull up', setup: { ...BAY, alt: 2000 * FT, speed: 250 * KTS, opts: { gearDown: false, flapIndex: 0, verticalSpeed: -25 } },
      steps: [], dur: 12,
      expect: [
        { name: 'SINK RATE', rel: /v_sinkrate$/, min: 1 }, { name: 'PULL UP repeating', rel: /v_pullup$/, min: 3 },
        { name: 'SINK RATE before PULL UP', order: [/v_sinkrate$/, /v_pullup$/] },
      ] },
    { name: 'overspeed', setup: { ...BAY, alt: 10000 * FT, speed: 215, opts: { gearDown: false, flapIndex: 0 } }, steps: [], dur: 5,
      expect: [a320 ? { name: 'CRC (OVERSPEED)', kind: 'loop+', id: /fwc:crc/, why: /overspeed/, min: 1 } : { name: 'clacker', kind: 'loop+', id: /boeing:clacker/, min: 1 }] },
    { name: 'takeoff configuration', setup: { ground: '28R', opts: { flapIndex: 0 } }, steps: [[1, { thr: 1 }], [4, 'flapsDown'], [4.3, 'flapsDown'], ...(a320 ? [] : [[4.6, 'flapsDown']]), [8, { thr: 0 }]], dur: 9,
      expect: [
        a320 ? { name: 'CRC (T.O CONFIG) with flaps 0', kind: 'loop+', id: /fwc:crc/, before: 2.5, min: 1 }
          : { name: 'intermittent horn with flaps UP', kind: 'loop+', id: /boeing:hornInt/, before: 2.5, min: 1 },
        a320 ? { name: 'CRC off with flaps 1+F', kind: 'loop-', id: /fwc:crc/, after: 4, before: 7.9, min: 1 }
          : { name: 'horn off with flaps 5', kind: 'loop-', id: /boeing:hornInt/, after: 4, before: 7.9, min: 1 },
      ] },
    ...(a320 ? [
      { name: 'SPEED SPEED SPEED, A.FLOOR, levers out of TOGA LK → A/THR OFF chime', setup: { ...BAY, alt: 1000 * FT, speed: 'vls-8',
        opts: { gearDown: true, flapIndex: 5, throttle: 0 } }, steps: [[0, { thr: 0 }], [11, { thr: 1, mark: 'toga' }]], dur: 20,
        expect: [{ name: 'SPEED SPEED SPEED', rel: /v_speed$/, min: 1 }, { name: 'repeated every 5 s', period: /v_speed$/, lo: 4.5, hi: 7 },
          { name: 'single chime (A/THR OFF) after leaving TOGA LK', kind: 'tone', id: /athr_off/, afterMark: 'toga', min: 1, max: 1 }] },
      { name: 'A/P off: cavalry + A/THR OFF chime, C-chord on deviation', setup: { ...BAY, alt: 5000 * FT, speed: 250 * KTS, opts: { gearDown: false, flapIndex: 0 } },
        steps: [[0.5, 'ap'], [3, 'ap'], [4, { key: 'KeyS', ms: 5000 }]], dur: 22,
        expect: [{ name: 'cavalry charge', kind: 'apd', min: 1 }, { name: 'single chime (A/THR OFF)', kind: 'tone', id: /athr_off/, min: 1, max: 1 },
          { name: 'continuous C-chord on 250 ft deviation', kind: 'loop+', id: /fwc:cchord/, min: 1 }] },
    ] : [
      { name: 'stick shaker', setup: { ...BAY, alt: 5000 * FT, speed: 52, opts: { gearDown: false, flapIndex: 0 } }, steps: [], dur: 4,
        expect: [{ name: 'shaker', kind: 'loop+', id: /boeing:shaker/, min: 1 }] },
      { name: 'bank angle', setup: { ...BAY, alt: 3000 * FT, speed: 220 * KTS, opts: { gearDown: false, flapIndex: 0, bank: 41 } }, steps: [], dur: 5,
        expect: [{ name: 'BANK ANGLE once for 35+40', rel: /v_bankangle$/, min: 1, max: 1 }] },
      { name: 'altitude alert (MCP +1200 ft)', setup: { ...BAY, alt: 5000 * FT, speed: 250 * KTS, opts: { gearDown: false, flapIndex: 0 } },
        steps: [[0.5, 'ap'], [2, { js: 'window.__game.flight.autopilot.altitude += 1200 * 0.3048' }]], dur: 40,
        expect: [{ name: 'alt alert tone 900 ft before', kind: 'tone', id: /alt_alert/, min: 1, max: 1 }] },
    ]),
    { name: 'cruise: no false alerts', setup: { ...BAY, alt: 6000 * FT, speed: 260 * KTS, opts: { gearDown: false, flapIndex: 0 } }, steps: [], dur: 12,
      expect: [{ name: 'silence', kind: /^(voice|tone|loop\+)$/, max: 0 }] },
    { name: 'owner report: after takeoff, throttle to idle, hands off', setup: { ...BAY, alt: 450 * FT, speed: 150 * KTS,
      opts: { gearDown: false, flapIndex: a320 ? 2 : 3, verticalSpeed: 4 } }, steps: [[0.3, { thr: 0 }]], dur: 40, report: true,
      expect: a320 ? [{ name: 'SPEED SPEED SPEED (low energy)', rel: /v_speed$/, min: 1 },
        { name: 'no L/G NOT DOWN CRC in the take-off phase', kind: 'loop+', id: /fwc:crc/, why: /gearNotDown/, max: 0 }]
        : [{ name: 'DON\'T SINK (altitude loss after take-off)', rel: /v_dontsink$/, min: 1 },
          { name: 'stick shaker when the AOA reaches the shaker', kind: 'loop+', id: /boeing:shaker/, min: 1 }] },
    { name: 'crash silences everything (A/P disconnect loop, gear alert)', setup: { ...BAY, alt: 1500 * FT, speed: 160 * KTS,
      opts: { gearDown: false, flapIndex: a320 ? 4 : 6, verticalSpeed: -3 } },
      steps: [[0.3, 'ap'], [2.5, { js: 'window.__game.flight.ap.disengage("limit")' }], [5, { js: 'window.__game.flight._crash("probe")', mark: 'crash' }]], dur: 9,
      expect: [{ name: 'involuntary A/P disconnect alert', kind: 'apd', min: 1 },
        { name: 'A/P disconnect alert stopped by the crash', kind: 'apd-', afterMark: 'crash', min: 1 },
        { name: 'nothing starts after the crash', silentAfterMark: 'crash', delay: 0.15 },
        { name: 'no alert loop left running', endLoops: 0, strict: true }] },
  ],
  fighter: (id) => [
    { name: 'gear up, slow, descending (TO/LDG CONFIG)', setup: { ...BAY, alt: 3000 * FT, speed: 165 * KTS, opts: { gearDown: false, verticalSpeed: -6 } },
      steps: [[9, 'gear']], dur: 18,
      expect: id === 'f16' ? [
        { name: 'LG warning horn on', kind: 'loop+', id: /vms:lgHorn/, before: 2.6, min: 1 },
        { name: 'WARNING WARNING 1.5 s after the light', rel: /v_warning$/, after: 2.9, before: 3.6, min: 1, max: 1 },
        { name: 'LG horn muted while the voice speaks', kind: 'loop-', id: /vms:lgHorn/, after: 2.9, before: 3.6, min: 1 },
        { name: 'horn off after gear down', kind: 'loop-', id: /vms:lgHorn/, after: 9, min: 1 },
        { name: 'no LANDING GEAR / OVER G voice', rel: /v_(gear|overg|lowspeed)$/, max: 0 },
      ] : [
        { name: 'warning tone + LANDING GEAR', rel: /f22\/v_gear$/, min: 1 },
        { name: 'no F-16 VMS words', rel: /v_(warning|caution|altitude|bingo)$/, max: 0 },
      ] },
    { name: 'pull up', setup: { ...BAY, alt: 1500 * FT, speed: 400 * KTS, opts: { gearDown: false, verticalSpeed: -60 } }, steps: [], dur: 5,
      expect: [{ name: 'PULL UP repeating', rel: /v_pullup$/, min: 1 }] },
    ...(id === 'f16' ? [
      { name: 'ALTITUDE below ALOW (gear up)', setup: { ...BAY, alt: 800 * FT, speed: 300 * KTS, opts: { gearDown: false, verticalSpeed: -9 } }, steps: [], dur: 12,
        expect: [{ name: 'ALTITUDE ALTITUDE once', rel: /v_altitude$/, min: 1, max: 1 }] },
      { name: 'BINGO + FUEL LOW caution', setup: { ...BAY, alt: 10000 * FT, speed: 300 * KTS, opts: { gearDown: false, fuel: 250 } }, steps: [], dur: 10,
        expect: [{ name: 'BINGO once', rel: /v_bingo$/, min: 1, max: 1 }, { name: 'CAUTION 7 s after the light', rel: /v_caution$/, after: 6.5, min: 1, max: 1 }] },
      { name: 'low-speed tone (gear down, AOA >= 15)', setup: { ...BAY, alt: 4000 * FT, speed: 150 * KTS, opts: { gearDown: true, throttle: 0 } },
        steps: [[0.2, { thr: 0 }], [1, { key: 'KeyS', ms: 7000 }]], dur: 9,
        expect: [{ name: 'low-speed tone', kind: 'loop+', id: /vms:lowSpeed/, min: 1 }] },
      { name: 'slow flight 53 m/s gear up (lead repro) → TO/LDG CONFIG: LG horn + WARNING WARNING (no gear-up low-speed tone at level pitch)',
        setup: { ...BAY, alt: 4000 * FT, speed: 53, opts: { gearDown: false, throttle: 0 } },
        steps: [[0.2, { thr: 0 }], [9, { thr: 1, mark: 'recover' }], [9, { key: 'KeyW', ms: 2500 }]], dur: 20,
        expect: [{ name: 'LG warning horn (gear up, < 190 kt, descending)', kind: 'loop+', id: /vms:lgHorn/, before: 8, min: 1 },
          { name: 'WARNING WARNING (TO/LDG CONFIG light)', rel: /v_warning$/, before: 9, min: 1 },
          { name: 'no low-speed tone at level pitch, gear up', kind: 'loop+', id: /vms:lowSpeed/, before: 9, max: 0 },
          { name: 'no LOW SPEED / OVER G voice', rel: /v_(lowspeed|overg|gear)$/, max: 0 }] },
      { name: 'VMS silent with weight on wheels', setup: { ground: '24', opts: { fuel: 200 } }, steps: [], dur: 9,
        expect: [{ name: 'no VMS voice on the ground', id: /^vms:/, kind: 'voice', max: 0 }] },
    ] : [
      { name: 'fuel low caution tone', setup: { ...BAY, alt: 10000 * FT, speed: 300 * KTS, opts: { gearDown: false, fuel: 400 } }, steps: [], dur: 4,
        expect: [{ name: 'caution tone', kind: 'tone', id: /fuel_low/, min: 1, max: 1 }] },
    ]),
    { name: 'cruise: no false alerts', setup: { ...BAY, alt: 8000 * FT, speed: 350 * KTS, opts: { gearDown: false } }, steps: [], dur: 10,
      expect: [{ name: 'silence', kind: /^(voice|tone|loop\+)$/, max: 0 }] },
    { name: 'owner report: after takeoff, throttle to idle, hands off', setup: { ...BAY, alt: 800 * FT, speed: 250 * KTS, opts: { gearDown: false, verticalSpeed: 25 } },
      steps: [[0.3, { thr: 0 }]], dur: 40, report: true, expect: [
        ...(id === 'f16' ? [{ name: 'a VMS / tone warning before PULLUP', order: [/v_warning$|v_altitude$|vms:lgHorn|vms:lowSpeed/, /v_pullup$/] }]
          : [{ name: 'LANDING GEAR warning before PULL UP', order: [/v_gear$/, /v_pullup$/] }])] },
    { name: 'crash silences everything', setup: { ...BAY, alt: 3000 * FT, speed: 165 * KTS, opts: { gearDown: false, verticalSpeed: -6 } },
      steps: [[5, { js: 'window.__game.flight._crash("probe")', mark: 'crash' }]], dur: 8,
      expect: [{ name: 'alert before the crash', kind: /^(voice|loop\+)$/, before: 5, min: 1 }, { name: 'nothing starts after the crash', silentAfterMark: 'crash', delay: 0.15 },
        { name: 'nothing playing at the end', endLoops: 0, strict: true }] },
  ],
  helicopter: () => [
    { name: 'cruise: no false alerts', setup: { ...BAY, alt: 500 * FT, speed: 50 }, steps: [], dur: 10,
      expect: [{ name: 'silence', kind: /^(voice|tone|loop\+)$/, max: 0 }] },
    { name: 'both engines out → ENGINE 1/2 OUT + LOW ROTOR (VWS), cut when restored', setup: { ...BAY, alt: 3000 * FT, speed: 50 },
      steps: [[1, { js: 'window.__game.flight.failEngine("both")' }], [22, { js: 'window.__game.flight.failEngine("both", false)', mark: 'restore' }]], dur: 34,
      expect: [{ name: 'ENGINE 1 OUT', rel: /uh60\/v_eng1out$/, min: 1 }, { name: 'ENGINE 2 OUT', rel: /uh60\/v_eng2out$/, min: 1 },
        { name: 'LOW ROTOR', rel: /uh60\/v_lowrotor$/, min: 1 }, { name: 'no tone loop (the tone is part of the VWS cycle)', kind: 'loop+', max: 0 },
        { name: 'VWS quiet after the engines recover', kind: 'voice', id: /^vws:/, afterMark: 'restore', afterDelay: 12, max: 0 }] },
    { name: 'owner report: collective down (rotor overspeed) → no rotor warning', setup: { ...BAY, alt: 900 * FT, speed: 50 }, steps: [[0.3, { thr: 0 }]], dur: 12, report: true,
      expect: [{ name: 'no LOW ROTOR / ENGINE OUT on overspeed', rel: /v_(lowrotor|eng\dout)$/, max: 0 }, { name: 'no loop', kind: 'loop+', max: 0 }] },
    { name: 'descending fast through the low bug (50 ft) → ALTITUDE LOW once', setup: { ...BAY, alt: 150 * FT, speed: 20 }, steps: [[0.3, { thr: 0.12 }]], dur: 10,
      expect: [{ name: 'ALTITUDE LOW once', rel: /uh60\/v_altlow$/, min: 1, max: 1 }] },
    { name: 'crash cuts the VWS', setup: { ...BAY, alt: 3000 * FT, speed: 50 },
      steps: [[1, { js: 'window.__game.flight.failEngine("both")' }], [6, { js: 'window.__game.flight._crash("probe")', mark: 'crash' }]], dur: 9,
      expect: [{ name: 'VWS before the crash', kind: 'voice', id: /^vws:/, min: 1 }, { name: 'nothing starts after the crash', silentAfterMark: 'crash', delay: 0.15 },
        { name: 'nothing playing at the end', endLoops: 0, strict: true }] },
  ],
};

const category = { a320neo: 'airliner', b737: 'airliner', f16: 'fighter', f22: 'fighter', uh60: 'helicopter' }[ac];
const scenarios = (category === 'airliner' ? S.airliner(ac, ac === 'a320neo') : category === 'fighter' ? S.fighter(ac) : S.helicopter())
  .filter((s) => !only || only.some((o) => s.name.includes(o)));

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /audio/i.test(m.text()))) problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/index.html?aircraft=${ac}&spawn=AIR-SFO-FINAL&telemetry=0`, { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.mouse.click(640, 360);
let ready = false;
for (let i = 0; i < 600 && !ready; i++) {
  ready = await page.evaluate(() => { const a = window.__audioSys, g = window.__game; return !!(a && g && g.flight && g.world && a.context && a.context.state === 'running' && a.debug().alerts); });
  if (!ready) await page.waitForTimeout(250);
}
if (!ready) { console.log('game/audio not ready', problems); await browser.close(); process.exit(1); }
await page.waitForTimeout(3000);          // let the buffers decode
await page.evaluate(() => {
  window.__T = {
    rwEnd(ident) {
      for (const apt of window.__game.world.runways.airports) for (const r of apt.runways) for (const e of r.ends) if (e.ident === ident && (apt.icao === 'KSFO' || ident === '24')) {
        const h = e.headingTrue * Math.PI / 180; return { x: e.x + Math.sin(h) * 45, z: e.z - Math.cos(h) * 45, heading: h };
      }
      return null;
    },
  };
});

const results = [];
for (const sc of scenarios) {
  const t0 = await page.evaluate(async (sc) => {
    const g = window.__game, f = g.flight, a = window.__audioSys;
    const st = sc.setup;
    const opts = { ...(st.opts || {}) };
    if (st.ground) {
      const e = window.__T.rwEnd(st.ground);
      f.reset({ x: e.x, z: e.z, heading: e.heading }, g.world, opts);
    } else {
      let speed = st.speed;
      if (speed === 'vls-8') { f.reset({ x: st.x, z: st.z, heading: st.heading, altitude: st.alt, speed: 80 }, g.world, opts); speed = f.vSpeeds.vls - 8 * 0.514444; }
      f.reset({ x: st.x, z: st.z, heading: st.heading, altitude: st.alt, speed: speed ?? undefined }, g.world, opts);
    }
    if (opts.fuel != null) f.fuel = opts.fuel;
    if (g.input.setThrottle) g.input.setThrottle(opts.throttle ?? f.throttle ?? 0);
    return a.context.currentTime;
  }, sc);
  const wall0 = Date.now();
  const marks = {};
  const steps = sc.steps.map(([t, a]) => ({ t, a, done: false }));
  let retardSeen = null;
  while ((Date.now() - wall0) / 1000 < sc.dur) {
    const t = (Date.now() - wall0) / 1000;
    for (const s of steps) {
      if (s.done || t < s.t) continue;
      s.done = true;
      const a = s.a;
      if (a.mark) marks[a.mark] = +(await page.evaluate((t0) => window.__audioSys.context.currentTime - t0, t0)).toFixed(2);
      if (typeof a === 'string') await page.evaluate((c) => window.__game.flight.command(c === 'ap' ? 'autopilot' : c), a);
      else if (a.thr != null) await page.evaluate((v) => { const i = window.__game.input; if (i.setThrottle) i.setThrottle(v); else i.state.throttle = v; }, a.thr);
      else if (a.key) { await page.keyboard.down(a.key); setTimeout(() => page.keyboard.up(a.key).catch(() => {}), a.ms); }
      else if (a.js) await page.evaluate(a.js);
    }
    if (sc.idleAfterRetard && retardSeen === null) {
      const hit = await page.evaluate((t0) => window.__audioSys.trace.find((e) => e.t >= t0 && /v_20_retard$/.test(e.rel || '')), t0);
      if (hit) retardSeen = hit.t;
    }
    if (retardSeen !== null && !marks.idle) {
      const now = await page.evaluate(() => window.__audioSys.context.currentTime);
      if (now - retardSeen >= sc.idleAfterRetard) {
        await page.evaluate(() => { const i = window.__game.input; if (i.setThrottle) i.setThrottle(0); else i.state.throttle = 0; });
        marks.idle = now - t0;
      }
    }
    await page.waitForTimeout(100);
  }
  const data = await page.evaluate((t0) => {
    const f = window.__game.flight;
    const dbg = window.__audioSys.debug();
    return { loopsAtEnd: dbg.alerts.loops, voiceAtEnd: dbg.alerts.voice ? dbg.alerts.voice.rel : null, apdAtEnd: !!dbg.apd, trace: window.__audioSys.trace.filter((e) => e.t >= t0).map((e) => ({ ...e, t: +(e.t - t0).toFixed(2) })),
      end: { agl: +f.agl.toFixed(1), ias: +(f.ias / 0.514444).toFixed(0), onGround: f.onGround, crashed: f.crashed, gear: +f.gear.toFixed(2), ap: f.autopilot && f.autopilot.mode,
        nr: f.rotorRPM ? +f.rotorRPM.toFixed(2) : undefined, w: Object.entries(f.warnings || {}).filter(([, b]) => b === true).map(([k]) => k).join('+') } };
  }, t0);
  const tr = data.trace;
  const match = (c) => tr.filter((e) => (!c.kind || (c.kind instanceof RegExp ? c.kind.test(e.kind) : e.kind === c.kind)) &&
    (!c.id || c.id.test(e.id)) && (!c.rel || c.rel.test(e.rel || '')) && (!c.why || c.why.test(e.why || '')) && (c.after == null || e.t >= c.after) && (c.before == null || e.t <= c.before) &&
    (!c.afterMark || (marks[c.afterMark] != null && e.t >= marks[c.afterMark] + (c.afterDelay || 0))));
  const checks = sc.expect.map((c) => {
    if (c.order) {      // first match of order[0] comes before the first of order[1] (or order[1] never happens)
      const i0 = tr.findIndex((e) => c.order[0].test(e.rel || e.id)), i1 = tr.findIndex((e) => c.order[1].test(e.rel || e.id));
      return { name: c.name, ok: i0 >= 0 && (i1 < 0 || i0 < i1), got: [i0 >= 0 ? tr[i0].t : null, i1 >= 0 ? tr[i1].t : null] };
    }
    if (c.period) {
      const ts = tr.filter((e) => e.kind === 'voice' && c.period.test(e.rel || '')).map((e) => e.t);
      const d = ts.slice(1).map((t, i) => +(t - ts[i]).toFixed(2));
      return { name: c.name, ok: d.length > 0 && d.every((x) => x >= c.lo && x <= c.hi), got: d };
    }
    if (c.endLoops != null) {
      const busy = [...data.loopsAtEnd, ...(c.strict && data.voiceAtEnd ? [data.voiceAtEnd] : []), ...(c.strict && data.apdAtEnd ? ['apd'] : [])];
      return { name: c.name, ok: busy.length <= c.endLoops || (!c.strict && data.end.crashed), got: busy };
    }
    if (c.silentAfterMark) {
      if (marks[c.silentAfterMark] == null) return { name: c.name, ok: false, got: 'mark not reached' };
      const late = tr.filter((e) => /^(voice|tone|loop\+|apd)$/.test(e.kind) && e.t > marks[c.silentAfterMark] + (c.delay || 0));
      return { name: c.name, ok: late.length === 0, got: late.map((e) => `${e.t}s ${e.kind} ${e.rel || e.id}`) };
    }
    if (c.afterMark && marks[c.afterMark] == null) return { name: c.name, ok: false, got: 'mark not reached' };
    const n = match(c).length;
    return { name: c.name, ok: (c.min == null || n >= c.min) && (c.max == null || n <= c.max), got: n };
  });
  const pass = checks.every((c) => c.ok);
  results.push({ ac, scenario: sc.name, pass, checks, marks, end: data.end, trace: tr.filter((e) => e.kind !== 'voice-') });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${ac} · ${sc.name}   (end: ${JSON.stringify(data.end)})`);
  for (const c of checks) console.log(`   ${c.ok ? 'ok ' : 'XX '} ${c.name}${c.got !== undefined ? '  → ' + JSON.stringify(c.got) : ''}`);
  console.log('   trace:', tr.filter((e) => e.kind !== 'voice-' || e.cut).map((e) => `${e.t}s ${e.kind} ${(e.rel || e.id).replace(/^.*\//, '')}${e.why ? '(' + e.why + ')' : ''}`).join(' | ') || '(nothing)');
  if (Object.keys(marks).length) console.log('   marks:', JSON.stringify(marks));
}
const errs = problems.filter((p) => !/ScriptProcessorNode|GL Driver|GPU stall/.test(p));
console.log(errs.length ? 'console problems:\n' + errs.join('\n') : 'no console errors');
if (out) fs.writeFileSync(out, JSON.stringify({ ac, results, consoleErrors: errs }, null, 1));
if (args.includes('--record') && !only) {
  const rp = new URL('./research/alertprobe.json', import.meta.url);
  const rec = fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, 'utf8')) : {};
  rec[ac] = results.map((r) => ({ scenario: r.scenario, pass: r.pass, checks: r.checks.map((c) => ({ name: c.name, ok: c.ok, got: c.got })) }));
  rec._consoleErrors = { ...(rec._consoleErrors || {}), [ac]: errs.length };
  fs.writeFileSync(rp, JSON.stringify(rec, null, 1));
}
await browser.close();
