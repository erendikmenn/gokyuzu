"""W4 airports: build all airport buildings of one airport in Blender and export assets/sf/airports/<icao>_buildings.glb

  /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/airports/build_buildings.py -- ksfo [--blend]
  GEO_REGION=ist /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/airports/build_buildings.py -- ltfm

Input: assets/sf/airports/<icao>.json (tools/geo/airports_build.py). Each building / structure becomes one top-level
object whose origin is on the ground at its anchor (the runtime drops it on the terrain and merges by material).
Blender axes: X = local x, Y = -local z, Z = up.
"""
import sys, os, json, math, random
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'common'))
sys.path.insert(0, HERE)
import bpy
from util import reset_scene, export_glb, REPO
from geom import MB, orient, ccw, point_in
import materials as M
import structures as S

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ICAO = (argv[0] if argv else 'ksfo').lower()
OUT = os.path.join(REPO, 'assets', os.environ.get('GEO_REGION', 'sf'), 'airports')   # map (tools/geo/geo.py)
meta = json.load(open(os.path.join(OUT, f'{ICAO}.json')))
rng = random.Random(42)

STYLE = {
    'terminal': dict(wall='fac_terminal', roof='roof_membrane', parapet='metal_white', ptop=1.3, hvac=True),
    'pier': dict(wall='fac_terminal', roof='roof_membrane', parapet='metal_white', ptop=1.1, hvac=True),
    'hangar': dict(wall='fac_hangar', roof='roof_metal', parapet='metal_white', ptop=0.8, door='fac_hangar_door'),
    'cargo': dict(wall='fac_cargo', roof='roof_metal', parapet='metal_white', ptop=0.6, door='fac_cargo'),
    'garage': dict(wall='fac_garage', roof='roof_gravel', parapet='concrete', ptop=1.1),
    'office': dict(wall='fac_office', roof='roof_gravel', parapet='concrete', ptop=0.9, hvac=True),
    'hotel': dict(wall='fac_glass', roof='roof_gravel', parapet='metal_grey', ptop=1.2, hvac=True),
    'station': dict(wall='fac_glass', roof='roof_membrane', parapet='metal_white', ptop=1.0),
    'industrial': dict(wall='fac_industrial', roof='roof_gravel', parapet='concrete', ptop=0.6, hvac=True),
    'service': dict(wall='fac_industrial', roof='roof_gravel', parapet='concrete', ptop=0.4),
    'fire': dict(wall='fac_office', roof='roof_gravel', parapet='paint_red', ptop=0.8),
    'hq': dict(wall='fac_mil_stucco', roof='roof_gravel', parapet='mil_tan', ptop=0.9, hvac=True),
    'office_mil': dict(wall='fac_mil_stucco', roof='roof_gravel', parapet='mil_tan', ptop=0.8, hvac=True),
    'ops': dict(wall='fac_mil_stucco', roof='roof_gravel', parapet='mil_tan', ptop=0.9, hvac=True),
    'service_mil': dict(wall='fac_mil_concrete', roof='roof_gravel', parapet='concrete', ptop=0.4),
}


def B(p):
    """json local (x, z) -> blender (x, y)"""
    return (p[0], -p[1])


def rel(ring, a):
    return [(x - a[0], y - a[1]) for x, y in ring]


