/**
 * End-to-end security-gate tests for the WebSocket ↔ SSH bridge (`server.mjs`).
 *
 * The sibling `bridge.integration.test.mjs` proves the happy path; this file
 * proves the *refusals*: the access-token gate, cross-site origin rejection,
 * per-IP rate limiting, the host allowlist, the SSRF private-host guard,
 * concurrent-session capacity, the idle timeout, graceful shutdown, and the
 * private-key / keyboard-interactive (2FA) auth relays — plus the shape of the
 * `/api/health` payload and its gating. Each block boots its own `server.mjs`
 * with the relevant env (a security posture is process-wide), driven against the
 * in-memory `ssh2` target from `helpers/mockSshServer.mjs` where a real login is
 * needed.
 *
 * Like the smoke test it runs only under `npm run test:integration`.
 */
import { once } from "node:events";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import ssh2 from "ssh2";
import { WebSocket } from "ws";

import {
  startMockSshServer,
  MOCK_USER,
  MOCK_PASSWORD,
  MOCK_OTP,
} from "./helpers/mockSshServer.mjs";
import { startBridge, MessageClient } from "./helpers/bridgeHarness.mjs";

/** Open a bridge WebSocket, defaulting Origin to same-origin (which passes the
 * anti-CSWSH check). Pass `origin: null` to omit the header entirely. */
function openWs(port, { origin, cookie } = {}) {
  const headers = {};
  headers.origin =
    origin === undefined ? `http://127.0.0.1:${port}` : origin || undefined;
  if (cookie) headers.cookie = cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ssh`, { headers });
  // Swallow late socket resets (e.g. when a bridge is killed in afterAll or the
  // graceful-shutdown test), which would otherwise surface as unhandled 'error'
  // events and fail the run. Tests that assert on rejection add their own
  // listener; multiple 'error' listeners coexist fine.
  ws.on("error", () => {});
  return ws;
}

/** Resolve with the HTTP status code of a rejected upgrade, or reject if it
 * unexpectedly opened. The bridge writes a raw `HTTP/1.1 <code> …` and destroys
 * the socket, which the ws client surfaces as `unexpected-response`. */
function expectUpgradeRejected(ws) {
  return new Promise((resolve, reject) => {
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.on("open", () => {
      ws.close();
      reject(new Error("expected the upgrade to be rejected, but it opened"));
    });
    ws.on("error", (err) => {
      const m = /(\d{3})/.exec(err.message || "");
      if (m) resolve(Number(m[1]));
      else reject(err);
    });
  });
}

/** Drive a full connect (through host-key TOFU) to the `connected` state. */
async function connectToMock(client, targetPort, extra = {}) {
  client.send({
    t: "connect",
    host: "127.0.0.1",
    port: targetPort,
    username: MOCK_USER,
    cols: 80,
    rows: 24,
    ...extra,
  });
  await client.waitFor((m) => m.t === "hostkey");
  client.send({ t: "hostkey-response", accept: true });
}

describe("security: access-token gate", () => {
  let bridge;
  const TOKEN = "s3cr3t-access-token";

  beforeAll(async () => {
    bridge = await startBridge({ SSH_ACCESS_TOKEN: TOKEN });
  });
  afterAll(() => bridge?.stop());

  it("advertises that a token is required and the caller is unauthorized", async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/access`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ required: true, authorized: false });
  });

  it("refuses a WebSocket upgrade without the access cookie (401)", async () => {
    const ws = openWs(bridge.port);
    expect(await expectUpgradeRejected(ws)).toBe(401);
  });

  it("rejects a wrong token at POST /api/access (401, no cookie)", async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("exchanges the correct token for a cookie that then authorizes an upgrade", async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/sshweb_access=/);
    expect(setCookie).toMatch(/HttpOnly/);
    // The raw token must never appear in the cookie (a digest is stored).
    expect(setCookie).not.toContain(TOKEN);

    const cookie = setCookie.split(";")[0];
    const ws = openWs(bridge.port, { cookie });
    await once(ws, "open");
    ws.close();
  });

  it("gates the detailed /api/health payload behind the cookie", async () => {
    const bare = await (
      await fetch(`http://127.0.0.1:${bridge.port}/api/health`)
    ).json();
    // Unauthenticated callers get only a readiness signal, no operational metrics.
    expect(bare).toEqual({ status: "ok" });

    const post = await fetch(`http://127.0.0.1:${bridge.port}/api/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = post.headers.get("set-cookie").split(";")[0];
    const full = await (
      await fetch(`http://127.0.0.1:${bridge.port}/api/health`, {
        headers: { cookie },
      })
    ).json();
    expect(full).toHaveProperty("activeSessions");
    expect(full).toHaveProperty("maxSessions");
  });
});

