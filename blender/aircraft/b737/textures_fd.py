"""737-800 flight deck panel atlas painter. Run with the repo venv:
    .venv/bin/python blender/aircraft/b737/textures_fd.py
Writes tex/fd_base_raw.png (panel albedo, 4096^2, layout from fdlayout.py; the bake step multiplies ambient
occlusion / soft interior light into it -> fd_base.jpg), tex/fd_emit.jpg (2048^2 lit legends, annunciators,
LCD digits), tex/fd_swatch.png (tileable source textures for the baked structure atlas) and
tex/fd_screen_*.png (static display images used only by the Cycles renders).

Colours follow the reference photos: Boeing grey (blue-grey) panels with white Futura legends, charcoal MCP /
EFIS faceplates, black glareshield, cream toggle handles, amber/blue/green annunciators, orange LED windows.
"""
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
FUTURA = '/System/Library/Fonts/Supplemental/Futura.ttc'
HELV = '/System/Library/Fonts/HelveticaNeue.ttc'
MONO = '/System/Library/Fonts/SFNSMono.ttf'
B612M = os.path.join(HERE, '..', '..', '..', 'src', 'avionics', 'fonts', 'B612Mono-Regular.ttf')

WHITE = (236, 237, 234)
BG = {
    'gray': (102, 111, 120),       # Boeing grey
    'gray2': (110, 118, 126),
    'mcp': (54, 57, 61),           # MCP / EFIS / six-pack faceplates
    'black': (24, 25, 27),         # glareshield
    'dark': (44, 46, 50),          # throttle quadrant cover
    'light': (176, 180, 182),      # side console tops
}
LIGHT = {                           # (lit colour, unlit legend colour)
    'amber': ((255, 168, 40), (150, 140, 118)),
    'red': ((255, 45, 30), (160, 118, 110)),
    'green': ((70, 240, 110), (130, 150, 132)),
    'blue': ((70, 170, 255), (128, 140, 158)),
    'white': ((245, 245, 240), (150, 150, 146)),
}
LCD = {'mcp': (255, 140, 40), 'amber': (255, 150, 40), 'green': (80, 255, 110), 'white': (240, 240, 240)}
LABEL_EMIT = 0.10          # panel legends are backlit (integral lighting): faint in daylight
_fonts = {}


def F(size_px, face='futura'):
    size_px = max(6, int(round(size_px)))
    key = (size_px, face)
    if key not in _fonts:
        if face == 'futura':
            _fonts[key] = ImageFont.truetype(FUTURA, size_px, index=0)
        elif face == 'cond':
            _fonts[key] = ImageFont.truetype(FUTURA, size_px, index=3)
        elif face == 'bold':
            _fonts[key] = ImageFont.truetype(FUTURA, size_px, index=2)
        elif face == 'mono':
            _fonts[key] = ImageFont.truetype(B612M if os.path.exists(B612M) else MONO, size_px)
        else:
            _fonts[key] = ImageFont.truetype(HELV, size_px, index=1)
    return _fonts[key]


class Painter:
    def __init__(self, size=A):
        self.base = Image.new('RGB', (size, size), (60, 64, 68))
        self.emit = Image.new('RGB', (size, size), (0, 0, 0))
        self.db = ImageDraw.Draw(self.base)
        self.de = ImageDraw.Draw(self.emit)


def scale(c, k):
    return tuple(int(max(0, min(255, v * k))) for v in c)


# ------------------------------------------------------------------ primitives in panel coordinates
def rect_px(p, cx, cy, w, h):
    a = p.px(cx - w / 2, cy + h / 2)
    b = p.px(cx + w / 2, cy - h / 2)
    return [a[0], a[1], b[0], b[1]]


def text(pa, p, x, y, s, size_m, col=WHITE, anchor='mm', emit=LABEL_EMIT, face='futura', spacing=1.08):
    """size_m = cap height in metres (Futura caps are ~0.72 of the font size)."""
    if not s:
        return
    ppm = p.ppm()
    fs = size_m * ppm / 0.72
    f = F(fs, face)
    lines = s.split('\n')
    lh = size_m * spacing * 1.25
    for i, ln in enumerate(lines):
        yy = y + ((len(lines) - 1) / 2 - i) * lh
        xy = p.px(x, yy)
        pa.db.text(xy, ln, font=f, fill=col, anchor=anchor)
        if emit > 0:
            pa.de.text(xy, ln, font=f, fill=scale(col, emit), anchor=anchor)


def fit_text(pa, p, x, y, s, w, h, col, emit=0.0, face='cond', max_size=None):
    """Legend fitted into a w x h box (multi-line)."""
    lines = s.split('\n')
    n = len(lines)
    size = min(h / (n * 1.30 + 0.25), max_size or 1.0)
    ppm = p.ppm()
    # shrink until the widest line fits
    for _ in range(12):
        f = F(size * ppm / 0.72, face)
        wmax = max(f.getlength(ln) for ln in lines) / ppm
        if wmax <= w * 0.90:
            break
        size *= 0.9
    text(pa, p, x, y, s, size, col, emit=emit, face=face, spacing=1.0)


def disk(pa, p, x, y, r, fill, emit=None, outline=None, width=1):
    cx, cy = p.px(x, y)
    rr = r * p.ppm()
    pa.db.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=fill, outline=outline, width=width)
    if emit is not None:
        pa.de.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=emit)


def screw(pa, p, x, y, r=0.0028):
    cx, cy = p.px(x, y)
    rr = r * p.ppm()
    pa.db.ellipse([cx - rr * 1.25, cy - rr * 1.25, cx + rr * 1.25, cy + rr * 1.25], fill=(40, 43, 47))
    pa.db.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(150, 154, 158))
    pa.db.ellipse([cx - rr * 0.8, cy - rr * 0.8, cx + rr * 0.6, cy + rr * 0.6], fill=(178, 182, 186))
    w = max(1, int(rr * 0.35))
    pa.db.line([cx - rr * 0.75, cy + rr * 0.3, cx + rr * 0.75, cy - rr * 0.3], fill=(55, 58, 62), width=w)


def seg7(pa, p, x, y, s, h, col, emit=1.0):
    """Seven-segment digits centred at (x, y), digit height h (m). '+', '-', '.', ' ' supported."""
    ppm = p.ppm()
    dh = h * ppm
    dw = dh * 0.50
    t = dh * 0.13
    g = t * 0.12
    pitch = dw + dh * 0.26
    chars = [c for c in s if c != '.']
    total = pitch * len(chars) - dh * 0.26
    cx, cy = p.px(x, y)
    x0 = cx - total / 2
    y0 = cy - dh / 2
    SEG = {'0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc',
           '8': 'abcdefg', '9': 'abcdfg', '-': 'g', '+': 'gp', ' ': ''}
    ends = {'a': ((0, 0), (1, 0)), 'b': ((1, 0), (1, 0.5)), 'c': ((1, 0.5), (1, 1)), 'd': ((0, 1), (1, 1)),
            'e': ((0, 0.5), (0, 1)), 'f': ((0, 0), (0, 0.5)), 'g': ((0, 0.5), (1, 0.5)), 'p': ((0.5, 0.22), (0.5, 0.78))}
    dim = scale(col, 0.07)
    sk = dw * 0.10

    def hexseg(ox, P, Q):
        P = np.array((ox + P[0] * dw, y0 + P[1] * dh))
        Q = np.array((ox + Q[0] * dw, y0 + Q[1] * dh))
        u = (Q - P) / np.linalg.norm(Q - P)
        n = np.array((-u[1], u[0]))
        h2 = t / 2
        pts = [P + u * g, P + u * (g + h2) + n * h2, Q - u * (g + h2) + n * h2, Q - u * g, Q - u * (g + h2) - n * h2,
               P + u * (g + h2) - n * h2]
        return [(float(q[0] + sk * (1 - (q[1] - y0) / dh)), float(q[1])) for q in pts]

    k = 0
    for ch in s:
        if ch == '.':
            px0 = x0 + k * pitch - dh * 0.13
            pa.db.ellipse([px0 - t * 0.55, y0 + dh - t * 1.1, px0 + t * 0.55, y0 + dh], fill=col)
            pa.de.ellipse([px0 - t * 0.55, y0 + dh - t * 1.1, px0 + t * 0.55, y0 + dh], fill=scale(col, emit))
            continue
        ox = x0 + k * pitch
        k += 1
        on = SEG.get(ch, '')
        for name, (P, Q) in ends.items():
            if name == 'p' and ch != '+':
                continue
            poly = hexseg(ox, P, Q)
            if name in on:
                pa.db.polygon(poly, fill=col)
                pa.de.polygon(poly, fill=scale(col, emit))
            elif name != 'p':
                pa.db.polygon(poly, fill=dim)


