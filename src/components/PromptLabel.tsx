import { TERMINAL_HOST, TERMINAL_USER } from "@/config/siteConfig";

/**
 * The `user@host:~$` shell label — the single source of truth for the prompt
 * prefix shared by `Prompt`, `Terminal`, `ErrorScreen` and the loading screen.
 * The user/host come from env-driven siteConfig, never a hardcoded identity.
 *
 * Renders inline (a fragment of two spans) so callers control the surrounding
 * element; pass `path` to change the working directory shown before `$`. Set
 * `showCursor` to append a blinking terminal cursor after the prompt for a
 * live-prompt feel (e.g. an idle shell awaiting input).
 */
export function PromptLabel({
  path = "~",
  showCursor = false,
}: {
  path?: string;
  showCursor?: boolean;
}) {
  return (
    <>
      <span className="text-term-green">
        {TERMINAL_USER}@{TERMINAL_HOST}
      </span>
      <span className="text-term-faint">:{path}$</span>
      {showCursor && (
        <span className="term-cursor ml-1 align-middle" aria-hidden />
      )}
    </>
  );
}
