from collections import Counter, defaultdict
from sessions import build_sessions
import statistics
ss, n, lost = build_sessions()
print(len(ss), 'real sessions; orphan tut beacons', n, 'unattributed', lost)
# what the report sees vs reality
fl = [s for s in ss if s['fly']]
rep_started = sum(1 for s in fl if any(e['q'].get('t')=='tut' and not e.get('orphan') for e in s['evs']))
rep_done = sum(1 for s in fl if any(e['q'].get('t')=='tut' and not e.get('orphan') and e['q'].get('st')=='done' for e in s['evs']))
print('report.py view: started', rep_started, 'done', rep_done)
started = [s for s in fl if any(e['q'].get('t')=='tut' for e in s['evs'])]
done = [s for s in started if any(e['q'].get('t')=='tut' and e['q'].get('st')=='done' for e in s['evs'])]
skip = [s for s in started if any(e['q'].get('t')=='tut' and e['q'].get('x')=='skip' for e in s['evs'])]
crash = [s for s in started if any(e['q'].get('t')=='tut' and e['q'].get('x')=='crash' for e in s['evs'])]
print('re-attributed: started(any tut event)', len(started), 'done', len(done), 'skip', len(skip), 'crash-during', len(crash))
by_sc = defaultdict(lambda: Counter())
steps = defaultdict(list)
last = Counter()
for s in started:
    tuts = [e['q'] for e in s['evs'] if e['q'].get('t')=='tut']
    sc = tuts[0].get('sc')
    by_sc[sc]['sessions'] += 1
    if any(q.get('st')=='done' for q in tuts): by_sc[sc]['done'] += 1
    if any(q.get('x')=='skip' for q in tuts): by_sc[sc]['skip'] += 1
    if any(q.get('x')=='crash' for q in tuts): by_sc[sc]['crash'] += 1
    for q in tuts:
        if q.get('sec') and not q.get('x') and q.get('st') not in ('done','restart'):
            steps[(sc, q.get('i'), q.get('st'))].append(float(q['sec']))
    # where did the player stop? last step completed
    comp = [q for q in tuts if not q.get('x') and q.get('st') not in ('restart',)]
    last[(sc, comp[-1].get('st') if comp else '(none)', 'done' if any(q.get('st')=='done' for q in tuts) else '')] += 1
for sc, c in by_sc.items(): print(' ', sc, dict(c))
print('\nstep completions (count, median s, max s):')
for k in sorted(steps, key=lambda k: (k[0], int(k[1] or 0))):
    v = steps[k]; print('  ', k, len(v), round(statistics.median(v),1), round(max(v),1))
print('\nlast completed step per session:')
for k, v in sorted(last.items()): print('  ', k, v)
