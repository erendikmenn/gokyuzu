"""Render the SF facade/roof texture atlas cells with Cycles (orthographic, real modelled geometry).

  Blender -b -P blender/city/facade_atlas.py -- [--only name1,name2] [--res 1024] [--samples 64]

Outputs assets/sf/city/atlas/cells/<name>_{albedo,data,win,normal}.png (1024 px renders); tools/geo/city_atlas.py packs
them into the 4K atlas PNGs + atlas.json. Cell list / sizes: STYLES below (single source of truth, dumped to cells.json).
"""
import json
import math
import os
import random
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'common'))
from util import reset_scene, setup_cycles, REPO  # noqa: E402
import facade_kit as K  # noqa: E402
from facade_kit import (Cell, box, quad, prism, wall_with_holes, reveal, window, punched, periodic, srgb,  # noqa: E402
                        m_plain, m_stucco, m_concrete, m_brick, m_stone, m_siding, m_corrugated, m_glass, m_gravel)

OUT = os.path.join(REPO, 'assets', 'sf', 'city', 'atlas', 'cells')
TAU = math.pi * 2


def glass_set(prefix, n=6, seed=0, **kw):
    return [m_glass(f'{prefix}{i}', seed * 100 + i, **kw) for i in range(n)]


def pick(lst, rnd):
    return lst[rnd.randrange(len(lst))]


# ================================================================================================== facade builders
def f_glass_blue():
    W, H = Cell.W, Cell.H
    vis = glass_set('gv', 8, 1, style='curtainwall', tint_color=(0.035, 0.075, 0.09), rough=0.04, metal=0.55)
    span = m_plain('span', (0.05, 0.07, 0.085), rough=0.15, metal=0.5, noise=0.03)
    mull = m_plain('mull', (0.50, 0.53, 0.56), rough=0.3, metal=0.9, noise=0.0)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(1)
        for f in range(2):
            z0 = oz + f * fh
            for p in range(4):
                x0 = ox + p * 1.5
                quad((x0, 0.05, z0), (x0 + 1.5, 0.05, z0), (x0 + 1.5, 0.05, z0 + 0.95), (x0, 0.05, z0 + 0.95), span)
                quad((x0, 0.05, z0 + 0.95), (x0 + 1.5, 0.05, z0 + 0.95), (x0 + 1.5, 0.05, z0 + fh), (x0, 0.05, z0 + fh), pick(vis, rnd))
                box(x0 - 0.035, x0 + 0.035, -0.14, 0.05, z0, z0 + fh, mull)
            box(ox, ox + W, -0.06, 0.05, z0 - 0.03, z0 + 0.03, mull)
            box(ox, ox + W, -0.05, 0.05, z0 + 0.93, z0 + 0.97, mull)
    periodic(b)


def f_glass_dark():
    W, H = Cell.W, Cell.H
    vis = glass_set('gd', 8, 2, style='curtainwall', tint_color=(0.025, 0.03, 0.035), rough=0.05, metal=0.6)
    span = m_plain('span', (0.03, 0.032, 0.035), rough=0.25, metal=0.4, noise=0.02)
    fin = m_plain('fin', (0.07, 0.07, 0.075), rough=0.35, metal=0.8, noise=0.0)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(2)
        for f in range(2):
            z0 = oz + f * fh
            for p in range(4):
                x0 = ox + p * 1.5
                quad((x0, 0.05, z0), (x0 + 1.5, 0.05, z0), (x0 + 1.5, 0.05, z0 + 0.6), (x0, 0.05, z0 + 0.6), span)
                quad((x0, 0.05, z0 + 0.6), (x0 + 1.5, 0.05, z0 + 0.6), (x0 + 1.5, 0.05, z0 + fh), (x0, 0.05, z0 + fh), pick(vis, rnd))
                deep = 0.35 if p % 2 == 0 else 0.12
                box(x0 - 0.03, x0 + 0.03, -deep, 0.05, z0, z0 + fh, fin)
            box(ox, ox + W, -0.08, 0.05, z0 - 0.04, z0 + 0.04, fin)
    periodic(b)


def f_glass_green():
    W, H = Cell.W, Cell.H
    vis = glass_set('gg', 6, 3, style='curtainwall', tint_color=(0.05, 0.10, 0.09), rough=0.05, metal=0.5)
    bandm = m_stone('bandm', (150, 152, 146), tint=0.5, block=(1.5, 1.27))
    mull = m_plain('mull', (0.35, 0.37, 0.36), rough=0.3, metal=0.9, noise=0.0)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(3)
        for f in range(2):
            z0 = oz + f * fh
            box(ox, ox + W, -0.12, 0.0, z0, z0 + 1.25, bandm)
            for p in range(4):
                x0 = ox + p * 1.5
                quad((x0, 0.08, z0 + 1.25), (x0 + 1.5, 0.08, z0 + 1.25), (x0 + 1.5, 0.08, z0 + fh), (x0, 0.08, z0 + fh), pick(vis, rnd))
                box(x0 - 0.03, x0 + 0.03, 0.0, 0.08, z0 + 1.25, z0 + fh, mull)
    periodic(b)


def f_office_stone():
    W, H = Cell.W, Cell.H
    wall = m_stone('wall', (196, 184, 160), tint=0.45, block=(1.5, 0.475))
    frame = m_plain('frame', (58, 50, 42), rough=0.4, metal=0.6, noise=0.0)
    sill = m_plain('sill', (205, 196, 176), rough=0.8, noise=0.04)
    gl = glass_set('g', 8, 4, rough=0.06, metal=0.25)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(4)
        holes = []
        for f in range(2):
            for bay in range(2):
                x0 = ox + bay * 3.0 + 0.6
                z0 = oz + f * fh + 0.85
                holes.append((x0, x0 + 1.8, z0, z0 + 2.2))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.28, mullions=(2, 1), sill=sill, transom=0.8)
        for bay in range(2):   # shallow pilasters (the periodic copy provides the one at x = W)
            x = ox + bay * 3.0
            box(x - 0.2, x + 0.2, -0.06, 0.0, oz, oz + H, wall)
        for f in range(2):     # floor band
            z = oz + f * fh
            box(ox, ox + W, -0.09, 0.0, z + 0.25, z + 0.45, sill)
    periodic(b)


def f_office_concrete():
    W, H = Cell.W, Cell.H
    conc = m_concrete('conc', (178, 176, 170), tint=0.5, joints=(3.0, 1.9))
    frame = m_plain('frame', (40, 42, 44), rough=0.35, metal=0.8, noise=0.0)
    gl = glass_set('g', 8, 5, rough=0.05, metal=0.35, tint_color=(0.04, 0.05, 0.06))
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(5)
        for f in range(2):
            z0 = oz + f * fh
            box(ox, ox + W, -0.18, 0.0, z0, z0 + 1.35, conc)
            for p in range(4):
                x0 = ox + p * 1.5
                g = pick(gl, rnd)
                quad((x0, 0.1, z0 + 1.35), (x0 + 1.5, 0.1, z0 + 1.35), (x0 + 1.5, 0.1, z0 + fh), (x0, 0.1, z0 + fh), g)
                box(x0 - 0.035, x0 + 0.035, 0.0, 0.1, z0 + 1.35, z0 + fh, frame)
            box(ox, ox + W, 0.0, 0.1, z0 + 1.35, z0 + 1.41, frame)
            quad((ox, -0.18, z0 + 1.35), (ox + W, -0.18, z0 + 1.35), (ox + W, 0.1, z0 + 1.35), (ox, 0.1, z0 + 1.35), conc)
    periodic(b)


