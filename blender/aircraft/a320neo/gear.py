"""Landing gear: twin-wheel main gears (retract inboard into the belly), nose gear (retracts forward), doors, bays.

AC data: nose gear 5.07 m aft of the nose, wheelbase 12.64 m, track 7.59 m, main wheel spacing 0.93 m, nose wheel
spacing 0.50 m, tyres 46x17R20 (main) / 30x8.8R15 (nose). Main gear door hinge 0.49 m off the centreline, door span
1.76 m, 1.83 m long starting 16.36 m aft of the nose. Static axle heights from the tyre radius minus deflection.

Node conventions (rig in src/aircraft/a320neo/model.js):
  gear_main_L/R  pivot at the trunnion, local frame = world; retraction = rotation about local Y (Blender) = fore-aft.
  gear_main_L/R_piston  child, slides along local Z (strut compression); wheels are its children (spin about X).
  gear_main_L/R_stay_up / _stay_lo   folding side stay (two-link IK in the rig).
  gear_door_main_L/R   hinge along Y at 0.49 m from the centreline.
  gear_nose  pivot at the trunnion; retraction = rotation about local X.  gear_nose_piston, wheel_nose_L/R.
  gear_door_nose_fwd_L/R, gear_door_nose_aft_L/R   hinged along Y at the bay edges.
"""
import math
import numpy as np
import bpy
from mathutils import Matrix, Vector
import geo
import layout as LY

ZG = -LY.Z_GROUND
MLG = dict(y=LY.MLG_Y, s=LY.MLG_S, z_trun=-0.88, r_tire=LY.MLG_TIRE_D / 2, w_tire=LY.MLG_TIRE_W, dy=LY.MLG_WHEEL_DY)
MLG['z_axle'] = ZG + MLG['r_tire'] - 0.024
NLG = dict(s_trun=4.85, z_trun=-1.35, s_axle=LY.NLG_S, r_tire=LY.NLG_TIRE_D / 2, w_tire=LY.NLG_TIRE_W, dy=LY.NLG_WHEEL_DY)
NLG['z_axle'] = ZG + NLG['r_tire'] - 0.012
MLG_RETRACT_DEG = 86.0
NLG_RETRACT_DEG = 98.0
MAIN_DOOR = dict(s0=16.36, s1=18.19, y_hinge=0.49, y_out=2.02)
NOSE_BAY = dict(s0=2.30, s1=5.35, y=0.37, s_split=4.52)


def Yw(s):
    return geo.S_CG - s


# ------------------------------------------------------------------------------------------------ wheels

def tire_profile(r, w, n=14):
    """(x_axial, radius) closed-ish profile of a tyre cross-section, bulged sidewalls."""
    pts = []
    rim = r * 0.52
    for k in range(n + 1):
        a = math.pi * k / n            # 0..pi around the tread
        x = -w / 2 * math.cos(a) * (0.92 + 0.08 * math.sin(a))
        rr = rim + (r - rim) * (0.55 + 0.45 * math.sin(a) ** 0.6)
        pts.append((x, rr))
    return pts


def wheel(name, center, r, w, col, mats, side_out=1):
    cx, cy, cz = center
    prof = tire_profile(r, w)
    tire = geo.revolve(name + '_t', [(x, rr) for x, rr in prof], n=geo.NS(40, 6), axis_origin=center, axis='X', col=col,
                       mat=mats['tire'])
    _orient_out(tire, center, 'X')
    rim_r = r * 0.52
    hub_prof = [(-w / 2 * 0.86, rim_r * 1.0), (-w / 2 * 0.80, rim_r * 0.93), (-w / 2 * 0.6, rim_r * 0.90),
                (-w / 2 * 0.45, rim_r * 0.55), (-w / 2 * 0.40, rim_r * 0.22), (-w / 2 * 0.42, 0.0)]
    hubs = []
    for sgn in (1, -1):
        hp = [(sgn * x, rr) for x, rr in hub_prof]
        h = geo.revolve(name + '_h', hp, n=geo.NS(28, 6), axis_origin=center, axis='X', col=col, mat=mats['hub'])
        _orient_out(h, center, 'X', axial_sign=sgn)
        hubs.append(h)
    # brake stack (visible between the rim spokes)
    brake = geo.revolve(name + '_b', [(-w * 0.3, rim_r * 0.80), (w * 0.3, rim_r * 0.80)], n=geo.NS(20, 6), axis_origin=center,
                        axis='X', col=col, mat=mats['dark'])
    # hub bolts (tiny boxes) on the outboard face
    bolts = []
    for k in range(10 if geo.DETAIL > 0.6 else 0):
        a = 2 * math.pi * k / 10
        p = (cx + side_out * (-w / 2 * 0.43), cy + rim_r * 0.40 * math.cos(a), cz + rim_r * 0.40 * math.sin(a))
        bolts.append(geo.box(name + '_bolt', p, (0.02, 0.025, 0.025), col=col, mat=mats['hub']))
    o = geo.join([tire] + hubs + [brake] + bolts, name)
    geo.set_origin(o, center)
    return o


