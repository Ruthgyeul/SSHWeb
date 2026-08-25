"use client";

import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import { TERMINAL_THEME, type TerminalTheme } from "@/lib/terminalTheme";

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
}

/**
 * A thin React wrapper around xterm.js.
 *
 * xterm touches the DOM at import time, so it is loaded dynamically inside an
 * effect (never during SSR). The parent talks to it through the imperative
 * {@link XtermHandle} rather than props, which matches how a byte stream flows.
 *
 * `onData` fires for every keystroke/paste; `onResize` fires when the fit addon
 * changes the grid — both should be forwarded to the SSH server. `theme` is
 * live-applied whenever it changes.
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
  // xterm loads asynchronously (dynamic import). Any output that arrives before
  // it is ready would otherwise be silently dropped, so queue it and flush on
  // init — this is what keeps the connect banner and first shell bytes visible.
  const pendingRef = useRef<Array<(term: XTerminal) => void>>([]);

  // Keep the latest callbacks/props without re-running the setup effect.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  const themeRef = useRef<TerminalTheme>(theme ?? TERMINAL_THEME);
  themeRef.current = theme ?? TERMINAL_THEME;

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
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
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
      term.loadAddon(fit);
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

      term.onData((data) => onDataRef.current(data));
      term.onResize(({ cols, rows }) => onResizeRef.current(cols, rows));

      termRef.current = term;
      fitRef.current = fit;

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
    </div>
  );
});
