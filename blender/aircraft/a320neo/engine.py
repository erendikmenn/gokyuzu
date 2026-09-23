"""CFM LEAP-1A nacelle, fan (18 blades), spinner, core, primary nozzle, plug, translating-sleeve thrust reverser,
pylon. Dimensions from the AC power-plant figure 2-12-0-991-055: max width 2.60, height 2.52, nose cowl 0.67 (top) /
0.49 (bottom; inlet scarf 0.18), fan cowl 1.58, reverser 1.98, primary nozzle 0.23, plug 0.98, fan 1.98 m.
Engine axis at y = +/-5.75, z = -2.09 (nacelle low point 0.56 m above ground); top inlet lip at s = 11.14."""
import math
import numpy as np
import bpy
from mathutils import Matrix, Vector
import geo
import layout as LY

NA = 64          # points around

# outer nacelle profile (x from the top lip, r)
OUTER = [(0.000, 1.080), (0.012, 1.108), (0.035, 1.137), (0.08, 1.170), (0.16, 1.200), (0.30, 1.228), (0.50, 1.252),
         (0.80, 1.270), (1.20, 1.280), (1.60, 1.279), (2.00, 1.268), (2.25, 1.254)]
SLEEVE_OUT = [(2.25, 1.254), (2.60, 1.228), (2.95, 1.186), (3.25, 1.130), (3.48, 1.078), (3.62, 1.046)]
# inlet inner surface: lip -> throat -> fan face
INLET = [(0.000, 1.080), (0.012, 1.050), (0.040, 1.022), (0.10, 1.002), (0.25, 0.992), (0.55, 0.990), (0.86, 0.992)]
BYPASS_OUTER = [(1.12, 0.995), (1.60, 0.990), (2.25, 0.985)]            # fixed duct wall behind the fan
SLEEVE_IN = [(2.25, 0.985), (2.90, 0.975), (3.40, 0.980), (3.62, 1.030)]
CORE = [(1.10, 0.55), (1.30, 0.66), (1.60, 0.72), (2.20, 0.75), (2.90, 0.74), (3.60, 0.70), (4.00, 0.63), (4.23, 0.565)]
NOZZLE = [(4.23, 0.565), (4.34, 0.535), (4.46, 0.505)]
NOZZLE_IN = [(4.46, 0.490), (4.20, 0.52), (3.95, 0.55)]
PLUG = [(3.90, 0.46), (4.20, 0.44), (4.46, 0.40), (4.80, 0.29), (5.10, 0.17), (5.32, 0.075), (5.40, 0.04), (5.44, 0.0)]
SPINNER = [(0.52, 0.0), (0.53, 0.035), (0.57, 0.085), (0.66, 0.160), (0.78, 0.245), (0.92, 0.325), (1.02, 0.370),
           (1.10, 0.395), (1.18, 0.40)]
SCARF = 0.18
X_FAN = 0.98
ELLIPSE = (1.0, 0.975)      # horizontal/vertical scale of the nacelle (2.60 x 2.52)


def axis_frame(side):
    """Engine origin (top inlet lip plane on the axis) and the local frame (x_eng along +aft)."""
    y = LY.ENG_Y * side
    s_lip = LY.ENG_S_LIP
    return np.array([y, geo.S_CG - s_lip, LY.ENG_Z])


def scarf_x(th, x):
    """Axial offset of the inlet scarf (top lip forward): applies to the front 0.8 m, fading out."""
    k = max(0.0, 1.0 - x / 0.8)
    return SCARF * 0.5 * (1 - np.cos(th)) * k


