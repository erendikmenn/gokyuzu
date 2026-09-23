"""Golden Gate Bridge (W3). Real dimensions; positions/orientation from OSM (blender/landmarks/layout.json).

Run:  Blender -b -P blender/landmarks/golden_gate.py
Outputs: assets/sf/landmarks/golden_gate{,_lod1,_lod2}.glb + golden_gate.json (collision, lights, LOD info).

Frame: origin = midspan between the tower centers at mean sea level. +Y = along the bridge towards Marin (heading
354.4 deg), +X = east side, +Z = up (meters MSL).
Reference numbers: main span 1280.2 m (4200 ft), side spans 343 m, towers 227.4 m above water, deck ~67 m clearance,
roadway ~75 m, stiffening truss 7.62 m (25 ft) deep, cables 0.924 m (36 3/8 in) at 27.43 m (90 ft) centers,
sag 144 m, suspenders every 15.24 m (50 ft). Tower-leg setbacks from OSM building:part levels.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from lmkit import (MB, V, Meta, LAYOUT, OUT, material, export, tri_count, reset_scene, norm)  # noqa: E402
import tex_common as tx  # noqa: E402

G = LAYOUT['golden_gate']
HALF = G['mainSpan'] / 2.0          # 640.05
T_S, T_N = -HALF, HALF              # tower centers (s)
CX = 13.716                         # cable / truss / leg centerline offset (45 ft)
TRUSS_D = 7.62
S1, S2 = -981.0, -1094.0            # pylon centers (from OSM)
N1, N2 = 984.3, 1084.2
ANCH_S = (-1199.9, -1098.8)
ANCH_N = (979.5, 1089.2)
SOUTH_END, NORTH_END = -1316.0, 1406.0
PANEL = 7.62

# ------------------------------------------------------------------------------------------------ profile functions


GRADE_S, GRADE_N = 0.0225, 0.0174   # calibrated on the 3DEP DEM: toll plaza side meets grade ~58 m, Marin ~60 m


def E(s):
    """Roadway surface elevation (m MSL): crest vertical curve on the main span, straight grades beyond the towers."""
    a = abs(s)
    if a <= HALF:
        return 73.2 + 3.0 * (1 - (a / HALF) ** 2)
    return 73.2 - (a - HALF) * (GRADE_S if s < 0 else GRADE_N)


CABLE_LOW = 78.0
SADDLE = 222.0


def cable_z(s):
    a = abs(s)
    if a <= HALF:
        return CABLE_LOW + (SADDLE - CABLE_LOW) * (a / HALF) ** 2
    end = abs(S1) if s < 0 else N1
    if a <= end:
        t = (a - HALF) / (end - HALF)
        z_end = E(end) + 9.5
        return SADDLE + (z_end - SADDLE) * t - 4 * 10.3 * t * (1 - t)
    # backstay: straight down into the anchorage
    anch = 1112.0 if s < 0 else 1040.0
    z0 = E(end) + 9.5
    z1 = E(anch) - 3.0
    t = min(1.0, (a - end) / (anch - end))
    return z0 + (z1 - z0) * t


def cable_end(s_sign):
    return -1112.0 if s_sign < 0 else 1040.0


# roadway centerline offset (approach curves) from the OSM carriageway lines
def _line_r(line, s):
    pts = sorted(line, key=lambda p: p[1])
    ss = [p[1] for p in pts]
    rr = [p[0] for p in pts]
    if s < ss[0] or s > ss[-1]:
        return None
    return float(np.interp(s, ss, rr))


_LINES = G['roadLines']


def rc(s):
    if -1200.0 <= s <= 1090.0:
        return 0.0
    vals = [v for v in (_line_r(l, s) for l in _LINES) if v is not None]
    if len(vals) >= 2:
        vals.sort()
        r = (vals[0] + vals[-1]) / 2.0
    elif vals:
        r = vals[0] + (-4.3 if s < 0 else 4.3) * 0
    else:
        r = 0.0
    # blend from the straight part
    edge = -1200.0 if s < 0 else 1090.0
    w = min(1.0, abs(s - edge) / 60.0)
    return r * w


_RC_CACHE = {}


def rc_s(s):
    """Smoothed centerline offset."""
    k = round(s, 2)
    if k not in _RC_CACHE:
        _RC_CACHE[k] = sum(rc(s + d) for d in (-12, -6, 0, 6, 12)) / 5.0
    return _RC_CACHE[k]


class Path:
    """Roadway centerline: straight between the anchorages, curving on the approaches."""

    def c(self, s):
        return V(rc_s(s), s)

    def t(self, s):
        a, b = self.c(s - 1.0), self.c(s + 1.0)
        return norm(b - a)

    def pt(self, s, x, dz, zfun=None):
        c = self.c(s)
        t = self.t(s)
        n = V(t[1], -t[0])        # right-hand normal
        z = (zfun or E)(s) + dz
        p = c + n * x
        return V(p[0], p[1], z)


PATH = Path()

# ------------------------------------------------------------------------------------------------ materials


def make_materials(lod=0):
    """Full PBR set for LOD0; small textures for LOD1; flat colors for LOD2 (keeps far LOD files tiny)."""
    orange = '#C63D26'
    if lod == 2:
        c = tx.srgb_to_linear(orange)
        return {
            'paint': material('ggb2_paint', color=c, rough=0.6),
            'tower': material('ggb2_tower_emit', color=c, rough=0.6, emissive=(1.0, 0.42, 0.22), emissive_strength=0.3),
            'cable': material('ggb2_cable', color=c, rough=0.55),
            'concrete': material('ggb2_concrete', color=(0.42, 0.40, 0.36), rough=0.9),
            'road': material('ggb2_road', color=(0.05, 0.05, 0.055), rough=0.9),
            'walk': material('ggb2_walk', color=(0.30, 0.29, 0.27), rough=0.9),
            'rail': material('ggb2_rail_clip', color=c, rough=0.6),
            'truss': material('ggb2_truss', color=c, rough=0.6),
            'steel': material('ggb2_barrier', color=(0.3, 0.3, 0.29), rough=0.6),
            'lamp': material('ggb2_lamp_emit', color=(0.9, 0.8, 0.6), emissive=(1.0, 0.72, 0.38), emissive_strength=2.0),
            'warn': material('ggb2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        }
    if lod == 1:
        pa, _, _ = tx.paint_textures(base=orange, name='ggb1_paint', seed=11, size=256, seams=False)
        ca, _, _ = tx.concrete_textures('ggb1_concrete', base=(0.50, 0.47, 0.42), seed=23, size=256)
        road = tx.road_texture('ggb1_road', lanes=6, width=18.6, w=256, h=256)
        truss = tx.truss_texture('ggb1_truss', color=orange, size=128, lacing=False)
        rail = tx.railing_texture('ggb1_rail', color=orange, w=64, h=64)
        return {
            'paint': material('ggb1_paint', albedo=pa, rough=0.6),
            'tower': material('ggb1_tower_emit', albedo=pa, rough=0.6, emissive=(1.0, 0.42, 0.22), emissive_strength=0.3),
            'cable': material('ggb1_cable', albedo=pa, rough=0.55),
            'concrete': material('ggb1_concrete', albedo=ca, rough=0.9),
            'road': material('ggb1_road', albedo=road, rough=0.9),
            'walk': material('ggb1_walk', color=(0.32, 0.31, 0.29), rough=0.9),
            'rail': material('ggb1_rail_clip', albedo=rail, alpha_img=True, rough=0.6, double_sided=True),
            'truss': material('ggb1_truss_clip', albedo=truss, alpha_img=True, rough=0.6, double_sided=True),
            'steel': material('ggb1_barrier', color=(0.3, 0.3, 0.29), rough=0.6),
            'lamp': material('ggb1_lamp_emit', color=(0.9, 0.8, 0.6), emissive=(1.0, 0.72, 0.38), emissive_strength=2.0),
            'warn': material('ggb1_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        }
    pa, pr, pn = tx.paint_textures(base=orange)
    ca, cr, cn = tx.concrete_textures('ggb_concrete', base=(0.50, 0.47, 0.42), seed=23)
    road = tx.road_texture('ggb_road', lanes=6, width=18.6)
    walk = tx.walk_texture('ggb_walk')
    rail = tx.railing_texture('ggb_rail', color=orange)
    cable_a, _, _ = tx.paint_textures(base=orange, name='ggb_cable', seed=17, seams=False, size=512)
    return {
        'paint': material('ggb_paint', albedo=pa, rough_img=pr, normal=pn, normal_strength=0.8),
        # towers: same paint + night floodlighting (the runtime scales *_emit materials with the night factor)
        'tower': material('ggb_tower_emit', albedo=pa, rough_img=pr, normal=pn, normal_strength=0.8,
                          emissive=(1.0, 0.42, 0.22), emissive_strength=0.3),
        'cable': material('ggb_cable', albedo=cable_a, rough=0.5),
        'concrete': material('ggb_concrete', albedo=ca, normal=cn, rough=0.88),
        'road': material('ggb_road', albedo=road, rough=0.9),
        'walk': material('ggb_walk', albedo=walk, rough=0.85),
        'rail': material('ggb_rail_clip', albedo=rail, alpha_img=True, rough=0.55, double_sided=True),
        'truss': material('ggb_truss_clip', albedo=rail, alpha_img=True, rough=0.6, double_sided=True),
        'steel': material('ggb_barrier', color=(0.55, 0.55, 0.53), rough=0.6),
        'lamp': material('ggb_lamp_emit', color=(0.9, 0.8, 0.6), emissive=(1.0, 0.72, 0.38), emissive_strength=2.0),
        'warn': material('ggb_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        'net': material('ggb_net_blend', color=(0.55, 0.57, 0.58), alpha=0.32, blend=True, double_sided=True, rough=0.4, metal=0.6),
    }


# ------------------------------------------------------------------------------------------------ builder
AO_UNDER = (0.62, 0.60, 0.60)
AO_MID = (0.82, 0.80, 0.80)
WHITE = (1.0, 1.0, 1.0)

# leg sections: (z0, z1, inner, outer, along_half)  -- OSM building:part levels (tops 21/74/123/162/195/225)
LEG = [
    (13.0, 21.0, 8.9, 18.5, 7.8),
    (21.0, 74.0, 10.0, 17.45, 6.9),
    (74.0, 123.0, 10.0, 17.45, 5.85),
    (123.0, 162.0, 10.0, 17.45, 4.9),
    (162.0, 195.0, 11.1, 16.35, 4.9),
    (195.0, 223.0, 11.6, 15.85, 4.0),
]
# portal struts above the deck: (bottom, top) ; OSM strut tops 121/161/193/223
STRUTS = [(111.0, 121.0), (153.0, 161.0), (185.5, 193.0), (213.5, 223.0)]


class Bridge:
    def __init__(self, lod, M):
        self.lod = lod
        self.M = M
        self.mb = {k: MB(k) for k in M}
        self.meta = Meta('golden_gate', 'Golden Gate Köprüsü') if lod == 0 else None

    # --------------------------------------------------------------------------------------- towers
    def fluted_face(self, mb, o, t, n, W, z0, z1, depth=0.28, pitch=1.3, pil=None, col=WHITE, ts=4.0):
        """Vertical face with recessed flutes. o = bottom-left corner (seen from outside), t = unit along width,
        n = outward normal."""
        o, t, n = V(o), V(t), V(n)
        up = V(0, 0, 1)
        pil = pil if pil is not None else min(1.1, W * 0.14)
        inner_w = W - 2 * pil
        k = max(1, int(round(inner_w / pitch)))
        if k % 2 == 0:
            k += 1                      # odd count: groove, rib, groove, ... groove
        seg = inner_w / k
        xs = [0.0, pil] + [pil + seg * (i + 1) for i in range(k)]
        xs[-1] = W - pil
        xs.append(W)
        for i in range(len(xs) - 1):
            a, b = xs[i], xs[i + 1]
            rec = (i >= 1 and i < len(xs) - 2 and (i - 1) % 2 == 0)
            d = -depth if rec else 0.0
            pa = o + t * a + n * d
            pb = o + t * b + n * d
            mb.quad(pa + up * z0, pb + up * z0, pb + up * z1, pa + up * z1, ts, col=col)
            if rec:
                # side walls of the groove
                qa, qb = o + t * a, o + t * b
                mb.quad(qa + up * z0, pa + up * z0, pa + up * z1, qa + up * z1, ts, col=col)
                mb.quad(pb + up * z0, qb + up * z0, qb + up * z1, pb + up * z1, ts, col=col)

    def rect_section(self, mb, x0, x1, y0, y1, z0, z1, fluted=True, bottom=False, col=WHITE, top=True):
        """Axis-aligned leg block with fluted faces (x0<x1, y0<y1)."""
        if fluted and self.lod == 0:
            self.fluted_face(mb, (x0, y0, 0), (1, 0, 0), (0, -1, 0), x1 - x0, z0, z1, col=col)     # front (-Y)
            self.fluted_face(mb, (x1, y1, 0), (-1, 0, 0), (0, 1, 0), x1 - x0, z0, z1, col=col)     # back (+Y)
            self.fluted_face(mb, (x1, y0, 0), (0, 1, 0), (1, 0, 0), y1 - y0, z0, z1, col=col)      # +X side
            self.fluted_face(mb, (x0, y1, 0), (0, -1, 0), (-1, 0, 0), y1 - y0, z0, z1, col=col)    # -X side
            faces = ('Z' if top else '') + ('z' if bottom else '')
            if faces:
                mb.box((x0, y0, z0), (x1, y1, z1), faces=faces, col=col)
        else:
            mb.box((x0, y0, z0), (x1, y1, z1), faces='xXyY' + ('Z' if top else '') + ('z' if bottom else ''), col=col)

    def tower(self, sc, south):
        mb = self.mb['tower']
        lod = self.lod
        for side in (-1, 1):
            for i, (z0, z1, inner, outer, ah) in enumerate(LEG):
                x0, x1 = sorted((side * inner, side * outer))
                col = (0.86, 0.84, 0.84) if z0 < 30 else WHITE
                if lod == 2:
                    continue
                self.rect_section(mb, x0, x1, sc - ah, sc + ah, z0, z1, fluted=True, bottom=(i == 0), col=col)
                # art-deco setback ledge chamfer (small step) at the top of each section
                if lod == 0 and i < len(LEG) - 1:
                    nz0, nz1, ninner, nouter, nah = LEG[i + 1]
                    nx0, nx1 = sorted((side * ninner, side * nouter))
                    mb.box((nx0 - 0.35, sc - nah - 0.35, z1), (nx1 + 0.35, sc + nah + 0.35, z1 + 0.7), faces='xXyYZ')
            if lod == 2:
                x0, x1 = sorted((side * 10.5, side * 17.0))
                mb.box((x0, sc - 6.0, 13.0), (x1, sc + 6.0, 223.0), faces='xXyYZ')
            # leg top: stepped cap over the cable saddle + lamp mast
            ztop = LEG[-1][1]
            inner, outer, ah = LEG[-1][2], LEG[-1][3], LEG[-1][4]
            cx = side * (inner + outer) / 2
            hw = (outer - inner) / 2
            steps = [(ztop, ztop + 1.2, hw + 0.25, ah + 0.25), (ztop + 1.2, ztop + 2.2, hw - 0.2, ah - 0.6),
                     (ztop + 2.2, ztop + 2.9, hw - 0.7, ah - 1.6)] if lod < 2 else [(ztop, ztop + 2.9, hw, ah)]
            for zz0, zz1, hx, hy in steps:
                mb.box((cx - hx, sc - hy, zz0), (cx + hx, sc + hy, zz1), faces='xXyYZ')
            # saddle housing hump (where the cable enters), front and back
            if lod == 0:
                for sgn in (-1, 1):
                    self.mb['paint'].box((cx - 1.2, sc + sgn * ah - (0.0 if sgn > 0 else 1.6), ztop - 3.0),
                                         (cx + 1.2, sc + sgn * ah + (1.6 if sgn > 0 else 0.0), ztop - 0.2), faces='xXyYZz')
            # aviation light mast
            self.mb['paint'].cylinder((cx, sc, ztop + 2.9), 0.25, 1.6, sides=8)
            self.mb['warn'].cylinder((cx, sc, ztop + 4.5), 0.35, 0.6, sides=8, cap_top=True)
            if self.meta:
                self.meta.light((cx, sc, ztop + 4.8), '#ff2a14', size=6.0, period=1.5, duty=0.5, phase=0.0 if south else 0.75)
                # mid-height obstruction lights on the outer faces
                self.meta.light((side * (outer + 0.6), sc, 150.0), '#ff2a14', size=4.0, period=1.5, duty=0.5, phase=0.0 if south else 0.75)
            if lod < 2:
                wx0, wx1 = sorted((side * (outer + 0.1), side * (outer + 0.7)))
                self.mb['warn'].box((wx0, sc - 0.4, 149.6), (wx1, sc + 0.4, 150.4))

        # ---- portal struts above the deck
        for zb, zt in STRUTS:
            inner = [l for l in LEG if l[0] <= zb + 1e-6 < l[1] or l[0] < zt <= l[1]][0][2]
            if lod == 2:
                mb.box((-inner, sc - 1.9, zb), (inner, sc + 1.9, zt), faces='yYzZ')
                continue
            # main strut body with vertical ribs on both faces
            if lod == 0:
                self.fluted_face(mb, (-inner, sc - 1.9, 0), (1, 0, 0), (0, -1, 0), 2 * inner, zb, zt, depth=0.35, pitch=0.9, pil=0.6)
                self.fluted_face(mb, (inner, sc + 1.9, 0), (-1, 0, 0), (0, 1, 0), 2 * inner, zb, zt, depth=0.35, pitch=0.9, pil=0.6)
                mb.box((-inner, sc - 1.9, zb), (inner, sc + 1.9, zt), faces='zZ')
                # horizontal cornice band on top and a recessed soffit step below
                mb.box((-inner, sc - 2.2, zt - 1.0), (inner, sc + 2.2, zt), faces='yYzZ')
                mb.box((-inner, sc - 1.6, zb - 0.6), (inner, sc + 1.6, zb), faces='yYz')
                # stepped art-deco corbels at both ends of the strut
                for side in (-1, 1):
                    for k, (dz, dx) in enumerate(((1.4, 2.2), (1.2, 1.2), (1.0, 0.5))):
                        z_hi = zb - 0.6 - sum(d for d, _ in ((1.4, 0), (1.2, 0), (1.0, 0))[:k])
                        x0, x1 = sorted((side * inner, side * (inner - dx)))
                        mb.box((x0, sc - 1.6, z_hi - dz), (x1, sc + 1.6, z_hi), faces='xXyYz')
            else:
                mb.box((-inner, sc - 1.9, zb), (inner, sc + 1.9, zt), faces='yYzZ')
            if self.meta:
                self.meta.box((-inner, sc - 2.2, zb - 1.0), (inner, sc + 2.2, zt), 'Golden Gate Köprüsü')

        # ---- below-deck bracing: struts + X braces in the tower plane
        inner = LEG[1][2]
        if lod < 2:
            for zb, zt in ((21.5, 26.0), (47.5, 52.0), (61.5, 65.2)):
                if lod == 0:
                    self.fluted_face(mb, (-inner, sc - 1.9, 0), (1, 0, 0), (0, -1, 0), 2 * inner, zb, zt, depth=0.3, pitch=1.0, pil=0.5, col=AO_MID)
                    self.fluted_face(mb, (inner, sc + 1.9, 0), (-1, 0, 0), (0, 1, 0), 2 * inner, zb, zt, depth=0.3, pitch=1.0, pil=0.5, col=AO_MID)
                    mb.box((-inner, sc - 1.9, zb), (inner, sc + 1.9, zt), faces='zZ', col=AO_MID)
                else:
                    mb.box((-inner, sc - 1.9, zb), (inner, sc + 1.9, zt), faces='yYzZ', col=AO_MID)
            for za, zb_ in ((26.0, 47.5), (52.0, 61.5)):
                for sgn in (-1, 1):
                    mb.beam((-inner * sgn, sc, za), (inner * sgn, sc, zb_), 1.4, 2.6, up=(0, 1, 0), col=AO_MID)
        if self.meta:
            for side in (-1, 1):
                x0, x1 = sorted((side * LEG[0][2], side * LEG[0][3]))
                self.meta.box((x0, sc - 7.8, -5.0), (x1, sc + 7.8, 227.4), 'Golden Gate Köprüsü')
            self.meta.box((-10.0, sc - 2.0, 21.5), (10.0, sc + 2.0, 65.2), 'Golden Gate Köprüsü')

        # ---- concrete pier (+ south tower fender ring)
        cm = self.mb['concrete']
        cm.box((-21.05, sc - 10.1, -12.0), (21.05, sc + 10.1, 13.0), ts=8.0, faces='xXyYZ', col=(0.9, 0.9, 0.88))
        if lod < 2:
            cm.box((-22.5, sc - 11.6, -12.0), (22.5, sc + 11.6, 2.5), ts=8.0, faces='xXyYZ', col=(0.62, 0.6, 0.56))
        if self.meta:
            self.meta.box((-22.5, sc - 11.6, -12.0), (22.5, sc + 11.6, 13.0), 'Golden Gate Köprüsü')
            self.meta.light((0.0, sc - 11.8, 8.0), '#ff2a14', size=3.0, period=0.0, kind='nav')
            self.meta.light((0.0, sc + 11.8, 8.0), '#ff2a14', size=3.0, period=0.0, kind='nav')
        if south and lod < 2:
            self.fender(sc)

    def fender(self, sc):
        cm = self.mb['concrete']
        n = 24 if self.lod == 0 else 12
        A, B, wall = 37.5, 23.0, 3.5            # half-lengths across (x) and along (y), measured on NAIP imagery

        def stadium(a, b, k):
            pts = []
            r = b
            straight = a - b
            for i in range(k):
                t = 2 * math.pi * i / k
                cx = straight if math.cos(t) >= 0 else -straight
                pts.append((cx + r * math.cos(t), sc + r * math.sin(t)))
            return pts
        outer = stadium(A, B, n)
        inner = stadium(A - wall, B - wall, n)
        z0, z1 = -8.0, 5.0
        for i in range(n):
            a, b = outer[i], outer[(i + 1) % n]
            cm.quad((a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1), 8.0, col=(0.75, 0.73, 0.7))
            a2, b2 = inner[i], inner[(i + 1) % n]
            cm.quad((b2[0], b2[1], z0), (a2[0], a2[1], z0), (a2[0], a2[1], z1), (b2[0], b2[1], z1), 8.0, col=(0.7, 0.68, 0.65))
            cm.quad((a[0], a[1], z1), (b[0], b[1], z1), (b2[0], b2[1], z1), (a2[0], a2[1], z1), 8.0)
        if self.meta:
            self.meta.box((-A, sc - B, -8.0), (A, sc + B, 5.0), 'Golden Gate Köprüsü')

    # --------------------------------------------------------------------------------------- deck
    def stations(self, s0, s1, step):
        n = max(1, int(round((s1 - s0) / step)))
        return [s0 + (s1 - s0) * i / n for i in range(n + 1)]

    def deck_surface(self, st, zfun=None, sidewalks=True, curved=False):
        """Roadway, median, barriers, sidewalks, railings, slab underside along stations st."""
        P = PATH
        road, walk, paint, steel, rail = self.mb['road'], self.mb['walk'], self.mb['paint'], self.mb['steel'], self.mb['rail']
        lod = self.lod
        zf = zfun or E
        arc = 0.0
        for i in range(len(st) - 1):
            a, b = st[i], st[i + 1]
            seg = float(np.linalg.norm(P.pt(b, 0, 0, zf)[:2] - P.pt(a, 0, 0, zf)[:2]))
            va, vb = arc / 12.192, (arc + seg) / 12.192
            arc += seg
            q = lambda s, x, dz: P.pt(s, x, dz, zf)
            # asphalt
            road.quad(q(a, -9.3, 0), q(a, 9.3, 0), q(b, 9.3, 0), q(b, -9.3, 0), uv=[(0, va), (1, va), (1, vb), (0, vb)])
            if lod == 2:
                paint.quad(q(a, 13.9, -1.0), q(a, -13.9, -1.0), q(b, -13.9, -1.0), q(b, 13.9, -1.0), 8.0)
                continue
            # median movable barrier
            if lod == 0:
                steel.quad(q(a, 0.3, 0), q(b, 0.3, 0), q(b, 0.18, 0.82), q(a, 0.18, 0.82), 2.0)
                steel.quad(q(b, -0.3, 0), q(a, -0.3, 0), q(a, -0.18, 0.82), q(b, -0.18, 0.82), 2.0)
                steel.quad(q(a, -0.18, 0.82), q(a, 0.18, 0.82), q(b, 0.18, 0.82), q(b, -0.18, 0.82), 2.0)
            if not sidewalks:
                continue
            for sgn in (-1, 1):
                # concrete curb + open steel barrier railing between roadway and sidewalk
                xa, xb = sgn * 9.3, sgn * 9.6
                lo, hi = sorted((xa, xb))
                walk.quad(q(a, lo, 0.25), q(a, hi, 0.25), q(b, hi, 0.25), q(b, lo, 0.25), 3.0)
                if sgn > 0:
                    walk.quad(q(b, xa, 0), q(a, xa, 0), q(a, xa, 0.25), q(b, xa, 0.25), 3.0)
                    rail.quad(q(a, 9.45, 0.25), q(b, 9.45, 0.25), q(b, 9.45, 1.15), q(a, 9.45, 1.15), uv=[((arc - seg) / 1.524, 0), (arc / 1.524, 0), (arc / 1.524, 1), ((arc - seg) / 1.524, 1)])
                else:
                    walk.quad(q(a, xa, 0), q(b, xa, 0), q(b, xa, 0.25), q(a, xa, 0.25), 3.0)
                    rail.quad(q(b, -9.45, 0.25), q(a, -9.45, 0.25), q(a, -9.45, 1.15), q(b, -9.45, 1.15), uv=[(arc / 1.524, 0), ((arc - seg) / 1.524, 0), ((arc - seg) / 1.524, 1), (arc / 1.524, 1)])
                # sidewalk slab
                w0, w1 = sorted((sgn * 9.6, sgn * 12.95))
                walk.quad(q(a, w0, 0.18), q(a, w1, 0.18), q(b, w1, 0.18), q(b, w0, 0.18), 3.0)
                # outer railing (alpha texture), both faces
                xr = sgn * 13.05
                ra, rb = arc - seg, arc
                if sgn > 0:
                    rail.quad(q(a, xr, 0.18), q(b, xr, 0.18), q(b, xr, 1.42), q(a, xr, 1.42), uv=[(ra / 1.524, 0), (rb / 1.524, 0), (rb / 1.524, 1), (ra / 1.524, 1)])
                else:
                    rail.quad(q(b, xr, 0.18), q(a, xr, 0.18), q(a, xr, 1.42), q(b, xr, 1.42), uv=[(rb / 1.524, 0), (ra / 1.524, 0), (ra / 1.524, 1), (rb / 1.524, 1)])
                # outer fascia (edge of deck/sidewalk, steel)
                xo = sgn * 13.3
                if sgn > 0:
                    paint.quad(q(a, xo, -0.9), q(b, xo, -0.9), q(b, xo, 0.18), q(a, xo, 0.18), 2.0)
                else:
                    paint.quad(q(b, xo, -0.9), q(a, xo, -0.9), q(a, xo, 0.18), q(b, xo, 0.18), 2.0)
                o0, o1 = sorted((sgn * 12.95, sgn * 13.3))
                paint.quad(q(a, o0, 0.18), q(a, o1, 0.18), q(b, o1, 0.18), q(b, o0, 0.18), 2.0)
            # slab underside
            paint.quad(q(a, 13.3, -0.9), q(a, -13.3, -0.9), q(b, -13.3, -0.9), q(b, 13.3, -0.9), 4.0, col=AO_UNDER)
        return arc

    def deck_collision(self, s0, s1, top_dz=0.4, bot_dz=-7.8, half_w=14.0, step=40.0):
        if not self.meta:
            return
        st = self.stations(s0, s1, step)
        for a, b in zip(st[:-1], st[1:]):
            m = (a + b) / 2
            pa, pb = PATH.pt(a, 0, 0), PATH.pt(b, 0, 0)
            c = (pa + pb) / 2
            d = pb - pa
            L = float(np.linalg.norm(d[:2]))
            ztop = max(E(a), E(b)) + top_dz
            zbot = min(E(a), E(b)) + bot_dz
            cz = (ztop + zbot) / 2
            self.meta.obox((c[0], c[1], cz), (d[0], d[1]), half_w, L / 2 + 0.5, (ztop - zbot) / 2, 'Golden Gate Köprüsü')

    def stiffening_truss(self, s0, s1, npan):
        """Two Warren trusses with verticals at x = +-CX, floor beams, stringers, bottom lateral bracing."""
        paint = self.mb['paint']
        lod = self.lod
        nodes = [s0 + (s1 - s0) * k / npan for k in range(npan + 1)]
        if lod == 2:
            idx = list(range(0, npan + 1, 4))
            if idx[-1] != npan:
                idx.append(npan)
            coarse = [nodes[i] for i in idx]
            for sgn in (-1, 1):
                x = sgn * (CX + 0.2)
                for a, b in zip(coarse[:-1], coarse[1:]):
                    if sgn > 0:
                        paint.quad((x, a, E(a) - TRUSS_D), (x, b, E(b) - TRUSS_D), (x, b, E(b) - 0.9), (x, a, E(a) - 0.9), 8.0, col=AO_MID)
                    else:
                        paint.quad((x, b, E(b) - TRUSS_D), (x, a, E(a) - TRUSS_D), (x, a, E(a) - 0.9), (x, b, E(b) - 0.9), 8.0, col=AO_MID)
            return
        if lod == 1:
            tm = self.mb['truss']
            for sgn in (-1, 1):
                for off in (-0.45, 0.45):
                    x = sgn * CX + off
                    for k, (a, b) in enumerate(zip(nodes[:-1], nodes[1:])):
                        u0, u1 = (0, 1) if k % 2 == 0 else (1, 0)
                        za, zb = E(a) - 0.1, E(b) - 0.1
                        tm.quad((x, a, za - TRUSS_D), (x, b, zb - TRUSS_D), (x, b, zb), (x, a, za), uv=[(u0, 0), (u1, 0), (u1, 1), (u0, 1)])
            # floor system as a dark plate + a few beams
            for a, b in zip(nodes[:-1], nodes[1:]):
                paint.quad((CX, a, E(a) - 2.9), (-CX, a, E(a) - 2.9), (-CX, b, E(b) - 2.9), (CX, b, E(b) - 2.9), 6.0, col=AO_UNDER)
            return
        for sgn in (-1, 1):
            x = sgn * CX
            top = [V(x, s, E(s) - 0.55) for s in nodes]
            bot = [V(x, s, E(s) - TRUSS_D + 0.55) for s in nodes]
            for k in range(npan):
                paint.beam(top[k], top[k + 1], 1.1, 1.0, ts=4.0)
                paint.beam(bot[k], bot[k + 1], 1.1, 1.0, ts=4.0, col=AO_MID)
                if k % 2 == 0:
                    paint.beam(bot[k], top[k + 1], 0.75, 0.8, up=(1, 0, 0), ts=4.0, col=AO_MID)
                else:
                    paint.beam(top[k], bot[k + 1], 0.75, 0.8, up=(1, 0, 0), ts=4.0, col=AO_MID)
            for k in range(npan + 1):
                paint.beam(bot[k] + V(0, 0, 0.5), top[k] - V(0, 0, 0.5), 0.7, 0.8, up=(1, 0, 0), ts=4.0, col=AO_MID, caps=False)
                # gusset plates at the top chord nodes (outer face)
                paint.box((x + sgn * 0.55 - 0.03, nodes[k] - 0.9, E(nodes[k]) - 2.2), (x + sgn * 0.55 + 0.03, nodes[k] + 0.9, E(nodes[k]) - 0.2), faces='xX', col=AO_MID)
        # floor beams, stringers, lateral bracing
        for k, s in enumerate(nodes):
            z = E(s) - 0.9 - 1.25
            paint.beam((-CX, s, z), (CX, s, z), 0.6, 2.5, ts=4.0, col=AO_UNDER, caps=False)
        for xs in (-10.6, -6.4, -2.1, 2.1, 6.4, 10.6):
            for a, b in zip(nodes[:-1], nodes[1:]):
                paint.beam((xs, a, E(a) - 1.6), (xs, b, E(b) - 1.6), 0.35, 1.4, ts=4.0, col=AO_UNDER, caps=False)
        for k in range(0, npan - 1, 2):
            a, b = nodes[k], nodes[k + 2]
            za, zb = E(a) - TRUSS_D + 0.55, E(b) - TRUSS_D + 0.55
            paint.beam((-CX, a, za), (CX, b, zb), 0.5, 0.5, ts=4.0, col=AO_UNDER)
            paint.beam((CX, a, za), (-CX, b, zb), 0.5, 0.5, ts=4.0, col=AO_UNDER)

    # --------------------------------------------------------------------------------------- cables
    def cable_points(self, side_x, step):
        pts = []
        s = cable_end(-1)
        while s < cable_end(1) - 1e-6:
            pts.append(V(side_x, s, cable_z(s)))
            a = abs(s)
            st = step if a > HALF + 2 else step
            # finer near the saddles (kink)
            if abs(a - HALF) < 12:
                st = min(step, 2.0)
            s += st
        pts.append(V(side_x, cable_end(1), cable_z(cable_end(1))))
        # force exact saddle points
        return pts

    def suspender_positions(self):
        pos = []
        k = int(math.floor((HALF - 10.0) / 15.24))
        for i in range(-k, k + 1):
            pos.append(i * 15.24)
        for sgn, end in ((-1, abs(S1)), (1, N1)):
            s = HALF + 15.24
            while s < end - 6.0:
                pos.append(sgn * s)
                s += 15.24
        return sorted(pos)

    def cables(self):
        lod = self.lod
        cm = self.mb['cable']
        sides = {0: 16, 1: 8, 2: 6}[lod]
        step = {0: 4.0, 1: 12.0, 2: 30.0}[lod]
        for sgn in (-1, 1):
            x = sgn * CX
            pts = self.cable_points(x, step)
            cm.tube(pts, 0.462, sides=sides, ts=3.0)
            if self.meta:
                # capsules along the cable
                cp = self.cable_points(x, 30.0)
                for a, b in zip(cp[:-1], cp[1:]):
                    self.meta.capsule(a, b, 0.8, 'Golden Gate Köprüsü')
        if lod == 2:
            return
        pos = self.suspender_positions()
        for sgn in (-1, 1):
            x = sgn * CX
            for s in pos:
                zc = cable_z(s)
                ze = E(s) - 0.05
                if lod == 0:
                    # cable band
                    d = norm(V(0, 1, (cable_z(s + 0.5) - cable_z(s - 0.5))))
                    cm.tube([V(x, s, zc) - d * 0.75, V(x, s, zc) + d * 0.75], 0.56, sides=10, closed_ends=True, ts=3.0)
                    for off in (-0.42, 0.42):
                        cm.tube([V(x + off, s, zc - 0.3), V(x + off, s, ze)], 0.036, sides=4, ts=3.0)
                    # clamp/socket at the truss top chord
                    cm.box((x - 0.5, s - 0.18, ze - 0.05), (x + 0.5, s + 0.18, ze + 0.45), faces='xXyYZ')
                else:
                    for off in (-0.42, 0.42):
                        cm.beam((x + off, s, zc), (x + off, s, ze), 0.1, 0.1, up=(1, 0, 0), caps=False)
                if self.meta and zc - ze > 2.5:
                    self.meta.capsule((x, s, ze + 1.0), (x, s, zc - 0.5), 0.25, 'Golden Gate Köprüsü')
        if lod == 0:
            # hand ropes + posts above each cable (maintenance walkway)
            for sgn in (-1, 1):
                x = sgn * CX
                pts = self.cable_points(x, 8.0)
                for off in (-0.55, 0.55):
                    cm.tube([p + V(off, 0, 1.25) for p in pts], 0.028, sides=4, ts=3.0)
                for s in pos:
                    zc = cable_z(s)
                    for off in (-0.55, 0.55):
                        cm.beam((x + off, s, zc + 0.3), (x + off, s, zc + 1.3), 0.06, 0.06, caps=False)

    # --------------------------------------------------------------------------------------- pylons, anchorages
    def pylon(self, sc, ground=-25.0):
        cm = self.mb['concrete']
        zt = E(sc) + 12.5
        for sgn in (-1, 1):
            x0, x1 = sorted((sgn * 12.4, sgn * 18.0))
            if self.lod == 0:
                self.rect_section(cm, x0 - 0.6, x1 + 0.6, sc - 6.2, sc + 6.2, ground, E(sc) - 9.0, fluted=True, bottom=False, col=(0.85, 0.83, 0.8))
                self.rect_section(cm, x0, x1, sc - 5.0, sc + 5.0, E(sc) - 9.0, zt - 3.2, fluted=True)
            else:
                cm.box((x0 - 0.6, sc - 6.2, ground), (x1 + 0.6, sc + 6.2, E(sc) - 9.0), ts=8.0, faces='xXyYZ')
                cm.box((x0, sc - 5.0, E(sc) - 9.0), (x1, sc + 5.0, zt - 3.2), ts=8.0, faces='xXyYZ')
            cm.box((x0 + 0.4, sc - 4.4, zt - 3.2), (x1 - 0.4, sc + 4.4, zt - 1.2), ts=8.0, faces='xXyYZ')
            cm.box((x0 + 1.0, sc - 3.5, zt - 1.2), (x1 - 1.0, sc + 3.5, zt), ts=8.0, faces='xXyYZ')
            if self.meta:
                self.meta.box((x0 - 0.6, sc - 6.2, ground), (x1 + 0.6, sc + 6.2, zt), 'Golden Gate Köprüsü')
        # wall between the pylon pair under the deck
        cm.box((-12.4, sc - 3.0, ground), (12.4, sc + 3.0, E(sc) - 1.0), ts=8.0, faces='yY', col=(0.8, 0.78, 0.75))
        if self.lod == 0:
            # recessed panels on the wall
            for sgn in (-1, 1):
                y = sc + sgn * 3.05
                for x0 in (-10.5, -3.2, 4.1):
                    cm.box((x0, y - 0.1, E(sc) - 22.0), (x0 + 6.4, y + 0.1, E(sc) - 4.0), ts=8.0, faces='yY' if sgn > 0 else 'y', col=(0.72, 0.7, 0.66))

    def anchorage(self, s0, s1, half_w, ground=-25.0):
        cm = self.mb['concrete']
        z_top = min(E(s0), E(s1)) - 1.0
        cm.box((-half_w, s0, ground), (half_w, s1, z_top), ts=8.0, faces='xXyY', col=(0.9, 0.88, 0.85))
        if self.lod == 0:
            # buttresses / pilasters on the long faces
            n = int((s1 - s0) / 9.0)
            for k in range(n + 1):
                s = s0 + (s1 - s0) * k / n
                for sgn in (-1, 1):
                    x0, x1 = sorted((sgn * half_w, sgn * (half_w + 1.2)))
                    cm.box((x0, s - 1.1, ground), (x1, s + 1.1, z_top - 1.5), ts=8.0, faces='xXyYZ')
            # cornice
            cm.box((-half_w - 1.0, s0 - 1.0, z_top - 2.0), (half_w + 1.0, s1 + 1.0, z_top - 0.8), ts=8.0, faces='xXyYz')
        if self.meta:
            self.meta.box((-half_w, s0, ground), (half_w, s1, z_top + 1.4), 'Golden Gate Köprüsü')

    # --------------------------------------------------------------------------------------- Fort Point arch
    def fort_point_arch(self):
        paint = self.mb['paint']
        lod = self.lod
        sa, sb = S2 + 5.5, S1 - 5.5          # springing points (pylon faces)
        scen, half = (sa + sb) / 2, (sb - sa) / 2
        spring, crown = 14.0, E(scen) - 5.0

        def arch_z(s, off=0.0):
            t = (s - scen) / half
            return spring + (crown - spring) * (1 - t * t) + off
        n = 28 if lod == 0 else 12
        ss = [sa + (sb - sa) * i / n for i in range(n + 1)]
        for sgn in (-1, 1):
            x = sgn * 10.5
            top = [V(x, s, arch_z(s)) for s in ss]
            bot = [V(x, s, arch_z(s, -3.2)) for s in ss]
            for k in range(n):
                paint.beam(top[k], top[k + 1], 1.4, 1.2, ts=4.0, col=AO_MID)
                if lod == 0:
                    paint.beam(bot[k], bot[k + 1], 1.4, 1.2, ts=4.0, col=AO_MID)
                    paint.beam(top[k] if k % 2 else bot[k], bot[k + 1] if k % 2 else top[k + 1], 0.6, 0.6, up=(1, 0, 0), col=AO_MID)
            # spandrel columns
            for k in range(1, n, 2 if lod == 0 else 3):
                s = ss[k]
                paint.beam(V(x, s, arch_z(s) + 0.6), V(x, s, E(s) - 1.0), 0.9, 0.9, up=(1, 0, 0), col=AO_MID, caps=False)
            if self.meta:
                for k in range(0, n, 4):
                    self.meta.capsule(top[k], top[min(n, k + 4)], 2.2, 'Golden Gate Köprüsü')
        # cross bracing between the ribs
        for k in range(2, n - 1, 4):
            s = ss[k]
            paint.beam((-10.5, s, arch_z(s) - 1.6), (10.5, s, arch_z(s) - 1.6), 0.6, 0.8, col=AO_UNDER)
        # deck girders over the arch
        for sgn in (-1, 1):
            x = sgn * 10.5
            for a, b in zip(ss[:-1], ss[1:]):
                paint.beam((x, a, E(a) - 2.2), (x, b, E(b) - 2.2), 0.7, 2.6, col=AO_MID, caps=False)

    # --------------------------------------------------------------------------------------- approach viaducts
    def approach(self, s0, s1):
        """Deck truss on steel bents following the curved roadway (ground unknown here: bents run to -30 m)."""
        paint = self.mb['paint']
        lod = self.lod
        st = self.stations(s0, s1, 6.0 if lod == 0 else 12.0)
        self.deck_surface(st, curved=True)
        depth = 5.2
        if lod < 2:
            for sgn in (-1, 1):
                x = sgn * 10.8
                pts_top = [PATH.pt(s, x, -1.3) for s in st]
                pts_bot = [PATH.pt(s, x, -depth) for s in st]
                for k in range(len(st) - 1):
                    paint.beam(pts_top[k], pts_top[k + 1], 0.8, 0.9, col=AO_MID)
                    paint.beam(pts_bot[k], pts_bot[k + 1], 0.8, 0.9, col=AO_MID)
                    if lod == 0:
                        paint.beam(pts_bot[k] if k % 2 == 0 else pts_top[k], pts_top[k + 1] if k % 2 == 0 else pts_bot[k + 1], 0.5, 0.5, up=(1, 0, 0), col=AO_MID)
            for k in range(0, len(st), 2):
                paint.beam(PATH.pt(st[k], -10.8, -1.8), PATH.pt(st[k], 10.8, -1.8), 0.5, 1.4, col=AO_UNDER, caps=False)
        # bents
        bstep = 42.0
        nb = max(1, int(abs(s1 - s0) / bstep))
        for i in range(1, nb + 1):
            s = s0 + (s1 - s0) * i / (nb + 1) if nb > 0 else (s0 + s1) / 2
            ztop = E(s) - depth
            for sgn in (-1, 1):
                p_top = PATH.pt(s, sgn * 10.0, -depth)
                p_bot = V(p_top[0], p_top[1], -30.0)
                if lod == 2:
                    paint.beam(p_bot, p_top, 1.6, 1.6, up=(1, 0, 0), caps=False)
                    continue
                paint.beam(p_bot, p_top, 1.6, 2.2, up=(1, 0, 0), col=AO_MID, caps=False)
                if self.meta:
                    self.meta.box((p_top[0] - 1.2, p_top[1] - 1.2, -30.0), (p_top[0] + 1.2, p_top[1] + 1.2, ztop), 'Golden Gate Köprüsü')
            if lod == 0:
                # horizontal struts + X bracing in the bent plane every 12 m down to -30
                z = ztop
                while z - 12.0 > -30.0:
                    a0, b0 = PATH.pt(s, -10.0, z - E(s)), PATH.pt(s, 10.0, z - E(s))
                    a1, b1 = PATH.pt(s, -10.0, z - 12.0 - E(s)), PATH.pt(s, 10.0, z - 12.0 - E(s))
                    paint.beam(a0, b0, 0.6, 0.8, col=AO_MID, caps=False)
                    paint.beam(a0, b1, 0.45, 0.45, col=AO_MID)
                    paint.beam(b0, a1, 0.45, 0.45, col=AO_MID)
                    z -= 12.0
        self.deck_collision(s0, s1, bot_dz=-depth, half_w=13.5, step=30.0)

    # --------------------------------------------------------------------------------------- lamps
    def lamps(self, s0, s1):
        paint, lamp = self.mb['paint'], self.mb['lamp']
        s = s0 + 15.24
        while s < s1:
            if min(abs(s - T_S), abs(s - T_N)) > 12:
                for sgn in (-1, 1):
                    x = sgn * 9.45
                    z0 = E(s) + 1.05
                    if self.lod == 0:
                        paint.cylinder((x, s, z0), 0.14, 7.2, sides=8, r_top=0.09, cap_top=False)
                        paint.beam((x, s, z0 + 7.1), (x - sgn * 1.4, s, z0 + 7.4), 0.14, 0.14)
                        lamp.box((x - sgn * 1.4 - 0.35, s - 0.22, z0 + 7.15), (x - sgn * 1.4 + 0.35, s + 0.22, z0 + 7.5))
                    else:
                        paint.beam((x, s, z0), (x, s, z0 + 7.2), 0.2, 0.2, caps=False)
                        lamp.box((x - sgn * 1.0 - 0.35, s - 0.25, z0 + 7.0), (x - sgn * 1.0 + 0.35, s + 0.25, z0 + 7.4))
                    if self.meta:
                        self.meta.light((x - sgn * 1.4, s, z0 + 7.0), '#ffc27a', size=5.0, period=0, kind='lamp', intensity=0.7)
            s += 30.48

    # --------------------------------------------------------------------------------------- tower-side sidewalk bypass
    def sidewalk_bypass(self, sc):
        walk, rail, paint = self.mb['walk'], self.mb['rail'], self.mb['paint']
        z = E(sc) + 0.18
        for sgn in (-1, 1):
            xo = sgn * 20.8
            x0, x1 = sorted((sgn * 17.45, xo))
            walk.box((x0, sc - 9.5, z - 1.0), (x1, sc + 9.5, z), ts=3.0, faces='xXyYZ')
            for a, b in ((sc - 9.5, sc - 6.9), (sc + 6.9, sc + 9.5)):
                xa, xb = sorted((sgn * 12.95, sgn * 17.45))
                walk.box((xa, a, z - 1.0), (xb, b, z), ts=3.0, faces='Zz')
            if sgn > 0:
                rail.quad((xo, sc - 9.5, z), (xo, sc + 9.5, z), (xo, sc + 9.5, z + 1.24), (xo, sc - 9.5, z + 1.24), uv=[(0, 0), (12.5, 0), (12.5, 1), (0, 1)])
            else:
                rail.quad((xo, sc + 9.5, z), (xo, sc - 9.5, z), (xo, sc - 9.5, z + 1.24), (xo, sc + 9.5, z + 1.24), uv=[(0, 0), (12.5, 0), (12.5, 1), (0, 1)])
            paint.box((x0, sc - 9.5, z - 1.6), (x1, sc + 9.5, z - 1.0), faces='xXyYz', col=AO_MID)

    # --------------------------------------------------------------------------------------- assemble
    def build(self):
        lod = self.lod
        # towers
        self.tower(T_S, True)
        self.tower(T_N, False)
        # suspended structure: main span + side spans
        gap = 7.2
        spans = [(T_S + gap, T_N - gap, 166), (S1 + 5.2, T_S - gap, 43), (T_N + gap, N1 - 5.2, 44)]
        for a, b, n in spans:
            self.stiffening_truss(a, b, n)
            self.deck_collision(a, b)
        # suicide-deterrent net (2024): stainless mesh 6 m below the sidewalks, 6 m outboard, along the suspended spans
        if lod == 0:
            for a_, b_, n_ in spans:
                st = self.stations(a_ + 2.0, b_ - 2.0, PANEL * 2)
                for sgn in (-1, 1):
                    x0, x1 = sgn * (CX + 0.7), sgn * (CX + 6.8)
                    for s0, s1 in zip(st[:-1], st[1:]):
                        q = [(x0, s0, E(s0) - 6.3), (x1, s0, E(s0) - 5.4), (x1, s1, E(s1) - 5.4), (x0, s1, E(s1) - 6.3)]
                        uv = [(0, s0 / 3.0), (2, s0 / 3.0), (2, s1 / 3.0), (0, s1 / 3.0)]
                        self.mb['net'].quad(*q, uv=uv) if sgn > 0 else self.mb['net'].quad(q[1], q[0], q[3], q[2], uv=[uv[1], uv[0], uv[3], uv[2]])
                        # support struts from the bottom chord every other panel
                    for s0 in st[::2]:
                        self.mb['paint'].beam((sgn * (CX + 0.5), s0, E(s0) - 6.8), (sgn * (CX + 6.8), s0, E(s0) - 5.35), 0.25, 0.25, caps=False)
        # deck surface continuous from the south anchorage to the north anchorage
        step = {0: PANEL, 1: 15.24, 2: 60.0}[lod]
        self.deck_surface(self.stations(ANCH_S[0], ANCH_N[1], step))
        self.deck_collision(T_S - gap, T_S + gap, bot_dz=-3.5, half_w=10.0, step=20.0)
        self.deck_collision(T_N - gap, T_N + gap, bot_dz=-3.5, half_w=10.0, step=20.0)
        if lod < 2:
            self.sidewalk_bypass(T_S)
            self.sidewalk_bypass(T_N)
        self.cables()
        # pylons, anchorages, arch
        for sc in (S1, S2, N1, N2):
            self.pylon(sc)
        self.anchorage(*ANCH_S, 20.5)
        self.anchorage(*ANCH_N, 24.0)
        self.deck_collision(S2 - 5, S1 + 5, bot_dz=-3.0, half_w=13.5, step=40.0)
        self.fort_point_arch() if lod < 2 else None
        # approach viaducts (curved)
        self.approach(SOUTH_END, ANCH_S[0])
        self.approach(ANCH_N[1], NORTH_END)
        if lod < 2:
            self.lamps(ANCH_S[0], ANCH_N[1])
        # traffic lanes: 3 northbound (east half), 3 southbound (west half), whole bridge incl. approaches
        if self.meta:
            st = self.stations(SOUTH_END, NORTH_END, 12.0)
            for k, x in enumerate((1.8, 4.9, 8.0)):
                self.meta.lane([PATH.pt(s, x, 0.02) for s in st], speed=21.0 - 1.5 * k)
                self.meta.lane([PATH.pt(s, -x, 0.02) for s in st[::-1]], speed=21.0 - 1.5 * k)
        # center-span navigation light (green) under the deck
        if self.meta:
            self.meta.light((0.0, 0.0, E(0) - 8.2), '#30ff60', size=3.5, period=0.0, kind='nav')
            self.meta.light((0.0, 0.0, E(0) - 8.2 + 0.01), '#30ff60', size=3.5, period=0.0, kind='nav')

    def objects(self, prefix):
        obs = []
        for k, mb in self.mb.items():
            if len(mb) == 0:
                continue
            obs.append(mb.to_object(f'{prefix}_{k}', self.M[k], use_colors=True))
        return obs


def main():
    reset_scene()
    meta = None
    results = {}
    for lod in (0, 1, 2):
        M = make_materials(lod)
        b = Bridge(lod, M)
        b.build()
        prefix = 'ggb' if lod == 0 else f'ggb_lod{lod}'
        obs = b.objects(prefix)
        name = 'golden_gate' if lod == 0 else f'golden_gate_lod{lod}'
        path = os.path.join(OUT, f'{name}.glb')
        export(path, obs, draco_bits=19)
        tris = tri_count(obs)
        results[lod] = (path, tris)
        print(f'LOD{lod}: {tris} triangles -> {path} ({os.path.getsize(path) / 1e6:.2f} MB)')
        if lod == 0:
            meta = b.meta
        for o in obs:
            o.hide_set(True)
            o.hide_render = True
    meta.d.update({
        'origin': G['origin'], 'heading': G['heading'], 'base': 'absolute',
        'lods': [{'url': 'assets/sf/landmarks/golden_gate.glb', 'dist': 3200},
                 {'url': 'assets/sf/landmarks/golden_gate_lod1.glb', 'dist': 13000},
                 {'url': 'assets/sf/landmarks/golden_gate_lod2.glb', 'dist': 1e9}],
        'tris': {str(k): v[1] for k, v in results.items()},
        'bounds': {'min': [-80, -40, -1420], 'max': [80, 232, 1330]},
    })
    meta.save()
    if '--blend' in sys.argv:
        import bpy
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'golden_gate.blend'))


if __name__ == '__main__':
    main()
