# Infrastructure security audit, September 2026

Date: 2026-09-27. Scope: the hosting (AWS S3, CloudFront, Lambda, DynamoDB, IAM and the account settings), the Cloudflare
zone in front of https://fs.erenailab.com, DNS and the email-spoofing surface of that zone, and the GitHub repository
`erendikmenn/gokyuzu`. The game's own code is covered by a separate application review.

**How it was done.** Every AWS, Cloudflare and GitHub call was read-only (`get`, `list`, `describe`, HTTP `GET`). There
was one exception, which the owner allowed in advance: a response headers policy was attached to the **staging**
distribution (section 3). Nothing in production, DNS, the Cloudflare zone or the GitHub settings was changed.

**What this document leaves out.** It is public, so it names no account id, bucket, distribution, zone, IP address, email
address, person or host other than the two game hosts. Resources are described by role ("the production bucket").
Every command below reads the real ids from `~/.config/gokyuzu/deploy.env` when it runs.

**Where the rules come from.**
- AWS: the Well-Architected Security Pillar and the Security Hub CSPM "Foundational Security Best Practices" (FSBP)
  controls. Control ids such as S3.5 or IAM.5 are quoted in the tables.
- Cloudflare: the Cloudflare documentation.
- Email: M3AAWG, RFC 7489, RFC 7505 and RFC 8659.
- GitHub: GitHub's security hardening guides.
- Prices: the public price lists, checked on 2026-09-27, in USD per month.

---

## 1. Summary

The game's own AWS resources are built well:
- The buckets are private and read only through origin access control.
- The leaderboard's function URL requires IAM auth, and only this distribution can call it.
- The IAM roles have least privilege.
- The production table has deletion protection and point-in-time recovery.
- Every log has an expiry.

The weak points are elsewhere:
- **Identity around the project.** A Cloudflare API token that can do almost anything sits on the laptop. Cloudflare and
  AWS console administrators have no second factor.
- **A way around Cloudflare.** The production distribution answers anyone who reaches it directly, which skips the WAF,
  the rate limit, the challenge and the security headers.
- **Cost and detection alarms.** There is no budget, no CloudTrail trail and no GuardDuty.
- **Free security features left off.** DMARC for the parent domain, DNSSEC, and GitHub's secret scanning, Dependabot and
  CodeQL are all off.

### Top 10 by risk

| # | ID | Finding | Risk | Fix (short) | Cost / month | Owner approval |
|---|----|---------|------|-------------|--------------|----------------|
| 1 | A-1 | The Cloudflare API token on the deploy machine can edit **every zone and nearly every account setting**: DNS, WAF, SSL, Workers, API tokens, billing and registrar. It has no expiry and no IP filter. `deploy.sh` only needs cache purge. | Critical | Replace it with a purge-only token for one zone (90-day TTL) plus a separate read-only token, then roll the broad token | 0 | yes |
| 2 | A-2 | Both Cloudflare account members are Super Administrators **without two-factor authentication**, and 2FA is not enforced. | High | Security key or TOTP for both, then turn on "enforce 2FA" | 0 | yes |
| 3 | A-3 | Two human AWS IAM users have `AdministratorAccess` and a console password but **no MFA**. There is no password policy. | High | Add MFA (passkey) or remove the unused login; set a password policy | 0 | yes |
| 4 | E-1 | **The Cloudflare protections can be bypassed.** The production distribution serves the game, the API and the beacons to anyone who connects to CloudFront directly, through its `*.cloudfront.net` name or with `fs.erenailab.com` pinned to a CloudFront edge address. There is no challenge, WAF, rate limit, Cloudflare cache or security headers (all checked with curl). | High | "Origin lock": Cloudflare adds a secret header, and a CloudFront Function refuses requests without it | ~0.5 | discuss |
| 5 | D-1 | **No cost guardrails.** There is no AWS Budget. The only anomaly alert fires at ≥ $100 **and** ≥ 40 % impact. A bandwidth or API flood through E-1 could run for days unnoticed. | High | A monthly and a daily budget with e-mail alerts; anomaly alert at $5 | 0 | yes |
| 6 | G-1 | **Secret scanning and push protection are off** on a public repository whose tools handle cloud credentials. | High | Turn on secret scanning, push protection and validity checks | 0 | yes |
| 7 | D-2 | **No CloudTrail trail** (only the 90-day event history). GuardDuty, IAM Access Analyzer, Security Hub and Config are all off. | Medium–High | One multi-Region trail with log file validation, and the external access analyzer. GuardDuty after discussion. | < 0.10 (+ GuardDuty ~1–5) | yes |
| 8 | M-1 | **The parent domain receives and sends mail but has no DMARC record.** Anyone can put the parent domain in a visible `From:` and receivers have no policy to apply. The newsletter subdomain's DMARC is `p=none` with no report address. | Medium | Add DMARC with reports first (`p=none; rua=`), then quarantine and reject; `sp=reject` for the non-mail subdomains | 0 | yes |
| 9 | H-1/2/3 | **Weak security headers.** Headers are set only by Cloudflare, so responses that bypass Cloudflare have none. The CSP is only `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` and HSTS lasts one day. | Medium | CloudFront response headers policy with a full CSP (**tested on staging, section 3**), and HSTS raised in steps to one year | 0 | yes |
| 10 | D-4/D-5 | **Unbounded cost paths.** On-demand DynamoDB has no maximum throughput, the staging function has no reserved concurrency, and the legacy 172–381 MB terrain packs are still downloadable, which makes large-file amplification easy. | Medium | DynamoDB max read/write units; staging concurrency 2; remove the legacy `terrain/h/` packs | 0 | yes |

**Also worth doing:**
- DNSSEC (E-3).
- A TLS-only policy on every bucket (S-1) and account-level Block Public Access (S-2).
- Dependabot, CodeQL and a tag ruleset (G-2 to G-5).
- A second root security key and no routine root use (A-4).
- CAA (M-3).

The full table is in section 2; the commands are in section 4.

---

## 2. Findings by area

**Columns:**
- **Approval:** the owner approves each production change separately.
- **Effort:** S is under 15 minutes, M under 1 hour, L more than that.
- **Cost:** monthly, in USD, at this site's current traffic. Over the last 7 days that was about 1.7 million CloudFront
  requests and about 190 GB, including the launch day. The whole site sits inside CloudFront's always-free allowance of
  1 TB and 10 million requests a month.

