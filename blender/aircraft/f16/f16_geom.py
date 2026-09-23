"""Pure-numpy geometry helpers for the F-16 build (no bpy import: also used by the texture generator).

Working frame ("drawing frame"): s = meters aft of the pitot tip, y = meters to the right (right wing +), z = meters above
the ground with the gear at static load. Blender frame: X = y, Y = CG_S - s (nose +Y), Z = z - CG_Z (origin at the CG).
"""
import math
import numpy as np

CG_S = 8.735   # CG station: 35 % MAC of the digitized wing
CG_Z = 1.90    # CG height above ground (gear static)


def to_blender(s, y, z):
    s = np.asarray(s, float); y = np.asarray(y, float); z = np.asarray(z, float)
    return np.stack([y, CG_S - s, z - CG_Z], axis=-1)


def bl(p):
    """(s,y,z) tuple -> Blender (x,y,z) tuple."""
    return (float(p[1]), float(CG_S - p[0]), float(p[2] - CG_Z))


# ----------------------------------------------------------------------------------------------------------------------
# 1-D monotone cubic interpolation (Fritsch–Carlson PCHIP), vectorized over trailing dims of yk.
def pchip(xk, yk, x):
    xk = np.asarray(xk, float)
    yk = np.asarray(yk, float)
    x = np.atleast_1d(np.asarray(x, float))
    n = len(xk)
    shp = yk.shape[1:]
    Y = yk.reshape(n, -1)
    h = np.diff(xk)
    delta = np.diff(Y, axis=0) / h[:, None]
    d = np.zeros_like(Y)
    if n == 2:
        d[:] = delta[0]
    else:
        w1 = 2 * h[1:] + h[:-1]
        w2 = h[1:] + 2 * h[:-1]
        dm, dp = delta[:-1], delta[1:]
        same = (np.sign(dm) * np.sign(dp)) > 0
        with np.errstate(divide='ignore', invalid='ignore'):
            hm = (w1[:, None] + w2[:, None]) / (w1[:, None] / dm + w2[:, None] / dp)
        d[1:-1] = np.where(same, hm, 0.0)

        def endpoint(h0, h1, del0, del1):
            e = ((2 * h0 + h1) * del0 - h0 * del1) / (h0 + h1)
            e = np.where(np.sign(e) != np.sign(del0), 0.0, e)
            e = np.where((np.sign(del0) != np.sign(del1)) & (np.abs(e) > 3 * np.abs(del0)), 3 * del0, e)
            return e
        d[0] = endpoint(h[0], h[1], delta[0], delta[1])
        d[-1] = endpoint(h[-1], h[-2], delta[-1], delta[-2])
    i = np.clip(np.searchsorted(xk, x) - 1, 0, n - 2)
    t = ((x - xk[i]) / h[i])[:, None]
    hh = h[i][:, None]
    h00 = 2 * t**3 - 3 * t**2 + 1
    h10 = t**3 - 2 * t**2 + t
    h01 = -2 * t**3 + 3 * t**2
    h11 = t**3 - t**2
    out = h00 * Y[i] + h10 * hh * d[i] + h01 * Y[i + 1] + h11 * hh * d[i + 1]
    # clamp outside
    out = np.where((x < xk[0])[:, None], Y[0], out)
    out = np.where((x > xk[-1])[:, None], Y[-1], out)
    return out.reshape((len(x),) + shp)


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------------------------------------------------
# Section curve: Hermite spline through 2-D control points with per-point sharpness (0 smooth … 1 corner).
def section_curve(P, sharp, counts, start_tan=(1.0, 0.0), end_tan=(-1.0, 0.0), tension=None):
    """P: (N,2) control points. sharp: (N,) 0..1. counts: (N-1,) samples per segment.
    start_tan/end_tan: unit tangent directions at the first/last point (None = natural).
    Returns (M,2) samples (M = sum(counts)+1) and the per-sample parameter in [0, N-1]."""
    P = np.asarray(P, float)
    N = len(P)
    seg = np.diff(P, axis=0)
    L = np.maximum(np.linalg.norm(seg, axis=1), 1e-9)
    U = seg / L[:, None]
    din = np.zeros_like(P)   # incoming tangent (unit-ish) at each point
    dout = np.zeros_like(P)
    for i in range(N):
        if i == 0:
            t = np.array(start_tan, float) if start_tan is not None else U[0]
            din[i] = dout[i] = t / max(np.linalg.norm(t), 1e-9)
            continue
        if i == N - 1:
            t = np.array(end_tan, float) if end_tan is not None else U[-1]
            din[i] = dout[i] = t / max(np.linalg.norm(t), 1e-9)
            continue
        a, b = L[i - 1], L[i]
        smooth = U[i] * a / (a + b) + U[i - 1] * b / (a + b)
        nrm = np.linalg.norm(smooth)
        smooth = smooth / nrm if nrm > 1e-9 else U[i]
        sg = float(sharp[i])
        di = lerp(smooth, U[i - 1], sg)
        do = lerp(smooth, U[i], sg)
        din[i] = di / max(np.linalg.norm(di), 1e-9)
        dout[i] = do / max(np.linalg.norm(do), 1e-9)
    out = []
    par = []
    for i in range(N - 1):
        n = int(counts[i])
        t = np.linspace(0, 1, n + 1)[:-1][:, None]
        k = 1.0 if tension is None else tension[i]
        m0 = dout[i] * L[i] * k
        m1 = din[i + 1] * L[i] * k
        h00 = 2 * t**3 - 3 * t**2 + 1
        h10 = t**3 - 2 * t**2 + t
        h01 = -2 * t**3 + 3 * t**2
        h11 = t**3 - t**2
        out.append(h00 * P[i] + h10 * m0 + h01 * P[i + 1] + h11 * m1)
        par.append(i + t[:, 0])
    out.append(P[-1:])
    par.append(np.array([N - 1.0]))
    return np.concatenate(out), np.concatenate(par)


