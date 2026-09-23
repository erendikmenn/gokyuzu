"""F-22 cockpit texture sources (project venv: .venv/bin/python blender/aircraft/f22/textures.py [cockpit] [displays]).

Writes into assets/aircraft/f22/src/ (build inputs, not shipped):
  cockpit_art.png   4096^2 art atlas (panel facets with display bezels + labels, ICP, consoles, side walls, seat,
                    placards, colour patches).  The Blender build bakes it (with ambient occlusion / soft interior
                    light) into the shipped cockpit texture.
  disp_*.png        render-only display pages (Cycles renders; the game draws live avionics instead)
Layout (positions of every display, control and label) comes from cklayout.py so art and geometry line up.
"""
import os
import sys
import math
import json
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cklayout as L  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'src')
os.makedirs(OUT, exist_ok=True)

FONTS = {
    'b': '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    'r': '/System/Library/Fonts/Supplemental/Arial.ttf',
    'n': '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf',
    'd': '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf',
}
_fc = {}


def font(size, kind='n'):
    key = (int(size), kind)
    if key not in _fc:
        for p in (FONTS.get(kind), FONTS['b']):
            try:
                _fc[key] = ImageFont.truetype(p, max(6, int(size)))
                break
            except (OSError, TypeError):
                continue
        else:
            _fc[key] = ImageFont.load_default()
    return _fc[key]


CONTROLS = []               # (region, u, v, kind) in region metres -> cockpit_controls.json (3-D knobs/toggles)
LBL = (226, 228, 220)       # placard white (engraved, backlit look)
LBL_DIM = (150, 152, 148)
PANEL = (27, 29, 31)
PANEL2 = (35, 37, 40)
EDGE = (12, 12, 13)


class Region:
    """Draw in metres inside an atlas region: (u, v) with u right, v up, origin bottom-left."""

    def __init__(self, img, name):
        self.name = name
        self.img = img
        self.d = ImageDraw.Draw(img)
        (self.x0, self.y0, self.x1, self.y1), (self.wm, self.hm) = L.ART_REGIONS[name]
        self.sx = (self.x1 - self.x0) / self.wm
        self.sy = (self.y1 - self.y0) / self.hm

    def P(self, u, v):
        return (self.x0 + u * self.sx, self.y1 - v * self.sy)

    def rect(self, u0, v0, u1, v1, fill=None, outline=None, width=1, radius=0):
        a, b = self.P(u0, v1)
        c, e = self.P(u1, v0)
        if radius:
            self.d.rounded_rectangle((a, b, c, e), radius=radius * self.sx, fill=fill, outline=outline, width=width)
        else:
            self.d.rectangle((a, b, c, e), fill=fill, outline=outline, width=width)

    def circle(self, u, v, r, fill=None, outline=None, width=1):
        x, y = self.P(u, v)
        R = r * self.sx
        self.d.ellipse((x - R, y - R, x + R, y + R), fill=fill, outline=outline, width=width)

    def line(self, pts, fill, width_m):
        self.d.line([self.P(*p) for p in pts], fill=fill, width=max(1, int(round(width_m * self.sx))))

    def text(self, u, v, s, h_m, fill=LBL, kind='n', anchor='mm'):
        f = font(h_m * self.sy * 1.35, kind)
        self.d.text(self.P(u, v), s, fill=fill, font=f, anchor=anchor)

    def fill(self, col):
        self.d.rectangle((self.x0, self.y0, self.x1, self.y1), fill=col)


# ------------------------------------------------------------------------------------------------ elements
def fastener(R, u, v, r=0.0032):
    R.circle(u, v, r, fill=(62, 64, 67), outline=(8, 8, 8), width=1)
    x, y = R.P(u, v)
    k = r * R.sx * 0.6
    R.d.line((x - k, y, x + k, y), fill=(12, 12, 12), width=1)


def subpanel(R, u0, v0, u1, v1, tone=PANEL2, fast=True):
    R.rect(u0, v0, u1, v1, fill=tone, outline=EDGE, width=2)
    if fast:
        m = 0.008
        for (u, v) in ((u0 + m, v0 + m), (u1 - m, v0 + m), (u0 + m, v1 - m), (u1 - m, v1 - m)):
            fastener(R, u, v)


