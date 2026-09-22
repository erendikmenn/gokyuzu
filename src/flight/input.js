// STUB: replaced by Agent C. Minimal keyboard input.
export function createInput(target = window) {
  const down = new Set();
  const handlers = {};
  const state = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: false };
  const actionKeys = { KeyC: 'camera', KeyR: 'reset', KeyP: 'pause', Escape: 'pause', KeyH: 'hud', KeyM: 'mute', Slash: 'help' };
  target.addEventListener('keydown', (e) => {
    if (!e.repeat && actionKeys[e.code]) (handlers[actionKeys[e.code]] || []).forEach((cb) => cb());
    down.add(e.code); e.preventDefault();
  });
  target.addEventListener('keyup', (e) => down.delete(e.code));
  return {
    state,
    bindings: [{ keys: 'W/S', label: 'Burun' }],
    on(a, cb) { (handlers[a] ||= []).push(cb); },
    update(dt) {
      const k = (c) => (down.has(c) ? 1 : 0);
      state.pitch = k('KeyS') - k('KeyW');
      state.roll = k('KeyD') - k('KeyA');
      state.yaw = k('KeyE') - k('KeyQ');
      state.throttle = Math.min(1, Math.max(0, state.throttle + (k('ShiftLeft') - k('ControlLeft')) * dt * 0.5));
      state.brake = down.has('KeyB');
    },
  };
}
