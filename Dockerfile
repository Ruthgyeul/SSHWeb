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
