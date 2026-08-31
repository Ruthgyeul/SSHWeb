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
    onResumeDownload: vi.fn(),
    canElevate: false,
    elevated: false,
    elevatedPending: false,
    onToggleElevated: vi.fn(),
    active: true,
    onOpenTerminalHere: vi.fn(),
    onDiskUsage: vi.fn(),
    onCopyPath: vi.fn(),
    onNavigate: vi.fn(),
    onDownload: vi.fn(),
    onDownloadDir: vi.fn(),
    onDownloadMany: vi.fn(),
    onDelete: vi.fn(),
    onDeleteMany: vi.fn(),
    onUpload: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
    onChmod: vi.fn(),
    onDiff: vi.fn(),
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
    expect(screen.getByText(/this directory is empty/i)).toBeInTheDocument();
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

describe("FileBrowser hidden files (#70)", () => {
  it("always shows dotfiles (no hide toggle)", () => {
    renderBrowser([file(".env", 1), file("visible.txt", 2)]);
    expect(rowOrder()).toEqual([".env", "visible.txt"]);
    expect(screen.queryByLabelText("Toggle hidden files")).toBeNull();
  });
});

describe("FileBrowser go-to-path (#69)", () => {
  it("navigates to an absolute path typed into the go-to bar", () => {
    const { props } = renderBrowser([file("a.txt", 1)]);
    fireEvent.click(screen.getByLabelText("Toggle go-to-path"));
    const input = screen.getByLabelText("Go to path") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/var/log" } });
    fireEvent.submit(input.closest("form")!);
    expect(props.onNavigate).toHaveBeenCalledWith("/var/log");
  });
});

describe("FileBrowser copy path (#72)", () => {
  it("copies the current directory from the toolbar", () => {
    const { props } = renderBrowser([file("a.txt", 1)], { cwd: "/home/u" });
    fireEvent.click(screen.getByLabelText("Copy current path"));
    expect(props.onCopyPath).toHaveBeenCalledWith("/home/u");
  });
});

describe("FileBrowser columns (#71)", () => {
  it("always shows the Size/Perms/Owner/Modified columns (no toggle chips)", () => {
    renderBrowser([file("a.txt", 1)]);
    // The list-view column headers are always present now.
    expect(
      screen.getByRole("button", { name: "Sort by size" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Perms" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Owner" }),
    ).toBeInTheDocument();
    // There is no "Columns" toggle group any more.
    expect(screen.queryByRole("group", { name: "Columns" })).toBeNull();
  });
});

describe("FileBrowser spacebar quicklook (#68)", () => {
  it("opens the preview for a single selected previewable file", () => {
    const { props } = renderBrowser([file("photo.jpg", 10)], {
      cwd: "/home/u",
    });
    fireEvent.click(screen.getByLabelText("Select photo.jpg"));
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.onPreview).toHaveBeenCalledWith(
      "/home/u/photo.jpg",
      "photo.jpg",
      expect.any(Array),
    );
  });

  it("does nothing when more than one file is selected", () => {
    const { props } = renderBrowser([file("a.jpg", 1), file("b.jpg", 2)]);
    fireEvent.click(screen.getByLabelText("Select all"));
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.onPreview).not.toHaveBeenCalled();
  });
});

describe("FileBrowser dotfile-only folder + quicklook scoping (Codex #135)", () => {
  it("lists dotfiles directly, without an 'empty' or hidden-items affordance", () => {
    renderBrowser([file(".env", 1), file(".gitignore", 2)]);
    expect(screen.queryByText("This directory is empty")).toBeNull();
    expect(rowOrder()).toEqual([".env", ".gitignore"]);
  });

  it("does not handle spacebar quicklook when the browser is inactive", () => {
    const { props } = renderBrowser([file("photo.jpg", 1)], { active: false });
    fireEvent.click(screen.getByLabelText("Select photo.jpg"));
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(props.onPreview).not.toHaveBeenCalled();
  });
});

describe("FileBrowser toolbar — merged New / Upload / go-to (Phase 8)", () => {
  it("fires onCreate from the merged New button", () => {
    const { props } = renderBrowser([file("a.txt", 1)]);
    fireEvent.click(screen.getByLabelText("New file or folder"));
    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("opens the Upload menu (Files / Folder) and closes it on Escape", () => {
    renderBrowser([file("a.txt", 1)]);
    // The menu items aren't rendered until the trigger is clicked.
    expect(screen.queryByRole("menuitem", { name: "Files" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByRole("menuitem", { name: "Files" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Folder" }),
    ).toBeInTheDocument();
    // Escape (from within the menu) closes it.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Files" })).toBeNull();
  });

  it("closes the Upload menu when its trigger is clicked again", () => {
    renderBrowser([file("a.txt", 1)]);
    const trigger = screen.getByRole("button", { name: "Upload" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Files" })).toBeInTheDocument();
    // A second click on the (now-expanded) trigger must close it, not reopen.
    fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { name: "Files" })).toBeNull();
  });

  it("closes the inline go-to editor on Escape, restoring the breadcrumb", () => {
    const { props } = renderBrowser([file("a.txt", 1)], { cwd: "/home/u" });
    fireEvent.click(screen.getByLabelText("Toggle go-to-path"));
    const input = screen.getByLabelText("Go to path") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Go to path")).toBeNull();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});

describe("FileBrowser grid view (Phase 8)", () => {
  it("renders tiles after switching to grid view", () => {
    renderBrowser([file("photo.jpg", 10), file("notes.txt", 2)]);
    // The grid tile's open button (aria-label "Open <name>") is grid-only.
    expect(screen.queryByLabelText("Open photo.jpg")).toBeNull();
    fireEvent.click(screen.getByLabelText("Grid view"));
    expect(screen.getByLabelText("Open photo.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("Open notes.txt")).toBeInTheDocument();
  });
});
