// Device class for graphics defaults and memory budgets (robustness; read by src/core/quality.js).
//
// Why this exists: Safari (macOS and iPadOS) reports its WebGL renderer as just "Apple GPU", and iPadOS Safari sends
// the desktop "Macintosh" user agent, so an iPad looked exactly like an M-series Mac and got the "high" preset:
// ~2.5 GB of WebGL allocations + ~1.2 GB of decoded images, far beyond what iOS lets a tab keep, and the GPU process
// dropped the WebGL context mid-flight. Classes:
//   phone / tablet   iOS, iPadOS (Mac UA + touch), Android — memory-limited whatever the GPU is
//   integrated       Intel / AMD APU / other shared-memory laptop GPUs (Chrome/Edge/Firefox expose the name)
//   integrated-fast  the strong recent iGPUs (Radeon 680M / 780M / 880M / 890M, Intel Arc iGPU of Core Ultra): the
//                    integrated memory caps, but the medium preset
//   apple            Apple Silicon Mac (M-series; "Apple GPU" in Safari)
//   apple-pro        M Pro / Max / Ultra (only visible outside Safari)
//   discrete         NVIDIA / AMD Radeon RX / Pro / Intel Arc A / B
//   midrange         older or entry-level dedicated GPUs that cannot hold "high" (GTX 950 / 960 / 1050 (Ti), MX 4xx / 5xx,
//                    Quadro M / P400–P1000 / T400 / T600, Radeon R9, Arc A3xx): medium preset
//   entry            very old or very weak dedicated GPUs (GT 7xx / GT 1030, GTX 4xx–7xx, Quadro K / FX / NVS, GeForce
//                    MX 1xx–3xx, Radeon HD / R5 / R7, RX 460 / 550 / 560): low preset with the integrated memory caps
//   software         SwiftShader / llvmpipe / Microsoft Basic Render Driver (WARP: Windows without a working GPU driver,
//                    remote desktop, virtual machines; SwiftShader: Chrome with graphics acceleration off)
//   unknown          anything else (medium preset with a 2048 texture cap)
// Live telemetry, 23–26 Sep 2026 (tools/analytics/report.py "Platformlar"): 4 % of the Windows sessions drew with the
// Microsoft Basic Render Driver at ~10 fps; GT 730 / Quadro K / GTX 480 / RX 550 got "high" as "discrete" and sat at
// the 0.6 pixel-ratio floor at 16–45 fps.

let cached = null;

/**
 * Renderer string of a context. Firefox has deprecated WEBGL_debug_renderer_info (a console warning on every use) and
 * already answers RENDERER with the same (sanitized) GPU name, e.g. "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11
 * vs_5_0 ps_5_0), or similar"; the other engines need the extension for the real name.
 */
export function rendererString(gl) {
  if (!gl) return '';
  try {
    const gecko = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent || '');
    const ext = gecko ? null : gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}

let probed = null;
/**
 * One throwaway WebGL context (released right away), memoized for the page: { webgl2, gpu, maxTex }. Creating a context
 * is not free (Firefox on Windows creates a D3D11 device for each), so every caller shares this probe.
 */
export function probeGpu() {
  if (probed) return probed;
  let gl = null, webgl2 = false;
  probed = { webgl2: false, gpu: '', maxTex: 0 };
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    gl = c.getContext('webgl2');
    webgl2 = !!gl;
    if (!gl) gl = c.getContext('webgl');
    if (gl) probed = { webgl2, gpu: rendererString(gl), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0 };
  } catch { /* no WebGL */ } finally {
    // free the probe context now (iOS counts every live context against the page)
    try { const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* ignore */ }
  }
  return probed;
}

/** GPU renderer string from the shared probe context. */
export function probeGpuName() { return probeGpu().gpu; }

/**
 * Browser engine: 'webkit' (Safari, and every browser on iOS / iPadOS), 'gecko' (Firefox), else 'blink'. WebKit's real
 * memory footprint is 2.5–4× what the game's GPU meter counts (docs/perf/findings-2026-09.md T5), see quality.js.
 */
