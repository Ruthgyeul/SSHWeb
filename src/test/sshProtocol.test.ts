import { describe, expect, it } from "vitest";
import {
  applyKeyModifiers,
  audioMimeType,
  compareHostKey,
  ctrlChar,
  encodeMessage,
  filterEntries,
  formatMode,
  formatSize,
  hostKeyId,
  imageMimeType,
  isHostAllowed,
  isProbablyAudioFile,
  isProbablyBinaryFile,
  isProbablyImageFile,
  isProbablyPreviewableFile,
  isProbablyTextFile,
  isProbablyVideoFile,
  isThumbnailable,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_VIDEO_MAX_BYTES,
  joinPath,
  forwardLabel,
  previewKind,
  videoMimeType,
  modeToOctal,
  parentPath,
  pathSegments,
  parseAllowlist,
  parseMessage,
  parseOctalMode,
  sortEntries,
  validateConnectInput,
  validateForward,
  type FileEntry,
} from "@/lib/sshProtocol";

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

describe("validateForward", () => {
  const base = {
    bindHost: "127.0.0.1",
    bindPort: 8080,
    destHost: "db.internal",
    destPort: 5432,
  };

  it("accepts a complete forward", () => {
    expect(validateForward(base)).toEqual([]);
  });

  it("flags out-of-range ports and a missing destination host", () => {
    const errors = validateForward({
      ...base,
      bindPort: 0,
      destHost: "  ",
      destPort: 70000,
    });
    expect(errors).toHaveLength(3);
  });

  it("rejects non-numeric ports", () => {
    expect(validateForward({ ...base, bindPort: "abc" })).toContain(
      "Local port must be an integer between 1 and 65535.",
    );
  });
});

