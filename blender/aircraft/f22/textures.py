"""F-22 texture sources (run with the project venv: .venv/bin/python blender/aircraft/f22/textures.py).

Writes into assets/aircraft/f22/src/ (inputs for the Blender bake / materials):
  cockpit.png         2048^2 interior atlas (consoles, panel, ICP, seat fabric, stripes, colour patches)
  proj_top.png        planform panel/marking map for upward-facing skin      (x: -7..7 m, s: 0..19 m)
  proj_bot.png        planform panel/marking map for downward-facing skin
  proj_side.png       side-view panel/marking map (s: 0..19, z: -1.5..1.5) for the right side (left is mirrored)
  proj_fin.png        fin-plane map (s along the chord, h along the span) for the vertical tails
Channels of the proj_* maps: R = panel-line groove (1 = line), G = panel tone id (random per panel), B = marking mask,
A = marking colour index (0 = none, 1 = dark insignia gray, 2 = light gray text, 3 = black walkway / anti-glare).
"""
import os
import math
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'src')
os.makedirs(OUT, exist_ok=True)

FONT_B = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FONT_R = '/System/Library/Fonts/Supplemental/Arial.ttf'
FONT_N = '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf'


def font(size, kind='b'):
    path = {'b': FONT_B, 'r': FONT_R, 'n': FONT_N}[kind]
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


# ================================================================================================
# cockpit atlas
# ================================================================================================
ATLAS = 2048
# regions (x0, y0, x1, y1) in pixels, origin top-left
R = {
    'lcon': (0, 0, 2048, 320),
    'rcon': (0, 320, 2048, 640),
    'panel': (0, 640, 1060, 1408),
    'icp': (1280, 640, 1664, 832),
    'seat': (1280, 832, 1664, 1216),
    'stripe': (1664, 1024, 2048, 1088),
    'side': (0, 1408, 1024, 1920),
    'bezel': (1664, 640, 2048, 1024),
    'headbox': (1024, 1408, 1536, 1920),
    'placard': (1536, 1408, 2048, 1920),
}
PATCHES = {   # solid colour patches, 128x128 each along the bottom row
    'wall': (58, 61, 64), 'black': (16, 17, 18), 'metal': (92, 96, 98), 'light': (150, 154, 156),
    'seatgreen': (74, 80, 66), 'yellow': (214, 172, 30), 'rubber': (22, 22, 22), 'white': (225, 225, 220),
    'panel': (40, 42, 44), 'olive': (86, 88, 70), 'red': (160, 30, 26), 'glass': (30, 40, 36),
    'chrome': (170, 172, 175), 'brown': (70, 58, 44), 'grip': (34, 34, 36), 'green': (40, 160, 70),
}


def patch_rect(name):
    i = list(PATCHES).index(name)
    return (i * 128, 1920, i * 128 + 128, 2048)


CONTROLS = []     # (region_name, u, v, kind) recorded while drawing; v up


