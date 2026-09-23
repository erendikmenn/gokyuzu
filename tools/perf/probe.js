// In-page performance probe for the game (injected by tools/perf/lib.mjs with page.addInitScript before any game code).
// Plain browser script, no imports. Configure with window.__PERF_CFG = { gl: 'off'|'light'|'mem', clock: 'real'|'virtual' }
// set in the same init script before this file.
//
// Early hooks (from the first line of the page):
//   - requestAnimationFrame wrapper: CPU time spent in rAF callbacks per frame + frame intervals
//   - WebGL2 hooks: texture uploads (time, bytes, by source kind), buffer uploads, shader compile / link stalls
//     (time spent in getProgramParameter / getShaderParameter = synchronous waits for the driver), draw calls,
//     generateMipmap; with gl:'mem' also binding tracking → live GPU bytes per texture / buffer / renderbuffer
//   - long tasks (PerformanceObserver)
//   - optional virtual clock (performance.now / rAF timestamps advance 1/60 s per frame; freeze() stops time) so a
//     screenshot of a pose is reproducible (water, clouds, animations do not move)
// After the game is up, lib.mjs calls __perf.attach(): wraps the game's per-frame functions (world + each layer,
// renderer.render CPU, HUD, avionics, audio, camera, rig, flight) and adds EXT_disjoint_timer_query_webgl2 GPU timing
// around renderer.render with the shadow pass timed separately.
(() => {
  const cfg = Object.assign({ gl: 'light', clock: 'real' }, window.__PERF_CFG || {});
  const realNow = performance.now.bind(performance);
  const P = (window.__perf = {
    cfg,
    frames: [],            // { t, cpu, dt, sub: {name: ms}, gpu: ms|null, gpuShadow, up: {kind: ms}, upBytes, compileMs, draws }
    longTasks: [],
    counters: null,
    live: { tex: new Map(), buf: new Map(), rb: new Map() },
    sub: null,
    gpuEnabled: false,
    attached: false,
  });

  // ------------------------------------------------------------------ virtual clock
  let virt = realNow(), frozen = false, clockOn = cfg.clock === 'virtual';
  if (clockOn) {
    performance.now = () => virt;
    const RealDate = Date;
    // Date.now stays real (network/backoff code uses it rarely); only performance.now + rAF timestamps are virtual
    void RealDate;
  }
  P.freeze = (on = true) => { frozen = on; };
  P.realNow = realNow;

  // ------------------------------------------------------------------ per-frame accumulators
  const cur = () => P.cur || (P.cur = newFrame());
  function newFrame() { return { cpu: 0, sub: {}, up: {}, upBytes: 0, upCount: 0, compileMs: 0, linkCount: 0, draws: 0, instDraws: 0, mips: 0, gpu: null, gpuShadow: null, gpuParts: 0 }; }
  P.addSub = (name, ms) => { const f = cur(); f.sub[name] = (f.sub[name] || 0) + ms; };

  // ------------------------------------------------------------------ rAF wrapper
  const rawRAF = window.requestAnimationFrame.bind(window);
  let lastTs = -1, frameIdx = 0, lastFrameReal = realNow();
  let lastHeap = 0;
  const endFrame = (ts) => {
    const f = cur();
    const rn = realNow();
    if (cfg.heap && performance.memory) {   // per-frame heap delta: allocation rate (+) and GC drops (−)
      const h = performance.memory.usedJSHeapSize;
      if (lastHeap) f.heapDelta = h - lastHeap;
      lastHeap = h;
    }
    f.dt = rn - lastFrameReal;          // real wall time between frame starts
    lastFrameReal = rn;
    f.t = rn;
    f.i = frameIdx++;
    P.frames.push(f);
    if (P.frames.length > 20000) P.frames.splice(0, 5000);
    P.cur = newFrame();
    P.cur.i = frameIdx;
    if (P.onFrame) try { P.onFrame(f); } catch { /* ignore */ }
  };
  // hold(true) parks every rAF callback (the game loop stops: no CPU/GPU work) until hold(false); used to interleave
  // several pages / variants in one browser so they are measured under the same GPU contention
  P.held = [];
  P.hold = (on) => {
    P.holding = !!on;
    if (!on) { const h = P.held.splice(0); for (const cb of h) window.requestAnimationFrame(cb); }
  };
  window.requestAnimationFrame = (cb) => rawRAF((ts) => {
    if (P.holding) { P.held.push(cb); return; }
    if (ts !== lastTs) {
      if (lastTs >= 0) endFrame(ts);
      lastTs = ts;
      if (clockOn && !frozen) virt += 1000 / 60;
      if (P.gpuEnabled) pollQueries();
    }
    const t0 = realNow();
    try { cb(clockOn ? virt : ts); } finally { cur().cpu += realNow() - t0; }
  });

  // ------------------------------------------------------------------ long tasks
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push({ t: e.startTime, ms: e.duration, name: e.name });
      if (P.longTasks.length > 5000) P.longTasks.splice(0, 1000);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* not supported (WebKit) */ }

  // ------------------------------------------------------------------ WebGL hooks
  const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (G && cfg.gl !== 'off') {
    const wrap = (name, fn) => { const orig = G[name]; if (orig) G[name] = function (...a) { return fn.call(this, orig, a); }; };
    const kindOf = (s) => {
      if (!s || typeof s !== 'object') return 'data';
      if (ArrayBuffer.isView(s)) return 'data';
      const c = s.constructor && s.constructor.name;
      return c === 'HTMLCanvasElement' || c === 'OffscreenCanvas' ? 'canvas' : c === 'ImageBitmap' ? 'bitmap' : c === 'HTMLImageElement' ? 'image' : c === 'HTMLVideoElement' ? 'video' : c === 'ImageData' ? 'data' : 'other';
    };
    const up = (kind, ms, bytes) => { const f = cur(); f.up[kind] = (f.up[kind] || 0) + ms; f.upBytes += bytes || 0; f.upCount++; };
    // bytes per texel for sized internal formats three.js uses (others → 4)
    const BPP = { 0x8058: 4, 0x8C43: 4, 0x881A: 8, 0x8814: 16, 0x822F: 8, 0x822E: 4, 0x8230: 8, 0x8229: 1, 0x822B: 2, 0x8D62: 2, 0x8051: 3, 0x8C41: 3,
      0x81A5: 2, 0x81A6: 4, 0x8CAC: 4, 0x88F0: 4, 0x8CAD: 8, 0x8C3A: 4, 0x8C3D: 4, 0x8D70: 16, 0x8D7C: 4, 0x8D8E: 4, 0x8232: 2, 0x8231: 1, 0x8233: 2, 0x8234: 2, 0x8235: 4, 0x8236: 4, 0x8237: 2, 0x8238: 2, 0x8239: 4, 0x823A: 4, 0x823B: 4, 0x823C: 4, 0x822A: 2, 0x822C: 4, 0x822D: 2, 0x8D7D: 4,
      // block-compressed formats (bytes per texel): BC1/ETC2-RGB/EAC-R11 0.5, BC3/BC5/BC7/ETC2-RGBA/ASTC-4x4 1
      0x83F0: 0.5, 0x83F1: 0.5, 0x8C4C: 0.5, 0x8C4D: 0.5, 0x83F2: 1, 0x83F3: 1, 0x8C4E: 1, 0x8C4F: 1, 0x8E8C: 1, 0x8E8D: 1,
      0x8DBB: 0.5, 0x8DBD: 1, 0x9270: 0.5, 0x9272: 1, 0x9274: 0.5, 0x9275: 0.5, 0x9276: 0.5, 0x9277: 0.5, 0x9278: 1, 0x9279: 1,
      0x93B0: 1, 0x93D0: 1, 0x8D64: 0.5 };
    const texSize = (ifmt, w, h, d = 1) => w * h * d * (BPP[ifmt] || 4);

    // upload timing (all modes)
    wrap('texImage2D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      let w, h, src;
      if (a.length >= 8) { w = a[3]; h = a[4]; src = a[8]; } else { src = a[5]; w = src && (src.width || src.videoWidth); h = src && (src.height || src.videoHeight); }
      const bytes = (w || 0) * (h || 0) * 4;
      up(kindOf(src), ms, bytes);
      if (cfg.gl === 'mem') trackTexLevel(this, a[0], a[1], a[2], w, h, 1);
      return r;
    });
    wrap('texSubImage2D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      let w, h, src;
      if (a.length >= 9) { w = a[4]; h = a[5]; src = a[8]; } else { src = a[6]; w = src && (src.width || src.videoWidth); h = src && (src.height || src.videoHeight); }
      up(kindOf(src), ms, (w || 0) * (h || 0) * 4);
      return r;
    });
    wrap('texSubImage3D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const src = a[a.length - 1]; up(kindOf(src) + '3d', ms, (a[5] || 0) * (a[6] || 0) * (a[7] || 1) * 4); return r;
    });
    wrap('texImage3D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      up('data3d', ms, (a[3] || 0) * (a[4] || 0) * (a[5] || 1) * 4);
      if (cfg.gl === 'mem') trackTexLevel(this, a[0], a[1], a[2], a[3], a[4], a[5]);
      return r;
    });
    wrap('compressedTexImage2D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const data = a[6]; const bytes = data && data.byteLength ? data.byteLength : 0;
      up('compressed', ms, bytes);
      if (cfg.gl === 'mem') addTexBytes(this, a[0], a[1], bytes);
      return r;
    });
    wrap('compressedTexSubImage2D', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const data = a[7]; up('compressed', ms, data && data.byteLength ? data.byteLength : 0); return r;
    });
    wrap('generateMipmap', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const f = cur(); f.mips++; f.up.mipmap = (f.up.mipmap || 0) + ms;
      if (cfg.gl === 'mem') { const t = boundTex(this, a[0]); const e = t && P.live.tex.get(t); if (e && !e.mips) { e.mips = true; e.bytes = Math.round(e.bytes * 4 / 3); } }
      return r;
    });
    wrap('bufferData', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const bytes = typeof a[1] === 'number' ? a[1] : (a[1] && a[1].byteLength) || 0;
      up('buffer', ms, bytes);
      if (cfg.gl === 'mem') { const b = bufBind.get(a[0]); if (b) P.live.buf.set(b, bytes); }
      return r;
    });
    wrap('bufferSubData', function (orig, a) {
      const t0 = realNow(); const r = orig.apply(this, a); const ms = realNow() - t0;
      const src = a[2]; const bytes = a.length >= 5 && a[4] ? a[4] * (src.BYTES_PER_ELEMENT || 1) : (src && src.byteLength) || 0;
      up('bufferSub', ms, bytes);
      return r;
    });
    // shader compile / link: three.js calls compileShader + linkProgram (async in the driver) and later blocks in
    // getProgramParameter(LINK_STATUS) / getShaderParameter(COMPILE_STATUS) → the time spent there is the compile stall
    const stall = (orig, a, self) => { const t0 = realNow(); const r = orig.apply(self, a); const f = cur(); f.compileMs += realNow() - t0; return r; };
    wrap('getProgramParameter', function (orig, a) { return a[1] === 0x8B82 /* LINK_STATUS */ ? stall(orig, a, this) : orig.apply(this, a); });
    wrap('getShaderParameter', function (orig, a) { return a[1] === 0x8B81 /* COMPILE_STATUS */ ? stall(orig, a, this) : orig.apply(this, a); });
    wrap('getProgramInfoLog', function (orig, a) { return stall(orig, a, this); });
    wrap('linkProgram', function (orig, a) { const t0 = realNow(); const r = orig.apply(this, a); const f = cur(); f.linkCount++; f.compileMs += realNow() - t0; return r; });
    wrap('compileShader', function (orig, a) { const t0 = realNow(); const r = orig.apply(this, a); cur().compileMs += realNow() - t0; return r; });
    wrap('drawElements', function (orig, a) { cur().draws++; return orig.apply(this, a); });
    wrap('drawArrays', function (orig, a) { cur().draws++; return orig.apply(this, a); });
    wrap('drawElementsInstanced', function (orig, a) { const f = cur(); f.draws++; f.instDraws++; return orig.apply(this, a); });
    wrap('drawArraysInstanced', function (orig, a) { const f = cur(); f.draws++; f.instDraws++; return orig.apply(this, a); });

    // GPU memory tracking (gl: 'mem'): bindings → live bytes per object
    const texUnit = new WeakMap();       // gl -> active unit
    const texBind = new WeakMap();       // gl -> Map(unit*65536+target -> tex)
    const bufBind = new Map();           // target -> buffer (single context)
    const rbBind = { rb: null };
    const TARGET_OF = (t) => (t >= 0x8515 && t <= 0x851A ? 0x8513 : t);   // cube faces -> TEXTURE_CUBE_MAP
    function boundTex(gl, target) { const m = texBind.get(gl); return m && m.get((texUnit.get(gl) || 0x84C0) * 65536 + TARGET_OF(target)); }
    function trackTexLevel(gl, target, level, ifmt, w, h, d) {
      const t = boundTex(gl, target); if (!t) return;
      let e = P.live.tex.get(t); if (!e) P.live.tex.set(t, (e = { bytes: 0, w: 0, h: 0, fmt: ifmt, levels: {} }));
      const key = `${target}:${level}`; const b = texSize(ifmt, w || 0, h || 0, d || 1);
      e.bytes += b - (e.levels[key] || 0); e.levels[key] = b; if (level === 0) { e.w = w; e.h = h; e.fmt = ifmt; }
    }
    function addTexBytes(gl, target, level, bytes) {
      const t = boundTex(gl, target); if (!t) return;
      let e = P.live.tex.get(t); if (!e) P.live.tex.set(t, (e = { bytes: 0, w: 0, h: 0, fmt: 'compressed', levels: {} }));
      const key = `${target}:${level}`; e.bytes += bytes - (e.levels[key] || 0); e.levels[key] = bytes;
    }
    if (cfg.gl === 'mem') {
      wrap('activeTexture', function (orig, a) { texUnit.set(this, a[0]); return orig.apply(this, a); });
      wrap('bindTexture', function (orig, a) {
        let m = texBind.get(this); if (!m) texBind.set(this, (m = new Map()));
        m.set((texUnit.get(this) || 0x84C0) * 65536 + a[0], a[1]); return orig.apply(this, a);
      });
      wrap('texStorage2D', function (orig, a) {
        const t0 = realNow(); const r = orig.apply(this, a); up('storage', realNow() - t0, 0);
        const t = boundTex(this, a[0]); if (t) {
          const [target, levels, ifmt, w, h] = a; let bytes = 0;
          for (let l = 0; l < levels; l++) bytes += texSize(ifmt, Math.max(1, w >> l), Math.max(1, h >> l));
          if (target === 0x8513) bytes *= 6;
          P.live.tex.set(t, { bytes, w, h, fmt: ifmt, levels: {}, storage: true, mips: levels > 1 });
        }
        return r;
      });
      wrap('texStorage3D', function (orig, a) {
        const r = orig.apply(this, a); const t = boundTex(this, a[0]); if (t) {
          const [, levels, ifmt, w, h, d] = a; let bytes = 0;
          for (let l = 0; l < levels; l++) bytes += texSize(ifmt, Math.max(1, w >> l), Math.max(1, h >> l), a[0] === 0x8C1A ? d : Math.max(1, d >> l));
          P.live.tex.set(t, { bytes, w, h, d, fmt: ifmt, levels: {}, storage: true });
        }
        return r;
      });
      wrap('deleteTexture', function (orig, a) { P.live.tex.delete(a[0]); return orig.apply(this, a); });
      wrap('bindBuffer', function (orig, a) { bufBind.set(a[0], a[1]); return orig.apply(this, a); });
      wrap('deleteBuffer', function (orig, a) { P.live.buf.delete(a[0]); return orig.apply(this, a); });
      wrap('bindRenderbuffer', function (orig, a) { rbBind.rb = a[1]; return orig.apply(this, a); });
      wrap('renderbufferStorage', function (orig, a) { if (rbBind.rb) P.live.rb.set(rbBind.rb, texSize(a[1], a[2], a[3])); return orig.apply(this, a); });
      wrap('renderbufferStorageMultisample', function (orig, a) { if (rbBind.rb) P.live.rb.set(rbBind.rb, texSize(a[2], a[3], a[4]) * Math.max(1, a[1])); return orig.apply(this, a); });
      wrap('deleteRenderbuffer', function (orig, a) { P.live.rb.delete(a[0]); return orig.apply(this, a); });
    }
    P.gpuBytes = () => {
      let tex = 0, buf = 0, rb = 0;
      for (const e of P.live.tex.values()) tex += e.bytes;
      for (const b of P.live.buf.values()) buf += b;
      for (const b of P.live.rb.values()) rb += b;
      return { tex, buf, rb, texCount: P.live.tex.size, bufCount: P.live.buf.size };
    };
  }

  // ------------------------------------------------------------------ GPU timer queries (after attach)
  let tq = null, glc = null;
  const pending = [];   // { q, frame, kind }
  let activeQ = null;
  function beginQ(kind) {
    if (!tq || activeQ) return;
    const q = glc.createQuery(); glc.beginQuery(tq.TIME_ELAPSED_EXT, q);
    activeQ = { q, frame: cur(), kind };
  }
  function endQ() {
    if (!activeQ) return;
    glc.endQuery(tq.TIME_ELAPSED_EXT); pending.push(activeQ); activeQ = null;
  }
  function pollQueries() {
    if (!tq) return;
    const disjoint = glc.getParameter(tq.GPU_DISJOINT_EXT);
    while (pending.length) {
      const p = pending[0];
      if (!glc.getQueryParameter(p.q, glc.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      const ns = glc.getQueryParameter(p.q, glc.QUERY_RESULT);
      glc.deleteQuery(p.q);
      if (disjoint) { p.frame.gpuDisjoint = true; continue; }
      const ms = ns / 1e6;
      p.frame.gpu = (p.frame.gpu || 0) + ms;
      p.frame.gpuParts++;
      if (p.kind === 'shadow') p.frame.gpuShadow = (p.frame.gpuShadow || 0) + ms;
      if (p.kind === 'rt') p.frame.gpuRT = (p.frame.gpuRT || 0) + ms;
    }
    if (pending.length > 600) pending.splice(0, 300);
  }

  // ------------------------------------------------------------------ attach to the running game
  P.attach = ({ gpu = true, subs = true } = {}) => {
    const g = window.__game;
    if (!g || !g.renderer || P.attached) return P.attached;
    P.attached = true;
    const r = g.renderer;
    const timed = (obj, name, label) => {
      if (!obj || typeof obj[name] !== 'function' || obj[name].__perfWrapped) return;
      const f = obj[name];
      const w = function (...a) { const t0 = realNow(); try { return f.apply(this, a); } finally { P.addSub(label, realNow() - t0); } };
      w.__perfWrapped = true; w.__orig = f;
      obj[name] = w;
    };
    if (subs) {
      const w = g.world;
      timed(w.environment, 'update', 'world.env');
      timed(w.terrain, 'update', 'world.terrain');
      (w.layers || []).forEach((l) => timed(l, 'update', `world.${(l.object && l.object.name) || 'layer'}`));
      if (w.nightLights) timed(w.nightLights, 'update', 'world.nightLights');
      timed(w, 'update', 'world');
      timed(r, 'render', 'render');
      timed(g.hud, 'update', 'hud');
      timed(g.audio, 'update', 'audio');
      timed(g.cameraRig, 'update', 'camera');
      timed(g.navMap, 'update', 'navMap');
      timed(g.onboarding, 'update', 'onboarding');
      P.wrapPerAircraft = () => {
        const gg = window.__game;
        timed(gg.flight, 'step', 'flight');
        timed(gg.rig, 'update', 'rig');
        for (const d of gg.displays || []) timed(d.display, 'update', 'avionics');
      };
      P.wrapPerAircraft();
    }
    if (gpu) {
      glc = r.getContext();
      tq = glc.getExtension('EXT_disjoint_timer_query_webgl2');
      if (tq) {
        P.gpuEnabled = true;
        const render = r.render;
        r.render = function (scene, camera) {
          const kind = r.getRenderTarget() ? 'rt' : 'main';
          beginQ(kind);
          try { return render.call(this, scene, camera); } finally { endQ(); }
        };
        const sm = r.shadowMap, smr = sm.render;
        sm.render = function (...a) {
          const had = activeQ && activeQ.kind;
          endQ(); beginQ('shadow');
          try { return smr.apply(this, a); } finally { endQ(); if (had) beginQ(had); }
        };
      }
    }
    return true;
  };

  // ------------------------------------------------------------------ summaries
  const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  P.mark = () => { P.markIdx = P.frames.length; P.markLT = P.longTasks.length; P.markT = realNow(); };
  P.summary = () => {
    const fr = P.frames.slice(P.markIdx || 0).filter((f) => f.dt > 0);
    const dts = fr.map((f) => f.dt), cpu = fr.map((f) => f.cpu);
    const gpuF = fr.filter((f) => f.gpu != null && !f.gpuDisjoint);
    const gpu = gpuF.map((f) => f.gpu), sh = gpuF.map((f) => f.gpuShadow || 0);
    const subs = {}, ups = {};
    for (const f of fr) {
      for (const [k, v] of Object.entries(f.sub)) (subs[k] || (subs[k] = [])).push(v);
      for (const [k, v] of Object.entries(f.up)) ups[k] = (ups[k] || 0) + v;
    }
    const subMean = {}, subP95 = {};
    for (const [k, v] of Object.entries(subs)) { while (v.length < fr.length) v.push(0); subMean[k] = r2(mean(v)); subP95[k] = r2(pct(v, 0.95)); }
    for (const k of Object.keys(ups)) ups[k] = r2(ups[k] / Math.max(1, fr.length));
    const secs = fr.length ? (fr[fr.length - 1].t - fr[0].t + fr[0].dt) / 1000 : 0;
    const lts = P.longTasks.slice(P.markLT || 0);
    const r = window.__game && window.__game.renderer;
    return {
      frames: fr.length, secs: r2(secs), fps: r2(fr.length / Math.max(secs, 1e-3)),
      frameMs: { mean: r2(mean(dts)), p50: r2(pct(dts, 0.5)), p95: r2(pct(dts, 0.95)), p99: r2(pct(dts, 0.99)), max: r2(Math.max(0, ...dts)) },
      cpuMs: { mean: r2(mean(cpu)), p50: r2(pct(cpu, 0.5)), p95: r2(pct(cpu, 0.95)), p99: r2(pct(cpu, 0.99)), max: r2(Math.max(0, ...cpu)) },
      gpuMs: gpu.length ? { mean: r2(mean(gpu)), p10: r2(pct(gpu, 0.1)), p50: r2(pct(gpu, 0.5)), p95: r2(pct(gpu, 0.95)), max: r2(Math.max(...gpu)), shadowMean: r2(mean(sh)), shadowP10: r2(pct(sh, 0.1)), samples: gpu.length } : null,
      hitches: { over33: dts.filter((d) => d > 33.4).length, over50: dts.filter((d) => d > 50).length, over100: dts.filter((d) => d > 100).length },
      subMean, subP95, uploadMsPerFrame: ups,
      uploadMBPerSec: r2(fr.reduce((a, f) => a + f.upBytes, 0) / 1048576 / Math.max(secs, 1e-3)),
      compileMs: r2(fr.reduce((a, f) => a + f.compileMs, 0)), links: fr.reduce((a, f) => a + f.linkCount, 0),
      mipmapsPerSec: r2(fr.reduce((a, f) => a + f.mips, 0) / Math.max(secs, 1e-3)),
      glDraws: r2(mean(fr.map((f) => f.draws))), glInstancedDraws: r2(mean(fr.map((f) => f.instDraws))),
      longTasks: { count: lts.length, totalMs: Math.round(lts.reduce((a, l) => a + l.ms, 0)), max: Math.round(Math.max(0, ...lts.map((l) => l.ms))) },
      info: r ? { calls: r.info.render.calls, triangles: r.info.render.triangles, points: r.info.render.points, lines: r.info.render.lines, programs: r.info.programs ? r.info.programs.length : null, textures: r.info.memory.textures, geometries: r.info.memory.geometries, pixelRatio: r.getPixelRatio(), size: [r.domElement.width, r.domElement.height] } : null,
      heapMB: performance.memory ? r2(performance.memory.usedJSHeapSize / 1048576) : null,
      alloc: cfg.heap ? (() => {
        const d = fr.map((f) => f.heapDelta).filter((x) => x != null);
        const pos = d.filter((x) => x > 0), neg = d.filter((x) => x < -65536);
        return { MBperSec: r2(pos.reduce((a, b) => a + b, 0) / 1048576 / Math.max(secs, 1e-3)), KBperFrame: r2(mean(pos.length ? d.map((x) => Math.max(0, x)) : [0]) / 1024), gcDrops: neg.length, freedMB: r2(-neg.reduce((a, b) => a + b, 0) / 1048576) };
      })() : null,
      gpuBytesMB: P.gpuBytes ? Object.fromEntries(Object.entries(P.gpuBytes()).map(([k, v]) => [k, /Count/.test(k) ? v : r2(v / 1048576)])) : null,
    };
  };
  /** Worst frames since mark(): their CPU sub-breakdown, uploads and compile time (for hitch attribution). */
  P.worst = (n = 10) => P.frames.slice(P.markIdx || 0).filter((f) => f.dt > 0).sort((a, b) => b.dt - a.dt).slice(0, n)
    .map((f) => ({ dt: r2(f.dt), cpu: r2(f.cpu), gpu: r2(f.gpu), compileMs: r2(f.compileMs), links: f.linkCount, upMB: r2(f.upBytes / 1048576), up: Object.fromEntries(Object.entries(f.up).map(([k, v]) => [k, r2(v)])), sub: Object.fromEntries(Object.entries(f.sub).map(([k, v]) => [k, r2(v)])) }));
})();
