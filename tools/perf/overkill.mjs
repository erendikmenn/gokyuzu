#!/usr/bin/env node
// Overkill audit per device class and map (docs/perf/findings-2026-09.md): contention-free counts of work the game does
// that a phone / tablet may not need. Uses the device profiles of tools/perf/matrix.mjs and the probe's audit counters.
//
//   node tools/perf/overkill.mjs [--profiles desktop-high,tablet-chromium,phone-cpu4] [--maps sf,ist] [--ms 4000] [--tag name]
//
// Per profile × map (one page, the game's own device overrides):
//   states     flying (chase, autopilot), cockpit (on the runway, engines running), paused (P), navigation map open (J),
//              and the main menu (a second page without a flight): fps, rAF CPU ms/frame, WebGL draws/frame, DOM
//              mutations/frame, 2D-canvas calls / canvases touched per frame, Mpx of 2D canvas cleared per second,
//              canvas→texture uploads, Web Audio sources started per second
//   scene      lights (type, intensity, shadow), shader programs by material type, shadow map set-up, camera far plane,
//              farthest visible object per layer (terrain / city / trees / airports / landmarks), tree instances drawn,
//              2D canvases in the page with their backing-store size
//   textures   GL-level census (probe gl:'mem'): bytes by format class (block-compressed vs RGBA), the largest textures
//              with the layer that uses them, textures above 2048² / above the class cap
import { launch, openGame, setPose, settle, sleep, arg, save, OUT, BASE, fmtTable } from './lib.mjs';
import { PROFILES, MAPS } from './matrix.mjs';
import fs from 'node:fs';
import path from 'node:path';

const profiles = arg('--profiles', 'desktop-high,tablet-chromium,phone-cpu4').split(',');
const maps = arg('--maps', 'sf,ist').split(',');
const ms = Number(arg('--ms', 4000));
const tag = arg('--tag', 'overkill');
const base = arg('--base', BASE);

const tap = async (page, code) => { await page.keyboard.down(code); await sleep(60); await page.keyboard.up(code); };
async function stateWindow(page, name) {
  const a = await page.evaluate(() => performance.now());
  await sleep(ms);
  return page.evaluate(([a, name]) => {
    const P = window.__perf, b = performance.now();
    const fr = P.frames.filter((f) => f.t >= a && f.t <= b && f.dt > 0);
    const n = Math.max(1, fr.length);
    const au = P.auditWindow ? P.auditWindow(a, b) : {};
    return { state: name, fps: +(fr.length / ((b - a) / 1000)).toFixed(1), rafCpuMs: +(fr.reduce((s, f) => s + f.cpu, 0) / n).toFixed(2), glDrawsPerFrame: +(fr.reduce((s, f) => s + f.draws, 0) / n).toFixed(0), ...au };
  }, [a, name]);
}

