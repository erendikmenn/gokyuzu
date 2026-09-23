"""Flight-deck panel atlas painter (737NG style). Run with the repo venv:
    .venv/bin/python blender/aircraft/b737/textures_fd.py
Writes tex/fd_base.jpg, tex/fd_orm.jpg, tex/fd_emit.jpg (4096^2 atlas, layout from fdlayout.py) and
tex/fd_screen_*.png (static display images used only by the Cycles renders)."""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fdlayout as FL

TEX = os.path.join(HERE, 'tex')
A = FL.ATLAS
HELV = '/System/Library/Fonts/HelveticaNeue.ttc'
MONO = '/System/Library/Fonts/SFNSMono.ttf'
DIN = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'

AMBER = (255, 176, 40)
BLUE = (80, 170, 255)
GREEN = (60, 230, 90)
RED = (240, 40, 30)
WHITE = (235, 236, 238)
PANEL = (88, 92, 98)
_fonts = {}


def F(size_px, bold=True, path=None):
    size_px = max(6, int(size_px))
    key = (size_px, bold, path)
    if key not in _fonts:
        if path:
            _fonts[key] = ImageFont.truetype(path, size_px)
        else:
            _fonts[key] = ImageFont.truetype(HELV, size_px, index=1 if bold else 10)
    return _fonts[key]


class Painter:
    def __init__(self):
        self.base = Image.new('RGB', (A, A), (70, 72, 76))
        self.emit = Image.new('RGB', (A, A), (0, 0, 0))
        self.rough = Image.new('L', (A, A), 150)
        self.db = ImageDraw.Draw(self.base)
        self.de = ImageDraw.Draw(self.emit)
        self.dr = ImageDraw.Draw(self.rough)


def panel_bg(p, pa):
    x0, y0, x1, y1 = p.rect
    pa.db.rectangle([x0, y0, x1, y1], fill=p.bg)
    # subtle mottling
    rng = np.random.default_rng(hash(p.name) % 1000)
    w, h = x1 - x0, y1 - y0
    n = rng.random((max(2, h // 60), max(2, w // 60))).astype(np.float32)
    n = np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
    arr = np.asarray(pa.base.crop((x0, y0, x1, y1)), np.float32)
    arr *= (0.975 + 0.05 * n)[..., None]
    pa.base.paste(Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)), (x0, y0))
    pa.dr.rectangle([x0, y0, x1, y1], fill=140)


def text(pa, p, x, y, s, size_m, col=WHITE, anchor='mm', emit=0.0, bold=True, font_path=None):
    ppm = p.ppm()
    f = F(size_m * ppm, bold, font_path)
    xy = p.px(x, y)
    lines = s.split('\n')
    if len(lines) > 1:
        lh = size_m * ppm * 1.05
        for i, ln in enumerate(lines):
            yy = xy[1] + (i - (len(lines) - 1) / 2) * lh
            pa.db.text((xy[0], yy), ln, font=f, fill=col, anchor=anchor)
            if emit > 0:
                pa.de.text((xy[0], yy), ln, font=f, fill=tuple(int(c * emit) for c in col), anchor=anchor)
        return
    pa.db.text(xy, s, font=f, fill=col, anchor=anchor)
    if emit > 0:
        pa.de.text(xy, s, font=f, fill=tuple(int(c * emit) for c in col), anchor=anchor)


def rect_px(p, cx, cy, w, h):
    a = p.px(cx - w / 2, cy + h / 2)
    b = p.px(cx + w / 2, cy - h / 2)
    return [a[0], a[1], b[0], b[1]]


def screw(pa, p, x, y):
    ppm = p.ppm()
    r = 0.0028 * ppm
    c = p.px(x, y)
    pa.db.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=(55, 57, 60))
    pa.db.line([c[0] - r * 0.7, c[1], c[0] + r * 0.7, c[1]], fill=(30, 30, 32), width=max(1, int(r * 0.4)))


