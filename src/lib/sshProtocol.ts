/**
 * Wire protocol shared by the browser SSH client and the WebSocket ↔ SSH bridge
 * in `server.mjs`.
 *
 * Both ends exchange JSON text frames shaped like the unions below. This module
 * is the single source of truth for the *frontend*; the server (a plain `.mjs`
 * file, outside the TypeScript build) mirrors the same `t` string constants —
 * if you change a message name or shape here, update `server.mjs` too. This is
 * the same "two synchronized places" discipline the theme uses (see
 * `src/lib/theme.ts` ↔ `globals.css`).
 *
 * Everything in this file is pure and DOM-free so it runs under Vitest's node
 * environment (see `sshProtocol.test.ts`).
 */

/** How a remote host is authenticated. */
export type AuthMethod = "password" | "key";

/** A single SFTP directory entry, normalized for the file browser. */
export interface FileEntry {
  name: string;
  /** Resolved kind — `link` is a symlink we did not follow. */
  type: "dir" | "file" | "link" | "other";
  /** Size in bytes (0 for directories we did not stat). */
  size: number;
  /** Modified time, epoch milliseconds (0 when unknown). */
  mtime: number;
  /** Raw POSIX mode bits, for rendering an `ls -l`-style permission string. */
  mode: number;
}

/* ------------------------------------------------------------------ */
/* Client → server messages                                            */
/* ------------------------------------------------------------------ */

export interface ConnectMessage {
  t: "connect";
  host: string;
  port: number;
  username: string;
  /** Present when authenticating with a password. */
  password?: string;
  /** PEM private key text when authenticating with a key. */
  privateKey?: string;
  /** Optional passphrase protecting `privateKey`. */
  passphrase?: string;
  cols: number;
  rows: number;
}

export type ClientMessage =
  | ConnectMessage
  // Raw keystrokes typed into the terminal, sent as a UTF-8 string.
  | { t: "data"; data: string }
  | { t: "resize"; cols: number; rows: number }
  // Round-trip latency probe: the server echoes the same `ts` straight back in a
  // `pong`, letting the client measure connection RTT without touching the shell.
  | { t: "ping"; ts: number }
  // User's decision on a presented host key (TOFU): accept and continue, or
  // reject and abort the handshake.
  | { t: "hostkey-response"; accept: boolean }
  // Answers to a keyboard-interactive challenge (e.g. an OTP / 2FA code), in
  // the same order as the prompts that were presented.
  | { t: "kbd-response"; responses: string[] }
  | { t: "sftp-list"; path: string }
  // Read a file. `edit: true` opens it in the inline editor, `preview: true`
  // opens it in the image preview modal, and `thumb: true` fetches a small
  // image for the file-browser grid's thumbnail (like `preview`, but the reply
  // is cached into a tile instead of a modal); without any of these the read
  // triggers a download. The server echoes whichever flag was set back to the
  // client.
  | {
      t: "sftp-read";
      path: string;
      edit?: boolean;
      preview?: boolean;
      thumb?: boolean;
    }
  // Write a file. When `offset` is a number the write is chunked (offset 0
  // opens the stream, `final: true` closes it) — this drives upload progress;
  // without `offset` the whole `dataB64` is written at once (inline-edit save).
  // `mkdirp` (honored on the opening chunk) recursively creates the target's
  // parent directories first — set by folder uploads whose path has subdirs.
  | {
      t: "sftp-write";
      path: string;
      dataB64: string;
      offset?: number;
      final?: boolean;
      mkdirp?: boolean;
    }
  | { t: "sftp-mkdir"; path: string }
  // Turn the file browser's elevated (sudo) mode on or off. When enabled the
  // bridge routes every SFTP operation through an `sftp-server` running as root
  // (`sudo sftp-server` over an exec channel), so files the login user can't
  // reach become browsable/editable — the SFTP counterpart to `sudo su` in the
  // terminal. `password` is an optional sudo password (fed to `sudo -S`); omit
  // it when passwordless sudo (`NOPASSWD`) is configured. Server-gated by
  // `SSH_ALLOW_SUDO`.
  | { t: "sftp-sudo"; enable: boolean; password?: string }
  | { t: "sftp-rm"; path: string; dir?: boolean }
  | { t: "sftp-rename"; from: string; to: string }
  | { t: "sftp-chmod"; path: string; mode: number }
  // Download a directory as a (store-only) zip archive.
  | { t: "sftp-download-dir"; path: string }
  // Download several selected entries (files and/or directories) as a single
  // (store-only) zip archive. The server replies with a one-shot `sftp-read`.
  | { t: "sftp-download-many"; paths: string[] }
  // Open a local port-forward (`ssh -L`): the bridge listens on
  // `bindHost:bindPort` and tunnels each accepted TCP connection to
  // `destHost:destPort` *through the SSH session*. `id` is a client-generated
  // handle the two ends use to correlate status and teardown.
  | {
      t: "forward-open";
      id: string;
      bindHost: string;
      bindPort: number;
      destHost: string;
      destPort: number;
    }
  // Tear down a previously opened forward and close its listener.
  | { t: "forward-close"; id: string }
  | { t: "disconnect" };