### A. Identity and accounts

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| A-1 | Cloudflare API token scope | One account-owned token covers all 4 zones of the account. It can edit DNS, WAF, SSL, Workers and Transform Rules, and at account level API Tokens, Billing, Registrar, Workers, R2 and Zero Trust. It has no TTL and no client-IP filter. It lives in the deploy machine's env file, and `deploy.sh` exports it to its child processes. | One token per job, least privilege, limited to one zone, with a TTL and ideally an IP filter. Use the dashboard with 2FA for administrative changes. | Critical: whoever reads that file can take over DNS for the game and the mail domain, mint new tokens and keep access. | A purge-only token for `deploy.sh`; a read-only token for audits; roll, then delete, the broad token (4.1-A1). | 0 | S | yes |
| A-2 | Cloudflare account MFA | 2 members, both Super Administrator, both without 2FA; `enforce_twofactor` is off. | 2FA for every member (security keys preferred), 2FA enforced, and the least role that works. | High: a phished password takes over everything. | Enable 2FA for both, then enforce it; review whether the second member needs Super Administrator. | 0 | S | yes |
| A-3 | IAM human users (FSBP IAM.5, IAM.7) | 2 console users with `AdministratorAccess`, a password and no MFA; their last sign-ins were 17 and 27 days ago. There is no account password policy. | MFA for every console user; no long-lived admin users (use IAM Identity Center, which is free). | High | Passkey MFA for both, or delete the login profile of the one not in use; add a password policy (4.1-A3). Later, move to Identity Center. | 0 | S | yes |
| A-4 | Root user (IAM.4, IAM.6, IAM.9) | MFA is on (a FIDO security key); there are no root access keys, which passes. **But the admin CLI profile is a console sign-in session of the root user**, so every admin task runs as root. There is one MFA device. | Root only for root-only tasks; at least two MFA devices. | Medium | Register a second security key; do admin work as an Identity Center or IAM admin with MFA. | 0 | S | yes |
| A-5 | Programmatic keys | The deploy and analytics users each have one active key, 3 days old, least-privilege and used daily. The deploy user may call `lambda:GetFunctionConfiguration`, so it can **read the leaderboard's hashing salt**, a secret kept in a plain environment variable. | Rotate keys every 90 days or less (IAM.3); keep secrets out of environment variables (Parameter Store or Secrets Manager). | Low–Medium | Put a 90-day key rotation in the calendar (4.1-A5). Move the salt to a Parameter Store SecureString (free tier), or encrypt the environment with a customer managed key the deploy user cannot decrypt (4.3-A5). | 0 / 1 | M | discuss |
| A-6 | Alternate security contact (Account.1) | None set (security, billing and operations). | A security contact that is not the root mailbox. | Low | Set the SECURITY and BILLING contacts (4.1-A6). | 0 | S | yes |
| A-7 | Public git history | The account id and bucket and distribution names are in older commits of this public repository; the current tree keeps them outside the repo. **No tokens, access keys, private keys or allow-listed IPs were found in the history.** | Treat them as public. No control depends on their secrecy. | Info | Accept: history is not rewritten (no force pushes). | 0 | – | – |

### B. Detection, cost and abuse limits

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| D-1 | Budgets and billing alerts | No AWS Budget and no billing alarm. The default Cost Anomaly Detection subscription has a confirmed e-mail subscriber, but its threshold is ≥ $100 **and** ≥ 40 %. | Budgets with actual and forecast alerts; an anomaly threshold that fits a small account. | High (cost) | A monthly budget ($20: 50 %, 100 % and forecast 100 %), a daily budget ($3), and an anomaly threshold of $5 absolute (4.1-D1). | 0 | S | yes |
| D-2 | CloudTrail (CloudTrail.1, .4) | No trail. | One multi-Region trail with read and write management events, log file validation, a private bucket and an expiry. | Medium–High: no durable record of who changed what beyond 90 days, and nothing for GuardDuty or an incident to work from. | Create the trail (4.2-D2). The first copy of management events is free; storage costs cents. | < 0.10 | S | yes |
| D-3 | GuardDuty, Access Analyzer, Security Hub (GuardDuty.1, IAM.28) | All off. | GuardDuty on; an external access analyzer; optionally Security Hub CSPM for continuous checks. | Medium | Access Analyzer (external access, free) now (4.1-D3). GuardDuty with EKS, RDS, EBS and runtime monitoring off: a 30-day free trial, then about $1–5 (4.2-D3). Security Hub CSPM plus Config, about $2–5, is optional. | 0 / 1–5 / 2–5 | S | yes |
| D-4 | DynamoDB and Lambda abuse limits | Production Lambda: reserved concurrency 10 (a good cap). **Staging Lambda: none**; when it was set up the account limit was too low, and it is now 1,000. Both tables are on-demand with **no maximum throughput**, so a sustained flood could reach about 600 write units/s, roughly $40/day of DynamoDB alone. | Reserved concurrency and on-demand maximum throughput as cost caps. | Medium (cost) | `MaxWriteRequestUnits` 50 and `MaxReadRequestUnits` 100 on production, 10 and 10 on staging; staging concurrency 2 (4.1-D4). Over the last week production used about 2,600 write units in total, so the cap leaves a wide margin. | 0 | S | yes |
| D-5 | Large legacy files | The `assets/sf/terrain/h/` packs (172–381 MB each) are still in the production bucket. `deploy.sh` says to delete them one week after the switch to `hz/`. | Do not serve big files nobody needs, especially through a path Cloudflare does not cache. | Medium (cost): each request pulls hundreds of MB out of CloudFront, and E-1 lets it skip Cloudflare. | Remove them as `deploy.sh` describes, then drop its exclude and the Cloudflare cache-bypass rule (deploy owner). | 0 | S | yes |

### C. Cloudflare zone and edge

What is already right:
- SSL/TLS is Full (strict), with automatic mode, and the minimum is TLS 1.2 (tested: 1.0 and 1.1 are refused everywhere).
- TLS 1.3, ECH, HTTP/3, Brotli, Always Use HTTPS and Automatic HTTPS Rewrites are on. 0-RTT is off.
- **Bot Fight Mode is off.** Keep it off: WAF skips cannot exempt anything from it, and it challenges non-HTML requests
  such as assets, workers and `/api`.
- The Cloudflare Free Managed Ruleset is deployed.
- The WAF uses 4 of its 5 custom rules:
  - write methods are blocked except `POST /api/score`;
  - probes for `/.git`, `/.env`, `*.map` and the like are blocked;
  - `/` and `/index.html` get a managed challenge;
  - one rule keeps the rate limit to the game's host.
- The rate limit allows 60 page requests per 10 s per IP.

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| E-1 | Origin reachable only through the proxy | The production distribution answers anyone. Its `*.cloudfront.net` name, or `fs.erenailab.com` resolved to any CloudFront edge address, returns the game (HTTP 200 on `/`), `/api/top` and `/_e` with no challenge, WAF, rate limit or headers. `PUT /api/score` goes straight to the function URL, where the origin access control signature check refuses it. | Lock the origin to the proxy: a shared-secret header checked at the origin. Cloudflare's Authenticated Origin Pulls does not fit a CloudFront origin. | High | Origin lock (4.3-E1). The leaderboard already rate-limits per address inside the function and trusts `CF-Connecting-IP` only from Cloudflare addresses, so this mainly closes cost and bandwidth abuse, WAF evasion and framing of the bare host. | ~0.5 | M | discuss |
| E-2 | Rate limit coverage | The Free plan's single rate-limiting rule covers `/` and `/index.html` only. `/api/score` and `/api/top` have no edge limit; the function has its own limits (12 POST and 90 GET per minute per address). | Rate-limit the dynamic endpoints at the edge. | Low–Medium | Add `/api/score` and `/api/top` to the same rule's path list (4.1-E2). | 0 | S | yes |
| E-3 | DNSSEC | Disabled. The registrar is not Cloudflare, so the DS record is added there by hand. | DNSSEC on. | Medium: spoofed DNS for the game and the mail domain. | Enable in Cloudflare, add the DS record at the registrar, then verify (4.1-E3). A wrong DS record breaks resolution, so do it carefully. | 0 | S | yes |
| E-4 | security.txt (RFC 9116) | None. | `/.well-known/security.txt` with `Contact` and `Expires`. | Low | Serve it from the game bucket (content in 4.1-E4). Cloudflare's security.txt feature would apply to every host in the zone, including the owner's other sites. | 0 | S | yes |
| E-5 | Client-side script monitoring | Off. | Optional on Free (script monitor only). | Info | Optional. It adds its own `Content-Security-Policy-Report-Only` header to a sample of pages. | 0 | S | yes |
| E-6 | Zone-wide settings touching other sites | Automatic Email Routing shows "misconfigured" at the apex, because the apex MX points to a third-party mailbox provider; the newsletter subdomain routes correctly. | – | Info | Nothing required. The owner may want to confirm the apex's Email Routing is meant to stay enabled. | 0 | – | – |

