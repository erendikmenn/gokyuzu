"""Public asset pack, texture side (called by tools/assets/pack_public.mjs; project venv: numpy, pillow, scipy).

    .venv/bin/python tools/assets/pack_public_tex.py <work_dir> [--fresh] [--only a320neo,b737,...]

The published GLBs embed their textures exactly as the texture scripts write them (Blender copies the JPEG / PNG bytes),
so the pack does not re-run Blender: it re-runs the texture scripts with every local brand opt-in switched off
(GOKYUZU_BRAND=off: the fictional liveries, neutral hangar lettering, generic military markings; see
blender/common/brand.py) into <work_dir>/tex/<id>/, and plans which embedded images of which exported GLB
(assets/<...>/_orig/<name>.glb) to replace:
  * same name as a regenerated file (same format)                    -> that file, when its bytes differ
  * DERIVE: a LOD image Blender made by downscaling a full-size one -> the regenerated source at the old size
  * PATCH:  a Blender-baked image (A320 flight-deck panels: light baked in Cycles) whose painted source changed in a
            small region (the registration plate) -> only that region is recomputed: new source x the baked light
            factor estimated around it from the production bake and source (blender/aircraft/a320neo/build/)
Writes <work_dir>/swap/plan.json: {"<GLB path relative to the repo>": {"src": <exported GLB>, "images": {<image name>:
<replacement file>}}}. pack_public.mjs swaps the images and runs the KTX2 conversion. Never writes into assets/.
Needs the build caches of a machine that built the assets once (NEEDS below).
"""
import io
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PY = sys.executable
TMP_UH60 = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'uh60_build_cache')     # blender/aircraft/uh60/build.py
A320_BUILD = os.path.join(REPO, 'blender', 'aircraft', 'a320neo', 'build')

# regen: commands run with GOKYUZU_TEX_OUT=<work>/tex/<id> ('{out}' is replaced by that directory); glbs: exported GLB ->
# dirs (searched by image name, relative to <work>/tex/<id>), derive {LOD image: full-size image}, patch {image: spec}
SPEC = {
    'a320neo': dict(
        regen=[['blender/aircraft/a320neo/textures.py'], ['blender/aircraft/a320neo/cockpit_tex.py']],
        glbs={
            'assets/aircraft/a320neo/a320neo_cockpit.glb': dict(dirs=[], patch={
                'ck_panelA': dict(kind='baked', new='ck_atlasA.png', old=os.path.join(A320_BUILD, 'tex', 'ck_atlasA.png')),
                'ck_emitA': dict(kind='direct', new='ck_emitA.png', old=os.path.join(A320_BUILD, 'tex', 'ck_emitA.png'))}),
            'assets/aircraft/a320neo/a320neo.glb': dict(dirs=['.'], patch={
                'lite_panelA': dict(kind='lite', of='ck_panelA', scale=0.25),
                'lite_emitA': dict(kind='lite', of='ck_emitA', scale=0.5)}),
            'assets/aircraft/a320neo/a320neo_lod.glb': dict(dirs=['.']),
        }),
    'b737': dict(
        regen=[['blender/aircraft/b737/textures.py']],
        glbs={
            'assets/aircraft/b737/b737.glb': dict(dirs=['.']),
            'assets/aircraft/b737/b737_lod.glb': dict(dirs=['lod']),
        }),
    'f16': dict(
        regen=[['blender/aircraft/f16/textures.py']],
        glbs={
            'assets/aircraft/f16/f16.glb': dict(dirs=['.']),
            'assets/aircraft/f16/f16_lod.glb': dict(dirs=['.'], derive={'skin_color_lod': 'skin_color'}),
        }),
    'f22': dict(
        regen=[['blender/aircraft/f22/textures_ext.py', '{out}/src'],
               ['blender/aircraft/f22/composite.py', 'assets/aircraft/f22/_bake', '{out}/src', '{out}']],
        glbs={
            'assets/aircraft/f22/f22.glb': dict(dirs=['.']),
            'assets/aircraft/f22/f22_lod.glb': dict(dirs=['.'], derive={'f22_basecolor_lod': 'f22_basecolor',
                                                                       'f22_metalrough_lod': 'f22_metalrough'}),
        }),
    'uh60': dict(
        regen=[['blender/aircraft/uh60/texgen.py', TMP_UH60, '{out}']],
        glbs={
            'assets/aircraft/uh60/uh60.glb': dict(dirs=['.']),
            'assets/aircraft/uh60/uh60_lod.glb': dict(dirs=['.'], derive={
                'lod_hull_base': 'hull_base', 'lod_hull_orm': 'hull_orm', 'lod_hull_nrm': 'hull_nrm', 'lod_hull_emit': 'hull_emit'}),
        }),
    'ist_atlas': dict(
        regen=[['tools/geo/airports_ist_atlas.py']],
        glbs={f'assets/ist/airports/{icao}_buildings.glb': dict(dirs=['.']) for icao in ('ltfm', 'ltfj', 'ltba')}),
}
# build caches the regeneration reads besides the repository (from one full build of that aircraft; never published)
NEEDS = {'f16': [os.path.join(REPO, 'assets/aircraft/f16/tex/skin_ao.png')],
         'f22': [os.path.join(REPO, 'assets/aircraft/f22/_bake/pos.npy')], 'uh60': [os.path.join(TMP_UH60, 'pos.npy')],
         'a320neo': [os.path.join(A320_BUILD, 'tex', 'ck_atlasA.png'), os.path.join(A320_BUILD, 'bake', 'ck_panelA.jpg')]}