def _orient_out(o, center, axis, axial_sign=0):
    me = o.data
    me.update()
    nrm = np.zeros(len(me.polygons) * 3)
    cen = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    me.polygons.foreach_get('center', cen)
    nrm = nrm.reshape(-1, 3)
    d = cen.reshape(-1, 3) - np.array(center)
    if axis == 'X':
        d[:, 0] = d[:, 0] * (1 if axial_sign == 0 else 0) + (axial_sign * 1.0 if axial_sign else 0)
    if np.einsum('ij,ij->i', nrm, d).sum() < 0:
        geo.flip_normals(o)


# ------------------------------------------------------------------------------------------------ main gear

def main_gear(side, col, mats):
    tag = 'R' if side > 0 else 'L'
    y = MLG['y'] * side
    Ys = Yw(MLG['s'])
    zt, za = MLG['z_trun'], MLG['z_axle']
    T = (y, Ys, zt)
    parts = []
    # main fitting + trunnion cross tube
    parts.append(geo.cylinder('mf', (y, Ys, zt + 0.05), (y, Ys, za + 0.95), 0.135, 0.125, n=geo.NS(20, 6), col=col, mat=mats['gear']))
    parts.append(geo.cylinder('tr', (y, Ys + 0.42, zt), (y, Ys - 0.42, zt), 0.085, n=geo.NS(14, 6), col=col, mat=mats['gear']))
    parts.append(geo.cylinder('collar', (y, Ys, za + 1.02), (y, Ys, za + 0.90), 0.150, n=geo.NS(20, 6), col=col, mat=mats['gear']))
    # side-stay lug on the inboard side
    parts.append(geo.box('lug', (y - side * 0.16, Ys, -1.95), (0.14, 0.12, 0.16), col=col, mat=mats['gear']))
    # leg fairing door (outboard, attached to the leg): curved thin panel
    door = leg_fairing(side, col, mats)
    parts.append(door)
    leg = geo.join(parts, f'gear_main_{tag}')
    geo.set_origin(leg, T)
    # piston (slides): chrome tube, axle beam, torque link lower, wheels as children
    pp = []
    pp.append(geo.cylinder('pist', (y, Ys, za + 1.05), (y, Ys, za + 0.10), 0.098, n=geo.NS(18, 6), col=col, mat=mats['gear_chrome']))
    pp.append(geo.cylinder('fork', (y, Ys, za + 0.16), (y, Ys, za - 0.05), 0.13, 0.10, n=geo.NS(16, 6), col=col, mat=mats['gear']))
    pp.append(geo.cylinder('axle', (y - 0.62, Ys, za), (y + 0.62, Ys, za), 0.072, n=geo.NS(16, 6), col=col, mat=mats['gear']))
    piston = geo.join(pp, f'gear_main_{tag}_piston')
    geo.set_origin(piston, (y, Ys, za))
    geo.parent_keep(piston, leg)
    for k, dy in (('in', -side * MLG['dy']), ('out', side * MLG['dy'])):
        c = (y + dy, Ys, za)
        w = wheel(f'wheel_main_{tag}_{k}', c, MLG['r_tire'], MLG['w_tire'], col, mats, side_out=(1 if dy > 0 else -1))
        geo.parent_keep(w, piston)
    # torque links (upper on the leg, lower on the piston), in front of the strut
    tl_up = geo.box(f'gear_main_{tag}_tl_up', (y, Ys + 0.20, za + 0.72), (0.07, 0.06, 0.40), col=col, mat=mats['gear'])
    geo.set_origin(tl_up, (y, Ys + 0.14, za + 0.92))
    geo.parent_keep(tl_up, leg)
    tl_lo = geo.box(f'gear_main_{tag}_tl_lo', (y, Ys + 0.20, za + 0.33), (0.07, 0.06, 0.40), col=col, mat=mats['gear'])
    geo.set_origin(tl_lo, (y, Ys + 0.14, za + 0.14))
    geo.parent_keep(tl_lo, piston)
    # folding side stay: A on the structure (inboard), B on the leg lug
    A = np.array([y - side * 1.45, Ys, -1.02])
    B = np.array([y - side * 0.16, Ys, -1.95])
    L = np.linalg.norm(B - A)
    L1 = 0.80
    knee = A + (B - A) * (L1 / L)
    up = geo.cylinder(f'gear_main_{tag}_stay_up', A, knee, 0.055, 0.05, n=geo.NS(12, 6), col=col, mat=mats['gear'])
    geo.set_origin(up, A)
    lo = geo.cylinder(f'gear_main_{tag}_stay_lo', knee, B, 0.05, 0.045, n=geo.NS(12, 6), col=col, mat=mats['gear'])
    geo.set_origin(lo, knee)
    geo.parent_keep(lo, up)
    geo.empty(f'gear_main_{tag}_stay_end', tuple(B), col, parent=leg, size=0.05)
    # main door (belly), hinged along Y at 0.49 m from the centreline
    dr = main_door(side, col, mats)
    return dict(leg=leg, piston=piston, stay_up=up, stay_lo=lo, door=dr, A=A, B=B, L1=L1, L2=L - L1)


