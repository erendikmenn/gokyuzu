#!/bin/bash
# Publish the game (AWS S3 + CloudFront, account "gokyuzu-admin"; production behind the Cloudflare proxy, staging DNS only).
#   tools/deploy/deploy.sh staging            → https://staging.fs.erenailab.com (IP allow-list, any branch)
#   tools/deploy/deploy.sh production [--yes] → https://fs.erenailab.com (only from a clean `main`, asks for confirmation, tags the release)
# Needs: the ~/.aws/credentials profile "gokyuzu-deploy" (IAM user gokyuzu-deployer, least privilege)
set -euo pipefail
cd "$(dirname "$0")/../.."
export AWS_PROFILE="${AWS_PROFILE_DEPLOY:-gokyuzu-deploy}"   # least-privilege IAM user (not root)
TARGET="${1:-}"; YES="${2:-}"
case "$TARGET" in
  staging)
    BUCKET=s3://gokyuzu-sf-staging-<aws-account-id>-eu-central-1; DIST_ID=<cf-dist-staging>; URL=https://staging.fs.erenailab.com ;;
  production)
    BUCKET=s3://gokyuzu-sf-<aws-account-id>-eu-central-1; DIST_ID=<cf-dist-production>; URL=https://fs.erenailab.com
    [ "$(git branch --show-current)" = "main" ] || { echo "Canlıya yalnızca 'main' dalından çıkılır (şu an: $(git branch --show-current))."; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "Commit edilmemiş değişiklikler var; canlıya çıkılmadı."; exit 1; }
    if [ "$YES" != "--yes" ]; then read -r -p "fs.erenailab.com CANLI yayına çıkılsın mı? Onaylamak için 'evet' yaz: " a; [ "$a" = "evet" ] || { echo "İptal."; exit 1; }; fi ;;
  *) echo "Kullanım: tools/deploy/deploy.sh staging | production [--yes]"; exit 2 ;;
esac
node tools/make_gallery.mjs >/dev/null
# KTX2 textures (tools/assets): a GLB re-exported from Blender must be converted before it ships (phones would get a stale
# .phone.glb, desktops an uncompressed texture); the check covers the aircraft and every map's airports / landmarks
# (assets/sf, assets/ist: tools/assets/lib/policy.mjs FAMILIES). One-time setup on a new machine: node tools/assets/setup.mjs
node tools/assets/textures.mjs --check || { echo "Önce: node tools/assets/textures.mjs (KTX2 dönüşümü güncel değil)"; exit 1; }
DEPLOY_TARGET="$TARGET" node tools/deploy/build_dist.mjs --gallery
# node_modules/: only three's Draco/Basis decoders are files now (three itself is in the JS bundle). The unbundled modules of
# the pre-bundle site (three/build, the rest of three/examples/jsm) stay for pages opened before; prune_js.mjs removes them.
aws s3 sync dist/node_modules $BUCKET/node_modules --delete --only-show-errors --cache-control "public, max-age=604800" \
  --exclude "three/build/*" --exclude "three/examples/jsm/*" --include "three/examples/jsm/libs/draco/*" --include "three/examples/jsm/libs/basis/*"
