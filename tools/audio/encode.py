"""Compress the WAV masters for delivery: AAC-LC in M4A (decodeAudioData in Safari, Chrome, Firefox).

Gapless loops: AAC adds encoder priming/padding that decoders may or may not trim. To make that irrelevant each
loop is encoded with wrap-around guard material ([last 0.1 s | loop | first 0.1 s] of the periodic signal), and the
runtime loops the window [loopStart, loopStart + loopDur] (AudioBufferSourceNode.loopStart/loopEnd). Because the
signal is periodic across the guards, the window is seamless wherever the decoder places time zero (±0.1 s).

Writes assets/audio/<dir>/<name>.m4a next to the .wav masters and adds {m4a, loopStart, loopDur, kb} to the manifest.
Usage: .venv/bin/python tools/audio/encode.py [--check]
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import warnings

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import OUT, SR, read_wav  # noqa: E402

GUARD = 0.1  # s of wrap-around material on each side of a loop

# every file the runtime plays with loop = true (layers + alert loops)
LOOPS = {f'common/{n}' for n in ('wind_ext', 'wind_canopy', 'wind_deck', 'buffet', 'gear_drag', 'gear_motor',
                                 'flap_airbus', 'flap_boeing', 'flap_fighter', 'canopy_motor', 'roll', 'brake_squeal',
                                 'avionics')}
LOOPS |= {f'{a}/{n}' for a in ('f16', 'f22') for n in ('whine_lo', 'whine_mid', 'whine_hi', 'roar_lo', 'roar_hi', 'ab',
                                                       'rumble', 'ecs', 'breath')}
LOOPS |= {f'{a}/{n}' for a in ('a320neo', 'b737') for n in ('fan_lo', 'fan_mid', 'fan_hi', 'buzzsaw', 'jet_lo', 'jet_hi',
                                                           'reverse', 'apu')}
LOOPS |= {f'uh60/{n}' for n in ('rotor', 'slap', 'tail', 'turbine', 'gearbox', 'wash')}
LOOPS |= {'a320neo/crc', 'a320neo/c_chord_loop', 'b737/shaker', 'b737/clacker', 'b737/horn', 'b737/horn_int',
          'a320neo/cavalry_loop', 'b737/wailer', 'b737/fire_bell', 'f16/lg_horn', 'f16/low_speed'}


def bitrate(rel):
    name = rel.split('/')[1]
    if name.startswith('v_'):
        return 64000          # band-limited speech
    if rel in LOOPS:
        return 96000          # tonal engine loops need the bits
    return 80000


def encode(rel, x, br):
    """x: float mono at SR → M4A (AAC-LC) via Apple's encoder (afconvert, best quality mode)."""
    dst = os.path.join(OUT, rel + '.m4a')
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'in.wav')
        wavfile.write(src, SR, np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16))
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', str(br), '-q', '127', '-s', '2', src, dst],
                       check=True, capture_output=True)
    return dst


def decode(path):
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'o.wav')
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', f'LEI16@{SR}', path, out], check=True, capture_output=True)
        return read_wav(out)


def main():
    check = '--check' in sys.argv
    mpath = os.path.join(OUT, 'manifest.json')
    man = json.load(open(mpath))
    tot_wav = tot_m4a = 0
    per_dir = {}
    worst = []
    for f in sorted(glob.glob(os.path.join(OUT, '*', '*.wav'))):
        rel = os.path.relpath(f, OUT)[:-4]
        x = read_wav(f)
        n = len(x)
        entry = man.setdefault(rel, {})
        if rel in LOOPS:
            g = int(GUARD * SR)
            ext = np.concatenate([x[-g:], x, x[:g]])
            dst = encode(rel, ext, bitrate(rel))
            entry.update({'loopStart': GUARD, 'loopDur': n / SR})
        else:
            dst = encode(rel, x, bitrate(rel))
            entry.pop('loopStart', None); entry.pop('loopDur', None)
        kb = os.path.getsize(dst) / 1024
        entry['m4a'] = round(kb, 1)
        tot_wav += os.path.getsize(f); tot_m4a += os.path.getsize(dst)
        d = rel.split('/')[0]
        per_dir[d] = per_dir.get(d, 0) + os.path.getsize(dst)
        if check and rel in LOOPS:
            y = decode(dst)
            # locate time zero by cross-correlating the decoded head with the known guard material
            g = int(GUARD * SR)
            ref = np.concatenate([x[-g:], x[:g]])
            c = np.correlate(y[:4 * g], ref, 'valid')
            off = int(np.argmax(c))                         # decoded index of ext[0]
            a = off + g                                      # decoded index of loop start (what the runtime uses ± slop)
            win = y[a:a + n]
            seam = np.concatenate([win[-4:], win[:4]])       # what the listener hears across loopEnd → loopStart
            jump = np.max(np.abs(np.diff(seam, 2)))
            d2 = np.abs(np.diff(win, 2))
            worst.append((jump / (np.percentile(d2, 99.9) + 1e-9), rel, off))
    json.dump(man, open(mpath, 'w'), indent=0, sort_keys=True)
    print(f'WAV {tot_wav / 1e6:.1f} MB → M4A {tot_m4a / 1e6:.2f} MB')
    for d, b in sorted(per_dir.items()):
        print(f'  {d:8s} {b / 1e6:5.2f} MB')
    if check:
        worst.sort(reverse=True)
        print('worst decoded loop seams (1.0 = typical sample step):', [(round(w, 2), r, o) for w, r, o in worst[:6]])


if __name__ == '__main__':
    main()
