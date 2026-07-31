/**
 * Custom Next.js server with a WebSocket ↔ SSH bridge.
 *
 * A browser cannot open a raw TCP/SSH socket, so a web SSH client needs a
 * server-side relay: the page opens a WebSocket to this process, and this
 * process holds the real `ssh2` connection to the target host and pipes bytes
 * between the two. It also exposes SFTP so the file browser can list, download,
 * upload and delete files over the same authenticated session.
 *
 * This file runs *outside* the TypeScript/Next build (it's plain ESM invoked by
 * `node server.mjs`), so it mirrors the message `t` constants defined in
 * `src/lib/sshProtocol.ts` by hand — keep the two in sync.
 *
 * Security posture (see docs/claude-project.md and .env.example):
 *   • Credentials are relayed to the target host and never logged or persisted.
 *   • SSH_ALLOWED_HOSTS optionally restricts which hosts may be reached.
 *   • SSH_MAX_SESSIONS caps concurrent SSH connections for this process.
 *   • The remote host still enforces its own authentication and file perms —
 *     the user only ever gets the access their own credentials grant.
 */

import { createServer } from "node:http";
import net from "node:net";
import { parse } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import next from "next";
import nextEnv from "@next/env";
import { WebSocketServer } from "ws";
import ssh2 from "ssh2";

const { Client: SSHClient, utils: sshUtils } = ssh2;
const { loadEnvConfig } = nextEnv;

const dev = process.env.NODE_ENV !== "production";
// Load `.env`, `.env.local`, `.env.[development|production]`, … into
// process.env (the same files Next loads) BEFORE reading PORT and friends, so
// the server port can be set from a .env file — e.g. `PORT=3000` in .env.local.
loadEnvConfig(process.cwd(), dev);

// Bind to 127.0.0.1 (IPv4 loopback) by default rather than "localhost", which
// can resolve to ::1 (IPv6 only) and leave an IPv4 reverse proxy unable to
// reach us. Set HOSTNAME=0.0.0.0 to expose the server on all interfaces.
const hostname = process.env.HOSTNAME || "127.0.0.1";
const port = parseInt(process.env.PORT || "3000", 10);

// Path the browser opens its SSH WebSocket on. Must match NEXT_PUBLIC_SSH_WS_PATH.
const WS_PATH = process.env.NEXT_PUBLIC_SSH_WS_PATH || "/api/ssh";

