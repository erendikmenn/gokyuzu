"""Exterior source maps for the F-22 skin (2-D projection views drawn with PIL; project venv).

Views (world metres -> pixels, PPM px/m):
  top / bot : x in [-7.2, 7.2], s in [-0.2, 19.2]           (image x = +x world, nose at the top)
  side_R    : s in [-0.2, 19.2] (nose on the RIGHT), z in [-1.8, 1.8]
  side_L    : s in [-0.2, 19.2] (nose on the LEFT),  z in [-1.8, 1.8]
  fin_R/L   : chord s in [12.6, 17.6], span h in [-0.4, 3.3] (outboard view; nose on the right for R, left for L)
Per view:  <view>_line.png (panel-line groove), <view>_tape.png (seam / RAM tape), <view>_tone.png (panel tone id,
           128 = none), <view>_shade.png (deliberate coating zones: 128 neutral, >128 lighter RAM edges, <128 darker),
           <view>_mark.png (RGBA markings)
Panel layout and markings follow USAF photos (ref/*.jpg) and the Lockheed 3-view. Markings (MARKINGS) are fictional
and generic by default (tail code "GK", serial AF 26-022, no fin emblem, a generic roundel); real markings are a local
opt-in kept outside git (markings.json["f22"] + plugin markings/f22.py, see blender/common/brand.py).
"""
import os
import sys
import math
import json
import random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(HERE, '..', '..', 'common'))
import brand             # noqa: E402
import oml as O          # noqa: E402
import surfaces as SF    # noqa: E402
import aft as A          # noqa: E402

PPM = 256

# Markings. The repository paints only fictional, generic markings: tail code "GK", serial AF 26-022 (F-22 production
# ended with FY10 airframes), no fin emblem, a generic roundel as wing insignia. Real markings are a local opt-in kept
# outside git (blender/common/brand.py): values in markings.json["f22"] (keys as below), drawing code in the plugin
# markings/f22.py (hooks insignia(size, body) and fin_emblem(size, col), each -> (RGBA image, width in metres)).
MARKINGS = brand.markings('f22', {'tail_code': 'GK', 'serial_fy': '26', 'serial_no': '022'})
MARKINGS_PLUGIN = brand.module('markings/f22.py')

FONT_B = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FONT_N = '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf'
FONT_S = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'


def font(size, kind='b'):
    for p in ({'b': FONT_B, 'n': FONT_N, 's': FONT_S}[kind], FONT_B):
        try:
            return ImageFont.truetype(p, int(size))
        except OSError:
            continue
    return ImageFont.load_default()


VIEWS = {
    'top': dict(a=(-7.2, 7.2), b=(-0.2, 19.2)),
    'bot': dict(a=(-7.2, 7.2), b=(-0.2, 19.2)),
    'side_R': dict(a=(-0.2, 19.2), b=(-1.8, 1.8)),
    'side_L': dict(a=(-0.2, 19.2), b=(-1.8, 1.8)),
    'fin_R': dict(a=(12.6, 17.6), b=(-0.4, 3.3)),
    'fin_L': dict(a=(12.6, 17.6), b=(-0.4, 3.3)),
}


