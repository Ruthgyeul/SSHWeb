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
  // Normally the store just reflects localStorage (cached by the last-seen raw
  // string so useSyncExternalStore gets a stable reference between changes).
  // `lastRaw` tracks the raw we last observed/persisted; when a write FAILS
  // (quota exhausted / read-only storage), `lastRaw` stays at the old stored
  // value while `cached` holds the new one — so the change still applies this
  // session, yet a genuine external change (or localStorage.clear()) is still
  // adopted because the stored raw then differs from `lastRaw`.
  let lastRaw: string | null = null;
  let cached: T = fallback;
  let primed = false;

  const readCurrent = (): T => {
    if (typeof window === "undefined") return fallback;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      raw = null;
    }
    if (!primed || raw !== lastRaw) {
      lastRaw = raw;
      cached = parse(raw);
      primed = true;
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
    // Apply in memory + notify regardless of whether persistence succeeds, so
    // the change takes effect this session even when storage is unavailable.
    cached = parse(raw);
    primed = true;
    try {
      localStorage.setItem(key, raw);
      lastRaw = raw; // persisted → this is now the observed stored value
    } catch {
      /* storage unavailable — keep `lastRaw` old so `cached` isn't overwritten */
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SYNC_EVENT));
    }
  };

  const useValue = (): T =>
    useSyncExternalStore(subscribe, readCurrent, () => fallback);

  /** The current value outside of render (for read-modify-write updaters). */
  const get = (): T => readCurrent();

  return { useValue, get, set };
}