export function browserEngine(ua = '', ios = false) {
  if (ios) return 'webkit';
  if (/Firefox\//.test(ua) && !/Seamonkey/.test(ua)) return 'gecko';
  if (/Chrome\/|Chromium\/|CriOS|Edg\/|OPR\//.test(ua)) return 'blink';
  if (/AppleWebKit/.test(ua)) return 'webkit';
  return 'blink';
}

/** Pure classification (unit-testable): { kind: 'phone'|'tablet'|'desktop', os, tier, engine, gpu, memoryGB, touch }. */
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
  const tier = kind !== 'desktop' ? 'mobile' : gpuTier(g);
  return { kind, os, tier, engine: browserEngine(ua, os === 'ios' || os === 'ipados'), gpu: g, memoryGB: deviceMemory || null, touch: maxTouchPoints > 0 };
}

// Dedicated GPUs below "high" (see the header). Checked on the raw renderer string, e.g. "ANGLE (NVIDIA, NVIDIA GeForce
// GT 730 (0x00001287) Direct3D11 vs_5_0 ps_5_0, D3D11)"; the (R) / (TM) marks are optional.
const TM = '(?:\\((?:R|TM)\\))?';
const ENTRY_GPU = new RegExp([
  'GeForce' + TM + ' (?:GT|GTS|G)? ?\\d{3}M?\\b',        // GT 710 / 730 / 740, GeForce 210, 820M / 920M
  'GeForce' + TM + ' GT 1030',
  'GeForce' + TM + ' GTX [4-7]\\d\\d',                    // Fermi / Kepler / early Maxwell
  'GeForce' + TM + ' MX ?[1-3]\\d\\d',                     // laptop MX 110–350
  'GeForce' + TM + ' 9\\d0MX',
  'Quadro' + TM + ' (?:K\\d|FX|NVS|[1-6]000\\b|410\\b|600\\b)', 'NVS \\d',
  'Radeon' + TM + ' (?:HD|R[57]\\b|R[57] ?\\d)',            // Radeon HD 7xxx, R5 / R7 2xx / 3xx
  'Radeon' + TM + ' (?:RX ?)?(?:460|540|550|560|640)\\b', 'RX ?550/550',
  'Radeon' + TM + ' (?:5[0-4]0|6[0-3]0)\\b',               // laptop Radeon 520–540 / 610–630
].join('|'), 'i');
const MIDRANGE_GPU = new RegExp([
  'GeForce' + TM + ' GTX (?:9[56]0|1050|1630)',          // (incl. 1050 Ti)
  'GeForce' + TM + ' MX ?[4-9]\\d\\d',
  'Quadro' + TM + ' (?:M\\d|P(?:400|600|620|1000)\\b)', 'NVIDIA T(?:400|500|550|600)\\b',
  'Radeon' + TM + ' R9\\b', 'Radeon' + TM + ' (?:RX ?)?(?:5300|6300|6400)\\b',
  'Arc' + TM + ' A3\\d\\d',
].join('|'), 'i');
// strong integrated GPUs (RDNA 2/3 APUs, Intel Arc iGPU of Core Ultra): medium preset, integrated memory caps
const FAST_IGPU = new RegExp([
  'Radeon' + TM + ' (?:6[68]0M|7[68]0M|8[4-9]0M)', 'gfx1103|gfx115\\d',
  'Arc' + TM + ' (?:Graphics|1[34]0[VT])',
].join('|'), 'i');

/** Desktop tier from the renderer string (pure; see the header for the classes). */
export function gpuTier(g = '') {
  if (/SwiftShader|llvmpipe|softpipe|Basic Render|Software/i.test(g)) return 'software';
  if (/Apple M\d+ (Max|Ultra|Pro)/i.test(g)) return 'apple-pro';
  if (/Apple (M\d|GPU)/i.test(g)) return 'apple';
  if (FAST_IGPU.test(g)) return 'integrated-fast';
  if (ENTRY_GPU.test(g)) return 'entry';
  if (MIDRANGE_GPU.test(g)) return 'midrange';
  if (/(NVIDIA|GeForce|RTX|Quadro|Radeon RX|Radeon Pro|Radeon \d{3,4}M? ?X|Arc\(TM\) [AB]\d|Arc [AB]\d)/i.test(g)) return 'discrete';
  if (/(Intel|UHD|Iris|Radeon(\(TM\))? Graphics|Radeon(\(TM\))? \d{3}M\b|Radeon Vega|Vega \d|Mali|Adreno|PowerVR)/i.test(g)) return 'integrated';
  return 'unknown';
}

/**
 * Readable GPU name for telemetry and notices (pure). The WebGL renderer strings differ per browser and backend:
 *   "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)"  → "Intel UHD Graphics 620"
 *   "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)"                   → "Apple M4 Max"
 *   "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)" → "SwiftShader"
 *   "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" (Firefox)      → "NVIDIA GeForce GTX 980"
 *   "Adreno (TM) 650" → "Adreno 650" · "llvmpipe (LLVM 15.0.7, 256 bits)" → "llvmpipe"
 * The telemetry used to cut "Intel(R) UHD Graphics 620" at the "(" → "Intel" (392 Windows sessions without a model).
 */
export function gpuLabel(raw = '') {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/SwiftShader/i.test(s)) return 'SwiftShader';
  s = s.replace(/,? or similar$/i, '');
  const metal = /Renderer: ([^,)]+)/.exec(s);
  const on = /^ANGLE \(([^()]*)\) on /.exec(s);   // "ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179"
  const angle = /^ANGLE \((.*)\)$/.exec(s);
  if (metal) s = metal[1];
  else if (on) s = on[1];
  else if (angle) { const parts = angle[1].split(', '); s = parts.length > 1 ? parts[1] : parts[0]; }
  s = s.replace(/\((?:R|TM|C)\)/gi, ' ')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(?:Direct3D|D3D1\d|OpenGL|Vulkan|vs_\d).*$/i, '')
    .replace(/\/PCIe\/SSE2/i, '')
    .replace(/\s*\([^()]*\)/g, '')     // driver / chip codes
    .replace(/\s*\(.*$/, '')           // a name cut at a comma inside its parentheses
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, 60);
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
  // ?device=phone|tablet|desktop|integrated|entry|midrange|software forces the class (testing the caps on a desktop browser)
  const forced = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('device');
  if (forced === 'phone' || forced === 'tablet') Object.assign(cached, { kind: forced, tier: 'mobile' });
  else if (forced === 'desktop' && cached.kind !== 'desktop') Object.assign(cached, { kind: 'desktop', tier: 'apple' });
  else if (['integrated', 'entry', 'midrange', 'software'].includes(forced)) Object.assign(cached, { kind: 'desktop', tier: forced });
  return cached;
}

