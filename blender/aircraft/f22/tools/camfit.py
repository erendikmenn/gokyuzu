"""Fit a pinhole camera to a reference photo from hand-picked landmarks (project venv: numpy + scipy).

  python camfit.py <landmarks.json> [out_cam.json]

landmarks.json: {"image": "ref/xxx.jpg", "size": [W, H],
                 "points": {"name": [[x, s, z], [u, v]], ...},   # model coords (x right, s aft of nose, z up) -> px
                 "guess": {"pos": [x, s, z], "look": [x, s, z], "fpx": 3000}}
Writes {"pos": [...], "quat": [w, x, y, z] (Blender world, camera looks along local -Z), "lens_mm": ..,
        "sensor": 36, "size": [W, H], "rms_px": ..} with Blender world = (x, Y0 - s, z).
"""
import sys, json, math
import numpy as np
from scipy.optimize import least_squares

import os as _os
sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..'))
from geom import Y0  # noqa: E402


def world(p):
    x, s, z = p
    return np.array([x, Y0 - s, z], float)


def rodrigues(r):
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K


def look_rot(pos, tgt):
    f = tgt - pos
    f /= np.linalg.norm(f)
    up = np.array([0, 0, 1.0])
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    # camera axes in world: X = r, Y = u, Z = -f   (world_from_cam columns)
    return np.stack([r, u, -f], 1)


def rot_to_vec(R):
    th = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2)))
    if th < 1e-9:
        return np.zeros(3)
    v = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * math.sin(th))
    return v * th


def project(params, X, W, H):
    C = params[:3]
    R = rodrigues(params[3:6])
    f = params[6]
    pc = (X - C) @ R           # = R^T (X - C) per row
    zc = -pc[:, 2]
    u = W / 2 + f * pc[:, 0] / zc
    v = H / 2 - f * pc[:, 1] / zc
    return np.stack([u, v], 1)


def quat_from_R(R):
    w = math.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    return [w, x, y, z]


def fit(spec):
    W, H = spec['size']
    names = list(spec['points'])
    X = np.array([world(spec['points'][n][0]) for n in names])
    U = np.array([spec['points'][n][1] for n in names], float)
    wts = np.array([spec.get('weights', {}).get(n, 1.0) for n in names])
    g = spec['guess']
    C0 = world(g['pos'])
    T0 = world(g['look'])
    fmax = spec.get('max_lens_mm', 600.0) * W / 36.0

    def res(p):
        return ((project(p, X, W, H) - U) * wts[:, None]).ravel()
    best = None
    dir0 = (C0 - T0) / np.linalg.norm(C0 - T0)
    d0 = np.linalg.norm(C0 - T0)
    f0 = g.get('fpx', 3000.0)
    for dscale in (0.5, 1.0, 2.0, 4.0, 8.0):
        for jitter in range(4):
            C = T0 + dir0 * d0 * dscale
            rng = np.random.RandomState(jitter)
            if jitter:
                C = C + rng.randn(3) * 0.05 * d0 * dscale
            R0 = look_rot(C, T0 + (rng.randn(3) * 0.5 if jitter else 0))
            f = min(f0 * dscale, fmax * 0.98)
            pj = np.concatenate([C, rot_to_vec(R0), [f]])
            lo = np.full(7, -np.inf)
            hi = np.full(7, np.inf)
            lo[6], hi[6] = 200.0, fmax
            try:
                r = least_squares(res, pj, loss='soft_l1', f_scale=8.0, max_nfev=4000, bounds=(lo, hi), x_scale='jac')
            except Exception:
                continue
            if best is None or r.cost < best.cost:
                best = r
    p = best.x
    P = project(p, X, W, H)
    err = np.linalg.norm(P - U, axis=1)
    R = rodrigues(p[3:6])
    out = {'pos': p[:3].tolist(), 'quat': quat_from_R(R), 'lens_mm': float(p[6] * 36.0 / W), 'sensor': 36.0,
           'size': [W, H], 'rms_px': float(np.sqrt(np.mean(err ** 2))), 'image': spec['image'],
           'residuals': {n: round(float(e), 1) for n, e in zip(names, err)}}
    return out


if __name__ == '__main__':
    spec = json.load(open(sys.argv[1]))
    out = fit(spec)
    print(json.dumps({k: v for k, v in out.items() if k != 'quat'}, indent=1))
    if len(sys.argv) > 2:
        json.dump(out, open(sys.argv[2], 'w'), indent=1)