# ------------------------------------------------------------------ panel background and plates
def noise(w, h, cells, seed):
    n = np.random.default_rng(seed).random((max(2, cells[1]), max(2, cells[0]))).astype(np.float32)
    return np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255


def panel_bg(pa, p):
    x0, y0, x1, y1 = [int(v) for v in p.rect]
    w, h = x1 - x0, y1 - y0
    col = np.array(BG.get(p.bg, BG['gray']), np.float32)
    seed = sum(ord(c) for c in p.name)
    n = 0.6 * noise(w, h, (w // 90, h // 90), seed) + 0.4 * noise(w, h, (w // 12, h // 12), seed + 1)
    img = col[None, None] * (0.965 + 0.07 * n[..., None])
    pa.base.paste(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)), (x0, y0))


def paint_plate(pa, p, plate, idx):
    x, y, w, h, title, style, title_at = plate
    ppm = p.ppm()
    col = BG.get(style, BG['gray'])
    rng = np.random.default_rng(idx * 7 + len(p.name))
    col = scale(col, 0.97 + 0.06 * rng.random())
    r = rect_px(p, x + w / 2, y + h / 2, w, h)
    gap = max(2, int(0.0012 * ppm))
    pa.db.rectangle([r[0] - gap, r[1] - gap, r[2] + gap, r[3] + gap], fill=(28, 30, 33))
    pa.db.rectangle(r, fill=col)
    # soft bevel: light top/left, dark bottom/right edges
    b = max(1, int(0.0008 * ppm))
    pa.db.line([r[0], r[1], r[2], r[1]], fill=scale(col, 1.18), width=b)
    pa.db.line([r[0], r[1], r[0], r[3]], fill=scale(col, 1.12), width=b)
    pa.db.line([r[0], r[3], r[2], r[3]], fill=scale(col, 0.75), width=b)
    pa.db.line([r[2], r[1], r[2], r[3]], fill=scale(col, 0.8), width=b)
    if w > 0.05 and h > 0.035:
        rs = 0.0024 if style != 'mcp' else 0.0020
        pts = [(x + 0.006, y + 0.006), (x + w - 0.006, y + 0.006), (x + 0.006, y + h - 0.006), (x + w - 0.006, y + h - 0.006)]
        if style in ('gray', 'gray2') and p.name.startswith('ovh'):
            # Dzus fasteners along the long edges of the overhead plates
            n = int(w / 0.07)
            for k in range(1, n):
                pts += [(x + w * k / n, y + 0.006), (x + w * k / n, y + h - 0.006)]
            n = int(h / 0.08)
            for k in range(1, n):
                pts += [(x + 0.006, y + h * k / n), (x + w - 0.006, y + h * k / n)]
        for sx, sy in pts:
            screw(pa, p, sx, sy, rs)
    if title:
        size = 0.0040 if h > 0.06 else 0.0034
        ty = y + h - 0.0085 if title_at == 'top' else y + 0.0075
        text(pa, p, x + w / 2, ty, title, size, WHITE)
        # Boeing-style title bar: thin white lines left and right of the title
        f = F(size * ppm / 0.72)
        tw = f.getlength(title) / ppm
        lw = max(1, int(0.0006 * ppm))
        for sgn in (-1, 1):
            xa = x + w / 2 + sgn * (tw / 2 + 0.004)
            xb = x + w / 2 + sgn * (w / 2 - 0.012)
            if (xb - xa) * sgn > 0.006:
                a_ = p.px(xa, ty)
                b_ = p.px(xb, ty)
                pa.db.line([a_, b_], fill=scale(WHITE, 0.9), width=lw)


