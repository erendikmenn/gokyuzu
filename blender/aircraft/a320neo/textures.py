"""Livery + material textures for the A320neo "Gökyüzü Hava Yolları" TC-GKA (fictional airline).

Run with the repo venv (PIL + numpy + scipy):  .venv/bin/python blender/aircraft/a320neo/textures.py [names...]
Writes blender/aircraft/a320neo/build/tex/* (GOKYUZU_TEX_OUT=<dir>: elsewhere).
Livery: the fictional 'gokyuzu' house livery below. LIVERY=<name> (or A320_LIVERY=<name>) paints a local livery module
instead, <brand dir>/liveries/a320neo/<name>.py (outside git, blender/common/brand.py). A livery module may provide:
  fuselage_side(T, side) -> Side canvas     tail(T)     nacelle(T)          (T = this module; each replaces that part)
  TAIL_SOOT (tail-cone soot, 0.55)   BELLY_COLOR / BELLY_JOINT (sRGB)   REG_PLATE (cockpit_layout.py)
The fuselage livery is designed on two side-view canvases (meters,
nose left / nose right) and projected laterally onto the fuselage UV layout (u = s / L, v = theta / 2pi, see
layout.py); cockpit window frames are painted directly in UV space. Wing/HT use planform-projection UVs, the fin
and sharklets side-projection UVs (see wing.py / empennage.py).
"""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(HERE, '..', '..', 'common'))
import layout as LY  # noqa: E402
import brand  # noqa: E402

OUT = os.environ.get('GOKYUZU_TEX_OUT') or os.path.join(HERE, 'build', 'tex')
os.makedirs(OUT, exist_ok=True)
RNG = np.random.default_rng(320)
LIV = brand.livery_module('a320neo', 'A320_LIVERY')     # None: the built-in fictional livery

FONT_AV = '/System/Library/Fonts/Avenir Next.ttc'
FONT_HN = '/System/Library/Fonts/HelveticaNeue.ttc'
FONT_DIN = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'

# palette (sRGB)
WHITE = (244, 246, 248)
BLUE = (14, 38, 96)          # deep "gökyüzü" blue
BLUE2 = (22, 64, 142)        # lighter accent blue
ORANGE = (242, 128, 28)
GREY_WING = (182, 187, 193)
GREY_LOW = (192, 196, 201)
DARK = (34, 38, 43)


def font(path, size, index=0):
    return ImageFont.truetype(path, int(size), index=index)


