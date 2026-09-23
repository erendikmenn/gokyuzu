import datetime as dt, re, statistics
from collections import Counter, defaultdict
from logs import load
U = lambda h, m: dt.datetime(2026, 9, 23, h, m, tzinfo=dt.timezone.utc)
def build(at): return 'v1.0' if at < U(16, 34) else '3833a08' if at < U(17, 24) else '94a7a5a' if at < U(18, 10) else '5d6612f'
def cls(p):
    for pre, name in [('/_e', 'beacon'), ('/assets/sf/terrain/h/', 'terrain height'), ('/assets/sf/terrain/img/', 'terrain imagery'),
                      ('/assets/sf/terrain/', 'terrain other'), ('/assets/sf/city/l', 'city tiles'), ('/assets/sf/city/trees/', 'trees'),
                      ('/assets/sf/city/obst/', 'city obstacles'), ('/assets/sf/city/', 'city other'), ('/assets/sf/landmarks/', 'landmarks'),
                      ('/assets/sf/airports/', 'airports'), ('/assets/aircraft/', 'aircraft GLB'), ('/assets/audio/', 'audio'),
                      ('/renders/', 'menu renders'), ('/src/', 'JS src'), ('/node_modules/', 'three.js'), ('/data/', 'data json')]:
        if p.startswith(pre): return name
    return 'root/other'
rows = [r for r in load() if r['target'] == 'production' and not r['bot'] and 'headless' not in r['ua'].lower()]
by = defaultdict(list)
for r in rows: by[cls(r['cs-uri-stem'])].append(r)
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))] if xs else 0
print(f"{'class':16} {'n':>6} {'GB':>6} {'p50':>6} {'p95':>6} {'p99':>6} {'max':>6}  ttfb95  hit%  miss%  refresh%  err")
for k, v in sorted(by.items(), key=lambda kv: -len(kv[1])):
    tt = [float(r['time-taken']) for r in v if r['time-taken'] not in ('-', '')]
    fb = [float(r['time-to-first-byte']) for r in v if r['time-to-first-byte'] not in ('-', '')]
    c = Counter(r['x-edge-result-type'] for r in v); n = len(v)
    gb = sum(int(r['sc-bytes'] or 0) for r in v) / 1e9
    print(f"{k:16} {n:6} {gb:6.1f} {q(tt,.5):6.3f} {q(tt,.95):6.2f} {q(tt,.99):6.2f} {max(tt):6.1f}  {q(fb,.95):6.3f} {100*c['Hit']/n:5.0f} {100*c['Miss']/n:6.0f} {100*c['RefreshHit']/n:8.0f} {c['Error']:5}")
# slowest non-fill requests
print('\nslowest 12 (excluding full-file terrain fills):')
sl = sorted((r for r in rows if not (r['cs-uri-stem'].startswith('/assets/sf/terrain/h/') and r['sc-status'] == '200')), key=lambda r: -float(r['time-taken'] if r['time-taken'] not in ('-','') else 0))[:12]
for r in sl: print(f"  {r['time-taken']:>7} ttfb={r['time-to-first-byte']:>6} {r['sc-status']} {r['x-edge-detailed-result-type']:10} {r['sc-bytes']:>10} {r['cs-uri-stem'][:60]}")
# versioning bypass: asset/renders requests without ?v= after versioning shipped (3833a08+)
print('\nassets/renders requests without ?v= by build:')
nov = Counter(); tot = Counter()
for r in rows:
    p = r['cs-uri-stem']
    if not (p.startswith('/assets/') or p.startswith('/renders/')): continue
    b = build(r['at']); tot[b] += 1
    if 'v=' not in r['cs-uri-query']: nov[b] += 1
for b in tot: print('  ', b, nov[b], 'of', tot[b])
late = [r for r in rows if build(r['at']) != 'v1.0' and (r['cs-uri-stem'].startswith('/assets/') or r['cs-uri-stem'].startswith('/renders/')) and 'v=' not in r['cs-uri-query']]
print('  paths (post v1.0):', Counter(re.sub(r'/[^/]*$', '/', r['cs-uri-stem']) for r in late).most_common(12))
print('  visitors:', len({r['vid'] for r in late}), ' referers:', Counter((r['cs(Referer)'] or '')[:40] for r in late).most_common(4))
