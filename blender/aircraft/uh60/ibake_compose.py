"""Compose baked interior atlases (venv python, called by ibake.py).

    python ibake_compose.py <cache_dir> <out_dir> <group>:<size> ...

Inputs per group (Blender pixel order, row 0 = bottom): <g>_alb.npy, <g>_rough.npy, <g>_metal.npy (size^2 RGBA float),
<g>_light.npy (light-bake size^2). Output: <g>_base.jpg (sRGB albedo x soft light), <g>_orm.jpg (R=1, G=rough, B=metal).
"""
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

CACHE, OUT = sys.argv[1], sys.argv[2]
LITE = '--lite' in sys.argv
GROUPS = [a.split(':') for a in sys.argv[3:] if not a.startswith('--')]
os.makedirs(OUT, exist_ok=True)

# light factor: irradiance under the overcast bake sky (1 ~ open sky overhead) -> multiplier on the albedo.
# The game adds its own sun + fill on top, so the bake mainly carries occlusion, contact shadows and window gradients.
L_REF = float(os.environ.get('IB_LREF', 1.0))        # x the group's 80th-percentile irradiance
L_GAMMA = float(os.environ.get('IB_LGAMMA', 0.6))
L_FLOOR = float(os.environ.get('IB_LFLOOR', 0.10))
L_MAX = float(os.environ.get('IB_LMAX', 1.12))


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def masked_blur(a, mask, sigma):
    m = mask.astype(np.float32)
    if a.ndim == 3:
        num = np.stack([ndimage.gaussian_filter(a[..., k] * m, sigma) for k in range(a.shape[2])], -1)
        den = ndimage.gaussian_filter(m, sigma)[..., None]
    else:
        num = ndimage.gaussian_filter(a * m, sigma)
        den = ndimage.gaussian_filter(m, sigma)
    return np.where(den > 1e-4, num / np.maximum(den, 1e-4), a)


def dilate(a, mask):
    _, (ri, ci) = ndimage.distance_transform_edt(~mask, return_indices=True)
    return a[ri, ci]


def save(img, path, q=88):
    a = (np.clip(img[::-1], 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(a).save(path, quality=q, subsampling=0 if q >= 92 else 2, optimize=True)


def compose_lite(name, size):
    """Lite stand-in: projected detailed colours where the rays hit, own (darkened) colour elsewhere."""
    proj = np.load(os.path.join(CACHE, f'{name}_proj.npy'))
    hit = np.load(os.path.join(CACHE, f'{name}_hit.npy'))[..., :3].mean(2)
    alb = np.load(os.path.join(CACHE, f'{name}_alb.npy'))
    cover = alb[..., 3] > 0.5
    h = ndimage.gaussian_filter(np.clip(hit, 0, 1), 0.8)
    # both bakes store linear values (the sRGB atlas is decoded when sampled)
    fallback = lin_to_srgb(alb[..., :3] * 0.45)
    col = lin_to_srgb(proj[..., :3]) * h[..., None] + fallback * (1 - h[..., None])
    col = dilate(col, cover | (h > 0.5))
    a = (np.clip(col[::-1], 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(a).save(os.path.join(OUT, f'{name}_base.jpg'), quality=86, optimize=True)
    orm = np.zeros(col.shape, np.float32)
    orm[..., 0] = 1.0
    orm[..., 1] = 0.75
    Image.fromarray((orm[::-1] * 255).astype(np.uint8)).resize((64, 64)).save(os.path.join(OUT, f'{name}_orm.jpg'), quality=90)
    print('lite composed', name, 'hit fraction %.2f' % (h[cover] > 0.5).mean(), flush=True)


for name, size in GROUPS:
    size = int(size)
    if LITE:
        compose_lite(name, size)
        continue
    alb = np.load(os.path.join(CACHE, f'{name}_alb.npy'))
    mk = np.load(os.path.join(CACHE, f'{name}_mask.npy'))
    mask = mk[..., :3].mean(2) > 0.5
    rough = np.load(os.path.join(CACHE, f'{name}_rough.npy'))[..., 0]
    metal = np.load(os.path.join(CACHE, f'{name}_metal.npy'))[..., 0]
    light = np.load(os.path.join(CACHE, f'{name}_light.npy'))
    lmask = light[..., 3] > 0.5
    L = light[..., :3]
    # denoise the path-traced light inside islands, then bring it to the atlas size
    L = masked_blur(L, lmask, 1.3)
    L = dilate(L, lmask)
    if L.shape[0] != size:
        z = size / L.shape[0]
        L = np.stack([ndimage.zoom(L[..., k], z, order=1) for k in range(3)], -1)
    lum = L.mean(2, keepdims=True)
    lmask_s = mask if mask.any() else np.ones(mask.shape, bool)
    tint = L / np.maximum(lum, 1e-4)
    tint = 1.0 + 0.35 * (np.clip(tint, 0.5, 1.5) - 1.0)          # keep a little of the sky tint
    lref = L_REF * float(np.percentile(lum[..., 0][lmask_s], 80)) if L_REF < 2 else L_REF   # per-group exposure
    f = L_FLOOR + (1 - L_FLOOR) * np.clip(lum / lref, 0, 4) ** L_GAMMA
    f = np.clip(f, 0, L_MAX) * tint
    base = alb[..., :3] * f
    base = dilate(base, mask)
    save(lin_to_srgb(base), os.path.join(OUT, f'{name}_base.jpg'), 88)
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    orm = dilate(orm, mask)
    small = Image.fromarray((np.clip(orm[::-1], 0, 1) * 255 + 0.5).astype(np.uint8)).resize((max(256, size // 4),) * 2, Image.BOX)
    small.save(os.path.join(OUT, f'{name}_orm.jpg'), quality=90)
    # debug: light factor
    Image.fromarray((np.clip(f[::-1].mean(2) / L_MAX, 0, 1) * 255).astype(np.uint8)).resize((1024, 1024)).save(
        os.path.join(OUT, f'dbg_{name}_light.png'))
    print('composed', name, size, 'coverage %.2f' % mask.mean(), 'light p10/p50/p90 %.3f %.3f %.3f' % tuple(
        np.percentile(lum[..., 0][mask], [10, 50, 90])), flush=True)
print('ibake_compose ok')
