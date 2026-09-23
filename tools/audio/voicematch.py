"""Pick the ElevenLabs voice closest to each real voice-warning system (evidence for tools/audio/gen_voices.py).

References (tools/audio/research/voice_refs.json, from tools/audio/real_clips.py): median F0 and word durations
of the real Airbus FWC voice (A319 cockpit recordings) and Honeywell EGPWS voice (P-8A recording). Documented
character (Wikipedia 'Voice warning system', non-primary): Airbus = male, British RP accent on recent builds;
Boeing/Honeywell = male, American. Military (F-16 VMS, F-22, UH-60) = female voice, no real recording available.

Each premade candidate voice renders the reference words (same settings as the game: stability 0.85, speed from
gen_voices.voice()); the score is |F0 difference| in semitones + 6 x |log2 duration ratio| (speaking rate) + an
accent mismatch penalty. No voice cloning: only ElevenLabs premade voices and two Voice Design voices (generated
from a text description) are considered.
Outputs tools/audio/research/voicematch.json and audition files under assets/audio/candidates/final/voices/.
Usage: .venv/bin/python tools/audio/voicematch.py
"""
import json
import os
import sys
import warnings

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import SR, write_wav  # noqa: E402

RESEARCH = os.path.join(os.path.dirname(__file__), 'research')

CANDIDATES = {   # voice id: (name, accent)
    'pqHfZKP75CvOlQylNhV4': ('Bill', 'american'), 'cjVigY5qzO86Huf0OWal': ('Eric', 'american'),
    'nPczCjzI2devNBz1zQrb': ('Brian', 'american'), 'pNInz6obpgDQGcFmaJgB': ('Adam', 'american'),
    'CwhRBWXzGAHq8TQ4Fs17': ('Roger', 'american'), 'iP95p4xoKVk53GoZ742B': ('Chris', 'american'),
    'onwK4e9ZLuTAKqWW03F9': ('Daniel', 'british'), 'JBFqnCBsd6RMkjVDRZzb': ('George', 'british'),
    # ElevenLabs Voice Design (a synthetic voice generated from a text description — not a clone of anybody):
    # "A deep, low-pitched British man in his fifties with a neutral Received Pronunciation accent. Calm, flat,
    #  precise and clipped delivery, like a recorded automated aircraft cockpit announcement." (previews A and B)
    '1aHz9yvm2tzigCRZ6LR6': ('DesignA', 'british'), 'WrWxGio5YUgz9Ahdti5R': ('DesignB', 'british'),
}
FEMALE = {'EXAVITQu4vr4xnSDxMaL': ('Sarah', 'american'), 'Xb7hH8MSUJpSbSDYk0k2': ('Alice', 'british'),
          'XrExE9yKIg1WjnnlVkGX': ('Matilda', 'american'), 'hpp4J3VqNfWAUOO0d1Us': ('Bella', 'american'),
          'pFZP5JQG7iQjIQuC4Bku': ('Lily', 'british')}
SYSTEMS = {
    'airbus_fwc': {'accent': 'british', 'words': {'500': 'Five hundred', '100': 'One hundred', '50': 'Fifty',
                                                  '40': 'Forty', 'retard': 'Retard', 'hundredabove': 'Hundred above',
                                                  'minimum': 'Minimum'}},
    'honeywell_egpws': {'accent': 'american', 'words': {'500': 'Five hundred', 'apprmin': 'Approaching minimums',
                                                        '50': 'Fifty', '40': 'Forty', '10': 'Ten'}},
}


def f0_stats(x):
    """Median F0 (Hz) and spread (semitones) of a clean voice (autocorrelation, voiced frames only)."""
    fr, hop = int(0.04 * SR), int(0.01 * SR)
    f0 = []
    env = np.sqrt(np.convolve(x * x, np.ones(fr) / fr, 'same'))
    thr = 0.2 * env.max()
    for i in range(0, len(x) - fr, hop):
        if env[i + fr // 2] < thr:
            continue
        seg = x[i:i + fr] * np.hanning(fr)
        ac = np.correlate(seg, seg, 'full')[fr - 1:]
        lo, hi = int(SR / 320), int(SR / 65)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.45 * ac[0]:
            f0.append(SR / k)
    if len(f0) < 3:
        return 0.0, 0.0
    f0 = np.array(f0)
    med = float(np.median(f0))
    f0 = f0[np.abs(np.log2(f0 / med)) < 0.6]          # drop octave errors
    return med, float(np.std(12 * np.log2(f0 / med)))


def main():
    import gen_voices as gv
    refs = json.load(open(os.path.join(RESEARCH, 'voice_refs.json')))['systems']
    out = {'method': __doc__.split('\n\n')[1].replace('\n', ' '), 'systems': {}}
    for sysname, S in SYSTEMS.items():
        R = refs[sysname]
        rows = []
        for vid, (name, accent) in CANDIDATES.items():
            gv.EL_VOICES['_audition'] = (vid, name)
            f0s, durs, spreads = [], [], []
            clips = []
            for key, text in S['words'].items():
                x = gv.voice(text, '_audition', 190 if key not in ('retard', 'apprmin', 'hundredabove', 'minimum') else 182, takes=1)
                f0, sp = f0_stats(x)
                if f0:
                    f0s.append(f0); spreads.append(sp)
                if key in R['words']:
                    durs.append(np.log2(len(x) / SR / max(0.3, R['words'][key]['dur'] - 0.1)))
                clips.append(x); clips.append(np.zeros(int(0.35 * SR)))
            f0m = float(np.median(f0s)) if f0s else 0.0
            d_f0 = abs(12 * np.log2(f0m / R['f0_median'])) if f0m else 24
            d_dur = float(np.mean(np.abs(durs))) if durs else 1
            score = d_f0 + 6 * d_dur + (4 if accent != S['accent'] else 0)
            rows.append({'voice': name, 'id': vid, 'accent': accent, 'f0_hz': round(f0m, 1), 'f0_spread_st': round(float(np.mean(spreads)), 2),
                         'df0_st': round(d_f0, 2), 'dur_log2': round(d_dur, 3), 'score': round(score, 2)})
            write_wav(f'candidates/final/voices/{sysname}/{name}.wav', gv.cockpit_audio(np.concatenate(clips), np.random.default_rng(1), 'speaker'))
            print(f'  {sysname:16s} {name:8s} f0 {f0m:6.1f} Hz (ref {R["f0_median"]})  dF0 {d_f0:5.2f} st  dur {d_dur:5.3f}  score {score:6.2f}')
        rows.sort(key=lambda r: r['score'])
        out['systems'][sysname] = {'reference_f0_hz': R['f0_median'], 'accent': S['accent'], 'ranking': rows, 'chosen': rows[0]['voice'],
                                   'chosen_id': rows[0]['id']}
    json.dump(out, open(os.path.join(RESEARCH, 'voicematch.json'), 'w'), indent=1)
    import elevenlabs as el
    print('ElevenLabs characters used (uncached):', el.chars_used())


if __name__ == '__main__':
    main()
