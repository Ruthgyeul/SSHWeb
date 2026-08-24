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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import next from "next";
import nextEnv from "@next/env";
import { WebSocketServer } from "ws";
import ssh2 from "ssh2";

const { Client: SSHClient, utils: sshUtils } = ssh2;
const { loadEnvConfig } = nextEnv;

// `sharp` downscales grid thumbnails in-memory (originals are never modified) so
// a directory of hundreds of photos sends KB per tile instead of MB. Every grid
// thumbnail is served as a tiny WebP and nothing else — so `sharp` is required
// for thumbnails: if it can't load in this environment we simply don't render
// grid thumbnails (tiles keep their type icon) rather than ever send a
// full-size, non-WebP original over the wire.
let sharp = null;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.warn(
    "[sshweb] sharp unavailable — grid thumbnails disabled (tiles show icons).",
  );
}

// `ffmpeg` extracts a poster frame from videos so a grid tile shows an actual
// still (downscaled to a tiny WebP, like the photo thumbnails) instead of the
// browser having to download the whole clip and paint frame 0. It's an external
// binary probed once at startup; when it's missing video tiles just show their
// icon (we never send the whole clip as a "thumbnail").
let ffmpegAvailable = false;
try {
  await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    } catch {
      return resolve();
    }
    proc.on("error", () => resolve());
    proc.on("close", (code) => {
      ffmpegAvailable = code === 0;
      resolve();
    });
  });
} catch {
  /* probe failed — treat ffmpeg as unavailable */
}
if (!ffmpegAvailable) {
  console.warn(
    "[sshweb] ffmpeg unavailable — video grid thumbnails disabled (tiles show icons).",
  );
}

/**
 * Run ffmpeg to pull one representative poster frame (PNG bytes) from `-i input`,
 * scaled to fit the thumbnail box, or `null` on any failure. When `stdinBuffer`
 * is given the input is fed on stdin (`pipe:0`); otherwise `input` is a file path
 * ffmpeg can seek in. `thumbnail` picks a frame from the opening of the clip
 * rather than a possibly-black frame 0.
 */
function ffmpegPosterFrame(input, stdinBuffer) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("ffmpeg", [
        "-loglevel",
        "error",
        "-i",
        input,
        "-vf",
        `thumbnail,scale=w=${THUMBNAIL_PIXELS}:h=${THUMBNAIL_PIXELS}:force_original_aspect_ratio=decrease`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ]);
    } catch {
      return resolve(null);
    }
    const chunks = [];
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    // Guard against a hung/very slow decode holding the concurrency slot.
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(null);
    }, FFMPEG_TIMEOUT_MS);
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stdout.on("error", () => {});
    proc.on("error", () => done(null));
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks);
      done(code === 0 && out.length > 0 ? out : null);
    });
    if (stdinBuffer) {
      // ffmpeg stops reading once it has its frame → EPIPE on the write is normal.
      proc.stdin.on("error", () => {});
      proc.stdin.write(stdinBuffer);
      proc.stdin.end();
    }
  });
}

/**
 * Extract a representative poster frame from a video buffer via ffmpeg, scaled to
 * fit the thumbnail box (PNG bytes, or `null` on failure). The original file is
 * never modified. Tries the disk-free **stdin pipe** first (works for faststart
 * clips); if that yields nothing, falls back to a **short-lived temp file** so
 * ffmpeg has a *seekable* input — needed for the common case of an MP4/MOV whose
 * `moov` atom sits at the end of the file (most phone recordings), which a
 * non-seekable pipe can't decode. The temp file is deleted immediately after.
 */
async function extractVideoFrame(buffer) {
  const piped = await ffmpegPosterFrame("pipe:0", buffer);
  if (piped) return piped;
  let tmp = null;
  try {
    tmp = join(tmpdir(), `sshweb-poster-${randomBytes(8).toString("hex")}`);
    await writeFile(tmp, buffer);
    return await ffmpegPosterFrame(tmp, null);
  } catch {
    return null;
  } finally {
    if (tmp) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

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

// Opt-in SSRF guard: refuse to dial private/internal targets (loopback, RFC1918
// ranges, link-local incl. the 169.254.169.254 cloud-metadata endpoint, IPv6
// ULA/link-local, and `localhost`). Off by default so a self-hosted deploy can
// still reach hosts on its own LAN; turn it on for a public relay.
const BLOCK_PRIVATE_HOSTS =
  (process.env.SSH_BLOCK_PRIVATE_HOSTS || "false").toLowerCase() === "true";

const MAX_SESSIONS = parseInt(process.env.SSH_MAX_SESSIONS || "25", 10);
// Cap a single SFTP download so a huge file can't exhaust server memory.
// Configured in whole megabytes; 0 (or less) disables the limit.
const MAX_DOWNLOAD_MB = parseInt(process.env.SSH_MAX_DOWNLOAD_MB || "25", 10);
const MAX_DOWNLOAD_BYTES =
  MAX_DOWNLOAD_MB > 0 ? MAX_DOWNLOAD_MB * 1024 * 1024 : 0;
// Absolute ceiling on a file fetched whole to feed a file-browser grid
// thumbnail. Mirrors `THUMBNAIL_VIDEO_MAX_BYTES` in src/lib/sshProtocol.ts (the
// larger of the image/video caps) — a `thumb` read past it is silently ignored
// so a client can't pull a huge file "as a thumbnail". The client also gates
// per-type via `isThumbnailable` (32 MB images / 64 MB videos), which is a
// bandwidth nicety rather than the security bound.
const THUMBNAIL_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
// Max PDF size the bridge will read to rasterize a first-page thumbnail. Mirrors
// `THUMBNAIL_PDF_MAX_BYTES` in src/lib/sshProtocol.ts and is enforced server-side
// so a direct WebSocket client can't force a larger PDF read than the client
// helper allows (#77 review).
const THUMBNAIL_PDF_MAX_BYTES = 16 * 1024 * 1024;
// Longest edge (px) of a generated thumbnail. Mirrors `THUMBNAIL_PIXELS` in
// src/lib/sshProtocol.ts. Images are downscaled to fit this box and re-encoded
// as WebP before being sent to the grid.
const THUMBNAIL_PIXELS = 256;

// ---------------------------------------------------------------------------
// Server-side grid-thumbnail cache (in-memory, LRU).
//
// Generating a thumbnail reads the original off the SSH target and downscales
// it with sharp/ffmpeg — cheap per file, but a directory of hundreds repeats
// that on every visit and every re-login. Caching the finished WebP tile here
// lets a return visit (even a fresh login) reuse it with no SSH read and no
// transcode, so image/video grids paint as fast as the bytes can be sent. The
// cache is:
//   • process-global (shared across sessions/logins) so a re-login reuses it;
//   • in-memory only — nothing is written to disk, so no file-derived data
//     outlives a bridge restart, and the client keeps thumbnails in memory only
//     (dropping every tile on logout — no browser copy lingers to download);
//   • keyed by identity (`user@host`, or `user@host#root` for an elevated read)
//     + path + `size:mtime`, so one login never reads another identity's tiles,
//     an edited file misses (new version tag), and an elevated (root-read) tile
//     is isolated from the login-user one;
//   • bounded by SSH_THUMB_CACHE_MB (default 128 MB; 0 disables) and evicted
//     least-recently-used first.
//
// `thumbCacheKey` + `planThumbCacheEvictions` mirror `thumbnailCacheKey` +
// `planThumbnailEvictions` in src/lib/thumbnailCache.ts — keep them in sync.
const THUMB_CACHE_MB = parseInt(process.env.SSH_THUMB_CACHE_MB || "128", 10);
const THUMB_CACHE_MAX_BYTES =
  THUMB_CACHE_MB > 0 ? THUMB_CACHE_MB * 1024 * 1024 : 0;
// Time-to-live (ms) for a cached tile: a tile unused for this long is dropped,
// so a re-login only reuses tiles from the recent past rather than keeping a
// decoded copy of your files in the shared process memory indefinitely (a
// confidentiality knob for a multi-tenant deploy). Default 30 min; 0 = never
// expire (only LRU eviction / explicit purge / restart clear it).
const THUMB_CACHE_TTL_MS = (() => {
  const n = parseInt(process.env.SSH_THUMB_CACHE_TTL_MS ?? "1800000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1800000;
})();
// key → { buf: Buffer, bytes: number, lastUsed: number }; Map insertion order
// doubles as the LRU order (get() re-inserts to move an entry to the newest).
const thumbCache = new Map();
let thumbCacheBytes = 0;

/** Mirrors src/lib/thumbnailCache.ts:thumbnailCacheKey. */
function thumbCacheKey(scope, path, version) {
  return `${scope} ${path} ${version}`;
}

/** Mirrors src/lib/thumbnailCache.ts:planThumbnailEvictions. */
function planThumbCacheEvictions(rows, maxBytes) {
  if (maxBytes <= 0) return rows.map((r) => r.key);
  const newestFirst = [...rows].sort((a, b) => b.lastUsed - a.lastUsed);
  const evict = [];
  let total = 0;
  for (const row of newestFirst) {
    total += row.bytes;
    if (total > maxBytes) evict.push(row.key);
  }
  return evict;
}

/** Look up a cached tile, bumping its recency; null on miss (or when disabled,
 * or once the tile has aged past the TTL). */
function thumbCacheGet(key) {
  if (THUMB_CACHE_MAX_BYTES <= 0) return null;
  const row = thumbCache.get(key);
  if (!row) return null;
  const now = Date.now();
  if (THUMB_CACHE_TTL_MS > 0 && now - row.lastUsed > THUMB_CACHE_TTL_MS) {
    thumbCache.delete(key);
    thumbCacheBytes -= row.bytes;
    return null; // expired → treat as a miss (re-generated fresh)
  }
  row.lastUsed = now;
  thumbCache.delete(key);
  thumbCache.set(key, row); // move to newest for LRU
  thumbCacheHits += 1;
  return { buf: row.buf, bg: row.bg };
}

/** Actively drop tiles that have aged past the TTL (so memory frees on a timer,
 * not only when a stale key is next requested). No-op when TTL is disabled. */
function thumbCacheSweepExpired() {
  if (THUMB_CACHE_TTL_MS <= 0 || THUMB_CACHE_MAX_BYTES <= 0) return;
  const now = Date.now();
  for (const [key, row] of thumbCache) {
    if (now - row.lastUsed > THUMB_CACHE_TTL_MS) {
      thumbCache.delete(key);
      thumbCacheBytes -= row.bytes;
    }
  }
}
// Sweep on a timer (at most once a minute) so expired tiles free memory even
// when the folder is never revisited. `unref` so it never keeps the process up.
if (THUMB_CACHE_TTL_MS > 0 && THUMB_CACHE_MAX_BYTES > 0) {
  const timer = setInterval(
    thumbCacheSweepExpired,
    Math.min(THUMB_CACHE_TTL_MS, 60000),
  );
  timer.unref?.();
}

/** Store a finished tile, evicting least-recently-used entries once over budget. */
function thumbCachePut(key, buf, bg) {
  if (THUMB_CACHE_MAX_BYTES <= 0 || buf.length > THUMB_CACHE_MAX_BYTES) return;
  const existing = thumbCache.get(key);
  if (existing) thumbCacheBytes -= existing.bytes;
  thumbCache.set(key, { buf, bg, bytes: buf.length, lastUsed: Date.now() });
  thumbCacheBytes += buf.length;
  if (thumbCacheBytes <= THUMB_CACHE_MAX_BYTES) return;
  const rows = [];
  for (const [k, v] of thumbCache)
    rows.push({ key: k, bytes: v.bytes, lastUsed: v.lastUsed });
  for (const k of planThumbCacheEvictions(rows, THUMB_CACHE_MAX_BYTES)) {
    const v = thumbCache.get(k);
    if (v) {
      thumbCacheBytes -= v.bytes;
      thumbCache.delete(k);
    }
  }
}

/** Evict every tile whose key starts with one of `prefixes` (the "clear cache"
 * action drops a connection's `user@host …` and `user@host#root …` entries). */
function thumbCachePurge(prefixes) {
  for (const key of [...thumbCache.keys()]) {
    if (prefixes.some((p) => key.startsWith(p))) {
      const v = thumbCache.get(key);
      if (v) thumbCacheBytes -= v.bytes;
      thumbCache.delete(key);
    }
  }
}

// Click-to-view image previews are downscaled to a compact transcode (format
// chosen by SSH_PREVIEW_IMAGE_FORMAT) so a big photo opens far faster while
// staying visually indistinguishable at the preview resolution; the original is
// only read, never modified, and Download (or zooming past the preview
// resolution) still fetches it whole. These mirror src/lib/sshProtocol.ts (the
// "two synchronized places" discipline): the preview's longest-edge bound, its
// encode quality, the minimum original size worth transcoding, and the largest
// original read into memory to transcode (only the transcode crosses the wire,
// so this can exceed the download cap; it just bounds decode memory).
const PREVIEW_IMAGE_MAX_DIM = 2560;
// Default quality mirrors PREVIEW_IMAGE_QUALITY in src/lib/sshProtocol.ts.
const PREVIEW_IMAGE_QUALITY = (() => {
  const q = parseInt(process.env.SSH_PREVIEW_IMAGE_QUALITY || "92", 10);
  return Number.isFinite(q) && q >= 1 && q <= 100 ? q : 92;
})();
// Preview transcode format, selectable per-deployment:
//   • webp-lossy   (default) — fastest to open; visually indistinguishable at
//                   the preview resolution; smallest encode CPU.
//   • webp-lossless — pixel-exact but larger on the wire and slower to encode.
//   • avif         — smallest wire size at a given quality, but the slowest CPU
//                   encode (previews aren't server-cached, so this is a real
//                   first-open cost).
// Pixel-perfect detail is always available on demand (zoom / "Original" /
// Download all fetch the untouched original), so the default trades nothing the
// user can see for a large speed-up.
const PREVIEW_IMAGE_FORMAT = (() => {
  const v = (process.env.SSH_PREVIEW_IMAGE_FORMAT || "webp-lossy")
    .trim()
    .toLowerCase();
  return v === "webp-lossless" || v === "avif" ? v : "webp-lossy";
})();
const PREVIEW_IMAGE_MIN_BYTES = 512 * 1024;
const PREVIEW_IMAGE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
// Whether an image is downscaled to a preview transcode. Mirrors
// `isResizablePreviewImage` in src/lib/sshProtocol.ts — excludes SVG (vector)
// and GIF (may be animated), which stream as their originals; includes HEIC/HEIF
// (which browsers can't render raw, so they're *only* ever shown transcoded).
function isResizablePreviewImage(name) {
  return /\.(png|apng|jpg|jpeg|jfif|pjpeg|pjp|webp|bmp|ico|cur|avif|heic|heif|heics|heifs)$/i.test(
    name,
  );
}
// Mirrors `isBrowserRenderableImage` in src/lib/sshProtocol.ts: whether the
// browser can render this image's raw bytes in an <img>. HEIC/HEIF cannot, so
// those must never be streamed raw for preview — only the transcode is sent.
function isBrowserRenderableImage(name) {
  return (
    isResizablePreviewImage(name) && !/\.(heic|heif|heics|heifs)$/i.test(name)
  );
}
// Encode a decoded original (as a Buffer) to the configured preview format,
// downscaled to fit PREVIEW_IMAGE_MAX_DIM. Returns { bytes, mime, srcWidth,
// srcHeight } or null when sharp can't decode/encode it. `srcWidth`/`srcHeight`
// are the ORIGINAL image's pixel dimensions (orientation-independent product) so
// the client can show the true size and gate loading a very large original. EXIF
// orientation is baked in so the preview is upright. The original file is only
// read, never modified.
async function encodePreviewImage(buffer) {
  try {
    const src = sharp(buffer);
    // Read the source dimensions before resizing (best-effort — may be undefined
    // for exotic formats; the client just falls back to the preview's own dims).
    let srcWidth;
    let srcHeight;
    try {
      const meta = await src.metadata();
      srcWidth = meta.width;
      srcHeight = meta.height;
    } catch {
      /* metadata unavailable — leave dims undefined */
    }
    let pipe = src
      .rotate()
      .resize(PREVIEW_IMAGE_MAX_DIM, PREVIEW_IMAGE_MAX_DIM, {
        fit: "inside",
        withoutEnlargement: true,
      });
    if (PREVIEW_IMAGE_FORMAT === "avif") {
      const bytes = await pipe
        .avif({ quality: PREVIEW_IMAGE_QUALITY })
        .toBuffer();
      return { bytes, mime: "image/avif", srcWidth, srcHeight };
    }
    if (PREVIEW_IMAGE_FORMAT === "webp-lossless") {
      const bytes = await pipe
        .webp({ lossless: true, quality: PREVIEW_IMAGE_QUALITY })
        .toBuffer();
      return { bytes, mime: "image/webp", srcWidth, srcHeight };
    }
    // Default: high-quality lossy WebP — fast to encode, small on the wire.
    const bytes = await pipe
      .webp({ quality: PREVIEW_IMAGE_QUALITY })
      .toBuffer();
    return { bytes, mime: "image/webp", srcWidth, srcHeight };
  } catch {
    return null;
  }
}
// Recursive-search limits. MAX_FIND_RESULTS mirrors src/lib/sshProtocol.ts; the
// node budget bounds how many filesystem entries a single search may visit so a
// deep/large tree can't tie up the session (the walk reads listings/metadata
// only, never file contents).
const MAX_FIND_RESULTS = 500;
// Cap on filesystem nodes visited per recursive search (#15, env-tunable).
const MAX_FIND_NODES = (() => {
  const n = parseInt(process.env.SSH_MAX_FIND_NODES || "20000", 10);
  return Number.isFinite(n) && n >= 1 ? n : 20000;
})();
// Upper bound on files enumerated for a single "download as zip" (#6). Caps the
// in-memory names+sizes list built before streaming so a directory with a
// pathological number of entries can't OOM the shared process.
const MAX_ZIP_ENTRIES = 100000;
// Content-search (grep) limits. GREP_MAX_FILE_BYTES mirrors src/lib/sshProtocol.ts
// (the largest file grep will open and scan — bigger files are skipped); the
// total-bytes budget bounds how much a single search may read so grepping a huge
// tree of text files can't tie up the session. Unlike name search, grep opens
// file *contents* — the files are only read, never modified.
const GREP_MAX_FILE_BYTES = 1024 * 1024;
// Total bytes a single content search may read (#15, env-tunable, in MB).
const GREP_MAX_TOTAL_BYTES = (() => {
  const mb = parseInt(process.env.SSH_GREP_MAX_TOTAL_MB || "64", 10);
  return (Number.isFinite(mb) && mb >= 1 ? mb : 64) * 1024 * 1024;
})();

// Mirror of grepFirstMatch in src/lib/sshProtocol.ts — keep the two in sync.
// Finds the first line containing `query` (case-insensitive), returning its
// 1-based number and a trimmed/clamped preview, or null when there's no match.
function grepFirstMatch(text, query, maxPreview = 160) {
  const needle = String(query).toLowerCase();
  if (needle === "") return null;
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      let preview = lines[i].replace(/^\s+/, "");
      if (preview.length > maxPreview)
        preview = `${preview.slice(0, maxPreview)}…`;
      return { line: i + 1, preview };
    }
  }
  return null;
}

// Heuristic: does a buffer look like binary (not text to grep)? A NUL byte in
// the first few KB is the classic "this is binary" signal (what grep -I uses),
// so we skip such files instead of scanning mojibake.
function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

// Required-field specs per client message type — mirrors CLIENT_MESSAGE_FIELDS
// in src/lib/sshProtocol.ts (keep the two in sync). Used to reject a malformed
// frame before a handler dereferences a missing field (e.g. an sftp-read with no
// `path`), which would otherwise throw inside an async SFTP callback and crash
// the single shared bridge process, dropping every concurrent session.
const CLIENT_MESSAGE_FIELDS = {
  connect: {
    host: "string",
    port: "number",
    username: "string",
    cols: "number",
    rows: "number",
  },
  data: { data: "string" },
  resize: { cols: "number", rows: "number" },
  ping: { ts: "number" },
  "hostkey-response": { accept: "boolean" },
  "kbd-response": { responses: "string[]" },
  "sftp-list": { path: "string" },
  "sftp-read": { path: "string" },
  "sftp-write": { path: "string", dataB64: "string" },
  "sftp-write-resume": { path: "string" },
  "sftp-upload-cancel": { path: "string" },
  "sftp-download-cancel": { path: "string" },
  "sftp-mkdir": { path: "string" },
  "sftp-find": { path: "string", query: "string" },
  "sftp-grep": { path: "string", query: "string" },
  "sftp-sudo": { enable: "boolean" },
  "sftp-rm": { path: "string" },
  "sftp-rename": { from: "string", to: "string" },
  "sftp-copy": { from: "string", to: "string" },
  "sftp-symlink": { target: "string", path: "string" },
  "sftp-chmod": { path: "string", mode: "number" },
  "sftp-checksum": { path: "string" },
  "sftp-df": { path: "string" },
  "sftp-follow": { path: "string" },
  "sftp-follow-stop": { path: "string" },
  "sftp-download-dir": { path: "string" },
  "sftp-download-many": { paths: "string[]" },
  "thumb-purge": {},
  disconnect: {},
};

// Mirror of fieldMatchesKind in src/lib/sshProtocol.ts.
function fieldMatchesKind(value, kind) {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    default:
      return false;
  }
}