def f_office_granite():
    W, H = Cell.W, Cell.H
    gran = m_stone('gran', (92, 52, 46), tint=0.25, rough=0.35, block=(0.75, 1.9), var=0.08)
    frame = m_plain('frame', (30, 28, 26), rough=0.3, metal=0.8, noise=0.0)
    gl = glass_set('g', 8, 6, rough=0.05, metal=0.3, tint_color=(0.035, 0.035, 0.04))
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(6)
        for pier in range(2):
            x = ox + pier * 3.0
            prism([(x - 0.35, oz), (x + 0.35, oz), (x + 0.35, oz + H), (x - 0.35, oz + H)], -0.45, 0.0, gran)
        for f in range(2):
            z0 = oz + f * fh
            box(ox, ox + W, -0.12, 0.0, z0, z0 + 1.0, gran)
            for bay in range(2):
                x0 = ox + bay * 3.0 + 0.35
                quad((x0, 0.05, z0 + 1.0), (x0 + 2.3, 0.05, z0 + 1.0), (x0 + 2.3, 0.05, z0 + fh), (x0, 0.05, z0 + fh), pick(gl, rnd))
                for m in range(3):
                    xm = x0 + m * 2.3 / 2
                    box(xm - 0.03, xm + 0.03, -0.02, 0.05, z0 + 1.0, z0 + fh, frame)
    periodic(b)


def f_apartment_stucco():
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (228, 222, 206), tint=1.0)
    trim = m_plain('trim', (236, 234, 228), rough=0.6, noise=0.03)
    frame = m_plain('frame', (240, 240, 236), rough=0.5, noise=0.0)
    gl = glass_set('g', 10, 7)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(7)
        # canted bay window (left): wall face projection 0.65 m
        bx0, bx1, pj = ox + 0.5, ox + 3.9, 0.65
        holes = []
        for f in range(2):
            z0 = oz + f * fh
            for k in range(2):
                x0 = ox + 4.5 + k * 1.35
                holes.append((x0, x0 + 1.0, z0 + 0.8, z0 + 2.5))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.12, mullions=(1, 2), sill=trim)
            box(x0 - 0.1, x1 + 0.1, -0.06, 0.0, z1, z1 + 0.14, trim)
        # bay: front face + 2 angled faces, full height
        fx0, fx1 = bx0 + pj, bx1 - pj
        pts_front = (fx0, fx1)
        for f in range(2):
            z0 = oz + f * fh
            # front face with window
            quad((fx0, -pj, z0), (fx1, -pj, z0), (fx1, -pj, z0 + 0.75), (fx0, -pj, z0 + 0.75), wall)
            quad((fx0, -pj, z0 + 2.55), (fx1, -pj, z0 + 2.55), (fx1, -pj, z0 + fh), (fx0, -pj, z0 + fh), wall)
            quad((fx0, -pj, z0 + 0.75), (fx0 + 0.12, -pj, z0 + 0.75), (fx0 + 0.12, -pj, z0 + 2.55), (fx0, -pj, z0 + 2.55), wall)
            quad((fx1 - 0.12, -pj, z0 + 0.75), (fx1, -pj, z0 + 0.75), (fx1, -pj, z0 + 2.55), (fx1 - 0.12, -pj, z0 + 2.55), wall)
            window(fx0 + 0.12, fx1 - 0.12, z0 + 0.75, z0 + 2.55, pick(gl, rnd), frame, depth=0.04, y=-pj, mullions=(2, 2))
            # angled sides (as quads from wall to front)
            for (xa, xb) in ((bx0, fx0), (bx1, fx1)):
                quad((xa, 0, z0), (xb, -pj, z0), (xb, -pj, z0 + 0.75), (xa, 0, z0 + 0.75), wall)
                quad((xa, 0, z0 + 2.55), (xb, -pj, z0 + 2.55), (xb, -pj, z0 + fh), (xa, 0, z0 + fh), wall)
                quad((xa, -0.02, z0 + 0.75), (xb, -pj + 0.02, z0 + 0.75), (xb, -pj + 0.02, z0 + 2.55), (xa, -0.02, z0 + 2.55), pick(gl, rnd))
            # belt molding under windows of the bay
            box(fx0 - 0.05, fx1 + 0.05, -pj - 0.06, -pj, z0 + 0.62, z0 + 0.75, trim)
        wall_with_holes(bx0, bx1, oz, oz + H, [], wall, y=0.001)
    periodic(b)


def fire_escape(x0, x1, z0, H, fh, mat):
    """Black steel fire escape platforms + railings + ladder in front of the facade."""
    for f in range(2):
        zf = z0 + f * fh + 0.75
        box(x0, x1, -1.0, -0.05, zf - 0.06, zf, mat)                 # platform
        box(x0, x1, -1.02, -0.98, zf, zf + 0.95, mat)                # front rail (thin plate reads as railing mesh)
        for x in (x0, x1):
            box(x - 0.02, x + 0.02, -1.0, -0.05, zf, zf + 0.95, mat)
        # diagonal ladder
        n = 8
        for i in range(n):
            t = i / n
            xa = x0 + 0.3 + t * (x1 - x0 - 0.6)
            box(xa - 0.12, xa + 0.12, -0.9, -0.5, zf - 0.06 - t * fh, zf - t * fh, mat)


def f_apartment_brick():
    W, H = Cell.W, Cell.H
    wall = m_brick('wall', (150, 78, 58), tint=0.35)
    stone = m_plain('stone', (200, 190, 170), rough=0.8, noise=0.05)
    frame = m_plain('frame', (238, 236, 230), rough=0.5, noise=0.0)
    iron = m_plain('iron', (22, 22, 22), rough=0.6, metal=0.7, noise=0.0)
    gl = glass_set('g', 10, 8)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(8)
        holes = []
        for f in range(2):
            for k in range(3):
                x0 = ox + 0.9 + k * 2.2
                holes.append((x0, x0 + 1.05, oz + f * fh + 0.8, oz + f * fh + 2.5))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.18, mullions=(1, 2), sill=stone)
            box(x0 - 0.12, x1 + 0.12, -0.05, 0.0, z1, z1 + 0.22, stone)
        fire_escape(ox + 2.7, ox + 5.1, oz, H, fh, iron)
    periodic(b)


