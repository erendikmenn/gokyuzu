"""Non-voice cockpit alert tones, re-synthesised from measurements of real recordings and published specs.

Every tone documents its evidence (see also tools/audio/research/warnings.md and alerts.md):
  737 config horn (intermittent)  P-8A cockpit video (DVIDS 910648, PD): 202 Hz harmonic series, measured partial levels
                                  h3..h25, pulses 0.21 s on / 0.52 s period                    → b737/horn_int (loop)
  737 landing-gear horn (steady)  same horn, continuous (b737.org.uk: gear config = steady horn) → b737/horn (loop)
  737 altitude alert              Transaero 737NG cockpit video (analysis only): steady chord 503.9 / 629.9 / 755.9 Hz
                                  (4:5:6), 1.13 s, fast attack/release, weak 3rd harmonics      → b737/alt_alert
  F-16 LG warning horn / low-speed tone
                                  250 Hz square wave (Dash-1 via NikolaiVChr/f16), spectrum shaped like the real 240.8 Hz
                                  square tone on the USAF Auto-GCAS HUD tape (h3 -9.5, h5 -16, h7 -20.3, h9 -25.4 dB)
  A320 FWC tones (CRC, single chime, C-chord, cricket), 737 stick shaker / clacker / fire bell, UH-60 tones: see the
  per-function notes.
Outputs 48 kHz mono WAVs under assets/audio/<aircraft>/ (+ encode.py LOOPS for the looped ones).
Usage: .venv/bin/python tools/audio/gen_alerts.py
"""
import os
import sys
import warnings

import numpy as np
from scipy import signal

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import N, SR, butter, bq, fade, limit_peaks, modal, spectral_noise, bump, tvec, undb, write_wav  # noqa: E402

TAU = 2 * np.pi


def periodic_tone(f0, partials_db, dur, phases=None, snap=True):
    """Sum of harmonics k*f0 with levels partials_db[k-1] (dB); f0 snapped so `dur` holds whole periods (loopable)."""
    if snap:
        f0 = round(f0 * dur) / dur
    t = np.arange(N(dur)) / SR
    rng = np.random.default_rng(5)
    y = np.zeros(len(t))
    for k, d in enumerate(partials_db, start=1):
        if k * f0 > SR / 2.2:
            break
        ph = phases[k - 1] if phases is not None else rng.uniform(0, TAU)
        y += undb(d) * np.sin(TAU * k * f0 * t + ph)
    return y / (np.max(np.abs(y)) + 1e-12)


def gate(n, on, period, attack=0.004, release=0.008, offset=0.0):
    """Periodic on/off envelope with smooth edges (raised-cosine), loopable when n/period is an integer."""
    t = (np.arange(n) / SR - offset) % period
    g = np.clip(np.minimum(t / attack, (on - t) / release), 0, 1)
    g[t > on] = 0
    return 0.5 - 0.5 * np.cos(np.pi * g)


# ------------------------------------------------------------------------------------------------ Boeing 737
# P-8A horn: noise-subtracted partial levels (dB) of the 202 Hz series, h1..h25 (tools/audio/research/alerts.md).
# h1/h2 are below the recording's noise floor (camera mic, cockpit noise): set 6 dB under h3 as a neutral assumption.
HORN_DB = [42.7, 42.7, 48.7, 36.2, 38.4, 28.7, 42.6, 39.3, 45.5, 40.8, 37.6, 40.6, 36.9, 40.7, 31.1, 35.2, 35.2, 28.9,
           31.6, 37.4, 34.0, 39.9, 34.2, 20.3, 32.3]


def horn(dur):
    return periodic_tone(202.0, [d - 48.7 for d in HORN_DB], dur)


def horn_intermittent():
    """Takeoff-configuration / cabin-altitude warning: 0.21 s pulses every 0.52 s (measured, P-8A)."""
    L = 0.52 * 4                        # 4 periods → loop
    y = horn(L) * gate(N(L), 0.21, 0.52, 0.004, 0.012)
    return y


def horn_steady():
    """Landing-gear configuration warning: the same horn, continuous."""
    return horn(1.0)


def alt_alert_737():
    """Altitude alert: steady 504/630/756 Hz chord (4:5:6), 1.13 s — measured on a 737NG cockpit recording."""
    d = 1.13
    t = tvec(N(d))
    y = np.zeros(len(t))
    for f in (503.9, 629.9, 755.9):
        y += np.sin(TAU * f * t) + undb(-18) * np.sin(TAU * 3 * f * t)
    env = np.clip(np.minimum(t / 0.012, (d - t) / 0.03), 0, 1)
    return y * env


def stick_shaker(rng, L=2.0):
    """Stick shaker: eccentric-weight motor on the column (b737.org.uk). ~26 Hz rotation, rattling column + floor."""
    n = N(L)
    f = round(26 * L) / L
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
    """Overspeed clacker: electromechanical clacking, ~8.5 per second."""
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


