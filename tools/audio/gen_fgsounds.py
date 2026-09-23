"""Autopilot-disconnect alerts from real reference recordings (FlightGear aircraft, GPL-2.0 — see
tools/audio/third_party/flightgear/NOTICE.md). Tonally faithful: only resampling to 48 kHz, an 80 Hz high-pass
(cockpit speakers), level matching with the other alerts, and a seamless loop cut for the 737 wailer.

  a320neo/cavalry.wav       A320 'cavalry charge' (three short trill bursts) — intentional disconnect, played once
  a320neo/cavalry_loop.wav  one burst + gap — repeated (looped) for an involuntary disconnect until acknowledged
  a320neo/ap_button.wav     the disconnect pushbutton (press/release clicks)
  b737/wailer.wav           737 A/P disconnect wailer, cut to a seamless 2-cycle loop
"""
import os
import sys
import warnings

import numpy as np
from scipy import signal

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import N, SR, circ_filter, hp, limit_peaks, read_wav, undb, write_wav  # noqa: E402
from gen_voices import speech_level_db  # noqa: E402

SRC = os.path.join(os.path.dirname(__file__), 'third_party', 'flightgear')


def load(name):
    return read_wav(os.path.join(SRC, name + '.wav'))       # resampled to 48 kHz by read_wav


def hpf(x, periodic=False):
    if periodic:
        return circ_filter(x, lambda f: hp(f, 80, 2))
    sos = signal.butter(2, 80, 'highpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def loop_cut(x, period_guess, cycles=2, xfade_ms=6):
    """Seamless loop of `cycles` periods: period by waveform autocorrelation, short crossfade into the loop start."""
    lo, hi = int(period_guess * 0.9 * SR), int(period_guess * 1.1 * SR)
    ref = x[:hi]
    best, P = -1e9, int(period_guess * SR)
    for lag in range(lo, min(hi, len(x) - len(ref) // 2)):
        seg = x[lag:lag + hi // 2]
        c = np.dot(ref[:len(seg)], seg) / (np.linalg.norm(ref[:len(seg)]) * np.linalg.norm(seg) + 1e-12)
        if c > best:
            best, P = c, lag
    a = P                                   # start at the 2nd cycle (the recording's head may have an onset)
    L = cycles * P
    if a + L > len(x):
        a, L = max(0, len(x) - L), L
    y = x[a:a + L].copy()
    k = N(xfade_ms / 1000)
    w = np.linspace(0, 1, k)
    y[-k:] = y[-k:] * (1 - w) + x[a - k:a] * w  # the tail flows into x[a] = y[0]
    return y, P / SR, best


def main():
    print('[fgsounds]')
    once = hpf(load('a320_cavalry_once'))
    loop = hpf(load('a320_cavalry_loop'), periodic=True)
    g = undb(-18.0 - speech_level_db(once))     # one gain for both so once/loop match
    write_wav('a320neo/cavalry.wav', limit_peaks(once * g, -1.0, 0.7))
    write_wav('a320neo/cavalry_loop.wav', limit_peaks(loop * g, -1.0, 0.7), loop=True, soft_limit=False)
    btn = hpf(load('a320_ap_button'))
    write_wav('a320neo/ap_button.wav', btn * (undb(-4) / np.max(np.abs(btn))))
    w = load('b737_apdisco')
    wl, per, corr = loop_cut(w, 0.75)
    wl = hpf(wl, periodic=True)
    wl = limit_peaks(wl * undb(-19.0 - speech_level_db(wl)), -1.0, 0.7)
    print(f'  737 wailer period {per:.4f} s (corr {corr:.3f}), loop {len(wl) / SR:.3f} s')
    write_wav('b737/wailer.wav', wl, loop=True, soft_limit=False)
    write_credits()


CREDITS = '''Gökyüzü SF — audio credits
==========================

Autopilot-disconnect sounds (a320neo/cavalry, a320neo/cavalry_loop, a320neo/ap_button, b737/wailer) are derived
(resampled to 48 kHz, level-matched, 80 Hz high-pass, 737 wailer cut to a seamless loop) from recordings in two
open-source FlightGear aircraft, licensed under the GNU General Public License v2.0 (GPL-2.0):

  * A320-family for FlightGear — legoboyvdlp, Octal450 and contributors
    https://github.com/legoboyvdlp/A320-family  (Sounds/Cockpit/cavalry-charge-once.wav, cavalry-charge-loop.wav,
    autopilot-disconnect pushbutton sound) — GPL-2.0
  * Boeing 737-800YV for FlightGear — YV3399 and contributors
    https://github.com/YV3399/737-800YV  (Sounds/Apdisco.wav) — GPL-2.0

The derived files are distributed under GPL-2.0 as well. Unmodified originals, the licence text and SHA-256 sums are
in tools/audio/third_party/flightgear/ of the source repository.

Voice callouts: generated with ElevenLabs text-to-speech (voices Sarah, Bill, Eric) under the project's ElevenLabs
licence. All other sounds (engines, rotors, wind, mechanical sounds, chimes, warning tones) are synthesised by the
project's own scripts in tools/audio/.

Türkçe:
Otopilot ayırma sesleri, FlightGear açık kaynak uçaklarından türetilmiştir: A320-family (legoboyvdlp, Octal450 ve
katkıda bulunanlar — github.com/legoboyvdlp/A320-family) ve Boeing 737-800YV (YV3399 ve katkıda bulunanlar —
github.com/YV3399/737-800YV); lisans: GNU GPL-2.0. Anons sesleri ElevenLabs ile üretilmiştir; diğer tüm sesler
projenin kendi sentez betikleriyle oluşturulmuştur.
'''


def write_credits():
    from dsp import OUT
    with open(os.path.join(OUT, 'CREDITS.txt'), 'w', encoding='utf-8') as fh:
        fh.write(CREDITS)
    with open(os.path.join(os.path.dirname(__file__), 'third_party', 'CREDITS.txt'), 'w', encoding='utf-8') as fh:
        fh.write(CREDITS)


if __name__ == '__main__':
    main()
