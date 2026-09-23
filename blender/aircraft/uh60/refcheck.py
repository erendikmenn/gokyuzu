"""Overlay the orthographic previews on the public-domain UH-60 dimension drawing (dev tool, venv python).

    .venv/bin/python blender/aircraft/uh60/refcheck.py <preview_dir> <dims.png>
"""
import sys
import numpy as np
from PIL import Image

pv, ref = sys.argv[1], sys.argv[2]
d = Image.open(ref).convert('L')

# side view: drawing 0.0207 m/px, mast at X=1049, ground at Y=374. preview 'left': 2000x680, 0.01035 m/px, centre (y=-1.884, z=2.98)
crop = d.crop((640, 60, 1640, 400)).resize((2000, 680), Image.LANCZOS)
r = Image.open(f'{pv}/pv_left.png').convert('RGB')
a = np.asarray(r).astype(float)
lines = np.asarray(crop).astype(float) < 128
a[lines] = a[lines] * 0.3 + np.array([255, 0, 0]) * 0.7
Image.fromarray(a.astype(np.uint8)).save(f'{pv}/ov_left.png')

# front view: drawing 0.0148 m/px, centre X=284.2, ground Y=560. preview 'front': 1000x1000, 0.007 m/px, centre z=2.2
s = 0.0148 / 0.007
X0 = 284.2 - 500 / s
Y0 = (560 - 2.2 / 0.0148) - 500 / s
crop = d.crop((int(X0), int(Y0), int(X0 + 1000 / s), int(Y0 + 1000 / s))).resize((1000, 1000), Image.LANCZOS)
r = Image.open(f'{pv}/pv_front.png').convert('RGB')
a = np.asarray(r).astype(float)
lines = np.asarray(crop).astype(float) < 128
a[lines] = a[lines] * 0.3 + np.array([255, 0, 0]) * 0.7
Image.fromarray(a.astype(np.uint8)).save(f'{pv}/ov_front.png')
print('ok')