def save_jpg(img, name, q=90):
    p = os.path.join(OUT, name)
    img.convert('RGB').save(p, quality=q, optimize=True, subsampling=0)
    print('wrote', name, img.size, os.path.getsize(p) // 1024, 'KB')


def save_png(img, name):
    p = os.path.join(OUT, name)
    img.save(p, optimize=True)
    print('wrote', name, img.size, os.path.getsize(p) // 1024, 'KB')


def noise(h, w, scale, seed=0, octaves=3):
    """Smooth value noise in [0,1]."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((h, w))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        gh, gw = max(2, int(h / scale) + 2), max(2, int(w / scale) + 2)
        g = rng.random((gh, gw))
        z = ndimage.zoom(g, (h / (gh - 1), w / (gw - 1)), order=3)[:h, :w]
        acc += z * amp
        tot += amp
        amp *= 0.5
        scale /= 2.2
    acc /= tot
    return (acc - acc.min()) / (np.ptp(acc) + 1e-9)


def normal_from_height(h, strength=2.0):
    gy, gx = np.gradient(h.astype(np.float32))
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(h, dtype=np.float32)
    n = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / n, ny / n, nz / n], -1) * 0.5 + 0.5
    return Image.fromarray((rgb * 255).clip(0, 255).astype(np.uint8))


def rounded_rect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


# ================================================================================================ fuselage
PPM = 240                    # side canvas pixels per meter
S0, S1 = -0.3, 37.9
Z0, Z1 = -2.35, 2.35
CW, CH = int((S1 - S0) * PPM), int((Z1 - Z0) * PPM)


def belly_line(s):
    """Height of the white/blue boundary (top of the orange stripe gap) along the fuselage."""
    ss = [0.0, 0.8, 2.0, 4.0, 7.0, 12.0, 20.0, 24.0, 26.5, 28.5, 30.5, 32.5, 34.5, 38.0]
    zz = [-1.55, -1.25, -0.98, -0.78, -0.62, -0.55, -0.52, -0.46, -0.25, 0.20, 0.95, 1.65, 2.3, 2.6]
    from scipy.interpolate import PchipInterpolator
    return PchipInterpolator(ss, zz)(s)


class Side:
    """Side-view canvas in meters. side=-1: left (nose on the left), side=+1: right (nose on the right)."""

    def __init__(self, side, bg=WHITE):
        self.side = side
        self.img = Image.new('RGB', (CW, CH), bg)
        self.d = ImageDraw.Draw(self.img)
        self.h = Image.new('L', (CW, CH), 128)        # height (panel lines / outlines) for the normal map
        self.hd = ImageDraw.Draw(self.h)
        self.m = Image.new('L', (CW, CH), 0)          # gloss mask (windows = glossy)
        self.md = ImageDraw.Draw(self.m)

    def px(self, s, z):
        x = (s - S0) * PPM if self.side < 0 else (S1 - s) * PPM
        return x, (Z1 - z) * PPM

    def rect(self, s0, s1, z0, z1):
        xa, ya = self.px(s0, z1)
        xb, yb = self.px(s1, z0)
        return (min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb))

    def poly(self, pts):
        return [self.px(s, z) for s, z in pts]


def hook(name):
    """The livery module's replacement for a built-in part, or None."""
    return getattr(LIV, name, None)


def draw_fuselage_side(side):
    if hook('fuselage_side'):
        return LIV.fuselage_side(sys.modules[__name__], side)
    C = Side(side)
    d = C.d
    # ---- belly blue + orange pinstripe (stripe separated from the blue by a thin white gap)
    ss = np.linspace(S0, S1, 800)
    zb = belly_line(ss)
    blue_poly = [(s, z) for s, z in zip(ss, zb)] + [(S1, Z0 - 1), (S0, Z0 - 1)]
    d.polygon(C.poly(blue_poly), fill=BLUE)
    stripe_lo = [(s, z + 0.045) for s, z in zip(ss, zb)]
    stripe_hi = [(s, z + 0.045 + 0.10 * (1 + 0.25 * np.clip((s - 24) / 8, 0, 1))) for s, z in zip(ss, zb)]
    d.polygon(C.poly(stripe_lo + stripe_hi[::-1]), fill=ORANGE)
    # thin lighter-blue sweep inside the blue at the rear (depth)
    sw_lo = [(s, z - 0.30 - 0.25 * np.clip((s - 22) / 10, 0, 1)) for s, z in zip(ss, zb) if s > 21]
    sw_hi = [(s, z - 0.16) for s, z in zip(ss, zb) if s > 21]
    if sw_lo:
        d.polygon(C.poly(sw_lo + sw_hi[::-1]), fill=BLUE2)
    # ---- radome: slightly warmer grey-white, seam at s = 1.25, lightning diverter strips
    top, bot, hw = LY.prof(1.25)
    rad = [(s, z) for s, z in zip(np.linspace(0, 1.25, 60), np.linspace(0, 0, 60))]
    d.rectangle(C.rect(-0.3, 1.25, -0.2, 2.35), fill=(236, 237, 236))
    for zz in (-0.15, 0.10, 0.32):
        d.line(C.poly([(0.05, zz * 0.3), (1.22, zz)]), fill=(150, 150, 150), width=2)
    d.line(C.poly([(1.25, -2.4), (1.25, 2.4)]), fill=(120, 124, 128), width=3)
    # re-apply blue under the radome where the belly line is (radome bottom is blue too)
    blue_nose = [(s, z) for s, z in zip(ss, zb) if s < 1.3] + [(1.3, Z0 - 1), (S0, Z0 - 1)]
    d.polygon(C.poly(blue_nose), fill=BLUE)
    # ---- cabin windows
    for s in LY.CABIN_WINDOWS:
        window(C, s)
    # ---- doors and exits
    for name, sc, w, zb0, zt0, sides, r in LY.DOORS:
        if side not in sides:
            continue
        door(C, name, sc, w, zb0, zt0, r)
    for s in LY.EXIT_WINDOWS:
        window(C, s)
    # ---- titles: "Gökyüzü" + "HAVA YOLLARI"
    titles(C)
    # ---- registration (white on the blue tail sweep) and flag
    reg = 'TC-GKA'
    f = font(FONT_HN, 0.52 * PPM, 1)
    tw = f.getlength(reg)
    s_c = 31.6
    x, y = C.px(s_c, 0.06)
    d.text((x - tw / 2, y - 0.55 * PPM), reg, font=f, fill=(250, 250, 250))
    flag(C, 27.9, 1.18, 0.62)
    # ---- small placards / markings
    placards(C)
    # ---- aircraft name under the cockpit
    fn = font(FONT_AV, 0.17 * PPM, 1)
    nm = 'Kapadokya'
    x, y = C.px(3.35, 0.10)
    tw = fn.getlength(nm)
    d.text((x - tw / 2, y), nm, font=fn, fill=BLUE)
    panel_lines(C)
    return C


def window(C, s):
    w, h, r = LY.WIN_W, LY.WIN_H, 0.085
    z = LY.WIN_Z
    fr = 0.022
    box = C.rect(s - w / 2 - fr, s + w / 2 + fr, z - h / 2 - fr, z + h / 2 + fr)
    rounded_rect(C.d, box, r * PPM, fill=(208, 212, 216))
    box2 = C.rect(s - w / 2, s + w / 2, z - h / 2, z + h / 2)
    rounded_rect(C.d, box2, (r - 0.015) * PPM, fill=(28, 33, 39))
    # soft reflection gradient inside the glass
    x0, y0, x1, y1 = [int(v) for v in box2]
    g = np.linspace(0, 1, max(1, y1 - y0))
    for k, yy in enumerate(range(y0, y1)):
        c = int(28 + 26 * (1 - g[k]) ** 2)
        C.d.line([(x0 + 3, yy), (x1 - 3, yy)], fill=(c, c + 5, c + 11))
    rounded_rect(C.d, box2, (r - 0.015) * PPM, outline=(20, 24, 28), width=2)
    rounded_rect(C.md, box2, (r - 0.015) * PPM, fill=255)
    rounded_rect(C.hd, box, r * PPM, outline=100, width=3)


def door(C, name, sc, w, zb, zt, r):
    d = C.d
    col = (118, 124, 132)
    lw = max(2, int(0.011 * PPM))
    box = C.rect(sc - w / 2, sc + w / 2, zb, zt)
    rounded_rect(d, box, r * PPM, outline=col, width=lw)
    rounded_rect(C.hd, box, r * PPM, outline=40, width=lw + 2)
    if name.startswith('door'):
        # door window
        window(C, sc + 0.02 * C.side * 0)
        # handle recess + flap and the orange arrow "open" placard
        hx = sc + (0.20 if C.side < 0 else -0.20) * (1 if name == 'door_1' else 1)
        hb = C.rect(hx - 0.07, hx + 0.07, 0.30, 0.40)
        rounded_rect(d, hb, 0.02 * PPM, outline=(90, 95, 100), width=2, fill=(226, 228, 230))
        f = font(FONT_HN, 0.055 * PPM, 4)
        x, y = C.px(sc, -0.05)
        tw = f.getlength('EMERGENCY EXIT')
        d.text((x - tw / 2, y), 'EMERGENCY EXIT', font=f, fill=(200, 40, 30))
        # evacuation slide bustle outline below the door
        sb = C.rect(sc - 0.28, sc + 0.28, zb - 0.22, zb - 0.06)
        rounded_rect(d, sb, 0.03 * PPM, outline=(150, 154, 160), width=2)
    elif name.startswith('exit'):
        f = font(FONT_HN, 0.05 * PPM, 4)
        x, y = C.px(sc, zt + 0.11)
        tw = f.getlength('EXIT')
        d.text((x - tw / 2, y), 'EXIT', font=f, fill=(200, 40, 30))
        hb = C.rect(sc - 0.05, sc + 0.05, zt - 0.14, zt - 0.08)
        rounded_rect(d, hb, 0.015 * PPM, fill=(210, 60, 40))
    else:   # cargo doors: hinge line on top + handle panel
        z = zt - 0.04
        d.line(C.poly([(sc - w / 2 + 0.05, z), (sc + w / 2 - 0.05, z)]), fill=(135, 140, 146), width=2)
        hb = C.rect(sc - 0.14, sc + 0.14, zb + 0.10, zb + 0.22)
        rounded_rect(d, hb, 0.02 * PPM, outline=(170, 175, 180), width=2)


def titles(C):
    d = C.d
    # main title
    t = 'Gökyüzü'
    f = font(FONT_AV, 1.02 * PPM, 8)           # Avenir Next Heavy
    tw = f.getlength(t)
    s_start = 7.3
    z_base = 1.00
    asc = f.getbbox('G')[1]
    if C.side < 0:
        x, y = C.px(s_start, z_base)
        x0 = x
    else:
        x, y = C.px(s_start, z_base)
        x0 = x - tw
    top_y = C.px(0, z_base + 0.78)[1]
    d.text((x0, top_y - asc), t, font=f, fill=BLUE)
    # sub-title, letter spaced, orange, right after the main title on the same baseline
    sub = 'HAVA YOLLARI'
    fs = font(FONT_AV, 0.34 * PPM, 0)
    sp = 0.055 * PPM
    widths = [fs.getlength(ch) for ch in sub]
    total = sum(widths) + sp * (len(sub) - 1)
    gap = 0.28 * PPM
    if C.side < 0:
        xs = x0 + tw + gap
    else:
        xs = x0 - gap - total
    yb = C.px(0, z_base + 0.26)[1] - fs.getbbox('H')[1]
    for ch, wch in zip(sub, widths):
        d.text((xs, yb), ch, font=fs, fill=BLUE2)
        xs += wch + sp


def flag(C, s, z, w):
    """Turkish flag (ratio 3:2), crescent and star, centred at (s, z)."""
    h = w * 2 / 3
    x0, y0, x1, y1 = C.rect(s - w / 2, s + w / 2, z - h / 2, z + h / 2)
    W, H = int(x1 - x0), int(y1 - y0)
    im = Image.new('RGB', (W * 4, H * 4), (227, 10, 23))
    dd = ImageDraw.Draw(im)
    G = H * 4
    cx, cy = 0.5 * G, 0.5 * G           # outer crescent centre at 1/2 G from the hoist
    ro = 0.25 * G
    dd.ellipse([cx - ro, cy - ro, cx + ro, cy + ro], fill=(255, 255, 255))
    ci = cx + 0.0625 * G
    ri = 0.2 * G
    dd.ellipse([ci - ri, cy - ri, ci + ri, cy + ri], fill=(227, 10, 23))
    sx = cx + 0.333 * G + 0.0625 * G * 0 - 0.02 * G
    rs = 0.125 * G
    pts = []
    for k in range(10):
        a = -math.pi / 2 + k * math.pi / 5 + math.pi / 2 * 0
        r = rs if k % 2 == 0 else rs * 0.382
        ang = math.radians(-90) + k * math.pi / 5 + math.radians(90) * 0
        pts.append((sx + r * math.cos(ang + math.pi / 2 * 0), cy + r * math.sin(ang)))
    # rotate star so one point faces the hoist (left)
    rot = [(sx + (px - sx) * math.cos(-math.pi / 2) - (py - cy) * math.sin(-math.pi / 2),
            cy + (px - sx) * math.sin(-math.pi / 2) + (py - cy) * math.cos(-math.pi / 2)) for px, py in pts]
    dd.polygon(rot, fill=(255, 255, 255))
    im = im.resize((W, H), Image.LANCZOS)
    if C.side > 0:
        im = im.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_LEFT_RIGHT)   # flags read hoist-first
    C.img.paste(im, (int(x0), int(y0)))


def placards(C):
    d = C.d
    f = font(FONT_HN, 0.045 * PPM, 4)
    # static ports (red outline) and pitot no-step
    for sc, z in ((4.62, -0.85),):
        b = C.rect(sc - 0.16, sc + 0.16, z - 0.12, z + 0.12)
        d.rectangle(b, outline=(200, 30, 30), width=3)
    x, y = C.px(2.55, -0.05)
    d.text((x, y), 'NO STEP', font=f, fill=(90, 90, 90))
    # ground power / servicing panels (outlines)
    for sc, zc, w, h in ((3.9, -1.35, 0.35, 0.25), (6.4, -1.65, 0.45, 0.30), (24.0, -1.55, 0.40, 0.30),
                         (10.2, -1.8, 0.5, 0.25), (20.6, -1.75, 0.42, 0.25)):
        b = C.rect(sc - w / 2, sc + w / 2, zc - h / 2, zc + h / 2)
        rounded_rect(d, b, 0.02 * PPM, outline=(70, 80, 105), width=2)
        rounded_rect(C.hd, b, 0.02 * PPM, outline=70, width=3)


FRAMES = [1.25, 2.95, 4.10, 6.05, 8.95, 10.95, 12.40, 13.95, 17.35, 19.00, 21.35, 24.35, 26.95, 29.05, 31.20, 33.05,
          35.40]


def panel_lines(C):
    """Circumferential skin joints (projected lines) + lap joints; drawn lightly in colour and in the height map."""
    for s in FRAMES:
        x, _ = C.px(s, 0)
        C.d.line([(x, 0), (x, CH)], fill=None, width=0) if False else None
        C.hd.line([(x, 0), (x, CH)], fill=70, width=3)
    for z in (1.55, -0.05, -1.25):
        y = C.px(0, z)[1]
        C.hd.line([(0, y), (CW, y)], fill=90, width=2)
    # window belt doublers
    for z in (LY.WIN_Z + 0.30, LY.WIN_Z - 0.30):
        y = C.px(0, z)[1]
        x0 = C.px(5.9, 0)[0]
        x1 = C.px(28.0, 0)[0]
        C.hd.line([(min(x0, x1), y), (max(x0, x1), y)], fill=95, width=2)


def fuselage():
    W, H = 4096, 2048
    left = draw_fuselage_side(-1)
    right = draw_fuselage_side(+1)
    # pixel grid -> (s, theta) -> (y, z)
    u = (np.arange(W) + 0.5) / W
    v = 1 - (np.arange(H) + 0.5) / H
    S = u[None, :] * LY.L_FUS * np.ones((H, 1))
    T = v[:, None] * 2 * math.pi * np.ones((1, W))
    Yy, Zz = LY.surface(S, T)
    col = np.zeros((H, W, 3), np.float32)
    hgt = np.zeros((H, W), np.float32)
    gloss = np.zeros((H, W), np.float32)
    for C in (left, right):
        mask = (Yy < 0) if C.side < 0 else (Yy >= 0)
        cx = ((S - S0) * PPM) if C.side < 0 else ((S1 - S) * PPM)
        cy = (Z1 - Zz) * PPM
        arr = np.asarray(C.img, dtype=np.float32)
        ha = np.asarray(C.h, dtype=np.float32)
        ga = np.asarray(C.m, dtype=np.float32)
        coords = [cy[mask], cx[mask]]
        for k in range(3):
            col[..., k][mask] = ndimage.map_coordinates(arr[..., k], coords, order=1, mode='nearest')
        hgt[mask] = ndimage.map_coordinates(ha, coords, order=1, mode='nearest')
        gloss[mask] = ndimage.map_coordinates(ga, coords, order=1, mode='nearest')
    # ---- cockpit window frames painted in UV space (dark seal band around each opening)
    img = Image.fromarray(col.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    hm = Image.fromarray(hgt.clip(0, 255).astype(np.uint8))
    hd = ImageDraw.Draw(hm)
    for side in (1, -1):
        for wn in ('ws', 'slide', 'fixed'):
            prm = LY.ck_window_params(wn, side)
            # densify edges
            pts = []
            for k in range(len(prm)):
                a, b = np.array(prm[k]), np.array(prm[(k + 1) % len(prm)])
                for t in np.linspace(0, 1, 12, endpoint=False):
                    p = a + (b - a) * t
                    pts.append((p[0] / LY.L_FUS * W, (1 - p[1] / (2 * math.pi)) * H))
            c = np.mean(pts, 0)
            # outer frame (grow ~6 cm): scale around the centre in metric-ish units
            grow = []
            for x, y in pts:
                dx, dy = x - c[0], y - c[1]
                n = math.hypot(dx / 109.0, dy / 230.0) + 1e-9
                grow.append((x + dx / n / 109.0 * 0.065 * 109, y + dy / n / 230.0 * 0.065 * 230))
            d.polygon(grow, fill=(36, 39, 44))
            d.polygon(pts, fill=(12, 14, 16))
    col = np.asarray(img, dtype=np.float32)
    hgt = np.asarray(hm, dtype=np.float32)
    # ---- weathering: subtle grime on the lower fuselage, soot at the tail cone, drain streaks
    n1 = noise(H, W, 180, seed=1)
    n2 = noise(H, W, 40, seed=2)
    lower = np.clip((-Zz - 0.6) / 1.4, 0, 1)
    grime = lower * (0.05 + 0.07 * n1) + 0.02 * n2
    col *= (1 - grime[..., None])
    soot = np.clip((S - 35.2) / 2.2, 0, 1) ** 1.5 * (0.55 + 0.3 * n1)
    sk = getattr(LIV, 'TAIL_SOOT', 0.55)
    col = col * (1 - soot[..., None] * sk) + np.array([35, 33, 30]) * soot[..., None] * sk
    # streaks aft of the belly fairing / drain masts
    for s0, z0 in ((23.9, -1.9), (12.0, -1.95), (26.4, -1.65)):
        st = np.exp(-((Zz - z0 - (S - s0) * 0.015) / 0.12) ** 2) * np.clip((S - s0) / 0.5, 0, 1) * np.exp(-np.clip(S - s0, 0, None) / 4.0)
        col *= (1 - 0.10 * st[..., None])
    # general paint variation
    col *= (0.985 + 0.03 * n2[..., None])
    save_jpg(Image.fromarray(col.clip(0, 255).astype(np.uint8)), 'fuselage_color.jpg', q=90)
    # ---- ORM (R: occlusion 1, G: roughness, B: metallic)
    rough = 0.34 + 0.10 * n1 + 0.10 * lower + 0.25 * soot
    rough = rough * (1 - gloss / 255) + 0.06 * (gloss / 255)
    orm = np.stack([np.full_like(rough, 1.0), rough, np.zeros_like(rough)], -1)
    save_png(Image.fromarray((orm * 255).clip(0, 255).astype(np.uint8)).resize((2048, 1024), Image.LANCZOS),
             'fuselage_orm.png')
    # ---- normal map from the height lines (grooves) + faint rivet rows along the frames
    hh = (hgt - 128) / 128.0
    hh = ndimage.gaussian_filter(hh, 0.7)
    save_png(normal_from_height(hh, strength=3.0), 'fuselage_normal.png')


# ================================================================================================ wing / HT
def wing():
    """Planform textures: u <- |y| in [0.8, 18]; upper surface v in [0.5, 1] (s 10.8..24 up), lower v in [0, 0.5]."""
    import importlib
    W, H = 4096, 4096
    U0, U1, VS0, VS1 = 0.8, 18.0, 10.8, 24.0
    ppm_u = W / (U1 - U0)
    ppm_v = (H / 2) / (VS1 - VS0)

    def P_up(y, s):
        return ((y - U0) * ppm_u, (H / 2) - (s - VS0) * ppm_v)       # upper half (rows 0..H/2): v 1 -> 0.5

    def P_lo(y, s):
        return ((y - U0) * ppm_u, H / 2 + (s - VS0) * ppm_v)          # lower half: v 0.5 -> 0 as s increases

    img = Image.new('RGB', (W, H), GREY_WING)
    d = ImageDraw.Draw(img)
    hm = Image.new('L', (W, H), 128)
    hd = ImageDraw.Draw(hm)
    met = Image.new('L', (W, H), 0)
    md = ImageDraw.Draw(met)
    d.rectangle([0, H / 2, W, H], fill=GREY_LOW)
    ys = np.linspace(U0, U1, 400)
    le = LY.wing_le(ys)
    te = LY.wing_te(ys)
    c = te - le
    import wing_layout as WL
    for P, upper in ((P_up, True), (P_lo, False)):
        # metallic leading-edge band (slats + fixed LE): 0 .. 0.07c upper, 0 .. 0.05c lower
        fr = 0.075 if upper else 0.05
        band = [P(y, s) for y, s in zip(ys, le - 0.02)] + [P(y, s) for y, s in zip(ys[::-1], (le + fr * c)[::-1])]
        d.polygon(band, fill=(200, 203, 207))
        md.polygon(band, fill=255)
        # spars / skin joints
        for xc in (0.15, 0.62):
            pts = [P(y, s) for y, s in zip(ys, le + xc * c)]
            hd.line(pts, fill=80, width=3)
            d.line(pts, fill=tuple(int(v * 0.93) for v in (GREY_WING if upper else GREY_LOW)), width=2)
        # rib lines
        for yr in np.arange(2.2, 16.2, 0.62):
            l0, t0 = LY.wing_le(yr), float(LY.wing_te(yr))
            cc = t0 - l0
            a, b = P(yr, l0 + 0.15 * cc), P(yr, l0 + 0.62 * cc)
            hd.line([a, b], fill=100, width=2)
        # moving surface outlines (slats, flaps, spoilers, aileron) — from the same layout as wing.py
        for (y0, y1) in WL.SLATS:
            outline_span(d, hd, P, y0, y1, 0.0, WL.XS if upper else 0.075, upper)
        for (y0, y1) in WL.FLAPS:
            outline_span(d, hd, P, y0, y1, (0.835 if upper else 0.72), 1.0, upper)
        if upper:
            for (y0, y1) in WL.SPOILERS:
                outline_span(d, hd, P, y0, y1, 0.62, 0.835, upper, fill=tuple(int(v * 0.96) for v in GREY_WING))
        outline_span(d, hd, P, WL.AILERON[0], WL.AILERON[1], 0.745, 1.0, upper)
        if not upper:
            # fuel tank access panels (ovals) along the lower surface, landing light, drain masts
            for yy in np.arange(2.8, 15.5, 1.05):
                l0, t0 = LY.wing_le(yy), float(LY.wing_te(yy))
                sc = l0 + 0.40 * (t0 - l0)
                x, y = P(yy, sc)
                rx, ry = 0.18 * ppm_u, 0.11 * ppm_v
                d.ellipse([x - rx, y - ry, x + rx, y + ry], outline=(150, 154, 160), width=2)
                hd.ellipse([x - rx, y - ry, x + rx, y + ry], outline=80, width=3)
    # walkway on the upper inboard wing (black outline) + NO STEP stencils
    wk = [(2.25, 14.4), (5.2, 15.6), (5.2, 17.2), (2.25, 17.2)]
    d.line([P_up(y, s) for y, s in wk + wk[:1]], fill=(25, 25, 25), width=5)
    f = font(FONT_HN, 0.11 * ppm_u, 4)
    # (no 'NO STEP' lettering: both wings share this planform texture, so text would read mirrored on one side)
    for yy, ss in ():
        x, y = P_up(yy, ss)
        txt = Image.new('L', (int(f.getlength('NO STEP')) + 4, int(0.14 * ppm_u)), 0)
        ImageDraw.Draw(txt).text((2, 0), 'NO STEP', font=f, fill=255)
        txt = txt.rotate(90, expand=True)
        img.paste((60, 60, 60), (int(x), int(y)), txt)
    arr = np.asarray(img, dtype=np.float32)
    n1 = noise(H, W, 200, seed=5)
    arr *= (0.975 + 0.05 * n1[..., None])
    # exhaust soot on the lower surface / flaps behind the engines (y ~ 5.75)
    yy = U0 + (np.arange(W) + 0.5) / ppm_u
    soot_y = np.exp(-((yy - LY.ENG_Y) / 0.9) ** 2)
    rows = np.arange(H)
    s_lo = VS0 + (rows - H / 2) / ppm_v
    soot_s = np.clip((s_lo - 16.5) / 2.0, 0, 1)[:, None] * (rows >= H / 2)[:, None]
    soot = soot_y[None, :] * soot_s * 0.16
    arr = arr * (1 - soot[..., None]) + np.array([40, 38, 36]) * soot[..., None]
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'wing_color.jpg', q=88)
    metal = np.asarray(met, dtype=np.float32) / 255
    rough = 0.42 + 0.12 * n1 - 0.22 * metal + 0.2 * soot
    orm = np.stack([np.ones_like(rough), rough, metal * 0.95], -1)
    save_png(Image.fromarray((orm * 255).clip(0, 255).astype(np.uint8)).resize((2048, 2048), Image.LANCZOS), 'wing_orm.png')
    hh = (np.asarray(hm, dtype=np.float32) - 128) / 128.0
    save_png(normal_from_height(ndimage.gaussian_filter(hh, 0.8), 2.5).resize((2048, 2048), Image.LANCZOS), 'wing_normal.png')


def outline_span(d, hd, P, y0, y1, x0, x1, upper, fill=None):
    ys = np.linspace(y0, y1, 30)
    le, te = LY.wing_le(ys), LY.wing_te(ys)
    c = te - le
    a = [P(y, s) for y, s in zip(ys, le + x0 * c)]
    b = [P(y, s) for y, s in zip(ys, le + x1 * c)]
    poly = a + b[::-1]
    if fill is not None:
        d.polygon(poly, fill=fill)
    d.line(poly + poly[:1], fill=(120, 124, 130), width=3)
    hd.line(poly + poly[:1], fill=50, width=4)


def htail():
    W, H = 2048, 2048
    img = Image.new('RGB', (W, H), GREY_WING)
    d = ImageDraw.Draw(img)
    # u = (|y| - 0.6) / 6.0 ; v: upper 0.5 + 0.5 * (s - 31.6)/5.6, lower 0.5 * (1 - (s-31.6)/5.6)
    def P(y, s, upper):
        u = (y - 0.6) / 6.0
        vv = (s - 31.6) / 5.6
        v = 0.5 + 0.5 * vv if upper else 0.5 * (1 - vv)
        return (u * W, (1 - v) * H)
    ys = np.linspace(0.7, 6.3, 60)
    le = 32.11 + 0.7235 * (ys - 1.35)
    te = 35.70 + 0.22 * (ys - 1.34)
    for up in (True, False):
        band = [P(y, s - 0.02, up) for y, s in zip(ys, le)] + [P(y, s, up) for y, s in zip(ys[::-1], (le + 0.07 * (te - le))[::-1])]
        d.polygon(band, fill=(202, 205, 209))
        hinge = [P(y, s, up) for y, s in zip(ys, le + np.interp(ys, [1.35, 6.225], [0.70, 0.62]) * (te - le))]
        d.line(hinge, fill=(125, 128, 134), width=4)
    arr = np.asarray(img, dtype=np.float32) * (0.975 + 0.05 * noise(H, W, 150, seed=9)[..., None])
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'htail_color.jpg', q=88)