describe("forwardLabel", () => {
  it("renders a bind→dest label, normalizing loopback to localhost", () => {
    expect(
      forwardLabel({
        bindHost: "127.0.0.1",
        bindPort: 8080,
        destHost: "db",
        destPort: 5432,
      }),
    ).toBe("localhost:8080 → db:5432");
    expect(
      forwardLabel({
        bindHost: "0.0.0.0",
        bindPort: 80,
        destHost: "web",
        destPort: 8080,
      }),
    ).toBe("0.0.0.0:80 → web:8080");
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

describe("ctrlChar / applyKeyModifiers", () => {
  it("maps letters to control bytes", () => {
    expect(ctrlChar("c")).toBe("\x03");
    expect(ctrlChar("C")).toBe("\x03");
    expect(ctrlChar("a")).toBe("\x01");
    expect(ctrlChar("z")).toBe("\x1a");
  });

  it("maps the symbol control forms", () => {
    expect(ctrlChar("[")).toBe("\x1b");
    expect(ctrlChar("_")).toBe("\x1f");
    expect(ctrlChar(" ")).toBe("\x00");
  });

  it("leaves characters without a control form unchanged", () => {
    expect(ctrlChar("1")).toBe("1");
  });

  it("applies ctrl to a single char", () => {
    expect(applyKeyModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
  });

  it("applies alt as an ESC prefix", () => {
    expect(applyKeyModifiers("f", { ctrl: false, alt: true })).toBe("\x1bf");
  });

  it("combines ctrl+alt", () => {
    expect(applyKeyModifiers("a", { ctrl: true, alt: true })).toBe("\x1b\x01");
  });

  it("passes through when no modifiers or multi-char input", () => {
    expect(applyKeyModifiers("s", { ctrl: false, alt: false })).toBe("s");
    expect(applyKeyModifiers("hello", { ctrl: true, alt: false })).toBe("hello");
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

  it("opens config files edited over SSH (env, systemd, nginx, …)", () => {
    expect(isProbablyTextFile(".env")).toBe(true);
    expect(isProbablyTextFile(".env.local")).toBe(true);
    expect(isProbablyTextFile(".env.production")).toBe(true);
    expect(isProbablyTextFile("app.service")).toBe(true);
    expect(isProbablyTextFile("web.socket")).toBe(true);
    expect(isProbablyTextFile("nginx.conf")).toBe(true);
    expect(isProbablyTextFile("mysite.nginx")).toBe(true);
  });

  it("opens anything vi/nano would: unknown or extensionless files", () => {
    expect(isProbablyTextFile("README")).toBe(true);
    expect(isProbablyTextFile("hosts")).toBe(true);
    expect(isProbablyTextFile("some.weirdext")).toBe(true);
    expect(isProbablyTextFile("mystery")).toBe(true);
  });

  it("returns false for previewable media and known binaries", () => {
    expect(isProbablyTextFile("photo.png")).toBe(false);
    expect(isProbablyTextFile("clip.mp4")).toBe(false);
    expect(isProbablyTextFile("archive.tar.gz")).toBe(false);
    expect(isProbablyTextFile("app.exe")).toBe(false);
    expect(isProbablyTextFile("lib.so")).toBe(false);
    expect(isProbablyTextFile("doc.pdf")).toBe(false);
    expect(isProbablyTextFile("font.woff2")).toBe(false);
  });
});

describe("isProbablyBinaryFile", () => {
  it("flags known binary extensions (case-insensitive)", () => {
    expect(isProbablyBinaryFile("archive.ZIP")).toBe(true);
    expect(isProbablyBinaryFile("data.sqlite3")).toBe(true);
    expect(isProbablyBinaryFile("song.mp3")).toBe(true);
  });

  it("does not flag text/config or extensionless files", () => {
    expect(isProbablyBinaryFile("notes.md")).toBe(false);
    expect(isProbablyBinaryFile("app.service")).toBe(false);
    expect(isProbablyBinaryFile("README")).toBe(false);
  });
});

describe("image detection", () => {
  it("recognizes images by extension (case-insensitive)", () => {
    expect(isProbablyImageFile("photo.png")).toBe(true);
    expect(isProbablyImageFile("Banner.JPG")).toBe(true);
    expect(isProbablyImageFile("logo.svg")).toBe(true);
    expect(isProbablyImageFile("anim.apng")).toBe(true);
    expect(isProbablyImageFile("scan.JFIF")).toBe(true);
  });

  it("returns false for non-images", () => {
    expect(isProbablyImageFile("notes.md")).toBe(false);
    expect(isProbablyImageFile("noextension")).toBe(false);
  });

  it("maps extensions to MIME types", () => {
    expect(imageMimeType("a.png")).toBe("image/png");
    expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("a.JPG")).toBe("image/jpeg");
    expect(imageMimeType("a.svg")).toBe("image/svg+xml");
    expect(imageMimeType("a.txt")).toBeNull();
    expect(imageMimeType("noext")).toBeNull();
  });
});

describe("isThumbnailable", () => {
  const mk = (over: Partial<FileEntry>): FileEntry => ({
    name: "photo.png",
    type: "file",
    size: 1024,
    mtime: 0,
    mode: 0,
    ...over,
  });

  it("accepts a small image file", () => {
    expect(isThumbnailable(mk({}))).toBe(true);
    expect(isThumbnailable(mk({ name: "a.JPG", size: THUMBNAIL_MAX_BYTES }))).toBe(
      true,
    );
  });

  it("accepts a small video file (up to the larger video cap)", () => {
    expect(isThumbnailable(mk({ name: "clip.mp4", size: 1024 }))).toBe(true);
    expect(
      isThumbnailable(mk({ name: "Movie.MOV", size: THUMBNAIL_VIDEO_MAX_BYTES })),
    ).toBe(true);
    // A video between the image and video caps is still thumbnailable.
    expect(
      isThumbnailable(mk({ name: "clip.webm", size: THUMBNAIL_MAX_BYTES + 1 })),
    ).toBe(true);
  });

  it("rejects non-media files", () => {
    expect(isThumbnailable(mk({ name: "notes.md" }))).toBe(false);
    expect(isThumbnailable(mk({ name: "archive.zip" }))).toBe(false);
  });

  it("rejects directories and links even with media-like names", () => {
    expect(isThumbnailable(mk({ type: "dir", name: "images.png" }))).toBe(false);
    expect(isThumbnailable(mk({ type: "link", name: "shortcut.png" }))).toBe(
      false,
    );
    expect(isThumbnailable(mk({ type: "link", name: "clip.mp4" }))).toBe(false);
  });

  it("rejects media larger than its cap", () => {
    expect(isThumbnailable(mk({ size: THUMBNAIL_MAX_BYTES + 1 }))).toBe(false);
    expect(
      isThumbnailable(mk({ name: "big.mp4", size: THUMBNAIL_VIDEO_MAX_BYTES + 1 })),
    ).toBe(false);
  });
});

describe("video detection", () => {
  it("recognizes videos by extension (case-insensitive)", () => {
    expect(isProbablyVideoFile("clip.mp4")).toBe(true);
    expect(isProbablyVideoFile("Recording.MOV")).toBe(true);
    expect(isProbablyVideoFile("screen.webm")).toBe(true);
  });

  it("returns false for non-videos", () => {
    expect(isProbablyVideoFile("photo.png")).toBe(false);
    expect(isProbablyVideoFile("notes.md")).toBe(false);
    expect(isProbablyVideoFile("noextension")).toBe(false);
  });

  it("maps extensions to MIME types", () => {
    expect(videoMimeType("a.mp4")).toBe("video/mp4");
    expect(videoMimeType("a.m4v")).toBe("video/mp4");
    expect(videoMimeType("a.MOV")).toBe("video/quicktime");
    expect(videoMimeType("a.webm")).toBe("video/webm");
    expect(videoMimeType("a.png")).toBeNull();
    expect(videoMimeType("noext")).toBeNull();
  });
});

describe("audio detection", () => {
  it("recognizes audio by extension (case-insensitive)", () => {
    expect(isProbablyAudioFile("song.mp3")).toBe(true);
    expect(isProbablyAudioFile("Voice.WAV")).toBe(true);
    expect(isProbablyAudioFile("track.flac")).toBe(true);
  });

  it("returns false for non-audio", () => {
    expect(isProbablyAudioFile("photo.png")).toBe(false);
    expect(isProbablyAudioFile("clip.mp4")).toBe(false);
    expect(isProbablyAudioFile("noextension")).toBe(false);
  });

  it("maps extensions to MIME types", () => {
    expect(audioMimeType("a.mp3")).toBe("audio/mpeg");
    expect(audioMimeType("a.WAV")).toBe("audio/wav");
    expect(audioMimeType("a.m4a")).toBe("audio/mp4");
    expect(audioMimeType("a.flac")).toBe("audio/flac");
    expect(audioMimeType("a.png")).toBeNull();
    expect(audioMimeType("noext")).toBeNull();
  });
});

describe("previewKind / isProbablyPreviewableFile", () => {
  it("classifies images, videos and audio, null otherwise", () => {
    expect(previewKind("photo.png")).toBe("image");
    expect(previewKind("Banner.JPG")).toBe("image");
    expect(previewKind("clip.mp4")).toBe("video");
    expect(previewKind("Recording.MOV")).toBe("video");
    expect(previewKind("song.mp3")).toBe("audio");
    expect(previewKind("Voice.WAV")).toBe("audio");
    expect(previewKind("notes.md")).toBeNull();
    expect(previewKind("noext")).toBeNull();
  });

  it("is previewable exactly when it is an image, a video or audio", () => {
    expect(isProbablyPreviewableFile("photo.png")).toBe(true);
    expect(isProbablyPreviewableFile("clip.mov")).toBe(true);
    expect(isProbablyPreviewableFile("song.mp3")).toBe(true);
    expect(isProbablyPreviewableFile("notes.md")).toBe(false);
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

describe("filterEntries", () => {
  const entries: FileEntry[] = [
    { name: "README.md", type: "file", size: 1, mtime: 0, mode: 0 },
    { name: "src", type: "dir", size: 0, mtime: 0, mode: 0 },
    { name: "server.mjs", type: "file", size: 1, mtime: 0, mode: 0 },
  ];

  it("matches names case-insensitively as a substring", () => {
    expect(filterEntries(entries, "SER").map((e) => e.name)).toEqual([
      "server.mjs",
    ]);
    expect(filterEntries(entries, "s").map((e) => e.name)).toEqual([
      "src",
      "server.mjs",
    ]);
  });

  it("returns the list unchanged for a blank query and preserves order", () => {
    expect(filterEntries(entries, "")).toBe(entries);
    expect(filterEntries(entries, "   ")).toBe(entries);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterEntries(entries, "nope")).toEqual([]);
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

describe("pathSegments", () => {
  it("builds cumulative breadcrumb segments", () => {
    expect(pathSegments("/home/user/docs")).toEqual([
      { name: "home", path: "/home" },
      { name: "user", path: "/home/user" },
      { name: "docs", path: "/home/user/docs" },
    ]);
  });

  it("returns an empty list for root and for non-absolute paths", () => {
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments("~")).toEqual([]);
  });

  it("collapses duplicate and trailing slashes", () => {
    expect(pathSegments("/a//b/")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });
});
