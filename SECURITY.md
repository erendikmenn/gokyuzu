# Security policy

## Reporting a vulnerability

Please report security problems **privately through GitHub**, not in a public issue:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**. You can also go there directly:
   <https://github.com/erendikmenn/REPO_NAME/security/advisories/new>
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

The report (a draft security advisory) is visible only to you and the maintainer. We discuss the fix there and
credit you in the advisory when it is published, unless you prefer not to be named. English or Turkish is fine.

There is no security e-mail address: GitHub's private reporting is the only channel.

## What to expect

Gökyüzü is a free project run by one maintainer, so these are goals, not guarantees:

- a first reply within **7 days**;
- a fix or a mitigation plan within **30 days** for confirmed issues, sooner for serious ones;
- a published advisory once the fix is live.

## Scope

In scope:

- the game code in this repository (`src/`), as served at <https://fs.erenailab.com>;
- the leaderboard service (`infra/leaderboard/`): input validation, rate limits, the nickname filter, anything that
  could reveal or link players (it stores only a salted hash of a random browser key, never an IP address);
- the anonymous usage beacons (`src/core/telemetry.js`): anything that would make them identify a person;
- the build and deploy tools (`tools/`), for example a path traversal in the dev server `tools/serve.mjs`;
- secrets or personal data committed by mistake.

Out of scope:

- denial-of-service and load testing against the live site, and automated scanning that sends large amounts of
  traffic (the site is a free project that pays for its traffic);
- findings that need a compromised device or browser;
- missing security headers without a demonstrated impact;
- vulnerabilities in third-party services (Cloudflare, AWS, GitHub): report those to their vendors;
- cheating on the leaderboard by editing your own client, unless it breaks the service or other players' data.

## Rules for testing

- Test against your own local copy: `node tools/serve.mjs` for the game, and the in-memory leaderboard of
  `infra/leaderboard/lambda/` (see `tests/leaderboard.test.mjs`). On the live site, only look at your own requests.
- Do not access, change or delete other players' data. Stop and report as soon as you see data that is not yours.
- Do not use social engineering against the maintainer, contributors or players.
- Give us reasonable time to fix a problem before you disclose it publicly.

If you follow these rules in good faith, we will not take legal action against you for your research, and we will
thank you in the advisory.

## Supported versions

Only the live site and the latest `main` branch receive security fixes. Forks and older releases do not.