# ------------------------------------------------------------------ dials
def dial(pa, p, x, y, r, kind):
    ppm = p.ppm()
    R = r * ppm
    cx, cy = p.px(x, y)
    pa.db.ellipse([cx - R * 1.22, cy - R * 1.22, cx + R * 1.22, cy + R * 1.22], fill=(34, 36, 39))
    pa.db.ellipse([cx - R * 1.08, cy - R * 1.08, cx + R * 1.08, cy + R * 1.08], fill=(52, 55, 58))
    pa.db.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(10, 10, 12))
    wmin = max(1, int(R * 0.035))
    specs = {
        # a0, a1 (deg, 0 = up, clockwise), major ticks, labels, needle value (0..1), caption
        'flaps': (-150, 150, 9, ['0', '1', '2', '5', '10', '15', '25', '30', '40'], 0.0, 'FLAPS'),
        'brake': (-135, 45, 5, ['0', '1', '2', '3', '4'], 0.75, 'BRAKE\nPRESS'),
        'egt': (-135, 90, 6, ['0', '2', '4', '6', '8', '10'], 0.0, 'EGT'),
        'press': (-135, 135, 5, ['0', '20', '40', '60', '80'], 0.0, 'DUCT\nPRESS'),
        'duct': (-120, 120, 5, ['0', '20', '40', '60', '80'], 0.4, 'TEMP'),
        'fueltemp': (-120, 120, 5, ['-50', '', '0', '', '+50'], 0.55, 'FUEL\nTEMP'),
        'cabalt': (-160, 160, 11, ['0', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50'], 0.02, 'CABIN\nALT'),
        'climb': (-150, 150, 7, ['4', '2', '1', '0', '1', '2', '4'], 0.5, 'CABIN\nCLIMB'),
        'valve': (-60, 60, 2, ['C', 'O'], 0.9, ''),
        'oxy': (-135, 135, 5, ['0', '4', '8', '12', '16'], 0.8, 'PSI'),
        'rudtrim': (-60, 60, 7, ['', '', '', '0', '', '', ''], 0.5, 'UNITS'),
        'yaw': (-50, 50, 5, ['', '', '', '', ''], 0.5, ''),
    }
    if kind == 'rdmi':
        # compass card with heading numbers + two needles
        for k in range(72):
            a = math.radians(k * 5)
            l = 0.16 if k % 2 == 0 else 0.09
            x1_, y1_ = cx + math.sin(a) * R * 0.95, cy - math.cos(a) * R * 0.95
            x2_, y2_ = cx + math.sin(a) * R * (0.95 - l), cy - math.cos(a) * R * (0.95 - l)
            pa.db.line([x1_, y1_, x2_, y2_], fill=WHITE, width=wmin)
        f = F(R * 0.22, 'cond')
        for k, lab in enumerate(['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33']):
            a = math.radians(k * 30)
            pa.db.text((cx + math.sin(a) * R * 0.62, cy - math.cos(a) * R * 0.62), lab, font=f, fill=WHITE, anchor='mm')
        pa.db.line([cx - R * 0.1, cy + R * 0.7, cx + R * 0.15, cy - R * 0.7], fill=(40, 200, 90), width=max(2, int(R * 0.06)))
        pa.db.line([cx + R * 0.2, cy + R * 0.65, cx - R * 0.25, cy - R * 0.65], fill=(250, 250, 250), width=max(2, int(R * 0.05)))
        pa.db.polygon([(cx, cy - R * 1.02), (cx - R * 0.06, cy - R * 1.12), (cx + R * 0.06, cy - R * 1.12)], fill=(255, 160, 40))
        return
    if kind == 'clock':
        pa.db.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(14, 16, 20))
        for k in range(60):
            a = math.radians(k * 6)
            l = 0.12 if k % 5 == 0 else 0.05
            pa.db.line([cx + math.sin(a) * R * 0.95, cy - math.cos(a) * R * 0.95, cx + math.sin(a) * R * (0.95 - l),
                        cy - math.cos(a) * R * (0.95 - l)], fill=WHITE, width=wmin)
        # digital windows (UTC / ET)
        for dy, s, col in ((-0.28, '1243', (120, 255, 150)), (0.28, '0045', (120, 255, 150))):
            ww, hh = R * 0.95, R * 0.34
            yy = cy + dy * R
            pa.db.rectangle([cx - ww / 2, yy - hh / 2, cx + ww / 2, yy + hh / 2], fill=(20, 28, 24))
            f = F(hh * 0.95, 'mono')
            pa.db.text((cx, yy), s[:2] + ':' + s[2:], font=f, fill=scale(col, 0.8), anchor='mm')
            pa.de.text((cx, yy), s[:2] + ':' + s[2:], font=f, fill=scale(col, 0.6), anchor='mm')
        f = F(R * 0.14, 'cond')
        pa.db.text((cx, cy - R * 0.62), 'UTC', font=f, fill=WHITE, anchor='mm')
        pa.db.text((cx, cy + R * 0.62), 'ET/CHR', font=f, fill=WHITE, anchor='mm')
        return
    a0, a1, nt, labs, val, cap = specs.get(kind, specs['press'])
    for k in range(nt):
        t = k / max(1, nt - 1)
        a = math.radians(a0 + t * (a1 - a0))
        pa.db.line([cx + math.sin(a) * R * 0.94, cy - math.cos(a) * R * 0.94, cx + math.sin(a) * R * 0.76,
                    cy - math.cos(a) * R * 0.76], fill=WHITE, width=max(wmin, int(R * 0.05)))
        if k < len(labs) and labs[k]:
            f = F(R * 0.26, 'cond')
            pa.db.text((cx + math.sin(a) * R * 0.55, cy - math.cos(a) * R * 0.55), labs[k], font=f, fill=WHITE, anchor='mm')
        if k < nt - 1:
            for j in range(1, 4):
                tt = (k + j / 4) / max(1, nt - 1)
                aa = math.radians(a0 + tt * (a1 - a0))
                pa.db.line([cx + math.sin(aa) * R * 0.94, cy - math.cos(aa) * R * 0.94, cx + math.sin(aa) * R * 0.86,
                            cy - math.cos(aa) * R * 0.86], fill=scale(WHITE, 0.8), width=wmin)
    if kind == 'brake':
        # green arc + red radial
        pa.db.arc([cx - R * 0.94, cy - R * 0.94, cx + R * 0.94, cy + R * 0.94], a0 - 90 + 0.5 * (a1 - a0), a0 - 90 + 0.9 * (a1 - a0),
                  fill=(40, 200, 80), width=max(2, int(R * 0.08)))
    if kind == 'cabalt':
        # second (inner) diff-press scale
        pa.db.arc([cx - R * 0.42, cy - R * 0.42, cx + R * 0.42, cy + R * 0.42], -200, 20, fill=scale(WHITE, 0.8), width=wmin)
    if cap:
        f = F(R * 0.17, 'cond')
        for i, ln in enumerate(cap.split('\n')):
            pa.db.text((cx, cy + R * (0.30 + i * 0.2)), ln, font=f, fill=WHITE, anchor='mm')
    a = math.radians(a0 + val * (a1 - a0))
    nw = max(2, int(R * 0.07))
    pa.db.line([cx - math.sin(a) * R * 0.15, cy + math.cos(a) * R * 0.15, cx + math.sin(a) * R * 0.86, cy - math.cos(a) * R * 0.86],
               fill=(245, 245, 245), width=nw)
    if kind == 'flaps':
        a2 = math.radians(a0 + 0.01 * (a1 - a0))
        pa.db.line([cx, cy, cx + math.sin(a2) * R * 0.70, cy - math.cos(a2) * R * 0.70], fill=(240, 240, 240), width=nw)
    pa.db.ellipse([cx - R * 0.1, cy - R * 0.1, cx + R * 0.1, cy + R * 0.1], fill=(30, 30, 32))


# ------------------------------------------------------------------ controls
def paint_control(pa, p, c):
    ppm = p.ppm()
    k = c.kind
    if k == 'du':
        hw, hh = c.w + 0.030, c.h + 0.042
        r = rect_px(p, c.x, c.y - 0.004, hw, hh)
        pa.db.rounded_rectangle(r, radius=int(0.006 * ppm), fill=(40, 42, 46))
        r2 = rect_px(p, c.x, c.y, c.w + 0.006, c.h + 0.006)
        pa.db.rectangle(r2, fill=(8, 9, 11))
        for sx in (-1, 1):
            for sy in (-1, 1):
                screw(pa, p, c.x + sx * (hw / 2 - 0.006), c.y - 0.004 + sy * (hh / 2 - 0.006), 0.0022)
    elif k == 'isfd':
        hw, hh = c.w + 0.016, c.h + 0.030
        r = rect_px(p, c.x, c.y - 0.006, hw, hh)
        pa.db.rounded_rectangle(r, radius=int(0.005 * ppm), fill=(30, 32, 35))
        pa.db.rectangle(rect_px(p, c.x, c.y, c.w + 0.003, c.h + 0.003), fill=(6, 7, 9))
        for i, t in enumerate(('APP', 'HP/IN', '-', '+', 'RST')):
            xx = c.x - hw / 2 + 0.010 + i * (hw - 0.020) / 4
            pa.db.rounded_rectangle(rect_px(p, xx, c.y - c.h / 2 - 0.010, 0.010, 0.006), radius=2, fill=(55, 57, 60))
            fit_text(pa, p, xx, c.y - c.h / 2 - 0.010, t, 0.010, 0.005, WHITE)
        disk(pa, p, c.x + hw / 2 - 0.007, c.y - c.h / 2 - 0.018, 0.005, (20, 20, 22))
    elif k == 'knob':
        paint_knob(pa, p, c)
    elif k == 'toggle':
        paint_toggle(pa, p, c)
    elif k in ('annun', 'pbtn', 'mc'):
        paint_light(pa, p, c)
    elif k == 'lcd':
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle([r[0] - 3, r[1] - 3, r[2] + 3, r[3] + 3], fill=(30, 31, 33))
        pa.db.rectangle(r, fill=(6, 6, 7))
        col = LCD.get(c.col or 'amber', LCD['amber'])
        digits = c.text
        n = len(digits.replace('.', ''))
        hdig = min(c.h * 0.70, c.w / max(1, n) / 0.72)
        if c.col == 'green' and not any(ch.isdigit() for ch in digits[:1]) and digits[:1] in 'NSEW':
            f = F(hdig * ppm / 0.72, 'mono')
            pa.db.text(p.px(c.x, c.y), digits, font=f, fill=col, anchor='mm')
            pa.de.text(p.px(c.x, c.y), digits, font=f, fill=col, anchor='mm')
        else:
            seg7(pa, p, c.x, c.y, digits, hdig, col)
        if c.label:
            ly = c.label_y if c.label_y is not None else c.y + c.h / 2 + 0.0055
            text(pa, p, c.x, ly, c.label, 0.0030 if p.name == 'glareshield' else 0.0028, WHITE)
    elif k in ('gauge', 'clock'):
        dial(pa, p, c.x, c.y, c.r, 'clock' if k == 'clock' else c.dial)
        if c.label:
            text(pa, p, c.x, c.y + c.r * 1.22 + 0.006, c.label, 0.0030, WHITE)
    elif k == 'gear':
        # lever slot + UP / OFF / DN
        r = rect_px(p, c.x, c.y, 0.020, 0.150)
        pa.db.rounded_rectangle(r, radius=int(0.008 * ppm), fill=(18, 18, 20))
        text(pa, p, c.x, c.y + 0.086, 'UP', 0.0038)
        text(pa, p, c.x + 0.020, c.y + 0.045, 'OFF', 0.0032)
        text(pa, p, c.x, c.y - 0.086, 'DN', 0.0038)
        text(pa, p, c.x - 0.020, c.y, 'LANDING\nGEAR', 0.0024)
    elif k == 'placard':
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle(r, fill=(58, 62, 67), outline=(120, 124, 128), width=max(1, int(0.0005 * ppm)))
        fit_text(pa, p, c.x, c.y, c.text, c.w * 0.95, c.h * 0.92, WHITE, face='cond', max_size=0.0028)
    elif k == 'cdu':
        paint_cdu(pa, p, c)
    elif k == 'firehandle':
        r = rect_px(p, c.x, c.y, c.w + 0.012, c.h + 0.030)
        pa.db.rounded_rectangle(r, radius=int(0.004 * ppm), fill=(22, 22, 24))
        # the handle itself (its top face samples this footprint): red with a white engine number
        pa.db.rounded_rectangle(rect_px(p, c.x, c.y, c.w, c.h), radius=int(0.003 * ppm), fill=(168, 22, 20))
        fit_text(pa, p, c.x, c.y, c.text, c.w * 0.7, c.h * 0.8, WHITE, face='bold')
        text(pa, p, c.x, c.y + c.h / 2 + 0.010, 'PULL', 0.0028)
        text(pa, p, c.x - c.w / 2 - 0.004, c.y - c.h / 2 - 0.006, 'L', 0.0028)
        text(pa, p, c.x + c.w / 2 + 0.004, c.y - c.h / 2 - 0.006, 'R', 0.0028)
    elif k == 'rxknob':
        r = rect_px(p, c.x, c.y, c.w + 0.004, c.h + 0.004)
        pa.db.rectangle(r, fill=(28, 29, 31))
        text(pa, p, c.x, c.y + c.h / 2 + 0.005, c.text, 0.0026)
    elif k == 'wheel':
        r = rect_px(p, c.x, c.y, c.w + 0.004, c.h + 0.006)
        pa.db.rectangle(r, fill=(12, 12, 14))
        text(pa, p, c.x + 0.012, c.y + c.h / 2 - 0.002, 'DN', 0.0026)
        text(pa, p, c.x + 0.012, c.y - c.h / 2 + 0.002, 'UP', 0.0026)
    elif k == 'keypad':
        for i in range(12):
            rr, cc = divmod(i, 4)
            xx = c.x - c.w / 2 + (cc + 0.5) * c.w / 4
            yy = c.y + c.h / 2 - (rr + 0.5) * c.h / 3
            pa.db.rounded_rectangle(rect_px(p, xx, yy, c.w / 4 * 0.78, c.h / 3 * 0.72), radius=3, fill=(40, 42, 45))
            fit_text(pa, p, xx, yy, ('1', '2', '3', 'H', '4', '5', '6', 'CLR', '7', '8', '9', 'ENT')[i], c.w / 4 * 0.6,
                     c.h / 3 * 0.5, WHITE)
    elif k == 'ledev':
        r = rect_px(p, c.x, c.y, c.w, c.h)
        pa.db.rectangle(r, fill=(30, 32, 35))
        # stylised planform with slat/flap lights
        cx, cy = p.px(c.x, c.y)
        s_ = c.w * ppm
        pa.db.line([cx, cy - s_ * 0.28, cx, cy + s_ * 0.25], fill=WHITE, width=2)
        for sgn in (-1, 1):
            pa.db.line([cx, cy - s_ * 0.05, cx + sgn * s_ * 0.45, cy + s_ * 0.12], fill=WHITE, width=2)
            for i in range(4):
                xx = c.x + sgn * (0.012 + i * 0.015)
                yy = c.y + 0.012 - i * 0.004
                pa.db.rectangle(rect_px(p, xx, yy, 0.010, 0.005), fill=(60, 100, 60))
    elif k == 'cb':
        cx, cy = p.px(c.x, c.y)
        R = 0.0075 * ppm
        pa.db.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(215, 215, 212))
        pa.db.ellipse([cx - R * 0.72, cy - R * 0.72, cx + R * 0.72, cy + R * 0.72], fill=(18, 18, 20))
        text(pa, p, c.x, c.y + 0.0135, str(5 * (1 + (int(c.x * 1000) + int(c.y * 1000)) % 4)), 0.003, WHITE, emit=0)
        text(pa, p, c.x, c.y - 0.0135, 'CB', 0.0024, scale(WHITE, 0.8), emit=0)
    elif k == 'tiller':
        disk(pa, p, c.x, c.y, 0.050, (38, 40, 44))
        disk(pa, p, c.x, c.y, 0.020, (24, 25, 27))


