// Gökyüzü SF audio system (AU). Web Audio mixer for the offline-synthesised sound set in assets/audio/.
//
// Graph (per aircraft instance):
//   loop source → [lowpass] → layer gain ─┬─ ext send → emitter: airLP → distance → DELAY(retarded time ⇒ doppler)
//                                         │                      → teleport-dip → mach-cone gate → panner → extBus ┐
//                                         └─ int send → (engine: stereo pan → intEngine → cockpit LP²) | intDirect → intBus ├→ mix → pause duck → mute
//   voices / chimes → alertBus ─────────────────────────────────────────────────────────────────────────────────────┤   → glue comp → limiter → out
//   ui clicks → uiBus ─────────────────────────────────────────────────────────────────────────────────────────────────┘
// Exterior: per-emitter directivity (fan tones forward, jet roar aft), 1/r attenuation, air absorption, a delay line
// driven by the *retarded* distance (so doppler, propagation delay and flyby timing are physical), panning from the
// retarded position, Mach-cone gating + sonic boom. Interior: per-layer cockpit sends, muffled engine path.
import * as THREE from 'three';
import { band, clamp, db, sstep } from './util.js';
import { approachGeometry, findApproach } from '../flight/fixedwing-autopilot.js';
import { detectDevice } from '../core/gpu-device.js';   // mobile hook: staged decoding on phones / tablets
import { activeMap } from '../maps/index.js';

const isMobile = () => { try { const d = detectDevice(); return d.kind === 'phone' || d.kind === 'tablet'; } catch { return false; } };

const ASSET_BASE = new URL('../../assets/audio/', import.meta.url).href;
const C_SOUND = 343;
const MAX_DELAY = 12;          // s of propagation delay (≈4 km); farther sources are inaudible anyway
const FT = 3.28084;
const HIST = 2048;          // aircraft position history (ring buffer) for retarded-time lookups
const TARGET_LUFS = -20;    // loops are mastered to this; the manifest corrects files that were peak-limited
const TRACE_MAX = 600;

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? +v : d);

