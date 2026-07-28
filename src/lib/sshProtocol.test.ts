import { describe, expect, it } from "vitest";
import {
  compareHostKey,
  encodeMessage,
  formatMode,
  formatSize,
  hostKeyId,
  isHostAllowed,
  isProbablyTextFile,
  joinPath,
  modeToOctal,
  parentPath,
  parseAllowlist,
  parseMessage,
  parseOctalMode,
  sortEntries,
  validateConnectInput,
  type FileEntry,
} from "./sshProtocol";

describe("encode/parse", () => {
  it("round-trips a message", () => {
    const msg = { t: "data", data: "ls -la\n" } as const;
    expect(parseMessage(encodeMessage(msg))).toEqual(msg);
  });

  it("returns null for invalid JSON", () => {
    expect(parseMessage("not json")).toBeNull();
  });

  it("returns null when the discriminator is missing", () => {
    expect(parseMessage('{"foo":1}')).toBeNull();
    expect(parseMessage("42")).toBeNull();
    expect(parseMessage("null")).toBeNull();
  });
});

describe("validateConnectInput", () => {
  const base = {
    host: "example.com",
    port: 22,
    username: "root",
    auth: "password" as const,
    password: "hunter2",
  };

  it("accepts a complete password connection", () => {
    expect(validateConnectInput(base)).toEqual([]);
  });

  it("flags a missing host, username and out-of-range port", () => {
    const errors = validateConnectInput({
      ...base,
      host: "",
      username: "",
      port: 70000,
    });
    expect(errors).toHaveLength(3);
  });

  it("rejects a non-numeric port", () => {
    expect(validateConnectInput({ ...base, port: "abc" })).toContain(
      "Port must be an integer between 1 and 65535.",
    );
  });

  it("requires a password in password mode", () => {
    expect(validateConnectInput({ ...base, password: "" })).toContain(
      "Password is required.",
    );
  });

  it("requires a key in key mode", () => {
    const errors = validateConnectInput({
      ...base,
      auth: "key",
      password: undefined,
      privateKey: "",
    });
    expect(errors).toContain("A private key is required.");
  });
});

describe("isHostAllowed / parseAllowlist", () => {
  it("permits everything when the allowlist is empty", () => {
    expect(isHostAllowed("anything.com", [])).toBe(true);
  });

  it("matches exact hosts case-insensitively", () => {
    expect(isHostAllowed("Example.COM", ["example.com"])).toBe(true);
    expect(isHostAllowed("other.com", ["example.com"])).toBe(false);
  });

  it("supports a *. subdomain wildcard including the bare apex", () => {
    const list = ["*.example.com"];
    expect(isHostAllowed("a.example.com", list)).toBe(true);
    expect(isHostAllowed("deep.a.example.com", list)).toBe(true);
    expect(isHostAllowed("example.com", list)).toBe(true);
    expect(isHostAllowed("notexample.com", list)).toBe(false);
  });

  it("parses comma/whitespace separated allowlists", () => {
    expect(parseAllowlist("a.com, b.com\n c.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe("hostKeyId / compareHostKey", () => {
  it("builds a case-insensitive host:port id", () => {
    expect(hostKeyId("Example.COM", 22)).toBe("example.com:22");
    expect(hostKeyId(" host ", "2222")).toBe("host:2222");
  });

  it("classifies a fingerprint as new / match / changed", () => {
    expect(compareHostKey(undefined, "SHA256:aaa")).toBe("new");
    expect(compareHostKey("SHA256:aaa", "SHA256:aaa")).toBe("match");
    expect(compareHostKey("SHA256:aaa", "SHA256:bbb")).toBe("changed");
  });
});

describe("parseOctalMode / modeToOctal", () => {
  it("parses valid 3–4 digit octal strings", () => {
    expect(parseOctalMode("644")).toBe(0o644);
    expect(parseOctalMode("0755")).toBe(0o755);
    expect(parseOctalMode(" 600 ")).toBe(0o600);
  });

  it("rejects invalid input", () => {
    expect(parseOctalMode("999")).toBeNull();
    expect(parseOctalMode("64")).toBeNull();
    expect(parseOctalMode("rwx")).toBeNull();
    expect(parseOctalMode("")).toBeNull();
  });

  it("round-trips through modeToOctal", () => {
    expect(modeToOctal(0o644)).toBe("644");
    expect(modeToOctal(0o40755 & 0o777)).toBe("755");
  });
});

describe("isProbablyTextFile", () => {
  it("recognizes text by extension", () => {
    expect(isProbablyTextFile("notes.md")).toBe(true);
    expect(isProbablyTextFile("server.mjs")).toBe(true);
    expect(isProbablyTextFile("Config.YAML")).toBe(true);
  });

  it("recognizes common extensionless config files", () => {
    expect(isProbablyTextFile("Dockerfile")).toBe(true);
    expect(isProbablyTextFile(".gitignore")).toBe(true);
  });

  it("returns false for binaries", () => {
    expect(isProbablyTextFile("photo.png")).toBe(false);
    expect(isProbablyTextFile("archive.tar.gz")).toBe(false);
    expect(isProbablyTextFile("binary")).toBe(false);
  });
});

describe("formatMode", () => {
  it("renders a regular file's rwx string", () => {
    expect(formatMode(0o644, "file")).toBe("-rw-r--r--");
    expect(formatMode(0o755, "file")).toBe("-rwxr-xr-x");
  });

  it("prefixes d for directories and l for links", () => {
    expect(formatMode(0o755, "dir")).toBe("drwxr-xr-x");
    expect(formatMode(0o777, "link")).toBe("lrwxrwxrwx");
  });
});

describe("formatSize", () => {
  it("shows a dash for directories", () => {
    expect(formatSize(4096, "dir")).toBe("—");
  });

  it("renders bytes and scaled units", () => {
    expect(formatSize(512, "file")).toBe("512 B");
    expect(formatSize(1024, "file")).toBe("1 KB");
    expect(formatSize(1536, "file")).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024, "file")).toBe("5 MB");
  });
});

describe("sortEntries", () => {
  it("puts directories first, then sorts by name, without mutating input", () => {
    const entries: FileEntry[] = [
      { name: "zeta.txt", type: "file", size: 1, mtime: 0, mode: 0 },
      { name: "src", type: "dir", size: 0, mtime: 0, mode: 0 },
      { name: "Alpha.txt", type: "file", size: 1, mtime: 0, mode: 0 },
      { name: "docs", type: "dir", size: 0, mtime: 0, mode: 0 },
    ];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual([
      "docs",
      "src",
      "Alpha.txt",
      "zeta.txt",
    ]);
    // original untouched
    expect(entries[0].name).toBe("zeta.txt");
  });
});

describe("joinPath / parentPath", () => {
  it("joins and normalizes segments", () => {
    expect(joinPath("/home/user", "docs")).toBe("/home/user/docs");
    expect(joinPath("/home/user", "..")).toBe("/home");
    expect(joinPath("/home/user/./docs", "../pics")).toBe("/home/user/pics");
    expect(joinPath("/", "..")).toBe("/");
  });

  it("collapses duplicate slashes", () => {
    expect(joinPath("/a//b", "c")).toBe("/a/b/c");
  });

  it("returns the parent directory", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/")).toBe("/");
  });
});
