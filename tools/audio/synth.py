"""Higher-level synthesis building blocks (turbomachinery tones, jet noise, crackle, buzz-saw, rotors).

All generators return exactly periodic signals of n samples (seamless loops) unless the name says `shot`.
"""
import numpy as np

from dsp import (SR, N, bump, circ_filter, fm_phase, haystack, hp, jet_spectrum, lp, place_events,
                 poisson_times, slow_noise, snap_freq, spectral_noise, tvec, undb)

TAU = 2 * np.pi


def am_env(n, rng, depth, fc, floor=0.05):
    return np.maximum(1 + depth * slow_noise(n, fc, rng), floor)


def band_am(n, rng, depth, f_lo, f_hi, floor=0.05):
    """Amplitude modulation by band-limited noise (f_lo..f_hi Hz) — turbulence 'roughness'."""
    m = spectral_noise(n, lambda f: ((f >= f_lo) & (f <= f_hi)).astype(float) * (1 / np.maximum(f, 1)) ** 0.5, rng)
    return np.maximum(1 + depth * m, floor)


class Family:
    """A spool: shared shaft-speed wander so all its orders move together."""

    def __init__(self, n, rng, f_shaft, wander=0.002, fc=0.7):
        self.n = n
        self.f = snap_freq(f_shaft, n)
        self.dev = wander * slow_noise(n, fc, rng)
        self.base = fm_phase(n, self.f, self.dev)

    def order_phase(self, k):
        # k-th engine order, exactly harmonic (k may be non-integer only for inharmonic partials -> snapped)
        if float(k).is_integer():
            return self.base * k
        return fm_phase(self.n, self.f * k, self.dev)


def comp_tone(n, rng, phase, level_db, hay=0.3, hay_f=None, hay_bw=0.012, am_depth=0.18, am_fc=1.2):
    """Unit-RMS-scaled tonal component: pure line (phase given) mixed with a narrow haystack, with slow AM."""
    pure = np.sqrt(2) * np.sin(phase + rng.uniform(0, TAU))
    y = np.sqrt(1 - hay) * pure
    if hay > 0 and hay_f:
        y = y + np.sqrt(hay) * haystack(n, hay_f, hay_bw, rng)
    return undb(level_db) * y * am_env(n, rng, am_depth, am_fc)


def fan_tones(n, rng, fam, blades, harmonics, sidebands=(), orders=(), am_depth=0.18, hay=0.3, hay_bw=0.012):
    """Blade-passing tones of a spool: harmonics = [(h, dB)], sidebands = [(m, dB)] around BPF, orders = [(k, dB)]."""
    y = np.zeros(n)
    for h, d in harmonics:
        k = blades * h
        y += comp_tone(n, rng, fam.order_phase(k), d, hay=hay, hay_f=fam.f * k, hay_bw=hay_bw, am_depth=am_depth)
    for m, d in sidebands:
        for s in (-1, 1):
            k = blades + s * m
            y += comp_tone(n, rng, fam.order_phase(k), d + rng.uniform(-3, 3), hay=0.0, am_depth=am_depth * 1.5)
    for k, d in orders:
        y += comp_tone(n, rng, fam.order_phase(k), d, hay=0.0, am_depth=am_depth)
    return y


def buzzsaw(n, rng, fam, blades, level_db=0.0, irregular=0.35, lp_hz=3500, kmax_hz=9000, evolve=0.35):
    """Multiple-pure-tone 'buzz-saw' noise of a fan with supersonic tips: irregular sawtooth per revolution."""
    M = 8192
    theta = np.arange(M) / M
    pos = np.sort((np.arange(blades) + rng.normal(0, 0.04, blades)) / blades % 1.0)
    h = np.abs(1 + irregular * rng.standard_normal(blades))
    w = np.zeros(M)
    for i in range(blades):
        a0 = pos[i]
        a1 = pos[(i + 1) % blades] + (1.0 if i == blades - 1 else 0.0)
        span = a1 - a0
        rel = (theta - a0) % 1.0
        seg = rel < span
        w[seg] = h[i] * (0.5 - rel[seg] / span)
    C = np.fft.rfft(w) / M
    K = int(kmax_hz / fam.f)
    mods = [am_env(n, rng, evolve, 0.8) for _ in range(8)]
    y = np.zeros(n)
    for k in range(1, K + 1):
        ck = C[k]
        amp = 2 * abs(ck) * lp(k * fam.f, lp_hz, 2)
        y += amp * mods[rng.integers(8)] * np.cos(fam.base * k + np.angle(ck))
    y /= np.sqrt(np.mean(y * y)) + 1e-12
    return undb(level_db) * y


def broadband(n, rng, shape, level_db=0.0, am_depth=0.1, am_fc=1.0):
    return undb(level_db) * spectral_noise(n, shape, rng) * am_env(n, rng, am_depth, am_fc)


