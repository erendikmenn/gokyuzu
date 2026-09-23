// Platform- and device-aware key labels for the onboarding UI (tutorial card, key card, hints, crash tips).
// Keyboard labels follow src/flight/input.js: the throttle / collective is Shift / Ctrl on macOS and X / Z on
// Windows / Linux (Ctrl+W closes the tab there, src/core/platform.js). With a standard-mapping gamepad connected the
// gamepad controls are shown instead (same mapping as input.js).
//
// Text templates use {Label} for an inline key chip (rendered by richText() in util.js), e.g. "{X} tuşunu basılı tut".
import { IS_MAC } from '../core/platform.js';

const KB = {
  thrUp: IS_MAC ? 'Shift' : 'X', thrDown: IS_MAC ? 'Ctrl' : 'Z',
  pitchDown: 'W', pitchUp: 'S', rollLeft: 'A', rollRight: 'D', yawLeft: 'Q', yawRight: 'E',
  gear: 'G', flapsDown: 'F', flapsUp: 'V', speedbrake: 'K', reverser: 'N', autopilot: 'O', brake: 'B / Boşluk',
  camera: 'C', view: 'T', help: 'F1', reset: 'R', pause: 'P', menu: 'Tab', preset: '9', presetMax: '0',
  // pairs shown as one chip group
  thr: IS_MAC ? 'Shift / Ctrl' : 'X / Z', pitch: 'W / S', roll: 'A / D', yaw: 'Q / E', flaps: 'F / V', stick: 'W A S D',
};
const PAD = {
  thrUp: 'RT', thrDown: 'LT',
  pitchDown: 'Sol çubuk ↑', pitchUp: 'Sol çubuk ↓', rollLeft: 'Sol çubuk ←', rollRight: 'Sol çubuk →',
  yawLeft: 'LB', yawRight: 'RB', gear: 'D-pad ↑', flapsDown: 'B', flapsUp: 'X', speedbrake: 'D-pad ↓', reverser: 'L3',
  autopilot: 'D-pad ←', brake: 'A', camera: 'Y', view: 'R3', help: 'F1', reset: 'Back', pause: 'Start', menu: 'Tab',
  preset: null, presetMax: null,
  thr: 'RT / LT', pitch: 'Sol çubuk ↕', roll: 'Sol çubuk ↔', yaw: 'LB / RB', flaps: 'B / X', stick: 'Sol çubuk',
};

// gamepad phrases that are not "press the <button>" (sticks, triggers)
const PAD_HOLD = {
  thrUp: '{RT} tetiğini basılı tut', thrDown: '{LT} tetiğini basılı tut',
  pitchUp: 'sol çubuğu geri çek', pitchDown: 'sol çubuğu ileri it', rollLeft: 'sol çubuğu sola it', rollRight: 'sol çubuğu sağa it',
  pitch: 'sol çubuğu ileri / geri oynat', roll: 'sol çubuğu sağa / sola it', stick: 'sol çubuğu oynat',
};
const PAD_PRESS = { thrUp: '{RT} tetiğine bas', thrDown: '{LT} tetiğine bas' };

function build(device) {
  const pad = device === 'pad';
  const L = pad ? PAD : KB;
  const k = {
    device, pad, mac: IS_MAC,
    /** Chip label(s) for an action ("X", "Shift / Ctrl", "D-pad ↑"). */
    label: (a) => L[a] ?? KB[a] ?? a,
    /** "{X} tuşunu basılı tut" / "{RT} tetiğini basılı tut" / "sol çubuğu geri çek". */
    hold(a) {
      if (pad) return PAD_HOLD[a] || `{${L[a]}} düğmesini basılı tut`;
      return `${orList(L[a])} tuşunu basılı tut`;
    },
    /** "{G} tuşuna bas" / "{D-pad ↑} düğmesine bas". */
    press(a) {
      if (pad) return PAD_PRESS[a] || PAD_HOLD[a] || `{${L[a]}} düğmesine bas`;
      return `${orList(L[a])} tuşuna bas`;
    },
    /** Inline chip(s) for an action: "{X}" or "{B} / {Boşluk}". */
    chip: (a) => chipList(L[a] ?? KB[a] ?? a),
  };
  return k;
}
// "B / Boşluk" → "{B} ya da {Boşluk}" in sentences (either key does it), "{B} / {Boşluk}" as a chip group
const orList = (lbl) => String(lbl || '').split(/\s+\/\s+/).map((x) => `{${x}}`).join(' ya da ');
const chipList = (lbl) => String(lbl || '').split(/\s+\/\s+/).map((x) => `{${x}}`).join(' / ');

const SETS = { kb: build('kb'), pad: build('pad') };
/** Key label set for the current device ('kb' | 'pad'). */
export function keySet(device) { return SETS[device === 'pad' ? 'pad' : 'kb']; }

/** The 5–6 essential controls per aircraft category for the opening key card: [chip labels, Turkish caption]. */
export function essentialKeys(category, device) {
  const k = keySet(device), l = k.label;
  if (category === 'helicopter') {
    return [[l('thr'), 'Kolektif ↑ / ↓'], [l('pitch'), 'Cyclic ileri / geri'], [l('roll'), 'Cyclic sola / sağa'],
      [l('yaw'), 'Pedal'], [l('autopilot'), 'Askıda tut'], [l('camera'), 'Kamera']];
  }
  if (category === 'fighter') {
    return [[l('thr'), k.pad ? 'Gaz · 2. çekiş: art yakıcı' : 'Gaz · 2. basış: art yakıcı'], [l('pitch'), 'Burun ↓ / ↑'], [l('roll'), 'Yatış'],
      [l('gear'), 'İniş takımı'], [l('speedbrake'), 'Hava freni'], [l('camera'), 'Kamera']];
  }
  return [[l('thr'), 'Gaz ↑ / ↓'], [l('pitch'), 'Burun ↓ / ↑'], [l('roll'), 'Yatış'],
    [l('gear'), 'İniş takımı'], [l('flaps'), 'Flap ↓ / ↑'], [l('autopilot'), 'Otopilot']];
}
