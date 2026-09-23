"""Generate the tileable water wave slope texture (assets/sf/terrain/waves.png) from a random-phase directional
wave spectrum (Phillips-like, inverse FFT). R,G = slopes dh/dx, dh/dz (128 = 0), B = normalized height.
Usage: .venv/bin/python tools/geo/terrain_waves.py
"""
import os
import numpy as np
from PIL import Image
from terrain_common import OUT

N = 512
rng = np.random.default_rng(1234)
k = np.fft.fftfreq(N) * N                      # integer wave numbers
kx, kz = np.meshgrid(k, k)
kk = np.hypot(kx, kz)
kk[0, 0] = 1
wind = np.array([np.cos(-0.35), np.sin(-0.35)])
cosang = (kx * wind[0] + kz * wind[1]) / kk
# Phillips-like: peak at |k| ~ 10 (texture scale / 10), directional spreading, cut tiny and huge wavenumbers
kp = 9.0
P = np.exp(-1.0 / (kk / kp) ** 2) / kk ** 4 * (0.25 + np.abs(cosang) ** 2.5 * (cosang > -0.2))
P *= np.exp(-(kk / 150.0) ** 2)
P[kk < 3] = 0
P[0, 0] = 0
amp = np.sqrt(P) * (rng.normal(size=(N, N)) + 1j * rng.normal(size=(N, N)))
h = np.fft.ifft2(amp).real
sx = np.fft.ifft2(amp * 1j * kx).real
sz = np.fft.ifft2(amp * 1j * kz).real
# sharpen crests a little (choppy look): mix in slopes of h^2-ish term
m = max(np.abs(sx).max(), np.abs(sz).max())
sx, sz = sx / m, sz / m
hn = (h - h.min()) / (h.max() - h.min())
img = np.stack([np.clip(128 + 127 * sx, 0, 255), np.clip(128 + 127 * sz, 0, 255), hn * 255], -1).astype(np.uint8)
os.makedirs(OUT, exist_ok=True)
Image.fromarray(img).save(os.path.join(OUT, 'waves.png'))
print('saved waves.png', img.shape, 'slope rms', np.sqrt((sx ** 2 + sz ** 2).mean()))

# ---------------- ground detail texture (tileable): R = fine grain, G = mid-scale variation, B = coarse patches
def band_noise(n, k0, k1, seed):
    r = np.random.default_rng(seed)
    kk2 = np.hypot(*np.meshgrid(np.fft.fftfreq(n) * n, np.fft.fftfreq(n) * n))
    spec = (r.normal(size=(n, n)) + 1j * r.normal(size=(n, n))) * ((kk2 >= k0) & (kk2 <= k1)) / np.maximum(kk2, 1) ** 0.5
    v = np.fft.ifft2(spec).real
    v = (v - v.mean()) / (v.std() + 1e-9)
    return np.clip(0.5 + 0.17 * v, 0, 1)

D = 512
det = np.stack([band_noise(D, 60, 250, 11), band_noise(D, 12, 60, 12), band_noise(D, 2, 12, 13)], -1)
Image.fromarray((det * 255).astype(np.uint8)).save(os.path.join(OUT, 'detail.png'))
print('saved detail.png')
