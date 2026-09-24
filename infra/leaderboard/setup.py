#!/usr/bin/env python3
"""Leaderboard service for Gökyüzü SF (CONTRACTS-SF.md §12): idempotent AWS setup, one stack per target.

    .venv/bin/python infra/leaderboard/setup.py staging [--wait]      # create/update the stack, connect staging
    .venv/bin/python infra/leaderboard/setup.py staging --code        # ship new Lambda code only (deploy user)
    .venv/bin/python infra/leaderboard/setup.py production            # prints the plan, changes nothing
    .venv/bin/python infra/leaderboard/setup.py production --owner-approved [--wait]   # ONLY after the owner said yes

Design: CloudFront behaviour /api/* on the game's own distribution → Lambda function URL (auth AWS_IAM, reachable only
through CloudFront origin access control: a direct call is refused by Lambda before the function runs) → DynamoDB
on-demand. GET /api/top is cached 30 s at the edge (cache key: mission, day, n); POST /api/score never. No CORS, no
third-party calls, no IP addresses stored (see infra/leaderboard/lambda/app.mjs).

Per target <t> it creates / updates (all tagged project=gokyuzu-sf, stage=<t>):
  DynamoDB table gokyuzu-sf-leaderboard-<t> (pk/sk, local index `rank`, TTL `exp`; production: deletion protection + PITR)
  IAM role gokyuzu-sf-leaderboard-<t> (only this table and its log group)
  log group /aws/lambda/gokyuzu-sf-leaderboard-<t> (14 days; the function logs errors only)
  Lambda gokyuzu-sf-leaderboard-<t> (Node.js, arm64, 256 MB, 5 s, reserved concurrency 10 when the account
    allows it) + function URL (AWS_IAM)
  Lambda permissions for this target's distribution only
and, shared by both targets (CloudFront policies and OACs cannot carry tags):
  origin access control gokyuzu-sf-leaderboard (lambda, sigv4 always), cache policy + origin request policy gokyuzu-sf-api
then adds to the target's distribution: origin `leaderboard-<t>` and behaviour /api/* (staging keeps its IP allow-list
function on it). Nothing else in the distribution changes.
The deploy user gokyuzu-deployer gets one inline policy: update the code of gokyuzu-sf-leaderboard-* (for --code).

Profiles are passed explicitly: admin "gokyuzu-admin" (override AWS_PROFILE_ADMIN), deploy "gokyuzu-deploy"
(AWS_PROFILE_DEPLOY). The shell's AWS_PROFILE is ignored on purpose: it points at another account. The script also
refuses to run against any account other than <aws-account-id>. The salt (hash secret) is generated once, lives only in
the function's environment and is never printed.
"""
import argparse
import hashlib
import base64
import io
import json
import os
import secrets
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError, ParamValidationError

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT = '<aws-account-id>'
REGION = 'eu-central-1'
DISTRIBUTIONS = {'staging': '<cf-dist-staging>', 'production': '<cf-dist-production>'}
SITES = {'staging': 'https://staging.fs.erenailab.com', 'production': 'https://fs.erenailab.com'}
TAGS = {'project': 'gokyuzu-sf'}
OAC_NAME = 'gokyuzu-sf-leaderboard'
POLICY_NAME = 'gokyuzu-sf-api'
DEPLOYER = 'gokyuzu-deployer'
RUNTIMES = ['nodejs24.x', 'nodejs22.x']
HANDLER = 'infra/leaderboard/lambda/index.handler'
LAMBDA_FILES = ['app.mjs', 'dynamo.mjs', 'index.mjs', 'net.mjs', 'validate.mjs', 'rules.json']
# (x-amz-content-sha256, the body hash the page sends for POST, may not be listed: origin access control signs with it)
FORWARDED_HEADERS = ['CloudFront-Viewer-Address', 'CF-Connecting-IP', 'Content-Type', 'Origin', 'Sec-Fetch-Site']
RESERVED_CONCURRENCY = 10
LOG_DAYS = 14