// Mirror of isValidClientMessage in src/lib/sshProtocol.ts. Unknown types pass
// here (the dispatcher's default case drops them); a known type with a missing
// or mistyped required field is rejected.
function isValidClientMessage(msg) {
  const spec = CLIENT_MESSAGE_FIELDS[msg.t];
  if (!spec) return true;
  for (const field in spec) {
    if (!fieldMatchesKind(msg[field], spec[field])) return false;
  }
  return true;
}

// Cap a single SFTP upload so an unbounded stream can't fill the target disk
// (symmetric with the download cap). Configured in whole megabytes; 0 (or less)
// disables the limit.
const MAX_UPLOAD_MB = parseInt(process.env.SSH_MAX_UPLOAD_MB || "25", 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB > 0 ? MAX_UPLOAD_MB * 1024 * 1024 : 0;
// Max concurrent in-flight transfers (uploads OR downloads) a single session may
// hold open (#7). The uploads/downloads maps are otherwise unbounded, so one
// session could open thousands of simultaneous SFTP streams and exhaust memory.
// Applied to each map independently. 0 disables the cap.
const MAX_TRANSFERS_PER_SESSION = (() => {
  const n = parseInt(process.env.SSH_MAX_TRANSFERS_PER_SESSION || "20", 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
})();
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
// How many chained trusted proxies sit in front of the bridge. The client IP is
// read as this many hops in from the RIGHT of X-Forwarded-For (the right-most
// hop is the one our own proxy appended and cannot be spoofed by the client;
// the left-most is attacker-controlled). Default 1 (a single reverse proxy).
const TRUSTED_PROXY_HOPS = (() => {
  const n = parseInt(process.env.SSH_TRUSTED_PROXY_HOPS || "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
})();
// Optional explicit WebSocket origin allowlist. Empty = require same-origin.
const ALLOWED_ORIGINS = (process.env.SSH_ALLOWED_ORIGINS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
// Max concurrent upgraded-but-unconnected WebSockets from a single IP (#1). A
// client can otherwise open unlimited upgrades and never send `connect`, each
// holding a socket + grace timer without counting against MAX_SESSIONS. 0
// disables the per-IP cap.
const MAX_PENDING_UPGRADES_PER_IP = (() => {
  const n = parseInt(process.env.SSH_MAX_PENDING_UPGRADES_PER_IP || "10", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();
// Drop a socket that connects but never sends a `connect` message (ms).
const CONNECT_GRACE_MS = (() => {
  const n = parseInt(process.env.SSH_CONNECT_GRACE_MS || "30000", 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();
// Bound the SSH handshake, including the time spent waiting for the user to
// respond to an interactive prompt — accepting a host key (TOFU) or entering a
// 2FA / keyboard-interactive code. Used both as ssh2's `readyTimeout` and as an
// independent reaper on the pending prompt waiters, so a browser that opens a
// prompt and never answers can't hold a session slot open. The old hard-coded
// 20s `readyTimeout` also cut off users who simply took a few extra seconds on
// 2FA; 60s is a more forgiving default. 0 keeps the ssh2 default and disables
// the independent reaper.
const HANDSHAKE_TIMEOUT_MS = (() => {
  const raw = process.env.SSH_HANDSHAKE_TIMEOUT_MS;
  if (raw === undefined) return 60_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();
// Auto-close a session after this many ms of no shell/SFTP activity. Latency
// pings don't count as activity, so a truly idle terminal still times out.
// 0 (the default) disables the idle timeout entirely.
const IDLE_TIMEOUT_MS = parseInt(process.env.SSH_IDLE_TIMEOUT_MS || "0", 10);
// How long before the idle timeout to warn the client so its UI can show a
// countdown (#51). Only relevant when IDLE_TIMEOUT_MS > 0; clamped so it can't
// exceed the timeout itself. 0 disables the warning.
const IDLE_WARNING_MS = (() => {
  const n = parseInt(process.env.SSH_IDLE_WARNING_MS || "60000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 60000;
})();
// SSH keepalive probe interval (ms) passed to ssh2 (#51). Keeps NAT/firewall
// mappings alive and detects a dead peer. 0 disables ssh2 keepalives.
const KEEPALIVE_INTERVAL_MS = (() => {
  const n = parseInt(process.env.SSH_KEEPALIVE_INTERVAL_MS || "15000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 15000;
})();
// Timeout (ms) for a single ffmpeg poster-frame extraction (#15, env-tunable),
// so a hung/slow decode can't hold a thumbnail concurrency slot.
const FFMPEG_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SSH_FFMPEG_TIMEOUT_MS || "15000", 10);
  return Number.isFinite(n) && n >= 1 ? n : 15000;
})();
// Opt-in audit log of SFTP operations (#90): subject (user@host), op, and path,
// never credentials or file contents. Emitted regardless of SSH_LOG_LEVEL when
// on (but still silenced by SSH_LOG=off).
const AUDIT_LOG =
  (process.env.SSH_AUDIT_LOG || "false").toLowerCase() === "true";
// Log a transfer whose wall-clock duration exceeds this many ms as a warn (#97),
// so ops can spot pathologically slow reads/writes. 0 disables.
const SLOW_TRANSFER_MS = (() => {
  const n = parseInt(process.env.SSH_SLOW_TRANSFER_MS || "10000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
})();
// Operational logging mode: "json" (structured one-line events, the default) or
// "off". Credentials are never included in any log line.
const LOG_MODE = (process.env.SSH_LOG || "json").toLowerCase();
// Minimum severity to emit (#96): error < warn < info < debug. Events at a lower
// severity than SSH_LOG_LEVEL are dropped. Default "info". `SSH_LOG=off` still
// silences everything regardless of level.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL =
  LOG_LEVELS[(process.env.SSH_LOG_LEVEL || "info").toLowerCase()] ?? 2;
// Default severity per event; a call may override via a `level` field. Anything
// unlisted defaults to "info".
const EVENT_SEVERITY = {
  reject: "warn",
  "transcode-cap": "warn",
  "handshake-timeout": "warn",
  "bad-message": "warn",
  "handler-error": "warn",
  "slow-transfer": "warn",
  "uncaught-exception": "error",
  "unhandled-rejection": "error",
};
// Fixed path for the JSON health probe (used by load balancers / uptime checks).
const HEALTH_PATH = "/api/health";
// Prometheus metrics endpoint (#54): the same operational counters as
// /api/health but in Prometheus text exposition format, plus a handshake-latency
// histogram. Gated exactly like the detailed health payload (see requestIsAuthorized).
const METRICS_PATH = "/api/metrics";
// Optional shared secret gating the whole relay. When set, the browser must
// exchange it for an access cookie at POST /api/access before its WebSocket
// upgrade is accepted. Empty (the default) leaves the relay open.
const ACCESS_TOKEN = process.env.SSH_ACCESS_TOKEN || "";
// Fixed path for the access-gate probe/exchange endpoint, and the cookie it sets.
const ACCESS_PATH = "/api/access";
const ACCESS_COOKIE = "sshweb_access";
// Fixed path for the seekable media-streaming endpoint. A `<video>` in the
// preview modal points its `src` here with a per-session capability token, and
// the browser issues HTTP Range requests so a large clip plays and seeks
// without downloading the whole file. Same-origin, gated by the access cookie
// and an unguessable token (see the GET handler and `streamSessions`).
const PREVIEW_STREAM_PATH = "/api/preview";
// Cap a single Range response so one request can't be turned into an unbounded
// pull; the browser just issues more ranges as playback advances.
const STREAM_MAX_CHUNK_BYTES = (() => {
  const mb = parseInt(process.env.SSH_STREAM_MAX_CHUNK_MB || "16", 10);
  return (Number.isFinite(mb) && mb >= 1 ? mb : 16) * 1024 * 1024;
})();
// WebSocket send-buffer watermarks for streamed reads (#15, env-tunable, in MB):
// pause the source when buffered bytes exceed HIGH, resume once they fall below
// LOW, so a big transfer never balloons the send buffer.
const WS_BACKPRESSURE_HIGH_BYTES = (() => {
  const mb = parseInt(process.env.SSH_WS_BACKPRESSURE_HIGH_MB || "8", 10);
  return (Number.isFinite(mb) && mb >= 1 ? mb : 8) * 1024 * 1024;
})();
const WS_BACKPRESSURE_LOW_BYTES = (() => {
  const mb = parseInt(process.env.SSH_WS_BACKPRESSURE_LOW_MB || "1", 10);
  return (Number.isFinite(mb) && mb >= 1 ? mb : 1) * 1024 * 1024;
})();
// On-the-fly video transcode (for containers/codecs the browser can't play
// natively — see `videoNeedsTranscode` in src/lib/sshProtocol.ts). A `<video>`
// requests `/api/preview?...&transcode=1` and the bridge pipes the source
// through ffmpeg to fragmented MP4 (H.264/AAC), streamed progressively so it
// starts playing before the whole clip is converted. It's CPU-heavy, so the
// number running at once is capped; each spawn is killed when the client
// disconnects (so pausing/seeking away frees the CPU). Requires ffmpeg.
const MAX_TRANSCODES = (() => {
  const n = parseInt(process.env.SSH_MAX_TRANSCODES || "3", 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();
// Cap the total bytes a single live transcode may stream (#8). The Range and
// whole-file paths are already bounded per response by STREAM_MAX_CHUNK_BYTES,
// but the transcode path pipes ffmpeg straight to the response with no ceiling
// (only CPU-capped and killed on disconnect). Bounds one request's bandwidth /
// duration. Configured in whole megabytes; 0 (or less) disables the cap.
const TRANSCODE_MAX_OUTPUT_MB = (() => {
  const n = parseInt(process.env.SSH_MAX_TRANSCODE_OUTPUT_MB || "4096", 10);
  return Number.isFinite(n) && n >= 0 ? n : 4096;
})();
const TRANSCODE_MAX_OUTPUT_BYTES =
  TRANSCODE_MAX_OUTPUT_MB > 0 ? TRANSCODE_MAX_OUTPUT_MB * 1024 * 1024 : 0;
let activeTranscodes = 0;

// Optional operator-configured SSH algorithm allowlist (#53). Each category, when
// set (comma/space separated), replaces ssh2's default list for that category so
// a hardened deployment can refuse weak kex/cipher/MAC/host-key algorithms.
// Unset categories keep ssh2's secure defaults. Passed as `algorithms` to
// `.connect()`; `undefined` when nothing is configured.
const SSH_ALGORITHMS = (() => {
  const parse = (v) =>
    (v || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const kex = parse(process.env.SSH_KEX_ALGORITHMS);
  const cipher = parse(process.env.SSH_CIPHER_ALGORITHMS);
  const hmac = parse(process.env.SSH_MAC_ALGORITHMS);
  const serverHostKey = parse(process.env.SSH_HOSTKEY_ALGORITHMS);
  const algs = {};
  if (kex.length) algs.kex = kex;
  if (cipher.length) algs.cipher = cipher;
  if (hmac.length) algs.hmac = hmac;
  if (serverHostKey.length) algs.serverHostKey = serverHostKey;
  return Object.keys(algs).length > 0 ? algs : undefined;
})();

// --- Concurrency caps for expensive, client-triggered work ------------------
//
// Grid thumbnails (each reads a whole file — up to THUMBNAIL_VIDEO_MAX_BYTES —
// and runs sharp/ffmpeg) and recursive find/grep searches (grep reads file
// contents up to GREP_MAX_TOTAL_BYTES per search) are otherwise unbounded: a
// client firing hundreds in parallel could exhaust this single shared process's
// memory and CPU. Cap how many run at once (process-wide), queueing the rest and
// shedding load once the queue is full. `createLimiter` is hand-mirrored from
// src/lib/concurrencyLimiter.ts (unit-tested there).
const posInt = (envVar, dflt) => {
  const n = parseInt(process.env[envVar] || String(dflt), 10);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
};
const MAX_THUMBNAIL_JOBS = posInt("SSH_MAX_THUMBNAIL_JOBS", 4);
const MAX_SEARCH_JOBS = posInt("SSH_MAX_SEARCH_JOBS", 4);
// Image-preview transcodes (sharp resize/encode — WebP/AVIF, AVIF being the
// slowest) are otherwise uncapped, so a client firing many large-image previews
// could pin every CPU. Route them through their own limiter too (#5).
const MAX_PREVIEW_JOBS = posInt("SSH_MAX_PREVIEW_JOBS", 4);
// Bound the wait queues so a flood can't grow them without limit; past this we
// shed the request (a skipped thumbnail keeps its icon; a search replies empty;
// a shed preview falls back to streaming the original image).
const THUMBNAIL_QUEUE_MAX = posInt("SSH_MAX_THUMBNAIL_QUEUE", 500);
const SEARCH_QUEUE_MAX = posInt("SSH_MAX_SEARCH_QUEUE", 100);
const PREVIEW_QUEUE_MAX = posInt("SSH_MAX_PREVIEW_QUEUE", 100);

class QueueFullError extends Error {
  constructor() {
    super("concurrency limiter queue is full");
    this.name = "QueueFullError";
  }
}
// Mirror of createConcurrencyLimiter in src/lib/concurrencyLimiter.ts.
function createLimiter(maxConcurrent, maxQueue = Infinity) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        if (queue.length >= maxQueue) {
          reject(new QueueFullError());
          return;
        }
        queue.push({ task, resolve, reject });
        pump();
      });
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}
const thumbnailLimiter = createLimiter(MAX_THUMBNAIL_JOBS, THUMBNAIL_QUEUE_MAX);
const searchLimiter = createLimiter(MAX_SEARCH_JOBS, SEARCH_QUEUE_MAX);
const previewLimiter = createLimiter(MAX_PREVIEW_JOBS, PREVIEW_QUEUE_MAX);
// Content types for the streaming endpoint, by lower-case extension. Mirrors the
// media MIME maps in `src/lib/sshProtocol.ts` (the "two synchronized places"
// discipline) for the formats a browser can play inline.
const STREAM_CONTENT_TYPES = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  aac: "audio/aac",
};
function streamContentType(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return STREAM_CONTENT_TYPES[ext] || "application/octet-stream";
}
// Active per-session streaming capabilities, keyed by an unguessable token →
// { withStreamSftp, isClosed }. A session registers on SSH-ready and removes
// itself on cleanup, so a token only ever reaches that one session's files
// (which its own authenticated WebSocket can already read).
const streamSessions = new Map();
// Allow the file browser's elevated (sudo) mode. When enabled, a session may
// ask the bridge to run `sftp-server` under `sudo` so file operations execute
// as root (see buildSudoSftpCommand). This grants far-reaching access on the
// target, so it's OFF by default — opt in per deployment. The remote host's
// sudoers policy still governs whether the elevation actually succeeds.
const ALLOW_SUDO =
  (process.env.SSH_ALLOW_SUDO || "false").toLowerCase() === "true";
// Optional override of where to look for `sftp-server` on the target (comma/
// space separated, tried in order). Empty = the built-in cross-distro list.
const SFTP_SERVER_PATHS = (process.env.SSH_SFTP_SERVER_PATHS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

let activeSessions = 0;
// Concurrent upgraded-but-not-yet-connected WebSockets per client IP (#1). A
// socket counts as "pending" from the moment its upgrade is accepted until it
// either starts a real SSH session (reserved in activeSessions, itself capped)
// or closes. This bounds a flood of upgrades that never send `connect` — which
// MAX_SESSIONS alone doesn't catch, since that's only enforced at connect time.
const pendingUpgrades = new Map();
const incPending = (ip) =>
  pendingUpgrades.set(ip, (pendingUpgrades.get(ip) || 0) + 1);
const decPending = (ip) => {
  const n = (pendingUpgrades.get(ip) || 0) - 1;
  if (n > 0) pendingUpgrades.set(ip, n);
  else pendingUpgrades.delete(ip);
};
// Cumulative operational counters surfaced by the health probe (process-wide).
let totalConnections = 0; // SSH sessions that reached "ready"
let rejectedConnections = 0; // connection attempts refused (any reason)
// Refused attempts broken down by reason (bad-origin, unauthorized, rate-limit,
// at-capacity, host-not-allowed, bad-access-token, …), tallied centrally in
// logEvent so every reject path is counted uniformly.
const rejectionsByReason = Object.create(null);
let sshErrors = 0; // ssh2 connection/auth errors after an accepted upgrade
let bytesUp = 0; // bytes relayed browser → remote (shell input + uploads)
let bytesDown = 0; // bytes relayed remote → browser (shell output + downloads)
// SFTP transfer counters (a subset of bytesUp/bytesDown): file-browser uploads
// and streamed downloads only, so the health probe can report data-plane volume
// distinct from interactive shell traffic.
let sftpFilesUp = 0; // chunked uploads that completed
let sftpBytesUp = 0; // bytes written by chunked uploads
let sftpFilesDown = 0; // streamed downloads that completed
let sftpBytesDown = 0; // bytes read by streamed downloads
// Grid-thumbnail counters: WebP tiles actually served vs. skipped (missing
// sharp/ffmpeg, over-cap, or undecodable), and the total thumbnail bytes sent.
let thumbsServed = 0;
let thumbsSkipped = 0;
let thumbBytesOut = 0;
let thumbCacheHits = 0; // tiles served straight from the in-memory cache
// SSH handshake-latency histogram (connect → ready), for the Prometheus endpoint
// (#54). Cumulative buckets in milliseconds (Prometheus "le" semantics).
const HANDSHAKE_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10000];
const handshakeHist = {
  buckets: new Array(HANDSHAKE_BUCKETS_MS.length).fill(0),
  count: 0,
  sumMs: 0,
};
function observeHandshake(ms) {
  handshakeHist.count += 1;
  handshakeHist.sumMs += ms;
  for (let i = 0; i < HANDSHAKE_BUCKETS_MS.length; i++) {
    if (ms <= HANDSHAKE_BUCKETS_MS[i]) handshakeHist.buckets[i] += 1;
  }
}
// Set once a graceful shutdown starts, so new upgrades are refused.
let shuttingDown = false;

// Build/version metadata for the health probe (#12), so ops dashboards can tell
// deploys apart and detect restarts. Version comes from package.json; the commit
// is injected at deploy time via any of the common CI env vars (optional).
const APP_VERSION = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("./package.json", import.meta.url), "utf8"),
      ).version || "unknown"
    );
  } catch {
    return "unknown";
  }
})();
const APP_COMMIT =
  process.env.SSH_BUILD_COMMIT ||
  process.env.GIT_COMMIT ||
  process.env.GITHUB_SHA ||
  "";
const STARTED_AT = new Date().toISOString();

/**
 * The value stored in the access cookie: a SHA-256 hex digest of the configured
 * token, so the raw secret never sits in a cookie. The WebSocket upgrade gate
 * compares the presented cookie against this.
 */
const ACCESS_COOKIE_VALUE = ACCESS_TOKEN
  ? createHash("sha256").update(ACCESS_TOKEN).digest("hex")
  : "";

/**
 * Emit a structured operational event as a single JSON line on stdout. Only
 * non-sensitive fields (client IP, host, port, reason) are ever passed in —
 * usernames, passwords and private keys are deliberately never logged.
 */
function logEvent(event, fields = {}) {
  // Tally every rejection centrally so no reject path is missed, regardless of
  // whether structured logging is enabled below.
  if (event === "reject") {
    rejectedConnections += 1;
    const reason = fields.reason || "unknown";
    rejectionsByReason[reason] = (rejectionsByReason[reason] || 0) + 1;
  }
  if (LOG_MODE === "off") return;
  const { level: overrideLevel, ...rest } = fields;
  const level = overrideLevel || EVENT_SEVERITY[event] || "info";
  // Audit entries are opt-in and always emitted when enabled, independent of the
  // severity threshold (#90); everything else honors SSH_LOG_LEVEL.
  if (event !== "audit" && (LOG_LEVELS[level] ?? 2) > LOG_LEVEL) return;
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...rest }) +
      "\n",
  );
}

/** Host is allowed when the list is empty, or matches exactly / by `*.` suffix. */
function isHostAllowed(host) {
  if (ALLOWLIST.length === 0) return true;
  const h = host.trim().toLowerCase();
  return ALLOWLIST.some((p) => {
    if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p;
  });
}

// Mirror of parseIpv4Octets / isPrivateIpv4 / isBlockedPrivateHost in
// src/lib/serverSecurity.ts (keep in sync). Pure IP/name classification for the
// SSRF guard; the unit tests over the lib copy cover the logic.
function parseIpv4Octets(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}
function isPrivateIpv4([a, b]) {
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
function isBlockedPrivateHost(host) {
  let h = host.trim().toLowerCase();
  if (h === "") return false;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.split("%")[0];
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = parseIpv4Octets(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    const tail = h.slice(h.lastIndexOf(":") + 1);
    const embedded = parseIpv4Octets(tail);
    if (embedded) return isPrivateIpv4(embedded);
    const firstHextet = h.startsWith("::") ? "0" : h.split(":")[0] || "0";
    const value = parseInt(firstHextet, 16);
    if (Number.isFinite(value)) {
      if (value >= 0xfc00 && value <= 0xfdff) return true;
      if (value >= 0xfe80 && value <= 0xfebf) return true;
    }
    return false;
  }
  return false;
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

/**
 * Resolve the client IP for rate-limiting (mirrors clientIpFromHeaders in
 * serverSecurity.ts). Counts TRUSTED_PROXY_HOPS in from the RIGHT of
 * X-Forwarded-For so a client can't forge a fresh IP per request (the left-most
 * hop is attacker-controlled; the right-most is the one our proxy appended).
 */
function clientIpFromReq(req) {
  const xff = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && xff) {
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    const hops = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      return hops[Math.max(0, hops.length - TRUSTED_PROXY_HOPS)];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Whether a chunked upload's offset continues exactly where the last ended. */
function uploadChunkInOrder(offset, written) {
  return offset === written;
}

/** Whether a session idle since `lastActivity` should be reaped at `now`. */
function isIdleExpired(lastActivity, now, timeoutMs) {
  if (timeoutMs <= 0) return false;
  return now - lastActivity >= timeoutMs;
}

/** Whether the relay is gated by an access token (mirrors serverSecurity.ts). */
function accessTokenRequired(configured) {
  return !!configured && configured.trim() !== "";
}

/**
 * Constant-time check that `provided` matches the configured access token. Uses
 * `timingSafeEqual` so response timing doesn't leak the token's length/prefix
 * (the pure mirror in serverSecurity.ts uses plain equality; the algorithm — an
 * exact match against a configured token — is the same).
 */
function accessTokenMatches(configured, provided) {
  if (!accessTokenRequired(configured)) return false;
  const a = Buffer.from(String(configured));
  const b = Buffer.from(String(provided ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a Cookie header into a name→value map (mirrors serverSecurity.ts). */
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/** Whether the request carries a valid access cookie (constant-time compare). */
function requestIsAuthorized(req) {
  if (!accessTokenRequired(ACCESS_TOKEN)) return true;
  const cookie = parseCookieHeader(req.headers.cookie)[ACCESS_COOKIE] || "";
  const a = Buffer.from(ACCESS_COOKIE_VALUE);
  const b = Buffer.from(cookie);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Default cross-distro `sftp-server` locations (mirrors serverSecurity.ts). */
const DEFAULT_SFTP_SERVER_PATHS = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
  "/usr/libexec/sftp-server",
  "/usr/lib/sftp-server",
  "/usr/local/libexec/sftp-server",
];

/**
 * Remote command that starts `sftp-server` as root under `sudo` (mirrors
 * serverSecurity.ts). `paths` come from server config only — never the browser —
 * so nothing user-controlled is interpolated here; the optional sudo password is
 * fed separately to `sudo -S` on the channel's stdin.
 */
function buildSudoSftpCommand(hasPassword, paths = SFTP_SERVER_PATHS) {
  const list = (paths.length > 0 ? paths : DEFAULT_SFTP_SERVER_PATHS).join(" ");
  const finder =
    `for p in ${list}; do [ -x "$p" ] && exec "$p"; done; ` +
    `echo "sftp-server not found" >&2; exit 127`;
  const sudo = hasPassword ? "sudo -k -S -p ''" : "sudo -n";
  return `${sudo} /bin/sh -c '${finder}'`;
}

// SFTP channel window/packet sizes, mirrored from ssh2's lib/Channel.js so we
// can open an SFTP-over-exec channel the same way ssh2's own Client.sftp does.
const SFTP_CHAN_WINDOW = 2 * 1024 * 1024;
const SFTP_CHAN_PACKET = 32 * 1024;

// How long to wait for a `sudo sftp-server` handshake to complete before giving
// up. A *wrong* sudo password makes `sudo -S` print its error and then block
// re-reading stdin (which we never send more of / EOF, since a correct password
// needs the channel kept open for the SFTP protocol) — so without this bound the
// elevate request would hang forever and the client's sudo button would stay
// disabled until disconnect. A correct elevation becomes ready near-instantly,
// so this only ever trips on failure.
const SUDO_ELEVATE_TIMEOUT_MS = 6000;

/** Largest WebSocket frame to accept, from the upload cap (serverSecurity.ts). */
function computeMaxPayloadBytes(maxUploadBytes) {
  if (maxUploadBytes <= 0) return 0;
  const bound = Math.ceil(maxUploadBytes * (4 / 3)) + 1024 * 1024;
  return Math.max(bound, 8 * 1024 * 1024);
}

/** Whether a request arrived over HTTPS (Secure-cookie gate; serverSecurity.ts). */
function isSecureRequest(forwardedProto, encrypted) {
  if (encrypted) return true;
  const raw = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;
  return typeof raw === "string" && raw.toLowerCase().includes("https");
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

/** Send a JSON body with no-store caching. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// Render the operational counters in Prometheus text exposition format (#54).
function renderPrometheus() {
  const lines = [];
  const metric = (name, type, help, value, labels) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    if (labels === undefined) {
      lines.push(`${name} ${value}`);
    }
  };
  metric(
    "sshweb_active_sessions",
    "gauge",
    "Currently open SSH sessions.",
    activeSessions,
  );
  metric(
    "sshweb_max_sessions",
    "gauge",
    "Configured session ceiling.",
    MAX_SESSIONS,
  );
  metric(
    "sshweb_connections_total",
    "counter",
    "SSH sessions that reached ready.",
    totalConnections,
  );
  metric(
    "sshweb_rejections_total",
    "counter",
    "Refused connection attempts, by reason.",
    null,
    true,
  );
  for (const [reason, n] of Object.entries(rejectionsByReason)) {
    lines.push(`sshweb_rejections_total{reason="${reason}"} ${n}`);
  }
  metric(
    "sshweb_ssh_errors_total",
    "counter",
    "ssh2 connection/auth errors after upgrade.",
    sshErrors,
  );
  metric(
    "sshweb_bytes_up_total",
    "counter",
    "Bytes relayed browser to remote.",
    bytesUp,
  );
  metric(
    "sshweb_bytes_down_total",
    "counter",
    "Bytes relayed remote to browser.",
    bytesDown,
  );
  metric(
    "sshweb_active_transcodes",
    "gauge",
    "Live video transcodes running.",
    activeTranscodes,
  );
  metric(
    "sshweb_pending_upgrade_ips",
    "gauge",
    "Client IPs holding upgraded-but-unconnected sockets.",
    pendingUpgrades.size,
  );
  // Handshake-latency histogram (connect → ready), in seconds.
  lines.push(
    "# HELP sshweb_handshake_seconds SSH handshake latency (connect to ready).",
  );
  lines.push("# TYPE sshweb_handshake_seconds histogram");
  for (let i = 0; i < HANDSHAKE_BUCKETS_MS.length; i++) {
    const le = (HANDSHAKE_BUCKETS_MS[i] / 1000).toFixed(3);
    lines.push(
      `sshweb_handshake_seconds_bucket{le="${le}"} ${handshakeHist.buckets[i]}`,
    );
  }
  lines.push(
    `sshweb_handshake_seconds_bucket{le="+Inf"} ${handshakeHist.count}`,
  );
  lines.push(
    `sshweb_handshake_seconds_sum ${(handshakeHist.sumMs / 1000).toFixed(3)}`,
  );
  lines.push(`sshweb_handshake_seconds_count ${handshakeHist.count}`);
  metric(
    "sshweb_uptime_seconds",
    "gauge",
    "Process uptime.",
    Math.floor(process.uptime()),
  );
  return lines.join("\n") + "\n";
}

const server = createServer((req, res) => {
  const pathname = parse(req.url).pathname;

  // Lightweight JSON health probe, answered before Next so load balancers and
  // uptime checks get a stable, dependency-free 200. No credentials involved.
  if (req.method === "GET" && pathname === HEALTH_PATH) {
    const status = shuttingDown ? "shutting_down" : "ok";
    const code = shuttingDown ? 503 : 200;
    // When the relay is gated by an access token, the detailed operational
    // metrics below (session counts, transfer volumes, per-reason rejection
    // tallies) require authorization — otherwise a public relay would leak them
    // to anyone. A minimal {status} stays unauthenticated so load balancers /
    // uptime checks still get a stable readiness signal.
    if (accessTokenRequired(ACCESS_TOKEN) && !requestIsAuthorized(req)) {
      sendJson(res, code, { status });
      return;
    }
    sendJson(res, code, {
      status,
      activeSessions,
      maxSessions: MAX_SESSIONS,
      totalConnections,
      rejectedConnections,
      // Failure counters for ops diagnostics: refused upgrades broken down by
      // reason, plus ssh2 connection/auth errors after an accepted upgrade.
      errors: {
        sshErrors,
        rejections: { ...rejectionsByReason },
      },
      bytesUp,
      bytesDown,
      // SFTP data-plane volume (a subset of bytesUp/bytesDown), so ops can see
      // file-transfer throughput apart from interactive shell traffic.
      sftp: {
        filesUp: sftpFilesUp,
        bytesUp: sftpBytesUp,
        filesDown: sftpFilesDown,
        bytesDown: sftpBytesDown,
      },
      // Grid-thumbnail pipeline: WebP tiles served vs. skipped and bytes sent.
      thumbnails: {
        served: thumbsServed,
        skipped: thumbsSkipped,
        bytesOut: thumbBytesOut,
        cacheHits: thumbCacheHits,
        cacheEntries: thumbCache.size,
        cacheBytes: thumbCacheBytes,
      },
      // Live video transcodes running (on-the-fly conversion of non-natively-
      // playable containers), and the per-process ceiling.
      transcodes: { active: activeTranscodes, max: MAX_TRANSCODES },
      // Concurrency limiters for expensive client-triggered work: how many jobs
      // are running vs. queued right now, and the per-process ceilings.
      limits: {
        thumbnails: {
          active: thumbnailLimiter.active,
          queued: thumbnailLimiter.queued,
          max: MAX_THUMBNAIL_JOBS,
        },
        search: {
          active: searchLimiter.active,
          queued: searchLimiter.queued,
          max: MAX_SEARCH_JOBS,
        },
        preview: {
          active: previewLimiter.active,
          queued: previewLimiter.queued,
          max: MAX_PREVIEW_JOBS,
        },
      },
      // Upgraded-but-unconnected sockets awaiting a `connect` (distinct client
      // IPs currently holding one or more), bounding an upgrade flood (#1).
      pendingUpgradeIps: pendingUpgrades.size,
      uptime: Math.floor(process.uptime()),
      // Build/version metadata (#12): distinguish deploys, detect restarts.
      version: APP_VERSION,
      commit: APP_COMMIT || undefined,
      startedAt: STARTED_AT,
    });
    return;
  }

  // Prometheus metrics (#54), gated like the detailed health payload: when the
  // relay is token-gated, scraping requires the access cookie (or a metrics
  // token via the same cookie), so a public relay doesn't leak operational data.
  if (req.method === "GET" && pathname === METRICS_PATH) {
    if (accessTokenRequired(ACCESS_TOKEN) && !requestIsAuthorized(req)) {
      res.writeHead(401, { "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderPrometheus());
    return;
  }

  // Access gate: report whether a token is required and whether this caller is
  // already authorized (GET), or exchange a token for the access cookie (POST).
  // Credentials for the target host never pass through here — only the relay's
  // own optional shared secret does.
  if (pathname === ACCESS_PATH) {
    if (req.method === "GET") {
      sendJson(res, 200, {
        required: accessTokenRequired(ACCESS_TOKEN),
        authorized: requestIsAuthorized(req),
      });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      let tooBig = false;
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        const ip = clientIpFromReq(req);
        // Throttle access-key guesses per IP (the WebSocket connect path is
        // already throttled; this closes the same brute-force door on the
        // shared-secret exchange). A dedicated `access:` bucket keeps these
        // attempts from consuming the SSH connection-attempt budget.
        if (!rateLimitAllow(`access:${ip}`, Date.now())) {
          logEvent("reject", { ip, reason: "access-rate-limit" });
          sendJson(res, 429, { authorized: false });
          return;
        }
        let token = "";
        try {
          token = String(JSON.parse(body).token ?? "");
        } catch {
          /* malformed body → treated as an empty (failing) token */
        }
        if (!accessTokenMatches(ACCESS_TOKEN, token)) {
          logEvent("reject", { ip, reason: "bad-access-token" });
          sendJson(res, 401, { authorized: false });
          return;
        }
        const secure = isSecureRequest(
          req.headers["x-forwarded-proto"],
          req.socket?.encrypted === true,
        );
        res.setHeader(
          "Set-Cookie",
          `${ACCESS_COOKIE}=${ACCESS_COOKIE_VALUE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`,
        );
        sendJson(res, 200, { authorized: true });
      });
      return;
    }
    res.writeHead(405, { Allow: "GET, POST" });
    res.end();
    return;
  }

  // Seekable media stream: `<video src="/api/preview?token=…&path=…">`. Answers
  // HTTP Range requests from a per-session SFTP read so a large clip plays and
  // seeks without downloading the whole file. Gated by the access cookie and an
  // unguessable per-session token; the path can only be one the session's own
  // WebSocket could already read.
  if (pathname === PREVIEW_STREAM_PATH) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }
    if (!requestIsAuthorized(req)) {
      res.writeHead(401);
      return res.end();
    }
    const q = parse(req.url, true).query;
    const token = typeof q.token === "string" ? q.token : "";
    const filePath = typeof q.path === "string" ? q.path : "";
    const entry = token ? streamSessions.get(token) : null;
    if (!entry || entry.isClosed() || !filePath) {
      res.writeHead(404);
      return res.end();
    }
    entry.withStreamSftp((err, s) => {
      if (err || !s) {
        res.writeHead(502);
        return res.end();
      }
      s.stat(filePath, (statErr, stats) => {
        if (statErr || !stats || !stats.isFile()) {
          res.writeHead(404);
          return res.end();
        }
        const size = stats.size;
        // On-the-fly transcode for a non-natively-playable video: pipe the source
        // through ffmpeg to fragmented MP4 and stream it progressively (no Range —
        // it's a live conversion), so a .avi/.wmv/.ts/… plays without the client
        // ever downloading or transcoding it. CPU-capped and killed on disconnect.
        if (q.transcode === "1") {
          if (!ffmpegAvailable) {
            res.writeHead(501);
            return res.end();
          }
          if (MAX_TRANSCODES > 0 && activeTranscodes >= MAX_TRANSCODES) {
            res.writeHead(503, { "Retry-After": "5" });
            return res.end();
          }
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            // A live transcode can't be range-served; tell the player not to try.
            "Accept-Ranges": "none",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          if (req.method === "HEAD") return res.end();
          activeTranscodes += 1;
          let proc = null;
          const src = s.createReadStream(filePath);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            activeTranscodes -= 1;
          };
          const cleanup = () => {
            try {
              src.destroy();
            } catch {
              /* already gone */
            }
            if (proc) {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }
            release();
          };
          try {
            proc = spawn("ffmpeg", [
              "-loglevel",
              "error",
              "-i",
              "pipe:0",
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              // Fragmented MP4 so playback can start before the whole file is
              // converted (a normal MP4 needs its index written last).
              "-movflags",
              "frag_keyframe+empty_moov+faststart",
              "-f",
              "mp4",
              "pipe:1",
            ]);
          } catch {
            cleanup();
            return res.destroy();
          }
          // Client went away (navigated / paused-and-closed) → stop converting.
          res.on("close", cleanup);
          proc.on("error", () => {
            cleanup();
            res.destroy();
          });
          proc.on("close", () => {
            release();
            res.end();
          });
          proc.stdin.on("error", () => {}); // EPIPE when ffmpeg exits early
          proc.stderr?.on("data", () => {}); // drain, don't buffer
          src.on("error", () => cleanup());
          src.pipe(proc.stdin);
          // Manually pump stdout→res (instead of .pipe) so we can enforce the
          // output-byte cap (#8) and honor response backpressure.
          let outBytes = 0;
          proc.stdout.on("data", (chunk) => {
            outBytes += chunk.length;
            if (
              TRANSCODE_MAX_OUTPUT_BYTES > 0 &&
              outBytes > TRANSCODE_MAX_OUTPUT_BYTES
            ) {
              logEvent("transcode-cap", {
                ip: clientIpFromReq(req),
                bytes: outBytes,
              });
              cleanup();
              try {
                res.end();
              } catch {
                /* already ended */
              }
              return;
            }
            if (!res.write(chunk)) {
              proc.stdout.pause();
              res.once("drain", () => proc.stdout.resume());
            }
          });
          return;
        }
        const type = streamContentType(filePath);
        const rangeHeader = req.headers.range;
        // Common headers for both full and partial responses.
        const baseHeaders = {
          "Content-Type": type,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          // This is opaque media bytes — never let it be treated as a document.
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        };
        const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
        if (rangeMatch && size > 0) {
          let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
          let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end) || end > size - 1) end = size - 1;
          if (start > end) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            return res.end();
          }
          // Bound a single response so one request can't pull the whole file.
          if (end - start + 1 > STREAM_MAX_CHUNK_BYTES) {
            end = start + STREAM_MAX_CHUNK_BYTES - 1;
          }
          res.writeHead(206, {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": end - start + 1,
          });
          if (req.method === "HEAD") return res.end();
          const stream = s.createReadStream(filePath, { start, end });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }
        // No (valid) Range header. A `<video>`/`<audio>` element always sends
        // `Range: bytes=0-` first, so this whole-file path is only hit by direct
        // navigation. Bound it to the same per-response cap as a ranged read so
        // one un-ranged request can never pull an unbounded whole file; advertise
        // the true length (via a 206) so any player switches to ranged reads for
        // the rest. A file within the cap still gets a plain 200.
        if (size > STREAM_MAX_CHUNK_BYTES) {
          const end = STREAM_MAX_CHUNK_BYTES - 1;
          res.writeHead(206, {
            ...baseHeaders,
            "Content-Range": `bytes 0-${end}/${size}`,
            "Content-Length": STREAM_MAX_CHUNK_BYTES,
          });
          if (req.method === "HEAD") return res.end();
          const capped = s.createReadStream(filePath, { start: 0, end });
          capped.on("error", () => res.destroy());
          res.on("close", () => capped.destroy());
          capped.pipe(res);
          return;
        }
        res.writeHead(200, { ...baseHeaders, "Content-Length": size });
        if (req.method === "HEAD") return res.end();
        const stream = s.createReadStream(filePath);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      });
    });
    return;
  }

  handle(req, res, parse(req.url, true));
});

