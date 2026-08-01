"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PreviewContentKind } from "@/lib/sshProtocol";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/** What the preview modal can show: a content kind, or a download-only fallback. */
export type PreviewMode = PreviewContentKind | "unsupported";

/** Header icon per preview mode. */
const MODE_ICON: Record<PreviewMode, string> = {
  image: "🖼",
  video: "🎞",
  audio: "🎵",
  pdf: "📕",
  markdown: "📝",
  unsupported: "📄",
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;

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
  hasGallery = false,
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
  /** True when there is more than one previewable file to step through (←/→). */
  hasGallery?: boolean;
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

  // Keyboard: Esc closes, ←/→ walk the gallery, and image transform shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
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
  }, [kind, isImage, hasGallery, onPrev, onNext, onClose, zoomBy, resetView, rotate]);

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
        {isImage && !loading && src && (
          <div className="flex items-center gap-1">
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
    </div>
  );
}
