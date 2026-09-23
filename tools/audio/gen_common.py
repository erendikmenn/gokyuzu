"""Shared airframe / mechanical / event sounds (assets/audio/common/).

Loops:  wind_ext, wind_canopy, wind_deck, buffet, gear_drag, gear_motor, flap_airbus, flap_boeing, flap_fighter,
        canopy_motor, roll, brake_squeal, avionics
Shots:  gear_unlock, gear_lock_down, gear_lock_up, flap_lever, speedbrake, spoiler_deploy, reverser_unlock,
        canopy_lock, canopy_unlock, canopy_seal, click, click_soft, touchdown_light, touchdown_heavy, nose_touch,
        bump, crash, sonic_boom
"""
import numpy as np

from dsp import (N, SR, process_periodic, bump, circ_filter, exp_decay, fade, hp, lp, modal, place_events, poisson_times,
                 resonator, slow_noise, soft_clip, spectral_noise, tvec, undb, write_wav, bq)
from synth import (Family, am_env, band_am, broadband, comp_tone, crackle, lf_pops, metal_clunk, noise_burst,
                   rumble, thump, textured_noise, loop_len)

TAU = 2 * np.pi
R = lambda s: np.random.default_rng(s)  # noqa: E731


def norm(x):
    return x / (np.max(np.abs(x)) + 1e-12)


def put(y, x, t, a=1.0):
    i = N(t)
    m = min(len(x), len(y) - i)
    if m > 0:
        y[i:i + m] += a * x[:m]
    return y


# --------------------------------------------------------------------------------------------------------- loops
def wind_ext(L=8.0, seed=1):
    """Airframe / passing-air noise: textured broadband (gusts reshape the spectrum) with a little flutter."""
    n = loop_len(L); rng = R(seed)
    y = textured_noise(n, lambda f: (bump(f, 260, 1.6) + 0.35 * bump(f, 2500, 1.3)) * hp(f, 25, 2), rng,
                       fields=((0.25, 1.0, 4.0), (1.5, 2.0, 3.0)))
    y *= am_env(n, rng, 0.2, 0.5) * band_am(n, rng, 0.1, 4, 18)
    return y


def wind_canopy(L=6.0, seed=2):
    """Bubble canopy boundary-layer noise: bright hiss + low rumble, with a little buffeting."""
    n = loop_len(L); rng = R(seed)
    y = textured_noise(n, lambda f: (bump(f, 1600, 1.4) + 0.6 * bump(f, 180, 1.0)) * hp(f, 30, 2), rng,
                       fields=((0.12, 0.8, 3.0), (1.0, 1.5, 2.0)))
    y *= am_env(n, rng, 0.1, 0.7) * band_am(n, rng, 0.1, 6, 30)
    return y


def wind_deck(L=6.0, seed=3):
    """Airliner flight deck airflow (windshield/nose boundary layer): dark broadband roar."""
    n = loop_len(L); rng = R(seed)
    y = textured_noise(n, lambda f: (bump(f, 480, 1.5) + 0.22 * bump(f, 4200, 1.2)) * hp(f, 35, 2), rng,
                       fields=((0.3, 1.0, 2.5), (1.5, 2.0, 2.0)))
    return y


def buffet(L=5.0, seed=4):
    """Low-frequency airframe buffet: rumble + random structural knocks with rattles."""
    n = N(L); rng = R(seed)
    y = rumble(n, rng, 38, 0.9, 0.5, 5)
    knocks = np.zeros(n)
    times = poisson_times(n, 9, rng, 0.04)
    for t0 in times:
        k = thump(0.25, f0=rng.uniform(22, 45), decay=0.05)
        knocks += place_events(n, [t0], k, [rng.uniform(0.3, 1.0)])
    rat = process_periodic(knocks * 0.02, lambda z: modal(z, [(160, 0.05, 1), (290, 0.04, 0.8), (430, 0.03, 0.6)]))
    return y + 1.2 * norm(knocks) * np.std(y) * 4 + norm(rat) * np.std(y) * 1.5