### D. CloudFront

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| H-1 | Response headers at the origin (CloudFront has no FSBP id; OWASP headers) | No response headers policy on any behaviour of either distribution. Production gets headers only from Cloudflare's transform rule, so bypassing responses have none. S3 metadata headers (`x-amz-version-id`, `x-amz-server-side-encryption`) reach browsers. | Security headers on every response, set as close to the content as possible. | Medium | A per-target response headers policy on every behaviour: `infra/security/headers_policy.py`, **tested on staging** (section 3, plan 4.1-H). | 0 | S | yes |
| H-2 | Content-Security-Policy | Production (via Cloudflare): `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. That stops plugins, `<base>` hijacking and framing, but no script or connection sources are restricted. | A restrictive CSP from real use; report-only first, then enforced. | Medium | The policy below, enforced; it passes all tests in Chromium, WebKit (iPhone) and Firefox. | 0 | S | yes |
| H-3 | HSTS | `max-age=86400` (1 day) through Cloudflare, only for the game's host. Zone-level HSTS is off. | At least 1 year. includeSubDomains and preload only when every subdomain of the parent domain is HTTPS-only, which is a zone-wide decision. | Low–Medium | Raise it in steps: 1 week, then 1 year. The game's host only; no preload. | 0 | S | yes |
| C-1 | Viewer TLS policy (CloudFront.15) | `TLSv1.2_2021` with an SNI-only ACM certificate on both distributions; HTTP/2 and HTTP/3 on. | `TLSv1.2_2021` passes; `TLSv1.2_2025` and `TLSv1.3_2025` are stricter. | Low: players connect to Cloudflare, not to CloudFront. | Optional: `TLSv1.2_2025` (test on staging first). | 0 | S | yes |
| C-2 | Origin access (CloudFront.13, .16, .9, .10) | S3 through OAC (sigv4, always); the Lambda URL through OAC (auth `AWS_IAM`); HTTPS-only and TLS 1.2 to the Lambda origin; no legacy OAI. | As is. | – | – | 0 | – | – |
| C-3 | Logging (CloudFront.5) | Legacy standard logs to the logs bucket (30-day expiry); it feeds `tools/analytics/report.py`. | Keep logs. Legacy logging needs bucket ACLs (see S-3). | – | See S-3. | 0 | – | – |
| C-4 | WAF on CloudFront (CloudFront.6) | None; the Cloudflare WAF covers traffic that comes through the proxy. | A WAF on the path users take. E-1 closes the other path. | Low (after E-1) | Not recommended at this size (AWS WAF would cost about $10/month). | – | – | – |
| C-5 | Error responses | S3 answers 403 XML for a missing key; the game relies on that ("missing optional file"). | – | Info | Leave as is. | 0 | – | – |
| C-6 | Staging `/_e` | The beacon behaviour on staging has no IP allow-list (one viewer function per behaviour), so anyone can add lines to the staging access logs. | – | Low | Accept, or fold the allow-list check into a staging copy of the beacon function. | 0 | S | no |

**The CSP proposed for production.** It is the one in `infra/security/headers_policy.py`, enforced on staging since
2026-09-27:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-OkxVQaU3HJ84Xm+E4SJjeZh4RlQ5nvgCyxfvs5QZXD4=';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:;
media-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'; frame-src 'none';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

It comes with these headers:
- `Strict-Transport-Security: max-age=…` (no includeSubDomains or preload)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Cross-Origin-Opener-Policy: same-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()`

The Permissions-Policy leaves alone what the game uses: device orientation (tilt steering), fullscreen, gamepads and Web Share.

**Why each allowance is there:**
- **`'unsafe-eval'`** is needed today. three.js's KTX2 (Basis Universal) transcoder is Emscripten embind code, which builds
  its bindings with `new Function` (`craftInvokerFunction`). With `'unsafe-eval'` removed, every KTX2 texture fails and the
  game never becomes playable, in all three engines. A blob: worker inherits the page's policy, so the allowance cannot be
  limited to the worker. It can go once the transcoder is built without dynamic code (`-sDYNAMIC_EXECUTION=0`) or loaded
  from its own URL with its own policy, which is a note for the application review. There is still no
  `'unsafe-inline'` for scripts, so injected markup cannot run code.
- **The `sha256-…` hash** allows the one fixed inline script of `galeri.html`, which comes from the `tools/make_gallery.mjs`
  template. If that template changes, `csp_check.mjs --cases gallery` prints the new hash. Moving the script into its own
  file would make the entry unnecessary.
- **`style-src 'unsafe-inline'`** is needed because `index.html` has an inline `<style>` and the UI sets inline styles.
  That is low risk when scripts are restricted.

### E. S3

What is already right:
- Block Public Access is on for all 4 settings on every bucket in the account.
- The site buckets are read only by `cloudfront.amazonaws.com`, with an `AWS:SourceArn` condition naming their own
  distribution.
- Default encryption is SSE-S3, with SSE-C blocked.
- The site buckets have versioning, keep old versions for 30 days and abort incomplete multipart uploads after 7 days.
- The site buckets use `BucketOwnerEnforced`.
- The logs expire after 30 days.

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| S-1 | TLS-only access (S3.5) | No `aws:SecureTransport` deny on any of the 3 buckets (the logs bucket has no policy). | Deny `s3:*` when `aws:SecureTransport` is false. | Low: OAC and the SDKs use TLS anyway. | Add the deny statement to all three policies (4.1-S1). | 0 | S | yes |
| S-2 | Account-level Block Public Access (S3.1) | Not configured. Every bucket has its own, but a future bucket could be made public by mistake. | On at account level. | Low | Turn on all 4 settings for the account (4.1-S2). Every existing bucket already blocks public access, so nothing changes today. | 0 | S | yes |
| S-3 | ACLs on the logs bucket (S3.12) | `BucketOwnerPreferred` with a `FULL_CONTROL` grant to the CloudFront log delivery account, which legacy CloudFront logging requires. | Disable ACLs (`BucketOwnerEnforced`). That needs CloudFront standard logging v2 (delivery to S3 costs nothing extra). | Low | Discuss (4.3-S3). v2 writes a different file layout, so `report.py` must change, and FSBP CloudFront.5 only recognises legacy logging. | 0 | M | discuss |
| S-4 | Server access logging (S3.9) | Off on the site buckets. | FSBP asks for it. | Low | Not recommended: CloudFront logs plus CloudTrail cover this site. Suppress if Security Hub is turned on. | – | – | – |

### F. Lambda and DynamoDB

What is already right:
- Runtime `nodejs24.x` on arm64 (supported until 2028-04-30, Lambda.2).
- The function URL uses auth `AWS_IAM`, with OAC. The resource policy allows `lambda:InvokeFunctionUrl` and
  `lambda:InvokeFunction` only for `cloudfront.amazonaws.com` from this target's own distribution, and the latter only
  when `InvokedViaFunctionUrl` is true (Lambda.1).
