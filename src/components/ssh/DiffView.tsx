"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { diffStats, lineDiff } from "@/lib/lineDiff";
import { useModalA11y } from "./hooks/useModalA11y";

/** One side of a diff: a file name and its full text. */
export interface DiffSide {
  name: string;
  content: string;
}

/**
 * Read-only unified diff of two text files (#76). The line-level diff is the
 * pure `lineDiff`; this renders it as a unified list (removed lines in red,
 * added in green) with a +N/-M summary. Opened from the file browser when
 * exactly two text files are selected.
 */
export function DiffView({
  a,
  b,
  onClose,
}: {
  a: DiffSide;
  b: DiffSide;
  onClose: () => void;
}) {
  const { ops, truncated } = useMemo(
    () => lineDiff(a.content, b.content),
    [a.content, b.content],
  );
  const stats = useMemo(() => diffStats(ops), [ops]);
  const dialogRef = useModalA11y<HTMLDivElement>({ onClose });

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-term-bg/80 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Diff of ${a.name} and ${b.name}`}
        className="term-modal-in flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-term-border bg-term-card shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-term-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-xs text-term-dim">
            <span className="min-w-0 truncate text-term-red" title={a.name}>
              − {a.name}
            </span>
            <span className="flex-none text-term-faint">vs</span>
            <span className="min-w-0 truncate text-term-green" title={b.name}>
              ＋ {b.name}
            </span>
          </div>
          <div className="flex flex-none items-center gap-3">
            <span className="tabular-nums text-xs text-term-faint">
              <span className="text-term-green">+{stats.added}</span>{" "}
              <span className="text-term-red">−{stats.removed}</span>
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-xs text-term-muted hover:text-term-text"
              aria-label="Close diff"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {truncated && (
          <p className="border-b border-term-border bg-term-yellow/10 px-4 py-1.5 text-xs text-term-yellow">
            Files are large — the diff was truncated.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto bg-term-bg font-mono text-xs leading-5">
          {ops.map((op, i) => (
            <div
              key={i}
              className={cn(
                "flex whitespace-pre",
                op.type === "add" && "bg-term-green/10 text-term-green",
                op.type === "del" && "bg-term-red/10 text-term-red",
                op.type === "same" && "text-term-dim",
              )}
            >
              <span className="w-10 flex-none select-none px-1 text-right text-term-faint">
                {op.aLine ?? ""}
              </span>
              <span className="w-10 flex-none select-none px-1 text-right text-term-faint">
                {op.bLine ?? ""}
              </span>
              <span className="w-4 flex-none select-none text-center">
                {op.type === "add" ? "+" : op.type === "del" ? "−" : " "}
              </span>
              <span className="flex-1 px-1">{op.text || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
