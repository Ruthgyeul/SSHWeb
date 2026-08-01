/**
 * Pure security helpers for the WebSocket ↔ SSH bridge in `server.mjs`.
 *
 * `server.mjs` runs *outside* the TypeScript build (plain ESM invoked by
 * `node server.mjs`), so — exactly like the wire protocol in `sshProtocol.ts`
 * and the palette in `theme.ts` — it hand-mirrors the logic below. This module
 * is the single source of truth for the *algorithms*; keep the copy in
 * `server.mjs` in sync when you change one here. Everything here is pure and
 * DOM-free so it runs under Vitest's node environment
 * (see `serverSecurity.test.ts`).
 */

/* ------------------------------------------------------------------ */
/* WebSocket origin verification (anti-CSWSH)                          */
/* ------------------------------------------------------------------ */

/**
 * Normalize an `Origin` header to `scheme://host[:port]`, lowercased, with any
 * trailing slash and path dropped. Returns `null` for a malformed value.
 */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** The `host[:port]` portion of a normalized origin (`scheme://host` → `host`). */
function originHostPort(normalized: string): string {
  return normalized.slice(normalized.indexOf("//") + 2);
}

/**
 * Decide whether a WebSocket upgrade's `Origin` is permitted, guarding against
 * cross-site WebSocket hijacking (CSWSH): a malicious page in the user's browser
 * opening our bridge socket behind their back.
 *
 *   - **No `Origin` header** → allowed. A browser always sends `Origin` on a
 *     cross-site WS handshake, so its absence means a non-browser client
 *     (e.g. a native tool or same-process probe), which CSWSH cannot be.
 *   - **`allowedOrigins` non-empty** → the origin must match one of them
 *     exactly (after normalization). This is the explicit escape hatch for
 *     deployments served on a different origin than the bridge.
 *   - **Otherwise** → require same-origin: the origin's `host[:port]` must equal
 *     the request's `Host` header.
 *
 * A malformed `Origin` (present but unparseable) is always rejected.
 */
