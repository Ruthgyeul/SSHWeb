"use client";

import { useEffect, useRef, useState } from "react";
import {
  filePreviewKind,
  filterEntries,
  formatMode,
  formatSize,
  isProbablyAudioFile,
  isProbablyImageFile,
  isProbablyTextFile,
  isProbablyVideoFile,
  isThumbnailable,
  parentPath,
  pathSegments,
  previewKind,
  sortEntriesBy,
  summarizeUploads,
  type FileEntry,
  type FindEntry,
  type GrepEntry,
  type PreviewKind,
  type SortKey,
} from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import { collectDroppedFiles, droppedEntries } from "./dropUpload";
import { useFileViewMode } from "./useFileViewMode";
import { useFileSort } from "./useFileSort";

/** One in-flight upload's progress, shown in the progress panel. */
export interface UploadItem {
  /** Remote destination path — the handle for cancel/resume. */
  path: string;
  name: string;
  sent: number;
  total: number;
  /** "queued" while it waits behind the concurrency limit, "uploading" while it
   * streams, "interrupted" when a dropped connection paused it (offers Resume). */
  status?: "uploading" | "interrupted" | "queued";
}

/** One in-flight download's progress, shown in the progress panel. */
export interface DownloadItem {
  /** Remote source path — the handle for cancel. */
  path: string;
  name: string;
  received: number;
  total: number;
}

/** Which axis a recursive search runs on: file *names* or file *contents*. */
export type SearchMode = "name" | "content";

/** An active recursive-search: the query, its axis, in-flight/result state, and
 * hits. Content-mode hits are `GrepEntry` (they carry a line + preview). */
export interface SearchState {
  query: string;
  mode: SearchMode;
  loading: boolean;
  results: (FindEntry | GrepEntry)[];
  truncated: boolean;
}

/** Type guard: a content-search hit (carries a matching line + preview). */
function isGrepHit(entry: FindEntry | GrepEntry): entry is GrepEntry {
  return "preview" in entry;
}

const actionBtn =
  "rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors";

/** DataTransfer type carrying an in-app dragged entry's absolute path (move). */
const DRAG_TYPE = "application/x-sshweb-path";

/** Shared empty set for a listing with no active selection (stable identity). */
const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** Short human-readable modified date for a listing row (blank for unknown). */
function formatMtime(mtime: number): string {
  if (!mtime) return "—";
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Grid-view sort options, in the order they appear in the sort menu. */
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "mtime", label: "Modified" },
];