def f_modern_midrise():
    W, H = Cell.W, Cell.H
    panel = m_concrete('panel', (205, 205, 200), tint=0.9, joints=(1.333, 0.8), joint_dark=0.8, stains=0.06)
    accent = m_concrete('accent', (120, 124, 128), tint=0.3, joints=(1.333, 0.8), joint_dark=0.85, stains=0.05)
    frame = m_plain('frame', (35, 36, 38), rough=0.35, metal=0.7, noise=0.0)
    rail = m_plain('rail', (0.2, 0.25, 0.27), rough=0.08, metal=0.3, noise=0.0)
    gl = glass_set('g', 10, 9, rough=0.05, metal=0.2)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(9)
        holes = []
        for f in range(2):
            z0 = oz + f * fh
            sh = 0.0 if f == 0 else 1.33
            for k, wdt in ((0, 2.4), (1, 1.2)):
                x0 = ox + 0.4 + sh + k * 3.8
                holes.append((x0, x0 + wdt, z0 + 0.5, z0 + 2.75))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, panel)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, panel, pick(gl, rnd), frame, depth=0.2, mullions=(max(1, round((x1 - x0) / 1.2)), 1))
        # accent panel column + juliet railing
        box(ox + 6.1, ox + 7.4, -0.05, 0.0, oz, oz + H, accent)
        for f in range(2):
            z0 = oz + f * fh
            x0 = ox + 0.4 + (0.0 if f == 0 else 1.33)
            box(x0, x0 + 2.4, -0.18, -0.16, z0 + 0.5, z0 + 1.55, rail)
    periodic(b)


def f_highrise_res():
    W, H = Cell.W, Cell.H
    slab = m_concrete('slab', (226, 226, 222), tint=0.6, joints=None, stains=0.05)
    frame = m_plain('frame', (70, 74, 78), rough=0.3, metal=0.8, noise=0.0)
    rail = m_plain('rail', (0.12, 0.17, 0.19), rough=0.06, metal=0.4, noise=0.0)
    gl = glass_set('g', 10, 10, rough=0.05, metal=0.35, tint_color=(0.04, 0.06, 0.07))
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(10)
        for f in range(2):
            z0 = oz + f * fh
            for p in range(5):
                x0 = ox + p * 1.6
                quad((x0, 0.1, z0 + 0.3), (x0 + 1.6, 0.1, z0 + 0.3), (x0 + 1.6, 0.1, z0 + fh), (x0, 0.1, z0 + fh), pick(gl, rnd))
                box(x0 - 0.03, x0 + 0.03, 0.02, 0.1, z0, z0 + fh, frame)
            box(ox, ox + W, -0.12, 0.1, z0, z0 + 0.3, slab)
            # balcony on half of the width, alternating
            bx0 = ox + (0.5 if f == 0 else 4.3)
            box(bx0, bx0 + 3.2, -1.4, 0.0, z0 + 0.0, z0 + 0.25, slab)
            box(bx0, bx0 + 3.2, -1.42, -1.38, z0 + 0.25, z0 + 1.3, rail)
    periodic(b)


def f_victorian():
    W, H = Cell.W, Cell.H
    siding = m_siding('siding', (238, 236, 230), board=0.14, tint=1.0)
    trim = m_plain('trim', (246, 244, 238), rough=0.55, noise=0.02)
    frame = m_plain('frame', (248, 248, 244), rough=0.5, noise=0.0)
    dark = m_plain('dark', (70, 50, 40), rough=0.6, noise=0.05, tint=0.6)
    gl = glass_set('g', 10, 11)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(11)
        bx0, bx1, pj = ox + 0.4, ox + 4.0, 0.85
        fx0, fx1 = bx0 + pj * 0.8, bx1 - pj * 0.8
        holes = []
        for f in range(2):
            z0 = oz + f * fh
            for k in range(2):
                x0 = ox + 4.6 + k * 1.3
                holes.append((x0, x0 + 0.85, z0 + 0.7, z0 + 2.85))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, siding)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, siding, pick(gl, rnd), frame, depth=0.1, mullions=(1, 2), sill=trim)
            # window casing + pediment hood
            box(x0 - 0.12, x0, -0.05, 0.0, z0 - 0.1, z1 + 0.1, trim)
            box(x1, x1 + 0.12, -0.05, 0.0, z0 - 0.1, z1 + 0.1, trim)
            prism([(x0 - 0.22, z1 + 0.1), (x1 + 0.22, z1 + 0.1), ((x0 + x1) / 2, z1 + 0.42)], -0.14, 0.0, trim)
            box(x0 - 0.22, x1 + 0.22, -0.16, 0.0, z1 + 0.08, z1 + 0.16, trim)
        for f in range(2):
            z0 = oz + f * fh
            # bay front + sides with tall windows
            for (xa, ya, xb, yb, main) in ((fx0, -pj, fx1, -pj, True), (bx0, 0.0, fx0, -pj, False), (fx1, -pj, bx1, 0.0, False)):
                def P(t, z):
                    return (xa + (xb - xa) * t, ya + (yb - ya) * t, z)
                quad(P(0, z0), P(1, z0), P(1, z0 + 0.7), P(0, z0 + 0.7), siding)
                quad(P(0, z0 + 2.85), P(1, z0 + 2.85), P(1, z0 + fh), P(0, z0 + fh), siding)
                quad(P(0, z0 + 0.7), P(0.12, z0 + 0.7), P(0.12, z0 + 2.85), P(0, z0 + 2.85), trim)
                quad(P(0.88, z0 + 0.7), P(1, z0 + 0.7), P(1, z0 + 2.85), P(0.88, z0 + 2.85), trim)
                g = pick(gl, rnd)
                a, c = P(0.12, z0 + 0.7), P(0.88, z0 + 2.85)
                quad((a[0], a[1] + 0.04, a[2]), (c[0], c[1] + 0.04, a[2]), (c[0], c[1] + 0.04, c[2]), (a[0], a[1] + 0.04, c[2]), g)
                # sash bar
                zm = z0 + 0.7 + 2.15 * 0.55
                quad((a[0], a[1] + 0.03, zm - 0.03), (c[0], c[1] + 0.03, zm - 0.03), (c[0], c[1] + 0.03, zm + 0.03), (a[0], a[1] + 0.03, zm + 0.03), frame)
                # decorative panel below window
                quad((a[0], a[1] - 0.01, z0 + 0.15), (c[0], c[1] - 0.01, z0 + 0.15), (c[0], c[1] - 0.01, z0 + 0.6), (a[0], a[1] - 0.01, z0 + 0.6), trim)
            # bay belt between floors
            prism([(bx0, z0 + 2.95), (bx1, z0 + 2.95), (bx1, z0 + 3.2), (bx0, z0 + 3.2)], -pj - 0.12, 0.0, trim)
        # cornice with brackets at the top of the cell
        top = oz + H
        box(ox, ox + W, -0.55, 0.0, top - 0.32, top - 0.02, trim)
        box(ox, ox + W, -0.35, 0.0, top - 0.62, top - 0.32, dark)
        for k in range(9):
            x = ox + 0.2 + k * (W - 0.4) / 8
            box(x - 0.07, x + 0.07, -0.5, 0.0, top - 0.75, top - 0.32, trim)
    periodic(b)


