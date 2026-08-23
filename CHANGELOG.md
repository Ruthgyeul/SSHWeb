# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- MIT `LICENSE`.
- Deployment assets: multi-stage `Dockerfile` (runs `server.mjs`, with a
  `/api/health` `HEALTHCHECK`), `docker-compose.yml` behind a Caddy reverse
  proxy, an nginx example, and a systemd unit sample.
- Observability: per-connection correlation id in logs, `SSH_LOG_LEVEL`
  severity filtering, optional `SSH_AUDIT_LOG` SFTP audit trail, slow-transfer
  logging, build/version metadata on `/api/health`, and a Prometheus
  `/api/metrics` endpoint with an SSH handshake-latency histogram.
- Client error-reporting seam (`NEXT_PUBLIC_SENTRY_DSN`), wired into the error
  boundaries.
- UX: success toasts (saves/downloads), clickable terminal URLs, a
  dangerous-command paste warning, open-tab persistence across reloads, session
  duplicate, and a close-tab guard for busy tabs.
- Performance: large base64 encode/decode offloaded to a Web Worker; dominant-
  color thumbnail placeholders.
- Pre-commit hooks (husky + lint-staged) and a `server.mjs`↔`src/lib`
  mirror-sync guard test; CI uploads a coverage report.

### Changed

- Removed the terminal color-theme presets and the light/system theme toggle;
  SSHWeb now uses a single fixed dark theme.
- Numerous bridge limits are now env-tunable (stream chunk size, WS backpressure
  watermarks, search/grep caps, ffmpeg timeout, keepalive interval, per-session
  transfer cap, preview/transcode concurrency).

### Fixed

- FileBrowser re-derivations are memoized and the post-op directory re-list is
  debounced (fewer re-renders/re-lists on large directories).
- Capacity check no longer races the async SSRF lookup.

### Security

- SSRF guard pins the vetted resolved IP (closes a DNS-rebinding TOCTOU).
- Per-IP cap + rate-limit on unauthenticated WebSocket upgrades.
- Client IP is read from the right-most (proxy-appended) `X-Forwarded-For` hop
  (`SSH_TRUSTED_PROXY_HOPS`), not the spoofable left-most one.
- `/api/health` and `/api/metrics` details are gated behind the access token
  when one is configured.
- Optional SSH algorithm allowlists (`SSH_*_ALGORITHMS`).
- Bounded ZIP enumeration, per-session transfers, and live-transcode output.

## [2.0.0]

- Baseline release prior to the project-review improvement series above.
