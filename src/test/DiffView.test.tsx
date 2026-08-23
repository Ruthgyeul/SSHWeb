// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "@/components/ssh/DiffView";

describe("DiffView", () => {
  it("renders the two file names and an add/remove summary", () => {
    render(
      <DiffView
        a={{ name: "old.txt", content: "a\nb\nc" }}
        b={{ name: "new.txt", content: "a\nB\nc" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/old\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/new\.txt/)).toBeInTheDocument();
    // One line changed → +1 / −1.
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });

  it("shows removed and added line content", () => {
    render(
      <DiffView
        a={{ name: "a", content: "keep\ngone" }}
        b={{ name: "b", content: "keep\nfresh" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("gone")).toBeInTheDocument();
    expect(screen.getByText("fresh")).toBeInTheDocument();
  });

  it("closes via the close button", () => {
    const onClose = vi.fn();
    render(
      <DiffView
        a={{ name: "a", content: "x" }}
        b={{ name: "b", content: "y" }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close diff"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
