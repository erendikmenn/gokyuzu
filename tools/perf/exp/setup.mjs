#!/usr/bin/env node
// Writes perf-exp.html (index.html with "three" mapped to tools/perf/exp/three-shim.js) into a scratch worktree root
// and links tools/perf there. usage: node tools/perf/exp/setup.mjs <worktree-root>   (never run it on the repo itself)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.argv[2];
if (!root || path.resolve(root) === path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')) { console.error('pass a scratch worktree root'); process.exit(2); }
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace('"three": "./node_modules/three/build/three.module.js"', '"three": "./tools/perf/exp/three-shim.js"');
fs.writeFileSync(path.join(root, 'perf-exp.html'), html);
const link = path.join(root, 'tools/perf');
if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), link);
console.log('wrote', path.join(root, 'perf-exp.html'));
