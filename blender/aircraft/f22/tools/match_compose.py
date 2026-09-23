"""Compose photo-vs-model comparisons (project venv).

  python match_compose.py <out_dir> <cam.json> [render.png]  -> <out_dir>/<name>_cmp.jpg
Top: photo with the model silhouette outline (red) + model render blended; bottom: the render alone.
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter

d, cp = sys.argv[1], sys.argv[2]
c = json.load(open(cp))
name = os.path.splitext(os.path.basename(cp))[0].replace('_cam', '')
H = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
photo = Image.open(os.path.join(H, c['image'])).convert('RGB')
rp = sys.argv[3] if len(sys.argv) > 3 else os.path.join(d, f'{name}_wb.png')
ren = Image.open(rp).convert('RGBA')
sil = Image.open(os.path.join(d, f'{name}_sil.png')).convert('RGBA')
W, Hh = ren.size
photo = photo.resize((W, Hh), Image.LANCZOS)
a = np.asarray(sil).astype(np.float32)[..., 3] / 255.0
edge = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES)).astype(np.float32) / 255.0
edge = np.clip(edge * 3, 0, 1)
P = np.asarray(photo).astype(np.float32) / 255.0
ov = P * (1 - edge[..., None]) + np.array([1.0, 0.1, 0.05]) * edge[..., None]
R = np.asarray(ren).astype(np.float32) / 255.0
bg = np.full((Hh, W, 3), 0.85, np.float32)
rr = R[..., :3] * R[..., 3:4] + bg * (1 - R[..., 3:4])
side = np.concatenate([np.concatenate([P, rr], 1), np.concatenate([ov, P * 0.5 + rr * 0.5], 1)], 0)
Image.fromarray((np.clip(side, 0, 1) * 255).astype(np.uint8)).save(os.path.join(d, f'{name}_cmp.jpg'), quality=88)
print('composed', os.path.join(d, f'{name}_cmp.jpg'))
