#!/usr/bin/env node
// Every converted GLB (and phone variant): Khronos glTF validator, then loaded through the game's loader with the KTX2 transcoder forced to each target family
// (ASTC, BC7, ETC2, ETC1, BC1/3, PVRTC, RGBA fallback, and the browser's own pick), in Chromium (ANGLE/Metal),
// WebKit and WebKit with an iPhone profile: zero GL errors, zero console errors, every texture compressed.
// usage: node tools/assets/check.mjs [--base http://localhost:5173/] [--engines chromium,webkit,iphone]
//                                    [--targets auto,astc,bptc,etc2,etc1,dxt,rgba,pvrtc] [--only f16] [--cap 1024]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';
import { createRequire } from 'node:module';
import { readGlb } from './lib/glb.mjs';

const validator = createRequire(import.meta.url)('gltf-validator');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const base = opt('--base', 'http://localhost:5173/');
const engines = opt('--engines', 'chromium,webkit,iphone').split(',');
const targets = opt('--targets', 'auto,astc,bptc,etc2,etc1,dxt,rgba').split(',');   // pvrtc: WebKit wants square POT PVRTC1 textures; never the only format on a WebGL2 device (iOS has ETC2 + ASTC)
const only = opt('--only', '');
const cap = opt('--cap', '');

const files = [];
const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory() && depth > 1 && !/^[_.]|^(tex|src|shared|render|dev)$/.test(e.name)) walk(p, depth - 1);
  else if (e.isFile() && e.name.endsWith('.glb')) {
    const { json } = readGlb(fs.readFileSync(p));
    if ((json.extensionsUsed || []).includes('KHR_texture_basisu')) files.push(path.relative(ROOT, p));
  }
} };
walk(path.join(ROOT, 'assets/aircraft'), 2); walk(path.join(ROOT, 'assets/sf/landmarks'), 1); walk(path.join(ROOT, 'assets/sf/airports'), 1);
const list = files.filter((f) => !only || f.includes(only));
console.log(`${list.length} GLBs with KTX2 textures`);

let bad = 0;
// 1. Khronos glTF validator on every file (external shared/*.ktx2 resolved from disk); errors the exported original
//    already had (in _orig/) are reported but not counted
const errorsOf = async (abs) => {
  const rep = await validator.validateBytes(new Uint8Array(fs.readFileSync(abs)), {
    uri: path.basename(abs), maxIssues: 100,
    externalResourceFunction: (uri) => Promise.resolve(new Uint8Array(fs.readFileSync(path.join(path.dirname(abs), decodeURIComponent(uri))))),
  });
  return rep.issues.messages.filter((m) => m.severity === 0).map((m) => `${m.code} ${m.pointer || ''}`);
};
let clean = 0;
for (const f of list) {
  const abs = path.join(ROOT, f);
  const orig = path.join(path.dirname(abs), '_orig', path.basename(abs).replace(/\.phone\.glb$/, '.glb'));
  const before = new Set(fs.existsSync(orig) ? await errorsOf(orig) : []);
  const errs = await errorsOf(abs);
  const added = errs.filter((e) => !before.has(e));
  if (added.length) { bad++; console.log(`validator: ${f}: ${added.slice(0, 3).join('; ')}`); } else clean++;
  if (errs.length > added.length) console.log(`validator: ${f}: ${errs.length - added.length} error(s) already in the Blender export (${[...before][0]})`);
}
console.log(`glTF validator: ${clean}/${list.length} without new errors`);
// 2. load + render in the browsers, transcoder forced to each target family
for (const eng of engines) {
  const browser = eng === 'chromium' ? await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }) : await webkit.launch();
  const ctx = eng === 'iphone' ? await browser.newContext({ ...devices['iPhone 15 Pro'] }) : await browser.newContext();
  for (const t of targets) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}tools/assets/check.html?target=${t}&files=${list.join(',')}${cap ? `&cap=${cap}` : ''}`);
    await page.waitForFunction(() => window.__check && window.__check.done, null, { timeout: 600000, polling: 250 });
    const r = await page.evaluate(() => window.__check);
    if (r.skipped) { console.log(`${eng.padEnd(8)} ${t.padEnd(6)} skipped (${r.skipped})`); await page.close(); continue; }
    const fails = r.results.filter((x) => !x.ok);
    const allErr = errors.concat(r.errors);
    bad += fails.length + allErr.length;
    const maxLoad = Math.max(...r.results.map((x) => x.loadMs || 0));
    console.log(`${eng.padEnd(8)} ${t.padEnd(6)} ${r.results.length - fails.length}/${r.results.length} ok, formats ${JSON.stringify(r.formats)}, console errors ${allErr.length}, slowest load ${maxLoad} ms${eng === 'chromium' && t === 'auto' ? `, supported ${Object.entries(r.supported).filter(([, v]) => v).map(([k]) => k.replace('Supported', '')).join('/')}` : ''}`);
    if (t === 'auto' && eng !== 'chromium') console.log(`         supported ${Object.entries(r.supported).filter(([, v]) => v).map(([k]) => k.replace('Supported', '')).join('/')}`);
    for (const f of fails) console.log(`   FAIL ${f.file} ${f.error || `gl ${f.glError}, ${f.compressed}/${f.textures} compressed`}`);
    for (const e of allErr.slice(0, 5)) console.log(`   console: ${e}`);
    await page.close();
  }
  await browser.close();
}
console.log(bad ? `${bad} problems` : 'all good');
process.exit(bad ? 1 : 0);
