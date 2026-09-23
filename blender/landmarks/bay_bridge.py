"""San Francisco–Oakland Bay Bridge (W3): west span (twin suspension bridges, center anchorage W4, Yerba Buena
Island tunnel portals) and east span (self-anchored suspension span with its single 160 m tower + Skyway).

Run:  Blender -b -P blender/landmarks/bay_bridge.py
Outputs: assets/sf/landmarks/bay_bridge_west{,_lod1,_lod2}.glb, bay_bridge_east{...}.glb + .json metadata.

Positions from OSM (W1..W7 piers, SAS tower, both east-span carriageways; blender/landmarks/layout.json), elevations
calibrated on the 3DEP DEM (tunnel portals ~53/57 m, Rincon Hill, Oakland touchdown).
West frame: origin = tower W2, +Y towards Yerba Buena Island (heading 39.98 deg).
East frame: origin = SAS tower T1, +Y along the SAS axis towards Oakland.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from lmkit import MB, V, Meta, LAYOUT, OUT, material, export, tri_count, reset_scene, norm  # noqa: E402
from bridgekit import pchip, resample, smooth, DeckPath, box_girder, warren_truss, parabola_cable, column  # noqa: E402
import tex_common as tx  # noqa: E402

NAME = 'Bay Köprüsü'
BB = LAYOUT['bay_bridge']
WL = BB['west']
EL = BB['east']
SUP = WL['supports']

# ============================================================================================ WEST SPAN
S_W1 = SUP['W1']['c'][0]
W1A, W1B = SUP['W1']['s']
S_P0 = SUP['P0']['c'][0]
S_W2, S_W3, S_W5, S_W6 = 0.0, SUP['W3']['c'][0], SUP['W5']['c'][0], SUP['W6']['c'][0]
W4A, W4B = SUP['W4']['s']
W7A, W7B = SUP['W7']['s']
TUN_W = min(p[0] for t in WL['tunnel'] for p in t)
TUN_E = max(p[0] for t in WL['tunnel'] for p in t)
S_START = -700.0
CX = 10.06          # 66 ft cable / truss spacing
TOWER_TOP, SADDLE = 160.0, 155.0
PANEL_W = 9.144      # 30 ft panels and suspender spacing
LOWER = 9.6          # lower deck is this far below the upper deck

U = pchip([-760, -700, -640, -357, 0, 352, 704, 1083, 1461, 1813, 2165, 2540, 2650, 2830],
          [45, 45, 46, 55, 65, 71, 65, 62, 65, 71, 65, 57, 53, 56])


def west_cable_z(s):
    mid1, mid2 = (S_W2 + S_W3) / 2, (S_W5 + S_W6) / 2
    half = (S_W3 - S_W2) / 2
    if S_W2 <= s <= S_W3:
        lo = U(mid1) + 2.5
        return lo + (SADDLE - lo) * ((s - mid1) / half) ** 2
    if S_W5 <= s <= S_W6:
        lo = U(mid2) + 2.5
        return lo + (SADDLE - lo) * ((s - mid2) / half) ** 2

    def side(s0, z0, s1, z1, sag):
        t = (s - s0) / (s1 - s0)
        return z0 + (z1 - z0) * t - 4 * sag * t * (1 - t)
    if S_W3 < s <= W4A:
        return side(S_W3, SADDLE, W4A, 84.0, 12.0)
    if W4B <= s < S_W5:
        return side(W4B, 84.0, S_W5, SADDLE, 12.0)
    if S_W6 < s <= W7A:
        return side(S_W6, SADDLE, W7A, U(W7A) + 5.0, 11.0)
    if S_P0 <= s < S_W2:
        return side(S_P0, U(S_P0) + 14.0, S_W2, SADDLE, 11.0)
    if W1B <= s < S_P0:
        t = (s - W1B) / (S_P0 - W1B)
        return U(W1B) + 4.0 + (U(S_P0) + 14.0 - U(W1B) - 4.0) * t
    return None


def west_materials(lod):
    gray = '#8C969B'
    if lod == 2:
        c = tx.srgb_to_linear(gray)
        return {
            'paint': material('bbw2_paint', color=c, rough=0.55), 'cable': material('bbw2_cable', color=c, rough=0.5),
            'concrete': material('bbw2_concrete', color=(0.42, 0.40, 0.37), rough=0.9),
            'road': material('bbw2_road', color=(0.05, 0.05, 0.055), rough=0.9),
            'rail': material('bbw2_rail', color=c, rough=0.6), 'truss': material('bbw2_truss', color=c, rough=0.6),
            'dark': material('bbw2_dark', color=(0.01, 0.01, 0.01), rough=1.0),
            'warn': material('bbw2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
            'lamp': material('bbw2_lamp_emit', color=(0.9, 0.85, 0.7), emissive=(1.0, 0.8, 0.5), emissive_strength=2.0),
        }
    if lod == 1:
        pa, _, _ = tx.paint_textures(base=gray, name='bbw1_paint', seed=71, size=256, seams=False)
        ca, _, _ = tx.concrete_textures('bbw1_concrete', base=(0.52, 0.50, 0.46), seed=73, size=256)
        road = tx.road_texture('bbw1_road', lanes=5, width=17.7, w=256, h=256, median=False)
        truss = tx.truss_texture('bbw1_truss', color=gray, size=128, lacing=False)
        rail = tx.railing_texture('bbw1_rail', color=gray, w=64, h=64)
        return {
            'paint': material('bbw1_paint', albedo=pa, rough=0.55), 'cable': material('bbw1_cable', albedo=pa, rough=0.5),
            'concrete': material('bbw1_concrete', albedo=ca, rough=0.9), 'road': material('bbw1_road', albedo=road, rough=0.9),
            'rail': material('bbw1_rail_clip', albedo=rail, alpha_img=True, double_sided=True),
            'truss': material('bbw1_truss_clip', albedo=truss, alpha_img=True, double_sided=True),
            'dark': material('bbw1_dark', color=(0.01, 0.01, 0.01), rough=1.0),
            'warn': material('bbw1_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
            'lamp': material('bbw1_lamp_emit', color=(0.9, 0.85, 0.7), emissive=(1.0, 0.8, 0.5), emissive_strength=2.0),
        }
    pa, pr, pn = tx.paint_textures(base=gray, name='bbw_paint', seed=71)
    ca, _, cn = tx.concrete_textures('bbw_concrete', base=(0.52, 0.50, 0.46), seed=73)
    road = tx.road_texture('bbw_road', lanes=5, width=17.7, median=False)
    rail = tx.railing_texture('bbw_rail', color=gray)
    cab, _, _ = tx.paint_textures(base=gray, name='bbw_cable', seed=75, seams=False, size=256)
    return {
        'paint': material('bbw_paint', albedo=pa, rough_img=pr, normal=pn, normal_strength=0.7),
        'cable': material('bbw_cable', albedo=cab, rough=0.45),
        'concrete': material('bbw_concrete', albedo=ca, normal=cn, rough=0.88),
        'road': material('bbw_road', albedo=road, rough=0.9),
        'rail': material('bbw_rail_clip', albedo=rail, alpha_img=True, double_sided=True),
        'truss': material('bbw_truss_clip', albedo=rail, alpha_img=True, double_sided=True),
        'dark': material('bbw_dark', color=(0.012, 0.012, 0.012), rough=1.0),
        'warn': material('bbw_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        'lamp': material('bbw_lamp_emit', color=(0.9, 0.85, 0.7), emissive=(1.0, 0.8, 0.5), emissive_strength=2.0),
    }


AO_UNDER = (0.62, 0.62, 0.62)
AO_MID = (0.82, 0.82, 0.82)


class West:
    def __init__(self, lod):
        self.lod = lod
        self.M = west_materials(lod)
        self.mb = {k: MB(k) for k in self.M}
        self.meta = Meta('bay_bridge_west', NAME) if lod == 0 else None
        st = np.arange(S_START, TUN_E + 0.01, {0: PANEL_W, 1: PANEL_W * 2, 2: 40.0}[lod])
        self.path = DeckPath([(0.0, s, U(s)) for s in st])

    # ------------------------------------------------------------------------------ towers
    def tower(self, sc):
        mb, lod = self.mb['paint'], self.lod
        ud = U(sc)
        base = 8.0
        for side in (-1, 1):
            x = side * 10.5
            if lod == 2:
                mb.box((x - 1.3, sc - 3.5, base), (x + 1.3, sc + 3.5, TOWER_TOP), faces='xXyYZ')
                continue
            # leg: tapered cellular column (w across, d along), vertical fluting via 3 stacked blocks with setbacks
            column(mb, (x, sc, 0), 3.4, 10.0, base, 60.0, w_top=3.1, d_top=8.6, chamfer=0.35, top=False)
            column(mb, (x, sc, 0), 3.1, 8.6, 60.0, 115.0, w_top=2.8, d_top=7.2, chamfer=0.3, top=False)
            column(mb, (x, sc, 0), 2.8, 7.2, 115.0, TOWER_TOP - 2.0, w_top=2.6, d_top=6.2, chamfer=0.3)
            if lod == 0:
                # vertical stiffener ribs on the outer face
                for dy in (-2.2, 0.0, 2.2):
                    mb.beam((x + side * 1.55, sc + dy, base), (x + side * 1.28, sc + dy, TOWER_TOP - 2.0), 0.25, 0.25, up=(0, 1, 0), caps=False)
                # setback bands
                for zb in (60.0, 115.0):
                    mb.box((x - 1.9, sc - 5.0, zb - 0.6), (x + 1.9, sc + 5.0, zb + 0.6), faces='xXyYZz')
            # saddle housing + light
            mb.box((x - 1.8, sc - 3.6, TOWER_TOP - 2.0), (x + 1.8, sc + 3.6, TOWER_TOP), faces='xXyYZ')
            self.mb['warn'].cylinder((x, sc, TOWER_TOP), 0.35, 0.8, sides=8)
            if self.meta:
                self.meta.light((x, sc, TOWER_TOP + 1.0), '#ff2a14', size=6.0, period=1.5, duty=0.5, phase=0.3 * (sc / 700.0))
                self.meta.box((x - 1.9, sc - 5.1, -10.0), (x + 1.9, sc + 5.1, TOWER_TOP), NAME)
        # bracing in the tower plane
        inner = 9.1
        struts = [(base, base + 3.0), (ud - LOWER - 3.2, ud - LOWER - 1.2), (ud + 6.0, ud + 8.5), (150.0, TOWER_TOP - 1.0)]
        zlevels = [ud + 8.5, ud + 8.5 + (150.0 - ud - 8.5) / 3, ud + 8.5 + 2 * (150.0 - ud - 8.5) / 3, 150.0]
        for a, b in zip(zlevels[1:-1], zlevels[1:-1]):
            struts.append((a - 1.0, a + 1.0))
        for zb, zt in struts:
            mb.box((-inner, sc - 1.6, zb), (inner, sc + 1.6, zt), faces='yYzZ' if lod else 'yYzZ', col=AO_MID if zt < ud else None)
            if self.meta:
                self.meta.box((-inner, sc - 1.6, zb), (inner, sc + 1.6, zt), NAME)
        if lod == 2:
            return
        xs = []
        # X bracing: below deck (one big X) and three X panels above the deck
        panels = [(base + 3.0, ud - LOWER - 3.2)] + [(zlevels[i] + (1.0 if i else 0), zlevels[i + 1] - 1.0) for i in range(3)]
        for za, zb in panels:
            for sgn in (-1, 1):
                mb.beam((-inner * sgn, sc, za), (inner * sgn, sc, zb), 1.2, 2.2, up=(0, 1, 0), col=AO_MID if zb < ud else None)
        # concrete pier
        cm = self.mb['concrete']
        cm.box((-16.0, sc - 8.0, -12.0), (16.0, sc + 8.0, base), ts=8.0, faces='xXyYZ')
        if self.meta:
            self.meta.box((-16.0, sc - 8.0, -12.0), (16.0, sc + 8.0, base), NAME)

    # ------------------------------------------------------------------------------ deck (upper + lower)
    def decks(self):
        P, lod = self.path, self.lod
        road, paint, rail, cm = self.mb['road'], self.mb['paint'], self.mb['rail'], self.mb['concrete']
        n = len(P)
        i_tun = P.index_at(TUN_W)
        # upper deck
        P.strip(road, -8.85, 8.85, 0.0, uv='road', ts=12.192)
        # lower deck (inside the truss; through the tunnel as well)
        P.strip(road, -8.85, 8.85, -LOWER, uv='road', ts=12.192)
        if lod == 2:
            P.strip(paint, 10.3, -10.3, -LOWER - 1.2, i1=i_tun)
            return
        # upper deck barriers and edge
        for sgn in (-1, 1):
            a, b = sorted((sgn * 8.85, sgn * 9.2))
            P.strip(cm, a, b, 0.85, col=(0.85, 0.85, 0.85))                     # barrier top
            P.strip(cm, sgn * 8.85, sgn * 8.85, 0.0, 0.85, flip=sgn < 0)          # barrier inner face
            P.strip(cm, sgn * 9.2, sgn * 9.2, -0.4, 0.85, flip=sgn > 0)           # outer face
            a, b = sorted((sgn * 8.85, sgn * 9.2))
            P.strip(cm, a, b, -LOWER + 0.85, col=AO_MID)                          # lower barrier top
            P.strip(cm, sgn * 8.85, sgn * 8.85, -LOWER, -LOWER + 0.85, flip=sgn < 0, col=AO_MID)
            # outer railing on the upper chord
            P.rail(rail, sgn * 10.3, 0.0, 1.25, i1=i_tun)
        # upper slab underside (seen from the lower deck and from below between trusses)
        P.strip(paint, 10.0, -10.0, -0.55, col=AO_UNDER)
        P.strip(paint, 10.0, -10.0, -LOWER - 0.55, col=AO_UNDER, i1=i_tun)

    def truss_segment(self, s0, s1):
        paint, lod = self.mb['paint'], self.lod
        npan = max(1, int(round((s1 - s0) / PANEL_W)))
        nodes = [s0 + (s1 - s0) * k / npan for k in range(npan + 1)]
        if lod == 2:
            for sgn in (-1, 1):
                x = sgn * (CX + 0.3)
                a, b = s0, s1
                for k in range(0, npan, 6):
                    a, b = nodes[k], nodes[min(npan, k + 6)]
                    q = [(x, a, U(a) - 10.9), (x, b, U(b) - 10.9), (x, b, U(b) - 0.3), (x, a, U(a) - 0.3)]
                    paint.quad(*q) if sgn > 0 else paint.quad(q[1], q[0], q[3], q[2])
            return
        if lod == 1:
            tm = self.mb['truss']
            for sgn in (-1, 1):
                for off in (-0.4, 0.4):
                    x = sgn * CX + off
                    for k in range(npan):
                        a, b = nodes[k], nodes[k + 1]
                        u0, u1 = (0, 1) if k % 2 == 0 else (1, 0)
                        tm.quad((x, a, U(a) - 10.9), (x, b, U(b) - 10.9), (x, b, U(b) - 0.3), (x, a, U(a) - 0.3), uv=[(u0, 0), (u1, 0), (u1, 1), (u0, 1)])
            for a, b in zip(nodes[:-1], nodes[1:]):
                paint.quad((CX, a, U(a) - 11.2), (-CX, a, U(a) - 11.2), (-CX, b, U(b) - 11.2), (CX, b, U(b) - 11.2), 6.0, col=AO_UNDER)
            return
        for sgn in (-1, 1):
            x = sgn * CX
            top = [V(x, s, U(s) - 0.9) for s in nodes]
            bot = [V(x, s, U(s) - 10.5) for s in nodes]
            warren_truss(paint, top, bot, chord_w=0.9, chord_h=0.9, web_w=0.55, web_t=0.7, col=None, col_bot=AO_MID)
            # mid-height chord carrying the lower deck edge
        for s in nodes:
            paint.beam((-CX, s, U(s) - 1.4), (CX, s, U(s) - 1.4), 0.5, 1.4, col=AO_UNDER, caps=False)
            paint.beam((-CX, s, U(s) - LOWER - 1.3), (CX, s, U(s) - LOWER - 1.3), 0.5, 1.4, col=AO_UNDER, caps=False)
        for k in range(0, npan - 1, 2):
            a, b = nodes[k], nodes[k + 2]
            za, zb = U(a) - 10.5, U(b) - 10.5
            paint.beam((-CX, a, za), (CX, b, zb), 0.4, 0.4, col=AO_UNDER)
            paint.beam((CX, a, za), (-CX, b, zb), 0.4, 0.4, col=AO_UNDER)

    def deck_collision(self, s0, s1, step=40.0):
        if not self.meta:
            return
        n = max(1, int(math.ceil((s1 - s0) / step)))
        for k in range(n):
            a, b = s0 + (s1 - s0) * k / n, s0 + (s1 - s0) * (k + 1) / n
            top = max(U(a), U(b)) + 0.5
            bot = min(U(a), U(b)) - 11.0
            self.meta.box((-10.6, a, bot), (10.6, b, top), NAME)

    # ------------------------------------------------------------------------------ cables & suspenders
    def cables(self):
        cm, lod = self.mb['cable'], self.lod
        sides = {0: 12, 1: 8, 2: 6}[lod]
        step = {0: 4.0, 1: 12.0, 2: 35.0}[lod]
        spans = [(W1B, S_P0), (S_P0, S_W2), (S_W2, S_W3), (S_W3, W4A), (W4B, S_W5), (S_W5, S_W6), (S_W6, W7A)]
        for sgn in (-1, 1):
            x = sgn * CX
            for a, b in spans:
                n = max(2, int((b - a) / step))
                pts = [V(x, a + (b - a) * i / n, west_cable_z(a + (b - a) * i / n)) for i in range(n + 1)]
                cm.tube(pts, 0.37, sides=sides, ts=3.0)
                if self.meta:
                    m = max(2, int((b - a) / 30))
                    cp = [V(x, a + (b - a) * i / m, west_cable_z(a + (b - a) * i / m)) for i in range(m + 1)]
                    for p0, p1 in zip(cp[:-1], cp[1:]):
                        self.meta.capsule(p0, p1, 0.7, NAME)
        if lod == 2:
            return
        # suspenders every 30 ft on the suspended spans
        pos = []
        for a, b in ((S_P0 + 6, S_W2 - 6), (S_W2 + 6, S_W3 - 6), (S_W3 + 6, W4A - 6), (W4B + 6, S_W5 - 6), (S_W5 + 6, S_W6 - 6), (S_W6 + 6, W7A - 6)):
            k0 = math.ceil(a / PANEL_W)
            k1 = math.floor(b / PANEL_W)
            pos += [k * PANEL_W for k in range(k0, k1 + 1)]
        self.susp = pos
        for sgn in (-1, 1):
            x = sgn * CX
            for s in pos:
                zc = west_cable_z(s)
                if zc is None or zc - U(s) < 1.2:
                    continue
                if lod == 0:
                    d = norm(V(0, 1, west_cable_z(s + 0.5) - west_cable_z(s - 0.5)))
                    cm.tube([V(x, s, zc) - d * 0.6, V(x, s, zc) + d * 0.6], 0.46, sides=8, closed_ends=True)
                    for off in (-0.33, 0.33):
                        cm.tube([V(x + off, s, zc - 0.2), V(x + off, s, U(s) - 0.3)], 0.03, sides=4)
                else:
                    cm.beam((x, s, zc), (x, s, U(s) - 0.3), 0.12, 0.12, up=(1, 0, 0), caps=False)
                if self.meta and zc - U(s) > 3:
                    self.meta.capsule((x, s, U(s) + 1.0), (x, s, zc - 0.5), 0.2, NAME)

    # ------------------------------------------------------------------------------ anchorages, bents, portals
    def anchorage(self, s0, s1, hw, top, ground=-15.0, fluted=True):
        """Massive concrete block the double deck passes through (slot between the side walls)."""
        cm, lod = self.mb['concrete'], self.lod
        slot = 9.7
        zs = min(U(s0), U(s1)) - LOWER - 1.8
        cm.box((-hw, s0, ground), (hw, s1, zs), ts=8.0, faces='xXyY', col=(0.9, 0.9, 0.88))
        for sgn in (-1, 1):
            x0, x1 = sorted((sgn * slot, sgn * hw))
            cm.box((x0, s0, zs), (x1, s1, top), ts=8.0, faces='xXyYZ')
            if lod == 0 and fluted:
                n = int((s1 - s0) / 6.0)
                for k in range(1, n):
                    s = s0 + (s1 - s0) * k / n
                    xa, xb = sorted((sgn * hw, sgn * (hw + 0.8)))
                    cm.box((xa, s - 0.9, ground), (xb, s + 0.9, top - 3.0), ts=8.0, faces='xXyYZ')
                cm.box((x0 - 0.6, s0 - 0.6, top - 2.5), (x1 + 0.6, s1 + 0.6, top - 1.2), ts=8.0, faces='xXyYzZ')
            if self.meta:
                self.meta.box((x0, s0, ground), (x1, s1, top), NAME)
        if self.meta:
            self.meta.box((-slot, s0, ground), (slot, s1, zs), NAME)

    def bents(self, s0, s1, spacing):
        paint, lod = self.mb['paint'], self.lod
        n = max(1, int(round((s1 - s0) / spacing)))
        for k in range(n + 1):
            s = s0 + (s1 - s0) * k / n
            zt = U(s) - 10.9
            for sgn in (-1, 1):
                x = sgn * CX
                if lod == 2:
                    paint.box((x - 0.8, s - 0.8, -12.0), (x + 0.8, s + 0.8, zt), faces='xXyY')
                    continue
                column(paint, (x, s, 0), 1.8, 2.4, -12.0, zt, chamfer=0.2, top=False, col=AO_MID)
                if self.meta:
                    self.meta.box((x - 1.0, s - 1.3, -12.0), (x + 1.0, s + 1.3, zt), NAME)
            if lod == 0:
                z = zt
                while z - 10.0 > -12.0:
                    paint.beam((-CX, s, z - 0.5), (CX, s, z - 0.5), 0.6, 0.8, col=AO_MID, caps=False)
                    paint.beam((-CX, s, z), (CX, s, z - 10.0), 0.45, 0.45, col=AO_MID)
                    paint.beam((CX, s, z), (-CX, s, z - 10.0), 0.45, 0.45, col=AO_MID)
                    z -= 10.0

    def cable_bent(self, s):
        paint = self.mb['paint']
        zt = west_cable_z(s + 0.01) or (U(s) + 14.0)
        for sgn in (-1, 1):
            x = sgn * 10.4
            column(paint, (x, s, 0), 2.6, 4.5, -10.0, zt - 1.0, w_top=2.2, d_top=3.6, chamfer=0.25)
            paint.box((x - 1.6, s - 2.4, zt - 1.0), (x + 1.6, s + 2.4, zt + 0.8), faces='xXyYZ')
            if self.meta:
                self.meta.box((x - 1.4, s - 2.3, -10.0), (x + 1.4, s + 2.3, zt + 0.8), NAME)
        paint.box((-9.1, s - 1.4, zt - 4.0), (9.1, s + 1.4, zt - 1.5), faces='yYzZ')
        paint.box((-9.1, s - 1.4, U(s) - 13.0), (9.1, s + 1.4, U(s) - 11.0), faces='yYzZ', col=AO_MID)

    def portal(self, s, facing):
        """YBI tunnel portal facade (art-deco concrete) facing -Y (west, facing=-1) or +Y (east, facing=+1)."""
        cm, dark, lod = self.mb['concrete'], self.mb['dark'], self.lod
        ud = U(s)
        z0, z1 = ud - LOWER - 1.5, ud + 14.0
        hw = 19.0
        ow, oz0, oz1 = 11.5, ud - LOWER, ud + 8.0     # opening (76 x 58 ft bore)
        y = s
        th = 3.0
        ya, yb = (y - th, y) if facing > 0 else (y, y + th)
        yf = yb if facing > 0 else ya                 # outer face
        # facade pieces around the opening (arched top approximated by a stepped lintel)
        cm.box((-hw, ya, z0), (-ow, yb, z1), ts=8.0, faces='xXyYZ')
        cm.box((ow, ya, z0), (hw, yb, z1), ts=8.0, faces='xXyYZ')
        cm.box((-ow, ya, oz1), (ow, yb, z1), ts=8.0, faces='yYzZ')
        if lod == 0:
            for k, (dx, dz) in enumerate(((3.0, 1.2), (6.0, 2.4), (8.5, 3.4))):
                cm.box((-ow, ya, oz1 - dz), (-ow + dx, yb, oz1), faces='yYz')
                cm.box((ow - dx, ya, oz1 - dz), (ow, yb, oz1), faces='yYz')
            # pilasters and cornice
            for x in (-hw + 1.0, -ow - 1.5, ow + 1.5, hw - 1.0):
                py0, py1 = (yb - 0.1, yb + 0.6) if facing > 0 else (ya - 0.6, ya + 0.1)
                cm.box((x - 1.0, py0, z0), (x + 1.0, py1, z1 + 1.0), faces='xXyYZ')
            cm.box((-hw - 0.8, ya - 0.8, z1), (hw + 0.8, yb + 0.8, z1 + 1.6), faces='xXyYzZ')
        # dark tunnel recess
        yd0, yd1 = (y - 40.0, ya) if facing > 0 else (yb, y + 40.0)
        dark.box((-ow, yd0, oz0 - 1.0), (ow, yd1, oz1), faces='xXzZ' + ('y' if facing > 0 else 'Y'))
        if self.meta:
            self.meta.box((-hw, ya, z0), (hw, yb, z1 + 1.6), NAME)

    def lamps(self):
        lamp, paint = self.mb['lamp'], self.mb['paint']
        s = S_P0
        while s < W7A:
            if min(abs(s - t) for t in (S_W2, S_W3, S_W5, S_W6)) > 10 and not (W4A - 5 < s < W4B + 5):
                for sgn in (-1, 1):
                    x = sgn * 9.3
                    z0 = U(s) + 0.85
                    if self.lod == 0:
                        paint.cylinder((x, s, z0), 0.12, 9.0, sides=6, r_top=0.08, cap_top=False)
                        paint.beam((x, s, z0 + 8.9), (x - sgn * 1.6, s, z0 + 9.2), 0.12, 0.12)
                    lamp.box((x - sgn * 1.6 - 0.3, s - 0.2, z0 + 8.95), (x - sgn * 1.6 + 0.3, s + 0.2, z0 + 9.25))
                    if self.meta:
                        self.meta.light((x - sgn * 1.6, s, z0 + 8.8), '#ffd9a0', size=5.0, period=0, kind='lamp', intensity=0.6)
            s += 45.72

    def bay_lights(self):
        """The Bay Lights: LED strings on the north-side suspenders (night art installation) -> glow points."""
        if not self.meta:
            return
        for s in getattr(self, 'susp', [])[::1]:
            zc = west_cable_z(s)
            if zc is None:
                continue
            zt = U(s) + 1.0
            n = max(1, int((zc - zt) / 9.0))
            for k in range(n + 1):
                z = zt + (zc - zt) * k / n
                self.meta.light((-CX - 0.3, s, z), '#f4f6ff', size=1.6, period=0, kind='lamp', intensity=0.55)

    # ------------------------------------------------------------------------------ assemble
    def build(self):
        lod = self.lod
        for sc in (S_W2, S_W3, S_W5, S_W6):
            self.tower(sc)
        self.decks()
        gap = 5.4
        segs = [(S_START, S_P0 - 2.0), (S_P0 + 2.0, S_W2 - gap), (S_W2 + gap, S_W3 - gap), (S_W3 + gap, W4A - 0.5),
                (W4B + 0.5, S_W5 - gap), (S_W5 + gap, S_W6 - gap), (S_W6 + gap, W7A - 0.5), (W7B + 0.5, TUN_W - 2.0)]
        for a, b in segs:
            if b - a > 5:
                self.truss_segment(a, b)
        self.deck_collision(S_START, TUN_W)
        self.cables()
        self.anchorage(W4A, W4B, 20.0, 86.0)
        self.anchorage(W1A, W1B, 15.2, U(S_W1) + 6.0)
        self.anchorage(W7A, W7B, 16.7, U(W7A) + 7.0)
        self.bents(S_START + 5, W1A - 8, 32.0)
        self.bents(W1B + 8, S_P0 - 10, 45.0)
        self.cable_bent(S_P0)
        self.portal(TUN_W, -1)
        self.portal(TUN_E, 1)
        if lod < 2:
            self.lamps()
        self.bay_lights()
        if self.meta:
            self.meta.box((-11.0, TUN_W, U(TUN_W) - 12.0), (11.0, TUN_E, U(TUN_E) + 10.0), NAME)   # hill/tunnel block
            # traffic: upper deck westbound (towards San Francisco), lower deck eastbound; 5 lanes each
            st = np.arange(S_START, TUN_W + 0.1, 12.0)
            for k, x in enumerate((-7.08, -3.54, 0.0, 3.54, 7.08)):
                self.meta.lane([V(x, s, U(s) + 0.02) for s in st[::-1]], speed=23.0 - 0.8 * k)
                self.meta.lane([V(x, s, U(s) - LOWER + 0.02) for s in st], speed=23.0 - 0.8 * k)

    def objects(self, prefix):
        return [mb.to_object(f'{prefix}_{k}', self.M[k], use_colors=True) for k, mb in self.mb.items() if len(mb)]


# ============================================================================================ EAST SPAN
def _closest_on(P, q):
    best, bp = 1e18, None
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]
        ab = b - a
        L2 = float(np.dot(ab, ab))
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, float(np.dot(q - a, ab)) / L2))
        c = a + ab * t
        d = float(np.linalg.norm(q - c))
        if d < best:
            best, bp = d, c
    return best, bp


def east_geometry():
    """Midline (world x,z) of the two parallel decks, deck side of each OSM line, transition polylines."""
    A = np.array(EL['A'])
    B = np.array(EL['B'])
    Ar, _ = resample(A, 5.0)
    mids = []
    for p in Ar:
        d, q = _closest_on(B, p)
        if 38.0 < d < 46.0:
            mids.append((p + q) / 2)
    M = smooth(np.array(mids), k=3, it=4)
    M, _ = resample(M, 6.0)
    T = np.array(EL['tower'])
    # frame: origin at the tower (projected on the midline), heading = midline direction there
    dists = np.linalg.norm(M - T, axis=1)
    it = int(np.argmin(dists))
    tdir = norm(M[min(it + 3, len(M) - 1)] - M[max(it - 3, 0)])
    heading = math.atan2(tdir[0], -tdir[1]) % (2 * math.pi)
    origin = M[it]
    return A, B, np.array(EL['Bup']), M, origin, heading, T


def to_frame_fn(origin, heading):
    fx, fz = math.sin(heading), -math.cos(heading)
    rx, rz = math.cos(heading), math.sin(heading)

    def f(p):
        dx, dz = p[0] - origin[0], p[1] - origin[1]
        return np.array([dx * rx + dz * rz, dx * fx + dz * fz])
    return f


def east_materials(lod):
    white = (0.80, 0.80, 0.78)
    steel = (0.62, 0.63, 0.63)
    if lod == 2:
        return {
            'white': material('bbe2_white', color=white, rough=0.5), 'steel': material('bbe2_steel', color=steel, rough=0.6),
            'concrete': material('bbe2_concrete', color=(0.55, 0.54, 0.51), rough=0.9),
            'road': material('bbe2_road', color=(0.06, 0.06, 0.065), rough=0.9),
            'rail': material('bbe2_rail', color=steel, rough=0.6), 'walk': material('bbe2_walk', color=(0.4, 0.4, 0.38), rough=0.9),
            'warn': material('bbe2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        }
    sz = 256 if lod == 1 else 1024
    wa, wr, wn = tx.paint_textures(base='#D6D7D2', name=f'bbe{lod}_white', seed=81, size=sz, seams=lod == 0)
    sa, _, _ = tx.paint_textures(base='#A9AEAE', name=f'bbe{lod}_steel', seed=83, size=sz, seams=lod == 0)
    ca, _, cn = tx.concrete_textures(f'bbe{lod}_concrete', base=(0.66, 0.65, 0.61), seed=85, size=sz)
    road = tx.road_texture(f'bbe{lod}_road', lanes=5, width=23.2, w=sz, h=sz, median=False, edge_inset=2.7, base_v=0.1)
    rail = tx.railing_texture(f'bbe{lod}_rail', color='#9FA5A6', w=64 if lod else 256, h=64 if lod else 256)
    walk = tx.walk_texture(f'bbe{lod}_walk', size=256 if lod else 512)
    M = {
        'white': material(f'bbe{lod}_white', albedo=wa, rough=0.45, **({'rough_img': wr, 'normal': wn, 'normal_strength': 0.5} if lod == 0 else {})),
        'steel': material(f'bbe{lod}_steel', albedo=sa, rough=0.55),
        'concrete': material(f'bbe{lod}_concrete', albedo=ca, rough=0.9, **({'normal': cn} if lod == 0 else {})),
        'road': material(f'bbe{lod}_road', albedo=road, rough=0.9),
        'rail': material(f'bbe{lod}_rail_clip', albedo=rail, alpha_img=True, double_sided=True),
        'walk': material(f'bbe{lod}_walk', albedo=walk, rough=0.85),
        'warn': material(f'bbe{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
    }
    return M


DECK_OFF = 21.0            # deck centers from the midline
DHW = 12.8                 # deck half width (box girder top)
BIKE = 4.8                 # bike/pedestrian path width (south deck)


class East:
    def __init__(self, lod):
        self.lod = lod
        self.M = east_materials(lod)
        self.mb = {k: MB(k) for k in self.M}
        self.meta = Meta('bay_bridge_east', NAME) if lod == 0 else None
        A, B, Bup, Mw, origin, heading, T = east_geometry()
        self.origin, self.heading = origin, heading
        f = to_frame_fn(origin, heading)
        self.f = f
        Mf = np.array([f(p) for p in Mw])
        s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(Mf, axis=0), axis=1))]
        it = int(np.argmin(np.linalg.norm(Mf, axis=1)))
        self.sT = s[it]
        self.sW2, self.sE2 = self.sT - 180.0, self.sT + 385.0
        self.s_end = s[-1]
        sE2, se = self.sE2, s[-1]
        self.D = pchip([self.sW2 - 60, self.sW2, self.sT, sE2, sE2 + 700, sE2 + 1500, se - 420, se],
                       [49.0, 49.5, 50.5, 49.5, 40.0, 26.0, 12.0, 5.8])
        # parallel-deck section (from W2 to the end), step per LOD
        step = {0: 6.0, 1: 12.0, 2: 36.0}[lod]
        Mr, sr = resample(Mf, step)
        mids = [(p[0], p[1], self.D(q)) for p, q in zip(Mr, sr) if q >= self.sW2 - 1.0]
        self.mid_s0 = float([q for q in sr if q >= self.sW2 - 1.0][0])
        self.mid = DeckPath(mids)
        # deck paths offset from the midline
        self.decks = {}
        for side in (-1, 1):
            pts = [tuple(self.mid.pt(i, side * DECK_OFF, 0.0)) for i in range(len(self.mid))]
            self.decks[side] = DeckPath(pts)
        # which OSM line is on which side (for the transition to the tunnel)
        a_side = 1 if f(A[len(A) // 2])[0] - np.interp(0, [0], [0]) > f(B[len(B) // 2])[0] else -1
        # transitions: from the tunnel portal to W2 (lower deck = A, upper deck = Bup)
        portal = np.array(EL['portalE'])
        self.trans = {}
        for side, line, z0 in ((a_side, np.vstack([portal, A]), 46.4), (-a_side, Bup, 56.0)):
            Lf = np.array([f(p) for p in line])
            # keep the part before W2 and join the offset deck start
            end = np.array(self.decks[side].pt(0)[:2])
            keep = [p for p in Lf if p[1] < end[1] - 25.0]
            pts2 = np.vstack([keep, end[None, :]]) if keep else np.array([Lf[0], end])
            pr, _ = resample(pts2, step / 2 if lod == 0 else step)
            pr = smooth(pr, k=2, it=2)
            pr[-1] = end
            n = len(pr)
            zs = [z0 + (self.D(self.sW2) - z0) * (0.5 - 0.5 * math.cos(math.pi * i / (n - 1))) for i in range(n)]
            self.trans[side] = DeckPath([(p[0], p[1], z) for p, z in zip(pr, zs)])
        self.bike_side = 1
        self.east_side = a_side            # the A carriageway (lower tunnel deck) carries eastbound traffic

    # -------------------------------------------------------------------------- decks
    def deck_surface(self, P, side, girder='steel', depth_fn=None, i0=0, i1=None, bike=False):
        lod = self.lod
        road, rail, walk = self.mb['road'], self.mb['rail'], self.mb['walk']
        gm = self.mb[girder]
        P.strip(road, -11.6, 11.6, 0.0, uv='road', ts=12.192, i0=i0, i1=i1)
        if lod == 2:
            box_girder(gm, P, DHW, DHW - 3.0, 5.0, i0=i0, i1=i1)
            return
        cm = self.mb['concrete']
        for sgn in (-1, 1):
            a, b = sorted((sgn * 11.6, sgn * 12.1))
            P.strip(cm, a, b, 1.05, i0=i0, i1=i1)
            P.strip(cm, sgn * 11.6, sgn * 11.6, 0.0, 1.05, flip=sgn < 0, i0=i0, i1=i1)
            a, b = sorted((sgn * 12.1, sgn * DHW))
            P.strip(gm, a, b, 0.1, i0=i0, i1=i1)
            P.rail(rail, sgn * 12.1, 1.05, 1.6, i0=i0, i1=i1)
        box_girder(gm, P, DHW, DHW - 3.2, 5.5, depth_fn=depth_fn, i0=i0, i1=i1, col=(0.85, 0.85, 0.85))
        if bike:
            b0, b1 = DHW, DHW + BIKE
            P.strip(walk, b0, b1, 0.1, i0=i0, i1=i1)
            P.strip(gm, b1, b0, -1.0, i0=i0, i1=i1, col=(0.7, 0.7, 0.7))
            P.strip(gm, b1, b1, -1.0, 0.1, flip=True, i0=i0, i1=i1)
            P.rail(rail, b1 - 0.1, 0.1, 1.5, i0=i0, i1=i1)

    def cross_beams(self):
        st = self.steps(self.sW2 + 15, self.sE2 - 10, 30.0)
        for s in st:
            if abs(s - self.sT) < 16:
                continue
            i = self.mid.index_at(s - self.mid_s0)
            a, b = self.mid.pt(i, -(DECK_OFF - DHW + 3.0), -3.2), self.mid.pt(i, DECK_OFF - DHW + 3.0, -3.2)
            self.mb['steel'].beam(a, b, 2.4, 3.2, col=(0.8, 0.8, 0.8))

    def steps(self, a, b, step):
        n = max(1, int(round((b - a) / step)))
        return [a + (b - a) * k / n for k in range(n + 1)]

    # -------------------------------------------------------------------------- SAS tower + cable
    def tower(self):
        wm, lod = self.mb['white'], self.lod
        top = 160.0
        c = self.mid.at(self.sT - self.mid_s0)
        cx, cy = c[0], c[1]
        cm = self.mb['concrete']
        cm.box((cx - 14.0, cy - 11.0, -10.0), (cx + 14.0, cy + 11.0, 6.0), ts=8.0, faces='xXyYZ')
        legs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
        for lx, ly in legs:
            b = (cx + lx * 3.3, cy + ly * 3.0)
            t = (cx + lx * 2.2, cy + ly * 2.0)
            if lod == 2:
                wm.box((b[0] - 1.6, b[1] - 1.6, 6.0), (b[0] + 1.6, b[1] + 1.6, top), faces='xXyYZ')
                continue
            column(wm, (b[0], b[1], 0), 3.6, 3.4, 6.0, top - 4.0, w_top=2.4, d_top=2.3, chamfer=0.9, c_top=(t[0], t[1], 0))
        if lod < 2:
            # shear link beams between the legs
            zs = np.arange(20.0, top - 8.0, 11.0 if lod == 0 else 22.0)
            for z in zs:
                k = (z - 6.0) / (top - 10.0)
                ox, oy = 3.3 + (2.2 - 3.3) * k, 3.0 + (2.0 - 3.0) * k
                for (ax, ay), (bx, by) in (((-1, -1), (1, -1)), ((-1, 1), (1, 1)), ((-1, -1), (-1, 1)), ((1, -1), (1, 1))):
                    wm.beam((cx + ax * ox, cy + ay * oy, z), (cx + bx * ox, cy + by * oy, z), 0.9, 1.6, col=(0.9, 0.9, 0.9))
            # saddle grillage at the top
            wm.box((cx - 3.6, cy - 3.2, top - 4.0), (cx + 3.6, cy + 3.2, top - 0.5), faces='xXyYZz')
        self.mb['warn'].cylinder((cx, cy, top - 0.5), 0.4, 1.0, sides=8)
        if self.meta:
            self.meta.light((cx, cy, top + 1.0), '#ff2a14', size=7.0, period=1.5, duty=0.5, phase=0.2)
            self.meta.light((cx + 3.6, cy, 105.0), '#ff2a14', size=4.0, period=1.5, duty=0.5, phase=0.2)
            self.meta.light((cx - 3.6, cy, 105.0), '#ff2a14', size=4.0, period=1.5, duty=0.5, phase=0.2)
            self.meta.box((cx - 5.5, cy - 5.0, -10.0), (cx + 5.5, cy + 5.0, top), NAME)
        self.tower_top = V(cx, cy, top - 2.5)

    def cable(self):
        """Single main cable: E2 (south deck edge) -> tower -> around the west end at W2 -> tower -> E2 (north deck)."""
        cm, lod = self.mb['white'], self.lod
        sides = {0: 12, 1: 8, 2: 6}[lod]
        n = {0: 60, 1: 24, 2: 10}[lod]
        top = self.tower_top
        edge = DECK_OFF + DHW + 0.3
        zE2 = self.D(self.sE2) + 1.2
        zW2 = self.D(self.sW2) - 4.5
        strands = []
        for side in (-1, 1):
            main, back = [], []
            for i in range(n + 1):
                t = i / n
                s = self.sT + (self.sE2 - self.sT) * t
                x = side * (1.4 + (edge - 1.4) * t)
                z = zE2 + (top[2] - zE2) * (1 - t) ** 2
                c = self.mid.at(s - self.mid_s0, x, 0.0)
                main.append(V(c[0], c[1], z))
                s2 = self.sT - (self.sT - self.sW2) * t
                x2 = side * (1.4 + (edge - 1.4) * t)
                z2 = zW2 + (top[2] - zW2) * (1 - t) ** 2
                c2 = self.mid.at(s2 - self.mid_s0, x2, 0.0)
                back.append(V(c2[0], c2[1], z2))
            strands.append((side, main, back))
            cm.tube(main, 0.39, sides=sides, ts=3.0)
            cm.tube(back, 0.39, sides=sides, ts=3.0)
            if self.meta:
                for pts in (main, back):
                    for p0, p1 in zip(pts[:-1:3], pts[3::3]):
                        self.meta.capsule(p0, p1, 0.8, NAME)
        # west-end loop under the deck ends (deviation saddle)
        loop = []
        for i in range(17):
            a = math.pi * i / 16
            x = -edge * math.cos(a)
            ds = -6.0 * math.sin(a)
            c = self.mid.at(self.sW2 - self.mid_s0 + ds, x, 0.0)
            loop.append(V(c[0], c[1], zW2))
        cm.tube(loop, 0.39, sides=sides, ts=3.0)
        if lod == 2:
            return
        # suspenders: from the cable down to the outer deck edges, ~10 m spacing
        for side, main, back in strands:
            for pts, s0, s1 in ((main, self.sT, self.sE2), (back, self.sT, self.sW2)):
                L = abs(s1 - s0)
                k = 1
                while k * 10.0 < L - 8.0:
                    t = k * 10.0 / L
                    j = t * n
                    i0 = int(j)
                    p = pts[i0] + (pts[min(i0 + 1, n)] - pts[i0]) * (j - i0)
                    s = s0 + (s1 - s0) * t
                    q = self.mid.at(s - self.mid_s0, side * edge, 0.3)
                    if p[2] - q[2] > 1.5:
                        if lod == 0:
                            cm.tube([p - V(0, 0, 0.3), q], 0.045, sides=4)
                            cm.tube([p + V(0, 0, 0.0), p + V(0, 0, 0.0) + norm(q - p) * 0.9], 0.5, sides=8, closed_ends=True)
                        else:
                            cm.beam(p, q, 0.12, 0.12, caps=False)
                        if self.meta and k % 2 == 0:
                            self.meta.capsule(q + V(0, 0, 1.0), p, 0.25, NAME)
                    k += 1

    # -------------------------------------------------------------------------- piers
    def piers(self):
        cm, lod = self.mb['concrete'], self.lod
        # E2: massive cap beam across both decks
        s = self.sE2 - self.mid_s0
        c0 = self.mid.at(s, -(DECK_OFF + DHW + 2), -5.8)
        c1 = self.mid.at(s, DECK_OFF + DHW + 2, -5.8)
        cm.beam(c0, c1, 12.0, 7.0, col=(0.9, 0.9, 0.88))
        for side in (-1, 1):
            p = self.mid.at(s, side * DECK_OFF, 0)
            column(cm, (p[0], p[1], 0), 12.0, 9.0, -10.0, p[2] - 9.0, chamfer=1.5, yaw=-self.heading * 0 + 0, top=False)
            if self.meta:
                self.meta.box((p[0] - 7, p[1] - 6, -10.0), (p[0] + 7, p[1] + 6, p[2] - 0.5), NAME)
        # W2: pier on YBI
        s = self.sW2 - self.mid_s0
        for side in (-1, 1):
            p = self.mid.at(s + 3.0, side * DECK_OFF, 0)
            column(cm, (p[0], p[1], 0), 10.0, 6.0, -15.0, p[2] - 5.8, chamfer=1.0)
        # Skyway + touchdown piers
        sp = []
        s = self.sE2 + 160.0
        while s < self.s_end - 430:
            sp.append(s)
            s += 160.0 if s < self.sE2 + 1500 else 100.0
        s = sp[-1] + 60.0 if sp else self.sE2 + 60
        while s < self.s_end - 10:
            sp.append(s)
            s += 55.0
        self.sky_piers = sp
        for s in sp:
            for side in (-1, 1):
                d = self.decks[side]
                z = self.D(s)
                depth = self.sky_depth(s)
                p = d.at(s - self.mid_s0, 0, 0)
                tdir = d.tangent_at(s - self.mid_s0)
                yaw = math.atan2(tdir[1], tdir[0]) - math.pi / 2
                h = z - 0.25 - depth
                w = 8.5 if z > 20 else 6.0
                if lod == 2:
                    cm.box((p[0] - 2.5, p[1] - 2.5, -8.0), (p[0] + 2.5, p[1] + 2.5, h), faces='xXyY')
                    continue
                column(cm, (p[0], p[1], 0), w, 4.2, -8.0, h - 2.5, chamfer=0.6, yaw=yaw, top=False)
                column(cm, (p[0], p[1], 0), w, 4.2, h - 2.5, h, w_top=w + 3.0, d_top=5.0, chamfer=0.6, yaw=yaw)
                if self.meta:
                    self.meta.box((p[0] - w / 2 - 1, p[1] - w / 2 - 1, -8.0), (p[0] + w / 2 + 1, p[1] + w / 2 + 1, h), NAME)

    def sky_depth(self, s):
        if s <= self.sE2 + 2:
            return 5.5
        piers = getattr(self, 'sky_piers', [])
        if not piers:
            return 5.5
        d = min(abs(s - p) for p in piers + [self.sE2])
        span = 160.0 if s < self.sE2 + 1500 else 100.0 if s < self.s_end - 430 else 55.0
        if span < 60:
            return 3.2
        return 5.5 + 3.8 * max(0.0, 1 - d / (span * 0.3)) ** 2

    # -------------------------------------------------------------------------- assemble
    def build(self):
        lod = self.lod
        self.piers()
        i_e2 = self.mid.index_at(self.sE2 - self.mid_s0)
        for side in (-1, 1):
            P = self.decks[side]
            bike = side == self.bike_side
            self.deck_surface(P, side, 'steel', i1=i_e2, bike=bike)
            self.deck_surface(P, side, 'concrete', depth_fn=lambda s: self.sky_depth(s + self.mid_s0), i0=i_e2, bike=bike)
            self.deck_surface(self.trans[side], side, 'concrete', bike=False)
            if self.meta:
                for Q in (P, self.trans[side]):
                    L = Q.length
                    n = max(1, int(math.ceil(L / 40.0)))
                    for k in range(n):
                        a, b = L * k / n, L * (k + 1) / n
                        pa, pb = Q.at(a), Q.at(b)
                        c = (pa + pb) / 2
                        d = pb - pa
                        top = max(pa[2], pb[2]) + 1.0
                        self.meta.obox((c[0], c[1], top - 5.0), (d[0], d[1]), DHW + (BIKE if bike else 0), float(np.linalg.norm(d[:2])) / 2 + 0.5, 5.0, NAME)
            # transition columns
            T = self.trans[side]
            for k in range(1, max(2, int(T.length / 45.0))):
                s = T.length * k / max(2, int(T.length / 45.0))
                p = T.at(s)
                column(self.mb['concrete'], (p[0], p[1], 0), 5.0, 3.5, -15.0, p[2] - 4.5, chamfer=0.4, top=False)
        if lod < 2:
            self.cross_beams()
        self.tower()
        self.cable()
        if self.meta:
            # traffic: eastbound = lower tunnel deck line (A), westbound = upper deck (Bup); 5 lanes on each deck
            a_side = [k for k, v in self.trans.items()][0]
            for side in (-1, 1):
                T, P = self.trans[side], self.decks[side]
                east = side == self.east_side
                for k, x in enumerate((-7.2, -3.6, 0.0, 3.6, 7.2)):
                    pts = [T.pt(i, x, 0.02) for i in range(0, len(T) - 1)] + [P.pt(i, x, 0.02) for i in range(len(P))]
                    if not east:
                        pts = pts[::-1]
                    self.meta.lane(pts, speed=24.0 - 0.8 * k)
            # navigation lights on the E2 pier, deck lamps (night)
            s = self.sW2 - self.mid_s0
            while s < self.s_end - self.mid_s0:
                for side in (-1, 1):
                    p = self.decks[side].at(s, 0.0, 11.0)
                    self.meta.light(p, '#ffe2b0', size=5.0, period=0, kind='lamp', intensity=0.55)
                s += 55.0

    def objects(self, prefix):
        return [mb.to_object(f'{prefix}_{k}', self.M[k], use_colors=True) for k, mb in self.mb.items() if len(mb)]


# ============================================================================================ main
def run(kind):
    results = {}
    meta = None
    frame = None
    for lod in (0, 1, 2):
        b = West(lod) if kind == 'west' else East(lod)
        b.build()
        name = f'bay_bridge_{kind}' + ('' if lod == 0 else f'_lod{lod}')
        obs = b.objects(f'bb{kind[0]}' + ('' if lod == 0 else f'_lod{lod}'))
        path = os.path.join(OUT, f'{name}.glb')
        export(path, obs, draco_bits=19)
        tris = tri_count(obs)
        results[lod] = tris
        print(f'{kind} LOD{lod}: {tris} triangles -> {path} ({os.path.getsize(path) / 1e6:.2f} MB)')
        if lod == 0:
            meta = b.meta
            if kind == 'east':
                frame = ({'x': round(float(b.origin[0]), 2), 'z': round(float(b.origin[1]), 2)}, float(b.heading))
            # bounds from the geometry (three local)
            vs = np.array([tuple(v.co) for o in obs for v in o.data.vertices])
            mn, mx = vs.min(axis=0), vs.max(axis=0)
            bounds = {'min': [float(mn[0]), float(mn[2]), float(-mx[1])], 'max': [float(mx[0]), float(mx[2]), float(-mn[1])]}
        for o in obs:
            o.hide_set(True)
            o.hide_render = True
    if kind == 'west':
        origin, heading = WL['origin'], WL['heading']
    else:
        origin, heading = frame
    meta.d.update({
        'origin': origin, 'heading': heading, 'base': 'absolute',
        'lods': [{'url': f'assets/sf/landmarks/bay_bridge_{kind}.glb', 'dist': 3000},
                 {'url': f'assets/sf/landmarks/bay_bridge_{kind}_lod1.glb', 'dist': 12000},
                 {'url': f'assets/sf/landmarks/bay_bridge_{kind}_lod2.glb', 'dist': 1e9}],
        'tris': {str(k): v for k, v in results.items()}, 'bounds': bounds,
    })
    meta.save()


def main():
    reset_scene()
    kinds = [a for a in sys.argv[sys.argv.index('--') + 1:]] if '--' in sys.argv else ['west', 'east']
    for k in kinds:
        run(k)


if __name__ == '__main__':
    main()