def toggle(R, u, v, label, guard=False, pos=None):
    CONTROLS.append((R.name, u, v, 'toggle_g' if guard else 'toggle'))
    R.circle(u, v, 0.0085, fill=(20, 20, 21), outline=(110, 112, 114), width=2)
    R.circle(u, v, 0.0038, fill=(182, 184, 186))
    if guard:
        R.rect(u - 0.014, v - 0.016, u + 0.014, v + 0.016, outline=(190, 40, 34), width=3, radius=0.004)
    R.text(u, v + 0.019, label, 0.0055)
    if pos:
        R.text(u, v - 0.017, pos, 0.0040, LBL_DIM)


def knob(R, u, v, label, r=0.011, ticks=('OFF', '', 'ON')):
    CONTROLS.append((R.name, u, v, 'knob' if r > 0.008 else 'knob_s'))
    rnd = random.Random(hash((u, v)) & 0xffff)
    for k, t in enumerate(ticks):
        a = math.radians(210 - k * 240 / max(1, len(ticks) - 1))
        R.line([(u + r * 1.25 * math.cos(a), v + r * 1.25 * math.sin(a)),
                (u + r * 1.5 * math.cos(a), v + r * 1.5 * math.sin(a))], LBL, 0.0012)
        if t:
            R.text(u + r * 2.2 * math.cos(a), v + r * 2.0 * math.sin(a), t, 0.0036, LBL_DIM)
    R.circle(u, v, r, fill=(16, 16, 17), outline=(70, 72, 74), width=2)
    a = math.radians(rnd.uniform(0, 360))
    R.line([(u, v), (u + r * 0.85 * math.cos(a), v + r * 0.85 * math.sin(a))], (235, 235, 230), 0.0016)
    R.text(u, v + r + 0.013, label, 0.0055)


def button(R, u, v, label, col=(120, 205, 140), w=0.022, h=0.014):
    CONTROLS.append((R.name, u, v, 'button'))
    R.rect(u - w / 2, v - h / 2, u + w / 2, v + h / 2, fill=(20, 21, 22), outline=(96, 98, 100), width=2)
    R.text(u, v, label, h * 0.42, col)


def mfd_bezel(R, u, v, aw, ah, m, osb=True, label=None):
    """Display bezel (the screen itself is a separate mesh): dark frame, white square OSB pads drawn (3-D pads are
    added by cockpit.py at the same positions), rocker switches in the corners."""
    R.rect(u - aw / 2 - m, v - ah / 2 - m, u + aw / 2 + m, v + ah / 2 + m, fill=(20, 21, 22), outline=(52, 54, 56),
           width=3, radius=0.006)
    R.rect(u - aw / 2 - 0.003, v - ah / 2 - 0.003, u + aw / 2 + 0.003, v + ah / 2 + 0.003, fill=(6, 7, 8))
    if osb:
        n = L.OSB_N
        for k in range(n):
            t = (k + 0.5) / n - 0.5
            for (cu, cv) in ((u + t * aw * 0.9, v + ah / 2 + m / 2), (u + t * aw * 0.9, v - ah / 2 - m / 2),
                             (u - aw / 2 - m / 2, v + t * ah * 0.9), (u + aw / 2 + m / 2, v + t * ah * 0.9)):
                R.rect(cu - 0.0065, cv - 0.0065, cu + 0.0065, cv + 0.0065, fill=(238, 238, 232), outline=(40, 40, 40))
        for (cu, cv) in ((u - aw / 2 - m / 2, v + ah / 2 + m / 2), (u + aw / 2 + m / 2, v + ah / 2 + m / 2),
                         (u - aw / 2 - m / 2, v - ah / 2 - m / 2), (u + aw / 2 + m / 2, v - ah / 2 - m / 2)):
            R.circle(cu, cv, 0.006, fill=(210, 210, 204), outline=(30, 30, 30))
    if label:
        R.text(u, v - ah / 2 - m - 0.007, label, 0.0045, LBL_DIM)


def facet_uv(facet, u, w):
    """Facet coordinates -> art-region metres (image x = pilot's left -> right)."""
    u0, u1, w0, w1 = L.facet_range(facet)
    if facet == 'L':
        return (u1 - u, w - w0)
    return (u - u0, w - w0)


