"""Livery / surface texture painter for the 737-800 "Gökyüzü Hava Yolları" (TC-GKB).

Run with the repo venv (numpy, pillow, scipy):
    .venv/bin/python blender/aircraft/b737/textures.py [fus wing tail stab nac misc lod]
    (GOKYUZU_TEX_OUT=<dir>: write elsewhere than blender/aircraft/b737/tex/)

Livery: the fictional 'gokyuzu' house livery below. LIVERY=<name> (or B737_LIVERY=<name>) paints a local livery module
instead, <brand dir>/liveries/b737/<name>.py (outside git, blender/common/brand.py). A livery module may provide
(T = this module; each replaces that part of the built-in livery):
  fuselage_paint(T, col, X, Y, Z) -> col          base paint of the fuselage (the built-in: blue belly + cheatlines)
  side_decals(T, cv, mirror, PPM) -> (x, z0, z1, w)  titles / registration on a side canvas; returns the flag box
  emblem(T, size) -> RGBA image                   fin and winglet emblem (the built-in: logo_image)
  WINGLET / FIN / STAB / NACELLE                  dicts overriding the built-in part parameters (see part() calls)

Every texel is evaluated on the same analytic surfaces as the Blender geometry (shape.py), so livery
lines, windows and doors are painted in 3D space and land exactly where the geometry is.
Outputs: blender/aircraft/b737/tex/*.jpg (base colour sRGB, ORM = (1, rough, metal), tangent normal).
"""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.ndimage import map_coordinates, gaussian_filter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.append(os.path.join(HERE, '..', '..', 'common'))
import shape as S
import brand

TEX = os.environ.get('GOKYUZU_TEX_OUT') or os.path.join(HERE, 'tex')
os.makedirs(TEX, exist_ok=True)
RNG = np.random.default_rng(737)

AVENIR = '/System/Library/Fonts/Avenir Next.ttc'
HELV = '/System/Library/Fonts/HelveticaNeue.ttc'
FUTURA = '/System/Library/Fonts/Supplemental/Futura.ttc'


def srgb(c):
    return np.array(c, np.float32) / 255.0


WHITE = srgb((236, 238, 240))
BLUE = srgb((12, 38, 92))
BLUE2 = srgb((20, 62, 138))      # lighter accent blue
ORANGE = srgb((243, 132, 28))
GREY_WING = srgb((146, 151, 157))
GREY_WING_LO = srgb((160, 164, 169))
METAL = srgb((200, 203, 207))
DARK = srgb((24, 26, 30))
RED = srgb((200, 30, 30))
GLASS = srgb((22, 30, 40))


# ------------------------------------------------------------------ helpers
def noise(h, w, cells_y, cells_x, seed=None, order=3):
    rng = np.random.default_rng(seed) if seed is not None else RNG
    small = rng.random((max(2, cells_y), max(2, cells_x))).astype(np.float32)
    im = Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return np.asarray(im, np.float32) / 255.0


def fbm(h, w, base_y, base_x, octaves=5, seed=0, gain=0.5):
    acc = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        acc += amp * noise(h, w, base_y * 2 ** o, base_x * 2 ** o, seed=seed + o)
        tot += amp
        amp *= gain
    return acc / tot


def aa(d, width):
    """Anti-aliased step: 1 where d > 0 (d in metres, width = transition in metres)."""
    return np.clip(d / width + 0.5, 0.0, 1.0).astype(np.float32)


def lerp(a, b, t):
    t = t[..., None] if t.ndim == a.ndim - 1 or (a.ndim == 3 and t.ndim == 2) else t
    return a + (b - a) * t


def mix(img, color, alpha):
    """img (H,W,3), color (3,) or (H,W,3), alpha (H,W)."""
    a = alpha[..., None]
    return img * (1 - a) + np.asarray(color, np.float32) * a


def normal_from_height(Hm, strength):
    """Tangent-space normal map from a height field (metres-ish scaled). Row 0 = top (v = 1)."""
    gx = (np.roll(Hm, -1, 1) - np.roll(Hm, 1, 1)) * 0.5
    gy = (np.roll(Hm, 1, 0) - np.roll(Hm, -1, 0)) * 0.5     # +v is up (previous row)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(Hm)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)


def save_rgb(arr, name, size=None, q=90):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)) if arr.dtype != np.uint8 else Image.fromarray(arr)
    if size:
        im = im.resize(size, Image.LANCZOS)
    p = os.path.join(TEX, name + '.jpg')
    im.save(p, quality=q, subsampling=0 if q >= 90 else 2)
    print('  wrote', p, im.size)


def orm(rough, metal, ao=None):
    h, w = rough.shape
    a = np.ones((h, w), np.float32) if ao is None else ao
    return np.stack([a, rough, metal], -1)


def font(path, size, index=0):
    return ImageFont.truetype(path, int(size), index=index)


class Canvas:
    """Side-projection canvas in metres: x = X (station) or mirrored, y = Z (height)."""

    def __init__(self, x0, x1, z0, z1, ppm, mode='RGBA'):
        self.x0, self.x1, self.z0, self.z1, self.ppm = x0, x1, z0, z1, ppm
        self.W = int((x1 - x0) * ppm)
        self.H = int((z1 - z0) * ppm)
        self.im = Image.new(mode, (self.W, self.H), (0, 0, 0, 0) if mode == 'RGBA' else 0)
        self.d = ImageDraw.Draw(self.im)

    def p(self, x, z):
        return ((x - self.x0) * self.ppm, (self.z1 - z) * self.ppm)

    def rrect(self, x0, z0, x1, z1, r, fill=None, outline=None, width=0):
        a = self.p(x0, z1); b = self.p(x1, z0)
        self.d.rounded_rectangle([a, b], radius=r * self.ppm, fill=fill, outline=outline, width=int(round(width * self.ppm)))

    def text(self, x, z_base, s, fnt, fill, anchor='ls'):
        self.d.text(self.p(x, z_base), s, font=fnt, fill=fill, anchor=anchor)

    def sample(self, X, Z, mirror=False):
        """Bilinear sample -> float array (H,W,C) in 0..1."""
        arr = np.asarray(self.im, np.float32) / 255.0
        if arr.ndim == 2:
            arr = arr[..., None]
        px = (X - self.x0) * self.ppm - 0.5
        if mirror:
            px = (self.x1 - X) * self.ppm - 0.5
        py = (self.z1 - Z) * self.ppm - 0.5
        out = np.zeros(X.shape + (arr.shape[2],), np.float32)
        if arr.shape[2] == 4:
            arr = arr.copy()
            arr[..., :3] *= arr[..., 3:4]          # premultiply so edges do not darken
        for c in range(arr.shape[2]):
            out[..., c] = map_coordinates(arr[..., c], [py, px], order=1, mode='constant', cval=0.0)
        if arr.shape[2] == 4:
            out[..., :3] /= np.maximum(out[..., 3:4], 1e-4)
        return out


