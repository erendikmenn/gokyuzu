"""Soundtrack build: Eleven Music generation → mastering → AAC/M4A delivery files in assets/music/.

  generate   compose every track in tools/music/tracks.py (cached raw 48 kHz stereo PCM in data/sf/raw/music/,
             so a rebuild never spends credits again; delete a cache file to re-roll that track)
  master     trim silence, click-free fade-in, fade-out tail (unless the track already decays), slow leveller for very
             dynamic tracks (LRA > MAX_LRA), loudness-normalise to TARGET_LUFS with a true-peak ceiling, encode AAC-LC in M4A (Apple encoder, ~128 kbit/s VBR)
  check      measure the delivered files (ffmpeg ebur128: integrated loudness, LRA, true peak), head/tail levels and
             the player's crossfade (every track end into every track start) for level dips and bumps

Usage: .venv/bin/python tools/music/build.py [generate] [master] [check]   (no argument = all three)
"""
import json
import os
import subprocess
import sys
import tempfile
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import minimum_filter1d

sys.path.insert(0, os.path.dirname(__file__))
warnings.filterwarnings('ignore')
import eleven  # noqa: E402
from tracks import MODEL, TRACKS  # noqa: E402

ROOT = eleven.ROOT
OUT = os.path.join(ROOT, 'assets', 'music')
MASTERS = os.path.join(eleven.CACHE, 'master')
SR = 48000
TARGET_LUFS = -18.0      # every file at the same integrated loudness; the player sets the level in the mix
CEILING_DBTP = -1.5      # true-peak ceiling after normalisation (AAC decoding adds a little overshoot)
BITRATE = 128000
MAX_LRA = 10.0           # LU; more dynamic tracks go through the slow leveller
XFADE = 4.0              # s, must match src/music/index.js CROSSFADE


def request(t):
    body = {'prompt': t['prompt'], 'music_length_ms': t['ms'], 'model_id': MODEL, 'force_instrumental': True}
    return body


def generate():
    def one(t):
        p = eleven.compose(request(t), 'pcm_48000', tag=t['id'])
        return t['id'], p
    with ThreadPoolExecutor(2) as ex:        # plan concurrency limit
        for tid, p in ex.map(one, TRACKS):
            meta = json.load(open(p + '.json'))
            print(f"{tid:16s} {os.path.basename(p)}  {meta['bytes'] / SR / 4:6.1f} s  song-id {meta['headers'].get('song-id', '?')}")


def load_raw(t):
    p = eleven.compose(request(t), 'pcm_48000', tag=t['id'])     # cached: no request
    x = np.frombuffer(open(p, 'rb').read(), dtype='<i2').astype(np.float64) / 32768.0
    return x.reshape(-1, 2)


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-12))


def rms_env(x, win):
    m = (x ** 2).mean(axis=1)
    k = np.ones(win) / win
    return np.sqrt(np.convolve(m, k, mode='same'))


def ffmpeg_loudness(path):
    """→ {I, LRA, TP} from ffmpeg's EBU R128 meter (true peak = 4× oversampled)."""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true:framelog=quiet',
                        '-f', 'null', '-'], capture_output=True, text=True)
    txt = r.stderr[r.stderr.rfind('Summary:'):]
    out = {}
    for line in txt.splitlines():
        line = line.strip()
        if line.startswith('I:'):
            out['I'] = float(line.split()[1])
        elif line.startswith('LRA:'):
            out['LRA'] = float(line.split()[1])
        elif line.startswith('Peak:'):
            out['TP'] = float(line.split()[1])
    return out


def write_wav(path, x):
    wavfile.write(path, SR, np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16))


def true_peak(x):
    up = signal.resample_poly(x, 4, 1, axis=0)
    return float(np.abs(up).max())


def limiter(x, ceiling):
    """Look-ahead peak limiter (5 ms attack, 120 ms release) on the 4× oversampled peak envelope."""
    up = np.abs(signal.resample_poly(x, 4, 1, axis=0)).max(axis=1)
    pk = up.reshape(-1, 4).max(axis=1)[:len(x)]
    need = np.minimum(1.0, ceiling / np.maximum(pk, 1e-9))
    la = int(0.005 * SR)
    # look-ahead: the gain reaches its target before the peak (running minimum over ±5 ms)
    g = minimum_filter1d(need, size=2 * la + 1, mode='nearest')
    rel = np.exp(-1 / (0.12 * SR))
    out = np.empty_like(g)
    cur = 1.0
    for i in range(len(g)):                 # instant attack (look-ahead covers it), exponential release
        cur = g[i] if g[i] < cur else g[i] + (cur - g[i]) * rel
        out[i] = cur
    att = np.exp(-1 / (0.0015 * SR))        # smooth the attack corners
    out = signal.lfilter([1 - att], [1, -att], out[::-1])[::-1]
    return x * np.minimum(out, 1.0)[:, None]


