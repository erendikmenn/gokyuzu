"""Hourly Gökyüzü statistics feed (AWS Lambda): CloudFront access logs → tools/analytics/report.py → the private
dashboard stats.erenailab.com (ingest contract v1). See infra/stats-feed/README.md.

One run: read the salt, the owner's IP list and the ingest token from SSM (SecureString); load the per-day history from
the feed's own private bucket; download the access logs from the oldest day without a final record (at least the last
48 h) into /tmp; build the day records and the snapshot with report.py (the same code as the local report); save the
history; POST the snapshot. Only aggregated numbers leave AWS. Secrets, bucket names and IPs are never logged.

The run's snapshot is also kept as last-snapshot.json next to the history (for checks against the local report).

Environment (template.yaml): LOG_BUCKET, LOG_PREFIX, STATE_BUCKET, STATE_KEY, INGEST_URL, PARAM_TOKEN, PARAM_SALT,
PARAM_OWN_IPS. Event: {} (the schedule) or {"push": false} (build and save, do not push).
"""
import datetime as dt
import gzip
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
# the package has tools/analytics/report.py next to this file; in the repo it is two levels up
sys.path.insert(0, str(HERE / 'tools' / 'analytics' if (HERE / 'tools').is_dir() else HERE.parents[1] / 'tools' / 'analytics'))
import report  # noqa: E402

LOGS = Path('/tmp/logs')
KEY_HOUR = re.compile(r'\.(\d{4}-\d{2}-\d{2}-\d{2})\.[^./]+\.gz$')   # <distribution>.<YYYY-MM-DD-HH>.<id>.gz (UTC)
MAX_BODY = 2_000_000
FAILS_STALE = 3            # after this many failed pushes in a row the next snapshot says "stale": true
USER_AGENT = 'erenailab-stats-feed/1.0'

# library warnings name hosts (a bucket's host carries its name): keep them out of the log; the pool fits the 16 threads
logging.getLogger('urllib3').setLevel(logging.ERROR)
logging.getLogger('botocore').setLevel(logging.ERROR)
s3 = boto3.client('s3', config=Config(max_pool_connections=20))
ssm = boto3.client('ssm')


def env(name):
    return os.environ[name]


def secrets():
    """(ingest token, salt, owner's IPs) from SSM; values are never printed."""
    names = [env('PARAM_TOKEN'), env('PARAM_SALT'), env('PARAM_OWN_IPS')]
    res = ssm.get_parameters(Names=names, WithDecryption=True)
    if res['InvalidParameters']:
        raise RuntimeError(f"{len(res['InvalidParameters'])} SSM parameter(s) missing: run infra/stats-feed/deploy.py")
    value = {p['Name']: p['Value'] for p in res['Parameters']}
    return value[names[0]].strip(), value[names[1]].strip(), report.parse_own_ips(value[names[2]])


def sync_logs(since):
    """Download the log files of hours from `since` - 2 h on into /tmp/logs (a warm container keeps what it has and
    drops what is older); returns (files in the window, files downloaded)."""
    LOGS.mkdir(exist_ok=True)
    first = (since - dt.timedelta(hours=2)).strftime('%Y-%m-%d-%H')
    want = {}
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=env('LOG_BUCKET'), Prefix=env('LOG_PREFIX')):
        for obj in page.get('Contents', []):
            m = KEY_HOUR.search(obj['Key'])
            if m and m[1] >= first:
                want[obj['Key'].rsplit('/', 1)[-1]] = obj['Key']
    for p in LOGS.iterdir():
        if p.name not in want:
            p.unlink()
    todo = [(name, key) for name, key in want.items() if not (LOGS / name).exists()]

    def get(item):
        name, key = item
        body = s3.get_object(Bucket=env('LOG_BUCKET'), Key=key)['Body'].read()
        tmp = LOGS / f'{name}.part'
        tmp.write_bytes(body)
        tmp.rename(LOGS / name)

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(get, todo))
    return len(want), len(todo)


def load_state():
    try:
        body = s3.get_object(Bucket=env('STATE_BUCKET'), Key=env('STATE_KEY'))['Body'].read()
    except ClientError as e:
        if e.response['Error']['Code'] in ('NoSuchKey', '404'):
            return None
        raise
    return json.loads(gzip.decompress(body))


