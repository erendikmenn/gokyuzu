"""F-22 skin compositor (project venv): baked world position / normal / class / AO  +  PIL projection views
->  f22_basecolor.jpg (4096), f22_metalrough.jpg (2048, G = roughness, B = metallic), f22_normal.jpg (2048).

usage: python composite.py <cache_dir> <src_dir> <tex_dir>
Arrays from Blender have row 0 = v = 0 (bottom); images are flipped when saved.
"""
import os
import sys
import json
import math
import time
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
Image.MAX_IMAGE_PIXELS = None

Y0 = 10.10
POS_OFF = np.array([10.0, 10.0, 3.0])
POS_SCALE = np.array([20.0, 20.0, 6.0])


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


# ------------------------------------------------------------------------------------------------ noise
_rng = np.random.RandomState(7)
_PERM = _rng.permutation(256).astype(np.int32)
_PERM = np.concatenate([_PERM, _PERM])
_VAL = _rng.rand(256).astype(np.float32)


def vnoise(p):
    """3-D value noise, p (M, 3) -> (M,) in [0, 1]."""
    pi = np.floor(p).astype(np.int32)
    pf = (p - pi).astype(np.float32)
    w = pf * pf * (3 - 2 * pf)
    xi, yi, zi = pi[:, 0] & 255, pi[:, 1] & 255, pi[:, 2] & 255
    out = np.zeros(len(p), np.float32)
    for dx in (0, 1):
        wx = w[:, 0] if dx else 1 - w[:, 0]
        for dy in (0, 1):
            wy = w[:, 1] if dy else 1 - w[:, 1]
            for dz in (0, 1):
                wz = w[:, 2] if dz else 1 - w[:, 2]
                h = _PERM[_PERM[_PERM[(xi + dx) & 255] + ((yi + dy) & 255)] + ((zi + dz) & 255)]
                out += wx * wy * wz * _VAL[h]
    return out


def fbm(p, octaves=4, lac=2.03, gain=0.5):
    amp, tot, norm = 1.0, np.zeros(len(p), np.float32), 0.0
    q = p.copy()
    for _ in range(octaves):
        tot += amp * vnoise(q)
        norm += amp
        amp *= gain
        q = q * lac + 17.3
    return tot / norm


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------ view sampling
class ViewImg:
    def __init__(self, src, name, meta):
        self.name = name
        m = meta[name]
        self.a0, self.a1 = m['a']
        self.b0, self.b1 = m['b']
        self.ppm = m['ppm']
        ld = lambda k: np.asarray(Image.open(os.path.join(src, f'{name}_{k}.png')))
        self.line = ld('line').astype(np.float32) / 255
        self.tape = ld('tape').astype(np.float32) / 255
        self.tone = ld('tone').astype(np.float32)
        self.mark = ld('mark').astype(np.float32) / 255
        # soften (anti-alias)
        self.line = ndimage.gaussian_filter(self.line, 0.7)
        self.tape = ndimage.gaussian_filter(self.tape, 1.0)

    def coords(self, a, b):
        n = self.name
        if n in ('top', 'bot'):
            X = (a - self.a0) * self.ppm
            Yp = (b - self.b0) * self.ppm
        elif n in ('side_R', 'fin_R'):
            X = (self.a1 - a) * self.ppm
            Yp = (self.b1 - b) * self.ppm
        else:
            X = (a - self.a0) * self.ppm
            Yp = (self.b1 - b) * self.ppm
        return X, Yp

    def sample(self, arr, X, Yp, nearest=False):
        H, W = arr.shape[:2]
        if nearest:
            xi = np.clip(np.round(X).astype(np.int32), 0, W - 1)
            yi = np.clip(np.round(Yp).astype(np.int32), 0, H - 1)
            return arr[yi, xi]
        x0 = np.clip(np.floor(X).astype(np.int32), 0, W - 2)
        y0 = np.clip(np.floor(Yp).astype(np.int32), 0, H - 2)
        fx = np.clip(X - x0, 0, 1).astype(np.float32)
        fy = np.clip(Yp - y0, 0, 1).astype(np.float32)
        if arr.ndim == 3:
            fx, fy = fx[:, None], fy[:, None]
        a = arr[y0, x0] * (1 - fx) + arr[y0, x0 + 1] * fx
        b = arr[y0 + 1, x0] * (1 - fx) + arr[y0 + 1, x0 + 1] * fx
        return a * (1 - fy) + b * fy


