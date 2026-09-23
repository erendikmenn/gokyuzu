"""Fuselage skin (lofted from the digitized Airbus profiles), cockpit window cut-outs + glass, belly fairing,
tail cone APU exhaust."""
import math
import numpy as np
import bpy
import geo
import layout as LY

M_AROUND = 128


def station_grid():
    D = geo.DETAIL
    s = np.r_[
        0.006, 0.02, 0.045, 0.08, 0.12, 0.17, 0.23, 0.30,
        np.arange(0.38, 1.2, 0.07 / D),
        np.arange(1.2, 3.6, 0.05 / D),
        np.arange(3.6, 6.4, 0.10 / D),
        np.arange(6.4, 26.0, 0.32 / D),
        np.arange(26.0, 37.2, 0.14 / D),
        [4.40, 37.28, 37.36, 37.43, LY.S_END],
    ]
    return np.unique(np.round(s, 4))


def theta_grid(M=None):
    M = M or max(24, 4 * int(round(M_AROUND * geo.DETAIL / 4)))
    return np.linspace(0, 2 * math.pi, M, endpoint=False)


def skin_points(s_arr, th):
    S, T = np.meshgrid(s_arr, th, indexing='ij')
    y, z = LY.surface(S, T)
    P = np.stack([y, geo.S_CG - S, z], -1)
    return P


def build_skin(s_lo, s_hi, name, col, mat, pole=False):
    s_all = station_grid()
    s_arr = s_all[(s_all >= s_lo - 1e-9) & (s_all <= s_hi + 1e-9)]
    th = theta_grid()
    P = skin_points(s_arr, th)
    N, M, _ = P.shape
    verts = P.reshape(-1, 3).tolist()
    faces, luv = [], []
    u = s_arr / LY.L_FUS
    v = np.linspace(0, 1, M + 1)
    for i in range(N - 1):
        for j in range(M):
            j2 = (j + 1) % M
            a, b, c, d = i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j
            faces.append((a, b, c, d))
            luv += [(u[i], v[j]), (u[i], v[j + 1]), (u[i + 1], v[j + 1]), (u[i + 1], v[j])]
    if pole:
        top, bot, hw = LY.prof(0.0)
        tip = [0.0, geo.S_CG - 0.0, float(0.5 * (top + bot))]
        pi = len(verts)
        verts.append(tip)
        for j in range(M):
            j2 = (j + 1) % M
            faces.append((pi, j2, j))
            luv += [(0.0, (v[j] + v[j + 1]) / 2), (u[0], v[j + 1]), (u[0], v[j])]
    obj = geo.mesh_object(name, np.array(verts), faces, col=col, mat=mat, loop_uvs=np.array(luv))
    geo.orient_outward(obj, P)
    return obj


