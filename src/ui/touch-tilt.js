// Tilt steering (optional, Ayarlar → Kontroller → "Eğimle kumanda"): the phone held in landscape like a steering wheel.
// Rotating it (right side down) rolls right; tilting the top edge away from you lowers the nose. The DeviceOrientation
// angles are turned into the gravity vector in screen coordinates (so the screen rotation — landscape left / right —
// and the gimbal flips of beta / gamma near vertical do not matter), then measured against a calibrated neutral pose.
// iOS 13+ needs DeviceOrientationEvent.requestPermission() from a user gesture (the settings switch calls request()).
//
//   const tilt = getTilt();  tilt.request() → Promise<'granted' | 'denied' | 'unsupported'>
//   tilt.start(); tilt.stop(); tilt.calibrate();  tilt.read(out) → true when out.pitch / out.roll (−1..1) are valid
const DEG = Math.PI / 180;
const ROLL_RANGE = 28 * DEG, PITCH_RANGE = 22 * DEG, DEAD = 1.5 * DEG;

let single = null;
/** The page's tilt source (one listener for the whole page). */
export function getTilt() {
  if (!single) single = createTilt();
  return single;
}

function screenAngle() {
  try {
    if (screen.orientation && Number.isFinite(screen.orientation.angle)) return screen.orientation.angle;
  } catch { /* ignore */ }
  const o = Number(window.orientation);
  return Number.isFinite(o) ? o : 0;
}

function createTilt() {
  const supported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  const needsPermission = supported && typeof DeviceOrientationEvent.requestPermission === 'function';
  let running = false, have = false, lastAt = 0, calibrateNext = true;
  let roll = 0, pitch = 0, roll0 = 0, pitch0 = 0, sRoll = 0, sPitch = 0, lastT = 0;

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    const b = e.beta * DEG, gm = e.gamma * DEG;
    // gravity (pointing down) in device coordinates for the Z-X'-Y'' Euler angles of the spec
    const dx = Math.sin(gm) * Math.cos(b), dy = -Math.sin(b), dz = -Math.cos(gm) * Math.cos(b);
    // device → screen axes (screen x right, y up, z out of the glass) for the current screen rotation
    const a = screenAngle() * DEG, ca = Math.cos(a), sa = Math.sin(a);
    const sx = dx * ca - dy * sa, sy = dx * sa + dy * ca;
    roll = Math.atan2(sx, -sy);                         // steering-wheel angle, + = rotated clockwise
    pitch = Math.atan2(-dz, Math.hypot(sx, sy));        // + = screen facing further up (top edge away from you)
    have = true; lastAt = performance.now();
    if (calibrateNext) { calibrateNext = false; roll0 = roll; pitch0 = pitch; sRoll = 0; sPitch = 0; }
  }

  const shape = (v, range) => {
    const a = Math.abs(v);
    if (a < DEAD) return 0;
    const x = Math.min(1, (a - DEAD) / (range - DEAD));
    return Math.sign(v) * (0.45 * x + 0.55 * x * x);  // a little expo: calm near neutral
  };
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));

  return {
    supported, needsPermission,
    get running() { return running; },
    /** True once orientation events arrive (desktops have the API but never fire it). */
    get receiving() { return have && performance.now() - lastAt < 1500; },
    /** Ask for the motion-sensor permission (iOS; call from a click / tap handler). */
    request() {
      if (!supported) return Promise.resolve('unsupported');
      if (!needsPermission) return Promise.resolve('granted');
      try {
        return DeviceOrientationEvent.requestPermission().then((r) => (r === 'granted' ? 'granted' : 'denied')).catch(() => 'denied');
      } catch { return Promise.resolve('denied'); }
    },
    start() {
      if (running || !supported) return;
      running = true; have = false; calibrateNext = true;
      window.addEventListener('deviceorientation', onOrient);
    },
    stop() {
      if (!running) return;
      running = false; have = false;
      window.removeEventListener('deviceorientation', onOrient);
    },
    /** The present pose becomes neutral (next sample). */
    calibrate() { calibrateNext = true; },
    /** out.roll / out.pitch in −1..1 (+ = roll right / nose up). */
    read(out) {
      if (!running || !have || performance.now() - lastAt > 1500) { out.roll = 0; out.pitch = 0; return false; }
      const now = performance.now();
      const k = lastT ? Math.min(1, (now - lastT) / 70) : 1;   // ≈ 70 ms smoothing against sensor jitter
      lastT = now;
      sRoll += (shape(wrap(roll - roll0), ROLL_RANGE) - sRoll) * k;
      sPitch += (shape(wrap(pitch - pitch0), PITCH_RANGE) - sPitch) * k;
      out.roll = sRoll;
      out.pitch = -sPitch;                                // top edge away (screen up) = nose down
      return true;
    },
  };
}
