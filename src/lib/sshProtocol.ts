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
  /** For a `link` entry: the raw (unfollowed) symlink target path, when the
   * bridge could read it (`readlink`). Absent for non-links or on error. */
  target?: string;
}

/** A recursive-search hit: a matched entry plus its absolute remote path. */
export interface FindEntry extends FileEntry {
  /** Absolute path of the match on the remote host. */
  path: string;
}

/** A content-search (grep) hit: a file whose *contents* matched, with the first
 * matching line's number and a short preview of that line. */
export interface GrepEntry extends FindEntry {
  /** 1-based line number of the first match within the file. */
  line: number;
  /** The matching line, leading-whitespace-trimmed and clamped for display. */
  preview: string;
}

/**
 * Max recursive-search hits the bridge returns before it stops and flags the
 * result truncated. Bounds the reply size and the walk cost. Mirrored in
 * `server.mjs`, which also caps the number of filesystem nodes it visits.
 */
export const MAX_FIND_RESULTS = 500;

/**
 * Largest file (bytes) the content search (grep) will read and scan. Unlike the
 * name search — which reads only listings/metadata — grep must open file
 * contents, so this caps the per-file read; larger files are skipped. Mirrored
 * in `server.mjs`, which also enforces a total-bytes budget for one search.
 */
export const GREP_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Find the first line of `text` containing `query` (case-insensitive), returning
 * its 1-based line number and a display-ready preview (leading whitespace
 * trimmed, clamped to `maxPreview` chars with an ellipsis), or `null` when there
 * is no match. Pure so the file browser and the bridge (which mirrors it) share
 * one rule; unit-tested.
 */
