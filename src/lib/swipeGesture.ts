/**
 * Pure touch-swipe classification for the preview modal's mobile gestures.
 *
 * Kept DOM-free (just start/end coordinates in and a direction out) so the
 * threshold + dominant-axis logic is unit-testable, mirroring the "pure logic in
 * src/lib" discipline used elsewhere (see `useImageTransform`, `zip`, …). The
 * `PreviewMedia` component feeds it `touchstart`/`touchend` coordinates.
 */

export type SwipeDirection = "left" | "right" | "up" | "down";

export interface SwipePoint {
  x: number;
  y: number;
}

export interface SwipeOptions {
  /** Minimum travel (px) along the dominant axis to count as a swipe. */
  threshold?: number;
  /**
   * How much the dominant axis must exceed the other one for the gesture to be
   * unambiguous (ratio ≥ 1). A diagonal drag returns null so it doesn't
   * accidentally navigate while the user meant to pan/scroll.
   */
  dominance?: number;
}

const DEFAULT_THRESHOLD = 50;
const DEFAULT_DOMINANCE = 1.3;

/**
 * Classify a swipe from `start` to `end`, or null when it's too short or too
 * diagonal to be a confident horizontal/vertical swipe.
 */
export function classifySwipe(
  start: SwipePoint,
  end: SwipePoint,
  options: SwipeOptions = {},
): SwipeDirection | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const dominance = options.dominance ?? DEFAULT_DOMINANCE;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= ay) {
    if (ax < threshold || ax < ay * dominance) return null;
    return dx < 0 ? "left" : "right";
  }
  if (ay < threshold || ay < ax * dominance) return null;
  return dy < 0 ? "up" : "down";
}
