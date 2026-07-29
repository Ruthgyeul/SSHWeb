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
│   └── ssh/             # web SSH client UI (client components)
├── config/
│   └── siteConfig.ts    # ★ all env-driven site identity — single source
├── lib/
│   ├── theme.ts         # palette as TS tokens (OG image only)
│   ├── og.tsx           # shared OG/Twitter image renderer
│   ├── sshProtocol.ts   # web-SSH wire types + pure helpers (+ .test.ts)
│   ├── serverSecurity.ts # origin check / rate limiter / IP + upload cap (mirrored in server.mjs, + .test.ts)
│   └── utils.ts         # cn() classname helper (+ utils.test.ts)
└── styles/
    └── globals.css      # Tailwind import + @theme palette + terminal utilities
```

## Rules of thumb

- **Read identity from `config/siteConfig.ts`**, never hardcode URLs/names.
- **Server components by default.** Add `"use client"` only for browser APIs or
  interactivity.
- **Colors come from Tailwind `term-*` tokens** (defined in `styles/globals.css`).
  The only raw-hex source is `lib/theme.ts`, kept in sync for the OG renderer.
- **Tests** live next to their subject as `*.test.ts` and run under Vitest
  (`node` environment — no DOM). Add tests for pure logic in `lib/`.
- **New route** → also register it in `app/sitemap.ts` and export page
  `metadata`.
