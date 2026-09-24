"""İstanbul skyscrapers: simplified but recognizable towers (Levent–Maslak–Şişli, Ataşehir, the western towers).

Run through monuments.py (ids skyline_levent / skyline_atasehir / skyline_west). Every tower of a group is merged into
two meshes per LOD: `glass` (one shared curtain-wall texture, neutral grey, tinted per tower with vertex colours: blue-green,
silver, dark, bronze …) and `solid` (flat white × vertex colour: crowns, fins, spires, podiums, roofs). Footprints and
positions come from OSM (tools/geo/landmarks_ist_layout.py → layout.json `skyline`); heights and forms of the named towers
from public sources (see SPECS and CONTRACTS-IST.md §6.L). Unnamed towers ≥ 150 m keep their OSM footprint with a plant
storey. Collision: an oriented box per tower body (to the roof), extra boxes / capsules for crowns and spires.

Frame: model = world axes (heading 0), +X east, +Y north, +Z up (m MSL); per-tower ground anchors (_ANCHOR).
"""
import math

import numpy as np
from istkit import obb, ccw, V, lin

TILE_U, TILE_V = 12.0, 16.0      # curtain-wall texture: 4 panes × 4 floors per tile = 12 m × 16 m


def hexcol(h, k=1.0):
    c = lin(h)
    return (min(1.0, c[0] * k), min(1.0, c[1] * k), min(1.0, c[2] * k))


# ---------------------------------------------------------------------------------------------------------- plan helpers
def offset_poly(P, d):
    """Mitred inward offset by d m (d < 0: outward) of a CCW polygon (convex or mildly concave)."""
    P = ccw(P)
    n = len(P)
    out = []
    for i in range(n):
        a, b, c = np.array(P[i - 1], float), np.array(P[i], float), np.array(P[(i + 1) % n], float)
        e1, e2 = b - a, c - b
        n1 = np.array([-e1[1], e1[0]]) / max(np.hypot(*e1), 1e-9)
        n2 = np.array([-e2[1], e2[0]]) / max(np.hypot(*e2), 1e-9)
        m = n1 + n2
        m = m / max(np.hypot(*m), 1e-9)
        cosh = max(0.35, float(np.dot(m, n1)))
        out.append(tuple(b + m * (d / cosh)))
    return out


def chamfer_poly(P, k):
    """Cut every corner sharper than 150° by k m along both edges."""
    P = ccw(P)
    n = len(P)
    out = []
    for i in range(n):
        a, b, c = np.array(P[i - 1], float), np.array(P[i], float), np.array(P[(i + 1) % n], float)
        u1, u2 = (a - b), (c - b)
        l1, l2 = np.hypot(*u1), np.hypot(*u2)
        cosang = float(np.dot(u1, u2) / max(l1 * l2, 1e-9))
        if cosang > -0.87 and l1 > 2.5 * k and l2 > 2.5 * k:
            out += [tuple(b + u1 / l1 * k), tuple(b + u2 / l2 * k)]
        else:
            out.append(tuple(b))
    return out


def rect(cx, cy, w, d, rot):
    c, s = math.cos(rot), math.sin(rot)
    return [(cx + x * c - y * s, cy + x * s + y * c) for x, y in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2))]


def simplify_poly(P, tol):
    """Douglas–Peucker on a closed ring (drops collinear / tiny steps); keeps >= 4 vertices."""
    P = [tuple(p) for p in P]
    if len(P) <= 4 or tol <= 0:
        return P
    keep = [True] * len(P)
    changed = True
    while changed and sum(keep) > 4:
        changed = False
        idx = [i for i, k in enumerate(keep) if k]
        best, bi = None, None
        for j, i in enumerate(idx):
            a, b, c = np.array(P[idx[j - 1]]), np.array(P[i]), np.array(P[idx[(j + 1) % len(idx)]])
            d = c - a
            L = np.hypot(*d) or 1e-9
            dist = abs(d[0] * (b[1] - a[1]) - d[1] * (b[0] - a[0])) / L
            if best is None or dist < best:
                best, bi = dist, i
        if best is not None and best < tol:
            keep[bi] = False
            changed = True
    return [p for p, k in zip(P, keep) if k]


