#!/usr/bin/env python3
"""Look-check grid: one row per pose, one column per capture folder (e.g. desktop high | integrated | tablet | phone).
    .venv/bin/python tools/perf/grid.py out.png --dirs a/ b/ c/ --labels A B C --poses p1 p2 [--crop x,y,w,h] [--cell 640]"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw
ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--dirs', nargs='+', required=True); ap.add_argument('--labels', nargs='+')
ap.add_argument('--poses', nargs='+', required=True); ap.add_argument('--crop'); ap.add_argument('--cell', type=int, default=640)
a = ap.parse_args()
labels = a.labels or [Path(d).name for d in a.dirs]
first = Image.open(Path(a.dirs[0]) / f'{a.poses[0]}.png')
cw = a.cell
if a.crop:
    x, y, w, h = map(int, a.crop.split(','))
else:
    x, y, w, h = 0, 0, first.width, first.height
ch = int(h * cw / w)
out = Image.new('RGB', (cw * len(a.dirs), (ch + 18) * len(a.poses) + 20), (18, 18, 18))
d = ImageDraw.Draw(out)
for j, l in enumerate(labels):
    d.text((j * cw + 6, 4), l, fill=(235, 235, 235))
for i, p in enumerate(a.poses):
    y0 = 20 + i * (ch + 18)
    d.text((6, y0 + 2), p, fill=(170, 200, 255))
    for j, dd in enumerate(a.dirs):
        f = Path(dd) / f'{p}.png'
        if f.exists():
            im = Image.open(f).convert('RGB').crop((x, y, x + w, y + h)).resize((cw, ch), Image.LANCZOS)
            out.paste(im, (j * cw, y0 + 16))
out.save(a.out)