# ================================================================================================ tail (fin + sharklets)
def tail():
    if hook('tail'):
        return LIV.tail(sys.modules[__name__])
    W, H = 4096, 2048
    img = Image.new('RGB', (W, H), BLUE)
    d = ImageDraw.Draw(img)
    # fin: u right face = 0.39 * (1 - su), left face = 0.40 + 0.39 * su, su = (s - 27.8) / 9.4 ; v = (z - 1.4) / 7.0
    def P(s, z, right):
        su = (s - 27.8) / 9.4
        u = 0.39 * (1 - su) if right else 0.40 + 0.39 * su
        return (u * W, (1 - (z - 1.4) / 7.0) * H)
    import empennage_layout as EL
    for right in (True, False):
        # orange sweep along the lower rear of the fin + a light-blue band
        sw = [(29.0, 1.4), (33.5, 1.4), (37.3, 3.6), (37.3, 4.4), (33.0, 2.25), (29.0, 2.05)]
        d.polygon([P(s, z, right) for s, z in sw], fill=BLUE2)
        sw2 = [(29.0, 2.05), (33.0, 2.25), (37.3, 4.4), (37.3, 4.75), (33.0, 2.50), (29.0, 2.28)]
        d.polygon([P(s, z, right) for s, z in sw2], fill=ORANGE)
        logo(img, P, right)
        # rudder hinge line + panel lines
        zz = np.linspace(2.38, 8.1, 20)
        d.line([P(33.77 + 0.416 * (z - 2.38), z, right) for z in zz], fill=(8, 26, 70), width=4)
        for z in (3.4, 4.6, 5.8, 7.0):
            d.line([P(EL.fin_le(z) + 0.25, z, right), P(33.77 + 0.416 * (z - 2.38) - 0.05, z, right)], fill=(10, 30, 80), width=2)
        # tip cap slightly darker, LE erosion (lighter)
        d.line([P(EL.fin_le(z), z, right) for z in np.linspace(3.4, 7.9, 30)], fill=(60, 80, 120), width=10)
    # sharklet region: u 0.80..0.99 ; v = 0.01 + 0.23 * h / 2.6 (+0.25 for the inboard face)
    sx0 = int(0.80 * W)
    d.rectangle([sx0, 0, W, H], fill=BLUE)
    for base in (0.0, 0.25):
        # orange tip band (top 20 %) and a thin white line
        v_top = 0.01 + 0.23 * 1.0 + base
        v_band = 0.01 + 0.23 * 0.80 + base
        y_top, y_band = (1 - v_top) * H, (1 - v_band) * H
        d.rectangle([sx0, y_top - 20, W, y_band], fill=ORANGE)
        d.rectangle([sx0, y_band, W, y_band + 10], fill=(245, 245, 245))
        # small sun logo
        cx, cy = (0.80 + 0.19 * (22.0 - 20.4) / 3.0) * W, (1 - (0.01 + 0.23 * 0.45 + base)) * H
        r = 55
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ORANGE)
    arr = np.asarray(img, dtype=np.float32) * (0.985 + 0.03 * noise(H, W, 160, seed=11)[..., None])
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'tail_color.jpg', q=90)
    rough = 0.30 + 0.08 * noise(H // 2, W // 2, 90, seed=12)
    orm = np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1)
    save_png(Image.fromarray((orm * 255).astype(np.uint8)), 'tail_orm.png')


