"""Autopilot-disconnect candidates for audition (dev/audio.html?ap=1): A320 'cavalry charge' and 737 'wailer'.

Synthesised variants + ElevenLabs sound-effects variants → assets/audio/candidates/apdisc/*.wav + index.json.
The chosen candidate is then copied to a320neo/cavalry.wav or b737/wailer.wav (same names, profiles unchanged).
Usage: .venv/bin/python tools/audio/gen_apdisc.py [--no-el]
"""
import json
import os
import sys
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import N, OUT, SR, butter, bq, fade, limit_peaks, tvec, undb, write_wav  # noqa: E402
from gen_voices import small_room, speech_level_db  # noqa: E402

TAU = 2 * np.pi
DST = 'candidates/apdisc'
G4, C5, E5, G5 = 392.0, 523.25, 659.25, 783.99


def speaker_tone(x, rng, lo=180, hi=7000, room=True):
    """Cockpit loudspeaker for synthetic aural alerts: wider band than speech, small-room reflections."""
    y = butter(x, 'highpass', lo, 2)
    y = butter(y, 'lowpass', hi, 2)
    y = bq(y, 'peak', 2400, 1.2, 2.5)
    y = np.concatenate([np.zeros(N(0.005)), y, np.zeros(N(0.12))])
    if room:
        y = small_room(y, rng, tail_db=-20, rt60=0.18)
    return y


def level(y, target=-18.0):
    y = y * undb(target - speech_level_db(y))
    return limit_peaks(y, -1.0, 0.6)


# ------------------------------------------------------------------------------------------------ brass (cavalry)
def brass_note(f, dur, bright=1.0, odd=0.0, rng=None, vib_after=0.14):
    """Additive brass: lip attack (pitch rises into the note), brightness follows the attack, slight vibrato."""
    n = N(dur)
    t = tvec(n)
    ft = f * (1 - 0.035 * np.exp(-t / 0.014)) * (1 + 0.006 * np.sin(TAU * 5.6 * t) * np.clip((t - vib_after) / 0.08, 0, 1))
    ph = TAU * np.cumsum(ft) / SR
    env = np.minimum(1, t / 0.007) * (0.85 + 0.15 * np.exp(-t / 0.05))
    rel = N(0.03)
    env[-rel:] *= np.linspace(1, 0, rel) ** 1.5
    fc = (700 + 2800 * bright * (1 - np.exp(-t / 0.018))) * (0.9 + 0.1 * env)   # brightness opens with the attack
    y = np.zeros(n)
    K = int(min(14000, SR / 2.2) / f)
    for k in range(1, K + 1):
        amp = (1 / k) * (1 - odd * (k % 2 == 0)) / np.sqrt(1 + (k * f / fc) ** 4)
        y += amp * np.sin(k * ph + 0.3 * k)
    y2 = np.zeros(n)                     # second 'player', 5 cents sharp → ensemble shimmer
    ph2 = ph * (1 + 0.0029)
    for k in range(1, min(K, 12) + 1):
        y2 += (1 / k) / np.sqrt(1 + (k * f / fc) ** 4) * np.sin(k * ph2 + 1.1 * k)
    return (y + 0.45 * y2) * env


def fanfare(notes, gap=0.014, **kw):
    parts = []
    for f, d in notes:
        parts.append(brass_note(f, d, **kw))
        parts.append(np.zeros(N(gap)))
    return np.concatenate(parts)


CHARGE = [(G4, 0.105), (C5, 0.105), (E5, 0.105), (G5, 0.23), (E5, 0.105), (G5, 0.52)]


def cavalry_a(rng):
    """Bugle 'charge' (G-C-E-G…E-G), bright brass, ~1.3 s."""
    return level(speaker_tone(fanfare([(f * 2, d) for f, d in CHARGE], bright=1.1), rng))


def cavalry_b(rng):
    """Same call faster and an octave higher, square-ish 'electronic trumpet' of an 80s warning computer."""
    notes = [(f * 2, d * 0.85) for f, d in CHARGE]
    return level(speaker_tone(fanfare(notes, gap=0.01, bright=1.4, odd=0.7), rng))


# ------------------------------------------------------------------------------------------------ wailer (737)
def periodic_sweep(L, rate, f_lo, f_hi, shape='tri', harm=((1, 1.0), (2, 0.25), (3, 0.12))):
    """Loopable warble: log-frequency sweep f_lo↔f_hi at `rate` sweeps/s; integer cycles per loop (seamless)."""
    n = N(L)
    t = tvec(n)
    cyc = max(1, round(rate * L))
    ph_l = (t * cyc / L) % 1.0
    if shape == 'tri':
        u = 1 - np.abs(2 * ph_l - 1)                          # up and down
    else:
        u = np.clip(ph_l / 0.8, 0, 1)                         # rise, then drop (whoop-like)
        u = np.where(ph_l < 0.8, u, 1 - (ph_l - 0.8) / 0.2)
    f = f_lo * (f_hi / f_lo) ** u
    cycles = np.sum(f) / SR
    f *= round(cycles) / cycles                               # integer number of carrier cycles per loop
    ph = TAU * np.cumsum(f) / SR
    y = sum(a * np.sin(k * ph) for k, a in harm)
    return y


def wailer_a(rng):
    """Up/down sine-like warble 1.1↔2.4 kHz, 3.3 sweeps/s (loopable 3 s)."""
    y = periodic_sweep(3.0, 3.33, 1100, 2400, 'tri')
    return fade(level(speaker_tone(fade(y, 0.004, 0.05), rng, room=False), -19), 0.002, 0.05)


