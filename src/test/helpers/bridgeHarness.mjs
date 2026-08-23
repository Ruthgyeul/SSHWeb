/**
 * Shared harness for the WebSocket ↔ SSH bridge integration tests.
 *
 * Both `bridge.integration.test.mjs` (happy-path smoke test) and
 * `security.integration.test.mjs` (the security-gate suite) boot the *real*
 * `server.mjs` as a child process and drive it over a WebSocket, so the plumbing
 * to spawn the bridge, wait for it to become healthy, grab a free port and
 * buffer inbound frames lives here in one place rather than being copy-pasted.
 *
 * Plain ESM (like `server.mjs` and `mockSshServer.mjs`) so it runs outside the
 * TypeScript build under `npm run test:integration`.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** Grab a currently-free localhost port by binding to 0 and reading it back. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll `/api/health` until it answers (any status code) or the deadline passes. */
export async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      // Any HTTP answer means the server is listening; 503 during shutdown still
      // counts as "up". A network error means it's not accepting yet.
      if (res.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`bridge did not become healthy within ${timeoutMs}ms`);
}

/**
 * Spawn `server.mjs` on a free port with the given extra environment, and wait
 * until it is healthy. Resolves with `{ port, child, stop }`; `stop()` kills the
 * child. Production mode is used when a `.next` build exists (CI, right after
 * `npm run build`), dev mode otherwise so a bare checkout still works.
 */
export async function startBridge(env = {}, { readyTimeoutMs = 90_000 } = {}) {
  const port = await getFreePort();
  const hasBuild = existsSync(join(REPO_ROOT, ".next"));
  const child = spawn("node", ["server.mjs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: hasBuild ? "production" : "development",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SSH_LOG: "off",
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitForHealth(port, readyTimeoutMs);
  return {
    port,
    child,
    stop() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
}

/**
 * A WebSocket wrapper that buffers every inbound JSON message so a test can
 * await a predicate against messages that may have already arrived or are still
 * coming.
 */
export class MessageClient {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.inbox.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.predicate(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(predicate, timeoutMs = 10_000) {
    const existing = this.inbox.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(
          new Error(
            `timed out; message types seen: ${this.inbox
              .map((m) => m.t)
              .join(", ")}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}
