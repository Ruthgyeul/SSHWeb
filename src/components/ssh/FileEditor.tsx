"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { highlightToHtml } from "@/lib/syntaxHighlight";

// Text metrics shared by the textarea, the highlight overlay and the gutter, so
// all three line up to the pixel. Any change here must apply to all three.
const TEXT_STYLE: CSSProperties = {
  fontFamily:
    'var(--font-geist-mono), ui-monospace, "SFMono-Regular", Menlo, monospace',
  fontSize: "13px",
  lineHeight: "1.5",
  tabSize: 2,
  whiteSpace: "pre",
  margin: 0,
};
const PAD = 12; // px padding around the code (both textarea and overlay)

/**
 * A minimal inline editor for a remote text file, with line numbers and
 * lightweight syntax highlighting. The visible text is a transparent
 * `<textarea>` layered over a highlighted `<pre>`; their scroll positions are
 * kept in sync so the caret always sits on the right glyph. Fully controlled:
 * the parent supplies the loaded `content` and receives the edited text on save.
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

  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => highlightToHtml(text), [text]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const gutterWidth = `${String(lineCount).length + 1}ch`;

  // Lock the overlay + gutter to the textarea's scroll offset.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !saving) onSave(text);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = ta;
      setText(text.slice(0, start) + "  " + text.slice(end));
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

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

      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-term-bg">
        {/* Line-number gutter (scrolls with the text) */}
        <div
          className="flex-none select-none overflow-hidden border-r border-term-border/50 text-right text-term-faint"
          style={{ width: gutterWidth }}
          aria-hidden
        >
          <div
            ref={gutterRef}
            style={{
              ...TEXT_STYLE,
              paddingTop: PAD,
              paddingBottom: PAD,
              paddingLeft: 6,
              paddingRight: 8,
              willChange: "transform",
            }}
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </div>
        </div>

        {/* Code area: transparent textarea over a highlighted <pre> */}
        <div className="relative min-w-0 flex-1">
          <pre
            ref={preRef}
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 text-term-text"
            style={{ ...TEXT_STYLE, padding: PAD, willChange: "transform" }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="absolute inset-0 resize-none overflow-auto bg-transparent text-transparent outline-none"
            style={{ ...TEXT_STYLE, padding: PAD, caretColor: "var(--color-term-text)" }}
          />
        </div>
      </div>
    </div>
  );
}
