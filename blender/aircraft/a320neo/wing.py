"""Wing: segmented fixed box + slats, Fowler flaps, spoilers, ailerons, sharklets and flap-track fairings.

Planform from the Airbus AC planform (digitized): LE(y) = 11.92 + 0.513 y, TE = 18.83 inboard of the kink
(y = 6.44), outboard TE sweep 0.306; tip (sharklet root) y = 16.30. Chord plane z(y) = -0.88 + (y-1.975) tan 5.1 deg.
All geometry is built for the right wing (+X) and mirrored.
"""
import math
import numpy as np
import bpy
import geo
import layout as LY

# ------------------------------------------------------------------------------------------------ airfoil

def airfoil(x, tc):
    """Supercritical-like section, chord 1. Returns (z_upper, z_lower)."""
    x = np.clip(np.asarray(x, float), 0, 1)
    # thickness: NACA-like with a blunter nose and max thickness ~0.37c
    t = (0.2969 * np.sqrt(x) * 1.06 - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    t = t * (1 + 0.30 * x * (1 - x) * (x - 0.15))           # shift thickness aft
    t = t / 0.1001 * tc / 2 * 0.98 + 0.0012 * x               # small TE thickness
    # aft-loaded camber (supercritical): flat upper, cusped lower aft
    yc = 0.012 * np.sin(np.pi * x ** 1.25) + 0.010 * np.exp(-((x - 0.82) / 0.13) ** 2)
    zu = yc + t
    zl = yc - t * (1 - 0.18 * np.exp(-((x - 0.80) / 0.12) ** 2))
    return zu, zl


def chord_grid():
    """Global chord-fraction samples shared by all wing parts (so coincident rings weld)."""
    if geo.DETAIL < 0.6:
        return np.array([0.0, 0.006, 0.02, 0.045, 0.075, 0.12, 0.22, 0.35, 0.48, 0.62, 0.66, 0.70, 0.715, 0.72, 0.745,
                         0.757, 0.785, 0.835, 0.9, 1.0])
    b = np.r_[0.0, 0.0025, 0.006, 0.012, 0.02, 0.03, 0.045, 0.06, 0.08, 0.10, 0.12,
              np.linspace(0.15, 0.60, 14), 0.62, 0.66, 0.70, 0.72, 0.74, 0.76, 0.785, 0.80, 0.83, 0.86, 0.89,
              0.92, 0.95, 0.975, 1.0]
    return np.unique(np.round(b, 5))


XG = chord_grid()

# spanwise layout (right wing) — shared with textures.py
from wing_layout import SLATS, FLAPS, SPOILERS, AILERON, FTF, XS, X_SP0, X_SP1, X_FL_LOW, X_SHROUD, X_AIL
Y_ROOT = 1.25
Y_TIP = LY.WING['y_tip']


def wing_frame(y):
    """-> dict with LE station, chord, chord-plane z at quarter chord, twist (rad), tc, dihedral (rad)."""
    le = LY.wing_le(y)
    te = float(LY.wing_te(y))
    c = te - le
    return dict(y=y, le=le, c=c, zq=float(LY.wing_z(y)), tw=math.radians(float(LY.wing_twist(y))),
                tc=float(LY.wing_tc(y)), dh=math.radians(LY.WING['dihedral_deg']))


def pt(fr, x, zn):
    """World point of chord fraction x with normalized thickness offset zn (chord units) at span frame fr."""
    c = fr['c']
    s = fr['le'] + x * c
    dz = (0.25 - x) * c * math.sin(fr['tw']) + zn * c
    y = fr['y'] - math.sin(fr['dh']) * zn * c
    return np.array([y, geo.S_CG - s, fr['zq'] + dz * math.cos(fr['dh'])])


def surf(fr, x, upper=True, off=0.0):
    zu, zl = airfoil(x, fr['tc'])
    z = (zu if upper else zl) + off
    return pt(fr, x, z)


# ------------------------------------------------------------------------------------------------ sections

def xs_between(a, b, include=True):
    xs = XG[(XG > a + 1e-6) & (XG < b - 1e-6)]
    if include:
        xs = np.r_[a, xs, b]
    return xs


def fixed_section(fr, xf_u, xf_l, xa_u, xa_l, n_nose=9, n_cove=7):
    """Closed loop: upper TE-side (xa_u) -> front -> lower -> aft cove back to start."""
    tc = fr['tc']
    pts = []
    xu = xs_between(xf_u, xa_u)[::-1]
    for x in xu:
        pts.append(surf(fr, x, True))
    if xf_u > 0:          # rounded nose hidden inside the slat
        zu = airfoil(xf_u, tc)[0]
        zl = airfoil(xf_l, tc)[1]
        for k in range(1, n_nose - 1):
            a = math.pi * k / (n_nose - 1)
            zz = zu + (zl - zu) * (1 - math.cos(a)) / 2
            xx = xf_u + (xf_l - xf_u) * (1 - math.cos(a)) / 2 - 0.035 * math.sin(a)
            pts.append(pt(fr, xx, zz))
    xl = xs_between(xf_l, xa_l)
    if xf_u == 0:
        xl = xl[1:]       # LE point shared
    for x in xl:
        pts.append(surf(fr, x, False))
    if xa_u < 0.999:      # cove back up to the upper surface
        zl = airfoil(xa_l, tc)[1]
        zu = airfoil(xa_u, tc)[0]
        for k in range(1, n_cove - 1):
            t = k / (n_cove - 1)
            xx = xa_l + (xa_u - xa_l) * t ** 1.6 - 0.02 * math.sin(math.pi * t)
            zz = zl + (zu - 0.004 - zl) * math.sin(t * math.pi / 2)
            pts.append(pt(fr, xx, zz))
    return np.array(pts)


def flap_section(fr, x0, n_nose=11, tuck=0.013, x_show=0.86):
    """Flap: rounded nose at x0, upper surface tucked under the spoiler/shroud until x_show."""
    tc = fr['tc']
    xs = xs_between(x0 + 0.02, 1.0)
    pts = []
    # upper from TE forward
    for x in xs[::-1]:
        tk = tuck * (1 - geo.smoothstep(x_show - 0.05, x_show, x))
        pts.append(pt(fr, x, airfoil(x, tc)[0] - tk))
    zu = airfoil(x0 + 0.02, tc)[0] - tuck
    zl = airfoil(x0 + 0.02, tc)[1] + 0.002
    for k in range(1, n_nose - 1):
        a = math.pi * k / (n_nose - 1)
        zz = zu + (zl - zu) * (1 - math.cos(a)) / 2
        xx = x0 + 0.02 - 0.02 * math.sin(a) * 1.6
        pts.append(pt(fr, xx, zz))
    for x in xs:
        pts.append(pt(fr, x, airfoil(x, tc)[1] + (0.002 if x < 0.73 else 0.0)))
    return np.array(pts)


def aileron_section(fr, x0=X_AIL, n_nose=9):
    tc = fr['tc']
    xs = xs_between(x0 + 0.012, 1.0)
    pts = [pt(fr, x, airfoil(x, tc)[0] - 0.001) for x in xs[::-1]]
    zu = airfoil(x0 + 0.012, tc)[0] - 0.001
    zl = airfoil(x0 + 0.012, tc)[1] + 0.001
    for k in range(1, n_nose - 1):
        a = math.pi * k / (n_nose - 1)
        zz = zu + (zl - zu) * (1 - math.cos(a)) / 2
        xx = x0 + 0.012 - 0.018 * math.sin(a)
        pts.append(pt(fr, xx, zz))
    pts += [pt(fr, x, airfoil(x, tc)[1] + 0.001) for x in xs]
    return np.array(pts)


def slat_section(fr, xs_u=XS, xs_l=0.075):
    tc = fr['tc']
    pts = []
    for x in xs_between(0.0, xs_u)[::-1]:
        pts.append(surf(fr, x, True, 0.0008))
    for x in xs_between(0.0, xs_l)[1:]:
        pts.append(surf(fr, x, False, -0.0008))
    # concave back face (3 pts)
    zl = airfoil(xs_l, tc)[1]
    zu = airfoil(xs_u, tc)[0]
    for t in (0.33, 0.66):
        xx = xs_l + (xs_u - xs_l) * t - 0.02 * math.sin(math.pi * t)
        pts.append(pt(fr, xx, zl + (zu - zl) * t))
    return np.array(pts)


def spoiler_section(fr, x0=X_SP0, x1=X_SP1, thick=0.012):
    tc = fr['tc']
    xs = xs_between(x0, x1)
    up = [pt(fr, x, airfoil(x, tc)[0] + 0.0007) for x in xs]
    lo = []
    for x in xs[::-1]:
        t = thick * (1 - 0.8 * ((x - x0) / (x1 - x0)) ** 2)
        lo.append(pt(fr, x, airfoil(x, tc)[0] - t))
    return np.array(up[::-1] + lo[::-1][::-1])


def loft_sections(name, secs, col, mat, uvfun=None, cap=True, sharp_first=True):
    P = np.array(secs)
    o = geo.grid_mesh(name, P, closed=True, col=col, mat=mat, cap0=cap, cap1=cap, auto_orient=True,
                      sharp_cols=(0,) if sharp_first else ())
    if uvfun is not None:
        uvfun(o)
    return o


def span_stations(y0, y1, step=0.45):
    step = step / geo.DETAIL
    n = max(2, int(math.ceil((y1 - y0) / step)) + 1)
    return np.linspace(y0, y1, n)


# ------------------------------------------------------------------------------------------------ UVs

U_Y0, U_Y1 = 0.8, 18.0         # tex u <- span y (abs)
V_S0, V_S1 = 10.8, 24.0        # tex v <- station s ; upper half v in [0.5,1], lower [0,0.5]


def planform_uv(obj, mirror=False):
    """Planform-projection UVs: upper faces -> v in [0.5,1], lower -> [0,0.5]; both wings share the texture."""
    me = obj.data
    me.update()
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uvl = me.uv_layers[0]
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(obj.matrix_world)
    co = co @ M[:3, :3].T + M[:3, 3]
    nrm = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    nrm = nrm.reshape(-1, 3) @ M[:3, :3].T
    li = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', li)
    ls = np.zeros(len(me.polygons), dtype=np.int32)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_start', ls)
    me.polygons.foreach_get('loop_total', lt)
    face_of_loop = np.repeat(np.arange(len(me.polygons)), lt)
    up = nrm[face_of_loop, 2] >= 0
    p = co[li]
    u = (np.abs(p[:, 0]) - U_Y0) / (U_Y1 - U_Y0)
    s = geo.S_CG - p[:, 1]
    vv = (s - V_S0) / (V_S1 - V_S0)
    v = np.where(up, 0.5 + 0.5 * vv, 0.5 * (1 - vv))
    uvl.data.foreach_set('uv', np.stack([u, v], 1).astype(np.float32).ravel())


# ------------------------------------------------------------------------------------------------ build

def segments():
    """Fixed-wing segments (y0, y1, xf_u, xf_l, xa_u, xa_l)."""
    segs = []
    cuts = sorted(set([Y_ROOT, Y_TIP - 0.3] + [a for a, b in SLATS] + [b for a, b in SLATS]
                      + [a for a, b in SPOILERS] + [b for a, b in SPOILERS] + [a for a, b in FLAPS]
                      + [b for a, b in FLAPS] + list(AILERON)))
    cuts = [c for c in cuts if Y_ROOT <= c <= Y_TIP - 0.3]
    for y0, y1 in zip(cuts[:-1], cuts[1:]):
        ym = 0.5 * (y0 + y1)
        slat = any(a <= ym <= b for a, b in SLATS)
        spoil = any(a <= ym <= b for a, b in SPOILERS)
        flap = any(a - 0.05 <= ym <= b + 0.05 for a, b in FLAPS)
        ail = AILERON[0] - 0.05 <= ym <= AILERON[1] + 0.05
        xf_u, xf_l = (XS, 0.075) if slat else (0.0, 0.0)
        if ail:
            xa_u = xa_l = X_AIL
        elif flap or ym < FLAPS[0][0]:
            xa_u = X_SP0 if spoil else X_SHROUD
            xa_l = X_FL_LOW
        else:
            xa_u = xa_l = 1.0
        segs.append((y0, y1, xf_u, xf_l, xa_u, xa_l))
    return segs


def build_right(col, mats):
    parts = {}
    fixed = []
    for i, (y0, y1, xfu, xfl, xau, xal) in enumerate(segments()):
        secs = [fixed_section(wing_frame(y), xfu, xfl, xau, xal) for y in span_stations(y0, y1)]
        o = loft_sections(f'wfix_{i}', secs, col, mats['wing'], cap=True, sharp_first=(xau >= 0.999))
        fixed.append(o)
    # tip + sharklet (continuous loft)
    tip = sharklet(col, mats)
    fixed.append(tip)
    wing = geo.join(fixed, 'wing_R')
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(wing.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2e-4)
    bm.to_mesh(wing.data)
    bm.free()
    planform_uv_multi(wing)
    parts['wing'] = wing

    # slats
    for k, (a, b) in enumerate(SLATS):
        secs = [slat_section(wing_frame(y)) for y in span_stations(a, b, 0.4)]
        o = loft_sections(f'ctl_slat_R_{k + 1}', secs, col, mats['wing'], cap=True)
        planform_uv(o)
        # pivot at the slat trailing point (upper, mid-span), axis along the LE
        fa, fb = wing_frame(a), wing_frame(b)
        p0, p1 = surf(fa, XS, True), surf(fb, XS, True)
        geo.set_origin(o, (p0 + p1) / 2, geo.hinge_frame(p0, p1))
        parts[o.name] = o
    # flaps
    for k, (a, b) in enumerate(FLAPS):
        x0 = 0.695
        secs = [flap_section(wing_frame(y), x0) for y in span_stations(a, b, 0.4)]
        o = loft_sections(f'ctl_flap_R_{k + 1}', secs, col, mats['wing'], cap=True)
        planform_uv(o)
        fa, fb = wing_frame(a), wing_frame(b)
        za = 0.5 * sum(airfoil(x0 + 0.02, fa['tc']))
        zb = 0.5 * sum(airfoil(x0 + 0.02, fb['tc']))
        p0, p1 = pt(fa, x0 + 0.01, za), pt(fb, x0 + 0.01, zb)
        geo.set_origin(o, (p0 + p1) / 2, geo.hinge_frame(p0, p1))
        parts[o.name] = o
    # spoilers
    for k, (a, b) in enumerate(SPOILERS):
        secs = [spoiler_section(wing_frame(y)) for y in span_stations(a, b, 0.4)]
        o = loft_sections(f'ctl_spoiler_R_{k + 1}', secs, col, mats['wing'], cap=True, sharp_first=True)
        planform_uv(o)
        fa, fb = wing_frame(a), wing_frame(b)
        p0, p1 = surf(fa, X_SP0, True), surf(fb, X_SP0, True)
        geo.set_origin(o, (p0 + p1) / 2, geo.hinge_frame(p0, p1))
        parts[o.name] = o
    # aileron
    a, b = AILERON
    secs = [aileron_section(wing_frame(y)) for y in span_stations(a, b, 0.4)]
    o = loft_sections('ctl_aileron_R', secs, col, mats['wing'], cap=True)
    planform_uv(o)
    fa, fb = wing_frame(a), wing_frame(b)
    za = 0.5 * sum(airfoil(X_AIL + 0.012, fa['tc']))
    zb = 0.5 * sum(airfoil(X_AIL + 0.012, fb['tc']))
    p0, p1 = pt(fa, X_AIL + 0.006, za), pt(fb, X_AIL + 0.006, zb)
    geo.set_origin(o, (p0 + p1) / 2, geo.hinge_frame(p0, p1))
    parts['ctl_aileron_R'] = o
    # flap track fairings
    for k, yf in enumerate(FTF):
        front, back = flap_track_fairing(yf, col, mats)
        fixed_part = front
        wing = geo.join([parts['wing'], fixed_part], 'wing_R')
        parts['wing'] = wing
        flap = parts['ctl_flap_R_1'] if yf < FLAPS[0][1] else parts['ctl_flap_R_2']
        back.name = f'ftf_R_{k + 1}'
        geo.parent_keep(back, flap)
        parts[back.name] = back
    return parts


def planform_uv_multi(obj):
    """UV for the joined fixed wing: planform projection; sharklet faces (material index 1) get a separate
    layout computed in sharklet()."""
    me = obj.data
    has_shark = 'shark_uv' in me.attributes
    if not has_shark:
        planform_uv(obj)
        return
    # save the sharklet uvs, compute planform uvs, then restore sharklet faces
    uvl = me.uv_layers[0]
    old = np.zeros(len(me.loops) * 2)
    uvl.data.foreach_get('uv', old)
    planform_uv(obj)
    new = np.zeros(len(me.loops) * 2)
    uvl.data.foreach_get('uv', new)
    mi = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('material_index', mi)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get('loop_total', lt)
    mloop = np.repeat(mi, lt)
    keep = np.repeat(mloop == 1, 2)
    new[keep] = old[keep]
    uvl.data.foreach_set('uv', new)


def sharklet(col, mats):
    """Wing tip (y from Y_TIP-0.3 to Y_TIP) + blended sharklet. Spine digitized from the AC front view:
    the wing runs on nearly flat to y~17.2, bends up tightly and the blade rises with ~7 deg outward cant to
    y = 17.9 (span 35.80 m), 2.4 m above the tip chord plane. LE/TE stations vs spine arc length from the
    AC planform + side view (top chord 0.31 m, LE 22.77, TE 23.08)."""
    y_a = Y_TIP - 0.3
    fr_tip = wing_frame(Y_TIP)
    z_tip = fr_tip['zq']
    pts = np.array([(16.30, 0.00), (16.80, 0.065), (17.18, 0.23), (17.45, 0.44), (17.62, 0.70), (17.71, 1.00),
                    (17.765, 1.30), (17.83, 1.85), (17.90, 2.40)])
    # Catmull-Rom through the points, then resample by arc length
    P = np.vstack([pts[0] - (pts[1] - pts[0]), pts, pts[-1] + (pts[-1] - pts[-2])])
    dense = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for t in np.linspace(0, 1, 40, endpoint=False):
            t2, t3 = t * t, t * t * t
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                                + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    dense.append(pts[-1])
    dense = np.array(dense)
    seg = np.linalg.norm(np.diff(dense, axis=0), axis=1)
    arc = np.r_[0, np.cumsum(seg)]
    sig_all = np.r_[np.linspace(0, 0.9, geo.NS(6, 3)), np.linspace(0.9, 2.2, geo.NS(12, 5))[1:], np.linspace(2.2, arc[-1], geo.NS(8, 3))[1:]]
    spine = []
    for y in np.linspace(y_a, Y_TIP, 4)[:-1]:
        spine.append((y, float(LY.wing_z(y)), fr_tip['dh'], -1.0))
    for sg in sig_all:
        y = float(np.interp(sg, arc, dense[:, 0]))
        h = float(np.interp(sg, arc, dense[:, 1]))
        y2 = float(np.interp(min(sg + 0.02, arc[-1]), arc, dense[:, 0]))
        h2 = float(np.interp(min(sg + 0.02, arc[-1]), arc, dense[:, 1]))
        y1 = float(np.interp(max(sg - 0.02, 0), arc, dense[:, 0]))
        h1 = float(np.interp(max(sg - 0.02, 0), arc, dense[:, 1]))
        th = math.atan2(h2 - h1, y2 - y1)
        th = max(th, fr_tip['dh'])
        spine.append((y, z_tip + h, th, sg))
    le_tip = LY.wing_le(Y_TIP)
    te_tip = float(LY.wing_te(Y_TIP))
    SG = [0, 0.5, 0.9, 1.25, 1.55, 1.85, 2.15, arc[-1]]
    LEo = [0, 0.28, 0.62, 0.80, 0.95, 1.15, 1.40, 2.49]
    TEo = [0, 0.13, 0.25, 0.40, 0.55, 0.68, 0.80, 1.23]
    secs = []
    qs = []
    for (y, z, th, sg) in spine:
        if sg < 0:
            fr = wing_frame(y)
            le, c, tc, tw = fr['le'], fr['c'], fr['tc'], fr['tw']
            z = fr['zq']
        else:
            le = le_tip + float(np.interp(sg, SG, LEo))
            te = te_tip + float(np.interp(sg, SG, TEo))
            c = max(te - le, 0.28)
            q = sg / arc[-1]
            tc = fr_tip['tc'] + (0.082 - fr_tip['tc']) * min(1.0, q * 1.6)
            tw = fr_tip['tw'] * max(0.0, 1 - q * 2)
        n = np.array([-math.sin(th), math.cos(th)])       # thickness direction in (y, z)
        sec = [(x, airfoil(x, tc)[0]) for x in xs_between(0.0, 1.0)[::-1]]
        sec += [(x, airfoil(x, tc)[1]) for x in xs_between(0.0, 1.0)[1:]]
        ring = []
        for x, zn in sec:
            dz = (0.25 - x) * c * math.sin(tw) + zn * c
            ring.append([y + n[0] * dz, geo.S_CG - (le + x * c), z + n[1] * dz])
        secs.append(np.array(ring))
        qs.append(sg)
    P = np.array(secs)
    o = geo.grid_mesh('wingtip_R', P, closed=True, col=col, mat=mats['wing'], cap1=True, auto_orient=True,
                      sharp_cols=(0,))
    o.data.materials.append(mats['tail'])
    me = o.data
    N, Mn = P.shape[0], P.shape[1]
    q = np.array(qs)
    h0 = z_tip
    mi = np.zeros(len(me.polygons), dtype=np.int32)
    luv = np.zeros(len(me.loops) * 2)
    me.uv_layers[0].data.foreach_get('uv', luv)
    luv = luv.reshape(-1, 2)
    li = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', li)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    for fi, poly in enumerate(me.polygons):
        vids = list(poly.vertices)
        rows = [v // Mn for v in vids if v < N * Mn]
        if rows and q[min(rows)] >= 1.0:
            mi[fi] = 1
            for k in range(poly.loop_total):
                vi = li[poly.loop_start + k]
                r, j = divmod(vi, Mn)
                side = 1.0 if j < Mn / 2 else 0.0     # upper(inboard) / lower(outboard) face
                p = co[vi]
                sta = geo.S_CG - p[1]
                uu = 0.80 + 0.19 * (sta - 20.4) / 3.0
                vv = 0.01 + 0.23 * (p[2] - h0) / 2.6 + 0.25 * side
                luv[poly.loop_start + k] = (uu, vv)
    me.polygons.foreach_set('material_index', mi)
    me.uv_layers[0].data.foreach_set('uv', luv.ravel())
    me.attributes.new('shark_uv', 'BOOLEAN', 'FACE')
    return o


def flap_track_fairing(yf, col, mats):
    """Canoe fairing under the wing at span yf: fixed front part + aft part (moves with the flap)."""
    fr = wing_frame(yf)
    c = fr['c']
    le = fr['le']
    s0 = le + 0.42 * c
    s_split = le + 0.73 * c
    s1 = le + c + 0.62
    zl_front = surf(fr, 0.45, False)[2]
    hmax = 0.40 + 0.10 * (1 - yf / 12)
    wmax = 0.17 + 0.04 * (1 - yf / 12)
    th = np.linspace(0, 2 * math.pi, 20, endpoint=False)

    def ring(s):
        t = (s - s0) / (s1 - s0)
        # profile: rises from the wing, deepest ~55%, tapers to a point aft
        depth = hmax * (np.sin(np.pi * np.clip(t, 0, 1) ** 0.75) ** 0.8) + 0.02
        width = wmax * (np.sin(np.pi * np.clip(t, 0, 1) ** 0.65) ** 0.6) + 0.01
        x_local = np.clip((s - le) / c, 0, 1.2)
        ztop = float(surf(fr, min(x_local, 1.0), False)[2]) + 0.05 if x_local <= 1.0 else float(surf(fr, 1.0, False)[2]) + 0.05 - (s - le - c) * 0.10
        zc = ztop - depth / 2
        y = yf + width * np.sin(th)
        z = zc + (depth / 2) * np.cos(th) * np.where(np.cos(th) > 0, 1.0, 1.0)
        return np.stack([y, np.full_like(th, geo.S_CG - s), z], 1)

    sa = np.linspace(s0, s_split, 9)
    sb = np.linspace(s_split, s1, 10)
    fa = geo.grid_mesh(f'ftf_front_{yf}', np.array([ring(s) for s in sa]), closed=True, col=col, mat=mats['wing'],
                       cap0=True, cap1=True)
    fb = geo.grid_mesh(f'ftf_back_{yf}', np.array([ring(s) for s in sb]), closed=True, col=col, mat=mats['wing'],
                       cap0=True, cap1=True)
    planform_uv(fa)
    planform_uv(fb)
    return fa, fb


def mirror_part(o, name):
    """Mirror a (possibly pivoted) object to the left wing, keeping a correct pivot frame."""
    m = geo.mirror_x(o, name)
    return m


def build(col, mats):
    global XG
    XG = chord_grid()
    right = build_right(col, mats)
    out = dict(right)
    # mirror everything to the left
    for key, o in list(right.items()):
        if o.parent is not None and o.name.startswith('ftf_'):
            continue
        nm = o.name.replace('_R', '_L') if '_R' in o.name else o.name + '_L'
        L = mirror_with_pivot(o, nm)
        out[nm] = L
        for ch in list(o.children):
            if ch.name.startswith('ftf_R'):
                Lc = mirror_with_pivot(ch, ch.name.replace('_R', '_L'))
                geo.parent_keep(Lc, L)
                out[Lc.name] = Lc
    return out


def mirror_with_pivot(o, name):
    """Mirror across X=0. For pivot objects the mirrored local frame keeps X pointing +X world (right)."""
    from mathutils import Matrix, Vector
    Mw = o.matrix_world.copy()
    me = o.data.copy()
    me.name = name
    # world-space mirrored geometry
    me.transform(Mw)
    S = Matrix.Scale(-1, 4, (1, 0, 0))
    me.transform(S)
    me.flip_normals()
    n = bpy.data.objects.new(name, me)
    for c in o.users_collection:
        c.objects.link(n)
    for i, m in enumerate(o.data.materials):
        pass
    # pivot: mirrored origin; local frame: mirror the rotation then flip X axis so it still points +X
    loc = Mw.translation.copy()
    loc.x = -loc.x
    R = Mw.to_3x3()
    Sm = Matrix.Scale(-1, 3, (1, 0, 0))
    Rm = Sm @ R @ Sm          # reflect frame (proper rotation)
    n.matrix_world = Matrix.Identity(4)
    geo.set_origin(n, loc, Rm)
    return n
