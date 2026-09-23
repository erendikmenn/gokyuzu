"""UH-60M interior textures (venv python): instrument panel face, MFD bezel, console/overhead panels, cabin floor,
quilted insulation (+ normal map), blade texture, rotor blur. Deterministic.

    python intex.py <out_dir>
"""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
FD = '/System/Library/Fonts/Supplemental/'
F_N = FD + 'Arial Narrow.ttf'
F_NB = FD + 'Arial Narrow Bold.ttf'
F_DIN = FD + 'DIN Condensed Bold.ttf'
RNG = np.random.default_rng(7)
LBL = (222, 222, 212)


def f(path, px):
    return ImageFont.truetype(path, max(6, int(px)))


def noise_img(w, h, sigma, amp, seed=0):
    r = np.random.default_rng(seed).standard_normal((h, w)).astype(np.float32)
    r = ndimage.gaussian_filter(r, sigma, mode='wrap')
    r /= r.std() + 1e-6
    return r * amp


def paint_bg(w, h, rgb, amp=4, seed=1):
    base = np.ones((h, w, 3), np.float32) * np.array(rgb, np.float32)
    base += noise_img(w, h, 3, amp, seed)[..., None]
    base += noise_img(w, h, 0.7, amp * 0.5, seed + 1)[..., None]
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


