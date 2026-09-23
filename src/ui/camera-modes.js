// Camera ids, Turkish names and direct keys, shared by the camera rig (src/ui/camera.js), the key bindings / F1 help
// (src/flight/input.js) and the HUD camera selector (src/ui/camera-bar.js). No DOM, no three.js: safe to import in Node.
//
// Direct keys: Alt + 1 … 7 (Option ⌥ + 1 … 7 on a Mac), numbered in the C / . cycle order.
//   - F-keys need fn on Mac laptops (and F1 is already help), so they are not used.
//   - Bare digits are throttle presets, Shift is throttle up and Ctrl is throttle down on a Mac.
//   - Ctrl + digit switches browser tabs on Windows / Linux (and Ctrl + letter hits browser shortcuts like Ctrl+W).
//   - Alt / Option + digit has no browser or OS binding on macOS and Windows; the Linux browsers' Alt + digit tab
//     switch is not a reserved shortcut, so the page's preventDefault (input.js does it for every digit) keeps it.
//     Windows AltGr (Ctrl + Alt) + digit works too.
import { IS_MAC } from '../core/platform.js';

export const CAMERA_ORDER = ['cockpit', 'chase', 'wing', 'orbit', 'flyby', 'tower', 'birdseye'];
export const CAMERA_NAMES = { cockpit: 'Kokpit', chase: 'Takip', wing: 'Kanat', orbit: 'Serbest', flyby: 'Geçiş', tower: 'Kule', birdseye: 'Kuşbakışı' };

/** Modifier label shown to the player for the direct camera keys. */
export const CAMERA_KEY_MOD = IS_MAC ? '⌥ Option' : 'Alt';
/** Short key label of a camera, e.g. "⌥7" (Mac) / "Alt+7". */
export function cameraKeyLabel(id) {
  const i = CAMERA_ORDER.indexOf(id);
  return i < 0 ? '' : IS_MAC ? `⌥${i + 1}` : `Alt+${i + 1}`;
}
/** Camera id for a digit pressed with Alt / Option (1-based), or null. */
export function cameraForDigit(d) {
  return d >= 1 && d <= CAMERA_ORDER.length ? CAMERA_ORDER[d - 1] : null;
}
/** Bird's-eye orientation labels (the view flips when its key or button is used again). */
export const BIRDSEYE_ORIENT = { north: 'Kuzey yukarıda', track: 'Uçuş yönü yukarıda' };