def logo(img, P, right):
    """'Gökyüzü' emblem on the fin: a rising orange sun cut by three white sky swooshes."""
    cs, cz = 34.25, 5.05
    R = 1.28
    x0, y0 = P(cs - R, cz + R, right)
    x1, y1 = P(cs + R, cz - R, right)
    bx0, bx1 = min(x0, x1), max(x0, x1)
    by0, by1 = min(y0, y1), max(y0, y1)
    Wb, Hb = int(bx1 - bx0), int(by1 - by0)
    k = 3
    em = Image.new('RGBA', (Wb * k, Hb * k), (0, 0, 0, 0))
    dd = ImageDraw.Draw(em)
    w, h = Wb * k, Hb * k
    # sun
    dd.ellipse([w * 0.18, h * 0.10, w * 0.82, h * 0.74], fill=ORANGE + (255,))
    # three swooshes (white) sweeping up and back
    for i, (off, th) in enumerate(((0.52, 0.075), (0.66, 0.06), (0.79, 0.05))):
        pts_top, pts_bot = [], []
        for t in np.linspace(0, 1, 60):
            x = w * (0.02 + 0.98 * t)
            yc = h * (off - 0.34 * t ** 1.6)
            tt = th * h * (0.25 + 0.75 * math.sin(math.pi * min(1, t * 1.15)))
            pts_top.append((x, yc - tt / 2))
            pts_bot.append((x, yc + tt / 2))
        dd.polygon(pts_top + pts_bot[::-1], fill=(250, 250, 252, 255))
    em = em.resize((Wb, Hb), Image.LANCZOS)
    if not right:
        pass
    # the emblem is designed for "nose on the left" (left face); mirror for the right face so the swooshes
    # always sweep backwards
    if right:
        em = em.transpose(Image.FLIP_LEFT_RIGHT)
    img.paste(em, (int(bx0), int(by0)), em)


