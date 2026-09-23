import { chromium, webkit } from 'playwright';
for (const [name, bt] of [['webkit', webkit], ['chromium', chromium]]) {
  const b = await bt.launch(); const p = await b.newPage();
  await p.setContent('<canvas id=c></canvas>');
  const r = await p.evaluate(async () => {
    const out = [];
    const c = document.getElementById('c'); const gl = c.getContext('webgl2');
    let evAt = null; c.addEventListener('webglcontextlost', (e) => { evAt = 'fired'; e.preventDefault(); });
    const ext = gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    out.push('sync after loseContext: event=' + evAt + ' isContextLost=' + gl.isContextLost());
    const s = gl.createShader(gl.VERTEX_SHADER);
    out.push('createShader → ' + (s === null ? 'null' : Object.prototype.toString.call(s)));
    try { gl.shaderSource(s, 'void main(){}'); out.push('shaderSource ok'); } catch (e) { out.push('shaderSource threw: ' + e.constructor.name + ': ' + e.message); }
    try { gl.shaderSource(null, 'x'); } catch (e) { out.push('shaderSource(null) threw: ' + e.message); }
    await new Promise((r) => setTimeout(r, 50));
    out.push('after a task: event=' + evAt);
    return out;
  });
  console.log(name, r);
  await b.close();
}
