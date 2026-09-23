"""Regenerate every sound and the loudness manifest.

Usage: .venv/bin/python tools/audio/build_all.py [--only common,fighters,airliners,uh60,voices] [--manifest-only]
Outputs: assets/audio/{common,f16,f22,a320neo,b737,uh60}/*.wav (48 kHz mono 16-bit) + assets/audio/manifest.json
"""
import glob
import json
import os
import sys
import time
import warnings

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import OUT, SR, lufs, peak_dbfs, read_wav  # noqa: E402


def manifest():
    m = {}
    total = 0
    for f in sorted(glob.glob(os.path.join(OUT, '*', '*.wav'))):
        rel = os.path.relpath(f, OUT)[:-4]
        x = read_wav(f)
        m[rel] = {'dur': round(len(x) / SR, 3), 'lufs': round(float(lufs(x)), 2), 'peak': round(peak_dbfs(x), 2)}
        total += os.path.getsize(f)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
        json.dump(m, fh, indent=0, sort_keys=True)
    print(f'manifest: {len(m)} files, {total / 1e6:.1f} MB')


def main():
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    if '--manifest-only' not in sys.argv:
        t0 = time.time()
        import gen_airliners, gen_common, gen_fighters, gen_uh60, gen_voices  # noqa: E401
        steps = {'common': gen_common.main, 'fighters': lambda: [gen_fighters.gen(a) for a in gen_fighters.ENGINES],
                 'airliners': lambda: [gen_airliners.gen(a) for a in gen_airliners.ENGINES], 'uh60': gen_uh60.main,
                 'voices': gen_voices.main}
        for k, fn in steps.items():
            if only is None or k in only:
                fn()
        print(f'generated in {time.time() - t0:.1f} s')
    manifest()


if __name__ == '__main__':
    main()
