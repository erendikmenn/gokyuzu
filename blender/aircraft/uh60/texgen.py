"""UH-60M hull texture generator (run with the repo venv python, called by build.py).

    python texgen.py <cache_dir> <out_dir> [--size 4096]

Inputs (from bake.py, Blender pixel order: row 0 = v 0 = bottom): pos.npy / nrm.npy (G-frame world position and normal
per texel), ao.npy, mask.npy. Outputs: hull_base.jpg (sRGB), hull_orm.jpg (R = AO, G = roughness, B = metal),
hull_nrm.jpg (tangent-space, OpenGL / +Y), plus debug sheets. Everything is derived from the 3D position of the texel,
so panel lines, stencils and weathering are continuous across UV seams. Boom markings (MARKINGS) are fictional by
default; a real airframe's serial and the service title are a local opt-in in markings.json["uh60"]
(blender/common/brand.py).
"""
import os
import sys
import math
import time
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'common'))
import brand  # noqa: E402

CACHE, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
T0 = time.time()


def log(*a):
    print(f'[texgen {time.time() - T0:5.1f}s]', *a, flush=True)


FONT_DIR = '/System/Library/Fonts/Supplemental/'
F_STENCIL = FONT_DIR + 'DIN Condensed Bold.ttf'
F_NARROW = FONT_DIR + 'Arial Narrow Bold.ttf'
F_NARROW_R = FONT_DIR + 'Arial Narrow.ttf'


def font(path, px):
    return ImageFont.truetype(path, max(6, int(px)))


# ------------------------------------------------------------------------------------------------------------ sheets
PPM = 400.0          # sheet pixels per metre
SS = 2               # supersampling for drawing
Y0, Y1 = -11.3, 5.1  # fore/aft extent
Z0, Z1 = -0.2, 4.3
X0, X1 = -2.7, 2.7


