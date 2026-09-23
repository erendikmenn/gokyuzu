// Experiment shim for "three" (research only, never shipped): re-exports three.js and lets a URL parameter change
// renderer-level options without touching game code. Used through tools/perf/exp/perf-exp.html (written into a scratch
// worktree root by tools/perf/exp/setup.mjs), which maps "three" to this file in its import map.
//   ?exp=nolog      logarithmicDepthBuffer off (plain 24-bit depth: z-fighting far away; measures the early-Z potential)
//   ?exp=revz       reversed float depth: logarithmicDepthBuffer off, reversedDepthBuffer on, the scene rendered into a
//                   HalfFloat colour + 32F depth target (MSAA 4) and tone-mapped to the canvas by a final pass
//   ?exp=nomsaa     antialias off at context creation (for the MSAA cost)
import * as T from '../../../node_modules/three/build/three.module.js';
export * from '../../../node_modules/three/build/three.module.js';

const exp = new Set((new URLSearchParams(location.search).get('exp') || '').split(',').filter(Boolean));
window.__exp = [...exp];

export class WebGLRenderer extends T.WebGLRenderer {
  constructor(p = {}) {
    const o = { ...p };
    if (exp.has('nolog') || exp.has('revz')) o.logarithmicDepthBuffer = false;
    if (exp.has('revz')) { o.reversedDepthBuffer = true; o.antialias = false; }
    if (exp.has('nomsaa')) o.antialias = false;
    super(o);
    if (exp.has('revz')) installFloatDepthPipeline(this, p.antialias !== false);
  }
}

function installFloatDepthPipeline(renderer, msaa) {
  const size = new T.Vector2();
  let rt = null;
  const ensure = () => {
    renderer.getDrawingBufferSize(size);
    if (rt && rt.width === size.x && rt.height === size.y) return rt;
    if (rt) rt.dispose();
    const depth = new T.DepthTexture(size.x, size.y, T.FloatType);
    depth.format = T.DepthFormat;
    rt = new T.WebGLRenderTarget(size.x, size.y, { type: T.HalfFloatType, samples: msaa ? 4 : 0, depthTexture: depth, colorSpace: T.LinearSRGBColorSpace });
    return rt;
  };
  const quadScene = new T.Scene();
  const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new T.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      void main() { gl_FragColor = texture2D(tDiffuse, vUv);
        #ifdef TONE_MAPPING
        gl_FragColor.rgb = toneMapping(gl_FragColor.rgb);
        #endif
        gl_FragColor = linearToOutputTexel(gl_FragColor); }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  // three.js adds the TONE_MAPPING define + toneMapping() for ShaderMaterials only when rendering to the screen with
  // toneMapped true; we do it by hand: define follows renderer.toneMapping
  mat.onBeforeCompile = (s) => { s.fragmentShader = '#define TONE_MAPPING\n' + s.fragmentShader.replace('#include <tonemapping_pars_fragment>', '#include <tonemapping_pars_fragment>\nvec3 toneMapping(vec3 c) { return ACESFilmicToneMapping(c); }'); };
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const render = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    if (renderer.getRenderTarget() !== null) return render(scene, camera);
    const target = ensure();
    renderer.setRenderTarget(target);
    render(scene, camera);
    renderer.setRenderTarget(null);
    mat.uniforms.tDiffuse.value = target.texture;
    const sm = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
    render(quadScene, quadCam);
    renderer.shadowMap.autoUpdate = sm;
  };
}
