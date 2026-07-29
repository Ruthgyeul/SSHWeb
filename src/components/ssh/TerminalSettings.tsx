"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_THEMES,
} from "@/lib/terminalTheme";
import { cn } from "@/lib/utils";
import type { TerminalPrefs } from "./useTerminalPrefs";

/**
 * Gear button + popover that tunes the terminal's font size and color theme.
 * Fully controlled: the current {@link TerminalPrefs} come in and every change
 * is delegated up via `onChange` (the parent persists them through
 * `useTerminalPrefs`, so the choice is shared across sessions and reloads).
 */
export function TerminalSettings({
  prefs,
  onChange,
}: {
  prefs: TerminalPrefs;
  onChange: (patch: Partial<TerminalPrefs>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const stepBtn =
    "flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-muted hover:text-term-text disabled:opacity-40";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded px-2 py-1 text-xs transition-colors",
          open
            ? "bg-term-accent/15 text-term-accent"
            : "text-term-muted hover:text-term-text",
        )}
        title="Terminal appearance"
        aria-label="Terminal appearance"
        aria-expanded={open}
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-lg border border-term-border bg-term-panel p-3 shadow-xl">
          {/* Font size */}
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-term-muted">
                Font size
              </span>
              <span className="tabular-nums text-xs text-term-faint">
                {prefs.fontSize}px
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChange({ fontSize: prefs.fontSize - 1 })}
                disabled={prefs.fontSize <= MIN_FONT_SIZE}
                className={stepBtn}
                aria-label="Decrease font size"
              >
                −
              </button>
              <input
                type="range"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                value={prefs.fontSize}
                onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                className="h-1 flex-1 accent-term-accent"
                aria-label="Font size"
              />
              <button
                type="button"
                onClick={() => onChange({ fontSize: prefs.fontSize + 1 })}
                disabled={prefs.fontSize >= MAX_FONT_SIZE}
                className={stepBtn}
                aria-label="Increase font size"
              >
                +
              </button>
            </div>
          </div>

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
        </div>
      )}
    </div>
  );
}