def names(target):
    base = f'gokyuzu-sf-leaderboard-{target}'
    return {'table': base, 'role': base, 'function': base, 'log': f'/aws/lambda/{base}', 'origin': f'leaderboard-{target}'}


def session(profile):
    s = boto3.Session(profile_name=profile, region_name=REGION)
    acct = s.client('sts').get_caller_identity()['Account']
    if acct != ACCOUNT:
        sys.exit(f'profile "{profile}" is account {acct}, not {ACCOUNT}: stopping')
    return s


def package():
    """Deterministic zip (fixed timestamps): the repo layout is kept so src/net/names.js resolves as in development."""
    rules = ROOT / 'infra/leaderboard/build_rules.mjs'
    if rules.exists():
        subprocess.run(['node', str(rules)], cwd=ROOT, check=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        def add(arc, data):
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
        add('package.json', json.dumps({'type': 'module', 'private': True}))
        for f in LAMBDA_FILES:
            add(f'infra/leaderboard/lambda/{f}', (ROOT / 'infra/leaderboard/lambda' / f).read_bytes())
        add('src/net/names.js', (ROOT / 'src/net/names.js').read_bytes())
    data = buf.getvalue()
    return data, base64.b64encode(hashlib.sha256(data).digest()).decode()


def tag_list(target):
    return {**TAGS, 'stage': target}


# ---------------------------------------------------------------------------------------------------------- stack
def ensure_table(s, target, n):
    ddb = s.client('dynamodb')
    try:
        desc = ddb.describe_table(TableName=n['table'])['Table']
        print(f"  table {n['table']}: exists")
    except ddb.exceptions.ResourceNotFoundException:
        ddb.create_table(
            TableName=n['table'], BillingMode='PAY_PER_REQUEST',
            AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in ('pk', 'sk', 'rk')],
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            LocalSecondaryIndexes=[{'IndexName': 'rank', 'Projection': {'ProjectionType': 'ALL'},
                                    'KeySchema': [{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'rk', 'KeyType': 'RANGE'}]}],
            Tags=[{'Key': k, 'Value': v} for k, v in tag_list(target).items()],
            DeletionProtectionEnabled=target == 'production',
        )
        ddb.get_waiter('table_exists').wait(TableName=n['table'])
        desc = ddb.describe_table(TableName=n['table'])['Table']
        print(f"  table {n['table']}: created (on-demand)")
    ttl = ddb.describe_time_to_live(TableName=n['table'])['TimeToLiveDescription']
    if ttl.get('TimeToLiveStatus') not in ('ENABLED', 'ENABLING'):
        ddb.update_time_to_live(TableName=n['table'], TimeToLiveSpecification={'Enabled': True, 'AttributeName': 'exp'})
        print('  table TTL on `exp`: enabled')
    if target == 'production':
        ddb.update_continuous_backups(TableName=n['table'], PointInTimeRecoverySpecification={'PointInTimeRecoveryEnabled': True})
    return desc['TableArn']


def ensure_logs(s, target, n):
    logs = s.client('logs')
    try:
        logs.create_log_group(logGroupName=n['log'], tags=tag_list(target))
        print(f"  log group {n['log']}: created")
    except logs.exceptions.ResourceAlreadyExistsException:
        pass
    logs.put_retention_policy(logGroupName=n['log'], retentionInDays=LOG_DAYS)
    return f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:{n['log']}"


def ensure_role(s, target, n, table_arn, log_arn):
    iam = s.client('iam')
    created = False
    try:
        arn = iam.get_role(RoleName=n['role'])['Role']['Arn']
    except iam.exceptions.NoSuchEntityException:
        trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]}
        arn = iam.create_role(RoleName=n['role'], AssumeRolePolicyDocument=json.dumps(trust),
                              Description=f'Gokyuzu SF leaderboard Lambda ({target})',
                              Tags=[{'Key': k, 'Value': v} for k, v in tag_list(target).items()])['Role']['Arn']
        created = True
        print(f"  role {n['role']}: created")
    policy = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
         'Resource': [table_arn, f'{table_arn}/index/rank']},
        {'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'], 'Resource': f'{log_arn}:*'},
    ]}
    iam.put_role_policy(RoleName=n['role'], PolicyName='leaderboard', PolicyDocument=json.dumps(policy))
    if created:
        time.sleep(12)   # a new role takes a few seconds before Lambda can assume it
    return arn


