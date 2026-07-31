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
| `SshSession`  | One connection: owns a WebSocket + terminal + files, auto-reconnects; header shows live uptime + latency (status widgets live in `SessionStatus`) |
| `SessionStatus` | The header/tab status widgets — `StatusDot`, `Uptime` clock, `LatencyChip` — plus the `SessionStatus` union type, shared by `SshSession` and `SshClient` |
| `ConnectForm` | Host/port/user + password-or-key login (validated via `sshProtocol`)    |
| `XtermView`   | xterm.js wrapper; xterm is dynamically imported (never during SSR)      |
| `MobileKeys`  | On-screen key bar (Esc/Tab/Ctrl/Alt/arrows/Fn/…) for touch devices; Ctrl/Alt are sticky one-shot modifiers |
| `SnippetsBar` | Saved command snippets that inject into the shell (persisted via `useSnippets`) |
| `FileBrowser` | SFTP listing with a **list / grid layout toggle** (persisted via `useFileViewMode`): the grid view shows large type icons and **lazily-loaded image thumbnails** (small images are fetched whole via a `thumb` `sftp-read` when the tile scrolls into view — gated by `isThumbnailable`/`THUMBNAIL_MAX_BYTES` in `sshProtocol`, cached per-path in `SshSession`). Also: **clickable breadcrumb path**, navigate, drag-drop upload+progress, **folder upload** (drop a directory or use "↑ folder" — subdirectories are recreated remotely via a `mkdirp` flag on the opening chunk), streamed download+progress, delete, rename, chmod, mkdir, touch, folder-zip, image/video preview, **in-CWD name filter** (case-insensitive; select-all acts on the filtered rows), **multi-select** (per-row + select-all checkbox → bulk download-as-zip / delete); **double-click opens** an entry by type (dir → navigate, image/video → preview, editable → editor, else download); an opt-in **`sudo` toggle** (shown only when the server sets `SSH_ALLOW_SUDO`) that routes every SFTP op through a root `sftp-server` so unreadable files become browsable/editable — the SFTP counterpart to `sudo su` (prompts for an optional sudo password; a banner marks the elevated session) |
| `FileEditor`  | Inline text editor modal with **multiple open files as tabs** (each keeps its own edit buffer; switching tabs never loses unsaved work) and an **unsaved-changes guard** (in-app "discard?" confirm on close + a `beforeunload` warning). Line numbers + lightweight syntax highlighting (`src/lib/syntaxHighlight.ts`), Ctrl/⌘+S to save, **find/replace bar** (Ctrl/⌘+F; Enter / Shift+Enter step matches, replace one / all, case toggle — pure logic in `src/lib/editorSearch.ts`). Opens like `vi`/`nano` — any file that isn't previewable media or a known binary (via `isProbablyTextFile`/`isProbablyBinaryFile` in `sshProtocol`), so config files, dotfiles (`.env*`, systemd units, nginx configs), and extensionless files all edit inline |
| `Tunnels`     | The **tunnels** tab: open and manage local port-forwards (`ssh -L`) — the bridge listens on a local port and tunnels connections to a host reached from the SSH server. Validated via `validateForward` (`sshProtocol`); server-gated by `SSH_ALLOW_PORT_FORWARD` (loopback-only bind by default) |
| `AccessGate`  | Wraps the app with the optional relay access gate: probes `GET /api/access`, and when a shared `SSH_ACCESS_TOKEN` is configured shows a one-time access-key prompt that `POST`s for the HttpOnly cookie before revealing `SshClient` |
| `FilePreview` | Read-only media preview modal for a remote image (data-URL `<img>`) or video (data-URL `<video controls>`, e.g. mp4/mov/webm) + download |
| `AuthPrompt`  | Modal for host-key (TOFU) confirmation and keyboard-interactive prompts |
| `PasteConfirm` | Confirmation modal shown before a multi-line paste reaches the shell |
| `PromptDialog` | Themed in-app prompt/confirm dialog (replaces `window.prompt`/`confirm` for mkdir/touch/rename/chmod/delete) |
| `ShortcutsHelp` | Modal cheat-sheet of keyboard & pointer shortcuts (opened via the header `?`) |
| `TerminalSettings` | Gear popover: terminal color-theme presets (persisted via `useTerminalPrefs`) + **trusted host-key management** (lists the TOFU fingerprints from `localStorage` and lets you forget any; helpers in `src/lib/knownHosts.ts`) |
| `Toast` (`ToastStack` + `useToasts`) | Transient error/notice toasts so a failed action is never silent — every bridge `error` frame (over-cap upload/download, rejected chmod/rename/mkdir, capacity/rate-limit) plus `forward-error` and clipboard failures surface here while connected. Sits at `z-50` above every tab and modal; messages are shown verbatim from the (deliberately short, credential-free) server text, clamped by the pure `clampToastMessage` (unit-tested in `Toast.test.ts`) |

The terminal also has a built-in **scrollback search** bar (Ctrl/Cmd+F, `@xterm/addon-search`) that lives inside `XtermView`, and a **latency read-out** + **uptime clock** in the session header (latency fed by a `ping`/`pong` round-trip). The terminal color theme is shared across sessions via the `useTerminalPrefs` hook (localStorage-backed); the presets are defined and unit-tested in `src/lib/terminalTheme.ts`. Plain SFTP **downloads stream in chunks** (`sftp-download-begin`/`chunk`/`end`) so the browser can show a progress bar; edit/preview reads still arrive as a single `sftp-read`.

Alongside the components, a few small **DOM helper modules** keep the big
components lean: `download.ts` (`triggerDownload` — save bytes as a file) and
`dropUpload.ts` (`droppedEntries` + `collectDroppedFiles` — walk a dropped
folder tree into relative-path files). Pure, DOM-free helpers stay in `src/lib`
instead — the base64 ↔ byte codec used across the wire is `src/lib/bytes.ts`
(unit-tested in `bytes.test.ts`).

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
