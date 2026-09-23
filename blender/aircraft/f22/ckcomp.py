"""Cockpit texture compositor (project venv): cached art colour + interior light bakes -> cockpit JPEG.
  python ckcomp.py <cache_dir> <out.jpg> [size]"""
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage


def main(cache, out_path, size):
    col = np.load(os.path.join(cache, 'ck_col.npy')).astype(np.float32)
    lt = np.load(os.path.join(cache, 'ck_light.npy')).astype(np.float32)
    a = col[..., 3] > 0.5
    c = col[..., :3]
    L = lt[..., :3].mean(-1)
    la = lt[..., 3] > 0.5
    if L.shape[0] != size:
        L = ndimage.zoom(L, size / L.shape[0], order=1)
        la = ndimage.zoom(la.astype(np.float32), size / la.shape[0], order=0) > 0.5
    # fill uncovered light texels from neighbours before blurring
    idx = ndimage.distance_transform_edt(~la, return_distances=False, return_indices=True)
    L = L[idx[0], idx[1]]
    L = ndimage.gaussian_filter(L, 1.5)
    covered = L[a]
    ref = np.percentile(covered, 92) if covered.size else 1.0
    Ln = np.clip(L / max(ref, 1e-4), 0, 1.25)
    shade = 0.30 + 0.78 * Ln ** 0.8
    img = c * shade[..., None]
    idx = ndimage.distance_transform_edt(~a, return_distances=False, return_indices=True)
    img = img[idx[0], idx[1]]
    srgb = np.where(img <= 0.0031308, img * 12.92, 1.055 * np.power(np.clip(img, 0, None), 1 / 2.4) - 0.055)
    Image.fromarray((np.flipud(np.clip(srgb, 0, 1)) * 255 + 0.5).astype(np.uint8)).save(out_path, quality=90,
                                                                                         subsampling=0)
    print('cockpit texture written', out_path, 'coverage', a.mean(), 'light ref', ref)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 4096)