- Recursive loop detection is set to Terminate.
- The timeout is 5 s and the memory 256 MB.
- The role can only GetItem, PutItem, UpdateItem and Query its own table and index, and write its own log group.
- Log retention is 14 days, errors only.
- The production table has point-in-time recovery (35 days, DynamoDB.2) and deletion protection (DynamoDB.6).
- Both tables have TTL on `exp` and are encrypted at rest with an AWS owned key.

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| L-1 | Secret in environment variables | `SALT` is in the function's environment, encrypted with the AWS managed key, so anyone with `lambda:GetFunctionConfiguration` sees it; the deploy user has that permission. | Secrets in Parameter Store or Secrets Manager, read at cold start. | Low–Medium | See A-5. | 0–1 | M | discuss |
| L-2 | Reserved concurrency and throughput caps | See D-4. | | | | | | |
| L-3 | Code signing | Not used. | Optional (no charge). | Info | Not worth the process for a single-maintainer project. | – | – | – |

### G. DNS and email

The parent zone holds records for the game's two hosts and for the owner's other sites. Those other records were checked
for dangling or insecure entries only and are not described further here.

- No dangling records were found. The two game hosts point to the two existing distributions: production is proxied,
  staging is DNS-only by design. The ACM validation CNAMEs are still needed for certificate renewal. The other sites' CNAMEs
  point to live services of their mail and newsletter providers.
