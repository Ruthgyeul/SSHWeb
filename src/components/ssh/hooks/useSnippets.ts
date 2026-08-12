"use client";

import { useCallback, useSyncExternalStore } from "react";

/** A saved command snippet: a short `label` and the `command` text it inserts. */
export interface Snippet {
  id: string;
  label: string;
  command: string;
}

const STORAGE_KEY = "sshweb.snippets";
const SYNC_EVENT = "sshweb:snippets";

/** Sanitize a raw localStorage string into a snippet list. */
function parseSnippets(raw: string | null): Snippet[] {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s) =>
          s &&
          typeof s.id === "string" &&
          typeof s.label === "string" &&
          typeof s.command === "string",
      )
      .map((s) => ({ id: s.id, label: s.label, command: s.command }));
  } catch {
    return [];
  }
}

// Cache the snapshot so useSyncExternalStore gets a stable reference (see the
// same pattern in useTerminalPrefs). Shared across all mounted sessions.
let cachedRaw: string | null = null;
let cachedSnippets: Snippet[] = [];

function getSnapshot(): Snippet[] {
  if (typeof window === "undefined") return cachedSnippets;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSnippets = parseSnippets(raw);
  }
  return cachedSnippets;
}

function getServerSnapshot(): Snippet[] {
  return [];
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

function persist(next: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(SYNC_EVENT));
  } catch {
    /* storage unavailable (private mode) — snippets just won't persist */
  }
}

/**
 * Command snippets shared across every session/tab, backed by localStorage.
 * Returns the current list plus `add`/`remove` mutators.
 */
export function useSnippets(): {
  snippets: Snippet[];
  add: (label: string, command: string) => void;
  remove: (id: string) => void;
} {
  const snippets = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const add = useCallback((label: string, command: string) => {
    const trimmedCmd = command.trim();
    if (!trimmedCmd) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    persist([
      ...getSnapshot(),
      { id, label: label.trim() || trimmedCmd, command: trimmedCmd },
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    persist(getSnapshot().filter((s) => s.id !== id));
  }, []);

  return { snippets, add, remove };
}