# Game files are requested as <file>?v=<hash of its directory> (CONTRACTS-SF.md §9, dist/assets/versions.json), so a
# changed file gets a new URL and no browser keeps an old copy. They still get 1 day, not a year + immutable: S3 and
# CloudFront send one Cache-Control per object whatever the query string, some requests stay unversioned (render gallery,
# dev pages), a player who loaded the old version map just before a deploy fetches new bytes under old ?v= URLs while
# the sync runs, and rollback.py brings old hashes back. One day bounds all of these.
# The terrain height packs sf/terrain/h/<L>.bin (range requests) are no longer published: the game reads hz/ (small
# cacheable files). The copies already in the bucket stay for pages loaded before the switch; once no such page can be
# open any more (a week), remove them with `aws s3 rm $BUCKET/assets/sf/terrain/h --recursive`, then drop this exclude
# and the Cloudflare cache-bypass rule for /assets/sf/terrain/h/.
aws s3 sync dist/assets $BUCKET/assets --delete --only-show-errors --exclude "versions.json" --exclude "sf/terrain/h/*" --cache-control "public, max-age=86400"
# manifests/indexes change with every build: keep them short-lived so browsers never mix old lists with new files
aws s3 cp $BUCKET/assets $BUCKET/assets --recursive --exclude "*" --include "*.json" --exclude "versions.json" --metadata-directive REPLACE --cache-control "public, max-age=300" --content-type "application/json" --only-show-errors
aws s3 sync dist/renders $BUCKET/renders --delete --only-show-errors --cache-control "public, max-age=86400"
# the version map goes up only after every file it points to (nobody gets a new ?v= URL before its file is there);
# short-lived like the other JSON, and the game revalidates it on every start (fetch cache: 'no-cache')
aws s3 cp dist/assets/versions.json $BUCKET/assets/versions.json --only-show-errors --cache-control "public, max-age=300" --content-type "application/json"
# JavaScript (tools/build/bundle.mjs): chunk names carry their content hash, so a year + immutable (no revalidation), and
# uploaded before the pages that name them. Never --delete here: pages opened before this deploy still import their
# lazy chunks (aircraft, sounds) from their own build; prune_js.mjs below removes chunks no open page can need.
# Source maps (*.map) are never uploaded (kept locally: dist/js and node_modules/.cache/gokyuzu/sourcemaps/).
aws s3 sync dist/js $BUCKET/js --size-only --only-show-errors --exclude "*.map" --cache-control "public, max-age=31536000, immutable" --content-type "text/javascript; charset=utf-8"
# the rest (pages, build.json, icons, fonts/images under src/, data/): 5 min; the unbundled src/**/*.js of the pre-bundle
# site is left to prune_js.mjs
aws s3 sync dist $BUCKET --delete --only-show-errors --exclude "assets/*" --exclude "node_modules/*" --exclude "renders/*" --exclude "js/*" --exclude "src/*.js" --exclude "*.map" --cache-control "public, max-age=300"
# pages last and never cached without revalidation: a page names the hashed chunks of exactly its own build, so a
# reload always gets the current build in one piece (no mix of old and new modules)
aws s3 cp dist $BUCKET --recursive --exclude "*" --include "*.html" --only-show-errors --cache-control "no-cache" --content-type "text/html; charset=utf-8"
node tools/build/prune_js.mjs $BUCKET
INV_ID=$(aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --query "Invalidation.Id" --output text)
if [ "$TARGET" = "production" ]; then
  # fs.erenailab.com sits behind the Cloudflare proxy: once CloudFront serves the new files, drop Cloudflare's copies
  # too (purging earlier would let Cloudflare re-fetch old files from CloudFront edges that are still invalidating)
  echo "CloudFront tazeleniyor, ardından Cloudflare önbelleği temizlenecek…"
  aws cloudfront wait invalidation-completed --distribution-id $DIST_ID --id "$INV_ID"
  if [ -f "$HOME/.config/cloudflare.env" ]; then
    set -a; source "$HOME/.config/cloudflare.env"; set +a
    curl -sf -X POST "https://api.cloudflare.com/client/v4/zones/<cloudflare-zone-id>/purge_cache" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      --data '{"hosts":["fs.erenailab.com"]}' >/dev/null && echo "Cloudflare önbelleği temizlendi." \
      || echo "UYARI: Cloudflare önbelleği temizlenemedi (dosyalar en geç 5 dk–1 gün içinde kendiliğinden yenilenir)."
  else
    echo "UYARI: ~/.config/cloudflare.env yok, Cloudflare önbelleği temizlenmedi."
  fi
fi
if [ "$TARGET" = "production" ]; then
  TAG="release-$(date +%Y%m%d-%H%M)"; git tag -a "$TAG" -m "Canlı yayın: $URL"; echo "Etiket: $TAG"
fi
echo "Yayınlandı ($TARGET): $URL  ·  sürüm $(python3 -c "import json; print(json.load(open('dist/build.json'))['version'])")  (önbellek tazeleme 1-2 dk)"
