"""F-16C (F110-GE-129) and F-22A (F119-PW-100) engine + cockpit loops.

Layers per aircraft (assets/audio/<id>/):
  whine_lo / whine_mid / whine_hi  tonal spool whine (fan BPF + harmonics, shaft-order sidebands, HP compressor
                                   whistle, accessory-gearbox inharmonic partials, fan broadband) at N1 refs 0.30/0.62/0.95
  roar_lo / roar_hi                jet mixing noise at idle / military power (turbulence roughness, light crackle)
  ab                               afterburner roar (deep, crackle, low-frequency pops, pulsing)
  ab_lightoff, ab_out              one-shots
  rumble                           combustion / structure-borne low end (mostly cockpit)
  ecs                              cockpit ECS air hiss
  breath                           oxygen-mask breathing (optional layer)
Runtime pitch: rate = (0.15 + 0.85*n1) / (0.15 + 0.85*ref) for the whine layers.
"""
import sys

import numpy as np

from dsp import (N, SR, bump, circ_filter, hp, lp, peak_db, spectral_noise, tvec, undb, write_wav, slow_noise,
                 place_events, poisson_times, fade, soft_clip, exp_decay)
from synth import (Family, am_env, band_am, broadband, buzzsaw, comp_tone, crackle, fan_tones, jet_noise, lf_pops,
                   rumble, thump, noise_burst, loop_len)

TAU = 2 * np.pi
WHINE_REFS = {'lo': 0.30, 'mid': 0.62, 'hi': 0.95}

ENGINES = {
    'f16': dict(  # F110-GE-129
        fan_max=125.0, fan_blades=32, hp_max=240.0, n2_idle=0.62, hpc_blades=(38, 53), acc_orders=(5.37, 11.9),
        bb_centre=1.5, hpc_db=(-5, -13), buzz_db=-11, orders_db=-30, side_db=-17, seed=16,
        roar_lo=dict(fpeak=420, rise=12, fall=12, rough=0.22), roar_hi=dict(fpeak=210, rise=10, fall=13, rough=0.32),
        ab=dict(fpeak=180, rise=9, fall=12, crackle_rate=320, crackle_db=-9, pops_rate=7, pops_db=-14, lf=48),
        rumble_f0=52,
    ),
    'f22': dict(  # F119-PW-100: larger mass flow, slower fan, deeper and heavier
        fan_max=108.0, fan_blades=28, hp_max=228.0, n2_idle=0.60, hpc_blades=(36, 47), acc_orders=(4.83, 10.4),
        bb_centre=1.35, hpc_db=(-7, -15), buzz_db=-8, orders_db=-26, side_db=-15, seed=22,
        roar_lo=dict(fpeak=330, rise=12, fall=12.5, rough=0.25), roar_hi=dict(fpeak=165, rise=10, fall=13.5, rough=0.36),
        ab=dict(fpeak=160, rise=9, fall=12, crackle_rate=280, crackle_db=-8, pops_rate=9, pops_db=-14, lf=42),
        rumble_f0=43,
    ),
}


def whine(eng, n1, L=4.0, seed=0):
    n = N(L)
    rng = np.random.default_rng(seed)
    fan = Family(n, rng, eng['fan_max'] * n1, wander=0.0025, fc=0.6)
    n2 = eng['n2_idle'] + (1 - eng['n2_idle']) * n1
    hpf = Family(n, rng, eng['hp_max'] * n2, wander=0.0015, fc=0.9)
    hi_power = np.clip((n1 - 0.55) / 0.4, 0, 1)
    y = fan_tones(n, rng, fan, eng['fan_blades'],
                  harmonics=[(1, 0), (2, -7 + 2 * hi_power), (3, -16)],
                  sidebands=[(1, eng['side_db']), (2, eng['side_db'] - 6), (3, eng['side_db'] - 11)],
                  orders=[(k, eng['orders_db'] - 2 * k + rng.uniform(-3, 3)) for k in range(1, 7)],
                  hay=0.35 + 0.2 * hi_power)
    # HP compressor whistle (stage 1 + 2) - prominent at idle, masked at high power
    hp_db = eng['hpc_db'][0] + (eng['hpc_db'][1] - eng['hpc_db'][0]) * n1
    for i, b in enumerate(eng['hpc_blades']):
        k = b
        y += comp_tone(n, rng, hpf.order_phase(k), hp_db - 7 * i, hay=0.25, hay_f=hpf.f * k, hay_bw=0.006)
    # accessory gearbox / pump partials (inharmonic w.r.t. both spools)
    for k in eng['acc_orders']:
        y += comp_tone(n, rng, hpf.order_phase(k), -27, hay=0.0, am_depth=0.1)
    # fan broadband hump around ~1.5x BPF, rising with power
    bpf = fan.f * eng['fan_blades']
    y += broadband(n, rng, lambda f: bump(f, bpf * eng['bb_centre'], 1.3) * hp(f, 150, 2), level_db=-9 + 5 * n1,
                   am_depth=0.15, am_fc=1.5)
    # fighter fans also buzz from the inlet at high power (supersonic tips)
    if n1 > 0.8:
        y += buzzsaw(n, rng, fan, eng['fan_blades'], level_db=eng['buzz_db'], lp_hz=4000, kmax_hz=8000)
    return y


