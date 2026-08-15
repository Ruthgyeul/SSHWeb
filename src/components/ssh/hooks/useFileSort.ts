"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_SORT_DIR,
  type SortDir,
  type SortKey,
} from "@/lib/sshProtocol";

/** How the file browser orders a directory listing. */
export interface FileSort {
  key: SortKey;
  dir: SortDir;
}

const STORAGE_KEY = "sshweb.fileSort";
// Same-document broadcast so every mounted session's file browser re-sorts
// together when one changes the order (the native `storage` event only fires in
// *other* documents), matching the useFileViewMode pattern.
const SYNC_EVENT = "sshweb:fileSort";

const DEFAULT_SORT: FileSort = { key: "name", dir: "asc" };

function parseSort(raw: string | null): FileSort {
  if (!raw) return DEFAULT_SORT;
  const [key, dir] = raw.split(":");
  if (key !== "name" && key !== "size" && key !== "mtime") return DEFAULT_SORT;
  return { key, dir: dir === "desc" ? "desc" : "asc" };
}

// Cache the parsed snapshot so useSyncExternalStore gets a stable reference
// between changes (shared across all hook instances, which is intended).
let cachedRaw: string | null = null;
let cachedSort: FileSort = DEFAULT_SORT;

function getSnapshot(): FileSort {
  if (typeof window === "undefined") return DEFAULT_SORT;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSort = parseSort(raw);
  }
  return cachedSort;
}

function getServerSnapshot(): FileSort {
  return DEFAULT_SORT;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(SYNC_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SYNC_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The file browser's sort preference (field + direction), shared across every
 * session/tab in the document and persisted in `localStorage`. Read through
 * `useSyncExternalStore`; writes broadcast a custom event so all mounted file
 * browsers re-sort together, and the `storage` event keeps other tabs in sync.
 *
 * `toggleSort(key)` flips the direction when the same field is clicked again,
 * otherwise switches to that field at its natural default direction
 * (`DEFAULT_SORT_DIR`: names A→Z, sizes/dates largest/newest first).
 */
export function useFileSort(): [FileSort, (key: SortKey) => void] {
  const sort = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleSort = useCallback((key: SortKey) => {
    const current = getSnapshot();
    const next: FileSort =
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_SORT_DIR[key] };
    try {
      localStorage.setItem(STORAGE_KEY, `${next.key}:${next.dir}`);
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  }, []);

  return [sort, toggleSort];
}