def wailer_b(rng):
    """Piezo-sounder style: brighter (odd harmonics), rising sweeps 1.0→2.5 kHz with a quick return, 4 per second."""
    y = periodic_sweep(3.0, 4.0, 1000, 2500, 'saw', harm=((1, 1.0), (3, 0.33), (5, 0.18), (7, 0.1)))
    return fade(level(speaker_tone(fade(y, 0.004, 0.05), rng, room=False), -19), 0.002, 0.05)


# ------------------------------------------------------------------------------------------------ ElevenLabs
EL = {
    'a320': [('el1', 'Airbus A320 autopilot disconnect "cavalry charge" warning: short synthetic brass bugle fanfare, '
                     'rapid rising trumpet arpeggio, cockpit aural alert, no voice', 1.6, 0.7),
             ('el2', 'Short bright electronic trumpet fanfare, cavalry charge bugle call played fast, '
                     'aircraft cockpit warning sound, clean, no voice', 1.5, 0.8)],
    'b737': [('el1', 'Boeing 737 autopilot disconnect wailer: electronic warbling siren tone sweeping up and down rapidly, '
                     'cockpit warning, no voice', 3.0, 0.7),
             ('el2', 'Electronic siren warble, pure tone rapidly sweeping up and down between 1 and 2.5 kHz several times '
                     'per second, aircraft cockpit alarm, dry, no voice', 3.0, 0.8)],
}


def el_candidate(text, dur, infl, tag, loop):
    import elevenlabs as el
    from dsp import trim_silence
    x = el.sound_effect(text, dur, infl, tag)
    x = trim_silence(x, -45, 0.01)
    x = butter(x, 'highpass', 120, 2)
    y = level(x, -19 if loop else -18)
    return fade(y, 0.003, 0.08)


def main():
    rng = np.random.default_rng(7)
    from dsp import read_wav
    from gen_voices import cavalry_charge, wailer
    # real reference recordings (FlightGear, GPL-2.0) — the in-game defaults; demos of the looped behaviour
    loop = read_wav(os.path.join(OUT, 'a320neo/cavalry_loop.wav'))
    write_wav(f'{DST}/a320_fg_loop_demo.wav', np.tile(loop, 6))
    wl = read_wav(os.path.join(OUT, 'b737/wailer.wav'))
    demo = np.tile(wl, 3)[:N(3.0)]
    write_wav(f'{DST}/b737_fg_3s.wav', fade(demo, 0.0, 0.03))
    write_wav(f'{DST}/a320_oldsynth.wav', level(speaker_tone(cavalry_charge(rng), rng)))
    write_wav(f'{DST}/b737_oldsynth.wav', level(speaker_tone(wailer(), rng, room=False), -19))
    items = [
        {'id': 'a320_fg_once', 'aircraft': 'a320neo', 'label': 'Gerçek referans (FlightGear) — kasıtlı ayırma: tek sefer, 3 kısa tril (oyundaki varsayılan)', 'file': 'a320neo/cavalry'},
        {'id': 'a320_fg_loop', 'aircraft': 'a320neo', 'label': 'Gerçek referans (FlightGear) — istem dışı ayırma: onaylanana kadar tekrar (örnek)', 'file': f'{DST}/a320_fg_loop_demo'},
        {'id': 'a320_fg_button', 'aircraft': 'a320neo', 'label': 'Gerçek referans (FlightGear) — ayırma düğmesi tık sesi', 'file': 'a320neo/ap_button'},
        {'id': 'a320_oldsynth', 'aircraft': 'a320neo', 'label': 'Eski sentez (önceki varsayılan)', 'file': f'{DST}/a320_oldsynth'},
        {'id': 'a320_synthA', 'aircraft': 'a320neo', 'label': 'Sentez A — pirinç boru "charge" (G-C-E-G…E-G)', 'fn': cavalry_a},
        {'id': 'a320_synthB', 'aircraft': 'a320neo', 'label': 'Sentez B — daha hızlı, elektronik trompet', 'fn': cavalry_b},
        {'id': 'b737_fg', 'aircraft': 'b737', 'label': 'Gerçek referans (FlightGear) — wailer, 3 s (oyundaki varsayılan)', 'file': f'{DST}/b737_fg_3s'},
        {'id': 'b737_oldsynth', 'aircraft': 'b737', 'label': 'Eski sentez (önceki varsayılan)', 'file': f'{DST}/b737_oldsynth'},
        {'id': 'b737_synthA', 'aircraft': 'b737', 'label': 'Sentez A — yukarı/aşağı siren 1.1–2.4 kHz, 3.3/s', 'fn': wailer_a},
        {'id': 'b737_synthB', 'aircraft': 'b737', 'label': 'Sentez B — piezo tipi yükselen süpürme 1–2.5 kHz, 4/s', 'fn': wailer_b},
    ]
    out = []
    for it in items:
        if 'fn' in it:
            write_wav(f'{DST}/{it["id"]}.wav', it['fn'](rng))
            it['file'] = f'{DST}/{it["id"]}'
        out.append({k: v for k, v in it.items() if k != 'fn'})
    if '--no-el' not in sys.argv:
        for ac, lst in EL.items():
            for tag, text, dur, infl in lst:
                cid = f'{ac}_{tag}'
                try:
                    y = el_candidate(text, dur, infl, cid, ac == 'b737')
                except Exception as e:  # network / quota: keep the synth candidates
                    print('ElevenLabs failed for', cid, e)
                    continue
                write_wav(f'{DST}/{cid}.wav', y)
                out.append({'id': cid, 'aircraft': 'a320neo' if ac == 'a320' else 'b737',
                            'label': f'ElevenLabs {tag[-1]} — "{text[:70]}…"', 'file': f'{DST}/{cid}'})
    with open(os.path.join(OUT, DST, 'index.json'), 'w') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    print('candidates:', len(out))


if __name__ == '__main__':
    main()
