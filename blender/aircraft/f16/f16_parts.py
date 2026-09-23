"""F-16 exterior parts (pure numpy -> MeshData). Drawing frame: s aft of pitot tip, y right, z above ground."""
import math
import numpy as np
from f16_geom import (MeshData, airfoil, section_curve, grid_faces, cap_fan, to_blender, pchip, smoothstep, lerp,
                      rot_matrix, CG_S, CG_Z)
import f16_layout as LY
import f16_fuselage as FU

# ---------------------------------------------------------------- planforms (digitized)
WING_Z = 1.905
LE_S0, LE_Y0, LE_T = 7.111, 1.351, 0.8057     # wing LE: s = LE_S0 + (y-LE_Y0)*LE_T
WING_TE = 10.90
WING_TIP = 4.608
WING_ROOT = 0.80


def wing_le(y):
    return LE_S0 + (y - LE_Y0) * LE_T


FLAP_Y0, FLAP_Y1 = 1.40, 3.612
def flap_hinge(y):
    return 10.254 + (y - 1.35) * (0.355 / 2.564)


LEF_Y0, LEF_Y1 = 1.351, WING_TIP
def lef_hinge(y):
    return 7.711 + (y - 1.346) * ((9.998 - 7.711) / (4.608 - 1.346))


STAB_Y0 = 1.060
STAB_Z0 = 1.965
STAB_PIVOT_S = 13.10
STAB_ANHEDRAL = math.radians(10.0)
STAB_SPAN = 2.811 - 1.048


def stab_le(sp):
    return 12.128 + sp * (1.574 / 1.763)


def stab_te(sp):
    return 14.565 if sp <= 1.477 else 14.565 - (sp - 1.477) * (0.221 / 0.286)


FIN_Z0 = 3.043
def fin_le(z):
    return 11.42 + (z - FIN_Z0) * (2.411 / 2.137)


def fin_te(z):
    return 13.984 + (z - FIN_Z0) * (0.978 / 1.959)


def rudder_hinge(z):
    return 13.227 + (z - FIN_Z0) * (1.338 / 1.959)


FIN_TOP = 5.002


# ---------------------------------------------------------------- generic lifting surface
def lifting_surface(stations, section_fn, n_af=40, uv_fn=None, cap_root=True, cap_tip=True, mirror=False):
    """stations: list of span parameters; section_fn(p) -> (M,3) points in drawing frame (s,y,z) for the airfoil
    loop (TE upper -> LE -> TE lower). uv_fn(face_kind, s, y, z) -> uv; face_kind 'U' or 'L'.
    Returns MeshData in Blender coords."""
    rings = [np.asarray(section_fn(p)) for p in stations]
    M = len(rings[0])
    R = np.array(rings)                 # (ns, M, 3)
    if mirror:
        R = R.copy(); R[..., 1] *= -1
    ns = len(stations)
    V = to_blender(R[..., 0], R[..., 1], R[..., 2]).reshape(-1, 3)
    faces, uvs = [], []
    half = M // 2
    for i in range(ns - 1):
        for j in range(M):
            j2 = (j + 1) % M
            a, b, c, d = i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j
            f = (a, b, c, d)
            if mirror:
                f = f[::-1]
            faces.append(f)
            if uv_fn is not None:
                kind = 'U' if j < half else 'L'
                cor = []
                for vi in f:
                    ii, jj = divmod(vi, M)
                    p = R[ii, jj]
                    cor.append(uv_fn(kind, p[0], p[1], p[2]))
                uvs.append(cor)
    md_extra = []
    for end, do in ((0, cap_root), (ns - 1, cap_tip)):
        if not do:
            continue
        ring = list(range(end * M, end * M + M))
        cidx = len(V) + len(md_extra)
        cen = R[end].mean(axis=0)
        md_extra.append(to_blender(cen[0], cen[1], cen[2]))
        fl = (end == ns - 1)
        if mirror:
            fl = not fl
        for f in cap_fan(ring, cidx, flip=fl):
            faces.append(f)
            if uv_fn is not None:
                cor = []
                for vi in f:
                    if vi == cidx:
                        p = cen
                    else:
                        ii, jj = divmod(vi, M); p = R[ii, jj]
                    cor.append(uv_fn('U', p[0], p[1], p[2]))
                uvs.append(cor)
    if md_extra:
        V = np.concatenate([V, np.array(md_extra)])
    return MeshData(V, faces, uvs if uv_fn is not None else None)


# ---------------------------------------------------------------- wing
def wing_stations():
    ys = [WING_ROOT, 0.95, 1.10, 1.25, 1.351, 1.40]
    y = 1.40
    while y < WING_TIP - 0.12:
        y += 0.16
        ys.append(min(y, WING_TIP))
    ys += [3.612, WING_TIP - 0.004, WING_TIP]
    ys = sorted(set(round(v, 4) for v in ys))
    return ys


AF_WING = airfoil(n=44, t=0.04, camber=0.011, te_thick=0.0025)


def wing_section(y):
    s_le = wing_le(y)
    c = WING_TE - s_le
    af = AF_WING
    s = s_le + af[:, 0] * c
    z = WING_Z + af[:, 1] * c
    if y > WING_TIP - 0.005:
        # rounded tip: shrink thickness slightly at the last station
        z = WING_Z + (z - WING_Z) * (0.35 if y >= WING_TIP else 0.8)
    return np.stack([s, np.full_like(s, y), z], 1)


def wing_mesh(side='R'):
    reg = lambda k: ('WU_' if k == 'U' else 'WL_') + side
    uvf = lambda kind, s, y, z: LY.region_uv(reg(kind), s, abs(y))
    return lifting_surface(wing_stations(), wing_section, uv_fn=uvf, mirror=(side == 'L'))


# ---------------------------------------------------------------- stabilator
AF_STAB = airfoil(n=30, t=0.045, camber=0.0, te_thick=0.003)


def stab_point(s, sp, zoff):
    y = STAB_Y0 + sp * math.cos(STAB_ANHEDRAL) + zoff * math.sin(STAB_ANHEDRAL)
    z = STAB_Z0 - sp * math.sin(STAB_ANHEDRAL) + zoff * math.cos(STAB_ANHEDRAL)
    return s, y, z


def stab_section(sp):
    le, te = stab_le(sp), stab_te(sp)
    c = te - le
    t = 1.0 - 0.3 * sp / STAB_SPAN
    af = AF_STAB
    out = []
    shrink = 0.4 if sp >= STAB_SPAN - 1e-4 else 1.0
    for x, zz in af:
        out.append(stab_point(le + x * c, sp, zz * c * t * shrink))
    return np.array(out)


def stab_mesh(side='R'):
    sps = [0.0, 0.08] + list(np.linspace(0.2, 1.4, 7)) + [1.477, 1.58, 1.68, STAB_SPAN - 0.003, STAB_SPAN]
    def uvf(kind, s, y, z):
        sp = ((abs(y) - STAB_Y0) * math.cos(STAB_ANHEDRAL) - (z - STAB_Z0) * math.sin(STAB_ANHEDRAL))
        return LY.region_uv(('SU_' if kind == 'U' else 'SL_') + side, s, sp)
    return lifting_surface(sps, stab_section, uv_fn=uvf, mirror=(side == 'L'))


