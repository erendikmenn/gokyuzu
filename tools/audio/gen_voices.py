"""Voice warnings (macOS `say` + cockpit-audio processing) and synthetic cockpit alert tones.

Only the standard macOS voices are installed on the build machine (no Premium/Enhanced/Siri voices), so the least
robotic *concatenative* voices are used (recorded human speech units) instead of the formant synthesisers:
  F-16 / F-22 / UH-60  'Bitching Betty'   Samantha (en_US female)  → headset/intercom chain
  A320neo / 737-800    GPWS / FWC callouts Daniel (male)            → cockpit loudspeaker chain (+ small flight deck)
Real voice-warning systems replay one recorded word, so repeated warnings ("pull up, pull up") are one rendering
played twice with a fixed gap instead of two synthesised words with different intonation.
Processing: trim → (pitch nudge) → syllable-levelling compressor → 300–3400 Hz band-limit + transducer EQ → light
tanh saturation → small-room early reflections + short diffuse tail (speaker) → active-speech-level normalisation
(-19 dBFS K-weighted active level) with a soft peak limit at -1 dBFS, so every callout has the same loudness.
"""
import warnings

import numpy as np
from scipy import signal

from dsp import (N, SR, bump, butter, circ_filter, fade, hp, lp, modal, say, soft_clip, spectral_noise, tvec, undb,
                 write_wav, bq, limit_peaks, _K1, _K2)

warnings.filterwarnings('ignore')
TAU = 2 * np.pi

# ---- voice providers ------------------------------------------------------------------------------------------
# Default: ElevenLabs (licensed for public use). Fallback: macOS `say` (personal use only) with --provider say.
PROVIDER = 'elevenlabs'
EL_MODEL = 'eleven_multilingual_v2'
EL_VOICES = {                      # role → (ElevenLabs premade voice id, name) — see `elevenlabs.py voices`
    'betty': ('EXAVITQu4vr4xnSDxMaL', 'Sarah'),    # calm, mature, reassuring US female (F-16 / F-22 VMS)
    'helo': ('EXAVITQu4vr4xnSDxMaL', 'Sarah'),     # same warning voice for the UH-60M
    'boeing': ('pqHfZKP75CvOlQylNhV4', 'Bill'),    # crisp, mature US male (Honeywell EGPWS style)
    'airbus': ('cjVigY5qzO86Huf0OWal', 'Eric'),    # smooth, neutral US male (Airbus FWC callouts)
}
SAY_VOICES = {'betty': 'Samantha', 'helo': 'Samantha', 'boeing': 'Daniel', 'airbus': 'Daniel'}
BETTY, GPWS, HELO = 'betty', 'boeing', 'helo'     # roles (kept for compatibility)


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


def speech_level_db(x, frame=0.05):
    """Active speech level: K-weighted RMS over the frames within 20 dB of the loudest frame (dBFS)."""
    y = signal.lfilter(*_K2, signal.lfilter(*_K1, x))
    n = N(frame)
    m = len(y) // n
    if m < 1:
        return 20 * np.log10(np.sqrt(np.mean(y * y)) + 1e-12)
    e = np.mean(y[:m * n].reshape(m, n) ** 2, axis=1)
    ldb = 10 * np.log10(e + 1e-12)
    act = e[ldb > ldb.max() - 20]
    return 10 * np.log10(np.mean(act) + 1e-12)