def f_edwardian():
    W, H = Cell.W, Cell.H
    shingle = m_brick('shingle', (224, 220, 212), mortar=(150, 146, 140), tint=1.0, brick=(0.2, 0.2), var=0.06)
    trim = m_plain('trim', (244, 242, 236), rough=0.55, noise=0.02)
    frame = m_plain('frame', (248, 248, 244), rough=0.5, noise=0.0)
    gl = glass_set('g', 10, 12)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(12)
        bx0, bx1, pj = ox + 0.6, ox + 4.4, 0.7
        holes = []
        for f in range(2):
            z0 = oz + f * fh
            holes.append((ox + 5.2, ox + 6.9, z0 + 0.8, z0 + 2.6))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, shingle)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, shingle, pick(gl, rnd), frame, depth=0.1, mullions=(2, 2), sill=trim)
            box(x0 - 0.1, x1 + 0.1, -0.06, 0.0, z1, z1 + 0.18, trim)
        # rectangular box bay spanning both floors
        prism([(bx0, oz), (bx1, oz), (bx1, oz + H), (bx0, oz + H)], -pj, 0.0, shingle)
        for f in range(2):
            z0 = oz + f * fh
            for k in range(3):
                x0 = bx0 + 0.25 + k * 1.15
                window(x0, x0 + 0.95, z0 + 0.75, z0 + 2.65, pick(gl, rnd), frame, depth=-0.0, y=-pj - 0.02, mullions=(1, 2))
            box(bx0 - 0.05, bx1 + 0.05, -pj - 0.1, 0.0, z0 + 2.75, z0 + 2.95, trim)
        top = oz + H
        box(ox, ox + W, -0.45, 0.0, top - 0.25, top - 0.02, trim)
    periodic(b)


def f_sunset_house():
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (232, 226, 214), tint=1.0, grain=0.05)
    trim = m_plain('trim', (240, 238, 232), rough=0.6, noise=0.03)
    frame = m_plain('frame', (245, 245, 242), rough=0.5, noise=0.0)
    tile = m_plain('tile', (160, 80, 52), rough=0.7, noise=0.12)
    iron = m_plain('iron', (25, 25, 25), rough=0.6, metal=0.6, noise=0.0)
    gl = glass_set('g', 8, 13)
    def b(ox, oz):
        rnd = random.Random(13)
        holes = [(ox + 0.8, ox + 4.2, oz + 0.7, oz + 2.5), (ox + 5.4, ox + 6.5, oz + 1.1, oz + 2.4)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        (x0, x1, z0, z1) = holes[0]
        punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.15, mullions=(4, 1), sill=trim, transom=0.72)
        (x0, x1, z0, z1) = holes[1]
        punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.15, mullions=(2, 1), sill=trim)
        for k in range(6):   # decorative iron grille
            x = x0 + 0.08 + k * (x1 - x0 - 0.16) / 5
            box(x - 0.012, x + 0.012, -0.08, -0.06, z0, z1, iron)
        # red tile false-front eave at top
        top = oz + H
        box(ox, ox + W, -0.45, 0.0, top - 0.3, top - 0.12, tile)
        for k in range(24):
            x = ox + k * W / 24
            box(x, x + W / 48, -0.48, -0.44, top - 0.34, top - 0.12, tile)
        box(ox, ox + W, -0.05, 0.0, top - 0.5, top - 0.3, trim)
    periodic(b)


def f_house_siding():
    W, H = Cell.W, Cell.H
    siding = m_siding('siding', (230, 228, 222), board=0.18, tint=1.0, shadow=0.2)
    trim = m_plain('trim', (244, 242, 238), rough=0.55, noise=0.02)
    frame = m_plain('frame', (246, 246, 242), rough=0.5, noise=0.0)
    shut = m_plain('shutter', (60, 70, 66), rough=0.6, noise=0.04, tint=0.3)
    gl = glass_set('g', 8, 14)
    def b(ox, oz):
        rnd = random.Random(14)
        holes = [(ox + 1.2, ox + 2.2, oz + 0.8, oz + 2.3), (ox + 5.2, ox + 6.2, oz + 0.8, oz + 2.3)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, siding)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, siding, pick(gl, rnd), frame, depth=0.08, mullions=(1, 2), sill=trim)
            box(x0 - 0.1, x0, -0.04, 0.0, z0, z1, trim)
            box(x1, x1 + 0.1, -0.04, 0.0, z0, z1, trim)
            box(x0 - 0.12, x1 + 0.12, -0.05, 0.0, z1, z1 + 0.15, trim)
            box(x0 - 0.55, x0 - 0.12, -0.05, -0.01, z0, z1, shut)
            box(x1 + 0.12, x1 + 0.55, -0.05, -0.01, z0, z1, shut)
        box(ox, ox + W, -0.06, 0.0, oz, oz + 0.12, trim)
    periodic(b)


def f_brick_warehouse():
    W, H = Cell.W, Cell.H
    wall = m_brick('wall', (140, 70, 50), tint=0.3)
    stone = m_plain('stone', (190, 180, 160), rough=0.8, noise=0.06)
    frame = m_plain('frame', (30, 32, 30), rough=0.5, metal=0.7, noise=0.0)
    gl = glass_set('g', 8, 15, rough=0.1)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(15)
        holes = []
        for f in range(2):
            for bay in range(2):
                x0 = ox + bay * 4.0 + 0.7
                holes.append((x0, x0 + 2.6, oz + f * fh + 0.9, oz + f * fh + 3.7))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.3, mullions=(4, 5), sill=stone, fw=0.035)
            box(x0 - 0.1, x1 + 0.1, -0.06, 0.0, z1, z1 + 0.3, stone)
        for bay in range(2):
            x = ox + bay * 4.0
            box(x - 0.3, x + 0.3, -0.14, 0.0, oz, oz + H, wall)
        box(ox, ox + W, -0.08, 0.0, oz + fh - 0.1, oz + fh + 0.1, stone)
    periodic(b)


def f_industrial_metal():
    W, H = Cell.W, Cell.H
    metal = m_corrugated('metal', (205, 205, 200), tint=1.0)
    base = m_concrete('base', (160, 158, 152), tint=0.2, joints=(4.0, 8.0))
    lite = m_plain('lite', (0.55, 0.58, 0.55), rough=0.3, noise=0.08, win=0.5)
    trim = m_plain('trim', (90, 92, 95), rough=0.5, metal=0.6, noise=0.0, tint=0.5)
    def b(ox, oz):
        wall_with_holes(ox, ox + W, oz + 0.8, oz + H, [(ox, ox + W, oz + 5.6, oz + 6.3)], metal)
        box(ox, ox + W, -0.06, 0.0, oz, oz + 0.8, base)
        quad((ox, 0.02, oz + 5.6), (ox + W, 0.02, oz + 5.6), (ox + W, 0.02, oz + 6.3), (ox, 0.02, oz + 6.3), lite)
        for k in range(4):
            x = ox + k * 2.0
            box(x - 0.03, x + 0.03, -0.02, 0.02, oz + 5.6, oz + 6.3, trim)
        box(ox, ox + W, -0.08, 0.0, oz + 7.7, oz + 8.0, trim)
    periodic(b)