# ---------------------------------------------------------------- fin
AF_FIN = airfoil(n=34, t=0.05, camber=0.0, te_thick=0.004)


def fin_section(z):
    le, te = fin_le(z), fin_te(z)
    c = te - le
    t = 1.0 - 0.25 * (z - FIN_Z0) / (FIN_TOP - FIN_Z0)
    af = AF_FIN
    s = le + af[:, 0] * c
    y = af[:, 1] * c * t
    return np.stack([s, y, np.full_like(s, z)], 1)


def fin_mesh():
    zs = [2.93, 3.043] + list(np.linspace(3.2, 4.9, 9)) + [FIN_TOP + 0.02]
    def uvf(kind, s, y, z):
        return LY.region_uv('FIN_R' if kind == 'U' else 'FIN_L', s, z)
    # the fin is built "spanwise" along z: express as lifting surface with y as thickness axis
    rings = [fin_section(z) for z in zs]
    M = len(rings[0]); R = np.array(rings); ns = len(zs)
    V = to_blender(R[..., 0], R[..., 1], R[..., 2]).reshape(-1, 3)
    faces, uvs = [], []
    half = M // 2
    for i in range(ns - 1):
        for j in range(M):
            j2 = (j + 1) % M
            f = (i * M + j, (i + 1) * M + j, (i + 1) * M + j2, i * M + j2)
            faces.append(f)
            kind = 'U' if j < half else 'L'
            uvs.append([uvf(kind, *R[divmod(v, M)]) for v in f])
    extra = []
    for end, fl in ((0, True), (ns - 1, False)):
        ring = list(range(end * M, end * M + M)); cidx = len(V) + len(extra)
        cen = R[end].mean(0); extra.append(to_blender(*cen))
        for f in cap_fan(ring, cidx, flip=fl):
            faces.append(f)
            uvs.append([uvf('U', *(cen if v == cidx else R[divmod(v, M)])) for v in f])
    V = np.concatenate([V, np.array(extra)])
    return MeshData(V, faces, uvs, 'fin')


# ---------------------------------------------------------------- generic tube loft (closed sections along s)
def tube_loft(S, half_fn, uv_fn=None, cap0=True, cap1=True, name='tube'):
    """half_fn(s) -> (m,2) right half (y,z) from top center to bottom center. Mirrored to a closed ring."""
    rings = []
    for s in S:
        h = np.asarray(half_fn(s))
        full = np.concatenate([h, np.stack([-h[-2:0:-1, 0], h[-2:0:-1, 1]], 1)])
        rings.append(full)
    R = np.array(rings); ns, M = R.shape[0], R.shape[1]
    nh = len(half_fn(S[0]))
    V = np.zeros((ns, M, 3))
    for i, s in enumerate(S):
        V[i] = to_blender(np.full(M, s), R[i, :, 0], R[i, :, 1])
    V = V.reshape(-1, 3)
    # arc lengths for uv
    arcs = np.zeros((ns, M))
    for i in range(ns):
        d = np.linalg.norm(np.diff(np.vstack([R[i], R[i][:1]]), axis=0), axis=1)
        arcs[i] = np.concatenate([[0], np.cumsum(d)[:-1]])
    faces, uvs = [], []
    perim = np.array([arcs[i, -1] + np.linalg.norm(R[i, -1] - R[i, 0]) for i in range(ns)])
    for i in range(ns - 1):
        for j in range(M):
            j2 = (j + 1) % M
            a, b, c, d = i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j
            faces.append((a, d, c, b))
            if uv_fn is not None:
                cor = []
                for (ii, jj) in ((i, j), (i + 1, j), (i + 1, j2), (i, j2)):
                    arc = arcs[ii, jj]
                    arc = min(arc, perim[ii] - arc)        # symmetric: distance from the top centerline
                    cor.append(uv_fn(S[ii], arc, R[ii, jj]))
                uvs.append(cor)
    extra = []
    for end, do, fl in ((0, cap0, False), (ns - 1, cap1, True)):
        if not do:
            continue
        ring = list(range(end * M, end * M + M)); cidx = len(V) + len(extra)
        cen = R[end].mean(0)
        extra.append(to_blender(S[end], cen[0], cen[1]))
        for f in cap_fan(ring, cidx, flip=fl):
            faces.append(f)
            if uv_fn is not None:
                uvs.append([uv_fn(S[end], 0.0, cen)] * 3)
    if extra:
        V = np.concatenate([V, np.array(extra)])
    return MeshData(V, faces, uvs if uv_fn is not None else None, name)


def rounded_half(w, zb, zt, r_top=0.6, n=10):
    """Right half of a rounded box section: top center -> bottom center."""
    rt = min(r_top * w, (zt - zb) * 0.8)
    P = [(0, zt), (w - rt, zt), (w, zt - rt), (w, zb + 0.02), (w * 0.6, zb), (0, zb)]
    sharp = [0, 0, 0, 0.6, 0, 0]
    pts, _ = section_curve(P, sharp, [3, 3, 3, 2, 2])
    return pts


# ---------------------------------------------------------------- dorsal fairing + fin root box
DORSAL_KEYS = [  # s, top z, half width, bottom z
    (9.05, 2.585, 0.22, 2.45), (9.30, 2.628, 0.235, 2.45), (9.60, 2.69, 0.225, 2.45), (10.0, 2.765, 0.21, 2.45),
    (10.5, 2.865, 0.19, 2.45), (11.0, 2.962, 0.17, 2.45), (11.42, 3.043, 0.155, 2.45), (11.8, 3.05, 0.148, 2.45),
    (12.8, 3.05, 0.145, 2.45), (13.25, 3.05, 0.135, 2.60), (13.70, 3.05, 0.115, 2.625), (13.975, 3.05, 0.095, 2.63),
]


def dorsal_mesh():
    k = np.array(DORSAL_KEYS)
    S = np.concatenate([np.linspace(9.05, 11.42, 22), np.linspace(11.5, 13.975, 16)])
    def half(s):
        zt, w, zb = pchip(k[:, 0], k[:, 1:4], [s])[0]
        return rounded_half(w, zb, zt, r_top=0.75)
    def uvf(s, arc, p):
        return LY.region_uv('DORSAL', s, min(arc, 1.04))
    return tube_loft(S, half, uvf, name='dorsal')


# ---------------------------------------------------------------- fin tip cap (RWR antennas + tail light)
def fincap_mesh():
    S = np.concatenate([np.linspace(13.62, 13.95, 8), np.linspace(14.1, 15.06, 8)])
    def half(s):
        zt = min(5.185, FIN_Z0 + (s - 11.42) / (2.411 / 2.137) + 0.005)
        zb = 4.985
        f = smoothstep(13.62, 13.95, s)
        w = 0.018 + 0.047 * f
        if s > 14.9:
            w *= 1.0 - 0.25 * (s - 14.9) / 0.16
        return rounded_half(w, zb, max(zt, zb + 0.02), r_top=0.9)
    def uvf(s, arc, p):
        return LY.region_uv('FCAP', s, min(arc, 0.54))
    return tube_loft(S, half, uvf, name='fincap')


