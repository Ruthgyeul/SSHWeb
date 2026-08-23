"use client";

import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import { getThemePreset, type TerminalTheme } from "@/lib/terminalTheme";

/** Fixed terminal font size (px); intentionally not user-configurable. */
const FONT_SIZE = 13;

/** Imperative surface the parent uses to drive the terminal. */
export interface XtermHandle {
  /** Write raw bytes received from the server into the terminal. */
  write(bytes: Uint8Array): void;
  /** Write a string (e.g. a local status banner). */
  writeln(text: string): void;
  /** Re-fit to the container and return the new {cols, rows}. */
  fit(): { cols: number; rows: number } | null;
  focus(): void;
  clear(): void;
  /** The user's current terminal selection (empty string if none). */
  getSelection(): string;
  /** Open the scrollback search bar and focus its input. */
  openSearch(): void;
}

/** Decoration colors for search matches (accent for matches, green for active). */
const SEARCH_DECORATIONS = {
  matchBackground: "#38bdf855",
  matchBorder: "#38bdf8",
  matchOverviewRuler: "#38bdf8",
  activeMatchBackground: "#34d39988",
  activeMatchBorder: "#34d399",
  activeMatchColorOverviewRuler: "#34d399",
} as const;

/**
 * A thin React wrapper around xterm.js.
 *
 * xterm touches the DOM at import time, so it is loaded dynamically inside an
 * effect (never during SSR). The parent talks to it through the imperative
 * {@link XtermHandle} rather than props, which matches how a byte stream flows.
 *
 * `onData` fires for every keystroke/paste; `onResize` fires when the fit addon
 * changes the grid — both should be forwarded to the SSH server. `fontSize` and
 * `theme` are live-applied whenever they change (the settings popover drives
 * them). A built-in search bar (Ctrl/Cmd+F) searches the scrollback buffer.
 */
export const XtermView = forwardRef<
  XtermHandle,
  {
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    className?: string;
    theme?: TerminalTheme;
  }
>(function XtermView({ onData, onResize, className, theme }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const searchRef = useRef<XSearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // xterm loads asynchronously (dynamic import). Any output that arrives before
  // it is ready would otherwise be silently dropped, so queue it and flush on
  // init — this is what keeps the connect banner and first shell bytes visible.
  const pendingRef = useRef<Array<(term: XTerminal) => void>>([]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState({ index: -1, count: 0 });

  // Keep the latest callbacks/props without re-running the setup effect.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  const themeRef = useRef<TerminalTheme>(
    theme ?? getThemePreset(undefined).theme,
  );
  themeRef.current = theme ?? getThemePreset(undefined).theme;

  const openSearch = () => {
    setSearchOpen(true);
    // Focus after the input mounts.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const runSearch = (term: string, forward = true) => {
    const addon = searchRef.current;
    if (!addon) return;
    const opts = { decorations: SEARCH_DECORATIONS } as const;
    if (!term) {
      addon.clearDecorations();
      setResults({ index: -1, count: 0 });
      return;
    }
    if (forward) addon.findNext(term, opts);
    else addon.findPrevious(term, opts);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    setResults({ index: -1, count: 0 });
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  useImperativeHandle(ref, () => {
    // Run now if the terminal is ready, otherwise queue until it is.
    const enqueue = (fn: (term: XTerminal) => void) => {
      if (termRef.current) fn(termRef.current);
      else pendingRef.current.push(fn);
    };
    return {
      write: (bytes) => enqueue((t) => t.write(bytes)),
      writeln: (text) => enqueue((t) => t.writeln(text)),
      fit: () => {
        fitRef.current?.fit();
        const term = termRef.current;
        return term ? { cols: term.cols, rows: term.rows } : null;
      },
      focus: () => termRef.current?.focus(),
      clear: () => termRef.current?.clear(),
      getSelection: () => termRef.current?.getSelection() ?? "",
      openSearch,
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { SearchAddon } = await import("@xterm/addon-search");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'var(--font-geist-mono), ui-monospace, "SFMono-Regular", Menlo, monospace',
        fontSize: FONT_SIZE,
        theme: themeRef.current,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      // Make URLs in terminal output clickable (#62). Open in a new tab with
      // noopener/noreferrer so a linked page can't reach back into this one.
      term.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (event.button !== 0) return; // left-click only
          window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
      term.open(containerRef.current);
      fit.fit();

      // Ctrl/Cmd+F opens the search bar instead of going to the shell.
      term.attachCustomKeyEventHandler((e) => {
        if (
          e.type === "keydown" &&
          (e.ctrlKey || e.metaKey) &&
          !e.altKey &&
          e.key.toLowerCase() === "f"
        ) {
          openSearch();
          return false;
        }
        return true;
      });

      term.onData((data) => onDataRef.current(data));
      term.onResize(({ cols, rows }) => onResizeRef.current(cols, rows));
      search.onDidChangeResults(({ resultIndex, resultCount }) =>
        setResults({ index: resultIndex, count: resultCount }),
      );

      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;

      // Flush anything written while xterm was still loading, in order.
      const queued = pendingRef.current;
      pendingRef.current = [];
      for (const fn of queued) fn(term);

      // Refit when the container changes size.
      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* container detached mid-resize */
        }
      });
      resizeObserver.observe(containerRef.current);
      term.focus();
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, []);

  // Live-apply theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (term && theme) term.options.theme = theme;
  }, [theme]);

  return (
    <div
      className={className}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {searchOpen && (
        <div
          className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-term-border bg-term-panel/95 px-1.5 py-1 shadow-lg backdrop-blur"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              runSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(searchTerm, !e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find in terminal…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-40 bg-transparent px-1.5 py-0.5 font-mono text-xs text-term-text outline-none placeholder:text-term-faint"
          />
          <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-term-faint">
            {searchTerm
              ? results.count > 0
                ? `${results.index + 1}/${results.count}`
                : "0/0"
              : ""}
          </span>
          <button
            type="button"
            onClick={() => runSearch(searchTerm, false)}
            className="rounded px-1.5 py-0.5 text-xs text-term-muted hover:text-term-text"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => runSearch(searchTerm, true)}
            className="rounded px-1.5 py-0.5 text-xs text-term-muted hover:text-term-text"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="rounded px-1.5 py-0.5 text-xs text-term-muted hover:text-term-red"
            title="Close (Esc)"
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
});
