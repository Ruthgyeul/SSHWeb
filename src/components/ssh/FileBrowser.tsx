"use client";

import { useRef } from "react";
import {
  formatMode,
  formatSize,
  parentPath,
  sortEntries,
  type FileEntry,
} from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";

/**
 * SFTP file browser over the live SSH session. It is fully controlled by the
 * parent: `entries`/`cwd` are supplied and every action (navigate, download,
 * upload, delete, mkdir, refresh) is delegated upward, so all network traffic
 * flows through the single WebSocket the parent owns.
 */
export function FileBrowser({
  cwd,
  entries,
  loading,
  onNavigate,
  onDownload,
  onDelete,
  onUpload,
  onMkdir,
  onRefresh,
}: {
  cwd: string;
  entries: FileEntry[];
  loading: boolean;
  onNavigate: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (entry: FileEntry) => void;
  onUpload: (file: File) => void;
  onMkdir: () => void;
  onRefresh: () => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const sorted = sortEntries(entries);
  const atRoot = cwd === "/";

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
          onClick={() => uploadRef.current?.click()}
          disabled={loading}
          className="rounded border border-term-accent/40 bg-term-accent/10 px-2 py-1 text-xs text-term-accent hover:bg-term-accent/20"
        >
          ↑ upload
        </button>
        <input
          ref={uploadRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* Listing */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <p className="px-3 py-4 text-xs text-term-muted">Loading…</p>
        )}
        {!loading && sorted.length === 0 && (
          <p className="px-3 py-4 text-xs text-term-muted">
            Empty directory.
          </p>
        )}
        <table className="w-full border-collapse text-sm">
          <tbody>
            {sorted.map((entry) => {
              const isDir = entry.type === "dir";
              const target = `${cwd.replace(/\/$/, "")}/${entry.name}`;
              return (
                <tr
                  key={entry.name}
                  className="border-b border-term-border/50 hover:bg-term-panel/60"
                >
                  <td className="w-full py-1.5 pl-3 pr-2">
                    <button
                      type="button"
                      onClick={() => isDir && onNavigate(target)}
                      className={cn(
                        "flex items-center gap-2 text-left",
                        isDir
                          ? "text-term-accent"
                          : "cursor-default text-term-dim",
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
                    {!isDir && (
                      <button
                        type="button"
                        onClick={() => onDownload(target)}
                        className="mr-2 text-xs text-term-muted hover:text-term-accent"
                        title="Download"
                      >
                        ↓
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDelete(entry)}
                      className="text-xs text-term-muted hover:text-term-red"
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
