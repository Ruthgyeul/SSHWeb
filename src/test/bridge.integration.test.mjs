/**
 * End-to-end smoke test for the WebSocket ↔ SSH bridge in `server.mjs`.
 *
 * Unlike the rest of the suite (pure unit tests of `src/lib` helpers), this
 * boots the *real* server as a child process and drives a full session against
 * an in-memory `ssh2` target (`helpers/mockSshServer.mjs`): host-key TOFU →
 * connected → caps → shell echo → ping/pong → an SFTP directory listing. It's
 * the safety net the bigger `server.mjs` refactors were missing — if the wire
 * protocol, the handshake, or the SFTP list path regress, this goes red.
 *
 * It is deliberately NOT part of `npm test`: the default vitest config only
 * globs `src/**\/*.test.ts`, so this `.mjs` file is skipped there and runs only
 * via `npm run test:integration` (its own config, generous timeouts). The
 * server runs in production mode when a `.next` build is present (CI, right
 * after `npm run build`) and falls back to dev mode otherwise, so it works
 * locally with no prior build.
 */
import { once } from "node:events";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";

import {
  startMockSshServer,
  MOCK_USER,
  MOCK_PASSWORD,
  MOCK_FILE_PATH,
  MOCK_FILE_CONTENT,
} from "./helpers/mockSshServer.mjs";
import { startBridge, MessageClient } from "./helpers/bridgeHarness.mjs";

