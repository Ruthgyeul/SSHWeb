"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyKeyModifiers,
  audioMimeType,
  compareHostKey,
  encodeMessage,
  filePreviewKind,
  formatSize,
  hostKeyId,
  imageMimeType,
  isLargeForEditor,
  isProbablyTextFile,
  isThumbnailable,
  joinPath,
  modeToOctal,
  parentPath,
  parseMessage,
  parseOctalMode,
  sniffMediaKind,
  suggestCopyName,
  TEXT_PREVIEW_MAX_BYTES,
  videoMimeType,
  type FileEntry,
  type ServerMessage,
} from "@/lib/sshProtocol";
import { getThemePreset } from "@/lib/terminalTheme";
import {
  clearThumbnailCache,
  fileVersionTag,
  getCachedThumbnails,
  putCachedThumbnail,
  thumbnailCacheKey,
} from "@/lib/thumbnailCache";
import {
  KNOWN_HOSTS_KEY,
  parseKnownHosts,
  serializeKnownHosts,
  type KnownHostMap,
} from "@/lib/knownHosts";
import { resumeUploadStart } from "@/lib/serverSecurity";
import { SITE_NAME, SSH_WS_PATH } from "@/config/siteConfig";
import { base64ToBytes, bytesToBase64, concatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";
import { triggerDownload } from "./download";
import {
  StatusDot,
  Uptime,
  LatencyChip,
  type SessionStatus,
} from "./SessionStatus";
import { XtermView, type XtermHandle } from "./XtermView";
import { ConnectForm, type ConnectDetails } from "./ConnectForm";
import {
  FileBrowser,
  type UploadItem,
  type DownloadItem,
  type SearchState,
  type SearchMode,
} from "./FileBrowser";
import { FileEditor, type EditorFile } from "./FileEditor";
import { Tunnels, type ForwardState, type NewForward } from "./Tunnels";
import { FilePreview, type PreviewMode } from "./FilePreview";
import { PasteConfirm } from "./PasteConfirm";
import { PromptDialog, type DialogRequest } from "./PromptDialog";
import { MobileKeys } from "./MobileKeys";
import { SnippetsBar } from "./SnippetsBar";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { TerminalSettings } from "./TerminalSettings";
import { useTerminalPrefs } from "./useTerminalPrefs";
import { AuthPromptModal, type AuthPromptState } from "./AuthPrompt";
import { ToastStack, useToasts } from "./Toast";

/** Upload chunk size; each chunk is one `sftp-write` message (drives progress). */
const UPLOAD_CHUNK = 256 * 1024;
/** How many uploads stream at once. The rest queue and start as slots free up,
 * so dropping a folder of hundreds of files reads only a few into memory at a
 * time (each active upload holds its whole file) instead of all at once. */
const MAX_INFLIGHT_UPLOADS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A file open in the preview modal (media viewed inline, or a download-only
 * fallback for types the browser can't render). */
interface PreviewState {
  path: string;
  name: string;
  /** Which surface to render; `unsupported` shows a download-only card. */
  kind: PreviewMode;
  /** `blob:` URL for the media/PDF element; empty until loaded / for markdown. */
  src: string;
  /** Decoded text for the `markdown` kind (rendered to HTML in the modal). */
  text?: string;
  /** True from the click until the file's bytes arrive — the modal opens
   * immediately in a loading state instead of waiting silently for transfer. */
  loading: boolean;
  /** Cached grid thumbnail (`data:` URL), painted instantly behind the spinner
   * while the full-resolution media loads. Absent in list view / for audio. */
  placeholder?: string;
  /** Raw bytes, kept so "Download" doesn't need a second round-trip. Absent for
   * `unsupported` previews, which stream the file only if the user downloads.
   * When `optimized` is set these are the *downscaled WebP preview*, not the
   * original — so Download must re-fetch the original instead of saving these. */
  bytes?: Uint8Array<ArrayBuffer>;
  /** True when `bytes`/`src` are a bridge-downscaled WebP preview of an image
   * rather than the original file. Keeps the view light while routing the
   * Download button to the untouched original. */
  optimized?: boolean;
  /** True while the full-resolution original is being fetched on demand (zoom /
   * "load original") to replace an `optimized` preview — drives a small badge;
   * the WebP stays visible until the original arrives. */
  loadingOriginal?: boolean;
  /** Bytes received so far while the preview streams in — drives the modal's
   * progress bar. Set once the `sftp-download-begin` for this preview arrives. */
  received?: number;
  /** Total size announced by `sftp-download-begin`, for the progress bar. */
  total?: number;
  /** Previewable files in the same view (display order), so the modal can step
   * ←/→ through them like a gallery. Empty/undefined for one-off opens. */
  siblings?: { path: string; name: string }[];
  /** True when a text preview was capped at `TEXT_PREVIEW_MAX_BYTES` and the
   * file is actually longer — the modal flags it's showing only the head. */
  truncated?: boolean;
  /** True when the decoded text contained U+FFFD replacement chars — a hint the
   * file isn't valid UTF-8 (a legacy encoding, or actually binary). */
  encodingWarning?: boolean;
}

/** Max concurrent grid-thumbnail reads. Enough to fill a visible screen of tiles
 * quickly without swamping the single bridge WebSocket when a folder holds
 * hundreds of images; the rest queue and drain as replies arrive. */
const MAX_INFLIGHT_THUMBS = 6;

/** In-memory budget for the recently-viewed preview cache (raw file bytes). A
 * revisited file re-opens instantly with no re-transfer; the LRU evicts the
 * oldest entries once the total exceeds this. Bytes (not blob URLs) are cached
 * so each open builds a fresh, independently-revoked `blob:` URL. */
const MAX_PREVIEW_CACHE_BYTES = 48 * 1024 * 1024;

/** Don't prefetch a gallery neighbour bigger than this — prefetching is a
 * latency nicety for the common case (folders of photos), not a reason to pull
 * a huge file the user may never step to. Bytes read from the entry's
 * `size:mtime` version tag. */
const PREFETCH_MAX_BYTES = 16 * 1024 * 1024;

/** Server path of the seekable media-stream endpoint (mirrors `server.mjs`). A
 * `<video>` points here with the session's `streamToken` so playback ranges are
 * served over HTTP instead of buffering the whole clip into a blob. */
const PREVIEW_STREAM_PATH = "/api/preview";

/** Build the `/api/preview` URL for a media (video/audio) path with the session's
 * stream token, so a `<video>`/`<audio>` plays over HTTP Range instead of
 * buffering the whole original into a blob. */
function mediaStreamSrc(token: string, path: string): string {
  return `${PREVIEW_STREAM_PATH}?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
}

/** The preview surface for a filename by extension: a media/PDF/Markdown kind,
 * a read-only `text` view for anything editable-as-text, or `unsupported`. Used
 * for the modal's loading state before bytes arrive (a cache hit / stream then
 * refines it, including magic-byte sniffing for mis-named media). */
function previewRenderKind(name: string): PreviewMode {
  return (
    filePreviewKind(name) ?? (isProbablyTextFile(name) ? "text" : "unsupported")
  );
}

/** Fields the preview modal needs to render a fully-loaded file, built from its
 * raw bytes. The kind is resolved by extension, then — for a `text`/`unsupported`
 * name — upgraded by sniffing the bytes' magic number, so a mis-named or
 * extensionless media file (a JPEG called `photo`) still previews as media.
 * Markdown/text decode to text (rendered in the modal); media/PDF get a `blob:`
 * URL. Shared by the streamed-in path and a preview-cache hit. */
function previewFieldsFromBytes(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeOverride?: string,
): Pick<PreviewState, "kind" | "src" | "text" | "bytes" | "encodingWarning"> {
  let kind = previewRenderKind(name);
  if (kind === "text" || kind === "unsupported") {
    const sniffed = sniffMediaKind(bytes);
    if (sniffed) kind = sniffed;
  }
  if (kind === "markdown" || kind === "text") {
    const text = new TextDecoder().decode(bytes);
    // A non-fatal decode substitutes U+FFFD for undecodable bytes; their
    // presence flags a likely non-UTF-8 (legacy-encoded or binary) file.
    return { kind, src: "", text, bytes, encodingWarning: text.includes("�") };
  }
  if (kind === "unsupported") {
    // Not decodable as media and not text — offer download only, no blob.
    return { kind, src: "", bytes };
  }
  // A server-transcoded image preview arrives as WebP regardless of the file's
  // name, so trust the bridge's `mimeOverride` when it sends one.
  const mime =
    mimeOverride ??
    ((kind === "pdf"
      ? "application/pdf"
      : (kind === "video"
          ? videoMimeType(name)
          : kind === "audio"
            ? audioMimeType(name)
            : imageMimeType(name)) ?? "application/octet-stream"));
  // A blob: URL renders large images/video/PDFs far faster than a giant data:
  // URL and lets <video> seek; revoked by the effect that watches preview.src.
  const src = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return { kind, src, bytes };
}

/** Only persist small thumbnails (the server-resized WebP images, a few KB). This
 * skips raw video clips and full images sent when server-side resizing is
 * unavailable, so the on-disk cache never balloons with multi-MB payloads. Length
 * is of the `data:` URL string (~1.33× the byte size). */
const THUMB_PERSIST_MAX_CHARS = 512 * 1024;

/** What a session reports up to the tab manager for its tab chip. */
export interface SessionMeta {
  label: string;
  status: SessionStatus;
}

// `SessionStatus` and the header status widgets (StatusDot/Uptime/LatencyChip)
// live in ./SessionStatus and are re-exported here so existing importers (the
// tab manager) keep resolving them from this module.
export type { SessionStatus };
export { StatusDot };

type Tab = "terminal" | "files" | "tunnels";

/** How many times to auto-reconnect a dropped session before giving up. */
const MAX_RECONNECT = 3;

/** Read the `host:port → fingerprint` map of trusted host keys (TOFU store). */
function loadKnownHosts(): KnownHostMap {
  try {
    return parseKnownHosts(localStorage.getItem(KNOWN_HOSTS_KEY));
  } catch {
    return {};
  }
}

/** Remember (or update) the trusted fingerprint for a host. */
function saveKnownHost(id: string, fingerprint: string) {
  try {
    const hosts = loadKnownHosts();
    hosts[id] = fingerprint;
    localStorage.setItem(KNOWN_HOSTS_KEY, serializeKnownHosts(hosts));
  } catch {
    /* storage unavailable (private mode) — verification just won't persist */
  }
}

/**
 * A single SSH session: owns one WebSocket to the bridge and the three pieces of
 * UI (connect form, xterm terminal, SFTP browser). Multiple of these run side by
 * side under the `SshClient` tab manager, so the terminal stays mounted even when
 * this session isn't the active tab (`active` toggles visibility, not mounting).
 *
 * If a live connection drops unexpectedly it auto-reconnects (a few times, with
 * backoff) using the credentials from the last connect, then offers a manual
 * "Reconnect" button.
 */
export function SshSession({
  active,
  onMeta,
}: {
  active: boolean;
  onMeta: (meta: SessionMeta) => void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<XtermHandle>(null);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [target, setTarget] = useState<{ user: string; host: string } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>("terminal");

  const [cwd, setCwd] = useState("~");
  // Mirror of cwd for the ws message handler, whose closure would otherwise go
  // stale (it's bound once when the socket opens).
  const cwdRef = useRef("~");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  // Active recursive subtree search (null = browsing the normal listing). The
  // query is kept so a late `sftp-find-result` for a stale query is ignored.
  const [search, setSearch] = useState<SearchState | null>(null);
  // Whether this deployment permits elevated (sudo) file access, learned from
  // the server's `caps` message once connected.
  const [canElevate, setCanElevate] = useState(false);
  // Whether SFTP operations are currently routed through `sudo` (root), and
  // whether an enable/disable request is in flight.
  const [elevated, setElevated] = useState(false);
  const [elevatedPending, setElevatedPending] = useState(false);
  const [authPrompt, setAuthPrompt] = useState<AuthPromptState | null>(null);
  // Files open in the inline editor (tabs), plus which one is shown and which
  // (if any) is being saved right now.
  const [editors, setEditors] = useState<EditorFile[]>([]);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Mirrors the open preview's path so a late `sftp-read` reply can tell whether
  // the user is still viewing that file before it builds a blob URL for it.
  const previewPathRef = useRef<string | null>(null);
  // Mirrors the full open-preview state so `stepPreview` (gallery ←/→) can read
  // the latest siblings/loading without being torn down and rebuilt each render.
  const previewRef = useRef<PreviewState | null>(null);
  // Paths currently being *prefetched* into the preview cache (adjacent gallery
  // images streamed ahead of a ←/→ step). Lets the download handlers buffer
  // their bytes without painting the modal; cleared as each stream ends.
  const prefetchPathsRef = useRef<Set<string>>(new Set());
  // Paths for which the full-resolution original is being fetched on demand to
  // replace an optimized (WebP) preview — so the download handlers paint the
  // original into the open modal instead of caching it over the fast WebP.
  const originalLoadPathsRef = useRef<Set<string>>(new Set());
  // Per-session capability token for the seekable /api/preview media endpoint
  // (from `caps`), read when building a video preview's `src`. Null when the
  // deployment didn't mint one — video then falls back to blob streaming.
  const streamTokenRef = useRef<string | null>(null);
  // Last playback position (seconds) per video path, so stepping the gallery
  // away from a clip and back resumes where you left off. In-memory only,
  // cleared on disconnect.
  const videoTimesRef = useRef<Map<string, number>>(new Map());
  // Cached grid-view image thumbnails, keyed by remote path → `data:` URL.
  // Populated lazily as tiles scroll into view; cleared on each directory change
  // (below) to bound memory. `requestedThumbsRef` dedupes in-flight requests so
  // a tile re-rendering never re-fetches.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // Mirror of `thumbnails` so callbacks can read the latest placeholder without
  // listing `thumbnails` as a dependency (it changes on every tile load).
  const thumbnailsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    thumbnailsRef.current = thumbnails;
  }, [thumbnails]);
  const requestedThumbsRef = useRef<Set<string>>(new Set());
  // Bound how many thumbnail reads are outstanding at once so a directory of
  // hundreds of images loads the visible tiles first instead of flooding the
  // bridge with every request the moment they scroll near the viewport.
  const thumbInFlightRef = useRef(0);
  const thumbQueueRef = useRef<string[]>([]);
  // path → `size:mtime` version tag for the current listing, for cache keys.
  const entryVersionRef = useRef<Map<string, string>>(new Map());
  // Mirrors of state the (bound-once) ws message handler reads: the connection
  // scope for cache keys, and whether we're elevated (root) — elevated reads are
  // never persisted so a `sudo` thumbnail can't linger on disk.
  const scopeRef = useRef("");
  const elevatedRef = useRef(false);
  // Active local port-forwards, keyed by their client-generated id.
  const [forwards, setForwards] = useState<Record<string, ForwardState>>({});
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  // Accumulated download chunks (bytes), keyed by remote path. A ref so pushing
  // chunks doesn't re-render; the `downloads` state above drives the progress UI.
  const downloadBuffersRef = useRef<
    Record<string, { name: string; chunks: Uint8Array[] }>
  >({});
  // Accumulated preview chunks (bytes), keyed by remote path. Previews stream in
  // over the same `sftp-download-*` frames (tagged `preview`), but land in the
  // modal (as a blob/text) instead of a saved file — so they buffer here.
  const previewBuffersRef = useRef<Record<string, Uint8Array[]>>({});
  // Server-supplied content type for a streaming preview, captured from its
  // `sftp-download-begin`. Present only when the bridge transcoded an image to a
  // WebP preview — its presence marks the bytes as an *optimized* (non-original)
  // preview so Download re-fetches the original.
  const previewMimeRef = useRef<Record<string, string>>({});
  // LRU cache of recently-viewed preview file bytes, keyed by path + version
  // (size:mtime) so an edited file re-fetches. A `Map` keeps insertion order for
  // eviction; `previewCacheBytesRef` tracks the running total against the budget.
  // Elevated (root) reads are never cached — they must not linger after de-elevate.
  const previewCacheRef = useRef<
    Map<
      string,
      {
        name: string;
        bytes: Uint8Array<ArrayBuffer>;
        // Set when `bytes` are a downscaled WebP preview (not the original), with
        // the WebP content type for building the blob. Download re-fetches the
        // original in that case.
        optimized?: boolean;
        mime?: string;
      }
    >
  >(new Map());
  const previewCacheBytesRef = useRef(0);
  // Text captured at save time per path, so `sftp-ok` can reconcile the editor's
  // saved content (marking that file clean) without a re-read.
  const editorSaveTextRef = useRef<Record<string, string>>({});
  // In-flight chunked uploads, keyed by remote path. Holds the source File and
  // enough state to cancel or resume: `sent` tracks bytes acknowledged as sent,
  // `cancelled` short-circuits the streaming loop, `running` guards against two
  // loops (e.g. an auto-resume racing a manual one) driving the same upload,
  // `interrupted` marks an upload paused by a dropped connection (awaiting
  // resume), and `queued` marks one still waiting behind the concurrency limit.
  const uploadCtlRef = useRef<
    Record<
      string,
      {
        file: File;
        rel: string;
        needsDir: boolean;
        total: number;
        sent: number;
        cancelled: boolean;
        running: boolean;
        interrupted: boolean;
        queued: boolean;
      }
    >
  >({});
  // Upload scheduler: paths waiting to start (each with the byte offset to begin
  // from — 0 for a fresh upload, >0 for a resume) and how many are streaming now.
  // Bounds concurrent uploads to MAX_INFLIGHT_UPLOADS so a big batch doesn't read
  // every file into memory or flood the single bridge socket at once.
  const uploadQueueRef = useRef<{ path: string; startOffset: number }[]>([]);
  const uploadInFlightRef = useRef(0);
  // Lets the (bound-once) ws message handler kick the upload queue once the
  // bridge reports a partial's size — `pumpUploads` is defined further down.
  const pumpUploadsRef = useRef<() => void>(() => {});

  // Round-trip latency (ms) to the SSH bridge, sampled while connected.
  const [latency, setLatency] = useState<number | null>(null);
  // Epoch ms when the session first reached "connected" (drives the uptime clock).
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  // A pending multi-line paste awaiting user confirmation before it runs.
  const [pastePending, setPastePending] = useState<string | null>(null);
  // The active in-app prompt/confirm dialog (replaces window.prompt/confirm).
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  // Whether the keyboard-shortcuts cheat sheet is open.
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Transient error/notice toasts (surface failures that would otherwise leave
  // the UI silent — e.g. an over-cap upload or download the bridge rejects).
  const { toasts, notify, dismiss } = useToasts();
  // Render-safe mirror of "am I connected?" for the ws message handler, whose
  // closure can't read the `connected` derived value directly.
  const connectedRef = useRef(false);

  // Terminal appearance (font size + color theme), shared across all sessions.
  const [termPrefs, updateTermPrefs] = useTerminalPrefs();

  // Sticky on-screen modifiers (mobile key bar). State drives the button
  // highlight; refs let the terminal's own input handler read them synchronously.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  // Whether we hold credentials from a prior connect (drives the Reconnect UI);
  // mirrors lastDetailsRef but is render-safe.
  const [hasLast, setHasLast] = useState(false);

  // Reconnection bookkeeping (refs so the ws close handler sees fresh values).
  const lastDetailsRef = useRef<ConnectDetails | null>(null);
  const userClosedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const reconnectingRef = useRef(false);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  const send = useCallback((msg: Parameters<typeof encodeMessage>[0]) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(msg));
  }, []);

  const listDir = useCallback(
    (path: string) => {
      setFilesLoading(true);
      send({ t: "sftp-list", path });
    },
    [send],
  );

  // Drain the thumbnail queue up to the concurrency limit. Each `thumb` reply
  // (success, skip, or error — the server always replies) frees a slot and calls
  // this again, so the queue keeps flowing until it empties.
  const pumpThumbs = useCallback(() => {
    while (
      thumbInFlightRef.current < MAX_INFLIGHT_THUMBS &&
      thumbQueueRef.current.length > 0
    ) {
      const path = thumbQueueRef.current.shift()!;
      thumbInFlightRef.current += 1;
      send({ t: "sftp-read", path, thumb: true });
    }
  }, [send]);

  // Lazily fetch a grid thumbnail for `path`, at most once (the ref dedupes so a
  // tile scrolling in and out never re-requests). The request is queued behind a
  // concurrency limit; the reply arrives as an `sftp-read` with `thumb: true` and
  // lands in the `thumbnails` cache (and, when not elevated, IndexedDB).
  const requestThumbnail = useCallback(
    (path: string) => {
      if (requestedThumbsRef.current.has(path)) return;
      requestedThumbsRef.current.add(path);
      thumbQueueRef.current.push(path);
      pumpThumbs();
    },
    [pumpThumbs],
  );

  // "Clear thumbnail cache" (settings): wipe the persistent IndexedDB store and
  // the in-memory cache, then let the visible tiles re-request from the bridge
  // (clearing `requestedThumbsRef` un-blocks their intersection observers).
  const clearThumbnails = useCallback(async () => {
    await clearThumbnailCache();
    requestedThumbsRef.current = new Set();
    thumbQueueRef.current = [];
    thumbInFlightRef.current = 0;
    setThumbnails({});
  }, []);

  // Cache key for a path: path + its version tag (size:mtime) so an edited file
  // misses and re-fetches. Falls back to the bare path when the version is
  // unknown (e.g. a search hit not in the current listing).
  const previewCacheKeyFor = useCallback((path: string) => {
    const version = entryVersionRef.current.get(path);
    return version ? `${path} ${version}` : path;
  }, []);

  // Store a fully-loaded preview's bytes in the LRU (unless elevated, or bigger
  // than the whole budget), evicting the oldest entries once over budget.
  const cachePreview = useCallback(
    (
      path: string,
      name: string,
      bytes: Uint8Array<ArrayBuffer>,
      optimized?: boolean,
      mime?: string,
    ) => {
      if (elevatedRef.current || bytes.length > MAX_PREVIEW_CACHE_BYTES) return;
      const key = previewCacheKeyFor(path);
      const cache = previewCacheRef.current;
      const existing = cache.get(key);
      if (existing) previewCacheBytesRef.current -= existing.bytes.length;
      cache.delete(key);
      cache.set(key, { name, bytes, optimized, mime });
      previewCacheBytesRef.current += bytes.length;
      // Evict oldest (front of the Map) until back within budget.
      while (previewCacheBytesRef.current > MAX_PREVIEW_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        const dropped = cache.get(oldest);
        cache.delete(oldest);
        if (dropped) previewCacheBytesRef.current -= dropped.bytes.length;
      }
    },
    [previewCacheKeyFor],
  );

  const clearPreviewCache = useCallback(() => {
    previewCacheRef.current.clear();
    previewCacheBytesRef.current = 0;
    prefetchPathsRef.current.clear();
  }, []);

  // Stream the gallery neighbours of `path` (the previous & next image) into the
  // preview cache ahead of a ←/→ step, so paging through a folder of photos is
  // instant. Only images (the common case), never elevated (never cached), and
  // never a neighbour already cached, in flight, or bigger than
  // `PREFETCH_MAX_BYTES`. The download handlers recognise these paths via
  // `prefetchPathsRef` and buffer their bytes without painting the modal.
  const prefetchNeighbors = useCallback(
    (path: string, siblings?: { path: string; name: string }[]) => {
      if (elevatedRef.current || !siblings || siblings.length < 2) return;
      const idx = siblings.findIndex((s) => s.path === path);
      if (idx < 0) return;
      const n = siblings.length;
      for (const delta of [1, -1]) {
        const nb = siblings[(idx + delta + n) % n];
        if (!nb || nb.path === path) continue;
        if (filePreviewKind(nb.name) !== "image") continue;
        if (previewCacheRef.current.has(previewCacheKeyFor(nb.path))) continue;
        if (prefetchPathsRef.current.has(nb.path)) continue;
        const version = entryVersionRef.current.get(nb.path);
        const size = version ? parseInt(version.split(":")[0], 10) : 0;
        if (size > PREFETCH_MAX_BYTES) continue;
        prefetchPathsRef.current.add(nb.path);
        // Neighbours are images (checked above) — prefetch the light WebP too.
        send({ t: "sftp-read", path: nb.path, preview: true, previewResize: true });
      }
    },
    [send, previewCacheKeyFor],
  );

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.t) {
        case "status":
          if (msg.state === "connected") {
            wasConnectedRef.current = true;
            reconnectingRef.current = false;
            attemptRef.current = 0;
            setStatus("connected");
            setConnectedAt((at) => at ?? Date.now());
            setStatusMessage("");
            xtermRef.current?.writeln(
              "\x1b[32m✓ Connected.\x1b[0m Type as you would in any shell.",
            );
            listDir(".");
            // A reconnect that follows a mid-transfer drop leaves uploads
            // "interrupted" — kick off a resume for each so a big upload picks
            // up where the dropped connection left off (see `sftp-write-at`).
            for (const [path, ctl] of Object.entries(uploadCtlRef.current)) {
              if (ctl.interrupted && !ctl.running && !ctl.cancelled) {
                send({ t: "sftp-write-resume", path });
              }
            }
          } else if (msg.state === "closed") {
            setStatusMessage(msg.message || "Connection closed.");
          } else if (msg.state === "error") {
            setStatusMessage(msg.message || "Connection error.");
          }
          break;

        case "data":
          xtermRef.current?.write(base64ToBytes(msg.data));
          break;

        case "pong":
          setLatency(Math.max(0, Date.now() - msg.ts));
          break;

        case "hostkey": {
          const id = hostKeyId(msg.host, msg.port);
          const verdict = compareHostKey(loadKnownHosts()[id], msg.fingerprint);
          if (verdict === "match") {
            send({ t: "hostkey-response", accept: true });
          } else {
            setAuthPrompt({
              kind: "hostkey",
              host: msg.host,
              port: msg.port,
              fingerprint: msg.fingerprint,
              keyType: msg.keyType,
              verdict,
            });
          }
          break;
        }

        case "kbd-interactive":
          setAuthPrompt({
            kind: "kbd",
            name: msg.name,
            instructions: msg.instructions,
            prompts: msg.prompts,
          });
          break;

        case "caps":
          setCanElevate(msg.sudo);
          streamTokenRef.current = msg.streamToken ?? null;
          break;

        case "sftp-sudo":
          setElevated(msg.enabled);
          setElevatedPending(false);
          if (msg.enabled) {
            notify("success", "Elevated access on — file operations run as root.");
          }
          // The access identity just changed, so drop every cached thumbnail:
          // an image only root could read must not linger after dropping root
          // (nor should a user-visible one be assumed still readable as root).
          // The re-list below re-fetches thumbnails under the new identity.
          requestedThumbsRef.current = new Set();
          thumbQueueRef.current = [];
          thumbInFlightRef.current = 0;
          setThumbnails({});
          // Drop cached preview bytes too: content only root could read must not
          // linger after de-elevate (and a user-visible file shouldn't be assumed
          // still readable as root).
          clearPreviewCache();
          // Re-list the current directory so the view reflects root's access.
          listDir(cwdRef.current);
          break;

        case "sftp-list":
          // Landing in a different directory invalidates the thumbnail cache
          // (a plain refresh of the same directory keeps it, so re-listing after
          // a file op doesn't re-fetch every image).
          if (msg.path !== cwdRef.current) {
            requestedThumbsRef.current = new Set();
            thumbQueueRef.current = [];
            thumbInFlightRef.current = 0;
            setThumbnails({});
          }
          cwdRef.current = msg.path;
          setCwd(msg.path);
          setEntries(msg.entries);
          setFilesLoading(false);
          // A fresh listing (navigation or refresh) exits search mode.
          setSearch(null);
          break;

        case "sftp-find-result":
          // Apply only if it answers the name search we're still showing (a
          // stale reply for an earlier query, or a find reply arriving after the
          // user switched to a content search, is dropped).
          setSearch((prev) =>
            prev && prev.mode === "name" && prev.query === msg.query
              ? {
                  ...prev,
                  loading: false,
                  results: msg.entries,
                  truncated: msg.truncated,
                }
              : prev,
          );
          break;

        case "sftp-grep-result":
          // Same reconciliation as find, but for the content (grep) axis.
          setSearch((prev) =>
            prev && prev.mode === "content" && prev.query === msg.query
              ? {
                  ...prev,
                  loading: false,
                  results: msg.entries,
                  truncated: msg.truncated,
                }
              : prev,
          );
          break;

        case "sftp-read":
          if (msg.edit) {
            const text = new TextDecoder().decode(base64ToBytes(msg.dataB64));
            setEditors((prev) =>
              prev.some((e) => e.path === msg.path)
                ? prev // already open — just focus it (don't clobber edits)
                : [...prev, { path: msg.path, name: msg.name, content: text }],
            );
            setActiveEditor(msg.path);
          } else if (msg.thumb) {
            // Free the concurrency slot and let the next queued tile go, whether
            // this one produced a thumbnail or not.
            thumbInFlightRef.current = Math.max(0, thumbInFlightRef.current - 1);
            pumpThumbs();
            // Empty payload = server skipped it (too big / not decodable): keep
            // the generic icon. `requestedThumbsRef` already blocks a re-request.
            if (msg.dataB64) {
              // The bridge always downscales a thumbnail to WebP (image or video
              // poster frame) — it never sends a full-size original as a thumb —
              // so a thumb payload is always `image/webp`.
              const mime = msg.mime ?? "image/webp";
              const dataUrl = `data:${mime};base64,${msg.dataB64}`;
              setThumbnails((prev) => ({ ...prev, [msg.path]: dataUrl }));
              // Persist so a return visit paints instantly — but never persist a
              // root-read (elevated) thumbnail (those stay in-memory only), nor a
              // large payload (only the small resized thumbnails are worth caching).
              if (
                !elevatedRef.current &&
                dataUrl.length <= THUMB_PERSIST_MAX_CHARS
              ) {
                const version = entryVersionRef.current.get(msg.path);
                if (version) {
                  void putCachedThumbnail(
                    thumbnailCacheKey(scopeRef.current, msg.path, version),
                    dataUrl,
                  );
                }
              }
            }
          } else {
            // Plain one-shot read (zip of a folder / multi-select). Previews now
            // stream in via the `sftp-download-*` frames below, not here.
            triggerDownload(msg.name, base64ToBytes(msg.dataB64));
          }
          break;

        case "sftp-download-begin":
          if (msg.preview) {
            // A preview stream: buffer chunks and drive the modal's progress bar
            // instead of registering a download row. A prefetch (adjacent gallery
            // image) buffers silently; otherwise ignore a stale begin the user
            // already navigated away from.
            const isPrefetch = prefetchPathsRef.current.has(msg.path);
            if (previewPathRef.current !== msg.path && !isPrefetch) break;
            previewBuffersRef.current[msg.path] = [];
            // A `mime` here means the bridge sent a transcoded (WebP) preview
            // rather than the original bytes; remember it for the end frame.
            if (msg.mime) previewMimeRef.current[msg.path] = msg.mime;
            else delete previewMimeRef.current[msg.path];
            setPreview((prev) =>
              prev && prev.path === msg.path
                ? { ...prev, received: 0, total: msg.size }
                : prev,
            );
            break;
          }
          downloadBuffersRef.current[msg.path] = { name: msg.name, chunks: [] };
          setDownloads((d) => ({
            ...d,
            [msg.path]: {
              path: msg.path,
              name: msg.name,
              received: 0,
              total: msg.size,
            },
          }));
          break;

        case "sftp-download-chunk": {
          if (msg.preview) {
            const chunks = previewBuffersRef.current[msg.path];
            if (!chunks) break;
            const bytes = base64ToBytes(msg.dataB64);
            chunks.push(bytes);
            setPreview((prev) =>
              prev && prev.path === msg.path
                ? { ...prev, received: (prev.received ?? 0) + bytes.length }
                : prev,
            );
            break;
          }
          const buf = downloadBuffersRef.current[msg.path];
          if (!buf) break;
          const bytes = base64ToBytes(msg.dataB64);
          buf.chunks.push(bytes);
          setDownloads((d) => {
            const cur = d[msg.path];
            if (!cur) return d;
            return {
              ...d,
              [msg.path]: { ...cur, received: cur.received + bytes.length },
            };
          });
          break;
        }

        case "sftp-download-end": {
          if (msg.preview) {
            const chunks = previewBuffersRef.current[msg.path];
            delete previewBuffersRef.current[msg.path];
            const serverMime = previewMimeRef.current[msg.path];
            delete previewMimeRef.current[msg.path];
            // A server mime means these bytes are a downscaled WebP preview, not
            // the original — so Download must re-fetch the original.
            const optimized = !!serverMime;
            const wasPrefetch = prefetchPathsRef.current.delete(msg.path);
            // An on-demand original load (zoom / "load original") replacing an
            // optimized preview: paint it but keep the fast WebP in the cache.
            const isOriginalLoad = originalLoadPathsRef.current.delete(msg.path);
            if (!chunks) break;
            const bytes = concatBytes(chunks);
            const name = msg.path.split("/").pop() || "file";
            // Cache the fully-received bytes even if the user has since stepped
            // away — the next visit reuses them without re-transfer. A truncated
            // (head-only) text read is never cached: a re-open must re-read. An
            // original-load isn't cached either, so re-opening still paints the
            // light WebP first and zoom re-fetches the original.
            if (!msg.truncated && !isOriginalLoad)
              cachePreview(msg.path, name, bytes, optimized, serverMime);
            // Only paint if still viewing this file (modal open, same path). A
            // prefetch that finished in the background just stays cached.
            if (previewPathRef.current !== msg.path) break;
            // Build the render fields (may create a blob URL) only now that we're
            // committing to paint this file.
            const fields = previewFieldsFromBytes(name, bytes, serverMime);
            // A capped (head-only) read that magic-byte-sniffs as media was a
            // mis-named/extensionless media file requested as text — its head
            // can't render, so discard it and re-read the whole file uncapped.
            if (
              msg.truncated &&
              fields.kind !== "text" &&
              fields.kind !== "markdown" &&
              fields.kind !== "unsupported"
            ) {
              if (fields.src.startsWith("blob:")) URL.revokeObjectURL(fields.src);
              send({ t: "sftp-read", path: msg.path, preview: true });
              break;
            }
            setPreview((prev) =>
              prev && prev.path === msg.path
                ? {
                    ...prev,
                    ...fields,
                    loading: false,
                    received: undefined,
                    total: undefined,
                    truncated: msg.truncated === true,
                    optimized,
                    loadingOriginal: false,
                  }
                : prev,
            );
            // With the viewed file painted, warm its neighbours for the next
            // ←/→ step (unless this stream was itself a promoted prefetch).
            if (!wasPrefetch) prefetchNeighbors(msg.path, previewRef.current?.siblings);
            break;
          }
          const buf = downloadBuffersRef.current[msg.path];
          delete downloadBuffersRef.current[msg.path];
          setDownloads((d) => {
            const rest = { ...d };
            delete rest[msg.path];
            return rest;
          });
          if (buf) triggerDownload(buf.name, concatBytes(buf.chunks));
          break;
        }

        case "sftp-write-at": {
          // Resume handshake reply: the bridge told us how much of the partial it
          // already has. Continue the upload from there (or restart at 0 when the
          // file is gone); if it's already complete, just drop the row.
          const ctl = uploadCtlRef.current[msg.path];
          if (!ctl || ctl.running || ctl.cancelled) break;
          const { offset, done } = resumeUploadStart(msg.offset, ctl.total);
          if (done && ctl.total > 0) {
            delete uploadCtlRef.current[msg.path];
            setUploads((u) => {
              const rest = { ...u };
              delete rest[msg.path];
              return rest;
            });
            listDir(cwdRef.current);
          } else {
            // Continue the upload through the shared queue so a resume respects
            // the same concurrency limit as a fresh upload.
            ctl.queued = true;
            uploadQueueRef.current.push({ path: msg.path, startOffset: offset });
            pumpUploadsRef.current();
          }
          break;
        }

        case "sftp-ok":
          if (msg.op === "write") {
            delete uploadCtlRef.current[msg.path];
            setUploads((u) => {
              const rest = { ...u };
              delete rest[msg.path];
              return rest;
            });
            setSavingPath((cur) => (cur === msg.path ? null : cur));
            const saved = editorSaveTextRef.current[msg.path];
            if (saved !== undefined) {
              setEditors((prev) =>
                prev.map((e) =>
                  e.path === msg.path ? { ...e, content: saved } : e,
                ),
              );
              delete editorSaveTextRef.current[msg.path];
            }
          }
          listDir(cwdRef.current);
          break;

        case "forward-opened":
          setForwards((f) => ({
            ...f,
            [msg.id]: {
              id: msg.id,
              kind: msg.kind,
              bindHost: msg.bindHost,
              bindPort: msg.bindPort,
              destHost: msg.destHost,
              destPort: msg.destPort,
              status: "open",
              conns: f[msg.id]?.conns ?? 0,
            },
          }));
          break;

        case "forward-closed":
          setForwards((f) => {
            const rest = { ...f };
            delete rest[msg.id];
            return rest;
          });
          break;

        case "forward-error":
          notify("error", `Port forward failed: ${msg.message}`);
          setForwards((f) => {
            const cur = f[msg.id];
            if (!cur) return f; // error for a forward we already dropped
            return {
              ...f,
              [msg.id]: { ...cur, status: "error", error: msg.message },
            };
          });
          break;

        case "forward-conn":
          setForwards((f) => {
            const cur = f[msg.id];
            if (!cur) return f;
            return { ...f, [msg.id]: { ...cur, conns: msg.count } };
          });
          break;

        case "error":
          if (msg.scope === "sftp") {
            // SFTP errors only happen while connected, where the overlay's
            // status text is hidden — a toast is the only visible channel.
            // Clear any in-flight spinners so a failed list/save doesn't hang.
            setFilesLoading(false);
            setSavingPath(null);
            setElevatedPending(false);
            // An in-flight "load original" that fails (e.g. the original is over
            // the download cap) should keep the WebP preview and just clear the
            // loading badge so it can be retried.
            originalLoadPathsRef.current.clear();
            // A preview read that fails (e.g. over the download cap, or a read
            // error) must not leave the modal spinning forever: drop it to the
            // download-only card so the user still has a way to fetch the file.
            setPreview((prev) =>
              prev && prev.loading
                ? {
                    ...prev,
                    loading: false,
                    kind: "unsupported",
                    received: undefined,
                    total: undefined,
                  }
                : prev && prev.loadingOriginal
                  ? { ...prev, loadingOriginal: false }
                  : prev,
            );
            notify("error", msg.message);
          } else {
            // Shell/auth errors: echo into the terminal, and while connected
            // also toast so the user sees it even away from the terminal tab.
            // Before connecting, the overlay shows the status text instead.
            xtermRef.current?.writeln(`\x1b[31m✗ ${msg.message}\x1b[0m`);
            if (connectedRef.current) notify("error", msg.message);
            else setStatusMessage(msg.message);
          }
          break;
      }
    },
    [listDir, send, notify, pumpThumbs, cachePreview, clearPreviewCache, prefetchNeighbors],
  );

  // openSocket and scheduleReconnect reference each other; a ref breaks the
  // cycle (openSocket calls scheduleReconnect directly; scheduleReconnect calls
  // the latest openSocket via the ref).
  const openSocketRef = useRef<((details: ConnectDetails) => void) | null>(null);

  const scheduleReconnect = useCallback(() => {
    const next = attemptRef.current + 1;
    if (next > MAX_RECONNECT || !lastDetailsRef.current) {
      reconnectingRef.current = false;
      setStatus("dropped");
      setStatusMessage("Connection lost.");
      return;
    }
    attemptRef.current = next;
    reconnectingRef.current = true;
    setStatus("reconnecting");
    setStatusMessage(`Reconnecting… (attempt ${next}/${MAX_RECONNECT})`);
    const delay = Math.min(1000 * 2 ** (next - 1), 8000);
    reconnectTimerRef.current = window.setTimeout(() => {
      if (lastDetailsRef.current) openSocketRef.current?.(lastDetailsRef.current);
    }, delay);
  }, []);

  // Open a socket and start the handshake. Used for both the first connect and
  // each auto-reconnect attempt; `connect` (below) wraps it with fresh state.
  const openSocket = useCallback(
    (details: ConnectDetails) => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${scheme}://${window.location.host}${SSH_WS_PATH}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        const size = xtermRef.current?.fit() ?? { cols: 80, rows: 24 };
        send({
          t: "connect",
          host: details.host,
          port: details.port,
          username: details.username,
          password: details.password,
          privateKey: details.privateKey,
          passphrase: details.passphrase,
          cols: size.cols,
          rows: size.rows,
        });
      };
      ws.onmessage = (event) => {
        const msg = parseMessage<ServerMessage>(String(event.data));
        if (msg) handleServerMessage(msg);
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (userClosedRef.current) return; // disconnect() owns the state
        if (wasConnectedRef.current || reconnectingRef.current) {
          // A live session dropped — try to bring it back.
          wasConnectedRef.current = false;
          scheduleReconnect();
        } else {
          // Never reached "connected" → auth/host failure; don't loop.
          setStatus("error");
        }
      };
      ws.onerror = () => {
        setStatusMessage("WebSocket error — is the SSH bridge running?");
      };
    },
    [handleServerMessage, send, scheduleReconnect],
  );

  // Keep the ref pointing at the latest openSocket for scheduleReconnect.
  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  // Fresh, user-initiated connect: reset all reconnection state.
  const connect = useCallback(
    (details: ConnectDetails) => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      lastDetailsRef.current = details;
      setHasLast(true);
      userClosedRef.current = false;
      wasConnectedRef.current = false;
      reconnectingRef.current = false;
      attemptRef.current = 0;
      setStatus("connecting");
      setStatusMessage("");
      setAuthPrompt(null);
      setLatency(null);
      setConnectedAt(null);
      setTarget({ user: details.username, host: details.host });
      openSocket(details);
    },
    [openSocket],
  );

  const reconnectNow = useCallback(() => {
    if (!lastDetailsRef.current) return;
    attemptRef.current = 0;
    connect(lastDetailsRef.current);
  }, [connect]);

  const disconnect = useCallback(() => {
    userClosedRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectingRef.current = false;
    send({ t: "disconnect" });
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("idle");
    setTarget(null);
    setEntries([]);
    setSearch(null);
    setCanElevate(false);
    setElevated(false);
    setElevatedPending(false);
    setStatusMessage("");
    setAuthPrompt(null);
    setEditors([]);
    setActiveEditor(null);
    setSavingPath(null);
    editorSaveTextRef.current = {};
    setForwards({});
    setPreview(null);
    setPastePending(null);
    setDialog(null);
    setShowShortcuts(false);
    setLatency(null);
    setConnectedAt(null);
    setUploads({});
    setDownloads({});
    uploadCtlRef.current = {};
    uploadQueueRef.current = [];
    uploadInFlightRef.current = 0;
    downloadBuffersRef.current = {};
    previewBuffersRef.current = {};
    previewMimeRef.current = {};
    previewCacheRef.current.clear();
    previewCacheBytesRef.current = 0;
    prefetchPathsRef.current.clear();
    originalLoadPathsRef.current.clear();
    streamTokenRef.current = null;
    videoTimesRef.current.clear();
    setHasLast(false);
    ctrlRef.current = false;
    altRef.current = false;
    setCtrlArmed(false);
    setAltArmed(false);
    xtermRef.current?.clear();
  }, [send]);

  // Open a file in the preview modal. On a cache hit (a recently-viewed file)
  // it paints instantly from the cached bytes with no re-transfer; otherwise it
  // opens immediately in a loading state (with the cached grid thumbnail as an
  // instant placeholder, if any) and streams the bytes in. `siblings` lets the
  // modal step ←/→ through the other previewable files in the same view.
  const openPreviewFile = useCallback(
    (path: string, name: string, siblings?: { path: string; name: string }[]) => {
      // Video AND audio with a stream token (non-elevated) play over the
      // seekable HTTP endpoint: no whole-file transfer, original quality, and the
      // browser can seek instantly. Elevated sessions keep the blob path (the
      // endpoint reads as the login user, so it can't reach root-only files).
      const mediaKind = filePreviewKind(name);
      if (
        !elevatedRef.current &&
        streamTokenRef.current &&
        (mediaKind === "video" || mediaKind === "audio")
      ) {
        setPreview({
          path,
          name,
          kind: mediaKind,
          src: mediaStreamSrc(streamTokenRef.current, path),
          loading: false,
          // The cached grid thumbnail (video poster frame) shows instantly as the
          // <video> poster while the stream initializes — no black flash.
          placeholder: thumbnailsRef.current[path],
          siblings,
        });
        prefetchNeighbors(path, siblings);
        return;
      }
      const key = previewCacheKeyFor(path);
      const hit = previewCacheRef.current.get(key);
      if (hit) {
        // LRU touch: re-insert at the back so it counts as most-recently used.
        previewCacheRef.current.delete(key);
        previewCacheRef.current.set(key, hit);
        setPreview({
          path,
          name,
          loading: false,
          placeholder: thumbnailsRef.current[path],
          siblings,
          optimized: hit.optimized,
          ...previewFieldsFromBytes(name, hit.bytes, hit.mime),
        });
        prefetchNeighbors(path, siblings);
        return;
      }
      // If a prefetch for this file is already in flight, promote it rather than
      // starting a second read: show the spinner and let the in-flight stream
      // paint it once `previewPathRef` matches (below). A duplicate `sftp-read`
      // would clobber the bridge's per-path stream and the chunk buffer.
      const prefetching = prefetchPathsRef.current.delete(path);
      const kind = previewRenderKind(name);
      setPreview({
        path,
        name,
        kind,
        src: "",
        loading: true,
        placeholder: thumbnailsRef.current[path],
        siblings,
      });
      if (!prefetching && !previewBuffersRef.current[path]) {
        // Text previews read only the head of a large file (and so can peek past
        // the whole-file download cap); media reads the whole file for the blob.
        const maxBytes =
          kind === "text" || kind === "markdown"
            ? TEXT_PREVIEW_MAX_BYTES
            : undefined;
        // Ask the bridge to downscale an image to a light WebP for fast viewing
        // (the original is still fetched whole by Download).
        send({
          t: "sftp-read",
          path,
          preview: true,
          maxBytes,
          previewResize: kind === "image",
        });
      }
    },
    [send, previewCacheKeyFor, prefetchNeighbors],
  );

  // Fetch the full-resolution original of an open, optimized (WebP) image preview
  // — triggered by zooming in or the "load original" button — and swap it into
  // the modal so zoomed detail is pixel-perfect. The light WebP stays cached, so
  // stepping away and back still paints instantly. Guards against a duplicate
  // in-flight request for the same file.
  const loadPreviewOriginal = useCallback(
    (path: string) => {
      if (originalLoadPathsRef.current.has(path)) return;
      originalLoadPathsRef.current.add(path);
      setPreview((prev) =>
        prev && prev.path === path ? { ...prev, loadingOriginal: true } : prev,
      );
      // Full read (no previewResize): the original streams in and replaces the
      // WebP in the modal (see the `sftp-download-end` handler).
      send({ t: "sftp-read", path, preview: true });
    },
    [send],
  );

  const decideHostKey = useCallback(
    (accept: boolean) => {
      if (accept && authPrompt?.kind === "hostkey") {
        saveKnownHost(
          hostKeyId(authPrompt.host, authPrompt.port),
          authPrompt.fingerprint,
        );
      }
      setAuthPrompt(null);
      send({ t: "hostkey-response", accept });
    },
    [authPrompt, send],
  );

  const submitKbd = useCallback(
    (responses: string[]) => {
      setAuthPrompt(null);
      send({ t: "kbd-response", responses });
    },
    [send],
  );

  // Tear down on unmount (session closed): stop reconnecting, drop the socket.
  useEffect(
    () => () => {
      userClosedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    },
    [],
  );

  const connected = status === "connected";

  // Mirror `connected` into a ref the ws message handler can read synchronously.
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Keep previewPathRef in sync so a late preview reply knows what's open.
  useEffect(() => {
    previewPathRef.current = preview?.path ?? null;
  }, [preview?.path]);

  // Keep the full-state mirror in sync for stepPreview (gallery ←/→).
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  // Step the preview modal to the previous/next previewable file in the same
  // view (wraps around). Cancels the current in-flight stream first so leaving a
  // half-loaded file doesn't keep pulling bytes.
  const stepPreview = useCallback(
    (delta: number) => {
      const cur = previewRef.current;
      if (!cur || !cur.siblings || cur.siblings.length < 2) return;
      const idx = cur.siblings.findIndex((s) => s.path === cur.path);
      if (idx < 0) return;
      const n = cur.siblings.length;
      const target = cur.siblings[(idx + delta + n) % n];
      if (!target || target.path === cur.path) return;
      if (cur.loading) {
        send({ t: "sftp-download-cancel", path: cur.path });
        delete previewBuffersRef.current[cur.path];
      }
      openPreviewFile(target.path, target.name, cur.siblings);
    },
    [send, openPreviewFile],
  );

  // Revoke a preview's blob URL once it's replaced or the modal closes, so
  // decoded media doesn't leak for the life of the session.
  useEffect(() => {
    const url = preview?.src;
    if (url && url.startsWith("blob:")) return () => URL.revokeObjectURL(url);
  }, [preview?.src]);

  // Keep the refs the (bound-once) ws handler reads current.
  useEffect(() => {
    scopeRef.current = target ? `${target.user}@${target.host}` : "";
  }, [target]);
  useEffect(() => {
    elevatedRef.current = elevated;
  }, [elevated]);

  // On each listing, rebuild the path→version map (for cache keys) and preload
  // any persisted thumbnails so a revisited folder paints instantly with no
  // bridge round-trips. Elevated (root) sessions are never persisted, so they
  // skip the cache entirely and just re-fetch (in-memory only) as before.
  useEffect(() => {
    const base = cwd.replace(/\/$/, "");
    const versions = new Map<string, string>();
    for (const e of entries) versions.set(`${base}/${e.name}`, fileVersionTag(e));
    entryVersionRef.current = versions;

    const scope = target ? `${target.user}@${target.host}` : "";
    if (elevated || !scope) return;
    const wanted = entries
      .filter((e) => isThumbnailable(e))
      .map((e) => {
        const path = `${base}/${e.name}`;
        return { path, key: thumbnailCacheKey(scope, path, fileVersionTag(e)) };
      })
      .filter((w) => !requestedThumbsRef.current.has(w.path));
    if (wanted.length === 0) return;

    let cancelled = false;
    void getCachedThumbnails(wanted.map((w) => w.key)).then((hits) => {
      if (cancelled || hits.size === 0) return;
      const found: Record<string, string> = {};
      for (const w of wanted) {
        const url = hits.get(w.key);
        if (url) {
          found[w.path] = url;
          requestedThumbsRef.current.add(w.path); // don't re-fetch from the bridge
        }
      }
      if (Object.keys(found).length > 0) {
        setThumbnails((prev) => ({ ...prev, ...found }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [entries, cwd, elevated, target]);

  // Report label + status to the tab manager whenever they change.
  useEffect(() => {
    onMeta({
      label: target ? `${target.user}@${target.host}` : "New session",
      status,
    });
  }, [target, status, onMeta]);

  // Refit the terminal when this session becomes active or its tab shows it
  // (a hidden xterm measures 0, so it needs a refit + resize on reveal).
  useEffect(() => {
    if (active && tab === "terminal" && connected) {
      const size = xtermRef.current?.fit();
      if (size) send({ t: "resize", cols: size.cols, rows: size.rows });
    }
  }, [active, tab, connected, send]);

  // Sample round-trip latency while connected (one probe now, then every 5s).
  // The chip is hidden whenever not connected, and disconnect()/reconnect reset
  // the value, so there's no stale read-out to clear here.
  useEffect(() => {
    if (!connected) return;
    send({ t: "ping", ts: Date.now() });
    const id = window.setInterval(
      () => send({ t: "ping", ts: Date.now() }),
      5000,
    );
    return () => window.clearInterval(id);
  }, [connected, send]);

  const connecting = status === "connecting" || status === "reconnecting";
  const showOverlay = !connected;
  const canReconnect = (status === "dropped" || status === "error") && hasLast;

  // --- On-screen modifier keys (mobile key bar) ---
  const disarmMods = () => {
    if (ctrlRef.current) {
      ctrlRef.current = false;
      setCtrlArmed(false);
    }
    if (altRef.current) {
      altRef.current = false;
      setAltArmed(false);
    }
  };
  // Terminal input (phone keyboard or a char key): apply armed modifiers, then
  // disarm them (one-shot). A multi-line paste is held back for confirmation
  // first (each newline would run as its own command).
  const sendInput = (data: string) => {
    if (!connected) return;
    if (data.length > 1 && data.includes("\n")) {
      setPastePending(data);
      return;
    }
    const out = applyKeyModifiers(data, {
      ctrl: ctrlRef.current,
      alt: altRef.current,
    });
    disarmMods();
    send({ t: "data", data: out });
  };
  // A fixed escape sequence (arrows / Esc / Fn / undo-redo): send raw, clear mods.
  const sendSeq = (seq: string) => {
    if (!connected) return;
    disarmMods();
    send({ t: "data", data: seq });
  };
  const toggleCtrl = () => {
    const v = !ctrlRef.current;
    ctrlRef.current = v;
    setCtrlArmed(v);
  };
  const toggleAlt = () => {
    const v = !altRef.current;
    altRef.current = v;
    setAltArmed(v);
  };
  const doCopy = async () => {
    const sel = xtermRef.current?.getSelection() ?? "";
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel);
    } catch {
      notify("error", "Clipboard unavailable (needs HTTPS or localhost).");
    }
  };
  const doPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      notify("error", "Clipboard unavailable (needs HTTPS or localhost).");
    }
  };

  // Inject a saved snippet's command into the shell (no trailing newline — the
  // user reviews and presses Enter, matching the paste-confirm posture).
  const runSnippet = (command: string) => {
    if (!connected) return;
    disarmMods();
    send({ t: "data", data: command });
    xtermRef.current?.focus();
  };

  // --- File browser actions (in-app dialogs, not window.prompt/confirm) ---
  const onDelete = (entry: FileEntry) => {
    setDialog({
      title: `Delete “${entry.name}”?`,
      message:
        entry.type === "dir"
          ? "The directory must be empty. This cannot be undone."
          : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () =>
        send({
          t: "sftp-rm",
          path: joinPath(cwd, entry.name),
          dir: entry.type === "dir",
        }),
    });
  };
  // Bulk delete: one confirm for the whole selection, then a `sftp-rm` per
  // entry (same per-item semantics as a single delete — directories must be
  // empty). Each ok refreshes the listing, which prunes the selection.
  const onDeleteMany = (items: FileEntry[]) => {
    if (items.length === 0) return;
    const hasDir = items.some((e) => e.type === "dir");
    setDialog({
      title: `Delete ${items.length} item${items.length > 1 ? "s" : ""}?`,
      message: hasDir
        ? "Selected directories must be empty. This cannot be undone."
        : "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        for (const entry of items) {
          send({
            t: "sftp-rm",
            path: joinPath(cwd, entry.name),
            dir: entry.type === "dir",
          });
        }
      },
    });
  };
  const clearUploadRow = useCallback((path: string) => {
    setUploads((u) => {
      const rest = { ...u };
      delete rest[path];
      return rest;
    });
  }, []);

  // Stream a chunked upload from `startOffset` to the end, one sftp-write per
  // chunk, throttled by the socket's buffered amount so a big file doesn't flood
  // the connection. `startOffset > 0` is a resume: the opening chunk carries
  // `resume: true` so the bridge reopens the partial in append-at-offset mode
  // instead of truncating. The loop stops early (marking the upload
  // "interrupted") if the socket drops, so a resume can pick up from there; it
  // bails silently if the upload was cancelled meanwhile. Called only through
  // `pumpUploads`, which reserves the concurrency slot this loop releases when it
  // finishes streaming (whether it completes, interrupts, cancels, or errors).
  const runUpload = useCallback(
    async (path: string, startOffset: number) => {
      let released = false;
      const releaseSlot = () => {
        if (released) return;
        released = true;
        uploadInFlightRef.current = Math.max(0, uploadInFlightRef.current - 1);
        pumpUploadsRef.current();
      };
      const ctl = uploadCtlRef.current[path];
      if (!ctl) {
        releaseSlot();
        return;
      }
      ctl.running = true;
      ctl.queued = false;
      ctl.interrupted = false;
      const { rel, needsDir, total } = ctl;
      const report = (sent: number) => {
        ctl.sent = sent;
        setUploads((u) => ({
          ...u,
          [path]: { path, name: rel, sent, total, status: "uploading" },
        }));
      };
      const markInterrupted = () => {
        ctl.running = false;
        ctl.interrupted = true;
        setUploads((u) =>
          u[path]
            ? { ...u, [path]: { ...u[path], status: "interrupted" } }
            : u,
        );
        releaseSlot();
      };
      report(startOffset);
      try {
        const buf = new Uint8Array(await ctl.file.arrayBuffer());
        let offset = startOffset;
        let firstChunk = true;
        // Empty file (or already fully uploaded on resume): still send a final
        // opening chunk so the bridge closes the stream and acks with sftp-ok.
        do {
          if (ctl.cancelled) {
            ctl.running = false;
            releaseSlot();
            return;
          }
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return markInterrupted();
          const end = Math.min(offset + UPLOAD_CHUNK, total);
          const opening = firstChunk && offset === startOffset;
          send({
            t: "sftp-write",
            path,
            dataB64: bytesToBase64(buf.subarray(offset, end)),
            offset,
            final: end >= total,
            // Only the opening chunk carries mkdirp (the bridge opens the write
            // stream then) and, on a resume, the resume flag.
            mkdirp: opening && offset === 0 && needsDir ? true : undefined,
            resume: opening && startOffset > 0 ? true : undefined,
          });
          firstChunk = false;
          offset = end;
          report(offset);
          while (
            wsRef.current &&
            wsRef.current.readyState === WebSocket.OPEN &&
            wsRef.current.bufferedAmount > 4 * 1024 * 1024
          ) {
            await sleep(25);
          }
        } while (offset < total);
        // All bytes streamed; the row clears when the bridge acks with sftp-ok.
        // Release the slot now so the next queued upload can start streaming
        // while this one waits for its acknowledgement.
        ctl.running = false;
        releaseSlot();
      } catch {
        // Reading the local file failed — drop the stuck progress row and tell
        // the user (a server-side reject arrives separately as an sftp error).
        ctl.running = false;
        delete uploadCtlRef.current[path];
        clearUploadRow(path);
        notify("error", `Upload failed: ${rel}`);
        releaseSlot();
      }
    },
    [send, notify, clearUploadRow],
  );

  // Start as many queued uploads as the concurrency limit allows, then stop;
  // each `runUpload` releases its slot and calls this again as it finishes, so
  // the queue keeps draining until empty. A cancelled or already-running job is
  // skipped without consuming a slot.
  const pumpUploads = useCallback(() => {
    while (
      uploadInFlightRef.current < MAX_INFLIGHT_UPLOADS &&
      uploadQueueRef.current.length > 0
    ) {
      const job = uploadQueueRef.current.shift()!;
      const ctl = uploadCtlRef.current[job.path];
      if (!ctl || ctl.cancelled || ctl.running) continue;
      uploadInFlightRef.current += 1;
      void runUpload(job.path, job.startOffset);
    }
  }, [runUpload]);

  // Begin a fresh chunked upload. A `relPath` (folder upload) preserves
  // subdirectories; the opening chunk asks the bridge to `mkdir -p` the parents.
  // The upload is queued (shown immediately as "queued") and starts once a
  // concurrency slot is free.
  const uploadFile = useCallback(
    (file: File, dir: string, relPath?: string) => {
      const rel = relPath && relPath.trim() !== "" ? relPath : file.name;
      const path = joinPath(dir, rel);
      uploadCtlRef.current[path] = {
        file,
        rel,
        needsDir: rel.includes("/"),
        total: file.size,
        sent: 0,
        cancelled: false,
        running: false,
        interrupted: false,
        queued: true,
      };
      setUploads((u) => ({
        ...u,
        [path]: { path, name: rel, sent: 0, total: file.size, status: "queued" },
      }));
      uploadQueueRef.current.push({ path, startOffset: 0 });
      pumpUploads();
    },
    [pumpUploads],
  );

  // Cancel an in-flight, queued, or interrupted upload: stop the local loop,
  // drop it from the queue, tell the bridge to tear down the stream and remove
  // the partial, and drop the row.
  const cancelUpload = useCallback(
    (path: string) => {
      const ctl = uploadCtlRef.current[path];
      if (ctl) ctl.cancelled = true;
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (job) => job.path !== path,
      );
      delete uploadCtlRef.current[path];
      send({ t: "sftp-upload-cancel", path });
      clearUploadRow(path);
    },
    [send, clearUploadRow],
  );

  // Cancel every active/queued/interrupted upload at once (the aggregate
  // progress bar's "Cancel all").
  const cancelAllUploads = useCallback(() => {
    for (const path of Object.keys(uploadCtlRef.current)) cancelUpload(path);
  }, [cancelUpload]);

  // Resume an interrupted upload: ask the bridge how much of the partial it
  // already has; the `sftp-write-at` reply drives the actual continue.
  const resumeUpload = useCallback(
    (path: string) => {
      const ctl = uploadCtlRef.current[path];
      if (!ctl || ctl.running || ctl.cancelled) return;
      send({ t: "sftp-write-resume", path });
    },
    [send],
  );

  // Cancel an in-flight download: tell the bridge to stop streaming and discard
  // whatever we've buffered so far.
  const cancelDownload = useCallback(
    (path: string) => {
      send({ t: "sftp-download-cancel", path });
      delete downloadBuffersRef.current[path];
      setDownloads((d) => {
        const rest = { ...d };
        delete rest[path];
        return rest;
      });
    },
    [send],
  );
  // Keep the ref the ws message handler reads pointed at the latest pumpUploads,
  // so the `sftp-write-at` resume reply can kick the queue despite being bound
  // earlier.
  useEffect(() => {
    pumpUploadsRef.current = pumpUploads;
  }, [pumpUploads]);
  const onMkdir = () => {
    setDialog({
      title: "New directory",
      input: { label: "Directory name", placeholder: "e.g. logs" },
      confirmLabel: "Create",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) => send({ t: "sftp-mkdir", path: joinPath(cwd, v.trim()) }),
    });
  };
  const onTouch = () => {
    setDialog({
      title: "New file",
      input: { label: "File name", placeholder: "e.g. notes.txt" },
      confirmLabel: "Create",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) =>
        send({ t: "sftp-write", path: joinPath(cwd, v.trim()), dataB64: "" }),
    });
  };
  const onRename = (entry: FileEntry) => {
    setDialog({
      title: `Rename “${entry.name}”`,
      input: { label: "New name", initialValue: entry.name },
      confirmLabel: "Rename",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) => {
        const next = v.trim();
        if (next && next !== entry.name) {
          send({
            t: "sftp-rename",
            from: joinPath(cwd, entry.name),
            to: joinPath(cwd, next),
          });
        }
      },
    });
  };
  // Duplicate a file/directory in place: pre-fill a non-colliding "… copy" name
  // and copy on confirm. The server streams the copy (original only read).
  const onCopy = (entry: FileEntry) => {
    const suggested = suggestCopyName(
      entry.name,
      entries.map((e) => e.name),
    );
    setDialog({
      title: `Duplicate “${entry.name}”`,
      input: { label: "New name", initialValue: suggested },
      confirmLabel: "Duplicate",
      validate: (v) => (v.trim() ? null : "Please enter a name."),
      onConfirm: (v) => {
        const next = v.trim();
        if (next && next !== entry.name) {
          send({
            t: "sftp-copy",
            from: joinPath(cwd, entry.name),
            to: joinPath(cwd, next),
          });
        }
      },
    });
  };
  // Move (drag-drop onto a folder): rename the item under the target directory.
  // Guards against no-op and moving a directory into itself or its own subtree.
  const onMove = (fromPath: string, toDir: string) => {
    const name = fromPath.split("/").pop() || "";
    if (!name) return;
    if (toDir === parentPath(fromPath)) return; // already there
    if (toDir === fromPath || toDir.startsWith(`${fromPath}/`)) return; // into self
    const to = joinPath(toDir, name);
    if (to !== fromPath) send({ t: "sftp-rename", from: fromPath, to });
  };
  const onChmod = (entry: FileEntry) => {
    setDialog({
      title: `Permissions for “${entry.name}”`,
      input: { label: "Octal mode (e.g. 644)", initialValue: modeToOctal(entry.mode) },
      confirmLabel: "Apply",
      validate: (v) =>
        parseOctalMode(v) === null ? "Use 3–4 octal digits like 644." : null,
      onConfirm: (v) => {
        const mode = parseOctalMode(v);
        if (mode !== null) {
          send({ t: "sftp-chmod", path: joinPath(cwd, entry.name), mode });
        }
      },
    });
  };
  // Toggle elevated (sudo) file access. Turning it on prompts for an optional
  // sudo password (blank = passwordless / NOPASSWD); turning it off is immediate.
  const toggleElevated = () => {
    if (elevatedPending) return;
    if (elevated) {
      setElevatedPending(true);
      send({ t: "sftp-sudo", enable: false });
      return;
    }
    setDialog({
      title: "Elevated file access",
      message:
        "Run file operations as root via sudo. Enter the sudo password, or leave blank if passwordless sudo is configured.",
      input: { label: "sudo password", placeholder: "(blank for NOPASSWD)", password: true },
      confirmLabel: "Enable",
      onConfirm: (password) => {
        setElevatedPending(true);
        send({ t: "sftp-sudo", enable: true, password: password || undefined });
      },
    });
  };
  // Recursive subtree search: send the query for the current directory and show
  // a loading state until the bridge replies. `mode` selects the axis — file
  // names (`sftp-find`, listings/metadata only) or file contents (`sftp-grep`,
  // which opens each file, size-capped). Trimmed to match the server (which
  // trims too), so `prev.query === msg.query` reconciles.
  const onSearch = (query: string, mode: SearchMode) => {
    const q = query.trim();
    if (!q) {
      setSearch(null);
      return;
    }
    setSearch({ query: q, mode, loading: true, results: [], truncated: false });
    send({ t: mode === "content" ? "sftp-grep" : "sftp-find", path: cwd, query: q });
  };
  const onClearSearch = () => setSearch(null);

  // Open a file in the inline editor. A very large file in a textarea with live
  // highlighting can be sluggish, so warn (and let the user back out) before
  // requesting one past the editor size threshold; already-open files reopen
  // without a prompt (the read reply just refocuses the existing tab).
  const requestEdit = (path: string, name: string, size: number) => {
    const openEditor = () => send({ t: "sftp-read", path, edit: true });
    const alreadyOpen = editors.some((e) => e.path === path);
    if (!alreadyOpen && isLargeForEditor(size)) {
      setDialog({
        title: "Open a large file?",
        message: `“${name}” is ${formatSize(size, "file")}. Editing a file this large in the browser can be slow. Open it anyway?`,
        confirmLabel: "Open",
        onConfirm: openEditor,
      });
      return;
    }
    openEditor();
  };
  const onSaveEdit = (path: string, text: string) => {
    editorSaveTextRef.current[path] = text;
    setSavingPath(path);
    send({
      t: "sftp-write",
      path,
      dataB64: bytesToBase64(new TextEncoder().encode(text)),
    });
  };
  // Close one editor tab; if it was active, fall back to the last remaining file.
  const closeEditorFile = (path: string) => {
    const remaining = editors.filter((e) => e.path !== path);
    setEditors(remaining);
    setActiveEditor((cur) =>
      cur !== path ? cur : remaining.length ? remaining[remaining.length - 1].path : null,
    );
  };
  const closeAllEditors = () => {
    setEditors([]);
    setActiveEditor(null);
  };

  // --- Port-forward actions ---
  const openForward = (nf: NewForward) => {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `fwd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Optimistic "opening" entry so the tunnel shows immediately; forward-opened
    // / forward-error will resolve its status.
    setForwards((f) => ({
      ...f,
      [id]: { id, ...nf, status: "opening", conns: 0 },
    }));
    send({ t: "forward-open", id, ...nf });
  };
  const closeForward = (id: string) => {
    send({ t: "forward-close", id });
    setForwards((f) => {
      const rest = { ...f };
      delete rest[id];
      return rest;
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-term-border bg-term-card">
      {/* Session header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        {/* Identity + live status — takes the remaining width so the host label
            truncates instead of shoving the controls off-screen. */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <StatusDot status={status} />
          <span className="min-w-0 truncate text-xs text-term-dim">
            {target ? `${target.user}@${target.host}` : "Not connected"}
          </span>
          {connected && connectedAt !== null && <Uptime since={connectedAt} />}
          {connected && latency !== null && <LatencyChip ms={latency} />}
        </div>

        {connected && (
          // Controls, grouped so a narrow header wraps them as coherent blocks
          // (utility icons / tab switcher / disconnect) rather than scattering
          // individual buttons across lines.
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Utility actions */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowShortcuts(true)}
                className="rounded px-2 py-1 text-xs text-term-muted transition-colors hover:text-term-text"
                title="Keyboard shortcuts"
                aria-label="Keyboard shortcuts"
              >
                ?
              </button>
              {tab === "terminal" && (
                <button
                  type="button"
                  onClick={() => {
                    setTab("terminal");
                    xtermRef.current?.openSearch();
                  }}
                  className="rounded px-2 py-1 text-xs text-term-muted transition-colors hover:text-term-text"
                  title="Search terminal (Ctrl+F)"
                  aria-label="Search terminal"
                >
                  🔍
                </button>
              )}
              <TerminalSettings
                prefs={termPrefs}
                onChange={updateTermPrefs}
                onClearThumbnailCache={clearThumbnails}
                thumbnailCacheElevated={elevated}
              />
            </div>

            {/* Tab switcher — one segmented control so the three tabs read as a
                single unit and stay together when the header wraps. */}
            <div className="inline-flex overflow-hidden rounded-md border border-term-border">
              {(["terminal", "files", "tunnels"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "border-l border-term-border px-3 py-1 text-xs capitalize transition-colors first:border-l-0",
                    tab === t
                      ? "bg-term-accent/15 text-term-accent"
                      : "text-term-muted hover:bg-term-card hover:text-term-text",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={disconnect}
              className="rounded-md border border-term-red/40 px-3 py-1 text-xs text-term-red hover:bg-term-red/10"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0 flex-col bg-term-bg",
            connected && tab !== "terminal" ? "hidden" : "flex",
          )}
        >
          <div className="min-h-0 flex-1 p-2">
            <XtermView
              ref={xtermRef}
              onData={sendInput}
              onResize={(cols, rows) =>
                connected && send({ t: "resize", cols, rows })
              }
              theme={getThemePreset(termPrefs.themeId).theme}
            />
          </div>
          {connected && <SnippetsBar onRun={runSnippet} />}
          {connected && (
            <MobileKeys
              ctrlActive={ctrlArmed}
              altActive={altArmed}
              onToggleCtrl={toggleCtrl}
              onToggleAlt={toggleAlt}
              onChar={sendInput}
              onSeq={sendSeq}
              onCopy={doCopy}
              onPaste={doPaste}
            />
          )}
        </div>

        {connected && tab === "files" && (
          <div className="absolute inset-0">
            <FileBrowser
              cwd={cwd}
              entries={entries}
              loading={filesLoading}
              uploads={Object.values(uploads)}
              downloads={Object.values(downloads)}
              onCancelUpload={cancelUpload}
              onCancelAllUploads={cancelAllUploads}
              onResumeUpload={resumeUpload}
              onCancelDownload={cancelDownload}
              canElevate={canElevate}
              elevated={elevated}
              elevatedPending={elevatedPending}
              onToggleElevated={toggleElevated}
              onNavigate={listDir}
              onRefresh={() => listDir(cwd)}
              onDownload={(path) => send({ t: "sftp-read", path })}
              onDownloadDir={(path) => send({ t: "sftp-download-dir", path })}
              onDownloadMany={(paths) => send({ t: "sftp-download-many", paths })}
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              onUpload={(file, relPath) => uploadFile(file, cwd, relPath)}
              onMkdir={onMkdir}
              onTouch={onTouch}
              onRename={onRename}
              onCopy={onCopy}
              onMove={onMove}
              onChmod={onChmod}
              onEdit={requestEdit}
              onPreview={openPreviewFile}
              onOpenUnsupported={(path, name) =>
                setPreview({
                  path,
                  name,
                  kind: "unsupported",
                  src: "",
                  loading: false,
                })
              }
              thumbnails={thumbnails}
              onRequestThumbnail={requestThumbnail}
              search={search}
              onSearch={onSearch}
              onClearSearch={onClearSearch}
            />
            {preview && (
              <FilePreview
                key={preview.path}
                name={preview.name}
                path={preview.path}
                src={preview.src}
                kind={preview.kind}
                loading={preview.loading}
                placeholder={preview.placeholder}
                text={preview.text}
                received={preview.received}
                total={preview.total}
                truncated={preview.truncated}
                encodingWarning={preview.encodingWarning}
                optimized={preview.optimized}
                loadingOriginal={preview.loadingOriginal}
                onLoadOriginal={() => loadPreviewOriginal(preview.path)}
                getStartTime={() => videoTimesRef.current.get(preview.path) ?? 0}
                onTime={(t) => videoTimesRef.current.set(preview.path, t)}
                hasGallery={(preview.siblings?.length ?? 0) > 1}
                index={preview.siblings?.findIndex((s) => s.path === preview.path)}
                count={preview.siblings?.length}
                filmstrip={preview.siblings?.map((s) => ({
                  path: s.path,
                  name: s.name,
                  thumb: thumbnails[s.path],
                }))}
                onJump={(path) => {
                  const target = preview.siblings?.find((s) => s.path === path);
                  if (target && target.path !== preview.path) {
                    if (preview.loading) {
                      send({ t: "sftp-download-cancel", path: preview.path });
                      delete previewBuffersRef.current[preview.path];
                    }
                    openPreviewFile(target.path, target.name, preview.siblings);
                  }
                }}
                onPrev={() => stepPreview(-1)}
                onNext={() => stepPreview(1)}
                onDownload={() =>
                  // Reuse the held bytes only when they're the *original*; an
                  // optimized (downscaled WebP) preview — or a stream-only
                  // video/audio, or the download-only fallback — fetches the
                  // untouched original on demand (streamed, with a progress bar).
                  preview.bytes && !preview.optimized
                    ? triggerDownload(preview.name, preview.bytes)
                    : send({ t: "sftp-read", path: preview.path })
                }
                onCancel={() => {
                  // Abort the in-flight preview stream and close the modal.
                  send({ t: "sftp-download-cancel", path: preview.path });
                  delete previewBuffersRef.current[preview.path];
                  setPreview(null);
                }}
                onClose={() => {
                  // Closing mid-transfer stops the stream so we don't keep
                  // pulling a large file the user no longer wants.
                  if (preview.loading) {
                    send({ t: "sftp-download-cancel", path: preview.path });
                    delete previewBuffersRef.current[preview.path];
                  }
                  setPreview(null);
                }}
              />
            )}
          </div>
        )}

        {connected && tab === "tunnels" && (
          <div className="absolute inset-0 bg-term-bg">
            <Tunnels
              forwards={Object.values(forwards)}
              onOpen={openForward}
              onClose={closeForward}
            />
          </div>
        )}

        {/* Inline editor overlays every tab so switching tabs keeps unsaved
            buffers alive; it's only populated while connected. */}
        {activeEditor && editors.length > 0 && (
          <FileEditor
            files={editors}
            activePath={activeEditor}
            savingPath={savingPath}
            onSave={onSaveEdit}
            onSelect={setActiveEditor}
            onCloseFile={closeEditorFile}
            onCloseAll={closeAllEditors}
          />
        )}

        {showOverlay && (
          <div className="absolute inset-0 overflow-auto bg-term-card p-5 sm:p-8">
            <div className="mx-auto max-w-md">
              {canReconnect ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-term-text">
                      {status === "dropped"
                        ? "Connection lost"
                        : "Connection failed"}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-term-muted">
                      {statusMessage ||
                        "The session ended. Reconnect to the same host, or start a new connection."}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={reconnectNow}
                      className="rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-2 text-sm font-medium text-term-accent hover:bg-term-accent/25"
                    >
                      Reconnect →
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        lastDetailsRef.current = null;
                        setHasLast(false);
                        setStatus("idle");
                        setStatusMessage("");
                      }}
                      className="rounded-md border border-term-border px-4 py-2 text-sm text-term-muted hover:text-term-text"
                    >
                      New connection
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="term-fade-up mb-5 flex items-center gap-3 rounded-lg border border-term-border bg-term-panel/60 px-4 py-3">
                    <span
                      className="select-none font-mono text-2xl text-term-accent"
                      aria-hidden
                    >
                      &gt;<span className="term-cursor ml-0.5 align-middle" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-term-text">
                        {SITE_NAME}
                      </p>
                      <p className="truncate text-xs text-term-muted">
                        SSH &amp; SFTP, right in your browser
                      </p>
                    </div>
                  </div>
                  <h2 className="text-lg font-semibold text-term-text">
                    New SSH connection
                  </h2>
                  <p className="mt-1 mb-5 text-xs leading-relaxed text-term-muted">
                    Credentials are relayed straight to the target host to open
                    the session and are never stored or logged by this site. Only
                    connect to hosts you trust.
                  </p>
                  <ConnectForm onConnect={connect} connecting={connecting} />
                  {statusMessage && (
                    <p className="mt-4 rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
                      {statusMessage}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {pastePending !== null && (
          <PasteConfirm
            text={pastePending}
            onConfirm={() => {
              const data = pastePending;
              setPastePending(null);
              disarmMods();
              if (connected) send({ t: "data", data });
              xtermRef.current?.focus();
            }}
            onCancel={() => {
              setPastePending(null);
              xtermRef.current?.focus();
            }}
          />
        )}

        {dialog && (
          <PromptDialog request={dialog} onClose={() => setDialog(null)} />
        )}

        {showShortcuts && (
          <ShortcutsHelp onClose={() => setShowShortcuts(false)} />
        )}

        {authPrompt && (
          <AuthPromptModal
            prompt={authPrompt}
            onHostKeyDecision={decideHostKey}
            onKbdSubmit={submitKbd}
          />
        )}

        {/* Transient notifications — sit above every tab and modal so a failed
            action is always visible, even with the editor or a dialog open. */}
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    </div>
  );
}
