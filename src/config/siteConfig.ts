/**
 * Centralized site configuration, sourced from environment variables.
 *
 * Every piece of site identity — name, URL, description, prompt text — lives
 * here and is read from `NEXT_PUBLIC_*` env vars with a sensible default.
 * Deploying SSHWeb under your own domain/branding means editing `.env.local`
 * (see `.env.example`), NOT hunting through layout.tsx, robots.ts, sitemap.ts
 * and manifest generation.
 *
 * The only deployment-specific default is `SITE_URL`, which falls back to
 * `http://localhost:3000` (the server's default port) — set
 * `NEXT_PUBLIC_SITE_URL` to your real origin so canonical URLs, the sitemap and
 * social-card images resolve correctly.
 */

/**
 * Ensures a scheme is present and strips any trailing slash, so downstream
 * string concatenation (e.g. `${SITE_URL}/sitemap.xml`) never produces a double
 * slash and `new URL(SITE_URL)` never throws.
 */
function normalizeSiteUrl(url: string): string {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return withScheme.replace(/\/+$/, "");
}

/** Read a public env var, falling back to a default when unset or empty. */
function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() !== "" ? value : fallback;
}

export const SITE_URL = normalizeSiteUrl(
  env("NEXT_PUBLIC_SITE_URL", "http://localhost:3000"),
);
export const SITE_NAME = env("NEXT_PUBLIC_SITE_NAME", "SSHWeb");
export const SITE_SHORT_NAME = env("NEXT_PUBLIC_SITE_SHORT_NAME", "SSHWeb");
export const SITE_DESCRIPTION = env(
  "NEXT_PUBLIC_SITE_DESCRIPTION",
  "Connect to any SSH server from your browser — an interactive terminal and SFTP file access.",
);
export const AUTHOR_NAME = env("NEXT_PUBLIC_AUTHOR_NAME", "SSHWeb");
export const AUTHOR_URL = env("NEXT_PUBLIC_AUTHOR_URL", SITE_URL);

/**
 * Open Graph / `<html lang>` locale, e.g. "en_US" / "ko_KR". This is metadata
 * only — it sets the document language and OG locale for SEO/social cards; it
 * does NOT translate the UI, which is English-only.
 */
export const SITE_LOCALE = env("NEXT_PUBLIC_SITE_LOCALE", "en_US");

/** `<html lang>` value derived from the OG locale ("en_US" -> "en-US"). */
export const SITE_LANG = SITE_LOCALE.replace("_", "-");

/** Cosmetic shell prompt shown in the terminal chrome, e.g. `user@sshweb`. */
export const TERMINAL_USER = env("NEXT_PUBLIC_TERMINAL_USER", "user");
export const TERMINAL_HOST = env("NEXT_PUBLIC_TERMINAL_HOST", "sshweb");

/**
 * Whether search engines may index the site. Disable on staging/preview deploys
 * by setting NEXT_PUBLIC_ALLOW_INDEXING=false. Read by src/app/robots.ts.
 */
export const ALLOW_INDEXING =
  env("NEXT_PUBLIC_ALLOW_INDEXING", "true").toLowerCase() !== "false";

/** Brand colors surfaced to metadata (`themeColor`, manifest). */
export const THEME_COLOR = "#0a0d13";

/* --- Web SSH client -------------------------------------------------------
 * The path the browser opens its SSH WebSocket on. Must match the `WS_PATH`
 * read by `server.mjs` (they default to the same value). The actual SSH host
 * allowlist and session limits are SERVER-only settings (`SSH_ALLOWED_HOSTS`,
 * `SSH_MAX_SESSIONS`) enforced in `server.mjs`; the optional public mirror
 * below is used only to fail fast with a friendly message in the UI.
 */
export const SSH_WS_PATH = env("NEXT_PUBLIC_SSH_WS_PATH", "/api/ssh");
export const SSH_ALLOWED_HOSTS = env("NEXT_PUBLIC_SSH_ALLOWED_HOSTS", "");