def paint_knob(pa, p, c):
    ppm = p.ppm()
    r = c.r or 0.012
    style = c.style or 'pointer'
    cx, cy = p.px(c.x, c.y)
    R = r * ppm
    # shadowed skirt ring on the panel
    pa.db.ellipse([cx - R * 1.30, cy - R * 1.30, cx + R * 1.30, cy + R * 1.30], fill=scale(BG.get(p.bg, BG['gray']), 0.55))
    ring = c.ring
    if ring:
        n = len(ring)
        spread = 60 * (n - 1) if n <= 3 else min(300, 42 * (n - 1))
        rr = r * (c.ring_r or 2.05)
        for i, wd in enumerate(ring):
            a = math.radians(-spread / 2 + i * spread / max(1, n - 1)) if n > 1 else 0
            tx = c.x + math.sin(a) * rr
            ty = c.y + math.cos(a) * rr
            # tick from the knob to the label
            t0 = p.px(c.x + math.sin(a) * r * 1.35, c.y + math.cos(a) * r * 1.35)
            t1 = p.px(c.x + math.sin(a) * r * 1.62, c.y + math.cos(a) * r * 1.62)
            pa.db.line([t0, t1], fill=WHITE, width=max(1, int(0.0006 * ppm)))
            fs = 0.0026 if len(wd) > 3 else 0.0030
            text(pa, p, tx, ty, wd, fs, WHITE, face='cond')
        if c.label:
            text(pa, p, c.x, c.y + rr + 0.0075, c.label, 0.0031, WHITE)
    elif c.label:
        text(pa, p, c.x, c.y + r * 1.35 + 0.0065, c.label, 0.0031, WHITE)


def paint_toggle(pa, p, c):
    ppm = p.ppm()
    cx, cy = p.px(c.x, c.y)
    small = bool(c.small)
    R = (0.0048 if not small else 0.0036) * ppm
    # bushing nut (hex) painted flat; the 3D part adds the lever and the handle
    pts = [(cx + R * 1.25 * math.cos(math.radians(30 + 60 * i)), cy + R * 1.25 * math.sin(math.radians(30 + 60 * i))) for i in range(6)]
    pa.db.polygon(pts, fill=(120, 124, 128))
    pa.db.ellipse([cx - R * 0.8, cy - R * 0.8, cx + R * 0.8, cy + R * 0.8], fill=(70, 72, 76))
    pos = c.pos or ('ON', 'OFF')
    fs = 0.0027 if not small else 0.0024
    dy = 0.0105 if not small else 0.0085
    if c.guard:
        dy += 0.004
        g = rect_px(p, c.x, c.y + 0.004, 0.018, 0.032)
        pa.db.rectangle([g[0], g[3] - 0.004 * ppm, g[2], g[3]], fill=(40, 40, 42))
    if len(pos) == 2:
        text(pa, p, c.x, c.y + dy, pos[0], fs, WHITE, face='cond')
        text(pa, p, c.x, c.y - dy, pos[1], fs, WHITE, face='cond')
    else:
        text(pa, p, c.x, c.y + dy, pos[0], fs, WHITE, face='cond')
        text(pa, p, c.x + (0.0115 if not small else 0.009), c.y, pos[1], fs * 0.95, WHITE, face='cond', anchor='lm')
        text(pa, p, c.x, c.y - dy, pos[2], fs, WHITE, face='cond')
    if c.label:
        n = c.label.count('\n') + 1
        text(pa, p, c.x, c.y + dy + 0.0048 + (n - 1) * 0.0022 + (0.0015 if len(pos) else 0), c.label, 0.0030 if not small else 0.0027, WHITE)


