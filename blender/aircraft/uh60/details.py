"""Landing gear, wire-strike protection, antennas, sensors, lights and other exterior details (G frame)."""
import math
import numpy as np
from mathutils import Matrix, Vector
from lib import (new_mesh_obj, empty, prim_cylinder, prim_tube, prim_box, prim_sphere, prim_torus, merge_parts,
                 transform_verts, loft_rings, half_profile, ring_from_half, join, airfoil)
import hull

MAIN_WHEEL = (1.352, 1.22, 0.33)
MAIN_R, MAIN_W = 0.33, 0.24
TAIL_WHEEL = (0.0, -7.65, 0.24)
TAIL_R, TAIL_W = 0.24, 0.15


def lathe(profile, n=28, axis='X', center=(0, 0, 0)):
    """Revolve a (r, a) profile (list, open) about an axis. Returns verts, faces."""
    verts, faces = [], []
    m = len(profile)
    for i in range(n):
        ang = 2 * math.pi * i / n
        c, s = math.cos(ang), math.sin(ang)
        for (r, a) in profile:
            if axis == 'X':
                verts.append((center[0] + a, center[1] + r * c, center[2] + r * s))
            elif axis == 'Z':
                verts.append((center[0] + r * c, center[1] + r * s, center[2] + a))
            else:
                verts.append((center[0] + r * c, center[1] + a, center[2] + r * s))
    for i in range(n):
        i1 = (i + 1) % n
        for j in range(m - 1):
            faces.append((i * m + j, i * m + j + 1, i1 * m + j + 1, i1 * m + j))
    return verts, faces


def wheel(name, r, w, M, n=32):
    """Tyre + hub, axle along local X, origin at the axle centre."""
    hw = w / 2
    tyre = [(r * 0.62, -hw * 0.92), (r * 0.80, -hw), (r * 0.93, -hw * 0.96), (r * 0.99, -hw * 0.75),
            (r, -hw * 0.4), (r, hw * 0.4), (r * 0.99, hw * 0.75), (r * 0.93, hw * 0.96), (r * 0.80, hw), (r * 0.62, hw * 0.92)]
    v, f = lathe(tyre, n=n)
    t = new_mesh_obj(name, v, f, M['rubber'], smooth=True)
    hub = [(0.0, -hw * 0.95), (r * 0.25, -hw * 0.95), (r * 0.30, -hw * 0.75), (r * 0.60, -hw * 0.80), (r * 0.64, -hw * 0.9),
           (r * 0.64, hw * 0.9), (r * 0.60, hw * 0.80), (r * 0.30, hw * 0.75), (r * 0.25, hw * 0.95), (0.0, hw * 0.95)]
    v, f = lathe(hub, n=24)
    h = new_mesh_obj('_hub', v, f, M['metal_dark'], smooth=True, sharp_deg=40)
    # hub bolts
    parts = []
    for k in range(6):
        a = 2 * math.pi * k / 6
        for s in (-1, 1):
            parts.append(prim_cylinder(0.014, 0.014, 0.02, n=6, axis='X' if s > 0 else '-X',
                                       center=(s * hw * 0.78, r * 0.42 * math.cos(a), r * 0.42 * math.sin(a))))
    v, f = merge_parts(parts)
    b = new_mesh_obj('_bolts', v, f, M['metal'], smooth=False)
    return join([t, h, b], name)


