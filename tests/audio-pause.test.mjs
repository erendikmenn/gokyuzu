// Audio pause sources (src/audio/index.js setPaused(p, source)): the player's pause and a mission card holding the flight
// are separate switches, and the sound stays off while either holds. With one shared boolean, pausing and resuming over a
// mission briefing or result card (Esc, Esc) turned the engines on behind the card. Run: node tests/audio-pause.test.mjs
// (a minimal Web Audio stand-in: only the gain values the pause duck writes are read).

const listeners = {};
const param = (v) => ({ value: v, setTargetAtTime(x) { this.value = x; }, setValueAtTime(x) { this.value = x; }, cancelScheduledValues() {} });
const node = (extra = {}) => ({ gain: param(1), connect(n) { return n; }, disconnect() {}, ...extra });
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = node(); }
  createGain() { return node(); }
  createDynamicsCompressor() { return node({ threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0), reduction: 0 }); }
  createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData(a) { a.fill(0); } }); }
  createBiquadFilter() { return node({ type: '', frequency: param(0), Q: param(0) }); }
  createBuffer() { return {}; }
  createBufferSource() { return node({ buffer: null, start() {}, stop() {} }); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
globalThis.window = globalThis;
globalThis.AudioContext = FakeAudioContext;
globalThis.addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
globalThis.document = { hidden: false, addEventListener() {} };
if (!globalThis.navigator || !('userActivation' in globalThis.navigator)) {
  Object.defineProperty(globalThis, 'navigator', { value: { ...(globalThis.navigator || {}), userAgent: 'node', userActivation: { hasBeenActive: true } }, configurable: true, writable: true });
}

const { createAudioSystem } = await import('../src/audio/index.js');
const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

const a = createAudioSystem({ settings: false });
a.start();
const duck = () => a.debug().gains.duck;
check('the sound plays at the start (duck open)', duck() === 1, duck());
a.setPaused(true, 'mission');            // a mission briefing holds the flight
check('mission card: silent', duck() === 0);
a.setPaused(true);                       // the player pauses over it (Esc) …
a.setPaused(false);                      // … and resumes (Esc): the card still holds the flight
check('pause + resume over a mission card: still silent', duck() === 0, duck());
a.setPaused(false, 'mission');           // "Başla"
check('the card goes away: sound again', duck() === 1, duck());
a.setPaused(true);                       // paused in flight, then the mission restarts (R) and holds …
a.setPaused(true, 'mission');
a.setPaused(false, 'mission');           // … a mission start does not undo the player's pause
check('a mission hold ending does not unpause the player\'s pause', duck() === 0, duck());
a.setPaused(false);
check('everything released: sound', duck() === 1, duck());
a.setPaused(true); a.setPaused(true); a.setPaused(false);
check('the same source twice is one switch (no counting)', duck() === 1, duck());

// the context first created while held (muted until then, unmuted on the pause screen or a mission card): no blip
const b = createAudioSystem({ settings: false });
b.setMuted(true);
b.setPaused(true, 'mission');
b.start();
check('muted at the start: no context yet', b.debug().gains === null);
b.setMuted(false);                        // "Ses" on the pause screen / the briefing: the context is created now
check('a context created while a card holds the flight starts silent (duck 0)', b.debug().gains && b.debug().gains.duck === 0, b.debug().gains && b.debug().gains.duck);

let failed = 0;
console.log('\n=== audio pause sources ' + '='.repeat(40));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(80)} ${x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
