// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFileSort } from "@/components/ssh/hooks/useFileSort";

afterEach(() => {
  localStorage.clear();
});

describe("useFileSort", () => {
  it("defaults to name ascending", () => {
    const { result } = renderHook(() => useFileSort());
    expect(result.current[0]).toEqual({ key: "name", dir: "asc" });
  });

  it("switches to a new field at its natural default direction", () => {
    const { result } = renderHook(() => useFileSort());
    // size defaults to descending (largest first).
    act(() => result.current[1]("size"));
    expect(result.current[0]).toEqual({ key: "size", dir: "desc" });
    expect(localStorage.getItem("sshweb.fileSort")).toBe("size:desc");
  });

  it("flips direction when the same field is toggled again", () => {
    const { result } = renderHook(() => useFileSort());
    act(() => result.current[1]("size")); // switch to size → desc (default)
    expect(result.current[0]).toEqual({ key: "size", dir: "desc" });
    act(() => result.current[1]("size")); // same field flips to asc
    expect(result.current[0]).toEqual({ key: "size", dir: "asc" });
  });

  it("reads and parses an existing stored value on mount", () => {
    localStorage.setItem("sshweb.fileSort", "mtime:desc");
    const { result } = renderHook(() => useFileSort());
    expect(result.current[0]).toEqual({ key: "mtime", dir: "desc" });
  });

  it("falls back to the default for a malformed stored value", () => {
    localStorage.setItem("sshweb.fileSort", "bogus:sideways");
    const { result } = renderHook(() => useFileSort());
    expect(result.current[0]).toEqual({ key: "name", dir: "asc" });
  });
});
