// Numbers from the page's query string (debug and test switches such as ?pr=, ?far=, ?playdelay=, ?geoPx=): a link can
// carry any text, so every such number is read through queryNumber — missing, empty, not a number or not finite → the
// default; otherwise clamped to a range the game can run with. A crafted link then cannot leave a 0 × 0 canvas
// (?pr=0), an infinite far plane (?far=1e400) or a world that never streams (?playdelay=1e9).

/** `params`: URLSearchParams. → def, or the value clamped to [min, max]. */
export function queryNumber(params, key, def, min = -Infinity, max = Infinity) {
  const s = params && params.get(key);
  if (s === null || s === undefined || String(s).trim() === '') return def;
  const v = Number(s);
  if (!Number.isFinite(v)) return def;
  return v < min ? min : v > max ? max : v;
}
