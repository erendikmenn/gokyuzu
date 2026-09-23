"""Build assets/audio/candidates/review.json (read by dev/sesler.html) and the listening previews.

    .venv/bin/python tools/audio/research/fetch_fg.py      # FlightGear originals (once)
    .venv/bin/python tools/audio/research/analyze.py --whisper
    .venv/bin/python tools/audio/research/build_review.py

The curated content (what each real alert is, when it sounds, what the game does today, every candidate with licence
and provenance, the recommendation) lives in review_data.py; this script only resolves files, renders previews
(previews.make_preview → <aircraft>/<sound>/<candidate>[__<label>].wav) and writes the JSON. Research only: the game's
own sounds (assets/audio/<id>/*, manifest.json, src/audio/**) are never touched.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from previews import make_preview  # noqa: E402
import review_data as D  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CAND = os.path.join(ROOT, 'assets', 'audio', 'candidates')
AN = json.load(open(os.path.join(os.path.dirname(__file__), 'analysis.json')))
MANIFEST = json.load(open(os.path.join(ROOT, 'assets', 'audio', 'manifest.json')))


def slug(s):
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')[:40]


def quality(orig):
    m = AN.get(orig)
    if not m:
        return None
    parts = [f"{m['sr'] / 1000:g} kHz", 'mono' if m.get('channels') == 1 else f"{m.get('channels')} kanal"]
    if m.get('bits'):
        parts.append(f"{m['bits']}-bit")
    if m.get('codec') and not m['codec'].startswith('pcm'):
        parts.append(m['codec'])
    parts.append(f"{m['dur']:.2f} s")
    if 'peak_dbfs' in m:
        parts.append(f"tepe {m['peak_dbfs']:+.1f} dBFS" + (f" ({m['clipped']} kırpılmış örnek)" if m.get('clipped', 0) > 3 else ''))
    if m.get('bw_hz'):
        parts.append(f"bant ≈{m['bw_hz'] / 1000:.1f} kHz")
    if m.get('snr_db') is not None and m['dur'] > 0.4:
        parts.append(f"dinamik ≈{m['snr_db']:.0f} dB")
    return ' · '.join(parts)


def build_candidate(c):
    out = {k: v for k, v in c.items() if k not in ('files',)}
    files = []
    for i, f in enumerate(c['files']):
        orig = f['orig']
        src = os.path.join(ROOT, orig)
        if not os.path.exists(src):
            print('  !! missing', orig)
            continue
        label = f.get('label') or ''
        name = c['id'] + (f'__{slug(label)}' if label and len(c['files']) > 1 else '') + '.wav'
        dst = os.path.join(CAND, c['aircraft'], c['sound'], name)
        info = make_preview(src, dst, segment=f.get('segment'), loop=f.get('loop', False),
                            repeat_to=f.get('repeat_to'), gap=f.get('gap', 0.0))
        an = AN.get(orig, {})
        files.append({'label': label, 'src': os.path.relpath(dst, ROOT), 'orig': orig, 'dur': info['dur'],
                      'quality': quality(orig), 'transcript': an.get('transcript'),
                      'segment': f.get('segment'), 'loop': bool(f.get('loop') or f.get('repeat_to'))})
    out['files'] = files
    return out


def game_files(aid, names):
    out = []
    for n in names:
        key = n if '/' in n else f'{aid}/{n}'
        if key not in MANIFEST:
            print('  !! game sound not in manifest:', key)
            continue
        out.append({'label': n.split('/')[-1], 'src': f'assets/audio/{key}.m4a', 'dur': MANIFEST[key]['dur'],
                    'loop': 'loopDur' in MANIFEST[key]})
    return out


def main():
    cands = {c['id']: c for c in D.CANDIDATES}
    used = set()
    review = {'generated': D.GENERATED, 'intro': D.INTRO, 'legend': D.LEGEND, 'aircraft': []}
    for ac in D.AIRCRAFT:
        print('[%s]' % ac['id'])
        A = {k: v for k, v in ac.items() if k != 'sounds'}
        A['sounds'] = []
        for s in ac['sounds']:
            S = {k: v for k, v in s.items() if k not in ('cands', 'game')}
            g = s.get('game')
            S['game'] = None if not g else {'files': game_files(ac['id'], g.get('files', [])), 'trigger': g['trigger'],
                                            'kind': g.get('kind', '')}
            S['candidates'] = []
            for cid in s.get('cands', []):
                c = cands[cid]
                used.add(cid)
                print('  ', cid)
                S['candidates'].append(build_candidate(c))
            A['sounds'].append(S)
        review['aircraft'].append(A)
    unused = set(cands) - used
    if unused:
        print('candidates not placed in any row:', sorted(unused))
    review['references'] = D.REFERENCES
    review['sources'] = D.SOURCES
    with open(os.path.join(CAND, 'review.json'), 'w') as f:
        json.dump(review, f, ensure_ascii=False, indent=1)
    print('wrote', os.path.relpath(os.path.join(CAND, 'review.json'), ROOT))


if __name__ == '__main__':
    main()
