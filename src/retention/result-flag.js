// "A result is on screen" signal for the rest of the HUD: <html class="gk-result-open"> while a challenge result (the
// free-flight panel's result view, or its compact result card on phones) or a mission result card is open. Other HUD
// parts check it before showing something of their own (the assisted-flight tip, src/ui/assist-hud.js: wait while it is
// set), and the landing score card (src/ui/landing.js) hides behind it so a result never stacks on top of the card.
//
//   setResultOpen(source, on)   source: 'ffc' | 'mission' (each owner sets and clears its own)
//   resultOpen() → boolean      the same as document.documentElement.classList.contains('gk-result-open')
const CLS = 'gk-result-open';
const open = new Set();
let styled = false;

export function setResultOpen(source, on) {
  if (typeof document === 'undefined') return;
  if (on) open.add(source); else open.delete(source);
  if (!styled) {
    styled = true;
    const st = document.createElement('style');
    st.dataset.gk = 'result-open';
    // the landing card steps aside while a result is open (the result carries the landing's rows)
    st.textContent = `html.${CLS} .gkls-card { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }`;
    document.head.appendChild(st);
  }
  document.documentElement.classList.toggle(CLS, open.size > 0);
}

export const resultOpen = () => typeof document !== 'undefined' && document.documentElement.classList.contains(CLS);