def gear_drag(L=5.0, seed=5):
    """Turbulent airflow around extended gear legs and open bays: rumbly, rattly roar."""
    n = N(L); rng = R(seed)
    y = broadband(n, rng, lambda f: bump(f, 220, 1.3) * hp(f, 30, 2), 0, 0.0)
    y *= band_am(n, rng, 0.35, 3, 20)
    y += 0.6 * rumble(n, rng, 60, 0.8, 0.5, 6)
    return y


def hydraulic_motor(n, rng, pump_hz, pistons=9, tone_db=-6, hiss_db=-8, whine_hz=None):
    s = Family(n, rng, pump_hz, wander=0.004, fc=1.5)
    y = np.zeros(n)
    for k, d in ((1, -18), (2, -22), (pistons, tone_db), (2 * pistons, tone_db - 6), (3 * pistons, tone_db - 12)):
        y += comp_tone(n, rng, s.order_phase(k), d, hay=0.2, hay_f=s.f * k, hay_bw=0.01, am_depth=0.2)
    if whine_hz:
        w = Family(n, rng, whine_hz, wander=0.003)
        y += comp_tone(n, rng, w.base, tone_db + 2, hay=0.3, hay_f=w.f, hay_bw=0.006)
        y += comp_tone(n, rng, w.base * 2, tone_db - 8, hay=0.0)
    y += broadband(n, rng, lambda f: bump(f, 3500, 1.1), hiss_db, 0.15, 3)
    y += broadband(n, rng, lambda f: bump(f, 250, 1.0), hiss_db - 4, 0.3, 4)
    return y


def gear_motor(L=4.0, seed=6):
    n = N(L); rng = R(seed)
    return hydraulic_motor(n, rng, 62.5, 9, -6, -9)


def flap_airbus(L=4.0, seed=7):
    """A320 flap/slat PCU: hydraulic motors through the torque shaft - a clean rising 'wheee' whine."""
    n = N(L); rng = R(seed)
    return hydraulic_motor(n, rng, 118.0, 7, -8, -14, whine_hz=1180)


def flap_boeing(L=4.0, seed=8):
    """737 trailing-edge flap drive: lower, buzzier hydraulic motor groan with gearbox whine."""
    n = N(L); rng = R(seed)
    y = hydraulic_motor(n, rng, 46.0, 9, -5, -12, whine_hz=640)
    y *= band_am(n, rng, 0.12, 8, 30)
    return y


def flap_fighter(L=3.0, seed=9):
    """Fighter servo actuator: high hydraulic hiss/whine (3000/4000 psi)."""
    n = N(L); rng = R(seed)
    y = hydraulic_motor(n, rng, 105.0, 9, -10, -4, whine_hz=2150)
    return y


def canopy_motor(L=3.0, seed=10):
    """Electric canopy actuator: DC motor (commutator hum + brush noise) driving a screw jack (gear whine)."""
    n = N(L); rng = R(seed)
    m = Family(n, rng, 95.0, 0.005, 2)
    y = np.zeros(n)
    for k, d in ((1, -10), (2, -8), (3, -14), (6, -12), (12, -18)):
        y += comp_tone(n, rng, m.order_phase(k), d, hay=0.1, hay_f=m.f * k, hay_bw=0.02, am_depth=0.15)
    g = Family(n, rng, 1420.0, 0.004, 2)
    y += comp_tone(n, rng, g.base, -9, hay=0.3, hay_f=g.f, hay_bw=0.01)
    y += broadband(n, rng, lambda f: bump(f, 5000, 1.0), -12, 0.3, 20)
    return y


def roll(L=4.0, seed=11):
    """Tyres rolling on grooved concrete: LF rumble + tread hum + fine grit."""
    n = N(L); rng = R(seed)
    y = rumble(n, rng, 55, 1.0, 0.35, 8)
    y += broadband(n, rng, lambda f: bump(f, 420, 0.6), -6, 0.25, 6)
    y += broadband(n, rng, lambda f: bump(f, 2500, 1.0), -18, 0.3, 10)
    return y