# ------------------------------------------------------------------------------------------ instrument panel
def panel_face():
    # face spans u -0.96..0.96 m, v -0.30..0.30 m -> 2048 x 640
    W, H = 2048, 640
    ppm = W / 1.92
    im = paint_bg(W, H, (44, 47, 50), 3)
    d = ImageDraw.Draw(im)

    def P(u, v):
        return ((u + 0.96) * ppm, (0.30 - v) * ppm)

    def box(u0, v0, u1, v1, fill, outline=None, r=4, w=2):
        a, b = P(u0, v1), P(u1, v0)
        d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=r, fill=fill, outline=outline, width=w)

    def label(u, v, s, px=15, font=F_N, fill=LBL):
        d.text(P(u, v), s, font=f(font, px), fill=fill, anchor='mm')

    def knob(u, v, r=0.013, lab=None):
        x, y = P(u, v)
        rr = r * ppm
        d.ellipse([x - rr - 5, y - rr - 5, x + rr + 5, y + rr + 5], fill=(30, 31, 33))
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(18, 18, 19), outline=(70, 72, 74), width=2)
        a = RNG.uniform(0, 2 * math.pi)
        d.line([x, y, x + math.cos(a) * rr * 0.8, y + math.sin(a) * rr * 0.8], fill=(230, 230, 220), width=3)
        if lab:
            label(u, v - r - 0.016, lab, 13)

    def toggle(u, v, lab=None):
        x, y = P(u, v)
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(90, 92, 94), outline=(20, 20, 20), width=2)
        d.line([x, y, x, y - 18], fill=(200, 200, 200), width=5)
        if lab:
            label(u, v - 0.02, lab, 12)

    def annun(u, v, s, col=(60, 58, 40)):
        box(u - 0.028, v - 0.011, u + 0.028, v + 0.011, col, (15, 15, 15), 3, 2)
        label(u, v, s, 12, F_NB, (200, 190, 120) if col[0] > col[2] else (170, 200, 170))

    # recessed MFD wells
    for x in (0.535, 0.195, -0.195, -0.535):
        box(x - 0.125, 0.075 - 0.152, x + 0.125, 0.075 + 0.152, (22, 23, 24), (60, 62, 64), 8, 3)
    # centre stack: master caution / warning, standby instrument, clock
    for s, u in (('MASTER\nCAUTION', -0.05), ('MASTER\nWARNING', 0.05)):
        box(u - 0.035, 0.235, u + 0.035, 0.275, (70, 50, 20) if 'CAU' in s else (80, 20, 18), (10, 10, 10), 4)
        d.multiline_text(P(u, 0.255), s, font=f(F_NB, 12), fill=(235, 200, 110) if 'CAU' in s else (240, 120, 110), anchor='mm', align='center')
    box(-0.05, -0.245, 0.05, -0.155, (15, 15, 16), (80, 82, 84), 6, 3)
    label(0, -0.14, 'ESIS', 12)
    x, y = P(0, -0.20)
    d.ellipse([x - 38, y - 38, x + 38, y + 38], fill=(40, 70, 120))
    d.chord([x - 38, y - 38, x + 38, y + 38], 0, 180, fill=(110, 76, 40))
    d.line([x - 30, y, x + 30, y], fill=(240, 240, 240), width=3)
    for k, s in enumerate(('FIRE', 'ENG 1', 'ENG 2', 'APU', 'CHIP', 'LOW FUEL')):
        annun(-0.06 + (k % 2) * 0.12, 0.13 - (k // 2) * 0.03, s, (60, 55, 35) if k else (80, 25, 20))
    # bottom row of control panels
    for k, u in enumerate(np.linspace(-0.86, 0.86, 9)):
        box(u - 0.085, -0.295, u + 0.085, -0.215, (40, 43, 46), (20, 20, 20), 5, 2)
        knob(u - 0.04, -0.262, 0.011)
        knob(u + 0.04, -0.262, 0.011)
        label(u, -0.232, ['BRT', 'HDG', 'CRS', 'BARO', 'RAD ALT', 'BARO', 'CRS', 'HDG', 'BRT'][k], 12)
    # side panels next to the outer MFDs
    for s in (-1, 1):
        u0 = s * 0.80
        box(u0 - 0.13, -0.19, u0 + 0.13, 0.26, (40, 43, 46), (20, 20, 20), 6, 2)
        label(u0, 0.235, 'CLOCK' if s < 0 else 'FUEL MGMT', 13, F_NB)
        x, y = P(u0, 0.15)
        d.ellipse([x - 42, y - 42, x + 42, y + 42], fill=(12, 12, 12), outline=(90, 90, 90), width=3)
        for a in range(12):
            aa = a / 12 * 2 * math.pi
            d.line([x + 34 * math.cos(aa), y + 34 * math.sin(aa), x + 40 * math.cos(aa), y + 40 * math.sin(aa)], fill=(220, 220, 210), width=2)
        for k in range(4):
            toggle(u0 - 0.075 + k * 0.05, 0.03, ['PUMP', 'XFEED', 'PRIME', 'BOOST'][k] if s > 0 else ['LT', 'NVG', 'TEST', 'RST'][k])
        for k in range(3):
            knob(u0 - 0.07 + k * 0.07, -0.10, 0.012, ['PNL', 'CSL', 'FLOOD'][k])
    # screws
    for u in np.linspace(-0.94, 0.94, 25):
        for v in (-0.29, 0.29):
            x, y = P(u, v)
            d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(70, 72, 74))
    im.save(os.path.join(OUT, 'int_panel.jpg'), quality=92)


def mfd_bezel():
    W, H = 512, 634            # 0.236 x 0.292 m
    im = paint_bg(W, H, (26, 27, 29), 3, 5)
    d = ImageDraw.Draw(im)
    sx, sy = W / 0.236, H / 0.292
    # screen window (6 x 8 in) centred, 4 mm high
    x0, x1 = (0.118 - 0.0762) * sx, (0.118 + 0.0762) * sx
    y0, y1 = (0.146 - 0.1016 - 0.004) * sy, (0.146 + 0.1016 - 0.004) * sy
    d.rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 6], fill=(8, 8, 9), outline=(55, 57, 60), width=3)
    labs_l = ['PFD', 'ND', 'ENG', 'FUEL', 'ACFT', 'DCLT']
    labs_r = ['TAC', 'FLT', 'COM', 'NAV', 'WPN', 'DATA']
    for k in range(6):
        yy = y0 + (k + 0.5) * (y1 - y0) / 6
        for (xx, lab) in ((x0 - 34, labs_l[k]), (x1 + 34, labs_r[k])):
            d.rounded_rectangle([xx - 22, yy - 16, xx + 22, yy + 16], radius=5, fill=(48, 50, 52), outline=(12, 12, 12), width=2)
            d.text((xx, yy), lab, font=f(F_NB, 13), fill=LBL, anchor='mm')
    for k in range(5):
        xx = x0 + (k + 0.5) * (x1 - x0) / 5
        for yy in (y0 - 30, y1 + 30):
            d.rounded_rectangle([xx - 20, yy - 13, xx + 20, yy + 13], radius=5, fill=(48, 50, 52), outline=(12, 12, 12), width=2)
    d.text((W / 2, H - 14), 'BRT  -  +  DIM', font=f(F_NB, 14), fill=LBL, anchor='mm')
    for (xx, yy) in ((14, 14), (W - 14, 14), (14, H - 14), (W - 14, H - 14)):
        d.ellipse([xx - 5, yy - 5, xx + 5, yy + 5], fill=(80, 80, 82))
    im.save(os.path.join(OUT, 'int_bezel.jpg'), quality=92)