def build_main_gear(M, root, side):
    s = side
    sn = 'R' if s > 0 else 'L'
    W = Vector((s * MAIN_WHEEL[0], MAIN_WHEEL[1], MAIN_WHEEL[2]))
    objs = []
    # drag beam: from a pivot under the cockpit floor aft/outboard to the axle
    P = Vector((s * 0.60, 2.66, 0.52))
    A = Vector((s * 1.17, 1.22, 0.33))
    v, f = prim_tube([P, P.lerp(A, 0.5) + Vector((0, 0, 0.03)), A], [0.070, 0.062, 0.056], n=14)
    objs.append(new_mesh_obj('_beam', v, f, M['paint'], smooth=True))
    # pivot fitting
    v, f = prim_cylinder(0.075, 0.075, 0.22, n=16, axis='X', center=(P.x - 0.11, P.y, P.z))
    objs.append(new_mesh_obj('_piv', v, f, M['metal_dark'], smooth=True))
    # shock strut: cylinder from the fuselage fitting down to the axle, chrome piston
    F = Vector((s * 1.12, 1.30, 1.16))
    Amid = A + Vector((0, 0.02, 0.06))
    mid = F.lerp(Amid, 0.55)
    v, f = prim_tube([F, mid], 0.072, n=16)
    objs.append(new_mesh_obj('_cyl', v, f, M['paint'], smooth=True))
    v, f = prim_tube([mid + (F - mid).normalized() * 0.05, Amid], 0.050, n=14)
    objs.append(new_mesh_obj('_pis', v, f, M['chrome'], smooth=True))
    # torque link / axle housing
    v, f = prim_cylinder(0.075, 0.075, abs(W.x - A.x) + 0.1, n=16, axis='X' if s > 0 else '-X', center=(A.x - s * 0.05, A.y, A.z))
    objs.append(new_mesh_obj('_axle', v, f, M['metal_dark'], smooth=True))
    # fuselage fitting fairing
    v, f = prim_sphere(0.16, n=16, m=10, center=(s * 1.10, 1.32, 1.20), scale=(0.55, 1.4, 0.9))
    objs.append(new_mesh_obj('_fair', v, f, M['paint'], smooth=True))
    g = join(objs, f'gear_main_{sn}')
    g.parent = root
    wh = wheel(f'wheel_main_{sn}', MAIN_R, MAIN_W, M)
    wh.location = W
    wh.parent = root
    c = empty(f'contact_main_{sn}', (W.x, W.y, W.z - MAIN_R), parent=root)
    return g, wh, c


def build_tail_gear(M, root):
    objs = []
    T = Vector((0, -6.92, 0.76))
    K = Vector((0, -7.47, 0.44))
    v, f = prim_tube([T, K], 0.07, n=14)
    objs.append(new_mesh_obj('_ts', v, f, M['paint'], smooth=True))
    v, f = prim_tube([T + Vector((0, 0.35, 0.02)), K + Vector((0, 0.05, 0.05))], 0.04, n=10)
    objs.append(new_mesh_obj('_ts2', v, f, M['chrome'], smooth=True))
    # fork
    W = Vector(TAIL_WHEEL)
    for sx in (-1, 1):
        v, f = prim_tube([K + Vector((sx * 0.02, 0, 0)), K + Vector((sx * 0.105, -0.05, -0.05)), W + Vector((sx * 0.105, 0, 0))], 0.025, n=8)
        objs.append(new_mesh_obj('_fk', v, f, M['paint'], smooth=True))
    v, f = prim_cylinder(0.05, 0.05, 0.23, n=12, axis='X', center=(-0.115, W.y, W.z))
    objs.append(new_mesh_obj('_ax', v, f, M['metal_dark'], smooth=True))
    # mount fairing on the tail cone
    v, f = prim_sphere(0.16, n=16, m=8, center=(0, -6.85, 0.78), scale=(1.0, 1.8, 0.6))
    objs.append(new_mesh_obj('_tf', v, f, M['paint'], smooth=True))
    g = join(objs, 'gear_tail')
    g.parent = root
    wh = wheel('wheel_tail', TAIL_R, TAIL_W, M, n=24)
    wh.location = W
    wh.parent = root
    c = empty('contact_tail', (W.x, W.y, W.z - TAIL_R), parent=root)
    return g, wh, c


def fin(name, base, length, chord, thick, sweep_deg, up=(0, 0, 1), fwd=(0, 1, 0), mat=None, n=10, taper=0.6):
    """Small blade antenna / fin: airfoil section extruded along 'up' with sweep."""
    up = Vector(up).normalized()
    fwd = Vector(fwd).normalized()
    side = fwd.cross(up).normalized()
    af = airfoil(n=n, t=thick)
    rings = []
    for k, t in enumerate(np.linspace(0, 1, 5)):
        c = chord * (1 - (1 - taper) * t)
        off = -length * t * math.tan(math.radians(sweep_deg))
        pts = []
        for xc, zc in af:
            p = Vector(base) + up * (length * t) + fwd * (off - (xc - 0.5) * c) + side * (zc * c)
            pts.append(tuple(p))
        rings.append(np.array(pts))
    v, f = loft_rings(rings, cap_start='fan', cap_end='fan')
    return new_mesh_obj(name, v, f, mat, smooth=True, sharp_deg=50)


