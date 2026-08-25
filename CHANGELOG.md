# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Conventional Commits](https://www.conventionalcommits.org/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- SFTP/UX features: transfer throughput + ETA on progress rows, a hex-view
  toggle in the text preview, "open terminal here" (cd the shell to the browsed
  folder), recursive chmod, opt-in desktop notifications on an unexpected
  disconnect, remote disk usage (df), and a two-file diff view.
- File-browser UX: always-on Size/Perms/Owner/Modified columns (Owner parsed
  from the SFTP long name), hidden (dotfile) entries always shown, and spacebar
  quicklook.
- Reorganized file-browser toolbar: a path row (parent-up · breadcrumb with
  Refresh inside it · copy-path / go-to / search on the right) and an actions
  row (list/grid + sudo on the left; open-terminal · df · New · Upload on the
  right). Clicking go-to turns the path box into an editable field (Enter to
  jump); a normal breadcrumb click still navigates.
- Merged toolbar actions: a single **New** button creates a file, or a folder
  when the name ends with `/`; a single **Upload** button picks files or a
  folder from one menu.
- Clearer, unified toolbar/row iconography (inline SVGs for open-terminal, df,
  copy-path, go-to-path, new, upload, sudo, and the row
  edit/move/chmod/download/delete actions).
- Live-follow (tail -f) for text previews, and first-page PDF thumbnails in the
  grid (when the bridge's `sharp` has PDF support).
- Resumable downloads and a concurrency-limited download queue: plain file
  downloads stream through a client queue (only a few at a time; the rest show
  *queued*), and a download interrupted by a dropped connection auto-resumes
  from its byte offset on reconnect (or via a Resume button) — the download
  mirror of the existing upload-resume path.
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
  dangerous-command paste warning, open-tab persistence across reloads, and a
  close-tab guard for busy tabs.
- Performance: large base64 encode/decode offloaded to a Web Worker; dominant-
  color thumbnail placeholders.
- Pre-commit hooks (husky + lint-staged) and a `server.mjs`↔`src/lib`
  mirror-sync guard test; CI uploads a coverage report.
- Test backfill: end-to-end security-gate integration tests (access token,
  origin, rate limit, allowlist, SSRF, capacity, idle timeout, graceful
  shutdown, private-key + keyboard-interactive auth), a credential-leak
  redaction assertion, and component/hook tests for `FileBrowser`, `FileEditor`,
  and `useConnectionProfiles`.

### Changed

- Removed the terminal color-theme presets and the light/system theme toggle;
  SSHWeb now uses a single fixed dark theme.
- Refactor: the inline-editor state moved out of `SshSession` into a `useEditors`
  hook, and the file browser's list/grid views now share one row-open helper.
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