def wing_lower_z(y, s):
    """Lower surface height of the wing (incl. flap) at span |y| and station s."""
    import wing as WG
    fr = WG.wing_frame(abs(y))
    x = float(np.clip((s - fr['le']) / fr['c'], 0.0, 1.0))
    return float(WG.surf(fr, x, False)[2])


def leg_fairing(side, col, mats):
    """Leg door: designed in its stowed pose as a patch flush with the wing-root lower surface (y 2.28..3.66,
    0.62 m long), then rotated to the extended pose about the trunnion (so gear-up closes it flush)."""
    y = MLG['y'] * side
    Ys = Yw(MLG['s'])
    ys = np.linspace(2.28, 3.66, 9)
    ss = np.linspace(MLG['s'] - 0.31, MLG['s'] + 0.31, 6)
    rows = []
    for s in ss:
        row = []
        for yy in ys:
            row.append((side * yy, Yw(s), wing_lower_z(yy, s) - 0.012))
        rows.append(row)
    P = np.array(rows)
    o = geo.grid_mesh('legdoor', P, closed=False, col=col, mat=mats['leg_door'], auto_orient=False)
    sol = o.modifiers.new('sol', 'SOLIDIFY')
    sol.thickness = 0.02
    sol.offset = 1.0
    geo.apply_modifiers(o)
    # stowed -> extended: inverse of the retraction rotation (about the fore-aft axis through the trunnion)
    ang = -math.radians(MLG_RETRACT_DEG) * side     # gear_main_R retracts by +angle about +Y (Blender)
    T = Vector((y, Ys, MLG['z_trun']))
    R = Matrix.Translation(T) @ Matrix.Rotation(ang, 4, 'Y') @ Matrix.Translation(-T)
    o.data.transform(R)
    o.data.update()
    return o


def main_door(side, col, mats):
    """Door skin following the belly fairing bottom from the hinge (0.49 m) to the outer edge, s0..s1."""
    tag = 'R' if side > 0 else 'L'
    s0, s1 = MAIN_DOOR['s0'], MAIN_DOOR['s1']
    ys = np.linspace(MAIN_DOOR['y_hinge'], MAIN_DOOR['y_out'], 10)
    ss = np.linspace(s0, s1, 8)
    rows = []
    for s in ss:
        row = []
        for yy in ys:
            z = belly_bottom_z(s, yy) - 0.006
            row.append((side * yy, Yw(s), z))
        rows.append(row)
    P = np.array(rows)
    o = geo.grid_mesh(f'gear_door_main_{tag}', P, closed=False, col=col, mat=mats['belly'], auto_orient=False)
    sol = o.modifiers.new('sol', 'SOLIDIFY')
    sol.thickness = 0.025
    sol.offset = 1.0
    geo.apply_modifiers(o)
    _faces_down(o)
    hinge = (side * MAIN_DOOR['y_hinge'], Yw(0.5 * (s0 + s1)), belly_bottom_z(0.5 * (s0 + s1), MAIN_DOOR['y_hinge']))
    geo.set_origin(o, hinge)
    return o


