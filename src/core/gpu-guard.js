// Graphics robustness (context loss, GPU memory budget, render failures) for the SF game; wired by src/app/main.js.
//
// What happened before: when a browser runs out of GPU / process memory (iOS / iPadOS Safari first) it drops the
// page's WebGL context. three.js calls preventDefault, so the browser restores it, and three.js then re-creates every
// GPU object from its CPU copy on the next draw — but the city tiles free their vertex arrays after upload and the
// atlases / terrain / GLB images are released too, so every frame threw "null is not an object (evaluating
// 'array.byteLength')" before anything was drawn: the canvas stayed transparent (the page's navy background) while
// the HUD, sound and flight kept running. Restoring in place is not reliable with streamed, CPU-freed content, so:
//   1. context lost (or rendering keeps throwing) → halt, save the flight, short Turkish notice, reload one quality
//      step lower with ?resume=1 into the same flight (src/core/gpu-resume.js); never loops (3 failures in 30 min or
//      nothing left to lower → the notice offers buttons instead of reloading)
//   2. budget monitor: exact WebGL allocations (src/core/gpu-meter.js) above the preset / device budget for a few
//      seconds → step the quality down live before the browser has to kill the context
//   3. texture policy (src/core/gpu-textures.js): downscale oversized GLB textures, drop decoded CPU copies after upload
//   4. `gfx` telemetry on loss / restore / reload / budget step / resume, with a memory snapshot.
import { attachGpuMeter } from './gpu-meter.js';
import { createTexturePolicy } from './gpu-textures.js';
import { saveSnapshot, markSnapshotClosed, markSnapshotAlive } from './gpu-resume.js';
import { lowerQuality, setQualityCap, QUALITY } from './quality.js';
import { detectDevice, deviceLabel } from './gpu-device.js';
import { trackEvent } from './telemetry.js';

const LOSS_KEY = 'gokyuzu.gpuLosses';
const LOSS_WINDOW = 30 * 60 * 1000;
const MAX_LOSSES = 3;
const SAFE_PR = 0.75;       // last resort below 'low': pixel ratio

function losses() { try { return (JSON.parse(sessionStorage.getItem(LOSS_KEY) || '[]') || []).filter((t) => Date.now() - t < LOSS_WINDOW); } catch { return []; } }
/** Count a graphics failure of this tab (also used by main.js for a tab that died mid-flight); returns the count in 30 min. */
export function noteGpuFailure() { return addLoss(); }
function addLoss() { const l = losses(); l.push(Date.now()); try { sessionStorage.setItem(LOSS_KEY, JSON.stringify(l)); } catch { /* ignore */ } return l.length; }

export function shortGpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const m = /Renderer: ([^,)]+)/.exec(raw) || /^ANGLE \([^,]*, ([^,(]+)/.exec(raw);
    return (m ? m[1] : raw).replace(/ (Direct3D|OpenGL|Vulkan).*$/, '').trim().slice(0, 60);
  } catch { return detectDevice().gpu.slice(0, 60); }
}

// ---- notice (Turkish, over everything; the canvas behind it may be empty) ----
let noticeEl = null;
export function showGpuNotice(text, buttons = []) {
  if (typeof document === 'undefined') return;
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.setAttribute('role', 'alertdialog');
    noticeEl.setAttribute('lang', 'tr');
    noticeEl.style.cssText = 'position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(6,12,20,.72);pointer-events:auto;font:500 16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8eef5';
    document.body.append(noticeEl);
  }
  noticeEl.textContent = '';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:min(460px,calc(100vw - 32px));padding:22px 24px;border-radius:14px;background:#122033;border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 40px rgba(0,0,0,.45);text-align:center';
  const p = document.createElement('p');
  p.style.cssText = 'margin:0';
  p.textContent = text;
  card.append(p);
  if (buttons.length) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px';
    for (const [label, fn] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'font:inherit;padding:8px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:#1d3350;color:#fff;cursor:pointer';
      b.addEventListener('click', fn);
      row.append(b);
    }
    card.append(row);
  }
  noticeEl.append(card);
  noticeEl.style.display = 'flex';
}
export function hideGpuNotice() { if (noticeEl) noticeEl.style.display = 'none'; }

