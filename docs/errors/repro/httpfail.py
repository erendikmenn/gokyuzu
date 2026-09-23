import datetime as dt, statistics, re
from logs import load, report
from collections import Counter, defaultdict
from logs import load
U = lambda h, m: dt.datetime(2026, 9, 23, h, m, tzinfo=dt.timezone.utc)
def build(at):
    return 'v1.0' if at < U(16, 34) else '3833a08' if at < U(17, 24) else '94a7a5a' if at < U(18, 10) else '5d6612f'
rows = [r for r in load() if r['target'] == 'production' and not r['bot'] and r['who'] != 'test']
print('production rows', len(rows), 'window', min(r['at'] for r in rows), max(r['at'] for r in rows))
print('status', Counter(r['sc-status'] for r in rows).most_common())
print('edge result', Counter(r['x-edge-result-type'] for r in rows).most_common())
print('detailed', Counter(r['x-edge-detailed-result-type'] for r in rows).most_common())
bad = [r for r in rows if not r['sc-status'].startswith(('2', '3'))]
print('\n--- non-2xx/3xx by status/path ---')
for (st, p), n in Counter((r['sc-status'], r['cs-uri-stem']) for r in bad).most_common(40):
    vids = {r['vid'] for r in bad if r['sc-status'] == st and r['cs-uri-stem'] == p}
    cl = Counter('/'.join(report.client(r['ua'])) for r in bad if r['sc-status'] == st and r['cs-uri-stem'] == p).most_common(3)
    bl = Counter(build(r['at']) for r in bad if r['sc-status'] == st and r['cs-uri-stem'] == p)
    det = Counter(r['x-edge-detailed-result-type'] for r in bad if r['sc-status'] == st and r['cs-uri-stem'] == p)
    print(f'  {st} {n:5} visitors={len(vids):3} {p[:60]:60} {dict(bl)} {dict(det)} {cl}')
print('\n--- error-type rows that were not 4xx/5xx (e.g. 200 + ClientCommError / aborted) ---')
odd = [r for r in rows if r['x-edge-result-type'] == 'Error' and r['sc-status'].startswith(('2', '3', '0'))]
for (st, det, cls), n in Counter((r['sc-status'], r['x-edge-detailed-result-type'], re.sub(r'/[^/]*$', '/', r['cs-uri-stem'])[:45]) for r in odd).most_common(25):
    print(f'  {st} {det:22} {cls:45} {n}')