EXT = {'image/jpeg': ('.jpg', '.jpeg'), 'image/png': ('.png',)}


def log(*a):
    print('[pack-tex]', *a, flush=True)


# ------------------------------------------------------------------------------------------------ GLB (read only)
def glb_images(path):
    """{name: (mime, bytes)} of the images embedded in a GLB."""
    b = open(path, 'rb').read()
    if struct.unpack_from('<I', b, 0)[0] != 0x46546C67:
        raise ValueError(f'{path}: not a GLB')
    o, js, bin_ = 12, None, None
    while o < len(b):
        n, t = struct.unpack_from('<II', b, o)
        if t == 0x4E4F534A:
            js = json.loads(b[o + 8:o + 8 + n])
        elif t == 0x004E4942 and bin_ is None:
            bin_ = b[o + 8:o + 8 + n]
        o += 8 + n
    out = {}
    for im in js.get('images', []):
        if im.get('bufferView') is None:
            continue
        bv = js['bufferViews'][im['bufferView']]
        off = bv.get('byteOffset', 0)
        out[im['name']] = (im.get('mimeType', ''), bin_[off:off + bv['byteLength']])
    return out


def source_glb(rel):
    """The exported (pre-KTX2) GLB: <dir>/_orig/<name>.glb once tools/assets/textures.mjs converted it."""
    p = os.path.join(REPO, rel)
    o = os.path.join(os.path.dirname(p), '_orig', os.path.basename(p))
    return o if os.path.exists(o) else p


# ------------------------------------------------------------------------------------------------ images
def load(src):
    f = io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src
    return np.asarray(Image.open(f).convert('RGB'), np.float32) / 255.0


def save_png(arr, path):
    Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path, optimize=True)