def shocklet_kernels(rng, taus_ms=(0.15, 0.25, 0.4, 0.6, 0.9, 1.3), length_ms=8):
    L = N(length_ms / 1000)
    t = np.arange(L) / SR
    ks = []
    for tau in taus_ms:
        k = np.exp(-t / (tau / 1000))
        k[0] = 1.0
        k -= np.mean(k) * np.exp(-t / 0.003) / np.mean(np.exp(-t / 0.003))  # slow negative tail -> ~zero mean
        ks.append(k)
    return ks


def crackle(n, rng, rate, alpha=2.0, hp_hz=700, lp_hz=12000, max_amp=10.0, gate=None):
    """Jet-noise crackle: random positive shocklets with Pareto amplitudes. gate(t)->0..1 optional density env."""
    times = poisson_times(n, rate * (1.6 if gate is not None else 1.0), rng)
    if gate is not None:
        g = gate[times]
        times = times[rng.uniform(0, 1, len(times)) < g / max(1e-6, g.max())]
    amps = np.minimum(rng.pareto(alpha, len(times)) + 1, max_amp)
    ks = shocklet_kernels(rng)
    y = np.zeros(n)
    idx = rng.integers(len(ks), size=len(times))
    for j, k in enumerate(ks):
        sel = idx == j
        y += place_events(n, times[sel], k, amps[sel])
    y = circ_filter(y, lambda f: hp(f, hp_hz, 2) * lp(f, lp_hz, 2))
    return y / (np.sqrt(np.mean(y * y)) + 1e-12)


def lf_pops(n, rng, rate, f_lo=35, f_hi=80, alpha=2.5, cycles=1.5):
    """Low-frequency combustion pops (windowed sine bursts)."""
    times = poisson_times(n, rate, rng, min_gap=0.03)
    y = np.zeros(n)
    for t0 in times:
        f0 = rng.uniform(f_lo, f_hi)
        L = N(cycles / f0)
        tt = np.arange(L) / SR
        k = np.sin(TAU * f0 * tt) * np.sin(np.pi * np.arange(L) / L) ** 2
        y += place_events(n, [t0], k, [min(rng.pareto(alpha) + 1, 6)])
    return y / (np.sqrt(np.mean(y * y)) + 1e-12)


def jet_noise(n, rng, fpeak, rise=10, fall=16, rough=0.25, rough_band=(4, 40), split_hz=500, slow=0.12,
              lf_hp=18, texture=((0.08, 0.7, 5.0), (0.8, 1.5, 2.5)), return_env=False):
    """Broadband jet mixing noise: textured (eddy 'bursts' reshape the spectrum), fast roughness on the upper band."""
    shape = lambda f: jet_spectrum(f, fpeak, rise, fall) * hp(f, lf_hp, 3)  # noqa: E731
    env = None
    if n % 1024 == 0 and texture:
        base, env = textured_noise(n, shape, rng, fields=texture, return_env=True)
    else:
        base = spectral_noise(n, shape, rng)
    hi = circ_filter(base, lambda f: hp(f, split_hz, 2))
    lo = base - hi
    y = lo * am_env(n, rng, rough * 0.3, 3.0) + hi * band_am(n, rng, rough, *rough_band)
    y *= am_env(n, rng, slow, 0.8)
    y /= np.sqrt(np.mean(y * y)) + 1e-12
    if return_env:
        return y, (env if env is not None else np.ones(n))
    return y


def rumble(n, rng, f0=45, width=0.8, am_depth=0.3, am_fc=3.0):
    y = spectral_noise(n, lambda f: bump(f, f0, width) * hp(f, 14, 3), rng)
    return y * am_env(n, rng, am_depth, am_fc)


# --------------------------------------------------------------------------------------------------- one-shot bits
def thump(dur, f0=38, decay=0.12, rng=None, click=0.0):
    """Low-frequency pressure thump (pitch dropping), optional click transient."""
    n = N(dur)
    t = tvec(n)
    f = f0 * (1 + 0.8 * np.exp(-t / 0.02))
    ph = TAU * np.cumsum(f) / SR
    y = np.sin(ph) * np.exp(-t / decay) * (1 - np.exp(-t / 0.002))
    if click and rng is not None:
        c = rng.standard_normal(n) * np.exp(-t / 0.004)
        c = circ_filter(c, lambda fr: hp(fr, 800, 2) * lp(fr, 6000, 2))
        y += click * c / (np.max(np.abs(c)) + 1e-9)
    return y


def noise_burst(dur, rng, shape, attack=0.01, decay=0.2, hold=0.0):
    n = N(dur)
    t = tvec(n)
    x = spectral_noise(n, shape, rng)
    env = np.minimum(1, t / max(attack, 1e-4)) * np.exp(-np.maximum(t - attack - hold, 0) / decay)
    return x * env