def roar(p, L=6.0, seed=0, crackle_db=None):
    n = loop_len(L)
    rng = np.random.default_rng(seed)
    y, env = jet_noise(n, rng, p['fpeak'], p['rise'], p['fall'], rough=p['rough'], return_env=True)
    if crackle_db is not None:
        y += undb(crackle_db) * crackle(n, rng, 90, alpha=2.3, hp_hz=900, gate=env ** 2)
    return y


def afterburner(p, L=6.0, seed=0):
    n = loop_len(L)
    rng = np.random.default_rng(seed)
    # irregular pulsing of the whole plume (combustion instability, 2-9 Hz)
    pulse = band_am(n, rng, 0.28, 2, 9)
    y, env = jet_noise(n, rng, p['fpeak'], p['rise'], p['fall'], rough=0.42, rough_band=(3, 30), split_hz=350,
                       texture=((0.06, 0.6, 6.0), (0.5, 1.2, 3.0)), return_env=True)
    y *= pulse
    y += undb(-13) * rumble(n, rng, p['lf'], 0.7, am_depth=0.45, am_fc=6) * pulse
    gate = (np.clip(pulse, 0, None) * env) ** 2
    y += undb(p['crackle_db']) * crackle(n, rng, p['crackle_rate'], alpha=1.9, hp_hz=600, gate=gate)
    y += undb(p['pops_db']) * lf_pops(n, rng, p['pops_rate'], 30, 75)
    return y


def ab_lightoff(p, seed=0):
    """Light-off: sub thump + whoomp (noise swelling into the AB roar), a couple of zone pops."""
    rng = np.random.default_rng(seed)
    dur = 2.2
    n = N(dur)
    t = tvec(n)
    y = np.zeros(n)
    th = thump(0.6, f0=p['lf'] * 0.7, decay=0.13, rng=rng, click=0.25)
    y[N(0.03):N(0.03) + len(th)] += 1.0 * th
    wh = noise_burst(1.6, rng, lambda f: lp(f, 900, 2) * hp(f, 25, 2) * bump(f, 110, 1.6), attack=0.05, decay=0.45)
    y[N(0.02):N(0.02) + len(wh)] += 0.55 * wh / np.max(np.abs(wh))
    # zone light-offs (stage pops)
    for k, (t0, a) in enumerate([(0.18, 0.5), (0.34, 0.4), (0.52, 0.32)]):
        pk = thump(0.35, f0=p['lf'] * (0.9 + 0.1 * k), decay=0.07, rng=rng, click=0.35)
        i0 = N(t0)
        y[i0:i0 + len(pk)] += a * pk
    # crackle burst
    cr = crackle(n, rng, 500, alpha=1.9, hp_hz=700) * exp_decay(n, 0.35, 0.05) * (t > 0.05)
    y += 0.12 * cr
    y = fade(y, 0.001, 0.4)
    return y


def ab_out(p, seed=0):
    rng = np.random.default_rng(seed)
    y = 0.6 * thump(0.5, f0=p['lf'] * 0.9, decay=0.09, rng=rng, click=0.1)
    wh = noise_burst(0.5, rng, lambda f: lp(f, 600, 2) * hp(f, 30, 2), attack=0.004, decay=0.12)
    y[:len(wh)] += 0.3 * wh / np.max(np.abs(wh))
    return fade(y, 0.001, 0.1)


