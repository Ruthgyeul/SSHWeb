"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  formatSize,
  modeToOctal,
  type PreviewContentKind,
} from "@/lib/sshProtocol";
import { renderMarkdown } from "@/lib/markdown";
import { highlightToHtml } from "@/lib/syntaxHighlight";
import { cn } from "@/lib/utils";
import {
  useImageTransform,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
} from "./hooks/useImageTransform";
import { useTextFind } from "./hooks/useTextFind";
import { usePreviewKeyboard } from "./hooks/usePreviewKeyboard";
import { useModalA11y } from "./hooks/useModalA11y";
import { PreviewMedia } from "./preview/PreviewMedia";
import { PreviewFilmstrip } from "./preview/PreviewFilmstrip";
import { FileIcon, type FileIconKind } from "./FileIcon";
import {
  DownloadIcon,
  InfoIcon,
  MoveIcon,
  PencilIcon,
  RefreshIcon,
  RotateIcon,
  SearchIcon,
  TrashIcon,
  WarningIcon,
  XMarkIcon,
} from "./icons";

/** What the preview modal can show: a content kind, a read-only `text` view
 * (syntax-highlighted, non-editable), or a download-only fallback. */
export type PreviewMode = PreviewContentKind | "text" | "unsupported";

/** Header icon (SVG kind) per preview mode. */
const MODE_ICON_KIND: Record<PreviewMode, FileIconKind> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  markdown: "text",
  text: "text",
  unsupported: "file",
};

/** Pixel count (W×H) above which an image is flagged as very large — decoding
 * one this big can spike memory, so we surface a warning hint next to its dimensions
 * rather than silently risk a tab crash. 60 MP ≈ a 8000×7500 photo. */
const LARGE_IMAGE_PIXELS = 60_000_000;

