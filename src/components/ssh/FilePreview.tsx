"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewContentKind } from "@/lib/sshProtocol";
import { renderMarkdown } from "@/lib/markdown";
import { highlightToHtml } from "@/lib/syntaxHighlight";
import { findMatches, type Match } from "@/lib/editorSearch";
import { cn } from "@/lib/utils";

/** Escape HTML-significant characters so file text is injected as literal text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render `text` as escaped HTML with each search match wrapped in a `<mark>`;
 * the active match is tagged `data-active` (for scroll-into-view) and styled
 * distinctly. Used by the text preview's find bar in place of the syntax
 * highlighter while a search is active. */
function buildSearchHtml(text: string, matches: Match[], active: number): string {
  if (matches.length === 0) return escapeHtml(text);
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += escapeHtml(text.slice(last, m.start));
    const cls =
      i === active
        ? "bg-term-accent text-term-bg"
        : "bg-term-accent/30 text-term-text";
    out += `<mark class="${cls}"${i === active ? ' data-active="true"' : ""}>`;
    out += escapeHtml(text.slice(m.start, m.end));
    out += "</mark>";
    last = m.end;
  });
  out += escapeHtml(text.slice(last));
  return out;
}

/** What the preview modal can show: a content kind, a read-only `text` view
 * (syntax-highlighted, non-editable), or a download-only fallback. */
export type PreviewMode = PreviewContentKind | "text" | "unsupported";

