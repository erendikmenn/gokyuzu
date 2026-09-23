"""F-22A fuselage meshes (Blender): upper skin, forebody / keel, nacelles, intake ducts, aft bulkhead.

The parts overlap where they meet (hidden inside) instead of being stitched: the upper skin and the nacelle outer walls
share the chine line exactly (welded), the forebody lower skin and the upper skin share the forebody chine (welded),
the ducts start on the lip loop (welded).  Everything else intersects cleanly inside the volume.
"""
import math
import numpy as np
try:
    import bmesh
    from mathutils import Vector
except ImportError:     # plain python (texture scripts)
    bmesh = Vector = None

import geom as G
from geom import Y, lerp, smoothstep
import oml as O

M_SKIN, M_DARK, M_HOT, M_BAY, M_DUCT = 0, 1, 2, 3, 4


def _grid(bm, rows, mirror=False, mat=M_SKIN, closed_v=False):
    A = np.asarray(rows, float)
    if mirror:
        A = A.copy()
        A[..., 0] *= -1
    return G.bm_grid(bm, A, flip=mirror, mat=mat, closed_v=closed_v)


def _orient(bm, ref, faces=None):
    G.orient_faces(bm, lambda c: ref(c), faces)


# ------------------------------------------------------------------------------------------------ upper skin
def upper_skin_rows(stations):
    return [[(p[0], Y(s), p[1]) for p in O.upper_profile(s)] for s in stations]


def fore_lower_rows(stations):
    return [[(p[0], Y(s), p[1]) for p in O.fore_lower_profile(s)] for s in stations]


def nacelle_rows():
    rows = []
    ks = O.nac_rows()
    nc = O.nac_ncols()
    for k, s0 in enumerate(ks):
        row = []
        for j in range(nc):
            if k == 0:
                p = O.nac_lip_point(j)
                row.append((p[0], Y(p[1]), p[2]))
            else:
                s = O.nac_station(s0, j)
                q = O.nac_profile_point(s, j)
                row.append((q[0], Y(s), q[1]))
        rows.append(row)
    return rows


def lip_loop(stations):
    """Closed lip loop TI -> (top edge along the chine) -> TO -> BO -> BI -> TI (right side), world coords."""
    top = [(O.x_chine(s), Y(s), O.z_chine(s)) for s in stations if O.S_TI - 1e-6 <= s <= O.S_TO + 1e-6]
    nac = [O.nac_lip_point(j) for j in range(O.nac_ncols())]
    nac = [(p[0], Y(p[1]), p[2]) for p in nac]
    loop = top + nac[1:-1]            # TO is the last top point, TI the first
    return np.array(loop)


def build_fuselage():
    """Returns bmesh (right + left) of upper skin, forebody lower skin, nacelle outer skins."""
    nr = O.nac_rows()
    st = O.fuselage_stations(nr)
    bm = bmesh.new()
    up = upper_skin_rows(st)
    fst = [s for s in st if s <= O.S_NAC_MERGE + 0.05]
    lo = fore_lower_rows(fst)
    na = nacelle_rows()
    for mir in (False, True):
        _grid(bm, up, mir)
        _grid(bm, lo, not mir)
        _grid(bm, na, not mir)
    G.weld(bm, 1.5e-4)

    def ref(c):
        s = Y(0) - c.y
        sc = min(max(s, 0.0), O.S_END)
        ax, z = abs(c.x), c.z
        xc, zc = O.x_chine(sc), O.z_chine(sc)
        # gap roof (horizontal strip beside the forebody chine, facing down)
        xf, zf = O.x_ch_fore(sc), O.z_ch_fore(sc)
        if O.S_TI - 0.35 < s < 7.6 and abs(z - zf) < 0.012 and xf - 0.004 < ax < xf + O.GAP + 0.004:
            return Vector((0, 0, -1))
        if z >= zc - 0.004 and (ax < xc + 0.004):
            # upper skin: away from a point below the crown
            return Vector((c.x, 0, z - (zc - 0.35)))
        if s > O.S_TO - 0.1 and ax > O.nac_inner_top(sc)[0] - 0.02 and s > O.S_TI:
            # nacelle U: away from its core
            ti = O.nac_inner_top(sc)
            n = O.nac_corner_out(sc)
            core_x = 0.5 * (xc + ti[0])
            core_z = 0.5 * (zc + n[1])
            return Vector((math.copysign(ax - core_x, c.x), 0, z - core_z))
        # forebody lower: away from the forebody core
        zb = O.z_bot_fore(sc)
        return Vector((c.x, 0, z - 0.5 * (zf + zb) - 0.1))
    _orient(bm, ref)
    return bm, st


def build_ducts(stations):
    """Intake ducts (S-shaped, lip loop -> engine face) + engine faces (dark). Faces point into the duct."""
    bm = bmesh.new()
    loop = lip_loop(stations)
    n = 56
    ts = G.arc_params(np.vstack([loop, loop[:1]]))[:-1]
    # resample the closed loop by arc length
    closed = np.vstack([loop, loop[:1]])
    ring0 = G.resample_polyline(closed, n + 1)[:-1]
    cen = ring0.mean(axis=0)
    ef_c = np.array([0.60, Y(10.3), -0.30])
    R = 0.47
    # engine-face ring phased to the lip loop by angle around the centroid (in the x-z plane)
    ang = np.arctan2(ring0[:, 2] - cen[2], ring0[:, 0] - cen[0])
    ring_e = np.stack([ef_c[0] + R * np.cos(ang), np.full(n, ef_c[1]), ef_c[2] + R * np.sin(ang)], 1)
    rows = [ring0]
    lip_in = ring0 + (cen - ring0) * 0.028
    lip_in[:, 1] = ring0[:, 1] - 0.035
    rows.append(lip_in)
    steps = 18
    for k in range(1, steps + 1):
        t = k / steps
        tt = t * t * (3 - 2 * t)
        # stations: each point moves from its lip station to the engine face
        r = lip_in + (ring_e - lip_in) * tt
        # serpentine: bulge outward/down in the middle so the engine face is hidden from the front
        r[:, 0] += 0.10 * math.sin(math.pi * t) ** 1.3
        r[:, 2] += -0.05 * math.sin(math.pi * t) ** 1.3
        rows.append(r)
    D = np.array(rows)
    for mir in (False, True):
        A = D.copy()
        if mir:
            A[..., 0] *= -1
        G.bm_grid(bm, A, closed_v=True, flip=mir, mat=M_DUCT)
        ec = A[-1].mean(axis=0)
        G.bm_fan(bm, ec, list(A[-1]) + [A[-1][0]], mat=M_DARK)
    G.weld(bm, 1e-5)

    def ref(c):
        s = Y(0) - c.y
        sgn = 1 if c.x > 0 else -1
        t = min(1.0, max(0.0, (s - 5.4) / (10.3 - 5.4)))
        ax = cen + (ef_c - cen) * t
        return Vector((sgn * ax[0] - c.x, 0, ax[2] - c.z))
    _orient(bm, ref, [f for f in bm.faces if f.material_index == M_DUCT])
    for f in bm.faces:
        if f.material_index == M_DARK:
            f.normal_update()
            if f.normal.y < 0:          # face forward (+Y = nose)
                f.normal_flip()
    return bm
