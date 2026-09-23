"""Cockpit label-plate textures (venv python). Reads the plate layout written by interior.py and draws every plate into
its region of a texture page: panel paint, engraved/white legends, knob scales, annunciator legends, placards, screws.

    python cptex.py <layout.json> <out_dir>

Plate coordinates: (u, v) in metres from the plate's bottom-left corner, v up. Pages are drawn at 'ppm' px/m.
"""
import os
import sys
import json
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage

LAYOUT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
FD = '/System/Library/Fonts/Supplemental/'
FONTS = {
    'r': FD + 'Arial Narrow.ttf',
    'b': FD + 'Arial Narrow Bold.ttf',
    'd': FD + 'DIN Condensed Bold.ttf',
    'c': FD + 'Courier New Bold.ttf',
}
_fc = {}


def font(k, px):
    px = max(5, int(round(px)))
    key = (k, px)
    if key not in _fc:
        _fc[key] = ImageFont.truetype(FONTS.get(k, FONTS['r']), px)
    return _fc[key]


def col(c, a=255):
    if isinstance(c, str):
        c = c.lstrip('#')
        if len(c) == 3:
            c = ''.join(ch * 2 for ch in c)
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) + (a,)
    return tuple(c) + ((a,) if len(c) == 3 else ())


def noise(w, h, sigma, seed):
    r = np.random.default_rng(seed).standard_normal((h, w)).astype(np.float32)
    r = ndimage.gaussian_filter(r, sigma, mode='wrap')
    return r / (r.std() + 1e-6)


class PlateDraw:
    def __init__(self, img, x0, y0, wpx, hpx, w, h):
        self.im = img
        self.d = ImageDraw.Draw(img, 'RGBA')
        self.x0, self.y0, self.wpx, self.hpx = x0, y0, wpx, hpx
        self.sx, self.sy = wpx / w, hpx / h
        self.h = h

    def P(self, u, v):
        return (self.x0 + u * self.sx, self.y0 + (self.h - v) * self.sy)

    def m(self, d):
        return d * self.sx

    def text(self, it):
        u, v, s = it['u'], it['v'], it['t']
        px = self.m(it.get('h', 0.004)) * 1.42
        f = font(it.get('f', 'b'), px)
        fill = col(it.get('c', '#e6e6dc'))
        anchor = it.get('a', 'mm')
        rot = it.get('rot', 0)
        lines = s.split('\n')
        if rot:
            tw = int(max(f.getlength(l) for l in lines)) + 8
            th = int(px * 1.25 * len(lines)) + 8
            tmp = Image.new('RGBA', (tw, th), (0, 0, 0, 0))
            ImageDraw.Draw(tmp).multiline_text((tw / 2, th / 2), s, font=f, fill=fill, anchor='mm', align='center', spacing=px * 0.15)
            tmp = tmp.rotate(rot, expand=True, resample=Image.BICUBIC)
            x, y = self.P(u, v)
            self.im.alpha_composite(tmp, (int(x - tmp.width / 2), int(y - tmp.height / 2)))
        elif len(lines) > 1:
            self.d.multiline_text(self.P(u, v), s, font=f, fill=fill, anchor=anchor, align='center', spacing=px * 0.15)
        else:
            self.d.text(self.P(u, v), s, font=f, fill=fill, anchor=anchor)

    def box(self, it):
        a = self.P(it['u0'], it['v1'])
        b = self.P(it['u1'], it['v0'])
        r = self.m(it.get('r', 0.0))
        fill = col(it['fill']) if it.get('fill') else None
        ol = col(it['ol']) if it.get('ol') else None
        wd = max(1, int(self.m(it.get('w', 0.0008))))
        self.d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=r, fill=fill, outline=ol, width=wd)

    def line(self, it):
        pts = [self.P(u, v) for u, v in it['p']]
        self.d.line(pts, fill=col(it.get('c', '#d8d8d0')), width=max(1, int(self.m(it.get('w', 0.0007)))))

    def circle(self, it):
        x, y = self.P(it['u'], it['v'])
        r = self.m(it['r'])
        fill = col(it['fill']) if it.get('fill') else None
        ol = col(it['ol']) if it.get('ol') else None
        self.d.ellipse([x - r, y - r, x + r, y + r], fill=fill, outline=ol, width=max(1, int(self.m(it.get('w', 0.0007)))))

    def scale(self, it):
        """Knob scale: ticks from angle a0 to a1 (deg, 0 = up, clockwise), optional labels at the major ticks."""
        x, y = self.P(it['u'], it['v'])
        r0, r1 = self.m(it['r0']), self.m(it['r1'])
        a0, a1, n = it.get('a0', -135), it.get('a1', 135), it.get('n', 11)
        c = col(it.get('c', '#e6e6dc'))
        labels = it.get('labels') or []
        lh = it.get('lh', 0.0028)
        for k in range(n):
            a = math.radians(a0 + (a1 - a0) * k / max(1, n - 1))
            sa, ca = math.sin(a), -math.cos(a)
            major = (k % it.get('major', 1) == 0)
            rr0 = r0 if major else (r0 + r1) / 2
            self.d.line([x + sa * rr0, y + ca * rr0, x + sa * r1, y + ca * r1], fill=c, width=max(1, int(self.m(0.0006))))
        for k, lab in enumerate(labels):
            if not lab:
                continue
            a = math.radians(a0 + (a1 - a0) * k / max(1, len(labels) - 1))
            rr = r1 + self.m(lh) * 1.6
            f = font('b', self.m(lh) * 1.42)
            self.d.text((x + math.sin(a) * rr, y - math.cos(a) * rr), lab, font=f, fill=c, anchor='mm')

    def legend(self, it):
        """Annunciator / capsule legend: dark lens with coloured (unlit) lettering."""
        u, v, w, h = it['u'], it['v'], it['w'], it['h']
        a = self.P(u - w / 2, v + h / 2)
        b = self.P(u + w / 2, v - h / 2)
        self.d.rectangle([a[0], a[1], b[0], b[1]], fill=col(it.get('bg', '#141412')), outline=col('#050505'), width=max(1, int(self.m(0.0008))))
        px = self.m(it.get('th', h * 0.28)) * 1.42
        # shrink until the legend fits inside the lens (85 % of its width / height)
        while px > 5:
            f = font('b', px)
            bb = self.d.multiline_textbbox((0, 0), it['t'], font=f, align='center', spacing=2) if it['t'] else (0, 0, 0, 0)
            if bb[2] - bb[0] <= self.m(w) * 0.86 and bb[3] - bb[1] <= self.m(h) * 0.86:
                break
            px *= 0.92
        if it['t']:
            self.d.multiline_text(self.P(u, v), it['t'], font=f, fill=col(it.get('c', '#b8b08a')), anchor='mm', align='center', spacing=2)

    def screw(self, it):
        x, y = self.P(it['u'], it['v'])
        r = self.m(it.get('r', 0.0022))
        self.d.ellipse([x - r, y - r, x + r, y + r], fill=col('#6a6c6e'), outline=col('#1a1a1a'), width=1)
        a = it.get('a', 30)
        dx, dy = math.cos(math.radians(a)) * r * 0.8, math.sin(math.radians(a)) * r * 0.8
        self.d.line([x - dx, y - dy, x + dx, y + dy], fill=col('#2a2a2a'), width=max(1, int(r * 0.35)))

    def stripes(self, it):
        """Black/yellow warning stripes in a box."""
        a = self.P(it['u0'], it['v1'])
        b = self.P(it['u1'], it['v0'])
        tmp = Image.new('RGBA', (int(b[0] - a[0]) + 1, int(b[1] - a[1]) + 1), col('#e0b020'))
        td = ImageDraw.Draw(tmp)
        s = max(4, int(self.m(it.get('s', 0.006))))
        for k in range(-tmp.height, tmp.width, 2 * s):
            td.polygon([(k, tmp.height), (k + s, tmp.height), (k + s + tmp.height, 0), (k + tmp.height, 0)], fill=col('#141414'))
        self.im.alpha_composite(tmp, (int(a[0]), int(a[1])))