def _faces_down(o):
    pass


def belly_bottom_z(s, y):
    """Belly fairing lower surface height at (s, |y|) - matches fuselage.belly_fairing()."""
    import fuselage as FU
    return FU.belly_z(s, abs(y))


# ------------------------------------------------------------------------------------------------ nose gear

def nose_gear(col, mats):
    sT, zt = NLG['s_trun'], NLG['z_trun']
    sA, za = NLG['s_axle'], NLG['z_axle']
    T = np.array([0.0, Yw(sT), zt])
    Aax = np.array([0.0, Yw(sA), za])
    d = (Aax - T) / np.linalg.norm(Aax - T)
    parts = []
    parts.append(geo.cylinder('nmf', T + d * 0.02, T + d * 1.45, 0.10, 0.09, n=geo.NS(18, 6), col=col, mat=mats['gear']))
    parts.append(geo.cylinder('ntr', T + [-0.30, 0, 0], T + [0.30, 0, 0], 0.07, n=geo.NS(12, 6), col=col, mat=mats['gear']))
    parts.append(geo.cylinder('ncol', T + d * 1.40, T + d * 1.55, 0.115, n=geo.NS(18, 6), col=col, mat=mats['gear']))
    # steering actuators block + taxi/take-off light bar on the front of the leg
    parts.append(geo.box('nsteer', tuple(T + d * 1.30 + [0, 0.10, 0]), (0.30, 0.16, 0.16), col=col, mat=mats['gear']))
    lightbar = geo.box('nlbar', tuple(T + d * 1.12 + [0, 0.16, 0]), (0.34, 0.08, 0.10), col=col, mat=mats['gear'])
    parts.append(lightbar)
    lens = []
    for x, nm in ((-0.10, 'turnoff_L'), (0.0, 'taxi'), (0.10, 'turnoff_R')):
        p = T + d * 1.12 + [x, 0.205, 0]
        lens.append(geo.cylinder('nlens', p - [0, 0.012, 0], p + [0, 0.012, 0], 0.035, n=geo.NS(14, 6), col=col, mat=mats['lens']))
    parts += lens
    leg = geo.join(parts, 'gear_nose')
    geo.set_origin(leg, T)
    pp = []
    pp.append(geo.cylinder('npist', T + d * 1.55, Aax - d * 0.10, 0.07, n=geo.NS(16, 6), col=col, mat=mats['gear_chrome']))
    pp.append(geo.cylinder('naxle', Aax + [-0.36, 0, 0], Aax + [0.36, 0, 0], 0.045, n=geo.NS(12, 6), col=col, mat=mats['gear']))
    pp.append(geo.box('nfork', tuple(Aax + [0, 0, 0.06]), (0.16, 0.14, 0.16), col=col, mat=mats['gear']))
    piston = geo.join(pp, 'gear_nose_piston')
    geo.set_origin(piston, Aax)
    geo.parent_keep(piston, leg)
    for tag, dx in (('L', -NLG['dy']), ('R', NLG['dy'])):
        w = wheel(f'wheel_nose_{tag}', (dx, Aax[1], Aax[2]), NLG['r_tire'], NLG['w_tire'], col, mats,
                  side_out=(1 if dx > 0 else -1))
        geo.parent_keep(w, piston)
    # torque links (behind the strut)
    tl_up = geo.box('gear_nose_tl_up', tuple(Aax + d * -0.62 + [0, -0.12, 0]), (0.05, 0.05, 0.32), col=col, mat=mats['gear'])
    geo.set_origin(tl_up, Aax + d * -0.78 + [0, -0.08, 0])
    geo.parent_keep(tl_up, leg)
    tl_lo = geo.box('gear_nose_tl_lo', tuple(Aax + d * -0.30 + [0, -0.12, 0]), (0.05, 0.05, 0.32), col=col, mat=mats['gear'])
    geo.set_origin(tl_lo, Aax + d * -0.14 + [0, -0.08, 0])
    geo.parent_keep(tl_lo, piston)
    # drag brace: from the bay structure forward (A) to the leg (B), folds when retracting
    A = np.array([0.0, Yw(3.70), -1.55])
    B = T + d * 1.20 + np.array([0, 0.09, 0])
    L = np.linalg.norm(B - A)
    L1 = 0.70
    knee = A + (B - A) * (L1 / L)
    up = geo.cylinder('gear_nose_brace_up', A, knee, 0.045, n=geo.NS(12, 6), col=col, mat=mats['gear'])
    geo.set_origin(up, A)
    lo = geo.cylinder('gear_nose_brace_lo', knee, B, 0.04, n=geo.NS(12, 6), col=col, mat=mats['gear'])
    geo.set_origin(lo, knee)
    geo.parent_keep(lo, up)
    geo.empty('gear_nose_brace_end', tuple(B), col, parent=leg, size=0.05)
    geo.empty('light_taxi', tuple(T + d * 1.12 + [0, 0.23, 0]), col, parent=leg, size=0.1)
    geo.empty('light_turnoff_L', tuple(T + d * 1.12 + [-0.10, 0.23, 0]), col, parent=leg, size=0.1,
              rot=Matrix.Rotation(math.radians(35), 3, 'Z'))
    geo.empty('light_turnoff_R', tuple(T + d * 1.12 + [0.10, 0.23, 0]), col, parent=leg, size=0.1,
              rot=Matrix.Rotation(math.radians(-35), 3, 'Z'))
    doors = nose_doors(col, mats)
    return dict(leg=leg, piston=piston, brace_up=up, brace_lo=lo, A=A, B=B, L1=L1, L2=L - L1, doors=doors)


