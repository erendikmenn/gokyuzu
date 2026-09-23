// Canvas drawing shared by the navigation map (src/ui/map.js) and the HUD minimap overlay: the route (legs,
// waypoints, approach points), the aircraft symbol and its track trail. Coordinates go through projection closures
// X(x) / Y(z) (local meters → CSS px), so both maps keep their own view. No allocations per call.

export const ROUTE_COLOR = '#ff6ee7';          // magenta: the route (HUD / avionics convention)
export const ROUTE_DIM = 'rgba(255,110,231,0.34)';
export const LOW_COLOR = '#ffb020';            // amber: a leg below terrain / obstacle clearance
const HALO = 'rgba(4,8,16,0.72)';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

// plane silhouette (24×24, nose up) — same shape as the menu map's spawn markers
const PLANE = typeof Path2D !== 'undefined'
  ? new Path2D('M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z')
  : null;
const HELI = typeof Path2D !== 'undefined'
  ? new Path2D('M12 3.2a2.3 2.3 0 0 0-2.3 2.3v6.6c0 1.6.9 2.9 2.3 3.3v5.1h-1.2v1.3h2.4v-1.3H12m0 0v-5.1c1.4-.4 2.3-1.7 2.3-3.3V5.5A2.3 2.3 0 0 0 12 3.2z M3 8.4h18v1.1H3z M11.4 19.2h1.2v2.6h-1.2z')
  : null;