export function grepFirstMatch(
  text: string,
  query: string,
  maxPreview = 160,
): { line: number; preview: string } | null {
  const needle = query.toLowerCase();
  if (needle === "") return null;
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      let preview = lines[i].replace(/^\s+/, "");
      if (preview.length > maxPreview) {
        preview = `${preview.slice(0, maxPreview)}…`;
      }
      return { line: i + 1, preview };
    }
  }
  return null;
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
  // client. A `preview` read is streamed back via the chunked
  // `sftp-download-*` frames (tagged `preview: true`) so the modal can show a
  // progress bar and be cancelled; `edit` reads still arrive whole in one
  // `sftp-read`.
  | {
      t: "sftp-read";
      path: string;
      edit?: boolean;
      preview?: boolean;
      thumb?: boolean;
      // Cap a `preview` stream at this many bytes (a text preview of a huge log
      // reads only the head instead of the whole file, and bypasses the
      // whole-file download cap). The reply's `sftp-download-end` carries
      // `truncated: true` when the file was longer.
      maxBytes?: number;
      // Ask the bridge to downscale a large image to a small WebP for a fast
      // click-to-view preview (see `PREVIEW_IMAGE_MAX_DIM`) instead of streaming
      // the full-resolution original. The original is untouched and still fetched
      // whole by an explicit Download. Ignored for non-image / SVG / GIF reads
      // and when `sharp` is unavailable — those stream the original as before.
      previewResize?: boolean;
      // Correlation flag for a two-file diff read (#76): the bridge echoes it on
      // the reply so the client routes it to the diff collector, not the editor.
      diff?: boolean;
    }
  // Write a file. When `offset` is a number the write is chunked (offset 0
  // opens the stream, `final: true` closes it) — this drives upload progress;
  // without `offset` the whole `dataB64` is written at once (inline-edit save).
  // `mkdirp` (honored on the opening chunk) recursively creates the target's
  // parent directories first — set by folder uploads whose path has subdirs.
  // `resume` (honored on the opening chunk, whose `offset` may be > 0) reopens
  // an existing partial in append-at-offset mode instead of truncating, so an
  // upload interrupted by a dropped connection can continue where it left off.
  | {
      t: "sftp-write";
      path: string;
      dataB64: string;
      offset?: number;
      final?: boolean;
      mkdirp?: boolean;
      resume?: boolean;
    }
  // Ask the bridge for a partial upload's current on-disk size so a resumed
  // upload knows where to continue. The bridge replies with `sftp-write-at`
  // (offset 0 when the file is missing → the client restarts from scratch).
  | { t: "sftp-write-resume"; path: string }
  // Abort an in-flight (or interrupted) upload: the bridge tears the write
  // stream down and removes the partial destination file.
  | { t: "sftp-upload-cancel"; path: string }
  // Abort an in-flight streamed download: the bridge tears that read stream down
  // (the source file is only read, so nothing on the remote is changed).
  | { t: "sftp-download-cancel"; path: string }
  | { t: "sftp-mkdir"; path: string }
  // Recursively search `path` (and its subdirectories) for entries whose name
  // contains `query` (case-insensitive). The bridge walks the tree reading only
  // directory listings/metadata — never file contents — and replies with a
  // single `sftp-find-result`. Symlinked directories are not descended.
  | { t: "sftp-find"; path: string; query: string }
  // Recursively search file *contents* under `path` for lines containing `query`
  // (case-insensitive). Unlike `sftp-find`, the bridge opens each candidate file
  // and scans it (skipping binaries and files over `GREP_MAX_FILE_BYTES`, and
  // bounded by a total-bytes budget) — the files are only read, never modified —
  // and replies with a single `sftp-grep-result`.
  | { t: "sftp-grep"; path: string; query: string }
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
  // Copy (duplicate) a file or directory to a new path. The bridge streams the
  // source into the destination (recursively for a directory) — the original is
  // only read, never modified. Move is done with `sftp-rename` instead.
  | { t: "sftp-copy"; from: string; to: string }
  // Create a symbolic link at `path` pointing to `target` (the target is stored
  // verbatim; a relative target resolves against the link's directory).
  | { t: "sftp-symlink"; target: string; path: string }
  // Change mode bits. `recursive` (directories only) walks the subtree applying
  // the same mode to every entry.
  | { t: "sftp-chmod"; path: string; mode: number; recursive?: boolean }
  // Compute a hash of a remote file's contents (default sha256), streamed on the
  // bridge so a large file isn't buffered. The original is only read.
  | { t: "sftp-checksum"; path: string; algo?: string }
  // Query filesystem disk usage for `path` (df), via the OpenSSH statvfs SFTP
  // extension. Not all servers support it; unsupported → an error frame.
  | { t: "sftp-df"; path: string }
  // Download a directory as a (store-only) zip archive.
  | { t: "sftp-download-dir"; path: string }
  // Download several selected entries (files and/or directories) as a single
  // (store-only) zip archive. The server replies with a one-shot `sftp-read`.
  | { t: "sftp-download-many"; paths: string[] }
  // Evict this connection's cached grid thumbnails from the bridge's in-memory
  // cache (the settings "Clear thumbnail cache" action). Drops both the
  // login-user and elevated (`#root`) entries for this `user@host`.
  | { t: "thumb-purge" }
  | { t: "disconnect" };

/* ------------------------------------------------------------------ */
/* Client message field validation (mirrored in server.mjs)            */
/* ------------------------------------------------------------------ */

/** The primitive shape a required message field must have. */
export type FieldKind = "string" | "number" | "boolean" | "string[]";

/**
 * Required-field specs per client message type. The bridge validates an
 * incoming frame against this table *before* dispatching it, so a malformed
 * message (e.g. an `sftp-read` with no `path`) is rejected up front instead of
 * throwing deep inside an async SFTP callback — which, with no per-message
 * guard, would crash the single shared bridge process and drop every concurrent
 * session. Only structurally-required fields are listed (the client is
 * TypeScript-typed against the `ClientMessage` union, so it always sends them);
 * optional fields are not checked here. Hand-mirrored in `server.mjs`, the same
 * "two synchronized places" discipline as the wire protocol constants.
 */
