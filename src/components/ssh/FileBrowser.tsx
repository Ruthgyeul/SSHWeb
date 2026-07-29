"use client";

import { useRef, useState } from "react";
import {
  formatMode,
  formatSize,
  isProbablyImageFile,
  isProbablyTextFile,
  parentPath,
  sortEntries,
  type FileEntry,
} from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";

/** One in-flight upload's progress, shown in the progress panel. */
export interface UploadItem {
  name: string;
  sent: number;
  total: number;
}

const actionBtn =
  "rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors";

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
  onNavigate,
  onDownload,
  onDownloadDir,
  onDelete,
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
  onNavigate: (path: string) => void;
  onDownload: (path: string) => void;
  onDownloadDir: (path: string) => void;
  onDelete: (entry: FileEntry) => void;
  onUpload: (file: File) => void;
  onMkdir: () => void;
  onTouch: () => void;
  onRename: (entry: FileEntry) => void;
  onChmod: (entry: FileEntry) => void;
  onEdit: (path: string, name: string) => void;
  onPreview: (path: string, name: string) => void;
  onRefresh: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const sorted = sortEntries(entries);
  const atRoot = cwd === "/";

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
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
        <code className="min-w-0 flex-1 truncate rounded bg-term-panel px-2 py-1 text-xs text-term-dim">
          {cwd || "~"}
        </code>
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
      </div>

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
        <table className="w-full border-collapse text-sm">
          <tbody>
            {sorted.map((entry) => {
              const isDir = entry.type === "dir";
              const target = `${cwd.replace(/\/$/, "")}/${entry.name}`;
              const editable = !isDir && isProbablyTextFile(entry.name);
              const previewable = !isDir && isProbablyImageFile(entry.name);
              // Double-click opens by type: dir → navigate, image → preview,
              // text → editor, anything else → download.
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
                  className="cursor-pointer border-b border-term-border/50 hover:bg-term-panel/60"
                >
                  <td className="w-full py-1.5 pl-3 pr-2">
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
                        {isDir ? "📁" : entry.type === "link" ? "🔗" : "📄"}
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
