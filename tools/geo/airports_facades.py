"""Facade / roof textures for the airport buildings (W4). Tileable, deterministic. numpy + Pillow.

Usage: .venv/bin/python tools/geo/airports_facades.py
Output: assets/sf/airports/tex/fac_*.jpg (+ *_e.jpg emissive night maps). Tile sizes (metres, w x h) are in FACADES
and mirrored in blender/airports/materials.py.
"""
import os, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from airports_textures import field, speckles, blur, OUT

rng = np.random.default_rng(7)
N = 1024

FACADES = {
    # name: (tile_w, tile_h)
    'fac_glass': (6.0, 4.5), 'fac_terminal': (9.0, 1.0), 'fac_office': (6.0, 3.8), 'fac_hangar': (4.0, 4.0),
    'fac_hangar_door': (8.0, 8.0), 'fac_garage': (8.0, 3.1), 'fac_industrial': (8.0, 8.0), 'roof_membrane': (12.0, 12.0),
    'roof_gravel': (10.0, 10.0), 'roof_metal': (6.0, 6.0), 'fac_mil_concrete': (8.0, 8.0), 'fac_mil_stucco': (6.0, 3.6),
    'fac_mil_hangar': (4.0, 4.0), 'tower_shaft': (4.0, 4.0), 'fac_jetbridge': (3.0, 3.0), 'fac_cargo': (8.0, 6.0),
}


