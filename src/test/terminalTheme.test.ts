import { describe, expect, it } from "vitest";
import { TERMINAL_THEME, type TerminalTheme } from "@/lib/terminalTheme";

describe("TERMINAL_THEME", () => {
  it("defines a complete ANSI palette with non-empty string values", () => {
    const keys: (keyof TerminalTheme)[] = [
      "background",
      "foreground",
      "cursor",
      "cursorAccent",
      "selectionBackground",
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ];
    for (const key of keys) {
      const value = TERMINAL_THEME[key];
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("matches the SSHWeb site background", () => {
    expect(TERMINAL_THEME.background).toBe("#0a0d13");
  });
});
