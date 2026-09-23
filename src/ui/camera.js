// Camera rig: cockpit (head look, g-force head motion, runway rumble), chase (spring follow), orbit (free),
// flyby, tower (nearest airport) and wing (rigid wingtip camera). All smoothing is exponential and
// frame-rate independent; nothing allocates per frame.
import * as THREE from 'three';
import { shared, loadRunways } from './shared.js';
import { clamp, damp, smoothstep, DEG } from './util.js';

const ORDER = ['cockpit', 'chase', 'wing', 'orbit', 'flyby', 'tower'];
export const CAMERA_NAMES = { cockpit: 'Kokpit', chase: 'Takip', wing: 'Kanat', orbit: 'Serbest', flyby: 'Geçiş', tower: 'Kule' };
const UP = new THREE.Vector3(0, 1, 0);
const MIN_CLEARANCE = 1.5;
const NEAR_IN = 0.05, NEAR_OUT = 0.5;
const HEAD_YAW_MAX = 150 * DEG, HEAD_PITCH_MAX = 80 * DEG;

// Approximate control-tower cab positions (local meters) and eye heights above ground.
// KSFO: the 2016 tower between terminals 1 and 2 (landmarks.json sfo_tower); KOAK: south-field tower;
// KNGZ (fictional base): north apron. The eye sits a few meters off the cab, toward the field.
const TOWERS = {
  KSFO: { x: -749, z: 301, h: 60 },
  KOAK: { x: 13979, z: -10536, h: 42 },
  KNGZ: { x: 5325, z: -19016, h: 36 },
};

