"""Voice warnings (macOS `say` + processing) and synthetic cockpit alert tones.

F-16/F-22  'Bitching Betty' (Samantha, headset/radio band, slight grit)
A320neo    FWC/EGPWS synthetic male (Rocko, digitised, cockpit loudspeaker) + single chime, CRC, cavalry charge,
           cricket, C-chord
737-800    EGPWS male (Reed, cockpit loudspeaker) + stick shaker, overspeed clacker, A/P disconnect wailer, whoop,
           chime
UH-60M     female voice (Shelley) + low-rotor tone (in gen_uh60)
"""
import warnings

import numpy as np
from scipy import signal

from dsp import (N, SR, bump, butter, circ_filter, fade, hp, lp, modal, say, soft_clip, spectral_noise, tvec, undb,
                 write_wav, bq)

warnings.filterwarnings('ignore')
TAU = 2 * np.pi

BETTY = 'Samantha'
AIRBUS = 'Rocko (İngilizce (ABD))'
BOEING = 'Reed (İngilizce (ABD))'
HELO = 'Shelley (İngilizce (ABD))'


def compress(x, thresh_db=-18, ratio=3.0, att=0.003, rel=0.08):
    env = np.abs(x)
    a1, r1 = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    e = np.zeros_like(x)
    s = 0.0
    for i, v in enumerate(env):  # simple peak follower (voice files are short)
        s = a1 * s + (1 - a1) * v if v > s else r1 * s + (1 - r1) * v
        e[i] = s
    ldb = 20 * np.log10(e + 1e-9)
    over = np.maximum(ldb - thresh_db, 0)
    g = undb(-over * (1 - 1 / ratio))
    return x * g


def radio(x, rng, grit=2.2, hiss_db=-38):
    """Headset / intercom: 300-3400 Hz band, compression, mild saturation, faint hiss."""
    y = butter(x, 'highpass', 320, 4)
    y = butter(y, 'lowpass', 3600, 4)
    y = bq(y, 'peak', 1900, 1.2, 4)
    y = compress(y / np.max(np.abs(y)), -20, 4)
    y = soft_clip(y / np.max(np.abs(y)) * grit, 1.0)
    pad = N(0.04)
    y = np.concatenate([np.zeros(pad), y, np.zeros(N(0.08))])
    h = spectral_noise(len(y), lambda f: bump(f, 2000, 1.0), rng) * undb(hiss_db)
    env = np.convolve((np.abs(y) > 0.01).astype(float), np.ones(N(0.06)) / N(0.06), 'same')
    return fade(y + h * np.clip(env * 3, 0, 1), 0.01, 0.03)


