"""Reusable bridge-building helpers for the W3 landmarks (paths, decks, trusses, cables, piers).

A DeckPath is a polyline of (x, y, z) road-centerline points in a landmark frame (Blender coordinates, meters).
Everything is expressed with offsets `x` (to the right of the direction of travel) and `dz` (above the road).
"""
import math

import numpy as np

from lmkit import V, norm


def pchip(xs, ys):
    """Monotone piecewise-cubic Hermite interpolation -> callable."""
    xs = np.asarray(xs, float)
    ys = np.asarray(ys, float)
    h = np.diff(xs)
    d = np.diff(ys) / h
    m = np.zeros_like(ys)
    for i in range(1, len(ys) - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    m[0], m[-1] = d[0], d[-1]

    def f(x):
        x = float(x)
        if x <= xs[0]:
            return float(ys[0] + m[0] * (x - xs[0]))
        if x >= xs[-1]:
            return float(ys[-1] + m[-1] * (x - xs[-1]))
        i = int(np.searchsorted(xs, x) - 1)
        t = (x - xs[i]) / h[i]
        h00, h10, h01, h11 = 2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2
        return float(h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1])
    return f


def resample(P, step):
    """Resample a 2D/3D polyline at (almost) uniform arclength."""
    P = np.asarray(P, float)
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    n = max(2, int(round(d[-1] / step)) + 1)
    s = np.linspace(0, d[-1], n)
    return np.stack([np.interp(s, d, P[:, k]) for k in range(P.shape[1])], axis=1), s


def smooth(P, k=2, it=3):
    P = np.asarray(P, float).copy()
    for _ in range(it):
        Q = P.copy()
        for i in range(1, len(P) - 1):
            a, b = max(0, i - k), min(len(P), i + k + 1)
            Q[i] = P[a:b].mean(axis=0)
        P = Q
    return P


class DeckPath:
    """Road centerline with frames. pts: Nx3 (x, y, z_road)."""

    def __init__(self, pts):
        self.p = np.asarray(pts, float)
        n = len(self.p)
        self.s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(self.p[:, :2], axis=0), axis=1))]
        self.t = np.zeros((n, 2))
        for i in range(n):
            a, b = self.p[max(0, i - 1), :2], self.p[min(n - 1, i + 1), :2]
            self.t[i] = norm(b - a)
        self.nrm = np.stack([self.t[:, 1], -self.t[:, 0]], axis=1)      # right-hand normal (x = right)

    def __len__(self):
        return len(self.p)

    @property
    def length(self):
        return float(self.s[-1])

    def pt(self, i, x=0.0, dz=0.0):
        c = self.p[i]
        n = self.nrm[i]
        return V(c[0] + n[0] * x, c[1] + n[1] * x, c[2] + dz)

    def at(self, s, x=0.0, dz=0.0):
        """Point at arclength s (linear interpolation)."""
        s = min(max(s, 0.0), self.length)
        i = int(min(len(self.s) - 2, max(0, np.searchsorted(self.s, s) - 1)))
        t = (s - self.s[i]) / max(1e-9, self.s[i + 1] - self.s[i])
        a, b = self.pt(i, x, dz), self.pt(i + 1, x, dz)
        return a + (b - a) * t

    def tangent_at(self, s):
        return norm(self.at(s + 1.0)[:2] - self.at(s - 1.0)[:2])

    def z_at(self, s):
        return float(np.interp(s, self.s, self.p[:, 2]))

    def strip(self, mb, x0, x1, dz0, dz1=None, uv=None, ts=4.0, col=None, i0=0, i1=None, flip=False):
        """Surface between offsets (x0,dz0) and (x1,dz1) along the path. uv: 'road' -> u across 0..1, v = s/ts."""
        dz1 = dz0 if dz1 is None else dz1
        i1 = len(self.p) - 1 if i1 is None else i1
        for i in range(i0, i1):
            a0, a1 = self.pt(i, x0, dz0), self.pt(i, x1, dz1)
            b0, b1 = self.pt(i + 1, x0, dz0), self.pt(i + 1, x1, dz1)
            if uv == 'road':
                va, vb = self.s[i] / ts, self.s[i + 1] / ts
                q = [(0, va), (1, va), (1, vb), (0, vb)]
            elif uv == 'along':   # u along the path, v across the strip (for railings)
                ua, ub = self.s[i] / ts, self.s[i + 1] / ts
                q = [(ua, 0), (ua, 1), (ub, 1), (ub, 0)]
            else:
                q = None
            if flip:
                mb.quad(a1, a0, b0, b1, ts, uv=None if q is None else [q[1], q[0], q[3], q[2]], col=col)
            else:
                mb.quad(a0, a1, b1, b0, ts, uv=q, col=col)

    def rail(self, mb, x, dz0, dz1, ts=1.524, col=None, i0=0, i1=None):
        """Vertical railing strip (alpha texture), u along path (ts per tile), v 0..1 bottom->top."""
        i1 = len(self.p) - 1 if i1 is None else i1
        for i in range(i0, i1):
            a0, a1 = self.pt(i, x, dz0), self.pt(i, x, dz1)
            b0, b1 = self.pt(i + 1, x, dz0), self.pt(i + 1, x, dz1)
            ua, ub = self.s[i] / ts, self.s[i + 1] / ts
            mb.quad(a0, b0, b1, a1, uv=[(ua, 0), (ub, 0), (ub, 1), (ua, 1)], col=col)

    def index_at(self, s):
        return int(np.clip(np.searchsorted(self.s, s), 0, len(self.s) - 1))


