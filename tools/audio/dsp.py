"""Offline DSP toolkit for the Gökyüzü SF sound synthesis (numpy/scipy only).

Design principle: every loop is generated as an exactly periodic signal (FFT-domain noise with random phases,
tones with an integer number of cycles per loop, periodic modulation envelopes, events placed on a circular
timeline, and IIR/nonlinear processing done on three tiled copies with the middle copy kept). Loops therefore
wrap without any click and need no crossfade. `make_loop_seamless()` is still available as a safety net.
"""
import os
import subprocess
import tempfile

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'audio')


# ----------------------------------------------------------------------------------------------------------- basics
def N(seconds):
    return int(round(seconds * SR))


def tvec(n):
    return np.arange(n) / SR


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-20))


def db(x):
    return 20 * np.log10(np.maximum(np.abs(x), 1e-12))


def undb(d):
    return 10 ** (d / 20)


def normalize_rms(x, target=1.0):
    return x * (target / rms(x))


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------------------------- spectral shaping
def freqs_for(n):
    return np.fft.rfftfreq(n, 1 / SR)


def lp(f, fc, order=2):
    return 1 / np.sqrt(1 + (np.asarray(f) / fc) ** (2 * order))


def hp(f, fc, order=2):
    f = np.maximum(np.asarray(f, dtype=float), 1e-6)
    return 1 / np.sqrt(1 + (fc / f) ** (2 * order))


def bump(f, f0, oct_width=1.0):
    """Gaussian bump in log-frequency (1.0 at f0, oct_width = std-dev in octaves)."""
    f = np.maximum(np.asarray(f, dtype=float), 1e-3)
    return np.exp(-0.5 * (np.log2(f / f0) / oct_width) ** 2)


def peak_db(f, f0, gain_db, oct_width=0.5):
    return undb(gain_db * bump(f, f0, oct_width))


def tilt(f, db_per_oct, ref=1000.0):
    f = np.maximum(np.asarray(f, dtype=float), 1.0)
    return undb(db_per_oct * np.log2(f / ref))


def jet_spectrum(f, fpeak, rise=10.0, fall=18.0):
    """Similarity-like jet-noise shape: rises `rise` dB/decade to fpeak, falls `fall` dB/decade above (smooth knee)."""
    f = np.maximum(np.asarray(f, dtype=float), 1.0)
    x = np.log10(f / fpeak)
    # smooth piecewise-linear in log-log space
    k = 3.0
    lo = rise * x
    hi = -fall * x
    d = -np.log(np.exp(-k * lo / 10) + np.exp(-k * hi / 10)) * 10 / k  # soft-min in dB
    return undb(d)


# -------------------------------------------------------------------------------------------- periodic generators
def spectral_noise(n, shape, rng):
    """Exactly periodic Gaussian noise of length n whose magnitude spectrum follows shape(f) (callable or array)."""
    f = freqs_for(n)
    mag = shape(f) if callable(shape) else shape
    mag = np.asarray(mag, dtype=float).copy()
    mag[0] = 0.0
    X = (rng.standard_normal(len(f)) + 1j * rng.standard_normal(len(f))) * mag
    x = np.fft.irfft(X, n)
    return x / rms(x)


def slow_noise(n, fc, rng, order=2):
    """Periodic smooth random signal (unit RMS) with content below ~fc Hz."""
    return spectral_noise(n, lambda f: lp(f, fc, order) * (f > 0), rng)


def circ_filter(x, shape):
    """Zero-phase circular filtering by a magnitude response shape(f)."""
    X = np.fft.rfft(x)
    f = freqs_for(len(x))
    X *= shape(f) if callable(shape) else shape
    return np.fft.irfft(X, len(x))


def snap_freq(f, n):
    """Nearest frequency with an integer number of cycles in n samples."""
    L = n / SR
    return max(1, round(f * L)) / L


def fm_phase(n, f0, dev=None):
    """Phase (radians) of a tone at f0 (snapped) with relative frequency deviation dev(t) (periodic, zero mean)."""
    f0 = snap_freq(f0, n)
    t = tvec(n)
    ph = 2 * np.pi * f0 * t
    if dev is not None:
        d = dev - np.mean(dev)
        integ = np.cumsum(d) / SR
        integ -= t * (integ[-1] / (n / SR))
        ph += 2 * np.pi * f0 * integ
    return ph


def tone(n, f0, amp=1.0, dev=None, phase0=0.0):
    return amp * np.sin(fm_phase(n, f0, dev) + phase0)


def haystack(n, f0, rel_bw, rng):
    """Narrow-band noise centred on f0 (turbulence-broadened tone), unit RMS, periodic."""
    bw = max(f0 * rel_bw, 0.8)
    return spectral_noise(n, lambda f: np.exp(-0.5 * ((f - f0) / bw) ** 2), rng)


