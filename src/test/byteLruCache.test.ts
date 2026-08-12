import { describe, it, expect } from "vitest";

import { ByteLruCache } from "@/lib/byteLruCache";

/** A cache of blobs sized by their `bytes.length`, with an injectable clock. */
function makeCache(maxBytes: number, ttlMs: number, clock: { t: number }) {
  return new ByteLruCache<{ bytes: { length: number }; tag?: string }>({
    maxBytes,
    ttlMs,
    sizeOf: (v) => v.bytes.length,
    now: () => clock.t,
  });
}

describe("ByteLruCache", () => {
  it("stores and retrieves a value, tracking byte total and size", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 1000, clock);
    c.set("a", { bytes: { length: 10 } });
    expect(c.size).toBe(1);
    expect(c.bytes).toBe(10);
    expect(c.get("a")?.bytes.length).toBe(10);
    expect(c.get("missing")).toBeNull();
  });

  it("evicts least-recently-used entries once over budget", () => {
    const clock = { t: 0 };
    const c = makeCache(30, 10_000, clock);
    c.set("a", { bytes: { length: 10 } });
    c.set("b", { bytes: { length: 10 } });
    c.set("c", { bytes: { length: 10 } });
    // Touch "a" so it becomes most-recently-used; "b" is now the oldest.
    expect(c.get("a")).not.toBeNull();
    c.set("d", { bytes: { length: 10 } }); // over budget → evict oldest ("b")
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
    expect(c.bytes).toBe(30);
  });

  it("re-inserting an existing key updates bytes without double-counting", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 10_000, clock);
    c.set("a", { bytes: { length: 10 } });
    c.set("a", { bytes: { length: 25 } });
    expect(c.size).toBe(1);
    expect(c.bytes).toBe(25);
    expect(c.get("a")?.bytes.length).toBe(25);
  });

  it("never stores a value larger than the whole budget", () => {
    const clock = { t: 0 };
    const c = makeCache(50, 10_000, clock);
    c.set("big", { bytes: { length: 51 } });
    expect(c.has("big")).toBe(false);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });

  it("drops an expired entry on get and stops counting its bytes", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 1000, clock);
    c.set("a", { bytes: { length: 10 } });
    clock.t = 1001; // just past TTL
    expect(c.get("a")).toBeNull();
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });

  it("get refreshes an entry's age (a hit within TTL survives)", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 1000, clock);
    c.set("a", { bytes: { length: 10 } });
    clock.t = 800;
    expect(c.get("a")).not.toBeNull(); // refreshes ts to 800
    clock.t = 1600; // 800ms since the refresh → still fresh
    expect(c.get("a")).not.toBeNull();
  });

  it("set sweeps TTL-expired entries before inserting", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 1000, clock);
    c.set("old", { bytes: { length: 10 } });
    clock.t = 2000; // "old" is now expired
    c.set("new", { bytes: { length: 10 } });
    expect(c.has("old")).toBe(false);
    expect(c.has("new")).toBe(true);
    expect(c.bytes).toBe(10);
  });

  it("has does not evict an expired entry (plain presence check)", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 1000, clock);
    c.set("a", { bytes: { length: 10 } });
    clock.t = 2000;
    expect(c.has("a")).toBe(true); // present until a get/set sweeps it
    expect(c.bytes).toBe(10);
  });

  it("clear drops everything and resets the byte total", () => {
    const clock = { t: 0 };
    const c = makeCache(100, 10_000, clock);
    c.set("a", { bytes: { length: 10 } });
    c.set("b", { bytes: { length: 20 } });
    c.clear();
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
    expect(c.get("a")).toBeNull();
  });
});
