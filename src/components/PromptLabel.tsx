import { TERMINAL_HOST, TERMINAL_USER } from "@/config/siteConfig";

/**
 * The `user@host:~$` shell label — the single source of truth for the prompt
 * prefix shared by `Prompt`, `Terminal`, `ErrorScreen` and the loading screen.
 * The user/host come from env-driven siteConfig, never a hardcoded identity.
 *
 * Renders inline (a fragment of two spans) so callers control the surrounding
 * element; pass `path` to change the working directory shown before `$`.
 */
export function PromptLabel({ path = "~" }: { path?: string }) {
  return (
    <>
      <span className="text-term-green">
        {TERMINAL_USER}@{TERMINAL_HOST}
      </span>
      <span className="text-term-faint">
        :{path}$
      </span>
    </>
  );
}
