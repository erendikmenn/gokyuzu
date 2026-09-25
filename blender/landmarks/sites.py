"""Priority-4 landmark sites (W3): Alcatraz, Fort Point, City Hall, Palace of Fine Arts, Oracle Park, Chase Center,
Painted Ladies, Pier 39 and the Port of Oakland container cranes (instanced).

Run:  Blender -b -P blender/landmarks/sites.py [-- alcatraz fortpoint cityhall palace oracle chase painted pier39 cranes]
Geometry from OSM footprints + 3DEP ground heights (blender/landmarks/layout.json['sites']). Multi-building sites are
modeled at their real ground heights and every building carries a ground anchor (_ANCHOR attribute) so the runtime
re-snaps it to whatever terrain is loaded.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from lmkit import (MB, V, Meta, LAYOUT, OUT, material, export, tri_count, reset_scene, norm, texture, fbm, srgb, blur,  # noqa: E402
                   rng, polygon_hole, height_to_normal)
from bridgekit import column, DeckPath  # noqa: E402
from towers import Build, export_landmark, loft, facade_box  # noqa: E402
import tex_common as tx  # noqa: E402

S = LAYOUT['sites']
DEG = math.pi / 180


def to_frame(origin):
    ox, oz = origin
    return lambda p: (p[0] - ox, -(p[1] - oz))


def centroid2(poly):
    return sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)


def walls(mb, poly, z0, z1, tile_w, tile_h, base, col=None):
    """Extruded polygon walls with facade UVs (u = perimeter / tile_w, v = (z - base) / tile_h). poly CCW (x, y)."""
    n = len(poly)
    per = 0.0
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-3:
            continue
        mb.quad((a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1),
                uv=[(per / tile_w, (z0 - base) / tile_h), ((per + L) / tile_w, (z0 - base) / tile_h),
                    ((per + L) / tile_w, (z1 - base) / tile_h), (per / tile_w, (z1 - base) / tile_h)], col=col)
        per += L


def inset(poly, d):
    """Offset a CCW polygon inwards by d (miter)."""
    n = len(poly)
    out = []
    for i in range(n):
        p0, p1, p2 = V(*poly[i - 1]), V(*poly[i]), V(*poly[(i + 1) % n])
        e0, e1 = norm(p1 - p0), norm(p2 - p1)
        n0, n1 = V(-e0[1], e0[0]), V(-e1[1], e1[0])       # left normals (inwards for CCW)
        m = norm(n0 + n1)
        c = max(0.3, float(np.dot(m, n1)))
        q = p1 + m * (d / c)
        out.append((float(q[0]), float(q[1])))
    return out


def ccw(poly):
    a = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    return poly if a > 0 else poly[::-1]


def std_mats(prefix, lod, facade=None, extra=None):
    M = {}
    if facade:
        M.update(facade)
    M.update({
        'roof': material(f'{prefix}{lod}_roof', color=(0.22, 0.22, 0.23), rough=0.85),
        'concrete': material(f'{prefix}{lod}_concrete', color=(0.62, 0.60, 0.56), rough=0.9),
        'dark': material(f'{prefix}{lod}_dark', color=(0.03, 0.035, 0.04), rough=0.6),
        'warn': material(f'{prefix}{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
    })
    if extra:
        M.update(extra)
    return M


ALIASES = {'stone': 'granite', 'glass': 'dark', 'hall': 'stone', 'roofw': 'roof', 'side': 'wood', 'trim': 'wood',
           'green': 'dark', 'bottle': 'brick', 'lamp': 'white', 'rust': 'steel', 'solar': 'roof', 'pile': 'dark',
           'granite': 'concrete', 'iron': 'dark', 'white': 'concrete', 'steel': 'concrete'}


def complete(mats):
    """Low LODs define fewer materials: map missing keys onto similar ones (same draw call)."""
    changed = True
    while changed:
        changed = False
        for k, v in ALIASES.items():
            if k not in mats and v in mats:
                mats[k] = mats[v]
                changed = True
    return mats


class Site(Build):
    def __init__(self, lid, name, lod, mats, origin):
        super().__init__(lid, name, lod, complete(mats))
        self.f = to_frame(origin)

    def objects(self, prefix):
        # merge builders that share a material (aliases) into one object each
        groups = {}
        for k, mb in self.mb.items():
            if len(mb):
                groups.setdefault(self.M[k].name, []).append((k, mb))
        obs = []
        for mname, lst in groups.items():
            k0, mb0 = lst[0]
            merged = MB(k0)
            for _, mb in lst:
                merged.merge(mb)
            obs.append(merged.to_object(f'{prefix}_{k0}', self.M[k0], use_colors=True))
        return obs

    def anchor(self, X, Y, g):
        a = (float(X), float(g), float(-Y))
        for mb in self.mb.values():
            mb.anchor = a
        if self.meta:
            self.meta.anchor = a

    def building(self, poly_w, floor, height, facade='facade', tile=(4.0, 3.6), roof='roof', parapet=0.8, skirt=4.0,
                 gc=None, name=None, flat_top=True):
        """Extrude a world polygon: walls from floor-skirt to floor+height, flat roof + parapet. Returns local poly."""
        poly = ccw([self.f(p) for p in poly_w])
        cx, cy = centroid2(poly)
        self.anchor(cx, cy, gc if gc is not None else floor)
        top = floor + height
        walls(self.mb[facade], poly, floor - skirt, top, tile[0], tile[1], floor)
        if flat_top:
            if parapet and self.lod == 0 and len(poly) < 40:
                inner = inset(poly, 0.35)
                walls(self.mb[facade], poly, top, top + parapet, tile[0], tile[1], floor)
                self.mb[roof].polygon([(x, y, top) for x, y in inner])
                walls(self.mb['concrete'], inner[::-1], top, top + parapet, 4.0, 4.0, 0)
                for i in range(len(poly)):
                    a, b = poly[i], poly[(i + 1) % len(poly)]
                    c, d = inner[(i + 1) % len(poly)], inner[i]
                    self.mb['concrete'].quad((a[0], a[1], top + parapet), (b[0], b[1], top + parapet), (c[0], c[1], top + parapet), (d[0], d[1], top + parapet))
            else:
                self.mb[roof].polygon([(x, y, top) for x, y in poly])
        if self.meta:
            xs, ys = [p[0] for p in poly], [p[1] for p in poly]
            self.meta.box((min(xs), min(ys), floor - skirt), (max(xs), max(ys), top + (parapet if flat_top else 0)), name or self.name)
        return poly


# ================================================================================================ Alcatraz
ALC = S['alcatraz']
ALC_ORIGIN = tuple(ALC['origin'])
# name -> (height, floor mode 'min'|'max'|'c', facade key, ruin?)
ALC_H = {
    'Main Prison': (14.5, 'max', 'cell', False), 'Dining Hall': (11.5, 'max', 'cell', False),
    'Administration Block': (12.5, 'max', 'bldg', False), 'New Industries Building': (9.0, 'min', 'bldg', False),
    'Model Industries Building': (8.5, 'min', 'bldg', False), 'Powerhouse': (10.0, 'min', 'bldg', False),
    'Quartermaster': (7.0, 'min', 'bldg', False), 'Building 64': (15.5, 'min', 'b64', False),
    "Post Exchange & Officers' Club": (5.5, 'c', 'ruin', True), "Warden's House": (9.0, 'max', 'ruin', True),
    'Sally Port': (8.0, 'min', 'bldg', False), 'Electric Shop': (5.0, 'min', 'bldg', False),
    'Former Military Chapel': (8.5, 'min', 'b64', False), 'Restrooms': (3.2, 'min', 'bldg', False), 'Morgue': (3.0, 'c', 'bldg', False),
    'Guard Tower': (11.0, 'min', 'bldg', False), 'Cistern': (1.2, 'c', 'concrete', False),
}


def alcatraz_materials(lod):
    if lod == 2:
        return {'cell': material('alc2_cell', color=(0.66, 0.64, 0.60), rough=0.85),
                'bldg': material('alc2_bldg', color=(0.60, 0.57, 0.51), rough=0.85),
                'b64': material('alc2_b64', color=(0.55, 0.48, 0.38), rough=0.85),
                'ruin': material('alc2_ruin', color=(0.45, 0.38, 0.33), rough=0.9),
                'roof': material('alc2_roof', color=(0.35, 0.35, 0.36), rough=0.8),
                'concrete': material('alc2_concrete', color=(0.6, 0.58, 0.55), rough=0.9),
                'steel': material('alc2_steel', color=(0.7, 0.68, 0.64), rough=0.6),
                'white': material('alc2_white', color=(0.85, 0.85, 0.83), rough=0.5),
                'dark': material('alc2_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'warn': material('alc2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 512 if lod == 0 else 128
    ca, co, cn, _ = tx.window_facade(f'alc{lod}_cell', size=sz, cols=2, rows=1, frame='#C9C2B3', glass='#23282B', win_w=0.34, win_h=0.7,
                                     seed=141, lit=0.0, streaks=0.18, mullion_h=4, mullion_v=2, h=sz)
    ba, bo, bn, _ = tx.window_facade(f'alc{lod}_bldg', size=sz, cols=4, rows=2, frame='#BDB29E', glass='#2A2E30', win_w=0.45, win_h=0.5,
                                     seed=143, lit=0.0, streaks=0.2)
    b6a, _, b6n, _ = tx.window_facade(f'alc{lod}_b64', size=sz, cols=4, rows=2, frame='#A9977A', glass='#2A2D2E', win_w=0.4, win_h=0.52,
                                      seed=145, lit=0.08, streaks=0.2)
    ra, _, rn, _ = tx.window_facade(f'alc{lod}_ruin', size=sz, cols=3, rows=2, frame='#8C7462', glass='#141414', win_w=0.45, win_h=0.55,
                                    seed=147, lit=0.0, streaks=0.3)

    def solar():
        s = 512
        img = np.zeros((s, s, 3))
        yy, xx = np.mgrid[0:s, 0:s] / s
        panel = (np.abs((xx * 4) % 1 - 0.5) < 0.46) & (np.abs((yy * 8) % 1 - 0.5) < 0.44)
        img[:] = srgb('#8C8C88')
        img[panel] = srgb('#1C2433')
        cells = panel & ((np.abs((xx * 24) % 1 - 0.5) > 0.47) | (np.abs((yy * 48) % 1 - 0.5) > 0.45))
        img[cells] = srgb('#3A4658')
        return img
    sa = texture(f'alc{lod}_solar_albedo', solar, 'jpg')
    M = {'cell': material(f'alc{lod}_cell', albedo=ca, rough=0.8, **({'normal': cn} if lod == 0 else {})),
         'bldg': material(f'alc{lod}_bldg', albedo=ba, rough=0.85, **({'normal': bn} if lod == 0 else {})),
         'b64': material(f'alc{lod}_b64', albedo=b6a, rough=0.85, **({'normal': b6n} if lod == 0 else {})),
         'ruin': material(f'alc{lod}_ruin', albedo=ra, rough=0.9, double_sided=True),
         'solar': material(f'alc{lod}_solar', albedo=sa, rough=0.3),
         'steel': material(f'alc{lod}_steel', color=(0.70, 0.67, 0.62), rough=0.6),
         'rust': material(f'alc{lod}_rust', color=(0.30, 0.17, 0.12), rough=0.8),
         'white': material(f'alc{lod}_white', color=(0.86, 0.86, 0.84), rough=0.5),
         'lamp': material(f'alc{lod}_lamp_emit', color=(0.9, 0.9, 0.8), emissive=(1.0, 0.95, 0.8), emissive_strength=3.0)}
    return std_mats('alc', lod, M)


def build_alcatraz(lod):
    b = Site('alcatraz', 'Alcatraz Hapishanesi', lod, alcatraz_materials(lod), ALC_ORIGIN)
    for bd in ALC['buildings']:
        nm = bd['name']
        if nm in ('Water Tower', 'Alcatraz Island Lighthouse'):
            continue
        if nm == '' and bd['building'] == 'yes' and bd['man_made'] == 'chimney':
            continue
        h, mode, fac, ruin = ALC_H.get(nm, (3.5, 'min', 'bldg', bd['building'] == 'ruins'))
        if bd['building'] == 'ruins':
            ruin, fac = True, 'ruin'
        floor = {'min': bd['g'], 'max': bd['gmax'] - 0.8, 'c': bd['gc']}[mode]
        if lod == 2 and h < 5:
            continue
        key = fac if lod < 2 or fac in b.mb else 'bldg'
        tile = (6.0, 7.0) if fac == 'cell' else (8.0, 7.0)
        if ruin:
            # roofless shell: walls only (both faces via double-sided material)
            poly = ccw([b.f(p) for p in bd['poly']])
            cx, cy = centroid2(poly)
            b.anchor(cx, cy, bd['gc'])
            walls(b.mb[key], poly, floor - 3.0, floor + h, 7.0, 7.0, floor)
            if b.meta:
                xs, ys = [p[0] for p in poly], [p[1] for p in poly]
                b.meta.box((min(xs), min(ys), floor - 3), (max(xs), max(ys), floor + h), 'Alcatraz Hapishanesi')
            continue
        roof = 'solar' if nm == 'Main Prison' and lod < 2 else 'roof'
        b.building(bd['poly'], floor, h, facade=key, tile=tile, roof=roof, gc=bd['gc'], name='Alcatraz Hapishanesi',
                   parapet=0.9 if h > 6 else 0.0)
    # recreation yard walls
    y = ALC['yard']
    c = b.f(y['c'])
    a = -y['angle'] * DEG           # world angle measured in (x, z) -> frame (x, -z)
    ax, ay = V(math.cos(a), math.sin(a), 0), V(-math.sin(a), math.cos(a), 0)
    b.anchor(c[0], c[1], y['gc'])
    corners = [V(c[0], c[1], 0) + ax * sx * y['w'] / 2 + ay * sy * y['d'] / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for i in range(4):
        p0, p1 = corners[i], corners[(i + 1) % 4]
        b.mb['concrete'].beam(p0 + V(0, 0, y['gc'] + 2.0), p1 + V(0, 0, y['gc'] + 2.0), 0.6, 8.0, caps=True, col=(0.9, 0.9, 0.88))
    if b.meta:
        for i in range(4):
            b.meta.capsule(corners[i] + V(0, 0, y['gc'] + 3), corners[(i + 1) % 4] + V(0, 0, y['gc'] + 3), 3.0, 'Alcatraz Hapishanesi')
    # water tower, lighthouse, powerhouse chimney
    for bd in ALC['buildings']:
        poly = [b.f(p) for p in bd['poly']]
        cx, cy = centroid2(poly)
        g = bd['gc']
        if bd['name'] == 'Water Tower':
            b.anchor(cx, cy, g)
            r = 6.7
            if lod < 2:
                for k in range(6):
                    t = 2 * math.pi * k / 6
                    b.mb['rust'].beam((cx + 6.2 * math.cos(t), cy + 6.2 * math.sin(t), g - 2), (cx + 5.4 * math.cos(t), cy + 5.4 * math.sin(t), g + 20.5), 0.5, 0.5)
                for zz in (g + 7, g + 14):
                    for k in range(6):
                        t0, t1 = 2 * math.pi * k / 6, 2 * math.pi * (k + 1) / 6
                        rr = 6.2 - 0.8 * (zz - g) / 22
                        b.mb['rust'].beam((cx + rr * math.cos(t0), cy + rr * math.sin(t0), zz), (cx + rr * math.cos(t1), cy + rr * math.sin(t1), zz), 0.25, 0.25)
            b.mb['steel'].cylinder((cx, cy, g + 20.5), r, 10.0, sides=20 if lod == 0 else 10, cap_top=False, cap_bottom=True)
            b.mb['steel'].cylinder((cx, cy, g + 30.5), r, 3.0, sides=20 if lod == 0 else 10, r_top=0.4)
            if b.meta:
                b.meta.box((cx - r, cy - r, g), (cx + r, cy + r, g + 33.5), 'Alcatraz Hapishanesi')
        elif bd['name'] == 'Alcatraz Island Lighthouse':
            b.anchor(cx, cy, g)
            ring = lambda rr: [(cx + rr * math.cos(2 * math.pi * (k + 0.5) / 8), cy + rr * math.sin(2 * math.pi * (k + 0.5) / 8)) for k in range(8)]
            loft(b.mb['white'], [ring(2.3), ring(1.6)], [g - 2, g + 21.0], cap_top=True)
            loft(b.mb['white'], [ring(2.6), ring(2.6)], [g + 21.0, g + 21.6], cap_top=True)
            loft(b.mb['dark'], [ring(1.5), ring(1.5)], [g + 21.6, g + 24.4], cap_top=False)
            loft(b.mb['roof'], [ring(1.7), ring(0.2)], [g + 24.4, g + 26.0], cap_top=True)
            if lod < 2:
                b.mb['lamp'].cylinder((cx, cy, g + 22.2), 0.6, 1.6, sides=8)
            if b.meta:
                b.meta.box((cx - 2.3, cy - 2.3, g - 2), (cx + 2.3, cy + 2.3, g + 26.0), 'Alcatraz Hapishanesi')
                b.meta.light((cx, cy, g + 23.0), '#fff6e0', size=9.0, period=5.0, duty=0.18, kind='nav')
        elif bd['man_made'] == 'chimney':
            b.anchor(cx, cy, g)
            b.mb['concrete'].cylinder((cx, cy, g - 2), 1.7, 32.0, sides=12 if lod == 0 else 8, r_top=1.3)
            if b.meta:
                b.meta.capsule((cx, cy, g), (cx, cy, g + 30), 1.8, 'Alcatraz Hapishanesi')
    return b


# ================================================================================================ Fort Point
FP = S['fort_point']
FP_ORIGIN = centroid2(FP['outer'])


def fort_materials(lod):
    if lod == 2:
        return {'brick': material('fpt2_brick', color=(0.42, 0.24, 0.18), rough=0.9),
                'roof': material('fpt2_roof', color=(0.45, 0.43, 0.40), rough=0.9),
                'concrete': material('fpt2_concrete', color=(0.55, 0.53, 0.5), rough=0.9),
                'dark': material('fpt2_dark', color=(0.03, 0.03, 0.03), rough=0.9),
                'warn': material('fpt2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 512 if lod == 0 else 128

    def brick():
        W = H = sz
        img = np.zeros((H, W, 3))
        base = srgb('#8A4A36')
        yy, xx = np.mgrid[0:H, 0:W]
        rows = 48
        row = (yy * rows // H)
        off = (row % 2) * (W // 16)
        mortar = ((yy * rows) % H < H / rows * 0.18) | (((xx + off) * 8) % W < W / 8 * 0.06)
        r = rng(151)
        var = r.uniform(-1, 1, (rows, 8))[row % rows, ((xx + off) * 8 // W) % 8]
        img[:] = base * (1 + 0.1 * var[:, :, None]) * (1 + 0.06 * fbm(H, W, 152, 4, 8)[:, :, None])
        img[mortar] = srgb('#A89A88')
        # three tiers of arched casemate openings (tile = 8 m wide x 15 m tall)
        u = xx / W
        v = 1 - yy / H
        for v0, v1 in ((0.06, 0.2), (0.38, 0.52), (0.7, 0.8)):
            body = (np.abs(u - 0.5) < 0.09) & (v > v0) & (v < v1)
            head = ((u - 0.5) ** 2 / 0.09 ** 2 + ((v - v1) / (0.09 * W / H)) ** 2 < 1) & (v >= v1)
            img[body | head] = srgb('#1A1614')
        img *= (1 - 0.25 * np.clip(0.12 - v, 0, 1) / 0.12)[:, :, None]
        return img
    ba = texture(f'fpt{lod}_brick_albedo', brick, 'jpg')
    return std_mats('fpt', lod, {'brick': material(f'fpt{lod}_brick', albedo=ba, rough=0.9, double_sided=False),
                                  'granite': material(f'fpt{lod}_granite', color=(0.55, 0.53, 0.50), rough=0.85),
                                  'iron': material(f'fpt{lod}_iron', color=(0.12, 0.12, 0.12), rough=0.5, metal=0.6)})


def build_fortpoint(lod):
    b = Site('fort_point', 'Fort Point Kalesi', lod, fort_materials(lod), FP_ORIGIN)
    outer = ccw([b.f(p) for p in FP['outer']])
    inner = ccw([b.f(p) for p in FP['inner']]) if FP.get('inner') else None
    g = FP['g']
    b.anchor(0.0, 0.0, FP['gc'])
    H = 15.0
    walls(b.mb['brick'], outer, g - 3.0, g + H, 8.0, 15.0, g)
    if inner and lod < 2:
        walls(b.mb['brick'], inner[::-1], g, g + H - 1.0, 8.0, 15.0, g)
        polygon_hole(b.mb['roof'], outer, inner, g + H)
        b.mb['concrete'].polygon([(x, y, g + 0.2) for x, y in inner])
    else:
        b.mb['roof'].polygon([(x, y, g + H) for x, y in outer])
    if lod == 0:
        # granite parapet on the barbette tier
        walls(b.mb['granite'], outer, g + H, g + H + 1.1, 4.0, 4.0, 0)
        walls(b.mb['granite'], inset(outer, 0.8)[::-1], g + H, g + H + 1.1, 4.0, 4.0, 0)
        polygon_hole(b.mb['granite'], outer, inset(outer, 0.8), g + H + 1.1)
        # Fort Point Light: small hexagonal iron lantern tower on the parapet
        lp = b.f((-9156.0, -21199.0))
        b.mb['iron'].cylinder((lp[0], lp[1], g + H), 1.2, 7.5, sides=6, r_top=0.9)
        b.mb['dark'].cylinder((lp[0], lp[1], g + H + 7.5), 0.9, 1.5, sides=6, cap_top=False)
        b.mb['iron'].cylinder((lp[0], lp[1], g + H + 9.0), 1.0, 1.0, sides=6, r_top=0.1)
    if b.meta:
        xs, ys = [p[0] for p in outer], [p[1] for p in outer]
        b.meta.box((min(xs), min(ys), g - 3), (max(xs), max(ys), g + H + 1.1), 'Fort Point Kalesi')
    return b


# ================================================================================================ City Hall
CH = S['city_hall']
CH_ORIGIN = centroid2(CH['outer'])
CH_ANGLE = -9.32   # world angle of the E-W facade direction


def cityhall_materials(lod):
    if lod == 2:
        return {'granite': material('cth2_granite', color=(0.62, 0.61, 0.58), rough=0.8),
                'copper': material('cth2_copper', color=(0.22, 0.38, 0.33), rough=0.6),
                'dome': material('cth2_dome', color=(0.30, 0.34, 0.33), rough=0.5),
                'gold': material('cth2_gold', color=(0.8, 0.6, 0.25), rough=0.3, metal=1.0),
                'roof': material('cth2_roof', color=(0.3, 0.3, 0.31), rough=0.8),
                'concrete': material('cth2_concrete', color=(0.6, 0.6, 0.57), rough=0.9),
                'dark': material('cth2_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'warn': material('cth2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 1024 if lod == 0 else 256
    fa, fo, fn, fe = tx.window_facade(f'cth{lod}_facade', size=sz, cols=4, rows=2, frame='#CFCBC1', glass='#262B30', win_w=0.36, win_h=0.55,
                                      seed=161, lit=0.2, streaks=0.05, mullion_h=1)

    def dome():
        s = 512
        img = np.zeros((s, s, 3))
        xx = np.arange(s) / s
        rib = (np.abs((xx * 16) % 1 - 0.5) > 0.44)
        img[:] = srgb('#4D5F5B')
        img *= (1 + 0.08 * fbm(s, s, 163, 4, 4))[:, :, None]
        img[:, rib] = srgb('#C9A04A')
        # gilded garland band near the base
        img[int(s * 0.88):int(s * 0.92), :] = srgb('#C9A04A')
        return img
    da = texture(f'cth{lod}_dome_albedo', dome, 'jpg')
    return std_mats('cth', lod, {
        'granite': material(f'cth{lod}_facade_emit', albedo=fa, emissive_img=fe, emissive_strength=0.8,
                            **({'rough_img': fo, 'normal': fn} if lod == 0 else {'rough': 0.7})),
        'stone': material(f'cth{lod}_stone', color=(0.66, 0.64, 0.60), rough=0.75),
        'copper': material(f'cth{lod}_copper', color=(0.24, 0.42, 0.36), rough=0.6, metal=0.2),
        'dome': material(f'cth{lod}_dome', albedo=da, rough=0.45, metal=0.4),
        'gold': material(f'cth{lod}_gold', color=(0.85, 0.63, 0.26), rough=0.3, metal=1.0),
        'glass': material(f'cth{lod}_glass', color=(0.15, 0.2, 0.22), rough=0.1)})


def build_cityhall(lod):
    b = Site('city_hall', 'Belediye Binası (City Hall)', lod, cityhall_materials(lod), CH_ORIGIN)
    g = CH['gc']
    b.anchor(0.0, 0.0, g)
    outer = ccw([b.f(p) for p in CH['outer']])
    if lod == 2:
        from lmkit import earcut  # noqa
    H = 27.0
    walls(b.mb['granite'], outer, g - 4.0, g + H, 8.0, 9.0, g)
    # mansard band (green copper) + flat roof
    mans = inset(outer, 2.5) if lod < 2 else outer
    if lod < 2:
        for i in range(len(outer)):
            a0, a1 = outer[i], outer[(i + 1) % len(outer)]
            c1, c0 = mans[(i + 1) % len(outer)], mans[i]
            b.mb['copper'].quad((a0[0], a0[1], g + H), (a1[0], a1[1], g + H), (c1[0], c1[1], g + H + 4.0), (c0[0], c0[1], g + H + 4.0))
    b.mb['roof'].polygon([(x, y, g + H + 4.0) for x, y in mans])
    # light courts (glass roofs) north and south of the rotunda
    a = CH_ANGLE * DEG
    ex, ey = V(math.cos(a), -math.sin(a), 0), V(math.sin(a), math.cos(a), 0)     # frame axes of the building (E, N)
    if lod < 2:
        for sy in (-1, 1):
            c = ey * (28.0 * sy)
            q = [c + ex * sx * 19.6 + ey * syy * 9.1 for sx, syy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            b.mb['glass'].quad(*(p + V(0, 0, g + H + 4.08) for p in q))
    # rotunda: square podium, colonnaded drum, attic, dome, lantern (dome 307.5 ft = 93.7 m)
    st = b.mb['stone']
    sq = [ex * sx * 18 + ey * sy * 18 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    walls(st, [(p[0], p[1]) for p in sq], g + H + 4.0, g + 40.0, 6.0, 6.0, 0)
    b.mb['roof'].polygon([(p[0], p[1], g + 40.0) for p in sq])
    ns = {0: 32, 1: 16, 2: 10}[lod]
    circ = lambda r: [(r * math.cos(2 * math.pi * k / ns), r * math.sin(2 * math.pi * k / ns)) for k in range(ns)]
    loft(st, [circ(15.5), circ(15.5)], [g + 40.0, g + 58.0], cap_top=False)
    if lod == 0:
        for k in range(32):
            t = 2 * math.pi * (k + 0.5) / 32
            st.cylinder((17.2 * math.cos(t), 17.2 * math.sin(t), g + 40.5), 0.75, 16.0, sides=8, cap_top=False)
        loft(st, [circ(18.2), circ(18.2)], [g + 56.5, g + 58.5], cap_top=True)
        loft(b.mb['dark'], [circ(15.55), circ(15.55)], [g + 44.0, g + 54.0], cap_top=False)
    loft(st, [circ(16.5), circ(16.5)], [g + 58.5, g + 62.5], cap_top=False)
    prof = [(16.0, 62.5), (15.6, 66.0), (14.6, 70.0), (12.8, 74.0), (10.0, 77.5), (6.2, 80.5), (3.6, 82.0)]
    loft(b.mb['dome'], [circ(r) for r, _ in prof], [g + z for _, z in prof], ts_u=1.0, ts_v=21.0, cap_top=True, smooth=True, angular=True)
    loft(b.mb['stone'], [circ(3.4), circ(3.4)], [g + 82.0, g + 88.0], cap_top=False)
    loft(b.mb['gold'], [circ(3.8), circ(2.0), circ(0.4)], [g + 88.0, g + 91.0, g + 93.7], cap_top=True)
    if b.meta:
        xs, ys = [p[0] for p in outer], [p[1] for p in outer]
        b.meta.box((min(xs), min(ys), g - 4), (max(xs), max(ys), g + H + 4), 'Belediye Binası (City Hall)')
        b.meta.box((-18, -18, g + H), (18, 18, g + 62.5), 'Belediye Binası (City Hall)')
        b.meta.capsule((0, 0, g + 62.5), (0, 0, g + 93.7), 8.0, 'Belediye Binası (City Hall)')
        b.meta.light((0, 0, g + 94.2), '#ff2a14', size=3.0, period=0)
    return b


# ================================================================================================ Palace of Fine Arts
PAL = S['palace']
ROT = PAL['288371295']
PAL_ORIGIN = centroid2(ROT['poly'])


def palace_materials(lod):
    ochre = (0.74, 0.55, 0.42)
    if lod == 2:
        return {'stone': material('pal2_stone', color=ochre, rough=0.85),
                'dome': material('pal2_dome', color=(0.72, 0.42, 0.30), rough=0.7),
                'roof': material('pal2_roof', color=(0.35, 0.35, 0.36), rough=0.8),
                'concrete': material('pal2_concrete', color=(0.6, 0.58, 0.55), rough=0.9),
                'dark': material('pal2_dark', color=(0.05, 0.05, 0.05), rough=0.9),
                'warn': material('pal2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sa, _, sn = tx.concrete_textures(f'pal{lod}_stone', base=(0.80, 0.62, 0.48), seed=171, size=512 if lod == 0 else 128, boards=1.2)

    def dome():
        s = 256
        img = np.zeros((s, s, 3))
        xx = np.arange(s) / s
        yy = np.arange(s)[:, None] / s
        img[:] = srgb('#B8704E')
        panel = (np.abs((xx * 8) % 1 - 0.5) < 0.38)[None, :] & (np.abs((yy * 4) % 1 - 0.5) < 0.36)
        img[panel] = srgb('#C98A62')
        img *= (1 + 0.06 * fbm(s, s, 173, 4, 4))[:, :, None]
        return img
    da = texture(f'pal{lod}_dome_albedo', dome, 'jpg')
    return std_mats('pal', lod, {'stone': material(f'pal{lod}_stone', albedo=sa, rough=0.85, **({'normal': sn} if lod == 0 else {})),
                                  'dome': material(f'pal{lod}_dome', albedo=da, rough=0.7),
                                  'hall': material(f'pal{lod}_hall', color=(0.70, 0.52, 0.40), rough=0.85)})


def build_palace(lod):
    b = Site('palace_of_fine_arts', 'Güzel Sanatlar Sarayı', lod, palace_materials(lod), PAL_ORIGIN)
    g = ROT['gc']
    b.anchor(0.0, 0.0, g)
    st = b.mb['stone']
    # rotunda: 8 massive piers with columns, arches ring, octagonal drum, dome (162 ft = 49 m)
    R = 15.5
    for k in range(8):
        t = 2 * math.pi * (k + 0.5) / 8
        c = (R * math.cos(t), R * math.sin(t))
        column(st, (c[0], c[1], 0), 5.2, 5.2, g - 2.0, g + 24.0, chamfer=0.8, yaw=t)
        if lod == 0:
            for dd in (-1, 1):
                tt = t + dd * 0.16
                st.cylinder(((R + 3.4) * math.cos(tt), (R + 3.4) * math.sin(tt), g), 0.8, 17.0, sides=10, cap_top=False)
                st.box(((R + 3.4) * math.cos(tt) - 1.1, (R + 3.4) * math.sin(tt) - 1.1, g + 17.0), ((R + 3.4) * math.cos(tt) + 1.1, (R + 3.4) * math.sin(tt) + 1.1, g + 20.5))
    oc = lambda r, n=8, off=0.5: [(r * math.cos(2 * math.pi * (k + off) / n), r * math.sin(2 * math.pi * (k + off) / n)) for k in range(n)]
    loft(st, [oc(R + 3.0), oc(R + 3.0)], [g + 24.0, g + 31.0], cap_top=False)
    loft(st, [oc(R - 2.5), oc(R - 2.5)][::-1], [g + 31.0, g + 24.0], cap_top=False) if lod == 0 else None
    loft(st, [oc(R + 1.5), oc(R + 1.5)], [g + 31.0, g + 35.0], cap_top=False)
    ns = 24 if lod == 0 else 12
    prof = [(R + 1.2, 35.0), (R + 0.6, 38.0), (R - 1.5, 41.5), (R - 5.0, 44.8), (R - 9.5, 47.2), (2.0, 48.3)]
    loft(b.mb['dome'], [oc(r, ns, 0) for r, _ in prof], [g + z for _, z in prof], ts_u=1.0, ts_v=14.0, cap_top=True, smooth=True, angular=True)
    # colonnade arms (peristyle): entablature slab + planter boxes on columns along the outline
    for key in ('288371306', '288371310'):
        arm = PAL[key]
        poly = ccw([b.f(p) for p in arm['poly']])
        ga = arm['gc']
        b.anchor(*centroid2(poly), ga)
        walls(st, poly, ga + 13.0, ga + 16.5, 6.0, 6.0, 0)
        st.polygon([(x, y, ga + 16.5) for x, y in poly])
        if lod < 2:
            # columns every ~5.5 m along the outline (inset 1.2 m)
            ins = inset(poly, 1.2)
            per = 0.0
            nxt = 0.0
            for i in range(len(ins)):
                a0, a1 = V(*ins[i]), V(*ins[(i + 1) % len(ins)])
                L = float(np.linalg.norm(a1 - a0))
                while nxt <= per + L:
                    p = a0 + (a1 - a0) * ((nxt - per) / max(L, 1e-6))
                    if lod == 0:
                        st.cylinder((p[0], p[1], ga - 1.0), 0.75, 14.0, sides=8, cap_top=False)
                    else:
                        st.box((p[0] - 0.7, p[1] - 0.7, ga - 1.0), (p[0] + 0.7, p[1] + 0.7, ga + 13.0), faces='xXyY')
                    nxt += 5.6
                per += L
            # planter boxes (with the weeping-women corners) every ~17 m
            per, nxt = 0.0, 8.0
            for i in range(len(poly)):
                a0, a1 = V(*poly[i]), V(*poly[(i + 1) % len(poly)])
                L = float(np.linalg.norm(a1 - a0))
                while nxt <= per + L:
                    p = a0 + (a1 - a0) * ((nxt - per) / max(L, 1e-6))
                    q = V(*centroid2(poly))
                    p = p + norm(q - p) * 2.5
                    st.box((p[0] - 2.6, p[1] - 2.6, ga + 16.5), (p[0] + 2.6, p[1] + 2.6, ga + 20.0))
                    nxt += 17.0
                per += L
        if b.meta:
            xs, ys = [p[0] for p in poly], [p[1] for p in poly]
            # the arms curve: approximate with their bbox top slab only (open colonnade underneath is flyable only by fools)
            b.meta.box((min(xs), min(ys), ga - 1), (max(xs), max(ys), ga + 20.0), 'Güzel Sanatlar Sarayı')
    # exhibition hall (big curved building behind)
    hall = PAL['288371302']
    poly = ccw([b.f(p) for p in hall['poly']])
    b.building(hall['poly'], hall['gc'], 20.0, facade='hall', tile=(10.0, 20.0), roof='roof', parapet=0.0, gc=hall['gc'],
               name='Güzel Sanatlar Sarayı')
    b.anchor(0.0, 0.0, g)
    if b.meta:
        b.meta.box((-R - 4, -R - 4, g - 2), (R + 4, R + 4, g + 35.0), 'Güzel Sanatlar Sarayı')
        b.meta.capsule((0, 0, g + 35), (0, 0, g + 46), 14.0, 'Güzel Sanatlar Sarayı')
    return b


# ================================================================================================ Chase Center
CC = S['chase_center']
CC_ORIGIN = centroid2(CC['poly'])


def chase_materials(lod):
    if lod == 2:
        return {'white': material('chs2_white', color=(0.78, 0.79, 0.79), rough=0.4),
                'glass': material('chs2_glass', color=(0.1, 0.12, 0.13), rough=0.1),
                'roof': material('chs2_roof', color=(0.55, 0.56, 0.57), rough=0.6),
                'concrete': material('chs2_concrete', color=(0.6, 0.58, 0.55), rough=0.9),
                'dark': material('chs2_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'warn': material('chs2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}

    def fins():
        s = 512
        img = np.zeros((s, s, 3))
        xx = np.arange(s) / s
        img[:] = srgb('#D8DBDB')
        shade = 0.82 + 0.18 * np.abs(np.sin(xx * math.pi * 16))
        img *= shade[None, :, None]
        img *= (1 + 0.03 * fbm(s, s, 181, 3, 4))[:, :, None]
        return img
    fa = texture(f'chs{lod}_fins_albedo', fins, 'jpg')
    return std_mats('chs', lod, {'white': material(f'chs{lod}_white', albedo=fa, rough=0.35, metal=0.3),
                                  'glass': material(f'chs{lod}_glass', color=(0.08, 0.1, 0.11), rough=0.06, metal=0.2),
                                  'roofw': material(f'chs{lod}_roofw', color=(0.72, 0.73, 0.73), rough=0.5)})


def build_chase(lod):
    b = Site('chase_center', 'Chase Center', lod, chase_materials(lod), CC_ORIGIN)
    g = CC['gc']
    b.anchor(0.0, 0.0, g)
    poly = ccw([b.f(p) for p in CC['poly']])
    if lod == 2:
        poly = poly[::2]
    walls(b.mb['glass'], inset(poly, 2.5), g - 2.0, g + 9.0, 8.0, 8.0, g)
    # white finned upper volume with a soft overhang
    walls(b.mb['white'], poly, g + 9.0, g + 34.0, 16.0, 25.0, g + 9.0)
    for i in range(len(poly)):
        a0, a1 = poly[i], poly[(i + 1) % len(poly)]
        ii = inset(poly, 2.5)
        c0, c1 = ii[i], ii[(i + 1) % len(poly)]
        b.mb['white'].quad((a1[0], a1[1], g + 9.0), (a0[0], a0[1], g + 9.0), (c0[0], c0[1], g + 9.0), (c1[0], c1[1], g + 9.0))
    # low domed roof
    rings = [poly, inset(poly, 12.0), inset(poly, 30.0), inset(poly, 50.0)]
    zs = [g + 34.0, g + 36.5, g + 37.6, g + 38.1]
    loft(b.mb['roofw'], rings, zs, cap_top=True)
    if b.meta:
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        b.meta.box((min(xs), min(ys), g - 2), (max(xs), max(ys), g + 38.1), 'Chase Center')
    return b


# ================================================================================================ Painted Ladies
PL = S['painted_ladies']
PL_ORIGIN = centroid2([centroid2(h['poly']) for h in PL])
PL_COLORS = ['#7FA3C4', '#E5CF8A', '#D48E86', '#8FB58A', '#E3B86A', '#6F92BE', '#DE9C7E']


def painted_materials(lod):
    if lod == 2:
        return {'wood': material('pld2_wood', color=(0.8, 0.8, 0.8), rough=0.7),
                'roof': material('pld2_roof', color=(0.25, 0.24, 0.24), rough=0.8),
                'concrete': material('pld2_concrete', color=(0.6, 0.58, 0.55), rough=0.9),
                'dark': material('pld2_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'warn': material('pld2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 512 if lod == 0 else 128

    def victorian():
        # grayscale detail (multiplied by per-house vertex colors): siding lines, trim, windows (tile 7 m x 12 m)
        W, H = sz, int(sz * 12 / 7)
        img = np.ones((H, W, 3)) * 0.95
        yy, xx = np.mgrid[0:H, 0:W]
        u, v = xx / W, 1 - yy / H
        img *= (1 - 0.1 * ((yy % max(2, H // 90)) == 0))[:, :, None]            # horizontal siding
        for (u0, u1, v0, v1) in ((0.12, 0.34, 0.12, 0.35), (0.62, 0.86, 0.12, 0.35), (0.12, 0.34, 0.47, 0.68), (0.62, 0.86, 0.47, 0.68), (0.4, 0.58, 0.78, 0.9)):
            frame = (u > u0 - 0.03) & (u < u1 + 0.03) & (v > v0 - 0.025) & (v < v1 + 0.04)
            img[frame] = 1.25                                                        # white trim (after vertex color)
            win = (u > u0) & (u < u1) & (v > v0) & (v < v1)
            img[win] = 0.12
            img[win & (np.abs(u - (u0 + u1) / 2) < 0.008)] = 1.0
        img[(v > 0.4) & (v < 0.43)] = 1.2                                            # belt course
        img[(v > 0.94)] = 1.2                                                        # cornice
        door = (u > 0.42) & (u < 0.56) & (v < 0.3)
        img[door] = 0.35
        return np.clip(img / 1.25, 0, 1)
    va = texture(f'pld{lod}_facade_albedo', victorian, 'jpg')
    return std_mats('pld', lod, {'wood': material(f'pld{lod}_wood', albedo=va, rough=0.7),
                                  'side': material(f'pld{lod}_side', color=(0.8, 0.8, 0.8), rough=0.75),
                                  'trim': material(f'pld{lod}_trim', color=(0.92, 0.91, 0.88), rough=0.6)})


def build_painted(lod):
    b = Site('painted_ladies', 'Painted Ladies Evleri', lod, painted_materials(lod), PL_ORIGIN)
    for k, h in enumerate(PL):
        poly = ccw([b.f(p) for p in h['poly']])
        # house axes from the minimum-area bounding rectangle: long side = depth (E-W), facade faces the park (west)
        best = None
        for i in range(len(poly)):
            e = V(*poly[(i + 1) % len(poly)]) - V(*poly[i])
            if np.linalg.norm(e) < 1e-6:
                continue
            u = norm(V(e[0], e[1], 0))
            w = V(-u[1], u[0], 0)
            pu = [float(np.dot(V(x, y, 0), u)) for x, y in poly]
            pw = [float(np.dot(V(x, y, 0), w)) for x, y in poly]
            area = (max(pu) - min(pu)) * (max(pw) - min(pw))
            if best is None or area < best[0]:
                best = (area, u if (max(pu) - min(pu)) >= (max(pw) - min(pw)) else w)
        ax = best[1]
        if ax[0] > 0:
            ax = -ax                                   # ax points west (towards the facade)
        ay = V(-ax[1], ax[0], 0)
        pa = [float(np.dot(V(x, y, 0), ax)) for x, y in poly]
        pb = [float(np.dot(V(x, y, 0), ay)) for x, y in poly]
        depth, width = max(pa) - min(pa), max(pb) - min(pb)
        c = ax * ((max(pa) + min(pa)) / 2) + ay * ((max(pb) + min(pb)) / 2)
        g = h['gmax']
        b.anchor(c[0], c[1], h['gc'])
        col = tuple(float(x) for x in tx.srgb_to_linear(PL_COLORS[k % len(PL_COLORS)]))
        colv = tuple(min(1.0, x / 0.72) for x in col)         # vertex color multiplies the (0.76 grey) detail texture
        H = 10.5
        # body: facade (textured, facing the park) + sides + back
        P = lambda dx, dy, z: c + ax * dx + ay * dy + V(0, 0, z)
        hw, hd = width / 2 - 0.05, depth / 2
        fac = b.mb['wood']
        up = V(0, 0, 1)
        fac.quad_facing(P(hd, hw, g - 3), P(hd, -hw, g - 3), P(hd, -hw, g + H), P(hd, hw, g + H), ax,
                        uv=[(0, -3 / 12), (1, -3 / 12), (1, H / 12), (0, H / 12)], col=colv)
        side = b.mb['side']
        for sgn in (-1, 1):
            side.quad_facing(P(-hd, sgn * hw, g - 3), P(hd, sgn * hw, g - 3), P(hd, sgn * hw, g + H), P(-hd, sgn * hw, g + H), ay * sgn, col=colv)
        side.quad_facing(P(-hd, -hw, g - 3), P(-hd, hw, g - 3), P(-hd, hw, g + H), P(-hd, -hw, g + H), -ax, col=colv)
        # gable roof, ridge along the depth axis, front gable over the facade
        rh = 4.2
        rf = b.mb['roof']
        rf.quad_facing(P(hd + 0.4, hw + 0.3, g + H), P(-hd, hw + 0.3, g + H), P(-hd, 0, g + H + rh), P(hd + 0.4, 0, g + H + rh), ay + up)
        rf.quad_facing(P(-hd, -hw - 0.3, g + H), P(hd + 0.4, -hw - 0.3, g + H), P(hd + 0.4, 0, g + H + rh), P(-hd, 0, g + H + rh), -ay + up)
        fac.tri_facing(P(hd, hw, g + H), P(hd, -hw, g + H), P(hd, 0, g + H + rh), ax, uv=[(0, H / 12), (1, H / 12), (0.5, (H + rh) / 12)], col=colv)
        side.tri_facing(P(-hd, -hw, g + H), P(-hd, hw, g + H), P(-hd, 0, g + H + rh), -ax, col=colv)
        if lod == 0:
            # two-storey bay window + front stoop + gable trim
            tr = b.mb['trim']
            bw, bd_ = 1.6, 1.0
            for z0, z1 in ((g + 0.8, g + 3.9), (g + 4.3, g + 7.4)):
                q0, q1 = P(hd, -hw * 0.25 - bw, z0), P(hd, -hw * 0.25 + bw, z0)
                fr = [P(hd + bd_, -hw * 0.25 - bw * 0.6, z0), P(hd + bd_, -hw * 0.25 + bw * 0.6, z0)]
                for a0, a1 in ((q0, fr[0]), (fr[0], fr[1]), (fr[1], q1)):
                    fac.quad_facing(a0, a1, a1 + V(0, 0, z1 - z0), a0 + V(0, 0, z1 - z0), ax, uv=[(0.62, 0.47), (0.86, 0.47), (0.86, 0.68), (0.62, 0.68)], col=colv)
                tr.quad_facing(q0 + V(0, 0, z1 - z0), fr[0] + V(0, 0, z1 - z0), fr[1] + V(0, 0, z1 - z0), q1 + V(0, 0, z1 - z0), up)
            st0 = P(hd, hw * 0.1, 0)
            tr.box((min(st0[0], st0[0] + ax[0] * 2.2) - 0.7, min(st0[1], st0[1] + ax[1] * 2.2) - 0.7, g - 1.0),
                   (max(st0[0], st0[0] + ax[0] * 2.2) + 0.7, max(st0[1], st0[1] + ax[1] * 2.2) + 0.7, g + 1.0))
            # gable edge trim boards
            tr.beam(P(hd + 0.5, hw + 0.4, g + H - 0.1), P(hd + 0.5, 0, g + H + rh), 0.25, 0.35)
            tr.beam(P(hd + 0.5, -hw - 0.4, g + H - 0.1), P(hd + 0.5, 0, g + H + rh), 0.25, 0.35)
        if b.meta:
            xs, ys = [p[0] for p in poly], [p[1] for p in poly]
            b.meta.box((min(xs), min(ys), g - 3), (max(xs), max(ys), g + H + rh), 'Painted Ladies Evleri')
    return b


# ================================================================================================ Pier 39
PI = S['pier_39']
PI_ORIGIN = centroid2(PI['deck'])


def pier_materials(lod):
    if lod == 2:
        return {'wood': material('p392_wood', color=(0.42, 0.36, 0.30), rough=0.85),
                'deck': material('p392_deck', color=(0.38, 0.33, 0.28), rough=0.9),
                'roof': material('p392_roof', color=(0.25, 0.25, 0.26), rough=0.8),
                'concrete': material('p392_concrete', color=(0.55, 0.53, 0.5), rough=0.9),
                'dark': material('p392_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'warn': material('p392_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 512 if lod == 0 else 128
    wa, wo, wn, we = tx.window_facade(f'p39{lod}_wood', size=sz, cols=3, rows=2, frame='#7A6552', glass='#242628', win_w=0.5, win_h=0.5,
                                      seed=191, lit=0.4, streaks=0.1, mullion_v=1)

    def planks():
        s = 256
        img = np.zeros((s, s, 3))
        yy, xx = np.mgrid[0:s, 0:s]
        img[:] = srgb('#6B5C4C')
        img *= (1 + 0.1 * fbm(s, s, 194, 4, 16))[:, :, None]
        img[(yy % 8) == 0] *= 0.6
        return img
    pa = texture(f'p39{lod}_deck_albedo', planks, 'jpg')
    return std_mats('p39', lod, {'wood': material(f'p39{lod}_wood_emit', albedo=wa, emissive_img=we, emissive_strength=0.7, rough=0.8),
                                  'deck': material(f'p39{lod}_deck', albedo=pa, rough=0.9),
                                  'pile': material(f'p39{lod}_pile', color=(0.2, 0.17, 0.14), rough=0.9)})


def build_pier39(lod):
    b = Site('pier_39', 'Pier 39 İskelesi', lod, pier_materials(lod), PI_ORIGIN)
    deck = ccw([b.f(p) for p in PI['deck']])
    dz = 3.6
    b.anchor(0.0, 0.0, -100.0)          # the pier stands in the water: keep absolute heights
    b.mb['deck'].polygon([(x, y, dz) for x, y in deck], 6.0)
    walls(b.mb['deck'], deck, dz - 1.2, dz, 6.0, 1.2, dz - 1.2)
    if lod < 2:
        # piles along the edge
        per, nxt = 0.0, 0.0
        for i in range(len(deck)):
            a0, a1 = V(*deck[i]), V(*deck[(i + 1) % len(deck)])
            L = float(np.linalg.norm(a1 - a0))
            while nxt <= per + L:
                p = a0 + (a1 - a0) * ((nxt - per) / max(L, 1e-6))
                b.mb['pile'].cylinder((p[0], p[1], -3.0), 0.3, dz + 1.8, sides=6, cap_top=False)
                nxt += 7.0
            per += L
    for bd in PI['buildings']:
        lv = bd.get('levels')
        h = float(bd['height'].split()[0]) if bd.get('height') else (4.2 * float(lv) + 1.5 if lv else 9.0)
        if 'Carousel' in bd['name']:
            poly = ccw([b.f(p) for p in bd['poly']])
            cx, cy = centroid2(poly)
            b.mb['wood'].cylinder((cx, cy, dz), 5.2, 5.0, sides=16, cap_top=False)
            b.mb['roof'].cylinder((cx, cy, dz + 5.0), 5.8, 4.0, sides=16, r_top=0.3)
            continue
        poly = b.building(bd['poly'], dz, h - 2.5, facade='wood', tile=(9.0, 8.4), roof='roof', parapet=0.0, skirt=0.2,
                          gc=-100.0, name='Pier 39 İskelesi', flat_top=False)
        # pitched roofs: simple hip-like pyramid capped (keeps silhouettes of the wooden buildings)
        cx, cy = centroid2(poly)
        top = dz + h - 2.5
        for i in range(len(poly)):
            a0, a1 = poly[i], poly[(i + 1) % len(poly)]
            b.mb['roof'].tri((a0[0], a0[1], top), (a1[0], a1[1], top), (cx, cy, top + 3.0))
    if b.meta:
        xs, ys = [p[0] for p in deck], [p[1] for p in deck]
        b.meta.box((min(xs), min(ys), -2.0), (max(xs), max(ys), dz), 'Pier 39 İskelesi')
        b.meta.light((0, 0, dz + 14.0), '#ffd9a0', size=1.0, period=0, kind='lamp', intensity=0.0)
    return b


# ================================================================================================ Oracle Park
OP = S['oracle_park']
OP_HOME = tuple(OP['home'])
OP_HEADING = OP['cf_heading'] * DEG


def oracle_materials(lod):
    if lod == 2:
        return {'brick': material('orp2_brick', color=(0.45, 0.25, 0.2), rough=0.9),
                'seats': material('orp2_seats', color=(0.2, 0.22, 0.26), rough=0.8),
                'field': material('orp2_field', color=(0.16, 0.33, 0.12), rough=0.95),
                'roof': material('orp2_roof', color=(0.5, 0.5, 0.5), rough=0.7),
                'concrete': material('orp2_concrete', color=(0.58, 0.57, 0.54), rough=0.9),
                'dark': material('orp2_dark', color=(0.03, 0.035, 0.04), rough=0.6),
                'white': material('orp2_white', color=(0.85, 0.85, 0.85), rough=0.5),
                'warn': material('orp2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 1024 if lod == 0 else 256

    def field():
        # field frame texture: 150 x 150 m, home plate at (0.1, 0.1) of the tile, CF along the diagonal
        s = sz
        img = np.zeros((s, s, 3))
        yy, xx = np.mgrid[0:s, 0:s]
        X = xx / s * 150.0 - 15.0            # meters along the 1B line direction rotated... (u axis = RF line)
        Y = (s - 1 - yy) / s * 150.0 - 15.0   # v axis = LF line
        r = np.hypot(X, Y)
        grass = srgb('#3E6B2F')
        stripe = ((np.floor((X + Y) / 6.0)) % 2) == 0
        img[:] = grass
        img[stripe] *= 1.12
        img *= (1 + 0.05 * fbm(s, s, 201, 4, 8))[:, :, None]
        dirt = srgb('#9C6A48')
        # infield arc (95 ft from the rubber, which is 60.5 ft from home along the diagonal)
        mx, my = 18.44 * 0.7071, 18.44 * 0.7071
        arc = (np.hypot(X - mx, Y - my) < 29.0) & (X > -3) & (Y > -3)
        grass_inf = (X > 1.2) & (Y > 1.2) & (X < 27.4 - 1.2) & (Y < 27.4 - 1.2)
        img[arc & ~grass_inf] = dirt
        img[np.hypot(X - mx, Y - my) < 2.7] = dirt                   # mound
        img[r < 4.0] = dirt                                             # home plate circle
        for bx, by in ((27.43, 0), (27.43, 27.43), (0, 27.43)):
            img[np.hypot(X - bx, Y - by) < 1.2] = srgb('#F2F0EA') if False else dirt
        # foul lines + batter's area
        line = ((np.abs(Y) < 0.12) & (X > 0) & (X < 95)) | ((np.abs(X) < 0.12) & (Y > 0) & (Y < 104))
        img[line] = srgb('#F2F0EA')
        # warning track near the fence (approx. arc radius ~ 100-120 m)
        fence = 94.0 + (122.0 - 94.0) * np.clip(np.sin(2 * np.arctan2(Y, X)), 0, 1)
        img[(r > fence - 4.5) & (r < fence) & (X > -5) & (Y > -5)] = dirt
        # foul territory beyond the lines: dirt/grass mix (grass at Oracle)
        return img
    fa = texture(f'orp{lod}_field_albedo', field, 'jpg')
    ba = tx.window_facade(f'orp{lod}_brick', size=512 if lod == 0 else 128, cols=2, rows=1, frame='#8B4A38', glass='#2B2624', win_w=0.55,
                          win_h=0.62, seed=203, lit=0.0, streaks=0.05)[0]

    def seats():
        s = 256
        img = np.zeros((s, s, 3))
        img[:] = srgb('#1E3A2A')                                      # Giants dark-green seats
        img[(np.arange(s) % 16) < 3, :] = srgb('#6A6B6C')           # concrete risers between rows
        img *= (1 + 0.1 * fbm(s, s, 205, 3, 16))[:, :, None]
        return img
    sa = texture(f'orp{lod}_seats_albedo', seats, 'jpg')
    return std_mats('orp', lod, {'brick': material(f'orp{lod}_brick', albedo=ba, rough=0.9),
                                  'seats': material(f'orp{lod}_seats', albedo=sa, rough=0.75),
                                  'field': material(f'orp{lod}_field', albedo=fa, rough=0.95),
                                  'white': material(f'orp{lod}_white', color=(0.85, 0.85, 0.83), rough=0.5),
                                  'green': material(f'orp{lod}_green', color=(0.10, 0.20, 0.14), rough=0.6, double_sided=True),
                                  'bottle': material(f'orp{lod}_bottle', color=(0.55, 0.05, 0.04), rough=0.3),
                                  'lamp': material(f'orp{lod}_lamp_emit', color=(0.95, 0.95, 0.9), emissive=(1.0, 1.0, 0.95), emissive_strength=3.0)})


def build_oracle(lod):
    """Field frame: origin = home plate, +Y = towards center field (heading ~80 deg), +X = right-field side."""
    b = Site('oracle_park', 'Oracle Park Stadyumu', lod, oracle_materials(lod), OP_HOME)
    g = OP['g_home']
    b.anchor(0.0, 0.0, g)
    dR, dL = V(0.7071, 0.7071, 0), V(-0.7071, 0.7071, 0)
    nR, nL = V(0.7071, -0.7071, 0), V(-0.7071, -0.7071, 0)
    # field (grass + infield texture): quad in the field frame covering the fair territory and some foul ground
    fm = b.mb['field']
    # field polygon: stands' inner edge (foul lines offset 15 m, round behind home) + outfield fence; UV from (u, v)
    fan = [dR * 94.0 + nR * 15.0]
    for a in np.linspace(-45.0, -135.0, 9):
        fan.append(V(15.0 * math.cos(a * DEG), 15.0 * math.sin(a * DEG), 0))
    fan.append(dL * 103.0 + nL * 15.0)
    for t in np.linspace(90, 0, 19):
        ang = (45 - t) * DEG
        rr = 94.0 + (103.0 - 94.0) * t / 90 + 22.0 * math.sin(t * 2 * DEG)
        fan.append(V(math.sin(ang), math.cos(ang), 0) * rr)
    fan2 = [(float(p[0]), float(p[1])) for p in fan]
    from lmkit import earcut
    area = sum(fan2[i][0] * fan2[(i + 1) % len(fan2)][1] - fan2[(i + 1) % len(fan2)][0] * fan2[i][1] for i in range(len(fan2)))
    if area < 0:
        fan2 = fan2[::-1]
    i0 = fm.add_verts([(x, y, g + 0.12) for x, y in fan2])
    uvf = lambda x, y: ((x * 0.7071 + y * 0.7071 + 15.0) / 150.0, (-x * 0.7071 + y * 0.7071 + 15.0) / 150.0)
    for a_, b_, c_ in earcut(fan2):
        fm.face((i0 + a_, i0 + b_, i0 + c_), [uvf(*fan2[k]) for k in (a_, b_, c_)])
    # inner edge path of the stands: RF line (offset 15 m) -> behind home (r=15) -> LF line
    pts = []
    for u in np.linspace(94.0, 0.0, 12):
        pts.append(dR * u + nR * 15.0)
    for a in np.linspace(-45.0, -135.0, 10)[1:-1]:
        pts.append(V(15.0 * math.cos(a * DEG), 15.0 * math.sin(a * DEG), 0))
    for v in np.linspace(0.0, 103.0, 13):
        pts.append(dL * v + nL * 15.0)
    path = DeckPath([(p[0], p[1], g) for p in pts])
    se = b.mb['seats']
    # lower bowl: 38 m deep band rising 1.5 -> 16 m (seat texture along the band)
    n = 8 if lod == 0 else 3
    for k in range(n):
        x0, x1 = -38.0 * k / n, -38.0 * (k + 1) / n
        z0, z1 = 1.5 + 14.5 * k / n, 1.5 + 14.5 * (k + 1) / n
        path.strip(se, x1, x0, z1, z0, uv='road', ts=8.0)
    # upper deck behind home plate / along the lines (from 45% of the RF line round to 55% of the LF line)
    i0, i1 = 5, len(path) - 6
    for k in range(n):
        x0, x1 = -46.0 - 30.0 * k / n, -46.0 - 30.0 * (k + 1) / n
        z0, z1 = 21.0 + 18.0 * k / n, 21.0 + 18.0 * (k + 1) / n
        path.strip(se, x1, x0, z1, z0, uv='road', ts=8.0, i0=i0, i1=i1)
    # decks' fascia / undersides (concrete) and the brick outer facade
    path.strip(b.mb['concrete'], -38.0, -38.0, 0.0, 16.0, flip=False)
    path.strip(b.mb['concrete'], -46.0, -46.0, 16.0, 21.0, i0=i0, i1=i1)
    path.strip(b.mb['concrete'], -46.0, -76.0, 20.5, 38.5, i0=i0, i1=i1)          # underside of the upper deck (seen from outside/below)
    path.strip(b.mb['brick'], -46.0, -38.0, 16.0, 16.0)                            # concourse (faces up)
    path.strip(b.mb['brick'], -76.0, -76.0, -3.0, 39.0, uv=None, i0=i0, i1=i1)       # outer brick facade (faces out)
    path.strip(b.mb['brick'], -46.0, -46.0, -3.0, 16.0)                             # lower-level outer wall
    # roof canopy over the upper deck
    path.strip(b.mb['white'], -80.0, -60.0, 45.0, 43.0, i0=i0, i1=i1)
    # outfield: fence line RF pole -> CF -> LF pole, arcade (brick) in right field, scoreboard in CF
    fence = []
    for t in np.linspace(0, 90, 19):
        ang = (45 - t) * DEG             # 45 = RF line, -45 = LF line (relative to +Y)
        rr = 94.0 + (103.0 - 94.0) * t / 90 + 22.0 * math.sin(t * 2 * DEG)
        fence.append(V(math.sin(ang), math.cos(ang), 0) * rr)
    for p0, p1 in zip(fence[:-1], fence[1:]):
        hwall = 7.6 if p0[0] > 30 else 2.6
        b.mb['green'].quad(p0 + V(0, 0, g), p1 + V(0, 0, g), p1 + V(0, 0, g + hwall), p0 + V(0, 0, g + hwall))
    # right-field arcade along McCovey Cove
    for p0, p1 in zip(fence[:6], fence[1:7]):
        o = V(0.6, -0.2, 0) * 0 + norm(V(p0[0], p0[1], 0)) * 6.0
        b.mb['brick'].quad_facing(p0 + o + V(0, 0, g - 2), p1 + o + V(0, 0, g - 2), p1 + o + V(0, 0, g + 9.0), p0 + o + V(0, 0, g + 9.0), o, uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
    # LF bleachers
    for p0, p1 in zip(fence[12:18], fence[13:19]):
        o0, o1 = norm(V(p0[0], p0[1], 0)), norm(V(p1[0], p1[1], 0))
        b.mb['seats'].quad_facing(p0 + o0 * 2 + V(0, 0, g + 2.6), p1 + o1 * 2 + V(0, 0, g + 2.6), p1 + o1 * 20 + V(0, 0, g + 12.0), p0 + o0 * 20 + V(0, 0, g + 12.0),
                                  -o0 + V(0, 0, 1.5), uv=[(0, 0), (1, 0), (1, 3), (0, 3)])
    # CF scoreboard
    sb = V(0, 1, 0) * 140.0 + V(-12.0, 0, 0)
    b.mb['dark'].box((sb[0] - 16, sb[1] - 1.5, g + 14.0), (sb[0] + 16, sb[1] + 1.5, g + 30.0), faces='xXyYzZ')
    b.mb['concrete'].box((sb[0] - 14, sb[1] - 1.0, g), (sb[0] - 12, sb[1] + 1.0, g + 14.0), faces='xXyY')
    b.mb['concrete'].box((sb[0] + 12, sb[1] - 1.0, g), (sb[0] + 14, sb[1] + 1.0, g + 14.0), faces='xXyY')
    # the giant bottle (a plain red bottle shape, no lettering) and the giant glove behind the left-field bleachers
    cb = dL * 118.0 + V(0, 1, 0) * 18.0
    if lod < 2:
        prof = [(3.2, 0), (3.6, 4), (3.6, 13), (2.6, 17), (1.5, 21), (1.4, 24.5)]
        ns = 16 if lod == 0 else 8
        circ = lambda r: [(cb[0] + r * math.cos(2 * math.pi * k / ns), cb[1] + r * math.sin(2 * math.pi * k / ns)) for k in range(ns)]
        loft(b.mb['bottle'], [circ(r) for r, _ in prof], [g + z for _, z in prof], smooth=True)
        gl = cb + V(14.0, 6.0, 0)
        b.mb['brick'].cylinder((gl[0], gl[1], g), 4.0, 8.0, sides=12, r_top=3.2)
    # light towers
    for i in (1, 4, 8, 12, 17, 20, 24, 27):
        if i >= len(path):
            continue
        p = path.pt(i, -74.0, 0.0)
        b.mb['concrete'].cylinder((p[0], p[1], g + 30.0), 0.6, 25.0, sides=8, cap_top=False)
        b.mb['lamp'].box((p[0] - 3.5, p[1] - 3.5, g + 55.0), (p[0] + 3.5, p[1] + 3.5, g + 58.0))
        if b.meta:
            b.meta.light((p[0], p[1], g + 56.5), '#ffffff', size=8.0, period=0, kind='lamp', intensity=0.9)
    # clock tower at the home-plate entrance (Willie Mays Plaza)
    ct = V(0, -95.0, 0)
    b.mb['brick'].box((ct[0] - 5, ct[1] - 5, g - 2), (ct[0] + 5, ct[1] + 5, g + 38.0), faces='xXyY')
    b.mb['roof'].box((ct[0] - 5.5, ct[1] - 5.5, g + 38.0), (ct[0] + 5.5, ct[1] + 5.5, g + 40.0))
    b.mb['white'].cylinder((ct[0], ct[1], g + 40.0), 1.5, 4.0, sides=8, r_top=0.2)
    if b.meta:
        for i in range(0, len(path) - 1, 3):
            a, c = path.pt(i, -40.0, 0.0), path.pt(min(i + 3, len(path) - 1), -40.0, 0.0)
            m = (a + c) / 2
            d = c - a
            b.meta.obox((m[0], m[1], g + 8.0), (d[0], d[1]), 38.0, float(np.linalg.norm(d[:2])) / 2 + 2, 11.0, 'Oracle Park Stadyumu')
        b.meta.box((sb[0] - 16, sb[1] - 1.5, g), (sb[0] + 16, sb[1] + 1.5, g + 30.0), 'Oracle Park Stadyumu')
        b.meta.box((ct[0] - 5, ct[1] - 5, g - 2), (ct[0] + 5, ct[1] + 5, g + 44.0), 'Oracle Park Stadyumu')
    return b


# ================================================================================================ Port of Oakland cranes
CR = S['cranes']


def crane_materials(lod):
    if lod == 2:
        return {'white': material('crn2_white', color=(0.82, 0.82, 0.8), rough=0.5),
                'red': material('crn2_red', color=(0.55, 0.08, 0.05), rough=0.5),
                'dark': material('crn2_dark', color=(0.1, 0.1, 0.1), rough=0.6),
                'warn': material('crn2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    return {'white': material(f'crn{lod}_white', color=(0.83, 0.83, 0.81), rough=0.45),
            'red': material(f'crn{lod}_red', color=(0.58, 0.09, 0.05), rough=0.45),
            'dark': material(f'crn{lod}_dark', color=(0.1, 0.1, 0.11), rough=0.6),
            'glass': material(f'crn{lod}_glass', color=(0.1, 0.13, 0.15), rough=0.1),
            'warn': material(f'crn{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}


def build_crane(lod, boom_up=False, lid='oakland_cranes'):
    """Post-Panamax STS crane. Local frame: +Y = boom direction (towards the water), X = along the rails.
    Waterside rail at y=+15.25, landside rail at y=-15.25 (100 ft gauge); legs 18 m apart along X."""
    b = Build(lid, 'Oakland Limanı Vinci', lod, crane_materials(lod))
    w, r, dk = b.mb['white'], b.mb['red'], b.mb['dark']
    gauge, span = 15.25, 9.0
    zb = 42.0                           # boom/girder level
    s = 1.8 if lod < 2 else 2.6
    for yy in (-gauge, gauge):
        for xx in (-span, span):
            w.beam((xx, yy, 0.0), (xx * 0.9, yy, zb), s, s, caps=True)
        w.beam((-span, yy, 1.0), (span, yy, 1.0), 1.2, 2.0)          # sill beams / bogies
        if lod < 2:
            w.beam((-span * 0.95, yy, 12.0), (span * 0.95, yy, 12.0), 1.2, 1.6)
            dk.box((-span - 2.5, yy - 1.2, 0.0), (-span + 2.5, yy + 1.2, 1.5))
            dk.box((span - 2.5, yy - 1.2, 0.0), (span + 2.5, yy + 1.2, 1.5))
    for xx in (-span * 0.9, span * 0.9):
        w.beam((xx, -gauge, zb), (xx, gauge, zb), 2.2, 2.4)                # portal beams
        if lod < 2:
            w.beam((xx, -gauge, 28.0), (xx, gauge, 28.0), 1.4, 1.6)
            w.beam((xx, -gauge, 28.0), (xx, 0.0, zb - 1.0), 0.8, 0.8)
            w.beam((xx, gauge, 28.0), (xx, 0.0, zb - 1.0), 0.8, 0.8)
    # main girders (backreach) + boom
    back, reach = -gauge - 26.0, gauge + 58.0
    for xx in (-3.2, 3.2):
        w.beam((xx, back, zb + 2.0), (xx, gauge + 2.0, zb + 2.0), 1.6, 3.4)
        if boom_up:
            w.beam((xx, gauge + 2.0, zb + 2.0), (xx, gauge + 10.0, zb + 2.0 + 56.0), 1.4, 3.0)
        else:
            w.beam((xx, gauge + 2.0, zb + 2.0), (xx, reach, zb + 2.0), 1.4, 3.0)
    for yy in np.linspace(back, gauge + 2.0, 9 if lod < 2 else 3):
        w.beam((-3.2, yy, zb + 3.6), (3.2, yy, zb + 3.6), 0.5, 0.5)
    # machinery house on the backreach
    w.box((-5.5, back, zb + 3.7), (5.5, back + 14.0, zb + 10.0))
    r.box((-5.6, back + 0.2, zb + 8.5), (5.6, back + 13.8, zb + 10.2))
    # A-frame (apex) with stays
    apex_y, apex_z = -gauge + 6.0, 80.0
    for xx in (-3.6, 3.6):
        w.beam((xx, -gauge, zb + 3.0), (xx * 0.6, apex_y, apex_z), 1.4, 1.4)
        w.beam((xx, gauge, zb + 3.0), (xx * 0.6, apex_y, apex_z), 1.4, 1.4)
        tip = (xx * 0.6, gauge + 10.0, zb + 58.0) if boom_up else (xx * 0.6, reach - 2.0, zb + 3.8)
        mid = (xx * 0.6, gauge + 8.0, zb + 30.0) if boom_up else (xx * 0.6, gauge + 30.0, zb + 3.8)
        w.beam((xx * 0.6, apex_y, apex_z), tip, 0.35, 0.35, caps=False)
        if lod < 2:
            w.beam((xx * 0.6, apex_y, apex_z), mid, 0.3, 0.3, caps=False)
        w.beam((xx * 0.6, apex_y, apex_z), (xx * 0.6, back + 2.0, zb + 3.6), 0.35, 0.35, caps=False)
    w.beam((-2.2, apex_y, apex_z), (2.2, apex_y, apex_z), 1.2, 1.2)
    r.box((-1.2, apex_y - 0.6, apex_z), (1.2, apex_y + 0.6, apex_z + 1.2))
    # trolley + operator cab
    ty = gauge + 12.0 if not boom_up else gauge - 6.0
    dk.box((-3.0, ty - 3.0, zb + 0.2), (3.0, ty + 3.0, zb + 3.4))
    b.mb['glass' if lod < 2 else 'dark'].box((-1.2, ty - 1.2, zb - 3.2), (1.2, ty + 1.2, zb + 0.2))
    b.mb['warn'].box((-0.4, apex_y - 0.4, apex_z + 1.2), (0.4, apex_y + 0.4, apex_z + 1.8))
    if b.meta:
        m = b.meta
        m.box((-span - 1, -gauge - 1, 0.0), (span + 1, gauge + 1, zb + 3.0), 'Oakland Limanı Vinci')
        if boom_up:
            m.box((-4, gauge, zb), (4, gauge + 12, zb + 60), 'Oakland Limanı Vinci')
        else:
            m.box((-4, gauge, zb), (4, reach, zb + 4.5), 'Oakland Limanı Vinci')
        m.box((-4, back, zb), (4, gauge, zb + 10.5), 'Oakland Limanı Vinci')
        m.box((-4, -gauge, zb + 3), (4, apex_y + 2, apex_z + 2), 'Oakland Limanı Vinci')
        m.light((0, apex_y, apex_z + 2.2), '#ff2a14', size=4.0, period=0)
        m.light((0, (gauge + 10) if boom_up else reach, (zb + 58.5) if boom_up else zb + 4.5), '#ff2a14', size=3.0, period=0)
    return b


def export_cranes():
    """Two instanced landmarks: cranes with booms lowered and with booms raised (idle)."""
    origin = (4800.0, -20500.0)
    import random
    rnd = random.Random(7)
    groups = {False: [], True: []}
    for x, z, heading, g in CR:
        up = rnd.random() < 0.4
        # instance: position in the (heading 0) frame -> local three coords (x, z) relative to the origin
        groups[up].append([round(x - origin[0], 2), 0.0, round(z - origin[1], 2), round(-heading, 4), 1.0])
    for up, inst in groups.items():
        lid = 'oakland_cranes_up' if up else 'oakland_cranes'
        export_landmark(lid, 'Oakland Limanı Vinci', lambda lod, up=up, lid=lid: build_crane(lod, up, lid), origin, 0.0, [(0, 0)],
                        dists=(1500, 7000), extra={'base': 'terrain', 'instances': inst, 'minY': 0.0,
                                                   'bounds': None})
    # bounds for instanced sets: cover all instances
    import json
    for up in (False, True):
        lid = 'oakland_cranes_up' if up else 'oakland_cranes'
        p = os.path.join(OUT, f'{lid}.json')
        d = json.load(open(p))
        xs = [i[0] for i in d['instances']]
        zs = [i[2] for i in d['instances']]
        d['bounds'] = {'min': [min(xs) - 80, 0, min(zs) - 80], 'max': [max(xs) + 80, 130, max(zs) + 80]}
        json.dump(d, open(p, 'w'), separators=(',', ':'))


# ================================================================================================ main
def site(lid, name, fn, origin, dists=(1200, 6000)):
    return lambda: export_landmark(lid, name, fn, origin, 0.0, [(0, 0)], dists=dists,
                                   extra={'base': 'absolute', 'anchored': True}, draco_bits=16)


def oracle_export():
    export_landmark('oracle_park', 'Oracle Park Stadyumu', build_oracle, OP_HOME, OP_HEADING, [(0, 0)], dists=(1500, 7000),
                    extra={'base': 'absolute', 'anchored': True})


SITES = {
    'alcatraz': site('alcatraz', 'Alcatraz Hapishanesi', build_alcatraz, ALC_ORIGIN, (1500, 7000)),
    'fortpoint': site('fort_point', 'Fort Point Kalesi', build_fortpoint, FP_ORIGIN),
    'cityhall': site('city_hall', 'Belediye Binası (City Hall)', build_cityhall, CH_ORIGIN, (1500, 7000)),
    'palace': site('palace_of_fine_arts', 'Güzel Sanatlar Sarayı', build_palace, PAL_ORIGIN),
    'chase': site('chase_center', 'Chase Center', build_chase, CC_ORIGIN),
    'painted': site('painted_ladies', 'Painted Ladies Evleri', build_painted, PL_ORIGIN, (800, 3000)),
    'pier39': site('pier_39', 'Pier 39 İskelesi', build_pier39, PI_ORIGIN),
    'oracle': oracle_export,
    'cranes': export_cranes,
}


def main():
    reset_scene()
    names = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else list(SITES)
    for n in names:
        SITES[n]()


if __name__ == '__main__':
    main()
