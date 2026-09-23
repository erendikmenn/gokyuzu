// Small shared helpers for the UI modules (DOM building, math, formatting, key chips).

export const KT = 1.943844;     // m/s → knots
export const FT = 3.28084;      // m → feet
export const FPM = FT * 60;     // m/s → ft/min
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Frame-rate independent smoothing factor for exponential approach at `rate` 1/s. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function svgEl(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

/** Turkish number formatting: thousands with a dot, decimals with a comma. */
export function fmtInt(v) {
  const n = Math.round(v);
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return n < 0 ? `−${s}` : s;
}
export function fmtDec(v, digits = 1) {
  return v.toFixed(digits).replace('.', ',').replace('-', '−');
}
export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (m >= 10000) return `${fmtInt(m / 1000)} km`;
  if (m >= 1000) return `${fmtDec(m / 1000, 1)} km`;
  return `${Math.round(m / 10) * 10} m`;
}

// ---------- key chips (help / pause / menu) ----------
// binding key strings look like "W / S  ·  ↑ / ↓", "B / Boşluk", "F1 / ?", "1 … 9  ·  0", "Oyun kolu"
export function keyGroups(keys) {
  const str = String(keys ?? '').trim();
  if (!str) return [];
  // "A, B" separates groups; a lone "," is the comma key itself (the camera keys "C  ·  , / .")
  return str.split(/\s*·\s*|(?<=\S)\s*,\s+|\s+veya\s+/i).filter(Boolean).map((g) => {
    let parts = g.split(/\s+\/\s+/);
    if (parts.length === 1 && g.length > 1 && g.length <= 5 && g.includes('/')) {
      const p = g.split('/');
      if (p.every((x) => x.length > 0)) parts = p;
    }
    return parts.map((x) => x.trim()).filter(Boolean);
  });
}

export function keyChips(parent, keys, cls = 'gk-keys') {
  const wrap = el('span', cls, parent);
  keyGroups(keys).forEach((grp, gi) => {
    if (gi) el('span', 'gk-dot', wrap, '·');
    grp.forEach((k, i) => {
      if (i) el('span', 'gk-or', wrap, '/');
      el('kbd', null, wrap, k);
    });
  });
  return wrap;
}

/**
 * Text with inline key chips: "{X} tuşunu basılı tut" → "X" in a <kbd class="gk-kbd gk-ikbd">, the rest as text nodes.
 * Replaces the children of `parent` (call it when the text changes, not every frame).
 */
export function richText(parent, str) {
  parent.textContent = '';
  const s = String(str ?? '');
  let i = 0;
  for (const m of s.matchAll(/\{([^{}]+)\}/g)) {
    if (m.index > i) parent.append(s.slice(i, m.index));
    el('kbd', 'gk-kbd gk-ikbd', parent, m[1]);
    i = m.index + m[0].length;
  }
  if (i < s.length) parent.append(s.slice(i));
  return parent;
}
/** The same text without the chip braces (aria labels, logs). */
export const plainText = (str) => String(str ?? '').replace(/\{([^{}]+)\}/g, '$1');

/** Map a human key label ("P", "Esc", "F1", "Boşluk") to a KeyboardEvent.code. */
export function codeForKeyLabel(label) {
  const k = String(label || '').trim();
  if (/^[A-Za-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  if (/^F\d{1,2}$/i.test(k)) return k.toUpperCase();
  const map = { esc: 'Escape', escape: 'Escape', 'boşluk': 'Space', space: 'Space', tab: 'Tab', enter: 'Enter', shift: 'ShiftLeft', ctrl: 'ControlLeft' };
  return map[k.toLowerCase()] || null;
}

/** Fire a synthetic key press on window (used by clickable buttons that mirror keyboard actions). */
export function pressKey(code) {
  if (!code) return;
  const opts = { code, key: code.replace(/^Key|^Digit/, ''), bubbles: true };
  window.dispatchEvent(new KeyboardEvent('keydown', opts));
  setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', opts)), 60);
}

/** Resolve a repo-root-relative path (e.g. 'renders/aircraft/f16/thumb.jpg') independent of the page location. */
export function rootUrl(path) {
  if (!path) return null;
  if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
  return new URL(`../../${path.replace(/^\.\//, '')}`, import.meta.url).href;
}

export function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
