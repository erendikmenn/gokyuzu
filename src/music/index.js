// Gökyüzü SF music player: menu / flight playlists over the soundtrack in assets/music/ (src/music/tracks.js).
//
//  - Streams lazily: nothing is requested before music actually plays (two <audio> decks, src set on play; the next
//    track is preloaded ~15 s before the crossfade). URLs go through assetUrl (CONTRACTS-SF.md §9).
//  - Own Web Audio graph, created on the first user gesture (autoplay rules), independent of the game mix:
//      <audio> deck A / B → fade gain → level (music volume² × context trim) → duck → out (master² × mute) → speakers
//  - Settings (src/core/settings.js, applied live from the 'gokyuzu:settings' event): volumes.music (0..1, "Müzik"),
//    volumes.master, musicMenu (default on), musicFlight (default off).
//  - Game state from main.js: setContext('menu' | 'flight'), setPaused, setMuted, update(dt, flight) every frame
//    (ducks the music while a cockpit warning / callout plays).
//  - Pause stops the music (fade, position kept) unless the player uses the music control on the pause screen
//    (preview); M mutes it with the game; hidden tab pauses it.
import { assetUrl, loadAssetVersions } from '../core/assets.js';
import { loadSettings } from '../core/settings.js';
import { TRACKS, FIRST } from './tracks.js';

const DIR = new URL('../../assets/music/', import.meta.url).href;
export const MUSIC_DEFAULTS = { volume: 0.6, menu: true, flight: false };
const CROSSFADE = 4;        // s, automatic track change (tools/music/build.py checks the files for it)
const NEXT_FADE = 1.2;      // s, "next" pressed
const START_FADE = 2.5;     // s, music starts / resumes
const STOP_FADE = 2.5;      // s, music turned off / context without music
const HOLD_FADE = 0.4;      // s, pause / mute / hidden tab
const PRELOAD = 15;         // s before the crossfade the next track starts buffering
const FLIGHT_TRIM = 10 ** (-4 / 20);   // in flight the music sits 4 dB lower than in the menu (files are at -18 LUFS)
const DUCK = 10 ** (-12 / 20);         // while a warning / callout plays
const DUCK_HOLD = 0.8;                 // s the duck stays after the alert ends
const EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend'];

let instance = null;
const waiting = [];
/** The player created by main.js (null before, e.g. on dev pages): the UI's music controls use it. */
export function getMusicPlayer() { return instance; }
/** fn(player) now or once main.js has created it (UI built before the player). */
export function onMusicPlayer(fn) { if (instance) fn(instance); else waiting.push(fn); }

