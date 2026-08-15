"use client";

import { formatSize, type FindEntry, type GrepEntry } from "@/lib/sshProtocol";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { SearchIcon } from "./icons";
import type { SearchState } from "./FileBrowser";

/** Type guard: a content-search hit (carries a matching line + preview). */
function isGrepHit(entry: FindEntry | GrepEntry): entry is GrepEntry {
  return "preview" in entry;
}

interface SearchResultsProps {
  /** The active recursive search — query, axis, loading/result state, hits. */
  search: SearchState;
  /** The search root (current directory) shown in the empty-state hint. */
  cwd: string;
  /** Dismiss the search and return to the normal listing. */
  onClear: () => void;
  /** Open a hit by type, mirroring the listing's click-to-open behaviour. */
  onOpen: (entry: FindEntry | GrepEntry) => void;
  /** Render an absolute hit path relative to the search root for display. */
  relativePath: (path: string) => string;
}

/** The recursive-search results panel that replaces the file listing while a
 * search is active: a header with the query/result count + Clear, then the
 * spinner, empty state, or a list of hits (content hits show line + preview). */
export function SearchResults({
  search,
  cwd,
  onClear,
  onOpen,
  relativePath,
}: SearchResultsProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-term-border bg-term-panel/40 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate text-term-muted">
          {search.loading
            ? `Searching ${
                search.mode === "content" ? "file contents" : "names"
              } for “${search.query}”…`
            : `${search.results.length}${search.truncated ? "+" : ""} result${
                search.results.length === 1 ? "" : "s"
              } for “${search.query}”${
                search.mode === "content" ? " in file contents" : ""
              }`}
        </span>
        {search.truncated && !search.loading && (
          <span className="flex-none text-term-faint">
            (first {search.results.length})
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="ml-auto flex-none rounded px-2 py-0.5 text-term-muted hover:text-term-text"
        >
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {search.loading ? (
          <div className="flex items-center justify-center py-12">
            <span
              className="h-7 w-7 animate-spin rounded-full border-2 border-term-border border-t-term-accent"
              role="status"
              aria-label="Searching"
            />
          </div>
        ) : search.results.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-term-muted">
            <SearchIcon className="h-8 w-8 opacity-60" />
            <p className="text-sm">
              {search.mode === "content"
                ? `No file contents matched “${search.query}”`
                : `No matches for “${search.query}”`}
            </p>
            <p className="text-xs text-term-faint">
              Searched {cwd} and its subfolders.
            </p>
          </div>
        ) : (
          <ul>
            {search.results.map((r) => {
              const grep = isGrepHit(r);
              return (
                <li key={r.path}>
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    title={r.path}
                    className="flex w-full flex-col gap-0.5 border-b border-term-border/50 px-3 py-1.5 text-left text-sm hover:bg-term-panel/60"
                  >
                    <span className="flex w-full items-center gap-2">
                      <FileIcon entry={r} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          r.type === "dir"
                            ? "text-term-accent"
                            : "text-term-dim",
                        )}
                      >
                        {relativePath(r.path)}
                      </span>
                      <span className="flex-none font-mono text-xs text-term-faint">
                        {formatSize(r.size, r.type)}
                      </span>
                    </span>
                    {grep && (
                      <span className="flex min-w-0 items-baseline gap-2 pl-6 font-mono text-xs text-term-faint">
                        <span className="flex-none text-term-accent/70">
                          :{r.line}
                        </span>
                        <span className="min-w-0 truncate">{r.preview}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