# ---------------------------------------------------------------------------------------------------------- mesh helpers
def walls(mb, P, zb, ztop, col, g, u0=0.0, inward=False):
    """Vertical walls of a CCW polygon from zb to ztop (a number or f(x, y) for sloped tops); curtain-wall UVs.
    inward: faces toward the inside (inner face of a crown ring)."""
    P = ccw(P)
    if inward:
        P = P[::-1]
    per = u0
    zt = ztop if callable(ztop) else (lambda x, y: ztop)
    n = len(P)
    for i in range(n):
        a, c = P[i], P[(i + 1) % n]
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        if L < 1e-3:
            continue
        za, zc = zt(*a), zt(*c)
        mb.quad((a[0], a[1], zb), (c[0], c[1], zb), (c[0], c[1], zc), (a[0], a[1], za),
                uv=[(per / TILE_U, (zb - g) / TILE_V), ((per + L) / TILE_U, (zb - g) / TILE_V),
                    ((per + L) / TILE_U, (zc - g) / TILE_V), (per / TILE_U, (za - g) / TILE_V)], col=col)
        per += L
    return per


def cap(mb, P, z, col):
    zf = z if callable(z) else (lambda x, y: z)
    mb.polygon([(p[0], p[1], zf(*p)) for p in ccw(P)], col=col)


def pyramid(mb, P, z0, apex, col):
    """Roof from a footprint to an apex (x, y, z) (pointed crown / hipped glass top)."""
    P = ccw(P)
    n = len(P)
    for i in range(n):
        a, c = P[i], P[(i + 1) % n]
        mb.tri((a[0], a[1], z0), (c[0], c[1], z0), apex, col=col)


def frustum(mb, P0, P1, z0, z1, col, g=0.0, uv=True):
    """Loft between two outlines with the same vertex count (tapering tiers)."""
    P0, P1 = ccw(P0), ccw(P1)
    n = len(P0)
    per = 0.0
    for i in range(n):
        a0, c0, a1, c1 = P0[i], P0[(i + 1) % n], P1[i], P1[(i + 1) % n]
        L = math.hypot(c0[0] - a0[0], c0[1] - a0[1])
        u = [(per / TILE_U, (z0 - g) / TILE_V), ((per + L) / TILE_U, (z0 - g) / TILE_V),
             ((per + L) / TILE_U, (z1 - g) / TILE_V), (per / TILE_U, (z1 - g) / TILE_V)] if uv else None
        mb.quad((a0[0], a0[1], z0), (c0[0], c0[1], z0), (c1[0], c1[1], z1), (a1[0], a1[1], z1), uv=u, col=col)
        per += L


def mast(mb, x, y, z0, h, r0, r1, sides, col):
    mb.cylinder((x, y, z0), r0, h, sides=sides, r_top=r1, cap_top=True, col=col, smooth=False)


