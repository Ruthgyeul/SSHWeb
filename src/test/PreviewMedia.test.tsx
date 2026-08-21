// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";

import { PreviewMedia } from "@/components/ssh/preview/PreviewMedia";
import { PreviewFilmstrip } from "@/components/ssh/preview/PreviewFilmstrip";
import type { ImageTransform } from "@/components/ssh/hooks/useImageTransform";

/** A no-op image transform for rendering the media pane. */
function stubTransform(): ImageTransform {
  return {
    zoom: 1,
    rotation: 0,
    offset: { x: 0, y: 0 },
    dragging: false,
    zoomBy: vi.fn(),
    resetView: vi.fn(),
    rotate: vi.fn(),
    onWheel: vi.fn(),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    endDrag: vi.fn(),
  };
}

function renderMedia(over: Partial<Parameters<typeof PreviewMedia>[0]> = {}) {
  const props: Parameters<typeof PreviewMedia>[0] = {
    kind: "image",
    name: "photo.jpg",
    src: "blob:img",
    loading: false,
    spinner: <div data-testid="spinner" />,
    galleryArrows: null,
    transform: stubTransform(),
    onImageLoad: vi.fn(),
    onDownload: vi.fn(),
    videoRef: createRef(),
    video: { src: "", rate: 1, onError: vi.fn() },
    hasGallery: false,
    onClose: vi.fn(),
    ...over,
  };
  return render(<PreviewMedia {...props} />);
}

describe("PreviewMedia", () => {
  it("renders an <img> for the image kind", () => {
    const { container } = renderMedia({ kind: "image", src: "blob:img" });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "blob:img");
  });

  it("renders a <video> with the resolved source and poster for the video kind", () => {
    const { container } = renderMedia({
      kind: "video",
      placeholder: "blob:poster",
      video: { src: "blob:clip", rate: 1, onError: vi.fn() },
    });
    const v = container.querySelector("video");
    expect(v).not.toBeNull();
    expect(v).toHaveAttribute("src", "blob:clip");
    expect(v).toHaveAttribute("poster", "blob:poster");
  });

  it("shows a speed badge only when the playback rate is not 1×", () => {
    const { rerender, container } = renderMedia({
      kind: "video",
      video: { src: "blob:clip", rate: 1, onError: vi.fn() },
    });
    expect(container.textContent).not.toContain("×");
    rerender(
      <PreviewMedia
        kind="video"
        name="clip.mp4"
        src=""
        loading={false}
        spinner={null}
        galleryArrows={null}
        transform={stubTransform()}
        onImageLoad={vi.fn()}
        onDownload={vi.fn()}
        videoRef={createRef()}
        video={{ src: "blob:clip", rate: 1.5, onError: vi.fn() }}
        hasGallery={false}
        onClose={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("1.5×");
  });

  it("renders an <audio> element for the audio kind", () => {
    const { container } = renderMedia({ kind: "audio", src: "blob:song" });
    const a = container.querySelector("audio");
    expect(a).not.toBeNull();
    expect(a).toHaveAttribute("src", "blob:song");
  });

  it("shows a download-only card for the unsupported kind", () => {
    renderMedia({ kind: "unsupported", src: "" });
    expect(screen.getByText(/can.t be previewed inline/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download to open it locally/i }),
    ).toBeInTheDocument();
  });
});

describe("PreviewFilmstrip", () => {
  const entries = [
    { path: "/a.jpg", name: "a.jpg", thumb: "blob:a" },
    { path: "/b.jpg", name: "b.jpg" },
  ];

  it("renders a tile per entry and marks the active one", () => {
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.jpg"
        activeRef={createRef()}
        onJump={vi.fn()}
      />,
    );
    const tiles = screen.getAllByRole("button");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveAttribute("aria-current", "true");
    expect(tiles[1]).toHaveAttribute("aria-current", "false");
  });

  it("jumps to a sibling on click", () => {
    const onJump = vi.fn();
    render(
      <PreviewFilmstrip
        entries={entries}
        activePath="/a.jpg"
        activeRef={createRef()}
        onJump={onJump}
      />,
    );
    screen.getByTitle("b.jpg").click();
    expect(onJump).toHaveBeenCalledWith("/b.jpg");
  });
});