# ================================================================================================ engines etc.
def nacelle():
    if hook('nacelle'):
        return LIV.nacelle(sys.modules[__name__])
    W, H = 2048, 1024
    img = Image.new('RGB', (W, H), BLUE)
    d = ImageDraw.Draw(img)
    # u = x / 3.7 (x from the top lip, aft), v = theta / 2pi (0 top, 0.25 right side)
    def P(x, th):
        return (x / 3.7 * W, (1 - th / (2 * math.pi)) * H)
    # orange ring at the nose cowl / fan cowl split and a thin white line
    d.rectangle([P(0.62, 0)[0], 0, P(0.72, 0)[0], H], fill=ORANGE)
    d.rectangle([P(0.72, 0)[0], 0, P(0.745, 0)[0], H], fill=(240, 240, 240))
    # panel lines: nose cowl / fan cowl / reverser splits, fan-cowl hinge (top) and latches (bottom)
    for x in (0.67, 2.25):
        d.line([P(x, 0)[0], 0, P(x, 0)[0], H], fill=(8, 22, 60), width=4)
    for th in (0.0, math.pi):
        y = P(0, th)[1]
        d.line([P(0.67, 0)[0], y - 1, P(3.62, 0)[0], y - 1], fill=(8, 22, 60), width=3)
    for x in (1.0, 1.35, 1.7, 2.05):
        xx, yy = P(x, math.pi)
        d.rectangle([xx - 14, yy - 5, xx + 14, yy + 5], fill=(6, 18, 50))
    # titles on both sides: rendered in metric proportions then squeezed into the (x, theta) UV aspect
    ppm_u = W / 3.7                                   # px per meter along the engine
    ppm_v = H / (2 * math.pi * 1.26)                  # px per meter around the nacelle
    f = font(FONT_AV, 200, 8)
    t = 'Gökyüzü'
    tw = f.getlength(t)
    big = Image.new('RGBA', (int(tw) + 20, 260), (0, 0, 0, 0))
    ImageDraw.Draw(big).text((10, 0), t, font=f, fill=(245, 245, 245, 255))
    big = big.crop(big.getbbox())
    h_m = 0.26
    w_m = h_m * big.size[0] / big.size[1]
    txt0 = big.resize((int(w_m * ppm_u), int(h_m * ppm_v)), Image.LANCZOS)
    for th, flip in ((math.pi / 2, True), (3 * math.pi / 2, False)):
        txt = txt0.rotate(180) if flip else txt0
        x, y = P(1.45, th)
        img.paste(txt, (int(x - txt.size[0] / 2), int(y - txt.size[1] / 2)), txt)
    arr = np.asarray(img, dtype=np.float32)
    # soot toward the aft end of the reverser sleeve
    uu = np.linspace(0, 1, W)[None, :]
    soot = np.clip((uu * 3.7 - 3.0) / 0.6, 0, 1) * 0.25
    arr = arr * (1 - soot[..., None])
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'nacelle_color.jpg', q=90)


