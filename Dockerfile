# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build, mirrors authservice/Dockerfile. Prisma's `postinstall`
# hook runs `prisma generate` on every `npm ci`, so prisma/schema.prisma has
# to be present before that step in every stage that installs deps.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=24

# ---- deps: install ALL deps (incl. dev) for the build ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- build: compile TypeScript ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm run build

# ---- prod-deps: production-only node_modules (still needs prisma generate) ----
# bookworm-slim has no libssl, so `prisma generate` (the postinstall hook)
# can't detect the OpenSSL version and guesses "debian-openssl-1.1.x" - then
# fails at runtime ("could not locate the Query Engine for runtime
# debian-openssl-3.0.x") because the runtime image (below) actually has 3.0.x.
# Installing openssl HERE, before `npm ci`, makes generate detect the same
# 3.0.x the runtime stage ships, so the fetched engine binary actually matches.
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
# migrations + schema needed at runtime: the container runs
# `prisma migrate deploy` before it starts (see the root docker-compose.yml)
COPY --chown=node:node prisma ./prisma

USER node
EXPOSE 8089

STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8089)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations, then start. migrate deploy takes a Postgres advisory
# lock, so two replicas starting together do not race.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/server.js"]
