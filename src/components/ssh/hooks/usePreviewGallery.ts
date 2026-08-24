import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  type ClientMessage,
  type FileEntry,
  type ServerMessage,
  filePreviewKind,
  joinPath,
  TEXT_PREVIEW_MAX_BYTES,
  videoNeedsTranscode,
} from "@/lib/sshProtocol";
import { base64ToBytes, concatBytes } from "@/lib/bytes";
import { SSH_MEDIA_CACHE_MAX_BYTES } from "@/config/siteConfig";
import {
  findSubtitleSidecar,
  srtToVtt,
  subtitleLabel,
  subtitleNeedsConversion,
} from "@/lib/subtitles";
import {
  previewFieldsFromBytes,
  previewRenderKind,
} from "../preview/previewFields";
import type { PreviewState } from "../preview/previewState";
import type { PreviewCacheEntry } from "./usePreviewCache";

/** Don't prefetch a gallery neighbour bigger than this — prefetching is a
 * latency nicety for the common case (folders of photos), not a reason to pull
 * a huge file the user may never step to. Bytes read from the entry's
 * `size:mtime` version tag. */
const PREFETCH_MAX_BYTES = 16 * 1024 * 1024;

/** A natively-playable video/audio clip at or under this size is fetched whole
 * and held in the in-memory preview cache instead of streamed, so stepping the
 * gallery away and back re-opens it *instantly* and fully seekable (no re-buffer)
 * — the cache is memory-only, dropped on logout, so nothing lingers. Larger
 * clips keep streaming over the seekable HTTP endpoint (fast start, no whole-file
 * transfer). Effective threshold is clamped to the bridge's download cap so a
 * whole-file fetch can never exceed what an ordinary download would allow. */
const MEDIA_CACHE_MAX_BYTES = SSH_MEDIA_CACHE_MAX_BYTES;

/** Server path of the seekable media-stream endpoint (mirrors `server.mjs`). A
 * `<video>` points here with the session's `streamToken` so playback ranges are
 * served over HTTP instead of buffering the whole clip into a blob. */
const PREVIEW_STREAM_PATH = "/api/preview";

/** Don't read a sidecar subtitle bigger than this — a real `.srt`/`.vtt` is tiny;
 * anything larger is almost certainly not a subtitle track. */
const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024;

/** Build the `/api/preview` URL for a media (video/audio) path with the session's
 * stream token, so a `<video>`/`<audio>` plays over HTTP Range instead of
 * buffering the whole original into a blob. With `transcode`, the bridge converts
 * a non-natively-playable container to fragmented MP4 on the fly (progressive,
 * no seeking) instead of range-serving the raw bytes. */