def fire_bell(L=2.0):
    """Fire warning bell: fast-striking electric bell, continuous until BELL CUTOUT (FCOM 8.10). Partials and strike rate
    measured on the 737-800YV FlightGear fire-bell.wav (GPL-2.0; a real bell recording of unstated origin, used as a
    measurement only): strongest partials 1333 / 2266 Hz, then 2665 / 596 / 366 Hz, clapper strikes at 15 per second."""
    n = N(L)
    rate = 15
    exc = np.zeros(n)
    rng = np.random.default_rng(7)
    for i in range(int(rate * L)):
        exc[int(i * n / (rate * L))] = 1.0 - 0.15 * (i % 2) + 0.05 * rng.standard_normal()
    from dsp import process_periodic
    # (Hz, decay s, level) — levels from the measured spectrum (0 / -1 / -5 / -7 / -8 dB re strongest)
    parts = [(2266, 0.22, 1.0), (1333, 0.3, 0.9), (2665, 0.16, 0.56), (596, 0.35, 0.45), (366, 0.4, 0.4),
             (3520, 0.08, 0.2)]
    y = process_periodic(exc, lambda z: modal(z, parts))
    return y / (np.max(np.abs(y)) + 1e-12)


# ------------------------------------------------------------------------------------------------ Airbus FWC
def chime_partial(f0, dur, partials, attack=0.002):
    t = tvec(N(dur))
    y = np.zeros(len(t))
    for r, a, d in partials:
        y += a * np.sin(TAU * f0 * r * t) * np.exp(-t / d)
    return y * np.minimum(1, t / attack)


def single_chime():
    """FWC single chime (amber caution): one electronic 'ding', 0.5 s (FCOM DSC-31-10 duration; pitch not published)."""
    return fade(chime_partial(1046.5, 0.55, ((1, 1.0, 0.16), (2.0, 0.22, 0.1), (3.0, 0.1, 0.06))), 0.0, 0.05)


def crc(L=2.0):
    """FWC continuous repetitive chime (red warning): the chime repeated, 4 per second (cadence not published; the
    FlightGear A320-family CRC uses the same rate), loopable."""
    n = N(L)
    y = np.zeros(n)
    per = n // 8
    c = chime_partial(1046.5, 0.25, ((1, 1.0, 0.1), (2.0, 0.26, 0.07), (3.0, 0.1, 0.045)))
    for i in range(8):
        k = min(len(c), n - i * per)
        y[i * per:i * per + k] += c[:k]
    return y


def c_chord(dur=1.5):
    """FWC altitude alert 'C-chord': C major triad (C5 E5 G5) with a soft attack/release, 1.5 s."""
    t = tvec(N(dur))
    y = sum(np.sin(TAU * f * t) + undb(-20) * np.sin(TAU * 2 * f * t) for f in (523.25, 659.25, 783.99)) / 3
    env = np.minimum(1, t / 0.015) * np.minimum(1, (dur - t) / 0.1)
    return y * env


def c_chord_loop(L=1.0):
    """Continuous C-chord (altitude deviation): the same triad, steady, loopable (whole cycles in 1 s)."""
    t = tvec(N(L))
    return sum(np.sin(TAU * f * t) + undb(-20) * np.sin(TAU * 2 * f * t) for f in (523, 659, 784)) / 3


def cricket(L=1.0):
    """FWC stall 'cricket': bursts of rapid high pips (loopable 1 s: two bursts)."""
    n = N(L)
    y = np.zeros(n)
    t = tvec(N(0.005))
    pip = np.sin(TAU * 2900 * t) * np.hanning(len(t))
    for burst in (0.0, 0.5):
        for k in range(7):
            i = N(burst + k * 0.019)
            y[i:i + len(pip)] += pip
    return y


# ------------------------------------------------------------------------------------------------ F-16
F16_SQUARE_DB = [0, -9.5, -16.0, -20.3, -25.4, -28.3, -31.0, -33.5, -36.0]   # odd harmonics 1,3,5..17 (GCAS tape)