class View:
    def __init__(self, name):
        self.name = name
        v = VIEWS[name]
        self.a0, self.a1 = v['a']
        self.b0, self.b1 = v['b']
        self.W = int(round((self.a1 - self.a0) * PPM))
        self.H = int(round((self.b1 - self.b0) * PPM))
        self.im_line = Image.new('L', (self.W, self.H), 0)
        self.tape = Image.new('L', (self.W, self.H), 0)
        self.tone = Image.new('L', (self.W, self.H), 128)
        self.shade = Image.new('L', (self.W, self.H), 128)
        self.mark = Image.new('RGBA', (self.W, self.H), (0, 0, 0, 0))
        self.dl = ImageDraw.Draw(self.im_line)
        self.dt = ImageDraw.Draw(self.tape)
        self.dn = ImageDraw.Draw(self.tone)
        self.ds = ImageDraw.Draw(self.shade)
        self.dm = ImageDraw.Draw(self.mark)

    def px(self, p):
        a, b = p
        n = self.name
        if n in ('top', 'bot'):
            return ((a - self.a0) * PPM, (b - self.b0) * PPM)
        if n in ('side_R', 'fin_R'):
            return ((self.a1 - a) * PPM, (self.b1 - b) * PPM)
        return ((a - self.a0) * PPM, (self.b1 - b) * PPM)

    def poly(self, pts, tone=None, tape=True, groove=True, tape_w=0.014, groove_w=0.0035, closed=True):
        P = [self.px(p) for p in pts]
        if tone is not None and closed:
            self.dn.polygon(P, fill=int(tone))
        seq = P + [P[0]] if closed else P
        if tape:
            self.dt.line(seq, fill=255, width=max(1, int(tape_w * PPM)), joint='curve')
        if groove:
            self.dl.line(seq, fill=255, width=max(1, int(round(groove_w * PPM))), joint='curve')

    def line(self, pts, groove_w=0.003, tape_w=0.0, strength=255):
        P = [self.px(p) for p in pts]
        if tape_w > 0:
            self.dt.line(P, fill=strength, width=max(1, int(tape_w * PPM)))
        self.dl.line(P, fill=strength, width=max(1, int(round(groove_w * PPM))))

    def shade_poly(self, pts, value):
        self.ds.polygon([self.px(p) for p in pts], fill=int(value))

    def shade_line(self, pts, value, width_m):
        self.ds.line([self.px(p) for p in pts], fill=int(value), width=max(1, int(width_m * PPM)), joint='curve')

    def fill_poly(self, pts, color):
        self.dm.polygon([self.px(p) for p in pts], fill=color)

    def dots(self, pts, r=0.006, fill=(40, 42, 44, 220)):
        for p in pts:
            X, Yp = self.px(p)
            R = r * PPM
            self.dm.ellipse((X - R, Yp - R, X + R, Yp + R), fill=fill)

    def text(self, p, s, size_m, color, angle=0.0, kind='b', mirror=False, spacing=0.0):
        f = font(size_m * PPM * 1.38, kind)
        tmp = Image.new('RGBA', (int(len(s) * size_m * PPM * 1.3 + 60), int(size_m * PPM * 2.4 + 20)), (0, 0, 0, 0))
        d = ImageDraw.Draw(tmp)
        d.text((tmp.width / 2, tmp.height / 2), s, fill=color, font=f, anchor='mm')
        if mirror:
            tmp = tmp.transpose(Image.FLIP_LEFT_RIGHT)
        if angle:
            tmp = tmp.rotate(angle, resample=Image.BICUBIC, expand=True)
        X, Yp = self.px(p)
        self.mark.alpha_composite(tmp, (int(X - tmp.width / 2), int(Yp - tmp.height / 2)))

    def image(self, img, p, width_m, angle=0.0, mirror=False):
        w = int(width_m * PPM)
        h = int(img.height * w / img.width)
        im = img.resize((w, h), Image.LANCZOS)
        if mirror:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        if angle:
            im = im.rotate(angle, resample=Image.BICUBIC, expand=True)
        X, Yp = self.px(p)
        self.mark.alpha_composite(im, (int(X - im.width / 2), int(Yp - im.height / 2)))

    def save(self, out):
        self.im_line.save(os.path.join(out, f'{self.name}_line.png'))
        self.tape.save(os.path.join(out, f'{self.name}_tape.png'))
        self.tone.save(os.path.join(out, f'{self.name}_tone.png'))
        self.shade.filter(ImageFilter.GaussianBlur(2)).save(os.path.join(out, f'{self.name}_shade.png'))
        self.mark.save(os.path.join(out, f'{self.name}_mark.png'))


