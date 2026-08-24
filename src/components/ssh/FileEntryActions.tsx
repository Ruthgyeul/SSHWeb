"use client";

import { type FileEntry } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import { DownloadIcon, EyeIcon, PencilIcon } from "./icons";

const actionBtn =
  "rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors";

type PreviewSibling = { path: string; name: string };

interface FileEntryActionsProps {
  entry: FileEntry;
  /** Absolute remote path of the entry (its action target). */
  target: string;
  isDir: boolean;
  /** The file opens in the inline editor (text-like). */
  editable: boolean;
  /** The file has an inline preview surface (media/PDF/Markdown/text). */
  previewable: boolean;
  /** Other previewable files in the same view, for the gallery step. */
  previewSiblings: PreviewSibling[];
  /** Include the `chmod` button (the list view does; the grid view omits it). */
  showChmod?: boolean;
  onPreview: (path: string, name: string, siblings?: PreviewSibling[]) => void;
  onEdit: (path: string, name: string, size: number) => void;
  onDownload: (path: string) => void;
  onDownloadDir: (path: string) => void;
  onRename: (entry: FileEntry) => void;
  onCopy: (entry: FileEntry) => void;
  onChmod: (entry: FileEntry) => void;
  /** Create a symlink pointing at this entry (list view only when provided). */
  onSymlink?: (entry: FileEntry) => void;
  /** Compute a checksum of this file (list view only; files only). */
  onChecksum?: (entry: FileEntry) => void;
  /** Copy this entry's absolute path to the clipboard (list view only). */
  onCopyPath?: (path: string) => void;
  onDelete: (entry: FileEntry) => void;
}

/** The per-entry action buttons (preview / edit / download / mv / cp / chmod /
 * delete) shared by the file browser's list rows and grid tiles. The set shown
 * depends on the entry's type: a previewable file gets 👁, a text file gets 👁
 * + ✎, a directory downloads as a zip. `chmod` is list-only via `showChmod`. */
export function FileEntryActions({
  entry,
  target,
  isDir,
  editable,
  previewable,
  previewSiblings,
  showChmod = false,
  onPreview,
  onEdit,
  onDownload,
  onDownloadDir,
  onRename,
  onCopy,
  onChmod,
  onSymlink,
  onChecksum,
  onCopyPath,
  onDelete,
}: FileEntryActionsProps) {
  return (
    <>
      {previewable && (
        <button
          type="button"
          onClick={() => onPreview(target, entry.name, previewSiblings)}
          className={cn(actionBtn, "hover:text-term-accent")}
          title="Preview"
        >
          <EyeIcon />
        </button>
      )}
      {editable && (
        <>
          <button
            type="button"
            onClick={() => onPreview(target, entry.name, previewSiblings)}
            className={cn(actionBtn, "hover:text-term-accent")}
            title="Preview (read-only)"
          >
            <EyeIcon />
          </button>
          <button
            type="button"
            onClick={() => onEdit(target, entry.name, entry.size)}
            className={cn(actionBtn, "hover:text-term-accent")}
            title="Edit"
          >
            <PencilIcon />
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => (isDir ? onDownloadDir(target) : onDownload(target))}
        className={cn(actionBtn, "hover:text-term-accent")}
        title={isDir ? "Download as zip" : "Download"}
        aria-label={isDir ? "Download as zip" : "Download"}
      >
        <DownloadIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onRename(entry)}
        className={cn(actionBtn, "hover:text-term-text")}
        title="Move / rename"
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
      {showChmod && (
        <button
          type="button"
          onClick={() => onChmod(entry)}
          className={cn(actionBtn, "hover:text-term-text")}
          title="Change permissions"
        >
          chmod
        </button>
      )}
      {onSymlink && (
        <button
          type="button"
          onClick={() => onSymlink(entry)}
          className={cn(actionBtn, "hover:text-term-text")}
          title="Create a symbolic link to this"
        >
          ln
        </button>
      )}
      {onChecksum && !isDir && (
        <button
          type="button"
          onClick={() => onChecksum(entry)}
          className={cn(actionBtn, "hover:text-term-text")}
          title="Compute SHA-256 checksum"
        >
          sum
        </button>
      )}
      {onCopyPath && (
        <button
          type="button"
          onClick={() => onCopyPath(target)}
          className={cn(actionBtn, "hover:text-term-text")}
          title="Copy path"
          aria-label={`Copy path of ${entry.name}`}
        >
          ⧉
        </button>
      )}
      <button
        type="button"
        onClick={() => onDelete(entry)}
        className={cn(actionBtn, "hover:text-term-red")}
        title="Delete"
      >
        ✕
      </button>
    </>
  );
}
