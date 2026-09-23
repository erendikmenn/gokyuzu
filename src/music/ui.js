// Music controls for the game UI (src/music/index.js player, created by main.js):
//  - mountPauseMusic(parent, before): compact control on the pause screen — on/off, current track, next
//  - mountNowPlaying(parent): "Şimdi çalıyor" row with a next button for the Ayarlar panel
//  - musicPreview(): lets the music be heard while the game is paused (the Ayarlar toggles call it)
// The on/off switch writes musicMenu / musicFlight through src/core/settings.js (the player follows the settings event).
import { getMusicPlayer, onMusicPlayer } from './index.js';
import { loadSettings, saveSettings } from '../core/settings.js';

const CSS = `
.gkm-ctl { display: flex; align-items: center; gap: 12px; padding: 7px 8px 7px 14px; border-radius: 12px; pointer-events: auto;
  background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .11); font: 600 13px var(--gk-sans); color: var(--gk-dim); }
.gkm-ctl[hidden] { display: none; }
.gkm-ctl .gkm-ic { color: var(--gk-teal); font-size: 15px; line-height: 1; }
.gkm-ctl .gkm-t { min-width: 118px; max-width: 220px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--gk-fg); font-weight: 600; }
.gkm-ctl .gkm-t.off { color: var(--gk-dim); font-weight: 500; }
.gkm-sw { position: relative; flex: 0 0 auto; width: 38px; height: 22px; border-radius: 11px; border: 0; padding: 0; cursor: pointer;
  background: rgba(255, 255, 255, .16); transition: background .15s; }
.gkm-sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
  transition: transform .18s cubic-bezier(.2, .9, .3, 1.2); }
.gkm-sw[aria-checked="true"] { background: var(--gk-teal); }
.gkm-sw[aria-checked="true"]::after { transform: translateX(16px); }
.gkm-sw:focus-visible, .gkm-next:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gkm-next { display: flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 9px; cursor: pointer; font: 650 12.5px var(--gk-sans);
  color: var(--gk-fg); background: rgba(255, 255, 255, .07); border: 1px solid rgba(255, 255, 255, .14); transition: background .15s; }
.gkm-next:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }
.gkm-next:disabled { opacity: .4; cursor: default; }
.gkm-next svg { width: 13px; height: 13px; }
.gkm-np { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 14px; }
.gkm-np span { color: rgba(236, 244, 255, .9); }
.gkm-np b { font-weight: 650; color: var(--gk-fg); }
.gkm-np em { font-style: normal; color: var(--gk-dim); }
`;
const NEXT_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 3.5 7.2 8 1 12.5zM7 3.5 13.2 8 7 12.5z"/><rect x="13.2" y="3.5" width="1.8" height="9" rx=".5"/></svg>';

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const st = document.createElement('style');
  st.dataset.gk = 'music';
  st.textContent = CSS;
  document.head.append(st);
}

function mk(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
}

/** Player state text: the track, or why nothing plays. */
function label(s) {
  if (!s.supported) return ['Bu tarayıcı müzik dosyalarını çalamıyor', true];
  if (!s.enabled) return ['Kapalı', true];
  if (s.track) return [s.track.title, false];
  return ['Açık', false];
}

/** Keep a control in sync with the player until it leaves the page. */
function follow(root, player, render) {
  render(player.state);
  const off = player.on((s) => { if (!root.isConnected && root.dataset.mounted) { off(); return; } render(s); });
  requestAnimationFrame(() => { root.dataset.mounted = '1'; });
}

/**
 * Pause-screen control: [♪ Müzik (switch)] [track] [Sonraki]. The switch turns music on/off for the current context
 * (in flight: musicFlight) and lets it play while paused. Hidden until main.js has created the player.
 */
export function mountPauseMusic(parent, before = null) {
  if (!parent) return null;
  inject();
  const root = mk('div', 'gkm-ctl');
  root.hidden = true;
  parent.insertBefore(root, before);
  onMusicPlayer((player) => { root.hidden = false; bindPause(root, player); });
  return root;
}

function bindPause(root, player) {
  root.setAttribute('lang', 'tr');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Müzik');
  mk('span', 'gkm-ic', root, '♪');
  mk('span', null, root, 'Müzik');
  const sw = mk('button', 'gkm-sw', root);
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Müzik açık');
  const title = mk('span', 'gkm-t', root);
  const next = mk('button', 'gkm-next', root);
  next.type = 'button';
  next.innerHTML = NEXT_SVG;
  next.append('Sonraki');
  next.title = 'Sonraki parça';
  sw.addEventListener('click', () => {
    const s = player.state;
    const key = s.context === 'menu' ? 'musicMenu' : 'musicFlight';
    player.preview();
    saveSettings({ ...loadSettings(), [key]: !s.enabled });
    sw.blur();   // keys go back to the game (Space etc.)
  });
  next.addEventListener('click', () => { player.next(); next.blur(); });
  follow(root, player, (s) => {
    sw.setAttribute('aria-checked', String(!!s.enabled));
    sw.disabled = !s.supported;
    const [text, off] = label(s);
    title.textContent = text;
    title.classList.toggle('off', off);
    title.title = text;
    next.disabled = !s.enabled || !s.supported;
  });
}

/** "Şimdi çalıyor: <track>" + next button (Ayarlar panel, under the music toggles). */
export function mountNowPlaying(parent) {
  const player = getMusicPlayer();
  if (!player || !parent) return null;
  inject();
  const root = mk('div', 'gkm-np', parent);
  const txt = mk('span', null, root);
  const next = mk('button', 'gkm-next', root);
  next.type = 'button';
  next.innerHTML = NEXT_SVG;
  next.append('Sonraki parça');
  next.addEventListener('click', () => player.next());
  follow(root, player, (s) => {
    txt.replaceChildren();
    if (s.enabled && s.track && s.supported) { mk('em', null, txt, 'Şimdi çalıyor: '); mk('b', null, txt, s.track.title); }
    else mk('em', null, txt, label(s)[0] === 'Kapalı' ? 'Müzik şu an kapalı' : label(s)[0]);
    next.disabled = !s.enabled || !s.supported;
  });
  return root;
}

/** Let the music play while the game is paused (after a music switch was turned on there). */
export function musicPreview() {
  const p = getMusicPlayer();
  if (p) p.preview();
}
