"""Technical metrics of every candidate original (assets/audio/candidates/<id>/<sound>/orig/*).

    .venv/bin/python tools/audio/research/analyze.py [--whisper] [path-filter]

Writes tools/audio/research/analysis.json: per file {codec, sr, channels, bits, dur, peak_dbfs, clipped (samples at
|x| >= 0.999), rms_dbfs, noise_dbfs (10th-percentile 50 ms frame RMS), snr_db, bw_hz (frequency below which 99 % of the
energy lies — shows 8/11/22 kHz resampling), dc, transcript (whisper.cpp small model, --whisper)}.
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CAND = os.path.join(ROOT, 'assets', 'audio', 'candidates')
OUT = os.path.join(os.path.dirname(__file__), 'analysis.json')
WHISPER_MODEL = os.path.expanduser('~/.cache/whisper.cpp/ggml-small.bin')
AUDIO_EXT = ('.wav', '.ogg', '.mp3', '.m4a', '.flac', '.aac', '.webm', '.opus', '.mp4')


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                        'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,sample_fmt:format=duration',
                        '-of', 'json', path], capture_output=True, text=True)
    j = json.loads(r.stdout or '{}')
    s = (j.get('streams') or [{}])[0]
    return {'codec': s.get('codec_name'), 'sr': int(s.get('sample_rate') or 0), 'channels': s.get('channels'),
            'bits': int(s.get('bits_per_sample') or s.get('bits_per_raw_sample') or 0) or None,
            'sample_fmt': s.get('sample_fmt'), 'dur': float((j.get('format') or {}).get('duration') or 0)}


def decode(path, sr=None):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1']
    if sr:
        cmd += ['-ar', str(sr)]
    cmd += ['-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def decode_multi(path):
    info = probe(path)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    ch = info['channels'] or 1
    return x.reshape(-1, ch) if len(x) % ch == 0 else x.reshape(-1, 1)


def metrics(path):
    info = probe(path)
    xm = decode_multi(path)
    x = xm.mean(axis=1) if xm.size else np.zeros(1)
    sr = info['sr'] or 48000
    m = dict(info)
    if not xm.size:
        return m
    pk = float(np.max(np.abs(xm)))
    m['peak_dbfs'] = round(20 * np.log10(pk + 1e-12), 1)
    m['clipped'] = int(np.sum(np.abs(xm) >= 0.999))
    m['rms_dbfs'] = round(10 * np.log10(np.mean(x * x) + 1e-20), 1)
    n = max(1, int(0.05 * sr))
    k = len(x) // n
    if k >= 4:
        fr = 10 * np.log10(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1) + 1e-20)
        m['noise_dbfs'] = round(float(np.percentile(fr, 10)), 1)
        m['loud_dbfs'] = round(float(np.percentile(fr, 95)), 1)
        m['snr_db'] = round(m['loud_dbfs'] - m['noise_dbfs'], 1)
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2 if len(x) > 16 else np.zeros(2)
    c = np.cumsum(spec)
    if c[-1] > 0:
        f = np.fft.rfftfreq(len(x), 1 / sr)
        m['bw_hz'] = int(f[np.searchsorted(c, 0.99 * c[-1])])
        m['centroid_hz'] = int(np.sum(f * spec) / c[-1])
    m['dc'] = round(float(np.mean(x)), 4)
    if (info['channels'] or 1) > 1 and xm.shape[1] > 1:
        d = xm[:, 0] - xm[:, 1]
        m['stereo_diff_db'] = round(10 * np.log10(np.mean(d * d) / (np.mean(xm[:, 0] ** 2) + 1e-20) + 1e-20), 1)
    return m


def transcribe(path):
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, 'in.wav')
        # pad 1 s of silence on both sides: whisper misses very short clips otherwise
        subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-af', 'adelay=1000,apad=pad_dur=1', '-ar', '16000',
                        '-ac', '1', wav], check=True)
        r = subprocess.run(['whisper-cli', '-m', WHISPER_MODEL, '-f', wav, '-l', 'en', '-nt', '-np'],
                           capture_output=True, text=True)
        return ' '.join(r.stdout.split()).strip()


def main():
    flt = [a for a in sys.argv[1:] if not a.startswith('--')]
    wh = '--whisper' in sys.argv
    old = json.load(open(OUT)) if os.path.exists(OUT) else {}
    for dp, dn, fn in os.walk(CAND):
        if os.path.basename(dp) != 'orig' and '/_sources' not in dp:
            continue
        for f in sorted(fn):
            if not f.lower().endswith(AUDIO_EXT):
                continue
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, ROOT)
            if flt and not any(s in rel for s in flt):
                continue
            st = os.stat(p)
            prev = old.get(rel, {})
            if prev.get('mtime') == st.st_mtime and prev.get('size') == st.st_size and (not wh or 'transcript' in prev):
                continue
            m = metrics(p)
            m['size'], m['mtime'] = st.st_size, st.st_mtime
            if wh and '/_sources' not in dp and m.get('dur', 0) < 60:
                m['transcript'] = transcribe(p)
            elif 'transcript' in prev:
                m['transcript'] = prev['transcript']
            old[rel] = m
            print(rel, {k: m.get(k) for k in ('sr', 'channels', 'bits', 'dur', 'peak_dbfs', 'snr_db', 'bw_hz', 'transcript')})
    json.dump(old, open(OUT, 'w'), indent=1, sort_keys=True)


if __name__ == '__main__':
    main()
