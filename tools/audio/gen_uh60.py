"""UH-60M Black Hawk: main rotor, blade slap, tail rotor, twin T700 turbines, transmission, rotor wash.

Main rotor: 4 blades, 258 rpm (Nr 100 %) -> 4.3 Hz shaft, 17.2 Hz blade passage. Loops that carry the main
rotor rhythm are exactly 34 revolutions long (7.907 s) so the rhythm wraps seamlessly.
Tail rotor: 4 blades in a 'scissors' arrangement (unequal spacing), ~1190 rpm -> 79 Hz blade passage family.
Runtime: rate = rotorRPM (0..1, 1 = 100 % Nr) for rotor/tail/gearbox layers.
"""
import numpy as np

from dsp import N, SR, bump, circ_filter, hp, lp, place_events, slow_noise, spectral_noise, tvec, undb, write_wav
from synth import Family, am_env, band_am, broadband, comp_tone, rumble

TAU = 2 * np.pi
NR = 258.0 / 60.0            # main rotor rev/s
REVS = 34
L_ROTOR = REVS / NR          # 7.907 s


def blade_times(n, revs, blades, rng, jitter=0.0015, spacing=None):
    rev = n / revs
    spacing = spacing if spacing is not None else [i / blades for i in range(blades)]
    t = []
    bl = []
    for r in range(revs):
        for b, s in enumerate(spacing):
            t.append((r + s) * rev + rng.normal(0, jitter * SR))
            bl.append(b)
    return np.array(t), np.array(bl)