export const CLIENT_MESSAGE_FIELDS: Record<
  string,
  Record<string, FieldKind>
> = {
  connect: {
    host: "string",
    port: "number",
    username: "string",
    cols: "number",
    rows: "number",
  },
  data: { data: "string" },
  resize: { cols: "number", rows: "number" },
  ping: { ts: "number" },
  "hostkey-response": { accept: "boolean" },
  "kbd-response": { responses: "string[]" },
  "sftp-list": { path: "string" },
  "sftp-read": { path: "string" },
  "sftp-write": { path: "string", dataB64: "string" },
  "sftp-write-resume": { path: "string" },
  "sftp-upload-cancel": { path: "string" },
  "sftp-download-cancel": { path: "string" },
  "sftp-mkdir": { path: "string" },
  "sftp-find": { path: "string", query: "string" },
  "sftp-grep": { path: "string", query: "string" },
  "sftp-sudo": { enable: "boolean" },
  "sftp-rm": { path: "string" },
  "sftp-rename": { from: "string", to: "string" },
  "sftp-copy": { from: "string", to: "string" },
  "sftp-symlink": { target: "string", path: "string" },
  "sftp-chmod": { path: "string", mode: "number" },
  "sftp-checksum": { path: "string" },
  "sftp-df": { path: "string" },
  "sftp-download-dir": { path: "string" },
  "sftp-download-many": { paths: "string[]" },
  "thumb-purge": {},
  disconnect: {},
};