# ---------------------------------------------------------------- ventral fins (canted 15 deg outward)
VF_CANT = math.radians(15)
VF_ROOT = (0.625, 1.20)   # (y, z) of the root line on the fuselage


def ventral_mesh(side='R'):
    # planform in (s, h) with h measured down the fin plane from the root line
    ch = math.cos(VF_CANT)
    pts_top = [(10.46, 1.26), (11.86, 1.28)]
    def le(h):
        z = VF_ROOT[1] - h * ch
        return 10.50 + (1.20 - z) * (0.35 / 0.65)
    def te(h):
        return 11.86
    hmax = (VF_ROOT[1] - 0.60) / ch
    hs = [-0.10, 0.0] + list(np.linspace(0.1, hmax - 0.02, 6)) + [hmax]
    af = airfoil(n=18, t=0.06, camber=0, te_thick=0.02)
    rings = []
    for h in hs:
        l, t_ = le(max(h, 0)), te(h)
        # bottom edge slopes up aft: clip chord
        if h > 0.5:
            pass
        c = t_ - l
        pts = []
        for x, zz in af:
            s = l + x * c
            th = zz * c * (1 - 0.3 * max(h, 0) / hmax)
            y = VF_ROOT[0] + h * math.sin(VF_CANT) + th * ch
            z = VF_ROOT[1] - h * ch + th * math.sin(VF_CANT)
            pts.append((s, y, z))
        rings.append(pts)
    R = np.array(rings)
    # bottom edge: the real fin's lower edge rises aft (0.55 fwd -> 0.72 aft); shape by pulling the last rings
    zlim = lambda s: 0.55 + (s - 10.85) * (0.17 / 1.0)
    for i in range(len(hs)):
        for j in range(R.shape[1]):
            s, y, z = R[i, j]
            zl = zlim(s)
            if z < zl:
                d = (zl - z)
                R[i, j, 2] = zl
                R[i, j, 1] -= d * math.tan(VF_CANT)
    if side == 'L':
        R[..., 1] *= -1
    ns, M = R.shape[:2]
    V = to_blender(R[..., 0], R[..., 1], R[..., 2]).reshape(-1, 3)
    faces, uvs = [], []
    half = M // 2
    for i in range(ns - 1):
        for j in range(M):
            j2 = (j + 1) % M
            f = (i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j)
            if side == 'R':
                f = f[::-1]
            faces.append(f)
            outer = (j < half)
            reg = ('VF_RO' if outer else 'VF_RI') if side == 'R' else ('VF_LO' if outer else 'VF_LI')
            uvs.append([LY.region_uv(reg, R[divmod(v, M)][0], R[divmod(v, M)][2]) for v in f])
    extra = []
    for end, fl in ((0, side == 'L'), (ns - 1, side == 'R')):
        ring = list(range(end * M, end * M + M)); cidx = len(V) + len(extra)
        cen = R[end].mean(0); extra.append(to_blender(*cen))
        reg = 'VF_RO' if side == 'R' else 'VF_LO'
        for f in cap_fan(ring, cidx, flip=fl):
            faces.append(f)
            uvs.append([LY.region_uv(reg, cen[0], cen[2])] * 3)
    V = np.concatenate([V, np.array(extra)])
    return MeshData(V, faces, uvs, 'ventral_' + side)


# ---------------------------------------------------------------- speedbrakes (split clamshell at the strake ends)
SB_S0, SB_S1 = 13.335, 14.24
SB_Y0, SB_Y1 = 0.665, 1.045
SB_ZMID = 1.962


def speedbrake_panel(side='R', upper=True, cell=0):
    """One clamshell half. Returns MeshData (Blender coords) and hinge (s,z)."""
    ns, ny = 10, 6
    S = np.linspace(SB_S0, SB_S1, ns)
    Y = np.linspace(SB_Y0, SB_Y1, ny)
    sign = 1 if upper else -1
    def outer_z(s, y):
        f = (s - SB_S0) / (SB_S1 - SB_S0)
        th0 = 0.098 - 0.02 * (y - SB_Y0) / (SB_Y1 - SB_Y0)
        th = th0 * (1 - f) ** 1.15 + 0.006
        # round the outer (strake) edge
        e = smoothstep(SB_Y1 - 0.06, SB_Y1, y)
        th *= (1 - 0.55 * e)
        return SB_ZMID + sign * th
    verts = []
    for s in S:
        for y in Y:
            verts.append((s, y, outer_z(s, y)))
    for s in S:
        for y in Y:
            verts.append((s, y, SB_ZMID + sign * 0.002))
    V = np.array(verts)
    if side == 'L':
        V[:, 1] *= -1
    faces = []
    n = ns * ny
    top = grid_faces(ns, ny)
    bot = grid_faces(ns, ny, flip=True)
    faces += top + [tuple(i + n for i in f) for f in bot]
    # borders
    def idx(i, j, layer):
        return layer * n + i * ny + j
    for i in range(ns - 1):
        for j in (0, ny - 1):
            f = (idx(i, j, 0), idx(i + 1, j, 0), idx(i + 1, j, 1), idx(i, j, 1))
            faces.append(f if j == 0 else f[::-1])
    for j in range(ny - 1):
        for i in (0, ns - 1):
            f = (idx(i, j, 0), idx(i, j + 1, 0), idx(i, j + 1, 1), idx(i, j, 1))
            faces.append(f[::-1] if i == 0 else f)
    if (not upper) ^ (side == 'L'):
        faces = [f[::-1] for f in faces]
    # uv: each panel face gets its own cell in the SB block
    uvs = []
    r = LY.REGIONS['SB']
    x0, y0 = LY.sb_cell(cell)
    for f in faces:
        cor = []
        for v in f:
            p = V[v]
            px = x0 + (p[0] - SB_S0) * r['k']
            py = y0 + (abs(p[1]) - SB_Y0) * r['k']
            cor.append(LY.px_to_uv(px, py))
        uvs.append(cor)
    md = MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), faces, uvs, 'sb')
    hinge = (SB_S0, SB_ZMID + sign * 0.10)
    return md, hinge


# ---------------------------------------------------------------- canopy
CAN_TOP = [(2.797, 2.368), (2.85, 2.41), (2.9, 2.466), (3.0, 2.544), (3.1, 2.621), (3.2, 2.681), (3.3, 2.739),
           (3.4, 2.795), (3.5, 2.848), (3.6, 2.888), (3.7, 2.927), (3.8, 2.957), (3.9, 2.987), (4.0, 3.008),
           (4.2, 3.040), (4.4, 3.053), (4.6, 3.051), (4.8, 3.042), (5.0, 3.025), (5.2, 2.992), (5.4, 2.958),
           (5.6, 2.922), (5.8, 2.881), (6.0, 2.838), (6.1, 2.814), (6.2, 2.790), (6.296, 2.765)]
