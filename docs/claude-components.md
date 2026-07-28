# src/components/ — UI components

Reusable presentational building blocks. Keep them small, typed, and (by
default) server components.

## What's here

| Component          | Purpose                                                        | Client? |
| ------------------ | ------------------------------------------------------------- | ------- |
| `TerminalBar`      | Sticky top bar with window chrome + shell label, optional git chip | no |
| `TerminalWindow`   | Framed "terminal window" card (traffic lights + title + body) | no      |
| `PromptLabel`      | The `user@host:~$` shell prefix — single source of truth reused by the below | no |
| `Prompt`           | A single `user@host:~$ <command>` shell line, optional cursor | no      |
| `Terminal`         | Interactive fake shell (type a command, get output); logic in `lib/terminal.ts` | **yes** |
| `ErrorScreen`      | Shared terminal error layout used by 404 / 500 / global-error | no      |
| `LoadingScreen`    | Shared terminal loading layout used by `loading.tsx` (`fullScreen` toggles embed mode) | no |

## Conventions

- **Typed props, no `any`.** Prefer explicit prop interfaces; accept
  `className` where a parent might need to adjust layout.
- **Style with Tailwind `term-*` tokens** (`bg-term-card`, `text-term-accent`,
  `border-term-border`). Don't hardcode hex — the palette is defined once in
  `src/styles/globals.css`.
- **Compose class names with `cn()`** from `@/lib/utils` so conditional classes
  stay clean.
- **Server component by default.** Add `"use client"` only when the component
  needs state, effects, or browser APIs. `TerminalBar`/`TerminalWindow`/`Prompt`
  are all server-safe.
- **Identity from config.** `Prompt`/`TerminalBar` read the shell `user@host`
  from `siteConfig` (env-driven) — follow that pattern instead of literals.

## Adding a component

1. Create `MyThing.tsx` exporting a named function component.
2. Type its props; take `className?` if it will be laid out by callers.
3. Use `term-*` utilities for color and `cn()` for conditional classes.
4. If it has non-trivial pure logic, extract it to `src/lib` and unit-test it.
