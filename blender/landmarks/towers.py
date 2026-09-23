"""Downtown / hilltop towers (W3): Transamerica Pyramid, Salesforce Tower, Coit Tower, Ferry Building, Sutro Tower.

Run:  Blender -b -P blender/landmarks/towers.py [-- transamerica salesforce coit ferry sutro]
Each landmark -> assets/sf/landmarks/<id>{,_lod1,_lod2}.glb + <id>.json. Footprints/orientations from OSM (see
tools/geo/landmarks_layout.py output printed in the comments), placement on the terrain at runtime (base='terrain':
model z=0 is the ground at the footprint's lowest point; foundations extend below).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from lmkit import MB, V, Meta, OUT, material, export, tri_count, reset_scene, norm, texture, fbm, srgb, blur  # noqa: E402
from bridgekit import column  # noqa: E402
import tex_common as tx  # noqa: E402

DEG = math.pi / 180


def heading_of(dx, dz):
    return math.atan2(dx, -dz) % (2 * math.pi)


# ------------------------------------------------------------------------------------------------ generic helpers
def rounded_square(a, r, seg=6):
    """CCW outline of a square of half-size a with corner radius r."""
    pts = []
    for cx, cy, a0 in ((a - r, a - r, 0), (-(a - r), a - r, 90), (-(a - r), -(a - r), 180), (a - r, -(a - r), 270)):
        for k in range(seg + 1):
            t = (a0 + 90 * k / seg) * DEG
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def loft(mb, rings, zs, ts_u=4.0, ts_v=4.0, col=None, cap_top=True, smooth=False, uv_scale=None, angular=False):
    """Loft closed outlines (same vertex count) at heights zs. UV: u = perimeter distance / ts_u, v = z / ts_v."""
    n = len(rings[0])
    idx = []
    for ring, z in zip(rings, zs):
        idx.append(mb.add_verts([(x, y, z) for x, y in ring], col))
    for k in range(len(rings) - 1):
        ra, rb = rings[k], rings[k + 1]
        za, zb = zs[k], zs[k + 1]
        ua = ub = 0.0
        for i in range(n):
            j = (i + 1) % n
            la = math.hypot(ra[j][0] - ra[i][0], ra[j][1] - ra[i][1])
            lb = math.hypot(rb[j][0] - rb[i][0], rb[j][1] - rb[i][1])
            if angular:     # u = fraction of the turn (texture wraps exactly once, ribs converge to the apex)
                ua, ub, la, lb = i / n * ts_u, i / n * ts_u, ts_u / n, ts_u / n
            if smooth:
                mb.face((idx[k] + i, idx[k] + j, idx[k + 1] + j, idx[k + 1] + i),
                        [(ua / ts_u, za / ts_v), ((ua + la) / ts_u, za / ts_v), ((ub + lb) / ts_u, zb / ts_v), (ub / ts_u, zb / ts_v)], smooth=True)
            else:
                a0, a1 = V(ra[i][0], ra[i][1], za), V(ra[j][0], ra[j][1], za)
                b0, b1 = V(rb[i][0], rb[i][1], zb), V(rb[j][0], rb[j][1], zb)
                mb.quad(a0, a1, b1, b0, uv=[(ua / ts_u, za / ts_v), ((ua + la) / ts_u, za / ts_v), ((ub + lb) / ts_u, zb / ts_v), (ub / ts_u, zb / ts_v)], col=col)
            ua += la
            ub += lb
    if cap_top:
        mb.polygon([(x, y, zs[-1]) for x, y in rings[-1]], ts_u, col=col)


def world_uv_face(mb, pts, ts_u, ts_v, axis, col=None):
    """Planar quad with u = dot(p, axis)/ts_u, v = z/ts_v (keeps floors horizontal on sloped faces)."""
    uv = [(float(np.dot(V(p)[:2], axis)) / ts_u, p[2] / ts_v) for p in pts]
    mb.quad(*pts, uv=uv, col=col)


class Build:
    """Per-LOD builder state: materials + mesh builders + meta."""

    def __init__(self, lid, name, lod, mats):
        self.lod = lod
        self.M = mats
        self.mb = {k: MB(k) for k in mats}
        self.meta = Meta(lid, name) if lod == 0 else None
        self.name = name

    def objects(self, prefix):
        return [mb.to_object(f'{prefix}_{k}', self.M[k], use_colors=True) for k, mb in self.mb.items() if len(mb)]


def export_landmark(lid, name, build_fn, origin, heading, footprint, dists=(1500, 7000), extra=None, draco_bits=16):
    results = {}
    meta = None
    bounds = None
    for lod in (0, 1, 2):
        b = build_fn(lod)
        obs = b.objects(lid if lod == 0 else f'{lid}_lod{lod}')
        fname = lid + ('' if lod == 0 else f'_lod{lod}')
        path = os.path.join(OUT, f'{fname}.glb')
        export(path, obs, draco_bits=draco_bits)
        results[lod] = tri_count(obs)
        print(f'{lid} LOD{lod}: {results[lod]} tris, {os.path.getsize(path) / 1e6:.2f} MB')
        if lod == 0:
            meta = b.meta
            vs = np.array([tuple(v.co) for o in obs for v in o.data.vertices])
            mn, mx = vs.min(axis=0), vs.max(axis=0)
            bounds = {'min': [float(mn[0]), float(mn[2]), float(-mx[1])], 'max': [float(mx[0]), float(mx[2]), float(-mn[1])]}
        for o in obs:
            o.hide_set(True)
            o.hide_render = True
    meta.d.update({
        'origin': {'x': round(origin[0], 2), 'z': round(origin[1], 2)}, 'heading': heading, 'base': 'terrain',
        'footprint': [[round(x, 2), round(-y, 2)] for x, y in footprint],
        'lods': [{'url': f'assets/sf/landmarks/{lid}.glb', 'dist': dists[0]},
                 {'url': f'assets/sf/landmarks/{lid}_lod1.glb', 'dist': dists[1]},
                 {'url': f'assets/sf/landmarks/{lid}_lod2.glb', 'dist': 1e9}],
        'tris': {str(k): v for k, v in results.items()}, 'bounds': bounds,
    })
    if extra:
        meta.d.update(extra)
    meta.save()


# ================================================================================================ Transamerica
TAM_ORIGIN = (-2586.5, -19532.4)
TAM_HEADING = (-9.38 % 360) * DEG      # +Y = along Montgomery St (NNW), +X = ENE (elevator wing side)


def tam_materials(lod):
    if lod == 2:
        return {'facade': material('tam2_facade', color=(0.62, 0.61, 0.58), rough=0.6),
                'spire': material('tam2_spire', color=(0.6, 0.6, 0.6), rough=0.35, metal=0.8),
                'dark': material('tam2_dark', color=(0.05, 0.06, 0.07), rough=0.2),
                'warn': material('tam2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 1024 if lod == 0 else 256
    a, o, n, e = tx.window_facade(f'tam{lod}_facade', size=sz, cols=4, rows=2, frame='#DCD9D0', glass='#1D2632', win_w=0.56,
                                  win_h=0.5, seed=101, lit=0.22, streaks=0.06)
    sp = texture(f'tam{lod}_spire_albedo', lambda: np.array([0.72, 0.72, 0.71])[None, None, :] * (1 + 0.04 * fbm(256, 256, 7, 3, 4))[:, :, None]
                 * (1 - 0.15 * (np.abs(((np.arange(256) / 32.0) % 1) - 0.5) < 0.03))[None, :, None], 'jpg')
    M = {'facade': material(f'tam{lod}_facade_emit', albedo=a, emissive_img=e, emissive_strength=1.0,
                            **({'rough_img': o, 'normal': n, 'normal_strength': 0.8} if lod == 0 else {'rough': 0.5})),
         'wing': material(f'tam{lod}_wing', color=(0.70, 0.69, 0.66), rough=0.65),
         'spire': material(f'tam{lod}_spire', albedo=sp, rough=0.35, metal=0.85),
         'dark': material(f'tam{lod}_dark', color=(0.04, 0.05, 0.06), rough=0.15),
         'glass': material(f'tam{lod}_lobby_glass', color=(0.05, 0.07, 0.08), rough=0.05, metal=0.2),
         'warn': material(f'tam{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
         'crown': material(f'tam{lod}_crown_emit', color=(0.9, 0.9, 0.85), emissive=(1.0, 0.95, 0.85), emissive_strength=3.0)}
    return M


def tam_hw(z):
    """Pyramid half-width (m) at height z: 53 m base (174 ft) to 13.7 m (45 ft) at the 48th floor (~197 m)."""
    return 26.9 - (26.9 - 6.85) * z / 197.0


def build_transamerica(lod):
    b = Build('transamerica', 'Transamerica Piramidi', lod, tam_materials(lod))
    fac = b.mb['facade']
    ts_u, ts_v = 10.0, 7.6            # 4 windows x 2 floors per tile (2.5 m x 3.8 m cells)
    z0, z1 = 16.0, 197.0
    faces = [((1, 0), (0, 1)), ((0, 1), (-1, 0)), ((-1, 0), (0, -1)), ((0, -1), (1, 0))]   # (normal, tangent), t x up = n
    for nrm, tan in faces:
        n, t = V(*nrm), V(*tan)
        h0, h1 = tam_hw(z0), tam_hw(z1)
        a = V(*(n * h0 - t * h0), z0)
        bb = V(*(n * h0 + t * h0), z0)
        c = V(*(n * h1 + t * h1), z1)
        d = V(*(n * h1 - t * h1), z1)
        world_uv_face(fac, [a, bb, c, d], ts_u, ts_v, t)
    # wings: elevator (east, +X) and stair/smoke tower (west, -X); vertical, emerging above ~floor 29
    wing = b.mb['wing'] if lod < 2 else b.mb['facade']
    for side, w, top, xo in ((1, 6.6, 212.0, 14.3), (-1, 4.8, 206.0, 13.2)):
        x0, x1 = sorted((side * 6.0, side * xo))
        wing.box((x0, -w, 110.0), (x1, w, top), ts=4.0, faces='xXyY')
        # sloped cap leaning towards the spire
        xo_, xi_ = side * xo, side * 6.0
        if side > 0:
            wing.quad((xo_, -w, top), (xo_, w, top), (xi_, w, top + 6.0), (xi_, -w, top + 6.0))
        else:
            wing.quad((xo_, w, top), (xo_, -w, top), (xi_, -w, top + 6.0), (xi_, w, top + 6.0))
        if side > 0:
            wing.tri((xi_, -w, top), (xo_, -w, top), (xi_, -w, top + 6.0))
            wing.tri((xo_, w, top), (xi_, w, top), (xi_, w, top + 6.0))
        else:
            wing.tri((xo_, -w, top), (xi_, -w, top), (xi_, -w, top + 6.0))
            wing.tri((xi_, w, top), (xo_, w, top), (xi_, w, top + 6.0))
        if lod == 0:
            # vertical window slits / louvres on the outer face of the wings
            xf = side * xo
            for dy in (-w * 0.45, 0.0, w * 0.45):
                b.mb['dark'].box((xf - 0.06, dy - 0.5, 125.0), (xf + 0.06, dy + 0.5, top - 4.0), faces='X' if side > 0 else 'x')
    # roof of the pyramid body at the spire base
    h1 = tam_hw(z1)
    fac.box((-h1, -h1, z1 - 0.1), (h1, h1, z1 + 0.6), faces='Z')
    # spire: aluminum-clad hollow pyramid 212 ft
    sp = b.mb['spire']
    top = 260.0
    hs = h1 - 0.4
    for nrm, tan in faces:
        n, t = V(*nrm), V(*tan)
        p0 = V(*(n * hs - t * hs), z1 + 0.6)
        p1 = V(*(n * hs + t * hs), z1 + 0.6)
        sp.tri(p0, p1, V(0, 0, top), ts=4.0)
    # "Crown Jewel" lantern near the tip + aviation light
    if lod < 2:
        b.mb['crown'].box((-0.9, -0.9, 243.0), (0.9, 0.9, 246.0), faces='xXyY')
    b.mb['warn'].cylinder((0, 0, top - 0.3), 0.25, 0.8, sides=8)
    # base: trussed arcade of sloping columns (floors 1-5) with the glass lobby set back
    if lod == 2:
        b.mb['facade'].box((-26.9, -26.9, 0.0), (26.9, 26.9, z0), faces='xXyY')
    else:
        g = b.mb['glass']
        g.box((-22.5, -22.5, -2.0), (22.5, 22.5, z0 - 1.0), faces='xXyY')
        fac.box((-26.4, -26.4, z0 - 1.6), (26.4, 26.4, z0), faces='xXyYz')          # ring beam
        cm = b.mb['wing']
        npan = 8
        for nrm, tan in faces:
            n, t = V(*nrm), V(*tan)
            hb, ht = tam_hw(0.0), tam_hw(z0 - 1.6)
            for k in range(npan + 1):
                u = -1 + 2 * k / npan
                pb = V(*(n * hb + t * hb * u), 0.0)
                if k < npan:
                    um = -1 + 2 * (k + 0.5) / npan
                    pt = V(*(n * ht + t * ht * um), z0 - 1.6)
                    cm.beam(pb, pt, 1.0, 1.2, up=tuple(n) + (0,), ts=3.0)
                if k > 0:
                    um = -1 + 2 * (k - 0.5) / npan
                    pt = V(*(n * ht + t * ht * um), z0 - 1.6)
                    cm.beam(pb, pt, 1.0, 1.2, up=tuple(n) + (0,), ts=3.0)
        # foundation skirt for sloped streets
        cm.box((-26.9, -26.9, -6.0), (26.9, 26.9, 0.0), faces='xXyY')
    if b.meta:
        m = b.meta
        # stepped collision: 5 boxes approximating the pyramid, wings and the spire
        levels = [0.0, 40.0, 80.0, 120.0, 160.0, 197.0]
        for za, zb in zip(levels[:-1], levels[1:]):
            hw = tam_hw(za)
            m.box((-hw, -hw, za - (6.0 if za == 0 else 0.0)), (hw, hw, zb), 'Transamerica Piramidi')
        m.box((6.0, -6.6, 110.0), (14.3, 6.6, 218.0), 'Transamerica Piramidi')
        m.box((-13.2, -4.8, 110.0), (-6.0, 4.8, 212.0), 'Transamerica Piramidi')
        m.capsule((0, 0, 197.0), (0, 0, top), 4.0, 'Transamerica Piramidi')
        m.light((0, 0, top + 0.6), '#ff2a14', size=5.0, period=2.0, duty=0.5)
        m.light((0, 0, 244.5), '#fff2dd', size=6.0, period=0, kind='lamp', intensity=1.2)
    return b


# ================================================================================================ Salesforce Tower
SF_ORIGIN = (-2067.2, -18937.5)
SF_HEADING = 49.24 * DEG
SF_TOP, SF_CROWN0 = 326.0, 280.0


def sf_a(z):
    return 27.3 - 3.6 * (min(max(z, 0.0), SF_TOP) / SF_TOP) ** 1.6


def sf_materials(lod):
    if lod == 2:
        return {'facade': material('sft2_facade', color=(0.55, 0.57, 0.58), rough=0.25),
                'dark': material('sft2_dark', color=(0.12, 0.12, 0.13), rough=0.6),
                'warn': material('sft2_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}
    sz = 1024 if lod == 0 else 256
    # glass curtain wall with pearl-white vertical fins and horizontal sunshades
    a, o, n, e = tx.window_facade(f'sft{lod}_facade', size=sz, cols=4, rows=2, frame='#E4E5E1', glass='#3B4A55', win_w=0.82,
                                  win_h=0.80, seed=111, lit=0.15, streaks=0.02, frame_rough=0.45, glass_rough=0.06, glass_var=0.12,
                                  recess=False)

    def fins():
        s = 256
        img = np.zeros((s, s, 4))
        yy, xx = np.mgrid[0:s, 0:s] / s
        fin = (np.abs((xx * 8) % 1 - 0.5) > 0.30) | (np.abs((yy * 4) % 1 - 0.5) > 0.40)
        img[:, :, :3] = srgb('#E8E8E4')
        img[:, :, 3] = fin
        return img
    fa = texture(f'sft{lod}_fins_albedo', fins, 'png', alpha=True)

    def led():
        s = 512
        v = np.clip(0.5 + 0.8 * fbm(s, s, 117, 4, 3), 0, 1)
        img = np.stack([v, v * 0.97, v * 0.92], axis=2) * ((np.arange(s)[None, :] % 8) < 5)[:, :, None]
        return img
    la = texture(f'sft{lod}_led_emit', led, 'jpg')
    return {'facade': material(f'sft{lod}_facade_emit', albedo=a, emissive_img=e, emissive_strength=0.8,
                               **({'rough_img': o, 'normal': n, 'normal_strength': 0.3} if lod == 0 else {'rough': 0.2})),
            'fins': material(f'sft{lod}_fins_clip', albedo=fa, alpha_img=True, double_sided=True, rough=0.45),
            'dark': material(f'sft{lod}_dark', color=(0.10, 0.10, 0.11), rough=0.7),
            'lobby': material(f'sft{lod}_lobby_glass', color=(0.06, 0.08, 0.09), rough=0.05, metal=0.3),
            'led': material(f'sft{lod}_led_emit', color=(0.3, 0.3, 0.3), emissive_img=la, emissive_strength=1.2),
            'warn': material(f'sft{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}


def build_salesforce(lod):
    b = Build('salesforce', 'Salesforce Kulesi', lod, sf_materials(lod))
    seg = {0: 7, 1: 4, 2: 2}[lod]
    nz = {0: 40, 1: 14, 2: 5}[lod]
    ring = lambda z, k=1.0: rounded_square(sf_a(z) * k, sf_a(z) * k * 0.36, seg)
    # lobby (inset glass) 0..14 m
    if lod < 2:
        zs = [-4.0, 14.0]
        loft(b.mb['lobby'], [ring(0, 0.97), ring(14, 0.97)], zs, cap_top=False)
    zs = [14.0 + (SF_CROWN0 - 14.0) * (i / nz) for i in range(nz + 1)] if lod < 2 else [0.0, SF_CROWN0]
    loft(b.mb['facade'], [ring(z) for z in zs], zs, ts_u=6.0, ts_v=8.3, cap_top=False)
    # crown: open lattice shell (fins) + mechanical core + LED screen band
    zc = [SF_CROWN0 + (SF_TOP - SF_CROWN0) * i / 6 for i in range(7)]
    if lod < 2:
        loft(b.mb['fins'], [ring(z) for z in zc], zc, ts_u=6.0, ts_v=8.3, cap_top=False)
        # inner crown: mechanical core + LED screen band + light inner lattice shell (reads solid from afar)
        loft(b.mb['dark'], [ring(SF_CROWN0, 0.78), ring(300.0, 0.74)], [SF_CROWN0, 300.0])
        loft(b.mb['led'], [ring(z, 0.86) for z in (284.0, 306.0)], [284.0, 306.0], ts_u=40.0, ts_v=22.0, cap_top=False)
        zi = [SF_CROWN0 + (SF_TOP - 4.0 - SF_CROWN0) * i / 5 for i in range(6)]
        loft(b.mb['fins'], [ring(z, 0.93) for z in zi], zi, ts_u=5.0, ts_v=6.0, cap_top=False)
        # roof rim
        loft(b.mb['facade'], [ring(SF_TOP - 1.2), ring(SF_TOP)], [SF_TOP - 1.2, SF_TOP], cap_top=False)
    else:
        loft(b.mb['facade'], [ring(SF_CROWN0), ring(SF_TOP)], [SF_CROWN0, SF_TOP])
    if b.meta:
        m = b.meta
        for za, zb in ((-4.0, 100.0), (100.0, 200.0), (200.0, SF_TOP)):
            a = sf_a(za)
            m.box((-a, -a, za), (a, a, zb), 'Salesforce Kulesi')
        a = sf_a(SF_TOP) * 0.9
        for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            m.light((sx * a * 0.72, sy * a * 0.72, SF_TOP + 0.5), '#ff2a14', size=5.0, period=2.0, duty=0.5)
        m.light((0, 0, 292.0), '#ffffff', size=1.0, period=0, kind='lamp', intensity=0.0)
    for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        a = sf_a(SF_TOP) * 0.9
        b.mb['warn'].cylinder((sx * a * 0.72, sy * a * 0.72, SF_TOP), 0.25, 0.6, sides=6)
    return b


# ================================================================================================ Coit Tower
COIT_ORIGIN = (-2860.0, -20330.0)


def coit_materials(lod):
    if lod == 2:
        return {'stone': material('coit2_stone', color=(0.66, 0.62, 0.55), rough=0.85),
                'dark': material('coit2_dark', color=(0.04, 0.04, 0.045), rough=0.9)}
    ca, _, cn = tx.concrete_textures(f'coit{lod}_stone', base=(0.80, 0.76, 0.68), seed=121, size=512 if lod == 0 else 128, boards=0.9)
    return {'stone': material(f'coit{lod}_stone', albedo=ca, rough=0.85, **({'normal': cn} if lod == 0 else {})),
            'dark': material(f'coit{lod}_dark', color=(0.04, 0.04, 0.045), rough=0.9),
            'roof': material(f'coit{lod}_roof', color=(0.35, 0.33, 0.30), rough=0.8),
            'warn': material(f'coit{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}


def fluted_ring(r, n=20, depth=0.28, sub=2):
    pts = []
    for i in range(n * sub * 2):
        a = 2 * math.pi * i / (n * sub * 2)
        k = (i // sub) % 2
        rr = r - depth * k
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    return pts


def build_coit(lod):
    b = Build('coit_tower', 'Coit Kulesi', lod, coit_materials(lod))
    st = b.mb['stone']
    n = {0: 20, 1: 12, 2: 8}[lod]
    # podium (lobby with the murals): 18-sided drum 22 m, 7 m tall + stepped plinth
    pod = lambda r: [(r * math.cos(2 * math.pi * i / 18), r * math.sin(2 * math.pi * i / 18)) for i in range(18)]
    loft(st, [pod(11.2), pod(11.2)], [-6.0, 7.0], ts_u=6, ts_v=6)
    loft(st, [pod(10.2), pod(10.2)], [7.0, 8.2], ts_u=6, ts_v=6)
    # fluted shaft 37 ft diameter tapering slightly
    if lod == 2:
        loft(st, [pod(5.6), pod(5.0)], [8.2, 64.0], ts_u=6, ts_v=6)
    else:
        rings = [fluted_ring(5.65 - 0.5 * t, n, 0.3 if lod == 0 else 0.25, 1) for t in (0.0, 1.0)]
        loft(st, rings, [8.2, 55.0], ts_u=6, ts_v=6)
        # observation level with 8 tall arched openings (dark recesses) + crown
        loft(st, [pod(5.4), pod(5.4)], [55.0, 64.0], ts_u=6, ts_v=6, cap_top=False)
        dk = b.mb['dark']
        for i in range(8):
            a = 2 * math.pi * (i + 0.5) / 8
            c, s = math.cos(a), math.sin(a)
            t = V(-s, c, 0)
            p = V(c * 5.42, s * 5.42, 0)
            w = 1.25
            dk.quad(p - t * w + V(0, 0, 56.2), p + t * w + V(0, 0, 56.2), p + t * w + V(0, 0, 61.4), p - t * w + V(0, 0, 61.4))
            # arch head
            for k in range(6):
                a0, a1 = math.pi * k / 6, math.pi * (k + 1) / 6
                dk.tri(p + V(0, 0, 61.4), p + t * (w * math.cos(a0)) + V(0, 0, 61.4 + w * math.sin(a0)), p + t * (w * math.cos(a1)) + V(0, 0, 61.4 + w * math.sin(a1)))
        # cornice + parapet with small merlons
        loft(st, [pod(5.9), pod(5.9)], [63.2, 64.0], ts_u=6, ts_v=6, cap_top=False)
        b.mb['roof'].polygon([(x, y, 63.6) for x, y in pod(5.5)])
        if lod == 0:
            for i in range(16):
                a = 2 * math.pi * i / 16
                st.box((5.2 * math.cos(a) - 0.35, 5.2 * math.sin(a) - 0.35, 64.0), (5.2 * math.cos(a) + 0.35, 5.2 * math.sin(a) + 0.35, 65.2))
        b.mb['warn'].cylinder((0, 0, 63.6), 0.2, 2.2, sides=6)
    if b.meta:
        b.meta.box((-11.2, -11.2, -6.0), (11.2, 11.2, 8.2), 'Coit Kulesi')
        b.meta.box((-5.7, -5.7, 8.2), (5.7, 5.7, 65.2), 'Coit Kulesi')
        b.meta.light((0, 0, 66.2), '#ff2a14', size=3.5, period=0)
    return b


# ================================================================================================ Ferry Building
FERRY_ORIGIN = (-1767.0, -19576.0)
FERRY_HEADING = 143.3 * DEG     # +Y = SE along the Embarcadero, +X = SW (front, Market St)
FERRY_L, FERRY_W = 201.4, 56.2


def ferry_facade_tex(name, size):
    """Sandstone facade 2 floors: ground arcade (tall arches) + upper paired windows; tile = 6.7 m x 16 m."""
    def f():
        W, H = size, size * 2
        img = np.zeros((H, W, 3))
        stone = srgb('#CDBFA6')
        img[:] = stone
        img *= (1 + 0.05 * fbm(H, W, 131, 4, 4))[:, :, None]
        yy, xx = np.mgrid[0:H, 0:W]
        u = xx / W
        v = 1 - yy / H           # v=0 bottom
        # ground arcade arch: opening from v 0.02..0.55, width 0.62 with semicircular head
        cxa = 0.5
        hw = 0.31
        rise = hw * W / H * 1.0
        body = (np.abs(u - cxa) < hw) & (v > 0.0) & (v < 0.42)
        head = ((u - cxa) ** 2 * (W / H) ** 2 + (v - 0.42) ** 2) < (hw * W / H) ** 2
        arch = body | (head & (v >= 0.42))
        glassc = srgb('#262C30')
        img = np.where(arch[:, :, None], glassc[None, None, :] * (1 + 0.1 * fbm(H, W, 133, 3, 8))[:, :, None], img)
        # mullions in the arch
        mull = arch & ((np.abs(u - 0.5) < 0.012) | (np.abs(v - 0.28) < 0.006) | (np.abs(v - 0.5) < 0.005))
        img = np.where(mull[:, :, None], stone[None, None, :] * 0.7, img)
        # string course between floors
        sc = (v > 0.62) & (v < 0.655)
        img = np.where(sc[:, :, None], img * 0.82, img)
        # upper floor paired windows
        for c in (0.3, 0.7):
            w = (np.abs(u - c) < 0.11) & (v > 0.7) & (v < 0.9)
            img = np.where(w[:, :, None], glassc[None, None, :], img)
        # cornice at top
        img = np.where((v > 0.95)[:, :, None], img * 0.85, img)
        # grime near the ground
        img *= (1 - 0.15 * np.clip(0.2 - v, 0, 1) / 0.2)[:, :, None]
        return img
    return texture(f'{name}_albedo', f, 'jpg')


def ferry_materials(lod):
    stone_c = (0.62, 0.57, 0.48)
    if lod == 2:
        return {'stone': material('ferry2_stone', color=stone_c, rough=0.85),
                'roof': material('ferry2_roof', color=(0.28, 0.29, 0.30), rough=0.7)}
    fa = ferry_facade_tex(f'ferry{lod}_facade', 512 if lod == 0 else 128)
    sa, _, sn = tx.concrete_textures(f'ferry{lod}_stone', base=(0.72, 0.66, 0.56), seed=135, size=512 if lod == 0 else 128, boards=0.5)

    def clock():
        s = 256
        yy, xx = np.mgrid[0:s, 0:s] / s - 0.5
        r = np.hypot(xx, yy)
        img = np.ones((s, s, 3)) * srgb('#CDBFA6')
        face = r < 0.46
        img[face] = srgb('#F2EEE2')
        ring = (r > 0.43) & (r < 0.46)
        img[ring] = srgb('#1E1E1E')
        ang = np.arctan2(xx, -yy)
        ticks = (r > 0.36) & (r < 0.42) & (np.abs(((ang / (2 * np.pi) * 12) % 1) - 0.5) > 0.47)
        img[ticks] = srgb('#1E1E1E')
        # hands at 10:10
        for a_deg, L, wdt in ((300.0, 0.28, 0.018), (60.0, 0.36, 0.012)):
            a = math.radians(a_deg)
            d = np.abs(xx * math.cos(a) + yy * math.sin(a))
            along = xx * math.sin(a) - yy * math.cos(a)
            img[(d < wdt) & (along > -0.02) & (along < L)] = srgb('#1E1E1E')
        return img
    ck = texture(f'ferry{lod}_clock_albedo', clock, 'jpg')
    return {'facade': material(f'ferry{lod}_facade', albedo=fa, rough=0.8),
            'stone': material(f'ferry{lod}_stone', albedo=sa, rough=0.85, **({'normal': sn} if lod == 0 else {})),
            'roof': material(f'ferry{lod}_roof', color=(0.30, 0.31, 0.32), rough=0.6, metal=0.3),
            'skylight': material(f'ferry{lod}_skylight', color=(0.2, 0.24, 0.27), rough=0.1),
            'clock': material(f'ferry{lod}_clock_emit', albedo=ck, emissive=(0.25, 0.23, 0.2), emissive_strength=1.0, rough=0.4),
            'dark': material(f'ferry{lod}_dark', color=(0.03, 0.03, 0.035), rough=0.9),
            'warn': material(f'ferry{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}


def facade_box(mb, lo, hi, tile_w, tile_h, z_base=0.0, faces='xXyY'):
    """Box whose vertical faces use a facade texture: u = along-face / tile_w, v = (z - z_base) / tile_h."""
    lo, hi = V(lo), V(hi)
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    vv = lambda z: (z - z_base) / tile_h
    if 'y' in faces:
        mb.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), uv=[(x0 / tile_w, vv(z0)), (x1 / tile_w, vv(z0)), (x1 / tile_w, vv(z1)), (x0 / tile_w, vv(z1))])
    if 'Y' in faces:
        mb.quad((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1), uv=[(-x1 / tile_w, vv(z0)), (-x0 / tile_w, vv(z0)), (-x0 / tile_w, vv(z1)), (-x1 / tile_w, vv(z1))])
    if 'X' in faces:
        mb.quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1), uv=[(y0 / tile_w, vv(z0)), (y1 / tile_w, vv(z0)), (y1 / tile_w, vv(z1)), (y0 / tile_w, vv(z1))])
    if 'x' in faces:
        mb.quad((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1), uv=[(-y1 / tile_w, vv(z0)), (-y0 / tile_w, vv(z0)), (-y0 / tile_w, vv(z1)), (-y1 / tile_w, vv(z1))])
    if 'Z' in faces:
        mb.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), 8.0)


def build_ferry(lod):
    b = Build('ferry_building', 'Ferry Building (İskele Binası)', lod, ferry_materials(lod))
    L2, W2 = FERRY_L / 2, FERRY_W / 2
    H = 16.0
    if lod == 2:
        b.mb['stone'].box((-W2, -L2, -3.0), (W2, L2, H), faces='xXyYZ')
    else:
        facade_box(b.mb['facade'], (-W2, -L2, -3.0), (W2, L2, H), 6.7, 16.0, z_base=0.0)
        # roof: flat + long central clerestory/skylight nave
        b.mb['roof'].box((-W2, -L2, H - 0.2), (W2, L2, H + 0.4), faces='Z')
        b.mb['stone'].box((-W2 - 0.4, -L2 - 0.4, H - 0.2), (W2 + 0.4, L2 + 0.4, H + 1.2), faces='xXyY')   # parapet
        nave = 11.0
        zr = H + 0.4
        sk = b.mb['skylight']
        rf = b.mb['roof']
        # gabled skylight roof over the nave
        rf.box((-nave, -L2 + 6, zr), (nave, L2 - 6, zr + 3.5), faces='xXyY')
        sk.quad((-nave, -L2 + 6, zr + 3.5), (0, -L2 + 6, zr + 7.5), (0, L2 - 6, zr + 7.5), (-nave, L2 - 6, zr + 3.5))
        sk.quad((0, -L2 + 6, zr + 7.5), (nave, -L2 + 6, zr + 3.5), (nave, L2 - 6, zr + 3.5), (0, L2 - 6, zr + 7.5))
        rf.tri((-nave, -L2 + 6, zr + 3.5), (nave, -L2 + 6, zr + 3.5), (0, -L2 + 6, zr + 7.5))
        rf.tri((nave, L2 - 6, zr + 3.5), (-nave, L2 - 6, zr + 3.5), (0, L2 - 6, zr + 7.5))
    # clock tower (Giralda-inspired), centered on the front (Embarcadero) facade
    tx0, ty0 = 12.0, 0.0
    st = b.mb['stone']

    def blk(hw, z0, z1, faces='xXyYZ'):
        if lod == 2:
            st.box((tx0 - hw, ty0 - hw, z0), (tx0 + hw, ty0 + hw, z1), faces=faces)
        else:
            facade_box(st, (tx0 - hw, ty0 - hw, z0), (tx0 + hw, ty0 + hw, z1), 4.0, 6.0, faces=faces)
    blk(7.6, H, 44.5)
    blk(8.0, 44.5, 46.0)
    blk(7.8, 46.0, 55.0)
    blk(6.8, 55.0, 63.5)
    blk(5.0, 63.5, 69.5)
    if lod < 2:
        # corner pilasters on the shaft
        for sx in (-1, 1):
            for sy in (-1, 1):
                st.box((tx0 + sx * 7.6 - 0.8, ty0 + sy * 7.6 - 0.8, H), (tx0 + sx * 7.6 + 0.8, ty0 + sy * 7.6 + 0.8, 44.5), faces='xXyY')
                st.box((tx0 + sx * 6.8 - 0.6, ty0 + sy * 6.8 - 0.6, 55.0), (tx0 + sx * 6.8 + 0.6, ty0 + sy * 6.8 + 0.6, 64.4), faces='xXyYZ')
        # vertical window slits on the shaft
        dk = b.mb['dark']
        for (nx, ny) in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            for off in (-2.5, 0.0, 2.5):
                cx = tx0 + nx * 7.62 + (0 if nx else off)
                cy = ty0 + ny * 7.62 + (0 if ny else off)
                w = 0.55
                if nx:
                    dk.quad((cx, cy - w * nx, 24.0), (cx, cy + w * nx, 24.0), (cx, cy + w * nx, 40.0), (cx, cy - w * nx, 40.0))
                else:
                    dk.quad((cx + w * ny, cy, 24.0), (cx - w * ny, cy, 24.0), (cx - w * ny, cy, 40.0), (cx + w * ny, cy, 40.0))
            # belfry arches (dark openings) on the two upper stages
            for zc, hw, n in ((58.5, 6.82, 3), (65.5, 5.02, 2)):
                for k in range(n):
                    off = (k - (n - 1) / 2) * (2 * hw / n)
                    cx = tx0 + nx * hw + (0 if nx else off)
                    cy = ty0 + ny * hw + (0 if ny else off)
                    w = hw / n * 0.55
                    if nx:
                        dk.quad((cx, cy - w * nx, zc - 2.8), (cx, cy + w * nx, zc - 2.8), (cx, cy + w * nx, zc + 2.4), (cx, cy - w * nx, zc + 2.4))
                    else:
                        dk.quad((cx + w * ny, cy, zc - 2.8), (cx - w * ny, cy, zc - 2.8), (cx - w * ny, cy, zc + 2.4), (cx + w * ny, cy, zc + 2.4))
        # four clock faces (22 ft dials)
        ck = b.mb['clock']
        r = 3.35
        for (nx, ny) in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            c = V(tx0 + nx * 7.85, ty0 + ny * 7.85, 50.5)
            t = V(-ny, nx, 0)
            up = V(0, 0, 1)
            ck.quad(c - t * r - up * r, c + t * r - up * r, c + t * r + up * r, c - t * r + up * r, uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
        # octagonal cupola + lantern + flagpole
        oc = lambda rr: [(tx0 + rr * math.cos(2 * math.pi * (i + 0.5) / 8), ty0 + rr * math.sin(2 * math.pi * (i + 0.5) / 8)) for i in range(8)]
        loft(st, [oc(4.3), oc(4.3), oc(3.4), oc(1.6), oc(1.0)], [69.5, 71.0, 73.2, 74.8, 75.4], ts_u=4, ts_v=4)
        st.cylinder((tx0, ty0, 75.4), 0.12, 3.5, sides=6)
        b.mb['warn'].cylinder((tx0, ty0, 78.9), 0.2, 0.4, sides=6)
    else:
        st.box((tx0 - 3, ty0 - 3, 69.5), (tx0 + 3, ty0 + 3, 75.0))
    if b.meta:
        b.meta.box((-W2, -L2, -3.0), (W2, L2, H + 7.9), 'Ferry Building (İskele Binası)')
        b.meta.box((tx0 - 8.0, ty0 - 8.0, H), (tx0 + 8.0, ty0 + 8.0, 69.5), 'Ferry Building (İskele Binası)')
        b.meta.capsule((tx0, ty0, 69.5), (tx0, ty0, 78.9), 3.0, 'Ferry Building (İskele Binası)')
        b.meta.light((tx0, ty0, 79.3), '#ff2a14', size=3.0, period=0)
    return b


# ================================================================================================ Sutro Tower
SUTRO_LEGS = [(-6986.4, -15075.7), (-6959.8, -15091.1), (-6959.5, -15047.2)]   # antenna nodes on the three masts
SUTRO_C = (sum(p[0] for p in SUTRO_LEGS) / 3, sum(p[1] for p in SUTRO_LEGS) / 3)
SUTRO_HEADING = heading_of(SUTRO_LEGS[0][0] - SUTRO_C[0], SUTRO_LEGS[0][1] - SUTRO_C[1])   # leg 0 = west leg on +Y
SUTRO_TOP = 298.0
RZ = [(0.0, 31.0), (140.0, 11.5), (232.0, 22.0), (SUTRO_TOP, 22.0)]


def sutro_r(z):
    for (z0, r0), (z1, r1) in zip(RZ[:-1], RZ[1:]):
        if z <= z1:
            return r0 + (r1 - r0) * (z - z0) / (z1 - z0)
    return RZ[-1][1]


def sutro_materials(lod):
    bands = ['#C4402A', '#EDEDEA'] * 5 + ['#C4402A']
    if lod == 2:
        return {'steel': material('sutro2_steel', color=(0.55, 0.25, 0.2), rough=0.6),
                'white': material('sutro2_white', color=(0.8, 0.8, 0.78), rough=0.6)}
    band = tx.stripes(f'sutro{lod}_bands', bands, size=256 if lod == 0 else 64)

    def lattice():
        s = 256
        img = np.zeros((s, s, 4))
        yy, xx = np.mgrid[0:s, 0:s] / s
        a = (xx < 0.1) | (xx > 0.9) | (np.abs(yy * 2 % 1 - 0.5) > 0.47)
        d1 = np.abs(((xx - yy * 2) % 1) - 0.5) < 0.035
        d2 = np.abs(((xx + yy * 2) % 1) - 0.5) < 0.035
        img[:, :, 3] = a | d1 | d2
        img[:, :, :3] = 1.0
        return img
    lat = texture(f'sutro{lod}_lattice_albedo', lattice, 'png', alpha=True)
    return {'steel': material(f'sutro{lod}_legs', albedo=band, rough=0.55),
            'lattice': material(f'sutro{lod}_lattice_clip', albedo=lat, alpha_img=True, double_sided=True, rough=0.6, color=(0.85, 0.85, 0.83)),
            'white': material(f'sutro{lod}_white', color=(0.82, 0.82, 0.80), rough=0.55),
            'concrete': material(f'sutro{lod}_concrete', color=(0.5, 0.49, 0.46), rough=0.9),
            'warn': material(f'sutro{lod}_warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0)}


def build_sutro(lod):
    b = Build('sutro_tower', 'Sutro Kulesi', lod, sutro_materials(lod))
    steel = b.mb['steel']
    angles = [90.0, 210.0, 330.0]
    zs = [0.0, 20, 45, 70, 95, 120, 140.0, 165, 190, 215, 232.0, 260, SUTRO_TOP]
    # legs: tubular steel legs, band texture along height (v = z / SUTRO_TOP)
    for ang in angles:
        a = ang * DEG
        d = V(math.cos(a), math.sin(a), 0)
        pts = [d * sutro_r(z) + V(0, 0, z) for z in zs]
        rad = [2.2 - 1.0 * (z / SUTRO_TOP) if z <= 232 else 1.0 for z in zs]
        if lod == 2:
            for p0, p1 in zip(pts[:-1], pts[1:]):
                steel.beam(p0, p1, 2.6, 2.6, caps=False)
            continue
        sides = 10 if lod == 0 else 6
        # custom tube with v = z / 298 so bands follow the height
        i0 = len(steel.v)
        rings = []
        prev_s = None
        for k, p in enumerate(pts):
            dd = norm(pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)])
            s_ax = norm(np.cross(dd, V(0, 0, 1))) if abs(dd[2]) < 0.999 else V(1, 0, 0)
            u_ax = norm(np.cross(s_ax, dd))
            rings.append(steel.add_verts([p + (s_ax * math.cos(t) + u_ax * math.sin(t)) * rad[k] for t in np.linspace(0, 2 * math.pi, sides + 1)[:-1]]))
        for k in range(len(pts) - 1):
            for j in range(sides):
                j1 = (j + 1) % sides
                va, vb = pts[k][2] / SUTRO_TOP, pts[k + 1][2] / SUTRO_TOP
                steel.face((rings[k] + j, rings[k] + j1, rings[k + 1] + j1, rings[k + 1] + j),
                           [(j / sides, va), ((j + 1) / sides, va), ((j + 1) / sides, vb), (j / sides, vb)], smooth=True)
        # lattice bracing panels around each leg (triangular truss look)
        if lod == 0:
            lt = b.mb['lattice']
            for k in range(len(pts) - 1):
                p0, p1 = pts[k], pts[k + 1]
                w0, w1 = rad[k] * 2.2, rad[k + 1] * 2.2
                for t_ang in (0, 120, 240):
                    ta = a + t_ang * DEG
                    off = V(math.cos(ta), math.sin(ta), 0)
                    side = V(-math.sin(ta), math.cos(ta), 0)
                    q0, q1 = p0 + off * rad[k] * 1.3, p1 + off * rad[k + 1] * 1.3
                    lt.quad(q0 - side * w0 / 2, q0 + side * w0 / 2, q1 + side * w1 / 2, q1 - side * w1 / 2,
                            uv=[(0, p0[2] / 12.0), (1, p0[2] / 12.0), (1, p1[2] / 12.0), (0, p1[2] / 12.0)])
        # antenna mast arrays above the top crossarm
        top = d * sutro_r(SUTRO_TOP)
        wm = b.mb['white']
        for zb, ze, rr in ((SUTRO_TOP - 30.0, SUTRO_TOP - 4.0, 1.4), (SUTRO_TOP - 4.0, SUTRO_TOP + 0.0, 0.5)):
            wm.cylinder(top + V(0, 0, zb), rr, ze - zb, sides=8)
        if b.meta:
            for p0, p1 in zip(pts[:-1], pts[1:]):
                b.meta.capsule(p0, p1, 3.2, 'Sutro Kulesi')
            b.meta.light(top + V(0, 0, SUTRO_TOP + 1.0), '#ff2a14', size=7.0, period=1.6, duty=0.5)
            b.meta.light(d * sutro_r(232.0) + V(0, 0, 234.0), '#ff2a14', size=5.0, period=1.6, duty=0.5)
            b.meta.light(d * sutro_r(140.0) + V(0, 0, 142.0), '#ff2a14', size=4.0, period=0)
        b.mb['warn'].cylinder(top + V(0, 0, SUTRO_TOP), 0.35, 0.8, sides=6)
    # crossarms: triangular trusses at 140 m (waist) and 232 m (top), plus a light one at 60 m
    for z, h, w in ((232.0, 7.0, 2.2), (140.0, 5.0, 1.8), (60.0, 3.0, 1.2)):
        corners = [V(math.cos(a * DEG), math.sin(a * DEG), 0) * sutro_r(z) + V(0, 0, z) for a in angles]
        for i in range(3):
            p0, p1 = corners[i], corners[(i + 1) % 3]
            if lod == 2:
                b.mb['white'].beam(p0, p1, w, h, caps=False)
                continue
            b.mb['white'].beam(p0 + V(0, 0, h / 2 - 0.5), p1 + V(0, 0, h / 2 - 0.5), w, 1.0)
            b.mb['white'].beam(p0 - V(0, 0, h / 2 - 0.5), p1 - V(0, 0, h / 2 - 0.5), w, 1.0)
            n = 8
            for k in range(n):
                a0, a1 = p0 + (p1 - p0) * (k / n), p0 + (p1 - p0) * ((k + 1) / n)
                b.mb['white'].beam(a0 - V(0, 0, h / 2 - 0.5), a1 + V(0, 0, h / 2 - 0.5), 0.4, 0.4) if k % 2 == 0 else \
                    b.mb['white'].beam(a0 + V(0, 0, h / 2 - 0.5), a1 - V(0, 0, h / 2 - 0.5), 0.4, 0.4)
            if b.meta:
                b.meta.capsule(p0, p1, h / 2 + 0.5, 'Sutro Kulesi')
    # concrete foundations at the three leg bases
    if lod < 2:
        for ang in angles:
            p = V(math.cos(ang * DEG), math.sin(ang * DEG), 0) * sutro_r(0.0)
            b.mb['concrete'].box(p - V(5, 5, 8), p + V(5, 5, 1.5), faces='xXyYZ')
    return b


# ================================================================================================ main
LANDMARKS = {
    'transamerica': lambda: export_landmark('transamerica', 'Transamerica Piramidi', build_transamerica, TAM_ORIGIN, TAM_HEADING,
                                            [(-26, -26), (26, -26), (26, 26), (-26, 26), (0, 0)], dists=(1800, 8000)),
    'salesforce': lambda: export_landmark('salesforce', 'Salesforce Kulesi', build_salesforce, SF_ORIGIN, SF_HEADING,
                                          [(-26, -26), (26, -26), (26, 26), (-26, 26), (0, 0)], dists=(1800, 9000)),
    'coit': lambda: export_landmark('coit_tower', 'Coit Kulesi', build_coit, COIT_ORIGIN, 0.0,
                                    [(-8, -8), (8, -8), (8, 8), (-8, 8), (0, 0)], dists=(1200, 6000)),
    'ferry': lambda: export_landmark('ferry_building', 'Ferry Building (İskele Binası)', build_ferry, FERRY_ORIGIN, FERRY_HEADING,
                                     [(-20, -90), (20, -90), (20, 90), (-20, 90), (0, 0)], dists=(1200, 6000)),
    'sutro': lambda: export_landmark('sutro_tower', 'Sutro Kulesi', build_sutro, SUTRO_C, SUTRO_HEADING,
                                     [(0, 0)], dists=(1800, 9000)),
}


def main():
    reset_scene()
    names = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else list(LANDMARKS)
    for n in names:
        LANDMARKS[n]()


if __name__ == '__main__':
    main()
