"use client";

import { useState } from "react";

/**
 * A minimal inline editor for a remote text file. Fully controlled: the parent
 * supplies the loaded `content` and receives the edited text on save (which it
 * writes back over SFTP). Rendered as a modal over the file browser.
 */
export function FileEditor({
  name,
  path,
  content,
  saving,
  onSave,
  onClose,
}: {
  name: string;
  path: string;
  content: string;
  saving: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(content);
  const dirty = text !== content;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-term-card">
      <div className="flex items-center gap-3 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <span className="text-xs text-term-muted" aria-hidden>
          ✎
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-term-dim" title={path}>
          {name}
          {dirty && <span className="ml-1 text-term-yellow">●</span>}
        </span>
        <button
          type="button"
          onClick={() => onSave(text)}
          disabled={saving || !dirty}
          className="rounded border border-term-accent/40 bg-term-accent/15 px-3 py-1 text-xs font-medium text-term-accent hover:bg-term-accent/25 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
        >
          Close
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="min-h-0 flex-1 resize-none bg-term-bg p-4 font-mono text-sm text-term-text outline-none"
      />
    </div>
  );
}
