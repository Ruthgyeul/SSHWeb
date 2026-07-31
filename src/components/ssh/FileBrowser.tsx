"use client";

import { useEffect, useRef, useState } from "react";
import {
  filterEntries,
  formatMode,
  formatSize,
  isProbablyPreviewableFile,
  isProbablyTextFile,
  isProbablyVideoFile,
  parentPath,
  pathSegments,
  sortEntries,
  type FileEntry,
} from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import { collectDroppedFiles, droppedEntries } from "./dropUpload";

/** One in-flight upload's progress, shown in the progress panel. */
export interface UploadItem {
  name: string;
  sent: number;
  total: number;
}

/** One in-flight download's progress, shown in the progress panel. */
export interface DownloadItem {
  name: string;
  received: number;
  total: number;
}

const actionBtn =
  "rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors";

/** Shared empty set for a listing with no active selection (stable identity). */
const EMPTY_NAMES: ReadonlySet<string> = new Set();

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
  onChmod,
  onEdit,
  onPreview,
  onRefresh,
}: {
  cwd: string;
  entries: FileEntry[];
  loading: boolean;
  uploads: UploadItem[];
  downloads: DownloadItem[];
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
  onChmod: (entry: FileEntry) => void;
  onEdit: (path: string, name: string) => void;
  onPreview: (path: string, name: string) => void;
  onRefresh: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

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

  const sorted = sortEntries(entries);
  // The rows actually shown: `sorted` narrowed by the filter box. Selection is
  // kept against the full listing (below) so filtering never drops checks.
  const visible = filterEntries(sorted, filter);
  const filtering = filter.trim() !== "";
  const atRoot = cwd === "/";
  const segments = pathSegments(cwd);
  const pathFor = (name: string) => `${cwd.replace(/\/$/, "")}/${name}`;

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

      {/* In-CWD name filter */}
      {sorted.length > 0 && (
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

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
          {uploads.map((u) => {
            const pct = u.total > 0 ? Math.round((u.sent / u.total) * 100) : 100;
            return (
              <div key={u.name} className="text-xs">
                <div className="flex justify-between text-term-muted">
                  <span className="truncate">↑ {u.name}</span>
                  <span className="ml-2 tabular-nums text-term-faint">{pct}%</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-term-border">
                  <div
                    className="h-full bg-term-accent transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Download progress */}
      {downloads.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-term-border bg-term-panel/50 px-3 py-2">
          {downloads.map((d) => {
            const pct =
              d.total > 0 ? Math.round((d.received / d.total) * 100) : 100;
            return (
              <div key={d.name} className="text-xs">
                <div className="flex justify-between text-term-muted">
                  <span className="truncate">↓ {d.name}</span>
                  <span className="ml-2 tabular-nums text-term-faint">{pct}%</span>
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
      {sorted.length > 0 && (
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
        <table className="w-full border-collapse text-sm">
          <tbody>
            {visible.map((entry) => {
              const isDir = entry.type === "dir";
              const target = pathFor(entry.name);
              const editable = !isDir && isProbablyTextFile(entry.name);
              const previewable = !isDir && isProbablyPreviewableFile(entry.name);
              // Double-click opens by type: dir → navigate, image/video →
              // preview, text → editor, anything else → download.
              const open = () => {
                if (isDir) onNavigate(target);
                else if (previewable) onPreview(target, entry.name);
                else if (editable) onEdit(target, entry.name);
                else onDownload(target);
              };
              return (
                <tr
                  key={entry.name}
                  onDoubleClick={open}
                  className={cn(
                    "cursor-pointer border-b border-term-border/50 hover:bg-term-panel/60",
                    isSelected(entry.name) && "bg-term-accent/5",
                  )}
                >
                  <td
                    className="w-8 py-1.5 pl-3 pr-0 align-middle"
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
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
                      onClick={() => isDir && onNavigate(target)}
                      title={isDir ? undefined : "Double-click to open"}
                      className={cn(
                        "flex items-center gap-2 text-left",
                        isDir ? "text-term-accent" : "text-term-dim",
                      )}
                    >
                      <span aria-hidden>
                        {isDir
                          ? "📁"
                          : entry.type === "link"
                            ? "🔗"
                            : isProbablyVideoFile(entry.name)
                              ? "🎞"
                              : "📄"}
                      </span>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1.5 text-right font-mono text-xs text-term-faint sm:table-cell">
                    {formatSize(entry.size, entry.type)}
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1.5 font-mono text-xs text-term-faint md:table-cell">
                    {formatMode(entry.mode, entry.type)}
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
                        onClick={() => onEdit(target, entry.name)}
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
      </div>
    </div>
  );
}
