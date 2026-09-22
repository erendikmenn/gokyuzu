// STUB (P1 replaces): the island input plus v2 system keys.
import { createInput as createInputV1 } from '../ada/flight/input.js';
export function createInput(target = window) {
  const inp = createInputV1(target);
  const handlers = {};
  const keys = { KeyG: 'gear', KeyF: 'flapsDown', KeyV: 'flapsUp', KeyK: 'speedbrake', KeyO: 'canopy', KeyL: 'lights', KeyT: 'view', Tab: 'menu' };
  target.addEventListener('keydown', (e) => { if (!e.repeat && keys[e.code]) (handlers[keys[e.code]] || []).forEach((cb) => cb()); });
  const on0 = inp.on.bind(inp);
  inp.on = (a, cb) => { if (Object.values(keys).includes(a)) (handlers[a] ||= []).push(cb); else on0(a, cb); };
  const upd = inp.update.bind(inp);
  inp.update = (dt) => { upd(dt); inp.state.brake = inp.state.brake ? 1 : 0; };
  inp.setAircraft = () => {};
  return inp;
}
