import { useCallback, useRef, type RefObject } from "react";
import { ByteLruCache } from "@/lib/byteLruCache";

/** In-memory budget for the recently-viewed preview cache (raw file bytes). A
 * revisited file re-opens instantly with no re-transfer; the LRU evicts the
 * oldest entries once the total exceeds this. Bytes (not blob URLs) are cached
 * so each open builds a fresh, independently-revoked `blob:` URL. Kept modest to
 * bound how much decoded file data sits in the tab's memory at once (a
 * confidentiality/RAM-residual choice) — since image previews are light lossy
 * WebP (a few hundred KB each) this still holds a good stretch of a gallery for
 * instant ←/→ stepping, and the bridge's own cache keeps a further re-open fast.
 * Held in memory only, so it's dropped on logout / sudo toggle (nothing
 * lingers). */
const MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;

/** How long a cached preview stays reusable. A file not re-opened within this
 * window is dropped so decoded copies of your files don't linger in the tab's
 * memory indefinitely — the same confidentiality/RAM-residual TTL the bridge's
 * thumbnail cache uses (30 min). A re-open within the window still paints
 * instantly and refreshes the entry's age. */
const PREVIEW_CACHE_TTL_MS = 30 * 60 * 1000;

/** One entry in the recently-viewed preview cache: the raw file bytes plus the
 * metadata needed to re-open them (the display name, and — when the bytes are a
 * downscaled WebP preview rather than the original — an `optimized` flag + the
 * WebP content type so Download re-fetches the untouched original). The LRU's
 * age/eviction bookkeeping lives in {@link ByteLruCache}, not here. */
export interface PreviewCacheEntry {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  optimized?: boolean;
  mime?: string;
}

/** The `SshSession` recently-viewed preview cache: an in-memory byte-bounded LRU
 * of file bytes keyed by path + version tag (`size:mtime`), so a re-open — or a
 * ←/→ gallery step onto a prefetched neighbour — paints instantly with no
 * re-transfer. Keyed on the version so an edited file misses and re-fetches.
 * Owns the LRU; the caller supplies the listing's version map (for the key) and
 * drives it via keyed get/has/store/clear. Elevated (root) reads are cached
 * here too, so it's dropped on every `sudo` toggle and on logout — nothing
 * lingers after de-elevate. */
export function usePreviewCache(
  entryVersionRef: RefObject<Map<string, string>>,
) {
  const cacheRef = useRef(
    new ByteLruCache<PreviewCacheEntry>({
      maxBytes: MAX_PREVIEW_CACHE_BYTES,
      ttlMs: PREVIEW_CACHE_TTL_MS,
      sizeOf: (e) => e.bytes.length,
    }),
  );

  // Cache key for a path: path + its version tag (size:mtime) so an edited file
  // misses and re-fetches. Falls back to the bare path when the version is
  // unknown (e.g. a search hit not in the current listing).
  const keyFor = useCallback(
    (path: string) => {
      const version = entryVersionRef.current.get(path);
      return version ? `${path} ${version}` : path;
    },
    [entryVersionRef],
  );

  /** A live cache entry for `path`, or null on a miss / expired. */
  const get = useCallback(
    (path: string) => cacheRef.current.get(keyFor(path)),
    [keyFor],
  );

  /** Whether `path` is currently cached (does not touch the entry's age). */
  const has = useCallback(
    (path: string) => cacheRef.current.has(keyFor(path)),
    [keyFor],
  );

  /** Store a fully-loaded preview's bytes (unless bigger than the whole budget),
   * evicting the oldest entries once over budget. TTL sweep, over-budget skip,
   * and LRU eviction all live in ByteLruCache. */
  const store = useCallback(
    (
      path: string,
      name: string,
      bytes: Uint8Array<ArrayBuffer>,
      optimized?: boolean,
      mime?: string,
    ) => {
      cacheRef.current.set(keyFor(path), { name, bytes, optimized, mime });
    },
    [keyFor],
  );

  const clear = useCallback(() => cacheRef.current.clear(), []);

  /** Total bytes currently held (for the settings media-cache read-out). */
  const sizeBytes = useCallback(() => cacheRef.current.bytes, []);

  return { keyFor, get, has, store, clear, sizeBytes };
}
