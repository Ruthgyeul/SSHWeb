// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { FilePreview, type PreviewMode } from "@/components/ssh/FilePreview";

/**
 * Characterization tests for FilePreview's rendering, written before any
 * refactor so the per-kind render tree is locked: if a decomposition changes
 * what the modal shows for a given `kind`, these go red. They assert on the
 * produced DOM (via the jsdom harness), not internals.
 */
function renderPreview(overrides: {
  kind: PreviewMode;
  name?: string;
  path?: string;
  src?: string;
  text?: string;
  loading?: boolean;
  index?: number;
  count?: number;
}) {
  const props = {
    name: "file.txt",
    path: "/home/user/file.txt",
    src: "",
    onDownload: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return render(<FilePreview {...props} />);
}

describe("FilePreview rendering by kind", () => {
  it("renders Markdown as sanitized HTML in a .md-preview pane", () => {
    const { container } = renderPreview({
      kind: "markdown",
      name: "readme.md",
      text: "# Hello World",
    });
    const pane = container.querySelector(".md-preview");
    expect(pane).not.toBeNull();
    expect(within(pane as HTMLElement).getByRole("heading")).toHaveTextContent(
      "Hello World",
    );
  });

  it("renders a PDF in a titled iframe pointing at the blob src", () => {
    const { container } = renderPreview({
      kind: "pdf",
      name: "doc.pdf",
      src: "blob:pdf-src",
    });
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("src", "blob:pdf-src");
    expect(iframe).toHaveAttribute("title", "doc.pdf");
  });

  it("renders text with a line-number gutter and the content", () => {
    const { container } = renderPreview({
      kind: "text",
      name: "notes.txt",
      text: "alpha\nbeta\ngamma",
    });
    // Gutter is an aria-hidden <pre> with one number per line.
    const gutter = container.querySelector('pre[aria-hidden="true"]');
    expect(gutter).not.toBeNull();
    expect(gutter).toHaveTextContent("1");
    expect(gutter).toHaveTextContent("3");
    expect(container).toHaveTextContent("alpha");
    expect(container).toHaveTextContent("gamma");
  });

  it("renders an image element for the image kind", () => {
    const { container } = renderPreview({
      kind: "image",
      name: "photo.jpg",
      src: "blob:img-src",
    });
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.some((img) => img.getAttribute("src") === "blob:img-src")).toBe(
      true,
    );
  });

  it("shows a download-only card for an unsupported file", () => {
    renderPreview({ kind: "unsupported", name: "app.bin", src: "" });
    expect(
      screen.getByText(/can.t be previewed inline/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download to open it locally/i }),
    ).toBeInTheDocument();
  });

  it("shows the gallery position counter when there are siblings", () => {
    renderPreview({
      kind: "image",
      name: "photo.jpg",
      src: "blob:x",
      index: 1,
      count: 5,
    });
    expect(screen.getByText("2 / 5")).toBeInTheDocument();
  });

  it("always offers a Close control", () => {
    renderPreview({ kind: "text", text: "hi" });
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });
});