def brake_squeal(L=3.0, seed=12):
    n = N(L); rng = R(seed)
    s = Family(n, rng, 2340.0, 0.006, 3)
    y = np.zeros(n)
    for k, d in ((1, 0), (2, -10), (3, -18)):
        y += comp_tone(n, rng, s.order_phase(k), d, hay=0.2, hay_f=s.f * k, hay_bw=0.004, am_depth=0.6, am_fc=4)
    y *= band_am(n, rng, 0.5, 5, 25)
    y += broadband(n, rng, lambda f: bump(f, 900, 1.2), -12, 0.4, 10)
    return y


def avionics(L=5.0, seed=13):
    """Flight deck equipment: avionics cooling fans + 400 Hz electrical hum."""
    n = N(L); rng = R(seed)
    y = broadband(n, rng, lambda f: bump(f, 1400, 1.3) * hp(f, 100, 2), 0, 0.05, 0.4)
    fan = Family(n, rng, 61.0, 0.001, 0.3)
    for k, d in ((7, -12), (14, -18), (1, -26)):
        y += comp_tone(n, rng, fan.order_phase(k), d, hay=0.4, hay_f=fan.f * k, hay_bw=0.01)
    hum = Family(n, rng, 400.0, 0.0002, 0.2)
    for k, d in ((1, -20), (2, -26), (3, -24), (5, -30)):
        y += comp_tone(n, rng, hum.order_phase(k), d, hay=0.0, am_depth=0.02)
    return y


# --------------------------------------------------------------------------------------------------------- shots
def gear_unlock(seed=20):
    rng = R(seed)
    y = np.zeros(N(1.2))
    put(y, metal_clunk(rng, 0.4, [(310, 0.05, 1), (720, 0.03, 0.8), (1650, 0.02, 0.6), (2900, 0.01, 0.4)],
                       strike_ms=1.5), 0.0, 0.6)
    put(y, metal_clunk(rng, 0.6, [(95, 0.12, 1), (170, 0.09, 0.8), (340, 0.06, 0.5), (610, 0.04, 0.3)],
                       strike_ms=4), 0.12, 1.0)
    put(y, noise_burst(1.0, rng, lambda f: bump(f, 300, 1.2), attack=0.15, decay=0.4), 0.15, 0.25)
    return fade(y, 0.001, 0.2)


def gear_lock_down(seed=21):
    rng = R(seed)
    y = np.zeros(N(1.3))
    put(y, metal_clunk(rng, 0.9, [(70, 0.16, 1), (128, 0.12, 0.9), (240, 0.08, 0.7), (455, 0.05, 0.5),
                                  (880, 0.03, 0.35), (1900, 0.015, 0.25)], strike_ms=5), 0.0, 1.0)
    put(y, thump(0.4, 34, 0.08, rng, 0.0), 0.0, 0.8)
    put(y, metal_clunk(rng, 0.4, [(260, 0.05, 1), (640, 0.03, 0.7), (1400, 0.02, 0.4)], strike_ms=2), 0.09, 0.35)
    put(y, metal_clunk(rng, 0.5, [(110, 0.1, 1), (210, 0.07, 0.6)], strike_ms=6), 0.35, 0.3)  # door
    return fade(y, 0.001, 0.25)


def gear_lock_up(seed=22):
    rng = R(seed)
    y = np.zeros(N(1.0))
    put(y, metal_clunk(rng, 0.6, [(90, 0.1, 1), (170, 0.08, 0.8), (330, 0.06, 0.6), (700, 0.03, 0.4)],
                       strike_ms=4), 0.0, 1.0)
    put(y, metal_clunk(rng, 0.4, [(340, 0.04, 1), (820, 0.02, 0.6), (2100, 0.01, 0.4)], strike_ms=1.5), 0.02, 0.4)
    put(y, metal_clunk(rng, 0.5, [(120, 0.09, 1), (230, 0.06, 0.6)], strike_ms=6), 0.28, 0.45)  # doors close
    return fade(y, 0.001, 0.2)


def flap_lever(seed=23):
    rng = R(seed)
    y = np.zeros(N(0.5))
    put(y, metal_clunk(rng, 0.2, [(1800, 0.01, 1), (3300, 0.008, 0.7), (5200, 0.005, 0.5)], strike_ms=0.6), 0, 0.5)
    put(y, metal_clunk(rng, 0.35, [(240, 0.04, 1), (520, 0.03, 0.7), (1100, 0.02, 0.5)], strike_ms=2), 0.07, 1.0)
    return fade(y, 0.0005, 0.1)


