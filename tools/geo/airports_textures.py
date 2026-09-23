"""Procedural, tileable ground textures for the airports (W4). numpy + Pillow, deterministic.

Usage: .venv/bin/python tools/geo/airports_textures.py
Output: assets/sf/airports/tex/*.jpg|png
  asphalt_rwy.jpg   grooved runway asphalt, 2048^2 = 8 m tile (v = along the runway)
  asphalt_twy.jpg   taxiway asphalt with sealed cracks, 2048^2 = 8 m tile
  concrete.jpg      apron PCC slabs 7.62 m (2x2 slabs per 15.24 m tile)
  concrete_rwy.jpg  grooved runway concrete slabs (military runway), 15.24 m tile
  shoulder.jpg      shoulder asphalt (older, lighter), 8 m tile
  macro.jpg         low-frequency variation (tile 512 m)
  rubber.jpg        tyre rubber streaks, 16 m across x 128 m along
  paintwear.jpg     paint coverage mask, 4 m tile
  detail_n.jpg      fine aggregate normal map, 2 m tile
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'sf', 'airports', 'tex')
rng = np.random.default_rng(20260923)


def field(n, m=None, beta=2.0, fmin=1.0, fmax=None, aniso=(1.0, 1.0)):
    """Tileable Gaussian random field with power spectrum ~ 1/f^beta, normalized to zero mean / unit std."""
    m = m or n
    fy = np.fft.fftfreq(n)[:, None] * n * aniso[1]
    fx = np.fft.fftfreq(m)[None, :] * m * aniso[0]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    amp = f ** (-beta / 2)
    amp[f < fmin] = 0
    if fmax:
        amp[f > fmax] = 0
    amp[0, 0] = 0
    ph = rng.normal(size=(n, m)) + 1j * rng.normal(size=(n, m))
    r = np.real(np.fft.ifft2(amp * ph))
    r -= r.mean()
    return r / (r.std() + 1e-9)


def save(name, arr, q=80):
    """JPEG q80 (4:2:0) for colour maps; single-channel masks saved as greyscale JPEG (web payload)."""
    os.makedirs(OUT, exist_ok=True)
    a = np.clip(arr, 0, 1)
    if a.ndim == 3 and name.endswith('.jpg') and np.allclose(a[..., 0], a[..., 1]) and np.allclose(a[..., 1], a[..., 2]):
        a = a[..., 0]
    img = Image.fromarray((a * 255 + 0.5).astype(np.uint8))
    p = os.path.join(OUT, name)
    if name.endswith('.jpg'):
        img.save(p, quality=q, optimize=True)
    else:
        img.save(p, optimize=True)
    print('wrote', p, img.size, os.path.getsize(p) // 1024, 'KB')


def speckles(n, count, rmin, rmax, m=None):
    """Tileable random round speckles: returns a 0..1 mask."""
    m = m or n
    mask = np.zeros((n, m), np.float32)
    ys = rng.integers(0, n, count)
    xs = rng.integers(0, m, count)
    rs = rng.uniform(rmin, rmax, count)
    for y, x, r in zip(ys, xs, rs):
        ri = int(np.ceil(r)) + 1
        yy, xx = np.mgrid[-ri:ri + 1, -ri:ri + 1]
        d = np.sqrt(yy * yy + xx * xx)
        v = np.clip(r - d + 0.5, 0, 1)
        iy = (yy + y) % n
        ix = (xx + x) % m
        np.maximum.at(mask, (iy, ix), v)
    return mask


def aggregate(n, tone, contrast=1.0, stones=True, m=None):
    m = m or n
    fine = field(n, m, beta=0.6, fmin=40)
    mid = field(n, m, beta=1.6, fmin=4)
    base = tone + contrast * (0.028 * fine + 0.018 * mid)
    if stones:
        light = speckles(n, int(n * m / 140), 0.8, 2.6, m)
        dark = speckles(n, int(n * m / 260), 0.7, 2.0, m)
        base = base + 0.10 * contrast * light * (0.5 + 0.5 * rng.random()) - 0.05 * contrast * dark
    return base


def rgbify(g, tint=(1.0, 1.0, 1.0), chroma_noise=0.0, n=None):
    out = np.stack([g * tint[0], g * tint[1], g * tint[2]], -1)
    if chroma_noise:
        c = field(g.shape[0], g.shape[1], beta=2.2, fmin=2)
        out[..., 0] += chroma_noise * c
        out[..., 2] -= chroma_noise * c
    return out


def cracks(n, count, width=1.6, m=None, seglen=(40, 220), wiggle=0.35):
    """Random-walk crack/sealant lines (tileable wrap)."""
    m = m or n
    mask = np.zeros((n, m), np.float32)
    for _ in range(count):
        y, x = rng.uniform(0, n), rng.uniform(0, m)
        ang = rng.uniform(0, 2 * np.pi)
        L = int(rng.uniform(*seglen))
        for _s in range(L):
            ang += rng.normal(0, wiggle)
            y += np.sin(ang) * 1.5
            x += np.cos(ang) * 1.5
            w = width * (0.6 + 0.4 * rng.random())
            ri = int(np.ceil(w)) + 1
            yy, xx = np.mgrid[-ri:ri + 1, -ri:ri + 1]
            d = np.sqrt((yy + (y % 1)) ** 2 + (xx + (x % 1)) ** 2)
            v = np.clip(w - d, 0, 1)
            np.maximum.at(mask, ((yy + int(y)) % n, (xx + int(x)) % m), v)
    return mask


def blur(a, r):
    img = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(r)), np.float32) / 255


def main():
    N = 2048
    # ---------------- runway asphalt (grooved). v (rows) = along runway, 8 m -> 3.9 mm/px
    g = aggregate(N, 0.34, 1.0)
    wear = field(N, beta=2.4, fmin=1)
    g += 0.018 * wear
    # transverse saw-cut grooves every 38 mm (~9.73 px), 6 mm wide; rows = along
    rows = np.arange(N)
    period = N / round(8.0 / 0.038)
    phase = (rows % period) / period
    groove = np.clip(1 - np.abs(phase - 0.5) * period / 1.1, 0, 1)
    groove_mask = groove[:, None] * (0.75 + 0.25 * np.clip(field(N, beta=1.0, fmin=8), -1, 1))
    g = g * (1 - 0.09 * groove_mask)
    # longitudinal faint paving lane joint at the tile edge (every 8 m it would repeat; keep very faint)
    col = np.arange(N)
    joint = np.exp(-((col - 3) ** 2) / 6.0)
    g -= 0.02 * joint[None, :]
    save('asphalt_rwy.jpg', rgbify(g, (1.0, 1.0, 1.02), 0.004))

    # ---------------- taxiway asphalt: no grooves, sealed cracks, patches
    g = aggregate(N, 0.37, 1.0)
    g += 0.02 * field(N, beta=2.4, fmin=1)
    cr = cracks(N, 10, 2.8, seglen=(120, 420))
    g = g * (1 - 0.55 * cr)
    save('asphalt_twy.jpg', rgbify(g, (1.0, 0.995, 0.99), 0.004))

    # ---------------- shoulder asphalt: older, lighter, more cracked
    g = aggregate(N, 0.44, 0.9)
    g += 0.035 * field(N, beta=2.2, fmin=1)
    cr = cracks(N, 26, 2.2, seglen=(60, 300), wiggle=0.5)
    g = g * (1 - 0.45 * cr)
    sh = rgbify(g, (1.0, 0.99, 0.975), 0.006)
    save('shoulder.jpg', np.asarray(Image.fromarray((np.clip(sh, 0, 1) * 255).astype(np.uint8)).resize((1024, 1024), Image.LANCZOS), np.float32) / 255)

    # ---------------- apron concrete slabs: 4x4 slabs of 7.62 m in a 30.48 m tile (1.5 cm/px)
    g = np.full((N, N), 0.64, np.float32)
    g += 0.014 * field(N, beta=0.5, fmin=60) + 0.02 * field(N, beta=1.8, fmin=3)
    g += 0.045 * speckles(N, N * N // 1200, 0.5, 1.2) - 0.03 * speckles(N, N * N // 1800, 0.4, 1.0)
    q = N // 4
    for sy in range(4):
        for sx in range(4):
            tone = 1 + rng.normal(0, 0.018)
            g[sy * q:(sy + 1) * q, sx * q:(sx + 1) * q] *= tone
            # occasional replaced (newer, lighter) or stained slab
            if rng.random() < 0.12:
                g[sy * q:(sy + 1) * q, sx * q:(sx + 1) * q] *= 1.03
    broom = field(N, beta=0.2, fmin=100, aniso=(8.0, 1.0))
    g += 0.01 * broom
    j = np.zeros(N)
    for c in range(0, N, q):
        j += np.exp(-((np.arange(N) - c + 0.5) ** 2) / 1.2) + np.exp(-((np.arange(N) - c - N + 0.5) ** 2) / 1.2)
    J = np.maximum(j[:, None], j[None, :])
    g = g * (1 - 0.4 * np.clip(J, 0, 1))
    cr = cracks(N, 12, 1.1, seglen=(40, 160), wiggle=0.25)
    g = g * (1 - 0.35 * cr)
    st = blur(speckles(N, 120, 3, 18), 7)
    st2 = blur(speckles(N, 700, 1.0, 4), 2)
    g = g * (1 - 0.2 * st - 0.12 * st2)
    rgb = rgbify(g, (1.0, 0.99, 0.965), 0.006)
    rgb[..., 0] += 0.02 * st
    save('concrete.jpg', rgb)

    # ---------------- runway concrete (military): slabs + transverse grooves
    g = np.full((N, N), 0.60, np.float32)
    g += 0.016 * field(N, beta=0.5, fmin=60) + 0.025 * field(N, beta=1.8, fmin=3)
    g += 0.05 * speckles(N, N * N // 900, 0.6, 1.6) - 0.03 * speckles(N, N * N // 1400, 0.5, 1.3)
    half = N // 2
    for sy in range(2):
        for sx in range(2):
            g[sy * half:(sy + 1) * half, sx * half:(sx + 1) * half] *= 1 + rng.normal(0, 0.03)
    j2 = np.zeros(N)
    for c in (0, half):
        j2 += np.exp(-((np.arange(N) - c + 0.5) ** 2) / 1.8) + np.exp(-((np.arange(N) - c - N + 0.5) ** 2) / 1.8)
    J2 = np.maximum(j2[:, None], j2[None, :])
    g = g * (1 - 0.5 * np.clip(J2, 0, 1))
    period = N / round(15.24 / 0.038)
    phase = (rows % period) / period
    groove = np.clip(1 - np.abs(phase - 0.5) * period / 1.2, 0, 1)
    g = g * (1 - 0.12 * groove[:, None])
    cr = cracks(N, 5, 1.3, seglen=(30, 120), wiggle=0.25)
    g = g * (1 - 0.3 * cr)
    save('concrete_rwy.jpg', rgbify(g, (1.0, 0.99, 0.97), 0.005))

    # ---------------- macro variation (tile 512 m), mean 0.5
    M = 1024
    mac = 0.55 * field(M, beta=2.6, fmin=1, fmax=200) + 0.25 * field(M, beta=1.4, fmin=6, fmax=300)
    # rectangular repair patches (slightly different tone)
    patch = np.zeros((M, M), np.float32)
    for _ in range(26):
        h, w = rng.integers(6, 40), rng.integers(6, 60)
        y, x = rng.integers(0, M - h), rng.integers(0, M - w)
        patch[y:y + h, x:x + w] = rng.choice([-1.0, 1.0]) * rng.uniform(0.4, 1.0)
    mac = 0.5 + 0.12 * mac + 0.06 * blur(patch * 0.5 + 0.5, 0.6) - 0.03
    save('macro.jpg', np.stack([mac, mac, mac], -1))

    # ---------------- rubber streaks: 512 across (16 m) x 1024 along (128 m)
    W, H = 512, 1024
    s = field(H, W, beta=1.4, fmin=1, aniso=(1.0, 40.0))       # stretched along v (rows)
    s2 = field(H, W, beta=0.8, fmin=10, aniso=(1.0, 25.0))
    r = np.clip(0.55 + 0.35 * s + 0.2 * s2, 0, 1)
    r = r ** 1.4
    save('rubber.jpg', r)

    # ---------------- paint wear mask (4 m tile): 1 = full paint
    P = 1024
    pw = 0.5 * field(P, beta=1.2, fmin=3) + 0.5 * field(P, beta=0.4, fmin=40)
    mask = np.clip(1.25 - 0.9 * np.clip(pw, 0, 3) * 0.6 - 0.9 * speckles(P, 1400, 0.6, 2.4), 0, 1)
    save('paintwear.jpg', np.stack([mask] * 3, -1))

    # ---------------- detail normal map (2 m tile, 512 px -> 4 mm)
    D = 512
    hgt = 0.6 * field(D, beta=0.9, fmin=30) + 0.9 * speckles(D, D * D // 60, 0.8, 2.2)
    hgt = blur(np.clip(hgt * 0.25 + 0.5, 0, 1), 0.7)
    gy, gx = np.gradient(hgt)
    k = 6.0
    nx, ny, nz = -gx * k, -gy * k, np.ones_like(hgt)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    nrm = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
    save('detail_n.jpg', nrm)


if __name__ == '__main__':
    main()
