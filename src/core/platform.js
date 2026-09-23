// Platform differences that change the key layout.
// On Windows/Linux, Ctrl+W closes the browser tab and pages cannot block it: holding Ctrl for "throttle down" while pressing
// W for "nose down" would close the game. So Ctrl only drives the throttle on macOS (where the tab shortcut is Cmd+W).
const ua = typeof navigator === 'undefined' ? '' : (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
export const IS_MAC = /mac|iphone|ipad/i.test(ua);

/** Key label pairs shown to the player for throttle / collective up and down. */
export const THROTTLE_KEYS = IS_MAC ? 'Shift / Ctrl' : 'X / Z';