/** A clickable list-view column header that sorts on `col` (▲/▼ when active). */
function SortHeader({
  label,
  col,
  activeKey,
  dir,
  onSort,
  align = "left",
  className,
}: {
  label: string;
  col: SortKey;
  activeKey: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = activeKey === col;
  return (
    <th
      className={cn(
        "px-2 py-1.5 font-medium",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-label={`Sort by ${label.toLowerCase()}`}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-term-text",
          active ? "text-term-accent" : "text-term-muted",
        )}
      >
        <span>{label}</span>
        {active && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

/** The emoji stand-in for an entry, by type (shared by both list and grid). */
function fileIcon(entry: FileEntry): string {
  if (entry.type === "dir") return "📁";
  if (entry.type === "link") return "🔗";
  if (isProbablyVideoFile(entry.name)) return "🎞";
  if (isProbablyImageFile(entry.name)) return "🖼";
  if (isProbablyAudioFile(entry.name)) return "🎵";
  return "📄";
}

/**
 * A grid-tile thumbnail: shows the file-type icon until the tile scrolls into
 * view, then lazily requests the media (once) and swaps in the returned WebP
 * `data:` URL as an `<img>` — the bridge always downscales both photos and
 * video poster frames to WebP, so a tile is always a small image (a ▶ badge
 * marks video tiles). Non-media / oversized entries just keep showing `fallback`.
 */
function Thumbnail({
  path,
  src,
  kind,
  thumbnailable,
  fallback,
  onRequest,
}: {
  path: string;
  src: string | undefined;
  kind: PreviewKind | null;
  thumbnailable: boolean;
  fallback: string;
  onRequest: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thumbnailable || src) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onRequest(path);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [path, src, thumbnailable, onRequest]);

  // The bridge always downscales a thumbnail — a photo or a video poster frame —
  // to a small WebP, so a tile is always an <img> (never a full <video> clip).
  return (
    <div
      ref={ref}
      className="relative flex h-24 w-full items-center justify-center overflow-hidden rounded bg-term-panel/50 text-4xl"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote data: URL
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span aria-hidden>{fallback}</span>
      )}
      {src && kind === "video" && (
        <span
          className="pointer-events-none absolute text-2xl drop-shadow"
          aria-hidden
        >
          ▶
        </span>
      )}
    </div>
  );
}

/**
 * SFTP file browser over the live SSH session. Fully controlled by the parent:
 * `entries`/`cwd`/`uploads` are supplied and every action (navigate, download,
 * upload, delete, mkdir, rename, chmod, edit, folder-download, refresh) is
 * delegated upward, so all traffic flows through the parent's WebSocket.
 * Supports drag-and-drop upload onto the listing.
 */
export function FileBrowser({
  cwd,
  entries,
  loading,
  uploads,
  downloads,
  onCancelUpload,
  onCancelAllUploads,
  onResumeUpload,
  onCancelDownload,
  canElevate,
  elevated,
  elevatedPending,
  onToggleElevated,
  onNavigate,
  onDownload,
  onDownloadDir,
  onDownloadMany,
  onDelete,
  onDeleteMany,
  onUpload,
  onMkdir,
  onTouch,
  onRename,
  onCopy,
  onMove,
  onChmod,
  onEdit,
  onPreview,
  onOpenUnsupported,
  onRefresh,
  thumbnails,
  onRequestThumbnail,
  search,
  onSearch,
  onClearSearch,
}: {
  cwd: string;
  entries: FileEntry[];
  loading: boolean;
  uploads: UploadItem[];
  downloads: DownloadItem[];
  /** Abort an in-flight or interrupted upload (removes its partial remotely). */
  onCancelUpload: (path: string) => void;
  /** Abort every queued/active/interrupted upload at once ("Cancel all"). */
  onCancelAllUploads: () => void;
  /** Resume an upload paused by a dropped connection. */
  onResumeUpload: (path: string) => void;
  /** Abort an in-flight download. */
  onCancelDownload: (path: string) => void;
  /** Whether the server permits elevated (sudo) file access at all. */
  canElevate: boolean;
  /** Whether elevated (root) mode is currently active. */
  elevated: boolean;
  /** Whether an elevate/de-elevate request is in flight. */
  elevatedPending: boolean;
  onToggleElevated: () => void;
  onNavigate: (path: string) => void;
  onDownload: (path: string) => void;
  onDownloadDir: (path: string) => void;
  onDownloadMany: (paths: string[]) => void;
  onDelete: (entry: FileEntry) => void;
  onDeleteMany: (entries: FileEntry[]) => void;
  onUpload: (file: File, relPath?: string) => void;
  onMkdir: () => void;
  onTouch: () => void;
  onRename: (entry: FileEntry) => void;
  /** Duplicate an entry in the current directory (copy with a new name). */
  onCopy: (entry: FileEntry) => void;
  /** Move an entry (absolute `fromPath`) into directory `toDir` (drag-drop). */
  onMove: (fromPath: string, toDir: string) => void;
  onChmod: (entry: FileEntry) => void;
  onEdit: (path: string, name: string, size: number) => void;
  onPreview: (path: string, name: string) => void;
  /** Open a file the browser can't render inline — a download-only modal (no
   * auto-download; the user chooses to download from there). */
  onOpenUnsupported: (path: string, name: string) => void;
  onRefresh: () => void;
  /** Cached grid thumbnails, keyed by remote path → `data:` URL. */
  thumbnails: Record<string, string>;
  /** Ask the parent to fetch a thumbnail for `path` (deduped upstream). */
  onRequestThumbnail: (path: string) => void;
  /** Active recursive search, or null when browsing the normal listing. */
  search: SearchState | null;
  /** Run a recursive search of the current directory for `query` — by file name
   * or by file contents (grep), per `mode`. */
  onSearch: (query: string, mode: SearchMode) => void;
  /** Exit search mode and return to the normal listing. */
  onClearSearch: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Absolute path of the folder currently under an in-app move drag (highlight).
  const [dropDir, setDropDir] = useState<string | null>(null);
  // Recursive-search bar: local input text + whether the bar is shown. Results
  // (and the loading state) come from the `search` prop, driven by the bridge.
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  // Search axis: match file names, or grep file contents.
  const [searchMode, setSearchMode] = useState<SearchMode>("name");
  // List vs. grid (thumbnail) layout, persisted across sessions/tabs.
  const [viewMode, setViewMode] = useFileViewMode();
  // Sort field + direction, persisted across sessions/tabs. `toggleSort` flips
  // direction on the active field or switches field at its natural default.
  const [sort, toggleSort] = useFileSort();

  // `webkitdirectory` isn't a typed React attribute; set it on the folder input
  // imperatively so clicking "↑ folder" opens a directory picker.
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
  }, []);
  // Checked entries, tagged with the directory they belong to. Tagging by `cwd`
  // means the selection derives to empty on navigation (no effect needed), and
  // stale names left after a refresh are naturally ignored because every read
  // below intersects with the current listing.
  const [selection, setSelection] = useState<{ cwd: string; names: Set<string> }>(
    { cwd, names: new Set() },
  );
  // In-CWD name filter, tagged with the directory it applies to. Tagging by
  // `cwd` makes it derive back to empty on navigation (no effect needed), the
  // same trick the selection above uses.
  const [filterState, setFilterState] = useState({ cwd, value: "" });
  const filter = filterState.cwd === cwd ? filterState.value : "";
  const setFilter = (value: string) => setFilterState({ cwd, value });

  const sorted = sortEntriesBy(entries, sort.key, sort.dir);
  const sortArrow = sort.dir === "asc" ? "▲" : "▼";
  // The rows actually shown: `sorted` narrowed by the filter box. Selection is
  // kept against the full listing (below) so filtering never drops checks.
  const visible = filterEntries(sorted, filter);
  const filtering = filter.trim() !== "";
  const atRoot = cwd === "/";
  const segments = pathSegments(cwd);
  const pathFor = (name: string) => `${cwd.replace(/\/$/, "")}/${name}`;
  // Display an absolute search-hit path relative to the search root (cwd).
  const relTo = (path: string) => {
    const b = cwd.replace(/\/$/, "");
    if (path === b) return path;
    return path.startsWith(`${b}/`) ? path.slice(b.length + 1) : path;
  };
  // Open a search hit by type, mirroring the listing's click-to-open behaviour.
  const openResult = (r: FindEntry) => {
    if (r.type === "dir") onNavigate(r.path);
    else if (filePreviewKind(r.name) !== null) onPreview(r.path, r.name);
    else if (isProbablyTextFile(r.name)) onEdit(r.path, r.name, r.size);
    else onOpenUnsupported(r.path, r.name);
  };
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchInput, searchMode);
  };
  const closeSearch = () => {
    setShowSearch(false);
    setSearchInput("");
    onClearSearch();
  };

  // --- In-app drag-to-move (drag a row/tile onto a folder) ---
  const isInternalDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DRAG_TYPE);
  const onEntryDragStart = (e: React.DragEvent, path: string) => {
    e.dataTransfer.setData(DRAG_TYPE, path);
    e.dataTransfer.effectAllowed = "move";
  };
  const onFolderDragOver = (e: React.DragEvent, folderPath: string) => {
    if (!isInternalDrag(e)) return; // OS file drag → let the container upload it
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dropDir !== folderPath) setDropDir(folderPath);
  };
  const onFolderDrop = (e: React.DragEvent, folderPath: string) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropDir(null);
    const from = e.dataTransfer.getData(DRAG_TYPE);
    if (from) onMove(from, folderPath);
  };

  const selNames = selection.cwd === cwd ? selection.names : EMPTY_NAMES;
  const isSelected = (name: string) => selNames.has(name);
  const selectedEntries = sorted.filter((e) => selNames.has(e.name));
  const selectedCount = selectedEntries.length;
  // Select-all acts on the visible rows: "all selected" means every visible
  // row is checked, and toggling adds/removes only the visible set (any checks
  // on rows hidden by the filter are preserved).
  const allSelected =
    visible.length > 0 && visible.every((e) => selNames.has(e.name));
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleOne = (name: string) =>
    setSelection((prev) => {
      const next = new Set(prev.cwd === cwd ? prev.names : []);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { cwd, names: next };
    });
  const toggleAll = () =>
    setSelection((prev) => {
      const next = new Set(prev.cwd === cwd ? prev.names : []);
      if (allSelected) for (const e of visible) next.delete(e.name);
      else for (const e of visible) next.add(e.name);
      return { cwd, names: next };
    });
  const clearSelection = () => setSelection({ cwd, names: new Set() });

  async function handleDrop(e: React.DragEvent) {
    // An in-app move drop that missed a folder target lands here — ignore it
    // (nothing to upload); a folder's own handler does the actual move.
    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
      e.preventDefault();
      setDragging(false);
      setDropDir(null);
      return;
    }
    e.preventDefault();
    setDragging(false);
    // Capture entries synchronously — the DataTransferItemList is emptied once
    // the event handler returns, so grab the FileSystemEntry refs before any
    // await. When the entry API is available it handles dropped folders too.
    const entries = droppedEntries(e.dataTransfer.items);

    if (entries.length > 0) {
      const collected = await collectDroppedFiles(entries);
      for (const { file, relPath } of collected) {
        onUpload(file, relPath.includes("/") ? relPath : undefined);
      }
      return;
    }
    // Fallback for browsers without the entry API: flat file list only.
    for (const file of Array.from(e.dataTransfer.files)) onUpload(file);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: path + actions */}
      <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-3 py-2">
        <button
          type="button"
          onClick={() => onNavigate(parentPath(cwd))}
          disabled={atRoot || loading}
          className={cn(
            "rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text",
            (atRoot || loading) && "opacity-40",
          )}
          title="Parent directory"
        >
          ↑ up
        </button>
        {/* Breadcrumb: click any segment to jump straight to that directory. */}
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded bg-term-panel px-2 py-1 text-xs"
          aria-label="Current path"
        >
          {segments.length === 0 ? (
            <span className="truncate text-term-dim">{cwd || "~"}</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onNavigate("/")}
                disabled={loading}
                className="flex-none text-term-muted hover:text-term-accent"
                title="Root"
              >
                /
              </button>
              {segments.map((seg, i) => (
                <span key={seg.path} className="flex flex-none items-center gap-0.5">
                  {i > 0 && <span className="text-term-faint">/</span>}
                  <button
                    type="button"
                    onClick={() => onNavigate(seg.path)}
                    disabled={loading}
                    className={cn(
                      "max-w-[10rem] truncate",
                      i === segments.length - 1
                        ? "text-term-dim"
                        : "text-term-muted hover:text-term-accent",
                    )}
                  >
                    {seg.name}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text"
          title="Refresh"
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={() => setShowSearch((v) => !v)}
          aria-pressed={showSearch}
          className={cn(
            "rounded border px-2 py-1 text-xs transition-colors",
            showSearch
              ? "border-term-accent/50 bg-term-accent/15 text-term-accent"
              : "border-term-border text-term-muted hover:text-term-text",
          )}
          title="Search this folder and its subfolders"
        >
          🔎
        </button>
        {/* List / grid layout toggle */}
        <div
          className="flex overflow-hidden rounded border border-term-border"
          role="group"
          aria-label="View mode"
        >
          <button
            type="button"
            onClick={() => setViewMode("list")}
            aria-pressed={viewMode === "list"}
            className={cn(
              "px-2 py-1 text-xs transition-colors",
              viewMode === "list"
                ? "bg-term-accent/15 text-term-accent"
                : "text-term-muted hover:text-term-text",
            )}
            title="List view"
          >
            ☰
          </button>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            aria-pressed={viewMode === "grid"}
            className={cn(
              "border-l border-term-border px-2 py-1 text-xs transition-colors",
              viewMode === "grid"
                ? "bg-term-accent/15 text-term-accent"
                : "text-term-muted hover:text-term-text",
            )}
            title="Grid view"
          >
            ▦
          </button>
        </div>
        {/* Sort control — grid view has no column headers to click, so it gets a
            compact segmented sort selector here (the list view uses its
            clickable table headers instead). */}
        {viewMode === "grid" && (
          <div
            className="flex overflow-hidden rounded border border-term-border"
            role="group"
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((opt, i) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => toggleSort(opt.key)}
                aria-pressed={sort.key === opt.key}
                className={cn(
                  "px-2 py-1 text-xs transition-colors",
                  i > 0 && "border-l border-term-border",
                  sort.key === opt.key
                    ? "bg-term-accent/15 text-term-accent"
                    : "text-term-muted hover:text-term-text",
                )}
                title={`Sort by ${opt.label.toLowerCase()}`}
              >
                {opt.label}
                {sort.key === opt.key && (
                  <span className="ml-1" aria-hidden>
                    {sortArrow}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {canElevate && (
          <button
            type="button"
            onClick={onToggleElevated}
            disabled={elevatedPending}
            aria-pressed={elevated}
            className={cn(
              "rounded border px-2 py-1 text-xs transition-colors",
              elevated
                ? "border-term-yellow/50 bg-term-yellow/15 text-term-yellow"
                : "border-term-border text-term-muted hover:text-term-text",
              elevatedPending && "opacity-50",
            )}
            title={
              elevated
                ? "Elevated (root) access is on — click to drop back to your user"
                : "Access files as root via sudo"
            }
          >
            {elevatedPending ? "sudo…" : elevated ? "sudo ●" : "sudo"}
          </button>
        )}
        <button
          type="button"
          onClick={onMkdir}
          disabled={loading}
          className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text"
        >
          + dir
        </button>
        <button
          type="button"
          onClick={onTouch}
          disabled={loading}
          className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text"
          title="Create an empty file"
        >
          + file
        </button>
        <button
          type="button"
          onClick={() => uploadRef.current?.click()}
          disabled={loading}
          className="rounded border border-term-accent/40 bg-term-accent/10 px-2 py-1 text-xs text-term-accent hover:bg-term-accent/20"
        >
          ↑ upload
        </button>
        <button
          type="button"
          onClick={() => folderRef.current?.click()}
          disabled={loading}
          className="rounded border border-term-accent/40 bg-term-accent/10 px-2 py-1 text-xs text-term-accent hover:bg-term-accent/20"
          title="Upload a folder (preserves its subdirectories)"
        >
          ↑ folder
        </button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            for (const file of Array.from(e.target.files ?? [])) onUpload(file);
            e.target.value = "";
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            for (const file of Array.from(e.target.files ?? [])) {
              // `webkitRelativePath` is like `folder/sub/file.txt`; keep it so
              // the upload recreates the tree under the current directory.
              const rel = file.webkitRelativePath || undefined;
              onUpload(file, rel && rel.includes("/") ? rel : undefined);
            }
            e.target.value = "";
          }}
        />
      </div>

      {/* Elevated-mode banner: a persistent reminder that actions run as root. */}
      {elevated && (
        <div className="flex items-center gap-2 border-b border-term-yellow/30 bg-term-yellow/10 px-3 py-1.5 text-xs text-term-yellow">
          <span aria-hidden>⚠</span>
          <span>
            Elevated access: file operations run as <strong>root</strong> via
            sudo.
          </span>
        </div>
      )}

      {/* Recursive subtree search bar */}
      {showSearch && (
        <form
          onSubmit={submitSearch}
          className="flex items-center gap-2 border-b border-term-border bg-term-panel/30 px-3 py-1.5"
        >
          <span className="text-xs text-term-faint" aria-hidden>
            🔎
          </span>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
            }}
            placeholder={
              searchMode === "content"
                ? "Search file contents in this folder and subfolders…"
                : "Search file names in this folder and subfolders…"
            }
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-term-text outline-none placeholder:text-term-faint"
            aria-label="Search files recursively"
          />
          {/* Name vs. content (grep) axis. Content search opens each file and
              scans its text on the bridge (size-capped); name search reads only
              listings/metadata. */}
          <div
            className="flex flex-none overflow-hidden rounded border border-term-border"
            role="group"
            aria-label="Search by"
          >
            {(["name", "content"] as const).map((m, i) => (
              <button
                key={m}
                type="button"
                onClick={() => setSearchMode(m)}
                aria-pressed={searchMode === m}
                className={cn(
                  "px-2 py-0.5 text-xs capitalize transition-colors",
                  i > 0 && "border-l border-term-border",
                  searchMode === m
                    ? "bg-term-accent/15 text-term-accent"
                    : "text-term-muted hover:text-term-text",
                )}
                title={
                  m === "content"
                    ? "Search inside file contents (grep)"
                    : "Search file names"
                }
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="submit"
            className="rounded border border-term-accent/40 bg-term-accent/10 px-2 py-0.5 text-xs text-term-accent hover:bg-term-accent/20"
          >
            Search
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="rounded px-1 text-xs text-term-muted hover:text-term-text"
            aria-label="Close search"
            title="Close search (Esc)"
          >
            ✕
          </button>
        </form>
      )}

      {/* In-CWD name filter */}
      {!search && sorted.length > 0 && (
        <div className="flex items-center gap-2 border-b border-term-border bg-term-panel/30 px-3 py-1.5">
          <span className="text-xs text-term-faint" aria-hidden>
            🔍
          </span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
            }}
            placeholder="Filter files by name…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-term-text outline-none placeholder:text-term-faint"
            aria-label="Filter files by name"
          />
          {filtering && (
            <>
              <span className="tabular-nums text-xs text-term-faint">
                {visible.length}/{sorted.length}
              </span>
              <button
                type="button"
                onClick={() => setFilter("")}
                className="rounded px-1 text-xs text-term-muted hover:text-term-text"
                aria-label="Clear filter"
                title="Clear filter (Esc)"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {/* Upload progress. For a batch (>1 file) an aggregate bar summarizes the
          whole queue with a single Cancel-all, and only the actively
          streaming/interrupted files get their own row — the ones still waiting
          behind the concurrency limit collapse into a "N queued" line so a big
          folder upload doesn't render hundreds of rows. */}
      {uploads.length > 0 &&
        (() => {
          const summary = summarizeUploads(uploads);
          const showAggregate = uploads.length > 1;
          const rows = showAggregate
            ? uploads.filter((u) => u.status !== "queued")
            : uploads;
          return (
            <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
              {showAggregate && (
                <div className="text-xs">
                  <div className="flex items-center justify-between gap-2 text-term-muted">
                    <span className="truncate font-medium">
                      ↑ Uploading {summary.files} file
                      {summary.files === 1 ? "" : "s"}
                      {summary.queued > 0 && (
                        <span className="text-term-faint">
                          {" "}
                          · {summary.queued} queued
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums text-term-faint">
                        {summary.pct}%
                      </span>
                      <button
                        type="button"
                        onClick={onCancelAllUploads}
                        className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                        title="Cancel all uploads"
                      >
                        Cancel all
                      </button>
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                    <div
                      className={cn(
                        "h-full transition-all",
                        summary.interrupted ? "bg-term-yellow" : "bg-term-accent",
                      )}
                      style={{ width: `${summary.pct}%` }}
                    />
                  </div>
                </div>
              )}
              {rows.map((u) => {
                const pct =
                  u.total > 0 ? Math.round((u.sent / u.total) * 100) : 100;
                const interrupted = u.status === "interrupted";
                return (
                  <div key={u.path} className="text-xs">
                    <div className="flex items-center justify-between gap-2 text-term-muted">
                      <span className="truncate">↑ {u.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {interrupted ? (
                          <>
                            <span className="text-term-yellow">interrupted</span>
                            <button
                              type="button"
                              onClick={() => onResumeUpload(u.path)}
                              className="rounded px-1 text-term-accent hover:bg-term-border"
                              title="Resume upload"
                            >
                              Resume
                            </button>
                          </>
                        ) : (
                          <span className="tabular-nums text-term-faint">
                            {pct}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => onCancelUpload(u.path)}
                          className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                          title="Cancel upload"
                          aria-label={`Cancel upload ${u.name}`}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                      <div
                        className={cn(
                          "h-full transition-all",
                          interrupted ? "bg-term-yellow" : "bg-term-accent",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

      {/* Download progress */}
      {downloads.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
          {downloads.map((d) => {
            const pct =
              d.total > 0 ? Math.round((d.received / d.total) * 100) : 100;
            return (
              <div key={d.path} className="text-xs">
                <div className="flex items-center justify-between gap-2 text-term-muted">
                  <span className="truncate">↓ {d.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-term-faint">{pct}%</span>
                    <button
                      type="button"
                      onClick={() => onCancelDownload(d.path)}
                      className="rounded px-1 text-term-faint hover:bg-term-border hover:text-term-red"
                      title="Cancel download"
                      aria-label={`Cancel download ${d.name}`}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                  <div
                    className="h-full bg-term-green transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Selection bar: select-all + bulk actions on the checked entries */}
      {!search && sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel/40 px-3 py-1.5 text-xs">
          <label className="flex items-center gap-2 text-term-muted">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={toggleAll}
              className="accent-term-accent"
              aria-label="Select all"
            />
            <span className="tabular-nums">
              {selectedCount > 0 ? `${selectedCount} selected` : "Select"}
            </span>
          </label>
          {selectedCount > 0 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  onDownloadMany(selectedEntries.map((e) => pathFor(e.name)))
                }
                className="rounded border border-term-accent/40 bg-term-accent/10 px-2 py-0.5 text-term-accent hover:bg-term-accent/20"
              >
                ↓ Download zip
              </button>
              <button
                type="button"
                onClick={() => onDeleteMany(selectedEntries)}
                className="rounded border border-term-red/40 px-2 py-0.5 text-term-red hover:bg-term-red/10"
              >
                ✕ Delete
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded px-2 py-0.5 text-term-muted hover:text-term-text"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {/* Listing (drop target) */}
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-auto",
          dragging && "outline outline-2 -outline-offset-2 outline-term-accent",
        )}
        onDragOver={(e) => {
          // In-app move drags are handled by folder rows, not the upload zone.
          if (e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 m-2 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-term-accent bg-term-bg/80 text-sm text-term-accent">
            <span className="text-3xl" aria-hidden>
              ↥
            </span>
            <span>Drop to upload to</span>
            <code className="rounded bg-term-panel px-2 py-0.5 text-xs">
              {cwd}
            </code>
          </div>
        )}
        {search ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-term-border bg-term-panel/40 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate text-term-muted">
                {search.loading
                  ? `Searching ${
                      search.mode === "content" ? "file contents" : "names"
                    } for “${search.query}”…`
                  : `${search.results.length}${search.truncated ? "+" : ""} result${
                      search.results.length === 1 ? "" : "s"
                    } for “${search.query}”${
                      search.mode === "content" ? " in file contents" : ""
                    }`}
              </span>
              {search.truncated && !search.loading && (
                <span className="flex-none text-term-faint">
                  (first {search.results.length})
                </span>
              )}
              <button
                type="button"
                onClick={onClearSearch}
                className="ml-auto flex-none rounded px-2 py-0.5 text-term-muted hover:text-term-text"
              >
                Clear
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {search.loading ? (
                <div className="flex items-center justify-center py-12">
                  <span
                    className="h-7 w-7 animate-spin rounded-full border-2 border-term-border border-t-term-accent"
                    role="status"
                    aria-label="Searching"
                  />
                </div>
              ) : search.results.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-term-muted">
                  <span className="text-3xl opacity-60" aria-hidden>
                    🔎
                  </span>
                  <p className="text-sm">
                    {search.mode === "content"
                      ? `No file contents matched “${search.query}”`
                      : `No matches for “${search.query}”`}
                  </p>
                  <p className="text-xs text-term-faint">
                    Searched {cwd} and its subfolders.
                  </p>
                </div>
              ) : (
                <ul>
                  {search.results.map((r) => {
                    const grep = isGrepHit(r);
                    return (
                      <li key={r.path}>
                        <button
                          type="button"
                          onClick={() => openResult(r)}
                          title={r.path}
                          className="flex w-full flex-col gap-0.5 border-b border-term-border/50 px-3 py-1.5 text-left text-sm hover:bg-term-panel/60"
                        >
                          <span className="flex w-full items-center gap-2">
                            <span aria-hidden>{fileIcon(r)}</span>
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate",
                                r.type === "dir"
                                  ? "text-term-accent"
                                  : "text-term-dim",
                              )}
                            >
                              {relTo(r.path)}
                            </span>
                            <span className="flex-none font-mono text-xs text-term-faint">
                              {formatSize(r.size, r.type)}
                            </span>
                          </span>
                          {grep && (
                            <span className="flex min-w-0 items-baseline gap-2 pl-6 font-mono text-xs text-term-faint">
                              <span className="flex-none text-term-accent/70">
                                :{r.line}
                              </span>
                              <span className="min-w-0 truncate">{r.preview}</span>
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <>
        {loading && <p className="px-3 py-4 text-xs text-term-muted">Loading…</p>}
        {!loading && sorted.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-term-muted">
            <span className="text-3xl opacity-60" aria-hidden>
              📂
            </span>
            <p className="text-sm">This directory is empty</p>
            <p className="text-xs text-term-faint">
              Drag files here, or use “↑ upload” / “+ file” to add one.
            </p>
          </div>
        )}
        {!loading && sorted.length > 0 && visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-term-muted">
            <span className="text-3xl opacity-60" aria-hidden>
              🔍
            </span>
            <p className="text-sm">No files match “{filter.trim()}”</p>
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-xs text-term-accent hover:text-term-accent-soft"
            >
              Clear filter
            </button>
          </div>
        )}
        {viewMode === "list" && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-term-border text-xs">
              <th className="w-8" aria-hidden />
              <SortHeader
                label="Name"
                col="name"
                activeKey={sort.key}
                dir={sort.dir}
                onSort={toggleSort}
                className="pl-1"
              />
              <SortHeader
                label="Size"
                col="size"
                activeKey={sort.key}
                dir={sort.dir}
                onSort={toggleSort}
                align="right"
                className="hidden whitespace-nowrap sm:table-cell"
              />
              <th className="hidden px-2 py-1.5 text-left font-medium text-term-muted md:table-cell">
                Perms
              </th>
              <SortHeader
                label="Modified"
                col="mtime"
                activeKey={sort.key}
                dir={sort.dir}
                onSort={toggleSort}
                className="hidden whitespace-nowrap lg:table-cell"
              />
              <th className="py-1.5 pl-2 pr-3" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const isDir = entry.type === "dir";
              const target = pathFor(entry.name);
              const editable = !isDir && isProbablyTextFile(entry.name);
              const previewable = !isDir && filePreviewKind(entry.name) !== null;
              // Click opens by type — always *viewing* the file, never
              // downloading it (download is only the explicit ↓ button): dir →
              // navigate, image/video/audio → preview, text → editor, anything
              // else → a download-only modal (the browser can't render it).
              const open = () => {
                if (isDir) onNavigate(target);
                else if (previewable) onPreview(target, entry.name);
                else if (editable) onEdit(target, entry.name, entry.size);
                else onOpenUnsupported(target, entry.name);
              };
              return (
                <tr
                  key={entry.name}
                  draggable
                  onDragStart={(e) => onEntryDragStart(e, target)}
                  onDragOver={
                    isDir ? (e) => onFolderDragOver(e, target) : undefined
                  }
                  onDragLeave={
                    isDir
                      ? () => setDropDir((d) => (d === target ? null : d))
                      : undefined
                  }
                  onDrop={isDir ? (e) => onFolderDrop(e, target) : undefined}
                  className={cn(
                    "border-b border-term-border/50 hover:bg-term-panel/60",
                    isSelected(entry.name) && "bg-term-accent/5",
                    isDir &&
                      dropDir === target &&
                      "bg-term-accent/10 outline outline-2 -outline-offset-2 outline-term-accent",
                  )}
                >
                  <td className="w-8 py-1.5 pl-3 pr-0 align-middle">
                    <input
                      type="checkbox"
                      checked={isSelected(entry.name)}
                      onChange={() => toggleOne(entry.name)}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-term-accent"
                      aria-label={`Select ${entry.name}`}
                    />
                  </td>
                  <td className="w-full py-1.5 pl-1 pr-2">
                    <button
                      type="button"
                      onClick={open}
                      title={
                        entry.type === "link" && entry.target
                          ? `${entry.name} → ${entry.target}`
                          : isDir
                            ? undefined
                            : "Click to open"
                      }
                      className={cn(
                        "flex max-w-full items-center gap-2 text-left",
                        isDir ? "text-term-accent" : "text-term-dim",
                      )}
                    >
                      <span aria-hidden>{fileIcon(entry)}</span>
                      <span className="truncate">{entry.name}</span>
                      {entry.type === "link" && entry.target && (
                        <span className="truncate text-xs text-term-faint">
                          → {entry.target}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1.5 text-right font-mono text-xs text-term-faint sm:table-cell">
                    {formatSize(entry.size, entry.type)}
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1.5 font-mono text-xs text-term-faint md:table-cell">
                    {formatMode(entry.mode, entry.type)}
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1.5 font-mono text-xs text-term-faint lg:table-cell">
                    {formatMtime(entry.mtime)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right">
                    {previewable && (
                      <button
                        type="button"
                        onClick={() => onPreview(target, entry.name)}
                        className={cn(actionBtn, "hover:text-term-accent")}
                        title="Preview"
                      >
                        👁
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        onClick={() => onEdit(target, entry.name, entry.size)}
                        className={cn(actionBtn, "hover:text-term-accent")}
                        title="Edit"
                      >
                        ✎
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        isDir ? onDownloadDir(target) : onDownload(target)
                      }
                      className={cn(actionBtn, "hover:text-term-accent")}
                      title={isDir ? "Download as zip" : "Download"}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => onRename(entry)}
                      className={cn(actionBtn, "hover:text-term-text")}
                      title="Rename"
                    >
                      mv
                    </button>
                    <button
                      type="button"
                      onClick={() => onCopy(entry)}
                      className={cn(actionBtn, "hover:text-term-text")}
                      title="Duplicate"
                    >
                      cp
                    </button>
                    <button
                      type="button"
                      onClick={() => onChmod(entry)}
                      className={cn(actionBtn, "hover:text-term-text")}
                      title="Change permissions"
                    >
                      chmod
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(entry)}
                      className={cn(actionBtn, "hover:text-term-red")}
                      title="Delete"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {viewMode === "grid" && visible.length > 0 && (
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {visible.map((entry) => {
              const isDir = entry.type === "dir";
              const target = pathFor(entry.name);
              const editable = !isDir && isProbablyTextFile(entry.name);
              const previewable = !isDir && filePreviewKind(entry.name) !== null;
              // Click opens by type — always *viewing* the file, never
              // downloading it (download is only the explicit ↓ button): dir →
              // navigate, image/video/audio → preview, text → editor, anything
              // else → a download-only modal (the browser can't render it).
              const open = () => {
                if (isDir) onNavigate(target);
                else if (previewable) onPreview(target, entry.name);
                else if (editable) onEdit(target, entry.name, entry.size);
                else onOpenUnsupported(target, entry.name);
              };
              return (
                <div
                  key={entry.name}
                  draggable
                  onDragStart={(e) => onEntryDragStart(e, target)}
                  onDragOver={
                    isDir ? (e) => onFolderDragOver(e, target) : undefined
                  }
                  onDragLeave={
                    isDir
                      ? () => setDropDir((d) => (d === target ? null : d))
                      : undefined
                  }
                  onDrop={isDir ? (e) => onFolderDrop(e, target) : undefined}
                  className={cn(
                    "group relative flex flex-col gap-1.5 rounded border p-2 transition-colors hover:bg-term-panel/60",
                    isSelected(entry.name)
                      ? "border-term-accent/50 bg-term-accent/5"
                      : "border-term-border/50",
                    isDir &&
                      dropDir === target &&
                      "border-term-accent bg-term-accent/10 outline outline-2 -outline-offset-2 outline-term-accent",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected(entry.name)}
                    onChange={() => toggleOne(entry.name)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className={cn(
                      "absolute left-2 top-2 z-10 accent-term-accent transition-opacity",
                      isSelected(entry.name)
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                    aria-label={`Select ${entry.name}`}
                  />
                  <button
                    type="button"
                    onClick={open}
                    title={isDir ? entry.name : "Click to open"}
                    className="cursor-pointer"
                    aria-label={`Open ${entry.name}`}
                  >
                    <Thumbnail
                      path={target}
                      src={thumbnails[target]}
                      kind={previewKind(entry.name)}
                      thumbnailable={isThumbnailable(entry)}
                      fallback={fileIcon(entry)}
                      onRequest={onRequestThumbnail}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={open}
                    title={
                      entry.type === "link" && entry.target
                        ? `${entry.name} → ${entry.target}`
                        : isDir
                          ? entry.name
                          : "Click to open"
                    }
                    className={cn(
                      "truncate text-left text-xs",
                      isDir ? "text-term-accent" : "text-term-dim",
                    )}
                  >
                    {entry.name}
                    {entry.type === "link" && entry.target && (
                      <span className="text-term-faint"> → {entry.target}</span>
                    )}
                  </button>
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-mono text-[10px] text-term-faint">
                      {formatSize(entry.size, entry.type)}
                    </span>
                    <div className="flex flex-none items-center opacity-0 transition-opacity group-hover:opacity-100">
                      {previewable && (
                        <button
                          type="button"
                          onClick={() => onPreview(target, entry.name)}
                          className={cn(actionBtn, "hover:text-term-accent")}
                          title="Preview"
                        >
                          👁
                        </button>
                      )}
                      {editable && (
                        <button
                          type="button"
                          onClick={() => onEdit(target, entry.name, entry.size)}
                          className={cn(actionBtn, "hover:text-term-accent")}
                          title="Edit"
                        >
                          ✎
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          isDir ? onDownloadDir(target) : onDownload(target)
                        }
                        className={cn(actionBtn, "hover:text-term-accent")}
                        title={isDir ? "Download as zip" : "Download"}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => onRename(entry)}
                        className={cn(actionBtn, "hover:text-term-text")}
                        title="Rename"
                      >
                        mv
                      </button>
                      <button
                        type="button"
                        onClick={() => onCopy(entry)}
                        className={cn(actionBtn, "hover:text-term-text")}
                        title="Duplicate"
                      >
                        cp
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(entry)}
                        className={cn(actionBtn, "hover:text-term-red")}
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}
