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
import { PencilIcon, SearchIcon } from "./icons";
import { useModalA11y } from "./hooks/useModalA11y";

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

/** One open file in the editor. `content` is the last saved text from the server. */
export interface EditorFile {
  path: string;
  name: string;
  content: string;
}

/**
 * A minimal inline editor for remote text files, with line numbers and
 * lightweight syntax highlighting. Several files can be open at once as tabs;
 * each keeps its own edit buffer, so switching tabs never loses unsaved work.
 *
 * The visible text is a transparent `<textarea>` layered over a highlighted
 * `<pre>`, their scroll positions kept in sync so the caret always sits on the
 * right glyph. Working text lives here in `buffers` (keyed by path); a file with
 * no buffer entry is pristine, so `content` updates from the parent (after a
 * save) reconcile cleanly without clobbering edits.
 */
export function FileEditor({
  files,
  activePath,
  savingPath,
  onSave,
  onSelect,
  onCloseFile,
  onCloseAll,
}: {
  files: EditorFile[];
  activePath: string;
  /** Path currently being written, or null — drives the Save button state. */
  savingPath: string | null;
  onSave: (path: string, text: string) => void;
  onSelect: (path: string) => void;
  onCloseFile: (path: string) => void;
  onCloseAll: () => void;
}) {
  // Per-file working text. Absent = pristine (equals that file's `content`).
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  // A pending close awaiting confirmation because of unsaved changes.
  const [confirm, setConfirm] = useState<
    { kind: "file"; path: string } | { kind: "all" } | null
  >(null);

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

  const activeFile =
    files.find((f) => f.path === activePath) ?? files[0] ?? null;
  const activeContent = activeFile?.content ?? "";
  const text =
    activeFile && activeFile.path in buffers
      ? buffers[activeFile.path]
      : activeContent;
  const dirty = text !== activeContent;
  const saving = savingPath !== null && savingPath === activeFile?.path;

  const isDirty = (f: EditorFile) =>
    f.path in buffers && buffers[f.path] !== f.content;
  const anyDirty = files.some(isDirty);

  const setText = (next: string) => {
    if (!activeFile) return;
    setBuffers((b) => ({ ...b, [activeFile.path]: next }));
  };

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

  // Warn before a browser navigation/refresh discards unsaved work.
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  // Close one tab; forget its buffer so a later reopen starts from server state.
  const doCloseFile = (path: string) => {
    setBuffers((b) => {
      if (!(path in b)) return b;
      const rest = { ...b };
      delete rest[path];
      return rest;
    });
    onCloseFile(path);
  };
  const requestCloseFile = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (f && isDirty(f)) setConfirm({ kind: "file", path });
    else doCloseFile(path);
  };
  const requestCloseAll = () => {
    if (anyDirty) setConfirm({ kind: "all" });
    else onCloseAll();
  };
  const confirmDiscard = () => {
    if (!confirm) return;
    if (confirm.kind === "file") doCloseFile(confirm.path);
    else onCloseAll();
    setConfirm(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (activeFile && dirty && !saving) onSave(activeFile.path, text);
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
      else requestCloseAll();
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

  // Screen-reader dialog semantics + focus restore on close. The editor owns
  // Escape (discard guard) and Tab (insert two spaces), so no trap here.
  const dialogRef = useModalA11y<HTMLDivElement>({
    onClose: onCloseAll,
    closeOnEscape: false,
    trapFocus: false,
  });

  if (!activeFile) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="File editor"
      className="absolute inset-0 z-30 flex flex-col bg-term-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-term-border bg-term-panel/90 px-4 py-2.5">
        <PencilIcon className="h-4 w-4 text-term-muted" />
        <span
          className="min-w-0 flex-1 truncate text-xs text-term-dim"
          title={activeFile.path}
        >
          {activeFile.name}
          {dirty && <span className="ml-1 text-term-yellow">●</span>}
        </span>
        <button
          type="button"
          onClick={openFind}
          className="flex items-center gap-1.5 rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
          title="Find / replace (Ctrl+F)"
        >
          <SearchIcon className="h-3.5 w-3.5" /> Find
        </button>
        <button
          type="button"
          onClick={() => onSave(activeFile.path, text)}
          disabled={saving || !dirty}
          className="rounded border border-term-accent/40 bg-term-accent/15 px-3 py-1 text-xs font-medium text-term-accent hover:bg-term-accent/25 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={requestCloseAll}
          className="rounded border border-term-border px-3 py-1 text-xs text-term-muted hover:text-term-text"
        >
          Close
        </button>
      </div>

      {/* Open-file tabs (only when more than one file is open) */}
      {files.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-term-border bg-term-panel/60 px-2 py-1">
          {files.map((f) => (
            <div
              key={f.path}
              className={cn(
                "flex flex-none items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                f.path === activeFile.path
                  ? "bg-term-accent/15 text-term-accent"
                  : "text-term-muted hover:text-term-text",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(f.path)}
                className="max-w-[10rem] truncate"
                title={f.path}
              >
                {f.name}
                {isDirty(f) && <span className="ml-1 text-term-yellow">●</span>}
              </button>
              <button
                type="button"
                onClick={() => requestCloseFile(f.path)}
                className="text-term-faint hover:text-term-red"
                aria-label={`Close ${f.name}`}
                title="Close tab"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

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
            style={{
              ...TEXT_STYLE,
              padding: PAD,
              caretColor: "var(--color-term-text)",
            }}
          />
        </div>
      </div>

      {/* Unsaved-changes confirmation */}
      {confirm && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-term-bg/70 p-4">
          <div className="w-full max-w-sm rounded-lg border border-term-border bg-term-card p-5">
            <h3 className="text-sm font-semibold text-term-text">
              Discard unsaved changes?
            </h3>
            <p className="mt-1 text-xs text-term-muted">
              {confirm.kind === "all"
                ? "One or more open files have unsaved edits."
                : "This file has unsaved edits."}{" "}
              Closing will lose them.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded border border-term-border px-3 py-1.5 text-xs text-term-muted hover:text-term-text"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={confirmDiscard}
                className="rounded border border-term-red/40 bg-term-red/10 px-3 py-1.5 text-xs text-term-red hover:bg-term-red/20"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
