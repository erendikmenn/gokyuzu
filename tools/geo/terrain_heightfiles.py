"""Cacheable height files: the height tiles of h/<L>.bin repacked as small, deflated whole files (one GET each, cached by
the browser and the CDN like any file; no HTTP range requests into the 0.01-381 MB level packs).

Output: assets/sf/terrain/hz/<L>/<gi>_<gj>.bin = the 4 tiles (L, 2gi..2gi+1, 2gj..2gj+1), i.e. the children of node
(L-1, gi, gj): the loader always requests the 4 children of a node together (a parent is replaced only when all four are
loaded), so a file holds exactly what one refinement needs (measured on recorded flights: no extra tiles, 1/4 of the
requests; 4x4 groups would double the bytes). hz/0/0_0.bin holds the root. ~12.6k files, ~300 MB.
The layout is recorded in index.json / index.bin ("heightFiles": {"dir": "hz", "group": 1, "format": 1}), so
terrain.js knows which file holds a tile without a file list.
File = zlib/deflate stream (browser: DecompressionStream('deflate')) of
  u16 tileCount, u16 reserved (0), then tileCount x (u8 di, u8 dj) = tile position in the group (i - 2gi, j - 2gj),
  in index (row-major) order, padded to 4 bytes; then per tile the TILE_BYTES record of h/<L>.bin, transformed
  losslessly so deflate finds the redundancy (each tile decodes back to exactly the same bytes):
    f32 hmin, f32 scale                       unchanged
    u16[67*67] heights                        -> residual of the gradient predictor (left + up - upleft; first row:
                                                 left, first column: up, (0, 0): 0), mod 2^16, zigzag, stored as two
                                                 byte planes (all high bytes, then all low bytes)
    packbits(water[67*67])                    unchanged
    u8 sunVis[65*65]                          -> residual of the same gradient predictor mod 256
Usage: run as part of tools/geo/terrain_pinpack.py (after every terrain rebuild), or alone:
       .venv/bin/python tools/geo/terrain_heightfiles.py   (rebuilds hz/ and the "heightFiles" entry of index.json/.bin)
"""
import os, json, zlib, struct, shutil, time
import numpy as np
from terrain_common import OUT

NS, NV = 67, 65
WB = (NS * NS + 7) // 8
TILE_BYTES = 8 + NS * NS * 2 + WB + NV * NV
GROUP = 1          # log2 of the group edge in tiles: 2x2 tiles per file
FORMAT = 1
DIR = 'hz'


def _pred(v):
    """Gradient predictor (int64 array): left + up - upleft; first row: left; first column: up; (0, 0): 0."""
    p = np.zeros_like(v)
    p[0, 1:] = v[0, :-1]
    p[1:, 0] = v[:-1, 0]
    p[1:, 1:] = v[1:, :-1] + v[:-1, 1:] - v[:-1, :-1]
    return p


def encode_tile(b):
    """TILE_BYTES record of h/<L>.bin -> transformed record of the same length."""
    assert len(b) == TILE_BYTES
    v = np.frombuffer(b[8:8 + NS * NS * 2], '<u2').reshape(NS, NS).astype(np.int64)
    r = (v - _pred(v)) & 0xFFFF
    r = np.where(r >= 32768, r - 65536, r)                          # wrap to int16
    zz = np.where(r >= 0, 2 * r, -2 * r - 1).astype(np.uint16).ravel()
    s = np.frombuffer(b[8 + NS * NS * 2 + WB:], np.uint8).reshape(NV, NV).astype(np.int64)
    sr = ((s - _pred(s)) & 0xFF).astype(np.uint8)
    return (b[:8] + (zz >> 8).astype(np.uint8).tobytes() + (zz & 0xFF).astype(np.uint8).tobytes()
            + b[8 + NS * NS * 2:8 + NS * NS * 2 + WB] + sr.tobytes())