- The apex MX points to a third-party mailbox provider. The apex has an SPF record `… -all` and DKIM keys.
- The newsletter subdomain sends through two providers and has its own SPF, DKIM and DMARC records.

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| M-1 | DMARC for the parent domain | **Missing.** | `p=none` with aggregate reports, then `quarantine`, then `reject`. `sp=reject` protects the subdomains that never send mail (the game's hosts among them); a subdomain with its own `_dmarc` record keeps its own policy (RFC 7489 §6.6.3). | Medium: exact-domain spoofing of the owner's mail domain. | Cloudflare DMARC Management (free) supplies the report address; then publish the record and tighten it after 2–4 weeks of clean reports (4.1-M1). | 0 | S | yes |
| M-2 | DMARC for the newsletter subdomain | `p=none` without `rua`, so it neither enforces nor reports. | Add `rua`, then move to `quarantine`. | Low | Owner's decision; that subdomain is outside this audit's change scope. | 0 | S | yes |
| M-3 | CAA (RFC 8659) | None. | Restrict issuance to the CAs in use: Amazon for the two CloudFront certificates. Cloudflare adds its own CAs' records automatically once any CAA record exists. | Low | `0 issue "amazon.com"` at the apex (4.1-M3). First confirm no other CA issues certificates for names in the zone. | 0 | S | yes |
| M-4 | Null MX or SPF on the game hosts | The game hosts are CNAMEs, so they cannot hold TXT or MX records. | Covered by `sp=reject` in the parent DMARC record (M-1). | – | – | 0 | – | – |

### H. GitHub

What is already right:
- The default `GITHUB_TOKEN` is read-only, and workflows cannot approve pull requests.
- `ci.yml` sets `permissions: contents: read`.
- No `pull_request_target` or `workflow_run` triggers, no Actions secrets, deploy keys, webhooks or environments.
- One collaborator: the owner.
- Private vulnerability reporting is on, and `SECURITY.md` exists.
- Rulesets: `main` and `dev` refuse force pushes and deletion with no bypass; `main` needs a pull request plus the checks
  "tests (Node 22)" and "tests (Node 24)", and the admin can bypass.
- Workflows from first-time contributors need approval.

| ID | Control | Current state | Best practice | Risk | Proposed change | Cost | Effort | Approval |
|----|---------|---------------|---------------|------|-----------------|------|--------|----------|
| G-1 | Secret scanning and push protection | **Both off** (also non-provider patterns and validity checks). | On for every public repository (free). | High | Turn them on (4.1-G). | 0 | S | yes |
| G-2 | Dependabot | Alerts off, security updates off, no config file. | Alerts and security updates on; version updates for the workflow actions. | Medium | Turn on alerts and security updates (4.1-G). **Done in this commit:** `.github/dependabot.yml` (actions only, monthly, 7-day cooldown). It takes effect once merged to `main`. | 0 | S | yes |
| G-3 | CodeQL | Not configured (default setup offers actions, JavaScript/TypeScript and Python). | Default setup on (free for public repos). | Medium–Low | Turn on the default setup (4.1-G). | 0 | S | yes |
| G-4 | Actions supply chain | All actions are allowed; SHA pinning is not required; `ci.yml` used `@v5` tags; checkout kept the token in `.git/config`. | Pin full commit SHAs; allow GitHub-owned actions only; `persist-credentials: false`. | Low | **Done in this commit:** `ci.yml` pins `actions/checkout` v5.1.0 and `actions/setup-node` v5.0.0 by SHA, with `persist-credentials: false` (check names unchanged). Then set the repository policy (4.1-G). | 0 | S | yes |
| G-5 | Release tags | `release-*` and `v*` tags can be moved or deleted by anyone with write access (today only the owner). | A tag ruleset against update and deletion. | Low | Add a tag ruleset (4.1-G). `deploy.sh` still creates new tags. | 0 | S | yes |
| G-6 | Fork pull request workflow approval | First-time contributors only. | "All external contributors" is stricter: one merged typo fix no longer skips the approval. | Low | Optional (4.1-G). | 0 | S | yes |

### I. Other account-level items

- **An unrelated small EC2 instance runs in the account.** IMDSv2 is required, the volume is encrypted, and only one UDP
  port is open. That is fine.
- **EBS encryption by default is off at account level.** Turning it on is free:
  `aws ec2 enable-ebs-encryption-by-default`.
- **ACM certificates** for both game hosts are Amazon-issued and eligible for automatic renewal. They expire in April 2027,
  and their validation records exist.

---

## 3. Staging experiment: response headers and CSP

### What changed

Only the **staging** distribution was changed:
- A new CloudFront response headers policy, `gokyuzu-sf-headers-staging` (free), was created.
- It was attached to the default, `/api/*` and `/_e` behaviours.
- Nothing else in the distribution changed.
- `headers_policy.py` saved the previous distribution config first, to `~/.config/gokyuzu/backups/` (chmod 600, outside
  the repository).
- Staging uses `HSTS max-age=86400`, so the experiment leaves nothing lasting in browsers.

### The steps

1. **Report-only phase.** The policy above without `'unsafe-eval'` and without the gallery hash, sent as
   `Content-Security-Policy-Report-Only`. `infra/security/csp_check.mjs` loaded 5 cases in 3 engines: the San Francisco map
   (A320 and F-16), İstanbul, a mission deep link, and `galeri.html`. The engines were Chromium desktop, WebKit on an
   iPhone 15 profile and Firefox desktop. It found two things:
   - the fixed inline script of `galeri.html`, now allowed by its hash;
   - in Firefox, a would-be-blocked `eval` in a blob: worker.

   WebKit ignores report-only policies that have no `report-uri`, so this phase did not test WebKit.
2. **Candidate policies injected locally.** `csp_check.mjs --inject-csp` adds the policy to page responses inside the test
   browser only; the site does not change. Without `'unsafe-eval'` the game **never became playable**:
   `EvalError … newFunc … craftInvokerFunction`, raised in the Basis transcoder worker. With `'unsafe-eval'` it was clean.
3. **Enforced on staging.** The final policy (section 2, D) was set as `Content-Security-Policy` on staging, and then:

| Check | Result |
|-------|--------|
| `node infra/security/csp_check.mjs https://staging.fs.erenailab.com` (6 cases × Chromium, WebKit iPhone 15, Firefox) | **18 of 18 clean**: every case playable, 0 violations, 0 CSP console messages, 0 console errors, 0 HTTP errors (exit 0) |
| `node tools/deploy/live_check.mjs https://staging.fs.erenailab.com` (the 5 standard cases) | **5 of 5 `problems=0`**: ready in 1.3–2.5 s, 21–32 MB before playable, 60 fps |

### Revert

Detaching the policy puts back exactly the state before the experiment, with no response headers policy on any behaviour:

```bash
.venv/bin/python infra/security/headers_policy.py staging --detach --apply --wait
# optional, afterwards: delete the unattached policy
#   awsa cloudfront list-response-headers-policies --type custom   (find gokyuzu-sf-headers-staging)
#   awsa cloudfront delete-response-headers-policy --id <id> --if-match <etag>
```

To go back to report-only instead, run `headers_policy.py staging --apply` (the default mode).

**Staging is left with the enforced policy on purpose**, so that new code is tested against the future production headers
before it ships. Rerun `csp_check.mjs` against staging after any change that loads new kinds of resources: a new decoder,
an external font, an embed, or an inline script.

**If setup scripts are rerun.** `infra/leaderboard/setup.py` and `tools/analytics/setup.py` now keep an attached response
headers policy when they rebuild the `/api/*` or `/_e` behaviour. Before this change, rerunning them would have silently
dropped the headers from those paths.

---

## 4. Change plan

Each production step needs the owner's go-ahead on its own. Run the snippets in **bash**, from the repository root. The
first block loads the ids without printing them; open a fresh `bash` first, because the helpers `exit` when a key is missing:

```bash
bash
cd ~/flight-sim && . tools/deploy/config.sh
cfg_set ACCT AWS_ACCOUNT_ID; cfg_set REGION AWS_REGION
cfg_set B_PROD S3_BUCKET_PRODUCTION; cfg_set B_STG S3_BUCKET_STAGING; cfg_set B_LOGS S3_BUCKET_LOGS
cfg_set D_PROD CF_DIST_PRODUCTION; cfg_set ZONE CLOUDFLARE_ZONE_ID
cfg_profile ADMIN AWS_PROFILE_ADMIN gokyuzu-admin
awsa() { env -u AWS_PROFILE aws --profile "$ADMIN" "$@"; }
# Cloudflare: a short-lived token with just the permission the step needs (see A-1), typed in, never saved
read -rs -p 'Cloudflare token for this step: ' CF_TOKEN; echo
cf() { local p=$1; shift; curl -sS -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4$p" "$@"; }
```

### 4.1 Safe and no cost

**A1: Cloudflare tokens (dashboard, about 10 minutes)**
1. Go to Manage Account → Account API Tokens → Create Token and create:
   - "gokyuzu deploy: cache purge": Zone → Cache Purge → Purge; resources: only the parent zone; TTL 90 days; client IP
     filtering optional.
   - "gokyuzu audit: read-only": Zone Read, DNS Read, Zone Settings Read, Zone WAF Read, Firewall Services Read,
     Transform Rules Read, Cache Settings Read, Bot Management Read, SSL and Certificates Read, Config Settings Read,
     Page Shield Read, Email Routing Rules Read; same zone; TTL 90 days.
2. Put the purge token into `~/.config/cloudflare.env` (`CLOUDFLARE_API_TOKEN=…`, chmod 600). Keep the audit token in a
   separate file, never in the deploy file.
3. Run a staging deploy, then a production deploy when one is due, and confirm the "Cloudflare önbelleği temizlendi" line.
4. **Roll, then delete, the broad token.** For edits, create a narrow token when it is needed, with a TTL of hours.

**A2: Cloudflare 2FA.** Each member enables 2FA under My Profile → Authentication, preferably with a security key. Then
turn on Manage Account → Members → "Enforce two-factor authentication". Check whether the second member needs a narrower
role than Super Administrator.

**A3: AWS console users.** Each human user registers a passkey or security key under Security credentials → Assign MFA
device. Remove the console password of a user who no longer needs one:
`awsa iam delete-login-profile --user-name <human-user>`. Then set the password policy:

```bash
awsa iam update-account-password-policy --minimum-password-length 16 --require-symbols --require-numbers \
  --require-uppercase-characters --require-lowercase-characters --allow-users-to-change-password --password-reuse-prevention 24
```

**A4: Root.** Register a second security key for root in the console. For everyday administration, create an IAM Identity
Center user with an administrator permission set (Identity Center is free) and use `aws sso login`, or an IAM admin with
MFA. After that, make `AWS_PROFILE_ADMIN` point to that profile instead of the root session.

**A5: Key rotation, every 90 days, for each of `gokyuzu-deployer` and `gokyuzu-analytics`.**

```bash
awsa iam create-access-key --user-name gokyuzu-deployer      # put the new pair into ~/.aws/credentials by hand
tools/deploy/deploy.sh staging                                # proves the new key works
awsa iam list-access-keys --user-name gokyuzu-deployer        # then deactivate and delete the old key id:
awsa iam update-access-key --user-name gokyuzu-deployer --access-key-id <old> --status Inactive
awsa iam delete-access-key --user-name gokyuzu-deployer --access-key-id <old>
```

**A6: Alternate contacts.** Use a mailbox the owner chooses, typed at run time:

```bash
read -r -p 'security contact e-mail: ' SEC_MAIL; read -r -p 'phone (+90…): ' SEC_PHONE
awsa account put-alternate-contact --alternate-contact-type SECURITY --name "Gokyuzu maintainer" --title "Owner" \
  --email-address "$SEC_MAIL" --phone-number "$SEC_PHONE"
# the same with --alternate-contact-type BILLING
```

**D1: Budgets and the anomaly alert.**

```bash
read -r -p 'alert e-mail: ' ALERT
notes() { python3 -c 'import json,sys; e=sys.argv[1]; print(json.dumps([{"Notification":{"NotificationType":t,"ComparisonOperator":"GREATER_THAN","Threshold":v,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":e}]} for t,v in json.loads(sys.argv[2])]))' "$ALERT" "$1"; }
awsa budgets create-budget --account-id "$ACCT" \
  --budget '{"BudgetName":"account-monthly","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers "$(notes '[["ACTUAL",50],["ACTUAL",100],["FORECASTED",100]]')"
awsa budgets create-budget --account-id "$ACCT" \
  --budget '{"BudgetName":"account-daily","BudgetLimit":{"Amount":"3","Unit":"USD"},"TimeUnit":"DAILY","BudgetType":"COST"}' \
  --notifications-with-subscribers "$(notes '[["ACTUAL",100]]')"
SUB=$(awsa ce get-anomaly-subscriptions --region us-east-1 --query 'AnomalySubscriptions[0].SubscriptionArn' --output text)
awsa ce update-anomaly-subscription --region us-east-1 --subscription-arn "$SUB" --threshold-expression \
  '{"Dimensions":{"Key":"ANOMALY_TOTAL_IMPACT_ABSOLUTE","MatchOptions":["GREATER_THAN_OR_EQUAL"],"Values":["5"]}}'
```

The amounts are a starting point for an account whose normal bill is close to zero. Billing data arrives 8–24 hours late,
so the daily budget is the faster alarm. Daily budgets support actual-cost alerts only.

**D3a: IAM Access Analyzer, external access (free).**

```bash
awsa accessanalyzer create-analyzer --region "$REGION" --analyzer-name account-external-access --type ACCOUNT
```

**D4: Throughput caps.** The staging concurrency can also be set by rerunning `infra/leaderboard/setup.py staging`; it
asks for 10, which the account limit allows now.

```bash
awsa dynamodb update-table --region "$REGION" --table-name gokyuzu-sf-leaderboard-production \
  --on-demand-throughput MaxReadRequestUnits=100,MaxWriteRequestUnits=50
awsa dynamodb update-table --region "$REGION" --table-name gokyuzu-sf-leaderboard-staging \
  --on-demand-throughput MaxReadRequestUnits=10,MaxWriteRequestUnits=10
awsa lambda put-function-concurrency --region "$REGION" --function-name gokyuzu-sf-leaderboard-staging \
  --reserved-concurrent-executions 2
```

To undo a cap, set its value to `-1`. Requests above a cap are throttled, and the function then answers with an error;
it does not fail open. Watch `ThrottledRequests` for a week afterwards.

**D5: The legacy terrain packs.** This is the step already written in `deploy.sh`:
`aws s3 rm s3://<production bucket>/assets/sf/terrain/h --recursive` with the deploy profile. Then drop the `sf/terrain/h/*`
exclude and the Cloudflare cache rule "terrain height packs bypass the Cloudflare cache".

**E2: Rate limit the API at the edge.** Change the single Free-plan rule's expression:

```bash
python3 - <<'PY'
import json, os, urllib.request
zone, tok = os.environ['ZONE'], os.environ['CF_TOKEN']
api = f'https://api.cloudflare.com/client/v4/zones/{zone}/rulesets'
def call(url, method='GET', body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))['result']
rs = call(f'{api}/phases/http_ratelimit/entrypoint')
rule = rs['rules'][0]
rule['expression'] = '(http.request.uri.path in {"/" "/index.html" "/api/score" "/api/top"}) and not cf.client.bot'
keep = {k: rule[k] for k in ('action', 'expression', 'description', 'enabled', 'ratelimit') if k in rule}
call(f"{api}/{rs['id']}/rules/{rule['id']}", 'PATCH', keep)
print('rate limit rule updated')
PY
```

Run it with `ZONE` and `CF_TOKEN` exported.

**E3: DNSSEC.**

```bash
cf "/zones/$ZONE/dnssec" -X PATCH --data '{"status":"active"}'
cf "/zones/$ZONE/dnssec" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r["status"], "key tag", r["key_tag"], "alg", r["algorithm"], "digest type", r["digest_type"], "digest", r["digest"])'
```

Add these values as a DS record at the registrar (DNSSEC settings of the domain). After 1–2 days the status goes from
`pending` to `active`. Check with `dig +dnssec <parent domain> SOA` or an online DNSSEC analyser. To roll back, remove the
DS record at the registrar first, wait for its TTL, and only then disable DNSSEC in Cloudflare.

**E4: security.txt.** Add this as a static file of the game at `.well-known/security.txt`. It needs a `build_dist.mjs`
entry, which belongs to the build owner.

```
Contact: https://github.com/erendikmenn/gokyuzu/security/advisories/new
Expires: 2027-09-01T00:00:00.000Z
Policy: https://github.com/erendikmenn/gokyuzu/security/policy
Preferred-Languages: en, tr
Canonical: https://fs.erenailab.com/.well-known/security.txt
```

**H: Security headers in production.** There are three steps; the first two change nothing for players.

1. **Attach the tested policy to the production distribution**, with 1-week HSTS. Players still get Cloudflare's header
   values, because Cloudflare's "set" overrides the origin. Responses that bypass Cloudflare now get the full set.

   ```bash
   .venv/bin/python infra/security/headers_policy.py production --mode enforce --hsts-max-age 604800   # dry run first
   .venv/bin/python infra/security/headers_policy.py production --mode enforce --hsts-max-age 604800 --apply --wait --owner-approved
   ```
2. **Check the production build under the production headers**, going around Cloudflare's challenge, in Chromium:

   ```bash
   . tools/deploy/config.sh; cfg_set CFH CF_HOST_PRODUCTION
   IP=$(dig +short "$CFH" A | head -1)
   node infra/security/csp_check.mjs https://fs.erenailab.com --engines chromium --map "fs.erenailab.com=$IP"
   ```

   Then open the game on an iPhone and in Firefox with the console open.
3. **Let the origin's headers through.** Disable the Cloudflare response-header transform rule "FS: safe browser security
   headers" (its `enabled` flag, in the dashboard or with the rulesets API). From then on the CloudFront policy is the
   single source of the headers. Recheck with `curl -sI https://fs.erenailab.com/src/data/changelog.json`. To roll back,
   re-enable the rule: it keeps its old values.

   After 1–2 weeks without problems, rerun step 1 with `--hsts-max-age 31536000`.

**M1: DMARC for the parent domain.**
1. In the dashboard, open Email → DMARC Management → Enable. This is free and gives a report address.
2. Publish the monitoring record:

   ```bash
   read -r -p 'DMARC report address from DMARC Management: ' RUA
   cf "/zones/$ZONE/dns_records" -X POST --data "$(python3 -c 'import json,sys; print(json.dumps({"type":"TXT","name":"_dmarc","ttl":3600,"content":"\"v=DMARC1; p=none; rua=mailto:%s; fo=1\"" % sys.argv[1],"comment":"DMARC for the parent domain: monitoring first"}))' "$RUA")"
   ```
3. After 2–4 weeks in which the reports show only the owner's mail provider passing DKIM or SPF, change the record to
   `p=quarantine; sp=reject`, and after another 2–4 weeks to `p=reject; sp=reject`.

The newsletter subdomain's own record takes precedence for that subdomain, so its mail is unaffected. `sp=reject` covers
the game's hosts and every other subdomain that never sends mail.

**M3: CAA.** First confirm that nothing else in the zone gets certificates from another CA. Cloudflare adds its own CAs,
including for its wildcard edge certificate.

```bash
cf "/zones/$ZONE/dns_records" -X POST --data '{"type":"CAA","name":"@","ttl":3600,"data":{"flags":0,"tag":"issue","value":"amazon.com"},"comment":"ACM certificates of the game hosts; Cloudflare adds its own CAs"}'
```

**S1: TLS-only bucket policies.** This merges the statement into the existing policies:

```bash
for B in "$B_PROD" "$B_STG" "$B_LOGS"; do
  P=$(mktemp)
  awsa s3api get-bucket-policy --bucket "$B" --query Policy --output text > "$P" 2>/dev/null || echo '{"Version":"2012-10-17","Statement":[]}' > "$P"
  python3 - "$B" "$P" <<'PY'
import json, sys
b, f = sys.argv[1], sys.argv[2]
p = json.load(open(f))
p['Statement'] = [s for s in p['Statement'] if s.get('Sid') != 'DenyInsecureTransport'] + [{
    'Sid': 'DenyInsecureTransport', 'Effect': 'Deny', 'Principal': '*', 'Action': 's3:*',
    'Resource': [f'arn:aws:s3:::{b}', f'arn:aws:s3:::{b}/*'],
    'Condition': {'Bool': {'aws:SecureTransport': 'false'}}}]
json.dump(p, open(f, 'w'))
PY
  awsa s3api put-bucket-policy --bucket "$B" --policy "file://$P" && rm -f "$P"
  awsa s3api get-bucket-policy-status --bucket "$B" --query PolicyStatus.IsPublic   # must stay false
done
```

Afterwards, run a staging deploy, `node tools/deploy/live_check.mjs https://staging.fs.erenailab.com`, and
`tools/analytics/report.py --days 1`.

**S2: Account-level Block Public Access.**

```bash
awsa s3control put-public-access-block --account-id "$ACCT" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

It does not affect the log delivery grant, which is not a public ACL.

**G: GitHub.**

```bash
R=erendikmenn/gokyuzu
gh api -X PATCH repos/$R --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"},
 "secret_scanning_non_provider_patterns":{"status":"enabled"},"secret_scanning_validity_checks":{"status":"enabled"}}}
