#!/usr/bin/env node
// Removes JavaScript chunks no open page can still need from a bucket (run by tools/deploy/deploy.sh after the pages of a
// deploy are up; it never touches the chunks of the current or the previous deploy).
// Chunk names carry their content hash (tools/build/bundle.mjs), so uploading never changes a file anybody uses; deleting
// can: a tab opened before a deploy keeps importing its lazy chunks (aircraft model/spec, sound profiles) from the build
// it started with.
//  - every deploy records its chunk list in js/_deploys/<UTC time>.json
//  - kept: the chunks of the current deploy, of the one before it, and of every deploy replaced less than RETAIN_DAYS ago
//  - the unbundled modules of the last deploy before the bundle (src/**/*.js, node_modules/three/build/, the rest of
//    node_modules/three/examples/jsm/ except the Draco/Basis decoders; deploy.sh's syncs leave them alone) count as
//    one more such deploy and are removed with it
// usage: node tools/build/prune_js.mjs s3://<bucket> [--dist <dir>] [--dry-run]    (AWS CLI; profile from AWS_PROFILE)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RETAIN_DAYS = 7;
const MARKERS = 'js/_deploys/';
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, '');   // 20260923T201500123Z

/** Unbundled files of the pre-bundle site, from a bucket listing. */
export const isLegacy = (key) => (/^src\/.*\.m?js$/.test(key) || /^node_modules\/three\/(build|examples\/jsm)\//.test(key))
  && !/^node_modules\/three\/examples\/jsm\/libs\/(draco|basis)\//.test(key);

/**
 * What to write and delete. now: ms; current: chunk file names of this deploy; markers: [{ key, at (ms), chunks, legacy }]
 * already in the bucket; jsKeys: every key under js/; legacyKeys: keys for which isLegacy() holds.
 */
export function plan({ now, current, markers, jsKeys, legacyKeys, retainDays = RETAIN_DAYS }) {
  const write = [{ key: `${MARKERS}${stampOf(now)}.json`, at: now, chunks: current }];
  // first bundled deploy over an unbundled site: the old modules are the previous generation
  if (!markers.length && legacyKeys.length) write.push({ key: `${MARKERS}${stampOf(now - 1000)}-unbundled.json`, at: now - 1000, chunks: [], legacy: true });
  const gens = [...markers, ...write].sort((a, b) => b.at - a.at);
  const kept = gens.filter((g, i) => i < 2 || now - gens[i - 1].at < retainDays * 864e5);
  const dropped = gens.filter((g) => !kept.includes(g));
  const keepChunks = new Set(kept.flatMap((g) => g.chunks.map((c) => `js/${c}`)));
  const del = [
    ...jsKeys.filter((k) => !k.startsWith(MARKERS) && !keepChunks.has(k)),
    ...(dropped.some((g) => g.legacy) ? legacyKeys : []),
    ...dropped.filter((g) => !write.includes(g)).map((g) => g.key),
  ];
  return { write: write.filter((g) => kept.includes(g)), del, kept: kept.length, dropped: dropped.length };
}

// ---------------------------------------------------------------- AWS CLI
const aws = (args, input) => execFileSync('aws', args, { input, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'inherit'] });
function listKeys(bucket, prefix) {
  const out = aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--query', 'Contents[].Key', '--output', 'json']);
  return JSON.parse(out || 'null') || [];
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => a.startsWith('s3://'));
  if (!target) { console.error('usage: node tools/build/prune_js.mjs s3://<bucket> [--dist <dir>] [--dry-run]'); process.exit(2); }
  const bucket = target.slice(5).replace(/\/.*$/, '');
  const dryRun = argv.includes('--dry-run');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dist = argv.includes('--dist') ? path.resolve(argv[argv.indexOf('--dist') + 1]) : path.join(root, 'dist');
  const jsDir = path.join(dist, 'js');
  const current = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')) : [];
  if (!current.length) throw new Error(`${jsDir}: no chunks (not a bundled build); nothing pruned`);

  const jsKeys = listKeys(bucket, 'js/');
  const missing = current.filter((c) => !jsKeys.includes(`js/${c}`));
  if (missing.length) throw new Error(`chunks of this build are not in the bucket (${missing.slice(0, 3).join(', ')}…): upload first`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-js-'));
  try {
    const markerKeys = jsKeys.filter((k) => k.startsWith(MARKERS) && k.endsWith('.json'));
    if (markerKeys.length) aws(['s3', 'cp', `s3://${bucket}/${MARKERS}`, path.join(tmp, 'm'), '--recursive', '--only-show-errors']);
    const markers = markerKeys.map((key) => {
      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'm', key.slice(MARKERS.length)), 'utf8'));
      return { key, at: Date.parse(m.at), chunks: m.chunks || [], legacy: !!m.legacy };
    });
    const legacyKeys = [...listKeys(bucket, 'src/'), ...listKeys(bucket, 'node_modules/three/')].filter(isLegacy);
    const p = plan({ now: Date.now(), current, markers, jsKeys, legacyKeys });
    console.log(`JS chunks: ${current.length} in this build; ${p.kept} deploys kept, ${p.dropped} expired; ${p.del.length} files to remove${dryRun ? ' (dry run)' : ''}`);
    if (dryRun) { for (const k of p.del.slice(0, 50)) console.log('  -', k); return; }
    for (const g of p.write) {
      aws(['s3', 'cp', '-', `s3://${bucket}/${g.key}`, '--content-type', 'application/json', '--cache-control', 'no-store', '--only-show-errors'],
        JSON.stringify({ at: new Date(g.at).toISOString(), legacy: g.legacy || undefined, chunks: g.chunks }));
    }
    for (let i = 0; i < p.del.length; i += 1000) {
      const f = path.join(tmp, `del-${i}.json`);
      fs.writeFileSync(f, JSON.stringify({ Objects: p.del.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true }));
      aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', `file://${f}`]);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`prune_js: ${e.message}`); process.exit(1); });
}
