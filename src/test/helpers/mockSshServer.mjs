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
const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;

export const MOCK_USER = "testuser";
export const MOCK_PASSWORD = "testpass";

/** The one readable file the mock serves (for an edit/download round-trip). */
export const MOCK_FILE_PATH = "/home/testuser/readme.txt";
export const MOCK_FILE_CONTENT = "hello from the mock ssh target\n";
const MOCK_FILE_BUF = Buffer.from(MOCK_FILE_CONTENT);

/** The fixed listing `sftp-list` will see for any directory. */
const DIR_ENTRIES = [
  { filename: "readme.txt", isDir: false, size: MOCK_FILE_BUF.length },
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

  // Minimal read-only file support (OPEN 'r' → FSTAT/READ → CLOSE) so an
  // edit/download round-trip against MOCK_FILE_PATH exercises the read handlers.
  const openFiles = new Map();
  let handleSeq = 0;

  sftp.on("OPEN", (reqid, filename, flags) => {
    const readable = (flags & OPEN_MODE.READ) !== 0;
    if (readable && filename === MOCK_FILE_PATH) {
      const handle = Buffer.from(`file:${handleSeq++}`);
      openFiles.set(handle.toString(), MOCK_FILE_BUF);
      return sftp.handle(reqid, handle);
    }
    // No writable/other files in the mock.
    sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  });

  sftp.on("FSTAT", (reqid, handle) => {
    const buf = openFiles.get(handle.toString());
    if (!buf) return sftp.status(reqid, STATUS_CODE.FAILURE);
    sftp.attrs(reqid, {
      mode: 0o100644,
      size: buf.length,
      uid: 1000,
      gid: 1000,
      atime: 0,
      mtime: 0,
    });
  });

  sftp.on("READ", (reqid, handle, offset, length) => {
    const buf = openFiles.get(handle.toString());
    if (!buf) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (offset >= buf.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, buf.subarray(offset, Math.min(offset + length, buf.length)));
  });

  sftp.on("CLOSE", (reqid, handle) => {
    openFiles.delete(handle.toString());
    sftp.status(reqid, STATUS_CODE.OK);
  });

  // Metadata ops the bridge issues for mkdir / rename / rm / chmod — acknowledge
  // success so the bridge replies with `sftp-ok` (the mock has no real FS).
  const ok = (reqid) => sftp.status(reqid, STATUS_CODE.OK);
  sftp.on("MKDIR", ok);
  sftp.on("RENAME", ok);
  sftp.on("REMOVE", ok);
  sftp.on("RMDIR", ok);
  sftp.on("SETSTAT", ok);
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
