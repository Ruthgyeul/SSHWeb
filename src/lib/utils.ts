/**
 * Join conditional class names into a single string.
 *
 * A tiny, dependency-free `clsx`: accepts strings, and skips anything falsy
 * (`false`, `null`, `undefined`, `""`) so you can write
 * `cn("base", active && "is-active")` without leaking "false" into the DOM.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(" ");
}

/**
 * Serialize a value for safe embedding inside an inline
 * `<script type="application/ld+json">` via `dangerouslySetInnerHTML`.
 *
 * `JSON.stringify` alone is NOT safe here: it does not escape `<`, so a value
 * containing `</script>` (or `<!--`) breaks out of the script element and
 * enables XSS. In this template the values are env-driven and build-time, but a
 * template is copied into many forks — some of which will feed it less-trusted
 * data — so we escape the HTML-significant characters (and the U+2028/U+2029
 * line separators that are invalid in some JS string contexts) at the source.
 */
const JSON_LD_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function toJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => JSON_LD_ESCAPES[ch] ?? ch,
  );
}
