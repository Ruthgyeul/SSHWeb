"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSnippets } from "./hooks/useSnippets";

/**
 * A horizontally-scrolling bar of saved command snippets. Clicking a snippet
 * inserts its command into the terminal (without a trailing newline, so the user
 * reviews and presses Enter — the same safety posture as the paste guard). The
 * "+" button reveals an inline form to save a new snippet; snippets persist and
 * sync across sessions via {@link useSnippets}.
 */
export function SnippetsBar({ onRun }: { onRun: (command: string) => void }) {
  const { snippets, add, remove } = useSnippets();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  const keepFocus = (e: React.SyntheticEvent) => e.preventDefault();

  const submit = () => {
    if (!command.trim()) return;
    add(label, command);
    setLabel("");
    setCommand("");
    setAdding(false);
  };

  const chip =
    "group/snippet flex flex-none items-center gap-1 rounded border border-term-border bg-term-panel px-2 py-1 text-xs text-term-dim transition-colors hover:border-term-accent/40 hover:text-term-text";

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-term-border bg-term-panel/60 px-2 py-1.5">
      <span className="flex-none text-[11px] font-medium text-term-faint">
        Snippets
      </span>

      {snippets.map((s) => (
        <span key={s.id} className={chip}>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onRun(s.command)}
            title={s.command}
            className="max-w-[12rem] truncate"
          >
            {s.label}
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => remove(s.id)}
            className="text-term-faint opacity-0 transition-opacity hover:text-term-red group-hover/snippet:opacity-100"
            title="Delete snippet"
            aria-label={`Delete snippet ${s.label}`}
          >
            ✕
          </button>
        </span>
      ))}

      {adding ? (
        <span className="flex flex-none items-center gap-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label"
            spellCheck={false}
            className="w-20 rounded border border-term-border bg-term-panel px-1.5 py-0.5 text-xs text-term-text outline-none focus:border-term-accent"
          />
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setAdding(false);
              }
            }}
            placeholder="command…"
            spellCheck={false}
            autoFocus
            className="w-40 rounded border border-term-border bg-term-panel px-1.5 py-0.5 font-mono text-xs text-term-text outline-none focus:border-term-accent"
          />
          <button
            type="button"
            onClick={submit}
            className="rounded border border-term-accent/40 bg-term-accent/15 px-2 py-0.5 text-xs text-term-accent hover:bg-term-accent/25"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded border border-term-border px-2 py-0.5 text-xs text-term-muted hover:text-term-text"
          >
            ✕
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={cn(
            "flex-none rounded border border-dashed border-term-border px-2 py-1 text-xs text-term-muted hover:border-term-accent/40 hover:text-term-accent",
          )}
          title="Save a new snippet"
        >
          + snippet
        </button>
      )}
    </div>
  );
}
