"""Paint the A320 flight-deck panel atlas (colour + emissive) from cockpit_layout.py.

.venv/bin/python blender/aircraft/a320neo/cockpit_tex.py  -> build/tex/ck_atlas.jpg, ck_atlas_emit.jpg, ck_*.jpg
"""
import math
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cockpit_layout as CL  # noqa: E402

OUT = os.path.join(HERE, 'build', 'tex')
os.makedirs(OUT, exist_ok=True)
FONT_HN = '/System/Library/Fonts/HelveticaNeue.ttc'
FONT_MONO = '/System/Library/Fonts/Menlo.ttc'
SS = 2                       # supersampling
PX = CL.APPM * SS            # pixels per meter while painting

_fonts = {}


def F(size_m, bold=True, mono=False):
    px = max(6, int(size_m * PX))
    key = (px, bold, mono)
    if key not in _fonts:
        if mono:
            _fonts[key] = ImageFont.truetype(FONT_MONO, px, index=1 if bold else 0)
        else:
            _fonts[key] = ImageFont.truetype(FONT_HN, px, index=4 if bold else 10)   # condensed bold / medium
    return _fonts[key]


LEG_COL = {'FAULT': CL.AMBER, 'OFF': CL.WHITE, 'ON': CL.BLUE_LIT, 'AVAIL': CL.GREEN, 'FIRE': (255, 40, 30),
           'ALIGN': CL.WHITE, 'AUTO': CL.WHITE, 'SQUIB': CL.WHITE, 'DECEL': CL.GREEN, 'OPEN': CL.WHITE,
           'MAN ON': CL.WHITE, 'SMOKE': (255, 40, 30), 'LINE': CL.WHITE}


class Painter:
    def __init__(self, w_m, h_m):
        self.W, self.H = int(math.ceil(w_m * PX)), int(math.ceil(h_m * PX))
        self.c = Image.new('RGB', (self.W, self.H), CL.PANEL_BG)
        self.e = Image.new('RGB', (self.W, self.H), (0, 0, 0))
        self.d = ImageDraw.Draw(self.c)
        self.de = ImageDraw.Draw(self.e)

    def P(self, x, y):
        return x * PX, y * PX

    def box(self, x, y, w, h):
        return [x * PX, y * PX, (x + w) * PX, (y + h) * PX]

    def text(self, x, y, s, size, col, anchor='mm', emit=0.12, bold=True, mono=False, target=None):
        f = F(size, bold, mono)
        d = target or self.d
        d.text(self.P(x, y), s, font=f, fill=col, anchor=anchor)
        if emit > 0:
            ec = tuple(int(c * emit) for c in col)
            self.de.text(self.P(x, y), s, font=f, fill=ec, anchor=anchor)


