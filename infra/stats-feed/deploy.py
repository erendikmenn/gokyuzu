#!/usr/bin/env python3
"""Deploy the hourly Gökyüzü statistics feed (infra/stats-feed/README.md). Idempotent.

    .venv/bin/python infra/stats-feed/deploy.py                 # SSM parameters + stack + function code
    .venv/bin/python infra/stats-feed/deploy.py --code          # function code only (after changing report.py / handler.py)
    .venv/bin/python infra/stats-feed/deploy.py --seed STATE    # upload a per-day history (report.py --json - --state STATE);
                                                                #   refused if the feed already has one (add --replace)
    .venv/bin/python infra/stats-feed/deploy.py --invoke [--no-push]   # run once now, print the run summary
    .venv/bin/python infra/stats-feed/deploy.py --schedule DISABLED|ENABLED

Account, region and the log bucket come from the local deploy config ~/.config/gokyuzu/deploy.env (AWS_ACCOUNT_ID,
AWS_REGION, S3_BUCKET_LOGS; profile AWS_PROFILE_ADMIN). The shell's AWS_PROFILE is ignored on purpose (it may point at
another account) and the script stops unless the profile is in AWS_ACCOUNT_ID. Three SecureString parameters are
written from local files (never printed, never passed on a command line): the dashboard's ingest token
(~/.config/erenailab-stats/ingest_token), the analytics salt (~/.config/gokyuzu/analytics_salt) and the owner's IP list
(~/.config/gokyuzu/staging_ips), so the feed hashes and filters exactly like tools/analytics/report.py.
Every resource is tagged project=erenailab-stats; nothing of the game's own infrastructure is changed.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'deploy'))
import deploy_config  # noqa: E402

STACK = 'erenailab-stats-gokyuzu-feed'
INGEST_URL_FILE = Path.home() / '.config' / 'erenailab-stats' / 'ingest_url'   # the dashboard's endpoint; kept out of the repo


def ingest_url():
    try:
        url = INGEST_URL_FILE.read_text().strip()
    except FileNotFoundError:
        sys.exit(f'missing {INGEST_URL_FILE} (the dashboard ingest URL)')
    if not url.startswith('https://'):
        sys.exit(f'{INGEST_URL_FILE}: not an https URL')
    return url

FUNCTION = 'erenailab-stats-gokyuzu-feed'
TAGS = [{'Key': 'project', 'Value': 'erenailab-stats'}]
TZDATA = 'tzdata==2026.4'   # zoneinfo data for Europe/Istanbul (the Lambda image may not carry /usr/share/zoneinfo)
PARAMS = {   # SSM name -> local file (the template's defaults)
    '/erenailab-stats/ingest-token': Path.home() / '.config' / 'erenailab-stats' / 'ingest_token',
    '/erenailab-stats/gokyuzu/analytics-salt': Path.home() / '.config' / 'gokyuzu' / 'analytics_salt',
    '/erenailab-stats/gokyuzu/own-ips': Path.home() / '.config' / 'gokyuzu' / 'staging_ips',
}
PACKAGE = {   # path in the zip -> repo file (report.py imports tools/deploy/deploy_config.py)
    'handler.py': HERE / 'handler.py',
    'tools/analytics/report.py': ROOT / 'tools' / 'analytics' / 'report.py',
    'tools/deploy/deploy_config.py': ROOT / 'tools' / 'deploy' / 'deploy_config.py',
}


def session():
    s = boto3.Session(profile_name=deploy_config.profile('AWS_PROFILE_ADMIN'), region_name=deploy_config.get('AWS_REGION'))
    if s.client('sts').get_caller_identity()['Account'] != deploy_config.get('AWS_ACCOUNT_ID'):
        sys.exit('The admin profile is not in AWS_ACCOUNT_ID of the deploy config: nothing changed.')
    return s


def put_params(s):
    ssm = s.client('ssm')
    for name, path in PARAMS.items():
        if not path.is_file():
            sys.exit(f'{path} is missing: nothing changed for {name}.')
        value = path.read_text().strip() + ('\n' if name.endswith('own-ips') else '')
        try:
            same = ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value'] == value
        except ClientError as e:
            if e.response['Error']['Code'] != 'ParameterNotFound':
                raise
            same = False
        if not same:
            ssm.put_parameter(Name=name, Value=value, Type='SecureString', Overwrite=True, Tier='Standard',
                              Description='erenailab-stats Gokyuzu feed (infra/stats-feed)')
        ssm.add_tags_to_resource(ResourceType='Parameter', ResourceId=name, Tags=TAGS)
        print(f'  SSM {name}: {"unchanged" if same else "written"} (SecureString)')


def deploy_stack(s):
    cf = s.client('cloudformation')
    try:
        cf.describe_stacks(StackName=STACK)
        exists = True
    except ClientError:
        exists = False
    params = [{'ParameterKey': 'LogBucket', 'ParameterValue': deploy_config.get('S3_BUCKET_LOGS')}]
    params.append({'ParameterKey': 'IngestUrl', 'ParameterValue': ingest_url()})
    if exists:   # keep the schedule as it is (on / off: --schedule)
        params.append({'ParameterKey': 'ScheduleState', 'UsePreviousValue': True})
    args = dict(StackName=STACK, TemplateBody=(HERE / 'template.yaml').read_text(), Parameters=params,
                Capabilities=['CAPABILITY_NAMED_IAM'], Tags=TAGS)
    if exists:
        try:
            cf.update_stack(**args)
        except ClientError as e:
            if 'No updates are to be performed' in str(e):
                print('  stack: no changes')
                return
            raise
        waiter = cf.get_waiter('stack_update_complete')
    else:
        cf.create_stack(**args, EnableTerminationProtection=True, OnFailure='ROLLBACK')
        waiter = cf.get_waiter('stack_create_complete')
    print(f'  stack {STACK}: {"updating" if exists else "creating"} …')
    try:
        waiter.wait(StackName=STACK, WaiterConfig={'Delay': 10, 'MaxAttempts': 90})
    except Exception:
        events = cf.describe_stack_events(StackName=STACK)['StackEvents'][:15]
        for ev in events:
            if 'FAILED' in ev['ResourceStatus']:
                print(f"    {ev['LogicalResourceId']}: {ev['ResourceStatus']} {ev.get('ResourceStatusReason', '')[:200]}")
        sys.exit('stack deployment failed')
    print(f'  stack {STACK}: done')


def build_zip():
    """A reproducible zip: the handler, report.py, deploy_config.py and the tzdata package."""
    buf = io.BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet', '--no-deps', '--only-binary=:all:',
                        '--target', tmp, TZDATA], check=True)
        files = dict(PACKAGE)
        for p in sorted(Path(tmp).rglob('*')):
            rel = p.relative_to(tmp).as_posix()
            if p.is_file() and rel.startswith('tzdata/') and '__pycache__' not in rel:
                files[rel] = p
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in sorted(files):
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, files[name].read_bytes())
    return buf.getvalue()


def deploy_code(s):
    lam = s.client('lambda')
    data = build_zip()
    sha = base64.b64encode(hashlib.sha256(data).digest()).decode()
    if lam.get_function_configuration(FunctionName=FUNCTION)['CodeSha256'] == sha:
        print(f'  code: unchanged ({len(data) // 1024} KB)')
        return
    lam.update_function_code(FunctionName=FUNCTION, ZipFile=data)
    lam.get_waiter('function_updated_v2').wait(FunctionName=FUNCTION)
    print(f'  code: uploaded ({len(data) // 1024} KB)')


def stack_output(s, key):
    outs = s.client('cloudformation').describe_stacks(StackName=STACK)['Stacks'][0].get('Outputs', [])
    return next(o['OutputValue'] for o in outs if o['OutputKey'] == key)


def seed(s, path, replace):
    bucket, key = stack_output(s, 'StateBucket'), 'gokyuzu/state.json.gz'
    s3 = s.client('s3')
    try:
        s3.head_object(Bucket=bucket, Key=key)
        if not replace:
            sys.exit('The feed already has a history: nothing uploaded (add --replace to overwrite it).')
    except ClientError as e:
        if e.response['Error']['Code'] not in ('404', 'NoSuchKey'):
            raise
    data = Path(path).read_bytes()
    days = json.loads(gzip.decompress(data))['days']
    s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType='application/gzip')
    print(f'  history: {len(days)} days uploaded ({min(days)} → {max(days)}, final: {sum(1 for r in days.values() if r.get("final"))})')


def invoke(s, push):
    lam = s.client('lambda', config=boto3.session.Config(read_timeout=660, retries={'max_attempts': 0}))
    t = time.monotonic()
    res = lam.invoke(FunctionName=FUNCTION, Payload=json.dumps({} if push else {'push': False}).encode())
    body = res['Payload'].read().decode()
    print(f"  invoke ({time.monotonic() - t:.0f} s){' FAILED' if res.get('FunctionError') else ''}: {body[:1500]}")
    if res.get('FunctionError'):
        sys.exit(1)


def set_schedule(s, state):
    cf = s.client('cloudformation')
    cf.update_stack(StackName=STACK, UsePreviousTemplate=True, Capabilities=['CAPABILITY_NAMED_IAM'], Tags=TAGS,
                    Parameters=[{'ParameterKey': 'LogBucket', 'UsePreviousValue': True},
                                {'ParameterKey': 'IngestUrl', 'UsePreviousValue': True},
                                {'ParameterKey': 'ScheduleState', 'ParameterValue': state}])
    cf.get_waiter('stack_update_complete').wait(StackName=STACK, WaiterConfig={'Delay': 10, 'MaxAttempts': 60})
    print(f'  schedule: {state}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--code', action='store_true', help='upload the function code only')
    ap.add_argument('--seed', metavar='STATE', help='upload this per-day history (.json.gz) as the feed\'s history')
    ap.add_argument('--replace', action='store_true', help='--seed: overwrite an existing history')
    ap.add_argument('--invoke', action='store_true', help='run the feed once now')
    ap.add_argument('--no-push', action='store_true', help='--invoke: build and save, do not push')
    ap.add_argument('--schedule', choices=['ENABLED', 'DISABLED'], help='turn the hourly schedule on or off')
    a = ap.parse_args()
    s = session()
    if a.schedule:
        set_schedule(s, a.schedule)
    elif a.seed or a.invoke:
        if a.seed:
            seed(s, a.seed, a.replace)
        if a.invoke:
            invoke(s, not a.no_push)
    elif a.code:
        deploy_code(s)
    else:
        put_params(s)
        deploy_stack(s)
        deploy_code(s)


if __name__ == '__main__':
    main()
