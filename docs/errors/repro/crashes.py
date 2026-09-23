from collections import Counter, defaultdict
from sessions import build_sessions
ss, _, _ = build_sessions()
rows = []
for s in ss:
    evs = s['evs']
    fly_at = next((e['at'] for e in evs if e['q'].get('t')=='fly'), None)
    last_reset = fly_at; took = False; last_to = None
    for e in evs:
        q = e['q']; t = q.get('t')
        if t == 'takeoff': took = True; last_to = e['at']
        if t == 'crash':
            since_fly = (e['at']-fly_at).total_seconds() if fly_at else None
            since_prev = (e['at']-last_reset).total_seconds() if last_reset else None
            rows.append({'s': s, 'r': q.get('r'), 'd': q.get('d'), 'w': q.get('w',''), 'ac': q.get('ac'), 'sp': q.get('sp'),
                         'since_fly': since_fly, 'since_prev': since_prev, 'took': took, 'since_to': (e['at']-last_to).total_seconds() if last_to else None, 'v': s['v']})
            last_reset = e['at']  # game auto-resets 4 s after a crash
print('crashes', len(rows), 'sessions', len({id(r['s']) for r in rows}))
print(Counter(r['r'] for r in rows).most_common())
print(Counter(r['d'] for r in rows).most_common())
print('\nby aircraft/spawn:', Counter((r['ac'], r['sp']) for r in rows).most_common())
print('\nwithin 20 s of the previous spawn/reset (resets add ~4 s):')
for r in sorted(rows, key=lambda r: r['since_prev'] or 0):
    if r['since_prev'] is not None and r['since_prev'] <= 20:
        print(f"  {r['since_prev']:5.0f}s {r['v']:8} {r['ac']:8} {r['sp']:14} r={r['r']} d={r['d']!r} w={r['w']} took={r['took']} {r['s']['browser']}/{r['s']['os']} sid={r['s']['sid']}")
print('\nnot yet airborne (no takeoff event before the crash):')
for r in rows:
    if not r['took']:
        print(f"  {r['since_prev'] or 0:5.0f}s {r['v']:8} {r['ac']:8} {r['sp']:14} r={r['r']} d={r['d']!r} w={r['w']} {r['s']['browser']}/{r['s']['os']} sid={r['s']['sid']}")
print('\nobstacle-type crashes:')
for r in rows:
    if r['r'] and ('obst' in r['r'] or 'build' in r['r'] or 'engel' in (r['d'] or '').lower() or 'bina' in (r['d'] or '').lower()):
        print(f"  {r['since_prev'] or 0:5.0f}s {r['v']:8} {r['ac']:8} {r['sp']:14} r={r['r']} d={r['d']!r} took={r['took']} since_to={r['since_to']}")
