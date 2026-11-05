#!/usr/bin/env bash
# One-time provisioning for a fresh EC2 host: Amazon Linux 2023 (ec2-user)
# or Ubuntu 22.04/24.04 (ubuntu). Amazon Linux 2 is too old for Node 22.
# Run as a sudo-capable user:  bash setup-ec2.sh
set -euo pipefail

NODE_MAJOR=22
ROOT=/opt/userservice
SVC_USER=userservice
DEPLOY_USER=${SUDO_USER:-$USER}

if command -v dnf >/dev/null; then PKG=dnf; else PKG=apt-get; fi

echo "==> base packages (rsync is needed to receive releases)"
if [ "$PKG" = dnf ]; then
  sudo dnf install -y rsync tar
else
  sudo apt-get update -y && sudo apt-get install -y rsync curl
fi

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  if [ "$PKG" = dnf ]; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo dnf install -y nodejs
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

echo "==> service user + directories"
sudo useradd --system --create-home --home-dir "$ROOT" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null || true
sudo mkdir -p "$ROOT/releases" "$ROOT/shared"
# The deploy user (GitHub Actions / deploy-local.sh) uploads releases and flips
# the 'current' symlink; the service user only needs to read the tree.
sudo chown -R "$DEPLOY_USER:$SVC_USER" "$ROOT"
sudo chmod -R g+rX "$ROOT"

echo "==> env file"
if [ ! -f "$ROOT/shared/userservice.env" ]; then
  sudo cp "$(dirname "$0")/userservice.env.example" "$ROOT/shared/userservice.env"
  # Readable by the deploy user (remote-release.sh sources it) and the service.
  sudo chown "$DEPLOY_USER:$SVC_USER" "$ROOT/shared/userservice.env"
  sudo chmod 640 "$ROOT/shared/userservice.env"
  echo "   -> edit $ROOT/shared/userservice.env before the first deploy"
fi

echo "==> systemd unit"
sudo cp "$(dirname "$0")/userservice.service" /etc/systemd/system/userservice.service
sudo systemctl daemon-reload
sudo systemctl enable userservice

echo "==> sudoers: let the deploy user restart the service without a password"
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart userservice, /usr/bin/systemctl status userservice" \
  | sudo tee /etc/sudoers.d/userservice-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/userservice-deploy

cat <<EOF

Done. Next:
  1. Edit  $ROOT/shared/userservice.env   (DATABASE_URL, GATEWAY_SECRET, DATA_ENCRYPTION_KEY, HP_SERVICE_URL...)
  2. Make sure the DB is reachable and the schema user can CREATE.
  3. Add these GitHub repo secrets (Settings > Secrets and variables > Actions):
       EC2_HOST     = this host's public DNS / IP
       EC2_USER     = $DEPLOY_USER
       EC2_SSH_KEY  = a private key whose public half is in ~$DEPLOY_USER/.ssh/authorized_keys
  4. Push to main - the CI/CD workflow deploys here.
     Or deploy the current checkout manually:  bash deploy/deploy-local.sh
EOF
