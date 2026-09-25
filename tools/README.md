# tools/: running the game locally and rebuilding its assets

The game code is in git. The generated game files are not: `assets/` (about 6 GB built, about 2.8 GB published)
and `renders/` (menu thumbnails, gallery). This page covers the three ways to work with them, from lightest to
heaviest, plus the ops scripts.

## 1. Play and develop with the published game files (no build)

```sh
npm ci
node tools/serve.mjs --assets-from          # http://localhost:5173/
```

`--assets-from [<base URL>]` (default `https://fs.erenailab.com`) makes the dev server fetch a file under `/assets/`
or `/renders/` from the published site **only when the page asks for it and it is missing locally**, and cache it in
`.cache/assets/` (gitignored). Local files always win, so you can rebuild one aircraft or one map and keep the rest
remote.

- **One file per request, nothing more.** The server never prefetches or mirrors. It keeps at most 6 requests in
  flight, sends `User-Agent: gokyuzu-dev-server`, only allows GET for these paths, and remembers a missing file for
  10 minutes.
- **Versions.** Upstream requests carry the same `?v=<directory hash>` from the site's `assets/versions.json` that
  players use, so the CDN answers from its cache. A file is downloaded again only after the site publishes a new
  version of its directory.
- **Traffic.** A first flight on one map costs roughly 50 to 130 MB. Later sessions come from the cache.
- **Please be gentle.** The site is a free game on a small budget, and every download is paid egress. Don't script bulk
  downloads or delete `.cache/` without need. Versioned asset packs for offline work are planned.
- **Cloudflare challenge.** If the site answers with a Cloudflare challenge, the server says so. Pass another origin
  that serves the same files (for example a CloudFront host) as `--assets-from https://…`.
- **Licences.** The downloaded files are covered by the asset licence, not the code licence. Some are third-party (see
  `NOTICE` and `ASSETS-LICENSE.md`).

Other flags: `node tools/serve.mjs [port] [--root dist]`. `--root dist` serves the publish build made by
`node tools/deploy/build_dist.mjs`.

## 2. Tests

```sh
for t in tests/*.test.mjs; do node "$t" || exit 1; done
```

Node 22 or newer. `tests/terrain.test.mjs` and `tests/packs.test.mjs` also check the built files when `assets/` is
present. Without it they print `SKIP` lines and still pass. CI (`.github/workflows/ci.yml`) runs them without assets.

## 3. Rebuild the assets from source

### Prerequisites

| What | Version / note |
|---|---|
| Machine | **macOS**, Apple Silicon recommended. Several texture scripts rasterise macOS system fonts, so Linux needs patches (welcome). |
| Disk | **≥ 30 GB free**: about 11 GB of downloads, 5 GB of caches and 6 GB of output. |
| Time | Roughly one working day of machine time on an M-series Mac. Downloads take 1 to 3 h, depending on bandwidth. |
| Blender | **5.2.x** (developed on 5.2.2). The scripts run `$BLENDER`, default `/Applications/Blender.app/Contents/MacOS/Blender`. |
| Python | **3.12** venv with `requirements.txt`: `python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| Node | 22 or newer; `npm ci`, and `node tools/assets/setup.mjs` for the texture tools |
| KTX-Software | **4.4.2**, the `ktx` encoder. `tools/assets/setup.mjs` downloads the pinned release (SHA-256 checked) into `tools/assets/.bin/`. No system install. |
| Voices (optional) | An ElevenLabs API key (`$ELEVENLABS_API_KEY` or `~/.config/elevenlabs.env`) is needed only to regenerate the voice lines. Every other sound is synthesised or in the repo. |

### Order

The scripts are re-runnable and incremental. Each has its usage in the docstring at the top. `P=.venv/bin/python`.
Scripts default to San Francisco; `GEO_REGION=ist` selects İstanbul.

1. **Terrain, imagery and water.**
   - San Francisco: `terrain_download` → `imagery_download` → `terrain_osm` → `terrain_water` → `terrain_build` →
     `imagery_build` → `terrain_waves` → `terrain_waterinfo` → `terrain_fogmap` → `terrain_pinpack` (all
     `$P tools/geo/<name>.py`).
   - İstanbul first needs `airports_runways` and `terrain_airports`.
2. **City and airports.** `city_fetch` → `city_osm` → facade and city atlas → trees → `airports_*` and the Blender
   airport scripts (`blender/airports/`) → `city_prep` → `city_build` → `city_trees`. The İstanbul sequence is in
   `CONTRACTS-IST.md` ("Rebuild").
3. **Landmarks:** `tools/geo/landmarks_*.py`, then `blender/landmarks*/`.
4. **Aircraft:** `blender/aircraft/<id>/` (`make_all.sh` where present; every Blender run has a hard time limit).
5. **Audio:** `$P tools/audio/build_all.py`.
6. **Minimaps:** `$P src/ui/tools/bake_bay_map.py` and `bake_ist_map.py`.
7. **Post-processing:** `node tools/assets/textures.mjs` (KTX2, see `tools/assets/README.md`), `packs.mjs` and
   `city_meshopt.mjs`.
8. **Publish build:** `node tools/deploy/build_dist.mjs` writes `dist/`, with `assets/versions.json` for cache busting.

### Environment variables

| Variable | Used by | Default |
|---|---|---|
| `BLENDER` | `tools/geo/city_build.py`, `blender/aircraft/*/make_all.sh` | `/Applications/Blender.app/Contents/MacOS/Blender` |
| `GEO_REGION` | `tools/geo/*` | San Francisco; `ist` for İstanbul |
| `QA_OUT`, `PERF_OUT` | `tools/qa`, `tools/perf` output | `<tmpdir>/gokyuzu-qa`, `<tmpdir>/gokyuzu-perf` |
| `ELEVENLABS_API_KEY` | `tools/audio` voice generation | `~/.config/elevenlabs.env` |
| `GOKYUZU_DEPLOY_ENV` | deploy and ops scripts | `~/.config/gokyuzu/deploy.env` |

## 4. Deploy and ops (maintainers)

`tools/deploy/deploy.sh`, `rollback.py`, `staging_access.sh`, `tools/analytics/` and `infra/leaderboard/` publish to
AWS (S3 + CloudFront) and optionally purge a Cloudflare cache. None of them contain account ids, bucket names or
distribution ids. They read a local file that is never committed:

```sh
mkdir -p ~/.config/gokyuzu && cp tools/deploy/deploy.env.example ~/.config/gokyuzu/deploy.env
chmod 600 ~/.config/gokyuzu/deploy.env        # fill in your own values
tools/deploy/deploy.sh --check-config          # names the missing keys; prints no values, makes no AWS calls
```

`deploy.env.example` documents every key. AWS profiles are always passed explicitly, and the shell's `AWS_PROFILE`
is ignored.
