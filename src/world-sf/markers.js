// Gameplay markers for missions (CONTRACTS-SF.md §12): plain and cheap by the owner's rule — unlit basic materials, no
// textures, at most five draw calls (rings, frames, pad, runway box, beacon), each only while it has something to show.
// Instanced rings / rectangular gates share one geometry per shape; colours mark the state (next = orange, later = white,
// passed = hidden). Built by the mission runtime (src/missions/runtime.js), which is itself lazily loaded.
//
//   const mk = createMarkers(scene)
//   mk.setGates(shape, gates)            // 'ring' [{ x, y, z, r, nx, nz }] | 'frame' [{ x, y, z, hw, hh, nx, nz }] (nx, nz: plane normal)
//   mk.setActiveGate(i)                  // i = next gate (earlier ones hide); -1 hides all
//   mk.setPad({ x, y, z, r } | null)     // landing pad outline (ring + H) at height y (just above the ground)
//   mk.setRunwayBox({ x, z, y, course, from, to, width } | null)   // touchdown target box along a runway end, at height y
//   mk.setBeacon({ x, y, z, h } | null)  // thin vertical light column to find a point target from afar
//   mk.update(dt, camera)                // gentle pulse of the next gate / beacon; the beacon fades out near the camera
//   mk.dispose()
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX = 16;
const C_NEXT = new THREE.Color(0xffa24a), C_LATER = new THREE.Color(0xe8f2ff), C_PAD = new THREE.Color(0xffb257), C_BOX = new THREE.Color(0x5cf2c8);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

function basic(color, opacity = 0.9, side = THREE.DoubleSide) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side, fog: false, toneMapped: false });
}

/** Pad outline (unit radius, flat on XZ): ring + H. */
function padGeometry() {
  const ring = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);
  const bar = (w, d, x, z) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0, z);
  return mergeGeometries([ring, bar(0.1, 0.9, -0.28, 0), bar(0.1, 0.9, 0.28, 0), bar(0.56, 0.1, 0, 0)]);
}
/** Rectangle outline (unit: x ∈ [-1, 1] across, z ∈ [0, 1] along), flat on XZ. */
function boxGeometry(t = 0.06, tz = 0.02) {
  const bar = (w, d, x, z) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0, z);
  return mergeGeometries([bar(2, tz, 0, tz / 2), bar(2, tz, 0, 1 - tz / 2), bar(t, 1, -1 + t / 2, 0.5), bar(t, 1, 1 - t / 2, 0.5)]);
}

