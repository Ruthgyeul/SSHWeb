import { useCallback, useRef, useState } from "react";

/** Zoom bounds and multiplicative step for the image preview view. Exported so
 * the modal's toolbar/keyboard can reuse the same step and disable its zoom
 * buttons at the limits. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.4;

/** The image view's pan offset (px), applied as a CSS translate. */
export interface ImageOffset {
  x: number;
  y: number;
}

/**
 * The image-preview transform state machine, extracted from `FilePreview`.
 *
 * Owns the zoom / rotation / pan (offset) state plus the pointer-drag and wheel
 * interactions that drive them — the one cohesive, self-contained concern in the
 * preview modal. The modal remounts on file change (`key={path}`), so the state
 * resets to its fitted/upright defaults automatically when stepping the gallery.
 *
 * `enabled` gates the wheel/pointer handlers: they hang off the shared media
 * container (which also wraps video/audio), so they must no-op unless an image
 * is showing. The pure math (clamp, recenter-at-fit, 90° rotation wrap) is
 * unit-tested via `renderHook`.
 */
export interface ImageTransform {
  /** Current zoom factor (1 = fit). */
  zoom: number;
  /** Current rotation in degrees (0/90/180/270). */
  rotation: number;
  /** Current pan offset in px. */
  offset: ImageOffset;
  /** True while a pan drag is active (drops the CSS transition for 1:1 tracking). */
  dragging: boolean;
  /** Multiply the zoom by `factor`, clamped to [MIN_ZOOM, MAX_ZOOM]; recenters at fit. */
  zoomBy: (factor: number) => void;
  /** Reset zoom, rotation, and pan to their defaults. */
  resetView: () => void;
  /** Rotate 90° clockwise (wraps at 360). */
  rotate: () => void;
  onWheel: (e: React.WheelEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  /** End an in-progress pan drag (pointer up / cancel). */
  endDrag: () => void;
}

export function useImageTransform(enabled: boolean): ImageTransform {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState<ImageOffset>({ x: 0, y: 0 });
  const dragRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  // Mirror of "is a pan drag active" for render (the ref itself can't be read
  // during render) — used to drop the CSS transition so panning tracks 1:1.
  const [dragging, setDragging] = useState(false);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      if (next <= 1) setOffset({ x: 0, y: 0 }); // recenter when back to fit
      return next;
    });
  }, []);
  const resetView = useCallback(() => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!enabled) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    },
    [enabled, zoomBy],
  );
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || zoom <= 1) return;
      dragRef.current = {
        x: e.clientX,
        y: e.clientY,
        ox: offset.x,
        oy: offset.y,
      };
      setDragging(true);
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [enabled, zoom, offset],
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }, []);
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  return {
    zoom,
    rotation,
    offset,
    dragging,
    zoomBy,
    resetView,
    rotate,
    onWheel,
    onPointerDown,
    onPointerMove,
    endDrag,
  };
}
