"""F-16C cockpit panel art (wave 6): paints every panel face of f16_ck_layout into build/art/<panel>.png.

Run with the venv Python (numpy + PIL):  .venv/bin/python blender/aircraft/f16/f16_ck_art.py
The images are bake inputs only (never shipped): build.py bakes them (with ambient occlusion / soft light) into the
cockpit atlas that goes into f16_cockpit.glb. Lettering: Futura Condensed (close to the MS33558 panel font), light gray
on dark gray panels; instrument faces black with white markings.
"""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import f16_ck_layout as CL

OUT = os.path.join(HERE, 'build', 'art')
SS = 2

FUT = '/System/Library/Fonts/Supplemental/Futura.ttc'
DIN = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
HEL = '/System/Library/Fonts/Helvetica.ttc'

PANEL = (44, 47, 50)
PANEL_DK = (30, 32, 34)
SEAM = (20, 21, 22)
LBL = (214, 214, 206)
FACE = (13, 13, 14)
MARK = (236, 236, 230)
BEZEL = (24, 25, 26)
SCREW = (92, 95, 98)
YEL = (222, 170, 28)
COLS = {'white': (220, 220, 212), 'green': (70, 150, 70), 'red': (170, 40, 32), 'amber': (190, 130, 30),
        'blue': (120, 160, 210)}

_fcache = {}


def font(size_px, kind='fut'):
    size_px = max(6, int(round(size_px)))
    k = (kind, size_px)
    if k not in _fcache:
        try:
            if kind == 'fut':
                _fcache[k] = ImageFont.truetype(FUT, size_px, index=3)      # Futura Condensed Medium
            elif kind == 'futb':
                _fcache[k] = ImageFont.truetype(FUT, size_px, index=4)      # Condensed ExtraBold
            elif kind == 'din':
                _fcache[k] = ImageFont.truetype(DIN, size_px)
            else:
                _fcache[k] = ImageFont.truetype(HEL, size_px, index=1)
        except Exception:
            _fcache[k] = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf', size_px)
    return _fcache[k]


