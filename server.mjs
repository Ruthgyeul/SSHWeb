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
import { parse } from "node:url";
import { createHash } from "node:crypto";
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

let activeSessions = 0;

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

const server = createServer((req, res) => {
  handle(req, res, parse(req.url, true));
});

// Delegate non-SSH upgrades (e.g. Next dev HMR) to Next's own handler.
const upgradeHandler = app.getUpgradeHandler?.();

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "");
  if (pathname === WS_PATH) {
    // Reject cross-site WebSocket handshakes before upgrading (anti-CSWSH).
    if (!isWebSocketOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(graceTimer);
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
      sendError(`Host not allowed by this server: ${host}`, "auth");
      return ws.close();
    }
    if (!rateLimitAllow(clientIp, Date.now())) {
      sendError("Too many connection attempts. Please slow down.", "auth");
      return ws.close();
    }
    if (activeSessions >= MAX_SESSIONS) {
      sendError("Server is at capacity. Try again shortly.", "auth");
      return ws.close();
    }

    activeSessions += 1;
    counted = true;
    send({ t: "status", state: "connecting" });

    ssh = new SSHClient();

    ssh
      .on("ready", () => {
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
            stream.on("data", (data) =>
              send({ t: "data", data: data.toString("base64") }),
            );
            stream.stderr?.on("data", (data) =>
              send({ t: "data", data: data.toString("base64") }),
            );
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

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "connect":
        handleConnect(msg);
        break;

      case "data":
        if (shell) shell.write(msg.data, "utf8");
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
            // Chunked upload: open a stream on the first chunk, append on the
            // rest, and close on the final one — this is what drives progress.
            let entry = uploads.get(msg.path);
            if (msg.offset === 0 || !entry) {
              const stream = s.createWriteStream(msg.path);
              stream.on("error", (err) => {
                uploads.delete(msg.path);
                sendError(err.message, "sftp");
              });
              entry = { stream, written: 0 };
              uploads.set(msg.path, entry);
            }
            // Enforce the upload cap: abort the stream if this chunk would push
            // the running total past MAX_UPLOAD_BYTES.
            if (
              MAX_UPLOAD_BYTES > 0 &&
              entry.written + buffer.length > MAX_UPLOAD_BYTES
            ) {
              try {
                entry.stream.destroy();
              } catch {
                /* stream already gone */
              }
              uploads.delete(msg.path);
              return sendError(
                `File too large to upload (> ${MAX_UPLOAD_BYTES} bytes).`,
                "sftp",
              );
            }
            entry.written += buffer.length;
            entry.stream.write(buffer);
            if (msg.final) {
              entry.stream.end(() => {
                uploads.delete(msg.path);
                send({ t: "sftp-ok", op: "write", path: msg.path });
              });
            }
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
});
