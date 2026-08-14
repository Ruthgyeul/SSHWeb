"use client";

import { useModalA11y } from "./hooks/useModalA11y";

/**
 * Confirmation modal shown before a multi-line paste reaches the shell. Pasting
 * text that contains newlines can run several commands at once (each newline is
 * an Enter), so we preview the content and let the user confirm — a guard
 * against fat-finger mistakes and paste-jacking. Single-line input is never
 * gated; it flows straight through.
 */
export function PasteConfirm({
  text,
  onConfirm,
  onCancel,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Strip bracketed-paste markers (\x1b[200~ … \x1b[201~) for a clean preview;
  // the untouched original is what actually gets sent on confirm.
  const preview = text.replace(/\x1b\[20[01]~/g, "");
  const lineCount = preview.replace(/\n$/, "").split("\n").length;
  const dialogRef = useModalA11y<HTMLDivElement>({ onClose: onCancel });

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-term-bg/80 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-confirm-title"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-term-border bg-term-card shadow-2xl"
      >
        <div className="border-b border-term-border px-5 py-3">
          <h2
            id="paste-confirm-title"
            className="text-sm font-semibold text-term-text"
          >
            Paste {lineCount} lines into the terminal?
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-term-muted">
            This paste spans multiple lines — each newline runs as a separate
            command. Review it before sending.
          </p>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-term-bg px-5 py-3 font-mono text-xs text-term-dim">
          {preview}
        </pre>
        <div className="flex justify-end gap-2 border-t border-term-border px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-term-border px-4 py-1.5 text-xs text-term-muted hover:text-term-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-term-accent/40 bg-term-accent/15 px-4 py-1.5 text-xs font-medium text-term-accent hover:bg-term-accent/25"
          >
            Paste &amp; run
          </button>
        </div>
      </div>
    </div>
  );
}
