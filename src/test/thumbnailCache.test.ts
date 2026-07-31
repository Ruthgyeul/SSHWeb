import { describe, it, expect } from "vitest";
import {
  fileVersionTag,
  thumbnailCacheKey,
  planThumbnailEvictions,
  MAX_CACHE_BYTES,
} from "@/lib/thumbnailCache";

describe("fileVersionTag", () => {
  it("combines size and mtime", () => {
    expect(fileVersionTag({ size: 1234, mtime: 5678 })).toBe("1234:5678");
  });

  it("changes when the file content changes (size or mtime)", () => {
    const a = fileVersionTag({ size: 100, mtime: 10 });
    expect(fileVersionTag({ size: 101, mtime: 10 })).not.toBe(a); // edited
    expect(fileVersionTag({ size: 100, mtime: 11 })).not.toBe(a); // re-saved
  });
});

describe("thumbnailCacheKey", () => {
  it("is stable for the same scope/path/version", () => {
    const k1 = thumbnailCacheKey("me@host", "/a/b.png", "10:20");
    const k2 = thumbnailCacheKey("me@host", "/a/b.png", "10:20");
    expect(k1).toBe(k2);
  });

  it("isolates different connections, paths and versions", () => {
    const base = thumbnailCacheKey("me@host", "/a/b.png", "10:20");
    expect(thumbnailCacheKey("me@other", "/a/b.png", "10:20")).not.toBe(base);
    expect(thumbnailCacheKey("me@host", "/a/c.png", "10:20")).not.toBe(base);
    expect(thumbnailCacheKey("me@host", "/a/b.png", "11:20")).not.toBe(base);
  });
});

describe("planThumbnailEvictions", () => {
  const rows = [
    { key: "old", bytes: 100, lastUsed: 1 },
    { key: "mid", bytes: 100, lastUsed: 2 },
    { key: "new", bytes: 100, lastUsed: 3 },
  ];

  it("evicts nothing when under budget", () => {
    expect(planThumbnailEvictions(rows, 1000)).toEqual([]);
  });

  it("evicts the least-recently-used rows first", () => {
    // Budget fits two of the three 100-byte rows → the oldest is evicted.
    expect(planThumbnailEvictions(rows, 200)).toEqual(["old"]);
    // Budget fits only the newest → the two oldest are evicted.
    expect(planThumbnailEvictions(rows, 100).sort()).toEqual(["mid", "old"]);
  });

  it("evicts everything when the budget is zero or negative", () => {
    expect(planThumbnailEvictions(rows, 0).sort()).toEqual([
      "mid",
      "new",
      "old",
    ]);
    expect(planThumbnailEvictions(rows, -5)).toHaveLength(3);
  });

  it("handles an empty cache", () => {
    expect(planThumbnailEvictions([], 100)).toEqual([]);
  });

  it("defaults to the module budget", () => {
    const big = [{ key: "k", bytes: MAX_CACHE_BYTES + 1, lastUsed: 1 }];
    expect(planThumbnailEvictions(big)).toEqual(["k"]);
  });
});
