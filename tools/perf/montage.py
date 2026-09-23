#!/usr/bin/env python3
"""Side-by-side review image for the quality gate: baseline | candidate | SSIM heat map (+ optional crop zoom).
    .venv/bin/python tools/perf/montage.py base.png cand.png heat.png out.png [--crop x,y,w,h] [--width 1600]"""
import argparse
from PIL import Image, ImageDraw
ap = argparse.ArgumentParser()
ap.add_argument('a'); ap.add_argument('b'); ap.add_argument('heat'); ap.add_argument('out')
ap.add_argument('--crop'); ap.add_argument('--width', type=int, default=1800)
a = ap.parse_args()
ims = [Image.open(p).convert('RGB') for p in (a.a, a.b, a.heat)]
if a.crop:
    x, y, w, h = map(int, a.crop.split(','))
    ims = [im.crop((x, y, x + w, y + h)) for im in ims]
w = a.width // 3
h = int(ims[0].height * w / ims[0].width)
out = Image.new('RGB', (w * 3, h + 22), (20, 20, 20))
d = ImageDraw.Draw(out)
for i, (im, label) in enumerate(zip(ims, ('baseline', 'candidate', 'SSIM heat map (red = different)'))):
    out.paste(im.resize((w, h)), (i * w, 22))
    d.text((i * w + 6, 5), label, fill=(230, 230, 230))
out.save(a.out)