// Delegate non-SSH upgrades (e.g. Next dev HMR) to Next's own handler.
const upgradeHandler = app.getUpgradeHandler?.();

// Bound the size of a single inbound WebSocket frame so a malicious client can't
// force a huge allocation before our application-level size checks run. Derived
// from the upload cap; 0 means "unbounded uploads → keep the library default".
const MAX_WS_PAYLOAD = computeMaxPayloadBytes(MAX_UPLOAD_BYTES);
const wss = new WebSocketServer(
  MAX_WS_PAYLOAD > 0
    ? { noServer: true, maxPayload: MAX_WS_PAYLOAD }
    : { noServer: true },
);

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url || "");
  if (pathname === WS_PATH) {
    // Refuse new sessions once a graceful shutdown has begun.
    if (shuttingDown) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    // Reject cross-site WebSocket handshakes before upgrading (anti-CSWSH).
    if (!isWebSocketOriginAllowed(req.headers.origin, req.headers.host)) {
      logEvent("reject", {
        reason: "bad-origin",
        origin: req.headers.origin || "",
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Enforce the optional access gate before spending a session on the upgrade.
    if (!requestIsAuthorized(req)) {
      logEvent("reject", { ip: clientIpFromReq(req), reason: "unauthorized" });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const upgradeIp = clientIpFromReq(req);
    // Rate-limit the upgrade itself, in a dedicated bucket so it doesn't consume
    // the SSH connect-attempt budget (#1). Stops an upgrade flood that never
    // reaches handleConnect (where connect-time limiting lives).
    if (!rateLimitAllow(`upgrade:${upgradeIp}`, Date.now())) {
      logEvent("reject", { ip: upgradeIp, reason: "upgrade-rate-limit" });
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    // Cap concurrent upgraded-but-unconnected sockets per IP (#1).
    if (
      MAX_PENDING_UPGRADES_PER_IP > 0 &&
      (pendingUpgrades.get(upgradeIp) || 0) >= MAX_PENDING_UPGRADES_PER_IP
    ) {
      logEvent("reject", { ip: upgradeIp, reason: "too-many-pending" });
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    incPending(upgradeIp);
    let pendingCleared = false;
    const clearPending = () => {
      if (pendingCleared) return;
      pendingCleared = true;
      decPending(upgradeIp);
    };
    // Release the pending slot if the socket dies before/around the upgrade.
    socket.on("close", clearPending);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The session clears this once it reserves a real activeSessions slot (see
      // startConnection); until then the socket counts as pending. Closing also
      // clears it (idempotent), covering sockets that never connect.
      ws.clearPendingUpgrade = clearPending;
      ws.once("close", clearPending);
      wss.emit("connection", ws, req);
    });
  } else if (upgradeHandler) {
    upgradeHandler(req, socket, head);
  } else {
    socket.destroy();
  }
});

// --- Folder download (streaming store-only ZIP) ----------------------------
//
// The archive is streamed entry-by-entry over the chunked download frames (each
// file read as a stream, CRC computed incrementally) so the bridge never buffers
// the whole tree — or a whole file — in memory, and never blocks the event loop
// crc-ing a giant buffer. Because the size/CRC aren't known when the local
// header goes out, every entry uses a data descriptor. The record builders below
// are hand-mirrored from src/lib/zip.ts (unit-tested there); keep them in sync.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32Init() {
  return 0xffffffff;
}
function crc32Update(crc, buf) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
function crc32Final(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

const ZIP32_MAX = 0xffffffff;
function exceedsZip32(value) {
  return value >= ZIP32_MAX;
}
function zipLocalHeader(nameLength) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0808, 6); // UTF-8 | data-descriptor
  h.writeUInt16LE(0, 8); // store
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(0, 12);
  h.writeUInt32LE(0, 14); // crc (in data descriptor)
  h.writeUInt32LE(0, 18); // compressed size (in data descriptor)
  h.writeUInt32LE(0, 22); // uncompressed size (in data descriptor)
  h.writeUInt16LE(nameLength, 26);
  h.writeUInt16LE(0, 28);
  return h;
}
function zipDataDescriptor(crc, size) {
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  d.writeUInt32LE(size >>> 0, 8);
  d.writeUInt32LE(size >>> 0, 12);
  return d;
}
function zipCentralHeader(nameLength, crc, size, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0808, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(0, 12);
  h.writeUInt16LE(0, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(size >>> 0, 20);
  h.writeUInt32LE(size >>> 0, 24);
  h.writeUInt16LE(nameLength, 28);
  h.writeUInt16LE(0, 30);
  h.writeUInt16LE(0, 32);
  h.writeUInt16LE(0, 34);
  h.writeUInt16LE(0, 36);
  h.writeUInt32LE(0, 38);
  h.writeUInt32LE(offset >>> 0, 42);
  return h;
}
function zipEndRecord(count, centralSize, centralOffset) {
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(0, 4);
  e.writeUInt16LE(0, 6);
  e.writeUInt16LE(count & 0xffff, 8);
  e.writeUInt16LE(count & 0xffff, 10);
  e.writeUInt32LE(centralSize >>> 0, 12);
  e.writeUInt32LE(centralOffset >>> 0, 16);
  e.writeUInt16LE(0, 20);
  return e;
}

// --- Path helpers for chunked uploads --------------------------------------

/** The parent directory of a POSIX path (`/a/b/c` → `/a/b`, `/a` → `/`). */
function parentDirOf(p) {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/** Join a remote directory path with a child name (single-slash separator). */
function joinRemote(dir, name) {
  return (dir.endsWith("/") ? dir : `${dir}/`) + name;
}

/**
 * Copy one file over SFTP by streaming the source into the destination. The
 * source is only read (never modified); the destination is a new file. Bytes
 * pass through the bridge in a streamed pipe, so memory stays bounded.
 */
function copyFile(s, from, to, done) {
  let settled = false;
  const finish = (err) => {
    if (settled) return;
    settled = true;
    done(err || null);
  };
  const rs = s.createReadStream(from);
  const ws = s.createWriteStream(to);
  rs.on("error", (e) => {
    try {
      ws.destroy();
    } catch {
      /* stream already gone */
    }
    finish(e);
  });
  ws.on("error", (e) => {
    try {
      rs.destroy();
    } catch {
      /* stream already gone */
    }
    finish(e);
  });
  ws.on("close", () => finish(null));
  rs.pipe(ws);
}

/**
 * Recursively copy a directory over SFTP: create `to`, then copy each child
 * (files streamed via {@link copyFile}, subdirectories recursively). Symlinks
 * and special files are skipped. Originals are only read, never modified.
 */
function copyDir(s, from, to, done) {
  s.mkdir(to, () => {
    // An existing destination directory is fine — merge into it.
    s.readdir(from, (err, list) => {
      if (err) return done(err);
      let i = 0;
      const next = () => {
        if (i >= list.length) return done(null);
        const item = list[i++];
        const childFrom = joinRemote(from, item.filename);
        const childTo = joinRemote(to, item.filename);
        if (item.attrs.isDirectory?.()) {
          copyDir(s, childFrom, childTo, (e) => (e ? done(e) : next()));
        } else if (item.attrs.isFile?.()) {
          copyFile(s, childFrom, childTo, (e) => (e ? done(e) : next()));
        } else {
          next(); // skip symlinks / specials
        }
      };
      next();
    });
  });
}

/**
 * Recursively create `dir` over SFTP (like `mkdir -p`), then call `done`. An
 * already-existing directory is not an error here: the final `mkdir`'s error is
 * intentionally ignored so a folder upload into an existing tree still proceeds.
 */
function mkdirp(sftp, dir, done) {
  if (!dir || dir === "/" || dir === ".") return done();
  sftp.mkdir(dir, (err) => {
    if (!err) return done();
    // The parent may be missing — create it first, then retry this level.
    const parent = parentDirOf(dir);
    if (parent === dir) return done();
    mkdirp(sftp, parent, () => sftp.mkdir(dir, () => done()));
  });
}

/**
 * Enumerate the files a zip should contain WITHOUT reading their contents —
 * just names + sizes from directory listings/stat, so the archive can be sized
 * and then streamed one file at a time. `roots` is a list of `{ path, prefix }`:
 * a folder download passes the folder with an empty prefix (names relative to
 * it); a multi-selection passes each path prefixed with its basename so the
 * structure is preserved. Symlinks and special files are skipped. Returns
 * `[{ readPath, name, size }]`.
 */
function enumerateZipEntries(sftp, roots, done) {
  const entries = [];
  // Bound the entry array so a "download as zip" of a directory with an enormous
  // number of files can't build an unbounded names+sizes list in the shared
  // process memory before streaming even begins (#6). Symmetric with the
  // MAX_FIND_NODES cap on recursive search.
  let finished = false;
  const finish = (err, result) => {
    if (finished) return;
    finished = true;
    done(err, result);
  };
  const overBudget = () => entries.length >= MAX_ZIP_ENTRIES;
  const walkDir = (dir, rel, cb) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return cb(err);
      let i = 0;
      const nextEntry = () => {
        if (overBudget())
          return cb(
            new Error(
              `Too many files to zip (over ${MAX_ZIP_ENTRIES}). Download a smaller selection.`,
            ),
          );
        if (i >= list.length) return cb(null);
        const item = list[i++];
        const childPath = `${dir}/${item.filename}`;
        const childRel = rel ? `${rel}/${item.filename}` : item.filename;
        if (item.attrs.isDirectory?.()) {
          walkDir(childPath, childRel, (e) => (e ? cb(e) : nextEntry()));
        } else if (item.attrs.isFile?.()) {
          entries.push({
            readPath: childPath,
            name: childRel,
            size: item.attrs.size || 0,
          });
          nextEntry();
        } else {
          nextEntry(); // skip symlinks / specials
        }
      };
      nextEntry();
    });
  };
  let r = 0;
  const nextRoot = () => {
    if (overBudget())
      return finish(
        new Error(
          `Too many files to zip (over ${MAX_ZIP_ENTRIES}). Download a smaller selection.`,
        ),
      );
    if (r >= roots.length) return finish(null, entries);
    const { path, prefix } = roots[r++];
    sftp.stat(path, (err, stats) => {
      if (err) return finish(err);
      if (stats.isDirectory?.()) {
        const base = path.replace(/\/+$/, "");
        walkDir(base, prefix, (e) => (e ? finish(e) : nextRoot()));
      } else if (stats.isFile?.()) {
        entries.push({
          readPath: path,
          name: prefix || path.split("/").filter(Boolean).pop() || "file",
          size: stats.size || 0,
        });
        nextRoot();
      } else {
        nextRoot(); // skip symlinks / specials
      }
    });
  };
  nextRoot();
}

