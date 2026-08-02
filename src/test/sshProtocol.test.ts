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
  isBrowserRenderableImage,
  isHostAllowed,
  isProbablyAudioFile,
  isProbablyBinaryFile,
  isProbablyImageFile,
  isProbablyPreviewableFile,
  isProbablyTextFile,
  isProbablyVideoFile,
  isResizablePreviewImage,
  isThumbnailable,
  filePreviewKind,
  videoNeedsTranscode,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_VIDEO_MAX_BYTES,
  joinPath,
  forwardLabel,
  previewKind,
  sniffMediaKind,
  videoMimeType,
  modeToOctal,
  parentPath,
  pathSegments,
  parseAllowlist,
  parseMessage,
  parseOctalMode,
  sortEntries,
  sortEntriesBy,
  summarizeUploads,
  grepFirstMatch,
  DEFAULT_SORT_DIR,
  isLargeForEditor,
  EDITOR_WARN_BYTES,
  suggestCopyName,
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
    kind: "local" as const,
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

  it("labels the port error 'Remote port' for a remote forward", () => {
    expect(
      validateForward({ ...base, kind: "remote", bindPort: 0 }),
    ).toContain("Remote port must be an integer between 1 and 65535.");
  });

  it("only requires a listen port for a dynamic (SOCKS) forward", () => {
    expect(
      validateForward({
        kind: "dynamic",
        bindHost: "127.0.0.1",
        bindPort: 1080,
        destHost: "",
        destPort: "",
      }),
    ).toEqual([]);
    expect(
      validateForward({
        kind: "dynamic",
        bindHost: "127.0.0.1",
        bindPort: 0,
        destHost: "",
        destPort: "",
      }),
    ).toHaveLength(1);
  });
});

