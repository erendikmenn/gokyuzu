"""F-22A small exterior details: light positions (empties), nav/strobe lenses, electroluminescent formation strips,
flush antenna fairings.  Refs: ref/side_langley.jpg (fin formation strip), ref/top_refuel_140807.jpg (wingtip lens)."""
import math
import numpy as np
try:
    import bmesh
    from mathutils import Vector
except ImportError:     # plain python (texture scripts)
    bmesh = Vector = None

import geom as G
from geom import Y
import oml as O
import surfaces as SF
import aft as A

# name: (x, s, z)
LIGHTS = {
    'light_nav_L': (-(O.X_TIP - 0.06), O.w_le(O.X_TIP - 0.06) + 0.22, O.w_zc(O.X_TIP) - 0.005),
    'light_nav_R': ((O.X_TIP - 0.06), O.w_le(O.X_TIP - 0.06) + 0.22, O.w_zc(O.X_TIP) - 0.005),
    'light_strobe_L': (-(O.X_TIP - 0.05), 13.55, O.w_zc(O.X_TIP) + 0.01),
    'light_strobe_R': ((O.X_TIP - 0.05), 13.55, O.w_zc(O.X_TIP) + 0.01),
    'light_tail': (-1.58, A.BOOM_S1 - 0.03, 0.0),
    'light_beacon_top': (0.0, 9.9, 0.66),
    'light_beacon_bottom': (0.0, 13.0, -0.95),
}


def _strip(bm, pts, normal, width, up=None, mat=0):
    n = Vector(normal).normalized()
    rows = []
    for i, p in enumerate(pts):
        a = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        side = n.cross(a).normalized() if up is None else Vector(up).normalized()
        rows.append([tuple(p - side * width / 2), tuple(p + side * width / 2)])
    n0 = len(bm.faces)
    G.bm_grid(bm, np.array(rows), mat=mat)
    for f in list(bm.faces)[n0:]:
        f.normal_update()
        if f.normal.dot(n) < 0:
            f.normal_flip()


def build_formation_strips():
    """Thin emissive strips (formation lights): forward fuselage below the chine, wingtips, fins (outboard)."""
    bm = bmesh.new()
    for sign in (1, -1):
        pts = []
        for s in np.linspace(3.2, 4.1, 6):
            xc, zc = O.x_ch_fore(s), O.z_ch_fore(s)
            pts.append(Vector((sign * (xc - 0.03), Y(s), zc - 0.06)))
        _strip(bm, pts, Vector((sign, 0, -0.5)), 0.045)
        # wingtip upper surface along the tip chord
        x = O.X_TIP - 0.12
        pts = []
        for v in np.linspace(0.25, 0.75, 6):
            p = O.wing_pt(x, v, True)
            pts.append(Vector((sign * p[0], Y(p[1]), p[2] + 0.003)))
        _strip(bm, pts, Vector((0, 0, 1)), 0.04)
        # fin: outboard face, parallel to the leading edge near the top (ref: side_langley)
        pts = []
        d, n = SF.fin_frame(sign)
        for h in np.linspace(SF.FIN_H - 1.05, SF.FIN_H - 0.25, 6):
            pts.append(SF.fin_pt(h, 0.16, True, sign) + n * 0.003)
        _strip(bm, pts, n, 0.035)
        # aft fuselage / boom top
        pts = [Vector((sign * 1.72, Y(s), A.boom_section(s)[0][1] + 0.004)) for s in np.linspace(15.6, 16.7, 5)]
        _strip(bm, pts, Vector((0, 0, 1)), 0.03)
    return bm


def build_lenses():
    """Lens fairings: mat 0 red (left tip), 1 green (right tip), 2 clear (strobes / tail / beacons)."""
    bm = bmesh.new()
    centers = []
    for name, (x, s, z) in LIGHTS.items():
        mat = 0 if name == 'light_nav_L' else 1 if name == 'light_nav_R' else 2
        c = Vector((x, Y(s), z))
        if name == 'light_tail':
            axis = Vector((0, -1, 0))
        elif name.startswith('light_beacon'):
            axis = Vector((0, 0, 1 if 'top' in name else -1))
        else:
            axis = Vector((math.copysign(1, x), 0, 0))
        prof = [(0.0, 0.022), (0.018, 0.019), (0.030, 0.011), (0.036, 0.0)]
        G.bm_revolve(bm, [(r, h - 0.008) for (r, h) in prof], c, axis, seg=12, mat=mat)
        centers.append(c)
    G.weld(bm, 1e-6)
    for f in bm.faces:
        f.normal_update()
        fc = f.calc_center_median()
        cc = min(centers, key=lambda q: (q - fc).length)
        if f.normal.dot(fc - cc) < 0:
            f.normal_flip()
    G.smooth_sharp(bm, 60)
    return bm