def process_periodic(x, fn, *aux):
    """Run a causal/stateful process fn(x3, *aux3) on three tiled copies and keep the middle one (seamless)."""
    n = len(x)
    y = fn(np.tile(x, 3), *[np.tile(a, 3) for a in aux])
    return y[n:2 * n]


def lfilter_periodic(b, a, x):
    return process_periodic(x, lambda z: signal.lfilter(b, a, z))


def place_events(n, times, kernel, amps=None):
    """Add kernel copies at the given sample times on a circular timeline of length n."""
    y = np.zeros(n)
    k = len(kernel)
    for i, t0 in enumerate(times):
        a = 1.0 if amps is None else amps[i]
        t0 = int(t0) % n
        end = t0 + k
        if end <= n:
            y[t0:end] += a * kernel
        else:
            m = n - t0
            y[t0:] += a * kernel[:m]
            y[:end - n] += a * kernel[m:]
    return y


def poisson_times(n, rate, rng, min_gap=0.0):
    """Random event times (samples) with mean rate (Hz) over a loop of n samples."""
    count = rng.poisson(rate * n / SR)
    t = np.sort(rng.uniform(0, n, count))
    if min_gap > 0 and len(t) > 1:
        keep = [t[0]]
        for v in t[1:]:
            if v - keep[-1] >= min_gap * SR:
                keep.append(v)
        t = np.array(keep)
    return t.astype(int)