class Sheet:
    """A planar projection sheet. kind: 'R' (right side, u=y), 'L' (left side, u=-y), 'T' (top, u=x v=y), 'B' (bottom, u=-x)."""

    def __init__(self, kind):
        self.kind = kind
        if kind in 'RL':
            self.W, self.H = int((Y1 - Y0) * PPM), int((Z1 - Z0) * PPM)
        else:
            self.W, self.H = int((X1 - X0) * PPM), int((Y1 - Y0) * PPM)
        s = SS
        self.panel = Image.new('L', (self.W * s, self.H * s), 255)     # 0 = seam groove
        self.rivet = Image.new('L', (self.W * s, self.H * s), 0)       # 255 = rivet head
        self.decal = Image.new('RGBA', (self.W * s, self.H * s), (0, 0, 0, 0))
        self.wear = Image.new('L', (self.W * s, self.H * s), 0)        # 255 = scuffed / worn paint
        self.emit = Image.new('L', (self.W * s, self.H * s), 0)        # 255 = electroluminescent formation light
        self.dp = ImageDraw.Draw(self.panel)
        self.dr = ImageDraw.Draw(self.rivet)
        self.dd = ImageDraw.Draw(self.decal)
        self.dw = ImageDraw.Draw(self.wear)
        self.de = ImageDraw.Draw(self.emit)

    # metres -> supersampled pixel
    def px(self, a, b):
        s = SS * PPM
        if self.kind == 'R':
            return ((a - Y0) * s, (Z1 - b) * s)          # a = y, b = z
        if self.kind == 'L':
            return ((Y1 - a) * s, (Z1 - b) * s)
        if self.kind == 'T':
            return ((a - X0) * s, (Y1 - b) * s)          # a = x, b = y
        return ((X1 - a) * s, (Y1 - b) * s)              # bottom: mirrored

    def m(self, d):
        return d * SS * PPM

    # --- drawing primitives (coordinates in metres)
    def seam(self, pts, w=0.0034, closed=False):
        p = [self.px(*q) for q in pts]
        if closed:
            p = p + [p[0]]
        self.dp.line(p, fill=0, width=max(1, int(round(self.m(w)))), joint='curve')

    def rect_seam(self, a0, b0, a1, b1, r=0.03, w=0.0034):
        p0, p1 = self.px(a0, b0), self.px(a1, b1)
        box = [min(p0[0], p1[0]), min(p0[1], p1[1]), max(p0[0], p1[0]), max(p0[1], p1[1])]
        self.dp.rounded_rectangle(box, radius=self.m(r), outline=0, width=max(1, int(round(self.m(w)))))

    def rivets(self, pts, pitch=0.036, r=0.0032, offset=0.0):
        """Rivet row along a polyline."""
        for (a0, b0), (a1, b1) in zip(pts[:-1], pts[1:]):
            L = math.hypot(a1 - a0, b1 - b0)
            n = max(1, int(L / pitch))
            for k in range(n + 1):
                t = k / n
                a, b = a0 + (a1 - a0) * t, b0 + (b1 - b0) * t
                if offset:
                    # offset perpendicular to the row
                    nx, ny = -(b1 - b0) / L, (a1 - a0) / L
                    a, b = a + nx * offset, b + ny * offset
                x, y = self.px(a, b)
                rr = self.m(r)
                self.dr.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)

    def rect_rivets(self, a0, b0, a1, b1, inset=0.018, pitch=0.04):
        pts = [(a0 + inset, b0 + inset), (a1 - inset, b0 + inset), (a1 - inset, b1 - inset), (a0 + inset, b1 - inset), (a0 + inset, b0 + inset)]
        self.rivets(pts, pitch)

    def text(self, a, b, s, h, fnt=F_NARROW, fill=(18, 18, 16, 235), anchor='mm', spacing=0.0, rot=0):
        """Text centred at (a, b) metres, cap height h metres."""
        f = font(fnt, self.m(h) * 1.38)
        x, y = self.px(a, b)
        if rot == 0:
            self.dd.text((x, y), s, font=f, fill=fill, anchor=anchor)
        else:
            tw = int(f.getlength(s)) + 20
            th = int(self.m(h) * 2.2) + 20
            im = Image.new('RGBA', (tw, th), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((tw / 2, th / 2), s, font=f, fill=fill, anchor='mm')
            im = im.rotate(rot, expand=True, resample=Image.BICUBIC)
            self.decal.alpha_composite(im, (int(x - im.width / 2), int(y - im.height / 2)))

    def poly(self, pts, fill):
        self.dd.polygon([self.px(*q) for q in pts], fill=fill)
        if fill == FORM:
            self.de.polygon([self.px(*q) for q in pts], fill=255)

    def box(self, a0, b0, a1, b1, fill, r=0.0):
        p0, p1 = self.px(a0, b0), self.px(a1, b1)
        bx = [min(p0[0], p1[0]), min(p0[1], p1[1]), max(p0[0], p1[0]), max(p0[1], p1[1])]
        if r:
            self.dd.rounded_rectangle(bx, radius=self.m(r), fill=fill)
        else:
            self.dd.rectangle(bx, fill=fill)
        if fill == FORM:
            self.de.rectangle(bx, fill=255)

    def outline_box(self, a0, b0, a1, b1, col, w=0.012, r=0.0):
        p0, p1 = self.px(a0, b0), self.px(a1, b1)
        bx = [min(p0[0], p1[0]), min(p0[1], p1[1]), max(p0[0], p1[0]), max(p0[1], p1[1])]
        self.dd.rounded_rectangle(bx, radius=self.m(r), outline=col, width=max(1, int(self.m(w))))

    def wear_blob(self, a0, b0, a1, b1, v=255):
        p0, p1 = self.px(a0, b0), self.px(a1, b1)
        bx = [min(p0[0], p1[0]), min(p0[1], p1[1]), max(p0[0], p1[0]), max(p0[1], p1[1])]
        self.dw.ellipse(bx, fill=v)

    def finish(self):
        """Downsample to arrays (float 0..1)."""
        def ds(im):
            return np.asarray(im.resize((self.W, self.H), Image.BOX), dtype=np.float32) / 255.0
        self.P = ds(self.panel)
        self.Rv = ds(self.rivet)
        self.D = ds(self.decal)            # premultiplied? PIL RGBA straight alpha
        self.Wr = ndimage.gaussian_filter(ds(self.wear), 6)
        self.Em = ds(self.emit)
        del self.panel, self.rivet, self.decal, self.wear, self.dp, self.dr, self.dd, self.dw, self.emit, self.de
        self.St = self.make_streaks() if self.kind in 'RL' else None

    def make_streaks(self, L=0.22):
        """Grime washed down from seams / fasteners: sources smeared downward with exponential decay, thin columns."""
        src = np.clip((1 - self.P) * 0.35 + self.Rv * 0.9, 0, 1)
        rng = np.random.default_rng(5 if self.kind == 'R' else 6)
        H, W = src.shape
        r = rng.random(W).astype(np.float32)
        col = np.where(r > 0.86, rng.uniform(0.3, 1.0, W).astype(np.float32), 0.0)     # ~14 % of columns streak
        col = ndimage.gaussian_filter1d(col, 1.5) * 2.2
        lowf = ndimage.gaussian_filter1d(rng.random(W).astype(np.float32), 60)
        col *= np.clip((lowf - lowf.min()) / (np.ptp(lowf) + 1e-6) * 1.6, 0.2, 1.0)
        col = np.clip(col, 0, 1)
        decay = math.exp(-1.0 / (L * PPM))
        out = np.zeros_like(src)
        acc = np.zeros(W, np.float32)
        for r in range(H):                  # row 0 = top (high z): streaks run toward larger rows (down)
            acc = np.maximum(src[r] * col, acc * decay)
            out[r] = acc
        return ndimage.gaussian_filter(out, (2.0, 0.6))

    def coords(self, a, b):
        """metres -> (row, col) float pixel coords of the downsampled sheet."""
        if self.kind == 'R':
            c, r = (a - Y0) * PPM, (Z1 - b) * PPM
        elif self.kind == 'L':
            c, r = (Y1 - a) * PPM, (Z1 - b) * PPM
        elif self.kind == 'T':
            c, r = (a - X0) * PPM, (Y1 - b) * PPM
        else:
            c, r = (X1 - a) * PPM, (Y1 - b) * PPM
        return np.stack([r - 0.5, c - 0.5])

    def sample(self, arr, a, b, cval=0.0):
        co = self.coords(a, b)
        if arr.ndim == 2:
            return ndimage.map_coordinates(arr, co, order=1, mode='constant', cval=cval)
        return np.stack([ndimage.map_coordinates(arr[..., k], co, order=1, mode='constant', cval=cval) for k in range(arr.shape[2])], -1)


# ------------------------------------------------------------------------------------------------------------ layout
# Boom markings. The defaults are fictional: an FY26 serial outside the block the Army numbers its UH-60Ms in, and no
# service title (a service's name is its registered trademark). A real airframe's serial and service title are a local
# opt-in kept outside git: markings.json["uh60"] = {"serial": ..., "service_title": ...} in the brand directory
# (blender/common/brand.py).
MARKINGS = brand.markings('uh60', {'serial': '26-01026', 'service_title': ''})
SERIAL = MARKINGS['serial']
BLACK = (16, 17, 15, 240)
LOWVIS = (112, 114, 107, 232)      # UH-60M low-visibility markings: light grey on the dark green
STENCIL = (20, 21, 19, 225)
FORM = (196, 214, 150, 255)       # electroluminescent formation-light strips (pale green)


def fuse_side_layout(S, side):
    """Panel seams, rivets and stencils on a side sheet. side = +1 right, -1 left."""
    # --- circumferential frames (rivet rows) and skin joints (seams)
    frames = [(4.28, 0.64, 1.42, 'seam'), (3.63, 0.58, 1.72, 'rivet'), (2.47, 0.50, 2.05, 'rivet'),
              (1.47, 0.47, 2.05, 'seam'), (-0.93, 0.40, 2.05, 'seam'), (-1.78, 0.40, 2.10, 'rivet'),
              (-2.55, 0.44, 2.10, 'seam'), (-3.28, 0.48, 2.05, 'seam')]
    for y, z0, z1, kind in frames:
        if kind == 'seam':
            S.seam([(y, z0), (y, z1)])
            S.rivets([(y + 0.022, z0), (y + 0.022, z1)])
            S.rivets([(y - 0.022, z0), (y - 0.022, z1)])
        else:
            S.rivets([(y, z0), (y, z1)])
    # tail cone frames every ~0.52 m (rivet rows) + two skin joints
    y = -3.28
    while y > -8.9:
        y -= 0.52
        S.rivets([(y, 0.5), (y, 2.0)], pitch=0.042)
    S.seam([(-5.40, 0.55), (-5.40, 1.95)])
    S.seam([(-7.55, 0.70), (-7.55, 1.70)])
    # --- longitudinal seams / stringers
    S.seam([(3.65, 0.63), (-3.28, 0.63)])          # lower longeron / floor line
    S.rivets([(3.65, 0.60), (-3.28, 0.60)])
    S.seam([(2.50, 2.02), (-3.28, 2.02)])          # upper longeron
    S.rivets([(2.50, 2.05), (-3.28, 2.05)])
    S.rivets([(1.47, 1.20), (-3.28, 1.20)], pitch=0.05)
    S.rivets([(-3.28, 1.24), (-9.0, 1.21)], pitch=0.045)       # tail cone mid stringer
    S.seam([(-3.28, 0.88), (-9.0, 0.98)])
    S.seam([(-3.28, 1.62), (-9.0, 1.44)])
    S.rivets([(-3.28, 0.84), (-9.0, 0.95)], pitch=0.045)
    S.rivets([(-3.28, 1.66), (-9.0, 1.47)], pitch=0.045)
    # belly-side seam
    S.seam([(4.0, 0.52), (-3.2, 0.47)])
    # --- nose: radome / avionics bay doors
    S.rect_seam(3.66, 1.25, 4.22, 1.60, r=0.05)
    S.rect_rivets(3.66, 1.25, 4.22, 1.60)
    S.text(3.94, 1.425, 'AVIONICS', 0.018, F_STENCIL, STENCIL)
    # nose jacking point / ground receptacle
    S.outline_box(3.10, 0.66, 3.22, 0.74, STENCIL, w=0.006)
    # --- crew door frame (the door edge is geometry; add doubler rivets around it)
    S.rivets([(3.60, 0.88), (3.60, 1.30), (3.47, 1.70), (3.00, 2.06), (2.52, 2.06), (2.52, 0.88)], pitch=0.04)
    S.text(3.05, 0.975, 'EMERGENCY  EXIT', 0.022, F_STENCIL, STENCIL)
    S.text(2.75, 1.19, 'PUSH', 0.02, F_STENCIL, STENCIL)
    S.box(2.70, 1.12, 2.80, 1.15, (30, 30, 28, 200))
    # --- gunner window frame / cabin door rails area
    S.rivets([(2.40, 1.20), (2.40, 1.98), (1.77, 1.98), (1.77, 1.20), (2.40, 1.20)], pitch=0.04)
    # cabin door: handle recess + stencils (the door itself is a separate object, same atlas)
    S.box(1.20, 1.05, 1.36, 1.10, (26, 26, 24, 230), r=0.01)
    S.text(1.28, 1.00, 'PULL TO OPEN', 0.018, F_STENCIL, STENCIL)
    S.text(0.25, 0.72, 'DO NOT STEP', 0.02, F_STENCIL, STENCIL)
    S.rect_seam(-0.84, 0.60, 1.38, 1.97, r=0.06, w=0.004)
    S.rivets([(1.30, 1.93), (-0.78, 1.93)], pitch=0.05)
    S.rivets([(1.30, 0.64), (-0.78, 0.64)], pitch=0.05)
    # --- window gaskets (light grey rubber) + black exit corner brackets around the cabin-door and gunner windows
    for (y0, z0, y1, z1) in ((0.16, 1.30, 1.26, 1.86), (-0.74, 1.30, -0.04, 1.86), (2.105, 1.25, 2.36, 1.93), (1.81, 1.25, 2.065, 1.93)):
        S.outline_box(y0 - 0.012, z0 - 0.012, y1 + 0.012, z1 + 0.012, (150, 151, 144, 235), w=0.016, r=0.10)
        L = 0.06
        for (yc, zc, sy, sz) in ((y0 - 0.05, z0 - 0.05, 1, 1), (y1 + 0.05, z0 - 0.05, -1, 1), (y0 - 0.05, z1 + 0.05, 1, -1), (y1 + 0.05, z1 + 0.05, -1, -1)):
            S.box(yc, zc, yc + sy * L, zc + sz * 0.012, (20, 21, 19, 235))
            S.box(yc, zc, yc + sy * 0.012, zc + sz * L, (20, 21, 19, 235))
    # --- rescue arrows (low-visibility black) and CUT HERE marks on the aft cabin
    for yc in (-1.30,):
        S.outline_box(yc - 0.28, 1.28, yc + 0.28, 1.72, (22, 22, 20, 200), w=0.012, r=0.0)
        S.text(yc, 1.80, 'RESCUE', 0.03, F_STENCIL, STENCIL)
        S.text(yc, 1.20, 'CUT HERE IN EMERGENCY', 0.018, F_STENCIL, STENCIL)
    # --- aft fuselage access panels
    if side > 0:
        S.rect_seam(-1.95, 0.95, -2.95, 1.75, r=0.04)
        S.rect_rivets(-1.95, 0.95, -2.95, 1.75)
        S.text(-2.45, 1.35, 'AVIONICS COMPT', 0.02, F_STENCIL, STENCIL)
        S.rect_seam(-3.55, 1.05, -4.25, 1.45, r=0.03)
        S.rect_rivets(-3.55, 1.05, -4.25, 1.45)
    else:
        # fuel: gravity filler + pressure refuel panel (left side)
        S.rect_seam(-2.10, 1.00, -2.75, 1.45, r=0.03)
        S.rect_rivets(-2.10, 1.00, -2.75, 1.45)
        S.text(-2.42, 1.53, 'JP-8', 0.035, F_STENCIL, STENCIL)
        S.text(-2.42, 0.92, 'PRESSURE REFUEL', 0.018, F_STENCIL, STENCIL)
        S.outline_box(-2.95, 1.30, -3.13, 1.48, STENCIL, w=0.006, r=0.09)
        S.text(-3.04, 1.55, 'FUEL', 0.022, F_STENCIL, STENCIL)
        S.rect_seam(-3.55, 1.05, -4.25, 1.45, r=0.03)
        S.rect_rivets(-3.55, 1.05, -4.25, 1.45)
    # --- service title along the tail boom (UH-60M; local opt-in only, MARKINGS)
    if MARKINGS['service_title']:
        S.text(-3.95, 1.50, MARKINGS['service_title'], 0.14, F_NARROW, BLACK)
    # tail cone: NO STEP / handhold / static port
    S.text(-7.0, 1.72, 'NO STEP', 0.03, F_STENCIL, STENCIL)
    S.outline_box(-3.62, 1.72, -3.70, 1.80, STENCIL, w=0.004, r=0.04)
    # --- engine / doghouse side (cowlings)
    S.seam([(0.88, 2.07), (-1.52, 2.07)])
    S.seam([(0.88, 2.73), (-1.52, 2.73)])
    S.seam([(-0.30, 2.08), (-0.30, 2.72)])
    S.rivets([(0.70, 2.12), (-1.40, 2.12)], pitch=0.05)
    S.text(0.10, 2.20, 'NO STEP', 0.025, F_STENCIL, STENCIL)
    S.text(-0.85, 2.60, 'ENG NO. %d' % (2 if side > 0 else 1), 0.03, F_STENCIL, STENCIL)
    # transmission / aft doghouse panels
    S.rect_seam(-1.62, 2.12, -2.55, 2.58, r=0.03)
    S.rect_rivets(-1.62, 2.12, -2.55, 2.58)
    S.rect_seam(-2.65, 2.00, -3.45, 2.34, r=0.03)
    S.rect_rivets(-2.65, 2.00, -3.45, 2.34)
    S.text(-3.05, 2.17, 'HOIST', 0.018, F_STENCIL, STENCIL) if side > 0 else None
    # --- formation lights (strips): nose, doghouse, tail cone, pylon
    for (yc, zc, L, ang) in ((3.95, 1.70, 0.30, 0), (0.40, 2.36, 0.34, 0), (-6.35, 1.56, 0.34, -2), (-8.85, 2.35, 0.30, 46)):
        S.text(yc, zc, '', 0.02)
        dx, dz = 0.5 * L * math.cos(math.radians(ang)), 0.5 * L * math.sin(math.radians(ang))
        w = 0.022
        nx, nz = -math.sin(math.radians(ang)) * w, math.cos(math.radians(ang)) * w
        S.poly([(yc - dx - nx, zc - dz - nz), (yc + dx - nx, zc + dz - nz), (yc + dx + nx, zc + dz + nz), (yc - dx + nx, zc - dz + nz)], FORM)
    # --- tail pylon: fold hinge, spar rivets, gearbox cover, serial, warning
    S.seam([(-7.98, 1.86), (-9.95, 1.86)])                 # fold line
    S.rivets([(-7.98, 1.82), (-9.95, 1.82)])
    S.seam([(-8.05, 1.25), (-9.85, 3.30)])                 # front spar line
    S.rivets([(-8.10, 1.25), (-9.90, 3.30)])
    S.rivets([(-8.95, 1.25), (-10.45, 3.25)])
    S.rect_seam(-9.55, 3.00, -10.55, 3.42, r=0.05)          # tail gearbox fairing panel
    S.text(-9.55, 2.30, SERIAL.split('-')[1], 0.19, F_NARROW, LOWVIS, rot=0)
    S.text(-9.55, 2.62, SERIAL, 0.045, F_NARROW, LOWVIS)
    S.text(-9.35, 2.06, 'DANGER', 0.07, F_STENCIL, LOWVIS)
    S.text(-9.30, 1.94, 'KEEP CLEAR OF ROTOR', 0.035, F_STENCIL, LOWVIS)
    # tie-down / jack symbols
    for (yc, zc) in ((2.1, 0.55), (-1.6, 0.52), (-6.0, 0.78)):
        S.poly([(yc - 0.04, zc - 0.03), (yc + 0.04, zc - 0.03), (yc, zc + 0.04)], (24, 24, 22, 200))
    # --- wear masks: door sills, steps, handholds, doghouse access
    S.wear_blob(-0.9, 0.52, 1.45, 0.72)
    S.wear_blob(2.5, 0.84, 3.62, 1.02)
    S.wear_blob(1.20, 0.95, 1.40, 1.18)
    S.wear_blob(-2.4, 1.9, -2.0, 2.3)
    S.wear_blob(2.7, 1.1, 2.85, 1.25)


def top_layout(S):
    # doghouse cowling seams (x, y)
    for x in (-0.36, 0.36):
        S.seam([(x, 2.35), (x, -2.2)])
        S.rivets([(x + 0.02, 2.30), (x + 0.02, -2.15)], pitch=0.05)
    for y in (1.35, 0.52, -0.62, -1.40, -2.25, -3.05):
        S.seam([(-0.62, y), (0.62, y)])
    S.rect_seam(-0.30, -2.35, 0.30, -2.95, r=0.04)               # oil cooler exhaust grille
    S.box(-0.27, -2.38, 0.27, -2.92, (14, 15, 14, 235), r=0.03)
    for k in range(9):
        yy = -2.42 - k * 0.055
        S.box(-0.25, yy, 0.25, yy - 0.012, (40, 42, 40, 255))
    # mast area oil staining handled procedurally; walkway non-skid on the cowlings
    for x0 in (-0.95, 0.55):
        S.box(x0, 0.75, x0 + 0.40, -1.10, (28, 28, 27, 170), r=0.03)
    S.text(0.0, 1.70, 'NO STEP', 0.03, F_STENCIL, STENCIL)
    S.text(0.0, -3.35, 'NO STEP', 0.03, F_STENCIL, STENCIL)
    # cockpit roof: panel + pitot
    S.rect_seam(-0.52, 2.95, 0.52, 2.45, r=0.05)
    S.rect_rivets(-0.52, 2.95, 0.52, 2.45)
    # cabin roof rivet rows (outside the doghouse)
    for x in (-0.95, 0.95):
        S.rivets([(x, 2.4), (x, -3.2)], pitch=0.05)
    # tail cone top: drive shaft cover seams + rivets, NO STEP
    for x in (-0.19, 0.19):
        S.seam([(x, -3.9), (x, -7.6)])
        S.rivets([(x * 1.2, -3.9), (x * 1.2, -7.6)], pitch=0.045)
    y = -3.9
    while y > -7.6:
        S.seam([(-0.19, y), (0.19, y)])
        y -= 0.62
    for yc in (-4.8, -6.4):
        S.text(0.33, yc, 'NO STEP', 0.03, F_STENCIL, STENCIL, rot=90)
        S.text(-0.33, yc, 'NO STEP', 0.03, F_STENCIL, STENCIL, rot=-90)
    # stabilator: spar rivet lines + NO STEP
    for sgn in (-1, 1):
        S.rivets([(sgn * 0.25, -9.12), (sgn * 2.15, -9.12)], pitch=0.05)
        S.rivets([(sgn * 0.25, -9.55), (sgn * 2.15, -9.55)], pitch=0.05)
        S.seam([(sgn * 1.2, -8.82), (sgn * 1.2, -9.95)])
        S.text(sgn * 1.25, -9.35 + 0.0, 'NO STEP', 0.035, F_STENCIL, STENCIL)
    # formation strip on the cabin roof edges
    for sgn in (-1, 1):
        S.box(sgn * 1.0 - 0.02, 0.2, sgn * 1.0 + 0.02, -0.15, FORM)
    # wear on the walkways next to the mast
    S.wear_blob(-0.7, 1.2, -0.2, -0.9, 200)
    S.wear_blob(0.2, 1.2, 0.7, -0.9, 200)


def bottom_layout(S):
    # belly frames continue + panels
    for y in (4.28, 3.63, 2.47, 1.47, -0.93, -1.78, -2.55, -3.28):
        S.seam([(-1.1, y), (1.1, y)])
    for x in (-0.55, 0.55):
        S.seam([(x, 3.6), (x, -3.2)])
        S.rivets([(x + 0.02, 3.6), (x + 0.02, -3.2)], pitch=0.05)
    # cargo hook door
    S.rect_seam(-0.35, 0.45, 0.35, -0.55, r=0.05)
    S.rect_rivets(-0.35, 0.45, 0.35, -0.55)
    S.text(0, -0.70, 'CARGO HOOK', 0.03, F_STENCIL, STENCIL)
    # fuel sump drains / belly panels aft
    S.rect_seam(-0.45, -1.9, 0.45, -3.1, r=0.04)
    S.rect_rivets(-0.45, -1.9, 0.45, -3.1)
    S.text(0, -2.5, 'FUEL DRAIN', 0.03, F_STENCIL, STENCIL)
    # tail cone underside
    y = -3.28
    while y > -8.9:
        y -= 0.52
        S.rivets([(-0.4, y), (0.4, y)], pitch=0.045)
    S.seam([(0, -3.3), (0, -8.9)])
    # stabilator underside
    for sgn in (-1, 1):
        S.rivets([(sgn * 0.25, -9.12), (sgn * 2.15, -9.12)], pitch=0.05)
    S.wear_blob(-0.8, 3.2, 0.8, 1.6, 120)


# ------------------------------------------------------------------------------------------------------------ noise
BB_LO = np.array([X0, Y0, Z0], np.float32)


def noise_grid(cell, seed, sigma=1.0):
    dims = (np.array([X1 - X0, Y1 - Y0, Z1 - Z0]) / np.array(cell)).astype(int) + 3
    g = np.random.default_rng(seed).standard_normal(tuple(dims)).astype(np.float32)
    g = ndimage.gaussian_filter(g, sigma, mode='wrap')
    g /= g.std() + 1e-6
    return g, np.array(cell, np.float32)


def noise_at(grid, P):
    g, cell = grid
    co = ((P - BB_LO) / cell).T
    return ndimage.map_coordinates(g, co, order=3, mode='nearest', prefilter=False)


def fbm(P, cells, seed, weights=None):
    out = np.zeros(len(P), np.float32)
    weights = weights or [1.0 / (i + 1) for i in range(len(cells))]
    for i, c in enumerate(cells):
        out += weights[i] * noise_at(noise_grid(c, seed + i, 1.2), P)
    return out / sum(weights)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------------------ main
def main():
    pos = np.load(os.path.join(CACHE, 'pos.npy'))
    nrm = np.load(os.path.join(CACHE, 'nrm.npy'))
    ao = np.load(os.path.join(CACHE, 'ao.npy'))[..., 0]
    mask = np.load(os.path.join(CACHE, 'mask.npy'))[..., 3] > 0.5
    H, W = mask.shape
    cover = pos[..., 3] > 0.5                          # texels with baked data (incl. margins)
    log('loaded', H, W, 'valid', int(mask.sum()), 'covered', int(cover.sum()))
    idx = np.nonzero(cover)
    P = pos[..., :3][idx].astype(np.float32)
    N = nrm[..., :3][idx].astype(np.float32)
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-6
    A = np.clip(ao[idx], 0, 1)
    n = len(P)

    # ---- sheets
    sheets = {k: Sheet(k) for k in 'RLTB'}
    fuse_side_layout(sheets['R'], 1)
    fuse_side_layout(sheets['L'], -1)
    top_layout(sheets['T'])
    bottom_layout(sheets['B'])
    for s in sheets.values():
        s.finish()
    log('sheets drawn')
    # debug previews of the sheets
    for k, s in sheets.items():
        im = (np.clip(s.P * (1 - s.Rv * 0.6), 0, 1) * 255).astype(np.uint8)
        Image.fromarray(im).resize((s.W // 3, s.H // 3)).save(os.path.join(OUT, f'dbg_sheet_{k}.png'))
        if s.St is not None:
            Image.fromarray((255 - np.clip(s.St, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, f'dbg_streak_{k}.png'))

    # ---- triplanar weights
    k = 6.0
    wR = np.clip(N[:, 0], 0, 1) ** k
    wL = np.clip(-N[:, 0], 0, 1) ** k
    wT = np.clip(N[:, 2], 0, 1) ** k
    wB = np.clip(-N[:, 2], 0, 1) ** k
    ws = wR + wL + wT + wB + 1e-6
    wR, wL, wT, wB = wR / ws, wL / ws, wT / ws, wB / ws
    # front/aft facing surfaces (|N.y| large) get the blend of whatever projections are left: fine.

    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    panel = np.zeros(n, np.float32)
    rivet = np.zeros(n, np.float32)
    grime_st = np.zeros(n, np.float32)
    emit = np.zeros(n, np.float32)
    decal = np.zeros((n, 4), np.float32)
    wear = np.zeros(n, np.float32)
    for key, w, a, b in (('R', wR, y, z), ('L', wL, y, z), ('T', wT, x, y), ('B', wB, x, y)):
        s = sheets[key]
        sel = w > 0.02
        if not sel.any():
            continue
        panel[sel] += w[sel] * s.sample(s.P, a[sel], b[sel], cval=1.0)
        rivet[sel] += w[sel] * s.sample(s.Rv, a[sel], b[sel])
        decal[sel] += w[sel, None] * s.sample(s.D, a[sel], b[sel])
        wear[sel] += w[sel] * s.sample(s.Wr, a[sel], b[sel])
        if s.St is not None:
            grime_st[sel] += w[sel] * s.sample(s.St, a[sel], b[sel])
        emit[sel] += w[sel] * s.sample(s.Em, a[sel], b[sel])
    wsel = wR + wL + wT + wB
    lowsel = wsel < 0.98
    panel[lowsel] += (1 - wsel[lowsel])
    # decals only where the projection is fairly perpendicular (avoid smeared text on curved edges)
    dproj = np.maximum.reduce([np.abs(N[:, 0]), np.abs(N[:, 2])])
    decal[:, 3] *= smoothstep(0.55, 0.8, dproj)
    log('sheets sampled')

    # ---- paint base colour (linear) with variation
    base = srgb_to_lin(np.array([50, 55, 46]) / 255.0)       # FS 34031 helo drab, as dark as UH-60M photos show it
    lum_n = fbm(P, [(0.9, 0.9, 0.9), (0.3, 0.3, 0.3), (0.08, 0.08, 0.08)], 11, [1.0, 0.6, 0.35])
    hue_n = fbm(P, [(1.6, 1.6, 1.6), (0.5, 0.5, 0.5)], 21)
    col = np.tile(base, (n, 1)).astype(np.float32)
    col *= (1.0 + 0.07 * lum_n)[:, None]
    col *= (1.0 + 0.04 * np.stack([hue_n, 0.3 * hue_n, -0.8 * hue_n], 1))
    # panel-to-panel repaint patchwork (cells between frames / seams)
    cell = (np.floor((y + 11.3) / 0.52) * 7 + np.floor(z / 0.7) * 13 + np.floor((x + 3) / 1.3) * 29).astype(np.int64)
    rnd = ((cell * 2654435761) % 1000) / 1000.0 - 0.5
    col *= (1.0 + 0.045 * rnd)[:, None]
    # touch-up repaint patches (rectangles aligned with the panel grid, slightly darker/greener fresh paint)
    pcell = (np.floor((y + 11.3) / 0.26) * 5 + np.floor((z + 0.2) / 0.35) * 17 + np.floor((x + 3) / 0.9) * 31).astype(np.int64)
    prnd = ((pcell * 2246822519) % 1000) / 1000.0
    patch = (prnd > 0.93).astype(np.float32)
    patch = patch * smoothstep(0.1, 0.6, np.abs(fbm(P, [(0.25, 0.25, 0.25)], 17)))
    col = col * (1 - patch[:, None] * 0.10) + (col * np.array([0.92, 1.0, 0.95], np.float32)) * patch[:, None] * 0.10
    col *= (1 - 0.07 * patch)[:, None]
    # sun-faded upper surfaces: lighter, greyer
    up = smoothstep(0.2, 0.9, N[:, 2])
    fade = up * (0.10 + 0.06 * fbm(P, [(0.6, 0.6, 0.6), (0.15, 0.15, 0.15)], 31))
    grey = col.mean(1, keepdims=True)
    col = col * (1 - fade[:, None] * 0.35) + grey * fade[:, None] * 0.35
    col *= (1 + fade * 0.55)[:, None]
    # vertical dirt streaks on the sides
    side = 1 - np.abs(N[:, 2])
    streak = np.clip(grime_st, 0, 1)
    col *= (1 - 0.16 * streak * side)[:, None]
    # grime washed down from fasteners / seams: vertical streak mask modulated by rivet density above
    fst = streak * side
    # lower-surface grime (brownish dust), heavier aft of the main wheels and under the tail cone
    grime = smoothstep(0.1, -0.7, N[:, 2]) * (0.45 + 0.25 * fbm(P, [(0.4, 0.4, 0.4), (0.1, 0.1, 0.1)], 51))
    grime += smoothstep(0.95, 0.45, z) * 0.35 * (0.6 + 0.4 * fbm(P, [(0.2, 0.2, 0.2)], 52))
    grime = np.clip(grime, 0, 1)
    dust = srgb_to_lin(np.array([84, 80, 70]) / 255.0)
    col = col * (1 - 0.30 * grime[:, None]) + dust * 0.30 * grime[:, None]
    # exhaust soot: HIRSS exits (outboard, aft) + APU exhaust (left aft doghouse) -> aft upper surfaces
    soot = np.zeros(n, np.float32)
    for sx in (-1, 1):
        ex = np.array([sx * 1.12, -2.40, 2.44], np.float32)
        d = P - ex
        along = -d[:, 1]                                  # distance aft of the exit
        lat = np.sqrt((d[:, 0] - sx * 0.25 * np.clip(along, 0, 5)) ** 2 + (d[:, 2] + 0.10 * np.clip(along, 0, 5)) ** 2)
        s_ = np.exp(-(lat / (0.25 + 0.12 * np.clip(along, 0, 6))) ** 2) * smoothstep(-0.3, 0.2, along) * np.exp(-np.clip(along, 0, 9) / 3.0)
        soot += s_
    apu = np.array([-0.55, -3.15, 2.30], np.float32)
    d = P - apu
    along = -d[:, 1]
    lat = np.sqrt(d[:, 0] ** 2 + (d[:, 2] + 0.05 * along) ** 2)
    soot += 0.8 * np.exp(-(lat / (0.12 + 0.08 * np.clip(along, 0, 6))) ** 2) * smoothstep(-0.1, 0.15, along) * np.exp(-np.clip(along, 0, 9) / 2.2)
    soot *= (0.75 + 0.35 * fbm(P, [(0.15, 0.15, 0.15), (0.05, 0.05, 0.05)], 61))
    soot = np.clip(soot, 0, 1)
    col *= (1 - 0.72 * soot)[:, None]
    # oil / hydraulic stains below the transmission + engine drains (dark, glossy)
    oil_n = fbm(P, [(0.12, 0.12, 0.5), (0.05, 0.05, 0.25)], 71)
    oil = smoothstep(0.6, 1.8, oil_n) * smoothstep(0.3, -0.5, N[:, 2]) * smoothstep(1.2, 0.2, np.abs(y + 0.3))
    oil += smoothstep(0.9, 2.0, oil_n) * smoothstep(2.3, 2.9, z) * (np.abs(y) < 1.3) * 0.7     # around the mast base
    oil = np.clip(oil, 0, 1)
    col *= (1 - 0.35 * oil)[:, None]
    # panel seams collect dirt; rivets catch a little light
    seam = 1 - panel
    col *= (1 - 0.60 * seam)[:, None]
    col *= (1 + 0.10 * rivet)[:, None]
    # edge wear from curvature of the baked normal field (computed in texture space)
    nimg = np.zeros((H, W, 3), np.float32)
    nimg[idx] = N
    pimg = np.zeros((H, W, 3), np.float32)
    pimg[idx] = P
    dpx = np.linalg.norm(np.roll(pimg, -1, 1) - np.roll(pimg, 1, 1), axis=2) + 1e-5
    dpy = np.linalg.norm(np.roll(pimg, -1, 0) - np.roll(pimg, 1, 0), axis=2) + 1e-5
    curv = (np.sum((np.roll(nimg, -1, 1) - np.roll(nimg, 1, 1)) * (np.roll(pimg, -1, 1) - np.roll(pimg, 1, 1)), 2) / dpx ** 2
            + np.sum((np.roll(nimg, -1, 0) - np.roll(nimg, 1, 0)) * (np.roll(pimg, -1, 0) - np.roll(pimg, 1, 0)), 2) / dpy ** 2)
    valid_d = (dpx < 0.03) & (dpy < 0.03)
    curv = np.where(valid_d, curv, 0)
    curv = ndimage.gaussian_filter(curv, 1.0)[idx]
    edge = smoothstep(10.0, 30.0, curv) * smoothstep(0.1, 1.2, fbm(P, [(0.06, 0.06, 0.06), (0.025, 0.025, 0.025)], 81))
    wear = np.clip(wear * smoothstep(0.2, 1.4, fbm(P, [(0.05, 0.05, 0.05), (0.02, 0.02, 0.02)], 91)), 0, 1)
    worn = np.clip(edge * 0.35 + wear * 0.45, 0, 1)
    light = srgb_to_lin(np.array([112, 116, 104]) / 255.0)
    col = col * (1 - 0.30 * worn[:, None]) + light * 0.30 * worn[:, None]
    chip = (worn > 0.6) & (fbm(P, [(0.010, 0.010, 0.010)], 101) > 1.9)
    metal_c = srgb_to_lin(np.array([150, 152, 150]) / 255.0)
    col[chip] = metal_c
    # decals (paint): straight alpha
    da = np.clip(decal[:, 3], 0, 1)
    dc = srgb_to_lin(np.clip(decal[:, :3] / np.maximum(decal[:, 3:4], 1e-4), 0, 1))
    dc *= (1 + 0.05 * lum_n)[:, None]
    col = col * (1 - da[:, None]) + dc * da[:, None]
    # ambient occlusion (partly baked into the albedo; the rest goes to the ORM R channel)
    col *= (0.55 + 0.45 * A)[:, None]
    log('colour done')

    # ---- roughness / metal
    rough = 0.64 + 0.07 * lum_n + 0.08 * grime - 0.20 * oil + 0.12 * soot - 0.12 * worn - 0.05 * da - 0.06 * patch + 0.05 * fst
    rough -= 0.10 * smoothstep(0.9, 2.0, fbm(P, [(0.3, 0.3, 0.3), (0.1, 0.1, 0.1)], 111))          # greasy hand-touched areas
    rough = np.clip(rough, 0.25, 0.95)
    metal = np.where(chip, 0.9, 0.0).astype(np.float32)

    # ---- height -> tangent-space normal map
    height = -0.0011 * seam + 0.00045 * rivet
    himg = np.zeros((H, W), np.float32)
    himg[idx] = height
    # tangent frame from position derivatives: T = dP/du (columns), B = dP/dv (rows; row index = v in Blender order)
    Tv = (np.roll(pimg, -1, 1) - np.roll(pimg, 1, 1))
    Bv = (np.roll(pimg, -1, 0) - np.roll(pimg, 1, 0))
    lt = np.linalg.norm(Tv, axis=2) + 1e-6
    lb = np.linalg.norm(Bv, axis=2) + 1e-6
    dhdu = (np.roll(himg, -1, 1) - np.roll(himg, 1, 1)) / lt
    dhdv = (np.roll(himg, -1, 0) - np.roll(himg, 1, 0)) / lb
    ok = valid_d & cover & np.roll(cover, 1, 0) & np.roll(cover, -1, 0) & np.roll(cover, 1, 1) & np.roll(cover, -1, 1)
    dhdu = np.where(ok, dhdu, 0)
    dhdv = np.where(ok, dhdv, 0)
    strength = 1.0
    nts = np.stack([-dhdu * strength, -dhdv * strength, np.ones_like(dhdu)], -1)
    nts /= np.linalg.norm(nts, axis=2, keepdims=True)
    log('normal map done')

    # ---- assemble images, fill the empty atlas space from the nearest texel (mip-safe)
    def to_img(vals, ch):
        img = np.zeros((H, W, ch), np.float32)
        img[idx] = vals.reshape(n, ch)
        return img

    base_img = to_img(lin_to_srgb(col), 3)
    orm_img = to_img(np.stack([A * 0.5 + 0.5, rough, metal], 1), 3)
    nrm_img = nts * 0.5 + 0.5
    dist, (ri, ci) = ndimage.distance_transform_edt(~cover, return_indices=True)
    base_img = base_img[ri, ci]
    orm_img = orm_img[ri, ci]
    nrm_img = np.where(cover[..., None], nrm_img, np.array([0.5, 0.5, 1.0], np.float32))
    # Blender pixel rows start at the bottom -> flip for image files
    def save(img, name, q=92):
        a = (np.clip(img[::-1], 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(a).save(os.path.join(OUT, name), quality=q, subsampling=0 if 'nrm' in name else 2)
    em_img = to_img(np.stack([emit * 0.75, emit * 1.0, emit * 0.55], 1) * smoothstep(0.55, 0.8, dproj)[:, None], 3)
    em_img = em_img[ri, ci] * cover[..., None]
    em_small = Image.fromarray((np.clip(em_img[::-1], 0, 1) * 255).astype(np.uint8)).resize((2048, 2048), Image.BOX)
    em_small.save(os.path.join(OUT, 'hull_emit.jpg'), quality=90)
    save(base_img, 'hull_base.jpg', 90)
    save(orm_img, 'hull_orm.jpg', 90)
    save(nrm_img, 'hull_nrm.jpg', 93)
    log('saved')


if __name__ == '__main__':
    main()
