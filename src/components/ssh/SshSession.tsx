"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyKeyModifiers,
  compareHostKey,
  encodeMessage,
  formatSize,
  formatDiskUsage,
  DIFF_MAX_BYTES,
  hostKeyId,
  isBrowserRenderableImage,
  isLargeForEditor,
  isProbablyTextFile,
  joinPath,
  type FileEntry,
  type ServerMessage,
} from "@/lib/sshProtocol";
import { cdCommand } from "@/lib/shellQuote";
import { fileVersionTag } from "@/lib/thumbnailCache";
import {
  KNOWN_HOSTS_KEY,
  parseKnownHosts,
  serializeKnownHosts,
  type KnownHostMap,
} from "@/lib/knownHosts";
import { resumeUploadStart } from "@/lib/serverSecurity";
import { SITE_NAME } from "@/config/siteConfig";
import { base64ToBytes, bytesToBase64 } from "@/lib/bytes";
import { bytesToBase64Async } from "@/lib/base64Codec";
import { cn } from "@/lib/utils";
import { triggerDownload } from "./dom/download";
import {
  StatusDot,
  Uptime,
  LatencyChip,
  type SessionStatus,
} from "./SessionStatus";
import { XtermView, type XtermHandle } from "./XtermView";
import {
  ConnectForm,
  type ConnectDetails,
  type ConnectFormInitial,
} from "./ConnectForm";
import {
  FileBrowser,
  type UploadItem,
  type SearchState,
  type SearchMode,
} from "./FileBrowser";
import { FileEditor } from "./FileEditor";
import type { PreviewState } from "./preview/previewState";
import { FilePreview } from "./FilePreview";
import { PasteConfirm } from "./PasteConfirm";
import { PromptDialog, type DialogRequest } from "./PromptDialog";
import { MobileKeys } from "./MobileKeys";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { TerminalSettings } from "./TerminalSettings";
import { SearchIcon } from "./icons";
import { useThumbnailQueue } from "./hooks/useThumbnailQueue";
import { useUploadQueue, type UploadJob } from "./hooks/useUploadQueue";
import { useDownloadTransfers } from "./hooks/useDownloadTransfers";
import { useReconnect } from "./hooks/useReconnect";
import { useSshSocket } from "./hooks/useSshSocket";
import { useFileActions } from "./hooks/useFileActions";
import { usePreviewCache } from "./hooks/usePreviewCache";
import { usePreviewGallery } from "./hooks/usePreviewGallery";
import { useEditors } from "./hooks/useEditors";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { DiffView, type DiffSide } from "./DiffView";
import { AuthPromptModal, type AuthPromptState } from "./AuthPrompt";
import { ToastStack, useToasts } from "./Toast";

/** Upload chunk size; each chunk is one `sftp-write` message (drives progress). */
const UPLOAD_CHUNK = 256 * 1024;
/** How many uploads stream at once. The rest queue and start as slots free up,
 * so dropping a folder of hundreds of files reads only a few into memory at a
 * time (each active upload holds its whole file) instead of all at once. */
const MAX_INFLIGHT_UPLOADS = 3;
/** How many plain file downloads stream at once (#74); the rest queue and start
 * as slots free up, so firing many downloads can't open unbounded streams or hit
 * the bridge's per-session transfer cap. */