# ----------------------------------------------------------------------------------------------------------------------
# Generic mesh container
class MeshData:
    def __init__(self, verts=None, faces=None, uvs=None, name='mesh'):
        self.verts = np.zeros((0, 3)) if verts is None else np.asarray(verts, float)
        self.faces = [] if faces is None else list(faces)
        # uvs: list (per face) of per-corner (u,v) tuples, or None
        self.uvs = uvs
        self.name = name
        self.sharp_edges = []   # list of (a,b) vertex index pairs
        self.mat_index = None   # optional per-face material index list

    def add(self, other):
        off = len(self.verts)
        self.verts = np.concatenate([self.verts, other.verts]) if len(self.verts) else other.verts.copy()
        self.faces += [tuple(i + off for i in f) for f in other.faces]
        if self.uvs is not None or other.uvs is not None:
            a = self.uvs if self.uvs is not None else [[(0, 0)] * len(f) for f in self.faces[:len(self.faces) - len(other.faces)]]
            b = other.uvs if other.uvs is not None else [[(0, 0)] * len(f) for f in other.faces]
            self.uvs = list(a) + list(b)
        self.sharp_edges += [(a + off, b + off) for a, b in other.sharp_edges]
        if self.mat_index is not None or other.mat_index is not None:
            a = self.mat_index if self.mat_index is not None else [0] * (len(self.faces) - len(other.faces))
            b = other.mat_index if other.mat_index is not None else [0] * len(other.faces)
            self.mat_index = list(a) + list(b)
        return self


def grid_faces(nr, nc, wrap_c=False, wrap_r=False, flip=False):
    """Quad faces for an nr x nc vertex grid (row-major)."""
    faces = []
    rr = nr if wrap_r else nr - 1
    cc = nc if wrap_c else nc - 1
    for r in range(rr):
        r2 = (r + 1) % nr
        for c in range(cc):
            c2 = (c + 1) % nc
            f = (r * nc + c, r * nc + c2, r2 * nc + c2, r2 * nc + c)
            faces.append(f[::-1] if flip else f)
    return faces


def cap_fan(ring_idx, center_idx, flip=False):
    n = len(ring_idx)
    out = []
    for i in range(n):
        f = (ring_idx[i], ring_idx[(i + 1) % n], center_idx)
        out.append(f[::-1] if flip else f)
    return out


# ----------------------------------------------------------------------------------------------------------------------
# Airfoils
def naca64a_thickness(x, t):
    """Approximate NACA 64A-series thickness distribution (half thickness) at chord fraction x for t/c=t.
    Tabulated 64A010 ordinates scaled."""
    xs = np.array([0, .005, .0075, .0125, .025, .05, .075, .10, .15, .20, .25, .30, .35, .40, .45, .50, .55, .60, .65, .70,
                   .75, .80, .85, .90, .95, 1.0])
    ys = np.array([0, .804, .969, 1.225, 1.688, 2.327, 2.805, 3.199, 3.813, 4.272, 4.606, 4.837, 4.968, 4.995, 4.894,
                   4.684, 4.388, 4.021, 3.597, 3.127, 2.623, 2.103, 1.582, 1.062, .541, .02]) / 100.0
    return np.interp(x, xs, ys) * (t / 0.10)


def airfoil(n=48, t=0.04, camber=0.01, te_thick=0.002, cosine=True):
    """Closed airfoil loop (x in [0,1], z) starting at TE upper, around LE, back to TE lower.
    Returns (2n, 2) array; index n-1..n near LE."""
    b = np.linspace(0, np.pi, n)
    x = 0.5 * (1 - np.cos(b)) if cosine else np.linspace(0, 1, n)
    yt = naca64a_thickness(x, t) + te_thick * 0.5 * x
    # a=0.8-ish mean line approximated by a parabola scaled to max camber at ~0.5
    yc = camber * 4 * x * (1 - x)
    upper = np.stack([x, yc + yt], 1)[::-1]   # TE -> LE
    lower = np.stack([x, yc - yt], 1)[1:]     # LE -> TE (skip LE duplicate)
    return np.concatenate([upper, lower])


def rot_matrix(axis, angle):
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    x, y, z = axis
    c, s = math.cos(angle), math.sin(angle)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def face_normal(V, f):
    P = V[list(f)]
    n = np.zeros(3)
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += np.array([(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
    ln = np.linalg.norm(n)
    return n / ln if ln > 0 else n


def orient(md, outward_fn):
    """Flip faces whose normal points against outward_fn(center) (Blender coords)."""
    V = md.verts
    for k, f in enumerate(md.faces):
        c = V[list(f)].mean(0)
        n = face_normal(V, f)
        if np.dot(n, outward_fn(c)) < 0:
            md.faces[k] = tuple(f[::-1])
            if md.uvs is not None:
                md.uvs[k] = list(md.uvs[k])[::-1]
    return md
