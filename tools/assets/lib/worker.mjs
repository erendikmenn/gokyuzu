// Worker thread: encodes one image per message and checks the result against the source.
//   in:  { id, bytes, kind: 'color'|'normal'|'data', maxSize, profile: 'hero'|'world', colour: 'uastc'|'auto'|'etc1s',
//          wrap, threads }
//   out: { id, ktx2, mode, rdo, width, height, srcW, srcH, alpha, q: { psnr, ssim, tileMin, … }, tried, ms } | { id, error }
import { parentPort } from 'node:worker_threads';
import { loadRGBA, encodeKTX2, decodeKTX2, compare } from './ktx2.mjs';
import { UASTC, ETC1S, PROFILES, etc1sAcceptable, uastcAcceptable } from './policy.mjs';

async function job({ bytes, kind, maxSize, profile, colour, wrap, threads }) {
  const t0 = Date.now();
  const px = await loadRGBA(Buffer.from(bytes), maxSize);
  const check = async (k) => compare(px, await decodeKTX2(k), { normal: kind === 'normal' });
  const tried = {};
  const P = PROFILES[profile];
  // ETC1S first where the profile allows it (smallest files), then UASTC with RDO, then plain UASTC
  if (kind !== 'normal' && colour !== 'uastc') {
    const k = await encodeKTX2(px, { ...ETC1S, kind, wrap, threads });
    const q = await check(k);
    tried.etc1s = { bytes: k.length, ...q };
    if (colour === 'etc1s' || etc1sAcceptable(profile, kind === 'data' ? 'data' : 'color', q)) return done({ ktx2: k, mode: 'etc1s', rdo: 0, q });
  }
  const rdo = kind === 'normal' ? P.normalRdo : P.rdo;
  if (rdo > 0) {
    const k = await encodeKTX2(px, { ...UASTC, kind, rdo, wrap, threads });
    const q = await check(k);
    tried.uastcRdo = { rdo, bytes: k.length, ...q };
    if (uastcAcceptable(profile, kind, q)) return done({ ktx2: k, mode: 'uastc', rdo, q });
  }
  const k = await encodeKTX2(px, { ...UASTC, kind, rdo: 0, wrap, threads });
  const q = await check(k);
  tried.uastc = { bytes: k.length, ...q };
  return done({ ktx2: k, mode: 'uastc', rdo: 0, q });

  function done(r) { return { ...r, width: px.width, height: px.height, srcW: px.srcW, srcH: px.srcH, alpha: px.alphaMin < 255, tried, ms: Date.now() - t0 }; }
}

parentPort.on('message', async (m) => {
  try {
    const r = await job(m);
    parentPort.postMessage({ id: m.id, ...r }, [r.ktx2.buffer]);
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.stack) || e) });
  }
});
