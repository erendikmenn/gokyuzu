// Camera rig: chase (spring-damped follow), cockpit (with mouse head-look), orbit (free, mouse drag + wheel)
// and flyby (parked ahead of the flight path, tracking the aircraft as it passes).
import * as THREE from 'three';

const MODES = ['chase', 'cockpit', 'orbit', 'flyby'];
const NAMES = { chase: 'Takip', cockpit: 'Kokpit', orbit: 'Serbest', flyby: 'Geçiş' };
const UP = new THREE.Vector3(0, 1, 0);
const MIN_CLEARANCE = 1.5;
const CHASE_DIST = 21;      // m behind the aircraft at rest (grows a little with speed)
const CHASE_HEIGHT = 4.0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);   // frame-rate independent smoothing factor

export function createCameraRig(camera, aircraft, dom, world) {
  const cockpitOffset = aircraft && aircraft.cockpitOffset ? aircraft.cockpitOffset : new THREE.Vector3(0, 1, -0.5);

  // scratch
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), vdir = new THREE.Vector3();
  const tFwd = new THREE.Vector3(), tUp = new THREE.Vector3(), horizUp = new THREE.Vector3();
  const look = new THREE.Vector3(), pos = new THREE.Vector3(), tmp = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const qHead = new THREE.Quaternion(), eHead = new THREE.Euler(0, 0, 0, 'YXZ');

  // chase state
  const smFwd = new THREE.Vector3(0, 0, -1);
  const smUp = new THREE.Vector3(0, 1, 0);
  let chaseDist = CHASE_DIST;
  let snap = true;
  const lastPos = new THREE.Vector3();
  let havePos = false;

  // shared
  let fov = camera.fov || 65;
  let fovTarget = fov;

  // orbit state (angles around the aircraft, world-relative)
  let oYaw = 0, oPitch = 0.3, oDist = 28;
  let oYawT = 0, oPitchT = 0.3, oDistT = 28;

  // cockpit head-look
  let headYaw = 0, headPitch = 0, headHold = 0;

  // flyby
  const flyPos = new THREE.Vector3();
  let flyValid = false;
  let flySide = 1;
  let pendingOrbitInit = false;

  // ---------- input (drag + wheel on the canvas) ----------
  let dragging = false, lastX = 0, lastY = 0, pointerId = null;
  if (dom && dom.addEventListener) {
    dom.addEventListener('pointerdown', (e) => {
      if (rig.mode !== 'orbit' && rig.mode !== 'cockpit') return;
      if (e.button !== 0 && e.button !== 2) return;
      dragging = true; pointerId = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      try { dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (rig.mode === 'orbit') {
        oYawT -= dx * 0.0065;
        oPitchT = clamp(oPitchT + dy * 0.005, -0.25, 1.45);
      } else if (rig.mode === 'cockpit') {
        headYaw = clamp(headYaw - dx * 0.0045, -2.6, 2.6);
        headPitch = clamp(headPitch - dy * 0.0045, -1.0, 1.2);
        headHold = 1.2;
      }
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      dragging = false; pointerId = null;
      try { dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => {
      if (rig.mode !== 'orbit') return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      oDistT = clamp(oDistT * Math.exp(dy * 0.0012), 7, 400);
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => { if (rig.mode === 'orbit' || rig.mode === 'cockpit') e.preventDefault(); });
  }

  // ---------- helpers ----------
  function groundAt(x, z) {
    try { const h = world && world.getGroundHeight ? world.getGroundHeight(x, z) : -Infinity; return Number.isFinite(h) ? h : -Infinity; } catch { return -Infinity; }
  }
  function clampAboveGround(p) {
    const g = groundAt(p.x, p.z) + MIN_CLEARANCE;
    if (p.y < g) p.y = g;
  }
  function setLens(near, f) {
    let dirty = false;
    if (Math.abs(camera.near - near) > 1e-4) { camera.near = near; dirty = true; }
    if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; dirty = true; }
    if (dirty) camera.updateProjectionMatrix();
  }
  function lookFrom(eye, target, upv) {
    camera.position.copy(eye);
    m4.lookAt(eye, target, upv);
    camera.quaternion.setFromRotationMatrix(m4);
  }
  function speedOf(f) {
    const v = f.velocity ? f.velocity.length() : 0;
    return v > 0.01 ? v : (f.airspeed || 0);
  }

  // ---------- modes ----------
  function updateChase(dt, f) {
    const p = f.position;
    fwd.set(0, 0, -1).applyQuaternion(f.quaternion);
    up.set(0, 1, 0).applyQuaternion(f.quaternion);
    const speed = speedOf(f);

    // trail direction: the nose, blended toward the flight path when airborne (smoother in turns / slips)
    tFwd.copy(fwd);
    if (!f.onGround && f.velocity && speed > 12) {
      vdir.copy(f.velocity).normalize();
      tFwd.lerp(vdir, 0.45).normalize();
    }
    // camera up: mostly level with the horizon, keeps ~30% of the bank; fades to the aircraft's up when
    // pointing near vertical or inverted so loops stay continuous
    horizUp.copy(UP).addScaledVector(tFwd, -tFwd.y);
    const hl = horizUp.length();
    let w = 0;
    if (hl > 1e-3) {
      horizUp.divideScalar(hl);
      w = 0.7 * clamp(hl * hl, 0, 1) * clamp((up.y + 0.1) / 0.4, 0, 1);
    }
    tUp.copy(up).multiplyScalar(1 - w).addScaledVector(horizUp, w).normalize();

    const distTarget = CHASE_DIST + clamp(speed, 0, 90) * 0.05;
    if (snap) {
      smFwd.copy(tFwd); smUp.copy(tUp);
      chaseDist = distTarget;
    } else {
      smFwd.lerp(tFwd, damp(4.2, dt)).normalize();
      smUp.lerp(tUp, damp(3.2, dt));
      chaseDist += (distTarget - chaseDist) * damp(1.5, dt);
    }
    // keep smUp orthogonal to smFwd
    smUp.addScaledVector(smFwd, -smUp.dot(smFwd));
    if (smUp.lengthSq() < 1e-6) smUp.copy(up);
    smUp.normalize();

    // camera behind/above; it looks (almost) parallel to the smoothed nose direction so the horizon sits
    // where the HUD's horizon line is, with the aircraft in the lower-middle of the frame
    pos.copy(p).addScaledVector(smFwd, -chaseDist).addScaledVector(smUp, CHASE_HEIGHT);
    clampAboveGround(pos);
    look.copy(p).addScaledVector(smFwd, 70).addScaledVector(smUp, CHASE_HEIGHT - 1.3);
    lookFrom(pos, look, smUp);

    fovTarget = 62 + clamp(speed, 0, 80) * 0.11;
    fov += (fovTarget - fov) * (snap ? 1 : damp(1.5, dt));
    setLens(0.3, fov);
  }

  function updateCockpit(dt, f) {
    if (!dragging) {
      headHold -= dt;
      if (headHold <= 0) {
        const k = damp(2.5, dt);
        headYaw -= headYaw * k;
        headPitch -= headPitch * k;
      }
    }
    pos.copy(cockpitOffset).applyQuaternion(f.quaternion).add(f.position);
    camera.position.copy(pos);
    eHead.set(headPitch, headYaw, 0, 'YXZ');
    qHead.setFromEuler(eHead);
    camera.quaternion.copy(f.quaternion).multiply(qHead);
    fov += (70 - fov) * (snap ? 1 : damp(4, dt));
    setLens(0.05, fov);
  }

  function initOrbitFromCamera(f) {
    tmp.subVectors(camera.position, f.position);
    const d = tmp.length();
    if (d < 8 || d > 150) {
      // coming from the cockpit (or the camera is far away): start behind and above the aircraft
      fwd.set(0, 0, -1).applyQuaternion(f.quaternion);
      oYawT = oYaw = Math.atan2(-fwd.x, -fwd.z);
      oPitchT = oPitch = 0.28;
      oDistT = oDist = 26;
      return;
    }
    oYawT = oYaw = Math.atan2(tmp.x, tmp.z);
    oPitchT = oPitch = clamp(Math.asin(clamp(tmp.y / d, -1, 1)), -0.25, 1.45);
    oDistT = oDist = clamp(d, 12, 400);
  }

  function updateOrbit(dt, f) {
    const k = damp(9, dt);
    oYaw += (oYawT - oYaw) * k;
    oPitch += (oPitchT - oPitch) * k;
    oDist += (oDistT - oDist) * damp(7, dt);
    const cp = Math.cos(oPitch);
    pos.set(Math.sin(oYaw) * cp, Math.sin(oPitch), Math.cos(oYaw) * cp).multiplyScalar(oDist).add(f.position);
    clampAboveGround(pos);
    look.copy(f.position);
    lookFrom(pos, look, UP);
    fov += (60 - fov) * (snap ? 1 : damp(4, dt));
    setLens(0.3, fov);
  }

  function placeFlyby(f) {
    const speed = Math.max(speedOf(f), 0);
    if (f.velocity && speed > 5) vdir.copy(f.velocity); else vdir.set(0, 0, -1).applyQuaternion(f.quaternion);
    vdir.y *= 0.5;
    if (vdir.lengthSq() < 1e-6) vdir.set(0, 0, -1);
    vdir.normalize();
    const ahead = speed > 5 ? clamp(speed * 4.5, 70, 360) : 45;
    tmp.crossVectors(vdir, UP);                     // right of the path
    if (tmp.lengthSq() < 1e-6) tmp.set(1, 0, 0);
    tmp.normalize();
    flySide = -flySide;
    const side = flySide * (speed > 5 ? 16 + ahead * 0.12 : 22);
    flyPos.copy(f.position).addScaledVector(vdir, ahead).addScaledVector(tmp, side);
    const agl = Number.isFinite(f.agl) ? f.agl : 50;
    const g = groundAt(flyPos.x, flyPos.z);
    flyPos.y = f.position.y + vdir.y * ahead - clamp(agl * 0.12, 1.5, 9) + (Math.random() - 0.3) * 4;
    if (Number.isFinite(g)) flyPos.y = Math.max(flyPos.y, g + 2.2);
    flyValid = true;
  }

  function updateFlyby(dt, f) {
    const speed = speedOf(f);
    if (!flyValid) placeFlyby(f);
    tmp.subVectors(f.position, flyPos);
    const d = tmp.length();
    const moving = speed > 5 && f.velocity && tmp.dot(f.velocity) > 0;     // plane has passed and is leaving
    if ((moving && d > Math.max(260, speed * 6)) || d > 1500 || (!moving && speed <= 5 && d > 220)) placeFlyby(f);
    pos.copy(flyPos);
    clampAboveGround(pos);
    look.copy(f.position);
    lookFrom(pos, look, UP);
    // zoom to keep the aircraft a similar size on screen
    const dist = Math.max(1, pos.distanceTo(f.position));
    fovTarget = clamp((2 * Math.atan(16 / dist)) / (Math.PI / 180), 14, 62);
    fov += (fovTarget - fov) * (snap ? 1 : damp(3, dt));
    setLens(0.3, fov);
  }

  // ---------- public ----------
  const rig = {
    mode: 'chase',
    next() {
      const i = MODES.indexOf(rig.mode);
      rig.mode = MODES[(i + 1) % MODES.length];
      dragging = false;
      headYaw = headPitch = 0;
      flyValid = false;
      pendingOrbitInit = rig.mode === 'orbit';
      snap = true;
      return NAMES[rig.mode];
    },
    update(dt, f) {
      if (!f || !f.position || !f.quaternion) return;
      dt = clamp(dt || 0, 0, 0.1);
      if (havePos && lastPos.distanceToSquared(f.position) > 80 * 80) { snap = true; flyValid = false; }
      lastPos.copy(f.position);
      havePos = true;
      if (pendingOrbitInit) { initOrbitFromCamera(f); pendingOrbitInit = false; }
      switch (rig.mode) {
        case 'cockpit': updateCockpit(dt, f); break;
        case 'orbit': updateOrbit(dt, f); break;
        case 'flyby': updateFlyby(dt, f); break;
        default: updateChase(dt, f);
      }
      snap = false;
    },
  };
  return rig;
}
