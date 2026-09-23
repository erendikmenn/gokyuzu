// Platform- and device-aware key labels for the onboarding UI (tutorial card, key card, hints, crash tips).
// Keyboard labels follow src/flight/input.js: the throttle / collective is Shift / Ctrl on macOS and X / Z on
// Windows / Linux (Ctrl+W closes the tab there, src/core/platform.js). With a standard-mapping gamepad connected the
// gamepad controls are shown instead (same mapping as input.js). On phones / tablets (touch controls, src/ui/touch.js)
// the chips name the on-screen controls ("Gaz sürgüsü", "TAKIM") and the sentences say what to do with them
// ("gaz sürgüsünü yukarı it", "sol çubuğu geri çek"); those labels are per aircraft category (collective, HOVER, PEDAL).
//
// Text templates use {Label} for an inline key chip (rendered by richText() in util.js), e.g. "{X} tuşunu basılı tut".
// Flags: k.kb (keyboard: digit presets such as {9} exist), k.pad (gamepad), k.touch (on-screen controls).
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
// on-screen controls (labels as printed on the buttons of src/ui/touch.js)
function touchLabels(cat) {
  const heli = cat === 'helicopter';
  return {
    thrUp: heli ? 'Kolektif ▲' : 'Gaz ▲', thrDown: heli ? 'Kolektif ▼' : 'Gaz ▼',
    pitchDown: 'Çubuk ↑', pitchUp: 'Çubuk ↓', rollLeft: 'Çubuk ←', rollRight: 'Çubuk →',
    yawLeft: heli ? '◀ PEDAL' : 'Çubuk ←', yawRight: heli ? 'PEDAL ▶' : 'Çubuk →',
    gear: 'TAKIM', flapsDown: 'FLAP ▼', flapsUp: 'FLAP ▲', speedbrake: 'H.FREN', reverser: 'REV', autopilot: heli ? 'HOVER' : 'AP',
    brake: 'FREN', camera: 'KAMERA', view: 'KOKPİT', help: '❚❚ → Kontroller', reset: '❚❚ → Yeniden başla', pause: '❚❚', menu: '❚❚ → Ana menü',
    preset: null, presetMax: null,
    thr: heli ? 'Kolektif sürgüsü' : 'Gaz sürgüsü', pitch: 'Çubuk ↕', roll: 'Çubuk ↔', yaw: heli ? 'PEDAL' : 'Çubuk ↔', flaps: 'FLAP ▲ / FLAP ▼', stick: 'Sol çubuk',
  };
}

// gamepad phrases that are not "press the <button>" (sticks, triggers)
const PAD_HOLD = {
  thrUp: '{RT} tetiğini basılı tut', thrDown: '{LT} tetiğini basılı tut',
  pitchUp: 'sol çubuğu geri çek', pitchDown: 'sol çubuğu ileri it', rollLeft: 'sol çubuğu sola it', rollRight: 'sol çubuğu sağa it',
  pitch: 'sol çubuğu ileri / geri oynat', roll: 'sol çubuğu sağa / sola it', stick: 'sol çubuğu oynat',
};
const PAD_PRESS = { thrUp: '{RT} tetiğine bas', thrDown: '{LT} tetiğine bas' };
function touchHold(cat) {
  const lever = cat === 'helicopter' ? 'kolektif sürgüsünü' : 'gaz sürgüsünü';
  return {
    thrUp: `${lever} yukarı it`, thrDown: `${lever} aşağı çek`,
    pitchUp: 'sol çubuğu geri (aşağı) çek', pitchDown: 'sol çubuğu ileri (yukarı) it', rollLeft: 'sol çubuğu sola it', rollRight: 'sol çubuğu sağa it',
    pitch: 'sol çubuğu ileri / geri oynat', roll: 'sol çubuğu sağa / sola it', stick: 'sol çubuğu oynat',
    yawLeft: cat === 'helicopter' ? 'pedal şeridini sola kaydır' : 'yerde sol çubuğu sola it',
    yawRight: cat === 'helicopter' ? 'pedal şeridini sağa kaydır' : 'yerde sol çubuğu sağa it',
    yaw: cat === 'helicopter' ? 'pedal şeridini sola / sağa kaydır' : 'yerde sol çubuğu sola / sağa it',
  };
}

