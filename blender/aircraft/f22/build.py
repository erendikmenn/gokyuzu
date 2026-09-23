"""F-22A Raptor build script (Blender 5.2, headless).

  Blender -b -P blender/aircraft/f22/build.py -- [--all] [--bake] [--glb] [--lod] [--renders [hero,front,...]]
                                                [--samples N] [--preview DIR --views a,b] [--blend]
Stages:
  (always)        regenerate the 2-D texture sources with the project venv (textures.py, textures_ext.py -> assets/.../src)
  --bake          Cycles-bake position/normal/class/AO into the UV atlas and composite the skin maps
                  (assets/aircraft/f22/tex/); runs automatically when the maps are missing
  --glb           export assets/aircraft/f22/f22.glb
  --lod           export assets/aircraft/f22/f22_lod.glb (<= 40k tris, parked pose)
  --renders       Cycles renders into renders/aircraft/f22/ (hero 2560x1440, front_34, rear_nozzles, planform,
                  cockpit, thumb.jpg)
  --all           = --glb --lod --renders
Env: F22_DEVICE=CPU renders/bakes on the CPU (useful when the GPU is busy), F22_PCT=50 renders at 50 % size.
"""
import os
import sys
import math
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', 'common'))

import bpy  # noqa: E402
from util import reset_scene, REPO  # noqa: E402

for m in ('geom', 'shape', 'airframe', 'details', 'cockpit', 'materials', 'scene_f22', 'renders_f22'):
    if m in sys.modules:
        del sys.modules[m]

import scene_f22  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'preview': None, 'glb': False, 'lod': False, 'renders': None, 'bake': False, 'blend': False,
            'samples': 128, 'only': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--preview':
            opts['preview'] = argv[i + 1]
            i += 1
        elif a == '--renders':
            nxt = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith('--') else 'all'
            opts['renders'] = nxt
            if nxt != 'all' or (i + 1 < len(argv) and argv[i + 1] == 'all'):
                i += 1
        elif a == '--views':
            opts['views'] = argv[i + 1].split(',')
            i += 1
        elif a == '--samples':
            opts['samples'] = int(argv[i + 1])
            i += 1
        elif a.startswith('--'):
            opts[a[2:]] = True
        i += 1
    return opts


def gen_sources():
    import subprocess
    py = os.path.join(REPO, '.venv', 'bin', 'python')
    for script, args in (('textures.py', ['cockpit']), ('textures_ext.py', [])):
        r = subprocess.run([py, os.path.join(HERE, script)] + args, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[-3000:])
            raise RuntimeError(f'{script} failed')


def main():
    t0 = time.time()
    opts = parse_args()
    if opts.get('all'):
        opts['glb'] = opts['lod'] = True
        opts['renders'] = opts['renders'] or 'all'
    gen_sources()
    tex = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'tex', 'f22_basecolor.jpg')
    if not os.path.exists(tex):
        opts['bake'] = True
    reset_scene()
    ctx = scene_f22.build_all(bake=opts['bake'])
    print(f'[f22] built scene in {time.time() - t0:.1f}s')
    scene_f22.report(ctx)
    if opts['preview']:
        scene_f22.preview(ctx, opts['preview'], opts.get('views'))
    if opts['glb']:
        scene_f22.export_main(ctx)
    if opts['lod']:
        scene_f22.export_lod(ctx)
    if opts['blend']:
        path = os.path.join(REPO, 'assets', 'aircraft', 'f22', 'f22.blend')
        bpy.ops.wm.save_as_mainfile(filepath=path)
    if opts['renders']:
        import renders_f22
        renders_f22.render(ctx, opts['renders'], opts['samples'])
    print(f'[f22] done in {time.time() - t0:.1f}s')


main()
