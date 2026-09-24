"""Precomputed, compressed height pack for the tiles other layers sample while they build (airports, landmarks) and that
physics needs exact at t=0 (runway spawns). Replaces ~58 MB of raw height-tile range requests with one small file.

Output: assets/sf/terrain/pins.bin = zlib/deflate stream (browser: DecompressionStream('deflate')) of
  u32 headerLength, header JSON {q, tiles: [[L, i, j], ...]}, then per tile: i16[67*67] 2D-delta of round(h / q)
  (row-major, 1-sample border, first delta relative to 0) + packbits water[67*67] (561 bytes).
Airports (runway bbox + 1.5 km) at full depth, landmarks (450 m, bridges 1.6 km) up to level 9. q = 0.1 m.
Also writes assets/sf/terrain/index.bin: deflate of u32 headerLength + header JSON (index.json without "nodes") +
  per node (index.json order) 12 bytes: u8 level, u16 i, u16 j, u8 flags (1 hasChildren, 2 img, 4|8 water), u16 error cm,
  i16 hmin dm, i16 hmax dm (little endian).
And the cacheable height files assets/sf/terrain/hz/ (terrain_heightfiles.py) the game streams instead of range requests
into h/<L>.bin; their layout goes into the "heightFiles" entry of index.json and index.bin.
Areas: <data>/runways.json airports + <data>/landmarks.json landmarks (sf). For ist, whatever of the other pipelines'
files exists (data/ist/runways.json, landmarks.json, bridges.json) plus the terrain's own airport runways
(data/ist/terrain_airports.json) and a few fixed landmark points (bridges, towers), so the pack is complete before the
airports / landmarks data land; re-run it after they change.
Usage: .venv/bin/python tools/geo/terrain_pinpack.py   (after terrain_build.py + imagery_build.py published index.json)
"""
import os, json, zlib, struct
import numpy as np
from terrain_common import ROOT, OUT, REGION_ID, DATA_DIR, RUNWAYS_JSON, LANDMARKS_JSON
import terrain_heightfiles

Q = 0.1
NS = 67
WB = (NS * NS + 7) // 8


def write_index_bin(d):
    hdr = {k: v for k, v in d.items() if k != 'nodes'}
    hdr['nodeCount'] = len(d['nodes'])
    hb = json.dumps(hdr, separators=(',', ':')).encode()
    rec = bytearray()
    for L, i, j, kids, err, hmin, hmax, water, img in (r[:9] for r in d['nodes']):
        flags = (1 if kids else 0) | (2 if img else 0) | (int(water) << 2)
        rec += struct.pack('<BHHBHhh', L, i, j, flags, min(int(round(err * 100)), 65535),
                           int(np.floor(hmin * 10)), int(np.ceil(hmax * 10)))
    z = zlib.compress(struct.pack('<I', len(hb)) + hb + bytes(rec), 9)
    tmp = os.path.join(OUT, 'index.bin.tmp')
    open(tmp, 'wb').write(z)
    os.replace(tmp, os.path.join(OUT, 'index.bin'))
    print('index.bin', len(d['nodes']), 'nodes', round(len(z) / 1e6, 2), 'MB')


def write_index_json(d):
    tmp = os.path.join(OUT, 'index.json.tmp')
    json.dump(d, open(tmp, 'w'), separators=(',', ':'))
    os.replace(tmp, os.path.join(OUT, 'index.json'))


# ist landmarks pinned even before data/ist/landmarks.json exists: (name, lon, lat, kind)
IST_LANDMARKS = [('Yavuz Sultan Selim Köprüsü', 29.1106, 41.2032, 'bridge'), ('15 Temmuz Şehitler Köprüsü', 29.0350, 41.0452, 'bridge'),
                 ('Fatih Sultan Mehmet Köprüsü', 29.0617, 41.0913, 'bridge'), ('Galata Köprüsü', 28.9737, 41.0197, 'bridge'),
                 ('Haliç Metro Köprüsü', 28.9661, 41.0233, 'bridge'), ('Galata Kulesi', 28.974167, 41.025556, 'tower'),
                 ('Kız Kulesi', 29.004097, 41.021083, 'tower'), ('Çamlıca Kulesi', 29.0690, 41.0283, 'tower'),
                 ('Sultanahmet / Ayasofya', 28.9790, 41.0070, 'mosque'), ('Süleymaniye', 28.9639, 41.0162, 'mosque'),
                 ('Çamlıca Camii', 29.0707, 41.0275, 'mosque'), ('Dolmabahçe', 29.0001, 41.0391, 'palace'),
                 ('Rumeli Hisarı', 29.0560, 41.0847, 'fort'), ('Maslak / Levent', 29.0110, 41.0810, 'towers')]


