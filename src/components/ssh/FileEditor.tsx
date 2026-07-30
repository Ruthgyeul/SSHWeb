"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { highlightToHtml } from "@/lib/syntaxHighlight";
import { cn } from "@/lib/utils";
import {
  findMatches,
  nextMatchIndex,
  replaceAll,
  replaceMatch,
  type Match,
} from "@/lib/editorSearch";

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
  const findRef = useRef<HTMLInputElement>(null);

  // Find/replace bar state.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);

  const html = useMemo(() => highlightToHtml(text), [text]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const gutterWidth = `${String(lineCount).length + 1}ch`;

  const matches = useMemo(
    () => findMatches(text, query, caseSensitive),
    [text, query, caseSensitive],
  );

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

  // Select a match in the textarea and scroll it into view; keeps the find box
  // focused (so Enter can keep stepping) while revealing the hit in the editor.
  const revealMatch = (m: Match) => {
    const ta = taRef.current;
    if (!ta) return;
    ta.setSelectionRange(m.start, m.end);
    const lineH = 13 * 1.5; // fontSize * lineHeight from TEXT_STYLE
    const line = text.slice(0, m.start).split("\n").length - 1;
    const target = line * lineH;
    const view = ta.clientHeight;
    if (target < ta.scrollTop || target > ta.scrollTop + view - lineH) {
      ta.scrollTop = Math.max(0, target - view / 2);
    }
    syncScroll();
  };

  // Step to the next/previous match relative to the current caret, wrapping.
  const findStep = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    const ta = taRef.current;
    const caret = ta ? (dir === 1 ? ta.selectionEnd : ta.selectionStart) : 0;
    const idx = nextMatchIndex(matches, caret, dir);
    if (idx < 0) return;
    setMatchIdx(idx);
    revealMatch(matches[idx]);
  };

  // Replace the currently selected match (if the selection still spans one),
  // then move on to the next occurrence.
  const replaceCurrent = () => {
    const ta = taRef.current;
    if (!ta || matches.length === 0) return;
    const hit = matches.find(
      (m) => m.start === ta.selectionStart && m.end === ta.selectionEnd,
    );
    const m = hit ?? matches[Math.min(matchIdx, matches.length - 1)];
    const { text: next, caret } = replaceMatch(text, m, replaceText);
    setText(next);
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(caret, caret);
      taRef.current?.focus();
    });
  };

  const replaceAllNow = () => {
    const { text: next, count } = replaceAll(
      text,
      query,
      replaceText,
      caseSensitive,
    );
    if (count > 0) setText(next);
  };

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => findRef.current?.focus());
  };
  const closeFind = () => {
    setFindOpen(false);
    taRef.current?.focus();
  };

  // Focus the find field whenever the bar opens.
  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !saving) onSave(text);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (findOpen) closeFind();
      else onClose();
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
          onClick={openFind}
          className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
          title="Find / replace (Ctrl+F)"
        >
          🔍 Find
        </button>
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

      {/* Find / replace bar */}
      {findOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel/70 px-3 py-1.5">
          <input
            ref={findRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findStep(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder="Find"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 font-mono text-xs text-term-text outline-none placeholder:text-term-faint focus:border-term-accent"
            aria-label="Find"
          />
          <span className="tabular-nums text-xs text-term-faint">
            {matches.length > 0
              ? `${Math.min(matchIdx + 1, matches.length)}/${matches.length}`
              : query
                ? "0/0"
                : ""}
          </span>
          <button
            type="button"
            onClick={() => findStep(-1)}
            disabled={matches.length === 0}
            className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-40"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => findStep(1)}
            disabled={matches.length === 0}
            className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-40"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <input
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
            placeholder="Replace"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-term-border bg-term-bg px-2 py-1 font-mono text-xs text-term-text outline-none placeholder:text-term-faint focus:border-term-accent"
            aria-label="Replace with"
          />
          <button
            type="button"
            onClick={replaceCurrent}
            disabled={matches.length === 0}
            className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-40"
            title="Replace the current match"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={replaceAllNow}
            disabled={matches.length === 0}
            className="rounded border border-term-border px-2 py-1 text-xs text-term-muted hover:text-term-text disabled:opacity-40"
            title="Replace every match"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setCaseSensitive((v) => !v)}
            className={cn(
              "rounded border px-2 py-1 text-xs transition-colors",
              caseSensitive
                ? "border-term-accent/40 bg-term-accent/15 text-term-accent"
                : "border-term-border text-term-muted hover:text-term-text",
            )}
            title="Match case"
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
          <button
            type="button"
            onClick={closeFind}
            className="rounded px-2 py-1 text-xs text-term-muted hover:text-term-text"
            aria-label="Close find bar"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}

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