def spinner():
    W, H = 512, 512
    img = Image.new('RGB', (W, H), (150, 152, 156))
    d = ImageDraw.Draw(img)
    # uv: u along the profile (tip 0 -> base 1), v around; white spiral band
    for k in range(2):
        pts_a, pts_b = [], []
        for t in np.linspace(0.0, 1.0, 80):
            v = (0.1 + 0.5 * k + 0.65 * t) % 1.0
            pts_a.append((t * W, (1 - v) * H))
        # draw as thick segments (handles wrap by drawing twice)
        for dy in (0, -H, H):
            d.line([(x, y + dy) for x, y in pts_a], fill=(245, 245, 245), width=26)
    d.ellipse([-30, H / 2 - 30, 30, H / 2 + 30], fill=(245, 245, 245))
    save_jpg(img, 'spinner_color.jpg', q=90)


def tire():
    W, H = 512, 256
    img = Image.new('RGB', (W, H), (18, 18, 19))
    d = ImageDraw.Draw(img)
    # u across the tyre section (0..1 sidewall-tread-sidewall), v around
    for uc in (0.40, 0.47, 0.53, 0.60):
        d.line([(uc * W, 0), (uc * W, H)], fill=(8, 8, 8), width=6)
    arr = np.asarray(img, dtype=np.float32)
    arr += 10 * noise(H, W, 20, seed=3)[..., None]
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'tire_color.jpg', q=88)