def box_girder(mb, path, top_half, bot_half, depth, col=None, i0=0, i1=None, depth_fn=None, dz_top=-0.25):
    """Trapezoidal box girder under a deck: top flange edges at +-top_half, bottom at +-bot_half, depth (m)."""
    i1 = len(path) - 1 if i1 is None else i1
    for i in range(i0, i1):
        da = depth_fn(path.s[i]) if depth_fn else depth
        db = depth_fn(path.s[i + 1]) if depth_fn else depth
        P = lambda k, x, dz: path.pt(k, x, dz)
        # outer webs (sloped, facing outwards/down), bottom flange (facing down)
        mb.quad(P(i + 1, top_half, dz_top), P(i, top_half, dz_top), P(i, bot_half, dz_top - da), P(i + 1, bot_half, dz_top - db), 4.0, col=col)
        mb.quad(P(i, -top_half, dz_top), P(i + 1, -top_half, dz_top), P(i + 1, -bot_half, dz_top - db), P(i, -bot_half, dz_top - da), 4.0, col=col)
        mb.quad(P(i, -bot_half, dz_top - da), P(i + 1, -bot_half, dz_top - db), P(i + 1, bot_half, dz_top - db), P(i, bot_half, dz_top - da), 4.0, col=col)


def warren_truss(mb, top, bot, chord_w=0.9, chord_h=0.9, web_w=0.6, web_t=0.7, verticals=True, col=None, col_bot=None,
                 plane_normal=(1, 0, 0)):
    """Warren truss with verticals between two node lists (same length) of 3D points."""
    n = len(top)
    for k in range(n - 1):
        mb.beam(top[k], top[k + 1], chord_w, chord_h, ts=4.0, col=col)
        mb.beam(bot[k], bot[k + 1], chord_w, chord_h, ts=4.0, col=col_bot or col)
        if k % 2 == 0:
            mb.beam(bot[k], top[k + 1], web_w, web_t, up=plane_normal, ts=4.0, col=col)
        else:
            mb.beam(top[k], bot[k + 1], web_w, web_t, up=plane_normal, ts=4.0, col=col)
    if verticals:
        for k in range(n):
            d = top[k] - bot[k]
            L = np.linalg.norm(d)
            if L > chord_h * 1.2:
                u = d / L
                mb.beam(bot[k] + u * chord_h / 2, top[k] - u * chord_h / 2, web_w, web_t, up=plane_normal, ts=4.0, col=col, caps=False)


def parabola_cable(p0, p1, sag, n):
    """Points of a parabolic cable between p0 and p1 with midpoint sag below the chord."""
    p0, p1 = V(p0), V(p1)
    out = []
    for i in range(n + 1):
        t = i / n
        p = p0 + (p1 - p0) * t
        p[2] -= 4 * sag * t * (1 - t)
        out.append(p)
    return out


def column(mb, c, w, d, z0, z1, taper=0.0, col=None, ts=6.0, chamfer=0.0, yaw=0.0, w_top=None, d_top=None, c_top=None, top=True):
    """Vertical rectangular column (w along local x, d along local y), optional taper (fraction at top) and yaw.
    c_top: optional different top center (inclined column)."""
    c = V(c)
    ct = c if c_top is None else V(c_top)
    cy, sy = math.cos(yaw), math.sin(yaw)
    ax, ay = V(cy, sy, 0), V(-sy, cy, 0)
    wt = w * (1 - taper) if w_top is None else w_top
    dt = d * (1 - taper) if d_top is None else d_top
    if chamfer <= 0:
        corners_b = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
        corners_t = [(-wt / 2, -dt / 2), (wt / 2, -dt / 2), (wt / 2, dt / 2), (-wt / 2, dt / 2)]
    else:
        def ch(W, D):
            k = chamfer
            return [(-W / 2 + k, -D / 2), (W / 2 - k, -D / 2), (W / 2, -D / 2 + k), (W / 2, D / 2 - k), (W / 2 - k, D / 2),
                    (-W / 2 + k, D / 2), (-W / 2, D / 2 - k), (-W / 2, -D / 2 + k)]
        corners_b, corners_t = ch(w, d), ch(wt, dt)
    B = [c + ax * x + ay * y + V(0, 0, z0) for x, y in corners_b]
    T = [ct + ax * x + ay * y + V(0, 0, z1) for x, y in corners_t]
    n = len(B)
    for i in range(n):
        j = (i + 1) % n
        mb.quad(B[i], B[j], T[j], T[i], ts, col=col)
    if top:
        mb.polygon([tuple(p) for p in T], ts, col=col)