def paint_boxes(pa, p):
    ppm = p.ppm()
    for (x, y, w, h, title) in p.boxes:
        r = rect_px(p, x + w / 2, y + h / 2, w, h)
        pa.db.rectangle(r, outline=(60, 63, 68), width=max(2, int(0.0015 * ppm)))
        inner = [r[0] + 3, r[1] + 3, r[2] - 3, r[3] - 3]
        pa.db.rectangle(inner, outline=(112, 116, 122), width=1)
        for sx, sy in ((x + 0.006, y + 0.006), (x + w - 0.006, y + 0.006), (x + 0.006, y + h - 0.006), (x + w - 0.006, y + h - 0.006)):
            screw(pa, p, sx, sy)
        if title:
            text(pa, p, x + w / 2, y + h - 0.011, title, 0.0085, WHITE, emit=0.35)


def dial(pa, p, c, kind):
    ppm = p.ppm()
    r = c.r * ppm
    cx, cy = p.px(c.x, c.y)
    pa.db.ellipse([cx - r * 1.12, cy - r * 1.12, cx + r * 1.12, cy + r * 1.12], fill=(40, 42, 45))
    pa.db.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(12, 12, 14))
    for k in range(12):
        a = math.radians(-225 + k * 270 / 11)
        x1, y1 = cx + math.cos(a) * r * 0.92, cy + math.sin(a) * r * 0.92
        x2, y2 = cx + math.cos(a) * r * 0.75, cy + math.sin(a) * r * 0.75
        pa.db.line([x1, y1, x2, y2], fill=WHITE, width=max(1, int(r * 0.05)))
        pa.de.line([x1, y1, x2, y2], fill=(90, 90, 90), width=max(1, int(r * 0.05)))
    a = math.radians(-200 if kind != 'flaps' else -225)
    pa.db.line([cx, cy, cx + math.cos(a) * r * 0.8, cy + math.sin(a) * r * 0.8], fill=WHITE, width=max(2, int(r * 0.08)))
    pa.de.line([cx, cy, cx + math.cos(a) * r * 0.8, cy + math.sin(a) * r * 0.8], fill=(120, 120, 120), width=max(2, int(r * 0.08)))
    if c.label:
        text(pa, p, c.x, c.y - c.r * 1.45, c.label, 0.007, WHITE, emit=0.3)
    lab = {'flaps': 'FLAPS', 'brake': 'PSI', 'egt': 'EGT', 'duct': 'DUCT', 'press': 'PSI', 'cabin': 'CABIN ALT',
           'rate': 'RATE', 'fuel': 'TEMP', 'cvr': 'CVR', 'trim': 'UNITS'}.get(kind, '')
    if lab:
        f = F(r * 0.28)
        pa.db.text((cx, cy + r * 0.4), lab, font=f, fill=WHITE, anchor='mm')


