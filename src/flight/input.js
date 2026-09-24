// Player input (P1): keyboard (KeyboardEvent.code, layout independent, Mac friendly) + standard-mapping gamepad.
//
//   createInput(target = window) -> { state, update(dt), on(action, cb), bindings, setAircraft(spec), setThrottle(v) }
//   state: { pitch, roll, yaw /* -1..1, + = nose up / roll right / yaw right */, throttle /* 0..1 lever; helicopter:
//            collective */, brake /* 0..1 */ }
//
// Keyboard axes ramp toward ±1 while held (a tap = small correction, a long hold = full deflection) and return quickly
// when released. The throttle lever moves at a constant rate while a throttle key is held; fighters have an
// afterburner detent at spec.abDetent: the lever stops at MIL and a fresh press of the throttle-up key goes into
// afterburner (and a fresh press of throttle-down leaves it). Digit keys are lever presets.
// Brakes are analog: B / Space ramp the pressure up while held.
// Map: J opens / closes the navigation map (src/ui/map.js; M = mute, H = HUD are taken; J sits between them on the
// home row and has the same label on the US and Turkish Q layouts). Esc closes the map before it can pause.
// Direct cameras: Alt / Option + 1 … 7 fire on('cameraSelect', (id) => …) with the camera id (src/ui/camera-modes.js).
// Emergency: I fires 'emergency' (failures, CONTRACTS-SF.md §12: fire handle, alternate gear, APU, relight — the model picks
// the next useful item); it is also handed to window.__game.flight.command() here (the host routes only the classic
// system actions; the model ignores a second call in the same frame).
// Throttle sync: when the flight model publishes `pendingThrottle` (after a reset or an autopilot disconnect) the lever
// adopts it (window.__game.flight, or call setThrottle()).
// Touch source (phones / tablets, src/ui/touch.js): the on-screen stick, pedals and tilt write absolute axes into
// `input.touch` (added to the keyboard / gamepad axes), the throttle slider sets the lever with setTouchLever() (the
// slider handles the AB detent and the reverse range itself) and the buttons call trigger(action). setTouchMode(true)
// switches `bindings` (F1 help) to the touch controls. `kind` is the input device used last: 'kb' | 'pad' | 'touch'.
// No DOM access beyond addEventListener on `target`: safe to construct in Node with target = null.
import { IS_MAC } from '../core/platform.js';
import { CAMERA_ORDER, CAMERA_NAMES, CAMERA_KEY_MOD, cameraForDigit } from '../ui/camera-modes.js';   // direct camera keys

// keyboard ramp rates (full deflection per second) per aircraft category: fighters ramp roll slower (their roll-rate
// command reaches 240-310°/s), helicopters get a gentler cyclic
const PRESS_RATES = {
  airliner: { pitch: 1.8, roll: 3.0, yaw: 3 },
  fighter: { pitch: 1.6, roll: 1.8, yaw: 3 },
  helicopter: { pitch: 1.5, roll: 2.0, yaw: 2.5 },
};
const AXIS_RELEASE_RATE = 7;
const AXIS_REVERSE_RATE = 10;

const THROTTLE_RATE = 0.45;          // lever travel per second (fixed wing)
const COLLECTIVE_RATE = 0.35;        // helicopter collective travel per second
const BRAKE_RATE = 4, BRAKE_RELEASE = 8;
const DEADZONE = 0.12;
const LONG_PRESS = 0.4;              // s: holding the speedbrake key this long makes it momentary

const AXES = {
  pitchUp: ['KeyS', 'ArrowDown'],           // pull back: nose up
  pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'KeyX', 'Equal', 'NumpadAdd'],
  // Ctrl only on macOS: on Windows/Linux Ctrl+W (with W = nose down) closes the tab (src/core/platform.js)
  throttleDown: [...(IS_MAC ? ['ControlLeft', 'ControlRight'] : []), 'KeyZ', 'Minus', 'NumpadSubtract'],
  brake: ['KeyB', 'Space'],
};

const ACTION_KEYS = {
  KeyG: 'gear', KeyF: 'flapsDown', KeyV: 'flapsUp', KeyK: 'speedbrake', KeyN: 'reverser', KeyU: 'canopy',
  KeyL: 'lights', KeyO: 'autopilot', KeyJ: 'map', KeyI: 'emergency',
  KeyC: 'camera', Period: 'camera', Comma: 'cameraPrev', KeyT: 'view', KeyY: 'lookBack',
  KeyR: 'reset', KeyP: 'pause', Escape: 'pause', KeyH: 'hud', KeyM: 'mute', F1: 'help', Slash: 'help', IntlRo: 'help',
  Tab: 'menu',
};

