// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFileActions } from "@/components/ssh/hooks/useFileActions";
import type { DialogRequest } from "@/components/ssh/PromptDialog";
import type { ClientMessage, FileEntry } from "@/lib/sshProtocol";

const file: FileEntry = {
  name: "a.txt",
  type: "file",
  size: 10,
  mtime: 0,
  mode: 0o644,
};
const dir: FileEntry = {
  name: "logs",
  type: "dir",
  size: 0,
  mtime: 0,
  mode: 0o755,
};

function setup() {
  const send = vi.fn<(m: ClientMessage) => void>();
  const setDialog = vi.fn<(r: DialogRequest | null) => void>();
  const { result } = renderHook(() =>
    useFileActions({ cwd: "/home/me", send, setDialog }),
  );
  const lastDialog = () =>
    setDialog.mock.calls.at(-1)?.[0] as DialogRequest & {
      onConfirm: (v: string) => void;
    };
  return { actions: result.current, send, setDialog, lastDialog };
}

describe("useFileActions", () => {
  it("deletes a file after confirm", () => {
    const { actions, send, lastDialog } = setup();
    actions.onDelete(file);
    const d = lastDialog();
    expect(d.danger).toBe(true);
    d.onConfirm("");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rm",
      path: "/home/me/a.txt",
      dir: false,
    });
  });

  it("bulk-deletes each selected entry", () => {
    const { actions, send, lastDialog } = setup();
    actions.onDeleteMany([file, dir]);
    lastDialog().onConfirm("");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rm",
      path: "/home/me/a.txt",
      dir: false,
    });
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rm",
      path: "/home/me/logs",
      dir: true,
    });
  });

  it("does nothing on an empty bulk delete", () => {
    const { actions, setDialog } = setup();
    actions.onDeleteMany([]);
    expect(setDialog).not.toHaveBeenCalled();
  });

  it("creates a file, or a folder when the name ends with /", () => {
    const { actions, send, lastDialog } = setup();
    // A plain name → empty file.
    actions.onCreate();
    // A slash-only name normalizes to nothing and must be rejected, not
    // silently accepted (which would close the dialog with nothing created).
    expect(lastDialog().validate?.("/")).toBeTruthy();
    expect(lastDialog().validate?.("///")).toBeTruthy();
    expect(lastDialog().validate?.("logs/")).toBeNull();
    lastDialog().onConfirm("  notes.txt  ");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-write",
      path: "/home/me/notes.txt",
      dataB64: "",
    });
    // A trailing slash → directory (slash stripped).
    actions.onCreate();
    lastDialog().onConfirm("logs/");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-mkdir",
      path: "/home/me/logs",
    });
  });

  it("renames only when the name actually changed", () => {
    const { actions, send, lastDialog } = setup();
    actions.onRename(file);
    lastDialog().onConfirm("a.txt"); // unchanged
    expect(send).not.toHaveBeenCalled();
    lastDialog().onConfirm("b.txt");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rename",
      from: "/home/me/a.txt",
      to: "/home/me/b.txt",
    });
  });

  it("row mv is unified with the preview: a full path input that also moves", () => {
    const { actions, send, lastDialog } = setup();
    actions.onRename(file);
    const d = lastDialog();
    // The dialog now pre-fills the absolute path (rename + move in one input),
    // matching the preview modal's mv.
    expect(d.input?.initialValue).toBe("/home/me/a.txt");
    // Editing the folder moves the file out of cwd.
    d.onConfirm("/home/me/archive/a.txt");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rename",
      from: "/home/me/a.txt",
      to: "/home/me/archive/a.txt",
    });
  });

  it("validates the chmod octal mode", () => {
    const { actions, send, lastDialog } = setup();
    actions.onChmod(file);
    const d = lastDialog();
    expect(d.validate?.("xyz")).toBeTruthy();
    expect(d.validate?.("644")).toBeNull();
    d.onConfirm("600");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-chmod",
      path: "/home/me/a.txt",
      mode: 0o600,
    });
  });

  it("deletes an absolute path (preview modal) and fires onConfirmed", () => {
    const { actions, send, lastDialog } = setup();
    const onConfirmed = vi.fn();
    // A search hit outside cwd — the path is used verbatim, not re-joined.
    actions.onDeletePath("/var/log/syslog", false, "syslog", onConfirmed);
    const d = lastDialog();
    expect(d.danger).toBe(true);
    d.onConfirm("");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rm",
      path: "/var/log/syslog",
      dir: false,
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("moves/renames an absolute path via one destination input", () => {
    const { actions, send, lastDialog } = setup();
    const onConfirmed = vi.fn();
    // A file nested below cwd, so a bare name must resolve against its parent.
    actions.onMovePath("/home/me/photos/a.jpg", "a.jpg", onConfirmed);
    const d = lastDialog();
    expect(d.input?.initialValue).toBe("/home/me/photos/a.jpg");
    // Empty is rejected; a bare name equal to the current one resolves back to
    // the same path and is rejected; a different bare name is allowed.
    expect(d.validate?.("  ")).toBeTruthy();
    expect(d.validate?.("a.jpg")).toBeTruthy();
    expect(d.validate?.("b.jpg")).toBeNull();
    // A bare filename renames IN the source folder (not the SFTP home dir).
    d.onConfirm("b.jpg");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rename",
      from: "/home/me/photos/a.jpg",
      to: "/home/me/photos/b.jpg",
    });
    expect(onConfirmed).toHaveBeenLastCalledWith("/home/me/photos/b.jpg");
    // An absolute destination moves to another folder verbatim.
    d.onConfirm("/home/me/archive/a.jpg");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rename",
      from: "/home/me/photos/a.jpg",
      to: "/home/me/archive/a.jpg",
    });
    expect(onConfirmed).toHaveBeenLastCalledWith("/home/me/archive/a.jpg");
  });

  it("moves an entry into a folder, guarding no-ops and self-moves", () => {
    const { actions, send } = setup();
    // No-op: already in the target directory.
    actions.onMove("/home/me/a.txt", "/home/me");
    // Into itself / own subtree.
    actions.onMove("/home/me/dir", "/home/me/dir/sub");
    expect(send).not.toHaveBeenCalled();
    // A real move.
    actions.onMove("/home/me/a.txt", "/home/me/logs");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-rename",
      from: "/home/me/a.txt",
      to: "/home/me/logs/a.txt",
    });
  });
});
