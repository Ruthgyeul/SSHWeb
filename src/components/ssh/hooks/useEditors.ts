"use client";

import { useCallback, useRef, useState } from "react";
import type { EditorFile } from "../FileEditor";

/**
 * Owns the inline text-editor's open files, active tab, and in-flight save
 * state for one SSH session — the state that used to live inline in the very
 * large `SshSession` component. It deliberately does NOT talk to the bridge:
 * the session still owns the WebSocket (`sftp-read`/`sftp-write`), and calls
 * these intent-named operations from its message handler and UI callbacks, so
 * the editor logic is localized without moving the transport.
 *
 * Working text lives in the `FileEditor` component's own buffers; here we track
 * only each open file's last *saved* content (`editors[i].content`) plus the
 * text of a save that's still awaiting the write ack (`pendingSaveText`), so the
 * ack can reconcile the saved content once the bridge confirms it.
 */
export interface EditorsApi {
  /** Open files, in tab order. */
  editors: EditorFile[];
  /** Path of the focused tab, or null when nothing is open. */
  activeEditor: string | null;
  /** Path whose save is in flight (drives the Save button), or null. */
  savingPath: string | null;
  /** Whether a file is already open (so a re-open just refocuses it). */
  isOpen: (path: string) => boolean;
  /** Handle a read-for-edit reply: open the file (or refocus if already open). */
  openForEdit: (path: string, name: string, content: string) => void;
  /** Focus an open tab. */
  select: (path: string) => void;
  /** Record a save's text and mark it in flight (the caller sends the write). */
  beginSave: (path: string, text: string) => void;
  /** Clear the in-flight save marker — for `path` only, or all when omitted. */
  clearSaving: (path?: string) => void;
  /** Reconcile a completed save: if `path` had a pending save, fold its text
   * into the file's saved content and return true; false if it wasn't ours. */
  markSaved: (path: string) => boolean;
  /** Close one tab, falling back to the last remaining file if it was active. */
  close: (path: string) => void;
  /** Close every open tab. */
  closeAll: () => void;
  /** Drop all editor state (on disconnect / session teardown). */
  reset: () => void;
}

export function useEditors(): EditorsApi {
  const [editors, setEditors] = useState<EditorFile[]>([]);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  // Text of a save awaiting its write ack, keyed by path (see markSaved).
  const pendingSaveTextRef = useRef<Record<string, string>>({});

  const isOpen = useCallback(
    (path: string) => editors.some((e) => e.path === path),
    [editors],
  );

  const openForEdit = useCallback(
    (path: string, name: string, content: string) => {
      setEditors((prev) =>
        prev.some((e) => e.path === path)
          ? prev // already open — just focus it (don't clobber edits)
          : [...prev, { path, name, content }],
      );
      setActiveEditor(path);
    },
    [],
  );

  const select = useCallback((path: string) => setActiveEditor(path), []);

  const beginSave = useCallback((path: string, text: string) => {
    pendingSaveTextRef.current[path] = text;
    setSavingPath(path);
  }, []);

  const clearSaving = useCallback((path?: string) => {
    setSavingPath((cur) =>
      path === undefined ? null : cur === path ? null : cur,
    );
  }, []);

  const markSaved = useCallback((path: string) => {
    const saved = pendingSaveTextRef.current[path];
    if (saved === undefined) return false;
    setEditors((prev) =>
      prev.map((e) => (e.path === path ? { ...e, content: saved } : e)),
    );
    delete pendingSaveTextRef.current[path];
    return true;
  }, []);

  const close = useCallback((path: string) => {
    setEditors((prev) => {
      const remaining = prev.filter((e) => e.path !== path);
      setActiveEditor((cur) =>
        cur !== path
          ? cur
          : remaining.length
            ? remaining[remaining.length - 1].path
            : null,
      );
      return remaining;
    });
  }, []);

  const closeAll = useCallback(() => {
    setEditors([]);
    setActiveEditor(null);
  }, []);

  const reset = useCallback(() => {
    setEditors([]);
    setActiveEditor(null);
    setSavingPath(null);
    pendingSaveTextRef.current = {};
  }, []);

  return {
    editors,
    activeEditor,
    savingPath,
    isOpen,
    openForEdit,
    select,
    beginSave,
    clearSaving,
    markSaved,
    close,
    closeAll,
    reset,
  };
}
