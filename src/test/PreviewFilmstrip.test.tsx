// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PreviewFilmstrip,
  type FilmstripEntry,
} from "@/components/ssh/preview/PreviewFilmstrip";

const entries: FilmstripEntry[] = [
  { path: "/a.png", name: "a.png", thumb: "data:image/webp;base64,AAAA" },
  { path: "/b.txt", name: "b.txt" }, // no thumb → icon
];

describe("PreviewFilmstrip", () => {
  it("renders a tile per entry and marks the active one", () => {
    const activeRef = createRef<HTMLButtonElement>();
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.png"
        activeRef={activeRef}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );
    // 2 tiles + the collapse handle.
    expect(screen.getAllByRole("button")).toHaveLength(3);

    const active = screen.getByTitle("a.png");
    expect(active).toHaveAttribute("aria-current", "true");
    expect(active.className).toContain("border-term-accent");
    // The active tile is wired to the parent's ref for scroll-into-view.
    expect(activeRef.current).toBe(active);

    const inactive = screen.getByTitle("b.txt");
    expect(inactive).toHaveAttribute("aria-current", "false");
  });

  it("shows a thumbnail image when present, otherwise a type icon", () => {
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.png"
        activeRef={createRef()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );
    const img = screen.getByAltText("a.png") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toContain("data:image/webp");
    // The thumbless entry renders no <img>.
    expect(screen.queryByAltText("b.txt")).toBeNull();
  });

  it("calls onJump with the clicked tile's path", () => {
    const onJump = vi.fn();
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.png"
        activeRef={createRef()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByTitle("b.txt"));
    expect(onJump).toHaveBeenCalledWith("/b.txt");
  });

  it("collapses to a single handle button and hides the tiles", () => {
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.png"
        activeRef={createRef()}
        collapsed={true}
        onToggleCollapsed={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByTitle("a.png")).toBeNull();
    expect(
      screen.getByRole("button", { name: /show filmstrip/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles collapsed state via the handle button", () => {
    const onToggleCollapsed = vi.fn();
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.png"
        activeRef={createRef()}
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /hide filmstrip/i }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
