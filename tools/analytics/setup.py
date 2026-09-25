#!/usr/bin/env python3
"""Idempotent AWS setup for anonymous usage statistics (run once per target with the admin profile).

    .venv/bin/python tools/analytics/setup.py staging      # then production
    Uses the admin profile AWS_PROFILE_ADMIN (distribution changes need more than the deploy user may do). The shell's
    AWS_PROFILE is deliberately ignored: it may point at another account. Account, distribution ids and the log bucket
    come from the local deploy config ~/.config/gokyuzu/deploy.env (template: tools/deploy/deploy.env.example).

For the target's CloudFront distribution it
  * turns on standard access logs → s3://<S3_BUCKET_LOGS>/<target>/ (the bucket deletes them after 30 days),
  * adds the /_e behaviour: the CloudFront Function gokyuzu-beacon answers the game's beacons with 204 at the edge,
    uncached, so every beacon (its query string = the event) becomes one access-log line.
Nothing else in the distribution changes. Reports: tools/analytics/report.py.
"""
import sys
from pathlib import Path

import boto3

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
import deploy_config  # noqa: E402

TARGETS = ('production', 'staging')
BEACON_FN_NAME = 'gokyuzu-beacon'
CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'   # AWS managed cache policy


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else ''
    if target not in TARGETS:
        sys.exit(f'usage: setup.py {"|".join(TARGETS)}')
    LOG_BUCKET = deploy_config.get('S3_BUCKET_LOGS')
    BEACON_FN = f'arn:aws:cloudfront::{deploy_config.get("AWS_ACCOUNT_ID")}:function/{BEACON_FN_NAME}'
    dist_id = deploy_config.get(f'CF_DIST_{target.upper()}')
    cf = boto3.Session(profile_name=deploy_config.profile('AWS_PROFILE_ADMIN')).client('cloudfront')
    res = cf.get_distribution_config(Id=dist_id)
    cfg, etag = res['DistributionConfig'], res['ETag']

    cfg['Logging'] = {'Enabled': True, 'IncludeCookies': False, 'Bucket': f'{LOG_BUCKET}.s3.amazonaws.com', 'Prefix': f'{target}/'}

    origin = cfg['DefaultCacheBehavior']['TargetOriginId']
    beacon = {
        'PathPattern': '/_e', 'TargetOriginId': origin, 'ViewerProtocolPolicy': 'redirect-to-https',
        'AllowedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD'], 'CachedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD']}},
        'CachePolicyId': CACHING_DISABLED, 'Compress': False, 'SmoothStreaming': False, 'FieldLevelEncryptionId': '',
        'LambdaFunctionAssociations': {'Quantity': 0},
        'FunctionAssociations': {'Quantity': 1, 'Items': [{'FunctionARN': BEACON_FN, 'EventType': 'viewer-request'}]},
    }
    behaviors = [b for b in cfg.get('CacheBehaviors', {}).get('Items', []) if b['PathPattern'] != '/_e'] + [beacon]
    cfg['CacheBehaviors'] = {'Quantity': len(behaviors), 'Items': behaviors}

    cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=cfg)
    print(f'{target} ({dist_id}): access logs → s3://{LOG_BUCKET}/{target}/, /_e beacon behaviour set; deploying (a few minutes)')


if __name__ == '__main__':
    main()
