"use client";

import { useEffect, useRef, useState } from "react";
import { TERMINAL_THEMES } from "@/lib/terminalTheme";
import {
  KNOWN_HOSTS_KEY,
  knownHostEntries,
  parseKnownHosts,
  removeKnownHost,
  serializeKnownHosts,
  type KnownHostMap,
} from "@/lib/knownHosts";
import { cn } from "@/lib/utils";
import type { TerminalPrefs } from "./useTerminalPrefs";

/**
 * Gear button + popover that picks the terminal's color theme. Fully
 * controlled: the current {@link TerminalPrefs} come in and every change is
 * delegated up via `onChange` (the parent persists them through
 * `useTerminalPrefs`, so the choice is shared across sessions and reloads).
 */
export function TerminalSettings({
  prefs,
  onChange,
  onClearThumbnailCache,
  thumbnailCacheElevated = false,
}: {
  prefs: TerminalPrefs;
  onChange: (patch: Partial<TerminalPrefs>) => void;
  /** Wipe the persistent grid-thumbnail cache (IndexedDB + in-memory). */
  onClearThumbnailCache?: () => void | Promise<void>;
  /** Whether the session is currently elevated (sudo). Elevated thumbnails are
   * never persisted, so the clear-cache action only makes sense off `sudo`. */
  thumbnailCacheElevated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Trusted host keys (TOFU store), read from localStorage when the popover
  // opens (see `toggle`) so the list reflects any keys accepted since it last
  // closed.
  const [hosts, setHosts] = useState<KnownHostMap>({});

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setCacheCleared(false);
      try {
        setHosts(parseKnownHosts(localStorage.getItem(KNOWN_HOSTS_KEY)));
      } catch {
        setHosts({});
      }
    }
  };

  const clearCache = async () => {
    await onClearThumbnailCache?.();
    setCacheCleared(true);
  };

  const forgetHost = (id: string) => {
    setHosts((prev) => {
      const next = removeKnownHost(prev, id);
      try {
        localStorage.setItem(KNOWN_HOSTS_KEY, serializeKnownHosts(next));
      } catch {
        /* storage unavailable (private mode) — the in-memory list still updates */
      }
      return next;
    });
  };

  const hostList = knownHostEntries(hosts);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          "rounded px-2 py-1 text-xs transition-colors",
          open
            ? "bg-term-accent/15 text-term-accent"
            : "text-term-muted hover:text-term-text",
        )}
        title="Terminal theme"
        aria-label="Terminal theme"
        aria-expanded={open}
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-term-border bg-term-panel p-3 shadow-xl">
          {/* Theme */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-term-muted">
              Color theme
            </span>
            <div className="flex flex-col gap-1">
              {TERMINAL_THEMES.map((preset) => {
                const selected = preset.id === prefs.themeId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onChange({ themeId: preset.id })}
                    className={cn(
                      "flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                      selected
                        ? "bg-term-accent/15 text-term-accent"
                        : "text-term-dim hover:bg-term-card",
                    )}
                  >
                    <span
                      className="flex h-4 w-4 flex-none items-center justify-center rounded-sm border border-term-border"
                      style={{ background: preset.theme.background }}
                      aria-hidden
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: preset.theme.green }}
                      />
                    </span>
                    <span className="flex-1 truncate">{preset.label}</span>
                    {selected && <span aria-hidden>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Known hosts (TOFU store) */}
          <div className="mt-3 border-t border-term-border pt-3">
            <span className="mb-1.5 block text-xs font-medium text-term-muted">
              Trusted host keys
            </span>
            {hostList.length === 0 ? (
              <p className="text-xs text-term-faint">
                No trusted hosts yet. Keys you accept on first connect appear
                here.
              </p>
            ) : (
              <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto">
                {hostList.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-2 rounded px-2 py-1 hover:bg-term-card"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-term-dim">
                        {h.host}
                        <span className="text-term-faint">:{h.port}</span>
                      </span>
                      <span
                        className="block truncate font-mono text-[10px] text-term-faint"
                        title={h.fingerprint}
                      >
                        {h.fingerprint}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => forgetHost(h.id)}
                      className="flex-none rounded px-1.5 py-0.5 text-xs text-term-muted transition-colors hover:text-term-red"
                      title="Forget this host key"
                      aria-label={`Forget host key for ${h.host}:${h.port}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Grid thumbnail cache */}
          {onClearThumbnailCache && (
            <div className="mt-3 border-t border-term-border pt-3">
              <span className="mb-1.5 block text-xs font-medium text-term-muted">
                Grid thumbnail cache
              </span>
              {thumbnailCacheElevated ? (
                <p className="text-xs text-term-faint">
                  Elevated (sudo) thumbnails are never cached. Drop{" "}
                  <span className="whitespace-nowrap">sudo</span> to clear the
                  saved cache.
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={clearCache}
                    className="w-full rounded border border-term-border px-2 py-1 text-xs text-term-dim transition-colors hover:border-term-red hover:text-term-red"
                  >
                    Clear thumbnail cache
                  </button>
                  <p className="mt-1 text-[10px] text-term-faint">
                    {cacheCleared
                      ? "Cleared. Thumbnails will regenerate as you browse."
                      : "Frees the saved grid thumbnails on this device."}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
