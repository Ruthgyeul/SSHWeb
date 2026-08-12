import { describe, expect, it } from "vitest";
import {
  findMatches,
  nextMatchIndex,
  replaceAll,
  replaceMatch,
  escapeHtml,
  buildSearchHtml,
} from "@/lib/editorSearch";

describe("findMatches", () => {
  it("finds all non-overlapping, case-insensitive matches by default", () => {
    expect(findMatches("aXaXa", "x")).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("does not overlap (e.g. 'aa' in 'aaaa')", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("honors case sensitivity", () => {
    expect(findMatches("Foo foo", "foo", true)).toEqual([{ start: 4, end: 7 }]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });
});

describe("nextMatchIndex", () => {
  const matches = [
    { start: 2, end: 3 },
    { start: 8, end: 9 },
    { start: 14, end: 15 },
  ];

  it("finds the first match at or after the caret going forward", () => {
    expect(nextMatchIndex(matches, 0, 1)).toBe(0);
    expect(nextMatchIndex(matches, 3, 1)).toBe(1);
    expect(nextMatchIndex(matches, 8, 1)).toBe(1);
  });

  it("wraps forward past the last match", () => {
    expect(nextMatchIndex(matches, 20, 1)).toBe(0);
  });

  it("finds the last match before the caret going backward", () => {
    expect(nextMatchIndex(matches, 14, -1)).toBe(1);
    expect(nextMatchIndex(matches, 9, -1)).toBe(1);
  });

  it("wraps backward before the first match", () => {
    expect(nextMatchIndex(matches, 0, -1)).toBe(2);
  });

  it("returns -1 with no matches", () => {
    expect(nextMatchIndex([], 0, 1)).toBe(-1);
  });
});

describe("replaceMatch", () => {
  it("replaces a single span and reports the caret after it", () => {
    expect(replaceMatch("hello world", { start: 6, end: 11 }, "there")).toEqual({
      text: "hello there",
      caret: 11,
    });
  });

  it("leaves the text untouched for out-of-range bounds", () => {
    expect(replaceMatch("abc", { start: 1, end: 99 }, "x")).toEqual({
      text: "abc",
      caret: 1,
    });
  });
});

describe("replaceAll", () => {
  it("replaces every occurrence and counts them", () => {
    expect(replaceAll("a.b.c", ".", "-")).toEqual({ text: "a-b-c", count: 2 });
  });

  it("inserts replacement verbatim without re-scanning it", () => {
    // Replacing "a" with "aa" must not loop forever or double-count.
    expect(replaceAll("aa", "a", "aa")).toEqual({ text: "aaaa", count: 2 });
  });

  it("is a no-op when nothing matches", () => {
    expect(replaceAll("abc", "z", "y")).toEqual({ text: "abc", count: 0 });
  });

  it("honors case sensitivity", () => {
    expect(replaceAll("Aa", "a", "x", true)).toEqual({ text: "Ax", count: 1 });
  });
});

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters &, <, >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("escapes & before < and > so entities aren't double-escaped", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("buildSearchHtml", () => {
  it("returns fully escaped text when there are no matches", () => {
    expect(buildSearchHtml("a<b>c", [], 0)).toBe("a&lt;b&gt;c");
  });

  it("wraps each match in a <mark>, tagging only the active one", () => {
    // "abab", query "ab" → matches at [0,2) and [2,4); active = index 1.
    const html = buildSearchHtml("abab", [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ], 1);
    const marks = html.match(/<mark/g) ?? [];
    expect(marks).toHaveLength(2);
    expect(html.match(/data-active="true"/g) ?? []).toHaveLength(1);
    // The active mark carries the highlighted (bg-term-accent) class.
    expect(html).toContain('class="bg-term-accent text-term-bg" data-active="true"');
    expect(html).toContain('class="bg-term-accent/30 text-term-text"');
  });

  it("escapes text inside and around matches", () => {
    // Match the "<" so the marked slice itself needs escaping.
    const html = buildSearchHtml("x<y", [{ start: 1, end: 2 }], 0);
    expect(html).toBe(
      'x<mark class="bg-term-accent text-term-bg" data-active="true">&lt;</mark>y',
    );
  });
});
