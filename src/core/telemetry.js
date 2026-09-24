// Anonymous usage statistics (CONTRACTS-SF.md §11).
// The game sends small GET beacons to /_e on its own origin; a CloudFront Function answers 204 at the edge and the
// access log line (query string = the event) is all that is kept, for 30 days. No cookies, no stored id, nothing personal:
// a random session id that lives only in this page, the chosen aircraft/spawn, minutes played, frame rate, errors, and
// gameplay events (takeoff, landing sink rate, crash cause, tutorial step times) through trackEvent().
// Off on localhost (unless ?telemetry=1), with ?telemetry=0, and when the browser sends Do Not Track / Global Privacy Control.

const params = new URLSearchParams(location.search);
const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
const optedOut = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
const enabled = params.get('telemetry') === '1' || (!local && !optedOut && params.get('telemetry') !== '0');

const sid = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('');
const t0 = performance.now();
let seq = 0, version = '', errors = 0, active = 0, getState = null;

const minutes = () => ((performance.now() - t0) / 60000).toFixed(1);

// envelope keys: a data field with one of these names would overwrite the session id / sequence (it did: the
// tutorial's step seconds were sent as `s`), so data keys never replace them
const RESERVED = new Set(['t', 's', 'n', 'm', 'v']);
// map of the page (src/maps/index.js): `mp` on open / fly / mission / ffc, only for maps other than San Francisco
let mapTag = '';
const MAP_EVENTS = new Set(['open', 'fly', 'mission', 'ffc']);
export function setTelemetryMap(id) { mapTag = id && id !== 'sf' ? id : ''; }

function send(type, data = {}) {
  if (!enabled) return;
  const q = new URLSearchParams({ t: type, s: sid, n: String(seq++), m: minutes(), v: version });
  for (const [k, val] of Object.entries(data)) if (!RESERVED.has(k) && val !== undefined && val !== null && val !== '') q.set(k, String(val).slice(0, 120));
  if (mapTag && MAP_EVENTS.has(type)) q.set('mp', mapTag);
  // keepalive lets the last beacon leave while the page unloads; failures are irrelevant to the player
  try { fetch(`_e?${q}`, { keepalive: true, cache: 'no-store', credentials: 'omit' }).catch(() => {}); } catch { /* ignore */ }
}

function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    // "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, …)" / "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"
    const m = /Renderer: ([^,)]+)/.exec(raw) || /^ANGLE \([^,]*, ([^,(]+)/.exec(raw);
    return (m ? m[1] : raw).replace(/ (Direct3D|OpenGL|Vulkan).*$/, '').trim().slice(0, 60);
  } catch { return ''; }
}

/**
 * Page opened (menu or direct link). `state()` is polled once a minute and returns
 * { flying, paused, aircraft, fps, pixelRatio, view } for the heartbeat.
 */
export function startTelemetry({ build, renderer, quality, state, extra = {} }) {
  version = (build && build.version) || '';
  getState = state;
  if (!enabled) return;   // off (localhost, ?telemetry=0, DNT / GPC): no GPU name query (a synchronous GL round trip), no timer
  send('open', {
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio.toFixed(2), q: quality, lang: navigator.language,
    gpu: gpuName(renderer), ref: document.referrer ? new URL(document.referrer).hostname : '',
    ...extra,   // e.g. { in: 'touch' | 'kb', touch: 1, iab: 'x' } (input kind, touch device, social-app webview)
  });
  // one heartbeat per minute of active flight (tab visible, not paused)
  setInterval(() => {
    const s = getState && getState();
    if (!s || !s.flying || s.paused || document.hidden) return;
    active++;
    send('hb', { a: active, ac: s.aircraft, fps: Math.round(s.fps || 0), pr: s.pixelRatio && s.pixelRatio.toFixed(2), vw: s.view === 'cockpit' ? 'c' : 'e' });
  }, 60000);
  addEventListener('pagehide', () => send('end', { a: active }));
}