# ------------------------------------------------------------------------------------------------ panel
def draw_panels(img):
    for facet, reg in (('C', 'pan_C'), ('L', 'pan_L'), ('R', 'pan_R'), ('K', 'pan_K')):
        R = Region(img, reg)
        R.fill(PANEL)
        u0, u1, w0, w1 = L.facet_range(facet)
        # stress panel breaks + fasteners around the edges
        W, H = u1 - u0, w1 - w0
        R.rect(0.004, 0.004, W - 0.004, H - 0.004, outline=(16, 17, 18), width=3)
        for k in range(int(W / 0.05)):
            fastener(R, 0.02 + k * 0.05, 0.009)
            fastener(R, 0.02 + k * 0.05, H - 0.009)
        for name, (f, u, w, aw, ah) in L.DISPLAYS.items():
            if f != facet:
                continue
            cu, cv = facet_uv(facet, u, w)
            kind = 'pmfd' if 'pmfd' in name else 'ufd' if 'ufd' in name else 'smfd'
            mfd_bezel(R, cu, cv, aw, ah, L.BEZEL[kind], osb=(kind != 'ufd'),
                      label={'screen_ufd_L': 'UFD', 'screen_ufd_R': 'UFD'}.get(name))
        if facet == 'C':
            # ICP recess + master warning / caution lights beside it
            f, u, w, iw, ih, idp = L.ICP
            cu, cv = facet_uv('C', u, w)
            R.rect(cu - iw / 2 - 0.006, cv - ih / 2 - 0.006, cu + iw / 2 + 0.006, cv + ih / 2 + 0.006, fill=(10, 10, 11))
            for sx in (-1, 1):
                bu = cu + sx * 0.118
                bv = cv + 0.068
                for k, (lab, col) in enumerate((('MASTER\nWARN', (190, 30, 26)), ('MASTER\nCAUT', (210, 140, 20)))):
                    uu = bu + (k - 0.5) * 0.026
                    R.rect(uu - 0.011, bv - 0.008, uu + 0.011, bv + 0.008, fill=col, outline=(10, 10, 10), width=2)
                    R.text(uu, bv, lab.split('\n')[1], 0.0034, (250, 240, 230), 'b')
            R.text(cu, cv - ih / 2 - 0.012, 'ICP', 0.004, LBL_DIM)
        if facet == 'L':
            # outboard of the UFD: master arm, fire / overheat, emergency jettison (art x = WING_W - u')
            subpanel(R, 0.008, 0.30, 0.165, 0.468)
            toggle(R, 0.04, 0.425, 'MASTER ARM', guard=True, pos='ARM SIM OFF')
            toggle(R, 0.12, 0.425, 'ALT FLAPS', pos='EXT NORM')
            button(R, 0.04, 0.365, 'FIRE', (240, 60, 50), 0.03, 0.018)
            button(R, 0.085, 0.365, 'OVHT', (240, 160, 40), 0.03, 0.018)
            button(R, 0.13, 0.365, 'APU', (240, 160, 40), 0.03, 0.018)
            R.text(0.07, 0.335, 'EMER JETT', 0.0045)
            R.rect(0.05, 0.305, 0.09, 0.325, fill=(170, 28, 24), outline=(8, 8, 8), width=2)
            # landing gear panel: vertical strip outboard of the SMFD
            subpanel(R, 0.004, 0.0, 0.078, 0.25)
            R.text(0.041, 0.235, 'LDG GEAR', 0.0045)
            R.text(0.041, 0.19, 'DN', 0.0045)
            R.text(0.041, 0.015, 'UP', 0.0045)
            for k, t in enumerate(('NOSE', 'LEFT', 'RIGHT')):
                R.circle(0.02 + k * 0.02, 0.215, 0.0045, fill=(40, 170, 70), outline=(8, 8, 8))
        if facet == 'R':
            f, u, w, aw, ah = L.SFD
            cu, cv = facet_uv('R', u, w)
            R.rect(cu - aw / 2 - 0.012, cv - ah / 2 - 0.012, cu + aw / 2 + 0.012, cv + ah / 2 + 0.012, fill=(20, 21, 22),
                   outline=(52, 54, 56), width=3, radius=0.005)
            R.text(cu, cv - ah / 2 - 0.018, 'SFD', 0.0045, LBL_DIM)
            subpanel(R, 0.135, 0.398, 0.295, 0.472)
            knob(R, 0.17, 0.428, 'HUD', 0.008, ('OFF', 'NIGHT', 'DAY'))
            knob(R, 0.26, 0.428, 'BRT', 0.008, ('', '', ''))
            button(R, 0.215, 0.43, 'CLK', (200, 200, 190), 0.026, 0.014)
            subpanel(R, 0.225, 0.0, 0.298, 0.235)
            toggle(R, 0.262, 0.19, 'ANTI SKID', pos='ON OFF')
            toggle(R, 0.262, 0.115, 'HOOK', guard=True)
            toggle(R, 0.262, 0.04, 'LAND/TAXI', pos='LDG OFF TAXI')
        if facet == 'K':
            R.text(0.035, 0.02, 'CLOCK', 0.0045, LBL_DIM)


