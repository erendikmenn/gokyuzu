// Fixed-wing failure effects (CONTRACTS-SF.md §12). failures.js keeps the bookkeeping / events / random scheduler; this
// module models what each failure does on each type, following the real system architecture:
//
//  Engines   A dead engine gives no thrust but windmilling drag; on the twins the live engine yaws the nose toward the
//            dead one (fixedwing-engine.js st.yaw). A320 lateral normal law and 737 yaw damper only damp part of it:
//            the pilot holds the rudder (pedal = rudder + limited yaw damper while an engine is out); the F-22 FBW
//            includes the thrust asymmetry in its yaw inversion (automatic compensation). Relight (engineRestart) inside
//            the type's envelope for flameouts (restartable), never after a fire or a shutdown.
//  A320      Hydraulics G (engine 1 pump), Y (engine 2 pump / electric pump), B (electric pump / RAT), PTU between G and
//            Y. Both engines out: RAT → blue + emergency generator → ALTERNATE law, flaps (G+Y) lost, gear by gravity;
//            APU start (≤ FL250, 50 s) → yellow electric pump + PTU, normal law back (US Airways 1549 kept normal law
//            because the APU was started). Laws: G+Y or B+G lost or emergency electrics → alternate (no protections, roll
//            direct, stall warning), direct in pitch with the gear down; THS frozen with G+Y (no trim).
//  737-800   Hydraulics A (engine 1 pump + electric pump), B (engine 2 pump + electric pump), standby (rudder, alternate
//            flaps, reversers). A+B lost (or both engines out without the APU generator): manual reversion — elevator and
//            ailerons on their tabs (heavy: less authority, slow), no spoilers / yaw damper, electric alternate flaps
//            (slow, flaps 15 max), manual gear extension.
//  F-16      Systems A and B both drive every flight-control actuator (one lost: slower surfaces only); B also the gear,
//            brakes and nose-wheel steering (B lost: ALT GEAR pneumatic extension, accumulator brakes); A the speedbrakes.
//            Flameout: EPU (hydrazine, ≈10 min) keeps system A and the electrics; glide at 200 KIAS; airstart below
//            30,000 ft (250–400 KIAS; with the JFS below 20,000 ft from 170 KIAS).
//  F-22      Two engines each driving both systems (one engine lost: no hydraulic effect), IPP emergency power.
//  Gear      Legs that stay where they are (normal system cannot move them); alternate extension (gravity / manual /
//            pneumatic) frees them when opts.alternate is true. A landing on the belly / nacelles is a skid, not a crash,
//            while a gear failure is active (fixedwing.js _ground).
//  Fire      Warning; the engine fails after opts.delay unless the fire handle is pulled (engine shut down + agent:
//            out after a few seconds; F-16: no extinguisher, the fuel cut puts it out in ≈10 s).
//
// Effects are published in m.fx (read by fixedwing.js / fixedwing-fcs.js) and recomputed only when something changes.
import { KT, FT, clamp, moveToward } from './fixedwing-util.js';

const FEASIBLE = Object.freeze({});

/**
 * Per-type data. arm: engine lateral position (m); inlet: fan / inlet area (m²) and wmCd its windmilling drag
 * coefficient (calibrated to the published glide: A320 FCOM ENG DUAL FAILURE "2.5 NM per 1000 ft" at green dot, 737
 * ≈ 17:1 clean, F-16 ≈ 8–9:1 at 200 KIAS); wmN1: windmill N1 ≈ k × Mach (max).
 */
