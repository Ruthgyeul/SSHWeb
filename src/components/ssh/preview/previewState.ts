import type { PreviewMode } from "../FilePreview";

/** Everything the preview modal needs to render one file — its identity, the
 * resolved surface (`kind`), the media/text payload, and the transient
 * loading/progress/gallery bookkeeping. Owned by `SshSession` (the streamed-in
 * download handlers fill it), consumed by `FilePreview`. */
export interface PreviewState {
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
  /** The ORIGINAL image's pixel dimensions (from a transcoded preview's begin
   * frame), so the modal shows the true size and can gate loading a very large
   * original. Undefined for non-image previews or when unknown. */
  originalDims?: { w: number; h: number };
  /** For a video that the browser can't play natively, the `/api/preview`
   * transcode URL to fall back to when native playback errors (or immediately,
   * for a known-unplayable container). Absent for natively-playable media. */
  videoFallbackSrc?: string;
  /** `blob:` URL of a WebVTT subtitle track (converted from a sibling `.srt`/
   * `.vtt`), shown on the `<video>`. Revoked when the preview closes. */
  subtitleSrc?: string;
  /** Short label for the subtitle track (e.g. `EN`, or `Subtitles`). */
  subtitleLabel?: string;
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