CAN_W = [(2.797, 0.0), (2.813, 0.093), (2.875, 0.181), (2.969, 0.261), (3.133, 0.329), (3.372, 0.392),
         (3.639, 0.427), (3.946, 0.445), (4.23, 0.432), (4.546, 0.397), (4.854, 0.348), (5.213, 0.287),
         (5.745, 0.175), (6.079, 0.092), (6.239, 0.041), (6.296, 0.0)]
FRAME_W = [(2.752, 0.0), (2.756, 0.095), (2.772, 0.183), (2.809, 0.284), (2.867, 0.373), (2.913, 0.418),
           (3.099, 0.43), (3.409, 0.449), (3.692, 0.469), (4.008, 0.486), (4.296, 0.489), (4.626, 0.492),
           (4.939, 0.486), (5.193, 0.474), (5.353, 0.452)]
ARCH_S_BOT, ARCH_S_TOP = 5.00, 5.19       # aft arch of the transparency (inclined)
CANOPY_HINGE = (6.24, 2.735)              # (s, z) of the canopy hinge (lateral axis)


def canopy_top(s):
    k = np.array(CAN_TOP)
    return float(np.interp(s, k[:, 0], k[:, 1]))


def canopy_w(s):
    k = np.array(CAN_W)
    return float(pchip(k[:, 0], k[:, 1], [s])[0])


def frame_w(s):
    k = np.array(FRAME_W)
    if s >= k[-1, 0]:
        return float(k[-1, 1] * max(0.0, 1 - (s - k[-1, 0]) / 0.9))
    return float(pchip(k[:, 0], k[:, 1], [s])[0])


def glass_edge_w(s):
    """half-width of the glass bottom edge (sits on the fuselage surface, inside the frame rail)."""
    w = canopy_w(s)
    if s < 5.3:
        return max(0.0, min(w * 0.985, frame_w(s) - 0.045))
    return w * 0.99


def arch_s(z):
    return ARCH_S_BOT + (z - 2.60) * (ARCH_S_TOP - ARCH_S_BOT) / (2.99 - 2.60)


def canopy_section(s, n=(6, 6, 6)):
    """Right half of the canopy section (top center -> glass edge on the fuselage)."""
    zt = canopy_top(s)
    ye = glass_edge_w(s)
    ze = FU.surface_point(s, ye, upper=True) + 0.004
    w = max(canopy_w(s), ye + 0.001)
    h = max(zt - ze, 0.005)
    # height of the widest point: low at the front (windscreen), ~30 % up in the middle, lower on the aft fairing
    fz = 0.18 + 0.14 * smoothstep(2.8, 3.6, s) - 0.12 * smoothstep(5.0, 6.0, s)
    zm = ze + fz * h
    P = [(0.0, zt), (0.66 * w, zm + 0.80 * (zt - zm)), (w, zm), (ye, ze)]
    pts, _ = section_curve(P, [0, 0, 0, 0], list(n), start_tan=(1, 0), end_tan=None)
    return pts


def canopy_mesh():
    """Canopy skin (glass + opaque aft fairing, material index 0 = glass, 1 = paint) in drawing frame."""
    S = np.concatenate([np.linspace(2.80, 2.95, 6)[:-1], np.linspace(2.95, 5.4, 44)[:-1], np.linspace(5.4, 6.29, 14)])
    rings = []
    for s in S:
        h = canopy_section(s)                              # top center -> right glass edge
        right = h[::-1]                                    # right edge -> top
        left = np.stack([-h[1:, 0], h[1:, 1]], 1)          # (after the top) -> left edge
        rings.append(np.concatenate([right, left]))
    R = np.array(rings)                                    # (ns, M, 2): right edge -> top -> left edge
    ns, M = R.shape[:2]
    V = np.zeros((ns, M, 3))
    for i, s in enumerate(S):
        V[i] = np.stack([np.full(M, s), R[i, :, 0], R[i, :, 1]], 1)
    # front tip point
    tip = np.array([[2.797, 0.0, 2.370]])
    Vf = V.reshape(-1, 3)
    faces, mats, uvs = [], [], []
    for i in range(ns - 1):
        for j in range(M - 1):
            a, b, c, d = i * M + j, i * M + j + 1, (i + 1) * M + j + 1, (i + 1) * M + j
            f = (a, d, c, b)
            faces.append(f)
            cen = Vf[list(f)].mean(0)
            glass = cen[0] < arch_s(cen[2]) - 0.01
            mats.append(0 if glass else 1)
    tip_i = len(Vf)
    Vf = np.concatenate([Vf, tip])
    for j in range(M - 1):
        faces.append((tip_i, j, j + 1)[::-1])
        mats.append(0)
    # close the aft end (fairing end) with a fan
    end_i = len(Vf)
    Vf = np.concatenate([Vf, [[S[-1] + 0.006, 0.0, V[-1, :, 2].min() + 0.002]]])
    base = (ns - 1) * M
    for j in range(M - 1):
        faces.append((base + j, base + j + 1, end_i)[::-1])
        mats.append(1)
    # uv for the painted part (fairing) : CANF region (s, arc from the right edge)
    def uvp(p):
        return LY.region_uv('CANF', p[0], min(1.39, abs(p[1]) * 0.6 + (p[2] - 2.55) * 1.2 + 0.3))
    for f in faces:
        uvs.append([uvp(Vf[v]) for v in f])
    md = MeshData(to_blender(Vf[:, 0], Vf[:, 1], Vf[:, 2]), faces, uvs, 'canopy')
    md.mat_index = mats
    md.meta = dict(S=S, V=V)
    return md


def sweep_frames(path, frames, profile, closed_path=False, closed_profile=True, name='sweep'):
    """Sweep a 2-D profile [(u,v)] along a path (drawing frame) with explicit per-point frames [(U,V)] (unit vectors
    in the drawing frame). Returns MeshData (Blender coords)."""
    P = np.asarray(path, float)
    rings = []
    for p, (U, Vv) in zip(P, frames):
        U = np.asarray(U, float); Vv = np.asarray(Vv, float)
        rings.append([p + U * u + Vv * v for u, v in profile])
    R = np.array(rings)
    n, m = R.shape[:2]
    V = to_blender(R[..., 0], R[..., 1], R[..., 2]).reshape(-1, 3)
    faces = grid_faces(n, m, wrap_c=closed_profile, wrap_r=closed_path)
    md = MeshData(V, faces, None, name)
    md.closed = closed_path and closed_profile
    return md


def path_tangents(P, closed=False):
    P = np.asarray(P, float)
    n = len(P)
    T = np.zeros_like(P)
    for i in range(n):
        if closed:
            T[i] = P[(i + 1) % n] - P[i - 1]
        else:
            T[i] = P[min(i + 1, n - 1)] - P[max(i - 1, 0)]
    return T / np.maximum(np.linalg.norm(T, axis=1), 1e-9)[:, None]