def paint_control(pa, p, c):
    ppm = p.ppm()
    k = c.kind
    if k == 'du':
        r = rect_px(p, c.x, c.y, c.w + 0.036, c.h + 0.040)
        pa.db.rounded_rectangle(r, radius=int(0.008 * ppm), fill=(36, 38, 41))
        r2 = rect_px(p, c.x, c.y, c.w + 0.004, c.h + 0.004)
        pa.db.rectangle(r2, fill=(5, 6, 8))
        for i in range(4):
            screw(pa, p, c.x - c.w / 2 - 0.012, c.y - c.h / 2 + 0.02 + i * 0.055)
        text(pa, p, c.x, c.y - c.h / 2 - 0.012, 'BRT', 0.006, (180, 180, 180))
    elif k == 'isfd':
        r = rect_px(p, c.x, c.y, c.w + 0.022, c.h + 0.022)
        pa.db.rounded_rectangle(r, radius=int(0.006 * ppm), fill=(30, 32, 35))
        r2 = rect_px(p, c.x, c.y, c.w, c.h)
        x0, y0, x1, y1 = [int(v) for v in r2]
        sky = Image.new('RGB', (x1 - x0, y1 - y0), (40, 110, 200))
        d = ImageDraw.Draw(sky)
        d.rectangle([0, (y1 - y0) * 0.55, x1 - x0, y1 - y0], fill=(130, 85, 40))
        d.line([0, (y1 - y0) * 0.55, x1 - x0, (y1 - y0) * 0.55], fill=(255, 255, 255), width=3)
        d.polygon([((x1 - x0) * 0.3, (y1 - y0) * 0.55), ((x1 - x0) * 0.5, (y1 - y0) * 0.6), ((x1 - x0) * 0.7, (y1 - y0) * 0.55)],
                  outline=(255, 220, 0), width=3)
        pa.base.paste(sky, (x0, y0))
        pa.emit.paste(Image.eval(sky, lambda v: int(v * 0.7)), (x0, y0))
    elif k == 'knob':
        r = c.r * ppm
        cx, cy = p.px(c.x, c.y)
        pa.db.ellipse([cx - r * 1.25, cy - r * 1.25, cx + r * 1.25, cy + r * 1.25], fill=(62, 65, 70))
        pa.db.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(20, 20, 22))
        if c.label:
            text(pa, p, c.x, c.y + c.r * 1.7, c.label, 0.0062, WHITE, emit=0.35)
        if c.ring:
            words = c.ring.split()
            for i, wd in enumerate(words):
                a = math.radians(-150 + i * 300 / max(1, len(words) - 1)) if len(words) > 1 else 0
                tx = c.x + math.sin(a) * c.r * 1.9
                ty = c.y + math.cos(a) * c.r * 1.9 - 0.002
                text(pa, p, tx, ty, wd, 0.0045, WHITE, emit=0.3)
    elif k in ('toggle', 'guard'):
        cx, cy = p.px(c.x, c.y)
        r = 0.0065 * ppm
        pa.db.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(150, 152, 156))
        if c.label:
            text(pa, p, c.x, c.y + 0.016, c.label, 0.0056, WHITE, emit=0.35)
        text(pa, p, c.x, c.y - 0.013, 'OFF' if k == 'toggle' else 'NORM', 0.0042, (200, 200, 200))
    elif k == 'annun':
        colmap = {'amber': AMBER, 'blue': BLUE, 'green': GREEN, 'red': RED}
        col = colmap.get(c.col, AMBER)
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle(r, fill=(22, 22, 24), outline=(10, 10, 10), width=2)
        lit = bool(c.lit)
        dim = tuple(int(v * (0.95 if lit else 0.35)) for v in col)
        f = F(c.h * ppm * 0.42)
        pa.db.text(p.px(c.x, c.y), c.text, font=f, fill=dim, anchor='mm')
        pa.de.text(p.px(c.x, c.y), c.text, font=f, fill=tuple(int(v * (1.0 if lit else 0.10)) for v in col), anchor='mm')
        if lit:
            pa.de.rectangle(r, outline=tuple(int(v * 0.25) for v in col), width=2)
    elif k == 'button':
        colmap = {'amber': AMBER, 'red': RED, 'white': WHITE}
        col = colmap.get(c.col, WHITE)
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle(r, fill=(28, 29, 32), outline=(12, 12, 12), width=2)
        big = c.col in ('amber', 'red')
        f = F(c.h * ppm * (0.30 if '\n' in c.text else 0.42))
        lines = c.text.split('\n')
        for i, ln in enumerate(lines):
            yy = c.y + (((len(lines) - 1) / 2) - i) * c.h * 0.36
            xy = p.px(c.x, yy)
            fill = tuple(int(v * (0.45 if big else 0.95)) for v in col)
            pa.db.text(xy, ln, font=f, fill=fill, anchor='mm')
            pa.de.text(xy, ln, font=f, fill=tuple(int(v * (0.15 if big else 0.45)) for v in col), anchor='mm')
        if c.lit:
            bar = rect_px(p, c.x, c.y - c.h * 0.36, c.w * 0.6, c.h * 0.12)
            pa.db.rectangle(bar, fill=GREEN)
            pa.de.rectangle(bar, fill=GREEN)
    elif k == 'lcd':
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle(r, fill=(8, 8, 9), outline=(40, 42, 45), width=3)
        col = WHITE if c.col == 'white' else AMBER
        f = F(c.h * ppm * 0.78, path=DIN)
        pa.db.text(p.px(c.x, c.y), c.text, font=f, fill=tuple(int(v * 0.8) for v in col), anchor='mm')
        pa.de.text(p.px(c.x, c.y), c.text, font=f, fill=col, anchor='mm')
        pa.dr.rectangle(r, fill=25)
        if c.label:
            text(pa, p, c.x, c.y + c.h * 0.5 + 0.007, c.label, 0.0055, WHITE, emit=0.35)
    elif k == 'gauge':
        dial(pa, p, c, c.dial)
    elif k == 'clock':
        cc = type('C', (), {'x': c.x, 'y': c.y, 'r': c.r, 'label': 'CLOCK'})
        dial(pa, p, cc, 'clock')
    elif k == 'gear':
        r = rect_px(p, c.x, c.y, 0.10, 0.16)
        pa.db.rectangle(r, fill=(72, 76, 82), outline=(45, 47, 50), width=3)
        text(pa, p, c.x, c.y + 0.06, 'UP', 0.008, WHITE, emit=0.35)
        text(pa, p, c.x + 0.03, c.y, 'OFF', 0.007, WHITE, emit=0.35)
        text(pa, p, c.x, c.y - 0.06, 'DN', 0.008, WHITE, emit=0.35)
        text(pa, p, c.x, c.y + 0.092, c.label, 0.0065, WHITE, emit=0.35)
    elif k == 'cb':
        cx, cy = p.px(c.x, c.y)
        r = 0.0075 * ppm
        pa.db.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(210, 210, 210))
        pa.db.ellipse([cx - r * 0.7, cy - r * 0.7, cx + r * 0.7, cy + r * 0.7], fill=(15, 15, 15))
        text(pa, p, c.x, c.y + 0.0135, '5', 0.005, (190, 190, 190))
    elif k == 'tiller':
        text(pa, p, c.x + 0.06, c.y - 0.07, 'NOSE WHEEL\nSTEERING', 0.0075, WHITE, emit=0.3)
    elif k == 'cdu':
        paint_cdu(pa, p, c)