def hyd_actuation(seed, dur=1.2, hiss=3200, clunk_t=0.8):
    rng = R(seed)
    y = np.zeros(N(dur))
    put(y, noise_burst(dur, rng, lambda f: bump(f, hiss, 1.0), attack=0.03, decay=0.3), 0.0, 0.5)
    put(y, metal_clunk(rng, 0.4, [(180, 0.06, 1), (400, 0.04, 0.6), (900, 0.02, 0.4)], strike_ms=3), clunk_t, 0.8)
    return fade(y, 0.002, 0.1)


def spoiler_deploy(seed=24):
    rng = R(seed)
    y = np.zeros(N(1.6))
    put(y, thump(0.5, 30, 0.1, rng, 0.2), 0.0, 1.0)
    put(y, noise_burst(1.5, rng, lambda f: bump(f, 200, 1.4), attack=0.08, decay=0.5), 0.02, 0.6)
    put(y, metal_clunk(rng, 0.4, [(150, 0.07, 1), (330, 0.05, 0.6)], strike_ms=4), 0.05, 0.5)
    return fade(y, 0.001, 0.3)


def reverser_unlock(seed=25):
    rng = R(seed)
    y = np.zeros(N(1.4))
    put(y, metal_clunk(rng, 0.5, [(120, 0.1, 1), (260, 0.07, 0.8), (540, 0.04, 0.5), (1200, 0.02, 0.3)],
                       strike_ms=3), 0.0, 1.0)
    put(y, noise_burst(1.3, rng, lambda f: bump(f, 400, 1.4), attack=0.2, decay=0.4), 0.05, 0.5)
    put(y, metal_clunk(rng, 0.5, [(100, 0.1, 1), (220, 0.07, 0.6)], strike_ms=5), 0.55, 0.6)
    return fade(y, 0.001, 0.2)


def canopy_lock(seed=26):
    rng = R(seed)
    y = np.zeros(N(0.8))
    put(y, metal_clunk(rng, 0.5, [(140, 0.07, 1), (310, 0.05, 0.8), (690, 0.03, 0.6), (1500, 0.015, 0.4)],
                       strike_ms=3), 0.0, 1.0)
    put(y, metal_clunk(rng, 0.2, [(2400, 0.01, 1), (4100, 0.006, 0.6)], strike_ms=0.5), 0.18, 0.35)
    return fade(y, 0.001, 0.15)


def canopy_unlock(seed=27):
    rng = R(seed)
    y = np.zeros(N(1.2))
    put(y, metal_clunk(rng, 0.2, [(2200, 0.01, 1), (3900, 0.006, 0.6)], strike_ms=0.5), 0.0, 0.5)
    put(y, noise_burst(1.0, rng, lambda f: bump(f, 3000, 1.3), attack=0.005, decay=0.25), 0.05, 0.6)
    put(y, metal_clunk(rng, 0.4, [(160, 0.05, 1), (380, 0.03, 0.6)], strike_ms=3), 0.1, 0.6)
    return fade(y, 0.001, 0.2)


def canopy_seal(seed=28):
    rng = R(seed)
    y = noise_burst(1.8, rng, lambda f: bump(f, 2600, 1.2) * hp(f, 400, 2), attack=0.12, decay=0.5, hold=0.4)
    return fade(y, 0.002, 0.3)


def click(seed=29, soft=False):
    rng = R(seed)
    modes = [(2600, 0.006, 1), (4300, 0.004, 0.8), (6900, 0.003, 0.6)] if not soft else \
        [(1300, 0.008, 1), (2400, 0.005, 0.7), (4100, 0.003, 0.4)]
    y = np.zeros(N(0.12))
    put(y, metal_clunk(rng, 0.1, modes, strike_ms=0.3, noise_amt=0.8), 0.0, 1.0)
    put(y, metal_clunk(rng, 0.06, [(m[0] * 0.8, m[1], m[2]) for m in modes], strike_ms=0.3), 0.018, 0.4)
    return fade(y, 0.0002, 0.03)


