#!/usr/bin/env python3
"""Security response headers for the game's CloudFront distributions (docs/security/infra-audit-2026-09.md, H-1 / H-2).

    .venv/bin/python infra/security/headers_policy.py staging                        # dry run: prints the plan, changes nothing
    .venv/bin/python infra/security/headers_policy.py staging --apply                # CSP report-only (the default mode)
    .venv/bin/python infra/security/headers_policy.py staging --mode enforce --apply # CSP enforced
    .venv/bin/python infra/security/headers_policy.py staging --detach --apply       # revert: behaviours without the policy
    .venv/bin/python infra/security/headers_policy.py production --mode enforce --apply --owner-approved   # ONLY after the owner said yes

One custom CloudFront response headers policy per target (gokyuzu-sf-headers-<target>), so a staging experiment never
changes production. It is attached to every cache behaviour of that target's distribution (default, /api/*, /_e);
nothing else in the distribution changes. Before any change the full distribution config is saved to
~/.config/gokyuzu/backups/ (chmod 600, outside the repo: it holds ids); `--detach` is the revert.

Why at CloudFront and not only in Cloudflare: the production distribution also answers requests that do not come
through the Cloudflare proxy (its *.cloudfront.net host, or the site's host name pinned to a CloudFront edge address),
and those responses carried no security headers at all. Headers set here travel with every response; Cloudflare's
response-header transform rule may keep setting the same values (it overwrites, it does not add a second header).

CSP notes (the game as of 2026-09): ES module chunks from /js/, Draco / Basis / meshopt decoders run in workers
created from blob: URLs and compile WebAssembly ('wasm-unsafe-eval'). 'unsafe-eval' is needed too: three.js's KTX2
(Basis Universal) transcoder is Emscripten embind code that builds its bindings with `new Function` (craftInvokerFunction);
without it every KTX2 texture fails and the game never becomes playable (tested in Chromium, WebKit and Firefox on
staging, 2026-09-27). A blob: worker inherits the page's policy, so this cannot be scoped to the worker; drop it once
the transcoder is built without dynamic code (Emscripten -sDYNAMIC_EXECUTION=0) or loaded from a URL with its own
policy. There is still no 'unsafe-inline' for scripts, so injected markup cannot run code. glTF textures and embedded buffers are
blob:/data: URLs read with fetch() and <img>; the page has one inline <style> block and the UI sets inline styles;
telemetry (/_e) and the leaderboard (/api/) are same-origin fetches. Nothing is loaded from another origin.
The device-orientation sensors (tilt steering), fullscreen, gamepads and Web Share are NOT restricted by the
Permissions-Policy below.

Profiles: admin AWS_PROFILE_ADMIN (distribution changes are beyond the deploy user). The shell's AWS_PROFILE is
ignored on purpose (it may point at another account). No id is ever printed.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools' / 'deploy'))
import deploy_config  # noqa: E402

TARGETS = ('staging', 'production')
BACKUPS = Path.home() / '.config' / 'gokyuzu' / 'backups'

# galeri.html (written by tools/make_gallery.mjs) has one fixed inline <script>; its hash changes only when that template
# changes (then update it here; infra/security/csp_check.mjs --cases gallery shows the new hash). Moving the script to a
# file of its own would make this entry unnecessary.
GALLERY_SCRIPT = "'sha256-OkxVQaU3HJ84Xm+E4SJjeZh4RlQ5nvgCyxfvs5QZXD4='"
CSP = '; '.join([
    "default-src 'self'",
    f"script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' {GALLERY_SCRIPT}",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
])
# upgrade-insecure-requests means nothing in a report-only policy (browsers ignore it there and warn)
CSP_REPORT_ONLY = '; '.join(d for d in CSP.split('; ') if not d.startswith('upgrade-insecure'))
PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()'
HSTS_DEFAULT = 31536000   # one year; production ramps up to it (see the audit report)


def policy_config(target, mode, hsts_max_age):
    security = {
        'StrictTransportSecurity': {'Override': True, 'AccessControlMaxAgeSec': hsts_max_age,
                                    'IncludeSubdomains': False, 'Preload': False},
        'ContentTypeOptions': {'Override': True},
        'FrameOptions': {'Override': True, 'FrameOption': 'DENY'},
        'ReferrerPolicy': {'Override': True, 'ReferrerPolicy': 'strict-origin-when-cross-origin'},
    }
    custom = [
        {'Header': 'Permissions-Policy', 'Value': PERMISSIONS_POLICY, 'Override': True},
        {'Header': 'Cross-Origin-Opener-Policy', 'Value': 'same-origin', 'Override': True},
    ]
    if mode == 'enforce':
        security['ContentSecurityPolicy'] = {'Override': True, 'ContentSecurityPolicy': CSP}
    else:
        custom.append({'Header': 'Content-Security-Policy-Report-Only', 'Value': CSP_REPORT_ONLY, 'Override': True})
    return {
        'Name': f'gokyuzu-sf-headers-{target}',
        'Comment': f'Gokyuzu SF {target}: security headers (CSP {mode}); managed by infra/security/headers_policy.py',
        'SecurityHeadersConfig': security,
        'CustomHeadersConfig': {'Quantity': len(custom), 'Items': custom},
        # S3 object metadata the browser does not need
        'RemoveHeadersConfig': {'Quantity': 2, 'Items': [{'Header': 'x-amz-server-side-encryption'},
                                                         {'Header': 'x-amz-version-id'}]},
    }


def session():
    s = boto3.Session(profile_name=deploy_config.profile('AWS_PROFILE_ADMIN'), region_name='us-east-1')
    if s.client('sts').get_caller_identity()['Account'] != deploy_config.get('AWS_ACCOUNT_ID'):
        sys.exit('the admin profile is not in the account AWS_ACCOUNT_ID of the deploy config: stopping')
    return s


def find_policy(cf, name):
    marker = None
    while True:
        kw = {'Type': 'custom', **({'Marker': marker} if marker else {})}
        page = cf.list_response_headers_policies(**kw)['ResponseHeadersPolicyList']
        for it in page.get('Items', []) or []:
            if it['ResponseHeadersPolicy']['ResponseHeadersPolicyConfig']['Name'] == name:
                return it['ResponseHeadersPolicy']['Id']
        marker = page.get('NextMarker')
        if not marker:
            return None


def behaviours(cfg):
    yield 'default', cfg['DefaultCacheBehavior']
    for b in cfg.get('CacheBehaviors', {}).get('Items', []) or []:
        yield b['PathPattern'], b


def backup(target, cfg, etag):
    BACKUPS.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUPS, 0o700)
    p = BACKUPS / f'{target}-distribution-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}.json'
    p.write_text(json.dumps({'ETag': etag, 'DistributionConfig': cfg}, indent=1, default=str))
    os.chmod(p, 0o600)
    return p


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', choices=TARGETS)
    ap.add_argument('--mode', choices=('report-only', 'enforce'), default='report-only')
    ap.add_argument('--hsts-max-age', type=int, default=HSTS_DEFAULT)
    ap.add_argument('--detach', action='store_true', help='remove this policy from every behaviour (the revert)')
    ap.add_argument('--apply', action='store_true', help='make the change (default: dry run)')
    ap.add_argument('--owner-approved', action='store_true', help='required for production')
    ap.add_argument('--wait', action='store_true', help='wait until CloudFront has deployed the change')
    a = ap.parse_args()
    if a.target == 'production' and a.apply and not a.owner_approved:
        sys.exit('production: add --owner-approved, and only after the owner approved this exact change')

    cfg_policy = policy_config(a.target, a.mode, a.hsts_max_age)
    s = session()
    cf = s.client('cloudfront')
    dist_id = deploy_config.get(f'CF_DIST_{a.target.upper()}')
    pid = find_policy(cf, cfg_policy['Name'])
    res = cf.get_distribution_config(Id=dist_id)
    cfg, etag = res['DistributionConfig'], res['ETag']

    print(f'{a.target}: response headers policy {cfg_policy["Name"]} ({"exists" if pid else "not created yet"})')
    if not a.detach:
        print(json.dumps({k: cfg_policy[k] for k in ('SecurityHeadersConfig', 'CustomHeadersConfig', 'RemoveHeadersConfig')}, indent=1))
    changes = []
    for name, b in behaviours(cfg):
        cur = b.get('ResponseHeadersPolicyId') or ''
        if a.detach:
            if pid and cur == pid:
                changes.append(name)
        elif cur and cur != pid:
            sys.exit(f'behaviour {name} already uses another response headers policy: stopping (nothing changed)')
        elif cur != pid or not pid:
            changes.append(name)
    verb = 'detach from' if a.detach else 'attach to'
    print(f'behaviours to {verb}: {", ".join(changes) if changes else "none"}')
    if not a.apply:
        print('dry run: nothing changed (add --apply)')
        return

    if not a.detach:
        if pid:
            p = cf.get_response_headers_policy(Id=pid)
            cf.update_response_headers_policy(Id=pid, IfMatch=p['ETag'], ResponseHeadersPolicyConfig=cfg_policy)
            print(f'policy updated (CSP {a.mode})')
        else:
            pid = cf.create_response_headers_policy(ResponseHeadersPolicyConfig=cfg_policy)['ResponseHeadersPolicy']['Id']
            print(f'policy created (CSP {a.mode})')
    if changes:
        path = backup(a.target, cfg, etag)
        print(f'distribution config saved to ~/.config/gokyuzu/backups/{path.name}')
        for name, b in behaviours(cfg):
            if name in changes:
                if a.detach:
                    b.pop('ResponseHeadersPolicyId', None)
                else:
                    b['ResponseHeadersPolicyId'] = pid
        cf.update_distribution(Id=dist_id, IfMatch=etag, DistributionConfig=cfg)
        print(f'distribution updated: {verb} {", ".join(changes)}')
    if a.wait:
        print('waiting for CloudFront to deploy …')
        cf.get_waiter('distribution_deployed').wait(Id=dist_id, WaiterConfig={'Delay': 20, 'MaxAttempts': 60})
        print('deployed')


if __name__ == '__main__':
    main()