describe("WebSocket ↔ SSH bridge (end-to-end)", () => {
  let target;
  let bridge;
  let client;
  let port;

  beforeAll(async () => {
    target = await startMockSshServer();
    bridge = await startBridge();
    port = bridge.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ssh`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    await once(ws, "open");
    client = new MessageClient(ws);

    // Kick off the login and complete the trust-on-first-use host-key prompt.
    client.send({
      t: "connect",
      host: "127.0.0.1",
      port: target.port,
      username: MOCK_USER,
      password: MOCK_PASSWORD,
      cols: 80,
      rows: 24,
    });
    const hostkey = await client.waitFor((m) => m.t === "hostkey");
    expect(hostkey.fingerprint).toMatch(/^SHA256:/);
    client.send({ t: "hostkey-response", accept: true });
  }, 120_000);

  afterAll(() => {
    try {
      client?.ws.close();
    } catch {
      /* already closed */
    }
    bridge?.stop();
    target?.close();
  });

  it("reaches the connected state and advertises capabilities", async () => {
    const connected = await client.waitFor(
      (m) => m.t === "status" && m.state === "connected",
    );
    expect(connected.state).toBe("connected");
    const caps = await client.waitFor((m) => m.t === "caps");
    expect(caps).toHaveProperty("streamToken");
    expect(typeof caps.streamToken).toBe("string");
  });

  it("relays shell I/O (the mock echoes input back)", async () => {
    // The mock writes a banner when the shell opens, proving the channel is up.
    await client.waitFor(
      (m) =>
        m.t === "data" &&
        Buffer.from(m.data, "base64").toString().includes("welcome"),
    );
    // Up-data is raw UTF-8; down-data is base64. Send a marker and see it echoed.
    const marker = `probe-${Date.now()}`;
    client.send({ t: "data", data: `${marker}\n` });
    const echoed = await client.waitFor(
      (m) =>
        m.t === "data" &&
        Buffer.from(m.data, "base64").toString().includes(marker),
    );
    expect(Buffer.from(echoed.data, "base64").toString()).toContain(marker);
  });

  it("answers a latency ping with a matching pong", async () => {
    const ts = 987654321;
    client.send({ t: "ping", ts });
    const pong = await client.waitFor((m) => m.t === "pong");
    expect(pong.ts).toBe(ts);
  });

  it("lists a directory over SFTP", async () => {
    client.send({ t: "sftp-list", path: "." });
    const list = await client.waitFor((m) => m.t === "sftp-list");
    expect(list.path).toBe("/home/testuser");
    const byName = Object.fromEntries(
      list.entries.map((e) => [e.name, e.type]),
    );
    expect(byName["readme.txt"]).toBe("file");
    expect(byName["projects"]).toBe("dir");
  });

  it("reads a file's bytes for the editor (single-frame edit read)", async () => {
    client.send({ t: "sftp-read", path: MOCK_FILE_PATH, edit: true });
    const read = await client.waitFor((m) => m.t === "sftp-read" && m.edit);
    expect(Buffer.from(read.dataB64, "base64").toString()).toBe(
      MOCK_FILE_CONTENT,
    );
  });

  it("streams a plain download and its resumable continuation (#41)", async () => {
    // A whole-file plain download streams over the download frames.
    client.send({ t: "sftp-read", path: MOCK_FILE_PATH });
    const begin = await client.waitFor(
      (m) => m.t === "sftp-download-begin" && m.path === MOCK_FILE_PATH,
    );
    expect(begin.size).toBe(MOCK_FILE_CONTENT.length);
    expect(begin.offset).toBeUndefined(); // fresh stream from 0
    await client.waitFor(
      (m) => m.t === "sftp-download-end" && m.path === MOCK_FILE_PATH,
    );
    const whole = Buffer.concat(
      client.inbox
        .filter(
          (m) => m.t === "sftp-download-chunk" && m.path === MOCK_FILE_PATH,
        )
        .map((m) => Buffer.from(m.dataB64, "base64")),
    );
    expect(whole.toString()).toBe(MOCK_FILE_CONTENT);

    // Resume from a byte offset: the client passes the file's `size:mtime`
    // version so the bridge can confirm the file is unchanged before honoring
    // the offset. With a matching version the begin echoes the offset and only
    // the tail (from that offset) is streamed. Derive the version from a listing
    // exactly as the client (`fileVersionTag`) does.
    client.inbox.length = 0;
    client.send({ t: "sftp-list", path: "/home/testuser" });
    const listing = await client.waitFor((m) => m.t === "sftp-list");
    const entry = listing.entries.find((e) => e.name === "readme.txt");
    const version = `${entry.size}:${entry.mtime}`;
    const resumeAt = 6;
    client.inbox.length = 0;
    client.send({
      t: "sftp-read",
      path: MOCK_FILE_PATH,
      resumeOffset: resumeAt,
      resumeVersion: version,
    });
    const rbegin = await client.waitFor(
      (m) => m.t === "sftp-download-begin" && m.path === MOCK_FILE_PATH,
    );
    expect(rbegin.size).toBe(MOCK_FILE_CONTENT.length); // full size, not the tail
    expect(rbegin.offset).toBe(resumeAt);
    await client.waitFor(
      (m) => m.t === "sftp-download-end" && m.path === MOCK_FILE_PATH,
    );
    const tail = Buffer.concat(
      client.inbox
        .filter(
          (m) => m.t === "sftp-download-chunk" && m.path === MOCK_FILE_PATH,
        )
        .map((m) => Buffer.from(m.dataB64, "base64")),
    );
    expect(tail.toString()).toBe(MOCK_FILE_CONTENT.slice(resumeAt));

    // A stale/mismatched version must NOT be honored — the bridge restarts the
    // stream from 0 (no `offset`), so a changed file can't save a corrupt hybrid.
    client.inbox.length = 0;
    client.send({
      t: "sftp-read",
      path: MOCK_FILE_PATH,
      resumeOffset: resumeAt,
      resumeVersion: "999999:0",
    });
    const stale = await client.waitFor(
      (m) => m.t === "sftp-download-begin" && m.path === MOCK_FILE_PATH,
    );
    expect(stale.offset).toBeUndefined();
    await client.waitFor(
      (m) => m.t === "sftp-download-end" && m.path === MOCK_FILE_PATH,
    );
    const restarted = Buffer.concat(
      client.inbox
        .filter(
          (m) => m.t === "sftp-download-chunk" && m.path === MOCK_FILE_PATH,
        )
        .map((m) => Buffer.from(m.dataB64, "base64")),
    );
    expect(restarted.toString()).toBe(MOCK_FILE_CONTENT);
    // Leave the shared inbox free of download-chunk frames for the next test.
    client.inbox.length = 0;
  });

  it("streams a store-only ZIP for a multi-file download", async () => {
    client.send({ t: "sftp-download-many", paths: [MOCK_FILE_PATH] });
    const begin = await client.waitFor(
      (m) => m.t === "sftp-download-begin" && m.name === "download.zip",
    );
    const key = begin.path;
    await client.waitFor((m) => m.t === "sftp-download-end" && m.path === key);
    // Reassemble the archive from the streamed chunk frames (inbox order).
    const zip = Buffer.concat(
      client.inbox
        .filter((m) => m.t === "sftp-download-chunk" && m.path === key)
        .map((m) => Buffer.from(m.dataB64, "base64")),
    );

    // End-of-central-directory sits in the last 22 bytes (no comment).
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(1); // one entry
    const centralOffset = zip.readUInt32LE(end + 16);

    // Central-directory record → name, size, local-header offset.
    expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50);
    const size = zip.readUInt32LE(centralOffset + 20);
    const nameLen = zip.readUInt16LE(centralOffset + 28);
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    expect(
      zip.subarray(centralOffset + 46, centralOffset + 46 + nameLen).toString(),
    ).toBe("readme.txt");

    // The stored data round-trips, and a data descriptor follows it.
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataStart = localOffset + 30 + nameLen;
    expect(zip.subarray(dataStart, dataStart + size).toString()).toBe(
      MOCK_FILE_CONTENT,
    );
    expect(zip.readUInt32LE(dataStart + size)).toBe(0x08074b50);
  });

  it("acknowledges mkdir with sftp-ok", async () => {
    client.send({ t: "sftp-mkdir", path: "/home/testuser/newdir" });
    const ok = await client.waitFor(
      (m) => m.t === "sftp-ok" && m.op === "mkdir",
    );
    expect(ok.path).toBe("/home/testuser/newdir");
  });

  it("acknowledges rename with sftp-ok (reporting the new path)", async () => {
    client.send({
      t: "sftp-rename",
      from: "/home/testuser/a.txt",
      to: "/home/testuser/b.txt",
    });
    const ok = await client.waitFor(
      (m) => m.t === "sftp-ok" && m.op === "rename",
    );
    expect(ok.path).toBe("/home/testuser/b.txt");
  });

  it("acknowledges rm with sftp-ok", async () => {
    client.send({ t: "sftp-rm", path: "/home/testuser/gone.txt" });
    const ok = await client.waitFor((m) => m.t === "sftp-ok" && m.op === "rm");
    expect(ok.path).toBe("/home/testuser/gone.txt");
  });

  it("streams an initial tail for a followed file, then stops (#47)", async () => {
    client.send({ t: "sftp-follow", path: MOCK_FILE_PATH });
    const data = await client.waitFor(
      (m) => m.t === "sftp-follow-data" && m.initial,
    );
    expect(Buffer.from(data.dataB64, "base64").toString()).toBe(
      MOCK_FILE_CONTENT,
    );
    client.send({ t: "sftp-follow-stop", path: MOCK_FILE_PATH });
  });

  it("writes an uploaded chunk and acks with sftp-ok", async () => {
    // A single-chunk chunked upload (offset 0, final) → open, write, close, ack.
    client.send({
      t: "sftp-write",
      path: "/home/testuser/upload.txt",
      offset: 0,
      final: true,
      dataB64: Buffer.from("uploaded bytes").toString("base64"),
    });
    const ok = await client.waitFor(
      (m) => m.t === "sftp-ok" && m.op === "write",
    );
    expect(ok.path).toBe("/home/testuser/upload.txt");
  });
});
