#!/usr/bin/env bash
# Deploy the current working checkout to EC2 without GitHub Actions.
# Usage:  EC2_HOST=65.0.170.87 EC2_USER=ec2-user EC2_SSH_KEY=~/.ssh/id_ed25519 bash deploy/deploy-local.sh
set -euo pipefail

: "${EC2_HOST:?set EC2_HOST}"
EC2_USER="${EC2_USER:-ec2-user}"
SSH_KEY="${EC2_SSH_KEY:-$HOME/.ssh/id_ed25519}"
cd "$(dirname "$0")/.."

echo "==> build"
npm ci
npm run build

echo "==> assemble bundle"
rm -rf release && mkdir -p release
cp -r dist package.json package-lock.json prisma release/
cp -r deploy release/deploy

echo "==> upload"
if command -v rsync >/dev/null; then
  rsync -az --delete --mkpath -e "ssh -i $SSH_KEY" \
    release/ "$EC2_USER@$EC2_HOST:/opt/userservice/releases/next/"
else
  # Git Bash on Windows ships without rsync - stream a tarball instead.
  tar -C release -czf - . | ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" \
    'rm -rf /opt/userservice/releases/next && mkdir -p /opt/userservice/releases/next && tar -xzf - -C /opt/userservice/releases/next'
fi

echo "==> activate"
ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" 'bash -s' < deploy/remote-release.sh

echo "==> health"
ssh -i "$SSH_KEY" "$EC2_USER@$EC2_HOST" \
  'curl -fsS --retry 5 --retry-delay 2 --retry-connrefused http://127.0.0.1:8089/health' && echo
