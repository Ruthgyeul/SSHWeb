# Project guide

Guidance for Claude Code (and humans) working in this repository. Loaded
automatically via the root `CLAUDE.md`.

## What this is

**SSHWeb** — a browser-based SSH client (inspired by ssheasy.com) built on
**Next.js (App Router)**. The home page is the tool itself: an interactive
terminal to any SSH server plus an SFTP file browser, relayed through a
server-side WebSocket ↔ SSH bridge.

Identity (name, domain, prompt) is env-driven via `src/config/siteConfig.ts`
with SSHWeb defaults — override it in `.env.local` for your deployment. Never
bake a real domain, personal name, or secret into committed files.

## Tech stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** (strict)
- **Tailwind CSS v4** (config-less; theme tokens live in `src/styles/globals.css`)
- **Vitest** for unit tests
- **Node 24** (see `.nvmrc`)

## Commands

```bash
npm run dev        # dev server + SSH bridge via server.mjs (http://localhost:3000)
npm run dev:next   # plain `next dev`, no SSH bridge
npm run build      # production build (fails on type errors)
npm run start      # serve the production build + SSH bridge (server.mjs)
npm run lint       # ESLint (eslint-config-next)
npm run typecheck  # tsc --noEmit
npm run test       # Vitest (run once)
npm run test:watch # Vitest (watch)
```

Before committing, run `npm run lint && npm run typecheck && npm run test`.
CI (`.github/workflows/ci.yml`) runs all of these plus a full build.

## Architecture & conventions

### Configuration is env-driven — this is the core idea

**All site identity flows through `src/config/siteConfig.ts`.** It reads
`NEXT_PUBLIC_*` variables and falls back to `example.*` placeholders. Layout
metadata, `robots.ts`, `sitemap.ts`, `manifest.ts`, and the OG image all import
from it.

- To rebrand this deployment, edit `.env.local` (copy from `.env.example`) — **not** the
  source files.
- When you add a new configurable value, add it to **both** `.env.example`
  (documented, with an `example` default) and `siteConfig.ts`.
- Never hardcode a URL, name, or email in a component or page — read it from
  `siteConfig`.

### The palette lives in two synchronized places

- `src/styles/globals.css` — the `@theme` block defines Tailwind color tokens
  (`term-bg`, `term-accent`, …). Components use these via utilities
  (`bg-term-card`, `text-term-accent`).
- `src/lib/theme.ts` — the same hex values as a TS object, for the **one**
  context that can't read CSS: the OG image generator (`src/lib/og.tsx`), which
  renders in a Satori runtime with no DOM.

If you retune colors, change **both**. Everything else references the tokens.

### Server components by default

Pages and layout components are server components (they prerender to static
HTML). Only opt into `"use client"` when you need browser APIs or interactivity
— currently just the error boundaries (`error.tsx`, `global-error.tsx`) and
`not-found.tsx` (reads `window.location`).

### SEO & metadata

- Global metadata is built in `src/app/layout.tsx` from `siteConfig`, including
  JSON-LD structured data.
- `robots.ts` gates indexing on `NEXT_PUBLIC_ALLOW_INDEXING` — set it to
  `false` on staging so previews don't get indexed.
- `sitemap.ts` lists public routes — extend it as you add pages.
- OG/Twitter images are generated on the fly (no committed binaries) by
  `opengraph-image.tsx` / `twitter-image.tsx` via `src/lib/og.tsx`.

### Error & loading states

`error.tsx` (500), `not-found.tsx` (404), `global-error.tsx` (root boundary),
and `loading.tsx` all share the terminal aesthetic via
`src/components/ErrorScreen.tsx`. `global-error.tsx` is deliberately
self-contained with inline styles because it renders when the root layout /
global CSS may be broken.

### Security headers

`next.config.ts` sets a strict CSP and hardening headers on every response.
When you add a third-party origin (analytics, external API, font CDN), **widen
the relevant CSP directive** there rather than removing the policy.

### Web SSH client — the one stateful surface