from fdlayout import CDU_W, CDU_H, CDU_SCREEN, cdu_keys


def paint_cdu(pa, p, c):
    """CDU faceplate at panel position (c.x = centre x, c.y = aft edge y)."""
    ppm = p.ppm()
    ox = c.x - CDU_W / 2
    oy = c.y + 0.005
    r = rect_px(p, c.x, oy + CDU_H / 2, CDU_W, CDU_H)
    pa.db.rounded_rectangle(r, radius=int(0.005 * ppm), fill=(40, 42, 46))
    sx, sy, sw, sh = CDU_SCREEN
    rs = rect_px(p, ox + sx, oy + sy, sw + 0.004, sh + 0.004)
    pa.db.rectangle(rs, fill=(4, 5, 6))
    text(pa, p, ox + CDU_W / 2, oy + 0.015, 'EXEC', 0.004, (200, 200, 200))
    for (name, kx, ky, kw, kh, lab) in cdu_keys():
        rk = rect_px(p, ox + kx, oy + ky, kw, kh)
        pa.db.rounded_rectangle(rk, radius=max(1, int(0.001 * ppm)), fill=(22, 23, 26) if name[0] != 'a' else (200, 202, 205))
        col = WHITE if name[0] != 'a' else (20, 20, 22)
        f = F(min(kh * 0.45, 0.0048) * ppm * (0.7 if '\n' in lab else 1.0))
        lines = lab.split('\n')
        for i, ln in enumerate(lines):
            yy = oy + ky + (((len(lines) - 1) / 2) - i) * kh * 0.38
            pa.db.text(p.px(ox + kx, yy), ln, font=f, fill=col, anchor='mm')
            if name[0] != 'a':
                pa.de.text(p.px(ox + kx, yy), ln, font=f, fill=(70, 70, 70), anchor='mm')


def paint_panel(pa, p):
    panel_bg(p, pa)
    if p.shape:
        pass
    paint_boxes(pa, p)
    for c in p.ctls:
        paint_control(pa, p, c)
    for (x, y, s, size, col, anchor) in p.texts:
        text(pa, p, x, y, s, size, col, anchor, emit=0.3)


