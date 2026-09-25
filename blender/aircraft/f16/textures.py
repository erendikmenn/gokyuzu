"""F-16C skin textures (4096²): base color (two-tone Hill Gray II), normal (panel lines, rivets), ORM.

Run with the project venv (numpy, pillow, scipy):
  .venv/bin/python blender/aircraft/f16/textures.py [--fast]
Outputs to assets/aircraft/f16/tex/ (or $GOKYUZU_TEX_OUT): skin_color.jpg, skin_normal.png, skin_orm.png (+ debug
previews). The baked AO (tex/skin_ao.png, build.py --bake) is read from the output directory, else from
assets/aircraft/f16/tex/.
Panel lines are projected from the digitized CC0 3-view (ref/f16_3view_lines.json): top view onto up-facing skin,
side view onto side-facing skin; the underside uses synthesized lines.

Markings (MARKINGS): fictional and generic by default (tail code "GK", serial AF 26-001, no unit band, a generic
roundel); real markings are a local opt-in kept outside git (markings.json["f16"] + plugin markings/f16.py, see
blender/common/brand.py).
"""
import os
import sys
import json
import math
import time
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import f16_layout as LY
import f16_fuselage as FU
import f16_parts as PT
import f16_gear as GR

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.append(os.path.join(REPO, 'blender', 'common'))
import brand  # noqa: E402
DEFAULT_OUT = os.path.join(REPO, 'assets', 'aircraft', 'f16', 'tex')
OUT = os.path.abspath(os.environ.get('GOKYUZU_TEX_OUT') or DEFAULT_OUT)

# Markings. The repository paints only fictional, generic markings: tail code "GK" (placed a little lower than a
# two-letter code without a raised right arm would be, so the K clears the fin's leading-edge UV border), serial
# AF 26-001 and data stencil "F-16C  26-0001" (FY26: the USAF orders no F-16s), no unit band, a generic roundel as
# national insignia. Real markings are a local opt-in kept outside git (blender/common/brand.py): values in
# markings.json["f16"] (keys as below plus 'unit' (str), 'unit_band' ({"text", "rgb", "text_rgb"}), 'fin_cap_rgb'
# ([r, g, b])), insignia drawing code in the plugin markings/f16.py (hook insignia(size_px, fill) -> RGBA image).
MARKINGS = brand.markings('f16', {'tail_code': 'GK', 'tail_code_pos': (13.28, 4.06), 'serial_fy': '26',
                                  'serial_no': '001', 'data_stencil': 'F-16C  26-0001', 'unit': '', 'unit_band': None,
                                  'fin_cap_rgb': None})
MARKINGS_PLUGIN = brand.module('markings/f16.py')
FAST = '--fast' in sys.argv
W = H = LY.W
RNG = np.random.default_rng(1604)

FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FONT_REG = '/System/Library/Fonts/Supplemental/Arial.ttf'
FONT_NARROW = '/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf'
for f in (FONT_BOLD, FONT_REG, FONT_NARROW):
    if not os.path.exists(f):
        FONT_BOLD = FONT_REG = FONT_NARROW = '/System/Library/Fonts/Helvetica.ttc'
        break


def srgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


GRAY_DARK = srgb('#7f8487')     # FS 36270 neutral gray (upper surfaces)
GRAY_LIGHT = srgb('#a2a6aa')    # FS 36375 light ghost gray (sides, lower surfaces)
GRAY_RADOME = srgb('#8e9296')
GRAY_INSIG = srgb('#5d6266')    # FS 36118-ish for low-vis markings

# ----------------------------------------------------------------------------------------------------------------------
# 1. surface information per texel
REG_NONE, REG_FUS, REG_WINGU, REG_WINGL, REG_STABU, REG_STABL, REG_FIN, REG_MISC = 0, 1, 2, 3, 4, 5, 6, 7


class Surf:
    def __init__(self):
        self.S = np.zeros((H, W), np.float32)
        self.Y = np.zeros((H, W), np.float32)
        self.Z = np.zeros((H, W), np.float32)
        self.NY = np.zeros((H, W), np.float32)
        self.NZ = np.zeros((H, W), np.float32)
        self.REG = np.zeros((H, W), np.uint8)
        self.AFT = np.zeros((H, W), np.int8)       # +1: aft is +x in texture, -1: aft is -x
        self.SIDE = np.zeros((H, W), np.int8)      # +1 right, -1 left


def fill_fuselage(sf):
    for side in ('R', 'L'):
        r = LY.REGIONS['FUS_' + side]
        k = r['k']
        x0, y0, h = r['x0'], r['y0'], r['h']
        xs = np.arange(int(x0), int(x0 + (LY.S_FUS1 - LY.S_FUS0) * k) + 1)
        rows = np.arange(y0, y0 + h)
        arc_rows = (rows - y0 + 0.5) / k
        for x in xs:
            if x < 0 or x >= W:
                continue
            s = (LY.S_FUS1 - (x + 0.5 - x0) / k) if side == 'R' else (LY.S_FUS0 + (x + 0.5 - x0) / k)
            s_c = min(max(s, FU.S_START), FU.S_END)
            pts, _ = FU.half_section(s_c)
            arcs = FU.arc_lengths(pts)
            ok = arc_rows <= arcs[-1] + 0.02
            a = np.clip(arc_rows, 0, arcs[-1])
            yy = np.interp(a, arcs, pts[:, 0])
            zz = np.interp(a, arcs, pts[:, 1])
            ty = np.gradient(pts[:, 0]); tz = np.gradient(pts[:, 1])
            tn = np.hypot(ty, tz) + 1e-9
            # outward normal of a curve running top -> right side -> bottom: n = rot90ccw(t) = (-tz, ty)
            ny = np.interp(a, arcs, -tz / tn)
            nz = np.interp(a, arcs, ty / tn)
            rr = rows[ok]
            sgn = 1 if side == 'R' else -1
            sf.S[rr, x] = s
            sf.Y[rr, x] = sgn * yy[ok]
            sf.Z[rr, x] = zz[ok]
            sf.NY[rr, x] = sgn * ny[ok]
            sf.NZ[rr, x] = nz[ok]
            sf.REG[rr, x] = REG_FUS
            sf.AFT[rr, x] = -1 if side == 'R' else 1
            sf.SIDE[rr, x] = sgn


