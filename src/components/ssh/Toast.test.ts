import { describe, expect, it } from "vitest";
import { clampToastMessage } from "./Toast";

describe("clampToastMessage", () => {
  it("trims and collapses whitespace", () => {
    expect(clampToastMessage("  hello   world \n")).toBe("hello world");
  });

  it("returns an empty string for blank input", () => {
    expect(clampToastMessage("")).toBe("");
    expect(clampToastMessage("   \n\t ")).toBe("");
  });

  it("leaves a short message unchanged", () => {
    expect(clampToastMessage("File too large to download (> 25 MB).")).toBe(
      "File too large to download (> 25 MB).",
    );
  });

  it("truncates an over-long message with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = clampToastMessage(long);
    expect(out.length).toBe(140);
    expect(out.endsWith("…")).toBe(true);
  });
});