# --------------------------------------------------------------------------------------------------- IIR helpers
def biquad(kind, f0, q=0.707, gain_db=0.0):
    """RBJ cookbook biquad coefficients (b, a)."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * q)
    if kind == 'lowpass':
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'highpass':
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'bandpass':
        b = [alpha, 0, -alpha]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == 'peak':
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]; a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == 'lowshelf':
        sa = 2 * np.sqrt(A) * alpha
        b = [A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)]
        a = [(A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa]
    elif kind == 'highshelf':
        sa = 2 * np.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)]
        a = [(A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa]
    else:
        raise ValueError(kind)
    b = np.array(b) / a[0]; a = np.array(a) / a[0]
    return b, a


def bq(x, kind, f0, q=0.707, gain_db=0.0):
    b, a = biquad(kind, f0, q, gain_db)
    return signal.lfilter(b, a, x)


def butter(x, kind, fc, order=2):
    sos = signal.butter(order, fc, btype=kind, fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def resonator(x, f0, decay_s, gain=1.0):
    """Two-pole resonator (ringing mode) excited by x."""
    r = np.exp(-1 / (decay_s * SR))
    w = 2 * np.pi * f0 / SR
    a = [1, -2 * r * np.cos(w), r * r]
    b = [(1 - r) * gain]
    return signal.lfilter(b, a, x)


def modal(x, modes):
    """Sum of resonators: modes = [(freq, decay_s, gain), ...]."""
    y = np.zeros_like(x)
    for f0, d, g in modes:
        y += resonator(x, f0, d, g)
    return y


# ---------------------------------------------------------------------------------------------- envelopes, shots
def env_adsr(n, a, d, s, r, sustain_level=0.7):
    """Linear-ish ADSR envelope of n samples (a/d/r in seconds, s derived from n)."""
    e = np.zeros(n)
    ia, idd, ir = N(a), N(d), N(r)
    isus = max(0, n - ia - idd - ir)
    seg = []
    seg.append(np.linspace(0, 1, max(ia, 1), endpoint=False))
    seg.append(np.linspace(1, sustain_level, max(idd, 1), endpoint=False))
    seg.append(np.full(isus, sustain_level))
    seg.append(np.linspace(sustain_level, 0, max(ir, 1)))
    e0 = np.concatenate(seg)[:n]
    e[:len(e0)] = e0
    return e


def exp_decay(n, tau, delay=0):
    t = tvec(n) - delay
    e = np.exp(-np.maximum(t, 0) / tau)
    e[t < 0] = 0
    return e


def fade(x, fin=0.002, fout=0.01):
    y = x.copy()
    a, b = N(fin), N(fout)
    if a > 0:
        y[:a] *= np.linspace(0, 1, a) ** 2
    if b > 0:
        y[-b:] *= np.linspace(1, 0, b) ** 2
    return y


def white(n, rng):
    return rng.standard_normal(n)


def shaped_burst(n, rng, shape):
    """Non-periodic noise burst with spectral shape (for one-shots)."""
    return spectral_noise(n, shape, rng)


def soft_clip(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


# ------------------------------------------------------------------------------------------------ loudness / io
_K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]),
       np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def lufs(x):
    """Ungated BS.1770 loudness (fine for steady loops); gated for one-shots with 400 ms blocks."""
    y = signal.lfilter(*_K1, x)
    y = signal.lfilter(*_K2, y)
    blk = N(0.4)
    if len(y) < blk * 2:
        return -0.691 + 10 * np.log10(np.mean(y * y) + 1e-20)
    hop = blk // 4
    ms = np.array([np.mean(y[i:i + blk] ** 2) for i in range(0, len(y) - blk, hop)])
    l = -0.691 + 10 * np.log10(ms + 1e-20)
    ms = ms[l > -70]
    if len(ms) == 0:
        return -99.0
    rel = -0.691 + 10 * np.log10(np.mean(ms)) - 10
    l2 = -0.691 + 10 * np.log10(ms + 1e-20)
    ms2 = ms[l2 > rel]
    return -0.691 + 10 * np.log10(np.mean(ms2) + 1e-20)


def peak_dbfs(x):
    return float(20 * np.log10(np.max(np.abs(x)) + 1e-12))


def master(x, target_lufs=None, peak_ceiling_db=-1.0):
    """Scale to target loudness (if given) and enforce the peak ceiling (by lowering gain, never clipping)."""
    y = np.asarray(x, dtype=float)
    y = y - np.mean(y)
    if target_lufs is not None:
        y = y * undb(target_lufs - lufs(y))
    pk = np.max(np.abs(y)) + 1e-12
    ceil = undb(peak_ceiling_db)
    if pk > ceil:
        y = y * (ceil / pk)
    return y


def limit_peaks(x, ceiling_db=-1.0, knee=0.8):
    """Gentle soft-knee limiter (sample-wise tanh above knee*ceiling), keeps loudness while taming spikes."""
    c = undb(ceiling_db)
    k = knee * c
    y = x.copy()
    over = np.abs(y) > k
    s = np.sign(y[over])
    e = np.abs(y[over]) - k
    y[over] = s * (k + (c - k) * np.tanh(e / (c - k)))
    return y


def write_wav(rel_path, x, target_lufs=None, peak_db=-1.0, loop=False, soft_limit=True):
    """Write a mono 16-bit 48 kHz WAV under assets/audio/. Returns stats dict.

    Loops with rare extreme peaks (crackle, bursts) are soft-limited (tanh knee from -7 dBFS) so they still reach
    the loudness target instead of being scaled down as a whole.
    """
    path = os.path.join(OUT, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if loop and soft_limit and target_lufs is not None:
        y = np.asarray(x, dtype=float) - np.mean(x)
        for _ in range(3):
            y = y * undb(target_lufs - lufs(y))
            y = limit_peaks(y, peak_db, knee=0.45)
            y = circ_filter(y, lambda f: lp(f, 16000, 4))   # remove limiter harmonics near Nyquist (periodic)
        x = y
    y = master(x, target_lufs if not (loop and soft_limit) else None, peak_db)
    if loop:
        y = y - np.mean(y)
    q = np.clip(np.round(y * 32767), -32768, 32767).astype(np.int16)
    wavfile.write(path, SR, q)
    st = {'file': rel_path, 'dur': len(y) / SR, 'peak': peak_dbfs(y), 'lufs': lufs(y), 'loop': loop,
          'kb': os.path.getsize(path) / 1024}
    print(f"  {rel_path:40s} {st['dur']:6.2f}s  peak {st['peak']:6.1f} dBFS  {st['lufs']:6.1f} LUFS  {st['kb']:7.0f} KB")
    return st


def read_wav(path):
    sr, x = wavfile.read(path)
    x = x.astype(float)
    if x.dtype != float or np.max(np.abs(x)) > 2:
        x = x / 32768.0
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        from math import gcd
        g = gcd(sr, SR)
        x = signal.resample_poly(x, SR // g, sr // g)
    return x


def make_loop_seamless(x, xfade_s=0.25):
    """Classic crossfade loop (tail blended into head) for non-periodic material."""
    n = N(xfade_s)
    y = x[:-n].copy()
    w = np.linspace(0, 1, n)
    wi, wo = np.sqrt(w), np.sqrt(1 - w)
    y[:n] = y[:n] * wi + x[-n:] * wo
    return y


# ------------------------------------------------------------------------------------------------------- speech
def say(text, voice, rate=None, pitch=None):
    """Render text with macOS `say` and return float samples at SR (trimmed)."""
    with tempfile.TemporaryDirectory() as td:
        aiff = os.path.join(td, 'v.aiff')
        wav = os.path.join(td, 'v.wav')
        cmd = ['say', '-v', voice, '-o', aiff]
        if rate:
            cmd += ['-r', str(rate)]
        txt = text if pitch is None else f'[[pbas {pitch}]] {text}'
        cmd.append(txt)
        subprocess.run(cmd, check=True)
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', f'LEI16@{SR}', aiff, wav], check=True, capture_output=True)
        x = read_wav(wav)
    return trim_silence(x)


def trim_silence(x, thresh_db=-45, pad=0.02):
    env = np.abs(x)
    th = undb(thresh_db) * np.max(env)
    idx = np.where(env > th)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - N(pad))
    b = min(len(x), idx[-1] + N(pad * 2))
    return x[a:b]