def saw(p0, p1, n, amp, first=1):
    """Sawtooth polyline p0 -> p1 with n teeth of amplitude amp (left of travel for first=1)."""
    p0, p1 = np.array(p0, float), np.array(p1, float)
    d = p1 - p0
    u = d / np.linalg.norm(d)
    nrm = np.array([-u[1], u[0]]) * first
    pts = [tuple(p0)]
    for k in range(n):
        a = p0 + d * ((k + 0.5) / n) + nrm * amp
        b = p0 + d * ((k + 1) / n)
        pts += [tuple(a), tuple(b)]
    return pts


def sawbox(x0, x1, s0, s1, n=2, amp=0.1, sides='fa'):
    """Door outline (x0..x1, s0..s1) in view coords (a, b) with sawtooth fore / aft edges pointing forward."""
    pts = []
    pts += saw((x0, s0), (x1, s0), n, amp, -1) if 'f' in sides else [(x0, s0), (x1, s0)]
    pts += [(x1, s1)]
    pts += saw((x1, s1), (x0, s1), n, amp, -1)[1:] if 'a' in sides else [(x0, s1)]
    return pts


def sawbox_v(s0, s1, z0, z1, n=2, amp=0.08):
    """Side-view door (s0..s1, z0..z1) with sawtooth fore / aft edges (teeth pointing forward)."""
    fore = saw((s0, z1), (s0, z0), n, amp, 1)
    aft = saw((s1, z0), (s1, z1), n, amp, 1)
    return fore + aft


# ------------------------------------------------------------------------------------------------ insignia
def generic_roundel(size, body):
    """Generic low-visibility roundel (a plain ring, no national emblem): the default insignia. -> (image, width m)"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse((0, 0, size - 1, size - 1), outline=body, width=max(2, size // 12))
    return im, 0.60


def insignia(size, body):
    """Wing insignia (image, width m): the brand plugin's insignia() when present (local opt-in), else generic."""
    if MARKINGS_PLUGIN is not None and hasattr(MARKINGS_PLUGIN, 'insignia'):
        return MARKINGS_PLUGIN.insignia(size, body)
    return generic_roundel(size, body)


def fin_emblem(size, col):
    """Fin emblem (image, width m) from the brand plugin's fin_emblem() (local opt-in), else None: no emblem."""
    if MARKINGS_PLUGIN is not None and hasattr(MARKINGS_PLUGIN, 'fin_emblem'):
        return MARKINGS_PLUGIN.fin_emblem(size, col)
    return None


GRAY_DK = (58, 62, 66, 230)
GRAY_MD = (86, 90, 94, 220)
GRAY_LT = (150, 154, 158, 225)
BLACK = (24, 25, 26, 230)
RED = (160, 38, 30, 225)


def wpt(x, v):
    return (x, O.w_le(x) + v * O.w_chord(x))