/* ------------------------------------------------------------------ */
/* Server → client messages                                            */
/* ------------------------------------------------------------------ */

export type ConnectionState =
  | "connecting"
  | "connected"
  | "closed"
  | "error";

/** A single keyboard-interactive question (e.g. "Verification code:"). */
export interface KbdPrompt {
  prompt: string;
  /** When false the answer should be masked (like a password field). */
  echo: boolean;
}

export type ServerMessage =
  | { t: "status"; state: ConnectionState; message?: string }
  // Terminal output. `data` is base64-encoded raw bytes so multi-byte UTF-8
  // sequences that straddle a chunk boundary survive the trip; the client
  // decodes to a Uint8Array and lets xterm's stream decoder handle it.
  | { t: "data"; data: string }
  // The target host's public-key fingerprint, presented for TOFU verification
  // before the session opens. The client compares it against its known-hosts
  // store and either auto-accepts, prompts, or warns on a changed key.
  | { t: "hostkey"; host: string; port: number; fingerprint: string; keyType: string }
  // Reply to a `ping`, carrying the original `ts` so the client can compute the
  // round-trip time.
  | { t: "pong"; ts: number }
  // Streamed download (plain download only — edit/preview reads still arrive as a
  // single `sftp-read`). `begin` announces the total size, `chunk`s carry the
  // base64 bytes in order, and `end` closes the stream so the client assembles
  // and saves the file. This is what drives the download progress bar.
  | { t: "sftp-download-begin"; path: string; name: string; size: number }
  | { t: "sftp-download-chunk"; path: string; dataB64: string }
  | { t: "sftp-download-end"; path: string }
  // A keyboard-interactive challenge (used for OTP / 2FA and some password
  // flows). The client collects answers and replies with `kbd-response`.
  | {
      t: "kbd-interactive";
      name: string;
      instructions: string;
      prompts: KbdPrompt[];
    }
  | { t: "sftp-list"; path: string; entries: FileEntry[] }
  // File contents. `edit`/`preview`/`thumb` echo the request flags: `edit` opens
  // the editor, `preview` opens the image preview modal, `thumb` feeds a grid
  // thumbnail; none of them triggers a download.
  | {
      t: "sftp-read";
      path: string;
      name: string;
      dataB64: string;
      edit?: boolean;
      preview?: boolean;
      thumb?: boolean;
      /** MIME type of `dataB64` when it differs from what the file name implies
       * — set for `thumb` replies whose image was re-encoded to WebP server-side.
       * A `thumb` reply with an empty `dataB64` means "no thumbnail" (skipped or
       * failed) so the client can keep the icon and advance its request queue. */
      mime?: string;
    }
  | { t: "sftp-ok"; op: string; path: string }
  // Optional per-session capability advertisement, sent once the session is
  // ready. `sudo` reflects whether the server permits elevated (root) file
  // access (`SSH_ALLOW_SUDO`), so the client only shows the sudo toggle when the
  // deployment allows it.
  | { t: "caps"; sudo: boolean }
  // Acknowledges an `sftp-sudo` request: `enabled` is the mode now in effect.
  // A failure to gain elevation is reported separately as an `error` (scope
  // `sftp`) and leaves the session unelevated.
  | { t: "sftp-sudo"; enabled: boolean }
  // A local port-forward the bridge is now listening for (echoes the resolved
  // bind/destination so the UI can show exactly what was opened).
  | {
      t: "forward-opened";
      id: string;
      bindHost: string;
      bindPort: number;
      destHost: string;
      destPort: number;
    }
  // A forward's listener has been torn down (by the user or on disconnect).
  | { t: "forward-closed"; id: string }
  // A forward could not be opened, or failed while running.
  | { t: "forward-error"; id: string; message: string }
  // Live count of connections currently tunnelled through a forward.
  | { t: "forward-conn"; id: string; count: number }
  | { t: "error"; message: string; scope?: "sftp" | "shell" | "auth" };