/** Short device label for telemetry: 'tablet/ipados/mobile'. */
export function deviceLabel(d = detectDevice()) { return `${d.kind}/${d.os}/${d.tier}`; }

/**
 * Turkish notice for a software renderer (src/core/gpu-guard.js), or null: what is wrong and how to turn the graphics
 * card on in this browser. `d` = a classifyDevice() result, `ua` = the user agent (browser menus differ).
 */
export function softwareRenderAdvice(d = detectDevice(), ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '') {
  if (!d || d.tier !== 'software' || d.kind !== 'desktop') return null;
  return {
    title: 'Ekran kartı kullanılamıyor',
    text: 'Tarayıcın 3B çizim için ekran kartını kullanamıyor; dünya işlemciyle (yazılımla) çiziliyor ve oyun saniyede yalnızca birkaç kare gösterebilir. Grafikler en düşük ayara alındı.',
    steps: gpuAccelSteps({ os: d.os, ua, warp: /Basic Render/i.test(d.gpu || '') }),
  };
}

/**
 * Turkish steps to get the graphics card working in this browser (pure): the GPU driver (WARP = Windows drawing without
 * one), the browser's graphics-acceleration switch, remote desktop / VMs. Also for a desktop without WebGL 2 at all
 * (the start gate, src/ui/touch-gate.js: usually graphics acceleration turned off).
 */
export function gpuAccelSteps({ os = 'other', ua = '', warp = false } = {}) {
  const linux = os === 'linux' || os === 'chromeos';
  const firefox = /Firefox\//.test(ua), edge = /Edg\//.test(ua), opera = /OPR\//.test(ua);
  const steps = [];
  if (warp) steps.push('Ekran kartı sürücüsü yüklü değil ya da çalışmıyor görünüyor: Windows Update → Gelişmiş seçenekler → İsteğe bağlı güncellemeler’den veya ekran kartı üreticisinin (Intel, AMD, NVIDIA) sitesinden sürücüyü kurup bilgisayarı yeniden başlat.');
  if (linux) steps.push('Ekran kartı sürücüsünü (Mesa ya da üreticinin sürücüsü) kurup oturumu yeniden başlat.');
  if (firefox) steps.push('Firefox: Ayarlar → Genel → Performans’ta «Önerilen performans ayarlarını kullan» işaretini kaldır, «Kullanılabilir olduğunda donanım hızlandırmasını kullan»ı işaretle ve Firefox’u yeniden başlat.');
  else steps.push(`${edge ? 'Edge: Ayarlar → Sistem ve performans' : opera ? 'Opera: Ayarlar → Sistem' : 'Chrome: Ayarlar → Sistem'} bölümünde «Kullanılabilir olduğunda grafik hızlandırmayı kullan» seçeneğini aç ve tarayıcıyı yeniden başlat.`);
  if (os === 'windows') steps.push('Uzak masaüstü veya sanal makine üzerinden bağlandıysan oyunu doğrudan bilgisayarın kendisinde aç.');
  return steps;
}

/**
 * Windows laptops drawing with the integrated GPU although a dedicated one may exist (hybrid graphics: the OS picks the
 * GPU per application; the renderer asks for powerPreference 'high-performance', which Windows browsers do not always
 * honour). Turkish hint for the graphics settings (src/ui/panels.js), or null. Pure.
 */
export function integratedGpuAdvice(d = detectDevice()) {
  if (!d || d.kind !== 'desktop' || d.os !== 'windows' || !/^integrated/.test(d.tier)) return null;
  return 'Bilgisayarında ayrı bir ekran kartı (NVIDIA / AMD) da varsa: Windows Ayarlar → Sistem → Ekran → Grafik bölümünde tarayıcını seçip «Yüksek performans» yap ve tarayıcıyı yeniden başlat.';
}