def pin_sources():
    """(runways, landmarks) dicts in the sf file layouts; ist merges what exists (see the module docstring)."""
    if REGION_ID == 'sf':
        return (json.load(open(os.path.join(ROOT, 'data', 'sf', 'runways.json'))),
                json.load(open(os.path.join(ROOT, 'data', 'sf', 'landmarks.json'))))
    from geo import lonlat_to_local
    rw = json.load(open(RUNWAYS_JSON)) if os.path.exists(RUNWAYS_JSON) else {'airports': []}
    have = {a['icao'] for a in rw['airports']}
    tpath = os.path.join(DATA_DIR, 'terrain_airports.json')
    if os.path.exists(tpath):
        for a in json.load(open(tpath))['airports']:
            if a['icao'] not in have and a['runways']:
                rw['airports'].append({'icao': a['icao'], 'runways': [{'ends': r['ends']} for r in a['runways']]})
    lm = json.load(open(LANDMARKS_JSON)) if os.path.exists(LANDMARKS_JSON) else {'landmarks': []}
    lm = {'landmarks': [l for l in lm.get('landmarks', []) if 'x' in l and 'z' in l]}
    bpath = os.path.join(DATA_DIR, 'bridges.json')
    if os.path.exists(bpath):
        b = json.load(open(bpath))
        for br in (b.get('bridges', b) if isinstance(b, dict) else b):
            if isinstance(br, dict) and 'x' in br and 'z' in br:
                lm['landmarks'].append({'x': br['x'], 'z': br['z'], 'kind': 'bridge'})
    for name, lon, lat, kind in IST_LANDMARKS:
        x, z = lonlat_to_local(lon, lat)
        lm['landmarks'].append({'name': name, 'x': x, 'z': z, 'kind': kind})
    return rw, lm


def main():
    d = json.load(open(os.path.join(OUT, 'index.json')))
    # small cacheable height files (hz/) first: index.json / index.bin must only name files that exist
    d['heightFiles'] = terrain_heightfiles.build(d)
    write_index_json(d)
    write_index_bin(d)
    RS, RX, RZ, TB = d['rootSize'], d['rootMinX'], d['rootMinZ'], d['tileBytes']
    rank, cnt = {}, {}
    for r in d['nodes']:
        L = r[0]
        rank[(L, r[1], r[2])] = cnt.get(L, 0)
        cnt[L] = cnt.get(L, 0) + 1
    N = {(r[0], r[1], r[2]): r for r in d['nodes']}
    rw, lm = pin_sources()
    groups = []
    ap = []
    for a in rw['airports']:
        xs = [e['x'] for r in a['runways'] for e in r['ends']]
        zs = [e['z'] for r in a['runways'] for e in r['ends']]
        ap.append((min(xs) - 1500, max(xs) + 1500, min(zs) - 1500, max(zs) + 1500))
    groups.append((ap, 10))
    lms = []
    for l in lm['landmarks']:
        m = 1600 if l['kind'] == 'bridge' else 450
        lms.append((l['x'] - m, l['x'] + m, l['z'] - m, l['z'] + m))
    groups.append((lms, 9))
    tiles = set()
    for areas, maxL in groups:
        def walk(L, i, j):
            s = RS / (1 << L)
            x0, z0 = RX + i * s, RZ + j * s
            if L > maxL or not any(x0 < a[1] and x0 + s > a[0] and z0 < a[3] and z0 + s > a[2] for a in areas):
                return
            r = N.get((L, i, j))
            if not r:
                return
            tiles.add((L, i, j))
            if r[3]:
                for dj in (0, 1):
                    for di in (0, 1):
                        walk(L + 1, 2 * i + di, 2 * j + dj)
        walk(0, 0, 0)
    tiles = sorted(tiles)
    files = {}
    body = bytearray()
    for (L, i, j) in tiles:
        f = files.setdefault(L, open(os.path.join(OUT, 'h', f'{L}.bin'), 'rb'))
        f.seek(rank[(L, i, j)] * TB)
        b = f.read(TB)
        hmin, scale = np.frombuffer(b[:8], '<f4')
        v = np.frombuffer(b[8:8 + NS * NS * 2], '<u2').reshape(NS, NS)
        c = np.round((hmin + v.astype(np.float64) * scale) / Q).astype(np.int64)
        dd = np.diff(np.concatenate([np.zeros((NS, 1), np.int64), c], 1), axis=1)
        dd = np.diff(np.concatenate([np.zeros((1, NS), np.int64), dd], 0), axis=0)
        assert np.abs(dd).max() < 32768
        body += dd.astype('<i2').tobytes() + b[8 + NS * NS * 2:8 + NS * NS * 2 + WB]
    header = json.dumps({'q': Q, 'tiles': [list(t) for t in tiles]}, separators=(',', ':')).encode()
    raw = struct.pack('<I', len(header)) + header + bytes(body)
    z = zlib.compress(raw, 9)
    tmp = os.path.join(OUT, 'pins.tmp')
    open(tmp, 'wb').write(z)
    os.replace(tmp, os.path.join(OUT, 'pins.bin'))
    print('pins.bin', len(tiles), 'tiles', round(len(z) / 1e6, 2), 'MB (raw', round(len(raw) / 1e6, 1), 'MB)')


if __name__ == '__main__':
    main()
