import { useCallback, useMemo, useState } from "react";

import { findMatches, buildSearchHtml, type Match } from "@/lib/editorSearch";

/**
 * The text-preview find-bar state machine, extracted from `FilePreview`.
 *
 * Owns the open/query/case/active-index state and derives the match set, the
 * clamped active index, and the marked-up search HTML from the current text.
 * `enabled` gates the whole thing (only the `text` preview kind searches), so
 * the derived work is skipped for every other kind. The find/replace matching
 * itself lives in `src/lib/editorSearch.ts` (unit-tested); this hook is the
 * thin stateful shell around it, covered via `renderHook`.
 */
export interface TextFind {
  /** Whether the find bar is shown. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Current search query. */
  query: string;
  /** Set the query (resets the active match to the first). */
  setQuery: (query: string) => void;
  /** Whether matching is case-sensitive. */
  matchCase: boolean;
  toggleCase: () => void;
  /** All matches for the current query (empty unless open with a query). */
  matches: Match[];
  /** Active match index, clamped to the current match set. */
  activeIdx: number;
  /** Escaped text with matches marked (active one flagged) for the text pane. */
  searchHtml: string;
  /** True when the bar is open with a query — the search render is active. */
  searching: boolean;
  /** Step to the next (1) / previous (-1) match, wrapping at the ends. */
  step: (dir: 1 | -1) => void;
}

export function useTextFind(text: string, enabled: boolean): TextFind {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [active, setActive] = useState(0);

  const searching = enabled && open && !!query;
  // Matches for the find bar (only while it's open with a query).
  const matches = useMemo<Match[]>(
    () => (searching ? findMatches(text, query, matchCase) : []),
    [searching, text, query, matchCase],
  );
  // Clamp the active index whenever the match set changes.
  const activeIdx = matches.length ? active % matches.length : 0;
  // Escaped text with matches marked, used in place of syntax highlighting while
  // searching so the highlight can be layered on and stepped through.
  const searchHtml = useMemo(
    () => (searching ? buildSearchHtml(text, matches, activeIdx) : ""),
    [searching, text, matches, activeIdx],
  );

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setActive(0);
  }, []);
  const toggleCase = useCallback(() => setMatchCase((c) => !c), []);
  const step = useCallback(
    (dir: 1 | -1) => {
      setActive((a) => {
        const n = matches.length;
        if (n === 0) return 0;
        return (a + dir + n) % n;
      });
    },
    [matches.length],
  );

  return {
    open,
    setOpen,
    query,
    setQuery,
    matchCase,
    toggleCase,
    matches,
    activeIdx,
    searchHtml,
    searching,
    step,
  };
}