def rev_surface(name, prof, origin, col, mat, n=None, scarf=False, ellipse=True, flip=False, cap1=False, uv_v=None):
    n = n or max(16, 4 * int(round(NA * geo.DETAIL / 4)))
    th = np.linspace(0, 2 * math.pi, n, endpoint=False)        # 0 = top, increasing toward +x (right)
    P = np.zeros((len(prof), n, 3))
    ex, ez = ELLIPSE if ellipse else (1.0, 1.0)
    for i, (x, r) in enumerate(prof):
        dx = scarf_x(th, x) if scarf else 0.0
        P[i, :, 0] = origin[0] + r * np.sin(th) * ex
        P[i, :, 1] = origin[1] - (x + dx)
        P[i, :, 2] = origin[2] + r * np.cos(th) * ez
    lens = np.r_[0, np.cumsum(np.hypot(np.diff([p[0] for p in prof]), np.diff([p[1] for p in prof])))]
    uv_u = np.array([p[0] for p in prof]) / 3.7
    o = geo.grid_mesh(name, P, closed=True, col=col, mat=mat, uv_u=uv_u, uv_v=uv_v, auto_orient=False, cap1=cap1)
    # orientation: outward from the axis unless flip
    me = o.data
    me.update()
    nrm = np.zeros(len(me.polygons) * 3)
    cen = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    me.polygons.foreach_get('center', cen)
    nrm = nrm.reshape(-1, 3)
    cen = cen.reshape(-1, 3)
    radial = cen - np.array([origin[0], 0, origin[2]]) * [1, 0, 1]
    radial[:, 1] = 0
    score = np.einsum('ij,ij->i', nrm, radial).sum()
    if (score < 0) != flip:
        geo.flip_normals(o)
    return o


def fan_blades(origin, col, mat, nb=18):
    """Wide-chord swept composite blades between hub r 0.40 and tip r 0.985 at x ~ X_FAN."""
    verts, faces = [], []
    radii = np.linspace(0.40, 0.982, geo.NS(9, 3))
    nch = geo.NS(9, 3)
    for b in range(nb):
        base = 2 * math.pi * b / nb
        rings = []
        for r in radii:
            t = (r - 0.40) / 0.582
            chord = 0.30 + 0.12 * t                  # wide chord
            stagger = math.radians(58 - 30 * t)      # blade angle from the axis
            sweep = 0.10 * t * t                     # tip swept aft
            camber = 0.035 * (1 - 0.5 * t)
            thick = 0.022 * (1 - 0.7 * t) + 0.004
            pts = []
            for side in (1, -1):
                xs = np.linspace(0, 1, nch)
                if side < 0:
                    xs = xs[::-1]
                for xc in xs:
                    ca = (xc - 0.5) * chord
                    cz = camber * 4 * xc * (1 - xc) * chord / 0.3 + side * thick * math.sin(math.pi * max(xc, 0.02)) ** 0.7 / 2
                    # blade-local: along axis (a) and circumferential (c)
                    a = ca * math.cos(stagger) - cz * math.sin(stagger) + sweep
                    c = ca * math.sin(stagger) + cz * math.cos(stagger)
                    ang = base + c / r
                    pts.append((r * math.sin(ang), -(X_FAN + a), r * math.cos(ang)))
            rings.append(pts)
        m = len(rings[0])
        off = len(verts)
        for ring in rings:
            verts.extend(ring)
        for i in range(len(rings) - 1):
            for j in range(m):
                j2 = (j + 1) % m
                faces.append((off + i * m + j, off + i * m + j2, off + (i + 1) * m + j2, off + (i + 1) * m + j))
        # tip cap
        tip = off + (len(rings) - 1) * m
        faces.append(tuple(tip + j for j in range(m)))
    V = np.array(verts) + np.array([origin[0], origin[1], origin[2]]) * [1, 1, 1]
    o = geo.mesh_object('blades', V, faces, col=col, mat=mat)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    return o


def ogv_ring(origin, col, mat, n=36):
    boxes = []
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        r0, r1 = 0.74, 0.99
        rm = (r0 + r1) / 2
        c = Vector((rm * math.sin(a), -1.42, rm * math.cos(a))) + Vector(origin)
        R = Matrix.Rotation(-a, 3, 'Y') @ Matrix.Rotation(math.radians(12), 3, 'Z')
        boxes.append(geo.box('ogv', c, (0.012, 0.16, r1 - r0), col=col, mat=mat, rot=np.array(R)))
    return geo.join(boxes, 'ogv')


