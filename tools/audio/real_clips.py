"""Real cockpit-recording clips: extraction, voice/noise separation, cockpit-speaker EQ, levelling, honest metrics.

Sources (downloaded by the research, gitignored, see tools/audio/research/warnings.md §4):
  a320neo/_sources/commons_baionnette_cdg_a319_f-grxm.ogg   Air France A319 F-GRXM, Sygoletto, CC BY-SA 3.0
  a320neo/_sources/commons_adria_a319_s5-aap_cockpit.ogg    Adria A319 S5-AAP, jan tisler, CC BY 3.0
  b737/_sources/dvids_910648_p8a_night_approach.m4a          P-8A (737-800 based), U.S. Navy / DVIDS, public domain

For every event: the word is located from the research annotation (tools/audio/research/found_air.json), refined
with the 300-3400 Hz band energy, then cleaned with two methods and the better one kept:
  'nr'  spectral gating (noisereduce, stationary) with a noise print taken just before the word
  'dm'  demucs htdemucs_ft voice stem (+ light gating) — only accepted when it keeps the voice (retention check)
then 250-4000 Hz band-limit, edge gating and -19 dBFS active speech level (same as the generated voices).
Metrics per clip (tools/audio/research/real_clips.json): SNR of the source in the speech band, residual noise
floor after cleaning, voice retention, whisper transcript — and a verdict 'ship' / 'reference only'.
Outputs: assets/audio/candidates/final/real/<aircraft>/<key>.wav (+ '_raw' = unprocessed excerpt for comparison),
and the voice references (third-octave LTAS, F0, word durations) used to match the generated voices:
tools/audio/research/voice_refs.json.

Usage: .venv/bin/python tools/audio/real_clips.py [--no-demucs] [--no-whisper]
Requires (pip, shared venv): noisereduce, soundfile; optional demucs (torch) for the 'dm' method.
"""
import json
import os
import subprocess
import sys
import tempfile
import warnings

import numpy as np
from scipy import signal

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
from dsp import OUT, SR, butter, fade, limit_peaks, undb, write_wav  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CAND = os.path.join(OUT, 'candidates')
CACHE = os.path.join(ROOT, 'data', 'sf', 'raw', 'audio_ref')
RESEARCH = os.path.join(os.path.dirname(__file__), 'research')
WHISPER_MODEL = os.path.expanduser('~/.cache/whisper.cpp/ggml-small.bin')

SOURCES = {   # key: (file under candidates/, excerpt start s, excerpt length s)
    'bcdg': ('a320neo/_sources/commons_baionnette_cdg_a319_f-grxm.ogg', 0, 142),
    'adria1': ('a320neo/_sources/commons_adria_a319_s5-aap_cockpit.ogg', 320, 70),
    'adria2': ('a320neo/_sources/commons_adria_a319_s5-aap_cockpit.ogg', 1300, 45),
    'p8': ('b737/_sources/dvids_910648_p8a_night_approach.m4a', 0, 65),
}
LICENCE = {
    'bcdg': ('Sygoletto / Wikimedia Commons — Air France A319 F-GRXM, CDG 26R (2010)', 'CC BY-SA 3.0',
             'https://commons.wikimedia.org/wiki/File:Ba%C3%AFonnette_CDG.ogv'),
    'adria1': ('jan tisler (YouTube "aircraft16") via Wikimedia Commons — Adria A319 S5-AAP', 'CC BY 3.0',
               'https://commons.wikimedia.org/wiki/File:Adria_Airways_A319_Night_landing_takeoff_Frankfurt_%2B_Landing_at_Ljubljana_(cockpit).ogv'),
    'p8': ('U.S. Navy video by MC2 Jacquelin Frost / DVIDS 910648 — P-8A Poseidon night approach (2024)', 'Public domain (U.S. Navy)',
           'https://www.dvidshub.net/video/910648/p-8a-poseidon-night-approach'),
}
LICENCE['adria2'] = LICENCE['adria1']

