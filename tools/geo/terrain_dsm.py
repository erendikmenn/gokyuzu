"""Copernicus GLO-30 is a surface model (TanDEM-X X-band radar, 2011-2015): roofs and tree canopy are part of it. This
removes most of that from the core (8 m) and global (16 m) grids of GEO_REGION=ist before terrain_build.py uses them.

Measured on the İstanbul data (32 m, land only): the DSM does not carry big roof plateaus (edge steps urban -> open
land ~0.7 m median, forest -> open ~1.8 m), but a rough positive layer: the 160 m land-only top-hat is ~0.5 m median,
4.5 m p90 in built-up land and 3.9 / 7.9 m in forest, which would put neighbouring buildings metres apart and make
wooded ridges knobbly. So, on a 32 m grid (the source resolution) over the whole root:
  top-hat  th = h - opening(h)           square 5 x 5 (160 m), sea / lakes excluded from the window (no coastal pull-down)
  rough    r  = local RMS (160 m) of h - gauss(h, 32 m): high where roofs / crowns make the surface grainy, low on smooth
              natural slopes and summits (a smooth hill top keeps its height: correction <= 2.5 r)
  weight   w  = per OSM land-cover class (built-up / forest 1, parks 0.9, unmapped 0.7 (mostly city or woods in the
              core), scrub / orchards 0.6, fields / grass 0.4, sand / rock / wetland 0.25), smoothed 32 m
  corr     = w * min(th, 2.5 r), smoothed (sigma 32 m), <= 40 m; subtracted from both grids (bilinear), so the core
              and the far terrain stay consistent. Built-up and forest land then gets a light 16 m smoothing on the
              8 m grid (the cubic resample of 30 m data plus residual roof grain).
Land within 40 m of the sea is also capped at 1.5 m + 0.5 x distance (quays / waterfront rows as a gentle slope instead
of a roof-height wall at the shoreline; real cliffs steeper than ~27° there are softened), and land within 300 m of the
sea is kept >= 0.8 m (Copernicus / OSM coastline offsets, land fills newer than the DEM such as Yenikapı or Maltepe).
"""
import os, pickle
import numpy as np
import rasterio
from scipy import ndimage
from rasterio import features
from affine import Affine
from terrain_common import RAW, CACHE, FAR, CORE, ROOT_SIZE

WEIGHT = {0: 0.7, 1: 1.0, 2: 1.0, 3: 1.0, 4: 0.4, 5: 0.6, 6: 0.4, 7: 1.0, 8: 0.6, 9: 0.9, 10: 0.8, 11: 0.25,
          12: 0.25, 13: 0.25}
R32 = 32.0
N32 = int(ROOT_SIZE / R32)


def _water_mask(x0, z0, d, shape, sea_only=False):
    w = pickle.load(open(os.path.join(CACHE, 'water.pkl'), 'rb'))
    T = Affine(d, 0, x0 - d / 2, 0, d, z0 - d / 2)   # sample centres at x0 + i*d
    shapes = [(w['sea'], 1)] + ([] if sea_only else [(g, 1) for g in w['lakes']])
    return features.rasterize(shapes, out_shape=shape, transform=T, dtype=np.uint8, fill=0).astype(bool)


def correction32(h16, log=print):
    """Correction field (m, >= 0) on the 32 m grid, sample centres at FAR.x0 + 8 + 32 i (centres of 2x2 blocks of h16)."""
    import terrain_landcover as lc
    h = h16[:-1, :-1].reshape(N32, 2, N32, 2).mean((1, 3)).astype(np.float32)
    x0, z0 = FAR['x0'] + 8.0, FAR['z0'] + 8.0          # centre of the 2x2 block of 16 m samples
    water = _water_mask(x0, z0, R32, h.shape)
    cls = lc.rasterize(x0, z0, R32, h.shape)
    big = 1e4
    E = ndimage.minimum_filter(np.where(water, big, h), 5)
    O = ndimage.maximum_filter(np.where(water, -big, E), 5)
    th = np.where(water, 0.0, np.maximum(h - O, 0.0))
    hp = h - ndimage.gaussian_filter(h, 1.0)
    rough = np.sqrt(np.maximum(ndimage.uniform_filter(np.where(water, 0.0, hp * hp), 5), 0.0))
    lut = np.array([WEIGHT.get(k, 0.5) for k in range(256)], np.float32)
    wgt = ndimage.gaussian_filter(lut[cls], 1.0)
    corr = wgt * np.minimum(th, 2.5 * rough)
    corr = np.clip(ndimage.gaussian_filter(np.where(water, 0.0, corr), 1.0), 0.0, 40.0)
    corr[water] = 0.0
    land = ~water
    log(f'dsm correction (land): median {np.median(corr[land]):.2f} m, p90 {np.percentile(corr[land], 90):.2f}, '
        f'p99 {np.percentile(corr[land], 99):.2f}, max {corr.max():.1f}')
    return corr, cls, x0, z0