// Errors are caught from the moment this module loads (not only after startTelemetry): failures while loading used to
// leave no trace. Errors from other origins / browser extensions / in-app browsers' injected scripts are tagged `x=foreign`.
addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const frame = r && r.stack ? (String(r.stack).split('\n').find((l) => /:\d+:\d+/.test(l)) || '') : '';
  const m = /([^/\s(]+):(\d+):\d+\)?\s*$/.exec(frame);
  reportError(r && (r.message || r), m ? m[1] : '', m ? m[2] : 0);
});

/** A flight started: aircraft, spawn, seconds from the menu click to the first playable frame (+ extra, e.g. { in: 'touch', tilt: 1 }). */
export function trackFlight(aircraft, spawn, loadSeconds, quality, extra = {}) {
  send('fly', { ac: aircraft, sp: spawn, lt: loadSeconds.toFixed(1), q: quality, ...extra });
  markLive();
}

/** Loading failed before the flight could start (the error screen is shown): phase, short message, network or not. */
export function trackFail(phase, message, net) {
  send('fail', { ph: phase, e: String(message || '').slice(0, 100), net: net ? 1 : 0 });
}

// Dead-page marker: a page that dies while flying (e.g. iOS kills it for memory) sends nothing. The marker lives in
// sessionStorage from `fly` until a normal `pagehide`; if the next page of this tab still finds it, the previous one died.
const LIVE_KEY = 'gokyuzu.live';
function markLive() {
  try { sessionStorage.setItem(LIVE_KEY, JSON.stringify({ sid, t: Date.now() })); } catch { /* ignore */ }
}
addEventListener('pagehide', () => { try { sessionStorage.removeItem(LIVE_KEY); } catch { /* ignore */ } });
try {
  const prev = JSON.parse(sessionStorage.getItem(LIVE_KEY) || 'null');
  if (prev && prev.sid && prev.sid !== sid) {
    sessionStorage.removeItem(LIVE_KEY);
    const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0] || {}).type || '';
    send('dead', { prev: prev.sid, after: Math.round((Date.now() - prev.t) / 1000), nav });
  }
} catch { /* ignore */ }

// Gameplay events (takeoff, land, crash, tutorial steps): same anonymous beacon, capped per type and page so a crash
// loop or a bouncing landing cannot flood the log. Values are short codes and numbers, never anything personal.
const EVENT_CAP = 40;
const eventCount = {};
// missions hook (CONTRACTS-SF.md §12): a module may add fields to every event of a type, e.g. the landing score
// (src/ui/landing.js) adds fpm / cl / tdz / st to `land`; fn(data) → { key: value } | null, never throws into the caller
const eventExtras = {};
export function setEventExtras(type, fn) { eventExtras[type] = typeof fn === 'function' ? fn : null; }
/** Generic gameplay event, e.g. trackEvent('land', { ac: 'a320neo', vs: -1.2, rw: 1 }). */
export function trackEvent(type, data = {}) {
  const t = String(type || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16);
  if (!t) return;
  eventCount[t] = (eventCount[t] || 0) + 1;
  if (eventCount[t] > EVENT_CAP) return;
  if (eventExtras[t]) { try { const x = eventExtras[t](data); if (x) data = { ...data, ...x }; } catch { /* ignore */ } }
  send(t, data);
}

function reportError(message, file, line) {
  if (errors++ >= 5) return;   // a broken frame loop must not flood the log
  const msg = String(message || 'unknown');
  // any script not served from this origin is foreign: other sites, and browser extensions (chrome-extension://…,
  // e.g. an injected "200.js" throwing "reading 'M_ID'" on one Windows Chrome)
  const foreign = msg === 'Script error.' || (file && !String(file).startsWith(location.origin));
  send('err', { e: msg, f: file ? `${String(file).split('/').pop()}:${line}` : '', x: foreign ? 'foreign' : '' });
}
