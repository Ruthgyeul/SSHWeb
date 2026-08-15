import type { ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";
import { FileIcon } from "../FileIcon";
import { DownloadIcon } from "../icons";
import { type ImageTransform, ZOOM_STEP } from "../hooks/useImageTransform";

/** The `<video>`-specific inputs, grouped to keep the media prop surface small. */
export interface PreviewVideoProps {
  /** The source to play (already resolved to the transcode fallback if needed). */
  src: string;
  /** Current playback speed (shown as a badge when ≠ 1). */
  rate: number;
  /** WebVTT subtitle track source + label, when a sidecar was found. */
  subtitleSrc?: string;
  subtitleTrackLabel?: string;
  /** Resume position getter (seconds) applied on metadata load. */
  getStartTime?: () => number;
  /** Report the current position so the gallery can resume it. */
  onTime?: (seconds: number) => void;
  /** Called when native playback errors (swap to the bridge transcode). */
  onError: () => void;
}

/**
 * The media pane of the preview modal: image (with zoom/pan/rotate), video,
 * audio, and the download-only `unsupported` fallback. Extracted from
 * `FilePreview` so each preview surface is its own component.
 *
 * The image transform lives in `useImageTransform` (owned by the parent, since
 * the modal's keyboard shortcuts also drive it) and is threaded through whole as
 * `transform`; the shared chrome (loading spinner, gallery arrows) is composed
 * by the parent and passed in as nodes.
 */
export function PreviewMedia({
  kind,
  name,
  src,
  placeholder,
  loading,
  spinner,
  galleryArrows,
  transform,
  onImageLoad,
  onDownload,
  videoRef,
  video,
}: {
  kind: "image" | "video" | "audio" | "unsupported";
  name: string;
  src: string;
  placeholder?: string;
  loading: boolean;
  spinner: ReactNode;
  galleryArrows: ReactNode;
  transform: ImageTransform;
  /** Record the loaded image's natural dimensions (full image only, not the placeholder). */
  onImageLoad: (dims: { w: number; h: number }) => void;
  onDownload: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  video: PreviewVideoProps;
}) {
  const { zoom, rotation, offset, dragging, zoomBy, resetView } = transform;
  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-term-bg"
      onWheel={transform.onWheel}
    >
      <div className="absolute inset-0 flex items-center justify-center p-4">
        {loading && spinner}
        {galleryArrows}
        {kind === "video" ? (
          video.src ? (
            <>
              {video.rate !== 1 && (
                <span className="absolute right-3 top-3 z-20 rounded bg-term-panel/80 px-1.5 py-0.5 text-[11px] tabular-nums text-term-muted">
                  {video.rate}×
                </span>
              )}
              <video
                ref={videoRef}
                src={video.src}
                controls
                playsInline
                // Only fetch enough to show the first frame + duration until the
                // user hits play — a range-streamed clip then pulls ranges on
                // demand instead of buffering ahead.
                preload="metadata"
                // The cached grid poster frame shows instantly (no black flash)
                // while the stream initializes.
                poster={placeholder}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  v.playbackRate = video.rate;
                  // Resume from the last position (if within the clip).
                  const start = video.getStartTime?.() ?? 0;
                  if (start > 0 && start < v.duration) {
                    v.currentTime = start;
                  }
                }}
                onError={video.onError}
                onTimeUpdate={(e) =>
                  video.onTime?.(e.currentTarget.currentTime)
                }
                className="max-h-full max-w-full"
              >
                {video.subtitleSrc && (
                  <track
                    default
                    kind="subtitles"
                    src={video.subtitleSrc}
                    label={video.subtitleTrackLabel ?? "Subtitles"}
                  />
                )}
                Your browser cannot play this video.
              </video>
            </>
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
                  onImageLoad({ w: el.naturalWidth, h: el.naturalHeight });
                }
              }}
              onDoubleClick={() =>
                zoom > 1 ? resetView() : zoomBy(ZOOM_STEP * 1.5)
              }
              onPointerDown={transform.onPointerDown}
              onPointerMove={transform.onPointerMove}
              onPointerUp={transform.endDrag}
              onPointerCancel={transform.endDrag}
              className={cn(
                "max-h-full max-w-full object-contain",
                loading && !src && "blur-md", // blur the low-res placeholder
                zoom > 1
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-zoom-in",
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
            <FileIcon kind="file" className="h-12 w-12 opacity-60" />
            <p className="text-sm">This file type can’t be previewed inline.</p>
            <button
              type="button"
              onClick={onDownload}
              className="flex items-center gap-1.5 rounded border border-term-accent/40 bg-term-accent/10 px-3 py-1.5 text-xs text-term-accent hover:bg-term-accent/20"
            >
              <DownloadIcon className="h-3.5 w-3.5" /> Download to open it
              locally
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