def planar_inverse(name):
    r = LY.REGIONS[name]
    fs, ft = LY.PLANAR_FLIPS.get(name, (False, False))
    x0, y0, w, h, k = r['x0'], r['y0'], r['w'], r['h'], r['k']
    xx, yy = np.meshgrid(np.arange(x0, x0 + w) + 0.5, np.arange(y0, y0 + h) + 0.5)
    s = (r['s1'] - (xx - x0) / k) if fs else (r['s0'] + (xx - x0) / k)
    t = (r['t0'] + (yy - y0) / k) if ft else (r['t1'] - (yy - y0) / k)
    sl = (slice(int(y0), int(y0 + h)), slice(int(x0), int(x0 + w)))
    return sl, s.astype(np.float32), t.astype(np.float32), (-1 if fs else 1)


def fill_planar(sf):
    # wings
    for name, reg, sgn, up in (('WU_R', REG_WINGU, 1, 1), ('WU_L', REG_WINGU, -1, 1), ('WL_R', REG_WINGL, 1, -1), ('WL_L', REG_WINGL, -1, -1)):
        sl, s, t, aft = planar_inverse(name)
        inside = (t >= PT.WING_ROOT - 0.05) & (t <= PT.WING_TIP + 0.02) & (s >= PT.wing_le(t) - 0.03) & (s <= PT.WING_TE + 0.03)
        sf.S[sl] = np.where(inside, s, sf.S[sl]); sf.Y[sl] = np.where(inside, sgn * t, sf.Y[sl])
        sf.Z[sl] = np.where(inside, PT.WING_Z, sf.Z[sl]); sf.NZ[sl] = np.where(inside, up, sf.NZ[sl])
        sf.REG[sl] = np.where(inside, reg, sf.REG[sl]); sf.AFT[sl] = np.where(inside, aft, sf.AFT[sl])
        sf.SIDE[sl] = np.where(inside, sgn, sf.SIDE[sl])
    # stabilators
    ca, sa = math.cos(PT.STAB_ANHEDRAL), math.sin(PT.STAB_ANHEDRAL)
    for name, reg, sgn, up in (('SU_R', REG_STABU, 1, 1), ('SU_L', REG_STABU, -1, 1), ('SL_R', REG_STABL, 1, -1), ('SL_L', REG_STABL, -1, -1)):
        sl, s, t, aft = planar_inverse(name)
        te = np.where(t <= 1.477, 14.565, 14.565 - (t - 1.477) * (0.221 / 0.286))
        inside = (t >= -0.02) & (t <= PT.STAB_SPAN + 0.02) & (s >= PT.stab_le(t) - 0.03) & (s <= te + 0.03)
        sf.S[sl] = np.where(inside, s, sf.S[sl]); sf.Y[sl] = np.where(inside, sgn * (PT.STAB_Y0 + t * ca), sf.Y[sl])
        sf.Z[sl] = np.where(inside, PT.STAB_Z0 - t * sa, sf.Z[sl]); sf.NZ[sl] = np.where(inside, up * ca, sf.NZ[sl])
        sf.NY[sl] = np.where(inside, sgn * up * sa, sf.NY[sl])
        sf.REG[sl] = np.where(inside, reg, sf.REG[sl]); sf.AFT[sl] = np.where(inside, aft, sf.AFT[sl])
        sf.SIDE[sl] = np.where(inside, sgn, sf.SIDE[sl])
    # fin
    for name, sgn in (('FIN_R', 1), ('FIN_L', -1)):
        sl, s, t, aft = planar_inverse(name)
        inside = (t >= 2.88) & (t <= 5.24) & (s >= PT.fin_le(np.clip(t, 2.9, 5.0)) - 0.05) & (s <= 15.08)
        sf.S[sl] = np.where(inside, s, sf.S[sl]); sf.Y[sl] = np.where(inside, sgn * 0.05, sf.Y[sl])
        sf.Z[sl] = np.where(inside, t, sf.Z[sl]); sf.NY[sl] = np.where(inside, sgn, sf.NY[sl])
        sf.REG[sl] = np.where(inside, REG_FIN, sf.REG[sl]); sf.AFT[sl] = np.where(inside, aft, sf.AFT[sl])
        sf.SIDE[sl] = np.where(inside, sgn, sf.SIDE[sl])
    # misc regions (dorsal, ventral fins, canopy fairing, fin cap, speedbrakes): side-ish surfaces
    for name, nz, ny in (('DORSAL', 0.6, 0.8), ('VF_RO', 0, 1), ('VF_RI', 0, -1), ('VF_LO', 0, -1), ('VF_LI', 0, 1),
                         ('CANF', 0.8, 0.5), ('FCAP', 0.3, 0.9)):
        sl, s, t, aft = planar_inverse(name)
        sf.S[sl] = s; sf.Z[sl] = t if name.startswith('VF') else 2.8
        sf.NZ[sl] = nz; sf.NY[sl] = ny
        sf.REG[sl] = REG_MISC; sf.AFT[sl] = aft
    r = LY.REGIONS['SB']
    for i in range(8):
        x0, y0 = LY.sb_cell(i)
        sl = (slice(int(y0), int(y0 + r['h'])), slice(int(x0), int(x0 + r['w'])))
        sf.REG[sl] = REG_MISC; sf.NZ[sl] = 1 if i % 2 == 0 else -1; sf.AFT[sl] = 1
        sf.S[sl] = np.linspace(PT.SB_S0, PT.SB_S1, r['w'])[None, :]


