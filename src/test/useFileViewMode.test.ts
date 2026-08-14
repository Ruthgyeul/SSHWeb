// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFileViewMode } from "@/components/ssh/hooks/useFileViewMode";

afterEach(() => {
  localStorage.clear();
});

describe("useFileViewMode", () => {
  it("defaults to list layout", () => {
    const { result } = renderHook(() => useFileViewMode());
    expect(result.current[0]).toBe("list");
  });

  it("persists a change and reflects it immediately", () => {
    const { result } = renderHook(() => useFileViewMode());
    act(() => result.current[1]("grid"));
    expect(result.current[0]).toBe("grid");
    expect(localStorage.getItem("sshweb.fileViewMode")).toBe("grid");
  });

  it("reads an existing stored preference on mount", () => {
    localStorage.setItem("sshweb.fileViewMode", "grid");
    const { result } = renderHook(() => useFileViewMode());
    expect(result.current[0]).toBe("grid");
  });

  it("falls back to list for an unrecognized stored value", () => {
    localStorage.setItem("sshweb.fileViewMode", "mosaic");
    const { result } = renderHook(() => useFileViewMode());
    expect(result.current[0]).toBe("list");
  });
});
