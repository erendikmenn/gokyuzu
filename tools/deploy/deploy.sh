#!/bin/bash
# Publish the game (AWS S3 + CloudFront, account "gokyuzu-admin"; DNS on Cloudflare).
#   tools/deploy/deploy.sh staging            → https://staging.fs.erenailab.com (IP allow-list, any branch)
#   tools/deploy/deploy.sh production [--yes] → https://fs.erenailab.com (only from a clean `main`, asks for confirmation, tags the release)
# Needs: aws login --profile gokyuzu-admin
set -euo pipefail
cd "$(dirname "$0")/../.."
export AWS_PROFILE=gokyuzu-admin
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
DEPLOY_TARGET="$TARGET" node tools/deploy/build_dist.mjs --gallery
aws s3 sync dist/node_modules $BUCKET/node_modules --delete --only-show-errors --cache-control "public, max-age=604800"
aws s3 sync dist/assets $BUCKET/assets --delete --only-show-errors --cache-control "public, max-age=86400"
# manifests/indexes change with every build: keep them short-lived so browsers never mix old lists with new files
aws s3 cp $BUCKET/assets $BUCKET/assets --recursive --exclude "*" --include "*.json" --metadata-directive REPLACE --cache-control "public, max-age=300" --content-type "application/json" --only-show-errors
aws s3 sync dist/renders $BUCKET/renders --delete --only-show-errors --cache-control "public, max-age=86400"
aws s3 sync dist $BUCKET --delete --only-show-errors --exclude "assets/*" --exclude "node_modules/*" --exclude "renders/*" --cache-control "public, max-age=300"
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --query "Invalidation.Id" --output text >/dev/null
if [ "$TARGET" = "production" ]; then
  TAG="release-$(date +%Y%m%d-%H%M)"; git tag -a "$TAG" -m "Canlı yayın: $URL"; echo "Etiket: $TAG"
fi
echo "Yayınlandı ($TARGET): $URL  ·  sürüm $(python3 -c "import json; print(json.load(open('dist/build.json'))['version'])")  (önbellek tazeleme 1-2 dk)"
