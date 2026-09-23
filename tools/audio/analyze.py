"""Analyse generated WAVs: spectrogram, long-term spectrum, level curve, loop-seam check.

Usage: .venv/bin/python tools/audio/analyze.py <out_dir> <wav or dir> [...]
Writes one PNG per input group (<= 6 files per sheet) and prints a table (peak, LUFS, seam metric).
Seam metric: max |2nd difference| in a 64-sample window around the wrap point, relative to the 99.9th
percentile of |2nd difference| over the whole loop (values ~<= 1 mean the seam is indistinguishable).
"""
import glob
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import signal  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from dsp import SR, lufs, peak_dbfs, read_wav  # noqa: E402


def seam_metric(x):
    y = np.concatenate([x[-512:], x[:512]])
    d2 = np.abs(np.diff(y, 2))
    seam = d2[512 - 32:512 + 32].max()
    ref = np.percentile(np.abs(np.diff(x, 2)), 99.9) + 1e-12
    return seam / ref


def analyse(files, out_png, title=''):
    n = len(files)
    fig, axes = plt.subplots(n, 3, figsize=(18, 2.6 * n), squeeze=False,
                             gridspec_kw={'width_ratios': [3, 1.4, 1.4]})
    rows = []
    for i, f in enumerate(files):
        x = read_wav(f)
        name = os.path.relpath(f, os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'audio'))
        loop = True
        sm = seam_metric(x)
        pk, ld = peak_dbfs(x), lufs(x)
        rows.append((name, len(x) / SR, pk, ld, sm))
        ax = axes[i][0]
        nper = 2048
        fr, tt, S = signal.spectrogram(x, SR, nperseg=nper, noverlap=nper * 3 // 4, window='hann')
        S = 10 * np.log10(S + 1e-14)
        vmax = S.max()
        ax.pcolormesh(tt, fr[1:], S[1:], vmin=vmax - 80, vmax=vmax, shading='auto', cmap='magma')
        ax.set_yscale('log'); ax.set_ylim(20, 20000)
        ax.set_title(f'{name}  {len(x)/SR:.2f}s  peak {pk:.1f} dBFS  {ld:.1f} LUFS  seam {sm:.2f}', fontsize=9)
        ax.set_ylabel('Hz')
        ax2 = axes[i][1]
        fw, P = signal.welch(x, SR, nperseg=8192)
        ax2.semilogx(fw[1:], 10 * np.log10(P[1:] + 1e-16))
        ax2.set_xlim(15, 20000); ax2.grid(True, which='both', alpha=0.3)
        ax2.set_title('long-term spectrum (dB)', fontsize=8)
        ax3 = axes[i][2]
        blk = int(0.02 * SR)
        m = len(x) // blk
        env = 20 * np.log10(np.sqrt(np.mean(x[:m * blk].reshape(m, blk) ** 2, axis=1)) + 1e-9)
        ax3.plot(np.arange(m) * 0.02, env)
        # seam zoom inset: last 5 ms + first 5 ms
        k = int(0.005 * SR)
        z = np.concatenate([x[-k:], x[:k]])
        ax3b = ax3.inset_axes([0.55, 0.05, 0.43, 0.4])
        ax3b.plot(z, lw=0.6); ax3b.axvline(k, color='r', lw=0.6); ax3b.set_xticks([]); ax3b.set_yticks([])
        ax3.set_title('RMS 20 ms (dBFS) + seam zoom', fontsize=8)
        ax3.set_ylim(-80, 0); ax3.grid(alpha=0.3)
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(out_png, dpi=72)
    plt.close(fig)
    return rows


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for a in sys.argv[2:]:
        if os.path.isdir(a):
            files += sorted(glob.glob(os.path.join(a, '*.wav')))
        else:
            files.append(a)
    tag = os.path.basename(os.path.normpath(sys.argv[2])) if len(sys.argv) == 3 else 'set'
    all_rows = []
    for gi in range(0, len(files), 6):
        grp = files[gi:gi + 6]
        png = os.path.join(out_dir, f'{tag}_{gi // 6:02d}.png')
        all_rows += analyse(grp, png, f'{tag} sheet {gi // 6}')
        print('wrote', png)
    print(f"{'file':42s} {'dur':>6s} {'peak':>6s} {'LUFS':>6s} {'seam':>6s}")
    for r in all_rows:
        print(f'{r[0]:42s} {r[1]:6.2f} {r[2]:6.1f} {r[3]:6.1f} {r[4]:6.2f}')


if __name__ == '__main__':
    main()