wss.on("connection", (ws, req) => {
  const clientIp = clientIpFromReq(req);
  // Short per-connection correlation id (#10) included in every log line for
  // this session, so ws-open / connect / sudo / ws-close can be tied together
  // even when many sessions share one IP behind a proxy.
  const connId = randomBytes(4).toString("hex");
  logEvent("ws-open", { id: connId, ip: clientIp });
  /** @type {import('ssh2').Client | null} */
  let ssh = null;
  let shell = null; // interactive PTY stream
  let sftp = null; // cached SFTP subsystem (runs as the login user)
  let elevatedSftp = null; // cached `sudo sftp-server` handle (runs as root)
  let elevated = false; // whether SFTP ops are currently routed through sudo
  let streamSftp = null; // dedicated SFTP channel for the HTTP media stream
  let streamToken = null; // capability token for /api/preview (this session)
  let sessionScope = ""; // `user@host` — the thumbnail-cache identity for this login
  let counted = false; // whether this connection is included in activeSessions
  let connecting = false; // a connect is being set up (guards the async SSRF DNS check)
  let closed = false;
  // Pending handshake callbacks that wait on a round-trip to the browser.
  let pendingHostVerify = null; // (accept: boolean) => void
  let pendingKbdFinish = null; // (responses: string[]) => void
  // Independent reaper for whichever handshake prompt is currently awaiting the
  // user (host-key confirmation or a 2FA / keyboard-interactive answer). Armed
  // when a prompt is sent, cleared when the browser replies — so a prompt that's
  // opened and never answered reclaims the session slot instead of relying
  // solely on ssh2's own handshake timeout.
  let promptTimer = null;
  const clearPromptTimeout = () => {
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
  };
  const armPromptTimeout = (kind) => {
    clearPromptTimeout();
    if (HANDSHAKE_TIMEOUT_MS <= 0) return;
    promptTimer = setTimeout(() => {
      promptTimer = null;
      logEvent("handshake-timeout", { id: connId, ip: clientIp, kind });
      // Reject a pending host-key verify so ssh2 aborts the handshake cleanly;
      // a pending kbd finish is just dropped (ssh2's own timeout closes it).
      if (pendingHostVerify) {
        try {
          pendingHostVerify(false);
        } catch {
          /* callback already consumed */
        }
        pendingHostVerify = null;
      }
      pendingKbdFinish = null;
      send({ t: "status", state: "error", message: "Handshake timed out." });
      sendError("Timed out waiting for a response.", "auth");
      cleanup();
      ws.close();
    }, HANDSHAKE_TIMEOUT_MS);
    promptTimer.unref?.();
  };
  // In-flight chunked uploads, keyed by remote path → { stream }.
  const uploads = new Map();
  // In-flight download read streams keyed by remote path, so they can be torn
  // down on cleanup or cancelled individually (`sftp-download-cancel`).
  const downloads = new Map();
  // Active tail -f follows keyed by remote path → { timer, offset } (#47), so
  // each poll timer can be cleared on stop / cleanup.
  const follows = new Map();
  // Timestamp of the last genuine shell/SFTP activity (not latency pings), used
  // by the idle-timeout reaper below.
  let lastActivity = Date.now();
  let idleWarned = false; // whether an idle-warning was already sent this idle span
  const touch = () => {
    lastActivity = Date.now();
    idleWarned = false; // real activity resets the warning
  };

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

  // Idle-session reaper: close a connection with no shell/SFTP traffic for
  // IDLE_TIMEOUT_MS. Disabled when the timeout is 0. The check runs at most
  // every 30s so a long timeout doesn't hold a tight interval.
  //
  // Clamp the warning window to strictly less than the timeout (half it) so a
  // short timeout (e.g. 30s with the default 60s warning) still warns before it
  // fires, instead of the first tick landing on expiry and skipping the warning.
  const idleWarnMs =
    IDLE_WARNING_MS > 0
      ? Math.min(IDLE_WARNING_MS, Math.floor(IDLE_TIMEOUT_MS / 2))
      : 0;
  const idleTimer =
    IDLE_TIMEOUT_MS > 0
      ? setInterval(
          () => {
            const now = Date.now();
            // Warn (once) before the timeout so the UI can prompt to stay
            // connected (#51); checked before expiry so a coarse tick can't skip
            // straight to disconnect.
            const remaining = IDLE_TIMEOUT_MS - (now - lastActivity);
            if (idleWarnMs > 0 && !idleWarned && remaining <= idleWarnMs) {
              idleWarned = true;
              send({ t: "idle-warning", remainingMs: Math.max(0, remaining) });
            }
            if (isIdleExpired(lastActivity, now, IDLE_TIMEOUT_MS)) {
              logEvent("idle-timeout", { id: connId, ip: clientIp });
              sendError("Session closed after inactivity.", "shell");
              cleanup();
              ws.close();
            }
          },
          // Tick at most every warning-window (or 30s), so the warning isn't
          // delivered too coarsely before the timeout fires.
          Math.max(
            1000,
            Math.min(
              IDLE_TIMEOUT_MS,
              idleWarnMs > 0 ? idleWarnMs : 30_000,
              30_000,
            ),
          ),
        )
      : null;
  idleTimer?.unref?.();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(graceTimer);
    clearPromptTimeout();
    if (idleTimer) clearInterval(idleTimer);
    logEvent("ws-close", { id: connId, ip: clientIp });
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
    for (const stream of downloads.values()) {
      try {
        stream.destroy();
      } catch {
        /* stream already gone */
      }
    }
    downloads.clear();
    // Stop any tail -f poll timers (#47).
    for (const f of follows.values()) clearInterval(f.timer);
    follows.clear();
    // Revoke the media-stream capability so no further /api/preview requests can
    // reach this (now closed) session, and drop its dedicated SFTP channel.
    if (streamToken) {
      streamSessions.delete(streamToken);
      streamToken = null;
    }
    try {
      streamSftp?.end();
    } catch {
      /* channel already gone */
    }
    try {
      elevatedSftp?.end();
    } catch {
      /* channel already gone */
    }
    ssh = null;
    shell = null;
    sftp = null;
    elevatedSftp = null;
    streamSftp = null;
    elevated = false;
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

  /**
   * Lazily open (and cache) an SFTP handle, then run `fn(sftp)`. While elevated
   * mode is on and the `sudo sftp-server` handle is live, operations route
   * through it (root); otherwise they use the login user's own SFTP subsystem.
   */
  function withSftp(fn) {
    if (!ssh) return sendError("Not connected.", "sftp");
    if (elevated && elevatedSftp) return fn(elevatedSftp);
    if (sftp) return fn(sftp);
    ssh.sftp((err, s) => {
      if (err) return sendError(`SFTP unavailable: ${err.message}`, "sftp");
      sftp = s;
      fn(s);
    });
  }

  /**
   * Lazily open (and cache) a dedicated SFTP channel for the HTTP media-stream
   * endpoint, then run `fn(err, sftp)`. Kept separate from `withSftp` so the
   * browser's Range requests never contend with the WebSocket's own SFTP stream
   * state, and always runs as the **login user** (never the sudo channel) — the
   * endpoint is only used for non-elevated previews. Calls back `fn(err)` on
   * failure so the HTTP handler can respond rather than push a WebSocket error.
   */
  function withStreamSftp(fn) {
    if (!ssh) return fn(new Error("not connected"));
    if (streamSftp) return fn(null, streamSftp);
    ssh.sftp((err, s) => {
      if (err) return fn(err);
      streamSftp = s;
      s.on("close", () => {
        streamSftp = null;
      });
      fn(null, s);
    });
  }

  /**
   * Open an SFTP handle backed by `sudo sftp-server` over an exec channel, so
   * file operations run as root. This mirrors ssh2's own `Client.prototype.sftp`
   * (lib/client.js) but sends an `exec` request (our sudo command) instead of the
   * plain `sftp` subsystem request — reusing ssh2's SFTP protocol object, which
   * ssh2 builds for any channel opened with type `sftp`. It therefore reaches
   * into a few ssh2 internals (`_chanMgr`, `_protocol`, the channel's
   * `_callbacks`), kept in step with the ssh2 version pinned in package.json.
   */
  function openElevatedSftp(password, cb) {
    const client = ssh;
    if (!client) return cb(new Error("Not connected."));
    const hasPassword = password !== "";
    const command = buildSudoSftpCommand(hasPassword);
    let settled = false;
    let channel = null;
    let timer = null;
    const done = (err, s) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cb(err, s);
    };
    // A wrong sudo password leaves `sudo -S` blocked re-reading stdin forever, so
    // the handshake never completes and no `ready`/`exit`/`error` ever fires.
    // Bound the wait: on timeout, tear the channel down (its stdin EOF makes the
    // stuck sudo exit) and report a failure so the client re-enables its button.
    // A correct elevation becomes ready near-instantly, so this only trips on
    // failure.
    timer = setTimeout(() => {
      try {
        channel?.end?.();
      } catch {
        /* channel already gone */
      }
      done(
        new Error(
          "Timed out starting sudo (wrong sudo password, or sudoers policy?).",
        ),
      );
    }, SUDO_ELEVATE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    // Invoked by ssh2 once the channel is confirmed; `chan` is a ready-made SFTP
    // protocol instance because we tag the request with type `sftp`.
    const onChannel = (err, chan) => {
      // The channel may open *after* the timeout already settled the request. If
      // so, don't drive the exec/SFTP handshake (which would leave a stray
      // sudo/sftp-server running) — just close the late channel and bail.
      if (settled) {
        if (!err && chan) {
          try {
            chan.end?.();
          } catch {
            /* channel already gone */
          }
        }
        return;
      }
      if (err) return done(err);
      channel = chan;
      // Equivalent of ssh2's reqExec: queue the channel-request reply handler,
      // then send the exec request for our sudo command.
      chan._callbacks.push((hadErr) => {
        if (hadErr) {
          return done(
            hadErr !== true
              ? hadErr
              : new Error(
                  "Could not start sudo sftp-server (is sudo access configured?).",
                ),
          );
        }
        chan.subtype = "exec";
        const detach = () => {
          chan.removeListener("ready", onReady);
          chan.removeListener("error", onError);
          chan.removeListener("exit", onExit);
          chan.removeListener("close", onExit);
        };
        const onReady = () => {
          detach();
          done(undefined, chan);
        };
        const onError = (e) => {
          detach();
          done(e);
        };
        const onExit = () => {
          detach();
          done(
            new Error(
              "sudo/sftp-server exited before the session started (check the sudo password or sudoers policy).",
            ),
          );
        };
        chan
          .on("ready", onReady)
          .on("error", onError)
          .on("exit", onExit)
          .on("close", onExit);
        // With `sudo -S`, feed the password as the first stdin line *before* the
        // SFTP protocol begins, so sudo consumes exactly that line and
        // sftp-server reads the protocol that follows. Never logged.
        if (hasPassword) {
          try {
            chan._protocol.channelData(
              chan.outgoing.id,
              Buffer.from(`${password}\n`),
            );
          } catch {
            /* fall through — _init still drives the handshake */
          }
        }
        chan._init();
      });
      client._protocol.exec(chan.outgoing.id, command, true);
    };
    onChannel.type = "sftp";

    const localChan = client._chanMgr.add(onChannel);
    if (localChan === -1) return done(new Error("No free channels available."));
    client._protocol.session(localChan, SFTP_CHAN_WINDOW, SFTP_CHAN_PACKET);
  }

  /** Turn elevated (sudo) SFTP mode on or off for this session. */
  function handleSudo(msg) {
    const enable = msg.enable === true;
    // A follow captured whichever SFTP handle was in effect when it started, so
    // stop them all when the privilege mode changes — the client re-follows if
    // still viewing the file (Codex #8).
    stopAllFollows();
    if (!enable) {
      elevated = false;
      const prev = elevatedSftp;
      elevatedSftp = null;
      try {
        prev?.end();
      } catch {
        /* channel already gone */
      }
      logEvent("sudo", { id: connId, ip: clientIp, enabled: false });
      return send({ t: "sftp-sudo", enabled: false });
    }
    if (!ALLOW_SUDO) {
      return sendError(
        "Elevated (sudo) file access is disabled on this server.",
        "sftp",
      );
    }
    if (!ssh) return sendError("Not connected.", "sftp");
    if (elevated && elevatedSftp)
      return send({ t: "sftp-sudo", enabled: true });
    const password = typeof msg.password === "string" ? msg.password : "";
    openElevatedSftp(password, (err, s) => {
      if (err) {
        elevated = false;
        elevatedSftp = null;
        return sendError(`Elevated access failed: ${err.message}`, "sftp");
      }
      elevatedSftp = s;
      elevated = true;
      logEvent("sudo", { id: connId, ip: clientIp, enabled: true });
      send({ t: "sftp-sudo", enabled: true });
    });
  }

  /**
   * Recursively search `msg.path` for entries whose name contains `msg.query`
   * (case-insensitive). Walks the tree over SFTP reading only directory
   * listings and metadata — never file contents, so originals are untouched —
   * and stops at the result / node budget, flagging `truncated`. Symlinked
   * directories are not descended (they show as `link`, so loops are avoided).
   */
  function handleFind(msg) {
    withSftp((s) => {
      const root = String(msg.path || ".");
      const query = String(msg.query || "")
        .trim()
        .toLowerCase();
      const reply = (entries, truncated) =>
        send({
          t: "sftp-find-result",
          path: root,
          query: String(msg.query || ""),
          entries,
          truncated,
        });
      if (query === "") return reply([], false);

      // Cap concurrent searches (this one reads listings/metadata across the
      // tree) so many parallel searches can't tie up the shared process. When
      // the queue is full, reply empty+truncated so the client isn't left
      // waiting for a result that never comes.
      searchLimiter
        .run(
          () =>
            new Promise((resolve) => {
              runFind(s, root, query, (entries, truncated) => {
                reply(entries, truncated);
                resolve();
              });
            }),
        )
        .catch(() => reply([], true));
    });
  }

  // The recursive name-search walk, factored out so handleFind can run it under
  // the search concurrency limiter. Calls `finish(entries, truncated)` exactly
  // once when the walk completes.
  function runFind(s, root, query, finish) {
    const results = [];
    let visited = 0;
    let truncated = false;
    const join = (dir, name) => (dir.endsWith("/") ? dir : `${dir}/`) + name;

    const walk = (dir, cb) => {
      if (truncated) return cb();
      s.readdir(dir, (err, list) => {
        if (err) return cb(); // unreadable directory — skip it, keep going
        let i = 0;
        const nextEntry = () => {
          if (truncated || i >= list.length) return cb();
          const item = list[i++];
          if (++visited > MAX_FIND_NODES) {
            truncated = true;
            return cb();
          }
          const name = item.filename;
          const type = toEntryType(item.attrs);
          const childPath = join(dir, name);
          if (name.toLowerCase().includes(query)) {
            results.push({
              name,
              path: childPath,
              type,
              size: item.attrs.size || 0,
              mtime: (item.attrs.mtime || 0) * 1000,
              mode: (item.attrs.mode || 0) & 0o777,
            });
            if (results.length >= MAX_FIND_RESULTS) {
              truncated = true;
              return cb();
            }
          }
          // Descend real directories only (never symlinks → no cycles).
          if (type === "dir") walk(childPath, nextEntry);
          else nextEntry();
        };
        nextEntry();
      });
    };

    walk(root, () => finish(results, truncated));
  }

  // Recursive content search (grep): walk the tree like handleFind, but open each
  // candidate file and scan its contents for `query`. Files are only read, never
  // modified. Binaries and files over GREP_MAX_FILE_BYTES are skipped, and the
  // whole search is bounded by node, result, and total-bytes budgets.
  function handleGrep(msg) {
    withSftp((s) => {
      const root = String(msg.path || ".");
      const query = String(msg.query || "").trim();
      const reply = (entries, truncated) =>
        send({
          t: "sftp-grep-result",
          path: root,
          query: String(msg.query || ""),
          entries,
          truncated,
        });
      if (query === "") return reply([], false);

      // Cap concurrent searches — grep opens and scans file *contents* (up to
      // GREP_MAX_TOTAL_BYTES per search), so several in parallel is the heaviest
      // search load. Queue-full sheds to an empty+truncated reply.
      searchLimiter
        .run(
          () =>
            new Promise((resolve) => {
              runGrep(s, root, query, (entries, truncated) => {
                reply(entries, truncated);
                resolve();
              });
            }),
        )
        .catch(() => reply([], true));
    });
  }

  // The recursive content-search walk, factored out so handleGrep can run it
  // under the search concurrency limiter. Calls `finish` exactly once.
  function runGrep(s, root, query, finish) {
    const results = [];
    let visited = 0;
    let bytesRead = 0;
    let truncated = false;
    const join = (dir, name) => (dir.endsWith("/") ? dir : `${dir}/`) + name;

    const walk = (dir, cb) => {
      if (truncated) return cb();
      s.readdir(dir, (err, list) => {
        if (err) return cb(); // unreadable directory — skip it, keep going
        let i = 0;
        const nextEntry = () => {
          if (truncated || i >= list.length) return cb();
          const item = list[i++];
          if (++visited > MAX_FIND_NODES) {
            truncated = true;
            return cb();
          }
          const name = item.filename;
          const type = toEntryType(item.attrs);
          const childPath = join(dir, name);
          if (type === "dir") return walk(childPath, nextEntry); // descend
          // Only scan regular files within the per-file and total read caps.
          const size = item.attrs.size || 0;
          if (type !== "file" || size === 0 || size > GREP_MAX_FILE_BYTES) {
            return nextEntry();
          }
          if (bytesRead + size > GREP_MAX_TOTAL_BYTES) {
            truncated = true;
            return cb();
          }
          s.readFile(childPath, (readErr, buffer) => {
            if (!readErr && buffer && !looksBinary(buffer)) {
              bytesRead += buffer.length;
              const hit = grepFirstMatch(buffer.toString("utf8"), query);
              if (hit) {
                results.push({
                  name,
                  path: childPath,
                  type,
                  size,
                  mtime: (item.attrs.mtime || 0) * 1000,
                  mode: (item.attrs.mode || 0) & 0o777,
                  line: hit.line,
                  preview: hit.preview,
                });
                if (results.length >= MAX_FIND_RESULTS) {
                  truncated = true;
                  return cb();
                }
              }
            }
            nextEntry();
          });
        };
        nextEntry();
      });
    };

    walk(root, () => finish(results, truncated));
  }

  /** Copy (duplicate) a file or directory to a new path over SFTP. */
  function handleCopy(msg) {
    withSftp((s) => {
      const from = String(msg.from || "");
      const to = String(msg.to || "");
      if (!from || !to) {
        return sendError("Copy needs a source and destination.", "sftp");
      }
      if (to === from) return sendError("Cannot copy onto itself.", "sftp");
      s.stat(from, (err, stats) => {
        if (err) return sendError(err.message, "sftp");
        const done = (e) => {
          if (e) return sendError(e.message, "sftp");
          send({ t: "sftp-ok", op: "copy", path: to });
        };
        if (stats.isDirectory?.()) copyDir(s, from, to, done);
        else if (stats.isFile?.()) copyFile(s, from, to, done);
        else sendError("Can only copy files and directories.", "sftp");
      });
    });
  }

  // chmod, optionally recursively (#48). A plain chmod is one call; a recursive
  // one walks the subtree (lstat to classify without following symlinks),
  // bounded by MAX_FIND_NODES so a pathological tree can't run away.
  function handleChmod(msg) {
    const mode = Number(msg.mode) & 0o777;
    withSftp((s) => {
      if (!msg.recursive) {
        return s.chmod(msg.path, mode, (err) => {
          if (err) return sendError(err.message, "sftp");
          send({ t: "sftp-ok", op: "chmod", path: msg.path });
        });
      }
      let remaining = 1;
      let failed = false;
      let visited = 0;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        sendError(err.message, "sftp");
      };
      const settle = () => {
        if (--remaining === 0 && !failed)
          send({ t: "sftp-ok", op: "chmod", path: msg.path });
      };
      const walk = (p) => {
        if (failed) return;
        if (++visited > MAX_FIND_NODES)
          return fail(new Error("Too many entries for recursive chmod."));
        s.chmod(p, mode, (err) => {
          if (err) return fail(err);
          s.lstat(p, (e2, st) => {
            if (failed) return;
            if (!e2 && st.isDirectory()) {
              s.readdir(p, (e3, list) => {
                if (failed) return;
                if (e3) return fail(e3);
                remaining += list.length;
                const base = p.replace(/\/$/, "");
                for (const ent of list) walk(`${base}/${ent.filename}`);
                settle(); // this directory itself is done
              });
            } else {
              settle();
            }
          });
        });
      };
      walk(msg.path);
    });
  }

  // Hash a remote file's contents (#46), streamed through the hash so a large
  // file is never buffered. Only sha256/sha1/md5 are allowed (default sha256).
  function handleChecksum(msg) {
    const allowed = new Set(["sha256", "sha1", "md5"]);
    const algo = allowed.has(String(msg.algo)) ? String(msg.algo) : "sha256";
    withSftp((s) => {
      let hash;
      try {
        hash = createHash(algo);
      } catch {
        return sendError("Unsupported checksum algorithm.", "sftp");
      }
      const rs = s.createReadStream(msg.path);
      rs.on("error", (err) => sendError(err.message, "sftp"));
      rs.on("data", (chunk) => {
        touch();
        hash.update(chunk);
      });
      rs.on("end", () =>
        send({
          t: "sftp-checksum",
          path: msg.path,
          algo,
          hex: hash.digest("hex"),
        }),
      );
    });
  }

  // tail -f (#47): send an initial tail of the file, then poll its size and
  // stream appended bytes. A shrink (truncation / log rotation) resets to the
  // new start. Bounded initial tail so a huge log doesn't dump whole.
  const FOLLOW_INITIAL_TAIL = 64 * 1024; // last 64 KB shown on start
  const FOLLOW_POLL_MS = 1000;
  const FOLLOW_MAX_CHUNK = 512 * 1024; // cap bytes sent per poll
  function handleFollow(msg) {
    const path = String(msg.path || "");
    if (!path || follows.has(path)) return;
    // Reserve the path synchronously so duplicate `sftp-follow` frames arriving
    // before the async SFTP setup finishes are deduped (they'd otherwise each
    // spawn a timer, leaking all but the last) — Codex #1.
    const state = { timer: null, offset: 0, reading: false, mtime: null };
    follows.set(path, state);
    withSftp((s) => {
      if (follows.get(path) !== state) return; // stopped during setup
      // Read [start, end) and, on success, advance the offset via `done(true)`.
      // Only one range is ever in flight (the poll checks `state.reading`), and
      // the offset is committed only after a successful read — so a slow or
      // failed read can't reorder or drop output — Codex #2.
      const readRange = (start, end, flags, done) => {
        if (end <= start) return done(false);
        const stream = s.createReadStream(path, { start, end: end - 1 });
        const parts = [];
        let errored = false;
        stream.on("data", (d) => parts.push(d));
        stream.on("error", (err) => {
          errored = true;
          sendError(err.message, "sftp");
          done(false);
        });
        stream.on("end", () => {
          if (errored || follows.get(path) !== state) return done(false);
          const buf = Buffer.concat(parts);
          bytesDown += buf.length;
          sftpBytesDown += buf.length;
          touch(); // new log activity keeps the session alive while following
          send({
            t: "sftp-follow-data",
            path,
            dataB64: buf.toString("base64"),
            ...flags,
          });
          done(true);
        });
      };
      s.stat(path, (err, st) => {
        if (err || !st) {
          follows.delete(path);
          return sendError(err?.message || "Not found.", "sftp");
        }
        if (follows.get(path) !== state) return; // stopped during setup
        const size = Math.max(0, st.size || 0);
        state.offset = Math.max(0, size - FOLLOW_INITIAL_TAIL);
        state.mtime = st.mtime;
        state.reading = true;
        readRange(state.offset, size, { initial: true }, (ok) => {
          state.reading = false;
          if (ok) state.offset = size;
        });
        const timer = setInterval(() => {
          if (follows.get(path) !== state || state.reading) return;
          // Backpressure: don't queue more follow frames while the socket's send
          // buffer is congested — otherwise a slow client grows bridge memory
          // and hurts every session — Codex #3.
          if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_BYTES) return;
          s.stat(path, (e2, st2) => {
            if (e2 || !st2 || follows.get(path) !== state || state.reading)
              return;
            const sz = Math.max(0, st2.size || 0);
            // Reset on truncation, or on a rotation that swapped in a new file
            // whose mtime changed without the size growing past our offset —
            // Codex #9 (best-effort without an inode over SFTP).
            const rotated =
              sz < state.offset ||
              (sz <= state.offset &&
                state.mtime != null &&
                st2.mtime !== state.mtime);
            state.mtime = st2.mtime;
            if (rotated) state.offset = 0;
            if (sz <= state.offset) return;
            const start = state.offset;
            const end = Math.min(sz, start + FOLLOW_MAX_CHUNK);
            state.reading = true;
            readRange(start, end, rotated ? { reset: true } : {}, (ok) => {
              state.reading = false;
              if (ok) state.offset = end;
            });
          });
        }, FOLLOW_POLL_MS);
        timer.unref?.();
        state.timer = timer;
      });
    });
  }

  function handleFollowStop(msg) {
    stopFollow(msg.path);
  }

  /** Stop a single follow (poll timer + map entry). */
  function stopFollow(path) {
    const f = follows.get(path);
    if (f) {
      if (f.timer) clearInterval(f.timer);
      follows.delete(path);
    }
  }

  /** Stop every active follow — used when the SFTP privilege mode changes, since
   * each follow captured the SFTP handle in effect at start (Codex #8). */
  function stopAllFollows() {
    for (const [, f] of follows) if (f.timer) clearInterval(f.timer);
    follows.clear();
  }

  function handleConnect(msg) {
    if (ssh || connecting) return; // already connecting/connected — ignore duplicates
    const host = String(msg.host || "").trim();
    const targetPort = Number(msg.port) || 22;
    const username = String(msg.username || "").trim();

    if (!host || !username) {
      sendError("Host and username are required.", "auth");
      return ws.close();
    }
    if (!isHostAllowed(host)) {
      logEvent("reject", {
        id: connId,
        ip: clientIp,
        host,
        reason: "host-not-allowed",
      });
      sendError(`Host not allowed by this server: ${host}`, "auth");
      return ws.close();
    }
    // Literal-IP / `localhost` SSRF guard: a fast, synchronous first pass.
    if (BLOCK_PRIVATE_HOSTS && isBlockedPrivateHost(host)) {
      logEvent("reject", {
        id: connId,
        ip: clientIp,
        host,
        reason: "host-private",
      });
      sendError("Connections to private/internal hosts are blocked.", "auth");
      return ws.close();
    }
    if (!rateLimitAllow(clientIp, Date.now())) {
      logEvent("reject", {
        id: connId,
        ip: clientIp,
        host,
        reason: "rate-limit",
      });
      sendError("Too many connection attempts. Please slow down.", "auth");
      return ws.close();
    }
    if (activeSessions >= MAX_SESSIONS) {
      logEvent("reject", {
        id: connId,
        ip: clientIp,
        host,
        reason: "at-capacity",
      });
      sendError("Server is at capacity. Try again shortly.", "auth");
      return ws.close();
    }

    // Reserve the session slot up front (#13). The capacity check above races
    // the awaited DNS lookup below: without reserving now, N concurrent connects
    // could all pass the check while their lookups are in flight and then all
    // increment, briefly exceeding MAX_SESSIONS. Any reject/failure path from
    // here closes the ws, whose cleanup() releases the slot.
    activeSessions += 1;
    counted = true;
    connecting = true;
    // When the SSRF guard is on, the literal check above only catches IP
    // literals and `localhost` — a *hostname* that resolves to a private/internal
    // address (e.g. an attacker's DNS record pointing at 169.254.169.254 or an
    // intranet box) would otherwise slip through and turn the relay into a
    // metadata/intranet probe. Resolve the name and reject if *any* resolved
    // address is private before we dial. `lookup({ all: true })` returns every
    // A/AAAA record (and echoes an IP literal without network I/O).
    if (BLOCK_PRIVATE_HOSTS && !isBlockedPrivateHost(host)) {
      lookup(host, { all: true }).then(
        (addrs) => {
          if (closed) return;
          const blocked = addrs.find((a) => isBlockedPrivateHost(a.address));
          if (blocked) {
            connecting = false;
            logEvent("reject", {
              id: connId,
              ip: clientIp,
              host,
              reason: "host-private-resolved",
            });
            sendError(
              "Connections to private/internal hosts are blocked.",
              "auth",
            );
            return ws.close();
          }
          // Pin the dial to a vetted resolved IP so ssh2 doesn't independently
          // re-resolve the hostname (#2). A short-TTL DNS-rebinding record could
          // otherwise return a public IP to our guard's lookup above and a
          // private/metadata IP to ssh2's own resolver at connect time. We
          // still pass the original hostname for logging and the TOFU host-key
          // prompt; only the transport target is the checked address.
          startConnection(msg, host, targetPort, username, addrs[0].address);
        },
        () => {
          if (closed) return;
          // Resolution failed — refuse rather than hand an unresolved name to
          // ssh2 (whose own resolver would then bypass this guard entirely).
          connecting = false;
          logEvent("reject", {
            id: connId,
            ip: clientIp,
            host,
            reason: "dns-failed",
          });
          sendError(`Could not resolve host: ${host}`, "auth");
          return ws.close();
        },
      );
      return;
    }
    startConnection(msg, host, targetPort, username, host);
  }

  function startConnection(msg, host, targetPort, username, dialHost = host) {
    if (ssh || closed) return;
    connecting = false;
    // This socket now holds a real (capped) session slot, so it no longer counts
    // as a pending upgrade (#1).
    try {
      ws.clearPendingUpgrade?.();
    } catch {
      /* already cleared */
    }
    // The thumbnail-cache identity for this login (see the server-side cache).
    sessionScope = `${username}@${host}`;
    send({ t: "status", state: "connecting" });

    const connectStartedAt = Date.now();
    ssh = new SSHClient();

    ssh
      .on("ready", () => {
        totalConnections += 1;
        observeHandshake(Date.now() - connectStartedAt);
        logEvent("connect", {
          id: connId,
          ip: clientIp,
          host,
          port: targetPort,
        });
        send({ t: "status", state: "connected" });
        // Mint a per-session capability token for the seekable media-stream
        // endpoint and register this session's login-user SFTP accessor under
        // it. The token is unguessable and revoked on cleanup, so it only ever
        // reaches this session's files (which its WebSocket can already read).
        streamToken = randomBytes(32).toString("hex");
        streamSessions.set(streamToken, {
          withStreamSftp,
          isClosed: () => closed,
        });
        // Advertise per-deployment capabilities so the UI only offers what the
        // server actually permits (e.g. the elevated/sudo file-access toggle).
        // `streamToken` lets the client build `/api/preview` URLs for video.
        send({
          t: "caps",
          sudo: ALLOW_SUDO,
          streamToken,
          maxDownloadBytes: MAX_DOWNLOAD_BYTES,
        });
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
            stream.on("data", (data) => {
              touch();
              bytesDown += data.length;
              send({ t: "data", data: data.toString("base64") });
            });
            stream.stderr?.on("data", (data) => {
              touch();
              bytesDown += data.length;
              send({ t: "data", data: data.toString("base64") });
            });
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
          armPromptTimeout("kbd");
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
        sshErrors += 1;
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
        // dialHost is the SSRF-vetted resolved IP when the guard is on, else the
        // original host; pinning it stops ssh2 from re-resolving the name (#2).
        host: dialHost,
        port: targetPort,
        username,
        password: msg.password || undefined,
        privateKey: msg.privateKey || undefined,
        passphrase: msg.passphrase || undefined,
        // Optional operator-configured algorithm allowlist (#53). Undefined when
        // no SSH_*_ALGORITHMS are set, so ssh2 keeps its secure defaults.
        algorithms: SSH_ALGORITHMS,
        readyTimeout: HANDSHAKE_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        // Enable keyboard-interactive so servers that require an OTP / 2FA code
        // (or deliver the password prompt this way) can complete auth.
        tryKeyboard: true,
        // Trust-on-first-use host key check: present the fingerprint to the
        // browser and let the user decide before the session opens.
        hostVerifier: (keyBuf, verify) => {
          const { fingerprint, keyType } = fingerprintHostKey(keyBuf);
          pendingHostVerify = verify;
          armPromptTimeout("hostkey");
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

  // Upload backpressure: SFTP write streams whose buffer is full and that we're
  // waiting to `drain` before reading more from the socket. Symmetric with the
  // download path (which pauses the SFTP *read* stream on a full `ws`
  // bufferedAmount). Without this, a client uploading over a fast local
  // WebSocket to a slow SSH target would have every chunk buffered in the write
  // stream's memory unbounded — `write()` returns false but was ignored.
  const backpressured = new Set();
  function pauseForBackpressure(stream) {
    if (backpressured.has(stream)) return;
    backpressured.add(stream);
    // Pause the whole connection's incoming data (uploads share the socket) only
    // when the first stream stalls; resume once every stalled stream drains.
    if (backpressured.size === 1) {
      try {
        ws.pause();
      } catch {
        /* socket already gone */
      }
    }
    // Release on the first of drain (buffer flushed) / close / error (stream
    // destroyed on cap, cancel or failure) so a torn-down stream never leaves
    // the socket paused forever.
    const release = () => {
      if (!backpressured.delete(stream)) return;
      if (backpressured.size === 0) {
        try {
          ws.resume();
        } catch {
          /* socket already gone */
        }
      }
    };
    stream.once("drain", release);
    stream.once("close", release);
    stream.once("error", release);
  }

  // Append `buffer` to an open upload, enforcing the size cap and closing the
  // stream on the final chunk.
  function appendUploadChunk(entry, path, buffer, isFinal) {
    if (
      MAX_UPLOAD_BYTES > 0 &&
      entry.written + buffer.length > MAX_UPLOAD_BYTES
    ) {
      try {
        entry.stream.destroy();
      } catch {
        /* stream already gone */
      }
      uploads.delete(path);
      return sendError(
        `File too large to upload (> ${MAX_UPLOAD_MB} MB).`,
        "sftp",
      );
    }
    entry.written += buffer.length;
    bytesUp += buffer.length;
    sftpBytesUp += buffer.length;
    const ok = entry.stream.write(buffer);
    if (isFinal) {
      entry.stream.end(() => {
        uploads.delete(path);
        sftpFilesUp += 1;
        send({ t: "sftp-ok", op: "write", path });
      });
    } else if (!ok) {
      // Write buffer full and more chunks are coming — throttle the client until
      // the SFTP stream drains instead of buffering the rest in memory.
      pauseForBackpressure(entry.stream);
    }
  }

  // Open a write stream for `path` and write the first chunk into it. `start > 0`
  // (a resume) reopens an existing partial in read/write mode and writes at that
  // offset instead of truncating, so an interrupted upload continues where it
  // left off; `start === 0` is a normal fresh upload (create/truncate).
  function openUpload(s, path, buffer, isFinal, start = 0) {
    const stream =
      start > 0
        ? s.createWriteStream(path, { flags: "r+", start })
        : s.createWriteStream(path);
    stream.on("error", (err) => {
      uploads.delete(path);
      sendError(err.message, "sftp");
    });
    const entry = { stream, written: start };
    uploads.set(path, entry);
    appendUploadChunk(entry, path, buffer, isFinal);
  }

  // Drive one chunk of a chunked upload. The opening chunk (re)opens the stream —
  // at offset 0 for a fresh upload (optionally creating parent directories first
  // for folder uploads), or at `msg.offset` when `msg.resume` recovers a partial
  // after a dropped connection; later chunks must arrive in order or the transfer
  // is aborted to avoid silent corruption.
  function handleChunkedWrite(s, msg, buffer) {
    const path = msg.path;
    const existing = uploads.get(path);
    const opening = msg.offset === 0 || (msg.resume === true && !existing);
    if (opening) {
      // Cap concurrent uploads per session (#7). A brand-new upload (no existing
      // stream for this path) must fit under the limit; a resume/reopen of an
      // existing path replaces its entry and doesn't grow the map.
      if (
        !existing &&
        MAX_TRANSFERS_PER_SESSION > 0 &&
        uploads.size >= MAX_TRANSFERS_PER_SESSION
      ) {
        return sendError(
          "Too many concurrent uploads. Wait for some to finish.",
          "sftp",
        );
      }
      if (existing) {
        try {
          existing.stream.destroy();
        } catch {
          /* stream already gone */
        }
        uploads.delete(path);
      }
      const start = msg.resume === true ? msg.offset : 0;
      if (msg.mkdirp) {
        mkdirp(s, parentDirOf(path), () =>
          openUpload(s, path, buffer, msg.final === true, start),
        );
      } else {
        openUpload(s, path, buffer, msg.final === true, start);
      }
      return;
    }
    if (!existing || !uploadChunkInOrder(msg.offset, existing.written)) {
      if (existing) {
        try {
          existing.stream.destroy();
        } catch {
          /* stream already gone */
        }
        uploads.delete(path);
      }
      return sendError("Upload chunk out of order.", "sftp");
    }
    appendUploadChunk(existing, path, buffer, msg.final === true);
  }

  // The file-read handler: thumbnails, previews (streamed/optimized),
  // edit reads and streamed downloads/transcodes. Extracted verbatim from the
  // message switch to keep the dispatcher thin.
  function handleRead(msg) {
    withSftp((s) =>
      s.stat(msg.path, (statErr, stats) => {
        const name = msg.path.split("/").pop() || "download";

        // Thumbnails feed the grid view. A grid renders many at once, so this
        // path is optimised for volume: what crosses the wire is ALWAYS a tiny
        // WebP (never a full-size original), so a folder of hundreds of photos
        // or videos sends KB per tile instead of MB. Images are decoded and
        // downscaled to WebP in-memory (the original is only read, never
        // modified); videos have a poster frame extracted by ffmpeg and
        // downscaled to WebP the same way. WebP needs `sharp` (and, for a
        // video, `ffmpeg`): if either is missing or the bytes can't be decoded
        // we skip the tile (empty payload → client keeps its icon) rather than
        // ever falling back to a non-WebP or full-size original.
        //
        // A `thumb` request ALWAYS gets a reply — even a skip or error sends
        // an empty payload — so the client can drop the tile back to its icon
        // and, crucially, advance its bounded request queue (no dead slot).
        if (msg.thumb === true) {
          const skipThumb = () => {
            thumbsSkipped += 1;
            send({
              t: "sftp-read",
              path: msg.path,
              name,
              dataB64: "",
              thumb: true,
            });
          };
          // Send a produced WebP tile, metering it for the health probe. `tile`
          // is { buf, bg } — bg is the dominant color placeholder (#100).
          const sendThumb = (tile) => {
            thumbsServed += 1;
            thumbBytesOut += tile.buf.length;
            send({
              t: "sftp-read",
              path: msg.path,
              name,
              dataB64: tile.buf.toString("base64"),
              thumb: true,
              mime: "image/webp",
              bg: tile.bg,
            });
          };
          // Downscale any decodable image bytes (a photo, or an ffmpeg poster
          // frame) to a small WebP, and compute its dominant color for a cheap
          // grid placeholder (#100). Returns { buf, bg } or null if sharp can't
          // decode the bytes.
          const toWebpThumb = async (bytes, rotate, sharpOpts) => {
            try {
              let pipe = sharp(bytes, sharpOpts);
              if (rotate) pipe = pipe.rotate(); // honour EXIF orientation
              const buf = await pipe
                .resize(THUMBNAIL_PIXELS, THUMBNAIL_PIXELS, {
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .webp({ quality: 70 })
                .toBuffer();
              let bg;
              try {
                const { dominant } = await sharp(buf).stats();
                if (dominant) {
                  const hex = (n) =>
                    Math.max(0, Math.min(255, n | 0))
                      .toString(16)
                      .padStart(2, "0");
                  bg = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
                }
              } catch {
                /* dominant color is optional; omit on failure */
              }
              return { buf, bg };
            } catch {
              return null;
            }
          };
          // No sharp = no WebP = no thumbnails at all (icons only).
          if (statErr || stats.size > THUMBNAIL_VIDEO_MAX_BYTES || !sharp) {
            return skipThumb();
          }
          // Enforce the PDF-specific bound before reading the file, so a direct
          // client can't force a larger PDF read than the client helper allows
          // (#77 review).
          if (/\.pdf$/i.test(name) && stats.size > THUMBNAIL_PDF_MAX_BYTES) {
            return skipThumb();
          }
          // Serve straight from the in-memory cache when we already hold this
          // exact tile (same identity + path + size:mtime): no SSH read, no
          // sharp/ffmpeg transcode, so a re-visited or re-logged-in grid
          // paints as fast as the bytes can be sent. Elevated (root) reads
          // are scoped under `#root` so they never mix with login-user tiles.
          const scope = elevated ? `${sessionScope}#root` : sessionScope;
          const cacheKey = thumbCacheKey(
            scope,
            msg.path,
            `${stats.size}:${stats.mtime}`,
          );
          const cached = thumbCacheGet(cacheKey);
          if (cached) return sendThumb(cached);
          // Gate the heavy read + sharp/ffmpeg transcode behind a process-wide
          // concurrency cap so a burst of tiles can't exhaust memory/CPU. When
          // the queue is full we shed the tile (keep its icon) — the reply the
          // client's bounded queue is waiting for still comes back.
          thumbnailLimiter
            .run(
              () =>
                new Promise((resolve) => {
                  s.readFile(msg.path, async (err, buffer) => {
                    try {
                      if (err) return skipThumb();
                      // PDF: rasterize the first page (needs sharp built with PDF
                      // support; falls through to skip when unavailable) (#77).
                      // Rendered at a higher density than the 72dpi default so the
                      // downscaled tile isn't blurry; no EXIF rotate for a PDF.
                      if (/\.pdf$/i.test(name)) {
                        const pdfThumb = await toWebpThumb(buffer, false, {
                          density: 100,
                        });
                        if (pdfThumb) {
                          thumbCachePut(cacheKey, pdfThumb.buf, pdfThumb.bg);
                          return sendThumb(pdfThumb);
                        }
                        return skipThumb();
                      }
                      // Image: decode + downscale straight to WebP.
                      const imageThumb = await toWebpThumb(buffer, true);
                      if (imageThumb) {
                        thumbCachePut(cacheKey, imageThumb.buf, imageThumb.bg);
                        return sendThumb(imageThumb);
                      }
                      // Not a sharp-decodable image (video, or corrupt): extract
                      // a poster frame with ffmpeg and downscale that too.
                      if (ffmpegAvailable) {
                        const frame = await extractVideoFrame(buffer);
                        if (frame) {
                          const videoThumb = await toWebpThumb(frame, false);
                          if (videoThumb) {
                            thumbCachePut(
                              cacheKey,
                              videoThumb.buf,
                              videoThumb.bg,
                            );
                            return sendThumb(videoThumb);
                          }
                        }
                      }
                      // Couldn't produce a WebP thumbnail — keep the icon rather
                      // than send the original bytes whole.
                      return skipThumb();
                    } finally {
                      resolve();
                    }
                  });
                }),
            )
            .catch(() => skipThumb());
          return;
        }

        if (statErr) return sendError(statErr.message, "sftp");
        const isPreview = msg.preview === true;

        // Stream a file (optionally head-only via `cap`) as download/preview
        // frames, pausing on WebSocket backpressure so a big file never
        // balloons the send buffer. Preview frames are tagged `preview: true`
        // so the client routes the bytes into the modal (as a blob/text)
        // instead of saving a file. Cancellable via the `downloads` map.
        const streamOriginal = (cap) => {
          // Cap concurrent transfers per session (#7) for a new download path.
          if (
            !downloads.has(msg.path) &&
            MAX_TRANSFERS_PER_SESSION > 0 &&
            downloads.size >= MAX_TRANSFERS_PER_SESSION
          ) {
            return sendError(
              "Too many concurrent transfers. Wait for some to finish.",
              "sftp",
            );
          }
          // A capped read only pulls the file's head (`{ start, end }`), so a
          // huge log previews as text without transferring the whole thing.
          const truncated = cap > 0 && stats.size > cap;
          const transferStartedAt = Date.now();
          const stream = truncated
            ? s.createReadStream(msg.path, { start: 0, end: cap - 1 })
            : s.createReadStream(msg.path);
          downloads.set(msg.path, stream);
          send({
            t: "sftp-download-begin",
            path: msg.path,
            name,
            size: truncated ? cap : stats.size,
            preview: isPreview,
          });
          stream.on("data", (chunk) => {
            bytesDown += chunk.length;
            sftpBytesDown += chunk.length;
            send({
              t: "sftp-download-chunk",
              path: msg.path,
              dataB64: chunk.toString("base64"),
              preview: isPreview,
            });
            if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_BYTES) {
              stream.pause();
              const resume = setInterval(() => {
                if (ws.readyState !== ws.OPEN) {
                  clearInterval(resume);
                  stream.destroy();
                } else if (ws.bufferedAmount < WS_BACKPRESSURE_LOW_BYTES) {
                  clearInterval(resume);
                  stream.resume();
                }
              }, 25);
            }
          });
          stream.on("error", (err) => {
            // A cancel (`sftp-download-cancel`) removes the map entry before
            // destroying the stream, so a still-present entry here means a
            // genuine read error (worth a toast); a missing one means we tore
            // the stream down on purpose and should stay silent.
            if (downloads.has(msg.path)) {
              downloads.delete(msg.path);
              sendError(err.message, "sftp");
            }
          });
          stream.on("end", () => {
            downloads.delete(msg.path);
            sftpFilesDown += 1;
            const elapsed = Date.now() - transferStartedAt;
            if (SLOW_TRANSFER_MS > 0 && elapsed > SLOW_TRANSFER_MS) {
              logEvent("slow-transfer", {
                id: connId,
                ip: clientIp,
                op: "download",
                // The remote path is potentially sensitive; only include it when
                // the opt-in audit log is enabled, so ordinary ops logs don't
                // leak users' filenames on a shared deploy.
                path: AUDIT_LOG ? msg.path : undefined,
                bytes: truncated ? cap : stats.size,
                ms: elapsed,
              });
            }
            send({
              t: "sftp-download-end",
              path: msg.path,
              preview: isPreview,
              truncated,
            });
          });
        };

        // Fast image preview: downscale a (possibly large) original to a
        // small transcode (see PREVIEW_IMAGE_FORMAT) so click-to-view loads
        // in KB, not MB. Only the transcode crosses the wire, so this may read
        // a source past the whole-file download cap — bounded by
        // PREVIEW_IMAGE_SOURCE_MAX_BYTES to cap decode memory. The `mime` on
        // the begin frame tells the client these are an optimized preview
        // (Download still fetches the original). The original is only read,
        // never modified. HEIC/HEIF are forced through this path regardless
        // of size — the browser can't render them raw, so a transcode is the
        // *only* way to preview them.
        const mustTranscode = !isBrowserRenderableImage(name);
        if (
          isPreview &&
          msg.previewResize === true &&
          sharp &&
          isResizablePreviewImage(name) &&
          (stats.size >= PREVIEW_IMAGE_MIN_BYTES || mustTranscode) &&
          stats.size <= PREVIEW_IMAGE_SOURCE_MAX_BYTES
        ) {
          s.readFile(msg.path, async (err, buffer) => {
            if (err) return sendError(err.message, "sftp");
            // Concurrency-cap the sharp resize/encode (#5). On load-shed
            // (queue full) treat it as "no transcode" and fall back below to
            // streaming the original (or the unsupported card for HEIC).
            let encoded = null;
            try {
              encoded = await previewLimiter(() => encodePreviewImage(buffer));
            } catch {
              encoded = null;
            }
            // Send the transcode when it saved bytes, or whenever the raw
            // bytes can't be rendered by the browser (HEIC/HEIF) — there the
            // transcode is the only viewable form, size regardless.
            if (
              encoded &&
              (mustTranscode || encoded.bytes.length < buffer.length)
            ) {
              const webp = encoded.bytes;
              const CHUNK = 256 * 1024;
              send({
                t: "sftp-download-begin",
                path: msg.path,
                name,
                size: webp.length,
                preview: true,
                mime: encoded.mime,
                // The ORIGINAL's dimensions (not the downscaled preview's), so
                // the client shows the true size and can gate loading a very
                // large original on demand.
                origWidth: encoded.srcWidth,
                origHeight: encoded.srcHeight,
              });
              for (let off = 0; off < webp.length; off += CHUNK) {
                const chunk = webp.subarray(
                  off,
                  Math.min(off + CHUNK, webp.length),
                );
                bytesDown += chunk.length;
                sftpBytesDown += chunk.length;
                send({
                  t: "sftp-download-chunk",
                  path: msg.path,
                  dataB64: chunk.toString("base64"),
                  preview: true,
                });
              }
              sftpFilesDown += 1;
              send({
                t: "sftp-download-end",
                path: msg.path,
                preview: true,
                truncated: false,
              });
              return;
            }
            // A non-renderable image we couldn't transcode (sharp missing
            // HEIF support, or corrupt bytes) can't be shown raw — surface an
            // error so the client degrades to the download-only card rather
            // than piping unrenderable bytes into an <img>.
            if (mustTranscode) {
              return sendError(
                "Can't preview this image (unsupported format).",
                "sftp",
              );
            }
            if (MAX_DOWNLOAD_BYTES > 0 && stats.size > MAX_DOWNLOAD_BYTES) {
              return sendError(
                `File too large to download (> ${MAX_DOWNLOAD_MB} MB).`,
                "sftp",
              );
            }
            streamOriginal(0);
          });
          return;
        }

        // A capped preview (text head-read) transfers at most `cap` bytes, so
        // it may peek at a file past the whole-file download cap. Clamp the
        // client-supplied cap to the download cap so `maxBytes` can never be
        // abused to stream more than an ordinary download would allow.
        let cap =
          isPreview && typeof msg.maxBytes === "number" && msg.maxBytes > 0
            ? msg.maxBytes
            : 0;
        if (cap && MAX_DOWNLOAD_BYTES > 0 && cap > MAX_DOWNLOAD_BYTES) {
          cap = MAX_DOWNLOAD_BYTES;
        }
        if (!cap && MAX_DOWNLOAD_BYTES > 0 && stats.size > MAX_DOWNLOAD_BYTES) {
          return sendError(
            `File too large to download (> ${MAX_DOWNLOAD_MB} MB).`,
            "sftp",
          );
        }

        // Edit reads need the whole file in one message (they build an editor
        // buffer); it's already size-capped above.
        if (msg.edit === true) {
          s.readFile(msg.path, (err, buffer) => {
            if (err) return sendError(err.message, "sftp");
            send({
              t: "sftp-read",
              path: msg.path,
              name,
              dataB64: buffer.toString("base64"),
              edit: true,
              // Echo the diff correlation flag so the client routes this reply to
              // its diff collector instead of the editor (#76 review).
              ...(msg.diff === true ? { diff: true } : {}),
            });
          });
          return;
        }

        // Plain downloads AND previews stream in chunks so the browser can
        // show a progress bar (and cancel).
        streamOriginal(cap);
      }),
    );
  }

  // Directory listing: resolve the path, read entries, and resolve any
  // symlink targets. Extracted from the message switch to keep it thin.
  function handleList(msg) {
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
          // Resolve each symlink's target with `readlink` (no follow — this
          // only reads link metadata, never the pointed-at file) so the UI
          // can show `name → target`. Non-links need no extra round-trip.
          const links = entries.filter((e) => e.type === "link");
          if (links.length === 0) {
            return send({ t: "sftp-list", path: dir, entries });
          }
          const join = (name) => (dir.endsWith("/") ? dir : `${dir}/`) + name;
          let pending = links.length;
          for (const entry of links) {
            s.readlink(join(entry.name), (lErr, target) => {
              if (!lErr && typeof target === "string") entry.target = target;
              if (--pending === 0) {
                send({ t: "sftp-list", path: dir, entries });
              }
            });
          }
        });
      });
    });
  }

  // Write handler: a chunked upload (offset present) or a whole-file write.
  function handleWrite(msg) {
    withSftp((s) => {
      const buffer = Buffer.from(msg.dataB64 || "", "base64");
      if (typeof msg.offset === "number") {
        // Chunked upload: open on the first chunk, append (in order) on the
        // rest, close on the final one — this is what drives progress.
        handleChunkedWrite(s, msg, buffer);
      } else {
        // Whole-file write (inline-edit save / empty-file touch).
        if (MAX_UPLOAD_BYTES > 0 && buffer.length > MAX_UPLOAD_BYTES) {
          return sendError(
            `File too large to save (> ${MAX_UPLOAD_MB} MB).`,
            "sftp",
          );
        }
        s.writeFile(msg.path, buffer, (err) => {
          if (err) return sendError(err.message, "sftp");
          send({ t: "sftp-ok", op: "write", path: msg.path });
        });
      }
    });
  }

  // Stream a store-only ZIP of `roots` (enumerated to names+sizes first) over the
  // chunked download frames, reading each file one at a time and computing its
  // CRC incrementally so neither the whole tree nor a whole file is ever held in
  // memory. `downloadKey` is the client-facing path (drives its progress row and
  // cancel); `zipName` is the saved filename. `overLimit` builds the too-large
  // message for the byte cap.
  function streamZip(s, roots, downloadKey, zipName, overLimit) {
    // Cap concurrent transfers per session (#7): a zip stream occupies a slot.
    if (
      !downloads.has(downloadKey) &&
      MAX_TRANSFERS_PER_SESSION > 0 &&
      downloads.size >= MAX_TRANSFERS_PER_SESSION
    ) {
      return sendError(
        "Too many concurrent transfers. Wait for some to finish.",
        "sftp",
      );
    }
    enumerateZipEntries(s, roots, (err, entries) => {
      if (err) return sendError(err.message, "sftp");
      const nameBufs = entries.map((e) => Buffer.from(e.name, "utf8"));
      let content = 0;
      let archive = 22; // end-of-central-directory record
      for (let k = 0; k < entries.length; k++) {
        content += entries[k].size;
        archive += 30 + nameBufs[k].length + entries[k].size + 16; // local + name + data + descriptor
        archive += 46 + nameBufs[k].length; // central directory record
      }
      if (MAX_DOWNLOAD_BYTES > 0 && content > MAX_DOWNLOAD_BYTES) {
        return sendError(overLimit, "sftp");
      }
      // Classic ZIP is 32-bit; refuse (rather than silently overflow) an archive
      // or entry that would need ZIP64.
      if (exceedsZip32(archive) || entries.some((e) => exceedsZip32(e.size))) {
        return sendError(
          "Selection too large to zip (over 4 GB). Download items individually.",
          "sftp",
        );
      }

      let cancelled = false;
      let curStream = null;
      // Registered in the downloads map so a cancel / cleanup tears the current
      // file read down and stops the archive (matches the streamOriginal shape).
      downloads.set(downloadKey, {
        destroy() {
          cancelled = true;
          try {
            curStream?.destroy();
          } catch {
            /* stream already gone */
          }
        },
      });

      const emit = (buf) => {
        bytesDown += buf.length;
        sftpBytesDown += buf.length;
        send({
          t: "sftp-download-chunk",
          path: downloadKey,
          dataB64: buf.toString("base64"),
        });
      };

      send({
        t: "sftp-download-begin",
        path: downloadKey,
        name: zipName,
        size: archive,
      });

      const centralParts = [];
      let offset = 0;

      const finishArchive = () => {
        const centralBuf = Buffer.concat(centralParts);
        emit(centralBuf);
        emit(zipEndRecord(entries.length, centralBuf.length, offset));
        downloads.delete(downloadKey);
        sftpFilesDown += 1;
        send({ t: "sftp-download-end", path: downloadKey });
      };

      const processEntry = (idx) => {
        if (cancelled || ws.readyState !== ws.OPEN) {
          downloads.delete(downloadKey);
          return;
        }
        if (idx >= entries.length) return finishArchive();
        const nameBuf = nameBufs[idx];
        const local = zipLocalHeader(nameBuf.length);
        emit(local);
        emit(nameBuf);
        const entryOffset = offset;
        let crc = crc32Init();
        let written = 0;
        const rs = s.createReadStream(entries[idx].readPath);
        curStream = rs;
        rs.on("data", (chunk) => {
          crc = crc32Update(crc, chunk);
          written += chunk.length;
          emit(chunk);
          if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_BYTES) {
            rs.pause();
            const resume = setInterval(() => {
              if (ws.readyState !== ws.OPEN) {
                clearInterval(resume);
                rs.destroy();
              } else if (ws.bufferedAmount < WS_BACKPRESSURE_LOW_BYTES) {
                clearInterval(resume);
                rs.resume();
              }
            }, 25);
          }
        });
        rs.on("error", (e) => {
          if (!cancelled && downloads.has(downloadKey)) {
            downloads.delete(downloadKey);
            sendError(e.message, "sftp");
          }
        });
        rs.on("end", () => {
          curStream = null;
          const finalCrc = crc32Final(crc);
          emit(zipDataDescriptor(finalCrc, written));
          centralParts.push(
            zipCentralHeader(nameBuf.length, finalCrc, written, entryOffset),
            nameBuf,
          );
          offset += local.length + nameBuf.length + written + 16;
          if (exceedsZip32(offset) || exceedsZip32(written)) {
            // A file grew past 4 GB between stat and read — abort cleanly.
            downloads.delete(downloadKey);
            return sendError(
              "Selection too large to zip (over 4 GB). Download items individually.",
              "sftp",
            );
          }
          processEntry(idx + 1);
        });
      };
      processEntry(0);
    });
  }

  // Zip up a whole directory and stream it as one download.
  function handleDownloadDir(msg) {
    withSftp((s) => {
      const name =
        (msg.path.split("/").filter(Boolean).pop() || "download") + ".zip";
      streamZip(
        s,
        [{ path: msg.path, prefix: "" }],
        msg.path,
        name,
        `Folder too large to download (> ${MAX_DOWNLOAD_MB} MB).`,
      );
    });
  }

  // Zip up a set of selected files and stream them as one download.
  function handleDownloadMany(msg) {
    withSftp((s) => {
      const paths = Array.isArray(msg.paths) ? msg.paths.filter(Boolean) : [];
      if (paths.length === 0) return sendError("Nothing selected.", "sftp");
      const roots = paths.map((p) => ({
        path: p,
        prefix: p.split("/").filter(Boolean).pop() || "file",
      }));
      streamZip(
        s,
        roots,
        paths[0],
        "download.zip",
        `Selection too large to download (> ${MAX_DOWNLOAD_MB} MB).`,
      );
    });
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    // Reject a known message type with a missing/mistyped required field before
    // dispatch, so a malformed frame can't throw deep in an async handler.
    if (!isValidClientMessage(msg)) {
      logEvent("bad-message", {
        id: connId,
        ip: clientIp,
        kind: String(msg.t),
      });
      return;
    }
    // Any real shell/SFTP traffic counts as activity for the idle reaper;
    // latency pings deliberately don't, so an idle terminal still times out.
    if (msg.t !== "ping") touch();

    // Opt-in SFTP audit trail (#90): record the op + path (never contents/creds).
    if (AUDIT_LOG && msg.t.startsWith("sftp")) {
      logEvent("audit", {
        id: connId,
        ip: clientIp,
        user: sessionScope,
        elevated,
        op: msg.t,
        path: msg.path,
        // Bulk ops (e.g. sftp-download-many) carry their selection in `paths`;
        // record a bounded copy so the trail names what was accessed.
        paths: Array.isArray(msg.paths) ? msg.paths.slice(0, 100) : undefined,
        from: msg.from,
        to: msg.to,
      });
    }

    // Defense in depth: even with field validation, a handler can throw
    // asynchronously in ways a single frame check can't foresee. Guard the
    // synchronous dispatch so one bad frame degrades to a logged error on this
    // session instead of an uncaught exception that would crash the shared
    // process and drop every concurrent session.
    try {
      switch (msg.t) {
        case "connect":
          handleConnect(msg);
          break;

        case "data":
          if (shell) {
            bytesUp += Buffer.byteLength(msg.data || "", "utf8");
            shell.write(msg.data, "utf8");
          }
          break;

        case "resize":
          if (shell)
            shell.setWindow(
              Number(msg.rows) || 24,
              Number(msg.cols) || 80,
              0,
              0,
            );
          break;

        case "ping":
          // Latency probe: echo the timestamp straight back so the client can
          // measure round-trip time without disturbing the shell.
          send({ t: "pong", ts: Number(msg.ts) || 0 });
          break;

        case "hostkey-response":
          if (pendingHostVerify) {
            clearPromptTimeout();
            const verify = pendingHostVerify;
            pendingHostVerify = null;
            verify(msg.accept === true);
          }
          break;

        case "kbd-response":
          if (pendingKbdFinish) {
            clearPromptTimeout();
            const finish = pendingKbdFinish;
            pendingKbdFinish = null;
            finish(
              Array.isArray(msg.responses) ? msg.responses.map(String) : [],
            );
          }
          break;

        case "sftp-list":
          handleList(msg);
          break;

        case "sftp-read":
          handleRead(msg);
          break;

        case "sftp-follow":
          handleFollow(msg);
          break;

        case "sftp-follow-stop":
          handleFollowStop(msg);
          break;

        case "sftp-write":
          handleWrite(msg);
          break;

        case "sftp-write-resume":
          // Report the partial destination's current size so a resumed upload
          // knows where to continue. A missing file (or any stat error) yields
          // offset 0, telling the client to restart the upload from the start.
          withSftp((s) =>
            s.stat(msg.path, (err, st) => {
              const offset = err || !st ? 0 : Math.max(0, st.size || 0);
              send({ t: "sftp-write-at", path: msg.path, offset });
            }),
          );
          break;

        case "sftp-upload-cancel":
          // Abort an in-flight (or interrupted) upload and remove the partial
          // destination file so a half-written upload never lingers. The client
          // has already dropped its progress row.
          {
            const entry = uploads.get(msg.path);
            if (entry) {
              uploads.delete(msg.path);
              try {
                entry.stream.destroy();
              } catch {
                /* stream already gone */
              }
            }
            // Best-effort: remove the partial (ignore "no such file").
            withSftp((s) => s.unlink(msg.path, () => {}));
          }
          break;

        case "sftp-download-cancel":
          // Abort an in-flight streamed download. Remove the map entry first so the
          // stream's error/close handler stays silent (see the download handler),
          // then tear the read stream down. The source file is only read.
          {
            const stream = downloads.get(msg.path);
            if (stream) {
              downloads.delete(msg.path);
              try {
                stream.destroy();
              } catch {
                /* stream already gone */
              }
            }
          }
          break;

        case "sftp-rename":
          withSftp((s) =>
            s.rename(msg.from, msg.to, (err) => {
              if (err) return sendError(err.message, "sftp");
              send({ t: "sftp-ok", op: "rename", path: msg.to });
            }),
          );
          break;

        case "sftp-symlink":
          withSftp((s) =>
            s.symlink(msg.target, msg.path, (err) => {
              if (err) return sendError(err.message, "sftp");
              send({ t: "sftp-ok", op: "symlink", path: msg.path });
            }),
          );
          break;

        case "sftp-chmod":
          handleChmod(msg);
          break;

        case "sftp-checksum":
          handleChecksum(msg);
          break;

        case "sftp-df":
          withSftp((s) => {
            // The df figures come from the OpenSSH statvfs SFTP extension. ssh2
            // always defines the method, but it throws synchronously when the
            // server didn't negotiate the extension — so the call itself must be
            // guarded (a `typeof` check always passes). Fail gracefully either
            // way (sync throw or async err).
            const unsupported = () =>
              sendError("Disk usage isn't supported by this server.", "sftp");
            if (typeof s.ext_openssh_statvfs !== "function")
              return unsupported();
            try {
              s.ext_openssh_statvfs(msg.path, (err, st) => {
                if (err || !st) return unsupported();
                const unit = Number(st.f_frsize || st.f_bsize || 512);
                const total = Number(st.f_blocks) * unit;
                const free = Number(st.f_bavail) * unit;
                send({ t: "sftp-df", path: msg.path, total, free });
              });
            } catch {
              unsupported();
            }
          });
          break;

        case "sftp-download-dir":
          handleDownloadDir(msg);
          break;

        case "sftp-download-many":
          handleDownloadMany(msg);
          break;

        case "sftp-sudo":
          handleSudo(msg);
          break;

        case "sftp-find":
          handleFind(msg);
          break;

        case "sftp-grep":
          handleGrep(msg);
          break;

        case "sftp-copy":
          handleCopy(msg);
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

        case "thumb-purge":
          // Drop this connection's cached tiles (both login-user and elevated).
          if (sessionScope) {
            thumbCachePurge([`${sessionScope} `, `${sessionScope}#root `]);
          }
          break;

        case "disconnect":
          cleanup();
          ws.close();
          break;
      }
    } catch {
      sshErrors += 1;
      logEvent("handler-error", {
        id: connId,
        ip: clientIp,
        kind: String(msg.t),
      });
      try {
        sendError("The server hit an error handling that request.", "sftp");
      } catch {
        /* socket already gone */
      }
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
  if (BLOCK_PRIVATE_HOSTS) {
    console.log("> Private/internal host dialing blocked (SSRF guard)");
  }
  if (IDLE_TIMEOUT_MS > 0) {
    console.log(`> Idle sessions closed after ${IDLE_TIMEOUT_MS} ms`);
  }
  if (ACCESS_TOKEN) {
    console.log("> Relay access gate enabled (SSH_ACCESS_TOKEN set)");
  }
  if (ALLOW_SUDO) {
    console.log("> Elevated (sudo) file access enabled (SSH_ALLOW_SUDO=true)");
  }
  logEvent("server-start", {
    port,
    maxSessions: MAX_SESSIONS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    accessGate: accessTokenRequired(ACCESS_TOKEN),
    sudo: ALLOW_SUDO,
  });
});

