// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTextFind } from "@/components/ssh/hooks/useTextFind";

const TEXT = "alpha beta\nAlpha gamma\nbeta ALPHA";

describe("useTextFind", () => {
  it("starts closed with no query and no matches", () => {
    const { result } = renderHook(() => useTextFind(TEXT, true));
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe("");
    expect(result.current.matches).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.searchHtml).toBe("");
  });

  it("finds matches only once open with a query", () => {
    const { result } = renderHook(() => useTextFind(TEXT, true));
    act(() => result.current.setQuery("alpha"));
    // Query set but bar still closed → no search yet.
    expect(result.current.matches).toEqual([]);
    expect(result.current.searching).toBe(false);
    act(() => result.current.setOpen(true));
    expect(result.current.searching).toBe(true);
    // Case-insensitive by default → all three "alpha" spellings match.
    expect(result.current.matches.length).toBe(3);
    expect(result.current.searchHtml).not.toBe("");
  });

  it("honours the case-sensitivity toggle", () => {
    const { result } = renderHook(() => useTextFind(TEXT, true));
    act(() => {
      result.current.setOpen(true);
      result.current.setQuery("alpha");
    });
    expect(result.current.matches.length).toBe(3);
    act(() => result.current.toggleCase());
    expect(result.current.matchCase).toBe(true);
    // Only the exact-case "alpha" (line 1) survives.
    expect(result.current.matches.length).toBe(1);
  });

  it("steps the active match forward and backward, wrapping", () => {
    const { result } = renderHook(() => useTextFind(TEXT, true));
    act(() => {
      result.current.setOpen(true);
      result.current.setQuery("alpha");
    });
    expect(result.current.activeIdx).toBe(0);
    act(() => result.current.step(1));
    expect(result.current.activeIdx).toBe(1);
    act(() => result.current.step(1));
    expect(result.current.activeIdx).toBe(2);
    // Wrap forward past the end.
    act(() => result.current.step(1));
    expect(result.current.activeIdx).toBe(0);
    // Wrap backward before the start.
    act(() => result.current.step(-1));
    expect(result.current.activeIdx).toBe(2);
  });

  it("resets the active match to the first when the query changes", () => {
    const { result } = renderHook(() => useTextFind(TEXT, true));
    act(() => {
      result.current.setOpen(true);
      result.current.setQuery("alpha");
    });
    // Step in its own act so the match set from the query has committed first.
    act(() => result.current.step(1));
    expect(result.current.activeIdx).toBe(1);
    act(() => result.current.setQuery("beta"));
    expect(result.current.activeIdx).toBe(0);
  });

  it("does nothing when disabled (non-text kinds)", () => {
    const { result } = renderHook(() => useTextFind(TEXT, false));
    act(() => {
      result.current.setOpen(true);
      result.current.setQuery("alpha");
    });
    expect(result.current.searching).toBe(false);
    expect(result.current.matches).toEqual([]);
    expect(result.current.searchHtml).toBe("");
  });
});
