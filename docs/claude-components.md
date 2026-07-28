# src/components/ — UI components

Reusable presentational building blocks. Keep them small, typed, and (by
default) server components.

## What's here

| Component          | Purpose                                                        | Client? |
| ------------------ | ------------------------------------------------------------- | ------- |
| `TerminalBar`      | Sticky top bar with window chrome + shell label, optional git chip | no |
| `PromptLabel`      | The `user@host:~$` shell prefix — single source of truth for the prompt prefix | no |
| `ErrorScreen`      | Shared terminal error layout used by 404 / 500 / global-error | no      |
| `LoadingScreen`    | Shared terminal loading layout used by `loading.tsx` (`fullScreen` toggles embed mode) | no |

### `ssh/` — web SSH client (all client components)

The home route's UI. These are interactive by nature, so they opt into
`"use client"`. Wire-protocol types + pure helpers live in
[`src/lib/sshProtocol.ts`](../src/lib/sshProtocol.ts) (unit-tested); the bridge
that actually talks SSH is [`server.mjs`](../server.mjs).

| Component     | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `SshClient`   | Orchestrator — owns the single WebSocket and coordinates the pieces     |
| `ConnectForm` | Host/port/user + password-or-key login (validated via `sshProtocol`)    |
| `XtermView`   | xterm.js wrapper; xterm is dynamically imported (never during SSR)      |
| `FileBrowser` | SFTP listing with navigate / upload / download / delete / mkdir         |

## Conventions

- **Typed props, no `any`.** Prefer explicit prop interfaces; accept
  `className` where a parent might need to adjust layout.
- **Style with Tailwind `term-*` tokens** (`bg-term-card`, `text-term-accent`,
  `border-term-border`). Don't hardcode hex — the palette is defined once in
  `src/styles/globals.css`.
- **Compose class names with `cn()`** from `@/lib/utils` so conditional classes
  stay clean.
- **Server component by default.** Add `"use client"` only when the component
  needs state, effects, or browser APIs. `TerminalBar`/`PromptLabel`/`ErrorScreen`
  are all server-safe; everything under `ssh/` is a client component.
- **Identity from config.** `PromptLabel`/`TerminalBar` read the shell `user@host`
  from `siteConfig` (env-driven) — follow that pattern instead of literals.

## Adding a component

1. Create `MyThing.tsx` exporting a named function component.
2. Type its props; take `className?` if it will be laid out by callers.
3. Use `term-*` utilities for color and `cn()` for conditional classes.
4. If it has non-trivial pure logic, extract it to `src/lib` and unit-test it.