/**
 * Graceful shutdown: stop accepting new connections, tell every live client the
 * server is going away, and exit once they've drained (or after a short grace
 * period). Lets a process manager (systemd, a container orchestrator) recycle
 * the relay without abruptly cutting active sessions.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("shutdown", { signal, activeSessions });
  server.close();
  for (const client of wss.clients) {
    try {
      client.send(
        JSON.stringify({
          t: "status",
          state: "closed",
          message: "Server is shutting down.",
        }),
      );
      client.close(1001, "server shutdown");
    } catch {
      /* client already gone */
    }
  }
  // Exit as soon as all sockets have closed, or force it after the grace period.
  const forceTimer = setTimeout(() => process.exit(0), 5000);
  forceTimer.unref?.();
  const drain = setInterval(() => {
    if (wss.clients.size === 0) {
      clearInterval(drain);
      process.exit(0);
    }
  }, 200);
  drain.unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Last-resort safety net. This is a single shared process relaying every
// session, so an uncaught exception or unhandled rejection anywhere (a stray
// throw in a library callback, a rejected promise with no `.catch`) would
// otherwise tear the whole server down and drop every concurrent connection.
// Log it and keep serving — the per-session guards above already contain most
// failures to the one session that caused them.
// Describe a thrown value for the log without dumping unbounded output. SSH
// credentials are relayed, never thrown, so an exception message/stack doesn't
// carry them; still, we cap the stack so a pathological error can't flood logs.
function describeError(err) {
  if (err instanceof Error) {
    // Bound both fields: the first stack line normally repeats the message, so a
    // huge message would otherwise flood stdout despite the 8-line cap.
    return {
      name: err.name,
      message: (err.message || "").slice(0, 500),
      stack: (err.stack || "")
        .split("\n")
        .slice(0, 8)
        .join("\n")
        .slice(0, 2000),
    };
  }
  return { name: typeof err, message: String(err).slice(0, 500) };
}
process.on("uncaughtException", (err) => {
  // Log the error name + (capped) stack so the most severe failures are
  // actually diagnosable in production, instead of a content-free "yes/no" (#11).
  logEvent("uncaught-exception", { level: "error", ...describeError(err) });
});
process.on("unhandledRejection", (reason) => {
  logEvent("unhandled-rejection", { level: "error", ...describeError(reason) });
});
