import {
  isProbablyAudioFile,
  isProbablyImageFile,
  isProbablyVideoFile,
  type FileEntry,
} from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";

/**
 * File-type icons as crisp inline SVGs (stroke-based, `currentColor`) instead of
 * emoji — emoji render inconsistently across platforms/fonts (often as broken
 * boxes or link-like glyphs). Every icon inherits the surrounding text color, so
 * a directory row tinted `text-term-accent` gets an accent folder for free.
 */

/** The visual categories we draw an icon for. */
export type FileIconKind =
  | "folder"
  | "file"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "pdf"
  | "text"
  | "link";

const ARCHIVE_EXTS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "zst",
  "lz", "lzma", "cab", "ar", "iso", "dmg", "war", "jar",
]);

const CODE_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "py", "rb", "go",
  "rs", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "java", "kt", "kts", "swift",
  "php", "sh", "bash", "zsh", "fish", "ps1", "yml", "yaml", "toml", "ini",
  "cfg", "conf", "xml", "html", "htm", "css", "scss", "sass", "less", "sql",
  "lua", "pl", "pm", "r", "dart", "vue", "svelte", "gradle", "make", "mk",
  "dockerfile", "graphql", "gql", "proto", "tf",
]);

const TEXT_EXTS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "log", "csv", "tsv", "rtf",
  "org", "adoc",
]);

/** File extension (lower-cased, no dot), or "" for none. */
function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Resolve the icon category for a file by name (no dir/link context). */
export function iconKindForName(name: string): FileIconKind {
  if (isProbablyVideoFile(name)) return "video";
  if (isProbablyImageFile(name)) return "image";
  if (isProbablyAudioFile(name)) return "audio";
  const e = ext(name);
  if (e === "pdf") return "pdf";
  if (ARCHIVE_EXTS.has(e)) return "archive";
  if (CODE_EXTS.has(e)) return "code";
  if (TEXT_EXTS.has(e)) return "text";
  return "file";
}

/** Resolve the icon category for a directory entry. */
export function iconKindForEntry(entry: FileEntry): FileIconKind {
  if (entry.type === "dir") return "folder";
  if (entry.type === "link") return "link";
  return iconKindForName(entry.name);
}

/** The SVG path/shape children for each icon kind (24×24 viewBox). */
const SHAPES: Record<FileIconKind, React.ReactNode> = {
  folder: (
    <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  text: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h7M8.5 9.5h2" />
    </>
  ),
  pdf: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.6 17.5c1.2-.4 2-1.6 2.6-3.2.5-1.5.7-3 .2-3.5-.6-.6-1.2.2-1 1.4.3 1.7 1.8 3.8 3 4.4.9.5 2 .5 2.6.1" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.5-4.5a2 2 0 0 0-2.8 0L4 20" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="2" />
      <path d="m15.5 10 6-3.2v10.4l-6-3.2z" />
    </>
  ),
  audio: (
    <>
      <path d="M9 17V5l11-2v12" />
      <circle cx="6" cy="17" r="3" />
      <circle cx="17" cy="15" r="3" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="3" width="18" height="5" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10.5 12h3M10.5 15h3" />
    </>
  ),
  code: (
    <>
      <path d="m9 8-5 4 5 4" />
      <path d="m15 8 5 4-5 4" />
    </>
  ),
  link: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
      <path d="M14 3v5h5" />
      <path d="M9 15h5m0 0-2-2m2 2-2 2" />
    </>
  ),
};

/**
 * Render a file-type icon. Pass an `entry` (kind is derived) or an explicit
 * `kind`. Size/color via `className` (defaults to `h-4 w-4`, inheriting
 * `currentColor`).
 */
export function FileIcon({
  entry,
  kind,
  className,
}: {
  entry?: FileEntry;
  kind?: FileIconKind;
  className?: string;
}) {
  const resolved: FileIconKind = kind ?? (entry ? iconKindForEntry(entry) : "file");
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-4 w-4 shrink-0", className)}
      aria-hidden
    >
      {SHAPES[resolved]}
    </svg>
  );
}
