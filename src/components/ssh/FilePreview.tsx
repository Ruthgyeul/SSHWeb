"use client";

import { useMemo } from "react";
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

/**
 * A read-only media preview modal for a remote file. The parent loads the file
 * over SFTP, builds a `data:` URL from the bytes, and hands it in as `src`;
 * this component just displays it centered over the file browser with download
 * and close actions. Images render in an `<img>`, videos (mp4/mov/webm/…) in a
 * `<video controls>`, audio (mp3/wav/…) in an `<audio controls>`. File types the
 * browser can't render inline open in the `unsupported` mode — no bytes are
 * fetched; the modal just offers a download. Rendered as a modal, mirroring
 * {@link FileEditor}.
 *
 * The modal opens immediately in a `loading` state (the file transfers over the
 * bridge whole, which can take a moment), showing a spinner over the cached grid
 * thumbnail `placeholder` when one is available so an image appears instantly.
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
          {!loading && (
            <div
              className="md-preview mx-auto max-w-3xl px-6 py-5"
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto bg-term-bg p-4">
        <div className="relative flex min-h-full items-center justify-center">
          {loading && spinner}
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
                className={cn(
                  "max-h-full max-w-full object-contain transition",
                  // While the full image loads, blur the low-res placeholder.
                  loading && !src && "scale-95 blur-md",
                )}
                style={{
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
