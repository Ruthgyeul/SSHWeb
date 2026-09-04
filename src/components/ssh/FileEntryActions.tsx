"use client";

import { type FileEntry } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import {
  DownloadIcon,
  EyeIcon,
  LockIcon,
  MoveIcon,
  PencilIcon,
  TrashIcon,
} from "./icons";

// `touch:` bumps the tap target to ~44px on hover-less (touch) devices without
// enlarging the compact desktop buttons.
const actionBtn =
  "inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors touch:min-h-11 touch:min-w-11";

type PreviewSibling = { path: string; name: string };

interface FileEntryActionsProps {
  entry: FileEntry;
  /** Absolute remote path of the entry (its action target). */
  target: string;
  isDir: boolean;
  /** The file opens in the inline editor (text-like). */
  editable: boolean;
  /** The file has an inline preview surface (media/PDF/Markdown). */
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
  onChmod: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

/** The per-entry action buttons shared by the file browser's list rows and grid
 * tiles, in a fixed order: preview / edit / mv / chmod / download / delete. A
 * file with a rich preview (media/PDF/Markdown) gets a single 👁; an editable
 * text file gets ✎ (reading a text file is done in the editor, so it needs no
 * separate read-only preview); a directory downloads as a zip. `chmod` is
 * list-only via `showChmod`. */
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
  onChmod,
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
          aria-label="Preview"
        >
          <EyeIcon />
        </button>
      )}
      {editable && (
        <button
          type="button"
          onClick={() => onEdit(target, entry.name, entry.size)}
          className={cn(actionBtn, "hover:text-term-accent")}
          title="Edit"
          aria-label="Edit"
        >
          <PencilIcon />
        </button>
      )}
      <button
        type="button"
        onClick={() => onRename(entry)}
        className={cn(actionBtn, "hover:text-term-text")}
        title="Move / rename"
        aria-label="Move / rename"
      >
        <MoveIcon className="h-4 w-4" />
      </button>
      {showChmod && (
        <button
          type="button"
          onClick={() => onChmod(entry)}
          className={cn(actionBtn, "hover:text-term-text")}
          title="Change permissions"
          aria-label="Change permissions"
        >
          <LockIcon className="h-4 w-4" />
        </button>
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
        onClick={() => onDelete(entry)}
        className={cn(actionBtn, "hover:text-term-red")}
        title="Delete"
        aria-label="Delete"
      >
        <TrashIcon className="h-4 w-4" />
      </button>
    </>
  );
}
