import type { ReactNode } from "react";
import { PromptLabel } from "@/components/PromptLabel";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalFooter } from "@/components/TerminalFooter";
import { TERMINAL_HOST, TERMINAL_USER } from "@/config/siteConfig";

interface DetailRow {
  key: string;
  value: string;
  /** Tailwind text-color class for the value, e.g. "text-term-red". */
  valueClassName?: string;
}

/**
 * Shared terminal-styled error page, used by both the 404 (not-found) and 500
 * (error boundary) routes. Renders a fake shell session: the command that
 * "failed", a big status code, a human message, and a details block.
 *
 * Server-renderable — the client 404/500 wrappers pass their own copy in.
 */
export function ErrorScreen({
  command,
  code,
  codeClassName,
  message,
  details,
}: {
  command: ReactNode;
  code: string;
  /** Tailwind text-color class for the big status code. */
  codeClassName: string;
  message: string;
  details: DetailRow[];
}) {
  return (
    <main className="terminal-bg flex min-h-screen flex-col">
      <TerminalBar branch="main" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="term-fade-up term-window w-full max-w-lg">
          <div className="term-window-bar">
            <span className="term-dot bg-term-red" aria-hidden />
            <span className="term-dot bg-term-yellow" aria-hidden />
            <span className="term-dot bg-term-green" aria-hidden />
            <span className="ml-2 truncate text-xs text-term-faint">
              {TERMINAL_USER}@{TERMINAL_HOST} — ~ — zsh
            </span>
          </div>

          <div className="px-5 py-5">
            <p className="text-sm text-term-muted">
              <PromptLabel /> {command}
              <span className="term-cursor ml-1 align-middle" aria-hidden />
            </p>

            <p
              className={`mt-5 text-6xl font-bold leading-none ${codeClassName}`}
            >
              {code}
            </p>
            <p className="mb-5 mt-3 text-term-dim">{message}</p>

            <dl className="rounded-lg border border-term-border bg-term-panel px-5 py-4 text-sm leading-7 text-term-muted">
              {details.map((row) => (
                <div key={row.key}>
                  <span className="text-term-pink">{row.key}</span>
                  <span className="text-term-faint">: </span>
                  <span className={row.valueClassName ?? "text-term-lime"}>
                    {row.value}
                  </span>
                </div>
              ))}
            </dl>

            {/* Plain anchor on purpose: a full reload cleanly resets any error state. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="term-btn mt-6 inline-block rounded-md px-4 py-2.5 text-sm"
            >
              <span className="text-term-green">$</span> cd ~
            </a>
          </div>
        </div>
      </div>
      <TerminalFooter />
    </main>
  );
}