// standard gamepad
const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
const GP_ACTIONS = {
  [GP.B]: 'flapsDown', [GP.X]: 'flapsUp', [GP.Y]: 'camera', [GP.BACK]: 'reset', [GP.START]: 'pause',
  [GP.L3]: 'reverser', [GP.R3]: 'view', [GP.UP]: 'gear', [GP.DOWN]: 'speedbrake', [GP.LEFT]: 'autopilot', [GP.RIGHT]: 'hud',
  [GP.HOME]: 'help',
};
const GP_ACTION_LIST = Object.entries(GP_ACTIONS).map(([b, a]) => [Number(b), a]);

const DIGITS = {};
for (let i = 0; i <= 9; i++) { DIGITS[`Digit${i}`] = i; DIGITS[`Numpad${i}`] = i; }

const HANDLED = new Set([...Object.values(AXES).flat(), ...Object.keys(ACTION_KEYS), ...Object.keys(DIGITS)]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function rampAxis(value, target, dt, pressRate) {
  let rate;
  if (target === 0) rate = AXIS_RELEASE_RATE;
  else if (value * target < 0) rate = AXIS_REVERSE_RATE;
  else rate = pressRate;
  const d = target - value;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : value + Math.sign(d) * step;
}

function deadzone(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  const x = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * (0.35 * x + 0.65 * x * x * x); // expo: fine control near center
}

export function createInput(target = globalThis.window) {
  const down = new Set();
  const handlers = {};
  const state = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
  const kb = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
  const gpPrev = [];
  let gamepadConnected = false;
  let padSeen = false, padPollT = 0;   // a pad has been seen (per-frame polling) / seconds to the next probe
  let mode = 'airliner';            // 'airliner' | 'fighter' | 'helicopter'
  let detent = null;                // afterburner detent (fighters)
  let abArmed = false;              // fresh throttle-up press at the detent → allowed into AB
  let milArmed = false;             // fresh throttle-down press at the detent → allowed out of AB
  let speedbrakeDownAt = -1, clock = 0;
  let gpTriggerIdle = true;
  const touch = { pitch: 0, roll: 0, yaw: 0, brake: 0 };   // touch source: absolute axes (src/ui/touch.js)
  let touchMode = false;
  let lastKind = 'kb';

  const fire = (action, arg) => {
    for (const cb of handlers[action] || []) { try { cb(arg); } catch (e) { console.error(e); } }
    if (action === 'emergency') {
      const f = globalThis.__game && globalThis.__game.flight;
      if (f && f.command) { try { f.command('emergency'); } catch (e) { console.error(e); } }
    }
  };
  const any = (codes) => codes.some((c) => down.has(c));

  function setLever(v) {
    state.throttle = clamp(v, 0, 1);
    abArmed = false; milArmed = false;
  }

  /** Move the lever by d, honouring the afterburner detent. */
  function moveLever(d) {
    let v = state.throttle + d;
    if (detent != null) {
      const at = Math.abs(state.throttle - detent) < 1e-6;
      if (d > 0 && state.throttle <= detent && v > detent && !(at && abArmed)) v = detent;
      if (d < 0 && state.throttle >= detent && v < detent && !(at && milArmed)) v = detent;
    }
    state.throttle = clamp(v, 0, 1);
  }

  function onKeyDown(e) {
    if (e.metaKey) return;          // leave Cmd shortcuts to the browser / OS
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    const code = e.code;
    const isHelpKey = e.key === '?';
    if (HANDLED.has(code) || isHelpKey) e.preventDefault();
    const fresh = !down.has(code);
    down.add(code);
    if (e.repeat || !fresh) return;
    if (e.isTrusted !== false) lastKind = 'kb';   // (synthetic presses from on-screen buttons do not count)
    // afterburner detent: a new press at the detent passes through it
    if (detent != null && Math.abs(state.throttle - detent) < 1e-6) {
      if (AXES.throttleUp.includes(code)) abArmed = true;
      if (AXES.throttleDown.includes(code)) milArmed = true;
    }
    if (isHelpKey && code !== 'Slash' && code !== 'IntlRo') fire('help');
    // direct camera keys: Alt / Option + 1 … 7 → 'cameraSelect' with the camera id (src/ui/camera-modes.js); with Alt
    // the digit is not a throttle preset
    if (e.altKey && code in DIGITS) {
      const cam = cameraForDigit(DIGITS[code]);
      if (cam) fire('cameraSelect', cam);
      return;
    }
    const action = ACTION_KEYS[code];
    if (action) {
      if (action === 'speedbrake') speedbrakeDownAt = clock;
      fire(action);
    }
    if (code in DIGITS) setLever(presetFor(DIGITS[code]));
  }

  function onKeyUp(e) {
    down.delete(e.code);
    // macOS does not send keyup for keys released while Cmd is held
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') down.clear();
    if (HANDLED.has(e.code)) e.preventDefault();
    // speedbrake held longer than LONG_PRESS behaves as a momentary switch: retract on release
    if (ACTION_KEYS[e.code] === 'speedbrake' && speedbrakeDownAt >= 0) {
      if (clock - speedbrakeDownAt > LONG_PRESS) fire('speedbrake');
      speedbrakeDownAt = -1;
    }
  }
  const releaseAll = () => down.clear();

  if (target && target.addEventListener) {
    target.addEventListener('gamepadconnected', () => { padSeen = true; });
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', releaseAll);
    const doc = target.document;
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', () => { if (doc.hidden) releaseAll(); });
  }

  /** Lever preset for a digit key: 1..9 = 10..90 % (fighters: 1..9 up to MIL), 0 = 100 % (TOGA / max AB). */
  function presetFor(d) {
    if (d === 0) return 1;
    if (detent != null) return (d / 9) * detent;
    return d / 10;
  }

  function readGamepad(dt) {
    // navigator.getGamepads() costs a snapshot of every pad per call: before the page has seen a pad (the
    // 'gamepadconnected' event, which browsers fire with the first input from a pad; getGamepads() lists nothing
    // before that either) it is asked once a second, not every frame
    if (!padSeen) {
      padPollT -= dt;
      if (padPollT > 0) return null;
      padPollT = 1;
    }
    const nav = globalThis.navigator;
    let pads = null;
    try { pads = nav && nav.getGamepads ? nav.getGamepads() : null; } catch { pads = null; }
    let pad = null;
    if (pads) for (const p of pads) if (p && p.connected) { pad = p; break; }
    gamepadConnected = !!pad;
    if (pad) padSeen = true;
    if (!pad) { gpPrev.length = 0; return null; }
    const ax = (i) => deadzone(pad.axes[i] || 0);
    const btn = (i) => pad.buttons[i] || { pressed: false, value: 0 };
    const pressed = (i) => btn(i).pressed;
    const edge = (i) => pressed(i) && !gpPrev[i];

    // throttle: triggers (analog) and right stick Y; the AB detent needs the trigger released and pulled again
    const rt = btn(GP.RT).value || 0, lt = btn(GP.LT).value || 0;
    const thr = rt - lt - ax(3);
    if (detent != null && Math.abs(state.throttle - detent) < 1e-6) {
      if (gpTriggerIdle && rt > 0.2) abArmed = true;
      if (gpTriggerIdle && lt > 0.2) milArmed = true;
    }
    gpTriggerIdle = rt < 0.1 && lt < 0.1 && Math.abs(ax(3)) < 0.1;
    if (Math.abs(thr) > 0.05) moveLever(thr * (mode === 'helicopter' ? COLLECTIVE_RATE : THROTTLE_RATE) * 1.5 * dt);

    for (const [b, action] of GP_ACTION_LIST) if (edge(b)) { fire(action); lastKind = 'pad'; }
    const bs = pad.buttons;
    gpPrev.length = bs.length;
    for (let i = 0; i < bs.length; i++) gpPrev[i] = bs[i].pressed;
    if (Math.abs(ax(0)) + Math.abs(ax(1)) + rt + lt > 0.3) lastKind = 'pad';
    return {
      pitch: ax(1),                       // stick back (+) = nose up
      roll: ax(0),
      yaw: ax(2) + (pressed(GP.RB) ? 1 : 0) - (pressed(GP.LB) ? 1 : 0),
      brake: btn(GP.A).value || (pressed(GP.A) ? 1 : 0),
    };
  }

  function syncFromModel() {
    // the flight model asks the lever to follow it after a reset / autopilot disconnect
    const g = globalThis.__game;
    const f = g && g.flight;
    if (f && typeof f.pendingThrottle === 'number' && Number.isFinite(f.pendingThrottle)) {
      setLever(f.pendingThrottle);
      f.pendingThrottle = null;
    }
  }

  function update(dt) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    clock += dt;
    syncFromModel();
    const k = (codes) => (any(codes) ? 1 : 0);
    const rate = PRESS_RATES[mode];
    kb.pitch = rampAxis(kb.pitch, k(AXES.pitchUp) - k(AXES.pitchDown), dt, rate.pitch);
    kb.roll = rampAxis(kb.roll, k(AXES.rollRight) - k(AXES.rollLeft), dt, rate.roll);
    kb.yaw = rampAxis(kb.yaw, k(AXES.yawRight) - k(AXES.yawLeft), dt, rate.yaw);
    const thr = k(AXES.throttleUp) - k(AXES.throttleDown);
    if (thr) moveLever(thr * (mode === 'helicopter' ? COLLECTIVE_RATE : THROTTLE_RATE) * dt);
    if (detent != null && Math.abs(state.throttle - detent) > 0.02) { abArmed = false; milArmed = false; }
    const b = k(AXES.brake);
    kb.brake = b ? Math.min(1, kb.brake + BRAKE_RATE * dt) : Math.max(0, kb.brake - BRAKE_RELEASE * dt);

    const gp = readGamepad(dt);
    if (touch.pitch || touch.roll || touch.yaw || touch.brake) lastKind = 'touch';
    state.pitch = clamp(kb.pitch + (gp ? gp.pitch : 0) + touch.pitch, -1, 1);
    state.roll = clamp(kb.roll + (gp ? gp.roll : 0) + touch.roll, -1, 1);
    state.yaw = clamp(kb.yaw + (gp ? gp.yaw : 0) + touch.yaw, -1, 1);
    state.brake = clamp(Math.max(kb.brake, gp ? gp.brake : 0, touch.brake), 0, 1);
  }

  const bindings = [];
  // rows other modules add to the F1 help: [{ keys, touch, label }] (free-flight challenges: Enter / GÖREV)
  let extraBindings = [];
  const addExtras = (add, touchRows) => { for (const b of extraBindings) { const k = touchRows ? b.touch : b.keys; if (k) add(k, b.label); } };
  /** F1 help rows for the on-screen controls (labels match the buttons of src/ui/touch.js). */
  function buildTouchBindings(add, heli, ftr) {
    if (heli) {
      add('Sol çubuk', 'Cyclic: ileri / geri, sola / sağa (bırakınca ortalanır)');
      add('Kolektif sürgüsü', 'Kolektif: yukarı it = yüksel, aşağı çek = alçal · bıraktığın yerde kalır');
      add('PEDAL', 'Kuyruk rotoru: şeridi sola / sağa kaydır, bırakınca ortalanır');
      add('HOVER', 'Otomatik havada asılı kalma (hover hold) aç / kapat · rota varsa rotayı uçar');
      add('FREN', 'Tekerlek freni (basılı tut)');
      add('ACİL', 'Arıza varken görünür: motor yangınında motoru kapatır ve söndürür');
    } else {
      add('Sol çubuk', ftr ? 'Burun (g komutu) ve yatış · geri çek = burun yukarı' : 'Burun ve yatış · geri çek = burun yukarı');
      add('Sol çubuk ↔', 'Yerde burun tekerleğini de çevirir; havada dümeni uçak kendisi koordine eder');
      add('Gaz sürgüsü', 'Gaz: yukarı it / aşağı çek · bıraktığın yerde kalır');
      if (ftr) add('MIL', 'Sürgü MIL çizgisinde durur; biraz daha yukarı it: art yakıcı');
      else add('REV', 'Yerde, rölantide sürgüyü IDLE çizgisinin altına çek: ters itki');
      add('TAKIM', 'İniş takımı indir / topla');
      add('FLAP ▲ / FLAP ▼', ftr ? 'Flap: otomatik / iniş konumu' : 'Flap bir kademe topla / indir');
      add('H.FREN', ftr ? 'Hava freni aç / kapat' : 'Spoiler / hava freni aç / kapat');
      add('AP', ftr ? 'Otopilot (irtifa / yön) aç / kapat' : 'Otopilot + otomatik gaz aç / kapat (iniş takımı inikken ILS yaklaşma)');
      add('AP açıkken', 'Çubuk irtifa ve yön hedefini, gaz sürgüsü hız hedefini değiştirir');
      add('FREN', 'Tekerlek freni (basılı tut)');
      add('ACİL', 'Arıza varken görünür: yangında motoru kapat + söndür, takım inmezse alternatif indirme, APU, motoru yeniden çalıştır');
    }
    add('KAMERA', 'Kamera değiştir');
    add('KOKPİT', 'Kokpit / dış görünüm');
    add('HARİTA', 'Harita: rota çiz, direkt git, piste yaklaş');
    addExtras(add, true);
    add('❚❚', 'Duraklat · Ayarlar · Yeniden başla · Ana menü');
    add('Ekranın ortası', 'Sürükle: etrafa bak / kamerayı döndür · Çift dokun: ortala');
    add('Eğim', 'Ayarlar → Kontroller → Eğimle kumanda: telefonu yatırarak uç');
  }
  function buildBindings() {
    bindings.length = 0;
    const heli = mode === 'helicopter', ftr = mode === 'fighter';
    const add = (keys, label) => bindings.push({ keys, label });
    if (touchMode) { buildTouchBindings(add, heli, ftr); return; }
    if (heli) {
      add('W / S  ·  ↑ / ↓', 'Cyclic ileri / geri (burun aşağı / yukarı)');
      add('A / D  ·  ← / →', 'Cyclic sola / sağa');
      add('Q / E', 'Pedal (kuyruk rotoru) sola / sağa');
      if (IS_MAC) {
        add('Shift / Ctrl', 'Kolektif artır / azalt');
        add('X / Z  ·  + / −', 'Kolektif artır / azalt (Ctrl+ok tuşları masaüstü değiştirdiği için bunlar önerilir)');
      } else {
        add('X / Z  ·  + / −', 'Kolektif artır / azalt');
        add('Shift', 'Kolektif artır');
      }
      add('1 … 9  ·  0', 'Kolektif %10 … %90  ·  %100');
      add('O', 'Otomatik havada asılı kalma (hover hold) aç / kapat · rota varsa rotayı uçar');
      add('I', 'Acil durum: motor yangınında motoru kapat ve söndür');
    } else {
      add('W / S  ·  ↑ / ↓', ftr ? 'Burun aşağı / yukarı (g komutu)' : 'Burun aşağı / yukarı');
      add('A / D  ·  ← / →', 'Sola / sağa yatış');
      add('Q / E', 'Dümen sola / sağa (yerde burun tekerleği)');
      if (IS_MAC) {
        add('Shift / Ctrl', 'Gaz artır / azalt');
        add('X / Z  ·  + / −', 'Gaz artır / azalt (Ctrl+ok tuşları masaüstü değiştirdiği için bunlar önerilir)');
      } else {
        add('X / Z  ·  + / −', 'Gaz artır / azalt');
        add('Shift', 'Gaz artır');
      }
      if (ftr) {
        add('1 … 9  ·  0', 'Gaz ön ayarı (9 = MIL / askeri güç)  ·  0 = tam art yakıcı');
        add('Gaz tuşu MIL\'de', 'Art yakıcı: MIL kademesinde durur, bırakıp tekrar basınca art yakıcıya geçer');
      } else add('1 … 9  ·  0', 'Gaz %10 … %90  ·  %100 (TOGA)');
      add('G', 'İniş takımı indir / topla');
      add('F / V', ftr ? 'Flap: iniş konumu / otomatik' : 'Flap bir kademe indir / topla');
      add('K', ftr ? 'Hava freni (bas: aç/kapa, basılı tut: geçici)' : 'Spoiler / hava freni (bas: aç/kapa, basılı tut: geçici)');
      if (!ftr) add('N', 'Ters itki (yerde, rölantide) aç / kapat — sonra gaz = ters itki');
      if (ftr) add('U', 'Kanopi aç / kapa (yerde)');
      add('O', ftr ? 'Otopilot (irtifa / yön) aç / kapa' : 'Otopilot + otomatik gaz aç / kapa (iniş takımı inikken ILS yaklaşma)');
      add('Otopilot açıkken', 'W/S irtifa hedefi, A/D yön hedefi, gaz tuşları hız hedefi; yaklaşmada çubuk otopilotu kapatır');
      add('Rota varken', 'O otopilotu rotada (LNAV) açar; A/D ile dönmek yön moduna (HDG) geçirir, rota haritada kalır');
      add('I', 'Acil durum: yangında motoru kapat + söndür · takım inmezse alternatif indirme · APU · motoru yeniden çalıştır');
    }
    add('B / Boşluk', heli ? 'Tekerlek freni' : 'Fren (basılı tut)');
    add('L', 'Işıklar');
    add('C  ·  , / .', 'Kamera değiştir (önceki / sonraki)');
    add(`${CAMERA_KEY_MOD} + 1 … ${CAMERA_ORDER.length}`, `Kameraya doğrudan geç: ${CAMERA_ORDER.map((id, i) => `${i + 1} ${CAMERA_NAMES[id]}`).join(' · ')}`);
    add(`${CAMERA_KEY_MOD} + ${CAMERA_ORDER.indexOf('birdseye') + 1}`, 'Kuşbakışında tekrar bas: kuzey / uçuş yönü yukarıda · tekerlek: yükseklik · sürükle: kaydır · çift tık: ortala');
    add('T', 'Kokpit / dış görünüm');
    add('Y', 'Arkaya bak');
    add('R', 'Yeniden başla');
    add('P / Esc', 'Duraklat');
    add('H', 'Göstergeleri gizle / göster');
    add('J', 'Harita: rota çiz, direkt git, piste yaklaş (Esc kapatır)');
    addExtras(add, false);
    add('M', 'Sesi kapat / aç');
    add('F1 / ?', 'Yardım');
    add('Tab', 'Ana menü');
    add('Oyun kolu', `Sol çubuk: ${heli ? 'cyclic' : 'burun / yatış'} · Sağ çubuk: pedal / ${heli ? 'kolektif' : 'gaz'} · RT / LT: ${heli ? 'kolektif' : 'gaz'} · LB / RB: dümen`);
    add('Oyun kolu', 'A: fren · B / X: flap · Y: kamera · D-pad ↑ takım, ↓ hava freni, ← otopilot, → HUD · L3: ters itki · R3: görünüm · Start: duraklat · Back: yeniden başla');
  }
  buildBindings();

  return {
    state,
    update,
    on(action, cb) { (handlers[action] ||= []).push(cb); },
    bindings,
    /** Adapt to the aircraft: fighter AB detent, helicopter collective. */
    setAircraft(spec) {
      const cat = spec && spec.category;
      mode = cat === 'helicopter' ? 'helicopter' : cat === 'fighter' ? 'fighter' : 'airliner';
      detent = mode === 'fighter' && spec.abDetent ? spec.abDetent : null;
      setLever(0);
      kb.pitch = kb.roll = kb.yaw = 0;
      buildBindings();
    },
    /** Put the lever at v (0..1), e.g. to match the flight model after a reset. */
    setThrottle(v) { setLever(v); },
    get gamepadConnected() { return gamepadConnected; },
    get afterburnerDetent() { return detent; },
    /** Touch source (src/ui/touch.js): absolute axes −1..1 (brake 0..1), added to the keyboard / gamepad axes. */
    touch,
    /** Lever from the touch slider (0..1); the slider applies the AB detent / reverse range itself. */
    setTouchLever(v) { state.throttle = clamp(Number.isFinite(v) ? v : 0, 0, 1); abArmed = false; milArmed = false; lastKind = 'touch'; },
    /** Fire an action as if its key had been pressed (on-screen buttons). */
    trigger(action, arg) { lastKind = 'touch'; fire(action, arg); },
    /** Touch controls on / off: the F1 help lists the on-screen controls instead of the keys. */
    setTouchMode(on) { touchMode = !!on; if (touchMode) lastKind = 'touch'; buildBindings(); },
    get touchMode() { return touchMode; },
    /** Input device used last: 'kb' | 'pad' | 'touch'. */
    get kind() { return lastKind; },
    /** Extra F1 help rows [{ keys, touch, label }] from other modules (the key handling stays theirs). */
    setExtraBindings(list) { extraBindings = Array.isArray(list) ? list : []; buildBindings(); },
  };
}
