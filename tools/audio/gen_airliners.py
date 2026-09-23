"""A320neo (CFM LEAP-1A) and 737-800 (CFM56-7B) engine loops.

Layers per aircraft (assets/audio/<id>/):
  fan_lo / fan_mid / fan_hi   fan BPF tones (haystacked by inlet turbulence), sidebands, low engine orders, LPT tones
                              (aft), HP-compressor whine, fan broadband; N1 refs 0.25 / 0.58 / 0.92 (rate = n1/ref)
  buzzsaw                     multiple pure tones of the supersonic fan tips at N1 0.95 (forward arc, takeoff)
  jet_lo / jet_hi             core + jet mixing noise at idle / takeoff power
  reverse                     reverse-thrust roar (efflux through the cascades: turbulent, rattly)
  apu                         APU (tail): centrifugal compressor whine + exhaust
"""
import sys

import numpy as np

from dsp import N, bump, hp, lp, undb, write_wav, spectral_noise
from synth import Family, am_env, band_am, broadband, buzzsaw, comp_tone, crackle, fan_tones, jet_noise, rumble, loop_len

FAN_REFS = {'lo': 0.25, 'mid': 0.58, 'hi': 0.92}

ENGINES = {
    'b737': dict(  # CFM56-7B26
        fan_max=89.7, fan_blades=24, hp_max=253.0, n2_idle=0.58, hpc_blades=(38, 53), lpt_blades=(150, 162),
        buzz=dict(irregular=0.55, lp_hz=2200, level=0), side_db=-15, orders_db=-24, seed=737,
        jet_lo=dict(fpeak=520, rise=12, fall=14, rough=0.2), jet_hi=dict(fpeak=260, rise=10, fall=16.5, rough=0.3),
        core_hump=420, apu=dict(shaft=817.0, whine=(6480, 9870), exhaust=1300),
    ),
    'a320neo': dict(  # LEAP-1A: 18 wide-chord composite blades, slower fan, quieter, smoother
        fan_max=64.3, fan_blades=18, hp_max=277.0, n2_idle=0.6, hpc_blades=(32, 44), lpt_blades=(128, 140),
        buzz=dict(irregular=0.4, lp_hz=1700, level=0), side_db=-19, orders_db=-28, seed=320,
        jet_lo=dict(fpeak=460, rise=12, fall=15, rough=0.16), jet_hi=dict(fpeak=210, rise=10, fall=17.5, rough=0.24),
        core_hump=360, apu=dict(shaft=733.0, whine=(5860, 8810), exhaust=1150),
    ),
}


def fan(eng, n1, L=4.0, seed=0):
    n = N(L)
    rng = np.random.default_rng(seed)
    f = Family(n, rng, eng['fan_max'] * n1, wander=0.002, fc=0.5)
    n2 = eng['n2_idle'] + (1 - eng['n2_idle']) * n1
    h = Family(n, rng, eng['hp_max'] * n2, wander=0.0012, fc=0.8)
    hi = np.clip((n1 - 0.5) / 0.45, 0, 1)
    y = fan_tones(n, rng, f, eng['fan_blades'],
                  harmonics=[(1, 0), (2, -5 - 3 * hi), (3, -12 - 2 * hi)],
                  sidebands=[(1, eng['side_db']), (2, eng['side_db'] - 5)],
                  orders=[(k, eng['orders_db'] - 1.5 * k + rng.uniform(-4, 4)) for k in range(1, 9)],
                  hay=0.45, hay_bw=0.015, am_depth=0.22)
    # LPT tones (aft arc, prominent on approach)
    for i, b in enumerate(eng['lpt_blades']):
        y += comp_tone(n, rng, f.order_phase(b), -13 - 5 * i - 4 * hi, hay=0.5, hay_f=f.f * b, hay_bw=0.008)
    # HP compressor whine
    for i, b in enumerate(eng['hpc_blades']):
        y += comp_tone(n, rng, h.order_phase(b), -10 - 6 * i - 6 * hi, hay=0.3, hay_f=h.f * b, hay_bw=0.006)
    # fan broadband (rotor-stator interaction) + inlet 'whoosh'
    bpf = f.f * eng['fan_blades']
    y += broadband(n, rng, lambda fr: bump(fr, bpf * 1.6, 1.4) * hp(fr, 120, 2), level_db=-7 + 3 * hi,
                   am_depth=0.14, am_fc=1.2)
    y += broadband(n, rng, lambda fr: bump(fr, 700, 1.5) * hp(fr, 60, 2), level_db=-18 + 4 * hi, am_depth=0.2,
                   am_fc=2.5)
    return y


