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
  | { t: "sftp-list"; path: string }
  | { t: "sftp-read"; path: string }
  | { t: "sftp-write"; path: string; dataB64: string }
  | { t: "sftp-mkdir"; path: string }
  | { t: "sftp-rm"; path: string; dir?: boolean }
  | { t: "disconnect" };

/* ------------------------------------------------------------------ */
/* Server → client messages                                            */
/* ------------------------------------------------------------------ */

export type ConnectionState =
  | "connecting"
  | "connected"
  | "closed"
  | "error";

export type ServerMessage =
  | { t: "status"; state: ConnectionState; message?: string }
  // Terminal output. `data` is base64-encoded raw bytes so multi-byte UTF-8
  // sequences that straddle a chunk boundary survive the trip; the client
  // decodes to a Uint8Array and lets xterm's stream decoder handle it.
  | { t: "data"; data: string }
  | { t: "sftp-list"; path: string; entries: FileEntry[] }
  | { t: "sftp-read"; path: string; name: string; dataB64: string }
  | { t: "sftp-ok"; op: string; path: string }
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
  const rank = (e: FileEntry) => (e.type === "dir" ? 0 : 1);
  return [...entries].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
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
