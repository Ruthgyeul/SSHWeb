/**
 * A byte-bounded, TTL-aware LRU cache.
 *
 * Extracted from `SshSession`, which previously open-coded this bookkeeping
 * inline for its recently-viewed preview bytes (a `Map` plus a hand-tracked
 * running byte total). Pulling it into a small, generic, DOM-free primitive
 * keeps the intricate eviction/TTL logic in one unit-tested place — the same
 * "pure logic in `src/lib`" discipline as {@link file://./thumbnailCache.ts}
 * (whose server-side twin is a separate cache; this one is browser-only, so it
 * has no `server.mjs` mirror to keep in sync).
 *
 * Semantics (unchanged from the original inline version):
 *  - Insertion order in the backing `Map` is the LRU order — the front is the
 *    least-recently-used entry, the back the most-recently-used.
 *  - `set` first drops any entries older than the TTL, then inserts (moving an
 *    existing key to the back), then evicts from the front until within budget.
 *  - A single value larger than the whole budget is never stored.
 *  - `get` returns `null` for a missing or expired entry (dropping the expired
 *    one), and otherwise refreshes the entry's age and moves it to the back.
 *  - `has` is a plain presence check — it does not evict on TTL.
 */

export interface ByteLruCacheOptions<V> {
  /** Total bytes the cache may hold before LRU eviction kicks in. */
  maxBytes: number;
  /** Entries older than this (ms) are dropped. */
  ttlMs: number;
  /** How many bytes a stored value counts for against the budget. */
  sizeOf: (value: V) => number;
  /** Clock source, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class ByteLruCache<V> {
  private readonly map = new Map<string, { value: V; ts: number }>();
  private total = 0;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly sizeOf: (value: V) => number;
  private readonly now: () => number;

  constructor(opts: ByteLruCacheOptions<V>) {
    this.maxBytes = opts.maxBytes;
    this.ttlMs = opts.ttlMs;
    this.sizeOf = opts.sizeOf;
    this.now = opts.now ?? Date.now;
  }

  /** Running total of bytes currently held. */
  get bytes(): number {
    return this.total;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.map.size;
  }

  /** Plain presence check — does not evict a TTL-expired entry. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Fetch a fresh entry, or `null` if missing or expired. A hit refreshes its
   * age and becomes most-recently-used; an expired hit is dropped.
   */
  get(key: string): V | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.ts > this.ttlMs) {
      this.map.delete(key);
      this.total -= this.sizeOf(hit.value);
      return null;
    }
    // LRU touch + refresh age: re-insert at the back as most-recently used.
    hit.ts = this.now();
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /**
   * Store `value` under `key`, sweeping TTL-expired entries first and evicting
   * the least-recently-used until within budget. A value larger than the whole
   * budget is not stored.
   */
  set(key: string, value: V): void {
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return;
    const now = this.now();
    // Opportunistically drop entries that have aged out (TTL), so stale bytes
    // don't sit in memory just because nothing pushed the LRU over budget.
    for (const [k, v] of this.map) {
      if (now - v.ts > this.ttlMs) {
        this.map.delete(k);
        this.total -= this.sizeOf(v.value);
      }
    }
    const existing = this.map.get(key);
    if (existing) this.total -= this.sizeOf(existing.value);
    this.map.delete(key);
    this.map.set(key, { value, ts: now });
    this.total += size;
    // Evict oldest (front of the Map) until back within budget.
    while (this.total > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.map.get(oldest);
      this.map.delete(oldest);
      if (dropped) this.total -= this.sizeOf(dropped.value);
    }
  }

  /** Drop everything. */
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}