const MAX_INFLIGHT_DOWNLOADS = 3;
// Cap the retained tail -f text so a long-running follow can't grow browser
// memory / re-highlight cost without bound — keep only the trailing window (#47).
const FOLLOW_MAX_TEXT = 512 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A file open in the preview modal (media viewed inline, or a download-only
 * fallback for types the browser can't render). */
/** Max concurrent grid-thumbnail reads. Enough to fill a visible screen of tiles
 * quickly without swamping the single bridge WebSocket when a folder holds
 * hundreds of images; the rest queue and drain as replies arrive. The bridge
 * serves cache hits without an SSH read or transcode, so a higher ceiling
 * mainly speeds the first paint of a fresh folder. */
const MAX_INFLIGHT_THUMBS = 12;

/** What a session reports up to the tab manager for its tab chip. */
export interface SessionMeta {
  label: string;
  status: SessionStatus;
  /** Whether the tab has work that closing would interrupt — open editor tabs or
   * in-flight transfers — so the tab manager can confirm before closing (#85). */
  busy: boolean;
}

// `SessionStatus` and the header status widgets (StatusDot/Uptime/LatencyChip)
// live in ./SessionStatus and are re-exported here so existing importers (the
// tab manager) keep resolving them from this module.
export type { SessionStatus };
export { StatusDot };

type Tab = "terminal" | "files";

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
/** A live connection in another tab, offered as a one-click "same server" login. */
export interface ReusableConnection {
  /** `user@host` (with `:port` when non-default) for the button label. */
  label: string;
  /** The in-memory details to reconnect with — no re-typing. */
  details: ConnectDetails;
}

export function SshSession({
  active,
  onMeta,
  reusableConnections,
  onConnectionChange,
  initialConnect,
}: {
  active: boolean;
  onMeta: (meta: SessionMeta) => void;
  /** Other tabs' live connections, shown as quick-connect options on the form. */
  reusableConnections?: ReusableConnection[];
  /** Report this tab's connected details (or null when not connected) upward. */
  onConnectionChange?: (details: ConnectDetails | null) => void;
  /** Pre-fill the connect form on mount (never a password) — used by the tab
   * manager's "Duplicate tab" so a new tab opens ready to reconnect (#83). */
  initialConnect?: ConnectFormInitial;
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
  // Mirror of the current listing so callbacks (e.g. subtitle-sidecar lookup on
  // preview open) can read it without re-binding on every listing change.
  const entriesRef = useRef<FileEntry[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
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
  // Files open in the inline editor (tabs), which one is shown, and which (if
  // any) is being saved right now — all owned by the useEditors hook.
  const editorsApi = useEditors();
  const { editors, activeEditor, savingPath } = editorsApi;
  // Opt-in desktop notifications (#52) — fires on an unexpected disconnect while
  // the tab is backgrounded.
  const desktopNotify = useDesktopNotifications();
  // Two-file diff (#76): the open diff modal, plus a pending collector that
  // gathers both files' contents (fetched via the editor read path) before
  // opening it.
  const [diff, setDiff] = useState<{ a: DiffSide; b: DiffSide } | null>(null);
  const diffPendingRef = useRef<{
    paths: [string, string];
    got: Record<string, DiffSide>;
  } | null>(null);
  // Path currently being tail-followed in the preview (#47), or null. The ref
  // mirror lets the ws message handler / reconnect re-issue the follow without
  // depending on the state.
  const [followPath, setFollowPath] = useState<string | null>(null);
  const followPathRef = useRef<string | null>(null);
  // Streaming UTF-8 decoder for follow chunks, so a multibyte character split
  // across two ranges isn't corrupted into U+FFFD (Codex #4). Reset on each
  // initial/reset frame.
  const followDecoderRef = useRef<TextDecoder | null>(null);
  // Kept current so the memoized message handler / cleanup callbacks can reach
  // the editor operations without listing the (per-render) api object as a dep —
  // the same ref pattern the rest of this component uses for stable callbacks.
  const editorsApiRef = useRef(editorsApi);
  useEffect(() => {
    editorsApiRef.current = editorsApi;
  }, [editorsApi]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Mirrors the open preview's path so a late `sftp-read` reply can tell whether
  // the user is still viewing that file before it builds a blob URL for it.
  const previewPathRef = useRef<string | null>(null);
  // Mirrors the full open-preview state so `stepPreview` (gallery ←/→) can read
  // the latest siblings/loading without being torn down and rebuilt each render.
  const previewRef = useRef<PreviewState | null>(null);
  // A delete/move issued from inside the preview modal, awaiting its `sftp-ok`.
  // Only once the bridge acks do we prune the file from the open gallery (step
  // to a neighbor / close) — so a failed op (permissions, etc.) never skips a
  // file. `ackPath` matches the op's ack (`sftp-rm` acks the removed path,
  // `sftp-rename` acks the destination); `prunePath` is what leaves the view.
  const pendingPreviewMutationRef = useRef<{
    op: "rm" | "rename";
    ackPath: string;
    prunePath: string;
  } | null>(null);
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
  // The bridge's whole-file download cap (bytes; 0 = unlimited), from `caps`. Used
  // to decide when a small clip is safe to fetch whole (and cache for instant
  // re-open) rather than stream — never fetch whole past this cap.
  const downloadCapRef = useRef<number>(0);
  // Last playback position (seconds) per video path, so stepping the gallery
  // away from a clip and back resumes where you left off. In-memory only,
  // cleared on disconnect.
  const videoTimesRef = useRef<Map<string, number>>(new Map());
  // In-flight sidecar-subtitle reads: subtitle path → { videoPath, name }. When
  // a video opens we look for a matching `.srt`/`.vtt` and read it here; the
  // download handlers convert it to a WebVTT `blob:` and attach it to the video
  // preview (rather than treating it as its own preview). `blob:` URL revoked on
  // preview close.
  const subtitleReadsRef = useRef<
    Map<string, { videoPath: string; name: string }>
  >(new Map());
  const subtitleUrlRef = useRef<string | null>(null);
  // Cached grid-view image thumbnails, keyed by remote path → `data:` URL.
  // Populated lazily as tiles scroll into view; cleared on each directory change
  // (below) to bound memory. `requestedThumbsRef` dedupes in-flight requests so
  // a tile re-rendering never re-fetches.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // Dominant color per thumbnail (`#rrggbb`), painted behind a grid tile as a
  // cheap placeholder while its (lazy-loaded) WebP decodes (#100). Cleared with
  // the thumbnails below.
  const [thumbBg, setThumbBg] = useState<Record<string, string>>({});
  // Mirror of `thumbnails` so callbacks can read the latest placeholder without
  // listing `thumbnails` as a dependency (it changes on every tile load).
  const thumbnailsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    thumbnailsRef.current = thumbnails;
  }, [thumbnails]);
  // The thumbnail request scheduler (dedupe + concurrency + visible-first) lives
  // in a co-located hook, unit-tested in isolation. `requestThumbnail` /
  // `setThumbVisible` are passed to FileBrowser; `onThumbReplied` frees a slot
  // when a `thumb` reply lands; `resetThumbs` drops the queue on dir change /
  // sudo toggle / logout. (The hook is instantiated below, once `send` exists.)
  // path → `size:mtime` version tag for the current listing, for cache keys.
  const entryVersionRef = useRef<Map<string, string>>(new Map());
  // Mirrors, for the (bound-once) ws message handler, whether we're elevated
  // (root): elevated in-memory caches are dropped on `sudo` toggle and logout.
  const elevatedRef = useRef(false);
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({});
  // Accumulated preview chunks (bytes), keyed by remote path. Previews stream in
  // over the same `sftp-download-*` frames (tagged `preview`), but land in the
  // modal (as a blob/text) instead of a saved file — so they buffer here.
  const previewBuffersRef = useRef<Record<string, Uint8Array[]>>({});
  // Server-supplied content type for a streaming preview, captured from its
  // `sftp-download-begin`. Present only when the bridge transcoded an image to a
  // WebP preview — its presence marks the bytes as an *optimized* (non-original)
  // preview so Download re-fetches the original.
  const previewMimeRef = useRef<Record<string, string>>({});
  // Recently-viewed preview byte cache (an in-memory, byte-bounded TTL LRU keyed
  // by path + version). Owns the LRU; the listing's version map keys it. See
  // `usePreviewCache`.
  const {
    get: previewCacheGet,
    has: previewCacheHas,
    store: cachePreview,
    clear: previewCacheClearOnly,
    sizeBytes: previewCacheSizeBytes,
  } = usePreviewCache(entryVersionRef);
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
  // Concurrency-limited upload queue (bounds how many files a big batch reads /
  // streams at once). The scheduler lives in a co-located, unit-tested hook; the
  // starter that actually begins a job (`startUpload`, wrapping `runUpload`) is
  // injected below with `setUploadStart` once it's defined, breaking the ordering
  // cycle the old `pumpUploadsRef` worked around.
  const {
    enqueue: enqueueUpload,
    onReleased: onUploadReleased,
    remove: removeUploads,
    reset: resetUploads,
    setStart: setUploadStart,
  } = useUploadQueue(MAX_INFLIGHT_UPLOADS);

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

  // Sticky on-screen modifiers (mobile key bar). State drives the button
  // highlight; refs let the terminal's own input handler read them synchronously.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  // Whether we hold credentials from a prior connect (drives the Reconnect UI);
  // mirrors lastDetailsRef but is render-safe.
  const [hasLast, setHasLast] = useState(false);
  // Bumped to re-mount (re-seed) the ConnectForm: after a failed login we
  // remount it pre-filled with the last host/port/user (password cleared), and
  // on a fresh "New connection" we remount it empty.
  const [formSeed, setFormSeed] = useState(0);
  // Values to pre-fill the connect form with after a failed login (never the
  // password). Set from the callback that sees the failure, so no ref is read
  // during render.
  const [formInitial, setFormInitial] = useState<
    ConnectFormInitial | undefined
  >(initialConnect);

  // Reconnection bookkeeping (refs so the ws close handler sees fresh values).
  const lastDetailsRef = useRef<ConnectDetails | null>(null);
  const userClosedRef = useRef(false);

  // Desktop-notify on an unexpected disconnect (#52): fire when the status
  // leaves "connected" for a dropped/errored state that the user didn't cause.
  // The hook's gate suppresses it unless the tab is backgrounded and the user
  // opted in with permission granted.
  const { notify: notifyDesktop } = desktopNotify;
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      prev === "connected" &&
      (status === "reconnecting" ||
        status === "dropped" ||
        status === "error") &&
      !userClosedRef.current
    ) {
      const who = target ? `${target.user}@${target.host}` : "SSH session";
      notifyDesktop("SSHWeb — disconnected", `${who} session dropped.`);
    }
  }, [status, target, notifyDesktop]);
  // The attempt counter, in-flight/was-connected flags, and backoff timer live
  // in useReconnect; this hook decides whether/when to retry a dropped socket.
  const reconnect = useReconnect({
    max: MAX_RECONNECT,
    onReconnecting: (attempt, max) => {
      setStatus("reconnecting");
      setStatusMessage(`Reconnecting… (attempt ${attempt}/${max})`);
    },
    onGaveUp: () => {
      setStatus("dropped");
      setStatusMessage("Connection lost.");
    },
  });

  const send = useCallback((msg: Parameters<typeof encodeMessage>[0]) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(msg));
  }, []);

  // Effective plain-download concurrency (#74): our client default, clamped to
  // the bridge's advertised per-session transfer cap (from `caps.maxTransfers`)
  // so we never start more downloads than the bridge will accept — otherwise the
  // excess get capacity rejections and a batch can shed every download but one.
  const [downloadConcurrency, setDownloadConcurrency] = useState(
    MAX_INFLIGHT_DOWNLOADS,
  );

  // Plain file downloads (#41 resumable, #74 queue): the concurrency-limited
  // download state machine, mirroring the upload side. Owns the `downloads`
  // progress state, the accumulated bytes, and the offset-resume path. Preview
  // streams flow through `usePreviewGallery` instead; only non-preview frames
  // are routed to `handleDownloadMessage` below.
  const {
    downloads,
    handleDownloadMessage,
    startDownload,
    cancelDownload,
    resumeDownload,
    interruptInFlight: interruptDownloads,
    resumeInterrupted: resumeInterruptedDownloads,
    reset: resetDownloads,
  } = useDownloadTransfers({
    send,
    onDownloaded: (name: string) => notify("success", `Downloaded ${name}`),
    maxInFlight: downloadConcurrency,
    isElevated: () => elevatedRef.current,
  });

  // File-browser mutating actions (delete/mkdir/touch/rename/copy/move/chmod):
  // each builds a PromptDialog request and, on confirm, sends the SFTP message.
  const {
    onDelete,
    onDeleteMany,
    onMkdir,
    onTouch,
    onRename,
    onCopy,
    onMove,
    onDeletePath,
    onMovePath,
    onChmod,
  } = useFileActions({ cwd, entries, send, setDialog });

  const {
    request: requestThumbnail,
    setVisible: setThumbVisible,
    onReplied: onThumbReplied,
    reset: resetThumbs,
  } = useThumbnailQueue(send, MAX_INFLIGHT_THUMBS);

  const listDir = useCallback(
    (path: string) => {
      setFilesLoading(true);
      send({ t: "sftp-list", path });
    },
    [send],
  );

  // Debounced re-list of the current directory (#17). A batch of SFTP ops (e.g. a
  // folder upload of N files) produces N `sftp-ok` acks; without coalescing that
  // fires N full directory re-lists, each also re-deriving the FileBrowser's
  // sort/filter. Collapse a burst into a single refresh.
  const relistTimerRef = useRef<number | null>(null);
  const scheduleRelist = useCallback(() => {
    if (relistTimerRef.current !== null)
      window.clearTimeout(relistTimerRef.current);
    // Capture the directory this refresh is for; if the user navigates away
    // within the debounce window, skip it — otherwise a late re-list of the old
    // directory could land after (and overwrite) the destination listing, since
    // SFTP list responses aren't request-correlated.
    const dir = cwdRef.current;
    relistTimerRef.current = window.setTimeout(() => {
      relistTimerRef.current = null;
      if (cwdRef.current === dir) listDir(dir);
    }, 120);
  }, [listDir]);
  useEffect(
    () => () => {
      if (relistTimerRef.current !== null)
        window.clearTimeout(relistTimerRef.current);
    },
    [],
  );

  // "Clear thumbnail cache" (settings): ask the bridge to evict this
  // connection's cached tiles (the cache lives server-side now), then drop the
  // in-memory copies and let the visible tiles re-request — a fresh generation
  // (clearing `requestedThumbsRef` un-blocks their intersection observers).
  const clearPreviewCache = useCallback(() => {
    previewCacheClearOnly();
    prefetchPathsRef.current.clear();
  }, [previewCacheClearOnly]);

  // Approximate bytes a `data:…;base64,` URL decodes to (the tile's real size).
  const dataUrlBytes = useCallback((url: string) => {
    const comma = url.indexOf(",");
    if (comma < 0) return 0;
    const b64 = url.length - comma - 1;
    const pad = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((b64 * 3) / 4) - pad);
  }, []);

  // Total bytes of cached media this browser is holding in memory right now:
  // grid thumbnails + the recently-viewed preview LRU. Surfaced next to the
  // settings "Clear thumbnail cache" action so the RAM residual is visible.
  const clientCacheBytes = useCallback(() => {
    let total = previewCacheSizeBytes();
    for (const url of Object.values(thumbnailsRef.current)) {
      total += dataUrlBytes(url);
    }
    return total;
  }, [dataUrlBytes, previewCacheSizeBytes]);

  const clearThumbnails = useCallback(() => {
    send({ t: "thumb-purge" });
    resetThumbs();
    setThumbnails({});
    setThumbBg({});
    // Also drop the recently-viewed preview bytes held in this browser, so
    // "clear" empties the whole in-memory media cache, not just grid tiles.
    clearPreviewCache();
  }, [send, clearPreviewCache, resetThumbs]);

  // The preview/gallery subsystem: opening a file into the modal, the chunked
  // download/preview state machine, ←/→ gallery stepping, load-original, and
  // sidecar subtitles. The `preview` state, its refs and lifecycle effects stay
  // here (the render, error and disconnect paths use them) and are injected.
  const {
    handleTransferMessage,
    openPreviewFile,
    loadPreviewOriginal,
    stepPreview,
    pruneAndStep,
    closeSubtitleTrack,
  } = usePreviewGallery({
    send,
    setPreview,
    cachePreview,
    previewCacheGet,
    previewCacheHas,
    previewRef,
    previewPathRef,
    previewBuffersRef,
    previewMimeRef,
    prefetchPathsRef,
    originalLoadPathsRef,
    subtitleReadsRef,
    subtitleUrlRef,
    thumbnailsRef,
    entriesRef,
    cwdRef,
    elevatedRef,
    streamTokenRef,
    downloadCapRef,
    entryVersionRef,
  });

  // The recursive-search domain of the server-message handler: reconcile a
  // find (name) / grep (content) result against the still-showing search,
  // dropping a stale reply for an earlier query or the wrong axis.
  const handleSearchResult = useCallback(
    (
      msg: Extract<
        ServerMessage,
        { t: "sftp-find-result" | "sftp-grep-result" }
      >,
    ) => {
      const mode = msg.t === "sftp-find-result" ? "name" : "content";
      setSearch((prev) =>
        prev && prev.mode === mode && prev.query === msg.query
          ? {
              ...prev,
              loading: false,
              results: msg.entries,
              truncated: msg.truncated,
            }
          : prev,
      );
    },
    [],
  );

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.t) {
        case "status":
          if (msg.state === "connected") {
            reconnect.markConnected();
            setStatus("connected");
            setConnectedAt((at) => at ?? Date.now());
            setStatusMessage("");
            // A later disconnect should show a clean form, not the last prefill.
            setFormInitial(undefined);
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
            // Symmetrically, re-drive any download interrupted by the drop from
            // its byte offset (#41), through the same concurrency queue (#74).
            resumeInterruptedDownloads();
            // Re-establish a live-follow on the fresh session — the old one was
            // torn down when the previous socket dropped (Codex #5).
            if (followPathRef.current) {
              followDecoderRef.current = null;
              send({ t: "sftp-follow", path: followPathRef.current });
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
          downloadCapRef.current = msg.maxDownloadBytes ?? 0;
          // Clamp the client download queue to the bridge's transfer cap (#74).
          setDownloadConcurrency(
            msg.maxTransfers && msg.maxTransfers > 0
              ? Math.min(MAX_INFLIGHT_DOWNLOADS, msg.maxTransfers)
              : MAX_INFLIGHT_DOWNLOADS,
          );
          break;

        case "sftp-sudo":
          setElevated(msg.enabled);
          setElevatedPending(false);
          if (msg.enabled) {
            notify(
              "success",
              "Elevated access on — file operations run as root.",
            );
            // Elevation restored (e.g. after a reconnect re-elevate): a download
            // started under sudo was held interrupted until now — resume it
            // through the root SFTP handle. Update the ref first so the resume's
            // elevation check sees the new state before the syncing effect runs.
            elevatedRef.current = true;
            resumeInterruptedDownloads();
          }
          // The access identity just changed, so drop every cached thumbnail:
          // an image only root could read must not linger after dropping root
          // (nor should a user-visible one be assumed still readable as root).
          // The re-list below re-fetches thumbnails under the new identity.
          resetThumbs();
          setThumbnails({});
          setThumbBg({});
          // Drop cached preview bytes too: content only root could read must not
          // linger after de-elevate (and a user-visible file shouldn't be assumed
          // still readable as root).
          clearPreviewCache();
          // The bridge stopped any follow on a privilege change (it captured the
          // old SFTP handle); re-issue it so it resumes under the new identity
          // (Codex #8).
          if (followPathRef.current) {
            followDecoderRef.current = null;
            send({ t: "sftp-follow", path: followPathRef.current });
          }
          // Re-list the current directory so the view reflects root's access.
          listDir(cwdRef.current);
          break;

        case "sftp-list":
          // Landing in a different directory invalidates the thumbnail cache
          // (a plain refresh of the same directory keeps it, so re-listing after
          // a file op doesn't re-fetch every image).
          if (msg.path !== cwdRef.current) {
            resetThumbs();
            setThumbnails({});
            setThumbBg({});
          }
          cwdRef.current = msg.path;
          setCwd(msg.path);
          setEntries(msg.entries);
          setFilesLoading(false);
          // A fresh listing (navigation or refresh) exits search mode.
          setSearch(null);
          break;

        case "sftp-find-result":
        case "sftp-grep-result":
          handleSearchResult(msg);
          break;

        case "sftp-read":
          if (msg.edit) {
            const text = new TextDecoder().decode(base64ToBytes(msg.dataB64));
            // #76: a read requested for a diff (echoed `diff` flag) feeds the
            // diff collector, never the editor — even a stale reply whose path
            // no longer matches the pending pair is dropped, not opened.
            if (msg.diff) {
              const pend = diffPendingRef.current;
              if (pend && pend.paths.includes(msg.path)) {
                pend.got[msg.path] = { name: msg.name, content: text };
                if (pend.paths.every((p) => pend.got[p])) {
                  setDiff({
                    a: pend.got[pend.paths[0]],
                    b: pend.got[pend.paths[1]],
                  });
                  diffPendingRef.current = null;
                }
              }
              break;
            }
            editorsApiRef.current.openForEdit(msg.path, msg.name, text);
          } else if (msg.thumb) {
            // Free the concurrency slot and let the next queued tile go, whether
            // this one produced a thumbnail or not.
            onThumbReplied();
            // Empty payload = server skipped it (too big / not decodable): keep
            // the generic icon. `requestedThumbsRef` already blocks a re-request.
            if (msg.dataB64) {
              // The bridge always downscales a thumbnail to WebP (image or video
              // poster frame) — it never sends a full-size original as a thumb —
              // so a thumb payload is always `image/webp`. The bridge also caches
              // the finished tile server-side, so the client only holds it in
              // memory (dropped on logout — no browser copy persists).
              const mime = msg.mime ?? "image/webp";
              const dataUrl = `data:${mime};base64,${msg.dataB64}`;
              setThumbnails((prev) => ({ ...prev, [msg.path]: dataUrl }));
              if (msg.bg)
                setThumbBg((prev) => ({
                  ...prev,
                  [msg.path]: msg.bg as string,
                }));
            }
          } else {
            // Plain one-shot read (zip of a folder / multi-select). Previews now
            // stream in via the `sftp-download-*` frames below, not here.
            triggerDownload(msg.name, base64ToBytes(msg.dataB64));
          }
          break;

        case "sftp-download-begin":
        case "sftp-download-chunk":
        case "sftp-download-end":
          // Preview streams drive the modal; plain downloads drive the download
          // queue/progress. They share these frames, split by the `preview` tag.
          if (msg.preview) handleTransferMessage(msg);
          else handleDownloadMessage(msg);
          break;

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
            enqueueUpload({ path: msg.path, startOffset: offset });
          }
          break;
        }

        case "sftp-checksum": {
          // #46: surface the digest as a toast the user can read/copy.
          const base = msg.path.split("/").pop() || msg.path;
          notify("info", `${msg.algo} ${base}: ${msg.hex}`);
          break;
        }

        case "sftp-df":
          // #49: surface the current filesystem's free/total as a toast.
          notify("info", formatDiskUsage(msg.total, msg.free));
          break;

        case "sftp-follow-data": {
          // #47: append tail -f output to the open text preview for this path.
          // A fresh streaming decoder on each initial/reset frame; otherwise a
          // persistent one carries partial multibyte chars across ranges.
          if (msg.reset || msg.initial || !followDecoderRef.current) {
            followDecoderRef.current = new TextDecoder();
          }
          const chunk = followDecoderRef.current.decode(
            base64ToBytes(msg.dataB64),
            { stream: true },
          );
          setPreview((prev) => {
            if (!prev || prev.path !== msg.path || prev.kind !== "text")
              return prev;
            // The initial tail (and a truncation reset) replaces the view; later
            // chunks append. Keep only the trailing window so memory is bounded.
            const base = msg.reset || msg.initial ? "" : (prev.text ?? "");
            const combined = base + chunk;
            const text =
              combined.length > FOLLOW_MAX_TEXT
                ? combined.slice(combined.length - FOLLOW_MAX_TEXT)
                : combined;
            return { ...prev, text, streaming: false };
          });
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
            editorsApiRef.current.clearSaving(msg.path);
            if (editorsApiRef.current.markSaved(msg.path)) {
              // #26: positive confirmation of a save (the ● dirty marker just
              // clears otherwise). Uploads intentionally don't toast — a batch
              // would spam; their progress row covers completion.
              notify(
                "success",
                `Saved ${msg.path.split("/").pop() || msg.path}`,
              );
            }
          }
          // A delete/move started from the preview modal is confirmed: now (and
          // only now) prune the file from the open gallery, stepping to the next
          // sibling or closing the modal. Matched on op + the acked path.
          {
            const pending = pendingPreviewMutationRef.current;
            if (
              pending &&
              pending.op === msg.op &&
              pending.ackPath === msg.path
            ) {
              pendingPreviewMutationRef.current = null;
              pruneAndStep(pending.prunePath);
              // If the preview was opened from a recursive-search listing, the
              // browser keeps rendering `search.results` (not the cwd listing),
              // so drop the removed source path there too — otherwise a deleted /
              // moved hit stays visible and reopening it errors.
              setSearch((prev) =>
                prev
                  ? {
                      ...prev,
                      results: prev.results.filter(
                        (r) => r.path !== pending.prunePath,
                      ),
                    }
                  : prev,
              );
            }
          }
          scheduleRelist();
          break;

        case "idle-warning": {
          // The server is about to reap this idle session; warn the user so they
          // can keep it alive. Any keypress/SFTP op resets the server timer.
          const secs = Math.max(1, Math.round((msg.remainingMs || 0) / 1000));
          notify(
            "info",
            `Inactive — disconnecting in ${secs}s. Press a key to stay connected.`,
          );
          break;
        }

        case "error":
          if (msg.scope === "sftp") {
            // NB: an sftp `error` frame carries no path/op, so we can't tell
            // whether it belongs to a preview delete/move in flight. We
            // deliberately do NOT clear `pendingPreviewMutationRef` here — an
            // unrelated concurrent failure (a background upload/download) must
            // not drop a still-valid pending mutation and make its later
            // `sftp-ok` a no-op. The pending ref is matched on exact op + acked
            // path (so a stale one can't prune the wrong file) and is cleared
            // when the modal closes (see the FilePreview onClose/onCancel).
            // SFTP errors only happen while connected, where the overlay's
            // status text is hidden — a toast is the only visible channel.
            // Clear any in-flight spinners so a failed list/save doesn't hang.
            setFilesLoading(false);
            editorsApiRef.current.clearSaving();
            setElevatedPending(false);
            // A failed diff read must not wedge the collector (which would
            // otherwise swallow later reads for those paths) (#76 review).
            diffPendingRef.current = null;
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
    [
      listDir,
      scheduleRelist,
      send,
      notify,
      onThumbReplied,
      resetThumbs,
      enqueueUpload,
      clearPreviewCache,
      handleTransferMessage,
      handleDownloadMessage,
      resumeInterruptedDownloads,
      handleSearchResult,
      pruneAndStep,
      reconnect,
    ],
  );

  // Send the `connect` handshake once the socket opens (with the current
  // terminal size). Passed to useSshSocket as its onOpen.
  const sendConnect = useCallback(
    (details: ConnectDetails) => {
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
    },
    [send],
  );

  // The bridge WebSocket lifecycle: open + handler wiring + reconnect-on-drop.
  // The socket hook keeps no session state — it calls back in for the handshake,
  // messages, and the hard-failure / transport-error statuses.
  const { openSocket } = useSshSocket({
    wsRef,
    reconnect,
    userClosedRef,
    lastDetailsRef,
    onMessage: handleServerMessage,
    onOpen: sendConnect,
    // A live session dropped: park streaming downloads as interrupted (keeping
    // their partial bytes) so they auto-resume from offset on reconnect (#41).
    onDrop: interruptDownloads,
    onNeverConnected: () => {
      // Login/host failure. Return to the connect form pre-filled with the same
      // host/port/user (and key material) but a cleared password — re-seed it by
      // bumping formSeed so the user only retypes the secret.
      const d = lastDetailsRef.current;
      setFormInitial(
        d
          ? {
              host: d.host,
              port: String(d.port),
              username: d.username,
              auth: d.privateKey ? "key" : "password",
              privateKey: d.privateKey ?? "",
              passphrase: d.passphrase ?? "",
            }
          : undefined,
      );
      setStatus("error");
      setFormSeed((s) => s + 1);
    },
    onSocketError: () =>
      setStatusMessage("WebSocket error — is the SSH bridge running?"),
  });

  // Fresh, user-initiated connect: reset all reconnection state.
  const connect = useCallback(
    (details: ConnectDetails) => {
      reconnect.resetForConnect();
      lastDetailsRef.current = details;
      setHasLast(true);
      userClosedRef.current = false;
      setStatus("connecting");
      setStatusMessage("");
      setAuthPrompt(null);
      setLatency(null);
      setConnectedAt(null);
      setTarget({ user: details.username, host: details.host });
      openSocket(details);
    },
    [openSocket, reconnect],
  );

  const reconnectNow = useCallback(() => {
    if (!lastDetailsRef.current) return;
    reconnect.resetAttempts();
    connect(lastDetailsRef.current);
  }, [connect, reconnect]);

  const disconnect = useCallback(() => {
    userClosedRef.current = true;
    reconnect.cancelPending();
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
    editorsApiRef.current.reset();
    // #76 review: drop the open diff + its collector so remote file contents
    // don't linger on screen after logout or into a later connection.
    setDiff(null);
    diffPendingRef.current = null;
    setFollowPath(null);
    setPreview(null);
    setPastePending(null);
    setDialog(null);
    setShowShortcuts(false);
    setLatency(null);
    setConnectedAt(null);
    setUploads({});
    uploadCtlRef.current = {};
    resetUploads();
    resetDownloads();
    previewBuffersRef.current = {};
    previewMimeRef.current = {};
    previewCacheClearOnly();
    prefetchPathsRef.current.clear();
    originalLoadPathsRef.current.clear();
    streamTokenRef.current = null;
    videoTimesRef.current.clear();
    if (subtitleUrlRef.current) {
      URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = null;
    }
    subtitleReadsRef.current.clear();
    // Logout invalidates every cached thumbnail in the browser (they live in
    // memory only) so nothing stays viewable or downloadable after disconnect;
    // the server keeps its own cache for a future re-login. `setPreview(null)`
    // above already revokes any open preview blob.
    setThumbnails({});
    setThumbBg({});
    resetThumbs();
    setHasLast(false);
    ctrlRef.current = false;
    altRef.current = false;
    setCtrlArmed(false);
    setAltArmed(false);
    xtermRef.current?.clear();
  }, [
    send,
    resetThumbs,
    resetUploads,
    resetDownloads,
    reconnect,
    previewCacheClearOnly,
  ]);

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
      reconnect.cancelPending();
      wsRef.current?.close();
    },
    [reconnect],
  );

  const connected = status === "connected";

  // Mirror `connected` into a ref the ws message handler can read synchronously.
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Report this tab's connected details upward (for other tabs' "same server"
  // quick-connect), and clear it whenever this tab isn't connected. The details
  // stay in memory only — same as the reconnect credentials this session
  // already holds — and are dropped on disconnect and unmount.
  const onConnectionChangeRef = useRef(onConnectionChange);
  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange;
  });
  useEffect(() => {
    onConnectionChangeRef.current?.(connected ? lastDetailsRef.current : null);
    return () => onConnectionChangeRef.current?.(null);
  }, [connected]);

  // Keep previewPathRef in sync so a late preview reply knows what's open.
  useEffect(() => {
    previewPathRef.current = preview?.path ?? null;
  }, [preview?.path]);

  // Keep the full-state mirror in sync for stepPreview (gallery ←/→).
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  // Revoke a preview's blob URL once it's replaced or the modal closes, so
  // decoded media doesn't leak for the life of the session.
  useEffect(() => {
    const url = preview?.src;
    if (url && url.startsWith("blob:")) return () => URL.revokeObjectURL(url);
  }, [preview?.src]);

  // Keep the ref the (bound-once) ws handler reads current.
  useEffect(() => {
    elevatedRef.current = elevated;
  }, [elevated]);

  // On each listing, rebuild the path→version map (size:mtime) that keys the
  // in-memory preview cache so an edited file re-fetches. The thumbnail cache
  // itself lives on the bridge now, so there's nothing to preload here — a
  // visible tile requests its thumb and the bridge serves it (from its cache
  // when it has it, so a re-visited folder still paints fast).
  useEffect(() => {
    const base = cwd.replace(/\/$/, "");
    const versions = new Map<string, string>();
    for (const e of entries)
      versions.set(`${base}/${e.name}`, fileVersionTag(e));
    entryVersionRef.current = versions;
  }, [entries, cwd]);

  // Report label + status + busy to the tab manager whenever they change. "busy"
  // means closing would interrupt something: an open editor (possible unsaved
  // work) or an in-flight upload/download (#85).
  const busy =
    editors.length > 0 ||
    Object.keys(uploads).length > 0 ||
    Object.keys(downloads).length > 0;
  useEffect(() => {
    onMeta({
      label: target ? `${target.user}@${target.host}` : "New session",
      status,
      busy,
    });
  }, [target, status, busy, onMeta]);

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
  // A dropped *live* session offers a one-click reconnect (saved credentials).
  // A failed login (status "error") instead returns to the pre-filled form.
  const canReconnect = status === "dropped" && hasLast;

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
  // Copy a file/breadcrumb path to the clipboard (#72), with a toast either way.
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify("success", `Copied path: ${path}`);
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

  // "Open terminal here" (#50): cd the shell to the file browser's current
  // directory and switch to the terminal. This runs the cd (trailing newline)
  // since it's an explicit, safe navigation the user asked for; the path is
  // single-quoted so metacharacters can't break out.
  const openTerminalHere = () => {
    if (!connected) return;
    disarmMods();
    send({ t: "data", data: cdCommand(cwd) });
    setTab("terminal");
    xtermRef.current?.focus();
  };

  // Request disk usage (df) for the current directory (#49); the result comes
  // back as an `sftp-df` frame surfaced as a toast.
  const requestDiskUsage = () => {
    if (connected) send({ t: "sftp-df", path: cwd });
  };

  // Toggle tail -f on the open preview's file (#47). Stops any prior follow.
  const toggleFollow = (path: string) => {
    if (followPath === path) {
      send({ t: "sftp-follow-stop", path });
      setFollowPath(null);
      return;
    }
    if (followPath) send({ t: "sftp-follow-stop", path: followPath });
    send({ t: "sftp-follow", path });
    setFollowPath(path);
  };
  // Stop following automatically when the preview closes or steps to another
  // file, so a background poll never lingers on the bridge.
  useEffect(() => {
    followPathRef.current = followPath;
    if (!followPath) followDecoderRef.current = null;
  }, [followPath]);
  useEffect(() => {
    if (followPath && preview?.path !== followPath) {
      send({ t: "sftp-follow-stop", path: followPath });
      // Defer the state update out of the effect body (a synchronous setState
      // here trips React's cascading-render guard).
      queueMicrotask(() => setFollowPath(null));
    }
  }, [preview?.path, followPath, send]);

  // Diff two selected text files (#76): read both via the editor read path into
  // the pending-diff collector, which opens the modal once both arrive.
  const onDiff = (items: FileEntry[]) => {
    if (!connected || items.length !== 2) return;
    if (diffPendingRef.current) return; // a diff is already loading
    // Refuse up front when either file is too big to diff, rather than
    // transferring two whole files the line-capped diff mostly discards.
    const tooBig = items.find((e) => e.size > DIFF_MAX_BYTES);
    if (tooBig) {
      notify(
        "error",
        `Too large to diff: ${tooBig.name} (> ${formatSize(DIFF_MAX_BYTES, "file")}).`,
      );
      return;
    }
    const base = cwd.replace(/\/$/, "");
    const paths: [string, string] = [
      `${base}/${items[0].name}`,
      `${base}/${items[1].name}`,
    ];
    diffPendingRef.current = { paths, got: {} };
    // `diff: true` is echoed on each reply so it routes to the diff collector.
    for (const p of paths)
      send({ t: "sftp-read", path: p, edit: true, diff: true });
  };

  // --- File browser actions (in-app dialogs, not window.prompt/confirm) ---
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
  // bails silently if the upload was cancelled meanwhile. Started only through
  // the upload queue's `startUpload`, which reserves the concurrency slot this
  // loop releases when it finishes (whether it completes, interrupts, or errors).
  const runUpload = useCallback(
    async (path: string, startOffset: number) => {
      let released = false;
      const releaseSlot = () => {
        if (released) return;
        released = true;
        onUploadReleased();
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
          u[path] ? { ...u, [path]: { ...u[path], status: "interrupted" } } : u,
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
    [send, notify, clearUploadRow, onUploadReleased],
  );

  // The upload queue's starter: begin one job, returning whether it consumed a
  // concurrency slot. A cancelled or already-running job is skipped (returns
  // false, no slot). `runUpload` releases the slot when it finishes streaming.
  const startUpload = useCallback(
    (job: UploadJob): boolean => {
      const ctl = uploadCtlRef.current[job.path];
      if (!ctl || ctl.cancelled || ctl.running) return false;
      void runUpload(job.path, job.startOffset);
      return true;
    },
    [runUpload],
  );

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
        [path]: {
          path,
          name: rel,
          sent: 0,
          total: file.size,
          status: "queued",
        },
      }));
      enqueueUpload({ path, startOffset: 0 });
    },
    [enqueueUpload],
  );

  // Cancel an in-flight, queued, or interrupted upload: stop the local loop,
  // drop it from the queue, tell the bridge to tear down the stream and remove
  // the partial, and drop the row.
  const cancelUpload = useCallback(
    (path: string) => {
      const ctl = uploadCtlRef.current[path];
      if (ctl) ctl.cancelled = true;
      removeUploads((job) => job.path !== path);
      delete uploadCtlRef.current[path];
      send({ t: "sftp-upload-cancel", path });
      clearUploadRow(path);
    },
    [send, clearUploadRow, removeUploads],
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

  // Inject the queue's starter once `runUpload` exists (it's defined after the
  // ws message handler that enqueues), so a `sftp-write-at` resume reply can kick
  // the queue. The hook holds `startUpload` in a ref, so this stays current.
  useEffect(() => {
    setUploadStart(startUpload);
  }, [startUpload, setUploadStart]);
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
      input: {
        label: "sudo password",
        placeholder: "(blank for NOPASSWD)",
        password: true,
      },
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
    send({
      t: mode === "content" ? "sftp-grep" : "sftp-find",
      path: cwd,
      query: q,
    });
  };
  const onClearSearch = () => setSearch(null);

  // Open a file in the inline editor. A very large file in a textarea with live
  // highlighting can be sluggish, so warn (and let the user back out) before
  // requesting one past the editor size threshold; already-open files reopen
  // without a prompt (the read reply just refocuses the existing tab).
  const requestEdit = (path: string, name: string, size: number) => {
    const openEditor = () => send({ t: "sftp-read", path, edit: true });
    const alreadyOpen = editorsApi.isOpen(path);
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
    editorsApi.beginSave(path, text);
    // Offload the base64 encode to a worker for large files so saving a big file
    // doesn't jank the UI (#98); falls back to a synchronous encode when workers
    // are unavailable, so the frame is always sent.
    const bytes = new TextEncoder().encode(text);
    // Bind the write to the socket that started it: if the connection drops or is
    // replaced while the (async) encode runs, don't send a stale write to a new
    // session — clear the saving state so the editor doesn't get stuck on
    // "Saving…" (the user can retry once reconnected).
    const originWs = wsRef.current;
    void bytesToBase64Async(bytes).then((dataB64) => {
      if (
        wsRef.current !== originWs ||
        originWs?.readyState !== WebSocket.OPEN
      ) {
        editorsApi.clearSaving(path);
        return;
      }
      send({ t: "sftp-write", path, dataB64 });
    });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-term-border bg-term-card">
      {/* Session header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        {/* Identity — the host renders identically in both tabs because the
            controls group is the same width in each (the terminal-only Search
            button keeps a reserved slot on the files tab too, below), so the
            `flex-1` identity always receives the same leftover width. The
            min-width floor is a readability aid: once the row is tight the
            controls wrap to their own line rather than squeezing the host. */}
        <div className="flex min-w-[14rem] flex-1 items-center gap-2.5">
          <StatusDot status={status} />
          <span
            className="min-w-0 flex-1 truncate text-xs text-term-dim"
            title={target ? `${target.user}@${target.host}` : undefined}
          >
            {target ? `${target.user}@${target.host}` : "Not connected"}
          </span>
        </div>

        {/* Live status chips — their own group so they wrap away from the host
            (as a unit) before the host has to truncate. */}
        {connected && (connectedAt !== null || latency !== null) && (
          <div className="flex flex-none items-center gap-3">
            {connectedAt !== null && <Uptime since={connectedAt} />}
            {latency !== null && <LatencyChip ms={latency} />}
          </div>
        )}

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
              {/* Terminal-only, but always occupies its slot so the controls
                  group is the same width in both tabs — otherwise the `flex-1`
                  identity would get more room (and truncate later) in the files
                  tab than the terminal tab. On the files tab it's an invisible,
                  non-interactive placeholder. */}
              <button
                type="button"
                onClick={() => {
                  setTab("terminal");
                  xtermRef.current?.openSearch();
                }}
                className={cn(
                  "rounded px-2 py-1 text-term-muted transition-colors hover:text-term-text",
                  tab !== "terminal" && "pointer-events-none invisible",
                )}
                tabIndex={tab === "terminal" ? undefined : -1}
                aria-hidden={tab !== "terminal"}
                title="Search terminal (Ctrl+F)"
                aria-label="Search terminal"
              >
                <SearchIcon className="h-3.5 w-3.5" />
              </button>
              <TerminalSettings
                onClearThumbnailCache={clearThumbnails}
                getCacheBytes={clientCacheBytes}
                notifications={{
                  supported: desktopNotify.supported,
                  enabled: desktopNotify.enabled,
                  permission: desktopNotify.permission,
                  onToggle: desktopNotify.setEnabled,
                }}
              />
            </div>

            {/* Tab switcher — one segmented control so the tabs read as a
                single unit and stay together when the header wraps. */}
            <div className="inline-flex overflow-hidden rounded-md border border-term-border">
              {(["terminal", "files"] as const).map((t) => (
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
            />
          </div>
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
              onResumeDownload={resumeDownload}
              canElevate={canElevate}
              elevated={elevated}
              elevatedPending={elevatedPending}
              onToggleElevated={toggleElevated}
              active={active}
              onOpenTerminalHere={openTerminalHere}
              onDiskUsage={requestDiskUsage}
              onCopyPath={copyPath}
              onNavigate={listDir}
              onRefresh={() => listDir(cwd)}
              onDownload={(path) =>
                startDownload(path, entryVersionRef.current.get(path))
              }
              onDownloadDir={(path) => send({ t: "sftp-download-dir", path })}
              onDownloadMany={(paths) =>
                send({ t: "sftp-download-many", paths })
              }
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              onUpload={(file, relPath) => uploadFile(file, cwd, relPath)}
              onMkdir={onMkdir}
              onTouch={onTouch}
              onRename={onRename}
              onCopy={onCopy}
              onMove={onMove}
              onChmod={onChmod}
              onDiff={onDiff}
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
              thumbBg={thumbBg}
              onRequestThumbnail={requestThumbnail}
              onThumbnailVisibility={setThumbVisible}
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
                streaming={
                  preview.loading === false &&
                  preview.received !== undefined &&
                  preview.total !== undefined
                }
                truncated={preview.truncated}
                following={followPath === preview.path}
                onToggleFollow={() => toggleFollow(preview.path)}
                encodingWarning={preview.encodingWarning}
                optimized={preview.optimized}
                originalDims={preview.originalDims}
                loadingOriginal={preview.loadingOriginal}
                // Only offer "load original" for images the browser can render
                // raw — a HEIC/HEIF preview *is* a transcode with no viewable
                // original to swap in (Download still fetches the raw file).
                onLoadOriginal={
                  isBrowserRenderableImage(preview.name)
                    ? () => loadPreviewOriginal(preview.path)
                    : undefined
                }
                videoFallbackSrc={preview.videoFallbackSrc}
                subtitleSrc={preview.subtitleSrc}
                subtitleTrackLabel={preview.subtitleLabel}
                getStartTime={() =>
                  videoTimesRef.current.get(preview.path) ?? 0
                }
                onTime={(t) => videoTimesRef.current.set(preview.path, t)}
                hasGallery={(preview.siblings?.length ?? 0) > 1}
                index={preview.siblings?.findIndex(
                  (s) => s.path === preview.path,
                )}
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
                onEdit={
                  // A read-only text/markdown preview can jump straight into the
                  // editor without closing and re-finding the file. Only for
                  // editable files (media/PDF/unsupported have no editor).
                  (preview.kind === "text" || preview.kind === "markdown") &&
                  isProbablyTextFile(preview.name)
                    ? () => {
                        // Stop an in-flight preview stream before switching.
                        if (preview.loading || preview.received !== undefined) {
                          send({
                            t: "sftp-download-cancel",
                            path: preview.path,
                          });
                          delete previewBuffersRef.current[preview.path];
                        }
                        closeSubtitleTrack();
                        const version = entryVersionRef.current.get(
                          preview.path,
                        );
                        const size = version
                          ? parseInt(version.split(":")[0], 10)
                          : 0;
                        setPreview(null);
                        requestEdit(preview.path, preview.name, size);
                      }
                    : undefined
                }
                onDelete={() =>
                  onDeletePath(preview.path, false, preview.name, () => {
                    pendingPreviewMutationRef.current = {
                      op: "rm",
                      ackPath: preview.path,
                      prunePath: preview.path,
                    };
                  })
                }
                onMove={() =>
                  onMovePath(preview.path, preview.name, (toPath) => {
                    pendingPreviewMutationRef.current = {
                      op: "rename",
                      ackPath: toPath,
                      prunePath: preview.path,
                    };
                  })
                }
                info={(() => {
                  // Metadata for the info panel, from the current listing entry
                  // (absent for a search hit outside `cwd`, which is fine).
                  const entry = entries.find(
                    (e) => joinPath(cwd, e.name) === preview.path,
                  );
                  return entry
                    ? {
                        size: entry.size,
                        mtime: entry.mtime,
                        mode: entry.mode,
                      }
                    : undefined;
                })()}
                onDownload={() =>
                  // Reuse the held bytes only when they're the *original*; an
                  // optimized (downscaled WebP) preview — or a stream-only
                  // video/audio, or the download-only fallback — fetches the
                  // untouched original on demand (streamed, with a progress bar).
                  preview.bytes && !preview.optimized
                    ? triggerDownload(preview.name, preview.bytes)
                    : startDownload(
                        preview.path,
                        entryVersionRef.current.get(preview.path),
                      )
                }
                onCancel={() => {
                  // Abort the in-flight preview stream and close the modal.
                  send({ t: "sftp-download-cancel", path: preview.path });
                  delete previewBuffersRef.current[preview.path];
                  pendingPreviewMutationRef.current = null;
                  closeSubtitleTrack();
                  setPreview(null);
                }}
                onClose={() => {
                  // Closing mid-transfer stops the stream so we don't keep
                  // pulling a large file the user no longer wants.
                  if (preview.loading) {
                    send({ t: "sftp-download-cancel", path: preview.path });
                    delete previewBuffersRef.current[preview.path];
                  }
                  // Bound the pending-mutation lifetime: a delete/move whose ack
                  // never arrived (it failed) must not linger and prune a later
                  // gallery.
                  pendingPreviewMutationRef.current = null;
                  closeSubtitleTrack();
                  setPreview(null);
                }}
              />
            )}
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
            onSelect={editorsApi.select}
            onCloseFile={editorsApi.close}
            onCloseAll={editorsApi.closeAll}
          />
        )}

        {diff && (
          <DiffView a={diff.a} b={diff.b} onClose={() => setDiff(null)} />
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
                        setFormInitial(undefined);
                        setFormSeed((s) => s + 1);
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
                      &gt;
                      <span className="term-cursor ml-0.5 align-middle" />
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
                    {status === "error" ? "Try again" : "New SSH connection"}
                  </h2>
                  <p className="mt-1 mb-5 text-xs leading-relaxed text-term-muted">
                    {status === "error"
                      ? "The login didn't go through. Your host, port and username are kept — just re-enter your password (or key) and reconnect."
                      : "Credentials are relayed straight to the target host to open the session and are never stored or logged by this site. Only connect to hosts you trust."}
                  </p>
                  <ConnectForm
                    key={formSeed}
                    initial={formInitial}
                    onConnect={connect}
                    connecting={connecting}
                  />
                  {statusMessage && (
                    <p className="mt-4 rounded-md border border-term-red/40 bg-term-red/10 px-3 py-2 text-xs text-term-red">
                      {statusMessage}
                    </p>
                  )}
                  {reusableConnections && reusableConnections.length > 0 && (
                    <div className="mt-6 border-t border-term-border pt-4">
                      <p className="mb-2 text-xs font-medium text-term-muted">
                        Open another session on a server you&apos;re already on
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {reusableConnections.map((c) => (
                          <button
                            key={c.label}
                            type="button"
                            onClick={() => connect(c.details)}
                            disabled={connecting}
                            className={cn(
                              "flex items-center gap-2 rounded-md border border-term-border bg-term-panel px-3 py-2 text-left text-sm text-term-text transition-colors hover:border-term-accent/40 hover:bg-term-accent/10",
                              connecting && "cursor-not-allowed opacity-60",
                            )}
                          >
                            <span
                              className="select-none font-mono text-term-accent"
                              aria-hidden
                            >
                              ↳
                            </span>
                            <span className="truncate font-mono">
                              {c.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
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
