// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useImageTransform,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
} from "@/components/ssh/hooks/useImageTransform";

/** A pointer-event stub carrying only the fields the hook reads. */
function pointer(x: number, y: number) {
  return {
    clientX: x,
    clientY: y,
    pointerId: 1,
    target: { setPointerCapture: () => {} },
  } as unknown as React.PointerEvent;
}
/** A wheel-event stub with a preventDefault spy and a scroll direction. */
function wheel(deltaY: number) {
  let prevented = false;
  const e = {
    deltaY,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as React.WheelEvent;
  return { e, wasPrevented: () => prevented };
}

describe("useImageTransform", () => {
  it("starts at the fitted, upright defaults", () => {
    const { result } = renderHook(() => useImageTransform(true));
    expect(result.current.zoom).toBe(1);
    expect(result.current.rotation).toBe(0);
    expect(result.current.offset).toEqual({ x: 0, y: 0 });
    expect(result.current.dragging).toBe(false);
  });

  it("zooms by a factor and clamps to MAX_ZOOM", () => {
    const { result } = renderHook(() => useImageTransform(true));
    act(() => result.current.zoomBy(ZOOM_STEP));
    expect(result.current.zoom).toBeCloseTo(ZOOM_STEP);
    // Repeatedly zooming in never exceeds the ceiling.
    act(() => {
      for (let i = 0; i < 20; i++) result.current.zoomBy(ZOOM_STEP);
    });
    expect(result.current.zoom).toBe(MAX_ZOOM);
  });

  it("clamps zoom-out to MIN_ZOOM and recenters the pan at fit", () => {
    const { result } = renderHook(() => useImageTransform(true));
    // Zoom in, pan, then zoom back out to fit.
    act(() => result.current.zoomBy(ZOOM_STEP * ZOOM_STEP));
    act(() => {
      result.current.onPointerDown(pointer(0, 0));
      result.current.onPointerMove(pointer(30, 40));
    });
    expect(result.current.offset).toEqual({ x: 30, y: 40 });
    act(() => {
      for (let i = 0; i < 10; i++) result.current.zoomBy(1 / ZOOM_STEP);
    });
    expect(result.current.zoom).toBe(MIN_ZOOM);
    // Back at fit, the pan offset is reset so the image recenters.
    expect(result.current.offset).toEqual({ x: 0, y: 0 });
  });

  it("rotates 90° clockwise and wraps at 360", () => {
    const { result } = renderHook(() => useImageTransform(true));
    for (const expected of [90, 180, 270, 0]) {
      act(() => result.current.rotate());
      expect(result.current.rotation).toBe(expected);
    }
  });

  it("resetView returns zoom, rotation, and pan to defaults", () => {
    const { result } = renderHook(() => useImageTransform(true));
    act(() => {
      result.current.zoomBy(ZOOM_STEP);
      result.current.rotate();
    });
    act(() => resetPan(result.current));
    act(() => result.current.resetView());
    expect(result.current.zoom).toBe(1);
    expect(result.current.rotation).toBe(0);
    expect(result.current.offset).toEqual({ x: 0, y: 0 });
  });

  it("only pans while zoomed in (drag ignored at fit)", () => {
    const { result } = renderHook(() => useImageTransform(true));
    // At fit (zoom == 1) a drag is a no-op.
    act(() => {
      result.current.onPointerDown(pointer(0, 0));
      result.current.onPointerMove(pointer(20, 20));
    });
    expect(result.current.dragging).toBe(false);
    expect(result.current.offset).toEqual({ x: 0, y: 0 });
    // Zoomed in, the drag tracks and sets `dragging`.
    act(() => result.current.zoomBy(ZOOM_STEP));
    act(() => result.current.onPointerDown(pointer(10, 10)));
    expect(result.current.dragging).toBe(true);
    act(() => result.current.onPointerMove(pointer(15, 25)));
    expect(result.current.offset).toEqual({ x: 5, y: 15 });
    act(() => result.current.endDrag());
    expect(result.current.dragging).toBe(false);
  });

  it("ignores wheel and pointer interactions when disabled", () => {
    const { result } = renderHook(() => useImageTransform(false));
    const w = wheel(-1);
    act(() => result.current.onWheel(w.e));
    expect(result.current.zoom).toBe(1);
    expect(w.wasPrevented()).toBe(false);
    act(() => result.current.onPointerDown(pointer(0, 0)));
    expect(result.current.dragging).toBe(false);
  });

  it("wheel up zooms in, wheel down zooms out, when enabled", () => {
    const { result } = renderHook(() => useImageTransform(true));
    const up = wheel(-1);
    act(() => result.current.onWheel(up.e));
    expect(up.wasPrevented()).toBe(true);
    expect(result.current.zoom).toBeCloseTo(ZOOM_STEP);
    act(() => result.current.onWheel(wheel(1).e));
    expect(result.current.zoom).toBeCloseTo(1);
  });
});

/** Pan the image (assumes it is already zoomed in) so resetView has work to do. */
function resetPan(t: ReturnType<typeof useImageTransform>) {
  t.onPointerDown(pointer(0, 0));
  t.onPointerMove(pointer(5, 5));
}
