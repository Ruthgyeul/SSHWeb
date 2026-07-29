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
