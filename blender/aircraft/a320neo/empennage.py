"""Horizontal stabilizer + elevators, fin + rudder (from the AC side view and planform, digitized).

HT: LE(y) = 32.11 + 0.7235 (y - 1.35), TE(y) = 35.70 + 0.22 (y - 1.34), semi-span 6.225, dihedral 6.5 deg,
    chord plane z = +0.95 at y = 1.35.   Elevator hinge ~0.70c (root) -> 0.62c (tip).
Fin: LE straight part slope 0.731 (36 deg) from (31.46, z 3.36) to (34.64, 7.71), tip z 8.10 (LE 34.97, TE 36.76),
     TE slope 0.217, rudder hinge (33.77, 2.38) -> (36.15, 8.10), dorsal fillet from s 28.8.
"""
import math
import numpy as np
import geo
import layout as LY


def sym_airfoil(x, tc):
    x = np.clip(np.asarray(x, float), 0, 1)
    t = 5 * tc * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4) + 0.0010 * x
    return t


XG = np.unique(np.round(np.r_[0.0, 0.003, 0.008, 0.016, 0.03, 0.05, 0.075, 0.10, 0.14, np.linspace(0.18, 0.56, 9),
                              0.60, 0.62, 0.64, 0.66, 0.68, 0.70, 0.72, 0.75, 0.79, 0.83, 0.87, 0.91, 0.95, 0.98, 1.0], 5))


def xs_between(a, b, n=22):
    """Fixed-count samples between chord fractions a and b (denser at the LE when a == 0)."""
    t = np.linspace(0, 1, geo.NS(n, 7))
    if a <= 1e-6:
        w = t ** 1.8                      # cluster near the leading edge
    else:
        w = 0.5 * (1 - np.cos(np.pi * t))
    return a + (b - a) * w


# ------------------------------------------------------------------------------------------------ HT
HT = dict(y0=0.70, y_root=1.35, y_tip=6.225, dih=math.radians(6.5), z_root=0.95)


def ht_frame(y):
    le = 32.11 + 0.7235 * (y - 1.35)
    te = 35.70 + 0.22 * (y - 1.34)
    # rounded tip: pull the LE back over the last 0.25 m
    if y > HT['y_tip'] - 0.25:
        k = (y - (HT['y_tip'] - 0.25)) / 0.25
        le += 0.30 * (1 - math.sqrt(max(0.0, 1 - k * k)))
    c = te - le
    z = HT['z_root'] + (y - HT['y_root']) * math.tan(HT['dih'])
    tc = float(np.interp(y, [0, 1.35, 6.225], [0.115, 0.11, 0.085]))
    xh = float(np.interp(y, [1.35, 6.225], [0.70, 0.62]))
    return dict(y=y, le=le, c=c, z=z, tc=tc, xh=xh, tw=math.radians(-1.0))


def ht_pt(fr, x, zn):
    s = fr['le'] + x * fr['c']
    dz = zn * fr['c'] + (0.25 - x) * fr['c'] * math.sin(fr['tw'])
    return np.array([fr['y'] - math.sin(HT['dih']) * dz, geo.S_CG - s, fr['z'] + dz * math.cos(HT['dih'])])


def ht_section(fr, x0, x1, nose_back=False, nose_front=False):
    tc = fr['tc']
    xs = xs_between(x0, x1)
    pts = [ht_pt(fr, x, sym_airfoil(x, tc)) for x in xs[::-1]]
    if x0 > 0:
        t0 = sym_airfoil(x0, tc)
        for a in np.linspace(0, math.pi, 9)[1:-1]:
            pts.append(ht_pt(fr, x0 - (0.018 if nose_front else -0.012) * math.sin(a), t0 * math.cos(a)))
    lo = xs[1:] if x0 == 0 else xs
    pts += [ht_pt(fr, x, -sym_airfoil(x, tc)) for x in lo]
    if x1 < 1:
        t1 = sym_airfoil(x1, tc)
        for a in np.linspace(0, math.pi, 7)[1:-1]:
            pts.append(ht_pt(fr, x1 - 0.006 * math.sin(a), -t1 * math.cos(a)))
    return np.array(pts)


