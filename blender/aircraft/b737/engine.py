"""CFM56-7B engine + nacelle ("hamster pouch" flattened lower lip), translating reverser sleeve, fan, pylon."""
import math
import numpy as np

import shape as S
import mk
from mk import MeshData

TB = S.to_b
NPSI = 72


def _eng_frame(side):
    """Engine origin (ground frame) at the inlet highlight on the axis."""
    return np.array([S.ENG_X0, side * S.ENGINE_Y, S.ENG_Z])


def revolve_profile(profile, side, vcoords, n=None, closed=False, mat_of_part=None, u_mirror=False):
    """Revolve (s, r, flatten, part) around the engine axis with the lower-lip flattening.
    Returns MeshData (blender coords). UV: u = angle (0..1), v = vcoords along the profile."""
    o = _eng_frame(side)
    n = n or S.qn(NPSI, 24)
    psi = np.linspace(0, 2 * np.pi, n, endpoint=False)          # 0 = top, increasing towards +Y (right)
    ring_pts = []
    for (s_, r, a, part) in profile:
        k = S.nac_flatten(psi, a)
        Y = o[1] + r * k * np.sin(psi)
        Z = o[2] + r * k * np.cos(psi)
        X = np.full_like(psi, o[0] + s_)
        ring_pts.append(TB(X, Y, Z))
    P = np.array(ring_pts)
    ni = len(profile)
    UV = np.zeros((ni, n + 1, 2))
    uu = np.arange(n + 1) / n
    if u_mirror:
        uu = 1 - uu
    UV[..., 0] = uu[None]
    UV[..., 1] = np.asarray(vcoords)[:, None]
    md = MeshData()
    if closed:
        P2 = np.concatenate([P, P[:1]], 0)
        UV2 = np.concatenate([UV, UV[:1]], 0)
        mk.grid(P2, UV2, wrap=True, md=md)
        nfaces_row = n
        rows = ni
    else:
        mk.grid(P, UV, wrap=True, md=md)
        nfaces_row = n
        rows = ni - 1
    if mat_of_part:
        for i in range(rows):
            part = profile[i][3]
            part2 = profile[(i + 1) % ni][3]
            m = mat_of_part.get(part, 0) if part == part2 or part2 == 'step' else mat_of_part.get(part2, 0)
            if part == 'step' or part2 == 'step':
                m = mat_of_part.get('step', m)
            for j in range(nfaces_row):
                md.mi[i * nfaces_row + j] = m
    return md


def fan_blades_md(side, nblades=24):
    o = _eng_frame(side)
    md = MeshData()
    s_fan = 0.80
    rs = np.linspace(0.27, 0.768, S.qn(7, 3))
    for b in range(nblades):
        phi0 = 2 * math.pi * b / nblades
        rings = []
        for r in rs:
            f = (r - rs[0]) / (rs[-1] - rs[0])
            chord = 0.17 + 0.07 * f
            beta = math.radians(28 + 36 * f ** 0.8)     # stagger from the axis
            th = 0.012 * (1 - f) + 0.004
            camber = 0.02
            pts = []
            cs = np.linspace(-0.5, 0.5, 5)
            for side_s in (1, -1):
                seq = cs if side_s > 0 else cs[::-1]
                for c in seq:
                    thick = th * math.sqrt(max(0.0, 1 - (2 * c) ** 2)) * side_s * 0.5
                    ax = c * chord * math.cos(beta) - (thick + camber * (1 - (2 * c) ** 2) * chord) * math.sin(beta)
                    tg = c * chord * math.sin(beta) + (thick + camber * (1 - (2 * c) ** 2) * chord) * math.cos(beta)
                    ph = phi0 + tg / r
                    X = o[0] + s_fan + ax
                    Y = o[1] + r * math.sin(ph)
                    Z = o[2] + r * math.cos(ph)
                    pts.append(TB(X, Y, Z))
            rings.append(np.array(pts))
        P = np.array(rings)
        UV = np.zeros((P.shape[0], P.shape[1] + 1, 2)) + 0.5
        base = md.nv
        mk.grid(P, UV, wrap=True, md=md)
        mk.cap(md, [base + j for j in range(P.shape[1])])
        mk.cap(md, [base + (P.shape[0] - 1) * P.shape[1] + j for j in range(P.shape[1])], flip=True)
    return md


