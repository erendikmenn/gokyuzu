// Leaving the game: an accidental tab close / reload during a flight asks for confirmation first; the game's own
// "back to menu" navigation goes through goToMenu() and is not asked about.
import { clearResume } from './gpu-resume.js';
import { activeMap, rememberMap } from '../maps/index.js';

let intentional = false;

export function goToMenu() {
  intentional = true;
  clearResume();   // an intentional exit is never resumed as if the tab had crashed (src/core/gpu-resume.js)
  // the menu opens on the map just flown: a deep link (?mission=ist-…, a challenge link) chooses the map without the
  // menu's stored choice, and "Menü" used to come back to the San Francisco menu
  try { rememberMap(activeMap().id); } catch { /* ignore */ }
  location.href = location.pathname;
}

export function guardUnload(isFlying) {
  window.addEventListener('beforeunload', (e) => {
    if (intentional || !isFlying()) return;
    e.preventDefault();
    e.returnValue = '';   // older Safari / Chrome need a value to show the dialog
  });
}