export const FW_TYPES = {
  a320neo: {
    arm: 5.75, inlet: 3.08, wmCd: 0.26, wmN1: [0.35, 0.3],           // LEAP-1A fan Ø 1.98 m, nacelle at 5.75 m
    hyd: 'airbus', hydSystems: ['G', 'Y', 'B'], hydDefault: 'G+Y', yawDamper: 0.25,
    relight: { windmillKt: 260, maxAlt: 27000 * FT, starterAlt: 20000 * FT, starterKt: 150, time: 45 },
    apu: { maxAlt: 25000 * FT, time: 50 }, rat: { minKt: 100, delay: 6 },
    gearAlt: 30, extinguisher: true, fireOut: 4,
    glide: { ratio: 15.2, speed: 'green dot' },
  },
  b737: {
    arm: 4.9, inlet: 1.89, wmCd: 0.26, wmN1: [0.35, 0.3],            // CFM56-7B fan Ø 1.55 m, nacelle at 4.9 m
    hyd: 'boeing', hydSystems: ['A', 'B'], hydDefault: 'A+B', yawDamper: 0.1,
    relight: { windmillKt: 250, maxAlt: 27000 * FT, starterAlt: 17000 * FT, starterKt: 150, time: 45 },
    apu: { maxAlt: 25000 * FT, time: 50 },
    gearAlt: 20, extinguisher: true, fireOut: 4, altFlapsMax: '15',
    glide: { ratio: 17, speed: 'VREF40+70' },
  },
  f16: {
    arm: 0, inlet: 0.55, wmCd: 0.3, wmN1: [0.5, 0.4],                // F110 in the fixed normal-shock inlet
    hyd: 'fighter', hydSystems: ['A', 'B'], hydDefault: 'B',
    relight: { bands: [[20000 * FT, 170, 400], [30000 * FT, 250, 400]], time: 25 },
    epu: { fuel: 600 },                                               // hydrazine ≈ 10 min
    gearAlt: 10, extinguisher: false, fireOut: 10,
    glide: { ratio: 8.5, speedKt: 200 },
  },
  f22: {
    arm: 0.7, inlet: 0.8, wmCd: 0.3, wmN1: [0.5, 0.4],
    hyd: 'fighter2', hydSystems: ['A', 'B'], hydDefault: 'B',
    relight: { bands: [[30000 * FT, 200, 450]], time: 25 },
    epu: { fuel: Infinity },                                          // IPP runs on aircraft fuel
    gearAlt: 12, extinguisher: true, fireOut: 5,
    glide: { ratio: 9, speedKt: 220 },
  },
};
function typeData(spec) {
  if (FW_TYPES[spec.id]) return FW_TYPES[spec.id];
  const fighter = spec.category === 'fighter';
  return fighter ? { ...FW_TYPES.f16, arm: (spec.engines || 1) > 1 ? 0.7 : 0 } : { ...FW_TYPES.b737, arm: (spec.structure?.nacelle?.x ?? 5) };
}

/** Neutral effect set (no failure). */
export function createFx() {
  return {
    any: false,
    law: 'normal',            // airbus normal|alternate|direct, boeing normal|manual, fighters normal|degraded
    pitchAuth: 1, rollAuth: 1, rateScale: 1, assistScale: 1,
    pedalDirect: false, yawAuth: 0.35, thrustYawComp: false,
    trimFrozen: false, trimRate: 1,
    flapRate: 1, flapMax: 99,
    gearPath: false, gearNormal: true, gearNoRetract: false, skid: false,
    speedbrakeScale: 1, groundSpoilerScale: 1, brakeScale: 1, steer: true, reverser: true, autobrake: true,
    apAvail: true, tvc: true, stallWarn: false,
  };
}

const SIDE = ['Sol', 'Sağ'];

