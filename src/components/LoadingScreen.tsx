import { PromptLabel } from "@/components/PromptLabel";
import { TerminalBar } from "@/components/TerminalBar";
import { TerminalFooter } from "@/components/TerminalFooter";
import { TERMINAL_HOST, TERMINAL_USER } from "@/config/siteConfig";
import { cn } from "@/lib/utils";
import { CheckIcon } from "@/components/ssh/icons";

/**
 * Shared terminal-styled loading UI. Renders a fake shell session: the command
 * that is "running", an optional list of resolved steps, and a blinking cursor
 * on the line still in progress — keeping the terminal illusion instead of a
 * generic spinner.
 *
 * Server-renderable and used by the route-level `loading.tsx`. Callers can pass
 * their own copy for section-specific loading states.
 */
export function LoadingScreen({
  command = "loading",
  steps = [],
  fullScreen = true,
  className,
}: {
  /** The command shown after the prompt, e.g. "npm run build". */
  command?: string;
  /** Already-resolved lines shown above the in-progress cursor line. */
  steps?: string[];
  /**
   * Fill the viewport as a route-level `<main>` (default). Set `false` to embed
   * the loading state inside another layout (e.g. a component preview) — it then
   * renders a plain `<div>` that fills its container instead.
   */
  fullScreen?: boolean;
  className?: string;
}) {
  const card = (
    <div className="term-fade-up term-window w-full max-w-lg" role="status">
      <div className="term-window-bar">
        <span className="term-dot bg-term-red" aria-hidden />
        <span className="term-dot bg-term-yellow" aria-hidden />
        <span className="term-dot bg-term-green" aria-hidden />
        <span className="ml-2 truncate text-xs text-term-faint">
          {TERMINAL_USER}@{TERMINAL_HOST} — ~ — zsh
        </span>
      </div>

      <div className="px-5 py-4">
        <p className="text-sm text-term-muted">
          <PromptLabel /> <span className="term-type">{command}</span>
        </p>

        {steps.length > 0 && (
          <ul className="term-stagger mt-4 space-y-1 text-sm leading-7 text-term-muted">
            {steps.map((step) => (
              <li key={step} className="flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-term-green" />
                <span className="text-term-dim">{step}</span>
              </li>
            ))}
          </ul>
        )}

        <p
          className={cn("text-sm text-term-muted", steps.length > 0 && "mt-1")}
        >
          <span className="text-term-yellow">…</span> working
          <span className="term-cursor ml-1 align-middle" aria-hidden />
          <span className="sr-only">Loading, please wait.</span>
        </p>
      </div>
    </div>
  );

  // Embedded (e.g. a component preview): just the card filling its container.
  if (!fullScreen) {
    return (
      <div
        className={cn(
          "terminal-bg flex h-full flex-col items-center justify-center px-6 py-16",
          className,
        )}
        aria-busy="true"
      >
        {card}
      </div>
    );
  }

  // Route-level: frame the card with the page header + footer, like every
  // other full page.
  return (
    <main
      className={cn("terminal-bg flex min-h-screen flex-col", className)}
      aria-busy="true"
    >
      <TerminalBar branch="main" />
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        {card}
      </div>
      <TerminalFooter />
    </main>
  );
}
