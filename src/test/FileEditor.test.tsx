// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileEditor, type EditorFile } from "@/components/ssh/FileEditor";

/** The main code textarea is the only <textarea> in the editor (the find/replace
 * fields are <input>s), so it's unambiguous to grab directly. */
function editorTextarea(container: HTMLElement): HTMLTextAreaElement {
  const ta = container.querySelector("textarea");
  if (!ta) throw new Error("editor textarea not found");
  return ta;
}

function renderEditor(
  files: EditorFile[],
  overrides: Partial<React.ComponentProps<typeof FileEditor>> = {},
) {
  const props = {
    files,
    activePath: files[0]?.path ?? "",
    savingPath: null,
    onSave: vi.fn(),
    onSelect: vi.fn(),
    onCloseFile: vi.fn(),
    onCloseAll: vi.fn(),
    ...overrides,
  };
  const utils = render(<FileEditor {...props} />);
  return { ...utils, props };
}

const fileA: EditorFile = {
  path: "/home/u/a.txt",
  name: "a.txt",
  content: "alpha\nbeta\n",
};
const fileB: EditorFile = {
  path: "/home/u/b.txt",
  name: "b.txt",
  content: "gamma\n",
};

describe("FileEditor dirty tracking + save", () => {
  it("keeps Save disabled until the buffer diverges from server content", () => {
    const { container } = renderEditor([fileA]);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(editorTextarea(container), {
      target: { value: "alpha edited\nbeta\n" },
    });
    expect(save).toBeEnabled();
  });

  it("calls onSave with the active path and edited text", () => {
    const { container, props } = renderEditor([fileA]);
    fireEvent.change(editorTextarea(container), {
      target: { value: "changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSave).toHaveBeenCalledWith("/home/u/a.txt", "changed");
  });

  it("reflects a save via the savingPath prop", () => {
    const { rerender, props } = renderEditor([fileA], {
      savingPath: "/home/u/a.txt",
    });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    // After the save completes the button returns to its idle label.
    rerender(<FileEditor {...props} savingPath={null} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("FileEditor multi-tab buffers", () => {
  it("shows a tab per open file and selects on click", () => {
    const { props } = renderEditor([fileA, fileB]);
    // Tab close buttons are labelled per file; the tab strip only renders with >1 file.
    expect(
      screen.getByRole("button", { name: "Close a.txt" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close b.txt" }),
    ).toBeInTheDocument();

    // Clicking the b.txt tab name asks the parent to switch active file.
    const bTab = screen
      .getAllByTitle("/home/u/b.txt")
      .find((el) => el.tagName === "BUTTON");
    fireEvent.click(bTab!);
    expect(props.onSelect).toHaveBeenCalledWith("/home/u/b.txt");
  });

  it("preserves each file's edit buffer across tab switches", () => {
    const { container, rerender, props } = renderEditor([fileA, fileB], {
      activePath: fileA.path,
    });
    fireEvent.change(editorTextarea(container), {
      target: { value: "A edited" },
    });

    // Switch to B: its own (pristine) content shows, not A's buffer.
    rerender(<FileEditor {...props} activePath={fileB.path} />);
    expect(editorTextarea(container).value).toBe("gamma\n");

    // Switch back to A: the edit is still there.
    rerender(<FileEditor {...props} activePath={fileA.path} />);
    expect(editorTextarea(container).value).toBe("A edited");
  });
});

describe("FileEditor unsaved-changes guard", () => {
  it("confirms before closing a dirty editor and only discards on confirm", () => {
    const { container, props } = renderEditor([fileA]);
    fireEvent.change(editorTextarea(container), {
      target: { value: "dirty" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // The guard appears; nothing closed yet.
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(props.onCloseAll).not.toHaveBeenCalled();

    // "Keep editing" dismisses without closing.
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(props.onCloseAll).not.toHaveBeenCalled();

    // Re-open the guard and discard for real.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onCloseAll).toHaveBeenCalledTimes(1);
  });

  it("closes a pristine editor immediately with no prompt", () => {
    const { props } = renderEditor([fileA]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(props.onCloseAll).toHaveBeenCalledTimes(1);
  });
});

describe("FileEditor find / replace", () => {
  const repeated: EditorFile = {
    path: "/home/u/r.txt",
    name: "r.txt",
    content: "foo bar foo baz foo",
  };

  it("counts matches and replaces all occurrences into the buffer", () => {
    const { container } = renderEditor([repeated]);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    const find = screen.getByLabelText("Find") as HTMLInputElement;
    fireEvent.change(find, { target: { value: "foo" } });
    // The match counter shows 1/3 for three occurrences.
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Replace with"), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(editorTextarea(container).value).toBe("X bar X baz X");
  });

  it("honors the case-sensitivity toggle", () => {
    const mixed: EditorFile = {
      path: "/home/u/c.txt",
      name: "c.txt",
      content: "Foo foo FOO",
    };
    renderEditor([mixed]);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.change(screen.getByLabelText("Find"), {
      target: { value: "foo" },
    });
    // Case-insensitive by default → all three.
    expect(screen.getByText("1/3")).toBeInTheDocument();

    // Toggle "Aa" (match case) → only the exact-case "foo".
    fireEvent.click(screen.getByRole("button", { name: "Aa" }));
    expect(screen.getByText("1/1")).toBeInTheDocument();
  });
});