/* ------------------------------------------------------------------ */
/* Encoding / decoding                                                 */
/* ------------------------------------------------------------------ */

/** Serialize a message for `WebSocket.send`. */
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse an incoming frame into a typed object, or `null` if it is not valid
 * JSON with a string `t` discriminator. Callers narrow on `t` themselves.
 */
export function parseMessage<T = ClientMessage | ServerMessage>(
  raw: string,
): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.t === "string") {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Connection input validation                                         */
/* ------------------------------------------------------------------ */

export interface ConnectInput {
  host: string;
  port: number | string;
  username: string;
  auth: AuthMethod;
  password?: string;
  privateKey?: string;
}

/**
 * Validate the connection form. Returns a list of human-readable errors; an
 * empty array means the input is ready to send. Kept pure so both the form and
 * tests can call it.
 */
export function validateConnectInput(input: ConnectInput): string[] {
  const errors: string[] = [];

  if (!input.host || input.host.trim() === "") {
    errors.push("Host is required.");
  }

  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push("Port must be an integer between 1 and 65535.");
  }

  if (!input.username || input.username.trim() === "") {
    errors.push("Username is required.");
  }

  if (input.auth === "password") {
    if (!input.password) errors.push("Password is required.");
  } else if (!input.privateKey || input.privateKey.trim() === "") {
    errors.push("A private key is required.");
  }

  return errors;
}

/** A local port-forward request, as gathered from the tunnels form. */
export interface ForwardInput {
  /** Address the bridge listens on (defaults to loopback in the UI). */
  bindHost: string;
  bindPort: number | string;
  /** Destination host, resolved *from the SSH server's* network. */
  destHost: string;
  destPort: number | string;
}

/** Validate a port number is an integer in the 1–65535 range. */
function isValidPort(value: number | string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Validate a local port-forward form. Returns human-readable errors; an empty
 * array means the input is ready to send. Kept pure so the tunnels form and its
 * tests share one rule set. The server enforces its own bind-safety policy on
 * top of this (see `isForwardBindAllowed` in `serverSecurity.ts`).
 */
export function validateForward(input: ForwardInput): string[] {
  const errors: string[] = [];
  if (!isValidPort(input.bindPort)) {
    errors.push("Local port must be an integer between 1 and 65535.");
  }
  if (!input.destHost || input.destHost.trim() === "") {
    errors.push("Destination host is required.");
  }
  if (!isValidPort(input.destPort)) {
    errors.push("Destination port must be an integer between 1 and 65535.");
  }
  return errors;
}

/** Compact `bind:port → dest:port` label for a forward chip. */
export function forwardLabel(f: {
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
}): string {
  const bind = f.bindHost && f.bindHost !== "127.0.0.1" ? f.bindHost : "localhost";
  return `${bind}:${f.bindPort} → ${f.destHost}:${f.destPort}`;
}

/**
 * Whether `host` is permitted by an allowlist. An empty/absent allowlist means
 * "no restriction" (connect anywhere, like the reference client). Matching is
 * case-insensitive and supports a leading `*.` wildcard for subdomains.
 *
 * The server enforces its own copy of this rule; the frontend uses it only to
 * fail fast with a friendlier message.
 */
export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const h = host.trim().toLowerCase();
  return allowlist.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return h === pattern.slice(2) || h.endsWith(suffix);
    }
    return h === pattern;
  });
}

/* ------------------------------------------------------------------ */
/* Host key (TOFU) helpers                                             */
/* ------------------------------------------------------------------ */

/** Stable key used to store/look up a host's fingerprint (`host:port`). */
export function hostKeyId(host: string, port: number | string): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/**
 * Trust-on-first-use verdict for a presented fingerprint against what (if
 * anything) we have stored for that host:
 *   - `new`     — never seen this host; ask the user to confirm.
 *   - `match`   — matches the stored key; safe to continue.
 *   - `changed` — differs from the stored key; warn loudly (possible MITM).
 */
export function compareHostKey(
  stored: string | undefined,
  fingerprint: string,
): "new" | "match" | "changed" {
  if (!stored) return "new";
  return stored === fingerprint ? "match" : "changed";
}

