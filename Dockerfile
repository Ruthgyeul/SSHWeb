# syntax=docker/dockerfile:1
#
# SSHWeb runs a CUSTOM Node server (`server.mjs`) that hosts Next.js *and*
# bridges a WebSocket to a real SSH connection — so this image runs
# `node server.mjs`, not `next start`. Multi-stage: the builder compiles the
# Next app; the runner ships only production deps + the build output.

# ---- builder: install all deps and produce the .next build --------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined into the client bundle at THIS step (`next
# build`), not at runtime — so they must be supplied here, not only in the
# runner's `environment:`. Pass them as build args (docker-compose `build.args`
# or `docker build --build-arg`); each defaults to the same placeholder as
# siteConfig.ts, so an unset arg just bakes the local-dev default. Non-public
# SSH_* settings are read by server.mjs at runtime and do NOT belong here.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_SITE_NAME=SSHWeb
ARG NEXT_PUBLIC_SITE_SHORT_NAME=SSHWeb
ARG NEXT_PUBLIC_SITE_DESCRIPTION=
ARG NEXT_PUBLIC_AUTHOR_NAME=SSHWeb
ARG NEXT_PUBLIC_AUTHOR_URL=http://localhost:3000
ARG NEXT_PUBLIC_SITE_LOCALE=en_US
ARG NEXT_PUBLIC_TERMINAL_USER=user
ARG NEXT_PUBLIC_TERMINAL_HOST=sshweb
ARG NEXT_PUBLIC_ALLOW_INDEXING=true
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SSH_WS_PATH=/api/ssh
ARG NEXT_PUBLIC_SSH_ALLOWED_HOSTS=
ARG NEXT_PUBLIC_SSH_MEDIA_CACHE_MAX_MB=24
# Promote the args to env so `next build` reads them (empty args fall back to
# siteConfig.ts defaults, so exporting an empty string is harmless).
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME \
    NEXT_PUBLIC_SITE_SHORT_NAME=$NEXT_PUBLIC_SITE_SHORT_NAME \
    NEXT_PUBLIC_SITE_DESCRIPTION=$NEXT_PUBLIC_SITE_DESCRIPTION \
    NEXT_PUBLIC_AUTHOR_NAME=$NEXT_PUBLIC_AUTHOR_NAME \
    NEXT_PUBLIC_AUTHOR_URL=$NEXT_PUBLIC_AUTHOR_URL \
    NEXT_PUBLIC_SITE_LOCALE=$NEXT_PUBLIC_SITE_LOCALE \
    NEXT_PUBLIC_TERMINAL_USER=$NEXT_PUBLIC_TERMINAL_USER \
    NEXT_PUBLIC_TERMINAL_HOST=$NEXT_PUBLIC_TERMINAL_HOST \
    NEXT_PUBLIC_ALLOW_INDEXING=$NEXT_PUBLIC_ALLOW_INDEXING \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SSH_WS_PATH=$NEXT_PUBLIC_SSH_WS_PATH \
    NEXT_PUBLIC_SSH_ALLOWED_HOSTS=$NEXT_PUBLIC_SSH_ALLOWED_HOSTS \
    NEXT_PUBLIC_SSH_MEDIA_CACHE_MAX_MB=$NEXT_PUBLIC_SSH_MEDIA_CACHE_MAX_MB

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runner: minimal production image ----------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# ffmpeg powers video grid thumbnails + on-the-fly transcodes (optional but
# recommended); openssh-client provides the `sftp-server` used by the opt-in
# elevated (sudo) file mode. Both degrade gracefully if absent.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Only production deps; `prepare` (husky) is dev-only and no-ops here (see the
# `husky || true` guard in package.json).
RUN npm ci --omit=dev && npm cache clean --force
# Build output + the files the custom server needs at runtime.
COPY --from=builder /app/.next ./.next
COPY public ./public
COPY server.mjs next.config.ts ./
USER node
EXPOSE 3000
# Liveness/readiness against the bridge's own health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