def to_img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def save(name, arr, q=88):
    p = os.path.join(OUT, name)
    to_img(arr).save(p, quality=q, optimize=True)
    print('wrote', name, os.path.getsize(p) // 1024, 'KB')


def grime(n=N, amount=0.08, streaks=True):
    """Weathering: low-freq blotches + vertical rain streaks (rows = down)."""
    g = 0.6 * field(n, beta=2.2, fmin=1) + 0.4 * field(n, beta=1.2, fmin=6)
    out = amount * g
    if streaks:
        s = field(n, beta=1.4, fmin=2, aniso=(1.0, 12.0))
        out += amount * 0.8 * np.clip(s, 0, None) * np.linspace(0.3, 1.0, n)[:, None]
    return out


def rgb(g, c):
    return np.stack([g * c[0], g * c[1], g * c[2]], -1)


def window_grid(img, x0, y0, w, h, nx, ny, frame, glass_col, frame_col, jitter=0.0, lit=None, lit_img=None, lit_p=0.35):
    dr = ImageDraw.Draw(img)
    dl = ImageDraw.Draw(lit_img) if lit_img is not None else None
    cw, ch = w / nx, h / ny
    for j in range(ny):
        for i in range(nx):
            ax, ay = x0 + i * cw, y0 + j * ch
            dr.rectangle([ax, ay, ax + cw, ay + ch], fill=frame_col)
            k = 1 + rng.normal(0, 0.07 * jitter)
            gc = tuple(int(np.clip(c * k, 0, 255)) for c in glass_col)
            dr.rectangle([ax + frame, ay + frame, ax + cw - frame, ay + ch - frame], fill=gc)
            if dl is not None and rng.random() < lit_p:
                warm = rng.choice([(255, 214, 150), (255, 236, 200), (230, 238, 255)])
                k = rng.uniform(0.45, 1.0)
                dl.rectangle([ax + frame, ay + frame, ax + cw - frame, ay + ch - frame], fill=tuple(int(c * k) for c in warm))


def glass_curtain():
    # 4 panels x 1 floor; mullions dark grey; glass blue-grey with reflection gradient; spandrel at floor line
    img = Image.new('RGB', (N, N), (60, 64, 70))
    lit = Image.new('RGB', (N, N), (0, 0, 0))
    sp = int(N * 0.8 / 4.5)       # spandrel 0.8 m
    window_grid(img, 0, 0, N, N - sp, 4, 1, 7, (96, 122, 140), (60, 64, 70), jitter=1.0, lit_img=lit, lit_p=0.6)
    dr = ImageDraw.Draw(img)
    dr.rectangle([0, N - sp, N, N], fill=(70, 78, 88))
    for i in range(5):
        x = int(i * N / 4)
        dr.rectangle([x - 5, 0, x + 5, N], fill=(48, 52, 58))
    a = np.asarray(img, np.float32) / 255
    # sky reflection gradient (lighter at the top of each pane) + subtle waviness
    grad = np.linspace(1.18, 0.9, N)[:, None, None]
    wav = 1 + 0.05 * field(N, beta=2.0, fmin=2)[..., None]
    glass = (a[..., 2:3] > 0.4).astype(np.float32)
    a = a * (1 + glass * (grad * wav - 1))
    save('fac_glass.jpg', a + grime(amount=0.02)[..., None] * 0.5)
    L = np.asarray(lit, np.float32) / 255
    save('fac_glass_e.jpg', blur(L[..., 0], 2)[..., None] * np.array([1.0, 0.85, 0.62]) + 0 * L)


def terminal_panels():
    """Full-height terminal / pier elevation (u: 9 m, v: whole building height, bottom row = ground):
    apron level: light metal panels + service doors; concourse level: tall glazing with mullions; top: fascia."""
    img = Image.new('RGB', (N, N), (208, 211, 214))
    lit = Image.new('RGB', (N, N), (0, 0, 0))
    dr = ImageDraw.Draw(img)
    dl = ImageDraw.Draw(lit)
    y_fascia = int(N * 0.10)          # top 10 %: fascia
    y_glass1 = int(N * 0.60)          # glass from 10 % to 60 % of the height (image rows)
    # apron level panels + doors
    for i in range(6):
        x = int(i * N / 6)
        dr.line([x, y_glass1, x, N], fill=(178, 182, 186), width=3)
    for yy in range(y_glass1 + 60, N, 90):
        dr.line([0, yy, N, yy], fill=(186, 190, 194), width=2)
    dr.rectangle([int(N * 0.62), int(N * 0.78), int(N * 0.80), N], fill=(96, 100, 106))       # service door
    dr.rectangle([int(N * 0.12), int(N * 0.86), int(N * 0.20), N], fill=(70, 76, 84))         # personnel door
    # concourse glazing
    dr.rectangle([0, y_fascia, N, y_glass1], fill=(58, 62, 68))
    npan = 6
    for i in range(npan):
        x0 = int(i * N / npan) + 5
        x1 = int((i + 1) * N / npan) - 5
        k = 1 + rng.normal(0, 0.04)
        dr.rectangle([x0, y_fascia + 6, x1, y_glass1 - 6], fill=(int(104 * k), int(128 * k), int(146 * k)))
        # transom
        yt = y_fascia + int((y_glass1 - y_fascia) * 0.72)
        dr.rectangle([x0, yt - 3, x1, yt + 3], fill=(62, 66, 72))
        if rng.random() < 0.85:
            c = rng.uniform(0.35, 0.9)
            # interior: bright ceiling band fading down, dark furniture / people silhouettes near the floor
            y0, y1 = y_fascia + 6, y_glass1 - 6
            for yy in range(y0, y1):
                t = (yy - y0) / max(1, (y1 - y0))
                k = c * (1.0 - 0.55 * t) * (1.25 if t < 0.12 else 1.0)
                dl.line([x0, yy, x1, yy], fill=(int(min(255, 255 * k)), int(min(255, 214 * k)), int(min(255, 160 * k))))
            for _ in range(rng.integers(1, 4)):
                bx = rng.uniform(x0, x1 - 20)
                bw = rng.uniform(6, 30)
                dl.rectangle([bx, y1 - rng.uniform(25, 80), bx + bw, y1], fill=(20, 16, 12))
    # fascia with a thin dark reveal
    dr.rectangle([0, 0, N, y_fascia], fill=(226, 228, 230))
    dr.rectangle([0, y_fascia - 8, N, y_fascia], fill=(120, 124, 128))
    a = np.asarray(img, np.float32) / 255
    # sky reflection gradient on the glass
    g = np.zeros((N, 1, 1), np.float32)
    g[y_fascia:y_glass1, 0, 0] = np.linspace(0.18, -0.05, y_glass1 - y_fascia)
    glass = (np.abs(a[..., 2:3] - a[..., 0:1]) > 0.08).astype(np.float32)
    a = a + glass * g
    a += grime(amount=0.025)[..., None]
    save('fac_terminal.jpg', a)
    L = np.asarray(lit, np.float32) / 255
    save('fac_terminal_e.jpg', np.stack([blur(L[..., k], 1.5) for k in range(3)], -1))


def office():
    img = Image.new('RGB', (N, N), (184, 178, 166))
    lit = Image.new('RGB', (N, N), (0, 0, 0))
    wh = int(N * 1.7 / 3.8)
    window_grid(img, int(N * 0.08), int(N * 0.28), int(N * 0.84), wh, 3, 1, 8, (58, 70, 82), (90, 92, 96), jitter=1.0, lit_img=lit, lit_p=0.45)
    a = np.asarray(img, np.float32) / 255
    a += grime(amount=0.05)[..., None] + 0.015 * field(N, beta=0.6, fmin=50)[..., None]
    save('fac_office.jpg', a)
    L = np.asarray(lit, np.float32) / 255
    save('fac_office_e.jpg', L[..., :1] * np.array([1.0, 0.86, 0.64]))


def corrugated(name, base, rib_px=26, amount=0.07, door=False):
    x = np.arange(N)
    rib = 0.5 + 0.5 * np.cos(2 * np.pi * x / rib_px)
    g = base * (0.9 + 0.12 * rib)[None, :] * np.ones((N, 1))
    g += grime(amount=amount)
    if door:
        # big sliding door panels: vertical seams every 1/2 tile + horizontal stiffeners
        for c in (0, N // 2):
            g[:, max(0, c - 3):c + 3] *= 0.6
        for r in range(0, N, N // 4):
            g[max(0, r - 2):r + 2, :] *= 0.8
    return g


def hangar():
    g = corrugated('fac_hangar', 0.8)
    save('fac_hangar.jpg', rgb(g, (0.93, 0.94, 0.95)))
    g = corrugated('fac_hangar_door', 0.72, rib_px=34, door=True)
    # window strip near the top of the door panel
    g[int(N * 0.08):int(N * 0.16), :] = 0.25 + 0.05 * field(N, beta=1, fmin=4)[int(N * 0.08):int(N * 0.16), :]
    save('fac_hangar_door.jpg', rgb(g, (0.9, 0.92, 0.95)))
    g = corrugated('fac_mil_hangar', 0.6, rib_px=30, amount=0.035)
    save('fac_mil_hangar.jpg', rgb(g, (0.86, 0.9, 0.84)))


def garage():
    img = Image.new('RGB', (N, N), (165, 162, 155))
    dr = ImageDraw.Draw(img)
    beam = int(N * 1.05 / 3.1)
    dr.rectangle([0, beam, N, N], fill=(28, 28, 30))
    # interior: columns and a few cars / ceiling lights
    for i in range(3):
        x = int((i + 0.5) * N / 3)
        dr.rectangle([x - 18, beam, x + 18, N], fill=(120, 118, 112))
    for i in range(6):
        x = int(rng.uniform(0, N))
        base = rng.choice([30, 60, 120, 170, 200, 220])
        c = tuple(int(np.clip(base + v, 0, 255)) for v in rng.integers(-12, 12, 3))
        dr.rectangle([x, N - 110, x + 120, N - 40], fill=c)
    a = np.asarray(img, np.float32) / 255
    a[:beam] += grime(amount=0.06)[:beam, :, None]
    save('fac_garage.jpg', a)
    lit = np.zeros((N, N, 3), np.float32)
    lit[beam + 10:beam + 30] = np.array([1.0, 0.9, 0.7]) * 0.8
    save('fac_garage_e.jpg', lit)


def industrial():
    g = np.full((N, N), 0.72, np.float32) + grime(amount=0.06) + 0.015 * field(N, beta=0.6, fmin=50)
    for c in (0, N // 2):
        g[:, max(0, c - 2):c + 2] *= 0.7
    img = to_img(np.stack([g * 0.98, g * 0.96, g * 0.92], -1))
    dr = ImageDraw.Draw(img)
    # a roll-up door on one panel, small windows on the other
    dr.rectangle([int(N * 0.08), int(N * 0.45), int(N * 0.42), N], fill=(150, 152, 150))
    for yy in range(int(N * 0.45), N, 12):
        dr.line([int(N * 0.08), yy, int(N * 0.42), yy], fill=(120, 122, 120), width=2)
    for i in range(3):
        x = int(N * (0.58 + i * 0.13))
        dr.rectangle([x, int(N * 0.62), x + int(N * 0.08), int(N * 0.72)], fill=(50, 60, 70))
    save('fac_industrial.jpg', np.asarray(img, np.float32) / 255)
    g = np.full((N, N), 0.62, np.float32) + grime(amount=0.05)
    img = to_img(np.stack([g * 0.97, g * 0.95, g * 0.9], -1))
    dr = ImageDraw.Draw(img)
    for i in range(2):
        x0 = int(N * (0.06 + i * 0.5))
        dr.rectangle([x0, int(N * 0.3), x0 + int(N * 0.38), N], fill=(110, 112, 110))
        for yy in range(int(N * 0.3), N, 14):
            dr.line([x0, yy, x0 + int(N * 0.38), yy], fill=(90, 92, 90), width=2)
    save('fac_cargo.jpg', np.asarray(img, np.float32) / 255)


def roofs():
    g = np.full((N, N), 0.74, np.float32) + 0.04 * field(N, beta=2.0, fmin=1) + 0.015 * field(N, beta=0.5, fmin=60)
    for r in range(0, N, N // 6):
        g[max(0, r - 1):r + 2, :] *= 0.9
    g -= 0.05 * blur(speckles(N, 60, 4, 16), 6)
    save('roof_membrane.jpg', rgb(g, (1.0, 1.0, 0.99)))
    g = 0.42 + 0.03 * field(N, beta=0.3, fmin=100) + 0.05 * field(N, beta=2.0, fmin=1) + 0.06 * speckles(N, N * N // 200, 0.6, 1.8)
    save('roof_gravel.jpg', rgb(g, (1.0, 0.97, 0.92)))
    x = np.arange(N)
    seam = np.exp(-((x % (N // 8)) - 3) ** 2 / 4.0)
    g = 0.66 + 0.05 * seam[None, :] + grime(amount=0.04, streaks=False)
    save('roof_metal.jpg', rgb(g, (0.95, 0.97, 0.99)))


def military():
    g = 0.62 + grime(amount=0.09) + 0.02 * field(N, beta=0.5, fmin=60) - 0.06 * blur(speckles(N, 50, 3, 14), 5)
    # formwork joints
    for r in range(0, N, N // 4):
        g[max(0, r - 1):r + 2, :] *= 0.9
    save('fac_mil_concrete.jpg', rgb(g, (0.98, 0.97, 0.93)))
    img = Image.new('RGB', (N, N), (196, 180, 150))
    lit = Image.new('RGB', (N, N), (0, 0, 0))
    window_grid(img, int(N * 0.15), int(N * 0.3), int(N * 0.7), int(N * 0.42), 2, 1, 10, (55, 62, 70), (230, 226, 216), jitter=1.0, lit_img=lit, lit_p=0.5)
    a = np.asarray(img, np.float32) / 255 + grime(amount=0.05)[..., None]
    save('fac_mil_stucco.jpg', a)
    L = np.asarray(lit, np.float32) / 255
    save('fac_mil_stucco_e.jpg', L[..., :1] * np.array([1.0, 0.86, 0.64]))


def tower_and_bridge():
    # SFO tower shaft: light precast concrete with vertical fins every 0.5 m
    x = np.arange(N)
    fin = 0.5 + 0.5 * np.cos(2 * np.pi * x / (N / 8))
    g = 0.78 * (0.94 + 0.08 * fin)[None, :] * np.ones((N, 1)) + grime(amount=0.03)
    save('tower_shaft.jpg', rgb(g, (0.99, 0.98, 0.96)))
    # jet bridge side: corrugated steel with a window strip
    g = corrugated('fac_jetbridge', 0.78, rib_px=20, amount=0.05)
    g[int(N * 0.25):int(N * 0.55), :] = 0.22 + 0.04 * field(N, beta=1.5, fmin=3)[int(N * 0.25):int(N * 0.55), :]
    for c in range(0, N, N // 3):
        g[int(N * 0.25):int(N * 0.55), max(0, c - 5):c + 5] = 0.6
    save('fac_jetbridge.jpg', rgb(g, (0.9, 0.92, 0.94)))


def main():
    os.makedirs(OUT, exist_ok=True)
    glass_curtain(); terminal_panels(); office(); hangar(); garage(); industrial(); roofs(); military(); tower_and_bridge()
    json.dump(FACADES, open(os.path.join(OUT, 'facades.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