def f_industrial_concrete():
    W, H = Cell.W, Cell.H
    conc = m_concrete('conc', (214, 208, 196), tint=1.0, joints=(4.5, 8.0), joint_dark=0.6, stains=0.2)
    band = m_plain('band', (110, 120, 130), rough=0.8, noise=0.05, tint=0.2)
    frame = m_plain('frame', (40, 40, 40), rough=0.5, metal=0.6, noise=0.0)
    gl = glass_set('g', 4, 16)
    def b(ox, oz):
        rnd = random.Random(16)
        holes = [(ox + 1.5, ox + 3.0, oz + 5.0, oz + 6.2)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, conc)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, conc, pick(gl, rnd), frame, depth=0.12, mullions=(2, 1))
        box(ox, ox + W, -0.02, 0.0, oz + 6.9, oz + 7.2, band)
    periodic(b)


def f_parking():
    W, H = Cell.W, Cell.H
    conc = m_concrete('conc', (190, 188, 182), tint=0.5, joints=(8.0, 3.0), stains=0.25)
    dark = m_plain('dark', (0.025, 0.025, 0.028), rough=0.9, noise=0.2)
    fh = H / 2
    cars = [m_plain(f'car{i}', c, rough=0.3, noise=0.0) for i, c in enumerate([(0.3, 0.3, 0.32), (0.02, 0.02, 0.025), (0.45, 0.05, 0.05), (0.5, 0.5, 0.52), (0.05, 0.1, 0.25), (0.6, 0.6, 0.6)])]
    def b(ox, oz):
        rnd = random.Random(17)
        for f in range(2):
            z0 = oz + f * fh
            box(ox, ox + W, -0.1, 0.0, z0, z0 + 1.05, conc)
            quad((ox, 2.5, z0 + 1.05), (ox + W, 2.5, z0 + 1.05), (ox + W, 2.5, z0 + fh), (ox, 2.5, z0 + fh), dark)
            box(ox, ox + W, 0.0, 2.5, z0 + fh - 0.35, z0 + fh, conc)    # slab edge/ceiling
            box(ox + 3.8, ox + 4.2, 0.1, 2.5, z0 + 1.05, z0 + fh, conc)  # column
            for k in range(3):
                if rnd.random() < 0.8:
                    x = ox + 0.3 + k * 2.6
                    box(x, x + 2.0, 0.6, 2.3, z0 + 1.05, z0 + 1.05 + rnd.uniform(0.3, 0.55), pick(cars, rnd))
    periodic(b)


def f_civic_stone():
    W, H = Cell.W, Cell.H
    wall = m_stone('wall', (214, 208, 194), tint=0.3, block=(1.6, 0.56), rough=0.75)
    frame = m_plain('frame', (40, 44, 40), rough=0.5, metal=0.6, noise=0.0)
    gl = glass_set('g', 8, 18)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(18)
        holes = []
        for f in range(2):
            for bay in range(2):
                x0 = ox + bay * 4.0 + 1.2
                holes.append((x0, x0 + 1.6, oz + f * fh + 0.9, oz + f * fh + 3.4))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.35, mullions=(2, 3), sill=wall)
            prism([(x0 - 0.25, z1 + 0.15), (x1 + 0.25, z1 + 0.15), ((x0 + x1) / 2, z1 + 0.55)], -0.2, 0.0, wall)
        for bay in range(2):   # pilasters
            x = ox + bay * 4.0
            box(x - 0.35, x + 0.35, -0.3, 0.0, oz, oz + H, wall)
            box(x - 0.45, x + 0.45, -0.38, 0.0, oz + fh - 0.3, oz + fh, wall)
        box(ox, ox + W, -0.2, 0.0, oz + fh - 0.2, oz + fh + 0.1, wall)
    periodic(b)


def f_blank_stucco():
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (226, 220, 208), tint=1.0, dirt=0.16)
    frame = m_plain('frame', (238, 238, 234), rough=0.5, noise=0.0)
    pipe = m_plain('pipe', (140, 140, 138), rough=0.4, metal=0.6, noise=0.0)
    gl = glass_set('g', 3, 19)
    def b(ox, oz):
        wall_with_holes(ox, ox + W, oz, oz + H, [], wall)
        box(ox + 1.8, ox + 1.9, -0.12, -0.02, oz, oz + H, pipe)
    periodic(b)


def f_blank_brick():
    W, H = Cell.W, Cell.H
    wall = m_brick('wall', (132, 72, 56), tint=0.3, var=0.22)
    tie = m_plain('tie', (30, 30, 30), noise=0.0)
    def b(ox, oz):
        wall_with_holes(ox, ox + W, oz, oz + H, [], wall)
        for k in range(2):   # steel tie plates (earthquake retrofit)
            x = ox + 2.0 + k * 4.0
            box(x - 0.08, x + 0.08, -0.05, 0.0, oz + 2.9, oz + 3.06, tie)
    periodic(b)


def f_rear_stucco():
    """Back / exposed side walls of SF row houses and apartments: stucco, plain double-hung windows, downspout."""
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (226, 220, 208), tint=1.0, dirt=0.14)
    frame = m_plain('frame', (238, 238, 234), rough=0.5, noise=0.0)
    trim = m_plain('trim', (232, 230, 224), rough=0.6, noise=0.03)
    pipe = m_plain('pipe', (150, 150, 146), rough=0.4, metal=0.6, noise=0.0)
    gl = glass_set('g', 8, 24)
    fh = H / 2
    def b(ox, oz):
        rnd = random.Random(24)
        holes = []
        for f in range(2):
            z0 = oz + f * fh
            holes.append((ox + 1.0, ox + 1.9, z0 + 0.9, z0 + 2.3))
            holes.append((ox + 4.4, ox + 5.8, z0 + 0.9, z0 + 2.3))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for (x0, x1, z0, z1) in holes:
            punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.1, mullions=(1, 2), sill=trim)
        box(ox + 7.1, ox + 7.2, -0.12, -0.02, oz, oz + H, pipe)
    periodic(b)


# ---------------------------------------------------------------------------------------------------- ground floors
def g_storefront():
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (200, 194, 182), tint=0.8)
    tile = m_plain('tile', (60, 64, 70), rough=0.3, noise=0.08, tint=0.3)
    frame = m_plain('frame', (35, 35, 36), rough=0.35, metal=0.8, noise=0.0)
    signs = [m_plain(f'sign{i}', c, rough=0.5, noise=0.25) for i, c in enumerate([(150, 30, 30), (30, 60, 110), (20, 90, 60), (200, 160, 40), (40, 40, 44), (230, 225, 210)])]
    awn = [m_plain(f'awn{i}', c, rough=0.9, noise=0.1) for i, c in enumerate([(120, 20, 26), (20, 70, 50), (30, 40, 80), (60, 60, 60)])]
    shop = [m_glass(f'shop{i}', 300 + i, style='interior', tint_color=c, win=1.0, rough=0.04)
            for i, c in enumerate([(0.18, 0.15, 0.11), (0.12, 0.12, 0.12), (0.2, 0.17, 0.12), (0.1, 0.09, 0.08)])]
    def b(ox, oz):
        rnd = random.Random(20)
        holes = []
        for s in range(2):
            x0 = ox + s * 4.0
            holes.append((x0 + 0.25, x0 + 2.75, oz + 0.55, oz + 3.1))
            holes.append((x0 + 2.9, x0 + 3.75, oz + 0.02, oz + 2.5))
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        for i, (x0, x1, z0, z1) in enumerate(holes):
            g = pick(shop, rnd)
            reveal(x0, x1, z0, z1, 0.25, frame)
            window(x0, x1, z0, z1, g, frame, depth=0.25, mullions=(2 if i % 2 == 0 else 1, 1), transom=0.82)
        for s in range(2):
            x0 = ox + s * 4.0
            box(x0 + 0.2, x0 + 2.8, -0.04, 0.0, oz, oz + 0.55, tile)
            box(x0 + 0.1, x0 + 3.9, -0.12, 0.0, oz + 3.3, oz + 4.1, pick(signs, rnd))
            if rnd.random() < 0.7:  # awning
                a = pick(awn, rnd)
                quad((x0 + 0.15, 0.0, oz + 3.25), (x0 + 2.85, 0.0, oz + 3.25), (x0 + 2.85, -1.1, oz + 2.75), (x0 + 0.15, -1.1, oz + 2.75), a)
                quad((x0 + 0.15, -1.1, oz + 2.75), (x0 + 2.85, -1.1, oz + 2.75), (x0 + 2.85, -1.1, oz + 2.5), (x0 + 0.15, -1.1, oz + 2.5), a)
        box(ox, ox + W, -0.08, 0.0, oz + H - 0.25, oz + H, wall)
    periodic(b)