JSON
gh api -X PUT repos/$R/vulnerability-alerts
gh api -X PUT repos/$R/automated-security-fixes
gh api -X PATCH repos/$R/code-scanning/default-setup -f state=configured -f query_suite=default
gh api -X PUT repos/$R/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT repos/$R/actions/permissions/selected-actions -F github_owned_allowed=true -F verified_allowed=false
gh api -X PUT repos/$R/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors   # optional
gh api -X POST repos/$R/rulesets --input - <<'JSON'
{"name":"Release tags cannot be moved or deleted","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/release-*","refs/tags/v*"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"update"}],"bypass_actors":[]}
JSON
```

Merge the `ci.yml` pinning to `main` before `sha_pinning_required` is turned on, because unpinned workflows fail once it
is on. Validity checks and non-provider patterns may not be offered on a personal account; the API then says so.

### 4.2 Small cost

**D2: CloudTrail, one multi-Region trail. Under $0.10 a month**: the first copy of management events is free, and S3
storage costs cents.

```bash
TB="account-trail-$ACCT-$REGION"; TRAIL="arn:aws:cloudtrail:$REGION:$ACCT:trail/account-trail"
awsa s3api create-bucket --bucket "$TB" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
awsa s3api put-public-access-block --bucket "$TB" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awsa s3api put-bucket-policy --bucket "$TB" --policy "$(python3 - "$TB" "$ACCT" "$TRAIL" <<'PY'
import json, sys
b, a, t = sys.argv[1:]
print(json.dumps({'Version': '2012-10-17', 'Statement': [
  {'Sid': 'AclCheck', 'Effect': 'Allow', 'Principal': {'Service': 'cloudtrail.amazonaws.com'}, 'Action': 's3:GetBucketAcl',
   'Resource': f'arn:aws:s3:::{b}', 'Condition': {'StringEquals': {'aws:SourceArn': t}}},
  {'Sid': 'Write', 'Effect': 'Allow', 'Principal': {'Service': 'cloudtrail.amazonaws.com'}, 'Action': 's3:PutObject',
   'Resource': f'arn:aws:s3:::{b}/AWSLogs/{a}/*',
   'Condition': {'StringEquals': {'s3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': t}}},
  {'Sid': 'DenyInsecureTransport', 'Effect': 'Deny', 'Principal': '*', 'Action': 's3:*',
   'Resource': [f'arn:aws:s3:::{b}', f'arn:aws:s3:::{b}/*'], 'Condition': {'Bool': {'aws:SecureTransport': 'false'}}}]}))
