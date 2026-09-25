#!/usr/bin/env node
// Quality gate for the device-class optimisations (docs/perf/findings-2026-09.md): frozen-time screenshots of fixed
// poses per device class and map, compared against a LOCAL reference set with tools/perf/ssim.py. References are not
// in git (the game's assets are not part of the code licence): capture your own before a change,
//   node tools/perf/refshots.mjs capture --out .cache/perf-ref   (or set $PERF_REF to another directory)
// and a second capture for the run-to-run noise floor (noise.json next to the images).
//
//   capture:  node tools/perf/refshots.mjs capture --out <dir> [--classes desktop,tablet,phone] [--maps sf,ist]
//                [--poses a,b] [--base http://localhost:5173/] [--webkit]
//   compare:  node tools/perf/refshots.mjs compare --cand <dir> [--ref $PERF_REF | .cache/perf-ref] [--heatmaps <dir>]
//   gate:     node tools/perf/refshots.mjs gate [--base URL]   (= capture into $PERF_OUT/refgate-<time> + compare; exit 1 on FAIL)
//   noise:    node tools/perf/refshots.mjs noise --ref <dir> --noise <dir>   (writes <ref>/noise.json)
//
// Classes (the game's own device overrides; HUD hidden with CSS only, see docs/perf/plan.md 4.7 item 4):
//   desktop  1280×720 @1, ?quality=high                         (1280×720 keeps the reference PNGs small)
//   tablet   1024×768 @2 (iPad), ?device=tablet&touch=1, the class default preset (medium), screenshot in CSS pixels
//   phone    844×390 @3 (iPhone in landscape), ?device=phone&touch=1, the class default preset (low), screenshot in CSS pixels
// Poses: tools/perf/lib.mjs POSES (aircraft close-up, cockpit, SFO / LTFM ground, Golden Gate, 15 Temmuz, Sultanahmet …).
import { launch, openGame, setPose, settle, sleep, arg, flag, OUT, POSES, poseMap } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
export const REF_DIR = process.env.PERF_REF ? path.resolve(process.env.PERF_REF) : path.join(REPO, '.cache/perf-ref');
export const CLASSES = {
  desktop: { width: 1280, height: 720, dpr: 1, quality: 'high', extra: '', touch: false },
  tablet: { width: 1024, height: 768, dpr: 2, quality: 'auto', extra: '&device=tablet&touch=1', touch: true },
  // landscape: in portrait the game pauses behind a "Telefonu yan çevir" prompt that covers the scene
  phone: { width: 844, height: 390, dpr: 3, quality: 'auto', extra: '&device=phone&touch=1', touch: true, mobile: true },
};
export const REF_POSES = {
  sf: ['aircraft-close', 'cockpit', 'sfo-ground', 'free-sfo', 'free-ggb', 'free-downtown'],
  ist: ['ist-ltfm-ground', 'ist-free-ltfm', 'ist-free-15temmuz', 'ist-free-sultanahmet', 'ist-bogaz'],
};
const SPAWN = { sf: 'KSFO-28R', ist: 'LTFM-35L' };
const PY = fs.existsSync(path.join(REPO, '.venv/bin/python')) ? path.join(REPO, '.venv/bin/python') : 'python3';

