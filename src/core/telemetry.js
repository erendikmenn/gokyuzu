// Anonymous usage statistics (CONTRACTS-SF.md §11).
// The game sends small GET beacons to /_e on its own origin; a CloudFront Function answers 204 at the edge and the
// access log line (query string = the event) is all that is kept, for 30 days. No cookies, no stored id, nothing personal:
// a random session id that lives only in this page, the chosen aircraft/spawn, minutes played, frame rate, errors, and
// gameplay events (takeoff, landing sink rate, crash cause, tutorial step times) through trackEvent().
// Returning players are counted without any identifier: this browser keeps only its first-visit day, its last visit day
// and a count of visit days (localStorage `gokyuzu.visits`), and `open` carries coarse buckets of them (d0, vn, vd, vo).
// Off on localhost (unless ?telemetry=1), with ?telemetry=0, and when the browser sends Do Not Track / Global Privacy
// Control (then nothing is sent and the visit record is neither read nor written; a ?telemetry=1 link does not override
// the browser's choice).
import { detectDevice, deviceLabel, gpuLabel, rendererString } from './gpu-device.js';
import { isQuality, detectQuality, capQuality, getQualityCap, qualitySource } from './quality.js';

const hasDom = typeof location !== 'undefined' && typeof navigator !== 'undefined' && typeof document !== 'undefined';
const params = new URLSearchParams(hasDom ? location.search : '');
const local = hasDom && /^(localhost|127\.|\[::1\])/.test(location.hostname);
const optedOut = hasDom && (navigator.doNotTrack === '1' || (typeof window !== 'undefined' && window.doNotTrack === '1') || navigator.globalPrivacyControl === true);
const enabled = hasDom && !optedOut && (local ? params.get('telemetry') === '1' : params.get('telemetry') !== '0');

const sid = typeof crypto !== 'undefined' && crypto.getRandomValues
  ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('') : '';
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const t0 = now();
let seq = 0, version = '', errors = 0, active = 0, getState = null;

const minutes = () => ((now() - t0) / 60000).toFixed(1);

// envelope keys: a data field with one of these names would overwrite the session id / sequence (it did: the
// tutorial's step seconds were sent as `s`), so data keys never replace them
const RESERVED = new Set(['t', 's', 'n', 'm', 'v']);
// map of the page (src/maps/index.js): `mp` on open / fly / mission / ffc, only for maps other than San Francisco
let mapTag = '';
const MAP_EVENTS = new Set(['open', 'fly', 'mission', 'ffc']);
export function setTelemetryMap(id) { mapTag = id && id !== 'sf' ? id : ''; }

// Events raised before the build version is known (the dead-page report at module load, the start gate, the software
// renderer notice) wait for it: startTelemetry() sends them with `v`; after 15 s or at pagehide they go without it.
// (The dead-page report used to leave at module load with an empty `v`, so a dying build could not be told apart.)
const early = [];
let versionKnown = false, earlyTimer = 0;

function dispatch(q) {
  // keepalive lets the last beacon leave while the page unloads; failures are irrelevant to the player
  try { fetch(`_e?${q}`, { keepalive: true, cache: 'no-store', credentials: 'omit' }).catch(() => {}); } catch { /* ignore */ }
}
function send(type, data = {}) {
  if (!enabled) return;
  const q = new URLSearchParams({ t: type, s: sid, n: String(seq++), m: minutes() });
  for (const [k, val] of Object.entries(data)) if (!RESERVED.has(k) && val !== undefined && val !== null && val !== '') q.set(k, String(val).slice(0, 120));
  if (mapTag && MAP_EVENTS.has(type)) q.set('mp', mapTag);
  if (!versionKnown) {
    if (early.length < 30) early.push(q);
    if (!earlyTimer) earlyTimer = setTimeout(flushEarly, 15000);
    return;
  }
  q.set('v', version);
  dispatch(q);
}
function flushEarly() {
  if (versionKnown) return;
  versionKnown = true;
  clearTimeout(earlyTimer);
  let dc = '';
  try { dc = deviceLabel(); } catch { /* ignore */ }
  for (const q of early.splice(0)) {
    q.set('v', version);
    if (q.get('t') === 'dead' && dc) q.set('dc', dc);
    dispatch(q);
  }
}

/** Readable GPU name of the renderer's context (src/core/gpu-device.js gpuLabel: "Intel UHD Graphics 620", not "Intel"). */
function gpuName(renderer) {
  try { return gpuLabel(rendererString(renderer.getContext())); } catch { return ''; }
}

// ---- returning players without an identifier ----
// localStorage `gokyuzu.visits` = { f: first visit day, l: last visit day ('YYYYMMDD', the player's local calendar),
// n: number of days with a visit, o: 1 when the browser had played before the record existed }. Nothing else, never sent
// as such: `open` carries d0 = days since the first visit (0–14, then '15-29' / '30+'), vn = visit days incl. today
// (1–7, then '8-14' / '15+'), vd = 1 on the first page of the day (so a day's pages count once), vo = 1 for the
// browsers that played before the counter existed (their first day is unknown: left out of the cohorts).
const VISIT_KEY = 'gokyuzu.visits';
const DAY_RE = /^\d{8}$/;
export const localDay = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000;
export const bucketD0 = (d) => (d <= 14 ? String(d) : d < 30 ? '15-29' : '30+');
export const bucketVn = (n) => (n <= 7 ? String(n) : n <= 14 ? '8-14' : '15+');