/**
 * createGpuGuard({ renderer, state, getQuality, onHalt, onStepDown })
 *   state        main.js game state (flight, world, cameraRig, choice, navRoute, readyAt …)
 *   getQuality   → the running (resolved) preset
 *   onHalt()     freeze the simulation + audio (the page is about to reload)
 *   onStepDown(id, reason)  apply the lower preset live (budget monitor); returns true when applied
 *   onInAppFailure(retry)   optional: a social-app webview lost the context — show its own screen and return true
 */
export function createGpuGuard({ renderer, state, getQuality, onHalt = () => {}, onStepDown = () => false, onInAppFailure = null }) {
  const canvas = renderer.domElement;
  const meter = attachGpuMeter(renderer.getContext());
  const textures = createTexturePolicy(renderer, getQuality);
  const t0 = performance.now();
  const gpuName = shortGpuName(renderer);   // read now: a lost context answers null
  let failing = false, restored = false, renderErrors = 0, lastRenderError = '';
  let acc = 0, snapAcc = 0, sweepAcc = 6, overFor = 0, lastStep = -1e9, budgetReported = false;
  const budgetOn = new URLSearchParams(location.search).get('gpubudget') !== '0';   // ?gpubudget=0: measure without the monitor

  function memory() {
    const s = meter.snapshot();
    const w = state.world;
    const city = w && w.layers ? w.layers.find((l) => l.stats && 'trees' in l.stats) : null;
    const heap = typeof performance !== 'undefined' && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined;
    return {
      ...s, heap,
      tt: w && w.terrain && w.terrain.stats ? w.terrain.stats.textures : undefined,
      cl: city ? city.stats.loaded : undefined,
      rel: Math.round(textures.stats.releasedMB), ds: textures.stats.downscaled,
      info: `${renderer.info.memory.geometries}g/${renderer.info.memory.textures}t`,
    };
  }
  function report(ev, extra = {}) {
    const q = getQuality() || {};
    const m = memory();
    trackEvent('gfx', {
      ev, q: q.id, pr: renderer.getPixelRatio().toFixed(2), gpu: gpuName, dev: deviceLabel(),
      mem: m.gpu, tex: m.tex, buf: m.buf, fb: m.fb, pk: m.peak, nt: m.nt, tt: m.tt, cl: m.cl, heap: m.heap, rel: m.rel,
      vw: state.cameraRig ? (state.cameraRig.view === 'cockpit' ? 'c' : 'e') : '', up: ((performance.now() - t0) / 60000).toFixed(1),
      ...extra,
    });
  }

  function reloadUrl(nextQ, pr) {
    const q = new URLSearchParams(location.search);
    const c = state.choice;
    if (c) {
      q.set('aircraft', c.aircraftId); q.set('spawn', c.spawnId);
      const w = state.world;
      const time = w && Number.isFinite(w.time) ? w.time : c.time;
      if (time != null) q.set('time', String(Math.round(time * 100) / 100));
      const wx = (w && w.weather && w.weather.preset) || c.weather;
      if (wx) q.set('weather', wx);
    }
    q.set('quality', nextQ);
    if (pr) q.set('pr', String(pr)); else q.delete('pr');
    if (state.flight && state.readyAt) q.set('resume', '1'); else q.delete('resume');
    return `${location.pathname}?${q}`;
  }

  /** Graphics failure: save the flight and reload one step lower (or offer buttons when that cannot help). */
  function fail(reason, detail = '') {
    if (failing) return;
    failing = true;
    try { onHalt(); } catch (e) { console.error(e); }
    const q = getQuality() || QUALITY.high;
    const n = addLoss();
    const pr = renderer.getPixelRatio();
    let nextQ = lowerQuality(q.id), nextPr = null;
    if (!nextQ) { nextQ = 'low'; nextPr = pr > SAFE_PR + 0.05 ? SAFE_PR : null; }
    const canRetry = n < MAX_LOSSES && (q.id !== 'low' || nextPr);
    const snap = state.flight && state.readyAt ? saveSnapshot(state, { alive: false, reason: 'gpu' }) : null;
    console.warn(`[gpu] ${reason}${detail ? ': ' + detail : ''} → ${canRetry ? `reload at ${nextQ}${nextPr ? ' pr ' + nextPr : ''}` : 'giving up'} (failure ${n} in 30 min)`);
    report(reason, { fails: n, next: canRetry ? nextQ : '', e: String(detail).slice(0, 80), snap: snap ? 1 : 0 });
    // mobile hook (docs/errors/audit.md #2): inside the X / Instagram webview a reload fails the same way — the caller
    // offers the real browser instead (src/ui/touch-gate.js) and keeps the reload as the small "Yeniden dene"
    if (onInAppFailure && onInAppFailure(() => { report('reload', { next: nextQ }); location.replace(reloadUrl(nextQ, nextPr)); })) return;
    if (canRetry) {
      setQualityCap(nextQ);   // later sessions on this device start no higher (cleared when the player raises it)
      showGpuNotice('Grafik belleği doldu, kalite düşürülerek devam ediliyor…');
      const url = reloadUrl(nextQ, nextPr);
      setTimeout(() => { report('reload', { next: nextQ }); location.replace(url); }, 1400);
    } else {
      showGpuNotice('Grafik belleği tekrar doldu. Bu cihazda oyun en düşük ayarda da zorlanıyor; tarayıcıdaki diğer sekmeleri kapatıp yeniden deneyebilirsin.', [
        ['Yeniden dene', () => location.replace(reloadUrl('low', SAFE_PR))],
        ['Menüye dön', () => { location.href = location.pathname; }],
      ]);
    }
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();          // (three.js does too) — keeps the page alive; we reload rather than restore in place
    meter.reset();
    fail('lost', e.statusMessage || '');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    restored = true;
    report('restored');
    if (!failing) fail('restored');   // restored before our handler ran (should not happen): the content is gone anyway
  }, false);

  // flight snapshot lifecycle: normal unload / bfcache → not a crash; back from bfcache → alive again
  // `closing`: once the page is being left, no later event may re-save the flight as alive. During a navigation
  // (e.g. "Ana menü") browsers fire visibilitychange AFTER pagehide; re-saving there made the menu page resume the flight.
  let closing = false;
  addEventListener('pagehide', () => { closing = true; if (!failing) markSnapshotClosed(); });
  addEventListener('pageshow', (e) => { if (e.persisted) { closing = false; markSnapshotAlive(); } });
  // a flight left in a background tab may be discarded by the browser: keep it resumable for longer
  document.addEventListener('visibilitychange', () => { if (!failing && !closing && state.flight && state.readyAt) saveSnapshot(state, { hidden: document.hidden }); });

  return {
    meter, textures,
    get failing() { return failing; },
    get restored() { return restored; },
    memory, report, fail,
    /** GLTFLoader plugin (downscale + release policy). */
    plugin: textures.plugin,
    /** Per frame (cheap): texture releases, budget monitor, periodic flight snapshot. */
    tick(dt) {
      if (failing) return;
      acc += dt; snapAcc += dt;
      if (snapAcc >= 5) { snapAcc = 0; if (!closing && state.flight && state.readyAt && !state.paused) saveSnapshot(state); }
      if (acc < 2) return;
      const span = acc;
      acc = 0;
      // WebKit sometimes drops the context without a webglcontextlost event (its GPU process died): notice it ourselves
      const gl = renderer.getContext();
      if (gl && gl.isContextLost && gl.isContextLost()) { fail('lost', 'silent'); return; }
      if ((sweepAcc += span) >= 8) { sweepAcc = 0; textures.sweep(state.scene); }
      const q = getQuality();
      if (!q || !state.readyAt || !q.gpuBudgetMB || !budgetOn) return;
      const mb = meter.bytes / 1048576;
      overFor = mb > q.gpuBudgetMB ? overFor + span : 0;
      if (overFor >= 6 && performance.now() - lastStep > 20000) {
        overFor = 0;
        const next = lowerQuality(q.id);
        if (next && onStepDown(next, 'budget')) {
          lastStep = performance.now();
          report('budget', { from: q.id, next, over: Math.round(mb - q.gpuBudgetMB) });
        } else if (!budgetReported) {
          budgetReported = true;
          report('budget', { next: '', over: Math.round(mb - q.gpuBudgetMB) });
        }
      }
    },
    /** renderer.render threw: a few in a row means nothing is being drawn → same recovery as a context loss. */
    renderFailed(e) {
      // a throw inside the shadow pass leaves the renderer bound to the shadow atlas: every later frame, even one that
      // completes, would draw there instead of the canvas
      try { renderer.setRenderTarget(null); } catch { /* ignore */ }
      renderErrors++;
      lastRenderError = (e && e.message) || String(e);
      if (renderErrors === 1) console.error('[gpu] render failed', e);
      if (renderErrors >= 30) fail('render', lastRenderError);
    },
    renderOk() { renderErrors = 0; },
  };
}
