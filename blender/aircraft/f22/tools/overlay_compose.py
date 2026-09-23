"""Compose red model silhouettes over the reference 3-view (project venv)."""
import sys, os
import numpy as np
from PIL import Image
ref, d = sys.argv[1], sys.argv[2]
im = Image.open(ref).convert('RGBA')
bg = Image.new('RGBA', im.size, (255, 255, 255, 255)); bg.alpha_composite(im)
base = np.asarray(bg.convert('RGB')).astype(np.float32)
boxes = {'top': (820, 20, 2048, 900), 'side': (0, 580, 1160, 880), 'front': (80, 50, 930, 330)}
for name, box in boxes.items():
    sil = np.asarray(Image.open(os.path.join(d, f'sil_{name}.png')).convert('RGBA')).astype(np.float32)
    a = (sil[..., 3:4] / 255.0) * 0.45
    col = base * (1 - a) + np.array([230, 40, 30], np.float32) * a
    Image.fromarray(col.astype(np.uint8)).crop(box).save(os.path.join(d, f'ov_{name}.png'))
print('composed')