/**
 * Pure: the visit record after a page opened on `today` → { rec, d0, vn, vd, vo }. `played` = this browser already had
 * other game data when the record was created (legacy player). A clock set back never un-counts a day.
 */
export function updateVisits(rec, today, played = false) {
  const valid = rec && typeof rec === 'object' && DAY_RE.test(rec.f) && DAY_RE.test(rec.l) && Number.isInteger(rec.n) && rec.n >= 1 && rec.l >= rec.f;
  let vd = 0;
  if (!valid) { rec = played ? { f: today, l: today, n: 1, o: 1 } : { f: today, l: today, n: 1 }; vd = 1; }
  else if (today > rec.l) { rec = { ...rec, l: today, n: rec.n + 1 }; vd = 1; }
  const d0 = Math.max(0, Math.round(dayNum(today) - dayNum(rec.f)));
  return { rec, d0, vn: rec.n, vd, vo: rec.o ? 1 : 0 };
}

// other game data present before this page wrote anything (settings, tutorial, missions, models …): a legacy player
let playedBefore = false;
if (enabled) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      if (k.startsWith('gokyuzu.') && k !== VISIT_KEY && k !== 'gokyuzu.swNotice') { playedBefore = true; break; }
    }
  } catch { /* storage blocked */ }
}
function visitFields() {
  try {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(VISIT_KEY) || 'null'); } catch { rec = null; }
    const r = updateVisits(rec, localDay(), playedBefore);
    localStorage.setItem(VISIT_KEY, JSON.stringify(r.rec));
    return { d0: bucketD0(r.d0), vn: bucketVn(r.vn), vd: r.vd, vo: r.vo || undefined };
  } catch { return {}; }   // storage blocked (some private windows): no retention fields
}

/** Why the page runs its start preset (`mq`): url | reload | user | auto | cap | resume (src/core/quality.js qualitySource). */
function qualityReason(running) {
  try {
    const urlQ = params.get('quality');
    if (isQuality(urlQ)) return params.get('resume') === '1' ? 'reload' : 'url';
    let stored = null;
    try { const s = JSON.parse(localStorage.getItem('gokyuzu.settings') || 'null'); stored = s && isQuality(s.quality) ? s.quality : null; } catch { /* ignore */ }
    const auto = detectQuality();
    return qualitySource({ running, stored, auto, cap: capQuality(stored || auto) });
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
  flushEarly();
  let dc = '';
  try { dc = deviceLabel(detectDevice()); } catch { /* ignore */ }
  const cap = getQualityCap();
  send('open', {
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio.toFixed(2), q: quality, lang: navigator.language,
    gpu: gpuName(renderer), ref: document.referrer ? new URL(document.referrer).hostname : '',
    dc,                                   // device class kind/os/tier, e.g. desktop/windows/integrated (gpu-device.js)
    mq: qualityReason(quality),           // why this preset: auto | user | url | reload | cap | resume
    qc: cap ? cap.q : undefined,          // quality ceiling left by a graphics failure on this device
    ...visitFields(),                     // d0 / vn / vd / vo: returning players without an identifier
    ...extra,   // e.g. { in: 'touch' | 'kb', touch: 1, iab: 'x' } (input kind, touch device, social-app webview)
  });
  // one heartbeat per minute of active flight (tab visible, not paused)
  setInterval(() => {
    const s = getState && getState();
    if (!s || !s.flying || s.paused || document.hidden) return;
    active++;
    // fps = drawn frames per second in flight; cap = what the frame pacing aims at (30 on phones, 60 on tablets, the
    // player's setting; 0 = the display's rate), so the report can tell a capped phone from a slow one
    const pacing = s.pacing || (globalThis.__game && globalThis.__game.pacing);
    const cap = s.cap ?? (pacing && Number.isFinite(pacing.cap) ? pacing.cap : undefined);
    // lp = 1: the browser throttles requestAnimationFrame to ~30 Hz (Low Power Mode / thermal, frame-pacing.js lowPower);
    // zm = 1: the page is zoomed in (a pinch / double tap got through on a phone or tablet)
    const vv = typeof visualViewport !== 'undefined' && visualViewport ? visualViewport.scale : 1;
    send('hb', { a: active, ac: s.aircraft, fps: Math.round(s.fps || 0), cap, pr: s.pixelRatio && s.pixelRatio.toFixed(2), vw: s.view === 'cockpit' ? 'c' : 'e',
      lp: pacing && pacing.lowPower ? 1 : undefined, zm: vv > 1.01 ? 1 : undefined });
  }, 60000);
  addEventListener('pagehide', () => send('end', withExtras('end', { a: active })));
}

// Errors are caught from the moment this module loads (not only after startTelemetry): failures while loading used to
// leave no trace. Errors from other origins / browser extensions / in-app browsers' injected scripts are tagged `x=foreign`.
if (hasDom && typeof addEventListener === 'function') {
  addEventListener('error', (e) => reportError(e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason, src = rejectionSource(r);
    reportError(r && (r.message || r), src.file, src.line);
  });
  addEventListener('pagehide', flushEarly);   // (registered before the handlers below: early events leave first)
}

/** A flight started: aircraft, spawn, seconds from the menu click to the first playable frame (+ extra, e.g. { in: 'touch', tilt: 1 }). */
export function trackFlight(aircraft, spawn, loadSeconds, quality, extra = {}) {
  send('fly', withExtras('fly', { ac: aircraft, sp: spawn, lt: loadSeconds.toFixed(1), q: quality, ...extra }));
  markLive(quality);
}

/** Loading failed before the flight could start (the error screen is shown): phase, short message, network or not. */
export function trackFail(phase, message, net) {
  send('fail', { ph: phase, e: String(message || '').slice(0, 100), net: net ? 1 : 0 });
}

// Dead-page marker: a page that dies while flying (e.g. iOS kills it for memory) sends nothing. The marker lives in
// sessionStorage from `fly` until a normal `pagehide`; if the next page of this tab still finds it, the previous one died.
// `dead` carries the dead page's build (pv) and preset (pq), this page's device class (dc) and version (v), and wd = 1
// when the browser itself discarded the tab (Chrome's memory saver: not a crash).
const LIVE_KEY = 'gokyuzu.live';
function markLive(q) {
  try { sessionStorage.setItem(LIVE_KEY, JSON.stringify({ sid, t: Date.now(), v: version, q })); } catch { /* ignore */ }
}
if (hasDom && typeof addEventListener === 'function') {
  addEventListener('pagehide', () => { try { sessionStorage.removeItem(LIVE_KEY); } catch { /* ignore */ } });
  try {
    const prev = JSON.parse(sessionStorage.getItem(LIVE_KEY) || 'null');
    if (prev && prev.sid && prev.sid !== sid) {
      sessionStorage.removeItem(LIVE_KEY);
      const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0] || {}).type || '';
      send('dead', { prev: prev.sid, after: Math.round((Date.now() - prev.t) / 1000), nav, pv: prev.v, pq: prev.q, wd: document.wasDiscarded ? 1 : undefined });
    }
  } catch { /* ignore */ }
}

