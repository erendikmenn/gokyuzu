"""Airport layout pipeline (W4): OSM + data/sf/runways.json -> assets/sf/airports/<icao>.json + <icao>.bin

Usage: .venv/bin/python tools/geo/airports_build.py [ksfo] [koak] [kngz]   (default: all)
       GEO_REGION=ist .venv/bin/python tools/geo/airports_build.py [ltfm] [ltfj] [ltba]
       (İstanbul: data/ist/runways.json from tools/geo/airports_runways.py, OSM from airports_fetch.py)

Per airport it produces
  surfaces  (draped meshes, x/z relative to the airport origin; runtime samples terrain heights per vertex)
            runway (attr e = (t, s, dA, dB): lateral, along, distance past each landing threshold), blast, shoulder,
            taxiway, apron, (kngz) pad
  markings  one mesh, attr c = colour class, e = runway coords (dA < -1000 on non-runway paint)
  lights    x, z, h, type, heading, param, mode
  json      buildings (footprints for collisions + Blender), jet bridges, stands, ALS stations, signs, props, exclusions
"""
import sys, os, math, json, random
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, box, MultiLineString
from shapely.ops import unary_union, nearest_points, substring
from shapely import affinity
from airports_lib import *
import airports_osm as osm

RUNWAYS = json.load(open(os.path.join(DATA_DIR, 'runways.json')))

# ---------------------------------------------------------------- light types (runtime table in airports_lights.js)
L_EDGE_W, L_EDGE_Y, L_CL_W, L_CL_R, L_TDZ, L_THR_G, L_END_R, L_APP_W, L_APP_R, L_SFL, L_PAPI, L_TWY_B, L_TWY_G, \
    L_RGL, L_OBS, L_BEACON, L_FLOOD, L_STOP, L_HELI_Y, L_HELI_G, L_OBS_FL, L_EDGE_WD = range(22)
M_GROUND, M_ABS, M_MAX = 0, 1, 2      # light height mode: above ground / absolute / max(abs, ground + 0.05)

TR = {  # Turkish names used by collisions
    'terminal': 'terminal binası', 'pier': 'terminal', 'hangar': 'hangar', 'garage': 'otopark binası', 'tower': 'kule',
    'office': 'bina', 'industrial': 'bina', 'service': 'bina', 'hotel': 'otel', 'station': 'istasyon', 'cargo': 'kargo binası',
    'fire': 'itfaiye binası', 'jetbridge': 'yolcu köprüsü', 'tower_cab': 'kule', 'has': 'sığınak (HAS)', 'tank': 'yakıt tankı', 'wall': 'patlama duvarı',
}


def nz_ident(ident, keep_zero):
    return ident if keep_zero else ident.lstrip('0')


