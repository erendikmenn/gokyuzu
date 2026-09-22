// Player input: keyboard (KeyboardEvent.code, layout independent) + standard-mapping gamepad.
// Produces a smoothed InputState (see CONTRACTS.md) and one-shot actions.

// Keyboard axes ramp toward +-1 while held (a tap = small correction, a long hold = full deflection)
// and snap back quickly when released. Pitch ramps slowest: it is the most sensitive axis.
const PRESS_RATE = { pitch: 1.8, roll: 3.5, yaw: 3 };
const AXIS_RELEASE_RATE = 8;    // ramp back to 0 when released
const AXIS_REVERSE_RATE = 10;   // switching direction (passes through 0 quickly)
const THROTTLE_RATE = 0.45;     // lever travel per second while a throttle key is held
const DEADZONE = 0.12;

const AXES = {
  pitchUp: ['KeyS', 'ArrowDown'],   // pull back: nose up
  pitchDown: ['KeyW', 'ArrowUp'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'KeyX', 'Equal', 'NumpadAdd'],
  throttleDown: ['ControlLeft', 'ControlRight', 'KeyZ', 'Minus', 'NumpadSubtract'],
  brake: ['KeyB', 'Space'],
};

const ACTION_KEYS = {
  KeyC: 'camera', KeyR: 'reset', KeyP: 'pause', Escape: 'pause',
  KeyH: 'hud', KeyM: 'mute', F1: 'help', Slash: 'help', IntlRo: 'help',
};

const THROTTLE_PRESETS = {};
for (let i = 1; i <= 9; i++) { THROTTLE_PRESETS[`Digit${i}`] = i / 10; THROTTLE_PRESETS[`Numpad${i}`] = i / 10; }
THROTTLE_PRESETS.Digit0 = 1; THROTTLE_PRESETS.Numpad0 = 1;

const FLAP_STEPS = [0, 0.5, 1];

// standard gamepad buttons
const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const GP_ACTIONS = { [GP.Y]: 'camera', [GP.BACK]: 'reset', [GP.START]: 'pause', [GP.LEFT]: 'hud', [GP.RIGHT]: 'help' };

