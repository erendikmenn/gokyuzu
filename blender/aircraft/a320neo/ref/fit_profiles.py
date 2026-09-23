"""Fit smooth fuselage profile curves to the silhouettes digitized from the Airbus A320 AC manual
(AC_A320, figures 2-2-0 "General Aircraft Dimensions - Sharklet", 400 dpi raster of the vector drawings).

Run with the repo venv:  .venv/bin/python blender/aircraft/a320neo/ref/fit_profiles.py
Writes ref/profiles.json: dense samples (station s from the nose tip, meters) of
  top(s), bot(s)  : fuselage upper / lower silhouette relative to the fuselage axis (m)
  hw(s)           : fuselage half width (m)
The drawing is normalised so the constant section is exactly 3.95 m wide x 4.14 m high.
"""
import json
import os
import numpy as np
from scipy.interpolate import UnivariateSpline, PchipInterpolator

HERE = os.path.dirname(os.path.abspath(__file__))
side = np.array(json.load(open(os.path.join(HERE, 'side_profile.json'))))
plan = np.array(json.load(open(os.path.join(HERE, 'plan_halfwidth.json'))))

AX = 3.85                    # drawing: axis height above ground
ZS = 4.14 / 4.06             # vertical normalisation
WS = 1.975 / 1.92            # lateral normalisation
L = 37.57
HALF_H = 2.07
HW = 1.975

s = side[:, 0]
top = (side[:, 1] - AX) * ZS
bot = (side[:, 2] - AX) * ZS
ps = plan[:, 0]
hw = 0.5 * (plan[:, 1] + plan[:, 2]) * WS

# re-centre so the constant section is symmetric about z = 0
off = 0.5 * (np.median(top[(s > 7) & (s < 24)]) + np.median(bot[(s > 6.5) & (s < 11)]))
top -= off
bot -= off
print('axis offset', off)

grid = np.round(np.arange(0.0, L + 0.001, 0.02), 4)


def smooth_fit(x, y, sm, xs):
    o = np.argsort(x)
    x, y = x[o], y[o]
    x, idx = np.unique(x, return_index=True)
    y = y[idx]
    sp = UnivariateSpline(x, y, s=sm, k=3)
    return sp(xs)

# ---- top: nose (digitized, smoothed), constant, tail (fin hides it: hand control points)
m = (s > 0.0) & (s < 7.5) & (np.abs(top) < 3)
nose_top = smooth_fit(np.r_[0.0, s[m], 8, 9, 10], np.r_[-0.745, top[m], HALF_H, HALF_H, HALF_H], len(s[m]) * 0.012 ** 2, grid)
tail_top = PchipInterpolator([27.0, 28.5, 31.0, 33.0, 35.0, 36.0, 36.7, 37.2, 37.57],
                             [HALF_H, HALF_H - 0.004, 2.03, 1.95, 1.82, 1.72, 1.62, 1.52, 1.40])(grid)
w_nose = np.clip((grid - 6.5) / 1.0, 0, 1)
T = nose_top * (1 - w_nose) + HALF_H * w_nose
T = np.where(grid > 27.0, tail_top, T)
T = np.minimum(T, HALF_H)

# ---- bottom: nose is well described by an analytic curve
def nose_curve(x, Lc, a, b, z0, H):
    t = np.clip(x / Lc, 0, 1)
    return z0 + (H - z0) * (1 - (1 - t) ** a) ** (1 / b)

B = nose_curve(grid, 3.99386328, 1.68527027, 2.1877702, -0.745, -HALF_H)
mt = (s > 23.5) & (s < 37.6)
tail_bot = smooth_fit(np.r_[s[mt], 37.57], np.r_[bot[mt], 0.95], len(s[mt]) * 0.01 ** 2, grid)
wt = np.clip((grid - 23.0) / 1.5, 0, 1)
B = np.where(grid > 23.0, B * (1 - wt) + tail_bot * wt, B)
B = np.maximum(B, -HALF_H)
B[grid < 23.0] = np.maximum(B[grid < 23.0], -HALF_H)

# ---- half width
mh = (ps > 0.0) & (ps < 7.5) & (hw > 0.05) & (hw < 2.02)
bad = ((ps > 4.5) & (ps < 4.7)) | ((ps > 5.3) & (ps < 5.45)) | ((ps > 6.1) & (ps < 6.75))
mh &= ~bad
nose_hw = smooth_fit(np.r_[0.0, ps[mh], 8.5, 9.5, 10.5], np.r_[0.0, hw[mh], HW, HW, HW], len(ps[mh]) * 0.012 ** 2, grid)
tail_hw = PchipInterpolator([26.5, 27.8, 28.28, 29.18, 30.52, 31.87, 33.5, 35.0, 35.91, 36.36, 36.81, 37.26, 37.57],
                            [HW, HW - 0.01, 1.939, 1.824, 1.604, 1.362, 1.085, 0.83, 0.681, 0.55, 0.43, 0.29, 0.19])(grid)
H = np.where(grid < 8.0, np.minimum(nose_hw, HW), HW)
H = np.where(grid > 26.5, tail_hw, H)
H[0] = 0.0

out = {'s': grid.tolist(), 'top': np.round(T, 5).tolist(), 'bot': np.round(B, 5).tolist(), 'hw': np.round(H, 5).tolist(),
       'source': 'Airbus AC A320 (Jun 2024) fig 2-2-0-991-004, digitized; see fit_profiles.py'}
json.dump(out, open(os.path.join(HERE, 'profiles.json'), 'w'))
for x in (0, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 20, 28, 30, 32, 34, 36, 37, 37.5):
    i = int(round(x / 0.02))
    print(f'{x:6.2f}  top {T[i]:6.3f}  bot {B[i]:6.3f}  hw {H[i]:6.3f}')