def tyre_chirp(rng, dur, f0=750, drop=0.25, rough=0.5):
    """Rubber spinning up on concrete: stick-slip squeal (sawtooth-like friction oscillation with jittery pitch)
    plus abrasion hiss. A short, bright 'chirp/screech'."""
    n = N(dur)
    t = tvec(n)
    jit = circ_filter(rng.standard_normal(n), lambda fr: lp(fr, 60, 2))
    jit /= np.std(jit) + 1e-9
    f = f0 * (1 - drop * t / dur) * (1 + 0.04 * jit)
    ph = np.cumsum(f) / SR
    saw = 2 * (ph % 1.0) - 1
    saw = circ_filter(saw, lambda fr: lp(fr, 6000, 2) * hp(fr, 250, 2))
    am = 1 + rough * circ_filter(rng.standard_normal(n), lambda fr: lp(fr, 120, 2)) * 3
    hiss = spectral_noise(n, lambda fr: bump(fr, 2600, 0.8), rng)
    env = np.minimum(1, t / 0.004) * np.exp(-t / (dur * 0.35))
    y = 0.8 * saw / (np.std(saw) + 1e-9) * np.clip(am, 0, None) + 0.45 * hiss
    return y * env


def touchdown(seed, heavy=False):
    rng = R(seed)
    dur = 1.6 if heavy else 1.0
    y = np.zeros(N(dur))
    ch = tyre_chirp(rng, 0.45 if heavy else 0.24, 640 if heavy else 760, 0.3, 0.7 if heavy else 0.45)
    put(y, norm(ch), 0.0, 1.0)
    ch2 = tyre_chirp(rng, 0.32 if heavy else 0.18, 820, 0.3, 0.5)
    put(y, norm(ch2), 0.045, 0.7)  # other main gear
    put(y, norm(thump(0.6, 30 if heavy else 40, 0.12 if heavy else 0.07, rng, 0.2)), 0.01, 0.9 if heavy else 0.5)
    put(y, norm(metal_clunk(rng, 0.6, [(85, 0.12, 1), (160, 0.08, 0.7), (320, 0.05, 0.4)], strike_ms=6)), 0.02,
        0.6 if heavy else 0.3)
    put(y, noise_burst(dur - 0.05, rng, lambda f: bump(f, 250, 1.3), attack=0.03, decay=0.25), 0.02, 0.25)
    return fade(y, 0.0005, 0.2)


def nose_touch(seed=32):
    rng = R(seed)
    y = np.zeros(N(0.7))
    put(y, norm(thump(0.5, 45, 0.06, rng, 0.15)), 0.0, 1.0)
    put(y, norm(tyre_chirp(rng, 0.08, 900, 0.3, 0.4)), 0.0, 0.2)
    put(y, norm(metal_clunk(rng, 0.4, [(130, 0.07, 1), (270, 0.04, 0.6)], strike_ms=4)), 0.01, 0.35)
    return fade(y, 0.0005, 0.15)


def runway_bump(seed=33):
    rng = R(seed)
    y = np.zeros(N(0.35))
    put(y, norm(thump(0.3, 48, 0.035, rng, 0.25)), 0.0, 1.0)
    put(y, norm(metal_clunk(rng, 0.25, [(180, 0.03, 1), (420, 0.02, 0.5)], strike_ms=2)), 0.0, 0.3)
    return fade(y, 0.0005, 0.05)


