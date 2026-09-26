// Settings storage and alert preference tests (src/core/settings.js, src/audio/alert-prefs.js): old stored objects keep
// their levels and get the new keys (muted, alerts, assist), invalid values fall back to the defaults, patchSettings()
// merges nested keys without writing the auto-detected quality, assist stays off once turned off, storage failures keep
// the change for the page, and the spoken-alert classes of every alert the aircraft can say.
// Run: node tests/settings.test.mjs — no framework: prints a PASS/FAIL table, exits 1 on failure.

// ---- browser stand-ins (before the modules load) ----
const store = new Map();
let storageBroken = false;
globalThis.localStorage = {
  getItem: (k) => { if (storageBroken) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (storageBroken) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const events = [];
globalThis.window = globalThis.window || globalThis;
if (!globalThis.dispatchEvent || !globalThis.addEventListener) {
  const et = new EventTarget();
  globalThis.addEventListener = et.addEventListener.bind(et);
  globalThis.removeEventListener = et.removeEventListener.bind(et);
  globalThis.dispatchEvent = et.dispatchEvent.bind(et);
}
window.addEventListener('gokyuzu:settings', (e) => events.push(e.detail));

const { DEFAULT_SETTINGS, loadSettings, storedSettings, saveSettings, patchSettings } = await import('../src/core/settings.js');
const { voiceClass, voiceAllowed, alertPrefsFrom } = await import('../src/audio/alert-prefs.js');

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });
const KEY = 'gokyuzu.settings';
const put = (o) => store.set(KEY, JSON.stringify(o));
const raw = () => JSON.parse(store.get(KEY) || '{}');

// ---- defaults ----
store.clear();
let s = storedSettings();
check('defaults: muted false, assist true, alerts all / chimes / hud on / no reduced flashing',
  s.muted === false && s.assist === true && s.alerts.voice === 'all' && s.alerts.chimes === true && s.alerts.hud === true && s.alerts.reduceFlash === false);
check('defaults: volumes as before (master .9, engine 1, voice 1, atc .8, ambient .8)',
  JSON.stringify(s.volumes) === JSON.stringify({ master: 0.9, engine: 1, voice: 1, atc: 0.8, ambient: 0.8 }));
check('loadSettings fills an auto quality, storedSettings leaves it null', typeof loadSettings().quality === 'string' && storedSettings().quality === null);

// ---- old stored settings ----
put({ quality: 'low', volumes: { master: 0.35, engine: 0.2 }, invertPitch: true, fps: 30 });
s = loadSettings();
check('old settings (no muted / alerts / assist key): levels kept', s.volumes.master === 0.35 && s.volumes.engine === 0.2 && s.volumes.voice === 1 && s.volumes.atc === 0.8);
check('old settings: new keys get their defaults, other keys kept', s.muted === false && s.assist === true && s.alerts.voice === 'all' && s.invertPitch === true && s.fps === 30 && s.quality === 'low');

// ---- invalid values ----
put({ volumes: { master: 5, engine: -1, voice: 'x', atc: null }, muted: 'yes', assist: 0, alerts: { voice: 'loud', chimes: 'no', hud: false } });
s = storedSettings();
check('invalid volumes clamp / fall back', s.volumes.master === 1 && s.volumes.engine === 0 && s.volumes.voice === 1 && s.volumes.atc === 0.8, JSON.stringify(s.volumes));
check('invalid muted / assist / alert values → defaults, valid ones kept', s.muted === false && s.assist === true && s.alerts.voice === 'all' && s.alerts.chimes === true && s.alerts.hud === false);
put({ volumes: 'loud', alerts: [1, 2] });
s = storedSettings();
check('non-object volumes / alerts → defaults', s.volumes.master === 0.9 && s.alerts.voice === 'all');
store.set(KEY, '{not json');
check('corrupt storage → defaults', storedSettings().volumes.master === 0.9);

// ---- patchSettings ----
store.clear(); events.length = 0;
let full = patchSettings({ muted: true });
check('patch: stored object has only the patched key (quality stays auto)', JSON.stringify(raw()) === '{"muted":true}', JSON.stringify(raw()));
check('patch: broadcasts the full settings', events.length === 1 && events[0].muted === true && events[0].volumes && typeof events[0].quality === 'string' && full.muted === true);
patchSettings({ volumes: { master: 0.3 } });
patchSettings({ alerts: { voice: 'critical' } });
patchSettings({ alerts: { chimes: false } });
s = storedSettings();
check('patch: nested volumes / alerts merge key by key', s.volumes.master === 0.3 && s.volumes.engine === 1 && s.alerts.voice === 'critical' && s.alerts.chimes === false && s.muted === true);
patchSettings((cur) => ({ muted: !cur.muted }));
check('patch: function form sees the current settings', storedSettings().muted === false);

