/**
 * A tiny in-memory `ssh2` server used as a fake SSH target for the bridge
 * integration smoke test. It is deliberately minimal — just enough of the SSH
 * surface the bridge exercises on a normal login:
 *
 *   • password authentication (a fixed user/password),
 *   • an interactive shell that echoes back whatever it receives, and
 *   • an SFTP subsystem serving one hard-coded directory listing (REALPATH +
 *     OPENDIR/READDIR + STAT/LSTAT), enough for a `sftp-list` round-trip.
 *
 * It is not a real shell or filesystem; it exists so the bridge's WebSocket ↔
 * SSH relay can be driven end-to-end without a live server. Plain ESM so it can
 * be spawned/imported outside the TypeScript build, mirroring `server.mjs`.
 */
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE } = ssh2.utils.sftp;

export const MOCK_USER = "testuser";
export const MOCK_PASSWORD = "testpass";

/** The fixed listing `sftp-list` will see for any directory. */
const DIR_ENTRIES = [
  { filename: "readme.txt", isDir: false, size: 12 },
  { filename: "projects", isDir: true, size: 4096 },
];

function attrsFor(entry) {
  const mode = entry.isDir ? 0o040755 : 0o100644;
  return { mode, size: entry.size, uid: 1000, gid: 1000, atime: 0, mtime: 0 };
}

function longnameFor(entry) {
  const type = entry.isDir ? "d" : "-";
  return `${type}rw-r--r-- 1 user user ${entry.size} Jan 1 00:00 ${entry.filename}`;
}

function handleSftp(sftp) {
  // Distinct handle buffers so we can tell an open dir from an open file, and
  // track whether a given READDIR has already returned its (single) page.
  const dirDrained = new Set();

  sftp.on("REALPATH", (reqid, givenPath) => {
    const resolved = givenPath === "." ? "/home/testuser" : givenPath;
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
  });

  sftp.on("OPENDIR", (reqid) => {
    const handle = Buffer.from("dir");
    dirDrained.delete(handle.toString());
    sftp.handle(reqid, handle);
  });

  sftp.on("READDIR", (reqid, handle) => {
    const key = handle.toString();
    if (dirDrained.has(key)) {
      sftp.status(reqid, STATUS_CODE.EOF);
      return;
    }
    dirDrained.add(key);
    sftp.name(
      reqid,
      DIR_ENTRIES.map((e) => ({
        filename: e.filename,
        longname: longnameFor(e),
        attrs: attrsFor(e),
      })),
    );
  });

  const statByName = (reqid, p) => {
    const name = String(p).split("/").pop();
    const entry = DIR_ENTRIES.find((e) => e.filename === name) ?? {
      filename: name,
      isDir: true,
      size: 4096,
    };
    sftp.attrs(reqid, attrsFor(entry));
  };
  sftp.on("STAT", statByName);
  sftp.on("LSTAT", statByName);

  sftp.on("OPEN", (reqid) => {
    // No file reads needed for the smoke test; refuse politely.
    sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
  });
  sftp.on("CLOSE", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
}

/**
 * Start the mock server on an ephemeral port. Resolves with `{ port, close }`.
 * `close()` stops accepting and drops connections.
 */
export function startMockSshServer() {
  const hostKey = utils.generateKeyPairSync("ed25519").private;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === MOCK_USER &&
        ctx.password === MOCK_PASSWORD
      ) {
        return ctx.accept();
      }
      // Advertise password as the only method so the client retries it.
      if (ctx.method !== "password") return ctx.reject(["password"]);
      return ctx.reject();
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        // `accept` here is the accept *function* — call it to grant the request.
        session.on("pty", (acceptPty) => {
          try {
            acceptPty?.();
          } catch {
            /* client didn't want a reply */
          }
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("welcome\r\n");
          // Echo whatever the bridge relays from the browser straight back.
          stream.on("data", (data) => stream.write(data));
        });
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          handleSftp(sftp);
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}