/** Parse a comma/space separated allowlist string into a clean array. */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/* ------------------------------------------------------------------ */
/* Presentation helpers (file browser)                                 */
/* ------------------------------------------------------------------ */

/** Render POSIX mode bits as an `ls -l` string, e.g. `-rwxr-xr-x`. */
export function formatMode(mode: number, type: FileEntry["type"]): string {
  const typeChar = type === "dir" ? "d" : type === "link" ? "l" : "-";
  const perms = ["r", "w", "x"];
  let out = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 0b111;
    for (let i = 0; i < 3; i++) {
      out += bits & (0b100 >> i) ? perms[i] : "-";
    }
  }
  return typeChar + out;
}

/** Human-readable byte size, e.g. `1.4 KB`. Directories render as `—`. */
export function formatSize(bytes: number, type: FileEntry["type"]): string {
  if (type === "dir") return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 || size % 1 === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Sort directory entries the way a file browser expects: directories first,
 * then case-insensitive by name. Returns a new array (does not mutate input).
 */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return sortEntriesBy(entries, "name", "asc");
}

/** Which field a directory listing is sorted on. */
export type SortKey = "name" | "size" | "mtime";
/** Sort direction: ascending (A→Z, small→large, old→new) or descending. */
export type SortDir = "asc" | "desc";

/** The natural first-click direction for each sort key (name A→Z, but size and
 * date most-recent/largest first, which is what a user usually wants). */
export const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  size: "desc",
  mtime: "desc",
};

/**
 * Sort directory entries by `key`/`dir` for the file browser. Directories are
 * always grouped ahead of files (the conventional "folders on top" behaviour),
 * and entries are then ordered within each group by the chosen field. Name is
 * the stable tiebreaker (always ascending) so equal sizes/dates stay in a
 * predictable order. Returns a new array (does not mutate input).
 */
export function sortEntriesBy(
  entries: FileEntry[],
  key: SortKey,
  dir: SortDir,
): FileEntry[] {
  const sign = dir === "desc" ? -1 : 1;
  const rank = (e: FileEntry) => (e.type === "dir" ? 0 : 1);
  const byName = (a: FileEntry, b: FileEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return [...entries].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r; // directories always first
    let cmp: number;
    if (key === "size") cmp = a.size - b.size;
    else if (key === "mtime") cmp = a.mtime - b.mtime;
    else cmp = byName(a, b);
    if (cmp === 0) return byName(a, b); // stable name tiebreak, always ascending
    return cmp * sign;
  });
}

/**
 * Filter directory entries by a case-insensitive substring of their name.
 * A blank/whitespace-only query returns the list unchanged (same array is fine
 * — callers treat the result as read-only). Used by the file browser's in-CWD
 * filter box; ordering is preserved so it composes with `sortEntries`.
 */
export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/**
 * Join a POSIX directory path with a child segment, collapsing `.`/`..` and
 * duplicate slashes. Used to navigate the remote filesystem safely on the
 * client (the server re-resolves independently).
 */