function build(device, cat) {
  const pad = device === 'pad', touch = device === 'touch';
  const L = touch ? touchLabels(cat) : pad ? PAD : KB;
  const HOLD = touch ? touchHold(cat) : PAD_HOLD;
  const k = {
    device, pad, touch, kb: !pad && !touch, mac: IS_MAC,
    /** Chip label(s) for an action ("X", "Shift / Ctrl", "D-pad ↑", "TAKIM"). */
    label: (a) => (touch ? (a in L ? L[a] : a) : L[a] ?? KB[a] ?? a),
    /** "{X} tuşunu basılı tut" / "{RT} tetiğini basılı tut" / "sol çubuğu geri çek" / "gaz sürgüsünü yukarı it". */
    hold(a) {
      if (touch) return HOLD[a] || `{${L[a] ?? a}} düğmesini basılı tut`;
      if (pad) return PAD_HOLD[a] || `{${L[a]}} düğmesini basılı tut`;
      return `${orList(L[a])} tuşunu basılı tut`;
    },
    /** "{G} tuşuna bas" / "{D-pad ↑} düğmesine bas" / "{TAKIM} düğmesine dokun". */
    press(a) {
      if (touch) return HOLD[a] || `{${L[a] ?? a}} düğmesine dokun`;
      if (pad) return PAD_PRESS[a] || PAD_HOLD[a] || `{${L[a]}} düğmesine bas`;
      return `${orList(L[a])} tuşuna bas`;
    },
    /** Inline chip(s) for an action: "{X}" or "{B} / {Boşluk}". */
    chip: (a) => chipList(touch ? (a in L ? L[a] : a) : L[a] ?? KB[a] ?? a),
  };
  return k;
}
// "B / Boşluk" → "{B} ya da {Boşluk}" in sentences (either key does it), "{B} / {Boşluk}" as a chip group
const orList = (lbl) => String(lbl || '').split(/\s+\/\s+/).map((x) => `{${x}}`).join(' ya da ');
const chipList = (lbl) => String(lbl || '').split(/\s+\/\s+/).map((x) => `{${x}}`).join(' / ');

const SETS = new Map();
/** Key label set for the current device ('kb' | 'pad' | 'touch'); touch labels depend on the aircraft category. */
export function keySet(device, category = 'airliner') {
  const d = device === 'pad' || device === 'touch' ? device : 'kb';
  const cat = d === 'touch' && (category === 'fighter' || category === 'helicopter') ? category : d === 'touch' ? 'airliner' : '';
  const key = `${d}:${cat}`;
  if (!SETS.has(key)) SETS.set(key, build(d, cat));
  return SETS.get(key);
}

/** The 5–6 essential controls per aircraft category for the opening key card: [chip labels, Turkish caption]. */
export function essentialKeys(category, device) {
  const k = keySet(device, category), l = k.label;
  if (category === 'helicopter') {
    return [[l('thr'), 'Kolektif ↑ / ↓'], [l('pitch'), 'Cyclic ileri / geri'], [l('roll'), 'Cyclic sola / sağa'],
      [l('yaw'), 'Pedal'], [l('autopilot'), 'Askıda tut'], [l('camera'), 'Kamera']];
  }
  if (category === 'fighter') {
    return [[l('thr'), k.touch ? 'Gaz · MIL’i geçince art yakıcı' : k.pad ? 'Gaz · 2. çekiş: art yakıcı' : 'Gaz · 2. basış: art yakıcı'], [l('pitch'), 'Burun ↓ / ↑'], [l('roll'), 'Yatış'],
      [l('gear'), 'İniş takımı'], [l('speedbrake'), 'Hava freni'], [l('camera'), 'Kamera']];
  }
  return [[l('thr'), k.touch ? 'Gaz · IDLE altı: ters itki' : 'Gaz ↑ / ↓'], [l('pitch'), 'Burun ↓ / ↑'], [l('roll'), 'Yatış'],
    [l('gear'), 'İniş takımı'], [l('flaps'), 'Flap ↓ / ↑'], [l('autopilot'), 'Otopilot']];
}
