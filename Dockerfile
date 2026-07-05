# syntax=docker/dockerfile:1.10
#
# Two-stage build:
#   1. node:alpine builder installs prod deps with pnpm (via Corepack, pinned
#      by sha512 in package.json's "packageManager" field).
#   2. Google distroless nodejs22 runtime — no shell, no package manager,
#      runs as the bundled `nonroot` user (uid 65532). Only Node, our app,
#      and resolved node_modules ship in the final image.
#
# `nonroot` is a rolling tag; we pin by digest so a moved tag can't silently
# change the runtime out from under us. Renovate tracks the digest.

# ---- builder ----------------------------------------------------------------
FROM node:22.22.3-alpine AS builder

# COREPACK_ENABLE_STRICT=1 forces Corepack to refuse any package manager that
# doesn't match the exact `packageManager` field (incl. its sha512). Without
# this, Corepack silently falls back to whatever pnpm a request asks for.
ENV COREPACK_ENABLE_STRICT=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production

RUN corepack enable

WORKDIR /app

# Copy manifests first so the install layer caches independently of source.
# pnpm-workspace.yaml carries the pnpm 11 install/security settings
# (formerly in .npmrc) — must be present before `pnpm install` runs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# `corepack install` reads `packageManager` from package.json and pins exactly
# that pnpm version. `pnpm install --frozen-lockfile` then refuses to mutate
# the lockfile, so the lockfile is the single source of truth for what gets
# installed.
RUN corepack install && \
    pnpm install --frozen-lockfile --prod --reporter=append-only

COPY server.mjs oauth.mjs ./

# ---- runtime ----------------------------------------------------------------
# Pin by digest because :nonroot is rolling.
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

WORKDIR /app

# Drop in only what the runtime needs. No pnpm, no shell, no apt-get.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.mjs /app/oauth.mjs ./
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Distroless's entrypoint is `/nodejs/bin/node`, so CMD is just the script.
CMD ["server.mjs"]
