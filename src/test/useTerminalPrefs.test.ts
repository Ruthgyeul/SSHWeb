// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTerminalPrefs } from "@/components/ssh/hooks/useTerminalPrefs";
import { DEFAULT_THEME_ID } from "@/lib/terminalTheme";

afterEach(() => {
  localStorage.clear();
});

describe("useTerminalPrefs", () => {
  it("defaults to the default theme", () => {
    const { result } = renderHook(() => useTerminalPrefs());
    expect(result.current[0].themeId).toBe(DEFAULT_THEME_ID);
  });

  it("persists a valid theme change", () => {
    const { result } = renderHook(() => useTerminalPrefs());
    act(() => result.current[1]({ themeId: "dracula" }));
    expect(result.current[0].themeId).toBe("dracula");
    expect(localStorage.getItem("sshweb.terminalPrefs")).toContain("dracula");
  });

  it("falls back to the default theme for an unknown id", () => {
    const { result } = renderHook(() => useTerminalPrefs());
    act(() => result.current[1]({ themeId: "no-such-theme" }));
    expect(result.current[0].themeId).toBe(DEFAULT_THEME_ID);
  });

  it("reads (and sanitizes) an existing stored value on mount", () => {
    localStorage.setItem(
      "sshweb.terminalPrefs",
      JSON.stringify({ themeId: "solarized-dark" }),
    );
    const { result } = renderHook(() => useTerminalPrefs());
    expect(result.current[0].themeId).toBe("solarized-dark");
  });

  it("falls back to the default for malformed storage", () => {
    localStorage.setItem("sshweb.terminalPrefs", "not json");
    const { result } = renderHook(() => useTerminalPrefs());
    expect(result.current[0].themeId).toBe(DEFAULT_THEME_ID);
  });
});
