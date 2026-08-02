"use client";

import { useEffect } from "react";

interface Shortcut {
  keys: string[];
  desc: string;
}

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: "Terminal",
    items: [
      { keys: ["Ctrl/⌘", "F"], desc: "Search the scrollback buffer" },
      { keys: ["Enter"], desc: "Next search match" },
      { keys: ["Shift", "Enter"], desc: "Previous search match" },
      { keys: ["Esc"], desc: "Close the search bar" },
      { keys: ["Ctrl", "C"], desc: "Send SIGINT (or copy when text is selected)" },
    ],
  },
  {
    title: "Files (SFTP)",
    items: [
      { keys: ["Double-click"], desc: "Open by type: dir · image · text · download" },
      { keys: ["Drag & drop"], desc: "Upload files into the current directory" },
    ],
  },
  {
    title: "Preview",
    items: [
      { keys: ["←", "→"], desc: "Previous / next file (gallery)" },
      { keys: ["Shift", "←/→"], desc: "Previous / next file (works over video/audio too)" },
      { keys: ["+", "−"], desc: "Zoom an image in / out" },
      { keys: ["0"], desc: "Reset the image view" },
      { keys: ["R"], desc: "Rotate the image 90°" },
      { keys: ["Space"], desc: "Play / pause a video" },
      { keys: ["←", "→"], desc: "Seek a video ∓5s (Shift+←/→ steps the gallery)" },
      { keys: ["↑", "↓"], desc: "Video volume up / down (M mute, F fullscreen)" },
      { keys: ["Ctrl/⌘", "F"], desc: "Find in a text preview" },
      { keys: ["Esc"], desc: "Close the find bar / the preview" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: ["Ctrl/⌘", "S"], desc: "Save the file" },
      { keys: ["Tab"], desc: "Insert two spaces" },
      { keys: ["Esc"], desc: "Close the editor" },
    ],
  },
  {
    title: "Touch devices",
    items: [
      { keys: ["Ctrl / Alt"], desc: "Sticky one-shot modifier for the next key" },
      { keys: ["Fn"], desc: "Toggle the F1–F12 row" },
    ],
  },
];

/** A modal cheat-sheet of the app's keyboard and pointer shortcuts. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-term-bg/80 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-term-border bg-term-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-term-border px-5 py-3">
          <h2 className="text-sm font-semibold text-term-text">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {GROUPS.map((group) => (
            <div key={group.title} className="mb-4 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-term-faint">
                {group.title}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.desc}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-term-muted">{item.desc}</span>
                    <span className="flex flex-none items-center gap-1">
                      {item.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-term-border bg-term-panel px-1.5 py-0.5 font-mono text-[11px] text-term-dim"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