def surface_frames(P, normals, closed=False):
    """Frames for bands lying on a surface: U = side (normal x tangent), V = surface normal."""
    T = path_tangents(P, closed)
    fr = []
    for t, nrm in zip(T, normals):
        nrm = np.asarray(nrm, float); nrm = nrm - t * np.dot(t, nrm); nrm /= np.linalg.norm(nrm)
        side = np.cross(nrm, t); side /= np.linalg.norm(side)
        fr.append((side, nrm))
    return fr


def canopy_frame_mesh():
    """Sill rails + front bow of the canopy frame, following the fuselage surface."""
    S = np.linspace(2.86, 5.40, 64)
    right = []
    for s in S:
        ye = glass_edge_w(s)
        yf = min(frame_w(s), ye + 0.07)
        ym = 0.5 * (ye + yf)
        zm = FU.surface_point(s, ym, upper=True)
        right.append((s, ym, zm))
    right = np.array(right)
    tipz = FU.surface_point(2.80, 0.0, upper=True)
    front = []
    # front bow: smooth U through the canopy nose tip
    for k in range(1, 12):
        a = math.pi * k / 12
        yy = right[0, 1] * math.cos(a)
        ss = 2.80 + (right[0, 0] - 2.80) * abs(math.cos(a)) ** 0.7 * 0.999
        front.append((ss, yy, FU.surface_point(ss, abs(yy), upper=True)))
    path = [(p[0], -p[1], p[2]) for p in right[::-1]] + front[::-1] + [tuple(p) for p in right]
    # reorder front so that it goes from left (-y) to right (+y)
    fr_sorted = sorted(front, key=lambda p: p[1])
    path = [(p[0], -p[1], p[2]) for p in right[::-1]] + fr_sorted + [tuple(p) for p in right]
    P = np.array(path)
    normals = [FU.surface_normal(p[0], p[1]) for p in P]
    prof = [(-0.034, -0.004), (0.034, -0.004), (0.036, 0.010), (0.026, 0.022), (-0.026, 0.022), (-0.036, 0.010)]
    md = sweep_frames(P, surface_frames(P, normals), prof, name='canopy_frame')
    return md


def arch_mesh():
    """Aft arch of the transparency at the glass/fairing boundary."""
    S = np.linspace(4.9, 5.3, 81)
    secs = [canopy_section(s) for s in S]
    nsec = len(secs[0])
    half = []
    for k in range(nsec):
        best = None
        for s, sec in zip(S, secs):
            y, z = sec[k]
            d = s - arch_s(z)
            if best is None or abs(d) < abs(best[0]):
                best = (d, s, y, z)
        half.append((best[1], best[2], best[3]))
    half = np.array(half)                       # top -> edge
    P = np.array([tuple(p) for p in half[::-1]] + [(p[0], -p[1], p[2]) for p in half[1:]])
    # outward normal ~ radial from the canopy axis (y=0, z=2.50), tilted with the arch
    normals = []
    for p in P:
        nrm = np.array([0.0, p[1], p[2] - 2.50]); nrm /= np.linalg.norm(nrm)
        normals.append(nrm)
    prof = [(-0.05, -0.004), (0.05, -0.004), (0.05, 0.02), (-0.05, 0.02)]
    return sweep_frames(P, surface_frames(P, normals), prof, name='canopy_arch')


# ---------------------------------------------------------------- nozzle (F110-GE-129)
NOZ_S0 = 13.90
NOZ_S1 = 14.57
NOZ_R0 = 0.566
NOZ_ZC = 1.885
NOZ_N = 14


def nozzle_petal(k, r_exit=0.44, n_arc=5, n_len=8):
    """External flap k (0..NOZ_N-1) in the closed (dry, max) pose. Drawing frame -> MeshData (Blender)."""
    a0 = (k - 0.5) * 2 * math.pi / NOZ_N - 0.035
    a1 = (k + 0.5) * 2 * math.pi / NOZ_N + 0.035
    L = NOZ_S1 - NOZ_S0
    th = 0.012
    verts = []
    for layer, dr in ((0, 0.0), (1, -th)):
        for i in range(n_len + 1):
            f = i / n_len
            s = NOZ_S0 + f * L
            r = NOZ_R0 + (r_exit - NOZ_R0) * f + dr - 0.01 * math.sin(math.pi * f) * 0
            for j in range(n_arc + 1):
                a = a0 + (a1 - a0) * j / n_arc
                # slight outward bulge in the middle of the flap (faceted look)
                bul = 0.004 * math.cos((j / n_arc - 0.5) * math.pi)
                rr = r + bul
                verts.append((s, rr * math.sin(a), NOZ_ZC + rr * math.cos(a)))
    V = np.array(verts)
    nr, nc = n_len + 1, n_arc + 1
    n = nr * nc
    faces = grid_faces(nr, nc, flip=True) + [tuple(i + n for i in f) for f in grid_faces(nr, nc)]
    idx = lambda i, j, l: l * n + i * nc + j
    for i in range(nr - 1):
        for j, fl in ((0, False), (nc - 1, True)):
            f = (idx(i, j, 0), idx(i + 1, j, 0), idx(i + 1, j, 1), idx(i, j, 1))
            faces.append(f[::-1] if fl else f)
    for j in range(nc - 1):
        for i, fl in ((0, False), (nr - 1, True)):
            f = (idx(i, j, 0), idx(i, j + 1, 0), idx(i, j + 1, 1), idx(i, j, 1))
            faces.append(f if fl else f[::-1])
    uvs = []
    for f in faces:
        cor = []
        for v in f:
            l, rem = divmod(v, n)
            i, j = divmod(rem, nc)
            u = (k + j / n_arc) / NOZ_N
            vv = i / n_len
            cor.append((u, 0.5 * vv + (0.5 if l else 0.0)))
        uvs.append(cor)
    md = MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), faces, uvs, 'petal')
    am = 0.5 * (a0 + a1)
    hinge_pt = (NOZ_S0, NOZ_R0 * math.sin(am), NOZ_ZC + NOZ_R0 * math.cos(am))
    tangent = (0.0, math.cos(am), -math.sin(am))      # drawing frame direction (ds, dy, dz)
    return md, hinge_pt, tangent, am


def revolve(profile, n=48, zc=NOZ_ZC, name='rev', flip=False, uv_v=None):
    """Revolve a profile [(s, r), ...] around the nozzle axis (drawing frame) -> MeshData (Blender)."""
    P = np.asarray(profile, float)
    m = len(P)
    verts = []
    for i in range(m):
        for j in range(n):
            a = 2 * math.pi * j / n
            verts.append((P[i, 0], P[i, 1] * math.sin(a), zc + P[i, 1] * math.cos(a)))
    V = np.array(verts)
    faces = grid_faces(m, n, wrap_c=True, flip=not flip)
    uvs = []
    for f in faces:
        cor = []
        for v in f:
            i, j = divmod(v, n)
            cor.append((j / n, (uv_v[i] if uv_v is not None else i / max(m - 1, 1))))
        uvs.append(cor)
    return MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), faces, uvs, name)


