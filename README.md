# SSHWeb

A **browser-based SSH client**, inspired by [ssheasy.com](https://ssheasy.com):
open an interactive terminal to any SSH server and browse its files over SFTP —
all from a web page. Built with **Next.js** and a terminal-styled design system.

<p align="center">
  <code>user@sshweb:~$</code> <em>SSH from your browser — terminal + files</em>
</p>

## Features

- **Interactive terminal** (xterm.js) attached to a real remote shell
- **On-screen key bar for touch devices** — Esc/Tab/Ctrl/Alt/arrows/Fn keys and
  more; Ctrl/Alt are sticky and combine with the next key you type on the phone
  keyboard (e.g. tap Ctrl then type `c` → `Ctrl+C`)
- **Multiple concurrent sessions** as tabs, each an independent connection
- **Auto-reconnect** — a dropped session retries with backoff, then offers a
  manual "Reconnect" button
- **Password or private-key** authentication (paste a key or load from file,
  with optional passphrase)
- **SFTP file browser** — navigate, drag-and-drop upload with progress
  (drop or pick a whole **folder** and its subdirectories are recreated
  remotely), download, delete, rename, `chmod`, create folders, and whole-folder
  download as a zip
- **Multi-file inline editor** — open several remote files at once as **tabs**,
  each with its own edit buffer, **find/replace**, and an unsaved-changes guard
- **Manage trusted host keys** — the gear popover lists the host keys you've
  accepted (trust-on-first-use) and lets you forget any of them
- **WebSocket ↔ SSH bridge** — a custom Node server (`server.mjs`) relays the
  browser to a real [`ssh2`](https://github.com/mscdex/ssh2) connection
- **Hardened by default** — strict CSP and security headers; credentials are
  relayed to the host and never stored or logged; optional host allowlist,
  session limits, per-IP rate limiting, an optional **idle-session timeout** and
  an optional **shared access key** gating the whole relay; structured
  (credential-free) event logs, a metrics-carrying `/api/health` probe and
  **graceful shutdown** (drains sessions on SIGTERM/SIGINT)
- **Env-driven config** — brand/host/limits via `.env.local`, not source edits
- **Next.js 16** (App Router) · **React 19** · **TypeScript** (strict) ·
  **Tailwind CSS v4**, plus SEO metadata, PWA manifest and Vitest/ESLint/CI

## Quick start

```bash
# Node 24 (see .nvmrc)
nvm use

npm install
cp .env.example .env.local   # optional — sensible defaults work out of the box
npm run dev                  # http://localhost:3000  (runs the SSH bridge too)
```

Open <http://localhost:3000>, enter a host / username / credentials, and connect.
(The port is configurable — set `PORT` in `.env.local`, e.g. `PORT=3000`.)
`npm run dev` and `npm run start` run the custom `server.mjs` (needed for the SSH
WebSocket); see [How it works](#how-it-works) below.

## Configuration

All site identity lives in [`src/config/siteConfig.ts`](src/config/siteConfig.ts)
and is read from `NEXT_PUBLIC_*` environment variables. Copy `.env.example` to
`.env.local` and set:

| Variable                       | What it controls                                |
| ------------------------------ | ----------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`         | Canonical origin (metadata, sitemap, robots)    |
| `NEXT_PUBLIC_SITE_NAME`        | Full site name (title, OG, structured data)     |
| `NEXT_PUBLIC_SITE_SHORT_NAME`  | Short name (PWA label, title suffix)            |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Meta description / social card copy             |
| `NEXT_PUBLIC_AUTHOR_NAME`      | Author / publisher                              |
| `NEXT_PUBLIC_SITE_LOCALE`      | Metadata locale (`<html lang>` + OG); UI stays English |
| `NEXT_PUBLIC_TERMINAL_USER`    | Shell prompt user (cosmetic)                    |
| `NEXT_PUBLIC_TERMINAL_HOST`    | Shell prompt host (cosmetic)                    |
| `NEXT_PUBLIC_ALLOW_INDEXING`   | `false` to block crawlers on staging            |

The SSH bridge has its own (server-only) settings — `SSH_ALLOWED_HOSTS`,
`SSH_MAX_SESSIONS`, `SSH_MAX_DOWNLOAD_MB`, `SSH_MAX_UPLOAD_MB`,
`SSH_RATE_LIMIT_MAX`, `SSH_ALLOWED_ORIGINS`, `SSH_ACCESS_TOKEN`,
`SSH_BLOCK_PRIVATE_HOSTS`, `SSH_AUDIT_LOG`, `SSH_LOG_LEVEL`, and the
`SSH_*_ALGORITHMS` allowlists — covered under [Security](#security). A few
client-side knobs are also env-driven: `NEXT_PUBLIC_SSH_WS_PATH`,
`NEXT_PUBLIC_SSH_ALLOWED_HOSTS` (a public mirror used only for a friendly
pre-connect message), `NEXT_PUBLIC_SSH_MEDIA_CACHE_MAX_MB` (browser media-cache
budget), and `NEXT_PUBLIC_SENTRY_DSN` (optional error reporting). See
[`.env.example`](.env.example) for the full, commented list.

## Scripts

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `npm run dev`              | Dev server + SSH bridge (`server.mjs`)           |
| `npm run dev:next`         | Plain `next dev` (no SSH bridge)                 |
| `npm run build`            | Production build (fails on TS errors)            |
| `npm run start`            | Serve the production build + SSH bridge          |
| `npm run lint`             | ESLint                                           |
| `npm run typecheck`        | `tsc --noEmit`                                   |
| `npm run test`             | Vitest unit tests (run once)                     |
| `npm run test:watch`       | Vitest in watch mode                             |
| `npm run test:coverage`    | Unit tests with the `src/lib` coverage gate      |
| `npm run test:integration` | End-to-end bridge smoke test (vs. an in-memory ssh2 target) |
| `npm run format`           | Prettier (write)                                 |
| `npm run format:check`     | Prettier (check only)                            |

## Project structure

```
server.mjs       # custom Next server + WebSocket ↔ SSH/SFTP bridge (ssh2)
src/
├── app/         # / (the SSH client), layout, metadata routes
├── components/  # TerminalBar, PromptLabel, ErrorScreen, LoadingScreen
│   └── ssh/     # SshClient, ConnectForm, XtermView, FileBrowser (web SSH UI)
├── config/      # siteConfig.ts — env-driven identity (single source of truth)
├── lib/         # theme tokens, OG renderer, utils, sshProtocol.ts (+ tests)
└── styles/      # globals.css — Tailwind import + palette + terminal utilities
public/          # favicon.svg (source logo) + generated icons
```

## Customizing the look

The whole palette is defined once — in the `@theme` block of
[`src/styles/globals.css`](src/styles/globals.css) (mirrored in
[`src/lib/theme.ts`](src/lib/theme.ts) for the OG image renderer). Change the
`--color-term-*` tokens there and the entire UI follows.

## Web SSH client

The home route (`/`, [`src/app/page.tsx`](src/app/page.tsx)) is the client
itself:

- an **interactive terminal** (xterm.js) attached to a real remote shell,
- **password or private-key** authentication (paste a key or load it from a
  file, with optional passphrase),
- an **SFTP file browser** — navigate directories and upload, download, delete
  files or create folders,
- all over a **single WebSocket** to a server-side bridge.

### How it works

A browser can't open a raw SSH socket, so the app ships a **custom Node server**
([`server.mjs`](server.mjs)) that runs Next.js *and* relays a WebSocket to a real
[`ssh2`](https://github.com/mscdex/ssh2) connection:

```
browser ──WebSocket(/api/ssh)──▶ server.mjs ──SSH/SFTP──▶ target host
  xterm.js + file browser          (ssh2)                (your server)
```

Because of this, **`npm run dev` and `npm run start` launch `server.mjs`**, not
`next dev`/`next start` (use `npm run dev:next` if you want the plain Next dev
server without the SSH bridge). `npm run build` is unchanged. The wire protocol
and its pure helpers live in
[`src/lib/sshProtocol.ts`](src/lib/sshProtocol.ts) (unit-tested); `server.mjs`
mirrors the same message names.

### Security

- **Credentials are relayed, never stored or logged.** They exist only for the
  life of the connection, to authenticate to the host you named.
- **Host key verification (trust-on-first-use).** On first connect the server's
  public-key fingerprint is shown for you to confirm; it's remembered in the
  browser and you're warned loudly if it ever changes (possible MITM).
- **Two-factor / keyboard-interactive auth** is supported — servers that require
  an OTP or interactive prompt will ask for it during login.
- **The remote host is still the gatekeeper** — you only get the access your own
  credentials grant, with the host enforcing its own auth and file permissions.
- **`SSH_ALLOWED_HOSTS`** (server-only) optionally restricts which hosts may be
  reached (empty = anywhere). **`SSH_MAX_SESSIONS`** caps concurrent sessions,
  **`SSH_MAX_DOWNLOAD_MB`** / **`SSH_MAX_UPLOAD_MB`** bound a single SFTP
  transfer in megabytes (`0` = unlimited), and **`SSH_RATE_LIMIT_MAX`** /
  **`SSH_RATE_LIMIT_WINDOW_MS`** throttle
  per-IP connection attempts so the bridge can't be used as a brute-force relay.
- **The WebSocket upgrade is origin-checked** (same-origin by default, or an
  explicit **`SSH_ALLOWED_ORIGINS`** allowlist) to block cross-site WebSocket
  hijacking. The CSP also only allows same-origin WebSockets, so a page can reach
  *this* site's relay and nothing else.
- **An optional shared access key** (**`SSH_ACCESS_TOKEN`**) gates the relay
  itself: when set, the browser must present it (a one-time prompt, exchanged for
  an HttpOnly cookie at `POST /api/access`) before any WebSocket upgrade is
  accepted. The raw token is never stored in the cookie or logged.

> Run it behind HTTPS/TLS in production so credentials and session bytes travel
> over `wss://`, and keep the allowlist tight if the deployment is public.

See the [Web SSH client block in `.env.example`](.env.example) for every knob.

## Deployment

SSHWeb needs a **long-lived Node process** running the custom
[`server.mjs`](server.mjs) (the SSH WebSocket bridge) behind a TLS-terminating
reverse proxy — it is **not** compatible with a static export or an edge-only
host. Whatever you run, run `server.mjs`, **not** `next start`: `next start`
serves the pages but omits the `/api/ssh` bridge, so the terminal and SFTP
silently fail. Terminate TLS in front so the WebSocket runs over `wss://`.

### Docker (recommended)

A multi-stage [`Dockerfile`](Dockerfile) builds the app and runs `server.mjs`
(with a `HEALTHCHECK` on `/api/health`), and [`docker-compose.yml`](docker-compose.yml)
wires it behind a [Caddy](deploy/Caddyfile) reverse proxy that auto-provisions
HTTPS and forwards the WebSocket upgrade:

```bash
# set SSHWEB_DOMAIN / NEXT_PUBLIC_SITE_URL (and any SSH_* knobs) in the compose file or a .env
docker compose up -d --build
```

Only Caddy is published (:80/:443); the app stays on the internal network.
Caddy preserves the client `Host` (same-origin WebSocket check), appends the
real client IP to `X-Forwarded-For`, and sets `X-Forwarded-Proto` so the access
cookie is flagged `Secure`.

> **`NEXT_PUBLIC_*` are baked at build time, not runtime.** They are inlined
> into the client bundle when `next build` runs, so the public identity
> (`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SITE_NAME`, …) is passed to the image as
> **build args** — the compose file forwards `NEXT_PUBLIC_SITE_URL` /
> `NEXT_PUBLIC_AUTHOR_URL` via `build.args`, and the `Dockerfile` accepts the
> full set (add more `--build-arg`s or `build.args` entries as needed). Changing
> any of them requires a rebuild (`--build`); putting them only in the runtime
> `environment:` has no effect on the already-built pages. Server-only `SSH_*`
> settings, by contrast, are read at runtime and belong in `environment:`.

### Without Docker

Because `NEXT_PUBLIC_*` values are inlined at build time, source your
configuration **before** building:

```bash
set -a && . /etc/sshweb.env && set +a   # export NEXT_PUBLIC_* for the build
npm ci && npm run build
```

Then run `server.mjs` under a process manager. A sample systemd unit is in
[`deploy/sshweb.service`](deploy/sshweb.service) (drops privileges, hardens the
sandbox, drains sessions on `SIGTERM`; it loads the same env file at runtime for
the server-only `SSH_*` settings). Front it with a reverse proxy that forwards
the WebSocket upgrade — an nginx example is in
[`deploy/nginx.conf.example`](deploy/nginx.conf.example). The security headers
and CSP in `next.config.ts` apply the same way.

## Contributing

Branch, commit, PR and merge conventions live in
[`CONTRIBUTING.md`](CONTRIBUTING.md). In short: branch off `main` as
`feat/…`·`fix/…`·`docs/…`, use [Conventional Commits](https://www.conventionalcommits.org/),
and merge green PRs with a merge commit. Issue and PR templates are under `.github/`.

## Working with AI agents

This repo keeps its AI/contributor guidance under [`docs/`](docs/) —
[`claude-project.md`](docs/claude-project.md) (project-wide),
[`claude-src.md`](docs/claude-src.md) (`src/`), and
[`claude-components.md`](docs/claude-components.md) (`src/components/`). **Any AI
agent (or contributor) should read these before starting work.** The root
[`CLAUDE.md`](CLAUDE.md) imports them so Claude Code loads the context
automatically; every other tool (Cursor, Copilot, Codex, …) is pointed at the
same guidance by [`AGENTS.md`](AGENTS.md).

## License

Released under the [MIT License](LICENSE).
