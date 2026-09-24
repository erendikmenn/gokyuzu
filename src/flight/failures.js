// System failures (CONTRACTS-SF.md §12), shared by the fixed-wing and helicopter flight models.
//
//   flight.failures = {
//     inject(kind, opts?) → boolean      // false: unknown kind / not applicable to this aircraft
//     clear(kind?)                       // one kind, or everything (flight.reset() clears everything too)
//     active                             // Map kind → normalised opts (read-only for callers)
//     has(kind), supports(kind)
//     random: { mode: 'off'|'rare'|'realistic', suspended, source: 'auto'|'manual', seed(n), elapsed }
//   }
//   flight.on('failure', { kind, on, ...opts })     // also for changes the model makes itself (fire → engine failed,
//                                                   // fire extinguished, engine restarted: `cause` / `extinguished` / `restarted`)
//   flight.command('emergency' | 'fireHandle' | 'engineRestart' | 'apuStart' | 'gearAlternate')
//     'emergency' (key I, touch ACİL) does the next useful memory item: fire handle → alternate gear (handle down, gear
//     not locked) → APU (airliner, all engines out) → relight (restartable, inside the envelope).
//   readouts: warnings.engineFail / engineFire / hydraulic / gearUnsafe (fixed wing), engineFail / engineFire / tailRotor
//     (UH-60); engines[i].failed / .fire (fixed wing), engines[i].running / .cause (UH-60); controlLaw ('normal' |
//     'alternate' | 'direct' | 'manual' | 'degraded'), apu ('off' | 'start' | 'on'), rat, epu, hydraulics { G, Y, B } |
//     { A, B }; failInfo { fireUnhandled, fireIndex, restartable, relighting, gearAlt, gearAltOk, apuAvail };
//     ditched (airliner water landing inside the envelope: floats, event 'ditch' { verticalSpeed, pitch, roll, ias } +
//     'touchdown' { water, ditched }); 'touchdown' { belly: true } for a landing on the skids with a gear failure.
//
// Kinds (opts): engine { index (0-based, default 0), restartable (default false; true = flameout) }, engineAll
// { restartable (default: fighters true) }, fire { index, delay s before the engine fails unless the fire handle is pulled
// (default 30) }, hydraulic { systems: A320 'G'|'Y'|'B'|'G+Y'|'B+G'|'B+Y' (default 'G+Y'), 737 'A'|'B'|'A+B' (default
// 'A+B'), F-16 / F-22 'A'|'B' (default 'B') }, gear { which: 'nose'|'left'|'right'|'all' (default 'all'), alternate: the
// alternate extension works (default true) }, tailRotor { mode: 'drive' (no thrust, default) | 'fixed' (pitch frozen) }.
// The model owns the physics (fixedwing-failures.js, helicopter.js); this file keeps the bookkeeping, the events and
// the random scheduler. No DOM access (Node tests); in the browser the scheduler reads the game settings and the
// tutorial state from window.__game once a second (source 'auto').

export const FAILURE_KINDS = ['engine', 'engineAll', 'fire', 'hydraulic', 'gear', 'tailRotor'];

