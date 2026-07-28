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
import next from "next";
import { WebSocketServer } from "ws";
import { Client as SSHClient } from "ssh2";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (upgradeHandler) {
    upgradeHandler(req, socket, head);
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  /** @type {import('ssh2').Client | null} */
  let ssh = null;
  let shell = null; // interactive PTY stream
  let sftp = null; // cached SFTP subsystem
  let counted = false; // whether this connection is included in activeSessions
  let closed = false;

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
    ssh = null;
    shell = null;
    sftp = null;
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
        // Offer a broad but modern algorithm set so older servers still connect.
        tryKeyboard: false,
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
            s.readFile(msg.path, (err, buffer) => {
              if (err) return sendError(err.message, "sftp");
              send({
                t: "sftp-read",
                path: msg.path,
                name: msg.path.split("/").pop() || "download",
                dataB64: buffer.toString("base64"),
              });
            });
          }),
        );
        break;

      case "sftp-write":
        withSftp((s) => {
          const buffer = Buffer.from(msg.dataB64 || "", "base64");
          s.writeFile(msg.path, buffer, (err) => {
            if (err) return sendError(err.message, "sftp");
            send({ t: "sftp-ok", op: "write", path: msg.path });
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