def consoles():
    """1024 x 1024: left half = centre console top (0.37 x 0.80 m, v up = forward), right half = overhead panel."""
    W, H = 1024, 1024
    im = paint_bg(W, H, (42, 45, 48), 3, 9)
    d = ImageDraw.Draw(im)
    # --- centre console (u 0..512)
    def C(u, v):  # u -0.185..0.185 m, v 0..0.80 m (0 = aft)
        return ((u + 0.185) / 0.37 * 512, H - v / 0.80 * H)

    def cbox(u0, v0, u1, v1, fill=(36, 39, 42)):
        a, b = C(u0, v1), C(u1, v0)
        d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=4, fill=fill, outline=(15, 15, 15), width=2)

    # two CDUs (screen + keys)
    for k, v0 in enumerate((0.42, 0.62)):
        cbox(-0.175, v0, 0.175, v0 + 0.17)
        a, b = C(-0.10, v0 + 0.16), C(0.10, v0 + 0.085)
        d.rectangle([a[0], a[1], b[0], b[1]], fill=(12, 30, 18))
        for r in range(4):
            d.text((a[0] + 8, a[1] + 6 + r * 13), ['FLT PLAN  1/3', 'KNGZ   24', 'WPT  ALAMEDA', 'EXEC'][r], font=f(F_N, 12), fill=(90, 230, 120))
        for r in range(3):
            for c in range(8):
                x, y = C(-0.16 + c * 0.0457, v0 + 0.07 - r * 0.022)
                d.rounded_rectangle([x - 9, y - 7, x + 9, y + 7], radius=2, fill=(62, 64, 66), outline=(10, 10, 10))
        for r in range(6):
            for s in (-1, 1):
                x, y = C(s * 0.14, v0 + 0.155 - r * 0.013)
                d.rectangle([x - 7, y - 4, x + 7, y + 4], fill=(62, 64, 66))
    # radio / AFCS panels
    names = ['AFCS', 'VHF', 'UHF', 'IFF', 'ICS']
    for k in range(5):
        v0 = 0.02 + k * 0.078
        cbox(-0.175, v0, 0.175, v0 + 0.07)
        d.text(C(-0.15, v0 + 0.058), names[k], font=f(F_NB, 13), fill=LBL, anchor='lm')
        for j in range(3):
            x, y = C(-0.09 + j * 0.09, v0 + 0.03)
            d.ellipse([x - 14, y - 14, x + 14, y + 14], fill=(16, 16, 17), outline=(80, 80, 80), width=2)
        a, b = C(0.05, v0 + 0.06), C(0.16, v0 + 0.04)
        d.rectangle([a[0], a[1], b[0], b[1]], fill=(30, 22, 10))
        d.text(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), ['ALT HLD', '121.50', '243.00', 'MODE 3', 'HOT MIC'][k], font=f(F_N, 12), fill=(250, 170, 60), anchor='mm')
    # --- overhead panel (u 512..1024): u -0.165..0.165, v 0 (aft) .. 1 (front)
    def O(u, v):
        return (512 + (u + 0.165) / 0.33 * 512, H - v * H)
    rows = [('ENG 1   ENG 2', 0.93), ('FUEL', 0.80), ('ANTI-ICE', 0.66), ('LIGHTS', 0.52), ('APU  GEN', 0.38), ('CB PANEL', 0.20)]
    for name, v in rows:
        a, b = O(-0.16, v + 0.06), O(0.16, v - 0.06)
        d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=5, fill=(40, 43, 46), outline=(12, 12, 12), width=2)
        d.text(O(0, v + 0.045), name, font=f(F_NB, 14), fill=LBL, anchor='mm')
        if name == 'CB PANEL':
            for r in range(3):
                for c in range(14):
                    x, y = O(-0.145 + c * 0.0223, v + 0.02 - r * 0.025)
                    d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(20, 20, 20), outline=(150, 150, 150))
            continue
        for c in range(6):
            x, y = O(-0.13 + c * 0.052, v - 0.01)
            d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(95, 97, 99), outline=(15, 15, 15), width=2)
            d.line([x, y, x, y - 20], fill=(210, 210, 210), width=5)
    im.save(os.path.join(OUT, 'int_console.jpg'), quality=92)