// ------------------------------------------------------------------------------------------------ random failures
// Real rates are far too low for a game: turbofan in-flight shutdowns run at ~2-5 per million engine hours (ETOPS
// needs < 20), gear extension and hydraulic failures are rarer still. Both modes therefore compress time and keep the
// real *relative* frequencies:
//  - 'rare' (Nadir): a constant hazard of 2 per hour of flight (mean 30 min between failures, P(failure within a 30 min
//    flight) = 1 - e^-1 = 63 %), kinds in the fleet-wide mix (IFSD most common, then hydraulic / gear, fires rarer, dual
//    engine failures rarest).
//  - 'realistic' (Gerçekçi): lower on average but weighted by the phase of flight like the real statistics: most engine
//    failures happen at take-off / climb thrust (thermal and mechanical stress peak; about 60 % of IFSDs), bird strikes
//    (the dual-engine case) below 3,000 ft at take-off and approach, gear problems show when the gear is lowered on the
//    approach, cruise is the quietest phase. Hazard per hour: take-off roll / initial climb 3.0, climb 0.8, cruise 0.2,
//    descent 0.3, approach / landing 1.2. A typical 27-min game flight (2 min take-off, 5 climb, 10 cruise, 5 descent,
//    5 approach) gets 0.33 failures on average (28 %), about one per 80 min, most of them near the ground.
// Never within the first 60 s after a start / reset, never while the tutorial runs or the scheduler is suspended
// (missions), never while another failure is active, never parked or taxiing.
export const RANDOM_RATES = {
  rare: { perHour: 2 },
  realistic: { perHour: { takeoff: 3.0, climb: 0.8, cruise: 0.2, descent: 0.3, approach: 1.2 } },
};
export const RANDOM_MIN_ELAPSED = 60;

// kind mix per phase (relative weights); kinds the aircraft cannot have or that cannot happen now are skipped
const MIX = {
  rare: { engine: 0.4, fire: 0.15, hydraulic: 0.2, gear: 0.2, engineAll: 0.05, tailRotor: 0.15 },
  takeoff: { engine: 0.55, fire: 0.15, engineAll: 0.1, hydraulic: 0.1, gear: 0, tailRotor: 0.1 },
  climb: { engine: 0.5, fire: 0.1, engineAll: 0.05, hydraulic: 0.25, gear: 0.1, tailRotor: 0.1 },
  cruise: { engine: 0.45, fire: 0.1, engineAll: 0.02, hydraulic: 0.3, gear: 0.15, tailRotor: 0.1 },
  descent: { engine: 0.4, fire: 0.1, engineAll: 0.02, hydraulic: 0.3, gear: 0.2, tailRotor: 0.1 },
  approach: { engine: 0.3, fire: 0.05, engineAll: 0.1, hydraulic: 0.15, gear: 0.45, tailRotor: 0.1 },
};

/** Failure hazard (per hour) for a mode and phase ('parked' → 0). */
export function failureRate(mode, phase) {
  if (phase === 'parked' || !phase) return 0;
  if (mode === 'rare') return RANDOM_RATES.rare.perHour;
  if (mode === 'realistic') return RANDOM_RATES.realistic.perHour[phase] ?? 0;
  return 0;
}

const MODES = new Set(['off', 'rare', 'realistic']);
const normMode = (m) => (MODES.has(m) ? m : m === true ? 'rare' : 'off');

/** Small deterministic PRNG (mulberry32) so tests can seed the scheduler; no allocation per draw. */
function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = (s) => { a = s >>> 0; };
  return rng;
}

export class FailureManager {
  /**
   * model hooks: _failNormalize(kind, opts) → opts | null, _failApply(kind, opts, on), _failPhase() → phase,
   * _failRandomOpts(kind, rng, phase) → opts | null, _emit(event, info), crashed.
   */
  constructor(model) {
    this.m = model;
    this.active = new Map();
    this.random = new RandomFailures(this);
  }

  supports(kind) { return FAILURE_KINDS.includes(kind) && !!this.m._failNormalize(kind, {}); }
  has(kind) { return this.active.has(kind); }

  inject(kind, opts = {}) {
    if (!FAILURE_KINDS.includes(kind)) return false;
    const o = this.m._failNormalize(kind, { ...(opts || {}) });
    if (!o) return false;
    if (opts && opts.random) o.random = true;                  // drawn by the random scheduler
    if (this.active.has(kind)) this._off(kind, null);          // re-injecting replaces the old one
    this.active.set(kind, o);
    this.m._failApply(kind, o, true);
    this.m._emit('failure', { kind, on: true, ...o });
    return true;
  }

