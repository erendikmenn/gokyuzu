"""Minimal SVG geometry reader (pure numpy): <path d>, <polygon points>, <rect> -> list of closed subpath polygons.
Supports M L H V C S Q T A Z (absolute + relative), used to rasterize the airline emblem and title letterforms
exactly from the reference vectors (even-odd fill)."""
import math
import re
import numpy as np

_TOK = re.compile(r'[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?')


def _arc(p0, rx, ry, phi, large, sweep, p1, n=24):
    """SVG elliptical arc (endpoint parameterisation) -> points (excluding p0)."""
    if rx == 0 or ry == 0:
        return [p1]
    x1, y1 = p0; x2, y2 = p1
    cphi, sphi = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cphi * dx + sphi * dy
    y1p = -sphi * dx + cphi * dy
    rx, ry = abs(rx), abs(ry)
    lam = (x1p / rx) ** 2 + (y1p / ry) ** 2
    if lam > 1:
        rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cphi * cxp - sphi * cyp + (x1 + x2) / 2
    cy = sphi * cxp + cphi * cyp + (y1 + y2) / 2

    def ang(u, v):
        a = math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])
        return a
    t1 = ang((1, 0), ((x1p - cxp) / rx, (y1p - cyp) / ry))
    dt = ang(((x1p - cxp) / rx, (y1p - cyp) / ry), ((-x1p - cxp) / rx, (-y1p - cyp) / ry))
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    m = max(2, int(abs(dt) / (2 * math.pi) * n * 4))
    out = []
    for k in range(1, m + 1):
        t = t1 + dt * k / m
        x = cx + rx * math.cos(t) * cphi - ry * math.sin(t) * sphi
        y = cy + rx * math.cos(t) * sphi + ry * math.sin(t) * cphi
        out.append((x, y))
    return out


def _cubic(p0, p1, p2, p3, n=16):
    t = np.linspace(0, 1, n + 1)[1:, None]
    p0, p1, p2, p3 = (np.array(p, float) for p in (p0, p1, p2, p3))
    pts = (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3
    return [tuple(p) for p in pts]


def parse_path(d):
    toks = _TOK.findall(d)
    i = 0
    subs = []
    cur = []
    pos = (0.0, 0.0)
    start = (0.0, 0.0)
    cmd = None
    last_ctrl = None
    last_cmd = None

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v
    while i < len(toks):
        t = toks[i]
        if re.match(r'[A-Za-z]', t):
            cmd = t; i += 1
            if cmd in 'Zz':
                if cur:
                    subs.append(np.array(cur))
                cur = []
                pos = start
                last_cmd = cmd
                continue
        rel = cmd.islower()
        C = cmd.upper()
        ox, oy = pos if rel else (0.0, 0.0)
        if C == 'M':
            x, y = num() + ox, num() + oy
            if cur:
                subs.append(np.array(cur))
            cur = [(x, y)]
            pos = start = (x, y)
            cmd = 'l' if rel else 'L'
            last_ctrl = None
        elif C == 'L':
            x, y = num() + ox, num() + oy
            cur.append((x, y)); pos = (x, y); last_ctrl = None
        elif C == 'H':
            x = num() + (pos[0] if rel else 0.0)
            pos = (x, pos[1]); cur.append(pos); last_ctrl = None
        elif C == 'V':
            y = num() + (pos[1] if rel else 0.0)
            pos = (pos[0], y); cur.append(pos); last_ctrl = None
        elif C == 'C':
            c1 = (num() + ox, num() + oy); c2 = (num() + ox, num() + oy); p = (num() + ox, num() + oy)
            cur.extend(_cubic(pos, c1, c2, p)); last_ctrl = c2; pos = p
        elif C == 'S':
            c1 = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if (last_ctrl and last_cmd and last_cmd.upper() in 'CS') else pos
            c2 = (num() + ox, num() + oy); p = (num() + ox, num() + oy)
            cur.extend(_cubic(pos, c1, c2, p)); last_ctrl = c2; pos = p
        elif C == 'Q':
            q = (num() + ox, num() + oy); p = (num() + ox, num() + oy)
            c1 = (pos[0] + 2 / 3 * (q[0] - pos[0]), pos[1] + 2 / 3 * (q[1] - pos[1]))
            c2 = (p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1]))
            cur.extend(_cubic(pos, c1, c2, p)); last_ctrl = q; pos = p
        elif C == 'T':
            q = (2 * pos[0] - last_ctrl[0], 2 * pos[1] - last_ctrl[1]) if (last_ctrl and last_cmd and last_cmd.upper() in 'QT') else pos
            p = (num() + ox, num() + oy)
            c1 = (pos[0] + 2 / 3 * (q[0] - pos[0]), pos[1] + 2 / 3 * (q[1] - pos[1]))
            c2 = (p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1]))
            cur.extend(_cubic(pos, c1, c2, p)); last_ctrl = q; pos = p
        elif C == 'A':
            rx, ry, rot = num(), num(), num()
            large, sweep = int(num()), int(num())
            p = (num() + ox, num() + oy)
            cur.extend(_arc(pos, rx, ry, math.radians(rot), large, sweep, p)); pos = p; last_ctrl = None
        else:
            raise ValueError('unsupported path command ' + cmd)
        last_cmd = cmd
    if cur:
        subs.append(np.array(cur))
    return subs


def element_polys(tag, attrs):
    if tag == 'path':
        return parse_path(re.search(r'\sd="([^"]*)"', attrs).group(1))
    if tag in ('polygon', 'polyline'):
        nums = [float(v) for v in re.findall(r'[-+]?(?:\d*\.\d+|\d+\.?\d*)', re.search(r'points="([^"]*)"', attrs).group(1))]
        return [np.array(nums).reshape(-1, 2)]
    if tag == 'rect':
        g = lambda k: float(re.search(k + r'="([^"]*)"', attrs).group(1))
        x, y, w, h = g(r'\sx'), g(r'\sy'), g('width'), g('height')
        return [np.array([(x, y), (x + w, y), (x + w, y + h), (x, y + h)])]
    return []


def read_svg(path):
    """Returns [(fill, [polys])] for every path/polygon/rect element, resolving CSS class fills."""
    s = open(path, encoding='utf-8').read()
    cls_fill = {}
    st = re.search(r'<style>(.*?)</style>', s, re.S)
    if st:
        for m in re.finditer(r'([^{}]+)\{([^}]*)\}', st.group(1)):
            fm = re.search(r'fill:\s*([^;]+);', m.group(2))
            if fm:
                for n in m.group(1).split(','):
                    cls_fill[n.strip().lstrip('.')] = fm.group(1).strip()
    out = []
    for m in re.finditer(r'<(path|polygon|rect|polyline)(\s[^>]*)/?>', s):
        tag, attrs = m.group(1), m.group(2)
        cm = re.search(r'class="([^"]*)"', attrs)
        fills = [cls_fill[c] for c in (cm.group(1).split() if cm else []) if c in cls_fill]
        fm = re.search(r'\sfill="([^"]*)"', attrs)
        fill = fm.group(1) if fm else (fills[-1] if fills else None)
        out.append((fill, element_polys(tag, attrs), attrs))
    return out
