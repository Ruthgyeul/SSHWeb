# TerminalWebTemplate

A terminal-styled **Next.js** website template. Fork it to start a new web
project that already ships with SEO, error pages, PWA metadata, a small design
system, and environment-driven configuration.

<p align="center">
  <code>guest@example:~$</code> <em>a clean starting point for terminal-aesthetic sites</em>
</p>

## Features

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

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `npm run dev`       | Start the dev server                 |
| `npm run build`     | Production build (fails on TS errors)|
| `npm run start`     | Serve the production build           |
| `npm run lint`      | ESLint                               |
| `npm run typecheck` | `tsc --noEmit`                       |
| `npm run test`      | Vitest (run once)                    |

## Project structure

```
src/
├── app/         # routes, layout, metadata routes (robots/sitemap/manifest/OG)
├── components/  # TerminalBar, TerminalWindow, Prompt, ErrorScreen
├── config/      # siteConfig.ts — env-driven identity (single source of truth)
├── lib/         # theme tokens, OG image renderer, utils
└── styles/      # globals.css — Tailwind import + palette + terminal utilities
public/          # favicon.svg (source logo) + generated icons
```

## Customizing the look

The whole palette is defined once — in the `@theme` block of
[`src/styles/globals.css`](src/styles/globals.css) (mirrored in
[`src/lib/theme.ts`](src/lib/theme.ts) for the OG image renderer). Change the
`--color-term-*` tokens there and the entire site follows.

## Deployment

Standard Next.js. `npm run build && npm run start` behind a reverse proxy, or
deploy to any Node host / platform that supports Next.js 16. The security
headers and CSP in `next.config.ts` are applied by the Node server, so run it
with `next start` (not a static export) to keep them.

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
