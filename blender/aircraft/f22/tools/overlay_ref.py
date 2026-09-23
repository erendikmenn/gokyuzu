"""Overlay model silhouettes (tools/preview.py --sil) on the Lockheed F-22A 3-view (ref/3view_lines.jpg).

  python overlay_ref.py <preview_dir>   -> <preview_dir>/ov_side.png, ov_top.png, ov_front.png
Model = translucent red, drawing = black lines.  Frames as in preview.py (100 px/m).
"""
import sys, os
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, '..', 'ref', '3view_lines.jpg')
d = sys.argv[1]
ref = np.asarray(Image.open(REF).convert('L')).astype(np.float32) / 255.0

# drawing pixel -> world (s, z) / (s, x) / (x, z)
Z_TIP = -0.35
FR = {
    'side': dict(W=2000, H=600, a0=-0.5, b1=3.7,
                 to_px=lambda a, b: (20 + a * 33.72, 446 - (b - Z_TIP) * 33.72)),
    'top': dict(W=2000, H=1500, a0=-0.5, b1=7.5,
                to_px=lambda a, b: (17 + a * 34.14, 762 - b * 34.51)),
    # front view: centre x = 331.0 px, fin tip (z = 2.97) at y = 78, 33.48 px/m; frame a = -x (image right = -x)
    'front': dict(W=1500, H=600, a0=-7.5, b1=3.7,
                  to_px=lambda a, b: (331.0 + a * 33.48, 78 + (2.97 - b) * 33.48)),
}
for name, f in FR.items():
    p = os.path.join(d, f'{name}_sil.png')
    if not os.path.exists(p):
        continue
    sil = np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)[..., 3] / 255.0
    H, W = sil.shape
    X, Yp = np.meshgrid(np.arange(W), np.arange(H))
    a = f['a0'] + (X + 0.5) / 100.0
    b = f['b1'] - (Yp + 0.5) / 100.0
    px, py = f['to_px'](a, b)
    lines = ndimage.map_coordinates(ref, [py, px], order=1, cval=1.0)
    img = np.ones((H, W, 3), np.float32)
    red = np.array([0.95, 0.25, 0.2])
    img = img * (1 - 0.45 * sil[..., None]) + red * 0.45 * sil[..., None]
    dark = np.clip((0.75 - lines) / 0.5, 0, 1)[..., None]
    img = img * (1 - dark)
    # 1 m grid
    for k in range(0, W, 100):
        img[:, k] = img[:, k] * 0.85 + np.array([0.3, 0.5, 1.0]) * 0.15
    for k in range(0, H, 100):
        img[k, :] = img[k, :] * 0.85 + np.array([0.3, 0.5, 1.0]) * 0.15
    Image.fromarray((img * 255).astype(np.uint8)).save(os.path.join(d, f'ov_{name}.png'))
print('overlay done')
