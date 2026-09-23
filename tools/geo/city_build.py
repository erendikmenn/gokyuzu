"""W2 city: run blender/city/build_tiles.py in parallel over all prepared tiles, then write assets/sf/city/index.json.

  .venv/bin/python tools/geo/city_build.py [--jobs 8] [--force] [--index-only] [--only i_j,...]

Incremental: a tile is rebuilt only when its prepared JSON changed (hash stored in the tile meta), so re-running after
city_prep.py (e.g. new airport exclusions from W4) only re-exports the affected tiles.
"""
import glob, json, os, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender'
TILES = os.path.join(ROOT, 'data', 'sf', 'cache', 'city', 'tiles')
OUT = os.path.join(ROOT, 'assets', 'sf', 'city')


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


def write_index():
    levels = []
    for lvl, size in ((0, 500), (1, 1000), (2, 2000), (3, 2000)):
        tiles = []
        for m in sorted(glob.glob(os.path.join(OUT, f'l{lvl}', '*.json'))):
            js = json.load(open(m))
            if not os.path.exists(m[:-5] + '.glb'):
                continue
            tiles.append({k: js[k] for k in ('i', 'j', 'minX', 'maxX', 'minZ', 'maxZ', 'maxY', 'tris', 'bytes', 'buildings')})
        levels.append({'level': lvl, 'size': size, 'dir': f'l{lvl}', 'placement': 'vertex' if lvl >= 2 else 'anchor', 'tiles': tiles})
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
        run_all(jobs, '--force' in sys.argv, only)
    write_index()
