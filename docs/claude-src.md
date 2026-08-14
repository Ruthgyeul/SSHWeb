# src/ — source layout

Scoped guidance for the application source. See
[`claude-project.md`](claude-project.md) for the project-wide picture.

```
src/
├── app/                 # Next.js App Router: routes, layout, metadata routes
│   ├── layout.tsx       # root layout — metadata + JSON-LD (server component)
│   ├── page.tsx         # ★ home = the SSH client (renders <SshClient/>)
│   ├── globals?          -> styles live in src/styles/globals.css
│   ├── error.tsx        # route error boundary (500)  ["use client"]
│   ├── global-error.tsx # root error boundary          ["use client"]
│   ├── not-found.tsx    # 404                           ["use client"]
│   ├── loading.tsx      # route loading UI
│   ├── robots.ts        # /robots.txt   (env-gated indexing)
│   ├── sitemap.ts       # /sitemap.xml
│   ├── manifest.ts      # /manifest.webmanifest (PWA)
│   ├── opengraph-image.tsx  # /opengraph-image (dynamic)
│   └── twitter-image.tsx    # /twitter-image (dynamic)
├── components/          # reusable UI (see docs/claude-components.md)
│   └── ssh/             # web SSH client UI (client components), plus:
│       ├── hooks/       #   co-located hooks (useFileSort, useFileViewMode,
│       │                #     useSnippets, useTerminalPrefs, useThumbnailQueue,
│       │                #     useUploadQueue, useReconnect, useSshSocket,
│       │                #     useConnectionProfiles, useImageTransform,
│       │                #     useTextFind, usePreviewKeyboard)
│       ├── preview/     #   FilePreview view components (PreviewMedia, PreviewFilmstrip)
│       └── dom/         #   DOM helpers (download.ts, dropUpload.ts)
├── config/
│   └── siteConfig.ts    # ★ all env-driven site identity — single source
├── lib/                 # pure, DOM-free logic (unit-tested under src/test/)
│   ├── theme.ts         # palette as TS tokens (OG image only)
│   ├── og.tsx           # shared OG/Twitter image renderer
│   ├── sshProtocol.ts   # web-SSH wire types + pure helpers
│   ├── serverSecurity.ts # origin check / rate limiter / IP + upload cap (mirrored in server.mjs)
│   ├── thumbnailCache.ts # thumbnail cache key + LRU-eviction (mirrored in server.mjs)
│   ├── byteLruCache.ts  # generic byte-bounded TTL LRU (browser preview cache)
│   ├── bytes.ts         # pure base64 ↔ byte helpers (web-SSH data plane)
│   ├── connections.ts   # multi-tab "same server" quick-connect label + dedup
│   ├── connectionProfiles.ts # saved recent-host profiles (identity only, no secret)
│   ├── concurrencyLimiter.ts # async concurrency cap (mirrored in server.mjs)
│   ├── zip.ts           # streaming store-only ZIP records + CRC (mirrored in server.mjs)

│   ├── editorSearch.ts  # find/replace match logic (editor + text preview)
│   ├── knownHosts.ts    # TOFU known-hosts parse/compare (localStorage)
│   ├── markdown.ts      # Markdown → sanitized HTML (preview)
│   ├── subtitles.ts     # sidecar subtitle discovery + SRT→VTT
│   ├── syntaxHighlight.ts # lightweight syntax highlighting
│   ├── terminalTheme.ts # terminal color-theme presets
│   └── utils.ts         # cn() classname helper + toJsonLd
├── styles/
│   └── globals.css      # Tailwind import + @theme palette + terminal utilities
└── test/                # ★ Vitest tests, import subjects via "@/…"
    ├── *.test.ts        #   unit tests of pure lib logic (`npm test`)
    ├── *.integration.test.mjs # end-to-end bridge smoke test (`npm run test:integration`)
    └── helpers/         #   shared test fixtures (e.g. the in-memory ssh2 target)
```

## Rules of thumb

- **Read identity from `config/siteConfig.ts`**, never hardcode URLs/names.
- **Server components by default.** Add `"use client"` only for browser APIs or
  interactivity.
- **Colors come from Tailwind `term-*` tokens** (defined in `styles/globals.css`).
  The only raw-hex source is `lib/theme.ts`, kept in sync for the OG renderer.
- **Tests** live under `src/test/` as `*.test.ts` and run under Vitest
  (`node` environment — no DOM). Import the subject via the `@/…` alias (e.g.
  `@/lib/utils`), not a relative path. Add tests for pure logic in `lib/`.
  **Component tests** render real UI with `@testing-library/react`: name them
  `*.test.tsx` and opt into a DOM with a `// @vitest-environment jsdom` docblock
  at the top (the suite default stays `node` so pure-logic tests stay fast);
  jest-dom matchers are registered globally via `src/test/setup.dom.ts`. The
  separate end-to-end bridge smoke test (`*.integration.test.mjs`, run via
  `npm run test:integration`) boots the real `server.mjs` against an in-memory
  ssh2 target; it's excluded from the fast `npm test` (which globs only
  `*.test.ts`/`*.test.tsx`) so the unit suite never starts a server.
- **New route** → also register it in `app/sitemap.ts` and export page
  `metadata`.