# ----------------------------------------------------------------------------------------------------------------------
# 2. reference line maps
REF = json.load(open(os.path.join(HERE, 'ref', 'f16_3view_lines.json')))
SIDE_EXCLUDE = {'path4879', 'path4895', 'path4915', 'path4947', 'path4967', 'path4969', 'path4991', 'path4993',
                'path4995', 'path5001', 'path5011', 'path5013', 'path5015', 'path4585', 'path4587', 'path2297',
                'path2299', 'path2301', 'path2303', 'path2305', 'path2307', 'path2309', 'path2293', 'path2295',
                'path2311', 'path4921', 'path4923', 'path4925', 'path4927', 'path4905', 'path4907', 'path4909',
                'path4911', 'path4913', 'path4917', 'path4939', 'path2327', 'path4955'}
TOP_EXCLUDE_PREFIX = ('path1465', 'path1467', 'path1541', 'path1543', 'path1545', 'path1551', 'path1579', 'path1581',
                      'path1583', 'path1585', 'path6463', 'path1499', 'path6457', 'path6455', 'path6459', 'path6461',
                      'path1547', 'path1607', 'path1491', 'path1493')
MPPX = 500.0          # line map resolution (px per meter)


class LineMap:
    def __init__(self, s0, s1, t0, t1, ppm=MPPX):
        self.s0, self.s1, self.t0, self.t1, self.ppm = s0, s1, t0, t1, ppm
        self.w = int((s1 - s0) * ppm); self.h = int((t1 - t0) * ppm)
        self.img = Image.new('L', (self.w, self.h), 0)
        self.d = ImageDraw.Draw(self.img)

    def px(self, s, t):
        return ((s - self.s0) * self.ppm, (self.t1 - t) * self.ppm)

    def line(self, pts, width=2, value=255):
        q = [self.px(a, b) for a, b in pts]
        if len(q) >= 2:
            self.d.line(q, fill=value, width=width)

    def rect(self, s0, t0, s1, t1, width=2, r=0.0):
        a, b = self.px(s0, t1), self.px(s1, t0)
        if r > 0:
            self.d.rounded_rectangle([a, b], radius=r * self.ppm, outline=255, width=width)
        else:
            self.d.rectangle([a, b], outline=255, width=width)

    def finish(self, blur=0.7):
        arr = np.asarray(self.img, np.float32) / 255.0
        if blur > 0:
            arr = ndimage.gaussian_filter(arr, blur)
        self.arr = arr
        return self

    def sample(self, S, T):
        x = (S - self.s0) * self.ppm
        y = (self.t1 - T) * self.ppm
        return ndimage.map_coordinates(self.arr, [y.ravel(), x.ravel()], order=1, mode='constant', cval=0).reshape(S.shape)


def build_line_maps():
    top = LineMap(0.0, 15.2, -4.9, 4.9)
    side = LineMap(0.0, 15.2, 0.0, 5.3)
    bot = LineMap(0.0, 15.2, -4.9, 4.9)
    for pid, p in zip(REF['side_ids'], REF['side']):
        if pid in SIDE_EXCLUDE:
            continue
        side.line(p, width=2)
    for pid, p in zip(REF['top_ids'], REF['top']):
        if pid.startswith(TOP_EXCLUDE_PREFIX):
            continue
        top.line(p, width=2)
        # wing structure lines repeat on the lower surface
        a = np.array(p)
        if abs(a[:, 1]).min() > 1.0 and a[:, 0].min() > 6.5:
            bot.line(p, width=2)
    # extra detail lines not in the drawing (upper fuselage frames, radome joint)
    for s in (2.21, 2.69):
        for sg in (1, -1):
            top.line([(s, 0), (s, sg * 0.6)], width=2)
    # synthesized belly panels (bottom view): keel lines, frames, gear doors, access panels
    for sg in (1, -1):
        bot.line([(4.7, sg * 0.20), (12.8, sg * 0.20)], width=2)
        bot.line([(4.7, sg * 0.46), (12.8, sg * 0.44)], width=2)
        bot.line([(5.3, sg * 0.66), (11.9, sg * 0.66)], width=2)
    for s in (5.29, 6.33, 7.18, 7.62, 8.95, 9.9, 10.9, 11.9, 12.8):
        bot.line([(s, -0.72), (s, 0.72)], width=2)
    # nose well doors split + main well doors (outline) + slots
    bot.line([(GR.NOSE_WELL[0][0], 0), (GR.NOSE_WELL[1][0], 0)], width=2)
    for poly in (GR.NOSE_WELL, GR.MAIN_WELL_R, [(s, -y) for s, y in GR.MAIN_WELL_R], GR.MAIN_SLOT_R, [(s, -y) for s, y in GR.MAIN_SLOT_R]):
        bot.line(list(poly) + [poly[0]], width=3)
    for (s0, s1, y0, y1) in ((9.95, 10.85, 0.05, 0.40), (11.0, 11.85, 0.05, 0.40), (6.40, 7.10, 0.25, 0.60),
                              (3.2, 4.2, 0.05, 0.40), (2.3, 3.1, 0.05, 0.35)):
        for sg in (1, -1):
            bot.rect(s0, min(sg * y0, sg * y1), s1, max(sg * y0, sg * y1), width=2, r=0.04)
    # lower forebody / radome joint
    for s in (2.2, 2.68, 3.36):
        bot.line([(s, -0.6), (s, 0.6)], width=2)
    return top.finish(), side.finish(), bot.finish()


