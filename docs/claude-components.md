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
| `SshClient`   | Multi-session tab manager — mounts one `SshSession` per tab; **double-click a tab to rename it** |
| `SshSession`  | One connection: owns a WebSocket + terminal + files, auto-reconnects; header shows live uptime + latency |
| `ConnectForm` | Host/port/user + password-or-key login (validated via `sshProtocol`)    |
| `XtermView`   | xterm.js wrapper; xterm is dynamically imported (never during SSR)      |
| `MobileKeys`  | On-screen key bar (Esc/Tab/Ctrl/Alt/arrows/Fn/…) for touch devices; Ctrl/Alt are sticky one-shot modifiers |
| `SnippetsBar` | Saved command snippets that inject into the shell (persisted via `useSnippets`) |
| `FileBrowser` | SFTP listing: **clickable breadcrumb path**, navigate, drag-drop upload+progress, streamed download+progress, delete, rename, chmod, mkdir, touch, folder-zip, image/video preview, **in-CWD name filter** (case-insensitive; select-all acts on the filtered rows), **multi-select** (per-row + select-all checkbox → bulk download-as-zip / delete); **double-click opens** an entry by type (dir → navigate, image/video → preview, text → editor, else download) |
| `FileEditor`  | Inline text editor modal: line numbers + lightweight syntax highlighting (`src/lib/syntaxHighlight.ts`), Ctrl/⌘+S to save |
| `FilePreview` | Read-only media preview modal for a remote image (data-URL `<img>`) or video (data-URL `<video controls>`, e.g. mp4/mov/webm) + download |
| `AuthPrompt`  | Modal for host-key (TOFU) confirmation and keyboard-interactive prompts |
| `PasteConfirm` | Confirmation modal shown before a multi-line paste reaches the shell |
| `PromptDialog` | Themed in-app prompt/confirm dialog (replaces `window.prompt`/`confirm` for mkdir/touch/rename/chmod/delete) |
| `ShortcutsHelp` | Modal cheat-sheet of keyboard & pointer shortcuts (opened via the header `?`) |
| `TerminalSettings` | Gear popover: terminal color-theme presets (persisted via `useTerminalPrefs`) |

The terminal also has a built-in **scrollback search** bar (Ctrl/Cmd+F, `@xterm/addon-search`) that lives inside `XtermView`, and a **latency read-out** + **uptime clock** in the session header (latency fed by a `ping`/`pong` round-trip). The terminal color theme is shared across sessions via the `useTerminalPrefs` hook (localStorage-backed); the presets are defined and unit-tested in `src/lib/terminalTheme.ts`. Plain SFTP **downloads stream in chunks** (`sftp-download-begin`/`chunk`/`end`) so the browser can show a progress bar; edit/preview reads still arrive as a single `sftp-read`.

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