def buzz(eng, n1=0.95, L=4.0, seed=0):
    n = N(L)
    rng = np.random.default_rng(seed)
    f = Family(n, rng, eng['fan_max'] * n1, wander=0.0015, fc=0.5)
    b = eng['buzz']
    y = buzzsaw(n, rng, f, eng['fan_blades'], level_db=0, irregular=b['irregular'], lp_hz=b['lp_hz'],
                kmax_hz=7000, evolve=0.45)
    # the buzz is heard through inlet turbulence: slight broadband haze
    y += broadband(n, rng, lambda fr: bump(fr, 1500, 1.2), level_db=-16)
    return y


def jet(p, eng, L=6.0, seed=0, core_db=-6):
    n = loop_len(L)
    rng = np.random.default_rng(seed)
    y = jet_noise(n, rng, p['fpeak'], p['rise'], p['fall'], rough=p['rough'], rough_band=(3, 30))
    # combustor / core noise hump (low-mid, quite smooth)
    y += broadband(n, rng, lambda f: bump(f, eng['core_hump'], 1.0) * hp(f, 40, 2), level_db=core_db,
                   am_depth=0.25, am_fc=4)
    y += undb(-9) * rumble(n, rng, 55, 0.8, 0.35, 3)
    return y


def reverse(eng, L=6.0, seed=0):
    n = loop_len(L)
    rng = np.random.default_rng(seed)
    y = jet_noise(n, rng, 380, 10, 13, rough=0.5, rough_band=(2, 22), split_hz=250,
                  texture=((0.07, 0.6, 6.0), (0.6, 1.2, 3.5)))
    y *= band_am(n, rng, 0.3, 1.5, 7)
    y += undb(-5) * rumble(n, rng, 70, 0.9, 0.5, 5)
    y += undb(-20) * crackle(n, rng, 60, alpha=2.4, hp_hz=1200)
    return y


def apu(eng, L=5.0, seed=0):
    n = N(L)
    rng = np.random.default_rng(seed)
    p = eng['apu']
    s = Family(n, rng, p['shaft'], wander=0.0008, fc=0.4)
    y = np.zeros(n)
    for k, d in ((1, -24), (2, -28), (3, -30)):
        y += comp_tone(n, rng, s.order_phase(k), d, hay=0.0)
    for i, w in enumerate(p['whine']):
        k = round(w / s.f)
        y += comp_tone(n, rng, s.order_phase(k), -4 - 8 * i, hay=0.4, hay_f=s.f * k, hay_bw=0.004)
    y += broadband(n, rng, lambda f: bump(f, p['exhaust'], 1.3) * hp(f, 80, 2), level_db=-3, am_depth=0.12)
    y += broadband(n, rng, lambda f: bump(f, 140, 0.8), level_db=-14, am_depth=0.3, am_fc=3)
    return y


def gen(aid):
    eng = ENGINES[aid]
    s = eng['seed']
    print(f'[{aid}]')
    for name, ref in FAN_REFS.items():
        write_wav(f'{aid}/fan_{name}.wav', fan(eng, ref, 4.0, s * 10 + len(name)), target_lufs=-20, loop=True)
    write_wav(f'{aid}/buzzsaw.wav', buzz(eng, 0.95, 4.0, s * 10 + 4), target_lufs=-20, loop=True)
    write_wav(f'{aid}/jet_lo.wav', jet(eng['jet_lo'], eng, 6.0, s * 10 + 5, core_db=-3), target_lufs=-20, loop=True)
    write_wav(f'{aid}/jet_hi.wav', jet(eng['jet_hi'], eng, 6.0, s * 10 + 6, core_db=-9), target_lufs=-20, loop=True)
    write_wav(f'{aid}/reverse.wav', reverse(eng, 6.0, s * 10 + 7), target_lufs=-20, loop=True)
    write_wav(f'{aid}/apu.wav', apu(eng, 5.0, s * 10 + 8), target_lufs=-20, loop=True)


if __name__ == '__main__':
    for a in (sys.argv[1:] or ENGINES.keys()):
        gen(a)