describe("security: WebSocket origin check (anti-CSWSH)", () => {
  let bridge;
  beforeAll(async () => {
    bridge = await startBridge();
  });
  afterAll(() => bridge?.stop());

  it("rejects a cross-site Origin (403)", async () => {
    const ws = openWs(bridge.port, { origin: "http://evil.example.com" });
    expect(await expectUpgradeRejected(ws)).toBe(403);
  });

  it("accepts a same-origin handshake", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    ws.close();
  });

  it("serves a full, dependency-free /api/health payload when open", async () => {
    const body = await (
      await fetch(`http://127.0.0.1:${bridge.port}/api/health`)
    ).json();
    expect(body.status).toBe("ok");
    for (const key of [
      "activeSessions",
      "maxSessions",
      "totalConnections",
      "sftp",
      "thumbnails",
      "transcodes",
      "limits",
      "uptime",
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body.sftp).toHaveProperty("bytesDown");
    expect(body.limits).toHaveProperty("thumbnails");
  });
});

describe("security: per-IP upgrade rate limit", () => {
  let bridge;
  beforeAll(async () => {
    // One upgrade allowed per (long) window, so the second is throttled.
    bridge = await startBridge({
      SSH_RATE_LIMIT_MAX: "1",
      SSH_RATE_LIMIT_WINDOW_MS: "60000",
    });
  });
  afterAll(() => bridge?.stop());

  it("throttles a second upgrade from the same IP (429)", async () => {
    const first = openWs(bridge.port);
    await once(first, "open");
    const second = openWs(bridge.port);
    expect(await expectUpgradeRejected(second)).toBe(429);
    first.close();
  });
});

describe("security: host allowlist", () => {
  let bridge;
  beforeAll(async () => {
    bridge = await startBridge({ SSH_ALLOWED_HOSTS: "example.com" });
  });
  afterAll(() => bridge?.stop());

  it("refuses a connect to a host outside the allowlist", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    client.send({
      t: "connect",
      host: "127.0.0.1",
      port: 22,
      username: "someone",
      cols: 80,
      rows: 24,
    });
    const err = await client.waitFor((m) => m.t === "error");
    expect(err.message).toMatch(/not allowed/i);
    ws.close();
  });
});

describe("security: SSRF private-host guard", () => {
  let bridge;
  beforeAll(async () => {
    bridge = await startBridge({ SSH_BLOCK_PRIVATE_HOSTS: "true" });
  });
  afterAll(() => bridge?.stop());

  it("refuses to dial a loopback/private target", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    client.send({
      t: "connect",
      host: "127.0.0.1",
      port: 22,
      username: "someone",
      cols: 80,
      rows: 24,
    });
    const err = await client.waitFor((m) => m.t === "error");
    expect(err.message).toMatch(/private\/internal hosts are blocked/i);
    ws.close();
  });
});