export function createAudioSystem({ camera: defaultCamera } = {}) {
  let ctx = null;
  let G = null;
  let inst = null;
  let started = false;
  let userPaused = false;
  let loadSeq = 0;
  const bufCache = new Map();
  let manifest = null;
  let manifestP = null;
  const warned = new Set();
  // alert trace (test hook): every voice / tone / alert loop start and stop, newest last
  const trace = [];
  const traceAdd = (kind, id, extra) => {
    const e = { t: ctx ? +ctx.currentTime.toFixed(3) : 0, kind, id, ...(extra || {}) };
    trace.push(e);
    if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
  };
  let runways = null, runwaysP = null;
  const loadRunways = () => {
    // ILS geometry for EGPWS mode 5: the active map's runways (src/maps/index.js)
    if (!runwaysP) runwaysP = fetch(new URL(`../../${activeMap().data}runways.json`, import.meta.url).href).then((r) => (r.ok ? r.json() : null)).then((j) => { runways = j; }).catch(() => {});
    return runwaysP;
  };
  // scratch objects (no per-frame allocation)
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vCam = new THREE.Vector3();
  const vFwd = new THREE.Vector3(), vVel = new THREE.Vector3(), vCamVel = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const mCamInv = new THREE.Matrix4();
  const prevCam = new THREE.Vector3();
  let prevCamValid = false;

  // user volume categories (0..1): master, engine (engines/rotors), voice (callouts + alert tones), atc, ambient
  const vol = { master: 1, engine: 1, voice: 1, atc: 1, ambient: 1 };
  const ENGINE_LAYER = /^(whine|roar|ab|rumble|fan|buzzsaw|jet|reverse|apu|rotor|slap|tail|turbine|gearbox)/;
  const ENGINE_SHOT = /^(abLightoff|abOut|reverser)$/;
  const warnOnce = (k, ...a) => { if (!warned.has(k)) { warned.add(k); console.warn('[audio]', ...a); } };

  // ------------------------------------------------------------------------------------------------ context
  // The real AudioContext is only created once the page has seen a user gesture (autoplay policy: no console
  // warning, no suspended context). Decoding happens earlier on an OfflineAudioContext, so loading never waits.
  let gestureHooked = false;
  let pending = null;          // { id, profile } loaded before the context existed
  const hasGesture = () => { const ua = typeof navigator !== 'undefined' && navigator.userActivation; return !ua || ua.hasBeenActive; };
  function hookGesture() {
    if (gestureHooked) return;
    gestureHooked = true;
    const go = () => {
      if (ctx) return;
      if (!ensureContext()) return;
      if (pending && !inst) { inst = buildInstance(pending.id, pending.profile); pending = null; }
      if (started) start();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, go, { passive: true, capture: true });
  }
  let decodeCtx = null;
  function decoder() {
    if (ctx) return ctx;
    if (!decodeCtx) {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      decodeCtx = OAC ? new OAC(1, 1, 48000) : null;
    }
    return decodeCtx;
  }

  function ensureContext() {
    if (ctx) return ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { warnOnce('noac', 'Web Audio unavailable'); return null; }
    if (!hasGesture()) { hookGesture(); return null; }
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { warnOnce('acfail', 'AudioContext failed', e); return null; }
    G = {};
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    G.out = g(0);
    G.limiter = ctx.createDynamicsCompressor();
    Object.assign(G.limiter, {});
    // NB: DynamicsCompressorNode applies an automatic, static make-up gain (≈ +3.5 dB for these settings);
    // the mix gain below is calibrated with it (tools/audio/probe.mjs level matrix).
    G.limiter.threshold.value = -2; G.limiter.knee.value = 0; G.limiter.ratio.value = 20;
    G.limiter.attack.value = 0.002; G.limiter.release.value = 0.12;
    G.glue = ctx.createDynamicsCompressor();
    G.glue.threshold.value = -14; G.glue.knee.value = 14; G.glue.ratio.value = 2;
    G.glue.attack.value = 0.015; G.glue.release.value = 0.35;
    G.mute = g(api.muted ? 0 : 1);
    G.duck = g(1);
    G.mix = g(db(0));
    G.analyser = ctx.createAnalyser();
    G.analyser.fftSize = 4096;
    G.hp = ctx.createBiquadFilter(); G.hp.type = 'highpass'; G.hp.frequency.value = 22; G.hp.Q.value = 0.7;
    G.vol = g(vol.master * vol.master);                       // user master volume (squared = perceptual taper)
    G.mix.connect(G.hp).connect(G.duck).connect(G.mute).connect(G.glue).connect(G.limiter).connect(G.out).connect(G.vol).connect(ctx.destination);
    G.out.connect(G.analyser);
    G.ext = g(0); G.ext.connect(G.mix);
    G.int = g(1); G.int.connect(G.mix);
    G.intEng = g(1);
    G.intLP = ctx.createBiquadFilter(); G.intLP.type = 'lowpass'; G.intLP.frequency.value = 1200; G.intLP.Q.value = 0.5;
    G.intLP2 = ctx.createBiquadFilter(); G.intLP2.type = 'lowpass'; G.intLP2.frequency.value = 2400; G.intLP2.Q.value = 0.5;
    G.intEng.connect(G.intLP).connect(G.intLP2).connect(G.int);
    G.intDirect = g(1); G.intDirect.connect(G.int);
    G.alert = g(1); G.alert.connect(G.mix);
    G.ui = g(0.8); G.ui.connect(G.mix);
    G.atc = g(vol.atc * vol.atc); G.atc.connect(G.mix);        // for radio/ATC audio of other modules (api.atcInput)
    const resume = () => { if (ctx && started && !document.hidden && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, resume, { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend().catch(() => {}); else resume();
    });
    return ctx;
  }

  function start() {
    started = true;
    if (!ensureContext()) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    G.out.gain.cancelScheduledValues(t);
    G.out.gain.setValueAtTime(G.out.gain.value, t);
    G.out.gain.setTargetAtTime(0.89, t + 0.05, 0.35);
  }

  function setMuted(m) {
    api.muted = !!m;
    if (G) G.mute.gain.setTargetAtTime(api.muted ? 0 : 1, ctx.currentTime, 0.05);
  }

  function setPaused(p) {
    userPaused = !!p;
    if (!G) return;
    G.duck.gain.setTargetAtTime(userPaused ? 0 : 1, ctx.currentTime, userPaused ? 0.08 : 0.2);
    if (userPaused && inst) stopVoice();
  }

  // ------------------------------------------------------------------------------------------------ loading
  function loadManifest() {
    if (!manifestP) {
      // always revalidate the manifest: it carries the per-file content hashes used to bust browser caches
      manifestP = fetch(ASSET_BASE + 'manifest.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        .then((m) => { manifest = m || {}; return manifest; });
    }
    return manifestP;
  }

  function decode(ab) {
    const dc = decoder();
    if (!dc) return Promise.reject(new Error('no decoder'));
    return new Promise((res, rej) => {
      const p = dc.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  // Delivery format: AAC/M4A (≈8× smaller; decodeAudioData in Safari/Chrome/Firefox trims the encoder priming) when
  // the browser can play it and the manifest lists it, else the WAV master. Loops are encoded with 0.1 s of
  // wrap-around guard material and played through loopStart/loopEnd, which keeps them gapless.
  let m4aOK = null;
  function canM4A() {
    if (m4aOK === null) {
      try { m4aOK = !!(typeof Audio !== 'undefined' && new Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"')); } catch { m4aOK = false; }
    }
    return m4aOK;
  }
  const fetchDecode = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(decode);

  function getBuffer(rel) {
    if (!rel) return Promise.resolve(null);
    if (!bufCache.has(rel)) {
      const p = loadManifest().then((man) => {
        const m = man && man[rel];
        // ?v=<content hash> (added to the manifest by the publish build) makes browsers fetch changed sounds anew
        const ver = (ext) => (m && m.h && m.h[ext] ? `?v=${m.h[ext]}` : '');
        const wav = () => fetchDecode(ASSET_BASE + rel + '.wav' + ver('wav'));
        if (m && m.m4a && canM4A()) {
          return fetchDecode(ASSET_BASE + rel + '.m4a' + ver('m4a')).then((buf) => {
            if (typeof m.loopStart === 'number' && typeof m.loopDur === 'number') buf.__loop = { start: m.loopStart, dur: m.loopDur };
            return buf;
          }, () => wav());
        }
        return wav();
      }).catch((e) => { warnOnce('f:' + rel, `sound ${rel} unavailable (${e.message || e})`); return null; });
      bufCache.set(rel, p);
    }
    return bufCache.get(rel);
  }

  function normFor(rel, loop) {
    const m = manifest && manifest[rel];
    if (!m || !loop || typeof m.lufs !== 'number') return 1;
    return db(clamp(TARGET_LUFS - m.lufs, -6, 6));
  }

  function collectFiles(p) {
    const s = new Set();
    for (const l of p.layers || []) s.add(l.file);
    for (const f of Object.values(p.shots || {})) s.add(f);
    const a = p.alerts || {};
    for (const r of a.rules || []) { if (r.voice) s.add(r.voice); if (r.loop) s.add(r.loop); }
    for (const c of a.callouts || []) s.add(c.voice);
    for (const k of ['chime', 'apDisconnect', 'apDisconnectLoop', 'apButton', 'altAlert', 'retard']) if (a[k]) s.add(a[k]);
    for (const mk of a.systems || []) {
      const sys = mk();
      for (const f of sys.files || []) s.add(f);
      for (const L of Object.values(sys.loops || {})) s.add(L.file);
    }
    s.delete(undefined); s.delete(null);
    return [...s];
  }

  async function loadAircraft(id) {
    const seq = ++loadSeq;
    if (typeof window === 'undefined' || !(window.AudioContext || window.webkitAudioContext)) return;
    ensureContext();
    let profile;
    try {
      profile = (await import(`./profiles/${id}.js`)).default;
    } catch (e) {
      warnOnce('p:' + id, `no sound profile for "${id}"`, e);
      if (seq === loadSeq) teardown();
      return;
    }
    if (seq !== loadSeq) return;
    teardown();
    const mf = loadManifest();
    if (profile.alerts?.systems?.length) loadRunways();
    const files = collectFiles(profile);
    // mobile hook (docs/errors/audit.md #1): phones / tablets decode the aircraft's own engine / rotor loops first, the
    // shared layers (wind, gear, brakes…) 5 s later and alerts / callouts / one-shots from 10 s on, one at a time
    // (they are also fetched on demand when played), so the decoded PCM does not land in the post-ready memory peak
    let loads;
    if (!isMobile()) loads = files.map(getBuffer);
    else {
      const layerFiles = new Set((profile.layers || []).map((l) => l.file));
      const own = files.filter((f) => layerFiles.has(f) && !/^common\//.test(f));
      const shared = files.filter((f) => layerFiles.has(f) && /^common\//.test(f));
      const rest = files.filter((f) => !layerFiles.has(f));
      loads = own.map(getBuffer);
      const later = (list, ms) => setTimeout(async () => { for (const f of list) { if (seq !== loadSeq) return; await getBuffer(f); } }, ms);
      later(shared, 5000);
      later(rest, 10000);
    }
    await mf;
    if (seq !== loadSeq) return;
    if (ctx) inst = buildInstance(id, profile);
    else { pending = { id, profile }; hookGesture(); }
    // resolve when everything is decoded, but never hold the loading screen for more than 1.5 s: sources attach
    // themselves as soon as their buffer arrives
    await Promise.race([Promise.allSettled(loads), new Promise((r) => setTimeout(r, 1500))]);
  }

  // ------------------------------------------------------------------------------------------------ graph
  function gainNode(v = 0) { const n = ctx.createGain(); n.gain.value = v; return n; }

  function makeEmitter(name, d) {
    const em = {
      name, def: d, ref: d.ref ?? 30, offset: new THREE.Vector3().fromArray(d.offset || [0, 0, 0]), resolvedFor: null,
      in: gainNode(1), inJet: gainNode(1), lp: ctx.createBiquadFilter(), aft: ctx.createBiquadFilter(), dist: gainNode(0), delay: ctx.createDelay(MAX_DELAY), post: gainNode(1),
      cone: gainNode(1), pan: ctx.createPanner(), intIn: gainNode(1), intPan: null,
      tau: 0, delayCur: 0, prevTau: 0, freezeUntil: 0, d: 0, cos: 1, world: new THREE.Vector3(), retarded: new THREE.Vector3(),
      last: {},
    };
    em.lp.type = 'lowpass'; em.lp.Q.value = 0.55; em.lp.frequency.value = 20000;
    em.aft.type = 'highshelf'; em.aft.frequency.value = 1500; em.aft.gain.value = 0;
    const p = em.pan;
    p.panningModel = 'equalpower'; p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 1e5; p.rolloffFactor = 0;
    em.inJet.connect(em.aft).connect(em.lp);           // jet-mixing layers: darker near the jet axis
    em.in.connect(em.lp).connect(em.dist).connect(em.delay).connect(em.post).connect(em.cone).connect(em.pan).connect(G.ext);
    // ground reflection (image source): a second, slightly later arrival → the sweeping comb 'flanger' of a flyby
    em.refl = ctx.createDelay(0.25); em.refl.delayTime.value = 0.01;
    em.reflLP = ctx.createBiquadFilter(); em.reflLP.type = 'lowpass'; em.reflLP.frequency.value = 1800; em.reflLP.Q.value = 0.5;
    em.reflG = gainNode(0);
    em.post.connect(em.refl).connect(em.reflLP).connect(em.reflG).connect(em.cone);
    em.turb = 0; em.turbTarget = 0; em.turbNext = 0;
    if (ctx.createStereoPanner && d.intPan) {
      em.intPan = ctx.createStereoPanner(); em.intPan.pan.value = d.intPan;
      em.intIn.connect(em.intPan).connect(G.intEng);
    } else em.intIn.connect(G.intEng);
    return em;
  }

  function buildInstance(id, profile) {
    const I = {
      id, profile, dir: id, emitters: {}, layers: [], alertLoops: {}, nodes: [], timers: [], ruleState: {}, co: {},
      voice: null, queue: [], shots: [], s: makeState(profile), P: null, idleN1: null, fuel0: 0, hist: new Float64Array(HIST * 4),
      histN: 0, histHead: 0, lastT: 0, crashT: -99, boomT: -99, touchT: -99, noseDone: true, bumpDist: 0, vsAir: 0,
      gearSimEnd: 0, flapSimEnd: 0, canopySimEnd: 0, gearMov: false, gearMoveT: -9, flapT: -9, canopyT: -9,
      retardNext: 0, firstUpdate: true, apOn: null, lights: null, last: {},
      systems: [], sysLoops: {}, ended: {}, graceUntil: 0, fcuValid: false,
    };
    for (const [name, d] of Object.entries(profile.emitters || { air: { offset: [0, 0, 0] } })) I.emitters[name] = makeEmitter(name, d);
    if (!I.emitters.air) I.emitters.air = makeEmitter('air', { offset: [0, 0, 0], ref: 25 });
    const nE = Math.max(1, profile.engines || 1);
    for (const def of profile.layers || []) {
      if (def.perEngine) for (let i = 0; i < nE; i++) addLayer(I, def, i);
      else addLayer(I, def, -1);
    }
    for (const mk of profile.alerts?.systems || []) {
      const sys = mk();
      I.systems.push(sys);
      for (const [lid, def] of Object.entries(sys.loops || {})) {
        const id = `${sys.name}:${lid}`;
        const L = { id: 'alert:' + id, def: { file: def.file }, g: gainNode(0), src: null, last: {}, norm: 1, db: def.db ?? 0, on: false };
        L.g.connect(G.alert);
        L.input = L.g;
        attachLoop(I, L);
        I.sysLoops[id] = L;
      }
    }
    for (const r of profile.alerts?.rules || []) {
      if (!r.loop) continue;
      const L = { id: 'alert:' + r.id, def: { file: r.loop }, g: gainNode(0), src: null, last: {}, norm: 1 };
      L.g.connect(G.alert);
      L.input = L.g;
      attachLoop(I, L);
      I.alertLoops[r.id] = L;
    }
    return I;
  }

  function emitterFor(I, def, ei) {
    const name = def.emitter;
    if (!name) return null;
    return (ei >= 0 && I.emitters[`${name}${ei + 1}`]) || I.emitters[name] || I.emitters[`${name}1`] || I.emitters.air;
  }

  function addLayer(I, def, ei) {
    const em = emitterFor(I, def, ei);
    const L = { id: def.id + (ei >= 0 ? `#${ei + 1}` : ''), def, ei, em, src: null, f: null, g: gainNode(0), ext: null, int: null, last: {}, norm: 1,
      cat: def.cat || (ENGINE_LAYER.test(def.id) ? 'engine' : 'ambient') };
    if (def.lp) {
      L.f = ctx.createBiquadFilter(); L.f.type = 'lowpass'; L.f.Q.value = def.lpQ ?? 0.6; L.f.frequency.value = 8000;
      L.f.connect(L.g);
    }
    L.input = L.f || L.g;
    if (def.ext && em) { L.ext = gainNode(0); L.g.connect(L.ext).connect(def.dir === 'rear' ? em.inJet : em.in); }
    if (def.int) {
      L.int = gainNode(0);
      L.g.connect(L.int).connect(def.intPath === 'direct' || !em ? G.intDirect : em.intIn);
    }
    attachLoop(I, L);
    I.layers.push(L);
  }

  function attachLoop(I, L) {
    // mobile hook (see loadAircraft): shared layers join after 5 s, alert / warning loops after 10 s
    const wait = !isMobile() ? 0 : String(L.id || '').startsWith('alert:') ? 10000 : /^common\//.test(L.def.file || '') ? 5000 : 0;
    if (wait) { setTimeout(() => { if (inst === I && !I.dead) attachLoopNow(I, L); }, wait); return; }
    attachLoopNow(I, L);
  }
  function attachLoopNow(I, L) {
    getBuffer(L.def.file).then((buf) => {
      if (!buf || inst !== I || I.dead) return;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      let start = Math.random() * buf.duration * 0.999;
      if (buf.__loop) {            // compressed loop: play the periodic window between the guards
        src.loopStart = buf.__loop.start; src.loopEnd = buf.__loop.start + buf.__loop.dur;
        start = buf.__loop.start + Math.random() * buf.__loop.dur * 0.999;
      }
      // buffers may arrive seconds after the layer is running (the game no longer waits for audio): fade in
      const fadeIn = gainNode(0);
      src.connect(fadeIn).connect(L.input);
      const t = ctx.currentTime + 0.02;
      fadeIn.gain.setValueAtTime(0, t); fadeIn.gain.setTargetAtTime(1, t, 0.12);
      src.start(t, start);
      L.src = src;
      L.norm = normFor(L.def.file, true);
      L.last.rate = undefined;
    });
  }

  function teardown() {
    const I = inst;
    inst = null;
    pending = null;
    if (!I || !ctx) return;
    I.dead = true;
    const t = ctx.currentTime;
    const all = [...I.layers, ...Object.values(I.alertLoops), ...Object.values(I.sysLoops)];
    for (const L of all) {
      try { L.g.gain.setTargetAtTime(0, t, 0.05); } catch { /* */ }
      if (L.src) try { L.src.stop(t + 0.3); } catch { /* */ }
    }
    stopVoice(I);
    stopApDisc(I);
    setTimeout(() => {
      for (const L of all) { try { L.g.disconnect(); L.src && L.src.disconnect(); L.f && L.f.disconnect(); L.ext && L.ext.disconnect(); L.int && L.int.disconnect(); } catch { /* */ } }
      for (const em of Object.values(I.emitters)) { try { em.pan.disconnect(); em.intIn.disconnect(); em.intPan && em.intPan.disconnect(); } catch { /* */ } }
    }, 500);
  }

  // ------------------------------------------------------------------------------------------------ state
  function makeState(profile) {
    const nE = Math.max(1, profile.engines || 1);
    return {
      cockpit: false, view: 'exterior', t: 0, dt: 0,
      eng: Array.from({ length: nE }, (_, i) => ({ i, n1: 0, n1s: 0, pow: 0, ab: 0, rev: 0, on: 0 })),
      n1: 0, n1s: 0, pow: 0, ab: 0, rev: 0, thr: 0, tas: 0, ias: 0, mach: 0, qn: 0, gs: 0, vs: 0, agl: 1e4, g: 1,
      onGround: 0, gear: 1, flaps: 0, flapsIndex: 0, flapsCount: 0, spoilers: 0, speedbrake: 0, brakes: 0, canopy: 0,
      gearMoving: 0, flapMoving: 0, canopyMoving: 0, rotor: 0, collective: 0, torque: 0, stalled: false, dead: false,
      w: { stall: false, overspeed: false, gear: false, bank: false, sinkRate: false, pullUp: false },
      wHas: {},
      fuelFrac: 1, rotorLow: false, vrs: false, overtorque: false, pitch: 0,
    };
  }

  function deriveState(I, dt, f, opts, vis) {
    const s = I.s;
    const p = I.profile;
    s.dt = dt; s.t = ctx.currentTime;
    s.view = opts.view === 'cockpit' ? 'cockpit' : 'exterior';
    s.cockpit = s.view === 'cockpit';
    s.dead = !!f.crashed || !!f.crashCause;        // crashCause ('stall' | 'lowspeed' | 'collective') comes with the crash
    s.thr = clamp(num(f.throttle));
    const engs = Array.isArray(f.engines) ? f.engines : null;
    const visE = vis && Array.isArray(vis.engines) ? vis.engines : null;
    if (I.idleN1 == null) I.idleN1 = num(f.spec?.engine?.n1Idle, num(f.spec?.idleN1, p.idleN1 ?? 0.22));
    const k = 1 - Math.exp(-dt / 0.1);
    let n1Sum = 0, n1sSum = 0, powSum = 0, abMax = 0, revMax = 0;
    const revAll = clamp(num(f.reverser));
    for (const e of s.eng) {
      const src = engs ? (engs[e.i] ?? engs[0]) : null;
      let raw = src ? num(src.n1, NaN) : NaN;
      if (!Number.isFinite(raw)) raw = visE ? num((visE[e.i] ?? visE[0])?.n1, NaN) : NaN;
      if (!Number.isFinite(raw)) raw = 0.2 + 0.8 * s.thr;
      if (raw > 1.5) raw /= 100;                                   // percent → fraction
      if (s.dead) raw = 0;
      const prev = e.n1;
      e.n1 += (raw - e.n1) * k;
      // adapt the idle estimate to whatever the flight model reports at idle throttle
      if (e.i === 0 && p.category !== 'helicopter' && s.thr < 0.02 && raw > 0.08 && Math.abs(e.n1 - prev) < 0.02 * dt && !s.dead) {
        I.idleN1 += (e.n1 - I.idleN1) * Math.min(1, dt / 2);
      }
      const idle = clamp(I.idleN1, 0.05, 0.9);
      const ref0 = p.idleRef ?? 0.25;
      if (e.n1 >= idle) {
        e.pow = Math.min(1.15, (e.n1 - idle) / (1 - idle));
        e.n1s = ref0 + (1 - ref0) * e.pow;
      } else {
        e.pow = 0;
        e.n1s = ref0 * e.n1 / idle;
      }
      e.on = s.dead ? 0 : sstep(0.03, 0.7, e.n1 / idle);
      let ab = src ? num(src.afterburner, 0) : 0;
      if (!ab && visE) ab = num((visE[e.i] ?? visE[0])?.afterburner, 0);
      e.ab = s.dead ? 0 : clamp(ab);
      let rev = visE ? num((visE[e.i] ?? visE[0])?.reverser, revAll) : revAll;
      e.rev = clamp(Math.max(rev, revAll));
      n1Sum += e.n1; n1sSum += e.n1s; powSum += e.pow; abMax = Math.max(abMax, e.ab); revMax = Math.max(revMax, e.rev);
    }
    const nE = s.eng.length;
    s.n1 = n1Sum / nE; s.n1s = n1sSum / nE; s.pow = powSum / nE; s.ab = abMax; s.rev = revMax;
    s.tas = Math.max(0, num(f.airspeed));
    s.ias = Math.max(0, num(f.ias, s.tas));
    s.mach = Math.max(0, num(f.mach, s.tas / 340));
    s.qn = Math.pow(s.ias / 150, 2);
    const vel = f.velocity;
    if (vel && typeof vel.x === 'number') { s.gs = Math.hypot(vel.x, vel.z); s.vs = num(f.verticalSpeed, vel.y); }
    else { s.gs = s.tas; s.vs = num(f.verticalSpeed); }
    s.agl = num(f.agl, num(f.altitude, 1e4));
    s.g = num(f.gForce, 1);
    s.onGround = f.onGround ? 1 : 0;
    s.gear = clamp(num(f.gear, p.mech?.gear === false ? 1 : 1));
    s.flaps = clamp(num(f.flaps, vis ? num(vis.flaps) : 0));
    s.flapsIndex = num(f.flapsIndex);
    s.flapsCount = Array.isArray(f.spec?.flapDetents) ? f.spec.flapDetents.length : 0;
    s.spoilers = clamp(num(f.spoilers, vis ? num(vis.spoilers) : 0));
    s.speedbrake = clamp(num(f.speedbrake, vis ? num(vis.speedbrake) : 0));
    s.brakes = clamp(num(f.brakes));
    s.canopy = clamp(vis ? num(vis.canopy, num(f.canopy)) : num(f.canopy));
    let rot = f.rotorRPM;
    if (rot == null && vis && vis.rotor) rot = vis.rotor.rpm;
    rot = num(rot, p.category === 'helicopter' ? (s.n1 > 0.15 ? 1 : 0) : 0);
    if (rot > 150) rot /= 258; else if (rot > 2) rot /= 100;
    s.rotor = s.dead ? 0 : clamp(rot, 0, 1.2);
    s.collective = clamp(num(f.collective, p.category === 'helicopter' ? s.thr : 0));
    s.torque = clamp(num(f.torque, s.collective), 0, 1.5);
    s.stalled = !!f.stalled;
    s.apOn = !!(f.autopilot && f.autopilot.on);
    // quantities in the units the real alert logic is written in (ft, kt, fpm) + system inputs
    s.ft = Math.max(0, s.agl * FT);
    s.kt = s.ias / 0.514444;
    s.fpm = s.vs * 196.85;
    s.alt = num(f.altitude, num(f.position?.y));
    s.altFt = s.alt * FT;
    s.roll = num(f.roll);
    s.aoa = num(f.aoa);
    s.gearHandle = typeof f.gearHandleDown === 'boolean' ? f.gearHandleDown : s.gear > 0.5;
    s.landIdx = num(f.spec?.landingFlapIndex, 99);
    s.gpwsLandIdx = p.gpwsLandIdx ?? s.landIdx;
    s.parkBrake = !!f.parkingBrake;
    const ap = f.autopilot || {};
    s.apMode = typeof ap.mode === 'string' ? ap.mode : '';
    s.athr = !!ap.athr;
    s.athrMode = typeof f.athrMode === 'string' ? f.athrMode : '';   // A320: '' | 'A.FLOOR' | 'TOGA LK'
    if (s.apOn) I.fcuValid = true;                 // FCU / MCP altitude = the autopilot target once it was engaged
    s.apAlt = num(ap.altitude, NaN);
    s.fcuValid = I.fcuValid && Number.isFinite(s.apAlt);
    s.fuelKg = num(f.fuel, 0);
    s.vlsKt = num(f.vSpeeds?.vls) / 0.514444;
    s.vmoKt = num(f.spec?.limits?.vmo, 1e4) / 0.514444;
    s.mmo = num(f.spec?.limits?.mmo, 9);
    s.n1min = Math.min(...s.eng.map((e) => e.n1));
    s.n1max = Math.max(...s.eng.map((e) => e.n1));
    computeIls(I, s, f);
    // every boolean flag the flight model publishes in `warnings` is passed through (new flags such as lowEnergy or
    // alphaFloor become s.w.<name> without changes here); s.wHas tells whether the model provides a flag at all
    const w = f.warnings || {};
    for (const key in s.w) s.w[key] = false;
    for (const key in w) if (typeof w[key] === 'boolean') { s.w[key] = w[key] && !s.dead; s.wHas[key] = true; }
    const fuel = num(f.fuel, NaN);
    if (Number.isFinite(fuel)) { I.fuel0 = Math.max(I.fuel0, fuel); s.fuelFrac = I.fuel0 > 0 ? fuel / I.fuel0 : 1; } else s.fuelFrac = 1;
    s.rotorLow = p.category === 'helicopter' && !s.dead && (typeof w.lowRotor === 'boolean' ? w.lowRotor
      : !s.onGround && s.rotor > 0.3 && s.rotor < 0.93);
    s.vrs = !!w.vrs && !s.dead;
    s.overtorque = !!w.overtorque && !s.dead;
    s.gearMoving = I.gearMov || s.t < I.gearSimEnd ? 1 : 0;
    s.flapMoving = s.t - I.flapT < 0.25 || s.t < I.flapSimEnd ? 1 : 0;
    s.canopyMoving = s.t - I.canopyT < 0.2 || s.t < I.canopySimEnd ? 1 : 0;
    return s;
  }

  /** Glide-slope / localizer deviation (dots) of the runway end ahead (3° path, the autopilot's ILS model). */
  const gTmp = {};
  function computeIls(I, s, f) {
    s.gsDots = null; s.locDots = 99;
    if (!runways || !f.position || s.onGround || s.ft > 2500) { I.ilsRw = null; return; }
    if (!I.ilsRw || s.t - (I.ilsT ?? -9) > 1) {
      I.ilsT = s.t;
      I.ilsRw = findApproach(runways, f.position.x, f.position.z, num(f.heading) * Math.PI / 180, 20000);
    }
    const rw = I.ilsRw;
    if (!rw) return;
    const g = approachGeometry(rw, f.position.x, f.position.z, gTmp);
    if (g.along < 150 || g.along > 18500) return;
    const theta = Math.atan2(s.alt - rw.elevation, g.along) * 57.2958;
    s.gsDots = (theta - 3) / 0.35;                                   // 1 dot = 0.35° (2 dots full scale)
    s.locDots = (Math.atan2(g.lateral, g.along + ((rw.length || 3000) - (rw.displaced || 0))) * 57.2958) / 1.25;
  }

  // ------------------------------------------------------------------------------------------------ helpers
  function setP(obj, key, param, v, tau) {
    const last = obj.last[key];
    if (last !== undefined && Math.abs(v - last) <= 1e-4 + Math.abs(last) * (key === 'rate' ? 0.0004 : 0.004)) return;
    obj.last[key] = v;
    param.setTargetAtTime(v, ctx.currentTime, tau);
  }

  const REAR_PTS = [[0, 0.28], [60, 0.34], [90, 0.5], [120, 0.8], [145, 1], [165, 0.95], [180, 0.85]];
  function directivity(dir, em) {
    if (!dir || dir === 'omni' || !em) return 1;
    const c = em.cos;
    if (dir === 'rear') {
      const deg = Math.acos(clamp(c, -1, 1)) * 57.2958;
      for (let i = 1; i < REAR_PTS.length; i++) {
        const [a1, g1] = REAR_PTS[i];
        if (deg <= a1) { const [a0, g0] = REAR_PTS[i - 1]; return g0 + (g1 - g0) * (deg - a0) / (a1 - a0); }
      }
      return 0.85;
    }
    const d = dir === 'front' ? FRONT : dir;
    return c >= 0 ? d.side + (d.front - d.side) * c : d.side + (d.rear - d.side) * -c;
  }
  const FRONT = { front: 1, side: 0.55, rear: 0.3 };

  const val = (x, s, e) => (typeof x === 'function' ? x(s, e) : x);

  // history of the aircraft position for retarded-time (emission position) lookups
  function histPush(I, t, p) {
    const h = I.hist;
    const j = I.histHead * 4;
    h[j] = t; h[j + 1] = p.x; h[j + 2] = p.y; h[j + 3] = p.z;
    I.histHead = (I.histHead + 1) % HIST;
    I.histN = Math.min(HIST, I.histN + 1);
  }
  function histAt(I, t, out) {
    const h = I.hist, n = I.histN;
    if (!n) return out;
    const newest = (I.histHead - 1 + HIST) % HIST;
    if (t >= h[newest * 4]) return out.set(h[newest * 4 + 1], h[newest * 4 + 2], h[newest * 4 + 3]);
    let lo = 0, hi = n - 1;                  // index 0 = oldest
    const idx = (i) => ((I.histHead - n + i + HIST) % HIST) * 4;
    if (t <= h[idx(0)]) { const j = idx(0); return out.set(h[j + 1], h[j + 2], h[j + 3]); }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (h[idx(m)] <= t) lo = m; else hi = m; }
    const a = idx(lo), b = idx(hi);
    const u = (t - h[a]) / Math.max(1e-6, h[b] - h[a]);
    return out.set(h[a + 1] + (h[b + 1] - h[a + 1]) * u, h[a + 2] + (h[b + 2] - h[a + 2]) * u, h[a + 3] + (h[b + 3] - h[a + 3]) * u);
  }

  // f(tau) = |P(now - tau) + offset - L| - c·tau ; the first root is the emission currently being heard
  const vT = new THREE.Vector3();
  function retardF(I, now, tau, off) { histAt(I, now - tau, vT); vT.add(off).sub(vCam); return vT.length() - C_SOUND * tau; }
  function solveTau(I, prev, now, off, mach) {
    const lim = MAX_DELAY - 0.5;
    if (mach < 0.85) {                                   // subsonic: fixed-point iteration converges (|slope| = M < 1)
      let tau = Math.min(prev, lim);
      for (let it = 0; it < 4; it++) tau = Math.min(lim, (retardF(I, now, tau, off) + C_SOUND * tau) / C_SOUND);
      return tau;
    }
    // transonic/supersonic: scan for the first sign change, then bisect
    let a = 0, b = 0.04;
    while (b < lim && retardF(I, now, b, off) > 0) { a = b; b += 0.04; }
    if (b >= lim) return lim;
    for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (retardF(I, now, m, off) > 0) a = m; else b = m; }
    return b;
  }

  function resolveEmitterNodes(I, obj) {
    for (const em of Object.values(I.emitters)) {
      if (em.resolvedFor === obj) continue;
      em.resolvedFor = obj;
      em.offset.fromArray(em.def.offset || [0, 0, 0]);
      for (const n of em.def.nodes || []) {
        const node = obj.getObjectByName(n);
        if (node) {
          obj.updateWorldMatrix(true, true);
          node.getWorldPosition(vA);
          obj.worldToLocal(vA);
          if (vA.lengthSq() < 4e4) { em.offset.copy(vA); break; }
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ one-shots
  function playFile(I, rel, { em = null, ext = 1, int = 1, gain = 1, rate = 1, bus = null, delay = 0, maxLate = 0.5 } = {}) {
    if (!ctx || !rel) return;
    const asked = ctx.currentTime;
    getBuffer(rel).then((buf) => {
      if (!buf || (I && inst !== I)) return;
      if (ctx.currentTime - asked > maxLate) return;       // still downloading when the event happened: skip, don't play late
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gn = gainNode(gain);
      src.connect(gn);
      if (bus) gn.connect(bus);
      else {
        if (em && ext > 0) { const e = gainNode(ext); gn.connect(e).connect(em.in); }
        if (int > 0) { const i2 = gainNode(int); gn.connect(i2).connect(G.intDirect); }
      }
      src.start(ctx.currentTime + delay);
      src.onended = () => { try { gn.disconnect(); src.disconnect(); } catch { /* */ } };
    });
  }

  function shot(I, key, opts = {}) {
    const rel = I.profile.shots?.[key] || key;
    const v = opts.bus ? 1 : ENGINE_SHOT.test(key) ? vol.engine * vol.engine : vol.ambient * vol.ambient;
    playFile(I, rel, { em: opts.em || I.emitters.air, ...opts, gain: (opts.gain ?? 1) * v });
  }

  // ------------------------------------------------------------------------------------------------ voices
  function stopVoice(I = inst) {
    if (!I) return;
    if (I.voice && I.voice.src) { try { I.voice.src.stop(); } catch { /* */ } }
    I.voice = null;
    I.queue.length = 0;
  }

  // tags 'group#key' (e.g. 'fwc:co#50'): a newer item of the same group replaces older queued ones (callouts)
  const groupOf = (tag) => { const i = tag.indexOf('#'); return i < 0 ? null : tag.slice(0, i); };
  function enqueueVoice(I, rel, prio, tag, maxAge = 3, gainDb = 0, system = '') {
    if (!rel) return;
    const now = ctx.currentTime;
    if (I.voice && I.voice.tag === tag && tag !== 'co') return;
    if (I.queue.some((q) => q.tag === tag && tag !== 'co')) return;
    if (tag === 'co') I.queue = I.queue.filter((q) => q.tag !== 'co');   // only the latest callout matters
    const grp = groupOf(tag);
    if (grp) I.queue = I.queue.filter((q) => groupOf(q.tag) !== grp);
    const item = { rel, prio, tag, t: now, maxAge, gainDb, system };
    if (!I.voice) startVoice(I, item);
    else if (I.voice.prio < prio) {
      const cur = I.voice; try { cur.src && cur.src.stop(); } catch { /* */ }
      I.ended[cur.tag] = now; traceAdd('voice-', cur.tag, { cut: true });
      I.voice = null; startVoice(I, item);
    } else I.queue.push(item);
  }

  function startVoice(I, item) {
    I.voice = { ...item, src: null, end: ctx.currentTime + 2 };
    const v = I.voice;
    traceAdd('voice', item.tag, { rel: item.rel });
    getBuffer(item.rel).then((buf) => {
      if (I.voice !== v) return;
      if (!buf) { I.voice = null; return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gn = gainNode(db(item.gainDb || 0));
      src.connect(gn).connect(G.alert);
      src.start();
      src.onended = () => { try { gn.disconnect(); } catch { /* */ } };
      v.src = src;
      v.end = ctx.currentTime + buf.duration;
    });
  }

  function serviceVoices(I) {
    const now = ctx.currentTime;
    if (I.voice && now >= I.voice.end) {
      const st = I.ruleState[I.voice.tag];
      if (st) st.next = now + (st.repeat ?? 1);
      I.ended[I.voice.tag] = now;
      I.voice = null;
    }
    if (!I.voice && I.queue.length) {
      I.queue.sort((a, b) => b.prio - a.prio || a.t - b.t);
      while (I.queue.length) {
        const it = I.queue.shift();
        if (now - it.t <= it.maxAge) { startVoice(I, it); break; }
      }
    }
  }

  function dequeueTag(I, tag) {
    I.queue = I.queue.filter((q) => q.tag !== tag);
  }

  function runAlerts(I, s) {
    const A = I.profile.alerts;
    if (!A) return;
    const now = s.t;
    const active = !userPaused && !s.dead;
    for (const r of A.rules || []) {
      const st = I.ruleState[r.id] || (I.ruleState[r.id] = { on: false, next: 0, fired: false, repeat: r.repeat });
      let on = false;
      if (active) { try { on = !!r.when(s); } catch { on = false; } }
      if (r.loop) {
        const L = I.alertLoops[r.id];
        if (L) setP(L, 'g', L.g.gain, on ? db(r.loopDb ?? 0) * L.norm : 0, on ? 0.02 : 0.08);
      }
      if (r.voice) {
        const busy = (I.voice && I.voice.tag === r.id) || I.queue.some((q) => q.tag === r.id);
        if (on && !busy && st.next === Infinity) st.next = now + (r.repeat ?? 1);
        if (on) {
          if (!st.on) {
            if (!(r.once && st.fired)) { enqueueVoice(I, r.voice, r.prio ?? 5, r.id, 1.5); st.fired = true; st.next = Infinity; }
          } else if (r.repeat != null && !r.once && now >= st.next && !(I.voice && I.voice.tag === r.id)) {
            enqueueVoice(I, r.voice, r.prio ?? 5, r.id, 1.5); st.next = Infinity;
          }
        } else if (st.on) dequeueTag(I, r.id);
      }
      st.on = on;
    }
    // radio-altimeter callouts (descending, airborne)
    if (A.callouts && active) {
      const ft = s.agl * FT;
      let hit = null;
      for (const c of A.callouts) {
        const st = I.co[c.ft] || (I.co[c.ft] = { armed: false });
        if (s.onGround) { st.armed = false; continue; }
        if (ft > c.ft + Math.max(12, c.ft * 0.08)) st.armed = true;
        else if (st.armed && ft <= c.ft && s.vs < -0.3) { st.armed = false; if (!hit || c.ft < hit.ft) hit = c; }
      }
      if (hit) {
        // Airbus: 'RETARD' replaces the 20 ft callout (10 ft in autoland) and repeats while the levers are above idle
        const retardFt = s.apOn ? 10 : 20;
        if (A.retard && hit.ft === retardFt) { enqueueVoice(I, A.retard, 4, 'retard', 1.2); I.retardNext = now + 2.2; }
        else enqueueVoice(I, hit.voice, 3, 'co', 0.8);
      }
    }
    if (A.retard && active && I.retardNext && now >= I.retardNext) {
      const low = s.agl * FT < 25 || (s.onGround && now - I.touchT < 6);
      if (low && s.thr > 0.08 && s.rev < 0.1) { enqueueVoice(I, A.retard, 4, 'retard', 1.5); I.retardNext = now + 2.2; }
      else I.retardNext = 0;
    }
    // real-system alert logic (src/audio/alertlogic.js)
    if (I.systems.length) {
      const io = I.io || (I.io = makeIo(I));
      io.now = now;
      const run = active && now >= I.graceUntil;
      I.loopReq = I.loopReq || {};
      I.loopWhy = I.loopWhy || {};
      for (const k in I.loopReq) { I.loopReq[k] = false; I.loopWhy[k] = ''; }
      if (run) {
        for (const sys of I.systems) {
          io.sys = sys.name;
          try { sys.update(s, io, I.flightRef); } catch (e) { warnOnce('sys:' + sys.name, `alert system ${sys.name}`, e); }
        }
      }
      for (const id in I.sysLoops) {
        const L = I.sysLoops[id];
        const on = run && !!I.loopReq[id];
        if (on !== L.on) { L.on = on; traceAdd(on ? 'loop+' : 'loop-', id, on && I.loopWhy[id] ? { why: I.loopWhy[id] } : undefined); }
        setP(L, 'g', L.g.gain, on ? db(L.db) * L.norm : 0, on ? 0.015 : 0.06);
      }
    }
  }

  function makeIo(I) {
    const io = {
      now: 0, sys: '',
      say(tag, rel, prio, o = {}) { enqueueVoice(I, rel, prio, tag, o.maxAge ?? 1.5, o.gainDb ?? 0, o.system ?? io.sys); },
      speaking(tag) {
        if (tag == null) return !!I.voice;
        return !!(I.voice && I.voice.tag === tag) || I.queue.some((q) => q.tag === tag);
      },
      speakingSystem(name) { return !!(I.voice && I.voice.system === name) || I.queue.some((q) => q.system === name); },
      endedAt(tag) { return I.ended[tag] ?? -99; },
      // why: short cause label recorded in the trace (e.g. CRC 'overspeed' vs 'gearNotDown')
      loop(id, on, why) { if (on) { const k = `${io.sys}:${id}`; I.loopReq[k] = true; if (why && !I.loopWhy[k]) I.loopWhy[k] = why; } },
      /** cut a playing / queued voice of this tag at once (its condition cleared) */
      stop(tag) {
        I.queue = I.queue.filter((q) => q.tag !== tag);
        if (I.voice && I.voice.tag === tag) {
          const cur = I.voice; try { cur.src && cur.src.stop(); } catch { /* */ }
          I.ended[tag] = ctx.currentTime; traceAdd('voice-', tag, { cut: true }); I.voice = null;
        }
      },
      tone(rel, o = {}) {
        playFile(I, rel, { bus: G.alert, gain: db(o.gainDb ?? 0) }); traceAdd('tone', o.tag || rel, { rel });
        I.toneUntil = Math.max(I.toneUntil || 0, ctx.currentTime + (manifest?.[rel]?.dur ?? 1.5));
      },
    };
    return io;
  }

  function resetSystems(I, now) {
    for (const sys of I.systems) { try { sys.reset(); } catch { /* */ } }
    I.graceUntil = now + 1.5;                      // smoothed readouts settle after a (re)spawn
    I.fcuValid = false;
    I.ended = {};
  }

  // ------------------------------------------------------------------------------------------------ events
  function runEvents(I, s, f, dt, obj) {
    const P = I.P;
    const mech = I.profile.mech || {};
    const air = I.emitters.air;
    const now = s.t;
    if (!P) return;
    if (I.teleport) { I.teleport = false; I.noseDone = true; return; }   // reset / respawn: no transition sounds
    // crash
    if (s.dead && !P.dead && now - I.crashT > 1) { I.crashT = now; shot(I, 'crash', { ext: 1.4, int: 1.2 }); }
    if (s.dead && !P.dead) { stopApDisc(I); stopVoice(I); }               // a crash silences every alert
    if (s.dead) return;
    // gear
    if (mech.gear !== false) {
      const gci = mech.gearClunkInt ?? 0.8;
      const dg = s.gear - P.gear;
      if (Math.abs(dg) > 0.5) {                                   // instantaneous (no animation): play a nominal sequence
        shot(I, 'gearUnlock', { ext: 0.6, int: gci * 0.8 });
        const T = mech.gearSeconds ?? 6;
        I.gearSimEnd = now + T;
        const down = s.gear > P.gear;
        I.timers.push({ t: now + T, fn: () => shot(I, down ? 'gearLockDown' : 'gearLockUp', { ext: 0.7, int: gci }) });
      } else if (Math.abs(dg) > 1e-4) {
        if (!I.gearMov) { I.gearMov = true; shot(I, 'gearUnlock', { ext: 0.6, int: gci * 0.8 }); }
        I.gearMoveT = now;
      } else if (I.gearMov && (s.gear <= 0.002 || s.gear >= 0.998 || now - I.gearMoveT > 0.6)) {
        I.gearMov = false;
        if (s.gear >= 0.998) shot(I, 'gearLockDown', { ext: 0.7, int: gci });
        else if (s.gear <= 0.002) shot(I, 'gearLockUp', { ext: 0.7, int: gci });
      }
    }
    // flaps
    const df = s.flaps - P.flaps;
    if (Math.abs(df) > 0.2) I.flapSimEnd = now + 1 + 5 * Math.abs(df);
    else if (Math.abs(df) > 0.03 * dt) I.flapT = now;           // ignore tiny automatic trims (fighter LEFs)
    if (mech.flapLever && s.flapsIndex !== P.flapsIndex) shot(I, 'flapLever', { ext: 0, int: 0.8 });
    // canopy
    if (mech.canopy) {
      const dc = s.canopy - P.canopy;
      if (Math.abs(dc) > 0.5) {
        I.canopySimEnd = now + 3.5;
        if (dc > 0) shot(I, 'canopyUnlock', { ext: 0.5, int: 0.8 });
        else I.timers.push({ t: now + 3.5, fn: () => { shot(I, 'canopyLock', { ext: 0.5, int: 0.9 }); shot(I, 'canopySeal', { ext: 0.1, int: 0.5, delay: 0.25 }); } });
      } else if (Math.abs(dc) > 1e-4) {
        if (P.canopy <= 0.002 && dc > 0) shot(I, 'canopyUnlock', { ext: 0.5, int: 0.8 });
        I.canopyT = now;
      }
      if (P.canopy > 0.002 && s.canopy <= 0.002 && Math.abs(dc) <= 0.5) { shot(I, 'canopyLock', { ext: 0.5, int: 0.9 }); shot(I, 'canopySeal', { ext: 0.1, int: 0.5, delay: 0.25 }); }
    }
    // speedbrake / spoilers / reverser
    if ((s.speedbrake > 0.05) !== (P.speedbrake > 0.05)) shot(I, 'speedbrake', { ext: 0.5, int: s.speedbrake > 0.05 ? 0.7 : 0.45 });
    if (mech.spoilers && s.spoilers > 0.5 && P.spoilers <= 0.5 && s.onGround) shot(I, 'spoiler', { ext: 0.6, int: 0.7 });
    if (mech.reverser && s.rev > 0.1 && P.rev <= 0.1) {
      for (const e of s.eng) shot(I, 'reverser', { em: I.emitters[`eng${e.i + 1}`] || air, ext: 0.7, int: 0.35 });
    }
    // afterburner light-off / blow-out
    for (const e of s.eng) {
      const pe = P.eng[e.i];
      const em = I.emitters[`eng${e.i + 1}`] || air;
      if (e.ab > 0.04 && pe.ab <= 0.04) shot(I, 'abLightoff', { em, ext: 1.3, int: 0.9, rate: 0.96 + Math.random() * 0.08 });
      else if (e.ab <= 0.02 && pe.ab > 0.02) shot(I, 'abOut', { em, ext: 0.8, int: 0.5 });
    }
    // touchdown / nose-gear / runway bumps
    if (!s.onGround) I.vsAir = s.vs;
    if (s.onGround && !P.onGround && now - I.touchT > 0.8) {
      I.touchT = now;
      const vs = Math.abs(I.vsAir);
      if (mech.helicopter) shot(I, 'noseTouch', { ext: 0.6, int: 0.8 * clamp(0.4 + vs / 2) });
      else if (s.gs > 12) {
        const heavy = vs > 2.3;
        const gain = clamp(0.55 + vs / 3.5, 0.5, 1.4);
        shot(I, heavy ? 'touchdownHeavy' : 'touchdownLight', { ext: gain, int: gain * 0.9, rate: 0.94 + Math.random() * 0.12 });
        I.noseDone = false;
      }
    }
    if (!I.noseDone && s.onGround) {
      if (s.pitch < 1.2 || now - I.touchT > 4) { I.noseDone = true; shot(I, 'noseTouch', { ext: 0.5, int: 0.7 }); }
    }
    if (s.onGround && s.gs > 3 && !mech.helicopter) {
      I.bumpDist += s.gs * dt;
      if (I.bumpDist >= 15.24) {
        I.bumpDist = 0;
        const g = clamp(s.gs / 45) * (0.6 + 0.4 * Math.random());
        shot(I, 'bump', { ext: 0.04 * g, int: (I.profile.bumpInt ?? 0.22) * g, rate: 0.9 + 0.2 * Math.random() });
      }
    }
    // light switches (cockpit clicks)
    const lt = I.vis && I.vis.lights;
    if (lt) {
      const key = (lt.nav ? 1 : 0) | (lt.strobe ? 2 : 0) | (lt.beacon ? 4 : 0) | (lt.landing ? 8 : 0) | (lt.taxi ? 16 : 0);
      if (I.lightsKey != null && key !== I.lightsKey && s.cockpit) shot(I, 'click', { ext: 0, int: 0.5 });
      I.lightsKey = key;
    }
    // autopilot engage / disconnect
    const ap = !!(f.autopilot && f.autopilot.on);
    if (I.apOn !== null && ap !== I.apOn) {
      if (ap) { shot(I, 'clickSoft', { bus: G.ui, gain: 0.7 }); stopApDisc(I); }
      else if (!I.apEvents) apDisconnect(I, false);          // flight model without events: treat as intentional
    }
    I.apOn = ap;
    // sonic boom when accelerating through Mach 1 near an exterior camera
    if (s.mach >= 1 && P.mach < 1 && !s.cockpit && air.d < 3000 && now - I.boomT > 5) {
      I.boomT = now;
      playBoom(I, air);
    }
  }

  // ---- autopilot disconnect aural alert -------------------------------------------------------------------
  // A320 'cavalry charge': once on an intentional disconnect, repeating until acknowledged when involuntary.
  // 737 'wailer': sounds ~3 s (intentional) or until acknowledged (involuntary, max 8 s).
  // Acknowledge = a second autopilot-disconnect press (KeyO / api.acknowledge()) or the autopilot re-engaging.
  function apDisconnect(I, involuntary) {
    const A = I.profile.alerts || {};
    if (!A.apDisconnect || !ctx) return;
    if (I.flightRef?.crashed || I.s?.dead) { stopApDisc(I); return; }   // a crash disengages the A/P silently
    stopApDisc(I);
    const boeing = A.style === 'boeing';
    const now = ctx.currentTime;
    if (!involuntary && A.apButton) shot(I, A.apButton, { ext: 0, int: 0.8 });     // the disconnect pushbutton
    const loop = boeing || involuntary;
    // 737: >= 2 s after a disconnect-switch press, until reset after an automatic disengage (safety cap 30 s);
    // A320: 1.5 s (take-over pb), permanent after an automatic disconnect until MASTER WARN / pb (cap 30 s)
    I.apd = { t0: now, until: now + (boeing ? (involuntary ? 30 : 2.2) : 30), srcs: [], loop,
      file: loop ? (A.apDisconnectLoop || A.apDisconnect) : A.apDisconnect };
    traceAdd('apd', involuntary ? 'apDisconnect:involuntary' : 'apDisconnect', { rel: I.apd.file });
    playApd(I);
  }
  function playApd(I) {
    const apd = I.apd;
    getBuffer(apd.file).then((buf) => {
      if (!buf || I.apd !== apd || inst !== I) return;
      const src = ctx.createBufferSource(); src.buffer = buf;
      if (apd.loop) {
        src.loop = true;
        if (buf.__loop) { src.loopStart = buf.__loop.start; src.loopEnd = buf.__loop.start + buf.__loop.dur; }
      }
      const gn = gainNode(1);
      src.connect(gn).connect(G.alert);
      src.start(ctx.currentTime, apd.loop && buf.__loop ? buf.__loop.start : 0);
      apd.srcs.push({ src, gn });
      src.onended = () => { try { gn.disconnect(); } catch { /* */ } if (I.apd === apd && !apd.loop) I.apd = null; };
    });
  }
  function stopApDisc(I) {
    if (!I || !I.apd) return;
    const now = ctx.currentTime;
    traceAdd('apd-', 'apDisconnect');
    for (const { src, gn } of I.apd.srcs) {
      try { gn.gain.cancelScheduledValues(now); gn.gain.setTargetAtTime(0, now, 0.03); src.stop(now + 0.25); } catch { /* */ }
    }
    I.apd = null;
  }
  function serviceApDisc(I, now) {
    if (I.apd && now >= I.apd.until) stopApDisc(I);         // 737: ~3 s (intentional) / safety limits
  }
  function acknowledge() {
    if (inst && inst.apd && ctx && ctx.currentTime > inst.apd.t0 + 0.15) stopApDisc(inst);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyO' && !e.repeat) acknowledge(); }, { capture: true });
  }

  function playBoom(I, em) {
    const d = Math.max(30, em.d);
    const g = clamp(Math.pow(300 / d, 0.75), 0.15, 1.6);
    // the boom arrives with the shock: inject after the delay line so it is not delayed/dopplered again
    getBuffer(I.profile.shots?.boom || 'common/sonic_boom').then((buf) => {
      if (!buf || inst !== I) return;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const gn = gainNode(g * 1.4);
      src.connect(gn).connect(em.pan);
      src.start();
      src.onended = () => { try { gn.disconnect(); } catch { /* */ } };
    });
  }

  // ------------------------------------------------------------------------------------------------ update
  function update(dt, flight, opts = {}) {
    const I = inst;
    if (!ctx || !I || !flight) return;
    dt = clamp(num(dt, 0.016), 0.001, 0.1);
    const now = ctx.currentTime;
    const cam = opts.camera || defaultCamera;
    const obj = opts.aircraftObject || null;
    let vis = null;
    if (typeof flight.getVisualState === 'function' && (I.visT === undefined || now - I.visT > 0.03)) {
      try { vis = flight.getVisualState(); I.vis = vis; I.visT = now; } catch { vis = null; }
    } else vis = I.vis || null;
    const s = deriveState(I, dt, flight, opts, vis);
    if (I.flightRef !== flight) {
      I.flightRef = flight;
      I.apEvents = false;
      if (typeof flight.on === 'function') {
        try {
          flight.on('autopilot', (e) => {
            if (inst !== I || I.flightRef !== flight || !e) return;
            if (e.on) stopApDisc(I);
            // pilot push / autoland rollout hand-over (the crew presses the take-over pb) = intentional
            else apDisconnect(I, !(e.reason === 'pilot' || e.reason === 'rollout'));
          });
          I.apEvents = true;
        } catch { I.apEvents = false; }
      }
    }

    // --- geometry
    if (obj) { obj.updateWorldMatrix(true, false); obj.getWorldPosition(vB); obj.getWorldQuaternion(qA); resolveEmitterNodes(I, obj); }
    else {
      const p = flight.position; const q = flight.quaternion;
      vB.set(num(p?.x), num(p?.y), num(p?.z));
      if (q && typeof q.w === 'number') qA.set(q.x, q.y, q.z, q.w); else qA.identity();
    }
    vFwd.set(0, 0, -1).applyQuaternion(qA);
    s.pitch = Math.asin(clamp(vFwd.y, -1, 1)) * 57.2958;
    if (cam) { cam.updateWorldMatrix(true, false); cam.getWorldPosition(vCam); mCamInv.copy(cam.matrixWorld).invert(); }
    else { vCam.copy(vB); mCamInv.identity(); }
    // aircraft teleport (reset) → forget the history
    if (I.histN) {
      const j = ((I.histHead - 1 + HIST) % HIST) * 4;
      const dx = vB.x - I.hist[j + 1], dy = vB.y - I.hist[j + 2], dz = vB.z - I.hist[j + 3];
      if (dx * dx + dy * dy + dz * dz > (1500 * dt + 50) ** 2) { I.histN = 0; I.teleport = true; }
    }
    histPush(I, now, vB);
    // camera velocity (for the Mach cone test and teleport detection)
    if (prevCamValid) vCamVel.copy(vCam).sub(prevCam).divideScalar(dt); else vCamVel.set(0, 0, 0);
    prevCam.copy(vCam); prevCamValid = true;
    const v = flight.velocity;
    if (v && typeof v.x === 'number') vVel.set(v.x, v.y, v.z); else vVel.copy(vFwd).multiplyScalar(s.tas);

    // --- buses
    const cockpit = s.cockpit;
    const ip = I.profile.interior || {};
    const tauView = 0.06;
    setP(I, 'ext', G.ext.gain, cockpit ? 0 : 1, tauView);
    setP(I, 'int', G.int.gain, cockpit ? 1 : 0, tauView);
    setP(I, 'alert', G.alert.gain, (cockpit ? 1.0 : 0.5) * vol.voice * vol.voice, 0.1);
    const canopy = s.canopy;
    const supersonicQuiet = I.profile.category === 'fighter' ? 1 - 0.55 * sstep(1.0, 1.25, s.mach) : 1;
    setP(I, 'intEng', G.intEng.gain, db((ip.engineDb ?? 0) + (ip.canopyOpenDb ?? 0) * canopy) * supersonicQuiet, 0.1);
    setP(I, 'intLP', G.intLP.frequency, clamp((ip.lp ?? 1200) * (1 + 4 * canopy), 100, 18000), 0.1);
    setP(I, 'intLP2', G.intLP2.frequency, clamp((ip.lp ?? 1200) * 2.2 * (1 + 4 * canopy), 100, 20000), 0.1);

    // --- emitters: directivity angle, distance, air absorption, retarded delay, panning, Mach cone
    const extDb = db(I.profile.exteriorDb ?? 0);
    const mach = s.mach;
    for (const em of Object.values(I.emitters)) {
      vA.copy(em.offset).applyQuaternion(qA);           // world offset
      em.world.copy(vA).add(vB);
      vC.copy(vCam).sub(em.world);
      const d = Math.max(0.5, vC.length());
      em.d = d;
      em.cos = vC.dot(vFwd) / d;
      const gd = Math.min(1, em.ref / d) * extDb * (1 + 0.18 * sstep(300, 3000, d) * em.turb);
      setP(em, 'dist', em.dist.gain, d > 15000 ? 0 : gd, 0.05);
      // atmospheric turbulence: at a distance the high frequencies 'swish' (random scintillation of the absorption)
      if (now >= em.turbNext) { em.turbTarget = Math.random() * 2 - 1; em.turbNext = now + 0.15 + Math.random() * 0.45; }
      em.turb += (em.turbTarget - em.turb) * Math.min(1, dt * 4);
      const far = sstep(150, 1500, d);
      setP(em, 'lp', em.lp.frequency, clamp(24000 * Math.pow(80 / Math.max(d, 80), 0.75) * (1 + 0.4 * far * em.turb), 400, 22000), 0.08);
      // jet mixing noise is darkest near the jet axis (large-scale structures), brighter to the side/front
      if (em.def.aftDb) {
        const aftT = sstep(-0.2, -0.97, em.cos);                  // 0 up to ~100°, 1 at 165°+
        setP(em, 'aft', em.aft.gain, -em.def.aftDb * aftT, 0.08);
      }
      // retarded time: tau = |P(t - tau) - L(t)| / c on the position history
      const tau = solveTau(I, em.tau, now, vA, mach);
      histAt(I, now - tau, vC);
      em.retarded.copy(vC).add(vA);
      const jump = Math.abs(tau - em.tau) > Math.max(0.15, 4 * dt);
      em.tau = tau;
      // Mach cone: outside it (ahead of a supersonic aircraft) nothing has arrived yet
      let inside = true;
      if (mach > 1.0 && vVel.lengthSq() > 1) {
        vC.copy(vCam).sub(em.world);
        const cosBack = -vC.dot(vVel) / (vC.length() * vVel.length() + 1e-9);
        inside = cosBack > Math.cos(Math.asin(1 / mach));
      }
      if (cockpit || !inside || em.inside === false) {
        // cockpit view or ahead of the Mach cone: the chain is muted, park the delay on the target (no doppler sweep)
        if (Math.abs(em.delayCur - tau) > 0.02) { em.delayCur = tau; em.delay.delayTime.cancelScheduledValues(now); em.delay.delayTime.setValueAtTime(tau, now); }
      } else if (jump || Math.abs(tau - em.delayCur) > 1.5) {
        // camera cut / aircraft reset: dip, jump the delay, restore (no pitch sweep)
        em.delayCur = tau;
        em.freezeUntil = now + 0.05;
        const pg = em.post.gain;
        pg.cancelScheduledValues(now); pg.setValueAtTime(pg.value, now); pg.linearRampToValueAtTime(0, now + 0.02);
        em.delay.delayTime.cancelScheduledValues(now); em.delay.delayTime.setValueAtTime(tau, now + 0.022);
        pg.setValueAtTime(0, now + 0.025); pg.linearRampToValueAtTime(1, now + 0.09);
      } else if (now >= em.freezeUntil) {
        // pitch ratio = 1 - d(tau)/dt, limited to [0.5, 2]
        em.delayCur += clamp(tau - em.delayCur, -1.0 * dt, 0.5 * dt);
        em.delay.delayTime.setTargetAtTime(em.delayCur, now, 0.03);
      }
      // ground reflection: flat ground at the terrain height under the aircraft (y - agl)
      if (!cockpit && s.agl < 5000) {
        const gy = vB.y - s.agl;
        const hs = Math.max(0.3, em.retarded.y - gy), hl = Math.max(0.3, vCam.y - gy);
        const dx = em.retarded.x - vCam.x, dz = em.retarded.z - vCam.z;
        const R2 = dx * dx + dz * dz;
        const r1 = Math.sqrt(R2 + (hs - hl) * (hs - hl)), r2 = Math.sqrt(R2 + (hs + hl) * (hs + hl));
        const dly = (r2 - r1) / C_SOUND;
        const rg = dly < 0.2 ? 0.55 * (r1 / r2) * (1 - sstep(0.08, 0.2, dly)) : 0;
        const dNow = clamp(dly, 0.00005, 0.2);
        if (em.last.reflD !== undefined && Math.abs(dNow - em.last.reflD) > Math.max(0.004, 0.25 * dt)) {
          // geometry jump (camera cut / reset): hide the delay step instead of sweeping through it
          const rgp = em.reflG.gain;
          rgp.cancelScheduledValues(now); rgp.setValueAtTime(rgp.value, now); rgp.linearRampToValueAtTime(0, now + 0.02);
          em.refl.delayTime.cancelScheduledValues(now); em.refl.delayTime.setValueAtTime(dNow, now + 0.022);
          rgp.setValueAtTime(0, now + 0.024); rgp.linearRampToValueAtTime(rg, now + 0.08);
          em.last.reflD = dNow; em.last.reflG = rg;
        } else {
          setP(em, 'reflG', em.reflG.gain, rg, 0.05);
          if (rg > 0.01) setP(em, 'reflD', em.refl.delayTime, dNow, 0.03);
        }
      } else setP(em, 'reflG', em.reflG.gain, 0, 0.05);
      // panning from the emission (retarded) position, in camera space
      vC.copy(em.retarded).applyMatrix4(mCamInv);
      const pn = em.pan;
      if (pn.positionX) {
        setP(em, 'px', pn.positionX, vC.x, 0.02); setP(em, 'py', pn.positionY, vC.y, 0.02); setP(em, 'pz', pn.positionZ, vC.z, 0.02);
      } else pn.setPosition(vC.x, vC.y, vC.z);
      if (em.name === 'air' && inside && em.inside === false && !cockpit && now - I.boomT > 4) { I.boomT = now; playBoom(I, em); }
      em.inside = inside;
      setP(em, 'cone', em.cone.gain, inside ? 1 : 0, inside ? 0.01 : 0.05);
    }

    // --- layers
    const volE = vol.engine * vol.engine, volA = vol.ambient * vol.ambient;
    for (const L of I.layers) {
      const def = L.def;
      const e = L.ei >= 0 ? s.eng[L.ei] : s.eng[0];
      let g = 0;
      try { g = Math.max(0, num(def.gain(s, e))); } catch { g = 0; }
      const tau = def.tau ?? 0.07;
      setP(L, 'g', L.g.gain, g * L.norm * (L.cat === 'engine' ? volE : volA), tau);
      if (g <= 0 && L.last.g === 0) continue;
      if (L.src && (def.rate || L.ei > 0)) {
        let r = 1;
        if (def.rate) { try { r = clamp(num(def.rate(s, e), 1), 0.05, 4); } catch { r = 1; } }
        // twin engines never run at exactly the same speed: a slowly wandering detune makes the fan tones beat
        if (L.ei > 0) r *= 1 + 0.0016 * L.ei + 0.0009 * Math.sin(now * 0.045 + 1.7 * L.ei) + 0.0005 * Math.sin(now * 0.13);
        setP(L, 'rate', L.src.playbackRate, r, 0.08);
      }
      if (L.f && def.lp) {
        let hz = 8000;
        try { hz = clamp(num(def.lp(s, e), 8000), 60, 20000); } catch { /* */ }
        setP(L, 'lp', L.f.frequency, hz, 0.08);
      }
      if (L.ext) setP(L, 'ext', L.ext.gain, num(val(def.ext, s, e)) * directivity(def.dir, L.em), 0.05);
      if (L.int) setP(L, 'int', L.int.gain, num(val(def.int, s, e)), 0.05);
    }

    // --- transitions, alerts, timers
    if (I.teleport || I.firstUpdate || I.sysFlight !== flight) { I.sysFlight = flight; resetSystems(I, now); stopVoice(I); stopApDisc(I); }
    if (s.dead && I.apd) stopApDisc(I);            // nothing may keep sounding over the crash card
    runEvents(I, s, flight, dt, obj);
    runAlerts(I, s);
    serviceApDisc(I, now);
    serviceVoices(I);
    if (I.timers.length) {
      for (let i = I.timers.length - 1; i >= 0; i--) if (now >= I.timers[i].t) { const t = I.timers[i]; I.timers.splice(i, 1); try { t.fn(); } catch { /* */ } }
    }
    // remember the previous state
    const P = I.P || (I.P = { eng: s.eng.map(() => ({ ab: 0 })) });
    P.gear = s.gear; P.flaps = s.flaps; P.flapsIndex = s.flapsIndex; P.canopy = s.canopy; P.speedbrake = s.speedbrake;
    P.spoilers = s.spoilers; P.rev = s.rev; P.onGround = s.onGround; P.dead = s.dead; P.mach = s.mach;
    for (const e of s.eng) P.eng[e.i].ab = e.ab;
    if (I.firstUpdate) { I.firstUpdate = false; I.apOn = !!(flight.autopilot && flight.autopilot.on); }
  }

  // ------------------------------------------------------------------------------------------------ play(name)
  function resolveName(I, name) {
    const p = I.profile;
    const A = p.alerts || {};
    if (name === 'chime') return { rel: A.chime || 'common/click_soft', bus: G.alert };
    if (name === 'click') return { rel: p.shots?.click || 'common/click', bus: G.ui };
    if (p.shots && p.shots[name]) return { rel: p.shots[name] };
    const rule = (A.rules || []).find((r) => r.id === name && r.voice);
    if (rule) return { rel: rule.voice, bus: G.alert, voice: true };
    const co = (A.callouts || []).find((c) => String(c.ft) === String(name));
    if (co) return { rel: co.voice, bus: G.alert, voice: true };
    if (name === 'retard' && A.retard) return { rel: A.retard, bus: G.alert, voice: true };
    if (name === 'apDisconnect' && A.apDisconnect) return { apd: true };
    if (name === 'touchdown') return { rel: p.shots?.touchdownLight || 'common/touchdown_light' };
    if (name === 'boom' || name === 'sonicBoom') return { rel: 'boom' };
    if (name.includes('/')) return { rel: name, bus: name.includes('/v_') ? G.alert : null };
    const low = name.toLowerCase();
    if (/^v_/.test(low)) return { rel: `${I.dir}/${low}`, bus: G.alert, voice: true };
    return { rel: `${I.dir}/${name}`, fallback: `common/${name}`, alt: `${I.dir}/v_${low}` };
  }

  function play(name) {
    if (!ctx || !inst || !name) return;
    const I = inst;
    if (name === 'crash') { if (ctx.currentTime - I.crashT > 1) { I.crashT = ctx.currentTime; shot(I, 'crash', { ext: 1.4, int: 1.2 }); } return; }
    const r = resolveName(I, String(name));
    if (r.apd) { apDisconnect(I, false); return; }
    if (r.rel === 'boom') { playBoom(I, I.emitters.air); return; }
    if (r.voice) { enqueueVoice(I, r.rel, 6, 'play:' + name, 2); return; }
    const tryPlay = (rel) => getBuffer(rel).then((b) => b);
    if (r.fallback) {
      tryPlay(r.rel).then((b) => {
        if (b) return playFile(I, r.rel, { em: I.emitters.air, ext: 1, int: 1 });
        return tryPlay(r.alt).then((b2) => {
          if (b2) return enqueueVoice(I, r.alt, 6, 'play:' + name, 2);
          return playFile(I, r.fallback, { em: I.emitters.air, ext: 1, int: 1 });
        });
      });
      return;
    }
    playFile(I, r.rel, r.bus ? { bus: r.bus } : { em: I.emitters.air, ext: 1, int: 1 });
  }

  // ------------------------------------------------------------------------------------------------ debug
  const dbgBuf = new Float32Array(4096);
  function debug() {
    const I = inst;
    let rms = -120, peak = -120;
    if (G) {
      G.analyser.getFloatTimeDomainData(dbgBuf);
      let sq = 0, pk = 0;
      for (let i = 0; i < dbgBuf.length; i++) { const x = dbgBuf[i]; sq += x * x; pk = Math.max(pk, Math.abs(x)); }
      rms = 10 * Math.log10(sq / dbgBuf.length + 1e-12); peak = 20 * Math.log10(pk + 1e-12);
    }
    return {
      state: ctx ? ctx.state : 'none', sampleRate: ctx?.sampleRate, masterGain: G ? +G.vol.gain.value.toFixed(3) : null, aircraft: I?.id ?? null, rmsDb: +rms.toFixed(1), peakDb: +peak.toFixed(1),
      reduction: G ? +(G.glue.reduction ?? 0).toFixed?.(1) : 0,
      layers: I ? I.layers.map((L) => ({ id: L.id, loaded: !!L.src, g: +(L.last.g ?? 0).toFixed(3), rate: +(L.last.rate ?? 1).toFixed(3), ext: +(L.last.ext ?? 0).toFixed(3), int: +(L.last.int ?? 0).toFixed(3) })) : [],
      emitters: I ? Object.values(I.emitters).map((e) => ({ name: e.name, d: +e.d.toFixed(1), delay: +e.delayCur.toFixed(3), tau: +e.tau.toFixed(3), cos: +e.cos.toFixed(2), inside: e.inside !== false })) : [],
      apd: I && I.apd ? { file: I.apd.file, srcs: I.apd.srcs.length, left: +(I.apd.until - ctx.currentTime).toFixed(2) } : null,
      voice: I?.voice?.rel ?? null, queue: I ? I.queue.map((q) => q.rel) : [], idleN1: I?.idleN1, s: I ? { n1: I.s.n1, n1s: I.s.n1s, pow: I.s.pow, ab: I.s.ab } : null,
      alerts: I ? { voice: I.voice ? { tag: I.voice.tag, rel: I.voice.rel } : null, loops: Object.keys(I.sysLoops).filter((k) => I.sysLoops[k].on),
        systems: I.systems.map((x) => ({ name: x.name, ...(x.debug ? x.debug() : {}) })), ils: I.s.gsDots != null ? { gs: +I.s.gsDots.toFixed(2), loc: +I.s.locDots.toFixed(2) } : null } : null,
    };
  }

  function setVolumes(v = {}) {
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(vol)) if (typeof v[k] === 'number' && Number.isFinite(v[k])) vol[k] = clamp(v[k], 0, 1);
    if (!G) return;
    const t = ctx.currentTime;
    G.vol.gain.setTargetAtTime(vol.master * vol.master, t, 0.05);
    G.atc.gain.setTargetAtTime(vol.atc * vol.atc, t, 0.05);
    if (inst) { inst.last.alert = undefined; for (const L of inst.layers) L.last.g = undefined; }   // re-apply next frame
  }

  const api = {
    muted: false,
    start, setMuted, setPaused, loadAircraft, update, play, debug, setVolumes, acknowledge,
    get volumes() { return { ...vol }; },
    get atcInput() { return G ? G.atc : null; },       // connect ATC/radio sources here (atc volume applies)
    get context() { return ctx; },
    get analyser() { return G ? G.analyser : null; },
    trace,                                              // alert trace: { t, kind: voice|voice-|tone|loop+|loop-|apd|apd-, id, rel, why }
    /** true while any aural alert sounds (voice playing / queued, alert loop, A/P-disconnect alert, alert tone) */
    get alertActive() {
      const I = inst;
      if (!I || !ctx || userPaused) return false;
      if (I.voice || I.queue.length || I.apd || ctx.currentTime < (I.toneUntil || 0)) return true;
      for (const k in I.sysLoops) if (I.sysLoops[k].on) return true;
      return false;
    },
    get output() { return G ? G.out : null; },          // post-limiter master (dev tools tap this for recording)
  };
  if (typeof window !== 'undefined') window.__audioSys = api;   // test hook (headless checks)
  return api;
}
