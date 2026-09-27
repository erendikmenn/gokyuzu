# Stats feed: Gökyüzü numbers to the private dashboard

Every hour a small AWS Lambda turns the game's CloudFront access logs into the dashboard snapshot and pushes it to the
owner's private dashboard (`POST https://stats.erenailab.com/api/ingest/gokyuzu`, ingest contract v1). The numbers come
from `tools/analytics/report.py`, the same code as the local report (`report.py production --json -` prints the same
snapshot on your machine).

```
EventBridge Scheduler (every hour at :05, Europe/Istanbul)
  └─ Lambda erenailab-stats-gokyuzu-feed (Python 3.12, arm64, 2 GB, ~15 s)
       ├─ SSM SecureString: ingest token, analytics salt, owner's IP list
       ├─ S3 access-log bucket, prefix production/ (read-only): the last 2-3 days of logs → /tmp
       ├─ S3 own private bucket, gokyuzu/state.json.gz: per-day history (read / write)
       └─ HTTPS POST of the snapshot (aggregated numbers only)
```

## Files

| file | what |
|---|---|
| `template.yaml` | CloudFormation: state bucket (private, versioned, TLS only), log group (14 days), function + role, schedule + its role. Nothing account-specific; every resource is tagged `project=erenailab-stats`. |
| `handler.py` | The Lambda: secrets from SSM, log download, `report.load` → `report.feed_snapshot`, save the history, push. |
| `deploy.py` | Idempotent deploy with the admin profile of the local deploy config (`~/.config/gokyuzu/deploy.env`). |

## Deploy, redeploy, operate

```sh
.venv/bin/python infra/stats-feed/deploy.py                 # SSM parameters + stack + code (first time and after template changes)
.venv/bin/python infra/stats-feed/deploy.py --code          # after changing report.py or handler.py
.venv/bin/python infra/stats-feed/deploy.py --invoke        # run once now (--no-push: build and save only)
.venv/bin/python infra/stats-feed/deploy.py --schedule DISABLED   # pause (ENABLED to resume)
```

`deploy.py` reads the account, region and log bucket from the deploy config, refuses to run against any other account,
ignores the shell's `AWS_PROFILE`, and writes three SecureString parameters from local files (never printed):
`/erenailab-stats/ingest-token` (`~/.config/erenailab-stats/ingest_token`, shared with the dashboard),
`/erenailab-stats/gokyuzu/analytics-salt` (`~/.config/gokyuzu/analytics_salt`) and `/erenailab-stats/gokyuzu/own-ips`
(`~/.config/gokyuzu/staging_ips`). With the same salt and IP list the feed's anonymous ids, bot and "sen" filtering are
exactly those of the local report. Rotating the token: change the local file, run `deploy.py` (the dashboard side reads
the same file / parameter).

Logs: CloudWatch log group `/aws/lambda/erenailab-stats-gokyuzu-feed` (14 days). Each run prints one JSON line: push
status, days rewritten, totals, seconds. The code and logs never print secrets, bucket names or IPs. Each run also keeps
its snapshot as `gokyuzu/last-snapshot.json` next to the history (what was, or would have been, pushed), so it can be
compared with `report.py --json` run locally on the same log files.

## History past the 30-day log expiry

The log bucket deletes access logs after 30 days, but the dashboard counts since launch (23 Sep 2026). Each Türkiye day
therefore gets a record in the feed's state (`gokyuzu/state.json.gz`): additive counts (flights, active minutes, per
aircraft / map / platform, events, assisted-flight funnel, visit cohorts, score API) and, per anonymous id (6 hex
characters of a salted hash: no IP, no browser string), the few facts that distinct counts need (flights, aircraft,
maps, platforms, event keys). Since-launch visitors / players / "2+ flights" / "2+ days" are unions over the records.

A run reads the logs from the oldest day without a final record (and at least the last 48 h, for the hourly table),
rewrites those days and leaves older ones alone. A record becomes final 26 h after its day ends. After an outage the
feed catches up at most 10 days back; a longer gap can be refilled from the owner's local log cache (below). The state
bucket keeps old versions for 14 days.

Seeding / refilling from the local cache (it has every log since launch):

```sh
.venv/bin/python tools/analytics/report.py production --days 400 --json /tmp/s.json --state /tmp/state.json.gz
.venv/bin/python infra/stats-feed/deploy.py --seed /tmp/state.json.gz [--replace]
```

## Changing the tables

Cards and tables are built by `build_payload` in `tools/analytics/report.py` from the day records (`day_records`);
the definitions are those of the text report (see the comment above `FEED_LAUNCH`). Preview locally with
`report.py production --no-sync --json - --days 400`, then `deploy.py --code`. A new per-day quantity needs a field in
`day_records`: days already final keep their old records, so reseed from the local cache (`--seed … --replace`) if the
new column must cover the whole history.

## Cost

About 720 runs a month of ~15 s at 2 GB (≈ 22,000 GB-s, inside the Lambda free tier; ≈ $0.30 without it), ≈ 0.5 M S3
GET requests for the log files (≈ $0.20), a few MB of state and logs, SSM standard parameters (free) and EventBridge
Scheduler (free tier). Under $1 a month, effectively free.

## Failures

The function retries the push 3 times within a run (not after a 4xx other than 429) and raises on failure (Lambda
`Errors` metric, log line). No e-mail alert: the dashboard shows the snapshot's age, and once the feed has worked, the
first successful snapshot after 3 or more failed runs in a row carries `"stale": true`, as does any snapshot whose
newest log line is more than 3 hours old (the access logs stopped arriving). The history is saved on every run, pushed
or not, so a dashboard outage loses nothing.
