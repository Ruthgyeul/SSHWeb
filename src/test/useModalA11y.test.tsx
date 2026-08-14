// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useModalA11y } from "@/components/ssh/hooks/useModalA11y";

function Modal({
  onClose,
  closeOnEscape,
}: {
  onClose: () => void;
  closeOnEscape?: boolean;
}) {
  const ref = useModalA11y<HTMLDivElement>({ onClose, closeOnEscape });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button>first</button>
      <button>last</button>
    </div>
  );
}

describe("useModalA11y", () => {
  it("moves focus into the dialog on open", () => {
    render(<Modal onClose={() => {}} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "first" }),
    );
  });

  it("closes on Escape by default", () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape when closeOnEscape is false", () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} closeOnEscape={false} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps focus with Tab / Shift+Tab at the edges", () => {
    render(<Modal onClose={() => {}} />);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    const dialog = screen.getByRole("dialog");

    // At the first element, Shift+Tab wraps to the last.
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // At the last element, Tab wraps to the first.
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("restores focus to the opener when it unmounts", () => {
    document.body.innerHTML = '<button id="opener">open</button>';
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<Modal onClose={() => {}} />);
    // Focus moved into the dialog.
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
  });
});
