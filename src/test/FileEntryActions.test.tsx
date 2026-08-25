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
      screen.queryByRole("button", { name: "Change permissions" }),
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
    expect(
      screen.getByRole("button", { name: "Change permissions" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change permissions" }));
    expect(h.onChmod).toHaveBeenCalledWith(file);
  });

  it("edits a text file (reading is done in the editor, so no preview eye)", () => {
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
    // An editable-only file gets no separate read-only preview button.
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("shows a single preview eye for a rich-previewable file", () => {
    const h = handlers();
    render(
      <FileEntryActions
        entry={{ ...file, name: "readme.md" }}
        target="/x/readme.md"
        isDir={false}
        editable
        previewable
        previewSiblings={[]}
        {...h}
      />,
    );
    // Markdown is both previewable and editable, but only one preview eye shows.
    expect(screen.getAllByRole("button", { name: "Preview" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(h.onPreview).toHaveBeenCalledWith("/x/readme.md", "readme.md", []);
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

  it("renames and deletes (no duplicate action)", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Move / rename" }));
    expect(h.onRename).toHaveBeenCalledWith(file);
    // The duplicate (cp) action has been removed.
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(h.onDelete).toHaveBeenCalledWith(file);
  });

  it("orders the row actions edit → mv → chmod → download → delete", () => {
    const h = handlers();
    render(
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
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Edit",
      "Move / rename",
      "Change permissions",
      "Download",
      "Delete",
    ]);
  });
});
