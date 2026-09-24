// In-memory leaderboard store with the same interface and semantics as dynamo.mjs (unit tests, local mocks).
export function createMemoryDb() {
  const items = new Map();   // `${pk}\n${sk}` → item
  const key = (pk, sk) => `${pk}\n${sk}`;
  const board = (pk) => [...items.values()].filter((it) => it.pk === pk && it.rk).sort((a, b) => (a.rk < b.rk ? 1 : a.rk > b.rk ? -1 : 0));
  return {
    items,
    /** Atomic counter (rate limit): +1, returns the new count; `exp` = expiry (epoch s), set on first use. */
    async hit(pk, exp) {
      const k = key(pk, '-');
      const it = items.get(k) || { pk, sk: '-', c: 0, exp };
      it.c++;
      items.set(k, it);
      return it.c;
    },
    /** Write the entry only if the player has none on this board or a worse one → { written, old }. */
    async putBest(item) {
      const k = key(item.pk, item.sk);
      const old = items.get(k) || null;
      if (old && !(old.rk < item.rk)) return { written: false, old: { ...old } };
      items.set(k, { ...item });
      return { written: true, old };
    },
    /** Best n entries of a board, best first. */
    async top(pk, n) {
      return board(pk).slice(0, n).map((it) => ({ ...it }));
    },
    /** How many entries rank above `rk` (at most `cap`). */
    async countAbove(pk, rk, cap) {
      return Math.min(cap, board(pk).filter((it) => it.rk > rk).length);
    },
  };
}