class Airport:
    def __init__(self, icao, cfg):
        self.icao = icao
        self.apt = next(a for a in RUNWAYS['airports'] if a['icao'] == icao)
        self.cfg = cfg
        c = self.apt['center']
        self.origin = (round(c['x']), round(c['z']))
        self.elev = self.apt['elevation']
        self.rf = [RunwayFrame(r) for r in self.apt['runways']]
        self.surf = {k: Mesh(('e',) if k == 'runway' else ()) for k in ('runway', 'blast', 'shoulder', 'taxiway', 'apron', 'pad')}
        self.marks = Mesh(('c', 'e'))
        self.lights = []
        self.als = []            # approach light stations (structures)
        self.buildings = []      # dicts
        self.jetbridges = []
        self.stands = []
        self.signs = []
        self.props = []          # {type, x, z, hdg}
        self.structures = []     # special Blender structures {kind, ...}
        self.rw_polys = {}
        self.exclude_ids = []
        self.rng = random.Random(sum(map(ord, icao)) * 7919)
        self.lines_extra = {}
        self.fixtures, self.papi_units, self.cable_lines, self.blast_polys = [], [], [], []
        self.floods = []

    # ------------------------------------------------------------ helpers
    NORUB = (0.0, -1.0, -5000.0, -5000.0)

    def mark(self, poly, cls, e=None):
        self.marks.add_polygon(poly, c=cls, e=e or self.NORUB)

    def mark_rw(self, poly, cls, rf, dispA, dispB):
        def ef(x, z):
            s, t = rf.st(x, z)
            return (t, s, s - dispA, rf.L - s - dispB)
        self.marks.add_polygon(poly, c=cls, e=ef)

    def light(self, x, z, h, typ, hdg=None, param=0.0, mode=M_GROUND):
        self.lights.append((float(x), float(z), float(h), typ, float('nan') if hdg is None else float(hdg), float(param), mode))

    def end_cfg(self, ident):
        return self.cfg['ends'].get(ident, {})

    # ------------------------------------------------------------ runways
    def build_runways(self, stopways=None):
        cfg = self.cfg
        prio = cfg.get('priority', [r.id for r in self.rf])
        order = sorted(self.rf, key=lambda r: prio.index(r.id))
        keep0 = cfg.get('leading_zero', False)
        dominant = []
        stopways = stopways or {}
        all_rw = []
        for rf in order:
            poly = rf.poly()
            self.rw_polys[rf.id] = poly
            clip = unary_union(dominant) if dominant else None
            A, B = rf.r['ends']
            cA, cB = self.end_cfg(A['ident']), self.end_cfg(B['ident'])
            dA, dB = cA.get('disp', 0.0), cB.get('disp', 0.0)
            surf = poly.difference(clip) if clip is not None else poly

            def ef(x, z, rf=rf, dA=dA, dB=dB):
                s, t = rf.st(x, z)
                return (t, s, s - dA, rf.L - s - dB)
            add_draped(self.surf['runway'], surf, cell=cfg.get('cell', 30.0), e=ef)
            # --- markings (clip region for secondary runways: dominant runway rectangles + 1 m)
            mclip = clip.buffer(1.0) if clip is not None else None
            self._runway_markings(rf, cA, cB, dA, dB, keep0, mclip)
            self._runway_lights(rf, A, B, cA, cB, dA, dB, clip)
            dominant.append(poly)
            all_rw.append(poly)
            # blast pads / stopways
            for which, end, c in ((0, A, cA), (1, B, cB)):
                ln = stopways.get(end['ident'], c.get('blast', 0.0))
                if ln > 1:
                    ef_ = EndFrame(rf, which)
                    bp = ef_.rect(-ln, 0.0, -rf.w / 2, rf.w / 2)
                    self.blast_polys.append(bp)
                    self._blast_markings(ef_, rf.w, ln)
        self.rw_union = unary_union(all_rw)
        self.blast_union = unary_union(self.blast_polys) if self.blast_polys else Polygon()
        if self.cfg.get('land') is not None:
            self.blast_union = self.blast_union.intersection(self.cfg['land'])
        bl = self.blast_union.difference(self.rw_union)
        add_draped(self.surf['blast'], bl, cell=30)

    blast_polys = []

    def _runway_markings(self, rf, cA, cB, dA, dB, keep0, mclip):
        w, hw = rf.w, rf.w / 2
        prec = self.cfg.get('marking', 'P')
        polys_white = []
        # side stripes (continuous, 0.9 m, full length)
        if w >= 30:
            sw = 0.9
            polys_white.append(rf.rect(0.2, rf.L - 0.2, hw - sw - 0.15, hw - 0.15))
            polys_white.append(rf.rect(0.2, rf.L - 0.2, -hw + 0.15, -hw + sw + 0.15))
        ends = rf.r['ends']
        cl_bounds = []
        for which, (end, c, disp) in enumerate(((ends[0], cA, dA), (ends[1], cB, dB))):
            ef = EndFrame(rf, which)
            p = c.get('marking', prec)
            n_str = 16 if w >= 58 else 12 if w >= 44 else 8 if w >= 29 else 6 if w >= 22 else 4
            thr0 = 6.1
            if disp > 1:
                # threshold bar + arrowheads + centreline arrows in the displaced area
                polys_white.append(ef.rect(disp - 3.05, disp, -hw + 1.2, hw - 1.2))
                n_head = 4 if w < 50 else 6
                span = w - 12
                for k in range(n_head):
                    t = -span / 2 + span * (k + 0.5) / n_head
                    polys_white.append(self._arrowhead(ef, disp - 4.5, t, 13.7, 3.4))
                s = disp - 4.5 - 13.7 - 24.0
                while s > 20:
                    polys_white.append(self._arrow(ef, s, 0.0, 36.6))
                    s -= 61.0
                thr0 = disp + 6.1
            # threshold stripes (all runways with instrument markings; visual runways get them too at big fields)
            if p in ('P', 'NP') or w >= 23:
                half = n_str // 2
                for k in range(half):
                    t0 = 1.75 + 3.5 * k
                    for sg in (1, -1):
                        polys_white.append(ef.rect(thr0, thr0 + 45.7, sg * t0, sg * (t0 + 1.75)))
                s_des = thr0 + 45.7 + 6.1
            else:
                s_des = thr0 + 6.1
            # designation: letter nearest the threshold, number beyond it
            ident = nz_ident(end['ident'], keep0)
            num = ''.join(ch for ch in ident if ch.isdigit())
            let = ''.join(ch for ch in ident if ch.isalpha())
            sc = 1.0 if w >= 29 else 0.6
            gh = GH * sc
            s = s_des
            if let:
                tp, tw = text_polygon(let, h=gh)
                polys_white.append(ef.to_poly(tp, s, -tw / 2))
                s += gh + 4.6 * sc
            tp, tw = text_polygon(num, h=gh, gap=3.0 * sc)
            polys_white.append(ef.to_poly(tp, s, -tw / 2))
            s += gh
            cl_bounds.append(s + 12.2)
            # aiming point + touchdown zone
            if w >= 29 and p in ('P', 'NP') and rf.L > 1200:
                ai, aw = (10.97, 9.1) if w >= 44 else (6.0, 6.1)
                s_aim = disp + 310.9
                if s_aim + 45.7 < rf.L / 2:
                    for sg in (1, -1):
                        polys_white.append(ef.rect(s_aim, s_aim + 45.7, sg * ai, sg * (ai + aw)))
                if p == 'P':
                    for dist_ft, nb in ((500, 3), (1500, 2), (2000, 2), (2500, 1), (3000, 1)):
                        s0 = disp + dist_ft * FT
                        if s0 + 22.9 > rf.L / 2 - 30:
                            break
                        for b in range(nb):
                            t0 = ai + b * (1.83 + 1.52)
                            for sg in (1, -1):
                                polys_white.append(ef.rect(s0, s0 + 22.9, sg * t0, sg * (t0 + 1.83)))
            # arresting gear (military): yellow discs across the runway at the cable
            for cab in c.get('cables', []):
                s0 = cab
                for k in range(-int(hw // 9.1), int(hw // 9.1) + 1):
                    t = k * 9.1
                    if abs(t) > hw - 3:
                        continue
                    self.mark_rw(Point(*ef.P(s0, t)).buffer(1.52, 16), YELLOW, rf, dA, dB)
                self.cable_lines.append((tuple(ef.P(s0, -hw - 4)), tuple(ef.P(s0, hw + 4))))
        # centreline stripes between the two designations (120 ft stripes, 80 ft gaps), centred pattern
        s0 = cl_bounds[0]
        s1 = rf.L - cl_bounds[1]
        cw = 0.9 if prec == 'P' else 0.45
        if s1 - s0 > 60:
            period = 36.6 + 24.4
            n = int((s1 - s0 + 24.4) // period)
            off = s0 + ((s1 - s0) - (n * period - 24.4)) / 2
            for k in range(n):
                a = off + k * period
                polys_white.append(rf.rect(a, a + 36.6, -cw / 2, cw / 2))
        g = unary_union(polys_white)
        if mclip is not None:
            g = g.difference(mclip)
        self.mark_rw(g, WHITE, rf, dA, dB)

    cable_lines = []

    def _arrow(self, ef, s, t, length):
        shaft = ef.rect(s, s + length - 6.0, t - 0.45, t + 0.45)
        head = Polygon([tuple(ef.P(s + length, t)), tuple(ef.P(s + length - 7.5, t - 2.1)), tuple(ef.P(s + length - 7.5, t + 2.1))])
        return unary_union([shaft, head])

    def _arrowhead(self, ef, s_tip, t, length, width):
        # chevron-style arrowhead (V shape with 0.9 m stroke) pointing +s
        a = LineString([tuple(ef.P(s_tip - length, t - width)), tuple(ef.P(s_tip, t)), tuple(ef.P(s_tip - length, t + width))])
        return a.buffer(0.45, cap_style='flat', join_style='mitre')

    def _blast_markings(self, ef, w, ln):
        hw = w / 2
        polys = [ef.rect(-0.9, 0.0, -hw + 0.3, hw - 0.3)]      # demarcation bar
        sp = 30.5 if ln > 120 else 15.2
        s = -sp / 2
        while s > -ln + 4:
            # chevron pointing towards the runway (apex on the centreline)
            for sg in (1, -1):
                ls = LineString([tuple(ef.P(s, 0.0)), tuple(ef.P(s - hw * 0.9, sg * hw * 0.9))])
                polys.append(ls.buffer(0.45, cap_style='flat'))
            s -= sp
        g = unary_union(polys).intersection(ef.rect(-ln, 0, -hw, hw))
        if self.cfg.get('land') is not None:
            g = g.intersection(self.cfg['land'].buffer(-2))
        self.mark(g, YELLOW)

    def _runway_lights(self, rf, A, B, cA, cB, dA, dB, clip):
        hw = rf.w / 2
        L = rf.L
        hA = A['headingTrue']      # direction of flight landing/departing from end A (toward B)
        hB = B['headingTrue']
        inside_clip = (lambda x, z: clip is not None and clip.contains(Point(x, z)))
        # edge lights every 60 m (last 610 m yellow toward the approaching aircraft)
        n = max(2, int(round(L / 60.0)))
        for k in range(n + 1):
            s = L * k / n
            for sg in (1, -1):
                x, z = rf.P(s, sg * (hw + 1.0))
                if inside_clip(x, z):
                    continue
                # seen by aircraft moving A->B (light faces toward A, i.e. heading hB)
                self.light(x, z, 0.35, L_EDGE_Y if (L - s) < 610 and s > dA else L_EDGE_WD, hB)
                self.light(x, z, 0.35, L_EDGE_Y if s < 610 and (L - s) > dB else L_EDGE_WD, hA)
                self.fixtures.append((x, z, 0))
        # centreline lights every 15 m (offset 0.6 m), colour coded by distance remaining
        prec = self.cfg.get('marking', 'P') == 'P'
        if prec and rf.w >= 44:
            n = int(L // 15.24)
            for k in range(1, n):
                s = k * 15.24 + (L - n * 15.24) / 2
                x, z = rf.P(s, 0.6)
                if inside_clip(x, z):
                    continue
                for rem, hdg in ((L - s, hB), (s, hA)):
                    # remaining distance ahead for an aircraft moving toward the light's far end
                    if rem < 305:
                        typ = L_CL_R
                    elif rem < 914:
                        typ = L_CL_R if (k % 2) else L_CL_W
                    else:
                        typ = L_CL_W
                    self.light(x, z, 0.05, typ, hdg)
        # thresholds / ends / TDZ / PAPI / ALS per end
        for which, (end, oth, c, disp) in enumerate(((A, B, cA, dA), (B, A, cB, dB))):
            ef = EndFrame(rf, which)
            h_land = end['headingTrue']            # landing direction on this end
            h_back = oth['headingTrue']
            # runway end lights (red, facing along the runway toward approaching roll-out) at physical end
            nl = int(rf.w // 3.0)
            for k in range(nl + 1):
                t = -hw + 1.0 + (rf.w - 2.0) * k / nl
                x, z = ef.P(0.3, t)
                self.light(x, z, 0.1, L_END_R, h_back)
                if disp <= 1:
                    self.light(x, z, 0.1, L_THR_G, (h_land + 180) % 360)
            if disp > 1:
                # green wing bars at the displaced threshold
                for sg in (1, -1):
                    for k in range(5):
                        x, z = ef.P(disp, sg * (hw + 2.0 + 3.0 * k))
                        self.light(x, z, 0.3, L_THR_G, (h_land + 180) % 360)
                # in-pavement green threshold lights across the displaced threshold too
                for k in range(nl + 1):
                    t = -hw + 1.0 + (rf.w - 2.0) * k / nl
                    x, z = ef.P(disp, t)
                    self.light(x, z, 0.05, L_THR_G, (h_land + 180) % 360)
            facing = (h_land + 180) % 360       # toward the approaching aircraft
            if c.get('tdz'):
                for k in range(1, 31):
                    s = disp + k * 30.48
                    if s > L / 2:
                        break
                    for sg in (1, -1):
                        for j in range(3):
                            x, z = ef.P(s, sg * (10.97 + 1.52 * j))
                            self.light(x, z, 0.05, L_TDZ, facing)
            if c.get('papi'):
                side = -1 if c['papi'] == 'L' else 1
                s = disp + c.get('papi_s', 330.0)
                for j, ang in enumerate((3.5, 3.17, 2.83, 2.5)):
                    x, z = ef.P(s, side * (hw + 15.0 + 9.0 * j))
                    self.light(x, z, 0.9, L_PAPI, facing, ang)
                    self.papi_units.append((x, z, facing))
            als = c.get('als')
            if als:
                self._als(ef, rf, disp, als, facing, end.get('elevation'))
                # ILS: localizer array beyond the far (stop) end on the centreline, glideslope mast beside the TDZ
                far = EndFrame(rf, 1 - which)
                lx, lz = far.P(-(self.cfg.get('loc_dist', 300.0)), 0.0)
                self.structures.append({'kind': 'localizer', 'x': round(lx - self.origin[0], 2), 'z': round(lz - self.origin[1], 2),
                                        'h': round(h_land % 360, 2), 'w': 42.0 if rf.w > 50 else 30.0})
                side = 1 if c.get('papi', 'L') == 'L' else -1          # glideslope opposite the PAPI
                gx, gz = ef.P(disp + 300.0, side * (hw + 120.0))
                self.structures.append({'kind': 'glideslope', 'x': round(gx - self.origin[0], 2), 'z': round(gz - self.origin[1], 2),
                                        'h': round(h_land % 360, 2)})
                self.light(gx, gz, 16.2, L_OBS)

    fixtures = []
    papi_units = []

    def _als(self, ef, rf, disp, kind, facing, end_elev=None):
        """Approach lighting system measured from the landing threshold (s = disp) outward (s decreasing).
        end_elev: the runway end's own elevation where runways.json has one (sloped runways), else the airport's."""
        y = (self.elev if end_elev is None else end_elev) + 0.6
        st = []
        if kind == 'ALSF2':
            stations = [k * 100 for k in range(1, 25)]
            flashers = [d for d in stations if d >= 1000]
        else:   # MALSR / SSALR
            stations = [k * 200 for k in range(1, 8)]
            flashers = [1600, 1800, 2000, 2200, 2400]
        for d_ft in stations:
            s = disp - d_ft * FT
            ypos = y + max(0.0, d_ft * FT * 0.004)
            lights = [(t, L_APP_W) for t in (-2.1, -1.05, 0.0, 1.05, 2.1)]
            width = 5.0
            if d_ft == 1000:
                for sg in (1, -1):
                    for j in range(8 if kind == 'ALSF2' else 5):
                        lights.append((sg * (4.6 + 1.52 * j), L_APP_W))
                width = 2 * (4.6 + 1.52 * 7) + 1 if kind == 'ALSF2' else 2 * (4.6 + 1.52 * 4) + 1
            if kind == 'ALSF2' and d_ft == 500:
                for sg in (1, -1):
                    for j in range(4):
                        lights.append((sg * (4.6 + 1.52 * j), L_APP_W))
                width = 2 * (4.6 + 1.52 * 3) + 1
            if kind == 'ALSF2' and d_ft <= 900:
                for sg in (1, -1):
                    for j in range(3):
                        lights.append((sg * (10.97 + 1.52 * j), L_APP_R))
            for t, typ in lights:
                x, z = ef.P(s, t)
                self.light(x, z, ypos, typ, facing, 0.0, M_MAX)
            x, z = ef.P(s, 0.0)
            on_pavement = s > 0
            st.append({'x': round(x - self.origin[0], 2), 'z': round(z - self.origin[1], 2), 'y': round(ypos, 2),
                       'w': round(width, 1), 'h': round(facing, 2), 'pave': on_pavement,
                       'side': 1 if (kind == 'ALSF2' and d_ft <= 900) else 0})
        n = len(flashers)
        for i, d_ft in enumerate(sorted(flashers, reverse=True)):
            s = disp - d_ft * FT
            x, z = ef.P(s, 0.0)
            ypos = y + d_ft * FT * 0.004 + 0.5
            self.light(x, z, ypos, L_SFL, facing, i / max(1, n), M_MAX)
            if d_ft * FT > disp + 50 and not any(abs(d_ft - s2) < 1 for s2 in stations):
                st.append({'x': round(x - self.origin[0], 2), 'z': round(z - self.origin[1], 2), 'y': round(ypos, 2), 'w': 1.0,
                           'h': round(facing, 2), 'pave': False, 'side': 0})
        # catwalk from the runway end to the farthest station
        far = max(stations + flashers) * FT
        a = ef.P(-2.0, 0.0)
        b = ef.P(disp - far, 0.0)
        self.als.append({'stations': st, 'walk': [round(a[0] - self.origin[0], 2), round(a[1] - self.origin[1], 2),
                                                  round(b[0] - self.origin[0], 2), round(b[1] - self.origin[1], 2)],
                         'y': round(y - 0.9, 2)})

    # ------------------------------------------------------------ taxiways, aprons, shoulders
    def build_ground(self, taxi_lines, aprons, extra_taxi_area=None, fillet=10.0):
        """taxi_lines: list of (LineString, width, ref); aprons: list of Polygon."""
        rw = self.rw_union
        bl = self.blast_union
        parts = [ln.buffer(w / 2, cap_style='round', join_style='round', quad_segs=6) for ln, w, _ in taxi_lines]
        if extra_taxi_area is not None:
            parts.append(extra_taxi_area)
        taxi_raw = unary_union(parts)
        taxi_area = taxi_raw.buffer(fillet, quad_segs=6).buffer(-fillet, quad_segs=6)
        apron = unary_union(aprons).buffer(0) if aprons else Polygon()
        if self.cfg.get('gap_fill', 22.0) and not apron.is_empty:
            # close narrow unpaved slivers between aprons and taxiways (real ramps are paved wall to wall)
            gf = self.cfg.get('gap_fill', 22.0)
            core = unary_union([apron, taxi_area])
            closed = core.buffer(gf, quad_segs=4).buffer(-gf, quad_segs=4)
            fill = closed.difference(core).difference(rw.buffer(40)).difference(bl.buffer(20))
            fill = unary_union([p for p in polys_of(fill) if p.area > 30 and p.intersects(apron.buffer(1))])
            apron = unary_union([apron, fill]).buffer(0)
        apron_s = apron.difference(rw).difference(bl)
        taxi_s = taxi_area.difference(rw).difference(apron).difference(bl)
        paved = unary_union([rw, bl, taxi_area, apron])
        rw_sh = unary_union([rw, bl]).buffer(7.5, cap_style='flat', join_style='mitre')
        tw_sh = taxi_area.buffer(7.0, quad_segs=4)
        shoulder = unary_union([rw_sh, tw_sh]).difference(paved)
        self.paved = paved
        self.taxi_area = taxi_area
        self.apron = apron
        rot = self.cfg.get('grid_rot', 0.0)
        add_draped(self.surf['apron'], apron_s, cell=40)
        add_draped(self.surf['taxiway'], taxi_s, cell=40)
        add_draped(self.surf['shoulder'], shoulder.buffer(0), cell=40)
        # --- taxiway markings
        rwbuf = rw.buffer(1.5)
        no_edge = unary_union([apron.buffer(2.0), rw.buffer(3.0), bl.buffer(3.0)])
        edge = unary_union([
            taxi_area.buffer(-0.12).difference(taxi_area.buffer(-0.27)),
            taxi_area.buffer(-0.42).difference(taxi_area.buffer(-0.57)),
        ]).difference(no_edge)
        self.mark(edge, YELLOW)
        cl_polys = []
        self.twy_cl = []
        # lead-on / lead-off lines: the part of a taxiway line that ends on a runway (entry/exit) is painted onto the
        # runway up to 3 m short of its centreline; lines that cross a runway are interrupted.
        rw_core = unary_union([rf.poly(margin=-1.0) for rf in self.rf])
        for ln, w, ref in taxi_lines:
            inside = ln.intersection(rw_core)
            ends = [Point(ln.coords[0]), Point(ln.coords[-1])]
            for part in lines_of(inside):
                if part.length < 4:
                    continue
                if not any(part.distance(e) < 0.5 for e in ends):
                    continue           # crossing: no paint across the runway
                # stop 3 m before the runway centreline
                cut = part
                for rf in self.rf:
                    cl = LineString([tuple(rf.P(-50, 0)), tuple(rf.P(rf.L + 50, 0))])
                    if cut.distance(cl) < 3.5:
                        cut = cut.difference(cl.buffer(3.0, cap_style='flat'))
                for piece in lines_of(cut):
                    if piece.length > 3:
                        cl_polys.append(piece.buffer(0.15, cap_style='flat', join_style='round'))
        for ln, w, ref in taxi_lines:
            g = ln.difference(rw.buffer(0.5))
            for part in lines_of(g):
                if part.length < 3:
                    continue
                self.twy_cl.append((part, w, ref))
                cl_polys.append(part.buffer(0.15, cap_style='flat', join_style='round'))
        self.mark(unary_union(cl_polys), YELLOW)
        # taxiway centreline lights (green, 30 m) and edge lights (blue, ~50 m on the taxiway edge)
        for part, w, ref in self.twy_cl:
            if part.intersects(apron) and part.difference(apron.buffer(-5)).length < 5:
                continue      # taxilanes inside aprons: no centreline lights
            L = part.length
            n = int(L // 30)
            for k in range(n + 1):
                p = part.interpolate(min(L, 15 + k * 30))
                if rw.buffer(3).contains(p) or apron.buffer(-3).contains(p):
                    continue
                self.light(p.x, p.y, 0.05, L_TWY_G)
        for ring in lines_of(taxi_area.buffer(1.2).boundary):
            seg = ring.difference(unary_union([apron.buffer(6), rw.buffer(10), bl.buffer(10)]))
            for part in lines_of(seg):
                L = part.length
                n = max(1, int(L // 55))
                for k in range(n + 1):
                    p = part.interpolate(L * k / n)
                    self.light(p.x, p.y, 0.35, L_TWY_B)
                    self.fixtures.append((p.x, p.y, 1))

    # ------------------------------------------------------------ holding positions
    def build_holds(self, hold_ways, hold_nodes):
        rw = self.rw_union
        items = []
        for ln, tags in hold_ways:
            items.append((ln, tags))
        for (x, z), tags in hold_nodes:
            # perpendicular line across the taxiway through the node
            best, bd = None, 1e9
            for part, w, ref in self.twy_cl:
                d = part.distance(Point(x, z))
                if d < bd:
                    bd, best = d, (part, w)
            if best is None or bd > 8:
                continue
            part, w = best
            s = part.project(Point(x, z))
            p0 = part.interpolate(max(0, s - 2))
            p1 = part.interpolate(min(part.length, s + 2))
            dx, dz = p1.x - p0.x, p1.y - p0.y
            ln_ = math.hypot(dx, dz) or 1
            nx, nz = -dz / ln_, dx / ln_
            hw = w / 2 + 1.0
            items.append((LineString([(x - nx * hw, z - nz * hw), (x + nx * hw, z + nz * hw)]), tags))
        seen = []
        for ln, tags in items:
            mid = ln.interpolate(0.5, normalized=True)
            if any(mid.distance(m) < 6 for m in seen):
                continue
            seen.append(mid)
            # nearest runway centreline
            best, bd = None, 1e9
            for rf in self.rf:
                cl = LineString([tuple(rf.P(0, 0)), tuple(rf.P(rf.L, 0))])
                d = cl.distance(mid)
                if d < bd:
                    bd, best = d, (rf, cl)
            if best is None or bd > 400:
                continue
            rf, cl = best
            q = nearest_points(cl, mid)[0]
            to_rw = np.array([q.x - mid.x, q.y - mid.y])
            to_rw /= (np.linalg.norm(to_rw) + 1e-9)
            typ = tags.get('holding_position:type', 'runway' if bd < 130 else 'ILS')
            self._hold_marking(ln, to_rw, typ)
            if typ == 'runway':
                self._hold_extras(ln, to_rw, rf, mid)

    def _hold_marking(self, ln, to_rw, typ):
        # extend the line slightly beyond the taxiway edges, clip to paved area
        coords = np.asarray(ln.coords)
        a, b = coords[0], coords[-1]
        d = b - a
        L = np.linalg.norm(d)
        if L < 1:
            return
        u = d / L
        a2, b2 = a - u * 1.5, b + u * 1.5
        base = LineString([tuple(a2), tuple(b2)])
        # make sure 'to_rw' is perpendicular component
        n = np.array([-u[1], u[0]])
        if n @ to_rw < 0:
            n = -n
        polys = []
        if typ == 'ILS':
            for off in (0.0, 1.5):
                polys.append(affinity.translate(base, *(n * (off + 0.15))).buffer(0.15, cap_style='flat'))
            Lb = base.length
            k = 0.0
            while k <= Lb:
                p = np.array(base.interpolate(k).coords[0])
                polys.append(LineString([tuple(p), tuple(p + n * 1.8)]).buffer(0.15, cap_style='flat'))
                k += 3.0
        else:
            # hold side (away from runway): two solid lines; runway side: two dashed lines. 0.3 m lines, 0.3 m gaps
            for j, off in enumerate((-1.95, -1.35, -0.75, -0.15)):
                seg = affinity.translate(base, *(n * off))
                if j < 2:
                    polys.append(seg.buffer(0.15, cap_style='flat'))
                else:
                    Lb = seg.length
                    k = 0.0
                    while k < Lb:
                        polys.append(substring(seg, k, min(Lb, k + 0.9)).buffer(0.15, cap_style='flat'))
                        k += 1.8
        g = unary_union(polys).intersection(self.paved.buffer(0.3))
        self.mark(g, YELLOW)

    def _hold_extras(self, ln, to_rw, rf, mid):
        """Runway guard lights + painted holding position sign + mandatory sign."""
        coords = np.asarray(ln.coords)
        a, b = coords[0], coords[-1]
        u = (b - a) / (np.linalg.norm(b - a) + 1e-9)
        n = np.array([-u[1], u[0]])
        if n @ to_rw < 0:
            n = -n
        away = -n                                   # direction toward the holding aircraft
        hdg_face = (math.degrees(math.atan2(away[0], -away[1]))) % 360      # heading pointing toward holding aircraft
        L = np.linalg.norm(b - a)
        for end, sgn in ((a, -1), (b, 1)):
            p = end + u * sgn * 3.0 + away * 3.0
            self.light(p[0], p[1], 0.6, L_RGL, hdg_face, 0.0 if sgn < 0 else 0.5)
            self.fixtures.append((p[0], p[1], 2))
        # runway designations as seen from the holding aircraft: left = runway direction to the left
        A, B = rf.r['ends']
        dirA = np.array(hdg_vec(A['headingTrue'])[0])   # direction of flight when using end A (toward B)
        # aircraft faces -away (toward runway); its left vector:
        fwd = -away
        left = np.array([fwd[1], -fwd[0]])
        # the designation on the left is the runway end whose landing direction points to the left side... use the
        # direction of travel: arriving from the right toward the left means heading "left"; FAA shows the runway
        # number for the direction to the left on the left.
        keep0 = self.cfg.get('leading_zero', False)
        if dirA @ left > 0:
            txt = f"{nz_ident(B['ident'], keep0)}-{nz_ident(A['ident'], keep0)}"
        else:
            txt = f"{nz_ident(A['ident'], keep0)}-{nz_ident(B['ident'], keep0)}"
        # correct convention: left number = runway end located to the left (you'd take off to the right from it)
        c = np.array(mid.coords[0])
        # painted surface sign on the hold side, left of the centreline
        sign_c = c + away * 8.0 + left * 4.5 * 0 - left * 0.0
        self._painted_sign(sign_c, fwd, txt)
        # mandatory sign (red, white text) beside the taxiway on the left, ~ at the hold line
        p = c - u * 0 + left * (L / 2 + 6.0) + away * 1.0
        if L < 5:
            p = c + left * 18.0 + away * 1.0
        hdg = (math.degrees(math.atan2(away[0], -away[1]))) % 360
        self.signs.append({'x': round(p[0] - self.origin[0], 2), 'z': round(p[1] - self.origin[1], 2), 'h': round(hdg, 1),
                           't': txt, 's': 'mand'})
        # taxiway location sign (yellow on black) outboard of the mandatory sign
        ref = ''
        bd = 1e9
        for part, w, r in getattr(self, 'twy_cl', []):
            dd = part.distance(mid)
            if dd < bd and r:
                bd, ref = dd, r
        if ref and bd < 20:
            q = p + left * 3.2
            self.signs.append({'x': round(q[0] - self.origin[0], 2), 'z': round(q[1] - self.origin[1], 2), 'h': round(hdg, 1),
                               't': ref, 's': 'loc'})

    def _painted_sign(self, c, fwd, txt):
        """Red rectangle with white characters painted on the pavement, readable by the approaching aircraft."""
        gh = 3.6
        tp, tw = text_polygon(txt, h=gh * 0.72, gap=0.3)
        W, H = tw + 1.6, gh
        right = np.array([-fwd[1], fwd[0]])
        def P(x, y):  # x lateral (right), y along fwd
            q = c + right * x + fwd * y
            return (q[0], q[1])
        rect = Polygon([P(-W / 2, -H / 2), P(W / 2, -H / 2), P(W / 2, H / 2), P(-W / 2, H / 2)])
        # text in local coords then mapped
        from shapely.ops import transform
        def f(x, y, z=None):
            xx = np.asarray(x) - tw / 2
            yy = np.asarray(y) - gh * 0.36
            return c[0] + right[0] * xx + fwd[0] * yy, c[1] + right[1] * xx + fwd[1] * yy
        text = transform(f, tp)
        self.mark(rect.difference(text).intersection(self.paved), RED)
        self.mark(text.intersection(self.paved), WHITE)

    # ------------------------------------------------------------ stands, gates, jet bridges
    def build_stands(self, stand_lines, jet_lines, terminals, occupancy=0.72, wide_refs=()):
        term = unary_union(terminals) if terminals else Polygon()
        jet_ends = []
        for ln, tags, wid in jet_lines:
            c = list(ln.coords)
            p0, p1 = Point(c[0]), Point(c[-1])
            # start = end nearest to the terminal
            if p1.distance(term) < p0.distance(term):
                c = c[::-1]
            jet_ends.append({'coords': c, 'ref': tags.get('ref', ''), 'id': wid})
        stops = []
        for ln, tags, wid in stand_lines:
            c = list(ln.coords)
            p0, p1 = Point(c[0]), Point(c[-1])
            d0, d1 = p0.distance(term), p1.distance(term)
            # nearest jet bridge end
            if d0 < d1:
                c = c[::-1]
            end = np.array(c[-1])
            lc = LineString(c)
            prev = np.array(lc.interpolate(max(0, lc.length - 8)).coords[0])
            dvec = end - prev
            if np.linalg.norm(dvec) < 1e-3:
                continue
            dvec /= np.linalg.norm(dvec)
            stops.append({'p': end, 'd': dvec, 'line': LineString(c), 'ref': tags.get('ref', ''), 'id': wid, 'dist_term': min(d0, d1)})
        # lead-in lines (yellow 0.15 m) + stop bars
        polys = []
        for s in stops:
            polys.append(s['line'].buffer(0.15, cap_style='flat'))
            n = np.array([-s['d'][1], s['d'][0]])
            a = s['p'] - n * 2.0
            b = s['p'] + n * 2.0
            polys.append(LineString([tuple(a), tuple(b)]).buffer(0.3, cap_style='flat'))
        self.mark(unary_union(polys).intersection(self.paved.buffer(1)), YELLOW)
        # classify stand size by neighbour spacing
        pts = np.array([s['p'] for s in stops]) if stops else np.zeros((0, 2))
        for i, s in enumerate(stops):
            if len(pts) > 1:
                d = np.linalg.norm(pts - s['p'], axis=1)
                d[i] = 1e9
                nn = d.min()
            else:
                nn = 99
            ref = s['ref']
            wide = nn > 60 or any(ref.startswith(w) for w in wide_refs)
            s['cls'] = 'wide' if wide else 'narrow'
            if nn < 30 or s['dist_term'] > 120:
                s['cls'] = 'remote' if nn >= 30 else 'small'
        # jet bridges -> which stand they serve
        for jb in jet_ends:
            e = np.array(jb['coords'][-1])
            best, bd = None, 1e9
            for s in stops:
                d = np.linalg.norm(s['p'] - e)
                if d < bd:
                    bd, best = d, s
            jb['stand'] = best if bd < 45 else None
        # MARS gates: lead-in lines closer than 30 m form one cluster -> either one widebody on the centre line or
        # narrowbodies on the outer lines (never overlapping aircraft)
        n = len(stops)
        parent = list(range(n))
        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        for i in range(n):
            for j in range(i + 1, n):
                if np.linalg.norm(pts[i] - pts[j]) < 30:
                    parent[find(i)] = find(j)
        clusters = {}
        for i in range(n):
            clusters.setdefault(find(i), []).append(i)
        for members in clusters.values():
            r = self.rng.random()
            if len(members) == 1:
                i = members[0]
                has_jb = any(jb['stand'] is stops[i] for jb in jet_ends)
                stops[i]['occ'] = (stops[i]['cls'] != 'small') and self.rng.random() < (occupancy if has_jb else occupancy * 0.8)
                continue
            for i in members:
                stops[i]['occ'] = False
            if r > occupancy:
                continue
            P = np.array([stops[i]['p'] for i in members])
            c = P.mean(axis=0)
            if len(members) >= 3 and self.rng.random() < 0.45:
                i = members[int(np.argmin(np.linalg.norm(P - c, axis=1)))]
                stops[i]['occ'] = True
                stops[i]['cls'] = 'wide'
            else:
                D = np.linalg.norm(P[:, None] - P[None], axis=2)
                a, b = np.unravel_index(np.argmax(D), D.shape)
                for k in ((a, b) if D[a, b] >= 36 else (a,)):
                    stops[members[k]]['occ'] = True
                    stops[members[k]]['cls'] = 'narrow'
        for i, s in enumerate(stops):
            has_jb = any(jb['stand'] is s for jb in jet_ends)
            hdg = (math.degrees(math.atan2(s['d'][0], -s['d'][1]))) % 360
            self.stands.append({'x': round(s['p'][0] - self.origin[0], 2), 'z': round(s['p'][1] - self.origin[1], 2),
                                'h': round(hdg, 1), 'cls': s['cls'], 'occ': bool(s['occ']), 'ref': s['ref'], 'jb': has_jb})
        # apron floodlight masts behind the parked aircraft, between adjacent stands (on the apron, clear of taxilanes)
        cl = unary_union([p.buffer(14) for p, w, r in getattr(self, 'twy_cl', [])]) if getattr(self, 'twy_cl', None) else Polygon()
        placed = []
        for i, s in enumerate(stops):
            if len(pts) < 2:
                break
            d = np.linalg.norm(pts - s['p'], axis=1)
            d[i] = 1e9
            j = int(np.argmin(d))
            if not (30 < d[j] < 110):
                continue
            mid = (s['p'] + stops[j]['p']) / 2
            back = -(s['d'] + stops[j]['d'])
            nb = np.linalg.norm(back)
            if nb < 1e-3:
                continue
            m = mid + back / nb * 58.0
            pt = Point(*m)
            if not self.apron.buffer(-4).contains(pt) or cl.contains(pt) or any(np.linalg.norm(m - q) < 70 for q in placed):
                continue
            placed.append(m)
            self.props.append({'t': 'floodlight', 'x': round(m[0] - self.origin[0], 2), 'z': round(m[1] - self.origin[1], 2), 'h': 0})
            self.light(m[0], m[1], 25.0, L_FLOOD)
            self.light(m[0], m[1], 26.4, L_OBS)
            self.floods.append([round(m[0] - self.origin[0], 2), round(m[1] - self.origin[1], 2), 25.0])
        for jb in jet_ends:
            s = jb['stand']
            occ = bool(s is not None and s['occ'])
            wide = s is not None and s['cls'] == 'wide'
            c = jb['coords']
            sh = None
            if s is not None:
                sh = round((math.degrees(math.atan2(s['d'][0], -s['d'][1]))) % 360, 1)
            self.jetbridges.append({'c': [[round(x - self.origin[0], 2), round(z - self.origin[1], 2)] for x, z in c],
                                    'occ': occ, 'wide': wide, 'ref': jb['ref'], 'sh': sh,
                                    'sp': [round(s['p'][0] - self.origin[0], 2), round(s['p'][1] - self.origin[1], 2)] if s is not None else None})
        self._stops = stops

    # ------------------------------------------------------------ buildings
    def add_building(self, poly, h, kind, name=None, minh=0.0, osm_id=None, roof='flat', extra=None):
        for p in polys_of(poly):
            if p.area < (4 if kind in ('blast_wall',) else 20):
                continue
            p = p.simplify(0.3)
            c = p.representative_point()
            b = {'id': osm_id or f'b{len(self.buildings)}', 'kind': kind, 'h': round(float(h), 2), 'minh': round(float(minh), 2),
                 'roof': roof, 'name': name or TR.get(kind, 'bina'),
                 'anchor': [round(c.x - self.origin[0], 2), round(c.y - self.origin[1], 2)],
                 'poly': [[round(x - self.origin[0], 2), round(z - self.origin[1], 2)] for x, z in list(p.exterior.coords)[:-1]],
                 'holes': [[[round(x - self.origin[0], 2), round(z - self.origin[1], 2)] for x, z in list(r.coords)[:-1]] for r in p.interiors]}
            # oriented bounding box: [cx, cz, L (long side), W, heading of the long axis (deg)]
            mrr = p.minimum_rotated_rectangle
            cc = list(mrr.exterior.coords)[:4]
            e0 = np.subtract(cc[1], cc[0]); e1 = np.subtract(cc[2], cc[1])
            if np.linalg.norm(e1) > np.linalg.norm(e0):
                e0, e1 = e1, e0
            hd = math.degrees(math.atan2(e0[0], -e0[1])) % 180
            mc = mrr.centroid
            b['obb'] = [round(mc.x - self.origin[0], 2), round(mc.y - self.origin[1], 2), round(float(np.linalg.norm(e0)), 2),
                        round(float(np.linalg.norm(e1)), 2), round(hd, 2)]
            if roof == 'flat' and p.area > 150 and kind not in ('tower_cab',):
                ins = p.buffer(-0.35, join_style='mitre')
                if isinstance(ins, Polygon) and not ins.is_empty and len(ins.interiors) == len(p.interiors):
                    b['inset'] = [[round(x - self.origin[0], 2), round(z - self.origin[1], 2)] for x, z in list(ins.exterior.coords)[:-1]]
                    b['inset_holes'] = [[[round(x - self.origin[0], 2), round(z - self.origin[1], 2)] for x, z in list(r.coords)[:-1]] for r in ins.interiors]
            if kind in ('hangar', 'cargo') and getattr(self, 'paved', None) is not None:
                ring = list(p.exterior.coords)
                best, bl = -1, 0.0
                for k in range(len(ring) - 1):
                    a, c = np.array(ring[k]), np.array(ring[k + 1])
                    d = c - a
                    L = float(np.linalg.norm(d))
                    if L < 12:
                        continue
                    nrm = np.array([d[1], -d[0]]) / L        # right-hand normal (outward for CCW-in-xz rings)
                    mid = (a + c) / 2
                    ok = [self.paved.contains(Point(*(mid + sg * nrm * 20))) for sg in (1, -1)]
                    if any(ok) and L > bl:
                        best, bl = k, L
                b['door_edge'] = best
            if extra:
                b.update(extra)
            self.buildings.append(b)

    # ------------------------------------------------------------ export
    def export(self):
        os.makedirs(OUT, exist_ok=True)
        bw = BinWriter()
        stats = {}
        for k, m in self.surf.items():
            if not m.p:
                continue
            dedupe(m)
            bw.add_mesh('surf.' + k, m, self.origin)
            stats[k] = (len(m.p), len(m.i) // 3)
        dedupe(self.marks)
        # runway coords of the paint (t, s, dA, dB) quantised to int16: 1 cm, 12.5 cm, 20 cm, 20 cm steps
        e = np.asarray(self.marks.attrs.pop('e'), dtype=np.float64)
        bw.add_mesh('marks', self.marks, self.origin, {'c': np.uint8})
        E16_SCALE = np.array([0.01, 0.125, 0.2, 0.2])
        bw.add('marks.e16', np.clip(np.round(e / E16_SCALE), -32767, 32767), np.int16)
        self.marks.attrs['e'] = e.tolist()
        stats['marks'] = (len(self.marks.p), len(self.marks.i) // 3)
        if self.lights:
            L = np.array(self.lights, dtype=np.float64)
            L[:, 0] -= self.origin[0]
            L[:, 1] -= self.origin[1]
            bw.add('lights.pos', L[:, 0:3], np.float32)
            bw.add('lights.type', L[:, 3], np.uint8)
            hd = np.where(np.isnan(L[:, 4]), -1.0, L[:, 4])
            bw.add('lights.hdg', hd, np.float32)
            bw.add('lights.param', L[:, 5], np.float32)
            bw.add('lights.mode', L[:, 6], np.uint8)
        if self.fixtures:
            F = np.array(self.fixtures, dtype=np.float64)
            F[:, 0] -= self.origin[0]
            F[:, 1] -= self.origin[1]
            bw.add('fixtures', F, np.float32)
        man = bw.write(os.path.join(OUT, f'{self.icao.lower()}.bin'))
        meta = {
            'icao': self.icao, 'name': self.apt['name'], 'origin': list(self.origin), 'elevation': self.elev,
            'bin': f'{self.icao.lower()}.bin', 'arrays': man,
            'military': self.apt.get('military', False),
            'papi': [[round(x - self.origin[0], 2), round(z - self.origin[1], 2), round(h, 1)] for x, z, h in self.papi_units],
            'als': self.als, 'stands': self.stands, 'jetbridges': self.jetbridges, 'signs': self.signs, 'props': self.props,
            'buildings': self.buildings, 'structures': self.structures,
            'cables': [[[round(a[0] - self.origin[0], 2), round(a[1] - self.origin[1], 2)], [round(b[0] - self.origin[0], 2), round(b[1] - self.origin[1], 2)]] for a, b in self.cable_lines],
            'radius': self.cfg.get('radius', 3000),
            'floods': self.floods,
            'e16Scale': [0.01, 0.125, 0.2, 0.2],
        }
        meta.update(self.lines_extra)
        save_json(os.path.join(OUT, f'{self.icao.lower()}.json'), meta)
        print(self.icao, 'surfaces', stats, 'lights', len(self.lights), 'buildings', len(self.buildings), 'stands', len(self.stands),
              'jetbridges', len(self.jetbridges), 'signs', len(self.signs), 'bin', os.path.getsize(os.path.join(OUT, f'{self.icao.lower()}.bin')) // 1024, 'KB')


# ==================================================================== SFO / OAK (from OSM)
def classify_building(t, name):
    b = t.get('building', 'yes')
    a = t.get('aeroway')
    n = (name or '').lower()
    if a == 'terminal' or b == 'terminal':
        return 'pier' if 'boarding' in n or t.get('building:part') else 'terminal'
    if b == 'hangar' or a == 'hangar' or 'hangar' in n or 'superbay' in n:
        return 'hangar'
    if t.get('amenity') == 'parking' or 'garage' in n or t.get('parking'):
        return 'garage'
    if t.get('amenity') == 'fire_station' or 'fire' in n:
        return 'fire'
    if b in ('hotel',) or 'hotel' in n or 'hyatt' in n:
        return 'hotel'
    if b in ('train_station', 'transportation'):
        return 'station'
    if 'cargo' in n or b in ('warehouse',):
        return 'cargo'
    if b in ('industrial',):
        return 'industrial'
    if b in ('office', 'commercial', 'college', 'government'):
        return 'office'
    if b in ('service', 'shed', 'garage', 'roof', 'kiosk'):
        return 'service'
    return 'industrial'


def height_of(t, kind, area):
    try:
        h = float(str(t.get('height', '')).replace('m', '').strip())
        try:
            lv = float(t.get('building:levels'))
            if h < lv * 2.6:          # inconsistent tags (e.g. 6-level garage tagged 10 m): trust the levels
                h = lv * 3.1
        except (TypeError, ValueError):
            pass
        if kind == 'hangar':
            h = max(h, 28.0 if area > 3000 else 16.0)
        return h
    except ValueError:
        pass
    if kind == 'hangar':
        return 30.0 if area > 8000 else 26.0 if area > 2000 else 14.0
    lv = t.get('building:levels')
    try:
        lv = float(lv)
        return lv * (5.0 if kind in ('terminal', 'pier') else 3.2 if kind in ('garage',) else 3.8)
    except (TypeError, ValueError):
        pass
    return {'terminal': 20, 'pier': 18, 'hangar': 22 if area > 4000 else 14, 'garage': 18, 'fire': 9, 'hotel': 30,
            'station': 16, 'cargo': 12, 'industrial': 10, 'office': 12, 'service': 5}.get(kind, 8)


def osm_airport(icao, cfg):
    el = osm.load(icao.lower())
    ap = Airport(icao, cfg)
    # stopways from OSM: assign to nearest runway end
    stop = {}
    for ln, t, wid in osm.lines(el, lambda t: t.get('aeroway') == 'stopway'):
        mid = ln.interpolate(0.5, normalized=True)
        best, bd = None, 1e9
        for rf in ap.rf:
            for k, e in enumerate(rf.r['ends']):
                d = math.hypot(e['x'] - mid.x, e['z'] - mid.y)
                if d < bd:
                    bd, best = d, e['ident']
        if bd < 250:
            stop[best] = max(stop.get(best, 0), round(ln.length, 1))
    ap.build_runways(stop)
    rw = ap.rw_union
    # taxiways
    wdef = cfg.get('taxi_width', 23.0)
    taxi = []
    for ln, t, wid in osm.lines(el, lambda t: t.get('aeroway') in ('taxiway', 'taxilane')):
        if cfg.get('taxi_clip') is not None and not cfg['taxi_clip'].intersects(ln):
            continue
        w = cfg.get('taxilane_width', 16.0) if t.get('aeroway') == 'taxilane' else wdef
        if cfg.get('width_fn'):
            w = cfg['width_fn'](ln, t, w)
        taxi.append((ln, w, t.get('ref', '')))
    aprons = [g for g, t, i, ty in osm.polygons(el, lambda t: t.get('aeroway') == 'apron')]
    if cfg.get('apron_clip') is not None:
        aprons = [a.intersection(cfg['apron_clip']) for a in aprons]
    ap.build_ground(taxi, aprons)
    hw = [(ln, t) for ln, t, i in osm.lines(el, lambda t: t.get('aeroway') == 'holding_position')]
    hn = [(p, t) for p, t, i in osm.nodes(el, lambda t: t.get('aeroway') == 'holding_position')]
    ap.build_holds(hw, hn)
    # terminals (for stand orientation)
    terms = [g for g, t, i, ty in osm.polygons(el, lambda t: t.get('aeroway') == 'terminal' or t.get('building') == 'terminal')]
    stands = list(osm.lines(el, lambda t: t.get('aeroway') == 'parking_position'))
    jets = list(osm.lines(el, lambda t: t.get('aeroway') == 'jet_bridge'))
    ap.build_stands(stands, jets, terms, wide_refs=cfg.get('wide_refs', ()))
    return ap, el


def airport_zone(ap, extra=()):
    z = unary_union([ap.paved.buffer(120)] + list(extra))
    return z


def collect_buildings(ap, el, zone, skip_ids=(), overrides=None):
    overrides = overrides or {}
    zp = zone
    n = 0
    for g, t, oid, typ in osm.polygons(el, lambda t: ('building' in t or t.get('aeroway') in ('terminal', 'hangar')) and
                                       t.get('building') not in ('residential', 'house', 'detached', 'semidetached_house', 'apartments', 'terrace', 'houseboat')):
        key = f'{typ[0]}{oid}'
        if oid in skip_ids:
            ap.exclude_ids.append(key)
            continue
        c = g.representative_point()
        if not zp.contains(c):
            continue
        if t.get('building:part') and t.get('aeroway') != 'terminal':
            continue
        name = t.get('name')
        kind = classify_building(t, name)
        h = height_of(t, kind, g.area)
        minh = 0.0
        try:
            minh = float(t.get('min_height', 0))
        except ValueError:
            pass
        if oid in overrides:
            o = overrides[oid]
            kind = o.get('kind', kind)
            h = o.get('h', h)
            minh = o.get('minh', minh)
            name = o.get('name', name)
        if int(t.get('layer', 0) or 0) >= 1 and minh == 0 and kind not in ('terminal', 'pier', 'garage', 'station', 'hotel', 'office'):
            pass
        base = TR.get(kind, 'bina')
        disp = name if kind == 'tower_cab' else (f'{base} ({name})' if name else base)
        ap.add_building(g, h, kind, name=disp, minh=minh, osm_id=key, roof=t.get('roof:shape', 'flat'))
        ap.exclude_ids.append(key)
        n += 1
    return n


def build_ksfo():
    cfg = {
        'priority': ['10L/28R', '10R/28L', '01R/19L', '01L/19R'],
        'marking': 'P',
        'ends': {
            '28R': {'disp': 96.0, 'als': 'ALSF2', 'papi': 'L', 'tdz': True},
            '28L': {'disp': 90.0, 'als': 'ALSF2', 'papi': 'L', 'tdz': True},
            '10L': {'papi': 'L', 'tdz': False},
            '10R': {'papi': 'L', 'tdz': False},
            '19L': {'als': 'MALSR', 'papi': 'L', 'tdz': True},
            '01R': {'disp': 171.0, 'papi': 'L'},
            '01L': {'disp': 205.0, 'papi': 'L'},
            '19R': {'papi': 'R'},
        },
        'taxi_width': 23.0, 'taxilane_width': 18.0,
        'wide_refs': ('A', 'G'),
        'radius': 3500,
    }
    ap, el = osm_airport('KSFO', cfg)
    # SFO special structures
    ap.structures.append({'kind': 'sfo_tower'})
    zone = airport_zone(ap)
    # include the terminal core (garages, AirTrain station, hotel) and the maintenance base
    core = Polygon([(-1900, -700), (-1250, -1100), (-300, -1450), (400, -1300), (300, 900), (-1200, 1500), (-2000, 900)])
    zone = unary_union([zone, core]).intersection(box(-2300, -2100, 2400, 1700))
    overrides = {
        554547693: {'kind': 'tower_cab', 'name': 'SFO kulesi'},
    }
    n = collect_buildings(ap, el, zone, overrides=overrides)
    for g, t, oid, typ in osm.polygons(el, lambda t: t.get('aeroway') == 'tower'):
        ap.add_building(g, float(t.get('height', 67.36)), 'tower_cab', name='SFO kulesi', minh=float(t.get('min_height', 60)), osm_id=f'w{oid}')
        ap.exclude_ids.append(f'w{oid}')
    for b in ap.buildings:
        if b['kind'] == 'tower_cab':
            pts = np.array(b['poly'])
            area = Polygon(pts).area
            cx, cz = Polygon(pts).centroid.coords[0]
            twr = next(st for st in ap.structures if st['kind'] == 'sfo_tower')
            twr.update({'x': round(cx, 2), 'z': round(cz, 2), 'r': round(math.sqrt(area / math.pi), 2),
                                     'cab0': b['minh'], 'top': b['h'], 'collide': [round(cx, 2), round(cz, 2), 7.0, b['minh']],
                                     'name': 'SFO kulesi'})
            ap.light(cx + ap.origin[0], cz + ap.origin[1], b['h'] + 6.5, L_OBS_FL)
            ap.light(cx + ap.origin[0] + 1.2, cz + ap.origin[1], b['h'] + 4.0, L_BEACON)
    # AirTrain guideway (elevated monorail)
    air = []
    for ln, t, wid in osm.lines(el, lambda t: t.get('railway') == 'monorail'):
        air.append([[round(x - ap.origin[0], 2), round(z - ap.origin[1], 2)] for x, z in ln.coords])
    ap.lines_extra['airtrain'] = air
    # windsocks near runway ends + the OSM one
    for p, t, i in osm.nodes(el, lambda t: t.get('aeroway') == 'windsock'):
        ap.props.append({'t': 'windsock', 'x': round(p[0] - ap.origin[0], 2), 'z': round(p[1] - ap.origin[1], 2), 'h': 0})
    add_windsocks(ap, ('28R', '28L', '19L', '01R'))
    ap.structures_zone = zone
    return ap


def add_windsocks(ap, idents):
    for rf in ap.rf:
        for which, e in enumerate(rf.r['ends']):
            if e['ident'] in idents:
                ef = EndFrame(rf, which)
                x, z = ef.P(300.0, -(rf.w / 2 + 75))
                ap.props.append({'t': 'windsock', 'x': round(x - ap.origin[0], 2), 'z': round(z - ap.origin[1], 2), 'h': 0})
                ap.light(x, z, 6.5, L_OBS)


def build_koak():
    cfg = {
        'priority': ['12/30', '10R/28L', '10L/28R', '15/33'],
        'marking': 'P',
        'ends': {
            '30': {'als': 'ALSF2', 'papi': 'L', 'tdz': True},
            '12': {'papi': 'L', 'als': 'MALSR', 'tdz': True},
            '28R': {'papi': 'L', 'marking': 'NP'}, '10L': {'papi': 'L', 'marking': 'NP'},
            '28L': {'papi': 'L', 'marking': 'NP', 'als': 'MALSR'}, '10R': {'papi': 'L', 'marking': 'NP'},
            '15': {'marking': 'V'}, '33': {'marking': 'V'},
        },
        'taxi_width': 23.0, 'taxilane_width': 15.0,
        'radius': 3000,
    }
    def wfn(ln, t, w):
        c = ln.centroid
        return 15.0 if c.y < -11600 and t.get('aeroway') == 'taxiway' else w   # north field (GA): narrower
    cfg['width_fn'] = wfn
    ap, el = osm_airport('KOAK', cfg)
    zone = airport_zone(ap)
    collect_buildings(ap, el, zone)
    for g, t, oid, typ in osm.polygons(el, lambda t: t.get('aeroway') == 'tower'):
        top = float(t.get('height', 72))
        c = g.centroid
        r = max(4.5, math.sqrt(g.area / math.pi))
        cx, cz = c.x - ap.origin[0], c.y - ap.origin[1]
        ap.structures.append({'kind': 'tower_generic', 'x': round(cx, 2), 'z': round(cz, 2), 'r': round(r, 2), 'cab0': round(top - 7.5, 2),
                              'top': top, 'collide': [round(cx, 2), round(cz, 2), 4.5, top], 'name': 'Oakland kulesi'})
        ap.exclude_ids.append(f'w{oid}')
        ap.light(c.x, c.y, top + 4.5, L_OBS_FL)
        ap.light(c.x + 1.0, c.y, top + 2.5, L_BEACON)
    add_windsocks(ap, ('30', '28L'))
    return ap


# ==================================================================== İstanbul (GEO_REGION=ist): LTFM, LTFJ, LTBA from OSM
def grid_rot(ap):
    """Apron / taxiway texture grid rotation (radians, like the runtime's San Francisco constants) =
    -(main runway heading mod 90 deg); src/world-sf/airports.js reads meta.gridRot."""
    h = ap.rf[0].r['ends'][0]['headingTrue']
    return round(math.radians(-(h % 90.0)), 5)


def osm_tower(ap, el, name, oid=None, default_h=60.0):
    """Control tower from an OSM man_made=tower / aeroway=tower polygon -> 'tower_generic' structure (+ lights)."""
    best = None
    for g, t, i, ty in osm.polygons(el, lambda t: t.get('man_made') == 'tower' or t.get('aeroway') == 'tower'):
        if oid is not None and i != oid:
            continue
        h = None
        try:
            h = float(str(t.get('height', '')).replace('m', '').strip())
        except ValueError:
            pass
        if best is None or (h or 0) > (best[1] or 0):
            best = (g, h, i)
    if best is None:
        return
    g, h, i = best
    top = h or default_h
    c = g.centroid
    r = max(4.5, min(9.0, math.sqrt(g.area / math.pi)))
    cx, cz = c.x - ap.origin[0], c.y - ap.origin[1]
    ap.structures.append({'kind': 'tower_generic', 'x': round(cx, 2), 'z': round(cz, 2), 'r': round(r, 2), 'cab0': round(top - 9.0, 2),
                          'top': top, 'collide': [round(cx, 2), round(cz, 2), r, top], 'name': name})
    ap.exclude_ids.append(f'w{i}')
    ap.light(c.x, c.y, top + 4.5, L_OBS_FL)
    ap.light(c.x + 1.0, c.y, top + 2.5, L_BEACON)
    return i


def ist_airport(icao, cfg, tower_name, tower_id=None, core=None):
    ap, el = osm_airport(icao, cfg)
    zone = airport_zone(ap)
    ad = [g for g, t, i, ty in osm.polygons(el, lambda t: t.get('aeroway') == 'aerodrome')]
    if core is not None:
        zone = unary_union([zone, core])
    if ad:
        # terminal / cargo / maintenance areas inside the aerodrome fence (not the neighbourhoods around it)
        zone = unary_union([zone, unary_union(ad).buffer(0).intersection(ap.paved.buffer(700))])
    tid = osm_tower(ap, el, tower_name, tower_id)
    collect_buildings(ap, el, zone, skip_ids=(tid,) if tid else ())
    for p, t, i in osm.nodes(el, lambda t: t.get('aeroway') == 'windsock'):
        ap.props.append({'t': 'windsock', 'x': round(p[0] - ap.origin[0], 2), 'z': round(p[1] - ap.origin[1], 2), 'h': 0})
    ap.lines_extra['gridRot'] = grid_rot(ap)
    ap.structures_zone = zone
    return ap


def all_ends(icao, **kw):
    apt = next(a for a in RUNWAYS['airports'] if a['icao'] == icao)
    out = {}
    for r in apt['runways']:
        for e in r['ends']:
            c = dict(kw)
            if e.get('displaced'):
                c['disp'] = e['displaced']
            out[e['ident']] = c
    return out


def build_ltfm():
    apt = next(a for a in RUNWAYS['airports'] if a['icao'] == 'LTFM')
    cfg = {
        'priority': [r['id'] for r in apt['runways']],
        'marking': 'P', 'leading_zero': True,
        # CAT II/III ILS on every runway end (ALSF-2 is the closest approach-light layout the runtime draws)
        'ends': all_ends('LTFM', als='ALSF2', papi='L', tdz=True),
        'taxi_width': 23.0, 'taxilane_width': 18.0,
        'radius': 5500,
    }
    ap = ist_airport('LTFM', cfg, 'İstanbul Havalimanı kulesi', 572703385)
    add_windsocks(ap, ('34R', '35L', '16L', '17R'))
    return ap


def build_ltfj():
    apt = next(a for a in RUNWAYS['airports'] if a['icao'] == 'LTFJ')
    cfg = {
        'priority': ['06R/24L', '06L/24R'],
        'marking': 'P', 'leading_zero': True,
        'ends': {'06R': {'als': 'ALSF2', 'papi': 'L', 'tdz': True}, '24L': {'als': 'MALSR', 'papi': 'L', 'tdz': True},
                 '06L': {'als': 'ALSF2', 'papi': 'L', 'tdz': True}, '24R': {'als': 'MALSR', 'papi': 'L', 'tdz': True}},
        'taxi_width': 23.0, 'taxilane_width': 16.0,
        'radius': 3500,
    }
    ap = ist_airport('LTFJ', cfg, 'Sabiha Gökçen kulesi', 1159751665)
    add_windsocks(ap, ('06L', '24R'))
    return ap


def build_ltba():
    cfg = {
        'priority': ['05/23'],
        'marking': 'P', 'leading_zero': True,
        'ends': all_ends('LTBA', papi='L', tdz=True),
        'taxi_width': 23.0, 'taxilane_width': 16.0,
        'radius': 3000,
    }
    cfg['ends']['05']['als'] = 'ALSF2'
    cfg['ends']['23']['als'] = 'MALSR'
    ap = ist_airport('LTBA', cfg, 'Atatürk kulesi', 245003917)
    add_windsocks(ap, ('05', '23'))
    return ap


# ==================================================================== main
def main():
    default = ['ksfo', 'koak', 'kngz'] if REGION_ID == 'sf' else [a['icao'].lower() for a in RUNWAYS['airports']]
    which = [a.lower() for a in sys.argv[1:]] or default
    excl = {}
    ex_path = os.path.join(OUT, 'exclusions.json')
    if os.path.exists(ex_path):
        excl = json.load(open(ex_path)).get('airports', {})
    for w in which:
        if w == 'ksfo':
            ap = build_ksfo()
        elif w == 'koak':
            ap = build_koak()
        elif w == 'kngz':
            import airports_kngz
            ap = airports_kngz.build(Airport)
        elif w in ('ltfm', 'ltfj', 'ltba'):
            ap = {'ltfm': build_ltfm, 'ltfj': build_ltfj, 'ltba': build_ltba}[w]()
        else:
            continue
        ap.export()
        zone = getattr(ap, 'structures_zone', None) or ap.paved.buffer(60)
        zone = zone.simplify(5)
        excl[ap.icao] = {'osmIds': sorted(set(ap.exclude_ids)),
                         'zones': [[[round(x, 1), round(z, 1)] for x, z in p.exterior.coords] for p in polys_of(zone)]}
    # which aircraft-agent LOD files exist (the runtime skips missing ones instead of producing 404s)
    man_p = os.path.join(OUT, 'manifest.json')
    man = json.load(open(man_p)) if os.path.exists(man_p) else {}
    man['lods'] = {aid: os.path.exists(os.path.join(ROOT, 'assets', 'aircraft', aid, f'{aid}_lod.glb'))
                   for aid in ('a320neo', 'b737', 'f16', 'f22', 'uh60')}
    if REGION_ID != 'sf':
        # other maps reuse San Francisco's generic ground textures and props (same files: one download, one cache entry)
        man['airports'] = [a['icao'].lower() for a in RUNWAYS['airports']]
        man['tex'] = 'assets/sf/airports/tex/'
        man['props'] = 'assets/sf/airports/props.glb'
    json.dump(man, open(man_p, 'w'), indent=1)
    save_json(ex_path, {'note': 'W4 airports: generic city buildings must not be generated for these OSM ids (w=way, r=relation) '
                                'or with a centroid inside these local-coordinate polygons (airside + modelled airport buildings).',
                        'airports': excl})


if __name__ == '__main__':
    main()
