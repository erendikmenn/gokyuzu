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

function send(type, data = {}) {
  if (!enabled) return;
  const q = new URLSearchParams({ t: type, s: sid, n: String(seq++), m: minutes(), v: version });
  for (const [k, val] of Object.entries(data)) if (val !== undefined && val !== null && val !== '') q.set(k, String(val).slice(0, 120));
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
export function startTelemetry({ build, renderer, quality, state }) {
  version = (build && build.version) || '';
  getState = state;
  send('open', {
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio.toFixed(2), q: quality, lang: navigator.language,
    gpu: gpuName(renderer), ref: document.referrer ? new URL(document.referrer).hostname : '',
  });
  // one heartbeat per minute of active flight (tab visible, not paused)
  setInterval(() => {
    const s = getState && getState();
    if (!s || !s.flying || s.paused || document.hidden) return;
    active++;
    send('hb', { a: active, ac: s.aircraft, fps: Math.round(s.fps || 0), pr: s.pixelRatio && s.pixelRatio.toFixed(2), vw: s.view === 'cockpit' ? 'c' : 'e' });
  }, 60000);
  addEventListener('pagehide', () => send('end', { a: active }));
  addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => reportError(e.reason && (e.reason.message || e.reason), '', 0));
}

/** A flight started: aircraft, spawn, seconds from the menu click to the first playable frame. */
export function trackFlight(aircraft, spawn, loadSeconds, quality) {
  send('fly', { ac: aircraft, sp: spawn, lt: loadSeconds.toFixed(1), q: quality });
}

// Gameplay events (takeoff, land, crash, tutorial steps): same anonymous beacon, capped per type and page so a crash
// loop or a bouncing landing cannot flood the log. Values are short codes and numbers, never anything personal.
const EVENT_CAP = 40;
const eventCount = {};
/** Generic gameplay event, e.g. trackEvent('land', { ac: 'a320neo', vs: -1.2, rw: 1 }). */
export function trackEvent(type, data = {}) {
  const t = String(type || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16);
  if (!t) return;
  eventCount[t] = (eventCount[t] || 0) + 1;
  if (eventCount[t] > EVENT_CAP) return;
  send(t, data);
}

function reportError(message, file, line) {
  if (errors++ >= 5) return;   // a broken frame loop must not flood the log
  send('err', { e: String(message || 'unknown'), f: file ? `${String(file).split('/').pop()}:${line}` : '' });
}