/** Date + time for the info panel (locale-formatted), or `—` when unknown. */
function formatMtimeFull(mtime?: number): string {
  if (!mtime) return "—";
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A read-only media preview modal for a remote file. The parent streams the file
 * over SFTP, builds a `blob:` URL from the bytes, and hands it in as `src`; this
 * component displays it centered over the file browser with download and close
 * actions. Images render in an `<img>` (with **zoom / pan / rotate** controls),
 * videos (mp4/mov/webm/…) in a `<video controls>`, audio (mp3/wav/…) in an
 * `<audio controls>`. File types the browser can't render inline open in the
 * `unsupported` mode — no bytes are fetched; the modal just offers a download.
 *
 * The modal opens immediately in a `loading` state (the file streams over the
 * bridge, which can take a moment), showing a spinner + a **% progress bar** and
 * a **Cancel** button over the cached grid thumbnail `placeholder` when one is
 * available so an image appears instantly.
 *
 * Keyboard: **Esc** closes; **←/→** step through the gallery of sibling
 * previewable files (when `hasGallery`); for images **+/-** zoom, **0** resets,
 * **r** rotates.
 */
export function FilePreview({
  name,
  path,
  src,
  kind,
  loading = false,
  placeholder,
  text,
  received,
  total,
  streaming = false,
  truncated = false,
  encodingWarning = false,
  optimized = false,
  originalDims,
  loadingOriginal = false,
  onLoadOriginal,
  videoFallbackSrc,
  subtitleSrc,
  subtitleTrackLabel,
  getStartTime,
  onTime,
  hasGallery = false,
  index,
  count,
  filmstrip,
  onJump,
  onPrev,
  onNext,
  onEdit,
  onDelete,
  onMove,
  info,
  onDownload,
  onCancel,
  onClose,
}: {
  name: string;
  path: string;
  /** `blob:` URL for the media/PDF element; empty while loading / for markdown. */
  src: string;
  kind: PreviewMode;
  /** True until the file's bytes arrive — show a spinner instead of blank space. */
  loading?: boolean;
  /** Cached grid thumbnail (`data:` URL) painted behind the spinner while loading. */
  placeholder?: string;
  /** Decoded file text — only used for the `markdown` kind (rendered to HTML). */
  text?: string;
  /** Bytes received so far while streaming — turns the spinner into a % bar. */
  received?: number;
  /** Total transfer size, once the stream has begun. */
  total?: number;
  /** True while a text/markdown preview is still streaming in (content already
   * painting, more bytes arriving) — drives a slim top progress strip. */
  streaming?: boolean;
  /** True when a text preview shows only the head of a larger file. */
  truncated?: boolean;
  /** True when the decoded text looks like it isn't valid UTF-8. */
  encodingWarning?: boolean;
  /** True when the shown image is a downscaled WebP preview, not the original —
   * enables the "load original" affordance (zoom / button) for pixel-perfect detail. */
  optimized?: boolean;
  /** The ORIGINAL image's pixel dimensions (when the shown bytes are a downscaled
   * preview), so the toolbar shows the true size and a very large original is
   * loaded only on an explicit click (not auto-fetched on zoom). */
  originalDims?: { w: number; h: number };
  /** True while the full-resolution original is being fetched to replace the WebP. */
  loadingOriginal?: boolean;
  /** Fetch the full-resolution original to replace an optimized preview (called
   * once on first zoom-in, or via the toolbar button). Omitted when there's no
   * viewable raw original to swap in (e.g. a HEIC preview is always a transcode). */
  onLoadOriginal?: () => void;
  /** For a video the browser can't play natively, an alternate `src` (the bridge
   * transcode) to switch to when the primary source errors. */
  videoFallbackSrc?: string;
  /** `blob:` URL of a WebVTT subtitle track to show on the `<video>`. */
  subtitleSrc?: string;
  /** Label for the subtitle track (e.g. `EN`). */
  subtitleTrackLabel?: string;
  /** Get the playback position (seconds) to resume a video from when it opens.
   * A getter (not a value) so the parent's ref isn't read during render. */
  getStartTime?: () => number;
  /** Report the video's current playback position so the gallery can resume it. */
  onTime?: (seconds: number) => void;
  /** True when there is more than one previewable file to step through (←/→). */
  hasGallery?: boolean;
  /** 0-based position of the current file among its gallery siblings. */
  index?: number;
  /** Total number of previewable siblings (for the "n / N" counter). */
  count?: number;
  /** Sibling files (display order) for the bottom thumbnail filmstrip. */
  filmstrip?: { path: string; name: string; thumb?: string }[];
  /** Jump straight to a sibling by path (filmstrip tile click). */
  onJump?: (path: string) => void;
  /** Step to the previous previewable file in the view. */
  onPrev?: () => void;
  /** Step to the next previewable file in the view. */
  onNext?: () => void;
  onDownload: () => void;
  /** Open this file in the editor (shown for editable text/markdown previews). */
  onEdit?: () => void;
  /** Delete the current file (confirm dialog owned by the parent). */
  onDelete?: () => void;
  /** Move / rename the current file (path-input dialog owned by the parent). */
  onMove?: () => void;
  /** File metadata for the info panel; any field may be absent (e.g. a search
   * hit whose entry isn't in the current listing). */
  info?: { size?: number; mtime?: number; mode?: number };
  /** Abort the in-flight preview transfer (only shown while loading). */
  onCancel?: () => void;
  onClose: () => void;
}) {
  // Markdown is rendered (and sanitised) from the decoded text; skipped for
  // every other kind so this stays cheap.
  const markdownHtml = useMemo(
    () => (kind === "markdown" ? renderMarkdown(text ?? "") : ""),
    [kind, text],
  );
  // Read-only syntax-highlighted HTML for the `text` kind (a quick, non-editing
  // look at code/config/logs). Escaped in `highlightToHtml`, so safe to inject.
  // Skipped while the file is still streaming in — re-highlighting the whole
  // (growing) buffer on every chunk would be wasteful; a cheap escaped plain
  // render is shown instead until the stream completes.
  const codeHtml = useMemo(
    () => (kind === "text" && !streaming ? highlightToHtml(text ?? "") : ""),
    [kind, streaming, text],
  );
  const lineCount = useMemo(
    () => (kind === "text" ? (text ?? "").split("\n").length : 0),
    [kind, text],
  );

  const isImage = kind === "image";
  // Image view transform: zoom, rotation (°), and pan offset (px), plus the
  // wheel/pointer-drag handlers that drive them. The parent remounts this modal
  // on file change (`key={path}`), so these reset to their initial fitted/upright
  // values automatically when stepping the gallery.
  const transform = useImageTransform(isImage);
  // The parent still reads these for the toolbar/keyboard; the pointer/wheel
  // handlers travel to PreviewMedia via the whole `transform` object.
  const { zoom, rotation, offset, zoomBy, resetView, rotate } = transform;
  // Natural pixel dimensions of the loaded image (from `<img onLoad>`), shown as
  // a WxH chip in the toolbar; also drives the very-large-image warning hint.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // The <video> element, for keyboard transport controls & resume position.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Playback speed (applied to the <video>); stepped with [ and ].
  const [rate, setRate] = useState(1);
  // Switch to the bridge-transcode `src` once native playback of this video
  // errors (a codec the browser can't decode). Reset per file (modal is keyed
  // by path). A video whose container is known-unplayable already arrives with
  // its `src` pointed at the transcode, so this only covers the surprise cases.
  const [usingFallback, setUsingFallback] = useState(false);
  const videoSrc = usingFallback && videoFallbackSrc ? videoFallbackSrc : src;
  const setSpeed = useCallback((next: number) => {
    const clamped = Math.min(4, Math.max(0.25, Math.round(next * 100) / 100));
    setRate(clamped);
    if (videoRef.current) videoRef.current.playbackRate = clamped;
  }, []);
  // Keep the element's rate in sync (e.g. after it (re)mounts on a fallback swap).
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, videoSrc]);
  // Fire the "load original" request at most once per open file (the modal is
  // keyed by path, so this resets when stepping the gallery).
  const originalFiredRef = useRef(false);
  // Request the full-resolution original once (idempotent), for zoomed detail.
  const requestOriginal = useCallback(() => {
    if (originalFiredRef.current || !onLoadOriginal) return;
    originalFiredRef.current = true;
    onLoadOriginal();
  }, [onLoadOriginal]);
  // The active filmstrip tile, scrolled into view when the gallery steps.
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [path]);

  // File-info panel toggle (path/size/modified/perms/dimensions) and the
  // narrow-screen overflow menu that holds the mv/delete/info actions.
  const [showInfo, setShowInfo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Close the overflow menu on any outside pointer press.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const isText = kind === "text";
  // Text-preview view options: soft-wrap long lines, and an in-modal find bar
  // (open/query/case + derived matches state owned by `useTextFind`).
  const [wrap, setWrap] = useState(false);
  const {
    open: findOpen,
    setOpen: setFindOpen,
    query: findQuery,
    setQuery: setFindQuery,
    matchCase: findCase,
    toggleCase: toggleFindCase,
    matches,
    activeIdx,
    searchHtml,
    searching,
    step: stepMatch,
  } = useTextFind(text ?? "", isText);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const textPaneRef = useRef<HTMLDivElement | null>(null);
  // Scroll the active match into view as the user steps through results.
  useEffect(() => {
    if (!findOpen || matches.length === 0) return;
    textPaneRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "center" });
  }, [findOpen, activeIdx, matches.length]);

  // A very large original (past LARGE_IMAGE_PIXELS) is NOT auto-fetched on zoom —
  // decoding one can spike memory / crash the tab, so it loads only on an explicit
  // "Original" click. Normal-sized originals still auto-load on zoom-in.
  const originalIsHuge =
    !!originalDims && originalDims.w * originalDims.h > LARGE_IMAGE_PIXELS;

  // Zooming past the fit view on an optimized (downscaled WebP) image pulls the
  // full-resolution original so the zoomed detail is pixel-perfect.
  useEffect(() => {
    if (optimized && isImage && zoom > 1 && !originalIsHuge) requestOriginal();
  }, [optimized, isImage, zoom, originalIsHuge, requestOriginal]);

  // Keyboard: Esc closes, ←/→ walk the gallery, video transport, image
  // transforms, and Ctrl/⌘+F opens the text find bar (see usePreviewKeyboard).
  usePreviewKeyboard({
    kind,
    isImage,
    isText,
    findOpen,
    hasGallery,
    videoRef,
    findInputRef,
    setFindOpen,
    onClose,
    onPrev,
    onNext,
    onDelete,
    onMove,
    zoomBy,
    resetView,
    rotate,
    setSpeed,
  });

  // Focus trap + restore; Escape is owned by usePreviewKeyboard above.
  const dialogRef = useModalA11y<HTMLDivElement>({
    onClose,
    closeOnEscape: false,
  });

  const pct =
    total && total > 0
      ? Math.min(100, Math.round(((received ?? 0) / total) * 100))
      : null;
  const spinner = (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
      <span
        className="h-9 w-9 animate-spin rounded-full border-2 border-term-border border-t-term-accent"
        role="status"
        aria-label="Loading preview"
      />
      {pct !== null && (
        <div className="flex w-44 flex-col items-center gap-1.5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-term-border">
            <div
              className="h-full rounded-full bg-term-accent transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-term-muted">
            {pct}%
          </span>
        </div>
      )}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-term-border px-2.5 py-1 text-[11px] text-term-muted hover:text-term-text"
        >
          Cancel
        </button>
      )}
    </div>
  );

  // Floating ‹ › gallery arrows, shared across kinds.
  const galleryArrows = hasGallery && (
    <>
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous file"
        className="absolute left-2 top-1/2 z-20 -translate-y-1/2 rounded-full border border-term-border bg-term-panel/80 px-3 py-2 text-lg text-term-muted hover:text-term-text"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onNext}
        aria-label="Next file"
        className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-full border border-term-border bg-term-panel/80 px-3 py-2 text-lg text-term-muted hover:text-term-text"
      >
        ›
      </button>
    </>
  );

  const toolBtn =
    "rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-40";
  // Icon-only header button (aria-label / title carry the meaning) so the
  // toolbar stays compact; `gap-1` still lets the overflow-menu variant pair the
  // icon with a text label.
  const headerBtn =
    "flex items-center gap-1 rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text";

  // The mv / delete / info actions, rendered inline (icon-only) on wide screens
  // and folded into the ⋯ overflow menu (icon + label) on narrow ones — both
  // from this single list, so the two never drift. `info` is always present;
  // mv/delete only when wired.
  const actions: {
    key: string;
    label: string;
    icon: ReactNode;
    title: string;
    onClick: () => void;
    danger?: boolean;
    active?: boolean;
  }[] = [
    ...(onMove
      ? [
          {
            key: "move",
            label: "Move / rename",
            icon: <MoveIcon className="h-3.5 w-3.5" />,
            title: "Move / rename (F2)",
            onClick: onMove,
          },
        ]
      : []),
    ...(onDelete
      ? [
          {
            key: "delete",
            label: "Delete",
            icon: <TrashIcon className="h-3.5 w-3.5" />,
            title: "Delete (Del)",
            onClick: onDelete,
            danger: true,
          },
        ]
      : []),
    {
      key: "info",
      label: "File info",
      icon: <InfoIcon className="h-3.5 w-3.5" />,
      title: "File info",
      onClick: () => setShowInfo((v) => !v),
      active: showInfo,
    },
  ];

  // A slim progress strip pinned to the top of a text/markdown pane while its
  // content is still streaming in (the body already paints progressively).
  const streamStrip = streaming && (
    <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-term-border">
      <div
        className="h-full bg-term-accent transition-[width]"
        style={{ width: `${pct ?? 0}%` }}
      />
    </div>
  );

  // Truncated / non-UTF-8 notices for text & markdown previews.
  const banner = (truncated || encodingWarning) && (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-term-border bg-term-panel/60 px-4 py-1.5 text-[11px] text-term-yellow">
      {truncated && (
        <span className="flex items-center gap-1.5">
          <WarningIcon className="h-3.5 w-3.5 flex-none" />
          Showing the first part of a large file — download for the full
          contents.
        </span>
      )}
      {encodingWarning && (
        <span className="flex items-center gap-1.5">
          <WarningIcon className="h-3.5 w-3.5 flex-none" />
          This file may not be UTF-8 — some characters may be garbled.
        </span>
      )}
    </div>
  );

  // In-modal find bar for the text preview (Ctrl/⌘+F).
  const findBar = findOpen && isText && (
    <div className="flex items-center gap-2 border-b border-term-border bg-term-panel/90 px-3 py-1.5">
      <input
        ref={findInputRef}
        value={findQuery}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            stepMatch(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setFindOpen(false);
          }
        }}
        placeholder="Find"
        className="w-44 rounded border border-term-border bg-term-bg px-2 py-0.5 text-xs text-term-text outline-none focus:border-term-accent"
      />
      <span className="min-w-[3rem] text-[11px] tabular-nums text-term-muted">
        {matches.length
          ? `${activeIdx + 1}/${matches.length}`
          : findQuery
            ? "0/0"
            : ""}
      </span>
      <button
        type="button"
        onClick={() => stepMatch(-1)}
        disabled={!matches.length}
        className={toolBtn}
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => stepMatch(1)}
        disabled={!matches.length}
        className={toolBtn}
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={toggleFindCase}
        className={cn(toolBtn, findCase && "text-term-accent")}
        aria-pressed={findCase}
        title="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        onClick={() => setFindOpen(false)}
        className={toolBtn}
        aria-label="Close find"
      >
        ×
      </button>
    </div>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${name}`}
      className="absolute inset-0 z-30 flex flex-col bg-term-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <FileIcon kind={MODE_ICON_KIND[kind]} className="text-term-muted" />

        <span
          className="min-w-0 flex-1 truncate text-xs text-term-dim"
          title={path}
        >
          {name}
        </span>
        {count !== undefined && count > 1 && (
          <span className="shrink-0 text-[11px] tabular-nums text-term-faint">
            {(index ?? 0) + 1} / {count}
          </span>
        )}
        {isImage && !loading && src && (
          <div className="flex flex-wrap items-center gap-1">
            {(() => {
              // Prefer the ORIGINAL's true dimensions (from the bridge) over the
              // downscaled preview's own dimensions, so the read-out reflects the
              // real photo size even while a light WebP is on screen.
              const shown = originalDims ?? dims;
              if (!shown) return null;
              const huge = shown.w * shown.h > LARGE_IMAGE_PIXELS;
              return (
                <span
                  className={cn(
                    "mr-1 inline-flex items-center gap-1 text-[11px] tabular-nums",
                    huge ? "text-term-yellow" : "text-term-faint",
                  )}
                  title={
                    huge
                      ? "Very large image — the full-resolution original loads only on the Original button"
                      : undefined
                  }
                >
                  {huge && <WarningIcon className="h-3 w-3" />}
                  {shown.w}×{shown.h}
                </span>
              );
            })()}
            {onLoadOriginal && (optimized || loadingOriginal) && (
              <button
                type="button"
                onClick={requestOriginal}
                disabled={loadingOriginal}
                className={cn(
                  toolBtn,
                  "mr-1",
                  originalIsHuge && "text-term-yellow",
                )}
                title={
                  originalIsHuge
                    ? "Load the very large full-resolution original (may be slow / memory-heavy)"
                    : "Load the full-resolution original for pixel-perfect zoom"
                }
              >
                {loadingOriginal ? "Original…" : "Original"}
              </button>
            )}
            <button
              type="button"
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              className={toolBtn}
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
            >
              −
            </button>
            <span className="w-10 text-center text-[11px] tabular-nums text-term-muted">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomBy(ZOOM_STEP)}
              className={toolBtn}
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
            >
              +
            </button>
            <button
              type="button"
              onClick={rotate}
              className={cn(toolBtn, "inline-flex items-center")}
              aria-label="Rotate"
            >
              <RotateIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={resetView}
              className={cn(toolBtn, "inline-flex items-center")}
              aria-label="Reset view"
              title="Reset view"
              disabled={
                zoom === 1 && rotation === 0 && offset.x === 0 && offset.y === 0
              }
            >
              <RefreshIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {isText && !loading && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setWrap((w) => !w)}
              className={cn(toolBtn, wrap && "text-term-accent")}
              aria-pressed={wrap}
              title="Toggle line wrap"
            >
              Wrap
            </button>
            <button
              type="button"
              onClick={() => {
                setFindOpen(true);
                requestAnimationFrame(() => findInputRef.current?.focus());
              }}
              className={cn(toolBtn, findOpen && "text-term-accent")}
              aria-label="Find (Ctrl/⌘+F)"
              title="Find (Ctrl/⌘+F)"
            >
              <SearchIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {/* mv / delete / info: icon-only inline on ≥sm, overflow ⋯ menu below sm. */}
        <div className="hidden items-center gap-1 sm:flex">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              className={cn(
                headerBtn,
                a.danger && "hover:text-term-red",
                a.active && "text-term-accent",
              )}
              title={a.title}
              aria-label={a.title}
              aria-pressed={a.active}
            >
              {a.icon}
            </button>
          ))}
        </div>
        <div className="relative sm:hidden" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className={headerBtn}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-40 mt-1 flex min-w-32 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded border border-term-border bg-term-panel shadow-lg"
            >
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    a.onClick();
                    setMenuOpen(false);
                  }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-left text-xs text-term-muted hover:bg-term-card hover:text-term-text",
                    a.danger && "hover:text-term-red",
                    a.active && "text-term-accent",
                  )}
                >
                  {a.icon} {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className={headerBtn}
            title="Edit this file"
            aria-label="Edit this file"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onDownload}
          className={headerBtn}
          title="Download"
          aria-label="Download"
        >
          <DownloadIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className={headerBtn}
          title="Close"
          aria-label="Close"
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {showInfo && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 border-b border-term-border bg-term-panel/60 px-4 py-2 text-[11px] text-term-muted">
          <div className="min-w-0 basis-full sm:basis-auto">
            <dt className="inline text-term-faint">Path </dt>
            <dd className="inline break-all">{path}</dd>
          </div>
          {info?.size !== undefined && (
            <div>
              <dt className="inline text-term-faint">Size </dt>
              <dd className="inline tabular-nums">
                {formatSize(info.size, "file")}
              </dd>
            </div>
          )}
          {info?.mtime !== undefined && (
            <div>
              <dt className="inline text-term-faint">Modified </dt>
              <dd className="inline">{formatMtimeFull(info.mtime)}</dd>
            </div>
          )}
          {info?.mode !== undefined && (
            <div>
              <dt className="inline text-term-faint">Perms </dt>
              <dd className="inline tabular-nums">{modeToOctal(info.mode)}</dd>
            </div>
          )}
          {(originalDims ?? dims) && (
            <div>
              <dt className="inline text-term-faint">Dimensions </dt>
              <dd className="inline tabular-nums">
                {(originalDims ?? dims)!.w}×{(originalDims ?? dims)!.h}
              </dd>
            </div>
          )}
        </dl>
      )}
      {kind === "pdf" ? (
        <div className="relative min-h-0 flex-1 bg-term-bg">
          {loading && spinner}
          {galleryArrows}
          {src && (
            <iframe src={src} title={name} className="h-full w-full border-0" />
          )}
        </div>
      ) : kind === "markdown" ? (
        <>
          {!loading && banner}
          <div className="relative min-h-0 flex-1 overflow-auto bg-term-bg">
            {streamStrip}
            {loading && spinner}
            {galleryArrows}
            {!loading && (
              <div
                className="md-preview mx-auto max-w-3xl px-6 py-5"
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            )}
          </div>
        </>
      ) : kind === "text" ? (
        <>
          {!loading && banner}
          {!loading && findBar}
          <div
            ref={textPaneRef}
            className="relative min-h-0 flex-1 overflow-auto bg-term-bg"
          >
            {streamStrip}
            {loading && spinner}
            {galleryArrows}
            {!loading && (
              <div className="flex min-h-full font-mono text-xs leading-5">
                {!wrap && (
                  <pre
                    aria-hidden
                    className="select-none border-r border-term-border px-3 py-3 text-right text-term-faint"
                  >
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join(
                      "\n",
                    )}
                  </pre>
                )}
                {streaming ? (
                  // While streaming, render cheap escaped plain text (no per-chunk
                  // syntax highlighting); the highlighter runs once the stream ends.
                  <pre
                    className={cn(
                      "flex-1 px-4 py-3 text-term-text",
                      wrap
                        ? "whitespace-pre-wrap break-words"
                        : "overflow-x-auto whitespace-pre",
                    )}
                  >
                    {text ?? ""}
                  </pre>
                ) : (
                  <pre
                    className={cn(
                      "flex-1 px-4 py-3 text-term-text",
                      wrap
                        ? "whitespace-pre-wrap break-words"
                        : "overflow-x-auto whitespace-pre",
                    )}
                    dangerouslySetInnerHTML={{
                      __html: searching ? searchHtml : codeHtml,
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <PreviewMedia
          kind={kind}
          name={name}
          src={src}
          placeholder={placeholder}
          loading={loading}
          spinner={spinner}
          galleryArrows={galleryArrows}
          transform={transform}
          onImageLoad={setDims}
          onDownload={onDownload}
          hasGallery={hasGallery}
          onPrev={onPrev}
          onNext={onNext}
          onClose={onClose}
          videoRef={videoRef}
          video={{
            src: videoSrc,
            rate,
            subtitleSrc,
            subtitleTrackLabel,
            getStartTime,
            onTime,
            onError: () => {
              // A codec the browser can't decode: retry via the bridge
              // transcode (progressive MP4) if we haven't already.
              if (videoFallbackSrc && !usingFallback) setUsingFallback(true);
            },
          }}
        />
      )}
      {filmstrip && filmstrip.length > 1 && (
        <PreviewFilmstrip
          entries={filmstrip}
          activePath={path}
          activeRef={activeThumbRef}
          onJump={onJump}
        />
      )}
    </div>
  );
}