def ensure_function(s, target, n, role_arn, origins, code, code_sha):
    lam = s.client('lambda')
    try:
        current = lam.get_function_configuration(FunctionName=n['function'])
    except lam.exceptions.ResourceNotFoundException:
        current = None
    salt = ((current or {}).get('Environment') or {}).get('Variables', {}).get('SALT') or secrets.token_urlsafe(48)
    cfg = dict(
        Role=role_arn, Handler=HANDLER, MemorySize=256, Timeout=5,
        Description=f'Gokyuzu SF leaderboard /api/* ({target}); managed by infra/leaderboard/setup.py',
        Environment={'Variables': {'TABLE': n['table'], 'SALT': salt, 'STAGE': target, 'ORIGINS': ','.join(origins)}},
        LoggingConfig={'LogFormat': 'JSON', 'ApplicationLogLevel': 'ERROR', 'SystemLogLevel': 'WARN', 'LogGroup': n['log']},
    )
    if current is None:
        runtimes, tries = list(RUNTIMES), 0
        while True:
            try:
                lam.create_function(FunctionName=n['function'], Runtime=runtimes[0], Architectures=['arm64'], Code={'ZipFile': code},
                                    Publish=False, Tags=tag_list(target), **cfg)
                print(f"  function {n['function']}: created ({runtimes[0]}, arm64)")
                break
            except ClientError as e:
                msg, tries = str(e), tries + 1
                if 'runtime' in msg.lower() and len(runtimes) > 1 and 'role' not in msg.lower():
                    runtimes.pop(0)                # this region does not offer it (yet): the next one
                elif 'role' in msg.lower() and tries < 8:
                    time.sleep(5)                  # a new role needs a few seconds before Lambda can assume it
                else:
                    raise
        lam.get_waiter('function_active_v2').wait(FunctionName=n['function'])
    else:
        if current.get('CodeSha256') != code_sha:
            lam.update_function_code(FunctionName=n['function'], ZipFile=code)
            lam.get_waiter('function_updated_v2').wait(FunctionName=n['function'])
            print(f"  function {n['function']}: code updated")
        lam.update_function_configuration(FunctionName=n['function'], **cfg)
        lam.get_waiter('function_updated_v2').wait(FunctionName=n['function'])
        print(f"  function {n['function']}: configuration up to date ({current.get('Runtime')})")
    try:
        lam.put_function_concurrency(FunctionName=n['function'], ReservedConcurrentExecutions=RESERVED_CONCURRENCY)
    except ClientError as e:
        print(f'  NOTE: reserved concurrency not set ({e.response["Error"]["Code"]}); the account limit is low', file=sys.stderr)

    try:
        url = lam.get_function_url_config(FunctionName=n['function'])
        if url['AuthType'] != 'AWS_IAM':
            url = lam.update_function_url_config(FunctionName=n['function'], AuthType='AWS_IAM')
    except lam.exceptions.ResourceNotFoundException:
        url = lam.create_function_url_config(FunctionName=n['function'], AuthType='AWS_IAM', InvokeMode='BUFFERED')
        print('  function URL: created (AWS_IAM: only CloudFront can call it)')
    return url['FunctionUrl']


