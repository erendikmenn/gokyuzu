from collections import Counter, defaultdict
import datetime as dt
from sessions import build_sessions
from logs import load
rows = [r for r in load() if r['target']=='production' and r['cs-uri-stem'] != '/_e']
by_vid = defaultdict(list)
for r in rows: by_vid[r['vid']].append(r)
for v in by_vid.values(): v.sort(key=lambda r: r['at'])
ss, _, _ = build_sessions()
opened = [s for s in ss if s['open']]
nofly = [s for s in opened if not s['fly']]
print('sessions with open:', len(opened), ' without fly:', len(nofly))
# same visitor, a later session that flew? (reload / retry)
cls = Counter(); detail = []
for s in nofly:
    t0 = s['evs'][0]['at']; t1 = s['evs'][-1]['at']
    endev = next((e for e in s['evs'] if e['q'].get('t')=='end'), None)
    nxt = [o for o in ss if o['vid']==s['vid'] and o is not s and o['evs'][0]['at'] > t0]
    nxt_at = min((o['evs'][0]['at'] for o in nxt), default=None)
    hi = min(nxt_at or t1 + dt.timedelta(minutes=10), t1 + dt.timedelta(minutes=10))
    reqs = [r for r in by_vid[s['vid']] if t0 - dt.timedelta(seconds=5) <= r['at'] <= hi]
    terr = [r for r in reqs if '/assets/sf/terrain/' in r['cs-uri-stem']]
    glb = [r for r in reqs if r['cs-uri-stem'].startswith('/assets/aircraft/')]
    bad = [r for r in reqs if not r['sc-status'].startswith(('2','3')) and 'favicon' not in r['cs-uri-stem'] and 'apple-touch' not in r['cs-uri-stem']]
    errt = Counter(r['x-edge-detailed-result-type'] for r in reqs if r['x-edge-result-type'] == 'Error')
    started = bool(terr or glb)
    flew_later = any(o['fly'] for o in nxt if (o['evs'][0]['at'] - t1) < dt.timedelta(minutes=5))
    k = ('loading started' if started else 'menu only') + (' → reloaded & flew' if flew_later else '')
    cls[k] += 1
    detail.append((k, s, len(reqs), len(terr), len(glb), bad, errt, endev, t1 - t0))
print(cls)
dev = defaultdict(Counter)
for k, s, n, nt, ng, bad, errt, endev, span in detail:
    dev[k][f"{s['browser']}/{s['os']} {s['open'].get('gpu','')[:22]}"] += 1
for k, c in dev.items(): print('\n', k, c.most_common(12))
print('\n--- loading started but never flew ---')
for k, s, n, nt, ng, bad, errt, endev, span in sorted(detail, key=lambda d: d[0]):
    if not k.startswith('loading'): continue
    print(f"  {s['v']:8} {s['browser']}/{s['os']} gpu={s['open'].get('gpu','')!r} {s['open'].get('w')}x{s['open'].get('h')}@{s['open'].get('dpr')} q={s['open'].get('q')} "
          f"reqs={n} terr={nt} glb={ng} end={'m='+endev['q'].get('m') if endev else '-'} span={span.total_seconds():.0f}s bad={[(r['cs-uri-stem'][-40:], r['sc-status'], r['x-edge-detailed-result-type']) for r in bad][:4]} errt={dict(errt)} [{k}] sid={s['sid']}")
