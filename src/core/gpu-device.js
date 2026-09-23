// Device class for graphics defaults and memory budgets (robustness; read by src/core/quality.js).
//
// Why this exists: Safari (macOS and iPadOS) reports its WebGL renderer as just "Apple GPU", and iPadOS Safari sends
// the desktop "Macintosh" user agent, so an iPad looked exactly like an M-series Mac and got the "high" preset:
// ~2.5 GB of WebGL allocations + ~1.2 GB of decoded images, far beyond what iOS lets a tab keep, and the GPU process
// dropped the WebGL context mid-flight. Classes:
//   phone / tablet   iOS, iPadOS (Mac UA + touch), Android — memory-limited whatever the GPU is
//   integrated       Intel / AMD APU / other shared-memory laptop GPUs (Chrome/Edge/Firefox expose the name)
//   apple            Apple Silicon Mac (M-series; "Apple GPU" in Safari)
//   apple-pro        M Pro / Max / Ultra (only visible outside Safari)
//   discrete         NVIDIA / AMD Radeon RX / Pro
//   software         SwiftShader / llvmpipe / Microsoft Basic Render Driver
//   unknown          anything else (medium preset with a 2048 texture cap)

let cached = null;

/** GPU renderer string from a throwaway WebGL2 context (released right away). */
export function probeGpuName() {
  let gl = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; } finally {
    // free the probe context now (iOS counts every live context against the page)
    try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
  }
}

/** Pure classification (unit-testable): { kind: 'phone'|'tablet'|'desktop', os, tier, gpu, memoryGB, touch }. */
export function classifyDevice({ ua = '', platform = '', maxTouchPoints = 0, gpu = '', deviceMemory = null, screenW = 0, screenH = 0 } = {}) {
  const iPhone = /iPhone|iPod/.test(ua);
  const iPadUA = /iPad/.test(ua);
  const macTouch = /Macintosh|MacIntel/.test(ua + ' ' + platform) && maxTouchPoints > 1;   // iPadOS "desktop website" mode
  const android = /Android/.test(ua);
  const androidPhone = android && /Mobile/.test(ua);
  let kind = 'desktop', os = 'other';
  if (iPhone) { kind = 'phone'; os = 'ios'; }
  else if (iPadUA || macTouch) { kind = 'tablet'; os = 'ipados'; }
  else if (android) { kind = androidPhone ? 'phone' : 'tablet'; os = 'android'; }
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'mac';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Linux/.test(ua)) os = 'linux';
  // small touch-first screens without a mobile UA (e.g. Android in desktop mode): a phone
  if (kind === 'desktop' && maxTouchPoints > 1 && Math.min(screenW, screenH) > 0 && Math.min(screenW, screenH) < 500 && !/Windows/.test(ua)) kind = 'phone';
  const g = gpu || '';
  let tier = 'unknown';
  if (kind !== 'desktop') tier = 'mobile';
  else if (/SwiftShader|llvmpipe|softpipe|Basic Render|Software/i.test(g)) tier = 'software';
  else if (/Apple M\d+ (Max|Ultra|Pro)/i.test(g)) tier = 'apple-pro';
  else if (/Apple (M\d|GPU)/i.test(g)) tier = 'apple';
  else if (/(NVIDIA|GeForce|RTX|Quadro|Radeon RX|Radeon Pro|Radeon \d{3,4}M? ?X|Arc\(TM\) A\d)/i.test(g)) tier = 'discrete';
  else if (/(Intel|UHD|Iris|Radeon(\(TM\))? Graphics|Radeon Vega|Vega \d|Mali|Adreno|PowerVR)/i.test(g)) tier = 'integrated';
  return { kind, os, tier, gpu: g, memoryGB: deviceMemory || null, touch: maxTouchPoints > 0 };
}

/** The running device (memoized). */
export function detectDevice() {
  if (cached) return cached;
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const scr = typeof screen === 'undefined' ? {} : screen;
  cached = classifyDevice({
    ua: nav.userAgent || '', platform: nav.platform || '', maxTouchPoints: nav.maxTouchPoints || 0,
    gpu: typeof document === 'undefined' ? '' : probeGpuName(), deviceMemory: nav.deviceMemory || null,
    screenW: scr.width || 0, screenH: scr.height || 0,
  });
  // ?device=phone|tablet|desktop|integrated forces the class (testing the caps on a desktop browser)
  const forced = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('device');
  if (forced === 'phone' || forced === 'tablet') Object.assign(cached, { kind: forced, tier: 'mobile' });
  else if (forced === 'desktop' && cached.kind !== 'desktop') Object.assign(cached, { kind: 'desktop', tier: 'apple' });
  else if (forced === 'integrated') Object.assign(cached, { kind: 'desktop', tier: 'integrated' });
  return cached;
}

/** Short device label for telemetry: 'tablet/ipados/mobile'. */
export function deviceLabel(d = detectDevice()) { return `${d.kind}/${d.os}/${d.tier}`; }
