# userservice — CI/CD (GitHub Actions → AWS EC2)

`.github/workflows/ci-cd.yml` has two jobs:

```
push / PR ─▶ test ──(main only)──▶ deploy ─▶ EC2
```

### `test` (every push + PR)
Postgres 18 service container, then `npm ci` → `prisma migrate deploy` →
`npm run typecheck` → `npm test` → `npm run build`.

### `deploy` (push to `main` only, needs `test` green)
1. `npm ci` + `npm run build` on the runner.
2. Bundle `dist/ package.json package-lock.json prisma/ deploy/` into `release/`.
3. `rsync` the bundle to `EC2_HOST:/opt/userservice/releases/next/`.
4. SSH in and run `deploy/remote-release.sh`, which:
   - promotes `releases/next` → `releases/<timestamp>`,
   - `npm ci --omit=dev` (runs `prisma generate` via `postinstall`),
   - `npx prisma migrate deploy`,
   - repoints `/opt/userservice/current` → the new release,
   - `sudo systemctl restart userservice`,
   - keeps the last 5 releases, deletes older ones.
5. `curl http://127.0.0.1:8089/health` on the box as a smoke test.

Rollback = point `current` at the previous `releases/*` dir and
`sudo systemctl restart userservice` (migrations are not auto-reverted).

## One-time EC2 setup

On the Amazon Linux 2023 instance (65.0.170.87; Ubuntu also works). Keep port 8089 private — only the api-gateway should reach it:

```bash
scp -r deploy ec2-user@65.0.170.87:/tmp/deploy
ssh ec2-user@65.0.170.87 'bash /tmp/deploy/setup-ec2.sh'
ssh ec2-user@65.0.170.87 'nano /opt/userservice/shared/userservice.env'
```

`setup-ec2.sh` installs rsync and Node 22 (dnf on Amazon Linux, apt on Ubuntu), creates the `userservice` system user and
`/opt/userservice/{releases,shared}`, installs the systemd unit
(`deploy/userservice.service`), and grants the deploy user a NOPASSWD sudoers
entry limited to `systemctl restart/status userservice`.

Postgres: use RDS (recommended) or install it on the box. The DB user in
`DATABASE_URL` must be able to run migrations (DDL).

## GitHub configuration

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `EC2_HOST` | `65.0.170.87` |
| `EC2_USER` | SSH user — `ec2-user` on Amazon Linux — same user `setup-ec2.sh` ran as |
| `EC2_SSH_KEY` | private key (full PEM) whose public half is in that user's `~/.ssh/authorized_keys` |

The `deploy` job uses a GitHub **Environment** named `production` — add
required reviewers there if you want a manual approval gate before each
deploy.

## Deploying without GitHub

The repo isn't a git repo yet. Until it's pushed to GitHub you can deploy the
working checkout straight from your machine:

```bash
EC2_HOST=65.0.170.87 EC2_USER=ec2-user EC2_SSH_KEY=~/.ssh/uyir.pem \
  bash deploy/deploy-local.sh
```

It does exactly what the `deploy` job does (build → rsync → `remote-release.sh`
→ health check).

## Files

| Path | Purpose |
|---|---|
| `.github/workflows/ci-cd.yml` | the pipeline |
| `deploy/setup-ec2.sh` | one-time host provisioning |
| `deploy/userservice.service` | systemd unit |
| `deploy/userservice.env.example` | template for `/opt/userservice/shared/userservice.env` |
| `deploy/remote-release.sh` | runs on the host per deploy (promote + migrate + restart) |
| `deploy/deploy-local.sh` | manual deploy from a workstation |

## Notes specific to userservice

- **Port 8089**, bound by the Node process directly. Don't open it in the
  security group to the internet — the api-gateway is the only caller, and
  requests without the right `x-gateway-secret` are refused in production.
- **Same box as authservice is fine.** Each service has its own
  `/opt/<service>`, system user, systemd unit and env file; `setup-ec2.sh`
  skips the Node install when Node 22 is already there. Point this repo's
  `EC2_*` secrets at the same host.
- **Required env in production** (the process exits at boot without them):
  `DATABASE_URL`, `GATEWAY_SECRET`, `DATA_ENCRYPTION_KEY`. Back up
  `DATA_ENCRYPTION_KEY` — stored health-record files can't be decrypted
  without it.
- The background worker (attachments, ABDM, retention) and the Kafka consumer
  run inside the same process — there's no second unit to deploy. If the
  consumer can't reach Kafka at boot the process exits and systemd restarts it.
