# syntax=docker/dockerfile:1.28
#
# Two-stage build:
#   1. node:alpine builder installs prod deps with pnpm (via Corepack, pinned
#      by sha512 in package.json's "packageManager" field).
#   2. Google distroless nodejs24 runtime (Debian 13), same Node major as the
#      builder and CI — no shell, no package manager,
#      runs as the bundled `nonroot` user (uid 65532). Only Node, our app,
#      and resolved node_modules ship in the final image.
#
# `nonroot` is a rolling tag; we pin by digest so a moved tag can't silently
# change the runtime out from under us. Renovate tracks the digest — that is
# the ONLY way the runtime gets Node security fixes: the weekly CI rebuild
# re-pulls this exact digest. (The old nodejs22 pin sat on Node 22.22.0 for
# months because Renovate held every digest update; see renovate.json.)

# ---- builder ----------------------------------------------------------------
FROM node:24.22.1-alpine AS builder

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

COPY server.mjs oauth.mjs sanitize.mjs ./

# ---- runtime ----------------------------------------------------------------
# Pin by digest because :nonroot is rolling.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:78f07ef1b5ea71ad7c055df15d0dd8997f2d288f9158623c4d4ae3d765b7d50d

WORKDIR /app

# Drop in only what the runtime needs. No pnpm, no shell, no apt-get.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.mjs /app/oauth.mjs /app/sanitize.mjs ./
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Distroless's entrypoint is `/nodejs/bin/node`, so CMD is just the script.
CMD ["server.mjs"]
