"""Voice warnings: one voice per real voice-warning system (wave 7), rendered with ElevenLabs (cached) and processed
through a cockpit chain matched to real recordings.

  A320 FWC        ElevenLabs Voice Design "FWC DesignB" (British RP male, no clone) → A320 loudspeaker EQ (A319 videos)
  EGPWS           "Adam" (Honeywell voice; A320: A320 loudspeaker EQ, 737: P-8A loudspeaker EQ)
  F-16 VMS        "Sarah" (female, headset);  F-22 ICAWS "Matilda" (female, headset)
Voice choice: tools/audio/voicematch.py; references: tools/audio/real_clips.py; decisions: research/alerts.md.
Real voice-warning systems replay one recorded word, so repeated warnings ("sink rate … sink rate") are one rendering
played twice with a fixed gap (Honeywell standard pause 0.75 s). Each file ends at -19 dBFS active speech level.
Usage: .venv/bin/python tools/audio/gen_voices.py [--only fwc,egpws,vms,icaws,uh60] [--provider say]
The alert tones are in gen_alerts.py; the old tone functions below are kept for gen_apdisc.py (audition candidates).
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




# ================================================================================================ wave 7: per system
# One voice per real voice-warning system (tools/audio/research/alerts.md):
#   A320neo  FWC  (Airbus flight warning computer: radio-altitude callouts, RETARD, HUNDRED ABOVE, MINIMUM, STALL,
#                  SPEED SPEED SPEED)                           → designed British RP male voice ('FWC DesignB')
#            EGPWS (Honeywell: SINK RATE, PULL UP, TERRAIN…, TOO LOW…, DON'T SINK, GLIDE SLOPE; no Mode 6 on Airbus)
#                                                                → Honeywell voice ('Adam'), A320 loudspeaker EQ
#   737-800  EGPWS (Honeywell MK V: all voices incl. Mode 6 callouts, MINIMUMS, BANK ANGLE) → 'Adam', 737 EQ
#   F-16C    VMS  (female, headset)                              → 'Sarah'
#   F-22A    ICAWS voice (female, headset, different unit)        → see F22_* below
#   UH-60M   see UH60_* below
# The voice choice is evidence based (tools/audio/voicematch.py → research/voicematch.json: F0 and speaking rate of
# the real recordings, documented accents). The loudspeaker colouration is matched to the long-term spectrum of the
# real cockpit recordings (research/voice_refs.json): A319 FWC voice (Air France / Adria videos) and P-8A EGPWS voice.
VOICE_ID = {
    'fwc': ('WrWxGio5YUgz9Ahdti5R', 'FWC DesignB'),     # ElevenLabs Voice Design (text description, not a clone)
    'egpws': ('pNInz6obpgDQGcFmaJgB', 'Adam'),
    'vms': ('EXAVITQu4vr4xnSDxMaL', 'Sarah'),
    'icaws': ('XrExE9yKIg1WjnnlVkGX', 'Matilda'),
    'uh60': ('hpp4J3VqNfWAUOO0d1Us', 'Bella'),
}
EGPWS_PAUSE = 0.75           # Honeywell standard pause between paired phrases ([SPEC] 6.4.4 via FlightGear mk_viii)


def _refs():
    import json
    import os
    p = os.path.join(os.path.dirname(__file__), 'research', 'voice_refs.json')
    return json.load(open(p)) if os.path.exists(p) else None


def third_oct_ltas(x):
    bands = 125 * 2 ** (np.arange(0, 6.01, 1 / 3))
    f, P = signal.welch(x, SR, nperseg=2048)
    e = np.array([P[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].mean() for c in bands])
    L = 10 * np.log10(e + 1e-20)
    return bands, L - L.max()


def match_eq(x, target, strength=0.85, limit=15.0):
    """Linear-phase EQ that moves the long-term third-octave spectrum of `x` toward `target` (dB re max)."""
    bands, L = third_oct_ltas(x)
    d = np.clip((np.asarray(target) - L) * strength, -limit, limit)
    d = np.convolve(np.pad(d, 1, mode='edge'), [0.25, 0.5, 0.25], 'valid')      # smooth across bands
    fr = np.concatenate([[0], bands, [SR / 2]])
    gains = undb(np.concatenate([[d[0]], d, [d[-1] - 12]]))
    taps = signal.firwin2(2047, fr / (SR / 2), gains)
    return signal.fftconvolve(x, taps, 'same')


def speaker_chain(x, rng, target=None, drive=1.6, pitch=1.0):
    """Cockpit loudspeaker: matched EQ to the real recording, 250-4000 Hz band-limit, syllable compression, light
    saturation, small flight-deck room, -19 dBFS active speech level."""
    x = x - np.mean(x)
    x = butter(x, 'highpass', 90, 2)
    x = pitch_nudge(x, pitch)
    x = x / (np.max(np.abs(x)) + 1e-12)
    x = level_compress(x, ratio=3.0, range_db=12)
    y = match_eq(x, target) if target is not None else bq(x, 'peak', 2300, 1.3, 3.5)
    y = butter(y, 'highpass', 250, 4)
    y = butter(y, 'lowpass', 4000, 4)
    y = y / (np.max(np.abs(y)) + 1e-12)
    y = np.tanh(drive * y) / np.tanh(drive)
    y = butter(y, 'lowpass', 4500, 2)
    y = np.concatenate([np.zeros(N(0.012)), y, np.zeros(N(0.08))])
    y = small_room(y, rng, tail_db=-20, rt60=0.18)
    y = y * undb(-19.0 - speech_level_db(y))
    return fade(limit_peaks(y, -1.0, knee=0.6), 0.004, 0.04)


def headset_chain(x, rng, drive=1.6, hiss_db=-40, pitch=1.0):
    return cockpit_audio(x, rng, 'headset', pitch=pitch, drive=drive, hiss_db=hiss_db)


def words(system, text, rate=195, takes=3):
    """One recorded word/phrase of a system voice (cached ElevenLabs rendering, trimmed)."""
    EL_VOICES['_' + system] = VOICE_ID[system]
    return voice(text, '_' + system, rate, takes=takes)


def seq(*parts):
    """Concatenate renderings and silences (float = seconds of silence)."""
    return np.concatenate([silence(p) if isinstance(p, (int, float)) else p for p in parts])


# ---- Airbus FWC (A320neo) -------------------------------------------------------------------------------------
FWC_WORDS = {
    'v_2500': 'Two thousand five hundred', 'v_1000': 'One thousand', 'v_500': 'Five hundred', 'v_400': 'Four hundred',
    'v_300': 'Three hundred', 'v_200': 'Two hundred', 'v_100': 'One hundred', 'v_50': 'Fifty', 'v_40': 'Forty',
    'v_30': 'Thirty', 'v_20': 'Twenty', 'v_10': 'Ten', 'v_5': 'Five', 'v_hundredabove': 'Hundred above',
    'v_minimum': 'Minimum', 'v_retard': 'Retard',
}
# intermediate callouts (FCOM: present height repeated every 4 s when the next callout is > 11 s away; below 410 ft)
FWC_INTERMEDIATE = [h for h in range(60, 400, 10) if h % 100]
NUM_WORDS = {1: 'one', 2: 'two', 3: 'three', 6: 'sixty', 7: 'seventy', 8: 'eighty', 9: 'ninety'}


def say_height(h):
    tens = {1: 'ten', 2: 'twenty', 3: 'thirty', 4: 'forty', 5: 'fifty', 6: 'sixty', 7: 'seventy', 8: 'eighty', 9: 'ninety'}
    hund, rest = divmod(h, 100)
    if not hund:
        return tens[rest // 10].capitalize()
    return f'{NUM_WORDS[hund].capitalize()} hundred and {tens[rest // 10]}'


def gen_fwc(rng, target):
    print('[voices] A320 FWC')
    W = {}
    for k, t in FWC_WORDS.items():
        W[k] = words('fwc', t, 200 if k not in ('v_retard', 'v_hundredabove', 'v_minimum') else 190)
    out = dict(W)
    out['v_20_retard'] = seq(W['v_20'], 0.06, W['v_retard'])       # FWC sheet: "TWENTY… RETARD" as one call
    out['v_10_retard'] = seq(W['v_10'], 0.06, W['v_retard'])       # autoland
    sp = words('fwc', 'Speed', 200)
    out['v_speed'] = seq(sp, max(0.05, 0.56 - len(sp) / SR), sp, max(0.05, 0.56 - len(sp) / SR), sp)
    st = words('fwc', 'Stall', 190)
    for k, y in out.items():
        write_wav(f'a320neo/{k}.wav', speaker_chain(y, rng, target))
    # stall: crickets + "STALL" (FCOM: permanent; the rule loops this file)
    from gen_alerts import cricket, speaker as tone_speaker
    cr = tone_speaker(cricket(1.0)[:N(0.48)])
    cr = cr * undb(-19.0 - speech_level_db(cr)) * undb(-3)
    stv = speaker_chain(st, rng, target)
    write_wav('a320neo/v_stall.wav', limit_peaks(np.concatenate([cr, silence(0.06), stv]), -1.0, 0.6))
    for h in FWC_INTERMEDIATE:
        write_wav(f'a320neo/v_i{h}.wav', speaker_chain(words('fwc', say_height(h), 205), rng, target))


# ---- Honeywell EGPWS (A320neo: modes 1-5; 737: modes 1-6) --------------------------------------------------------
EGPWS_WORDS = {
    'sinkrate': 'Sink rate', 'pullup': 'Pull up', 'terrain': 'Terrain', 'toolow_terrain': 'Too low, terrain',
    'toolow_gear': 'Too low, gear', 'toolow_flaps': 'Too low, flaps', 'dontsink': "Don't sink", 'glideslope': 'Glide slope',
    'terrainahead': 'Terrain ahead', 'bankangle': 'Bank angle',
}
EGPWS_737_CALLOUTS = {'v_2500': 'Twenty five hundred', 'v_1000': 'One thousand', 'v_500': 'Five hundred',
                      'v_100': 'One hundred', 'v_50': 'Fifty', 'v_40': 'Forty', 'v_30': 'Thirty', 'v_20': 'Twenty',
                      'v_10': 'Ten', 'v_apprmin': 'Approaching minimums', 'v_minimums': 'Minimums'}


def gen_egpws(rng, aid, target, boeing):
    print(f'[voices] EGPWS {aid}')
    W = {k: words('egpws', t, 185) for k, t in EGPWS_WORDS.items()}
    P = EGPWS_PAUSE
    out = {
        'v_sinkrate': seq(W['sinkrate'], P, W['sinkrate']),
        'v_pullup': W['pullup'],
        'v_terrain2': seq(W['terrain'], P, W['terrain']),
        'v_terrain': W['terrain'],
        'v_toolow_terrain': W['toolow_terrain'], 'v_toolow_gear': W['toolow_gear'], 'v_toolow_flaps': W['toolow_flaps'],
        'v_dontsink': seq(W['dontsink'], P, W['dontsink']),
        'v_glideslope': W['glideslope'], 'v_glideslope2': seq(W['glideslope'], 0.25, W['glideslope']),
    }
    if boeing:
        out['v_terrain_pullup'] = seq(W['terrain'], P, W['terrain'], P, W['pullup'])     # look-ahead warning
        out['v_bankangle'] = seq(W['bankangle'], P, W['bankangle'])
        for k, t in EGPWS_737_CALLOUTS.items():
            out[k] = words('egpws', t, 200 if len(t) < 14 else 190)
    else:
        out['v_terrainahead_pullup'] = seq(W['terrainahead'], 0.2, W['pullup'])           # Airbus TAD option
    for k, y in out.items():
        write_wav(f'{aid}/{k}.wav', speaker_chain(y, rng, target, drive=1.5))


# ---- F-16 VMS (female voice, headset) -------------------------------------------------------------------------
def gen_vms(rng):
    print('[voices] F-16 VMS')
    w = {k: words('vms', t, 175) for k, t in {'warning': 'Warning', 'caution': 'Caution', 'altitude': 'Altitude',
                                              'bingo': 'Bingo', 'pullup': 'Pull up'}.items()}
    g = 0.12                            # the VMS replays one stored word: identical intonation, short gap
    out = {
        'v_warning': seq(w['warning'], g, w['warning'], 0.45, w['warning'], g, w['warning']),   # WARNING-WARNING pause WARNING-WARNING
        'v_caution': seq(w['caution'], g, w['caution']),
        'v_altitude': seq(w['altitude'], g, w['altitude']),
        'v_bingo': seq(w['bingo'], g, w['bingo']),
        'v_pullup': seq(w['pullup'], g, w['pullup'], g, w['pullup'], g, w['pullup']),
    }
    for k, y in out.items():
        write_wav(f'f16/{k}.wav', headset_chain(y, rng, drive=1.8, hiss_db=-38))


# ---- F-22A ICAWS (no public word list: cautions are an aural tone (DoD IG 2013, 2010 AIB); warnings reach the
#      headset and the jet has voice synthesis (AGARD AR-349, Avionics Handbook) — the words below are assumptions,
#      kept few; a different female voice than the F-16 VMS) ------------------------------------------------------
def gen_icaws(rng):
    print('[voices] F-22 ICAWS')
    w = {k: words('icaws', t, 180) for k, t in {'pullup': 'Pull up', 'gear': 'Landing gear', 'engfail_l': 'Left engine fail',
                                               'engfail_r': 'Right engine fail'}.items()}
    out = {'v_pullup': seq(w['pullup'], 0.15, w['pullup']), 'v_gear': w['gear'], 'v_engfail_l': w['engfail_l'],
           'v_engfail_r': w['engfail_r']}
    from gen_alerts import f22_warning, headset as tone_headset
    tone = tone_headset(f22_warning())
    for k, y in out.items():
        y = headset_chain(y, rng, drive=1.3, hiss_db=None, pitch=1.0)
        if k != 'v_pullup':                      # warnings: ICAW warning tone, then the voice
            tt = tone * undb(-19.0 - speech_level_db(tone)) * undb(-2)
            y = limit_peaks(np.concatenate([tt, silence(0.15), y]), -1.0, 0.6)
        write_wav(f'f22/{k}.wav', y)


# ---- UH-60M voice warning system -------------------------------------------------------------------------------
# The UH-60M operator's manual (TM 1-1520-280-10) is not public. The closest documented Army H-60 voice warning
# system is the MH-60K VWS (TM 1-1520-250-10, 1994, para 2-227 / table 2-6): priority 1 = 2 s intermittent 250 Hz tone,
# priority 2 = 2 s continuous 250 Hz tone, then "message, 1 s, message"; priorities 3-10 = "message, 0.5 s, message,
# 1 s, message"; 1 s gap before the cycle repeats (the gap is timed by src/audio/alertlogic.js uh60Vws). The UH-60A/L
# manual calls the NR / Ng tone "a low steady tone" — the continuous 250 Hz tone that precedes LOW ROTOR / ENGINE OUT.
UH60_VWS = {                     # file → (words, priority class)
    'v_eng1out': ('Engine one out', 2), 'v_eng2out': ('Engine two out', 2), 'v_lowrotor': ('Low rotor', 2),
    'v_altlow': ('Altitude low', 4),
}


def gen_uh60(rng):
    print('[voices] UH-60M VWS (MH-60K format)')
    from gen_alerts import headset as tone_headset, steady_tone
    tone = steady_tone(250.0, 2.0)
    n = np.arange(len(tone))
    tone = tone * np.minimum(1, np.minimum(n / N(0.008), (len(tone) - n) / N(0.015)))
    tone = tone_headset(tone)
    for k, (t, prio) in UH60_VWS.items():
        x = words('uh60', t, 178)
        msg = seq(x, 1.0, x) if prio <= 2 else seq(x, 0.5, x, 1.0, x)
        y = headset_chain(msg, rng, drive=2.0, hiss_db=-34)
        if prio <= 2:
            tt = tone * undb(-19.0 - speech_level_db(tone)) * undb(-3)      # tone ≈ 3 dB under the voice
            y = limit_peaks(np.concatenate([tt, silence(0.5), y]), -1.0, 0.6)
        write_wav(f'uh60/{k}.wav', y)


def main_voices(systems=None):
    rng = np.random.default_rng(99)
    R = _refs() or {'systems': {}}
    fwc_t = R['systems'].get('airbus_fwc', {}).get('ltas')
    egp_t = R['systems'].get('honeywell_egpws', {}).get('ltas')
    todo = systems or ['fwc', 'egpws', 'vms', 'icaws', 'uh60']
    if 'fwc' in todo:
        gen_fwc(rng, fwc_t)
    if 'egpws' in todo:
        gen_egpws(rng, 'a320neo', fwc_t, boeing=False)        # plays through the A320 loudspeakers
        gen_egpws(rng, 'b737', egp_t, boeing=True)
    if 'vms' in todo:
        gen_vms(rng)
    if 'icaws' in todo and 'gen_icaws' in globals():
        globals()['gen_icaws'](rng)
    if 'uh60' in todo and 'gen_uh60' in globals():
        globals()['gen_uh60'](rng)


def main():
    main_voices()


if __name__ == '__main__':
    import sys
    if '--provider' in sys.argv:
        PROVIDER = sys.argv[sys.argv.index('--provider') + 1]
    only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
    main_voices(only)
    if PROVIDER == 'elevenlabs':
        import elevenlabs as el
        print(f'ElevenLabs characters used this run (uncached): {el.chars_used()}')
