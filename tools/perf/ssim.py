#!/usr/bin/env python3
"""Screenshot quality comparison for optimisation work (the visual gate of docs/perf/plan.md).

    .venv/bin/python tools/perf/ssim.py A.png B.png [--heatmap out.png]
    .venv/bin/python tools/perf/ssim.py --dirs baseline/ candidate/ [--noise noise/ | --noise-json noise.json] [--json out.json] [--heatmaps dir/]

Per image pair: SSIM (Gaussian 11x11, sigma 1.5, on luma, Wang et al. 2004), the minimum SSIM over 64 px tiles (catches
a local break that a global mean hides), PSNR, and the share of pixels whose colour differs by more than 8/255 (any
channel). With --dirs every file present in both folders is compared; --noise gives a second baseline capture of the
same poses (run-to-run noise: streaming order, animation) so a candidate is judged against the noise floor
(--noise-json: the --json output of a baseline-vs-noise run, e.g. docs/perf/ref-2026-09/noise.json):
    PASS  when SSIM >= min(0.995, noise SSIM - 0.002) and tile-min SSIM >= noise tile-min - 0.02
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter


def load(p):
    im = Image.open(p).convert('RGB')
    return np.asarray(im, dtype=np.float64) / 255.0


def luma(a):
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def ssim_map(x, y):
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mx, my = gaussian_filter(x, 1.5, truncate=3.5), gaussian_filter(y, 1.5, truncate=3.5)
    sxx = gaussian_filter(x * x, 1.5, truncate=3.5) - mx * mx
    syy = gaussian_filter(y * y, 1.5, truncate=3.5) - my * my
    sxy = gaussian_filter(x * y, 1.5, truncate=3.5) - mx * my
    return ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))


def compare(a_path, b_path, heatmap=None):
    a, b = load(a_path), load(b_path)
    if a.shape != b.shape:
        return {'error': f'size {a.shape} vs {b.shape}'}
    m = ssim_map(luma(a), luma(b))
    h, w = m.shape
    t = 64
    tiles = [m[y:y + t, x:x + t].mean() for y in range(0, h - t + 1, t) for x in range(0, w - t + 1, t)]
    mse = float(((a - b) ** 2).mean())
    diff = np.abs(a - b).max(axis=2)
    res = {
        'ssim': round(float(m.mean()), 5), 'tileMin': round(float(min(tiles)) if tiles else float(m.mean()), 4),
        'psnr': round(10 * np.log10(1.0 / mse), 2) if mse > 0 else 99.0,
        'changedPct': round(100 * float((diff > 8 / 255).mean()), 3),
    }
    if heatmap:
        hm = np.clip((1 - m) * 4, 0, 1)
        img = (np.stack([hm, hm * 0.3, 1 - hm], axis=2) * 255).astype(np.uint8)
        base = (luma(a)[..., None] * 0.5 * 255).astype(np.uint8)
        Image.fromarray(np.maximum(img // 2, base)).save(heatmap)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a', nargs='?')
    ap.add_argument('b', nargs='?')
    ap.add_argument('--heatmap')
    ap.add_argument('--dirs', nargs=2)
    ap.add_argument('--noise')
    ap.add_argument('--noise-json')
    ap.add_argument('--json')
    ap.add_argument('--heatmaps')
    a = ap.parse_args()
    if not a.dirs:
        print(json.dumps(compare(a.a, a.b, a.heatmap)))
        return
    base, cand = Path(a.dirs[0]), Path(a.dirs[1])
    out = {}
    fails = 0
    noise_json = json.loads(Path(a.noise_json).read_text()) if a.noise_json else {}
    if a.heatmaps:
        Path(a.heatmaps).mkdir(parents=True, exist_ok=True)
    # references may be lossless WebP (docs/perf/ref-2026-09: same pixels, 40 % smaller) and candidates PNG: match by stem
    def find(d, stem):
        for ext in ('.png', '.webp'):
            if (d / (stem + ext)).exists():
                return d / (stem + ext)
        return None
    for f in sorted(list(base.glob('*.png')) + list(base.glob('*.webp'))):
        g = find(cand, f.stem)
        if g is None:
            continue
        r = compare(f, g, str(Path(a.heatmaps) / (f.stem + '.png')) if a.heatmaps else None)
        n = None
        nf = find(Path(a.noise), f.stem) if a.noise else None
        nk = next((k for k in (f.name, f.stem + '.png', f.stem + '.webp') if k in noise_json and 'ssim' in noise_json[k]), None)
        if nf is not None:
            n = compare(f, nf)
        elif nk:
            n = {k: noise_json[nk][k] for k in ('ssim', 'tileMin')}
        if 'error' in r:
            r['pass'] = False
            fails += 1
            out[f.name] = r
            print(f"{f.name:40} {r['error']}  FAIL")
            continue
        if n:
            r['noise'] = n
            r['pass'] = r['ssim'] >= min(0.995, n['ssim'] - 0.002) and r['tileMin'] >= n['tileMin'] - 0.02
        else:
            r['pass'] = r['ssim'] >= 0.995 and r['tileMin'] >= 0.95
        fails += 0 if r['pass'] else 1
        out[f.name] = r
        print(f"{f.name:40} ssim {r['ssim']:.4f} tileMin {r['tileMin']:.3f} psnr {r['psnr']:6.2f} changed {r['changedPct']:6.2f}%"
              + (f"  (noise ssim {r['noise']['ssim']:.4f} tileMin {r['noise']['tileMin']:.3f})" if 'noise' in r else '') + ('  PASS' if r['pass'] else '  FAIL'))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
