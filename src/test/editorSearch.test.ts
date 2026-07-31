import { describe, expect, it } from "vitest";
import {
  findMatches,
  nextMatchIndex,
  replaceAll,
  replaceMatch,
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
