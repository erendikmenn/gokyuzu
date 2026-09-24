"""İstanbul monuments: towers, mosques, palaces, fortress, station, skyscrapers (parametric, OSM-placed).

Run:  blender -b -P blender/landmarks_ist/monuments.py [-- galata_kulesi kiz_kulesi camlica_kulesi camlica_camii sultanahmet
      ayasofya suleymaniye yeni_cami haydarpasa rumeli_hisari topkapi dolmabahce skyline_levent skyline_atasehir skyline_west]
Outputs: assets/ist/landmarks/<id>{,_lod1,_lod2}.glb + <id>.json.  Frames / footprints / minaret positions:
blender/landmarks_ist/layout.json (tools/geo/landmarks_ist_layout.py, OSM + Copernicus DEM).

Placement: single buildings use base 'terrain' (model z = 0 at the lowest ground under the footprint; foundations reach
below); multi-building sites (Topkapı, Dolmabahçe, Rumeli Hisarı walls, skyscraper groups) use base 'absolute' with design
ground heights from the DEM and per-building ground anchors (_ANCHOR), re-snapped to the loaded terrain at runtime.

Public figures (sources in CONTRACTS-IST.md §6.L): Galata Kulesi 62.59 m to the roof tip (66.9 with the finial), Ø16.45 m,
gallery 51.65 m, roof 10.94 m (OSM); Kız Kulesi tower ≈30 m on its islet (OSM parts 17 / 25 m + flagpole 33 m);
Çamlıca Kulesi 369 m (203.5 m concrete + 165.5 m antenna), observation 148.5–153 m, restaurants 175.5–180 m;
Çamlıca Camii dome Ø34 m / 72 m, minarets 4 × 107.1 m (3 şerefe) + 2 × 90 m; Sultanahmet dome Ø23.5 m / 43 m,
4 semi-domes with exedrae, 6 minarets (4 × 64 m / 3 şerefe, 2 × 54 m / 2 şerefe); Ayasofya dome Ø31 m / 55.6 m, 82 × 73 m,
4 minarets ≈60 m; Süleymaniye dome Ø26.5 m / 53 m, 2 semi-domes, minarets 2 × 76 m (3 şerefe) + 2 × 56 m (2 şerefe);
Yeni Cami dome Ø17.5 m / 36 m, 2 minarets 52 m (3 şerefe); Rumeli Hisarı towers Ø23.3 / 23.3 / 26.7 m, 28 / 22 / 21 m;
Dolmabahçe Saat Kulesi 27 m; skyscraper heights from OSM (İstanbul Sapphire 238 m roof + antenna to 261 m).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from istkit import (Build, export_landmark, LAYOUT, loft, ring, extrude, cone, dome, half_dome, minaret, mosque, alem,  # noqa: E402
                    gable_hip, obb, ccw, V, np, reset_scene, material, lin, mats, tx)

SITES = LAYOUT['sites']
SKY = LAYOUT.get('skyline', {})
DEG = math.pi / 180


def site(k):
    s = SITES[k]
    return s, (s['origin']['x'], s['origin']['z']), s['heading']


def circle_fp(r, n=8):
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)] + [(0.0, 0.0)]


def set_anchor(b, x, y, g):
    """Ground anchor (Three local: x, design ground, z) for the next vertices / collision primitives / lights."""
    a = (float(x), float(g), float(-y))
    for mb in b.mb.values():
        mb.anchor = a
    b._anchor = a
    if b.meta:
        b.meta.anchor = a


def anchored(b, key):
    """Mesh builder with the current anchor applied (created on demand)."""
    mb = b[key]
    mb.anchor = getattr(b, '_anchor', None)
    return mb


# ================================================================================================ Galata Kulesi
def build_galata(lod):
    b = Build('galata_kulesi', 'Galata Kulesi', lod)
    R = 8.23
    n = {0: 28, 1: 16, 2: 10}[lod]
    rb = b['rubble']
    # masonry shaft (slightly battered base)
    loft(rb, [ring(R + 0.5, n), ring(R, n), ring(R, n)], [-6.0, 6.0, 44.0], ts_u=4, ts_v=4, smooth=lod < 2)
    # upper storey with arched windows (restaurant / museum floors under the gallery)
    loft(b['wall'], [ring(R, n), ring(R, n)], [44.0, 50.8], u_turns=16 if lod < 2 else 8, ts_v=6.8, v0=44.0, smooth=lod < 2)
    if lod < 2:
        # corbelled cornice + gallery floor + parapet
        loft(b['stone_plain'], [ring(R, n), ring(R + 1.25, n)], [50.8, 51.65], 4, 4)
        b['stone_plain'].cylinder((0, 0, 51.4), R + 1.25, 0.25, sides=n, cap_top=True)
        loft(b['stone_plain'], [ring(R + 1.25, n), ring(R + 1.25, n)], [51.65, 52.75], 3, 1.2)
        loft(b['stone_plain'], [ring(R + 1.1, n), ring(R + 1.1, n)], [52.75, 51.65], 3, 1.2)
        # glazed wall of the top floor behind the gallery (the roof springs from it)
        loft(b['dark'], [ring(R - 0.6, n), ring(R - 0.6, n)], [51.65, 53.6], 4, 4)
    else:
        b['stone_plain'].cylinder((0, 0, 50.8), R + 1.1, 1.8, sides=n, cap_top=True)
    # conical roof (lead) + finial
    cone(b['lead'], (0, 0, 53.4 if lod < 2 else 52.6), R - 0.2, 62.59 - (53.4 if lod < 2 else 52.6), n=n, u_turns=4)
    if lod < 2:
        alem(b, 0, 0, 62.4, h=4.3, r=0.22)
    b.cbox((-R - 0.5, -R - 0.5, -6.0), (R + 0.5, R + 0.5, 50.8))
    b.cbox((-R - 1.3, -R - 1.3, 50.8), (R + 1.3, R + 1.3, 56.0))
    b.ccap((0, 0, 56.0), (0, 0, 62.6), 5.0, solid=True)
    b.ccap((0, 0, 62.6), (0, 0, 66.9), 0.6, solid=True)
    b.light((0, 0, 67.2), '#ff2a14', size=3.0, period=0)
    return b


# ================================================================================================ Kız Kulesi
def build_kiz(lod):
    s, o, h = site('kiz_kulesi')
    b = Build('kiz_kulesi', 'Kız Kulesi', lod)
    isl = s['islet']
    if isl:
        extrude(b['stone_plain'], [tuple(p) for p in isl], -3.0, 1.6, 4, 4, top=True)
        if b.meta:
            x0, y0 = np.min(np.array(isl), axis=0)
            x1, y1 = np.max(np.array(isl), axis=0)
            b.cbox((x0, y0, -3.0), (x1, y1, 1.6))
    for bl in s['buildings']:
        P = [tuple(p) for p in bl['poly']]
        H = bl['height'] or 6.0
        if bl['id'] in ('w398219280', 'w398210643'):
            continue                      # the tower is built below
        z1 = 1.6 + max(3.0, H - 3.5)
        extrude(b['white'], P, 1.0, z1, 4, 4, top=False)
        cx, cy, ang, hl, hs = obb(P)
        gable_hip(b['lead'], cx, cy, ang, hl + 0.3, hs + 0.3, z1, min(3.2, hs * 0.7))
        b.cbox((cx - hl, cy - hs, 1.0), (cx + hl, cy + hs, z1 + 3.0), yaw=ang)
    # tower: square shaft (OSM part 17 m) -> octagonal drum with windows -> lead dome -> lantern -> flagpole
    a = 3.2
    n = 8 if lod < 2 else 6
    extrude(b['white'], [(-a, -a), (a, -a), (a, a), (-a, a)], 0.0, 17.0, 4, 4, top=True)
    if lod < 2:
        b['stone_plain'].box((-a - 0.35, -a - 0.35, 16.6), (a + 0.35, a + 0.35, 17.2))
    loft(b['drum'], [ring(2.9, n, math.pi / n), ring(2.9, n, math.pi / n)], [17.0, 22.5], u_turns=n, ts_v=5.5, v0=17.0)
    dome(b['lead'], (0, 0, 22.5), 3.1, 3.6, seg=n * 2 if lod < 2 else n, rings_n=3 if lod < 2 else 2)
    if lod < 2:
        loft(b['white'], [ring(0.9, 8), ring(0.9, 8)], [25.8, 27.6], 2, 2)
        cone(b['lead'], (0, 0, 27.6), 1.1, 1.6, n=8)
        b['paint'].cylinder((0, 0, 29.0), 0.08, 4.0, sides=4)
    b.cbox((-a, -a, 0.0), (a, a, 22.5))
    b.ccap((0, 0, 22.5), (0, 0, 29.2), 3.0, solid=True)
    b.ccap((0, 0, 29.2), (0, 0, 33.0), 0.3, solid=True)
    b.light((0, 0, 27.0), '#fff4d6', size=3.0, period=3.0, duty=0.3, kind='nav')
    return b


# ================================================================================================ Çamlıca Kulesi
TV_PROFILE = [(-8, 12.5), (0, 12.5), (12, 10.5), (40, 8.2), (95, 7.2), (118, 7.6), (132, 10.5), (146, 16.0), (158, 18.6),
              (170, 19.2), (182, 17.8), (192, 14.0), (199, 9.0), (203.5, 5.0)]


def build_camlica_tv(lod):
    b = Build('camlica_kulesi', 'Çamlıca Kulesi', lod)
    n = {0: 28, 1: 16, 2: 10}[lod]
    prof = TV_PROFILE if lod < 2 else TV_PROFILE[::2] + [TV_PROFILE[-1]]
    # four soft lobes in plan (the "tulip" leaves): radius modulation 1 + 0.07 cos 4θ above the neck
    rings, zs = [], []
    for z, r in prof:
        k = 0.07 if z > 120 else 0.0
        rings.append([(r * (1 + k * math.cos(4 * t)) * math.cos(t), r * (1 + k * math.cos(4 * t)) * math.sin(t))
                      for t in np.linspace(0, 2 * math.pi, n + 1)[:-1]])
        zs.append(z)
    loft(b['white'], rings, zs, ts_u=6, ts_v=6, smooth=lod < 2, cap_top=True)
    # glazed observation / restaurant bands
    if lod < 2:
        for z0, z1 in ((148.5, 153.0), (175.5, 180.0)):
            r0 = float(np.interp(z0, [p[0] for p in TV_PROFILE], [p[1] for p in TV_PROFILE])) + 0.25
            r1 = float(np.interp(z1, [p[0] for p in TV_PROFILE], [p[1] for p in TV_PROFILE])) + 0.25
            loft(b['glass'], [ring(r0 * 1.02, n), ring(r1 * 1.02, n)], [z0, z1], ts_u=12, ts_v=16)
    # antenna mast: 165.5 m steel, tapering, with platforms
    segs = [(203.5, 2.6), (260.0, 1.9), (310.0, 1.2), (350.0, 0.6), (369.0, 0.25)]
    for (za, ra), (zb, rbb) in zip(segs[:-1], segs[1:]):
        b['paint'].cylinder((0, 0, za), ra, zb - za, sides=8 if lod == 0 else 6, r_top=rbb, cap_top=zb == 369.0)
        if lod == 0:
            b['paint'].cylinder((0, 0, za - 0.6), ra + 0.9, 1.2, sides=8, cap_top=True, cap_bottom=True)
    # red / white aviation bands on the upper mast
    if lod < 2:
        for k in range(4):
            z = 320 + 12 * k
            r = float(np.interp(z, [p[0] for p in segs], [p[1] for p in segs])) + 0.05
            b['red'].cylinder((0, 0, z), r, 6.0, sides=8, r_top=r * 0.95, cap_top=False)
    # collision: stacked capsules (grounded)
    for (za, ra), (zb, rbb) in zip(TV_PROFILE[1:-1], TV_PROFILE[2:]):
        b.ccap((0, 0, za), (0, 0, zb), max(ra, rbb) * 1.07, solid=True)
    b.ccap((0, 0, 203.5), (0, 0, 369.0), 3.0, solid=True)
    for z in (369.5, 330.0, 290.0, 250.0, 204.5):
        for ang in ((0.0,) if z > 360 else (0.0, math.pi)):
            r = 0.0 if z > 360 else 3.0
            b.light((r * math.cos(ang), r * math.sin(ang), z), '#ff2a14', size=7.0 if z > 360 else 5.0, period=1.5 if z > 300 else 0,
                    phase=0.0)
    return b


# ================================================================================================ mosques
def minaret_specs(s, r_tall=2.3, r_short=2.1):
    out = []
    Hmax = max(m[2] for m in s['minarets'])
    for x, y, H, sh in s['minarets']:
        out.append([x, y, H, sh, r_tall if H >= Hmax - 1 else r_short])
    return out


def spec_camlica():
    s, o, h = site('camlica_camii')
    M = minaret_specs(s, 2.6, 2.4)
    tall = [m for m in M if m[2] > 100]
    short = [m for m in M if m[2] < 100]
    hx = np.mean([abs(m[0]) for m in tall]) - 3.5
    hy = np.mean([abs(m[1]) for m in tall]) - 3.5
    cy_far = np.mean([m[1] for m in short])
    cw = abs(short[0][0] - short[1][0]) + 6
    court_near = -hy
    court_far = cy_far - 2.5
    return s, o, h, {
        'hall': [2 * hx, 2 * hy, 30.0, 0.0], 'dome': [34.0, 46.0, 8.5, 72.0], 'semis': ['+y', '-y', '+x', '-x'],
        'exedrae': {'+y': 3, '+x': 2, '-x': 2}, 'turrets': True, 'turret_r': 3.2,
        'corner_domes': [[sx * (hx - 9), sy * (hy - 9), 12.0, 30.5] for sx in (-1, 1) for sy in (-1, 1)],
        'court': [cw, abs(court_near - court_far), (court_near + court_far) / 2, 10.0, 7, 5],
        'minarets': M,
    }


def spec_sultanahmet():
    s, o, h = site('sultanahmet')
    M = minaret_specs(s, 2.05, 1.9)
    tall = [m for m in M if m[2] > 60]
    short = [m for m in M if m[2] < 60]
    hx = np.mean([abs(m[0]) for m in tall]) - 2.6
    hy = np.mean([abs(m[1]) for m in tall]) - 2.6
    cy_far = np.mean([m[1] for m in short]) - 1.5
    cw = abs(short[0][0] - short[1][0]) + 3
    return s, o, h, {
        'hall': [2 * hx, 2 * hy, 24.0, 0.0], 'dome': [23.5, 31.0, 5.5, 45.0], 'semis': ['+y', '-y', '+x', '-x'],
        'exedrae': {'+y': 3, '+x': 3, '-x': 3, '-y': 2}, 'turrets': True, 'turret_r': 2.6,
        'corner_domes': [[sx * (hx - 7), sy * (hy - 7), 9.0, 24.5] for sx in (-1, 1) for sy in (-1, 1)],
        'court': [cw, abs(-hy - cy_far), (-hy + cy_far) / 2, 9.0, 6, 5],
        'side_galleries': [[-hx - 7, -hx, -hy + 4, hy - 4, 9.0, 6], [hx, hx + 7, -hy + 4, hy - 4, 9.0, 6]],
        'minarets': M,
    }


def spec_suleymaniye():
    s, o, h = site('suleymaniye')
    M = minaret_specs(s, 2.1, 1.9)
    tall = [m for m in M if m[2] > 70]
    short = [m for m in M if m[2] < 70]
    # the four minarets stand at the courtyard corners; the prayer hall (58 × 58 m) is on the qibla side of it
    c_near = np.mean([m[1] for m in tall])
    c_far = np.mean([m[1] for m in short])
    cw = abs(tall[0][0] - tall[1][0]) - 3
    hall_d = 58.0
    hall_cy = c_near + 1.5 + hall_d / 2
    return s, o, h, {
        'hall': [58.0, hall_d, 26.0, hall_cy - 0.0 * hall_cy], 'dome': [27.0, 37.0, 5.5, 53.0], 'semis': ['+y', '-y'],
        'exedrae': {'+y': 2, '-y': 2}, 'turrets': True, 'turret_r': 2.4,
        'corner_domes': [[sx * 20.0, sy * 20.0, 10.0, 26.5] for sx in (-1, 1) for sy in (-1, 1)],
        'court': [cw, abs(c_near - c_far) - 1.0, (c_near + c_far) / 2, 9.0, 5, 6],
        'side_galleries': [[-37.0, -29.0, -26.0, 26.0, 10.0, 5], [29.0, 37.0, -26.0, 26.0, 10.0, 5]],
        'minarets': M,
    }


def spec_yeni_cami():
    s, o, h = site('yeni_cami')
    L, Wd = s['length'], s['width']
    hall = 41.0
    court_far = -(L - 26.0) + 1.0
    return s, o, h, {
        'hall': [min(Wd, 42.0), hall, 20.0, 26.0 - hall / 2 - 0.5], 'dome': [17.5, 25.0, 3.5, 36.0],
        'semis': ['+y', '-y', '+x', '-x'], 'exedrae': {'+y': 2}, 'turrets': True, 'turret_r': 1.8,
        'corner_domes': [[sx * 14.0, 26.0 - hall / 2 + sy * 14.0, 7.0, 20.5] for sx in (-1, 1) for sy in (-1, 1)],
        'court': [min(Wd, 40.0), abs(court_far - (26.0 - hall)), (court_far + 26.0 - hall) / 2, 8.0, 5, 4],
        'minarets': [[sx * (min(Wd, 40.0) / 2 - 1.5), 26.0 - hall - 1.5, 52.0, 3, 1.7] for sx in (-1, 1)],
    }


def build_mosque(lid, name, spec_fn):
    def fn(lod):
        s, o, h, spec = spec_fn()
        b = Build(lid, name, lod)
        mosque(b, spec)
        return b
    return fn


def export_mosque(lid, name, spec_fn, dists=(2200, 9000)):
    s, o, h, spec = spec_fn()
    w, d, hh, cy = spec['hall']
    fp = [(-w / 2, cy - d / 2), (w / 2, cy - d / 2), (w / 2, cy + d / 2), (-w / 2, cy + d / 2), (0.0, 0.0)]
    export_landmark(lid, name, build_mosque(lid, name, spec_fn), o, h, base='terrain', footprint=fp, dists=dists)


# ---- Ayasofya (Hagia Sophia): ochre plaster, shallow ribbed dome on a low windowed drum, two great semi-domes along the
# axis, exedrae, apse, massive north / south buttresses, four minarets of different styles
def build_ayasofya(lod):
    s, o, h = site('ayasofya')
    b = Build('ayasofya', 'Ayasofya-i Kebir Camii', lod)
    Oc = b['ochre']
    L = b['lead']
    out = [tuple(p) for p in s['outline']]
    extrude(Oc, out, -4.0, 14.0, 6, 6, top=False)
    L.polygon([(p[0], p[1], 14.0) for p in ccw(out)])
    b.cbox(tuple(np.min(np.array(out), axis=0)) + (-4.0,), tuple(np.max(np.array(out), axis=0)) + (14.5,))
    # main block (nave) 70 × 75 m to 26 m, central square to the dome springing
    seg = {0: 40, 1: 20, 2: 12}[lod]
    extrude(Oc, [(-33, -38), (33, -38), (33, 38), (-33, 38)], 14.0, 22.0, 6, 6, top=False)
    L.polygon([(-33, -38, 22.0), (33, -38, 22.0), (33, 38, 22.0), (-33, 38, 22.0)])
    b.cbox((-33, -38, 14.0), (33, 38, 22.5))
    R = 15.6
    extrude(Oc, [(-R - 1, -R - 1), (R + 1, -R - 1), (R + 1, R + 1), (-R - 1, R + 1)], 22.0, 40.5, 5, 5, top=False)
    L.polygon([(-R - 1, -R - 1, 40.5), (R + 1, -R - 1, 40.5), (R + 1, R + 1, 40.5), (-R - 1, R + 1, 40.5)])
    # north / south buttress towers (4 massive piers)
    for sx in (-1, 1):
        for sy in (-1, 1):
            x0, x1 = sorted((sx * (R + 1), sx * (R + 9)))
            y0, y1 = sorted((sy * 6.0, sy * 17.0))
            extrude(Oc, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], 20.0, 36.0, 5, 5, top=False)
            L.polygon([(x0, y0, 36.0), (x1, y0, 36.0), (x1, y1, 36.0), (x0, y1, 36.0)])
            b.cbox((x0, y0, 20.0), (x1, y1, 36.5))
    # drum with 40 windows (low) + shallow ribbed dome
    loft(b['drum'], [ring(R, seg), ring(R, seg)], [40.5, 43.0], u_turns=40 if lod < 2 else 20, ts_v=2.5, v0=40.5)
    if lod == 0:
        for k in range(40):
            t = 2 * math.pi * (k + 0.5) / 40
            p = V(math.cos(t), math.sin(t), 0) * (R + 0.5)
            Oc.obox(p + V(0, 0, 41.8), V(math.cos(t), math.sin(t), 0), V(-math.sin(t), math.cos(t), 0), V(0, 0, 1), 0.7, 0.5, 1.3)
    dome(L, (0, 0, 43.0), R + 0.3, 55.6 - 43.0, seg=seg, rings_n={0: 6, 1: 4, 2: 3}[lod], ribs=40 if lod == 0 else None)
    alem(b, 0, 0, 55.4, h=3.5, r=0.3)
    b.cbox((-R - 1, -R - 1, 26.0), (R + 1, R + 1, 55.8))
    # two great semi-domes along the axis, with exedrae; the apse beyond the eastern one
    for sgn in (1, -1):
        a = math.pi / 2 if sgn > 0 else -math.pi / 2
        c = V(0, sgn * (R + 1), 27.0)
        half_dome(L, c, R + 0.5, 14.5, a, seg=seg // 2, rings_n=3 if lod < 2 else 2)
        b.cbox((-R, min(c[1], c[1] + sgn * R), 22.0), (R, max(c[1], c[1] + sgn * R), 41.5))
        if lod < 2:
            for t in (-0.9, 0.9):
                cc = c + V(math.sin(t) * R * 0.78, sgn * math.cos(t) * R * 0.55, -5.0)
                half_dome(L, cc, 6.0, 5.5, a + (t if sgn > 0 else -t), seg=6, rings_n=2)
    if lod < 2:
        half_dome(L, V(0, R + 1 + R * 0.95, 20.0), 6.5, 6.5, math.pi / 2, seg=6, rings_n=2)
    # minarets (the two western Sinan minarets are taller; the south-eastern one is brick red)
    for x, y, H, sh in s['minarets']:
        red = y > 0 and x > 0
        minaret(b, x, y, 0.0, H, r=1.9 if H >= 60 else 1.7, sherefe=2 if H >= 60 else 1, stone='red' if red else 'stone_plain')
    return b


# ================================================================================================ Haydarpaşa Garı
def build_haydarpasa(lod):
    s, o, h = site('haydarpasa')
    b = Build('haydarpasa', 'Haydarpaşa Garı', lod)
    P = [tuple(p) for p in s['outline']]
    H = 24.0
    extrude(b['wall'], P, -4.0, H, 6, 6, top=False, v0=0.0)
    if lod < 2:
        extrude(b['sand'], P, H - 1.2, H, 4, 4, top=False)
    cx, cy, ang, hl, hs = obb(P)
    gable_hip(b['slate'], cx, cy, ang, hl + 0.5, hs + 0.5, H, min(9.0, hs * 0.55))
    b.cbox((cx - hl, cy - hs, -4.0), (cx + hl, cy + hs, H + 9.0), yaw=ang)
    # two round corner turrets with steep conical slate roofs at the ends of the long (sea) facade
    u = V(math.cos(ang), math.sin(ang), 0)
    w = V(-math.sin(ang), math.cos(ang), 0)
    # sea side: the long side whose outward normal points most to the west (model frame = world axes rotated by heading)
    hdg = s['heading']
    west = V(-math.cos(hdg), -math.sin(hdg), 0)          # world -x expressed in the model frame (X axis = (cos h, sin h))
    side = 1.0 if float(np.dot(w, west)) > 0 else -1.0
    n = 12 if lod < 2 else 8
    for sgn in (-1, 1):
        c = V(cx, cy, 0) + u * (sgn * (hl - 3.0)) + w * (side * (hs - 3.0))
        loft(b['sand'], [ring(5.2, n, c=(c[0], c[1])), ring(5.2, n, c=(c[0], c[1]))], [-2.0, 32.0], 4, 4)
        cone(b['slate'], (c[0], c[1], 32.0), 5.8, 11.0, n=n, u_turns=4)
        if lod < 2:
            alem(b, c[0], c[1], 42.8, h=2.0, r=0.12)
        b.ccap((c[0], c[1], -2.0), (c[0], c[1], 43.0), 5.8, solid=True)
    return b


# ================================================================================================ Rumeli Hisarı
RH_TOWERS_BUILT = {}


def build_rumeli(lod):
    s, o, h = site('rumeli_hisari')
    b = Build('rumeli_hisari', 'Rumeli Hisarı', lod)
    wall = s['wall']
    step = {0: 1, 1: 3, 2: 6}[lod]
    pts = wall[::step]
    if pts[-1] != wall[-1]:
        pts.append(wall[-1])
    Hw = 11.0
    for (xa, ya, ga), (xb, yb, gb) in zip(pts[:-1], pts[1:]):
        L = math.hypot(xb - xa, yb - ya)
        if L < 0.3:
            continue
        mx, my, g = (xa + xb) / 2, (ya + yb) / 2, min(ga, gb)
        set_anchor(b, mx, my, g)
        d = V(xb - xa, yb - ya, 0) / L
        mb = anchored(b, 'rubble')
        # wall slab: box along the segment from below ground to the wall top
        c = V(mx, my, (g - 4.0 + g + Hw) / 2)
        mb.obox(c, d, V(-d[1], d[0], 0), V(0, 0, 1), L / 2 + 0.6, 1.5, (Hw + 4.0) / 2, ts=4.0, faces='yYxXZ')
        if lod == 0 and L > 2.5:
            # merlons
            k = int(L // 2.2)
            for i in range(k):
                t = (i + 0.5) / k
                p = V(xa, ya, 0) * (1 - t) + V(xb, yb, 0) * t
                mb.obox(V(p[0], p[1], g + Hw + 0.7), d, V(-d[1], d[0], 0), V(0, 0, 1), 0.55, 1.2, 0.7, ts=4.0, faces='yYxXZ')
        if b.meta:
            yaw = math.atan2(d[1], d[0])
            b.meta.box((mx - L / 2 - 0.6, my - 1.5, g - 4.0), (mx + L / 2 + 0.6, my + 1.5, g + Hw + 1.4), b.name, yaw)
    n = {0: 20, 1: 12, 2: 8}[lod]
    for t in s['towers']:
        x, y, r, H, g = t['x'], t['y'], t['r'], t['h'], t['g']
        set_anchor(b, x, y, g)
        nn = 12 if t['shape'] == 'poly12' else n
        loft(anchored(b, 'rubble'), [ring(r + 0.6, nn, c=(x, y)), ring(r, nn, c=(x, y)), ring(r, nn, c=(x, y))],
             [g - 6.0, g + 3.0, g + H], 4, 4, smooth=t['shape'] != 'poly12' and lod < 2)
        if lod == 0:
            for i in range(nn * 2):
                a = 2 * math.pi * (i + 0.5) / (nn * 2)
                p = V(x + (r - 0.5) * math.cos(a), y + (r - 0.5) * math.sin(a), g + H + 0.7)
                anchored(b, 'rubble').obox(p, V(math.cos(a), math.sin(a), 0), V(-math.sin(a), math.cos(a), 0), V(0, 0, 1), 0.6, 0.8, 0.7,
                                           faces='yYxXZ')
        if t['name'] != 'Zağanos Paşa':
            cone(anchored(b, 'lead'), (x, y, g + H), r - 0.8, r * 0.95, n=nn, u_turns=6)
            top = g + H + r * 0.95
        else:
            anchored(b, 'stone_plain').polygon([(px, py, g + H - 0.4) for px, py in ring(r - 0.8, nn, c=(x, y))])
            top = g + H + 1.4
        if b.meta:
            b.meta.capsule((x, y, g - 6.0), (x, y, top), r, b.name, True)
    return b


# ================================================================================================ palace sites (Topkapı, Dolmabahçe)
def palace_building(b, bl, H, wall='white', roof='lead', roof_h=None, dome_d=None, dome_h=None):
    P = [tuple(p) for p in bl['poly']]
    g = bl['g']
    cx, cy, ang, hl, hs = obb(P)
    set_anchor(b, cx, cy, g)
    extrude(anchored(b, wall), P, g - 4.0, g + H, 6, 6, top=False, v0=g)
    rh = roof_h if roof_h is not None else min(5.0, hs * 0.45)
    if rh > 0.2 and hl < 60:
        gable_hip(anchored(b, roof), cx, cy, ang, hl + 0.4, hs + 0.4, g + H, rh)
        anchored(b, roof).polygon([(p[0], p[1], g + H - 0.05) for p in ccw(P)])
    else:
        anchored(b, roof).polygon([(p[0], p[1], g + H) for p in ccw(P)])
    if dome_d:
        dome(anchored(b, 'lead'), (cx, cy, g + H + rh * 0.4), dome_d / 2, dome_h or dome_d * 0.35, seg=16 if b.lod == 0 else 10, rings_n=3)
    if b.meta:
        b.meta.box((cx - hl, cy - hs, g - 4.0), (cx + hl, cy + hs, g + H + rh + (dome_h or 0)), b.name, ang)
    return cx, cy, ang, hl, hs, g


def tower_spire(b, x, y, g, shaft_w, shaft_h, top_h, spire_h, mat='white'):
    """Square stone tower with a windowed top storey and a lead spire (Adalet Kulesi, Saat Kulesi-like)."""
    a = shaft_w / 2
    extrude(anchored(b, mat), [(x - a, y - a), (x + a, y - a), (x + a, y + a), (x - a, y + a)], g - 3.0, g + shaft_h, 4, 4, top=False)
    extrude(anchored(b, 'drum'), [(x - a + 0.3, y - a + 0.3), (x + a - 0.3, y - a + 0.3), (x + a - 0.3, y + a - 0.3), (x - a + 0.3, y + a - 0.3)],
            g + shaft_h, g + shaft_h + top_h, 3, top_h, top=False, v0=g + shaft_h)
    cone(anchored(b, 'lead'), (x, y, g + shaft_h + top_h), a * 1.25, spire_h, n=8, u_turns=4)
    if b.lod < 2:
        alem(b, x, y, g + shaft_h + top_h + spire_h - 0.2, h=2.5, r=0.12)
    top = g + shaft_h + top_h + spire_h
    b.ccap((x, y, g - 3.0), (x, y, top), a * 1.3, solid=True)
    return top


def build_topkapi(lod):
    s, o, h = site('topkapi')
    b = Build('topkapi', 'Topkapı Sarayı', lod)
    for bl in s['buildings']:
        nm = bl['name']
        if bl['id'] == s['adalet']:
            cx, cy = np.mean(np.array(bl['poly']), axis=0)
            set_anchor(b, cx, cy, bl['g'])
            top = tower_spire(b, cx, cy, bl['g'], 7.5, 28.0, 6.0, 9.0)
            b.light((cx, cy, top + 0.5), '#ff2a14', size=3.0, period=0)
            continue
        if bl['id'] == s['babusselam']:
            cx, cy, ang, hl, hs, g = palace_building(b, bl, 11.0, roof_h=3.0)
            u = V(math.cos(ang), math.sin(ang), 0)
            w = V(-math.sin(ang), math.cos(ang), 0)
            # the two octagonal gate towers with pointed lead caps, on the outer side of the gate building
            for sgn in (-1, 1):
                c = V(cx, cy, 0) + u * (sgn * min(hl - 3.0, 9.0)) + w * (-hs + 3.0)
                loft(anchored(b, 'white'), [ring(3.6, 8, c=(c[0], c[1]))] * 2, [g - 2.0, g + 15.0], 3, 3)
                cone(anchored(b, 'lead'), (c[0], c[1], g + 15.0), 4.0, 9.0, n=8, u_turns=4)
                b.ccap((c[0], c[1], g - 2.0), (c[0], c[1], g + 24.0), 4.0, solid=True)
            continue
        if bl['id'] == s['kitchens']:
            cx, cy, ang, hl, hs, g = palace_building(b, bl, 9.0, roof_h=0.0)
            u = V(math.cos(ang), math.sin(ang), 0)
            n = 10 if lod < 2 else 5
            for k in range(n):
                p = V(cx, cy, 0) + u * (-hl + (k + 0.5) * 2 * hl / n)
                dome(anchored(b, 'lead'), (p[0], p[1], g + 9.0), min(hs, 2 * hl / n) * 0.42, 3.0, seg=10 if lod == 0 else 6, rings_n=2)
                if lod < 2:
                    anchored(b, 'white').box((p[0] - 0.8, p[1] - 0.8, g + 11.5), (p[0] + 0.8, p[1] + 0.8, g + 16.5))
            continue
        H = bl['height'] or (bl['levels'] * 4.5 if bl['levels'] else (13.0 if 'Harem' in nm else 9.0))
        dome_d = None
        if bl['kind'] == 'mosque' or 'Köşk' in nm or 'Arz' in nm or 'Kütüphane' in nm:
            dome_d = 7.0 if 'Köşk' in nm or 'Arz' in nm else 9.0
        palace_building(b, bl, H, dome_d=dome_d)
    # palace wall along the outline (low, anchored per segment)
    W = s['walls']
    G = s['wall_g']
    stepw = {0: 1, 1: 2, 2: 4}[lod]
    pts = [(W[i][0], W[i][1], G[i]) for i in range(0, len(G), stepw)] + [(W[0][0], W[0][1], G[0])]
    for (xa, ya, ga), (xb, yb, gb) in zip(pts[:-1], pts[1:]):
        L = math.hypot(xb - xa, yb - ya)
        if L < 0.5:
            continue
        g = min(ga, gb)
        mx, my = (xa + xb) / 2, (ya + yb) / 2
        set_anchor(b, mx, my, g)
        d = V(xb - xa, yb - ya, 0) / L
        anchored(b, 'rubble').obox(V(mx, my, g + 2.5), d, V(-d[1], d[0], 0), V(0, 0, 1), L / 2 + 0.5, 0.9, 6.5, ts=4.0, faces='yYxXZ')
        if b.meta:
            b.meta.box((mx - L / 2, my - 1.0, g - 4.0), (mx + L / 2, my + 1.0, g + 9.0), b.name, math.atan2(d[1], d[0]))
    return b


def build_dolmabahce(lod):
    s, o, h = site('dolmabahce')
    b = Build('dolmabahce', 'Dolmabahçe Sarayı', lod)
    for bl in s['buildings']:
        nm = bl['name']
        if bl['id'] == s['clock']:
            cx, cy = np.mean(np.array(bl['poly']), axis=0)
            set_anchor(b, cx, cy, bl['g'])
            a = 4.25
            extrude(anchored(b, 'white'), [(cx - 6, cy - 6), (cx + 6, cy - 6), (cx + 6, cy + 6), (cx - 6, cy + 6)], bl['g'] - 2, bl['g'] + 2.0, 4, 4)
            for k, (z0, z1, aa) in enumerate(((2.0, 12.0, a), (12.0, 19.0, a * 0.9), (19.0, 23.5, a * 0.8))):
                extrude(anchored(b, 'palace' if k == 1 else 'white'), [(cx - aa, cy - aa), (cx + aa, cy - aa), (cx + aa, cy + aa), (cx - aa, cy + aa)],
                        bl['g'] + z0, bl['g'] + z1, 4, 4 if k != 1 else 7.0, top=True, v0=bl['g'] + z0)
            dome(anchored(b, 'lead'), (cx, cy, bl['g'] + 23.5), a * 0.75, 3.5, seg=8, rings_n=2)
            if lod < 2:
                alem(b, cx, cy, bl['g'] + 26.8, h=1.5, r=0.1)
            b.ccap((cx, cy, bl['g'] - 2.0), (cx, cy, bl['g'] + 27.5), 5.5, solid=True)
            continue
        if bl['id'] == s['muayede']:
            cx, cy, ang, hl, hs, g = palace_building(b, bl, 26.0, wall='palace', roof_h=2.0)
            # the ceremonial hall's great dome (crown ≈ 36 m) rising over the roof
            dome(anchored(b, 'lead'), (cx, cy, g + 27.0), 17.0, 9.5, seg=24 if lod == 0 else 12, rings_n=4 if lod == 0 else 2)
            if lod < 2:
                loft(anchored(b, 'palace'), [ring(17.2, 24 if lod == 0 else 12, c=(cx, cy))] * 2, [g + 25.0, g + 27.0], 4, 2.0, v0=g + 25.0)
            b.ccap((cx, cy, g + 26.0), (cx, cy, g + 36.5), 17.0)
            continue
        if 'Selamlık' in nm:
            H = 22.0
        elif 'Harem' in nm:
            H = 19.0
        elif 'Resim' in nm:
            H = 18.0
        elif 'Kapı' in nm:
            H = 14.0
        else:
            H = bl['height'] or (bl['levels'] * 5.0 if bl['levels'] else 10.0)
        palace_building(b, bl, H, wall='palace' if H >= 14 else 'white', roof_h=min(3.0, H * 0.15))
    return b


# ================================================================================================ skyscrapers
def build_skyline(key):
    s = SKY[key]

    def fn(lod):
        b = Build(key, s['name'], lod)
        for i, bl in enumerate(s['buildings']):
            P = [tuple(p) for p in bl['poly']]
            H = float(bl['height'])
            g = bl['g']
            cx, cy, ang, hl, hs = obb(P)
            set_anchor(b, cx, cy, g)
            if bl.get('tv'):
                # TV tower (Endem): slim concrete shaft, pod, antenna
                r0 = max(4.0, min(hs, 9.0))
                loft(anchored(b, 'white'), [ring(r0, 12, c=(cx, cy)), ring(r0 * 0.6, 12, c=(cx, cy))], [g - 4, g + H * 0.62], 6, 6)
                loft(anchored(b, 'white'), [ring(r0 * 0.6, 12, c=(cx, cy)), ring(r0 * 1.7, 12, c=(cx, cy)), ring(r0 * 1.7, 12, c=(cx, cy)),
                                            ring(r0 * 0.5, 12, c=(cx, cy))], [g + H * 0.62, g + H * 0.66, g + H * 0.72, g + H * 0.75], 6, 6, cap_top=True)
                anchored(b, 'paint').cylinder((cx, cy, g + H * 0.75), 1.4, H * 0.25, sides=6, r_top=0.3, cap_top=True)
                b.ccap((cx, cy, g - 4), (cx, cy, g + H * 0.75), r0 * 1.7, solid=True)
                b.ccap((cx, cy, g + H * 0.75), (cx, cy, g + H), 1.5, solid=True)
                b.light((cx, cy, g + H + 0.5), '#ff2a14', size=6.0, period=1.5)
                continue
            glass = 'glass' if i % 2 == 0 else 'glass2'
            simplified = P if lod < 2 or len(P) <= 6 else None
            if simplified is None:
                u = V(math.cos(ang), math.sin(ang), 0)
                w = V(-math.sin(ang), math.cos(ang), 0)
                c = V(cx, cy, 0)
                simplified = [tuple((c + u * (sx * hl) + w * (sy * hs))[:2]) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            extrude(anchored(b, glass), simplified, g - 5.0, g + H, ts_u=12.0, ts_v=14.4, top=False, v0=g)
            anchored(b, 'concrete').polygon([(p[0], p[1], g + H) for p in ccw(simplified)])
            if lod < 2:
                # roof crown / plant storey
                sh = [(cx + (p[0] - cx) * 0.8, cy + (p[1] - cy) * 0.8) for p in simplified]
                extrude(anchored(b, 'concrete'), sh, g + H, g + H + min(6.0, H * 0.03), 4, 4, top=True)
            top = g + H + min(6.0, H * 0.03)
            if 'Sapphire' in bl['name']:
                anchored(b, 'paint').cylinder((cx, cy, top), 0.9, 261.0 - (H + min(6.0, H * 0.03)), sides=6, r_top=0.25, cap_top=True)
                top = g + 261.0
                b.ccap((cx, cy, g + H), (cx, cy, top), 1.2, solid=True)
            if b.meta:
                b.meta.box((cx - hl, cy - hs, g - 5.0), (cx + hl, cy + hs, g + H + min(6.0, H * 0.03)), b.name, ang)
            b.light((cx, cy, top + 1.0), '#ff2a14', size=6.0, period=1.5 if H > 200 else 0, phase=(i * 0.37) % 1)
        return b
    export_landmark(key, s['name'], fn, (s['origin']['x'], s['origin']['z']), 0.0, base='absolute', dists=(3500, 16000),
                    extra={'anchored': True})


# ================================================================================================ extra materials
def palace_mats():
    """White palace facade with tall windows (Dolmabahçe) added to the shared sets."""
    for lod in (0, 1, 2):
        M = mats(lod)
        if 'palace' in M:
            continue
        if lod == 2:
            M['palace'] = material(f'ist{lod}_palace_emit', color=lin('#E9E4D8'), rough=0.8, emissive=lin('#FFE2B8'), emissive_strength=0.2)
            continue
        a, o_, n_, e = tx.window_facade(f'ist_palace{lod}', size=512 if lod == 0 else 128, cols=3, rows=2, frame='#EDE8DC',
                                        glass='#2B3238', win_w=0.36, win_h=0.62, seed=381, lit=0.0, recess=False, streaks=0.02,
                                        glass_var=0.05)
        M['palace'] = material(f'ist{lod}_palace_emit', albedo=a, rough=0.75, emissive_img=a, emissive_strength=0.22)


LANDMARKS = {
    'galata_kulesi': lambda: export_landmark('galata_kulesi', 'Galata Kulesi', build_galata, site('galata_kulesi')[1], 0.0,
                                             base='terrain', footprint=circle_fp(8.7), dists=(1500, 7000)),
    'kiz_kulesi': lambda: export_landmark('kiz_kulesi', 'Kız Kulesi', build_kiz, site('kiz_kulesi')[1], 0.0, base='absolute',
                                          dists=(1500, 7000)),
    'camlica_kulesi': lambda: export_landmark('camlica_kulesi', 'Çamlıca Kulesi', build_camlica_tv, site('camlica_kulesi')[1], 0.0,
                                              base='terrain', footprint=circle_fp(12.5), dists=(3000, 15000)),
    'camlica_camii': lambda: export_mosque('camlica_camii', 'Çamlıca Camii', spec_camlica, dists=(2600, 11000)),
    'sultanahmet': lambda: export_mosque('sultanahmet', 'Sultanahmet Camii', spec_sultanahmet),
    'suleymaniye': lambda: export_mosque('suleymaniye', 'Süleymaniye Camii', spec_suleymaniye),
    'yeni_cami': lambda: export_mosque('yeni_cami', 'Yeni Cami', spec_yeni_cami, dists=(1800, 8000)),
    'ayasofya': lambda: export_landmark('ayasofya', 'Ayasofya-i Kebir Camii', build_ayasofya, site('ayasofya')[1], site('ayasofya')[2],
                                        base='terrain', footprint=[(-33, -38), (33, -38), (33, 38), (-33, 38), (0, 0)], dists=(2200, 9000)),
    'haydarpasa': lambda: export_landmark('haydarpasa', 'Haydarpaşa Garı', build_haydarpasa, site('haydarpasa')[1], site('haydarpasa')[2],
                                          base='terrain', footprint=[tuple(p) for p in site('haydarpasa')[0]['outline']][::4] + [(0, 0)],
                                          dists=(1500, 7000)),
    'rumeli_hisari': lambda: export_landmark('rumeli_hisari', 'Rumeli Hisarı', build_rumeli, site('rumeli_hisari')[1], 0.0,
                                             base='absolute', dists=(1800, 8000), extra={'anchored': True}),
    'topkapi': lambda: export_landmark('topkapi', 'Topkapı Sarayı', build_topkapi, site('topkapi')[1], 0.0, base='absolute',
                                       dists=(1800, 8000), extra={'anchored': True}),
    'dolmabahce': lambda: export_landmark('dolmabahce', 'Dolmabahçe Sarayı', build_dolmabahce, site('dolmabahce')[1], 0.0,
                                          base='absolute', dists=(1800, 8000), extra={'anchored': True}),
}
for _k in SKY:
    LANDMARKS[_k] = (lambda k: (lambda: build_skyline(k)))(_k)


def main():
    reset_scene()
    palace_mats()
    names = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else list(LANDMARKS)
    for n in names:
        LANDMARKS[n]()


if __name__ == '__main__':
    main()