def metal_clunk(rng, dur=0.5, modes=None, strike_ms=3.0, noise_amt=0.6, lp_hz=5000, damp=0.45, spread=6):
    """Impact on a (damped, bolted) metal structure: a noise strike exciting clusters of inharmonic modes.

    Each nominal mode (f, decay_s, gain) is split into `spread` detuned partials (±12 %) with decay scaled by `damp`
    (real airframe structures are heavily damped: a 'clunk', not a bell), plus the strike's own filtered noise body.
    """
    from dsp import modal
    n = N(dur)
    t = tvec(n)
    exc = rng.standard_normal(n) * np.exp(-t / (strike_ms / 1000))
    exc = circ_filter(exc, lambda f: lp(f, lp_hz, 2))
    if modes is None:
        modes = [(120, 0.08, 1.0), (210, 0.06, 0.8), (380, 0.05, 0.7), (720, 0.03, 0.5), (1350, 0.02, 0.35),
                 (2400, 0.012, 0.25)]
    parts = []
    for f0, d, g in modes:
        for _ in range(spread):
            parts.append((f0 * rng.uniform(0.88, 1.12), d * damp * rng.uniform(0.6, 1.2), g * rng.uniform(0.4, 1.0)))
    y = modal(exc, parts)
    y = y / (np.max(np.abs(y)) + 1e-9)
    body = circ_filter(rng.standard_normal(n), lambda f: bump(f, modes[0][0] * 2.5, 1.4)) * np.exp(-t / 0.025)
    y = y + noise_amt * 0.6 * body / (np.max(np.abs(body)) + 1e-9) + noise_amt * 0.4 * exc / (np.max(np.abs(exc)) + 1e-9)
    tail = np.minimum(1, (dur - t) / (0.3 * dur))              # never truncate a ringing mode
    return y * np.clip(tail, 0, 1)


# ------------------------------------------------------------------------------------------ textured turbulence noise
def loop_len(seconds, hop=1024):
    """Sample count close to `seconds` that is a multiple of the STFT hop (keeps textured noise periodic)."""
    return max(hop * 8, int(round(seconds * SR / hop)) * hop)


def textured_noise(n, shape, rng, win=4096, hop=1024, fields=((0.10, 0.8, 5.0), (0.9, 1.5, 2.5)), return_env=False):
    """Periodic noise whose spectrum 'breathes' like real turbulence.

    Each STFT frame is independent complex-Gaussian noise shaped by shape(f) × 10^(G(t,f)/20), where G is a smooth
    random field (sum of `fields` = (time correlation s, frequency correlation octaves, depth dB)). Frames are
    overlap-added on a circular timeline, so the result loops seamlessly. n must be a multiple of hop.
    """
    from scipy.ndimage import gaussian_filter
    assert n % hop == 0, 'n must be a multiple of hop'
    M = n // hop
    fr = np.fft.rfftfreq(win, 1 / SR)
    base = shape(fr) if callable(shape) else shape
    base = np.asarray(base, dtype=float)
    base[0] = 0.0
    B = 64
    band_lo, band_hi = np.log2(15.0), np.log2(22000.0)
    centers = np.linspace(band_lo, band_hi, B)
    oct_per_band = (band_hi - band_lo) / (B - 1)
    G = np.zeros((M, B))
    for tc, fc, depth in fields:
        f0 = rng.standard_normal((M, B))
        f0 = gaussian_filter(f0, sigma=(max(0.5, tc * SR / hop), max(0.5, fc / oct_per_band)), mode=('wrap', 'nearest'))
        f0 -= f0.mean(axis=0, keepdims=True)          # keep the long-term spectrum equal to `shape`
        f0 /= (f0.std() + 1e-12)
        G += depth * f0
    lf = np.log2(np.maximum(fr, 15.0))
    w = np.hanning(win + 1)[:-1]
    y = np.zeros(n)
    for m in range(M):
        g = undb(np.interp(lf, centers, G[m]))
        X = (rng.standard_normal(len(fr)) + 1j * rng.standard_normal(len(fr))) * base * g
        frame = np.fft.irfft(X, win) * w
        start = (m * hop - win // 2) % n
        end = start + win
        if end <= n:
            y[start:end] += frame
        else:
            k = n - start
            y[start:] += frame[:k]
            y[:end - n] += frame[k:]
    y /= np.sqrt(np.mean(y * y)) + 1e-12
    if return_env:
        # per-sample loudness envelope of the low/mid field (for gating crackle to the loud eddies)
        env_frames = undb(G[:, (centers > np.log2(60)) & (centers < np.log2(1500))].mean(axis=1))
        env = np.interp(np.arange(n), np.arange(M) * hop, env_frames, period=n)
        return y, env
    return y
