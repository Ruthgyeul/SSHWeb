import { describe, it, expect } from "vitest";

import { classifySwipe } from "@/lib/swipeGesture";

describe("classifySwipe", () => {
  const start = { x: 200, y: 200 };

  it("detects a left swipe past the threshold", () => {
    expect(classifySwipe(start, { x: 120, y: 205 })).toBe("left");
  });

  it("detects a right swipe past the threshold", () => {
    expect(classifySwipe(start, { x: 280, y: 195 })).toBe("right");
  });

  it("detects a down swipe past the threshold", () => {
    expect(classifySwipe(start, { x: 205, y: 300 })).toBe("down");
  });

  it("detects an up swipe past the threshold", () => {
    expect(classifySwipe(start, { x: 195, y: 100 })).toBe("up");
  });

  it("returns null for a short movement under the threshold", () => {
    expect(classifySwipe(start, { x: 220, y: 210 })).toBeNull();
  });

  it("returns null for an ambiguous diagonal drag", () => {
    // 70px each way: past threshold but neither axis dominates.
    expect(classifySwipe(start, { x: 270, y: 270 })).toBeNull();
  });

  it("honours a custom threshold", () => {
    expect(classifySwipe(start, { x: 260, y: 200 })).toBe("right");
    expect(
      classifySwipe(start, { x: 260, y: 200 }, { threshold: 100 }),
    ).toBeNull();
  });
});
