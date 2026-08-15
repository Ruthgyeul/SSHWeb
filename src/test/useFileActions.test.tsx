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

function setup(entries: FileEntry[] = [file]) {
  const send = vi.fn<(m: ClientMessage) => void>();
  const setDialog = vi.fn<(r: DialogRequest | null) => void>();
  const { result } = renderHook(() =>
    useFileActions({ cwd: "/home/me", entries, send, setDialog }),
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

  it("makes a directory joined under cwd", () => {
    const { actions, send, lastDialog } = setup();
    actions.onMkdir();
    lastDialog().onConfirm("  new  ");
    expect(send).toHaveBeenCalledWith({
      t: "sftp-mkdir",
      path: "/home/me/new",
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

  it("suggests a non-colliding duplicate name", () => {
    const { actions, lastDialog } = setup([file]);
    actions.onCopy(file);
    const d = lastDialog();
    expect(d.input?.initialValue).toBe("a copy.txt");
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
