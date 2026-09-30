// Keyboard layouts (src/flight/input.js): letters, digits and arrows go by position (e.code), punctuation by the
// character it types (logicalCode). On the Turkish Q layout "." is the Slash key and opened the help instead of the next
// camera, "," (Backslash) did nothing, ç / ö (Period / Comma) switched cameras and "-" (Equal) raised the throttle.
// Run: node tests/input-layout.test.mjs (a fake event target, no browser).
import { createInput, logicalCode } from '../src/flight/input.js';

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });

function kb() {
  const h = {};
  const input = createInput({ addEventListener: (t, f) => { h[t] = f; } });
  const fired = [];
  for (const a of ['help', 'camera', 'cameraPrev', 'mute', 'gear']) input.on(a, () => fired.push(a));
  const ev = (code, key, extra = {}) => ({ code, key, repeat: false, metaKey: false, altKey: false, shiftKey: false, target: null, isTrusted: true, preventDefault() {}, ...extra });
  return {
    input, fired, h,
    press(code, key, extra) { h.keydown(ev(code, key, extra)); h.keyup(ev(code, key, extra)); },
    hold(code, key, secs, extra) { h.keydown(ev(code, key, extra)); for (let t = 0; t < secs; t += 1 / 30) input.update(1 / 30); h.keyup(ev(code, key, extra)); },
  };
}

// Turkish Q
{
  const k = kb();
  k.press('Slash', '.');
  check('Turkish Q "." (Slash key): next camera, not the help', k.fired.join() === 'camera', k.fired.join());
  k.fired.length = 0; k.press('Backslash', ',');
  check('Turkish Q "," (Backslash key): previous camera', k.fired.join() === 'cameraPrev', k.fired.join());
  k.fired.length = 0; k.press('Period', 'ç'); k.press('Comma', 'ö');
  check('Turkish Q ç / ö (Period / Comma keys): nothing', k.fired.length === 0, k.fired.join());
  k.fired.length = 0; k.press('Minus', '?', { shiftKey: true });
  check('Turkish Q "?" (Shift + Minus key): the help once', k.fired.join() === 'help', k.fired.join());
  k.input.setThrottle(0.5);
  k.hold('Equal', '-', 1);
  const afterMinus = k.input.state.throttle;
  k.hold('Minus', '*', 1);
  check('Turkish Q "-" (Equal key) lowers the throttle, "*" (Minus key) leaves it', afterMinus < 0.45 && Math.abs(k.input.state.throttle - afterMinus) < 1e-9, `${afterMinus.toFixed(2)} → ${k.input.state.throttle.toFixed(2)}`);
  k.fired.length = 0; k.press('KeyG', 'ğ'); k.press('KeyM', 'm');
  check('Turkish Q letters stay by position (G gear, M mute)', k.fired.join() === 'gear,mute', k.fired.join());
}
// US / Turkish on-screen buttons (synthetic presses without a character) keep working
{
  const k = kb();
  k.press('Period', '.'); k.press('Comma', ','); k.press('Slash', '/');
  check('US "." / "," / "/": camera, previous camera, help', k.fired.join() === 'camera,cameraPrev,help', k.fired.join());
  k.fired.length = 0; k.press('Period', 'Period'); k.press('Slash', 'Slash');
  check('synthetic presses (key = the code name): by position', k.fired.join() === 'camera,help', k.fired.join());
  k.input.setThrottle(0.5);
  k.hold('Equal', '=', 1);
  const up = k.input.state.throttle;
  k.hold('Minus', '-', 2);
  check('US "=" raises, "-" lowers the throttle', up > 0.55 && k.input.state.throttle < up - 0.1, `${up.toFixed(2)} → ${k.input.state.throttle.toFixed(2)}`);
}
// German QWERTZ: "-" is the Slash key, "+" BracketRight
{
  const k = kb();
  k.input.setThrottle(0.5);
  k.hold('BracketRight', '+', 1);
  const up = k.input.state.throttle;
  k.hold('Slash', '-', 2);
  check('German "+" raises, "-" lowers the throttle (no help)', up > 0.55 && k.input.state.throttle < up - 0.1 && !k.fired.includes('help'), `${up.toFixed(2)} → ${k.input.state.throttle.toFixed(2)} ${k.fired.join()}`);
}
// a key released after its character changed (Shift let go first) releases what it pressed
{
  const k = kb();
  k.input.setThrottle(0.5);
  k.h.keydown({ code: 'Equal', key: '+', repeat: false, target: null, preventDefault() {} });
  for (let t = 0; t < 0.5; t += 1 / 30) k.input.update(1 / 30);
  k.h.keyup({ code: 'Equal', key: '=', target: null, preventDefault() {} });
  const v = k.input.state.throttle;
  for (let t = 0; t < 0.5; t += 1 / 30) k.input.update(1 / 30);
  check('keyup with another character releases the pressed key (no stuck throttle)', Math.abs(k.input.state.throttle - v) < 1e-9, `${v.toFixed(3)} → ${k.input.state.throttle.toFixed(3)}`);
}
check('logicalCode: letters / digits / arrows unchanged, unknown punctuation unbound', logicalCode({ code: 'KeyI', key: 'ı' }) === 'KeyI' && logicalCode({ code: 'Digit4', key: '+' }) === 'Digit4'
  && logicalCode({ code: 'ArrowUp', key: 'ArrowUp' }) === 'ArrowUp' && logicalCode({ code: 'Quote', key: 'i' }) === 'Unbound');

let failed = 0;
console.log('\n=== keyboard layouts ' + '='.repeat(40));
for (const x of rows) { if (!x.ok) failed++; console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(80)} ${x.detail}`); }
console.log(`\n${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
