#!/usr/bin/env node
// Maps positions in the published JavaScript chunks back to the source, with the source maps the build keeps locally
// (dist/js/*.map; deploy builds also in node_modules/.cache/gokyuzu/sourcemaps/<target>/, since maps are never uploaded).
//   node tools/build/symbolicate.mjs app-ZVKT4TCH.js:812            telemetry "err" beacons carry file:line only
//   node tools/build/symbolicate.mjs app-ZVKT4TCH.js:812:4410
//   pbpaste | node tools/build/symbolicate.mjs                        a whole stack trace: every chunk:line[:col] replaced
import fs from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = [path.join(root, 'dist/js'), ...['production', 'staging'].map((t) => path.join(root, 'node_modules/.cache/gokyuzu/sourcemaps', t))];
const maps = new Map();
function mapFor(file) {
  if (!maps.has(file)) {
    const f = DIRS.map((d) => path.join(d, `${file}.map`)).find((p) => fs.existsSync(p));
    maps.set(file, f ? new SourceMap(JSON.parse(fs.readFileSync(f, 'utf8'))) : null);
  }
  return maps.get(file);
}
const clean = (s) => String(s).replace(/^(\.\.\/)+/, '');
/** "src/ui/menu.js:65:12 (name)"; without a column: the source lines the whole generated line covers. */
function lookup(file, line, col) {
  const sm = mapFor(file);
  if (!sm) return null;
  if (col != null) {
    const e = sm.findEntry(line - 1, col - 1);
    return e && e.originalSource ? `${clean(e.originalSource)}:${e.originalLine + 1}:${e.originalColumn + 1}${e.name ? ` (${e.name})` : ''}` : null;
  }
  const spans = new Map();
  for (let c = 0; c < 4000; c += 20) {   // lines are ≤ ~500 characters (bundle.mjs lineLimit)
    const e = sm.findEntry(line - 1, c);
    if (!e || !e.originalSource || e.generatedLine !== line - 1) continue;
    const s = spans.get(e.originalSource) || [Infinity, -Infinity];
    spans.set(e.originalSource, [Math.min(s[0], e.originalLine + 1), Math.max(s[1], e.originalLine + 1)]);
  }
  return spans.size ? [...spans].map(([s, [a, b]]) => `${clean(s)}:${a}${b > a ? `-${b}` : ''}`).join(', ') : null;
}
const RE = /(?:[a-z]+:\/\/[^\s()]*\/)?([\w.-]+\.js):(\d+)(?::(\d+))?/g;   // with or without the URL in front
const sub = (text) => text.replace(RE, (m, f, l, c) => { const r = lookup(f, Number(l), c == null ? null : Number(c)); return r ? `${r} [${m}]` : m; });

const args = process.argv.slice(2);
if (args.length) for (const a of args) console.log(sub(a));
else process.stdout.write(sub(fs.readFileSync(0, 'utf8')));