def g_lobby():
    W, H = Cell.W, Cell.H
    stone = m_stone('stone', (70, 68, 66), tint=0.2, rough=0.3, block=(1.5, 1.25), var=0.05)
    frame = m_plain('frame', (150, 150, 146), rough=0.25, metal=0.9, noise=0.0)
    lob = [m_glass(f'lob{i}', 400 + i, style='interior', tint_color=c, win=1.0, rough=0.03)
           for i, c in enumerate([(0.2, 0.18, 0.15), (0.14, 0.13, 0.12)])]
    def b(ox, oz):
        rnd = random.Random(21)
        holes = [(ox + 0.5, ox + 5.5, oz + 0.02, oz + 4.2)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, stone)
        x0, x1, z0, z1 = holes[0]
        reveal(x0, x1, z0, z1, 0.4, stone)
        window(x0, x1, z0, z1, pick(lob, rnd), frame, depth=0.4, mullions=(4, 1), transom=0.62, fw=0.06)
        box(ox + 2.2, ox + 3.8, -1.2, 0.0, oz + 3.0, oz + 3.2, frame)  # entrance canopy
    periodic(b)


def g_garage():
    W, H = Cell.W, Cell.H
    wall = m_stucco('wall', (232, 226, 214), tint=1.0, grain=0.05)
    door = m_concrete('door', (230, 228, 222), tint=0.5, joints=(0.62, 0.55), joint_dark=0.7, stains=0.05)
    wood = m_plain('wood', (110, 70, 40), rough=0.6, noise=0.1)
    frame = m_plain('frame', (245, 245, 242), rough=0.5, noise=0.0)
    step = m_concrete('step', (180, 176, 170), tint=0.0, joints=None)
    gl = glass_set('g', 3, 22)
    def b(ox, oz):
        rnd = random.Random(22)
        holes = [(ox + 0.6, ox + 3.2, oz, oz + 2.25), (ox + 4.3, ox + 5.3, oz, oz + 2.3), (ox + 6.0, ox + 7.0, oz + 1.0, oz + 2.2)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, wall)
        x0, x1, z0, z1 = holes[0]
        reveal(x0, x1, z0, z1, 0.2, wall)
        quad((x0, 0.2, z0), (x1, 0.2, z0), (x1, 0.2, z1), (x0, 0.2, z1), door)
        x0, x1, z0, z1 = holes[1]
        reveal(x0, x1, z0, z1, 0.5, wall)
        quad((x0, 0.5, z0), (x1, 0.5, z0), (x1, 0.5, z1), (x0, 0.5, z1), wood)
        for k in range(3):
            box(x0 - 0.2, x1 + 0.2, -0.3 * (3 - k), 0.0, oz + k * 0.12, oz + (k + 1) * 0.12, step)
        x0, x1, z0, z1 = holes[2]
        punched(x0, x1, z0, z1, wall, pick(gl, rnd), frame, depth=0.12, mullions=(1, 2))
    periodic(b)


def g_victorian():
    W, H = Cell.W, Cell.H
    siding = m_siding('siding', (238, 236, 230), board=0.14, tint=1.0)
    trim = m_plain('trim', (246, 244, 238), rough=0.55, noise=0.02)
    door = m_plain('door', (70, 45, 30), rough=0.5, noise=0.08)
    garage = m_concrete('garage', (225, 222, 215), tint=0.7, joints=(0.62, 0.6), joint_dark=0.75)
    step = m_concrete('step', (150, 140, 128), tint=0.0, joints=None)
    frame = m_plain('frame', (248, 248, 244), rough=0.5, noise=0.0)
    gl = glass_set('g', 4, 23)
    def b(ox, oz):
        rnd = random.Random(23)
        holes = [(ox + 0.6, ox + 3.4, oz, oz + 2.3), (ox + 4.9, ox + 6.0, oz + 0.9, oz + H - 0.05)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, siding)
        x0, x1, z0, z1 = holes[0]
        reveal(x0, x1, z0, z1, 0.2, trim)
        quad((x0, 0.2, z0), (x1, 0.2, z0), (x1, 0.2, z1), (x0, 0.2, z1), garage)
        x0, x1, z0, z1 = holes[1]
        reveal(x0, x1, z0, z1, 0.8, trim)
        quad((x0 + 0.05, 0.8, z0), (x1 - 0.05, 0.8, z0), (x1 - 0.05, 0.8, z1 - 0.5), (x0 + 0.05, 0.8, z1 - 0.5), door)
        quad((x0 + 0.05, 0.79, z1 - 0.48), (x1 - 0.05, 0.79, z1 - 0.48), (x1 - 0.05, 0.79, z1 - 0.1), (x0 + 0.05, 0.79, z1 - 0.1), pick(gl, rnd))
        # stairs up to the door
        n = 6
        for k in range(n):
            box(x0 - 0.3, x1 + 0.3, -0.3 * (n - k), 0.0, oz + k * 0.15, oz + (k + 1) * 0.15, step)
        box(ox, ox + W, -0.1, 0.0, oz + H - 0.2, oz + H, trim)
    periodic(b)


def g_warehouse():
    W, H = Cell.W, Cell.H
    conc = m_concrete('conc', (205, 200, 190), tint=1.0, joints=(4.5, 4.5), stains=0.22)
    door = m_corrugated('door', (200, 200, 196), period=0.12, tint=0.4, axis='v', metal=0.4)
    man = m_plain('man', (60, 70, 80), rough=0.5, noise=0.05)
    def b(ox, oz):
        holes = [(ox + 1.0, ox + 4.8, oz, oz + 3.9), (ox + 6.3, ox + 7.3, oz, oz + 2.2)]
        wall_with_holes(ox, ox + W, oz, oz + H, holes, conc)
        x0, x1, z0, z1 = holes[0]
        reveal(x0, x1, z0, z1, 0.15, conc)
        quad((x0, 0.15, z0), (x1, 0.15, z0), (x1, 0.15, z1), (x0, 0.15, z1), door)
        box(x0 - 0.15, x0 - 0.05, -0.3, 0.0, oz, oz + 1.0, man)
        x0, x1, z0, z1 = holes[1]
        reveal(x0, x1, z0, z1, 0.08, conc)
        quad((x0, 0.08, z0), (x1, 0.08, z0), (x1, 0.08, z1), (x0, 0.08, z1), man)
    periodic(b)


