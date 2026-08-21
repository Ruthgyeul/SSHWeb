// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { createRef } from "react";

import {
  usePreviewKeyboard,
  type PreviewKeyboardOptions,
} from "@/components/ssh/hooks/usePreviewKeyboard";

/** A minimal stand-in for the <video> element the transport keys drive. */
function fakeVideo() {
  return {
    paused: true,
    currentTime: 20,
    duration: 100,
    volume: 0.5,
    muted: false,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    requestFullscreen: vi.fn(),
  };
}

type Opts = PreviewKeyboardOptions;

function baseOpts(over: Partial<Opts> = {}): Opts {
  return {
    kind: "image",
    isImage: true,
    isText: false,
    findOpen: false,
    hasGallery: false,
    videoRef: createRef(),
    findInputRef: createRef(),
    setFindOpen: vi.fn(),
    onClose: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    zoomBy: vi.fn(),
    resetView: vi.fn(),
    rotate: vi.fn(),
    setSpeed: vi.fn(),
    ...over,
  };
}

/** Dispatch a keydown on `target` (defaults to window) and return the event. */
function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
) {
  const e = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

function mount(opts: Opts) {
  renderHook(() => usePreviewKeyboard(opts));
}

describe("usePreviewKeyboard", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("Escape closes the modal when the find bar is shut", () => {
    const opts = baseOpts({ isText: true, findOpen: false });
    mount(opts);
    const e = press("Escape");
    expect(opts.onClose).toHaveBeenCalledTimes(1);
    expect(opts.setFindOpen).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Escape dismisses the find bar first, not the modal", () => {
    const opts = baseOpts({ isText: true, findOpen: true });
    mount(opts);
    press("Escape");
    expect(opts.setFindOpen).toHaveBeenCalledWith(false);
    expect(opts.onClose).not.toHaveBeenCalled();
  });

  it("Ctrl+F opens the find bar for a text preview only", () => {
    const textOpts = baseOpts({ isText: true, isImage: false, kind: "text" });
    mount(textOpts);
    press("f", { ctrlKey: true });
    expect(textOpts.setFindOpen).toHaveBeenCalledWith(true);

    const imgOpts = baseOpts();
    mount(imgOpts);
    press("f", { ctrlKey: true });
    expect(imgOpts.setFindOpen).not.toHaveBeenCalled();
  });

  it("ignores non-Escape keys while typing in an input", () => {
    const opts = baseOpts({ hasGallery: true });
    mount(opts);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("ArrowLeft", {}, input);
    expect(opts.onPrev).not.toHaveBeenCalled();
    input.remove();
  });

  it("Shift+Arrow steps the gallery on any kind (incl. video)", () => {
    const opts = baseOpts({ kind: "video", isImage: false, hasGallery: true });
    mount(opts);
    press("ArrowLeft", { shiftKey: true });
    expect(opts.onPrev).toHaveBeenCalledTimes(1);
    press("ArrowRight", { shiftKey: true });
    expect(opts.onNext).toHaveBeenCalledTimes(1);
  });

  it("plain Arrow steps the gallery for non-media, but not for video", () => {
    const img = baseOpts({ hasGallery: true });
    mount(img);
    press("ArrowRight");
    expect(img.onNext).toHaveBeenCalledTimes(1);

    // Video reserves the plain arrows for seeking, so no gallery step.
    const vid = baseOpts({
      kind: "video",
      isImage: false,
      hasGallery: true,
      videoRef: { current: fakeVideo() as unknown as HTMLVideoElement },
    });
    mount(vid);
    press("ArrowRight");
    expect(vid.onNext).not.toHaveBeenCalled();
  });

  it("drives video transport: play/pause, seek, mute, speed", () => {
    const v = fakeVideo();
    const opts = baseOpts({
      kind: "video",
      isImage: false,
      videoRef: { current: v as unknown as HTMLVideoElement },
    });
    mount(opts);

    press(" "); // play (currently paused)
    expect(v.play).toHaveBeenCalledTimes(1);

    press("ArrowRight"); // seek +5s from 20
    expect(v.currentTime).toBe(25);
    press("ArrowLeft"); // seek -5s
    expect(v.currentTime).toBe(20);

    press("m"); // toggle mute
    expect(v.muted).toBe(true);

    press("]"); // speed up by 0.25
    expect(opts.setSpeed).toHaveBeenCalledWith(1.25);
  });

  it("Delete triggers onDelete and F2 triggers onMove, on any kind", () => {
    const onDelete = vi.fn();
    const onMove = vi.fn();
    const opts = baseOpts({
      kind: "video",
      isImage: false,
      videoRef: { current: fakeVideo() as unknown as HTMLVideoElement },
      onDelete,
      onMove,
    });
    mount(opts);
    const del = press("Delete");
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(del.defaultPrevented).toBe(true);
    const f2 = press("F2");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(f2.defaultPrevented).toBe(true);
  });

  it("does not fire Delete/F2 while typing in an input", () => {
    const onDelete = vi.fn();
    const onMove = vi.fn();
    mount(baseOpts({ onDelete, onMove }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("Delete", {}, input);
    press("F2", {}, input);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    input.remove();
  });

  it("drives image transforms: zoom, reset, rotate", () => {
    const opts = baseOpts();
    mount(opts);
    press("+");
    expect(opts.zoomBy).toHaveBeenCalled();
    press("0");
    expect(opts.resetView).toHaveBeenCalledTimes(1);
    press("r");
    expect(opts.rotate).toHaveBeenCalledTimes(1);
  });

  it("removes the window listener on unmount", () => {
    const opts = baseOpts();
    const { unmount } = renderHook(() => usePreviewKeyboard(opts));
    unmount();
    press("0");
    expect(opts.resetView).not.toHaveBeenCalled();
  });
});