export function createFixedWingFailures(m) {
  const spec = m.spec;
  const T = typeData(spec);
  const n = spec.engines || 1;
  const pp = m.pp;
  const fx = m.fx;
  const mgr = () => m.failures;
  for (let i = 0; i < n; i++) pp.engines[i].arm = n > 1 ? (i === 0 ? -T.arm : T.arm) : 0;
  Object.assign(pp.windmill, { area: T.inlet, cd: T.wmCd, n1k: T.wmN1[0], n1max: T.wmN1[1] });
  const flapIndexOf = (label) => { const i = spec.flapDetents.findIndex((d) => d.label === label); return i < 0 ? 99 : i; };

  // engine states: src = the failure kind that owns the out state ('engine' | 'engineAll'), cause: 'failure' |
  // 'flameout' | 'fire' | 'shutdown'
  const E = Array.from({ length: n }, () => ({ out: false, src: '', cause: '', restartable: false, relight: 0, fire: false,
    fireT: 0, delay: 30, handle: false, extT: 0 }));
  const S = {
    leak: new Set(),                 // hydraulic systems lost by the injected failure
    apu: 'off', apuT: 0,
    rat: false, ratT: 0, ratOn: false,
    epu: false, epuFuel: T.epu ? T.epu.fuel : 0,
    gear: null, gearAlt: false, gearAltPos: 0, gearN: 1, unsafeT: 0,
    h: T.hyd === 'airbus' ? { G: true, Y: true, B: true } : { A: true, B: true },
    busy: false,                     // timers running (fire, relight, APU, RAT, EPU, alternate gear)
  };
  // public readouts
  m.hydraulics = S.h;
  m.apu = 'off'; m.rat = false; m.epu = false; m.controlLaw = 'normal';
  // what the emergency key can still do (hints / UI): burning engine without the handle pulled, relight possible or
  // running, alternate gear extension used / able to free the failed legs
  const info = m.failInfo = { fireUnhandled: false, fireIndex: -1, restartable: false, relighting: false, gearAlt: false, gearAltOk: true,
    apuAvail: !!T.apu, glideKt: T.glide.speedKt ?? 0 };

  const allOut = () => { for (const e of E) if (!e.out) return false; return true; };
  const anyOut = () => { for (const e of E) if (e.out) return true; return false; };

  // ---------------------------------------------------------------------------------------------- engines
  function engineOut(i, src, cause, restartable) {
    const e = E[i], p = pp.engines[i];
    e.out = true; e.src = src; e.cause = cause; e.restartable = !!restartable; e.relight = 0;
    p.out = true; p.failed = true; p.startN1 = -1; p.xs = -1;
    pp.refresh();
  }
  function engineIn(i, spoolFromIdle) {
    const e = E[i], p = pp.engines[i];
    e.out = false; e.src = ''; e.cause = ''; e.restartable = false; e.relight = 0;
    p.out = false; p.failed = false; p.startN1 = -1; p.xs = spoolFromIdle ? 0 : -1;
    pp.refresh();
  }

  // ---------------------------------------------------------------------------------------------- recompute effects
  function recompute() {
    const run = (i) => i < n && !E[i].out;
    const apuOn = S.apu === 'on';
    const h = S.h;
    // defaults
    Object.assign(fx, createFxNeutral);
    let law = 'normal';
    if (T.hyd === 'airbus') {
      const ac = run(0) || run(1) || apuOn;
      let G = !S.leak.has('G') && run(0);
      let Y = !S.leak.has('Y') && (run(1) || apuOn);
      if (!S.leak.has('G') && !G && Y) G = true;          // PTU
      if (!S.leak.has('Y') && !Y && G) Y = true;
      const B = !S.leak.has('B') && (ac || S.ratOn);
      h.G = G; h.Y = Y; h.B = B;
      if ((!G && !Y) || (!B && !G) || !ac) law = 'alternate';
      if (!G && !Y && !B) law = 'direct';
      fx.trimFrozen = !G && !Y;
      fx.flapRate = (G ? 0.5 : 0) + (Y ? 0.5 : 0);
      fx.gearNormal = G;
      fx.speedbrakeScale = ((Y ? 2 : 0) + (B ? 1 : 0)) / 3;
      fx.groundSpoilerScale = ((G ? 2 : 0) + (Y ? 2 : 0) + (B ? 1 : 0)) / 5;
      fx.brakeScale = G ? 1 : Y ? 0.8 : 0.5;
      fx.autobrake = G; fx.steer = Y; fx.reverser = G && Y;
      fx.apAvail = law === 'normal' && ac;
      if (law !== 'normal') { fx.stallWarn = true; }
      fx.yawAuth = law === 'direct' ? 0 : T.yawDamper;
      if (law === 'direct') { fx.rollAuth = 0.3; fx.pitchAuth = 0.5; }
    } else if (T.hyd === 'boeing') {
      const ac = run(0) || run(1) || apuOn;
      const A = !S.leak.has('A') && (run(0) || ac);
      const B = !S.leak.has('B') && (run(1) || ac);
      h.A = A; h.B = B;
      if (!A && !B) {
        law = 'manual';
        fx.pitchAuth = 0.45; fx.rollAuth = 0.4; fx.rateScale = 0.4; fx.assistScale = 0.5; fx.trimRate = 0.35;
      }
      fx.flapRate = B ? 1 : 0.15;
      fx.flapMax = B ? 99 : flapIndexOf(T.altFlapsMax);
      fx.gearNormal = A;
      fx.speedbrakeScale = ((A ? 1 : 0) + (B ? 1 : 0)) / 2;
      fx.groundSpoilerScale = A ? 1 : 0;
      fx.brakeScale = B ? 1 : A ? 0.9 : 0.5;
      fx.autobrake = B; fx.steer = A || B;
      fx.apAvail = A || B;
      fx.yawAuth = B ? T.yawDamper : 0;
    } else {
      const anyRun = !allOut();
      const epuOk = S.epu && S.epuFuel > 0;
      const A = !S.leak.has('A') && (anyRun || epuOk);
      const B = !S.leak.has('B') && (anyRun || (T.hyd === 'fighter2' && epuOk));
      h.A = A; h.B = B;
      if (!(A && B)) law = 'degraded';
      fx.rateScale = A && B ? 1 : A || B ? 0.6 : 0.12;
      if (!A && !B) { fx.pitchAuth = 0.3; fx.rollAuth = 0.3; }
      fx.gearNormal = B; fx.brakeScale = B ? 1 : 0.5; fx.steer = B;
      fx.speedbrakeScale = A ? 1 : 0; fx.tvc = A || B;
    }
    fx.law = law;
    m.controlLaw = law;
    // engine out on a twin: airliner pedals become the rudder (+ limited yaw damper); FBW fighters compensate
    const asym = n > 1 && anyOut() && !allOut();
    if (spec.category === 'airliner') fx.pedalDirect = asym || law !== 'normal';
    else fx.thrustYawComp = anyOut();
    // gear
    const gearFail = !!S.gear;
    const wasPath = fx.gearPathPrev;
    fx.gearPath = gearFail || !fx.gearNormal || S.gearAlt;
    fx.gearNoRetract = S.gearAlt;
    fx.skid = gearFail;
    if (fx.gearPath && !wasPath) {
      S.gearN = m.sys.gear;
      for (const w of m._wheels) { w.leg = m.sys.gear; if (!w.gearFail) w.stuck = m.sys.gear; }
    } else if (!fx.gearPath && wasPath) {
      m.sys.gear = S.gearN;
      for (const w of m._wheels) w.leg = S.gearN;
    }
    fx.gearPathPrev = fx.gearPath;
    // skids: belly and nacelles; the nose with the nose leg up; the wingtips with a main leg up (a slow scrape)
    const noseUp = noseFailed(), mainUp = mainFailed();
    for (const s of m._structure) s.skid = gearFail && (s.kind === 'belly' || s.kind === 'nacelle' || (s.kind === 'nose' && noseUp) || (s.kind === 'wing' && mainUp));
    // anything at all?
    fx.any = law !== 'normal' || anyOut() || fx.gearPath || fx.pedalDirect || fx.thrustYawComp || S.leak.size > 0 || fx.flapRate !== 1
      || fx.brakeScale !== 1 || !fx.steer || !fx.reverser || !fx.autobrake || fx.speedbrakeScale !== 1 || fx.trimFrozen;
    // autopilot lost
    if (!fx.apAvail && m.autopilot.on) m.ap.disengage('failure');
    // readouts
    m.apu = S.apu === 'start' ? 'start' : S.apu; m.rat = S.rat; m.epu = S.epu && S.epuFuel > 0;
    S.busy = E.some((e) => e.fire || e.relight > 0) || S.apu === 'start' || anyOut() || S.epu || S.gearAlt;
    info.fireIndex = E.findIndex((e) => e.fire && !e.handle); info.fireUnhandled = info.fireIndex >= 0;
    info.restartable = E.some((e) => e.out && e.restartable && !e.fire);
    info.relighting = E.some((e) => e.relight > 0);
    info.gearAlt = S.gearAlt;
    info.gearAltOk = !S.gear || m._wheels.some((w) => w.gearFail && w.altOk);
    for (let i = 0; i < n; i++) pp.engines[i].fire = E[i].fire;
  }
  const createFxNeutral = createFx();
  delete createFxNeutral.gearPathPrev;
  const noseFailed = () => m._wheels.some((w) => w.gearFail && w.kind !== 'main');
  const mainFailed = () => m._wheels.some((w) => w.gearFail && w.kind === 'main');

  // ---------------------------------------------------------------------------------------------- normalise / apply
  function normalize(kind, o) {
    const index = Number.isInteger(o.index) ? o.index : 0;
    switch (kind) {
      case 'engine': {
        if (index < 0 || index >= n) return null;
        // single-engine fighter: an engine failure is a flameout, airstart possible unless said otherwise
        const r = o.restartable ?? (o.cause ? o.cause === 'flameout' : n === 1 && spec.category === 'fighter');
        return { index, restartable: !!r, cause: o.cause || (r ? 'flameout' : 'failure') };
      }
      case 'engineAll': {
        const r = o.restartable ?? (o.cause ? o.cause === 'flameout' : spec.category === 'fighter');
        return { restartable: r, cause: o.cause || (r ? 'flameout' : 'failure') };
      }
      case 'fire':
        if (index < 0 || index >= n) return null;
        return { index, delay: Number.isFinite(o.delay) ? Math.max(0, o.delay) : 30 };
      case 'hydraulic': {
        const list = String(o.systems || T.hydDefault).toUpperCase().split(/[+,\s]+/).filter(Boolean);
        if (!list.length || list.some((x) => !T.hydSystems.includes(x))) return null;
        const uniq = T.hydSystems.filter((x) => list.includes(x));
        return { systems: uniq.join('+') };
      }
      case 'gear': {
        const which = o.which || 'all';
        if (!['nose', 'left', 'right', 'all'].includes(which)) return null;
        return { which, alternate: o.alternate !== false };
      }
      default: return null;       // tailRotor: helicopters only
    }
  }

  function apply(kind, o, on) {
    switch (kind) {
      case 'engine':
        if (on) engineOut(o.index, 'engine', o.cause, o.restartable);
        else for (let i = 0; i < n; i++) if (E[i].out && E[i].src === 'engine') engineIn(i, false);
        break;
      case 'engineAll':
        if (on) { for (let i = 0; i < n; i++) if (!E[i].out) engineOut(i, 'engineAll', o.cause, o.restartable); }
        else for (let i = 0; i < n; i++) if (E[i].out && E[i].src === 'engineAll') engineIn(i, false);
        break;
      case 'fire': {
        const e = E[o.index];
        if (on) { e.fire = true; e.fireT = 0; e.delay = o.delay; e.handle = false; e.extT = 0; }
        else { for (const x of E) { x.fire = false; x.handle = false; x.extT = 0; } }
        break;
      }
      case 'hydraulic':
        S.leak.clear();
        if (on) for (const x of o.systems.split('+')) S.leak.add(x);
        break;
      case 'gear':
        if (on) {
          S.gear = o;
          for (const w of m._wheels) {
            const hit = o.which === 'all' || (o.which === 'nose' && w.kind !== 'main') || (w.kind === 'main' && ((o.which === 'left' && w.r0.x < 0) || (o.which === 'right' && w.r0.x > 0)));
            w.gearFail = hit; w.altOk = o.alternate;
            if (hit) w.stuck = fx.gearPath && Number.isFinite(w.leg) ? w.leg : m.sys.gear;   // stays where it is now
          }
        } else {
          S.gear = null;
          for (const w of m._wheels) w.gearFail = false;
        }
        break;
      default: break;
    }
    if (!on && !m.failures.active.size) resetAux();
    recompute();
  }

  /** Everything back to normal (all failures cleared / reset). */
  function resetAux() {
    for (let i = 0; i < n; i++) { const e = E[i]; e.fire = false; e.handle = false; e.extT = 0; if (e.out) engineIn(i, false); }
    S.leak.clear();
    S.apu = 'off'; S.apuT = 0; S.rat = false; S.ratT = 0; S.ratOn = false;
    S.epu = false; S.epuFuel = T.epu ? T.epu.fuel : 0;
    S.gear = null; S.gearAlt = false; S.gearAltPos = 0; S.unsafeT = 0;
    for (const w of m._wheels) w.gearFail = false;
  }

  // ---------------------------------------------------------------------------------------------- per frame
  function frame(dt) {
    if (!S.busy) return;
    let change = false;
    const ias = m.ad.ias, air = !m.wow;
    // fire: the engine fails after the delay unless the handle is pulled; handle → out after fireOut s
    for (let i = 0; i < n; i++) {
      const e = E[i];
      if (!e.fire) continue;
      e.fireT += dt;
      if (!e.handle && !e.out && e.fireT >= e.delay) {
        engineOut(i, 'engine', 'fire', false);
        mgr()._set('engine', { index: i, restartable: false, cause: 'fire' });
        change = true;
      }
      if (e.handle && (e.extT += dt) >= T.fireOut) {
        e.fire = false; e.handle = false;
        mgr()._drop('fire', { extinguished: true });
        change = true;
      }
    }
    // relight: N1 climbs from windmill to idle, then the engine spools up on its own
    for (let i = 0; i < n; i++) {
      const e = E[i];
      if (!(e.relight > 0)) continue;
      e.relight -= dt;
      const p = pp.engines[i];
      const n1i = spec.engine.n1Idle ?? 0.2;
      p.startN1 = n1i * clamp(1 - e.relight / T.relight.time, 0, 1);
      if (e.relight <= 0) {
        const src = e.src;
        engineIn(i, true);
        let left = false;
        for (const x of E) if (x.out && x.src === src) left = true;
        if (!left) mgr()._drop(src, { restarted: true });
        change = true;
      }
    }
    // APU
    if (S.apu === 'start' && (S.apuT += dt) >= T.apu.time) { S.apu = 'on'; change = true; m._emit('warning', { type: 'apu', on: true }); }
    // A320 RAT: deploys when both engines are out in flight above 100 kt, on line a few seconds later
    if (T.rat && allOut() && air && !S.rat && ias > T.rat.minKt * KT) { S.rat = true; S.ratT = 0; change = true; m._emit('warning', { type: 'rat', on: true }); }
    if (S.rat && !S.ratOn && (S.ratT += dt) >= T.rat.delay) { S.ratOn = true; change = true; }
    // F-16 EPU / F-22 IPP: automatic with all engines out (or both hydraulic systems low)
    if (T.epu) {
      const need = allOut() && air;
      if (need && !S.epu) { S.epu = true; change = true; m._emit('warning', { type: 'epu', on: true }); }
      else if (!allOut() && S.epu) { S.epu = false; change = true; }
      if (S.epu && S.epuFuel > 0 && (S.epuFuel -= dt) <= 0) change = true;
    }
    if (change) recompute();
  }

  /** Gear legs while the failure path is active (called from _systems each sub-step). */
  function gear(h) {
    const sys = m.sys, G = spec.gear;
    if (fx.gearNormal && !S.gearAlt) S.gearN = moveToward(S.gearN, sys.gearHandleDown ? 1 : 0, h / (sys.gearHandleDown ? (G.extendTime ?? 8) : (G.retractTime ?? 8)));
    if (S.gearAlt) S.gearAltPos = moveToward(S.gearAltPos, 1, h / T.gearAlt);
    let mn = 1;
    for (const w of m._wheels) {
      let p = w.gearFail ? w.stuck : S.gearN;
      if (S.gearAlt && (!w.gearFail || w.altOk)) p = Math.max(p, S.gearAltPos);
      w.leg = p;
      if (p < mn) mn = p;
    }
    sys.gear = mn;
    S.unsafeT = sys.gearHandleDown || S.gearAlt ? S.unsafeT + h : 0;
  }

  // ---------------------------------------------------------------------------------------------- commands
  function inRelightEnvelope() {
    const R = T.relight, ias = m.ad.ias / KT, alt = m._pos.y;
    if (R.bands) { for (const [maxAlt, lo, hi] of R.bands) if (alt <= maxAlt && ias >= lo && ias <= hi) return true; return false; }
    if (alt > R.maxAlt) return false;
    if (ias >= R.windmillKt) return true;                                       // windmilling relight
    return S.apu === 'on' && alt <= R.starterAlt && ias >= R.starterKt;          // starter assisted (APU bleed)
  }

  function command(action) {
    const air = !m.wow;
    switch (action) {
      case 'fireHandle': {
        const i = E.findIndex((e) => e.fire && !e.handle);
        if (i < 0) return false;
        const e = E[i];
        e.handle = true; e.extT = 0;
        if (!e.out) { engineOut(i, 'engine', 'shutdown', false); mgr()._set('engine', { index: i, restartable: false, cause: 'shutdown' }); }
        else { e.restartable = false; }
        m._emit('warning', { type: 'fireHandle', on: true, index: i });
        recompute();
        return true;
      }
      case 'engineRestart': {
        const idx = E.findIndex((e) => e.out && e.restartable && !e.fire && !(e.relight > 0));
        if (idx < 0) { m._emit('warning', { type: 'restartUnavailable', on: true }); return false; }
        if (!air || !inRelightEnvelope()) { m._emit('warning', { type: 'restartEnvelope', on: true }); return false; }
        for (const e of E) if (e.out && e.restartable && !e.fire && !(e.relight > 0)) e.relight = T.relight.time;
        m._emit('warning', { type: 'relight', on: true });
        recompute();
        return true;
      }
      case 'apuStart': {
        if (!T.apu || S.apu !== 'off') return false;
        if (m._pos.y > T.apu.maxAlt) { m._emit('warning', { type: 'apuEnvelope', on: true }); return false; }
        S.apu = 'start'; S.apuT = 0;
        recompute();
        return true;
      }
      case 'gearAlternate': {
        if (S.gearAlt) return false;
        if (!fx.gearPath) return false;
        S.gearAlt = true; S.gearAltPos = 0;
        m.sys.gearHandleDown = true; m.gearHandleDown = true;
        m._emit('gear', { down: true, alternate: true });
        recompute();
        return true;
      }
      case 'emergency': {
        // the contextual emergency key (I / ACİL): the next useful memory item
        if (E.some((e) => e.fire && !e.handle)) return command('fireHandle');
        if (fx.gearPath && !S.gearAlt && m.sys.gear < 0.98 && m.sys.gearHandleDown) return command('gearAlternate');
        if (T.apu && allOut() && S.apu === 'off' && air) return command('apuStart');
        if (E.some((e) => e.out && e.restartable && !e.fire && !(e.relight > 0))) return command('engineRestart');
        m._emit('warning', { type: 'noEmergency', on: true });
        return false;
      }
      default: return false;
    }
  }

  // ---------------------------------------------------------------------------------------------- warnings / phase
  function warnings(set) {
    let fire = false;
    for (const e of E) if (e.fire) fire = true;
    set('engineFire', fire);
    set('engineFail', anyOut());
    const hydLow = T.hyd === 'airbus' ? !(S.h.G && S.h.Y && S.h.B) : !(S.h.A && S.h.B);
    set('hydraulic', hydLow);
    const unsafe = fx.gearPath && (m.sys.gearHandleDown || S.gearAlt) && m.sys.gear < 0.98 && S.unsafeT > (spec.gear.extendTime ?? 8) + 1;
    set('gearUnsafe', !!unsafe);
  }

  function phase() {
    if (m.crashed || m.ditched) return 'parked';
    if (m.wow || m.onGround) return m.groundSpeed > 20 && (m._lever ?? 0) > 0.5 ? 'takeoff' : 'parked';
    if (m._takeoffMode || m._climbout) return 'takeoff';
    const ft = m.agl / FT;
    if (m.sys.gearHandleDown || (ft < 3000 && m.verticalSpeed < -1)) return 'approach';
    if (m.verticalSpeed > 2.5) return 'climb';
    if (m.verticalSpeed < -2.5) return 'descent';
    return 'cruise';
  }

  /** Random-failure options (rng) or a feasibility check (rng = null). */
  function randomOpts(kind, rng, ph) {
    const air = !m.wow;
    switch (kind) {
      case 'engine':
        if (anyOut()) return null;
        if (!rng) return FEASIBLE;
        return { index: n > 1 && rng() < 0.5 ? 1 : 0, restartable: rng() < (n === 1 ? 0.6 : 0.3) };
      case 'engineAll':
        if (n < 2 || anyOut() || !air) return null;
        if (ph !== 'rare' && m.agl > 900) return null;             // bird strikes: low altitude
        if (!rng) return FEASIBLE;
        return { restartable: rng() < 0.3 };
      case 'fire':
        if (allOut()) return null;
        if (!rng) return FEASIBLE;
        { let i = n > 1 && rng() < 0.5 ? 1 : 0; if (E[i].out) i = 1 - i; return { index: i }; }
      case 'hydraulic': {
        if (S.leak.size) return null;
        if (!rng) return FEASIBLE;
        const opts = T.hyd === 'airbus' ? ['G+Y', 'G+Y', 'B+G', 'G', 'Y', 'B'] : T.hyd === 'boeing' ? ['A+B', 'A+B', 'A', 'B'] : ['A', 'B', 'B'];
        return { systems: opts[Math.floor(rng() * opts.length) % opts.length] };
      }
      case 'gear': {
        if (!air || S.gear || m.sys.gear > 0.02 || m.sys.gearHandleDown) return null;   // shows when the gear is lowered
        if (!rng) return FEASIBLE;
        const r = rng();
        return { which: r < 0.35 ? 'all' : r < 0.7 ? 'nose' : r < 0.85 ? 'left' : 'right', alternate: rng() < 0.7 };
      }
      default: return null;
    }
  }

  /** Short Turkish name of engine i ('Sol motor' / 'Motor'). */
  const engineName = (i) => (n > 1 ? `${SIDE[i] || 'Motor'} motor` : 'Motor');

  recompute();
  return { T, E, S, normalize, apply, frame, gear, command, warnings, phase, randomOpts, recompute, resetAux, engineName, inRelightEnvelope,
    get busy() { return S.busy; } };
}
