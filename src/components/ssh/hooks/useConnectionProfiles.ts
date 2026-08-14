"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  parseConnectionProfiles,
  removeConnectionProfile,
  upsertProfile,
  type ConnectionProfile,
  type ProfileInput,
} from "@/lib/connectionProfiles";

const STORAGE_KEY = "sshweb.connectionProfiles";
const SYNC_EVENT = "sshweb:connectionProfiles";

// Cache the parsed snapshot so useSyncExternalStore gets a stable reference
// between changes (same pattern as useSnippets). Shared across all sessions.
let cachedRaw: string | null = null;
let cachedProfiles: ConnectionProfile[] = [];

function getSnapshot(): ConnectionProfile[] {
  if (typeof window === "undefined") return cachedProfiles;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedProfiles = parseConnectionProfiles(raw);
  }
  return cachedProfiles;
}

function getServerSnapshot(): ConnectionProfile[] {
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

function persist(next: ConnectionProfile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(SYNC_EVENT));
  } catch {
    /* storage unavailable (private mode) — profiles just won't persist */
  }
}

function makeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Saved connection profiles (recent hosts), shared across every session/tab and
 * backed by localStorage. Stores connection *identity* only — never the
 * password or key. Returns the list plus `save`/`remove` mutators.
 */
export function useConnectionProfiles(): {
  profiles: ConnectionProfile[];
  save: (input: ProfileInput) => void;
  remove: (id: string) => void;
} {
  const profiles = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const save = useCallback((input: ProfileInput) => {
    if (!input.host.trim() || !input.username.trim()) return;
    persist(upsertProfile(getSnapshot(), input, makeId));
  }, []);

  const remove = useCallback((id: string) => {
    persist(removeConnectionProfile(getSnapshot(), id));
  }, []);

  return { profiles, save, remove };
}
