"""F-16C Block 50 cockpit texture atlas (2048²): instrument panel face with analog standby instruments, side console
switch panels, ICP keypad, MFD/DED/RWR bezels, glareshield, seat fabric.

Run: .venv/bin/python blender/aircraft/f16/cockpit_textures.py  -> assets/aircraft/f16/tex/cockpit_color.png
"""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import f16_cockpit_layout as CL

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(REPO, 'assets', 'aircraft', 'f16', 'tex')
SS = 2                                  # supersampling factor
A = CL.ATLAS * SS
FB = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FR = '/System/Library/Fonts/Supplemental/Arial.ttf'
FN = '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf'
if not os.path.exists(FB):
    FB = FR = FN = '/System/Library/Fonts/Helvetica.ttc'

PANEL = (62, 66, 70)          # FS 36231 dark gull gray (cockpit)
PANEL_D = (44, 47, 50)
BLACK = (14, 14, 15)
WHITE = (232, 232, 226)
LBL = (225, 225, 215)
AMBER = (230, 150, 30)
GREEN = (120, 220, 110)
RED = (200, 35, 30)


def F(size, font=FB):
    return ImageFont.truetype(font, max(6, int(size * SS)))


class Canvas:
    def __init__(self):
        self.im = Image.new('RGB', (A, A), (40, 42, 44))
        self.d = ImageDraw.Draw(self.im)

    def rect_px(self, key):
        x, y, w, h = CL.TEX[key]
        return x * SS, y * SS, w * SS, h * SS


def rng(seed):
    return np.random.default_rng(seed)


