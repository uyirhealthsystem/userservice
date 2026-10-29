#!/usr/bin/env bash
# Runs ON the EC2 host (piped in over SSH by the GitHub Actions deploy job).
# Promotes the freshly-uploaded release in /opt/userservice/releases/next,
# runs migrations, and restarts the service.
set -euo pipefail

ROOT=/opt/userservice
ENV_FILE="$ROOT/shared/userservice.env"
KEEP=5

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE - run deploy/setup-ec2.sh first"; exit 1; }
[ -d "$ROOT/releases/next" ] || { echo "no uploaded release at $ROOT/releases/next"; exit 1; }

TS=$(date +%Y%m%d%H%M%S)
REL="$ROOT/releases/$TS"
mv "$ROOT/releases/next" "$REL"
cd "$REL"

# DATABASE_URL / DIRECT_DATABASE_URL for the migrate step below.
set -a; . "$ENV_FILE"; set +a
export NODE_ENV=production

echo "==> installing production dependencies"
npm ci --omit=dev

echo "==> applying database migrations"
# migrate deploy holds a session advisory lock, which a transaction-mode pooler
# (Neon's "-pooler" host, PgBouncer) can't keep - use the direct host if given.
DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" npx prisma migrate deploy

echo "==> switching 'current' symlink -> $TS"
ln -sfn "$REL" "$ROOT/current"

echo "==> restarting service"
sudo systemctl restart userservice

echo "==> pruning old releases (keeping last $KEEP)"
ls -1dt "$ROOT"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "==> deployed $TS"