const HANDLED = new Set([...Object.values(AXES).flat(), ...Object.keys(ACTION_KEYS), ...Object.keys(THROTTLE_PRESETS), 'KeyF', 'KeyV']);

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
  const state = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: false };
  const kb = { pitch: 0, roll: 0, yaw: 0 };
  let flapIndex = 0;
  let gpPrev = [];
  let gamepadConnected = false;

  const fire = (action) => { for (const cb of handlers[action] || []) cb(); };
  const any = (codes) => codes.some((c) => down.has(c));
  const setFlaps = (i) => { flapIndex = clamp(i, 0, FLAP_STEPS.length - 1); state.flaps = FLAP_STEPS[flapIndex]; };

  function onKeyDown(e) {
    if (e.metaKey) return; // leave Cmd shortcuts to the browser/OS
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    const code = e.code;
    const isHelpKey = e.key === '?';
    if (HANDLED.has(code) || isHelpKey) e.preventDefault();
    down.add(code);
    if (e.repeat) return;
    if (isHelpKey && code !== 'Slash' && code !== 'IntlRo') fire('help');
    const action = ACTION_KEYS[code];
    if (action) fire(action);
    if (code in THROTTLE_PRESETS) state.throttle = THROTTLE_PRESETS[code];
    if (code === 'KeyF') setFlaps(flapIndex >= FLAP_STEPS.length - 1 ? 0 : flapIndex + 1); // extend (wraps to up)
    if (code === 'KeyV') setFlaps(flapIndex - 1); // retract one step
  }
  function onKeyUp(e) {
    down.delete(e.code);
    // macOS does not send keyup for keys released while Cmd is held
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') down.clear();
    if (HANDLED.has(e.code)) e.preventDefault();
  }
  const releaseAll = () => down.clear();

  if (target && target.addEventListener) {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', releaseAll);
    const doc = target.document;
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', () => { if (doc.hidden) releaseAll(); });
  }

  function readGamepad(dt) {
    const nav = globalThis.navigator;
    const pads = nav && nav.getGamepads ? nav.getGamepads() : null;
    let pad = null;
    if (pads) for (const p of pads) if (p && p.connected) { pad = p; break; }
    gamepadConnected = !!pad;
    if (!pad) { gpPrev = []; return null; }
    const ax = (i) => deadzone(pad.axes[i] || 0);
    const btn = (i) => pad.buttons[i] || { pressed: false, value: 0 };
    const pressed = (i) => btn(i).pressed;
    const edge = (i) => pressed(i) && !gpPrev[i];

    // throttle: triggers (analog) and right stick Y
    const thr = (btn(GP.RT).value || 0) - (btn(GP.LT).value || 0) - ax(3);
    if (Math.abs(thr) > 0.05) state.throttle = clamp(state.throttle + thr * THROTTLE_RATE * 1.5 * dt, 0, 1);

    for (const [b, action] of Object.entries(GP_ACTIONS)) if (edge(Number(b))) fire(action);
    if (edge(GP.B) || edge(GP.DOWN)) setFlaps(flapIndex + 1);
    if (edge(GP.X) || edge(GP.UP)) setFlaps(flapIndex - 1);

    gpPrev = pad.buttons.map((b) => b.pressed);
    return {
      pitch: ax(1),                       // stick back (+) = nose up
      roll: ax(0),
      yaw: ax(2) + (pressed(GP.RB) ? 1 : 0) - (pressed(GP.LB) ? 1 : 0),
      brake: pressed(GP.A),
    };
  }

  function update(dt) {
    dt = clamp(dt || 0, 0, 0.1);
    const k = (codes) => (any(codes) ? 1 : 0);
    kb.pitch = rampAxis(kb.pitch, k(AXES.pitchUp) - k(AXES.pitchDown), dt, PRESS_RATE.pitch);
    kb.roll = rampAxis(kb.roll, k(AXES.rollRight) - k(AXES.rollLeft), dt, PRESS_RATE.roll);
    kb.yaw = rampAxis(kb.yaw, k(AXES.yawRight) - k(AXES.yawLeft), dt, PRESS_RATE.yaw);
    const thr = k(AXES.throttleUp) - k(AXES.throttleDown);
    if (thr) state.throttle = clamp(state.throttle + thr * THROTTLE_RATE * dt, 0, 1);

    const gp = readGamepad(dt);
    state.pitch = clamp(kb.pitch + (gp ? gp.pitch : 0), -1, 1);
    state.roll = clamp(kb.roll + (gp ? gp.roll : 0), -1, 1);
    state.yaw = clamp(kb.yaw + (gp ? gp.yaw : 0), -1, 1);
    state.brake = any(AXES.brake) || !!(gp && gp.brake);
  }

  const bindings = [
    { keys: 'W / S  ·  ↑ / ↓', label: 'Burnu indir / kaldır' },
    { keys: 'A / D  ·  ← / →', label: 'Sola / sağa yatış' },
    { keys: 'Q / E', label: 'Dümen sola / sağa (yerde burun tekeri)' },
    { keys: 'Shift / Ctrl', label: 'Gaz artır / azalt' },
    { keys: 'X / Z  ·  + / −', label: 'Gaz artır / azalt (Mac için)' },
    { keys: '1 … 9  ·  0', label: 'Gaz %10 … %90  ·  %100' },
    { keys: 'F / V', label: 'Flap indir / topla' },
    { keys: 'B / Boşluk', label: 'Fren' },
    { keys: 'C', label: 'Kamera değiştir' },
    { keys: 'R', label: 'Yeniden başla' },
    { keys: 'P / Esc', label: 'Duraklat' },
    { keys: 'H', label: 'Göstergeleri gizle / göster' },
    { keys: 'M', label: 'Sesi kapat / aç' },
    { keys: 'F1 / ?', label: 'Yardım' },
    { keys: 'Oyun kolu', label: 'Sol çubuk: burun / yatış · Sağ çubuk: dümen / gaz · RT / LT: gaz · LB / RB: dümen' },
    { keys: 'Oyun kolu', label: 'A: fren · B / X: flap indir / topla · Y: kamera · Start: duraklat · Back: yeniden başla' },
  ];

  return {
    state,
    update,
    on(action, cb) { (handlers[action] ||= []).push(cb); },
    bindings,
    get gamepadConnected() { return gamepadConnected; },
  };
}
