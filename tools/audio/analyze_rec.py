"""Analyse a runtime recording (from probe.mjs): spectrogram, level curve, per-segment loudness + spectra.

Usage: .venv/bin/python tools/audio/analyze_rec.py rec.wav out.png [--seg 3,3,3,...] [--title text]
--seg: segment durations (s) matching a probe --seq; prints LUFS/peak/centroid per segment and overlays spectra.
"""
import sys
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy import signal  # noqa: E402
from scipy.io import wavfile  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from dsp import lufs  # noqa: E402


def main():
    path, out = sys.argv[1], sys.argv[2]
    segs = None
    if '--seg' in sys.argv:
        segs = [float(v) for v in sys.argv[sys.argv.index('--seg') + 1].split(',')]
    title = sys.argv[sys.argv.index('--title') + 1] if '--title' in sys.argv else os.path.basename(path)
    sr, x = wavfile.read(path)
    x = x.astype(float) / 32768
    mono = x.mean(axis=1) if x.ndim > 1 else x
    rows = 3 if segs else 2
    fig, ax = plt.subplots(rows, 1, figsize=(16, 3.2 * rows), squeeze=False)
    ax = ax[:, 0]
    f, t, S = signal.spectrogram(mono, sr, nperseg=4096, noverlap=3072)
    S = 10 * np.log10(S + 1e-14)
    ax[0].pcolormesh(t, f[1:], S[1:], vmin=S.max() - 85, vmax=S.max(), shading='auto', cmap='magma')
    ax[0].set_yscale('log'); ax[0].set_ylim(20, 20000); ax[0].set_title(title)
    blk = int(0.05 * sr)
    m = len(mono) // blk
    for ch, lab in ((0, 'L'), (1, 'R')) if x.ndim > 1 else ((None, 'M'),):
        y = x[:, ch] if ch is not None else mono
        env = 10 * np.log10(np.mean(y[:m * blk].reshape(m, blk) ** 2, axis=1) + 1e-12)
        ax[1].plot(np.arange(m) * 0.05, env, label=f'RMS {lab}', lw=0.8)
    pk = 20 * np.log10(np.max(np.abs(mono[:m * blk].reshape(m, blk)), axis=1) + 1e-9)
    ax[1].plot(np.arange(m) * 0.05, pk, label='peak', lw=0.5, alpha=0.6)
    ax[1].set_ylim(-70, 0); ax[1].grid(alpha=0.3); ax[1].legend(loc='lower right'); ax[1].set_xlim(0, len(mono) / sr)
    if segs:
        t0 = 0.0
        print(f"{'seg':>4} {'t0':>6} {'LUFS':>7} {'peak':>6} {'centroid':>9} {'L-R dB':>7}")
        for i, d in enumerate(segs):
            a, b = int((t0 + d * 0.3) * sr), int((t0 + d) * sr)
            seg = mono[a:b]
            if len(seg) < sr * 0.3:
                break
            fw, P = signal.welch(seg, sr, nperseg=8192)
            cen = np.sum(fw * P) / np.sum(P)
            lr = 0.0
            if x.ndim > 1:
                lr = 10 * np.log10(np.mean(x[a:b, 0] ** 2) + 1e-12) - 10 * np.log10(np.mean(x[a:b, 1] ** 2) + 1e-12)
            print(f'{i:4d} {t0:6.1f} {lufs(seg):7.1f} {20*np.log10(np.max(np.abs(seg))+1e-9):6.1f} {cen:9.0f} {lr:7.1f}')
            ax[2].semilogx(fw[1:], 10 * np.log10(P[1:] + 1e-16), lw=0.8, label=f'seg {i}')
            ax[1].axvline(t0, color='k', lw=0.4)
            t0 += d
        ax[2].set_xlim(20, 20000); ax[2].grid(True, which='both', alpha=0.3); ax[2].legend(fontsize=7, ncol=4)
    fig.tight_layout()
    fig.savefig(out, dpi=70)
    print('wrote', out)


if __name__ == '__main__':
    main()