def speaker(x, rng, digitise=16000, room=True, lo=220, hi=5200, res=2400):
    """Cockpit loudspeaker: digitised (reduced sample rate), speaker band + resonance, small-room reflections."""
    if digitise:
        from math import gcd
        g = gcd(SR, digitise)
        x = signal.resample_poly(x, digitise // g, SR // g)
        x = np.round(x / np.max(np.abs(x)) * 2047) / 2047  # 12-bit
        x = signal.resample_poly(x, SR // g, digitise // g)
    y = butter(x, 'highpass', lo, 3)
    y = butter(y, 'lowpass', hi, 3)
    y = bq(y, 'peak', res, 1.5, 5)
    y = bq(y, 'peak', 850, 1.0, 2)
    y = soft_clip(compress(y / np.max(np.abs(y)), -16, 3) * 1.6, 1.0)
    y = np.concatenate([np.zeros(N(0.01)), y, np.zeros(N(0.07))])
    if room:
        out = y.copy()
        for d, a in ((0.0017, 0.28), (0.0031, -0.2), (0.0046, 0.14), (0.0072, 0.1), (0.011, 0.07)):
            k = N(d)
            out[k:] += a * y[:-k]
        tail = spectral_noise(N(0.12), lambda f: bump(f, 1500, 1.5), rng) * np.exp(-tvec(N(0.12)) / 0.03)
        out += 0.05 * np.convolve(y, tail / np.sum(np.abs(tail)) * 8, 'full')[:len(y)]
        y = out
    return fade(y, 0.005, 0.05)


def voice(text, v, rate=None):
    return say(text, v, rate=rate)


def silence(s):
    return np.zeros(N(s))


# ------------------------------------------------------------------------------------------------ alert tones
def chime(f0=1046.5, dur=1.3, partials=((1, 1.0, 0.38), (2.0, 0.28, 0.25), (3.01, 0.12, 0.15), (2.41, 0.08, 0.2)),
          attack=0.003):
    n = N(dur)
    t = tvec(n)
    y = np.zeros(n)
    for r, a, d in partials:
        y += a * np.sin(TAU * f0 * r * t) * np.exp(-t / d)
    return fade(y * np.minimum(1, t / attack), 0.0, 0.1)


def crc(L=2.0):
    """Airbus continuous repetitive chime (master warning), loopable: 6 chimes per 2 s."""
    n = N(L)
    y = np.zeros(n)
    c = chime(1046.5, 0.33, ((1, 1.0, 0.12), (2.0, 0.3, 0.08), (3.01, 0.12, 0.05)))
    per = n // 6
    for i in range(6):
        y[i * per:i * per + len(c)] += c[:max(0, min(len(c), n - i * per))]
    return y


def brass_note(f, dur, rng, bright=1.0):
    n = N(dur)
    t = tvec(n)
    vib = 1 + 0.004 * np.sin(TAU * 5.5 * t)
    ph = TAU * np.cumsum(f * vib) / SR
    saw = sum(((-1) ** (k + 1)) * np.sin(k * ph) / k for k in range(1, 16))
    env = np.minimum(1, t / 0.018) * np.exp(-np.maximum(t - dur * 0.7, 0) / 0.03)
    # filter opens with the attack (brass 'blat')
    y = saw * env
    cut = 900 + 2600 * bright * np.minimum(1, t / 0.04)
    out = np.zeros(n)
    z = np.zeros(2)
    blk = N(0.005)
    for i in range(0, n, blk):
        b, a = signal.butter(2, min(cut[i], SR / 2.2), fs=SR)
        seg, z = signal.lfilter(b, a, y[i:i + blk], zi=z if i else signal.lfilter_zi(b, a) * 0)
        out[i:i + blk] = seg
    return out


def cavalry_charge(rng):
    """Airbus A/P disconnect: short trumpet fanfare (~1.5 s)."""
    notes = [(783.99, 0.11), (1046.5, 0.11), (1318.5, 0.11), (1568.0, 0.26), (1318.5, 0.11), (1568.0, 0.5)]
    y = np.zeros(N(1.6))
    t = 0.0
    for f, d in notes:
        s = brass_note(f / 2, d, rng) + 0.5 * brass_note(f, d, rng, 0.6)
        i = N(t)
        y[i:i + len(s)] += s[:len(y) - i]
        t += d + 0.012
    return fade(y, 0.001, 0.05)


def cricket(L=1.0):
    """Airbus stall 'cricket': bursts of rapid high pips."""
    n = N(L)
    y = np.zeros(n)
    t = tvec(N(0.005))
    pip = np.sin(TAU * 2900 * t) * np.hanning(len(t))
    for burst in (0.0, 0.5):
        for k in range(7):
            i = N(burst + k * 0.019)
            y[i:i + len(pip)] += pip
    return y


def c_chord(dur=1.5):
    n = N(dur)
    t = tvec(n)
    y = sum(np.sin(TAU * f * t) for f in (523.25, 659.25, 783.99)) / 3
    env = np.minimum(1, t / 0.01) * np.minimum(1, (dur - t) / 0.08)
    return y * env


def stick_shaker(rng, L=2.0):
    """Boeing stick shaker: eccentric-mass motor (~26 Hz) rattling the control column."""
    n = N(L)
    f = round(26 * L) / L
    y = np.zeros(n)
    exc = np.zeros(n)
    per = SR / f
    for i in range(int(round(f * L))):
        j = int(i * per + rng.normal(0, 0.0006 * SR)) % n
        exc[j] += 1 + 0.25 * rng.standard_normal()
    from dsp import process_periodic
    y = process_periodic(exc, lambda z: modal(z, [(180, 0.02, 1), (420, 0.012, 0.9), (960, 0.008, 0.7),
                                                   (2100, 0.004, 0.5), (3600, 0.002, 0.3)]))
    t = tvec(n)
    hum = sum(np.sin(TAU * f * k * t) / k for k in range(1, 6))
    y = y / np.max(np.abs(y)) + 0.35 * hum / np.max(np.abs(hum))
    y += 0.2 * spectral_noise(n, lambda fr: bump(fr, 1200, 1.0), rng)
    return y


def clacker(rng, L=2.0):
    """737 overspeed clacker (~8.5 clacks per second)."""
    n = N(L)
    exc = np.zeros(n)
    cnt = 17
    for i in range(cnt):
        exc[int((i + 0.5) * n / cnt)] = 1.0
    from dsp import process_periodic
    y = process_periodic(exc, lambda z: modal(z, [(1850, 0.006, 1), (3400, 0.004, 0.8), (5200, 0.002, 0.6),
                                                   (720, 0.01, 0.5)]))
    y += process_periodic(exc, lambda z: modal(z, [(260, 0.012, 1)])) * 0.3
    return y


def wailer(dur=2.2):
    """Boeing A/P disconnect wailer: warbling two-tone siren."""
    n = N(dur)
    t = tvec(n)
    f = 780 + 330 * (0.5 + 0.5 * signal.sawtooth(TAU * 3.2 * t, 0.85))
    ph = TAU * np.cumsum(f) / SR
    y = np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)
    env = np.minimum(1, t / 0.02) * np.minimum(1, (dur - t) / 0.1)
    return y * env


def whoop(dur=0.45):
    n = N(dur)
    t = tvec(n)
    f = 330 + 1250 * (t / dur) ** 1.4
    ph = TAU * np.cumsum(f) / SR
    y = np.sin(ph) + 0.3 * np.sin(2 * ph)
    return y * np.minimum(1, t / 0.02) * np.minimum(1, (dur - t) / 0.03)


def ding_dong():
    a = chime(784.0, 0.9, ((1, 1.0, 0.35), (2.0, 0.2, 0.2), (3.0, 0.08, 0.1)))
    b = chime(622.25, 1.2, ((1, 1.0, 0.45), (2.0, 0.2, 0.25), (3.0, 0.08, 0.1)))
    y = np.zeros(N(1.6))
    y[:len(a)] += a
    y[N(0.38):N(0.38) + len(b)] += b[:len(y) - N(0.38)]
    return y


def gen_betty(aid, rng, voice_name=BETTY, grit=2.2):
    phrases = {'v_warning': 'Warning. Warning.', 'v_caution': 'Caution. Caution.', 'v_pullup': 'Pull up. Pull up.',
               'v_altitude': 'Altitude. Altitude.', 'v_bingo': 'Bingo. Bingo.', 'v_overg': 'Over G. Over G.',
               'v_lowspeed': 'Low speed. Low speed.', 'v_gear': 'Landing gear.'}
    for k, txt in phrases.items():
        write_wav(f'{aid}/{k}.wav', radio(voice(txt, voice_name, 180), rng, grit), target_lufs=-18)


def gen_gpws(aid, v, rng, airbus):
    rate = 185
    common = {'v_sinkrate': 'Sink rate.', 'v_pullup': 'Pull up.', 'v_terrain': 'Terrain. Terrain.',
              'v_toolow_gear': 'Too low. Gear.', 'v_toolow_flaps': 'Too low. Flaps.',
              'v_toolow_terrain': 'Too low. Terrain.', 'v_bankangle': 'Bank angle. Bank angle.',
              'v_dontsink': "Don't sink.", 'v_glideslope': 'Glide slope.', 'v_windshear': 'Windshear. Windshear.',
              'v_1000': 'One thousand.', 'v_500': 'Five hundred.', 'v_100': 'One hundred.', 'v_50': 'Fifty.',
              'v_40': 'Forty.', 'v_30': 'Thirty.', 'v_20': 'Twenty.', 'v_10': 'Ten.'}
    if airbus:
        common.update({'v_2500': 'Two thousand five hundred.', 'v_400': 'Four hundred.', 'v_300': 'Three hundred.',
                       'v_200': 'Two hundred.', 'v_5': 'Five.', 'v_hundredabove': 'Hundred above.',
                       'v_minimums': 'Minimum.', 'v_retard': 'Retard. Retard.', 'v_stall': 'Stall. Stall.'})
    else:
        common.update({'v_2500': 'Twenty five hundred.', 'v_hundredabove': 'Approaching minimums.',
                       'v_minimums': 'Minimums.'})
    for k, txt in common.items():
        # radio-altitude numbers are spoken fast (they follow each other quickly in the flare)
        x = voice(txt, v, 215 if k[2:].isdigit() else rate)
        if k == 'v_stall' and airbus:
            cr = cricket(0.62)[:N(0.6)]
            x = np.concatenate([cr / np.max(np.abs(cr)) * 0.5, silence(0.08), x / np.max(np.abs(x)) * 0.9])
        if k == 'v_pullup' and not airbus:
            w = whoop()
            x = np.concatenate([w, silence(0.08), w, silence(0.12), x / np.max(np.abs(x)) * 0.9])
        write_wav(f'{aid}/{k}.wav', speaker(x, rng, 16000 if airbus else 22050), target_lufs=-18)


def main():
    rng = np.random.default_rng(99)
    print('[voices]')
    gen_betty('f16', rng)
    gen_betty('f22', rng, BETTY, 1.6)
    gen_gpws('a320neo', AIRBUS, rng, True)
    gen_gpws('b737', BOEING, rng, False)
    for k, txt in {'v_lowrotor': 'Low rotor R P M.', 'v_altitude': 'Altitude. Altitude.', 'v_pullup': 'Pull up.',
                   'v_bankangle': 'Bank angle.'}.items():
        write_wav(f'uh60/{k}.wav', radio(voice(txt, HELO, 175), rng, 1.8), target_lufs=-18)
    print('[alerts]')
    write_wav('a320neo/single_chime.wav', chime(), target_lufs=-18)
    write_wav('a320neo/crc.wav', crc(), target_lufs=-18, loop=True)
    write_wav('a320neo/cavalry.wav', cavalry_charge(rng), target_lufs=-17)
    write_wav('a320neo/cricket.wav', cricket(), target_lufs=-18, loop=True)
    write_wav('a320neo/c_chord.wav', c_chord(), target_lufs=-20)
    write_wav('b737/shaker.wav', stick_shaker(rng), target_lufs=-17, loop=True)
    write_wav('b737/clacker.wav', clacker(rng), target_lufs=-18, loop=True)
    write_wav('b737/wailer.wav', wailer(), target_lufs=-18)
    write_wav('b737/chime.wav', ding_dong(), target_lufs=-19)
    write_wav('b737/c_chord.wav', c_chord(), target_lufs=-20)


if __name__ == '__main__':
    main()
