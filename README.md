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
- **Local port forwarding** (`ssh -L`) — tunnel a local port to a host reachable
  from the SSH server (opt-in; loopback-only by default)
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
| `NEXT_PUBLIC_SITE_LOCALE`      | Locale, e.g. `en_US` / `ko_KR`                  |
| `NEXT_PUBLIC_TERMINAL_USER`    | Shell prompt user (cosmetic)                    |
| `NEXT_PUBLIC_TERMINAL_HOST`    | Shell prompt host (cosmetic)                    |
| `NEXT_PUBLIC_ALLOW_INDEXING`   | `false` to block crawlers on staging            |

The SSH bridge has its own (server-only) settings — `SSH_ALLOWED_HOSTS`,
`SSH_MAX_SESSIONS`, `SSH_MAX_DOWNLOAD_MB`, `SSH_MAX_UPLOAD_MB`,
`SSH_RATE_LIMIT_MAX`, `SSH_ALLOWED_ORIGINS`, `SSH_ACCESS_TOKEN`,
`SSH_ALLOW_PORT_FORWARD`, `NEXT_PUBLIC_SSH_WS_PATH` — covered under
[Security](#security). See [`.env.example`](.env.example) for the full,
commented list.

## Scripts

| Command             | Description                                      |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Dev server + SSH bridge (`server.mjs`)           |
| `npm run dev:next`  | Plain `next dev` (no SSH bridge)                 |
| `npm run build`     | Production build (fails on TS errors)            |
| `npm run start`     | Serve the production build + SSH bridge          |
| `npm run lint`      | ESLint                                           |
| `npm run typecheck` | `tsc --noEmit`                                   |
| `npm run test`      | Vitest (run once)                                |

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
- **Local port forwarding is opt-in** (**`SSH_ALLOW_PORT_FORWARD`**) and binds to
  loopback only unless **`SSH_FORWARD_ALLOW_PUBLIC_BIND`** is set, so a tunnel is
  reachable from the relay host and nowhere else by default.

> Run it behind HTTPS/TLS in production so credentials and session bytes travel
> over `wss://`, and keep the allowlist tight if the deployment is public.

See the [Web SSH client block in `.env.example`](.env.example) for every knob.

## Deployment

`npm run build && npm run start` behind a reverse proxy, or deploy to any Node
host / platform that supports Next.js 16. Note that `start` runs the custom
[`server.mjs`](server.mjs) (needed for the SSH WebSocket bridge), **not**
`next start` — running `next start` (e.g. from a service unit) gives you a plain
Next server with no `/api/ssh` bridge, and without a prior `next build` it exits
immediately. The security headers and CSP in `next.config.ts` are applied the
same way. This is **not** compatible with a static export or an edge-only host —
the SSH bridge needs a long-lived Node process. Terminate TLS in front of it so
the SSH WebSocket runs over `wss://`.

To run it as a long-lived Linux service, use the hardened systemd unit template
and step-by-step guide under [`deploy/`](deploy/) — see
[`deploy/README.md`](deploy/README.md) and
[`deploy/SSHWeb.service`](deploy/SSHWeb.service).

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

No license file is included — add one that fits your project before publishing.