def paint_light(pa, p, c):
    """Annunciator (flush lens), pushbutton light (raised) or master caution / fire warning."""
    ppm = p.ppm()
    colname = c.col or 'amber'
    lit_col, unlit = LIGHT.get(colname, LIGHT['amber'])
    lit = bool(c.lit)
    r = rect_px(p, c.x, c.y, c.w, c.h)
    frame = max(2, int(0.0010 * ppm))
    pa.db.rectangle([r[0] - frame, r[1] - frame, r[2] + frame, r[3] + frame], fill=(22, 23, 25))
    if c.kind == 'pbtn' and colname == 'white' and not lit:
        face = (44, 46, 50)
        pa.db.rectangle(r, fill=face)
        fit_text(pa, p, c.x, c.y + (c.h * 0.10 if c.bar else 0), c.text, c.w, c.h * (0.62 if c.bar else 0.9), WHITE,
                 emit=0.12, face='cond')
        if c.bar:
            b = rect_px(p, c.x, c.y - c.h * 0.32, c.w * 0.55, c.h * 0.12)
            pa.db.rectangle(b, fill=(30, 34, 32))
        return
    if c.kind == 'pbtn' and colname == 'white' and lit:
        pa.db.rectangle(r, fill=(44, 46, 50))
        fit_text(pa, p, c.x, c.y + c.h * 0.10, c.text, c.w, c.h * 0.62, WHITE, emit=0.12, face='cond')
        b = rect_px(p, c.x, c.y - c.h * 0.32, c.w * 0.55, c.h * 0.12)
        g = LIGHT['green'][0]
        pa.db.rectangle(b, fill=g)
        pa.de.rectangle(b, fill=g)
        return
    # coloured lens
    if lit:
        face = scale(lit_col, 0.55)
        pa.db.rectangle(r, fill=face)
        pa.de.rectangle(r, fill=scale(lit_col, 0.35))
        fit_text(pa, p, c.x, c.y, c.text, c.w, c.h * 0.9, scale(lit_col, 1.0), emit=1.0, face='bold' if c.kind == 'mc' else 'cond')
    else:
        face = (40, 39, 38) if colname != 'blue' else (36, 40, 46)
        pa.db.rectangle(r, fill=face)
        if c.recess:
            fit_text(pa, p, c.x, c.y, c.text, c.w * 0.85, c.h * 0.55, scale(unlit, 0.62), emit=0.0, face='cond')
        else:
            fit_text(pa, p, c.x, c.y, c.text, c.w, c.h * 0.9, unlit, emit=0.0, face='bold' if c.kind == 'mc' else 'cond')


def paint_cdu(pa, p, c):
    ppm = p.ppm()
    ox = c.x - FL.CDU_W / 2
    oy = c.y
    r = rect_px(p, c.x, oy + FL.CDU_H / 2, FL.CDU_W, FL.CDU_H)
    pa.db.rounded_rectangle(r, radius=int(0.004 * ppm), fill=(50, 53, 57))
    sx, sy, sw, sh = FL.CDU_SCREEN
    pa.db.rectangle(rect_px(p, ox + sx, oy + sy, sw + 0.006, sh + 0.006), fill=(24, 25, 27))
    pa.db.rectangle(rect_px(p, ox + sx, oy + sy, sw + 0.002, sh + 0.002), fill=(4, 5, 6))
    for (name, kx, ky, kw, kh, lab, style) in FL.cdu_keys():
        rk = rect_px(p, ox + kx, oy + ky, kw, kh)
        if style == 'lsk':
            pa.db.rectangle(rk, fill=(36, 37, 40))
            pa.db.line(p.px(ox + kx - kw * 0.25, oy + ky) + p.px(ox + kx + kw * 0.25, oy + ky), fill=WHITE, width=max(1, int(0.0006 * ppm)))
            continue
        pa.db.rounded_rectangle(rk, radius=max(1, int(0.0012 * ppm)), fill=(34, 35, 38))
        fit_text(pa, p, ox + kx, oy + ky, lab, kw, kh * 0.85, WHITE, emit=0.14, face='cond')
        if style == 'exec':
            bar = rect_px(p, ox + kx, oy + ky + kh * 0.36, kw * 0.6, kh * 0.14)
            pa.db.rectangle(bar, fill=(60, 55, 40))
    # annunciators + brightness
    for i, t in enumerate(('DSPY', 'FAIL', 'MSG', 'OFST')):
        xx = ox + 0.013 if i < 2 else ox + FL.CDU_W - 0.013
        yy = oy + 0.090 - (i % 2) * 0.012
        pa.db.rectangle(rect_px(p, xx, yy, 0.012, 0.007), fill=(30, 28, 25))
        fit_text(pa, p, xx, yy, t, 0.012, 0.006, (140, 120, 80), face='cond')
    text(pa, p, ox + FL.CDU_W / 2, oy + 0.006, 'BRT', 0.0022)