def window_cutter(name, params, col, depth=0.12, expand=0.0, samples=24):
    """Closed prism around a window polygon given in (s, th) parameter space."""
    pts = []
    n = len(params)
    for k in range(n):
        s0, t0 = params[k]
        s1, t1 = params[(k + 1) % n]
        for t in np.linspace(0, 1, samples, endpoint=False):
            pts.append((s0 + (s1 - s0) * t, t0 + (t1 - t0) * t))
    pts = np.array(pts)
    if expand:
        c = pts.mean(0)
        d = pts - c
        # expand in metric-ish units: s in meters, th scaled by local radius
        pts = c + d * (1 + expand)
    y, z = LY.surface(pts[:, 0], pts[:, 1])
    P = np.stack([y, geo.S_CG - pts[:, 0], z], -1)
    Nrm = LY.normal(pts[:, 0], pts[:, 1])
    outer = P + Nrm * depth
    inner = P - Nrm * depth
    m = len(P)
    verts = np.vstack([outer, inner, outer.mean(0, keepdims=True), inner.mean(0, keepdims=True)])
    co, ci = 2 * m, 2 * m + 1
    faces = []
    for k in range(m):
        k2 = (k + 1) % m
        faces.append((k, k2, m + k2, m + k))
        faces.append((co, k2, k))
        faces.append((ci, m + k, m + k2))
    o = geo.mesh_object(name, verts, faces, col=col, smooth=False)
    # make normals consistent/outward
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def window_pane(name, params, col, mat, inset=0.012, grow=0.018, nu=10, nv=10):
    """Glass pane following the fuselage surface, slightly inside the skin, a little larger than the hole."""
    q = np.array(params, float)
    if len(q) != 4:
        raise ValueError('pane needs 4 corners')
    c = q.mean(0)
    # grow the quad in parameter space (convert th to meters with the local radius ~1.5 m)
    scale = np.array([1.0, 1.0 / 1.5])
    d = (q - c) / scale
    dn = d / np.linalg.norm(d, axis=1, keepdims=True)
    q = c + (d + dn * grow) * scale
    uu, vv = np.meshgrid(np.linspace(0, 1, nu), np.linspace(0, 1, nv), indexing='ij')
    # bilinear: corners 0,1,2,3 in order
    p = ((1 - uu)[..., None] * (1 - vv)[..., None] * q[0] + uu[..., None] * (1 - vv)[..., None] * q[1]
         + uu[..., None] * vv[..., None] * q[2] + (1 - uu)[..., None] * vv[..., None] * q[3])
    y, z = LY.surface(p[..., 0], p[..., 1])
    P = np.stack([y, geo.S_CG - p[..., 0], z], -1)
    Nrm = LY.normal(p[..., 0], p[..., 1])
    P = P - Nrm * inset
    verts = P.reshape(-1, 3)
    faces, luv = [], []
    for i in range(nu - 1):
        for j in range(nv - 1):
            a, b, cc, d_ = i * nv + j, (i + 1) * nv + j, (i + 1) * nv + j + 1, i * nv + j + 1
            faces.append((a, b, cc, d_))
            luv += [(uu[i, j], vv[i, j]), (uu[i + 1, j], vv[i + 1, j]), (uu[i + 1, j + 1], vv[i + 1, j + 1]), (uu[i, j + 1], vv[i, j + 1])]
    o = geo.mesh_object(name, verts, faces, col=col, mat=mat, loop_uvs=np.array(luv))
    # orient outward: compare with surface normal
    o.data.update()
    nrm = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nrm)
    if np.einsum('ij,ij->i', nrm.reshape(-1, 3), Nrm[:-1, :-1].reshape(-1, 3)).sum() < 0:
        geo.flip_normals(o)
    return o


def build(col, mat_skin, mat_glass, cut_windows=True):
    S_SPLIT = 4.40
    nose = build_skin(0.0, S_SPLIT, 'fus_nose', col, mat_skin, pole=True)
    body = build_skin(S_SPLIT, LY.S_END, 'fus_body', col, mat_skin)
    panes = []
    if cut_windows:
        cutters = []
        for side in (1, -1):
            for wname in ('ws', 'slide', 'fixed'):
                prm = LY.ck_window_params(wname, side)
                if side < 0:
                    prm = prm[::-1]
                cutters.append(window_cutter(f'cut_{wname}_{side}', prm, col))
                pp = LY.ck_window_params(wname, side)
                if side < 0:
                    pp = [pp[1], pp[0], pp[3], pp[2]]
                panes.append(window_pane(f'glass_{wname}_{"R" if side > 0 else "L"}', pp, col, mat_glass))
        cut = geo.join(cutters, 'cutters')
        geo.boolean(nose, cut, 'DIFFERENCE', 'EXACT')
        bpy.data.objects.remove(cut, do_unlink=True)
    skin = geo.join([nose, body], 'fuselage')
    # weld the split seam
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(skin.data)
    bm.free()
    skin.data.polygons.foreach_set('use_smooth', np.ones(len(skin.data.polygons), dtype=bool))
    skin.data.update()
    glass = geo.join(panes, 'cockpit_glass') if panes else None
    return skin, glass


# ------------------------------------------------------------------------------------------------ belly fairing

BF_S0, BF_S1 = 10.6, 23.9
BF_N = 40


def bf_n():
    return geo.NS(BF_N, 12)


def _bf_env(s):
    t = (np.asarray(s, float) - BF_S0) / (BF_S1 - BF_S0)
    return geo.smoothstep(0.0, 0.22, t) * (1 - geo.smoothstep(0.62, 1.0, t))


