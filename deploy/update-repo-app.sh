#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/repo-app}"
BRANCH="${BRANCH:-main}"
PM2_APP_NAME="${PM2_APP_NAME:-repo-app}"

echo "[repo-app] Pulling latest from $BRANCH…"
cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "[repo-app] Installing dependencies…"
npm install --production

echo "[repo-app] Restarting PM2 process…"
pm2 restart "$PM2_APP_NAME" --update-env

echo "[repo-app] Done."