def draw_icp(img):
    R = Region(img, 'icp')
    R.fill((22, 23, 25))
    W, H = L.ICP[3], L.ICP[4]
    R.rect(0.002, 0.002, W - 0.002, H - 0.002, outline=(70, 72, 74), width=4, radius=0.006)
    # top row: 9 function keys (COM1 COM2 NAV STPT A/P IFF MRK SWAP ...)
    top = ['COM\n1', 'COM\n2', 'NAV', 'STPT', 'A/P', 'IFF', 'LIST', 'MRK', 'SWAP']
    kw = 0.0165
    for k, t in enumerate(top):
        u = 0.011 + k * (W - 0.022) / 8
        v = H - 0.016
        R.rect(u - kw / 2, v - kw / 2, u + kw / 2, v + kw / 2, fill=(236, 236, 228), outline=(30, 30, 30), width=2,
               radius=0.0015)
        for j, ln in enumerate(t.split('\n')):
            R.text(u, v + (0.0035 if '\n' in t else 0) - j * 0.007, ln, 0.0033, (18, 18, 18), 'b')
    # left: 3 x 4 keypad
    keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'RCL', '0', 'ENT']
    for k, t in enumerate(keys):
        u = 0.018 + (k % 3) * 0.024
        v = H - 0.043 - (k // 3) * 0.022
        R.rect(u - kw / 2, v - kw / 2 + 0.001, u + kw / 2, v + kw / 2 - 0.001, fill=(236, 236, 228),
               outline=(30, 30, 30), width=2, radius=0.0015)
        R.text(u, v, t, 0.0055 if len(t) < 2 else 0.0035, (18, 18, 18), 'b')
    # right: 5 rows of round select buttons + green data windows (scratchpad lines)
    lines = ['UHF1  243.000', 'UHF2  251.250', 'TCN   35X  A/A', 'IFF M3  4211', 'ALT   11500']
    for k, t in enumerate(lines):
        v = H - 0.043 - k * 0.0175
        R.circle(0.093, v, 0.0058, fill=(236, 236, 228), outline=(30, 30, 30), width=2)
        R.rect(0.104, v - 0.0065, W - 0.012, v + 0.0065, fill=(20, 70, 34), outline=(10, 10, 10), width=2)
        R.text(0.106, v, t, 0.0055, (140, 255, 150), 'd', anchor='lm')
    # rocker + brightness knob
    R.circle(W - 0.008, 0.012, 0.005, fill=(16, 16, 17), outline=(90, 90, 92))


def draw_sfd(img):
    """Standby flight display face (static page: attitude ball, airspeed / altitude tapes)."""
    R = Region(img, 'sfd')
    W, H = L.SFD[3], L.SFD[4]
    R.fill((6, 8, 10))
    cx, cy = W / 2, H / 2 + 0.004
    x0, y0 = R.P(0.008, H - 0.008)
    x1, y1 = R.P(W - 0.008, 0.008)
    hy = R.P(0, cy)[1]
    R.d.rectangle((x0, y0, x1, hy), fill=(30, 110, 210))
    R.d.rectangle((x0, hy, x1, y1), fill=(125, 80, 40))
    R.line([(0.012, cy), (W - 0.012, cy)], (240, 240, 240), 0.0008)
    for k in (-2, -1, 1, 2):
        R.line([(cx - 0.006 * (2 if k % 2 == 0 else 1), cy + k * 0.006), (cx + 0.006 * (2 if k % 2 == 0 else 1), cy + k * 0.006)],
               (240, 240, 240), 0.0005)
    R.line([(cx - 0.016, cy), (cx - 0.006, cy), (cx - 0.004, cy - 0.003)], (255, 220, 40), 0.0012)
    R.line([(cx + 0.016, cy), (cx + 0.006, cy), (cx + 0.004, cy - 0.003)], (255, 220, 40), 0.0012)
    R.rect(0.002, cy - 0.005, 0.017, cy + 0.005, fill=(0, 0, 0), outline=(230, 230, 230))
    R.text(0.0095, cy, '312', 0.0035, (240, 240, 240), 'd')
    R.rect(W - 0.02, cy - 0.005, W - 0.002, cy + 0.005, fill=(0, 0, 0), outline=(230, 230, 230))
    R.text(W - 0.011, cy, '11500', 0.003, (240, 240, 240), 'd')
    R.text(cx, H - 0.006, '330  000  030', 0.0028, (240, 240, 240), 'd')


def draw_console(img, reg, side):
    """Console top: u along s (front -> back), v across (inboard -> outboard for the right, mirrored for the left)."""
    R = Region(img, reg)
    R.fill((30, 32, 34))
    Wm, Hm = R.wm, R.hm
    rnd = random.Random(11 if side == 'L' else 23)
    if side == 'L':
        # left console: throttle quadrant forward, then COMM/AUDIO, ENG START / APU, FUEL, LIGHTS, OXY
        s0 = L.THR_SLOT_S[0] - L.CON_S[0]
        s1 = L.THR_SLOT_S[1] - L.CON_S[0]
        v_thr = abs(L.THROTTLE[0]) - L.CON_X[0]
        subpanel(R, s0 - 0.04, 0.01, s1 + 0.04, Hm - 0.01, (26, 27, 29))
        R.rect(s0, v_thr - 0.022, s1, v_thr + 0.022, fill=(6, 6, 7), outline=(80, 82, 84), width=3)
        for k in range(9):
            uu = s0 + (s1 - s0) * k / 8
            R.line([(uu, v_thr + 0.026), (uu, v_thr + 0.034)], LBL, 0.0012)
        for uu, t in ((s0 + 0.01, 'MAX AB'), (s0 + (s1 - s0) * 0.35, 'MIL'), (s1 - 0.02, 'IDLE'), (s1 + 0.025, 'OFF')):
            R.text(uu, v_thr + 0.045, t, 0.0055)
        R.text((s0 + s1) / 2, 0.02, 'THROTTLES', 0.006)
        panels = [
            (s1 + 0.05, 'ENGINE', [('t', 'ENG 1', 'START'), ('t', 'ENG 2', 'START'), ('k', 'APU', None), ('t', 'JFS', 'ARM')]),
            (s1 + 0.20, 'FUEL', [('t', 'BOOST', 'ON'), ('k', 'TANK SEL', None), ('t', 'AR DOOR', 'OPEN'), ('b', 'DUMP', None)]),
            (s1 + 0.35, 'EXT LIGHTS', [('k', 'FORM', None), ('t', 'ANTI COLL', 'ON'), ('t', 'POS', 'STDY'), ('k', 'NVIS', None)]),
            (s1 + 0.50, 'OXYGEN', [('t', 'OBOGS', 'ON'), ('b', 'BIT', None), ('k', 'CONC', None)]),
        ]
    else:
        v_st = L.STICK[0] - L.CON_X[0]
        sc = L.STICK[1] - L.CON_S[0]
        subpanel(R, sc - 0.09, 0.01, sc + 0.09, Hm - 0.01, (26, 27, 29))
        R.circle(sc, v_st, 0.042, fill=(10, 10, 11), outline=(70, 72, 74), width=3)
        R.text(sc, 0.02, 'SIDESTICK CONTROLLER', 0.005)
        panels = [
            (0.005, 'FLCS', [('t', 'FLCS', 'RESET'), ('b', 'BIT', None), ('t', 'MAN PITCH', 'OVRD')]),
            (sc + 0.11, 'ECS', [('k', 'TEMP', None), ('t', 'DEFOG', 'ON'), ('k', 'CABIN', None), ('t', 'ANTI-ICE', 'ON')]),
            (sc + 0.27, 'SENSORS', [('t', 'RADAR', 'OPR'), ('t', 'EW', 'OPR'), ('t', 'CNI', 'OPR'), ('k', 'IFF', None)]),
            (sc + 0.43, 'INT LIGHTS', [('k', 'CONSOLE', None), ('k', 'FLOOD', None), ('k', 'INST', None)]),
            (sc + 0.57, 'ELECT', [('t', 'MAIN PWR', 'BATT'), ('t', 'GEN 1', 'ON'), ('t', 'GEN 2', 'ON')]),
        ]
    for (u0, title, items) in panels:
        w = 0.14
        if u0 + w > Wm - 0.005:
            continue
        subpanel(R, u0, 0.012, u0 + w, Hm - 0.012)
        R.text(u0 + w / 2, Hm - 0.022, title, 0.0065)
        n = len(items)
        for k, (kind, lab, pos) in enumerate(items):
            uu = u0 + w * (k % 2 + 0.5) / 2
            vv = Hm - 0.07 - (k // 2) * 0.075
            if kind == 't':
                toggle(R, uu, vv, lab, guard=(rnd.random() < 0.25), pos=pos)
            elif kind == 'k':
                knob(R, uu, vv, lab)
            else:
                button(R, uu, vv, lab)


def draw_walls(img):
    for reg in ('wall_L', 'wall_R'):
        R = Region(img, reg)
        R.fill((42, 45, 48))
        rnd = random.Random(7 if reg == 'wall_L' else 9)
        u = 0.02
        while u < R.wm - 0.1:
            w = rnd.uniform(0.18, 0.34)
            subpanel(R, u, 0.03, min(u + w, R.wm - 0.02), R.hm - 0.05, (46, 49, 52) if rnd.random() < 0.6 else (38, 40, 43))
            if rnd.random() < 0.5:
                R.text(u + w / 2, R.hm - 0.08, rnd.choice(['CIRCUIT BREAKERS', 'MAP CASE', 'DATA TRANSFER',
                                                              'FLOOD LIGHT', 'BATTERY', 'G-SUIT']), 0.006)
            u += w + 0.02
        # circuit-breaker rows on some panels
        u = 0.06
        while u < R.wm - 0.3:
            if rnd.random() < 0.45:
                for row in range(3):
                    for k in range(8):
                        cu, cv = u + k * 0.022, 0.09 + row * 0.07
                        R.circle(cu, cv, 0.0055, fill=(12, 12, 12), outline=(90, 92, 94))
                        R.text(cu, cv + 0.014, rnd.choice(['FCS', 'CNI', 'IFF', 'ECS', 'HUD', 'LTS', 'GEN', 'OBOGS', 'TRIM']),
                               0.0035)
            u += 0.34
        if reg == 'wall_R':
            R.text(1.05, R.hm - 0.03, 'CANOPY', 0.007)


def draw_misc(img):
    R = Region(img, 'seat')
    R.fill((66, 72, 58))
    for k in range(0, 13):
        R.line([(0, k * 0.04), (R.wm, k * 0.04)], (52, 57, 46), 0.004)
    for k in range(0, 9):
        R.line([(k * 0.06, 0), (k * 0.06, R.hm)], (58, 63, 50), 0.003)
    R = Region(img, 'headbox')
    R.fill((60, 66, 54))
    R.rect(0.04, 0.16, R.wm - 0.04, 0.29, fill=(18, 18, 18))
    R.text(R.wm / 2, 0.26, 'WARNING', 0.018, (236, 190, 30), 'b')
    R.text(R.wm / 2, 0.225, 'EJECTION SEAT', 0.012, (230, 230, 220), 'b')
    R.text(R.wm / 2, 0.195, 'ACES II', 0.012, (230, 230, 220), 'b')
    R.rect(0.01, 0.01, R.wm - 0.01, R.hm - 0.01, outline=(40, 44, 36), width=5)
    # yellow / black stripes
    x0, y0, x1, y1 = L.ART_REGIONS['stripe'][0]
    st = Image.new('RGB', (x1 - x0, y1 - y0), (18, 18, 18))
    sd = ImageDraw.Draw(st)
    for k in range(-80, x1 - x0 + 80, 64):
        sd.polygon([(k, y1 - y0), (k + 32, y1 - y0), (k + 32 + 80, 0), (k + 80, 0)], fill=(230, 184, 26))
    img.paste(st, (x0, y0))
    R = Region(img, 'canopy_sw')
    R.fill((24, 25, 27))
    R.rect(0.004, 0.004, R.wm - 0.004, R.hm - 0.004, outline=(220, 220, 214), width=4)
    R.text(0.03, 0.07, 'CANOPY', 0.009, LBL, 'b')
    R.text(0.03, 0.055, 'SWITCH', 0.009, LBL, 'b')
    for k, t in enumerate(('UP', 'HOLD', 'DOWN')):
        R.text(0.08, 0.08 - k * 0.025, t, 0.007)
    R.line([(0.06, 0.03), (0.06, 0.085)], LBL, 0.001)
    for reg, col, seed in (('glare', (16, 17, 18), 1), ('deck', (34, 36, 38), 2), ('floor', (40, 42, 44), 3),
                           ('bulk', (44, 47, 50), 4)):
        R = Region(img, reg)
        R.fill(col)
        rnd = random.Random(seed)
        # crinkle / non-slip grain
        for k in range(1800):
            u, v = rnd.uniform(0, R.wm), rnd.uniform(0, R.hm)
            c = max(0, min(255, col[0] + rnd.randint(-6, 6)))
            R.circle(u, v, 0.002, fill=(c, c + 1, c + 2))
        if reg in ('deck', 'bulk', 'floor'):
            for k in range(4):
                fastener(R, 0.05 + k * 0.12, 0.03)
                fastener(R, 0.05 + k * 0.12, R.hm - 0.03)


def make_cockpit_art():
    CONTROLS.clear()
    img = Image.new('RGB', (L.ART, L.ART), (30, 32, 34))
    draw_panels(img)
    draw_icp(img)
    draw_sfd(img)
    draw_console(img, 'lcon', 'L')
    draw_console(img, 'rcon', 'R')
    draw_walls(img)
    draw_misc(img)
    d = ImageDraw.Draw(img)
    for name, col in L.PATCHES.items():
        x0, y0, x1, y1 = L.patch_rect(name)
        d.rectangle((x0 - 8, y0 - 8, x1 + 8, y1 + 8), fill=col)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    img.save(os.path.join(OUT, 'cockpit_art.png'))
    x0, y0, x1, y1 = L.ART_REGIONS['sfd'][0]
    img.crop((x0, y0, x1, y1)).resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'disp_sfd.png'))
    with open(os.path.join(OUT, 'cockpit_controls.json'), 'w') as f:
        json.dump(CONTROLS, f)


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
        im = Image.new('RGB', (size, size), (4, 6, 9))
        d = ImageDraw.Draw(im)
        cx, cy = size / 2, size * 0.66
        for r in (0.2, 0.4, 0.6):
            R = r * size
            d.arc((cx - R, cy - R, cx + R, cy + R), 0, 360, fill=(40, 60, 170), width=3)
        d.polygon([(cx - 150, cy - 520), (cx + 150, cy - 520), (cx + 30, cy - 40), (cx - 30, cy - 40)], outline=W_)
        d.polygon([(cx, cy - 26), (cx - 16, cy + 18), (cx, cy + 8), (cx + 16, cy + 18)], fill=W_)
        for (x, y, col) in ((0.36, 0.34, C_), (0.58, 0.28, C_), (0.52, 0.46, G_), (0.3, 0.2, R_)):
            X, Yp = x * size, y * size
            d.polygon([(X, Yp + 18), (X - 14, Yp - 10), (X + 14, Yp - 10)], outline=col, width=3)
            d.line((X, Yp - 10, X, Yp - 40), fill=col, width=3)
        d.text((60, 40), '349/111 BE', fill=(255, 80, 230), font=font(34))
        d.text((size - 180, 60), '80', fill=W_, font=font(40))
        d.rectangle((2, 2, size - 3, size - 3), outline=(40, 50, 60), width=4)
        return im

    def sms(size=768):
        im = Image.new('RGB', (size, size), (4, 6, 8))
        d = ImageDraw.Draw(im)
        d.text((size * 0.08, 60), 'MENU', fill=G_, font=font(34))
        d.rectangle((size * 0.28, size * 0.34, size * 0.72, size * 0.42), outline=G_, width=3)
        d.text((size * 0.31, size * 0.35), 'AIM-120C--READY', fill=G_, font=font(34))
        d.polygon([(size * 0.2, size * 0.6), (size * 0.5, size * 0.52), (size * 0.8, size * 0.6), (size * 0.5, size * 0.72)],
                  outline=G_)
        for k in range(6):
            x = size * (0.32 + k * 0.07)
            d.rectangle((x, size * 0.58, x + 26, size * 0.64), outline=G_, width=2)
        d.text((size * 0.06, size * 0.86), 'AUTO\nUNCAGE', fill=G_, font=font(26))
        d.text((size * 0.8, size * 0.86), 'EXCH\nPROG', fill=G_, font=font(26))
        d.rectangle((2, 2, size - 3, size - 3), outline=(40, 50, 60), width=4)
        return im

    def ufd(w=384, h=512):
        im = Image.new('RGB', (w, h), (3, 7, 5))
        d = ImageDraw.Draw(im)
        lines = ['COM1  243.000', 'COM2  251.250', 'NAV   TCN 35X', 'IFF   M3 4211', 'FUEL  18.2', 'BINGO 5.0',
                 '* ICAW CLEAR *']
        for k, t in enumerate(lines):
            d.text((20, 24 + k * 64), t, fill=G_ if k < 6 else Y_, font=font(40))
        return im

    def hud(w=1024, h=900):
        im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        g = (80, 255, 120, 255)
        cx, cy = w / 2, h * 0.42
        for k in range(-3, 4):
            Yp = cy + k * 120
            if k == 0:
                d.line((cx - 330, Yp, cx - 60, Yp), fill=g, width=4)
                d.line((cx + 60, Yp, cx + 330, Yp), fill=g, width=4)
                continue
            for L_ in [(cx - 220, Yp, cx - 90, Yp), (cx + 90, Yp, cx + 220, Yp)]:
                d.line(L_, fill=g, width=3)
            d.text((cx - 280, Yp - 14), f'{-k * 5}', fill=g, font=font(28))
        d.ellipse((cx - 20, cy + 40, cx + 20, cy + 80), outline=g, width=4)
        d.line((cx - 50, cy + 60, cx - 20, cy + 60), fill=g, width=4)
        d.line((cx + 20, cy + 60, cx + 50, cy + 60), fill=g, width=4)
        d.line((cx, cy + 40, cx, cy + 18), fill=g, width=4)
        d.rectangle((60, cy - 30, 200, cy + 30), outline=g, width=4)
        d.text((80, cy - 22), '412', fill=g, font=font(44))
        d.rectangle((w - 230, cy - 30, w - 60, cy + 30), outline=g, width=4)
        d.text((w - 212, cy - 22), '12450', fill=g, font=font(44))
        for k in range(-5, 6):
            X = cx + k * 70
            d.line((X, 60, X, 80 if k % 2 else 95), fill=g, width=3)
            if k % 2 == 0:
                d.text((X - 18, 100), f'{(29 + k // 2) % 36:02d}', fill=g, font=font(30))
        d.text((60, h - 120), 'G 1.2', fill=g, font=font(34))
        d.text((w - 220, h - 120), 'M 0.72', fill=g, font=font(34))
        return im

    tsd().save(os.path.join(out, 'disp_pmfd.png'))
    sms().save(os.path.join(out, 'disp_smfd.png'))
    ufd().save(os.path.join(out, 'disp_ufd.png'))
    hud().save(os.path.join(out, 'disp_hud.png'))


if __name__ == '__main__':
    what = sys.argv[1:] or ['cockpit', 'displays']
    if 'cockpit' in what:
        make_cockpit_art()
        print('cockpit art written')
    if 'displays' in what or 'cockpit' in what:
        make_display_pages()
        print('display pages written')