# ------------------------------------------------------------------------------------------------------------ roofs
def r_gravel():
    W, H = Cell.W, Cell.H
    g = m_gravel('gravel', (160, 158, 152), tint=1.0)
    metal = m_plain('vent', (170, 172, 174), rough=0.4, metal=0.8, noise=0.0)
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), g)
    periodic_roof(b)


def r_membrane():
    W, H = Cell.W, Cell.H
    mem = Mat_membrane()
    metal = m_plain('vent', (160, 162, 165), rough=0.4, metal=0.8, noise=0.0)
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), mem)
    periodic_roof(b)


def Mat_membrane():
    m = K.Mat('membrane', tint=1.0, rough=0.6)
    nt = m.nt
    seam = K.band(nt, K.stripes(nt, 2.0, 'u'), 0.01, 0.99)
    dirt = K.pnoise(nt, scale=0.5, detail=5, seed=14)
    fine = K.pnoise(nt, scale=10.0, detail=3, seed=15)
    f = K._math(nt, 'MULTIPLY', K._math(nt, 'MULTIPLY_ADD', dirt, 0.28, 0.78), K._math(nt, 'MULTIPLY_ADD', fine, 0.06, 0.97))
    f = K._math(nt, 'MULTIPLY', f, K._math(nt, 'MULTIPLY_ADD', seam, 0.12, 0.88))
    m.color = K._mul_color(nt, srgb((228, 228, 224)), f)
    m.height = seam
    m.bump_strength = 0.3
    return m.finish()


def r_tar():
    W, H = Cell.W, Cell.H
    m = K.Mat('tar', tint=1.0, rough=0.75)
    nt = m.nt
    patch = K.pnoise(nt, scale=0.45, detail=6, rough=0.7, seed=16)
    fine = K.pnoise(nt, scale=20.0, detail=2, seed=17)
    f = K._math(nt, 'MULTIPLY', K._math(nt, 'MULTIPLY_ADD', patch, 0.5, 0.65), K._math(nt, 'MULTIPLY_ADD', fine, 0.2, 0.9))
    m.color = K._mul_color(nt, srgb((80, 80, 82)), f)
    m.height = fine
    m.finish()
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), m)
    periodic_roof(b)


def r_shingle():
    W, H = Cell.W, Cell.H
    m = K.Mat('shingle', tint=1.0, rough=0.9)
    nt = m.nt
    row = K.stripes(nt, 0.14, 'v')
    u, v = K._coords(nt)
    rowi = K._math(nt, 'FLOOR', K._math(nt, 'DIVIDE', v, H / max(1, round(H / 0.14))))
    tabu = K._math(nt, 'FRACT', K._math(nt, 'ADD', K._math(nt, 'DIVIDE', u, W / max(1, round(W / 0.33))), K._math(nt, 'MULTIPLY', rowi, 0.5)))
    slot = K._math(nt, 'MULTIPLY', K.band(nt, tabu, 0.02, 0.98), 1.0)
    shade = K._math(nt, 'MULTIPLY_ADD', K._math(nt, 'POWER', row, 0.4), 0.35, 0.65)
    shade = K._math(nt, 'MULTIPLY', shade, K._math(nt, 'MULTIPLY_ADD', slot, 0.35, 0.65))
    gran = K.pnoise(nt, scale=40.0, detail=2, seed=18)
    blot = K.pnoise(nt, scale=0.8, detail=4, seed=19)
    shade = K._math(nt, 'MULTIPLY', shade, K._math(nt, 'MULTIPLY_ADD', gran, 0.3, 0.85))
    shade = K._math(nt, 'MULTIPLY', shade, K._math(nt, 'MULTIPLY_ADD', blot, 0.2, 0.9))
    m.color = K._mul_color(nt, srgb((200, 200, 198)), shade)
    m.height = K._math(nt, 'MULTIPLY', row, 1.0)
    m.bump_strength = 0.6
    m.finish()
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), m)
    periodic_roof(b)


def r_clay_tile():
    W, H = Cell.W, Cell.H
    m = K.Mat('clay', tint=1.0, rough=0.75)
    nt = m.nt
    cu = K.stripes(nt, 0.26, 'u')
    cv = K.stripes(nt, 0.36, 'v')
    wave = K._math(nt, 'MULTIPLY_ADD', K._math(nt, 'SINE', K._math(nt, 'MULTIPLY', cu, TAU)), 0.5, 0.5)
    lap = K._math(nt, 'POWER', cv, 0.5)
    shade = K._math(nt, 'MULTIPLY', K._math(nt, 'MULTIPLY_ADD', wave, 0.45, 0.55), K._math(nt, 'MULTIPLY_ADD', lap, 0.3, 0.7))
    var = K.pnoise(nt, scale=3.0, detail=3, seed=20)
    shade = K._math(nt, 'MULTIPLY', shade, K._math(nt, 'MULTIPLY_ADD', var, 0.3, 0.85))
    m.color = K._mul_color(nt, srgb((186, 92, 56)), shade)
    m.height = K._math(nt, 'ADD', wave, lap)
    m.bump_strength = 0.8
    m.finish()
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), m)
    periodic_roof(b)


def r_metal():
    W, H = Cell.W, Cell.H
    m = K.m_corrugated('metalroof', (190, 192, 192), period=0.6, tint=1.0, rough=0.45, metal=0.5)
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), m)
    periodic_roof(b)


def r_concrete():
    W, H = Cell.W, Cell.H
    m = m_concrete('deck', (168, 166, 160), tint=1.0, joints=(6.0, 6.0), stains=0.3)
    stripe = m_plain('stripe', (230, 230, 225), rough=0.7, noise=0.1)
    def b(ox, oz):
        quad((ox, oz, 0), (ox + W, oz, 0), (ox + W, oz + H, 0), (ox, oz + H, 0), m)
        for k in range(4):   # parking stripes (garage roofs)
            x = ox + 0.5 + k * 2.7
            box(x, x + 0.1, oz + 1.0, oz + 5.5, 0.0, 0.005, stripe)
    periodic_roof(b)


def periodic_roof(builder):
    W, H = Cell.W, Cell.H
    for ox in (-W, 0.0, W):
        for oy in (-H, 0.0, H):
            builder(ox, oy)