class Painter:
    def __init__(self, P):
        self.P = P
        self.w, self.h, self.ppm = P['w'], P['h'], P['ppm'] * SS
        self.W, self.H = int(round(self.w * self.ppm)), int(round(self.h * self.ppm))
        self.im = Image.new('RGB', (self.W, self.H), PANEL)
        self.d = ImageDraw.Draw(self.im)

    def px(self, u, v):
        return ((u + self.w / 2) * self.ppm, (self.h / 2 - v) * self.ppm)

    def L(self, m):
        return m * self.ppm

    # ---- primitives
    def rect(self, u0, v0, u1, v1, fill=None, outline=None, width=0.0):
        a = self.px(min(u0, u1), max(v0, v1)); b = self.px(max(u0, u1), min(v0, v1))
        self.d.rectangle([a[0], a[1], b[0], b[1]], fill=fill, outline=outline, width=max(1, int(self.L(width))) if outline else 0)

    def rrect(self, u, v, w, h, r, fill=None, outline=None, width=0.0):
        a = self.px(u - w / 2, v + h / 2); b = self.px(u + w / 2, v - h / 2)
        self.d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=self.L(r), fill=fill, outline=outline,
                                 width=max(1, int(self.L(width))) if outline else 0)

    def circle(self, u, v, r, fill=None, outline=None, width=0.0):
        c = self.px(u, v); R = self.L(r)
        self.d.ellipse([c[0] - R, c[1] - R, c[0] + R, c[1] + R], fill=fill, outline=outline,
                       width=max(1, int(self.L(width))) if outline else 0)

    def line(self, pts, fill, width):
        self.d.line([self.px(*p) for p in pts], fill=fill, width=max(1, int(round(self.L(width)))))

    def poly(self, pts, fill=None, outline=None):
        self.d.polygon([self.px(*p) for p in pts], fill=fill, outline=outline)

    def text(self, u, v, s, size, fill=LBL, anchor='mm', kind='fut', angle=0.0):
        if not s:
            return
        f = font(self.L(size) * 1.32, kind)          # cap height ~ size
        if angle:
            tw = int(self.L(size) * 1.4 * (len(s) + 2)); th = int(self.L(size) * 3)
            tmp = Image.new('L', (tw, th), 0)
            ImageDraw.Draw(tmp).text((tw / 2, th / 2), s, font=f, fill=255, anchor='mm')
            tmp = tmp.rotate(angle, resample=Image.BICUBIC, expand=True)
            c = self.px(u, v)
            col = Image.new('RGB', tmp.size, fill)
            self.im.paste(col, (int(c[0] - tmp.width / 2), int(c[1] - tmp.height / 2)), tmp)
            return
        lines = s.split('\n')
        if len(lines) > 1:
            dy = size * 1.35
            for i, ln in enumerate(lines):
                self.text(u, v + dy * ((len(lines) - 1) / 2 - i), ln, size, fill, anchor, kind)
            return
        self.d.text(self.px(u, v), s, font=f, fill=fill, anchor=anchor)

    def screw(self, u, v, r=0.0021):
        self.circle(u, v, r, fill=SCREW, outline=(40, 41, 43), width=0.0004)
        a = 0.6
        self.line([(u - r * 0.75 * math.cos(a), v - r * 0.75 * math.sin(a)), (u + r * 0.75 * math.cos(a), v + r * 0.75 * math.sin(a))],
                  (38, 38, 40), 0.0006)

    def noise(self, amp=3.0, seed=1):
        r = np.random.default_rng(seed)
        a = np.asarray(self.im).astype(np.float32)
        h, w = a.shape[:2]
        n = r.normal(0, amp, (h // 16 + 2, w // 16 + 2)).astype(np.float32)
        n = np.kron(n, np.ones((16, 16), np.float32))[:h, :w]
        from scipy.ndimage import gaussian_filter
        n = gaussian_filter(n, 10)
        fine = r.normal(0, amp * 0.5, (h, w)).astype(np.float32)
        a = np.clip(a + (n + fine)[..., None], 0, 255)
        self.im = Image.fromarray(a.astype(np.uint8))
        self.d = ImageDraw.Draw(self.im)

    def save(self, path):
        im = self.im.resize((self.W // SS, self.H // SS), Image.LANCZOS)
        im.save(path)


# ----------------------------------------------------------------------------------------------------------------------
# dials
def ticks(p, u, v, R, a0, a1, n, major=1, r_in=0.80, r_out=0.95, lw=0.0006, lab=None, lab_r=0.62, size=0.16, col=MARK,
          minor_in=0.87):
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        mj = (i % major == 0)
        ri = R * (r_in if mj else minor_in)
        p.line([(u + ri * math.sin(a), v + ri * math.cos(a)), (u + R * r_out * math.sin(a), v + R * r_out * math.cos(a))],
               col, lw * (1.6 if mj else 1.0))
        if lab and mj and (i // major) < len(lab):
            t = lab[i // major]
            p.text(u + R * lab_r * math.sin(a), v + R * lab_r * math.cos(a), t, R * size, col, kind='fut')


def needle(p, u, v, R, a_deg, L=0.80, w=0.055, col=MARK, tail=0.22):
    a = math.radians(a_deg)
    tip = (u + R * L * math.sin(a), v + R * L * math.cos(a))
    nx, ny = math.cos(a) * R * w, -math.sin(a) * R * w
    b = (u - R * tail * math.sin(a), v - R * tail * math.cos(a))
    p.poly([tip, (b[0] + nx, b[1] + ny), (b[0] - nx, b[1] - ny)], fill=col)
    p.circle(u, v, R * 0.075, fill=(50, 50, 52))


def counter(p, u, v, w, h, digits, size=None):
    p.rect(u - w / 2, v - h / 2, u + w / 2, v + h / 2, fill=(8, 8, 8), outline=(95, 95, 95), width=0.0004)
    p.text(u, v, digits, size or h * 0.62, MARK, kind='hel')


def dial(p, u, v, dia, kind):
    R = dia / 2
    p.circle(u, v, R, fill=FACE)
    if kind == 'asi':
        # airspeed (knots, non-linear) + mach inner ring
        vals = [('1', -140), ('2', -95), ('3', -40), ('4', 15), ('5', 60), ('6', 95), ('7', 125), ('8', 150)]
        for i in range(0, 60):
            a = -160 + i * 5.2
            if a > 158:
                break
            mj = i % 2 == 0
            ri = R * (0.82 if mj else 0.88)
            p.line([(u + ri * math.sin(math.radians(a)), v + ri * math.cos(math.radians(a))),
                    (u + R * 0.95 * math.sin(math.radians(a)), v + R * 0.95 * math.cos(math.radians(a)))], MARK, 0.00055)
        for t, a in vals:
            p.text(u + R * 0.68 * math.sin(math.radians(a)), v + R * 0.68 * math.cos(math.radians(a)), t, R * 0.17, MARK)
        p.circle(u, v, R * 0.46, outline=(150, 150, 150), width=0.0004)
        for i, t in enumerate(('.5', '.7', '.9', '1.1', '1.4', '1.8')):
            a = math.radians(-120 + i * 45)
            p.text(u + R * 0.36 * math.sin(a), v + R * 0.36 * math.cos(a), t, R * 0.09, MARK)
        p.text(u, v - R * 0.60, 'KNOTS', R * 0.09, MARK)
        p.text(u, v + R * 0.22, 'MACH', R * 0.08, MARK)
        needle(p, u, v, R, -40, col=MARK)
        needle(p, u, v, R, 120, L=0.5, w=0.05, col=(230, 130, 40))
    elif kind == 'alt':
        ticks(p, u, v, R, 0, 360, 50, 5, lab=list('0123456789'), lab_r=0.66, size=0.19)
        counter(p, u - R * 0.18, v + R * 0.12, R * 0.62, R * 0.24, '02400')
        counter(p, u + R * 0.30, v - R * 0.30, R * 0.54, R * 0.18, '2992')
        p.text(u, v + R * 0.42, 'ALT', R * 0.14, MARK)
        p.rect(u - R * 0.62, v + R * 0.02, u - R * 0.42, v + R * 0.22, fill=(210, 150, 30))
        p.text(u - R * 0.52, v + R * 0.12, 'PNEU', R * 0.055, (20, 20, 20))
        needle(p, u, v, R, 144, L=0.84, w=0.05)
    elif kind in ('adi', 'sai'):
        # attitude sphere: gray sky, black ground, pitch ladder, orange aircraft symbol, bank scale
        r = R * 0.86
        c = p.px(u, v); rr = p.L(r)
        p.d.pieslice([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], 180, 360, fill=(150, 152, 150))
        p.d.pieslice([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], 0, 180, fill=(22, 22, 22))
        for pp in (-30, -20, -10, 10, 20, 30):
            yy = v + pp * r * 0.028
            ww = r * (0.22 if abs(pp) % 20 else 0.36)
            col = (25, 25, 25) if pp > 0 else (225, 225, 225)
            p.line([(u - ww, yy), (u + ww, yy)], col, 0.0005)
            if kind == 'adi':
                p.text(u - ww - r * 0.12, yy, str(abs(pp)), r * 0.09, col)
        p.line([(u - r, v), (u + r, v)], MARK, 0.0009)
        ticks(p, u, v, R, -60, 60, 12, 3, r_in=0.88, r_out=0.98, lw=0.0005, minor_in=0.93)
        p.poly([(u, v + R * 0.86), (u - R * 0.05, v + R * 0.97), (u + R * 0.05, v + R * 0.97)], fill=MARK)
        # aircraft symbol
        p.line([(u - r * 0.55, v), (u - r * 0.17, v)], (240, 150, 25), 0.0014)
        p.line([(u + r * 0.17, v), (u + r * 0.55, v)], (240, 150, 25), 0.0014)
        p.poly([(u - r * 0.17, v), (u, v - r * 0.10), (u + r * 0.17, v)], fill=(240, 150, 25))
        p.circle(u, v, r * 0.035, fill=(240, 150, 25))
        if kind == 'adi':
            # ILS bars + glideslope scale + OFF / LOC flags
            p.line([(u + r * 0.10, v + r * 0.75), (u + r * 0.10, v - r * 0.75)], (230, 200, 40), 0.0007)
            p.line([(u - r * 0.75, v - r * 0.08), (u + r * 0.75, v - r * 0.08)], (230, 200, 40), 0.0007)
            for k in (-2, -1, 1, 2):
                p.circle(u + R * 0.93, v + k * R * 0.15, R * 0.025, outline=MARK, width=0.0004)
            p.rect(u - R * 0.92, v - R * 0.55, u - R * 0.70, v - R * 0.35, fill=(190, 35, 30))
            p.text(u - R * 0.81, v - R * 0.45, 'OFF', R * 0.07, (240, 230, 220))
            p.text(u - R * 0.62, v - R * 0.78, 'GS', R * 0.07, MARK)
    elif kind == 'hsi':
        for i in range(72):
            a = math.radians(i * 5)
            mj = i % 2 == 0
            ri = R * (0.78 if mj else 0.83)
            p.line([(u + ri * math.sin(a), v + ri * math.cos(a)), (u + R * 0.90 * math.sin(a), v + R * 0.90 * math.cos(a))], MARK, 0.0005)
        for i, t in enumerate(('N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33')):
            a = math.radians(i * 30 - 297 % 360)
            p.text(u + R * 0.66 * math.sin(a), v + R * 0.66 * math.cos(a), t, R * 0.11, MARK)
        # course arrow + deviation dots + aircraft symbol
        a = math.radians(40)
        ca, sa = math.cos(a), math.sin(a)
        p.line([(u - R * 0.55 * sa, v - R * 0.55 * ca), (u + R * 0.55 * sa, v + R * 0.55 * ca)], (230, 200, 40), 0.0012)
        p.poly([(u + R * 0.6 * sa, v + R * 0.6 * ca), (u + R * 0.48 * sa + R * 0.05 * ca, v + R * 0.48 * ca - R * 0.05 * sa),
                (u + R * 0.48 * sa - R * 0.05 * ca, v + R * 0.48 * ca + R * 0.05 * sa)], fill=(230, 200, 40))
        for k in (-2, -1, 1, 2):
            p.circle(u + k * R * 0.16 * ca, v - k * R * 0.16 * sa, R * 0.025, outline=MARK, width=0.0004)
        p.line([(u - R * 0.16, v), (u + R * 0.16, v)], MARK, 0.0008)
        p.line([(u, v + R * 0.10), (u, v - R * 0.18)], MARK, 0.0008)
        p.line([(u - R * 0.07, v - R * 0.14), (u + R * 0.07, v - R * 0.14)], MARK, 0.0008)
        p.poly([(u, v + R * 0.90), (u - R * 0.04, v + R * 0.98), (u + R * 0.04, v + R * 0.98)], fill=MARK)
        counter(p, u - R * 0.58, v + R * 0.84, R * 0.34, R * 0.14, '012')
        counter(p, u + R * 0.58, v + R * 0.84, R * 0.34, R * 0.14, '240')
        p.text(u - R * 0.58, v + R * 1.00, 'RANGE', R * 0.06, MARK)
        p.text(u + R * 0.58, v + R * 1.00, 'COURSE', R * 0.06, MARK)
        p.rect(u + R * 0.12, v - R * 0.30, u + R * 0.34, v - R * 0.18, fill=(190, 35, 30))
    elif kind in ('aoa', 'vvi'):
        pass     # tapes are drawn by tape()
    elif kind == 'clock':
        ticks(p, u, v, R, 0, 360, 60, 5, r_in=0.80, lab=['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], lab_r=0.62, size=0.2)
        needle(p, u, v, R, 60, L=0.52, w=0.07); needle(p, u, v, R, 300, L=0.78, w=0.05)
        needle(p, u, v, R, 200, L=0.85, w=0.02, col=(230, 60, 40))
    elif kind == 'fuel':
        ticks(p, u, v, R, -140, 140, 40, 5, lab=['0', '1', '2', '3', '4', '5', '6', '7', '8'], lab_r=0.67, size=0.14)
        p.text(u, v - R * 0.30, 'FUEL', R * 0.14, MARK, kind='futb')
        p.text(u, v - R * 0.47, 'LBS x 1000', R * 0.07, MARK)
        counter(p, u, v - R * 0.66, R * 0.66, R * 0.17, '07500')
        p.text(u - R * 0.52, v + R * 0.30, 'AL', R * 0.08, MARK); p.text(u + R * 0.52, v + R * 0.30, 'FR', R * 0.08, (230, 70, 50))
        needle(p, u, v, R, -30, col=MARK)
        needle(p, u, v, R, -18, L=0.7, col=(230, 70, 50))
    else:
        spec = {'oil': ('OIL', 'PSI', ['0', '20', '40', '60', '80', '100'], -135, 135, 20),
                'noz': ('NOZ POS', '% OPEN', ['0', '20', '40', '60', '80', '100'], -150, 150, -120),
                'rpm': ('RPM', '%', ['0', '20', '40', '60', '80', '100'], -150, 150, 70),
                'ftit': ('FTIT', 'x100 °C', ['2', '4', '6', '8', '10', '12'], -150, 150, -10),
                'hyda': ('HYD A', 'PSI x1000', ['0', '1', '2', '3', '4'], -135, 135, 60),
                'hydb': ('HYD B', 'PSI x1000', ['0', '1', '2', '3', '4'], -135, 135, 62),
                'lox': ('LOX', 'LITERS', ['0', '1', '2', '3', '4', '5'], -135, 135, 80),
                'epu': ('EPU', 'FUEL %', ['0', '50', '100'], -120, 120, 95),
                'cabin': ('CABIN', 'x1000 FT', ['0', '10', '20', '30', '40', '50'], -150, 150, -110)}[kind]
        name, unit, lab, a0, a1, a_n = spec
        a0, a1 = max(a0, -135), min(a1, 135)
        n = (len(lab) - 1) * 5
        ticks(p, u, v, R, a0, a1, n, 5, lab=lab, lab_r=0.62, size=0.17 if dia < 0.045 else 0.155)
        p.text(u, v - R * 0.30, name, R * (0.13 if len(name) < 6 else 0.105), MARK, kind='futb')
        p.text(u, v - R * 0.47, unit, R * 0.085, MARK)
        needle(p, u, v, R, max(min(a_n, 130), -130))


def tape(p, u, v, w, h, kind):
    p.rect(u - w / 2, v - h / 2, u + w / 2, v + h / 2, fill=FACE)
    ww = w * 0.55
    p.rect(u - ww / 2, v - h * 0.45, u + ww / 2, v + h * 0.45, fill=(18, 18, 18))
    if kind == 'aoa':
        vals = ['30', '25', '20', '15', '10', '5', '0']
        for i, t in enumerate(vals):
            yy = v + h * 0.40 - i * h * 0.8 / 6
            p.line([(u - ww / 2, yy), (u - ww / 2 + ww * 0.3, yy)], MARK, 0.0005)
            p.text(u + ww * 0.12, yy, t, w * 0.22, MARK)
        p.rect(u - ww / 2 + ww * 0.05, v + h * 0.02, u - ww / 2 + ww * 0.25, v - h * 0.10, fill=(40, 150, 60))
        p.rect(u - ww / 2 + ww * 0.05, v + h * 0.10, u - ww / 2 + ww * 0.25, v + h * 0.02, fill=(210, 170, 30))
        p.text(u, v - h * 0.47, 'AOA', w * 0.2, MARK)
    else:
        vals = ['6', '4', '2', '1', '0', '1', '2', '4', '6']
        for i, t in enumerate(vals):
            yy = v + h * 0.40 - i * h * 0.8 / 8
            p.line([(u - ww / 2, yy), (u - ww / 2 + ww * 0.3, yy)], MARK, 0.0005)
            p.text(u + ww * 0.12, yy, t, w * 0.22, MARK)
        p.text(u, v + h * 0.47, 'UP', w * 0.18, MARK)
        p.text(u, v - h * 0.47, 'DN', w * 0.18, MARK)
    p.poly([(u - w / 2, v + 0.002), (u - w / 2 + 0.005, v), (u - w / 2, v - 0.002)], fill=(230, 200, 40))
    p.line([(u - ww / 2, v), (u + ww / 2, v)], (230, 200, 40), 0.0006)


# ----------------------------------------------------------------------------------------------------------------------
def draw_item(p, it):
    k = it['k']
    u, v = it.get('u', 0), it.get('v', 0)
    if k == 'box':
        p.rect(it['u0'], it['v0'], it['u1'], it['v1'], outline=SEAM, width=0.0011)
        p.rect(it['u0'] + 0.0011, it['v0'] + 0.0011, it['u1'] - 0.0011, it['v1'] - 0.0011, outline=(58, 61, 64), width=0.0004)
        if it.get('screws', True):
            for (a, b) in ((it['u0'] + 0.0045, it['v0'] + 0.0045), (it['u1'] - 0.0045, it['v0'] + 0.0045),
                           (it['u0'] + 0.0045, it['v1'] - 0.0045), (it['u1'] - 0.0045, it['v1'] - 0.0045)):
                p.screw(a, b)
        if it.get('title'):
            p.text((it['u0'] + it['u1']) / 2, it['v1'] - 0.0055, it['title'], 0.0034, LBL, kind='futb')
    elif k == 'label':
        col = COLS.get(it['color'], LBL) if it['color'] != 'white' else LBL
        p.text(u, v, it['text'], it['size'] * 0.8, col, anchor=it['anchor'])
    elif k == 'gauge':
        dia = it['dia']
        if it['flange'] == 'tall':
            w, h = dia + 0.006, dia * 2.9
            p.rrect(u, v, w, h, 0.003, fill=BEZEL)
            tape(p, u, v, w * 0.8, h * 0.9, it['face'])
            return
        sw = dia + 0.006
        p.rrect(u, v, sw, sw, 0.002, fill=BEZEL)
        for a, b in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            p.screw(u + a * (sw / 2 - 0.0028), v + b * (sw / 2 - 0.0028), 0.0015)
        dial(p, u, v, dia * 0.985, it['face'])
        p.circle(u, v, dia / 2, outline=(60, 60, 62), width=0.0006)
        if it.get('label'):
            p.text(u, v + sw / 2 + 0.0042, it['label'], 0.0030, LBL, kind='futb')
        kn = it.get('knob')
        if kn:
            where, r = kn
            pos = []
            if where in ('ll', 'both'):
                pos.append((u - sw / 2 + r * 0.9, v - sw / 2 + r * 0.9))
            if where in ('lr', 'both'):
                pos.append((u + sw / 2 - r * 0.9, v - sw / 2 + r * 0.9))
            for a, b in pos:
                knob_top(p, a, b, r, 0)
    elif k == 'key':
        key_cap(p, it)
    elif k == 'light':
        w, h = it['w'], it['h']
        p.rrect(u, v, w + 0.002, h + 0.002, 0.0008, fill=(12, 12, 12))
        base = COLS.get(it['color'], LBL)
        p.rrect(u, v, w, h, 0.0006, fill=tuple(int(c * 0.16) for c in base))
        if it['text']:
            p.text(u, v, it['text'], min(h * 0.42, w / (len(it['text']) * 0.55 + 0.5)), tuple(int(c * 0.75) for c in base), kind='futb')
    elif k == 'knob':
        r = it['r']
        if it['style'] == 'bar':
            p.circle(u, v, r * 1.05, fill=(16, 16, 17))
            a = math.radians(it.get('ang', 0.0) + 90)
            ca, sa = math.cos(a), math.sin(a)
            pts = [(u + ca * r * 1.25 - sa * r * 0.33, v + sa * r * 1.25 + ca * r * 0.33),
                   (u + ca * r * 1.25 + sa * r * 0.33, v + sa * r * 1.25 - ca * r * 0.33),
                   (u - ca * r * 1.25 + sa * r * 0.33, v - sa * r * 1.25 - ca * r * 0.33),
                   (u - ca * r * 1.25 - sa * r * 0.33, v - sa * r * 1.25 + ca * r * 0.33)]
            p.poly(pts, fill=(20, 20, 21))
            p.line([(u, v), (u + ca * r * 1.15, v + sa * r * 1.15)], MARK, 0.0008)
        elif it['style'] == 'wheelv':
            p.rect(u - r * 0.9, v - r * 1.4, u + r * 0.9, v + r * 1.4, fill=(14, 14, 14))
        else:
            knob_top(p, u, v, r, it.get('ang', 0.0))
        marks = it.get('marks') or []
        if marks:
            n = len(marks)
            span = min(240, 50 * (n - 1)) if n > 1 else 0
            for i, t in enumerate(marks):
                a = math.radians(-span / 2 + (span * i / (n - 1) if n > 1 else 0))
                rr = r * 1.35 + 0.0015
                p.line([(u + rr * math.sin(a), v + rr * math.cos(a)), (u + (rr + 0.0018) * math.sin(a), v + (rr + 0.0018) * math.cos(a))], LBL, 0.0004)
                ro = rr + 0.0018 + 0.0012 + len(t) * 0.0007
                p.text(u + ro * math.sin(a), v + ro * math.cos(a), t, 0.0020, LBL)
        if it.get('label'):
            off = r * 1.35 + (0.0085 if marks else 0.004)
            p.text(u, v - off, it['label'], 0.0026, LBL, kind='futb')
    elif k == 'toggle':
        s = it['size']
        p.circle(u, v, 0.0048 * s, fill=(26, 27, 28))
        if it.get('guard'):
            col = (150, 30, 25) if it['guard'] == 'red' else YEL
            p.rect(u - 0.0078 * s, v - 0.0135 * s, u + 0.0078 * s, v + 0.0135 * s, outline=col, width=0.0006)
        if it.get('label'):
            p.text(u, v + 0.0178 * s, it['label'], 0.0027, LBL, kind='futb')
        if it.get('up'):
            p.text(u, v + 0.0098 * s, it['up'], 0.0021, LBL)
        if it.get('dn'):
            p.text(u, v - 0.0098 * s, it['dn'], 0.0021, LBL)
        if it.get('mid'):
            p.text(u + 0.0062 * s, v, it['mid'], 0.0019, LBL, anchor='lm')
    elif k == 'display':
        display_face(p, it)
    elif k in ('special', 'paint'):
        fn = SPECIAL_ART.get(it['name'])
        if fn:
            fn(p, it)


def knob_top(p, u, v, r, ang):
    p.circle(u, v, r, fill=(15, 15, 16))
    p.circle(u, v, r * 0.72, fill=(26, 26, 28))
    a = math.radians(ang)
    p.line([(u + r * 0.15 * math.sin(a), v + r * 0.15 * math.cos(a)), (u + r * 0.95 * math.sin(a), v + r * 0.95 * math.cos(a))], MARK, 0.0007)


def key_cap(p, it):
    u, v, w, h, st = it['u'], it['v'], it['w'], it['h'], it['style']
    txt, sub = it.get('text', ''), it.get('sub', '')
    if st == 'round':
        p.circle(u, v, w / 2 + 0.0015, fill=(12, 12, 13))
        p.circle(u, v, w / 2 * 0.86, fill=(44, 45, 47))
        p.circle(u, v, w / 2 * 0.86, outline=(90, 90, 92), width=0.0005)
        if txt:
            p.text(u, v, txt, w * (0.22 if '\n' in txt else 0.26), LBL, kind='futb')
        if sub:
            p.text(u, v - w * 0.9, sub, 0.0022, LBL)
        return
    if st in ('keyw', 'keyb'):
        fill = (205, 205, 198) if st == 'keyw' else (150, 168, 186)
        p.rrect(u, v, w, h, min(w, h) * 0.12, fill=fill)
        p.rrect(u, v, w, h, min(w, h) * 0.12, outline=(90, 90, 90), width=0.0004)
        ink = (20, 20, 22)
        if sub:
            p.text(u, v + h * 0.12, txt, h * 0.30, ink, kind='futb')
            p.text(u, v - h * 0.24, sub, h * 0.15, ink, kind='futb')
        elif txt:
            p.text(u, v, txt, h * (0.30 if len(txt) < 3 else 0.2), ink, kind='futb')
        return
    if st == 'lit':
        base = COLS.get(it.get('lit') or 'green')
        p.rrect(u, v, w, h, 0.001, fill=(14, 14, 15))
        p.rrect(u, v, w * 0.86, h * 0.86, 0.0008, fill=tuple(int(c * 0.10) for c in base))
        ink = tuple(int(c * 0.8) for c in base)
        if sub:
            p.text(u, v + h * 0.16, txt, h * 0.17, ink, kind='futb')
            p.text(u, v - h * 0.18, sub, h * 0.17, ink, kind='futb')
        else:
            p.text(u, v, txt, min(h * 0.2, w / (len(txt) * 0.6 + 0.5)), ink, kind='futb')
        return
    if st == 'yb':
        stripes(p, u, v, w + 0.008, h + 0.008)
        p.rrect(u, v, w, h, 0.001, fill=(20, 20, 20))
        p.circle(u, v, min(w, h) * 0.36, fill=(215, 175, 40))
        p.text(u, v + h / 2 + 0.008, txt + (' ' + sub if sub else ''), 0.0024, LBL, kind='futb')
        return
    # gray push button
    p.rrect(u, v, w, h, 0.0012, fill=(52, 54, 57))
    p.rrect(u, v, w, h, 0.0012, outline=(96, 98, 100), width=0.0004)
    if sub:
        p.text(u, v + h * 0.17, txt, h * 0.19, LBL, kind='futb')
        p.text(u, v - h * 0.19, sub, h * 0.19, LBL, kind='futb')
    elif txt:
        p.text(u, v, txt, h * 0.26, LBL, kind='futb')


def stripes(p, u, v, w, h, n=None):
    """Yellow/black diagonal hazard border."""
    x0, y0 = p.px(u - w / 2, v + h / 2); x1, y1 = p.px(u + w / 2, v - h / 2)
    tile = Image.new('RGB', (int(x1 - x0) + 1, int(y1 - y0) + 1), (18, 18, 18))
    dd = ImageDraw.Draw(tile)
    step = p.L(0.004)
    for k in range(-int(tile.height / step) - 2, int(tile.width / step) + 3):
        x = k * step
        dd.polygon([(x, 0), (x + step / 2, 0), (x + step / 2 + tile.height, tile.height), (x + tile.height, tile.height)], fill=YEL)
    p.im.paste(tile, (int(x0), int(y0)))


def display_face(p, it):
    u, v, bw, bh, sw, sh = it['u'], it['v'], it['bw'], it['bh'], it['sw'], it['sh']
    kind = it['kind']
    p.rrect(u, v, bw, bh, 0.006 if kind != 'ded' else 0.004, fill=(30, 31, 33))
    p.rrect(u, v, bw, bh, 0.006 if kind != 'ded' else 0.004, outline=(62, 64, 66), width=0.0006)
    sx, sy = u + it['soff'][0], v + it['soff'][1]
    p.rect(sx - sw / 2 - 0.002, sy - sh / 2 - 0.002, sx + sw / 2 + 0.002, sy + sh / 2 + 0.002, fill=(6, 6, 7))
    if kind == 'mfd':
        for bx, by, kw, kh in CL.osb_positions(it):
            p.rrect(bx, by, kw, kh, 0.0012, fill=(150, 154, 158))
            p.rrect(bx, by, kw, kh, 0.0012, outline=(70, 72, 74), width=0.0004)
            if abs(bx - u) < 1e-6 or abs(by - v) < 1e-6:
                p.line([(bx - kw * 0.25, by), (bx + kw * 0.25, by)], (40, 40, 42), 0.0005)
        for cx, cy, t in ((-1, 1, 'GAIN'), (1, 1, 'SYM'), (-1, -1, 'CON'), (1, -1, 'BRT')):
            bx, by = u + cx * (bw / 2 - 0.0095), v + cy * (bh / 2 - 0.0095)
            p.rrect(bx, by, 0.0085, 0.0085, 0.002, fill=(120, 124, 128))
            p.text(bx, by, '▲' if False else '', 0.002)
            p.text(bx, by + cy * 0.0072, t, 0.0020, LBL, kind='futb')
        for a, b in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            p.screw(u + a * (bw / 2 - 0.003), v + b * (bh / 2 - 0.003), 0.0012)
    elif kind == 'ded':
        for a, b in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            p.screw(u + a * (bw / 2 - 0.004), v + b * (bh / 2 - 0.004), 0.0014)
    elif kind == 'rwr':
        for a, b in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            p.screw(u + a * (bw / 2 - 0.0035), v + b * (bh / 2 - 0.0035), 0.0014)
        knob_top(p, u + bw / 2 - 0.007, v - bh / 2 + 0.007, 0.0045, 30)
        p.text(u, v + bh / 2 - 0.0035, 'THREAT', 0.0020, LBL)


# ---- specials -----------------------------------------------------------------------------------------------------
def a_jettison(p, it):
    u, v = it['u'], it['v']
    stripes(p, u, v, 0.040, 0.040)
    p.rect(u - 0.015, v - 0.015, u + 0.015, v + 0.015, fill=(14, 14, 14))
    p.circle(u, v, 0.0125, fill=(20, 20, 21))


def a_gearlamps(p, it):
    u, v = it['u'], it['v']
    # aircraft planform outline with three gear lights (NOSE / LEFT / RIGHT)
    pts = [(0, 0.028), (0.004, 0.010), (0.022, -0.004), (0.022, -0.010), (0.005, -0.006), (0.004, -0.018), (0.011, -0.024),
           (0.011, -0.028), (0, -0.026)]
    full = pts + [(-x, y) for x, y in reversed(pts)]
    p.line([(u + x, v + y) for x, y in full] + [(u + full[0][0], v + full[0][1])], LBL, 0.0006)
    for x, y in ((0, 0.018), (-0.012, -0.004), (0.012, -0.004)):
        p.circle(u + x, v + y, 0.0036, fill=(14, 14, 14))
        p.circle(u + x, v + y, 0.0026, fill=(20, 60, 25))
    p.text(u, v - 0.034, 'WHEELS', 0.0026, LBL, kind='futb')


def a_gearhandle(p, it):
    u, v = it['u'], it['v']
    p.rect(u - 0.006, v - 0.052, u + 0.006, v + 0.034, fill=(12, 12, 12))
    p.rect(u - 0.0022, v - 0.048, u + 0.0022, v + 0.030, fill=(4, 4, 4))


def a_fuelflow(p, it):
    u, v = it['u'], it['v']
    p.rrect(u, v, 0.060, 0.034, 0.003, fill=(16, 16, 17))
    for i, dgt in enumerate('3500'):
        p.rect(u - 0.019 + i * 0.0105 - 0.0045, v - 0.006, u - 0.019 + i * 0.0105 + 0.0045, v + 0.008, fill=(6, 6, 6))
        p.text(u - 0.019 + i * 0.0105, v + 0.001, dgt, 0.0075, MARK, kind='hel')
    p.text(u, v + 0.0125, 'FUEL FLOW', 0.0026, MARK, kind='futb')
    p.text(u, v - 0.0115, 'PPH', 0.0024, MARK)


def a_throttle_slot(p, it):
    u, v = it['u'], it['v']
    p.rect(u - 0.006, v - 0.105, u + 0.006, v + 0.105, fill=(8, 8, 8))
    p.rect(u - 0.018, v - 0.108, u + 0.018, v + 0.108, outline=SEAM, width=0.0008)
    for dv in (-0.095, -0.045, 0.045, 0.080):
        p.line([(u + 0.008, v + dv), (u + 0.016, v + dv)], LBL, 0.0006)


def a_stick_base(p, it):
    u, v = it['u'], it['v']
    p.rrect(u, v, 0.074, 0.089, 0.013, fill=(20, 20, 21))


def a_uhf(p, it):
    u, v = it['u'], it['v']
    p.rect(u - 0.056, v + 0.004, u + 0.016, v + 0.020, fill=(8, 8, 8))
    p.text(u - 0.020, v + 0.012, '2 9 2 . 3 0', 0.0068, MARK, kind='hel')
    p.rect(u + 0.030, v + 0.018, u + 0.044, v + 0.030, fill=(8, 8, 8))
    p.text(u + 0.037, v + 0.024, '1', 0.0055, MARK, kind='hel')
    p.text(u + 0.037, v + 0.034, 'PRESET', 0.0020, LBL)
    for i in range(5):
        knob_top(p, u - 0.050 + i * 0.019, v - 0.010, 0.0055, 0)
    knob_top(p, u + 0.052, v + 0.008, 0.008, 0)
    p.text(u - 0.012, v - 0.0205, 'MHz', 0.0022, LBL)


def a_oxyreg(p, it):
    u, v = it['u'], it['v']
    for x, t in ((-0.040, 'FLOW'), (0.0, 'PRESS')):
        c = (u + x, v + 0.022)
        p.rrect(c[0], c[1], 0.036, 0.036, 0.002, fill=BEZEL)
        p.circle(c[0], c[1], 0.015, fill=FACE)
        if t == 'FLOW':
            p.rect(c[0] - 0.006, c[1] - 0.004, c[0] + 0.006, c[1] + 0.004, fill=(30, 30, 30))
            p.text(c[0], c[1] - 0.009, 'FLOW', 0.0024, MARK)
        else:
            ticks(p, c[0], c[1], 0.015, -135, 135, 10, 2, lab=['0', '1', '2', '3', '4', '5'], lab_r=0.6, size=0.2)
            needle(p, c[0], c[1], 0.015, 20)
            p.text(c[0], c[1] - 0.0075, 'PSI', 0.0018, MARK)
    p.text(u + 0.040, v + 0.034, 'SUPPLY', 0.0024, LBL, kind='futb')
    p.text(u + 0.040, v + 0.026, 'ON / OFF', 0.0020, LBL)
    p.text(u + 0.040, v + 0.016, 'DILUTER', 0.0024, LBL, kind='futb')
    p.text(u + 0.040, v + 0.008, 'NORM / 100%', 0.0020, LBL)
    for i, (t, sub) in enumerate((('SUPPLY', 'ON'), ('DILUTER', 'NORM'), ('EMERG', 'NORMAL'))):
        bx = u - 0.045 + i * 0.030
        p.rect(bx - 0.0045, v - 0.041, bx + 0.0045, v - 0.011, fill=(14, 14, 14))
        p.text(bx, v - 0.047, t, 0.0020, LBL, kind='futb')
        p.text(bx, v - 0.006, sub, 0.0018, LBL)


def a_vent(p, it):
    u, v, w, h = it['u'], it['v'], it['w'], it['h']
    p.rrect(u, v, w, h, 0.003, fill=(16, 16, 16))
    for k in range(9):
        yy = v - h / 2 + 0.003 + k * (h - 0.006) / 8
        p.line([(u - w / 2 + 0.003, yy), (u + w / 2 - 0.003, yy)], (40, 40, 42), 0.0012)


def a_dobber(p, it):
    u, v = it['u'], it['v']
    p.circle(u, v, 0.0068, fill=(170, 170, 165))
    for dv in (0.0095, -0.0095):
        p.poly([(u, v + dv * 1.2), (u - 0.0018, v + dv * 0.95), (u + 0.0018, v + dv * 0.95)], fill=LBL)


SPECIAL_ART = dict(jettison=a_jettison, gearlamps=a_gearlamps, gearhandle=a_gearhandle, fuelflow=a_fuelflow,
                   throttle_slot=a_throttle_slot, stick_base=a_stick_base, uhf=a_uhf, oxyreg=a_oxyreg, vent=a_vent,
                   dobber=a_dobber)


# ----------------------------------------------------------------------------------------------------------------------
def paint_panel(P):
    p = Painter(P)
    name = P['name']
    base = {'icp': (26, 27, 29), 'lmfd': (36, 38, 41), 'rmfd': (36, 38, 41), 'leyebrow': (30, 31, 33),
            'reyebrow': (30, 31, 33)}.get(name, PANEL)
    p.d.rectangle([0, 0, p.W, p.H], fill=base)
    p.noise(2.2, seed=sum(ord(c) for c in name))
    if name == 'icp':
        # ICP: black bezel, dark top strip for the override buttons, OFF detents
        p.rect(-P['w'] / 2, -P['h'] / 2, P['w'] / 2, P['h'] / 2, outline=(10, 10, 10), width=0.004)
        p.rect(-0.072, 0.039, 0.072, 0.061, fill=(14, 14, 15))
        p.rect(-0.058, -0.035, 0.032, 0.034, fill=(16, 16, 17))
        for a, b in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            p.screw(a * (P['w'] / 2 - 0.006), b * (P['h'] / 2 - 0.006), 0.0018)
        p.line([(0.071, 0.030), (0.071, 0.016)], LBL, 0.0006)
        p.line([(0.071, 0.002), (0.071, -0.050)], LBL, 0.0006)
    if name == 'cstack':
        p.rect(-0.1, -0.16, 0.1, 0.16, outline=SEAM, width=0.0012)
    if name in ('lcons', 'rcons'):
        # Dzus rails along both edges
        for x in (-P['w'] / 2 + 0.002, P['w'] / 2 - 0.002):
            p.rect(x - 0.002, -P['h'] / 2, x + 0.002, P['h'] / 2, fill=(24, 25, 27))
    for it in P['items']:
        draw_item(p, it)
    return p


def main(names=None):
    os.makedirs(OUT, exist_ok=True)
    CL.build_layout()
    for name, P in CL.PANELS.items():
        if names and name not in names:
            continue
        p = paint_panel(P)
        p.save(os.path.join(OUT, name + '.png'))
        print('[ck art]', name, p.W // SS, 'x', p.H // SS)


if __name__ == '__main__':
    main(sys.argv[1:] or None)
