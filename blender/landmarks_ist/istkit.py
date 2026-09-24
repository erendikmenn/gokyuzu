"""İstanbul landmark kit (Blender 5.2, headless): shared paths, textures, materials and parametric generators.

Reuses the San Francisco kit (blender/landmarks/lmkit.py: mesh builder MB, collision/light metadata Meta, material(),
Draco GLB export; bridgekit.py; tex_common.py) with the output redirected to assets/ist/landmarks (SF untouched).
Texture build inputs go to assets/ist/landmarks/_tex (underscore: never published, skipped by tools/assets).

Frame convention (per landmark): Blender +X = right, +Y = forward (landmark heading), +Z = up.
glTF/Three: (x, y, z)_three = (X, Z, -Y)_blender. Collision/lights metadata are written in Three local coordinates.

Generators:
  dome / half_dome / drum / cone / minaret      Ottoman mosque parts (lead domes, stone drums with windows, şerefe)
  mosque(spec)                                   square hall + central dome + semi-domes + exedrae + corner domes +
                                                 weight turrets + courtyard with portico domes + pencil minarets
  extrude(poly, z0, z1) / hip_roof / pyramid     footprints from OSM
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'landmarks'))
import numpy as np  # noqa: E402
import lmkit  # noqa: E402
from lmkit import MB, V, Meta, material, tri_count, reset_scene, norm, texture, fbm, srgb, blur, rng, earcut  # noqa: E402,F401

OUT = os.path.join(lmkit.REPO, 'assets', 'ist', 'landmarks')
lmkit.OUT = OUT
lmkit.TEX = os.path.join(OUT, '_tex')
import tex_common as tx  # noqa: E402  (uses lmkit.texture -> lmkit.TEX)

LAYOUT_PATH = os.path.join(HERE, 'layout.json')
LAYOUT = json.load(open(LAYOUT_PATH)) if os.path.exists(LAYOUT_PATH) else {}
URL = 'assets/ist/landmarks/'
DEG = math.pi / 180


def lin(hexstr):
    return tx.srgb_to_linear(hexstr)


# ================================================================================================ textures
def _ashlar(size, seed, base, course=0.5, tile=4.0, mortar=0.035, var=0.06, dirt=0.10):
    """Cut-stone courses: `course` m tall rows of blocks 0.7–1.5 m long on a `tile` m square tile."""
    r = rng(seed)
    h = w = size
    px = size / tile
    img = np.ones((h, w))
    rows = int(round(tile / course))
    edge = np.zeros((h, w))
    for k in range(rows):
        y0, y1 = int(k * h / rows), int((k + 1) * h / rows)
        x = r.uniform(0, 1.0) * px
        while x < w + 2 * px:
            L = r.uniform(0.7, 1.5) * px
            xa, xb = int(x) % w, int(x + L) % w
            v = 1 + r.uniform(-var, var)
            if xa < xb:
                img[y0:y1, xa:xb] *= v
            else:
                img[y0:y1, xa:] *= v
                img[y0:y1, :xb] *= v
            edge[y0:y1, xb % w:(xb % w) + max(1, int(mortar * px))] = 1
            x += L
        edge[y0:y0 + max(1, int(mortar * px)), :] = 1
    v = img * (1 + 0.06 * fbm(h, w, seed + 1, 5, 4) + 0.03 * fbm(h, w, seed + 2, 3, 32))
    v -= 0.12 * blur(edge, 1)
    streak = blur(np.tile(fbm(1, w, seed + 3, 6, 16), (h, 1)) * np.clip(0.3 + fbm(h, w, seed + 4, 3, 2), 0, None), 1)
    v -= dirt * np.clip(streak, 0, None)
    return np.array(base)[None, None, :] * v[:, :, None]


def stone_tex(lod, name='ist_stone', base='#C9C1AE', seed=301):
    size = 512 if lod == 0 else 128
    b = srgb(base)
    return texture(f'{name}{lod}', lambda: _ashlar(size, seed, b), 'jpg')


def rubble_tex(lod, name='ist_rubble', base='#948B7B', seed=311, brick=True):
    """Rough rubble masonry with brick courses (Byzantine / early Ottoman walls: Rumeli Hisarı, Galata)."""
    size = 512 if lod == 0 else 128

    def f():
        r = rng(seed)
        h = w = size
        b = srgb(base)
        img = np.zeros((h, w, 3)) + b[None, None, :]
        # stones: jittered cells
        cells = 14
        cy, cx = np.mgrid[0:h, 0:w] / size * cells
        best = np.full((h, w), 9.0)
        second = np.full((h, w), 9.0)
        ids = np.zeros((h, w), int)
        pts = r.uniform(0, 1, (cells, cells, 2))
        tone = r.uniform(-0.12, 0.12, (cells, cells))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                gy = (np.floor(cy).astype(int) + dy) % cells
                gx = (np.floor(cx).astype(int) + dx) % cells
                py = np.floor(cy) + dy + pts[gy, gx, 0]
                pxx = np.floor(cx) + dx + pts[gy, gx, 1]
                d = np.hypot((cy - py) * 1.6, cx - pxx)
                m = d < best
                second = np.where(m, best, np.minimum(second, d))
                ids = np.where(m, gy * cells + gx, ids)
                best = np.where(m, d, best)
        mortar = np.clip(1 - (second - best) * 6, 0, 1)
        t = tone.ravel()[ids]
        img *= (1 + t)[:, :, None]
        img = img * (1 - 0.35 * mortar[:, :, None]) + np.array([0.62, 0.60, 0.55])[None, None, :] * 0.35 * mortar[:, :, None]
        if brick:
            for k in range(2):
                y0 = int((0.3 + 0.5 * k) * h)
                band = slice(y0, y0 + max(2, h // 40))
                img[band] = srgb('#9A5A44')[None, None, :] * (1 + 0.1 * fbm(h, w, seed + 7, 3, 16)[band][:, :, None])
        img *= (1 + 0.06 * fbm(h, w, seed + 5, 5, 4))[:, :, None]
        return img
    return texture(f'{name}{lod}', f, 'jpg')


def lead_tex(lod, name='ist_lead', base='#737C82', seed=321):
    """Lead sheet roofing with standing seams along v (tile: 6 seams across u)."""
    size = 256 if lod == 0 else 64

    def f():
        h = w = size
        b = srgb(base)
        v = 1 + 0.07 * fbm(h, w, seed, 5, 4) + 0.03 * fbm(h, w, seed + 1, 3, 32)
        seams = np.zeros(w)
        for k in range(6):
            x = int(k * w / 6)
            seams[x:x + max(1, w // 128)] = 1
        v = v * (1 - 0.18 * seams[None, :]) + 0.08 * np.roll(seams, 2)[None, :]
        # whitish oxidation patches
        ox = np.clip(fbm(h, w, seed + 3, 4, 2) - 0.2, 0, None) * 0.35
        img = b[None, None, :] * v[:, :, None]
        return img * (1 - ox[:, :, None]) + np.array([0.78, 0.80, 0.80])[None, None, :] * ox[:, :, None]
    return texture(f'{name}{lod}', f, 'jpg')


def arched_window_tex(lod, name='ist_win', base='#C9C1AE', glass='#1C2126', seed=331, cols=1, rows=1, win_w=0.34,
                      win_h=0.55, y_center=0.5, frame='#B9AE98'):
    """Stone tile with pointed-arch windows (cols x rows per tile). Used on mosque walls and dome drums."""
    size = 512 if lod == 0 else 128

    def f():
        img = _ashlar(size, seed, srgb(base), course=0.5, tile=4.0)
        h = w = size
        yy, xx = np.mgrid[0:h, 0:w]
        cw, ch = w / cols, h / rows
        u = (xx % cw) / cw - 0.5
        v = 1 - (yy % ch) / ch        # 0 bottom .. 1 top
        y0 = y_center - win_h / 2
        y1 = y_center + win_h / 2 - win_w * 0.55
        rect = (np.abs(u) < win_w / 2) & (v > y0) & (v < y1)
        # pointed arch: two circle arcs of radius win_w centered on the opposite jambs
        ay = v - y1
        arch = (ay >= 0) & (np.hypot(np.abs(u) + win_w / 2, ay) < win_w) & (np.abs(u) < win_w / 2)
        win = rect | arch
        # frame (1 px band around the opening)
        grow = np.zeros_like(win)
        for d in (-3, -2, -1, 1, 2, 3):
            grow |= np.roll(win, d, axis=0) | np.roll(win, d, axis=1)
        fr = grow & ~win
        g = srgb(glass)[None, None, :] * (1 + 0.1 * fbm(h, w, seed + 9, 3, 8))[:, :, None]
        img = np.where(fr[:, :, None], srgb(frame)[None, None, :], img)
        img = np.where(win[:, :, None], g, img)
        return img
    return texture(f'{name}{lod}', f, 'jpg')


def plaster_tex(lod, name, base, seed=341, bands=True):
    size = 512 if lod == 0 else 128

    def f():
        h = w = size
        v = 1 + 0.06 * fbm(h, w, seed, 5, 4) + 0.03 * fbm(h, w, seed + 1, 3, 32)
        streak = blur(np.tile(fbm(1, w, seed + 3, 6, 16), (h, 1)) * np.clip(0.3 + fbm(h, w, seed + 4, 3, 2), 0, None), 1)
        v -= 0.07 * np.clip(streak, 0, None)
        img = srgb(base)[None, None, :] * v[:, :, None]
        if bands:
            for k in range(4):
                y = int(k * h / 4)
                img[y:y + max(1, h // 100)] *= 0.9
        return img
    return texture(f'{name}{lod}', f, 'jpg')


def slate_tex(lod, name='ist_slate', base='#4E555C', seed=351):
    size = 256 if lod == 0 else 64

    def f():
        h = w = size
        img = srgb(base)[None, None, :] * (1 + 0.08 * fbm(h, w, seed, 5, 8))[:, :, None]
        for k in range(16):
            y = int(k * h / 16)
            img[y:y + max(1, h // 128)] *= 0.75
        return img
    return texture(f'{name}{lod}', f, 'jpg')


def tvbud_tex(lod, seed=391):
    """Çamlıca Kulesi upper body: off-white panels, a dark ribbon window band per floor (tile = 6 m × one 4.5 m floor),
    fine vertical panel joints."""
    size = 128 if lod == 0 else 64

    def f():
        h = w = size
        img = srgb('#ECEBE6')[None, None, :] * (1 + 0.03 * fbm(h, w, seed, 4, 4))[:, :, None] * np.ones((h, w, 3))
        yy, xx = np.mgrid[0:h, 0:w]
        v = 1 - yy / h
        win = (v > 0.18) & (v < 0.52)
        img = np.where(win[:, :, None], srgb('#2A3137')[None, None, :] * (1 + 0.15 * fbm(h, w, seed + 1, 3, 8))[:, :, None], img)
        img[:, ::max(1, w // 4)] *= 0.93
        img[int(h * 0.1):int(h * 0.12)] *= 0.85
        return img
    return texture(f'ist_tvbud{lod}', f, 'jpg')


def glass_facade(lod, name, frame='#9DA6AD', glass='#4F6B84', cols=4, rows=4, lit=0.2, seed=361, win_w=0.86, win_h=0.78):
    """Curtain-wall office facade: cols x rows panels per tile (tile = 12 m wide x 4 floors)."""
    size = 512 if lod == 0 else 128
    return tx.window_facade(f'{name}{lod}', size=size, cols=cols, rows=rows, frame=frame, glass=glass, win_w=win_w,
                            win_h=win_h, seed=seed, lit=lit, recess=False, glass_rough=0.1, streaks=0.02, glass_var=0.15)


# ================================================================================================ materials
_M = {}


def hanger_mat(lod):
    """Suspension hangers: thin light-grey ropes drawn semi-transparent (glTF BLEND) so a span of several hundred of
    them reads as fine lines, not a truss. The `_cable` suffix keeps the runtime's ~1 px minimum rope width
    (src/world-sf/landmarks.js widenRopes), the alpha falls with the LOD (0.42 near, 0.25 at 1.8–4.2 km, none beyond)."""
    return material(f'ist{lod}_hanger_cable', color=lin('#BFC5C9'), rough=0.7, metal=0.0,
                    alpha=0.42 if lod == 0 else 0.25, blend=True)


def mats(lod):
    """Shared İstanbul material set per LOD (textures 512² LOD0 / 128² LOD1 / flat colours LOD2 and coarser)."""
    if lod in _M:
        return _M[lod]
    p = f'ist{lod}_'
    if lod >= 2:
        def flat(n, c, rough=0.8, **k):
            return material(p + n, color=lin(c), rough=rough, **k)
        M = {
            'stone': flat('stone_emit', '#C6BEAB', emissive=lin('#FFD9A8'), emissive_strength=0.25),
            'stone_plain': flat('stone', '#C6BEAB'),
            'wall': flat('wall_emit', '#BDB4A1', emissive=lin('#FFD9A8'), emissive_strength=0.25),
            'drum': flat('drum_emit', '#B8AE9A', emissive=lin('#FFD9A8'), emissive_strength=0.25),
            'lead': flat('lead', '#737C82', rough=0.55, metal=0.12),
            'rubble': flat('rubble', '#8F8676'),
            'ochre': flat('ochre_emit', '#D09A6E', emissive=lin('#FFC890'), emissive_strength=0.2),
            'sand': flat('sand', '#CDBB93'),
            'white': flat('white', '#EFEBE2'),
            'slate': flat('slate', '#4E555C', rough=0.6),
            'tile': flat('tile', '#9C5B42'),
            'dark': flat('dark', '#1B1F23', rough=0.5),
            'gold': flat('gold', '#C9A447', rough=0.35, metal=0.9),
            'paint': flat('paint', '#C4C8CA', rough=0.55),
            'paint_w': flat('paint_w', '#DDE0E1', rough=0.55),
            'concrete': flat('concrete', '#A8A399', rough=0.9),
            'road': flat('road', '#2A2B2D', rough=0.9),
            'cable': flat('steel_cable', '#9FA5A8', rough=0.5, metal=0.5),
            'glass': flat('glass', '#40546A', rough=0.15, metal=0.4),
            'glass2': flat('glass2', '#5E7A8C', rough=0.15, metal=0.4),
            'red': flat('red', '#B02A20'),
            'grass': flat('grass', '#5E7244', rough=0.95),
            'warn': flat('warn_emit', '#992015', emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
            'lamp': flat('lamp_emit', '#E6DCC0', emissive=(1.0, 0.75, 0.42), emissive_strength=2.0),
            'hanger': hanger_mat(lod),
            'sky_glass': flat('sky_glass', '#B2BCC3', rough=0.2, metal=0.3),
            'steel': flat('steel', '#4C5358', rough=0.45, metal=0.5),
            'tvbud': flat('tvbud', '#C9CCCC', rough=0.6),
            'sky_solid': flat('sky_solid', '#E6E6E4', rough=0.6),
        }
        _M[lod] = M
        return M
    st = stone_tex(lod)
    wall = arched_window_tex(lod, 'ist_wallwin', cols=1, rows=1, win_w=0.30, win_h=0.62, y_center=0.48)
    drum = arched_window_tex(lod, 'ist_drumwin', base='#CFC5AF', cols=1, rows=1, win_w=0.42, win_h=0.78, y_center=0.5)
    ld = lead_tex(lod)
    rb = rubble_tex(lod)
    oc = plaster_tex(lod, 'ist_ochre', '#D39A6C', seed=343)
    sd = plaster_tex(lod, 'ist_sand', '#CDB891', seed=345)
    wh = plaster_tex(lod, 'ist_white', '#F0ECE3', seed=347, bands=False)
    sl = slate_tex(lod)
    ga, go, gn, ge = glass_facade(lod, 'ist_glass')
    g2a, _, _, g2e = glass_facade(lod, 'ist_glass2', frame='#B7BCC0', glass='#5D7B90', cols=3, rows=4, seed=367, win_w=0.9, win_h=0.82)
    tvb = tvbud_tex(lod)
    sa, so, _, se = tx.window_facade(f'ist_skyglass{lod}', size=256 if lod == 0 else 128, cols=4, rows=4, frame='#E4E7E9',
                                     glass='#AEB9C1', win_w=0.9, win_h=0.76, seed=391, lit=0.2, recess=False,
                                     glass_rough=0.08, streaks=0.0, glass_var=0.1)
    pa, _, _ = tx.paint_textures(base='#C3C8CB', name=f'ist_paint{lod}', seed=371, size=256 if lod == 0 else 64, seams=False)
    pw, _, _ = tx.paint_textures(base='#DADEE0', name=f'ist_paintw{lod}', seed=373, size=256 if lod == 0 else 64, seams=False)
    ca, _, _ = tx.concrete_textures(f'ist_concrete{lod}', base=(0.58, 0.56, 0.52), seed=375, size=256 if lod == 0 else 64)
    road = tx.road_texture(f'ist_road{lod}', lanes=6, width=21.0, w=256 if lod == 0 else 64, h=256 if lod == 0 else 64)
    rail = tx.railing_texture(f'ist_rail{lod}', color='#9BA1A4', w=64, h=64)
    warm = lin('#FFD9A8')
    M = {
        # floodlit masonry: *_emit materials are scaled by the runtime's night factor (lamp class)
        'stone': material(p + 'stone_emit', albedo=st, rough=0.85, emissive_img=st, emissive_strength=0.28),
        'stone_plain': material(p + 'stone', albedo=st, rough=0.85),
        'wall': material(p + 'wall_emit', albedo=wall, rough=0.85, emissive_img=wall, emissive_strength=0.28),
        'drum': material(p + 'drum_emit', albedo=drum, rough=0.85, emissive_img=drum, emissive_strength=0.28),
        'lead': material(p + 'lead', albedo=ld, rough=0.55, metal=0.12),
        'rubble': material(p + 'rubble', albedo=rb, rough=0.9),
        'ochre': material(p + 'ochre_emit', albedo=oc, rough=0.85, emissive_img=oc, emissive_strength=0.22),
        'sand': material(p + 'sand', albedo=sd, rough=0.85),
        'white': material(p + 'white', albedo=wh, rough=0.8),
        'slate': material(p + 'slate', albedo=sl, rough=0.6),
        'tile': material(p + 'tile', color=lin('#9C5B42'), rough=0.8),
        'dark': material(p + 'dark', color=lin('#1B1F23'), rough=0.5),
        'gold': material(p + 'gold', color=lin('#C9A447'), rough=0.35, metal=0.9),
        'paint': material(p + 'paint', albedo=pa, rough=0.5),
        'paint_w': material(p + 'paint_w', albedo=pw, rough=0.5),
        'concrete': material(p + 'concrete', albedo=ca, rough=0.9),
        'road': material(p + 'road', albedo=road, rough=0.9),
        'rail': material(p + 'rail_clip', albedo=rail, alpha_img=True, rough=0.55, double_sided=True),
        'cable': material(p + 'steel_cable', color=lin('#A3A9AC'), rough=0.45, metal=0.5),
        'glass': material(p + 'glass_emit', albedo=ga, rough_img=go, emissive_img=ge, emissive_strength=0.9),
        'glass2': material(p + 'glass2_emit', albedo=g2a, rough=0.2, emissive_img=g2e, emissive_strength=0.9),
        'red': material(p + 'red', color=lin('#B02A20'), rough=0.7),
        'grass': material(p + 'grass', color=lin('#5E7244'), rough=0.95),
        'warn': material(p + 'warn_emit', color=(0.6, 0.02, 0.01), emissive=(1.0, 0.05, 0.02), emissive_strength=5.0),
        'lamp': material(p + 'lamp_emit', color=(0.9, 0.8, 0.6), emissive=(1.0, 0.72, 0.38), emissive_strength=2.0),
        'hanger': hanger_mat(lod),
        # skyscrapers (skyline.py): one neutral curtain wall (4 panes × 4 floors per 12 × 16 m tile, night-lit windows)
        # tinted per tower by vertex colours, and one flat solid material for crowns / spires / podiums
        'sky_glass': material(p + 'sky_glass_emit', albedo=sa, rough_img=so, emissive_img=se, emissive_strength=0.9),
        'sky_solid': material(p + 'sky_solid', color=lin('#E6E6E4'), rough=0.6),
        'steel': material(p + 'steel', color=lin('#4C5358'), rough=0.45, metal=0.5),
        # Çamlıca Kulesi bud / louvred collar: off-white GFRC panels with a dark ribbon window per 4.5 m floor
        'tvbud': material(p + 'tvbud', albedo=tvb, rough=0.6),
    }
    _ = warm
    _M[lod] = M
    return M


# ================================================================================================ builder
class Build:
    """Per-LOD builder: one mesh builder per material key, metadata (collision/lights) on LOD0 only."""

    def __init__(self, lid, name, lod):
        self.lid, self.name, self.lod = lid, name, lod
        self.M = mats(lod)
        self.mb = {}
        self.meta = Meta(lid, name) if lod == 0 else None

    def __getitem__(self, k):
        if k not in self.mb:
            self.mb[k] = MB(k)
            self.mb[k].anchor = getattr(self, '_anchor', None)     # current ground anchor of an anchored site
        return self.mb[k]

    def objects(self, prefix):
        return [mb.to_object(f'{prefix}_{k}', self.M[k], use_colors=True) for k, mb in self.mb.items() if len(mb)]

    # -- metadata shortcuts (no-ops on LOD1/LOD2)
    def cbox(self, lo, hi, yaw=0.0):
        if self.meta:
            self.meta.box(lo, hi, self.name, yaw)

    def ccap(self, a, b, r, solid=False):
        if self.meta:
            self.meta.capsule(a, b, r, self.name, solid)

    def light(self, p, color='#ff2a14', size=4.0, period=1.5, **k):
        if self.meta:
            self.meta.light(p, color, size, period, **k)


def export_landmark(lid, name, build_fn, origin, heading, base='terrain', footprint=None, dists=(1500, 7000),
                    extra=None, draco_bits=16, lods=(0, 1, 2)):
    """Build LOD0..2 with build_fn(lod) -> Build, export GLBs + <lid>.json (same schema as SF's landmark JSON)."""
    results, meta, bounds = {}, None, None
    from lmkit import export
    for lod in lods:
        b = build_fn(lod)
        obs = b.objects(lid if lod == 0 else f'{lid}_lod{lod}')
        fname = lid + ('' if lod == 0 else f'_lod{lod}')
        path = os.path.join(OUT, f'{fname}.glb')
        export(path, obs, draco_bits=draco_bits)
        results[lod] = tri_count(obs)
        print(f'{lid} LOD{lod}: {results[lod]} tris, {os.path.getsize(path) / 1e6:.2f} MB', flush=True)
        if lod == 0:
            meta = b.meta
            vs = np.array([tuple(v.co) for o in obs for v in o.data.vertices])
            mn, mx = vs.min(axis=0), vs.max(axis=0)
            bounds = {'min': [round(float(mn[0]), 2), round(float(mn[2]), 2), round(float(-mx[1]), 2)],
                      'max': [round(float(mx[0]), 2), round(float(mx[2]), 2), round(float(-mn[1]), 2)]}
        for o in obs:
            o.hide_set(True)
            o.hide_render = True
    urls = [URL + lid + ('' if k == 0 else f'_lod{k}') + '.glb' for k in lods]
    dl = list(dists[:len(lods) - 1]) + [1e9]
    meta.d.update({
        'origin': {'x': round(origin[0], 2), 'z': round(origin[1], 2)}, 'heading': round(heading, 6), 'base': base,
        'lods': [{'url': u, 'dist': d} for u, d in zip(urls, dl)],
        'tris': {str(k): v for k, v in results.items()}, 'bounds': bounds,
    })
    if footprint is not None:
        meta.d['footprint'] = [[round(x, 2), round(-y, 2)] for x, y in footprint]
    if extra:
        meta.d.update(extra)
    meta.save()
    return meta


# ================================================================================================ geometry helpers
def ring(r, n, a0=0.0, c=(0.0, 0.0)):
    return [(c[0] + r * math.cos(a0 + 2 * math.pi * i / n), c[1] + r * math.sin(a0 + 2 * math.pi * i / n)) for i in range(n)]


def loft(mb, rings, zs, ts_u=4.0, ts_v=4.0, cap_top=False, smooth=False, u_turns=None, v0=0.0, cap_bottom=False):
    """Loft closed outlines (same vertex count) at heights zs. u = perimeter / ts_u (or u_turns tiles per turn),
    v = (z - v0) / ts_v."""
    n = len(rings[0])
    idx = [mb.add_verts([(x, y, z) for x, y in rg]) for rg, z in zip(rings, zs)]
    for k in range(len(rings) - 1):
        ra, rb = rings[k], rings[k + 1]
        za, zb = zs[k], zs[k + 1]
        ua = ub = 0.0
        for i in range(n):
            j = (i + 1) % n
            if u_turns:
                la = lb = u_turns / n
                uua, uub = i / n * u_turns, i / n * u_turns
            else:
                la = math.hypot(ra[j][0] - ra[i][0], ra[j][1] - ra[i][1]) / ts_u
                lb = math.hypot(rb[j][0] - rb[i][0], rb[j][1] - rb[i][1]) / ts_u
                uua, uub = ua, ub
            mb.face((idx[k] + i, idx[k] + j, idx[k + 1] + j, idx[k + 1] + i),
                    [(uua, (za - v0) / ts_v), (uua + la, (za - v0) / ts_v), (uub + lb, (zb - v0) / ts_v), (uub, (zb - v0) / ts_v)],
                    smooth=smooth)
            ua += la
            ub += lb
    if cap_top:
        mb.polygon([(x, y, zs[-1]) for x, y in rings[-1]])
    if cap_bottom:
        mb.polygon([(x, y, zs[0]) for x, y in rings[0][::-1]])


def dome(mb, c, r, h, seg=16, rings_n=6, ts=4.0, ribs=None, z_base=None):
    """Lead dome: surface of revolution, base radius r at c.z, crown h above. Profile = quarter ellipse (h vs r).
    UV: u = ribs per turn (lead seams follow the meridians), v = meridian length / ts."""
    c = V(c)
    prof = [(r * math.cos(t), h * math.sin(t)) for t in np.linspace(0, math.pi / 2, rings_n + 1)]
    ribs = ribs or max(4, int(round(2 * math.pi * r / 3.0 / 6)))   # ~3 m between seams, 6 seams per texture tile
    rings_xy, zs = [], []
    for rr, zz in prof[:-1]:
        rings_xy.append(ring(max(rr, 1e-3), seg, c=(c[0], c[1])))
        zs.append(c[2] + zz)
    # meridian arclength for v
    arc = [0.0]
    for i in range(1, len(prof)):
        arc.append(arc[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))
    idx = [mb.add_verts([(x, y, z) for x, y in rg]) for rg, z in zip(rings_xy, zs)]
    top = mb.add_verts([(c[0], c[1], c[2] + h)])
    for k in range(len(idx) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            ua, ub = i / seg * ribs, (i + 1) / seg * ribs
            mb.face((idx[k] + i, idx[k] + j, idx[k + 1] + j, idx[k + 1] + i),
                    [(ua, arc[k] / ts), (ub, arc[k] / ts), (ub, arc[k + 1] / ts), (ua, arc[k + 1] / ts)], smooth=True)
    k = len(idx) - 1
    for i in range(seg):
        j = (i + 1) % seg
        ua, ub = i / seg * ribs, (i + 1) / seg * ribs
        mb.face((idx[k] + i, idx[k] + j, top), [(ua, arc[k] / ts), (ub, arc[k] / ts), ((ua + ub) / 2, arc[-1] / ts)], smooth=True)


def half_dome(mb, c, r, h, ang, seg=8, rings_n=4, ts=4.0, cap=True, ribs=None):
    """Semi-dome (quarter sphere) centred at c (springing level), bulging along direction `ang` (rad, from +X CCW),
    open face toward -dir (closed by a flat tympanum when cap)."""
    c = V(c)
    d = V(math.cos(ang), math.sin(ang), 0.0)
    s = V(-math.sin(ang), math.cos(ang), 0.0)
    ribs = ribs or max(2, int(round(math.pi * r / 3.0 / 6)))
    grid = []
    for k in range(rings_n + 1):
        t = math.pi / 2 * k / rings_n
        rr, zz = r * math.cos(t), h * math.sin(t)
        row = []
        for i in range(seg + 1):
            a = -math.pi / 2 + math.pi * i / seg
            row.append(c + d * (rr * math.cos(a)) + s * (rr * math.sin(a)) + V(0, 0, zz))
        grid.append(mb.add_verts(row))
    for k in range(rings_n):
        for i in range(seg):
            ua, ub = i / seg * ribs, (i + 1) / seg * ribs
            va, vb = k / rings_n * (math.pi / 2 * r) / ts, (k + 1) / rings_n * (math.pi / 2 * r) / ts
            if k == rings_n - 1:
                mb.face((grid[k] + i, grid[k] + i + 1, grid[k + 1] + i), [(ua, va), (ub, va), (ua, vb)], smooth=True)
            else:
                mb.face((grid[k] + i + 1, grid[k + 1] + i + 1, grid[k + 1] + i, grid[k] + i)[::-1],
                        [(ua, va), (ua, vb), (ub, vb), (ub, va)][::-1], smooth=True)
    return d, s


def cone(mb, c, r, h, n=12, ts=4.0, r_top=0.0, u_turns=None, smooth=True):
    """Vertical cone / frustum from c upward (open bottom)."""
    c = V(c)
    if r_top > 0:
        loft(mb, [ring(r, n, c=(c[0], c[1])), ring(r_top, n, c=(c[0], c[1]))], [c[2], c[2] + h], ts, ts, cap_top=True,
             smooth=smooth, u_turns=u_turns)
        return
    base = mb.add_verts([(x, y, c[2]) for x, y in ring(r, n, c=(c[0], c[1]))])
    top = mb.add_verts([(c[0], c[1], c[2] + h)])
    L = math.hypot(r, h)
    turns = u_turns or 2 * math.pi * r / ts
    for i in range(n):
        j = (i + 1) % n
        mb.face((base + i, base + j, top), [(i / n * turns, 0), ((i + 1) / n * turns, 0), ((i + 0.5) / n * turns, L / ts)], smooth=smooth)


def extrude(mb, poly, z0, z1, ts_u=4.0, ts_v=4.0, top=True, bottom=False, v0=None):
    """Prism from a 2D polygon (made CCW). Wall UVs: u = perimeter / ts_u, v = (z - v0) / ts_v."""
    poly = ccw(poly)
    n = len(poly)
    per = 0.0
    v0 = z0 if v0 is None else v0
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-3:
            continue
        mb.quad((a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1),
                uv=[(per / ts_u, (z0 - v0) / ts_v), ((per + L) / ts_u, (z0 - v0) / ts_v),
                    ((per + L) / ts_u, (z1 - v0) / ts_v), (per / ts_u, (z1 - v0) / ts_v)])
        per += L
    if top:
        mb.polygon([(p[0], p[1], z1) for p in poly], ts_u)
    if bottom:
        mb.polygon([(p[0], p[1], z0) for p in poly[::-1]], ts_u)


def ccw(poly):
    a = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    return list(poly) if a > 0 else list(poly)[::-1]


def hip_roof(mb, poly, z0, h, ts=4.0):
    """Roof over a footprint: a pyramid to the centroid for compact shapes (lead/tile hipped roof look).
    For elongated rectangles use gable_hip()."""
    poly = ccw(poly)
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    apex = (cx, cy, z0 + h)
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        mb.tri((a[0], a[1], z0), (b[0], b[1], z0), apex, ts)


def obb(poly):
    """Oriented bounding box of a polygon: (cx, cy, angle of the long axis (rad), half_long, half_short)."""
    pts = np.array(poly, float)
    best = None
    n = len(pts)
    for i in range(n):
        e = pts[(i + 1) % n] - pts[i]
        L = np.linalg.norm(e)
        if L < 1e-6:
            continue
        u = e / L
        w = np.array([-u[1], u[0]])
        pu, pw = pts @ u, pts @ w
        area = (pu.max() - pu.min()) * (pw.max() - pw.min())
        if best is None or area < best[0]:
            c = u * (pu.max() + pu.min()) / 2 + w * (pw.max() + pw.min()) / 2
            hl, hs = (pu.max() - pu.min()) / 2, (pw.max() - pw.min()) / 2
            ang = math.atan2(u[1], u[0])
            if hs > hl:
                hl, hs, ang = hs, hl, ang + math.pi / 2
            best = (area, float(c[0]), float(c[1]), ang, float(hl), float(hs))
    return best[1:]


def gable_hip(mb, cx, cy, ang, hl, hs, z0, h, ts=4.0):
    """Hipped roof over an oriented rectangle (ridge along the long axis)."""
    u = V(math.cos(ang), math.sin(ang), 0)
    w = V(-math.sin(ang), math.cos(ang), 0)
    c = V(cx, cy, z0)
    r = max(hl - hs, 0.0)
    A, B, C, D = c - u * hl - w * hs, c + u * hl - w * hs, c + u * hl + w * hs, c - u * hl + w * hs
    R0, R1 = c - u * r + V(0, 0, h), c + u * r + V(0, 0, h)
    mb.quad(A, B, R1, R0, ts)
    mb.quad(C, D, R0, R1, ts)
    mb.tri(B, C, R1, ts)
    mb.tri(D, A, R0, ts)


# ================================================================================================ mosque parts
def alem(b, x, y, z, h=3.0, r=0.18):
    """Finial (alem): gilded spike with a few balls; LOD0 only details."""
    g = b['gold']
    if b.lod == 2:
        g.cylinder((x, y, z), r * 1.5, h, sides=4, cap_top=True)
        return
    g.cylinder((x, y, z), r, h, sides=6, cap_top=True)
    for k, (zz, rr) in enumerate(((0.25, 0.45), (0.55, 0.35))):
        g.cylinder((x, y, z + h * zz - rr), rr, 2 * rr, sides=6, r_top=rr * 0.6, cap_top=True)


def minaret(b, x, y, z0, H, r=1.6, sherefe=3, base_h=None, lod=None, cap_ratio=0.18, sides=None, stone='stone'):
    """Ottoman pencil minaret standing at (x, y) on ground z0, total height H (to the tip of the cone, alem excluded).
    Square base (kürsü) -> transition -> polygonal shaft with `sherefe` balconies -> petek -> lead cone (külah)."""
    lod = b.lod if lod is None else lod
    n = sides or {0: 12, 1: 8, 2: 6}[lod]
    S = b[stone]
    base_h = base_h if base_h is not None else min(0.16 * H, 14.0)
    cone_h = cap_ratio * H
    shaft_top = z0 + H - cone_h
    # base: square kürsü slightly wider than the shaft
    a = r * 1.35
    extrude(S, [(x - a, y - a), (x + a, y - a), (x + a, y + a), (x - a, y + a)], z0 - 3.0, z0 + base_h, 4, 4, top=lod == 2)
    if lod < 2:
        # pabuç: tapered transition from the square to the polygon
        loft(S, [[(x + a * 1.02 * math.cos(t) / max(abs(math.cos(t)), abs(math.sin(t))) * 0.98,
                   y + a * 1.02 * math.sin(t) / max(abs(math.cos(t)), abs(math.sin(t))) * 0.98) for t in np.linspace(0, 2 * math.pi, n + 1)[:-1]],
                  ring(r, n, c=(x, y))], [z0 + base_h, z0 + base_h + 2.5], 4, 4)
    z_sh = z0 + base_h + (2.5 if lod < 2 else 0)
    # şerefe levels between 52 % and 84 % of the height
    lv = [z0 + H * (0.52 + 0.30 * (k / max(1, sherefe - 1) if sherefe > 1 else 1.0)) for k in range(sherefe)] if sherefe else []
    if sherefe == 1:
        lv = [z0 + H * 0.74]
    zs = [z_sh]
    for z in lv:
        zs += [z - 1.6, z + 1.1]
    zs.append(shaft_top)
    # shaft segments between balconies (slightly narrowing upward: petek)
    for k in range(0, len(zs) - 1, 2):
        za, zb = zs[k], zs[k + 1]
        rk = r * (1 - 0.04 * k)
        loft(S, [ring(rk, n, c=(x, y)), ring(rk * 0.985, n, c=(x, y))], [za, zb], 4, 4, smooth=lod < 2)
    for k, z in enumerate(lv):
        rk = r * (1 - 0.04 * (2 * k + 1))
        rb = rk + (1.05 if lod < 2 else 0.8)
        if lod == 2:
            S.cylinder((x, y, z - 0.6), rb, 1.2, sides=n, cap_top=True, cap_bottom=True)
            continue
        # corbel (mukarnas) as a flared frustum, balcony slab, parapet
        loft(S, [ring(rk, n, c=(x, y)), ring(rb, n, c=(x, y))], [z - 1.6, z], 4, 4)
        S.cylinder((x, y, z), rb, 0.25, sides=n, cap_top=True)
        loft(S, [ring(rb, n, c=(x, y)), ring(rb, n, c=(x, y))], [z + 0.25, z + 1.1], 2, 1.0, cap_top=False)
        if lod == 0:
            loft(S, [ring(rb - 0.12, n, c=(x, y)), ring(rb - 0.12, n, c=(x, y))], [z + 1.1, z + 0.25], 2, 1.0)
        # upper shaft between this balcony and the next (roofed gallery look at the top one)
    # lead cone + alem
    rc = r * (1 - 0.04 * (2 * sherefe)) * 1.08
    if lod < 2:
        S.cylinder((x, y, shaft_top - 0.3), rc * 1.05, 0.6, sides=n, cap_top=False)
    cone(b['lead'], (x, y, shaft_top), rc, cone_h, n=n, u_turns=2)
    if lod < 2:
        alem(b, x, y, shaft_top + cone_h - 0.3, h=min(4.0, 0.035 * H), r=0.16)
    # collision: one capsule per minaret (solid, standing on the ground) + balcony ring
    b.ccap((x, y, z0), (x, y, z0 + H), r + 0.5, solid=True)
    return z0 + H


def mosque(b, spec):
    """Classical Ottoman mosque from a spec (frame: +Y toward the qibla wall, origin at the central dome centre on
    the ground). Units m. Keys:
      hall: [w, d, h, cy]        prayer hall walls (width along X, depth along Y, wall height, centre y)
      dome: [D, z_base, drum_h, crown]   diameter, springing height of the drum, drum height, outer crown height
      semis: ['+y','-y','+x','-x'] directions of the semi-domes (radius D/2, spring at z_base - D*0.1)
      exedrae: {dir: n}          small half domes around a semi-dome
      corner_domes: [[x, y, D, z]...]
      turrets: bool              4 weight turrets at the corners of the central square
      court: [w, d, cy, h, n_domes_long, n_domes_short]   courtyard with portico domes
      minarets: [[x, y, H, sherefe, r]...]
      side_galleries: [[x0, x1, y0, y1, h, n]] low domed galleries (revak) along the hall
      stone: material key ('stone' / 'ochre')
    """
    lod = b.lod
    st = spec.get('stone', 'stone')
    S, W, L = b[st], b['wall' if st == 'stone' else st], b['lead']
    Dr = b['drum' if st == 'stone' else st]
    w, d, hh, cy = spec['hall']
    D, zb, dh, crown = spec['dome']
    R = D / 2
    seg = {0: 24, 1: 16, 2: 10}[lod]
    rn = {0: 6, 1: 4, 2: 3}[lod]
    # --- prayer hall block (walls with windows) + flat lead-covered roof slab
    hx, hy = w / 2, d / 2
    hall = [(-hx, cy - hy), (hx, cy - hy), (hx, cy + hy), (-hx, cy + hy)]
    extrude(W, hall, -4.0, hh, ts_u=8.0, ts_v=hh / 2.6, top=False, v0=0.0)
    L.polygon([(p[0], p[1], hh) for p in hall])
    if lod < 2:
        # cornice
        extrude(S, [(-hx - 0.5, cy - hy - 0.5), (hx + 0.5, cy - hy - 0.5), (hx + 0.5, cy + hy + 0.5), (-hx - 0.5, cy + hy + 0.5)],
                hh - 0.6, hh, 4, 4, top=False)
    b.cbox((-hx, cy - hy, -4.0), (hx, cy + hy, hh + 0.5))
    # --- central square: raised block carrying the pendentives up to the drum springing
    sq = R * 1.02
    z_sq0 = hh
    extrude(S, [(-sq, -sq), (sq, -sq), (sq, sq), (-sq, sq)], z_sq0, zb, 4, 4, top=False)
    L.polygon([(p[0], p[1], zb) for p in [(-sq, -sq), (sq, -sq), (sq, sq), (-sq, sq)]])
    # --- semi-domes
    dirs = {'+y': math.pi / 2, '-y': -math.pi / 2, '+x': 0.0, '-x': math.pi}
    z_semi = zb - dh * 0.1 - R * 0.05
    semi_h = zb - z_semi + dh * 0.15 + R * 0.12
    for key in spec.get('semis', []):
        a = dirs[key]
        dvec = V(math.cos(a), math.sin(a), 0)
        c = dvec * sq + V(0, 0, z_semi)
        half_dome(L, c, R, semi_h + R * 0.25, a, seg=seg // 2, rings_n=max(2, rn - 1))
        ex = spec.get('exedrae', {}).get(key, 0)
        if ex and lod < 2:
            rr = R * 0.42
            for k in range(ex):
                t = (k - (ex - 1) / 2) * (math.pi / 2.6)
                cc = c + (dvec * math.cos(t) + V(-math.sin(a), math.cos(a), 0) * math.sin(t)) * (R * 0.78)
                cc[2] = z_semi - R * 0.35
                half_dome(L, cc, rr, rr * 0.9, a + t, seg=max(4, seg // 4), rings_n=2)
        # collision: a box over the semi-dome footprint
        lo = V(min(c[0], c[0] + dvec[0] * R) - R * abs(dvec[1]), min(c[1], c[1] + dvec[1] * R) - R * abs(dvec[0]), hh)
        hi = V(max(c[0], c[0] + dvec[0] * R) + R * abs(dvec[1]), max(c[1], c[1] + dvec[1] * R) + R * abs(dvec[0]), z_semi + semi_h + R * 0.25)
        b.cbox(lo, hi)
    # --- drum with windows + dome + alem
    nwin = spec.get('drum_windows', max(12, int(D * 1.2) // 2 * 2))
    loft(Dr, [ring(R * 0.98, seg), ring(R * 0.98, seg)], [zb, zb + dh], u_turns=nwin, ts_v=dh, v0=zb)
    if lod < 2:
        # buttresses around the drum
        nb = min(nwin, 24) if lod == 0 else 8
        for k in range(nb):
            t = 2 * math.pi * (k + 0.5) / nb
            p = V(math.cos(t), math.sin(t), 0) * (R * 0.98 + 0.6)
            S.obox(p + V(0, 0, zb + dh * 0.45), V(math.cos(t), math.sin(t), 0), V(-math.sin(t), math.cos(t), 0), V(0, 0, 1),
                   0.9, 0.7, dh * 0.45)
    dome(L, (0, 0, zb + dh), R, crown - zb - dh, seg=seg, rings_n=rn)
    alem(b, 0, 0, crown - 0.2, h=max(3.0, D * 0.12), r=0.3)
    b.cbox((-R, -R, hh), (R, R, crown))
    # --- weight turrets at the corners of the central square
    if spec.get('turrets'):
        tr = spec.get('turret_r', R * 0.16)
        for sx in (-1, 1):
            for sy in (-1, 1):
                x, y = sx * sq, sy * sq
                tz = zb + dh * 0.6
                loft(S, [ring(tr, 8, c=(x, y)), ring(tr, 8, c=(x, y))], [hh, tz], 3, 3)
                dome(L, (x, y, tz), tr * 1.05, tr * 1.1, seg=8 if lod == 0 else 6, rings_n=2)
                if lod < 2:
                    alem(b, x, y, tz + tr * 1.05, h=1.8, r=0.1)
    # --- corner / side domes on the hall roof
    for x, y, dd, z in spec.get('corner_domes', []):
        rr = dd / 2
        loft(S, [ring(rr, 8 if lod < 2 else 6, c=(x, y))] * 2, [hh, z], 3, 3)
        dome(L, (x, y, z), rr, rr * 0.75, seg=max(6, seg // 2), rings_n=max(2, rn - 2))
    # --- side galleries (low domed porticos along the hall: revak)
    for x0, x1, y0, y1, gh, n in spec.get('side_galleries', []):
        extrude(S, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], -3.0, gh, 4, 4, top=False)
        L.polygon([(x0, y0, gh), (x1, y0, gh), (x1, y1, gh), (x0, y1, gh)])
        if lod < 2 and n:
            longx = abs(x1 - x0) > abs(y1 - y0)
            step = (abs(x1 - x0) if longx else abs(y1 - y0)) / n
            rr = min(step, abs(y1 - y0) if longx else abs(x1 - x0)) * 0.42
            for k in range(n):
                t = min(x0, x1) + step * (k + 0.5) if longx else min(y0, y1) + step * (k + 0.5)
                cx, cyy = (t, (y0 + y1) / 2) if longx else ((x0 + x1) / 2, t)
                dome(L, (cx, cyy, gh), rr, rr * 0.7, seg=8, rings_n=2)
        b.cbox((min(x0, x1), min(y0, y1), -3.0), (max(x0, x1), max(y0, y1), gh + 2))
    # --- courtyard (avlu): portico ring with small domes, walls, fountain
    if spec.get('court'):
        cw, cd, ccy, ch, nl, ns = spec['court']
        ax, ay = cw / 2, cd / 2
        pw = 7.0    # portico depth
        outer = [(-ax, ccy - ay), (ax, ccy - ay), (ax, ccy + ay), (-ax, ccy + ay)]
        extrude(W, outer, -3.0, ch, ts_u=6.0, ts_v=ch, top=False, v0=0.0)
        # portico roof ring (lead) + inner arcade face
        inner = [(-ax + pw, ccy - ay + pw), (ax - pw, ccy - ay + pw), (ax - pw, ccy + ay - pw), (-ax + pw, ccy + ay - pw)]
        for i in range(4):
            a0, a1 = outer[i], outer[(i + 1) % 4]
            b0, b1 = inner[i], inner[(i + 1) % 4]
            L.quad((a0[0], a0[1], ch), (a1[0], a1[1], ch), (b1[0], b1[1], ch), (b0[0], b0[1], ch))
        if lod < 2:
            # inner arcade wall (openings drawn by the window texture)
            for i in range(4):
                a0, a1 = inner[i], inner[(i + 1) % 4]
                W.quad((a1[0], a1[1], 0), (a0[0], a0[1], 0), (a0[0], a0[1], ch), (a1[0], a1[1], ch),
                       uv=[(0, 0), (math.hypot(a1[0] - a0[0], a1[1] - a0[1]) / 5, 0), (math.hypot(a1[0] - a0[0], a1[1] - a0[1]) / 5, 1.0), (0, 1.0)])
            # portico domes along the four sides
            rr = pw * 0.42
            for (xa, ya), (xb, yb), n in (((-ax + pw / 2, ccy - ay + pw / 2), (ax - pw / 2, ccy - ay + pw / 2), nl),
                                          ((-ax + pw / 2, ccy + ay - pw / 2), (ax - pw / 2, ccy + ay - pw / 2), nl),
                                          ((-ax + pw / 2, ccy - ay + pw / 2), (-ax + pw / 2, ccy + ay - pw / 2), ns),
                                          ((ax - pw / 2, ccy - ay + pw / 2), (ax - pw / 2, ccy + ay - pw / 2), ns)):
                for k in range(n):
                    t = (k + 0.5) / n
                    dome(L, (xa + (xb - xa) * t, ya + (yb - ya) * t, ch), rr, rr * 0.8, seg=8 if lod == 0 else 6, rings_n=2)
            # şadırvan (ablution fountain) in the middle
            loft(S, [ring(3.2, 8, c=(0, ccy))] * 2, [0, 3.0], 3, 3)
            dome(L, (0, ccy, 3.0), 3.6, 2.2, seg=8, rings_n=2)
        # courtyard floor (stone) so the court never shows terrain imagery artefacts from inside
        b['stone_plain'].polygon([(p[0], p[1], 0.05) for p in inner])
        b.cbox((-ax, ccy - ay, -3.0), (ax, ccy + ay, ch + 1.5))
    # --- minarets
    for m in spec.get('minarets', []):
        x, y, H, sh = m[:4]
        r = m[4] if len(m) > 4 else 1.7
        minaret(b, x, y, 0.0, H, r=r, sherefe=sh)
    # --- floodlight-free aviation lights on the minaret tips are not used (no obstruction lights on İstanbul mosques)
    return b
