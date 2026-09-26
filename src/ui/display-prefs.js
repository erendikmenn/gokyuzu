// Warning display preferences for canvas-drawn instruments (src/avionics): cheap per-frame reads of the classes that
// src/ui/settings-live.js puts on <html> from settings.alerts (src/core/settings.js). No imports, no side effects.
//   reducedFlash()    alerts.reduceFlash: draw warnings steady instead of blinking
//   warningTextsOn()  alerts.hud: warning texts wanted on the HUD (the cockpit instruments keep theirs)
const root = () => (typeof document !== 'undefined' ? document.documentElement : null);
export const reducedFlash = () => { const r = root(); return !!(r && r.classList.contains('gk-calm')); };
export const warningTextsOn = () => { const r = root(); return !(r && r.classList.contains('gk-no-warntext')); };