def nozzle_fixed():
    # attach collar (short ring overlapping the fuselage end) + inner liner + flame holder + turbine cone
    parts = {}
    parts['collar'] = revolve([(13.84, NOZ_R0 - 0.004), (13.87, NOZ_R0 + 0.006), (13.915, NOZ_R0 + 0.006),
                               (13.93, NOZ_R0 - 0.01)], 48, name='noz_collar')
    # inner liner (visible through the exit): faces inward
    liner = [(13.93, 0.52), (13.80, 0.445), (13.40, 0.445), (13.00, 0.44)]
    parts['liner'] = revolve(liner, 48, name='noz_liner', flip=True, uv_v=[0, 0.1, 0.6, 1.0])
    # flame holder rings + turbine exhaust cone
    cone = [(12.95, 0.44), (12.96, 0.30), (13.05, 0.22), (13.25, 0.10), (13.40, 0.0)]
    parts['cone'] = revolve(cone, 32, name='noz_cone')
    fh = [(13.30, 0.30), (13.33, 0.315), (13.36, 0.30), (13.33, 0.285), (13.30, 0.30)]
    parts['fh1'] = revolve(fh, 40, name='noz_fh1')
    fh2 = [(13.24, 0.19), (13.27, 0.205), (13.30, 0.19), (13.27, 0.175), (13.24, 0.19)]
    parts['fh2'] = revolve(fh2, 32, name='noz_fh2')
    return parts


# ---------------------------------------------------------------- intake: mouth outline, lip, duct
MOUTH = [(0.0, 1.432), (0.20, 1.446), (0.40, 1.470), (0.54, 1.492), (0.605, 1.492), (0.633, 1.452),
         (0.628, 1.360), (0.590, 1.260), (0.510, 1.170), (0.390, 1.105), (0.21, 1.072), (0.0, 1.063)]
S_LIP = 4.595


def mouth_outline(n_half=24):
    P = np.array(MOUTH)
    sharp = [0] * len(P)
    pts, _ = section_curve(P, sharp, [2] * (len(P) - 1), start_tan=(1, 0.08), end_tan=(-1, 0))
    # resample to n_half+1 points by arc length
    d = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    t = np.linspace(0, d[-1], n_half + 1)
    y = np.interp(t, d, pts[:, 0]); z = np.interp(t, d, pts[:, 1])
    half = np.stack([y, z], 1)
    full = np.concatenate([half, np.stack([-half[-2:0:-1, 0], half[-2:0:-1, 1]], 1)])
    return full                           # closed loop, starts at the top center going right


def intake_cutter_poly():
    return mouth_outline(24)