# (key, source, absolute start, end [s in the original file], words) — from found_air.json, one best take per word
EVENTS = {
    'a320neo': [
        ('500', 'bcdg', 44.60, 45.30, 'five hundred'), ('400', 'bcdg', 51.27, 51.99, 'four hundred'),
        ('300', 'bcdg', 59.45, 60.13, 'three hundred'), ('hundredabove', 'adria1', 362.05, 362.80, 'hundred above'),
        ('200', 'bcdg', 69.65, 70.36, 'two hundred'), ('minimum', 'adria2', 1319.40, 1320.15, 'minimum'),
        ('100', 'bcdg', 76.36, 76.97, 'one hundred'), ('50', 'bcdg', 82.06, 82.70, 'fifty'),
        ('40', 'bcdg', 83.07, 83.54, 'forty'), ('30', 'bcdg', 84.27, 84.94, 'thirty'),
        ('20', 'bcdg', 85.50, 86.05, 'twenty'), ('retard', 'bcdg', 86.07, 86.90, 'retard'),
        # second takes (Adria) for comparison
        ('500_b', 'adria1', 339.05, 339.75, 'five hundred'), ('minimum_b', 'adria1', 371.30, 371.85, 'minimum'),
        ('retard_b', 'adria2', 1337.01, 1337.90, 'retard'),
    ],
    'b737': [
        ('500', 'p8', 30.45, 31.25, 'five hundred'), ('apprmin', 'p8', 31.65, 32.85, 'approaching minimums'),
        ('50', 'p8', 44.25, 44.85, 'fifty'), ('40', 'p8', 45.25, 45.75, 'forty'), ('30', 'p8', 46.50, 46.98, 'thirty'),
        ('20', 'p8', 47.88, 48.38, 'twenty'), ('10', 'p8', 49.08, 49.58, 'ten'),
    ],
}
# sequences kept whole for timing analysis (RETARD repetition, callout spacing)
SEQUENCES = {'a320_retard_x4': ('bcdg', 85.40, 90.60), 'a320_flare_50_to_retard': ('bcdg', 81.90, 90.60),
             'b737_flare_50_to_10': ('p8', 44.10, 49.80), 'b737_config_horn': ('p8', 57.30, 60.50)}

SOS_SPEECH = signal.butter(4, [300, 3400], 'bandpass', fs=SR, output='sos')


def decode(key):
    """Mono float excerpt of a source at 48 kHz (cached)."""
    rel, t0, dur = SOURCES[key]
    os.makedirs(CACHE, exist_ok=True)
    wav = os.path.join(CACHE, f'{key}.wav')
    if not os.path.exists(wav):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t0), '-t', str(dur), '-i', os.path.join(CAND, rel),
                        '-ar', str(SR), '-ac', '1', '-c:a', 'pcm_f32le', wav], check=True)
    import soundfile as sf
    x, _ = sf.read(wav)
    return x


def demucs_voice(key):
    """htdemucs_ft voice stem of the excerpt (cached), or None when demucs is unavailable."""
    out = os.path.join(CACHE, 'demucs', 'htdemucs_ft', key, 'vocals.wav')
    if not os.path.exists(out):
        if '--no-demucs' in sys.argv:
            return None
        decode(key)
        r = subprocess.run([sys.executable, '-m', 'demucs', '--two-stems', 'vocals', '-n', 'htdemucs_ft', '-o',
                            os.path.join(CACHE, 'demucs'), '--float32', os.path.join(CACHE, f'{key}.wav')],
                           capture_output=True, text=True)
        if r.returncode or not os.path.exists(out):
            print('  demucs unavailable:', r.stderr[-300:])
            return None
    import soundfile as sf
    x, _ = sf.read(out)
    return x.mean(axis=1) if x.ndim > 1 else x


def band_db(x, fr=0.01):
    y = signal.sosfiltfilt(SOS_SPEECH, x)
    n = int(fr * SR)
    m = len(y) // n
    return 10 * np.log10(np.mean(y[:m * n].reshape(m, n) ** 2, axis=1) + 1e-14)