def dilate(im, r_px):
    from scipy.ndimage import distance_transform_edt
    a = np.asarray(im) > 127
    d = distance_transform_edt(~a)
    return Image.fromarray((np.clip(r_px + 0.5 - d, 0, 1) * 255).astype(np.uint8))


# ------------------------------------------------------------------ livery (built-in fictional or a local module)
LIV = brand.livery_module('b737', 'B737_LIVERY')      # None: the built-in fictional livery


def hook(name):
    """The livery module's replacement for a built-in part (a function), or None."""
    return getattr(LIV, name, None)


def part(name, **builtin):
    """Parameters of one livery part: the built-in values, updated by the livery module's <name> dict."""
    d = dict(builtin)
    d.update(getattr(LIV, name, None) or {})
    return d


def colour(c):
    """sRGB 0..1 array from a float array or a 0..255 tuple."""
    return c if isinstance(c, np.ndarray) else srgb(c)


def emblem(size):
    return LIV.emblem(sys.modules[__name__], size) if hook('emblem') else logo_image(size)


def logo_image(size=1024):
    """Gökyüzü emblem: orange sun disc crossed by a white stylised swift (sky bird). RGBA."""
    s = size
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    o = tuple(int(c * 255) for c in ORANGE)
    # sun
    d.ellipse([s * 0.14, s * 0.12, s * 0.86, s * 0.84], fill=o + (255,))
    # swift: two crescent wings + body, built from ellipse differences
    wing = Image.new('L', (s, s), 0)
    wd = ImageDraw.Draw(wing)
    wd.ellipse([s * -0.05, s * 0.30, s * 0.82, s * 1.05], fill=255)
    wd.ellipse([s * 0.02, s * 0.38, s * 0.90, s * 1.12], fill=0)
    wing2 = Image.new('L', (s, s), 0)
    wd2 = ImageDraw.Draw(wing2)
    wd2.ellipse([s * 0.30, s * 0.05, s * 1.12, s * 0.78], fill=255)
    wd2.ellipse([s * 0.22, s * 0.13, s * 1.04, s * 0.86], fill=0)
    body = Image.new('L', (s, s), 0)
    bd = ImageDraw.Draw(body)
    bd.polygon([(s * 0.30, s * 0.62), (s * 0.62, s * 0.36), (s * 0.70, s * 0.40), (s * 0.40, s * 0.66)], fill=255)
    mask = Image.fromarray(np.maximum.reduce([np.asarray(wing), np.asarray(wing2), np.asarray(body)]))
    # keep the swift inside a slightly larger circle than the sun
    clip = Image.new('L', (s, s), 0)
    ImageDraw.Draw(clip).ellipse([s * 0.02, s * 0.0, s * 0.98, s * 0.96], fill=255)
    mask = Image.fromarray(np.minimum(np.asarray(mask), np.asarray(clip)))
    white = Image.new('RGBA', (s, s), (245, 246, 248, 255))
    im.paste(white, (0, 0), mask)
    return im


# ================================================================== FUSELAGE
def fus_grid(W, H):
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H
    X1 = u * S.LENGTH
    th1 = 2 * np.pi * v - np.pi                     # inverse of fus_uv
    p = S.fus_profiles(X1)
    Y, Z = S.fus_point_grid(X1, th1)
    X = np.broadcast_to(X1[None], Y.shape)
    TH = np.broadcast_to(th1[:, None], Y.shape)
    # 2D section normal (outward) from theta derivatives
    dY = np.gradient(Y, axis=0); dZ = np.gradient(Z, axis=0)
    ny, nz = -dZ, dY
    nrm = np.hypot(ny, nz) + 1e-9
    ny, nz = ny / nrm, nz / nrm
    sgn = np.sign(ny * Y + nz * (Z - p['zm'][None]) + 1e-9)
    ny, nz = ny * sgn, nz * sgn
    return X.astype(np.float32), Y.astype(np.float32), Z.astype(np.float32), TH.astype(np.float32), ny, nz


