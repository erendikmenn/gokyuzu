"""Shared loader for the error audit: parses every CloudFront log line of both targets, never keeps raw IPs."""
import datetime as dt
import gzip
import hashlib
import pickle
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools' / 'analytics'))
import report  # noqa: E402

CACHE = ROOT / 'data' / 'analytics' / 'audit-rows.pkl'   # gitignored, next to the downloaded logs
KEEP = ['date', 'time', 'x-edge-location', 'sc-bytes', 'cs-method', 'cs-uri-stem', 'sc-status', 'cs(Referer)',
        'cs-uri-query', 'x-edge-result-type', 'x-edge-response-result-type', 'x-edge-detailed-result-type', 'cs-protocol',
        'time-taken', 'time-to-first-byte', 'cs-protocol-version', 'sc-content-type', 'sc-content-len', 'sc-range-start',
        'sc-range-end', 'ssl-protocol', 'cs(Host)', 'x-host-header']


def load(force=False):
    if CACHE.exists() and not force:
        return pickle.loads(CACHE.read_bytes())
    key_salt, mine = report.salt(), report.own_ips()
    rows = []
    for target in ('production', 'staging'):
        folder = ROOT / 'data' / 'analytics' / target
        for path in sorted(folder.glob('*.gz')):
            with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as f:
                fields = []
                for line in f:
                    if line.startswith('#Fields:'):
                        fields = line.split()[1:]
                        continue
                    if line.startswith('#') or not fields:
                        continue
                    raw = dict(zip(fields, line.rstrip('\n').split('\t')))
                    ua = unquote(raw.get('cs(User-Agent)', '-'))
                    xff = unquote(raw.get('x-forwarded-for', '-'))
                    ip = xff.split(',')[0].strip() if xff not in ('-', '') else raw.get('c-ip', '')
                    r = {k: raw.get(k, '') for k in KEEP}
                    r['target'] = target
                    r['file'] = path.name
                    r['at'] = dt.datetime.fromisoformat(f"{raw['date']}T{raw['time']}+00:00")
                    r['ua'] = ua
                    r['vid'] = hashlib.sha256(f'{key_salt}|{ip}|{ua}'.encode()).hexdigest()[:6]
                    r['ipid'] = hashlib.sha256(f'{key_salt}|{ip}'.encode()).hexdigest()[:6]   # same network, any browser
                    r['who'] = 'sen' if ip in mine else ('test' if 'headless' in ua.lower() else '')
                    r['bot'] = any(w in ua.lower() for w in report.BOT_WORDS)
                    r['q'] = report.query(raw) if raw.get('cs-uri-stem') == '/_e' else {}
                    rows.append(r)
    CACHE.write_bytes(pickle.dumps(rows))
    return rows


if __name__ == '__main__':
    rows = load(force=True)
    print(len(rows), 'rows')