def s2l(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def l2s(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def change_mask(old_src, new_src, thr=12 / 255, grow=3):
    """Where the painted source really changed (the cockpit painter adds a few levels of unseeded noise everywhere)."""
    m = np.abs(new_src - old_src).max(-1) > thr
    return ndimage.binary_dilation(m, iterations=grow) if m.any() else m


def bbox(m, pad=0):
    ys, xs = np.nonzero(m)
    return max(0, ys.min() - pad), ys.max() + 1 + pad, max(0, xs.min() - pad), xs.max() + 1 + pad


def patch_baked(old_img, old_src, new_src):
    """old_img = l2s(s2l(old_src) * f) with a smooth light factor f (Cycles bake): recompute the changed region with f
    estimated from the unchanged pixels around it (normalised Gaussian convolution of the ratio)."""
    m = change_mask(old_src, new_src)
    if not m.any():
        return None, None
    y0, y1, x0, x1 = bbox(m, pad=48)
    y1, x1 = min(y1, old_img.shape[0]), min(x1, old_img.shape[1])
    lo, ls, ln = s2l(old_img[y0:y1, x0:x1]), s2l(old_src[y0:y1, x0:x1]), s2l(new_src[y0:y1, x0:x1])
    mm = m[y0:y1, x0:x1]
    ok = (~ndimage.binary_dilation(mm, iterations=4)) & (ls.mean(-1) > 0.015)
    ratio = np.where(ok, lo.mean(-1) / np.maximum(ls.mean(-1), 1e-4), 0.0)
    ws = ndimage.gaussian_filter(ok.astype(np.float32), 10)
    f = ndimage.gaussian_filter(ratio, 10) / np.maximum(ws, 1e-6)
    f = np.clip(np.where(ws > 1e-3, f, np.median(ratio[ok]) if ok.any() else 1.0), 0.2, 1.2)
    out = old_img.copy()
    out[y0:y1, x0:x1] = np.where(mm[..., None], l2s(ln * f[..., None]), old_img[y0:y1, x0:x1])
    return out, bbox(m)


def patch_direct(old_img, old_src, new_src):
    """old_img is the painted source re-encoded at the same size: copy the changed region."""
    m = change_mask(old_src, new_src)
    if not m.any():
        return None, None
    return np.where(m[..., None], new_src, old_img), bbox(m)


def patch_lite(old_img, new_full, box, scale):
    """old_img is a downsample of a patched full-size image (plus pasted display images): replace the patched region."""
    y0, y1, x0, x1 = box
    h, w = old_img.shape[:2]
    ly0, lx0 = int(y0 * scale), int(x0 * scale)
    ly1, lx1 = min(h, int(np.ceil(y1 * scale)) + 1), min(w, int(np.ceil(x1 * scale)) + 1)
    crop = new_full[int(round(ly0 / scale)):int(round(ly1 / scale)), int(round(lx0 / scale)):int(round(lx1 / scale))]
    small = Image.fromarray((np.clip(crop, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((lx1 - lx0, ly1 - ly0), Image.BOX)
    out = old_img.copy()
    out[ly0:ly1, lx0:lx1] = np.asarray(small, np.float32) / 255
    return out, (ly0, ly1, lx0, lx1)


# ------------------------------------------------------------------------------------------------ steps
def regenerate(work, ids, fresh):
    env = {k: v for k, v in os.environ.items() if k not in ('LIVERY', 'A320_LIVERY', 'B737_LIVERY', 'GOKYUZU_BRAND_DIR')}
    env['GOKYUZU_BRAND'] = 'off'
    for aid in ids:
        out = os.path.join(work, 'tex', aid)
        done = os.path.join(out, '.done')
        if os.path.exists(done) and not fresh:
            log(aid, 'textures already regenerated (--fresh redoes them)')
            continue
        missing = [p for p in NEEDS.get(aid, []) if not os.path.exists(p)]
        if missing:
            raise SystemExit(f'{aid}: build caches missing ({", ".join(missing)}): run that full build once first')
        os.makedirs(out, exist_ok=True)
        for cmd in SPEC[aid]['regen']:
            args = [a.replace('{out}', out) for a in cmd]
            args = [os.path.join(REPO, a) if a.startswith(('assets/', 'blender/', 'tools/')) else a for a in args]
            for a in args[1:]:
                if a.startswith(out):
                    os.makedirs(a, exist_ok=True)
            t0 = time.time()
            r = subprocess.run([PY] + args, cwd=REPO, env=dict(env, GOKYUZU_TEX_OUT=out), capture_output=True, text=True)
            if r.returncode:
                sys.stderr.write(r.stdout[-4000:] + r.stderr[-4000:])
                raise SystemExit(f'{aid}: {" ".join(cmd)} failed')
            log(aid, cmd[0], f'{time.time() - t0:.0f} s')
        open(done, 'w').write('ok\n')


def find(texdir, dirs, name, mime):
    for d in dirs:
        for ext in EXT.get(mime, ()):
            p = os.path.join(texdir, d, name + ext)
            if os.path.isfile(p):
                return p
    return None


SHARED_FULL = {}      # patched full-size image name -> (new image, patched bbox): 'lite' patches downsample these


def replacement(rel, spec, texdir, dst, name, mime, data):
    """Replacement file for one embedded image, or None when it stays."""
    p = find(texdir, spec.get('dirs', []), name, mime)
    if p:
        return p if open(p, 'rb').read() != bytes(data) else None
    if name in spec.get('derive', {}):
        base = spec['derive'][name]
        dirs = spec.get('dirs') or ['.']
        sp = find(texdir, dirs, base, 'image/jpeg') or find(texdir, dirs, base, 'image/png')
        if not sp:
            raise SystemExit(f'{rel}: {name}: regenerated {base} not found in {texdir}')
        full = source_glb(rel.replace('_lod.glb', '.glb'))
        old_base = glb_images(full).get(base) if os.path.exists(full) else None
        if old_base is not None and open(sp, 'rb').read() == bytes(old_base[1]):
            return None                                   # the full-size source did not change: keep Blender's LOD
        ext = EXT.get(mime, ('.png',))[0]
        target = os.path.join(dst, name + ext)
        im = Image.open(sp).convert('RGB').resize(Image.open(io.BytesIO(bytes(data))).size, Image.LANCZOS)
        im.save(target, **({'quality': 88} if ext == '.jpg' else {'optimize': True}))
        return target
    pt = spec.get('patch', {}).get(name)
    if not pt:
        return None
    old_img = load(bytes(data))
    if pt['kind'] == 'lite':
        if pt['of'] not in SHARED_FULL:
            return None
        new_full, box = SHARED_FULL[pt['of']]
        arr, box = patch_lite(old_img, new_full, box, pt['scale'])
    else:
        fn = patch_baked if pt['kind'] == 'baked' else patch_direct
        arr, box = fn(old_img, load(pt['old']), load(os.path.join(texdir, pt['new'])))
        if arr is not None:
            SHARED_FULL[name] = (arr, box)
    if arr is None:
        return None
    # lossless: the pack ships the KTX2 encoded from this image; a second JPEG generation would only lose detail
    target = os.path.join(dst, name + '.png')
    save_png(arr, target)
    log(rel, name, f'patched rows {box[0]}-{box[1]}, columns {box[2]}-{box[3]}')
    return target


def plan(work, ids):
    out = {}
    for aid in ids:
        texdir = os.path.join(work, 'tex', aid)
        for rel, spec in SPEC[aid]['glbs'].items():          # cockpit GLBs first: their patches feed interior_lite
            src = source_glb(rel)
            imgs = glb_images(src)
            dst = os.path.join(work, 'swap', rel)
            os.makedirs(dst, exist_ok=True)
            rep = {}
            for name, (mime, data) in imgs.items():
                r = replacement(rel, spec, texdir, dst, name, mime, data)
                if r:
                    rep[name] = r
            if rep:
                out[rel] = {'src': src, 'images': rep}
                log(rel, f'{len(rep)} of {len(imgs)} images replaced:', ', '.join(sorted(rep)))
            else:
                log(rel, 'unchanged')
    return out


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        raise SystemExit(__doc__)
    work = os.path.abspath(args[0])
    ids = list(SPEC)
    if '--only' in args:
        ids = [i for i in args[args.index('--only') + 1].split(',') if i]
        bad = [i for i in ids if i not in SPEC]
        if bad:
            raise SystemExit(f'unknown ids {bad}: one of {", ".join(SPEC)}')
    regenerate(work, ids, '--fresh' in args)
    result = plan(work, ids)
    with open(os.path.join(work, 'swap', 'plan.json'), 'w') as f:
        json.dump(result, f, indent=1)
    log('plan:', len(result), 'GLBs with replaced images ->', os.path.relpath(os.path.join(work, 'swap', 'plan.json'), REPO))


if __name__ == '__main__':
    main()
