#!/usr/bin/env python3
"""Roll a published site back to how it was at a given moment, using S3 object versioning.

    .venv/bin/python tools/deploy/rollback.py production --to 2026-09-23T14:05          # dry run: shows what would change
    .venv/bin/python tools/deploy/rollback.py production --to 2026-09-23T14:05 --apply  # does it + invalidates CloudFront
    .venv/bin/python tools/deploy/rollback.py staging --list                            # recent deploy times (for --to)

Times are local (Europe/Istanbul) unless they end with Z. Uses the least-privilege profile AWS_PROFILE_DEPLOY (default
"gokyuzu-deploy"). Buckets, distribution ids and site URLs come from the local deploy config ~/.config/gokyuzu/deploy.env
(template: tools/deploy/deploy.env.example).
For every key: the newest version that existed at --to becomes current again (a copy of that version);
keys that did not exist then are deleted (a delete marker, itself reversible). Old versions expire after 30 days.
"""
import argparse
import datetime as dt
import os
import sys
import time
from collections import defaultdict

import boto3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deploy_config  # noqa: E402

TARGETS = ('production', 'staging')


def target_config(target):
    """(bucket, CloudFront distribution id, site URL) of a target, from the deploy config."""
    t = target.upper()
    return deploy_config.get(f'S3_BUCKET_{t}'), deploy_config.get(f'CF_DIST_{t}'), deploy_config.get(f'SITE_{t}')


def parse_time(s):
    if s.endswith('Z'):
        return dt.datetime.fromisoformat(s[:-1]).replace(tzinfo=dt.timezone.utc)
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.astimezone()   # local time zone of this Mac


def all_versions(s3, bucket):
    by_key = defaultdict(list)
    for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket):
        for v in page.get('Versions', []):
            by_key[v['Key']].append({'id': v['VersionId'], 'at': v['LastModified'], 'latest': v['IsLatest'], 'marker': False})
        for m in page.get('DeleteMarkers', []):
            by_key[m['Key']].append({'id': m['VersionId'], 'at': m['LastModified'], 'latest': m['IsLatest'], 'marker': True})
    return by_key


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', choices=TARGETS)
    ap.add_argument('--to', help='roll back to this moment, e.g. 2026-09-23T14:05')
    ap.add_argument('--apply', action='store_true', help='actually change the bucket (default: dry run)')
    ap.add_argument('--list', action='store_true', help='show recent deploy moments')
    a = ap.parse_args()
    bucket, dist_id, url = target_config(a.target)
    session = boto3.Session(profile_name=deploy_config.profile('AWS_PROFILE_DEPLOY'))
    s3, cf = session.client('s3'), session.client('cloudfront')
    versions = all_versions(s3, bucket)

    if a.list:
        minutes = defaultdict(int)
        for vs in versions.values():
            for v in vs:
                minutes[v['at'].astimezone().strftime('%Y-%m-%dT%H:%M')] += 1
        print(f'{a.target}: changes per minute (most recent first) — pick a moment just after a good deploy')
        for m in sorted(minutes, reverse=True)[:20]:
            print(f'  {m}   {minutes[m]} files')
        return

    if not a.to:
        ap.error('--to is required (or use --list)')
    when = parse_time(a.to)
    restore, delete = [], []
    for key, vs in versions.items():
        vs.sort(key=lambda v: v['at'])
        current = next((v for v in vs if v['latest']), None)
        then = [v for v in vs if v['at'] <= when]
        target = then[-1] if then else None
        if target is None or target['marker']:
            if current and not current['marker']:
                delete.append(key)
        elif not current or current['id'] != target['id']:
            restore.append((key, target['id']))
    print(f'{a.target} → state at {when.isoformat()}: {len(restore)} files restored, {len(delete)} files removed, '
          f'{len(versions) - len(restore) - len(delete)} unchanged')
    for key, _ in restore[:10]:
        print('  restore', key)
    for key in delete[:10]:
        print('  remove ', key)
    if not a.apply:
        print('Dry run only. Add --apply to roll back.')
        return
    for i, (key, vid) in enumerate(restore, 1):
        s3.copy_object(Bucket=bucket, Key=key, CopySource={'Bucket': bucket, 'Key': key, 'VersionId': vid}, MetadataDirective='COPY')
        if i % 200 == 0:
            print(f'  {i}/{len(restore)}')
    for key in delete:
        s3.delete_object(Bucket=bucket, Key=key)
    cf.create_invalidation(DistributionId=dist_id, InvalidationBatch={
        'Paths': {'Quantity': 1, 'Items': ['/*']}, 'CallerReference': f'rollback-{int(time.time())}'})
    print(f'Rolled back {url} to {when.isoformat()} (CloudFront refresh 1–2 min).')


if __name__ == '__main__':
    sys.exit(main())
