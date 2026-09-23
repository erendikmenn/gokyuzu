"""Antennas, probes, light fixtures (+ light empties for the rig), wipers."""
import math
import numpy as np
import bpy
from mathutils import Matrix, Vector
import geo
import layout as LY


def surf_pt(s, th, off=0.0):
    y, z = LY.surface(s, th)
    n = LY.normal(np.array([s]), np.array([th]))[0]
    p = np.array([float(y), geo.S_CG - s, float(z)])
    return p + n * off, n


def top_pt(s, off=0.0):
    return surf_pt(s, 0.0, off)


def bottom_pt(s, off=0.0):
    return surf_pt(s, math.pi, off)


def blade_antenna(name, s, th, col, mat, h=0.26, chord=0.30, sweep=0.14, thick=0.028):
    """Swept blade antenna standing on the skin at (s, th), pointing along the surface normal."""
    base, n = surf_pt(s, th, -0.01)
    n = n / np.linalg.norm(n)
    fwd = np.array([0.0, 1.0, 0.0])
    side = np.cross(n, fwd)
    side /= np.linalg.norm(side)
    fwd = np.cross(side, n)
    rings = []
    for k, t in enumerate(np.linspace(0, 1, 6)):
        c = chord * (1 - 0.55 * t)
        sw = sweep * t
        z = h * t
        ring = []
        for a in np.linspace(0, 2 * math.pi, 14, endpoint=False):
            x = -c / 2 * math.cos(a) - sw
            w = thick * (1 - 0.5 * t) * math.sin(a) * (0.5 + 0.5 * math.cos(a) ** 2 * 0 + 0.5)
            ring.append(base + fwd * x + side * w + n * z)
        rings.append(ring)
    o = geo.grid_mesh(name, np.array(rings), closed=True, col=col, mat=mat, cap1=True)
    return o


def pitot(name, s, th, col, mat, length=0.22):
    base, n = surf_pt(s, th, -0.005)
    fwd = np.array([0.0, 1.0, 0.0])
    elbow = base + n * 0.09
    tip = elbow + fwd * length
    a = geo.cylinder(name + '_mast', base, elbow, 0.022, 0.016, n=10, col=col, mat=mat)
    b = geo.cylinder(name + '_tube', elbow - fwd * 0.02, tip, 0.013, 0.011, n=10, col=col, mat=mat)
    return geo.join([a, b], name)


def aoa_vane(name, s, th, col, mat):
    base, n = surf_pt(s, th, 0.0)
    fwd = np.array([0.0, 1.0, 0.0])
    plate = geo.cylinder(name + '_b', base - n * 0.005, base + n * 0.006, 0.07, n=16, col=col, mat=mat)
    side = np.cross(n, fwd)
    side /= np.linalg.norm(side)
    pts = [base + n * 0.005 + fwd * 0.03, base + n * 0.10 - fwd * 0.05, base + n * 0.10 - fwd * 0.15,
           base + n * 0.005 - fwd * 0.08]
    v = [p + side * 0.006 for p in pts] + [p - side * 0.006 for p in pts]
    f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    vane = geo.mesh_object(name + '_v', np.array(v), f, col=col, mat=mat, smooth=False)
    return geo.join([plate, vane], name)


def dome(name, center, normal, r, col, mat, h=None, n=16):
    """Hemispherical lens (beacon/strobe cover)."""
    h = h or r
    normal = np.asarray(normal, float)
    normal /= np.linalg.norm(normal)
    tmp = np.array([1.0, 0, 0]) if abs(normal[0]) < 0.9 else np.array([0, 1.0, 0])
    u = np.cross(normal, tmp)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    rings = []
    for k in range(7):
        a = (math.pi / 2) * k / 6
        rr = r * math.cos(a)
        zz = h * math.sin(a)
        ring = [center + normal * zz + (u * math.cos(b) + v * math.sin(b)) * max(rr, 1e-4)
                for b in np.linspace(0, 2 * math.pi, n, endpoint=False)]
        rings.append(ring)
    return geo.grid_mesh(name, np.array(rings), closed=True, col=col, mat=mat, cap0=True)