def belly():
    """Belly fairing: u = along the fairing (s 10.6 .. 23.9), v = around (0 = left upper join, 0.5 = bottom centre,
    1 = right upper join). Panel joints, access panels, grime around the main-gear bay and streaks aft of it."""
    W, H = 2048, 1024
    S0_, S1_ = 10.6, 23.9
    base = getattr(LIV, 'BELLY_COLOR', BLUE)
    joint = getattr(LIV, 'BELLY_JOINT', (10, 30, 78))
    img = Image.new('RGB', (W, H), base)
    d = ImageDraw.Draw(img)
    def U(s):
        return (s - S0_) / (S1_ - S0_) * W
    for s in (12.4, 13.95, 15.4, 16.3, 18.25, 19.6, 21.35, 22.6):
        d.line([(U(s), 0), (U(s), H)], fill=joint, width=3)
    for v in (0.22, 0.40, 0.60, 0.78):
        d.line([(0, v * H), (W, v * H)], fill=joint, width=3)
    # access panels (screws hinted as rounded rectangles)
    for s, v in ((12.9, 0.3), (12.9, 0.7), (20.4, 0.32), (20.4, 0.68), (22.9, 0.5), (14.6, 0.5)):
        x, y = U(s), v * H
        d.rounded_rectangle([x - 70, y - 40, x + 70, y + 40], radius=8, outline=joint, width=3)
    arr = np.asarray(img, dtype=np.float32)
    n1 = noise(H, W, 60, seed=4)
    arr *= (0.96 + 0.06 * n1[..., None])
    # grime + hydraulic streaks around/behind the main gear bay (s 16.3..18.2 near the bottom centre)
    uu = (np.arange(W) + 0.5) / W * (S1_ - S0_) + S0_
    vv = (np.arange(H) + 0.5) / H
    S, V = np.meshgrid(uu, vv)
    bay = np.exp(-((S - 17.3) / 1.4) ** 2) * np.exp(-((V - 0.5) / 0.22) ** 2)
    streak = np.clip((S - 18.2) / 0.5, 0, 1) * np.exp(-np.clip(S - 18.2, 0, None) / 3.5)
    lines = 0.5 + 0.5 * np.sin(V * 90.0 + 3 * noise(H, W, 30, seed=8))
    streak = streak * np.exp(-((V - 0.5) / 0.3) ** 2) * (0.4 + 0.6 * lines)
    dirt = np.clip(0.28 * bay + 0.22 * streak + 0.06 * noise(H, W, 25, seed=6), 0, 0.5)
    arr = arr * (1 - dirt[..., None]) + np.array([30, 28, 26]) * dirt[..., None]
    save_jpg(Image.fromarray(arr.clip(0, 255).astype(np.uint8)), 'belly_color.jpg', q=88)


def lod_textures():
    sizes = {'fuselage_color.jpg': (2048, 1024), 'wing_color.jpg': (1024, 1024), 'tail_color.jpg': (1024, 512),
             'htail_color.jpg': (512, 512), 'nacelle_color.jpg': (256, 512), 'belly_color.jpg': (256, 128),
             'spinner_color.jpg': (128, 128), 'tire_color.jpg': (128, 64)}
    for name, size in sizes.items():
        p = os.path.join(OUT, name)
        if os.path.exists(p):
            Image.open(p).convert('RGB').resize(size, Image.LANCZOS).save(os.path.join(OUT, 'lod_' + name), quality=85)
    print('lod textures written')


ALL = dict(fuselage=fuselage, wing=wing, htail=htail, tail=tail, nacelle=nacelle, spinner=spinner, tire=tire,
           belly=belly, lod=lod_textures)

if __name__ == '__main__':
    names = sys.argv[1:] or list(ALL)
    for n in names:
        ALL[n]()