def draw_panel_texture(d, rect, seed, labels, knobs=0, switches=0, dense=1.0, name=None):
    x0, y0, x1, y1 = rect
    rnd = random.Random(seed)
    d.rectangle(rect, fill=(38, 40, 43))
    # sub-panels
    w, h = x1 - x0, y1 - y0
    rows = rnd.randint(2, 3)
    ys = sorted([y0] + [y0 + int(h * (k + 1) / rows + rnd.randint(-20, 20)) for k in range(rows - 1)] + [y1])
    for r in range(rows):
        cols = rnd.randint(1, 3)
        xs = sorted([x0] + [x0 + int(w * (k + 1) / cols + rnd.randint(-30, 30)) for k in range(cols - 1)] + [x1])
        for c in range(cols):
            a, b, c2, e = xs[c] + 4, ys[r] + 4, xs[c + 1] - 4, ys[r + 1] - 4
            tone = rnd.randint(40, 50)
            d.rectangle((a, b, c2, e), fill=(tone, tone + 2, tone + 4), outline=(20, 21, 22), width=3)
            # dzus fasteners
            for (px, py) in ((a + 10, b + 10), (c2 - 10, b + 10), (a + 10, e - 10), (c2 - 10, e - 10)):
                d.ellipse((px - 5, py - 5, px + 5, py + 5), fill=(70, 72, 74), outline=(18, 18, 18))
                d.line((px - 3, py, px + 3, py), fill=(20, 20, 20), width=2)
            # label strip + controls
            n = int(rnd.randint(1, 4) * dense)
            for k in range(n):
                cx = a + (c2 - a) * (k + 0.5) / n
                cy = b + (e - b) * rnd.uniform(0.45, 0.7)
                kind = rnd.random()
                lab = rnd.choice(labels)
                f = font(18, 'n')
                tw = d.textlength(lab, font=f)
                d.text((cx - tw / 2, cy - 48), lab, fill=(220, 222, 215), font=f)
                if name:
                    CONTROLS.append((name, (cx - x0) / (x1 - x0), 1 - (cy - y0) / (y1 - y0),
                                     'toggle' if kind < 0.45 else ('knob' if kind < 0.8 else 'button')))
                if kind < 0.45:     # toggle switch (guard ring)
                    d.ellipse((cx - 16, cy - 16, cx + 16, cy + 16), fill=(24, 24, 25), outline=(120, 122, 124), width=2)
                    d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=(175, 178, 180))
                elif kind < 0.8:    # rotary knob with index line
                    d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), fill=(18, 18, 19), outline=(60, 60, 62), width=3)
                    ang = rnd.uniform(0, 2 * math.pi)
                    d.line((cx, cy, cx + 18 * math.cos(ang), cy + 18 * math.sin(ang)), fill=(230, 230, 225), width=3)
                    for t in range(7):
                        aa = -math.pi * 0.75 + t * math.pi * 1.5 / 6 - math.pi / 2
                        d.line((cx + 28 * math.cos(aa), cy + 28 * math.sin(aa), cx + 33 * math.cos(aa),
                                cy + 33 * math.sin(aa)), fill=(210, 210, 205), width=2)
                else:               # push button with legend
                    d.rectangle((cx - 26, cy - 16, cx + 26, cy + 16), fill=(22, 23, 24), outline=(90, 92, 94), width=2)
                    d.text((cx - 18, cy - 9), lab[:3], fill=(120, 200, 140), font=font(14, 'n'))