def cascade_ring(origin, col, mat):
    prof = [(2.28, 1.17), (2.70, 1.15)]
    return rev_surface('cascade', prof, origin, col, mat, n=48)


def nacelle_strake(side, O, col, mat):
    """Vortex-control strake (chine) on the inboard upper side of the fan cowl (A320neo)."""
    th = math.radians(-62) * side          # inboard, above the horizontal (0 = top, + = toward +x)
    ex, ez = ELLIPSE
    pts = []
    for x, h in ((0.95, 0.0), (1.25, 0.20), (1.65, 0.20), (1.75, 0.0)):
        r = float(np.interp(x, [p[0] for p in OUTER], [p[1] for p in OUTER])) - 0.01
        rr = r + h
        pts.append((O[0] + rr * math.sin(th) * ex, O[1] - x, O[2] + rr * math.cos(th) * ez))
    P = np.array(pts)
    tvec = np.array([math.cos(th), 0.0, -math.sin(th)]) * 0.008      # thickness (tangential)
    verts = np.vstack([P + tvec, P - tvec])
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    luv = [(0.3, 0.5)] * 24
    return geo.mesh_object('strake', verts, faces, col=col, mat=mat, smooth=False, loop_uvs=np.array(luv))


def pylon(side, col, mat):
    """Pylon: forward fairing on the fan cowl rising to the wing LE, main body under the wing, aft fairing."""
    import wing as WG
    y = LY.ENG_Y * side
    fr = WG.wing_frame(LY.ENG_Y)
    s_lip = LY.ENG_S_LIP
    ze = LY.ENG_Z
    stations = np.linspace(s_lip + 0.55, 18.35, geo.NS(40, 12))
    rings = []
    for s in stations:
        x = s - s_lip
        # bottom of the pylon: nacelle top (outer) / core cowl top / aft fairing rising to the wing
        if x < 3.62:
            r = np.interp(x, [p[0] for p in OUTER + SLEEVE_OUT], [p[1] for p in OUTER + SLEEVE_OUT]) * ELLIPSE[1]
            zb = ze + r - 0.06
        elif x < 4.25:
            zb = ze + np.interp(x, [p[0] for p in CORE], [p[1] for p in CORE]) - 0.03
        else:
            zb = None
        # wing lower surface at this station
        xc = (s - fr['le']) / fr['c']
        if xc <= 0.0:
            zw = float(WG.surf(fr, 0.0, False)[2]) + 0.05
        else:
            zw = float(WG.surf(fr, min(xc, 1.0), False)[2]) + 0.03
        if zb is None:
            # aft fairing: bottom rises from the core-top level to the wing near its end
            z_core_end = ze + 0.565 - 0.03
            t = (s - (s_lip + 4.25)) / (18.35 - (s_lip + 4.25))
            zb = z_core_end + (zw - 0.08 - z_core_end) * float(geo.smoothstep(0.0, 1.0, t)) ** 0.8
            top = zw
        elif x < 0.55 + 1e-6:
            top = zb + 0.02
        else:
            # forward fairing: rises from the fan cowl to the wing LE (s ~ 14.9)
            top = zb + 0.02 + (zw - zb - 0.02) * float(geo.smoothstep(0.55, fr['le'] - s_lip + 0.3, x))
            top = min(top, zw)
        h = max(top - zb, 0.03)
        # half width: 0.20 at the nacelle, 0.23 under the wing, tapering at both ends
        w = 0.20 + 0.03 * geo.smoothstep(0.5, 3.6, x)
        w *= float(geo.smoothstep(-0.3, 0.9, x)) * 0.8 + 0.2
        if s > 17.3:
            w *= max(0.12, 1 - (s - 17.3) / 1.1)
        n = geo.NS(16, 8)
        ring = []
        for k in range(n):
            a = 2 * math.pi * k / n
            yy = y + w * np.sign(math.sin(a)) * abs(math.sin(a)) ** 0.6
            zz = zb + h * (0.5 + 0.5 * np.sign(math.cos(a)) * abs(math.cos(a)) ** 0.6)
            ring.append((yy, geo.S_CG - s, zz))
        rings.append(ring)
    o = geo.grid_mesh(f'pylon_{"R" if side > 0 else "L"}', np.array(rings), closed=True, col=col, mat=mat,
                      cap0=True, cap1=True)
    return o