# ----------------------------------------------------------------------------------------------------------------------
def noise_fill(im, box, base, amp=6, seed=1):
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    r = rng(seed)
    n = r.normal(0, amp, (h // 8 + 2, w // 8 + 2))
    n = np.kron(n, np.ones((8, 8)))[:h, :w]
    fine = r.normal(0, amp * 0.35, (h, w))
    arr = np.clip(np.array(base, np.float32)[None, None, :] + (n + fine)[..., None], 0, 255).astype(np.uint8)
    im.paste(Image.fromarray(arr, 'RGB'), (x0, y0))


def screw(d, x, y, r):
    d.ellipse([x - r, y - r, x + r, y + r], fill=(88, 92, 95), outline=(30, 30, 32))
    d.line([x - r * 0.7, y, x + r * 0.7, y], fill=(35, 35, 37), width=max(1, int(r * 0.3)))


def dial(d, cx, cy, R, kind):
    """Draw a round analog instrument face (black) with ticks, numerals and needles."""
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=BLACK)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(70, 72, 74), width=max(1, int(R * 0.03)))
    def ticks(n, a0, a1, major_every=1, lab=None, r_in=0.80, lw=1.5, font=0.16):
        for i in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            major = i % major_every == 0
            ri = R * (r_in if major else r_in + 0.08)
            ro = R * 0.93
            d.line([cx + ri * math.sin(a), cy - ri * math.cos(a), cx + ro * math.sin(a), cy - ro * math.cos(a)],
                   fill=WHITE, width=max(1, int(lw * SS * (1.4 if major else 0.8))))
            if lab and major and (i // major_every) < len(lab):
                rl = R * 0.62
                d.text((cx + rl * math.sin(a), cy - rl * math.cos(a)), lab[i // major_every], font=F(R * font / SS * 1.0 * SS / SS), fill=WHITE, anchor='mm')
    def needle(a_deg, L=0.78, w=0.06, col=WHITE):
        a = math.radians(a_deg)
        tip = (cx + R * L * math.sin(a), cy - R * L * math.cos(a))
        tail = (cx - R * 0.18 * math.sin(a), cy + R * 0.18 * math.cos(a))
        nx, ny = math.cos(a) * R * w, math.sin(a) * R * w
        d.polygon([tip, (tail[0] + nx, tail[1] + ny), (tail[0] - nx, tail[1] - ny)], fill=col)
        d.ellipse([cx - R * 0.08, cy - R * 0.08, cx + R * 0.08, cy + R * 0.08], fill=(60, 60, 60))
    f = lambda k: F(R * k / SS)
    if kind == 'adi':
        # attitude ball: sky gray / ground black with pitch ladder
        d.pieslice([cx - R * 0.9, cy - R * 0.9, cx + R * 0.9, cy + R * 0.9], 180, 360, fill=(150, 152, 150))
        d.pieslice([cx - R * 0.9, cy - R * 0.9, cx + R * 0.9, cy + R * 0.9], 0, 180, fill=(25, 25, 25))
        for p in (-20, -10, 10, 20):
            yy = cy - p * R * 0.025
            w = R * (0.30 if abs(p) == 10 else 0.42)
            d.line([cx - w, yy, cx + w, yy], fill=(250, 250, 250) if p < 0 else (20, 20, 20), width=max(1, SS))
        d.line([cx - R * 0.9, cy, cx + R * 0.9, cy], fill=WHITE, width=2 * SS)
        d.polygon([(cx - R * 0.55, cy), (cx - R * 0.2, cy), (cx - R * 0.12, cy + R * 0.1)], fill=(240, 170, 20))
        d.polygon([(cx + R * 0.55, cy), (cx + R * 0.2, cy), (cx + R * 0.12, cy + R * 0.1)], fill=(240, 170, 20))
        ticks(12, -60, 60, 1, None, 0.84)
        d.text((cx, cy + R * 0.72), 'OFF', font=f(0.16), fill=(210, 40, 30), anchor='mm')
    elif kind == 'ehsi':
        for i in range(36):
            a = math.radians(i * 10)
            ri = R * (0.74 if i % 3 == 0 else 0.80)
            d.line([cx + ri * math.sin(a), cy - ri * math.cos(a), cx + R * 0.88 * math.sin(a), cy - R * 0.88 * math.cos(a)], fill=WHITE, width=SS)
        for i, t in enumerate(('N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33')):
            a = math.radians(i * 30)
            d.text((cx + R * 0.60 * math.sin(a), cy - R * 0.60 * math.cos(a)), t, font=f(0.13), fill=WHITE, anchor='mm')
        d.polygon([(cx, cy - R * 0.45), (cx - R * 0.07, cy + R * 0.2), (cx + R * 0.07, cy + R * 0.2)], fill=(250, 200, 40))
        d.line([cx, cy - R * 0.5, cx, cy + R * 0.5], fill=(90, 220, 90), width=2 * SS)
        d.text((cx, cy - R * 0.95), '297', font=f(0.12), fill=WHITE, anchor='mm')
    elif kind == 'asi':
        ticks(16, -150, 150, 2, ['0', '100', '200', '300', '400', '500', '600', '700', '800'], 0.8, font=0.13)
        d.text((cx, cy + R * 0.3), 'KNOTS', font=f(0.10), fill=WHITE, anchor='mm')
        d.text((cx, cy - R * 0.28), 'MACH', font=f(0.09), fill=WHITE, anchor='mm')
        needle(-62)
    elif kind == 'alt':
        ticks(50, 0, 360, 5, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 0.8, lw=1.0, font=0.17)
        d.rectangle([cx - R * 0.35, cy - R * 0.14, cx + R * 0.35, cy + R * 0.14], fill=(20, 20, 20), outline=(90, 90, 90))
        d.text((cx, cy), '02400', font=f(0.17), fill=WHITE, anchor='mm')
        needle(144)
    elif kind == 'vvi':
        ticks(12, -150, 150, 2, ['6', '4', '2', '1', '0', '1', '2'], 0.78, font=0.18)
        d.text((cx - R * 0.35, cy), 'UP', font=f(0.12), fill=WHITE, anchor='mm')
        needle(-90 + 3)
    elif kind == 'aoa':
        d.rectangle([cx - R * 0.18, cy - R * 0.8, cx + R * 0.18, cy + R * 0.8], fill=(24, 24, 24))
        for i in range(9):
            yy = cy - R * 0.7 + i * R * 0.175
            d.line([cx - R * 0.18, yy, cx - R * 0.02, yy], fill=WHITE, width=SS)
        d.rectangle([cx - R * 0.17, cy - R * 0.1, cx + R * 0.17, cy + R * 0.12], fill=(40, 160, 60))
        d.text((cx + R * 0.52, cy), 'AOA', font=f(0.16), fill=WHITE, anchor='mm')
    elif kind == 'fuel':
        ticks(10, -135, 135, 1, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'][::2] and None, 0.8)
        for i, t in enumerate(('0', '2', '4', '6', '8')):
            a = math.radians(-135 + i * 67.5)
            d.text((cx + R * 0.6 * math.sin(a), cy - R * 0.6 * math.cos(a)), t, font=f(0.15), fill=WHITE, anchor='mm')
        d.text((cx, cy + R * 0.42), 'FUEL QTY', font=f(0.11), fill=WHITE, anchor='mm')
        d.rectangle([cx - R * 0.32, cy + R * 0.12, cx + R * 0.32, cy + R * 0.28], fill=(20, 20, 20))
        d.text((cx, cy + R * 0.2), '6400', font=f(0.12), fill=WHITE, anchor='mm')
        needle(40, col=(255, 255, 255)); needle(10, L=0.6, col=(230, 60, 40))
    elif kind in ('ftit', 'rpm', 'noz', 'oil', 'hyd'):
        labs = {'ftit': ['2', '4', '6', '8', '10', '12'], 'rpm': ['0', '2', '4', '6', '8', '10'],
                'noz': ['0', '20', '40', '60', '80', '100'], 'oil': ['0', '20', '40', '60', '80', '100'],
                'hyd': ['0', '1', '2', '3', '4', '5']}[kind]
        ticks(10, -135, 135, 2, labs, 0.82, font=0.20)
        d.text((cx, cy + R * 0.45), kind.upper(), font=f(0.18), fill=WHITE, anchor='mm')
        needle({'ftit': -20, 'rpm': 60, 'noz': -90, 'oil': 20, 'hyd': 70}[kind], L=0.72)
    elif kind == 'clock':
        ticks(12, 0, 360, 1, None, 0.82)
        needle(60, L=0.55); needle(-150, L=0.75, w=0.04)


def switch(d, x, y, s, up=True, guard=False, col=(200, 200, 195)):
    """Top view of a toggle switch with its base nut (drawn as a painted detail)."""
    d.ellipse([x - s, y - s, x + s, y + s], fill=(40, 40, 42), outline=(110, 110, 112), width=max(1, SS))
    ty = y - s * 1.6 if up else y + s * 1.6
    d.line([x, y, x, ty], fill=col, width=max(2, int(s * 0.55)))
    d.ellipse([x - s * 0.35, ty - s * 0.35, x + s * 0.35, ty + s * 0.35], fill=col)
    if guard:
        d.rectangle([x - s * 1.3, y - s * 2.2, x + s * 1.3, y + s * 1.2], outline=(190, 30, 25), width=max(2, SS * 2))


def knob(d, x, y, r, pointer=True):
    d.ellipse([x - r, y - r, x + r, y + r], fill=(18, 18, 19), outline=(80, 80, 82), width=max(1, SS))
    d.ellipse([x - r * 0.62, y - r * 0.62, x + r * 0.62, y + r * 0.62], fill=(34, 34, 36))
    if pointer:
        d.line([x, y, x + r * 0.2, y - r * 0.9], fill=WHITE, width=max(1, int(r * 0.15)))


def label(d, x, y, text, size, fill=LBL, font=FB, anchor='mm'):
    d.text((x, y), text, font=F(size / SS, font), fill=fill, anchor=anchor)


def indicator(d, x, y, w, h, text, col):
    d.rectangle([x - w / 2, y - h / 2, x + w / 2, y + h / 2], fill=(24, 24, 24), outline=(90, 90, 90), width=max(1, SS))
    label(d, x, y, text, h * 0.34, fill=col, font=FN)


# ----------------------------------------------------------------------------------------------------------------------
def draw_panel(cv):
    x0, y0, w, h = cv.rect_px('panel')
    im, d = cv.im, cv.d
    u0, u1 = CL.PANEL_TEX_U
    v0, v1 = CL.PANEL_TEX_V
    k = w / (u1 - u0)
    P = lambda u, v: (x0 + (u - u0) * k, y0 + (v1 - v) * k)
    noise_fill(im, (x0, y0, x0 + w, y0 + h), PANEL, 2.2, 3)
    # sub-panel seams + screws
    seams = [(-0.33, 0.17, -0.105, 0.455), (-0.105, 0.30, 0.105, 0.455), (0.105, 0.17, 0.33, 0.455), (-0.105, 0.0, 0.105, 0.30),
             (-0.25, 0.11, -0.105, 0.17), (0.105, 0.11, 0.25, 0.17)]
    for a, b, c, e in seams:
        p0, p1 = P(a + 0.002, e - 0.002), P(c - 0.002, b + 0.002)
        d.rectangle([p0[0], p0[1], p1[0], p1[1]], outline=(30, 32, 34), width=2 * SS)
        for (uu, vv) in ((a + 0.008, b + 0.008), (c - 0.008, b + 0.008), (a + 0.008, e - 0.008), (c - 0.008, e - 0.008)):
            screw(d, *P(uu, vv), 0.0032 * k)
    # instruments
    for name, (gu, gv, dia) in CL.GAUGES.items():
        cx, cy = P(gu, gv)
        dial(d, cx, cy, dia / 2 * k * 0.97, name)
    # MFD/ICP/DED/RWR areas: dark mounting plates
    for cfg in (CL.MFD_L, CL.MFD_R, CL.DED, CL.RWR):
        (cu, cvv), (bw, bh) = cfg['c'], cfg['bezel']
        p0, p1 = P(cu - bw / 2 - 0.006, cvv + bh / 2 + 0.006), P(cu + bw / 2 + 0.006, cvv - bh / 2 - 0.006)
        d.rectangle([p0[0], p0[1], p1[0], p1[1]], fill=PANEL_D)
    # warning / caution lights (right upper), threat warning prime (left upper under RWR)
    for i, (t, c) in enumerate((('ENG FIRE', RED), ('ENGINE', RED), ('HYD/OIL', RED), ('FLCS', AMBER), ('TO/LG', RED), ('CANOPY', RED))):
        cx, cy = P(0.285 + (i % 2) * 0.0 - 0.0, 0.442 - (i // 2) * 0.0)
    labels_r = [('ENG FIRE', RED), ('ENGINE', RED), ('HYD/OIL PRESS', RED), ('FLCS', AMBER), ('DBU ON', AMBER), ('TO/LDG CONFIG', RED)]
    for i, (t, c) in enumerate(labels_r):
        cx, cy = P(0.268 + (i % 2) * 0.042, 0.440 - (i // 2) * 0.018)
        indicator(d, cx, cy, 0.039 * k, 0.015 * k, t, c)
    labels_l = [('HANDOFF', GREEN), ('LAUNCH', RED), ('MODE', GREEN), ('UNKNOWN', GREEN), ('SYS TEST', GREEN), ('T', GREEN)]
    for i, (t, c) in enumerate(labels_l):
        cx, cy = P(-0.305, 0.44 - i * 0.017)
        indicator(d, cx, cy, 0.034 * k, 0.014 * k, t, c)
    label(d, *P(-0.192, 0.452), 'THREAT WARNING PRIME', 0.008 * k)
    # master arm / laser arm / alt rel switches (upper left, left of the RWR)
    cx, cy = P(-0.268, 0.33)
    label(d, cx, cy - 0.03 * k, 'MASTER ARM', 0.0075 * k)
    switch(d, cx, cy, 0.006 * k, True, guard=True)
    label(d, cx, cy + 0.02 * k, 'SIMULATE   OFF', 0.0055 * k)
    cx, cy = P(-0.268, 0.265)
    label(d, cx, cy - 0.024 * k, 'LASER ARM', 0.0075 * k)
    switch(d, cx, cy, 0.006 * k, False)
    cx, cy = P(-0.3, 0.33)
    label(d, cx, cy - 0.03 * k, 'IFF', 0.007 * k)
    # landing gear panel (lower left around the gear handle)
    gu, gv = CL.GEAR_HANDLE
    cx, cy = P(gu, gv + 0.05)
    label(d, cx, cy, 'LG', 0.009 * k)
    for i, t in enumerate(('NOSE', 'LEFT', 'RIGHT')):
        c2 = P(gu - 0.015 + i * 0.015, gv - 0.075)
        d.polygon([(c2[0], c2[1] - 0.006 * k), (c2[0] - 0.006 * k, c2[1] + 0.005 * k), (c2[0] + 0.006 * k, c2[1] + 0.005 * k)], fill=(40, 170, 60))
        label(d, c2[0], c2[1] + 0.011 * k, t, 0.0045 * k)
    label(d, *P(gu, gv - 0.10), 'DN LOCK REL', 0.005 * k)
    label(d, *P(gu, gv + 0.028), 'UP', 0.007 * k)
    label(d, *P(gu, gv - 0.052), 'DN', 0.007 * k)
    # misc labels
    for (uu, vv, t) in ((-0.078, 0.225, 'AIRSPEED/MACH'), (0.078, 0.225, 'ALTITUDE'), (0.0, 0.305, 'SAI'),
                        (0.0, 0.118, 'HSI'), (0.300, 0.372, 'FTIT'), (0.300, 0.312, 'RPM'), (0.300, 0.252, 'NOZ POS'),
                        (0.300, 0.195, 'OIL'), (0.192, 0.442, 'FUEL'), (-0.075, 0.084, 'CLOCK'), (0.075, 0.084, 'HYD PRESS')):
        label(d, *P(uu, vv), t, 0.0062 * k)
    # lower pedestal: PFLD + fuel/ext lighting small switches
    cx, cy = P(0.0, 0.045)
    d.rectangle([cx - 0.07 * k, cy - 0.022 * k, cx + 0.07 * k, cy + 0.022 * k], fill=(20, 22, 20), outline=(90, 90, 90), width=SS)
    label(d, cx, cy - 0.03 * k, 'PILOT FAULT LIST', 0.006 * k)
    for i in range(3):
        label(d, cx - 0.06 * k, cy - 0.012 * k + i * 0.012 * k, ['FLCS BUS', 'AVIONICS', 'ENGINE'][i], 0.0065 * k, fill=(90, 200, 90), anchor='lm')
    for i in range(5):
        switch(d, *P(-0.21 + i * 0.022, 0.14), 0.004 * k, i % 2 == 0)
        switch(d, *P(0.13 + i * 0.022, 0.14), 0.004 * k, i % 3 == 0)
    label(d, *P(-0.165, 0.160), 'EXT LIGHTING', 0.006 * k)
    label(d, *P(0.175, 0.160), 'FUEL', 0.006 * k)
    # knobs next to the MFDs
    for sg in (-1, 1):
        knob(d, *P(sg * 0.105 + sg * -0.0, 0.200), 0.006 * k)


def draw_console(cv, key, left):
    x0, y0, w, h = cv.rect_px(key)
    im, d = cv.im, cv.d
    noise_fill(im, (x0, y0, x0 + w, y0 + h), PANEL, 2.2, 7 if left else 9)
    k = w / 0.19
    # panels stacked along the console (front at the top of the texture)
    if left:
        names = [('THROTTLE', 0.20), ('TEST', 0.075), ('FLCS', 0.08), ('FUEL', 0.085), ('AUX COMM', 0.09), ('EXT LIGHTING', 0.085),
                 ('EPU', 0.07), ('ENG & JET START', 0.085), ('AUDIO', 0.07)]
    else:
        names = [('SIDESTICK', 0.20), ('SNSR PWR', 0.08), ('HUD', 0.085), ('INTR LIGHT', 0.085), ('AIR COND', 0.08),
                 ('OXYGEN', 0.095), ('ZEROIZE', 0.06), ('AVTR', 0.07), ('KY-58', 0.07)]
    y = y0
    r = rng(21 if left else 22)
    for name, L in names:
        ph = L * k
        d.rectangle([x0 + 3 * SS, y + 2 * SS, x0 + w - 3 * SS, y + ph - 2 * SS], outline=(28, 30, 32), width=2 * SS, fill=(58, 62, 66) if name not in ('THROTTLE', 'SIDESTICK') else PANEL_D)
        if name not in ('THROTTLE', 'SIDESTICK'):
            label(d, x0 + w / 2, y + 0.012 * k, name, 0.0085 * k)
            for (sx, sy) in ((x0 + 8 * SS, y + 8 * SS), (x0 + w - 8 * SS, y + 8 * SS), (x0 + 8 * SS, y + ph - 8 * SS), (x0 + w - 8 * SS, y + ph - 8 * SS)):
                screw(d, sx, sy, 0.0025 * k)
            # switches / knobs grid
            n_rows = max(1, int((L - 0.03) / 0.028))
            for rr in range(n_rows):
                for cc in range(3):
                    cx = x0 + w * (0.22 + cc * 0.28)
                    cy = y + 0.032 * k + rr * 0.028 * k
                    t = r.random()
                    if t < 0.45:
                        switch(d, cx, cy, 0.0042 * k, r.random() < 0.5)
                    elif t < 0.8:
                        knob(d, cx, cy, 0.0065 * k)
                    else:
                        indicator(d, cx, cy, 0.035 * k, 0.012 * k, ['ON', 'OFF', 'NORM', 'MAN', 'BATT'][int(r.random() * 5)], (200, 200, 190))
                    label(d, cx, cy + 0.011 * k, ['PWR', 'NORM', 'OFF', 'TEST', 'AUTO', 'MAIN', 'STBY', 'ON'][int(r.random() * 8)], 0.0045 * k)
        else:
            # throttle quadrant / stick base area: dark with slot outline
            label(d, x0 + w / 2, y + ph - 0.01 * k, 'IDLE          MIL          AB' if left else 'FLCS', 0.006 * k)
            if left:
                d.rectangle([x0 + w * 0.42, y + 0.02 * k, x0 + w * 0.58, y + ph - 0.03 * k], fill=(10, 10, 10))
        y += ph


def draw_icp(cv):
    x0, y0, w, h = cv.rect_px('icp')
    d = cv.d
    noise_fill(cv.im, (x0, y0, x0 + w, y0 + h), (50, 53, 56), 4, 12)
    k = w / 0.150
    # keypad 3x4 on the left
    keys = [['1\nT-ILS', '2\nALOW', '3'], ['4\nSTPT', '5\nCRUS', '6\nTIME'], ['7\nMARK', '8\nFIX', '9\nA-CAL'], ['RCL', '0\nM-SEL', 'ENTR']]
    for r_, row in enumerate(keys):
        for c_, t in enumerate(row):
            cx = x0 + (0.018 + c_ * 0.017) * k
            cy = y0 + (0.016 + r_ * 0.0165) * k
            d.rectangle([cx - 0.0068 * k, cy - 0.0062 * k, cx + 0.0068 * k, cy + 0.0062 * k], fill=(26, 26, 27), outline=(90, 90, 90))
            parts = t.split('\n')
            label(d, cx, cy - (0.002 * k if len(parts) > 1 else 0), parts[0], 0.0052 * k)
            if len(parts) > 1:
                label(d, cx, cy + 0.0032 * k, parts[1], 0.0026 * k)
    # function buttons and rocker on the right
    for i, t in enumerate(('COM1', 'COM2', 'IFF', 'LIST', 'A-A', 'A-G')):
        cx = x0 + (0.083 + (i % 3) * 0.02) * k
        cy = y0 + (0.012 + (i // 3) * 0.015) * k
        d.rectangle([cx - 0.0085 * k, cy - 0.005 * k, cx + 0.0085 * k, cy + 0.005 * k], fill=(26, 26, 27), outline=(90, 90, 90))
        label(d, cx, cy, t, 0.0038 * k)
    knob(d, x0 + 0.090 * k, y0 + 0.058 * k, 0.007 * k)
    knob(d, x0 + 0.120 * k, y0 + 0.058 * k, 0.007 * k)
    label(d, x0 + 0.090 * k, y0 + 0.070 * k, 'SYM', 0.0035 * k)
    label(d, x0 + 0.120 * k, y0 + 0.070 * k, 'BRT', 0.0035 * k)
    d.rectangle([x0 + 0.136 * k, y0 + 0.03 * k, x0 + 0.144 * k, y0 + 0.05 * k], fill=(30, 30, 30), outline=(100, 100, 100))


def draw_bezel(cv, key, kind):
    x0, y0, w, h = cv.rect_px(key)
    d = cv.d
    noise_fill(cv.im, (x0, y0, x0 + w, y0 + h), (36, 38, 40), 3, 14)
    if kind == 'mfd':
        # screen window (dark) in the middle, OSB labels
        m = 0.19
        d.rectangle([x0 + w * m, y0 + h * m, x0 + w * (1 - m), y0 + h * (1 - m)], fill=(5, 5, 6))
        for side in range(4):
            for i in range(5):
                t = (i - 2) * 0.1265 + 0.5
                if side == 0: cx, cy = x0 + w * t, y0 + h * 0.08
                elif side == 1: cx, cy = x0 + w * t, y0 + h * 0.92
                elif side == 2: cx, cy = x0 + w * 0.074, y0 + h * t
                else: cx, cy = x0 + w * 0.926, y0 + h * t
                d.rectangle([cx - w * 0.04, cy - h * 0.033, cx + w * 0.04, cy + h * 0.033], fill=(20, 20, 21), outline=(85, 85, 85))
        for (cx, cy, t) in ((0.06, 0.03, 'GAIN'), (0.94, 0.03, 'SYM'), (0.06, 0.97, 'CON'), (0.94, 0.97, 'BRT')):
            label(d, x0 + w * cx, y0 + h * cy, t, h * 0.028)
    elif kind == 'ded':
        d.rectangle([x0 + w * 0.12, y0 + h * 0.18, x0 + w * 0.88, y0 + h * 0.82], fill=(5, 6, 5))
        label(d, x0 + w * 0.5, y0 + h * 0.09, 'DED', h * 0.08)
    elif kind == 'rwr':
        d.rectangle([x0 + w * 0.13, y0 + h * 0.13, x0 + w * 0.87, y0 + h * 0.87], fill=(5, 5, 6))
        label(d, x0 + w * 0.5, y0 + h * 0.05, 'AZIMUTH IND', h * 0.045)
        knob(d, x0 + w * 0.07, y0 + h * 0.93, w * 0.04)
        knob(d, x0 + w * 0.93, y0 + h * 0.93, w * 0.04)


def draw_glare(cv):
    x0, y0, w, h = cv.rect_px('glare')
    noise_fill(cv.im, (x0, y0, x0 + w, y0 + h), (20, 21, 22), 3, 15)


def draw_seat(cv):
    x0, y0, w, h = cv.rect_px('seat')
    noise_fill(cv.im, (x0, y0, x0 + w, y0 + h), (58, 64, 46), 7, 16)
    d = cv.d
    # quilted cushion seams
    for i in range(1, 8):
        yy = y0 + h * i / 8
        d.line([x0, yy, x0 + w, yy], fill=(40, 44, 32), width=3 * SS)
    for i in range(1, 4):
        xx = x0 + w * i / 4
        d.line([xx, y0, xx, y0 + h], fill=(44, 48, 35), width=2 * SS)


def draw_placard(cv):
    x0, y0, w, h = cv.rect_px('placard')
    noise_fill(cv.im, (x0, y0, x0 + w, y0 + h), (58, 62, 66), 4, 17)


def main():
    os.makedirs(OUT, exist_ok=True)
    cv = Canvas()
    draw_panel(cv)
    draw_console(cv, 'lcons', True)
    draw_console(cv, 'rcons', False)
    draw_icp(cv)
    draw_bezel(cv, 'mfdbezel', 'mfd')
    draw_bezel(cv, 'dedbezel', 'ded')
    draw_bezel(cv, 'rwrbezel', 'rwr')
    draw_glare(cv)
    draw_seat(cv)
    draw_placard(cv)
    im = cv.im.resize((CL.ATLAS, CL.ATLAS), Image.LANCZOS)
    im.save(os.path.join(OUT, 'cockpit_color.png'), optimize=True)
    im.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'cockpit_preview.jpg'), quality=88)
    print('[cockpit tex] saved')


if __name__ == '__main__':
    main()