async function sceneAudit(page) {
  return page.evaluate(() => {
    const g = window.__game, r = g.renderer, scene = g.scene, cam = g.camera, P = window.__perf;
    const lights = [];
    scene.traverse((o) => { if (o.isLight) lights.push({ type: o.type, name: o.name || (o.parent && o.parent.name) || '', intensity: +o.intensity.toFixed(2), visible: o.visible, castShadow: !!o.castShadow, shadowMap: o.castShadow && o.shadow ? o.shadow.mapSize.x : null }); });
    const progs = {};
    for (const p of r.info.programs || []) { const k = p.name || 'unnamed'; progs[k] = (progs[k] || 0) + 1; }
    // farthest visible (frustum-intersecting) mesh per top-level layer, horizontal distance from the camera
    const THREE = r.constructor;   // (not needed; plain maths below)
    void THREE;
    const cx = cam.position.x, cz = cam.position.z;
    const layers = {};
    const cityRoot = scene.children.find((c) => c.name === 'city');
    const add = (key, o) => {
      if (!o.geometry) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere; if (!bs) return;
      const c = bs.center.clone().applyMatrix4(o.matrixWorld);
      const d = Math.hypot(c.x - cx, c.z - cz);
      const L = layers[key] || (layers[key] = { meshes: 0, maxKm: 0, instances: 0 });
      L.meshes++; if (d > L.maxKm * 1000) L.maxKm = +(d / 1000).toFixed(1);
      if (o.isInstancedMesh) L.instances += o.count;
    };
    const visible = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    for (const top of scene.children) {
      const parts = top === cityRoot ? top.children.map((k) => [`city/${k.name}`, k]) : [[top.name || top.type, top]];
      for (const [key, root] of parts) root.traverse((o) => { if ((o.isMesh || o.isPoints) && visible(o)) add(key, o); });
    }
    const sun = scene.getObjectByName('sf-sun');
    const shadow = { enabled: r.shadowMap.enabled, autoUpdate: r.shadowMap.autoUpdate, type: r.shadowMap.type, mapSize: sun && sun.shadow ? sun.shadow.mapSize.x : null, far: sun && sun.shadow ? sun.shadow.camera.far : null, cascades: sun && sun.shadow && sun.shadow.cascades ? sun.shadow.cascades : null };
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ id: c.id || c.className || c.parentElement && (c.parentElement.id || c.parentElement.className) || '', w: c.width, h: c.height, css: [c.clientWidth, c.clientHeight], shown: !!(c.offsetWidth || c.offsetHeight), webgl: c === r.domElement }));
    // GL-level texture census (probe gl:'mem'), joined with three textures → layer names
    const texLayer = new Map();
    for (const top of scene.children) {
      const parts = top === cityRoot ? top.children.map((k) => [`city/${k.name}`, k]) : [[top.name || top.type, top]];
      for (const [key, root] of parts) root.traverse((o) => {
        for (const m of [].concat(o.material || [])) {
          if (!m) continue;
          const ts = []; for (const v of Object.values(m)) if (v && v.isTexture) ts.push(v);
          if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) ts.push(u.value);
          for (const t of ts) { const p = r.properties.get(t); if (p && p.__webglTexture && !texLayer.has(p.__webglTexture)) texLayer.set(p.__webglTexture, { layer: key, name: t.name || (m.name ? `mat:${m.name}` : '') }); }
        }
      });
    }
    const COMPRESSED = new Set([0x83F0, 0x83F1, 0x83F2, 0x83F3, 0x8C4C, 0x8C4D, 0x8C4E, 0x8C4F, 0x8E8C, 0x8E8D, 0x8DBB, 0x8DBD, 0x9270, 0x9272, 0x9274, 0x9275, 0x9276, 0x9277, 0x9278, 0x9279, 0x93B0, 0x93D0, 0x8D64, 'compressed']);
    const tex = [];
    for (const [t, e] of P.live.tex) { const l = texLayer.get(t) || { layer: '(not in scene: render targets, shadow maps, LUTs, released)', name: '' }; tex.push({ ...l, w: e.w, h: e.h, bytes: e.bytes, compressed: COMPRESSED.has(e.fmt) || e.fmt === 'compressed', fmt: e.fmt }); }
    const MB = (b) => +(b / 1048576).toFixed(1);
    const byLayer = {};
    for (const t of tex) { const k = t.layer; const L = byLayer[k] || (byLayer[k] = { n: 0, MB: 0, uncompressedMB: 0, over2048: 0 }); L.n++; L.MB += t.bytes; if (!t.compressed) L.uncompressedMB += t.bytes; if (Math.max(t.w, t.h) > 2048) L.over2048++; }
    for (const L of Object.values(byLayer)) { L.MB = MB(L.MB); L.uncompressedMB = MB(L.uncompressedMB); }
    const total = tex.reduce((s, t) => s + t.bytes, 0), unc = tex.filter((t) => !t.compressed).reduce((s, t) => s + t.bytes, 0);
    const top = tex.sort((a, b) => b.bytes - a.bytes).slice(0, 15).map((t) => ({ layer: t.layer, name: t.name, size: `${t.w}×${t.h}`, MB: MB(t.bytes), compressed: t.compressed }));
    const bufMB = MB([...P.live.buf.values()].reduce((s, b) => s + b, 0)), rbMB = MB([...P.live.rb.values()].reduce((s, b) => s + b, 0));
    return {
      pr: r.getPixelRatio(), canvas: [r.domElement.width, r.domElement.height], camera: { far: cam.far, near: cam.near, fog: scene.fog ? { type: scene.fog.type, near: scene.fog.near, far: scene.fog.far } : null },
      quality: g.quality, lights, programs: { total: (r.info.programs || []).length, byType: Object.fromEntries(Object.entries(progs).sort((a, b) => b[1] - a[1])) },
      shadow, layers, canvases, textures: { count: tex.length, MB: MB(total), uncompressedMB: MB(unc), bufferMB: bufMB, renderbufferMB: rbMB, byLayer, top },
      audio: { nodesCreated: P.audit ? P.audit.audioNodes : null, sourcesStarted: P.audit ? P.audit.audioStarted : null },
      domTop: P.audit ? [...P.audit.domTargets].sort((a, b) => b[1] - a[1]).slice(0, 12) : null,
      canvasTop: P.audit ? [...P.audit.canvases].map(([c, e]) => ({ id: c.id || c.className || (c.parentElement && (c.parentElement.id || c.parentElement.className)) || (c instanceof HTMLCanvasElement ? 'canvas' : 'offscreen'), size: `${c.width}×${c.height}`, inDom: !!(c.isConnected), calls: e.calls, frames: e.frames, clearMpx: +(e.clearPx / 1e6).toFixed(1) })).sort((a, b) => b.frames - a.frames).slice(0, 14) : null,
    };
  });
}

