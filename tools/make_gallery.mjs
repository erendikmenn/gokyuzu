#!/usr/bin/env node
// Scans renders/** for images and writes renders/manifest.json for galeri.html.
// Usage: node tools/make_gallery.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendersDir = path.join(root, 'renders');
const TITLES = {
  'aircraft/f16': 'F-16C Fighting Falcon', 'aircraft/f22': 'F-22A Raptor', 'aircraft/a320neo': 'Airbus A320neo',
  'aircraft/b737': 'Boeing 737-800', 'aircraft/uh60': 'UH-60M Black Hawk',
  landmarks: 'San Francisco simge yapıları', airports: 'Havalimanları ve Alameda Hava Üssü', city: 'Şehir',
};

const groups = [];
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const images = entries.filter((e) => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name) && !/^(thumb|compare|cmp)/i.test(e.name))
    .map((e) => e.name).sort();
  const rel = path.relative(rendersDir, dir).split(path.sep).join('/');
  if (images.length && rel) {
    groups.push({
      key: rel, title: TITLES[rel] || rel,
      images: images.map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { src: `renders/${rel}/${n}`, name: n.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' '), bytes: st.size };
      }),
    });
  }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('_') && !['before', 'fidelity'].includes(e.name)) walk(path.join(dir, e.name));
}
if (fs.existsSync(rendersDir)) walk(rendersDir);
const order = ['aircraft/f16', 'aircraft/f22', 'aircraft/a320neo', 'aircraft/b737', 'aircraft/uh60', 'landmarks', 'airports', 'city'];
groups.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
fs.writeFileSync(path.join(rendersDir, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), groups }, null, 1));
console.log(groups.map((g) => `${g.key}: ${g.images.length}`).join('\n'));
