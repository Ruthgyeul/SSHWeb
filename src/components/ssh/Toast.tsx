"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight toast notifications for the SSH client. Their whole reason to
 * exist is *visible failure*: many actions (an over-size upload, a download that
 * trips the transfer cap, a rejected chmod) fail on the server and, before
 * these, left the UI silent — the user clicked and nothing happened. A toast
 * surfaces that outcome without stealing focus.
 *
 * Messages are shown verbatim from the bridge, which deliberately keeps them
 * short and credential-free (this deployment can be public), so we only clamp
 * runaway length here rather than trying to re-word server text.
 */
export type ToastKind = "error" | "info" | "success";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

/** How long a toast lingers before it auto-dismisses. */
const AUTO_DISMISS_MS = 6000;
/** Cap how many stack at once (oldest fall off) and how long a message can be. */
const MAX_VISIBLE = 3;
const MAX_LEN = 140;

/**
 * Clamp an arbitrary message to a single, bounded line so a verbose or
 * newline-laden error can't blow out the toast. Returns `""` for empty input so
 * callers can skip showing a blank toast.
 */
export function clampToastMessage(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  return text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
}

/**
 * Owns the toast list plus each toast's auto-dismiss timer. `notify` shows one;
 * `dismiss` removes it early (the ✕ button). Timers are cleared on unmount so a
 * closed session never fires a stray setState.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current[id];
    if (handle) {
      window.clearTimeout(handle);
      delete timers.current[id];
    }
  }, []);

  const notify = useCallback(
    (kind: ToastKind, message: string) => {
      const text = clampToastMessage(message);
      if (text === "") return;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setToasts((list) => [...list, { id, kind, message: text }].slice(-MAX_VISIBLE));
      timers.current[id] = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const handle of Object.values(timers.current)) {
        window.clearTimeout(handle);
      }
      timers.current = {};
    },
    [],
  );

  return { toasts, notify, dismiss };
}

const KIND_STYLES: Record<ToastKind, string> = {
  error: "border-term-red/50 bg-term-red/15 text-term-red",
  info: "border-term-accent/40 bg-term-accent/12 text-term-accent",
  success: "border-term-green/45 bg-term-green/12 text-term-green",
};

const KIND_ICON: Record<ToastKind, string> = {
  error: "✗",
  info: "•",
  success: "✓",
};

/** One toast row: an icon, the message, and a dismiss button. */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={cn(
        "term-fade-up pointer-events-auto flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-sm",
        KIND_STYLES[toast.kind],
      )}
    >
      <span aria-hidden className="mt-px font-mono leading-none">
        {KIND_ICON[toast.kind]}
      </span>
      <span className="min-w-0 flex-1 break-words leading-relaxed">
        {toast.message}
      </span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="ml-1 flex-none opacity-70 transition-opacity hover:opacity-100"
        aria-label="Dismiss notification"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * The floating stack of toasts, pinned to the top of a session panel. The
 * container itself ignores pointer events so it never blocks the terminal/file
 * UI underneath; only the toast rows (and their ✕) are clickable.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3 sm:items-end sm:pr-4"
      aria-live="polite"
    >
      <div className="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