export function createMusicPlayer({ audio = null, toast = true } = {}) {
  let ctx = null, G = null;
  const decks = [];
  let cur = null;                 // deck holding the current track
  let context = 'none';           // 'none' | 'menu' | 'flight'
  let category = null;            // aircraft category in flight ('fighter' opens with the energetic track)
  let paused = false, muted = false, preview = false;
  let hidden = typeof document !== 'undefined' && document.hidden;
  const cfg = { volume: MUSIC_DEFAULTS.volume, master: 0.9, menu: MUSIC_DEFAULTS.menu, flight: MUSIC_DEFAULTS.flight };
  const queues = {};              // per playlist: { order: [ids], i }
  let lastId = null;
  const failed = new Set();
  let versionsReady = false;
  const duck = { on: false, until: 0, poll: 0, voice: false };
  const listeners = new Set();
  let announcer = null;           // (title) => true when the game showed the now-playing note itself (HUD in flight)
  const warned = new Set();
  const warnOnce = (k, ...a) => { if (!warned.has(k)) { warned.add(k); console.warn('[music]', ...a); } };

  const probe = typeof Audio !== 'undefined' ? new Audio() : null;
  const supported = !!(probe && probe.canPlayType && probe.canPlayType('audio/mp4; codecs="mp4a.40.2"'));
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);

  readSettings(safe(loadSettings, null));

  // ------------------------------------------------------------------------------------------------ settings
  function readSettings(s) {
    if (!s) return;
    const v = s.volumes || {};
    cfg.volume = num(v.music, MUSIC_DEFAULTS.volume);
    cfg.master = num(v.master, 0.9);
    cfg.menu = typeof s.musicMenu === 'boolean' ? s.musicMenu : MUSIC_DEFAULTS.menu;
    cfg.flight = typeof s.musicFlight === 'boolean' ? s.musicFlight : MUSIC_DEFAULTS.flight;
  }

  // ------------------------------------------------------------------------------------------------ audio graph
  const hasGesture = () => { const ua = typeof navigator !== 'undefined' && navigator.userActivation; return !ua || ua.hasBeenActive; };

  function ensureContext() {
    if (ctx) {
      if (ctx.state === 'suspended' && !hidden) ctx.resume().catch(() => {});
      return ctx;
    }
    if (!AC || !supported || !hasGesture()) return null;
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { warnOnce('ac', 'AudioContext failed', e); return null; }
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    G = { level: g(levelGain()), duck: g(1), out: g(outGain()) };
    G.level.connect(G.duck).connect(G.out).connect(ctx.destination);
    for (let i = 0; i < 2; i++) decks.push(makeDeck());
    // (called from a user gesture) Safari lifts its per-element playback restriction on load()/play() during a gesture:
    // touch both decks now so later crossfades may start without one. No source yet, so nothing is downloaded.
    for (const d of decks) { try { d.el.load(); } catch { /* ignore */ } }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function makeDeck() {
    const el = new Audio();
    el.preload = 'none';
    const d = { el, gain: ctx.createGain(), track: null, timer: 0, fading: false, prepared: false };
    d.gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(d.gain).connect(G.level);
    el.addEventListener('timeupdate', () => onTime(d));
    el.addEventListener('ended', () => { if (d === cur) advance(0.6); });
    el.addEventListener('error', () => onError(d));
    for (const ev of ['playing', 'pause']) el.addEventListener(ev, () => { if (d === cur) emit(); });
    return d;
  }

  const levelGain = () => cfg.volume * cfg.volume * (context === 'flight' ? FLIGHT_TRIM : 1);
  const outGain = () => (muted ? 0 : cfg.master * cfg.master);

  function applyLevels(tau = 0.05) {
    if (!G) return;
    const t = ctx.currentTime;
    G.level.gain.setTargetAtTime(levelGain(), t, tau);
    G.out.gain.setTargetAtTime(outGain(), t, tau);
  }

  /** Linear fade of a deck from its current gain (anchored now: a ramp would otherwise start at the last old event). */
  function ramp(d, to, dur) {
    const p = d.gain.gain, t = ctx.currentTime;
    const v = p.value;
    p.cancelScheduledValues(0);
    p.setValueAtTime(v, t);
    p.linearRampToValueAtTime(to, t + Math.max(0.02, dur));
  }

  // ------------------------------------------------------------------------------------------------ playlists
  function listName() { return context === 'flight' ? (category === 'fighter' ? 'fighter' : 'flight') : context; }
  function inList(id, name = listName()) {
    const t = TRACKS.find((x) => x.id === id);
    return !!t && t.lists.includes(name === 'fighter' ? 'flight' : name);
  }

  function pickNext() {
    const name = listName();
    const ids = TRACKS.filter((t) => inList(t.id, name) && !failed.has(t.id)).map((t) => t.id);
    if (!ids.length) return null;
    let q = queues[name];
    if (!q || q.i >= q.order.length) {
      const order = shuffle(ids.slice());
      if (!q) {                                  // a playlist's first round opens with its signature track
        const first = FIRST[name] && ids.includes(FIRST[name]) ? FIRST[name]
          : order.find((id) => !TRACKS.find((t) => t.id === id).energetic);
        if (first) order.splice(order.indexOf(first), 1), order.unshift(first);
      }
      if (order.length > 1 && order[0] === lastId) order.push(order.shift());
      q = queues[name] = { order, i: 0 };
    }
    const id = q.order[q.i++];
    return ids.includes(id) ? id : pickNext();
  }

  // ------------------------------------------------------------------------------------------------ playback
  /** Should music be audible right now? */
  function wanted() {
    const on = context === 'menu' ? cfg.menu : context === 'flight' ? cfg.flight : false;
    return supported && on;
  }
  /** Keep the track but silence it (position kept): pause screen, mute, hidden tab, volume at zero. */
  const holding = () => muted || hidden || (paused && !preview) || cfg.volume <= 0.001 || cfg.master <= 0.001;

  /** Bring the players in line with the state (called after every change). */
  function sync() {
    if (!wanted()) { if (cur) stop(STOP_FADE); return; }
    if (holding()) { if (cur) hold(); return; }
    if (!ensureContext()) { hookGesture(); return; }
    if (cur && cur.track && inList(cur.track.id)) resume(cur);
    else advance(cur ? CROSSFADE : START_FADE);
  }

  function load(d, id) {
    const t = TRACKS.find((x) => x.id === id);
    d.track = t;
    d.prepared = true;
    d.el.preload = 'auto';
    d.el.src = assetUrl(DIR + id + '.m4a');
    return t;
  }

  /** Start the next track of the current playlist on the free deck and crossfade to it over `fade` seconds. */
  function advance(fade) {
    if (!ctx) return;
    if (!versionsReady) {    // a gesture before the asset version map arrived (not in the menu flow): start once it has
      loadAssetVersions().catch(() => {}).finally(() => { versionsReady = true; sync(); });
      return;
    }
    const other = decks.find((d) => d !== cur);
    if (other.track && !other.el.paused && other.gain.gain.value > 0.02) {
      // "next" pressed again while that deck is still fading out: a 30 ms dip first instead of a click
      ramp(other, 0, 0.03);
      clearTimeout(other.timer);
      other.timer = setTimeout(() => { release(other); advance(fade); }, 40);
      return;
    }
    let id = other.prepared && other.track && inList(other.track.id) ? other.track.id : null;
    if (!id) {
      id = pickNext();
      if (!id) { stop(STOP_FADE); return; }
      release(other);
      load(other, id);
    }
    const old = cur;
    cur = other;
    cur.prepared = false;
    lastId = id;
    if (old) fadeOut(old, fade, true);
    clearTimeout(cur.timer);
    cur.fading = false;
    try { cur.el.currentTime = 0; } catch { /* not loaded yet */ }
    play(cur, fade);
    if (toast && !(announcer && safe(() => announcer(cur.track.title), false))) showToast(cur.track.title);
    emit();
  }

  function play(d, fade) {
    const p = d.el.play();
    // fade in once audio flows (a track that is still buffering would otherwise swallow part of its fade)
    if (d.el.readyState >= 3) ramp(d, 1, fade);
    else d.el.addEventListener('playing', () => { if (d === cur && !holding()) ramp(d, 1, fade); }, { once: true });
    if (p && p.catch) {
      p.catch((e) => {
        if (d !== cur) return;
        if (e && e.name === 'NotAllowedError') { hookGesture(); return; }   // Safari: the next gesture resumes it
        if (e && e.name !== 'AbortError') warnOnce('play:' + (d.track && d.track.id), 'play failed', e.message || e);
      });
    }
  }

  function resume(d) {
    clearTimeout(d.timer);
    d.fading = false;
    if (d.el.paused) play(d, START_FADE * 0.5);
    else ramp(d, 1, START_FADE * 0.5);
  }

  /** Pause (keep the position): pause screen, mute, hidden tab. */
  function hold() {
    for (const d of decks) {
      if (!d.track || d.el.paused) continue;
      if (d !== cur) { release(d); continue; }
      ramp(d, 0, HOLD_FADE);
      clearTimeout(d.timer);
      d.timer = setTimeout(() => { if (holding() || !wanted()) d.el.pause(); }, HOLD_FADE * 1000 + 60);
    }
    emit();
  }

  /** Music off for this context: fade out and free the decks (a later start opens a fresh track). */
  function stop(fade) {
    for (const d of decks) if (d.track) fadeOut(d, d.el.paused ? 0 : fade, true);
    cur = null;
    emit();
  }

  function fadeOut(d, fade, andRelease) {
    if (!ctx) return;
    ramp(d, 0, fade);
    d.fading = true;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => { if (d !== cur) (andRelease ? release(d) : d.el.pause()); }, fade * 1000 + 80);
  }

  /** Stop a deck and drop its source (ends the download). */
  function release(d) {
    clearTimeout(d.timer);
    d.fading = false;
    if (!d.track && !d.el.getAttribute('src')) return;
    d.track = null;
    d.prepared = false;
    d.gain.gain.cancelScheduledValues(0);
    d.gain.gain.value = 0;
    d.el.pause();
    d.el.removeAttribute('src');
    d.el.preload = 'none';
    try { d.el.load(); } catch { /* ignore */ }
  }

  function onTime(d) {
    if (d !== cur || d.fading || holding()) return;
    const dur = d.el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const left = dur - d.el.currentTime;
    const other = decks.find((x) => x !== d);
    if (left <= CROSSFADE + PRELOAD && !other.prepared && !other.track) {
      const id = pickNext();
      if (id) load(other, id);                  // buffer the next track before the crossfade
    }
    if (left <= CROSSFADE) advance(CROSSFADE);
  }

  function onError(d) {
    if (!d.track) return;                        // src removed on purpose
    const id = d.track.id;
    failed.add(id);
    warnOnce('err:' + id, `could not play ${id}.m4a (${d.el.error ? d.el.error.code : '?'})`);
    const wasCur = d === cur;
    release(d);
    if (wasCur) {
      cur = null;
      if (TRACKS.some((t) => inList(t.id) && !failed.has(t.id))) setTimeout(sync, 1500);
      else emit();
    }
  }

  // ------------------------------------------------------------------------------------------------ gesture / tab
  let gestureHooked = false;
  function hookGesture() {
    if (gestureHooked) return;
    gestureHooked = true;
    const go = () => {
      if (ctx && ctx.state === 'suspended' && !hidden) ctx.resume().catch(() => {});
      if (!cur || (cur.el.paused && !holding())) sync();
    };
    for (const ev of EVENTS) window.addEventListener(ev, go, { passive: true, capture: true });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      hidden = document.hidden;
      if (ctx && !hidden && ctx.state === 'suspended') ctx.resume().catch(() => {});
      sync();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('gokyuzu:settings', (e) => {
      const before = { ...cfg };
      readSettings(e.detail);
      applyLevels();
      if (before.menu !== cfg.menu || before.flight !== cfg.flight || (before.volume > 0.001) !== (cfg.volume > 0.001)
        || (before.master > 0.001) !== (cfg.master > 0.001)) sync();
      emit();
    });
    loadAssetVersions().then(() => { versionsReady = true; }, () => {});   // memoized: the game already loads it
  }

  // ------------------------------------------------------------------------------------------------ ducking
  // Warnings come from the flight model (flight.warnings / stalled / crashed); callouts from the audio system
  // (`audio.alertActive` when it offers one, else its debug state, polled at 5 Hz).
  function alertNow(flight, t) {
    if (audio && typeof audio.alertActive === 'boolean') return audio.alertActive || warningsOn(flight);
    if (audio && audio.debug && t >= duck.poll) {
      duck.poll = t + 0.2;
      try { const d = audio.debug(); duck.voice = !!(d && (d.voice || d.apd)); } catch { duck.voice = false; }
    }
    return duck.voice || warningsOn(flight);
  }

  function update(dt, flight) {
    if (!G) return;
    const t = ctx.currentTime;
    const alert = !!flight && context === 'flight' && alertNow(flight, t);
    if (alert) duck.until = t + DUCK_HOLD;
    const on = alert || t < duck.until;
    if (on !== duck.on) {
      duck.on = on;
      G.duck.gain.setTargetAtTime(on ? DUCK : 1, t, on ? 0.04 : 0.5);   // fast down, slow back up
    }
  }

  // ------------------------------------------------------------------------------------------------ toast
  let toastEl = null, toastTimer = 0;
  function showToast(title) {
    if (typeof document === 'undefined') return;
    if (!toastEl) {
      const st = document.createElement('style');
      st.textContent = `.gkm-toast { position: fixed; top: 10px; right: 16px; z-index: 58; display: flex; align-items: center; gap: 8px;
  padding: 6px 13px 6px 10px; border-radius: 999px; font: 600 12.5px var(--gk-sans, -apple-system, system-ui, sans-serif); color: rgba(236, 244, 255, .92);
  background: rgba(8, 14, 26, .78); border: 1px solid rgba(92, 242, 200, .28); box-shadow: 0 8px 24px rgba(0, 0, 0, .3);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); pointer-events: none; opacity: 0; transform: translateY(-6px);
  transition: opacity .35s ease, transform .35s ease; }
.gkm-toast.show { opacity: 1; transform: none; }
.gkm-toast b { color: var(--gk-teal, #5cf2c8); font-weight: 700; font-size: 13px; line-height: 1; }
.gkm-toast small { color: rgba(208, 222, 240, .6); font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }`;
      document.head.append(st);
      toastEl = document.createElement('div');
      toastEl.className = 'gkm-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('lang', 'tr');
      document.body.append(toastEl);
    }
    toastEl.replaceChildren();
    const icon = document.createElement('b'); icon.textContent = '♪';
    const lab = document.createElement('small'); lab.textContent = 'Müzik';
    toastEl.append(icon, lab, document.createTextNode(title));
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3800);
  }

  // ------------------------------------------------------------------------------------------------ API
  function emit() { const s = api.state; for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } } }

  const api = {
    /** 'menu' (menu + loading screen) | 'flight'; `category` = aircraft category ('fighter' opens with the energetic track). */
    setContext(name, { category: cat = null } = {}) {
      const changed = name !== context || (name === 'flight' && cat !== category);
      context = name;
      category = cat;
      if (!changed) return;
      applyLevels(0.4);
      if (cur && cur.track && !inList(cur.track.id)) {   // the track does not belong here: fade to this playlist
        if (wanted() && !holding() && ctx) advance(CROSSFADE); else stop(STOP_FADE);
      } else sync();
      emit();
    },
    setPaused(p) { paused = !!p; preview = false; sync(); },
    setMuted(m) { muted = !!m; applyLevels(0.03); sync(); },
    update,
    /** Next track (crossfade). On the pause screen it also lets the music play (preview). */
    next() {
      if (!wanted()) return;
      if (paused) preview = true;
      if (!ensureContext()) { hookGesture(); return; }
      if (holding()) return;
      advance(cur ? NEXT_FADE : START_FADE);
    },
    /** The music controls on the pause screen: let the music play while paused. */
    preview() { if (paused) { preview = true; sync(); } },
    /** { context, enabled (for this context), playing, track: { id, title } | null, supported, volume } */
    get state() {
      const playing = !!(cur && cur.track && !cur.el.paused && !holding());
      return {
        context, enabled: context === 'menu' ? cfg.menu : context === 'flight' ? cfg.flight : false, playing,
        track: cur && cur.track ? { id: cur.track.id, title: cur.track.title } : null, supported, volume: cfg.volume,
      };
    },
    /** fn(title) → true if it announced a new track itself (main.js: HUD message in flight); else the player's own toast. */
    setAnnouncer(fn) { announcer = typeof fn === 'function' ? fn : null; },
    /** fn(state) on every change (track, on/off, pause). Returns an unsubscribe function. */
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    tracks: TRACKS.map(({ id, title, lists }) => ({ id, title, lists: [...lists] })),
    /** Test hook: jump the current track to `left` seconds before its end (crossfade checks). */
    seekEnd(left = CROSSFADE + 2) {
      if (cur && Number.isFinite(cur.el.duration)) cur.el.currentTime = Math.max(0, cur.el.duration - left);
    },
    debug() {
      let rmsDb = null;
      if (G && !G.meter) {                       // output level meter, created by the first debug() call (tests)
        G.meter = ctx.createAnalyser();
        G.meter.fftSize = 2048;
        G.out.connect(G.meter);
      }
      if (G) {
        const b = new Float32Array(G.meter.fftSize);
        G.meter.getFloatTimeDomainData(b);
        let sq = 0;
        for (let i = 0; i < b.length; i++) sq += b[i] * b[i];
        rmsDb = +(10 * Math.log10(sq / b.length + 1e-12)).toFixed(1);
      }
      return {
        rmsDb,
        ctx: ctx ? ctx.state : 'none', context, category, paused, muted, preview, hidden, cfg: { ...cfg }, versionsReady,
        duck: G ? +G.duck.gain.value.toFixed(3) : null, level: G ? +G.level.gain.value.toFixed(3) : null, out: G ? +G.out.gain.value.toFixed(3) : null,
        decks: decks.map((d) => ({ id: d.track && d.track.id, src: d.el.getAttribute('src'), paused: d.el.paused, t: +d.el.currentTime.toFixed(2),
          dur: Number.isFinite(d.el.duration) ? +d.el.duration.toFixed(1) : null, gain: +d.gain.gain.value.toFixed(3), cur: d === cur })),
        failed: [...failed],
      };
    },
  };
  instance = api;
  for (const fn of waiting.splice(0)) { try { fn(api); } catch (e) { console.error(e); } }
  if (typeof window !== 'undefined') window.__music = api;   // test hook
  return api;
}

function warningsOn(flight) {
  if (flight.crashed || flight.stalled) return true;
  const w = flight.warnings;
  if (w) for (const k in w) if (w[k]) return true;
  return false;
}
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d; }
function safe(fn, d) { try { return fn(); } catch { return d; } }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