def paint_item(p, it):
    k = it[0]
    d, de = p.d, p.de
    if k == 'rect':
        _, x, y, w, h, col = it
        d.rectangle(p.box(x, y, w, h), fill=col)
    elif k == 'bezel':
        _, x, y, w, h = it
        d.rounded_rectangle(p.box(x, y, w, h), radius=0.012 * PX, fill=(34, 37, 42))
        d.rounded_rectangle(p.box(x + 0.004, y + 0.004, w - 0.008, h - 0.008), radius=0.008 * PX, fill=(24, 26, 29))
        # screw heads + brightness/'BRT' legend
        for sx, sy in ((x + 0.008, y + 0.008), (x + w - 0.008, y + 0.008), (x + 0.008, y + h - 0.008), (x + w - 0.008, y + h - 0.008)):
            r = 0.0025 * PX
            d.ellipse([sx * PX - r, sy * PX - r, sx * PX + r, sy * PX + r], fill=(90, 94, 100))
    elif k == 'screen':
        _, name, x, y, w, h = it
        d.rectangle(p.box(x, y, w, h), fill=(6, 8, 10))
    elif k == 'btn' or k == 'gbtn':
        _, x, y, w, h, top, bot, lit = it
        if bot:
            p.text(x + w / 2, y - 0.0055, top, 0.0062, CL.WHITE)
            legends = [('', None), (bot, lit)]
        else:
            legends = [(top, lit)]
        if k == 'gbtn':
            d.rectangle(p.box(x - 0.004, y - 0.004, w + 0.008, h + 0.008), fill=(170, 28, 24))
        d.rounded_rectangle(p.box(x, y, w, h), radius=0.0025 * PX, fill=(30, 33, 37), outline=(12, 13, 15), width=int(0.0008 * PX))
        # split line (two-legend buttons)
        if bot:
            d.line([p.P(x + 0.003, y + h / 2), p.P(x + w - 0.003, y + h / 2)], fill=(22, 24, 27), width=max(1, int(0.0005 * PX)))
            # upper half legend (FAULT / fire etc.) dim, lower half = bot
            upper = 'FAULT' if bot not in ('ON', 'AVAIL', 'FIRE', 'LINE', 'SQUIB') else ''
            if bot in ('FIRE',):
                upper = ''
            if upper:
                col = LEG_COL.get(upper, CL.WHITE)
                p.text(x + w / 2, y + h * 0.27, upper, min(0.0055, h * 0.28), tuple(int(c * 0.28) for c in col), emit=0)
            legend = bot
            col = LEG_COL.get(legend, CL.WHITE)
            on = lit == 'bot'
            p.text(x + w / 2, y + h * 0.73, legend, min(0.0058, h * 0.30, w / max(len(legend), 1) * 1.9),
                   col if on else tuple(int(c * 0.30) for c in col), emit=0.9 if on else 0)
        else:
            legend = top
            col = LEG_COL.get(legend, CL.WHITE)
            on = lit == 'top'
            if on:
                # lit indicator bar (Airbus 3-green-bar style for AP/FD/A-THR)
                d.rectangle(p.box(x + w * 0.25, y + h * 0.12, w * 0.5, h * 0.12), fill=CL.GREEN)
                de.rectangle(p.box(x + w * 0.25, y + h * 0.12, w * 0.5, h * 0.12), fill=CL.GREEN)
            p.text(x + w / 2, y + h * 0.62, legend, min(0.0064, h * 0.42, w / max(len(legend), 1) * 1.8), CL.WHITE, emit=0.35)
    elif k in ('knob', 'bigknob'):
        _, x, y, r, label = it
        # position ticks around the knob + label below
        for a in np.linspace(-2.2, 2.2, 7 if k == 'knob' else 0):
            x0, y0 = x + math.sin(a) * r * 1.35, y - math.cos(a) * r * 1.35
            x1, y1 = x + math.sin(a) * r * 1.6, y - math.cos(a) * r * 1.6
            d.line([p.P(x0, y0), p.P(x1, y1)], fill=CL.WHITE, width=max(1, int(0.0008 * PX)))
        d.ellipse(p.box(x - r * 1.15, y - r * 1.15, 2.3 * r, 2.3 * r), fill=(40, 44, 50))
        if label:
            p.text(x, y + r * 1.9 + 0.004, label, 0.0058, CL.WHITE)
    elif k == 'toggle':
        _, x, y, label, pos = it
        if label:
            p.text(x, y - 0.012, label, 0.0055, CL.WHITE)
        d.ellipse(p.box(x - 0.006, y - 0.006, 0.012, 0.012), fill=(150, 152, 156), outline=(40, 42, 46))
        for i, ps in enumerate(pos):
            yy = y + 0.004 + (i - (len(pos) - 1) / 2) * 0.011
            p.text(x + 0.018, yy, ps, 0.0045, CL.WHITE, anchor='lm')
    elif k == 'text':
        _, x, y, s, size, col = it
        p.text(x, y, s, size, col)
    elif k == 'title':
        _, x, y, w, s = it
        f = F(0.0068)
        tw = f.getlength(s) / PX
        lw = max(1, int(0.0007 * PX))
        d.line([p.P(x, y), p.P(x + (w - tw) / 2 - 0.004, y)], fill=CL.WHITE, width=lw)
        d.line([p.P(x + (w + tw) / 2 + 0.004, y), p.P(x + w, y)], fill=CL.WHITE, width=lw)
        d.line([p.P(x, y), p.P(x, y + 0.006)], fill=CL.WHITE, width=lw)
        d.line([p.P(x + w, y), p.P(x + w, y + 0.006)], fill=CL.WHITE, width=lw)
        p.text(x + w / 2, y, s, 0.0068, CL.WHITE)
    elif k == 'lcd':
        _, x, y, w, h, s, col = it
        d.rectangle(p.box(x, y, w, h), fill=(16, 12, 8))
        de.rectangle(p.box(x, y, w, h), fill=(0, 0, 0))
        p.text(x + w / 2, y + h / 2, s, h * 0.72, col, emit=1.0, mono=True)
    elif k == 'light':
        _, x, y, w, h, s, col, lit = it
        d.rectangle(p.box(x, y, w, h), fill=(22, 22, 24), outline=(10, 10, 10))
        c = col if lit else tuple(int(v * 0.25) for v in col)
        p.text(x + w / 2, y + h / 2, s, min(h * 0.45, w / max(len(s), 1) * 1.7), c, emit=1.0 if lit else 0)
    elif k == 'clock':
        _, x, y, r = it
        d.ellipse(p.box(x - r, y - r, 2 * r, 2 * r), fill=(20, 22, 25), outline=(120, 124, 130), width=int(0.002 * PX))
        for i in range(12):
            a = i / 12 * 2 * math.pi
            d.line([p.P(x + math.sin(a) * r * 0.78, y - math.cos(a) * r * 0.78),
                    p.P(x + math.sin(a) * r * 0.92, y - math.cos(a) * r * 0.92)], fill=CL.WHITE, width=int(0.0012 * PX))
        p.text(x, y - r * 0.35, '13:02', r * 0.28, CL.GREEN, emit=0.9, mono=True)
        p.text(x, y + r * 0.35, 'UTC', r * 0.2, CL.WHITE)
    elif k == 'mcdu':
        _, x, y, w, h, side = it
        paint_mcdu(p, x, y, w, h)


