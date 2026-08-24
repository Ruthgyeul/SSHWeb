// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  usePreviewGallery,
  type PreviewGalleryDeps,
} from "@/components/ssh/hooks/usePreviewGallery";
import type { PreviewState } from "@/components/ssh/preview/previewState";

/** A full deps bag with inert stubs; only the handful `pruneAndStep` touches
 * (`previewRef`, `setPreview`, `send`, `previewBuffersRef`, `openPreviewFile`)
 * carry behaviour. */
function makeDeps(preview: PreviewState | null) {
  const send = vi.fn();
  const setPreview = vi.fn();
  const deps: PreviewGalleryDeps = {
    send,
    setPreview,
    cachePreview: vi.fn(),
    previewCacheGet: vi.fn(() => null),
    previewCacheHas: vi.fn(() => false),
    previewRef: { current: preview },
    previewPathRef: { current: null },
    previewBuffersRef: { current: {} },
    previewMimeRef: { current: {} },
    prefetchPathsRef: { current: new Set() },
    originalLoadPathsRef: { current: new Set() },
    subtitleReadsRef: { current: new Map() },
    subtitleUrlRef: { current: null },
    thumbnailsRef: { current: {} },
    entriesRef: { current: [] },
    cwdRef: { current: "/" },
    elevatedRef: { current: false },
    streamTokenRef: { current: null },
    downloadCapRef: { current: 0 },
    entryVersionRef: { current: new Map() },
  };
  return { deps, send, setPreview };
}

function preview(over: Partial<PreviewState> = {}): PreviewState {
  return {
    path: "/a.jpg",
    name: "a.jpg",
    kind: "image",
    src: "blob:a",
    loading: false,
    siblings: [
      { path: "/a.jpg", name: "a.jpg" },
      { path: "/b.jpg", name: "b.jpg" },
    ],
    ...over,
  };
}

describe("usePreviewGallery.pruneAndStep", () => {
  it("steps to the next sibling when the current file is removed", () => {
    const { deps, send } = makeDeps(preview());
    const { result } = renderHook(() => usePreviewGallery(deps));
    result.current.pruneAndStep("/a.jpg");
    // openPreviewFile("/b.jpg") streams the next file in (no cache/stream token).
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ t: "sftp-read", path: "/b.jpg" }),
    );
  });

  it("closes the modal when the last file is removed", () => {
    const { deps, setPreview, send } = makeDeps(
      preview({ siblings: [{ path: "/a.jpg", name: "a.jpg" }] }),
    );
    const { result } = renderHook(() => usePreviewGallery(deps));
    result.current.pruneAndStep("/a.jpg");
    expect(setPreview).toHaveBeenCalledWith(null);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ t: "sftp-read" }),
    );
  });

  it("only prunes the snapshot when a background sibling is removed", () => {
    const { deps, setPreview, send } = makeDeps(preview());
    const { result } = renderHook(() => usePreviewGallery(deps));
    result.current.pruneAndStep("/b.jpg");
    // Current file (/a.jpg) stays; siblings lose /b.jpg; no new read.
    const arg = setPreview.mock.calls.at(-1)?.[0] as PreviewState;
    expect(arg.path).toBe("/a.jpg");
    expect(arg.siblings).toEqual([{ path: "/a.jpg", name: "a.jpg" }]);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ t: "sftp-read" }),
    );
  });
});
