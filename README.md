# TerminalWebTemplate

A terminal-styled **Next.js** website template. Fork it to start a new web
project that already ships with SEO, error pages, PWA metadata, a small design
system, and environment-driven configuration.

<p align="center">
  <code>guest@example:~$</code> <em>a clean starting point for terminal-aesthetic sites</em>
</p>

## Features

- **Web SSH client** (`/ssh`) — an in-browser terminal (xterm.js) plus an SFTP
  file browser, backed by a WebSocket ↔ SSH bridge. See
  [Web SSH client](#web-ssh-client) below.
- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** (strict)
- **Tailwind CSS v4** with a terminal palette defined in one place
- **Env-driven config** — rebrand by editing `.env.local`, not source files
- **SEO out of the box** — metadata, JSON-LD, `robots.txt`, `sitemap.xml`
- **Dynamic social cards** — Open Graph & Twitter images generated at request
  time (no committed binaries)
- **Terminal error pages** — styled 404, 500, root error boundary, and loading UI
- **PWA ready** — web manifest, favicon, and generated app icons
- **Hardened by default** — strict CSP and security headers in `next.config.ts`
- **Tested & linted** — Vitest + ESLint + a CI workflow

## Quick start

```bash
# Node 24 (see .nvmrc)
nvm use

npm install
cp .env.example .env.local   # then edit values for your site
npm run dev                  # http://localhost:3000
```

The app runs with placeholder identity (`example.com`) even without a `.env`
file, so you can see it immediately and configure as you go.

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
| `NEXT_PUBLIC_GITHUB_URL`       | Optional GitHub link                            |
| `NEXT_PUBLIC_CONTACT_EMAIL`    | Optional contact email                          |

See [`.env.example`](.env.example) for the full, commented list.

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
├── app/         # routes (incl. /ssh), layout, metadata routes
├── components/  # TerminalBar, TerminalWindow, Prompt, ErrorScreen …
│   └── ssh/     # SshClient, ConnectForm, XtermView, FileBrowser (web SSH UI)
├── config/      # siteConfig.ts — env-driven identity (single source of truth)
├── lib/         # theme tokens, OG renderer, utils, sshProtocol.ts
└── styles/      # globals.css — Tailwind import + palette + terminal utilities
public/          # favicon.svg (source logo) + generated icons
```

## Customizing the look

The whole palette is defined once — in the `@theme` block of
[`src/styles/globals.css`](src/styles/globals.css) (mirrored in
[`src/lib/theme.ts`](src/lib/theme.ts) for the OG image renderer). Change the
`--color-term-*` tokens there and the entire site follows.

## Web SSH client

The route [`/ssh`](src/app/ssh/page.tsx) is a full browser-based SSH client,
inspired by [ssheasy.com](https://ssheasy.com):

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
- **The remote host is still the gatekeeper** — you only get the access your own
  credentials grant, with the host enforcing its own auth and file permissions.
- **`SSH_ALLOWED_HOSTS`** (server-only) optionally restricts which hosts may be
  reached (empty = anywhere). **`SSH_MAX_SESSIONS`** caps concurrent sessions and
  **`SSH_MAX_DOWNLOAD_BYTES`** bounds a single SFTP download.
- The CSP only allows same-origin WebSockets, so a page can reach *this* site's
  relay and nothing else.

> Run it behind HTTPS/TLS in production so credentials and session bytes travel
> over `wss://`, and keep the allowlist tight if the deployment is public.

See the [Web SSH client block in `.env.example`](.env.example) for every knob.

## Deployment

`npm run build && npm run start` behind a reverse proxy, or deploy to any Node
host / platform that supports Next.js 16. Note that `start` runs the custom
[`server.mjs`](server.mjs) (needed for the `/ssh` WebSocket bridge), not
`next start`; the security headers and CSP in `next.config.ts` are applied the
same way. This is **not** compatible with a static export or an edge-only host —
the SSH bridge needs a long-lived Node process. Terminate TLS in front of it so
the SSH WebSocket runs over `wss://`.

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
