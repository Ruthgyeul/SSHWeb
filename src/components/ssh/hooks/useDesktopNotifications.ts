"use client";

import { useCallback, useEffect, useState } from "react";
import { canNotify, type NotifyPermission } from "@/lib/desktopNotify";

const STORAGE_KEY = "sshweb.desktopNotifications";

/**
 * Opt-in desktop notifications (#52): remembers the user's toggle in
 * localStorage, requests Notification permission when they enable it, and
 * exposes a `notify(title, body)` that fires only when the pure `canNotify`
 * gate allows (enabled + granted + page hidden). All Notification / document
 * access happens in effects and callbacks, never during render.
 */
export function useDesktopNotifications(): {
  supported: boolean;
  enabled: boolean;
  permission: NotifyPermission;
  setEnabled: (next: boolean) => void;
  notify: (title: string, body: string) => void;
} {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [permission, setPermission] = useState<NotifyPermission>("unsupported");

  // Read support / stored preference / current permission after mount (these
  // touch browser globals, so they can't run during render or SSR). Deferred to
  // a microtask so the state updates aren't synchronous within the effect.
  useEffect(() => {
    queueMicrotask(() => {
      const ok = typeof window !== "undefined" && "Notification" in window;
      setSupported(ok);
      if (ok) setPermission(Notification.permission);
      try {
        setEnabledState(localStorage.getItem(STORAGE_KEY) === "1");
      } catch {
        /* storage unavailable — default off */
      }
    });
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable — the toggle just won't persist */
      }
      // Ask for permission when turning it on and the browser hasn't decided yet.
      if (
        next &&
        supported &&
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        void Notification.requestPermission().then((p) => setPermission(p));
      }
    },
    [supported],
  );

  const notify = useCallback(
    (title: string, body: string) => {
      if (
        typeof Notification === "undefined" ||
        typeof document === "undefined"
      )
        return;
      if (
        !canNotify({
          enabled,
          permission: Notification.permission,
          hidden: document.hidden,
        })
      )
        return;
      try {
        new Notification(title, { body });
      } catch {
        /* construction can throw on some platforms — ignore */
      }
    },
    [enabled],
  );

  return { supported, enabled, permission, setEnabled, notify };
}