def ensure_permissions(s, n, dist_id):
    lam = s.client('lambda')
    source = f'arn:aws:cloudfront::{ACCOUNT}:distribution/{dist_id}'
    try:
        have = {st['Sid'] for st in json.loads(lam.get_policy(FunctionName=n['function'])['Policy'])['Statement']}
    except lam.exceptions.ResourceNotFoundException:
        have = set()
    sid = f'cloudfront-{dist_id}-url'
    if sid not in have:
        lam.add_permission(FunctionName=n['function'], StatementId=sid, Action='lambda:InvokeFunctionUrl',
                           Principal='cloudfront.amazonaws.com', SourceArn=source, FunctionUrlAuthType='AWS_IAM')
        print(f'  permission: CloudFront {dist_id} may invoke the URL')
    sid = f'cloudfront-{dist_id}-invoke'
    if sid not in have:   # function URLs created since Oct 2025 also need lambda:InvokeFunction (via the URL only)
        try:
            lam.add_permission(FunctionName=n['function'], StatementId=sid, Action='lambda:InvokeFunction',
                               Principal='cloudfront.amazonaws.com', SourceArn=source, InvokedViaFunctionUrl=True)
            print(f'  permission: CloudFront {dist_id} may invoke through the URL')
        except (ParamValidationError, ClientError) as e:
            print(f'  NOTE: InvokeFunction permission not added ({type(e).__name__})', file=sys.stderr)


# ----------------------------------------------------------------------------------------------------- CloudFront
def ensure_oac(cf):
    for page in [cf.list_origin_access_controls()]:
        for it in page.get('OriginAccessControlList', {}).get('Items', []) or []:
            if it['Name'] == OAC_NAME:
                return it['Id']
    return cf.create_origin_access_control(OriginAccessControlConfig={
        'Name': OAC_NAME, 'Description': 'Gokyuzu SF leaderboard: CloudFront signs requests to the Lambda function URL',
        'SigningProtocol': 'sigv4', 'SigningBehavior': 'always', 'OriginAccessControlOriginType': 'lambda'})['OriginAccessControl']['Id']


def ensure_cache_policy(cf):
    cfg = {
        'Name': POLICY_NAME, 'Comment': 'Gokyuzu SF /api/*: origin Cache-Control decides (top 30 s, POST never); key = mission, day, n',
        'MinTTL': 0, 'DefaultTTL': 0, 'MaxTTL': 60,
        'ParametersInCacheKeyAndForwardedToOrigin': {
            'EnableAcceptEncodingGzip': True, 'EnableAcceptEncodingBrotli': True,
            'HeadersConfig': {'HeaderBehavior': 'none'}, 'CookiesConfig': {'CookieBehavior': 'none'},
            'QueryStringsConfig': {'QueryStringBehavior': 'whitelist', 'QueryStrings': {'Quantity': 3, 'Items': ['mission', 'day', 'n']}},
        },
    }
    for it in cf.list_cache_policies(Type='custom').get('CachePolicyList', {}).get('Items', []) or []:
        if it['CachePolicy']['CachePolicyConfig']['Name'] == POLICY_NAME:
            pid = it['CachePolicy']['Id']
            etag = cf.get_cache_policy(Id=pid)['ETag']
            cf.update_cache_policy(Id=pid, IfMatch=etag, CachePolicyConfig=cfg)
            return pid
    return cf.create_cache_policy(CachePolicyConfig=cfg)['CachePolicy']['Id']


def ensure_origin_request_policy(cf):
    cfg = {
        'Name': POLICY_NAME, 'Comment': 'Gokyuzu SF /api/*: viewer address (rate limit), content type/hash, origin checks',
        'HeadersConfig': {'HeaderBehavior': 'whitelist', 'Headers': {'Quantity': len(FORWARDED_HEADERS), 'Items': FORWARDED_HEADERS}},
        'CookiesConfig': {'CookieBehavior': 'none'}, 'QueryStringsConfig': {'QueryStringBehavior': 'none'},
    }
    for it in cf.list_origin_request_policies(Type='custom').get('OriginRequestPolicyList', {}).get('Items', []) or []:
        if it['OriginRequestPolicy']['OriginRequestPolicyConfig']['Name'] == POLICY_NAME:
            pid = it['OriginRequestPolicy']['Id']
            etag = cf.get_origin_request_policy(Id=pid)['ETag']
            cf.update_origin_request_policy(Id=pid, IfMatch=etag, OriginRequestPolicyConfig=cfg)
            return pid
    return cf.create_origin_request_policy(OriginRequestPolicyConfig=cfg)['OriginRequestPolicy']['Id']