describe("security: concurrent-session capacity", () => {
  let bridge;
  let target;
  beforeAll(async () => {
    target = await startMockSshServer();
    bridge = await startBridge({ SSH_MAX_SESSIONS: "1" });
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  it("refuses a second session once at capacity", async () => {
    const ws1 = openWs(bridge.port);
    await once(ws1, "open");
    const c1 = new MessageClient(ws1);
    await connectToMock(c1, target.port, { password: MOCK_PASSWORD });
    await c1.waitFor((m) => m.t === "status" && m.state === "connected");

    const ws2 = openWs(bridge.port);
    await once(ws2, "open");
    const c2 = new MessageClient(ws2);
    c2.send({
      t: "connect",
      host: "127.0.0.1",
      port: target.port,
      username: MOCK_USER,
      password: MOCK_PASSWORD,
      cols: 80,
      rows: 24,
    });
    const err = await c2.waitFor((m) => m.t === "error");
    expect(err.message).toMatch(/at capacity/i);
    ws1.close();
    ws2.close();
  });
});

describe("security: idle timeout with warning", () => {
  let bridge;
  let target;
  beforeAll(async () => {
    target = await startMockSshServer();
    bridge = await startBridge({
      SSH_IDLE_TIMEOUT_MS: "4000",
      SSH_IDLE_WARNING_MS: "2000",
    });
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  it("warns then disconnects an inactive session", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    await connectToMock(client, target.port, { password: MOCK_PASSWORD });
    await client.waitFor((m) => m.t === "status" && m.state === "connected");

    // No further shell/SFTP activity → warning, then an inactivity close.
    const warn = await client.waitFor((m) => m.t === "idle-warning", 15_000);
    expect(warn.remainingMs).toBeGreaterThanOrEqual(0);
    const err = await client.waitFor(
      (m) => m.t === "error" && /inactivity/i.test(m.message || ""),
      15_000,
    );
    expect(err.message).toMatch(/inactivity/i);
    ws.close();
  });
});

describe("security: graceful shutdown", () => {
  let bridge;
  let target;
  beforeAll(async () => {
    target = await startMockSshServer();
    bridge = await startBridge();
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  it("drains active sessions and exits on SIGTERM", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    await connectToMock(client, target.port, { password: MOCK_PASSWORD });
    await client.waitFor((m) => m.t === "status" && m.state === "connected");

    const exited = once(bridge.child, "exit");
    bridge.child.kill("SIGTERM");

    const closed = await client.waitFor(
      (m) => m.t === "status" && m.state === "closed",
      15_000,
    );
    expect(closed.message).toMatch(/shutting down/i);
    const [code, signal] = await exited;
    // A clean drain exits 0; treat a signal-terminated exit as acceptable too.
    expect(code === 0 || signal != null).toBe(true);
  });
});

describe("security: private-key authentication", () => {
  let bridge;
  let target;
  beforeAll(async () => {
    target = await startMockSshServer({
      allowPassword: false,
      allowPublicKey: true,
    });
    bridge = await startBridge();
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  it("relays a private key and reaches the connected state", async () => {
    const { private: privateKey } = ssh2.utils.generateKeyPairSync("ed25519");
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    await connectToMock(client, target.port, { privateKey });
    const connected = await client.waitFor(
      (m) => m.t === "status" && m.state === "connected",
    );
    expect(connected.state).toBe("connected");
    ws.close();
  });
});

describe("security: credentials never leak into client-bound frames (#93)", () => {
  let bridge;
  let target;
  const SENTINEL = "LEAK-6c4f7a-do-not-echo";
  const WRONG_PASSWORD = `PW-${SENTINEL}`;
  const BAD_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nKEY-${SENTINEL}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const PASSPHRASE = `PASS-${SENTINEL}`;

  beforeAll(async () => {
    target = await startMockSshServer();
    bridge = await startBridge();
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  /** Fail if any secret sentinel appears in ANY frame the bridge sent back. */
  function assertNoLeak(client) {
    const dump = client.inbox.map((m) => JSON.stringify(m)).join("\n");
    expect(dump).not.toContain(SENTINEL);
  }

  it("does not echo a wrong password in the auth-failure error frame", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    client.send({
      t: "connect",
      host: "127.0.0.1",
      port: target.port,
      username: MOCK_USER,
      password: WRONG_PASSWORD,
      cols: 80,
      rows: 24,
    });
    await client.waitFor((m) => m.t === "hostkey");
    client.send({ t: "hostkey-response", accept: true });
    // Auth fails against the mock (wrong password) → an error frame.
    await client.waitFor((m) => m.t === "error");
    assertNoLeak(client);
    ws.close();
  });

  it("does not echo a private key or passphrase when the key is unparseable", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    client.send({
      t: "connect",
      host: "127.0.0.1",
      port: target.port,
      username: MOCK_USER,
      privateKey: BAD_KEY,
      passphrase: PASSPHRASE,
      cols: 80,
      rows: 24,
    });
    // A malformed key surfaces as an error frame (or a closed status); either
    // way, wait until the bridge has spoken, then scan everything it sent.
    await client.waitFor(
      (m) => m.t === "error" || (m.t === "status" && m.state !== "connecting"),
      15_000,
    );
    // Give any trailing frames a beat to arrive before scanning.
    await new Promise((r) => setTimeout(r, 250));
    assertNoLeak(client);
    ws.close();
  });
});

describe("security: keyboard-interactive (2FA)", () => {
  let bridge;
  let target;
  beforeAll(async () => {
    target = await startMockSshServer({
      allowPassword: false,
      keyboardInteractive: true,
    });
    bridge = await startBridge();
  });
  afterAll(() => {
    bridge?.stop();
    target?.close();
  });

  it("relays the challenge and completes auth with the OTP", async () => {
    const ws = openWs(bridge.port);
    await once(ws, "open");
    const client = new MessageClient(ws);
    await connectToMock(client, target.port);

    const challenge = await client.waitFor((m) => m.t === "kbd-interactive");
    expect(Array.isArray(challenge.prompts)).toBe(true);
    expect(challenge.prompts.length).toBeGreaterThan(0);

    client.send({ t: "kbd-response", responses: [MOCK_OTP] });
    const connected = await client.waitFor(
      (m) => m.t === "status" && m.state === "connected",
    );
    expect(connected.state).toBe("connected");
    ws.close();
  });
});
