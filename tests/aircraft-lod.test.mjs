// LOD-first start (src/app/aircraft-lod.js): the download-rate estimate that decides between the LOD stand-in and the
// full model. Run: node tests/aircraft-lod.test.mjs
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

let entries = [];
globalThis.performance.getEntriesByType = (t) => (t === 'resource' ? entries : []);
const { measuredMbps } = await import('../src/app/aircraft-lod.js');
// a response body: bytes over [responseStart, responseEnd] ms; transferSize = body + ~300 B of headers
const net = (bytes, start, end) => ({ transferSize: bytes + 300, encodedBodySize: bytes, responseStart: start, responseEnd: end });

entries = [net(1e6, 0, 1000)];
check('1 MB in 1 s over the network ≈ 8 Mbit/s', Math.abs(measuredMbps() - 8) < 0.01, measuredMbps());
entries = [net(1e6, 0, 1000), net(1e6, 500, 1500)];
check('overlapping downloads share the time (2 MB in 1.5 s)', Math.abs(measuredMbps() - 2e6 * 8 / 1.5e6) < 0.01, measuredMbps());
entries = [{ transferSize: 0, encodedBodySize: 5e6, responseStart: 0, responseEnd: 2 }];
check('memory / disk cache hits alone: no estimate', measuredMbps() === null);
// a revalidated copy (304): only headers move, encodedBodySize reports the cached body, in a few ms
entries = [{ transferSize: 310, encodedBodySize: 800e3, responseStart: 100, responseEnd: 103 }, { transferSize: 290, encodedBodySize: 400e3, responseStart: 104, responseEnd: 106 }];
check('304 revalidations are not a download (was ~3000 Mbit/s: full model on a slow line)', measuredMbps() === null, measuredMbps());
entries = [net(1e6, 0, 1000), { transferSize: 310, encodedBodySize: 5e6, responseStart: 1000, responseEnd: 1002 }];
check('a real download next to 304s keeps its own rate', Math.abs(measuredMbps() - 8) < 0.01, measuredMbps());

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.detail})`}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
