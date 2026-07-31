"use client";

import { useCallback, useSyncExternalStore } from "react";

/** How the file browser lays out a directory listing. */
export type FileViewMode = "list" | "grid";

const STORAGE_KEY = "sshweb.fileViewMode";
// Same-document broadcast so every mounted session's file browser flips
// together when one changes the view (the native `storage` event only fires in
// *other* documents).
const SYNC_EVENT = "sshweb:fileViewMode";

const DEFAULT_MODE: FileViewMode = "list";

function parseMode(raw: string | null): FileViewMode {
  return raw === "grid" ? "grid" : "list";
}

// Cache the snapshot so useSyncExternalStore gets a stable reference between
// changes. Shared across all hook instances, which is what we want.
let cachedRaw: string | null = null;
let cachedMode: FileViewMode = DEFAULT_MODE;

function getSnapshot(): FileViewMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMode = parseMode(raw);
  }
  return cachedMode;
}

function getServerSnapshot(): FileViewMode {
  return DEFAULT_MODE;
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
 * The file browser's list/grid layout preference, shared across every
 * session/tab in the document and persisted in `localStorage`. Read through
 * `useSyncExternalStore`; writes broadcast a custom event so all mounted file
 * browsers switch together, and the `storage` event keeps other tabs in sync.
 */
export function useFileViewMode(): [
  FileViewMode,
  (mode: FileViewMode) => void,
] {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setMode = useCallback((next: FileViewMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  }, []);

  return [mode, setMode];
}