def generic(b, mb, anchor):
    st = STYLE.get(b['kind'], STYLE['industrial'])
    outer = orient(rel([B(p) for p in b['poly']], anchor), True)
    holes = [orient(rel([B(p) for p in h], anchor), False) for h in b.get('holes', [])]
    h = b['h']
    z0 = b['minh'] if b['minh'] > 0 else -3.0
    ptop = st.get('ptop', 0.6) if 'inset' in b else 0.0
    wall = st['wall']
    door_edge = b.get('door_edge', -1) if st.get('door') else -1
    # outer walls (door panels on the hangar door edge)
    n = len(outer)
    src_ccw = ccw(rel([B(p) for p in b['poly']], anchor))
    u = 0.0
    for i in range(n):
        a, c = outer[i], outer[(i + 1) % n]
        # map door edge index from the json ring order to the oriented ring
        j = i if src_ccw else (n - 2 - i) % n
        if st['wall'] == 'fac_terminal':
            u = mb.wall(a, c, z0, h + ptop, wall, u, tile=(M.tile(wall)[0], h + ptop))
            continue
        if door_edge >= 0 and j == door_edge:
            dz = min(h * 0.82, h - 3.0)
            mb.wall(a, c, z0, dz, st['door'], 0.0)
            u = mb.wall(a, c, dz, h + ptop, wall, u)
            # door header beam
        else:
            u = mb.wall(a, c, z0, h + ptop, wall, u)
    for hh in holes:
        mb.ring_walls(hh, z0, h + ptop, wall, tile=(M.tile(wall)[0], h + ptop) if wall == 'fac_terminal' else None)
    if b['minh'] > 0:
        mb.cap(outer, holes, z0, st['parapet'], up=False)
    if ptop > 0:
        ins = orient(rel([B(p) for p in b['inset']], anchor), True)
        ins_h = [orient(rel([B(p) for p in hh], anchor), False) for hh in b.get('inset_holes', [])]
        mb.cap(ins, ins_h, h, st['roof'], True)
        # parapet: inner walls (facing the roof) + top band
        mb.ring_walls(ins[::-1], h, h + ptop, st['parapet'], tile=(4.0, 4.0))
        for hh in ins_h:
            mb.ring_walls(hh[::-1], h, h + ptop, st['parapet'], tile=(4.0, 4.0))
        mb.cap(outer, [ins[::-1]] + holes, h + ptop, st['parapet'], True, tile=(4.0, 4.0))
        roof_ring = ins
    else:
        mb.cap(outer, holes, h, st['roof'], True)
        roof_ring = outer
    # rooftop units on larger flat roofs
    if st.get('hvac') and 'inset' in b:
        xs = [p[0] for p in roof_ring]
        ys = [p[1] for p in roof_ring]
        area = abs(sum(roof_ring[i][0] * roof_ring[(i + 1) % len(roof_ring)][1] - roof_ring[(i + 1) % len(roof_ring)][0] * roof_ring[i][1] for i in range(len(roof_ring)))) / 2
        cnt = min(28, int(area / 450))
        tries = 0
        while cnt > 0 and tries < 400:
            tries += 1
            x, y = rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys))
            sx, sy = rng.uniform(2.0, 6.0), rng.uniform(1.5, 4.0)
            if all(point_in(roof_ring, x + dx, y + dy) for dx in (-sx / 2 - 1, sx / 2 + 1) for dy in (-sy / 2 - 1, sy / 2 + 1)):
                mb.box(x, y, h, sx, sy, rng.uniform(1.0, 2.4), rng.choice(['metal_grey', 'metal_white', 'metal_grey']), rot=rng.uniform(0, 0.1))
                cnt -= 1