def ht_uv(obj):
    """Planform projection: upper faces -> v [0.5,1], lower -> [0,0.5]; u from span."""
    me = obj.data
    me.update()
    uvl = me.uv_layers[0]
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    M = np.array(obj.matrix_world)
    co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    nrm = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    nrm = nrm.reshape(-1, 3) @ M[:3, :3].T
    li = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', li)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_total', lt)
    up = np.repeat(nrm[:, 2] >= 0, lt)
    p = co[li]
    u = (np.abs(p[:, 0]) - 0.6) / 6.0
    vv = ((geo.S_CG - p[:, 1]) - 31.6) / 5.6
    v = np.where(up, 0.5 + 0.5 * vv, 0.5 * (1 - vv))
    uvl.data.foreach_set('uv', np.stack([u, v], 1).astype(np.float32).ravel())


def build_ht(col, mats):
    ys = np.r_[np.linspace(HT['y0'], 1.45, 3), np.linspace(1.45, 6.0, geo.NS(12, 4))[1:], np.linspace(6.0, HT['y_tip'], geo.NS(5, 3))[1:]]
    # stabilizer (fixed part: 0 -> hinge)
    secs = []
    for y in ys:
        fr = ht_frame(y)
        secs.append(ht_section(fr, 0.0, fr['xh']))
    stab = geo.grid_mesh('htail_R', np.array(secs), closed=True, col=col, mat=mats['htail'], cap0=True, cap1=True)
    ht_uv(stab)
    # elevator
    ye = np.linspace(1.45, 6.05, geo.NS(12, 4))
    secs = []
    for y in ye:
        fr = ht_frame(y)
        secs.append(ht_section(fr, fr['xh'] + 0.004, 1.0, nose_front=True))
    elev = geo.grid_mesh('ctl_elevator_R', np.array(secs), closed=True, col=col, mat=mats['htail'], cap0=True,
                         cap1=True, sharp_cols=(0,))
    ht_uv(elev)
    fa, fb = ht_frame(ye[0]), ht_frame(ye[-1])
    p0, p1 = ht_pt(fa, fa['xh'], 0.0), ht_pt(fb, fb['xh'], 0.0)
    geo.set_origin(elev, (p0 + p1) / 2, geo.hinge_frame(p0, p1))
    return stab, elev


# ------------------------------------------------------------------------------------------------ fin
FIN = dict(z0=1.40, z_tip=8.10)


from empennage_layout import fin_le, fin_te, fin_hinge  # noqa: E402


def fin_tc(z):
    base = float(np.interp(z, [1.4, 2.4, 8.1], [0.125, 0.115, 0.09]))
    return base


def fin_frame(z):
    le = fin_le(z)
    te = fin_te(z)
    c = te - le
    # the dorsal fillet section is thin in absolute terms: limit thickness to ~0.30 m there
    tc = fin_tc(z)
    tmax = 0.30 if z < 3.0 else 1.0
    tc = min(tc, tmax / c * 0.95)
    xh = (fin_hinge(z) - le) / c
    return dict(z=z, le=le, c=c, tc=tc, xh=xh)


def fin_pt(fr, x, yn):
    return np.array([yn * fr['c'], geo.S_CG - (fr['le'] + x * fr['c']), fr['z']])


def fin_section(fr, x0, x1, nose_front=False):
    tc = fr['tc']
    xs = xs_between(x0, x1)
    pts = [fin_pt(fr, x, sym_airfoil(x, tc)) for x in xs[::-1]]
    if x0 > 0:
        t0 = sym_airfoil(x0, tc)
        for a in np.linspace(0, math.pi, 9)[1:-1]:
            pts.append(fin_pt(fr, x0 - (0.02 if nose_front else -0.01) * math.sin(a), t0 * math.cos(a)))
    lo = xs[1:] if x0 == 0 else xs
    pts += [fin_pt(fr, x, -sym_airfoil(x, tc)) for x in lo]
    if x1 < 1:
        t1 = sym_airfoil(x1, tc)
        for a in np.linspace(0, math.pi, 7)[1:-1]:
            pts.append(fin_pt(fr, x1 - 0.006 * math.sin(a), -t1 * math.cos(a)))
    return np.array(pts)


