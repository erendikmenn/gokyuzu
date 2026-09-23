"""KNGZ "Alameda Hava Üssü" — fictional (realistic) military air base on Alameda Point, designed procedurally.

Runway frame of 06/24: s along from the 06 threshold toward 24, t lateral (t > 0 = south side, t < 0 = north side).
Land (alameda_land_local.json): the south side is continuous (t up to ~225 at the 06 end, 550–1200 further east);
the north side is very wide in the west (t down to -1400) but narrows to nothing near the 24 end.
  South: parallel taxiway A (t = +180), EOR (arm/de-arm) pads at both ends, flight-line apron with two fighter rows,
         3 maintenance hangars, hush house, control tower + ops, crash/fire station, helicopter apron with 4 helipads
         + helicopter hangar, base buildings, main gate on the east fence.
  North: taxiway B (t = -180, s 0..820) with its own connectors, squadron loop with 10 hardened aircraft shelters (HAS)
         and blast walls, fuel farm, ASR radar.
  Runway: concrete, military markings, BAK-12 arresting cables 457 m from both thresholds, 300 m overruns,
         distance remaining markers, SSALR both ends, PAPIs.
"""
import math, json, os
import numpy as np
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union
from shapely import affinity
from airports_lib import *
from airports_build import (L_FLOOD, L_OBS, L_BEACON, L_HELI_Y, L_HELI_G, L_OBS_FL, TR)

ALAMEDA = json.load(open(os.path.join(ROOT, 'data', 'sf', 'alameda_land_local.json')))['coordsLocal']


