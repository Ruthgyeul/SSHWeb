"use client";

import { useCallback } from "react";
import { makePersistentStore } from "./usePersistentStore";

/** Which optional list-view columns are shown (Name is always shown). */
export interface FileColumns {
  size: boolean;
  perms: boolean;
  modified: boolean;
}

export type FileColumnKey = keyof FileColumns;

const DEFAULT_COLUMNS: FileColumns = {
  size: true,
  perms: true,
  modified: true,
};

function parse(raw: string | null): FileColumns {
  if (!raw) return DEFAULT_COLUMNS;
  try {
    const v = JSON.parse(raw);
    return {
      size: v?.size !== false,
      perms: v?.perms !== false,
      modified: v?.modified !== false,
    };
  } catch {
    return DEFAULT_COLUMNS;
  }
}

const store = makePersistentStore<FileColumns>(
  "sshweb.fileColumns",
  parse,
  DEFAULT_COLUMNS,
);

/**
 * The list view's optional-column visibility (Size / Perms / Modified),
 * persisted across sessions/tabs (#71). Name is always shown; owner/group
 * aren't carried in a listing entry, so they aren't offered here.
 */
export function useFileColumns(): [FileColumns, (key: FileColumnKey) => void] {
  const columns = store.useValue();
  const toggleColumn = useCallback((key: FileColumnKey) => {
    // Flip against the store's authoritative value (not a possibly-stale render
    // snapshot), then persist.
    const current = store.get();
    store.set(JSON.stringify({ ...current, [key]: !current[key] }));
  }, []);
  return [columns, toggleColumn];
}
