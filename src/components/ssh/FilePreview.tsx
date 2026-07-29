"use client";

/**
 * A read-only image preview modal for a remote file. The parent loads the file
 * over SFTP, builds a `data:` URL from the bytes, and hands it in as `src`;
 * this component just displays it centered over the file browser with download
 * and close actions. Rendered as a modal, mirroring {@link FileEditor}.
 */
export function FilePreview({
  name,
  path,
  src,
  onDownload,
  onClose,
}: {
  name: string;
  path: string;
  src: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-term-card">
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <span className="text-xs text-term-muted" aria-hidden>
          🖼
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
        <div className="flex min-h-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={name}
            className="max-h-full max-w-full object-contain"
            style={{
              // Checkerboard so transparent PNGs stay legible.
              backgroundImage:
                "conic-gradient(#ffffff10 25%, transparent 0 50%, #ffffff10 0 75%, transparent 0)",
              backgroundSize: "16px 16px",
            }}
          />
        </div>
      </div>
    </div>
  );
}