def main(cache, src, out):
    t0 = time.time()
    import shape as S
    import details as D
    pos = np.load(os.path.join(cache, 'pos.npy')).astype(np.float32)
    nrm = np.load(os.path.join(cache, 'nrm.npy')).astype(np.float32)
    H, W = pos.shape[:2]
    cls = np.load(os.path.join(cache, 'cls.npy')).astype(np.float32)
    cls = np.repeat(np.repeat(cls, H // cls.shape[0], axis=0), W // cls.shape[1], axis=1)
    ao = np.load(os.path.join(cache, 'ao.npy')).astype(np.float32)[..., 0]
    ao = ndimage.gaussian_filter(ao, 1.2)
    ao = ndimage.zoom(ao, H / ao.shape[0], order=1)
    mask = pos[..., 3] > 0.5
    print('coverage', mask.mean())
    iy, ix = np.nonzero(mask)
    P = pos[iy, ix, :3] * POS_SCALE - POS_OFF
    N = nrm[iy, ix, :3] * 2 - 1
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-6
    C = cls[iy, ix, 0]
    A = ao[iy, ix]
    del pos, nrm
    M = len(P)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    s = Y0 - y
    ax = np.abs(x)
    nx, ny, nz = N[:, 0], N[:, 1], N[:, 2]
    print(f'{M} texels, load {time.time() - t0:.1f}s')

    meta = json.load(open(os.path.join(src, 'views.json')))
    views = {n: ViewImg(src, n, meta) for n in meta}

    # ---------------- projection selection
    fin_h = (ax - D.FIN_X0) * math.sin(D.FIN_CANT) + (z - D.FIN_Z0) * math.cos(D.FIN_CANT)
    is_fin = (ax > 1.2) & (z > D.FIN_Z0 + 0.02) & (s > 12.6) & (s < 17.6) & (np.abs(nx) > 0.5)
    sel = np.full(M, -1, np.int8)
    order = ['top', 'bot', 'side_R', 'side_L', 'fin_R', 'fin_L']
    sel[(nz > 0.42)] = 0
    sel[(nz < -0.42)] = 1
    rest = sel < 0
    sel[rest & (x >= 0)] = 2
    sel[rest & (x < 0)] = 3
    sel[is_fin & (x >= 0)] = 4
    sel[is_fin & (x < 0)] = 5
    line = np.zeros(M, np.float32)
    tape = np.zeros(M, np.float32)
    tone = np.full(M, 128, np.float32)
    mark = np.zeros((M, 4), np.float32)
    for k, name in enumerate(order):
        idx = np.nonzero(sel == k)[0]
        if len(idx) == 0:
            continue
        V = views[name]
        if name in ('top', 'bot'):
            X, Yp = V.coords(x[idx], s[idx])
        elif name.startswith('side'):
            X, Yp = V.coords(s[idx], z[idx])
        else:
            X, Yp = V.coords(s[idx], fin_h[idx])
        line[idx] = V.sample(V.line, X, Yp)
        tape[idx] = V.sample(V.tape, X, Yp)
        tone[idx] = V.sample(V.tone, X, Yp, nearest=True)
        mk = V.sample(V.mark, X, Yp)
        if name.startswith('fin'):
            # side of the fin mid-plane from the position (robust), consistent with the normal
            sg = np.sign(x[idx])
            off = (ax[idx] - D.FIN_X0) * math.cos(D.FIN_CANT) - (z[idx] - D.FIN_Z0) * math.sin(D.FIN_CANT)
            outboard = (off > 0.002) & (np.sign(nx[idx]) == sg)
            mk[~outboard] = 0
        if name.startswith('side'):
            facing = (np.sign(nx[idx]) == np.sign(x[idx])) | (np.abs(nx[idx]) < 0.2)
            mk[~facing] = 0
        mark[idx] = mk
    print(f'views sampled {time.time() - t0:.1f}s')

    # ---------------- geometric features: leading-edge treatments, radome, control-surface gaps
    le = np.zeros(M, np.float32)
    on_wing = (ax > S.X_ROOT) & (ax < S.X_TIP + 0.01) & (np.abs(z - S.w_zc(np.clip(ax, S.X_ROOT, S.X_TIP)) * 1) < 0.35)
    wle = S.W_S_LE0 + S.TAN_LE * ax
    le = np.where(on_wing & (s - wle < 0.07) & (s - wle > -0.02), 1.0, le)
    stab_le = 15.26 + S.TAN_LE * (ax - 1.75)
    on_stab = (ax > 1.98) & (ax < 4.43) & (np.abs(z - 0.02) < 0.12) & (s > 15.0)
    le = np.where(on_stab & (s - stab_le < 0.05) & (s - stab_le > -0.02), 1.0, le)
    fin_le = D.FIN_S_LE0 + D.FIN_TAN_LE * np.maximum(fin_h, 0)
    le = np.where(is_fin & (s - fin_le < 0.06) & (s - fin_le > -0.02), 1.0, le)
    radome = (s < 2.25 + 0.09 * np.abs(np.sin(ax * 20 + z * 20)))
    # RAM edge treatments: forebody chines, inlet lips, canopy sill outline
    sc = np.clip(s, 0.0, S.S_TI)
    xch = np.interp(sc, np.linspace(0, S.S_TI, 200), [S.x_ch_fore(t) for t in np.linspace(0, S.S_TI, 200)])
    zch = np.interp(sc, np.linspace(0, S.S_TI, 200), [S.z_ch(t) for t in np.linspace(0, S.S_TI, 200)])
    chine_d = np.hypot(ax - xch, z - zch)
    le = np.where((s < S.S_TI) & (s > 0.3) & (chine_d < 0.03), 1.0, le)

    def seg_dist(p, a, b):
        a, b = np.asarray(a, np.float32), np.asarray(b, np.float32)
        ab = b - a
        t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
        return np.linalg.norm(p - (a[None, :] + t[:, None] * ab[None, :]), axis=1)
    PL = np.stack([ax, s, z], 1).astype(np.float32)
    near_lip = (s > 5.3) & (s < 7.3) & (ax > 0.6) & (ax < 2.2) & (z < 0.1)
    idx = np.nonzero(near_lip)[0]
    if len(idx):
        TI, TO = (S.x_ch_fore(S.S_TI), S.S_TI, -0.02), (2.03, S.S_TO, -0.02)
        zbo = S.z_belly(S.S_BO) + 0.06
        BO = (2.03 - (0.0 - zbo) * math.tan(S.CANT_NAC), S.S_BO, zbo)
        BI = (S.x_bi(S.S_BI), S.S_BI, S.z_belly(S.S_BI))
        d = np.minimum.reduce([seg_dist(PL[idx], TI, TO), seg_dist(PL[idx], TO, BO), seg_dist(PL[idx], BO, BI),
                               seg_dist(PL[idx], BI, TI)])
        le[idx] = np.maximum(le[idx], (d < 0.045).astype(np.float32))
    sill = np.zeros(M, np.float32)
    inc = (s > S.S_CAN0 + 0.05) & (s < S.S_CAN1 - 0.05)
    idx = np.nonzero(inc)[0]
    if len(idx):
        cx = np.interp(s[idx], np.linspace(S.S_CAN0, S.S_CAN1, 200), [S.can_x(t) for t in np.linspace(S.S_CAN0, S.S_CAN1, 200)])
        cz = np.interp(s[idx], np.linspace(S.S_CAN0, S.S_CAN1, 200), [S.can_zs(t) for t in np.linspace(S.S_CAN0, S.S_CAN1, 200)])
        dd = np.hypot(ax[idx] - cx, z[idx] - cz)
        sill[idx] = ((dd > 0.012) & (dd < 0.055)).astype(np.float32)

    # ---------------- colours (linear)
    c_a = srgb_to_lin(np.array([101, 105, 110]) / 255.0)      # FS 36176 (lighter)
    c_b = srgb_to_lin(np.array([88, 92, 98]) / 255.0)         # FS 36170 (darker)
    camo = fbm(P * np.array([0.28, 0.22, 0.28]) + 3.1, 3)
    camo = smoothstep(0.47, 0.53, camo)
    base = c_a[None, :] * (1 - camo[:, None]) + c_b[None, :] * camo[:, None]
    # panel tones (+-4 %), sheen panels
    tnorm = (tone - 128) / 127.0
    in_panel = np.abs(tone - 128) > 0.5
    base *= (1 + 0.035 * tnorm * in_panel)[:, None]
    sheen = in_panel & ((tone > 196) | (tone < 52))
    sheen_col = srgb_to_lin(np.array([116, 120, 126]) / 255.0)
    base = np.where(sheen[:, None], base * 0.35 + sheen_col[None, :] * 0.65, base)
    # radome slightly different tone
    base = np.where(radome[:, None], base * 1.05, base)
    # leading edges darker (RAM LE treatment)
    le_col = srgb_to_lin(np.array([70, 74, 80]) / 255.0)
    base = base * (1 - 0.75 * le[:, None]) + le_col[None, :] * 0.75 * le[:, None]
    # canopy sill seal (light gray RAM tape band)
    sill_col = srgb_to_lin(np.array([122, 126, 130]) / 255.0)
    base = base * (1 - 0.6 * sill[:, None]) + sill_col[None, :] * 0.6 * sill[:, None]
    # seam tape (lighter) + grooves (darker)
    tape_col = srgb_to_lin(np.array([126, 130, 134]) / 255.0)
    tt = np.clip(tape, 0, 1) * 0.55
    base = base * (1 - tt[:, None]) + tape_col[None, :] * tt[:, None]
    base *= (1 - 0.42 * np.clip(line, 0, 1))[:, None]
    # weathering: large blotches, fine grain, aft streaks, lower-surface grime
    grime = fbm(P * 1.3 + 11.0, 4)
    base *= (0.965 + 0.07 * grime)[:, None]
    fine = vnoise(P * 22.0)
    base *= (0.985 + 0.03 * fine)[:, None]
    streak = fbm(np.stack([x * 5.0, s * 0.45, z * 5.0], 1) + 5.0, 3)
    base *= (1 - 0.035 * smoothstep(0.55, 0.8, streak) * (1 - 0.6 * is_fin))[:, None]
    lower = smoothstep(-0.2, -0.9, nz)
    base *= (1 - 0.05 * lower * fbm(P * 2.5, 3))[:, None]
    # exhaust / heat staining on the aft deck, booms, stabilator roots
    heat = smoothstep(16.0, 17.4, s) * (ax < 1.6) * (z > -0.1)
    heat_col = srgb_to_lin(np.array([92, 86, 80]) / 255.0)
    hmix = (0.45 * heat * (0.7 + 0.3 * fbm(P * 3.0, 3)))[:, None]
    base = base * (1 - hmix) + heat_col[None, :] * hmix
    # markings
    mcol = srgb_to_lin(mark[:, :3])
    ma = mark[:, 3:4]
    base = base * (1 - ma) + mcol * ma
    # classes
    skin = C < 0.2
    dark = (C >= 0.2) & (C < 0.4)
    hot = (C >= 0.4) & (C < 0.6)
    bay = C >= 0.6
    hot_col = srgb_to_lin(np.array([158, 148, 134]) / 255.0) * (0.8 + 0.4 * fbm(P * 4.0, 3))[:, None]
    tint = smoothstep(16.3, 17.8, s)[:, None]
    hot_col = hot_col * (1 - 0.35 * tint) + srgb_to_lin(np.array([96, 84, 104]) / 255.0)[None, :] * 0.35 * tint
    # ceramic-matrix tiles on the nozzle flaps / tunnel (10 x 12 cm grid)
    tu = np.abs(((x * 10.0) % 1.0) - 0.5)
    tv = np.abs(((s * 8.3) % 1.0) - 0.5)
    tiles = np.clip((np.maximum(tu, tv) - 0.44) / 0.06, 0, 1)
    hot_col = hot_col * (1 - 0.45 * tiles)[:, None]
    base = np.where(hot[:, None], hot_col, base)
    base = np.where(dark[:, None], srgb_to_lin(np.array([14, 14, 15]) / 255.0)[None, :], base)
    bay_col = srgb_to_lin(np.array([176, 178, 172]) / 255.0) * (0.93 + 0.1 * fbm(P * 3.0, 2))[:, None]
    base = np.where(bay[:, None], bay_col, base)
    # ambient occlusion
    aoe = np.clip(A, 0, 1)
    occl = np.where(bay | dark, 0.25 + 0.75 * aoe, 0.45 + 0.55 * aoe)
    occl = np.where(hot, 0.62 + 0.38 * aoe, occl)
    base *= occl[:, None]

    # ---------------- roughness / metallic
    rough = 0.66 + 0.07 * (grime - 0.5) + 0.03 * (fine - 0.5)
    metal = np.full(M, 0.04, np.float32)
    rough = np.where(sheen, 0.47 + 0.05 * grime, rough)
    metal = np.where(sheen, 0.32, metal)
    rough = rough + 0.08 * tt
    metal = metal * (1 - tt)
    rough = np.where(le > 0.5, 0.62, rough)
    rough = rough * (1 - ma[:, 0]) + 0.5 * ma[:, 0]
    rough = np.where(hot, 0.5 + 0.12 * fbm(P * 5.0, 2), rough)
    metal = np.where(hot, 0.3, metal)
    rough = np.where(bay, 0.62, rough)
    metal = np.where(bay, 0.0, metal)
    rough = np.where(dark, 0.8, rough)
    metal = np.where(dark, 0.0, metal)
    print(f'shading {time.time() - t0:.1f}s')

    # ---------------- write base colour (4096)
    img = np.zeros((H, W, 3), np.float32)
    img[iy, ix] = lin_to_srgb(base)
    # dilate into the empty area (so mip levels don't bleed black)
    img = dilate_fill(img, mask)
    Image.fromarray((np.flipud(img) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out, 'f22_basecolor.jpg'),
                                                                          quality=92, subsampling=0)
    del img
    # ---------------- metallic/roughness (2048): R = 1 (unused / occlusion), G = rough, B = metal
    mr = np.zeros((H, W, 3), np.float32)
    mr[..., 0] = 1.0
    mr[iy, ix, 1] = np.clip(rough, 0.04, 1)
    mr[iy, ix, 2] = np.clip(metal, 0, 1)
    mr = dilate_fill(mr, mask)
    mr2 = mr.reshape(H // 2, 2, W // 2, 2, 3).mean(axis=(1, 3))
    Image.fromarray((np.flipud(mr2) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out, 'f22_metalrough.jpg'),
                                                                         quality=92, subsampling=0)
    del mr, mr2
    # ---------------- normal map from panel grooves / seam tape (2048)
    hgt = np.zeros((H, W), np.float32)
    hgt[iy, ix] = -np.clip(line, 0, 1) * 1.0 - np.clip(tape, 0, 1) * 0.08 + 0.02 * (fine - 0.5)
    hgt = dilate_fill(hgt[..., None], mask)[..., 0]
    hgt = ndimage.gaussian_filter(hgt, 1.2)
    h2 = hgt.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
    gy, gx = np.gradient(h2)            # gy: along rows (v up in Blender orientation), gx: along u
    k = 2.2
    nmap = np.stack([-gx * k, -gy * k, np.ones_like(h2)], -1)
    nmap /= np.linalg.norm(nmap, axis=-1, keepdims=True)
    nimg = nmap * 0.5 + 0.5
    Image.fromarray((np.flipud(nimg) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out, 'f22_normal.jpg'),
                                                                          quality=95, subsampling=0)
    print(f'written in {time.time() - t0:.1f}s')


def dilate_fill(img, mask, iters=6):
    """Fill empty texels with the nearest covered texel (via distance transform indices)."""
    idx = ndimage.distance_transform_edt(~mask, return_distances=False, return_indices=True)
    return img[idx[0], idx[1]]


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
