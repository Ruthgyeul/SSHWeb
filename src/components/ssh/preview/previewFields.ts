import {
  audioMimeType,
  filePreviewKind,
  imageMimeType,
  isProbablyTextFile,
  sniffMediaKind,
  videoMimeType,
} from "@/lib/sshProtocol";
import type { PreviewMode } from "../FilePreview";
import type { PreviewState } from "./previewState";

/** The preview surface for a filename by extension: a media/PDF/Markdown kind,
 * a read-only `text` view for anything editable-as-text, or `unsupported`. Used
 * for the modal's loading state before bytes arrive (a cache hit / stream then
 * refines it, including magic-byte sniffing for mis-named media). */
export function previewRenderKind(name: string): PreviewMode {
  return (
    filePreviewKind(name) ?? (isProbablyTextFile(name) ? "text" : "unsupported")
  );
}

/** Fields the preview modal needs to render a fully-loaded file, built from its
 * raw bytes. The kind is resolved by extension, then — for a `text`/`unsupported`
 * name — upgraded by sniffing the bytes' magic number, so a mis-named or
 * extensionless media file (a JPEG called `photo`) still previews as media.
 * Markdown/text decode to text (rendered in the modal); media/PDF get a `blob:`
 * URL. Shared by the streamed-in path and a preview-cache hit. */
export function previewFieldsFromBytes(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeOverride?: string,
): Pick<PreviewState, "kind" | "src" | "text" | "bytes" | "encodingWarning"> {
  let kind = previewRenderKind(name);
  if (kind === "text" || kind === "unsupported") {
    const sniffed = sniffMediaKind(bytes);
    if (sniffed) kind = sniffed;
  }
  if (kind === "markdown" || kind === "text") {
    const text = new TextDecoder().decode(bytes);
    // A non-fatal decode substitutes U+FFFD for undecodable bytes; their
    // presence flags a likely non-UTF-8 (legacy-encoded or binary) file.
    return { kind, src: "", text, bytes, encodingWarning: text.includes("�") };
  }
  if (kind === "unsupported") {
    // Not decodable as media and not text — offer download only, no blob.
    return { kind, src: "", bytes };
  }
  // A server-transcoded image preview arrives as WebP regardless of the file's
  // name, so trust the bridge's `mimeOverride` when it sends one.
  const mime =
    mimeOverride ??
    (kind === "pdf"
      ? "application/pdf"
      : ((kind === "video"
          ? videoMimeType(name)
          : kind === "audio"
            ? audioMimeType(name)
            : imageMimeType(name)) ?? "application/octet-stream"));
  // A blob: URL renders large images/video/PDFs far faster than a giant data:
  // URL and lets <video> seek; revoked by the effect that watches preview.src.
  const src = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return { kind, src, bytes };
}
