import { useMemo } from "react";
import {
  joinPath,
  modeToOctal,
  parentPath,
  parseOctalMode,
  suggestCopyName,
  type ClientMessage,
  type FileEntry,
} from "@/lib/sshProtocol";
import type { DialogRequest } from "../PromptDialog";

/** Send a client message over the session's WebSocket. */
type Send = (msg: ClientMessage) => void;

/** Open (or replace) the themed prompt/confirm dialog. */
type SetDialog = (request: DialogRequest | null) => void;

interface FileActionsDeps {
  /** The current working directory (search/action root). */
  cwd: string;
  /** The current listing, for a copy's non-colliding name suggestion. */
  entries: FileEntry[];
  send: Send;
  setDialog: SetDialog;
}

/** The file-browser's mutating actions, each of which builds a `PromptDialog`
 * request (confirm or name/mode input) and, on confirm, sends the matching
 * SFTP message. Pure of any session state beyond `cwd`/`entries`, so it lives
 * here rather than inline in SshSession. `onMove` is the one immediate action
 * (drag-drop) with no dialog. Elevated-access (sudo) toggling stays in
 * SshSession since it also drives connection state. */
export function useFileActions({
  cwd,
  entries,
  send,
  setDialog,
}: FileActionsDeps) {
  return useMemo(() => {
    const onDelete = (entry: FileEntry) => {
      setDialog({
        title: `Delete “${entry.name}”?`,
        message:
          entry.type === "dir"
            ? "The directory must be empty. This cannot be undone."
            : "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () =>
          send({
            t: "sftp-rm",
            path: joinPath(cwd, entry.name),
            dir: entry.type === "dir",
          }),
      });
    };

    // Bulk delete: one confirm for the whole selection, then a `sftp-rm` per
    // entry (same per-item semantics as a single delete — directories must be
    // empty). Each ok refreshes the listing, which prunes the selection.
    const onDeleteMany = (items: FileEntry[]) => {
      if (items.length === 0) return;
      const hasDir = items.some((e) => e.type === "dir");
      setDialog({
        title: `Delete ${items.length} item${items.length > 1 ? "s" : ""}?`,
        message: hasDir
          ? "Selected directories must be empty. This cannot be undone."
          : "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          for (const entry of items) {
            send({
              t: "sftp-rm",
              path: joinPath(cwd, entry.name),
              dir: entry.type === "dir",
            });
          }
        },
      });
    };

    const onMkdir = () => {
      setDialog({
        title: "New directory",
        input: { label: "Directory name", placeholder: "e.g. logs" },
        confirmLabel: "Create",
        validate: (v) => (v.trim() ? null : "Please enter a name."),
        onConfirm: (v) =>
          send({ t: "sftp-mkdir", path: joinPath(cwd, v.trim()) }),
      });
    };

    const onTouch = () => {
      setDialog({
        title: "New file",
        input: { label: "File name", placeholder: "e.g. notes.txt" },
        confirmLabel: "Create",
        validate: (v) => (v.trim() ? null : "Please enter a name."),
        onConfirm: (v) =>
          send({ t: "sftp-write", path: joinPath(cwd, v.trim()), dataB64: "" }),
      });
    };

    const onRename = (entry: FileEntry) => {
      setDialog({
        title: `Rename “${entry.name}”`,
        input: { label: "New name", initialValue: entry.name },
        confirmLabel: "Rename",
        validate: (v) => (v.trim() ? null : "Please enter a name."),
        onConfirm: (v) => {
          const next = v.trim();
          if (next && next !== entry.name) {
            send({
              t: "sftp-rename",
              from: joinPath(cwd, entry.name),
              to: joinPath(cwd, next),
            });
          }
        },
      });
    };

    // Duplicate a file/directory in place: pre-fill a non-colliding "… copy"
    // name and copy on confirm. The server streams the copy (original only read).
    const onCopy = (entry: FileEntry) => {
      const suggested = suggestCopyName(
        entry.name,
        entries.map((e) => e.name),
      );
      setDialog({
        title: `Duplicate “${entry.name}”`,
        input: { label: "New name", initialValue: suggested },
        confirmLabel: "Duplicate",
        validate: (v) => (v.trim() ? null : "Please enter a name."),
        onConfirm: (v) => {
          const next = v.trim();
          if (next && next !== entry.name) {
            send({
              t: "sftp-copy",
              from: joinPath(cwd, entry.name),
              to: joinPath(cwd, next),
            });
          }
        },
      });
    };

    // Move (drag-drop onto a folder): rename the item under the target
    // directory. Guards against no-op and moving a directory into itself or its
    // own subtree.
    const onMove = (fromPath: string, toDir: string) => {
      const name = fromPath.split("/").pop() || "";
      if (!name) return;
      if (toDir === parentPath(fromPath)) return; // already there
      if (toDir === fromPath || toDir.startsWith(`${fromPath}/`)) return; // into self
      const to = joinPath(toDir, name);
      if (to !== fromPath) send({ t: "sftp-rename", from: fromPath, to });
    };

    const onChmod = (entry: FileEntry) => {
      setDialog({
        title: `Permissions for “${entry.name}”`,
        input: {
          label: "Octal mode (e.g. 644)",
          initialValue: modeToOctal(entry.mode),
        },
        confirmLabel: "Apply",
        validate: (v) =>
          parseOctalMode(v) === null ? "Use 3–4 octal digits like 644." : null,
        onConfirm: (v) => {
          const mode = parseOctalMode(v);
          if (mode !== null) {
            send({ t: "sftp-chmod", path: joinPath(cwd, entry.name), mode });
          }
        },
      });
    };

    return {
      onDelete,
      onDeleteMany,
      onMkdir,
      onTouch,
      onRename,
      onCopy,
      onMove,
      onChmod,
    };
  }, [cwd, entries, send, setDialog]);
}