def build(col, mats, lod=False):
    out = {}
    anten = mats['antenna']
    probe = mats['probe']
    objs = []
    # --- antennas (AC fig 2-11-0-991-003)
    objs.append(blade_antenna('ant_vhf1', 4.35, 0.0, col, anten, h=0.30, chord=0.34))
    objs.append(blade_antenna('ant_vhf3', 23.2, 0.0, col, anten, h=0.30, chord=0.34))
    objs.append(blade_antenna('ant_vhf2', 21.6, math.pi, col, anten, h=0.26, chord=0.30))
    objs.append(blade_antenna('ant_atc_top', 7.3, 0.0, col, anten, h=0.10, chord=0.14, sweep=0.03, thick=0.02))
    objs.append(blade_antenna('ant_tcas_top', 9.6, 0.0, col, anten, h=0.06, chord=0.20, sweep=0.0, thick=0.05))
    objs.append(blade_antenna('ant_elt', 26.8, 0.0, col, anten, h=0.14, chord=0.16, sweep=0.04, thick=0.02))
    objs.append(blade_antenna('ant_atc1', 6.3, math.pi, col, anten, h=0.10, chord=0.14, sweep=0.03, thick=0.02))
    objs.append(blade_antenna('ant_dme1', 7.9, math.pi, col, anten, h=0.10, chord=0.14, sweep=0.03, thick=0.02))
    objs.append(blade_antenna('ant_dme2', 9.6, math.pi - 0.12, col, anten, h=0.10, chord=0.14, sweep=0.03, thick=0.02))
    objs.append(blade_antenna('ant_tcas_bot', 10.2, math.pi, col, anten, h=0.06, chord=0.20, sweep=0.0, thick=0.05))
    objs.append(blade_antenna('ant_marker', 24.5, math.pi, col, anten, h=0.05, chord=0.40, sweep=0.0, thick=0.06))
    for i, s in enumerate((3.95, 4.15)):
        p, n = top_pt(s, 0.0)
        objs.append(geo.cylinder(f'ant_gps{i}', p - n * 0.01, p + n * 0.018, 0.075, 0.06, n=16, col=col, mat=anten))
    # --- probes (both sides): pitot x3, AOA x3, TAT, static plates
    for side in (1, -1):
        th = lambda s, z: LY.theta_at(s, z, side)
        objs.append(pitot(f'pitot_{side}', 2.55, th(2.55, -0.25), col, probe))
        objs.append(aoa_vane(f'aoa_{side}', 3.35, th(3.35, 0.05), col, probe))
        p, n = surf_pt(4.62, th(4.62, -0.85))
        objs.append(geo.cylinder(f'static_{side}', p - n * 0.004, p + n * 0.004, 0.09, n=18, col=col, mat=probe))
    objs.append(pitot('pitot_stby', 2.75, LY.theta_at(2.75, -0.55, -1), col, probe))
    objs.append(aoa_vane('aoa_stby', 3.55, LY.theta_at(3.55, -0.30, -1), col, probe))
    tat_p, tat_n = surf_pt(2.25, LY.theta_at(2.25, -0.90, -1))
    objs.append(geo.cylinder('tat', tat_p, tat_p + tat_n * 0.12, 0.03, 0.02, n=10, col=col, mat=probe))
    if lod:
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        out['antennas'] = geo.join(objs, 'antennas')

    # --- lights: fixtures + empties
    lights = []
    import wing as WG
    for side, tag, mat in ((1, 'R', mats['light_green']), (-1, 'L', mats['light_red'])):
        fr = WG.wing_frame(16.15)
        p = WG.surf(fr, 0.02, True)
        p[0] *= side
        lights.append(dome(f'navlens_{tag}', p + np.array([0, 0.02, 0.0]), (0, 1, 0), 0.06, col, mat, h=0.07))
        geo.empty(f'light_nav_{tag}', tuple(p + np.array([0, 0.08, 0.0])), col, size=0.1)
        ps = WG.surf(fr, 0.05, False)
        ps[0] *= side
        lights.append(dome(f'strobelens_{tag}', ps + np.array([0, 0.0, -0.01]), (0, 0, -1), 0.05, col, mats['lens'], h=0.04))
        geo.empty(f'light_strobe_{tag}', tuple(ps + np.array([0, 0.0, -0.06])), col, size=0.1)
        # aft-facing white nav/strobe at the sharklet root trailing edge
        pt_ = WG.surf(WG.wing_frame(16.25), 0.99, True)
        pt_[0] *= side
        geo.empty(f'light_navaft_{tag}', tuple(pt_ + np.array([0, -0.05, 0])), col, size=0.1)
        # retractable landing light under the wing root
        fl = WG.wing_frame(3.0)
        pl = WG.surf(fl, 0.30, False)
        pl[0] *= side
        lights.append(geo.cylinder(f'landlens_{tag}', pl + np.array([0, 0, 0.01]), pl + np.array([0, 0, -0.012]), 0.10,
                                   n=18, col=col, mat=mats['lens']))
        geo.empty(f'light_landing_{tag}', tuple(pl + np.array([0, 0.05, -0.06])), col, size=0.15,
                  rot=Matrix.Rotation(math.radians(-4), 3, 'X'))
        # wing scan light on the fuselage side ahead of the wing
        ps2, n2 = surf_pt(12.3, LY.theta_at(12.3, 0.25, side), 0.0)
        lights.append(dome(f'scanlens_{tag}', ps2, n2, 0.045, col, mats['lens'], h=0.02))
        geo.empty(f'light_wing_{tag}', tuple(ps2 + n2 * 0.05), col, size=0.1)
        # logo light on the HT upper surface, looking at the fin
        import empennage as EM
        fh = EM.ht_frame(4.2)
        pg = EM.ht_pt(fh, 0.35, EM.sym_airfoil(0.35, fh['tc']))
        pg[0] *= side
        lights.append(dome(f'logolens_{tag}', pg, (0, 0, 1), 0.05, col, mats['lens'], h=0.03))
        geo.empty(f'light_logo_{tag}', tuple(pg + np.array([0, 0, 0.05])), col, size=0.1)
    # beacons (red) top and bottom
    pb, nb = top_pt(14.9)
    lights.append(dome('beacon_top', pb - nb * 0.005, nb, 0.075, col, mats['light_red'], h=0.075))
    geo.empty('light_beacon_top', tuple(pb + nb * 0.08), col, size=0.1)
    pb2, nb2 = bottom_pt(10.35)
    lights.append(dome('beacon_bottom', pb2 - nb2 * 0.005, nb2, 0.075, col, mats['light_red'], h=0.075))
    geo.empty('light_beacon_bottom', tuple(pb2 + nb2 * 0.08), col, size=0.1)
    # tail cone: white nav (tail) + strobe
    top, bot, hw = LY.prof(37.2)
    pt_tail = np.array([0.0, geo.S_CG - 37.2, float(0.5 * (top + bot)) + 0.25])
    for sd in (1, -1):
        p = pt_tail + np.array([sd * float(hw) * 0.8, 0, 0])
        lights.append(dome(f'taillens_{sd}', p, (sd, -0.3, 0), 0.04, col, mats['light_white'], h=0.03))
    geo.empty('light_tail', tuple(pt_tail + np.array([0, -0.25, 0])), col, size=0.1)
    geo.empty('light_strobe_tail', tuple(pt_tail + np.array([0, -0.25, 0.05])), col, size=0.1)
    out['light_fixtures'] = geo.join(lights, 'light_fixtures')

    # --- wipers (parked on the windshields, near the centre post)
    wipers = []
    if lod:
        return out
    for side in (1, -1):
        s0, t0 = LY.s_at_front(0.16, 0.66)
        s1, t1 = LY.s_at_front(0.24, 0.98)
        a, _ = surf_pt(s0, t0 if side > 0 else 2 * math.pi - t0, 0.03)
        b, _ = surf_pt(s1, t1 if side > 0 else 2 * math.pi - t1, 0.022)
        wipers.append(geo.cylinder(f'wiper_arm_{side}', a, b, 0.012, 0.009, n=8, col=col, mat=mats['wiper']))
        mid = (a + b) / 2
        d = (b - a) / np.linalg.norm(b - a)
        wipers.append(geo.cylinder(f'wiper_blade_{side}', mid - d * 0.26 + np.array([0, 0.0, 0]),
                                   mid + d * 0.26, 0.008, n=6, col=col, mat=mats['wiper']))
        wipers.append(geo.cylinder(f'wiper_hub_{side}', a - np.array([0, 0, 0.01]), a + np.array([0, 0.0, 0.03]), 0.03,
                                   n=12, col=col, mat=mats['wiper']))
    out['wipers'] = geo.join(wipers, 'wipers')
    # --- eye points and contacts
    geo.empty('eye_pilot', (-LY.EYE_Y, geo.S_CG - LY.EYE_S, LY.EYE_Z), col, size=0.1)
    geo.empty('eye_copilot', (LY.EYE_Y, geo.S_CG - LY.EYE_S, LY.EYE_Z), col, size=0.1)
    zg = -LY.Z_GROUND
    geo.empty('contact_nose', (0.0, geo.S_CG - LY.NLG_S, zg), col, size=0.2)
    geo.empty('contact_main_L', (-LY.MLG_Y, geo.S_CG - LY.MLG_S, zg), col, size=0.2)
    geo.empty('contact_main_R', (LY.MLG_Y, geo.S_CG - LY.MLG_S, zg), col, size=0.2)
    return out
