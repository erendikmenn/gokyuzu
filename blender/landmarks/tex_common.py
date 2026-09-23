"""Procedural PBR textures shared by the landmark builders (numpy -> Blender images -> embedded in GLBs)."""
import math

import numpy as np

from lmkit import texture, fbm, blur, srgb, height_to_normal, rng


def srgb_to_linear(hexstr):
    c = srgb(hexstr)
    return tuple(float(v) for v in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))


# ---------------------------------------------------------------- International Orange paint (tile = 4 m x 4 m)
def paint_textures(base='#C0362C', name='ggb_paint', seed=11, size=1024, seams=True):
    def albedo():
        h = w = size
        c = srgb(base)
        low = fbm(h, w, seed, octaves=4, base=2)
        mid = fbm(h, w, seed + 1, octaves=5, base=8)
        hi = fbm(h, w, seed + 2, octaves=3, base=64)
        # touch-up patches: slightly different shades (the bridge is repainted in sections)
        patches = np.zeros((h, w))
        r = rng(seed + 3)
        for _ in range(7):
            x0, y0 = r.integers(0, w), r.integers(0, h)
            pw, ph = r.integers(w // 8, w // 3), r.integers(h // 10, h // 3)
            yy = (np.arange(h)[:, None] - y0) % h
            xx = (np.arange(w)[None, :] - x0) % w
            patches += ((yy < ph) & (xx < pw)) * r.uniform(-1, 1)
        patches = blur(patches, 2)
        # vertical weathering streaks
        streak = blur(np.tile(fbm(1, w, seed + 4, octaves=6, base=16), (h, 1)) * (0.5 + 0.5 * fbm(h, w, seed + 5, 3, 2)), 1)
        v = 1 + 0.07 * low + 0.035 * mid + 0.02 * hi - 0.05 * np.clip(streak, 0, None)
        img = c[None, None, :] * v[:, :, None]
        img[:, :, 0] *= 1 + 0.025 * patches
        img[:, :, 1] *= 1 - 0.05 * patches
        img[:, :, 2] *= 1 - 0.04 * patches
        # chalky oxidation lightening
        chalk = np.clip(fbm(h, w, seed + 6, 5, 4) - 0.25, 0, None) * 0.35
        img = img * (1 - chalk[:, :, None]) + np.array([0.80, 0.52, 0.45])[None, None, :] * chalk[:, :, None]
        if seams:
            sm = seam_mask(size)
            img *= (1 - 0.18 * sm[:, :, None])
        return img

    def rough():
        h = w = size
        r = 0.55 + 0.1 * fbm(h, w, seed + 7, 5, 4) + 0.04 * fbm(h, w, seed + 8, 3, 32)
        if seams:
            r += 0.1 * seam_mask(size)
        return np.stack([np.ones((h, w)), np.clip(r, 0.3, 0.9), np.zeros((h, w))], axis=2)

    def normal():
        h = w = size
        hm = 0.15 * fbm(h, w, seed + 9, 3, 64)      # orange peel
        if seams:
            hm += seam_height(size)
        return height_to_normal(hm, 3.0)

    a = texture(f'{name}_albedo', albedo, 'jpg')
    r = texture(f'{name}_orm', rough, 'jpg', colorspace='Non-Color')
    n = texture(f'{name}_normal', normal, 'png', colorspace='Non-Color')
    return a, r, n


def _seam_lines(size):
    """Plate seams of the 4 m tile: vertical every 2 m, horizontal every 4/3 m, staggered."""
    px = size / 4.0  # px per meter
    ys = [int(round(k * size / 3)) for k in range(3)]
    return px, ys


def seam_mask(size):
    px, ys = _seam_lines(size)
    m = np.zeros((size, size))
    w = max(1, int(px * 0.012))
    for y in ys:
        m[max(0, y - w):y + w + 1, :] = 1
    for band in range(3):
        y0, y1 = ys[band], (ys[band + 1] if band < 2 else size)
        x = int(round((band % 2) * size / 4 + size / 8))
        for xx in (x, (x + size // 2) % size):
            m[y0:y1, max(0, xx - w):xx + w + 1] = 1
    return blur(m, 1)


def seam_height(size):
    px, ys = _seam_lines(size)
    hmap = -0.6 * seam_mask(size)
    # rivet rows next to seams
    yy, xx = np.mgrid[0:size, 0:size]
    riv = np.zeros((size, size))
    step = int(px * 0.12)
    rr = px * 0.012
    for y in ys:
        for off in (-int(px * 0.05), int(px * 0.05)):
            cy = (y + off) % size
            for cx in range(0, size, step):
                y0, y1 = int(cy - 3 * rr), int(cy + 3 * rr) + 1
                x0, x1 = int(cx - 3 * rr), int(cx + 3 * rr) + 1
                sub_y, sub_x = yy[max(0, y0):y1, max(0, x0):x1], xx[max(0, y0):y1, max(0, x0):x1]
                d2 = (sub_y - cy) ** 2 + (sub_x - cx) ** 2
                riv[max(0, y0):y1, max(0, x0):x1] = np.maximum(riv[max(0, y0):y1, max(0, x0):x1], np.clip(1 - d2 / (rr * rr * 4), 0, 1))
    return hmap + 0.8 * riv


# ---------------------------------------------------------------- concrete (tile = 8 m)
def concrete_textures(name='concrete', base=(0.60, 0.58, 0.54), seed=21, size=1024, boards=0.6):
    if size < 1024:
        boards = 0
    def albedo():
        h = w = size
        low = fbm(h, w, seed, 4, 2)
        mid = fbm(h, w, seed + 1, 5, 8)
        hi = fbm(h, w, seed + 2, 2, 128)
        streak = blur(np.tile(fbm(1, w, seed + 3, 6, 32), (h, 1)) * np.clip(0.4 + fbm(h, w, seed + 4, 3, 2), 0, None), 1)
        v = 1 + 0.08 * low + 0.05 * mid + 0.05 * hi - 0.10 * np.clip(streak, 0, None)
        if boards:
            nb = int(8 / boards)
            lines = np.zeros((h, w))
            for k in range(nb):
                y = int(k * h / nb)
                lines[y:y + 2, :] = 1
            v -= 0.05 * blur(lines, 1)
        return np.array(base)[None, None, :] * v[:, :, None]

    def rough():
        h = w = size
        r = 0.85 + 0.08 * fbm(h, w, seed + 5, 4, 8)
        return np.stack([np.ones((h, w)), np.clip(r, 0.5, 1), np.zeros((h, w))], axis=2)

    def normal():
        h = w = size
        return height_to_normal(0.4 * fbm(h, w, seed + 6, 4, 32) + 0.2 * fbm(h, w, seed + 7, 2, 128), 2.0)

    return (texture(f'{name}_albedo', albedo, 'jpg'), texture(f'{name}_orm', rough, 'jpg', colorspace='Non-Color'),
            texture(f'{name}_normal', normal, 'png', colorspace='Non-Color'))


# ---------------------------------------------------------------- roadway (u across the carriageway, v along; tile 12.192 m)
def road_texture(name='ggb_road', lanes=6, width=18.6, seed=31, w=1024, h=1024, median=True, edge_yellow=False, edge_inset=0.25, base_v=0.085):
    def albedo():
        rr = rng(seed)
        base = base_v + 0.02 * fbm(h, w, seed, 5, 8) + 0.015 * fbm(h, w, seed + 1, 2, 128)
        img = np.stack([base, base * 1.0, base * 1.03], axis=2)
        # tire tracks (lighter polished) & oil drip (darker) per lane
        xs = np.arange(w) / w * width - (edge_inset - 0.25)
        lane_w = (width - 2 * (edge_inset - 0.25)) / lanes
        track = np.zeros(w)
        drip = np.zeros(w)
        for k in range(lanes):
            c = (k + 0.5) * lane_w
            for o in (-0.9, 0.9):
                track += np.exp(-((xs - c - o) / 0.35) ** 2)
            drip += np.exp(-((xs - c) / 0.4) ** 2)
        img *= (1 + 0.18 * track - 0.25 * drip * (0.6 + 0.4 * fbm(h, w, seed + 2, 3, 4)))[..., None] if False else 1
        img = img * (1 + 0.16 * track[None, :, None]) * (1 - 0.22 * drip[None, :, None] * np.clip(0.6 + 0.6 * fbm(h, w, seed + 2, 3, 4), 0, 1)[:, :, None])
        # lane lines: dashed (3.05 m dash of 12.19 m), 0.15 m wide
        px = w / width
        dash_rows = int(h * 3.05 / 12.192)
        paint = np.zeros((h, w))
        for k in range(1, lanes):
            if median and k == lanes // 2:
                continue
            x = int(((edge_inset - 0.25) + k * lane_w) * px)
            hw = max(1, int(0.075 * px))
            paint[:dash_rows, x - hw:x + hw + 1] = 1
        # solid edge lines
        for x in (int(edge_inset * px), int(w - edge_inset * px)):
            hw = max(1, int(0.075 * px))
            paint[:, x - hw:x + hw + 1] = 1
        wear = np.clip(0.75 + 0.35 * fbm(h, w, seed + 3, 5, 16), 0, 1)
        paint *= wear
        col = np.array([0.80, 0.80, 0.76]) if not edge_yellow else np.array([0.85, 0.7, 0.2])
        img = img * (1 - paint[..., None]) + col[None, None, :] * paint[..., None]
        # patch repairs
        for _ in range(3):
            y0, x0 = rr.integers(0, h), rr.integers(0, w)
            ph, pw = rr.integers(h // 12, h // 5), rr.integers(w // 20, w // 8)
            img[y0:y0 + ph, x0:x0 + pw] *= 0.8
        return img

    return texture(f'{name}_albedo', albedo, 'jpg')


# ---------------------------------------------------------------- sidewalk concrete (tile 3 m)
def walk_texture(name='walk', seed=41, size=512):
    def albedo():
        v = 0.55 + 0.04 * fbm(size, size, seed, 5, 8) + 0.03 * fbm(size, size, seed + 1, 2, 64)
        img = np.stack([v, v * 0.98, v * 0.94], axis=2)
        img[0:3, :] *= 0.7
        img[:, 0:2] *= 0.8
        return img
    return texture(f'{name}_albedo', albedo, 'jpg')


# ---------------------------------------------------------------- railing (alpha clip) tile 1.524 m wide x 1.4 m tall
def railing_texture(name='ggb_rail', color='#C0362C', seed=51, w=256, h=256):
    def albedo():
        c = srgb(color)
        a = np.zeros((h, w))
        # top rail + mid rail + bottom rail
        for y0, y1 in ((0, 14), (int(h * 0.55), int(h * 0.55) + 6), (h - 16, h - 6)):
            a[y0:y1, :] = 1
        # posts (balusters) every 1/8 of the tile, one heavy post at the tile edge
        for k in range(8):
            x = int(k * w / 8)
            a[:, x:x + 5] = 1
        a[:, 0:12] = 1
        v = 1 + 0.06 * fbm(h, w, seed, 3, 8)
        img = np.concatenate([c[None, None, :] * v[:, :, None], a[:, :, None]], axis=2)
        return img
    return texture(f'{name}_albedo', albedo, 'png', alpha=True)


# ---------------------------------------------------------------- Warren truss with verticals, one panel per tile (alpha)
def truss_texture(name='ggb_truss', color='#C0362C', seed=61, size=256, chord=0.13, vert=0.09, diag=0.08, lacing=True):
    def albedo():
        c = srgb(color)
        a = np.zeros((size, size))
        shade = np.ones((size, size))
        yy, xx = np.mgrid[0:size, 0:size] / size
        ch = chord
        a[(yy < ch) | (yy > 1 - ch)] = 1
        a[(xx < vert / 2) | (xx > 1 - vert / 2)] = 1
        # diagonal from bottom-left to top-right (tile repeats -> Warren alternation needs mirrored UV per panel)
        d = np.abs((xx - (1 - yy))) / math.sqrt(2)
        diag_mask = d < diag / 2
        a[diag_mask] = 1
        if lacing:
            # lattice lacing inside the members (darker lines)
            lat = (np.abs(((xx + yy) * 24) % 1 - 0.5) < 0.12) | (np.abs(((xx - yy) * 24) % 1 - 0.5) < 0.12)
            shade[lat & (a > 0)] = 0.8
        v = (1 + 0.05 * fbm(size, size, seed, 3, 4)) * shade
        img = np.concatenate([c[None, None, :] * v[:, :, None], a[:, :, None]], axis=2)
        return img
    return texture(f'{name}_albedo', albedo, 'png', alpha=True)


# ---------------------------------------------------------------- facades: window grids
def window_facade(name, size=1024, cols=4, rows=2, frame='#D9D6CC', glass='#1A2330', win_w=0.6, win_h=0.62, seed=91,
                  lit=0.18, recess=True, mullion_v=0, mullion_h=0, frame_rough=0.65, glass_rough=0.08, streaks=0.05,
                  sill=0.0, glass_var=0.08, h=None):
    """Tileable facade: cols x rows windows per tile. win_w/win_h: fraction of the cell. Returns albedo, orm, normal,
    emissive (night-lit windows) images."""
    H = h or size
    W = size
    r = rng(seed)
    cw, ch = W / cols, H / rows
    yy, xx = np.mgrid[0:H, 0:W]
    cx = (xx % cw) / cw
    cy = (yy % ch) / ch
    ix = (xx // cw).astype(int)
    iy = (yy // ch).astype(int)
    x0, x1 = (1 - win_w) / 2, (1 + win_w) / 2
    y0, y1 = (1 - win_h) / 2, (1 + win_h) / 2
    win = (cx > x0) & (cx < x1) & (cy > y0) & (cy < y1)
    if mullion_v:
        for k in range(1, mullion_v + 1):
            mx = x0 + (x1 - x0) * k / (mullion_v + 1)
            win &= np.abs(cx - mx) > 0.012
    if mullion_h:
        for k in range(1, mullion_h + 1):
            my = y0 + (y1 - y0) * k / (mullion_h + 1)
            win &= np.abs(cy - my) > 0.012
    fcol = srgb(frame)
    gcol = srgb(glass)
    # per-window variation (blinds, reflections)
    cellv = r.uniform(-1, 1, (rows, cols))
    blinds = r.uniform(0, 1, (rows, cols)) < 0.25
    litm = r.uniform(0, 1, (rows, cols)) < lit
    cv = cellv[iy % rows, ix % cols]
    bl = blinds[iy % rows, ix % cols]
    lm = litm[iy % rows, ix % cols]
    wall = fcol[None, None, :] * (1 + 0.05 * fbm(H, W, seed + 1, 4, 4)[:, :, None] - streaks * np.clip(fbm(H, W, seed + 2, 5, 16), 0, None)[:, :, None])
    g = gcol[None, None, :] * (1 + glass_var * cv[:, :, None])
    # blinds: lighter band in the upper part of some windows
    blind_band = bl & (cy < y0 + (y1 - y0) * 0.45)
    g = np.where(blind_band[:, :, None], g * 0.4 + np.array([0.55, 0.53, 0.48])[None, None, :] * 0.6, g)
    alb = np.where(win[:, :, None], g, wall)
    if sill:
        sillm = (cy > y1) & (cy < y1 + sill) & (cx > x0 - 0.02) & (cx < x1 + 0.02)
        alb = np.where(sillm[:, :, None], alb * 0.8, alb)
    rough = np.where(win, glass_rough, frame_rough) + 0.03 * fbm(H, W, seed + 3, 3, 8)
    orm = np.stack([np.ones((H, W)), np.clip(rough, 0.03, 1), np.where(win, 0.0, 0.0)], axis=2)
    hmap = np.where(win, -1.0, 0.0)
    hmap = blur(hmap, 1)
    nrm = height_to_normal(hmap, 1.5 if recess else 0.5)
    em = np.where((win & lm)[:, :, None], np.array([1.0, 0.78, 0.52])[None, None, :] * (0.7 + 0.3 * cv[:, :, None]), 0.0)
    a = texture(f'{name}_albedo', lambda: alb, 'jpg')
    o = texture(f'{name}_orm', lambda: orm, 'jpg', colorspace='Non-Color')
    n = texture(f'{name}_normal', lambda: nrm, 'jpg', colorspace='Non-Color')
    e = texture(f'{name}_emit', lambda: em, 'jpg')
    return a, o, n, e


def stripes(name, colors, size=256, horizontal=True, noise=0.04, seed=95):
    """Banded texture (e.g. red/white aviation marking). colors: list of hex, equal bands over the tile."""
    def f():
        img = np.zeros((size, size, 3))
        n = len(colors)
        for i, c in enumerate(colors):
            a, b = int(i * size / n), int((i + 1) * size / n)
            if horizontal:
                img[a:b, :, :] = srgb(c)
            else:
                img[:, a:b, :] = srgb(c)
        img *= (1 + noise * fbm(size, size, seed, 4, 4))[:, :, None]
        return img
    return texture(f'{name}_albedo', f, 'jpg')


def mesh_net_texture(name='ggb_net', size=128, cells=8, wire=0.12, color='#9EA3A6'):
    """Stainless wire-mesh net (alpha): diamond mesh, `cells` meshes per tile."""
    def f():
        yy, xx = np.mgrid[0:size, 0:size] / size
        a = (np.abs(((xx + yy) * cells) % 1 - 0.5) > 0.5 - wire / 2) | (np.abs(((xx - yy) * cells) % 1 - 0.5) > 0.5 - wire / 2)
        img = np.zeros((size, size, 4))
        img[:, :, :3] = srgb(color)
        img[:, :, 3] = a
        return img
    return texture(f'{name}_albedo', f, 'png', alpha=True)
