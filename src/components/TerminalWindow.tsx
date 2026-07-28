import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A framed "terminal window": rounded card with macOS-style traffic-light
 * chrome and a title showing a shell path. The building block most pages in
 * this template compose from.
 *
 * Server component — no client JS. Pass `title` to override the default shell
 * path shown in the title bar.
 */
export function TerminalWindow({
  title = "~",
  children,
  className,
  contentClassName,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn(
        "card overflow-hidden rounded-xl border border-term-border bg-term-card",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-term-border bg-term-panel/90 px-4 py-2.5 backdrop-blur">
        <span className="term-dot bg-term-red" aria-hidden />
        <span className="term-dot bg-term-yellow" aria-hidden />
        <span className="term-dot bg-term-green" aria-hidden />
        <span className="ml-2 truncate text-xs text-term-faint">{title}</span>
      </header>
      <div className={cn("p-5 sm:p-6", contentClassName)}>{children}</div>
    </section>
  );
}