export async function captureClass(cls, map, dir, { base, poses, aircraft = 'f16', engine = 'chromium' } = {}) {
  const c = CLASSES[cls];
  fs.mkdirSync(dir, { recursive: true });
  const { browser, page, log } = await launch({ engine, width: c.width, height: c.height, dpr: c.dpr, gl: 'off', clock: 'virtual', hasTouch: c.touch, isMobile: c.mobile });
  const meta = {};
  try {
    await openGame(page, { aircraft, spawn: SPAWN[map], quality: c.quality, pr: 0, extra: `${c.extra}${map === 'sf' ? '' : `&map=${map}`}&telemetry=0`, base });
    await page.addStyleTag({ content: '#hud, #ui { display: none !important; }' });
    for (const pose of poses || REF_POSES[map]) {
      if (!POSES[pose] || poseMap(pose) !== map) { console.log('skip', pose); continue; }
      await page.evaluate(() => window.__perf.freeze(false));
      await setPose(page, pose);
      const st = await settle(page, { minMs: 5000, maxMs: 45000, quietMs: 2500 });
      await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 30 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
      await page.evaluate(() => {
        window.__perf.freeze(true);
        const w = window.__game.world, T = 1000;
        if (w.terrain && w.terrain.shared && w.terrain.shared.uTime) w.terrain.shared.uTime.value = T;
        const e = w.environment;
        if (e && e.skyUniforms && e.skyUniforms.uTime) e.update(T - e.skyUniforms.uTime.value, window.__game.camera);
      });
      await sleep(1200);
      const file = `${cls}-${pose}.png`;
      await page.screenshot({ path: path.join(dir, file), scale: 'css' });
      const q = await page.evaluate(() => ({ quality: window.__game.quality && window.__game.quality.id, deviceClass: window.__game.quality && window.__game.quality.deviceClass, pr: +window.__game.renderer.getPixelRatio().toFixed(2), meterMB: window.__game.gpu && window.__game.gpu.meter ? Math.round(window.__game.gpu.meter.bytes / 1048576) : null }));
      meta[file] = { cls, map, pose, settled: st.idle, settleMs: st.ms, ...q };
      console.log(`${cls} ${pose}: settled ${st.idle} in ${st.ms} ms, ${q.quality}/${q.deviceClass} pr ${q.pr}, meter ${q.meterMB} MB`);
    }
  } finally {
    meta.__errors = log.errors.slice(0, 10);
    await browser.close();
  }
  return meta;
}

export async function captureAll(dir, { classes, maps, poses, base, engine } = {}) {
  const all = {};
  for (const cls of classes) for (const map of maps) {
    const p = poses ? poses.filter((x) => poseMap(x) === map) : null;
    if (p && !p.length) continue;
    Object.assign(all, await captureClass(cls, map, dir, { base, poses: p, engine }));
  }
  const metaFile = path.join(dir, 'capture.json');
  const prev = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  fs.writeFileSync(metaFile, JSON.stringify({ ...prev, ...all, __base: base || '', __date: new Date().toISOString() }, null, 1));
  return all;
}

function compare(ref, cand, heat) {
  const args = [path.join(HERE, 'ssim.py'), '--dirs', ref, cand, '--json', path.join(cand, 'ssim.json')];
  if (fs.existsSync(path.join(ref, 'noise.json'))) args.push('--noise-json', path.join(ref, 'noise.json'));
  if (heat) args.push('--heatmaps', heat);
  try { process.stdout.write(execFileSync(PY, args, { encoding: 'utf8' })); return 0; } catch (e) { process.stdout.write(String(e.stdout || '')); return e.status || 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const classes = arg('--classes', 'desktop,tablet,phone').split(',');
  const maps = arg('--maps', 'sf,ist').split(',');
  const poses = arg('--poses', '') ? arg('--poses').split(',') : null;
  const base = arg('--base', undefined);
  const engine = flag('--webkit') ? 'webkit' : 'chromium';
  if (cmd === 'capture') {
    const dir = path.resolve(arg('--out', path.join(OUT, 'refshots')));
    await captureAll(dir, { classes, maps, poses, base, engine });
    console.log(`saved ${dir}`);
  } else if (cmd === 'compare') {
    process.exit(compare(path.resolve(arg('--ref', REF_DIR)), path.resolve(arg('--cand')), arg('--heatmaps', null)));
  } else if (cmd === 'gate') {
    const dir = path.join(OUT, `refgate-${Date.now()}`);
    await captureAll(dir, { classes, maps, poses, base, engine });
    process.exit(compare(path.resolve(arg('--ref', REF_DIR)), dir, path.join(dir, 'heat')));
  } else if (cmd === 'noise') {
    const ref = path.resolve(arg('--ref', REF_DIR)), noise = path.resolve(arg('--noise'));
    const out = path.join(ref, 'noise.json');
    try { execFileSync(PY, [path.join(HERE, 'ssim.py'), '--dirs', ref, noise, '--json', out], { encoding: 'utf8', stdio: 'inherit' }); } catch { /* fails are expected: this is the noise floor */ }
    console.log(`wrote ${out}`);
  } else {
    console.log('usage: refshots.mjs capture|compare|gate|noise … (see the header)');
    process.exit(2);
  }
}
