"""Paint the A320 flight-deck panel atlases (colour + emissive) from cockpit_layout.py.

.venv/bin/python blender/aircraft/a320neo/cockpit_tex.py
  -> build/tex/ck_atlasA.png, ck_atlasB.png (colour, 4096^2), ck_emitA.png, ck_emitB.png (2048^2), ck_fabric.jpg, ...
     (GOKYUZU_TEX_OUT=<dir>: elsewhere). The registration plate follows the livery (cockpit_layout.REG_PLATE).

Panels: Airbus blue-grey plates with Dzus fasteners and dark seams, white Futura-like legends, section titles between
white rules, Korry pushbuttons (black glass caps with dim or lit legends / green 'bars'), knob scales, toggle position
labels, 7-segment LCD windows, synoptic flow lines, MCDU/DCDU pages, the digital clock and the brake triple indicator.
Contact shadows around every raised part (caps, knobs, bezels, keys) are painted here (the large-scale lighting of the
flight deck is baked later in Blender: cockpit_bake.py).
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

OUT = os.environ.get('GOKYUZU_TEX_OUT') or os.path.join(HERE, 'build', 'tex')
os.makedirs(OUT, exist_ok=True)
F_LEG = ('/System/Library/Fonts/Avenir Next Condensed.ttc', 2)      # Demi Bold (Airbus legends are Futura-like)
F_SMALL = ('/System/Library/Fonts/Avenir Next Condensed.ttc', 5)    # Medium
F_DIN = ('/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf', 0)
F_MONO = ('/System/Library/Fonts/Menlo.ttc', 1)
SS = 2
_fonts = {}


def font(spec, px):
    px = max(5, int(round(px)))
    key = (spec, px)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(spec[0], px, index=spec[1])
    return _fonts[key]


def C(name, k=1.0):
    c = CL.COL.get(name, name) if isinstance(name, str) else name
    return tuple(int(min(255, v * k)) for v in c)


def dim(col, k=0.26):
    return tuple(int(v * k + 20 * (1 - k) * 0.35) for v in col)


class Painter:
    def __init__(self, w_m, h_m, appm, bg):
        self.PX = appm * SS
        self.W, self.H = int(math.ceil(w_m * self.PX)), int(math.ceil(h_m * self.PX))
        self.c = Image.new('RGB', (self.W, self.H), bg)
        self.e = Image.new('RGB', (self.W, self.H), (0, 0, 0))
        self.raised = Image.new('L', (self.W, self.H), 0)        # footprints of raised parts (contact shadows)
        self.d = ImageDraw.Draw(self.c)
        self.de = ImageDraw.Draw(self.e)
        self.dr = ImageDraw.Draw(self.raised)

    def P(self, x, y):
        return x * self.PX, y * self.PX

    def box(self, x, y, w, h):
        return [x * self.PX, y * self.PX, (x + w) * self.PX, (y + h) * self.PX]

    def L(self, m):
        return max(1, int(round(m * self.PX)))

    def text(self, x, y, s, size, col, anchor='mm', emit=0.0, spec=F_LEG, fit=None):
        if not s:
            return
        f = font(spec, size * self.PX * 1.32)
        if fit is not None:
            tw = f.getlength(s) / self.PX
            if tw > fit:
                f = font(spec, size * self.PX * 1.32 * fit / tw)
        lines = s.split('\n')
        if len(lines) > 1:
            lh = size * 1.12
            for i, ln in enumerate(lines):
                self.text(x, y + (i - (len(lines) - 1) / 2) * lh, ln, size, col, anchor, emit, spec, fit)
            return
        self.d.text(self.P(x, y), s, font=f, fill=col, anchor=anchor)
        if emit > 0:
            self.de.text(self.P(x, y), s, font=f, fill=tuple(int(v * emit) for v in col), anchor=anchor)

    def raise_rect(self, x, y, w, h, v=255):
        self.dr.rectangle(self.box(x, y, w, h), fill=v)

    def raise_circle(self, x, y, r, v=255):
        self.dr.ellipse(self.box(x - r, y - r, 2 * r, 2 * r), fill=v)


# ------------------------------------------------------------------------------------------------ 7-segment digits
SEG = {'0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc',
       '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '', 'L': 'def', 'R': 'eg'}


def seg7(p, x, y, h, s, col, emit=1.0):
    """7-segment text, left edge x, vertical centre y, digit height h (meters)."""
    w = h * 0.54
    t = h * 0.14
    g = t * 0.12
    sk = h * 0.08                          # italic skew (top leans right)
    X = x
    ecol = tuple(int(v * emit) for v in col)

    def hexa(xa, ya, xb, yb):
        if abs(yb - ya) < 1e-9:           # horizontal
            return [(xa + g, ya), (xa + g + t / 2, ya - t / 2), (xb - g - t / 2, ya - t / 2), (xb - g, ya),
                    (xb - g - t / 2, ya + t / 2), (xa + g + t / 2, ya + t / 2)]
        return [(xa, ya + g), (xa + t / 2, ya + g + t / 2), (xa + t / 2, yb - g - t / 2), (xa, yb - g),
                (xa - t / 2, yb - g - t / 2), (xa - t / 2, ya + g + t / 2)]

    for ch in s:
        if ch in '.:*':
            r = t * 0.55
            if ch == ':':
                for dy in (-h * 0.2, h * 0.2):
                    box = p.box(X + t * 0.2 - r, y + dy - r, 2 * r, 2 * r)
                    p.d.ellipse(box, fill=col)
                    p.de.ellipse(box, fill=ecol)
                X += t * 1.6
            else:
                cy = y + h / 2 - r if ch == '.' else y
                box = p.box(X - w * 0.08 - r, cy - r, 2 * r, 2 * r)
                p.d.ellipse(box, fill=col)
                p.de.ellipse(box, fill=ecol)
                if ch == '*':
                    X += t * 2.2
            continue
        segs = SEG.get(ch, '')
        x0, x1 = X + t / 2, X + w - t / 2
        y0, ym, y1 = y - h / 2 + t / 2, y, y + h / 2 - t / 2
        S = {'a': hexa(x0, y0, x1, y0), 'g': hexa(x0, ym, x1, ym), 'd': hexa(x0, y1, x1, y1),
             'f': hexa(x0, y0, x0, ym), 'b': hexa(x1, y0, x1, ym), 'e': hexa(x0, ym, x0, y1), 'c': hexa(x1, ym, x1, y1)}
        for sg in 'abcdefg':
            pts = [p.P(px + sk * (ym - py) / h, py) for px, py in S[sg]]
            if sg in segs:
                p.d.polygon(pts, fill=col)
                p.de.polygon(pts, fill=ecol)
            else:
                p.d.polygon(pts, fill=(30, 24, 18))
        X += w * 1.22


def is_seg(s):
    return all(ch in '0123456789-. :*' for ch in s)


# ------------------------------------------------------------------------------------------------ item painters
def paint_plate(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    lw = p.L(0.0016)
    p.d.rectangle(p.box(x, y, w, h), outline=(30, 34, 40), width=lw)
    p.d.line([p.P(x + 0.0012, y + 0.0012), p.P(x + w - 0.0012, y + 0.0012)], fill=(128, 140, 154), width=max(1, lw // 2))
    if it.get('screws', True) and w > 0.03 and h > 0.02:
        for sx, sy in ((x + 0.0045, y + 0.0045), (x + w - 0.0045, y + 0.0045), (x + 0.0045, y + h - 0.0045),
                       (x + w - 0.0045, y + h - 0.0045)):
            r = 0.0021
            p.d.ellipse(p.box(sx - r, sy - r, 2 * r, 2 * r), fill=(150, 158, 168), outline=(70, 76, 84), width=max(1, lw // 2))
            p.d.line([p.P(sx - r * 0.7, sy), p.P(sx + r * 0.7, sy)], fill=(60, 64, 70), width=max(1, lw // 2))


def paint_title(p, it):
    x, y, w, s, size = it['x'], it['y'], it['w'], it['text'], it['size']
    f = font(F_LEG, size * p.PX * 1.32)
    tw = f.getlength(s) / p.PX
    lw = p.L(0.0007)
    col = CL.WHITE
    p.d.line([p.P(x, y), p.P(x + (w - tw) / 2 - 0.003, y)], fill=col, width=lw)
    p.d.line([p.P(x + (w + tw) / 2 + 0.003, y), p.P(x + w, y)], fill=col, width=lw)
    p.d.line([p.P(x, y), p.P(x, y + 0.006)], fill=col, width=lw)
    p.d.line([p.P(x + w, y), p.P(x + w, y + 0.006)], fill=col, width=lw)
    p.text(x + w / 2, y, s, size, col, emit=0.06)


def cap_legend(p, x, y, w, h, leg, where, bars=False):
    if not leg:
        return
    s, cname, lit = leg
    col = C(cname)
    if bars:
        # FCU / EFIS / RMP style: white legend printed on the cap, green bar lit above it
        bc = C('green') if lit else (28, 40, 32)
        p.d.rectangle(p.box(x + w * 0.22, y + h * 0.14, w * 0.56, h * 0.13), fill=bc)
        if lit:
            p.de.rectangle(p.box(x + w * 0.22, y + h * 0.14, w * 0.56, h * 0.13), fill=bc)
        p.text(x + w / 2, y + h * 0.63, s, min(h * 0.36, 0.0036), (214, 216, 218), emit=0.08, fit=w * 0.86)
        return
    cy = {'up': y + h * 0.29, 'lo': y + h * 0.71, 'mid': y + h * 0.5}[where]
    size = min(h * (0.24 if where != 'mid' else 0.30), 0.0040)
    if lit:
        # lit legend: bright, framed (Airbus 'ON' / 'OFF' legends are outlined by a lit bar frame)
        p.text(x + w / 2, cy, s, size, col, emit=1.0, fit=w * 0.82)
    else:
        p.text(x + w / 2, cy, s, size, dim(col, 0.30), fit=w * 0.82)


def paint_pb(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    if it.get('label'):
        p.text(x + w / 2, y - 0.0052 - (0.0022 if '\n' in it['label'] else 0), it['label'], it['lsize'], CL.WHITE, emit=0.06,
               fit=max(w * 2.0, 0.030))
    g = it.get('guard')
    if g == 'fire':
        p.d.rectangle(p.box(x - 0.003, y - 0.003, w + 0.006, h + 0.006), fill=(30, 12, 12))
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.0012), fill=CAP, outline=(10, 11, 12), width=p.L(0.0006))
    # glass sheen at the top edge
    p.d.line([p.P(x + 0.001, y + 0.0012), p.P(x + w - 0.001, y + 0.0012)], fill=(58, 62, 68), width=p.L(0.0005))
    up, lo, bars = it.get('up'), it.get('lo'), it.get('bars')
    if g == 'fire':
        cap_legend(p, x, y, w, h, up, 'up')
        cap_legend(p, x, y, w, h, lo, 'lo')
        p.d.rectangle(p.box(x + 0.002, y + 0.002, w - 0.004, h - 0.004), outline=(120, 20, 18), width=p.L(0.0008))
    elif up and lo:
        p.d.line([p.P(x + 0.002, y + h / 2), p.P(x + w - 0.002, y + h / 2)], fill=(14, 15, 16), width=p.L(0.0005))
        cap_legend(p, x, y, w, h, up, 'up')
        cap_legend(p, x, y, w, h, lo, 'lo')
    elif lo:
        cap_legend(p, x, y, w, h, lo, 'lo' if not bars else 'mid', bars)
    elif up:
        cap_legend(p, x, y, w, h, up, 'up')
    p.raise_rect(x, y, w, h)


CAP = (24, 26, 29)


def paint_key(p, it):
    x, y, w, h, s, st = it['x'], it['y'], it['w'], it['h'], it['text'], it['style']
    fill = {'lsk': (40, 44, 50), 'fn': (48, 52, 58), 'alpha': (56, 60, 66), 'num': (56, 60, 66), 'key': (48, 52, 58)}[st]
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.0008), fill=fill, outline=(16, 17, 19), width=p.L(0.0004))
    p.d.line([p.P(x + 0.0008, y + 0.0007), p.P(x + w - 0.0008, y + 0.0007)], fill=(90, 96, 104), width=p.L(0.0004))
    if s == '-':
        p.d.line([p.P(x + w * 0.3, y + h / 2), p.P(x + w * 0.7, y + h / 2)], fill=CL.WHITE, width=p.L(0.0006))
    else:
        n = s.count('\n') + 1
        p.text(x + w / 2, y + h / 2, s, min(h * (0.36 if n == 1 else 0.26), 0.0034), (228, 230, 232), emit=0.05, fit=w * 0.9)
    p.raise_rect(x, y, w, h)


def paint_knob(p, it):
    x, y, r, style = it['x'], it['y'], it['r'], it['style']
    pos = it.get('pos') or []
    arc = it.get('arc', 2.2)
    lw = p.L(0.0006)
    if pos:
        n = len(pos)
        for i, lab in enumerate(pos):
            a = -arc / 2 + (arc * i / (n - 1) if n > 1 else 0)
            x0, y0 = x + math.sin(a) * r * 1.30, y - math.cos(a) * r * 1.30
            x1, y1 = x + math.sin(a) * r * 1.62, y - math.cos(a) * r * 1.62
            p.d.line([p.P(x0, y0), p.P(x1, y1)], fill=CL.WHITE, width=lw)
            tx, ty = x + math.sin(a) * (r * 1.62 + 0.0055), y - math.cos(a) * (r * 1.62 + 0.0040)
            if lab:
                p.text(tx, ty, lab.replace('\n', ' '), 0.0030 if len(lab) > 4 else 0.0034, CL.WHITE, emit=0.05)
    elif style in ('round', 'dual', 'big'):
        # continuous scale arc
        box = p.box(x - r * 1.38, y - r * 1.38, 2.76 * r, 2.76 * r)
        p.d.arc(box, 130, 410, fill=(200, 204, 208), width=lw)
    p.d.ellipse(p.box(x - r * 1.16, y - r * 1.16, 2.32 * r, 2.32 * r), fill=(40, 44, 50))
    if it.get('label'):
        lab = it['label']
        dy = r * 1.62 + (0.0085 if pos else 0.0060) + (0.002 if '\n' in lab else 0)
        p.text(x, y + dy if style != 'big' else y - dy, lab, it['lsize'], CL.WHITE, emit=0.06, fit=max(0.05, r * 7))
    p.raise_circle(x, y, r * 1.12)


def paint_tog(p, it):
    x, y = it['x'], it['y']
    pos = it['pos']
    if it.get('label'):
        lab = it['label']
        p.text(x, y - 0.0125 - (0.0022 if '\n' in lab else 0), lab, it['lsize'], CL.WHITE, emit=0.06, fit=0.034)
    p.d.ellipse(p.box(x - 0.0058, y - 0.0058, 0.0116, 0.0116), fill=(62, 66, 72), outline=(30, 32, 36), width=p.L(0.0005))
    n = len(pos)
    for i, lab in enumerate(pos):
        if not lab:
            continue
        yy = y + (i - (n - 1) / 2) * 0.0085
        p.text(x + 0.0082, yy, lab, 0.0029, CL.WHITE, anchor='lm', emit=0.05)
    p.raise_circle(x, y, 0.0058)


def paint_lcd(p, it):
    x, y, w, h, s, cname = it['x'], it['y'], it['w'], it['h'], it['text'], it['colour']
    p.d.rectangle(p.box(x, y, w, h), fill=(16, 12, 9), outline=(8, 8, 8), width=p.L(0.0006))
    col = C(cname)
    if is_seg(s):
        hh = h * 0.66
        ww = sum(hh * (0.0 if ch == '.' else 0.22 if ch == ':' else 0.31 if ch == '*' else 0.54 * 1.22) for ch in s) - hh * 0.54 * 0.22
        seg7(p, x + (w - ww) / 2 + hh * 0.05, y + h / 2, hh, s, col)
    else:
        p.text(x + w / 2, y + h / 2, s, h * 0.55, col, emit=1.0, spec=F_DIN, fit=w * 0.9)


def paint_bezel(p, it):
    x, y, w, h, kind = it['x'], it['y'], it['w'], it['h'], it['kind']
    rad = p.L(0.006 if kind == 'du' else 0.004)
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=rad, fill=(38, 41, 46), outline=(20, 22, 25), width=p.L(0.0008))
    p.d.rounded_rectangle(p.box(x + 0.0035, y + 0.0035, w - 0.007, h - 0.007), radius=rad, fill=(30, 33, 37))
    if kind == 'isis':
        for i, lab in enumerate(('BUGS', 'LS')):
            p.text(x + w * (0.30 + 0.40 * i), y + 0.0035, lab, 0.0024, CL.WHITE)
        p.text(x + 0.012, y + h - 0.0035, 'ATT RST', 0.0022, CL.WHITE, anchor='lm')
        p.text(x + w - 0.012, y + h - 0.0035, 'BARO', 0.0022, CL.WHITE, anchor='rm')
    p.raise_rect(x, y, w, h)


def paint_screen(p, it):
    p.d.rectangle(p.box(it['x'], it['y'], it['w'], it['h']), fill=(4, 5, 6))


def paint_ann(p, it):
    x, y, w, h, s, cname, lit = it['x'], it['y'], it['w'], it['h'], it['text'], it['colour'], it['lit']
    p.d.rectangle(p.box(x, y, w, h), fill=(16, 17, 19), outline=(8, 8, 9), width=p.L(0.0005))
    col = C(cname)
    if s == 'v':
        # green 'down and locked' triangle
        cx, cy = x + w / 2, y + h / 2
        pts = [p.P(cx - w * 0.22, cy - h * 0.28), p.P(cx + w * 0.22, cy - h * 0.28), p.P(cx, cy + h * 0.30)]
        c = col if lit else dim(col)
        p.d.polygon(pts, fill=c)
        if lit:
            p.de.polygon(pts, fill=c)
        return
    p.text(x + w / 2, y + h / 2, s, min(h * 0.46, 0.0036), col if lit else dim(col), emit=1.0 if lit else 0, fit=w * 0.86)


def paint_sq(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.0012), fill=CAP, outline=(10, 10, 11), width=p.L(0.0006))
    if it.get('split'):
        p.d.line([p.P(x + 0.002, y + h / 2), p.P(x + w - 0.002, y + h / 2)], fill=(12, 12, 13), width=p.L(0.0005))
        p.text(x + w / 2, y + h * 0.28, it['texts'][0], 0.0026, dim(C('red')))
        pts = [p.P(x + w * 0.35, y + h * 0.72), p.P(x + w * 0.65, y + h * 0.62), p.P(x + w * 0.65, y + h * 0.82)]
        p.d.polygon(pts, fill=dim(C('green')))
    else:
        col = C(it['colour'])
        lines = [t for t in it['text'] if t]
        for i, t in enumerate(lines):
            cy = y + h * (0.5 + (i - (len(lines) - 1) / 2) * 0.30)
            p.text(x + w / 2, cy, t, min(h * 0.22, 0.0036), col if it['lit'] else dim(col, 0.34), emit=1.0 if it['lit'] else 0,
                   fit=w * 0.84)
    p.raise_rect(x, y, w, h)


def paint_placard(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rectangle(p.box(x, y, w, h), fill=it['bg'])
    lines = it['lines']
    if len(lines) == 2 and lines[0][1] > 0.01:
        # registration plate: large registration left, SELCAL right
        (t0, s0, _), (t1, s1, _) = lines
        p.text(x + 0.004, y + h * 0.55, t0, s0 * 0.78, it['fg'], anchor='lm', spec=F_DIN, emit=0.05)
        p.text(x + w - 0.004, y + h * 0.22, 'SELCAL CODE', 0.0028, it['fg'], anchor='rm')
        p.text(x + w - 0.004, y + h * 0.62, t1.split()[-1], 0.0072, it['fg'], anchor='rm', spec=F_DIN)
        p.d.line([p.P(x + w * 0.60, y + 0.003), p.P(x + w * 0.60, y + h - 0.003)], fill=it['fg'], width=p.L(0.0006))
        return
    lh = h / (len(lines) + 0.6)
    for i, (t, s, al) in enumerate(lines):
        p.text(x + 0.003, y + lh * (i + 0.8), t, s, it['fg'], anchor='lm', spec=F_SMALL, emit=0.04)


def paint_grille(p, it):
    x, y, r = it['x'], it['y'], it['r']
    p.d.ellipse(p.box(x - r, y - r, 2 * r, 2 * r), fill=(44, 48, 54), outline=(28, 30, 34), width=p.L(0.001))
    st = 0.0036
    for iy in np.arange(-r, r, st):
        for ix in np.arange(-r, r, st):
            xx, yy = ix + (st / 2 if int(round(iy / st)) % 2 else 0), iy
            if xx * xx + yy * yy < (r - 0.003) ** 2:
                rr = 0.0011
                p.d.ellipse(p.box(x + xx - rr, y + yy - rr, 2 * rr, 2 * rr), fill=(14, 15, 17))


def paint_clock(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.006), fill=(34, 37, 42), outline=(18, 19, 22), width=p.L(0.001))
    p.d.rounded_rectangle(p.box(x + w * 0.22, y + h * 0.10, w * 0.56, h * 0.80), radius=p.L(0.003), fill=(14, 15, 17))
    p.text(x + w / 2, y + h * 0.16, 'CHR', 0.0030, CL.WHITE)
    p.d.rectangle(p.box(x + w * 0.28, y + h * 0.20, w * 0.44, h * 0.14), fill=(18, 16, 12))
    p.text(x + w / 2, y + h * 0.42, 'UTC', 0.0030, CL.WHITE)
    p.d.rectangle(p.box(x + w * 0.26, y + h * 0.47, w * 0.48, h * 0.17), fill=(18, 16, 12))
    seg7(p, x + w * 0.285, y + h * 0.555, h * 0.11, '13:02', (230, 232, 236), emit=0.8)
    p.text(x + w / 2, y + h * 0.72, 'ET', 0.0030, CL.WHITE)
    p.d.rectangle(p.box(x + w * 0.32, y + h * 0.75, w * 0.36, h * 0.11), fill=(18, 16, 12))
    seg7(p, x + w * 0.35, y + h * 0.805, h * 0.075, '00:30', (230, 232, 236), emit=0.8)
    for i, lab in enumerate(('CHR', 'RST', 'DATE')):
        cx, cy = (x + w * 0.11, y + h * (0.25 + 0.30 * i)) if i < 2 else (x + w * 0.11, y + h * 0.82)
        p.d.ellipse(p.box(cx - 0.0045, cy - 0.0045, 0.009, 0.009), fill=(58, 62, 68), outline=(18, 19, 21))
        p.text(cx, cy - 0.0075, lab, 0.0022, CL.WHITE)
        p.raise_circle(cx, cy, 0.0045, 120)
    p.text(x + w * 0.89, y + h * 0.25, 'GPS', 0.0022, CL.WHITE)
    p.text(x + w * 0.89, y + h * 0.55, 'RUN', 0.0022, CL.WHITE)
    p.text(x + w * 0.89, y + h * 0.70, 'STP', 0.0022, CL.WHITE)
    p.raise_rect(x, y, w, h, 160)


def paint_gauge(p, it):
    x, y, r = it['x'], it['y'], it['r']
    p.d.ellipse(p.box(x - r, y - r, 2 * r, 2 * r), fill=(30, 32, 36), outline=(70, 74, 80), width=p.L(0.0015))
    p.d.ellipse(p.box(x - r * 0.86, y - r * 0.86, 1.72 * r, 1.72 * r), fill=(8, 9, 10))
    lw = p.L(0.0007)
    p.d.arc(p.box(x - r * 0.62, y - r * 0.72, 1.24 * r, 1.24 * r), 200, 340, fill=CL.WHITE, width=lw)
    p.d.arc(p.box(x - r * 0.70, y - r * 0.40, 0.8 * r, 1.1 * r), 110, 250, fill=CL.WHITE, width=lw)
    p.d.arc(p.box(x - r * 0.10, y - r * 0.40, 0.8 * r, 1.1 * r), 290, 430, fill=CL.WHITE, width=lw)
    p.text(x, y - r * 0.55, 'ACCU PRESS', 0.0020, CL.WHITE)
    p.text(x, y + r * 0.62, 'BRAKES', 0.0022, CL.WHITE)
    for a, ll in ((-0.3, 0.55), (0.9, 0.45), (-0.9, 0.45)):
        p.d.line([p.P(x, y), p.P(x + math.sin(a) * r * ll, y - math.cos(a) * r * ll)], fill=(90, 230, 110), width=p.L(0.0011))
    p.d.ellipse(p.box(x - 0.002, y - 0.002, 0.004, 0.004), fill=(200, 200, 200))
    p.raise_circle(x, y, r, 140)


def paint_slot(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(min(w, h) * 0.45), fill=(10, 11, 12), outline=(40, 44, 50),
                          width=p.L(0.0008))


def paint_arrow(p, it):
    x, y0, y1 = it['x'], it['y0'], it['y1']
    lw = p.L(0.0009)
    p.d.line([p.P(x, y0 + 0.004), p.P(x, y1 - 0.004)], fill=CL.WHITE, width=lw)
    for yy, dy in ((y0, 1), (y1, -1)):
        p.d.polygon([p.P(x, yy), p.P(x - 0.003, yy + dy * 0.006), p.P(x + 0.003, yy + dy * 0.006)], fill=CL.WHITE)


def paint_mcdu(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.004), fill=(70, 80, 94), outline=(26, 28, 32), width=p.L(0.0008))
    sx, sy, sw, sh = x + w * 0.19, y + h * 0.045, w * 0.62, h * 0.33
    p.d.rectangle(p.box(sx - 0.003, sy - 0.003, sw + 0.006, sh + 0.006), fill=(22, 24, 27))
    p.d.rectangle(p.box(sx, sy, sw, sh), fill=(3, 5, 6))
    cols = {'w': (230, 232, 236), 'g': (70, 240, 110), 'c': (70, 215, 255)}
    lh = sh / (len(CL.MCDU_PAGE) + 1.0)
    for i, (line, c) in enumerate(CL.MCDU_PAGE):
        p.text(sx + 0.002, sy + lh * (i + 0.95), line, lh * 0.62, cols[c], anchor='lm', emit=1.0, spec=F_MONO, fit=sw * 0.97)
    p.d.rectangle(p.box(sx, sy + sh - lh * 0.9, sw, lh * 0.8), fill=(3, 5, 6))
    p.raise_rect(x, y, w, h, 90)


def paint_dcdu(p, it):
    x, y, w, h = it['x'], it['y'], it['w'], it['h']
    p.d.rounded_rectangle(p.box(x, y, w, h), radius=p.L(0.004), fill=(64, 72, 84), outline=(24, 26, 30), width=p.L(0.0008))
    sx, sy, sw, sh = x + w * 0.20, y + h * 0.10, w * 0.60, h * 0.62
    p.d.rectangle(p.box(sx - 0.002, sy - 0.002, sw + 0.004, sh + 0.004), fill=(24, 26, 29))
    p.d.rectangle(p.box(sx, sy, sw, sh), fill=(4, 6, 8))
    p.d.line([p.P(sx + 0.004, sy + sh * 0.72), p.P(sx + sw - 0.004, sy + sh * 0.72)], fill=(230, 232, 236), width=p.L(0.0005))
    p.text(sx + sw - 0.003, sy + sh * 0.86, 'RECALL', 0.0030, (70, 215, 255), anchor='rm', emit=0.9)
    for i, lab in enumerate(('BRT', 'MSG-', 'MSG+', 'PGE-')):
        cy = y + h * (0.16 + 0.17 * i)
        p.key(x + 0.004, cy - 0.004, w * 0.12, 0.009, lab)
    for i, lab in enumerate(('PRINT', 'PGE+', '', '')):
        cy = y + h * (0.16 + 0.17 * i)
        p.key(x + w - 0.004 - w * 0.12, cy - 0.004, w * 0.12, 0.009, lab)
    for i in range(4):
        p.key(x + w * (0.22 + 0.15 * i), y + h * 0.80, w * 0.12, h * 0.10, '')
    p.raise_rect(x, y, w, h, 110)


def paint_quadrant_hint(p, it):
    # thrust quadrant: the drum is geometry (textured from the 'quadrant' region); the panel shows its dark well
    x, y0, y1 = it['x'], it['y0'], it['y1']
    p.d.rounded_rectangle(p.box(x - 0.066, y0, 0.132, y1 - y0), radius=p.L(0.01), fill=(30, 33, 37))


def paint_master(p, it):
    x, y, n = it['x'], it['y'], it['n']
    p.d.rounded_rectangle(p.box(x - 0.010, y - 0.020, 0.020, 0.040), radius=p.L(0.004), fill=(34, 37, 41))
    p.text(x, y - 0.026, f'ENG {n}', 0.0042, CL.WHITE, emit=0.06)
    p.text(x - 0.018, y + 0.006, 'MASTER', 0.0024, CL.WHITE)
    p.raise_circle(x, y, 0.007)


def paint_parkbrk(p, it):
    x, y = it['x'], it['y']
    p.d.ellipse(p.box(x - 0.016, y - 0.016, 0.032, 0.032), fill=(40, 44, 50), outline=(24, 26, 30), width=p.L(0.001))
    lw = p.L(0.0009)
    p.d.arc(p.box(x - 0.024, y - 0.024, 0.048, 0.048), 200, 340, fill=CL.WHITE, width=lw)
    p.raise_circle(x, y, 0.016)


def paint_rect(p, it):
    p.d.rectangle(p.box(it['x'], it['y'], it['w'], it['h']), fill=it['colour'])


def paint_text(p, it):
    p.text(it['x'], it['y'], it['text'], it['size'], C(it['colour']) if isinstance(it['colour'], str) else it['colour'],
           anchor=it['anchor'], emit=0.06)


def paint_line(p, it):
    pts = [p.P(x, y) for x, y in it['pts']]
    p.d.line(pts, fill=C(it['colour']), width=p.L(it['width']), joint='curve')


PAINTERS = dict(plate=paint_plate, title=paint_title, pb=paint_pb, key=paint_key, knob=paint_knob, tog=paint_tog,
                lcd=paint_lcd, bezel=paint_bezel, screen=paint_screen, ann=paint_ann, sq=paint_sq, placard=paint_placard,
                grille=paint_grille, clock=paint_clock, gauge=paint_gauge, slot=paint_slot, arrow=paint_arrow,
                mcdu=paint_mcdu, dcdu=paint_dcdu, quadrant=paint_quadrant_hint, master=paint_master,
                parkbrk=paint_parkbrk, rect=paint_rect, text=paint_text, line=paint_line)
ORDER = {'rect': 0, 'plate': 1, 'quadrant': 1, 'line': 2}


# p.key used by the DCDU painter (keys painted flat)
def _pkey(self, x, y, w, h, s):
    paint_key(self, dict(x=x, y=y, w=w, h=h, text=s, style='fn'))


Painter.key = _pkey


def flow_lines(pn):
    """Synoptic flow lines between the pushbuttons of the HYD / FUEL / ELEC / AIR COND overhead panels."""
    if pn['name'] != 'overhead':
        return []
    titles = [it for it in pn['items'] if it['k'] == 'title' and it['text'] in ('HYD', 'FUEL', 'ELEC', 'AIR COND')]
    plates = [it for it in pn['items'] if it['k'] == 'plate']
    out = []
    for t in titles:
        pl = [q for q in plates if abs(q['x'] + 0.008 - t['x']) < 1e-6 and abs(q['y'] + 0.010 - t['y']) < 1e-6]
        if not pl:
            continue
        q = pl[0]
        pbs = [it for it in pn['items'] if it['k'] in ('pb', 'knob') and q['x'] < it['x'] < q['x'] + q['w']
               and q['y'] < it['y'] < q['y'] + q['h']]
        rows = {}
        for it in pbs:
            cy = it['y'] + it['h'] / 2 if it['k'] == 'pb' else it['y']
            rows.setdefault(round(cy, 3), []).append(it)
        ys = sorted(rows)
        for yy in ys:
            row = sorted(rows[yy], key=lambda it: it['x'])
            for a, b in zip(row, row[1:]):
                xa = a['x'] + (a['w'] if a['k'] == 'pb' else a['r'] * 1.4)
                xb = b['x'] if b['k'] == 'pb' else b['x'] - b['r'] * 1.4
                if xb - xa > 0.004:
                    out.append(dict(k='line', pts=[(xa + 0.001, yy), (xb - 0.001, yy)], colour='flow', width=0.0009))
        if len(ys) > 1:
            # vertical bus line joining the rows at the panel centre
            xm = q['x'] + q['w'] / 2
            out.append(dict(k='line', pts=[(xm, ys[0] + 0.012), (xm, ys[-1] - 0.012)], colour='flow', width=0.0009))
    return out


def side_titles(p, pn):
    """Airbus overhead synoptic panels carry their name vertically at both side edges (H/Y/D, F/U/E/L ...)."""
    if pn['name'] != 'overhead':
        return
    for t in [it for it in pn['items'] if it['k'] == 'title' and it['text'] in ('HYD', 'FUEL', 'ELEC', 'AIR COND')]:
        pl = [q for q in pn['items'] if q['k'] == 'plate' and abs(q['x'] + 0.008 - t['x']) < 1e-6 and abs(q['y'] + 0.010 - t['y']) < 1e-6]
        if not pl:
            continue
        q = pl[0]
        letters = [c for c in t['text'] if c != ' ']
        n = len(letters)
        step = min(0.0075, (q['h'] - 0.03) / max(n, 1))
        y0 = q['y'] + q['h'] / 2 - step * (n - 1) / 2
        for xx in (q['x'] + 0.0065, q['x'] + q['w'] - 0.0065):
            for i, c in enumerate(letters):
                p.text(xx, y0 + i * step, c, 0.0046, CL.WHITE, emit=0.06)


def paint_panel(pn):
    appm = CL.panel_appm(pn)
    p = Painter(pn['w'], pn['h'], appm, pn['bg'])
    # base: subtle mottling + a soft top-to-bottom tone
    arr = np.asarray(p.c, np.float32)
    rng = np.random.default_rng(abs(hash(pn['name'])) & 0xffff)
    n = ndimage.gaussian_filter(rng.random(arr.shape[:2]), 6)
    n = (n - n.min()) / (np.ptp(n) + 1e-9)
    grad = np.linspace(1.03, 0.97, arr.shape[0])[:, None]
    arr *= ((0.975 + 0.05 * n) * grad)[..., None]
    p.c = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    p.d = ImageDraw.Draw(p.c)
    items = sorted(pn['items'] + flow_lines(pn), key=lambda it: ORDER.get(it['k'], 5))
    for it in items:
        PAINTERS[it['k']](p, it)
    side_titles(p, pn)
    # contact shadows: darken the panel around raised parts (not their tops)
    m = np.asarray(p.raised, np.float32) / 255.0
    small = max(1, int(p.PX * 0.0005))
    ms = m[::small, ::small]
    sig = 0.0022 * p.PX / small
    ao = ndimage.gaussian_filter(ms, sig) * 0.55 + ndimage.gaussian_filter(ms, sig * 3.0) * 0.30
    ao = ndimage.zoom(ao, small, order=1)[:m.shape[0], :m.shape[1]]
    if ao.shape != m.shape:
        ao = np.pad(ao, ((0, m.shape[0] - ao.shape[0]), (0, m.shape[1] - ao.shape[1])), mode='edge')
    shade = 1.0 - np.clip(ao, 0, 1) * 0.62 * (1.0 - m)
    arr = np.asarray(p.c, np.float32) * shade[..., None]
    p.c = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    return p


# ------------------------------------------------------------------------------------------------ extra regions
def cb_panel(w, h):
    """Circuit-breaker panel: rows of black CB heads with white collars, labels, grouped by white lines."""
    im = Image.new('RGB', (w, h), CL.PANEL_BG)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(F_LEG[0], 12, index=F_LEG[1])
    rng = np.random.default_rng(7)
    rows, cols = 12, 16
    mx, my = 34, 44
    px, py = (w - 2 * mx) / cols, (h - 2 * my) / rows
    names = ['ELEC', 'HYD', 'FLT CTL', 'NAV', 'FUEL', 'AIR COND']
    for r in range(rows):
        if r % 3 == 0:
            yy = my + r * py - 12
            d.line([(mx - 10, yy), (w - mx + 10, yy)], fill=(225, 228, 230), width=2)
            d.text((w / 2, yy), names[r // 3 % len(names)], font=f, fill=(225, 228, 230), anchor='mm')
        for c in range(cols):
            if rng.random() < 0.10:
                continue
            cx, cy = mx + (c + 0.5) * px, my + (r + 0.5) * py
            col = (235, 235, 235) if rng.random() < 0.9 else (60, 60, 64)
            d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=col)
            d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(18, 18, 20))
            d.text((cx, cy + 15), f'{rng.integers(1, 99)}', font=f, fill=(210, 212, 214), anchor='mm')
    d.rectangle([2, 2, w - 3, h - 3], outline=(40, 46, 55), width=4)
    return im


def quadrant_texture(w, h):
    """Thrust lever quadrant drum (region 'quadrant', painted in atlas A): two lever slots with detent marks and
    TO GA / FLX MCT / CL / 0 / REV labels, green edge lighting strips."""
    im = Image.new('RGB', (w, h), (88, 100, 114))
    em = Image.new('RGB', (w, h), (0, 0, 0))
    d, de = ImageDraw.Draw(im), ImageDraw.Draw(em)
    for sx in (0.30, 0.70):
        d.rounded_rectangle([w * sx - w * 0.055, h * 0.02, w * sx + w * 0.055, h * 0.98], radius=int(w * 0.05), fill=(14, 15, 17))
    labs = [('TO', 0.06), ('GA', 0.09), ('FLX', 0.20), ('MCT', 0.23), ('CL', 0.36), ('A/THR', 0.50), ('0', 0.64),
            ('REV', 0.80), ('FULL', 0.94)]
    f = ImageFont.truetype(F_LEG[0], int(w * 0.07), index=F_LEG[1])
    for t, v in labs:
        d.text((w * 0.5, h * v), t, font=f, fill=(236, 238, 240), anchor='mm')
        for sx in (0.12, 0.88):
            d.line([(w * (sx - 0.05), h * v), (w * (sx + 0.05), h * v)], fill=(236, 238, 240), width=3)
    for sx in (0.02, 0.98):
        d.rectangle([w * sx - 5, h * 0.03, w * sx + 5, h * 0.97], fill=(70, 230, 120))
        de.rectangle([w * sx - 5, h * 0.03, w * sx + 5, h * 0.97], fill=(40, 170, 80))
    # hatched reverse range
    for k in range(10):
        y = h * (0.70 + 0.028 * k)
        d.line([(w * 0.40, y), (w * 0.60, y + h * 0.02)], fill=(200, 200, 200), width=2)
    return im, em


def swatch_texture(n):
    """Solid colours sampled by the side faces of caps/keys/bezels (see cockpit.SWATCH)."""
    im = Image.new('RGB', (n, n), (0, 0, 0))
    d = ImageDraw.Draw(im)
    q = n // 4
    cols = [(20, 22, 25), (36, 39, 44), (30, 33, 37), (70, 80, 94), (84, 96, 110), (12, 12, 13), (150, 30, 26), (92, 104, 118)]
    for i, c in enumerate(cols):
        x, y = (i % 4) * q, (i // 4) * q
        d.rectangle([x, y, x + q - 1, y + q - 1], fill=c)
    return im


def swatch(kind, size=512, seed=0):
    rng = np.random.default_rng(seed)
    if kind == 'fabric':           # seat fabric: dark blue-grey woven
        base = np.array([62, 74, 98], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 0.8)
        yy, xx = np.mgrid[0:size, 0:size]
        weave = 0.5 + 0.5 * np.sin(xx * 1.3) * np.sin(yy * 1.3)
        img = base * (0.86 + 0.18 * n[..., None] + 0.08 * weave[..., None])
    elif kind == 'leather':
        base = np.array([40, 42, 48], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 1.2)
        n2 = ndimage.gaussian_filter(rng.random((size, size)), 12)
        img = base * (0.84 + 0.22 * n[..., None] + 0.18 * n2[..., None])
    elif kind == 'carpet':
        base = np.array([44, 47, 52], np.float32)
        n = rng.random((size, size))
        img = base * (0.8 + 0.4 * ndimage.gaussian_filter(n, 0.7)[..., None])
    elif kind == 'lining':         # light grey textured wall panels
        base = np.array([150, 153, 154], np.float32)
        n = ndimage.gaussian_filter(rng.random((size, size)), 2.0)
        img = base * (0.95 + 0.10 * n[..., None])
    else:
        base = np.array([120, 124, 130], np.float32)
        img = base * np.ones((size, size, 1))
    return Image.fromarray(img.clip(0, 255).astype(np.uint8))


def main():
    panels = CL.all_panels()
    regs = CL.regions()
    atl = {a: Image.new('RGB', (CL.ATLAS, CL.ATLAS), (70, 80, 94)) for a in 'AB'}
    emi = {a: Image.new('RGB', (CL.ATLAS, CL.ATLAS), (0, 0, 0)) for a in 'AB'}
    for pn in panels:
        a, x0, y0, w, h = regs[pn['name']]
        p = paint_panel(pn)
        atl[a].paste(p.c.resize((w, h), Image.LANCZOS), (x0, y0))
        emi[a].paste(p.e.resize((w, h), Image.LANCZOS), (x0, y0))
        print('painted', pn['name'], (w, h), flush=True)
    a, x0, y0, w, h = regs['cb']
    atl[a].paste(cb_panel(w, h), (x0, y0))
    for key in ('swatch', 'swatchB'):
        a, x0, y0, w, h = regs[key]
        atl[a].paste(swatch_texture(w), (x0, y0))
    a, x0, y0, w, h = regs['quadrant']
    qc, qe = quadrant_texture(w, h)
    atl[a].paste(qc, (x0, y0))
    emi[a].paste(qe, (x0, y0))
    for a in 'AB':
        atl[a].save(os.path.join(OUT, f'ck_atlas{a}.png'))
        emi[a].resize((CL.ATLAS // 2, CL.ATLAS // 2), Image.LANCZOS).save(os.path.join(OUT, f'ck_emit{a}.png'))
    for k, seed in (('fabric', 1), ('carpet', 2), ('lining', 3), ('leather', 4)):
        swatch(k, seed=seed).save(os.path.join(OUT, f'ck_{k}.jpg'), quality=90)
    print('atlases written', flush=True)


if __name__ == '__main__':
    main()
