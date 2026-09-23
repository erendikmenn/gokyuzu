// Exact accounting of the WebGL memory this page allocates (robustness): wraps the allocation calls of ONE context
// (instance properties, so other canvases are untouched) and sums buffers, textures (incl. mip chains, cube faces,
// array layers) and renderbuffers as they are created, resized and deleted. Used by the GPU budget monitor and the
// `gfx` telemetry snapshot (src/core/gpu-guard.js). The wrappers call the original first and never throw. Only
// allocation calls are wrapped (bufferData, texImage/texStorage, renderbufferStorage, delete*): the bound object is
// read back with getParameter, so per-frame calls (bind*, bufferSubData, texSubImage, draws) cost nothing extra.
// The default framebuffer (canvas) is estimated from the drawing buffer size and the context attributes.

const BPP = {};   // internal format → bytes per texel (filled lazily from the context's constants)
function fillBpp(gl) {
  const t = [
    ['RGBA8', 4], ['SRGB8_ALPHA8', 4], ['RGBA', 4], ['RGB8', 4], ['RGB', 4], ['SRGB8', 4], ['RGBA16F', 8], ['RGBA32F', 16],
    ['RGB16F', 8], ['RGB32F', 16], ['R8', 1], ['RG8', 2], ['R16F', 2], ['R32F', 4], ['RG16F', 4], ['RG32F', 8],
    ['R11F_G11F_B10F', 4], ['RGB10_A2', 4], ['DEPTH_COMPONENT16', 2], ['DEPTH_COMPONENT24', 4], ['DEPTH_COMPONENT32F', 4],
    ['DEPTH24_STENCIL8', 4], ['DEPTH32F_STENCIL8', 8], ['LUMINANCE', 1], ['ALPHA', 1], ['LUMINANCE_ALPHA', 2],
    ['DEPTH_COMPONENT', 4], ['DEPTH_STENCIL', 4], ['RGBA8UI', 4], ['R8UI', 1], ['RG8UI', 2], ['RGBA16UI', 8], ['R16UI', 2],
    ['R32UI', 4], ['RGBA32UI', 16], ['RGBA4', 2], ['RGB5_A1', 2], ['RGB565', 2], ['STENCIL_INDEX8', 1],
  ];
  for (const [k, v] of t) if (gl[k] !== undefined) BPP[gl[k]] = v;
  // block-compressed formats of KTX2 textures (tools/assets/textures.mjs; KTX2Loader picks one per device), by value
  // since their constants live on the extension objects: S3TC/BC, BPTC, RGTC, ETC1/ETC2/EAC, ASTC 4x4, PVRTC.
  // Without them every KTX2 texture was counted at 4 bytes per texel (4–8× too much for the budget monitor).
  Object.assign(BPP, {
    0x83F0: 0.5, 0x83F1: 0.5, 0x83F2: 1, 0x83F3: 1, 0x8C4C: 0.5, 0x8C4D: 0.5, 0x8C4E: 1, 0x8C4F: 1,
    0x8E8C: 1, 0x8E8D: 1, 0x8E8E: 1, 0x8E8F: 1, 0x8DBB: 0.5, 0x8DBC: 0.5, 0x8DBD: 1, 0x8DBE: 1, 0x8D64: 0.5,
    0x9270: 0.5, 0x9271: 0.5, 0x9272: 1, 0x9273: 1, 0x9274: 0.5, 0x9275: 0.5, 0x9276: 0.5, 0x9277: 0.5, 0x9278: 1, 0x9279: 1,
    0x93B0: 1, 0x93D0: 1, 0x8C00: 0.5, 0x8C01: 0.25, 0x8C02: 0.5, 0x8C03: 0.25,
  });
}

