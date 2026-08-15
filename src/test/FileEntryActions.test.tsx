// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileEntryActions } from "@/components/ssh/FileEntryActions";
import type { FileEntry } from "@/lib/sshProtocol";

const file: FileEntry = {
  name: "report.txt",
  type: "file",
  size: 128,
  mtime: 0,
  mode: 0o644,
};
const dir: FileEntry = {
  name: "docs",
  type: "dir",
  size: 0,
  mtime: 0,
  mode: 0o755,
};

const handlers = () => ({
  onPreview: vi.fn(),
  onEdit: vi.fn(),
  onDownload: vi.fn(),
  onDownloadDir: vi.fn(),
  onRename: vi.fn(),
  onCopy: vi.fn(),
  onChmod: vi.fn(),
  onDelete: vi.fn(),
});

describe("FileEntryActions", () => {
  it("shows chmod only when showChmod is set (list view)", () => {
    const h = handlers();
    const { rerender } = render(
      <FileEntryActions
        entry={file}
        target="/x/report.txt"
        isDir={false}
        editable
        previewable={false}
        previewSiblings={[]}
        {...h}
      />,
    );
    // Grid view (default): no chmod button.
    expect(
      screen.queryByRole("button", { name: "chmod" }),
    ).not.toBeInTheDocument();

    rerender(
      <FileEntryActions
        entry={file}
        target="/x/report.txt"
        isDir={false}
        editable
        previewable={false}
        previewSiblings={[]}
        showChmod
        {...h}
      />,
    );
    expect(screen.getByRole("button", { name: "chmod" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "chmod" }));
    expect(h.onChmod).toHaveBeenCalledWith(file);
  });

  it("edits and read-only-previews a text file", () => {
    const h = handlers();
    render(
      <FileEntryActions
        entry={file}
        target="/x/report.txt"
        isDir={false}
        editable
        previewable={false}
        previewSiblings={[]}
        {...h}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(h.onEdit).toHaveBeenCalledWith("/x/report.txt", "report.txt", 128);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview (read-only)" }),
    );
    expect(h.onPreview).toHaveBeenCalledWith("/x/report.txt", "report.txt", []);
  });

  it("downloads a directory as a zip", () => {
    const h = handlers();
    render(
      <FileEntryActions
        entry={dir}
        target="/x/docs"
        isDir
        editable={false}
        previewable={false}
        previewSiblings={[]}
        {...h}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download as zip" }));
    expect(h.onDownloadDir).toHaveBeenCalledWith("/x/docs");
    expect(h.onDownload).not.toHaveBeenCalled();
    // A directory has no preview/edit buttons.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("renames, duplicates, and deletes", () => {
    const h = handlers();
    render(
      <FileEntryActions
        entry={file}
        target="/x/report.txt"
        isDir={false}
        editable={false}
        previewable={false}
        previewSiblings={[]}
        {...h}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mv" }));
    expect(h.onRename).toHaveBeenCalledWith(file);
    fireEvent.click(screen.getByRole("button", { name: "cp" }));
    expect(h.onCopy).toHaveBeenCalledWith(file);
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(h.onDelete).toHaveBeenCalledWith(file);
  });
});