PY
)"
awsa s3api put-bucket-lifecycle-configuration --bucket "$TB" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-after-1-year","Filter":{"Prefix":""},"Status":"Enabled","Expiration":{"Days":365}}]}'
awsa cloudtrail create-trail --region "$REGION" --name account-trail --s3-bucket-name "$TB" \
  --is-multi-region-trail --enable-log-file-validation
awsa cloudtrail start-logging --region "$REGION" --name account-trail
```

The trail covers the whole account, including the owner's other projects.

**D3b: GuardDuty. A 30-day free trial, then an estimated $1–5 a month.** The trial's usage page shows the real figure.
Only the features that matter here are turned on:

```bash
awsa guardduty create-detector --region "$REGION" --enable --finding-publishing-frequency SIX_HOURS --features \
  '[{"Name":"S3_DATA_EVENTS","Status":"ENABLED"},{"Name":"LAMBDA_NETWORK_LOGS","Status":"ENABLED"},
    {"Name":"EKS_AUDIT_LOGS","Status":"DISABLED"},{"Name":"EBS_MALWARE_PROTECTION","Status":"DISABLED"},
    {"Name":"RDS_LOGIN_EVENTS","Status":"DISABLED"},{"Name":"RUNTIME_MONITORING","Status":"DISABLED"}]'
