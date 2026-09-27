// Leaderboard board ids of the "Destekli" list: results flown with assisted flight or landed on the autopilot go to the
// assisted variant of their board, never to the manual one (infra/leaderboard/lambda/validate.mjs: `as-<board>`, inside a
// weekly id `w-<yyyyww>-as-<base>`; same rules, days and expiry as the base). The views open on the list the player's
// latest result went to (localStorage `gokyuzu.lbList`: { <manual board>: 'a' | 'm' }, local only), else "Elle".
const WEEK = /^(w-\d{6}-)(.*)$/;
const AS = 'as-';

/** The assisted variant of a board ('low-pass' → 'as-low-pass', 'w-202640-ff-bridge' → 'w-202640-as-ff-bridge'). */
export function assistedBoard(board) {
  const b = String(board || '');
  const w = WEEK.exec(b);
  if (w) return w[2].startsWith(AS) ? b : `${w[1]}${AS}${w[2]}`;
  return b.startsWith(AS) ? b : `${AS}${b}`;
}
/** The manual board of either variant. */
export const manualBoard = (board) => String(board || '').replace(/^(w-\d{6}-)?as-/, '$1');
export const isAssistedBoard = (board) => /^(w-\d{6}-)?as-/.test(String(board || ''));
/** The board a result goes to. */
export const boardFor = (board, assisted) => (assisted ? assistedBoard(board) : manualBoard(board));

const KEY = 'gokyuzu.lbList';
function read() { try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
/** 'as' | 'm' | null: the list the player's latest result on this board went to. */
export function lastList(board) { const v = read()[manualBoard(board)]; return v === 'a' ? 'as' : v === 'm' ? 'm' : null; }
export function rememberList(board, assisted) {
  try {
    const s = read(), k = manualBoard(board);
    delete s[k];
    s[k] = assisted ? 'a' : 'm';
    const keys = Object.keys(s);
    while (keys.length > 60) delete s[keys.shift()];   // (insertion order: the oldest first)
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* private mode */ }
}