/** Turkish thousands separator (4.500). */
export function fmtFt(m) {
  const n = Math.round((m / 0.3048) / 10) * 10;
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// label placement among the route's own labels (right, left, below, above the point); rects reused across calls
const RECTS = new Float64Array(4 * 96);
let nRects = 0;
function freeSpot(x0, y0, x1, y1) {
  for (let k = 0; k < nRects; k++) {
    const o = k * 4;
    if (x0 < RECTS[o + 2] && x1 > RECTS[o] && y0 < RECTS[o + 3] && y1 > RECTS[o + 1]) return false;
  }
  return true;
}
function reserve(x0, y0, x1, y1) { if (nRects < 96) { const o = nRects * 4; RECTS[o] = x0; RECTS[o + 1] = y0; RECTS[o + 2] = x1; RECTS[o + 3] = y1; nRects++; } }

/**
 * Route overlay. opts: { big (labels, symbols), selectedId, hoverId, low (Uint8Array|array per waypoint index: leg
 * into it is too low), speedText(w) → "250 kt" for the labels }.
 */
export function drawRoute(ctx, route, X, Y, opts = {}) {
  if (!route || !route.waypoints.length) return;
  const W = route.waypoints, big = !!opts.big;
  const act = route.hasActive ? route.active : W.length;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // extended centreline of the approach runway (dashed), from the threshold out past the IF
  const A = route.approach;
  if (A && big) {
    const rw = A.rw, len = 11 * 1852;
    ctx.beginPath();
    ctx.moveTo(X(rw.x), Y(rw.z)); ctx.lineTo(X(rw.x - rw.dx * len), Y(rw.z - rw.dz * len));
    ctx.setLineDash([10, 8]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(236,244,255,0.55)'; ctx.stroke(); ctx.setLineDash([]);
  }
  // legs: done (dim, dashed), active (thick), ahead
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < W.length; i++) {
      let ax, az;
      if (i === 0) { if (!(act === 0 && route.hasActive)) continue; ax = route.origin.x; az = route.origin.z; }
      else { ax = W[i - 1].x; az = W[i - 1].z; }
      const done = i < act, active = i === act;
      ctx.beginPath(); ctx.moveTo(X(ax), Y(az)); ctx.lineTo(X(W[i].x), Y(W[i].z));
      const low = opts.low && opts.low[i];
      if (pass === 0) {
        if (done) continue;
        ctx.lineWidth = (active ? 5.5 : 4.5) * (big ? 1 : 0.7); ctx.strokeStyle = HALO; ctx.stroke();
      } else {
        if (done) { ctx.setLineDash(big ? [6, 6] : [3, 4]); ctx.lineWidth = big ? 2 : 1.4; ctx.strokeStyle = ROUTE_DIM; ctx.stroke(); ctx.setLineDash([]); continue; }
        ctx.lineWidth = (active ? 3.2 : 2.3) * (big ? 1 : 0.75);
        ctx.strokeStyle = low ? LOW_COLOR : ROUTE_COLOR;
        ctx.stroke();
      }
    }
  }
  // waypoints (their symbols block label space)
  nRects = 0;
  if (big) for (let i = 0; i < W.length; i++) { const x = X(W[i].x), y = Y(W[i].z); reserve(x - 11, y - 11, x + 11, y + 11); }
  for (let i = 0; i < W.length; i++) {
    const w = W[i], x = X(w.x), y = Y(w.z);
    const done = i < act, active = i === act;
    if (!big) {
      ctx.beginPath(); ctx.arc(x, y, active ? 3.6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = done ? ROUTE_DIM : active ? ROUTE_COLOR : '#1a0f1c'; ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = done ? ROUTE_DIM : ROUTE_COLOR; ctx.stroke();
      continue;
    }
    const sel = opts.selectedId === w.id, hov = opts.hoverId === w.id;
    if (w.kind === 'wpt') {
      const r = sel || hov ? 11 : 9.5;
      ctx.beginPath(); ctx.arc(x, y, r + 2.2, 0, Math.PI * 2); ctx.fillStyle = HALO; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = active ? ROUTE_COLOR : done ? 'rgba(60,40,62,0.9)' : 'rgba(26,14,30,0.94)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = done ? ROUTE_DIM : ROUTE_COLOR; ctx.stroke();
      ctx.font = `800 ${w.name.length > 1 ? 10.5 : 11.5}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = active ? '#1a0716' : done ? 'rgba(255,220,250,0.55)' : '#ffe6fb'; ctx.fillText(w.name, x, y + 0.5);
    } else if (w.kind === 'thr') {
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y + 5); ctx.lineTo(x - 7, y + 5); ctx.closePath();
      ctx.lineWidth = 3.5; ctx.strokeStyle = HALO; ctx.stroke();
      ctx.fillStyle = done ? ROUTE_DIM : ROUTE_COLOR; ctx.fill();
    } else {
      // approach fix: diamond (hover point: circle with a cross)
      const r = sel || hov ? 9.5 : 8;
      ctx.beginPath();
      if (w.kind === 'hov') ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
      else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
      ctx.lineWidth = 4.5; ctx.strokeStyle = HALO; ctx.stroke();
      ctx.fillStyle = active ? ROUTE_COLOR : 'rgba(26,14,30,0.94)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = done ? ROUTE_DIM : ROUTE_COLOR; ctx.stroke();
      if (w.kind === 'hov') { ctx.beginPath(); ctx.moveTo(x - 3.5, y); ctx.lineTo(x + 3.5, y); ctx.moveTo(x, y - 3.5); ctx.lineTo(x, y + 3.5); ctx.lineWidth = 1.6; ctx.strokeStyle = active ? '#1a0716' : ROUTE_COLOR; ctx.stroke(); }
    }
    if (sel) { ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(); }
    // label: name (approach fixes) + altitude
    const alt = w.kind === 'thr' ? null : route.altFor(w);
    const name = w.kind === 'wpt' ? '' : w.kind === 'thr' ? '' : w.name;
    const spdStr = opts.speedText ? opts.speedText(w) : '';
    const altStr = alt != null ? `${fmtFt(alt)} ft${spdStr ? ` · ${spdStr}` : ''}` : spdStr;
    if (!name && !altStr) continue;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `800 11px ${SANS}`;
    const wN = name ? ctx.measureText(name).width : 0;
    ctx.font = `650 10.5px ${MONO}`;
    const wA = altStr ? ctx.measureText(altStr).width : 0;
    const bw = Math.max(wN, wA), bh = name && altStr ? 26 : 13;
    // right, left, below, above
    let bx = x + 15, by = y - bh / 2;
    const VW = opts.width || Infinity, VH = opts.height || Infinity;   // keep labels inside the map
    for (let c = 0; c < 4; c++) {
      const cx = c === 0 ? x + 15 : c === 1 ? x - 15 - bw : x - bw / 2;
      const cy = c < 2 ? y - bh / 2 : c === 2 ? y + 14 : y - 14 - bh;
      if (cx < 4 || cx + bw > VW - 4 || cy < 4 || cy + bh > VH - 4) continue;
      if (freeSpot(cx, cy, cx + bw, cy + bh)) { bx = cx; by = cy; break; }
    }
    reserve(bx, by, bx + bw, by + bh);
    let ty = by + 6.5;
    ctx.lineWidth = 3.2; ctx.strokeStyle = HALO;
    if (name) {
      ctx.font = `800 11px ${SANS}`;
      ctx.strokeText(name, bx, ty); ctx.fillStyle = done ? ROUTE_DIM : '#ffc6f5'; ctx.fillText(name, bx, ty);
      ty += 13;
    }
    if (altStr) {
      ctx.font = `650 10.5px ${MONO}`;
      ctx.strokeText(altStr, bx, ty); ctx.fillStyle = done ? 'rgba(236,244,255,0.4)' : (opts.low && opts.low[i]) ? LOW_COLOR : 'rgba(236,244,255,0.86)'; ctx.fillText(altStr, bx, ty);
    }
  }
  ctx.restore();
}

/** Aircraft symbol at (x, y) CSS px, heading in degrees; heli = helicopter silhouette. */
export function drawAircraft(ctx, x, y, hdgDeg, size = 26, heli = false) {
  const p = heli ? HELI : PLANE;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((hdgDeg * Math.PI) / 180);
  const k = size / 24;
  ctx.scale(k, k);
  ctx.translate(-12, -12);
  if (p) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.4 / k; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke(p);
    ctx.fillStyle = '#ffffff'; ctx.fill(p);
  } else {
    ctx.beginPath(); ctx.moveTo(12, 2); ctx.lineTo(19, 20); ctx.lineTo(12, 16); ctx.lineTo(5, 20); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
  }
  ctx.restore();
}

const TRAIL_COLORS = ['rgba(92,242,200,0.2)', 'rgba(92,242,200,0.34)', 'rgba(92,242,200,0.5)', 'rgba(92,242,200,0.72)'];
/**
 * Track trail: ring buffer of positions (Float32Array [x0, z0, x1, z1, …]), `count` valid points ending at index
 * `head` (exclusive). Drawn oldest → newest with fading alpha, in 4 alpha bands (4 strokes).
 */
export function drawTrail(ctx, buf, head, count, cap, X, Y, width = 2.4) {
  if (count < 2) return;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const bands = TRAIL_COLORS.length;
  for (let b = 0; b < bands; b++) {
    const i0 = Math.floor((count * b) / bands), i1 = Math.min(count - 1, Math.floor((count * (b + 1)) / bands));
    if (i1 <= i0) continue;
    ctx.beginPath();
    for (let k = i0; k <= i1; k++) {
      const idx = (head - count + k + cap) % cap;
      const px = X(buf[idx * 2]), py = Y(buf[idx * 2 + 1]);
      if (k === i0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineWidth = width; ctx.strokeStyle = TRAIL_COLORS[b];
    ctx.stroke();
  }
  ctx.restore();
}
