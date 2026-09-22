// Fully synthesized WebAudio: piston engine + propeller chop, wind, ground rumble, stall horn,
// tire squeak and crash. The AudioContext is created lazily in start() (browser autoplay rules).

const MASTER_VOL = 0.55;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createAudio() {
  let ctx = null;
  let n = null;          // node graph
  let stallOn = false;
  let wasCrashed = false;
  // pause detection: main.js keeps calling update() while paused; an airborne aircraft whose position
  // is exactly frozen is paused (or the tab is stalled), so the continuous loops fade out
  let lastX = NaN, lastY = NaN, lastZ = NaN, frozenSince = -1;

  function noiseBuffer(seconds, brown = false) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    // smooth the loop seam
    const fade = Math.min(256, len >> 3);
    for (let i = 0; i < fade; i++) { const t = i / fade; d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t; }
    return buf;
  }

  function loopNoise(buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }

  function build() {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.setTargetAtTime(api.muted ? 0 : MASTER_VOL, now + 0.05, 0.4);   // gentle fade-in
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);

    const white = noiseBuffer(2.5);
    const brown = noiseBuffer(3, true);

    // ---- engine: detuned saws + sub square -> lowpass -> propeller chop (AM) -> level ----
    const engMix = ctx.createGain(); engMix.gain.value = 0.5;
    const oscs = [];
    const mk = (type, gain) => {
      const o = ctx.createOscillator(); o.type = type;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g).connect(engMix); o.start();
      oscs.push(o);
      return o;
    };
    const o1 = mk('sawtooth', 0.55);
    const o2 = mk('sawtooth', 0.45);
    const o3 = mk('square', 0.35);
    const o4 = mk('triangle', 0.3);
    // exhaust rumble: brown noise band
    const exhaust = loopNoise(brown);
    const exBP = ctx.createBiquadFilter(); exBP.type = 'bandpass'; exBP.frequency.value = 140; exBP.Q.value = 0.9;
    const exG = ctx.createGain(); exG.gain.value = 0.9;
    exhaust.connect(exBP).connect(exG).connect(engMix);

    const engLP = ctx.createBiquadFilter(); engLP.type = 'lowpass'; engLP.frequency.value = 500; engLP.Q.value = 0.7;
    const chop = ctx.createGain(); chop.gain.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 14;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.3;
    lfo.connect(lfoDepth).connect(chop.gain); lfo.start();
    const engGain = ctx.createGain(); engGain.gain.value = 0;
    engMix.connect(engLP).connect(chop).connect(engGain).connect(master);

    // ---- wind: white noise band, opens with airspeed ----
    const wind = loopNoise(white);
    const windBP = ctx.createBiquadFilter(); windBP.type = 'bandpass'; windBP.frequency.value = 400; windBP.Q.value = 0.6;
    const windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 2500;
    const windGain = ctx.createGain(); windGain.gain.value = 0;
    wind.connect(windBP).connect(windLP).connect(windGain).connect(master);

    // ---- ground rumble while rolling ----
    const rumble = loopNoise(brown);
    const rumLP = ctx.createBiquadFilter(); rumLP.type = 'lowpass'; rumLP.frequency.value = 220;
    const rumGain = ctx.createGain(); rumGain.gain.value = 0;
    rumble.connect(rumLP).connect(rumGain).connect(master);

    // ---- stall horn: steady reedy tone, gated ----
    const hornGain = ctx.createGain(); hornGain.gain.value = 0;
    const hornLP = ctx.createBiquadFilter(); hornLP.type = 'lowpass'; hornLP.frequency.value = 2600;
    const h1 = ctx.createOscillator(); h1.type = 'square'; h1.frequency.value = 820;
    const h2 = ctx.createOscillator(); h2.type = 'triangle'; h2.frequency.value = 826;
    const h1g = ctx.createGain(); h1g.gain.value = 0.35;
    h1.connect(h1g).connect(hornLP);
    h2.connect(hornLP);
    hornLP.connect(hornGain).connect(master);
    h1.start(); h2.start();

    n = { master, white, brown, o1, o2, o3, o4, engLP, lfo, lfoDepth, engGain, windBP, windLP, windGain, rumGain, hornGain, exG };
  }

  function set(param, value, tau = 0.08) {
    param.setTargetAtTime(value, ctx.currentTime, tau);
  }

  const api = {
    muted: false,

    start() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = null; return; }
      build();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
      });
    },

    update(f) {
      if (!ctx || !n || !f) return;
      const p = f.position;
      if (p && p.x === lastX && p.y === lastY && p.z === lastZ && !f.onGround) {
        if (frozenSince < 0) frozenSince = ctx.currentTime;
      } else frozenSince = -1;
      if (p) { lastX = p.x; lastY = p.y; lastZ = p.z; }
      const frozen = frozenSince >= 0 && ctx.currentTime - frozenSince > 0.2;
      if (frozen) {
        set(n.engGain.gain, 0, 0.15); set(n.windGain.gain, 0, 0.15); set(n.rumGain.gain, 0, 0.1);
        api.stallWarning(false);
        return;
      }
      const thr = clamp(f.throttle || 0, 0, 1);
      const as = Math.max(0, f.airspeed || 0);
      const crashed = !!f.crashed;

      // engine: rpm from throttle plus some windmilling from airspeed
      const rpm = crashed ? 0 : 750 + thr * 1850 + as * 6;
      const fire = (rpm / 60) * 2;                     // 4-cylinder, 4-stroke firing frequency (Hz)
      const base = Math.max(20, fire);
      set(n.o1.frequency, base, 0.12);
      set(n.o2.frequency, base * 1.008, 0.12);
      set(n.o3.frequency, base * 0.5, 0.12);
      set(n.o4.frequency, base * 2.01, 0.12);
      set(n.lfo.frequency, Math.max(4, rpm / 60), 0.12);          // blade chop once per revolution pair
      set(n.lfoDepth.gain, 0.34 - thr * 0.16, 0.2);                 // chop is most audible at idle
      set(n.engLP.frequency, 320 + thr * 1500 + as * 8, 0.12);
      set(n.exG.gain, 0.6 + thr * 0.8, 0.15);
      set(n.engGain.gain, crashed ? 0 : 0.3 + thr * 0.28, crashed ? 0.05 : 0.15);

      // wind
      const w = clamp(as / 65, 0, 1.3);
      set(n.windGain.gain, 0.32 * w * w, 0.15);
      set(n.windBP.frequency, 260 + as * 26, 0.15);
      set(n.windLP.frequency, 1200 + as * 40, 0.15);

      // rolling on the ground
      set(n.rumGain.gain, f.onGround && !crashed ? clamp(as / 30, 0, 1) * 0.55 : 0, 0.08);

      api.stallWarning(!!f.stalled && !f.onGround && !crashed);
      if (crashed && !wasCrashed) api.stallWarning(false);
      wasCrashed = crashed;
    },

    setMuted(m) {
      api.muted = !!m;
      if (ctx && n) set(n.master.gain, api.muted ? 0 : MASTER_VOL, 0.05);
    },

    stallWarning(on) {
      on = !!on;
      if (on === stallOn) return;
      stallOn = on;
      if (ctx && n) set(n.hornGain.gain, on ? 0.075 : 0, 0.025);
    },

    touchdown() {
      if (!ctx || !n) return;
      const t0 = ctx.currentTime;
      // two tire chirps (left / right main gear), slightly offset
      for (const [dt, pan] of [[0, -0.35], [0.045, 0.35]]) {
        const t = t0 + dt;
        const src = ctx.createBufferSource(); src.buffer = n.white;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 7;
        bp.frequency.setValueAtTime(2600, t);
        bp.frequency.exponentialRampToValueAtTime(1150, t + 0.24);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        const tone = ctx.createOscillator(); tone.type = 'sine';
        tone.frequency.setValueAtTime(1700, t);
        tone.frequency.exponentialRampToValueAtTime(900, t + 0.22);
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(0.0001, t);
        tg.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
        tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        if (p.pan) p.pan.value = pan;
        src.connect(bp).connect(g).connect(p);
        tone.connect(tg).connect(p);
        p.connect(n.master);
        src.start(t, Math.random() * 2); src.stop(t + 0.32);
        tone.start(t); tone.stop(t + 0.26);
      }
      // gear thud
      const th = ctx.createOscillator(); th.type = 'sine';
      th.frequency.setValueAtTime(95, t0);
      th.frequency.exponentialRampToValueAtTime(45, t0 + 0.15);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, t0);
      tg.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
      tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      th.connect(tg).connect(n.master);
      th.start(t0); th.stop(t0 + 0.22);
    },

    // Optional extra (not in the contract): short chime for mission events. kind: 'ring' | 'complete'.
    chime(kind = 'ring') {
      if (!ctx || !n) return;
      const t0 = ctx.currentTime + 0.01;
      const notes = kind === 'complete' ? [523.25, 659.25, 783.99, 1046.5] : [880, 1318.5];
      const step = kind === 'complete' ? 0.11 : 0.085;
      notes.forEach((hz, i) => {
        const t = t0 + i * step;
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz;
        const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = hz * 2;
        const g = ctx.createGain();
        const g2 = ctx.createGain(); g2.gain.value = 0.25;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.14, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'complete' && i === notes.length - 1 ? 1.1 : 0.45));
        o.connect(g); o2.connect(g2).connect(g); g.connect(n.master);
        o.start(t); o2.start(t); o.stop(t + 1.2); o2.stop(t + 1.2);
      });
    },

    crash() {
      if (!ctx || !n) return;
      const t = ctx.currentTime;
      // broadband impact noise, darkening as it decays
      const src = ctx.createBufferSource(); src.buffer = n.white; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(5000, t);
      lp.frequency.exponentialRampToValueAtTime(160, t + 1.6);
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 3); }
      shaper.curve = curve;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      src.connect(shaper).connect(lp).connect(g).connect(n.master);
      src.start(t); src.stop(t + 2.3);
      // metallic crunch
      const c = ctx.createBufferSource(); c.buffer = n.white;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.4;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      c.connect(bp).connect(cg).connect(n.master);
      c.start(t, 0.7); c.stop(t + 0.4);
      // low thump
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(75, t);
      o.frequency.exponentialRampToValueAtTime(26, t + 0.7);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.9, t + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      o.connect(og).connect(n.master);
      o.start(t); o.stop(t + 1.05);
      api.stallWarning(false);
    },
  };
  return api;
}