def fin_uv(obj):
    """Side projection. Right face (+X) -> u in [0, 0.39]; left face -> [0.40, 0.79] (mirrored so both read
    nose-left/nose-right correctly in the texture). v = (z - 1.4) / 7.0."""
    me = obj.data
    me.update()
    uvl = me.uv_layers[0]
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    M = np.array(obj.matrix_world)
    co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    nrm = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    nrm = nrm.reshape(-1, 3) @ M[:3, :3].T
    li = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', li)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_total', lt)
    right = np.repeat(nrm[:, 0] >= 0, lt)
    p = co[li]
    s = geo.S_CG - p[:, 1]
    su = (s - 27.8) / 9.4                  # 0..1 over s 27.8 .. 37.2
    v = (p[:, 2] - 1.4) / 7.0
    u = np.where(right, 0.39 * (1 - su), 0.40 + 0.39 * su)   # right face: nose to the right in the texture
    uvl.data.foreach_set('uv', np.stack([u, v], 1).astype(np.float32).ravel())


def build_fin(col, mats):
    zs = np.r_[np.linspace(FIN['z0'], 3.36, geo.NS(9, 4)), np.linspace(3.36, 7.85, geo.NS(14, 4))[1:], np.linspace(7.85, FIN['z_tip'], geo.NS(6, 3))[1:]]
    secs = []
    for z in zs:
        fr = fin_frame(z)
        x1 = fr['xh'] if z >= 2.38 else 1.0
        secs.append(fin_section(fr, 0.0, x1))
    # fixed fin: sections change topology at z = 2.38 (rudder bottom) -> build two lofts
    lower = [fin_section(fin_frame(z), 0.0, 1.0) for z in zs[zs <= 2.38 + 1e-6]] + [fin_section(fin_frame(2.38), 0.0, 1.0)]
    upper = [fin_section(fin_frame(z), 0.0, fin_frame(z)['xh']) for z in np.r_[2.38, zs[zs > 2.38]]]
    a = geo.grid_mesh('fin_a', np.array(lower), closed=True, col=col, mat=mats['tail'], cap0=True, cap1=True,
                      sharp_cols=(0,))
    b = geo.grid_mesh('fin_b', np.array(upper), closed=True, col=col, mat=mats['tail'], cap0=False, cap1=True)
    fin = geo.join([a, b], 'fin')
    fin_uv(fin)
    zr = np.linspace(2.42, 8.02, geo.NS(16, 5))
    rsecs = [fin_section(fin_frame(z), fin_frame(z)['xh'] + 0.004, 1.0, nose_front=True) for z in zr]
    rud = geo.grid_mesh('ctl_rudder', np.array(rsecs), closed=True, col=col, mat=mats['tail'], cap0=True, cap1=True,
                        sharp_cols=(0,))
    fin_uv(rud)
    p0 = np.array([0.0, geo.S_CG - fin_hinge(zr[0]), zr[0]])
    p1 = np.array([0.0, geo.S_CG - fin_hinge(zr[-1]), zr[-1]])
    # rudder frame: local Z along the hinge (up), local Y forward
    from mathutils import Vector, Matrix
    zax = Vector(p1 - p0).normalized()
    yax = Vector((0, 1, 0))
    xax = yax.cross(zax).normalized()
    yax = zax.cross(xax).normalized()
    R = Matrix((xax, yax, zax)).transposed()
    geo.set_origin(rud, (p0 + p1) / 2, R)
    return fin, rud


def build(col, mats):
    stab_R, elev_R = build_ht(col, mats)
    import wing as WG
    stab_L = WG.mirror_with_pivot(stab_R, 'htail_L')
    elev_L = WG.mirror_with_pivot(elev_R, 'ctl_elevator_L')
    ht_uv(stab_L)
    ht_uv(elev_L)
    fin, rud = build_fin(col, mats)
    return dict(htail_R=stab_R, htail_L=stab_L, ctl_elevator_R=elev_R, ctl_elevator_L=elev_L, fin=fin,
                ctl_rudder=rud)
