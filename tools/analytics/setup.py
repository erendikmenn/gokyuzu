#!/usr/bin/env python3
"""Idempotent AWS setup for anonymous usage statistics (run once per target with the admin profile).

    .venv/bin/python tools/analytics/setup.py staging      # then production
    Uses the admin profile "gokyuzu-admin" (distribution changes need more than the deploy user may do); override with
    AWS_PROFILE_ADMIN. The shell's AWS_PROFILE is deliberately ignored: it may point at another account.

For the target's CloudFront distribution it
  * turns on standard access logs → s3://gokyuzu-sf-logs-…/<target>/ (the bucket deletes them after 30 days),
  * adds the /_e behaviour: the CloudFront Function gokyuzu-beacon answers the game's beacons with 204 at the edge,
    uncached, so every beacon (its query string = the event) becomes one access-log line.
Nothing else in the distribution changes. Reports: tools/analytics/report.py.
"""
import os
import sys

import boto3

LOG_BUCKET = 'gokyuzu-sf-logs-<aws-account-id>-eu-central-1'
DISTRIBUTIONS = {'production': '<cf-dist-production>', 'staging': '<cf-dist-staging>'}
BEACON_FN = 'arn:aws:cloudfront::<aws-account-id>:function/gokyuzu-beacon'
CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'   # AWS managed cache policy


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else ''
    if target not in DISTRIBUTIONS:
        sys.exit(f'usage: setup.py {"|".join(DISTRIBUTIONS)}')
    cf = boto3.Session(profile_name=os.environ.get('AWS_PROFILE_ADMIN', 'gokyuzu-admin')).client('cloudfront')
    dist_id = DISTRIBUTIONS[target]
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