def military_rect(b):
    """Returns (mb, location, rotation) for KNGZ parametric kinds. Local frame: door faces +Y."""
    cx, cz, w, d, door_h, s_h = b['rect']
    loc = B((cx, cz))
    th = math.atan2(math.cos(math.radians(s_h)), math.sin(math.radians(s_h)))   # local +X along the runway (+s)
    dh = math.radians(door_h)
    ddx, ddy = math.sin(dh), math.cos(dh)
    lx = ddx * math.cos(-th) - ddy * math.sin(-th)
    ly = ddx * math.sin(-th) + ddy * math.cos(-th)
    if abs(ly) >= abs(lx):
        rot = th if ly > 0 else th + math.pi
        W, D = w, d
    else:
        rot = th - math.pi / 2 if lx > 0 else th + math.pi / 2
        W, D = d, w
    mb = MB()
    k = b['kind']
    if k == 'has':
        S.has(mb, W, D, b['h'], b.get('num', 1))
    elif k == 'blast_wall':
        S.blast_wall(mb, max(W, D), b['h'])
        if W > D:
            rot += math.pi / 2
    elif k == 'hangar_mil':
        S.hangar_mil(mb, W, D, b['h'], label=f"H-{b.get('num', 1)}")
    elif k == 'heli_hangar':
        S.hangar_mil(mb, W, D, b['h'], annex=False, label='HELI')
    elif k == 'tower_mil':
        S.tower_mil(mb, b['h'])
    elif k == 'fire_mil':
        S.fire_station(mb, W, D, b['h'])
    elif k == 'hush_house':
        S.pitched_building(mb, W, D, b['h'] * 0.8, 'fac_mil_concrete', 'roof_metal', pitch=0.12)
        mb.cylinder(0.0, -D / 2 - 3.5, -1.0, b['h'] + 4.0, 3.2, 3.0, 'fac_mil_concrete', seg=16, top=True)
    elif k in ('barracks',):
        S.pitched_building(mb, W, D, b['h'], 'fac_mil_stucco', 'roof_tile', pitch=0.4)
    elif k in ('warehouse_mil',):
        S.pitched_building(mb, W, D, b['h'], 'fac_mil_hangar', 'roof_metal', pitch=0.18)
    else:
        # flat-roofed stucco boxes (hq, ops, offices, services)
        st = STYLE.get(k, STYLE['office_mil'])
        hx, hy = W / 2, D / 2
        ring = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        mb.ring_walls(ring, -2.0, b['h'] + 0.8, st['wall'])
        ins = [(-hx + 0.35, -hy + 0.35), (hx - 0.35, -hy + 0.35), (hx - 0.35, hy - 0.35), (-hx + 0.35, hy - 0.35)]
        mb.cap(ins, [], b['h'], st['roof'], True)
        mb.ring_walls(ins[::-1], b['h'], b['h'] + 0.8, st['parapet'], tile=(4, 4))
        mb.cap(ring, [ins[::-1]], b['h'] + 0.8, st['parapet'], True, tile=(4, 4))
        # entrance canopy on the door side
        mb.box(0.0, hy + 2.0, 3.2, 8.0, 4.0, 0.4, 'metal_grey')
        if k == 'hq':
            mb.cylinder(-hx + 6.0, hy + 8.0, 0.0, 14.0, 0.1, 0.06, 'metal_white', seg=8)
            mb.box(-hx + 7.4, hy + 8.0, 11.4, 2.6, 0.04, 1.7, 'flag_red')
        for _ in range(int(W * D / 250)):
            x, y = rng.uniform(-hx + 3, hx - 3), rng.uniform(-hy + 3, hy - 3)
            mb.box(x, y, b['h'], rng.uniform(1.5, 3.5), rng.uniform(1.2, 2.5), rng.uniform(1.0, 1.8), 'metal_grey')
    return mb, loc, rot


def make(mb, name, loc, rot=0.0):
    ob = mb.to_object(name, (loc[0], loc[1], 0.0))
    if ob is not None:
        ob.rotation_euler = (0.0, 0.0, rot)
        ob['kind'] = name.split('_')[0]
    return ob