def paint_mcdu(p, x, y, w, h):
    d = p.d
    d.rounded_rectangle(p.box(x, y, w, h), radius=0.006 * PX, fill=(52, 58, 67), outline=(20, 22, 26), width=int(0.001 * PX))
    L = CL.mcdu_layout(x, y, w, h)
    sx, sy, sw, sh = L['screen']
    d.rectangle(p.box(sx - 0.004, sy - 0.004, sw + 0.008, sh + 0.008), fill=(20, 22, 25))
    d.rectangle(p.box(sx, sy, sw, sh), fill=(4, 6, 8))
    cols = {'w': CL.WHITE, 'g': CL.GREEN, 'c': CL.CYAN}
    lh = sh / (len(CL.MCDU_PAGE) + 1.2)
    for i, (line, c) in enumerate(CL.MCDU_PAGE):
        p.text(sx + 0.004, sy + lh * (i + 1.0), line, lh * 0.78, cols[c], anchor='lm', emit=1.0, mono=True)
    for (kx, ky, kw, kh, lab, kind) in L['keys']:
        fill = (38, 42, 48) if kind != 'lsk' else (30, 33, 37)
        d.rounded_rectangle(p.box(kx, ky, kw, kh), radius=0.0015 * PX, fill=fill, outline=(15, 16, 18))
        if lab != '-':
            p.text(kx + kw / 2, ky + kh / 2, lab, min(kh * 0.42, kw / max(len(lab), 1) * 1.6), CL.WHITE, emit=0.3)
        else:
            d.line([p.P(kx + kw * 0.3, ky + kh / 2), p.P(kx + kw * 0.7, ky + kh / 2)], fill=CL.WHITE, width=max(1, int(0.0008 * PX)))
    for lab, (fx, fy) in (('BRT', (x + w * 0.88, y + h * 0.47)), ('FAIL', (x + w * 0.12, y + h * 0.47))):
        p.text(fx, fy, lab, 0.004, CL.WHITE)


def paint_panel(pn):
    p = Painter(pn['w'], pn['h'])
    # subtle texture + panel border and screws
    arr = np.asarray(p.c, np.float32)
    n = ndimage.gaussian_filter(np.random.default_rng(hash(pn['name']) & 0xffff).random(arr.shape[:2]), 3)
    arr *= (0.97 + 0.06 * (n - n.min()) / (np.ptp(n) + 1e-9))[..., None]
    p.c = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    p.d = ImageDraw.Draw(p.c)
    for it in pn['items']:
        paint_item(p, it)
    p.d.rectangle([0, 0, p.W - 1, p.H - 1], outline=(40, 46, 55), width=int(0.002 * PX))
    for sx, sy in ((0.006, 0.006), (pn['w'] - 0.006, 0.006), (0.006, pn['h'] - 0.006), (pn['w'] - 0.006, pn['h'] - 0.006)):
        r = 0.0022 * PX
        p.d.ellipse([sx * PX - r, sy * PX - r, sx * PX + r, sy * PX + r], fill=(150, 154, 160))
    return p


