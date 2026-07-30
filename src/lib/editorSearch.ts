/**
 * Pure text-search helpers for the inline file editor's find/replace bar
 * (`FileEditor.tsx`). Kept DOM-free so the match/replace logic is unit-tested
 * (see `editorSearch.test.ts`); the component layers caret/selection handling
 * on top of these.
 */

/** A single match: its `start` index and `end` (exclusive) in the source text. */
export interface Match {
  start: number;
  end: number;
}

/**
 * Find every (non-overlapping) occurrence of `query` in `text`. An empty query
 * yields no matches. Matching is literal (not a regex) and case-insensitive
 * unless `caseSensitive` is set.
 */
export function findMatches(
  text: string,
  query: string,
  caseSensitive = false,
): Match[] {
  if (query === "") return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

/**
 * Pick the index of the "next" match relative to a caret at `caretPos`, wrapping
 * around the ends. `dir` is `1` for forward (first match at or after the caret)
 * or `-1` for backward (last match before the caret). Returns `-1` when there
 * are no matches.
 */
export function nextMatchIndex(
  matches: Match[],
  caretPos: number,
  dir: 1 | -1,
): number {
  if (matches.length === 0) return -1;
  if (dir === 1) {
    const i = matches.findIndex((m) => m.start >= caretPos);
    return i === -1 ? 0 : i; // wrap to the first
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start < caretPos) return i;
  }
  return matches.length - 1; // wrap to the last
}

/**
 * Replace the single match at `[start, end)` with `replacement`, returning the
 * new text and the caret position just after the inserted text. Out-of-range
 * bounds leave the text untouched.
 */
export function replaceMatch(
  text: string,
  match: Match,
  replacement: string,
): { text: string; caret: number } {
  if (match.start < 0 || match.end > text.length || match.start > match.end) {
    return { text, caret: match.start };
  }
  const next = text.slice(0, match.start) + replacement + text.slice(match.end);
  return { text: next, caret: match.start + replacement.length };
}

/**
 * Replace every occurrence of `query` with `replacement`, returning the new text
 * and how many replacements were made. Uses {@link findMatches}, so replacement
 * text is inserted verbatim and never re-scanned (no runaway self-replacement).
 */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  caseSensitive = false,
): { text: string; count: number } {
  const matches = findMatches(text, query, caseSensitive);
  if (matches.length === 0) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacement;
    last = m.end;
  }
  out += text.slice(last);
  return { text: out, count: matches.length };
}
