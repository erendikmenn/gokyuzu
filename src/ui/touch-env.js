// Touch / mobile environment: touch-only detection (the on-screen controls), in-app browsers (X, Instagram, …), the
// WebGL 2 probe and the weak-device rule of the start gate (src/ui/touch-gate.js). No DOM building here.
//
//   touchMode()          on-screen controls wanted: touch-only device (coarse pointer, no mouse / trackpad), or ?touch=1
//                        (?touch=0 forces them off)
//   inAppBrowser()       { id, name, os } for social-app webviews, else null
//   gateCheck()          { ok, reason, soft, … }: can this device run the 3D world? (see RULES below)
import { detectDevice } from '../core/gpu-device.js';

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const mm = (q) => { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch { return false; } };

/** Touch screen without a fine pointer (phones, tablets without a keyboard / trackpad). */
export function isTouchOnly() {
  try {
    const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    return touch && mm('(pointer: coarse)') && !mm('(any-pointer: fine)');
  } catch { return false; }
}

/** The game should show the on-screen touch controls (and the touch menu / tutorial texts). */
export function touchMode() {
  const q = params.get('touch');
  if (q === '1') return true;
  if (q === '0') return false;
  return isTouchOnly();
}

/** Phone-sized viewport (the short side is below a small tablet's). */
export const isPhoneSize = () => Math.min(window.innerWidth || 0, window.innerHeight || 0) < 500;

/** OS family from the user agent (iPadOS in desktop mode reports a Mac with touch). */
export function mobileOS(ua = navigator.userAgent) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** Social-app in-app browser (webview) or null. The X / Instagram webviews have no fullscreen and ask for no sensor permission. */
export function inAppBrowser(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  const os = mobileOS(ua);
  const hit = (id, name) => ({ id, name, os });
  if (/Instagram/i.test(ua)) return hit('instagram', 'Instagram');
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return hit('facebook', 'Facebook');
  if (/Twitter/i.test(ua)) return hit('x', 'X');
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return hit('tiktok', 'TikTok');
  if (/\bLine\//.test(ua)) return hit('line', 'LINE');
  if (/Snapchat/i.test(ua)) return hit('snapchat', 'Snapchat');
  if (/LinkedInApp/i.test(ua)) return hit('linkedin', 'LinkedIn');
  if (/; wv\)/.test(ua)) return hit('webview', 'uygulama');
  return null;
}

/** WebGL 2 capability probe (throwaway context, released right away). */
export function probeWebGL2() {
  let gl = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    gl = c.getContext('webgl2');
    if (!gl) return { ok: false, gpu: '', maxTex: 0 };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    return { ok: true, gpu, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0 };
  } catch { return { ok: false, gpu: '', maxTex: 0 }; } finally {
    try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
  }
}

/** Social-app webviews that lose the WebGL context on iOS (live telemetry, 23 Sep 2026: 79 of 98 iOS sessions were X). */
export const BAD_IAB = new Set(['x', 'instagram', 'facebook']);
/** This page runs in one of them (iPhone / iPad). */
export const inBadInAppBrowser = () => { const b = inAppBrowser(); return !!(b && b.os === 'ios' && BAD_IAB.has(b.id)); };

// Mobile GPUs that cannot draw the bay at a playable rate even on the low preset with the phone caps
// (src/core/quality.js DEVICE_CAPS.phone): Mali-4xx / T6xx–T8xx (2012–2016), Adreno 1xx–4xx, PowerVR SGX and the
// GE8xxx entry-level Rogue parts (e.g. GE8320 in MediaTek Helio P22/P35 phones), Vivante, VideoCore.
const WEAK_MOBILE_GPU = /Mali-(4\d\d|T[678]\d\d)|Adreno( \(TM\))? [1-4]\d\d\b|PowerVR (SGX|Rogue GE8\d{3})|Vivante|VideoCore/i;

/**
 * The start gate (src/ui/touch-gate.js), run before anything of the 3D world is downloaded:
 *   webgl2    no WebGL 2 context (three.js r186 needs it)                                       → hard: cannot start
 *   software  phone / tablet drawing with a software rasterizer                                 → soft: "Yine de dene"
 *   memory    phone / tablet with < 2 GB (navigator.deviceMemory), or a 320-pt-wide iPhone (SE 1st gen, 2 GB):
 *             below the phone caps' ~900 MB WebGL budget + JS heap                              → soft
 *   gpu       phone / tablet GPU in WEAK_MOBILE_GPU, or a max texture size below 4096             → soft
 *   iab       X / Instagram / Facebook in-app browser on iOS: "Safari'de aç" first                   → soft
 * Desktop browsers only get the WebGL 2 rule (the robustness caps and the budget guard handle weak desktop GPUs).
 * ?gate=<reason> simulates a failure (testing the screen); ?gate=off skips the check.
 */
export function gateCheck() {
  const forced = params.get('gate');
  if (forced === 'off') return { ok: true };
  if (forced && forced !== 'off') return { ok: false, reason: forced, soft: forced !== 'webgl2', gpu: '', kind: 'test' };
  const gl = probeWebGL2();
  if (!gl.ok) return { ok: false, reason: 'webgl2', soft: false, gpu: '', kind: '' };
  // docs/errors/audit.md #2: the X / Instagram / Facebook webviews on iOS drop the WebGL context within seconds at only
  // 20–50 MB of GPU memory (their process limits, not the game's budget): the real browser is the default way in
  const iab = inAppBrowser();
  if (iab && iab.os === 'ios' && BAD_IAB.has(iab.id)) return { ok: false, reason: 'iab', soft: true, gpu: gl.gpu, kind: 'iab', iab };
  let dev;
  try { dev = detectDevice(); } catch { dev = { kind: 'desktop' }; }
  const mobile = dev.kind === 'phone' || dev.kind === 'tablet';
  const res = { ok: true, gpu: gl.gpu, kind: dev.kind, maxTex: gl.maxTex };
  if (!mobile) return res;
  const fail = (reason) => Object.assign(res, { ok: false, reason, soft: true });
  if (/SwiftShader|llvmpipe|softpipe|Software/i.test(gl.gpu)) return fail('software');
  const mem = navigator.deviceMemory;
  if (typeof mem === 'number' && mem > 0 && mem < 2) return fail('memory');
  const sw = Math.min(screen.width || 0, screen.height || 0);
  if (/iPhone|iPod/.test(navigator.userAgent) && sw > 0 && sw <= 320) return fail('memory');
  if (WEAK_MOBILE_GPU.test(gl.gpu) || (gl.maxTex && gl.maxTex < 4096)) return fail('gpu');
  return res;
}
