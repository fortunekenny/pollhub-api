#!/usr/bin/env bash
# Nightly pg_dump to Cloudflare R2. Run from cron:
#   15 3 * * * /srv/pollhub-api/scripts/backup.sh >> /var/log/pollhub/backup.log 2>&1
#
# Free cloud accounts carry no SLA and can be suspended with little recourse.
# This script plus deploy.sh are what make "rebuild elsewhere within an hour"
# true rather than aspirational — so test the restore, not just the backup.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${R2_BUCKET:?R2_BUCKET must be set}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="/tmp/pollhub-${STAMP}.sql.gz"

echo "==> Dumping"
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$FILE"

SIZE=$(stat -c %s "$FILE")
# A dump that small means pg_dump wrote an error, not a database.
if [ "$SIZE" -lt 1024 ]; then
  echo "Dump is only ${SIZE} bytes — aborting rather than uploading a bad backup." >&2
  rm -f "$FILE"
  exit 1
fi

echo "==> Uploading (${SIZE} bytes)"
# Requires: aws cli configured against the R2 S3-compatible endpoint.
aws s3 cp "$FILE" "s3://${R2_BUCKET}/db/" --endpoint-url "${R2_ENDPOINT}"

rm -f "$FILE"

echo "==> Pruning local dumps older than 7 days"
find /tmp -name 'pollhub-*.sql.gz' -mtime +7 -delete 2>/dev/null || true

echo "Backup complete: pollhub-${STAMP}.sql.gz"