export function createCameraRig(camera, dom, world) {
  // ---------- aircraft ----------
  let rig = null, def = null, category = 'airliner';
  const bounds = { length: 15, span: 12, height: 4, radius: 8 };
  const eye = new THREE.Vector3(0, 1, -3);

  // ---------- state ----------
  let mode = 'chase', lastExterior = 'chase';
  let snap = true;
  let time = 0;
  const prevPos = new THREE.Vector3(), prevVel = new THREE.Vector3();
  let havePrev = false;
  const vel = new THREE.Vector3();                 // aircraft velocity (world)
  const acc = new THREE.Vector3();                 // smoothed kinematic acceleration (world)
  let moveSpeed = 0;                               // smoothed actual displacement speed (0 while paused)
  let wasOnGround = true;
  let impact = 0;                                  // touchdown jolt envelope

  let fov = camera.fov || 60, near = camera.near || 0.5;

  // chase
  const smFwd = new THREE.Vector3(0, 0, -1), smUp = new THREE.Vector3(0, 1, 0);
  const lag = new THREE.Vector3();
  let chaseDist = 30, chaseZoom = 1, chaseFov = 58;
  let cYaw = 0, cPitch = 0, cYawT = 0, cPitchT = 0, cIdle = 0;

  // cockpit / wing head look
  let hYaw = 0, hPitch = 0, hYawT = 0, hPitchT = 0, hIdle = 0;
  let cockpitFov = 70, cockpitFovT = 70;
  const headOff = new THREE.Vector3(), headVel = new THREE.Vector3(), headTarget = new THREE.Vector3();
  let lookBackOn = false, lookBackT = 0;

  // orbit
  let oYaw = 0, oPitch = 0.3, oDist = 40, oYawT = 0, oPitchT = 0.3, oDistT = 40, orbitInit = true;

  // flyby
  const flyPos = new THREE.Vector3();
  let flyValid = false, flySide = 1, flyFovMul = 1;

  // tower
  let towerKey = null, towerCheck = 0, towerFovMul = 1;
  const towerPos = new THREE.Vector3();
  const towerLook = new THREE.Vector3();
  let towerLookInit = false;

  // scratch
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), Qi = new THREE.Quaternion();
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const tFwd = new THREE.Vector3(), tUp = new THREE.Vector3(), hUp = new THREE.Vector3();
  const pos = new THREE.Vector3(), look = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const off = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');

  shared.camera = camera;
  shared.cameraMode = mode;
  loadRunways();

  // ---------- pointer input on the canvas ----------
  let dragging = false, pid = null, lx = 0, ly = 0;
  const lookModes = new Set(['cockpit', 'wing', 'chase', 'orbit']);
  if (dom && dom.addEventListener) {
    dom.addEventListener('pointerdown', (e) => {
      if (!lookModes.has(mode) || (e.button !== 0 && e.button !== 2)) return;
      dragging = true; pid = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      const h = dom.clientHeight || window.innerHeight || 900;
      const k = 1.9 / h;                                  // ≈ full screen height drag = 110°
      if (mode === 'cockpit' || mode === 'wing') {
        const z = (mode === 'cockpit' ? cockpitFov : 60) / 70;
        hYawT = clamp(hYawT - dx * k * z, -HEAD_YAW_MAX, HEAD_YAW_MAX);
        hPitchT = clamp(hPitchT - dy * k * z, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
        hIdle = 0;
      } else if (mode === 'chase') {
        cYawT -= dx * k * 1.6;
        cPitchT = clamp(cPitchT + dy * k * 1.2, -0.5, 1.2);
        cIdle = 0;
      } else if (mode === 'orbit') {
        oYawT -= dx * k * 1.8;
        oPitchT = clamp(oPitchT + dy * k * 1.4, -0.6, 1.5);
      }
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      dragging = false; pid = null;
      try { dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const z = Math.exp(clamp(dy, -200, 200) * 0.0012);
      if (mode === 'cockpit') cockpitFovT = clamp(cockpitFovT * z, 22, 100);
      else if (mode === 'orbit') oDistT = clamp(oDistT * z, bounds.radius * 1.25, 8000);
      else if (mode === 'chase') chaseZoom = clamp(chaseZoom * z, 0.55, 4);
      else if (mode === 'flyby') flyFovMul = clamp(flyFovMul * z, 0.35, 3);
      else if (mode === 'tower') towerFovMul = clamp(towerFovMul * z, 0.25, 4);
      else return;
      e.preventDefault();
    }, { passive: false });
    // Safari trackpad pinch (gesture events): zoom instead of scaling the page
    let gScale = 1;
    dom.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = e.scale || 1; });
    dom.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const sc = e.scale || 1;
      const z = clamp(gScale / sc, 0.5, 2);
      gScale = sc;
      if (mode === 'cockpit') cockpitFovT = clamp(cockpitFovT * z, 22, 100);
      else if (mode === 'orbit') oDistT = clamp(oDistT * z, bounds.radius * 1.25, 8000);
      else if (mode === 'chase') chaseZoom = clamp(chaseZoom * z, 0.55, 4);
      else if (mode === 'flyby') flyFovMul = clamp(flyFovMul * z, 0.35, 3);
      else if (mode === 'tower') towerFovMul = clamp(towerFovMul * z, 0.25, 4);
    });
    dom.addEventListener('gestureend', (e) => e.preventDefault());
    dom.addEventListener('dblclick', () => {
      if (mode === 'cockpit' || mode === 'wing') { hYawT = 0; hPitchT = 0; cockpitFovT = defaultCockpitFov(); }
      else if (mode === 'chase') { cYawT = 0; cPitchT = 0; chaseZoom = 1; }
      else if (mode === 'orbit') orbitInit = true;
      else if (mode === 'tower') towerFovMul = 1;
      else if (mode === 'flyby') { flyFovMul = 1; flyValid = false; }
    });
    dom.addEventListener('contextmenu', (e) => { if (lookModes.has(mode)) e.preventDefault(); });
  }

  // ---------- helpers ----------
  function groundAt(x, z) {
    try {
      const h = world && typeof world.getGroundHeight === 'function' ? world.getGroundHeight(x, z) : 0;
      return Number.isFinite(h) ? h : 0;
    } catch { return 0; }
  }
  function clampAboveGround(p) {
    const g = groundAt(p.x, p.z) + MIN_CLEARANCE;
    if (p.y < g) p.y = g;
  }
  // Spring arm against world solids (buildings, bridge towers): pull the camera toward the aircraft until the
  // camera sphere is clear. Uses world.hitTest (from the proxy, or the full world once main.js has it).
  let arm = 1;
  const armFrom = new THREE.Vector3(), armTo = new THREE.Vector3();
  function fullWorld() {
    if (world && typeof world.hitTest === 'function') return world;
    const w = globalThis.__game && globalThis.__game.world;
    return w && typeof w.hitTest === 'function' ? w : null;
  }
  function blocked(w, p) {
    try { return !!w.hitTest(p.x, p.y, p.z, 0.8); } catch { return false; }
  }
  function armCollide(dt, from, p) {
    const w = fullWorld();
    let target = 1;
    if (w && blocked(w, p)) {
      armFrom.copy(from); armTo.copy(p);
      let lo = 0, hi = 1;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        tmp2.lerpVectors(armFrom, armTo, mid);
        if (blocked(w, tmp2)) hi = mid; else lo = mid;
      }
      target = Math.max(0.08, lo * 0.97);
      p.copy(armTo);
    }
    // shorten instantly (never clip), lengthen smoothly
    arm = target < arm || snap ? target : arm + (target - arm) * damp(1.8, dt);
    if (arm < 0.999) p.lerpVectors(from, p, arm);
  }

  function setLens(n, f) {
    let dirty = false;
    if (Math.abs(camera.near - n) > 1e-5) { camera.near = n; dirty = true; }
    if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; dirty = true; }
    if (dirty) camera.updateProjectionMatrix();
  }
  function lookFrom(eyePos, target, upv) {
    camera.position.copy(eyePos);
    if (eyePos.distanceToSquared(target) < 1e-8) return;
    m4.lookAt(eyePos, target, upv);
    camera.quaternion.setFromRotationMatrix(m4);
  }
  function defaultCockpitFov() {
    return category === 'fighter' ? 74 : category === 'helicopter' ? 76 : 70;
  }
  // smooth pseudo-random shake: sum of incommensurate sines (a pure function of time → no frame-rate dependency)
  function noise(t, seed) {
    return Math.sin(t * 31.7 + seed) * 0.5 + Math.sin(t * 53.3 + seed * 2.1) * 0.3 + Math.sin(t * 89.9 + seed * 3.7) * 0.2;
  }
  function slowNoise(t, seed) {
    return Math.sin(t * 0.37 + seed) * 0.6 + Math.sin(t * 0.83 + seed * 1.9) * 0.4;
  }
  function airports() {
    const rw = (world && world.runways) || (globalThis.__game && globalThis.__game.world && globalThis.__game.world.runways) || shared.runways;
    if (rw && !shared.runways) shared.runways = rw;
    return rw && Array.isArray(rw.airports) ? rw.airports : [];
  }

  // ---------- per-frame shared kinematics ----------
  function kinematics(dt, f) {
    const src = rig && rig.object ? rig.object : f;
    P.copy(src.position);
    Q.copy(src.quaternion);
    Qi.copy(Q).invert();
    if (f.velocity && Number.isFinite(f.velocity.x)) vel.copy(f.velocity);
    else if (havePrev && dt > 1e-4) vel.subVectors(P, prevPos).divideScalar(dt);
    fwd.set(0, 0, -1).applyQuaternion(Q);
    up.set(0, 1, 0).applyQuaternion(Q);
    right.set(1, 0, 0).applyQuaternion(Q);

    if (havePrev) {
      const jump = P.distanceTo(prevPos);
      if (jump > Math.max(40, vel.length() * dt * 4 + 15)) snap = true;
    }
    if (!havePrev || snap) {
      acc.set(0, 0, 0); moveSpeed = vel.length(); flyValid = false; towerLookInit = false;
    } else if (dt > 1e-4) {
      tmp.subVectors(vel, prevVel).divideScalar(dt);
      if (tmp.lengthSq() > 200 * 200) tmp.setLength(200);
      acc.lerp(tmp, damp(9, dt));
      const ds = P.distanceTo(prevPos) / dt;
      moveSpeed += (ds - moveSpeed) * damp(12, dt);
    }
    // touchdown jolt
    const onGround = !!f.onGround;
    if (onGround && !wasOnGround && !snap) {
      const vs = Math.abs(Number.isFinite(f.verticalSpeed) ? f.verticalSpeed : 1.5);
      impact = Math.max(impact, clamp(0.25 + vs * 0.35, 0.25, 1.6));
      headVel.y -= clamp(0.08 + vs * 0.09, 0.08, 0.6);
    }
    wasOnGround = onGround;
    impact = Math.max(0, impact - dt * 2.2);
    prevPos.copy(P); prevVel.copy(vel); havePrev = true;
  }

  // ---------- chase ----------
  function updateChase(dt, f) {
    const speed = vel.length();
    tFwd.copy(fwd);
    if (!f.onGround && speed > 25) {
      tmp.copy(vel).normalize();
      if (tmp.dot(fwd) > 0.2) tFwd.lerp(tmp, 0.4).normalize();
    }
    // camera up: mostly level with the horizon keeping ~30% of the bank; fades to the aircraft's up when
    // near vertical or inverted so loops and rolls stay continuous
    hUp.copy(UP).addScaledVector(tFwd, -tFwd.y);
    const hl = hUp.length();
    let w = 0;
    if (hl > 1e-3) {
      hUp.divideScalar(hl);
      w = 0.7 * clamp(hl * hl, 0, 1) * clamp((up.y + 0.1) / 0.4, 0, 1);
      if (f.onGround || f.crashed) w = 1;            // on the ground (or wrecked) keep the camera level
    }
    tUp.copy(up).multiplyScalar(1 - w).addScaledVector(hUp, w).normalize();

    const R = bounds.radius;
    const distT = (R * 2.2 + 7) * chaseZoom + clamp(speed, 0, 300) * 0.018 * Math.sqrt(R / 8);
    const height = (bounds.height * 0.5 + R * 0.34) * Math.sqrt(chaseZoom);
    if (snap) {
      smFwd.copy(tFwd); smUp.copy(tUp); chaseDist = distT; lag.set(0, 0, 0);
      cYaw = cYawT; cPitch = cPitchT;
    } else {
      smFwd.lerp(tFwd, damp(4.4, dt)).normalize();
      smUp.lerp(tUp, damp(3.4, dt));
      chaseDist += (distT - chaseDist) * damp(2.2, dt);
    }
    smUp.addScaledVector(smFwd, -smUp.dot(smFwd));
    if (smUp.lengthSq() < 1e-6) smUp.copy(up);
    smUp.normalize();

    // spring lag: the camera falls behind under acceleration (kinematic offset −a/ω², ω ≈ 4 rad/s)
    tmp.copy(acc).multiplyScalar(-1 / 16);
    const maxLag = chaseDist * 0.16;
    if (tmp.lengthSq() > maxLag * maxLag) tmp.setLength(maxLag);
    lag.lerp(tmp, snap ? 1 : damp(3, dt));

    // mouse look-around (springs back when idle) and look-back
    cIdle += dt;
    if (!dragging && cIdle > 1.6 && !lookBackOn) { cYawT -= cYawT * damp(2.2, dt); cPitchT -= cPitchT * damp(2.2, dt); }
    const yawGoal = cYawT + (lookBackOn ? Math.PI : 0);
    cYaw += (yawGoal - cYaw) * (snap ? 1 : damp(7, dt));
    cPitch += (cPitchT - cPitch) * (snap ? 1 : damp(7, dt));

    // offset in the smoothed frame
    off.copy(smFwd).multiplyScalar(-chaseDist).addScaledVector(smUp, height);
    const looking = Math.abs(cYaw) > 1e-4 || Math.abs(cPitch) > 1e-4;
    if (looking) {
      tmp.crossVectors(smFwd, smUp).normalize();          // right
      qA.setFromAxisAngle(smUp, cYaw);
      qB.setFromAxisAngle(tmp, -cPitch);
      qA.multiply(qB);
      off.applyQuaternion(qA);
    }
    pos.copy(P).add(off).add(lag);
    armCollide(dt, P, pos);
    clampAboveGround(pos);
    // look-ahead: the view leads into turns (blend of the lagged frame toward the current flight path)
    tmp.copy(smFwd).lerp(tFwd, 0.35).normalize();
    tmp2.copy(tmp).multiplyScalar(chaseDist * 3).addScaledVector(smUp, height * 0.62);
    if (looking) tmp2.applyQuaternion(qA);
    look.copy(P).add(tmp2).addScaledVector(lag, 0.5);
    lookFrom(pos, look, smUp);

    chaseFov = 57 + smoothstep(50, 330, speed) * 12;
    fov += (chaseFov - fov) * (snap ? 1 : damp(1.4, dt));
    setLens(NEAR_OUT, fov);
  }

  // ---------- cockpit ----------
  function headLook(dt, allowReturn) {
    hIdle += dt;
    if (allowReturn && !dragging && hIdle > 3 && !lookBackOn) {
      hYawT -= hYawT * damp(1.6, dt);
      hPitchT -= hPitchT * damp(1.6, dt);
    }
    const yGoal = lookBackOn ? (hYawT >= -0.3 ? HEAD_YAW_MAX : -HEAD_YAW_MAX) : hYawT;
    const pGoal = lookBackOn ? 10 * DEG : hPitchT;
    const k = snap ? 1 : damp(lookBackOn || lookBackT > 0 ? 7 : 16, dt);
    hYaw += (yGoal - hYaw) * k;
    hPitch += (pGoal - hPitch) * k;
    lookBackT = Math.max(0, lookBackT - dt);
  }

  function updateHeadSpring(dt, f) {
    // body-frame acceleration drives a small damped head displacement (eyes sag under g, lurch on thrust)
    const g = Number.isFinite(f.gForce) ? f.gForce : 1;
    tmp.copy(acc).applyQuaternion(Qi);
    headTarget.set(
      clamp(-tmp.x * 0.0035, -0.05, 0.05),
      clamp(-(g - 1) * 0.011, -0.075, 0.035),
      clamp(-tmp.z * 0.004, -0.05, 0.07),
    );
    const omega = 10, zeta = 0.55;
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(t, 1 / 120);
      tmp.subVectors(headTarget, headOff).multiplyScalar(omega * omega).addScaledVector(headVel, -2 * zeta * omega);
      headVel.addScaledVector(tmp, h);
      headOff.addScaledVector(headVel, h);
      t -= h;
    }
    if (snap) { headOff.copy(headTarget); headVel.set(0, 0, 0); }
  }

  function shakeAmount(f) {
    // runway rumble grows with ground roll speed; stall buffet; helicopter rotor vibration; touchdown jolt
    const gs = moveSpeed;
    let a = f.onGround ? Math.pow(clamp(gs / 70, 0, 1), 0.7) * (gs > 0.5 ? 1 : 0) : 0;
    const stalled = !!f.stalled || !!(f.warnings && f.warnings.stall);
    if (stalled && !f.onGround) a = Math.max(a, 0.8);
    const rpm = Number.isFinite(f.rotorRPM) ? f.rotorRPM : 0;
    if (category === 'helicopter' && rpm > 0.3 && gs > 0.01) a = Math.max(a, 0.18 * clamp(rpm, 0, 1.2));
    const hiQ = !f.onGround && gs > 0 ? smoothstep(250, 420, vel.length()) * 0.25 : 0;
    return Math.max(a, hiQ) + impact;
  }

  function updateCockpit(dt, f) {
    headLook(dt, true);
    updateHeadSpring(dt, f);
    cockpitFov += (cockpitFovT - cockpitFov) * (snap ? 1 : damp(10, dt));

    const sh = shakeAmount(f);
    const rx = noise(time, 1.3) * 0.0026 * sh, ry = noise(time, 4.1) * 0.0018 * sh, rz = noise(time, 7.7) * 0.0022 * sh;
    const g = Number.isFinite(f.gForce) ? f.gForce : 1;
    const gPitch = clamp(-(g - 1) * 0.0045, -0.03, 0.012);

    // neck pivot 10 cm behind the eyes + lean to the side when looking far back
    const ay = Math.abs(hYaw);
    const lean = smoothstep(1.3, 2.6, ay) * 0.11 * Math.sign(hYaw);
    tmp.set(0, 0, -0.1);
    eul.set(hPitch, hYaw, 0, 'YXZ');
    qA.setFromEuler(eul);
    tmp.applyQuaternion(qA);
    tmp.z += 0.1;
    tmp.x -= lean;
    tmp.add(headOff);
    tmp.x += noise(time, 9.2) * 0.003 * sh;
    tmp.y += noise(time, 2.6) * 0.004 * sh;
    pos.copy(eye).add(tmp).applyQuaternion(Q).add(P);
    camera.position.copy(pos);
    eul.set(hPitch + gPitch + rx, hYaw + ry, rz, 'YXZ');
    qA.setFromEuler(eul);
    camera.quaternion.copy(Q).multiply(qA);
    setLens(NEAR_IN, cockpitFov);
  }

  // ---------- wing ----------
  const wingEye = new THREE.Vector3(), wingTarget = new THREE.Vector3();
  function layoutWing() {
    const { length: L, span: S, height: H } = bounds;
    if (category === 'helicopter') {
      wingEye.set(Math.max(2.4, S * 0.2), -H * 0.02, -L * 0.02);
      wingTarget.set(0, -H * 0.05, -L * 0.42);
    } else if (category === 'fighter') {
      // just inboard of the wingtip rail, above the wing, looking forward-inboard at the canopy
      wingEye.set(S * 0.5 * 0.86, H * 0.1 + 1.0, L * 0.16);
      wingTarget.set(0, H * 0.1, -L * 0.3);
    } else {
      // inboard of the wingtip device (sharklet / winglet), above the outer wing, looking at the engine + nose
      wingEye.set(S * 0.5 * 0.82, H * 0.07 + 1.7, L * 0.2);
      wingTarget.set(0, H * 0.02, -L * 0.28);
    }
  }
  function updateWing(dt, f) {
    headLook(dt, true);
    const g = Number.isFinite(f.gForce) ? f.gForce : 1;
    const flex = category === 'helicopter' ? 0 : clamp((g - 1) * bounds.span * 0.004, -0.4, 1.0);
    const sh = shakeAmount(f) * 1.3;
    pos.copy(wingEye);
    pos.y += flex + noise(time, 5.5) * 0.012 * sh;
    // local look direction → quaternion
    m4.lookAt(pos, wingTarget, UP);
    qA.setFromRotationMatrix(m4);
    eul.set(hPitch + noise(time, 3.3) * 0.002 * sh, hYaw, noise(time, 8.8) * 0.002 * sh, 'YXZ');
    qB.setFromEuler(eul);
    qA.multiply(qB);
    camera.quaternion.copy(Q).multiply(qA);
    pos.applyQuaternion(Q).add(P);
    clampAboveGround(pos);
    camera.position.copy(pos);
    fov += (60 - fov) * (snap ? 1 : damp(6, dt));
    setLens(NEAR_OUT, fov);
  }

  // ---------- orbit ----------
  function initOrbit() {
    tmp.subVectors(camera.position, P);
    const d = tmp.length();
    const R = bounds.radius;
    if (d < R * 1.3 || d > R * 40 || mode === 'cockpit') {
      oYawT = oYaw = Math.atan2(-fwd.x, -fwd.z) + 0.6;
      oPitchT = oPitch = 0.26;
      oDistT = oDist = R * 3.2 + 8;
    } else {
      oYawT = oYaw = Math.atan2(tmp.x, tmp.z);
      oPitchT = oPitch = clamp(Math.asin(clamp(tmp.y / d, -1, 1)), -0.6, 1.5);
      oDistT = oDist = d;
    }
    orbitInit = false;
  }
  function updateOrbit(dt) {
    if (orbitInit) initOrbit();
    const k = snap ? 1 : damp(10, dt);
    oYaw += (oYawT - oYaw) * k;
    oPitch += (oPitchT - oPitch) * k;
    oDist += (oDistT - oDist) * (snap ? 1 : damp(7, dt));
    const cp = Math.cos(oPitch);
    pos.set(Math.sin(oYaw) * cp, Math.sin(oPitch), Math.cos(oYaw) * cp).multiplyScalar(oDist).add(P);
    armCollide(dt, P, pos);
    clampAboveGround(pos);
    lookFrom(pos, P, UP);
    fov += (55 - fov) * (snap ? 1 : damp(5, dt));
    setLens(NEAR_OUT, fov);
  }

  // ---------- flyby ----------
  function placeFlyby(f) {
    const speed = vel.length();
    const R = bounds.radius;
    if (speed > 5) tmp.copy(vel); else tmp.copy(fwd);
    tmp.y *= 0.5;
    if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, -1);
    tmp.normalize();
    const ahead = speed > 5 ? clamp(speed * 4.2, R * 7, R * 7 + 700) : R * 5;
    tmp2.crossVectors(tmp, UP);
    if (tmp2.lengthSq() < 1e-6) tmp2.set(1, 0, 0);
    tmp2.normalize();
    flySide = -flySide;
    const side = flySide * (R * 1.4 + ahead * 0.1);
    flyPos.copy(P).addScaledVector(tmp, ahead).addScaledVector(tmp2, side);
    const agl = Number.isFinite(f.agl) ? f.agl : 50;
    flyPos.y = P.y + tmp.y * ahead - clamp(agl * 0.12, 1.2, 14) + (Math.sin(time * 7.3) * 0.5 + 0.2) * R * 0.4;
    const g = groundAt(flyPos.x, flyPos.z);
    flyPos.y = Math.max(flyPos.y, g + 1.8);
    flyValid = true;
  }
  function updateFlyby(dt, f) {
    const speed = vel.length();
    const R = bounds.radius;
    if (!flyValid) placeFlyby(f);
    tmp.subVectors(P, flyPos);
    const d = tmp.length();
    const leaving = speed > 5 && tmp.dot(vel) > 0;
    if ((leaving && d > Math.max(R * 14, speed * 5)) || d > Math.max(2500, R * 120) || (speed <= 5 && d > R * 18)) { placeFlyby(f); tmp.subVectors(P, flyPos); }
    pos.copy(flyPos);
    clampAboveGround(pos);
    // hand-held feel: slow drift of the aim point
    look.copy(P);
    const dist = Math.max(1, pos.distanceTo(P));
    const wob = dist * 0.004;
    look.x += slowNoise(time, 1) * wob; look.y += slowNoise(time, 2) * wob; look.z += slowNoise(time, 3) * wob;
    lookFrom(pos, look, UP);
    const target = clamp((2 * Math.atan((R * 2.4 * flyFovMul) / dist)) / DEG, 7, 62);
    fov += (target - fov) * (snap ? 1 : damp(3, dt));
    setLens(NEAR_OUT, fov);
  }

  // ---------- tower ----------
  function pickTower(force) {
    const list = airports();
    let best = null, bestD = Infinity, curD = Infinity;
    const cand = [];
    for (const a of list) {
      const t = TOWERS[a.icao];
      let x, z, h = 40;
      if (t) { x = t.x; z = t.z; h = t.h; }
      else if (a.center) { x = a.center.x; z = a.center.z; }
      else continue;
      cand.push({ key: a.icao, x, z, h });
    }
    if (!cand.length) for (const [k, t] of Object.entries(TOWERS)) cand.push({ key: k, ...t });
    for (const c of cand) {
      const d = Math.hypot(c.x - P.x, c.z - P.z);
      if (c.key === towerKey) curD = d;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return;
    if (!force && towerKey && best.key !== towerKey && bestD > curD * 0.8) return;   // hysteresis
    if (best.key !== towerKey || force) {
      towerKey = best.key;
      const apt = list.find((a) => a.icao === best.key);
      let ox = 0, oz = 0;
      if (apt && apt.center) {
        const dx = apt.center.x - best.x, dz = apt.center.z - best.z, d = Math.hypot(dx, dz);
        if (d > 30) { ox = dx / d * 14; oz = dz / d * 14; }
      }
      towerPos.set(best.x + ox, groundAt(best.x, best.z) + best.h, best.z + oz);
      towerLookInit = false;
    }
  }
  // Far from every airport the tower is just haze: a ground spotter with a long lens takes over, standing
  // ahead of the aircraft's track (on a hillside, a beach or a boat) and re-positioning after it passes.
  const spotPos = new THREE.Vector3();
  let spotValid = false, spotting = false;
  function nearestTowerDist() {
    let best = Infinity;
    const list = airports();
    const cand = list.length ? list.map((a) => TOWERS[a.icao] || a.center).filter(Boolean) : Object.values(TOWERS);
    for (const c of cand) best = Math.min(best, Math.hypot(c.x - P.x, c.z - P.z));
    return best;
  }
  let f0 = {};
  function placeSpotter() {
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 3) tmp.set(vel.x, 0, vel.z).normalize(); else tmp.set(fwd.x, 0, fwd.z).normalize();
    if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, -1);
    tmp2.set(-tmp.z, 0, tmp.x);                        // right of the track
    const ahead = clamp(speed * 7, 300, 1400);
    const side = (Math.random() < 0.5 ? -1 : 1) * clamp(ahead * 0.3, 150, 450);
    spotPos.copy(P).addScaledVector(tmp, ahead).addScaledVector(tmp2, side);
    // a little below the aircraft (a hilltop / another aircraft's photographer), never under the ground
    const agl = Number.isFinite(f0.agl) ? f0.agl : 100;
    spotPos.y = Math.max(groundAt(spotPos.x, spotPos.z) + 2.2, P.y - clamp(agl * 0.35, 15, 160));
    spotValid = true;
    towerLookInit = false;
  }
  function updateTower(dt, f) {
    f0 = f;
    towerCheck -= dt;
    if (!towerKey || towerCheck <= 0 || snap) {
      pickTower(!towerKey); towerCheck = 2;
      const far = nearestTowerDist();
      const want = spotting ? far > 7500 : far > 9000;    // hysteresis
      if (want !== spotting) { spotting = want; spotValid = false; towerLookInit = false; }
      shared.cameraSub = spotting ? 'spotter' : null;
    }
    if (spotting) {
      const d = spotValid ? Math.hypot(P.x - spotPos.x, P.z - spotPos.z) : Infinity;
      tmp.set(P.x - spotPos.x, 0, P.z - spotPos.z);
      const leaving = spotValid && tmp.dot(vel) > 0;
      if (!spotValid || (leaving && d > 3200) || d > 6000) placeSpotter();
      pos.copy(spotPos);
    } else pos.copy(towerPos);
    clampAboveGround(pos);
    // a human operator tracks with a little lag
    // an operator tracks with a little lag but leads the target (velocity feed-forward → no steady-state error)
    if (!towerLookInit || snap) { towerLook.copy(P); towerLookInit = true; }
    else { towerLook.addScaledVector(vel, dt); towerLook.lerp(P, damp(5, dt)); }
    tmp.subVectors(P, towerLook);
    if (tmp.length() > bounds.radius * 6) towerLook.copy(P).addScaledVector(tmp.normalize(), -bounds.radius * 6);
    lookFrom(pos, towerLook, UP);
    const dist = Math.max(1, pos.distanceTo(P));
    const target = clamp((2 * Math.atan((bounds.radius * 2.6 * towerFovMul) / dist)) / DEG, 0.3, 55);
    fov += (target - fov) * (snap ? 1 : damp(2.2, dt));
    setLens(NEAR_OUT, fov);
  }

  // ---------- mode switching ----------
  function setMode(m) {
    if (!ORDER.includes(m)) return CAMERA_NAMES[mode];
    if (m === mode) return CAMERA_NAMES[mode];
    if (m === 'orbit') orbitInit = true;
    if (m === 'flyby') flyValid = false;
    if (m === 'tower') { towerKey = null; towerFovMul = 1; spotValid = false; }
    shared.cameraSub = null;
    if (m === 'cockpit' || m === 'wing') { hYaw = hYawT = 0; hPitch = hPitchT = 0; }
    if (m === 'chase') { cYaw = cYawT = 0; cPitch = cPitchT = 0; }
    if (mode !== 'cockpit') lastExterior = mode;
    mode = m;
    if (mode !== 'cockpit') lastExterior = mode;
    dragging = false;
    snap = true;
    shared.cameraMode = mode;
    return CAMERA_NAMES[mode];
  }

  const api = {
    get mode() { return mode; },
    set mode(m) { setMode(m); },
    get modeName() { return CAMERA_NAMES[mode]; },
    get view() { return mode === 'cockpit' ? 'cockpit' : 'exterior'; },
    modes: ORDER.slice(),
    names: CAMERA_NAMES,
    setMode,
    setAircraft(r, d) {
      rig = r || null; def = d || null;
      category = (d && d.spec && d.spec.category) || (d && d.category) || 'airliner';
      const b = (r && r.bounds) || {};
      bounds.length = Number.isFinite(b.length) && b.length > 0 ? b.length : 15;
      bounds.span = Number.isFinite(b.span) && b.span > 0 ? b.span : bounds.length * 0.8;
      bounds.height = Number.isFinite(b.height) && b.height > 0 ? b.height : bounds.length * 0.3;
      bounds.radius = Number.isFinite(b.radius) && b.radius > 0 ? b.radius : Math.max(bounds.length, bounds.span) * 0.5;
      const e = r && r.eye && r.eye.pilot;
      if (e && Number.isFinite(e.x)) eye.copy(e);
      else eye.set(0, bounds.height * 0.25, -bounds.length * 0.3);
      cockpitFov = cockpitFovT = defaultCockpitFov();
      layoutWing();
      orbitInit = true; flyValid = false; towerKey = null;
      snap = true; havePrev = false;
    },
    next() { const i = ORDER.indexOf(mode); return setMode(ORDER[(i + 1) % ORDER.length]); },
    prev() { const i = ORDER.indexOf(mode); return setMode(ORDER[(i - 1 + ORDER.length) % ORDER.length]); },
    toggleView() { return setMode(mode === 'cockpit' ? (lastExterior && lastExterior !== 'cockpit' ? lastExterior : 'chase') : 'cockpit'); },
    /** lookBack(true) on press, lookBack(false) on release; repeated presses without a release toggle. */
    lookBack(on) {
      const now = performance.now();
      if (on === false) lookBackOn = false;
      else if (lookBackOn && now - (api._lbT || 0) > 250) lookBackOn = false;
      else lookBackOn = true;
      api._lbT = now;
      lookBackT = 0.6;
      shared.lookingBack = lookBackOn;
    },
    get lookingBack() { return lookBackOn; },
    /** Snap the camera next frame (after a reset / teleport). */
    reset() { snap = true; havePrev = false; },
    update(dt, f) {
      if (!f || (!rig && !f.position)) return;
      if (!(rig && rig.object) && !(f.position && f.quaternion)) return;
      dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      time += dt;
      kinematics(dt, f);
      switch (mode) {
        case 'cockpit': updateCockpit(dt, f); break;
        case 'wing': updateWing(dt, f); break;
        case 'orbit': updateOrbit(dt); break;
        case 'flyby': updateFlyby(dt, f); break;
        case 'tower': updateTower(dt, f); break;
        default: updateChase(dt, f);
      }
      snap = false;
      shared.cameraMode = mode;
    },
  };
  return api;
}