def _door_uv(o, mats):
    """Outer faces: fuselage livery via the analytic skin UVs; inner faces (pointing up) -> bay primer."""
    import fuselage as FU
    FU.fuselage_uv(o)
    me = o.data
    if mats['gear_bay'].name not in [m.name for m in me.materials]:
        me.materials.append(mats['gear_bay'])
    k = [m.name for m in me.materials].index(mats['gear_bay'].name)
    nrm = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get('normal', nrm)
    mi = np.where(nrm.reshape(-1, 3)[:, 2] > 0.2, k, 0).astype(np.int32)
    me.polygons.foreach_set('material_index', mi)


def nose_doors(col, mats):
    """Forward doors (s0..s_split) and aft doors (s_split..s1), each side hinged along Y at |y| = bay half width,
    skins follow the fuselage underside."""
    out = {}
    for part, (sa, sb) in (('fwd', (NOSE_BAY['s0'], NOSE_BAY['s_split'] - 0.01)), ('aft', (NOSE_BAY['s_split'] + 0.01, NOSE_BAY['s1']))):
        for side in (-1, 1):
            tag = 'R' if side > 0 else 'L'
            ss = np.linspace(sa, sb, 8)
            yy = np.linspace(0.005, NOSE_BAY['y'], 6)
            rows = []
            for s in ss:
                row = []
                for y in yy:
                    th = math.pi - math.asin(min(0.999, y / float(LY.prof(s)[2])))
                    # find the surface point with lateral coordinate y (lower half)
                    ths = np.linspace(math.pi / 2, math.pi, 400)
                    Ys_, Zs_ = LY.surface(np.full_like(ths, s), ths)
                    t = float(np.interp(-y, -Ys_, ths))
                    yv, zv = LY.surface(s, t)
                    row.append((side * float(yv), Yw(s), float(zv) - 0.006))
                rows.append(row)
            P = np.array(rows)
            o = geo.grid_mesh(f'gear_door_nose_{part}_{tag}', P, closed=False, col=col, mat=mats['fuselage'],
                              auto_orient=False)
            sol = o.modifiers.new('sol', 'SOLIDIFY')
            sol.thickness = 0.02
            sol.offset = 1.0
            geo.apply_modifiers(o)
            _door_uv(o, mats)
            hs = 0.5 * (sa + sb)
            ths = np.linspace(math.pi / 2, math.pi, 400)
            Ys_, Zs_ = LY.surface(np.full_like(ths, hs), ths)
            t = float(np.interp(-NOSE_BAY['y'], -Ys_, ths))
            yv, zv = LY.surface(hs, t)
            geo.set_origin(o, (side * float(yv), Yw(hs), float(zv)))
            out[o.name] = o
    return out


# ------------------------------------------------------------------------------------------------ bays