def pitch_nudge(x, factor):
    """Small pitch change by resampling (±8 % keeps the timbre natural); factor < 1 lowers the voice."""
    if abs(factor - 1) < 1e-3:
        return x
    from math import gcd
    up, down = int(round(1000 / factor)), 1000
    g = gcd(up, down)
    return signal.resample_poly(x, up // g, down // g)


def level_compress(x, ratio=3.0, att=0.004, rel=0.06, range_db=14):
    """RMS-follower compressor that evens out syllable levels (threshold = active level - range_db/2)."""
    env = np.sqrt(signal.lfilter([1 - np.exp(-1 / (0.008 * SR))], [1, -np.exp(-1 / (0.008 * SR))], x * x) + 1e-12)
    a1, r1 = np.exp(-1 / (att * SR)), np.exp(-1 / (rel * SR))
    e = np.zeros_like(env)
    st = 0.0
    for i, v in enumerate(env):
        st = a1 * st + (1 - a1) * v if v > st else r1 * st + (1 - r1) * v
        e[i] = st
    ldb = 20 * np.log10(e + 1e-9)
    thr = ldb.max() - range_db
    g = undb(-np.maximum(ldb - thr, 0) * (1 - 1 / ratio))
    return x * g


def small_room(y, rng, early=((0.0013, 0.32), (0.0021, -0.24), (0.0034, 0.2), (0.0047, 0.15), (0.0062, -0.12),
                              (0.0089, 0.09), (0.0118, 0.06)), tail_db=-17, rt60=0.2):
    """Flight-deck acoustics: discrete early reflections (panels, windscreen) + a short, dark diffuse tail."""
    out = y.copy()
    for d, a in early:
        k = N(d)
        refl = np.concatenate([np.zeros(k), y[:-k]])
        out += a * butter(refl, 'lowpass', 4500, 1)
    nt = N(rt60 * 1.2)
    t = tvec(nt)
    ir = rng.standard_normal(nt) * np.exp(-6.91 * t / rt60) * (t > 0.012)
    ir = butter(ir, 'lowpass', 2500, 2)
    ir /= np.sqrt(np.sum(ir * ir)) + 1e-12
    tail = signal.fftconvolve(y, ir)[:len(y)]
    out += undb(tail_db) * tail * (np.sqrt(np.mean(y * y)) / (np.sqrt(np.mean(tail * tail)) + 1e-12))
    return out


def cockpit_audio(x, rng, kind='speaker', pitch=1.0, drive=1.8, hiss_db=None):
    """kind: 'speaker' (flight-deck loudspeaker + room) or 'headset' (helmet / intercom earphones)."""
    x = x - np.mean(x)
    x = butter(x, 'highpass', 90, 2)
    x = pitch_nudge(x, pitch)
    x = x / (np.max(np.abs(x)) + 1e-12)
    x = level_compress(x, ratio=3.0, range_db=12)
    # 300-3400 Hz band-limit (4th order) + transducer colouration
    y = butter(x, 'highpass', 300, 4)
    y = butter(y, 'lowpass', 3400, 4)
    if kind == 'speaker':
        y = bq(y, 'peak', 2300, 1.3, 3.5)      # small cone resonance
        y = bq(y, 'peak', 750, 1.0, -2.0)      # enclosure dip
        y = bq(y, 'peak', 420, 1.4, 2.0)       # body
    else:
        y = bq(y, 'peak', 1700, 1.1, 3.0)      # earphone presence
        y = bq(y, 'peak', 3000, 2.0, 1.5)
    # light saturation (amplifier / transducer), then tame the added harmonics
    y = y / (np.max(np.abs(y)) + 1e-12)
    y = np.tanh(drive * y) / np.tanh(drive)
    y = butter(y, 'lowpass', 4200, 2)
    pad_a, pad_b = N(0.012), N(0.08)
    y = np.concatenate([np.zeros(pad_a), y, np.zeros(pad_b)])
    if kind == 'speaker':
        y = small_room(y, rng)
    if hiss_db is not None:   # intercom 'open mic' hiss, gated with the speech
        g = np.convolve((np.abs(y) > 0.02 * np.max(np.abs(y))).astype(float), np.ones(N(0.08)) / N(0.08), 'same')
        h = butter(rng.standard_normal(len(y)), 'bandpass', [400, 3200], 2)
        y = y + undb(hiss_db) * np.max(np.abs(y)) * h / np.max(np.abs(h)) * np.clip(g * 2, 0, 1)
    # consistent loudness: same active speech level for every file, soft peak limit
    y = y * undb(-19.0 - speech_level_db(y))
    y = limit_peaks(y, -1.0, knee=0.6)
    return fade(y, 0.004, 0.04)


def _f0_spread(x):
    fr = N(0.03); hop = fr // 2; f = []
    for i in range(0, len(x) - fr, hop):
        seg = x[i:i + fr] * np.hanning(fr)
        if np.sqrt(np.mean(seg * seg)) < 0.03 * np.max(np.abs(x)):
            continue
        ac = np.correlate(seg, seg, 'full')[fr - 1:]
        lo, hi = int(SR / 350), int(SR / 70)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.4 * ac[0]:
            f.append(np.log2(SR / k))
    return float(np.std(f)) if len(f) > 3 else 1.0


def voice(text, role, rate=None, takes=3):
    """Render text for a voice role. rate: words per minute (say) → mapped to an ElevenLabs speed factor."""
    from dsp import trim_silence
    if PROVIDER == 'say':
        return say(text, SAY_VOICES.get(role, role), rate=rate)
    import elevenlabs as el
    vid = EL_VOICES[role][0]
    speed = float(np.clip((rate or 175) / 175.0, 0.8, 1.18))
    # several takes (different seeds); keep the steadiest delivery (flattest pitch, no dragging), like picking
    # the best recording in a studio session
    best, best_score = None, 1e9
    for seed in range(1, takes + 1):
        x = el.tts(text, vid, EL_MODEL, stability=0.85, similarity=0.8, style=0.0, speed=speed, seed=seed)
        x = trim_silence(x, thresh_db=-42, pad=0.015)
        score = _f0_spread(x) * 4 + len(x) / SR
        if score < best_score:
            best, best_score = x, score
    return best


def silence(s):
    return np.zeros(N(s))


def twice(x, gap):
    """A recorded warning replayed twice (identical intonation, fixed gap) like a real voice-warning unit."""
    return np.concatenate([x, silence(gap), x])


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


# phrase table: key → (text, rate wpm, repeat twice?, gap s)
BETTY_PHRASES = {
    'v_warning': ('Warning', 170, True, 0.28), 'v_caution': ('Caution', 170, True, 0.28),
    'v_pullup': ('Pull up', 175, True, 0.22), 'v_altitude': ('Altitude', 172, True, 0.25),
    'v_bingo': ('Bingo', 168, True, 0.3), 'v_overg': ('Over G', 172, True, 0.25),
    'v_lowspeed': ('Low speed', 172, True, 0.25), 'v_gear': ('Landing gear', 170, False, 0),
}


def render(text, v, rate, rep=False, gap=0.25):
    x = voice(text, v, rate)
    return twice(x, gap) if rep else x


def gen_betty(aid, rng, voice_name=BETTY, drive=1.6, pitch=1.0, hiss_db=-40):
    for k, (txt, rate, rep, gap) in BETTY_PHRASES.items():
        x = render(txt, voice_name, rate, rep, gap)
        write_wav(f'{aid}/{k}.wav', cockpit_audio(x, rng, 'headset', pitch=pitch, drive=drive, hiss_db=hiss_db))


def gen_gpws(aid, v, rng, airbus):
    # GPWS / FWC phrases: warnings emphatic and even, radio-altitude numbers quick and flat (no trailing period)
    P = {'v_sinkrate': ('Sink rate', 182, False, 0), 'v_pullup': ('Pull up', 180, False, 0),
         'v_terrain': ('Terrain', 180, True, 0.2), 'v_toolow_gear': ('Too low, gear', 185, False, 0),
         'v_toolow_flaps': ('Too low, flaps', 185, False, 0), 'v_toolow_terrain': ('Too low, terrain', 185, False, 0),
         'v_bankangle': ('Bank angle', 182, True, 0.22), 'v_dontsink': ("Don't sink", 182, False, 0),
         'v_glideslope': ('Glide slope', 182, False, 0), 'v_windshear': ('Windshear', 180, True, 0.22),
         'v_1000': ('One thousand', 190, False, 0), 'v_500': ('Five hundred', 190, False, 0),
         'v_100': ('One hundred', 195, False, 0), 'v_50': ('Fifty', 205, False, 0), 'v_40': ('Forty', 205, False, 0),
         'v_30': ('Thirty', 205, False, 0), 'v_20': ('Twenty', 205, False, 0), 'v_10': ('Ten', 205, False, 0)}
    if airbus:
        P.update({'v_2500': ('Two thousand five hundred', 195, False, 0), 'v_400': ('Four hundred', 195, False, 0),
                  'v_300': ('Three hundred', 195, False, 0), 'v_200': ('Two hundred', 195, False, 0),
                  'v_5': ('Five', 205, False, 0), 'v_hundredabove': ('Hundred above', 180, False, 0),
                  'v_minimums': ('Minimum', 175, False, 0), 'v_retard': ('Retard', 185, True, 0.3),
                  'v_stall': ('Stall', 180, True, 0.2)})
    else:
        P.update({'v_2500': ('Twenty five hundred', 195, False, 0),
                  'v_hundredabove': ('Approaching minimums', 182, False, 0), 'v_minimums': ('Minimums', 178, False, 0)})
    # the Airbus FWC voice is a little deeper and more compressed than the Honeywell EGPWS voice
    pitch, drive = ((0.95 if PROVIDER == 'say' else 1.0), 2.0) if airbus else (1.0, 1.6)
    for k, (txt, rate, rep, gap) in P.items():
        x = render(txt, v, rate, rep, gap)
        if k == 'v_stall' and airbus:
            cr = cricket(0.62)[:N(0.6)]
            y = cockpit_audio(x, rng, 'speaker', pitch=pitch, drive=drive)
            c = cockpit_audio(cr, rng, 'speaker', pitch=1.0, drive=1.2) * undb(-4)
            out = np.concatenate([c, silence(0.05), y])
            write_wav(f'{aid}/{k}.wav', limit_peaks(out, -1.0, 0.6))
            continue
        if k == 'v_pullup' and not airbus:
            w = whoop()
            y = cockpit_audio(x, rng, 'speaker', pitch=pitch, drive=drive)
            ww = cockpit_audio(np.concatenate([w, silence(0.08), w]), rng, 'speaker', pitch=1.0, drive=1.3) * undb(-2)
            write_wav(f'{aid}/{k}.wav', limit_peaks(np.concatenate([ww, silence(0.04), y]), -1.0, 0.6))
            continue
        write_wav(f'{aid}/{k}.wav', cockpit_audio(x, rng, 'speaker', pitch=pitch, drive=drive))


def gen_helo(rng):
    for k, (txt, rate, rep, gap) in {'v_lowrotor': ('Low rotor R.P.M.' if PROVIDER != 'say' else 'Low rotor R P M', 175, False, 0),
                                     'v_altitude': ('Altitude', 172, True, 0.25), 'v_pullup': ('Pull up', 175, True, 0.22),
                                     'v_bankangle': ('Bank angle', 175, False, 0)}.items():
        x = render(txt, HELO, rate, rep, gap)
        write_wav(f'uh60/{k}.wav', cockpit_audio(x, rng, 'headset', pitch=0.97 if PROVIDER == 'say' else 1.0, drive=2.2,
                                                 hiss_db=-34))


def main_voices():
    rng = np.random.default_rng(99)
    print('[voices]')
    gen_betty('f16', rng, BETTY, drive=1.8, pitch=1.0, hiss_db=-38)
    gen_betty('f22', rng, BETTY, drive=1.3, pitch=1.02, hiss_db=None)    # F-22: cleaner digital audio
    gen_gpws('a320neo', 'airbus', rng, True)
    gen_gpws('b737', 'boeing', rng, False)
    gen_helo(rng)


def main(voices_only=False):
    main_voices()
    if voices_only:
        return
    rng = np.random.default_rng(99)
    print('[alerts]')   # A/P-disconnect sounds come from real recordings: gen_fgsounds.py
    write_wav('a320neo/single_chime.wav', chime(), target_lufs=-18)
    write_wav('a320neo/crc.wav', crc(), target_lufs=-18, loop=True)
    write_wav('a320neo/cricket.wav', cricket(), target_lufs=-18, loop=True)
    write_wav('a320neo/c_chord.wav', c_chord(), target_lufs=-20)
    write_wav('b737/shaker.wav', stick_shaker(rng), target_lufs=-17, loop=True)
    write_wav('b737/clacker.wav', clacker(rng), target_lufs=-18, loop=True)
    write_wav('b737/chime.wav', ding_dong(), target_lufs=-19)
    write_wav('b737/c_chord.wav', c_chord(), target_lufs=-20)


if __name__ == '__main__':
    import sys
    if '--provider' in sys.argv:
        PROVIDER = sys.argv[sys.argv.index('--provider') + 1]
    main(voices_only='--voices-only' in sys.argv)
    if PROVIDER == 'elevenlabs':
        import elevenlabs as el
        print(f'ElevenLabs characters used this run (uncached): {el.chars_used()}')