# ------------------------------------------------------------------------------------------ tiling materials
def floor_tile():
    W = 512                   # 0.5 m tile
    base = np.ones((W, W, 3), np.float32) * np.array([70, 72, 72], np.float32)
    base += noise_img(W, W, 0.6, 9, 11)[..., None]
    base += noise_img(W, W, 12, 5, 12)[..., None]
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    d.line([0, 0, W, 0], fill=(34, 34, 34), width=3)
    # screw heads along the panel joint
    for k in range(8):
        x = 32 + k * 64
        d.ellipse([x - 4, 4, x + 4, 12], fill=(95, 96, 96))
    im.save(os.path.join(OUT, 'int_floor.jpg'), quality=90)


def quilt_tile():
    W = 512                   # 0.45 m tile: 3 x 3 stitched puffs
    y, x = np.mgrid[0:W, 0:W].astype(np.float32) / W
    cells = 3
    fx, fy = (x * cells) % 1.0, (y * cells) % 1.0
    h = np.sin(fx * np.pi) ** 0.6 * np.sin(fy * np.pi) ** 0.6
    h += 0.04 * noise_img(W, W, 2, 1.0, 21)
    stitch = (np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) < 0.012)
    col = np.ones((W, W, 3), np.float32) * np.array([122, 119, 101], np.float32)   # tan soundproofing blankets
    col *= (0.88 + 0.12 * h)[..., None]
    col += noise_img(W, W, 0.8, 3, 22)[..., None]
    col[stitch] *= 0.82
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'int_quilt.jpg'), quality=90)
    s = 6.0
    gy, gx = np.gradient(h)
    n = np.stack([-gx * s, gy * s, np.ones_like(h)], -1)     # image rows go down = -v
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save(os.path.join(OUT, 'int_quilt_nrm.jpg'), quality=92)


# ------------------------------------------------------------------------------------------ main rotor blade
def blade_tex():
    """2048 x 256: u = span (0 root .. 1 tip), v = around the airfoil (0 TE upper .. 0.5 LE .. 1 TE lower)."""
    W, H = 2048, 256
    col = np.ones((H, W, 3), np.float32) * np.array([48, 50, 47], np.float32)
    col += noise_img(W, H, 24, 0.7, 31)[..., None]
    col += noise_img(W, H, 1.0, 0.35, 32)[..., None]
    u = np.linspace(0, 1, W)[None, :]
    v = np.linspace(0, 1, H)[:, None]
    le = np.abs(v - 0.5) < 0.085                  # titanium / nickel abrasion strip
    col[np.broadcast_to(le, (H, W))] = [120, 122, 120]
    # tip cap (swept tip, lighter composite)
    tip = u > 0.93
    col[np.broadcast_to(tip & ~le, (H, W))] = [58, 60, 57]
    # trim tabs outline and blade stripe near the tip (white/yellow tip marking on upper surface)
    stripe = (u > 0.955) & (u < 0.975) & (v < 0.45)
    col[np.broadcast_to(stripe, (H, W))] = [150, 150, 140]
    # exhaust / oil streaks along the span
    col *= (1 - 0.025 * np.clip(noise_img(W, H, (3, 60), 1.0, 33), 0, 2))[..., None]
    Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'blade.jpg'), quality=90)


def screens_placeholder():
    """Dark screen texture used in the GLB (avionics replaces it at runtime)."""
    im = Image.new('RGB', (64, 64), (6, 8, 10))
    im.save(os.path.join(OUT, 'screen_off.jpg'), quality=90)


if __name__ == '__main__':
    panel_face()
    mfd_bezel()
    consoles()
    floor_tile()
    quilt_tile()
    blade_tex()
    screens_placeholder()
    print('intex ok')
