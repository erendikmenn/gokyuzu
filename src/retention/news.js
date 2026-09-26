// "Yenilikler" logic (pure; the card is src/retention/whatsnew.js): which entries of src/data/changelog.json a player sees.
// Entries: { id: 'YYYY-MM-DD' (sortable; a second release on one day: 'YYYY-MM-DDb'), title, items: [Turkish lines] }, any
// order in the file. The last seen id is kept in localStorage `gokyuzu.seen`.
//   seen      → the entries newer than it (at most `max`, newest first)
//   no seen   → a returning player from before this card (the game's other keys exist): the newest entry only;
//               a first visit: nothing (the newest id is stored, the next release shows)
export const SEEN_KEY = 'gokyuzu.seen';
/** localStorage keys of an earlier visit: the menu's choice, missions, free-flight challenges, leaderboard key, streak. */
export const RETURNING_KEYS = ['gokyuzu-sf.menu', 'gokyuzu.missions', 'gokyuzu.ffc', 'gokyuzu.player', 'gokyuzu.streak', 'gokyuzu.settings'];

export function pendingNews(entries, seen, returning, max = 3) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.id === 'string' && Array.isArray(e.items) && e.items.length)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (!list.length) return { show: [], latest: null };
  const latest = list[0].id;
  if (seen) return { show: list.filter((e) => e.id > seen).slice(0, max), latest };
  return { show: returning ? list.slice(0, 1) : [], latest };
}
