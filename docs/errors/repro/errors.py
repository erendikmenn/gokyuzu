"""Inventory of every t=err beacon with its session context (no IPs; visitor = salted hash)."""
from collections import Counter, defaultdict
import sys
from logs import load
import report

rows = load()
sessions = defaultdict(list)
for r in rows:
    if r['cs-uri-stem'] == '/_e' and r['q'].get('s'):
        sessions[(r['target'], r['q']['s'])].append(r)
for evs in sessions.values():
    evs.sort(key=lambda r: (r['at'], int(r['q'].get('n', 0) or 0)))

print('sessions with beacons:', len(sessions))
print('builds:', Counter((k[0], next((e['q'].get('v') for e in evs if e['q'].get('v')), '?')) for k, evs in sessions.items()))
print('event types:', Counter(e['q'].get('t') for evs in sessions.values() for e in evs))

def ctx(evs):
    op = next((e['q'] for e in evs if e['q'].get('t') == 'open'), {})
    fl = next((e['q'] for e in evs if e['q'].get('t') == 'fly'), {})
    b, s = report.client(evs[0]['ua'])
    return op, fl, b, s

errs = defaultdict(list)
for key, evs in sessions.items():
    for i, e in enumerate(evs):
        if e['q'].get('t') == 'err':
            errs[(e['q'].get('e', ''), e['q'].get('f', ''))].append((key, i))

print('\n==== distinct errors ====')
for (msg, f), hits in sorted(errs.items(), key=lambda kv: -len(kv[1])):
    keys = {k for k, _ in hits}
    print(f'\n### [{len(hits)} beacons, {len(keys)} sessions] {msg!r}  f={f!r}')
    for key, i in hits:
        evs = sessions[key]
        op, fl, b, s = ctx(evs)
        e = evs[i]
        who = evs[0]['who'] or ''
        prev = [f"{p['q'].get('t')}" + (f"({p['q'].get('k') or p['q'].get('r') or p['q'].get('e','')[:30]})" if p['q'].get('t') in ('gfx', 'crash', 'err') else '')
                for p in evs[max(0, i - 6):i]]
        after = [p['q'].get('t') for p in evs[i + 1:i + 4]]
        gfx = [p['q'] for p in evs if p['q'].get('t') == 'gfx']
        print(f"  {key[0][:4]} s={key[1]} v={e['q'].get('v')} {e['at']:%H:%M:%S}Z m={e['q'].get('m')} vid={evs[0]['vid']} {who} "
              f"{b}/{s} gpu={op.get('gpu')!r} {op.get('w')}x{op.get('h')}@{op.get('dpr')} q={op.get('q')}/{fl.get('q')} "
              f"ac={fl.get('ac')} sp={fl.get('sp')} lt={fl.get('lt')}")
        print(f"     before: {prev}  after: {after}  n_ev={len(evs)}")
        if gfx:
            print('     gfx:', gfx[:4])