def main_rotor(seed=60):
    n = N(L_ROTOR)
    rng = np.random.default_rng(seed)
    times, bl = blade_times(n, REVS, 4, rng)
    track = np.array([1.0, 0.93, 1.05, 0.97])   # small blade-to-blade track/balance differences -> 1/rev content
    # loading/thickness pulse: smooth bipolar pulse ~12 ms (content 17-250 Hz)
    L = N(0.06)
    tt = (np.arange(L) - L / 2) / SR
    w = 0.0055
    pulse = -tt / w * np.exp(-0.5 * (tt / w) ** 2)
    amps = track[bl] * (1 + 0.08 * rng.standard_normal(len(times)))
    thumps = place_events(n, times - L // 2, pulse, amps)
    thumps /= np.std(thumps)
    # blade swish: broadband modulated at the blade rate (peaks as each advancing blade passes)
    ph = (np.arange(n) * (REVS * 4) / n) % 1.0
    env = np.exp(-0.5 * (np.minimum(ph, 1 - ph) / 0.09) ** 2)
    swish = spectral_noise(n, lambda f: bump(f, 700, 1.2) * hp(f, 150, 2), rng) * (0.25 + env)
    swish *= am_env(n, rng, 0.2, 1.0)
    # rotor wake / low roar
    wake = spectral_noise(n, lambda f: bump(f, 90, 1.0) * hp(f, 20, 2), rng) * am_env(n, rng, 0.3, 2.0)
    y = thumps + 0.45 * swish / np.std(swish) + 0.35 * wake
    return y


def blade_slap(seed=61):
    """BVI: impulsive cracks when blades strike the preceding tip vortices (descent / decelerating turns)."""
    n = N(L_ROTOR)
    rng = np.random.default_rng(seed)
    times, bl = blade_times(n, REVS, 4, rng, jitter=0.0008)
    times = times + N(0.012)  # BVI occurs on the advancing side, slightly after the thickness pulse
    L = N(0.03)
    tt = (np.arange(L) - N(0.004)) / SR
    w = 0.0009
    k = -tt / w * np.exp(-0.5 * (tt / w) ** 2)          # sharp bipolar spike
    k += 0.35 * np.sin(TAU * 420 * tt) * np.exp(-np.maximum(tt, 0) / 0.004) * (tt > 0)
    amps = np.abs(1 + 0.25 * rng.standard_normal(len(times))) * np.array([1.0, 0.8, 1.1, 0.9])[bl]
    y = place_events(n, times, k, amps)
    y = circ_filter(y, lambda f: hp(f, 60, 2) * lp(f, 5000, 1))
    y /= np.std(y)
    # the slap drags a burst of broadband 'crack' noise with it
    ph = (np.arange(n) * (REVS * 4) / n + 0.05) % 1.0
    env = np.exp(-0.5 * (np.minimum(ph, 1 - ph) / 0.02) ** 2)
    y += 0.5 * spectral_noise(n, lambda f: bump(f, 1200, 1.0), rng) * env
    return y


def tail_rotor(seed=62, L=4.0):
    n = N(L)
    rng = np.random.default_rng(seed)
    f_rev = 1190.0 / 60.0
    revs = round(f_rev * L)
    spacing = [0.0, 0.5, 80 / 360, 260 / 360]  # scissors: pairs 80 deg apart
    times, bl = blade_times(n, revs, 4, rng, jitter=0.0002, spacing=sorted(spacing))
    Lk = N(0.012)
    tt = (np.arange(Lk) - Lk / 2) / SR
    w = 0.0011
    k = -tt / w * np.exp(-0.5 * (tt / w) ** 2)
    y = place_events(n, times - Lk // 2, k, 1 + 0.05 * rng.standard_normal(len(times)))
    y = circ_filter(y, lambda f: hp(f, 50, 2) * lp(f, 2500, 2))
    y /= np.std(y)
    ph = (np.arange(n) * (revs * 2) / n) % 1.0
    env = 0.4 + np.exp(-0.5 * (np.minimum(ph, 1 - ph) / 0.12) ** 2)
    y += 0.5 * spectral_noise(n, lambda f: bump(f, 1500, 1.1), rng) * env
    y *= am_env(n, rng, 0.12, 1.5)
    return y


def turbines(seed=63, L=4.0):
    """Two T700-GE-701D: gas-generator whine (Ng ~ 44,700 rpm), slightly different speeds -> beating."""
    n = N(L)
    rng = np.random.default_rng(seed)
    y = np.zeros(n)
    for e, ng in enumerate((745.0, 745.0 * 1.0022)):
        f = Family(n, rng, ng, wander=0.0008, fc=0.6)
        for k, d in ((1, -26), (2, -20), (9, -3), (12.7, -9), (18, -14)):
            ph = f.order_phase(k)
            y += comp_tone(n, rng, ph, d, hay=0.3, hay_f=f.f * k, hay_bw=0.004)
        y += broadband(n, rng, lambda fr: bump(fr, 2600, 1.3), -10, 0.1)
    y += broadband(n, rng, lambda fr: bump(fr, 700, 1.2) * hp(fr, 80, 2), -8, 0.2, 2)  # exhaust
    return y


def gearbox(seed=64):
    """Main transmission (cabin): gear-mesh whine with rotor-rate sidebands."""
    n = N(L_ROTOR)
    rng = np.random.default_rng(seed)
    y = np.zeros(n)
    rot = Family(n, rng, NR * 1.0, wander=0.0)
    for fm, d in ((1012.0, 0), (2024.0, -6), (3130.0, -5), (623.0, -9), (4480.0, -14)):
        k = round(fm / rot.f)
        y += comp_tone(n, rng, rot.order_phase(k), d, hay=0.15, hay_f=rot.f * k, hay_bw=0.002, am_depth=0.1)
        for m, dd in ((1, -12), (4, -14)):
            for s in (-1, 1):
                y += comp_tone(n, rng, rot.order_phase(k + s * m), d + dd + rng.uniform(-3, 3), hay=0.0)
    y += broadband(n, rng, lambda f: bump(f, 2200, 1.2), -9, 0.1)
    # structure-borne rotor thump inside the cabin
    ph = (np.arange(n) * (REVS * 4) / n) % 1.0
    env = np.exp(-0.5 * (np.minimum(ph, 1 - ph) / 0.08) ** 2)
    y += 0.8 * np.std(y) * spectral_noise(n, lambda f: bump(f, 45, 0.6), rng) * env / 0.5
    return y


def wash(seed=65):
    """Rotor downwash: gusty broadband roar with rotor-rate buffeting (hover in ground effect)."""
    n = N(L_ROTOR)
    rng = np.random.default_rng(seed)
    # textured noise needs n % 1024 == 0: build on a padded grid and resample the rhythm onto it is overkill;
    # instead texture a periodic noise by FFT-domain field modulation on the exact rotor loop length.
    base = spectral_noise(n, lambda f: (bump(f, 160, 1.4) + 0.3 * bump(f, 2000, 1.3)) * hp(f, 20, 2), rng)
    lo = circ_filter(base, lambda f: lp(f, 400, 2))
    y = lo * am_env(n, rng, 0.45, 1.2) + (base - lo) * am_env(n, rng, 0.45, 2.5)
    ph = (np.arange(n) * (REVS * 4) / n) % 1.0
    beat = 1 + 0.35 * np.cos(TAU * ph)
    y *= am_env(n, rng, 0.4, 0.6) * band_am(n, rng, 0.2, 3, 12) * beat
    return y


def low_rotor(L=2.0):
    """OLD low-rotor warning (4 Hz 700/850 Hz warble) — not real: the UH-60 tone is steady (TM 1-1520-237-10). Kept only for
    the listening page ("eskiden oyunda"); the shipped warnings are the VWS cycles (gen_voices.gen_uh60)."""
    n = N(L)
    t = tvec(n)
    f = 700 + 150 * np.sign(np.sin(TAU * 4 * t))
    ph = TAU * np.cumsum(f) / SR
    tone = np.sin(ph) + 0.3 * np.sin(3 * ph)
    return tone * 0.8


def main():
    print('[uh60]')
    write_wav('uh60/rotor.wav', main_rotor(), target_lufs=-20, loop=True)
    write_wav('uh60/slap.wav', blade_slap(), target_lufs=-20, loop=True)
    write_wav('uh60/tail.wav', tail_rotor(), target_lufs=-20, loop=True)
    write_wav('uh60/turbine.wav', turbines(), target_lufs=-20, loop=True)
    write_wav('uh60/gearbox.wav', gearbox(), target_lufs=-20, loop=True)
    write_wav('uh60/wash.wav', wash(), target_lufs=-20, loop=True)
    write_wav('candidates/old/uh60/low_rotor.wav', low_rotor(), target_lufs=-20, loop=True)   # old sound, page only


if __name__ == '__main__':
    main()