def build_engine(side, col, mats):
    idx = 2 if side > 0 else 1
    O = axis_frame(side)
    parts = []
    # nacelle outer (fixed): lip + nose cowl + fan cowl ; inlet inner
    lip = rev_surface('lip', OUTER[:4], O, col, mats['inlet_lip'], scarf=True)
    cowl = rev_surface('cowl', OUTER[3:], O, col, mats['nacelle'], scarf=True)
    inlet = rev_surface('inlet', INLET, O, col, mats['engine_inner'], scarf=True, flip=True)
    duct = rev_surface('duct', BYPASS_OUTER, O, col, mats['engine_inner'], flip=True)
    core = rev_surface('core', CORE, O, col, mats['core'], ellipse=False)
    noz = rev_surface('noz', NOZZLE, O, col, mats['exhaust'], ellipse=False)
    nozi = rev_surface('nozi', NOZZLE_IN, O, col, mats['exhaust'], ellipse=False, flip=True)
    plug = rev_surface('plug', PLUG, O, col, mats['exhaust'], ellipse=False, n=geo.NS(40, 12))
    ogv = ogv_ring(O, col, mats['engine_inner']) if geo.DETAIL > 0.6 else None
    splitter = rev_surface('split', [(1.02, 0.50), (1.08, 0.56), (1.16, 0.60)], O, col, mats['core'], ellipse=False)
    hub_wall = rev_surface('hubwall', [(1.16, 0.40), (1.40, 0.52)], O, col, mats['engine_inner'], ellipse=False, flip=True)
    cascade = cascade_ring(O, col, mats['cascade']) if geo.DETAIL > 0.6 else None
    py = pylon(side, col, mats['pylon'])
    strake = nacelle_strake(side, O, col, mats['nacelle'])
    nac = geo.join([lip, cowl, inlet, duct, core, noz, nozi, plug, ogv, splitter, hub_wall, cascade, py, strake],
                   f'nacelle_{idx}')
    # thrust reverser translating sleeve (outer + inner skin)
    so = rev_surface('sleeve_o', SLEEVE_OUT, O, col, mats['nacelle'])
    si = rev_surface('sleeve_i', SLEEVE_IN, O, col, mats['engine_inner'], flip=True)
    lipr = rev_surface('sleeve_lip', [(3.62, 1.046), (3.625, 1.038), (3.62, 1.030)], O, col, mats['nacelle'])
    rev = geo.join([so, si, lipr], f'reverser_{idx}')
    geo.set_origin(rev, (O[0], O[1] - 2.25, O[2]))
    # fan: blades + spinner, pivot on the axis at the fan plane
    blades = fan_blades(O, col, mats['fan'])
    spin = rev_surface('spinner', SPINNER, O, col, mats['spinner'], ellipse=False, n=geo.NS(40, 12))
    fan = geo.join([blades, spin], f'fan_{idx}')
    geo.set_origin(fan, (O[0], O[1] - X_FAN, O[2]))
    # empties
    geo.empty(f'engine_{idx}', (O[0], O[1] - 1.6, O[2]), col)
    geo.empty(f'nozzle_{idx}', (O[0], O[1] - 4.46, O[2]), col)
    return dict(nacelle=nac, reverser=rev, fan=fan)


def build(col, mats):
    out = {}
    for side in (-1, 1):
        e = build_engine(side, col, mats)
        for k, v in e.items():
            out[v.name] = v
    return out
