// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSnippets } from "@/components/ssh/hooks/useSnippets";

afterEach(() => {
  localStorage.clear();
});

describe("useSnippets", () => {
  it("starts empty and persists an added snippet", () => {
    const { result } = renderHook(() => useSnippets());
    expect(result.current.snippets).toEqual([]);

    act(() => result.current.add("List", "ls -la"));
    expect(result.current.snippets).toHaveLength(1);
    expect(result.current.snippets[0]).toMatchObject({
      label: "List",
      command: "ls -la",
    });
    expect(localStorage.getItem("sshweb.snippets")).toContain("ls -la");
  });

  it("ignores a blank command and trims the stored command", () => {
    const { result } = renderHook(() => useSnippets());
    act(() => result.current.add("empty", "   "));
    expect(result.current.snippets).toEqual([]);
    act(() => result.current.add("", "  echo hi  "));
    expect(result.current.snippets[0].command).toBe("echo hi");
    // A missing label defaults to the command text.
    expect(result.current.snippets[0].label).toBe("echo hi");
  });

  it("removes a snippet by id", () => {
    const { result } = renderHook(() => useSnippets());
    act(() => result.current.add("a", "cmd-a"));
    const id = result.current.snippets[0].id;
    act(() => result.current.remove(id));
    expect(result.current.snippets).toEqual([]);
  });

  it("reads existing snippets on mount and ignores malformed storage", () => {
    localStorage.setItem(
      "sshweb.snippets",
      JSON.stringify([{ id: "x", label: "L", command: "c" }]),
    );
    const { result } = renderHook(() => useSnippets());
    expect(result.current.snippets).toEqual([
      { id: "x", label: "L", command: "c" },
    ]);
  });

  it("returns an empty list for malformed storage", () => {
    localStorage.setItem("sshweb.snippets", "not json");
    const { result } = renderHook(() => useSnippets());
    expect(result.current.snippets).toEqual([]);
  });
});
