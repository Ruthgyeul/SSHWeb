// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchResults } from "@/components/ssh/SearchResults";
import type { SearchState } from "@/components/ssh/FileBrowser";
import type { FindEntry, GrepEntry } from "@/lib/sshProtocol";

const base = {
  cwd: "/home/me",
  onClear: () => {},
  onOpen: () => {},
  // Display an absolute hit path relative to the search root.
  relativePath: (p: string) =>
    p.startsWith("/home/me/") ? p.slice("/home/me/".length) : p,
};

const nameHit: FindEntry = {
  name: "notes.txt",
  type: "file",
  size: 42,
  mtime: 0,
  mode: 0o644,
  path: "/home/me/docs/notes.txt",
};

const grepHit: GrepEntry = {
  name: "app.ts",
  type: "file",
  size: 100,
  mtime: 0,
  mode: 0o644,
  path: "/home/me/src/app.ts",
  line: 12,
  preview: "const answer = 42;",
};

function state(over: Partial<SearchState>): SearchState {
  return {
    query: "answer",
    mode: "name",
    loading: false,
    results: [],
    truncated: false,
    ...over,
  };
}

describe("SearchResults", () => {
  it("shows a spinner while loading", () => {
    render(<SearchResults {...base} search={state({ loading: true })} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/Searching names/)).toBeInTheDocument();
  });

  it("shows an empty state with the search root when there are no hits", () => {
    render(<SearchResults {...base} search={state({ results: [] })} />);
    expect(screen.getByText(/No matches for/)).toBeInTheDocument();
    expect(screen.getByText(/Searched \/home\/me/)).toBeInTheDocument();
  });

  it("renders name hits relative to the search root", () => {
    render(<SearchResults {...base} search={state({ results: [nameHit] })} />);
    expect(screen.getByText("docs/notes.txt")).toBeInTheDocument();
    // A name hit shows no line/preview row.
    expect(screen.queryByText(/const answer/)).not.toBeInTheDocument();
  });

  it("renders a content hit's line number and preview", () => {
    render(
      <SearchResults
        {...base}
        search={state({ mode: "content", results: [grepHit] })}
      />,
    );
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText(":12")).toBeInTheDocument();
    expect(screen.getByText("const answer = 42;")).toBeInTheDocument();
  });

  it("counts results and marks truncation", () => {
    render(
      <SearchResults
        {...base}
        search={state({ results: [nameHit], truncated: true })}
      />,
    );
    expect(screen.getByText(/1\+ result/)).toBeInTheDocument();
    expect(screen.getByText(/\(first 1\)/)).toBeInTheDocument();
  });

  it("calls onOpen with the clicked hit and onClear from the button", () => {
    const onOpen = vi.fn();
    const onClear = vi.fn();
    render(
      <SearchResults
        {...base}
        onOpen={onOpen}
        onClear={onClear}
        search={state({ results: [nameHit] })}
      />,
    );
    fireEvent.click(screen.getByText("docs/notes.txt"));
    expect(onOpen).toHaveBeenCalledWith(nameHit);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