def connect_distribution(cf, target, n, dist_id, url, oac_id, cache_id, orp_id):
    res = cf.get_distribution_config(Id=dist_id)
    cfg, etag = res['DistributionConfig'], res['ETag']
    host = url.split('://', 1)[1].rstrip('/')
    origin = {
        'Id': n['origin'], 'DomainName': host, 'OriginPath': '', 'CustomHeaders': {'Quantity': 0},
        'CustomOriginConfig': {'HTTPPort': 80, 'HTTPSPort': 443, 'OriginProtocolPolicy': 'https-only',
                               'OriginSslProtocols': {'Quantity': 1, 'Items': ['TLSv1.2']},
                               'OriginReadTimeout': 10, 'OriginKeepaliveTimeout': 5},
        'ConnectionAttempts': 2, 'ConnectionTimeout': 2, 'OriginShield': {'Enabled': False}, 'OriginAccessControlId': oac_id,
    }

    # staging: the same viewer-request function as the rest of the site (tools/deploy/staging_access.sh IP allow-list)
    default_fns = cfg['DefaultCacheBehavior'].get('FunctionAssociations', {'Quantity': 0})
    fns = [f for f in default_fns.get('Items', []) or [] if f['EventType'] == 'viewer-request'] if target == 'staging' else []
    api = {
        'PathPattern': '/api/*', 'TargetOriginId': n['origin'], 'ViewerProtocolPolicy': 'https-only',
        'AllowedMethods': {'Quantity': 7, 'Items': ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                           'CachedMethods': {'Quantity': 2, 'Items': ['GET', 'HEAD']}},
        'CachePolicyId': cache_id, 'OriginRequestPolicyId': orp_id, 'Compress': True, 'SmoothStreaming': False,
        'FieldLevelEncryptionId': '', 'LambdaFunctionAssociations': {'Quantity': 0},
        'FunctionAssociations': {'Quantity': len(fns), 'Items': fns} if fns else {'Quantity': 0},
    }
    old_b = next((b for b in cfg.get('CacheBehaviors', {}).get('Items', []) or [] if b['PathPattern'] == '/api/*'), None)
    old_o = next((o for o in cfg['Origins']['Items'] if o['Id'] == n['origin']), None)
    same = old_b and old_o and old_o['DomainName'] == host and old_o.get('OriginAccessControlId') == oac_id and all(
        old_b.get(k) == api[k] for k in ('TargetOriginId', 'ViewerProtocolPolicy', 'CachePolicyId', 'OriginRequestPolicyId', 'Compress')) \
        and set(old_b['AllowedMethods']['Items']) == set(api['AllowedMethods']['Items']) \
        and [f['FunctionARN'] for f in old_b.get('FunctionAssociations', {}).get('Items', []) or []] == [f['FunctionARN'] for f in fns]
    if same:
        print(f'  distribution {dist_id}: /api/* already connected')
        return cfg
    behaviors = [api] + [b for b in cfg.get('CacheBehaviors', {}).get('Items', []) or [] if b['PathPattern'] != '/api/*']
    cfg['CacheBehaviors'] = {'Quantity': len(behaviors), 'Items': behaviors}
    origins = [o for o in cfg['Origins']['Items'] if o['Id'] != n['origin']] + [origin]
    cfg['Origins'] = {'Quantity': len(origins), 'Items': origins}

    # (no error-page change: CloudFront never caches a 429, and the API's 4xx answers carry their own Cache-Control)
    cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=cfg)
    print(f'  distribution {dist_id}: origin {n["origin"]} + behaviour /api/*' + (' (IP allow-list kept)' if fns else ''))
    return cfg