def square250(dur, f0=250.0):
    """250 Hz square wave with the odd-harmonic roll-off measured on the real F-16 tone (Auto-GCAS HUD tape)."""
    parts = []
    for k in range(1, 18):
        parts.append(F16_SQUARE_DB[(k - 1) // 2] if k % 2 else -80)
    return periodic_tone(f0, parts, dur, phases=[0.0] * 17)


def lg_horn():
    """F-16 landing-gear warning horn: 250 +/- 50 Hz, repetition rate 5 +/- 1 Hz (DTIC AD-A145469 Table 5), i.e.
    100 ms on / 100 ms off; loop 1 s."""
    return square250(1.0) * gate(N(1.0), 0.1, 0.2, 0.003, 0.005)


def low_speed_tone():
    """F-16 low-speed warning tone: steady 250 Hz."""
    return square250(1.0)


# ------------------------------------------------------------------------------------------------ F-22
def f22_caution():
    """F-22 ICAW caution 'aural tone' (DoD IG 2013 / 2010 AIB: cautions assert with an aural tone and CAUT in the HUD).
    The tone itself is not published: two short 1.2 kHz beeps (assumption)."""
    t = tvec(N(0.12))
    b = (np.sin(TAU * 1200 * t) + 0.2 * np.sin(TAU * 3600 * t)) * np.minimum(1, np.minimum(t / 0.004, (0.12 - t) / 0.01))
    return np.concatenate([b, np.zeros(N(0.08)), b])


def f22_warning():
    """F-22 ICAW warning tone in the headset (existence: AGARD AR-349; form not published): three fast 800 Hz
    pulses (assumption), played before the warning voice."""
    t = tvec(N(0.09))
    b = (np.sin(TAU * 800 * t) + 0.3 * np.sin(TAU * 2400 * t)) * np.minimum(1, np.minimum(t / 0.003, (0.09 - t) / 0.008))
    g = np.zeros(N(0.06))
    return np.concatenate([b, g, b, g, b])


# ------------------------------------------------------------------------------------------------ UH-60
def uh60_lobug():
    """UH-60M radar-altimeter low-bug audio (exists per ARL UH-60M assessment 2006; sound not published): three short
    1 kHz pulses (assumption)."""
    t = tvec(N(0.1))
    b = np.sin(TAU * 1000 * t) * np.minimum(1, np.minimum(t / 0.004, (0.1 - t) / 0.01))
    g = np.zeros(N(0.07))
    return np.concatenate([b, g, b, g, b])


def steady_tone(f, dur=1.0, h3=-14):
    """Steady headset warning tone (UH-60 TM: 'a low steady tone'), slightly square-ish, loopable."""
    parts = [0, -80, h3, -80, h3 - 8]
    return periodic_tone(f, parts, dur)


def headset(y):
    y = butter(y, 'highpass', 250, 2)
    return butter(y, 'lowpass', 5000, 2)


def circ_speaker(y, lo=160, hi=6500):
    """speaker() for periodic (loop) signals: circular filtering keeps the loop seamless."""
    from dsp import circ_filter, hp, lp
    y = circ_filter(y, lambda f: hp(f, lo, 2) * lp(f, hi, 2))
    return bq(y, 'peak', 2300, 1.2, 2.0)


def speaker(y, rng=None, lo=160, hi=6500):
    """Flight-deck loudspeaker for tones: band-limit + small cone resonance."""
    y = butter(y, 'highpass', lo, 2)
    y = butter(y, 'lowpass', hi, 2)
    return bq(y, 'peak', 2300, 1.2, 2.0)


def main():
    rng = np.random.default_rng(99)
    print('[alerts]')
    # Boeing 737
    write_wav('b737/horn_int.wav', speaker(horn_intermittent()), target_lufs=-17, loop=True, soft_limit=False)
    write_wav('b737/horn.wav', speaker(horn_steady()), target_lufs=-17, loop=True, soft_limit=False)
    write_wav('b737/alt_alert.wav', speaker(alt_alert_737()), target_lufs=-19)
    write_wav('b737/shaker.wav', stick_shaker(rng), target_lufs=-17, loop=True)
    write_wav('b737/clacker.wav', clacker(rng), target_lufs=-18, loop=True)
    # fire bell: plays when the flight model reports a fire (alertlogic FLAGS.fire; none of the flight models has one yet)
    write_wav('b737/fire_bell.wav', circ_speaker(fire_bell()), target_lufs=-17, loop=True, soft_limit=False)
    # Airbus A320 FWC
    write_wav('a320neo/single_chime.wav', speaker(single_chime()), target_lufs=-18)
    write_wav('a320neo/crc.wav', speaker(crc()), target_lufs=-18, loop=True, soft_limit=False)
    write_wav('candidates/final/alt/a320neo/cricket.wav', speaker(cricket()), target_lufs=-18, loop=True, soft_limit=False)  # baked into v_stall
    write_wav('a320neo/c_chord.wav', speaker(c_chord()), target_lufs=-20)
    write_wav('a320neo/c_chord_loop.wav', circ_speaker(c_chord_loop()), target_lufs=-20, loop=True, soft_limit=False)
    # F-16
    write_wav('f16/lg_horn.wav', headset(lg_horn()), target_lufs=-19, loop=True, soft_limit=False)
    write_wav('f16/low_speed.wav', headset(low_speed_tone()), target_lufs=-20, loop=True, soft_limit=False)
    # F-22
    write_wav('f22/caution.wav', headset(f22_caution()), target_lufs=-20)
    write_wav('candidates/final/alt/f22/warning.wav', headset(f22_warning()), target_lufs=-19)   # baked into the warning voices
    # UH-60: the shipped warnings are the VWS cycles (gen_voices.gen_uh60: 2 s continuous 250 Hz tone + message). The
    # tone-only variant (UH-60A/L "low steady tone") and the assumed low-bug beeps stay on the listening page.
    write_wav('candidates/final/alt/uh60/low_rotor_tone.wav', headset(steady_tone(250.0)), target_lufs=-20, loop=True, soft_limit=False)
    write_wav('candidates/final/alt/uh60/lobug.wav', headset(uh60_lobug()), target_lufs=-21)


if __name__ == '__main__':
    main()
