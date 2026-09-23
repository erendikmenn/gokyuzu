"""Autopilot-disconnect alerts from two FlightGear aircraft (GPL-2.0 — see tools/audio/third_party/flightgear/NOTICE.md).
The A320 cavalry charge is a re-synthesis from an Airbus waveform diagram (not a recording); the 737 wailer's origin is
not stated. Tonally faithful: only resampling to 48 kHz, an 80 Hz high-pass
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

1. Autopilot-disconnect alerts — GNU General Public License v2.0 (GPL-2.0)
   Derived (resampled to 48 kHz, level-matched, 80 Hz high-pass, 737 wailer cut to a seamless loop) from two open-source
   FlightGear aircraft:
   * a320neo/cavalry, a320neo/cavalry_loop, a320neo/ap_button — A320-family for FlightGear, Josh Davidson (Octal450),
     Jonathan Redpath (legoboyvdlp) and contributors, https://github.com/legoboyvdlp/A320-family (GPL-2.0).
     The "cavalry charge" is NOT a recording: it was re-synthesised in A320-family PR #364 (2025) from an Airbus waveform
     diagram (1660 Hz / 830 Hz square waves alternating every 40 ms, 200 ms bursts). A real A319 cockpit recording
     (Adria S5-AAP, see 3.) shows the same waveform.
   * b737/wailer — Boeing 737-800YV for FlightGear, YV3399 and contributors, https://github.com/YV3399/737-800YV
     (Sounds/Apdisco.wav, GPL-2.0; its origin is not stated in that repository).
   The derived files are distributed under GPL-2.0 as well. Unmodified originals, the licence text and SHA-256 sums are in
   tools/audio/third_party/flightgear/ of the source repository.

2. Voice warnings — generated with ElevenLabs text-to-speech under the project's ElevenLabs licence; no voice of a real
   person was cloned. A320 FWC voice: an ElevenLabs Voice Design voice made from a text description ("deep British RP
   male, flat automated cockpit announcement"); Honeywell EGPWS voice (A320, 737): "Adam"; F-16 VMS: "Sarah"; F-22 ICAWS:
   "Matilda". The voices were chosen and equalised by measuring real cockpit recordings (3.).

3. Real cockpit recordings used as references (measured; cleaned excerpts are only on the local listening page
   dev/sesler.html and are not distributed with the game):
   * "Baïonnette CDG" — Air France A319 F-GRXM cockpit video, Sygoletto / Wikimedia Commons, CC BY-SA 3.0
     (https://creativecommons.org/licenses/by-sa/3.0/), https://commons.wikimedia.org/wiki/File:Ba%C3%AFonnette_CDG.ogv.
     Modified: excerpts cut, noise-reduced (spectral gating), band-limited, level-normalised; the modified excerpts are
     themselves licensed CC BY-SA 3.0.
   * "Adria Airways A319 Night landing takeoff Frankfurt + Landing at Ljubljana (cockpit)" — jan tisler (YouTube
     "aircraft16") via Wikimedia Commons, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Modified: excerpts
     cut, noise-reduced, band-limited, level-normalised.
   * "P-8A Poseidon Night Approach" — U.S. Navy video by MC2 Jacquelin Frost, DVIDS 910648 (public domain; no DoD
     endorsement implied). Its intermittent configuration horn was measured (202 Hz harmonic series, 0.21 s / 0.52 s)
     and re-synthesised for b737/horn_int and b737/horn.
   * "Auto-GCAS Saves Unconscious F-16 Pilot — Declassified USAF Footage" — U.S. Air Force, via Wikimedia Commons (public
     domain). The spectrum of its 241 Hz square-wave tone shaped f16/lg_horn and f16/low_speed.
   * Transaero 737NG Irkutsk landing (2015, YouTube channel Vnebelaynery, Internet Archive mirror; licence not verified):
     analysis only — the frequencies and length of its altitude-alert chord (503.9 / 629.9 / 755.9 Hz, 1.13 s) were
     measured for b737/alt_alert; no audio from it is used anywhere.

4. Everything else (engines, rotors, wind, mechanical sounds, chimes, horns and warning tones) is synthesised by the
   project's own scripts in tools/audio/ (numpy), following published specifications where they exist
   (tools/audio/research/alerts.md).

Türkçe
------
Otopilot ayırma sesleri FlightGear açık kaynak uçaklarından türetilmiştir (GNU GPL-2.0): A320 "cavalry charge" bir kayıt
değil, A320-family projesinde (Josh Davidson, Jonathan Redpath ve katkıda bulunanlar) Airbus dalga şemasından yeniden
sentezlenmiştir; 737 wailer'ı Boeing 737-800YV'den (YV3399 ve katkıda bulunanlar). Sesli uyarılar ElevenLabs ile
üretilmiştir (gerçek kişi sesi klonlanmadı). Sesleri seçmek ve ölçmek için gerçek kokpit kayıtları kullanıldı:
Sygoletto (Air France A319, CC BY-SA 3.0, değiştirildi), jan tisler (Adria A319, CC BY 3.0, değiştirildi), ABD Donanması
(P-8A, DVIDS, kamu malı), ABD Hava Kuvvetleri (F-16 Auto-GCAS kaydı, kamu malı). Diğer tüm sesler projenin kendi sentez
betikleriyle oluşturulmuştur.
'''


def write_credits():
    from dsp import OUT
    with open(os.path.join(OUT, 'CREDITS.txt'), 'w', encoding='utf-8') as fh:
        fh.write(CREDITS)
    with open(os.path.join(os.path.dirname(__file__), 'third_party', 'CREDITS.txt'), 'w', encoding='utf-8') as fh:
        fh.write(CREDITS)


if __name__ == '__main__':
    main()