// Optional allowlist (comma/space separated). Empty = connect anywhere.
const ALLOWLIST = (process.env.SSH_ALLOWED_HOSTS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_SESSIONS = parseInt(process.env.SSH_MAX_SESSIONS || "25", 10);
// Cap a single SFTP download so a huge file can't exhaust server memory.
const MAX_DOWNLOAD_BYTES = parseInt(
  process.env.SSH_MAX_DOWNLOAD_BYTES || `${25 * 1024 * 1024}`,
  10,
);
// Cap a single SFTP upload so an unbounded stream can't fill the target disk
// (symmetric with the download cap). 0 disables the limit.
const MAX_UPLOAD_BYTES = parseInt(
  process.env.SSH_MAX_UPLOAD_BYTES || `${25 * 1024 * 1024}`,
  10,
);
// Per-IP throttle on SSH connection *attempts* (anti-brute-force relay).
const RATE_MAX = parseInt(process.env.SSH_RATE_LIMIT_MAX || "10", 10);
const RATE_WINDOW_MS = parseInt(
  process.env.SSH_RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
// Trust X-Forwarded-For for the client IP (default deploy sits behind a reverse
// proxy on loopback). Set false when the server is directly exposed.
const TRUST_PROXY =
  (process.env.SSH_TRUST_PROXY || "true").toLowerCase() !== "false";
// Optional explicit WebSocket origin allowlist. Empty = require same-origin.
const ALLOWED_ORIGINS = (process.env.SSH_ALLOWED_ORIGINS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
// Drop a socket that connects but never sends a `connect` message.
const CONNECT_GRACE_MS = 30_000;
// Auto-close a session after this many ms of no shell/SFTP activity. Latency
// pings don't count as activity, so a truly idle terminal still times out.
// 0 (the default) disables the idle timeout entirely.
const IDLE_TIMEOUT_MS = parseInt(process.env.SSH_IDLE_TIMEOUT_MS || "0", 10);
// Operational logging mode: "json" (structured one-line events, the default) or
// "off". Credentials are never included in any log line.
const LOG_MODE = (process.env.SSH_LOG || "json").toLowerCase();
// Fixed path for the JSON health probe (used by load balancers / uptime checks).
const HEALTH_PATH = "/api/health";
// Optional shared secret gating the whole relay. When set, the browser must
// exchange it for an access cookie at POST /api/access before its WebSocket
// upgrade is accepted. Empty (the default) leaves the relay open.
const ACCESS_TOKEN = process.env.SSH_ACCESS_TOKEN || "";
// Fixed path for the access-gate probe/exchange endpoint, and the cookie it sets.
const ACCESS_PATH = "/api/access";
const ACCESS_COOKIE = "sshweb_access";
// Allow local port-forwarding (`ssh -L`). Opening a listening TCP socket on the
// relay host is sensitive, so it's off unless explicitly enabled.
const ALLOW_FORWARD =
  (process.env.SSH_ALLOW_PORT_FORWARD || "false").toLowerCase() === "true";
// Whether a forward may bind to a non-loopback address (e.g. 0.0.0.0). Off by
// default: forwards may only listen on loopback so they aren't network-reachable.
const FORWARD_ALLOW_PUBLIC_BIND =
  (process.env.SSH_FORWARD_ALLOW_PUBLIC_BIND || "false").toLowerCase() ===
  "true";
// Cap on concurrent forwards per session, so a client can't exhaust host ports.
const MAX_FORWARDS = parseInt(process.env.SSH_MAX_FORWARDS || "10", 10);

let activeSessions = 0;
// Cumulative operational counters surfaced by the health probe (process-wide).
let totalConnections = 0; // SSH sessions that reached "ready"
let rejectedConnections = 0; // connection attempts refused (any reason)
let bytesUp = 0; // bytes relayed browser → remote (shell input + uploads)
let bytesDown = 0; // bytes relayed remote → browser (shell output + downloads)
// Set once a graceful shutdown starts, so new upgrades are refused.
let shuttingDown = false;

/**
 * The value stored in the access cookie: a SHA-256 hex digest of the configured
 * token, so the raw secret never sits in a cookie. The WebSocket upgrade gate
 * compares the presented cookie against this.
 */
const ACCESS_COOKIE_VALUE = ACCESS_TOKEN
  ? createHash("sha256").update(ACCESS_TOKEN).digest("hex")
  : "";

/**
 * Emit a structured operational event as a single JSON line on stdout. Only
 * non-sensitive fields (client IP, host, port, reason) are ever passed in —
 * usernames, passwords and private keys are deliberately never logged.
 */
function logEvent(event, fields = {}) {
  if (LOG_MODE === "off") return;
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n",
  );
}

/** Host is allowed when the list is empty, or matches exactly / by `*.` suffix. */
function isHostAllowed(host) {
  if (ALLOWLIST.length === 0) return true;
  const h = host.trim().toLowerCase();
  return ALLOWLIST.some((p) => {
    if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p;
  });
}

/* ---------------------------------------------------------------------------
 * Security helpers mirrored from src/lib/serverSecurity.ts.
 *
 * That module is the tested source of truth for these algorithms; this file
 * runs outside the TypeScript build so it hand-mirrors them (same discipline as
 * the wire protocol). Change one, change the other.
 * ------------------------------------------------------------------------- */

/** Normalize an Origin header to `scheme://host[:port]`, or null if malformed. */
function normalizeOrigin(value) {
  try {
    const u = new URL(String(value).trim());
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Guard against cross-site WebSocket hijacking on the upgrade handshake. */
function isWebSocketOriginAllowed(origin, host) {
  if (!origin) return true; // non-browser client — CSWSH always sends Origin
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (ALLOWED_ORIGINS.length > 0) {
    return ALLOWED_ORIGINS.some((o) => normalizeOrigin(o) === normalized);
  }
  if (!host || String(host).trim() === "") return false;
  const hostPort = normalized.slice(normalized.indexOf("//") + 2);
  return hostPort === String(host).trim().toLowerCase();
}

/** Resolve the client IP for rate-limiting (honors X-Forwarded-For if trusted). */
function clientIpFromReq(req) {
  const xff = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && xff) {
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Whether a chunked upload's offset continues exactly where the last ended. */
function uploadChunkInOrder(offset, written) {
  return offset === written;
}

/** Whether a session idle since `lastActivity` should be reaped at `now`. */
function isIdleExpired(lastActivity, now, timeoutMs) {
  if (timeoutMs <= 0) return false;
  return now - lastActivity >= timeoutMs;
}

/** Whether the relay is gated by an access token (mirrors serverSecurity.ts). */
function accessTokenRequired(configured) {
  return !!configured && configured.trim() !== "";
}

/**
 * Constant-time check that `provided` matches the configured access token. Uses
 * `timingSafeEqual` so response timing doesn't leak the token's length/prefix
 * (the pure mirror in serverSecurity.ts uses plain equality; the algorithm — an
 * exact match against a configured token — is the same).
 */
function accessTokenMatches(configured, provided) {
  if (!accessTokenRequired(configured)) return false;
  const a = Buffer.from(String(configured));
  const b = Buffer.from(String(provided ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a Cookie header into a name→value map (mirrors serverSecurity.ts). */
function parseCookieHeader(header) {
  const out = {};
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

/** Whether the request carries a valid access cookie (constant-time compare). */
function requestIsAuthorized(req) {
  if (!accessTokenRequired(ACCESS_TOKEN)) return true;
  const cookie = parseCookieHeader(req.headers.cookie)[ACCESS_COOKIE] || "";
  const a = Buffer.from(ACCESS_COOKIE_VALUE);
  const b = Buffer.from(cookie);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const FORWARD_LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost", ""]);

/** Whether a forward may bind to `bindHost` (mirrors serverSecurity.ts). */
function isForwardBindAllowed(bindHost, allowPublic) {
  if (allowPublic) return true;
  return FORWARD_LOOPBACK_BINDS.has((bindHost ?? "").trim().toLowerCase());
}

/** Largest WebSocket frame to accept, from the upload cap (serverSecurity.ts). */
function computeMaxPayloadBytes(maxUploadBytes) {
  if (maxUploadBytes <= 0) return 0;
  const bound = Math.ceil(maxUploadBytes * (4 / 3)) + 1024 * 1024;
  return Math.max(bound, 8 * 1024 * 1024);
}

/** Whether a request arrived over HTTPS (Secure-cookie gate; serverSecurity.ts). */
function isSecureRequest(forwardedProto, encrypted) {
  if (encrypted) return true;
  const raw = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return typeof raw === "string" && raw.toLowerCase().includes("https");
}

/** Minimal per-key sliding-window rate limiter (see serverSecurity.ts). */
const rateHits = new Map();
function rateLimitAllow(key, now) {
  if (RATE_MAX <= 0) return true;
  const recent = (rateHits.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (recent.length >= RATE_MAX) {
    rateHits.set(key, recent);
    return false;
  }
  recent.push(now);
  rateHits.set(key, recent);
  return true;
}
// Periodically drop empty/expired buckets so the map stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateHits) {
    const kept = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length === 0) rateHits.delete(key);
    else rateHits.set(key, kept);
  }
}, RATE_WINDOW_MS).unref?.();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

/** Send a JSON body with no-store caching. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const pathname = parse(req.url).pathname;

  // Lightweight JSON health probe, answered before Next so load balancers and
  // uptime checks get a stable, dependency-free 200. No credentials involved.
  if (req.method === "GET" && pathname === HEALTH_PATH) {
    sendJson(res, shuttingDown ? 503 : 200, {
      status: shuttingDown ? "shutting_down" : "ok",
      activeSessions,
      maxSessions: MAX_SESSIONS,
      totalConnections,
      rejectedConnections,
      bytesUp,
      bytesDown,
      uptime: Math.floor(process.uptime()),
    });
    return;
  }

  // Access gate: report whether a token is required and whether this caller is
  // already authorized (GET), or exchange a token for the access cookie (POST).
  // Credentials for the target host never pass through here — only the relay's
  // own optional shared secret does.
  if (pathname === ACCESS_PATH) {
    if (req.method === "GET") {
      sendJson(res, 200, {
        required: accessTokenRequired(ACCESS_TOKEN),
        authorized: requestIsAuthorized(req),
      });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      let tooBig = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        const ip = clientIpFromReq(req);
        // Throttle access-key guesses per IP (the WebSocket connect path is
        // already throttled; this closes the same brute-force door on the
        // shared-secret exchange). A dedicated `access:` bucket keeps these
        // attempts from consuming the SSH connection-attempt budget.
        if (!rateLimitAllow(`access:${ip}`, Date.now())) {
          logEvent("reject", { ip, reason: "access-rate-limit" });
          sendJson(res, 429, { authorized: false });
          return;
        }
        let token = "";
        try {
          token = String(JSON.parse(body).token ?? "");
        } catch {
          /* malformed body → treated as an empty (failing) token */
        }
        if (!accessTokenMatches(ACCESS_TOKEN, token)) {
          logEvent("reject", { ip, reason: "bad-access-token" });
          sendJson(res, 401, { authorized: false });
          return;
        }
        const secure = isSecureRequest(
          req.headers["x-forwarded-proto"],
          req.socket?.encrypted === true,
        );
        res.setHeader(
          "Set-Cookie",
          `${ACCESS_COOKIE}=${ACCESS_COOKIE_VALUE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`,
        );
        sendJson(res, 200, { authorized: true });
      });
      return;
    }
    res.writeHead(405, { Allow: "GET, POST" });
    res.end();
    return;
  }

  handle(req, res, parse(req.url, true));
});

