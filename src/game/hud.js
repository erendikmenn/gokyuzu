// STUB: replaced by Agent D.
export function createHUD(container) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;left:16px;top:16px;color:#fff;font:14px monospace;text-shadow:0 1px 2px #000';
  const msg = document.createElement('div');
  msg.style.cssText = 'position:absolute;left:50%;top:30%;transform:translateX(-50%);color:#fff;font:bold 28px sans-serif;text-shadow:0 2px 6px #000';
  container.append(el, msg);
  let t;
  return {
    update(f, m) { el.textContent = `HIZ ${(f.airspeed * 1.944).toFixed(0)} kt  İRTİFA ${(f.altitude * 3.281).toFixed(0)} ft  YÖN ${f.heading.toFixed(0)}°  GAZ ${(f.throttle * 100).toFixed(0)}%`; },
    showMessage(text, ms = 1500) { msg.textContent = text; clearTimeout(t); t = setTimeout(() => (msg.textContent = ''), ms); },
    setVisible(v) { container.style.display = v ? '' : 'none'; },
    showHelp() {}, setPaused() {},
  };
}