def ecs(L=5.0, seed=0, tone_hz=3150):
    """Cockpit ECS: conditioned air rushing through the ducts/vents (hiss) + faint cooling-turbine tone."""
    n = N(L)
    rng = np.random.default_rng(seed)
    y = broadband(n, rng, lambda f: (bump(f, 4200, 1.4) + 0.5 * bump(f, 900, 1.2)) * hp(f, 120, 2), 0, 0.06, 0.5)
    fam = Family(n, rng, tone_hz, 0.001)
    y += comp_tone(n, rng, fam.base, -22, hay=0.5, hay_f=fam.f, hay_bw=0.004)
    y += comp_tone(n, rng, fam.base * 2, -32, hay=0.0)
    y += undb(-14) * rumble(n, rng, 180, 0.9, 0.2, 1.0)
    return y


def breath(L=8.0, seed=0):
    """Pressure-demand oxygen mask: inhale = regulator hiss with valve click, exhale = softer, darker hiss."""
    n = N(L)
    rng = np.random.default_rng(seed)
    y = np.zeros(n)
    t0 = 0.0
    cycle = L / 2  # two breaths per loop
    for c in range(2):
        start = c * cycle + rng.uniform(-0.05, 0.05)
        # inhale 1.3 s
        ni = N(1.3)
        ti = np.arange(ni) / SR
        env = np.sin(np.pi * np.clip(ti / 1.3, 0, 1)) ** 0.7
        inh = spectral_noise(ni, lambda f: bump(f, 2600, 1.1) * hp(f, 300, 2), rng) * env
        # valve click at inhale start
        clk = np.zeros(ni)
        k = N(0.004)
        clk[:k] = rng.standard_normal(k) * np.exp(-np.arange(k) / (0.0008 * SR))
        clk = circ_filter(clk, lambda f: bump(f, 3500, 0.8))
        seg = 0.9 * inh + 0.5 * clk / (np.max(np.abs(clk)) + 1e-9)
        y += place_events(n, [N(start)], seg)
        # exhale 1.5 s, starts after a 0.35 s pause
        ne = N(1.5)
        te = np.arange(ne) / SR
        enve = np.sin(np.pi * np.clip(te / 1.5, 0, 1)) ** 1.2
        exh = spectral_noise(ne, lambda f: bump(f, 1100, 1.2) * hp(f, 150, 2), rng) * enve
        y += place_events(n, [N(start + 1.65)], 0.45 * exh)
    return y


def gen(aid):
    eng = ENGINES[aid]
    s = eng['seed']
    print(f'[{aid}]')
    for name, ref in WHINE_REFS.items():
        write_wav(f'{aid}/whine_{name}.wav', whine(eng, ref, 4.0, s * 10 + len(name)), target_lufs=-20, loop=True)
    write_wav(f'{aid}/roar_lo.wav', roar(eng['roar_lo'], 6.0, s * 10 + 3), target_lufs=-20, loop=True)
    write_wav(f'{aid}/roar_hi.wav', roar(eng['roar_hi'], 6.0, s * 10 + 4, crackle_db=-12), target_lufs=-20,
              loop=True)
    write_wav(f'{aid}/ab.wav', afterburner(eng['ab'], 6.0, s * 10 + 5), target_lufs=-20, loop=True)
    write_wav(f'{aid}/ab_lightoff.wav', ab_lightoff(eng['ab'], s * 10 + 6), target_lufs=-16)
    write_wav(f'{aid}/ab_out.wav', ab_out(eng['ab'], s * 10 + 7), target_lufs=-22)
    n = N(5.0)
    rng = np.random.default_rng(s * 10 + 8)
    write_wav(f'{aid}/rumble.wav', rumble(n, rng, eng['rumble_f0'], 0.75, 0.3, 4.0), target_lufs=-24, loop=True)
    write_wav(f'{aid}/ecs.wav', ecs(5.0, s * 10 + 9, 3150 if aid == 'f16' else 2780), target_lufs=-20, loop=True)
    write_wav(f'{aid}/breath.wav', breath(8.0, s * 10 + 11), target_lufs=-24, loop=True)


if __name__ == '__main__':
    for a in (sys.argv[1:] or ENGINES.keys()):
        gen(a)