def leveler(x, ratio=3.0, max_db=8.0):
    """Slow 3:1 loudness leveller around the track's mean (3 s windows, zero-phase smoothed, ±8 dB): shrinks the loudness
    range of very dynamic tracks so quiet passages stay audible under the engines and climaxes do not jump out.
    Passages far below the mean (fades, silences) are left alone."""
    hop = int(0.1 * SR)
    win = int(3 * SR)
    p = (x ** 2).mean(axis=1)
    c = np.concatenate([[0], np.cumsum(p)])
    centers = np.arange(0, len(x), hop)
    lo = np.clip(centers - win // 2, 0, len(x))
    hi = np.clip(centers + win // 2, 0, len(x))
    st = db(np.sqrt((c[hi] - c[lo]) / np.maximum(hi - lo, 1)))
    ref = db(np.sqrt(p.mean()))
    dev = st - ref
    g = np.clip(-dev * (1 - 1 / ratio), -max_db, max_db)
    g = np.where(dev < -16, np.minimum(g, 0), g)            # never lift fades / near-silence
    a = np.exp(-1 / (1.5 / 0.1))                              # 1.5 s time constant at the 10 Hz control rate
    g = signal.filtfilt([1 - a], [1, -a], g)
    gs = np.interp(np.arange(len(x)), centers, g)
    return x * (10 ** (gs / 20))[:, None]


def master_one(t):
    x = load_raw(t)
    env = rms_env(x, int(0.05 * SR))
    lvl = db(env)
    loud = np.where(lvl > -60)[0]
    # start: skip a near-silent intro (400 ms level 35 dB under the track, e.g. a faint riser before the first hit)
    lvl4 = db(rms_env(x, int(0.4 * SR)))
    start = np.argmax(lvl4 > db(np.sqrt((x ** 2).mean())) - 35)
    a = max(loud[0] - int(0.03 * SR), start - int(0.25 * SR), 0)
    b = min(len(x), loud[-1] + int(0.25 * SR))
    x = x[a:b].copy()
    n = len(x)
    # does the track already decay into its end? (last 2 s vs. the whole track)
    body = db(np.sqrt((x ** 2).mean()))
    tail = db(np.sqrt((x[-int(2 * SR):] ** 2).mean()))
    fade_s = 0.6 if tail < body - 14 else 5.0
    fi = int((0.012 if a <= loud[0] else 0.25) * SR)          # click-free start (longer when an intro was cut)
    x[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(fade_s * SR)
    x[-fo:] *= (np.cos(np.linspace(0, np.pi / 2, fo)) ** 2)[:, None]
    # loudness: measure with ffmpeg on a temporary WAV, apply gain, limit to the true-peak ceiling
    os.makedirs(MASTERS, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = os.path.join(td, 'm.wav')
        write_wav(tmp, x)
        L0 = ffmpeg_loudness(tmp)
        levelled = L0['LRA'] > MAX_LRA
        if levelled:
            x = leveler(x)
            write_wav(tmp, x)
            L0 = {**ffmpeg_loudness(tmp), 'LRA_raw': L0['LRA']}
    g = 10 ** ((TARGET_LUFS - L0['I']) / 20)
    y = x * g
    ceil = 10 ** (CEILING_DBTP / 20)
    tp = true_peak(y)
    limited = tp > ceil
    if limited:
        y = limiter(y, ceil * 0.97)
    master = os.path.join(MASTERS, f"{t['id']}.wav")
    write_wav(master, y)
    L1 = ffmpeg_loudness(master)
    # a limited master lost a little loudness: one corrective pass (small, so the limiter barely changes)
    if abs(L1['I'] - TARGET_LUFS) > 0.3:
        y = y * 10 ** ((TARGET_LUFS - L1['I']) / 20)
        if true_peak(y) > ceil:
            y = limiter(y, ceil * 0.97)
        write_wav(master, y)
        L1 = ffmpeg_loudness(master)
    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, f"{t['id']}.m4a")
    subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', str(BITRATE), '-q', '127', '-s', '2', master, dst],
                   check=True, capture_output=True)
    return {'id': t['id'], 'sec': round(n / SR, 1), 'raw_lufs': L0['I'], 'raw_tp': L0['TP'], 'gain_db': round(float(db(g)), 1),
            'limited': limited, 'levelled': levelled, 'lra': L0['LRA'], 'fade_s': fade_s, 'tail_rel_db': round(float(tail - body), 1)}


def master():
    with ThreadPoolExecutor(4) as ex:
        for r in ex.map(master_one, TRACKS):
            print(r)


def decode(path):
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, 'o.wav')
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', f'LEI16@{SR}', path, out], check=True, capture_output=True)
        sr, x = wavfile.read(out)
    return x.astype(np.float64) / 32768.0


def check():
    rows, heads, tails, levels = [], {}, {}, {}
    total = 0
    for t in TRACKS:
        f = os.path.join(OUT, f"{t['id']}.m4a")
        L = ffmpeg_loudness(f)
        x = decode(f)
        kb = os.path.getsize(f) / 1024
        total += kb
        sec = len(x) / SR
        env = db(rms_env(x, int(0.4 * SR)))
        # head: first sample above -50 dBFS (s); tail: level of the last 2 s relative to the whole track
        first = np.argmax(np.abs(x).max(axis=1) > 10 ** (-50 / 20)) / SR
        whole = db(np.sqrt((x ** 2).mean()))
        tail = db(np.sqrt((x[-2 * SR:] ** 2).mean())) - whole
        edge = float(np.abs(x[-64:]).max())
        dropouts = float((env[int(2 * SR):-int(6 * SR)] < whole - 30).mean())    # near-silent stretches mid-track
        rows.append((t['id'], sec, kb, kb * 8 / sec, L['I'], L['LRA'], L['TP'], first, tail, edge, dropouts))
        heads[t['id']] = x[:int(XFADE * SR * 2)]
        levels[t['id']] = whole
        tails[t['id']] = x[-int(XFADE * SR):]
    print(f"{'track':16s} {'len':>6s} {'KB':>6s} {'kbps':>5s} {'LUFS':>6s} {'LRA':>5s} {'TP':>6s} {'head':>5s} {'tail':>6s} {'edge':>6s} {'gaps':>5s}")
    for r in rows:
        print(f"{r[0]:16s} {int(r[1]) // 60}:{int(r[1]) % 60:02d} {r[2]:6.0f} {r[3]:5.0f} {r[4]:6.1f} {r[5]:5.1f} {r[6]:6.1f} {r[7]:5.2f} {r[8]:6.1f} {r[9]:6.4f} {r[10]:5.3f}")
    print(f'total {total / 1024:.1f} MB, {sum(r[1] for r in rows) / 60:.1f} min')
    # crossfade simulation, as the player does it (linear fades over the last XFADE s of A and the first XFADE s of B):
    # short-term level (400 ms) through the junction → longest near-silent gap (< -50 dBFS) and the loudest moment of
    # the overlap compared with the louder of the two tracks' whole-track RMS (a bump > 0 dB: both play loud at once)
    n = int(XFADE * SR)
    ramp = np.linspace(0, 1, n)[:, None]
    worst_gap, worst_bump, quiet = (0.0, ''), (-99.0, ''), (0.0, '')
    for a in tails:
        for b in heads:
            if a == b:
                continue
            seq = np.concatenate([tails[a] * (1 - ramp) + heads[b][:n] * ramp, heads[b][n:]])
            e = db(rms_env(seq, int(0.4 * SR)))
            below = e < -50
            run = best = 0
            for v in below:
                run = run + 1 if v else 0
                best = max(best, run)
            gap = best / SR
            bump = e[:n].max() - max(levels[a], levels[b])
            low = e[int(0.2 * SR):-int(0.2 * SR)].min()
            if gap > worst_gap[0]:
                worst_gap = (gap, f'{a}→{b}')
            if bump > worst_bump[0]:
                worst_bump = (bump, f'{a}→{b}')
            if low < quiet[0]:
                quiet = (low, f'{a}→{b}')
    print(f'crossfade {XFADE:.0f} s, {len(tails) * (len(tails) - 1)} pairs: longest gap below -50 dBFS {worst_gap[0]:.2f} s '
          f'({worst_gap[1] or "none"}), quietest moment {quiet[0]:.1f} dBFS ({quiet[1]}), '
          f'loudest moment vs. track RMS {worst_bump[0]:+.1f} dB ({worst_bump[1]})')


if __name__ == '__main__':
    steps = sys.argv[1:] or ['generate', 'master', 'check']
    for s in steps:
        {'generate': generate, 'master': master, 'check': check}[s]()