# ------------------------------------------------------------------ throttle quadrant (cover + sides)
def paint_tq(pa, p):
    panel_bg(pa, p)
    ppm = p.ppm()
    W, L = p.w, p.h
    c = W / 2
    # thrust lever slots (y = arc length from the aft end)
    for sx in (-0.034, 0.034):
        pa.db.rounded_rectangle(rect_px(p, c + sx, L * 0.55, 0.012, L * 0.62), radius=int(0.004 * ppm), fill=(8, 8, 9))
    # speed brake (left) and flap (right) slots
    pa.db.rounded_rectangle(rect_px(p, c - 0.102, L * 0.56, 0.010, L * 0.58), radius=int(0.004 * ppm), fill=(8, 8, 9))
    pa.db.rounded_rectangle(rect_px(p, c + 0.102, L * 0.50, 0.010, L * 0.66), radius=int(0.004 * ppm), fill=(8, 8, 9))
    # speed brake scale
    for i, lab in enumerate(('DOWN', 'ARMED', 'FLIGHT\nDETENT', 'UP')):
        yy = L * 0.80 - i * L * 0.16
        text(pa, p, c - 0.076, yy, lab, 0.0034, WHITE, face='cond')
        a_ = p.px(c - 0.096, yy)
        b_ = p.px(c - 0.090, yy)
        pa.db.line([a_, b_], fill=WHITE, width=max(1, int(0.0008 * ppm)))
    text(pa, p, c - 0.105, L * 0.90, 'SPEED BRAKE', 0.0034, WHITE)
    # flap detents 0..40
    labs = ('UP', '1', '2', '5', '10', '15', '25', '30', '40')
    for i, lab in enumerate(labs):
        yy = L * 0.82 - i * L * 0.078
        text(pa, p, c + 0.080, yy, lab, 0.0048 if lab != 'UP' else 0.0038, WHITE, face='futura')
        a_ = p.px(c + 0.092, yy)
        b_ = p.px(c + 0.097, yy)
        pa.db.line([a_, b_], fill=WHITE, width=max(1, int(0.0008 * ppm)))
        if lab in ('1', '15'):
            # green gates (go-around flap detents)
            g = rect_px(p, c + 0.113, yy, 0.006, 0.010)
            pa.db.rectangle(g, fill=(40, 160, 70))
    text(pa, p, c + 0.090, L * 0.90, 'FLAP', 0.0038, WHITE)
    text(pa, p, c + 0.080, L * 0.12, 'FLAP\nDOWN', 0.0032, WHITE)
    # thrust lever labels
    text(pa, p, c, L * 0.88, 'FWD', 0.0038, WHITE)
    text(pa, p, c, L * 0.27, 'IDLE', 0.0040, WHITE)
    text(pa, p, c, L * 0.20, 'REV', 0.0034, WHITE)
    for i, t in enumerate(('1', '2')):
        text(pa, p, c + (i * 2 - 1) * 0.034, L * 0.96, t, 0.0045, WHITE)
    # aft part: start levers + parking brake + stab trim cutout
    text(pa, p, c, L * 0.105, 'START LEVERS', 0.0030, WHITE)
    for sx in (-0.034, 0.034):
        pa.db.rounded_rectangle(rect_px(p, c + sx, L * 0.055, 0.010, 0.045), radius=int(0.003 * ppm), fill=(8, 8, 9))
    text(pa, p, c, L * 0.085, 'IDLE', 0.0030, WHITE)
    text(pa, p, c, L * 0.022, 'CUTOFF', 0.0030, WHITE)
    # parking brake (left aft) + red light
    pa.db.rounded_rectangle(rect_px(p, c - 0.090, L * 0.12, 0.050, 0.070), radius=int(0.003 * ppm), fill=(58, 62, 67))
    text(pa, p, c - 0.090, L * 0.155, 'PARKING\nBRAKE', 0.0030, WHITE)
    text(pa, p, c - 0.090, L * 0.075, 'PULL', 0.0030, WHITE)
    disk(pa, p, c - 0.064, L * 0.105, 0.0055, (120, 20, 16), emit=(200, 30, 20), outline=(20, 20, 20), width=2)
    text(pa, p, c - 0.064, L * 0.085, 'PARK\nBRAKE', 0.0022, WHITE)
    # stab trim cutout switches (right aft)
    pa.db.rectangle(rect_px(p, c + 0.088, L * 0.11, 0.070, 0.072), fill=(58, 62, 67))
    text(pa, p, c + 0.088, L * 0.165, 'STAB TRIM', 0.0034, WHITE)
    text(pa, p, c + 0.070, L * 0.145, 'MAIN ELEC', 0.0022, WHITE)
    text(pa, p, c + 0.106, L * 0.145, 'AUTO PILOT', 0.0022, WHITE)
    text(pa, p, c + 0.088, L * 0.055, 'NORMAL    CUTOUT', 0.0022, WHITE)
    for sx in (-0.018, 0.018):
        disk(pa, p, c + 0.088 + sx, L * 0.105, 0.004, (120, 124, 128))


def paint_tq_side(pa, p):
    panel_bg(pa, p)
    ppm = p.ppm()
    W, H = p.w, p.h
    # stab trim indicator scale (APL NOSE DOWN .. UP) with the green takeoff band, near the trim wheel
    right = p.name.endswith('R')
    if right:
        x0 = W * 0.30
        pa.db.rectangle(rect_px(p, x0, H * 0.62, 0.030, 0.13), fill=(22, 23, 25))
        for i in range(0, 17, 1):
            yy = H * 0.62 + 0.058 - i * 0.116 / 16
            l = 0.010 if i % 2 == 0 else 0.005
            a_ = p.px(x0 - 0.012, yy)
            b_ = p.px(x0 - 0.012 + l, yy)
            pa.db.line([a_, b_], fill=WHITE, width=max(1, int(0.0008 * ppm)))
            if i % 4 == 0:
                text(pa, p, x0 + 0.006, yy, str(i), 0.0035, WHITE, face='cond')
        g = rect_px(p, x0 - 0.009, H * 0.62 + 0.058 - 0.116 * 4 / 16, 0.004, 0.116 * 5 / 16)
        pa.db.rectangle([g[0], g[1], g[2], g[3]], fill=(40, 180, 80))
        text(pa, p, x0, H * 0.62 + 0.075, 'APL NOSE\nDOWN', 0.0030, WHITE)
        text(pa, p, x0, H * 0.62 - 0.075, 'APL NOSE\nUP', 0.0030, WHITE)
        text(pa, p, x0, H * 0.30, 'STAB TRIM', 0.0042, WHITE)
    else:
        text(pa, p, W * 0.70, H * 0.30, 'STAB TRIM', 0.0042, WHITE)
    # arrows around the wheel opening
    text(pa, p, W * 0.5, H * 0.90, 'NOSE DOWN', 0.0035, WHITE)
    text(pa, p, W * 0.5, H * 0.08, 'NOSE UP', 0.0035, WHITE)


# ------------------------------------------------------------------ whole panel
def paint_card(pa, p):
    """Checklist card on the control wheel."""
    x0, y0, x1, y1 = [int(v) for v in p.rect]
    pa.db.rectangle([x0, y0, x1, y1], fill=(236, 236, 230))
    pa.db.rectangle([x0, y0, x1, y0 + int(0.012 * p.ppm())], fill=(30, 30, 34))
    text(pa, p, p.w / 2, p.h - 0.006, 'NORMAL CHECKLIST', 0.0034, (240, 240, 240), emit=0)
    items = ['BEFORE START', 'OXYGEN', 'INSTRUMENTS', 'PARKING BRAKE', 'FUEL', 'BEFORE TAXI', 'FLAPS', 'STAB TRIM',
             'BEFORE TAKEOFF', 'AFTER TAKEOFF', 'DESCENT', 'APPROACH', 'LANDING', 'SHUTDOWN']
    y = p.h - 0.020
    for k, it in enumerate(items):
        bold = it.isupper() and it in ('BEFORE START', 'BEFORE TAXI', 'BEFORE TAKEOFF', 'AFTER TAKEOFF', 'DESCENT', 'APPROACH', 'LANDING', 'SHUTDOWN')
        text(pa, p, 0.006, y, it, 0.0026, (20, 20, 22), anchor='lm', emit=0, face='bold' if bold else 'cond')
        if not bold:
            text(pa, p, p.w - 0.006, y, '. . . . CHECK', 0.0022, (40, 40, 44), anchor='rm', emit=0, face='cond')
        y -= 0.0074


def paint_panel(pa, p):
    if p.name == 'yoke_card':
        return paint_card(pa, p)
    if p.name == 'tq_top':
        return paint_tq(pa, p)
    if p.name.startswith('tq_side'):
        return paint_tq_side(pa, p)
    panel_bg(pa, p)
    for i, pl in enumerate(p.plates):
        paint_plate(pa, p, pl, i)
    for c in p.ctls:
        paint_control(pa, p, c)
    for (x, y, s, size, col, anchor, font) in p.texts:
        text(pa, p, x, y, s, size, WHITE if col == 'white' else col, anchor, face=font)
    for (pts, width, col) in p.lines:
        pa.db.line([p.px(*q) for q in pts], fill=WHITE, width=max(1, int(width * p.ppm())))


