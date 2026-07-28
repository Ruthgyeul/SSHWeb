"use client";

import "@xterm/xterm/css/xterm.css";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { Terminal as XTerminal } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import { THEME_COLOR } from "@/config/siteConfig";

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
}

/**
 * A thin React wrapper around xterm.js.
 *
 * xterm touches the DOM at import time, so it is loaded dynamically inside an
 * effect (never during SSR). The parent talks to it through the imperative
 * {@link XtermHandle} rather than props, which matches how a byte stream flows.
 *
 * `onData` fires for every keystroke/paste; `onResize` fires when the fit addon
 * changes the grid — both should be forwarded to the SSH server.
 */
export const XtermView = forwardRef<
  XtermHandle,
  {
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    className?: string;
  }
>(function XtermView({ onData, onResize, className }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  // xterm loads asynchronously (dynamic import). Any output that arrives before
  // it is ready would otherwise be silently dropped, so queue it and flush on
  // init — this is what keeps the connect banner and first shell bytes visible.
  const pendingRef = useRef<Array<(term: XTerminal) => void>>([]);

  // Keep the latest callbacks without re-running the setup effect.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;

  useImperativeHandle(
    ref,
    () => {
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
      };
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'var(--font-geist-mono), ui-monospace, "SFMono-Regular", Menlo, monospace',
        fontSize: 13,
        theme: {
          background: THEME_COLOR,
          foreground: "#e6e8ee",
          cursor: "#34d399",
          selectionBackground: "rgba(52, 211, 153, 0.3)",
        },
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
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

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
});