# ---------------------------------------------------------------------------------------------------------- tower specs
# roof / tip in m above ground; glass / solid tints (sRGB hex; vertex colours on the shared materials). Sources: CTBUH
# Skyscraper Center (skyscrapercenter.com/city/istanbul), Wikipedia (EN/TR), the architects; plans / positions from OSM.
BLUE, BLUEGREEN, SILVER, DARK, GREEN, WHITE = '#86A7BC', '#8DB4BB', '#D2D8DC', '#5E6B78', '#9CC4B2', '#F4F4F0'
SPECS = {
    # İstanbul Sapphire (Tabanlıoğlu, 2010): roof 234.85 m, spire (design element) to 261 m; 26.5 × 48 m slab, the roof
    # a single pitch across the short axis rising to the spire corner; dark blue-grey double-skin glass
    'sapphire': dict(form='slant', roof=(224.0, 238.0), rise=0.0, tip=261.0, glass='#6F8494', solid='#C9CED2'),
    # İş Bankası Tower 1 (2000): 52 floors, roof 181.2 m, flagpole 194.6 m; stepped setbacks at floors 42–52 (OSM parts)
    # and a pointed pyramid crown; blue-grey glass / metal
    'isbank1': dict(form='steps', floor=3.48, roof=181.2, crown=7.5, tip=194.6, glass='#7D93A6', solid='#B9C1C8'),
    # İş Bankası Towers 2 / 3: 118 m, 36 floors; top floors set back under a dark bronze hipped cap
    'isbank2': dict(form='hipcap', roof=108.0, setback=113.0, cap=118.0, glass='#7D93A6', solid='#5A4A3C'),
    'isbank3': dict(form='hipcap', roof=108.0, setback=113.0, cap=118.0, glass='#7D93A6', solid='#5A4A3C'),
    # Kanyon office tower (Jerde / Tabanlıoğlu 2006): 118 m, rounded "D" plan, flat roof with an open ring crown
    'kanyon': dict(form='ring', roof=112.0, ring=118.0, glass='#62778A', solid='#D9DCDD'),
    # MetroCity (Tekeli-Sisa 2000): office tower A (half-ellipse, blue glass, dark-blue glass cone + spire), residential
    # B / C (white, chamfered, blue glass dome); 31 / 35 floors, 133–143 m
    'metrocity_a': dict(form='dome', roof=124.0, dome=9.0, tip=143.0, glass='#7FA3C4', solid='#3E5F8A'),
    'metrocity_b': dict(form='dome', roof=128.0, dome=8.0, tip=0.0, glass=WHITE, solid='#4C6E98', chamfer=3.0),
    'metrocity_c': dict(form='dome', roof=128.0, dome=8.0, tip=0.0, glass=WHITE, solid='#4C6E98', chamfer=3.0),
    # Sabancı Center (1993): Akbank Tower 157 m / 39 floors, Sabancı Center 2 140 m / 34 floors; each a dark blue-black
    # glass half and a light grey-beige clad half interlocked, the clad core rising higher as a box crown
    'akbank': dict(form='sabanci', roof=144.0, crown=157.0, glass='#46505E', solid='#CFC8BA'),
    'sabanci2': dict(form='sabanci', roof=127.0, crown=140.0, glass='#46505E', solid='#CFC8BA'),
    # Süzer Plaza (Doruk Pamir 1998): 34 floors, 153.65 m to the antenna; slab with a steel-lattice gabled "sky cage"
    # crown, blue-green glass with red-brown bands; podium over the OSM complex outline
    'suzer': dict(form='suzer', roof=132.0, cage=144.0, tip=153.6, podium=24.0, glass='#7FAAA8', solid='#6B3B32'),
    # Zorlu Center (Emre Arolat / Tabanlıoğlu 2013): four 107 m towers, 32 floors, white / light grey bands, flat roofs
    'zorlu_a': dict(form='flat', roof=107.0, glass='#E6E8E6', solid='#D8DAD8'),
    'zorlu_b': dict(form='flat', roof=107.0, glass='#E6E8E6', solid='#D8DAD8'),
    'zorlu_c': dict(form='flat', roof=107.0, glass='#E6E8E6', solid='#D8DAD8'),
    'zorlu_h': dict(form='flat', roof=107.0, glass='#E6E8E6', solid='#D8DAD8'),
    # Trump Towers (2011): residence roof 156.3 / tip 160.9 m, office 147.2 / 151.8 m; blue-silver glass, black box
    # crowns with the lettering; the office tower widens toward the top
    'trump_res': dict(form='crownbox', roof=156.3, box=10.0, tip=160.9, glass='#A9BCCB', solid='#1E2226'),
    'trump_off': dict(form='crownbox', roof=147.2, box=10.0, tip=151.8, glass='#A9BCCB', solid='#1E2226', flare=0.9),
    # Spine Tower (2014): roof 191 m, architectural 202 m, mast 227.6 m; teardrop plan, sail-like sloping top rising to
    # the sharp corner; green-tinted glass
    'spine': dict(form='slant', roof=(187.0, 202.0), rise='sharp', tip=227.6, glass=GREEN, solid='#C8CDCF'),
    # Skyland İstanbul (2017): twin 284 m towers (65 / 64 floors), rounded wedge plans, grey-silver glass with vertical
    # fins, a darker band at mid-height, flat tops
    'skyland_off': dict(form='flat', roof=284.0, band=(136.0, 146.0), glass='#BCC6CC', solid='#7C8790'),
    'skyland_res': dict(form='flat', roof=284.0, band=(136.0, 146.0), glass='#BCC6CC', solid='#7C8790'),
    # ÖzdilekPark İstanbul (2014): two towers of 32 storeys (≈150 m; CTBUH 170 / 148 m, Wikipedia 156 / 137 m), blue-green
    # glass in beige stone frames, flat helipad canopies; 6-floor mall podium (the OSM height tags are elevations)
    'ozdilek_e': dict(form='flat', roof=152.0, canopy=True, glass='#8DB4BB', solid='#D6CDB9'),
    'ozdilek_w': dict(form='flat', roof=148.0, canopy=True, glass='#8DB4BB', solid='#D6CDB9'),
    'ozdilek_mall': dict(form='podium', roof=30.0, solid='#D6CDB9'),
    # TCMB (CBRT) Tower (Vizzion 2024): 62 floors, roof 330 m, spire tip 353.9 m; chamfered square, tiered setbacks,
    # steep green-glass pyramid crown; beige-grey stone piers with green glass
    'tcmb': dict(form='tcmb', roof=292.0, crown=330.0, tip=353.9, glass='#A8BCA8', solid='#9FC0A8'),
    # Metropol İstanbul A (RMJM 2017): roof 280 m, twin needle spires to 301 m; blue glass with white bands
    'metropol_a': dict(form='flat', roof=280.0, twin=301.0, glass='#7C9FC4', solid='#E8ECEE'),
    # İstanbul Finans Merkezi bank towers (2023): Vakıfbank 221.3 m, Ziraat I 219.2 m (roof 203.4), Ziraat II 193.5 m,
    # Halkbank 208 m
    'vakif1': dict(form='flat', roof=221.3, glass='#9DB3C2', solid='#C9CFD3'),
    'ziraat1': dict(form='flat', roof=203.4, tip=219.2, glass='#A6B9C4', solid='#C9CFD3'),
    'ziraat2': dict(form='flat', roof=193.5, glass='#A6B9C4', solid='#C9CFD3'),
    'halk1': dict(form='flat', roof=208.0, glass='#8FAAC0', solid='#C9CFD3'),
    # Varyap Meridian Grand Tower A (RMJM 2012): 188.4 m, 52 floors, boomerang plan, silver-white glass
    'varyap_a': dict(form='flat', roof=188.4, glass=SILVER, solid='#E0E3E5'),
}
GENERIC_TINTS = [BLUE, SILVER, BLUEGREEN, '#A8B4BE', '#97A9B0']


