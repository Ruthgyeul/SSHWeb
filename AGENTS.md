# AGENTS.md

Guidance for **any** AI coding agent working in this repository — Claude Code,
Cursor, GitHub Copilot, Codex, Gemini, Aider, and the rest. (Claude Code reads
[`CLAUDE.md`](CLAUDE.md) automatically; this file exists so every other tool gets
the same instructions.)

## Read this first — before you write any code

This project has an opinionated architecture and a fixed set of conventions.
**Read the guidance below in full before planning or changing anything**, and
follow it as you work — it overrides your generic defaults:

1. [`CLAUDE.md`](CLAUDE.md) — the entry point.
2. [`docs/README.md`](docs/README.md) — index of the guides that follow.
3. [`docs/claude-project.md`](docs/claude-project.md) — stack, commands, and the
   core architecture (env-driven config, the palette, server components, SEO,
   security headers).
4. [`docs/claude-src.md`](docs/claude-src.md) — `src/` layout and rules of thumb.
5. [`docs/claude-components.md`](docs/claude-components.md) — `src/components/` UI
   conventions.
6. [`docs/git-workflow.md`](docs/git-workflow.md) — branching and **merge**
   strategy.
7. [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch, commit, PR, and merge rules.

Do not start work until you have read these. When in doubt, the `docs/` guides
are the source of truth; this list is only the map.

## Non-negotiables (the docs explain each in full)

- **Config is env-driven.** All site identity flows through
  [`src/config/siteConfig.ts`](src/config/siteConfig.ts). Never hardcode a URL,
  name, or email — read it from `siteConfig`, and add new values to both
  `.env.example` and `siteConfig.ts`.
- **Colors come from Tailwind `term-*` tokens** defined in
  [`src/styles/globals.css`](src/styles/globals.css) (mirrored in
  [`src/lib/theme.ts`](src/lib/theme.ts) for the OG image only). Don't hardcode
  hex.
- **Server components by default.** Add `"use client"` only for browser APIs or
  interactivity.
- **Placeholder discipline.** This is a template — never commit real domains,
  names, emails, tokens, or secrets. Use `example.com` / "Example Author".
- **Gate before pushing:** `npm run lint && npm run typecheck && npm test && npm run build`.
- **Branch, don't push to `main`.** Open a PR and land it with a **merge commit**
  (not squash) per [`docs/git-workflow.md`](docs/git-workflow.md).
