// STUB (UI agent replaces with src/ui/*.js files exporting the same functions): minimal menu, loading, HUD, cameras.
import * as THREE from 'three';

export function createMenu(container, { aircraft, spawns }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0b1622;color:#fff;font:16px -apple-system,sans-serif;z-index:20';
    el.innerHTML = '<h1 style="margin:0 0 10px">Gökyüzü SF</h1>';
    const spawnSel = document.createElement('select');
    for (const s of spawns) spawnSel.add(new Option(s.name, s.id));
    for (const a of aircraft) {
      const b = document.createElement('button');
      b.textContent = `${a.name} (${a.role})`;
      b.style.cssText = 'padding:10px 24px;font-size:16px;cursor:pointer;min-width:320px';
      b.onclick = () => { el.remove(); resolve({ aircraftId: a.id, spawnId: spawnSel.value === 'default' ? a.defaultSpawn : spawnSel.value }); };
      el.append(b);
    }
    spawnSel.add(new Option('Varsayılan (uçağa göre)', 'default'), 0); spawnSel.value = 'default';
    el.append(spawnSel);
    container.append(el);
  });
}

export function createLoadingScreen(container) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b1622;color:#cfe;font:18px -apple-system,sans-serif;z-index:19';
  container.append(el);
  return { setProgress(p, text) { el.textContent = `${text || ''} ${(p * 100).toFixed(0)}%`; }, hide() { el.remove(); } };
}

export function createHUD(container) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:16px;top:16px;color:#fff;font:14px monospace;text-shadow:0 1px 2px #000;pointer-events:none';
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;left:50%;top:28%;transform:translateX(-50%);color:#fff;font:bold 26px sans-serif;text-shadow:0 2px 6px #000;pointer-events:none';
  container.append(el, msg);
  let t;
  return {
    setAircraft() {},
    update(f) {
      el.textContent = `IAS ${(f.ias * 1.944).toFixed(0)} kt  ALT ${(f.altitude * 3.281).toFixed(0)} ft  HDG ${f.heading.toFixed(0)}  THR ${(f.throttle * 100).toFixed(0)}%  GEAR ${f.gear > 0.5 ? 'DN' : 'UP'}  FLAPS ${f.flapsLabel}`;
    },
    showMessage(text, ms = 1500) { msg.textContent = text; clearTimeout(t); t = setTimeout(() => (msg.textContent = ''), ms); },
    setVisible(v) { container.style.display = v ? '' : 'none'; },
    showHelp() {}, setPaused() {},
  };
}

export function createCameraRig(camera, dom, world) {
  let rig = null, mode = 'chase';
  const off = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  return {
    get mode() { return mode; },
    get view() { return mode === 'cockpit' ? 'cockpit' : 'exterior'; },
    setAircraft(r) { rig = r; off.set(0, r.bounds.height * 0.9, r.bounds.length * 1.6 + 8); },
    next() { mode = mode === 'chase' ? 'cockpit' : 'chase'; return mode === 'chase' ? 'Takip' : 'Kokpit'; },
    prev() { return this.next(); },
    toggleView() { return this.next(); },
    lookBack() {},
    update(dt, flight) {
      if (!rig) return;
      if (mode === 'cockpit') {
        camera.position.copy(rig.eye.pilot).applyQuaternion(flight.quaternion).add(rig.object.position);
        camera.quaternion.copy(flight.quaternion);
        camera.near = 0.05;
      } else {
        tmp.copy(off).applyQuaternion(flight.quaternion).add(rig.object.position);
        camera.position.lerp(tmp, 1 - Math.exp(-dt * 5));
        const g = world.getGroundHeight(camera.position.x, camera.position.z) + 1.5;
        if (camera.position.y < g) camera.position.y = g;
        camera.lookAt(rig.object.position);
        camera.near = 0.3;
      }
      camera.updateProjectionMatrix();
    },
  };
}
