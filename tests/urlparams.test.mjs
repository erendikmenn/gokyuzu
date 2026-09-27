// Hostile links: the query-string number reader every debug / test switch goes through (src/core/url-params.js), and
// the dev server's root check (tools/serve.mjs). Run: node tests/urlparams.test.mjs (no browser, no network)
import { queryNumber } from '../src/core/url-params.js';

const rows = [];
const check = (name, ok, detail = '') => rows.push({ name, ok: !!ok, detail });
const q = (s) => new URLSearchParams(s);

check('queryNumber: missing / empty / blank → default', queryNumber(q(''), 'pr', 1.5) === 1.5 && queryNumber(q('pr='), 'pr', 1.5) === 1.5
  && queryNumber(q('pr=%20'), 'pr', 1.5) === 1.5 && queryNumber(null, 'pr', 2) === 2);
check('queryNumber: not a number / not finite → default', ['abc', 'NaN', 'Infinity', '-Infinity', '1e400', '0x', '1,5', 'constructor'].every((v) => queryNumber(q(`pr=${v}`), 'pr', 7, 0.5, 3) === 7));
check('queryNumber: clamped to the range', queryNumber(q('pr=0'), 'pr', 1, 0.25, 3) === 0.25 && queryNumber(q('pr=-1'), 'pr', 1, 0.25, 3) === 0.25
  && queryNumber(q('pr=100'), 'pr', 1, 0.25, 3) === 3 && queryNumber(q('pr=1.25'), 'pr', 1, 0.25, 3) === 1.25);
check('queryNumber: plain numbers, exponent and hex forms read like Number()', queryNumber(q('far=2e4'), 'far', 0) === 20000 && queryNumber(q('far=0x10'), 'far', 0) === 16
  && queryNumber(q('d=%2B5'), 'd', 0) === 5);

// dev server (tools/serve.mjs): a path must stay inside the served root, also against a sibling sharing its name prefix
{
  const path = await import('node:path');
  const root = path.resolve('/srv/game');
  const inside = (urlPath) => { const file = path.join(root, decodeURIComponent(urlPath)); return file === root || file.startsWith(root + path.sep); };
  check('dev server root check: sibling with the same prefix refused, files inside served', !inside('/../game-private/x') && !inside('/../../etc/passwd')
    && !inside('/%2e%2e/game2/a') && inside('/index.html') && inside('/src/../index.html') && inside('/'));
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../tools/serve.mjs', import.meta.url), 'utf8');
  check('dev server uses the separator-aware root check', src.includes('file.startsWith(root + path.sep)') && !/!file\.startsWith\(root\)\)/.test(src));
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