def build_details(M, root):
    paint, dark, metal = M['paint'], M['paint_dark'], M['metal']
    objs_paint, objs_dark, objs_metal, objs_black = [], [], [], []

    # ---- wire strike protection system (upper cutter, windshield deflector, lower cutter)
    v, f = prim_tube([(0, 2.46, 2.25), (0, 2.62, 2.46), (0, 2.78, 2.62)], [0.03, 0.022, 0.012], n=6)
    objs_metal.append(new_mesh_obj('_wc1', v, f, metal, smooth=False))
    objs_paint.append(fin('_wcf', (0, 2.50, 2.22), 0.38, 0.30, 0.10, 42, mat=paint, taper=0.25))
    # (UH-60M: no deflector across the centre pane; the upper cutter sits on the roof above the windshield)
    objs_paint.append(fin('_wcl', (0, 3.95, 0.60), 0.30, 0.22, 0.10, -50, up=(0, 0.25, -1), mat=paint, taper=0.3))
    # ---- windshield wipers (parked along the lower frame of each pane)
    import openings as _op
    for sgn in (-1, 1):
        # parked wipers on the side panes: pivot at the bottom middle of the pane, arm leaning inboard-up
        piv = _op.WS_B + np.array([sgn * 0.58, 0, 0]) + _op.WS_D * 0.03 + _op.WS_N * 0.02
        tip = piv + np.array([-sgn * 0.10, 0, 0]) + _op.WS_D * 0.36 + _op.WS_N * 0.005
        v, f = prim_tube([tuple(piv), tuple(tip)], 0.009, n=6)
        objs_black.append(new_mesh_obj('_wip', v, f, M['black'], smooth=True))
        mid = (piv + tip) / 2
        v, f = prim_tube([tuple(mid - (tip - piv) * 0.55 + _op.WS_N * 0.012), tuple(mid + (tip - piv) * 0.55 + _op.WS_N * 0.012)], 0.006, n=5)
        objs_black.append(new_mesh_obj('_wipb', v, f, M['black'], smooth=True))
        v, f = prim_cylinder(0.022, 0.022, 0.03, n=10, center=tuple(piv - _op.WS_N * 0.01))
        objs_black.append(new_mesh_obj('_wipp', v, f, M['black'], smooth=True))
    # ---- pitot tubes on the cockpit roof
    for s in (-1, 1):
        v, f = prim_tube([(s * 0.36, 2.60, 2.18), (s * 0.40, 2.66, 2.38)], 0.02, n=8)
        objs_paint.append(new_mesh_obj('_ptm', v, f, paint, smooth=True))
        v, f = prim_tube([(s * 0.40, 2.62, 2.38), (s * 0.40, 2.98, 2.38)], [0.016, 0.012], n=8)
        objs_metal.append(new_mesh_obj('_pt', v, f, metal, smooth=True))
    # ---- UH-60M: no ALQ-144 'disco ball'; a low SATCOM / GPS radome sits on the aft doghouse instead
    v, f = prim_sphere(0.17, n=20, m=10, center=(0, -1.70, 2.70), scale=(1.0, 1.35, 0.32))
    objs_dark.append(new_mesh_obj('_rdome', v, f, dark, smooth=True))
    # ---- cargo hook under the belly (hook well + swivel + hook)
    v, f = prim_box((0.52, 0.62, 0.04), center=(0, -0.05, 0.395))
    objs_black.append(new_mesh_obj('_hookwell', v, f, M['black'], smooth=False))
    v, f = prim_cylinder(0.07, 0.06, 0.10, n=14, center=(0, -0.05, 0.30))
    objs_metal.append(new_mesh_obj('_hookb', v, f, M['metal_dark'], smooth=True))
    v, f = prim_tube([(0, -0.05, 0.30), (0, -0.05, 0.19), (0, 0.03, 0.14), (0, 0.10, 0.17), (0, 0.10, 0.22)], 0.022, n=8)
    objs_metal.append(new_mesh_obj('_hook', v, f, M['metal'], smooth=True))
    # ---- louvred vents on the aft tail cone sides (transmission / battery bay cooling) and kick-in steps / handholds
    for s_ in (-1, 1):
        for yv in (-7.05, -7.30):
            xw = hull.fuse_halfwidth_at(yv, 1.35)
            for k in range(5):
                v, f = prim_box((0.012, 0.16, 0.012), center=(s_ * (xw + 0.004), yv, 1.28 + k * 0.03))
                objs_black.append(new_mesh_obj('_lv', v, f, M['black'], smooth=False))
        for (y, z) in ((-3.9, 1.05), (-4.9, 1.20)):
            xw = hull.fuse_halfwidth_at(y, z)
            v, f = prim_box((0.012, 0.13, 0.05), center=(s_ * (xw + 0.003), y, z))
            objs_black.append(new_mesh_obj('_kstep', v, f, M['black'], smooth=False))
        # tail-boom handhold rails (as on the M, above 'UNITED STATES ARMY')
        pts = []
        for y in np.linspace(-3.6, -4.3, 6):
            xw = hull.fuse_halfwidth_at(y, 1.62)
            pts.append((s_ * (xw + 0.035), y, 1.62))
        v, f = prim_tube(pts, 0.012, n=6)
        objs_metal.append(new_mesh_obj('_hhr', v, f, M['metal_dark'], smooth=True))
        for y in (-3.6, -4.3):
            xw = hull.fuse_halfwidth_at(y, 1.62)
            v, f = prim_tube([(s_ * xw, y, 1.62), (s_ * (xw + 0.04), y, 1.62)], 0.012, n=6)
            objs_metal.append(new_mesh_obj('_hhp', v, f, M['metal_dark'], smooth=True))
    # ---- extra blade antennas on the tail boom top and the cabin roof (UH-60M)
    objs_paint.append(fin('_ant5', (0, -6.3, 1.66), 0.20, 0.18, 0.10, 30, mat=paint))
    objs_paint.append(fin('_ant7', (0, -7.3, 0.92), 0.24, 0.20, 0.10, 35, up=(0, 0, -1), mat=paint))
    # ---- mast base boot on the transmission fairing
    v, f = prim_cylinder(0.30, 0.18, 0.12, n=28, center=(0, 0.01, 2.72))
    objs_paint.append(new_mesh_obj('_boot', v, f, paint, smooth=True, sharp_deg=40))
    # ---- engine inlet faces (dark) + particle separator hub
    for s in (-1, 1):
        v, f = prim_cylinder(0.20, 0.20, 0.02, n=24, axis='-Y', center=(s * hull.NAC_X, hull.NAC_Y0 - 0.16, hull.NAC_Z))
        objs_black.append(new_mesh_obj('_inl', v, f, M['black'], smooth=False))
        v, f = prim_sphere(0.09, n=16, m=8, center=(s * hull.NAC_X, hull.NAC_Y0 - 0.17, hull.NAC_Z), scale=(1, 1.3, 1))
        objs_metal.append(new_mesh_obj('_inh', v, f, M['metal_dark'], smooth=True))
    # ---- HIRSS exits: sooty inner duct (the dark disc deep inside the oblique exit) + exhaust mixer vanes
    for s in (-1, 1):
        ring = hull.hirss_ring(s, hull.HIRSS_Y1, cut=True)
        c = ring.mean(0)
        deep = c + (ring - c) * 0.80
        deep[:, 1] += 0.35
        v = [tuple(p) for p in deep] + [tuple(deep.mean(0) + np.array([0, 0.05, 0]))]
        n = len(deep)
        f = [(k, (k + 1) % n, n) for k in range(n)]
        if s > 0:
            f = [ff[::-1] for ff in f]
        objs_black.append(new_mesh_obj('_hx', v, f, M['soot'], smooth=True))
        dc = deep.mean(0)
        for k in range(3):
            off = np.array([0, 0.04 * k, -0.15 + 0.15 * k])
            vv, ff = prim_box((0.36, 0.012, 0.03), center=tuple(dc + off + np.array([0, -0.05, 0])))
            objs_black.append(new_mesh_obj('_hl', vv, ff, M['soot'], smooth=False))
    # ---- cabin door rails (upper and lower), both sides
    for s in (-1, 1):
        for z, y0, y1 in ((1.995, 1.45, -2.75), (0.575, 1.45, -2.65)):
            pts = []
            for y in np.linspace(y0, y1, 12):
                xw = hull.fuse_halfwidth_at(y, z)
                pts.append((s * (xw + 0.02), y, z))
            v, f = prim_tube(pts, 0.018, n=6)
            objs_metal.append(new_mesh_obj('_rail', v, f, M['metal_dark'], smooth=True))
    # ---- steps below the crew doors and cabin doors
    for s in (-1, 1):
        for (y, z) in ((3.05, 0.78), (0.9, 0.46), (-0.2, 0.46)):
            xw = hull.fuse_halfwidth_at(y, z + 0.1)
            v, f = prim_box((0.14, 0.24, 0.025), center=(s * (xw + 0.06), y, z))
            objs_metal.append(new_mesh_obj('_step', v, f, M['metal_dark'], smooth=False))
    # ---- grab handles on the fuselage side
    for s in (-1, 1):
        for (y, z) in ((2.45, 1.55), (1.48, 1.45), (-0.95, 1.45), (-2.2, 1.9)):
            xw = hull.fuse_halfwidth_at(y, z)
            v, f = prim_tube([(s * xw, y, z - 0.12), (s * (xw + 0.05), y, z - 0.1), (s * (xw + 0.05), y, z + 0.1), (s * xw, y, z + 0.12)], 0.012, n=6)
            objs_metal.append(new_mesh_obj('_gh', v, f, M['metal_dark'], smooth=True))
    # ---- antennas: VHF/UHF blades on the tail cone + belly, ADF loop, GPS
    objs_paint.append(fin('_ant1', (0, -5.0, 1.89), 0.36, 0.26, 0.10, 35, mat=paint))
    objs_paint.append(fin('_ant2', (0, -3.2, 2.12), 0.22, 0.22, 0.10, 30, mat=paint))
    objs_paint.append(fin('_ant3', (0, -2.9, 0.45), 0.30, 0.26, 0.10, 35, up=(0, 0, -1), mat=paint))
    objs_paint.append(fin('_ant4', (0, 1.2, 0.41), 0.22, 0.22, 0.10, 30, up=(0, 0, -1), mat=paint))
    v, f = prim_sphere(0.09, n=16, m=8, center=(0, -2.75, 2.49), scale=(1, 1.2, 0.35))
    objs_dark.append(new_mesh_obj('_gps', v, f, dark, smooth=True))
    # whip antenna on the tail cone
    v, f = prim_tube([(0.12, -6.5, 1.62), (0.14, -6.6, 2.35)], [0.008, 0.004], n=5)
    objs_black.append(new_mesh_obj('_whip', v, f, M['black'], smooth=True))
    # ---- APR-39 radar-warning spiral antennas: flat discs on the nose sides (facing 45 deg out) and on the tail cone
    for sx in (-1, 1):
        z = 1.03
        c = Vector((sx * 0.27, 4.40, z))
        # march forward until the point reaches the nose skin (front face)
        for _ in range(80):
            if abs(c.x) >= hull.fuse_halfwidth_at(c.y + 0.005, z) - 0.004 or c.y > 4.74:
                break
            c.y += 0.005
        nrm = Vector((sx * 0.40, 0.92, 0.0)).normalized()
        R = nrm.cross(Vector((0, 0, 1))).normalized()
        U = R.cross(nrm).normalized()
        import cplib as _c
        v, f = _c.place(_c.lathe_z([(0, 0.0), (0.072, 0.0), (0.072, 0.012), (0.062, 0.018), (0, 0.020)], 20), _c.frame(c, R, U, nrm))
        objs_dark.append(new_mesh_obj('_rwr', v, f, dark, smooth=True, sharp_deg=40))
        v, f = _c.place(_c.lathe_z([(0, 0.0), (0.050, 0.0), (0.050, 0.004), (0, 0.004)], 20), _c.frame(c + nrm * 0.018, R, U, nrm))
        objs_black.append(new_mesh_obj('_rwrf', v, f, M['black'], smooth=True))
    for (x, y, z) in ((0.30, -8.9, 1.25), (-0.30, -8.9, 1.25)):
        v, f = prim_sphere(0.055, n=12, m=6, center=(x, y, z))
        objs_black.append(new_mesh_obj('_cm', v, f, M['black'], smooth=True))
    # ---- blade antenna on the aft cockpit roof (right) and the drag-beam fairings with their lenses
    objs_paint.append(fin('_ant8', (0.60, 2.42, 2.13), 0.24, 0.26, 0.10, 38, up=(0.3, 0, 1), mat=paint))
    for sx in (-1, 1):
        v, f = prim_sphere(0.20, n=18, m=10, center=(sx * 0.78, 2.72, 0.60), scale=(0.55, 1.45, 0.55))
        objs_paint.append(new_mesh_obj('_dbf', v, f, paint, smooth=True))
        v, f = prim_sphere(0.035, n=12, m=6, center=(sx * 0.88, 2.78, 0.60), scale=(0.6, 1.0, 0.8))
        objs_black.append(new_mesh_obj('_dbl', v, f, M['lens_blue'], smooth=True))
    # ---- M130 chaff/flare dispensers on the tail cone sides
    for s in (-1, 1):
        y, z = -4.6, 1.02
        xw = hull.fuse_halfwidth_at(y, z)
        v, f = prim_box((0.08, 0.40, 0.22), center=(s * (xw + 0.02), y, z))
        objs_dark.append(new_mesh_obj('_cf', v, f, dark, smooth=False))
    # ---- tail rotor gearbox fairing (top of the pylon, right side) + intermediate gearbox bump
    v, f = prim_sphere(0.30, n=20, m=12, center=(0.05, -9.96, 3.53), scale=(0.75, 1.35, 0.95))
    objs_paint.append(new_mesh_obj('_tgb', v, f, paint, smooth=True))
    v, f = prim_sphere(0.28, n=20, m=10, center=(0, -7.55, 1.52), scale=(0.9, 2.0, 0.8))
    objs_paint.append(new_mesh_obj('_igb', v, f, paint, smooth=True))
    # ---- oil cooler exhaust grille on the aft doghouse (dark insert)
    # (oil cooler exhaust grille is painted in the hull texture)
    # ---- stabilator hinge fairings
    for s in (-1, 1):
        v, f = prim_cylinder(0.06, 0.06, 0.18, n=12, axis='X', center=(s * 0.12 - (0.18 if s > 0 else 0) * 0 + (0 if s > 0 else -0.18), hull.STAB_HINGE[1], hull.STAB_HINGE[2]))
        objs_dark.append(new_mesh_obj('_sh', v, f, dark, smooth=True))

    out = {}
    out['details_paint'] = join(objs_paint, 'details_paint')
    out['details_dark'] = join(objs_dark, 'details_dark')
    out['details_metal'] = join(objs_metal, 'details_metal')
    out['details_black'] = join(objs_black, 'details_black')
    for o in out.values():
        o.parent = root
    return out


