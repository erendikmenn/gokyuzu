"""İstanbul bridges (Boğaz + Haliç): parametric suspension / hybrid / cable-stayed / girder / bascule generator.

Run:  blender -b -P blender/landmarks_ist/bridges.py [-- bogazici fsm yss halic_metro halic_bridge galata_bridge ataturk_bridge]
Outputs: assets/ist/landmarks/<id>{,_lod1,_lod2}.glb + <id>.json (collision, lights, traffic lanes, LODs, and a `bridge`
block with the deck-underside profile that tools/geo/landmarks_ist_index.py copies into data/ist/bridges.json).

Frame: origin = main-span centre at mean sea level (straight bridges: midpoint of the two towers from OSM), +Y along the
axis toward the eastern / Asian end (layout.json heading), +X to the right, +Z up (m MSL). Positions, axes, deck ends
and the ground profile under the deck come from OSM + Copernicus DEM (tools/geo/landmarks_ist_layout.py).

Public figures used (see CONTRACTS-IST.md §6 Landmarks for sources):
  15 Temmuz Şehitler (Boğaziçi) 1973: main span 1074 m, side spans on piers (Ortaköy 40+3×45+56 = 231 m, Beylerbeyi
    4×63.75 = 255 m; steel box girders on columns, not suspended), steel towers 165 m, legs 5.2→3.0 × 7.0 m, 3 portal
    beams (under the deck, mid-height, top; OSM building:part 50–55 / 120–125 / 152–157 m), deck box 28 × 3 m +
    walkways = 33.4 m, clearance 64 m at mid-span on a 17 900 m crest curve (≈56 m at the towers), cables 0.58 m, sag
    93 m (≈1:11.5), anchor blocks at the ends of the side viaducts (≈50 m elevation), 59 clamps at 17.9 m per cable.
    Hangers: VERTICAL since the 2013–2019 IHI retrofit (the 1973 inclined zig-zag hangers were re-hung vertically: TR /
    JA Wikipedia, MLIT JAPAN Construction International Award 2021) — twin ropes per clamp. Light grey-white paint.
  Fatih Sultan Mehmet 1988: main span 1090 m (only the main span suspended), towers on the slopes (base ≈ deck level,
    top ≈ 165 m MSL; 98 m above the road), legs 5.0→3.0 × 4.0 m, 2 portal beams (mid-height above the deck and the
    top, none under the deck), deck box 33.8 × 3 m + walkways = 39.4 m, clearance 64 m, vertical twin hangers (76 mm)
    at 17.92 m, anchorages 210 m behind the towers (1510 m between anchorages) (KGM project sheets, DE Wikipedia).
  Yavuz Sultan Selim 2016: 378 + 1408 + 378 m hybrid cable-stayed suspension, A-shaped concrete towers ≈330 m MSL,
    crossbeam at 61 m, upper steel beam ≈268 m, deck 58.5 m wide, 5.5 m deep (underside ≈73 m at mid-span, ≈70 m at
    the towers), 22 + 22 stays per leg anchored 208–304 m, main cable saddles ≈305 m, low point ≈90 m, 34 pairs of
    vertical hangers at ≈24 m in the central ±396 m, rail in the middle.
  Haliç Metro 2014: 180 m main span, 90 m side spans, two "horn" pylons 65 m, 9 harp stays per side, deck 12.6 × 4.45 m
    (rail ≈13 m), 120 m swing span.   Haliç (O-1) 1974/1998: 995 m girder viaduct, road ≈24 m.
  Galata 1994: 490 m (OSM ≈462 m), 42 m wide, bascule 80 m with 6 m clearance, lower restaurant level.
  Atatürk (Unkapanı) 1940: 477 × 25 m steel deck on pontoons.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from istkit import Build, export_landmark, LAYOUT, extrude, V, np, reset_scene, hip_roof  # noqa: E402
from bridgekit import DeckPath, box_girder, column  # noqa: E402

BR = LAYOUT['bridges']
AO = (0.5, 0.5, 0.52)          # vertex-colour shade of girder webs / undersides (sky occlusion)


def ground_fn(br):
    g = np.array(br['ground'], float)
    return lambda s: float(np.interp(s, g[:, 0], g[:, 1]))


def stations(s0, s1, step):
    n = max(1, int(math.ceil((s1 - s0) / step)))
    return [s0 + (s1 - s0) * i / n for i in range(n + 1)]


# ================================================================================================ generic parts
class Deck:
    """A deck along a model-frame path: road top z(s), box girder under it. path: DeckPath of (x, y=s, z_top) whose
    station parameter is shifted to the model Y of the first point (straight decks: s == Y)."""

    def __init__(self, pts, road_half, walk_half, depth, bot_half=None, lanes=6, dz_top=-0.8):
        self.path = DeckPath(pts)
        self.path.s = self.path.s + self.path.p[0][1]
        self.road_half, self.walk_half, self.depth = road_half, walk_half, depth
        self.bot_half = bot_half if bot_half is not None else road_half * 0.8
        self.lanes = lanes
        self.dz_top = dz_top          # girder top below the road surface; underside = road + dz_top - depth

    def edge(self, mb, x, dz_lo, dz_hi, outward, i0=0, i1=None, ts=4.0):
        """Vertical strip at offset x between dz_lo and dz_hi, facing +X (outward=+1) or -X (-1)."""
        if outward > 0:
            self.path.strip(mb, x, x, dz_hi, dz_lo, i0=i0, i1=i1, ts=ts)
        else:
            self.path.strip(mb, x, x, dz_lo, dz_hi, i0=i0, i1=i1, ts=ts)

    def build(self, b, i0=0, i1=None, girder='paint', railing=True, split=0.0):
        """split > 0: two carriageways with a central gap of `split` m (open median, e.g. Haliç O-1)."""
        P, lod = self.path, b.lod
        i1 = len(P) - 1 if i1 is None else i1
        rh, wh = self.road_half, self.walk_half
        halves = [(-wh, -split / 2, -rh, -split / 2), (split / 2, wh, split / 2, rh)] if split else [(-wh, wh, -rh, rh)]
        dzt = self.dz_top if lod < 2 else 0.0
        for (w0, w1, r0, r1) in halves:
            P.strip(b['road'], r0, r1, 0.0, uv='road', ts=12.0, i0=i0, i1=i1)
            if w0 < r0:
                P.strip(b['concrete'], w0, r0, 0.2, i0=i0, i1=i1, ts=4.0)
            if w1 > r1:
                P.strip(b['concrete'], r1, w1, 0.2, i0=i0, i1=i1, ts=4.0)
            # fascia on both outer faces of this carriageway
            self.edge(b[girder], w0, dzt, 0.2, -1, i0, i1)
            self.edge(b[girder], w1, dzt, 0.2, +1, i0, i1)
            c, hw = (w0 + w1) / 2, (w1 - w0) / 2
            bh = hw * 0.8 if split else self.bot_half
            box_girder(b[girder], _Shift(P, c), hw - 0.3, bh, self.depth, col=AO, i0=i0, i1=i1, dz_top=dzt)
            if railing and lod == 0:
                for x in (w0 + 0.15, w1 - 0.15):
                    P.rail(b['rail'], x, 0.2, 1.4, ts=2.0, i0=i0, i1=i1)
                for x in (r0, r1):
                    if abs(x) < wh - 0.3:
                        P.strip(b['concrete'], x, x, 0.0, 0.9, i0=i0, i1=i1, ts=4.0)
                        P.strip(b['concrete'], x, x, 0.9, 0.0, i0=i0, i1=i1, ts=4.0)

    def collision(self, b, s0=None, s1=None, step=30.0, top_extra=1.4):
        if not b.meta:
            return
        P = self.path
        s0 = P.s[0] if s0 is None else s0
        s1 = P.s[-1] if s1 is None else s1
        st = stations(s0, s1, step)
        for a, c in zip(st[:-1], st[1:]):
            pa, pc = P.at(a), P.at(c)
            zt = max(pa[2], pc[2]) + top_extra
            zb = min(pa[2], pc[2]) + self.dz_top - self.depth
            m = (pa + pc) / 2
            d = pc - pa
            L = float(np.hypot(d[0], d[1]))
            b.meta.obox((m[0], m[1], (zt + zb) / 2), (d[0], d[1]), self.walk_half, L / 2 + 0.6, (zt - zb) / 2, b.name)

    def top(self, s):
        return self.path.z_at(s)

    def bottom(self, s):
        return self.path.z_at(s) + self.dz_top - self.depth


class _Shift:
    """DeckPath view with a lateral offset (for per-carriageway girders)."""

    def __init__(self, P, dx):
        self.P, self.dx = P, dx
        self.s = P.s

    def __len__(self):
        return len(self.P)

    def pt(self, i, x=0.0, dz=0.0):
        return self.P.pt(i, x + self.dx, dz)


def tube(mb, pts, r, sides):
    if len(pts) >= 2:
        mb.tube(pts, r, sides=sides, ts=4.0)


def cable_caps(b, pts, r, step_n=4):
    """Collision capsules along a cable polyline (merging every step_n points)."""
    if not b.meta:
        return
    idx = list(range(0, len(pts) - 1, step_n)) + [len(pts) - 1]
    for i, j in zip(idx[:-1], idx[1:]):
        b.ccap(pts[i], pts[j], r)


def pier(b, x, y, z_top, ground, w=4.0, d=4.0, mat='concrete', cap=None, yaw=0.0):
    column(b[mat], (x, y, 0), w, d, ground - 25.0, z_top, taper=0.0, yaw=yaw, ts=6.0)
    if b.meta:
        b.meta.box((x - w / 2, y - d / 2, ground - 25.0), (x + w / 2, y + d / 2, z_top), b.name, yaw)


def lamp_row(b, deck, s0, s1, step, x, h=10.0, arm=1.8, mat='paint'):
    """Street lamps along a deck edge: slim post + emissive head (LOD0) and glow lights (all LODs via meta)."""
    for s in np.arange(s0 + step / 2, s1, step):
        p = deck.path.at(s, x, 0.2)
        sgn = -1 if x > 0 else 1
        if b.lod == 0:
            b[mat].box((p[0] - 0.12, p[1] - 0.12, p[2]), (p[0] + 0.12, p[1] + 0.12, p[2] + h))
            b[mat].box((min(p[0], p[0] + sgn * arm) - 0.08, p[1] - 0.08, p[2] + h - 0.15),
                       (max(p[0], p[0] + sgn * arm) + 0.08, p[1] + 0.08, p[2] + h))
            b['lamp'].box((p[0] + sgn * arm - 0.35, p[1] - 0.2, p[2] + h - 0.35), (p[0] + sgn * arm + 0.35, p[1] + 0.2, p[2] + h - 0.15))
        b.light((p[0] + sgn * arm, p[1], p[2] + h - 0.3), '#ffc27a', size=5.0, period=0, intensity=0.7, kind='lamp')


def lanes(b, deck, s0, s1, n_per_dir, lane_w=3.6, x0=1.2, speed=22.0, step=12.0):
    """Traffic lanes (right-hand traffic): +Y on x > 0, -Y on x < 0."""
    if not b.meta:
        return
    st = stations(s0, s1, step)
    for k in range(n_per_dir):
        x = x0 + lane_w * (k + 0.5)
        b.meta.lane([deck.path.at(s, x, 0.0) for s in st], speed=speed - 2 * k)
        b.meta.lane([deck.path.at(s, -x, 0.0) for s in st[::-1]], speed=speed - 2 * k)


def bridge_block(br, deck, s_lo, s_hi, half, tower_top, step=25.0):
    """The `bridge` metadata block for data/ist/bridges.json (world position = main-span centre)."""
    h = br['heading']
    ox, oz = br['origin']['x'], br['origin']['z']
    cs = (s_lo + s_hi) / 2
    P = deck.path
    c = P.at(cs)
    cx = ox + c[0] * math.cos(h) + c[1] * math.sin(h)
    cz = oz + c[0] * math.sin(h) - c[1] * math.cos(h)
    deck_pts = []
    lo, hi = P.s[0] - cs, P.s[-1] - cs
    ss = [lo] + [k * step for k in range(int(math.ceil(lo / step)), int(math.floor(hi / step)) + 1) if lo < k * step < hi] + [hi]
    for sr in ss:
        s = sr + cs
        deck_pts.append({'s': round(sr, 1), 'bottom': round(deck.bottom(s), 2), 'top': round(deck.top(s) + 1.4, 2)})
    lim = max(half - 40, half * 0.5)
    mid = [d['bottom'] for d in deck_pts if abs(d['s']) <= lim]
    return {'x': round(cx, 2), 'z': round(cz, 2), 'axis': round(math.degrees(h) % 360, 3), 'half': round(half, 1),
            'deck': deck_pts, 'towerTop': round(tower_top, 1) if tower_top else None,
            'clear': round(min(mid), 1) if mid else None}


# ================================================================================================ suspension bridges
class Suspension:
    """Classic box-girder suspension bridge (15 Temmuz, FSM). spec keys: see SPEC_*."""

    def __init__(self, key, spec, lod):
        self.key, self.spec, self.lod = key, spec, lod
        self.br = BR[key]
        self.g = ground_fn(self.br)
        self.b = Build(spec['id'], spec['name'], lod)

    def road(self, s):
        sp = self.spec
        return sp['top_mid'] - s * s / (2 * sp['crest_R'])

    def build(self):
        sp, b, lod, br = self.spec, self.b, self.lod, self.br
        H = sp['half']
        s0, s1 = br['s0'], br['s1']
        step = {0: 6.0, 1: 18.0, 2: 45.0, 3: 90.0}[lod]
        deck = Deck([(0.0, s, self.road(s)) for s in stations(s0, s1, step)], sp['road_half'], sp['walk_half'],
                    sp['depth'], sp['bot_half'], sp['lanes'])
        self.deck = deck
        tm = sp.get('tower_mat', 'paint')
        deck.build(b, girder=tm)
        deck.collision(b)
        # ---- towers: tapered steel box legs (light grey-white paint), portal beams, saddle housings
        XL = sp['leg_x']
        for sc in (-H, H):
            gz = self.g(sc) if sp.get('tower_on_ground') else sp.get('tower_base', 0.0)
            zb = min(gz, self.road(sc) - sp['depth']) - 25.0
            for sx in (-1, 1):
                x = sx * XL
                w0, w1 = sp['leg_w']
                column(b[tm], (x, sc, 0), w0, sp['leg_d'], zb, sp['tower_top'], w_top=w1, d_top=sp['leg_d'] * 0.92,
                       ts=6.0, chamfer=0.6 if lod == 0 else 0.0)
                b.cbox((x - w0 / 2, sc - sp['leg_d'] / 2, zb), (x + w0 / 2, sc + sp['leg_d'] / 2, sp['tower_top'] + 0.5))
                b.light((x, sc, sp['tower_top'] + 1.0), '#ff2a14', size=6.0, period=1.5, phase=0.0 if sc < 0 else 0.75)
                b.light((x + sx * 2.0, sc, sp['tower_top'] * 0.62), '#ff2a14', size=4.0, period=1.5, phase=0.0 if sc < 0 else 0.75)
                # saddle housing
                if lod < 2:
                    b[tm].box((x - 2.2, sc - 4.6, sp['tower_top'] - 0.2), (x + 2.2, sc + 4.6, sp['tower_top'] + 2.2))
                # foundation plinth
                if lod < 3:
                    b['concrete'].box((x - 5, sc - 7, zb), (x + 5, sc + 7, max(gz, 0.0) + 3.0))
            for z0, z1 in sp['portals']:
                xi = XL - sp['leg_w'][0] * 0.4
                b[tm].box((-xi, sc - sp['leg_d'] * 0.42, z0), (xi, sc + sp['leg_d'] * 0.42, z1),
                          faces='xXyYzZ' if lod < 3 else 'yYzZ')
                b.cbox((-xi, sc - sp['leg_d'] * 0.45, z0), (xi, sc + sp['leg_d'] * 0.45, z1))
        # ---- main cables + backstays (the smooth sag is what reads from afar; beyond the runtime's rope widening
        # (≈4 km) the far LODs carry a slightly fatter tube so the curve stays about a pixel wide)
        sides = {0: 10, 1: 6, 2: 4, 3: 3}[lod]
        csteps = {0: 8.0, 1: 24.0, 2: 48.0, 3: 90.0}[lod]
        cr = {0: sp['cable_r'], 1: sp['cable_r'], 2: max(sp['cable_r'], 0.8), 3: 1.5}[lod]
        zs, zlow = sp['saddle'], sp['cable_low']
        a_s0, a_s1 = sp['anchor_s']
        self.cables = {}
        for sx in (-1, 1):
            xc = sx * sp['cable_x']
            pts = [V(xc, s, zlow + (zs - zlow) * (s / H) ** 2) for s in stations(-H, H, csteps)]
            tube(b['cable'], pts, cr, sides)
            cable_caps(b, pts, 1.2, 3 if lod == 0 else 1)
            self.cables[sx] = pts
            for sc, sa in ((-H, a_s0), (H, a_s1)):
                za = self.anchor_z(sa)
                bs = [V(xc, sc, zs), V(xc, sa, za)]
                tube(b['cable'], bs, cr * 1.03, sides)
                b.ccap(bs[0], bs[1], 1.2)
        # anchorages: a concrete block per cable beside the approach road at the end of the side span (≈2/3 buried);
        # the backstay enters its top
        for sa in (a_s0, a_s1):
            za = self.anchor_z(sa)
            ga = self.g(sa)
            L = sp['anchor_len']
            y0, y1 = (sa - L, sa + 8) if sa < 0 else (sa - 8, sa + L)
            for sx in (-1, 1):
                xa, xb = sorted((sx * (sp['walk_half'] - 0.5), sx * (sp['cable_x'] + 9.0)))
                b['concrete'].box((xa, y0, ga - 15), (xb, y1, za + 2), faces='xXyYZ')
                b.cbox((xa, y0, ga - 15), (xb, y1, za + 2))
        # ---- hangers: thin semi-transparent ropes (istkit.hanger_mat) on LOD0 / LOD1 only; collision on LOD0 (meta)
        hr = sp['hanger_r']
        sp_h = sp['hanger_step']
        n = int(round(2 * H / sp_h))
        clamps = [-H + 2 * H * i / n for i in range(1, n)]
        for sx in (-1, 1):
            xc, xd = sx * sp['cable_x'], sx * sp['hanger_x']
            for i, s in enumerate(clamps):
                zc = zlow + (zs - zlow) * (s / H) ** 2
                feet = [s - sp_h / 2, s + sp_h / 2] if sp['inclined'] else [s]
                for sf in feet:
                    top = V(xc, s, zc - 0.4)
                    foot = V(xd, sf, self.road(sf) + 0.3)
                    if top[2] - foot[2] < 1.0:
                        continue
                    if lod == 0:
                        # twin ropes 0.5 m apart read as one line beyond ~100 m: one tube of their combined section
                        b['hanger'].tube([foot, top], hr * (1.5 if sp.get('twin') else 1.0), sides=4, ts=4.0)
                    elif lod == 1 and (sp['inclined'] or i % 2 == 0):     # vertical hangers: every other one
                        b['hanger'].tube([foot, top], hr, sides=3, ts=4.0)
                    b.ccap(foot, top, 0.35)
        # ---- side spans: box girder on piers (not suspended; only the backstays pass over them)
        for sp_s in (sp.get('piers', []) if lod < 3 else []):
            gz = self.g(sp_s)
            zt = self.road(sp_s) - sp['depth'] - 0.8
            if zt - gz < 2.0:
                continue
            for sx in (-1, 1):
                pier(b, sx * sp['road_half'] * 0.55, sp_s, zt, gz, w=3.2, d=3.2)
            b['concrete'].box((-sp['walk_half'] + 1, sp_s - 1.6, zt - 2.2), (sp['walk_half'] - 1, sp_s + 1.6, zt))
        # ---- abutments at the deck ends
        for se in (s0, s1):
            gz = self.g(se)
            zt = self.road(se) - sp['depth'] - 0.8
            if zt > gz:
                b['concrete'].box((-sp['walk_half'], se - 6, gz - 20), (sp['walk_half'], se + 6, zt))
                b.cbox((-sp['walk_half'], se - 6, gz - 20), (sp['walk_half'], se + 6, zt))
        # ---- lamps + traffic
        lamp_row(b, deck, s0, s1, sp['lamp_step'], sp['road_half'] + 0.3, mat=tm)
        lamp_row(b, deck, s0 + sp['lamp_step'] / 2, s1, sp['lamp_step'], -sp['road_half'] - 0.3, mat=tm)
        lanes(b, deck, s0, s1, 2, x0=1.4)
        return b

    def anchor_z(self, sa):
        return max(self.g(sa), 0.0) + 6.0

    def meta_extra(self):
        sp = self.spec
        return {'bridge': bridge_block(self.br, self.deck, -sp['half'], sp['half'], sp['half'], sp['tower_top'])}


SPEC_BOGAZICI = dict(
    id='bogazici', name='15 Temmuz Şehitler Köprüsü', half=537.0, top_mid=67.8, crest_R=17900.0, depth=3.0,
    road_half=14.0, walk_half=16.7, bot_half=9.5, lanes=6, leg_x=19.0, leg_w=(5.2, 3.0), leg_d=7.0, tower_top=165.0,
    tower_base=2.0, portals=[(50.0, 55.0), (120.0, 125.0), (152.0, 157.0)], saddle=163.0, cable_low=70.5, cable_x=17.6,
    cable_r=0.30, anchor_s=(-770.0, 795.0), anchor_len=35.0, hanger_step=17.9, hanger_x=16.9, hanger_r=0.04,
    inclined=False, twin=True, lamp_step=36.0, tower_mat='paint_w',
    # Ortaköy side 40+3×45+56 (from the European tower), Beylerbeyi side 4×63.75
    piers=[-593.0, -638.0, -683.0, -728.0, 600.75, 664.5, 728.25, 792.0],
)
SPEC_FSM = dict(
    id='fsm', name='Fatih Sultan Mehmet Köprüsü', half=545.0, top_mid=67.8, crest_R=37000.0, depth=3.0,
    road_half=16.9, walk_half=19.7, bot_half=11.0, lanes=8, leg_x=22.0, leg_w=(5.0, 3.0), leg_d=4.0, tower_top=165.0,
    tower_on_ground=True, portals=[(111.0, 117.0), (157.0, 163.0)], saddle=164.0, cable_low=70.5, cable_x=20.2,
    cable_r=0.385, anchor_s=(-755.0, 755.0), anchor_len=35.0, hanger_step=17.92, hanger_x=19.9, hanger_r=0.038,
    inclined=False, twin=True, lamp_step=36.0, piers=[],
)


def build_suspension(key, spec):
    holder = {}

    def fn(lod):
        s = Suspension(key, spec, lod)
        s.build()
        if lod == 0:
            holder['s'] = s
        return s.b
    br = BR[key]
    # LOD0 is built first by export_landmark; its `bridge` block is known once LOD0 exists -> write after
    meta = export_landmark(spec['id'], spec['name'], fn, (br['origin']['x'], br['origin']['z']), br['heading'],
                           base='absolute', dists=(1800, 4200, 14000), draco_bits=19, lods=(0, 1, 2, 3))
    meta.d.update(holder['s'].meta_extra())
    meta.save()


# ================================================================================================ Yavuz Sultan Selim
class YSS:
    """Hybrid cable-stayed suspension bridge with A-shaped concrete towers (T-ingénierie / Virlogeux design)."""
    H = 704.0
    TOP = 330.0
    SADDLE = 305.0
    LOW = 90.0
    HANG = 396.0                  # hangers in |s| < HANG
    DEPTH = 5.5
    WH = 29.25                    # deck half width (58.5 m)
    LEG_B, LEG_T = 45.0, 14.5     # leg centre |x| at z = 0 and at the saddle

    def __init__(self, lod):
        self.lod = lod
        self.br = BR['yss']
        self.g = ground_fn(self.br)
        self.b = Build('yss', 'Yavuz Sultan Selim Köprüsü', lod)

    def road(self, s):
        a = abs(s)
        if a <= self.H:
            return 78.5 - 3.0 * (a / self.H) ** 2
        return 75.5 - (a - self.H) * 0.0085

    def leg_x(self, z):
        return self.LEG_B + (self.LEG_T - self.LEG_B) * min(max(z, 0.0), self.SADDLE) / self.SADDLE

    def cable_z(self, s):
        a = abs(s)
        k = 0.0005365
        if a <= self.HANG:
            return self.LOW + k * a * a
        z1 = self.LOW + k * self.HANG ** 2
        if a <= self.H:
            return z1 + (self.SADDLE - z1) * (a - self.HANG) / (self.H - self.HANG)
        return None

    def build(self):
        b, lod, br = self.b, self.lod, self.br
        s0, s1 = br['s0'], br['s1']
        step = {0: 8.0, 1: 24.0, 2: 60.0, 3: 120.0}[lod]
        deck = Deck([(0.0, s, self.road(s)) for s in stations(s0, s1, step)], 22.0, self.WH, self.DEPTH - 1.0, 20.0, lanes=8,
                    dz_top=-1.0)
        self.deck = deck
        # two road carriageways + rail corridor in the middle: road texture on the outer parts, ballast in between
        P = deck.path
        P.strip(b['road'], -self.WH + 1.5, -8.0, 0.0, uv='road', ts=12.0)
        P.strip(b['road'], 8.0, self.WH - 1.5, 0.0, uv='road', ts=12.0)
        P.strip(b['concrete'], -8.0, 8.0, -0.1, ts=4.0)
        if lod < 2:
            for x in (-4.2, -2.7, 2.7, 4.2):          # rails
                P.strip(b['cable'], x - 0.08, x + 0.08, 0.1, ts=4.0)
            for x in (-self.WH + 1.5, -8.0, 8.0, self.WH - 1.5):
                P.strip(b['concrete'], x, x, 0.0, 1.0, ts=4.0)
                P.strip(b['concrete'], x, x, 1.0, 0.0, ts=4.0)
        if lod == 0:
            for x in (-self.WH + 0.2, self.WH - 0.2):
                P.rail(b['rail'], x, 0.0, 1.4, ts=2.0)
        deck.edge(b['paint'], -self.WH, -1.0, 0.2, -1)
        deck.edge(b['paint'], self.WH, -1.0, 0.2, +1)
        if lod < 2:
            P.strip(b['concrete'], -self.WH, -self.WH + 1.5, 0.2, ts=4.0)
            P.strip(b['concrete'], self.WH - 1.5, self.WH, 0.2, ts=4.0)
        box_girder(b['paint'], P, self.WH - 0.2, 20.0, self.DEPTH - 1.0, col=AO, dz_top=-1.0)
        deck.collision(b, top_extra=1.5)
        # ---- A towers
        for sc in (-self.H, self.H):
            for sx in (-1, 1):
                # leg: tapered section along an inclined axis (triangular 18 m at the base -> chamfered box)
                segs = {0: 6, 1: 3, 2: 3, 3: 2}[lod]
                zs = np.linspace(-12.0, self.SADDLE, segs + 1)
                for za, zb in zip(zs[:-1], zs[1:]):
                    wa = 13.0 - 6.5 * (za + 12) / (self.SADDLE + 12)
                    wb = 13.0 - 6.5 * (zb + 12) / (self.SADDLE + 12)
                    column(b['concrete'], (sx * self.leg_x(za), sc, 0), wa, wa * 1.15, za, zb, w_top=wb, d_top=wb * 1.15,
                           c_top=(sx * self.leg_x(zb), sc, 0), ts=8.0, chamfer=2.2 if lod < 2 else 0.0, top=False)
                    b.ccap((sx * self.leg_x(za), sc, za), (sx * self.leg_x(zb), sc, zb), wa * 0.62, solid=True)
                # steel top (saddle housing) up to the top
                xt = sx * self.LEG_T
                column(b['paint_w'], (xt, sc, 0), 6.0, 8.0, self.SADDLE, self.TOP, w_top=4.5, d_top=6.0, ts=4.0)
                b.cbox((xt - 3.5, sc - 4.5, self.SADDLE), (xt + 3.5, sc + 4.5, self.TOP + 0.5))
                b.light((xt, sc, self.TOP + 1.0), '#ff2a14', size=8.0, period=1.5, phase=0.0 if sc < 0 else 0.75)
                b.light((sx * self.leg_x(200.0) + sx * 4, sc, 200.0), '#ff2a14', size=5.0, period=1.5, phase=0.0 if sc < 0 else 0.75)
                b.light((sx * self.leg_x(100.0) + sx * 5, sc, 100.0), '#ff2a14', size=5.0, period=1.5, phase=0.0 if sc < 0 else 0.75)
                # foundation
                gz = self.g(sc)
                if lod < 3:
                    b['concrete'].box((sx * self.LEG_B - 12, sc - 14, -20), (sx * self.LEG_B + 12, sc + 14, max(gz, 0) + 2))
            # crossbeam under the deck (61 m) and upper steel crossbeam (~268 m)
            xa = self.leg_x(55.0) - 5
            b['concrete'].box((-xa, sc - 6, 50.0), (xa, sc + 6, 62.0))
            b.cbox((-xa, sc - 6, 50.0), (xa, sc + 6, 62.0))
            xt = self.leg_x(268.0) - 3
            b['paint_w'].box((-xt, sc - 3, 264.0), (xt, sc + 3, 272.0))
            b.cbox((-xt, sc - 3, 264.0), (xt, sc + 3, 272.0))
        # ---- stays: 22 main-span + 22 land-side per leg (anchored 208–304 m on the leg)
        rs = 0.09
        ssides = {0: 4, 1: 3}.get(lod, 3)
        nst = {0: 22, 1: 22, 2: 6, 3: 3}[lod]
        for sc in (-self.H, self.H):
            inward = -1 if sc > 0 else 1        # toward mid-span
            for sx in (-1, 1):
                for k in range(nst):
                    t = k / (nst - 1)
                    za = 208.0 + (304.0 - 208.0) * t
                    xa = sx * (self.leg_x(za) - 1.5)
                    top = V(xa, sc + inward * 1.5, za)
                    # main span side: outer deck edge, 36 → 308 m from the tower
                    sm = sc + inward * (36.0 + (308.0 - 36.0) * t)
                    foot = V(sx * (self.WH - 1.0), sm, self.road(sm) + 0.3)
                    # land side: inner edge by the railway, 30 → 270 m from the tower
                    sl = sc - inward * (30.0 + 240.0 * t)
                    foot_l = V(sx * 9.0, sl, self.road(sl) + 0.3)
                    for f in (foot, foot_l):
                        if lod >= 2:
                            b['cable'].tube([f, top], 0.35 if lod == 2 else 0.6, sides=3, ts=4.0)
                        else:
                            b['cable'].tube([f, top], rs, sides=ssides, ts=4.0)
                        b.ccap(f, top, 0.45)
        # ---- main cables (planes x = ±12 at the hangers, saddles at the leg tops) + backstays to the deck ends
        sides_c = {0: 10, 1: 6, 2: 4, 3: 3}[lod]
        cst = {0: 8.0, 1: 24.0, 2: 60.0, 3: 120.0}[lod]
        crr = {0: 0.42, 1: 0.42, 2: 0.9, 3: 1.5}[lod]
        for sx in (-1, 1):
            pts = []
            for s in stations(-self.H, self.H, cst):
                x = sx * (12.0 + (self.LEG_T - 12.0) * max(0.0, (abs(s) - self.HANG) / (self.H - self.HANG)))
                pts.append(V(x, s, self.cable_z(s)))
            tube(b['cable'], pts, crr, sides_c)
            cable_caps(b, pts, 1.3, 3 if lod == 0 else 1)
            for sc, se in ((-self.H, s0 + 12.0), (self.H, s1 - 12.0)):
                bs = [V(sx * self.LEG_T, sc, self.SADDLE), V(sx * 12.0, se, self.road(se) + 2.0)]
                tube(b['cable'], bs, crr, sides_c)
                b.ccap(bs[0], bs[1], 1.3)
            # hangers: 34 vertical pairs at ~24 m in the central part (thin semi-transparent ropes, LOD0 / LOD1)
            n = 34
            for i in range(n):
                s = -self.HANG + 2 * self.HANG * (i + 0.5) / n
                top = V(sx * 12.0, s, self.cable_z(s) - 0.5)
                foot = V(sx * 12.0, s, self.road(s) + 0.3)
                if top[2] - foot[2] > 1.0:
                    if lod < 2:
                        b['hanger'].tube([foot, top], 0.07, sides=4 if lod == 0 else 3, ts=4.0)
                    if lod == 0:
                        b['hanger'].tube([foot + V(0, 0.8, 0), top + V(0, 0.8, 0)], 0.07, sides=4, ts=4.0)
                    b.ccap(foot, top, 0.4)
        # ---- side-span piers (concrete counterweight decks)
        for sgn in ((-1, 1) if lod < 3 else ()):
            for k in (1, 2, 3):
                s = sgn * (self.H + 95.0 * k)
                if not (s0 + 20 < s < s1 - 20):
                    continue
                gz = self.g(s)
                zt = self.road(s) - self.DEPTH - 1.0
                if zt - gz < 3:
                    continue
                for px in (-14.0, 14.0):
                    pier(b, px, s, zt, gz, w=6.0, d=5.0)
                b['concrete'].box((-self.WH + 2, s - 3, zt - 3), (self.WH - 2, s + 3, zt))
        for se in (s0, s1):
            gz = self.g(se)
            zt = self.road(se) - self.DEPTH - 1.0
            if zt > gz:
                b['concrete'].box((-self.WH, se - 8, gz - 20), (self.WH, se + 8, zt))
                b.cbox((-self.WH, se - 8, gz - 20), (self.WH, se + 8, zt))
        lamp_row(b, deck, s0, s1, 40.0, self.WH - 1.8)
        lamp_row(b, deck, s0 + 20, s1, 40.0, -self.WH + 1.8)
        lanes(b, deck, s0, s1, 2, x0=9.5, lane_w=3.75)
        return b


def build_yss():
    holder = {}

    def fn(lod):
        y = YSS(lod)
        y.build()
        if lod == 0:
            holder['y'] = y
        return y.b
    br = BR['yss']
    meta = export_landmark('yss', 'Yavuz Sultan Selim Köprüsü', fn, (br['origin']['x'], br['origin']['z']), br['heading'],
                           base='absolute', dists=(1800, 4200, 15000), draco_bits=19, lods=(0, 1, 2, 3))
    y = holder['y']
    meta.d['bridge'] = bridge_block(br, y.deck, -YSS.H, YSS.H, YSS.H, YSS.TOP)
    meta.save()


# ================================================================================================ Haliç bridges
def path_pts(br, zfun, step):
    """Model-frame centreline (x, y, z_top) of a path bridge resampled every `step` m."""
    P = np.array(br['path'], float)          # [[X, Y], ...] (Y = s along the chord)
    ys = stations(P[0, 1], P[-1, 1], step)
    xs = np.interp(ys, P[:, 1], P[:, 0])
    return [(float(x), float(y), zfun(y)) for x, y in zip(xs, ys)]


class HalicMetro:
    """Haliç Metro Köprüsü: cable-stayed (two horn pylons, harp stays) + swing span + approach viaducts."""
    DECK_TOP = 12.5
    DEPTH = 4.45

    def __init__(self, lod):
        self.lod = lod
        self.br = BR['halic_metro']
        self.g = ground_fn(self.br)
        self.b = Build('halic_metro', 'Haliç Metro Köprüsü', lod)
        g = np.array(self.br['ground'])
        wet = g[g[:, 1] < 0.5, 0]
        self.w0, self.w1 = float(wet.min()), float(wet.max())      # water along the path
        self.sw0 = self.w0 - 5.0                                    # swing span from the south-west shore
        self.sw1 = self.sw0 + 120.0
        self.p0 = self.sw1 + 90.0                                   # pylons: side span 90, main span 180
        self.p1 = self.p0 + 180.0
        s0, s1 = self.br['s0'], self.br['s1']
        self.e0 = (s0, max(self.g(s0), 0) + 4.0)
        self.e1 = (s1, max(self.g(s1), 0) + 4.0)

    def road(self, s):
        a, b = self.sw0 - 60, self.p1 + 90 + 40
        if s < a:
            return self.DECK_TOP + (self.e0[1] - self.DECK_TOP) * (a - s) / (a - self.e0[0])
        if s > b:
            return self.DECK_TOP + (self.e1[1] - self.DECK_TOP) * (s - b) / (self.e1[0] - b)
        return self.DECK_TOP

    def build(self):
        b, lod, br = self.b, self.lod, self.br
        step = {0: 6.0, 1: 15.0, 2: 40.0}[lod]
        pts = path_pts(br, self.road, step)
        deck = Deck(pts, 5.2, 6.3, self.DEPTH, 4.0, lanes=2)
        self.deck = deck
        P = deck.path
        P.strip(b['concrete'], -5.2, 5.2, 0.0, ts=4.0)
        if lod < 2:
            for x in (-3.0, -1.6, 1.6, 3.0):
                P.strip(b['cable'], x - 0.07, x + 0.07, 0.15, ts=4.0)
            P.strip(b['concrete'], -6.3, -5.2, 0.6, ts=4.0)
            P.strip(b['concrete'], 5.2, 6.3, 0.6, ts=4.0)
        if lod == 0:
            for x in (-6.2, 6.2):
                P.rail(b['rail'], x, 0.6, 1.8, ts=2.0)
        deck.edge(b['paint_w'], -6.3, -0.8, 0.6, -1)
        deck.edge(b['paint_w'], 6.3, -0.8, 0.6, +1)
        box_girder(b['paint_w'], P, 6.2, 3.6, self.DEPTH - 0.8, col=AO, dz_top=-0.8)
        deck.collision(b, top_extra=2.0)
        # ---- pylons: two slim curved horns per pylon position (x = ±7.6), 65 m above the water
        for sp in (self.p0, self.p1):
            c = P.at(sp)
            t = P.tangent_at(sp)
            nrm = V(t[1], -t[0], 0)
            for sx in (-1, 1):
                segs = 8 if lod == 0 else 4
                prev = None
                for k in range(segs + 1):
                    z = -6.0 + 71.0 * k / segs
                    off = 7.6 + 2.6 * max(0.0, z / 65.0) ** 2
                    p = V(c[0], c[1], 0) + nrm * (sx * off) + V(0, 0, z)
                    if prev is not None:
                        wa = 3.4 - 2.0 * (k - 1) / segs
                        wb = 3.4 - 2.0 * k / segs
                        column(b['paint_w'], (prev[0], prev[1], 0), wa, wa * 1.3, prev[2], p[2], w_top=wb, d_top=wb * 1.3,
                               c_top=(p[0], p[1], 0), ts=4.0, yaw=math.atan2(t[1], t[0]) - math.pi / 2, top=k == segs)
                        b.ccap(prev, p, wa * 0.7, solid=True)
                    prev = p
                b.light((prev[0], prev[1], prev[2] + 0.8), '#ff2a14', size=4.0, period=1.5)
            # pier under the pylon
            b['concrete'].box((c[0] - 9.5, c[1] - 5, -12.0), (c[0] + 9.5, c[1] + 5, self.DECK_TOP - self.DEPTH - 0.8))
            b.cbox((c[0] - 9.5, c[1] - 5, -12.0), (c[0] + 9.5, c[1] + 5, self.DECK_TOP - self.DEPTH - 0.8))
            # harp stays: 9 per side per horn, parallel, highest anchor at 47 m
            n = 9 if lod < 2 else 3
            for side in (-1, 1):
                for k in range(n):
                    za = 47.0 - 27.0 * k / max(1, n - 1)
                    dist = (za - self.DECK_TOP) * 1.9
                    for sx in (-1, 1):
                        off = 7.6 + 2.6 * (za / 65.0) ** 2
                        top = V(c[0], c[1], 0) + nrm * (sx * (off - 0.8)) + V(0, 0, za)
                        foot = P.at(sp + side * dist, sx * 6.0, 0.8)
                        b['cable'].tube([foot, top], 0.08 if lod < 2 else 0.25, sides=4 if lod == 0 else 3, ts=4.0)
                        b.ccap(foot, top, 0.35)
        # ---- station canopy on the main span (≈90 m roof)
        mid = (self.p0 + self.p1) / 2
        if lod < 2:
            for s in stations(mid - 45, mid + 45, 15.0 if lod == 0 else 45.0)[:-1]:
                a, c2 = P.at(s, -8.5, 7.0), P.at(s + (15.0 if lod == 0 else 45.0), -8.5, 7.0)
                d2, e2 = P.at(s + (15.0 if lod == 0 else 45.0), 8.5, 7.0), P.at(s, 8.5, 7.0)
                b['paint_w'].quad(a, c2, d2, e2)
                b['paint_w'].quad(e2, d2, c2, a)
        # platforms either side of the tracks along the station
        for sx in (-1, 1):
            P.strip(b['concrete'], sx * 6.3 if sx > 0 else -9.0, 9.0 if sx > 0 else -6.3, 1.0, ts=4.0,
                    i0=P.index_at(mid - 45), i1=P.index_at(mid + 45))
        # ---- swing span pivot pier + approach piers
        piv = (self.sw0 + self.sw1) / 2
        c = P.at(piv)
        b['concrete'].cylinder((c[0], c[1], -10.0), 8.0, self.road(piv) - self.DEPTH - 0.8 + 10.0, sides=12 if lod < 2 else 8)
        if b.meta:
            b.meta.box((c[0] - 8, c[1] - 8, -10.0), (c[0] + 8, c[1] + 8, self.road(piv) - self.DEPTH - 0.8), b.name)
        stops = [self.sw0, self.sw1, self.p1 + 90]
        for s in list(np.arange(br['s0'] + 30, self.sw0 - 10, 40.0)) + list(np.arange(self.p1 + 90 + 40, br['s1'] - 10, 40.0)) + stops:
            c = P.at(s)
            gz = self.g(s)
            zt = self.road(s) - self.DEPTH - 0.8
            if zt - gz < 1.5:
                continue
            pier(b, c[0], c[1], zt, max(gz, -2.0), w=3.2, d=3.2)
        lamp_row(b, deck, P.s[0], P.s[-1], 45.0, 6.0, h=6.0, arm=0.8)
        return b


class Girder:
    """Straight / curved girder or pontoon bridges (Haliç O-1, Galata, Atatürk)."""

    def __init__(self, key, lid, name, lod, road_top, depth, road_half, walk_half, pier_step, split=0.0, pontoon=False,
                 bascule=None, lower=False, lamp_h=9.0):
        self.key, self.lod = key, lod
        self.br = BR[key]
        self.g = ground_fn(self.br)
        self.b = Build(lid, name, lod)
        self.top, self.depth = road_top, depth
        self.rh, self.wh, self.pier_step, self.split = road_half, walk_half, pier_step, split
        self.pontoon, self.bascule, self.lower, self.lamp_h = pontoon, bascule, lower, lamp_h
        g = np.array(self.br['ground'])
        wet = g[g[:, 1] < 0.5, 0]
        self.w0, self.w1 = (float(wet.min()), float(wet.max())) if len(wet) else (0.0, 0.0)

    def road(self, s):
        br = self.br
        s0, s1 = br['s0'], br['s1']
        e0, e1 = max(self.g(s0), 0.0) + 0.5, max(self.g(s1), 0.0) + 0.5
        ramp = 90.0
        if s < s0 + ramp:
            t = (s - s0) / ramp
            return e0 + (self.top - e0) * min(max(t, 0.0), 1.0) if e0 < self.top else self.top
        if s > s1 - ramp:
            t = (s1 - s) / ramp
            return e1 + (self.top - e1) * min(max(t, 0.0), 1.0) if e1 < self.top else self.top
        return self.top

    def build(self):
        b, lod, br = self.b, self.lod, self.br
        step = {0: 6.0, 1: 15.0, 2: 40.0}[lod]
        if 'path' in br:
            pts = path_pts(br, self.road, step)
        else:
            pts = [(0.0, s, self.road(s)) for s in stations(br['s0'], br['s1'], step)]
        deck = Deck(pts, self.rh, self.wh, self.depth, self.wh * 0.75, lanes=4)
        self.deck = deck
        deck.build(b, girder='paint', split=self.split)
        P = deck.path
        # collision: grounded when the underside is near the water (pontoons / low decks), floating otherwise
        deck.collision(b, top_extra=1.4)
        # piers
        if self.pier_step:
            s = P.s[0] + self.pier_step
            while s < P.s[-1] - 20:
                c = P.at(s)
                gz = self.g(s)
                zt = self.road(s) - self.depth - 0.8
                if zt - gz > 1.5:
                    t = P.tangent_at(s)
                    yaw = math.atan2(t[1], t[0]) - math.pi / 2
                    offs = [-self.wh * 0.5, self.wh * 0.5] if not self.split else [-(self.split / 2 + (self.wh - self.split / 2) / 2),
                                                                                  self.split / 2 + (self.wh - self.split / 2) / 2]
                    for xo in offs:
                        q = P.at(s, xo, 0)
                        pier(b, q[0], q[1], zt, max(gz, -4.0), w=4.0, d=5.0, yaw=yaw)
                s += self.pier_step
        # pontoons (Atatürk): floating boxes under the deck in the water
        if self.pontoon:
            for s in np.arange(self.w0 + 10, self.w1 - 5, 22.0):
                c = P.at(s)
                b['paint'].box((c[0] - self.wh + 1, c[1] - 7, -1.5), (c[0] + self.wh - 1, c[1] + 7, self.road(s) - self.depth))
        # bascule towers (Galata): four small control houses with pyramid roofs at the bascule ends
        if self.bascule:
            bc, half = self.bascule
            for sy in (bc - half, bc + half):
                for sx in (-1, 1):
                    q = P.at(sy, sx * (self.wh + 3.2), 0)
                    extrude(b['stone_plain'], [(q[0] - 3.2, q[1] - 3.2), (q[0] + 3.2, q[1] - 3.2), (q[0] + 3.2, q[1] + 3.2), (q[0] - 3.2, q[1] + 3.2)],
                            -4.0, 16.0, 4, 4, top=False)
                    hip_roof(b['lead'], [(q[0] - 3.6, q[1] - 3.6), (q[0] + 3.6, q[1] - 3.6), (q[0] + 3.6, q[1] + 3.6), (q[0] - 3.6, q[1] + 3.6)], 16.0, 4.5)
                    b.cbox((q[0] - 3.4, q[1] - 3.4, -4.0), (q[0] + 3.4, q[1] + 3.4, 20.5))
        # lower level (Galata): restaurant arcades under both deck edges, from the shores to the bascule
        if self.lower and lod < 2:
            bc, half = self.bascule
            for a, c in ((P.s[0] + 25, bc - half - 4), (bc + half + 4, P.s[-1] - 25)):
                for sx in (-1, 1):
                    x0, x1 = sorted((sx * (self.wh - 0.5), sx * (self.wh - 9.0)))
                    i0, i1 = P.index_at(a), P.index_at(c)
                    P.strip(b['wall'], x1 if sx > 0 else x0, x1 if sx > 0 else x0, 1.0 - self.top, -self.depth - 0.9,
                            i0=i0, i1=i1, ts=6.0, flip=sx > 0)
                    P.strip(b['concrete'], x0, x1, 1.0 - self.top, i0=i0, i1=i1, ts=4.0)
        if self.lower and b.meta:
            # the restaurant level under both deck edges is solid down to the water (only the bascule is open below)
            bc, half = self.bascule
            for a, c in ((P.s[0] + 25, bc - half - 4), (bc + half + 4, P.s[-1] - 25)):
                for s0 in stations(a, c, 30.0)[:-1]:
                    s1 = min(c, s0 + 30.0)
                    pa, pc = P.at(s0), P.at(s1)
                    m, d = (pa + pc) / 2, pc - pa
                    L = float(np.hypot(d[0], d[1]))
                    for sx in (-1, 1):
                        q = m + V(-d[1], d[0], 0) / max(L, 1e-6) * 0.0
                        off = P.at((s0 + s1) / 2, sx * (self.wh - 4.75), 0) - P.at((s0 + s1) / 2)
                        c3 = q + off
                        b.meta.obox((c3[0], c3[1], 1.5), (d[0], d[1]), 4.75, L / 2 + 0.5, 3.5, b.name)
        # lamps
        lamp_row(b, deck, P.s[0], P.s[-1], 30.0, self.wh - 0.3, h=self.lamp_h)
        lamp_row(b, deck, P.s[0] + 15, P.s[-1], 30.0, -self.wh + 0.3, h=self.lamp_h)
        lanes(b, deck, P.s[0], P.s[-1], 2, x0=1.0 + self.split / 2, lane_w=3.4, speed=14.0)
        return b


def build_path_bridge(lid, name, cls_fn, dists=(2500, 9000), span=None):
    holder = {}

    def fn(lod):
        o = cls_fn(lod)
        o.build()
        if lod == 0:
            holder['o'] = o
        return o.b
    br = BR[lid]
    meta = export_landmark(lid, name, fn, (br['origin']['x'], br['origin']['z']), br['heading'], base='absolute',
                           dists=dists, draco_bits=17)
    o = holder['o']
    s_lo, s_hi = span(o)
    top = getattr(o, 'tower_top', None)
    meta.d['bridge'] = bridge_block(br, o.deck, s_lo, s_hi, (s_hi - s_lo) / 2, top)
    meta.save()


def halic_metro():
    def span(o):
        o.tower_top = 65.0
        return o.p0, o.p1
    build_path_bridge('halic_metro', 'Haliç Metro Köprüsü', HalicMetro, span=span)


def halic_bridge():
    def mk(lod):
        return Girder('halic_bridge', 'halic_bridge', 'Haliç Köprüsü', lod, road_top=24.0, depth=4.0, road_half=15.0,
                      walk_half=16.0, pier_step=124.0, split=7.0, lamp_h=10.0)

    def span(o):
        c = (o.w0 + o.w1) / 2
        return c - 62.0, c + 62.0
    build_path_bridge('halic_bridge', 'Haliç Köprüsü', mk, span=span)


def galata_bridge():
    br = BR['galata_bridge']
    g = np.array(br['ground'])
    wet = g[g[:, 1] < 0.5, 0]
    bc = float((wet.min() + wet.max()) / 2)

    def mk(lod):
        return Girder('galata_bridge', 'galata_bridge', 'Galata Köprüsü', lod, road_top=7.8, depth=1.8, road_half=17.5,
                      walk_half=21.0, pier_step=24.0, bascule=(bc, 40.0), lower=True, lamp_h=8.0)

    def span(o):
        return bc - 40.0, bc + 40.0
    build_path_bridge('galata_bridge', 'Galata Köprüsü', mk, dists=(2000, 8000), span=span)


def ataturk_bridge():
    def mk(lod):
        return Girder('ataturk_bridge', 'ataturk_bridge', 'Atatürk Köprüsü', lod, road_top=5.2, depth=1.6, road_half=10.5,
                      walk_half=12.5, pier_step=0.0, pontoon=True, lamp_h=8.0)

    def span(o):
        c = (o.w0 + o.w1) / 2
        return c - 30.0, c + 30.0
    build_path_bridge('ataturk_bridge', 'Atatürk Köprüsü', mk, dists=(2000, 8000), span=span)


BRIDGES = {
    'bogazici': lambda: build_suspension('bogazici', SPEC_BOGAZICI),
    'fsm': lambda: build_suspension('fsm', SPEC_FSM),
    'yss': build_yss,
    'halic_metro': halic_metro,
    'halic_bridge': halic_bridge,
    'galata_bridge': galata_bridge,
    'ataturk_bridge': ataturk_bridge,
}


def main():
    reset_scene()
    names = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else list(BRIDGES)
    for n in names:
        BRIDGES[n]()


if __name__ == '__main__':
    main()
