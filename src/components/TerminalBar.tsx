import { TERMINAL_HOST, TERMINAL_USER } from "@/config/siteConfig";

/**
 * A slim, sticky top bar with terminal window chrome and a shell label.
 * Use it as a page-wide header. `branch` optionally renders a git-branch chip
 * on the right (handy for "you are here" context).
 *
 * Server component. The user/host label comes from env-driven siteConfig.
 */
export function TerminalBar({ branch }: { branch?: string }) {
  return (
    <div className="sticky top-0 z-20 flex h-10 items-center gap-2 border-b border-term-border bg-term-panel/90 px-4 backdrop-blur">
      <span className="term-dot bg-term-red" aria-hidden />
      <span className="term-dot bg-term-yellow" aria-hidden />
      <span className="term-dot bg-term-green" aria-hidden />
      <span className="ml-2 min-w-0 flex-1 truncate text-xs text-term-faint">
        {TERMINAL_USER}@{TERMINAL_HOST}
        <span className="text-term-fainter"> — </span>~/.ssh
        <span className="text-term-fainter"> — </span>zsh
      </span>
      {branch && (
        <span className="ml-auto flex flex-none items-center gap-1.5 text-xs text-term-faint">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="6" cy="6" r="2.2" />
            <circle cx="6" cy="18" r="2.2" />
            <circle cx="18" cy="12" r="2.2" />
            <path d="M6 8.2v7.6M6 6h6a4 4 0 014 4" />
          </svg>
          {branch}
        </span>
      )}
    </div>
  );
}
