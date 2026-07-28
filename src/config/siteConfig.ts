/**
 * Centralized site configuration, sourced from environment variables.
 *
 * Every piece of site identity — name, URL, description, author, prompt text —
 * lives here and is read from `NEXT_PUBLIC_*` env vars with a safe placeholder
 * default. Forking this template to build a real site should mean editing
 * `.env.local` (see `.env.example`), NOT hunting through layout.tsx, robots.ts,
 * sitemap.ts and manifest generation.
 *
 * Defaults use `example.com` / "Example Author" on purpose so an un-configured
 * clone still builds and renders, and so nobody's real identity is baked into
 * the template.
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
  env("NEXT_PUBLIC_SITE_URL", "https://example.com"),
);
export const SITE_NAME = env("NEXT_PUBLIC_SITE_NAME", "Terminal Web Template");
export const SITE_SHORT_NAME = env("NEXT_PUBLIC_SITE_SHORT_NAME", "TermWeb");
export const SITE_DESCRIPTION = env(
  "NEXT_PUBLIC_SITE_DESCRIPTION",
  "A terminal-styled website built with Next.js.",
);
export const AUTHOR_NAME = env("NEXT_PUBLIC_AUTHOR_NAME", "Example Author");
export const AUTHOR_URL = env("NEXT_PUBLIC_AUTHOR_URL", SITE_URL);

/** Open Graph locale, e.g. "en_US" / "ko_KR". */
export const SITE_LOCALE = env("NEXT_PUBLIC_SITE_LOCALE", "en_US");

/** `<html lang>` value derived from the OG locale ("en_US" -> "en-US"). */
export const SITE_LANG = SITE_LOCALE.replace("_", "-");

/** Cosmetic shell prompt shown in the terminal chrome, e.g. `guest@example`. */
export const TERMINAL_USER = env("NEXT_PUBLIC_TERMINAL_USER", "guest");
export const TERMINAL_HOST = env("NEXT_PUBLIC_TERMINAL_HOST", "example");

/**
 * Whether search engines may index the site. Disable on staging/preview deploys
 * by setting NEXT_PUBLIC_ALLOW_INDEXING=false. Read by src/app/robots.ts.
 */
export const ALLOW_INDEXING =
  env("NEXT_PUBLIC_ALLOW_INDEXING", "true").toLowerCase() !== "false";

/** Optional external links. Empty string means "not configured — hide it". */
export const GITHUB_URL = env("NEXT_PUBLIC_GITHUB_URL", "https://github.com/example");
export const CONTACT_EMAIL = env("NEXT_PUBLIC_CONTACT_EMAIL", "hello@example.com");

/** Brand colors surfaced to metadata (`themeColor`, manifest). */
export const THEME_COLOR = "#0a0d13";