/** Whether `value` matches the expected field kind. */
function fieldMatchesKind(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

/**
 * Validate a decoded client frame's required fields. Returns `true` when the
 * type is unknown (the dispatcher's `default` case drops it) or every required
 * field is present with the right type; returns `false` only when a *known*
 * message type is missing a required field or carries one of the wrong type.
 * Kept pure so the bridge and its tests share one rule set.
 */
export function isValidClientMessage(
  msg: { t: string } & Record<string, unknown>,
): boolean {
  const spec = CLIENT_MESSAGE_FIELDS[msg.t];
  if (!spec) return true;
  for (const field in spec) {
    if (!fieldMatchesKind(msg[field], spec[field])) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Server → client messages                                            */
/* ------------------------------------------------------------------ */

export type ConnectionState = "connecting" | "connected" | "closed" | "error";

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
  | {
      t: "hostkey";
      host: string;
      port: number;
      fingerprint: string;
      keyType: string;
    }
  // Reply to a `ping`, carrying the original `ts` so the client can compute the
  // round-trip time.
  | { t: "pong"; ts: number }
  // Streamed transfer. `begin` announces the total size, `chunk`s carry the
  // base64 bytes in order, and `end` closes the stream so the client assembles
  // the file. This drives both the download progress bar and — when the frames
  // are tagged `preview: true` (a `preview` read) — the preview modal's progress
  // bar, letting the client accumulate the bytes into a blob/text and paint
  // progress instead of waiting silently. `edit` reads still arrive whole in a
  // single `sftp-read`.
  | {
      t: "sftp-download-begin";
      path: string;
      name: string;
      size: number;
      preview?: boolean;
      // Set only when the bridge transcoded a `previewResize` image: the content
      // type of the bytes that follow (always `image/webp`). Its presence tells
      // the client these are an *optimized* preview, not the original — so the
      // modal builds its blob with this type and routes Download to the original.
      mime?: string;
      // The ORIGINAL image's pixel dimensions (only on a transcoded preview
      // begin), so the modal shows the true size and can gate loading a very
      // large original on demand. May be absent when sharp couldn't read them.
      origWidth?: number;
      origHeight?: number;
    }
  | {
      t: "sftp-download-chunk";
      path: string;
      dataB64: string;
      preview?: boolean;
    }
  // `truncated` is set when a capped `preview` read (`maxBytes`) stopped short
  // of the file's real end, so the modal can flag that it's showing a head slice.
  | {
      t: "sftp-download-end";
      path: string;
      preview?: boolean;
      truncated?: boolean;
    }
  // Reply to `sftp-write-resume`: the destination's current on-disk size, so the
  // client resumes its chunked upload from exactly there (0 = file missing, so
  // the client restarts the upload from the beginning).
  | { t: "sftp-write-at"; path: string; offset: number }
  // A keyboard-interactive challenge (used for OTP / 2FA and some password
  // flows). The client collects answers and replies with `kbd-response`.
  | {
      t: "kbd-interactive";
      name: string;
      instructions: string;
      prompts: KbdPrompt[];
    }
  | { t: "sftp-list"; path: string; entries: FileEntry[] }
  // Result of a recursive `sftp-find`: matches under `path` for `query`, each
  // carrying its absolute path. `truncated` is true when the walk hit the
  // result/node budget before finishing (see MAX_FIND_RESULTS).
  | {
      t: "sftp-find-result";
      path: string;
      query: string;
      entries: FindEntry[];
      truncated: boolean;
    }
  // Result of a recursive content search (`sftp-grep`): files under `path` whose
  // contents matched `query`, each with the first matching line + preview.
  // `truncated` is true when the hit/node/byte budget was reached first.
  | {
      t: "sftp-grep-result";
      path: string;
      query: string;
      entries: GrepEntry[];
      truncated: boolean;
    }
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
      /** Echoed diff correlation flag (#76): this edit read was requested for a
       * two-file diff, so the client feeds it to the diff collector. */
      diff?: boolean;
      /** MIME type of `dataB64` when it differs from what the file name implies
       * — set for `thumb` replies whose image was re-encoded to WebP server-side.
       * A `thumb` reply with an empty `dataB64` means "no thumbnail" (skipped or
       * failed) so the client can keep the icon and advance its request queue. */
      mime?: string;
      /** Dominant color (`#rrggbb`) of a `thumb` image, used as a cheap solid
       * placeholder behind the grid tile while the WebP paints (#100). Optional;
       * absent when unavailable, in which case the tile just uses its panel bg. */
      bg?: string;
    }
  | { t: "sftp-ok"; op: string; path: string }
  // Result of a `sftp-checksum` request: the hex digest of the file's contents.
  | { t: "sftp-checksum"; path: string; algo: string; hex: string }
  // Result of a `sftp-df` request: total/free bytes of the filesystem holding
  // the queried path.
  | { t: "sftp-df"; path: string; total: number; free: number }
  // Optional per-session capability advertisement, sent once the session is
  // ready. `sudo` reflects whether the server permits elevated (root) file
  // access (`SSH_ALLOW_SUDO`), so the client only shows the sudo toggle when the
  // deployment allows it. `streamToken` is a per-session capability the client
  // puts in `/api/preview` URLs so a `<video>` can stream+seek over HTTP Range
  // (see `server.mjs`); absent if the deployment can't mint one.
  // `maxDownloadBytes` echoes the whole-file download cap (`SSH_MAX_DOWNLOAD_MB`,
  // 0 = unlimited) so the client can decide when a small clip is safe to fetch
  // whole (and cache for instant re-open) instead of streaming it.
  | {
      t: "caps";
      sudo: boolean;
      streamToken?: string;
      maxDownloadBytes?: number;
    }
  // Acknowledges an `sftp-sudo` request: `enabled` is the mode now in effect.
  // A failure to gain elevation is reported separately as an `error` (scope
  // `sftp`) and leaves the session unelevated.
  | { t: "sftp-sudo"; enabled: boolean }
  // Sent when an idle session is about to be reaped (SSH_IDLE_TIMEOUT_MS), so the
  // UI can warn the user; `remainingMs` is the time left before disconnect. Any
  // real shell/SFTP activity cancels the pending timeout on the server.
  | { t: "idle-warning"; remainingMs: number }
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

/** Max size of either file the two-file diff (#76) will fetch. The diff caps at
 * MAX_DIFF_LINES anyway, so a very large file is refused up front rather than
 * transferred whole and mostly discarded. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024;

/** Human-readable one-line disk-usage summary for the df toast (#49). */
export function formatDiskUsage(total: number, free: number): string {
  if (!Number.isFinite(total) || total <= 0) return "Disk usage unavailable";
  const used = Math.max(0, total - free);
  const pct = Math.round((used / total) * 100);
  return `Disk: ${formatSize(free, "file")} free of ${formatSize(total, "file")} (${pct}% used)`;
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
export function filterEntries(
  entries: FileEntry[],
  query: string,
): FileEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/** One transfer's progress, as the aggregate upload summary reads it. */
export interface TransferProgress {
  sent: number;
  total: number;
  status?: "uploading" | "interrupted" | "queued";
}

/** A rolled-up view of several in-flight uploads, for the aggregate bar. */
export interface UploadSummary {
  /** How many uploads are in the batch (queued + active). */
  files: number;
  /** Bytes sent across the batch. */
  sent: number;
  /** Total bytes to move across the batch. */
  total: number;
  /** Overall percentage, clamped to 0–100 (100 when there are no bytes to move). */
  pct: number;
  /** True when any upload in the batch is paused (interrupted). */
  interrupted: boolean;
  /** How many are still waiting behind the concurrency limit. */
  queued: number;
}

/**
 * Roll several in-flight uploads into one summary for the aggregate progress
 * bar: file count, summed bytes, an overall percentage (100 when there are no
 * bytes to move), whether any is paused (interrupted), and how many are still
 * queued behind the concurrency limit. Kept pure so the file browser and its
 * tests share one rule.
 */
export function summarizeUploads(items: TransferProgress[]): UploadSummary {
  let sent = 0;
  let total = 0;
  let queued = 0;
  let interrupted = false;
  for (const it of items) {
    sent += Math.max(0, it.sent);
    total += Math.max(0, it.total);
    if (it.status === "queued") queued += 1;
    if (it.status === "interrupted") interrupted = true;
  }
  const pct =
    total > 0
      ? Math.min(100, Math.max(0, Math.round((sent / total) * 100)))
      : 100;
  return { files: items.length, sent, total, pct, interrupted, queued };
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

/**
 * Suggest a non-colliding name for a duplicated file, e.g. `report.txt` →
 * `report copy.txt`, then `report copy 2.txt` if that's taken too. A leading-dot
 * dotfile (`.bashrc`) is treated as having no extension. Used to pre-fill the
 * duplicate dialog; the server still enforces its own filesystem rules.
 */
export function suggestCopyName(
  name: string,
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0; // dot at index 0 ⇒ dotfile, not an extension split
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  const make = (n: number) =>
    n === 1 ? `${base} copy${ext}` : `${base} copy ${n}${ext}`;
  let n = 1;
  while (taken.has(make(n))) n++;
  return make(n);
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
  "zip",
  "gz",
  "tgz",
  "bz2",
  "tbz2",
  "xz",
  "txz",
  "7z",
  "rar",
  "tar",
  "zst",
  "lz",
  "lzma",
  "jar",
  "war",
  "ear",
  "apk",
  "deb",
  "rpm",
  "iso",
  "dmg",
  "cab",
  "ar",
  "cpio",
  // Audio.
  "mp3",
  "wav",
  "flac",
  "aac",
  "oga",
  "m4a",
  "opus",
  "wma",
  "aiff",
  "mid",
  "midi",
  // Documents / office.
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  // Fonts.
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Compiled / executable / object.
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "obj",
  "bin",
  "class",
  "pyc",
  "pyo",
  "wasm",
  "node",
  "lib",
  "msi",
  "elf",
  "ko",
  // Databases / packed data.
  "db",
  "sqlite",
  "sqlite3",
  "mdb",
  "pack",
  "idx",
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
    "@": 0,
    " ": 0,
    "[": 27,
    "\\": 28,
    "]": 29,
    "^": 30,
    _: 31,
    "?": 127,
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
  // HEIC/HEIF (iPhone photos): browsers can't decode these, so they're only
  // ever *previewed* as a bridge-transcoded WebP (never streamed raw to an
  // <img>). Listing them here routes them to the image preview + grid thumbnail
  // paths; `isBrowserRenderableImage` keeps the raw bytes off the <img>.
  heic: "image/heic",
  heif: "image/heif",
  heics: "image/heic-sequence",
  heifs: "image/heif-sequence",
};

/**
 * Whether the browser can render this image format's raw bytes directly in an
 * `<img>`. HEIC/HEIF cannot be (no browser decodes them), so those are only
 * shown via the bridge's WebP transcode — the client must never swap their raw
 * original into the `<img>` (that's what the zoom / "Original" affordance would
 * otherwise do). Everything else in {@link IMAGE_MIME} renders natively.
 */
export function isBrowserRenderableImage(name: string): boolean {
  if (imageMimeType(name) === null) return false;
  return !/\.(heic|heif|heics|heifs)$/i.test(name);
}

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
 * downscales it to a tiny WebP (originals are never modified) before sending, so
 * what crosses the WebSocket is tiny regardless; this cap only bounds the read
 * the bridge does from the SSH target (decode memory). Set generously so nearly
 * every real photo gets a thumbnail; larger images just show the generic icon
 * until opened. Mirrored in `server.mjs`, which also enforces it so a client
 * can't request a huge file "as a thumbnail".
 */
export const THUMBNAIL_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Longest edge (px) of a generated grid thumbnail. The bridge downscales images
 * to fit within this box (preserving aspect ratio, never enlarging) and re-encodes
 * them as WebP, turning multi-MB photos into a few KB. Sized with room for
 * hi-DPI grid tiles. Mirrored in `server.mjs`.
 */
export const THUMBNAIL_PIXELS = 256;

/**
 * Upper bound (bytes) on a video the grid will auto-fetch to render a poster
 * frame. The bridge reads the clip into memory, extracts a poster frame with
 * `ffmpeg`, and downscales it to a tiny WebP — so what crosses the wire is tiny;
 * this cap only bounds the read + decode the bridge does. Set generously so most
 * clips get a poster thumbnail; larger videos just show the film icon (reading a
 * multi-hundred-MB clip whole to poster it would be wasteful). Mirrored in
 * `server.mjs` (as the absolute ceiling for any `thumb` read).
 */
export const THUMBNAIL_VIDEO_MAX_BYTES = 64 * 1024 * 1024;

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

/** Video extensions the browser can usually play inline, mapped to their MIME
 * type. `.mkv`/`.mov` are hit-or-miss (codec-dependent) — the preview tries them
 * natively first and falls back to a bridge transcode if playback errors. */
const NATIVE_VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
};

/** Video containers browsers essentially never play, mapped to their MIME type.
 * They're still recognised as videos (grid poster frame via ffmpeg, preview
 * routing) and *play* by streaming a bridge transcode to fragmented MP4 — see
 * {@link videoNeedsTranscode}. */
const TRANSCODE_VIDEO_MIME: Record<string, string> = {
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  asf: "video/x-ms-asf",
  flv: "video/x-flv",
  f4v: "video/x-f4v",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  m2v: "video/mpeg",
  // NB: `.ts` is deliberately NOT here. It's overwhelmingly TypeScript source in
  // this (developer-facing) tool, and treating it as an MPEG transport-stream
  // video sent every `foo.ts` to the video preview/transcode instead of the code
  // editor. A genuine MPEG-TS clip named `.ts` now opens in the text editor
  // (with the usual non-UTF-8 warning) rather than as video — an accepted
  // trade-off. The unambiguous AVCHD extensions `.mts`/`.m2ts` stay as video.
  mts: "video/mp2t",
  m2ts: "video/mp2t",
  vob: "video/mpeg",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  divx: "video/x-msvideo",
  ogm: "video/ogg",
  mxf: "application/mxf",
  rm: "application/vnd.rn-realmedia",
  rmvb: "application/vnd.rn-realmedia-vbr",
};

/** All recognised video extensions → MIME (native-playable ∪ transcode-only). */
const VIDEO_MIME: Record<string, string> = {
  ...NATIVE_VIDEO_MIME,
  ...TRANSCODE_VIDEO_MIME,
};

/**
 * Whether a video must be transcoded by the bridge to play in the browser: its
 * container/codec isn't one browsers decode natively, so the preview points the
 * `<video>` at the bridge's on-the-fly fragmented-MP4 transcode instead of the
 * raw stream. `.mkv`/`.mov` are *not* forced here (they often play natively) —
 * the preview retries them via transcode only if native playback errors.
 * Mirrored in `server.mjs`.
 */
export function videoNeedsTranscode(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return name.slice(dot + 1).toLowerCase() in TRANSCODE_VIDEO_MIME;
}

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

/**
 * Size (bytes) above which the inline editor warns before opening a file. A very
 * large file in a `<textarea>` with live syntax highlighting can be sluggish, so
 * the browser asks for confirmation first. This is only a heads-up — the hard
 * ceiling is the bridge's download cap (`SSH_MAX_DOWNLOAD_MB`), which rejects an
 * over-cap edit read outright.
 */
export const EDITOR_WARN_BYTES = 2 * 1024 * 1024;

/** Whether opening `size` bytes in the inline editor warrants a slowness warning. */
export function isLargeForEditor(size: number): boolean {
  return size > EDITOR_WARN_BYTES;
}

/**
 * Byte cap for a read-only *text* preview stream. A huge log or data file is
 * previewed by reading only its head (the bridge caps the stream at this via the
 * `maxBytes` field on `sftp-read`), so the modal opens fast and stays responsive
 * — and, because the read is bounded, a file past the whole-file download cap
 * can still be peeked at. The modal flags the view as truncated and offers the
 * full download. Mirrored in `server.mjs`.
 */
export const TEXT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Longest-edge pixel bound for a click-to-view image preview. The bridge
 * downscales any larger image to a **high-quality lossy** WebP fitting inside
 * this box so a multi-megapixel photo opens far faster while staying visually
 * indistinguishable at the preview resolution; the original file is only read,
 * never modified, and an explicit Download — or zooming past this resolution —
 * still fetches the untouched original. Mirrored in `server.mjs`.
 */
export const PREVIEW_IMAGE_MAX_DIM = 2560;

/** Default quality (0–100) of the image preview transcode. High enough to be
 * visually indistinguishable from the source at the preview resolution, while
 * cutting the transfer *and* the encode time dramatically versus a lossless
 * encode — the single biggest lever on how fast a photo opens. Pixel-perfect
 * detail is still available on demand (zoom / "Original" / Download all fetch
 * the untouched original). The preview *format* is selectable server-side via
 * `SSH_PREVIEW_IMAGE_FORMAT` (`webp-lossy` — default, fastest to open;
 * `webp-lossless` — pixel-exact but larger/slower; `avif` — smallest wire size,
 * slower CPU encode) and this quality via `SSH_PREVIEW_IMAGE_QUALITY`; mirrored
 * in `server.mjs`. */
export const PREVIEW_IMAGE_QUALITY = 92;

/** Don't transcode an image smaller than this: the original already loads fast,
 * so a WebP round-trip would only add latency. Below it the bridge streams the
 * original as-is. Mirrored in `server.mjs`. */
export const PREVIEW_IMAGE_MIN_BYTES = 512 * 1024;

/** Upper bound on the *original* an image preview will read into memory to
 * transcode. Only the tiny WebP crosses the wire, so this can safely exceed the
 * whole-file download cap; it just bounds the bridge's decode memory. A source
 * larger than this streams through the normal path (subject to the download cap)
 * instead. Mirrored in `server.mjs`. */
export const PREVIEW_IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Whether a click-to-view image should be downscaled to a WebP preview (the fast
 * path) rather than streamed as its original bytes. Excludes SVG (vector — tiny,
 * and rasterizing it would lose scalability) and GIF (may be animated — a `sharp`
 * WebP downscale would drop to a single frame), which stream as their originals.
 */
export function isResizablePreviewImage(name: string): boolean {
  if (imageMimeType(name) === null) return false;
  return !/\.(svg|gif)$/i.test(name);
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
 * video, or audio)? Used by the file browser to decide the click-to-open
 * action so opening a media file views it in place instead of downloading it.
 */
export function isProbablyPreviewableFile(name: string): boolean {
  return previewKind(name) !== null;
}

/** Heuristic: is this a PDF (previewable inline via the browser's viewer)? */
export function isProbablyPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** Markdown extensions we render to HTML in the preview modal. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn"]);

/** Heuristic: is this a Markdown document (previewable as rendered HTML)? */
export function isProbablyMarkdownFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Everything the preview modal can render inline (media + PDF + Markdown). */
export type PreviewContentKind = PreviewKind | "pdf" | "markdown";

/**
 * The preview surface for a filename, or `null` when it can't be previewed
 * inline. Media (image/video/audio) win first, then PDF, then Markdown. A
 * Markdown file is still editable text too (so it shows both a preview and an
 * edit affordance); PDFs are not.
 */
export function filePreviewKind(name: string): PreviewContentKind | null {
  const media = previewKind(name);
  if (media) return media;
  if (isProbablyPdfFile(name)) return "pdf";
  if (isProbablyMarkdownFile(name)) return "markdown";
  return null;
}

/**
 * Sniff a file's leading bytes for a well-known media/PDF magic number, so a
 * mis-named or extensionless file (e.g. a JPEG called `photo` or `image.dat`)
 * can still be previewed as what it actually is. Returns the media kind, or
 * `null` when the signature isn't recognised. Only checks unambiguous magic
 * numbers — never text — so it's safe to fall back to a text/unsupported view.
 */
export function sniffMediaKind(
  bytes: Uint8Array,
): Exclude<PreviewContentKind, "markdown"> | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  const ascii = (start: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      if (b[start + i] !== s.charCodeAt(i)) return false;
    }
    return true;
  };
  // Images.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image"; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image"; // JPEG
  if (ascii(0, "GIF8")) return "image"; // GIF87a / GIF89a
  if (b[0] === 0x42 && b[1] === 0x4d) return "image"; // BMP
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image"; // WEBP
  // PDF.
  if (ascii(0, "%PDF")) return "pdf";
  // ISO base-media (`ftyp`): the major brand tells still-image (HEIC/AVIF) apart
  // from moving-image (MP4/MOV). HEIC/AVIF preview as (transcoded) images.
  if (ascii(4, "ftyp")) {
    if (
      ascii(8, "heic") ||
      ascii(8, "heix") ||
      ascii(8, "hevc") ||
      ascii(8, "heim") ||
      ascii(8, "heis") ||
      ascii(8, "mif1") ||
      ascii(8, "msf1") ||
      ascii(8, "avif") ||
      ascii(8, "avis")
    ) {
      return "image";
    }
    return "video"; // MP4 / MOV / M4V (ISO base media)
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return "video"; // Matroska/WebM
  // Audio.
  if (ascii(0, "OggS")) return "audio"; // Ogg
  if (ascii(0, "fLaC")) return "audio"; // FLAC
  if (ascii(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
    return "audio"; // MP3
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio"; // WAV
  return null;
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
