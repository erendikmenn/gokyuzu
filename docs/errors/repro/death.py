import datetime as dt, statistics
from collections import Counter, defaultdict
from sessions import build_sessions
from logs import load
rows = [r for r in load() if r['target'] == 'production' and r['cs-uri-stem'] != '/_e']
by_vid = defaultdict(list)
for r in rows: by_vid[r['vid']].append(r)
for v in by_vid.values(): v.sort(key=lambda r: r['at'])
ss, _, _ = build_sessions()
def klass(s):
    return 'iOS' if s['os'] == 'iOS' else 'Android' if s['os'] == 'Android' else 'desktop'
out = defaultdict(list); lastpaths = Counter(); lastdirs = Counter()
for s in ss:
    if not s['fly']: continue
    fly_at = next(e['at'] for e in s['evs'] if e['q'].get('t') == 'fly')
    nxt = min((o['evs'][0]['at'] for o in ss if o['vid'] == s['vid'] and o['evs'][0]['at'] > fly_at), default=fly_at + dt.timedelta(hours=1))
    reqs = [r for r in by_vid[s['vid']] if fly_at - dt.timedelta(seconds=20) <= r['at'] < nxt - dt.timedelta(seconds=1)]
    after = [r for r in reqs if r['at'] >= fly_at]
    last_req = max((r['at'] for r in reqs), default=fly_at)
    last_beacon = s['evs'][-1]['at']
    alive = (max(last_req, last_beacon) - fly_at).total_seconds()
    out[(klass(s), s['v'])].append((alive, len(after)))
    if klass(s) == 'iOS' and s['v'] != '5d6612f' and alive < 30:
        for r in reqs[-3:]: lastdirs['/'.join(r['cs-uri-stem'].split('/')[:5])] += 1
for k in sorted(out):
    v = out[k]; a = [x for x, _ in v]
    print(f"{k[0]:8} {k[1]:8} n={len(v):3}  page-alive-after-fly: median {statistics.median(a):5.0f}s  <30s: {sum(1 for x in a if x < 30):3}  >=60s: {sum(1 for x in a if x >= 60):3}  median reqs after fly {statistics.median(n for _, n in v):.0f}")
print('\nlast 3 requests before death (iOS, pre-5d6612f, alive<30s):', lastdirs.most_common(12))