# ------------------------------------------------------------------ passenger cabin swatches (unchanged; the cabin samples them)
def paint_cabin_swatches(pa):
    SW = FL.SWATCH

    def noise_img(w, h, cells, seed):
        n = np.random.default_rng(seed).random((cells, cells)).astype(np.float32)
        return np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255

    x0, y0, x1, y1 = SW['cab_fabric']
    w, h = x1 - x0, y1 - y0
    yy, xx = np.mgrid[0:h, 0:w]
    weave = ((xx // 3 + yy // 3) % 2).astype(np.float32)
    base = np.array((40, 44, 58), np.float32)
    col = base[None, None] * (0.9 + 0.08 * weave[..., None] + 0.08 * noise_img(w, h, 16, 1)[..., None])
    stripe = (np.abs(yy - h * 0.7) < 3)
    col[stripe] = (200, 16, 46)
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    x0, y0, x1, y1 = SW['cab_head']
    pa.db.rectangle(SW['cab_head'], fill=(236, 234, 228))
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    pa.db.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=(200, 16, 46))
    pa.db.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], fill=(245, 246, 248))
    x0, y0, x1, y1 = SW['cab_carpet']
    w, h = x1 - x0, y1 - y0
    col = np.array((52, 60, 78), np.float32)[None, None] * (0.8 + 0.35 * noise_img(w, h, 128, 3)[..., None])
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    for key, c in (('cab_wall', (226, 225, 220)), ('cab_bin', (232, 232, 230)), ('cab_ceiling', (238, 238, 236))):
        x0, y0, x1, y1 = SW[key]
        w, h = x1 - x0, y1 - y0
        col = np.array(c, np.float32)[None, None] * (0.97 + 0.04 * noise_img(w, h, 24, 7)[..., None])
        pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    x0, y0, x1, y1 = SW['cab_bin']
    pa.db.rectangle([x0, y0 + int((y1 - y0) * 0.78), x1, y0 + int((y1 - y0) * 0.80)], fill=(160, 160, 160))
    x0, y0, x1, y1 = SW['cab_psu']
    pa.db.rectangle(SW['cab_psu'], fill=(196, 198, 200))
    for i in range(6):
        cx = x0 + 30 + i * ((x1 - x0 - 60) // 5)
        cy = (y0 + y1) // 2
        pa.db.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=(90, 92, 95) if i % 2 else (230, 230, 220))
        if i % 2 == 0:
            pa.de.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(80, 78, 70))
    pa.db.rectangle([x0 + 10, y0 + 6, x0 + 80, y0 + 22], fill=(40, 40, 42))
    pa.db.rectangle(SW['cab_light'], fill=(250, 248, 240))
    pa.de.rectangle(SW['cab_light'], fill=(255, 250, 236))
    x0, y0, x1, y1 = SW['cab_curtain']
    w, h = x1 - x0, y1 - y0
    xx = np.arange(w)[None, :].repeat(h, 0)
    fold = 0.85 + 0.15 * np.cos(xx / 9.0)
    col = np.array((25, 50, 105), np.float32)[None, None] * fold[..., None]
    pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    pa.db.rectangle(SW['cab_reveal'], fill=(218, 218, 214))
    # generic swatches still referenced by the cabin (seat frames: 'grey'; default box sides: 'plastic')
    for key, c, seed in (('plastic', (30, 31, 34), 50), ('grey', (105, 109, 115), 60)):
        x0, y0, x1, y1 = SW[key]
        w, h = x1 - x0, y1 - y0
        n = 0.5 * noise_img(w, h, 8, seed) + 0.5 * noise_img(w, h, 32, seed + 1)
        col = np.array(c, np.float32)[None, None] * (0.95 + 0.1 * n[..., None])
        pa.base.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))


# ------------------------------------------------------------------ source swatches for the baked structure atlas