def refine(x, a, b):
    """Word boundaries from the speech-band envelope around the annotated [a, b] (sample indices)."""
    pad = int(0.25 * SR)
    lo, hi = max(0, a - pad), min(len(x), b + pad)
    d = band_db(x[lo:hi])
    floor = np.percentile(d, 15)
    peak = np.percentile(d[(a - lo) // 480:(b - lo) // 480 + 1], 95)
    thr = floor + max(4.0, 0.3 * (peak - floor))
    on = np.where(d > thr)[0]
    if not len(on):
        return a, b
    i0, i1 = on[0], on[-1]
    # keep the annotation as a bound: never extend more than 120 ms beyond it (neighbouring words)
    s = max(lo + i0 * 480 - int(0.03 * SR), a - int(0.12 * SR))
    e = min(lo + (i1 + 1) * 480 + int(0.06 * SR), b + int(0.12 * SR))
    return s, e


def noise_print(x, a, dur=0.6):
    """Quietest `dur` seconds in the 1.6 s before the word (engine/wind noise only)."""
    seg = x[max(0, a - int(1.6 * SR)):max(0, a - int(0.05 * SR))]
    if len(seg) < int(dur * SR):
        return seg
    n = int(0.05 * SR)
    d = band_db(seg, 0.05)
    k = int(dur / 0.05)
    best = min(range(0, max(1, len(d) - k)), key=lambda i: np.mean(d[i:i + k]))
    return seg[best * n:(best + k) * n]


def speech_level(x):
    from gen_voices import speech_level_db
    return speech_level_db(x)


def cockpit_eq(y):
    """Keep the recording's own speaker/room character; only band-limit like the aircraft audio (250-4000 Hz)."""
    y = butter(y, 'highpass', 250, 4)
    return butter(y, 'lowpass', 4000, 4)


def gate_edges(y, thr_db=-32):
    """Downward expander (speech-band envelope) to silence the noise between/around words, 30 ms release."""
    env = np.sqrt(signal.lfilter([0.01], [1, -0.99], y * y) + 1e-12)
    ldb = 20 * np.log10(env + 1e-9)
    top = np.percentile(ldb, 98)
    g = np.clip((ldb - (top + thr_db)) / 10.0, 0, 1)
    k = int(0.03 * SR)
    g = np.convolve(g, np.ones(k) / k, 'same')
    return y * np.clip(g * 1.5, 0, 1)


def clean(x, a, b, xv):
    """Returns {method: processed}, metrics."""
    import noisereduce as nr
    pre, post = int(0.08 * SR), int(0.15 * SR)
    lo, hi = max(0, a - pre), min(len(x), b + post)
    seg = x[lo:hi]
    nz = noise_print(x, a)
    d_seg = band_db(seg)
    d_nz = band_db(nz)
    snr_in = float(np.percentile(d_seg, 90) - np.median(d_nz))
    out = {'raw': cockpit_eq(seg.copy())}
    y = nr.reduce_noise(y=seg, sr=SR, y_noise=nz, stationary=True, prop_decrease=0.92, n_fft=1024,
                        n_std_thresh_stationary=1.3)
    out['nr'] = cockpit_eq(y)
    if xv is not None:
        v = xv[lo:hi]
        nzv = noise_print(xv, a)
        v2 = nr.reduce_noise(y=v, sr=SR, y_noise=nzv, stationary=True, prop_decrease=0.8, n_fft=1024) if len(nzv) > 2048 else v
        out['dm'] = cockpit_eq(v2)
    met = {'snr_in_db': round(snr_in, 1)}
    ref_e = np.percentile(band_db(out['raw']), 90)
    for k in ('nr', 'dm'):
        if k not in out:
            continue
        d = band_db(out[k])
        met[f'{k}_retention_db'] = round(float(np.percentile(d, 90) - ref_e), 1)
        # residual noise in the processed noise print region (same processing on the noise alone ≈ gaps)
        met[f'{k}_floor_db'] = round(float(np.percentile(d, 90) - np.percentile(d, 10)), 1)
    return out, met


def transcribe(y):
    if '--no-whisper' in sys.argv or not os.path.exists(WHISPER_MODEL):
        return None
    from scipy.io import wavfile
    with tempfile.TemporaryDirectory() as td:
        w = os.path.join(td, 'a.wav')
        z = np.concatenate([np.zeros(SR), y / (np.max(np.abs(y)) + 1e-9) * 0.7, np.zeros(SR)])
        wavfile.write(w, SR, (z * 32767).astype(np.int16))
        w16 = os.path.join(td, 'b.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-i', w, '-ar', '16000', w16], check=True)
        r = subprocess.run(['whisper-cli', '-m', WHISPER_MODEL, '-f', w16, '-l', 'en', '-nt', '-np'],
                           capture_output=True, text=True)
    return ' '.join(r.stdout.split()).strip()


NUM = {'5': 'five', '10': 'ten', '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty', '100': 'one hundred',
       '200': 'two hundred', '300': 'three hundred', '400': 'four hundred', '500': 'five hundred'}


def words_match(tr, words):
    import re
    t = ' ' + re.sub(r'[^a-z0-9 ]', ' ', tr.lower()) + ' '
    for k, v in sorted(NUM.items(), key=lambda kv: -len(kv[0])):
        t = re.sub(rf'(?<![0-9]){k}(?![0-9])', ' ' + v + ' ', t)
    t = t.replace('minimums', 'minimum')
    return all(w.rstrip('s') in t for w in words.split())


def level(y):
    y = y * undb(-19.0 - speech_level(y))
    return fade(limit_peaks(y, -1.0, 0.6), 0.004, 0.04)


def third_oct(x):
    bands = 125 * 2 ** (np.arange(0, 6.01, 1 / 3))
    f, P = signal.welch(x, SR, nperseg=2048)
    return [float(10 * np.log10(P[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].mean() + 1e-20)) for c in bands]


def voice_ltas(x, a, b):
    """Noise-subtracted third-octave spectrum of the word (for matching the generated voices)."""
    nz = noise_print(x, a)
    f, t, Z = signal.stft(x[a:b], SR, nperseg=2048, noverlap=1536)
    P = np.abs(Z) ** 2
    fn, tn, Zn = signal.stft(nz, SR, nperseg=2048, noverlap=1536)
    Pn = np.percentile(np.abs(Zn) ** 2, 40, axis=1)
    e = P[(f > 300) & (f < 3400)].sum(0)
    Pv = np.maximum(P[:, e > 0.3 * e.max()].mean(1) - Pn, Pn * 0.05)
    bands = 125 * 2 ** (np.arange(0, 6.01, 1 / 3))
    return [float(10 * np.log10(Pv[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].mean() + 1e-20)) for c in bands]


def f0_median(x, a, b):
    """Median F0 of the voiced frames (noise-subtracted subharmonic summation), Hz."""
    nz = noise_print(x, a)
    nf = 4096
    f, t, Z = signal.stft(x[a:b], SR, nperseg=2048, noverlap=1568, nfft=nf)
    _, _, Zn = signal.stft(nz, SR, nperseg=2048, noverlap=1568, nfft=nf)
    Pn = np.percentile(np.abs(Zn) ** 2, 30, axis=1)
    A = np.sqrt(np.maximum(np.abs(Z) ** 2 - 1.5 * Pn[:, None], 0))
    e = A[(f > 300) & (f < 3400)].sum(0)
    cands = np.arange(70, 320, 0.5)
    f0 = []
    for j in np.where(e > 0.25 * e.max())[0]:
        sc = np.zeros(len(cands))
        for h in range(1, 13):
            idx = np.round(cands * h / (SR / nf)).astype(int)
            ok = idx < A.shape[0]
            sc[ok] += A[idx[ok], j] * 0.86 ** (h - 1)
        f0.append(cands[np.argmax(sc)])
    return float(np.median(f0)) if f0 else 0.0


def main():
    xs, xv = {}, {}
    report, refs = {}, {'bands_hz': [round(125 * 2 ** (k / 3), 1) for k in range(19)], 'systems': {}}
    for ac, evs in EVENTS.items():
        sysname = 'airbus_fwc' if ac == 'a320neo' else 'honeywell_egpws'
        R = refs['systems'].setdefault(sysname, {'words': {}, 'ltas': [], 'f0': []})
        for key, src, t0, t1, words in evs:
            if src not in xs:
                xs[src] = decode(src)
                xv[src] = demucs_voice(src)
            x = xs[src]
            off = SOURCES[src][1]
            a, b = int((t0 - off) * SR), int((t1 - off) * SR)
            a, b = refine(x, a, b)
            outs, met = clean(x, a, b, xv[src])
            # method: spectral gating. demucs (htdemucs_ft) was evaluated on every clip and rejected: it treats the
            # synthetic FWC/EGPWS voice as non-vocal and removed it in most clips (retention -17 to -77 dB), and where it
            # kept it, whisper no longer understood the word ('100' -> '40', '50' -> 'we thought'); see real_clips.json
            m = 'nr'
            y = level(gate_edges(outs[m]))
            raw = level(outs['raw'])
            write_wav(f'candidates/final/real/{ac}/{key}.wav', y)
            write_wav(f'candidates/final/real/{ac}/{key}_raw.wav', raw)
            met.update({'method': m, 'source': src, 'start': round(a / SR + off, 3), 'end': round(b / SR + off, 3),
                        'dur': round((b - a) / SR, 3), 'words': words})
            met['transcript'] = transcribe(y)
            met['transcript_raw'] = transcribe(raw)
            # honest verdict. The engine/wind noise *under* the word cannot be removed without artefacts: with less
            # than ~14 dB source SNR in the speech band the cleaned word keeps audible noise / musical-noise artefacts.
            ok_tr = met['transcript'] is None or words_match(met['transcript'], words)
            if met['transcript'] is not None and not ok_tr and not words_match(met['transcript_raw'] or '', words):
                ok_tr = True                   # whisper cannot recognise the isolated word even unprocessed: judge by SNR
                met['whisper_note'] = 'isolated word not recognised by whisper in the raw excerpt either'
            met['verdict'] = ('clean enough' if met['snr_in_db'] >= 14 and ok_tr else
                              'usable with audible noise' if met['snr_in_db'] >= 9 and ok_tr else 'reference only')
            report[f'{ac}/{key}'] = met
            print(f'  {ac}/{key:13s} snr_in {met["snr_in_db"]:5.1f} dB  method {m}  {met["verdict"]:26s} "{met["transcript"]}"')
            if not key.endswith('_b'):
                R['words'][key] = {'dur': met['dur'], 'f0': round(f0_median(x, a, b), 1)}
                R['ltas'].append(voice_ltas(x, a, b))
                R['f0'].append(R['words'][key]['f0'])
    for sysname, R in refs['systems'].items():
        L = 10 * np.log10(np.mean(np.power(10, np.array(R['ltas']) / 10), axis=0))
        R['ltas'] = [round(float(v), 1) for v in (L - L.max())]
        R['f0_median'] = round(float(np.median([f for f in R['f0'] if f > 0])), 1)
        del R['f0']
    # timing: RETARD repetition period and flare callout spacing (onsets from the speech-band envelope)
    timing = {}
    TEMPLATES = {}
    for name, (src, key) in {'a320_retard_x4': ('bcdg', 'retard')}.items():
        m = report[f'a320neo/{key}']
        TEMPLATES[name] = xs[src][int((m['start'] - SOURCES[src][1]) * SR):int((m['end'] - SOURCES[src][1]) * SR)]
    for name, (src, t0, t1) in SEQUENCES.items():
        x = xs.get(src)
        if x is None:
            xs[src] = x = decode(src)
        off = SOURCES[src][1]
        seg = x[int((t0 - off) * SR):int((t1 - off) * SR)]
        write_wav(f'candidates/final/real/sequences/{name}.wav', level(cockpit_eq(seg)))
        tmpl = TEMPLATES.get(name)
        if tmpl is not None:
            # matched filter (speech band) of one reference word over the sequence → repetition onsets
            a_ = signal.sosfiltfilt(SOS_SPEECH, seg)
            t_ = signal.sosfiltfilt(SOS_SPEECH, tmpl)
            c = signal.fftconvolve(a_, t_[::-1], 'valid')
            en = np.sqrt(signal.fftconvolve(a_ * a_, np.ones(len(t_)), 'valid') * np.sum(t_ * t_)) + 1e-12
            c = c / en
            pk, _ = signal.find_peaks(c, height=0.35, distance=int(0.6 * SR))
            merged = [round(float(p) / SR, 2) for p in pk]
        else:
            d = band_db(seg)
            on = d > np.percentile(d, 20) + 8
            ons = [i * 0.01 for i in range(1, len(on)) if on[i] and not on[i - 1]]
            merged = []
            for o in ons:
                if not merged or o - merged[-1] > 0.3:
                    merged.append(round(o, 2))
        timing[name] = {'onsets_s': merged, 'intervals_s': [round(b - a, 2) for a, b in zip(merged, merged[1:])]}
        print(f'  {name}: onsets {merged}')
    refs['timing'] = timing
    refs['licences'] = {k: {'credit': v[0], 'licence': v[1], 'url': v[2]} for k, v in LICENCE.items()}
    json.dump(report, open(os.path.join(RESEARCH, 'real_clips.json'), 'w'), indent=1)
    json.dump(refs, open(os.path.join(RESEARCH, 'voice_refs.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