def lathe_axis(profile_rs, side, n=None, mat=0, uv_v=(0, 1)):
    """Plain (circular) lathe around the engine axis; profile [(s, r)]."""
    prof = [(s_, r, 0.0, 'x') for s_, r in profile_rs]
    n = n or S.qn(48, 16)
    v = S.nac_v_coords(prof, *uv_v)
    md = revolve_profile(prof, side, v, n=n)
    md.set_mat(mat)
    mk.orient_outward(md)
    return md


def pylon_md(side):
    """Engine strut + aft pylon fairing, sections along X (ground frame)."""
    o = _eng_frame(side)
    Yc = o[1]
    from exterior import wing_surface
    surf = wing_surface()
    l = S.wing_l_of_Y(S.ENGINE_Y)
    st = surf.sec(l)

    def wing_low(x):
        t = np.clip((x - st['X']) / st['c'], 0.0, 1.0)
        p, _ = surf.pts(l, np.atleast_1d(t), False)
        return float(p[0, 2])
    xs = np.array([12.55, 12.75, 13.0, 13.4, 13.9, 14.5, 15.1, 15.6, 16.1, 16.6, 17.1, 17.6, 18.1, 18.6, 19.1, 19.45])
    rings = []
    n = 16
    for x in xs:
        s_ = x - o[0]
        if s_ <= S.NAC_LEN:
            zb = o[2] + float(S.NAC_OUT(min(s_, S.NAC_LEN))) - 0.06
        else:
            rc = float(S.CORE(min(max(s_, 3.25), 4.42))) if s_ <= 4.42 else 0.3
            zb = o[2] + rc + 0.10 + 0.55 * S.smoothstep(4.3, 7.6, s_)
        zt = wing_low(x) + 0.25 if x > st['X'] + 0.05 else o[2] + 1.35
        if x < st['X'] + 0.05:
            # forward part rises to meet the wing leading edge
            zt = max(zb + 0.12, wing_low(st['X'] + 0.06) + 0.25 - 0.22 * (st['X'] - x))
        f_front = S.smoothstep(12.5, 13.6, x)
        f_back = 1 - S.smoothstep(17.4, 19.5, x)
        w = 0.40 * (0.35 + 0.65 * f_front) * (0.25 + 0.75 * f_back)
        if x < 12.8:
            zt = zb + 0.12
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            cy = math.sin(a); cz = math.cos(a)
            ey = np.sign(cy) * abs(cy) ** (2 / 3.0)
            ez = np.sign(cz) * abs(cz) ** (2 / 3.0)
            ring.append((x, Yc + w / 2 * ey, (zt + zb) / 2 + (zt - zb) / 2 * ez))
        rings.append(np.array(ring))
    P = np.array([TB(r[:, 0], r[:, 1], r[:, 2]) for r in rings])
    UV = np.zeros((P.shape[0], P.shape[1] + 1, 2)) + 0.5
    md = mk.grid(P, UV, wrap=True)
    mk.cap(md, list(range(n)))
    mk.cap(md, [(len(xs) - 1) * n + j for j in range(n)], flip=True)
    mk.orient_outward(md)
    return md


def chine_md(side):
    """Nacelle vortex strake on the inboard side of the fan cowl."""
    o = _eng_frame(side)
    psi = math.radians(58) * (-side)     # inboard, upper
    md = MeshData()
    pts = []
    for s_, h in ((0.55, 0.0), (0.8, 0.20), (1.30, 0.26), (1.45, 0.0)):
        r = float(S.NAC_OUT(s_)) - 0.01
        rr = r + h
        pts.append((s_, rr))
    base = []
    V = []
    for s_, rr in pts:
        for dth in (-0.004, 0.004):
            ps = psi + dth / rr
            V.append(TB(o[0] + s_, o[1] + rr * math.sin(ps), o[2] + rr * math.cos(ps)))
    V = np.array(V)
    # base (on the cowl surface)
    for s_, rr in pts:
        r = float(S.NAC_OUT(s_)) - 0.01
    faces = [[0, 2, 4, 6][::-1], [1, 3, 5, 7], [0, 1, 3, 2], [2, 3, 5, 4], [4, 5, 7, 6], [6, 7, 1, 0]]
    md.add(V, faces, None, flat=True)
    return md


