#!/usr/bin/env bash
# Deploy PollHub on the VM. No Docker, no registry, no build step.
#   ./scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/pollhub-api}"
cd "$APP_DIR"

echo "==> Pulling"
git pull --ff-only

echo "==> Installing production dependencies"
npm ci --omit=dev

echo "==> Migrating"
npm run migrate

echo "==> Reloading"
# reload, not restart: PM2 waits for the old process to finish in-flight
# requests, so a deploy does not drop votes mid-transaction.
pm2 reload ecosystem.config.js --update-env

echo "==> Health check"
for i in $(seq 1 10); do
  if curl -fsS http://localhost:3000/health > /dev/null; then
    echo "Healthy."
    exit 0
  fi
  sleep 1
done

echo "Health check failed after reload — check: pm2 logs pollhub-api" >&2
exit 1