def f_hvac():
    W, H = Cell.W, Cell.H
    body = m_plain('body', (185, 188, 190), rough=0.45, metal=0.6, noise=0.04, tint=0.3)
    louv = m_corrugated('louver', (150, 154, 158), period=0.09, tint=0.3, axis='v', metal=0.6)
    def b(ox, oz):
        wall_with_holes(ox, ox + W, oz, oz + H, [(ox + 0.3, ox + W - 0.3, oz + 0.3, oz + H - 0.8)], body)
        x0, x1, z0, z1 = ox + 0.3, ox + W - 0.3, oz + 0.3, oz + H - 0.8
        reveal(x0, x1, z0, z1, 0.05, body)
        quad((x0, 0.05, z0), (x1, 0.05, z0), (x1, 0.05, z1), (x0, 0.05, z1), louv)
    periodic(b)


# kind: facade | ground | roof. W,H meters per texture repeat; floors: storeys per cell (facade), 0 = stretch
STYLES = [
    # name,              builder,               kind,     W,    H,   floors
    ('glass_blue',        f_glass_blue,          'facade', 6.0,  8.0, 2),
    ('glass_dark',        f_glass_dark,          'facade', 6.0,  8.0, 2),
    ('glass_green',       f_glass_green,         'facade', 6.0,  7.6, 2),
    ('office_stone',      f_office_stone,        'facade', 6.0,  7.6, 2),
    ('office_concrete',   f_office_concrete,     'facade', 6.0,  7.6, 2),
    ('office_granite',    f_office_granite,      'facade', 6.0,  7.6, 2),
    ('apartment_stucco',  f_apartment_stucco,    'facade', 7.6,  6.2, 2),
    ('apartment_brick',   f_apartment_brick,     'facade', 7.6,  6.2, 2),
    ('modern_midrise',    f_modern_midrise,      'facade', 8.0,  6.4, 2),
    ('highrise_res',      f_highrise_res,        'facade', 8.0,  6.2, 2),
    ('victorian',         f_victorian,           'facade', 7.6,  7.0, 2),
    ('edwardian',         f_edwardian,           'facade', 7.6,  6.8, 2),
    ('sunset_house',      f_sunset_house,        'facade', 7.6,  3.4, 1),
    ('house_siding',      f_house_siding,        'facade', 8.0,  3.0, 1),
    ('brick_warehouse',   f_brick_warehouse,     'facade', 8.0,  9.0, 2),
    ('industrial_metal',  f_industrial_metal,    'facade', 8.0,  8.0, 0),
    ('industrial_concrete', f_industrial_concrete, 'facade', 9.0, 8.0, 0),
    ('parking',           f_parking,             'facade', 8.0,  6.0, 2),
    ('civic_stone',       f_civic_stone,         'facade', 8.0,  9.0, 2),
    ('blank_stucco',      f_blank_stucco,        'facade', 8.0,  6.0, 0),
    ('blank_brick',       f_blank_brick,         'facade', 8.0,  6.0, 0),
    ('hvac',              f_hvac,                'facade', 4.0,  3.0, 0),
    ('gf_storefront',     g_storefront,          'ground', 8.0,  4.5, 1),
    ('gf_lobby',          g_lobby,               'ground', 6.0,  5.0, 1),
    ('gf_garage',         g_garage,              'ground', 7.6,  3.0, 1),
    ('gf_victorian',      g_victorian,           'ground', 7.6,  3.2, 1),
    ('gf_warehouse',      g_warehouse,           'ground', 9.0,  4.5, 1),
    ('roof_gravel',       r_gravel,              'roof',  12.0, 12.0, 0),
    ('roof_membrane',     r_membrane,            'roof',  16.0, 16.0, 0),
    ('roof_tar',          r_tar,                 'roof',  12.0, 12.0, 0),
    ('roof_shingle',      r_shingle,             'roof',   8.0,  8.0, 0),
    ('roof_tile',         r_clay_tile,           'roof',   6.0,  6.0, 0),
    ('roof_metal',        r_metal,               'roof',   8.0,  8.0, 0),
    ('roof_concrete',     r_concrete,            'roof',  12.0, 12.0, 0),
    ('rear_stucco',       f_rear_stucco,         'facade', 7.6,  6.0, 2),
]


# ------------------------------------------------------------------------------------------------------------ render
USE_GPU = '--cpu' not in sys.argv


def setup_render(res, samples):
    sc = setup_cycles(samples=samples, width=res, height=res, gpu=USE_GPU)
    sc.view_settings.view_transform = 'Standard'
    try:
        sc.view_settings.look = 'None'
    except TypeError:
        pass
    sc.cycles.max_bounces = 4
    sc.cycles.diffuse_bounces = 3
    sc.cycles.glossy_bounces = 1
    sc.render.film_transparent = False
    sc.render.image_settings.color_mode = 'RGB'
    return sc


def world(strength):
    sc = bpy.context.scene
    w = sc.world or bpy.data.worlds.new('W')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    if bg is None:
        bg = w.node_tree.nodes.new('ShaderNodeBackground')
        out = w.node_tree.nodes.new('ShaderNodeOutputWorld')
        w.node_tree.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs[0].default_value = (1, 1, 1, 1)
    bg.inputs[1].default_value = strength


def camera(kind, W, H, res):
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.sensor_fit = 'HORIZONTAL'
    cam.ortho_scale = W
    cam.clip_start = 0.1
    cam.clip_end = 1000
    ob = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(ob)
    if kind == 'roof':
        ob.location = (W / 2, H / 2, 50)
        ob.rotation_euler = (0, 0, 0)
    else:
        ob.location = (W / 2, -50, H / 2)
        ob.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.scene.camera = ob
    sc = bpy.context.scene
    sc.render.resolution_x = res
    sc.render.resolution_y = max(8, round(res * H / W))


def render_cell(name, builder, kind, W, H, res, samples):
    reset_scene()
    K.new_cell(W, H, 'roof' if kind == 'roof' else 'facade')
    sc = setup_render(res, samples)
    camera(kind, W, H, res)
    builder()
    os.makedirs(OUT, exist_ok=True)
    base = os.path.join(OUT, name)
    # beauty (albedo x sky occlusion)
    world(1.0)
    K.set_all_modes('beauty')
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.filepath = base + '_albedo.png'
    bpy.ops.render.render(write_still=True)
    # data passes: emission only, black world, raw values
    world(0.0)
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.view_settings.view_transform = 'Raw'
    for mode, suffix in (('data', '_data.png'), ('win', '_win.png'), ('normal', '_normal.png')):
        K.set_all_modes(mode)
        sc.render.filepath = base + suffix
        bpy.ops.render.render(write_still=True)
    print(f'[atlas] {name} done', flush=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = None
    res, samples = 1024, 64
    for i, a in enumerate(argv):
        if a == '--only':
            only = set(argv[i + 1].split(','))
        if a == '--res':
            res = int(argv[i + 1])
        if a == '--samples':
            samples = int(argv[i + 1])
    os.makedirs(OUT, exist_ok=True)
    meta = [{'name': n, 'kind': k, 'W': w, 'H': h, 'floors': f} for (n, _, k, w, h, f) in STYLES]
    json.dump(meta, open(os.path.join(OUT, 'cells.json'), 'w'), indent=1)
    for (name, builder, kind, W, H, floors) in STYLES:
        if only and name not in only:
            continue
        render_cell(name, builder, kind, W, H, res, samples)


if __name__ == '__main__':
    main()
