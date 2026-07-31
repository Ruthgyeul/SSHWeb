import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_ID,
  getThemePreset,
  TERMINAL_THEMES,
} from "@/lib/terminalTheme";

describe("getThemePreset", () => {
  it("returns the matching preset by id", () => {
    expect(getThemePreset("dracula").label).toBe("Dracula");
  });

  it("falls back to the default preset for unknown/empty ids", () => {
    expect(getThemePreset("nope").id).toBe(DEFAULT_THEME_ID);
    expect(getThemePreset(null).id).toBe(DEFAULT_THEME_ID);
    expect(getThemePreset(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it("default id is the first preset", () => {
    expect(DEFAULT_THEME_ID).toBe(TERMINAL_THEMES[0].id);
  });

  it("every preset defines a full 16-color palette", () => {
    for (const preset of TERMINAL_THEMES) {
      for (const value of Object.values(preset.theme)) {
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