  clear(kind) {
    if (kind === undefined || kind === null) {
      for (const k of FAILURE_KINDS) if (this.active.has(k)) this._off(k, {});
      return;
    }
    if (this.active.has(kind)) this._off(kind, {});
  }

  _off(kind, info) {
    const o = this.active.get(kind);
    this.active.delete(kind);
    this.m._failApply(kind, o, false);
    if (info) this.m._emit('failure', { kind, on: false, ...o, ...info });
  }

  /** The model changed a failure by itself (fire → engine failed, fire out, engine relit): bookkeeping + event. */
  _set(kind, o, info = {}) {
    this.active.set(kind, o);
    this.m._emit('failure', { kind, on: true, ...o, ...info });
  }
  _drop(kind, info = {}) {
    const o = this.active.get(kind);
    if (!o) return;
    this.active.delete(kind);
    this.m._emit('failure', { kind, on: false, ...o, ...info });
  }

  /** Per frame (after the physics): random scheduler. */
  frame(dt) { this.random.tick(dt); }
  /** New flight (model.reset): everything cleared, the 60 s grace period starts again. */
  reset() { this.clear(); this.random.reset(); }
}

class RandomFailures {
  constructor(mgr) {
    this.mgr = mgr;
    this.mode = 'off';
    this.suspended = false;       // missions / tools: no random failures while true
    this.source = 'auto';         // 'auto': mode + tutorial state from window.__game.settings / onboarding; 'manual': as set
    this.elapsed = 0;             // s of flight since the last reset (the 60 s grace period)
    this.last = null;             // { kind, t } of the last random failure (tests / telemetry)
    this.count = 0;
    this._acc = 0;
    this._hostHold = false;
    this._rng = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);
  }
  seed(n) { this._rng.seed(n); this.source = this.source === 'auto' ? 'manual' : this.source; }
  reset() { this.elapsed = 0; this._acc = 0; }

  _readHost() {
    const g = globalThis.__game;
    if (!g || g.flight !== this.mgr.m) { this._hostHold = false; return; }
    this.mode = normMode(g.settings && g.settings.failures);
    this._hostHold = !!(g.onboarding && g.onboarding.tutorialActive);
  }

  /** Once per second: draw against the phase hazard. */
  tick(dt) {
    if (!(dt > 0)) return;
    const m = this.mgr.m;
    this.elapsed += dt;
    this._acc += dt;
    if (this._acc < 1) return;
    const step = this._acc;
    this._acc = 0;
    if (this.source === 'auto') this._readHost();
    const mode = normMode(this.mode);
    if (mode === 'off' || this.suspended || this._hostHold || m.crashed || m.ditched) return;
    if (this.elapsed < RANDOM_MIN_ELAPSED || this.mgr.active.size > 0) return;
    const phase = m._failPhase();
    const lam = failureRate(mode, phase) / 3600;
    if (lam <= 0 || this._rng() >= 1 - Math.exp(-lam * step)) return;
    this.fire(mode, phase);
  }

  /** Pick a kind for the phase (weighted, skipping impossible ones) and inject it. Returns the kind or null. */
  fire(mode = this.mode, phase = this.mgr.m._failPhase()) {
    const mix = mode === 'rare' ? MIX.rare : MIX[phase] || MIX.cruise;
    let total = 0;
    for (const k of FAILURE_KINDS) if (mix[k] > 0 && this.mgr.m._failRandomOpts(k, null, phase)) total += mix[k];
    if (total <= 0) return null;
    let r = this._rng() * total;
    for (const k of FAILURE_KINDS) {
      if (!(mix[k] > 0)) continue;
      if (!this.mgr.m._failRandomOpts(k, null, phase)) continue;
      r -= mix[k];
      if (r > 0) continue;
      const o = this.mgr.m._failRandomOpts(k, this._rng, phase);
      if (o && this.mgr.inject(k, { ...o, random: true })) { this.last = { kind: k, t: this.elapsed, phase }; this.count++; return k; }
      return null;
    }
    return null;
  }
}
