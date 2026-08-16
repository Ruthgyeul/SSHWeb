// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePreviewCache } from "@/components/ssh/hooks/usePreviewCache";

const bytes = (n: number) =>
  new Uint8Array(n).fill(1) as Uint8Array<ArrayBuffer>;

function setup(versions: Record<string, string> = {}) {
  // A non-null ref, matching SshSession's useRef<Map>(new Map()).
  const ref = { current: new Map(Object.entries(versions)) };
  const { result } = renderHook(() => usePreviewCache(ref));
  return { cache: result.current, versions: ref.current };
}

describe("usePreviewCache", () => {
  it("stores and retrieves by path, keyed on the version tag", () => {
    const { cache } = setup({ "/a.png": "10:99" });
    cache.store("/a.png", "a.png", bytes(10), true, "image/webp");
    const hit = cache.get("/a.png");
    expect(hit).toMatchObject({
      name: "a.png",
      optimized: true,
      mime: "image/webp",
    });
    expect(cache.has("/a.png")).toBe(true);
    expect(cache.sizeBytes()).toBe(10);
  });

  it("misses after the file's version tag changes (edited file)", () => {
    const { cache, versions } = setup({ "/a.txt": "5:1" });
    cache.store("/a.txt", "a.txt", bytes(5));
    expect(cache.has("/a.txt")).toBe(true);
    // The file was edited — its size:mtime tag changed, so the old key misses.
    versions.set("/a.txt", "6:2");
    expect(cache.has("/a.txt")).toBe(false);
    expect(cache.get("/a.txt")).toBeNull();
  });

  it("clears everything", () => {
    const { cache } = setup();
    cache.store("/x", "x", bytes(8));
    expect(cache.sizeBytes()).toBe(8);
    cache.clear();
    expect(cache.sizeBytes()).toBe(0);
    expect(cache.has("/x")).toBe(false);
  });

  it("falls back to the bare path when no version is known", () => {
    const { cache } = setup(); // no versions
    cache.store("/hit.txt", "hit.txt", bytes(3));
    expect(cache.get("/hit.txt")).toMatchObject({ name: "hit.txt" });
  });
});