def paint_fuselage(W=4096, H=2048):
    print('fuselage', W, H)
    X, Y, Z, TH, ny, nz = fus_grid(W, H)
    texel = S.LENGTH / W
    col = np.broadcast_to(WHITE, (H, W, 3)).copy()
    height = np.zeros((H, W), np.float32)
    rough = np.full((H, W), 0.26, np.float32)
    metal = np.zeros((H, W), np.float32)
    # subtle large-scale paint variation
    col *= (0.985 + 0.03 * fbm(H, W, 6, 24, 4, seed=1))[..., None]
    if hook('fuselage_paint'):
        col = LIV.fuselage_paint(sys.modules[__name__], col, X, Y, Z)
    else:
        bl = S.belly_line(X)
        dbl = np.gradient(S.belly_line(X[0]), X[0])[None].repeat(H, 0)
        cosk = 1.0 / np.sqrt(1 + dbl ** 2)
        dperp = (Z - bl) * cosk                 # + above the line
        belly = 1 - aa(dperp, 0.012)
        col = mix(col, BLUE, belly)
        fade = 1 - S.smoothstep(34.2, 35.0, X)
        stripe = aa(dperp - 0.075, 0.012) * (1 - aa(dperp - 0.185, 0.012)) * fade
        col = mix(col, ORANGE, stripe)
        pin = aa(dperp - 0.215, 0.01) * (1 - aa(dperp - 0.24, 0.01)) * fade
        col = mix(col, BLUE2, pin)
    # ---- side decals on projection canvases
    PPM = 220
    side = np.abs(ny)
    for sgn, mirror in ((-1, False), (1, True)):
        cv = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM)
        if hook('side_decals'):
            fx, fz0, fz1, fw = LIV.side_decals(sys.modules[__name__], cv, mirror, PPM)
        else:
            f1 = font(AVENIR, 0.74 * PPM, 9)        # Heavy Italic
            f2 = font(AVENIR, 0.40 * PPM, 6)        # Medium Italic
            blue8 = tuple(int(c * 255) for c in BLUE) + (255,)
            oran8 = tuple(int(c * 255) for c in ORANGE) + (255,)
            t1, t2 = 'Gökyüzü', 'Hava Yolları'
            w1 = cv.d.textlength(t1, font=f1) / PPM
            w2 = cv.d.textlength(t2, font=f2) / PPM
            x_start = 7.25
            base = 3.935
            cx0 = x_start if not mirror else S.LENGTH - (x_start + w1 + 0.25 + w2)
            cv.text(cx0, base, t1, f1, blue8)
            cv.text(cx0 + w1 + 0.25, base, t2, f2, oran8)
            f3 = font(HELV, 0.30 * PPM, 1)
            reg = 'TC-GKB'
            wr = cv.d.textlength(reg, font=f3) / PPM
            rx = 28.35 if not mirror else S.LENGTH - 28.35 - wr
            cv.text(rx, 3.96, reg, f3, (20, 22, 30, 255))
            fx, fz0, fz1, fw = 27.65, 4.01, 4.25, 0.36
        fl = fx if not mirror else S.LENGTH - fx - fw
        cv.d.rectangle([cv.p(fl, fz1), cv.p(fl + fw, fz0)], fill=(227, 10, 23, 255))
        # hoist is at the nose side on both sides: canvas-left on the left side, canvas-right when mirrored
        hs = 1 if not mirror else -1
        hx = fl if not mirror else fl + fw
        fh = fz1 - fz0
        fcx, fcz = hx + hs * fh * 0.39, (fz0 + fz1) / 2
        r1 = fh * 0.25
        cv.d.ellipse([cv.p(fcx - r1, fcz + r1), cv.p(fcx + r1, fcz - r1)], fill=(255, 255, 255, 255))
        r2 = fh * 0.20
        cv.d.ellipse([cv.p(fcx - r2 + hs * fh * 0.0625, fcz + r2), cv.p(fcx + r2 + hs * fh * 0.0625, fcz - r2)], fill=(227, 10, 23, 255))
        sx, sz = fcx + hs * fh * 0.33, fcz
        pts = []
        for k_ in range(10):
            a_ = math.pi / 2 + k_ * math.pi / 5
            rr = fh * (0.125 if k_ % 2 == 0 else 0.05)
            pts.append(cv.p(sx + rr * math.cos(a_) * 0.95, sz + rr * math.sin(a_)))
        cv.d.polygon(pts, fill=(255, 255, 255, 255))
        # EXIT markings above the overwing exits (text must read correctly on each side)
        fe = font(HELV, 0.075 * PPM, 1)
        for k, (xa, xb, zs, h, sd) in S.DOORS.items():
            if not k.startswith('OW') or sd != sgn:
                continue
            wt = cv.d.textlength('EXIT', font=fe) / PPM
            ex = (xa + xb) / 2 - wt / 2
            if mirror:
                ex = S.LENGTH - ((xa + xb) / 2 + wt / 2)
            cv.text(ex, zs + h + 0.065, 'EXIT', fe, (200, 30, 30, 255))
        dec = cv.sample(X, Z, mirror=mirror)
        w = np.where((Y * sgn > 0), S.smoothstep(0.25, 0.55, side), 0.0).astype(np.float32)
        a = dec[..., 3] * w
        col = mix(col, dec[..., :3], a)
    # ---- windows, doors, panel lines via line/mask canvases (one per side, no mirroring needed)
    wins = S.window_stations()
    wins = [x for x in wins if not (S.OW_RANGE[0] < x < S.OW_RANGE[1])] + list(S.OW_WINDOWS)
    for sgn in (-1, 1):
        mk = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM, mode='L')     # window glass
        gk = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM, mode='L')     # gasket / frames
        ln = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM, mode='L')     # door gaps
        hd = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM, mode='L')     # handles, dark details
        rd = Canvas(0.0, S.LENGTH, 0.8, 5.45, PPM, mode='RGBA')  # coloured markings (exit red, text)
        ww, wh = S.WIN_WH
        for x in wins:
            gk.rrect(x - ww / 2 - 0.022, S.WIN_Z - wh / 2 - 0.022, x + ww / 2 + 0.022, S.WIN_Z + wh / 2 + 0.022, 0.085, fill=255)
            mk.rrect(x - ww / 2, S.WIN_Z - wh / 2, x + ww / 2, S.WIN_Z + wh / 2, 0.075, fill=255)
        for k, (xa, xb, zs, h, sd) in S.DOORS.items():
            if sd != sgn:
                continue
            ln.rrect(xa, zs, xb, zs + h, 0.10 if not k.startswith('OW') else 0.06, outline=255, width=0.012)
            if k.startswith('OW'):
                # overwing exit: red outline band + EXIT text
                rd.rrect(xa - 0.035, zs - 0.035, xb + 0.035, zs + h + 0.035, 0.08, outline=(200, 30, 30, 255), width=0.022)
                hd.rrect((xa + xb) / 2 - 0.06, zs + h - 0.16, (xa + xb) / 2 + 0.06, zs + h - 0.10, 0.01, fill=255)
            else:
                # handle + viewport + slide warning stripe
                hx = xb - 0.16 if sgn < 0 else xa + 0.16
                hd.rrect(hx - 0.05, zs + 1.02, hx + 0.05, zs + 1.30, 0.02, fill=255)
                vx = (xa + xb) / 2
                gk.rrect(vx - 0.065, zs + 1.40, vx + 0.065, zs + 1.53, 0.06, fill=255)
                mk.rrect(vx - 0.05, zs + 1.415, vx + 0.05, zs + 1.515, 0.05, fill=255)
                rd.rrect(xa + 0.08, zs + 0.72, xb - 0.08, zs + 0.78, 0.0, fill=(210, 40, 30, 200))
        if sgn > 0:
            for k, (xa, xb, zs, h, sd) in S.CARGO.items():
                ln.rrect(xa, zs, xb, zs + h, 0.08, outline=255, width=0.012)
                hd.rrect((xa + xb) / 2 - 0.07, zs + 0.12, (xa + xb) / 2 + 0.07, zs + 0.20, 0.01, fill=255)
        # small details: static ports, pitot plates, "no step" markers near the nose
        for (x, z) in ((4.55, 3.05), (4.55, 3.20)):
            hd.d.ellipse([hd.p(x - 0.025, z + 0.025), hd.p(x + 0.025, z - 0.025)], outline=255, width=3)
        hd.rrect(2.28, 2.93, 2.55, 3.10, 0.01, outline=255, width=0.006)
        side_w = np.where((Y * sgn > 0), S.smoothstep(0.2, 0.5, side), 0.0).astype(np.float32)
        glass = mk.sample(X, Z)[..., 0] * side_w
        gask = gk.sample(X, Z)[..., 0] * side_w
        gaps = ln.sample(X, Z)[..., 0] * side_w
        hand = hd.sample(X, Z)[..., 0] * side_w
        mark = rd.sample(X, Z) * side_w[..., None]
        col = mix(col, col * 0.72, gask * (1 - glass))
        col = mix(col, mark[..., :3], mark[..., 3])
        grad = (0.85 + 0.35 * S.smoothstep(S.WIN_Z + 0.2, S.WIN_Z - 0.2, Z))[..., None]
        col = mix(col, GLASS * grad, glass)
        col = mix(col, col * 0.35, gaps)
        col = mix(col, col * 0.55, hand)
        rough = np.where(glass > 0.5, 0.05, rough)
        height += gask * 0.35 - glass * 0.25 - gaps * 1.0 - hand * 0.4
    # ---- cockpit window dark surround (painted mask)
    for win, kind in ((S.WIN_W1, 'front'), (S.WIN_W2, 'side'), (S.WIN_W3, 'side')):
        for sgn in (-1, 1):
            if kind == 'side':
                cv = Canvas(1.5, 5.0, 2.8, 4.8, 600, mode='L')
                pts = [cv.p(x, z) for x, z in win]
                cv.d.polygon(pts, fill=255)
                cv.im = dilate(cv.im, 0.042 * 600)
                a = cv.sample(X, Z)[..., 0] * np.where(Y * sgn > 0, S.smoothstep(0.3, 0.5, side), 0)
            else:
                cv = Canvas(-1.4, 1.4, 2.8, 4.8, 600, mode='L')
                pts = [cv.p(y, z) for y, z in win]
                cv.d.polygon(pts, fill=255)
                cv.im = dilate(cv.im, 0.042 * 600)
                a = cv.sample(Y * sgn, Z)[..., 0] * np.where((Y * sgn > 0.0) & (X < 3.2), 1.0, 0.0)
            col = mix(col, DARK, a * 0.92)
    # ---- panel lines (circumferential butt joints + longitudinal lap joints)
    for xk in (1.35, 4.75, 7.05, 9.9, 12.3, 14.65, 18.45, 21.3, 24.1, 27.2, 30.35, 33.2, 36.1, 38.2):
        l = np.exp(-((X - xk) / (0.6 * texel)) ** 2)
        height -= l * 0.7
        col = mix(col, col * 0.80, l * 0.55)
    r_loc = 1.9
    for tk in (0.52, 1.02, 1.42, 1.98, 2.52, 2.88):
        for s_ in (-1, 1):
            d = np.abs(np.mod(TH - s_ * tk + np.pi, 2 * np.pi) - np.pi) * r_loc
            l = np.exp(-(d / (0.7 * texel)) ** 2) * (X > 4.8) * (X < 34.5)
            height -= l * 0.45
            col = mix(col, col * 0.86, l * 0.4)
    # rivet rows along lap joints and frames (tiny bumps, normal map only)
    riv = np.zeros((H, W), np.float32)
    pitch = 0.035
    for tk in (0.52, 1.02, 1.42, 1.98, 2.52, 2.88):
        for s_ in (-1, 1):
            for off in (-0.018, 0.018):
                d = np.abs(np.mod(TH - s_ * tk + np.pi, 2 * np.pi) - np.pi) * r_loc - abs(off)
                along = np.cos(2 * np.pi * X / pitch)
                riv += np.exp(-(d / 0.004) ** 2) * np.clip(along * 3 - 2, 0, 1) * (X > 4.8) * (X < 34.5)
    height += riv * 0.25
    # ---- radome: slightly different paint, matte
    rad = 1 - S.smoothstep(1.25, 1.35, X)
    rough = rough * (1 - rad) + 0.42 * rad
    # radome joint line
    height -= np.exp(-((X - 1.30) / (0.6 * texel)) ** 2) * 0.8
    # ---- grime & wear
    streak = noise(H, W, 400, 30, seed=11)               # streaks along the length (belly flow)
    vstreak = noise(H, W, 18, 500, seed=12)              # vertical-ish streaks on the sides
    low = S.smoothstep(2.6, 1.5, Z) * S.smoothstep(12.0, 18.0, X) * (0.6 + 0.4 * S.smoothstep(30.0, 22.0, X))
    grime = low * (0.25 + 0.75 * streak) * 0.45
    side_grime = (S.smoothstep(0.4, 0.9, side) * S.smoothstep(4.4, 2.5, Z) * np.clip(vstreak - 0.5, 0, 1) * 0.22
                  * (0.2 + 0.8 * fbm(H, W, 3, 14, 3, seed=13)))
    tail_soot = S.smoothstep(37.6, 39.4, X) * 0.85
    dirt = np.clip(grime + side_grime + fbm(H, W, 10, 40, 4, seed=5) * 0.06, 0, 1)
    grime_col = srgb((96, 88, 74))
    col = mix(col, col * grime_col * 1.45, dirt)
    col = mix(col, DARK * 0.8, tail_soot * (0.5 + 0.5 * noise(H, W, 30, 60, seed=9)))
    rough = np.clip(rough + dirt * 0.35 + tail_soot * 0.3, 0.04, 1)
    # ---- write
    save_rgb(col, 'fus_base', q=92)
    save_rgb(orm(rough, metal), 'fus_orm', size=(W // 2, H // 2), q=90)
    nm = normal_from_height(gaussian_filter(height, 0.6), 1.2)
    Image.fromarray(nm).save(os.path.join(TEX, 'fus_nrm.jpg'), quality=92)
    print('  wrote fus_nrm')


# ================================================================== WING
def wing_grid(W, H):
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H
    l = u * S.W_LEND
    st = S.wing_station(l)
    d = (v - 0.5) * 2 * S.WING_UV_D                   # + upper
    upper = d[:, None] > 0
    a = np.abs(d)[:, None] / st['c'][None]
    t = np.where(upper, S.airfoil_arc_inv(a, True), S.airfoil_arc_inv(a, False))
    valid = a <= np.where(upper, S.airfoil_arc(1.0, True), S.airfoil_arc(1.0, False))
    stb = {k: np.broadcast_to(v_[None], t.shape) for k, v_ in st.items()}
    x2, y2 = S.airfoil(t, stb['tc'], stb['camber'], upper)
    X, Y, Z = S.section_to_3d(stb, x2, y2)
    L = np.broadcast_to(l[None], t.shape)
    return X, Y, Z, t, upper, valid, L, stb


def paint_wing(W=4096, H=2048):
    print('wing', W, H)
    X, Y, Z, t, upper, valid, L, st = wing_grid(W, H)
    texel = S.W_LEND / W
    col = np.where(upper[..., None], GREY_WING, GREY_WING_LO).astype(np.float32) * np.ones((H, W, 3), np.float32)
    col *= (0.975 + 0.05 * fbm(H, W, 16, 60, 4, seed=21))[..., None]
    rough = np.full((H, W), 0.42, np.float32)
    metal = np.full((H, W), 0.05, np.float32)
    height = np.zeros((H, W), np.float32)
    Yabs = np.abs(Y)
    # control surface regions tinted slightly
    xcut = S.wing_xcut(np.minimum(Yabs, 16.12))
    aft = (X > xcut + 0.02) & (Yabs < 16.12)
    col = np.where(aft[..., None], col * 1.03, col)
    # hinge / cut lines
    cutl = np.exp(-((X - xcut) / 0.012) ** 2) * (Yabs < 16.12)
    height -= cutl * 1.0
    col = mix(col, col * 0.55, cutl * 0.8)
    # spoiler outlines (upper surface)
    for a_, b_ in S.W_SPOILERS:
        xa = S.wing_xcut(np.clip(Yabs, a_, b_)) - S.W_SPOILER_CHORD
        inside = upper & (Yabs > a_) & (Yabs < b_)
        e = np.exp(-((X - xa) / 0.012) ** 2) * inside
        e += (np.exp(-((Yabs - a_) / 0.012) ** 2) + np.exp(-((Yabs - b_) / 0.012) ** 2)) * upper * (X > xa) * (X < xcut)
        height -= e
        col = mix(col, col * 0.6, np.clip(e, 0, 1) * 0.7)
    # leading edge: bare polished metal on the slat span and the outer LE
    le_up = upper & (t < S.W_SLAT_T)
    le_lo = (~upper) & (t < 0.045)
    le = (le_up | le_lo) & (Yabs > 1.9) & (L < S.W_LA + 0.2)
    lef = le.astype(np.float32)
    col = mix(col, METAL * (0.96 + 0.08 * noise(H, W, 8, 200, seed=33))[..., None], lef)
    rough = np.where(le, 0.18, rough)
    metal = np.where(le, 1.0, metal)
    # slat gaps
    for a_, b_ in S.W_SLATS:
        e = (np.exp(-((Yabs - a_) / 0.01) ** 2) + np.exp(-((Yabs - b_) / 0.01) ** 2)) * le
        height -= e
        col = mix(col, col * 0.5, e * 0.8)
    # spars and ribs (subtle lines)
    for f in (0.15, 0.62):
        e = np.exp(-((t - f) * st['c'] / (0.8 * texel * 1.5)) ** 2) * (L < S.W_LA)
        height -= e * 0.5
        col = mix(col, col * 0.9, e * 0.35)
    rib = np.abs(((Yabs / 0.62) % 1.0) - 0.5) * 0.62
    e = np.exp(-((0.31 - rib) / 0.006) ** 2) * (t > 0.15) * (t < 0.62) * (L < S.W_LA) * 0.35
    height -= e * 0.4
    # rivet lines along spars
    along = np.clip(np.cos(2 * np.pi * Yabs / 0.04) * 3 - 2, 0, 1)
    for f in (0.15, 0.62):
        dd = np.abs((t - f) * st['c'])
        for off in (0.015, -0.015):
            height += np.exp(-((dd - abs(off)) / 0.004) ** 2) * along * 0.25 * (L < S.W_LA)
    # walkway outline (black) on the inboard upper surface
    wk = upper & (Yabs > 1.95) & (Yabs < 4.35) & (t > 0.22) & (t < 0.58)
    wk_in = upper & (Yabs > 2.02) & (Yabs < 4.28) & (t > 0.235) & (t < 0.565)
    walk = (wk & ~wk_in).astype(np.float32)
    col = mix(col, DARK, walk * 0.95)
    col = mix(col, col * 0.93, wk_in.astype(np.float32) * 0.6)  # slightly darker non-slip area
    rough = np.where(wk_in, 0.7, rough)
    # access panels on the lower surface
    for yk in np.arange(2.6, 15.5, 1.3):
        pa = (~upper) & (np.abs(Yabs - yk) < 0.22) & (np.abs(t - 0.42) * st['c'] < 0.18 * np.clip(st['c'] / 4.0, 0.4, 1))
        edge = pa & ~((~upper) & (np.abs(Yabs - yk) < 0.205) & (np.abs(t - 0.42) * st['c'] < 0.18 * np.clip(st['c'] / 4.0, 0.4, 1) - 0.015))
        height -= edge.astype(np.float32) * 0.8
        col = mix(col, col * 0.75, edge.astype(np.float32) * 0.6)
    # fuel cap
    fc = (~upper) & (np.hypot(Yabs - 12.8, (t - 0.35) * st['c']) < 0.06)
    col = mix(col, col * 0.6, fc.astype(np.float32))
    # ---- winglet livery: blue with the logo, orange tip band
    wl = S.smoothstep(S.W_LA + 0.15, S.W_LA + 0.55, L)
    WL = part('WINGLET', color=BLUE, size=0.56, s=0.72, tip_band=True)
    col = mix(col, colour(WL['color']), wl)
    rough = rough * (1 - wl) + 0.28 * wl
    metal = metal * (1 - wl)
    # winglet LE metal strip
    wle = (t < 0.05) & (L > S.W_LA + 0.3)
    col = mix(col, METAL, wle.astype(np.float32))
    metal = np.where(wle, 1.0, metal)
    rough = np.where(wle, 0.2, rough)
    # logo on both faces of the straight winglet
    logo = emblem(1024)
    lg = np.asarray(logo, np.float32) / 255.0
    # winglet local coords: along the winglet (s) and chordwise (X - X_LE)
    s_w = (L - S.W_LB)
    xl = (X - st['X'])
    for face in (True, False):
        m = (upper == face) & (s_w > 0.05)
        # centre at s=0.75 m, x = 0.45 * chord ; size 0.75 m
        sz = WL['size']
        cu = (xl - 0.50 * st['c']) / sz + 0.5
        if not face:
            cu = cu
        else:
            cu = 1 - cu
        cvv = 1 - ((s_w - WL['s']) / sz + 0.5)
        ok = m & (cu >= 0) & (cu < 1) & (cvv >= 0) & (cvv < 1)
        iu = np.clip((cu * 1023).astype(int), 0, 1023)
        iv = np.clip((cvv * 1023).astype(int), 0, 1023)
        samp = lg[iv, iu]
        a = samp[..., 3] * ok
        col = mix(col, samp[..., :3], a)
    if WL['tip_band']:
        tipb = S.smoothstep(S.W_LEND - 0.14, S.W_LEND - 0.10, L)
        col = mix(col, ORANGE, tipb)
    # ---- dirt: engine exhaust soot on the lower surface behind the pylon, hydraulic streaks near spoilers
    soot = (~upper) * np.exp(-((Yabs - S.ENGINE_Y) / 0.9) ** 2) * S.smoothstep(16.0, 18.5, X) * 0.55
    streak = noise(H, W, 600, 25, seed=41)
    hyd = (upper * S.smoothstep(-0.9, -0.1, X - xcut) * (Yabs < 12.5) * np.clip(streak - 0.55, 0, 1) * 0.28
           * fbm(H, W, 6, 20, 3, seed=44))
    gen = fbm(H, W, 12, 60, 4, seed=43) * 0.12 + (~upper) * 0.08
    dirt = np.clip(soot * (0.6 + 0.4 * streak) + hyd + gen, 0, 1) * (1 - lef) * (1 - wl * 0.7)
    col = mix(col, col * srgb((90, 84, 74)) * 1.3, dirt)
    rough = np.clip(rough + dirt * 0.3, 0.05, 1)
    # outside the valid area: neutral
    col = np.where(valid[..., None], col, GREY_WING)
    save_rgb(col, 'wing_base', q=92)
    save_rgb(orm(rough, metal), 'wing_orm', size=(W // 2, H // 2), q=90)
    nm = normal_from_height(gaussian_filter(height, 0.6), 1.0)
    Image.fromarray(nm).resize((W // 2, H // 2), Image.LANCZOS).save(os.path.join(TEX, 'wing_nrm.jpg'), quality=92)
    print('  wrote wing_nrm')


# ================================================================== TAIL (fin + rudder)
def paint_tail(W=4096, H=2048):
    print('tail', W, H)
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H
    Z1 = S.F_Z0 + v * (S.F_Z1 - S.F_Z0 + 0.05)
    st = S.fin_station(Z1)
    right = u[None] > 0.5
    X = st['xle'][:, None] + np.abs(u[None] - 0.5) * S.FIN_UV_W
    Z = np.broadcast_to(Z1[:, None], X.shape)
    FIN = part('FIN', color=BLUE, centre=(36.3, 8.2), size=2.9, tip_band=True)
    col = np.broadcast_to(colour(FIN['color']), (H, W, 3)).copy()
    col *= (0.98 + 0.04 * fbm(H, W, 12, 24, 4, seed=51))[..., None]
    rough = np.full((H, W), 0.27, np.float32)
    metal = np.zeros((H, W), np.float32)
    height = np.zeros((H, W), np.float32)
    # logo (side projection, mirrored on the right so the swift flies forward on both sides)
    logo = np.asarray(emblem(1024), np.float32) / 255.0
    (cxl, czl), sz = FIN['centre'], FIN['size']
    for face in (False, True):
        lu = (X - (cxl - sz / 2)) / sz
        if face:
            lu = 1 - lu
        lv = 1 - (Z - (czl - sz / 2)) / sz
        ok = (right == face) & (lu >= 0) & (lu < 1) & (lv >= 0) & (lv < 1)
        iu = np.clip((lu * 1023).astype(int), 0, 1023)
        iv = np.clip((lv * 1023).astype(int), 0, 1023)
        samp = logo[iv, iu]
        a = samp[..., 3] * ok
        col = mix(col, samp[..., :3], a)
    # orange band near the fin root following the fuselage cheatline end, thin white pinstripe at the tip
    if FIN['tip_band']:
        tipband = S.smoothstep(12.05, 12.08, Z) * (1 - S.smoothstep(12.18, 12.21, Z))
        col = mix(col, ORANGE, tipband)
    # rudder hinge line + panels
    xc = S.fin_xcut(np.clip(Z, S.F_RUDDER[0], S.F_RUDDER[1]))
    hl = np.exp(-((X - xc) / 0.01) ** 2) * (Z > S.F_RUDDER[0]) * (Z < S.F_RUDDER[1])
    height -= hl
    col = mix(col, col * 0.55, hl * 0.8)
    for zk in np.linspace(5.4, 12.0, 7):
        e = np.exp(-((Z - zk) / 0.008) ** 2) * (X < xc) * (X > st['xle_main'][:, None] + 0.3) * 0.5
        height -= e * 0.5
    # LE erosion: slightly lighter/metallic
    le = np.exp(-((X - st['xle_main'][:, None]) / 0.07) ** 2) * (Z > 6.4)
    col = mix(col, col * 1.25 + 0.05, le * 0.5)
    # grime streaks
    vs = noise(H, W, 30, 500, seed=55)
    dirt = np.clip(vs - 0.55, 0, 1) * 0.25 + fbm(H, W, 10, 20, 3, seed=56) * 0.05
    col = mix(col, col * 0.8, dirt)
    save_rgb(col, 'tail_base', q=92)
    save_rgb(orm(rough + dirt * 0.2, metal), 'tail_orm', size=(W // 4, H // 4), q=90)
    nm = normal_from_height(gaussian_filter(height, 0.6), 1.0)
    Image.fromarray(nm).resize((W // 2, H // 2), Image.LANCZOS).save(os.path.join(TEX, 'tail_nrm.jpg'), quality=92)


# ================================================================== STABILIZER
def paint_stab(W=2048, H=1024):
    print('stab', W, H)
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H
    l = u * (S.S_LEND + 0.05)
    st = S.stab_station(l)
    d = (v - 0.5) * 2 * 4.6
    upper = d[:, None] > 0
    a = np.abs(d)[:, None] / st['c'][None]
    t = np.where(upper, S.airfoil_arc_inv(a, True), S.airfoil_arc_inv(a, False))
    stb = {k: np.broadcast_to(v_[None], t.shape) for k, v_ in st.items()}
    X = stb['X'] + t * stb['c']
    Yl = np.broadcast_to(st['Y'][None], t.shape)
    col = np.where(upper[..., None], GREY_WING, GREY_WING_LO) * np.ones((H, W, 3), np.float32)
    col *= (0.975 + 0.05 * fbm(H, W, 8, 30, 4, seed=61))[..., None]
    rough = np.full((H, W), 0.42, np.float32)
    metal = np.full((H, W), 0.12, np.float32)
    height = np.zeros((H, W), np.float32)
    le = (t < 0.08)
    col = mix(col, METAL, le.astype(np.float32))
    metal = np.where(le, 1.0, metal); rough = np.where(le, 0.2, rough)
    xc = S.stab_xcut(Yl)
    hl = np.exp(-((X - xc) / 0.01) ** 2) * (Yl > S.S_ELEV[0]) * (Yl < S.S_ELEV[1])
    height -= hl
    col = mix(col, col * 0.55, hl * 0.8)
    # blue root area (tail cone livery continues onto the stab root fairing)
    root = 1 - S.smoothstep(0.9, 1.05, Yl)
    stab_root = part('STAB', root=BLUE)['root']
    if stab_root is not None:
        col = mix(col, colour(stab_root), root)
    save_rgb(col, 'stab_base', q=90)
    save_rgb(orm(rough, metal), 'stab_orm', size=(W // 2, H // 2), q=90)
    nm = normal_from_height(gaussian_filter(height, 0.6), 1.0)
    Image.fromarray(nm).resize((W // 2, H // 2), Image.LANCZOS).save(os.path.join(TEX, 'stab_nrm.jpg'), quality=92)


# ================================================================== NACELLE
def paint_nacelle(W=2048, H=1024):
    print('nacelle', W, H)
    u = (np.arange(W) + 0.5) / W
    v = 1.0 - (np.arange(H) + 0.5) / H
    prof = S.nacelle_profile()
    pv = S.nac_v_coords(prof, 0.0, 0.60)
    sp = S.sleeve_profile()
    sv = S.nac_v_coords(sp + [sp[0]], 0.62, 1.0)[:-1]
    ps = np.array([p[0] for p in prof]); parts = [p[3] for p in prof]
    ss = np.array([p[0] for p in sp]); sparts = [p[3] for p in sp]
    V = np.broadcast_to(v[:, None], (H, W))
    U = np.broadcast_to(u[None], (H, W))
    psi = U * 2 * np.pi
    NAC = part('NACELLE', color=BLUE, ring=True)
    col = np.broadcast_to(colour(NAC['color']), (H, W, 3)).copy()
    rough = np.full((H, W), 0.26, np.float32)
    metal = np.zeros((H, W), np.float32)
    height = np.zeros((H, W), np.float32)
    # locate parts along v
    i_hl = parts.index('outer')        # highlight index (first outer point)
    v_hl = pv[i_hl]
    v_cowl_end = pv[[i for i, p in enumerate(prof) if p[3] == 'outer'][-1]]
    s_of_v = np.interp(v, pv, ps)
    inner = V < v_hl
    s_arr = np.broadcast_to(s_of_v[:, None], (H, W))
    # inner duct: light grey acoustic liner, lip: polished metal
    liner = inner & (s_arr > 0.10)
    col = np.where(liner[..., None], srgb((150, 154, 158)) * np.ones(3), col)
    col = np.where(liner[..., None], col * (0.93 + 0.07 * noise(H, W, 40, 300, seed=72))[..., None], col)
    lip = ((inner & (s_arr <= 0.10)) | (~inner & (V < 0.60) & (s_arr < 0.16)))
    col = np.where(lip[..., None], METAL, col)
    metal = np.where(lip, 1.0, metal)
    rough = np.where(lip, 0.16, rough)
    # orange pinstripe ring on the fan cowl + blue cowl
    cowl = (~inner) & (V < v_cowl_end + 1e-3)
    if NAC['ring']:
        ring = cowl & (np.abs(s_arr - 0.42) < 0.035)
        col = np.where(ring[..., None], ORANGE, col)
    # latch panel line along the bottom and hinge at the top
    for ps_ in (0.0, np.pi):
        dline = np.abs(np.mod(psi - ps_ + np.pi, 2 * np.pi) - np.pi)
        e = np.exp(-(dline / 0.004) ** 2) * cowl * (s_arr > 0.2)
        height -= e
        col = mix(col, col * 0.6, e * 0.7)
    for sl in (0.6, 1.1, 1.6):   # latches at the bottom
        la = cowl & (np.abs(s_arr - sl) < 0.06) & (np.abs(np.mod(psi - np.pi + np.pi, 2 * np.pi) - np.pi) < 0.06)
        col = np.where(la[..., None], col * 0.5, col)
    # cowl / sleeve split line
    e = np.exp(-((s_arr - 2.08) / 0.01) ** 2) * cowl
    height -= e
    # cascade band (dark grille)
    casc = (V >= v_cowl_end + 1e-3) & (V < 0.60)
    grille = (np.cos(s_arr * 2 * np.pi * 14) > 0.2) | (np.cos(U * 2 * np.pi * 36) > 0.9)
    col = np.where(casc[..., None], np.where(grille[..., None], srgb((40, 42, 45)), srgb((15, 15, 17))), col)
    # sleeve: blue outer, dark grey duct
    sl_s = np.interp(v, sv, ss)
    sleeve = V >= 0.62
    duct = sleeve & (V > np.interp(0.5, [0, 1], [0.62, 1.0])) & False
    idx_lip = sparts.index('lip')
    v_lip = sv[idx_lip]
    duct = sleeve & (V > v_lip)
    col = np.where(duct[..., None], srgb((55, 58, 62)), col)
    # soot at the sleeve exit
    ex = sleeve & (~duct) & (np.broadcast_to(sl_s[:, None], (H, W)) > 3.35)
    col = np.where(ex[..., None], col * 0.85, col)
    col *= (0.98 + 0.04 * fbm(H, W, 8, 16, 3, seed=71))[..., None]
    save_rgb(col, 'nac_base', q=92)
    save_rgb(orm(rough, metal), 'nac_orm', size=(W // 2, H // 2), q=90)
    nm = normal_from_height(gaussian_filter(height, 0.6), 1.0)
    Image.fromarray(nm).resize((W // 2, H // 2), Image.LANCZOS).save(os.path.join(TEX, 'nac_nrm.jpg'), quality=92)


# ================================================================== SMALL TEXTURES
def paint_misc():
    print('misc')
    # spinner: dark grey with a white spiral (u = angle, v = profile tip->base)
    W, H = 512, 256
    u = (np.arange(W) + 0.5) / W
    v = 1 - (np.arange(H) + 0.5) / H
    U, V = np.meshgrid(u, v)
    col = np.broadcast_to(srgb((45, 47, 52)), (H, W, 3)).copy()
    sp = np.mod(U + 0.9 * V, 1.0)
    band = (sp < 0.10) & (V > 0.12)
    col[band] = srgb((236, 238, 240))
    tip = V < 0.06
    col[tip] = srgb((236, 238, 240))
    save_rgb(col, 'spinner_base', q=90)
    # tire: tread grooves (u = profile across the tread, v = around)
    W, H = 256, 512
    u = (np.arange(W) + 0.5) / W
    col = np.broadcast_to(srgb((22, 22, 24)), (H, W, 3)).copy()
    for g in (0.40, 0.47, 0.53, 0.60):
        m = np.abs(u - g) < 0.008
        col[:, m] = srgb((8, 8, 9))
    col *= (0.9 + 0.2 * noise(H, W, 64, 16, seed=81))[..., None]
    side = (u < 0.25) | (u > 0.75)
    col[:, side] *= 1.1
    save_rgb(col, 'tire_base', q=90)


def make_lod_textures():
    out = os.path.join(TEX, 'lod')
    os.makedirs(out, exist_ok=True)
    for name, size in (('fus_base', (1024, 512)), ('fus_orm', (512, 256)), ('wing_base', (1024, 512)), ('wing_orm', (512, 256)),
                       ('tail_base', (1024, 512)), ('tail_orm', (256, 128)), ('stab_base', (512, 256)), ('stab_orm', (256, 128)),
                       ('nac_base', (512, 256)), ('nac_orm', (256, 128)), ('spinner_base', (128, 64)), ('tire_base', (64, 128))):
        p = os.path.join(TEX, name + '.jpg')
        if os.path.exists(p):
            Image.open(p).resize(size, Image.LANCZOS).save(os.path.join(out, name + '.jpg'), quality=88)
    print('  wrote lod textures')


if __name__ == '__main__':
    which = sys.argv[1:] or ['fus', 'wing', 'tail', 'stab', 'nac', 'misc', 'lod']
    if 'fus' in which:
        paint_fuselage()
    if 'wing' in which:
        paint_wing()
    if 'tail' in which:
        paint_tail()
    if 'stab' in which:
        paint_stab()
    if 'nac' in which:
        paint_nacelle()
    if 'misc' in which:
        paint_misc()
    if 'lod' in which:
        make_lod_textures()
