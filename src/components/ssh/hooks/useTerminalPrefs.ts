"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_THEME_ID, getThemePreset } from "@/lib/terminalTheme";

/** Persisted terminal appearance preferences. */
export interface TerminalPrefs {
  themeId: string;
}

const STORAGE_KEY = "sshweb.terminalPrefs";
// Same-document broadcast so every mounted session updates live when one tab's
// settings change (the native `storage` event only fires in *other* documents).
const SYNC_EVENT = "sshweb:terminalPrefs";

const DEFAULT_PREFS: TerminalPrefs = {
  themeId: DEFAULT_THEME_ID,
};

/** Sanitize a raw localStorage string into valid prefs. */
function parsePrefs(raw: string | null): TerminalPrefs {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    return { themeId: getThemePreset(parsed.themeId).id };
  } catch {
    return DEFAULT_PREFS;
  }
}

// Cache the snapshot so useSyncExternalStore gets a stable reference between
// changes (a fresh object every read would loop). Shared across all hook
// instances, which is exactly what we want — they all see the same store.
let cachedRaw: string | null = null;
let cachedPrefs: TerminalPrefs = DEFAULT_PREFS;

function getSnapshot(): TerminalPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = parsePrefs(raw);
  }
  return cachedPrefs;
}

function getServerSnapshot(): TerminalPrefs {
  return DEFAULT_PREFS;
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
 * Terminal appearance preferences shared across every session/tab in the
 * document. Backed by `localStorage` and read through `useSyncExternalStore`;
 * writes broadcast a custom event so all mounted terminals restyle together,
 * and the `storage` event keeps other browser tabs in sync too.
 */
export function useTerminalPrefs(): [
  TerminalPrefs,
  (patch: Partial<TerminalPrefs>) => void,
] {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((patch: Partial<TerminalPrefs>) => {
    const prev = getSnapshot();
    const next: TerminalPrefs = {
      themeId:
        patch.themeId !== undefined
          ? getThemePreset(patch.themeId).id
          : prev.themeId,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  }, []);

  return [prefs, update];
}
