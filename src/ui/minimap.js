// Minimap: a dark, stylised relief map sampled lazily from world.getGroundHeight / isWater (time-sliced so the
// frame rate never hitches), with runways, airports, a few landmarks and the aircraft arrow. North-up.
import { REGION } from '../geo.js';
import { clamp, DEG, KT } from './util.js';
import { AIRPORTS, LANDMARK_NAMES } from './data.js';
import { shared } from './shared.js';
import { loadBayMap, BRIDGES } from './baymap.js';

const N_X = 512;                      // samples across the map (x); z count follows the aspect ratio
const SHOW_LANDMARKS = ['golden_gate_bridge', 'bay_bridge_west', 'alcatraz', 'salesforce_tower', 'sutro_tower', 'coit_tower'];
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

export function createMinimap() {
  let img = null;                     // offscreen canvas with the relief (replaced atomically after a rebuild)
  let building = false, builtFor = null, flatRetry = 0, nextBuild = 0;
  const builtAt = { x: 0, z: 0 };
  let bounds = null;
  let span = 9000;                    // meters shown across (smoothed)
  let lastT = 0;
  const BUDGET = 3;                   // ms of work per time slice (never hitches the frame)
  // Preferred base layer: the baked aerial map (full detail from the first frame, no sampling at all).
  // Sampling the streamed terrain remains as the fallback when the bake is missing.
  let baked = false;
  loadBayMap().then((m) => { if (m) { img = m.img; bounds = { minX: m.meta.minX, maxX: m.meta.maxX, minZ: m.meta.minZ, maxZ: m.meta.maxZ }; baked = true; } });

  function regionBounds(world) {
    const r = (world && world.region && world.region.local) || REGION.bounds;
    return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ };
  }

  // Terrain is streamed (heights come from whatever LOD is loaded), so the map is rebuilt in the background
  // after the first streaming burst and whenever the aircraft has moved far from where it was last sampled.
  function build(world, cx0, cz0, delay = 120) {
    if (building || typeof world.getGroundHeight !== 'function') return;
    building = true;
    builtFor = world;
    builtAt.x = cx0; builtAt.z = cz0;
    const B = regionBounds(world);
    const W = B.maxX - B.minX, D = B.maxZ - B.minZ;
    const NX = N_X, NZ = Math.round(N_X * D / W);
    const cx = W / NX, cz = D / NZ;
    const hts = new Float32Array(NX * NZ);
    const wat = new Uint8Array(NX * NZ);
    const hasWater = typeof world.isWater === 'function';
    let row = 0, hmin = Infinity, hmax = -Infinity;
    const sample = () => {
      const t0 = performance.now();
      while (row < NZ && performance.now() - t0 < BUDGET) {
        const z = B.minZ + (row + 0.5) * cz;
        for (let i = 0; i < NX; i++) {
          const x = B.minX + (i + 0.5) * cx;
          let h = 0, w = false;
          try {
            h = world.getGroundHeight(x, z);
            w = hasWater ? !!world.isWater(x, z) : false;
          } catch { /* keep defaults */ }
          if (!Number.isFinite(h)) h = 0;
          hts[row * NX + i] = h;
          wat[row * NX + i] = w ? 1 : 0;
          if (h < hmin) hmin = h;
          if (h > hmax) hmax = h;
        }
        row++;
      }
      if (row < NZ) { setTimeout(sample, 16); return; }
      const dist = shoreDistance(wat, NX, NZ);
      paint(hts, wat, dist, NX, NZ, cx, cz, (canvas) => {
        if (!baked) { img = canvas; bounds = B; }
      building = false;
        // a flat stub terrain (no relief, no water) is probably a placeholder: re-sample later
        flatRetry = hmax - hmin < 0.5 && !wat.some((v) => v) ? performance.now() + 30000 : 0;
      });
    };
    setTimeout(sample, delay);
  }

  // two-pass chamfer distance (in pixels, capped) from every water pixel to the nearest land pixel
  function shoreDistance(wat, NX, NZ) {
    const d = new Uint8Array(NX * NZ);
    const CAP = 6;
    for (let k = 0; k < d.length; k++) d[k] = wat[k] ? CAP : 0;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i > 0 && d[k - 1] + 1 < v) v = d[k - 1] + 1;
      if (j > 0 && d[k - NX] + 1 < v) v = d[k - NX] + 1;
      d[k] = v;
    }
    for (let j = NZ - 1; j >= 0; j--) for (let i = NX - 1; i >= 0; i--) {
      const k = j * NX + i;
      if (!d[k]) continue;
      let v = d[k];
      if (i < NX - 1 && d[k + 1] + 1 < v) v = d[k + 1] + 1;
      if (j < NZ - 1 && d[k + NX] + 1 < v) v = d[k + NX] + 1;
      d[k] = v;
    }
    return d;
  }

  function paint(hts, wat, dist, NX, NZ, cx, cz, done) {
    const c = document.createElement('canvas');
    c.width = NX; c.height = NZ;
    const g = c.getContext('2d');
    const im = g.createImageData(NX, NZ);
    const d = im.data;
    const stops = [[0, 58, 68, 74], [40, 62, 72, 76], [150, 74, 82, 80], [300, 92, 96, 90], [550, 118, 118, 110], [900, 156, 154, 146]];
    const ramp = (h, out) => {
      if (h <= stops[0][0]) { out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3]; return; }
      for (let k = 1; k < stops.length; k++) {
        if (h <= stops[k][0] || k === stops.length - 1) {
          const a = stops[k - 1], b = stops[k];
          const t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
          out[0] = a[1] + (b[1] - a[1]) * t; out[1] = a[2] + (b[2] - a[2]) * t; out[2] = a[3] + (b[3] - a[3]) * t;
          return;
        }
      }
    };
    const rgb = [0, 0, 0];
    const L = [-0.55, 0.62, -0.55];      // light from the north-west
    const Ln = Math.hypot(...L);
    let j = 0;
    const slice = () => {
      const t0 = performance.now();
      while (j < NZ && performance.now() - t0 < BUDGET) {
        for (let i = 0; i < NX; i++) {
          const k = j * NX + i, p = k * 4;
          if (wat[k]) {
            const shore = clamp(1 - (dist[k] - 1) / 5, 0, 1);
            d[p] = 10 + 16 * shore; d[p + 1] = 26 + 30 * shore; d[p + 2] = 46 + 40 * shore; d[p + 3] = 255;
            continue;
          }
          const h = hts[k];
          const hx = (hts[j * NX + Math.min(NX - 1, i + 1)] - hts[j * NX + Math.max(0, i - 1)]) / (2 * cx);
          const hz = (hts[Math.min(NZ - 1, j + 1) * NX + i] - hts[Math.max(0, j - 1) * NX + i]) / (2 * cz);
          const nx = -hx * 2.5, nz = -hz * 2.5, inv = 1 / Math.hypot(nx, 1, nz);
          const shade = clamp(0.35 + 0.65 * ((nx * L[0] + L[1] + nz * L[2]) * inv) / (L[1] / Ln) / Ln, 0.55, 1.4);
          let coast = false;
          if (i > 0 && i < NX - 1 && j > 0 && j < NZ - 1) coast = wat[k - 1] || wat[k + 1] || wat[k - NX] || wat[k + NX];
          if (coast) { d[p] = 120; d[p + 1] = 160; d[p + 2] = 186; d[p + 3] = 255; continue; }
          ramp(h, rgb);
          d[p] = clamp(rgb[0] * shade, 0, 255);
          d[p + 1] = clamp(rgb[1] * shade, 0, 255);
          d[p + 2] = clamp(rgb[2] * shade, 0, 255);
          d[p + 3] = 255;
        }
        j++;
      }
      if (j < NZ) { setTimeout(slice, 16); return; }
      g.putImageData(im, 0, 0);
      done(c);
    };
    slice();
  }

  function maybeRebuild(world, f) {
    if (baked || !world || building) return;
    const now = performance.now();
    const px = f.position.x, pz = f.position.z;
    // first build a moment after the flight starts (nearby terrain LODs settle), refresh once streaming has caught up
    if (!img || builtFor !== world) { build(world, px, pz, builtFor ? 120 : 2500); nextBuild = now + 22000; return; }
    if (flatRetry && now > flatRetry) { flatRetry = 0; build(world, px, pz); return; }
    const moved = Math.hypot(px - builtAt.x, pz - builtAt.z);
    if ((nextBuild && now > nextBuild) || moved > 7000) { nextBuild = 0; build(world, px, pz); }
  }

  function runwaysOf(world) {
    const rw = (world && world.runways) || shared.runways;
    return rw && Array.isArray(rw.airports) ? rw.airports : [];
  }
  function landmarksOf(world) {
    const lm = world && world.landmarks;
    return lm && Array.isArray(lm.landmarks) ? lm.landmarks : [];
  }

  /**
   * Draw into ctx (already scaled to CSS px) a M×M map centred on the aircraft.
   * f: flight state (position, heading deg, velocity); hdg: heading in degrees.
   */
  function draw(ctx, M, f, world, hdg, pulse) {
    maybeRebuild(world, f);
    const now = performance.now();
    const dt = clamp((now - lastT) / 1000, 0, 0.2);
    lastT = now;
    const gs = f.velocity ? Math.hypot(f.velocity.x, f.velocity.z) : (f.airspeed || 0);
    const target = clamp(5200 + gs * KT * 24, 5200, 24000);
    span += (target - span) * (1 - Math.exp(-dt * 0.8));

    const px = f.position.x, pz = f.position.z;
    const sc = M / span;
    const X = (x) => M / 2 + (x - px) * sc, Y = (z) => M / 2 + (z - pz) * sc;

    ctx.fillStyle = '#0c1d31';
    ctx.fillRect(0, 0, M, M);
    if (img && bounds) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, X(bounds.minX), Y(bounds.minZ), (bounds.maxX - bounds.minX) * sc, (bounds.maxZ - bounds.minZ) * sc);
    } else {
      ctx.font = `600 10px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(200,216,236,0.45)'; ctx.fillText('Harita hazırlanıyor…', M / 2, M / 2 + 26);
    }
    // 2 km grid
    const grid = span > 14000 ? 5000 : 2000;
    ctx.beginPath();
    for (let x = Math.ceil((px - span / 2) / grid) * grid; x < px + span / 2; x += grid) { ctx.moveTo(X(x), 0); ctx.lineTo(X(x), M); }
    for (let z = Math.ceil((pz - span / 2) / grid) * grid; z < pz + span / 2; z += grid) { ctx.moveTo(0, Y(z)); ctx.lineTo(M, Y(z)); }
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.stroke();

    // bridges
    ctx.lineCap = 'round';
    for (const br of BRIDGES) {
      ctx.beginPath(); ctx.moveTo(X(br.a[0]), Y(br.a[1])); ctx.lineTo(X(br.b[0]), Y(br.b[1]));
      ctx.lineWidth = Math.max(2, 27 * sc); ctx.strokeStyle = 'rgba(255,122,74,0.85)'; ctx.stroke();
    }
    // runways
    const apts = runwaysOf(world);
    ctx.lineCap = 'butt';
    for (const a of apts) for (const r of a.runways || []) {
      const [e0, e1] = r.ends || [];
      if (!e0 || !e1) continue;
      ctx.beginPath(); ctx.moveTo(X(e0.x), Y(e0.z)); ctx.lineTo(X(e1.x), Y(e1.z));
      const w = Math.max(2.2, r.width * sc);
      ctx.lineWidth = w + 2; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
      ctx.lineWidth = w; ctx.strokeStyle = a.military ? '#cfe3ff' : '#e9eef5'; ctx.stroke();
    }
    // landmark + airport labels: kept fully inside the map (flipped / nudged inward, dropped when they don't fit),
    // clear of the north marker (top centre) and the scale bar (bottom right)
    const PAD = 4;
    const reserved = [[M / 2 - 10, 0, M / 2 + 10, 18], [M - 64, M - 30, M, M]];
    const placed = [];
    const hits = (x0, y0, x1, y1) => reserved.some((r) => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1])
      || placed.some((r) => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
    const label = (str, ax, ay, prefer, color, halo) => {
      const w = ctx.measureText(str).width, h = 11;
      const cands = prefer === 'center'
        ? [[clamp(ax - w / 2, PAD, M - PAD - w), ay]]
        : [[ax + 5, ay], [ax - 5 - w, ay]];                       // right of the dot, else flipped to the left
      for (const [x0, cy] of cands) {
        const y0 = cy - h / 2;
        if (x0 < PAD || x0 + w > M - PAD || y0 < PAD || y0 + h > M - PAD) continue;
        if (hits(x0, y0, x0 + w, y0 + h)) continue;
        placed.push([x0, y0, x0 + w, y0 + h]);
        ctx.textAlign = 'left';
        ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(str, x0, cy);
        ctx.fillStyle = color; ctx.fillText(str, x0, cy);
        return;
      }
    };
    ctx.textBaseline = 'middle';
    // airports first (they win the space)
    ctx.font = `700 10.5px ${SANS}`;
    for (const a of apts) {
      const c = a.center || (a.runways && a.runways[0] && a.runways[0].center);
      if (!c) continue;
      const x = X(c.x), y = Y(c.z);
      if (x < -20 || x > M + 20 || y < -20 || y > M + 20) continue;
      const code = (AIRPORTS[a.icao] && AIRPORTS[a.icao].code) || a.icao;
      label(code, x, y - 16 * Math.min(1, 9000 / span) - 6, 'center', '#5cf2c8', 'rgba(6,12,22,0.75)');
    }
    ctx.font = `600 9.5px ${SANS}`;
    for (const l of landmarksOf(world)) {
      if (!SHOW_LANDMARKS.includes(l.id)) continue;
      const x = X(l.x), y = Y(l.z);
      if (x < 2 || x > M - 2 || y < 2 || y > M - 2) continue;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,190,150,0.85)'; ctx.fill();
      if (span < 12500) label(LANDMARK_NAMES[l.id] || l.name, x, y, 'side', 'rgba(255,214,190,0.8)', 'rgba(6,12,22,0.7)');
    }

    // track line (where the velocity vector points)
    if (f.velocity && gs > 3) {
      const vx = f.velocity.x / gs, vz = f.velocity.z / gs;
      ctx.beginPath(); ctx.moveTo(M / 2, M / 2); ctx.lineTo(M / 2 + vx * M * 0.7, M / 2 + vz * M * 0.7);
      ctx.setLineDash([3, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(92,242,200,0.55)'; ctx.stroke(); ctx.setLineDash([]);
    }
    // aircraft arrow
    ctx.save();
    ctx.translate(M / 2, M / 2);
    ctx.rotate(hdg * DEG);
    ctx.beginPath();
    ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();

    // north + scale bar
    ctx.font = `800 10.5px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText('K', M / 2, 10);
    ctx.fillStyle = '#ff9a6a'; ctx.fillText('K', M / 2, 10);
    const bar = span > 15000 ? 5000 : span > 7000 ? 2000 : 1000;
    const bw = bar * sc;
    ctx.beginPath();
    ctx.moveTo(M - 10 - bw, M - 10); ctx.lineTo(M - 10, M - 10);
    ctx.moveTo(M - 10 - bw, M - 13); ctx.lineTo(M - 10 - bw, M - 7);
    ctx.moveTo(M - 10, M - 13); ctx.lineTo(M - 10, M - 7);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.font = `700 9.5px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,12,22,0.75)'; ctx.strokeText(`${bar / 1000} km`, M - 10, M - 21);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(`${bar / 1000} km`, M - 10, M - 21);
    return pulse;
  }

  return { draw, get ready() { return !!img; } };
}