export function joinPath(base: string, segment: string): string {
  const start = base.startsWith("/") ? "/" : "";
  const parts = `${base}/${segment}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return start + stack.join("/") || "/";
}

/** The parent directory of a POSIX path (`/a/b/c` → `/a/b`, `/` → `/`). */
export function parentPath(path: string): string {
  return joinPath(path, "..") || "/";
}

/** A clickable breadcrumb segment: its display `name` and the absolute `path`. */
export interface PathSegment {
  name: string;
  path: string;
}

/**
 * Split an absolute POSIX path into cumulative breadcrumb segments, e.g.
 * `/home/user/docs` → `[{home,/home}, {user,/home/user}, {docs,/home/user/docs}]`.
 * A non-absolute path (e.g. the pre-resolve `~` placeholder) yields no segments;
 * the caller renders the root crumb separately.
 */
export function pathSegments(path: string): PathSegment[] {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return [];
  const out: PathSegment[] = [];
  let acc = "";
  for (const part of trimmed.split("/")) {
    if (part === "") continue;
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/**
 * Parse a symbolic-free octal permission string (e.g. "644", "0755") into mode
 * bits, or `null` if it isn't 3–4 octal digits. Used by the chmod dialog.
 */
export function parseOctalMode(input: string): number | null {
  const s = input.trim();
  if (!/^[0-7]{3,4}$/.test(s)) return null;
  return parseInt(s, 8);
}

/** Render the low 12 mode bits back as a 3-digit octal string (e.g. "644"). */
export function modeToOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Extensions we treat as binary — files better downloaded than opened as text.
 * This is a *blocklist*: the inline editor opens essentially everything else,
 * mirroring how `vi`/`nano` will open any file (so config files, dotfiles, and
 * extensionless files all edit inline). Images and videos have their own preview
 * modal, so they're matched separately (see `previewKind`) rather than listed
 * here.
 */
const BINARY_EXTENSIONS = new Set([
  // Archives / compressed.
  "zip", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "tar", "zst",
  "lz", "lzma", "jar", "war", "ear", "apk", "deb", "rpm", "iso", "dmg", "cab",
  "ar", "cpio",
  // Audio.
  "mp3", "wav", "flac", "aac", "oga", "m4a", "opus", "wma", "aiff", "mid",
  "midi",
  // Documents / office.
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // Fonts.
  "ttf", "otf", "woff", "woff2", "eot",
  // Compiled / executable / object.
  "exe", "dll", "so", "dylib", "o", "a", "obj", "bin", "class", "pyc", "pyo",
  "wasm", "node", "lib", "msi", "elf", "ko",
  // Databases / packed data.
  "db", "sqlite", "sqlite3", "mdb", "pack", "idx",
]);

/* ------------------------------------------------------------------ */
/* Terminal input helpers (on-screen modifier keys)                    */
/* ------------------------------------------------------------------ */

/**
 * Translate a single character to the control byte it would produce with Ctrl
 * held (e.g. `c` → 0x03 / ETX). Letters map to 1–26; a handful of symbols map to
 * 0/27–31/127 as a terminal does. Anything without a Ctrl form is returned
 * unchanged.
 */
export function ctrlChar(ch: string): string {
  if (ch.length !== 1) return ch;
  if (ch >= "a" && ch <= "z") return String.fromCharCode(ch.charCodeAt(0) - 96);
  if (ch >= "A" && ch <= "Z") return String.fromCharCode(ch.charCodeAt(0) - 64);
  const map: Record<string, number> = {
    "@": 0, " ": 0, "[": 27, "\\": 28, "]": 29, "^": 30, "_": 31, "?": 127,
  };
  return ch in map ? String.fromCharCode(map[ch]) : ch;
}

/**
 * Apply on-screen Ctrl/Alt modifiers to terminal input. Ctrl maps a single
 * character to its control byte; Alt (Meta) prefixes ESC. Modifiers only apply
 * to single-character input — a multi-character string (e.g. a paste) passes
 * through untouched.
 */
export function applyKeyModifiers(
  data: string,
  mods: { ctrl: boolean; alt: boolean },
): string {
  if ((!mods.ctrl && !mods.alt) || data.length !== 1) return data;
  let out = data;
  if (mods.ctrl) out = ctrlChar(out);
  if (mods.alt) out = `\x1b${out}`;
  return out;
}

/** Image extensions the browser can render inline, mapped to their MIME type. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  pjpeg: "image/jpeg",
  pjp: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  avif: "image/avif",
};

/**
 * Heuristic: is this filename an image we can preview inline in the browser?
 * Matches purely by extension (case-insensitive).
 */
export function isProbablyImageFile(name: string): boolean {
  return imageMimeType(name) !== null;
}

/**
 * Upper bound (bytes) on the *original* image the file-browser grid will
 * auto-fetch as a thumbnail. The bridge reads the original into memory and
 * downscales it (originals are never modified) before sending, so what crosses
 * the WebSocket is tiny; this cap bounds the read the bridge does from the SSH
 * target. Larger images just show the generic icon until opened. Mirrored in
 * `server.mjs`, which also enforces it so a client can't request a huge file
 * "as a thumbnail".
 */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Longest edge (px) of a generated grid thumbnail. The bridge downscales images
 * to fit within this box (preserving aspect ratio, never enlarging) and re-encodes
 * them as WebP, turning multi-MB photos into a few KB. Sized with room for
 * hi-DPI grid tiles. Mirrored in `server.mjs`.
 */
export const THUMBNAIL_PIXELS = 256;

/**
 * Upper bound (bytes) on a video the grid will auto-fetch to render a poster
 * frame. Video thumbnails work by pulling the whole (short) clip and letting a
 * `<video>` element paint its first frame — there's no server-side frame
 * extraction (unlike images, which are downscaled on the bridge) — so the cap is
 * a bit higher than the image one but still keeps the grid cheap; larger clips
 * just show the film icon. Mirrored in `server.mjs` (as the absolute ceiling for
 * any `thumb` read).
 */
export const THUMBNAIL_VIDEO_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Whether a listing entry should get an auto-loaded thumbnail in the grid view:
 * a regular file that's a browser-renderable image or video and small enough
 * that fetching it whole is cheap (see {@link THUMBNAIL_MAX_BYTES} /
 * {@link THUMBNAIL_VIDEO_MAX_BYTES}). Use {@link previewKind} to decide whether
 * to render the fetched bytes as an `<img>` or a `<video>`.
 */
export function isThumbnailable(entry: FileEntry): boolean {
  if (entry.type !== "file" || entry.size < 0) return false;
  if (isProbablyImageFile(entry.name)) return entry.size <= THUMBNAIL_MAX_BYTES;
  if (isProbablyVideoFile(entry.name)) {
    return entry.size <= THUMBNAIL_VIDEO_MAX_BYTES;
  }
  return false;
}

/**
 * The image MIME type implied by a filename's extension, or `null` when it is
 * not a previewable image. Used to build the `data:` URL for the preview modal.
 */
export function imageMimeType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_MIME[ext] ?? null;
}

/** Video extensions the browser can play inline, mapped to their MIME type. */
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
};

/**
 * Heuristic: is this filename a video we can play inline in the browser?
 * Matches purely by extension (case-insensitive). Actual playback still depends
 * on the browser's codec support (e.g. `.mov`/`.mkv` vary), but the `<video>`
 * element degrades gracefully when a codec is missing.
 */
export function isProbablyVideoFile(name: string): boolean {
  return videoMimeType(name) !== null;
}

/**
 * The video MIME type implied by a filename's extension, or `null` when it is
 * not a previewable video. Used to build the `data:` URL for the preview modal.
 */
export function videoMimeType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return VIDEO_MIME[ext] ?? null;
}

/** Audio extensions the browser can play inline, mapped to their MIME type. */
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
};

/**
 * Heuristic: is this filename an audio file we can play inline in the browser?
 * Matches purely by extension (case-insensitive). Actual playback still depends
 * on the browser's codec support, but the `<audio>` element degrades gracefully
 * when a codec is missing.
 */
export function isProbablyAudioFile(name: string): boolean {
  return audioMimeType(name) !== null;
}

/**
 * The audio MIME type implied by a filename's extension, or `null` when it is
 * not a playable audio file. Used to build the `data:` URL for the preview
 * modal's `<audio>` element.
 */
export function audioMimeType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return AUDIO_MIME[ext] ?? null;
}

/** What kind of media the preview modal should render for a file. */
export type PreviewKind = "image" | "video" | "audio";

/**
 * Classify a filename for the inline preview modal: `image`, `video`, `audio`,
 * or `null` when it isn't a previewable media file. Images win over videos, and
 * videos over audio, on the (never expected) chance an extension appears in more
 * than one map.
 */
export function previewKind(name: string): PreviewKind | null {
  if (imageMimeType(name) !== null) return "image";
  if (videoMimeType(name) !== null) return "video";
  if (audioMimeType(name) !== null) return "audio";
  return null;
}

/**
 * Heuristic: can this filename be shown in the inline preview modal (image,
 * video, or audio)? Used by the file browser to decide the click-to-open/👁
 * action so opening a media file views it in place instead of downloading it.
 */
export function isProbablyPreviewableFile(name: string): boolean {
  return previewKind(name) !== null;
}

/**
 * Heuristic: is this filename a binary format we should download rather than try
 * to open as text? Matches by extension (case-insensitive); an extensionless
 * name is not considered binary (a plain `README`/`hosts`-style file).
 */
export function isProbablyBinaryFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Heuristic: can this filename be opened in the inline editor? Modeled on how
 * `vi`/`nano` behave — they open essentially any file — so this is true for
 * everything that isn't previewable media (image/video, which has its own modal)
 * or a known binary format (archives, compiled objects, fonts, office docs, …).
 * Config files, dotfiles, and extensionless files all count as editable text.
 */
export function isProbablyTextFile(name: string): boolean {
  return previewKind(name) === null && !isProbablyBinaryFile(name);
}
