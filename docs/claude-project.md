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
npm run test       # Vitest unit tests (run once)
npm run test:watch # Vitest (watch)
npm run test:integration # end-to-end bridge smoke test (boots server.mjs vs. an in-memory ssh2 target)
```

Before committing, run `npm run lint && npm run typecheck && npm run test`.
CI (`.github/workflows/ci.yml`) runs all of these plus a full build **and**
`npm run test:integration` (after the build, so it exercises the production server).

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
  constants hand-mirrored in `server.mjs`. Change one, change the other. This
  includes the per-message required-field table (`CLIENT_MESSAGE_FIELDS` /
  `isValidClientMessage`) the bridge validates every incoming frame against
  before dispatch — add a new client message and you extend that table in both
  places. The bridge also runs a global `uncaughtException`/`unhandledRejection`
  guard plus a try/catch around message dispatch, so one malformed or
  unexpected frame degrades to a logged error on that session instead of
  crashing the single shared process and dropping every connection.
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
  WebSocket upgrade is accepted. Elevated (sudo) file access is opt-in
  via `SSH_ALLOW_SUDO`: when enabled, the file browser's `sudo` toggle routes
  SFTP through an `sftp-server` launched under `sudo` over an exec channel (the
  SFTP counterpart to `sudo su`), so file ops run as root — the target's sudoers
  policy still governs whether it succeeds, and an optional sudo password is fed
  to `sudo -S` on stdin (never interpolated into the command, never logged), with
  passwordless `sudo -n` used when none is given (`SSH_SFTP_SERVER_PATHS`
  overrides where `sftp-server` is found). The WebSocket upgrade is origin-checked
  (same-origin by default, or `SSH_ALLOWED_ORIGINS`) to block cross-site
  WebSocket hijacking. The security-critical pure logic (origin check, rate
  limiter, IP resolution, upload accounting + chunk-order check, idle expiry,
  access-token match, cookie parsing, WebSocket frame-size
  bound, secure-cookie decision, sudo-sftp command builder) lives in
  `src/lib/serverSecurity.ts` (unit-tested) and is hand-mirrored in `server.mjs`
  — the same "two synchronized places" discipline as the wire protocol. The
  CSP's `connect-src 'self'` already authorizes the same-origin WebSocket —
  don't widen it for this feature. Video **and audio** previews stream over a
  same-origin **HTTP Range endpoint** (`GET /api/preview`) so `<video>`/`<audio>`
  seek and start instantly without buffering the whole clip: it's gated by the
  same access cookie as the upgrade **and** an unguessable per-session capability
  token (minted on SSH-ready, sent in `caps.streamToken`, revoked on cleanup)
  that scopes a request to that one session's login-user SFTP — files its own
  WebSocket could already read — with a single response bounded by
  `STREAM_MAX_CHUNK_BYTES` and a hardened `default-src 'none'; sandbox` CSP on the
  media bytes; the existing `media-src 'self'` already authorizes it, so don't
  widen the CSP. A container/codec the browser can't play natively (e.g.
  `.avi`/`.wmv`/`.flv`/`.ts` — `videoNeedsTranscode` in `sshProtocol.ts`) is
  **transcoded on the fly** by the same endpoint (`?transcode=1`): the bridge
  pipes the source through `ffmpeg` to fragmented MP4 (H.264/AAC,
  `-movflags frag_keyframe+empty_moov+faststart`) and streams it progressively so
  it plays without the client ever downloading it — CPU-capped by
  `SSH_MAX_TRANSCODES` (each spawn killed when the viewer navigates away), and a
  natively-playable clip whose codec turns out unplayable falls back to the same
  transcode on a `<video>` error. **Small, natively-playable clips are fetched
  whole and cached in memory instead of streamed** (bounded by the smaller of
  `MEDIA_CACHE_MAX_BYTES` and the bridge's download cap, advertised in
  `caps.maxDownloadBytes`) so stepping the gallery away and back re-opens them
  instantly and fully seekable — memory-only, dropped on logout. **Image previews
  are downscaled to a compact preview transcode for viewing**: clicking a photo
  opens a `sharp`-resized image (`PREVIEW_IMAGE_MAX_DIM`, mirrored from
  `sshProtocol.ts`) in a format chosen per-deployment via `SSH_PREVIEW_IMAGE_FORMAT`
  — `webp-lossy` (default; fastest to open, visually indistinguishable at the
  preview resolution), `webp-lossless` (pixel-exact but larger/slower), or `avif`
  (smallest wire size, slowest CPU encode), tuned by `SSH_PREVIEW_IMAGE_QUALITY` —
  that crosses the wire far smaller than the multi-MB original, which even lets a
  photo too large to download whole preview cheaply (bounded by
  `PREVIEW_IMAGE_SOURCE_MAX_BYTES` decode memory). **Zooming in (or a "load
  original" button) pulls the full-resolution original on demand** so zoomed
  detail is pixel-perfect, and an explicit **Download** always fetches the
  untouched original. **HEIC/HEIF (iPhone) photos**, which browsers can't render
  raw, are *only* ever shown as this transcode (never streamed raw), previewing
  and thumbnailing like any other image when `sharp` has HEIF support (else they
  degrade to the download-only card). The original is only read, never modified;
  SVG/GIF and images under `PREVIEW_IMAGE_MIN_BYTES` stream as-is, and when
  `sharp` can't decode the bytes (or a lossy transcode wouldn't be smaller — for
  a browser-renderable format) the bridge streams the original instead. Ops surfaces: `server.mjs` emits structured,
  credential-free event logs (`SSH_LOG=json|off`), serves a metrics-carrying JSON
  health probe at `GET /api/health` (session counts, cumulative shell bytes, an
  `sftp` block of file-transfer volume — completed uploads/downloads + bytes —
  and a `thumbnails` block of WebP tiles served/skipped + bytes plus the
  server-side cache's hits/entries/bytes, and a `transcodes` block of live video
  transcodes + the per-process ceiling), and shuts down
  gracefully (drains sessions on SIGTERM/SIGINT). Grid thumbnails are **always** served as a tiny WebP and
  nothing else: images are downscaled in-memory with `sharp`
  (`THUMBNAIL_PIXELS`, mirrored from `sshProtocol.ts`) before being sent — the
  original file is only read, never modified — and video tiles get a poster
  frame extracted by `ffmpeg` (piped to ffmpeg on stdin, with a short-lived temp
  file as a seekable fallback for MP4/MOV whose `moov` atom sits at the end — most
  phone recordings — which a non-seekable pipe can't decode; the temp file is
  deleted immediately) and downscaled to WebP the same way, so a folder of photos
  or videos sends KB per tile instead of whole files. A full-size original is
  **never** sent as a thumbnail: `sharp` is therefore required for thumbnails
  (and `ffmpeg` for video tiles) — when either is missing, or the bytes can't
  be decoded, the bridge skips that tile (an empty `thumb` reply → the client
  keeps its type icon) instead of falling back to the original bytes. **The
  finished WebP tiles are cached on the bridge, not the browser**: an in-memory
  LRU cache (`SSH_THUMB_CACHE_MB`, default 128 MB; `0` disables) keyed by
  identity (`user@host`, or `user@host#root` for an elevated read) + path +
  `size:mtime` serves a re-visited folder — or a fresh re-login — with **no SSH
  read and no transcode**, so grids paint as fast as the bytes send; the pure key
  + LRU-eviction logic lives in `src/lib/thumbnailCache.ts` and is hand-mirrored
  in `server.mjs` (the same "two synchronized places" discipline). The tile bytes
  are never written to disk, and a tile unused for `SSH_THUMB_CACHE_TTL_MS`
  (default 30 min; `0` = never expire) is dropped so decoded copies of your files
  don't linger in shared process memory indefinitely — a confidentiality knob for
  a multi-tenant deploy, while a re-login within the window still reuses tiles for
  free. **Elevated (root) reads are cached too** — isolated under the `#root`
  scope so they never mix with login-user tiles. The client concurrency-limits
  thumbnail reads (serving tiles currently in the viewport first) and holds tiles
  **in memory only** — so **logging out immediately drops every cached thumbnail,
  preview blob and stream token from the browser** (no on-disk copy lingers,
  nothing stays downloadable), while the server keeps its cache for the next
  login. The settings popover shows how much media cache this browser is holding
  and a **"Clear cache"** action drops the browser's in-memory thumbnails and
  previews and sends a `thumb-purge` that evicts this connection's tiles
  (login-user **and** `#root`) from the server cache.

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