```

Findings are e-mailed through an EventBridge rule to an SNS topic, or read in the console weekly.

**E1 (the recommended variant) costs about $0.50 a month.** It is described in 4.3, because it needs a decision.

**Optional: Security Hub CSPM with AWS Config, about $2–5 a month.** It checks these controls continuously. Suppress the
controls this audit accepts: S3.9, CloudFront.4, CloudFront.6 and CloudFront.17.

### 4.3 Needs discussion

**E1: Origin lock.**
- **What it closes:** direct CloudFront access that skips the WAF, the rate limit, the challenge, the cache and the headers.
- **What it risks:** if the Cloudflare rule and the CloudFront Function ever disagree, the whole site answers 403.
- **Cost:** about 7 million function runs a month, of which 2 million are free, so about $0.50 a month.
- **Cheaper variant:** lock only `/api/*`, the part that costs Lambda and DynamoDB money. That is about $0, but assets and
  pages stay reachable around Cloudflare.

The steps:
1. **Create the secret:** `umask 077; openssl rand -hex 32 > ~/.config/gokyuzu/origin_secret`.
2. **Have Cloudflare add the header** to requests for the game's host. This is a request header transform rule. The phase
   has no rules today; if it has any by then, add this rule instead of replacing them.

   ```bash
   S=$(cat ~/.config/gokyuzu/origin_secret)
   cf "/zones/$ZONE/rulesets/phases/http_request_late_transform/entrypoint" -X PUT --data "$(python3 -c 'import json,sys; print(json.dumps({"rules":[{"description":"FS: origin lock header for CloudFront","expression":"(http.host eq \"fs.erenailab.com\")","action":"rewrite","action_parameters":{"headers":{"x-gk-origin":{"operation":"set","value":sys.argv[1]}}}}]}))' "$S")"
   ```
3. **Create and test a production-only CloudFront Function.** It takes the viewer-request slot of every production
   behaviour, including `/_e`, where it also answers the beacon, replacing `gokyuzu-beacon` there.

   ```js
   // gokyuzu-origin-lock-production (cloudfront-js-2.0, viewer request): only requests that came through Cloudflare
   var SECRET = '__ORIGIN_SECRET__';
   function handler(event) {
     var req = event.request, h = req.headers['x-gk-origin'];
     if (!h || h.value !== SECRET) {
       return { statusCode: 403, statusDescription: 'Forbidden', headers: { 'cache-control': { value: 'no-store' } } };
     }
     delete req.headers['x-gk-origin'];
     if (req.uri === '/_e') {   // the beacon (tools/analytics/beacon-function.js): 204 at the edge, one access-log line
       return { statusCode: 204, statusDescription: 'No Content', headers: { 'cache-control': { value: 'no-store' } } };
     }
     return req;
   }
   ```

   Use `aws cloudfront create-function` with the secret substituted, then `test-function` with and without the header,
   then `publish-function`.
4. **Attach it** to the default, `/api/*` and `/_e` behaviours of the production distribution (`update-distribution`,
   after saving the config as `headers_policy.py` does).
5. **Verify:**
   - `curl -sI https://fs.erenailab.com/src/data/changelog.json` → 200.
   - The same with `--resolve fs.erenailab.com:443:<CloudFront edge IP>` → 403.
   - The bare `*.cloudfront.net` host → 403.
   - Beacons still appear in `report.py`.
6. **Follow-ups:**
   - `infra/leaderboard/verify.mjs production --cf` and anything else that calls the CloudFront host directly must send
     the header.
   - Drop the `*.cloudfront.net` origin from the function's allowed `ORIGINS`.
   - Rotate the secret yearly: set the new value in Cloudflare and the function together.

**Rollback:** re-attach `gokyuzu-beacon` to `/_e`, remove the function from the other behaviours, and delete the Cloudflare
rule.

**A5 and L-1: the salt.**
- **Option 1:** move `SALT` to an SSM Parameter Store SecureString (standard tier, AWS managed key: free). The function
  reads it at cold start; the role gets `ssm:GetParameter` on that one parameter. This is an application change.
- **Option 2:** encrypt the function's environment with a customer managed KMS key ($1 a month) that the deploy user
  cannot use for decryption.

**S3: CloudFront standard logging v2.**
- **What it gives:** ACLs can be disabled on the logs bucket (S3.12).
- **What it costs in work:** the log files have another layout, so `tools/analytics/report.py` must change, and FSBP
  CloudFront.5 only recognises legacy logging.
- **Recommendation:** do it only together with a report update.

**CloudFront flat-rate plans (announced November 2025).** The fixed monthly price with no overage would cap the cost of
abuse outright. But the Free plan's allowance (1 million requests and 100 GB) is below this site's traffic, and it has
no access logs (Pro, $15, and above), which the telemetry needs. Custom response headers policies, the CSP of this report,
need Business ($200). Accounts on the AWS Free Tier are not eligible. Worth another look once traffic settles.

**HSTS for the parent domain (includeSubDomains or preload).** Every present and future subdomain would have to be
HTTPS-only. That is a zone-wide decision for all of the owner's sites, not the game's.

---

## 5. Re-checking

- **Response headers:**
  - `curl -sI https://fs.erenailab.com/src/data/changelog.json` (through Cloudflare).
  - The same with `--resolve` to a CloudFront edge address: what CloudFront itself sends; 403 once E1 is in place.
- **CSP in real browsers:** `node infra/security/csp_check.mjs https://staging.fs.erenailab.com`. Exit 0 means no
  violation, no CSP console message, no console error, no HTTP error and every case playable. `--inject-csp "<policy>"`
  tries a candidate policy without changing the site.
- **Load and smoke test:** `node tools/deploy/live_check.mjs https://staging.fs.erenailab.com`.
- **Settings:** repeat the read-only calls this audit used:
  - `aws iam get-account-summary`, `aws iam generate-credential-report` and `get-credential-report`;
  - `aws s3api get-bucket-policy`, `get-public-access-block`;
  - `aws cloudfront get-distribution-config`;
  - `aws lambda get-function-concurrency`, `aws dynamodb describe-table`;
  - `aws cloudtrail describe-trails`, `aws budgets describe-budgets`;
  - Cloudflare `GET /zones/{zone}/settings/{id}`, `/dnssec`, `/rulesets/phases/{phase}/entrypoint`, `/dns_records`;
  - `gh api repos/erendikmenn/gokyuzu` (`security_and_analysis`), `/actions/permissions`, `/rulesets`.

  Use the read-only Cloudflare token (A-1) for the Cloudflare calls.

## 6. Sources

- **AWS Security Hub CSPM, FSBP controls:**
  - https://docs.aws.amazon.com/securityhub/latest/userguide/fsbp-standard.html
  - the per-service control pages under the same path
- **AWS Well-Architected Security Pillar:** https://docs.aws.amazon.com/wellarchitected/latest/framework/a-security.html
- **CloudFront:**
  - origin access control for S3 and Lambda: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
    and https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
  - response headers policies: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html
  - viewer TLS policies: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/secure-connections-supported-viewer-protocols-ciphers.html
  - legacy logging: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging-legacy-s3.html
  - flat-rate plans: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
- **Lambda:**
  - function URL auth: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
  - environment variable encryption: https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars-encryption.html
  - runtimes: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html
  - concurrency: https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html
- **DynamoDB on-demand maximum throughput:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html
- **Pricing:**
  - CloudTrail: https://aws.amazon.com/cloudtrail/pricing/
  - GuardDuty: https://aws.amazon.com/guardduty/pricing/
  - Budgets: https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/
  - IAM Access Analyzer: https://aws.amazon.com/iam/access-analyzer/pricing/
  - AWS WAF: https://aws.amazon.com/waf/pricing/
- **Root user:** https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html
- **Cloudflare:**
  - SSL/TLS modes: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/
  - HSTS: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/
  - DNSSEC: https://developers.cloudflare.com/dns/dnssec/
  - custom rules: https://developers.cloudflare.com/waf/custom-rules/
  - rate limiting rules: https://developers.cloudflare.com/waf/rate-limiting-rules/
  - Bot Fight Mode: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
  - challenges and fetch requests: https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/
  - Transform Rules: https://developers.cloudflare.com/rules/transform/
  - managed transforms: https://developers.cloudflare.com/rules/transform/managed-transforms/reference/
  - client-side security: https://developers.cloudflare.com/client-side-security/
  - security.txt: https://developers.cloudflare.com/security-center/infrastructure/security-file/
  - API tokens: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
  - DMARC Management: https://developers.cloudflare.com/dmarc-management/
  - CAA records: https://developers.cloudflare.com/ssl/edge-certificates/caa-records/
- **Email:**
  - RFC 7489 (DMARC): https://www.rfc-editor.org/rfc/rfc7489
  - RFC 7505 (null MX): https://www.rfc-editor.org/rfc/rfc7505
  - RFC 8659 (CAA): https://www.rfc-editor.org/rfc/rfc8659
  - RFC 9116 (security.txt): https://www.rfc-editor.org/rfc/rfc9116
  - M3AAWG parked domains: https://www.m3aawg.org/sites/default/files/m3aawg_parked_domains_bp-2015-12.pdf
  - GOV.UK: https://www.gov.uk/guidance/protect-domains-that-dont-send-email
- **GitHub:**
  - secure use of Actions: https://docs.github.com/en/actions/reference/security/secure-use
  - `pull_request_target`: https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
  - Actions permissions API: https://docs.github.com/en/rest/actions/permissions
  - Dependabot options: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
  - push protection: https://docs.github.com/en/code-security/concepts/secret-security/about-push-protection
  - rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- **OWASP HTTP headers cheat sheet:** https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