def sample(grid, gx0, gz0, gd, xs, zs):
    """Bilinear sample of grid (centres gx0 + i*gd) at the outer product of xs (cols) and zs (rows)."""
    fx = np.clip((xs - gx0) / gd, 0, grid.shape[1] - 1.001)
    fz = np.clip((zs - gz0) / gd, 0, grid.shape[0] - 1.001)
    ix, iz = np.floor(fx).astype(int), np.floor(fz).astype(int)
    tx, tz = (fx - ix).astype(np.float32), (fz - iz).astype(np.float32)
    a = grid[np.ix_(iz, ix)]; b = grid[np.ix_(iz, ix + 1)]; c = grid[np.ix_(iz + 1, ix)]; d = grid[np.ix_(iz + 1, ix + 1)]
    return ((a * (1 - tx) + b * tx) * (1 - tz)[:, None] + (c * (1 - tx) + d * tx) * tz[:, None]).astype(np.float32)


def shore_cap(h, x0, z0, d):
    sea = _water_mask(x0, z0, d, h.shape, sea_only=True)
    dist = ndimage.distance_transform_edt(~sea) * d
    cap = 1.5 + 0.5 * dist
    near = (~sea) & (dist <= 40.0)
    h = np.where(near, np.minimum(h, cap), h)
    # and no land below sea level along the coast (DEM / OSM coastline offsets, fills newer than the DEM)
    return np.where((~sea) & (dist <= 300.0), np.maximum(h, np.minimum(0.8, cap)), h).astype(np.float32)


def load_clean(nx, nz, log=print):
    """-> (core grid (nz, nx) at CORE_RES, far grid (8193, 8193) at 16 m), both cleaned (heights in m MSL)."""
    import terrain_landcover as lc
    from terrain_common import CORE_RES
    core = rasterio.open(os.path.join(RAW, 'copdem', 'core.tif')).read(1).astype(np.float32)
    far = rasterio.open(os.path.join(RAW, 'copdem', 'far16.tif')).read(1).astype(np.float32)
    assert core.shape == (nz, nx), (core.shape, nz, nx)
    corr, cls32, cx0, cz0 = correction32(far, log)
    np.save(os.path.join(CACHE, 'dsm_corr32.npy'), corr)
    fx = FAR['x0'] + np.arange(far.shape[1]) * 16.0
    fz = FAR['z0'] + np.arange(far.shape[0]) * 16.0
    far = far - sample(corr, cx0, cz0, R32, fx, fz)
    xs = CORE['x0'] + np.arange(nx) * CORE_RES
    zs = CORE['z0'] + np.arange(nz) * CORE_RES
    core = core - sample(corr, cx0, cz0, R32, xs, zs)
    # light smoothing of built-up / forest land on the core grid (water excluded from the kernel)
    cls = lc.rasterize(CORE['x0'], CORE['z0'], CORE_RES, core.shape)
    water = _water_mask(CORE['x0'], CORE['z0'], CORE_RES, core.shape)
    lut = np.array([1.0 if k in (1, 2, 3, 7, 10) else 0.7 if k in (0, 9) else 0.0 for k in range(256)], np.float32)
    ws = ndimage.gaussian_filter(lut[cls], 2.0) * ~water
    sig = 16.0 / CORE_RES
    m = (~water).astype(np.float32)
    num = ndimage.gaussian_filter(np.where(water, 0.0, core), sig)
    den = ndimage.gaussian_filter(m, sig)
    smooth = num / np.maximum(den, 1e-3)
    core = np.where(water, core, core + (smooth - core) * ws).astype(np.float32)
    core = shore_cap(core, CORE['x0'], CORE['z0'], CORE_RES)
    far = shore_cap(far, FAR['x0'], FAR['z0'], 16.0)
    return core, far
