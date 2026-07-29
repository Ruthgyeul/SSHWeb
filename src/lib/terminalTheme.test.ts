import { describe, expect, it } from "vitest";
import {
  clampFontSize,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME_ID,
  getThemePreset,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_THEMES,
} from "./terminalTheme";

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

describe("clampFontSize", () => {
  it("keeps in-range sizes unchanged", () => {
    expect(clampFontSize(14)).toBe(14);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(999)).toBe(MAX_FONT_SIZE);
  });

  it("rounds fractional sizes", () => {
    expect(clampFontSize(13.6)).toBe(14);
  });

  it("snaps non-finite input back to the default", () => {
    expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Infinity)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(-Infinity)).toBe(DEFAULT_FONT_SIZE);
  });
});
