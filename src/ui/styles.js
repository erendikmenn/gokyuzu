// CSS injection (synchronous, so the first frame of the menu / loading screen is already styled).
const injected = new Set();

export function injectCSS(id, css) {
  if (injected.has(id) || typeof document === 'undefined') return;
  injected.add(id);
  const style = document.createElement('style');
  style.dataset.gk = id;
  style.textContent = css;
  document.head.appendChild(style);
}

// Shared design tokens for every UI surface.
export const BASE_CSS = `
:root {
  --gk-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --gk-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --gk-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --gk-orange: #ff6b3d;
  --gk-orange-2: #ffa24a;
  --gk-teal: #5cf2c8;
  --gk-fg: rgba(240, 246, 255, 0.97);
  --gk-dim: rgba(208, 222, 240, 0.64);
  --gk-faint: rgba(208, 222, 240, 0.36);
  --gk-line: rgba(255, 255, 255, 0.12);
  --gk-warn: #ff4d4f;
  --gk-caution: #ffb020;
}
.gk-keys { display: inline-flex; flex-wrap: nowrap; justify-content: flex-end; gap: 4px; align-items: center; white-space: nowrap; }
.gk-keys kbd, kbd.gk-kbd {
  font-family: var(--gk-sans); font-size: 12px; font-weight: 600; line-height: 1.2;
  min-width: 14px; text-align: center; padding: 3px 7px; border-radius: 6px;
  color: var(--gk-fg); background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.16); border-bottom-width: 2px;
}
.gk-keys .gk-or { color: var(--gk-faint); font-size: 11px; }
.gk-keys .gk-dot { color: var(--gk-faint); font-size: 14px; margin: 0 3px; }
`;
