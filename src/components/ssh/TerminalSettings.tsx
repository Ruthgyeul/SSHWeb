"use client";

import { useEffect, useRef, useState } from "react";
import {
  KNOWN_HOSTS_KEY,
  knownHostEntries,
  parseKnownHosts,
  removeKnownHost,
  serializeKnownHosts,
  type KnownHostMap,
} from "@/lib/knownHosts";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/sshProtocol";
import { SettingsIcon } from "./icons";

/**
 * Gear button + popover with session settings: trusted host-key (TOFU)
 * management and the in-browser media cache. SSHWeb uses a single fixed terminal
 * theme, so there is no theme/appearance picker here.
 */
/** Format a byte count for the media-cache readout, reusing the file browser's
 * shared size formatter (#28: drop the duplicate implementation). */
function formatBytes(n: number): string {
  return formatSize(n, "file");
}

export function TerminalSettings({
  onClearThumbnailCache,
  getCacheBytes,
  notifications,
}: {
  /** Evict this connection's cached grid thumbnails from the bridge, plus the
   * in-memory thumbnail + preview copies this browser is holding. */
  onClearThumbnailCache?: () => void | Promise<void>;
  /** Current bytes of cached media held in this browser (grid thumbnails +
   * recently-viewed previews), read when the popover opens to show the size. */
  getCacheBytes?: () => number;
  /** Desktop-notification toggle (#52): supported/enabled state + a setter.
   * Omitted when the browser has no Notification API. */
  notifications?: {
    supported: boolean;
    enabled: boolean;
    permission: string;
    onToggle: (next: boolean) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  // Bytes of in-browser cached media, sampled when the popover opens (and reset
  // to 0 after a clear) so the read-out reflects what "Clear" will free.
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
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
      setCacheBytes(getCacheBytes ? getCacheBytes() : null);
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
    setCacheBytes(0);
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
        title="Settings"
        aria-label="Settings"
        aria-expanded={open}
      >
        <SettingsIcon className="h-4 w-4" />
      </button>

      {open && (
        <div
          className={cn(
            "z-50 rounded-lg border border-term-border bg-term-panel p-3 shadow-xl",
            // Mobile: a viewport-anchored bottom sheet. The session container is
            // `overflow-hidden` and the gear isn't at the far right once the
            // header wraps, so an `absolute right-0 w-64` dropdown would spill
            // off (and get clipped) on a narrow screen. `fixed` escapes the
            // clipping container; centered + inset keeps it fully on-screen and
            // it scrolls if the content is tall.
            "fixed inset-x-3 bottom-3 mx-auto max-h-[70vh] w-auto max-w-sm overflow-y-auto",
            // ≥sm: the original dropdown anchored under the gear button.
            "sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mx-0 sm:mt-1.5 sm:max-h-none sm:w-64 sm:max-w-none sm:overflow-visible",
          )}
        >
          {/* Known hosts (TOFU store) */}
          <div>
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

          {/* Desktop notifications (#52) */}
          {notifications?.supported && (
            <div className="mt-3 border-t border-term-border pt-3">
              <label className="flex items-center gap-2 text-xs text-term-dim">
                <input
                  type="checkbox"
                  checked={notifications.enabled}
                  onChange={(e) => notifications.onToggle(e.target.checked)}
                  className="accent-term-accent"
                />
                Desktop notifications on disconnect
              </label>
              {notifications.enabled &&
                notifications.permission === "denied" && (
                  <p className="mt-1 text-[10px] text-term-yellow">
                    Blocked by the browser — allow notifications in site
                    settings.
                  </p>
                )}
            </div>
          )}

          {/* Grid thumbnail cache */}
          {onClearThumbnailCache && (
            <div className="mt-3 border-t border-term-border pt-3">
              <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-term-muted">
                <span>Media cache</span>
                {cacheBytes !== null && (
                  <span className="tabular-nums text-term-faint">
                    {formatBytes(cacheBytes)} in memory
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={clearCache}
                className="w-full rounded border border-term-border px-2 py-1 text-xs text-term-dim transition-colors hover:border-term-red hover:text-term-red"
              >
                Clear cache{cacheBytes ? ` (${formatBytes(cacheBytes)})` : ""}
              </button>
              <p className="mt-1 text-[10px] text-term-faint">
                {cacheCleared
                  ? "Cleared. Thumbnails & previews regenerate as you browse."
                  : "Drops this browser's cached thumbnails & previews, and evicts this connection's tiles on the server."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
