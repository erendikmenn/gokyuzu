#!/usr/bin/env node
// Markdown tables from the JSON results of the perf tools (for docs/perf/plan.md updates).
// usage: node tools/perf/report.mjs scenes <scenes-*.json> | load <load-*.json> | soak <soak-*.json> | ab <ab-*.json>
import fs from 'node:fs';

const [kind, file] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const table = (rows, cols) => {
  const head = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
  return `${head}\n${rows.map((r) => `| ${cols.map((c) => (r[c] ?? '')).join(' | ')} |`).join('\n')}`;
};
const f1 = (x) => (x == null ? '' : (+x).toFixed(1));

if (kind === 'scenes') {
  const rows = d.filter((r) => !r.error).map((r) => ({
    preset: r.preset, scene: r.pose, fps: f1(r.fps), 'frame p95 ms': f1(r.frameMs.p95), 'CPU ms (p50)': f1(r.cpuMs.p50), 'render CPU': f1(r.subMean.render),
    'world CPU': f1(r.subMean.world), HUD: f1(r.subMean.hud), avionics: f1(r.subMean.avionics), 'GPU ms p10/mean': r.gpuMs ? `${f1(r.gpuMs.p10)} / ${f1(r.gpuMs.mean)}` : '',
    shadow: r.gpuMs ? f1(r.gpuMs.shadowP10 ?? r.gpuMs.shadowMean) : '', calls: r.info.calls, 'tris M': f1(r.info.triangles / 1e6), programs: r.info.programs, textures: r.info.textures,
    'shaded Mpx (xscreen)': r.fragments ? `${f1(r.fragments.totalShadedMpx)} (x${r.fragments.overdraw})` : '', 'heap MB': Math.round(r.heapMB),
  }));
  console.log(table(rows, Object.keys(rows[0])));
  const ab = d.filter((r) => r.ablation);
  for (const r of ab) {
    console.log(`\nAblation ${r.preset} ${r.pose} (all: GPU ${r.ablation.all.gpu} ms mean, ${r.ablation.all.p10} p10, CPU ${r.ablation.all.cpu} ms, ${r.ablation.all.calls} calls)`);
    const rows2 = Object.entries(r.ablation).filter(([k]) => k !== 'all').map(([k, v]) => ({ hidden: k.slice(1), 'GPU saved (mean)': v.gpuSaved, 'GPU saved (p10)': v.gpuSavedP10, 'CPU saved': v.cpuSaved, 'calls saved': v.callsSaved }))
      .sort((a, b) => (b['GPU saved (p10)'] || 0) - (a['GPU saved (p10)'] || 0));
    console.log(table(rows2, Object.keys(rows2[0])));
  }
  const fr = d.filter((r) => r.fragments && (r.pose === 'downtown-300' || r.pose.startsWith('cockpit-f16')) && r.preset === 'high');
  for (const r of fr) {
    console.log(`\nFragments ${r.preset} ${r.pose}: ${r.fragments.totalShadedMpx} Mpx shaded for a ${r.fragments.screenMpx} Mpx screen`);
    console.log(table(r.fragments.layers.map((l) => ({ layer: l.layer, 'shaded Mpx': l.shadedMpx, 'visible Mpx': l.visibleMpx, 'wasted %': l.wastedPct })), ['layer', 'shaded Mpx', 'visible Mpx', 'wasted %']));
  }
  const mem = d.filter((r) => r.memory && r.memory.layers);
  for (const r of mem.filter((x) => x.preset === 'high' && x.pose === 'downtown-300')) {
    console.log(`\nMemory ${r.preset} ${r.pose} (GL total ${JSON.stringify(r.memory.glTotalMB)})`);
    console.log(table(r.memory.layers.filter((l) => l.geoMB + l.texMB + l.instMB > 0.5), ['layer', 'meshes', 'visible', 'geometries', 'textures', 'geoMB', 'instMB', 'texMB']));
  }
} else if (kind === 'load') {
  const rows = d.filter((r) => !r.error).map((r) => ({ run: r.label, 'menu s': r.timeToMenuS, 'click→playable s': r.clickToPlayableS, requests: r.totals.requests, 'MB total': r.totals.MB, 'MB until playable': r.totals.MBuntilReady,
    'JS modules': r.jsWaterfall && r.jsWaterfall.modules, 'JS phase ms': r.jsWaterfall && `${r.jsWaterfall.firstStartMs}–${r.jsWaterfall.lastEndMs}`, 'first frame ms': r.hitch.firstFrame && r.hitch.firstFrame.dt,
    'worst frame 5 s': r.hitch.worstFirst5s[0] && r.hitch.worstFirst5s[0].dt, 'compile ms (before+after)': `${r.hitch.compileMsBeforeReady}+${r.hitch.compileMsFirst5s}`, 'links after start': r.hitch.linksFirst5s }));
  console.log(table(rows, Object.keys(rows[0])));
  const c = d.find((r) => r.byType && r.label.endsWith('cold'));
  if (c) {
    console.log(`\nBytes by type (${c.label})`);
    console.log(table(Object.entries(c.byType).sort((a, b) => b[1].KB - a[1].KB).map(([k, v]) => ({ type: k, requests: v.req, 'KB total': v.KB, 'KB until playable': v.KBload, menu: v.menu, load: v.load, after: v.after })), ['type', 'requests', 'KB total', 'KB until playable', 'menu', 'load', 'after']));
  }
} else if (kind === 'soak') {
  const rows = d.series.map((r) => ({ t: r.t, fps: f1(r.fps), p95: f1(r.p95), p99: f1(r.p99), max: f1(r.max), '>50ms': r.over50, 'CPU': f1(r.cpu), 'upload MB/s': f1(r.upMBs), 'compile ms': Math.round(r.compileMs), 'alloc MB/s': r.alloc && f1(r.alloc.MBperSec), GCs: r.alloc && r.alloc.gcDrops,
    'heap MB': Math.round(r.heapMB), 'GPU MB': r.gpuMB ? Math.round(r.gpuMB.tex + r.gpuMB.buf) : '', textures: r.textures, geometries: r.geometries, 'terrain tiles/tex': `${r.terrain.loaded}/${r.terrain.textures}`, 'city tiles': r.city && r.city.loaded }));
  console.log(table(rows, Object.keys(rows[0])));
  console.log('\ngrowth', JSON.stringify(d.growth), 'maxima', JSON.stringify(d.maxima));
  if (d.windows.trace) console.log('trace', JSON.stringify(d.windows.trace));
  if (d.windows.profile) console.log('profile', JSON.stringify(d.windows.profile.topSelf.slice(0, 15)), JSON.stringify(d.windows.profile.special));
  if (d.windows.alloc) console.log('alloc', JSON.stringify(d.windows.alloc));
} else if (kind === 'ab') {
  const rows = Object.entries(d.summary).map(([k, s]) => ({ 'pose|variant': k, 'GPU mean': s.gpu, 'x base': s.gpuRatio, 'GPU p10': s.gpuP10, 'x base (p10)': s.gpuP10Ratio, 'CPU ms': s.cpu, 'x base CPU': s.cpuRatio, calls: s.calls }));
  console.log(table(rows, Object.keys(rows[0])));
  console.log(`\nother-process GPU busy while parked: ${JSON.stringify(d.busy)}`);
}
