"use client";

import type { PreviewKind } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";

/** What the preview modal can show: a media kind, or a download-only fallback. */
export type PreviewMode = PreviewKind | "unsupported";

/** Header icon per preview mode. */
const MODE_ICON: Record<PreviewMode, string> = {
  image: "🖼",
  video: "🎞",
  audio: "🎵",
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
  onDownload,
  onClose,
}: {
  name: string;
  path: string;
  /** `blob:` URL for the media element; empty while loading / for `unsupported`. */
  src: string;
  kind: PreviewMode;
  /** True until the file's bytes arrive — show a spinner instead of blank space. */
  loading?: boolean;
  /** Cached grid thumbnail (`data:` URL) painted behind the spinner while loading. */
  placeholder?: string;
  onDownload: () => void;
  onClose: () => void;
}) {
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
      <div className="min-h-0 flex-1 overflow-auto bg-term-bg p-4">
        <div className="relative flex min-h-full items-center justify-center">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <span
                className="h-9 w-9 animate-spin rounded-full border-2 border-term-border border-t-term-accent"
                role="status"
                aria-label="Loading preview"
              />
            </div>
          )}
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
    </div>
  );
}
