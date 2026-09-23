"""Skin texture atlas layout (4096², shared by build.py and the texture generator; pure Python).

Pixel coordinates: x right, y down (image space). UV = (x / W, 1 - y / H).
Each region maps a surface parameterization to pixels:
  fuselage halves: (s, arc) where arc = meters along the section from the top centerline (downwards)
  planar parts: (s, t) with t a second in-plane coordinate (span or height)
Text drawn upright in the image appears upright and readable on both sides of the aircraft.
"""
W = H = 4096

K_FUS = 235.0     # px per meter
K_WING = 232.0
K_TAIL = 235.0

S_FUS0, S_FUS1 = 0.44, 13.92

REGIONS = {
    # name: (x0, y0, kind, params)
    # fuselage right half: x increases toward the nose (so text reads correctly seen from the right side)
    'FUS_R': dict(x0=12, y0=12, k=K_FUS),
    'FUS_L': dict(x0=12, y0=0, k=K_FUS),            # y0 set below from the max arc
    # wings: (s, |y|) planform; upper surfaces seen from above, lower seen from below
    'WU_R': dict(s0=6.75, s1=11.0, t0=0.78, t1=4.66, k=K_WING),
    'WU_L': dict(s0=6.75, s1=11.0, t0=0.78, t1=4.66, k=K_WING),
    'WL_R': dict(s0=6.75, s1=11.0, t0=0.78, t1=4.66, k=K_WING),
    'WL_L': dict(s0=6.75, s1=11.0, t0=0.78, t1=4.66, k=K_WING),
    # stabilators: (s, span from root)
    'SU_R': dict(s0=12.05, s1=14.62, t0=-0.02, t1=1.80, k=K_TAIL),
    'SU_L': dict(s0=12.05, s1=14.62, t0=-0.02, t1=1.80, k=K_TAIL),
    'SL_R': dict(s0=12.05, s1=14.62, t0=-0.02, t1=1.80, k=K_TAIL),
    'SL_L': dict(s0=12.05, s1=14.62, t0=-0.02, t1=1.80, k=K_TAIL),
    # fin sides: (s, z)
    'FIN_R': dict(s0=11.30, s1=15.10, t0=2.88, t1=5.24, k=K_TAIL),
    'FIN_L': dict(s0=11.30, s1=15.10, t0=2.88, t1=5.24, k=K_TAIL),
    # fin root box / dorsal (s, arc around the box from the bottom-right over the top)
    'DORSAL': dict(s0=8.9, s1=14.05, t0=0.0, t1=1.05, k=K_TAIL),
    # ventral fins (s, z) both faces
    'VF_RO': dict(s0=10.40, s1=11.95, t0=0.50, t1=1.30, k=K_TAIL),
    'VF_RI': dict(s0=10.40, s1=11.95, t0=0.50, t1=1.30, k=K_TAIL),
    'VF_LO': dict(s0=10.40, s1=11.95, t0=0.50, t1=1.30, k=K_TAIL),
    'VF_LI': dict(s0=10.40, s1=11.95, t0=0.50, t1=1.30, k=K_TAIL),
    # speedbrakes (s, y) upper/lower, R/L
    'SB': dict(s0=13.30, s1=14.30, t0=0.60, t1=1.10, k=K_TAIL),
    # canopy aft fairing + frame (s, arc)
    'CANF': dict(s0=2.70, s1=6.40, t0=0.0, t1=1.40, k=K_TAIL),
    # fin tip cap (s, arc)
    'FCAP': dict(s0=13.75, s1=15.10, t0=0.0, t1=0.55, k=K_TAIL),
    # intake duct lip (angle, depth)
    'LIP': dict(s0=0.0, s1=4.2, t0=0.0, t1=0.35, k=K_TAIL),
}

FUS_ARC_MAX = 3.85   # meters (checked in build)