def bay_liner(name, s0, s1, y0, y1, z_bot, z_top, col, mat, bottom=None, n=10):
    """Wheel-well liner, faces pointing into the well. Open at the bottom; the side/end walls stop at
    bottom(s, y) (the skin) so nothing protrudes outside the aircraft."""
    bottom = bottom or (lambda s, y: z_bot)
    ss = np.linspace(s0, s1, n)
    yy = np.linspace(y0, y1, n)
    acc_v, acc_f = [], []

    def quad(a, b, c, d):
        k = len(acc_v)
        acc_v.extend([a, b, c, d])
        acc_f.append((k, k + 1, k + 2, k + 3))
    for i in range(n - 1):
        sa, sb = ss[i], ss[i + 1]
        for yw in (y0, y1):
            quad((yw, Yw(sa), bottom(sa, yw) + 0.03), (yw, Yw(sb), bottom(sb, yw) + 0.03), (yw, Yw(sb), z_top), (yw, Yw(sa), z_top))
        ya, yb = yy[i], yy[i + 1]
        for sw in (s0, s1):
            quad((ya, Yw(sw), bottom(sw, ya) + 0.03), (yb, Yw(sw), bottom(sw, yb) + 0.03), (yb, Yw(sw), z_top), (ya, Yw(sw), z_top))
    quad((y0, Yw(s0), z_top), (y1, Yw(s0), z_top), (y1, Yw(s1), z_top), (y0, Yw(s1), z_top))
    luv = [(0, 0), (1, 0), (1, 1), (0, 1)] * len(acc_f)
    o = geo.mesh_object(name, np.array(acc_v), acc_f, col=col, mat=mat, smooth=False, loop_uvs=np.array(luv))
    # orient faces toward the well centre
    o.data.update()
    c = np.array([(y0 + y1) / 2, Yw((s0 + s1) / 2), (z_bot + z_top) / 2])
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for f in bm.faces:
        if f.normal.dot(Vector(c) - f.calc_center_median()) < 0:
            f.normal_flip()
    bm.to_mesh(o.data)
    bm.free()
    return o


def fuselage_bottom(s, y):
    ths = np.linspace(math.pi / 2, math.pi, 400)
    Y_, Z_ = LY.surface(np.full_like(ths, s), ths)
    return float(np.interp(-abs(y), -Y_, Z_))


def build(col, mats, skin=None, belly=None):
    out = {}
    for side in (-1, 1):
        g = main_gear(side, col, mats)
        tag = 'R' if side > 0 else 'L'
        out[f'main_{tag}'] = g
    out['nose'] = nose_gear(col, mats)
    # wells
    liners = []
    import fuselage as FU
    for side in (-1, 1):
        y0, y1 = side * 0.46, side * 2.05
        liners.append(bay_liner('mlg_well', MAIN_DOOR['s0'] - 0.02, MAIN_DOOR['s1'] + 0.02, min(y0, y1), max(y0, y1), -2.25,
                                -0.28, col, mats['gear_bay'], bottom=lambda s, y: FU.belly_z(s, y)))
    liners.append(bay_liner('nlg_well', NOSE_BAY['s0'] - 0.01, NOSE_BAY['s1'] + 0.01, -NOSE_BAY['y'] - 0.01,
                            NOSE_BAY['y'] + 0.01, -2.2, -0.95, col, mats['gear_bay'], bottom=fuselage_bottom))
    wells = geo.join(liners, 'gear_wells')
    out['wells'] = wells
    return out


def cutters(col):
    """Boxes to cut the wheel-well openings: (belly fairing MLG cut, fuselage MLG cut, nose-bay cut)."""
    c_main, c_mainf = [], []
    sc = 0.5 * (MAIN_DOOR['s0'] + MAIN_DOOR['s1'])
    ln = MAIN_DOOR['s1'] - MAIN_DOOR['s0']
    for side in (-1, 1):
        yc = side * 0.5 * (MAIN_DOOR['y_hinge'] + MAIN_DOOR['y_out'])
        wd = MAIN_DOOR['y_out'] - MAIN_DOOR['y_hinge']
        c_main.append(geo.box('cut_mlg', (yc, Yw(sc), -2.5), (wd, ln, 1.2), col=col))
        c_mainf.append(geo.box('cut_mlgf', (yc, Yw(sc), -1.975), (wd, ln, 2.25), col=col))
    c_nose = geo.box('cut_nlg', (0, Yw(0.5 * (NOSE_BAY['s0'] + NOSE_BAY['s1'])), -2.3),
                     (2 * NOSE_BAY['y'], NOSE_BAY['s1'] - NOSE_BAY['s0'], 1.0), col=col)
    return geo.join(c_main, 'cut_mlg'), geo.join(c_mainf, 'cut_mlgf'), c_nose