def swatch(kind, size=512, seed=0):
    rng = np.random.default_rng(seed)
    if kind == 'fabric':           # seat fabric: dark blue-grey woven
        base = np.array([52, 58, 72], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 1.0)
        yy, xx = np.mgrid[0:size, 0:size]
        weave = 0.5 + 0.5 * np.sin(xx * 0.9) * np.sin(yy * 0.9)
        img = base * (0.85 + 0.2 * n[..., None] + 0.08 * weave[..., None])
    elif kind == 'leather':
        base = np.array([62, 64, 70], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 1.2)
        n2 = ndimage.gaussian_filter(rng.random((size, size)), 12)
        img = base * (0.82 + 0.25 * n[..., None] + 0.2 * n2[..., None])
    elif kind == 'carpet':
        base = np.array([48, 52, 58], np.float32)
        n = rng.random((size, size))
        img = base * (0.8 + 0.4 * ndimage.gaussian_filter(n, 0.7)[..., None])
    elif kind == 'lining':         # light grey textured wall panels
        base = np.array([128, 130, 130], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 2.0)
        img = base * (0.94 + 0.12 * n[..., None])
    else:
        base = np.array([120, 124, 130], np.float32)
        img = base * np.ones((size, size, 1))
    return Image.fromarray(img.clip(0, 255).astype(np.uint8))


def cb_panel(w, h):
    """Circuit-breaker panel: rows of black CB heads with white collars, labels, grouped by white lines."""
    im = Image.new('RGB', (w, h), CL.PANEL_BG)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT_HN, 11, index=4)
    rng = np.random.default_rng(7)
    rows, cols = 13, 18
    mx, my = 40, 50
    px, py = (w - 2 * mx) / cols, (h - 2 * my) / rows
    for r in range(rows):
        if r % 4 == 0:
            yy = my + r * py - 14
            d.line([(mx - 10, yy), (w - mx + 10, yy)], fill=(225, 228, 230), width=2)
            d.text((w / 2, yy), ['ELEC', 'HYD', 'FLT CTL', 'NAV', 'FUEL'][r // 4 % 5], font=f, fill=(225, 228, 230), anchor='mm')
        for c in range(cols):
            if rng.random() < 0.08:
                continue
            cx, cy = mx + (c + 0.5) * px, my + (r + 0.5) * py
            col = (235, 235, 235) if rng.random() < 0.85 else (220, 40, 30)
            d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=col)
            d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=(18, 18, 20))
            d.text((cx, cy + 18), f'{rng.integers(1, 99)}', font=f, fill=(210, 212, 214), anchor='mm')
    d.rectangle([2, 2, w - 3, h - 3], outline=(40, 46, 55), width=4)
    return im


def main():
    panels = CL.all_panels()
    regions = CL.pack(panels)
    atlas = Image.new('RGB', (CL.ATLAS, CL.ATLAS), (60, 66, 76))
    emit = Image.new('RGB', (CL.ATLAS, CL.ATLAS), (0, 0, 0))
    for pn in panels:
        x0, y0, w, h = regions[pn['name']]
        p = paint_panel(pn)
        atlas.paste(p.c.resize((w, h), Image.LANCZOS), (x0, y0))
        emit.paste(p.e.resize((w, h), Image.LANCZOS), (x0, y0))
    x0, y0, w, h = CL.reserved_regions()['cb']
    atlas.paste(cb_panel(w, h), (x0, y0))
    atlas.save(os.path.join(OUT, 'ck_atlas.jpg'), quality=92, subsampling=0)
    emit.save(os.path.join(OUT, 'ck_atlas_emit.jpg'), quality=90, subsampling=0)
    for k, seed in (('fabric', 1), ('carpet', 2), ('lining', 3), ('leather', 4)):
        swatch(k, seed=seed).save(os.path.join(OUT, f'ck_{k}.jpg'), quality=88)
    print('atlas written', {k: v for k, v in regions.items()})


if __name__ == '__main__':
    main()
