"use client";

import { useCallback } from "react";
import { makePersistentStore } from "./usePersistentStore";

const store = makePersistentStore<boolean>(
  "sshweb.showHidden",
  (raw) => raw === "1",
  false,
);

/**
 * Whether the file browser shows dotfiles (hidden files), persisted across
 * sessions/tabs (#70). Off by default, matching a plain `ls`.
 */
export function useShowHidden(): [boolean, (next: boolean) => void] {
  const showHidden = store.useValue();
  const setShowHidden = useCallback(
    (next: boolean) => store.set(next ? "1" : "0"),
    [],
  );
  return [showHidden, setShowHidden];
}
