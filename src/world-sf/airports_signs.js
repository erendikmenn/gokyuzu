// W4 airports: airfield guidance signs (mandatory red/white, location black/yellow, direction yellow/black, distance
// remaining black/white). Legends are drawn once into a canvas atlas; all signs of an airport form one merged mesh.
import * as THREE from 'three';

const STYLE = {
  mand: { bg: '#b3121c', fg: '#ffffff', border: '#111111' },
  loc: { bg: '#141414', fg: '#f2c318', border: '#f2c318' },
  dir: { bg: '#f2c318', fg: '#111111', border: '#111111' },
  drm: { bg: '#141414', fg: '#ffffff', border: '#141414' },
  info: { bg: '#f2c318', fg: '#111111', border: '#111111' },
};

export function buildSigns(meta, ctx) {
  const signs = meta.signs || [];
  if (!signs.length) return null;
  const [ox, oz] = meta.origin;
  // --- atlas
  const H = 96, pad = 6, AW = 2048;
  const cv = document.createElement('canvas');
  const g0 = cv.getContext('2d');
  g0.font = `bold ${Math.round(H * 0.72)}px "Helvetica Neue", "Arial Narrow", Arial, sans-serif`;
  const entries = new Map();
  let x = 16, y = 0;
  for (const s of signs) {
    const key = s.s + '|' + s.t;
    if (entries.has(key)) continue;
    const tw = g0.measureText(s.t).width;
    const w = Math.ceil(tw + H * 0.7);
    if (x + w + pad > AW) { x = 16; y += H + pad; }
    entries.set(key, { x, y, w, h: H, s });
    x += w + pad;
  }
  cv.width = AW;
  cv.height = THREE.MathUtils.ceilPowerOfTwo(y + H + pad);
  const g = cv.getContext('2d');
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, 12, 12);
  for (const e of entries.values()) {
    const st = STYLE[e.s.s] || STYLE.loc;
    g.fillStyle = st.border; g.fillRect(e.x, e.y, e.w, e.h);
    g.fillStyle = st.bg; g.fillRect(e.x + 4, e.y + 4, e.w - 8, e.h - 8);
    g.fillStyle = st.fg;
    g.font = `bold ${Math.round(H * 0.72)}px "Helvetica Neue", "Arial Narrow", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(e.s.t, e.x + e.w / 2, e.y + e.h / 2 + 3);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const AH = cv.height;
  // --- geometry: box body + legend quads front and back
  const pos = [], uv = [], nor = [], idx = [];
  const grey = [6 / AW, 1 - 6 / AH];
  const quad = (p0, p1, p2, p3, n, uvs) => {
    const b = pos.length / 3;
    for (const p of [p0, p1, p2, p3]) pos.push(...p);
    for (let k = 0; k < 4; k++) nor.push(...n);
    for (const t of uvs) uv.push(...t);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const tmp = new THREE.Vector3();
  const anchors = [];
  for (const s of signs) {
    const e = entries.get(s.s + '|' + s.t);
    const ph = s.s === 'drm' ? 1.3 : 0.95;               // panel height (m)
    const pw = ph * e.w / e.h;
    const depth = 0.3;
    const h = s.h * Math.PI / 180;
    const f = [Math.sin(h), 0, -Math.cos(h)];            // face normal (toward the reader)
    const r = [Math.cos(h), 0, Math.sin(h)];             // right as seen by... (reader faces -f; reader's right = -r)
    const cx = s.x, cz = s.z;
    const gy = ctx.terrain.getHeight(cx + ox, cz + oz);
    anchors.push([cx + ox, cz + oz, gy, pos.length / 3]);
    const y0 = gy + 0.35, y1 = y0 + ph;
    const P = (a, b, yy) => [cx + r[0] * a + f[0] * b, yy, cz + r[2] * a + f[2] * b];
    const u0 = e.x / AW, u1 = (e.x + e.w) / AW, v0 = 1 - (e.y + e.h) / AH, v1 = 1 - e.y / AH;
    const hw = pw / 2, hd = depth / 2;
    // front (facing +f): reader looks along -f, so reader's right is -r
    quad(P(hw, hd, y0), P(-hw, hd, y0), P(-hw, hd, y1), P(hw, hd, y1), f, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    // back
    const nb = [-f[0], 0, -f[2]];
    quad(P(-hw, -hd, y0), P(hw, -hd, y0), P(hw, -hd, y1), P(-hw, -hd, y1), nb, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    // top, sides (grey)
    const G = [grey, grey, grey, grey];
    quad(P(-hw, hd, y1), P(-hw, -hd, y1), P(hw, -hd, y1), P(hw, hd, y1), [0, 1, 0], G);
    quad(P(hw, hd, y0), P(hw, hd, y1), P(hw, -hd, y1), P(hw, -hd, y0), r, G);
    quad(P(-hw, -hd, y0), P(-hw, -hd, y1), P(-hw, hd, y1), P(-hw, hd, y0), [-r[0], 0, -r[2]], G);
    // legs
    for (const a of [-hw * 0.7, hw * 0.7]) {
      const lw = 0.05;
      quad(P(a - lw, 0.02, gy), P(a + lw, 0.02, gy), P(a + lw, 0.02, y0), P(a - lw, 0.02, y0), f, G);
      quad(P(a + lw, -0.02, gy), P(a - lw, -0.02, gy), P(a - lw, -0.02, y0), P(a + lw, -0.02, y0), nb, G);
    }
    void tmp;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.6, side: THREE.FrontSide });
  mat.name = 'apt-signs';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `apt-signs-${meta.icao}`;
  mesh.position.set(ox, 0, oz);
  mesh.castShadow = true;
  mesh.userData.nightEmissive = mat;
  mesh.userData.drapeGroups = anchors.map(([ax, az, g, start], k) => ({
    ax, az, g, ranges: [[geo, start, (k + 1 < anchors.length ? anchors[k + 1][3] : pos.length / 3) - start]],
  }));
  return mesh;
}