def paint_extras(pa):
    """Tileable material swatches in free atlas space."""
    rng = np.random.default_rng(5)
    def swatch(rect, base, amp, cells, seed, rough):
        x0, y0, x1, y1 = rect
        w, h = x1 - x0, y1 - y0
        acc = np.zeros((h, w), np.float32)
        for o, c in enumerate(cells):
            n = np.random.default_rng(seed + o).random((c, c)).astype(np.float32)
            acc += np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255 / len(cells)
        col = np.array(base, np.float32)[None, None] * (1 - amp + 2 * amp * acc[..., None])
        pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
        pa.dr.rectangle(rect, fill=rough)
    swatch(SWATCH['carpet'], (58, 62, 70), 0.18, (64, 128, 256), 10, 245)
    swatch(SWATCH['sheep'], (196, 184, 160), 0.16, (32, 96, 256), 20, 250)
    swatch(SWATCH['leather'], (44, 45, 48), 0.10, (16, 64), 30, 150)
    swatch(SWATCH['trim'], (150, 153, 156), 0.05, (8, 32), 40, 200)
    swatch(SWATCH['plastic'], (30, 31, 34), 0.06, (8, 32), 50, 120)
    swatch(SWATCH['grey'], (105, 109, 115), 0.05, (8, 32), 60, 150)
    # flight deck door
    x0, y0, x1, y1 = SWATCH['door']
    pa.db.rectangle(SWATCH['door'], fill=(140, 143, 146))
    pa.db.rectangle([x0 + 20, y0 + 20, x1 - 20, y1 - 20], outline=(110, 112, 115), width=6)
    cx = (x0 + x1) // 2
    pa.db.ellipse([cx - 14, y0 + 250, cx + 14, y0 + 278], fill=(20, 20, 20))
    pa.db.rectangle([x1 - 90, y0 + 520, x1 - 50, y0 + 560], fill=(60, 60, 62))
    f = F(26)
    pa.db.text((cx, y0 + 150), 'FLIGHT DECK', font=f, fill=(60, 60, 62), anchor='mm')
    # throttle quadrant sides (stab trim scale)
    for key in ('tq_side_l', 'tq_side_r'):
        x0, y0, x1, y1 = SWATCH[key]
        pa.db.rectangle(SWATCH[key], fill=(60, 63, 68))
        for i in range(9):
            yy = y0 + 40 + i * 20
            pa.db.line([x0 + 30, yy, x0 + 70, yy], fill=WHITE, width=3)
        pa.db.polygon([(x0 + 30, y0 + 40), (x0 + 70, y0 + 40), (x0 + 70, y0 + 120), (x0 + 30, y0 + 120)], outline=GREEN, width=4)
        pa.db.text(((x0 + x1) // 2 + 40, y0 + 30), 'STAB TRIM', font=F(22), fill=WHITE, anchor='mm')


def paint_cabin_swatches(pa):
    rng = np.random.default_rng(9)

    def noise_img(w, h, cells, seed):
        n = np.random.default_rng(seed).random((cells, cells)).astype(np.float32)
        return np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255

    # seat fabric: deep blue with a fine woven pattern and an orange pin stripe
    x0, y0, x1, y1 = SWATCH['cab_fabric']
    w, h = x1 - x0, y1 - y0
    yy, xx = np.mgrid[0:h, 0:w]
    weave = ((xx // 3 + yy // 3) % 2).astype(np.float32)
    base = np.array((22, 44, 96), np.float32)
    col = base[None, None] * (0.9 + 0.08 * weave[..., None] + 0.08 * noise_img(w, h, 16, 1)[..., None])
    stripe = (np.abs(yy - h * 0.7) < 3)
    col[stripe] = (230, 130, 30)
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    pa.dr.rectangle(SWATCH['cab_fabric'], fill=235)
    # headrest cover: off-white with a small orange sun mark
    x0, y0, x1, y1 = SWATCH['cab_head']
    pa.db.rectangle(SWATCH['cab_head'], fill=(236, 234, 228))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    pa.db.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=(243, 132, 28))
    pa.db.arc([cx - 60, cy - 20, cx + 30, cy + 70], 200, 330, fill=(245, 246, 248), width=10)
    pa.dr.rectangle(SWATCH['cab_head'], fill=230)
    # carpet
    x0, y0, x1, y1 = SWATCH['cab_carpet']
    w, h = x1 - x0, y1 - y0
    col = np.array((52, 60, 78), np.float32)[None, None] * (0.8 + 0.35 * noise_img(w, h, 128, 3)[..., None])
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    pa.dr.rectangle(SWATCH['cab_carpet'], fill=250)
    for key, c, r in (('cab_wall', (226, 225, 220), 170), ('cab_bin', (232, 232, 230), 120), ('cab_ceiling', (238, 238, 236), 190)):
        x0, y0, x1, y1 = SWATCH[key]
        w, h = x1 - x0, y1 - y0
        col = np.array(c, np.float32)[None, None] * (0.97 + 0.04 * noise_img(w, h, 24, 7)[..., None])
        pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
        pa.dr.rectangle(SWATCH[key], fill=r)
    # bin door latch line
    x0, y0, x1, y1 = SWATCH['cab_bin']
    pa.db.rectangle([x0, y0 + int((y1 - y0) * 0.78), x1, y0 + int((y1 - y0) * 0.80)], fill=(160, 160, 160))
    # PSU strip: grey with reading lights and gasper vents; lit reading lights in the emissive map
    x0, y0, x1, y1 = SWATCH['cab_psu']
    pa.db.rectangle(SWATCH['cab_psu'], fill=(196, 198, 200))
    for i in range(6):
        cx = x0 + 30 + i * ((x1 - x0 - 60) // 5)
        cy = (y0 + y1) // 2
        pa.db.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=(90, 92, 95) if i % 2 else (230, 230, 220))
        if i % 2 == 0:
            pa.de.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(80, 78, 70))
    pa.db.rectangle([x0 + 10, y0 + 6, x0 + 80, y0 + 22], fill=(40, 40, 42))
    # light strip (emissive white)
    pa.db.rectangle(SWATCH['cab_light'], fill=(250, 248, 240))
    pa.de.rectangle(SWATCH['cab_light'], fill=(255, 250, 236))
    # curtain (blue)
    x0, y0, x1, y1 = SWATCH['cab_curtain']
    w, h = x1 - x0, y1 - y0
    xx = np.arange(w)[None, :].repeat(h, 0)
    fold = 0.85 + 0.15 * np.cos(xx / 9.0)
    col = np.array((25, 50, 105), np.float32)[None, None] * fold[..., None]
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    # window shade / reveal plastic
    pa.db.rectangle(SWATCH['cab_reveal'], fill=(218, 218, 214))


from fdlayout import SWATCH


def paint_tq(pa, p):
    panel_bg(p, pa)
    ppm = p.ppm()
    # lever slots and scales
    for yy in (0.13, 0.27):
        r = rect_px(p, yy, 0.30, 0.018, 0.40)
        pa.db.rectangle(r, fill=(12, 12, 14))
    for lab, yv in (('FWD', 0.46), ('IDLE', 0.14), ('REV', 0.08)):
        text(pa, p, 0.20, yv, lab, 0.009, WHITE, emit=0.3)
    # speedbrake (left) and flap (right) gates
    r = rect_px(p, 0.03, 0.30, 0.012, 0.36)
    pa.db.rectangle(r, fill=(12, 12, 14))
    for i, lab in enumerate(('DOWN', 'ARMED', 'FLIGHT DETENT', 'UP')):
        text(pa, p, 0.075, 0.46 - i * 0.09, lab, 0.0065, WHITE, emit=0.3)
    r = rect_px(p, 0.37, 0.30, 0.012, 0.36)
    pa.db.rectangle(r, fill=(12, 12, 14))
    for i, lab in enumerate(('UP', '1', '2', '5', '10', '15', '25', '30', '40')):
        text(pa, p, 0.335, 0.47 - i * 0.042, lab, 0.0075, WHITE, emit=0.3)
    text(pa, p, 0.335, 0.52, 'FLAPS', 0.008, WHITE, emit=0.3)
    text(pa, p, 0.20, 0.53, 'ENG 1    ENG 2', 0.008, WHITE, emit=0.3)
    text(pa, p, 0.20, 0.035, 'START LEVERS  IDLE / CUTOFF', 0.0065, WHITE, emit=0.3)


def render_screens():
    """Static display images for Cycles renders only (the game uses the live avionics canvases)."""
    out = {}
    S = 512
    # PFD
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = S * 0.46, S * 0.50
    horizon = Image.new('RGB', (int(S * 0.5), int(S * 0.5)), (40, 110, 210))
    hd = ImageDraw.Draw(horizon)
    hd.rectangle([0, S * 0.27, S * 0.5, S * 0.5], fill=(150, 90, 40))
    hd.line([0, S * 0.27, S * 0.5, S * 0.27], fill=(255, 255, 255), width=3)
    for k in (-2, -1, 1, 2):
        yy = S * 0.27 - k * S * 0.045
        w = S * (0.06 if k % 2 else 0.1)
        hd.line([S * 0.25 - w, yy, S * 0.25 + w, yy], fill=(255, 255, 255), width=2)
    horizon = horizon.rotate(-4, resample=Image.BICUBIC)
    im.paste(horizon, (int(cx - S * 0.25), int(cy - S * 0.25)))
    d.polygon([(cx - 70, cy), (cx - 25, cy), (cx - 25, cy + 12), (cx - 32, cy + 12), (cx - 32, cy + 6), (cx - 70, cy + 6)], fill=(0, 0, 0), outline=(255, 255, 0))
    d.polygon([(cx + 70, cy), (cx + 25, cy), (cx + 25, cy + 12), (cx + 32, cy + 12), (cx + 32, cy + 6), (cx + 70, cy + 6)], fill=(0, 0, 0), outline=(255, 255, 0))
    d.rectangle([cx - 4, cy - 4, cx + 4, cy + 4], outline=(255, 255, 0), width=2)
    f = ImageFont.truetype(HELV, 22, index=1)
    fs = ImageFont.truetype(HELV, 16, index=1)
    d.rectangle([20, 100, 80, 410], fill=(60, 60, 70))
    d.rectangle([22, 240, 82, 272], fill=(0, 0, 0), outline=(255, 255, 255))
    d.text((52, 256), '250', font=f, fill=(255, 255, 255), anchor='mm')
    d.rectangle([380, 100, 450, 410], fill=(60, 60, 70))
    d.rectangle([378, 240, 452, 272], fill=(0, 0, 0), outline=(255, 255, 255))
    d.text((415, 256), '10000', font=fs, fill=(255, 255, 255), anchor='mm')
    d.text((60, 70), '250', font=fs, fill=(255, 0, 255), anchor='mm')
    d.text((415, 70), '10000', font=fs, fill=(255, 0, 255), anchor='mm')
    d.text((150, 30), 'MCP SPD', font=fs, fill=(0, 255, 0), anchor='mm')
    d.text((240, 30), 'HDG SEL', font=fs, fill=(0, 255, 0), anchor='mm')
    d.text((330, 30), 'ALT', font=fs, fill=(0, 255, 0), anchor='mm')
    d.chord([cx - 120, S - 110, cx + 120, S + 130], 200, 340, fill=(60, 60, 70))
    d.text((cx, S - 95), '287', font=f, fill=(255, 255, 255), anchor='mm')
    out['pfd'] = im
    # ND (map mode arc)
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    c = (S / 2, S * 0.82)
    for rr in (0.35, 0.7):
        R = S * rr
        d.arc([c[0] - R, c[1] - R, c[0] + R, c[1] + R], 215, 325, fill=(255, 255, 255), width=2)
    for k in range(-5, 6):
        a = math.radians(-90 + k * 10)
        R = S * 0.7
        d.line([c[0] + math.cos(a) * R, c[1] + math.sin(a) * R, c[0] + math.cos(a) * (R - 12), c[1] + math.sin(a) * (R - 12)], fill=(255, 255, 255), width=2)
    pts = [(c[0], c[1]), (c[0] + 30, c[1] - 120), (c[0] + 90, c[1] - 260), (c[0] + 60, c[1] - 380)]
    d.line(pts, fill=(255, 0, 255), width=3)
    for pt, nm in zip(pts[1:], ('SFO', 'OSI', 'PORTE')):
        d.polygon([(pt[0], pt[1] - 7), (pt[0] + 7, pt[1]), (pt[0], pt[1] + 7), (pt[0] - 7, pt[1])], outline=(0, 255, 255))
        d.text((pt[0] + 14, pt[1]), nm, font=fs, fill=(0, 255, 255), anchor='lm')
    d.polygon([(c[0], c[1] - 20), (c[0] - 10, c[1] + 10), (c[0] + 10, c[1] + 10)], outline=(255, 255, 255))
    d.text((S / 2, 22), 'TRK 287 MAG', font=f, fill=(0, 255, 0), anchor='mm')
    d.text((40, 30), 'GS 250', font=fs, fill=(255, 255, 255), anchor='lm')
    out['nd'] = im
    # EICAS (engine display): N1/EGT dials
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, x in enumerate((140, 372)):
        for j, (y, val) in enumerate(((120, '85.2'), (300, '612'))):
            R = 70
            d.arc([x - R, y - R, x + R, y + R], 180, 390, fill=(255, 255, 255), width=4)
            d.pieslice([x - R + 6, y - R + 6, x + R - 6, y + R - 6], 180, 330, fill=(90, 90, 90))
            d.rectangle([x - 5, y - 44, x + 70, y - 14], outline=(255, 255, 255))
            d.text((x + 32, y - 29), val, font=fs, fill=(255, 255, 255), anchor='mm')
    d.text((S / 2, 120), 'N1', font=f, fill=(0, 200, 255), anchor='mm')
    d.text((S / 2, 300), 'EGT', font=f, fill=(0, 200, 255), anchor='mm')
    d.text((S / 2, 440), 'FUEL  5.4  12.1  5.4', font=fs, fill=(255, 255, 255), anchor='mm')
    out['eicas'] = im
    # CDU page
    im = Image.new('RGB', (S, int(S * 0.8)), (0, 0, 0))
    d = ImageDraw.Draw(im)
    fm = ImageFont.truetype(MONO, 24)
    lines = [('      PERF INIT', (255, 255, 255)), ('GW/CRZ CG     TRIP/CRZ ALT', (255, 255, 255)),
             ('142.3/ 25.0%    FL370', (0, 255, 255)), ('PLAN/FUEL       CRZ WIND', (255, 255, 255)),
             ('12.1           280/045', (0, 255, 255)), ('ZFW             ISA DEV', (255, 255, 255)),
             ('130.2              11C', (0, 255, 255)), ('RESERVES       T/C OAT', (255, 255, 255)),
             ('  4.2              -45C', (0, 255, 255)), ('', (0, 0, 0)), ('<INDEX       N1 LIMIT>', (255, 255, 255))]
    for i, (ln, col) in enumerate(lines):
        d.text((16, 16 + i * 34), ln, font=fm, fill=col)
    out['cdu'] = im
    for k, im in out.items():
        # screens are authored upside-down in UV (v=0 at the top, matching the CanvasTexture flipY)
        im.transpose(Image.FLIP_TOP_BOTTOM).save(os.path.join(TEX, f'fd_screen_{k}.png'))
    return out


def main():
    pa = Painter()
    L = FL.layout()
    for name, p in L.items():
        if name == 'tq_top':
            paint_tq(pa, p)
        else:
            paint_panel(pa, p)
    paint_extras(pa)
    paint_cabin_swatches(pa)
    base = pa.base
    base.save(os.path.join(TEX, 'fd_base.jpg'), quality=92)
    em = pa.emit.filter(ImageFilter.GaussianBlur(0.6))
    em.save(os.path.join(TEX, 'fd_emit.jpg'), quality=90)
    r = np.asarray(pa.rough, np.float32) / 255
    orm = np.stack([np.ones_like(r), r, np.zeros_like(r)], -1)
    Image.fromarray((orm * 255).astype(np.uint8)).resize((A // 2, A // 2), Image.LANCZOS).save(os.path.join(TEX, 'fd_orm.jpg'), quality=90)
    render_screens()
    print('wrote fd atlas')


if __name__ == '__main__':
    main()
