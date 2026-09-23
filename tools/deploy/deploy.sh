#!/bin/bash
# Publish the game to https://fs.erenailab.com (AWS S3 + CloudFront, account "gokyuzu-admin").
# Usage: tools/deploy/deploy.sh        (needs: aws login --profile gokyuzu-admin)
set -euo pipefail
cd "$(dirname "$0")/../.."
export AWS_PROFILE=gokyuzu-admin
BUCKET=s3://gokyuzu-sf-<aws-account-id>-eu-central-1
DIST_ID=<cf-dist-production>
node tools/make_gallery.mjs >/dev/null
node tools/deploy/build_dist.mjs --gallery
aws s3 sync dist/node_modules $BUCKET/node_modules --delete --only-show-errors --cache-control "public, max-age=604800"
aws s3 sync dist/assets $BUCKET/assets --delete --only-show-errors --cache-control "public, max-age=86400"
aws s3 sync dist/renders $BUCKET/renders --delete --only-show-errors --cache-control "public, max-age=86400"
aws s3 sync dist $BUCKET --delete --only-show-errors --exclude "assets/*" --exclude "node_modules/*" --exclude "renders/*" --cache-control "public, max-age=300"
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*" --query "Invalidation.Id" --output text
echo "Yayınlandı: https://fs.erenailab.com (önbellek tazeleme 1-2 dk sürer)"
