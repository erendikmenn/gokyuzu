"""W2 city: run blender/city/build_tiles.py in parallel over all prepared tiles, then write assets/sf/city/index.json.

  .venv/bin/python tools/geo/city_build.py [--jobs 8] [--force] [--index-only] [--only i_j,...]
  GEO_REGION=ist .venv/bin/python tools/geo/city_build.py [--jobs 14] [--force]   (Python / meshopt builder:
                                                                                   tools/geo/city_mesh.py, no Blender)

Incremental: a tile is rebuilt only when its prepared JSON changed (hash stored in the tile meta), so re-running after
city_prep.py (e.g. new airport exclusions from W4) only re-exports the affected tiles.
"""
import glob, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from city_paths import ROOT, CACHE, OUT, REGION_ID  # noqa: E402

BLENDER = os.environ.get('BLENDER', '/Applications/Blender.app/Contents/MacOS/Blender')   # Blender 5.2 binary
TILES = os.path.join(CACHE, 'tiles')


def chunks(lst, n):
    return [lst[k::n] for k in range(n)]


def run_all(jobs, force, only):
    l1 = sorted(os.path.basename(p)[3:-5] for p in glob.glob(os.path.join(TILES, 'L1_*.json')))
    l2 = sorted(os.path.basename(p)[3:-5] for p in glob.glob(os.path.join(TILES, 'L2_*.json')))
    if only:
        l1 = [t for t in l1 if t in only]
        l2 = []
    procs = []
    t0 = time.time()
    for k, part in enumerate(chunks(l1, jobs)):
        far = chunks(l2, jobs)[k]
        args = [BLENDER, '-b', '--factory-startup', '-P', os.path.join(ROOT, 'blender', 'city', 'build_tiles.py'), '--']
        if part:
            args += ['--tiles', ','.join(part)]
        if far:
            args += ['--far', ','.join(far)]
        if force:
            args.append('--force')
        if len(args) <= 7:
            continue
        log = open(os.path.join(OUT, f'build_{k}.log'), 'w')
        procs.append(subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT))
    for p in procs:
        p.wait()
    print(f'blender build done in {time.time() - t0:.0f} s')


def _py_job(args):
    kind, i, j, force = args
    import city_mesh
    if kind == 'l1':
        return city_mesh.build_l1(i, j, force)
    return city_mesh.build_far(i, j, 2, force), city_mesh.build_far(i, j, 3, force)


def run_all_py(jobs, force, only):
    """Python builder (city_mesh.py) over a process pool: heaviest tiles first."""
    import multiprocessing as mp
    l1 = [os.path.basename(p)[3:-5] for p in glob.glob(os.path.join(TILES, 'L1_*.json'))]
    far = sorted({os.path.basename(p)[3:-5] for p in glob.glob(os.path.join(TILES, 'L[23]_*.json'))} |
                 {os.path.basename(p)[:-4] for p in glob.glob(os.path.join(OUT, 'l[23]', '*.glb'))})
    if only:
        l1 = [t for t in l1 if t in only]
        far = []
    l1.sort(key=lambda t: -os.path.getsize(os.path.join(TILES, f'L1_{t}.json')))
    tasks = [('l1', *map(int, t.split('_')), force) for t in l1] + [('far', *map(int, t.split('_')), force) for t in far]
    for d in ('l0', 'l1', 'l2', 'l3'):
        os.makedirs(os.path.join(OUT, d), exist_ok=True)
    if not only:     # tiles whose prepared JSON is gone (e.g. new exclusions): remove their GLBs
        have = set(l1)
        for d, f in (('l1', 1), ('l0', 2)):
            for g in glob.glob(os.path.join(OUT, d, '*.glb')):
                i, j = map(int, os.path.basename(g)[:-4].split('_'))
                if f'{i // f}_{j // f}' not in have:
                    for ext in ('.glb', '.json'):
                        if os.path.exists(g[:-4] + ext):
                            os.remove(g[:-4] + ext)
    t0 = time.time()
    done = 0
    with mp.get_context('spawn').Pool(jobs) as pool:
        for _ in pool.imap_unordered(_py_job, tasks, chunksize=1):
            done += 1
            if done % 100 == 0:
                print(f'  {done}/{len(tasks)} tiles ({time.time() - t0:.0f} s)', flush=True)
    print(f'python build done in {time.time() - t0:.0f} s ({len(tasks)} tasks)')


def write_index():
    levels = []
    for lvl, size in ((0, 500), (1, 1000), (2, 2000), (3, 2000)):
        tiles = []
        for m in sorted(glob.glob(os.path.join(OUT, f'l{lvl}', '*.json'))):
            js = json.load(open(m))
            if not os.path.exists(m[:-5] + '.glb'):
                continue
            tiles.append({k: js[k] for k in ('i', 'j', 'minX', 'maxX', 'minZ', 'maxZ', 'maxY', 'tris', 'bytes', 'buildings')})
        # İstanbul's LOD1 are merged blocks placed per vertex (city_mesh.py); San Francisco's LOD1 keep the anchors
        vertex_from = 2 if REGION_ID == 'sf' else 1
        levels.append({'level': lvl, 'size': size, 'dir': f'l{lvl}', 'placement': 'vertex' if lvl >= vertex_from else 'anchor', 'tiles': tiles})
    obst = sorted(os.path.basename(p)[:-7] for p in glob.glob(os.path.join(OUT, 'obst', '*.bin.gz')))
    trees = None
    tpath = os.path.join(OUT, 'trees', 'trees.json')
    if os.path.exists(tpath):
        trees = 'trees/trees.json'
    index = {'version': 1, 'levels': levels, 'obstacles': {'dir': 'obst', 'size': 1000, 'cell': 4, 'tiles': obst},
             'atlas': 'atlas/atlas.json', 'trees': trees}
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
    for l in levels:
        print(f"L{l['level']}: {len(l['tiles'])} tiles, {sum(t['tris'] for t in l['tiles']) / 1e6:.1f} M tris, "
              f"{sum(t['bytes'] for t in l['tiles']) / 1e6:.0f} MB")


if __name__ == '__main__':
    jobs = 8
    if '--jobs' in sys.argv:
        jobs = int(sys.argv[sys.argv.index('--jobs') + 1])
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    if '--index-only' not in sys.argv:
        if REGION_ID == 'sf':
            run_all(jobs, '--force' in sys.argv, only)
        else:
            run_all_py(jobs, '--force' in sys.argv, only)
    write_index()
