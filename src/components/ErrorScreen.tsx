import type { ReactNode } from "react";
import { PromptLabel } from "@/components/PromptLabel";

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
    <main className="terminal-bg flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-lg">
        <p className="text-sm text-term-muted">
          <PromptLabel /> {command}
        </p>

        <p className={`mt-5 text-6xl font-bold leading-none ${codeClassName}`}>
          {code}
        </p>
        <p className="mb-5 mt-3 text-term-dim">{message}</p>

        <dl className="rounded-lg border border-term-border bg-term-card px-5 py-4 text-sm leading-7 text-term-muted">
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
          className="mt-6 inline-block rounded-md border border-term-border bg-term-panel px-4 py-2.5 text-sm text-term-text hover:border-term-accent hover:text-term-accent"
        >
          ← Back to home
        </a>
      </div>
    </main>
  );
}
