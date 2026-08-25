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
// between changes. Shared across all sessions.
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

let idCounter = 0;

/** A unique id for a profile list entry (a plain list key, not a secret). Uses
 * Web Crypto so there's no insecure-randomness sink; falls back to a
 * timestamp+counter only when Web Crypto is entirely unavailable. */
function makeId(): string {
  if (typeof crypto !== "undefined") {
    if (crypto.randomUUID) return crypto.randomUUID();
    if (crypto.getRandomValues) {
      const b = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
  }
  return `${Date.now()}-${idCounter++}`;
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