export function attachGpuMeter(gl) {
  if (!gl || gl.__gpuMeter) return gl && gl.__gpuMeter;
  if (!Object.keys(BPP).length) fillBpp(gl);
  const bpp = (f) => BPP[f] || 4;
  const m = { buffers: 0, textures: 0, renderbuffers: 0, peak: 0, texCount: 0, bufCount: 0 };
  let bufBytes = new WeakMap(), texInfo = new WeakMap(), rbBytes = new WeakMap();
  const CUBE = gl.TEXTURE_CUBE_MAP, CUBE0 = gl.TEXTURE_CUBE_MAP_POSITIVE_X, TEX3D = gl.TEXTURE_3D;
  const BUF_BINDING = { [gl.ARRAY_BUFFER]: gl.ARRAY_BUFFER_BINDING, [gl.ELEMENT_ARRAY_BUFFER]: gl.ELEMENT_ARRAY_BUFFER_BINDING };
  if (gl.UNIFORM_BUFFER !== undefined) Object.assign(BUF_BINDING, { [gl.UNIFORM_BUFFER]: gl.UNIFORM_BUFFER_BINDING, [gl.COPY_READ_BUFFER]: gl.COPY_READ_BUFFER_BINDING, [gl.COPY_WRITE_BUFFER]: gl.COPY_WRITE_BUFFER_BINDING, [gl.PIXEL_PACK_BUFFER]: gl.PIXEL_PACK_BUFFER_BINDING, [gl.PIXEL_UNPACK_BUFFER]: gl.PIXEL_UNPACK_BUFFER_BINDING, [gl.TRANSFORM_FEEDBACK_BUFFER]: gl.TRANSFORM_FEEDBACK_BUFFER_BINDING });
  const TEX_BINDING = { [gl.TEXTURE_2D]: gl.TEXTURE_BINDING_2D, [CUBE]: gl.TEXTURE_BINDING_CUBE_MAP };
  if (TEX3D !== undefined) Object.assign(TEX_BINDING, { [TEX3D]: gl.TEXTURE_BINDING_3D, [gl.TEXTURE_2D_ARRAY]: gl.TEXTURE_BINDING_2D_ARRAY });
  const bindTarget = (t) => (t >= CUBE0 && t < CUBE0 + 6 ? CUBE : t);
  const boundTex = (target) => { const b = TEX_BINDING[bindTarget(target)]; return b ? gl.getParameter(b) : null; };
  const boundBufOf = (target) => { const b = BUF_BINDING[target]; return b ? gl.getParameter(b) : null; };
  const total = () => m.buffers + m.textures + m.renderbuffers;
  const bump = () => { const t = total(); if (t > m.peak) m.peak = t; };
  function setTex(tex, key, bytes) {
    if (!tex) return;
    let info = texInfo.get(tex);
    if (!info) { info = { total: 0, parts: new Map() }; texInfo.set(tex, info); m.texCount++; }
    const old = info.parts.get(key) || 0;
    info.parts.set(key, bytes);
    info.total += bytes - old;
    m.textures += bytes - old;
    bump();
  }
  const wrap = (name, after) => {
    const orig = gl[name];
    if (typeof orig !== 'function') return;
    gl[name] = function (a, b, c, d, e, f, g, h, i, j) {
      const r = orig.apply(gl, arguments);
      try { after(arguments, a, b, c, d, e, f, g, h, i, j); } catch { /* accounting must never break rendering */ }
      return r;
    };
  };
  wrap('bufferData', (args, target, src, usage, off, len) => {
    const buf = boundBufOf(target);
    if (!buf) return;
    let bytes = 0;
    if (typeof src === 'number') bytes = src;
    else if (src) { const el = src.BYTES_PER_ELEMENT || 1; bytes = len ? len * el : src.byteLength - (off || 0) * el; }
    const old = bufBytes.get(buf);
    if (old === undefined) m.bufCount++;
    bufBytes.set(buf, bytes);
    m.buffers += bytes - (old || 0);
    bump();
  });
  wrap('deleteBuffer', (args, buf) => { const old = bufBytes.get(buf); if (old !== undefined) { m.buffers -= old; m.bufCount--; bufBytes.delete(buf); } });
  wrap('texImage2D', (args, target, level, fmt, w, h) => {
    if (args.length === 6) { const s = args[5]; w = s.naturalWidth || s.videoWidth || s.displayWidth || s.width || 0; h = s.naturalHeight || s.videoHeight || s.displayHeight || s.height || 0; }
    setTex(boundTex(target), `${target}:${level}`, w * h * bpp(fmt));
  });
  wrap('texImage3D', (args, target, level, fmt, w, h, d) => { setTex(boundTex(target), `${target}:${level}`, w * h * d * bpp(fmt)); });
  wrap('compressedTexImage2D', (args, target, level) => { const d = args[6]; setTex(boundTex(target), `${target}:${level}`, typeof d === 'number' ? d : (d && d.byteLength) || 0); });
  wrap('texStorage2D', (args, target, levels, fmt, w, h) => {
    let bytes = 0;
    for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * bpp(fmt);
    setTex(boundTex(target), 'storage', target === CUBE ? bytes * 6 : bytes);
  });
  wrap('texStorage3D', (args, target, levels, fmt, w, h, d) => {
    let bytes = 0;
    for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * (target === TEX3D ? Math.max(1, d >> l) : d) * bpp(fmt);
    setTex(boundTex(target), 'storage', bytes);
  });
  wrap('generateMipmap', (args, target) => {
    const t = boundTex(target), info = t && texInfo.get(t);
    if (!info || info.parts.has('storage')) return;   // texStorage already counted the chain
    let base = 0;
    for (const [k, v] of info.parts) if (k.endsWith(':0')) base += v;
    if (base) setTex(t, 'mips', Math.round(base / 3));
  });
  wrap('deleteTexture', (args, tex) => { const info = texInfo.get(tex); if (info) { m.textures -= info.total; m.texCount--; texInfo.delete(tex); } });
  const rbSet = (bytes) => {
    const rb = gl.getParameter(gl.RENDERBUFFER_BINDING);
    if (!rb) return;
    const old = rbBytes.get(rb) || 0; rbBytes.set(rb, bytes); m.renderbuffers += bytes - old; bump();
  };
  wrap('renderbufferStorage', (args, target, fmt, w, h) => rbSet(w * h * bpp(fmt)));
  wrap('renderbufferStorageMultisample', (args, target, samples, fmt, w, h) => rbSet(w * h * bpp(fmt) * Math.max(1, samples)));
  wrap('deleteRenderbuffer', (args, rb) => { const old = rbBytes.get(rb); if (old !== undefined) { m.renderbuffers -= old; rbBytes.delete(rb); } });

  const attrs = (gl.getContextAttributes && gl.getContextAttributes()) || {};
  const meter = {
    /** Canvas (default framebuffer): colour + depth, multisampled + resolve when antialiased, plus the display copy. */
    framebufferBytes() {
      const px = (gl.drawingBufferWidth || 0) * (gl.drawingBufferHeight || 0);
      const depth = attrs.depth === false ? 0 : 4;
      return px * (attrs.antialias ? 4 * (4 + depth) + 4 + 4 : 4 + depth + 4);
    },
    /** Everything this page holds on the GPU through this context, in bytes. */
    get bytes() { return total() + meter.framebufferBytes(); },
    get peak() { return m.peak + meter.framebufferBytes(); },
    /** After a context loss every object is gone: start from zero. */
    reset() {
      m.buffers = m.textures = m.renderbuffers = 0; m.texCount = m.bufCount = 0;
      bufBytes = new WeakMap(); texInfo = new WeakMap(); rbBytes = new WeakMap();   // deletes of dead objects must not count
    },
    /** Compact MB figures for telemetry / logs. */
    snapshot() {
      const MB = (b) => Math.round(b / 1048576);
      return { gpu: MB(meter.bytes), tex: MB(m.textures), buf: MB(m.buffers), rb: MB(m.renderbuffers), fb: MB(meter.framebufferBytes()), peak: MB(meter.peak), nt: m.texCount, nb: m.bufCount };
    },
    stats: m,
  };
  gl.__gpuMeter = meter;
  return meter;
}
