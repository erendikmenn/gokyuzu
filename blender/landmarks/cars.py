"""Low-poly traffic vehicles for the bridges (W3): sedan, SUV, box truck, bus.

Run:  Blender -b -P blender/landmarks/cars.py   ->  assets/sf/landmarks/cars.glb
One material for all (vertex colors: body = white so the runtime per-instance color tints it; glass/tyres dark) plus an
emissive atlas for head/tail lights (the runtime scales emission with the night factor).
Frame: +Y = forward (driving direction), +X = right, +Z = up, origin = road contact at the center of the wheelbase.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from lmkit import MB, V, OUT, material, export, reset_scene, texture, tri_count  # noqa: E402

BODY = (1.0, 1.0, 1.0)
GLASS = (0.05, 0.06, 0.07)
TYRE = (0.03, 0.03, 0.03)
TRIM = (0.18, 0.18, 0.19)


def lights_atlas():
    """4 x 4 atlas: (0,0) = no emission, (1,0) = headlight white, (2,0) = tail red."""
    s = 64
    img = np.zeros((s, s, 3))
    q = s // 4
    img[0:q, q:2 * q] = (1.0, 0.95, 0.85)          # row 0 (top) col 1 : headlights
    img[0:q, 2 * q:3 * q] = (1.0, 0.08, 0.04)      # row 0 col 2 : tail lights
    return img


def uv_cell(c):
    """UV rectangle (u0, v0, u1, v1) of atlas cell c in the top row (v near 1)."""
    return (c / 4 + 0.03, 0.78, (c + 1) / 4 - 0.03, 0.97)


def cell_uv(c):
    u0, v0, u1, v1 = uv_cell(c)
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def box(mb, lo, hi, col, faces='xXyYzZ', light_front=None, light_back=None):
    """Box with dark cell UVs, optional emissive UV cells on the front (+Y) / back (-Y) faces."""
    lo, hi = V(lo), V(hi)
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    q = lambda a, b, c, d, cell=0: mb.quad(a, b, c, d, uv=cell_uv(cell), col=col)
    if 'X' in faces:
        q((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))
    if 'x' in faces:
        q((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1))
    if 'Y' in faces:
        q((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1))
    if 'y' in faces:
        q((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))
    if 'Z' in faces:
        q((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
    if 'z' in faces:
        q((x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0))


def lamp(mb, x, y, z, w, h, cell, front):
    """Small emissive quad on the front/back face."""
    if front:
        mb.quad((x + w / 2, y, z - h / 2), (x - w / 2, y, z - h / 2), (x - w / 2, y, z + h / 2), (x + w / 2, y, z + h / 2), uv=cell_uv(cell), col=(1, 1, 1))
    else:
        mb.quad((x - w / 2, y, z - h / 2), (x + w / 2, y, z - h / 2), (x + w / 2, y, z + h / 2), (x - w / 2, y, z + h / 2), uv=cell_uv(cell), col=(1, 1, 1))


def wheels(mb, xs, ys, r):
    for x in xs:
        for y in ys:
            # hexagonal prism along X
            ang = np.linspace(0, 2 * np.pi, 7)[:-1]
            pts = [(y + r * np.cos(a), r + r * np.sin(a)) for a in ang]
            w = 0.22 if abs(x) > 0 else 0.22
            xa, xb = (x - w / 2, x + w / 2)
            n = len(pts)
            for i in range(n):
                (ya, za), (yb, zb) = pts[i], pts[(i + 1) % n]
                mb.quad((xb, ya, za), (xb, yb, zb), (xa, yb, zb), (xa, ya, za), uv=cell_uv(0), col=TYRE)


def sedan():
    mb = MB('sedan')
    L, W, H = 4.7, 1.82, 1.45
    box(mb, (-W / 2, -L / 2, 0.3), (W / 2, L / 2, 0.85), BODY)
    # greenhouse: glass box with roof
    box(mb, (-W / 2 + 0.1, -L / 2 + 1.2, 0.85), (W / 2 - 0.1, L / 2 - 1.3, 1.35), GLASS, faces='xXyY')
    box(mb, (-W / 2 + 0.12, -L / 2 + 1.35, 1.35), (W / 2 - 0.12, L / 2 - 1.45, 1.45), BODY, faces='xXyYZ')
    for sx in (-0.62, 0.62):
        lamp(mb, sx, L / 2 + 0.01, 0.7, 0.35, 0.12, 1, True)
        lamp(mb, sx, -L / 2 - 0.01, 0.72, 0.35, 0.12, 2, False)
    wheels(mb, (-W / 2 + 0.08, W / 2 - 0.08), (-1.4, 1.4), 0.33)
    return mb


def suv():
    mb = MB('suv')
    L, W = 4.9, 1.95
    box(mb, (-W / 2, -L / 2, 0.38), (W / 2, L / 2, 1.05), BODY)
    box(mb, (-W / 2 + 0.08, -L / 2 + 0.35, 1.05), (W / 2 - 0.08, L / 2 - 1.1, 1.65), GLASS, faces='xXyY')
    box(mb, (-W / 2 + 0.1, -L / 2 + 0.4, 1.65), (W / 2 - 0.1, L / 2 - 1.15, 1.78), BODY, faces='xXyYZ')
    for sx in (-0.66, 0.66):
        lamp(mb, sx, L / 2 + 0.01, 0.88, 0.35, 0.14, 1, True)
        lamp(mb, sx, -L / 2 - 0.01, 0.95, 0.25, 0.3, 2, False)
    wheels(mb, (-W / 2 + 0.08, W / 2 - 0.08), (-1.45, 1.45), 0.38)
    return mb


def truck():
    mb = MB('truck')
    W = 2.45
    box(mb, (-W / 2, -4.2, 0.9), (W / 2, 2.4, 3.9), BODY)                                  # box body
    box(mb, (-W / 2 + 0.05, 2.5, 0.55), (W / 2 - 0.05, 4.6, 2.3), (0.85, 0.85, 0.85))        # cab
    box(mb, (-W / 2 + 0.1, 3.7, 1.5), (W / 2 - 0.1, 4.62, 2.2), GLASS, faces='Y')
    box(mb, (-W / 2 + 0.2, -4.2, 0.45), (W / 2 - 0.2, 4.6, 0.9), TRIM, faces='xXyYz')
    for sx in (-0.95, 0.95):
        lamp(mb, sx, 4.62, 0.9, 0.3, 0.15, 1, True)
        lamp(mb, sx, -4.21, 1.1, 0.25, 0.2, 2, False)
    wheels(mb, (-W / 2 + 0.1, W / 2 - 0.1), (-3.1, -2.0, 3.6), 0.48)
    return mb


def bus():
    mb = MB('bus')
    W, L = 2.55, 12.2
    box(mb, (-W / 2, -L / 2, 0.45), (W / 2, L / 2, 3.2), BODY)
    box(mb, (-W / 2 - 0.01, -L / 2 + 0.4, 1.5), (W / 2 + 0.01, L / 2 - 0.4, 2.6), GLASS, faces='xX')
    box(mb, (-W / 2 + 0.1, L / 2 - 0.02, 1.3), (W / 2 - 0.1, L / 2 + 0.01, 2.8), GLASS, faces='Y')
    for sx in (-1.0, 1.0):
        lamp(mb, sx, L / 2 + 0.02, 0.8, 0.3, 0.15, 1, True)
        lamp(mb, sx, -L / 2 - 0.02, 1.0, 0.2, 0.35, 2, False)
    wheels(mb, (-W / 2 + 0.1, W / 2 - 0.1), (-4.2, 4.0), 0.5)
    return mb


def main():
    reset_scene()
    atlas = texture('cars_lights_emit', lights_atlas, 'png')
    white = texture('cars_white', lambda: np.ones((8, 8, 3)), 'png')
    m = material('cars_body_emit', albedo=white, emissive_img=atlas, emissive_strength=3.0, rough=0.35, metal=0.2)
    obs = []
    for fn in (sedan, suv, truck, bus):
        mb = fn()
        obs.append(mb.to_object(f'car_{mb.name}', m, use_colors=True))
    path = os.path.join(OUT, 'cars.glb')
    export(path, obs, draco_bits=14)
    print('cars', tri_count(obs), 'tris', os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