/** Header icon per preview mode. */
const MODE_ICON: Record<PreviewMode, string> = {
  image: "🖼",
  video: "🎞",
  audio: "🎵",
  pdf: "📕",
  markdown: "📝",
  text: "🗒",
  unsupported: "📄",
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;

/** Pixel count (W×H) above which an image is flagged as very large — decoding
 * one this big can spike memory, so we surface a ⚠ hint next to its dimensions
 * rather than silently risk a tab crash. 60 MP ≈ a 8000×7500 photo. */
const LARGE_IMAGE_PIXELS = 60_000_000;

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
  truncated = false,
  encodingWarning = false,
  hasGallery = false,
  index,
  count,
  filmstrip,
  onJump,
  onPrev,
  onNext,
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
  /** True when a text preview shows only the head of a larger file. */
  truncated?: boolean;
  /** True when the decoded text looks like it isn't valid UTF-8. */
  encodingWarning?: boolean;
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
  const codeHtml = useMemo(
    () => (kind === "text" ? highlightToHtml(text ?? "") : ""),
    [kind, text],
  );
  const lineCount = useMemo(
    () => (kind === "text" ? (text ?? "").split("\n").length : 0),
    [kind, text],
  );

  // Image view transform: zoom, rotation (°), and pan offset (px). The parent
  // remounts this modal on file change (`key={path}`), so these reset to their
  // initial fitted/upright values automatically when stepping the gallery.
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  // Mirror of "is a pan drag active" for render (the ref itself can't be read
  // during render) — used to drop the CSS transition so panning tracks 1:1.
  const [dragging, setDragging] = useState(false);
  // Natural pixel dimensions of the loaded image (from `<img onLoad>`), shown as
  // a WxH chip in the toolbar; also drives the very-large-image ⚠ hint.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // The active filmstrip tile, scrolled into view when the gallery steps.
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [path]);

  // Text-preview view options: soft-wrap long lines, and an in-modal find bar.
  const [wrap, setWrap] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findActive, setFindActive] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const textPaneRef = useRef<HTMLDivElement | null>(null);

  const isText = kind === "text";
  // Matches for the find bar (only while it's open with a query).
  const matches = useMemo<Match[]>(
    () =>
      isText && findOpen && findQuery
        ? findMatches(text ?? "", findQuery, findCase)
        : [],
    [isText, findOpen, findQuery, findCase, text],
  );
  // Clamp the active index whenever the match set changes.
  const activeIdx = matches.length ? findActive % matches.length : 0;
  // Escaped text with matches marked, used in place of syntax highlighting while
  // searching so the highlight can be layered on and stepped through.
  const searchHtml = useMemo(
    () =>
      isText && findOpen && findQuery
        ? buildSearchHtml(text ?? "", matches, activeIdx)
        : "",
    [isText, findOpen, findQuery, text, matches, activeIdx],
  );
  // Scroll the active match into view as the user steps through results.
  useEffect(() => {
    if (!findOpen || matches.length === 0) return;
    textPaneRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "center" });
  }, [findOpen, activeIdx, matches.length]);

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      setFindActive((a) => {
        const n = matches.length;
        if (n === 0) return 0;
        return (a + dir + n) % n;
      });
    },
    [matches.length],
  );

  const isImage = kind === "image";
  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next <= 1) setOffset({ x: 0, y: 0 }); // recenter when back to fit
      return next;
    });
  }, []);
  const resetView = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  // Keyboard: Esc closes, ←/→ walk the gallery, image transforms, and Ctrl/⌘+F
  // opens the text find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      // Ctrl/⌘+F opens (and focuses) the find bar for a text preview.
      if (isText && (e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Esc dismisses the find bar first, only then the whole modal.
        if (findOpen) {
          setFindOpen(false);
          return;
        }
        onClose();
        return;
      }
      // While typing in the find input, leave the rest of the keys to it.
      if (typing) return;
      // Let a focused <video>/<audio> keep its own arrow-key seeking; gallery
      // stepping for those is still available via the on-screen ‹ › buttons.
      const mediaFocused =
        kind === "video" || kind === "audio";
      if (!mediaFocused && hasGallery && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        (e.key === "ArrowLeft" ? onPrev : onNext)?.();
        return;
      }
      if (!isImage) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        resetView();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        rotate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, isImage, isText, findOpen, hasGallery, onPrev, onNext, onClose, zoomBy, resetView, rotate]);

  const onWheel = (e: React.WheelEvent) => {
    if (!isImage) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!isImage || zoom <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

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
          <span className="text-[11px] tabular-nums text-term-muted">{pct}%</span>
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

  // Truncated / non-UTF-8 notices for text & markdown previews.
  const banner = (truncated || encodingWarning) && (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-term-border bg-term-panel/60 px-4 py-1.5 text-[11px] text-term-yellow">
      {truncated && (
        <span>⚠ Showing the first part of a large file — download for the full contents.</span>
      )}
      {encodingWarning && (
        <span>⚠ This file may not be UTF-8 — some characters may be garbled.</span>
      )}
    </div>
  );

  // In-modal find bar for the text preview (Ctrl/⌘+F).
  const findBar = findOpen && isText && (
    <div className="flex items-center gap-2 border-b border-term-border bg-term-panel/90 px-3 py-1.5">
      <input
        ref={findInputRef}
        value={findQuery}
        onChange={(e) => {
          setFindQuery(e.target.value);
          setFindActive(0);
        }}
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
        onClick={() => setFindCase((c) => !c)}
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
    <div className="absolute inset-0 z-30 flex flex-col bg-term-card">
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <span className="text-xs text-term-muted" aria-hidden>
          {MODE_ICON[kind]}
        </span>
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
          <div className="flex items-center gap-1">
            {dims && (
              <span
                className={cn(
                  "mr-1 text-[11px] tabular-nums",
                  dims.w * dims.h > LARGE_IMAGE_PIXELS
                    ? "text-term-yellow"
                    : "text-term-faint",
                )}
                title={
                  dims.w * dims.h > LARGE_IMAGE_PIXELS
                    ? "Very large image — may be slow to render"
                    : undefined
                }
              >
                {dims.w * dims.h > LARGE_IMAGE_PIXELS && "⚠ "}
                {dims.w}×{dims.h}
              </span>
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
              className={toolBtn}
              aria-label="Rotate"
            >
              ⟳
            </button>
            <button
              type="button"
              onClick={resetView}
              className={toolBtn}
              aria-label="Reset view"
              disabled={zoom === 1 && rotation === 0 && offset.x === 0 && offset.y === 0}
            >
              Reset
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
              🔎
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onDownload}
          className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
        >
          ↓ Download
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
        >
          Close
        </button>
      </div>
      {kind === "pdf" ? (
        <div className="relative min-h-0 flex-1 bg-term-bg">
          {loading && spinner}
          {galleryArrows}
          {src && (
            <iframe
              src={src}
              title={name}
              className="h-full w-full border-0"
            />
          )}
        </div>
      ) : kind === "markdown" ? (
        <>
          {!loading && banner}
          <div className="relative min-h-0 flex-1 overflow-auto bg-term-bg">
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
            {loading && spinner}
            {galleryArrows}
            {!loading && (
              <div className="flex min-h-full font-mono text-xs leading-5">
                {!wrap && (
                  <pre
                    aria-hidden
                    className="select-none border-r border-term-border px-3 py-3 text-right text-term-faint"
                  >
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                  </pre>
                )}
                <pre
                  className={cn(
                    "flex-1 px-4 py-3 text-term-text",
                    wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto whitespace-pre",
                  )}
                  dangerouslySetInnerHTML={{
                    __html: findOpen && findQuery ? searchHtml : codeHtml,
                  }}
                />
              </div>
            )}
          </div>
        </>
      ) : (
      <div
        className="min-h-0 flex-1 overflow-hidden bg-term-bg p-4"
        onWheel={onWheel}
      >
        <div className="relative flex min-h-full items-center justify-center">
          {loading && spinner}
          {galleryArrows}
          {kind === "video" ? (
            src ? (
              <video
                src={src}
                controls
                playsInline
                className="max-h-full max-w-full"
              >
                Your browser cannot play this video.
              </video>
            ) : null
          ) : kind === "audio" ? (
            src ? (
              <audio src={src} controls className="w-full max-w-md">
                Your browser cannot play this audio.
              </audio>
            ) : null
          ) : kind === "image" ? (
            src || placeholder ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src || placeholder}
                alt={name}
                draggable={false}
                onLoad={(e) => {
                  // Only record real dimensions from the full image, not the
                  // low-res placeholder painted while loading.
                  if (!src) return;
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    setDims({ w: el.naturalWidth, h: el.naturalHeight });
                  }
                }}
                onDoubleClick={() => (zoom > 1 ? resetView() : zoomBy(ZOOM_STEP * 1.5))}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={cn(
                  "max-h-full max-w-full object-contain",
                  loading && !src && "blur-md", // blur the low-res placeholder
                  zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
                  !dragging && "transition-transform",
                )}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${
                    loading && !src ? 0.95 : zoom
                  }) rotate(${rotation}deg)`,
                  // Honour the JPEG's embedded EXIF orientation so phone photos
                  // that record a rotation flag show upright, not sideways.
                  imageOrientation: "from-image",
                  // Checkerboard so transparent PNGs stay legible.
                  backgroundImage:
                    "conic-gradient(#ffffff10 25%, transparent 0 50%, #ffffff10 0 75%, transparent 0)",
                  backgroundSize: "16px 16px",
                }}
              />
            ) : null
          ) : (
            <div className="flex flex-col items-center gap-3 text-center text-term-muted">
              <span className="text-4xl opacity-60" aria-hidden>
                📄
              </span>
              <p className="text-sm">This file type can’t be previewed inline.</p>
              <button
                type="button"
                onClick={onDownload}
                className="rounded border border-term-accent/40 bg-term-accent/10 px-3 py-1.5 text-xs text-term-accent hover:bg-term-accent/20"
              >
                ↓ Download to open it locally
              </button>
            </div>
          )}
        </div>
      </div>
      )}
      {filmstrip && filmstrip.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-term-border bg-term-panel/90 px-3 py-2">
          {filmstrip.map((f) => {
            const activeTile = f.path === path;
            return (
              <button
                key={f.path}
                ref={activeTile ? activeThumbRef : undefined}
                type="button"
                onClick={() => onJump?.(f.path)}
                title={f.name}
                aria-current={activeTile}
                className={cn(
                  "h-12 w-12 shrink-0 overflow-hidden rounded border",
                  activeTile
                    ? "border-term-accent"
                    : "border-term-border opacity-60 hover:opacity-100",
                )}
              >
                {f.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.thumb}
                    alt={f.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-sm text-term-muted">
                    📄
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