def paint_swatches():
    im = Image.new('RGB', (1024, 1024), (128, 128, 128))
    d = ImageDraw.Draw(im)

    def fill(key, c, amp, cells, seed):
        x0, y0, x1, y1 = FL.SWATCH_SRC[key]
        w, h = x1 - x0, y1 - y0
        n = np.zeros((h, w), np.float32)
        for i, cc in enumerate(cells):
            n += noise(w, h, (cc, cc), seed + i) / len(cells)
        col = np.array(c, np.float32)[None, None] * (1 - amp + 2 * amp * n[..., None])
        im.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    fill('lining', (188, 192, 194), 0.025, (8, 64), 1)       # flight deck lining: very light blue-grey
    fill('black', (26, 27, 29), 0.08, (16, 128), 2)          # glareshield anti-glare (textured)
    fill('grayp', (93, 102, 111), 0.03, (8, 32), 3)          # Boeing grey structure
    fill('floor', (46, 50, 56), 0.10, (32, 128, 256), 4)     # floor covering
    fill('leather', (64, 67, 71), 0.05, (16, 96), 5)         # seat leather (grey)
    fill('dark', (38, 40, 44), 0.04, (8, 32), 7)             # dark grey trim
    fill('column', (105, 115, 124), 0.03, (8, 32), 8)        # control column paint (blue grey)
    fill('white', (220, 221, 218), 0.02, (8, 32), 9)
    fill('visor', (34, 44, 40), 0.03, (8, 32), 10)           # tinted sun visor
    fill('metal', (150, 154, 158), 0.05, (8, 64), 11)
    fill('frame', (160, 165, 168), 0.03, (8, 32), 12)        # window frame mouldings
    fill('kick', (58, 63, 69), 0.05, (8, 64), 13)            # kick panels / footwell
    # seat mesh fabric: dark woven
    x0, y0, x1, y1 = FL.SWATCH_SRC['mesh']
    w, h = x1 - x0, y1 - y0
    yy, xx = np.mgrid[0:h, 0:w]
    weave = (((xx // 2) + (yy // 2)) % 2).astype(np.float32)
    col = np.array((52, 55, 60), np.float32)[None, None] * (0.85 + 0.18 * weave[..., None] + 0.05 * noise(w, h, (32, 32), 6)[..., None])
    im.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    # sheepskin
    x0, y0, x1, y1 = FL.SWATCH_SRC['sheep']
    w, h = x1 - x0, y1 - y0
    n = 0.5 * noise(w, h, (48, 48), 20) + 0.5 * noise(w, h, (160, 160), 21)
    col = np.array((196, 196, 192), np.float32)[None, None] * (0.8 + 0.3 * n[..., None])
    im.paste(Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), (x0, y0))
    # flight deck door
    x0, y0, x1, y1 = FL.SWATCH_SRC['door']
    d.rectangle(FL.SWATCH_SRC['door'], fill=(176, 180, 182))
    d.rectangle([x0 + 18, y0 + 18, x1 - 18, y1 - 18], outline=(140, 144, 146), width=5)
    cx = (x0 + x1) // 2
    d.ellipse([cx - 10, y0 + 170, cx + 10, y0 + 190], fill=(20, 20, 20))
    d.rectangle([x1 - 80, y0 + 250, x1 - 44, y0 + 290], fill=(90, 92, 94))
    d.rectangle([x0 + 60, y0 + 330, x0 + 200, y0 + 420], fill=(200, 200, 196), outline=(120, 120, 120), width=2)
    d.text((x0 + 130, y0 + 375), 'FLIGHT DECK', font=F(18), fill=(50, 50, 50), anchor='mm')
    im.save(os.path.join(TEX, 'fd_swatch.png'))
    # roughness per swatch (ORM: R = 1, G = roughness, B = metallic)
    rough = {'lining': 0.62, 'black': 0.97, 'grayp': 0.58, 'floor': 0.92, 'leather': 0.52, 'mesh': 0.88, 'sheep': 1.0,
             'dark': 0.62, 'column': 0.5, 'white': 0.5, 'visor': 0.18, 'metal': 0.35, 'door': 0.62, 'frame': 0.6, 'kick': 0.85}
    orm = Image.new('RGB', (1024, 1024), (255, 160, 0))
    do = ImageDraw.Draw(orm)
    for k, r in rough.items():
        do.rectangle(FL.SWATCH_SRC[k], fill=(255, int(r * 255), 0))
    orm.save(os.path.join(TEX, 'fd_swatch_orm.png'))
    return im


# ------------------------------------------------------------------ static display images (Cycles renders only)
def render_screens():
    """Static stand-ins for the live avionics canvases (the game draws the displays itself)."""
    out = {}
    S = 512
    f = ImageFont.truetype(HELV, 22, index=1)
    fs = ImageFont.truetype(HELV, 16, index=1)
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = S * 0.47, S * 0.47
    hz = Image.new('RGB', (int(S * 0.46), int(S * 0.46)), (40, 110, 215))
    hd = ImageDraw.Draw(hz)
    hd.rectangle([0, S * 0.25, S * 0.46, S * 0.46], fill=(150, 90, 40))
    hd.line([0, S * 0.25, S * 0.46, S * 0.25], fill=(255, 255, 255), width=3)
    for k in (-2, -1, 1, 2):
        yy = S * 0.25 - k * S * 0.045
        w = S * (0.05 if k % 2 else 0.09)
        hd.line([S * 0.23 - w, yy, S * 0.23 + w, yy], fill=(255, 255, 255), width=2)
    m = Image.new('L', hz.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, hz.size[0] - 1, hz.size[1] - 1], radius=40, fill=255)
    im.paste(hz, (int(cx - S * 0.23), int(cy - S * 0.23)), m)
    for sx in (-1, 1):
        d.polygon([(cx + sx * 70, cy), (cx + sx * 25, cy), (cx + sx * 25, cy + 12), (cx + sx * 32, cy + 12), (cx + sx * 32, cy + 6),
                   (cx + sx * 70, cy + 6)], fill=(0, 0, 0), outline=(255, 255, 255))
    d.rectangle([cx - 4, cy - 4, cx + 4, cy + 4], outline=(255, 255, 255), width=2)
    d.rectangle([20, 95, 75, 400], fill=(70, 72, 82))
    d.rectangle([14, 234, 80, 266], fill=(0, 0, 0), outline=(255, 255, 255))
    d.text((47, 250), '250', font=f, fill=(255, 255, 255), anchor='mm')
    d.rectangle([395, 95, 455, 400], fill=(70, 72, 82))
    d.rectangle([388, 234, 470, 266], fill=(0, 0, 0), outline=(255, 255, 255))
    d.text((429, 250), '10000', font=fs, fill=(255, 255, 255), anchor='mm')
    d.text((47, 75), '250', font=fs, fill=(255, 0, 255), anchor='mm')
    d.text((425, 75), '10000', font=fs, fill=(255, 0, 255), anchor='mm')
    d.rectangle([90, 12, 390, 42], outline=(90, 90, 90))
    for x_, t in ((140, 'MCP SPD'), (240, 'HDG SEL'), (340, 'ALT HOLD')):
        d.text((x_, 27), t, font=fs, fill=(0, 255, 0), anchor='mm')
    d.chord([cx - 130, S - 105, cx + 130, S + 150], 200, 340, fill=(70, 72, 82))
    d.text((cx, S - 88), '287', font=f, fill=(255, 255, 255), anchor='mm')
    out['pfd'] = im
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    c = (S / 2, S * 0.80)
    for rr in (0.35, 0.7):
        R = S * rr
        d.arc([c[0] - R, c[1] - R, c[0] + R, c[1] + R], 215, 325, fill=(255, 255, 255), width=2)
    for k in range(-5, 6):
        a = math.radians(-90 + k * 10)
        R = S * 0.7
        d.line([c[0] + math.cos(a) * R, c[1] + math.sin(a) * R, c[0] + math.cos(a) * (R - 12), c[1] + math.sin(a) * (R - 12)], fill=(255, 255, 255), width=2)
    pts = [(c[0], c[1]), (c[0] + 30, c[1] - 120), (c[0] + 90, c[1] - 260), (c[0] + 60, c[1] - 360)]
    d.line(pts, fill=(255, 0, 255), width=3)
    for pt, nm in zip(pts[1:], ('SFO', 'OSI', 'PORTE')):
        d.polygon([(pt[0], pt[1] - 7), (pt[0] + 7, pt[1]), (pt[0], pt[1] + 7), (pt[0] - 7, pt[1])], outline=(0, 255, 255))
        d.text((pt[0] + 14, pt[1]), nm, font=fs, fill=(0, 255, 255), anchor='lm')
    d.polygon([(c[0], c[1] - 20), (c[0] - 10, c[1] + 10), (c[0] + 10, c[1] + 10)], outline=(255, 255, 255))
    d.text((S / 2, 22), 'TRK 287 MAG', font=f, fill=(0, 255, 0), anchor='mm')
    d.text((30, 30), 'GS 250', font=fs, fill=(255, 255, 255), anchor='lm')
    out['nd'] = im
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, x in enumerate((150, 362)):
        for j, (y, val) in enumerate(((120, '85.2'), (290, '612'))):
            R = 62
            d.arc([x - R, y - R, x + R, y + R], 180, 390, fill=(255, 255, 255), width=4)
            d.pieslice([x - R + 6, y - R + 6, x + R - 6, y + R - 6], 180, 330, fill=(90, 90, 90))
            d.rectangle([x - 5, y - 44, x + 70, y - 14], outline=(255, 255, 255))
            d.text((x + 32, y - 29), val, font=fs, fill=(255, 255, 255), anchor='mm')
    d.text((S / 2, 120), 'N1', font=f, fill=(0, 200, 255), anchor='mm')
    d.text((S / 2, 290), 'EGT', font=f, fill=(0, 200, 255), anchor='mm')
    d.text((S / 2, 440), 'FUEL  5.4  12.1  5.4', font=fs, fill=(255, 255, 255), anchor='mm')
    out['eicas'] = im
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
    # ISFD (standby): attitude + speed/alt tapes
    im = Image.new('RGB', (S, S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, S, S * 0.52], fill=(30, 110, 220))
    d.rectangle([0, S * 0.52, S, S], fill=(140, 85, 40))
    d.line([0, S * 0.52, S, S * 0.52], fill=(255, 255, 255), width=4)
    d.rectangle([0, 60, 110, S - 60], fill=(40, 40, 50))
    d.rectangle([S - 130, 60, S, S - 60], fill=(40, 40, 50))
    d.text((55, S / 2), '250', font=f, fill=(255, 255, 255), anchor='mm')
    d.text((S - 65, S / 2), '10000', font=fs, fill=(255, 255, 255), anchor='mm')
    d.polygon([(S / 2 - 60, S / 2), (S / 2 - 15, S / 2), (S / 2 - 15, S / 2 + 10)], fill=(255, 255, 0))
    d.polygon([(S / 2 + 60, S / 2), (S / 2 + 15, S / 2), (S / 2 + 15, S / 2 + 10)], fill=(255, 255, 0))
    d.text((S / 2, 25), '1013', font=fs, fill=(0, 255, 255), anchor='mm')
    out['isfd'] = im
    for k, im in out.items():
        # screens are authored upside-down in UV (v=0 at the top, matching the CanvasTexture flipY)
        im.transpose(Image.FLIP_TOP_BOTTOM).save(os.path.join(TEX, f'fd_screen_{k}.png'))
    return out


def main():
    pa = Painter()
    L = FL.layout()
    for name, p in L.items():
        paint_panel(pa, p)
    paint_cabin_swatches(pa)
    for k, r in FL.LITE_SW.items():
        pa.db.rectangle(r, fill=FL.LITE_COL[k])
    pa.base.save(os.path.join(TEX, 'fd_base_raw.png'))
    pa.base.save(os.path.join(TEX, 'fd_base.jpg'), quality=92)      # unbaked default (bake_fd.py overwrites it)
    em = pa.emit.filter(ImageFilter.GaussianBlur(1.2)).resize((A // 2, A // 2), Image.LANCZOS)
    em.save(os.path.join(TEX, 'fd_emit.jpg'), quality=88)
    paint_swatches()
    if '--screens' in sys.argv:          # static fallbacks; capture_displays.py grabs the real avionics pages
        render_screens()
    print('wrote fd atlas')


if __name__ == '__main__':
    main()
