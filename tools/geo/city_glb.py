"""Minimal glTF 2.0 (GLB) writer for city tiles with EXT_meshopt_compression + KHR_mesh_quantization.

The city runtime (src/world-sf/city.js) edits POSITION.y in place (terrain placement) and reads TEXCOORD_1 (building
anchor) as plain numbers, so those stay float32 after decoding: they are stored with the meshopt EXPONENTIAL filter
(shared exponent per component = fixed-point quantisation, decoded to float32 on the GPU-upload path).
NORMAL float32 (8-bit exponential filter: flat-shaded facades have few distinct normals), COLOR_0 uint8 normalised
RGBA, TEXCOORD_2 (atlas layer, per-building seed) uint16 non-normalised (layer index, seed 0..255). Every attribute's
byte stride equals its element size, so three.js creates plain (not interleaved) BufferAttributes, which the city
runtime needs (onUpload / in-place edits). Index buffers use the meshopt TRIANGLES codec.
Vertices are reordered for the post-transform cache and fetch (meshoptimizer), which also helps the codecs.

  write_glb(path, name, center_xz, P (n,3) f32, N (n,3) f32, UV (n,2) f32, A (n,2) f32, L (n,2) u16, C (n,4) u8, I (m,) u32)
"""
import json
import struct

import numpy as np
import meshoptimizer as mo

mo.encode_vertex_version(0)       # EXT_meshopt_compression = vertex codec v0
mo.encode_index_version(1)

F32, U8, I8, U16, U32 = 5126, 5121, 5120, 5123, 5125


def exp_filter(data, bits):
    """meshopt_encodeFilterExp, mode SharedComponent: one exponent per component over the whole stream.
    data: (n, k) float32 -> (n, k) uint32 (24-bit signed mantissa | exponent << 24)."""
    d = np.asarray(data, np.float32)
    n, k = d.shape
    out = np.zeros((n, k), np.uint32)
    for j in range(k):
        v = d[:, j]
        m = float(np.abs(v).max()) if n else 0.0
        if m == 0.0:
            e = 0
        else:
            # optlog2: exponent field of the float (+1 for the implicit leading 1); the max |v| sets the exponent
            e = int((np.float32(m).view(np.uint32) >> 23) & 0xff) - 127 + 1
        e = max(e, -100)
        ex = e - (bits - 1)
        # C: int(v * 2^-ex + (v >= 0 ? 0.5 : -0.5)) truncates toward zero
        mant = np.trunc(v.astype(np.float64) * (2.0 ** -ex) + np.where(v >= 0, 0.5, -0.5)).astype(np.int64)
        out[:, j] = (mant & 0xffffff).astype(np.uint32) | (np.uint32(ex & 0xff) << np.uint32(24))
    return out


def exp_decode(enc):
    """Inverse of exp_filter (for checks): (n, k) uint32 -> float32."""
    e = enc.astype(np.uint32)
    m = (e & 0xffffff).astype(np.int64)
    m = np.where(m >= 1 << 23, m - (1 << 24), m)
    ex = (e >> 24).astype(np.int64)
    ex = np.where(ex >= 128, ex - 256, ex)
    return (m * np.power(2.0, ex)).astype(np.float32)


def optimize(P, I, attrs):
    """Vertex cache + fetch order. attrs: list of (n, ...) arrays reordered like P. Returns (P, I, attrs)."""
    n = len(P)
    I = np.asarray(I, np.uint32)
    dst = np.zeros_like(I)
    mo.optimize_vertex_cache(dst, I, len(I), n)
    I = dst
    # fetch order remap: first use of each vertex in the index stream
    remap = np.full(n, -1, np.int64)
    uniq, first = np.unique(I, return_index=True)
    order = uniq[np.argsort(first)]
    remap[order] = np.arange(len(order))
    I = remap[I].astype(np.uint32)
    P = P[order]
    attrs = [a[order] for a in attrs]
    return P, I, attrs


class _Bin:
    def __init__(self):
        self.parts, self.off = [], 0

    def add(self, b):
        pad = (-self.off) % 4
        if pad:
            self.parts.append(b'\0' * pad)
            self.off += pad
        o = self.off
        self.parts.append(b)
        self.off += len(b)
        return o

    def bytes(self):
        pad = (-self.off) % 4
        return b''.join(self.parts) + b'\0' * pad


# mantissa bits per LOD: POSITION (<= 1.5 cm at LOD0, 3-6 cm beyond), NORMAL, TEXCOORD_0 (facade repeats), anchor
BITS = {0: (15, 8, 13, 13), 1: (14, 8, 12, 12), 2: (13, 8, 11, 12), 3: (13, 8, 11, 12)}