describe("forwardLabel", () => {
  it("renders a bind→dest label, normalizing loopback to localhost", () => {
    expect(
      forwardLabel({
        kind: "local",
        bindHost: "127.0.0.1",
        bindPort: 8080,
        destHost: "db",
        destPort: 5432,
      }),
    ).toBe("localhost:8080 → db:5432");
    expect(
      forwardLabel({
        kind: "local",
        bindHost: "0.0.0.0",
        bindPort: 80,
        destHost: "web",
        destPort: 8080,
      }),
    ).toBe("0.0.0.0:80 → web:8080");
  });

  it("labels remote and dynamic forwards distinctly", () => {
    expect(
      forwardLabel({
        kind: "remote",
        bindHost: "127.0.0.1",
        bindPort: 9000,
        destHost: "localhost",
        destPort: 3000,
      }),
    ).toBe("remote localhost:9000 → localhost:3000");
    expect(
      forwardLabel({
        kind: "dynamic",
        bindHost: "127.0.0.1",
        bindPort: 1080,
        destHost: "",
        destPort: 0,
      }),
    ).toBe("SOCKS localhost:1080");
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

describe("isResizablePreviewImage", () => {
  it("downscales ordinary raster images", () => {
    expect(isResizablePreviewImage("photo.jpg")).toBe(true);
    expect(isResizablePreviewImage("Banner.PNG")).toBe(true);
    expect(isResizablePreviewImage("shot.webp")).toBe(true);
    expect(isResizablePreviewImage("pic.avif")).toBe(true);
  });

  it("streams vector / animated images as their originals", () => {
    // SVG is vector (rasterizing loses scalability); GIF may be animated
    // (a sharp WebP downscale would drop to a single frame).
    expect(isResizablePreviewImage("logo.svg")).toBe(false);
    expect(isResizablePreviewImage("anim.GIF")).toBe(false);
  });

  it("returns false for non-images", () => {
    expect(isResizablePreviewImage("notes.md")).toBe(false);
    expect(isResizablePreviewImage("clip.mp4")).toBe(false);
    expect(isResizablePreviewImage("noextension")).toBe(false);
  });
});

describe("isLargeForEditor", () => {
  it("flags files strictly larger than the warn threshold", () => {
    expect(isLargeForEditor(0)).toBe(false);
    expect(isLargeForEditor(EDITOR_WARN_BYTES)).toBe(false);
    expect(isLargeForEditor(EDITOR_WARN_BYTES + 1)).toBe(true);
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

describe("sniffMediaKind", () => {
  /** Build a byte array from a signature prefix, padded to at least 12 bytes. */
  const sig = (...bytes: number[]) => {
    const out = new Uint8Array(Math.max(12, bytes.length));
    out.set(bytes);
    return out;
  };
  const ascii = (s: string, offset = 0) => {
    const out = new Uint8Array(Math.max(12, offset + s.length));
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
    return out;
  };

  it("detects images by magic number", () => {
    expect(sniffMediaKind(sig(0x89, 0x50, 0x4e, 0x47))).toBe("image"); // PNG
    expect(sniffMediaKind(sig(0xff, 0xd8, 0xff))).toBe("image"); // JPEG
    expect(sniffMediaKind(ascii("GIF89a"))).toBe("image"); // GIF
    expect(sniffMediaKind(sig(0x42, 0x4d))).toBe("image"); // BMP
    const webp = ascii("RIFF");
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    expect(sniffMediaKind(webp)).toBe("image");
  });

  it("detects PDF, video and audio signatures", () => {
    expect(sniffMediaKind(ascii("%PDF-1.7"))).toBe("pdf");
    expect(sniffMediaKind(ascii("ftyp", 4))).toBe("video"); // MP4/MOV
    expect(sniffMediaKind(sig(0x1a, 0x45, 0xdf, 0xa3))).toBe("video"); // WebM
    expect(sniffMediaKind(ascii("OggS"))).toBe("audio");
    expect(sniffMediaKind(ascii("fLaC"))).toBe("audio");
    expect(sniffMediaKind(ascii("ID3"))).toBe("audio"); // MP3
    const wav = ascii("RIFF");
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffMediaKind(wav)).toBe("audio");
  });

  it("returns null for text and unknown bytes", () => {
    expect(sniffMediaKind(ascii("#!/bin/sh\necho hi\n"))).toBeNull();
    expect(sniffMediaKind(ascii("{ \"json\": true }"))).toBeNull();
    expect(sniffMediaKind(new Uint8Array(4))).toBeNull(); // too short
  });

  it("distinguishes HEIC/AVIF (image) from MP4 (video) by ISO brand", () => {
    const brand = (b: string) => {
      const out = new Uint8Array(16);
      out.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
      for (let i = 0; i < b.length; i++) out[8 + i] = b.charCodeAt(i);
      return out;
    };
    expect(sniffMediaKind(brand("heic"))).toBe("image");
    expect(sniffMediaKind(brand("mif1"))).toBe("image");
    expect(sniffMediaKind(brand("avif"))).toBe("image");
    expect(sniffMediaKind(brand("isom"))).toBe("video"); // ordinary MP4
    expect(sniffMediaKind(brand("qt  "))).toBe("video"); // MOV
  });
});

describe("HEIC/HEIF handling", () => {
  it("routes HEIC/HEIF as previewable images", () => {
    for (const n of ["photo.heic", "IMG.HEIF", "clip.heics", "x.heifs"]) {
      expect(imageMimeType(n)).not.toBeNull();
      expect(isProbablyImageFile(n)).toBe(true);
      expect(filePreviewKind(n)).toBe("image");
      // They must be transcoded (never streamed raw to an <img>).
      expect(isResizablePreviewImage(n)).toBe(true);
      expect(isBrowserRenderableImage(n)).toBe(false);
    }
  });

  it("keeps ordinary images browser-renderable", () => {
    for (const n of ["a.png", "b.jpg", "c.webp", "d.gif", "e.avif", "f.svg"]) {
      expect(isBrowserRenderableImage(n)).toBe(true);
    }
    expect(isBrowserRenderableImage("notes.txt")).toBe(false); // not an image
  });
});

describe("videoNeedsTranscode", () => {
  it("flags containers browsers can't play natively", () => {
    for (const n of ["a.avi", "b.wmv", "c.flv", "d.ts", "e.m2ts", "f.mpg", "g.vob", "h.3gp"]) {
      expect(videoNeedsTranscode(n)).toBe(true);
      expect(isProbablyVideoFile(n)).toBe(true); // still recognised as a video
      expect(filePreviewKind(n)).toBe("video");
    }
  });

  it("leaves natively-playable containers alone", () => {
    for (const n of ["a.mp4", "b.webm", "c.mov", "d.mkv", "e.m4v"]) {
      expect(videoNeedsTranscode(n)).toBe(false);
    }
    expect(videoNeedsTranscode("photo.jpg")).toBe(false);
    expect(videoNeedsTranscode("noext")).toBe(false);
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

describe("sortEntriesBy", () => {
  const entries: FileEntry[] = [
    { name: "big.bin", type: "file", size: 900, mtime: 100, mode: 0 },
    { name: "src", type: "dir", size: 0, mtime: 500, mode: 0 },
    { name: "small.txt", type: "file", size: 10, mtime: 300, mode: 0 },
    { name: "docs", type: "dir", size: 0, mtime: 200, mode: 0 },
    { name: "mid.log", type: "file", size: 100, mtime: 200, mode: 0 },
  ];

  it("keeps directories first regardless of the sort field or direction", () => {
    for (const key of ["name", "size", "mtime"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const sorted = sortEntriesBy(entries, key, dir);
        expect(sorted.slice(0, 2).every((e) => e.type === "dir")).toBe(true);
        expect(sorted.slice(2).every((e) => e.type === "file")).toBe(true);
      }
    }
  });

  it("sorts files by size ascending and descending", () => {
    expect(
      sortEntriesBy(entries, "size", "asc")
        .filter((e) => e.type === "file")
        .map((e) => e.name),
    ).toEqual(["small.txt", "mid.log", "big.bin"]);
    expect(
      sortEntriesBy(entries, "size", "desc")
        .filter((e) => e.type === "file")
        .map((e) => e.name),
    ).toEqual(["big.bin", "mid.log", "small.txt"]);
  });

  it("sorts by mtime, breaking ties by name (ascending) in both directions", () => {
    // mid.log and docs both have mtime 200; docs is a dir so it leads, and the
    // name tiebreak stays ascending even when the direction is descending.
    expect(sortEntriesBy(entries, "mtime", "desc").map((e) => e.name)).toEqual([
      "src", // dir, mtime 500
      "docs", // dir, mtime 200
      "small.txt", // 300
      "mid.log", // 200
      "big.bin", // 100
    ]);
  });

  it("does not mutate its input", () => {
    const copy = [...entries];
    sortEntriesBy(entries, "size", "desc");
    expect(entries).toEqual(copy);
  });

  it("exposes sensible default directions per key", () => {
    expect(DEFAULT_SORT_DIR).toEqual({ name: "asc", size: "desc", mtime: "desc" });
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

describe("suggestCopyName", () => {
  it("appends ' copy' before the extension", () => {
    expect(suggestCopyName("report.txt", [])).toBe("report copy.txt");
    expect(suggestCopyName("archive.tar.gz", [])).toBe("archive.tar copy.gz");
  });

  it("handles extensionless names and dotfiles", () => {
    expect(suggestCopyName("Makefile", [])).toBe("Makefile copy");
    expect(suggestCopyName(".bashrc", [])).toBe(".bashrc copy");
  });

  it("increments a counter until the name is free", () => {
    const existing = ["a.txt", "a copy.txt", "a copy 2.txt"];
    expect(suggestCopyName("a.txt", existing)).toBe("a copy 3.txt");
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

describe("summarizeUploads", () => {
  it("returns a complete, 100% summary for an empty batch", () => {
    expect(summarizeUploads([])).toEqual({
      files: 0,
      sent: 0,
      total: 0,
      pct: 100,
      interrupted: false,
      queued: 0,
    });
  });

  it("sums bytes and rounds the overall percentage", () => {
    const s = summarizeUploads([
      { sent: 50, total: 100, status: "uploading" },
      { sent: 25, total: 100, status: "uploading" },
    ]);
    expect(s.files).toBe(2);
    expect(s.sent).toBe(75);
    expect(s.total).toBe(200);
    expect(s.pct).toBe(38); // 75/200 = 37.5 → 38
  });

  it("counts queued items and flags any interruption", () => {
    const s = summarizeUploads([
      { sent: 10, total: 100, status: "uploading" },
      { sent: 0, total: 100, status: "queued" },
      { sent: 0, total: 100, status: "queued" },
      { sent: 40, total: 100, status: "interrupted" },
    ]);
    expect(s.files).toBe(4);
    expect(s.queued).toBe(2);
    expect(s.interrupted).toBe(true);
  });

  it("reports 100% when there are no bytes to move (all empty files)", () => {
    const s = summarizeUploads([
      { sent: 0, total: 0, status: "uploading" },
      { sent: 0, total: 0, status: "queued" },
    ]);
    expect(s.pct).toBe(100);
    expect(s.queued).toBe(1);
  });

  it("clamps the percentage to 0–100 and ignores negative inputs", () => {
    expect(summarizeUploads([{ sent: 150, total: 100 }]).pct).toBe(100);
    const s = summarizeUploads([{ sent: -10, total: -5 }]);
    expect(s.sent).toBe(0);
    expect(s.total).toBe(0);
    expect(s.pct).toBe(100);
  });
});

describe("grepFirstMatch", () => {
  const text = "first line\n  const secret = 42;\nlast line\n";

  it("returns the 1-based line number and a trimmed preview of the first hit", () => {
    expect(grepFirstMatch(text, "secret")).toEqual({
      line: 2,
      preview: "const secret = 42;",
    });
  });

  it("matches case-insensitively", () => {
    expect(grepFirstMatch(text, "SECRET")?.line).toBe(2);
    expect(grepFirstMatch("Hello World", "hello")?.line).toBe(1);
  });

  it("returns null when nothing matches or the query is empty", () => {
    expect(grepFirstMatch(text, "nope")).toBeNull();
    expect(grepFirstMatch(text, "")).toBeNull();
  });

  it("reports only the first matching line", () => {
    expect(grepFirstMatch("a\nfoo\nbar\nfoo", "foo")?.line).toBe(2);
  });

  it("handles CRLF and lone-CR line endings", () => {
    expect(grepFirstMatch("one\r\ntwo\r\nthree", "two")?.line).toBe(2);
    expect(grepFirstMatch("one\rtwo\rthree", "three")?.line).toBe(3);
  });

  it("clamps a long preview to maxPreview and appends an ellipsis", () => {
    const long = `x${"a".repeat(500)}`;
    const hit = grepFirstMatch(long, "x", 10);
    expect(hit).not.toBeNull();
    expect(hit!.preview.endsWith("…")).toBe(true);
    expect(hit!.preview.length).toBe(11); // 10 chars + ellipsis
  });
});
