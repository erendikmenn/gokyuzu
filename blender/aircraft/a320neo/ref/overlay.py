"""Overlay Blender ortho silhouettes (preview.py) on the Airbus AC drawings.
usage: .venv/bin/python overlay.py <cmpdir> <refdir>   -> <cmpdir>/ov_side.png, ov_top.png, ov_front.png
Drawing fill = yellow, model silhouette = semi-transparent red, overlap = orange."""
import sys
import os
import numpy as np
from PIL import Image

cmp, ref = sys.argv[1], sys.argv[2]
ZS = 4.14 / 4.06
WS = 1.975 / 1.92


def load_mask(p):
    a = np.array(Image.open(p).convert('RGBA'))
    return a[..., 3] > 128


def fill_mask(img):
    a = np.array(img.convert('RGB')).astype(int)
    fill = (abs(a[..., 0] - 255) < 3) & (abs(a[..., 2] - 204) < 12)
    dark = a.sum(-1) < 500
    return fill, dark


def compose(draw_rgb, model_mask_in_draw):
    out = np.array(draw_rgb.convert('RGB')).astype(float)
    m = model_mask_in_draw
    out[m] = out[m] * 0.45 + np.array([255, 0, 0]) * 0.55
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def side():
    d = Image.open(os.path.join(ref, 'hi-042.png'))
    m = load_mask(os.path.join(cmp, 'side.png'))     # 44.53 px/m, s in [-1, 39], z in [2.4-7, 2.4+7]
    ppm = 44.53
    H, W = m.shape
    dh, dw = d.size[1], d.size[0]
    yy, xx = np.mgrid[0:dh, 0:dw]
    s = (xx - 808) / ppm
    h = (1493 - yy) / ppm                    # drawing height above ground
    z = (h - 3.85) * ZS                      # model z
    px = ((s + 1.0) * ppm).astype(int)
    py = ((2.4 + 7.0 - z) * ppm).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    mm = np.zeros((dh, dw), bool)
    mm[ok] = m[py[ok], px[ok]]
    out = compose(d, mm)
    out.crop((700, 850, 2600, 1560)).save(os.path.join(cmp, 'ov_side.png'))


def top():
    d = Image.open(os.path.join(ref, 'hi-043.png'))
    m = load_mask(os.path.join(cmp, 'top.png'))       # 44.53 px/m, s in [-1,39], y in [-20,20] (up = +y right wing)
    ppm_m = 44.53
    ppm_d = 44.5568
    H, W = m.shape
    dh, dw = d.size[1], d.size[0]
    yy, xx = np.mgrid[0:dh, 0:dw]
    s = (xx - 864) / ppm_d
    y = (2044.5 - yy) / ppm_d
    px = ((s + 1.0) * ppm_m).astype(int)
    py = ((20.0 - y) * ppm_m).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    mm = np.zeros((dh, dw), bool)
    mm[ok] = m[py[ok], px[ok]]
    out = compose(d, mm)
    out.crop((750, 1150, 2650, 2950)).save(os.path.join(cmp, 'ov_top.png'))


def front():
    d = Image.open(os.path.join(ref, 'hi-042.png'))
    m = load_mask(os.path.join(cmp, 'front.png'))     # 43.94 px/m, x in [-20,20] (image right = aircraft left), z in [2.4-7, 2.4+7]
    ppm = 43.94
    H, W = m.shape
    dh, dw = d.size[1], d.size[0]
    yy, xx = np.mgrid[0:dh, 0:dw]
    cx = 1544.5
    ground = 2865
    xl = (xx - cx) / ppm                    # image right = + (aircraft left)
    h = (ground - yy) / ppm
    z = (h - 3.85) * ZS
    px = ((xl + 20.0) * ppm).astype(int)
    py = ((2.4 + 7.0 - z) * ppm).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    mm = np.zeros((dh, dw), bool)
    mm[ok] = m[py[ok], px[ok]]
    out = compose(d, mm)
    out.crop((700, 2250, 2400, 2900)).save(os.path.join(cmp, 'ov_front.png'))


side()
top()
front()
print('ok')