async function auditOne(profile, map) {
  const P = PROFILES[profile], M = MAPS[map];
  const res = { profile, map, label: P.label, states: [] };
  const { browser, page, log } = await launch({ engine: P.engine, width: P.width, height: P.height, dpr: P.dpr, gl: 'mem', audit: true, cpuThrottle: P.cpu, hasTouch: P.touch, isMobile: P.mobile });
  try {
    // main menu (no flight): what the loop does behind the menu
    await page.goto(`${base}index.html?${M.extra.replace(/^&/, '')}${P.extra}&telemetry=0${P.quality !== 'auto' ? `&quality=${P.quality}` : ''}`, { waitUntil: 'load' });
    await sleep(3000);
    res.states.push(await stateWindow(page, 'main menu'));
    await openGame(page, { aircraft: 'f16', spawn: M.spawn, quality: P.quality, pr: P.pr, extra: `${P.extra}${M.extra}&telemetry=0`, base, timeout: 300000 });
    // flying (chase, autopilot) from the first pose
    await setPose(page, M.poses[0]);
    await settle(page, { minMs: 3000, maxMs: 25000 });
    await page.evaluate(() => { const g = window.__game; g.paused = false; });
    await tap(page, 'Digit7'); await sleep(200);
    const ap = await page.evaluate(() => { const f = window.__game.flight; return f.autopilot ? !!f.autopilot.on : null; });
    if (!ap) await tap(page, 'KeyO');
    await sleep(1500);
    res.states.push(await stateWindow(page, 'flying (chase)'));
    res.scene = await sceneAudit(page);
    // paused
    await tap(page, 'KeyP'); await sleep(800);
    res.states.push(await stateWindow(page, 'paused'));
    await tap(page, 'KeyP'); await sleep(500);
    // navigation map open
    await tap(page, 'KeyJ'); await sleep(1200);
    res.states.push(await stateWindow(page, 'nav map open'));
    await tap(page, 'KeyJ'); await sleep(500);
    // cockpit on the runway (engines running)
    await setPose(page, M.cockpit);
    await settle(page, { minMs: 3000, maxMs: 25000 });
    await page.evaluate(() => { window.__game.paused = false; });
    await sleep(1000);
    res.states.push(await stateWindow(page, 'cockpit'));
    res.cockpitScene = await page.evaluate(() => ({ programs: (window.__game.renderer.info.programs || []).length, displays: (window.__game.displays || []).map((d) => { const t = d.display.texture; const img = t && t.image; return { w: img && img.width, h: img && img.height, mips: t && t.generateMipmaps }; }) }));
    res.cockpitCanvasTop = await page.evaluate(() => { const P = window.__perf; return P.audit ? [...P.audit.canvases].map(([c, e]) => ({ size: `${c.width}×${c.height}`, inDom: !!c.isConnected, frames: e.frames, calls: e.calls })).sort((a, b) => b.frames - a.frames).slice(0, 12) : null; });
  } catch (e) {
    res.error = String(e && e.stack || e);
    console.log(`FAILED ${profile} ${map}: ${e.message}`);
  } finally {
    res.errors = log.errors.slice(0, 8);
    await browser.close().catch(() => {});
  }
  return res;
}

const out = { base, date: new Date().toISOString(), runs: [] };
for (const profile of profiles) for (const map of maps) {
  console.log(`== ${profile} ${map}`);
  const r = await auditOne(profile, map);
  out.runs.push(r);
  save(`${tag}.json`, out);
  if (r.states.length) console.log(fmtTable(r.states, Object.keys(r.states[r.states.length - 1])));
  if (r.scene) {
    const s = r.scene;
    console.log(`lights: ${s.lights.map((l) => `${l.type}(${l.intensity}${l.castShadow ? ', shadow ' + l.shadowMap : ''}${l.visible ? '' : ', hidden'})`).join(' ')}`);
    console.log(`programs ${s.programs.total}: ${Object.entries(s.programs.byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`shadow ${JSON.stringify(s.shadow)} | camera far ${s.camera.far} | pr ${s.pr} canvas ${s.canvas}`);
    console.log(`layers: ${Object.entries(s.layers).map(([k, v]) => `${k} ${v.meshes} meshes ≤${v.maxKm} km${v.instances ? ` ${v.instances} inst` : ''}`).join(' | ')}`);
    console.log(`textures ${s.textures.count}: ${s.textures.MB} MB (${s.textures.uncompressedMB} MB uncompressed), buffers ${s.textures.bufferMB} MB`);
    console.log(`2D canvases: ${s.canvases.map((c) => `${c.id} ${c.w}×${c.h}${c.shown ? '' : ' (hidden)'}`).join(', ')}`);
  }
}
save(`${tag}.json`, out);
fs.writeFileSync(path.join(OUT, `${tag}.md`), out.runs.map((r) => `## ${r.profile} ${r.map}\n\n${r.states.length ? fmtTable(r.states, Object.keys(r.states[r.states.length - 1])) : r.error}`).join('\n\n'));
console.log(`saved ${OUT}/${tag}.json`);