def build_engine(side, idx, mats):
    """Creates nacelle_<idx> (static), reverser_<idx>, fan_<idx>. side -1 = left (engine 1)."""
    import bpy
    objs = []
    o = _eng_frame(side)
    # UV layout of the nacelle texture: v 0..0.60 fixed nacelle, 0.62..1.0 sleeve
    prof = S.nacelle_profile()
    v = S.nac_v_coords(prof, 0.0, 0.60)
    nac = revolve_profile(prof, side, v, mat_of_part={'inner': 0, 'outer': 0, 'step': 1, 'cascade': 0},
                          u_mirror=side < 0)
    mk.orient_outward(nac, center=TB(*(o + np.array([1.5, 0, 0]))))
    # fan face background disc (behind the blades) + booster spinner cone
    disc = lathe_axis([(1.0, 0.776), (1.02, 0.70), (1.05, 0.40), (1.06, 0.0)], side, mat=3)
    nac.merge(disc)
    # core cowl, core nozzle, plug
    core = lathe_axis([(3.0, 0.60), (3.25, 0.63), (3.62, 0.595), (4.0, 0.52), (4.2, 0.46), (4.42, 0.41),
                       (4.43, 0.375), (4.1, 0.37), (4.0, 0.0)], side, mat=4)
    nac.merge(core)
    plug = lathe_axis([(4.15, 0.0), (4.16, 0.33), (4.42, 0.318), (4.7, 0.25), (4.95, 0.14), (5.10, 0.05), (5.14, 0.0)],
                      side, mat=5)
    nac.merge(plug)
    pyl = pylon_md(side)
    pyl.set_mat(6)
    nac.merge(pyl)
    ch = chine_md(side)
    ch.set_mat(0)
    nac.merge(ch)
    no = mk.obj(f'nacelle_{idx}', nac, [mats['nacelle'], mats['structure'], mats['metal_dark'], mats['metal_dark'],
                                        mats['core'], mats['exhaust'], mats['pylon']], sharp_angle=60)
    objs.append(no)
    # reverser sleeve (translates aft along the engine axis)
    sp = S.sleeve_profile()
    sv = S.nac_v_coords(sp + [sp[0]], 0.62, 1.0)[:-1]
    sl = revolve_profile(sp, side, sv, closed=True, mat_of_part={'outer': 0, 'lip': 0, 'duct': 1, 'step': 1},
                         u_mirror=side < 0)
    mk.orient_outward(sl, center=TB(*(o + np.array([3.0, 0, 0]))))
    M = np.eye(4)
    M[:3, 3] = TB(*(o + np.array([S.NAC_SLEEVE, 0, 0])))
    objs.append(mk.obj(f'reverser_{idx}', sl, [mats['nacelle'], mats['structure']], matrix=M, sharp_angle=60))
    # fan: blades + spinner, spins about the engine axis (blender local Y)
    fan = fan_blades_md(side) if S.Q > 0.6 else MeshData()
    fan.set_mat(0)
    spin = lathe_axis([(0.30, 0.0), (0.33, 0.045), (0.40, 0.10), (0.50, 0.16), (0.62, 0.22), (0.74, 0.262),
                       (0.84, 0.28), (0.92, 0.285), (0.95, 0.0)], side, mat=1)
    fan.merge(spin)
    M = np.eye(4)
    M[:3, 3] = TB(*(o + np.array([0.80, 0, 0])))
    objs.append(mk.obj(f'fan_{idx}', fan, [mats['fan'], mats['spinner']], matrix=M, sharp_angle=40))
    # empties
    mk.empty(f'engine_{idx}', TB(*(o + np.array([1.2, 0, 0]))))
    mk.empty(f'nozzle_{idx}', TB(*(o + np.array([4.45, 0, 0]))))
    return objs
