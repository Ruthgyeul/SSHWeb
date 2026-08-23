import { describe, expect, it } from "vitest";
import { canNotify } from "@/lib/desktopNotify";

describe("canNotify", () => {
  it("fires only when enabled, granted, and the page is hidden", () => {
    expect(
      canNotify({ enabled: true, permission: "granted", hidden: true }),
    ).toBe(true);
  });

  it("does not fire when disabled", () => {
    expect(
      canNotify({ enabled: false, permission: "granted", hidden: true }),
    ).toBe(false);
  });

  it("does not fire without granted permission", () => {
    for (const permission of ["default", "denied", "unsupported"] as const) {
      expect(canNotify({ enabled: true, permission, hidden: true })).toBe(
        false,
      );
    }
  });

  it("does not fire while the page is visible (toast suffices)", () => {
    expect(
      canNotify({ enabled: true, permission: "granted", hidden: false }),
    ).toBe(false);
  });
});
