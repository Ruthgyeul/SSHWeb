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

    // The file-browser row "mv" action: the same single destination-path dialog
    // as the preview modal, so renaming (edit the final segment) and moving (edit
    // the folder) are one unified action in both places. Delegates to
    // `onMovePath` with the entry's absolute path.
    const onRename = (entry: FileEntry) =>
      onMovePath(joinPath(cwd, entry.name), entry.name);

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

    // Path-based delete for the preview modal, which knows an absolute path (and
    // may be viewing a search hit outside `cwd`) rather than a `cwd`-relative
    // `FileEntry`. `onConfirmed` runs when the user accepts the dialog so the
    // caller can record the pending mutation and reconcile it on the `sftp-ok`.
    const onDeletePath = (
      path: string,
      isDir: boolean,
      name: string,
      onConfirmed?: () => void,
    ) => {
      setDialog({
        title: `Delete “${name}”?`,
        message: isDir
          ? "The directory must be empty. This cannot be undone."
          : "This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => {
          send({ t: "sftp-rm", path, dir: isDir });
          onConfirmed?.();
        },
      });
    };

    // Path-based move/rename for the preview modal: one absolute-path input, so
    // editing just the final segment renames in place while changing the
    // directory moves the file — the shell `mv src dest` semantics. `onConfirmed`
    // receives the destination path for `sftp-ok` reconciliation.
    const onMovePath = (
      fromPath: string,
      name: string,
      onConfirmed?: (toPath: string) => void,
    ) => {
      // Resolve the entered destination: an absolute path is used as-is, a bare
      // value (e.g. just a new filename) is resolved against the source's parent
      // — so typing "b.jpg" renames in place instead of moving the file to the
      // SFTP session's default directory.
      const resolve = (raw: string) =>
        raw.startsWith("/") ? raw : joinPath(parentPath(fromPath), raw);
      setDialog({
        title: `Move / rename “${name}”`,
        message: "Edit the name to rename, or the folder to move it.",
        input: { label: "Destination path", initialValue: fromPath },
        confirmLabel: "Move",
        validate: (v) => {
          const next = v.trim();
          if (!next) return "Please enter a destination path.";
          if (resolve(next) === fromPath)
            return "Enter a different name or folder.";
          return null;
        },
        onConfirm: (v) => {
          const raw = v.trim();
          const to = resolve(raw);
          if (to && to !== fromPath) {
            send({ t: "sftp-rename", from: fromPath, to });
            onConfirmed?.(to);
          }
        },
      });
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
      onDeletePath,
      onMovePath,
      onChmod,
    };
  }, [cwd, entries, send, setDialog]);
}
