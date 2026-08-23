// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileBrowser } from "@/components/ssh/FileBrowser";
import type { FileEntry } from "@/lib/sshProtocol";

afterEach(() => {
  // useFileViewMode / useFileSort / the filter box all key off localStorage.
  localStorage.clear();
});

function file(name: string, size: number, mtime = 0): FileEntry {
  return { name, type: "file", size, mtime, mode: 0o100644 };
}

function renderBrowser(
  entries: FileEntry[],
  overrides: Partial<React.ComponentProps<typeof FileBrowser>> = {},
) {
  const props = {
    cwd: "/home/u",
    entries,
    loading: false,
    uploads: [],
    downloads: [],
    onCancelUpload: vi.fn(),
    onCancelAllUploads: vi.fn(),
    onResumeUpload: vi.fn(),
    onCancelDownload: vi.fn(),
    canElevate: false,
    elevated: false,
    elevatedPending: false,
    onToggleElevated: vi.fn(),
    onOpenTerminalHere: vi.fn(),
    onNavigate: vi.fn(),
    onDownload: vi.fn(),
    onDownloadDir: vi.fn(),
    onDownloadMany: vi.fn(),
    onDelete: vi.fn(),
    onDeleteMany: vi.fn(),
    onUpload: vi.fn(),
    onMkdir: vi.fn(),
    onTouch: vi.fn(),
    onRename: vi.fn(),
    onCopy: vi.fn(),
    onMove: vi.fn(),
    onChmod: vi.fn(),
    onSymlink: vi.fn(),
    onChecksum: vi.fn(),
    onEdit: vi.fn(),
    onPreview: vi.fn(),
    onOpenUnsupported: vi.fn(),
    onRefresh: vi.fn(),
    thumbnails: {},
    thumbBg: {},
    onRequestThumbnail: vi.fn(),
    onThumbnailVisibility: vi.fn(),
    search: null,
    onSearch: vi.fn(),
    onClearSearch: vi.fn(),
    ...overrides,
  };
  const utils = render(<FileBrowser {...props} />);
  return { ...utils, props };
}

/** The ordered file names, read from the per-row "Select <name>" checkboxes. */
function rowOrder(): string[] {
  return screen
    .getAllByLabelText(/^Select .+/)
    .map((el) => el.getAttribute("aria-label")!.replace(/^Select /, ""))
    .filter((name) => name !== "all");
}

describe("FileBrowser empty + listing states", () => {
  it("shows an empty-directory message when there are no entries", () => {
    renderBrowser([]);
    expect(screen.getByText("This directory is empty")).toBeInTheDocument();
  });

  it("renders a row per entry in the default (name asc) order", () => {
    renderBrowser([file("b.txt", 300), file("a.txt", 100), file("c.txt", 200)]);
    expect(rowOrder()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

describe("FileBrowser name filter", () => {
  it("narrows the listing to matching names (case-insensitive)", () => {
    renderBrowser([file("alpha.log", 1), file("beta.txt", 2)]);
    fireEvent.change(screen.getByLabelText("Filter files by name"), {
      target: { value: "ALPHA" },
    });
    expect(rowOrder()).toEqual(["alpha.log"]);
  });

  it("shows a no-match message when nothing matches the filter", () => {
    renderBrowser([file("alpha.log", 1), file("beta.txt", 2)]);
    fireEvent.change(screen.getByLabelText("Filter files by name"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText(/No files match/)).toBeInTheDocument();
    expect(rowOrder()).toEqual([]);
  });
});

describe("FileBrowser selection", () => {
  it("select-all checks every visible row", () => {
    renderBrowser([file("a.txt", 1), file("b.txt", 2)]);
    const selectAll = screen.getByLabelText("Select all") as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(
      (screen.getByLabelText("Select a.txt") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Select b.txt") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("select-all only acts on the filtered rows", () => {
    renderBrowser([file("keep.txt", 1), file("drop.log", 2)]);
    fireEvent.change(screen.getByLabelText("Filter files by name"), {
      target: { value: "keep" },
    });
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(
      (screen.getByLabelText("Select keep.txt") as HTMLInputElement).checked,
    ).toBe(true);
    // The filtered-out row isn't rendered, so it can't be selected.
    expect(screen.queryByLabelText("Select drop.log")).toBeNull();
  });
});

describe("FileBrowser sort headers", () => {
  it("sorts by size on the column header (desc first, then asc)", () => {
    renderBrowser([file("a.txt", 100), file("b.txt", 300), file("c.txt", 200)]);
    const sizeHeader = screen.getByRole("button", { name: "Sort by size" });

    // First click on size → its natural direction is descending (largest first).
    fireEvent.click(sizeHeader);
    expect(rowOrder()).toEqual(["b.txt", "c.txt", "a.txt"]);
    expect(sizeHeader).toHaveAttribute("aria-pressed", "true");

    // Second click flips to ascending (smallest first).
    fireEvent.click(sizeHeader);
    expect(rowOrder()).toEqual(["a.txt", "c.txt", "b.txt"]);
  });

  it("always groups directories ahead of files regardless of the key", () => {
    const dir: FileEntry = {
      name: "zzz-dir",
      type: "dir",
      size: 0,
      mtime: 0,
      mode: 0o040755,
    };
    renderBrowser([file("a.txt", 100), dir, file("b.txt", 200)]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
    // Directory first even though its name sorts last alphabetically.
    expect(rowOrder()[0]).toBe("zzz-dir");
  });
});