export function isWebSocketOriginAllowed(opts: {
  origin?: string;
  host?: string;
  allowedOrigins?: string[];
}): boolean {
  const { origin, host, allowedOrigins = [] } = opts;
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (allowedOrigins.length > 0) {
    return allowedOrigins.some((o) => normalizeOrigin(o) === normalized);
  }

  if (!host || host.trim() === "") return false;
  return originHostPort(normalized) === host.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Client IP resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Resolve the client IP for rate-limiting. When `trustProxy` is set (the
 * default deployment sits behind a reverse proxy on loopback), the first hop in
 * `X-Forwarded-For` wins; otherwise the socket's `remoteAddress` is used. Falls
 * back to `"unknown"` so a missing address still yields a stable bucket key.
 */
export function clientIpFromHeaders(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress || "unknown";
}

/* ------------------------------------------------------------------ */
/* Sliding-window rate limiter                                         */
/* ------------------------------------------------------------------ */

/**
 * A minimal in-memory sliding-window rate limiter keyed by an arbitrary string
 * (here: the client IP). It throttles SSH connection *attempts* so the bridge
 * can't be turned into a brute-force relay. `now` is injected so the logic is
 * deterministic under test.
 *
 * A `max` of `0` (or less) disables limiting entirely.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record an attempt for `key` at time `now` and report whether it is allowed.
   * Returns `false` (and does *not* record the attempt) once `max` attempts have
   * occurred within the trailing window.
   */
  check(key: string, now: number): boolean {
    if (this.max <= 0) return true;
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop empty/expired buckets so the map doesn't grow without bound. */
  sweep(now: number): void {
    for (const [key, times] of this.hits) {
      const kept = times.filter((t) => now - t < this.windowMs);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }

  /** Number of tracked keys (for tests / introspection). */
  get size(): number {
    return this.hits.size;
  }
}

/* ------------------------------------------------------------------ */
/* Upload size accounting                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether appending `incoming` more bytes to an upload that has already written
 * `written` bytes would exceed `cap`. A `cap` of `0` (or less) means "no limit".
 */
export function uploadExceedsCap(
  written: number,
  incoming: number,
  cap: number,
): boolean {
  if (cap <= 0) return false;
  return written + incoming > cap;
}

/**
 * Whether a chunked upload's `offset` is the one we expect next. A stream opened
 * on the bridge is written sequentially (append-only — the write stream cannot
 * seek), so an out-of-order, duplicated or skipped chunk would silently corrupt
 * the file. The very first chunk must start at 0; each subsequent chunk must
 * continue exactly where the previous one ended (`written`).
 */
export function uploadChunkInOrder(offset: number, written: number): boolean {
  return offset === written;
}

/**
 * Where a resumed chunked upload should continue from, given the destination
 * file's current on-disk size (`remoteSize`, authoritative — reported by the
 * bridge after a reconnect) and the local file's `total` size. The offset is
 * clamped into `[0, total]` so a stale/mismatched partial that is somehow larger
 * than the source can't drive a negative or over-long remaining range; `done` is
 * true when the remote already holds every byte (nothing left to send).
 */
export function resumeUploadStart(
  remoteSize: number,
  total: number,
): { offset: number; done: boolean } {
  const offset = Math.max(0, Math.min(Math.floor(remoteSize) || 0, total));
  return { offset, done: offset >= total };
}

/* ------------------------------------------------------------------ */
/* Idle-session expiry                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether a session whose last real activity was at `lastActivity` should be
 * reaped at time `now`, given an idle `timeoutMs`. "Activity" is genuine shell
 * or SFTP traffic — latency pings deliberately don't count, so a truly idle
 * terminal still times out even while its keep-alive probes continue. A
 * `timeoutMs` of `0` (or less) disables the timeout entirely.
 */
export function isIdleExpired(
  lastActivity: number,
  now: number,
  timeoutMs: number,
): boolean {
  if (timeoutMs <= 0) return false;
  return now - lastActivity >= timeoutMs;
}

/* ------------------------------------------------------------------ */
/* Relay access gate (optional shared secret)                          */
/* ------------------------------------------------------------------ */

/**
 * Whether the relay is gated by an access token. The bridge is only guarded when
 * `SSH_ACCESS_TOKEN` is set to a non-empty value; an empty/whitespace token
 * means the relay is open (the default), matching the reference client.
 */
export function accessTokenRequired(configured: string | undefined): boolean {
  return !!configured && configured.trim() !== "";
}

/**
 * Whether a caller-supplied `provided` token authorizes access. The gate is only
 * satisfied when a token is actually configured *and* the supplied value matches
 * it exactly. An unconfigured gate is never satisfied by this check — callers use
 * {@link accessTokenRequired} to decide whether a token is needed at all, so an
 * open relay never routes through here.
 *
 * `server.mjs` mirrors this but compares in constant time (`crypto.timingSafeEqual`)
 * to avoid leaking the token's length/prefix through response timing.
 */
export function accessTokenMatches(
  configured: string | undefined,
  provided: string | undefined,
): boolean {
  if (!accessTokenRequired(configured)) return false;
  return provided === configured;
}

/**
 * Parse a `Cookie` request header into a `name → value` map. Values are
 * URL-decoded; malformed pairs are skipped. Absent/empty headers yield `{}`.
 * Used by the WebSocket upgrade gate to read the access cookie set by
 * `POST /api/access`.
 */
export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* WebSocket frame-size bound                                          */
/* ------------------------------------------------------------------ */

/**
 * The largest WebSocket frame the bridge should accept, derived from the upload
 * cap. `ws` buffers a whole frame in memory *before* any application-level size
 * check runs, so without a bound a single client frame can force a ~100 MiB
 * allocation (the library default) regardless of `SSH_MAX_UPLOAD_MB`.
 *
 * The largest legitimate client→server frame is a whole-file editor save, sent
 * base64-encoded (≈4/3 inflation) inside a small JSON envelope; that save is
 * already capped at `maxUploadBytes` on the server. We therefore size the bound
 * to that cap plus base64/JSON headroom, with an 8 MiB floor so a tiny upload
 * cap still admits ordinary control frames. A `maxUploadBytes` of `0` (or less)
 * means uploads are unbounded, so we return `0` — "do not bound frames".
 */
export function computeMaxPayloadBytes(maxUploadBytes: number): number {
  if (maxUploadBytes <= 0) return 0;
  const bound = Math.ceil(maxUploadBytes * (4 / 3)) + 1024 * 1024;
  return Math.max(bound, 8 * 1024 * 1024);
}

/* ------------------------------------------------------------------ */
/* Secure-cookie decision                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether a request arrived over HTTPS, so the access cookie can be flagged
 * `Secure`. Behind a TLS-terminating reverse proxy the original scheme survives
 * only in `X-Forwarded-Proto`; when Node terminates TLS itself there is no such
 * header but the socket is `encrypted`. Honoring both means the cookie never
 * ships without `Secure` on an HTTPS deployment (which would let it leak over a
 * downgraded request).
 */
export function isSecureRequest(
  forwardedProto: string | string[] | undefined,
  encrypted: boolean,
): boolean {
  if (encrypted) return true;
  const raw = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;
  return typeof raw === "string" && raw.toLowerCase().includes("https");
}

/* ------------------------------------------------------------------ */
/* Port-forward bind safety                                            */
/* ------------------------------------------------------------------ */

/** Loopback bind addresses a local port-forward may always listen on. */
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost", ""]);

/**
 * Whether a local port-forward may bind to `bindHost`. Opening a listening
 * socket is sensitive, so by default a forward may only listen on loopback
 * (reachable from the machine running the relay, not the wider network). Set
 * `allowPublic` (from `SSH_FORWARD_ALLOW_PUBLIC_BIND`) to permit any bind
 * address, e.g. `0.0.0.0`. An empty/absent bind host is treated as loopback.
 */
export function isForwardBindAllowed(
  bindHost: string | undefined,
  allowPublic: boolean,
): boolean {
  if (allowPublic) return true;
  return LOOPBACK_BINDS.has((bindHost ?? "").trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Elevated (sudo) SFTP command                                        */
/* ------------------------------------------------------------------ */

/**
 * Where `sftp-server` typically lives across distributions, tried in order.
 * The plain SFTP subsystem always runs as the logged-in user, so to browse or
 * edit files that user can't reach the bridge instead launches this binary
 * under `sudo` over an exec channel (see `buildSudoSftpCommand`). Debian/Ubuntu
 * put it under `/usr/lib/openssh`, RHEL/Fedora under `/usr/libexec/openssh`,
 * Arch/Alpine under `/usr/lib/ssh`, and the BSDs under `/usr/libexec`.
 */
export const DEFAULT_SFTP_SERVER_PATHS = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
  "/usr/libexec/sftp-server",
  "/usr/lib/sftp-server",
  "/usr/local/libexec/sftp-server",
];

/**
 * Build the remote command that starts an `sftp-server` running as root, for the
 * file browser's opt-in elevated mode. It shells out to the first `sftp-server`
 * that exists among `paths` and `exec`s it under `sudo`, so every SFTP operation
 * on that channel runs with root's permissions — the SFTP equivalent of
 * `sudo su` in the terminal (which never affected the file browser, because the
 * SFTP subsystem is a separate channel bound to the login user).
 *
 * Two sudo modes:
 *   - `hasPassword: false` → `sudo -n` (non-interactive): requires passwordless
 *     sudo (a `NOPASSWD` sudoers rule) for the sftp-server binary. Fails fast if
 *     a password would be needed, rather than hanging on a prompt.
 *   - `hasPassword: true` → `sudo -k -S`: sudo reads the password from stdin
 *     (`-k` first invalidates any cached credentials so it always prompts, which
 *     keeps stdin consumption deterministic). The bridge writes exactly that one
 *     password line to the channel before the SFTP protocol starts.
 *
 * The browser never supplies `paths` — they come from server configuration only
 * — so nothing user-controlled is interpolated into this shell command. The
 * optional sudo password travels separately (fed to `sudo -S` on the channel's
 * stdin), never spliced into the command string.
 */
export function buildSudoSftpCommand(
  hasPassword: boolean,
  paths: string[] = DEFAULT_SFTP_SERVER_PATHS,
): string {
  const list = (paths.length > 0 ? paths : DEFAULT_SFTP_SERVER_PATHS).join(" ");
  const finder =
    `for p in ${list}; do [ -x "$p" ] && exec "$p"; done; ` +
    `echo "sftp-server not found" >&2; exit 127`;
  const sudo = hasPassword ? "sudo -k -S -p ''" : "sudo -n";
  return `${sudo} /bin/sh -c '${finder}'`;
}