def save_state(state, body=None):
    """The history, and next to it the snapshot of this run (aggregated numbers only: what was pushed)."""
    s3.put_object(Bucket=env('STATE_BUCKET'), Key=env('STATE_KEY'), Body=report.dump_state(state),
                  ContentType='application/gzip')
    if body is not None:
        s3.put_object(Bucket=env('STATE_BUCKET'), Key=f"{env('STATE_KEY').rsplit('/', 1)[0]}/last-snapshot.json", Body=body,
                      ContentType='application/json; charset=utf-8')


def push(body, token):
    """POST the snapshot; up to 3 tries (not after a 4xx other than 429). Returns (HTTP status or error name, the
    dashboard's message: its JSON `hata` on a rejected snapshot, else '')."""
    req = urllib.request.Request(env('INGEST_URL'), data=body, method='POST', headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': USER_AGENT})
    status, message = None, ''
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, ''
        except urllib.error.HTTPError as e:
            status, message = e.code, ''
            if 'json' in (e.headers.get('Content-Type') or ''):
                try:
                    message = str(json.loads(e.read(4096)).get('hata', ''))[:300]
                except ValueError:
                    pass
            if 400 <= e.code < 500 and e.code != 429:
                return status, message
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            status = type(e).__name__
        time.sleep(5 * (attempt + 1))
    return status, message


def handler(event, context):
    started = time.monotonic()
    now = dt.datetime.now(dt.timezone.utc)
    token, key_salt, mine = secrets()
    state = load_state()
    if state is None:   # the history since launch cannot be rebuilt from 30 days of logs: seed it from the local cache
        raise RuntimeError('no history in the state bucket: seed it with infra/stats-feed/deploy.py --seed')
    since = report.feed_since(state, now)
    files, downloaded = sync_logs(since)
    d = report.load(LOGS, since, env('LOG_PREFIX').strip('/'), key_salt=key_salt, mine=mine)
    payload, state = report.feed_snapshot(d, now, state)
    feed = state.setdefault('feed', {})
    fails = feed.get('fails', 0)
    if fails >= FAILS_STALE and feed.get('last_ok'):
        report.mark_stale(payload, f"Son {fails} saatlik gönderim başarısız oldu; bu anlık görüntü aradaki boşluğu kapatır.")
    body = report.dump_payload(payload).encode()
    if len(body) > MAX_BODY:
        raise RuntimeError(f'snapshot too large: {len(body)} bytes')
    status, message = 'skipped', ''
    try:
        if (event or {}).get('push', True):
            status, message = push(body, token)
            feed['fails'] = 0 if status == 200 else fails + 1
            feed['last_status'] = status
            if status == 200:
                feed['last_ok'] = now.isoformat(timespec='seconds')
        feed['last_run'] = now.isoformat(timespec='seconds')
    finally:
        save_state(state, body)   # the day records are valid whether or not the push went through
    card = {c['label']: c['value'] for c in payload['cards']}
    summary = {
        'status': status, 'message': message, 'stale': payload['stale'], 'fails_in_a_row': feed.get('fails', 0),
        'range': payload['range'], 'logs_from': since.isoformat(timespec='minutes'), 'log_files': files,
        'downloaded': downloaded, 'newest_log': d.last_at.isoformat(timespec='minutes') if d.last_at else None,
        'days_rewritten': sorted(k for k, r in state['days'].items() if r.get('at') == now.isoformat(timespec='seconds')),
        'visitors': card.get('Toplam ziyaretçi'), 'players': card.get('Toplam oyuncu'), 'flights': card.get('Toplam uçuş'),
        'hours': card.get('Toplam uçuş saati'), 'today': [card.get('Bugün ziyaretçi'), card.get('Bugün oyuncu'),
                                                            card.get('Bugün uçuş'), card.get('Bugün uçuş saati')],
        'bytes': len(body), 'seconds': round(time.monotonic() - started, 1),
    }
    print(json.dumps(summary, ensure_ascii=False))
    if status not in (200, 'skipped'):
        raise RuntimeError(f'push failed: {status}')
    return summary
