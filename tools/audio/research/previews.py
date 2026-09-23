"""Listening previews for the warning-sound research: 48 kHz / 16-bit mono WAV, trimmed and level-matched.

make_preview(src, dst, segment=None, loop=False, repeat_to=None, target_db=-20.0)
  * segment [start, end] (s) cuts the event out of a longer original (video soundtrack excerpt);
  * silence before/after the sound is trimmed (frames 45 dB below the loudest 20 ms frame; 60 ms padding) unless
    `loop` is set — loop files are kept whole so their rhythm/spacing survives, and optionally repeated to ~repeat_to s;
  * level: K-weighted (BS.1770) RMS of the active frames (within 20 dB of the loudest) set to target_db, then scaled
    down if the peak would exceed -1 dBFS (no limiter, no EQ — the recording itself is not altered);
  * 4 ms fades.
The preview is for A/B listening only; the unmodified original stays in orig/.
"""
import os
import subprocess

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
# BS.1770 K-weighting at 48 kHz (same as tools/audio/dsp.py)
_K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]),
       np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def decode(path, segment=None):
    cmd = ['ffmpeg', '-v', 'error']
    if segment:
        cmd += ['-ss', f'{segment[0]:.3f}', '-to', f'{segment[1]:.3f}']
    cmd += ['-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-af', 'aresample=resampler=soxr', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    if not raw:   # soxr missing in this ffmpeg build → default resampler
        cmd = [c for c in cmd if c not in ('-af', 'aresample=resampler=soxr')]
        raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def frames_db(x, win):
    n = max(1, len(x) // win)
    e = np.mean(x[:n * win].reshape(n, win) ** 2, axis=1) if len(x) >= win else np.array([np.mean(x * x)])
    return 10 * np.log10(e + 1e-20)


def trim(x, floor_db=45, pad=0.06):
    win = int(0.02 * SR)
    f = frames_db(x, win)
    on = np.where(f > f.max() - floor_db)[0]
    if not len(on):
        return x
    a = max(0, on[0] * win - int(pad * SR))
    b = min(len(x), (on[-1] + 1) * win + int(pad * SR))
    return x[a:b]


def active_level_db(x):
    y = signal.lfilter(*_K2, signal.lfilter(*_K1, x))
    f = frames_db(y, int(0.05 * SR))
    act = f[f > f.max() - 20]
    return 10 * np.log10(np.mean(10 ** (act / 10)) + 1e-20)


def make_preview(src, dst, segment=None, loop=False, repeat_to=None, target_db=-20.0, gap=0.0):
    x = decode(src, segment)
    if not len(x):
        raise RuntimeError(f'could not decode {src}')
    x = x - np.mean(x)
    if not loop:
        x = trim(x)
    if repeat_to:
        reps = max(1, int(np.ceil(repeat_to / (len(x) / SR + gap))))
        g = np.zeros(int(gap * SR))
        x = np.concatenate([np.concatenate([x, g]) for _ in range(reps)])[:len(x) * reps + len(g) * (reps - 1)]
    x = x * 10 ** ((target_db - active_level_db(x)) / 20)
    pk = np.max(np.abs(x))
    if pk > 10 ** (-1 / 20):
        x = x * 10 ** (-1 / 20) / pk
    fl = min(len(x) // 4, int(0.004 * SR))
    if fl > 1:
        x[:fl] *= np.linspace(0, 1, fl)
        x[-fl:] *= np.linspace(1, 0, fl)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    wavfile.write(dst, SR, np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16))
    return {'dur': round(len(x) / SR, 3), 'peak_dbfs': round(20 * np.log10(np.max(np.abs(x)) + 1e-12), 1)}


if __name__ == '__main__':
    import sys
    a = sys.argv[1:]
    print(make_preview(a[0], a[1], segment=[float(a[2]), float(a[3])] if len(a) >= 4 else None))