def make_cockpit_atlas():
    img = Image.new('RGB', (ATLAS, ATLAS), (40, 42, 44))
    d = ImageDraw.Draw(img)
    labels = ['FUEL', 'ENG', 'APU', 'EXT LT', 'INT LT', 'ANTI ICE', 'OXY', 'COMM', 'IFF', 'ECS', 'ARM', 'CANOPY',
              'BATT', 'GEN', 'JFS', 'TEMP', 'DEFOG', 'NAV', 'FORM', 'AR', 'MSTR', 'LAND', 'TAXI', 'PARK BRK',
              'HOOK', 'VOL', 'TACAN', 'ILS', 'HMD', 'BRT']
    CONTROLS.clear()
    draw_panel_texture(d, R['lcon'], 11, labels, dense=1.2, name='lcon')
    draw_panel_texture(d, R['rcon'], 23, labels, dense=1.2, name='rcon')
    # throttle slot on the left console (u ~ 0.55 of the region width, along s)
    x0, y0, x1, y1 = R['lcon']
    d.rectangle((x0 + 300, y0 + 110, x0 + 930, y0 + 210), fill=(14, 14, 15), outline=(80, 80, 82), width=4)
    for k in range(10):
        xx = x0 + 320 + k * 66
        d.line((xx, y0 + 218, xx, y0 + 238), fill=(220, 220, 215), width=3)
    d.text((x0 + 320, y0 + 244), 'MAX', fill=(220, 220, 215), font=font(22, 'n'))
    d.text((x0 + 560, y0 + 244), 'MIL', fill=(220, 220, 215), font=font(22, 'n'))
    d.text((x0 + 860, y0 + 244), 'IDLE', fill=(220, 220, 215), font=font(22, 'n'))
    # instrument panel face
    x0, y0, x1, y1 = R['panel']
    d.rectangle(R['panel'], fill=(34, 36, 38))
    rnd = random.Random(5)
    for k in range(60):
        px = rnd.randint(x0 + 20, x1 - 20)
        py = rnd.randint(y0 + 20, y1 - 20)
        d.ellipse((px - 4, py - 4, px + 4, py + 4), fill=(60, 62, 64))
    # placards / small switches around the display area
    for (px, py, lab) in ((x0 + 90, y0 + 520, 'LDG GEAR'), (x0 + 90, y0 + 330, 'MASTER ARM'), (x1 - 150, y0 + 540, 'EMER JETT'),
                          (x1 - 150, y0 + 330, 'FIRE'), (x0 + 120, y0 + 700, 'ISFD'), (x1 - 170, y0 + 700, 'CLOCK')):
        d.text((px, py), lab, fill=(220, 222, 214), font=font(22, 'n'))
    d.rectangle((x1 - 170, y0 + 575, x1 - 70, y0 + 640), fill=(150, 26, 22), outline=(10, 10, 10), width=3)
    d.text((x1 - 150, y0 + 592), 'FIRE', fill=(240, 230, 220), font=font(24, 'b'))
    # ICP keypad
    x0, y0, x1, y1 = R['icp']
    d.rectangle(R['icp'], fill=(28, 29, 31))
    keys = ['1', '2', '3', 'COM1', '4', '5', '6', 'COM2', '7', '8', '9', 'NAV', 'CLR', '0', 'ENT', 'A/P']
    for k, lab in enumerate(keys):
        cx = x0 + 30 + (k % 4) * 88
        cy = y0 + 20 + (k // 4) * 42
        d.rounded_rectangle((cx, cy, cx + 70, cy + 34), radius=6, fill=(16, 16, 17), outline=(95, 97, 99), width=2)
        f = font(22 if len(lab) < 3 else 16, 'n')
        tw = d.textlength(lab, font=f)
        d.text((cx + 35 - tw / 2, cy + 6), lab, fill=(200, 235, 205), font=f)
    # seat fabric (quilted)
    x0, y0, x1, y1 = R['seat']
    d.rectangle(R['seat'], fill=(76, 82, 68))
    for k in range(0, 400, 48):
        d.line((x0, y0 + k, x1, y0 + k), fill=(58, 62, 52), width=5)
    for k in range(0, 400, 64):
        d.line((x0 + k, y0, x0 + k, y1), fill=(62, 66, 55), width=3)
    # yellow/black stripes
    x0, y0, x1, y1 = R['stripe']
    st = Image.new('RGB', (x1 - x0, y1 - y0), (18, 18, 18))
    sd = ImageDraw.Draw(st)
    for k in range(-64, 400, 48):
        sd.polygon([(k, y1 - y0), (k + 24, y1 - y0), (k + 24 + 64, 0), (k + 64, 0)], fill=(226, 180, 28))
    img.paste(st, (x0, y0))
    # side wall panels with placards
    draw_panel_texture(d, R['side'], 41, labels, dense=0.5)
    # headbox (parachute container) with warning text
    x0, y0, x1, y1 = R['headbox']
    d.rectangle(R['headbox'], fill=(66, 70, 60))
    d.rectangle((x0 + 60, y0 + 140, x1 - 60, y0 + 260), fill=(20, 20, 20))
    d.text((x0 + 80, y0 + 160), 'WARNING', fill=(230, 190, 40), font=font(34, 'b'))
    d.text((x0 + 80, y0 + 205), 'EJECTION SEAT', fill=(230, 230, 220), font=font(26, 'n'))
    d.rectangle((x0 + 20, y0 + 20, x1 - 20, y1 - 20), outline=(40, 44, 36), width=6)
    # bezel (buttons ring look) - dark with light tick marks
    x0, y0, x1, y1 = R['bezel']
    d.rectangle(R['bezel'], fill=(26, 27, 28))
    for k in range(5):
        for side in range(4):
            pass
    # placard block
    x0, y0, x1, y1 = R['placard']
    d.rectangle(R['placard'], fill=(40, 42, 44))
    rnd = random.Random(77)
    for k in range(10):
        yy = y0 + 20 + k * 48
        d.rectangle((x0 + 20, yy, x1 - 20, yy + 36), fill=(30, 31, 33), outline=(80, 82, 84))
        d.text((x0 + 32, yy + 8), rnd.choice(labels) + '  ' + rnd.choice(labels), fill=(215, 215, 210), font=font(18, 'n'))
    # colour patches
    for name, col in PATCHES.items():
        d.rectangle(patch_rect(name), fill=col)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(os.path.join(OUT, 'cockpit.png'))
    # region table for Blender (normalized UV rects, v up)
    import json
    tab = {k: [v[0] / ATLAS, 1 - v[3] / ATLAS, v[2] / ATLAS, 1 - v[1] / ATLAS] for k, v in R.items()}
    tab.update({f'patch_{k}': [r[0] / ATLAS, 1 - r[3] / ATLAS, r[2] / ATLAS, 1 - r[1] / ATLAS]
                for k, r in ((k, patch_rect(k)) for k in PATCHES)})
    tab['controls'] = CONTROLS
    with open(os.path.join(OUT, 'cockpit_regions.json'), 'w') as f:
        json.dump(tab, f, indent=1)


# ================================================================================================
# render-only display pages (Cycles renders; the game draws live avionics instead)
# ================================================================================================
def make_display_pages(out=OUT):
    G_ = (60, 255, 110)
    W_ = (235, 240, 235)
    C_ = (90, 220, 255)
    Y_ = (255, 220, 60)
    R_ = (255, 70, 60)

    def tsd(size=1024):
        im = Image.new('RGB', (size, size), (6, 10, 14))
        d = ImageDraw.Draw(im)
        cx, cy = size / 2, size * 0.62
        # terrain-ish colour patches
        rnd = random.Random(3)
        for k in range(26):
            x, y, r = rnd.randint(0, size), rnd.randint(0, size), rnd.randint(40, 180)
            d.ellipse((x - r, y - r * 0.6, x + r, y + r * 0.6), fill=(10 + rnd.randint(0, 12), 22 + rnd.randint(0, 18), 20 + rnd.randint(0, 10)))
        for r in (0.18, 0.36, 0.54):
            R = r * size
            d.arc((cx - R, cy - R, cx + R, cy + R), 200, 340, fill=(80, 90, 100), width=3)
        d.line((cx, cy, cx, cy - size * 0.58), fill=(80, 90, 100), width=2)
        d.polygon([(cx, cy - 26), (cx - 16, cy + 18), (cx, cy + 8), (cx + 16, cy + 18)], fill=C_)
        for (x, y, col, t) in ((0.35, 0.3, R_, 'SA'), (0.7, 0.22, Y_, ''), (0.62, 0.42, G_, ''), (0.28, 0.52, R_, '')):
            X, Yp = x * size, y * size
            if col == R_:
                d.arc((X - 60, Yp - 60, X + 60, Yp + 60), 0, 360, fill=col, width=3)
                d.text((X - 14, Yp - 14), t or '10', fill=col, font=font(26, 'n'))
            else:
                d.polygon([(X, Yp - 18), (X - 16, Yp + 12), (X + 16, Yp + 12)], outline=col, width=3)
        # osb labels
        for k, t in enumerate(['TSD', 'SMS', 'FCS', 'ENG', 'FUEL']):
            d.text((60 + k * 190, 18), t, fill=W_, font=font(30, 'n'))
        d.text((24, size - 60), '40', fill=W_, font=font(34, 'n'))
        d.rectangle((2, 2, size - 3, size - 3), outline=(40, 50, 60), width=4)
        return im

    def eng(size=768):
        im = Image.new('RGB', (size, size), (5, 7, 9))
        d = ImageDraw.Draw(im)
        for k, x in enumerate((0.3, 0.7)):
            X = x * size
            for j, (lab, val) in enumerate((('N2', 0.86), ('FTIT', 0.72), ('NOZ', 0.3), ('OIL', 0.5))):
                Yp = 110 + j * 160
                d.rectangle((X - 110, Yp, X + 110, Yp + 36), outline=(90, 100, 110), width=3)
                d.rectangle((X - 108, Yp + 2, X - 108 + 216 * val, Yp + 34), fill=G_)
                d.text((X - 110, Yp - 34), f'{lab}  {int(val * 100)}', fill=W_, font=font(28, 'n'))
        d.text((size * 0.36, 20), 'ENG  FUEL 18.2', fill=C_, font=font(34, 'n'))
        d.rectangle((2, 2, size - 3, size - 3), outline=(40, 50, 60), width=4)
        return im

    def ufd(w=512, h=384):
        im = Image.new('RGB', (w, h), (4, 8, 6))
        d = ImageDraw.Draw(im)
        lines = ['COM1  243.000', 'COM2  251.250', 'NAV   TCN 35X', 'IFF   M3 4211', 'ALT   STBY', '* ICAW CLEAR *']
        for k, t in enumerate(lines):
            d.text((24, 20 + k * 58), t, fill=G_ if k < 5 else Y_, font=font(40, 'n'))
        return im

    def hud(w=1024, h=900):
        im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        g = (80, 255, 120, 255)
        cx, cy = w / 2, h * 0.48
        for k in range(-3, 4):
            Yp = cy + k * 120
            if k == 0:
                d.line((cx - 330, Yp, cx - 60, Yp), fill=g, width=4)
                d.line((cx + 60, Yp, cx + 330, Yp), fill=g, width=4)
                continue
            dash = [(cx - 220, Yp, cx - 90, Yp), (cx + 90, Yp, cx + 220, Yp)]
            for L in dash:
                d.line(L, fill=g, width=3)
            d.text((cx - 280, Yp - 14), f'{-k * 5}', fill=g, font=font(28, 'n'))
        # flight path marker
        d.ellipse((cx - 20, cy + 40, cx + 20, cy + 80), outline=g, width=4)
        d.line((cx - 50, cy + 60, cx - 20, cy + 60), fill=g, width=4)
        d.line((cx + 20, cy + 60, cx + 50, cy + 60), fill=g, width=4)
        d.line((cx, cy + 40, cx, cy + 18), fill=g, width=4)
        # airspeed / altitude boxes
        d.rectangle((60, cy - 30, 200, cy + 30), outline=g, width=4)
        d.text((80, cy - 22), '412', fill=g, font=font(44, 'n'))
        d.rectangle((w - 230, cy - 30, w - 60, cy + 30), outline=g, width=4)
        d.text((w - 212, cy - 22), '12,450', fill=g, font=font(44, 'n'))
        # heading tape
        for k in range(-5, 6):
            X = cx + k * 70
            d.line((X, 60, X, 80 if k % 2 else 95), fill=g, width=3)
            if k % 2 == 0:
                d.text((X - 18, 100), f'{(29 + k // 2) % 36:02d}', fill=g, font=font(30, 'n'))
        d.polygon([(cx, 140), (cx - 12, 160), (cx + 12, 160)], outline=g)
        d.text((60, h - 120), 'G 1.2', fill=g, font=font(34, 'n'))
        d.text((w - 220, h - 120), 'M 0.72', fill=g, font=font(34, 'n'))
        return im

    tsd().save(os.path.join(out, 'disp_pmfd.png'))
    eng().save(os.path.join(out, 'disp_smfd.png'))
    ufd().save(os.path.join(out, 'disp_ufd.png'))
    hud().save(os.path.join(out, 'disp_hud.png'))


if __name__ == '__main__':
    import sys
    what = sys.argv[1:] or ['cockpit', 'exterior']
    if 'cockpit' in what:
        make_cockpit_atlas()
        print('cockpit atlas written')
    if 'displays' in what or 'cockpit' in what:
        make_display_pages()
        print('display pages written')
    if 'exterior' in what:
        import textures_ext
        textures_ext.make_all(OUT)
        print('exterior maps written')