def crash(seed=34):
    """Impact + fireball: crack, sub-bass boom, metal crunch/debris, rolling fire roar tail."""
    rng = R(seed)
    dur = 6.0
    n = N(dur)
    t = tvec(n)
    y = np.zeros(n)
    # impact crack (broadband, very short)
    put(y, noise_burst(0.25, rng, lambda f: hp(f, 150, 2) * lp(f, 9000, 1), attack=0.0005, decay=0.03), 0.0, 1.0)
    # sub boom
    put(y, norm(thump(2.0, 24, 0.5, rng, 0.0)), 0.0, 1.2)
    put(y, norm(thump(1.2, 55, 0.2, rng, 0.0)), 0.015, 0.6)
    # blast roar (lowpassed noise swelling then long decay)
    roar = noise_burst(dur, rng, lambda f: bump(f, 90, 1.6) * hp(f, 18, 2), attack=0.04, decay=1.2)
    y += 0.9 * norm(roar)
    # metal crunch / debris impacts
    for k in range(26):
        t0 = rng.uniform(0.02, 2.2) ** 1.4
        c = metal_clunk(rng, 0.5, [(rng.uniform(150, 400), 0.06, 1), (rng.uniform(600, 1400), 0.03, 0.7),
                                   (rng.uniform(1800, 4200), 0.015, 0.5)], strike_ms=rng.uniform(1, 4))
        put(y, norm(c), t0, rng.uniform(0.1, 0.45) * np.exp(-t0 / 1.5))
    # fire crackle tail
    cr = crackle(n, rng, 120, 2.0, 500, 7000) * np.exp(-t / 2.2) * np.minimum(1, t / 0.3)
    y += 0.08 * cr
    y = soft_clip(y / np.max(np.abs(y)) * 1.6, 1.2)
    return fade(y, 0.0003, 1.0)


def sonic_boom(seed=35):
    """N-wave (double crack ~0.12 s apart, 1-2 ms rise times) + ground reflection + rolling rumble."""
    rng = R(seed)
    dur = 3.5
    n = N(dur)
    T = 0.12
    nw = np.zeros(N(T) + N(0.01))
    k = N(T)
    nw[:k] = np.linspace(1, -1, k)
    rise = N(0.0015)
    b = np.hanning(2 * rise)[:rise]
    b = b / b.sum()
    nw = np.convolve(nw, np.ones(rise) / rise, mode='same')
    y = np.zeros(n)
    put(y, nw, 0.02, 1.0)
    put(y, nw, 0.02 + 0.009, 0.55)  # ground reflection
    # rolling rumble: filtered noise with slow decay + echoes off terrain / buildings
    rum = noise_burst(dur, rng, lambda f: bump(f, 60, 1.4) * hp(f, 15, 2), attack=0.05, decay=0.7)
    y += 0.25 * norm(rum)
    for d, a in ((0.35, 0.25), (0.62, 0.18), (1.1, 0.12), (1.6, 0.07)):
        put(y, circ_filter(nw, lambda f: lp(f, 900, 2)), 0.02 + d, a)
    y = circ_filter(y, lambda f: hp(f, 8, 2))
    return fade(y, 0.0002, 0.6)


def main():
    print('[common]')
    loops = {'wind_ext': wind_ext(), 'wind_canopy': wind_canopy(), 'wind_deck': wind_deck(), 'buffet': buffet(),
             'gear_drag': gear_drag(), 'gear_motor': gear_motor(), 'flap_airbus': flap_airbus(),
             'flap_boeing': flap_boeing(), 'flap_fighter': flap_fighter(), 'canopy_motor': canopy_motor(),
             'roll': roll(), 'brake_squeal': brake_squeal(), 'avionics': avionics()}
    for k, v in loops.items():
        write_wav(f'common/{k}.wav', v, target_lufs=-20, loop=True)
    shots = {'gear_unlock': gear_unlock(), 'gear_lock_down': gear_lock_down(), 'gear_lock_up': gear_lock_up(),
             'flap_lever': flap_lever(), 'speedbrake': hyd_actuation(40, 1.2, 3000, 0.75),
             'spoiler_deploy': spoiler_deploy(), 'reverser_unlock': reverser_unlock(),
             'canopy_lock': canopy_lock(), 'canopy_unlock': canopy_unlock(), 'canopy_seal': canopy_seal(),
             'click': click(29), 'click_soft': click(30, True), 'touchdown_light': touchdown(31),
             'touchdown_heavy': touchdown(36, True), 'nose_touch': nose_touch(), 'bump': runway_bump(),
             'crash': crash(), 'sonic_boom': sonic_boom()}
    for k, v in shots.items():
        write_wav(f'common/{k}.wav', v, target_lufs=-18)


if __name__ == '__main__':
    main()