def _layout():
    r = REGIONS
    fh = int(FUS_ARC_MAX * K_FUS) + 4
    r['FUS_R']['h'] = fh
    r['FUS_L']['h'] = fh
    r['FUS_L']['y0'] = 12 + fh + 14
    y = r['FUS_L']['y0'] + fh + 14
    # wings row
    ww = int((11.0 - 6.75) * K_WING) + 2
    wh = int((4.66 - 0.78) * K_WING) + 2
    x = 12
    for n in ('WU_R', 'WU_L', 'WL_R', 'WL_L'):
        r[n].update(x0=x, y0=y, w=ww, h=wh)
        x += ww + 10
    y += wh + 14
    # stabs row + right fin
    sw = int((14.62 - 12.05) * K_TAIL) + 2
    sh = int((1.80 + 0.02) * K_TAIL) + 2
    x = 12
    for n in ('SU_R', 'SU_L', 'SL_R', 'SL_L'):
        r[n].update(x0=x, y0=y, w=sw, h=sh)
        x += sw + 10
    fw = int((15.10 - 11.30) * K_TAIL) + 2
    fhh = int((5.24 - 2.88) * K_TAIL) + 2
    r['FIN_R'].update(x0=x, y0=y, w=fw, h=fhh)
    y2 = y + sh + 14
    r['FIN_L'].update(x0=12, y0=y2, w=fw, h=fhh)
    # misc blocks right of FIN_L
    x = 12 + fw + 12
    yy = y2
    dw = int((14.05 - 8.9) * K_TAIL) + 2
    dh = int(1.05 * K_TAIL) + 2
    r['DORSAL'].update(x0=x, y0=yy, w=dw, h=dh)
    yy += dh + 10
    vw = int((11.95 - 10.40) * K_TAIL) + 2
    vh = int((1.30 - 0.50) * K_TAIL) + 2
    xx = x
    for n in ('VF_RO', 'VF_RI', 'VF_LO', 'VF_LI'):
        r[n].update(x0=xx, y0=yy, w=vw, h=vh)
        xx += vw + 8
    yy += vh + 10
    cw = int((6.40 - 2.70) * K_TAIL) + 2
    ch = int(1.40 * K_TAIL) + 2
    r['CANF'].update(x0=x, y0=yy, w=cw, h=ch)
    xx = x + cw + 10
    bw = int((14.30 - 13.30) * K_TAIL) + 2
    bh = int((1.10 - 0.60) * K_TAIL) + 2
    r['SB'].update(x0=xx, y0=yy, w=bw, h=bh, n=8)   # 8 faces stacked 2x4
    r['FCAP'].update(x0=xx, y0=yy + 2 * (bh + 6) + 8, w=int(1.35 * K_TAIL) + 2, h=int(0.55 * K_TAIL) + 2)
    r['LIP'].update(x0=xx + 4 * (bw + 6) + 10, y0=yy, w=int(4.2 * K_TAIL) + 2, h=int(0.35 * K_TAIL) + 2)
    return r


_layout()


def sb_cell(i):
    """Pixel origin of speedbrake face cell i (0..7)."""
    r = REGIONS['SB']
    bw, bh = r['w'], r['h']
    return r['x0'] + (i % 4) * (bw + 6), r['y0'] + (i // 4) * (bh + 6)


def px_to_uv(px, py):
    return (px / W, 1.0 - py / H)


def fus_px(side, s, arc):
    r = REGIONS['FUS_' + side]
    k = r['k']
    if side == 'R':
        x = r['x0'] + (S_FUS1 - s) * k
    else:
        x = r['x0'] + (s - S_FUS0) * k
    return x, r['y0'] + arc * k


def fus_uv(side, s, arc):
    return px_to_uv(*fus_px(side, s, arc))


def planar_px(name, s, t, flip_s=False, flip_t=False):
    """Generic planar region: x along s (or reversed), y along t (t1 at the top unless flip_t)."""
    r = REGIONS[name]
    k = r['k']
    x = r['x0'] + ((r['s1'] - s) if flip_s else (s - r['s0'])) * k
    y = r['y0'] + ((t - r['t0']) if flip_t else (r['t1'] - t)) * k
    return x, y


def planar_uv(name, s, t, flip_s=False, flip_t=False):
    return px_to_uv(*planar_px(name, s, t, flip_s, flip_t))


# conventions per region (used by both the UV assignment and the painter):
#   WU_*: seen from above, nose up... we keep: x along s (nose left), y from tip (top) to root (bottom) for the right
#         wing and mirrored (flip_t) for the left, so both wings' upper textures are drawn in plan view orientation.
PLANAR_FLIPS = {
    'WU_R': (False, False), 'WU_L': (False, True),
    'WL_R': (False, True), 'WL_L': (False, False),
    'SU_R': (False, False), 'SU_L': (False, True),
    'SL_R': (False, True), 'SL_L': (False, False),
    'FIN_R': (True, False), 'FIN_L': (False, False),
    'VF_RO': (True, False), 'VF_RI': (False, False), 'VF_LO': (False, False), 'VF_LI': (True, False),
    'DORSAL': (False, True), 'CANF': (False, True), 'FCAP': (False, True), 'LIP': (False, True),
}


def region_uv(name, s, t):
    fs, ft = PLANAR_FLIPS.get(name, (False, False))
    return planar_uv(name, s, t, fs, ft)


def check():
    boxes = []
    for n, r in REGIONS.items():
        if n.startswith('FUS'):
            w = int((S_FUS1 - S_FUS0) * r['k']) + 2
            h = r['h'] if 'h' in r else REGIONS['FUS_R']['h']
            boxes.append((n, r['x0'], r['y0'], r['x0'] + w, r['y0'] + h))
        elif n == 'SB':
            x0, y0 = sb_cell(0)
            x1, y1 = sb_cell(7)
            boxes.append((n, x0, y0, x1 + r['w'], y1 + r['h']))
        else:
            boxes.append((n, r['x0'], r['y0'], r['x0'] + r['w'], r['y0'] + r['h']))
    bad = []
    for i, a in enumerate(boxes):
        if a[3] > W or a[4] > H:
            bad.append(('out', a))
        for b in boxes[i + 1:]:
            if a[1] < b[3] and b[1] < a[3] and a[2] < b[4] and b[2] < a[4]:
                bad.append(('overlap', a[0], b[0]))
    return boxes, bad


if __name__ == '__main__':
    boxes, bad = check()
    for b in boxes:
        print(b)
    print('problems:', bad)
