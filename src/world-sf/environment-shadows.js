// Render agent: the sun's cascaded shadow map (three's SunLight, 2 cascades in one 2×1 atlas), made cheaper without
// touching three itself:
//   1. no colour attachment: three gives every render target an RGBA8 colour texture, which PCF shadows never read (they
//      compare against the depth texture): 128 MB of GPU memory at 4096² per cascade (high / ultra), 32 MB at 2048²
//      (medium / tablet / laptop). The texture is detached and deleted after three builds the target; the framebuffer
//      stays complete with its depth attachment (colour writes of the depth pass go nowhere).
//   2. the far cascade (high / ultra ≈ 120 m – 1.6 km at 1.5 m per texel; medium / tablets ≈ 120 – 500 m) is
//      re-rendered every second frame; in between it keeps its map and its matrix from the frame it was drawn
//      (world-consistent: static casters are exact, a moving caster's far shadow lags one frame). Its caster pass is the
//      larger one (city blocks, landmarks, airports; the aircraft is in both cascades).
//   3. optional (setCascades(1), no preset uses it): a real single cascade, only the near one with exactly today's split
//      (~130 m on a 500 m range, same texel size for the aircraft) in a 1×1 atlas: half the memory and half the caster
//      pass, but the shadows of lamps / buildings at 130–500 m disappear (a visible change on tablets).
// ?shadowfar=1 renders the far cascade every frame again (A/B), ?shadowcolor=1 keeps the colour attachment.
import * as THREE from 'three';

export function createShadowEconomy(renderer, sun) {
  const q = new URLSearchParams(location.search);
  const shadow = sun.shadow;
  const origUpdate = shadow.updateMatrices.bind(shadow);
  const origCount = shadow.getViewportCount.bind(shadow);
  const keepFar = new THREE.Matrix4();
  let cascades = 2, alternate = q.get('shadowfar') !== '1', skipFar = false, frame = 0, strippedFb = null, farValid = false;

  // Inside the shadow pass the cascades to draw; everywhere else (WebGLLights fills the shader's two cascade matrices /
  // ranges from this count) always both. A pass that drew every cascade makes the far one reusable.
  let inPass = false;
  shadow.getViewportCount = () => (inPass && (cascades === 1 || skipFar) ? 1 : origCount());
  const sm = renderer.shadowMap, smRender = sm.render;   // (WebGLShadowMap.render is looked up on every frame)
  sm.render = function (...a) {
    const runs = sm.enabled && (sm.autoUpdate || sm.needsUpdate) && sun.castShadow;
    inPass = true;
    try { return smRender.apply(this, a); } finally {
      inPass = false;
      if (runs && !skipFar && shadow.map) farValid = true;
    }
  };
  shadow.updateMatrices = function (light, viewCamera) {
    if (skipFar) keepFar.copy(this._matrices[1]);
    origUpdate(light, viewCamera);
    if (cascades === 1) this._cascadeData[1].set(1e30, 1e30, 1e30, 0);   // (the shader never selects it)
    else if (skipFar) this._matrices[1].copy(keepFar);
  };

  function stripColour() {
    const rt = shadow.map;
    if (!rt || q.get('shadowcolor') === '1') return;
    const rp = renderer.properties.get(rt), tp = renderer.properties.get(rt.texture);
    const fb = rp.__webglFramebuffer;
    if (!fb || fb === strippedFb || !tp.__webglTexture) return;
    const gl = renderer.getContext();
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (!ok) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tp.__webglTexture, 0);   // (keep it: some driver wants colour)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    strippedFb = fb;
    if (ok) gl.deleteTexture(tp.__webglTexture);   // three never binds it again (nothing samples a PCF map's colour)
  }

  return {
    /** Preset's cascade count (1 or 2). */
    setCascades(n) {
      const c = n >= 2 ? 2 : 1;
      if (c === cascades) return;
      cascades = c;
      shadow._frameExtents.set(c, 1);   // WebGLShadowMap resizes the atlas to mapSize × extents on the next pass
      farValid = false;
    },
    /** Before each render: which cascades this frame draws (the far one every second frame). */
    beforeRender() {
      stripColour();
      const rt = shadow.map;
      // (only while the map is re-rendered every frame: a frozen map's refreshes draw every cascade)
      skipFar = cascades === 2 && alternate && farValid && renderer.shadowMap.autoUpdate && (frame++ & 1) === 1 && !!rt;
      if (rt) {
        rt.scissorTest = skipFar;   // the atlas clear at the start of the pass must not wipe the far cascade
        if (skipFar) rt.scissor.set(0, 0, shadow.mapSize.x, shadow.mapSize.y);
      }
    },
    get skipFar() { return skipFar; },
    get cascades() { return cascades; },
    /** A new map (size change / quality): nothing to keep. */
    reset() { farValid = false; strippedFb = null; },
    /** The next pass must draw every cascade (e.g. after a pass was skipped: frozen shadow map). */
    invalidate() { farValid = false; },
  };
}