def build_lights(M, root):
    """Light empties (contract names) + small emissive lens meshes."""
    L = {}
    specs = [
        ('light_nav_L', (-0.97, 0.80, 2.13), M['light_red']),
        ('light_nav_R', (0.97, 0.80, 2.13), M['light_green']),
        ('light_tail', (0.0, -10.86, 3.34), M['light_white']),
        ('light_beacon_top', (0.0, -9.98, 3.83), M['light_red']),
        ('light_beacon_bottom', (0.0, -2.05, 0.40), M['light_red']),
    ]
    lens = []
    for name, p, mat in specs:
        e = empty(name, p, parent=root, size=0.1)
        v, f = prim_sphere(0.045, n=12, m=6, center=p, scale=(1, 1.4, 0.8))
        o = new_mesh_obj(f'lens_{name[6:]}', v, f, mat, smooth=True)
        o.parent = root
        lens.append(o)
        L[name] = e
    # landing light under the nose (points forward-down, local -Z three = +Y blender)
    e = empty('light_landing', (0.0, 3.98, 0.56), rot=(math.radians(-22), 0, 0), parent=root, size=0.15, kind='SINGLE_ARROW')
    L['light_landing'] = e
    v, f = prim_cylinder(0.09, 0.09, 0.03, n=20, axis='-Z', center=(0.0, 3.98, 0.575))
    o = new_mesh_obj('lens_landing', v, f, M['light_white'], smooth=False)
    o.parent = root
    # searchlight on the belly
    e = empty('light_taxi', (0.0, 2.35, 0.47), rot=(math.radians(-40), 0, 0), parent=root, size=0.15, kind='SINGLE_ARROW')
    L['light_taxi'] = e
    v, f = prim_cylinder(0.11, 0.10, 0.12, n=20, axis='-Z', center=(0.0, 2.35, 0.50))
    o = new_mesh_obj('searchlight', v, f, M['metal_dark'], smooth=True, sharp_deg=40)
    o.parent = root
    return L