// Gameplay events (takeoff, land, crash, tutorial steps): same anonymous beacon, capped per type and page so a crash
// loop or a bouncing landing cannot flood the log. Values are short codes and numbers, never anything personal.
const EVENT_CAP = 40;
const eventCount = {};
// missions hook (CONTRACTS-SF.md §12): a module may add fields to every event of a type, e.g. the landing score
// (src/ui/landing.js) adds fpm / cl / tdz / st to `land`; fn(data) → { key: value } | null, never throws into the caller
const eventExtras = {};
export function setEventExtras(type, fn) { eventExtras[type] = typeof fn === 'function' ? fn : null; }
function withExtras(t, data) {   // (fly and end use the hook too, e.g. assisted flight's `as`)
  if (eventExtras[t]) { try { const x = eventExtras[t](data); if (x) return { ...data, ...x }; } catch { /* ignore */ } }
  return data;
}
/** Generic gameplay event, e.g. trackEvent('land', { ac: 'a320neo', vs: -1.2, rw: 1 }). */
export function trackEvent(type, data = {}) {
  const t = String(type || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 16);
  if (!t) return;
  eventCount[t] = (eventCount[t] || 0) + 1;
  if (eventCount[t] > EVENT_CAP) return;
  send(t, withExtras(t, data));
}

/**
 * Pure: script URL and line of the first stack frame of an unhandled rejection's reason (Chrome "at f (url:1:2)" /
 * "at url:1:2", Safari and Firefox "f@url:1:2"). The whole URL, not only the file name: isForeignError() needs its origin
 * (the file name alone tagged every rejection of the game's own code as foreign).
 */
export function rejectionSource(reason) {
  const stack = reason && reason.stack ? String(reason.stack) : '';
  const frame = stack.split('\n').find((l) => /:\d+:\d+/.test(l)) || '';
  const m = /([^\s(@]+):(\d+):\d+\)?\s*$/.exec(frame);
  return m ? { file: m[1], line: Number(m[2]) } : { file: '', line: 0 };
}
/**
 * Pure: an error from a script not served by `origin` (other sites; browser extensions, chrome-extension://…, e.g. an
 * injected "200.js" throwing "reading 'M_ID'" on one Windows Chrome; in-app browsers' injected code). The game's own
 * blob: workers count as its own.
 */
export function isForeignError(message, file, origin) {
  const f = String(file || '');
  return message === 'Script error.' || (!!f && !f.startsWith(origin) && !f.startsWith(`blob:${origin}`));
}

function reportError(message, file, line) {
  if (errors++ >= 5) return;   // a broken frame loop must not flood the log
  const msg = String(message || 'unknown');
  const foreign = isForeignError(msg, file, location.origin);
  send('err', { e: msg, f: file ? `${String(file).split('/').pop()}:${line}` : '', x: foreign ? 'foreign' : '' });
}