def belly_half(s):
    """Half cross-section of the belly fairing at station s: (y, z) from the upper join to the bottom centre."""
    top, bot, hw = LY.prof(s)
    ek = float(_bf_env(s))
    wmax = hw + 0.24 * ek                 # max half width (~2.2 m at the wing root, AC front view)
    zb = -2.07 - 0.13 * ek                # flat bottom ~0.13 m below the fuselage
    zj = -0.62                            # upper join on the fuselage side
    th_j = math.acos(np.clip(zj / 2.07, -1, 1))
    yj = float(LY.surface(s, th_j)[0]) - 0.03
    pts = []
    n_ = bf_n()
    for u in np.linspace(0, 1, n_):
        if u < 0.5:
            a = u / 0.5 * (math.pi / 2)
            y = yj + (wmax - yj) * math.sin(a)
            z = zj - (zj + 1.35) * (1 - math.cos(a))
        else:
            a = (u - 0.5) / 0.5 * (math.pi / 2)
            y = wmax * math.cos(a) ** 0.55
            z = -1.35 + (zb + 1.35) * math.sin(a)
        pts.append((y, z))
    pts = np.array(pts)
    th = np.linspace(th_j, math.pi, n_)
    fy, fz = LY.surface(np.full(n_, s), th)
    zc = 0.5 * (top + bot)
    fy = fy * 0.985                                # fallback shape just inside the skin (ends dive under it)
    fz = zc + (fz - zc) * 0.985
    y = fy + (pts[:, 0] - fy) * ek
    z = fz + (pts[:, 1] - fz) * ek
    return y, z


def belly_z(s, y):
    """Lower surface height of the belly fairing at (s, |y|) (bottom branch)."""
    yy, zz = belly_half(s)
    k = int(np.argmax(yy))
    yb, zb = yy[k:][::-1], zz[k:][::-1]          # increasing y
    return float(np.interp(abs(y), yb, zb))


def belly_fairing(col, mat):
    """Ventral wing-to-body fairing: flat-bottomed, wider than the fuselage at the wing root (AC front view:
    half width ~2.2 m, bottom ~0.13 m below the fuselage), blending into the skin fore and aft."""
    ss = np.linspace(BF_S0, BF_S1, geo.NS(72, 16))
    rings = []
    for s in ss:
        y, z = belly_half(s)
        half = np.stack([y, z], 1)
        full = np.vstack([half, half[-2::-1] * [-1, 1]])
        rings.append(np.stack([full[:, 0], np.full(len(full), geo.S_CG - s), full[:, 1]], 1))
    P = np.array(rings)
    o = geo.grid_mesh('belly_fairing', P, closed=False, col=col, mat=mat, auto_orient=False)
    o.data.update()
    nz = np.zeros(len(o.data.polygons) * 3)
    o.data.polygons.foreach_get('normal', nz)
    nz = nz.reshape(-1, 3)
    if (nz[:, 2] < 0).sum() < (nz[:, 2] > 0).sum():
        geo.flip_normals(o)
    return o


def apu_exhaust(col, mat_dark, mat_metal):
    s = LY.S_END
    top, bot, hw = LY.prof(s)
    zc = 0.5 * (top + bot)
    a = 0.5 * (top - bot)
    prof = [(0.0, 1.0), (-0.25, 0.9), (-0.5, 0.8)]
    th = np.linspace(0, 2 * math.pi, 32, endpoint=False)
    rings = []
    for t, k in prof:
        ss = s + t   # t negative -> forward (inside)
        ring = np.stack([hw * k * np.sin(th) * 0.97, np.full_like(th, geo.S_CG - ss), zc + a * k * np.cos(th) * 0.97], 1)
        rings.append(ring)
    P = np.array(rings)
    tube = geo.grid_mesh('apu_exhaust', P, closed=True, col=col, mat=mat_metal, cap1=True, auto_orient=False)
    geo.flip_normals(tube)   # visible from inside the opening
    return tube


def param_of_points(co):
    """Inverse of layout.surface for points on (or very near) the skin: returns (s, theta)."""
    s = geo.S_CG - co[:, 1]
    zc, a_up, a_dn, hw, n_up, n_dn = LY.section_params(s)
    y = co[:, 0]
    dz = co[:, 2] - zc
    up = dz >= 0
    n = np.where(up, n_up, n_dn)
    a = np.where(up, a_up, a_dn)
    sn = np.sign(y) * np.abs(np.clip(y / np.maximum(hw, 1e-6), -1, 1)) ** (n / 2)
    cs = np.sign(dz) * np.abs(np.clip(dz / np.maximum(a, 1e-6), -1, 1)) ** (n / 2)
    th = np.mod(np.arctan2(sn, cs), 2 * math.pi)
    return s, th