def draw_plate(img, pl, rng):
    x0, y0, wpx, hpx = pl['x'], pl['y'], pl['wpx'], pl['hpx']
    w, h = pl['w'], pl['h']
    # base paint with subtle mottling, edge wear and a lighter bevel line
    bg = np.array(col(pl.get('bg', '#1e1f21'))[:3], np.float32)
    n1 = noise(wpx, hpx, 2.0, rng.integers(1 << 30)) * 2.2 + noise(wpx, hpx, 0.6, rng.integers(1 << 30)) * 1.4
    n2 = noise(wpx, hpx, max(4, wpx / 12), rng.integers(1 << 30))
    a = bg[None, None, :] + n1[..., None] + n2[..., None] * pl.get('mottle', 1.6)
    # worn / polished edges
    yy, xx = np.mgrid[0:hpx, 0:wpx]
    e = np.minimum(np.minimum(xx, wpx - 1 - xx), np.minimum(yy, hpx - 1 - yy)).astype(np.float32)
    ew = np.exp(-e / max(1.5, wpx * 0.006)) * pl.get('edgewear', 10.0)
    a += ew[..., None] * (0.6 + 0.4 * (n2[..., None] > 0.3))
    tile = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')
    img.paste(tile, (x0, y0))
    D = PlateDraw(img, x0, y0, wpx, hpx, w, h)
    if pl.get('border', True):
        D.box({'u0': 0.0015, 'v0': 0.0015, 'u1': w - 0.0015, 'v1': h - 0.0015, 'ol': '#050505', 'w': 0.0012, 'r': 0.002})
    for it in pl.get('items', []):
        getattr(D, it['k'])(it)
    if pl.get('screws', True) and w > 0.03 and h > 0.03:
        for (u, v) in ((0.006, 0.006), (w - 0.006, 0.006), (0.006, h - 0.006), (w - 0.006, h - 0.006)):
            D.screw({'u': u, 'v': v, 'r': 0.0024, 'a': rng.uniform(0, 180)})


def main():
    L = json.load(open(LAYOUT))
    rng = np.random.default_rng(11)
    for name, pg in L['pages'].items():
        W, H = pg['w'], pg['h']
        img = Image.new('RGBA', (W, H), col(pg.get('bg', '#1b1c1e')))
        for pl in L['plates']:
            if pl['page'] == name:
                draw_plate(img, pl, rng)
        img = img.convert('RGB')
        img.save(os.path.join(OUT, f'{name}.png'), optimize=False, compress_level=3)
        print('page', name, W, H, sum(1 for p in L['plates'] if p['page'] == name), 'plates', flush=True)
    print('cptex ok')


if __name__ == '__main__':
    main()
