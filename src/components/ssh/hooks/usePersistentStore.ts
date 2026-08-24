"use client";

import { useSyncExternalStore } from "react";

/**
 * A tiny localStorage-backed store factory for a single preference key, sharing
 * the same "cache the parsed snapshot + broadcast a same-document event" shape
 * the file-browser view/sort hooks use — so a new preference (hidden-files
 * toggle, column visibility) doesn't hand-roll the whole `useSyncExternalStore`
 * dance again. Reads go through `useValue()`; `set(raw)` writes the raw string,
 * persists it, and broadcasts so every mounted browser (and other tabs) updates.
 */
export function makePersistentStore<T>(
  key: string,
  parse: (raw: string | null) => T,
  fallback: T,
) {
  const SYNC_EVENT = `sshweb:${key}`;
  let cachedRaw: string | null = null;
  let cached: T = fallback;

  const getSnapshot = (): T => {
    if (typeof window === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = parse(raw);
    }
    return cached;
  };

  const subscribe = (onChange: () => void): (() => void) => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) onChange();
    };
    window.addEventListener(SYNC_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  };

  const set = (raw: string) => {
    try {
      localStorage.setItem(key, raw);
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  };

  const useValue = (): T =>
    useSyncExternalStore(subscribe, getSnapshot, () => fallback);

  return { useValue, set };
}