export function createMarkers(scene) {
  const group = new THREE.Group();
  group.name = 'mission-markers';
  scene.add(group);

  const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.035, 6, 56), basic(0xffffff, 0.92), MAX);
  // rectangular gates: four bar instances each (unit box scaled per bar), so the bars keep their thickness at any size
  const frameMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), basic(0xffffff, 0.92), MAX * 4);
  for (const m of [ringMesh, frameMesh]) {
    m.count = 0; m.visible = false; m.frustumCulled = false; m.renderOrder = 2;
    m.setColorAt(0, C_LATER);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  const padMat = basic(C_PAD, 0.95);
  padMat.polygonOffset = true; padMat.polygonOffsetFactor = -4; padMat.polygonOffsetUnits = -4;
  const pad = new THREE.Mesh(padGeometry(), padMat);
  pad.visible = false; pad.renderOrder = 2;
  const boxMat = basic(C_BOX, 0.85);
  boxMat.polygonOffset = true; boxMat.polygonOffsetFactor = -4; boxMat.polygonOffsetUnits = -4;
  const box = new THREE.Mesh(boxGeometry(), boxMat);
  box.visible = false; box.renderOrder = 2;
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffb257, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false, side: THREE.DoubleSide });
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0), beaconMat);
  beacon.visible = false; beacon.renderOrder = 3;
  group.add(pad, box, beacon);

  let shape = null, gates = [], active = -1, t = 0;
  const meshFor = () => (shape === 'ring' ? ringMesh : frameMesh);

  const BARS = [[0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1], [1, 0, 0, 1]];   // (x, y) offset sign, horizontal / vertical bar
  function writeGate(mesh, i, g, scale = 1) {
    const yaw = Math.atan2(g.nx, g.nz);                  // the shape's +Z (its plane normal) along (nx, nz)
    _q.setFromEuler(_e.set(0, yaw, 0));
    if (shape === 'ring') {
      _p.set(g.x, g.y, g.z);
      _s.set(g.r * scale, g.r * scale, g.r * scale);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      return;
    }
    const t = Math.min(4, Math.max(1.2, Math.min(g.hw, g.hh) * 0.08)) * scale, hw = g.hw * scale, hh = g.hh * scale;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    for (let k = 0; k < 4; k++) {
      const [sx, sy, horiz] = BARS[k];
      const lx = sx * (hw - t / 2), ly = sy * (hh - t / 2);
      _p.set(g.x + lx * c, g.y + ly, g.z - lx * sn);   // local +X → world (cos, 0, -sin) for a yaw about Y
      if (horiz) _s.set(2 * hw, t, t); else _s.set(t, Math.max(0.01, 2 * hh - 2 * t), t);
      mesh.setMatrixAt(i * 4 + k, _m.compose(_p, _q, _s));
    }
  }
  function refresh() {
    const mesh = meshFor();
    if (!mesh) return;
    const per = shape === 'ring' ? 1 : 4;
    for (let i = 0; i < gates.length; i++) {
      const hidden = active < 0 || i < active;
      writeGate(mesh, i, gates[i], hidden ? 0 : 1);
      for (let k = 0; k < per; k++) mesh.setColorAt(i * per + k, i === active ? C_NEXT : C_LATER);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.visible = gates.length > 0 && active >= 0 && active < gates.length;
  }

  return {
    group,
    setGates(sh, list) {
      ringMesh.visible = false; frameMesh.visible = false;
      shape = sh; gates = (list || []).slice(0, MAX);
      const mesh = meshFor();
      mesh.count = gates.length * (sh === 'ring' ? 1 : 4);
      active = gates.length ? 0 : -1;
      refresh();
    },
    setActiveGate(i) { if (i === active) return; active = i; refresh(); },
    setPad(p) {
      pad.visible = !!p;
      if (p) { pad.position.set(p.x, p.y, p.z); pad.scale.setScalar(p.r); }
    },
    setRunwayBox(b) {
      box.visible = !!b;
      if (!b) return;
      box.position.set(b.x + Math.sin(b.course) * b.from, b.y, b.z - Math.cos(b.course) * b.from);
      box.rotation.set(0, Math.PI - b.course, 0);         // box +Z (along) → runway course
      box.scale.set(b.width / 2, 1, b.to - b.from);
    },
    setBeacon(b) {
      beacon.visible = !!b;
      if (b) { beacon.position.set(b.x, b.y, b.z); beacon.scale.set(b.w || 4, b.h || 400, b.w || 4); }
    },
    update(dt, cam = null) {
      t += dt;
      if (beacon.visible) {   // a far-away finder: fades out within ~600 m of the camera (it would cover the aircraft)
        let k = 1;
        if (cam) { const d = Math.hypot(cam.position.x - beacon.position.x, cam.position.z - beacon.position.z); k = Math.min(1, Math.max(0, (d - 200) / 400)); }
        beaconMat.opacity = (0.22 + 0.13 * Math.sin(t * 3)) * k;
      }
      const mesh = meshFor();
      if (mesh && mesh.visible && active >= 0 && active < gates.length) {   // one gate (1 or 4 instances), ≤ 64 matrices uploaded
        writeGate(mesh, active, gates[active], 1 + 0.035 * Math.sin(t * 4));
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
    clear() { this.setGates(null, []); this.setPad(null); this.setRunwayBox(null); this.setBeacon(null); },
    dispose() {
      scene.remove(group);
      for (const m of [ringMesh, frameMesh, pad, box, beacon]) { m.geometry.dispose(); m.material.dispose(); if (m.dispose) m.dispose(); }
    },
  };
}