function mediaStreamSrc(
  token: string,
  path: string,
  transcode = false,
): string {
  const base = `${PREVIEW_STREAM_PATH}?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;
  return transcode ? `${base}&transcode=1` : base;
}

/** The state SshSession owns (via useState/useRef) that the preview/gallery
 * handlers read and mutate. Passed in so the handlers live here while the state
 * stays with the component (whose render, effects, error and disconnect paths
 * also touch it). The pure helpers (codecs, subtitle conversion, field builder)
 * are imported directly, not injected. */
export interface PreviewGalleryDeps {
  send: (msg: ClientMessage) => void;
  setPreview: Dispatch<SetStateAction<PreviewState | null>>;
  /** Store fully-loaded preview bytes in the recently-viewed cache. */
  cachePreview: (
    path: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
    optimized?: boolean,
    mime?: string,
  ) => void;
  /** A live cache entry for `path`, or null on a miss. */
  previewCacheGet: (path: string) => PreviewCacheEntry | null;
  /** Whether `path` is currently cached (without touching its age). */
  previewCacheHas: (path: string) => boolean;
  previewRef: RefObject<PreviewState | null>;
  previewPathRef: RefObject<string | null>;
  previewBuffersRef: RefObject<Record<string, Uint8Array[]>>;
  previewMimeRef: RefObject<Record<string, string>>;
  prefetchPathsRef: RefObject<Set<string>>;
  originalLoadPathsRef: RefObject<Set<string>>;
  subtitleReadsRef: RefObject<Map<string, { videoPath: string; name: string }>>;
  subtitleUrlRef: RefObject<string | null>;
  thumbnailsRef: RefObject<Record<string, string>>;
  entriesRef: RefObject<FileEntry[]>;
  cwdRef: RefObject<string>;
  elevatedRef: RefObject<boolean>;
  streamTokenRef: RefObject<string | null>;
  downloadCapRef: RefObject<number>;
  entryVersionRef: RefObject<Map<string, string>>;
}

/** The SshSession preview/gallery subsystem: opening a file into the modal,
 * streaming its bytes in (the `sftp-download-*` state machine), stepping ←/→
 * through a folder like a gallery, loading a full-resolution original over an
 * optimized preview, prefetching neighbours, and attaching a sidecar subtitle.
 * The `preview` state, its refs and lifecycle effects stay in SshSession (whose
 * render, error and disconnect paths also use them) and are injected via
 * {@link PreviewGalleryDeps}; behaviour is characterized in
 * `SshSession.download.test.tsx`. */
export function usePreviewGallery(deps: PreviewGalleryDeps) {
  const {
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
  } = deps;

  // Stream the gallery neighbours of `path` (the previous & next previewable
  // file) into the preview cache ahead of a ←/→ step, so paging through a folder
  // is instant. Images prefetch as the light downscaled WebP; small,
  // natively-playable audio/video clips prefetch whole (within the media-cache
  // budget) so stepping onto one opens instantly and fully seekable — matching
  // the `cacheSmallWhole` path in `openPreviewFile`. A neighbour already cached,
  // in flight, or bigger than the relevant cap is skipped. The download handlers
  // recognise these paths via `prefetchPathsRef` and buffer their bytes without
  // painting the modal. (Elevated reads prefetch too — the cache is dropped on
  // every `sudo` toggle and on logout, so nothing root-read lingers.)
  const prefetchNeighbors = useCallback(
    (path: string, siblings?: { path: string; name: string }[]) => {
      if (!siblings || siblings.length < 2) return;
      const idx = siblings.findIndex((s) => s.path === path);
      if (idx < 0) return;
      const n = siblings.length;
      const cap = downloadCapRef.current;
      const mediaBudget = Math.min(
        PREFETCH_MAX_BYTES,
        cap > 0 ? Math.min(MEDIA_CACHE_MAX_BYTES, cap) : MEDIA_CACHE_MAX_BYTES,
      );
      for (const delta of [1, -1]) {
        const nb = siblings[(idx + delta + n) % n];
        if (!nb || nb.path === path) continue;
        if (previewCacheHas(nb.path)) continue;
        if (prefetchPathsRef.current.has(nb.path)) continue;
        const kind = filePreviewKind(nb.name);
        const version = entryVersionRef.current.get(nb.path);
        const size = version ? parseInt(version.split(":")[0], 10) : 0;
        if (kind === "image") {
          if (size > PREFETCH_MAX_BYTES) continue;
          prefetchPathsRef.current.add(nb.path);
          // Prefetch the light WebP (the same downscaled preview open uses).
          send({
            t: "sftp-read",
            path: nb.path,
            preview: true,
            previewResize: true,
          });
          continue;
        }
        // Only whole-cache media that reliably plays from a blob, small enough to
        // sit in the media-cache budget — everything else keeps streaming on open.
        const reliablyNative =
          kind === "audio" ||
          (kind === "video" && /\.(mp4|m4v|webm|ogv)$/i.test(nb.name));
        if (!reliablyNative) continue;
        if (kind === "video" && videoNeedsTranscode(nb.name)) continue;
        if (size <= 0 || size > mediaBudget) continue;
        prefetchPathsRef.current.add(nb.path);
        // Whole-file read (no resize/cap) so the cached bytes play as a native blob.
        send({ t: "sftp-read", path: nb.path, preview: true });
      }
    },
    [send, previewCacheHas, downloadCapRef, entryVersionRef, prefetchPathsRef],
  );

  // The streamed-transfer domain of the server-message handler: the chunked
  // download / preview state machine (`sftp-download-begin/chunk/end`). A preview
  // buffers chunks and drives the modal, a plain download assembles the file and
  // hands it to `triggerDownload`, and a sidecar-subtitle / prefetch read buffers
  // silently. Characterized in `SshSession.download.test.tsx`.
  const handleTransferMessage = useCallback(
    (
      msg: Extract<
        ServerMessage,
        {
          t:
            "sftp-download-begin" | "sftp-download-chunk" | "sftp-download-end";
        }
      >,
    ) => {
      switch (msg.t) {
        case "sftp-download-begin": {
          if (msg.preview) {
            // A preview stream: buffer chunks and drive the modal's progress bar
            // instead of registering a download row. A prefetch (adjacent gallery
            // image) and a sidecar-subtitle read buffer silently; otherwise ignore
            // a stale begin the user already navigated away from.
            const isPrefetch = prefetchPathsRef.current.has(msg.path);
            const isSubtitle = subtitleReadsRef.current.has(msg.path);
            if (
              previewPathRef.current !== msg.path &&
              !isPrefetch &&
              !isSubtitle
            )
              break;
            previewBuffersRef.current[msg.path] = [];
            // A `mime` here means the bridge sent a transcoded (WebP) preview
            // rather than the original bytes; remember it for the end frame.
            if (msg.mime) previewMimeRef.current[msg.path] = msg.mime;
            else delete previewMimeRef.current[msg.path];
            // The original image's true dimensions (transcoded image previews
            // only), for the true-size read-out + the large-original gate.
            const originalDims =
              msg.origWidth && msg.origHeight
                ? { w: msg.origWidth, h: msg.origHeight }
                : undefined;
            setPreview((prev) =>
              prev && prev.path === msg.path
                ? { ...prev, received: 0, total: msg.size, originalDims }
                : prev,
            );
          }
          // Plain (non-preview) downloads are owned by `useDownloadTransfers`;
          // only preview frames reach this handler.
          break;
        }

        case "sftp-download-chunk": {
          if (msg.preview) {
            const chunks = previewBuffersRef.current[msg.path];
            if (!chunks) break;
            const bytes = base64ToBytes(msg.dataB64);
            chunks.push(bytes);
            // Progressive text/markdown: decode what's arrived so far and paint it
            // as the modal fills, instead of showing only a spinner until the whole
            // (up to `TEXT_PREVIEW_MAX_BYTES`) transfer completes. A large log's head
            // appears almost immediately. Only for the actively-viewed text/markdown
            // preview (prefetches are images); media/PDF still buffer to a blob. Any
            // trailing partial multi-byte char is resolved on the next chunk / end.
            const cur = previewRef.current;
            const progressive =
              previewPathRef.current === msg.path &&
              cur?.path === msg.path &&
              (cur.kind === "text" || cur.kind === "markdown");
            const partialText = progressive
              ? new TextDecoder().decode(concatBytes(chunks))
              : null;
            setPreview((prev) =>
              prev && prev.path === msg.path
                ? {
                    ...prev,
                    received: (prev.received ?? 0) + bytes.length,
                    ...(partialText !== null
                      ? { text: partialText, loading: false }
                      : {}),
                  }
                : prev,
            );
          }
          // Plain (non-preview) download chunks are handled elsewhere.
          break;
        }

        case "sftp-download-end": {
          if (msg.preview) {
            // A sidecar-subtitle read: convert to WebVTT and attach it to the
            // open video preview (never painted as its own preview).
            const subtitleTarget = subtitleReadsRef.current.get(msg.path);
            if (subtitleTarget) {
              subtitleReadsRef.current.delete(msg.path);
              const subChunks = previewBuffersRef.current[msg.path];
              delete previewBuffersRef.current[msg.path];
              delete previewMimeRef.current[msg.path];
              if (
                subChunks &&
                previewPathRef.current === subtitleTarget.videoPath
              ) {
                try {
                  const text = new TextDecoder().decode(concatBytes(subChunks));
                  const vtt = subtitleNeedsConversion(subtitleTarget.name)
                    ? srtToVtt(text)
                    : text;
                  const url = URL.createObjectURL(
                    new Blob([vtt], { type: "text/vtt" }),
                  );
                  if (subtitleUrlRef.current)
                    URL.revokeObjectURL(subtitleUrlRef.current);
                  subtitleUrlRef.current = url;
                  setPreview((prev) =>
                    prev && prev.path === subtitleTarget.videoPath
                      ? {
                          ...prev,
                          subtitleSrc: url,
                          subtitleLabel: subtitleLabel(
                            prev.name,
                            subtitleTarget.name,
                          ),
                        }
                      : prev,
                  );
                } catch {
                  /* undecodable subtitle — silently skip */
                }
              }
              break;
            }
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
            const isOriginalLoad = originalLoadPathsRef.current.delete(
              msg.path,
            );
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
              if (fields.src.startsWith("blob:"))
                URL.revokeObjectURL(fields.src);
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
            if (!wasPrefetch)
              prefetchNeighbors(msg.path, previewRef.current?.siblings);
          }
          // Plain (non-preview) download completion is handled by
          // `useDownloadTransfers`; only preview frames reach this handler.
          break;
        }
      }
    },
    [
      send,
      cachePreview,
      prefetchNeighbors,
      setPreview,
      previewRef,
      previewPathRef,
      previewBuffersRef,
      previewMimeRef,
      prefetchPathsRef,
      originalLoadPathsRef,
      subtitleReadsRef,
      subtitleUrlRef,
    ],
  );

  // Look for a sidecar subtitle (`clip.srt` / `clip.en.vtt`) next to an opening
  // video and, if found, read it so the modal can attach it as a WebVTT track.
  // The bytes come back over the normal preview stream and are picked up in the
  // `sftp-download-*` handlers via `subtitleReadsRef`.
  const requestSubtitleFor = useCallback(
    (videoPath: string, name: string) => {
      const list = entriesRef.current;
      const sidecar = findSubtitleSidecar(
        name,
        list.map((e) => e.name),
      );
      if (!sidecar) return;
      const entry = list.find((e) => e.name === sidecar);
      if (!entry || entry.size < 0 || entry.size > SUBTITLE_MAX_BYTES) return;
      const sidecarPath = joinPath(cwdRef.current, sidecar);
      subtitleReadsRef.current.set(sidecarPath, { videoPath, name: sidecar });
      send({
        t: "sftp-read",
        path: sidecarPath,
        preview: true,
        maxBytes: SUBTITLE_MAX_BYTES,
      });
    },
    [send, cwdRef, entriesRef, subtitleReadsRef],
  );

  // Revoke the active subtitle-track blob and drop any pending sidecar reads —
  // called when the preview modal closes.
  const closeSubtitleTrack = useCallback(() => {
    if (subtitleUrlRef.current) {
      URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = null;
    }
    subtitleReadsRef.current.clear();
  }, [subtitleReadsRef, subtitleUrlRef]);

  // Open a file in the preview modal. On a cache hit (a recently-viewed file)
  // it paints instantly from the cached bytes with no re-transfer; otherwise it
  // opens immediately in a loading state (with the cached grid thumbnail as an
  // instant placeholder, if any) and streams the bytes in. `siblings` lets the
  // modal step ←/→ through the other previewable files in the same view.
  const openPreviewFile = useCallback(
    (
      path: string,
      name: string,
      siblings?: { path: string; name: string }[],
    ) => {
      // Video AND audio with a stream token (non-elevated) play over the
      // seekable HTTP endpoint: no whole-file transfer, original quality, and the
      // browser can seek instantly. Elevated sessions keep the blob path (the
      // endpoint reads as the login user, so it can't reach root-only files).
      // A previous preview's subtitle blob is no longer needed.
      if (subtitleUrlRef.current) {
        URL.revokeObjectURL(subtitleUrlRef.current);
        subtitleUrlRef.current = null;
      }
      subtitleReadsRef.current.clear();
      const mediaKind = filePreviewKind(name);
      // A recently-viewed file (image, or a small cached clip) re-opens instantly
      // from the in-memory cache with no re-transfer — this is what makes stepping
      // the gallery away and back snappy. Checked first, before the streaming path,
      // so a cached small video/audio re-opens as a fully-seekable blob.
      // A fresh hit (within TTL) re-opens instantly; the cache drops an expired
      // entry and refreshes/touches a live one for us, returning null on a miss.
      const hit = previewCacheGet(path);
      if (hit) {
        setPreview({
          path,
          name,
          loading: false,
          placeholder: thumbnailsRef.current[path],
          siblings,
          optimized: hit.optimized,
          ...previewFieldsFromBytes(name, hit.bytes, hit.mime),
        });
        if (mediaKind === "video") requestSubtitleFor(path, name);
        prefetchNeighbors(path, siblings);
        return;
      }
      if (
        !elevatedRef.current &&
        streamTokenRef.current &&
        (mediaKind === "video" || mediaKind === "audio")
      ) {
        const token = streamTokenRef.current;
        // A container the browser can't play natively streams as a bridge
        // transcode from the start; a natively-playable one streams raw but keeps
        // the transcode URL as a fallback for when a codec turns out unplayable.
        const needsTranscode =
          mediaKind === "video" && videoNeedsTranscode(name);
        // A small, natively-playable clip is fetched whole and cached (falls
        // through below) so re-opening is instant; everything else streams. The
        // whole-file fetch is bounded by the bridge's download cap so it can never
        // pull more than an ordinary download would.
        const cap = downloadCapRef.current;
        const budget =
          cap > 0
            ? Math.min(MEDIA_CACHE_MAX_BYTES, cap)
            : MEDIA_CACHE_MAX_BYTES;
        const version = entryVersionRef.current.get(path);
        const size = version ? parseInt(version.split(":")[0], 10) : 0;
        // Only whole-cache formats that reliably play from a blob — audio, and the
        // always-native video containers. `.mkv`/`.mov` are codec-dependent, so
        // they keep streaming (which has the transcode fallback on a codec error).
        const reliablyNative =
          mediaKind === "audio" || /\.(mp4|m4v|webm|ogv)$/i.test(name);
        const cacheSmallWhole = reliablyNative && size > 0 && size <= budget;
        if (!cacheSmallWhole) {
          setPreview({
            path,
            name,
            kind: mediaKind,
            src: mediaStreamSrc(token, path, needsTranscode),
            videoFallbackSrc:
              mediaKind === "video" && !needsTranscode
                ? mediaStreamSrc(token, path, true)
                : undefined,
            loading: false,
            // The cached grid thumbnail (video poster frame) shows instantly as
            // the <video> poster while the stream initializes — no black flash.
            placeholder: thumbnailsRef.current[path],
            siblings,
          });
          if (mediaKind === "video") requestSubtitleFor(path, name);
          prefetchNeighbors(path, siblings);
          return;
        }
        // else: fall through to the whole-file read below, which caches the bytes
        // for instant re-open and paints a native blob <video>/<audio>.
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
      // A small video reaching this path is being fetched whole to cache — still
      // attach its sidecar subtitles once it paints as a native blob <video>.
      if (mediaKind === "video") requestSubtitleFor(path, name);
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
    [
      send,
      previewCacheGet,
      prefetchNeighbors,
      requestSubtitleFor,
      setPreview,
      elevatedRef,
      streamTokenRef,
      downloadCapRef,
      entryVersionRef,
      prefetchPathsRef,
      previewBuffersRef,
      subtitleReadsRef,
      subtitleUrlRef,
      thumbnailsRef,
    ],
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
    [send, setPreview, originalLoadPathsRef],
  );

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
    [send, openPreviewFile, previewRef, previewBuffersRef],
  );

  // Drop a file from the open gallery after it was deleted or moved away
  // (called once the bridge acks the op, so a failed op never skips a file).
  // If the removed file is the one on screen, advance to the next remaining
  // sibling — or close the modal when it was the last one. Removing a
  // background sibling just prunes the snapshot so the counter/filmstrip stay
  // accurate.
  const pruneAndStep = useCallback(
    (path: string) => {
      const cur = previewRef.current;
      if (!cur) return;
      const sibs = (cur.siblings ?? []).filter((s) => s.path !== path);
      if (cur.path !== path) {
        setPreview({ ...cur, siblings: sibs });
        return;
      }
      // Stop an in-flight stream for the removed file before leaving it.
      if (cur.loading) {
        send({ t: "sftp-download-cancel", path: cur.path });
        delete previewBuffersRef.current[cur.path];
      }
      if (sibs.length === 0) {
        setPreview(null);
        return;
      }
      const idx = (cur.siblings ?? []).findIndex((s) => s.path === path);
      const target = sibs[Math.min(Math.max(idx, 0), sibs.length - 1)];
      openPreviewFile(target.path, target.name, sibs);
    },
    [send, openPreviewFile, previewRef, previewBuffersRef, setPreview],
  );

  return {
    prefetchNeighbors,
    handleTransferMessage,
    requestSubtitleFor,
    closeSubtitleTrack,
    openPreviewFile,
    loadPreviewOriginal,
    stepPreview,
    pruneAndStep,
  };
}