def build(Airport):
    cfg = {
        'priority': ['06/24'],
        'marking': 'P',
        'leading_zero': True,
        'ends': {
            '06': {'als': 'SSALR', 'papi': 'L', 'tdz': True, 'blast': 300.0, 'cables': [457.0], 'papi_s': 300.0},
            '24': {'als': 'SSALR', 'papi': 'L', 'tdz': True, 'blast': 300.0, 'cables': [457.0], 'papi_s': 300.0},
        },
        'radius': 2200,
        'land': Polygon(ALAMEDA).buffer(0),
        'gap_fill': 0,
    }
    ap = Airport('KNGZ', cfg)
    rf = ap.rf[0]
    ap.build_runways({})
    land = Polygon(ALAMEDA).buffer(0)
    O = ap.origin

    def P(s, t):
        return tuple(rf.P(s, t))

    def rel(x, z):
        return [round(x - O[0], 2), round(z - O[1], 2)]

    def rect(s0, s1, t0, t1):
        return rf.rect(s0, s1, t0, t1)

    def line(*pts):
        return LineString([P(s, t) for s, t in pts])

    H_S = rf.r['ends'][0]['headingTrue']        # 75: direction of +s
    H_N = (H_S - 90) % 360                      # direction of -t (north-ish)
    H_SO = (H_S + 90) % 360                     # direction of +t (south-ish)

    # ------------------------------------------------------------ taxiways
    TA, TB = 180.0, -180.0
    W = 23.0
    taxi = [(line((-10, TA), (2710, TA)), W, 'A')]
    for k, s in enumerate((0.0, 700.0, 1350.0, 2000.0, 2700.0)):
        taxi.append((line((s, TA), (s, 0.0)), W, f'A{k + 1}'))
    taxi.append((line((-10, TB), (830, TB)), W, 'B'))
    for k, s in enumerate((0.0, 820.0)):
        taxi.append((line((s, TB), (s, 0.0)), W, f'B{k + 1}'))
    LOOP_T = -420.0
    taxi.append((line((260, TB), (260, LOOP_T), (740, LOOP_T), (740, TB)), 18.0, 'S'))
    taxi.append((line((1350, TA), (1350, 205)), W, ''))
    taxi.append((line((2100, TA), (2100, 230)), 18.0, 'H'))
    # arm / de-arm pads (EOR) between runway and the parallel taxiways at the runway ends
    EOR = ((8.0, 190.0, 70.0, 172.0), (2510.0, 2692.0, 70.0, 172.0), (8.0, 190.0, -172.0, -70.0))   # join end connector + parallel taxiway
    eor = [rect(*e) for e in EOR]
    apron_main = rect(880.0, 1720.0, 195.0, 330.0)
    apron_heli = rect(1960.0, 2280.0, 225.0, 335.0)
    has_list = []
    HAS_W, HAS_L, HAS_H = 22.0, 38.0, 9.5
    for k in range(5):
        s = 300.0 + k * 100.0
        has_list.append((s, LOOP_T - 30.0 - HAS_L / 2, H_SO, -1))       # north row, door faces the loop (south)
        if k < 4:
            has_list.append((s + 50.0, LOOP_T + 30.0 + HAS_L / 2, H_N, 1))   # south row (staggered), door faces north
    has_pads = []
    for s, t, hd, row in has_list:
        t_door = t - row * HAS_L / 2 if row == 1 else t + HAS_L / 2
        lo, hi = min(t_door, LOOP_T), max(t_door, LOOP_T)
        has_pads.append(unary_union([rect(s - 16.0, s + 16.0, lo, hi), rect(s - HAS_W / 2 + 0.5, s + HAS_W / 2 - 0.5, min(t, t_door), max(t, t_door))]))
    aprons = [a.intersection(land) for a in [apron_main, apron_heli] + has_pads + eor]
    ap.build_ground(taxi, aprons, fillet=12.0)

    # ------------------------------------------------------------ arm / de-arm pad markings: red boundary, 3 positions
    for (s0, s1, t0, t1) in EOR:
        s0, s1 = (s0 + 22.0, s1) if s0 < 100 else (s0, s1 - 22.0)       # keep the marked box clear of the connector
        t0, t1 = (t0, t1 - 18.0) if t0 > 0 else (t0 + 18.0, t1)         # ... and of the parallel taxiway
        box_ = rect(s0 + 2, s1 - 2, t0 + 2, t1 - 2)
        ap.mark(box_.exterior.buffer(0.2, cap_style='flat').intersection(land), RED)
        tm = (t0 + t1) / 2
        for k in range(3):
            sc = s0 + 25.0 + k * 50.0
            # aircraft face the runway (t -> 0): lead line across the pad, T-bar at the nose position
            nose_t = tm - 12.0 if tm > 0 else tm + 12.0
            ap.mark(LineString([P(sc, t1 - 4 if tm > 0 else t0 + 4), P(sc, nose_t)]).buffer(0.15, cap_style='flat'), YELLOW)
            ap.mark(LineString([P(sc - 2.0, nose_t), P(sc + 2.0, nose_t)]).buffer(0.3, cap_style='flat'), YELLOW)

    # ------------------------------------------------------------ runway holding positions on every connector
    holds = []
    for s in (0.0, 700.0, 1350.0, 2000.0, 2700.0):
        holds.append((LineString([P(s - 12.5, 76.0), P(s + 12.5, 76.0)]), {'holding_position:type': 'runway'}))
    for s in (0.0, 820.0):
        holds.append((LineString([P(s - 12.5, -76.0), P(s + 12.5, -76.0)]), {'holding_position:type': 'runway'}))
    ap.build_holds(holds, [])

    # ------------------------------------------------------------ helipads
    pads_s = (2000.0, 2080.0, 2160.0, 2240.0)
    ef0 = EndFrame(rf, 0)
    for s in pads_s:
        c = Point(*P(s, 280.0))
        ap.mark(c.buffer(12.0, 48).difference(c.buffer(11.3, 48)), WHITE)
        ap.mark(c.buffer(15.0, 48).difference(c.buffer(14.6, 48)), YELLOW)
        hp, hw = text_polygon('H', h=6.0, gap=0.0, s=0.9)
        ap.mark(place_poly(hp, c.x, c.y, H_SO, hw / 2, 3.0), WHITE)      # readable when arriving from the taxiway
        cx, cz = c.x, c.y
        for j in range(12):
            a = 2 * math.pi * j / 12
            ap.light(cx + 12.6 * math.cos(a), cz + 12.6 * math.sin(a), 0.1, L_HELI_Y if j % 2 else L_HELI_G)

    # ------------------------------------------------------------ stands
    rng = ap.rng
    lead = []
    k = 0
    for row_t in (245.0, 300.0):
        for j in range(16):
            s = 910.0 + j * 50.0
            if 1325 < s < 1375:
                continue
            nose_t = row_t - 6.0
            x, z = P(s, nose_t)
            model = 'f22' if (j % 5 == 2 and row_t > 260) else 'f16'
            ap.stands.append({'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_N, 1), 'cls': 'fighter',
                              'occ': rng.random() < 0.8, 'ref': f'P{k + 1}', 'jb': False, 'model': model})
            lead.append(LineString([P(s, row_t + 9.0), P(s, nose_t - 2.0)]).buffer(0.15, cap_style='flat'))
            lead.append(LineString([P(s - 1.5, nose_t), P(s + 1.5, nose_t)]).buffer(0.25, cap_style='flat'))
            k += 1
    # apron edge / wingtip clearance line (red) along the back of the flight line
    lead_red = LineString([P(885.0, 322.0), P(1715.0, 322.0)]).buffer(0.15, cap_style='flat')
    ap.mark(unary_union(lead), YELLOW)
    ap.mark(lead_red, RED)
    for i, (s, t, hd, row) in enumerate(has_list):
        nose_t = t + (HAS_L / 2 - 9.0) if row == -1 else t - (HAS_L / 2 - 9.0)
        x, z = P(s, nose_t)
        ap.stands.append({'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(hd, 1), 'cls': 'fighter_has',
                          'occ': rng.random() < 0.7, 'ref': f'HAS{i + 1}', 'jb': False, 'model': 'f22' if i % 4 == 1 else 'f16'})
        t_door = t + HAS_L / 2 if row == -1 else t - HAS_L / 2
        ap.mark(LineString([P(s, LOOP_T), P(s, t_door + (-2.0 if row == -1 else 2.0))]).buffer(0.15, cap_style='flat'), YELLOW)
    for s, occ in zip(pads_s, (True, False, True, False)):
        x, z = P(s, 282.0)
        ap.stands.append({'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_N, 1), 'cls': 'heli', 'occ': occ,
                          'ref': 'H', 'jb': False, 'model': 'uh60'})

    # ------------------------------------------------------------ buildings / structures
    def bld(s, t, w, d, h, kind, name, door_hdg, extra=None):
        """Rectangular building w (along s) x d (along t) centred at (s, t); rect = [cx, cz, w, d, doorHdg, sHdg]."""
        poly = rect(s - w / 2, s + w / 2, t - d / 2, t + d / 2)
        cx, cz = P(s, t)
        e = {'rect': rel(cx, cz) + [w, d, round(door_hdg, 2), round(H_S, 2)]}
        if extra:
            e.update(extra)
        ap.add_building(poly, h, kind, name=name, extra=e)

    for i, (s, t, hd, row) in enumerate(has_list):
        bld(s, t, HAS_W, HAS_L, HAS_H, 'has', 'sığınak (HAS)', hd, {'num': i + 1})
        t_front = t + HAS_L / 2 if row == -1 else t - HAS_L / 2
        dirt = 1 if row == -1 else -1
        for side in (-1, 1):
            bld(s + side * (HAS_W / 2 + 7.0), t_front + dirt * 8.0, 1.2, 15.0, 4.5, 'blast_wall', 'patlama duvarı', hd)
    for i, s in enumerate((1010.0, 1180.0, 1520.0)):
        bld(s, 372.0, 72.0, 56.0, 21.0, 'hangar_mil', 'bakım hangarı', H_N, {'num': i + 1})
    bld(840.0, 262.0, 30.0, 44.0, 12.0, 'hush_house', 'motor test binası', (H_S + 180) % 360)
    bld(1800.0, 360.0, 10.0, 10.0, 36.0, 'tower_mil', 'Alameda kulesi', H_N)
    tx, tz = P(1800.0, 360.0)
    ap.structures.append({'kind': 'tower_mil', 'x': rel(tx, tz)[0], 'z': rel(tx, tz)[1], 'h': 36.0, 'face': round(H_N, 2),
                          'collide': rel(tx, tz) + [6.0, 40.0], 'name': 'Alameda kulesi'})
    bld(1850.0, 385.0, 62.0, 26.0, 11.0, 'ops', 'harekat merkezi', H_N)
    bld(1880.0, 242.0, 52.0, 26.0, 8.5, 'fire_mil', 'itfaiye (ARFF)', H_N)
    bld(2040.0, 372.0, 64.0, 44.0, 15.0, 'heli_hangar', 'helikopter hangarı', H_N)
    base = [
        (1260.0, 470.0, 70.0, 22.0, 13.0, 'hq', 'karargah'),
        (1360.0, 470.0, 50.0, 18.0, 10.0, 'office_mil', 'filo harekat'),
        (1260.0, 540.0, 80.0, 16.0, 13.0, 'barracks', 'koğuş'),
        (1370.0, 540.0, 80.0, 16.0, 13.0, 'barracks', 'koğuş'),
        (1260.0, 605.0, 60.0, 20.0, 7.0, 'office_mil', 'yemekhane'),
        (1500.0, 470.0, 90.0, 30.0, 10.0, 'warehouse_mil', 'ikmal deposu'),
        (1520.0, 560.0, 40.0, 20.0, 8.0, 'office_mil', 'revir'),
        (1640.0, 470.0, 60.0, 24.0, 9.0, 'warehouse_mil', 'depo'),
        (2450.0, 330.0, 70.0, 20.0, 10.0, 'barracks', 'koğuş'),
        (2450.0, 400.0, 70.0, 20.0, 10.0, 'barracks', 'koğuş'),
        (2560.0, 360.0, 40.0, 30.0, 7.0, 'office_mil', 'güvenlik amirliği'),
    ]
    for s, t, w, d, h, kind, name in base:
        bld(s, t, w, d, h, kind, name, H_N)
    # fuel farm on the north side (far from everything)
    for s, t in ((620.0, -880.0), (650.0, -880.0), (620.0, -910.0), (650.0, -910.0)):
        x, z = P(s, t)
        ap.add_building(Point(x, z).buffer(9.0, 24), 12.0, 'fuel_tank', name='yakıt tankı', extra={'circle': rel(x, z) + [9.0]})
    berm = rect(595.0, 675.0, -935.0, -855.0)
    ap.structures.append({'kind': 'berm', 'poly': [rel(x, z) for x, z in list(berm.exterior.coords)[:-1]], 'h': 1.8})
    bld(635.0, -835.0, 30.0, 12.0, 5.0, 'service_mil', 'yakıt ikmal', H_SO)
    taxi_road = line((635.0, -829.0), (635.0, LOOP_T - 80.0))
    ap.lines_extra['roads'] = [[rel(*c) for c in taxi_road.coords]]
    x, z = P(1100.0, -800.0)
    ap.structures.append({'kind': 'radar', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': 22.0, 'collide': rel(x, z) + [4.0, 24.0], 'name': 'radar kulesi'})
    ap.light(x, z, 23.5, L_OBS_FL)

    # ------------------------------------------------------------ lights: floodlight masts, beacon, obstruction
    masts = [(s, 335.0) for s in np.arange(900.0, 1741.0, 105.0)]
    masts += [(s, LOOP_T - 8.0) for s in (280.0, 440.0, 600.0, 760.0)]
    masts += [(1960.0, 338.0), (2280.0, 338.0)]
    for s, t in masts:
        x, z = P(s, t)
        ap.props.append({'t': 'floodlight', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_N if t > 0 else H_SO, 1)})
        ap.light(x, z, 25.0, L_FLOOD)
        ap.light(x, z, 26.4, L_OBS)
        ap.floods.append(rel(x, z) + [25.0])
    ap.light(tx, tz, 39.5, L_BEACON)
    for s, t, hh in ((1010.0, 372.0, 21.5), (1180.0, 372.0, 21.5), (1520.0, 372.0, 21.5), (2040.0, 372.0, 15.5)):
        for ds, dt_ in ((-35.5, -27.5), (35.5, -27.5), (-35.5, 27.5), (35.5, 27.5)):
            x, z = P(s + ds * (0.9 if hh < 20 else 1.0), t + dt_ * (0.8 if hh < 20 else 1.0))
            ap.light(x, z, hh, L_OBS)
    for s, t in ((320.0, 75.0 + 40), (2380.0, -75.0 - 40)):
        x, z = P(s, t)
        ap.props.append({'t': 'windsock', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': 0})
        ap.light(x, z, 6.5, L_OBS)
    for j in range(4):
        x, z = P(1862.0 + j * 12.0, 222.0)
        ap.props.append({'t': 'fire_truck', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_N, 1)})
    for j in range(3):
        x, z = P(610.0 + j * 10.0, -815.0)
        ap.props.append({'t': 'fuel_truck_mil', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_SO, 1)})
    for j in range(6):
        x, z = P(1700.0 + j * 7.0, 318.0)
        ap.props.append({'t': 'hmmwv', 'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_S, 1)})

    # ------------------------------------------------------------ distance remaining markers (both edges)
    L = rf.L
    n = int(L / FT / 1000)
    for k in range(1, n + 1):
        for which in (0, 1):
            # seen by aircraft rolling toward end B (which = 0) or toward end A (which = 1); k thousand feet remaining
            s = L - k * 1000 * FT if which == 0 else k * 1000 * FT
            face = (H_S + 180) % 360 if which == 0 else H_S
            for side in (-1, 1):
                x, z = P(s + (0.2 if which == 0 else -0.2), side * (22.5 + 16.0))
                ap.signs.append({'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(face, 1), 't': str(k), 's': 'drm'})
    for s, ref, t in ((0.0, 'A1', 1), (700.0, 'A2', 1), (1350.0, 'A3', 1), (2000.0, 'A4', 1), (2700.0, 'A5', 1), (0.0, 'B1', -1), (820.0, 'B2', -1)):
        x, z = P(s - 18.0, t * 90.0)
        ap.signs.append({'x': rel(x, z)[0], 'z': rel(x, z)[1], 'h': round(H_SO if t > 0 else H_N, 1), 't': ref, 's': 'loc'})

    # ------------------------------------------------------------ perimeter fence + main gate (east fence, south side)
    # base zone (fence line): keeps the historic NAS Alameda hangars south-east of the runway outside (t > 545, s > 1850)
    zone = land.intersection(unary_union([rect(-900.0, 1850.0, -2000.0, 700.0), rect(1850.0, 2790.0, -2000.0, 545.0)]))
    fence = zone.buffer(-15.0)
    gx, gz = P(2790.0 - 15.0, 420.0)
    ap.lines_extra['fence'] = [[rel(x, z) for x, z in r.coords] for p in polys_of(fence) for r in [p.exterior]]
    ap.lines_extra['gate'] = rel(gx, gz) + [round(H_S, 1)]
    ap.structures.append({'kind': 'gate', 'x': rel(gx, gz)[0], 'z': rel(gx, gz)[1], 'h': round(H_S, 1)})
    ap.structures_zone = zone
    ap.lines_extra['floods'] = ap.floods
    return ap