def write_glb(path, name, center, P, N, UV, A, L, C, I, extras=None, optimize_order=True, lod=0):
    P = np.asarray(P, np.float32)
    n = len(P)
    has_anchor = A is not None
    if not has_anchor:
        A = np.zeros((n, 2), np.float32)
    if optimize_order and n:
        P, I, (N, UV, A, L, C) = optimize(P, I, [np.asarray(N), np.asarray(UV), np.asarray(A), np.asarray(L), np.asarray(C)])
        n = len(P)            # unreferenced vertices are dropped by the fetch reorder
    I = np.asarray(I, np.uint32)
    binw = _Bin()
    buffer_views, accessors = [], []
    fallback = [0]

    def view(raw_bytes, count, stride, mode, filt=None, target=34962):
        enc = mo.encode_vertex_buffer(np.frombuffer(raw_bytes, np.uint8).reshape(count, stride), count, stride) \
            if mode == 'ATTRIBUTES' else mo.encode_index_buffer(np.frombuffer(raw_bytes, np.uint32 if stride == 4 else np.uint16).astype(np.uint32), count, n)
        off = binw.add(enc)
        ext = {'buffer': 0, 'byteOffset': off, 'byteLength': len(enc), 'byteStride': stride, 'mode': mode, 'count': count}
        if filt:
            ext['filter'] = filt
        fb_off = fallback[0]
        fallback[0] += (count * stride + 3) // 4 * 4
        bv = {'buffer': 1, 'byteOffset': fb_off, 'byteLength': count * stride, 'extensions': {'EXT_meshopt_compression': ext}}
        if mode == 'ATTRIBUTES':
            bv['byteStride'] = stride
        bv['target'] = target
        buffer_views.append(bv)
        return len(buffer_views) - 1

    def acc(bv, ctype, count, typ, normalized=False, mn=None, mx=None):
        a = {'bufferView': bv, 'componentType': ctype, 'count': count, 'type': typ}
        if normalized:
            a['normalized'] = True
        if mn is not None:
            a['min'], a['max'] = mn, mx
        accessors.append(a)
        return len(accessors) - 1

    attrs = {}
    # POSITION: float32 via exponential filter
    bp, bn, bu, ba = BITS.get(lod, BITS[0])
    encP = exp_filter(P, bp)
    decP = exp_decode(encP)
    attrs['POSITION'] = acc(view(encP.tobytes(), n, 12, 'ATTRIBUTES', 'EXPONENTIAL'), F32, n, 'VEC3',
                            mn=[float(v) for v in decP.min(0)], mx=[float(v) for v in decP.max(0)])
    attrs['NORMAL'] = acc(view(exp_filter(N, bn).tobytes(), n, 12, 'ATTRIBUTES', 'EXPONENTIAL'), F32, n, 'VEC3')
    attrs['TEXCOORD_0'] = acc(view(exp_filter(UV, bu).tobytes(), n, 8, 'ATTRIBUTES', 'EXPONENTIAL'), F32, n, 'VEC2')
    if has_anchor:     # building anchors (terrain placement 'anchor'); 'vertex'-placed tiles need none
        attrs['TEXCOORD_1'] = acc(view(exp_filter(A, ba).tobytes(), n, 8, 'ATTRIBUTES', 'EXPONENTIAL'), F32, n, 'VEC2')
    Lq = np.ascontiguousarray(np.asarray(L, np.uint16))
    attrs['TEXCOORD_2'] = acc(view(Lq.tobytes(), n, 4, 'ATTRIBUTES'), U16, n, 'VEC2')
    attrs['COLOR_0'] = acc(view(np.ascontiguousarray(np.asarray(C, np.uint8)).tobytes(), n, 4, 'ATTRIBUTES'), U8, n, 'VEC4', normalized=True)
    if n <= 65535:
        idx = acc(view(I.astype(np.uint16).tobytes(), len(I), 2, 'TRIANGLES', target=34963), U16, len(I), 'SCALAR')
    else:
        idx = acc(view(I.tobytes(), len(I), 4, 'TRIANGLES', target=34963), U32, len(I), 'SCALAR')
    for bv in buffer_views:
        if bv['extensions']['EXT_meshopt_compression']['mode'] == 'TRIANGLES':
            bv.pop('byteStride', None)
    body = binw.bytes()
    gltf = {
        'asset': {'version': '2.0', 'generator': 'gokyuzu city_glb.py'},
        'extensionsUsed': ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
        'extensionsRequired': ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': name, 'translation': [float(center[0]), 0.0, float(center[1])]}],
        'materials': [{'name': 'city', 'doubleSided': True, 'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 0.8}}],
        'meshes': [{'name': name, 'primitives': [{'attributes': attrs, 'indices': idx, 'material': 0, 'mode': 4}]}],
        'accessors': accessors, 'bufferViews': buffer_views,
        'buffers': [{'byteLength': len(body)}, {'byteLength': fallback[0], 'extensions': {'EXT_meshopt_compression': {'fallback': True}}}],
    }
    if extras:
        gltf['extras'] = extras
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(body)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(body), 0x004E4942))
        f.write(body)
    return total
