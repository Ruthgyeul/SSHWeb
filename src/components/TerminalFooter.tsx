import { AUTHOR_NAME, SITE_DESCRIPTION, SITE_NAME } from "@/config/siteConfig";

// Computed once at module load (not per-render) so this stays a pure component.
const YEAR = new Date().getFullYear();

/**
 * A slim, sticky bottom status bar — the page-wide counterpart to
 * {@link TerminalBar}. Frames the app shell (connect / access / session) with a
 * shell-style status line instead of leaving the viewport edge bare.
 *
 * Server component. Identity comes from env-driven siteConfig.
 */
export function TerminalFooter() {
  return (
    <footer className="sticky bottom-0 z-20 flex h-9 items-center gap-2 border-t border-term-border bg-term-panel/90 px-4 text-xs text-term-faint backdrop-blur">
      <span className="text-term-green" aria-hidden>
        $
      </span>
      <span className="min-w-0 truncate">
        {SITE_NAME}
        <span className="text-term-fainter"> — </span>
        {SITE_DESCRIPTION}
      </span>
      <span className="ml-auto flex-none whitespace-nowrap text-term-fainter">
        © {YEAR} {AUTHOR_NAME}
      </span>
    </footer>
  );
}