def grant_deployer(s):
    iam = s.client('iam')
    policy = {'Version': '2012-10-17', 'Statement': [{
        'Sid': 'LeaderboardCodeDeploys', 'Effect': 'Allow',
        'Action': ['lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionCode'],
        'Resource': f'arn:aws:lambda:{REGION}:{ACCOUNT}:function:gokyuzu-sf-leaderboard-*'}]}
    iam.put_user_policy(UserName=DEPLOYER, PolicyName='gokyuzu-leaderboard-code', PolicyDocument=json.dumps(policy))
    print(f'  {DEPLOYER}: may update the leaderboard functions\' code (nothing else new)')


def plan(target):
    n = names(target)
    print(f"""Plan for {target} (nothing has been changed):
  DynamoDB   {n['table']}  on-demand, TTL exp, index rank{', deletion protection + PITR' if target == 'production' else ''}
  IAM role   {n['role']}  (GetItem/PutItem/UpdateItem/Query on that table; its log group)
  Logs       {n['log']}  ({LOG_DAYS} days, errors only)
  Lambda     {n['function']}  Node.js arm64 256 MB, reserved concurrency {RESERVED_CONCURRENCY}, URL auth AWS_IAM
  CloudFront {DISTRIBUTIONS[target]}: origin {n['origin']} (OAC {OAC_NAME}), behaviour /api/* (policies {POLICY_NAME}),
             {'IP allow-list function kept on /api/*' if target == 'staging' else 'no viewer function on /api/*; nothing else changes'}
Run with --owner-approved to apply.""")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', choices=list(DISTRIBUTIONS))
    ap.add_argument('--code', action='store_true', help='only upload new Lambda code (deploy user)')
    ap.add_argument('--owner-approved', action='store_true', help='required for production')
    ap.add_argument('--wait', action='store_true', help='wait until CloudFront has deployed the change')
    a = ap.parse_args()
    n = names(a.target)
    if a.target == 'production' and not a.owner_approved:
        plan(a.target)
        return

    code, sha = package()
    if a.code:
        s = session(os.environ.get('AWS_PROFILE_DEPLOY', 'gokyuzu-deploy'))
        lam = s.client('lambda')
        if lam.get_function_configuration(FunctionName=n['function']).get('CodeSha256') == sha:
            print(f"{n['function']}: code unchanged")
            return
        lam.update_function_code(FunctionName=n['function'], ZipFile=code)
        lam.get_waiter('function_updated_v2').wait(FunctionName=n['function'])
        print(f"{n['function']}: code updated ({len(code)} bytes)")
        return

    s = session(os.environ.get('AWS_PROFILE_ADMIN', 'gokyuzu-admin'))
    cf = s.client('cloudfront')
    dist_id = DISTRIBUTIONS[a.target]
    domain = cf.get_distribution(Id=dist_id)['Distribution']['DomainName']
    origins = [SITES[a.target], f'https://{domain}']
    print(f'{a.target}: leaderboard stack')
    table_arn = ensure_table(s, a.target, n)
    log_arn = ensure_logs(s, a.target, n)
    role_arn = ensure_role(s, a.target, n, table_arn, log_arn)
    url = ensure_function(s, a.target, n, role_arn, origins, code, sha)
    ensure_permissions(s, n, dist_id)
    oac_id, cache_id, orp_id = ensure_oac(cf), ensure_cache_policy(cf), ensure_origin_request_policy(cf)
    connect_distribution(cf, a.target, n, dist_id, url, oac_id, cache_id, orp_id)
    grant_deployer(s)
    print(f'  function URL (refuses direct calls): {url}')
    if a.wait:
        print('  waiting for CloudFront to deploy …')
        cf.get_waiter('distribution_deployed').wait(Id=dist_id, WaiterConfig={'Delay': 20, 'MaxAttempts': 60})
    print(f'done: {SITES[a.target]}/api/top?mission=…  (check: node infra/leaderboard/verify.mjs {a.target})')


if __name__ == '__main__':
    main()
