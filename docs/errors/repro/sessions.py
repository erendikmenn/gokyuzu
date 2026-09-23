"""Session reconstruction: re-attributes orphaned tut beacons (their `s` = step seconds overwrote the session id)."""
import re
from collections import defaultdict
import datetime as dt
from logs import load
import report

NUM = re.compile(r'^\d+(\.\d+)?$')
BUILD_SHORT = {'v1.0.0-20-g3833a08': '3833a08', 'release-20260923-1934-2-g94a7a5a': '94a7a5a',
               'release-20260923-2024-3-g5d6612f': '5d6612f'}


def build_sessions(target='production', include_own=False):
    rows = [r for r in load() if r['target'] == target]
    sess, orphans = defaultdict(list), []
    for r in rows:
        if r['cs-uri-stem'] != '/_e' or r['bot']:
            continue
        s = r['q'].get('s')
        if not s:
            continue
        if NUM.match(s) and r['q'].get('t') == 'tut':
            orphans.append(r)
        else:
            sess[s].append(r)
    for evs in sess.values():
        evs.sort(key=lambda r: (r['at'], int(r['q'].get('n', 0) or 0)))
    # attribute each orphan to the session of the same visitor (salted IP+UA) that was running at that time
    by_vid = defaultdict(list)
    for sid, evs in sess.items():
        by_vid[evs[0]['vid']].append((evs[0]['at'], evs[-1]['at'], sid))
    lost = 0
    for r in orphans:
        cands = [(a, b, sid) for a, b, sid in by_vid.get(r['vid'], []) if a <= r['at'] <= b + dt.timedelta(minutes=2)]
        if not cands:
            lost += 1
            continue
        a, b, sid = max(cands)          # latest-started session that covers the time
        rr = dict(r)
        rr['q'] = dict(r['q'])
        rr['q']['sec'] = rr['q'].pop('s')
        rr['q']['s'] = sid
        rr['orphan'] = True
        sess[sid].append(rr)
    for evs in sess.values():
        evs.sort(key=lambda r: (r['at'], int(r['q'].get('n', 0) or 0)))
    out = []
    for sid, evs in sess.items():
        who = evs[0]['who']
        if who and not include_own:
            continue
        op = next((e['q'] for e in evs if e['q'].get('t') == 'open'), {})
        fl = next((e['q'] for e in evs if e['q'].get('t') == 'fly'), {})
        v = next((e['q'].get('v') for e in evs if e['q'].get('v')), '')
        b, s = report.client(evs[0]['ua'])
        if 'Twitter for iPhone' in evs[0]['ua'] or 'Instagram' in evs[0]['ua'] or 'FBAN' in evs[0]['ua']:
            b = 'in-app'
        out.append({'sid': sid, 'evs': evs, 'open': op, 'fly': fl, 'v': BUILD_SHORT.get(v, v), 'browser': b, 'os': s,
                    'vid': evs[0]['vid'], 'who': who, 'ua': evs[0]['ua']})
    return out, len(orphans), lost


if __name__ == '__main__':
    ss, n, lost = build_sessions()
    print(len(ss), 'sessions; orphans', n, 'unattributed', lost)