def decode_tile(e):
    """Inverse of encode_tile (reference for the JS decoder and the tests)."""
    n = NS * NS
    zz = (np.frombuffer(e[8:8 + n], np.uint8).astype(np.int64) << 8) | np.frombuffer(e[8 + n:8 + 2 * n], np.uint8)
    r = np.where(zz & 1, -((zz + 1) >> 1), zz >> 1).reshape(NS, NS)
    v = np.zeros((NS, NS), np.int64)
    for y in range(NS):   # row by row: the predictor needs the decoded row above and the sample to the left
        for x in range(NS):
            p = 0 if (x == 0 and y == 0) else v[y, x - 1] if y == 0 else v[y - 1, x] if x == 0 else v[y, x - 1] + v[y - 1, x] - v[y - 1, x - 1]
            v[y, x] = (p + r[y, x]) & 0xFFFF
    sr = np.frombuffer(e[8 + 2 * n + WB:], np.uint8).reshape(NV, NV).astype(np.int64)
    s = np.zeros((NV, NV), np.int64)
    for y in range(NV):
        for x in range(NV):
            p = 0 if (x == 0 and y == 0) else s[y, x - 1] if y == 0 else s[y - 1, x] if x == 0 else s[y, x - 1] + s[y - 1, x] - s[y - 1, x - 1]
            s[y, x] = (p + sr[y, x]) & 0xFF
    return e[:8] + v.astype('<u2').tobytes() + e[8 + 2 * n:8 + 2 * n + WB] + s.astype(np.uint8).tobytes()


def group_of(i, j, g=GROUP):
    return i >> g, j >> g


def pack_group(tiles, g=GROUP):
    """tiles: list of (i, j, raw TILE_BYTES record) of one group, any order -> deflated file bytes."""
    tiles = sorted(tiles, key=lambda t: (t[1], t[0]))
    m = (1 << g) - 1
    head = struct.pack('<HH', len(tiles), 0) + b''.join(struct.pack('<BB', i & m, j & m) for i, j, _ in tiles)
    head += b'\0' * (-len(head) % 4)
    return zlib.compress(head + b''.join(encode_tile(b) for _, _, b in tiles), 9)


def unpack_group(data, g=GROUP):
    """-> {(di, dj): raw TILE_BYTES record} (reference decoder)."""
    raw = zlib.decompress(data)
    n = struct.unpack_from('<H', raw, 0)[0]
    pos = [struct.unpack_from('<BB', raw, 4 + 2 * k) for k in range(n)]
    off = 4 + 2 * n + (-(4 + 2 * n) % 4)
    return {p: decode_tile(raw[off + k * TILE_BYTES:off + (k + 1) * TILE_BYTES]) for k, p in enumerate(pos)}


def level_groups(nodes, L, g=GROUP):
    """{(gi, gj): [(i, j, rank), ...]} for the nodes of level L (rank = position in h/<L>.bin)."""
    out, rank = {}, 0
    for r in nodes:
        if r[0] != L:
            continue
        out.setdefault(group_of(r[1], r[2], g), []).append((r[1], r[2], rank))
        rank += 1
    return out


def build(index, out_dir=None, g=GROUP, log=print):
    """Write hz/<L>/<gi>_<gj>.bin for every node of the index from h/<L>.bin (next to the live data, then swapped in)."""
    out_dir = out_dir or os.path.join(OUT, DIR)
    tmp = out_dir + '.next'
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    levels = sorted({r[0] for r in index['nodes']})
    assert index['tileBytes'] == TILE_BYTES
    t0, files, raw_bytes, out_bytes = time.time(), 0, 0, 0
    for L in levels:
        os.makedirs(os.path.join(tmp, str(L)))
        groups = level_groups(index['nodes'], L, g)
        with open(os.path.join(OUT, 'h', f'{L}.bin'), 'rb') as f:
            for (gi, gj), lst in groups.items():
                tiles = []
                for i, j, rank in lst:
                    f.seek(rank * TILE_BYTES)
                    tiles.append((i, j, f.read(TILE_BYTES)))
                z = pack_group(tiles, g)
                with open(os.path.join(tmp, str(L), f'{gi}_{gj}.bin'), 'wb') as o:
                    o.write(z)
                files += 1
                raw_bytes += len(lst) * TILE_BYTES
                out_bytes += len(z)
        log(f'  hz/{L}: {len(groups)} files')
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.replace(tmp, out_dir)
    log(f'hz/: {files} files, {out_bytes / 1e6:.1f} MB (raw tiles {raw_bytes / 1e6:.1f} MB, x{out_bytes / raw_bytes:.3f}) in {time.time() - t0:.0f} s')
    return {'dir': DIR, 'group': g, 'format': FORMAT}


def main():
    """Rebuild hz/ alone and record it in index.json + index.bin (terrain_pinpack.py does this as part of its run)."""
    import terrain_pinpack
    d = json.load(open(os.path.join(OUT, 'index.json')))
    d['heightFiles'] = build(d)
    terrain_pinpack.write_index_json(d)
    terrain_pinpack.write_index_bin(d)


if __name__ == '__main__':
    main()