# ----------------------------------------------------------------------------------------------------------------------
def smooth01(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def value_noise(shape, cell, seed):
    rng = np.random.default_rng(seed)
    gh, gw = shape[0] // cell + 3, shape[1] // cell + 3
    g = rng.random((gh, gw)).astype(np.float32)
    z = ndimage.zoom(g, cell, order=3)[:shape[0], :shape[1]]
    return z


def world_cells(S, T, cs, seed):
    """Random value per world-space cell (panel-sized repaint patches)."""
    i = np.floor(S / cs[0]).astype(np.int64)
    j = np.floor(T / cs[1]).astype(np.int64)
    h = (i * 73856093) ^ (j * 19349663) ^ seed
    h = (h ^ (h >> 13)) * 1274126177
    return ((h & 0xffff).astype(np.float32) / 65535.0)


def directional_smear(mask, aft_sign, length_px, decay):
    """Streaks trailing aft from a mask along +x/-x (per texel aft direction)."""
    k = np.exp(-np.arange(length_px) / decay).astype(np.float32)
    k /= k.sum()
    fwd = ndimage.convolve1d(mask, np.concatenate([np.zeros(length_px - 1, np.float32), k]), axis=1, mode='constant')
    bwd = ndimage.convolve1d(mask, np.concatenate([k[::-1], np.zeros(length_px - 1, np.float32)]), axis=1, mode='constant')
    # convolve1d with kernel centered: 'fwd' spreads toward +x
    return np.where(aft_sign > 0, fwd, np.where(aft_sign < 0, bwd, 0))


# ----------------------------------------------------------------------------------------------------------------------
# 3. marking placement helpers (draw into an RGBA overlay in atlas pixel space)
def fus_arc_at(side, s, y, z):
    pts, _ = FU.half_section(min(max(s, FU.S_START), FU.S_END))
    arcs = FU.arc_lengths(pts)
    d = (pts[:, 0] - abs(y)) ** 2 + (pts[:, 1] - z) ** 2
    k = int(np.argmin(d))
    return float(arcs[k])


def fus_px_at(side, s, y, z):
    return LY.fus_px(side, s, fus_arc_at(side, s, y, z))


def text_stamp(text, height_px, color, font=FONT_BOLD, spacing=0, stroke=0, stroke_color=None, pad=4):
    f = ImageFont.truetype(font, max(6, int(height_px)))
    bbox = f.getbbox(text, stroke_width=stroke)
    w, h = bbox[2] - bbox[0] + 2 * pad, bbox[3] - bbox[1] + 2 * pad
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.text((pad - bbox[0], pad - bbox[1]), text, font=f, fill=color, stroke_width=stroke, stroke_fill=stroke_color)
    return im


def paste(overlay, stamp, cx, cy, angle=0.0):
    if angle:
        stamp = stamp.rotate(angle, resample=Image.BICUBIC, expand=True)
    overlay.alpha_composite(stamp, (int(round(cx - stamp.width / 2)), int(round(cy - stamp.height / 2))))


def generic_roundel(size_px, fill):
    """Generic low-visibility roundel (a plain ring, no national emblem): the default insignia."""
    D = size_px
    im = Image.new('RGBA', (D + 8, D + 8), (0, 0, 0, 0))
    c, R = (D + 8) / 2, D / 2
    ImageDraw.Draw(im).ellipse([c - R, c - R, c + R, c + R], outline=fill, width=max(2, int(R * 0.16)))
    return im


def insignia(size_px, fill):
    """National insignia stamp (RGBA, `size_px` = disc diameter): the brand plugin's insignia() when present (local
    opt-in, MARKINGS_PLUGIN), else the generic roundel."""
    if MARKINGS_PLUGIN is not None and hasattr(MARKINGS_PLUGIN, 'insignia'):
        return MARKINGS_PLUGIN.insignia(size_px, fill)
    return generic_roundel(size_px, fill)


def warning_triangle(size_px):
    im = Image.new('RGBA', (size_px + 4, size_px + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = size_px
    d.polygon([(2 + s / 2, 2), (2 + s, 2 + s * 0.87), (2, 2 + s * 0.87)], fill=(200, 30, 25, 255))
    d.polygon([(2 + s / 2, 2 + s * 0.22), (2 + s * 0.8, 2 + s * 0.75), (2 + s * 0.2, 2 + s * 0.75)], fill=(235, 235, 230, 255))
    f = ImageFont.truetype(FONT_BOLD, int(s * 0.38))
    d.text((2 + s / 2, 2 + s * 0.52), '!', font=f, fill=(20, 20, 20, 255), anchor='mm')
    return im


# ----------------------------------------------------------------------------------------------------------------------
def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    sf = Surf()
    fill_fuselage(sf)
    fill_planar(sf)
    valid = sf.REG > 0
    print(f'[tex] surface info {time.time() - t0:.1f}s')
    top, side, bot = build_line_maps()
    S, Y, Z, NY, NZ = sf.S, sf.Y, sf.Z, sf.NY, sf.NZ
    anz = np.abs(NZ); any_ = np.abs(NY)
    w_top = smooth01(0.30, 0.62, NZ) * valid
    w_bot = smooth01(0.30, 0.62, -NZ) * valid
    w_side = smooth01(0.40, 0.72, any_) * valid
    # fins/wings: use explicit projections
    is_fin = sf.REG == REG_FIN
    w_side = np.where(is_fin, 1.0, w_side)
    w_top = np.where(is_fin, 0.0, w_top)
    lines = np.maximum.reduce([w_top * top.sample(S, Y), w_side * side.sample(S, Z), w_bot * bot.sample(S, Y)])
    lines = np.clip(lines * 1.6, 0, 1).astype(np.float32)
    print(f'[tex] lines {time.time() - t0:.1f}s')

    # --------------------------------------------------------------- base paint (two-tone) + radome
    dark_w = smooth01(0.22, 0.40, NZ)
    dark_w = np.where(sf.REG == REG_FUS, dark_w * smooth01(2.15, 2.30, S), dark_w)
    dark_w = np.where(np.isin(sf.REG, [REG_WINGU, REG_STABU, REG_FIN]), 1.0, dark_w)
    dark_w = np.where(np.isin(sf.REG, [REG_WINGL, REG_STABL]), 0.0, dark_w)
    # nose top ahead of the windscreen: dark as well; intake/lower sides light
    dark_w = np.where((sf.REG == REG_FUS) & (Z < 1.80), 0.0, dark_w)
    base = GRAY_LIGHT[None, None, :] * (1 - dark_w[..., None]) + GRAY_DARK[None, None, :] * dark_w[..., None]
    radome = (sf.REG == REG_FUS) & (S < 2.205)
    base = np.where(radome[..., None], GRAY_RADOME[None, None, :], base)
    base = to_lin(base)

    # --------------------------------------------------------------- weathering: patches, mottling, noise
    T_lat = np.where(any_ > anz, Z, Y)
    patch = world_cells(S + 0.13, T_lat + 0.07, (0.62, 0.41), 11)
    patch2 = world_cells(S, T_lat, (1.35, 0.9), 29)
    pv = (patch - 0.5) * 0.07 + (patch2 - 0.5) * 0.05
    # touch-up paint: panel-sized rectangles with a visibly different shade
    p3 = world_cells(S + 0.05, T_lat + 0.03, (0.34, 0.21), 47)
    p4 = world_cells(S + 0.05, T_lat + 0.03, (0.34, 0.21), 53)
    touch = (p3 > 0.86).astype(np.float32)
    touch = ndimage.gaussian_filter(touch, 1.0)
    pv = pv + touch * (p4 - 0.45) * 0.14
    mott = (value_noise((H, W), 96, 3) - 0.5) * 0.05 + (value_noise((H, W), 24, 5) - 0.5) * 0.025
    fine = (RNG.random((H, W)).astype(np.float32) - 0.5) * 0.018
    lum = 1.0 + pv + mott + fine
    # slight blue/green tint variation typical of repainted panels
    tint = np.stack([1.0 - 0.012 * (patch - 0.5), 1.0 + 0.006 * (patch2 - 0.5), 1.0 + 0.015 * (patch - 0.5)], -1)
    col = base * lum[..., None] * tint

    # panel lines: dark core + subtle light rim
    rim = np.clip(ndimage.gaussian_filter(lines, 1.4) - lines, 0, 1)
    col = col * (1 - 0.30 * lines[..., None]) * (1 + 0.04 * rim[..., None])

    # grime streaks trailing aft of panel lines
    streak = directional_smear(lines, sf.AFT.astype(np.float32), 60, 22.0)
    streak_n = value_noise((H, W), 8, 17)
    grime = np.clip(streak * 2.2 * (0.4 + 0.8 * streak_n), 0, 1)
    col = col * (1 - ((0.10 + 0.06 * smooth01(0.2, 0.8, NZ)) * grime)[..., None])

    # exhaust / heat soot on the aft fuselage and strakes
    soot = smooth01(12.7, 13.9, S) * (sf.REG == REG_FUS) * (0.6 + 0.4 * smooth01(2.3, 1.4, Z))
    soot = soot * (0.7 + 0.5 * value_noise((H, W), 40, 23))
    soot_col = to_lin(srgb('#4a4640'))
    col = col * (1 - 0.55 * soot[..., None]) + soot_col[None, None, :] * 0.55 * soot[..., None] * 0.35
    # underside fluid stains around gear wells
    belly = (sf.REG == REG_FUS) & (NZ < -0.5) & (S > 5.0) & (S < 10.5)
    stain = belly * value_noise((H, W), 60, 31) * 0.5
    col = col * (1 - 0.12 * stain[..., None])
    # gun port soot (left LEX root, above the wing): M61 port at s~5.75
    gun = (sf.SIDE < 0) & (sf.REG == REG_FUS)
    gd = np.hypot((S - 5.95) / 0.9, (Z - 2.18) / 0.10)
    gsoot = gun * np.clip(1 - gd, 0, 1) * smooth01(5.55, 5.8, S)
    col = col * (1 - 0.6 * gsoot[..., None])

    # leading-edge wear (wings): lighter scuffs near the LE
    le_d = np.where(np.isin(sf.REG, [REG_WINGU, REG_WINGL]), S - PT.wing_le(np.clip(np.abs(Y), 0.8, 4.61)), 9)
    wear = smooth01(0.06, 0.0, le_d) * value_noise((H, W), 6, 41)
    col = col * (1 + 0.10 * wear[..., None])

    # --------------------------------------------------------------- rivets (height & tiny color)
    rivet = np.zeros((H, W), np.float32)
    # rivet rows = panel lines offset: approximate by thin ring around the lines, modulated by a dot pattern
    ring = np.clip(ndimage.gaussian_filter(lines, 2.6) * 3.0 - lines * 2.0, 0, 1)
    yy, xx = np.mgrid[0:H, 0:W]
    dots = ((xx % 6 < 2) & (yy % 6 < 2)).astype(np.float32)
    dots = ndimage.gaussian_filter(dots, 0.6)
    rivet = ring * dots
    col = col * (1 - 0.10 * rivet[..., None])
    del yy, xx
    print(f'[tex] paint {time.time() - t0:.1f}s')

    # --------------------------------------------------------------- markings overlay (RGBA, sRGB space)
    ov = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    k = LY.K_FUS
    kt = LY.K_TAIL
    INS = tuple(int(c * 255) for c in GRAY_INSIG) + (255,)
    BLACKISH = (38, 40, 42, 255)
    MK = MARKINGS
    # tail code + serial + unit band on both fin sides
    for name in ('FIN_R', 'FIN_L'):
        # tail code (two letters)
        cx, cy = LY.planar_px(name, *MK['tail_code_pos'], *LY.PLANAR_FLIPS[name])
        st = text_stamp(MK['tail_code'], 0.56 * kt, BLACKISH, FONT_BOLD)
        st = st.resize((int(st.width * 1.08), st.height))
        paste(ov, st, cx, cy)
        # serial: small stacked AF / fiscal year + large last three digits
        bx, by = LY.planar_px(name, 13.34, 3.62, *LY.PLANAR_FLIPS[name])
        paste(ov, text_stamp('AF', 0.075 * kt, BLACKISH, FONT_BOLD), bx - 0.23 * kt, by - 0.045 * kt)
        paste(ov, text_stamp(MK['serial_fy'], 0.075 * kt, BLACKISH, FONT_BOLD), bx - 0.23 * kt, by + 0.045 * kt)
        paste(ov, text_stamp(MK['serial_no'], 0.17 * kt, BLACKISH, FONT_BOLD), bx + 0.03 * kt, by)
        # unit band at the top of the fin with its title (local opt-in only)
        ub = MK.get('unit_band')
        if ub:
            band = Image.new('RGBA', ov.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(band)
            poly = []
            for s_, z_ in ((PT.fin_le(4.72), 4.72), (PT.fin_te(4.72) + 0.02, 4.72), (15.08, 5.24), (13.6, 5.24)):
                poly.append(LY.planar_px(name, s_, z_, *LY.PLANAR_FLIPS[name]))
            d.polygon(poly, fill=tuple(ub['rgb']) + (255,))
            for zz in (4.72,):
                a = LY.planar_px(name, PT.fin_le(zz), zz, *LY.PLANAR_FLIPS[name])
                b = LY.planar_px(name, PT.fin_te(zz) + 0.02, zz, *LY.PLANAR_FLIPS[name])
                d.line([a, b], fill=(20, 20, 20, 255), width=max(2, int(0.012 * kt)))
            ov.alpha_composite(band)
            if ub.get('text'):
                tx, ty = LY.planar_px(name, 14.05, 4.86, *LY.PLANAR_FLIPS[name])
                ink = tuple(ub.get('text_rgb', (235, 235, 230))) + (255,)
                paste(ov, text_stamp(ub['text'], 0.085 * kt, ink, FONT_BOLD), tx, ty)
        # small unit data block (local opt-in only)
        if MK.get('unit'):
            dx, dy = LY.planar_px(name, 12.2, 3.25, *LY.PLANAR_FLIPS[name])
            paste(ov, text_stamp(MK['unit'], 0.045 * kt, BLACKISH, FONT_BOLD), dx, dy)
    # coloured fin cap (FCAP region; local opt-in only)
    if MK.get('fin_cap_rgb'):
        r = LY.REGIONS['FCAP']
        ImageDraw.Draw(ov).rectangle([r['x0'], r['y0'], r['x0'] + r['w'], r['y0'] + r['h']],
                                     fill=tuple(MK['fin_cap_rgb']) + (255,))

    # national insignia (generic roundel unless the local markings plugin draws one): intake sides + upper left wing +
    # lower right wing
    for side_, sg in (('R', 1), ('L', -1)):
        cx, cy = fus_px_at(side_, 6.25, sg * 0.79, 1.36)
        paste(ov, insignia(int(0.34 * k), INS), cx, cy)
    cx, cy = LY.planar_px('WU_L', 9.35, 3.05, *LY.PLANAR_FLIPS['WU_L'])
    paste(ov, insignia(int(0.52 * LY.K_WING), INS), cx, cy, angle=90)
    cx, cy = LY.planar_px('WL_R', 9.35, 3.05, *LY.PLANAR_FLIPS['WL_R'])
    paste(ov, insignia(int(0.52 * LY.K_WING), INS), cx, cy, angle=90)

    # ejection-seat warning triangles + rescue markings below the canopy (both sides)
    for side_, sg in (('R', 1), ('L', -1)):
        cx, cy = fus_px_at(side_, 4.35, sg * 0.55, 2.22)
        paste(ov, warning_triangle(int(0.10 * k)), cx, cy)
        rx, ry = fus_px_at(side_, 3.55, sg * 0.58, 2.14)
        box = Image.new('RGBA', (int(0.30 * k), int(0.09 * k)), (0, 0, 0, 0))
        d = ImageDraw.Draw(box)
        d.rectangle([0, 0, box.width - 1, box.height - 1], outline=(40, 40, 40, 255), width=2)
        f = ImageFont.truetype(FONT_BOLD, int(0.035 * k))
        d.text((box.width / 2, box.height * 0.36), 'RESCUE', font=f, fill=(215, 170, 25, 255), anchor='mm')
        f2 = ImageFont.truetype(FONT_REG, int(0.018 * k))
        d.text((box.width / 2, box.height * 0.76), 'CANOPY JETTISON  -  PULL', font=f2, fill=(35, 35, 35, 255), anchor='mm')
        paste(ov, box, rx, ry)
        # arrow toward the canopy handle
        ax_, ay_ = fus_px_at(side_, 3.85, sg * 0.56, 2.18)
        ImageDraw.Draw(ov).line([(rx + (0.16 * k if side_ == 'L' else -0.16 * k), ry), (ax_, ay_)], fill=(215, 170, 25, 255), width=3)
        # intake danger chevrons
        ix, iy = fus_px_at(side_, 4.95, sg * 0.77, 1.46)
        st = text_stamp('DANGER', 0.035 * k, (190, 30, 25, 255), FONT_BOLD)
        paste(ov, st, ix, iy)
        st = text_stamp('ENGINE INTAKE', 0.022 * k, (40, 40, 40, 255), FONT_BOLD)
        paste(ov, st, ix, iy + 0.035 * k)
        # formation light strips (fuselage sides under the canopy, aft fuselage)
        for (s_a, s_b, zz) in ((3.25, 3.60, 2.05), (12.25, 12.62, 2.28)):
            p0 = fus_px_at(side_, s_a, sg * 0.6, zz)
            p1 = fus_px_at(side_, s_b, sg * 0.6, zz)
            ImageDraw.Draw(ov).line([p0, p1], fill=(196, 206, 170, 255), width=int(0.05 * k))
        # tiny data stencils (fuel, ground points)
        for (s_, zz, txt) in ((2.95, 1.75, MK['data_stencil']), (7.35, 1.55, 'JP-8 / NATO F-34'), (9.6, 1.35, 'GROUND HERE'),
                              (5.55, 1.62, 'NAV LT'), (11.4, 1.45, 'HYD ACCESS'), (2.45, 1.9, 'RADOME')):
            px, py = fus_px_at(side_, s_, sg * 0.8, zz)
            paste(ov, text_stamp(txt, 0.022 * k, (48, 50, 52, 230), FONT_NARROW), px, py)
    # refuelling receptacle markings on the spine (behind the canopy)
    for side_ in ('R', 'L'):
        pts = []
        for (s_, yy) in ((6.55, 0.0), (6.55, 0.16), (7.20, 0.13), (7.35, 0.0)):
            pts.append(LY.fus_px(side_, s_, fus_arc_at(side_, s_, yy, FU.surface_point(s_, yy))))
        d = ImageDraw.Draw(ov)
        d.line(pts, fill=(222, 222, 215, 255), width=int(0.018 * k))
        a = LY.fus_px(side_, 6.62, 0.0); b = LY.fus_px(side_, 7.12, fus_arc_at(side_, 7.12, 0.07, FU.surface_point(7.12, 0.07)))
        d.rectangle([min(a[0], b[0]), a[1], max(a[0], b[0]), b[1]], fill=(70, 72, 74, 255))
    # NO STEP stencils on wings, stabs, LEX
    for name, pos in (('WU_R', [(9.9, 2.4), (10.5, 2.6), (10.45, 1.6)]), ('WU_L', [(9.9, 2.4), (10.5, 2.6), (10.45, 1.6)]),
                      ('SU_R', [(13.6, 0.8)]), ('SU_L', [(13.6, 0.8)])):
        for s_, t_ in pos:
            cx, cy = LY.planar_px(name, s_, t_, *LY.PLANAR_FLIPS[name])
            paste(ov, text_stamp('NO STEP', 0.04 * LY.K_WING, (40, 42, 44, 235), FONT_BOLD), cx, cy, angle=90)
    # walkway outline on the wing roots (upper)
    for name in ('WU_R', 'WU_L'):
        d = ImageDraw.Draw(ov)
        pts = [LY.planar_px(name, s_, t_, *LY.PLANAR_FLIPS[name]) for s_, t_ in ((8.0, 1.40), (9.6, 1.40), (9.6, 1.9), (8.3, 1.9), (8.0, 1.40))]
        d.line(pts, fill=(45, 47, 49, 230), width=3)
    # composite overlay (sRGB) onto linear color
    ova = np.asarray(ov, np.float32) / 255.0
    oa = ova[..., 3:4]
    ocol = to_lin(ova[..., :3])
    # markings are paint too: weather them with the same luminance variation
    ocol = ocol * (0.92 + 0.08 * lum[..., None])
    col = col * (1 - oa) + ocol * oa
    mark_mask = oa[..., 0]
    print(f'[tex] markings {time.time() - t0:.1f}s')

    # baked ambient occlusion (from build.py --bake): subtle multiply into the color, full strength in ORM.R
    aopath = os.path.join(OUT, 'skin_ao.png')
    if not os.path.exists(aopath):
        aopath = os.path.join(DEFAULT_OUT, 'skin_ao.png')
    AO = None
    if os.path.exists(aopath):
        AO = np.asarray(Image.open(aopath).convert('L').resize((W, H), Image.BILINEAR), np.float32) / 255.0
        AO = np.where(valid, AO, 1.0)
        col = col * (0.62 + 0.38 * AO)[..., None]
    # fill invalid texels with the average to avoid dark seams (dilate valid colors)
    cols = to_srgb(col)
    if True:
        inv = ~valid
        idx = ndimage.distance_transform_edt(inv, return_distances=False, return_indices=True)
        cols = cols[idx[0], idx[1]]
    img = Image.fromarray((np.clip(cols, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
    img.save(os.path.join(OUT, 'skin_color.jpg'), quality=92)

    # --------------------------------------------------------------- height -> normal
    hgt = -1.0 * lines - 0.35 * rim * 0 + 0.55 * rivet
    hgt += 0.05 * (patch - 0.5) * smooth01(0.0, 0.1, lines)  # tiny panel steps
    hgt = ndimage.gaussian_filter(hgt, 0.7)
    gx = ndimage.sobel(hgt, axis=1) / 8.0
    gy = ndimage.sobel(hgt, axis=0) / 8.0
    strength = 2.2
    nx_ = -gx * strength
    ny_ = gy * strength
    nz_ = np.ones_like(nx_)
    nl = np.sqrt(nx_ ** 2 + ny_ ** 2 + nz_ ** 2)
    nrm = np.stack([nx_ / nl, ny_ / nl, nz_ / nl], -1)
    nimg = ((nrm * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(nimg, 'RGB').save(os.path.join(OUT, 'skin_normal.png'), optimize=False, compress_level=6)

    # --------------------------------------------------------------- ORM
    rough = 0.56 + 0.06 * (patch - 0.5) + 0.05 * (mott / 0.05) + 0.10 * grime + 0.12 * soot - 0.06 * mark_mask
    rough = np.where(radome, rough - 0.08, rough)
    rough = np.clip(rough, 0.3, 0.9)
    ao = np.ones_like(rough) if AO is None else np.clip(AO, 0.2, 1.0)
    metal = np.zeros_like(rough)
    orm = np.stack([ao, rough, metal], -1)
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8), 'RGB').resize((2048, 2048), Image.LANCZOS).save(os.path.join(OUT, 'skin_orm.png'))
    # debug preview
    img.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'skin_color_preview.jpg'), quality=85)
    print(f'[tex] done {time.time() - t0:.1f}s')


if __name__ == '__main__' and '--nozzle' not in sys.argv:
    main()


def nozzle_texture(n_petals=14, size=1024):
    """Petal atlas: u = around (n_petals columns), v: outer skin [0,0.5] front->aft, inner [0.5,1]."""
    rng = np.random.default_rng(77)
    Hh, Ww = size, size
    yy, xx = np.mgrid[0:Hh, 0:Ww].astype(np.float32)
    u = xx / Ww
    v = 1.0 - yy / Hh                     # glTF/Blender V up
    pet = (u * n_petals) % 1.0            # position across a petal
    outer = v < 0.5
    t = np.where(outer, v / 0.5, (v - 0.5) / 0.5)   # 0 = hinge (front), 1 = exit
    streak = ndimage.gaussian_filter(rng.random((Hh, Ww)).astype(np.float32), (18, 0.8))
    streak = (streak - streak.mean()) / (streak.std() + 1e-6)
    base_o = srgb('#6d6a66')
    blue = srgb('#5f6680')
    bronze = srgb('#8a7458')
    gold = srgb('#9a8660')
    soot = srgb('#2b2927')
    col = np.zeros((Hh, Ww, 3), np.float32)
    # outer: gray-bronze titanium with heat bands (blue near the hinge, bronze/gold toward the exit)
    w_blue = smooth01(0.35, 0.0, t)
    w_bronze = smooth01(0.2, 0.7, t) * (1 - smooth01(0.85, 1.0, t))
    w_gold = smooth01(0.75, 1.0, t)
    c_out = base_o[None, None] * (1 - w_blue - 0.6 * w_bronze - 0.4 * w_gold)[..., None] + blue[None, None] * w_blue[..., None] \
        + bronze[None, None] * (0.6 * w_bronze)[..., None] + gold[None, None] * (0.4 * w_gold)[..., None]
    c_in = soot[None, None] * (0.7 + 0.3 * t)[..., None] + srgb('#6a5a48')[None, None] * (0.25 * smooth01(0.4, 1.0, t))[..., None]
    col = np.where(outer[..., None], c_out, c_in)
    col = col * (1 + 0.06 * streak)[..., None]
    # petal edges (seams) darker, central stiffener lighter
    edge = np.minimum(pet, 1 - pet)
    col = col * (1 - 0.45 * smooth01(0.035, 0.0, edge))[..., None]
    col = col * (1 + 0.08 * np.exp(-((pet - 0.5) / 0.03) ** 2))[..., None]
    # per-petal tone variation
    pid = np.floor(u * n_petals).astype(int)
    tone = rng.normal(0, 0.035, n_petals + 1)[pid]
    col = col * (1 + tone)[..., None]
    img = Image.fromarray((np.clip(col, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
    img.save(os.path.join(OUT, 'nozzle_color.jpg'), quality=90)
    print('[tex] nozzle texture')


if __name__ == '__main__' and '--nozzle' in sys.argv:
    nozzle_texture()