def make_all(out):
    rnd = random.Random(1729)
    views = {n: View(n) for n in VIEWS}
    T, B = views['top'], views['bot']

    def tone():
        return rnd.randint(30, 225)

    # =============================================================================== TOP
    for sign in (1, -1):
        m = lambda pts: [(sign * a, b) for (a, b) in pts]
        # radome joint (sawtooth across the nose)
        xc = O.x_ch_fore(2.32)
        T.poly(m(saw((0, 2.32), (xc, 2.32), 3, 0.09, -1)), closed=False, tape_w=0.02)
        # forward equipment bay doors beside the canopy (sawtooth fore / aft)
        T.poly(m(sawbox(0.60, 0.84, 3.00, 4.30, 2, 0.07)), tone=tone())
        T.poly(m(sawbox(0.66, 0.90, 4.45, 5.30, 2, 0.07)), tone=tone())
        # intake bypass / bleed doors on the upper intake (dark slots, Lockheed 3-view)
        for (s0, x0) in ((6.18, 1.02), (6.52, 1.22)):
            slot = [(x0, s0), (x0 + 0.10, s0 - 0.10), (x0 + 0.20, s0 + 0.28), (x0 + 0.10, s0 + 0.38)]
            T.fill_poly(m(slot), (30, 32, 34, 235))
            T.poly(m(slot), tape=True, groove=True)
        T.poly(m(sawbox(0.95, 1.65, 5.95, 7.10, 2, 0.08)), tone=tone())
        # upper fuselage shelves over the ducts
        T.poly(m(sawbox(0.25, 0.60, 7.05, 7.95, 1, 0.06)), tone=tone())
        T.fill_poly(m([(0.33, 7.15), (0.52, 7.15), (0.52, 7.85), (0.33, 7.85)]), (36, 38, 40, 220))    # ECS vent
        T.poly(m(sawbox(0.62, 1.55, 7.6, 9.1, 2, 0.1)), tone=tone())
        T.poly(m(sawbox(1.55, 2.15, 8.3, 9.6, 2, 0.08)), tone=tone())
        # spine grilles (zigzag vents) either side of the refuelling door
        for k in range(3):
            xx = 0.48 + k * 0.14
            T.line(m(saw((xx, 10.05), (xx, 10.75), 4, 0.035, 1)), 0.006, 0.0)
        T.poly(m([(0.44, 10.0), (0.92, 10.0), (0.92, 10.8), (0.44, 10.8)]), tone=tone())
        # engine bay doors (upper aft fuselage)
        T.poly(m(sawbox(0.30, 1.15, 11.2, 12.9, 2, 0.1)), tone=tone())
        T.poly(m(sawbox(0.30, 1.20, 12.9, 13.9, 2, 0.1)), tone=tone())
        T.poly(m(sawbox(1.20, 2.15, 10.2, 12.2, 2, 0.1)), tone=tone())
        T.poly(m(sawbox(1.20, 2.10, 12.5, 14.6, 2, 0.1)), tone=tone())
        # aft deck sawtooth edge (ahead of the nozzle flaps)
        T.line(m(saw((0.02, 15.52), (1.25, 15.52), 3, 0.30, -1)), 0.004, 0.02)
        T.poly(m(sawbox(0.25, 1.20, 14.05, 14.95, 2, 0.08)), tone=tone())
        # wing / body blend seam and wing panels
        T.line(m([(2.20, O.w_le(2.2) + 0.1), (2.20, O.w_te(2.2) - 0.05)]), 0.003, 0.012)
        for (xa, xb, va, vb) in ((2.5, 3.7, 0.12, 0.55), (3.9, 5.1, 0.14, 0.6), (5.2, 6.2, 0.16, 0.62),
                                 (2.4, 3.4, 0.58, 0.78)):
            pts = [wpt(xa, va), wpt(xb, va), wpt(xb, vb), wpt(xa, vb)]
            T.poly(m(pts), tone=tone())
        # diamond access panels (lighter, sawtooth) on the upper wing
        for (x, v) in ((3.1, 0.35), (4.6, 0.36), (3.5, 0.66)):
            c = wpt(x, v)
            dia = [(c[0] - 0.18, c[1]), (c[0], c[1] - 0.14), (c[0] + 0.18, c[1]), (c[0], c[1] + 0.14)]
            T.poly(m(dia), tone=tone())
            T.shade_poly(m(dia), 150)
        # spar / hinge lines
        T.line(m([wpt(2.2, 0.47), wpt(6.5, 0.47)]), 0.0025, 0.0)
        T.line(m([wpt(2.34, 0.058), wpt(O.X_TIP, SF.v_lef(O.X_TIP))]), 0.004, 0.014)
        T.line(m([wpt(2.36, SF.v_hinge(2.36)), wpt(O.X_TIP, SF.v_hinge(O.X_TIP))]), 0.004, 0.014)
        # leading-edge RAM band (lighter)
        T.shade_line(m([(O.X_ROOT, O.w_le(O.X_ROOT) + 0.08), (O.X_TIP, O.w_le(O.X_TIP) + 0.08)]), 168, 0.16)
        T.shade_line(m([(O.X_TIP - 0.05, O.w_le(O.X_TIP)), (O.X_TIP - 0.05, O.W_TIP_TE)]), 160, 0.08)
        # stabilator: LE band, root doubler, pivot panel
        T.shade_line(m([(SF.STAB_X0, SF.stab_le(SF.STAB_X0) + 0.07), (SF.STAB_X1, SF.stab_le(SF.STAB_X1) + 0.07)]), 168, 0.14)
        T.poly(m([(2.0, 16.4), (2.6, 16.2), (2.9, 16.9), (2.3, 17.1)]), tone=tone())
        # nose: chine band lighter
        pts = [(O.x_ch_fore(s) - 0.03, s) for s in np.linspace(0.3, 4.6, 20)]
        T.shade_line(m(pts), 162, 0.07)
    # refuelling receptacle door (centre, sawtooth) + spine panels
    T.poly(sawbox(-0.26, 0.26, 10.0, 10.8, 2, 0.08), tone=tone())
    T.fill_poly([(-0.10, 10.2), (0.10, 10.2), (0.12, 10.55), (-0.12, 10.55)], (40, 42, 44, 200))
    T.poly(sawbox(-0.24, 0.24, 8.4, 9.3, 2, 0.07), tone=tone())
    T.poly(sawbox(-0.22, 0.22, 6.2, 6.9, 1, 0.06), tone=tone())
    T.line([(0.0, 11.0), (0.0, 15.4)], 0.003, 0.01)
    # antennas / lights on the spine
    T.fill_poly([(-0.06, 11.9), (0.06, 11.9), (0.0, 11.75)], (34, 36, 38, 230))
    T.fill_poly([(-0.05, 12.3), (0.05, 12.3), (0.07, 12.55), (0.0, 12.7), (-0.07, 12.55)], (34, 36, 38, 230))
    # gun port door (right wing root, upper) - hexagonal, dark when closed
    gp = [(1.50, 11.25), (1.68, 11.18), (1.84, 11.30), (1.84, 11.52), (1.68, 11.64), (1.50, 11.55)]
    T.poly(gp, tone=tone(), tape_w=0.02)
    T.fill_poly([(1.60, 11.33), (1.74, 11.33), (1.74, 11.47), (1.60, 11.47)], (40, 42, 44, 220))

    # =============================================================================== BOTTOM
    for sign in (1, -1):
        m = lambda pts: [(sign * a, b) for (a, b) in pts]
        xc = O.x_ch_fore(2.32)
        B.poly(m(saw((0, 2.32), (xc, 2.32), 3, 0.09, -1)), closed=False, tape_w=0.02)
        # forward avionics access
        B.poly(m(sawbox(0.05, 0.40, 1.3, 2.1, 1, 0.07)), tone=tone())
        B.poly(m(sawbox(0.30, 0.62, 2.6, 3.5, 1, 0.07)), tone=tone())
        # nose gear doors (outline tape, matches the geometric cut)
        B.poly(m(sawbox(0.0, 0.235, 3.72, 5.82, 1, 0.11)), tape_w=0.018)
        # main weapons bay: two doors per side, sawtooth fore / aft
        B.poly(m(sawbox(0.02, 0.46, 6.55, 10.9, 2, 0.13)), tone=tone())
        B.poly(m(sawbox(0.48, 0.93, 6.55, 10.9, 2, 0.13)), tone=tone())
        B.shade_poly(m(sawbox(0.02, 0.93, 6.55, 10.9, 4, 0.13)), 146)
        # main gear doors (outline tape)
        B.poly(m(sawbox(1.75, 2.90, 10.30, 11.88, 2, 0.14)), tape_w=0.018)
        # aft belly: engine bays, arresting hook
        B.poly(m(sawbox(0.10, 0.62, 11.3, 13.4, 2, 0.1)), tone=tone())
        B.poly(m(sawbox(0.66, 1.30, 11.9, 14.0, 2, 0.1)), tone=tone())
        B.poly(m(sawbox(0.2, 1.1, 14.1, 15.3, 2, 0.1)), tone=tone())
        # lower wing
        for (xa, xb, va, vb) in ((2.6, 3.8, 0.15, 0.55), (4.1, 5.4, 0.18, 0.6), (2.5, 3.2, 0.6, 0.78)):
            B.poly(m([wpt(xa, va), wpt(xb, va), wpt(xb, vb), wpt(xa, vb)]), tone=tone())
        B.line(m([wpt(2.34, 0.058), wpt(O.X_TIP, SF.v_lef(O.X_TIP))]), 0.004, 0.014)
        B.line(m([wpt(2.36, SF.v_hinge(2.36)), wpt(O.X_TIP, SF.v_hinge(O.X_TIP))]), 0.004, 0.014)
        B.shade_line(m([(O.X_ROOT, O.w_le(O.X_ROOT) + 0.08), (O.X_TIP, O.w_le(O.X_TIP) + 0.08)]), 166, 0.16)
        B.shade_line(m([(SF.STAB_X0, SF.stab_le(SF.STAB_X0) + 0.07), (SF.STAB_X1, SF.stab_le(SF.STAB_X1) + 0.07)]), 166, 0.14)
    B.line([(0, 6.55), (0, 10.9)], 0.004, 0.012)
    B.poly(sawbox(-0.12, 0.12, 14.3, 15.3, 1, 0.07), tone=tone())
    B.fill_poly([(-0.04, 13.02), (0.04, 13.02), (0.04, 12.98), (-0.04, 12.98)], (40, 40, 40, 200))

    # =============================================================================== SIDES
    for name in ('side_R', 'side_L'):
        Sv = views[name]
        Sv.poly(saw((2.32, 0.18), (2.32, -0.72), 3, 0.08, 1), closed=False, tape_w=0.02)
        # forward avionics bays (below the chine)
        Sv.poly(sawbox_v(2.55, 3.45, -0.72, -0.26, 2, 0.07), tone=tone())
        Sv.poly(sawbox_v(3.62, 4.45, -0.74, -0.18, 2, 0.07), tone=tone())
        # side weapons bay door (lower nacelle wall behind the intake)
        Sv.poly(sawbox_v(6.95, 9.35, -1.00, -0.30, 2, 0.09), tone=tone())
        Sv.shade_poly(sawbox_v(6.95, 9.35, -1.00, -0.30, 2, 0.09), 110)
        # nacelle / fuselage side panels
        Sv.poly(sawbox_v(9.6, 11.6, -0.95, -0.25, 2, 0.08), tone=tone())
        Sv.poly(sawbox_v(11.9, 13.6, -0.90, -0.20, 2, 0.08), tone=tone())
        Sv.poly(sawbox_v(13.9, 15.5, -0.75, -0.10, 2, 0.08), tone=tone())
        # canopy sill seal and the rescue / jettison stencils
        Sv.text((5.05, 0.47), '→  RESCUE  ←', 0.035, (40, 42, 44, 220), kind='n')
        X, Yp = Sv.px((4.6, 0.52))
        r = 0.05 * PPM
        Sv.dm.polygon([(X, Yp - r), (X - r * 0.9, Yp + r * 0.6), (X + r * 0.9, Yp + r * 0.6)], fill=(170, 40, 34, 230))
        Sv.text((4.6, 0.51), '!', 0.035, (240, 230, 220, 240))
        # small low-vis modex on the nose (last digits of the serial, ref: side_AK_norway)
        Sv.text((2.0, -0.22), MARKINGS['serial_no'], 0.055, GRAY_DK, kind='s')
        # air-data ports
        Sv.dots([(1.55, -0.34), (1.70, -0.34), (1.55, -0.48)], 0.008, (36, 38, 40, 220))
        # static-discharge / service stencils
        for (s, z, t) in ((12.4, -0.55, 'FUEL'), (14.3, -0.4, 'ENG OIL'), (3.0, -0.5, 'AV BAY 1'), (4.05, -0.5, 'AV BAY 2'),
                          (8.2, -0.65, 'NO STEP')):
            Sv.text((s, z), t, 0.024, (46, 48, 50, 200), kind='n')

    # =============================================================================== FINS (outboard faces)
    try:
        from shapely.geometry import Polygon
    except ImportError:
        Polygon = None
    for name in ('fin_R', 'fin_L'):
        F = views[name]

        def fpt(h, v):
            return (SF.fin_le(h) + v * (SF.fin_te(h) - SF.fin_le(h)), h)
        F.line([fpt(SF.RUD_H0, SF.rud_v(SF.RUD_H0)), fpt(SF.RUD_H1, SF.rud_v(SF.RUD_H1))], 0.004, 0.014)
        F.line([fpt(SF.RUD_H0, SF.rud_v(SF.RUD_H0)), fpt(SF.RUD_H0, 1.0)], 0.004, 0.014)
        F.line([fpt(SF.RUD_H1, SF.rud_v(SF.RUD_H1)), fpt(SF.RUD_H1, 1.0)], 0.004, 0.014)
        # the fin tip cap (sawtooth joint)
        F.line(saw(fpt(SF.FIN_H - 0.22, 0.0), fpt(SF.FIN_H - 0.22, 1.0), 3, 0.05, -1), 0.003, 0.012)
        # dark RAM coating inside a lighter border (rounded) - refs: q34_low_220606 (HH), side_AK_norway
        border = []
        for h in np.linspace(0.30, SF.FIN_H - 0.36, 12):
            border.append((SF.fin_le(h) + 0.24, h))
        for h in np.linspace(SF.FIN_H - 0.36, 0.30, 12):
            border.append((SF.fin_te(h) - 0.16, h))
        if Polygon is not None:
            pg = Polygon(border).buffer(-0.22).buffer(0.22)
            border = list(pg.exterior.coords)
        F.shade_poly(border, 96)
        F.shade_line([fpt(h, 0.0) for h in np.linspace(0.0, SF.FIN_H, 10)], 170, 0.16)
        # markings (MARKINGS): fin emblem (local opt-in plugin only), tail code, serial
        em = fin_emblem(360, (150, 154, 158, 210))
        if em is not None:
            F.image(em[0], fpt(2.12, 0.40), em[1])
        F.text(fpt(1.52, 0.40), MARKINGS['tail_code'], 0.40, GRAY_LT, kind='b')
        F.text(fpt(0.95, 0.30), 'AF', 0.075, GRAY_LT, kind='b')
        F.text(fpt(0.87, 0.30), MARKINGS['serial_fy'], 0.075, GRAY_LT, kind='b')
        F.text(fpt(0.92, 0.50), MARKINGS['serial_no'], 0.17, GRAY_LT, kind='b')

    # =============================================================================== insignia (low-vis; generic
    # roundel unless the local markings plugin draws one)
    rd, rw = insignia(420, (66, 70, 74, 225))
    T.image(rd, (-4.8, O.w_le(4.8) + 0.42 * O.w_chord(4.8)), rw)
    B.image(rd, (4.8, O.w_le(4.8) + 0.42 * O.w_chord(4.8)), rw)
    for v in views.values():
        v.save(out)
    meta = {n: dict(VIEWS[n], W=views[n].W, H=views[n].H, ppm=PPM) for n in views}
    with open(os.path.join(out, 'views.json'), 'w') as f:
        json.dump(meta, f, indent=1)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', '..', 'assets', 'aircraft', 'f22', 'src')
    make_all(out)
    print('views written to', out)