// Delegate non-SSH upgrades (e.g. Next dev HMR) to Next's own handler.
const upgradeHandler = app.getUpgradeHandler?.();

// Bound the size of a single inbound WebSocket frame so a malicious client can't
// force a huge allocation before our application-level size checks run. Derived
// from the upload cap; 0 means "unbounded uploads → keep the library default".
const MAX_WS_PAYLOAD = computeMaxPayloadBytes(MAX_UPLOAD_BYTES);
const wss = new WebSocketServer(
  MAX_WS_PAYLOAD > 0
    ? { noServer: true, maxPayload: MAX_WS_PAYLOAD }
    : { noServer: true },
);

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "");
  if (pathname === WS_PATH) {
    // Refuse new sessions once a graceful shutdown has begun.
    if (shuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Reject cross-site WebSocket handshakes before upgrading (anti-CSWSH).
    if (!isWebSocketOriginAllowed(req.headers.origin, req.headers.host)) {
      logEvent("reject", {
        reason: "bad-origin",
        origin: req.headers.origin || "",
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Enforce the optional access gate before spending a session on the upgrade.
    if (!requestIsAuthorized(req)) {
      rejectedConnections += 1;
      logEvent("reject", { ip: clientIpFromReq(req), reason: "unauthorized" });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (upgradeHandler) {
    upgradeHandler(req, socket, head);
  } else {
    socket.destroy();
  }
});

// --- Folder download (store-only ZIP) --------------------------------------

/** CRC-32 (IEEE) of a buffer — required in ZIP local/central headers. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Path helpers for chunked uploads --------------------------------------

/** The parent directory of a POSIX path (`/a/b/c` → `/a/b`, `/a` → `/`). */
function parentDirOf(p) {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/**
 * Recursively create `dir` over SFTP (like `mkdir -p`), then call `done`. An
 * already-existing directory is not an error here: the final `mkdir`'s error is
 * intentionally ignored so a folder upload into an existing tree still proceeds.
 */
function mkdirp(sftp, dir, done) {
  if (!dir || dir === "/" || dir === ".") return done();
  sftp.mkdir(dir, (err) => {
    if (!err) return done();
    // The parent may be missing — create it first, then retry this level.
    const parent = parentDirOf(dir);
    if (parent === dir) return done();
    mkdirp(sftp, parent, () => sftp.mkdir(dir, () => done()));
  });
}

/**
 * Recursively read every file under `dir` over SFTP, returning
 * `[{ name: relativePath, data: Buffer }]`. Symlinks are skipped.
 */
function collectDirFiles(sftp, dir, done) {
  const out = [];
  const base = dir.replace(/\/+$/, "");
  const walk = (path, rel, cb) => {
    sftp.readdir(path, (err, list) => {
      if (err) return cb(err);
      let i = 0;
      const nextEntry = () => {
        if (i >= list.length) return cb(null);
        const item = list[i++];
        const childPath = `${path}/${item.filename}`;
        const childRel = rel ? `${rel}/${item.filename}` : item.filename;
        if (item.attrs.isDirectory?.()) {
          walk(childPath, childRel, (e) => (e ? cb(e) : nextEntry()));
        } else if (item.attrs.isFile?.()) {
          sftp.readFile(childPath, (e, buf) => {
            if (e) return cb(e);
            out.push({ name: childRel, data: buf });
            nextEntry();
          });
        } else {
          nextEntry(); // skip symlinks / specials
        }
      };
      nextEntry();
    });
  };
  walk(base, "", (err) => (err ? done(err) : done(null, out)));
}

/**
 * Collect a set of selected paths (files and/or directories) into a flat
 * `[{ name, data }]` list suitable for zipping. A directory is walked
 * recursively and its entries are prefixed with the directory's basename so the
 * archive preserves structure. Errors abort the whole collection.
 */
function collectPaths(sftp, paths, done) {
  const out = [];
  let i = 0;
  const nextPath = () => {
    if (i >= paths.length) return done(null, out);
    const p = paths[i++];
    const base = p.split("/").filter(Boolean).pop() || "file";
    sftp.stat(p, (err, stats) => {
      if (err) return done(err);
      if (stats.isDirectory?.()) {
        collectDirFiles(sftp, p, (e, files) => {
          if (e) return done(e);
          for (const f of files) out.push({ name: `${base}/${f.name}`, data: f.data });
          nextPath();
        });
      } else if (stats.isFile?.()) {
        sftp.readFile(p, (e, buf) => {
          if (e) return done(e);
          out.push({ name: base, data: buf });
          nextPath();
        });
      } else {
        nextPath(); // skip symlinks / specials
      }
    });
  };
  nextPath();
}

/** Build a minimal store-only (uncompressed) ZIP archive from a file list. */
function buildStoreZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filename
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBuf, file.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

wss.on("connection", (ws, req) => {
  const clientIp = clientIpFromReq(req);
  logEvent("ws-open", { ip: clientIp });
  /** @type {import('ssh2').Client | null} */
  let ssh = null;
  let shell = null; // interactive PTY stream
  let sftp = null; // cached SFTP subsystem
  let counted = false; // whether this connection is included in activeSessions
  let closed = false;
  // Pending handshake callbacks that wait on a round-trip to the browser.
  let pendingHostVerify = null; // (accept: boolean) => void
  let pendingKbdFinish = null; // (responses: string[]) => void
  // In-flight chunked uploads, keyed by remote path → { stream }.
  const uploads = new Map();
  // In-flight download read streams, so they can be torn down on cleanup.
  const downloads = new Set();
  // Open local port-forwards, keyed by client id → { server, sockets:Set }.
  const forwards = new Map();
  // Timestamp of the last genuine shell/SFTP activity (not latency pings), used
  // by the idle-timeout reaper below.
  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const sendError = (message, scope) => send({ t: "error", message, scope });

  // If the client never authenticates, reclaim the socket.
  const graceTimer = setTimeout(() => {
    if (!ssh) {
      sendError("No connection request received.", "auth");
      ws.close();
    }
  }, CONNECT_GRACE_MS);

  // Idle-session reaper: close a connection with no shell/SFTP traffic for
  // IDLE_TIMEOUT_MS. Disabled when the timeout is 0. The check runs at most
  // every 30s so a long timeout doesn't hold a tight interval.
  const idleTimer =
    IDLE_TIMEOUT_MS > 0
      ? setInterval(
          () => {
            if (isIdleExpired(lastActivity, Date.now(), IDLE_TIMEOUT_MS)) {
              logEvent("idle-timeout", { ip: clientIp });
              sendError("Session closed after inactivity.", "shell");
              cleanup();
              ws.close();
            }
          },
          Math.max(1000, Math.min(IDLE_TIMEOUT_MS, 30_000)),
        )
      : null;
  idleTimer?.unref?.();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(graceTimer);
    if (idleTimer) clearInterval(idleTimer);
    logEvent("ws-close", { ip: clientIp });
    if (counted) {
      activeSessions = Math.max(0, activeSessions - 1);
      counted = false;
    }
    try {
      shell?.end();
    } catch {
      /* stream already gone */
    }
    try {
      ssh?.end();
    } catch {
      /* client already gone */
    }
    // Release any handshake waiters so a half-open handshake doesn't hang.
    if (pendingHostVerify) {
      try {
        pendingHostVerify(false);
      } catch {
        /* callback already consumed */
      }
      pendingHostVerify = null;
    }
    pendingKbdFinish = null;
    for (const { stream } of uploads.values()) {
      try {
        stream.destroy();
      } catch {
        /* stream already gone */
      }
    }
    uploads.clear();
    for (const stream of downloads) {
      try {
        stream.destroy();
      } catch {
        /* stream already gone */
      }
    }
    downloads.clear();
    for (const fwd of forwards.values()) {
      try {
        fwd.server.close();
      } catch {
        /* listener already gone */
      }
      for (const s of fwd.sockets) {
        try {
          s.destroy();
        } catch {
          /* socket already gone */
        }
      }
    }
    forwards.clear();
    ssh = null;
    shell = null;
    sftp = null;
  }

  /** SHA256 fingerprint of a host public key, in OpenSSH's `SHA256:…` form. */
  function fingerprintHostKey(keyBuf) {
    const digest = createHash("sha256")
      .update(keyBuf)
      .digest("base64")
      .replace(/=+$/, "");
    let keyType = "ssh";
    try {
      const parsed = sshUtils.parseKey(keyBuf);
      if (parsed && !(parsed instanceof Error) && parsed.type) {
        keyType = parsed.type;
      }
    } catch {
      /* fall back to the generic label */
    }
    return { fingerprint: `SHA256:${digest}`, keyType };
  }

  /** Lazily open (and cache) the SFTP subsystem, then run `fn(sftp)`. */
  function withSftp(fn) {
    if (!ssh) return sendError("Not connected.", "sftp");
    if (sftp) return fn(sftp);
    ssh.sftp((err, s) => {
      if (err) return sendError(`SFTP unavailable: ${err.message}`, "sftp");
      sftp = s;
      fn(s);
    });
  }

  function handleConnect(msg) {
    if (ssh) return; // already connecting/connected — ignore duplicates
    const host = String(msg.host || "").trim();
    const targetPort = Number(msg.port) || 22;
    const username = String(msg.username || "").trim();

    if (!host || !username) {
      sendError("Host and username are required.", "auth");
      return ws.close();
    }
    if (!isHostAllowed(host)) {
      rejectedConnections += 1;
      logEvent("reject", { ip: clientIp, host, reason: "host-not-allowed" });
      sendError(`Host not allowed by this server: ${host}`, "auth");
      return ws.close();
    }
    if (!rateLimitAllow(clientIp, Date.now())) {
      rejectedConnections += 1;
      logEvent("reject", { ip: clientIp, host, reason: "rate-limit" });
      sendError("Too many connection attempts. Please slow down.", "auth");
      return ws.close();
    }
    if (activeSessions >= MAX_SESSIONS) {
      rejectedConnections += 1;
      logEvent("reject", { ip: clientIp, host, reason: "at-capacity" });
      sendError("Server is at capacity. Try again shortly.", "auth");
      return ws.close();
    }

    activeSessions += 1;
    counted = true;
    send({ t: "status", state: "connecting" });

    ssh = new SSHClient();

    ssh
      .on("ready", () => {
        totalConnections += 1;
        logEvent("connect", { ip: clientIp, host, port: targetPort });
        send({ t: "status", state: "connected" });
        ssh.shell(
          {
            term: "xterm-256color",
            cols: Number(msg.cols) || 80,
            rows: Number(msg.rows) || 24,
          },
          (err, stream) => {
            if (err) {
              sendError(`Failed to open shell: ${err.message}`, "shell");
              return cleanup();
            }
            shell = stream;
            stream.on("data", (data) => {
              touch();
              bytesDown += data.length;
              send({ t: "data", data: data.toString("base64") });
            });
            stream.stderr?.on("data", (data) => {
              touch();
              bytesDown += data.length;
              send({ t: "data", data: data.toString("base64") });
            });
            stream.on("close", () => {
              send({ t: "status", state: "closed" });
              cleanup();
              ws.close();
            });
          },
        );
      })
      .on(
        "keyboard-interactive",
        (name, instructions, _lang, prompts, finish) => {
          // Relay the challenge (e.g. an OTP / 2FA code) to the browser and
          // wait for the user's answers before finishing authentication.
          pendingKbdFinish = finish;
          send({
            t: "kbd-interactive",
            name: name || "",
            instructions: instructions || "",
            prompts: prompts.map((p) => ({
              prompt: p.prompt,
              echo: p.echo !== false,
            })),
          });
        },
      )
      .on("error", (err) => {
        // ssh2 surfaces auth failures and network errors here.
        send({ t: "status", state: "error", message: err.message });
        sendError(err.message, "auth");
        cleanup();
        ws.close();
      })
      .on("close", () => {
        send({ t: "status", state: "closed" });
        cleanup();
      })
      .connect({
        host,
        port: targetPort,
        username,
        password: msg.password || undefined,
        privateKey: msg.privateKey || undefined,
        passphrase: msg.passphrase || undefined,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        // Enable keyboard-interactive so servers that require an OTP / 2FA code
        // (or deliver the password prompt this way) can complete auth.
        tryKeyboard: true,
        // Trust-on-first-use host key check: present the fingerprint to the
        // browser and let the user decide before the session opens.
        hostVerifier: (keyBuf, verify) => {
          const { fingerprint, keyType } = fingerprintHostKey(keyBuf);
          pendingHostVerify = verify;
          send({ t: "hostkey", host, port: targetPort, fingerprint, keyType });
        },
      });
  }

  function toEntryType(attrs) {
    if (attrs.isDirectory?.()) return "dir";
    if (attrs.isSymbolicLink?.()) return "link";
    if (attrs.isFile?.()) return "file";
    return "other";
  }

  // Append `buffer` to an open upload, enforcing the size cap and closing the
  // stream on the final chunk.
  function appendUploadChunk(entry, path, buffer, isFinal) {
    if (
      MAX_UPLOAD_BYTES > 0 &&
      entry.written + buffer.length > MAX_UPLOAD_BYTES
    ) {
      try {
        entry.stream.destroy();
      } catch {
        /* stream already gone */
      }
      uploads.delete(path);
      return sendError(
        `File too large to upload (> ${MAX_UPLOAD_BYTES} bytes).`,
        "sftp",
      );
    }
    entry.written += buffer.length;
    bytesUp += buffer.length;
    entry.stream.write(buffer);
    if (isFinal) {
      entry.stream.end(() => {
        uploads.delete(path);
        send({ t: "sftp-ok", op: "write", path });
      });
    }
  }

  // Open a fresh write stream for `path` and write the first chunk into it.
  function openUpload(s, path, buffer, isFinal) {
    const stream = s.createWriteStream(path);
    stream.on("error", (err) => {
      uploads.delete(path);
      sendError(err.message, "sftp");
    });
    const entry = { stream, written: 0 };
    uploads.set(path, entry);
    appendUploadChunk(entry, path, buffer, isFinal);
  }

  // Drive one chunk of a chunked upload. offset 0 (re)opens the stream —
  // optionally creating parent directories first (folder uploads); later chunks
  // must arrive in order or the transfer is aborted to avoid silent corruption.
  function handleChunkedWrite(s, msg, buffer) {
    const path = msg.path;
    const existing = uploads.get(path);
    if (msg.offset === 0) {
      if (existing) {
        try {
          existing.stream.destroy();
        } catch {
          /* stream already gone */
        }
        uploads.delete(path);
      }
      if (msg.mkdirp) {
        mkdirp(s, parentDirOf(path), () =>
          openUpload(s, path, buffer, msg.final === true),
        );
      } else {
        openUpload(s, path, buffer, msg.final === true);
      }
      return;
    }
    if (!existing || !uploadChunkInOrder(msg.offset, existing.written)) {
      if (existing) {
        try {
          existing.stream.destroy();
        } catch {
          /* stream already gone */
        }
        uploads.delete(path);
      }
      return sendError("Upload chunk out of order.", "sftp");
    }
    appendUploadChunk(existing, path, buffer, msg.final === true);
  }

  // Open a local port-forward (`ssh -L`): listen on bindHost:bindPort and tunnel
  // each accepted TCP connection to destHost:destPort *through the SSH session*.
  // Guarded by ALLOW_FORWARD, a loopback-only bind policy, and a per-session cap.
  function openForward(msg) {
    const id = String(msg.id || "");
    if (!id || forwards.has(id)) return;
    const fail = (message) => send({ t: "forward-error", id, message });
    if (!ALLOW_FORWARD) {
      return fail("Port forwarding is disabled on this server.");
    }
    if (!ssh) return fail("Not connected.");
    if (forwards.size >= MAX_FORWARDS) {
      return fail(`Too many forwards (max ${MAX_FORWARDS}).`);
    }
    const bindHost = String(msg.bindHost || "127.0.0.1").trim() || "127.0.0.1";
    const bindPort = Number(msg.bindPort) || 0;
    const destHost = String(msg.destHost || "").trim();
    const destPort = Number(msg.destPort) || 0;
    if (bindPort < 1 || bindPort > 65535 || destPort < 1 || destPort > 65535 || !destHost) {
      return fail("Invalid forward specification.");
    }
    if (!isForwardBindAllowed(bindHost, FORWARD_ALLOW_PUBLIC_BIND)) {
      return fail(
        "Forward may only bind to loopback on this server (127.0.0.1).",
      );
    }

    const sockets = new Set();
    const local = net.createServer((socket) => {
      if (!ssh) return socket.destroy();
      const srcIp = socket.remoteAddress || "127.0.0.1";
      const srcPort = socket.remotePort || 0;
      ssh.forwardOut(srcIp, srcPort, destHost, destPort, (err, stream) => {
        if (err) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        send({ t: "forward-conn", id, count: sockets.size });
        // Meter forwarded traffic into the same up/down counters as the shell.
        socket.on("data", (d) => {
          bytesUp += d.length;
        });
        stream.on("data", (d) => {
          bytesDown += d.length;
        });
        socket.pipe(stream).pipe(socket);
        const done = () => {
          if (sockets.delete(socket)) {
            send({ t: "forward-conn", id, count: sockets.size });
          }
          try {
            socket.destroy();
          } catch {
            /* already gone */
          }
          try {
            stream.destroy();
          } catch {
            /* already gone */
          }
        };
        socket.on("close", done);
        socket.on("error", done);
        stream.on("close", done);
        stream.on("error", done);
      });
    });
    local.on("error", (err) => {
      forwards.delete(id);
      fail(err.code === "EADDRINUSE" ? `Port ${bindPort} is already in use.` : err.message);
    });
    forwards.set(id, { server: local, sockets, bindHost, bindPort, destHost, destPort });
    local.listen(bindPort, bindHost, () => {
      logEvent("forward-open", { ip: clientIp, bindPort, destHost, destPort });
      send({ t: "forward-opened", id, bindHost, bindPort, destHost, destPort });
    });
  }

  // Tear down a forward: close its listener and drop any live tunnelled sockets.
  function closeForward(id) {
    const fwd = forwards.get(String(id || ""));
    if (!fwd) return;
    forwards.delete(String(id));
    try {
      fwd.server.close();
    } catch {
      /* listener already gone */
    }
    for (const s of fwd.sockets) {
      try {
        s.destroy();
      } catch {
        /* socket already gone */
      }
    }
    send({ t: "forward-closed", id: String(id) });
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    // Any real shell/SFTP traffic counts as activity for the idle reaper;
    // latency pings deliberately don't, so an idle terminal still times out.
    if (msg.t !== "ping") touch();

    switch (msg.t) {
      case "connect":
        handleConnect(msg);
        break;

      case "data":
        if (shell) {
          bytesUp += Buffer.byteLength(msg.data || "", "utf8");
          shell.write(msg.data, "utf8");
        }
        break;

      case "resize":
        if (shell)
          shell.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0);
        break;

      case "ping":
        // Latency probe: echo the timestamp straight back so the client can
        // measure round-trip time without disturbing the shell.
        send({ t: "pong", ts: Number(msg.ts) || 0 });
        break;

      case "hostkey-response":
        if (pendingHostVerify) {
          const verify = pendingHostVerify;
          pendingHostVerify = null;
          verify(msg.accept === true);
        }
        break;

      case "kbd-response":
        if (pendingKbdFinish) {
          const finish = pendingKbdFinish;
          pendingKbdFinish = null;
          finish(Array.isArray(msg.responses) ? msg.responses.map(String) : []);
        }
        break;

      case "sftp-list":
        withSftp((s) => {
          // Resolve to an absolute path first so the UI breadcrumb is clean and
          // "." maps to the user's home directory on first load.
          const requested = msg.path || ".";
          s.realpath(requested, (rpErr, resolved) => {
            const dir = rpErr ? requested : resolved;
            s.readdir(dir, (err, list) => {
              if (err) return sendError(err.message, "sftp");
              const entries = list.map((item) => ({
                name: item.filename,
                type: toEntryType(item.attrs),
                size: item.attrs.size || 0,
                mtime: (item.attrs.mtime || 0) * 1000,
                mode: (item.attrs.mode || 0) & 0o777,
              }));
              send({ t: "sftp-list", path: dir, entries });
            });
          });
        });
        break;

      case "sftp-read":
        withSftp((s) =>
          s.stat(msg.path, (statErr, stats) => {
            if (statErr) return sendError(statErr.message, "sftp");
            if (stats.size > MAX_DOWNLOAD_BYTES) {
              return sendError(
                `File too large to download (> ${MAX_DOWNLOAD_BYTES} bytes).`,
                "sftp",
              );
            }
            const name = msg.path.split("/").pop() || "download";

            // Edit/preview need the whole file in one message (they build an
            // editor buffer or a data: URL); they're already size-capped above.
            if (msg.edit === true || msg.preview === true) {
              s.readFile(msg.path, (err, buffer) => {
                if (err) return sendError(err.message, "sftp");
                send({
                  t: "sftp-read",
                  path: msg.path,
                  name,
                  dataB64: buffer.toString("base64"),
                  edit: msg.edit === true,
                  preview: msg.preview === true,
                });
              });
              return;
            }

            // Plain download: stream in chunks so the browser can show progress.
            // Pause on WebSocket backpressure and resume when it drains, so a big
            // file never balloons the send buffer.
            const stream = s.createReadStream(msg.path);
            downloads.add(stream);
            send({
              t: "sftp-download-begin",
              path: msg.path,
              name,
              size: stats.size,
            });
            stream.on("data", (chunk) => {
              bytesDown += chunk.length;
              send({
                t: "sftp-download-chunk",
                path: msg.path,
                dataB64: chunk.toString("base64"),
              });
              if (ws.bufferedAmount > 8 * 1024 * 1024) {
                stream.pause();
                const resume = setInterval(() => {
                  if (ws.readyState !== ws.OPEN) {
                    clearInterval(resume);
                    stream.destroy();
                  } else if (ws.bufferedAmount < 1 * 1024 * 1024) {
                    clearInterval(resume);
                    stream.resume();
                  }
                }, 25);
              }
            });
            stream.on("error", (err) => {
              downloads.delete(stream);
              sendError(err.message, "sftp");
            });
            stream.on("end", () => {
              downloads.delete(stream);
              send({ t: "sftp-download-end", path: msg.path });
            });
          }),
        );
        break;

      case "sftp-write":
        withSftp((s) => {
          const buffer = Buffer.from(msg.dataB64 || "", "base64");
          if (typeof msg.offset === "number") {
            // Chunked upload: open on the first chunk, append (in order) on the
            // rest, close on the final one — this is what drives progress.
            handleChunkedWrite(s, msg, buffer);
          } else {
            // Whole-file write (inline-edit save / empty-file touch).
            if (MAX_UPLOAD_BYTES > 0 && buffer.length > MAX_UPLOAD_BYTES) {
              return sendError(
                `File too large to save (> ${MAX_UPLOAD_BYTES} bytes).`,
                "sftp",
              );
            }
            s.writeFile(msg.path, buffer, (err) => {
              if (err) return sendError(err.message, "sftp");
              send({ t: "sftp-ok", op: "write", path: msg.path });
            });
          }
        });
        break;

      case "sftp-rename":
        withSftp((s) =>
          s.rename(msg.from, msg.to, (err) => {
            if (err) return sendError(err.message, "sftp");
            send({ t: "sftp-ok", op: "rename", path: msg.to });
          }),
        );
        break;

      case "sftp-chmod":
        withSftp((s) =>
          s.chmod(msg.path, Number(msg.mode) & 0o777, (err) => {
            if (err) return sendError(err.message, "sftp");
            send({ t: "sftp-ok", op: "chmod", path: msg.path });
          }),
        );
        break;

      case "sftp-download-dir":
        withSftp((s) => {
          collectDirFiles(s, msg.path, (err, files) => {
            if (err) return sendError(err.message, "sftp");
            const total = files.reduce((n, f) => n + f.data.length, 0);
            if (total > MAX_DOWNLOAD_BYTES) {
              return sendError(
                `Folder too large to download (> ${MAX_DOWNLOAD_BYTES} bytes).`,
                "sftp",
              );
            }
            const zip = buildStoreZip(files);
            const name = (msg.path.split("/").filter(Boolean).pop() || "download") + ".zip";
            send({
              t: "sftp-read",
              path: msg.path,
              name,
              dataB64: zip.toString("base64"),
            });
          });
        });
        break;

      case "sftp-download-many":
        withSftp((s) => {
          const paths = Array.isArray(msg.paths) ? msg.paths.filter(Boolean) : [];
          if (paths.length === 0) return sendError("Nothing selected.", "sftp");
          collectPaths(s, paths, (err, files) => {
            if (err) return sendError(err.message, "sftp");
            const total = files.reduce((n, f) => n + f.data.length, 0);
            if (total > MAX_DOWNLOAD_BYTES) {
              return sendError(
                `Selection too large to download (> ${MAX_DOWNLOAD_BYTES} bytes).`,
                "sftp",
              );
            }
            const zip = buildStoreZip(files);
            send({
              t: "sftp-read",
              path: paths[0],
              name: "download.zip",
              dataB64: zip.toString("base64"),
            });
          });
        });
        break;

      case "sftp-mkdir":
        withSftp((s) =>
          s.mkdir(msg.path, (err) => {
            if (err) return sendError(err.message, "sftp");
            send({ t: "sftp-ok", op: "mkdir", path: msg.path });
          }),
        );
        break;

      case "sftp-rm":
        withSftp((s) => {
          const done = (err) => {
            if (err) return sendError(err.message, "sftp");
            send({ t: "sftp-ok", op: "rm", path: msg.path });
          };
          if (msg.dir) s.rmdir(msg.path, done);
          else s.unlink(msg.path, done);
        });
        break;

      case "forward-open":
        openForward(msg);
        break;

      case "forward-close":
        closeForward(msg.id);
        break;

      case "disconnect":
        cleanup();
        ws.close();
        break;
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(port, hostname, () => {
  console.log(
    `> Ready on http://${hostname}:${port} (SSH bridge at ${WS_PATH})`,
  );
  if (ALLOWLIST.length > 0) {
    console.log(`> SSH host allowlist active: ${ALLOWLIST.join(", ")}`);
  }
  if (IDLE_TIMEOUT_MS > 0) {
    console.log(`> Idle sessions closed after ${IDLE_TIMEOUT_MS} ms`);
  }
  if (ACCESS_TOKEN) {
    console.log("> Relay access gate enabled (SSH_ACCESS_TOKEN set)");
  }
  if (ALLOW_FORWARD) {
    console.log(
      `> Port forwarding enabled (bind: ${FORWARD_ALLOW_PUBLIC_BIND ? "any" : "loopback only"})`,
    );
  }
  logEvent("server-start", {
    port,
    maxSessions: MAX_SESSIONS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    accessGate: accessTokenRequired(ACCESS_TOKEN),
    portForward: ALLOW_FORWARD,
  });
});

/**
 * Graceful shutdown: stop accepting new connections, tell every live client the
 * server is going away, and exit once they've drained (or after a short grace
 * period). Lets a process manager (systemd, a container orchestrator) recycle
 * the relay without abruptly cutting active sessions.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("shutdown", { signal, activeSessions });
  server.close();
  for (const client of wss.clients) {
    try {
      client.send(
        JSON.stringify({
          t: "status",
          state: "closed",
          message: "Server is shutting down.",
        }),
      );
      client.close(1001, "server shutdown");
    } catch {
      /* client already gone */
    }
  }
  // Exit as soon as all sockets have closed, or force it after the grace period.
  const forceTimer = setTimeout(() => process.exit(0), 5000);
  forceTimer.unref?.();
  const drain = setInterval(() => {
    if (wss.clients.size === 0) {
      clearInterval(drain);
      process.exit(0);
    }
  }, 200);
  drain.unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