The home route (`/`) is a browser SSH client (interactive terminal + SFTP),
modeled on ssheasy.com. A browser can't open a raw SSH socket, so this needs a
**custom Node server**, `server.mjs`, which runs Next.js *and* bridges a
WebSocket to a real `ssh2` connection. Key facts an agent must know:

- **`npm run dev` / `npm run start` run `server.mjs`**, not `next dev` /
  `next start`. `npm run build` is still `next build`. `server.mjs` is plain ESM
  and lives **outside** the TypeScript/Next build (it isn't in `tsconfig`).
- **The wire protocol has two synchronized homes**, like the palette does:
  typed messages + pure helpers in `src/lib/sshProtocol.ts` (imported by the
  client, unit-tested in `sshProtocol.test.ts`), and the matching `t` string
  constants hand-mirrored in `server.mjs`. Change one, change the other.
- **UI is all client components** under `src/components/ssh/` (xterm.js is
  dynamically imported so it never runs during SSR).
- **Security posture:** credentials are relayed to the target host and never
  stored or logged; the remote host enforces its own auth/permissions; host keys
  are checked trust-on-first-use (fingerprint prompt + browser known-hosts) and
  keyboard-interactive/2FA is supported;
  `SSH_ALLOWED_HOSTS`, `SSH_MAX_SESSIONS`, `SSH_MAX_DOWNLOAD_MB` and
  `SSH_MAX_UPLOAD_MB` (server env, read in `server.mjs`, in megabytes; `0` =
  unlimited) gate reachable hosts,
  concurrency and transfer size, while `SSH_RATE_LIMIT_MAX` /
  `SSH_RATE_LIMIT_WINDOW_MS` throttle per-IP connection attempts and
  `SSH_IDLE_TIMEOUT_MS` (0 = off) reaps sessions with no shell/SFTP activity. An
  optional `SSH_ACCESS_TOKEN` gates the whole relay: when set, the browser must
  exchange it for an HttpOnly cookie at `POST /api/access` (the raw token is
  never stored in the cookie — a SHA-256 digest is — nor logged) before a
  WebSocket upgrade is accepted. Local port-forwarding (`ssh -L`) is opt-in via
  `SSH_ALLOW_PORT_FORWARD` and binds loopback-only unless
  `SSH_FORWARD_ALLOW_PUBLIC_BIND` is set. The WebSocket upgrade is origin-checked
  (same-origin by default, or `SSH_ALLOWED_ORIGINS`) to block cross-site
  WebSocket hijacking. The security-critical pure logic (origin check, rate
  limiter, IP resolution, upload accounting + chunk-order check, idle expiry,
  access-token match, cookie parsing, forward-bind policy, WebSocket frame-size
  bound, secure-cookie decision) lives in
  `src/lib/serverSecurity.ts` (unit-tested) and is hand-mirrored in `server.mjs`
  — the same "two synchronized places" discipline as the wire protocol. The
  CSP's `connect-src 'self'` already authorizes the same-origin WebSocket —
  don't widen it for this feature. Ops surfaces: `server.mjs` emits structured,
  credential-free event logs (`SSH_LOG=json|off`), serves a metrics-carrying JSON
  health probe at `GET /api/health`, and shuts down gracefully (drains sessions
  on SIGTERM/SIGINT).

## Assets

- `public/favicon.svg` — the scalable source logo (a `>_` terminal prompt).
- `public/favicon.ico` and `public/icons/*.png` are **generated** from that
  design. If you change the logo, regenerate them (the generator script used is
  not committed; a simple SVG rasterizer or design tool is fine) so the raster
  icons stay in sync.

## When extending SSHWeb

- New page → add a route folder under `src/app`, add it to `sitemap.ts`, give
  it a `metadata` export (title/description).
- New shared UI → put it in `src/components` (see [`claude-components.md`](claude-components.md)).
- New config → `.env.example` + `siteConfig.ts`, then consume from `siteConfig`.
- New SSH/SFTP capability → extend the protocol in `src/lib/sshProtocol.ts`
  **and** its handler in `server.mjs` (keep the two in sync), then wire the UI.
- Keep the discipline: no real domains, personal data, or secrets in committed
  files.