def plan(P, lod, tol=(0.35, 1.5, 4.0)):
    Q = simplify_poly([tuple(p) for p in P[:-1]] if tuple(P[0]) == tuple(P[-1]) else [tuple(p) for p in P], tol[min(lod, 2)])
    return ccw(Q)


def tower(b, bl, lod, idx, anchored):
    """One tower into b['sky_glass'] / b['sky_solid'] (vertex-tinted); collision + lights on LOD0 meta."""
    key = bl.get('key')
    sp = SPECS.get(key) if key else None
    g = bl['g']
    P0 = plan(bl['poly'], lod)
    cx, cy, ang, hl, hs = obb(P0)
    G, S = anchored(b, 'sky_glass'), anchored(b, 'sky_solid')
    if sp is None:
        sp = dict(form='generic', roof=float(bl['height']), glass=GENERIC_TINTS[idx % len(GENERIC_TINTS)], solid='#C4C9CC')
    gc, sc = hexcol(sp['glass'] if 'glass' in sp else sp['solid']), hexcol(sp['solid'])
    form = sp['form']
    zb = g - 5.0
    roof = sp['roof'] if not isinstance(sp['roof'], tuple) else max(sp['roof'])
    top = g + roof
    coll = []                                  # extra collision: ('cap', a, b, r) / ('box', poly, z0, z1)

    if lod == 2:
        # far LOD: oriented box (+ the sloped / pointed top of the crowned towers); low towers dropped
        if roof < 150.0:
            return top
        R = rect(cx, cy, 2 * hl, 2 * hs, ang)
        if form == 'slant':
            lo, hi = sp['roof']
            walls(G, R, zb, g + (lo + hi) / 2, gc, g)
            cap(S, R, g + (lo + hi) / 2, sc)
        elif form in ('steps', 'tcmb'):
            base = g + (sp['roof'] if form == 'tcmb' else sp['roof'] - 25.0)
            walls(G, R, zb, base, gc, g)
            pyramid(S if form == 'tcmb' else G, rect(cx, cy, 1.4 * hl, 1.4 * hs, ang), base,
                    (cx, cy, g + (sp['crown'] if form == 'tcmb' else sp['roof'] + sp['crown'])), sc if form == 'tcmb' else gc)
            cap(S, R, base, sc)
        else:
            walls(G, R, zb, g + roof, gc, g)
            cap(S, R, g + roof, sc)
        return top
    if sp.get('chamfer') and lod < 2:
        P0 = chamfer_poly(P0, sp['chamfer'])
    if form == 'podium':
        walls(S, P0, zb, g + roof, sc, g)
        cap(S, P0, g + roof, sc)
    elif form in ('flat', 'generic'):
        z1 = g + roof
        if sp.get('band') and lod < 2:
            b0, b1 = sp['band']
            walls(G, P0, zb, g + b0, gc, g)
            walls(G, P0, g + b0, g + b1, hexcol(sp['solid']), g)
            walls(G, P0, g + b1, z1, gc, g)
        else:
            walls(G, P0, zb, z1, gc, g)
        if lod < 2:
            inner = offset_poly(P0, min(hs * 0.18, 3.0))
            walls(S, inner, z1, z1 + min(5.0, roof * 0.025), sc, g)
            cap(S, inner, z1 + min(5.0, roof * 0.025), sc)
            cap(S, P0, z1, sc)
            top = z1 + min(5.0, roof * 0.025)
            if sp.get('canopy'):
                big = offset_poly(P0, -2.5)
                S.polygon([(p[0], p[1], top + 2.0) for p in big], col=sc)
                S.polygon([(p[0], p[1], top + 1.4) for p in big[::-1]], col=sc)
                top += 2.0
        else:
            cap(S, P0, z1, sc)
        if sp.get('twin'):
            u = V(math.cos(ang), math.sin(ang), 0)
            for sgn in (-1, 1):
                p = V(cx, cy, 0) + u * (sgn * hl * 0.55)
                if lod < 2:
                    mast(S, p[0], p[1], top, sp['twin'] - (top - g), 1.2, 0.15, 6 if lod == 0 else 4, sc)
                coll.append(('cap', (p[0], p[1], top), (p[0], p[1], g + sp['twin']), 1.2))
            top = g + sp['twin']
    elif form == 'slant':
        lo, hi = sp['roof']
        if sp['rise'] == 'sharp':
            # rise toward the sharpest vertex of the plan (Spine Tower's teardrop point)
            best, dirv = None, None
            for i in range(len(P0)):
                a, c, d = np.array(P0[i - 1]), np.array(P0[i]), np.array(P0[(i + 1) % len(P0)])
                u1, u2 = a - c, d - c
                cosang = float(np.dot(u1, u2) / max(np.hypot(*u1) * np.hypot(*u2), 1e-9))
                if best is None or cosang > best:
                    best, dirv = cosang, c - np.array([cx, cy])
            dirv = dirv / max(np.hypot(*dirv), 1e-9)
        else:
            # across the short axis (rise = rotation in degrees from the short axis)
            a0 = ang + math.pi / 2 + math.radians(sp['rise'])
            dirv = np.array([math.cos(a0), math.sin(a0)])
        proj = [float(np.dot(np.array(p) - np.array([cx, cy]), dirv)) for p in P0]
        pmin, pmax = min(proj), max(proj)

        def zf(x, y):
            t = (float(np.dot(np.array([x, y]) - np.array([cx, cy]), dirv)) - pmin) / max(pmax - pmin, 1e-6)
            return g + lo + (hi - lo) * t
        walls(G, P0, zb, zf, gc, g)
        cap(S, P0, zf, sc)
        hp = np.array([cx, cy]) + dirv * (pmax * 0.72)
        if sp.get('tip') and lod < 2:
            z0 = zf(*hp)
            mast(S, hp[0], hp[1], z0 - 1.0, g + sp['tip'] - z0 + 1.0, 1.6 if key == 'spine' else 1.1, 0.2, 6 if lod == 0 else 4, sc)
        if sp.get('tip'):
            coll.append(('cap', (hp[0], hp[1], g + lo), (hp[0], hp[1], g + sp['tip']), 1.6))
        top = g + (sp.get('tip') or hi)
        roof = hi
    elif form == 'steps':
        # OSM setback parts (levels) as tiers; the last one carries a pointed pyramid + flagpole
        tiers = [(plan(p['poly'], lod), (p['levels'] or 40) * sp['floor']) for p in bl.get('parts', [])]
        tiers.sort(key=lambda t: t[1])
        if lod == 1:
            tiers = tiers[::2] + ([tiers[-1]] if len(tiers) % 2 == 0 else [])
        elif lod == 2:
            tiers = tiers[-1:]
        h0 = tiers[0][1] if tiers else sp['roof']
        walls(G, P0, zb, g + h0 * 0.985, gc, g)
        cap(S, P0, g + h0 * 0.985, sc)
        for k, (Pt, zt) in enumerate(tiers):
            zlo = g + (tiers[k - 1][1] if k else h0 * 0.985)
            walls(G, Pt, zlo, g + zt, gc, g)
            cap(S, Pt, g + zt, sc)
        Pl = tiers[-1][0] if tiers else P0
        lx, ly, _, lhl, lhs = obb(Pl)
        zr = g + (tiers[-1][1] if tiers else sp['roof'])
        pyramid(G, Pl, zr, (lx, ly, zr + sp['crown']), gc)
        if lod < 2:
            mast(S, lx, ly, zr + sp['crown'] - 1.0, g + sp['tip'] - (zr + sp['crown']) + 1.0, 0.35, 0.08, 4, sc)
        coll.append(('cap', (lx, ly, zr), (lx, ly, zr + sp['crown']), max(lhl, lhs) * 0.6))
        coll.append(('cap', (lx, ly, zr + sp['crown']), (lx, ly, g + sp['tip']), 0.6))
        top = g + sp['tip']
        roof = h0
    elif form == 'hipcap':
        parts = bl.get('parts', [])
        Pi = plan(parts[0]['poly'], lod) if parts else offset_poly(P0, 4.0)
        walls(G, P0, zb, g + sp['roof'], gc, g)
        cap(S, P0, g + sp['roof'], sc)
        walls(G, Pi, g + sp['roof'], g + sp['setback'], gc, g)
        ix, iy, _, ihl, ihs = obb(Pi)
        pyramid(S, Pi, g + sp['setback'], (ix, iy, g + sp['cap']), sc)
        coll.append(('cap', (ix, iy, g + sp['roof']), (ix, iy, g + sp['cap']), max(ihl, ihs) * 0.8))
        top = g + sp['cap']
    elif form == 'ring':
        z1 = g + sp['roof']
        walls(G, P0, zb, z1, gc, g)
        cap(S, P0, z1, sc)
        if lod < 2:
            # open ring crown: outer and inner face of a 1.6 m band above the roof
            walls(S, offset_poly(P0, -0.4), z1 - 1.0, g + sp['ring'], sc, g)
            walls(S, offset_poly(P0, 1.2), z1, g + sp['ring'], sc, g, inward=True)
        top = g + sp['ring']
    elif form == 'dome':
        z1 = g + sp['roof']
        walls(G, P0, zb, z1, gc, g)
        cap(S, P0, z1, sc)
        r0 = min(hl, hs) * 0.62
        n = {0: 12, 1: 8, 2: 6}[lod]
        rings_z = [(r0, 0.0), (r0 * 0.92, sp['dome'] * 0.45), (r0 * 0.65, sp['dome'] * 0.8), (0.0, sp['dome'])] if lod < 2 else \
            [(r0, 0.0), (r0 * 0.6, sp['dome'] * 0.75), (0.0, sp['dome'])]
        for (ra, za), (rb, zb2) in zip(rings_z[:-1], rings_z[1:]):
            if rb > 0:
                frustum(S, [(cx + ra * math.cos(t), cy + ra * math.sin(t)) for t in np.linspace(0, 2 * math.pi, n + 1)[:-1]],
                        [(cx + rb * math.cos(t), cy + rb * math.sin(t)) for t in np.linspace(0, 2 * math.pi, n + 1)[:-1]],
                        z1 + za, z1 + zb2, sc, uv=False)
            else:
                pyramid(S, [(cx + ra * math.cos(t), cy + ra * math.sin(t)) for t in np.linspace(0, 2 * math.pi, n + 1)[:-1]],
                        z1 + za, (cx, cy, z1 + zb2), sc)
        top = z1 + sp['dome']
        if sp.get('tip'):
            if lod < 2:
                mast(S, cx, cy, top - 0.5, g + sp['tip'] - top + 0.5, 0.45, 0.08, 4, sc)
            coll.append(('cap', (cx, cy, z1), (cx, cy, g + sp['tip']), 1.0))
            top = g + sp['tip']
        coll.append(('cap', (cx, cy, z1), (cx, cy, z1 + sp['dome']), r0))
    elif form == 'sabanci':
        parts = bl.get('parts', [])
        halves = [P0] + [plan(p['poly'], lod) for p in parts if (p['levels'] or 0) < 36]
        core = [plan(p['poly'], lod) for p in parts if (p['levels'] or 0) >= 36]
        for k, Ph in enumerate(halves[:2]):
            col = gc if k == 0 else sc
            walls(G if k == 0 else S, Ph, zb, g + sp['roof'], col, g)
            cap(S, Ph, g + sp['roof'], sc)
        for Pc in core[:1]:
            walls(S, Pc, g + sp['roof'] - 2.0, g + sp['crown'], sc, g)
            cap(S, Pc, g + sp['crown'], sc)
            kx, ky, _, khl, khs = obb(Pc)
            coll.append(('box', Pc, g + sp['roof'], g + sp['crown']))
        top = g + sp['crown']
    elif form == 'suzer':
        # tower slab inside the complex outline (the OSM way covers slab + podium): ≈ 46 × 24 m on the outline's axes
        podium = P0
        walls(S, podium, zb, g + sp['podium'], hexcol('#C9C2B6'), g)
        cap(S, podium, g + sp['podium'], hexcol('#B9B2A6'))
        slab = rect(cx, cy, 46.0, 24.0, ang)
        walls(G, slab, g + sp['podium'] - 1.0, g + sp['roof'], gc, g)
        cap(S, slab, g + sp['roof'], sc)
        # lattice "sky cage": a gabled frame over the roof (open gable ends) + antenna
        u, w = V(math.cos(ang), math.sin(ang), 0), V(-math.sin(ang), math.cos(ang), 0)
        c = V(cx, cy, 0)
        z1, z2 = g + sp['roof'], g + sp['cage']
        A, B = c - u * 23.0, c + u * 23.0
        for sgn in (-1, 1):
            e0, e1 = A + w * (sgn * 12.0), B + w * (sgn * 12.0)
            quad = [(e0[0], e0[1], z1), (e1[0], e1[1], z1), (B[0], B[1], z2), (A[0], A[1], z2)]
            S.quad(*(quad if sgn > 0 else quad[::-1]), col=sc)
            S.quad(*(quad[::-1] if sgn > 0 else quad), col=sc)
        if lod < 2:
            mast(S, cx, cy, z2 - 1.0, g + sp['tip'] - z2 + 1.0, 0.5, 0.1, 4, hexcol('#D0D0D0'))
        coll.append(('box', slab, z1, z2))
        coll.append(('cap', (cx, cy, z2), (cx, cy, g + sp['tip']), 0.8))
        top = g + sp['tip']
        roof = sp['roof']
        P0 = podium
    elif form == 'crownbox':
        z1 = g + sp['roof'] - sp['box']
        if sp.get('flare') and lod < 2:
            Pn = [(cx + (p[0] - cx) * sp['flare'], cy + (p[1] - cy) * sp['flare']) for p in P0]
            walls(G, Pn, zb, g + sp['roof'] * 0.45, gc, g)
            frustum(G, Pn, P0, g + sp['roof'] * 0.45, z1, gc, g)
        else:
            walls(G, P0, zb, z1, gc, g)
        walls(S, P0, z1, g + sp['roof'], sc, g)
        cap(S, P0, g + sp['roof'], sc)
        if lod < 2:
            mast(S, cx, cy, g + sp['roof'] - 0.5, sp['tip'] - sp['roof'] + 0.5, 0.35, 0.08, 4, sc)
        coll.append(('cap', (cx, cy, g + sp['roof']), (cx, cy, g + sp['tip']), 0.6))
        top = g + sp['tip']
    elif form == 'tcmb':
        # tiered setbacks: body to 250 m, two tiers, a steep green-glass pyramid crown, spire
        t1, t2 = g + sp['roof'] - 42.0, g + sp['roof'] - 18.0
        walls(G, P0, zb, t1, gc, g)
        P1 = offset_poly(P0, 4.5)
        P2 = offset_poly(P0, 9.5)
        cap(S, P0, t1, hexcol('#CFC7B6'))
        walls(G, P1, t1, t2, gc, g)
        cap(S, P1, t2, hexcol('#CFC7B6'))
        walls(G, P2, t2, g + sp['roof'], gc, g)
        x2, y2, _, hl2, hs2 = obb(P2)
        pyramid(S, P2, g + sp['roof'], (x2, y2, g + sp['crown']), sc)
        if lod < 2:
            mast(S, x2, y2, g + sp['crown'] - 1.0, sp['tip'] - sp['crown'] + 1.0, 0.8, 0.12, 6 if lod == 0 else 4, hexcol('#D8DCDC'))
        coll.append(('box', P2, g + sp['roof'] - 42.0, g + sp['roof']))
        coll.append(('cap', (x2, y2, g + sp['roof']), (x2, y2, g + sp['crown']), max(hl2, hs2) * 0.55))
        coll.append(('cap', (x2, y2, g + sp['crown']), (x2, y2, g + sp['tip']), 1.0))
        top = g + sp['tip']
        roof = sp['roof'] - 42.0
    # ---- collision: body box on the OBB to the (highest) roof, extra primitives, red light at the top
    if b.meta:
        body_top = g + (roof if not isinstance(roof, tuple) else max(roof))
        if form == 'suzer':
            body_top = g + sp['podium']
        b.meta.box((cx - hl, cy - hs, g - 5.0), (cx + hl, cy + hs, body_top), b.name, ang)
        for c in coll:
            if c[0] == 'cap':
                b.meta.capsule(c[1], c[2], c[3], b.name, True)
            else:
                qx, qy, qa, qhl, qhs = obb(c[1])
                b.meta.box((qx - qhl, qy - qhs, c[2]), (qx + qhl, qy + qhs, c[3]), b.name, qa)
    b.light((cx, cy, top + 1.0), '#ff2a14', size=6.0, period=1.5 if top - g > 200 else 0, phase=(idx * 0.37) % 1)
    return top