def fuselage_uv(obj):
    """Recompute the skin UVs analytically after booleans (u = s / L, v = theta / 2pi, seam-safe per face)."""
    me = obj.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(obj.matrix_world)
    co = co @ M[:3, :3].T + M[:3, 3]
    s, th = param_of_points(co)
    u = s / LY.L_FUS
    v = th / (2 * math.pi)
    li = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', li)
    ls = np.zeros(len(me.polygons), dtype=np.int32)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_start', ls)
    me.polygons.foreach_get('loop_total', lt)
    uv = np.stack([u[li], v[li]], 1)
    # seam: faces with loops on both sides of v = 0/1 -> lift the small ones by +1
    for f in range(len(ls)):
        a, n = ls[f], lt[f]
        vv = uv[a:a + n, 1]
        if vv.max() - vv.min() > 0.5:
            vv[vv < 0.5] += 1.0
            uv[a:a + n, 1] = vv
    # nose pole: the tip vertex has undefined theta -> use the face's mean v
    tip = s < 0.004
    if tip.any():
        for f in range(len(ls)):
            a, n = ls[f], lt[f]
            idx = li[a:a + n]
            if tip[idx].any():
                others = uv[a:a + n, 1][~tip[idx]]
                if len(others):
                    uv[a:a + n, 1][tip[idx]] = others.mean()
    me.uv_layers[0].data.foreach_set('uv', uv.astype(np.float32).ravel())


def _offset_polygon(P, d):
    """Outward offset of a convex polygon P (n,2) by d (counter-clockwise or clockwise handled)."""
    n = len(P)
    area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    sgn = 1.0 if area > 0 else -1.0
    lines = []
    for k in range(n):
        a, b = P[k], P[(k + 1) % n]
        e = (b - a) / np.linalg.norm(b - a)
        nrm = np.array([e[1], -e[0]]) * sgn          # outward normal
        lines.append((a + nrm * d, e))
    out = []
    for k in range(n):
        (p1, e1), (p2, e2) = lines[k - 1], lines[k]
        A = np.array([e1, -e2]).T
        t = np.linalg.solve(A, p2 - p1)
        out.append(p1 + e1 * t[0])
    return np.array(out)


def window_frames(col, mat, width=0.055, lift=0.0025, samples=18):
    """Dark painted frame rings around the cockpit openings as real geometry (crisp at any distance)."""
    rings = []
    for side in (1, -1):
        for wn in ('ws', 'slide', 'fixed'):
            prm = np.array(LY.ck_window_params(wn, side))
            R = float(np.mean([np.hypot(*LY.surface(s, t)) for s, t in prm]))
            Q = np.stack([prm[:, 0], prm[:, 1] * R], 1)
            Qo = _offset_polygon(Q, width)
            outer = np.stack([Qo[:, 0], Qo[:, 1] / R], 1)
            inner_d, outer_d = [], []
            n = len(prm)
            for k in range(n):
                for t in np.linspace(0, 1, samples, endpoint=False):
                    inner_d.append(prm[k] + (prm[(k + 1) % n] - prm[k]) * t)
                    outer_d.append(outer[k] + (outer[(k + 1) % n] - outer[k]) * t)
            inner_d, outer_d = np.array(inner_d), np.array(outer_d)
            pts = []
            for arr in (inner_d, outer_d):
                y, z = LY.surface(arr[:, 0], arr[:, 1])
                Nn = LY.normal(arr[:, 0], arr[:, 1])
                pts.append(np.stack([y, geo.S_CG - arr[:, 0], z], 1) + Nn * lift)
            m = len(inner_d)
            verts = np.vstack(pts)
            faces = [(k, (k + 1) % m, m + (k + 1) % m, m + k) for k in range(m)]
            luv = []
            for _ in faces:
                luv += [(0, 0), (1, 0), (1, 1), (0, 1)]
            o = geo.mesh_object('wframe', verts, faces, col=col, mat=mat, loop_uvs=np.array(luv))
            # face outward
            o.data.update()
            nrm = np.zeros(len(o.data.polygons) * 3)
            o.data.polygons.foreach_get('normal', nrm)
            c = verts.mean(0)
            Nc = LY.normal(np.array([prm[:, 0].mean()]), np.array([prm[:, 1].mean()]))[0]
            if np.dot(nrm.reshape(-1, 3).sum(0), Nc) < 0:
                geo.flip_normals(o)
            rings.append(o)
    return geo.join(rings, 'cockpit_frames')