def main():
    reset_scene()
    names = set()

    def uniq(n):
        k, base = 1, n
        while n in names:
            k += 1
            n = f'{base}_{k}'
        names.add(n)
        return n

    count = 0
    for b in meta['buildings']:
        kind = b['kind']
        if kind == 'tower_cab':
            continue
        if 'rect' in b:
            mb, loc, rot = military_rect(b)
            make(mb, uniq(f'{kind}_{b["id"]}'), loc, rot)
            count += 1
            continue
        if kind == 'fuel_tank' and 'circle' in b:
            mb = MB()
            S.fuel_tank(mb, b['circle'][2], b['h'])
            make(mb, uniq(f'tank_{b["id"]}'), B(b['circle'][:2]))
            count += 1
            continue
        if kind == 'radar':
            continue
        anchor = B(b['anchor'])
        mb = MB()
        if 'International Terminal Main Hall' in (b.get('name') or ''):
            ox, oy = B(b['obb'][:2])
            ang = math.radians(90.0 - b['obb'][4])     # heading -> blender angle of the long axis
            outer = rel([B(p) for p in b['poly']], anchor)
            holes = [rel([B(p) for p in h], anchor) for h in b.get('holes', [])]
            S.intl_terminal(mb, outer, holes, (ox - anchor[0], oy - anchor[1], b['obb'][2], b['obb'][3], ang), b['h'])
        else:
            generic(b, mb, anchor)
        make(mb, uniq(f'{kind}_{b["id"]}'), anchor)
        count += 1
    # special structures
    for st in meta.get('structures', []):
        k = st['kind']
        if k == 'sfo_tower' and 'x' in st:
            mb = MB()
            S.sfo_tower(mb, st['r'], st['cab0'], st['top'])
            make(mb, uniq('tower_sfo'), B((st['x'], st['z'])))
        elif k == 'tower_generic' and 'x' in st:
            mb = MB()
            S.tower_generic(mb, st['r'], st['cab0'], st['top'])
            make(mb, uniq('tower_generic'), B((st['x'], st['z'])))
        elif k in ('localizer', 'glideslope'):
            mb = MB()
            if k == 'localizer':
                S.localizer(mb, st.get('w', 42.0))
            else:
                S.glideslope(mb)
            # local +Y must face the approaching aircraft: facing heading = landing heading + 180
            face = math.radians((st['h'] + 180.0) % 360)
            make(mb, uniq(k), B((st['x'], st['z'])), math.atan2(math.cos(face), math.sin(face)) - math.pi / 2)
        elif k == 'radar':
            mb = MB()
            S.radar(mb, st['h'])
            make(mb, uniq('radar'), B((st['x'], st['z'])))
        elif k == 'gate':
            mb = MB()
            S.gate(mb)
            make(mb, uniq('gate'), B((st['x'], st['z'])), math.radians(90.0 - st['h']))
        elif k == 'berm':
            ring = [B(p) for p in st['poly']]
            a = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
            mb = MB()
            S.berm(mb, rel(ring, a), st['h'])
            make(mb, uniq('berm'), a)
    # jet bridges
    for i, jb in enumerate(meta.get('jetbridges', [])):
        pts = [B(p) for p in jb['c']]
        a = pts[0]
        loc_pts = rel(pts, a)
        door, face, dz = None, None, 3.4
        if jb['occ'] and jb.get('sh') is not None and jb.get('sp'):
            h = math.radians(jb['sh'])
            fwd = (math.sin(h), math.cos(h))                  # blender XY
            left = (-fwd[1], fwd[0])
            sp = B(jb['sp'])
            end = pts[-1]
            along = (end[0] - sp[0]) * fwd[0] + (end[1] - sp[1]) * fwd[1]
            if jb['wide']:
                back, r, dz = (1.8, 3.25, 4.9) if along > -8 else (14.0, 3.35, 5.1)
            else:
                back, r, dz = 1.5, 2.2, 3.4
            door = (sp[0] - fwd[0] * back + left[0] * r - a[0], sp[1] - fwd[1] * back + left[1] * r - a[1])
            face = (-left[0], -left[1])
        mb = MB()
        S.jetbridge(mb, loc_pts, door, dz, face, jb['occ'] and door is not None)
        make(mb, uniq(f'jetbridge_{i}'), a)
    # AirTrain guideway
    for i, line in enumerate(meta.get('airtrain', [])):
        pts = [B(p) for p in line]
        if len(pts) < 2:
            continue
        mb = MB()
        S.airtrain(mb, rel(pts, pts[0]), 10.5)
        make(mb, uniq(f'airtrain_{i}'), pts[0])
    print(f'[{ICAO}] objects: {len(bpy.context.scene.objects)} (buildings {count})')
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    print(f'[{ICAO}] triangles ~{tris}')
    out = os.path.join(OUT, f'{ICAO}_buildings.glb')
    export_glb(out)
    print('exported', out, os.path.getsize(out) // 1024, 'KB')
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f'{ICAO}_buildings.blend'))
    # manifest
    man_p = os.path.join(OUT, 'manifest.json')
    man = json.load(open(man_p)) if os.path.exists(man_p) else {}
    man.setdefault('buildings', {})[ICAO] = f'{ICAO}_buildings.glb'
    json.dump(man, open(man_p, 'w'), indent=1)


main()