def intake_duct():
    """Duct surface from the mouth going aft and up, morphing to a circle; normals face inward."""
    m0 = mouth_outline(24)
    M = len(m0)
    ang = np.arctan2(m0[:, 0], m0[:, 1] - m0[:, 1].mean())
    S = np.array([S_LIP - 0.005, 4.70, 4.9, 5.2, 5.6, 6.1, 6.7])
    rings = []
    for i, s in enumerate(S):
        f = smoothstep(4.6, 6.7, s)
        zc = 1.26 + 0.25 * f
        r = 0.36 - 0.05 * f
        circ = np.stack([r * np.sin(ang) * 1.15, zc + r * np.cos(ang)], 1)
        base = m0 if i == 0 else m0 * (1 - 0.02 * min(i, 1))
        if i == 1:
            base = m0 + (np.array([0, m0[:, 1].mean()]) - m0) * 0.02
        ring = base * (1 - f) + circ * f
        rings.append(ring)
    R = np.array(rings)
    ns = len(S)
    V = np.zeros((ns, M, 3))
    for i, s in enumerate(S):
        V[i] = to_blender(np.full(M, s), R[i, :, 0], R[i, :, 1])
    V = V.reshape(-1, 3)
    faces = grid_faces(ns, M, wrap_c=True, flip=False)
    uvs = [[((v % M) / M, (v // M) / (ns - 1)) for v in f] for f in faces]
    # end cap (engine face, far away & dark)
    c = len(V)
    V = np.concatenate([V, to_blender([S[-1] + 0.01], [0], [R[-1, :, 1].mean()])])
    for f in cap_fan(list(range((ns - 1) * M, ns * M)), c, flip=False):
        faces.append(f); uvs.append([(0.5, 1.0)] * 3)
    return MeshData(V, faces, uvs, 'intake_duct')


def intake_lip():
    """Rounded lip around the mouth (torus-like sweep)."""
    m = mouth_outline(48)
    P = np.array([(S_LIP + 0.004, y, z) for y, z in m])
    T = path_tangents(P, closed=True)
    cen = np.array([0.0, 0.0, 1.27])
    frames = []
    for p, t in zip(P, T):
        out = np.cross(t, [1.0, 0, 0])          # in-plane normal
        rad = p - np.array([p[0], cen[1], cen[2]])
        if np.dot(out, rad) < 0:
            out = -out
        out /= np.linalg.norm(out)
        frames.append((out, np.array([-1.0, 0, 0])))
    prof = [(0.012 + 0.017 * math.cos(a), 0.017 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 13)[:-1]]
    md = sweep_frames(P, frames, prof, closed_path=True, closed_profile=True, name='intake_lip')
    return md


def intake_hood():
    """Upper lip / splitter extension: a thin curved plate from the mouth top edge forward to s≈4.36."""
    ys = np.linspace(-0.66, 0.66, 23)
    ss = np.linspace(4.36, S_LIP + 0.02, 7)
    top = np.array(MOUTH[:6])
    def zedge(y):
        return float(np.interp(abs(y), top[:, 0], top[:, 1]))
    verts = []
    for s in ss:
        f = (s - 4.36) / (S_LIP + 0.02 - 4.36)
        for y in ys:
            w = 0.66 - 0.10 * (1 - f) ** 2
            yy = y * w / 0.66
            z = zedge(yy) + 0.035 + 0.085 * (1 - f) ** 1.6
            verts.append((s, yy, z))
    ns, ny = len(ss), len(ys)
    V = np.array(verts)
    V2 = V.copy(); V2[:, 2] -= 0.016
    Vall = np.concatenate([V, V2])
    n = len(V)
    faces = grid_faces(ns, ny, flip=True) + [tuple(i + n for i in f) for f in grid_faces(ns, ny)]
    for i in range(ns - 1):
        for j, fl in ((0, True), (ny - 1, False)):
            f = (i * ny + j, (i + 1) * ny + j, n + (i + 1) * ny + j, n + i * ny + j)
            faces.append(f[::-1] if fl else f)
    for j in range(ny - 1):
        f = (j, j + 1, n + j + 1, n + j)
        faces.append(f)
    return MeshData(to_blender(Vall[:, 0], Vall[:, 1], Vall[:, 2]), faces, None, 'intake_hood')


# ---------------------------------------------------------------- pitot + small probes
def pitot_mesh():
    prof = [(0.00, 0.0), (0.005, 0.006), (0.05, 0.0065), (0.06, 0.009), (0.30, 0.012), (0.36, 0.020),
            (0.44, 0.026), (0.50, 0.036)]
    zc = 1.600
    P = np.array(prof)
    return revolve([(s, r) for s, r in P], 16, zc=zc, name='pitot')


# ---------------------------------------------------------------- wingtip launcher + missiles
LAU_Y = 4.678
def launcher_mesh(side='R'):
    S = np.array([8.46, 8.50, 8.62, 8.80, 9.0, 9.4, 10.2, 10.9, 11.05, 11.10])
    def half(s):
        f = smoothstep(8.46, 8.85, s)
        g = 1 - smoothstep(11.0, 11.1, s) * 0.5
        w = (0.012 + 0.058 * f) * g
        zt = WING_Z + 0.02 + 0.07 * f
        zb = WING_Z - 0.02 - 0.08 * f
        return rounded_half(w, zb, zt, r_top=0.5)
    md = tube_loft(S, half, None, name='launcher')
    sign = 1 if side == 'R' else -1
    md.verts[:, 0] = md.verts[:, 0] + sign * LAU_Y
    if side == 'L':
        pass
    return md


def aim9x(s_nose=8.10, y=4.815, z=1.878, side='R'):
    """AIM-9X Sidewinder (3.02 m, 127 mm)."""
    L = 3.02
    R = 0.0635
    prof = [(0.0, 0.0), (0.004, 0.018), (0.02, 0.040), (0.05, 0.056), (0.09, 0.0625), (0.12, R), (L - 0.05, R),
            (L - 0.01, 0.055), (L, 0.045)]
    body = revolve([(s_nose + a, r) for a, r in prof], 24, zc=0.0, name='aim9_body')
    # revolve() centers on NOZ axis param zc; we recenter manually
    V = body.verts.copy()
    V[:, 0] += y
    V[:, 2] += z
    body.verts = V
    parts = [body]
    # tail fins (X configuration): 4 clipped trapezoids near the tail
    def fin(angle, root0, root1, tip0, tip1, span, th=0.006):
        ca, sa = math.cos(angle), math.sin(angle)
        pts = [(root0, R), (root1, R), (tip1, R + span), (tip0, R + span)]
        vs = []
        for d in (-th, th):
            for a, r in pts:
                # radial direction (in y,z): (sin, cos) of angle; thickness offset along tangent
                yy = y + r * sa + d * ca
                zz = z + r * ca - d * sa
                vs.append((s_nose + a, yy, zz))
        Vv = np.array(vs)
        faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        return MeshData(to_blender(Vv[:, 0], Vv[:, 1], Vv[:, 2]), faces, None, 'fin')
    for q in range(4):
        ang = math.radians(45 + 90 * q)
        parts.append(fin(ang, L - 0.42, L - 0.06, L - 0.22, L - 0.10, 0.115))
        parts.append(fin(ang, 0.62, 0.80, 0.70, 0.78, 0.028))     # small forward strakes
    out = parts[0]
    for p in parts[1:]:
        out.add(p)
    out.name = 'aim9x'
    return out


def aim9_dome(s_nose=8.10, y=4.815, z=1.878):
    prof = [(0.0, 0.0), (0.004, 0.018), (0.02, 0.040), (0.05, 0.056), (0.065, 0.0605)]
    d = revolve([(s_nose + a - 0.001, r * 1.01) for a, r in prof], 24, zc=0.0, name='aim9_dome')
    d.verts[:, 0] += y
    d.verts[:, 2] += z
    return d


# ---------------------------------------------------------------- hinge cutters (D-profile prisms) for control surfaces
def hinge_cutter(p0, p1, r0, r1, move_dir, end_normal, extent=0.6, half_h=0.25, n_arc=14, pad=0.0):
    """Closed prism (Blender coords) for cutting a hinged surface.
    p0, p1: hinge axis end points (drawing frame); r0, r1: cove radius at each end.
    move_dir: unit vector (drawing frame) perpendicular to the axis pointing into the moving part (e.g. aft).
    end_normal: normal of the end planes (e.g. (0,1,0) for streamwise ends of a wing surface).
    The moving side region = half-space beyond the axis (toward move_dir) ∪ a cylinder of radius r around the axis."""
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    a = p1 - p0; L = np.linalg.norm(a); a /= L
    d = np.asarray(move_dir, float); d = d - a * np.dot(a, d); d /= np.linalg.norm(d)
    e = np.cross(a, d)
    nrm = np.asarray(end_normal, float)
    ext0, ext1 = p0 - a * pad, p1 + a * pad

    def profile(r):
        pts = [(extent, half_h), (0.0, half_h), (0.0, r)]
        for k in range(1, n_arc):
            th = math.pi / 2 + math.pi * k / n_arc      # around the back (away from move_dir)
            pts.append((r * math.cos(th), r * math.sin(th)))
        pts += [(0.0, -r), (0.0, -half_h), (extent, -half_h)]
        return pts

    rings = []
    for base, r in ((ext0, r0), (ext1, r1)):
        ring = []
        for u, v in profile(r):
            q = base + d * u + e * v
            # slide along the axis direction onto the end plane through `base`
            t = np.dot(nrm, base - q) / np.dot(nrm, a)
            ring.append(q + a * t)
        rings.append(ring)
    R = np.array(rings)
    m = R.shape[1]
    V = to_blender(R[..., 0], R[..., 1], R[..., 2]).reshape(-1, 3)
    faces = [tuple(range(m))[::-1], tuple(range(m, 2 * m))]
    for k in range(m):
        k2 = (k + 1) % m
        faces.append((k, k2, m + k2, m + k))
    return MeshData(V, faces, None, 'cutter')


def wing_half_thickness(y, s):
    le = wing_le(y); c = WING_TE - le
    x = min(max((s - le) / c, 0.0), 1.0)
    from f16_geom import naca64a_thickness
    t = naca64a_thickness(x, 0.04) * c
    zc = WING_Z + 0.011 * 4 * x * (1 - x) * c
    return t, zc


def flaperon_cutter(side='R'):
    sg = 1 if side == 'R' else -1
    y0, y1 = FLAP_Y0, FLAP_Y1
    t0, z0 = wing_half_thickness(y0, flap_hinge(y0))
    t1, z1 = wing_half_thickness(y1, flap_hinge(y1))
    p0 = (flap_hinge(y0), sg * y0, z0)
    p1 = (flap_hinge(y1), sg * y1, z1)
    return hinge_cutter(p0, p1, t0 + 0.004, t1 + 0.003, (1, 0, 0), (0, 1, 0), extent=0.9, half_h=0.2), p0, p1


def lef_cutter(side='R'):
    sg = 1 if side == 'R' else -1
    y0, y1 = LEF_Y0 - 0.004, WING_TIP + 0.05
    t0, z0 = wing_half_thickness(LEF_Y0, lef_hinge(LEF_Y0))
    t1, z1 = wing_half_thickness(WING_TIP, lef_hinge(WING_TIP))
    p0 = (lef_hinge(y0), sg * y0, z0)
    p1 = (lef_hinge(y1), sg * y1, z1)
    return hinge_cutter(p0, p1, t0 + 0.004, t1 + 0.003, (-1, 0, 0), (0, 1, 0), extent=1.0, half_h=0.25), p0, p1


def rudder_cutter():
    z0, z1 = 2.90, 4.995
    def half_t(z):
        s = rudder_hinge(z)
        le, te = fin_le(z), fin_te(z)
        c = te - le; x = (s - le) / c
        from f16_geom import naca64a_thickness
        t = 1.0 - 0.25 * (z - FIN_Z0) / (FIN_TOP - FIN_Z0)
        return naca64a_thickness(x, 0.05) * c * t
    p0 = (rudder_hinge(z0), 0.0, z0)
    p1 = (rudder_hinge(z1), 0.0, z1)
    return hinge_cutter(p0, p1, half_t(z0) + 0.004, half_t(z1) + 0.003, (1, 0, 0), (0, 0, 1), extent=1.2, half_h=0.2), p0, p1


# ---------------------------------------------------------------- small exterior details
def _blade(root_s, root_y, root_z, nrm, height, chord_root, chord_tip, sweep, thick=0.012, name='blade'):
    """Thin swept blade antenna standing on a surface point along its normal (drawing frame)."""
    nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    fwd = np.array([-1.0, 0, 0])
    side = np.cross(nrm, fwd); side /= np.linalg.norm(side)
    fwd = np.cross(side, nrm)
    base = np.array([root_s, root_y, root_z]) - nrm * 0.01
    pts = [base + fwd * chord_root * 0.5, base - fwd * chord_root * 0.5,
           base + nrm * height - fwd * (chord_tip * 0.5 + sweep), base + nrm * height + fwd * (chord_tip * 0.5 - sweep)]
    V = []
    for d in (-thick / 2, thick / 2):
        for p in pts:
            V.append(p + side * d)
    V = np.array(V)
    F = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return MeshData(to_blender(V[:, 0], V[:, 1], V[:, 2]), F, None, name)


def _probe(s, y, z, nrm, length, r0, r1, tilt_fwd=0.6, name='probe'):
    nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    d = nrm * (1 - tilt_fwd) + np.array([-1.0, 0, 0]) * tilt_fwd
    d /= np.linalg.norm(d)
    p0 = np.array([s, y, z]) - nrm * 0.01
    p1 = p0 + d * length
    import f16_gear as G
    a = G.cylinder(to_blender(*p0), to_blender(*p1), r0, r1, n=10)
    base = G.cylinder(to_blender(*(p0 - nrm * 0.005)), to_blender(*(p0 + nrm * 0.015)), 0.028, 0.028, n=14)
    a.add(base)
    return a


def _lens(s, y, z, nrm, r, name='lens'):
    """Small dome lens on the surface (drawing frame)."""
    import f16_gear as G
    nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    c = np.array([s, y, z])
    prof = [(r, -0.004), (r * 0.98, 0.004), (r * 0.8, 0.010), (r * 0.45, 0.015), (0.001, 0.017)]
    return G.revolve_axis(prof, to_blender(*c), np.array([nrm[1], -nrm[0], nrm[2]]), n=16, name=name)


def details():
    out = []
    # AoA probes on both nose sides
    for sg in (1, -1):
        s = 1.64
        y = 0.41 * sg
        z = 1.80
        n = FU.surface_normal(s, abs(y), upper=True)
        n = np.array([n[0], sg * abs(n[1]), n[2]])
        out.append(('aoa_probe_' + ('R' if sg > 0 else 'L'), _probe(s, y, z, n, 0.14, 0.009, 0.005, 0.55), 'metal'))
    # IFF interrogator "bird slicer" blades ahead of the windscreen (Block 50/52 AIFF)
    for k, yy in enumerate((-0.235, -0.085, 0.085, 0.235)):
        s = 2.46
        z = FU.surface_point(s, abs(yy), upper=True)
        n = FU.surface_normal(s, yy, upper=True)
        out.append((f'iff_blade_{k}', _blade(s, yy, z, n, 0.075, 0.05, 0.028, 0.015, 0.007), 'antenna'))
    # UHF blade on the spine and under the belly, TACAN under the nose
    z = FU.surface_point(7.95, 0.0, upper=True)
    out.append(('uhf_top', _blade(7.95, 0.0, z, (0, 0, 1), 0.16, 0.26, 0.10, 0.10, 0.014), 'antenna'))
    zb = FU.surface_point(7.25, 0.0, upper=False)
    out.append(('uhf_bottom', _blade(7.25, 0.0, zb, (0, 0, -1), 0.20, 0.28, 0.10, 0.12, 0.014), 'antenna'))
    zb = FU.surface_point(3.70, 0.0, upper=False)
    out.append(('tacan_bottom', _blade(3.70, 0.0, zb, (0, 0, -1), 0.10, 0.12, 0.06, 0.04, 0.012), 'antenna'))
    # position lights on the intake sides (red left / green right) and the tail light
    for sg, mat in ((1, 'lens_green'), (-1, 'lens_red')):
        s, zz = 5.35, 1.42
        y = 0.795 * sg
        out.append(('navlens_' + ('R' if sg > 0 else 'L'), _lens(s, y, zz, (0, sg, 0), 0.035), mat))
    out.append(('taillens', _lens(15.058, 0.0, 5.09, (1, 0, 0), 0.03), 'lens_white'))
    out.append(('strobelens', _lens(14.45, 0.0, 5.182, (0, 0, 1), 0.035), 'lens_white'))
    # M61 gun port on the left LEX root: dark recess disc following the surface
    s, y = 5.62, -0.60
    z = FU.surface_point(s, abs(y), upper=True)
    n = FU.surface_normal(s, y, upper=True)
    import f16_gear as G
    c = np.array([s, y, z]) + np.asarray(n) * 0.002
    port = G.revolve_axis([(0.06, 0.0), (0.045, 0.003), (0.001, 0.003)], to_blender(*c), np.array([n[1], -n[0], n[2]]), n=20, name='gunport')
    out.append(('gun_port', port, 'dark'))
    return out


def aim9_bands(s_nose=8.10, y=4.815, z=1.878):
    """Thin colour bands (warhead yellow, motor brown) slightly proud of the body."""
    out = []
    for a0, a1, key in ((0.78, 0.83, 'band_yellow'), (1.30, 1.35, 'band_brown')):
        b = revolve([(s_nose + a0, 0.0637), (s_nose + a0 + 0.002, 0.0645), (s_nose + a1 - 0.002, 0.0645), (s_nose + a1, 0.0637)], 24, zc=0.0, name=key)
        b.verts[:, 0] += y
        b.verts[:, 2] += z
        out.append((key, b))
    return out