// ---- assist: off stays off ----
store.clear();
patchSettings({ assist: false });
patchSettings({ muted: true }); patchSettings({ volumes: { master: 0.5 } }); patchSettings({ alerts: { voice: 'off' } });
saveSettings({ ...loadSettings(), quality: 'high' });
check('assist: false survives other patches and a full save', storedSettings().assist === false && loadSettings().assist === false);
put({ assist: false, volumes: { master: 0.2 } });
check('assist: stored false is never replaced by the default', storedSettings().assist === false);

// ---- storage failure: the change holds for the page ----
store.clear();
storageBroken = true;
patchSettings({ muted: true, volumes: { engine: 0.4 } });
s = storedSettings();
storageBroken = false;
check('storage unavailable: the change is kept in memory for this page', s.muted === true && s.volumes.engine === 0.4);

// ---- alert classes ----
const CRITICAL = ['gpws:pullup', 'gpws:tad', 'gpws:m2', 'gpws:t1', 'gpws:sink', 'gpws:dontsink', 'gpws:toolowgear', 'gpws:toolowflaps',
  'gpws:toolowterrain', 'fwc:stall', 'fwc:speed', 'vms:pullup', 'vms:warning', 'vms:altitude', 'icaw:pullup', 'icaw:gear', 'icaw:eng0',
  'icaw:eng1', 'vws:eng1', 'vws:eng2', 'vws:lowrotor', 'vws:altlow', 'stall', 'something:new'];
const INFO = ['gpws:co#2500', 'gpws:co#500', 'gpws:co#200', 'gpws:co#280', 'gpws:gs', 'gpws:bank', 'fwc:co#1000', 'fwc:co#ha', 'fwc:co#min',
  'fwc:co#5', 'fwc:inter', 'fwc:retard', 'vms:caution', 'vms:bingo', 'co', 'retard'];
const wrongC = CRITICAL.filter((t) => voiceClass(t) !== 'critical');
const wrongI = INFO.filter((t) => voiceClass(t) !== 'info');
check('critical: PULL UP / TERRAIN / SINK RATE / STALL / SPEED / engine / fire / low rotor / unknown tags', !wrongC.length, wrongC.join(' '));
check('info: height callouts, MINIMUM(S), RETARD, GLIDESLOPE, BANK ANGLE, CAUTION, BINGO', !wrongI.length, wrongI.join(' '));
check('play:<name> is not an alert', voiceClass('play:v_hello') === 'play' && voiceAllowed('play:x', 'off') && voiceAllowed('play:x', 'critical'));
check('mode all: everything', [...CRITICAL, ...INFO].every((t) => voiceAllowed(t, 'all')) && voiceAllowed('gpws:co#500', undefined));
check('mode critical: critical only', CRITICAL.every((t) => voiceAllowed(t, 'critical')) && INFO.every((t) => !voiceAllowed(t, 'critical')));
check('mode off: no alert voice', [...CRITICAL, ...INFO].every((t) => !voiceAllowed(t, 'off')));
check('alertPrefsFrom: defaults and sanitising', JSON.stringify(alertPrefsFrom(null)) === '{"voice":"all","chimes":true}'
  && JSON.stringify(alertPrefsFrom({ voice: 'critical', chimes: false })) === '{"voice":"critical","chimes":false}'
  && alertPrefsFrom({ voice: 'x', chimes: 0 }).voice === 'all' && alertPrefsFrom({ chimes: 0 }).chimes === true);
check('DEFAULT_SETTINGS.alerts matches the audio defaults', alertPrefsFrom(DEFAULT_SETTINGS.alerts).voice === DEFAULT_SETTINGS.alerts.voice && DEFAULT_SETTINGS.alerts.chimes === true);

// every tag the alert systems can say is one of the lists above (a new alert has to be classified on purpose)
const fs = await import('node:fs');
const src = fs.readFileSync(new URL('../src/audio/alertlogic.js', import.meta.url), 'utf8');
const found = new Set();
for (const m of src.matchAll(/(?:say|sayF|sayV)\(io, '([a-z0-9#]+)'/g)) found.add(m[1]);
for (const m of src.matchAll(/repeater\('([a-z0-9:#]+)'/g)) found.add(m[1]);
const prefixed = [...found].map((t) => (t.includes(':') ? t : null)).filter(Boolean);
const bare = [...found].filter((t) => !t.includes(':'));
const known = new Set([...CRITICAL, ...INFO].map((t) => t.replace(/^[a-z]+:/, '').replace(/#.*/, '#')));
const unknown = bare.filter((t) => !known.has(t.replace(/#.*/, '#')) && !known.has(t));
check('every alertlogic.js voice tag is classified in this test', found.size > 15 && !unknown.length && prefixed.every((t) => CRITICAL.includes(t) || INFO.includes(t)),
  `${found.size} tags${unknown.length ? ` · unclassified: ${unknown.join(' ')}` : ''}`);

let failed = 0;
console.log('\n=== settings storage + alert preferences ' + '='.repeat(66));
for (const r of rows) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(100)} ${r.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
