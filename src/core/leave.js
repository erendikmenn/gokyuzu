// Leaving the game: an accidental tab close / reload during a flight asks for confirmation first; the game's own
// "back to menu" navigation goes through goToMenu() and is not asked about.
import { clearResume } from './gpu-resume.js';

let intentional = false;

export function goToMenu() {
  intentional = true;
  clearResume();   // an intentional exit is never resumed as if the tab had crashed (src/core/gpu-resume.js)
  location.href = location.pathname;
}

export function guardUnload(isFlying) {
  window.addEventListener('beforeunload', (e) => {
    if (intentional || !isFlying()) return;
    e.preventDefault();
    e.returnValue = '';   // older Safari / Chrome need a value to show the dialog
  });
}
